// HOD syllabus PDF upload (routes/syllabus-upload.js): HOD only, PDF content checked, the course found by the
// offering's subject code, a DRAFT version created with the printed COs / units / topics and an extraction record,
// audited; scanned and wrong documents refused with a useful message; the source PDF readable by the course's roles.
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { sql, log, baseRules, start, IDS, installWorld, writes, tokenFor } from './harness.mjs';

// Where routes/syllabus-upload.js stores uploads (UPLOAD_DIR/syllabus). Not imported: app modules must load after
// the harness has set the test environment.
const SYLLABUS_DIR = new URL('../uploads/syllabus/', import.meta.url).pathname;

before(start);
after(() => {
  // The upload stored the PDF under its hash: remove it so tests leave no files behind.
  fs.rmSync(path.join(SYLLABUS_DIR, `${crypto.createHash('sha256').update(PDF).digest('hex')}.pdf`), { force: true });
  setTimeout(() => process.exit(0), 50).unref();
});
let PDF;
PDF = fs.readFileSync(new URL('../data/syllabus-2023/Syllabus-2023-New.pdf', import.meta.url));

function script(subjectCode = 'TCS 571', title = 'Big Data Visualization') {
  sql(/SELECT co\.id, s\.subject_code, s\.course_title FROM course_offerings co JOIN subjects s/i, [{ id: IDS.off, subject_code: subjectCode, course_title: title }]);
  sql(/^SELECT COALESCE\(MAX\(version_number\), 0\) AS v FROM syllabus_versions/i, [{ v: 2 }]);
  sql(/^\s*INSERT INTO syllabus_versions/i, (p) => [{ id: 'aaaa0000-0000-0000-0000-00000000v003'.replace('v', '0'), version_number: p[1], status: 'DRAFT' }]);
  sql(/^INSERT INTO syllabus_units/i, (p) => [{ id: `bbbb0000-0000-0000-0000-00000000000${p[3]}` }]);
  sql(/^\s*INSERT INTO syllabus_extraction_jobs/i, [{ id: 7 }]);
}
beforeEach(() => { baseRules(); installWorld(); script(); });

async function upload(who, buf, name = 'syllabus.pdf', off = IDS.off) {
  const form = new FormData();
  if (buf) form.append('file', new Blob([buf], { type: 'application/pdf' }), name);
  const res = await fetch(`http://localhost:${process.env.PORT}/api/academic/course-offerings/${off}/syllabus-upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${tokenFor(who)}` }, body: form });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

test('only the HOD in scope uploads: teacher, reviewer, admin and another department\'s HOD are refused, nothing written', async () => {
  for (const who of ['teacher', 'reviewer', 'admin', 'hodB']) {
    const r = await upload(who, PDF);
    assert.equal(r.status, 403, `${who}: ${JSON.stringify(r.data)}`);
  }
  assert.deepEqual(writes(), []);
});

test('the content is checked: no file, a non-PDF renamed .pdf, and an encrypted PDF are refused', async () => {
  assert.equal((await upload('hod', null)).status, 400);
  const fake = await upload('hod', Buffer.from('<script>alert(1)</script>'), 'syllabus.pdf');
  assert.equal(fake.status, 400); assert.match(fake.data.error, /not a PDF/);
  const enc = await upload('hod', Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer << /Root 1 0 R /Encrypt 2 0 R >>\n%%EOF'));
  assert.equal(enc.status, 400); assert.match(enc.data.error, /Encrypted/);
  assert.deepEqual(writes(), []);
});

test('an upload larger than the limit is refused with 413', async () => {
  const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(26 * 1024 * 1024)]);
  assert.equal((await upload('hod', big)).status, 413);
  assert.deepEqual(writes(), []);
});

test('a PDF without the offering\'s course is refused and lists what it does contain', async () => {
  baseRules(); installWorld(); script('XYZ 999', 'Unknown');
  const r = await upload('hod', PDF);
  assert.equal(r.status, 422); assert.match(r.data.error, /does not contain the syllabus of XYZ 999/);
  assert.ok(r.data.courses_found.some((c) => c.code === 'TCS 571' && c.title === 'Big Data Visualization'));
  assert.deepEqual(writes(), []);
});

test('the official PDF creates a DRAFT version with the printed COs, units and topics, an extraction record and an audit entry', async () => {
  const r = await upload('hod', PDF);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.version.status, 'DRAFT'); assert.equal(r.data.version.version_number, 3);
  assert.equal(r.data.course.code, 'TCS 571'); assert.deepEqual(r.data.course.pages, [130, 131]);
  assert.deepEqual(r.data.course.course_outcomes.map((c) => c.code), ['CO1', 'CO2', 'CO3', 'CO4', 'CO5', 'CO6']);
  assert.match(r.data.course.course_outcomes[0].text, /^Create and adapt visualizations to represent complex data sets/);
  assert.deepEqual(r.data.course.units.map((u) => u.hours), [10, 10, 9, 9, 8]);
  assert.deepEqual(r.data.warnings, []);
  const ins = (rx) => log.filter((l) => rx.test(l.text));
  assert.equal(ins(/^\s*INSERT INTO syllabus_versions/).length, 1);
  assert.match(ins(/^\s*INSERT INTO syllabus_versions/)[0].text, /'pending', 'pending', 'pending', 'DRAFT'/);
  assert.equal(ins(/^INSERT INTO course_outcomes/).length, 6);
  assert.equal(ins(/^INSERT INTO syllabus_units/).length, 5);
  assert.ok(ins(/^INSERT INTO syllabus_topics/).length >= 5);
  const job = ins(/^\s*INSERT INTO syllabus_extraction_jobs/)[0];
  assert.match(job.params[1], /^syllabus\/[0-9a-f]{64}\.pdf$/, 'stored under its hash, never the client name');
  const audit = log.find((l) => /INSERT INTO audit_log/.test(l.text) && l.params[2] === 'syllabus_pdf_uploaded');
  assert.ok(audit, 'audited');
  assert.ok(!log.some((l) => /UPDATE syllabus_versions SET status/.test(l.text)), 'nothing is verified or activated by the upload');
});

test('a mismatch between the PDF title and the recorded subject title is reported as a warning', async () => {
  baseRules(); installWorld(); script('TCS 571', 'Data Visualisation');
  const r = await upload('hod', PDF);
  assert.equal(r.status, 201);
  assert.ok(r.data.warnings.some((w) => /titles this course "Big Data Visualization"/.test(w)));
});
