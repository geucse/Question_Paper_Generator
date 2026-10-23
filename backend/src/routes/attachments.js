import express from 'express';
import multer from 'multer';
import fs from 'fs';
import { fileTypeFromBuffer } from 'file-type';
import { get, all, run } from '../db.js';
import { requireAuth, requireRole } from '../middleware.js';
import { logAudit } from '../audit.js';
import { sha256Buffer } from '../auth.js';
import { scanBuffer } from '../antivirus.js';
import { authorize } from '../authorization.js';
import { isUuid } from '../scopes.js';
import { ensureUploadDirs, storedName, resolveStored, rescanAttachment } from '../attachment-scan.js';
import { PRINTABLE_IMAGE_TYPES } from '../question-types.js';

ensureUploadDirs();

const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
const MAX_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_PER_QUESTION = 3;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_SIZE } });
const router = express.Router();

// Files are question content: they can change only while the author may edit the question
// (spec §7, §14). Migration 038's trg_guard_question_attachments enforces the same rule in the DB.
const EDITABLE_STATES = ['DRAFT', 'CHANGES_REQUESTED'];

router.post('/:questionId', requireAuth, requireRole('teacher'), upload.single('file'), async (req, res) => {
  if (!isUuid(req.params.questionId)) return res.status(404).json({ error: 'Question not found' });
  const q = await get('SELECT id, question_status, question_type FROM questions WHERE id = $1 AND submitted_by = $2', [req.params.questionId, req.user.id]);
  if (!q) return res.status(404).json({ error: 'Question not found' });
  if (!EDITABLE_STATES.includes(q.question_status)) {
    return res.status(409).json({ error: `Files can only be attached while the question is a draft or has changes requested (it is ${q.question_status})` });
  }
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const countRow = await get('SELECT COUNT(*)::int as c FROM question_attachments WHERE question_id = $1', [q.id]);
  if (countRow.c >= MAX_PER_QUESTION) {
    return res.status(400).json({ error: `Max ${MAX_PER_QUESTION} attachments per question` });
  }

  // Detect actual file type from magic bytes — never trust the client-reported MIME type.
  const detected = await fileTypeFromBuffer(req.file.buffer);
  const mime = detected ? detected.mime : (req.file.mimetype === 'application/pdf' ? 'application/pdf' : null);

  if (!mime || !ALLOWED_MIME.includes(mime)) {
    await logAudit({ userId: req.user.id, action: 'attachment_rejected_type', entityId: q.id, details: { claimed: req.file.mimetype, detected: mime }, ip: req.ip });
    return res.status(400).json({ error: 'File type not allowed or could not be verified (only PNG/JPEG/WEBP/PDF accepted)' });
  }

  // A diagram question's file is printed inside the paper, and the PDF writer embeds only PNG and JPEG (the quality
  // gate requires one since migration 041). Other questions may still attach WEBP or PDF reference material.
  if (q.question_type === 'diagram' && !PRINTABLE_IMAGE_TYPES.includes(mime)) {
    await logAudit({ userId: req.user.id, action: 'attachment_rejected_type', entityId: q.id, details: { detected: mime, reason: 'diagram_not_printable' }, ip: req.ip });
    return res.status(400).json({ error: 'A diagram question needs its diagram as a PNG or JPEG image (the printed paper can only embed those). Convert the file and upload it again.' });
  }

  const hash = sha256Buffer(req.file.buffer);
  const ext = detected ? detected.ext : 'pdf';

  // ClamAV scan over the clamd protocol (antivirus.js). An unreachable scanner gives 'failed', never 'clean':
  // the file goes to quarantine and cannot be used (download, /submit, the quality gate and the submit trigger
  // all require 'clean') until a rescan clears it (attachment-scan.js).
  const scanResult = await scanBuffer(req.file.buffer);

  // Conditional on the state: the scan can take up to 15s, and a question submitted meanwhile must not
  // pick up the file.
  const inserted = await get(`
    INSERT INTO question_attachments (question_id, uploaded_by, file_path, file_name, file_type, file_size_bytes, file_hash, scan_status)
    SELECT $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::int, $7::text, $8::text
    WHERE EXISTS (SELECT 1 FROM questions WHERE id = $1::uuid AND question_status IN ('DRAFT', 'CHANGES_REQUESTED'))
    RETURNING id
  `, [q.id, req.user.id, '', req.file.originalname, mime, req.file.size, hash, scanResult.status]);
  if (!inserted) {
    return res.status(409).json({ error: 'The question was submitted while the file was being scanned, so the file was not attached' });
  }

  if (scanResult.status === 'infected') {
    // Never write an infected file to disk at all.
    await run('UPDATE question_attachments SET scan_detail = $1, last_scanned_at = now(), scan_attempts = 1 WHERE id = $2', [scanResult.signature, inserted.id]);
    await logAudit({ userId: req.user.id, action: 'attachment_infected', entityId: q.id, details: { attId: inserted.id, signature: scanResult.signature }, ip: req.ip });
    return res.status(400).json({ error: 'This file was flagged by the virus scanner and was not accepted.', id: inserted.id, scan_status: 'infected' });
  }

  // Clean files go to uploads/, unscanned ones to uploads/quarantine/ (never served).
  const rel = storedName(inserted.id, ext, scanResult.status);
  fs.writeFileSync(resolveStored(rel), req.file.buffer);
  await run('UPDATE question_attachments SET file_path = $1, last_scanned_at = now(), scan_attempts = 1, scan_detail = $3 WHERE id = $2',
    [rel, inserted.id, scanResult.status === 'clean' ? null : scanResult.reason]);

  if (scanResult.status === 'failed') {
    console.error(`Virus scan failed for attachment ${inserted.id}: ${scanResult.reason}`);
    await logAudit({ userId: req.user.id, action: 'attachment_scan_failed', entityId: q.id, details: { attId: inserted.id, reason: scanResult.reason }, ip: req.ip });
  } else {
    await logAudit({ userId: req.user.id, action: 'attachment_uploaded', entityId: q.id, details: { attId: inserted.id, mime }, ip: req.ip });
  }

  res.json({
    id: inserted.id, file_name: req.file.originalname, scan_status: scanResult.status,
    ...(scanResult.status === 'failed' ? { warning: 'The virus scanner is currently unavailable. The file is quarantined and cannot be used until it is scanned clean; use "Scan again" later.' } : {}),
  });
});

router.delete('/:attachmentId', requireAuth, requireRole('teacher'), async (req, res) => {
  if (!isUuid(req.params.attachmentId)) return res.status(404).json({ error: 'Not found' });
  const att = await get(`
    SELECT a.*, q.question_status, q.submitted_by AS question_owner
    FROM question_attachments a JOIN questions q ON q.id = a.question_id WHERE a.id = $1`, [req.params.attachmentId]);
  if (!att || att.uploaded_by !== req.user.id || att.question_owner !== req.user.id) return res.status(404).json({ error: 'Not found' });
  if (!EDITABLE_STATES.includes(att.question_status)) {
    return res.status(409).json({ error: `Files can only be removed while the question is a draft or has changes requested (it is ${att.question_status})` });
  }
  const del = await run(`
    DELETE FROM question_attachments a USING questions q
    WHERE a.id = $1 AND q.id = a.question_id AND q.question_status IN ('DRAFT', 'CHANGES_REQUESTED') RETURNING a.id`, [att.id]);
  if (del.rowCount !== 1) return res.status(409).json({ error: 'The question is no longer editable; the file was not removed' });
  // The file goes only after its row is gone, so a refused delete never loses the file.
  try { if (att.file_path) fs.unlinkSync(resolveStored(att.file_path)); } catch { /* already gone */ }
  await logAudit({ userId: req.user.id, action: 'attachment_deleted', entityId: att.question_id, details: { attId: att.id, question_status: att.question_status }, ip: req.ip });
  res.json({ ok: true });
});

// Serve a file only once it scanned clean, to everyone, the author included (a quarantined file is never served):
// the author (409 with the scan status, so the UI can offer "Scan again"), or the people in the question's review
// workflow: reviewers assigned to its offering and HODs whose scope covers it (authorize('view_question_workflow')).
// Admin is technical-only and never reads question content.
router.get('/:attachmentId/file', requireAuth, async (req, res) => {
  if (!isUuid(req.params.attachmentId)) return res.status(404).end();
  const att = await get(`
    SELECT a.id, a.file_path, a.file_type, a.scan_status, a.uploaded_by, q.id AS question_id, q.submitted_by AS question_owner
    FROM question_attachments a JOIN questions q ON q.id = a.question_id WHERE a.id = $1`, [req.params.attachmentId]);
  if (!att || !att.file_path) return res.status(404).end();

  const isOwner = att.question_owner === req.user.id;
  if (att.scan_status !== 'clean') {
    return isOwner ? res.status(409).json({ error: 'This file has not passed the virus scan and cannot be opened', scan_status: att.scan_status }) : res.status(403).end();
  }
  if (att.file_path.startsWith('quarantine/')) return res.status(404).end(); // never served, whatever the row says
  if (!isOwner) {
    if (!['hod', 'reviewer'].includes(req.user.role)) return res.status(403).end();
    const authz = await authorize(req.user, 'view_question_workflow', { question_id: att.question_id, type: 'question_attachment', id: att.id });
    if (!authz.allowed) return res.status(403).end();
  }
  if (att.file_type) res.type(att.file_type);
  res.sendFile(resolveStored(att.file_path));
});

// The author asks for a rescan of a file the scanner could not check (any question state: the verdict is not
// content, and migration 038's attachment guard allows scan updates). Once per 30 seconds per file.
router.post('/:attachmentId/rescan', requireAuth, requireRole('teacher'), async (req, res) => {
  if (!isUuid(req.params.attachmentId)) return res.status(404).json({ error: 'Not found' });
  const att = await get(`
    SELECT a.id, a.question_id, a.file_path, a.scan_status, a.uploaded_by, a.last_scanned_at, q.submitted_by AS question_owner
    FROM question_attachments a JOIN questions q ON q.id = a.question_id WHERE a.id = $1`, [req.params.attachmentId]);
  if (!att || att.uploaded_by !== req.user.id || att.question_owner !== req.user.id) return res.status(404).json({ error: 'Not found' });
  if (['clean', 'infected'].includes(att.scan_status)) return res.status(409).json({ error: `This file is already ${att.scan_status}`, scan_status: att.scan_status });
  if (att.last_scanned_at && Date.now() - new Date(att.last_scanned_at).getTime() < 30000) {
    return res.status(429).json({ error: 'This file was scanned less than 30 seconds ago; try again shortly' });
  }
  const r = await rescanAttachment(att, { actorId: req.user.id, ip: req.ip });
  const status = r.status === 'conflict' ? (await get('SELECT scan_status FROM question_attachments WHERE id = $1', [att.id]))?.scan_status : r.status;
  res.json({
    id: att.id, scan_status: status,
    ...(r.status === 'failed' ? { warning: 'The virus scanner is still unavailable; the file stays quarantined. Try again later.' } : {}),
    ...(r.status === 'infected' ? { warning: 'The virus scanner flagged this file and it was removed; delete it and upload a clean copy.' } : {}),
  });
});

export default router;
