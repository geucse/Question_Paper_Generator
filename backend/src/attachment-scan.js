// Quarantine and rescan of question attachments (fail-closed virus scanning, recoverable).
//   - A clean file is stored at uploads/<id>.<ext>; a file the scanner could not check is stored at
//     uploads/quarantine/<id>.<ext> (directory mode 0700); an infected file is never written.
//   - Only clean files are ever served or allowed into SUBMITTED/ACTIVE questions (routes and migration 040).
//   - Rescans: the question's author (POST /api/attachments/:id/rescan), the technical admin in batches
//     (POST /api/admin/attachments/rescan, counts only) and an in-process sweeper. Rows are claimed with
//     FOR UPDATE SKIP LOCKED, so replicas never scan the same row twice.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { all, run } from './db.js';
import { logAudit } from './audit.js';
import { notify } from './notifications.js';
import { scanBuffer, pingClamd, clamdTarget } from './antivirus.js';
import { describeError } from './errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
export const QUARANTINE_DIR = path.join(UPLOAD_DIR, 'quarantine');

export function ensureUploadDirs() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.mkdirSync(QUARANTINE_DIR, { recursive: true, mode: 0o700 });
}

export const storedName = (id, ext, status) => (status === 'clean' ? `${id}.${ext}` : `quarantine/${id}.${ext}`);

// Stored paths are relative to UPLOAD_DIR; anything resolving outside it is refused.
export function resolveStored(rel) {
  const p = path.resolve(UPLOAD_DIR, String(rel || ''));
  if (!p.startsWith(UPLOAD_DIR + path.sep)) throw new Error('bad stored path');
  return p;
}

const PENDING = "scan_status IN ('failed', 'pending')";

// att: { id, question_id, file_path, uploaded_by }. Returns { status: 'clean'|'infected'|'failed'|'conflict', reason? }.
export async function rescanAttachment(att, { actorId = null, ip = 'system' } = {}) {
  let buf = null;
  if (att.file_path) {
    try { buf = fs.readFileSync(resolveStored(att.file_path)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  let r;
  if (!buf) {
    await run(`UPDATE question_attachments SET scan_status = 'failed', scan_detail = 'file_missing', last_scanned_at = now(), scan_attempts = scan_attempts + 1
               WHERE id = $1 AND ${PENDING}`, [att.id]);
    r = { status: 'failed', reason: 'file_missing' };
  } else {
    r = await scanBuffer(buf);
    if (r.status === 'clean') {
      const target = `${att.id}${path.extname(att.file_path)}`;
      const moved = att.file_path !== target;
      if (moved) fs.renameSync(resolveStored(att.file_path), resolveStored(target));
      const u = await run(`UPDATE question_attachments SET scan_status = 'clean', file_path = $2, scan_detail = NULL, last_scanned_at = now(), scan_attempts = scan_attempts + 1
                           WHERE id = $1 AND ${PENDING} RETURNING id`, [att.id, target]);
      if (!u.rowCount) {
        if (moved) { try { fs.renameSync(resolveStored(target), resolveStored(att.file_path)); } catch { /* the row moved on; nothing references the target */ } }
        r = { status: 'conflict' };
      }
    } else if (r.status === 'infected') {
      const u = await run(`UPDATE question_attachments SET scan_status = 'infected', file_path = '', scan_detail = $2, last_scanned_at = now(), scan_attempts = scan_attempts + 1
                           WHERE id = $1 AND ${PENDING} RETURNING id`, [att.id, r.signature]);
      if (u.rowCount) {
        try { fs.unlinkSync(resolveStored(att.file_path)); } catch (e) { if (e.code !== 'ENOENT') console.error('[attachment-rescan] could not remove an infected file', att.id, e.code); }
        await logAudit({ userId: actorId, action: 'attachment_rescan_infected', entityId: att.question_id, details: { attId: att.id, signature: r.signature }, ip });
        await notify(att.uploaded_by, 'attachment_infected', 'A file you attached was flagged by the virus scanner and removed; delete it from the question and upload a clean copy.', att.question_id);
      } else {
        r = { status: 'conflict' };
      }
    } else {
      await run(`UPDATE question_attachments SET scan_detail = $2, last_scanned_at = now(), scan_attempts = scan_attempts + 1 WHERE id = $1 AND ${PENDING}`,
        [att.id, r.reason]);
    }
  }
  await logAudit({ userId: actorId, action: 'attachment_rescanned', entityId: att.question_id, details: { attId: att.id, result: r.status, reason: r.reason ?? null }, ip });
  return r;
}

// Rescan up to `limit` unscanned rows. maxAttempts null = no cap (admin); the sweeper stops after 10 tries.
export async function rescanPending({ limit = 25, actorId = null, ip = 'system', maxAttempts = 10 } = {}) {
  if (!(await pingClamd()).ok) return { skipped: 'scanner_unavailable' };
  const rows = await all(`
    UPDATE question_attachments SET last_scanned_at = now()
    WHERE id IN (
      SELECT id FROM question_attachments
      WHERE ${PENDING} AND (last_scanned_at IS NULL OR last_scanned_at < now() - interval '2 minutes')
        AND ($2::int IS NULL OR scan_attempts < $2)
      ORDER BY last_scanned_at NULLS FIRST, id LIMIT $1 FOR UPDATE SKIP LOCKED)
    RETURNING id, question_id, file_path, uploaded_by`, [limit, maxAttempts]);
  const tally = { scanned: 0, clean: 0, infected: 0, failed: 0, missing: 0, conflict: 0 };
  for (const att of rows) {
    const r = await rescanAttachment(att, { actorId, ip });
    tally.scanned += 1;
    if (r.reason === 'file_missing') tally.missing += 1;
    else tally[r.status] = (tally[r.status] || 0) + 1;
  }
  return tally;
}

// Quarantine files older than an hour that no row references (an upload that failed between write and UPDATE).
export async function cleanupQuarantineOrphans() {
  let names = [];
  try { names = fs.readdirSync(QUARANTINE_DIR); } catch { return 0; }
  const old = names.filter((n) => { try { return Date.now() - fs.statSync(path.join(QUARANTINE_DIR, n)).mtimeMs > 3600000; } catch { return false; } });
  if (!old.length) return 0;
  const rels = old.map((n) => `quarantine/${n}`);
  const used = new Set((await all('SELECT file_path FROM question_attachments WHERE file_path = ANY($1)', [rels])).map((r) => r.file_path));
  let removed = 0;
  for (const rel of rels) if (!used.has(rel)) { try { fs.unlinkSync(resolveStored(rel)); removed += 1; } catch { /* already gone */ } }
  return removed;
}

export function startAttachmentRescanSweeper(env = process.env) {
  const ms = Number(env.ATTACHMENT_RESCAN_INTERVAL_MS ?? (env.NODE_ENV === 'test' ? 0 : 600000));
  if (!ms || !clamdTarget(env)) return { stop() {} };
  let busy = false;
  const t = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await rescanPending({});
      await cleanupQuarantineOrphans();
      if (r.scanned) {
        console.log('[attachment-rescan]', JSON.stringify(r));
        await logAudit({ userId: null, action: 'attachment_rescan_sweep', entityId: null, details: r, ip: 'system' });
      }
    } catch (e) {
      console.error('[attachment-rescan] failed', JSON.stringify(describeError(e)));
    } finally {
      busy = false;
    }
  }, ms);
  t.unref();
  return { stop: () => clearInterval(t) };
}
