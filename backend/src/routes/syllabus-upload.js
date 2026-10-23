// The HOD uploads the official syllabus PDF of a course offering (spec: "Upload syllabus"). The server extracts
// the text (pdf-text-extract.js), finds the course block whose subject code matches the offering
// (syllabus-parse.js) and creates a DRAFT syllabus version holding exactly what the PDF prints: the COs and their
// numbering, the units with contact hours, and topics split from the unit text. Nothing is invented and nothing
// is activated: the HOD reviews the extraction (warnings included), corrects it with the existing unit / topic /
// CO endpoints (all audited), then verifies, submits and approves the version through the existing lifecycle.
//
//   POST /api/academic/course-offerings/:id/syllabus-upload   multipart field "file" (HOD in scope only)
//   GET  /api/academic/syllabus-versions/:id/extraction        the extraction record (HOD, assigned teacher/reviewer)
//   GET  /api/academic/syllabus-versions/:id/source            the uploaded PDF (same roles)
//
// Teachers and reviewers can read the syllabus but never upload, replace, verify or approve it.
import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { get, withTransaction } from '../db.js';
import { requireAuth, requireRole } from '../middleware.js';
import { logAudit } from '../audit.js';
import { guardOffering, isUuid } from '../academic-scope.js';
import { UPLOAD_DIR } from '../attachment-scan.js';
import { extractPdfText, PdfError } from '../pdf-text-extract.js';
import { parseSyllabusDocument, normalizeCode } from '../syllabus-parse.js';

const router = express.Router();
export const MAX_SYLLABUS_BYTES = 25 * 1024 * 1024;
export const SYLLABUS_DIR = path.join(UPLOAD_DIR, 'syllabus');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_SYLLABUS_BYTES, files: 1 } });

// multer's size error becomes a clean 413 instead of the generic error handler.
const receive = (req, res, next) => upload.single('file')(req, res, (err) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `The PDF is larger than ${MAX_SYLLABUS_BYTES / 1024 / 1024} MB` });
  return res.status(400).json({ error: 'Upload one PDF file in the field "file"' });
});

router.post('/course-offerings/:id/syllabus-upload', requireAuth, requireRole('hod'), receive, async (req, res) => {
  const ctx = await guardOffering(req, res, req.params.id, 'manage');
  if (!ctx) return;
  const file = req.file;
  if (!file || !file.buffer?.length) return res.status(400).json({ error: 'Choose the syllabus PDF to upload' });
  // The content decides, not the name or the declared type: a PDF starts with %PDF-.
  if (file.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') return res.status(400).json({ error: 'This file is not a PDF' });

  let extracted;
  try { extracted = extractPdfText(file.buffer); } catch (e) {
    return res.status(400).json({ error: e instanceof PdfError ? e.message : 'The PDF could not be read; it may be damaged' });
  }
  if (!extracted.pagesWithText) {
    return res.status(422).json({ error: 'This PDF has no text layer (it looks scanned). Upload the text PDF of the syllabus, or enter the syllabus manually; scanned pages are not read automatically.' });
  }

  const offering = await get(`SELECT co.id, s.subject_code, s.course_title FROM course_offerings co JOIN subjects s ON s.id = co.subject_id WHERE co.id = $1`, [ctx.course_offering_id]);
  const wanted = normalizeCode(offering.subject_code);
  const courses = parseSyllabusDocument(extracted.text);
  const course = courses.find((c) => c.code === wanted);
  if (!course) {
    return res.status(422).json({
      error: `The PDF does not contain the syllabus of ${offering.subject_code}. Check that this is the right document.`,
      courses_found: courses.slice(0, 60).map((c) => ({ code: c.code, title: c.title, semester: c.semester, pages: c.pages })),
    });
  }
  const warnings = [...course.warnings];
  if (course.title && offering.course_title && course.title.toLowerCase() !== offering.course_title.toLowerCase()) {
    warnings.push(`The PDF titles this course "${course.title}"; the subject is recorded as "${offering.course_title}"`);
  }

  const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const storedName = `${sha256}.pdf`; // never a client-supplied name
  fs.mkdirSync(SYLLABUS_DIR, { recursive: true });
  const target = path.join(SYLLABUS_DIR, storedName);
  if (!fs.existsSync(target)) fs.writeFileSync(target, file.buffer, { mode: 0o640 });

  const result = await withTransaction(async (txn) => {
    const last = await txn.get('SELECT COALESCE(MAX(version_number), 0) AS v FROM syllabus_versions WHERE course_offering_id = $1', [ctx.course_offering_id]);
    const version = await txn.get(`
      INSERT INTO syllabus_versions (course_offering_id, version_number, extracted_units, uploaded_by, extraction_status, verification_status, approval_status, status)
      VALUES ($1, $2, $3, $4, 'pending', 'pending', 'pending', 'DRAFT') RETURNING *`,
    [ctx.course_offering_id, last.v + 1, JSON.stringify({ source: 'pdf', file_sha256: sha256, pages: course.pages,
      notes: `Extracted from the uploaded PDF (pages ${course.pages.join('-')}); verify before activation.`,
      units: course.units.map((u) => ({ number: u.number, hours: u.hours, text: u.text })) }), req.user.id]);
    for (const [i, co] of course.course_outcomes.entries()) {
      await txn.run('INSERT INTO course_outcomes (syllabus_version_id, code, description, sequence) VALUES ($1, $2, $3, $4)', [version.id, co.code, co.text, i + 1]);
    }
    let topicCount = 0;
    for (const u of course.units) {
      const head = /^([^:]{3,80}?)\s*:/.exec(u.text)?.[1];
      const unit = await txn.get('INSERT INTO syllabus_units (syllabus_version_id, code, title, sequence) VALUES ($1, $2, $3, $4) RETURNING id',
        [version.id, `U${u.number}`, `Unit ${u.number}: ${head || u.text.slice(0, 80)}`.slice(0, 200), u.number]);
      for (const [k, t] of u.topics.entries()) {
        await txn.run('INSERT INTO syllabus_topics (syllabus_unit_id, title, sequence) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [unit.id, t.title, k + 1]);
        topicCount++;
      }
    }
    const job = await txn.get(`
      INSERT INTO syllabus_extraction_jobs (syllabus_version_id, file_path, file_type, extraction_method, status, extracted_text, extracted_data,
        requires_verification, created_by, completed_at)
      VALUES ($1, $2, 'pdf', 'text', 'extracted', $3, $4, TRUE, $5, now()) RETURNING id`,
    [version.id, `syllabus/${storedName}`, null, JSON.stringify({ code: course.code, title: course.title, semester: course.semester, pages: course.pages,
      total_hours: course.total_hours, course_outcomes: course.course_outcomes, units: course.units, warnings, file_name: String(file.originalname || '').slice(0, 200),
      sha256, document_pages: extracted.pages }), req.user.id]);
    return { version, topicCount, jobId: job.id };
  });

  await logAudit({ userId: req.user.id, action: 'syllabus_pdf_uploaded', entityId: result.version.id, ip: req.ip,
    details: { course_offering_id: ctx.course_offering_id, version_number: result.version.version_number, sha256, pages: course.pages,
      course_outcomes: course.course_outcomes.length, units: course.units.length, topics: result.topicCount, warnings } });
  res.status(201).json({
    version: { id: result.version.id, version_number: result.version.version_number, status: result.version.status },
    course: { code: course.code, title: course.title, semester: course.semester, pages: course.pages, total_hours: course.total_hours,
      course_outcomes: course.course_outcomes, units: course.units.map((u) => ({ number: u.number, hours: u.hours, topics: u.topics.length, label_missing_in_source: !!u.label_missing_in_source })) },
    warnings, extraction_id: result.jobId,
    next: course.course_outcomes.length
      ? 'Review the extracted COs, units and topics, correct anything that differs from the PDF, then verify, submit and approve the version.'
      : 'The PDF prints no course outcomes for this course. Resolve this with the department before the version can be verified; COs are never invented.',
  });
});

async function viewableVersion(req, res) {
  if (!isUuid(req.params.id)) { res.status(404).json({ error: 'Syllabus version not found' }); return null; }
  const v = await get('SELECT id, course_offering_id FROM syllabus_versions WHERE id = $1', [req.params.id]);
  if (!v) { res.status(404).json({ error: 'Syllabus version not found' }); return null; }
  return (await guardOffering(req, res, v.course_offering_id, 'view')) ? v : null;
}

router.get('/syllabus-versions/:id/extraction', requireAuth, requireRole('hod', 'teacher', 'reviewer'), async (req, res) => {
  const v = await viewableVersion(req, res);
  if (!v) return;
  const job = await get(`SELECT j.id, j.file_type, j.extraction_method, j.status, j.extracted_data, j.requires_verification, j.created_at, u.email AS uploaded_by_email
    FROM syllabus_extraction_jobs j LEFT JOIN users u ON u.id = j.created_by WHERE j.syllabus_version_id = $1 ORDER BY j.created_at DESC LIMIT 1`, [v.id]);
  if (!job) return res.status(404).json({ error: 'This syllabus version was not created from an uploaded PDF' });
  res.json(job);
});

router.get('/syllabus-versions/:id/source', requireAuth, requireRole('hod', 'teacher', 'reviewer'), async (req, res) => {
  const v = await viewableVersion(req, res);
  if (!v) return;
  const job = await get('SELECT file_path FROM syllabus_extraction_jobs WHERE syllabus_version_id = $1 ORDER BY created_at DESC LIMIT 1', [v.id]);
  const name = /^syllabus\/([0-9a-f]{64})\.pdf$/.exec(job?.file_path || '')?.[1]; // only names this route wrote
  const file = name && path.join(SYLLABUS_DIR, `${name}.pdf`);
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'The uploaded PDF is not available' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="syllabus-${name.slice(0, 12)}.pdf"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(file).pipe(res);
});

export default router;
