// PIVOT_SPEC_V2 section 40 smoke tests.
// Prereqs:  npm run migrate && npm run seed && AUTH_RATE_MAX=500 npm run dev   (other terminal)
// Run:      node smoketest-pivot.mjs
// Logs in through the real password+OTP flow. Because OTPs are never returned by the API, the
// test overwrites the stored OTP *hash* with a known code (it needs DATABASE_URL, i.e. DB access).
import 'dotenv/config';
import pg from 'pg';
import { startFakeClamd } from './test/fake-clamd.mjs';
import * as XLSX from 'xlsx';
import { authenticator } from 'otplib';
import { hashCode, hashPassword } from './src/auth.js';
import { loadRecentlyUsed, loadEligiblePool } from './src/exam-generator.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pdfText, pdfPages } from './test/pdf-text.mjs';

const BASE = process.env.API_BASE || 'http://localhost:4000/api';
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const tag = Date.now().toString(36);
const CAMPUS_A = '00000000-0000-0000-0000-000000000002';
const INSTITUTION = '00000000-0000-0000-0000-000000000001';
const results = [];

const rows = async (sql, p = []) => (await db.query(sql, p)).rows;
const one = async (sql, p = []) => (await rows(sql, p))[0];
async function api(method, url, body, token) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`);
}
async function dbFails(sql, p, re) {
  try { await db.query(sql, p); return { failed: false }; } catch (e) { return { failed: re ? re.test(e.message) : true, message: e.message }; }
}

// Runs `setup` statements and `target` in one transaction that is always rolled back; reports whether target failed.
async function txnFails(setup, target, p, re) {
  await db.query('BEGIN');
  try {
    const ctx = {};
    for (const step of setup) await step(ctx);
    try { await db.query(target, typeof p === 'function' ? p(ctx) : p); return { failed: false }; } catch (e) { return { failed: re ? re.test(e.message) : true, message: e.message }; }
  } finally { await db.query('ROLLBACK'); }
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
async function attachPng(questionId, token) {
  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: 'image/png' }), 'diagram.png');
  const res = await fetch(`${BASE}/attachments/${questionId}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const tokens = {};
async function login(email, password) {
  if (tokens[email]) return tokens[email];
  const s1 = await api('POST', '/auth/login/password', { email, password });
  if (!s1.data.otp_pending_for) throw new Error(`login failed for ${email}: ${JSON.stringify(s1.data)}`);
  await db.query(`UPDATE otp_codes SET code_hash = $1 WHERE user_id = $2 AND purpose = 'login' AND used = FALSE`, [hashCode('123456'), s1.data.otp_pending_for]);
  const s2 = await api('POST', '/auth/login/otp', { userId: s1.data.otp_pending_for, code: '123456' });
  if (!s2.data.token) throw new Error(`otp failed for ${email}: ${JSON.stringify(s2.data)}`);
  return (tokens[email] = s2.data.token);
}
const userId = async (email) => (await one('SELECT id FROM users WHERE email = $1', [email])).id;
// A TOTP code is accepted once per 30-second step (replay protection, migration 040). The smoke test runs several
// approvals within one step, so it clears the recorded step first (DB access, like the OTP-hash overwrite above).
async function freshTotp(secret, email = 'coe@portal.edu') {
  await db.query('UPDATE users SET totp_last_used_step = NULL WHERE email = $1', [email]);
  return authenticator.generate(secret);
}

// ---------------- fixtures ----------------
const F = {};
// verifiedBloom: the reviewer-verified Bloom level on the canonical question (the question's own bloom_level stays 'apply').
// 042: the reviewer-verified topic is the unit's topic titled `topic` (none when the unit has no such topic), and the
// CO mapping is reviewer-verified (verified_by recorded), as a review round would leave them.
async function mkQuestion({ off, sv, unit, difficulty, marks, text, status = 'ACTIVE', author, withMeta = true, co, topic = 'Trees', type = 'descriptive', answerData = null, verifiedBloom = 'apply', subtopicId = null }) {
  const hash = `smk-${tag}-${text}`;
  let canon = null;
  if (withMeta) {
    const t = unit ? await one('SELECT id FROM syllabus_topics WHERE syllabus_unit_id = $1 AND title = $2', [unit, topic]) : null;
    canon = (await one(`INSERT INTO canonical_questions (subject_id, canonical_text, normalized_text, question_type, question_hash, verified_difficulty, verified_bloom_level, verified_syllabus_unit_id,
        verified_syllabus_topic_id, verified_syllabus_subtopic_id, verified_by)
      VALUES ($1,$2,$3,$7,$4,$5,$8,$6,$9,$10,$11) RETURNING id`, [F.subject, text, text.toLowerCase(), hash, difficulty, unit, type, verifiedBloom, t?.id || null, subtopicId, F.reviewer])).id;
    await db.query(`INSERT INTO question_course_outcomes (canonical_question_id, course_outcome_id, source, verified_by, verified_at) VALUES ($1,$2,'reviewer',$3,now())`, [canon, co, F.reviewer]);
  }
  const q = await one(`INSERT INTO questions (subject_id, course_offering_id, submitted_by, question_type, question_text, difficulty, topic, marks, question_hash, model_answer,
      bloom_level, canonical_question_id, syllabus_version_id, question_status, approved_by, is_draft, answer_data)
    VALUES ($1,$2,$3,$14,$4,$5,$13,$6,$7,'a sufficiently long model answer',$8,$9,$10,$11,$12,FALSE,$15) RETURNING id`,
    [F.subject, off, author || F.teacher, text, difficulty, marks, hash, withMeta ? 'apply' : null, canon, sv, status === 'ACTIVE' ? 'APPROVED' : status, F.reviewer, topic,
     type, answerData ? JSON.stringify(answerData) : null]);
  if (status === 'ACTIVE') await db.query(`UPDATE questions SET question_status = 'ACTIVE' WHERE id = $1`, [q.id]); // runs the quality gate
  return q.id;
}

// A syllabus version taken through the 042 workflow as a migration-era fixture: DRAFT, its content, TEACHER_VERIFIED,
// HOD_REVIEW, then ACTIVE (the offering's previous ACTIVE version SUPERSEDED in the same transaction) and the offering's
// pointer. units: [{ code, title, topics: [title] }]; cos: [[code, description]]; subtopics: { topicTitle: [title] }.
async function mkSyllabus(off, { units = [{ code: 'Unit 1', title: 'Trees', topics: ['Trees'] }], cos = [['CO1', 'c1']], subtopics = {}, activate = true } = {}) {
  const n = (await one('SELECT COALESCE(MAX(version_number), 0) + 1 AS n FROM syllabus_versions WHERE course_offering_id = $1', [off])).n;
  const sv = (await one('INSERT INTO syllabus_versions (course_offering_id, version_number, uploaded_by) VALUES ($1,$2,$3) RETURNING id', [off, n, F.teacher])).id;
  const out = { sv, units: [], topics: {}, subtopics: {}, cos: {} };
  for (const u of units) {
    const uid = (await one('INSERT INTO syllabus_units (syllabus_version_id, code, title) VALUES ($1,$2,$3) RETURNING id', [sv, u.code, u.title])).id;
    out.units.push(uid);
    for (const t of u.topics) {
      out.topics[t] = (await one('INSERT INTO syllabus_topics (syllabus_unit_id, title) VALUES ($1,$2) RETURNING id', [uid, t])).id;
      for (const st of subtopics[t] || []) out.subtopics[st] = (await one('INSERT INTO syllabus_subtopics (syllabus_topic_id, title) VALUES ($1,$2) RETURNING id', [out.topics[t], st])).id;
    }
  }
  for (const [code, d] of cos) out.cos[code] = (await one('INSERT INTO course_outcomes (syllabus_version_id, code, description) VALUES ($1,$2,$3) RETURNING id', [sv, code, d])).id;
  if (activate) await activateSyllabusSql(off, sv);
  return { ...out, unit: out.units[0], co: out.cos[cos[0][0]] };
}
async function activateSyllabusSql(off, sv) {
  await db.query('BEGIN');
  try {
    await db.query(`UPDATE syllabus_versions SET status = 'TEACHER_VERIFIED', verified_by = $2 WHERE id = $1`, [sv, F.teacher]);
    await db.query(`UPDATE syllabus_versions SET status = 'HOD_REVIEW', submitted_for_review_by = $2 WHERE id = $1`, [sv, F.teacher]);
    const cur = await one('SELECT syllabus_version_id AS id FROM course_offerings WHERE id = $1 FOR UPDATE', [off]);
    if (cur?.id) await db.query(`UPDATE syllabus_versions SET status = 'SUPERSEDED', superseded_by_version_id = $2 WHERE id = $1`, [cur.id, sv]);
    await db.query(`UPDATE syllabus_versions SET status = 'ACTIVE', approved_by = $2 WHERE id = $1`, [sv, F.hod]);
    await db.query('UPDATE course_offerings SET syllabus_version_id = $1 WHERE id = $2', [sv, off]);
    await db.query('COMMIT');
  } catch (e) { await db.query('ROLLBACK'); throw e; }
}

async function setup() {
  F.teacher = await userId('teacher1@portal.edu'); F.reviewer = await userId('reviewer@portal.edu'); F.hod = await userId('hod@portal.edu');
  F.coe = await userId('coe@portal.edu');
  F.dept = (await one(`SELECT id FROM departments WHERE code = 'CSE'`)).id;
  F.programA = (await one(`SELECT id FROM programs WHERE code = 'BTECH-CSE'`)).id;
  F.session = (await one(`SELECT id FROM academic_sessions WHERE label = '2026-2027'`)).id;
  F.subject = (await one(`INSERT INTO subjects (subject_code, course_title, description, credits, theory_hours, category) VALUES ($1,'Smoke Subject','smoke',3,3,'core') RETURNING id`, ['SMK' + tag])).id;
  F.off = (await one(`INSERT INTO course_offerings (subject_id, program_id, academic_session_id, semester, offering_code, status) VALUES ($1,$2,$3,5,$4,'active') RETURNING id`, [F.subject, F.programA, F.session, 'SMK-' + tag])).id;
  // Migration 042: an earlier version (F.sv0, now SUPERSEDED) and the current one (F.sv1, ACTIVE). F.sv1 also has
  // CO2, CO3 (for the CO-target checks) and a subtopic of Trees (bulk import), since content changes only in DRAFT.
  F.subtopic = `Rotations ${tag}`;
  ({ sv: F.sv0, unit: F.unit0, co: F.co0 } = await mkSyllabus(F.off));
  const s1 = await mkSyllabus(F.off, { cos: [['CO1', 'c1'], ['CO2', 'c2'], ['CO3', 'taught later']], subtopics: { Trees: [F.subtopic] } });
  ({ sv: F.sv1, unit: F.unit1, co: F.co1 } = s1);
  F.co2 = s1.cos.CO2;
  await db.query('INSERT INTO reviewer_assignments (reviewer_id, course_offering_id, assigned_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [F.reviewer, F.off, F.hod]);

  // Campus B with its own offering + question (cross-campus fixtures)
  F.campusB = (await one(`INSERT INTO campuses (institution_id, name, code, is_active) VALUES ($1,$2,$3,TRUE) RETURNING id`, [INSTITUTION, 'Campus B ' + tag, 'B' + tag])).id;
  const collegeB = (await one(`INSERT INTO colleges (campus_id, name, code, is_active) VALUES ($1,'College B',$2,TRUE) RETURNING id`, [F.campusB, 'CB' + tag])).id;
  const deptB = (await one(`INSERT INTO departments (name, code, description, institution_id, campus_id, college_id) VALUES ('Dept B',$1,'b',$2,$3,$4) RETURNING id`, ['DB' + tag, INSTITUTION, F.campusB, collegeB])).id;
  const progB = (await one(`INSERT INTO programs (department_id, name, code, degree_type, duration_years, institution_id, campus_id, college_id) VALUES ($1,'Prog B',$2,'UG',4,$3,$4,$5) RETURNING id`, [deptB, 'PB' + tag, INSTITUTION, F.campusB, collegeB])).id;
  F.offB = (await one(`INSERT INTO course_offerings (subject_id, program_id, academic_session_id, semester, offering_code, status) VALUES ($1,$2,$3,5,$4,'active') RETURNING id`, [F.subject, progB, F.session, 'SMKB-' + tag])).id;
  const sB = await mkSyllabus(F.offB, { units: [{ code: 'Unit 1', title: 'T', topics: ['Trees'] }], cos: [['CO1', 'c']] });
  const svB = F.svB = sB.sv; const unitB = F.unitB = sB.unit; const coB = F.coB = sB.co;
  F.teacherB = (await one(`INSERT INTO users (email, password_hash, role, department_id, campus_id, institution_id) VALUES ($1,'x','teacher',$2,$3,$4) RETURNING id`, [`teacherb-${tag}@portal.edu`, deptB, F.campusB, INSTITUTION])).id;
  await db.query('INSERT INTO teacher_course_assignments (teacher_id, course_offering_id) VALUES ($1,$2)', [F.teacherB, F.offB]);
  F.qCampusB = await mkQuestion({ off: F.offB, sv: svB, unit: unitB, difficulty: 'hard', marks: 6, text: `campus B hard ${tag}`, co: coB });

  // Eligible ACTIVE pool for the exam: 3 easy(2) + 3 medium(4) + 1 hard(6)  => 2/2/1 = 18 marks
  F.eligible = [];
  for (let i = 0; i < 3; i++) F.eligible.push(await mkQuestion({ off: F.off, sv: F.sv1, unit: F.unit1, difficulty: 'easy', marks: 2, text: `easy question number ${i} ${tag}`, co: F.co1 }));
  for (let i = 0; i < 3; i++) F.eligible.push(await mkQuestion({ off: F.off, sv: F.sv1, unit: F.unit1, difficulty: 'medium', marks: 4, text: `medium question number ${i} ${tag}`, co: F.co1 }));
  F.eligible.push(await mkQuestion({ off: F.off, sv: F.sv1, unit: F.unit1, difficulty: 'hard', marks: 6, text: `the one eligible hard question ${tag}`, co: F.co1 }));
  // Decoys (all HARD) that must never be substituted
  F.decoyNotActive = await mkQuestion({ off: F.off, sv: F.sv1, unit: F.unit1, difficulty: 'hard', marks: 6, text: `approved but not active hard ${tag}`, status: 'APPROVED', co: F.co1 });
  F.decoyWrongSyllabus = await mkQuestion({ off: F.off, sv: F.sv0, unit: F.unit0, difficulty: 'hard', marks: 6, text: `active under a superseded syllabus hard ${tag}`, co: F.co0 });
}

// ---------------- tests ----------------
async function main() {
  await db.connect();
  console.log('Setting up fixtures...');
  await setup();
  const hod = await login('hod@portal.edu', 'Hod@12345');
  const reviewer = await login('reviewer@portal.edu', 'Review@123');
  const teacher = await login('teacher1@portal.edu', 'Teach@123');
  const coe = await login('coe@portal.edu', 'Coe@123456');
  const admin = await login('admin@portal.edu', 'Admin@12345');
  console.log('\nQuestion bank');

  // 1 cross-campus
  let r = await api('GET', `/questions/${F.qCampusB}/lifecycle`, null, hod);
  check('Cross-campus question access -> DENIED (HOD)', r.status === 403, `${r.status} ${JSON.stringify(r.data)}`);
  r = await api('POST', '/examinations', { course_offering_id: F.offB, exam_type: 'end_term', maximum_marks: 18, duration_minutes: 60 }, coe);
  check('Cross-campus examination creation -> DENIED (COE)', r.status === 403, `${r.status}`);

  // Phase 3: object-level campus/department scope on the academic routes; admin is technical-only.
  r = await api('GET', `/academic/syllabus-versions?course_offering_id=${F.offB}`, null, hod);
  check('Phase 3: HOD (campus A) reads campus-B syllabus versions -> DENIED', r.status === 403, `${r.status}`);
  r = await api('GET', `/academic/units/${F.unitB}/topics`, null, hod);
  check('Phase 3: HOD (campus A) reads campus-B topics -> DENIED', r.status === 403, `${r.status}`);
  r = await api('POST', `/academic/course-outcomes/${F.coB}/deactivate`, null, hod);
  const coStill = await one('SELECT is_active FROM course_outcomes WHERE id = $1', [F.coB]);
  check('Phase 3: HOD (campus A) deactivates a campus-B CO -> DENIED, row unchanged', r.status === 403 && coStill.is_active === true, `${r.status}`);
  r = await api('GET', `/questions/mistakes/${F.teacherB}`, null, hod);
  check('Phase 3: HOD (campus A) mistake report on a campus-B teacher -> 404', r.status === 404, `${r.status}`);
  r = await api('GET', '/academic/course-offerings', null, hod);
  check('Phase 3: HOD offering list excludes campus B, includes its own',
    r.status === 200 && !r.data.some((o) => o.course_offering_id === F.offB) && r.data.some((o) => o.course_offering_id === F.off), `${r.status}`);
  r = await api('GET', `/question-bank/analytics?course_offering_id=${F.offB}`, null, hod);
  check('Phase 3: HOD analytics on a campus-B offering -> DENIED', r.status === 403, `${r.status}`);
  r = await api('GET', `/question-bank/analytics?course_offering_id=${F.off}`, null, hod);
  check('Phase 3: HOD analytics on its own offering (SCOPE_SQL runs on Postgres)', r.status === 200 && r.data.scope?.role === 'hod', `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  r = await api('GET', '/question-bank/analytics', null, reviewer);
  check('Phase 3: reviewer analytics limited to assigned offerings (runs on Postgres)', r.status === 200, `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  r = await api('POST', `/academic/syllabus-versions/${F.sv1}/reject`, { reason: 'admin tries' }, admin);
  check('Phase 3: admin rejects a syllabus version -> DENIED (technical-only)', r.status === 403, `${r.status}`);
  r = await api('GET', '/review/batches', null, admin);
  check('Phase 3: admin lists review batches -> DENIED', r.status === 403, `${r.status}`);
  r = await api('GET', '/review/batches', null, hod);
  check('Phase 3: HOD review-batch list (SCOPE_SQL) runs on Postgres', r.status === 200, `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  r = await api('GET', '/review/dashboard', null, reviewer);
  check('Phase 3: reviewer dashboard (live seats in scope) runs on Postgres', r.status === 200 && r.data.candidates_awaiting_review === undefined, `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  r = await api('GET', `/questions/mistakes/${F.teacher}`, null, hod);
  check('Phase 3: HOD mistake report on its own teacher (scoped queries run on Postgres)', r.status === 200 && Array.isArray(r.data.issues), `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  r = await api('GET', '/papers', null, hod);
  check('Phase 3: legacy paper list by user_scopes runs on Postgres', r.status === 200, `${r.status}`);
  r = await api('POST', '/notifications/00000000-0000-0000-0000-0000000000ff/read', null, hod);
  check('Phase 3: marking a notification that is not yours read -> 404 (no fake success)', r.status === 404, `${r.status}`);
  r = await api('GET', '/academic/units/not-a-uuid/topics', null, hod);
  check('Phase 3: malformed id -> 404, not 500', r.status === 404, `${r.status}`);
  {
    const secB = (await one(`INSERT INTO sections (course_offering_id, name) VALUES ($1,$2) RETURNING id`, [F.offB, 'S' + tag])).id;
    const fk = await dbFails('INSERT INTO teacher_course_assignments (teacher_id, course_offering_id, section_id) VALUES ($1,$2,$3)', [F.teacher, F.off, secB], /tca_section_same_offering_fk/);
    check('Phase 3: an assignment to a section of another offering is refused (DB composite FK, 040)', fk.failed, fk.message);
    r = await api('POST', '/academic/assignments/teacher', { teacher_id: F.teacher, course_offering_id: F.off, section_id: secB }, hod);
    check('Phase 3: ... and by the route (400)', r.status === 400 && /does not belong/.test(r.data.error || ''), `${r.status} ${r.data.error}`);
    const migration = fs.readFileSync(new URL('./migrations/040_security_scoping.sql', import.meta.url), 'utf8');
    // Run twice in one rolled-back transaction: the first run may backfill scopes for fixtures this smoke test
    // inserted directly; the second must change nothing (idempotent).
    let first; let second; let trig;
    await db.query('BEGIN');
    try {
      await db.query(migration);
      first = await one('SELECT COUNT(*)::int AS n FROM user_scopes');
      await db.query(migration);
      second = await one('SELECT COUNT(*)::int AS n FROM user_scopes');
      trig = await one("SELECT tgenabled FROM pg_trigger WHERE tgname = 'trg_protect_locked_paper_questions'");
    } finally { await db.query('ROLLBACK'); }
    check('Phase 3: migration 040 is idempotent (a second run adds nothing) and leaves the paper lock trigger enabled', first?.n === second?.n && trig?.tgenabled === 'O', `${first?.n} -> ${second?.n}, ${trig?.tgenabled}`);
    const nulls = await one('SELECT COUNT(*)::int AS n FROM paper_questions pq WHERE pq.question_text_snapshot IS NULL AND EXISTS (SELECT 1 FROM questions q WHERE q.id = pq.question_id)');
    check('Phase 3: no paper question without a snapshot (040 backfill)', nulls.n === 0, `${nulls.n}`);
    // The generator never picks a question whose file is not virus-scan clean.
    await db.query('BEGIN');
    try {
      await db.query("SELECT set_config('app.question_content_override', 'on', true)");
      await db.query(`INSERT INTO question_attachments (question_id, uploaded_by, file_path, file_name, file_type, file_size_bytes, file_hash, scan_status)
        VALUES ($1,$2,'x.png','x.png','image/png',1,'h','failed')`, [F.eligible[0], F.teacher]);
      const exam = { id: '00000000-0000-0000-0000-0000000000ee', course_offering_id: F.off, syllabus_version_id: F.sv1, subject_id: F.subject, campus_id: CAMPUS_A, program_id: F.programA };
      const pool = await loadEligiblePool(exam, { all: rows });
      check('Phase 3: a question with a non-clean attachment is not in the generation pool', pool.length > 0 && !pool.some((q) => q.id === F.eligible[0]), `${pool.length}`);
    } finally { await db.query('ROLLBACK'); }
  }

  // 2 reviewer reviewing own question
  const own = await mkQuestion({ off: F.off, sv: F.sv1, unit: F.unit1, difficulty: 'easy', marks: 2, text: `authored by reviewer ${tag}`, status: 'UNDER_REVIEW', author: F.reviewer, co: F.co1 });
  r = await api('POST', `/questions/${own}/transition`, { target_status: 'APPROVED' }, reviewer);
  check('Reviewer reviewing own question -> DENIED', r.status === 403 && /own/i.test(r.data.error || ''), `${r.status} ${r.data.error}`);

  // 3 inactive reviewer
  const inactive = (await one(`INSERT INTO users (email, password_hash, role, department_id, is_active) VALUES ($1,'x','reviewer',$2,FALSE) RETURNING id`, [`inactive-${tag}@portal.edu`, F.dept])).id;
  r = await api('POST', '/academic/assignments/reviewer', { reviewer_id: inactive, course_offering_id: F.off }, hod);
  check('Inactive reviewer assignment -> DENIED', r.status === 400 && /not active/i.test(r.data.error || ''), `${r.status} ${r.data.error}`);

  // 4 invalid metadata cannot become ACTIVE; valid one can (through the real route)
  const bad = await mkQuestion({ off: F.off, sv: F.sv1, unit: F.unit1, difficulty: 'easy', marks: 2, text: `approved without metadata ${tag}`, status: 'APPROVED', withMeta: false });
  r = await api('POST', `/questions/${bad}/transition`, { target_status: 'ACTIVE' }, reviewer);
  check('Invalid metadata -> ACTIVE transition denied', r.status === 400 && (r.data.validation_errors || []).length > 0, `${r.status} ${JSON.stringify(r.data)}`);
  const good = await mkQuestion({ off: F.off, sv: F.sv1, unit: F.unit1, difficulty: 'easy', marks: 2, text: `approved with full metadata ${tag}`, status: 'APPROVED', co: F.co1 });
  r = await api('POST', `/questions/${good}/transition`, { target_status: 'ACTIVE' }, reviewer);
  check('Valid question -> ACTIVE via reviewer route', r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
  const offTopic = await mkQuestion({ off: F.off, sv: F.sv1, unit: F.unit1, difficulty: 'easy', marks: 2, text: `approved with an unknown topic ${tag}`, status: 'APPROVED', co: F.co1, topic: 'Quantum gravity' });
  r = await api('POST', `/questions/${offTopic}/transition`, { target_status: 'ACTIVE' }, reviewer);
  check('Topic not in syllabus version -> ACTIVE transition denied (042: a reviewer-verified topic of the version is required)',
    r.status === 400 && /Missing reviewer-verified topic/.test(JSON.stringify(r.data)), `${r.status} ${JSON.stringify(r.data)}`);
  r = await api('GET', '/questions/lifecycle?status=UNDER_REVIEW', null, reviewer);
  check('Reviewer lifecycle list never includes own questions', r.status === 200 && !(r.data.questions || []).some((q) => q.id === own), `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);

  // admin is technical-only
  // A transition that IS valid from APPROVED, so the denial can only come from the role.
  r = await api('POST', `/questions/${bad}/transition`, { target_status: 'CHANGES_REQUESTED', reason: 'admin trying' }, admin);
  check('Admin cannot take academic decisions', r.status === 403 && /technical-only/.test(r.data.error || ''), `${r.status} ${r.data.error}`);
  r = await api('POST', '/papers/generate', { course_offering_id: F.off }, hod);
  check('Legacy HOD paper generation is retired (410)', r.status === 410, `${r.status}`);
  r = await api('POST', '/review/papers/00000000-0000-0000-0000-000000000000/admin-approve', { admin_password: 'x', totp_code: '000000' }, admin);
  check('Legacy Admin paper approval is retired (410)', r.status === 410, `${r.status}`);

  // AI is advisory; legacy question decisions are retired (§2, §39 inv. 10)
  const sub = await mkQuestion({ off: F.off, sv: F.sv1, unit: F.unit1, difficulty: 'easy', marks: 2, text: `submitted for the advisory AI check ${tag}`, status: 'SUBMITTED', co: F.co1 });
  r = await api('POST', `/ai-review/${sub}`, null, teacher);
  let row = await one('SELECT question_status, status, ai_reviewed_at, approved_by FROM questions WHERE id = $1', [sub]);
  check('AI review stores findings only (status unchanged)', r.status === 200 && r.data.advisory === true && row.question_status === 'SUBMITTED' && row.status === 'pending' && !!row.ai_reviewed_at,
    `${r.status} ${JSON.stringify(r.data)} ${JSON.stringify(row)}`);
  r = await api('POST', `/questions/${sub}/review`, { decision: 'approved' }, hod);
  const row2 = await one('SELECT question_status, approved_by FROM questions WHERE id = $1', [sub]);
  check('Legacy HOD approve-anyway retired (410), nothing changed', r.status === 410 && row2.question_status === 'SUBMITTED' && row2.approved_by === row.approved_by, `${r.status} ${JSON.stringify(row2)}`);
  r = await api('POST', `/questions/${sub}/reviewer-verdict`, { verdict: 'needs_hod_attention' }, reviewer);
  row = await one('SELECT question_status FROM questions WHERE id = $1', [sub]);
  check('Legacy reviewer verdict retired (410), nothing changed', r.status === 410 && row.question_status === 'SUBMITTED', `${r.status} ${JSON.stringify(row)}`);
  r = await api('POST', `/ai-review/${F.eligible[0]}`, null, teacher);
  row = await one('SELECT question_status, ai_review_notes FROM questions WHERE id = $1', [F.eligible[0]]);
  check('AI review on ACTIVE refused; ACTIVE question not made editable', r.status === 409 && row.question_status === 'ACTIVE' && row.ai_review_notes === null, `${r.status} ${JSON.stringify(row)}`);

  // retirement needs a reason, records who/when/why
  const act = F.eligible[0];
  r = await api('POST', `/questions/${act}/transition`, { target_status: 'RETIRED' }, reviewer);
  check('Retirement without reason -> rejected', r.status === 400, `${r.status}`);
  r = await api('POST', `/questions/${good}/transition`, { target_status: 'RETIRED', reason: 'Outdated' }, reviewer);
  const ret = await one('SELECT question_status, retired_by, retirement_reason FROM questions WHERE id = $1', [good]);
  check('Retirement records retired_by + reason', r.status === 200 && ret.retired_by === F.reviewer && ret.retirement_reason === 'Outdated', `${r.status} ${JSON.stringify(ret)}`);

  console.log('\nLifecycle integrity (migration 038)');
  const qm = (status, text, extra = {}) => mkQuestion({ off: F.off, sv: F.sv1, unit: F.unit1, difficulty: 'easy', marks: 2, text: `${text} ${tag}`, status, co: F.co1, ...extra });
  const subQ = await qm('SUBMITTED', 'legacy approve attempt');
  let f = await dbFails(`UPDATE questions SET status = 'approved', approved_by = $2 WHERE id = $1`, [subQ, F.hod], /Invalid question state transition: SUBMITTED → APPROVED/);
  check('Legacy status write cannot skip states (SUBMITTED -> APPROVED, DB-enforced)', f.failed, f.message);
  const urQ = await qm('UNDER_REVIEW', 'under review guard');
  f = await dbFails(`UPDATE questions SET status = 'approved', approved_by = $2 WHERE id = $1`, [urQ, F.hod], /Review decision required/);
  check('Leaving UNDER_REVIEW needs the review round decision (legacy write, DB-enforced)', f.failed, f.message);
  f = await dbFails(`UPDATE questions SET question_status = 'APPROVED', approved_by = $2 WHERE id = $1`, [urQ, F.reviewer], /Review decision required/);
  check('Direct UNDER_REVIEW -> APPROVED write without a review decision -> DENIED (DB)', f.failed, f.message);
  const decided = [
    async (c) => { c.batch = (await one(`INSERT INTO review_batches (course_offering_id, title) VALUES ($1, 'smoke guard') RETURNING id`, [F.off])).id; },
    async (c) => { await db.query(`INSERT INTO review_batch_items (review_batch_id, question_id, outcome, decided_at) VALUES ($1, $2, 'APPROVED', now())`, [c.batch, urQ]); },
  ];
  f = await txnFails(decided, `UPDATE questions SET question_status = 'APPROVED', approved_by = $2 WHERE id = $1`, [urQ, F.hod], /active reviewer/);
  check('HOD cannot be the approver even with a decision record (DB)', f.failed, f.message);
  f = await txnFails(decided, `UPDATE questions SET question_status = 'APPROVED', approved_by = $2 WHERE id = $1`, [urQ, F.teacher], /active reviewer/);
  check('Author cannot be the approver (DB)', f.failed, f.message);
  f = await txnFails(decided, `UPDATE questions SET question_status = 'APPROVED', approved_by = $2 WHERE id = $1`, [urQ, F.reviewer]);
  check('Reviewer approval with a recorded decision is accepted (DB)', !f.failed, f.message);

  f = await dbFails(`UPDATE questions SET status = 'needs_teacher_fix' WHERE id = $1`, [F.eligible[0]], /question is ACTIVE and its legacy status cannot change/);
  check('Legacy status write on an ACTIVE question -> DENIED (DB)', f.failed, f.message);
  const note = await db.query(`UPDATE questions SET ai_review_notes = 'smoke note' WHERE id = $1`, [F.eligible[2]]);
  await db.query('UPDATE questions SET ai_review_notes = NULL WHERE id = $1', [F.eligible[2]]);
  check('Non-content columns of an ACTIVE question can still be written', note.rowCount === 1);
  f = await dbFails(`UPDATE questions SET question_text = question_text || ' x' WHERE id = $1`, [F.eligible[0]], /content is locked/);
  check('ACTIVE question content cannot change in place (DB)', f.failed, f.message);
  f = await dbFails('UPDATE questions SET marks = 7 WHERE id = $1', [F.decoyNotActive], /content is locked/);
  check('APPROVED question content cannot change in place (DB)', f.failed, f.message);
  f = await dbFails(`UPDATE questions SET answer_data = '{}' WHERE id = $1`, [good], /content is locked/);
  check('RETIRED question content cannot change in place (DB)', f.failed, f.message);
  f = await dbFails(`INSERT INTO question_attachments (question_id, file_path, file_name, file_type, file_size_bytes, file_hash, scan_status)
    VALUES ($1, 'x.png', 'x.png', 'image/png', 1, 'h', 'clean')`, [F.eligible[0]], /DRAFT or CHANGES_REQUESTED/);
  check('Attachments of an ACTIVE question cannot change (DB)', f.failed, f.message);

  const wd = await qm('DRAFT', 'withdrawn duplicate draft');
  await db.query(`UPDATE questions SET status = 'withdrawn_duplicate', is_draft = FALSE WHERE id = $1`, [wd]);
  const otherCanon = (await one('SELECT canonical_question_id FROM questions WHERE id = $1', [F.eligible[0]])).canonical_question_id;
  const link = await dbFails('UPDATE questions SET canonical_question_id = $2 WHERE id = $1', [wd, otherCanon]);
  const wdRow = await one('SELECT question_status, canonical_question_id FROM questions WHERE id = $1', [wd]);
  check('Withdrawn duplicate: DRAFT -> REJECTED and linked to the existing canonical question', !link.failed && wdRow.question_status === 'REJECTED' && wdRow.canonical_question_id === otherCanon, `${link.message} ${JSON.stringify(wdRow)}`);
  const d2 = await qm('DRAFT', 'draft rejected by legacy write');
  f = await dbFails(`UPDATE questions SET status = 'rejected', is_draft = FALSE WHERE id = $1`, [d2], /DRAFT → REJECTED/);
  check('A plain legacy rejection of a DRAFT -> DENIED (DB)', f.failed, f.message);

  const crQ = await qm('CHANGES_REQUESTED', 'changes requested legacy revise');
  await db.query(`UPDATE questions SET is_draft = TRUE, status = 'pending', question_text = question_text || ' (revised)' WHERE id = $1`, [crQ]);
  const crMid = (await one('SELECT question_status FROM questions WHERE id = $1', [crQ])).question_status;
  await db.query(`UPDATE questions SET is_draft = FALSE, status = 'pending' WHERE id = $1`, [crQ]);
  const crEnd = (await one('SELECT question_status FROM questions WHERE id = $1', [crQ])).question_status;
  check('Legacy revise keeps CHANGES_REQUESTED, then a submit makes it RESUBMITTED', crMid === 'CHANGES_REQUESTED' && crEnd === 'RESUBMITTED', `${crMid} ${crEnd}`);
  const apQ = await qm('APPROVED', 'approved before a syllabus change');
  await db.query(`UPDATE questions SET status = 'pending' WHERE id = $1`, [apQ]);
  const apRow = await one('SELECT question_status, status FROM questions WHERE id = $1', [apQ]);
  check('Syllabus re-confirm sends an APPROVED question back as CHANGES_REQUESTED', apRow.question_status === 'CHANGES_REQUESTED' && apRow.status === 'needs_teacher_fix', JSON.stringify(apRow));

  // Restore (RETIRED -> ACTIVE) re-runs the whole gate (item 6)
  r = await api('POST', `/questions/${good}/transition`, { target_status: 'ACTIVE' }, reviewer);
  check('Restore without a reason -> rejected', r.status === 400, `${r.status} ${JSON.stringify(r.data)}`);
  r = await api('POST', `/questions/${good}/transition`, { target_status: 'ACTIVE', reason: 'Back in the syllabus' }, teacher);
  check('Teacher cannot restore', r.status === 403, `${r.status}`);
  const rel = (await one(`INSERT INTO question_relationships (source_question_id, target_question_id, relationship_type, source, status, classification)
    VALUES ($1, $2, 'duplicate', 'manual', 'pending', 'EXACT_DUPLICATE') RETURNING id`, [good, F.eligible[1]])).id;
  r = await api('POST', `/questions/${good}/transition`, { target_status: 'ACTIVE', reason: 'Back in the syllabus' }, reviewer);
  check('Restore re-runs the gate (unresolved duplicate -> denied)', r.status === 400 && /Unresolved duplicate/.test(JSON.stringify(r.data)), `${r.status} ${JSON.stringify(r.data)}`);
  await db.query(`UPDATE question_relationships SET status = 'dismissed' WHERE id = $1`, [rel]);
  r = await api('POST', `/questions/${good}/transition`, { target_status: 'ACTIVE', reason: 'Back in the syllabus' }, reviewer);
  const restored = await one('SELECT question_status, retired_by, retirement_reason, activated_by FROM questions WHERE id = $1', [good]);
  check('Restore RETIRED -> ACTIVE works and records who restored it', r.status === 200 && restored.question_status === 'ACTIVE' && restored.retired_by === null
    && restored.retirement_reason === null && restored.activated_by === F.reviewer, `${r.status} ${JSON.stringify(r.data)} ${JSON.stringify(restored)}`);
  r = await api('POST', `/questions/${good}/transition`, { target_status: 'RETIRED', reason: 'Outdated' }, reviewer);
  check('Re-retire after the restore', r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
  const goodCanon = (await one('SELECT canonical_question_id FROM questions WHERE id = $1', [good])).canonical_question_id;
  await db.query(`UPDATE canonical_questions SET verified_bloom_level = 'create' WHERE id = $1`, [goodCanon]);
  const bloom = (await one('SELECT bloom_level FROM questions WHERE id = $1', [good])).bloom_level;
  await db.query(`UPDATE canonical_questions SET verified_bloom_level = 'apply' WHERE id = $1`, [goodCanon]);
  check('A later Bloom re-verification does not reclassify a retired question', bloom === 'apply', bloom);
  f = await dbFails(`UPDATE questions SET question_status = 'RETIRED' WHERE id = $1`, [F.eligible[0]], /Retirement requires/);
  check('Retirement without who/when/why -> DENIED (DB)', f.failed, f.message);

  console.log('\nExamination');
  r = await api('POST', '/examinations', { course_offering_id: F.off, exam_type: 'end_term', maximum_marks: 18, duration_minutes: 90 }, coe);
  check('COE creates examination (context derived from offering)', r.status === 201 && r.data.campus_id === CAMPUS_A, `${r.status} ${JSON.stringify(r.data)}`);
  const exam = r.data;

  // Hard constraints: only ONE eligible hard exists; decoys (non-ACTIVE, wrong syllabus) must not fill the gap
  r = await api('POST', '/examinations/blueprints', { examination_id: exam.id, easy_count: 2, medium_count: 2, hard_count: 2 }, coe);
  const bpBad = r.data;
  r = await api('POST', `/examinations/${exam.id}/generate`, { blueprint_id: bpBad.id }, coe);
  check('Non-ACTIVE / wrong-syllabus questions never substituted (generator fails with reason)', r.status === 422 && /HARD/.test((r.data.reasons || []).join(' ')), `${r.status} ${JSON.stringify(r.data)}`);
  r = await api('POST', '/examinations/blueprints', { examination_id: exam.id, easy_count: 2, medium_count: 2, hard_count: 1 }, coe);
  const bp = r.data;
  check('Blueprint is versioned (v2 supersedes v1)', bp.version_number === 2 && bp.supersedes_id === bpBad.id, JSON.stringify(bp));
  r = await api('POST', `/examinations/${exam.id}/generate`, { blueprint_id: bp.id, seed: 'fixed-seed' }, coe);
  check('Generator succeeds from ACTIVE questions only', r.status === 201, `${r.status} ${JSON.stringify(r.data)}`);
  let paperId = r.data.paperId;
  const firstPaper = paperId;
  const pq = await rows('SELECT question_id FROM paper_questions WHERE paper_id = $1', [paperId]);
  const ids = pq.map((x) => x.question_id);
  const forbidden = [F.decoyNotActive, F.decoyWrongSyllabus, F.qCampusB, bad, own];
  check('Paper excludes non-ACTIVE, wrong-syllabus and wrong-campus questions', ids.length === 5 && !ids.some((i) => forbidden.includes(i)), JSON.stringify(ids));
  const meta = await one('SELECT generation_seed, generator_version, blueprint_version_id, eligible_question_set_hash FROM exam_papers WHERE id = $1', [paperId]);
  check('Reproducibility fields stored (seed, version, blueprint, set hash)', meta.generation_seed === 'fixed-seed' && meta.generator_version && meta.blueprint_version_id === bp.id && meta.eligible_question_set_hash, JSON.stringify(meta));
  // One live paper per examination (039): a second candidate is a regeneration of the live one, never a second paper.
  r = await api('POST', `/examinations/${exam.id}/generate`, { blueprint_id: bp.id, seed: 'fixed-seed' }, coe);
  check('Second /generate while the examination has a live paper -> 409 naming it', r.status === 409 && /v1 is GENERATED/.test((r.data.reasons || []).join(' ')), `${r.status} ${JSON.stringify(r.data)}`);
  r = await api('POST', `/examinations/papers/${paperId}/regenerate`, { reason: 'smoke: reproducibility check', seed: 'fixed-seed' }, coe);
  const again = r.status === 201 ? (await rows('SELECT question_id FROM paper_questions WHERE paper_id = $1', [r.data.paperId])).map((x) => x.question_id).sort() : [];
  check('Same seed + same pool -> same paper (regenerated revision)', r.status === 201 && JSON.stringify(again) === JSON.stringify([...ids].sort()), `${r.status} ${JSON.stringify(r.data)}`);
  const lineage = await one(`SELECT (SELECT paper_status FROM exam_papers WHERE id = $1) AS old_status,
      (SELECT array_agg(paper_version ORDER BY paper_version) FROM exam_papers WHERE examination_id = $2) AS versions,
      (SELECT count(*)::int FROM paper_revisions WHERE paper_id = $3 AND revision_number = 2 AND change_type = 'question_regenerated') AS revs`, [firstPaper, exam.id, r.data.paperId]);
  check('Regeneration supersedes v1 (REGENERATED) with v2 and one revision row', lineage.old_status === 'REGENERATED' && JSON.stringify(lineage.versions) === '[1,2]' && lineage.revs === 1, JSON.stringify(lineage));
  paperId = r.data.paperId;
  const paper2 = paperId;
  const jump = await dbFails(`UPDATE exam_papers SET paper_status = 'VALIDATED' WHERE id = $1`, [paper2], /Invalid paper status transition|validators/);
  check('Skipping paper states -> denied (DB-enforced)', jump.failed, jump.message);
  const addQ = await dbFails('INSERT INTO paper_questions (paper_id, question_id, slot_number) VALUES ($1,$2,9)', [paper2, F.eligible[1]], /GENERATED paper/);
  check('Question list of a generated paper cannot change (DB-enforced)', addQ.failed, addQ.message);
  const upd = await dbFails('UPDATE paper_blueprints SET easy_count = 9 WHERE id = $1', [bp.id], /cannot be modified/);
  check('Blueprint used by a paper cannot be edited (DB-enforced)', upd.failed, upd.message);

  // An examination uses only the offering's CURRENT (ACTIVE) syllabus version (phase 3, 042). The syllabus-change flow
  // through the real API (old questions not automatically eligible) is in the "Syllabus versioning" section below.
  r = await api('POST', '/examinations', { course_offering_id: F.off, syllabus_version_id: F.sv0, exam_type: 'supplementary', maximum_marks: 2, duration_minutes: 30 }, coe);
  check('Phase 3: an examination on a version that is not the offering\'s current one -> 400', r.status === 400 && r.data.current_syllabus_version_id === F.sv1, `${r.status} ${JSON.stringify(r.data)}`);

  console.log('\nValidators and approval');
  const v = [];
  for (let i = 1; i <= 5; i++) v.push(await userId(`validator${i}@portal.edu`));
  r = await api('POST', `/examinations/papers/${paperId}/validators`, { validator_ids: [v[0], v[0], v[1], v[2]] }, coe);
  check('Duplicate validator -> assignment denied', r.status === 400, `${r.status}`);
  r = await api('POST', `/examinations/papers/${paperId}/validators`, { validator_ids: [F.coe, v[1], v[2], v[3]] }, coe);
  check('Validator = COE -> assignment denied', r.status === 403, `${r.status} ${JSON.stringify(r.data)}`);
  r = await api('POST', `/examinations/papers/${paperId}/validators`, { validator_ids: [F.teacher, v[1], v[2], v[3]] }, coe);
  check('Non-validator / out-of-scope user -> assignment denied', r.status === 403, `${r.status}`);
  r = await api('POST', `/examinations/papers/${paperId}/validators`, { validator_ids: v.slice(0, 4) }, coe);
  check('COE assigns exactly 4 validators', r.status === 200 && r.data.paper_status === 'VALIDATION_PENDING', `${r.status} ${JSON.stringify(r.data)}`);

  const early = await dbFails(`UPDATE exam_papers SET paper_status = 'PRINT_READY', coe_approved_by = $2 WHERE id = $1`, [paperId, F.coe], /validators must approve|Invalid|cannot/i);
  check('Paper without 4 validator approvals -> PRINT_READY denied (DB-enforced)', early.failed, early.message);

  const checklist = Object.fromEntries(['question_correctness', 'syllabus_relevance', 'co_mapping_correct', 'bloom_levels_correct', 'difficulty_appropriate', 'marks_distribution_ok', 'formatting_ok', 'numbering_correct', 'spelling_grammar_ok', 'instructions_clear', 'layout_acceptable'].map((k) => [k, true]));
  r = await api('POST', `/validators/papers/${paperId}/validate`, { decision: 'APPROVE', checklist }, await login('validator1@portal.edu', 'Valid@12345'));
  check('Validator approval needs the full checklist and is recorded', r.status === 200 && r.data.all_decided === false, `${r.status} ${JSON.stringify(r.data)}`);
  r = await api('POST', `/validators/papers/${paperId}/validate`, { decision: 'APPROVE', checklist }, await login('validator5@portal.edu', 'Valid@12345'));
  check('Unassigned validator cannot decide', r.status === 403, `${r.status}`);
  r = await api('POST', `/examinations/papers/${paperId}/issues`, { issue_type: 'spelling', description: 'typo in Q1' }, await login('validator2@portal.edu', 'Valid@12345'));
  check('Validator can report an issue (not edit the question)', r.status === 201, `${r.status}`);
  const issueId = r.data.id;
  for (const i of [2, 3, 4]) r = await api('POST', `/validators/papers/${paperId}/validate`, { decision: 'APPROVE', checklist }, await login(`validator${i}@portal.edu`, 'Valid@12345'));
  check('All 4 approve -> VALIDATED', r.data.all_approved === true, JSON.stringify(r.data));

  r = await api('POST', `/coe/papers/${paperId}/print-ready`, {}, coe);
  check('VALIDATED paper without COE approval -> PRINT_READY denied (API)', r.status === 400, `${r.status}`);
  const skip = await dbFails(`UPDATE exam_papers SET paper_status = 'PRINT_READY' WHERE id = $1`, [paperId], /COE approval required/);
  check('Paper without COE approval -> PRINT_READY denied (DB-enforced)', skip.failed, skip.message);

  r = await api('POST', '/auth/totp/setup', null, coe);
  check('Phase 3: authenticator setup needs the current password', r.status === 401, `${r.status} ${JSON.stringify(r.data)}`);
  const totpSetup = await api('POST', '/auth/totp/setup', { current_password: 'Coe@123456' }, coe);
  const pend = await one('SELECT totp_pending_secret, totp_secret, totp_enabled FROM users WHERE id = $1', [F.coe]);
  check('Phase 3: the new authenticator secret is stored sealed and only pending until confirmed',
    totpSetup.status === 200 && /^v1\./.test(pend.totp_pending_secret || '') && !pend.totp_pending_secret.includes(totpSetup.data.secret), JSON.stringify({ s: totpSetup.status, enabled: pend.totp_enabled }));
  r = await api('POST', '/auth/totp/confirm', { code: await freshTotp(totpSetup.data.secret) }, coe);
  check('Phase 3: authenticator confirmed', r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
  r = await api('POST', `/coe/papers/${paperId}/coe-approve`, { totp_code: await freshTotp(totpSetup.data.secret) }, coe);
  check('Open validator issue -> COE approval blocked', r.status === 409 && /issue/.test(JSON.stringify(r.data)), `${r.status} ${JSON.stringify(r.data)}`);
  r = await api('POST', `/examinations/issues/${issueId}/resolve`, { status: 'resolved', resolution: 'typo accepted; source fixed by reviewer' }, coe);
  {
    // The same code twice: the second use is refused (replay protection), and nothing is approved by it.
    const code = await freshTotp(totpSetup.data.secret);
    await db.query('UPDATE users SET totp_last_used_step = $2 WHERE id = $1', [F.coe, Math.floor(Date.now() / 30000) + 1]);
    const replay = await api('POST', `/coe/papers/${paperId}/coe-approve`, { totp_code: code }, coe);
    check('Phase 3: a TOTP code already used (same or later step) is refused', replay.status === 401 && /already used/.test(replay.data.error || ''), `${replay.status} ${JSON.stringify(replay.data)}`);
  }
  r = await api('POST', `/coe/papers/${paperId}/coe-approve`, { totp_code: await freshTotp(totpSetup.data.secret) }, coe);
  check('COE approves with TOTP step-up', r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
  {
    const logRows = await one(`SELECT COUNT(*) FILTER (WHERE success)::int AS ok, COUNT(*) FILTER (WHERE NOT success)::int AS bad FROM step_up_auth_log WHERE user_id = $1`, [F.coe]);
    check('Phase 3: step_up_auth_log records the COE\'s successful and failed step-ups', logRows.ok >= 2 && logRows.bad >= 1, JSON.stringify(logRows));
    const f2 = await dbFails(`UPDATE users SET totp_secret = 'PLAINTEXT' WHERE id = $1`, [F.coe], /users_totp_secret_sealed/);
    check('Phase 3: a plaintext TOTP secret is refused by the database', f2.failed, f2.message);
  }
  {
    const v1t = await login('validator1@portal.edu', 'Valid@12345');
    const seen = await api('GET', `/examinations/papers/${paperId}`, null, v1t);
    const key = await fetch(`${BASE}/examinations/papers/${paperId}/pdf?include_answers=1`, { headers: { Authorization: `Bearer ${v1t}` } });
    check('COE_APPROVED paper: validators lose the paper and the answer key (COE only)', seen.status === 403 && key.status === 403, `${seen.status} ${key.status}`);
  }
  r = await api('POST', `/coe/papers/${paperId}/print-ready`, {}, coe);
  check('PRINT_READY after 4 approvals + COE approval', r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);

  const before = (await api('GET', `/examinations/papers/${paperId}`, null, coe)).data.questions.map((q) => q.text).join('|');
  const lockedEdit = await dbFails(`UPDATE questions SET question_text = 'EDITED AFTER PRINT READY ' || question_text WHERE id = ANY($1)`, [ids], /content is locked/);
  check('ACTIVE question content cannot be edited in place (DB-enforced)', lockedEdit.failed, lockedEdit.message);
  // A data repair under the migration-only hatch still must not change the printed paper.
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.question_content_override', 'on', true)`);
  await db.query(`UPDATE questions SET question_text = 'EDITED AFTER PRINT READY ' || question_text WHERE id = ANY($1)`, [ids]);
  await db.query('COMMIT');
  const after = (await api('GET', `/examinations/papers/${paperId}`, null, coe)).data.questions.map((q) => q.text).join('|');
  check('Editing source questions -> historical paper unchanged', before === after && before.length > 0);
  const lock = await dbFails(`UPDATE paper_questions SET slot_number = 99 WHERE paper_id = $1`, [paperId], /PRINT_READY/);
  check('PRINT_READY paper is locked (DB-enforced)', lock.failed, lock.message);
  const usage = await one('SELECT COUNT(*)::int AS n FROM question_usage WHERE paper_id = $1', [paperId]);
  const used = await one('SELECT MIN(times_used)::int AS m FROM questions WHERE id = ANY($1)', [ids]);
  check('Usage recorded when paper becomes PRINT_READY', usage.n === 5 && used.m >= 1, `${JSON.stringify(usage)} ${JSON.stringify(used)}`);
  const unlock = await dbFails(`UPDATE exam_papers SET paper_status = 'COE_APPROVED' WHERE id = $1`, [paperId], /Cannot modify PRINT_READY/);
  check('PRINT_READY cannot be moved back (DB-enforced lock)', unlock.failed, unlock.message);
  const pdf = await fetch(`${BASE}/examinations/papers/${paperId}/pdf`, { headers: { Authorization: `Bearer ${coe}` } });
  check('PRINT_READY paper downloads as PDF from snapshots', pdf.status === 200 && /pdf/.test(pdf.headers.get('content-type') || ''), `${pdf.status}`);

  // Spec §28: a change after PRINT_READY is a new revision of the printed paper (review fix: there was no path).
  console.log('\nRevising a printed paper (§28) and program-limited COE scope');
  const printedV2 = paperId;
  r = await api('POST', `/examinations/${exam.id}/generate`, { blueprint_id: bp.id }, coe);
  check('Fresh /generate while the examination has a printed paper -> 409 pointing at Revise', r.status === 409 && /Revise/.test(r.data.error || '') && /v2 is PRINT_READY/.test((r.data.reasons || []).join(' ')),
    `${r.status} ${JSON.stringify(r.data)}`);
  r = await api('POST', `/examinations/papers/${printedV2}/revise`, { reason: 'smoke: Q2 printed with a typo' }, coe);
  const v3 = r.data.paperId;
  const lin3 = v3 ? await one(`SELECT (SELECT paper_status FROM exam_papers WHERE id = $1) AS printed, ep.parent_paper_id, ep.paper_version, ep.paper_status,
      (SELECT count(*)::int FROM paper_revisions pr WHERE pr.paper_id = ep.id AND (pr.previous_snapshot->>'revision_of_printed')::boolean) AS revs
      FROM exam_papers ep WHERE ep.id = $2`, [printedV2, v3]) : null;
  check('Revise a PRINT_READY paper -> v3 GENERATED with the printed paper as parent and a revision row; the printed paper stays PRINT_READY',
    r.status === 201 && lin3?.printed === 'PRINT_READY' && lin3.parent_paper_id === printedV2 && lin3.paper_version === 3 && lin3.paper_status === 'GENERATED' && lin3.revs === 1,
    `${r.status} ${JSON.stringify(r.data)} ${JSON.stringify(lin3)}`);
  r = await api('POST', `/examinations/papers/${printedV2}/revise`, { reason: 'smoke: a second revision at once' }, coe);
  check('A second revision while one is in progress -> 409', r.status === 409, `${r.status} ${JSON.stringify(r.data)}`);
  let f0 = await dbFails(`INSERT INTO exam_papers (subject_id, course_offering_id, title, examination_id, paper_status, paper_version) VALUES ($1,$2,'third',$3,'GENERATING',99)`,
    [F.subject, F.off, exam.id], /already has a paper in progress/);
  check('A second paper in progress next to the revision -> refused at COMMIT (DB)', f0.failed, f0.message);

  // A COE whose scope is another program of the same campus can do nothing with this examination (review fix).
  const prog2 = (await one(`INSERT INTO programs (department_id, name, code, degree_type, duration_years, institution_id, campus_id, college_id)
      SELECT department_id, 'Smoke Program 2', $1, degree_type, duration_years, institution_id, campus_id, college_id FROM programs WHERE id = $2 RETURNING id`, ['SP2' + tag, F.programA])).id;
  const coe2Email = `coe2-${tag}@portal.edu`;
  const coe2Id = (await one(`INSERT INTO users (email, password_hash, role) VALUES ($1,$2,'coe') RETURNING id`, [coe2Email, await hashPassword('Coe2@123456')])).id;
  await db.query(`INSERT INTO user_scopes (user_id, role, campus_id, program_id) VALUES ($1,'coe',$2,$3)`, [coe2Id, CAMPUS_A, prog2]);
  const coe2 = await login(coe2Email, 'Coe2@123456');
  {
    const seen = await api('GET', `/examinations/papers/${printedV2}`, null, coe2);
    const key = await fetch(`${BASE}/examinations/papers/${printedV2}/pdf?include_answers=1`, { headers: { Authorization: `Bearer ${coe2}` } });
    const asg = await api('POST', `/examinations/papers/${v3}/validators`, { validator_ids: v.slice(0, 4) }, coe2);
    const bpw = await api('POST', '/examinations/blueprints', { examination_id: exam.id, easy_count: 2, medium_count: 2, hard_count: 1 }, coe2);
    const rev = await api('POST', `/examinations/papers/${printedV2}/revise`, { reason: 'smoke: other program COE' }, coe2);
    const arc = await api('POST', `/coe/papers/${printedV2}/archive`, { reason: 'smoke: other program COE tries' }, coe2);
    const lists = await Promise.all(['/examinations', '/examinations/papers', `/examinations/blueprints?examination_id=${exam.id}`].map((u) => api('GET', u, null, coe2)));
    const leaks = lists.map((x) => (x.data || []).filter((row) => row.id === exam.id || row.examination_id === exam.id).length);
    check('COE scoped to another program of the same campus: paper, answer key, validators, blueprint, revise, archive all 403; lists exclude it',
      [seen.status, key.status, asg.status, bpw.status, rev.status, arc.status].every((x) => x === 403) && leaks.every((n) => n === 0),
      `${[seen.status, key.status, asg.status, bpw.status, rev.status, arc.status]} ${JSON.stringify(leaks)}`);
  }

  // The revision runs the normal workflow; printing it archives the printed v2 in the same transaction.
  r = await api('POST', `/examinations/papers/${v3}/validators`, { validator_ids: v.slice(0, 4) }, coe);
  for (const i of [1, 2, 3, 4]) r = await api('POST', `/validators/papers/${v3}/validate`, { decision: 'APPROVE', checklist }, await login(`validator${i}@portal.edu`, 'Valid@12345'));
  check('Revision v3 validated by 4 validators', r.data.paper_status === 'VALIDATED', JSON.stringify(r.data));
  {
    const ap2 = await api('POST', `/coe/papers/${v3}/coe-approve`, { totp_code: authenticator.generate(totpSetup.data.secret) }, coe2); // refused on scope before any TOTP check
    const sb2 = await api('POST', `/coe/papers/${v3}/send-back`, { reason: 'smoke: other program COE sends back' }, coe2);
    const st3 = await one('SELECT paper_status FROM exam_papers WHERE id = $1', [v3]);
    check('COE of another program cannot approve or send back the VALIDATED revision', ap2.status === 403 && sb2.status === 403 && st3.paper_status === 'VALIDATED',
      `${ap2.status} ${JSON.stringify(ap2.data)} ${sb2.status} ${st3.paper_status}`);
  }
  r = await api('POST', `/coe/papers/${v3}/coe-approve`, { totp_code: await freshTotp(totpSetup.data.secret) }, coe);
  r = await api('POST', `/coe/papers/${v3}/print-ready`, {}, coe);
  {
    const st = await rows('SELECT id, paper_status, archive_reason FROM exam_papers WHERE examination_id = $1 AND paper_status IN (\'PRINT_READY\', \'ARCHIVED\') ORDER BY paper_version', [exam.id]);
    const old = st.find((x) => x.id === printedV2); const now = st.find((x) => x.id === v3);
    const kept2 = await one('SELECT count(*)::int AS n FROM paper_validator_assignments WHERE paper_id = $1 AND is_active', [printedV2]);
    const aud = await one(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'paper_archived' AND entity_id = $1`, [printedV2]);
    check('Printing the revision archives the previously printed paper (one printed paper per examination, audited, approvals kept)',
      r.status === 200 && now?.paper_status === 'PRINT_READY' && old?.paper_status === 'ARCHIVED' && /Replaced by printed revision v3/.test(old.archive_reason || '')
      && st.filter((x) => x.paper_status === 'PRINT_READY').length === 1 && kept2.n === 4 && aud.n === 1, `${r.status} ${JSON.stringify(r.data)} ${JSON.stringify(st)} ${JSON.stringify([kept2, aud])}`);
  }
  paperId = v3;
  r = await api('POST', `/coe/papers/${paperId}/archive`, { reason: 'smoke test archive of a printed paper' }, coe);
  check('COE archives a PRINT_READY paper', r.status === 200 && r.data.paper_status === 'ARCHIVED', `${r.status} ${JSON.stringify(r.data)}`);
  {
    // Both printed papers of the examination are now ARCHIVED; their questions must still be "recently used".
    const printedQs = (await rows('SELECT DISTINCT question_id FROM paper_questions WHERE paper_id = ANY($1::uuid[])', [[printedV2, v3]])).map((x) => x.question_id);
    const recent = await loadRecentlyUsed({ course_offering_id: F.off }, 5, { all: rows });
    check('Recency: questions of printed papers that were later archived still count as recently used', printedQs.length >= 5 && printedQs.every((id) => recent.has(id)),
      `${JSON.stringify(printedQs)} vs ${JSON.stringify([...recent])}`);
  }
  {
    const kept = await one('SELECT count(*)::int AS n FROM paper_validator_assignments WHERE paper_id = $1 AND is_active', [paperId]);
    const st = await api('GET', `/coe/papers/${paperId}/coe-status`, null, coe);
    check('Archiving a printed paper keeps its 4 validator approvals as the record', kept.n === 4 && st.data.validator_approvals === 4, `${JSON.stringify(kept)} ${JSON.stringify(st.data)}`);
  }
  const frozen = await dbFails(`UPDATE exam_papers SET title = 'changed' WHERE id = $1`, [paperId], /ARCHIVED/);
  check('ARCHIVED paper is frozen (DB-enforced)', frozen.failed, frozen.message);

  console.log('\nValidator workflow integrity (migration 039)');
  {
    // An offering of its own (semester 6), so these checks do not depend on the flows above.
    const offV = (await one(`INSERT INTO course_offerings (subject_id, program_id, academic_session_id, semester, offering_code, status) VALUES ($1,$2,$3,6,$4,'active') RETURNING id`, [F.subject, F.programA, F.session, 'SMKV-' + tag])).id;
    const { sv: svV, unit: unitV, co: coV } = await mkSyllabus(offV);
    await db.query('INSERT INTO reviewer_assignments (reviewer_id, course_offering_id, assigned_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [F.reviewer, offV, F.hod]);
    for (let i = 0; i < 14; i++) await mkQuestion({ off: offV, sv: svV, unit: unitV, difficulty: 'easy', marks: 2, text: `validator flow easy question ${i} ${tag}`, co: coV });
    const vt = (i) => login(`validator${i}@portal.edu`, 'Valid@12345');
    const decide = async (paper, i, decision = 'APPROVE', comments) => api('POST', `/validators/papers/${paper}/validate`, { decision, checklist, comments }, await vt(i));
    const assign = (paper, ids) => api('POST', `/examinations/papers/${paper}/validators`, { validator_ids: ids }, coe);
    const pdfStatus = async (paper, token, q = '') => (await fetch(`${BASE}/examinations/papers/${paper}/pdf${q}`, { headers: { Authorization: `Bearer ${token}` } })).status;
    const genV = async (type) => {
      const e = await api('POST', '/examinations', { course_offering_id: offV, exam_type: type, maximum_marks: 4, duration_minutes: 30 }, coe);
      const b = await api('POST', '/examinations/blueprints', { examination_id: e.data.id, easy_count: 2, medium_count: 0, hard_count: 0, total_marks: 4 }, coe);
      const g = await api('POST', `/examinations/${e.data.id}/generate`, { blueprint_id: b.data.id }, coe);
      if (g.status !== 201) throw new Error(`validator-flow generation failed: ${g.status} ${JSON.stringify(g.data)}`);
      return g.data.paperId;
    };

    // ---- P1: one decision per assignment, reset, re-validation, issues, send-back, regeneration ----
    const P1 = await genV('end_term');
    const p1q = (await rows('SELECT question_id FROM paper_questions WHERE paper_id = $1 ORDER BY slot_number', [P1])).map((x) => x.question_id);
    let f = await dbFails('INSERT INTO paper_issues (paper_id, question_id, issue_type, description, reported_by) VALUES ($1,$2,$3,$4,$5)', [P1, p1q[0], 'spelling', 'raw insert', v[0]], /reported only while/);
    check('Issue on a GENERATED paper -> refused (DB)', f.failed, f.message);
    r = await assign(P1, v.slice(0, 4));
    check('P1: 4 validators assigned (round 1)', r.status === 200 && r.data.round === 1, `${r.status} ${JSON.stringify(r.data)}`);
    f = await dbFails('INSERT INTO paper_issues (paper_id, issue_type, description, reported_by) VALUES ($1,$2,$3,$4)', [P1, 'other', 'raw insert', v[4]], /Only a validator assigned/);
    check('Issue by an unassigned validator -> refused (DB)', f.failed, f.message);
    await decide(P1, 1); await decide(P1, 2);
    f = await dbFails(`UPDATE paper_validator_assignments SET decision = 'CHANGES_REQUIRED', comments = 'changed my mind' WHERE paper_id = $1 AND validator_id = $2`, [P1, v[0]], /already recorded a decision/);
    check('A recorded validator decision cannot be changed (DB)', f.failed, f.message);
    f = await dbFails('DELETE FROM paper_validator_assignments WHERE paper_id = $1', [P1], /cannot be deleted/);
    check('Validator assignments cannot be deleted (DB)', f.failed, f.message);
    f = await dbFails(`UPDATE paper_validation_reviews SET comments = 'rewritten' WHERE paper_id = $1`, [P1], /history/);
    const f2 = await dbFails('DELETE FROM paper_validation_reviews WHERE paper_id = $1', [P1], /history/);
    check('Validator reviews are append-only (DB)', f.failed && f2.failed, `${f.message} | ${f2.message}`);
    f = await dbFails(`UPDATE paper_validator_assignments SET is_active = FALSE WHERE paper_id = $1`, [P1], /deactivation_reason/);
    check('Ending an assignment needs a reason (DB)', f.failed, f.message);

    r = await api('POST', '/admin/overrides/reset-paper', { paper_id: P1, reason: 'smoke: validators left mid-review' }, admin);
    const ended = await one(`SELECT count(*) FILTER (WHERE is_active)::int AS active, count(*) FILTER (WHERE deactivation_reason = 'paper_reset')::int AS reset FROM paper_validator_assignments WHERE paper_id = $1`, [P1]);
    check('Admin reset ends the round (kept as history), paper back to GENERATED', r.status === 200 && ended.active === 0 && ended.reset === 4, `${r.status} ${JSON.stringify(r.data)} ${JSON.stringify(ended)}`);
    f = await dbFails('UPDATE paper_validator_assignments SET is_active = TRUE, deactivation_reason = NULL WHERE paper_id = $1', [P1], /history/);
    check('An ended assignment can never be reactivated (DB)', f.failed, f.message);
    r = await assign(P1, v.slice(0, 4));
    check('The same four validators can be assigned again (round 2)', r.status === 200 && r.data.round === 2, `${r.status} ${JSON.stringify(r.data)}`);
    for (const i of [1, 2, 3, 4]) r = await decide(P1, i);
    const twice = await one('SELECT count(*)::int AS n, count(DISTINCT assignment_id)::int AS a FROM paper_validation_reviews WHERE paper_id = $1 AND validator_id = $2', [P1, v[0]]);
    check('Re-validation after the reset reaches VALIDATED; each round keeps its own review', r.data.paper_status === 'VALIDATED' && twice.n === 2 && twice.a === 2, `${JSON.stringify(r.data)} ${JSON.stringify(twice)}`);

    r = await api('POST', `/examinations/papers/${P1}/issues`, { issue_type: 'incorrect', description: 'model answer of Q1 is wrong', question_id: p1q[0] }, await vt(1));
    const issueQ = r.data.id;
    const r2 = await api('POST', `/examinations/papers/${P1}/issues`, { issue_type: 'formatting', description: 'instructions missing on top' }, await vt(2));
    const issueP = r2.data.id;
    check('Validators can report issues on a VALIDATED paper', r.status === 201 && r2.status === 201, `${r.status} ${r2.status} ${JSON.stringify(r.data)}`);
    const mine = await api('GET', `/examinations/papers/${P1}/issues`, null, await vt(1));
    check('A validator sees only their own issues', mine.status === 200 && mine.data.length === 1 && mine.data[0].id === issueQ && !mine.data[0].reported_by_email, JSON.stringify(mine.data));
    f = await txnFails([], `UPDATE exam_papers SET paper_status = 'COE_APPROVED', coe_approved_by = $2, coe_approved_at = now(), coe_approval_totp_verified = TRUE WHERE id = $1`, [P1, F.coe], /Open validator issues/);
    check('Open issue -> COE approval refused (DB)', f.failed, f.message);
    f = await txnFails([], `UPDATE exam_papers SET paper_status = 'CHANGES_REQUIRED' WHERE id = $1`, [P1], /recorded COE send-back/);
    check('VALIDATED -> CHANGES_REQUIRED without a recorded send-back -> refused (DB)', f.failed, f.message);
    f = await txnFails([async () => db.query(`INSERT INTO paper_send_backs (paper_id, from_status, reason, sent_back_by) VALUES ($1,'VALIDATED','smoke: rolled back check',$2)`, [P1, F.coe])],
      `UPDATE exam_papers SET paper_status = 'CHANGES_REQUIRED' WHERE id = $1`, [P1]);
    check('VALIDATED -> CHANGES_REQUIRED with a send-back row in the same transaction -> allowed (rolled back)', !f.failed, f.message);
    r = await api('POST', `/coe/papers/${P1}/send-back`, { reason: 'smoke: Q1 model answer is wrong' }, coe);
    const sb = await one('SELECT from_status, open_issue_ids FROM paper_send_backs WHERE paper_id = $1', [P1]);
    check('COE sends a VALIDATED paper back with a reason (recorded)', r.status === 200 && r.data.paper_status === 'CHANGES_REQUIRED' && sb?.from_status === 'VALIDATED' && sb.open_issue_ids.length === 2,
      `${r.status} ${JSON.stringify(r.data)} ${JSON.stringify(sb)}`);
    const gone = await api('GET', `/examinations/papers/${P1}`, null, await vt(1));
    const late = await api('POST', `/examinations/papers/${P1}/issues`, { issue_type: 'other', description: 'another thought' }, await vt(1));
    check('After send-back validators lose the paper and cannot report', gone.status === 403 && late.status === 409, `${gone.status} ${late.status}`);
    r = await api('POST', `/examinations/papers/${P1}/regenerate`, { reason: 'smoke: fix Q1' }, coe);
    const P1b = r.data.paperId;
    const iq = await one('SELECT status, resolution FROM paper_issues WHERE id = $1', [issueQ]);
    const ip = await one('SELECT status, carried_to_issue_id FROM paper_issues WHERE id = $1', [issueP]);
    const copy = ip?.carried_to_issue_id ? await one('SELECT paper_id, status, origin_issue_id FROM paper_issues WHERE id = $1', [ip.carried_to_issue_id]) : null;
    const newQs = P1b ? (await rows('SELECT question_id FROM paper_questions WHERE paper_id = $1', [P1b])).map((x) => x.question_id) : [];
    check('Regeneration leaves out the flagged question and resolves its issue', r.status === 201 && !newQs.includes(p1q[0]) && iq.status === 'resolved' && /replaced by regeneration/.test(iq.resolution),
      `${r.status} ${JSON.stringify(r.data)} ${JSON.stringify(iq)}`);
    check('A paper-level issue is carried to the new revision (open there, carried_forward here)', ip.status === 'carried_forward' && copy?.paper_id === P1b && copy.status === 'open' && copy.origin_issue_id === issueP,
      `${JSON.stringify(ip)} ${JSON.stringify(copy)}`);
    const rev = P1b ? await one(`SELECT count(*)::int AS n FROM paper_revisions WHERE paper_id = $1 AND change_type = 'issue_resolution'`, [P1b]) : { n: 0 };
    const st1b = P1b ? await api('GET', `/coe/papers/${P1b}/coe-status`, null, coe) : { data: {} };
    check('issue_resolution revision written; the carried issue blocks the new revision', rev.n === 1 && st1b.data.open_issues === 1 && (st1b.data.blockers || []).some((b) => /issue/.test(b)),
      `${JSON.stringify(rev)} ${JSON.stringify(st1b.data)}`);
    const sup = await one(`SELECT count(*) FILTER (WHERE is_active)::int AS active, count(*) FILTER (WHERE deactivation_reason = 'paper_regenerated')::int AS regen FROM paper_validator_assignments WHERE paper_id = $1`, [P1]);
    const told = await one(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'validation_ended' AND entity_id = $2`, [v[0], P1]);
    check('Regeneration ends the old revision\'s validators and tells them', sup.active === 0 && sup.regen === 4 && told.n >= 1, `${JSON.stringify(sup)} ${JSON.stringify(told)}`);
    f = await dbFails(`UPDATE paper_issues SET resolution = 'changed afterwards by hand' WHERE id = $1`, [issueQ], /already closed/);
    check('A closed issue cannot change (DB)', f.failed, f.message);
    f = await dbFails(`UPDATE paper_issues SET description = 'edited' WHERE id = $1`, [ip.carried_to_issue_id], /cannot be edited/);
    const fd = await dbFails('DELETE FROM paper_issues WHERE id = $1', [ip.carried_to_issue_id], /cannot be deleted/);
    check('A reported issue cannot be edited or deleted (DB)', f.failed && fd.failed, `${f.message} | ${fd.message}`);
    const statusBefore = await one('SELECT question_status FROM questions WHERE id = $1', [p1q[0]]);
    r = await api('POST', `/examinations/issues/${issueQ}/refer`, { note: 'please re-check the model answer of this question' }, coe);
    const refNote = await one(`SELECT count(*)::int AS n FROM notifications WHERE type = 'question_referred_by_examination' AND entity_id = $1`, [p1q[0]]);
    const statusAfter = await one('SELECT question_status FROM questions WHERE id = $1', [p1q[0]]);
    check('Referral notifies the reviewer/HOD (entity = the question) and never writes the bank', r.status === 201 && refNote.n >= 1 && statusAfter.question_status === statusBefore.question_status,
      `${r.status} ${JSON.stringify(r.data)} ${JSON.stringify(refNote)} ${JSON.stringify([statusBefore, statusAfter])}`);
    r = await api('POST', `/examinations/issues/${issueQ}/refer`, { note: 'please re-check the model answer of this question' }, coe);
    check('An issue is referred once', r.status === 409, `${r.status}`);

    // ---- P2: scope revoked after assignment, then single-validator replacement ----
    const P2 = await genV('mid_term');
    await assign(P2, v.slice(0, 4));
    const scope2 = await one(`SELECT id FROM user_scopes WHERE user_id = $1 AND role = 'validator' AND is_active ORDER BY created_at LIMIT 1`, [v[1]]);
    await api('DELETE', `/admin/scopes/${scope2.id}`, null, admin);
    r = await decide(P2, 2);
    const listed = await api('GET', `/examinations/papers/${P2}/validators`, null, coe);
    const slot2 = (listed.data || []).find((a) => a.validator_number === 2);
    const nr = await one(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'validator_needs_replacement' AND entity_id = $2`, [F.coe, P2]);
    check('Validator scope revoked after assignment -> decision refused; flagged for replacement; COE told', r.status === 403 && /scope/.test(r.data.error || '') && (slot2?.problems || []).length > 0 && nr.n >= 1,
      `${r.status} ${JSON.stringify(r.data)} ${JSON.stringify(slot2)} ${JSON.stringify(nr)}`);
    {
      // Review fix: losing scope also ends access to the paper, its answer key and issue reporting at once.
      const v2t = await vt(2);
      const seen = await api('GET', `/examinations/papers/${P2}`, null, v2t);
      const keyStatus = await pdfStatus(P2, v2t, '?include_answers=1');
      const rep2 = await api('POST', `/examinations/papers/${P2}/issues`, { issue_type: 'other', description: 'reported after losing scope' }, v2t);
      const raw = await dbFails('INSERT INTO paper_issues (paper_id, issue_type, description, reported_by) VALUES ($1,$2,$3,$4)', [P2, 'other', 'raw insert after losing scope', v[1]], /scope covers this examination/);
      const queue = (await api('GET', '/validators/my-validations', null, v2t)).data || [];
      check('Validator who lost scope: paper, answer key and issue reporting refused (API and DB); queue says it cannot be opened',
        seen.status === 403 && /required scope/.test(seen.data.error || '') && keyStatus === 403 && rep2.status === 403 && raw.failed
        && queue.find((x) => x.paper_id === P2)?.can_open === false, `${seen.status} ${JSON.stringify(seen.data)} ${keyStatus} ${rep2.status} ${raw.message}`);
    }
    await api('POST', '/admin/scopes', { user_id: v[1], role: 'validator', campus_id: CAMPUS_A }, admin);
    for (const i of [1, 2, 3]) await decide(P2, i);
    r = await api('POST', `/examinations/papers/${P2}/validators/1/replace`, { validator_id: v[4], reason: 'smoke: try to replace a decided slot' }, coe);
    check('A slot with a recorded decision cannot be replaced', r.status === 409, `${r.status} ${JSON.stringify(r.data)}`);
    r = await api('POST', `/examinations/papers/${P2}/validators/4/replace`, { validator_id: v[4], reason: 'smoke: validator 4 is on leave' }, coe);
    const kept = await one('SELECT count(*) FILTER (WHERE decision IS NOT NULL)::int AS decided, count(*)::int AS n FROM paper_validator_assignments WHERE paper_id = $1 AND is_active', [P2]);
    check('COE replaces one undecided validator; the other decisions stay', r.status === 200 && kept.decided === 3 && kept.n === 4, `${r.status} ${JSON.stringify(r.data)} ${JSON.stringify(kept)}`);
    const old4 = await vt(4);
    r = await decide(P2, 4);
    const oldPdf = await pdfStatus(P2, old4);
    check('The replaced validator can no longer decide or download the paper', r.status === 403 && oldPdf === 403, `${r.status} ${oldPdf}`);
    r = await decide(P2, 5);
    const hist = await api('GET', `/examinations/papers/${P2}/validators?history=1`, null, coe);
    check('The replacement validator completes validation -> VALIDATED; history keeps the replaced row', r.data.paper_status === 'VALIDATED' && (hist.data || []).some((a) => a.deactivation_reason === 'replaced'),
      `${JSON.stringify(r.data)} ${JSON.stringify(hist.data)}`);
    check('Assigned validator still sees the VALIDATED paper with its answer key (window ends at COE approval)', (await pdfStatus(P2, await vt(5), '?include_answers=1')) === 200);

    // ---- P3: independence policy with a real reviewer action, then a decision racing a replacement ----
    const P3 = await genV('quiz');
    const p3q = (await rows('SELECT question_id FROM paper_questions WHERE paper_id = $1 ORDER BY slot_number', [P3])).map((x) => x.question_id);
    // A verdict recorded by validator5 on one of the paper's questions (the legacy reviewer_verdicts table).
    await db.query(`INSERT INTO reviewer_verdicts (question_id, reviewer_id, verdict) VALUES ($1,$2,'looks_good') ON CONFLICT DO NOTHING`, [p3q[0], v[4]]);
    await api('PUT', '/admin/settings/validator-independence', { exclude_question_reviewers: true, reason: 'smoke: independence check on' }, admin);
    const cands = await api('GET', `/examinations/validators?paper_id=${P3}`, null, coe);
    const c5 = (cands.data || []).find((u) => u.id === v[4]);
    r = await assign(P3, [v[4], v[1], v[2], v[3]]);
    check('Independence policy: a validator who reviewed a paper question is flagged and cannot be assigned', (c5?.conflicts || []).some((x) => /reviewer verdict/.test(x)) && r.status === 403 && /Validator 1: Validator reviewed a question/.test(r.data.error || ''),
      `${JSON.stringify(c5)} ${r.status} ${JSON.stringify(r.data)}`);
    await api('PUT', '/admin/settings/validator-independence', { exclude_question_reviewers: false, reason: 'smoke: independence check off' }, admin);
    await assign(P3, v.slice(0, 4));
    await decide(P3, 1);
    // DB backstop (review fix): a recorded decision is never ended by a replacement or a new round.
    f = await txnFails([], `UPDATE paper_validator_assignments SET is_active = FALSE, deactivation_reason = 'replaced' WHERE paper_id = $1 AND validator_number = 1 AND is_active`, [P3], /cannot be replaced/);
    const f3 = await txnFails([], `UPDATE paper_validator_assignments SET is_active = FALSE, deactivation_reason = 'reassigned' WHERE paper_id = $1 AND validator_number = 1 AND is_active`, [P3], /cannot be replaced/);
    check('Ending a decided assignment as replaced/reassigned -> refused (DB)', f.failed && f3.failed, `${f.message} | ${f3.message}`);
    // A NON-final decision racing a replacement of the same slot, both queued on the paper row (deterministic):
    // exactly one wins and the loser changes nothing; a recorded decision is never discarded.
    const H3 = new pg.Client({ connectionString: process.env.DATABASE_URL }); await H3.connect();
    try {
      await H3.query('BEGIN'); await H3.query('SELECT id FROM exam_papers WHERE id = $1 FOR UPDATE', [P3]);
      const decP = decide(P3, 2);
      const repP = api('POST', `/examinations/papers/${P3}/validators/2/replace`, { validator_id: v[4], reason: 'smoke: race with the decision' }, coe);
      let queued = false;
      for (const t0 = Date.now(); Date.now() - t0 < 5000 && !queued;) {
        queued = (await one(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).n >= 2;
        if (!queued) await new Promise((res) => setTimeout(res, 50));
      }
      await H3.query('COMMIT');
      const [dec, rep] = await Promise.all([decP, repP]);
      const slot = await rows('SELECT validator_id, decision, is_active, deactivation_reason FROM paper_validator_assignments WHERE paper_id = $1 AND validator_number = 2 ORDER BY assigned_at', [P3]);
      const active3 = await one('SELECT count(*)::int AS n FROM paper_validator_assignments WHERE paper_id = $1 AND is_active', [P3]);
      const reviews = await one('SELECT count(*)::int AS n FROM paper_validation_reviews WHERE paper_id = $1 AND validator_id = $2', [P3, v[1]]);
      const decisionWon = dec.status === 200 && rep.status === 409 && slot.length === 1 && slot[0].is_active && slot[0].decision === 'APPROVE' && reviews.n === 1;
      const replaceWon = rep.status === 200 && dec.status === 403 && slot.length === 2 && !slot[0].is_active && slot[0].decision === null && slot[0].deactivation_reason === 'replaced'
        && slot[1].validator_id === v[4] && slot[1].is_active && reviews.n === 0;
      check('A non-final decision racing a replacement of its slot (queued on the paper row): exactly one wins; a recorded decision is never discarded',
        queued && active3.n === 4 && (decisionWon || replaceWon), `${queued} ${dec.status} ${JSON.stringify(dec.data)} | ${rep.status} ${JSON.stringify(rep.data)} | ${JSON.stringify(slot)} ${JSON.stringify(reviews)}`);
    } finally { await H3.end().catch(() => {}); }

    // ---- P4: send-back from VALIDATION_PENDING with recorded decisions; the technical reset cannot overturn objections ----
    const P4 = await genV('supplementary');
    await assign(P4, v.slice(0, 4));
    await decide(P4, 1, 'CHANGES_REQUIRED', 'smoke: Q2 is ambiguous'); await decide(P4, 2);
    r = await api('POST', '/admin/overrides/reset-paper', { paper_id: P4, reason: 'smoke: admin tries to discard an objection' }, admin);
    f = await txnFails([async () => db.query(`SELECT set_config('app.paper_override', 'on', true)`)], `UPDATE exam_papers SET paper_status = 'GENERATED' WHERE id = $1`, [P4], /cannot discard a CHANGES_REQUIRED decision/);
    const f4 = await txnFails([async () => db.query(`SELECT set_config('app.paper_override', 'on', true)`)],
      `UPDATE paper_validator_assignments SET is_active = FALSE, deactivation_reason = 'paper_reset' WHERE paper_id = $1 AND is_active`, [P4], /cannot discard a CHANGES_REQUIRED decision/);
    check('Technical reset over a recorded CHANGES_REQUIRED decision -> refused (API 409, DB lifecycle and assignment guard)',
      r.status === 409 && /CHANGES_REQUIRED/.test(r.data.error || '') && f.failed && f4.failed, `${r.status} ${JSON.stringify(r.data)} | ${f.message} | ${f4.message}`);
    r = await api('POST', `/coe/papers/${P4}/send-back`, { reason: 'smoke: Q2 must be reworded' }, coe);
    const sb4 = await one('SELECT from_status FROM paper_send_backs WHERE paper_id = $1', [P4]);
    const late4 = await decide(P4, 3);
    const act4 = await one(`SELECT count(*) FILTER (WHERE is_active)::int AS active, count(*) FILTER (WHERE decision IS NOT NULL)::int AS decided FROM paper_validator_assignments WHERE paper_id = $1`, [P4]);
    check('Send-back from VALIDATION_PENDING (2 decisions recorded) -> CHANGES_REQUIRED; a later decision -> 409; assignments and decisions kept',
      r.status === 200 && r.data.paper_status === 'CHANGES_REQUIRED' && sb4?.from_status === 'VALIDATION_PENDING' && late4.status === 409 && act4.active === 4 && act4.decided === 2,
      `${r.status} ${JSON.stringify(r.data)} ${JSON.stringify(sb4)} ${late4.status} ${JSON.stringify(act4)}`);
    r = await api('POST', '/admin/overrides/reset-paper', { paper_id: P4, reason: 'smoke: admin tries to undo the verdict' }, admin);
    f = await txnFails([async () => db.query(`SELECT set_config('app.paper_override', 'on', true)`)], `UPDATE exam_papers SET paper_status = 'GENERATED' WHERE id = $1`, [P4], /Invalid paper status transition: CHANGES_REQUIRED -> GENERATED/);
    check('Technical reset of a CHANGES_REQUIRED paper -> refused (API 409 and DB)', r.status === 409 && /not stuck/.test(r.data.error || '') && f.failed, `${r.status} ${JSON.stringify(r.data)} | ${f.message}`);
    r = await api('POST', `/examinations/papers/${P4}/regenerate`, { reason: 'smoke: reword Q2' }, coe);
    const end4 = await one(`SELECT count(*) FILTER (WHERE NOT is_active AND deactivation_reason = 'paper_regenerated')::int AS ended, count(*)::int AS n FROM paper_validator_assignments WHERE paper_id = $1`, [P4]);
    check('Regenerating the sent-back paper ends all four assignments (decided and undecided)', r.status === 201 && end4.ended === 4 && end4.n === 4, `${r.status} ${JSON.stringify(r.data)} ${JSON.stringify(end4)}`);

    // ---- P5: archiving an unprinted (CHANGES_REQUIRED) paper ends its four validators; they lose the paper ----
    const P5 = await genV('makeup');
    await assign(P5, v.slice(0, 4));
    await decide(P5, 1, 'CHANGES_REQUIRED', 'smoke: wrong marks on Q1');
    for (const i of [2, 3, 4]) r = await decide(P5, i);
    const cr5 = r.data.paper_status;
    r = await api('POST', `/coe/papers/${P5}/archive`, { reason: 'smoke: exam plan changed, not needed' }, coe);
    const end5 = await one(`SELECT count(*) FILTER (WHERE NOT is_active AND deactivation_reason = 'paper_archived')::int AS ended, count(*)::int AS n FROM paper_validator_assignments WHERE paper_id = $1`, [P5]);
    const pdf5 = await pdfStatus(P5, await vt(1)); const told5 = await one(`SELECT count(*)::int AS n FROM notifications WHERE type = 'validation_ended' AND entity_id = $1`, [P5]);
    check('Archiving a CHANGES_REQUIRED paper ends its 4 validators (paper_archived), tells them, and they lose the PDF',
      cr5 === 'CHANGES_REQUIRED' && r.status === 200 && end5.ended === 4 && end5.n === 4 && pdf5 === 403 && told5.n >= 4, `${cr5} ${r.status} ${JSON.stringify(end5)} ${pdf5} ${JSON.stringify(told5)}`);
  }

  console.log('\nQuestion types, sections, reservations (implementation prompt)');
  // Type-specific validation on the teacher API (spec §10)
  const asg0 = (await api('GET', '/academic/my-assignments', null, teacher)).data.find((a) => a.course_offering_id === F.off) || (await api('GET', '/academic/my-assignments', null, teacher)).data[0];
  r = await api('POST', '/questions/draft', { question_type: 'numerical', question_text: `How many edges does a tree with 5 nodes have? ${tag}`, difficulty: 'easy', marks: 2,
    answer_data: { expected_value: 4 }, course_offering_id: asg0.course_offering_id, section_id: asg0.section_id }, teacher);
  check('Numerical draft with expected answer is saved', r.status === 200 && !!r.data.id, `${r.status} ${JSON.stringify(r.data)}`);
  const savedNum = r.data.id ? await one('SELECT question_type, answer_data FROM questions WHERE id = $1', [r.data.id]) : null;
  check('Type and answer data stored', savedNum?.question_type === 'numerical' && Number(savedNum?.answer_data?.expected_value) === 4, JSON.stringify(savedNum));
  r = await api('POST', '/questions/draft', { question_type: 'fill_blank', question_text: `A ___ has ___ children ${tag}`, difficulty: 'easy', marks: 2,
    answer_data: { answers: ['binary tree'] }, course_offering_id: asg0.course_offering_id }, teacher);
  check('Fill in the Blank with fewer answers than blanks -> refused', r.status === 400 && /2 blank\(s\) but 1 answer/.test(JSON.stringify(r.data)), `${r.status} ${JSON.stringify(r.data)}`);
  const legacyTypes = await one(`SELECT count(*)::int AS n FROM questions WHERE question_type IN ('objective', 'subjective')`);
  check('No question keeps a pre-pivot type name (migrated to mcq/descriptive)', legacyTypes.n === 0, JSON.stringify(legacyTypes));

  // Type-specific quality gate (DB)
  const numQ = await mkQuestion({ off: F.off, sv: F.sv1, unit: F.unit1, difficulty: 'easy', marks: 2, text: `numerical without expected value ${tag}`, status: 'APPROVED', co: F.co1, type: 'numerical' });
  r = await api('POST', `/questions/${numQ}/transition`, { target_status: 'ACTIVE' }, reviewer);
  check('Numerical without expected answer -> ACTIVE denied', r.status === 400 && /Numerical needs/.test(JSON.stringify(r.data)), `${r.status} ${JSON.stringify(r.data)}`);
  const fix = await dbFails(`UPDATE questions SET answer_data = '{"expected_value": 7}' WHERE id = $1`, [numQ], /content is locked/);
  check('APPROVED answer data cannot be edited in place', fix.failed, fix.message);
  const numQ2 = await mkQuestion({ off: F.off, sv: F.sv1, unit: F.unit1, difficulty: 'easy', marks: 2, text: `numerical with expected value ${tag}`, status: 'APPROVED', co: F.co1, type: 'numerical', answerData: { expected_value: 7 } });
  r = await api('POST', `/questions/${numQ2}/transition`, { target_status: 'ACTIVE' }, reviewer);
  check('Numerical with expected answer -> ACTIVE', r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
  const diagQ = await mkQuestion({ off: F.off, sv: F.sv1, unit: F.unit1, difficulty: 'easy', marks: 2, text: `label the parts of the diagram ${tag}`, status: 'APPROVED', co: F.co1, type: 'diagram' });
  r = await api('POST', `/questions/${diagQ}/transition`, { target_status: 'ACTIVE' }, reviewer);
  check('Diagram without an attached diagram -> ACTIVE denied', r.status === 400 && /attached diagram/.test(JSON.stringify(r.data)), `${r.status} ${JSON.stringify(r.data)}`);

  // Concurrency: two examinations of the same offering generated at the same moment never share a question
  const extra = [];
  for (let i = 0; i < 4; i++) extra.push(await mkQuestion({ off: F.off, sv: F.sv1, unit: F.unit1, difficulty: 'easy', marks: 2, text: `extra easy for concurrency ${i} ${tag}`, co: F.co1 }));
  const mkExam = async (type) => {
    const e = await api('POST', '/examinations', { course_offering_id: F.off, exam_type: type, maximum_marks: 4, duration_minutes: 30 }, coe);
    const b = await api('POST', '/examinations/blueprints', { examination_id: e.data.id, easy_count: 2, medium_count: 0, hard_count: 0, total_marks: 4,
      sections: [{ name: 'Section A', question_count: 2, marks_per_question: 2, question_types: ['descriptive', 'numerical'], instructions: 'Answer both.' }] }, coe);
    return { exam: e.data, bp: b.data, status: [e.status, b.status] };
  };
  const ex1 = await mkExam('mid_term'); const ex2 = await mkExam('quiz');
  check('Sectioned blueprints accepted', ex1.status.join() === '201,201' && ex2.status.join() === '201,201' && ex1.bp.hard_targets === true, JSON.stringify([ex1.status, ex2.status, ex1.bp.hard_targets]));
  const [g1, g2] = await Promise.all([
    api('POST', `/examinations/${ex1.exam.id}/generate`, { blueprint_id: ex1.bp.id }, coe),
    api('POST', `/examinations/${ex2.exam.id}/generate`, { blueprint_id: ex2.bp.id }, coe),
  ]);
  check('Concurrent generations both complete', g1.status === 201 && g2.status === 201, `${g1.status} ${JSON.stringify(g1.data)} | ${g2.status} ${JSON.stringify(g2.data)}`);
  let ex3 = null;
  if (g1.status === 201 && g2.status === 201) {
    const overlap = await one(`SELECT count(*)::int AS n FROM paper_questions a JOIN paper_questions b ON a.question_id = b.question_id WHERE a.paper_id = $1 AND b.paper_id = $2`, [g1.data.paperId, g2.data.paperId]);
    check('Concurrent papers share no question (reservations)', overlap.n === 0, JSON.stringify(overlap));
    const held = await one(`SELECT count(*)::int AS n FROM question_reservations WHERE paper_id = ANY($1::uuid[]) AND released_at IS NULL`, [[g1.data.paperId, g2.data.paperId]]);
    check('Each picked question is reserved exactly once', held.n === 4, JSON.stringify(held));
    const secs = await one(`SELECT count(*) FILTER (WHERE section_name = 'Section A')::int AS a, count(*)::int AS n FROM paper_questions WHERE paper_id = $1`, [g1.data.paperId]);
    check('Paper questions carry their section', secs.a === 2 && secs.n === 2, JSON.stringify(secs));
    const pdf2 = await fetch(`${BASE}/examinations/papers/${g1.data.paperId}/pdf`, { headers: { Authorization: `Bearer ${coe}` } });
    check('Sectioned draft paper renders as PDF', pdf2.status === 200, `${pdf2.status}`);
    ex3 = await mkExam('makeup');
    const g3 = await api('POST', `/examinations/${ex3.exam.id}/generate`, { blueprint_id: ex3.bp.id }, coe);
    check('Reserved questions are not eligible for another examination', g3.status === 422 || (g3.status === 201 && (await one(
      `SELECT count(*)::int AS n FROM paper_questions WHERE paper_id = $1 AND question_id IN (SELECT question_id FROM paper_questions WHERE paper_id = ANY($2::uuid[]))`,
      [g3.data.paperId, [g1.data.paperId, g2.data.paperId]])).n === 0), `${g3.status} ${JSON.stringify(g3.data)}`);
    r = await api('POST', `/coe/papers/${g2.data.paperId}/archive`, { reason: 'smoke: release reserved questions' }, coe);
    const freed = await one(`SELECT count(*)::int AS n FROM question_reservations WHERE paper_id = $1 AND released_at IS NULL`, [g2.data.paperId]);
    check('Archiving a paper releases its reservations', r.status === 200 && freed.n === 0, `${r.status} ${JSON.stringify(freed)}`);
  }

  // Analytics match the database (HOD view, filtered to this offering)
  r = await api('GET', `/question-bank/analytics?course_offering_id=${F.off}`, null, hod);
  const truthStatus = await db.query(`SELECT question_status AS key, count(*)::int AS n FROM questions WHERE course_offering_id = $1 GROUP BY 1`, [F.off]);
  const truthType = await db.query(`SELECT question_type AS key, count(*)::int AS n FROM questions WHERE course_offering_id = $1 AND question_status = 'ACTIVE' GROUP BY 1`, [F.off]);
  const asMap = (rows) => Object.fromEntries((rows || []).map((x) => [x.key, Number(x.n)]));
  const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
  check('Analytics status counts equal SQL truth', r.status === 200 && same(asMap(r.data.by_status), asMap(truthStatus.rows)), `${JSON.stringify(r.data.by_status)} vs ${JSON.stringify(truthStatus.rows)}`);
  check('Analytics ACTIVE-by-type counts equal SQL truth (new type codes)', r.status === 200 && same(asMap(r.data.active_by_type), asMap(truthType.rows)), `${JSON.stringify(r.data.active_by_type)} vs ${JSON.stringify(truthType.rows)}`);

  // Hard targets: CO targets name active COs; legacy soft targets are refused; an override is accepted only when
  // strict generation fails, is recorded (paper + paper_constraint_overrides + audit) and approved by the generating COE.
  // (all five exam types of this offering are now used, so the 'makeup' examination is reused; its paper is archived first)
  const ex4 = ex3;
  check('Hard-target checks ran', !!ex4?.exam?.id, 'previous step did not create the makeup examination');
  if (ex4?.exam?.id) {
    const live4 = await one(`SELECT id FROM exam_papers WHERE examination_id = $1 AND paper_status = 'GENERATED'`, [ex4.exam.id]);
    if (live4) await api('POST', `/coe/papers/${live4.id}/archive`, { reason: 'smoke: make room for the target checks' }, coe);
    const save = (extra) => api('POST', '/examinations/blueprints', { examination_id: ex4.exam.id, easy_count: 2, medium_count: 0, hard_count: 0, total_marks: 4, ...extra }, coe);
    r = await save({ co_distribution: { CO9: 1 } });
    check('CO target naming no active course outcome -> refused at save', r.status === 400 && /CO9 is not an active course outcome/.test(JSON.stringify(r.data)), `${r.status} ${JSON.stringify(r.data)}`);
    const legacyBp = (await one(`INSERT INTO paper_blueprints (name, department_id, easy_count, medium_count, hard_count, created_by, is_active, examination_id, course_offering_id,
        version_number, total_marks, co_distribution, hard_targets) VALUES ('legacy smoke', $1, 2, 0, 0, $2, FALSE, $3, $4, 99, 4, '{"CO1": 1}', FALSE) RETURNING id`, [F.dept, F.coe, ex4.exam.id, F.off])).id;
    r = await api('POST', `/examinations/${ex4.exam.id}/generate`, { blueprint_id: legacyBp }, coe);
    check('Legacy soft-target blueprint with targets -> 422 LEGACY_BLUEPRINT', r.status === 422 && r.data.code === 'LEGACY_BLUEPRINT', `${r.status} ${JSON.stringify(r.data)}`);
    const bpOk = (await save({ co_distribution: { co1: 2 } })).data;
    const counts = async () => one(`SELECT (SELECT count(*)::int FROM exam_papers) AS papers, (SELECT count(*)::int FROM question_reservations) AS reservations, (SELECT count(*)::int FROM audit_log) AS audits`);
    const c0 = await counts();
    r = await api('POST', `/examinations/${ex4.exam.id}/feasibility`, { blueprint_id: bpOk.id }, coe);
    const c1 = await counts();
    check('Feasibility dry run: verdict without writing anything (papers, reservations, audit)', r.status === 200 && r.data.feasible === true && bpOk.co_distribution?.CO1 === 2
      && JSON.stringify(c0) === JSON.stringify(c1), `${r.status} ${JSON.stringify(r.data).slice(0, 300)} ${JSON.stringify([c0, c1])}`);
    r = await api('POST', `/examinations/${ex4.exam.id}/generate`, { blueprint_id: bpOk.id, override: { relax: ['co'], reason: 'smoke test: trying an unneeded override' } }, coe);
    check('Override on a feasible blueprint -> 422 OVERRIDE_NOT_NEEDED', r.status === 422 && r.data.code === 'OVERRIDE_NOT_NEEDED', `${r.status} ${JSON.stringify(r.data)}`);
    // CO3 ('taught later') is part of F.sv1 from the start (setup): content changes only while a version is DRAFT (042).
    const bpCo = (await save({ co_distribution: { CO3: 1 } })).data;
    const before = await one('SELECT count(*)::int AS n FROM exam_papers WHERE examination_id = $1', [ex4.exam.id]);
    r = await api('POST', `/examinations/${ex4.exam.id}/generate`, { blueprint_id: bpCo.id }, coe);
    const after = await one('SELECT count(*)::int AS n FROM exam_papers WHERE examination_id = $1', [ex4.exam.id]);
    check('Unmeetable CO target -> clear reason, no paper written', r.status === 422 && /CO3/.test(JSON.stringify(r.data)) && after.n === before.n, `${r.status} ${JSON.stringify(r.data)}`);
    r = await api('POST', `/examinations/${ex4.exam.id}/generate`, { blueprint_id: bpCo.id, override: { relax: ['co'], reason: 'smoke test: CO3 not taught this term' } }, coe);
    const ovPaper = r.data.paperId;
    const ov = r.status === 201 ? await one('SELECT constraint_overrides FROM exam_papers WHERE id = $1', [ovPaper]) : null;
    const rec = r.status === 201 ? await rows('SELECT constraint_type, original_value, approved_by, approval_basis FROM paper_constraint_overrides WHERE paper_id = $1', [ovPaper]) : [];
    const aud = r.status === 201 ? await one(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'generation_constraint_override' AND entity_id = $1`, [ovPaper]) : { n: 0 };
    check('CO override with reason -> generated and recorded (paper, override record approved by the generating COE, audit)', r.status === 201 && ov?.constraint_overrides?.relax?.[0] === 'co'
      && rec.length === 1 && rec[0].original_value?.CO3 === 1 && rec[0].approved_by === F.coe && rec[0].approval_basis === 'generating_coe' && aud.n === 1,
      `${r.status} ${JSON.stringify(r.data)} ${JSON.stringify(rec)} ${JSON.stringify(aud)}`);
    if (ovPaper) {
      f = await dbFails(`UPDATE paper_constraint_overrides SET reason = 'rewritten afterwards' WHERE paper_id = $1`, [ovPaper], /permanent/);
      const f2 = await dbFails(`INSERT INTO paper_constraint_overrides (paper_id, constraint_type, original_value, override_value, reason, overridden_by) VALUES ($1, 'co_distribution', '{}', '{}', 'late', $2)`,
        [ovPaper, F.coe], /only be recorded by the generation/);
      check('Override records are permanent and only written by the generation (DB)', f.failed && f2.failed, `${f.message} | ${f2.message}`);
      const frozen = [];
      for (const col of ['candidate_metrics', 'constraint_overrides', 'format_config']) frozen.push((await dbFails(`UPDATE exam_papers SET ${col} = '{}' WHERE id = $1`, [ovPaper], /Generation metadata/)).failed);
      check('What the generator decided (targets, overrides, section rules) cannot change after generation (DB)', frozen.every(Boolean), JSON.stringify(frozen));
      const used = [];
      for (const set of [`sections = '[]'`, 'hard_targets = FALSE', `name = 'renamed'`]) used.push((await dbFails(`UPDATE paper_blueprints SET ${set} WHERE id = $1`, [bpCo.id], /cannot be modified|legacy/)).failed);
      used.push((await dbFails('DELETE FROM paper_blueprints WHERE id = $1', [bpCo.id], /cannot be deleted/)).failed);
      const deact = await dbFails('UPDATE paper_blueprints SET is_active = FALSE WHERE id = $1', [bpCo.id]);
      check('A used blueprint: sections, hard flag and name frozen, never deleted; is_active may change (DB)', used.every(Boolean) && !deact.failed, `${JSON.stringify(used)} ${deact.message}`);
    }
  }

  console.log('\nGeneration concurrency (phase 2)');
  {
    // An offering of its own (semester 7): 4 easy (2 marks) and 1 medium (4 marks, "M") questions.
    const offC = (await one(`INSERT INTO course_offerings (subject_id, program_id, academic_session_id, semester, offering_code, status) VALUES ($1,$2,$3,7,$4,'active') RETURNING id`, [F.subject, F.programA, F.session, 'SMKC-' + tag])).id;
    const { sv: svC, unit: unitC, co: coC } = await mkSyllabus(offC);
    const qC = (difficulty, marks, text) => mkQuestion({ off: offC, sv: svC, unit: unitC, difficulty, marks, text: `${text} ${tag}`, co: coC });
    for (let i = 0; i < 4; i++) await qC('easy', 2, `concurrency easy question ${i}`);
    const M = await qC('medium', 4, 'concurrency medium question M');
    const mkE = async (type, max, bp) => {
      const e = await api('POST', '/examinations', { course_offering_id: offC, exam_type: type, maximum_marks: max, duration_minutes: 30 }, coe);
      const b = bp ? await api('POST', '/examinations/blueprints', { examination_id: e.data.id, total_marks: max, easy_count: 0, medium_count: 0, hard_count: 0, ...bp }, coe) : null;
      return { id: e.data.id, bp: b?.data };
    };
    const EA = await mkE('mid_term', 2, { easy_count: 1 }); const EB = await mkE('supplementary', 2, { easy_count: 1 });
    const EC = await mkE('end_term', 2); const ED = await mkE('quiz', 4, { medium_count: 1 }); const EE = await mkE('makeup', 4, { medium_count: 1 });
    const extra = [];
    const client = async () => { const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); extra.push(c); return c; };
    const lockWaiters = async () => (await one(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).n;
    const waitForLockWaiters = async (n, ms = 5000) => {
      for (const t0 = Date.now(); Date.now() - t0 < ms;) { if ((await lockWaiters()) >= n) return true; await new Promise((res) => setTimeout(res, 50)); }
      return false;
    };
    const sorted = (...xs) => xs.map((x) => x.status).sort().join(',');
    try {
      // Same examination generated twice at the same moment: one paper, version 1; the other request is told why.
      const [a1, a2] = await Promise.all([api('POST', `/examinations/${EA.id}/generate`, { blueprint_id: EA.bp.id }, coe), api('POST', `/examinations/${EA.id}/generate`, { blueprint_id: EA.bp.id }, coe)]);
      const loser = [a1, a2].find((x) => x.status === 409);
      const eaPapers = await rows('SELECT id, paper_version FROM exam_papers WHERE examination_id = $1', [EA.id]);
      const P1 = eaPapers[0]?.id;
      const held = await one('SELECT count(*)::int AS n FROM question_reservations WHERE examination_id = $1 AND released_at IS NULL', [EA.id]);
      check('Same examination generated twice concurrently -> one paper (v1), the other 409 naming it', sorted(a1, a2) === '201,409' && /is GENERATED/.test((loser?.data.reasons || []).join(' '))
        && eaPapers.length === 1 && eaPapers[0].paper_version === 1 && held.n === 1, `${sorted(a1, a2)} ${JSON.stringify(loser?.data)} ${JSON.stringify(eaPapers)} ${JSON.stringify(held)}`);
      const cols = 'subject_id, course_offering_id, title, examination_id, paper_status, paper_version';
      let f = await dbFails(`INSERT INTO exam_papers (${cols}) VALUES ($1,$2,'dup',$3,'DRAFT',1)`, [F.subject, offC, EA.id], /uq_exam_papers_examination_version/);
      check('A second paper with the same version of an examination -> refused (DB unique index)', f.failed, f.message);
      f = await dbFails(`INSERT INTO exam_papers (${cols}) VALUES ($1,$2,'second live',$3,'GENERATING',99)`, [F.subject, offC, EA.id], /already has a paper in progress/);
      check('A second live paper of an examination -> refused at COMMIT (DB, deferred)', f.failed, f.message);

      // Double regenerate: exactly one new revision, the parent superseded once.
      const [g1, g2] = await Promise.all([1, 2].map(() => api('POST', `/examinations/papers/${P1}/regenerate`, { reason: 'smoke: concurrent regenerate' }, coe)));
      const kids = await rows('SELECT id FROM exam_papers WHERE parent_paper_id = $1', [P1]);
      const st = await one(`SELECT (SELECT paper_status FROM exam_papers WHERE id = $1) AS parent,
          (SELECT count(*)::int FROM paper_revisions WHERE paper_id = ANY($2::uuid[]) AND change_type = 'question_regenerated') AS revs,
          (SELECT count(*)::int FROM exam_papers WHERE examination_id = $3 AND paper_status NOT IN ('REGENERATED','ARCHIVED','DRAFT')) AS live,
          (SELECT array_agg(paper_version ORDER BY paper_version) FROM exam_papers WHERE examination_id = $3) AS versions,
          (SELECT count(*)::int FROM question_reservations WHERE paper_id = $1 AND released_at IS NULL) AS parent_held`, [P1, kids.map((k) => k.id), EA.id]);
      check('Double regenerate -> one 201, one 409; parent REGENERATED once; one revision; one live paper; versions 1,2', sorted(g1, g2) === '201,409' && kids.length === 1 && st.parent === 'REGENERATED'
        && st.revs === 1 && st.live === 1 && JSON.stringify(st.versions) === '[1,2]' && st.parent_held === 0, `${sorted(g1, g2)} ${JSON.stringify([g1.data, g2.data])} ${JSON.stringify(st)}`);
      const P2 = kids[0]?.id;

      const nBefore = await one('SELECT count(*)::int AS n FROM exam_papers'); 
      r = await api('POST', `/examinations/papers/${P2}/regenerate`, { reason: 'smoke: idor attempt', blueprint_id: EB.bp.id }, coe);
      const nAfter = await one('SELECT count(*)::int AS n FROM exam_papers');
      check('Regenerate with another examination\'s blueprint -> 400, nothing written', r.status === 400 && nBefore.n === nAfter.n, `${r.status} ${JSON.stringify(r.data)}`);

      // Regeneration through CHANGES_REQUIRED ends the superseded revision's validators but keeps their decisions.
      r = await api('POST', `/examinations/papers/${P2}/validators`, { validator_ids: v.slice(0, 4) }, coe);
      const p2q = (await one('SELECT question_id FROM paper_questions WHERE paper_id = $1 ORDER BY slot_number LIMIT 1', [P2])).question_id;
      const iss = await api('POST', `/examinations/papers/${P2}/issues`, { issue_type: 'unclear', description: 'smoke: Q1 is ambiguous', question_id: p2q }, await login('validator1@portal.edu', 'Valid@12345'));
      await api('POST', `/validators/papers/${P2}/validate`, { decision: 'CHANGES_REQUIRED', comments: 'smoke: Q1 is ambiguous', checklist: {} }, await login('validator1@portal.edu', 'Valid@12345'));
      for (const i of [2, 3, 4]) r = await api('POST', `/validators/papers/${P2}/validate`, { decision: 'APPROVE', checklist }, await login(`validator${i}@portal.edu`, 'Valid@12345'));
      const cr = r.data.paper_status;
      // The flagged-question exclusion is read under the parent row lock (review fix): the COE closes the issue as
      // wont_fix while the regeneration waits on that lock, so nothing may be left out or recorded as excluded.
      const HI = await client();
      await HI.query('BEGIN'); await HI.query('SELECT id FROM exam_papers WHERE id = $1 FOR UPDATE', [P2]);
      const regenP = api('POST', `/examinations/papers/${P2}/regenerate`, { reason: 'smoke: Q1 ambiguous' }, coe);
      const waiting = await waitForLockWaiters(1);
      await HI.query(`UPDATE paper_issues SET status = 'wont_fix', resolution = 'smoke: accepted while regenerate waits', resolved_by = $2, resolved_at = now() WHERE id = $1`, [iss.data.id, F.coe]);
      await HI.query('COMMIT');
      r = await regenP;
      const P3 = r.data.paperId;
      const exRev = P3 ? await one(`SELECT new_snapshot->'excluded_question_ids' AS ex FROM paper_revisions WHERE paper_id = $1 AND change_type = 'question_regenerated'`, [P3]) : null;
      const exAud = P3 ? await one(`SELECT details::jsonb->'excluded_question_ids' AS ex FROM audit_log WHERE action = 'paper_generated' AND entity_id = $1`, [P3]) : null;
      check('Issue closed while a regenerate waits on the parent lock -> the exclusion is read under the lock (nothing excluded or recorded as excluded)',
        iss.status === 201 && waiting && r.status === 201 && JSON.stringify(exRev?.ex) === '[]' && JSON.stringify(exAud?.ex) === '[]',
        `${iss.status} ${waiting} ${r.status} ${JSON.stringify(r.data)} ${JSON.stringify([exRev, exAud])}`);
      const ended = await one(`SELECT count(*) FILTER (WHERE NOT is_active)::int AS ended, count(*)::int AS n FROM paper_validator_assignments WHERE paper_id = $1`, [P2]);
      const hist = await api('GET', `/examinations/papers/${P2}/validators`, null, coe);
      const v1t = await login('validator1@portal.edu', 'Valid@12345');
      const seen = await api('GET', `/examinations/papers/${P2}`, null, v1t);
      const queue = await api('GET', '/validators/my-validations', null, v1t);
      const q2 = (queue.data || []).find((x) => x.paper_id === P2);
      check('Regenerate through CHANGES_REQUIRED: old validators ended, decisions kept for the COE, old revision closed to them',
        cr === 'CHANGES_REQUIRED' && r.status === 201 && ended.ended === 4 && ended.n === 4 && (hist.data || []).filter((a) => a.decision).length === 4
        && seen.status === 403 && q2 && q2.can_open === false, `${cr} ${r.status} ${JSON.stringify(ended)} ${JSON.stringify(hist.data)} ${seen.status} ${JSON.stringify(q2)}`);

      // A reassignment racing a decision: both wait on the paper row; exactly one wins; four active validators remain.
      r = await api('POST', `/examinations/papers/${P3}/validators`, { validator_ids: v.slice(0, 4) }, coe);
      const H = await client();
      await H.query('BEGIN'); await H.query('SELECT id FROM exam_papers WHERE id = $1 FOR UPDATE', [P3]);
      const decP = api('POST', `/validators/papers/${P3}/validate`, { decision: 'APPROVE', checklist }, v1t);
      const reaP = api('POST', `/examinations/papers/${P3}/validators`, { validator_ids: v.slice(1, 5) }, coe);
      const queued = await waitForLockWaiters(2);
      await H.query('COMMIT');
      const [dec, rea] = await Promise.all([decP, reaP]);
      const act = await rows('SELECT validator_id, decision FROM paper_validator_assignments WHERE paper_id = $1 AND is_active', [P3]);
      const reviews = await one('SELECT count(*)::int AS n FROM paper_validation_reviews WHERE paper_id = $1 AND validator_id = $2', [P3, v[0]]);
      const ids4 = act.map((a) => a.validator_id).sort().join();
      const validateWon = dec.status === 200 && rea.status === 409 && ids4 === v.slice(0, 4).sort().join() && act.find((a) => a.validator_id === v[0])?.decision === 'APPROVE' && reviews.n === 1;
      const reassignWon = rea.status === 200 && dec.status === 403 && ids4 === v.slice(1, 5).sort().join() && act.every((a) => !a.decision) && reviews.n === 0;
      check('Assignment racing a decision (both queued on the paper row): exactly one wins, consistently', queued && act.length === 4 && (validateWon || reassignWon),
        `${queued} ${dec.status} ${JSON.stringify(dec.data)} | ${rea.status} ${JSON.stringify(rea.data)} | ${JSON.stringify(act)} ${JSON.stringify(reviews)}`);

      // Five blueprint saves at once: consecutive versions, one active, each superseding the previous.
      const saves = await Promise.all([...Array(5)].map(() => api('POST', '/examinations/blueprints', { examination_id: EC.id, easy_count: 1, total_marks: 2 }, coe)));
      const bps = await rows('SELECT id, version_number, supersedes_id, is_active FROM paper_blueprints WHERE examination_id = $1 ORDER BY version_number', [EC.id]);
      const chain = bps.every((b, i) => b.version_number === i + 1 && (i === 0 ? b.supersedes_id === null : b.supersedes_id === bps[i - 1].id));
      check('Concurrent blueprint saves -> 5 consecutive versions, one active (the newest), each superseding the previous', saves.every((x) => x.status === 201) && bps.length === 5 && chain
        && bps.filter((b) => b.is_active).map((b) => b.version_number).join() === '5', `${saves.map((x) => x.status)} ${JSON.stringify(bps)}`);
      f = await dbFails('UPDATE paper_blueprints SET is_active = TRUE WHERE id = $1', [bps[0]?.id], /uq_paper_blueprints_active_per_examination/);
      const f2 = await dbFails(`INSERT INTO paper_blueprints (name, easy_count, examination_id, version_number, is_active) VALUES ('dup', 1, $1, 3, FALSE)`, [EC.id], /uq_paper_blueprints_examination_version/);
      check('A second active version or a duplicate version number -> refused (DB unique indexes)', f.failed && f2.failed, `${f.message} | ${f2.message}`);

      // Reservation conflict mid-generation, then a successful retry (deterministic): B holds an uncommitted
      // reservation of M; the generator blocks on the unique index; C queues for the offering lock; B commits,
      // attempt 1 fails and rolls back; C (first in the queue) releases M; attempt 2 succeeds.
      const someAPaper = P3;
      const B = await client(); const C = await client();
      await B.query('BEGIN');
      await B.query('INSERT INTO question_reservations (question_id, paper_id, examination_id) VALUES ($1,$2,$3)', [M, someAPaper, EA.id]);
      const genD = api('POST', `/examinations/${ED.id}/generate`, { blueprint_id: ED.bp.id }, coe);
      const blocked = await waitForLockWaiters(1);
      const cLock = C.query('SELECT pg_advisory_lock(hashtextextended($1::text, 0))', [`generate:${offC}`]);
      const cQueued = await waitForLockWaiters(2);
      await B.query('COMMIT');
      await cLock;
      await C.query(`UPDATE question_reservations SET released_at = now(), release_reason = 'smoke' WHERE question_id = $1 AND paper_id = $2 AND released_at IS NULL`, [M, someAPaper]);
      await C.query('SELECT pg_advisory_unlock(hashtextextended($1::text, 0))', [`generate:${offC}`]);
      const gd = await genD;
      const mRes = await rows('SELECT paper_id FROM question_reservations WHERE question_id = $1 AND released_at IS NULL', [M]);
      const hasM = gd.status === 201 ? await one('SELECT count(*)::int AS n FROM paper_questions WHERE paper_id = $1 AND question_id = $2', [gd.data.paperId, M]) : { n: 0 };
      check('Reservation conflict mid-generation -> rolled back and retried; the retry succeeds with the freed question', blocked && cQueued && gd.status === 201 && gd.data.attempt === 2
        && hasM.n === 1 && mRes.length === 1 && mRes[0].paper_id === gd.data.paperId, `${blocked} ${cQueued} ${gd.status} ${JSON.stringify(gd.data)} ${JSON.stringify(mRes)}`);

      // A conflict the retry cannot fix: the question stays reserved elsewhere -> 422 with the reason; nothing left behind.
      const M2 = await qC('medium', 4, 'concurrency medium question M2');
      await B.query('BEGIN');
      await B.query('INSERT INTO question_reservations (question_id, paper_id, examination_id) VALUES ($1,$2,$3)', [M2, someAPaper, EA.id]);
      const genE = api('POST', `/examinations/${EE.id}/generate`, { blueprint_id: EE.bp.id }, coe);
      const blocked2 = await waitForLockWaiters(1);
      await B.query('COMMIT');
      const ge = await genE;
      const left = await one(`SELECT (SELECT count(*)::int FROM exam_papers WHERE examination_id = $1) AS papers,
          (SELECT count(*)::int FROM paper_questions pq JOIN exam_papers ep ON ep.id = pq.paper_id WHERE ep.examination_id = $1) AS questions,
          (SELECT count(*)::int FROM question_reservations WHERE examination_id = $1) AS reservations`, [EE.id]);
      check('Reservation conflict that persists -> 422 naming the shortage; the rolled-back attempt left no rows', blocked2 && ge.status === 422 && /MEDIUM/.test((ge.data.reasons || []).join(' '))
        && left.papers === 0 && left.questions === 0 && left.reservations === 0, `${blocked2} ${ge.status} ${JSON.stringify(ge.data)} ${JSON.stringify(left)}`);
      await db.query(`UPDATE question_reservations SET released_at = now(), release_reason = 'smoke cleanup' WHERE question_id = $1 AND released_at IS NULL`, [M2]);
    } finally {
      for (const c of extra) await c.end().catch(() => {});
    }
    r = await api('GET', '/review/audit-log/verify', null, admin);
    check('Audit hash chain still verifies after the concurrent work', r.status === 200 && r.data.valid === true, `${r.status} ${JSON.stringify(r.data)}`);
  }

  console.log('\nMulti-section paper: order, section rules, internal choice, PDF from the snapshot');
  {
    const off3 = (await one(`INSERT INTO course_offerings (subject_id, program_id, academic_session_id, semester, offering_code, status) VALUES ($1,$2,$3,8,$4,'active') RETURNING id`, [F.subject, F.programA, F.session, 'SMKS-' + tag])).id;
    const { sv: sv3, unit: unit3, co: co3 } = await mkSyllabus(off3);
    const q3 = (type, difficulty, marks, i, answerData = null) => mkQuestion({ off: off3, sv: sv3, unit: unit3, difficulty, marks, type, answerData, text: `sections ${type} ${difficulty} ${i} ${tag}`, co: co3 });
    for (let i = 0; i < 3; i++) await q3('short_answer', 'easy', 2, i);
    for (let i = 0; i < 2; i++) await q3('short_answer', 'medium', 2, i);
    for (let i = 0; i < 2; i++) await q3('long_answer', 'medium', 5, i);
    for (let i = 0; i < 3; i++) await q3('long_answer', 'hard', 5, i);
    for (let i = 0; i < 2; i++) await q3('numerical', 'medium', 4, i, { expected_value: 3 });
    const decoy = await q3('long_answer', 'hard', 4, 'decoy');
    const e3 = (await api('POST', '/examinations', { course_offering_id: off3, exam_type: 'end_term', maximum_marks: 20, duration_minutes: 90 }, coe)).data;
    const sections = (bAttempt) => [
      { name: 'Section A', question_count: 3, marks_per_question: 2, question_types: ['short_answer'], easy: 2, medium: 1, hard: 0, instructions: 'Answer all questions briefly.' },
      { name: 'Section B', question_count: 3, marks_per_question: 5, question_types: ['long_answer'], easy: 0, medium: 1, hard: 2, attempt_count: bAttempt, instructions: 'Draw diagrams where they help.' },
      { name: 'Section C', question_count: 1, marks_per_question: 4, question_types: ['numerical'], instructions: 'Show every step of the calculation.' }];
    const bpBody = (bAttempt) => ({ examination_id: e3.id, easy_count: 2, medium_count: 3, hard_count: 2, total_marks: 20, sections: sections(bAttempt) });
    r = await api('POST', '/examinations/blueprints', bpBody(3), coe);
    check('Internal choice "attempt any 3 of 3" -> refused with the reason', r.status === 400 && /must be fewer than/.test(JSON.stringify(r.data)), `${r.status} ${JSON.stringify(r.data)}`);
    const bp3 = (await api('POST', '/examinations/blueprints', bpBody(2), coe)).data;
    r = await api('POST', `/examinations/${e3.id}/generate`, { blueprint_id: bp3.id, seed: 'sections-smoke' }, coe);
    check('Multi-section paper with an internal choice generated', r.status === 201, `${r.status} ${JSON.stringify(r.data)}`);
    const S = r.data.paperId;
    if (S) {
      const pqs = await rows(`SELECT slot_number, section_name, question_id, marks_snapshot AS marks, metadata_snapshot->>'question_type' AS type, metadata_snapshot->>'difficulty' AS difficulty
                              FROM paper_questions WHERE paper_id = $1 ORDER BY slot_number`, [S]);
      check('Slots 1..7 in section order A,A,A,B,B,B,C', pqs.map((x) => x.slot_number).join() === '1,2,3,4,5,6,7' && pqs.map((x) => x.section_name.slice(-1)).join('') === 'AAABBBC', JSON.stringify(pqs));
      const ok = (sec, type, marks) => pqs.filter((x) => x.section_name === sec).every((x) => x.type === type && Number(x.marks) === marks);
      check('Each section has its type and marks; the 4-mark decoy is not used', ok('Section A', 'short_answer', 2) && ok('Section B', 'long_answer', 5) && ok('Section C', 'numerical', 4)
        && !pqs.some((x) => x.question_id === decoy), JSON.stringify(pqs));
      const split = (sec) => ['easy', 'medium', 'hard'].map((d) => pqs.filter((x) => x.section_name === sec && x.difficulty === d).length).join('/');
      check('Per-section difficulty splits met (A 2/1/0, B 0/1/2)', split('Section A') === '2/1/0' && split('Section B') === '0/1/2', `${split('Section A')} ${split('Section B')}`);
      const fc = JSON.parse((await one('SELECT format_config FROM exam_papers WHERE id = $1', [S])).format_config);
      check('format_config freezes the 3 section rules (choice and instructions kept)', fc.sections?.length === 3 && fc.sections[1].attempt === 2 && fc.sections[2].instructions === 'Show every step of the calculation.', JSON.stringify(fc));
      const view = await api('GET', `/examinations/papers/${S}`, null, coe);
      const vs = view.data.sections || []; const sum = view.data.validation?.summary || {};
      check('COE preview: 3 sections from the snapshot, all checks passed; choice counted once (20 of 25 printed)', vs.length === 3 && vs.every((x) => x.check?.passed) && vs[1].marks_counted === 10
        && JSON.stringify(vs[1].allowed_types) === '["long_answer"]' && sum.internal_choices?.[0]?.attempt_count === 2 && sum.total_marks === 20 && sum.printed_marks === 25,
        `${JSON.stringify(vs)} ${JSON.stringify(sum)}`);
      await api('POST', `/examinations/papers/${S}/validators`, { validator_ids: v.slice(0, 4) }, coe);
      const vv = await api('GET', `/examinations/papers/${S}`, null, await login('validator1@portal.edu', 'Valid@12345'));
      check('Validator preview shows the same sections', vv.status === 200 && JSON.stringify(vv.data.sections) === JSON.stringify(vs), `${vv.status}`);
      const pdfRes = await fetch(`${BASE}/examinations/papers/${S}/pdf`, { headers: { Authorization: `Bearer ${coe}` } });
      const text = pdfRes.status === 200 ? pdfText(Buffer.from(await pdfRes.arrayBuffer())) : '';
      const iA = text.indexOf('Section A (3 questions, 6 marks)'); const iB = text.indexOf('Section B (Attempt any 2 of 3 questions, 10 marks)');
      const iC = text.indexOf('Section C (1 question, 4 marks)'); const iQ4 = text.indexOf('Q4.');
      check('PDF: headings in order, the choice rule, every instruction, counted maximum marks, Q4 under section B', iA >= 0 && iA < iB && iB < iC && iQ4 > iB && iQ4 < iC
        && ['Answer all questions briefly.', 'Draw diagrams where they help.', 'Show every step of the calculation.', 'Attempt any 2 of the 3 questions in this section. Each question carries 5 marks.', 'Maximum Marks: 20']
          .every((x) => text.includes(x)), `${pdfRes.status} ${[iA, iB, iC, iQ4]} ${text.slice(0, 600)}`);
      f = await dbFails(`UPDATE exam_papers SET format_config = '{}' WHERE id = $1`, [S], /cannot change after generation|Generation metadata/);
      check('The printed section rules cannot change after generation (DB)', f.failed, f.message);
      const keyRes = await fetch(`${BASE}/examinations/papers/${S}/pdf?include_answers=1`, { headers: { Authorization: `Bearer ${coe}` } });
      const pages = keyRes.status === 200 ? pdfPages(Buffer.from(await keyRes.arrayBuffer())) : { pageCount: 0, texts: [] };
      check('Draft PDF with answer key: the DRAFT banner is on every page, answer-key page included (review fix)',
        pages.pageCount >= 2 && pages.texts.length === pages.pageCount && pages.texts.every((t) => t.includes('DRAFT')) && pages.texts.some((t) => t.includes('Answer Key')),
        `${keyRes.status} ${pages.pageCount} ${JSON.stringify(pages.texts.map((t) => t.slice(0, 60)))}`);
    }
  }

  console.log('\nBloom targets met exactly through the eligible-pool SQL (verified Bloom level wins)');
  {
    const offB = (await one(`INSERT INTO course_offerings (subject_id, program_id, academic_session_id, semester, offering_code, status) VALUES ($1,$2,$3,4,$4,'active') RETURNING id`, [F.subject, F.programA, F.session, 'SMKBL-' + tag])).id;
    const { sv: svBl, unit: unitBl, co: coBl } = await mkSyllabus(offB);
    // Three 'apply' questions and ONE whose reviewer-verified level is 'analyze' although it was submitted as 'apply'.
    const applyQs = [];
    for (let i = 0; i < 3; i++) applyQs.push(await mkQuestion({ off: offB, sv: svBl, unit: unitBl, difficulty: 'easy', marks: 2, text: `bloom apply question ${i} ${tag}`, co: coBl }));
    const analyzeQ = await mkQuestion({ off: offB, sv: svBl, unit: unitBl, difficulty: 'easy', marks: 2, text: `bloom verified analyze question ${tag}`, co: coBl, verifiedBloom: 'analyze' });
    const eB = (await api('POST', '/examinations', { course_offering_id: offB, exam_type: 'mid_term', maximum_marks: 4, duration_minutes: 30 }, coe)).data;
    const nothing = async () => one(`SELECT (SELECT count(*)::int FROM exam_papers WHERE examination_id = $1) AS papers, (SELECT count(*)::int FROM question_reservations WHERE examination_id = $1) AS reservations`, [eB.id]);
    const bpAll = (await api('POST', '/examinations/blueprints', { examination_id: eB.id, easy_count: 2, total_marks: 4, bloom_distribution: { analyze: 100 } }, coe)).data;
    r = await api('POST', `/examinations/${eB.id}/generate`, { blueprint_id: bpAll.id }, coe);
    const left = await nothing();
    check('Unmeetable Bloom target (2 analyze, 1 in the bank) -> 422 naming it, nothing written', r.status === 422 && /analyze/i.test(JSON.stringify(r.data)) && left.papers === 0 && left.reservations === 0,
      `${r.status} ${JSON.stringify(r.data)} ${JSON.stringify(left)}`);
    const bpHalf = (await api('POST', '/examinations/blueprints', { examination_id: eB.id, easy_count: 2, total_marks: 4, bloom_distribution: { apply: 50, analyze: 50 } }, coe)).data;
    r = await api('POST', `/examinations/${eB.id}/generate`, { blueprint_id: bpHalf.id }, coe);
    const picked = r.status === 201 ? (await rows('SELECT question_id FROM paper_questions WHERE paper_id = $1', [r.data.paperId])).map((x) => x.question_id) : [];
    const realized = r.status === 201 ? (await one('SELECT bloom_realized FROM exam_papers WHERE id = $1', [r.data.paperId])).bloom_realized : null;
    const bl = typeof realized === 'string' ? JSON.parse(realized) : realized;
    check('Bloom 50/50 apply/analyze -> exactly 1 apply + 1 analyze; the verified level (not the submitted one) decides',
      r.status === 201 && picked.length === 2 && picked.includes(analyzeQ) && picked.filter((q) => applyQs.includes(q)).length === 1 && bl?.apply === 1 && bl?.analyze === 1,
      `${r.status} ${JSON.stringify(r.data).slice(0, 300)} ${JSON.stringify(picked)} ${JSON.stringify(realized)}`);
  }

  console.log('\nBulk upload');
  const asg = await api('GET', '/academic/my-assignments', null, teacher);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
    { question_text: `Bulk row with an invalid CO ${tag}`, difficulty: 'easy', marks: 2, bloom_level: 'apply', co: 'CO99', topic: 'Anything', model_answer: 'long enough answer' },
    { question_text: `Bulk row missing bloom ${tag}`, difficulty: 'easy', marks: 2, co: 'CO1', topic: 'Anything', model_answer: 'long enough answer' },
  ]), 'Q');
  const fd = new FormData();
  fd.append('file', new Blob([XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })]), 'q.xlsx');
  fd.append('course_offering_id', asg.data[0].course_offering_id);
  const res = await fetch(BASE + '/bulk-upload', { method: 'POST', headers: { Authorization: `Bearer ${teacher}` }, body: fd });
  const bulk = await res.json();
  const flat = JSON.stringify(bulk.errors || []);
  check('Bulk upload: invalid rows get row-level errors (invalid CO, missing Bloom)', res.status === 200 && bulk.error_rows === 2 && /invalid CO/.test(flat) && /missing bloom_level/.test(flat), `${res.status} ${flat}`);
  const imported = await one('SELECT COUNT(*)::int AS n FROM questions WHERE bulk_batch_id = $1', [bulk.batchId]);
  check('Bulk upload imports nothing before confirmation', imported.n === 0);

  console.log('\nBulk import reaches the gate (canonical + CO mapping), diagrams via DRAFT');
  // teacher1 teaches the smoke offering from here on; CO2 and a subtopic exist in its syllabus.
  await db.query(`INSERT INTO teacher_course_assignments (teacher_id, course_offering_id, section_id, assignment_role) VALUES ($1, $2, NULL, 'instructor')`, [F.teacher, F.off]);
  const co2 = F.co2;
  const subtopic = F.subtopic;
  const bulkBase = { difficulty: 'easy', marks: 3, bloom_level: 'apply', co: 'CO1, CO2', topic: 'Trees', model_answer: 'A model answer that is long enough' };
  const bulkRows = [
    { question_type: 'mcq', question_text: `Which traversal of a binary search tree yields sorted keys ${tag}?`, option_a: 'Preorder', option_b: 'Inorder', option_c: 'Postorder', option_d: 'Level order', correct_answer: 'B', subtopic },
    { question_type: 'true_false', question_text: `Every AVL tree is a binary search tree ${tag}.`, correct_answer: 'TRUE' },
    { question_type: 'assertion_reason', question_text: `Assess the assertion about heap height ${tag}.`, assertion: 'A heap with n nodes has height O(log n)', reason: 'A heap is a complete binary tree', correct_answer: 'A' },
    { question_type: 'numerical', question_text: `How many edges does a tree with 9 vertices have ${tag}?`, expected_value: 8 },
    { question_type: 'fill_blank', question_text: `A queue follows the ___ discipline ${tag}.`, answers: 'FIFO' },
    { question_type: 'programming', question_text: `Write a function that reverses a singly linked list in place ${tag}.`, language: 'Python' },
    { question_type: 'case_study', question_text: `Recommend an index structure for the case described ${tag}.`, case_text: 'A library stores two million records and needs range queries daily.' },
    { question_type: 'short_answer', question_text: `Define the balance factor of a node ${tag}.` },
    { question_type: 'long_answer', question_text: `Compare B-trees and red-black trees for disk storage ${tag}.` },
    { question_type: 'derivation', question_text: `Derive the minimum number of nodes in an AVL tree of height h ${tag}.` },
    { question_type: 'proof', question_text: `Prove that a binary tree with n leaves has n minus one internal nodes of degree two ${tag}.` },
    { question_type: 'descriptive', question_text: `Describe how deletion works in a splay tree ${tag}.` },
    { question_type: 'diagram', question_text: `Label the root, internal nodes and leaves in the attached tree diagram ${tag}.` },
  ].map((x) => ({ ...bulkBase, ...x }));
  const wbB = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wbB, XLSX.utils.json_to_sheet(bulkRows), 'Q');
  const fdB = new FormData();
  fdB.append('file', new Blob([XLSX.write(wbB, { type: 'buffer', bookType: 'xlsx' })]), 'types.xlsx');
  fdB.append('course_offering_id', F.off);
  const upB = await (await fetch(BASE + '/bulk-upload', { method: 'POST', headers: { Authorization: `Bearer ${teacher}` }, body: fdB })).json();
  check('Bulk upload: one valid row of each of the 13 types', upB.valid_rows === 13 && upB.error_rows === 0, JSON.stringify(upB.errors || upB));
  r = await api('POST', `/bulk-upload/${upB.batchId}/confirm`, {}, teacher);
  check('Bulk confirm: 12 submitted, the diagram row saved as a DRAFT', r.status === 200 && r.data.submitted === 12 && r.data.drafted === 1, `${r.status} ${JSON.stringify(r.data)}`);
  const imported2 = await rows(`
    SELECT q.id, q.question_type, q.question_status, q.canonical_question_id, q.subtopic, q.correct_answer, q.submitted_cos,
           (SELECT count(*)::int FROM question_versions v JOIN canonical_questions cq ON cq.current_version_id = v.id WHERE cq.id = q.canonical_question_id AND v.is_current) AS current_versions,
           (SELECT count(*)::int FROM question_course_outcomes x WHERE x.canonical_question_id = q.canonical_question_id AND x.source = 'bulk' AND x.verified_by IS NULL) AS bulk_cos,
           (SELECT count(*)::int FROM question_course_outcomes x WHERE x.canonical_question_id = q.canonical_question_id AND x.relationship_type = 'primary' AND x.course_outcome_id = $2) AS co1_primary,
           (SELECT errors FROM validate_question_for_active(q.id)) AS gate_errors
    FROM questions q WHERE q.bulk_batch_id = $1`, [upB.batchId, F.co1]);
  const submittedRows = imported2.filter((x) => x.question_type !== 'diagram');
  check('Every submitted bulk row has a canonical question with a current version and 2 unverified bulk CO rows (CO1 primary)',
    submittedRows.length === 12 && submittedRows.every((x) => x.question_status === 'SUBMITTED' && x.canonical_question_id && x.current_versions === 1 && x.bulk_cos === 2 && x.co1_primary === 1),
    JSON.stringify(submittedRows.map((x) => [x.question_type, x.question_status, x.current_versions, x.bulk_cos, x.co1_primary])));
  check('Bulk rows no longer fail the gate on canonical / CO / subtopic mapping',
    submittedRows.every((x) => !(x.gate_errors || []).some((e) => /Missing canonical question mapping|Missing course outcome mapping|Subtopic is not part/.test(e))),
    JSON.stringify(submittedRows.map((x) => x.gate_errors)));
  const mcqRow = submittedRows.find((x) => x.question_type === 'mcq');
  check('Bulk MCQ stores the subtopic and the answer as option text', mcqRow?.subtopic === subtopic && mcqRow?.correct_answer === 'Inorder', JSON.stringify(mcqRow));
  const diag = imported2.find((x) => x.question_type === 'diagram');
  check('Bulk diagram row: DRAFT, no canonical yet, typed COs kept', diag?.question_status === 'DRAFT' && diag.canonical_question_id === null
    && JSON.stringify(diag.submitted_cos) === JSON.stringify(['CO1', 'CO2']), JSON.stringify(diag));
  r = await attachPng(diag.id, teacher);
  check('Diagram attached to the imported DRAFT', r.status === 200 && !!r.data.id, `${r.status} ${JSON.stringify(r.data)}`);
  const attId = r.data.id;
  {
    // No clamd in this run: the upload is quarantined (fail-closed) and cannot be submitted, and a rescan keeps it there.
    const att = await one('SELECT scan_status, file_path FROM question_attachments WHERE id = $1', [attId]);
    check('Phase 3: an upload the scanner could not check is quarantined', att.scan_status === 'failed' && att.file_path.startsWith('quarantine/')
      && fs.existsSync(new URL(att.file_path, new URL('./uploads/', import.meta.url))), JSON.stringify(att));
    const sub = await api('POST', `/questions/${diag.id}/submit`, {}, teacher);
    const own = await fetch(`${BASE}/attachments/${attId}/file`, { headers: { Authorization: `Bearer ${teacher}` } });
    check('Phase 3: a question with an unscanned attachment cannot be submitted, and not even the author opens the file', sub.status === 400 && own.status === 409,
      `${sub.status} ${JSON.stringify(sub.data)} ${own.status}`);
    const sub2 = await dbFails(`UPDATE questions SET question_status = 'SUBMITTED' WHERE id = $1`, [diag.id], /virus scan/);
    check('Phase 3: the database refuses SUBMITTED while an attachment is unscanned', sub2.failed, sub2.message);
    await db.query(`UPDATE question_attachments SET last_scanned_at = now() - interval '1 minute' WHERE id = $1`, [attId]); // past the 30 s per-file throttle
    const res = await api('POST', `/attachments/${attId}/rescan`, null, teacher);
    check('Phase 3: rescan with the scanner still down keeps the file quarantined', res.status === 200 && res.data.scan_status === 'failed' && /still unavailable/.test(res.data.warning || ''),
      `${res.status} ${JSON.stringify(res.data)}`);
    const again = await api('POST', `/attachments/${attId}/rescan`, null, teacher);
    check('Phase 3: rescans are throttled per file', again.status === 429, `${again.status}`);
    const cleanInQ = await dbFails(`UPDATE question_attachments SET scan_status = 'clean' WHERE id = $1`, [attId], /scan_storage_check/);
    check('Phase 3: a clean file cannot stay in quarantine (DB)', cleanInQ.failed, cleanInQ.message);
    const infectedStored = await dbFails(`UPDATE question_attachments SET scan_status = 'infected' WHERE id = $1`, [attId], /scan_storage_check/);
    check('Phase 3: an infected file is never stored (DB)', infectedStored.failed, infectedStored.message);
    if (process.env.SMOKE_FAKE_CLAMD_PORT) {
      // The scanner comes back (run-checks.sh points the server's CLAMD_HOST/CLAMD_PORT at this port): the real
      // rescan path moves the file out of quarantine and marks it clean under the 040 storage CHECK, on Postgres.
      const clamd = await startFakeClamd({ port: Number(process.env.SMOKE_FAKE_CLAMD_PORT) });
      try {
        await db.query(`UPDATE question_attachments SET last_scanned_at = now() - interval '1 minute' WHERE id = $1`, [attId]);
        const clean = await api('POST', `/attachments/${attId}/rescan`, null, teacher);
        const row = await one('SELECT scan_status, file_path, scan_attempts FROM question_attachments WHERE id = $1', [attId]);
        const up = new URL('./uploads/', import.meta.url);
        check('Phase 3: a rescan with the scanner back marks the file clean and moves it out of quarantine (real path, 040 CHECK)',
          clean.status === 200 && clean.data.scan_status === 'clean' && row.scan_status === 'clean' && !row.file_path.startsWith('quarantine/')
            && fs.existsSync(new URL(row.file_path, up)) && !fs.existsSync(new URL(att.file_path, up)) && clamd.state.received.length === 1,
          `${clean.status} ${JSON.stringify(clean.data)} ${JSON.stringify(row)} scans=${clamd.state.received.length}`);
        const own2 = await fetch(`${BASE}/attachments/${attId}/file`, { headers: { Authorization: `Bearer ${teacher}` } });
        check('Phase 3: ... and the author can now open it', own2.status === 200, `${own2.status}`);
      } finally { await clamd.close(); }
    } else {
      // No fake scanner port configured (smoke run by hand): stand in for the scanner on the throwaway DB.
      const target = att.file_path.replace(/^quarantine\//, '');
      fs.renameSync(new URL(att.file_path, new URL('./uploads/', import.meta.url)), new URL(target, new URL('./uploads/', import.meta.url)));
      await db.query(`UPDATE question_attachments SET scan_status = 'clean', file_path = $2 WHERE id = $1`, [attId, target]);
    }
  }
  r = await api('POST', `/questions/${diag.id}/submit`, {}, teacher);
  const diagRow = await one(`SELECT question_status, canonical_question_id,
      (SELECT count(*)::int FROM question_course_outcomes x WHERE x.canonical_question_id = q.canonical_question_id AND x.source = 'bulk') AS cos
    FROM questions q WHERE id = $1`, [diag.id]);
  check('Diagram draft submitted: canonical + CO mapping from the spreadsheet codes', r.status === 200 && diagRow.question_status === 'SUBMITTED' && !!diagRow.canonical_question_id && diagRow.cos === 2,
    `${r.status} ${JSON.stringify(r.data)} ${JSON.stringify(diagRow)}`);
  r = await attachPng(diag.id, teacher);
  const delAtt = await fetch(`${BASE}/attachments/${attId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${teacher}` } });
  check('Attachments cannot be added or removed after submission (API)', r.status === 409 && delAtt.status === 409, `${r.status} ${delAtt.status}`);
  f = await dbFails('DELETE FROM question_attachments WHERE id = $1', [attId], /DRAFT or CHANGES_REQUESTED/);
  check('Attachments cannot be removed after submission (DB)', f.failed, f.message);
  f = await dbFails(`INSERT INTO question_course_outcomes (canonical_question_id, course_outcome_id, source) VALUES ($1, $2, 'other')`, [diagRow.canonical_question_id, co2], /source_check/);
  check("CO mapping source is still constrained ('bulk' allowed, others not)", f.failed, f.message);

  console.log('\nRevise and resubmit, decided by the review batch');
  const topicId = (await one(`SELECT id FROM syllabus_topics WHERE syllabus_unit_id = $1 AND title = 'Trees'`, [F.unit1])).id;
  const raId = (await one('SELECT id FROM reviewer_assignments WHERE reviewer_id = $1 AND course_offering_id = $2', [F.reviewer, F.off])).id;
  r = await api('POST', '/questions/draft', { question_type: 'descriptive', question_text: `Explain how a red-black tree restores its colour invariants after insertion ${tag}`,
    difficulty: 'easy', marks: 5, bloom_level: 'apply', topic: 'Trees', model_answer: 'Recolouring and rotations restore the invariants', course_offering_id: F.off }, teacher);
  const rq = r.data.id;
  check('Teacher drafts a question for the offering', r.status === 200 && !!rq, `${r.status} ${JSON.stringify(r.data)}`);
  r = await api('POST', `/questions/${rq}/transition`, { target_status: 'SUBMITTED' }, teacher);
  check('/transition cannot submit (the /submit pipeline is the only way)', r.status === 400, `${r.status} ${JSON.stringify(r.data)}`);
  r = await api('POST', `/questions/${rq}/submit`, { primary_course_outcome_id: F.co1 }, teacher);
  const s1 = await one(`SELECT question_status, canonical_question_id,
      (SELECT count(*)::int FROM question_versions v WHERE v.canonical_question_id = q.canonical_question_id) AS versions,
      (SELECT count(*)::int FROM question_course_outcomes x WHERE x.canonical_question_id = q.canonical_question_id) AS cos
    FROM questions q WHERE id = $1`, [rq]);
  check('Submit -> SUBMITTED with a canonical question, version 1 and the CO mapping', r.status === 200 && s1.question_status === 'SUBMITTED' && s1.versions === 1 && s1.cos === 1,
    `${r.status} ${JSON.stringify(r.data)} ${JSON.stringify(s1)}`);
  r = await api('POST', '/review/batches', { course_offering_id: F.off, title: `Round 1 ${tag}`, question_ids: [rq] }, hod);
  const batch1 = r.data.id;
  check('Creating a review batch sends the question to review', r.status === 200 && r.data.sent_to_review === 1
    && (await one('SELECT question_status FROM questions WHERE id = $1', [rq])).question_status === 'UNDER_REVIEW', `${r.status} ${JSON.stringify(r.data)}`);
  r = await api('POST', `/questions/${rq}/transition`, { target_status: 'APPROVED' }, reviewer);
  check('Approval without a reviewer on the batch / without verdicts -> DENIED', [403, 409].includes(r.status) && /review batch|verdict/i.test(r.data.error || ''), `${r.status} ${JSON.stringify(r.data)}`);
  f = await dbFails(`UPDATE questions SET status = 'needs_teacher_fix' WHERE id = $1`, [rq], /Review decision required/);
  check('Legacy status bridge cannot decide a review -> DENIED (DB)', f.failed, f.message);
  r = await api('POST', `/review/batches/${batch1}/close`, {}, hod);
  check('A batch with an undecided round cannot be closed (its question would be stuck UNDER_REVIEW)', r.status === 409
    && (r.data.question_ids || []).includes(rq), `${r.status} ${JSON.stringify(r.data)}`);
  r = await api('POST', `/review/batches/${batch1}/assign`, { reviewer_assignment_ids: [raId] }, hod);
  check('HOD assigns the reviewer to the batch', r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
  r = await api('POST', `/review/batches/${batch1}/questions/${rq}/verdict`, { decision: 'request_revision', comment: 'Say which rotation fixes each case' }, reviewer);
  check('Reviewer records a request-revision verdict', r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
  r = await api('POST', `/review/batches/${batch1}/complete`, { reviewer_summary: 'One question needs work' }, reviewer);
  check('Reviewer completes the batch', r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
  r = await api('POST', `/questions/${rq}/transition`, { target_status: 'CHANGES_REQUESTED', reason: 'Say which rotation fixes each case' }, reviewer);
  const cr = await one(`SELECT q.question_status, q.change_request_reason, rbi.outcome FROM questions q JOIN review_batch_items rbi ON rbi.question_id = q.id
    WHERE q.id = $1 AND rbi.review_batch_id = $2`, [rq, batch1]);
  check('Changes requested from the batch decision; reason stored on the question and the round', r.status === 200 && cr.question_status === 'CHANGES_REQUESTED'
    && cr.change_request_reason === 'Say which rotation fixes each case' && cr.outcome === 'CHANGES_REQUESTED', `${r.status} ${JSON.stringify(r.data)} ${JSON.stringify(cr)}`);
  r = await api('POST', `/questions/${rq}/transition`, { target_status: 'REJECTED', reason: 'reject it after all' }, reviewer);
  check('Nobody rejects alone from CHANGES_REQUESTED (API)', r.status === 400 && /Invalid transition/.test(r.data.error || ''), `${r.status} ${JSON.stringify(r.data)}`);
  f = await dbFails(`UPDATE questions SET question_status = 'REJECTED', rejection_reason = 'reject it after all' WHERE id = $1`, [rq], /CHANGES_REQUESTED → REJECTED/);
  check('Nobody rejects alone from CHANGES_REQUESTED (DB)', f.failed, f.message);
  r = await api('GET', '/question-bank/lifecycle?status=CHANGES_REQUESTED', null, teacher);
  check('Author sees the reviewer\'s reason', (r.data.questions || []).some((x) => x.id === rq && x.change_request_reason === 'Say which rotation fixes each case'), JSON.stringify(r.data).slice(0, 300));
  const revisedText = `Explain how a red-black tree restores its colour invariants after insertion, naming the rotation for each case ${tag}`;
  r = await api('POST', '/questions/draft', { id: rq, question_type: 'descriptive', question_text: revisedText, difficulty: 'easy', marks: 6, bloom_level: 'apply',
    topic: 'Trees', model_answer: 'Recolouring and rotations restore the invariants' }, teacher);
  const ed = await one('SELECT question_status, is_draft, status FROM questions WHERE id = $1', [rq]);
  check('Editing keeps CHANGES_REQUESTED (no state change)', r.status === 200 && ed.question_status === 'CHANGES_REQUESTED' && ed.is_draft === false && ed.status === 'needs_teacher_fix',
    `${r.status} ${JSON.stringify(r.data)} ${JSON.stringify(ed)}`);
  r = await api('POST', `/questions/${rq}/submit`, {}, teacher);
  const s2 = await one(`SELECT q.question_status, q.canonical_question_id, cq.current_version_id,
      (SELECT count(*)::int FROM question_versions v WHERE v.canonical_question_id = q.canonical_question_id) AS versions,
      (SELECT id FROM question_versions v WHERE v.canonical_question_id = q.canonical_question_id AND v.is_current AND v.version_number = 2 AND v.question_text = $2) AS v2,
      (SELECT count(*)::int FROM question_versions v WHERE v.canonical_question_id = q.canonical_question_id AND v.is_current) AS current_versions,
      (SELECT count(*)::int FROM question_course_outcomes x WHERE x.canonical_question_id = q.canonical_question_id) AS cos
    FROM questions q JOIN canonical_questions cq ON cq.id = q.canonical_question_id WHERE q.id = $1`, [rq, revisedText]);
  check('Resubmit -> RESUBMITTED as version 2 of the SAME canonical question, CO mapping kept',
    r.status === 200 && s2.question_status === 'RESUBMITTED' && s2.canonical_question_id === s1.canonical_question_id && s2.versions === 2
    && s2.current_versions === 1 && s2.v2 && s2.current_version_id === s2.v2 && s2.cos === 1, `${r.status} ${JSON.stringify(r.data)} ${JSON.stringify(s2)}`);
  r = await api('POST', '/questions/draft', { id: rq, question_type: 'descriptive', question_text: `${revisedText} again`, difficulty: 'easy', marks: 6, topic: 'Trees' }, teacher);
  check('A RESUBMITTED question cannot be edited', r.status === 400, `${r.status}`);
  r = await api('GET', `/questions/${rq}/lifecycle`, null, teacher);
  const events = new Set((r.data.audit_trail || []).map((e) => e.event));
  check('Lifecycle history shows create, edit, submit, resubmit and transitions', ['draft_created', 'draft_updated', 'submitted', 'resubmitted', 'transition'].every((e) => events.has(e)),
    JSON.stringify([...events]));

  r = await api('POST', '/review/batches', { course_offering_id: F.off, title: `Round 2 ${tag}`, question_ids: [rq] }, hod);
  const batch2 = r.data.id;
  check('Resubmission goes back to review in a new round', r.status === 200 && r.data.sent_to_review === 1, `${r.status} ${JSON.stringify(r.data)}`);
  await api('POST', `/review/batches/${batch2}/assign`, { reviewer_assignment_ids: [raId] }, hod);
  r = await api('POST', `/review/batches/${batch2}/questions/${rq}/verdict`, { decision: 'accept', verified_difficulty: 'easy', verified_bloom_level: 'apply',
    verified_course_outcome_id: F.co1, verified_syllabus_unit_id: F.unit1, verified_syllabus_topic_id: topicId, answer_approved: true }, reviewer);
  check('Reviewer accepts with the full classification', r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
  r = await api('POST', `/questions/${rq}/transition`, { target_status: 'APPROVED' }, reviewer);
  check('Approval waits for the batch to be completed', r.status === 409 && /Waiting/.test(r.data.error || ''), `${r.status} ${JSON.stringify(r.data)}`);
  await api('POST', `/review/batches/${batch2}/complete`, { reviewer_summary: 'Fixed' }, reviewer);
  r = await api('POST', `/questions/${rq}/transition`, { target_status: 'APPROVED' }, reviewer);
  const ap = await one(`SELECT q.question_status, q.approved_by, rbi.outcome, rbi.decided_by FROM questions q JOIN review_batch_items rbi ON rbi.question_id = q.id
    WHERE q.id = $1 AND rbi.review_batch_id = $2`, [rq, batch2]);
  check('Approval applied from the batch, recorded on the round', r.status === 200 && ap.question_status === 'APPROVED' && ap.approved_by === F.reviewer
    && ap.outcome === 'APPROVED' && ap.decided_by === F.reviewer, `${r.status} ${JSON.stringify(r.data)} ${JSON.stringify(ap)}`);
  r = await api('POST', `/review/batches/${batch2}/questions/${rq}/verdict`, { decision: 'request_revision', comment: 'late change' }, reviewer);
  check('No verdicts after the decision', r.status === 409, `${r.status}`);
  r = await api('POST', `/review/batches/${batch2}/reassign`, { old_reviewer_assignment_id: raId, new_reviewer_assignment_id: raId, reason: 'swap' }, hod);
  check('A reviewer who completed cannot be reassigned away (their verdict counts)', r.status === 409, `${r.status} ${JSON.stringify(r.data)}`);
  r = await api('POST', `/review/batches/${batch2}/close`, {}, hod);
  const r1 = await api('POST', `/review/batches/${batch1}/close`, {}, hod);
  check('Batches close once every round is decided', r.status === 200 && r1.status === 200, `${r.status} ${JSON.stringify(r.data)} ${r1.status} ${JSON.stringify(r1.data)}`);
  r = await api('POST', '/review/batches', { course_offering_id: F.off, title: `Round 3 ${tag}`, question_ids: [rq] }, hod);
  check('An approved question cannot be put back into a batch', r.status === 400, `${r.status}`);
  r = await api('POST', `/questions/${rq}/transition`, { target_status: 'ACTIVE' }, reviewer);
  check('Revised question passes the quality gate (canonical + CO kept across the revision)', r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
  f = await dbFails(`UPDATE questions SET question_status = 'RESUBMITTED' WHERE id = $1`, [wd], /Invalid question state/);
  check('REJECTED is terminal (DB)', f.failed, f.message);

  console.log('\nAccounts and authentication (phase 3)');
  {
    const adminId = await userId('admin@portal.edu');
    const email = `val-${tag}@portal.edu`;
    r = await api('POST', '/academic/users', { email: email.toUpperCase(), full_name: 'Smoke Validator', employee_id: `EMP-SMK-${tag}`, role: 'validator', campus_id: CAMPUS_A }, admin);
    const nu = r.data || {};
    check('Admin provisions a validator: 201, invitation sent, no password or setup code in the response',
      r.status === 201 && nu.email === email && nu.invite_delivered === true && !/password|dev_setup_token/.test(JSON.stringify(nu)), `${r.status} ${JSON.stringify(nu)}`);
    const sc = await rows('SELECT role, campus_id, department_id, is_active, granted_by FROM user_scopes WHERE user_id = $1', [nu.id]);
    const invite = await one(`SELECT id FROM otp_codes WHERE user_id = $1 AND purpose = 'account_setup' AND used = FALSE`, [nu.id]);
    check('The validator\'s campus scope (granted_by the admin) and a one-time setup code exist',
      sc.length === 1 && sc[0].role === 'validator' && sc[0].campus_id === CAMPUS_A && sc[0].is_active && sc[0].granted_by === adminId && !!invite, JSON.stringify({ sc, invite: !!invite }));
    r = await api('POST', '/auth/login/password', { email, password: 'anything-Abc1' });
    check('An invited account cannot sign in before setting its password', r.status === 401, `${r.status}`);
    const tok = crypto.randomBytes(32).toString('hex');
    await db.query('UPDATE otp_codes SET code_hash = $1 WHERE id = $2', [hashCode(tok), invite.id]);
    r = await api('POST', '/auth/password-reset/confirm', { token: tok, new_password: 'Valid@Smoke123' });
    check('The setup code sets the password once', r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
    r = await api('POST', '/auth/password-reset/confirm', { token: tok, new_password: 'Valid@Smoke456' });
    check('A setup code works only once', r.status === 400, `${r.status}`);
    const vt = await login(email, 'Valid@Smoke123');
    const me = await api('GET', '/auth/me', null, vt);
    check('The new validator signs in (password + emailed code)', me.status === 200 && me.data.role === 'validator' && me.data.must_change_password === false && me.data.employee_id === `EMP-SMK-${tag}`,
      JSON.stringify(me.data));
    r = await api('POST', `/academic/users/${nu.id}/deactivate`, { reason: 'smoke: offboarding check' }, admin);
    const sc2 = await rows('SELECT is_active, revoked_by, revoke_reason FROM user_scopes WHERE user_id = $1', [nu.id]);
    const me2 = await api('GET', '/auth/me', null, vt);
    check('Deactivation revokes every scope (who and why) and ends the session at once',
      r.status === 200 && sc2.every((x) => !x.is_active && x.revoked_by === adminId && x.revoke_reason === 'account_deactivated') && me2.status === 401,
      `${r.status} ${JSON.stringify(sc2)} ${me2.status}`);
    const after = await api('POST', '/auth/login/password', { email, password: 'Valid@Smoke123' });
    const wrong = await api('POST', '/auth/login/password', { email, password: 'Wrong@Smoke123' });
    check('An inactive account is told so only after the correct password', after.status === 403 && /inactive/.test(after.data.error || '') && wrong.status === 401,
      `${after.status} ${wrong.status}`);
    r = await api('POST', '/academic/users', { email: `coe-${tag}@portal.edu`, full_name: 'Smoke COE', employee_id: `EMP-SMK2-${tag}`, role: 'coe' }, hod);
    check('An HOD cannot create a COE account', r.status === 403, `${r.status}`);

    // Reactivation and role change on Postgres (uq_user_scopes_active partial index, trg_guard_user_scope,
    // trg_users_session_epoch / trg_users_access_revoked, the users CHECKs).
    r = await api('POST', `/academic/users/${nu.id}/reactivate`, null, admin);
    check('Reactivating a validator restores no scope by itself (COE/validator scopes are explicit grants)', r.status === 200 && r.data.restored_scopes === 0 && r.data.needs_scope_grant === true,
      `${r.status} ${JSON.stringify(r.data)}`);
    r = await api('POST', '/admin/scopes', { user_id: nu.id, role: 'validator', campus_id: CAMPUS_A }, admin);
    const vsc = await rows('SELECT is_active, granted_by, revoke_reason FROM user_scopes WHERE user_id = $1 ORDER BY created_at', [nu.id]);
    check('The admin re-grants a scope identical to the revoked one: one active row with granted_by, the revoked row kept as history',
      r.status === 200 && vsc.filter((x) => x.is_active).length === 1 && vsc.find((x) => x.is_active).granted_by === adminId
        && vsc.some((x) => !x.is_active && x.revoke_reason === 'account_deactivated'), `${r.status} ${JSON.stringify(vsc)}`);

    const remail = `rvw-${tag}@portal.edu`;
    r = await api('POST', '/academic/users', { email: remail, full_name: 'Smoke Reviewer 2', employee_id: `EMP-SMK5-${tag}`, role: 'reviewer', campus_id: CAMPUS_A, department_id: F.dept }, admin);
    const rvw = r.data || {};
    check('Admin provisions a reviewer with a department scope', r.status === 201 && (rvw.scopes || []).length === 1, `${r.status} ${JSON.stringify(rvw)}`);
    await api('POST', `/academic/users/${rvw.id}/deactivate`, { reason: 'smoke: reactivation check' }, admin);
    r = await api('POST', `/academic/users/${rvw.id}/reactivate`, null, admin);
    const rsc = await rows('SELECT role, is_active, granted_by, revoke_reason FROM user_scopes WHERE user_id = $1 ORDER BY created_at', [rvw.id]);
    check('Reactivating a reviewer re-grants its department scope (granted_by set) next to the revoked history row',
      r.status === 200 && r.data.restored_scopes === 1 && rsc.filter((x) => x.is_active).length === 1 && rsc.find((x) => x.is_active).granted_by === adminId
        && rsc.filter((x) => !x.is_active && x.revoke_reason === 'account_deactivated').length === 1, `${r.status} ${JSON.stringify(r.data)} ${JSON.stringify(rsc)}`);
    const before = await one('SELECT token_version FROM users WHERE id = $1', [rvw.id]);
    r = await api('POST', `/academic/users/${rvw.id}/role`, { role: 'teacher', campus_id: CAMPUS_A, department_id: F.dept, reason: 'smoke: moves to teaching duties' }, admin);
    const afterRole = await one(`SELECT role, token_version,
        (SELECT COUNT(*)::int FROM user_scopes s WHERE s.user_id = u.id AND s.is_active) AS live,
        (SELECT COUNT(*)::int FROM user_scopes s WHERE s.user_id = u.id AND s.role = 'reviewer' AND NOT s.is_active AND s.revoke_reason = 'role_changed' AND s.revoked_by = $2) AS revoked
      FROM users u WHERE id = $1`, [rvw.id, adminId]);
    check('Role change reviewer -> teacher: old scopes revoked (role_changed, by the admin), sessions end, no active scope of the old role',
      r.status === 200 && afterRole.role === 'teacher' && afterRole.token_version > before.token_version && afterRole.live === 0 && afterRole.revoked === 1,
      `${r.status} ${JSON.stringify(r.data)} ${JSON.stringify(afterRole)}`);
    const f4 = await dbFails(`INSERT INTO user_scopes (user_id, role, campus_id, department_id) VALUES ($1, 'reviewer', $2, $3)`, [rvw.id, CAMPUS_A, F.dept], /role/);
    check('DB backstop: a scope of the old role cannot be granted after the role change', f4.failed, f4.message);

    // Review fixes on Postgres: a program-limited HOD scope is refused (route and CHECK); a teacher scope cannot be
    // revoked by the admin (it follows the HOD's assignment).
    const hodId = await userId('hod@portal.edu');
    const prog = (await one('SELECT program_id FROM course_offerings WHERE id = $1', [F.off])).program_id;
    r = await api('POST', '/admin/scopes', { user_id: hodId, role: 'hod', campus_id: CAMPUS_A, department_id: F.dept, program_id: prog }, admin);
    const f5 = await dbFails(`INSERT INTO user_scopes (user_id, role, campus_id, department_id, program_id) VALUES ($1, 'hod', $2, $3, $4)`, [hodId, CAMPUS_A, F.dept, prog], /hod_department_level/);
    check('A program-limited HOD scope is refused by the route (400) and the database (CHECK)', r.status === 400 && f5.failed, `${r.status} ${f5.message}`);
    const tScope = await one(`SELECT id FROM user_scopes WHERE user_id = $1 AND role = 'teacher' AND is_active LIMIT 1`, [F.teacher]);
    if (tScope) {
      r = await api('DELETE', `/admin/scopes/${tScope.id}`, null, admin);
      const still = await one('SELECT is_active FROM user_scopes WHERE id = $1', [tScope.id]);
      check('The admin cannot revoke a teacher scope (409, unchanged): it follows the HOD\'s assignment', r.status === 409 && still.is_active === true, `${r.status} ${JSON.stringify(still)}`);
    }

    // Database backstop: deactivating straight in SQL still ends sessions and revokes scopes.
    const rv = (await one(`INSERT INTO users (email, password_hash, role, department_id, full_name, employee_id) VALUES ($1, $2, 'reviewer', $3, 'Smoke Reviewer', $4)
      RETURNING id, token_version`, [`rev-${tag}@portal.edu`, await hashPassword('Review@Smoke1'), F.dept, `EMP-SMK3-${tag}`]));
    await db.query(`INSERT INTO user_scopes (user_id, role, campus_id, department_id) VALUES ($1, 'reviewer', $2, $3)`, [rv.id, CAMPUS_A, F.dept]);
    await db.query('UPDATE users SET is_active = FALSE WHERE id = $1', [rv.id]);
    const rvAfter = await one(`SELECT token_version, (SELECT COUNT(*)::int FROM user_scopes s WHERE s.user_id = u.id AND s.is_active) AS live FROM users u WHERE id = $1`, [rv.id]);
    check('DB backstop: a direct deactivation bumps token_version and revokes scopes', rvAfter.token_version === rv.token_version + 1 && rvAfter.live === 0, JSON.stringify(rvAfter));
    const f3 = await dbFails(`INSERT INTO user_scopes (user_id, role, campus_id) VALUES ($1, 'reviewer', $2)`, [rv.id, CAMPUS_A], /active user/);
    check('DB backstop: no scope can be granted to an inactive account', f3.failed, f3.message);

    // A locked account with the CORRECT password gets the same answer as a wrong password.
    await db.query(`INSERT INTO users (email, password_hash, role, department_id, full_name, employee_id, locked_until) VALUES ($1, $2, 'teacher', $3, 'Smoke Locked', $4, now() + interval '10 minutes')`,
      [`locked-${tag}@portal.edu`, await hashPassword('Teach@Smoke1'), F.dept, `EMP-SMK4-${tag}`]);
    const lk = await api('POST', '/auth/login/password', { email: `locked-${tag}@portal.edu`, password: 'Teach@Smoke1' });
    const unk = await api('POST', '/auth/login/password', { email: `nobody-${tag}@portal.edu`, password: 'Teach@Smoke1' });
    check('A locked account with the correct password answers exactly like an unknown account', lk.status === 401 && JSON.stringify(lk.data) === JSON.stringify(unk.data),
      `${lk.status} ${JSON.stringify(lk.data)} ${JSON.stringify(unk.data)}`);
  }

  console.log('\nInfrastructure (phase 3)');
  {
    const ready = await fetch(`${BASE}/health/ready`);
    const body = await ready.json();
    check('/api/health/ready is mounted and reports the database and the active protections', ready.status === 200 && body.checks?.database === 'ok' && !!body.protections?.upload_scanning,
      `${ready.status} ${JSON.stringify(body)}`);
    const live = await fetch(`${BASE}/health/live`);
    check('/api/health/live answers', live.status === 200);
    const gate = await one(`SELECT v.errors FROM validate_question_for_active($1) v`, [F.eligible[0]]);
    await db.query('BEGIN');
    let gateErr;
    try {
      await db.query("SELECT set_config('app.question_content_override', 'on', true)");
      await db.query(`INSERT INTO question_attachments (question_id, uploaded_by, file_path, file_name, file_type, file_size_bytes, file_hash, scan_status)
        VALUES ($1, $2, 'quarantine/x.png', 'x.png', 'image/png', 1, 'h', 'failed')`, [F.eligible[0], F.teacher]);
      gateErr = await one(`SELECT v.errors FROM validate_question_for_active($1, 'APPROVED') v`, [F.eligible[0]]);
    } finally { await db.query('ROLLBACK'); }
    check('Quality gate: an attachment that has not passed the virus scan blocks ACTIVE',
      !(gate.errors || []).includes('Attachment has not passed the virus scan') && (gateErr.errors || []).includes('Attachment has not passed the virus scan'), JSON.stringify(gateErr));
  }

  // ---------------- Phase 4a: every question type in output (migration 041), analytics truth, export ----------------
  {
    console.log('\nPhase 4a: question types in papers, diagrams, analytics by offering, export');
    // A second offering of the same subject and program with the SAME codes as the smoke offering (CO1, Unit 1,
    // topic Trees), so per-offering grouping is tested against equal codes in one HOD scope.
    F.off4 = (await one(`INSERT INTO course_offerings (subject_id, program_id, academic_session_id, semester, offering_code, status) VALUES ($1,$2,$3,3,$4,'active') RETURNING id`,
      [F.subject, F.programA, F.session, 'SMK4-' + tag])).id;
    const { sv: sv4, unit: unit4, co: co4 } = await mkSyllabus(F.off4);
    const pngName = `p4a-${tag}.png`;
    fs.writeFileSync(new URL(`./uploads/${pngName}`, import.meta.url), PNG);
    const pngHash = crypto.createHash('sha256').update(PNG).digest('hex');
    // APPROVED first; the answer fields and the diagram are set through the data-repair hatch (content is locked
    // once approved), then each question becomes ACTIVE through the real quality gate.
    async function mk4(type, difficulty, text, { answerData = null, cols = {}, file = null, verifiedBloom = 'apply' } = {}) {
      const id = await mkQuestion({ off: F.off4, sv: sv4, unit: unit4, difficulty, marks: 2, text: `${text} ${tag}`, status: 'APPROVED', co: co4, type, answerData, verifiedBloom });
      await db.query('BEGIN');
      try {
        await db.query("SELECT set_config('app.question_content_override', 'on', true)");
        const keys = Object.keys(cols);
        if (keys.length) await db.query(`UPDATE questions SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...keys.map((k) => cols[k])]);
        if (file) {
          await db.query(`INSERT INTO question_attachments (question_id, uploaded_by, file_path, file_name, file_type, file_size_bytes, file_hash, scan_status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,'clean')`, [id, F.teacher, file.path, file.name, file.type, file.size, file.hash]);
        }
        await db.query('COMMIT');
      } catch (e) { await db.query('ROLLBACK'); throw e; }
      const act = await dbFails(`UPDATE questions SET question_status = 'ACTIVE' WHERE id = $1`, [id]);
      return { id, activated: !act.failed, message: act.message };
    }
    const q4 = {
      mcq: await mk4('mcq', 'easy', 'Which bound does binary search achieve', { cols: { option_a: 'O(n)', option_b: 'O(log n)', option_c: 'O(1)', option_d: 'O(n^2)', correct_answer: 'O(log n)' } }),
      prog: await mk4('programming', 'easy', 'Complete the depth function', { answerData: { language: 'Python' },
        cols: { model_answer: 'def depth(n):\n    return 0 if n is None else 1 + max(depth(n.left), depth(n.right))' } }),
      cs: await mk4('case_study', 'medium', 'Which index should the library use', { answerData: { case_text: `A library stores two million records and needs range queries ${tag}.` } }),
      ar: await mk4('assertion_reason', 'medium', 'Assess the assertion about heaps', { answerData: { assertion: 'A heap has logarithmic height', reason: 'Heaps are complete trees' }, cols: { correct_answer: 'A' } }),
      diag: await mk4('diagram', 'hard', 'Label the parts of the tree in the diagram', { file: { path: pngName, name: 'tree.png', type: 'image/png', size: PNG.length, hash: pngHash } }),
      num: await mk4('numerical', 'hard', 'How many edges does a tree with nine vertices have', { answerData: { expected_value: 8 } }),
    };
    check('Phase 4a: one ACTIVE question of six types (mcq, programming, case study, A/R, diagram with PNG, numerical) passes the gate',
      Object.values(q4).every((x) => x.activated), JSON.stringify(Object.fromEntries(Object.entries(q4).map(([k, v]) => [k, v.message || 'ok']))));
    // 041 gate: a diagram whose only file is a WEBP cannot become ACTIVE.
    const webp = await mk4('diagram', 'hard', 'Label the graph in the WEBP diagram', { file: { path: `p4a-${tag}.webp`, name: 'g.webp', type: 'image/webp', size: 10, hash: 'webp' } });
    const gate = await one(`SELECT v.errors FROM validate_question_for_active($1) v`, [webp.id]);
    check('Phase 4a: a diagram with only a WEBP file is refused by the quality gate (041: PNG or JPEG)', !webp.activated && (gate.errors || []).some((e) => /PNG or JPEG/.test(e)),
      `${webp.message} ${JSON.stringify(gate)}`);
    await db.query(`UPDATE question_course_outcomes SET verified_at = now(), verified_by = $2 WHERE canonical_question_id = (SELECT canonical_question_id FROM questions WHERE id = $1)`, [q4.mcq.id, F.reviewer]);

    // Real generation: the snapshot records the diagram; the COE sees it, the PDF embeds it.
    r = await api('POST', '/examinations', { course_offering_id: F.off4, exam_type: 'quiz', maximum_marks: 12, duration_minutes: 30 }, coe);
    const exam4 = r.data;
    r = await api('POST', '/examinations/blueprints', { examination_id: exam4.id, easy_count: 2, medium_count: 2, hard_count: 2, total_marks: 12, reuse_lookback_exams: 0 }, coe);
    r = await api('POST', `/examinations/${exam4.id}/generate`, { blueprint_id: r.data.id, seed: 'p4a' }, coe);
    check('Phase 4a: paper generated from the six typed questions', r.status === 201, `${r.status} ${JSON.stringify(r.data)}`);
    const paper4 = r.data.paperId;
    if (paper4) {
      const snap = await one(`SELECT metadata_snapshot FROM paper_questions WHERE paper_id = $1 AND question_id = $2`, [paper4, q4.diag.id]);
      const att = (snap?.metadata_snapshot?.attachments || [])[0];
      check('Phase 4a: the snapshot records the diagram (id, name, type, hash) at generation (041)',
        att && att.file_name === 'tree.png' && att.file_type === 'image/png' && att.file_hash === pngHash, JSON.stringify(snap?.metadata_snapshot));
      const noAtt = await one(`SELECT metadata_snapshot->'attachments' AS a FROM paper_questions WHERE paper_id = $1 AND question_id = $2`, [paper4, q4.mcq.id]);
      check('Phase 4a: a question without files records an empty list', Array.isArray(noAtt.a) && noAtt.a.length === 0, JSON.stringify(noAtt));
      r = await api('GET', `/examinations/papers/${paper4}`, null, coe);
      const dq = (r.data.questions || []).find((x) => x.question_id === q4.diag.id);
      check('Phase 4a: COE paper view lists the diagram (available, no storage path) and the answer key inline',
        r.status === 200 && dq?.attachments?.[0]?.available === true && !('file_path' in (dq?.attachments?.[0] || {}))
        && (r.data.questions || []).find((x) => x.question_id === q4.mcq.id)?.meta?.correct_answer === 'O(log n)', JSON.stringify(dq));
      const file = await fetch(`${BASE}/examinations/papers/${paper4}/attachments/${att?.id}`, { headers: { Authorization: `Bearer ${coe}` } });
      const fileBuf = Buffer.from(await file.arrayBuffer());
      check('Phase 4a: COE opens the paper\'s diagram (image/png, not cached)', file.status === 200 && /image\/png/.test(file.headers.get('content-type')) && fileBuf.equals(PNG)
        && file.headers.get('cache-control') === 'no-store', `${file.status}`);
      const v1 = await login('validator1@portal.edu', 'Valid@12345');
      const denied = await Promise.all([v1, hod, teacher].map((t) => fetch(`${BASE}/examinations/papers/${paper4}/attachments/${att?.id}`, { headers: { Authorization: `Bearer ${t}` } }).then((x) => x.status)));
      check('Phase 4a: an unassigned validator, the HOD and the author cannot open the paper\'s diagram', denied.every((st) => st === 403), JSON.stringify(denied));
      const other = await fetch(`${BASE}/examinations/papers/${paper4}/attachments/${crypto.randomUUID()}`, { headers: { Authorization: `Bearer ${coe}` } });
      check('Phase 4a: a file that is not part of this paper -> 404', other.status === 404, `${other.status}`);
      const pdfRes = await fetch(`${BASE}/examinations/papers/${paper4}/pdf?include_answers=1&inline=1`, { headers: { Authorization: `Bearer ${coe}` } });
      const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
      const txt = pdfText(pdfBuf);
      const key = txt.slice(txt.indexOf('Answer Key'));
      check('Phase 4a: PDF inline for preview/print, diagram embedded, case before question, MCQ key "(B) O(log n)", A/R choice, code in Courier',
        pdfRes.status === 200 && /^inline;/.test(pdfRes.headers.get('content-disposition') || '') && /\/Subtype \/Image/.test(pdfBuf.toString('latin1'))
        && txt.indexOf('A library stores two million records') >= 0 && txt.indexOf('A library stores two million records') < txt.indexOf('Which index should the library use')
        && key.includes('(B) O(log n)') && key.includes('(A) Both A and R are true, and R is the correct explanation of A') && /\/BaseFont \/Courier/.test(pdfBuf.toString('latin1')),
        `${pdfRes.status} ${pdfRes.headers.get('content-disposition')} ${txt.slice(0, 300)}`);
      const pdfAudit = await one(`SELECT details FROM audit_log WHERE entity_id = $1 AND action = 'paper_pdf_downloaded' ORDER BY created_at DESC LIMIT 1`, [paper4]);
      const auditDetails = typeof pdfAudit?.details === 'string' ? JSON.parse(pdfAudit.details) : pdfAudit?.details; // audit_log.details is JSON text
      check('Phase 4a: the inline view is audited as such', auditDetails?.inline === true && auditDetails?.include_answers === true, JSON.stringify(pdfAudit));
    }

    // The review lists carry the full question: attachments of the HOD lifecycle list (json_agg on Postgres).
    r = await api('GET', '/question-bank/lifecycle?status=ACTIVE&limit=200', null, hod);
    const lq = (r.data.questions || []).find((x) => x.id === q4.diag.id);
    check('Phase 4a: HOD lifecycle list returns the full question with its clean attachments',
      r.status === 200 && lq?.attachments?.[0]?.file_type === 'image/png' && lq?.model_answer && 'answer_data' in lq, JSON.stringify(lq || r.data).slice(0, 300));

    // Draft save normal form on Postgres; a diagram question refuses a WEBP upload.
    r = await api('POST', '/questions/draft', { question_type: 'mcq', question_text: `Which structure is LIFO ${tag}?`, option_a: 'Queue', option_b: 'Stack', option_c: 'Heap', option_d: 'Tree',
      correct_answer: 'b', answer_data: { case_text: 'stale' }, difficulty: 'easy', marks: 1, course_offering_id: F.off }, teacher);
    let saved = r.data.id ? await one('SELECT correct_answer, answer_data FROM questions WHERE id = $1', [r.data.id]) : null;
    check('Phase 4a: draft save stores an MCQ letter as the option text and drops unused answer data', saved?.correct_answer === 'Stack' && saved?.answer_data === null, `${r.status} ${JSON.stringify(saved || r.data)}`);
    r = await api('POST', '/questions/draft', { question_type: 'true_false', question_text: `A heap is a complete tree ${tag}.`, correct_answer: 'true', option_a: 'stale',
      difficulty: 'easy', marks: 1, course_offering_id: F.off }, teacher);
    saved = r.data.id ? await one('SELECT correct_answer, option_a FROM questions WHERE id = $1', [r.data.id]) : null;
    check('Phase 4a: draft save upper-cases a True/False key and drops options', saved?.correct_answer === 'TRUE' && saved?.option_a === null, `${r.status} ${JSON.stringify(saved || r.data)}`);
    r = await api('POST', '/questions/draft', { question_type: 'diagram', question_text: `Label the heap in the diagram ${tag}.`, difficulty: 'easy', marks: 1, course_offering_id: F.off }, teacher);
    const diagDraft = r.data.id;
    const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.from([0x0e, 0, 0, 0, 0x30, 0x01, 0, 0x9d, 0x01, 0x2a, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0])]);
    const fdw = new FormData(); fdw.append('file', new Blob([WEBP], { type: 'image/webp' }), 'heap.webp');
    const upw = await fetch(`${BASE}/attachments/${diagDraft}`, { method: 'POST', headers: { Authorization: `Bearer ${teacher}` }, body: fdw });
    const upwBody = await upw.json().catch(() => ({}));
    const stored = await one('SELECT COUNT(*)::int AS n FROM question_attachments WHERE question_id = $1', [diagDraft]);
    check('Phase 4a: a diagram question refuses a WEBP upload with the PNG/JPEG reason; nothing stored', upw.status === 400 && /PNG or JPEG/.test(upwBody.error || '') && stored.n === 0,
      `${upw.status} ${JSON.stringify(upwBody)} ${stored.n}`);

    // 042: the gate needs a reviewer-verified Bloom level, so an ACTIVE question without one exists only as pre-042 data;
    // one is made here (the canonical record is not content-locked) so analytics shows an unverified Bloom level.
    await db.query('UPDATE canonical_questions SET verified_bloom_level = NULL WHERE id = (SELECT canonical_question_id FROM questions WHERE id = $1)', [q4.ar.id]);
    // Analytics: CO, unit, topic and both matrices grouped by offering (two offerings share CO1 / Unit 1 / Trees),
    // Bloom and CO split verified / unverified; every figure equals SQL truth.
    r = await api('GET', '/question-bank/analytics', null, hod);
    const all4 = r.data;
    const truth = async (sqlText, off) => (await rows(sqlText, [off])).map((x) => ({ ...x }));
    const sameRows = (a, b, keys) => JSON.stringify(a.map((x) => keys.map((k) => x[k] ?? null)).sort()) === JSON.stringify(b.map((x) => keys.map((k) => x[k] ?? null)).sort());
    const ACT = `q.course_offering_id = $1 AND q.question_status = 'ACTIVE'`;
    const okFor = async (off) => {
      const co = await truth(`SELECT oc.code AS key, COUNT(DISTINCT q.id)::int AS n, COUNT(DISTINCT q.id) FILTER (WHERE qco.verified_by IS NOT NULL)::int AS verified,
          COUNT(DISTINCT q.id) FILTER (WHERE qco.verified_by IS NULL)::int AS unverified FROM questions q JOIN question_course_outcomes qco ON qco.canonical_question_id = q.canonical_question_id
          JOIN course_outcomes oc ON oc.id = qco.course_outcome_id AND oc.syllabus_version_id = q.syllabus_version_id WHERE ${ACT} GROUP BY 1`, off);
      const unit = await truth(`SELECT su.code AS key, COUNT(*)::int AS n FROM questions q JOIN canonical_questions cq ON cq.id = q.canonical_question_id
          JOIN syllabus_units su ON su.id = cq.verified_syllabus_unit_id WHERE ${ACT} GROUP BY 1`, off);
      const topic = await truth(`SELECT COALESCE(st.title, NULLIF(trim(q.topic), '')) AS key, COUNT(*)::int AS n FROM questions q LEFT JOIN canonical_questions cq ON cq.id = q.canonical_question_id
          LEFT JOIN syllabus_topics st ON st.id = cq.verified_syllabus_topic_id WHERE ${ACT} GROUP BY 1`, off);
      const ud = await truth(`SELECT su.code AS row, q.difficulty AS col, COUNT(*)::int AS n FROM questions q JOIN canonical_questions cq ON cq.id = q.canonical_question_id
          JOIN syllabus_units su ON su.id = cq.verified_syllabus_unit_id WHERE ${ACT} GROUP BY 1, 2`, off);
      const cb = await truth(`SELECT oc.code AS row, COALESCE(cq.verified_bloom_level, q.bloom_level, q.submitted_bloom_level) AS col, COUNT(DISTINCT q.id)::int AS n
          FROM questions q LEFT JOIN canonical_questions cq ON cq.id = q.canonical_question_id JOIN question_course_outcomes qco ON qco.canonical_question_id = q.canonical_question_id
          JOIN course_outcomes oc ON oc.id = qco.course_outcome_id AND oc.syllabus_version_id = q.syllabus_version_id WHERE ${ACT} GROUP BY 1, 2`, off);
      const mine = (list) => (list || []).filter((x) => x.offering_id === off);
      return {
        co: sameRows(mine(all4.active_by_co), co, ['key', 'n', 'verified', 'unverified']), unit: sameRows(mine(all4.active_by_unit), unit, ['key', 'n']),
        topic: sameRows(mine(all4.active_by_topic), topic, ['key', 'n']), ud: sameRows(mine(all4.coverage?.unit_x_difficulty), ud, ['row', 'col', 'n']),
        cb: sameRows(mine(all4.coverage?.co_x_bloom), cb, ['row', 'col', 'n']),
      };
    };
    const t1 = await okFor(F.off); const t4 = await okFor(F.off4);
    const co1Rows = (all4.active_by_co || []).filter((x) => x.key === 'CO1' && [F.off, F.off4].includes(x.offering_id));
    check('Phase 4a: analytics CO / unit / topic / Unit×Difficulty / CO×Bloom equal SQL truth per offering; the two "CO1"s stay separate',
      r.status === 200 && Object.values(t1).every(Boolean) && Object.values(t4).every(Boolean) && co1Rows.length === 2, `${JSON.stringify({ t1, t4 })} ${JSON.stringify(co1Rows)}`);
    r = await api('GET', `/question-bank/analytics?course_offering_id=${F.off4}`, null, hod);
    const bloomTruth = await rows(`SELECT COALESCE(cq.verified_bloom_level, q.bloom_level, q.submitted_bloom_level) AS key, COUNT(*)::int AS n,
        COUNT(*) FILTER (WHERE cq.verified_bloom_level IS NOT NULL)::int AS verified, COUNT(*) FILTER (WHERE cq.verified_bloom_level IS NULL)::int AS unverified
      FROM questions q LEFT JOIN canonical_questions cq ON cq.id = q.canonical_question_id WHERE q.course_offering_id = $1 AND q.question_status = 'ACTIVE' GROUP BY 1`, [F.off4]);
    const usageTruth = await one(`SELECT COUNT(*) FILTER (WHERE times_used = 0)::int AS never_used, COUNT(*) FILTER (WHERE last_used_at > now() - interval '180 days')::int AS used_last_180_days,
        COUNT(*)::int AS active_total FROM questions WHERE course_offering_id = $1 AND question_status = 'ACTIVE'`, [F.off4]);
    check('Phase 4a: analytics Bloom (verified / unverified) and usage equal SQL truth for the filtered offering',
      r.status === 200 && sameRows(r.data.active_by_bloom, bloomTruth, ['key', 'n', 'verified', 'unverified']) && JSON.stringify(r.data.usage) === JSON.stringify(usageTruth)
      && bloomTruth.some((x) => x.unverified > 0) && bloomTruth.some((x) => x.verified > 0), `${JSON.stringify(r.data.active_by_bloom)} vs ${JSON.stringify(bloomTruth)} | ${JSON.stringify(r.data.usage)} vs ${JSON.stringify(usageTruth)}`);

    // Export: the import layout, scoped, re-importable.
    const ex = await fetch(`${BASE}/question-bank/export?course_offering_id=${F.off4}`, { headers: { Authorization: `Bearer ${hod}` } });
    const exRows = ex.status === 200 ? XLSX.utils.sheet_to_json(XLSX.read(Buffer.from(await ex.arrayBuffer()), { type: 'buffer' }).Sheets.Questions, { defval: '' }) : [];
    const exTruth = await one(`SELECT COUNT(*)::int AS n FROM questions WHERE course_offering_id = $1 AND question_status <> 'DRAFT'`, [F.off4]);
    const exMcq = exRows.find((x) => String(x.question_text).startsWith('Which bound does binary search achieve'));
    const exProg = exRows.find((x) => String(x.question_text).startsWith('Complete the depth function'));
    check('Phase 4a: HOD export of an offering = SQL truth, in the import columns (type data as columns, COs, verified Bloom)',
      ex.status === 200 && exRows.length === exTruth.n && exMcq?.correct_answer === 'O(log n)' && exMcq?.co === 'CO1' && exProg?.language === 'Python'
      && Object.keys(exRows[0] || {}).slice(0, 3).join() === 'question_type,question_text,option_a', `${ex.status} ${exRows.length} vs ${exTruth.n} ${JSON.stringify(exMcq)}`);
    const exT = await fetch(`${BASE}/question-bank/export`, { headers: { Authorization: `Bearer ${teacher}` } });
    const exTRows = exT.status === 200 ? XLSX.utils.sheet_to_json(XLSX.read(Buffer.from(await exT.arrayBuffer()), { type: 'buffer' }).Sheets.Questions, { defval: '' }) : [];
    const ownTruth = await one('SELECT LEAST(COUNT(*), 2000)::int AS n FROM questions WHERE submitted_by = $1', [F.teacher]);
    check('Phase 4a: a teacher exports exactly their own questions', exT.status === 200 && exTRows.length === ownTruth.n, `${exT.status} ${exTRows.length} vs ${ownTruth.n}`);
    const exB = await fetch(`${BASE}/question-bank/export?course_offering_id=${F.offB}`, { headers: { Authorization: `Bearer ${hod}` } });
    const exC = await fetch(`${BASE}/question-bank/export`, { headers: { Authorization: `Bearer ${coe}` } });
    check('Phase 4a: export of another campus\'s offering, and by the COE, is refused', exB.status === 403 && exC.status === 403, `${exB.status} ${exC.status}`);
    fs.rmSync(new URL(`./uploads/${pngName}`, import.meta.url), { force: true });
  }

  console.log('\nSyllabus versioning, change detection and question mapping (phase 4b, migration 042)');
  {
    const S = {};
    // An offering of its own (semester 9), staffed through the HOD's routes (assignments grant the scopes).
    S.off = (await one(`INSERT INTO course_offerings (subject_id, program_id, academic_session_id, semester, offering_code, status) VALUES ($1,$2,$3,9,$4,'active') RETURNING id`,
      [F.subject, F.programA, F.session, 'SMKSY-' + tag])).id;
    await api('POST', '/academic/assignments/teacher', { teacher_id: F.teacher, course_offering_id: S.off }, hod);
    await api('POST', '/academic/assignments/reviewer', { reviewer_id: F.reviewer, course_offering_id: S.off }, hod);
    // A legacy question from before any syllabus version (APPROVED, verified Bloom only, no syllabus mapping).
    const legacyText = `legacy question without a syllabus version ${tag}`;
    const legacyCanon = (await one(`INSERT INTO canonical_questions (subject_id, canonical_text, normalized_text, question_type, question_hash, verified_difficulty, verified_bloom_level)
      VALUES ($1,$2,$3,'descriptive',$4,'easy','apply') RETURNING id`, [F.subject, legacyText, legacyText, `smk-${tag}-legacy`])).id;
    S.legacy = (await one(`INSERT INTO questions (subject_id, course_offering_id, submitted_by, question_type, question_text, difficulty, topic, marks, question_hash, model_answer,
        bloom_level, canonical_question_id, question_status, approved_by, is_draft)
      VALUES ($1,$2,$3,'descriptive',$4,'easy','Old topic',2,$5,'a sufficiently long model answer','apply',$6,'APPROVED',$7,FALSE) RETURNING id, syllabus_version_id`,
    [F.subject, S.off, F.teacher, legacyText, `smk-${tag}-legacy`, legacyCanon, F.reviewer]));

    // ---- version 1 through the API ----
    r = await api('POST', '/academic/syllabus-versions', { course_offering_id: S.off, notes: 'Units: Trees, Graphs' }, hod);
    S.v1 = r.data.id;
    check('042: a new syllabus version starts as DRAFT', r.status === 200 && r.data.status === 'DRAFT' && S.legacy.syllabus_version_id === null, `${r.status} ${JSON.stringify(r.data)}`);
    r = await api('POST', `/academic/syllabus-versions/${S.v1}/verify`, null, hod);
    check('042: an empty version cannot be verified (needs a unit with a topic and an active CO)', r.status === 400 && /at least one active unit/.test(r.data.error || ''), `${r.status} ${JSON.stringify(r.data)}`);
    const addUnit = async (sv, code, title) => (await api('POST', `/academic/syllabus-versions/${sv}/units`, { code, title }, hod)).data.id;
    const addTopic = async (unit, title) => (await api('POST', `/academic/units/${unit}/topics`, { title }, hod)).data.id;
    const addCo = async (sv, code, description) => (await api('POST', `/academic/syllabus-versions/${sv}/course-outcomes`, { code, description }, hod)).data.id;
    S.u1 = await addUnit(S.v1, 'U1', 'Trees'); S.u2 = await addUnit(S.v1, 'U2', 'Graphs');
    S.tAvl = await addTopic(S.u1, 'AVL'); S.tHeaps = await addTopic(S.u1, 'Heaps'); S.tBfs = await addTopic(S.u2, 'BFS');
    S.sRot = (await api('POST', `/academic/topics/${S.tAvl}/subtopics`, { title: 'Rotations' }, hod)).data.id;
    S.co1 = await addCo(S.v1, 'CO1', 'Explain balanced trees'); S.co2 = await addCo(S.v1, 'CO2', 'Apply graph search');
    check('042: the HOD builds the DRAFT content (units, topics, a subtopic, COs)', [S.u1, S.u2, S.tAvl, S.tHeaps, S.tBfs, S.sRot, S.co1, S.co2].every(Boolean));

    let f = await dbFails(`INSERT INTO syllabus_versions (course_offering_id, version_number, status, approval_status) VALUES ($1, 99, 'ACTIVE', 'hod_approved')`, [S.off], /starts as DRAFT/);
    check('042 DB: a version cannot be inserted as ACTIVE / approved', f.failed, f.message);
    f = await dbFails(`UPDATE syllabus_versions SET status = 'ACTIVE', approved_by = $2 WHERE id = $1`, [S.v1, F.hod], /Invalid syllabus version transition: DRAFT -> ACTIVE/);
    check('042 DB: DRAFT -> ACTIVE (skipping verification and HOD review) is refused', f.failed, f.message);
    f = await dbFails(`UPDATE syllabus_versions SET approval_status = 'hod_approved' WHERE id = $1`, [S.v1], /follow the syllabus version status/);
    check('042 DB: the legacy approval_status cannot be written on its own', f.failed, f.message);
    r = await api('POST', `/academic/syllabus-versions/${S.v1}/approve`, null, hod);
    check('042: approval of a DRAFT is refused (verify and submit first)', r.status === 400 && /teacher-verified/.test(r.data.error || ''), `${r.status} ${JSON.stringify(r.data)}`);
    r = await api('POST', `/academic/syllabus-versions/${S.v1}/verify`, null, hod);
    const r2 = await api('POST', `/academic/syllabus-versions/${S.v1}/submit-review`, null, hod);
    check('042: verify (DRAFT -> TEACHER_VERIFIED) then submit for HOD review', r.status === 200 && r2.status === 200, `${r.status} ${r2.status} ${JSON.stringify(r2.data)}`);
    r = await api('POST', `/academic/syllabus-versions/${S.v1}/units`, { code: 'U9', title: 'Late' }, hod);
    f = await dbFails(`INSERT INTO syllabus_units (syllabus_version_id, code, title) VALUES ($1, 'U9', 'Late')`, [S.v1], /content is locked/);
    check('042: content of a version in HOD review is locked (route 409 and DB)', r.status === 409 && f.failed, `${r.status} ${f.message}`);
    f = await dbFails(`UPDATE syllabus_versions SET status = 'ACTIVE', approved_by = $2 WHERE id = $1`, [S.v1, F.teacher], /approved by an active HOD/);
    check('042 DB: only an active HOD can be the approver', f.failed, f.message);
    r = await api('POST', `/academic/syllabus-versions/${S.v1}/approve`, null, hod);
    const v1row = await one(`SELECT sv.status, sv.approval_status, sv.verification_status, sv.approved_by, co.syllabus_version_id AS ptr
      FROM syllabus_versions sv JOIN course_offerings co ON co.id = sv.course_offering_id WHERE sv.id = $1`, [S.v1]);
    check('042: approval activates the version, mirrors approval_status and points the offering at it', r.status === 200 && r.data.previous_version_id === null
      && v1row.status === 'ACTIVE' && v1row.approval_status === 'hod_approved' && v1row.approved_by === F.hod && v1row.ptr === S.v1, `${r.status} ${JSON.stringify(r.data)} ${JSON.stringify(v1row)}`);

    // ---- questions on version 1, and an examination created on it ----
    const q = (text, status, { unit = S.u1, topic = 'AVL', co = S.co1, subtopicId = null } = {}) =>
      mkQuestion({ off: S.off, sv: S.v1, unit, topic, co, subtopicId, status, difficulty: 'easy', marks: 2, text: `${text} ${tag}` });
    S.qKeep = await q('syllabus keep AVL active', 'ACTIVE');
    S.qKeepSub = await q('syllabus keep AVL rotations approved', 'APPROVED', { subtopicId: S.sRot });
    S.qHeapsApproved = await q('syllabus heaps approved', 'APPROVED', { topic: 'Heaps' });
    S.qHeapsActive = await q('syllabus heaps active', 'ACTIVE', { topic: 'Heaps' });
    S.qBfsActive = await q('syllabus bfs co2 active', 'ACTIVE', { unit: S.u2, topic: 'BFS', co: S.co2 });
    S.qInReview = await q('syllabus avl under review', 'UNDER_REVIEW');
    const rb = (await one(`INSERT INTO review_batches (course_offering_id, title) VALUES ($1, $2) RETURNING id`, [S.off, `smoke 042 round ${tag}`])).id;
    await db.query('INSERT INTO review_batch_items (review_batch_id, question_id) VALUES ($1,$2)', [rb, S.qInReview]);
    r = await api('POST', '/examinations', { course_offering_id: S.off, exam_type: 'mid_term', maximum_marks: 2, duration_minutes: 30 }, coe);
    S.e1 = r.data;
    const poolOf = async (exam) => (await loadEligiblePool({ id: exam.id, course_offering_id: S.off, syllabus_version_id: exam.syllabus_version_id, subject_id: F.subject,
      campus_id: CAMPUS_A, program_id: F.programA }, { all: rows })).map((x) => x.id);
    const p1 = await poolOf(S.e1);
    check('042 pool on version 1: ACTIVE questions with reviewer-verified mappings only', r.status === 201 && [S.qKeep, S.qHeapsActive, S.qBfsActive].every((id) => p1.includes(id))
      && ![S.qKeepSub, S.qHeapsApproved, S.qInReview, S.legacy.id].some((id) => p1.includes(id)), `${r.status} ${JSON.stringify(p1)}`);
    await db.query('BEGIN');
    try {
      await db.query('UPDATE question_course_outcomes SET verified_by = NULL WHERE canonical_question_id = (SELECT canonical_question_id FROM questions WHERE id = $1)', [S.qKeep]);
      const pu = await poolOf(S.e1);
      const gate = await one('SELECT question_has_verified_mapping($1) AS ok', [S.qKeep]);
      check('042 pool: an ACTIVE question whose CO mapping has no recorded verifier is not eligible', !pu.includes(S.qKeep) && gate.ok === false, JSON.stringify(pu));
    } finally { await db.query('ROLLBACK'); }

    // ---- version 2 from the current one, changed, approved ----
    r = await api('POST', `/academic/course-offerings/${S.off}/syllabus-versions/from-current`, {}, teacher);
    check('042: a teacher cannot start a version from the current one', r.status === 403, `${r.status}`);
    r = await api('POST', `/academic/course-offerings/${S.off}/syllabus-versions/from-current`, {}, hod);
    S.v2 = r.data.id;
    const copied = await one(`SELECT (SELECT count(*)::int FROM syllabus_units WHERE syllabus_version_id = $1) AS units,
        (SELECT count(*)::int FROM syllabus_topics t JOIN syllabus_units u ON u.id = t.syllabus_unit_id WHERE u.syllabus_version_id = $1) AS topics,
        (SELECT count(*)::int FROM syllabus_subtopics s JOIN syllabus_topics t ON t.id = s.syllabus_topic_id JOIN syllabus_units u ON u.id = t.syllabus_unit_id WHERE u.syllabus_version_id = $1) AS subtopics,
        (SELECT count(*)::int FROM course_outcomes WHERE syllabus_version_id = $1) AS cos,
        (SELECT based_on_version_id FROM syllabus_versions WHERE id = $1) AS based_on, (SELECT status FROM syllabus_versions WHERE id = $1) AS status`, [S.v2]);
    check('042: "new version from current" copies units, topics, subtopics and COs into a DRAFT', r.status === 201 && copied.units === 2 && copied.topics === 3 && copied.subtopics === 1
      && copied.cos === 2 && copied.based_on === S.v1 && copied.status === 'DRAFT', `${r.status} ${JSON.stringify(r.data)} ${JSON.stringify(copied)}`);
    const v2Topic = async (title) => (await one(`SELECT t.id FROM syllabus_topics t JOIN syllabus_units u ON u.id = t.syllabus_unit_id WHERE u.syllabus_version_id = $1 AND t.title = $2`, [S.v2, title])).id;
    const v2Co = async (code) => (await one('SELECT id FROM course_outcomes WHERE syllabus_version_id = $1 AND code = $2', [S.v2, code])).id;
    const edits = [
      await api('POST', `/academic/topics/${await v2Topic('Heaps')}/deactivate`, null, hod),
      await api('POST', `/academic/course-outcomes/${await v2Co('CO2')}/deactivate`, null, hod),
      await api('POST', `/academic/syllabus-versions/${S.v2}/course-outcomes`, { code: 'CO3', description: 'Apply graph search' }, hod),
    ];
    const u3 = await addUnit(S.v2, 'U3', 'Hashing');
    edits.push(await api('POST', `/academic/units/${u3}/topics`, { title: 'Open addressing' }, hod));
    check('042: the DRAFT copy is edited (topic removed, CO renumbered, unit and topic added)', edits.every((x) => x.status === 200) && !!u3, JSON.stringify(edits.map((x) => x.status)));
    const conc = await Promise.all([...Array(4)].map(() => api('POST', '/academic/syllabus-versions', { course_offering_id: S.off, notes: 'concurrent' }, hod)));
    const nums = await rows('SELECT version_number FROM syllabus_versions WHERE course_offering_id = $1', [S.off]);
    check('042: concurrent version creation answers 200 or 409 (never 500) and version numbers stay unique',
      conc.every((x) => [200, 409].includes(x.status)) && conc.some((x) => x.status === 200) && new Set(nums.map((x) => x.version_number)).size === nums.length, JSON.stringify(conc.map((x) => x.status)));
    const spare = conc.filter((x) => x.status === 200).map((x) => x.data.id);
    r = await api('POST', `/academic/syllabus-versions/${spare[0]}/reject`, {}, hod);
    const rActive = await api('POST', `/academic/syllabus-versions/${S.v1}/reject`, { reason: 'smoke: try the active one' }, hod);
    let rejected = 0;
    for (const id of spare) rejected += (await api('POST', `/academic/syllabus-versions/${id}/reject`, { reason: 'smoke: concurrent duplicate' }, hod)).status === 200 ? 1 : 0;
    const rej = await one('SELECT status, rejection_reason, rejected_by FROM syllabus_versions WHERE id = $1', [spare[0]]);
    check('042: rejection needs a reason; the ACTIVE version is never rejected; a draft is rejected with who and why', r.status === 400 && rActive.status === 409
      && rejected === spare.length && rej.status === 'REJECTED' && rej.rejected_by === F.hod && /concurrent/.test(rej.rejection_reason), `${r.status} ${rActive.status} ${JSON.stringify(rej)}`);
    f = await dbFails(`UPDATE syllabus_versions SET status = 'REJECTED', rejected_by = $2 WHERE id = $1`, [S.v2, F.hod], /needs who rejected it and a reason/);
    check('042 DB: a rejection without a reason is refused', f.failed, f.message);

    await api('POST', `/academic/syllabus-versions/${S.v2}/verify`, null, hod);
    await api('POST', `/academic/syllabus-versions/${S.v2}/submit-review`, null, hod);
    r = await api('POST', `/academic/syllabus-versions/${S.v2}/approve`, null, teacher);
    check('042: a teacher cannot approve a syllabus version', r.status === 403, `${r.status}`);
    r = await api('POST', `/academic/syllabus-versions/${S.v2}/approve`, null, hod);
    check('042 approval: change and question counts reported', r.status === 200 && r.data.changes === 4 && r.data.questions_remapped === 2 && r.data.questions_sent_back === 1
      && r.data.questions_flagged === 2 && r.data.questions_skipped === 1 && r.data.questions_unmapped === 0, `${r.status} ${JSON.stringify(r.data)}`);
    const vs = await one(`SELECT (SELECT status FROM syllabus_versions WHERE id = $1) AS v1, (SELECT superseded_by_version_id FROM syllabus_versions WHERE id = $1) AS v1_by,
        (SELECT effective_to IS NOT NULL FROM syllabus_versions WHERE id = $1) AS v1_closed, (SELECT status FROM syllabus_versions WHERE id = $2) AS v2,
        (SELECT syllabus_version_id FROM course_offerings WHERE id = $3) AS ptr,
        (SELECT count(*)::int FROM syllabus_versions WHERE course_offering_id = $3 AND status = 'ACTIVE') AS active_n`, [S.v1, S.v2, S.off]);
    check('042: activation supersedes the previous version in the same transaction (one ACTIVE per offering)', vs.v1 === 'SUPERSEDED' && vs.v1_by === S.v2 && vs.v1_closed
      && vs.v2 === 'ACTIVE' && vs.ptr === S.v2 && vs.active_n === 1, JSON.stringify(vs));
    const ch = (await rows('SELECT entity_type, change_type, entity_id FROM syllabus_changes WHERE new_version_id = $1 ORDER BY 1, 2, 3', [S.v2])).map((c) => `${c.entity_type}:${c.change_type}:${c.entity_id}`);
    check('042 change detection: CO RENAMED (same description), topic ADDED and REMOVED, unit ADDED',
      JSON.stringify(ch) === JSON.stringify(['course_outcome:RENAMED:CO3', 'topic:ADDED:Open addressing', 'topic:REMOVED:Heaps', 'unit:ADDED:U3']), JSON.stringify(ch));

    const st = async (id) => one(`SELECT q.question_status, q.syllabus_version_id, q.change_request_reason, cq.verified_syllabus_topic_id, cq.verified_syllabus_subtopic_id,
        (SELECT count(*)::int FROM question_syllabus_remaps r WHERE r.question_id = q.id AND r.kind = 'auto_unchanged' AND r.from_version_id = $2) AS remaps,
        (SELECT string_agg(a.action_taken, ',' ORDER BY a.id) FROM affected_questions a WHERE a.question_id = q.id) AS actions,
        (SELECT count(*)::int FROM question_course_outcomes x JOIN course_outcomes oc ON oc.id = x.course_outcome_id
          WHERE x.canonical_question_id = q.canonical_question_id AND oc.syllabus_version_id = $3 AND x.verified_by IS NOT NULL) AS v2_verified_cos
      FROM questions q LEFT JOIN canonical_questions cq ON cq.id = q.canonical_question_id WHERE q.id = $1`, [id, S.v1, S.v2]);
    const v2Avl = await v2Topic('AVL');
    const v2Rot = (await one('SELECT id FROM syllabus_subtopics WHERE syllabus_topic_id = $1', [v2Avl])).id;
    const [keep, keepSub, heapsAp, heapsAc, bfs, inRev] = await Promise.all([S.qKeep, S.qKeepSub, S.qHeapsApproved, S.qHeapsActive, S.qBfsActive, S.qInReview].map(st));
    check('042 auto re-map: an ACTIVE question on unchanged items moves to the new version with its verified topic and CO (history row)', keep.question_status === 'ACTIVE'
      && keep.syllabus_version_id === S.v2 && keep.verified_syllabus_topic_id === v2Avl && keep.v2_verified_cos === 1 && keep.remaps === 1 && keep.actions === null, JSON.stringify(keep));
    check('042 auto re-map: an APPROVED question stays APPROVED and its verified subtopic follows', keepSub.question_status === 'APPROVED' && keepSub.syllabus_version_id === S.v2
      && keepSub.verified_syllabus_subtopic_id === v2Rot, JSON.stringify(keepSub));
    check('042: an affected APPROVED question goes back as CHANGES_REQUESTED with a reason naming the change', heapsAp.question_status === 'CHANGES_REQUESTED'
      && /topic "Heaps" removed/.test(heapsAp.change_request_reason || '') && heapsAp.actions === 'changes_requested' && heapsAp.syllabus_version_id === S.v1, JSON.stringify(heapsAp));
    check('042: affected ACTIVE questions (removed topic, renumbered CO) are flagged only: still ACTIVE on the old version', heapsAc.question_status === 'ACTIVE'
      && heapsAc.syllabus_version_id === S.v1 && heapsAc.actions === 'flagged' && bfs.question_status === 'ACTIVE' && bfs.syllabus_version_id === S.v1 && bfs.actions === 'flagged',
    JSON.stringify([heapsAc, bfs]));
    check('042: a question in an open review round is not moved', inRev.syllabus_version_id === S.v1 && inRev.question_status === 'UNDER_REVIEW', JSON.stringify(inRev));
    const trail = new Set((await rows(`SELECT action || ':' || entity_id AS k FROM audit_log WHERE entity_id = ANY($1::text[])`,
      [[S.qKeep, S.qKeepSub, S.qHeapsApproved, S.qHeapsActive, S.qBfsActive, S.qInReview, S.v1, S.v2]])).map((x) => x.k));
    check('042: every move is audited (approval, supersession, re-maps, the transition, flags, the skip)',
      [`syllabus_version_approved:${S.v2}`, `syllabus_version_superseded:${S.v1}`, `question_syllabus_remapped:${S.qKeep}`, `question_syllabus_remapped:${S.qKeepSub}`,
        `question_transition_changes_requested:${S.qHeapsApproved}`, `question_syllabus_flagged:${S.qHeapsActive}`, `question_syllabus_flagged:${S.qBfsActive}`,
        `question_syllabus_remap_skipped:${S.qInReview}`].every((k) => trail.has(k)), JSON.stringify([...trail]));

    // ---- eligibility after the change ----
    r = await api('POST', '/examinations', { course_offering_id: S.off, syllabus_version_id: S.v1, exam_type: 'quiz', maximum_marks: 2, duration_minutes: 30 }, coe);
    check('042: a new examination on the superseded version is refused', r.status === 400 && r.data.current_syllabus_version_id === S.v2, `${r.status} ${JSON.stringify(r.data)}`);
    r = await api('POST', '/examinations', { course_offering_id: S.off, exam_type: 'end_term', maximum_marks: 2, duration_minutes: 30 }, coe);
    S.e2 = r.data;
    const p2 = await poolOf(S.e2); const p1b = await poolOf(S.e1);
    check('Syllabus change -> old question not automatically eligible (042: affected ACTIVE questions stay out of the new version\'s pool)', r.status === 201
      && S.e2.syllabus_version_id === S.v2 && p2.includes(S.qKeep) && !p2.includes(S.qHeapsActive) && !p2.includes(S.qBfsActive), `${r.status} ${JSON.stringify(p2)}`);
    check('042: an examination created before the change keeps its pool (re-mapped unchanged questions and the old version\'s own)',
      [S.qKeep, S.qHeapsActive, S.qBfsActive].every((id) => p1b.includes(id)), JSON.stringify(p1b));

    // ---- change report ----
    r = await api('GET', `/academic/syllabus-versions/${S.v2}/changes`, null, hod);
    const heapsChange = (r.data.changes || []).find((c) => c.entity_type === 'topic' && c.change_type === 'REMOVED');
    check('042 change report: each change lists the questions it affected; unchanged re-maps counted (HOD)', r.status === 200 && r.data.questions_remapped_unchanged === 2
      && JSON.stringify((heapsChange?.affected_questions || []).map((a) => a.question_id).sort()) === JSON.stringify([S.qHeapsApproved, S.qHeapsActive].sort()), `${r.status} ${JSON.stringify(r.data).slice(0, 400)}`);
    const rr = await api('GET', `/academic/syllabus-versions/${S.v2}/changes`, null, reviewer);
    const rt = await api('GET', `/academic/syllabus-versions/${S.v2}/changes`, null, teacher);
    check('042 change report: the assigned reviewer reads it; a teacher cannot', rr.status === 200 && rt.status === 403, `${rr.status} ${rt.status}`);

    // ---- question mapping ----
    r = await api('GET', `/academic/question-mapping?course_offering_id=${S.off}`, null, hod);
    const kinds = Object.fromEntries((r.data.questions || []).map((x) => [x.id, x.kind]));
    check('042 mapping list: the legacy question, the superseded-version ones (incl. the one in review); not the re-mapped one', r.status === 200
      && kinds[S.legacy.id] === 'no_syllabus_version' && kinds[S.qHeapsActive] === 'superseded_version' && kinds[S.qBfsActive] === 'superseded_version'
      && kinds[S.qInReview] === 'superseded_version' && !kinds[S.qKeep], `${r.status} ${JSON.stringify(kinds)}`);
    const deptX = (await one(`INSERT INTO departments (name, code, description, institution_id, campus_id, college_id)
      SELECT 'Dept X ' || $1::text, 'DX' || $1::text, 'smoke', institution_id, campus_id, college_id FROM departments WHERE id = $2 RETURNING id`, [tag, F.dept])).id;
    const hodX = (await one(`INSERT INTO users (email, password_hash, role, department_id, campus_id, institution_id, must_change_password)
      VALUES ($1,$2,'hod',$3,$4,$5,FALSE) RETURNING id`, [`hodx-${tag}@portal.edu`, await hashPassword('HodX@Smoke12'), deptX, CAMPUS_A, INSTITUTION])).id;
    await db.query(`INSERT INTO user_scopes (user_id, role, campus_id, department_id) VALUES ($1, 'hod', $2, $3)`, [hodX, CAMPUS_A, deptX]);
    const hodXT = await login(`hodx-${tag}@portal.edu`, 'HodX@Smoke12');
    const v2co1 = await v2Co('CO1');
    const mapBody = (over = {}) => ({ syllabus_topic_id: v2Avl, primary_course_outcome_id: v2co1, reason: 'Heaps material is taught under AVL balancing in v2', ...over });
    const xMap = await api('POST', `/academic/questions/${S.qHeapsActive}/syllabus-mapping`, mapBody(), hodXT);
    const xList = await api('GET', `/academic/question-mapping?course_offering_id=${S.off}`, null, hodXT);
    const xAll = await api('GET', '/academic/question-mapping', null, hodXT);
    const xCh = await api('GET', `/academic/syllabus-versions/${S.v2}/changes`, null, hodXT);
    const still = await one('SELECT syllabus_version_id FROM questions WHERE id = $1', [S.qHeapsActive]);
    check('042 mapping: another department\'s HOD is refused (403), sees none of these questions, and nothing changes', xMap.status === 403 && xList.status === 403
      && xCh.status === 403 && xAll.status === 200 && !(xAll.data.questions || []).some((x) => x.course_offering_id === S.off) && still.syllabus_version_id === S.v1,
    `${xMap.status} ${xList.status} ${xCh.status} ${xAll.status}`);
    const refusals = [
      await api('POST', `/academic/questions/${S.qHeapsActive}/syllabus-mapping`, mapBody({ syllabus_topic_id: S.tAvl }), hod),
      await api('POST', `/academic/questions/${S.qHeapsActive}/syllabus-mapping`, mapBody({ reason: 'too short' }), hod),
      await api('POST', `/academic/questions/${S.qHeapsActive}/syllabus-mapping`, mapBody({ primary_course_outcome_id: S.co1 }), hod),
      await api('POST', `/academic/questions/${S.qHeapsApproved}/syllabus-mapping`, mapBody(), hod),
      await api('POST', `/academic/questions/${S.qInReview}/syllabus-mapping`, mapBody(), hod),
      await api('POST', `/academic/questions/${S.qHeapsActive}/syllabus-mapping`, mapBody(), teacher),
    ];
    check('042 mapping: a topic or CO of another version, a short reason, an editable or in-review question and a teacher are refused',
      JSON.stringify(refusals.map((x) => x.status)) === JSON.stringify([400, 400, 400, 409, 409, 403]), JSON.stringify(refusals.map((x) => [x.status, x.data.error])));
    r = await api('POST', `/academic/questions/${S.qHeapsActive}/syllabus-mapping`, mapBody(), hod);
    const mapped = await st(S.qHeapsActive);
    const mapRow = await one(`SELECT count(*)::int AS remaps, (SELECT count(*)::int FROM affected_questions WHERE question_id = $1 AND reviewed AND review_outcome = 'remapped') AS resolved,
        (SELECT count(*)::int FROM audit_log WHERE action = 'question_syllabus_mapped' AND entity_id = $1::text) AS audits
      FROM question_syllabus_remaps WHERE question_id = $1 AND kind = 'hod_mapping'`, [S.qHeapsActive]);
    const p2b = await poolOf(S.e2);
    check('042 mapping: the HOD maps a flagged ACTIVE question onto the ACTIVE version (reason, history, flag resolved, audit) and it becomes eligible',
      r.status === 200 && r.data.generation_eligible === true && mapped.question_status === 'ACTIVE' && mapped.syllabus_version_id === S.v2 && mapped.verified_syllabus_topic_id === v2Avl
      && mapRow.remaps === 1 && mapRow.resolved >= 1 && mapRow.audits === 1 && p2b.includes(S.qHeapsActive), `${r.status} ${JSON.stringify(r.data)} ${JSON.stringify(mapped)} ${JSON.stringify(mapRow)}`);
    r = await api('POST', `/academic/questions/${S.legacy.id}/syllabus-mapping`, mapBody({ reason: 'Legacy question re-mapped to the current syllabus' }), hod);
    const act = await api('POST', `/questions/${S.legacy.id}/transition`, { target_status: 'ACTIVE' }, reviewer);
    const p2c = await poolOf(S.e2);
    check('042 mapping: a legacy question without a version is mapped, passes the gate and enters the pool', r.status === 200 && act.status === 200 && p2c.includes(S.legacy.id),
      `${r.status} ${JSON.stringify(r.data)} ${act.status} ${JSON.stringify(act.data)}`);

    // ---- the question form follows the current syllabus ----
    r = await api('GET', `/academic/course-offerings/${S.off}/syllabus-tree`, null, teacher);
    const treeTopics = (r.data.units || []).flatMap((u) => u.topics.map((t) => t.title));
    check('042: the teacher\'s syllabus tree is the ACTIVE version (removed topic gone, new unit there)', r.status === 200 && r.data.version_number === 2
      && treeTopics.includes('Open addressing') && !treeTopics.includes('Heaps'), `${r.status} ${JSON.stringify(treeTopics)}`);
    const draftBody = { question_type: 'descriptive', question_text: `Explain a single rotation ${tag}`, difficulty: 'easy', marks: 2, model_answer: 'A sufficiently long model answer', course_offering_id: S.off };
    const badTopic = await api('POST', '/questions/draft', { ...draftBody, topic: 'Heaps' }, teacher);
    r = await api('POST', '/questions/draft', { ...draftBody, syllabus_topic_id: v2Avl, subtopic_id: v2Rot }, teacher);
    const dRow = r.data.id ? await one('SELECT topic, subtopic, subtopic_id, syllabus_version_id FROM questions WHERE id = $1', [r.data.id]) : null;
    check('042: a draft\'s topic must be in the current syllabus; the selected topic and subtopic ids are stored', badTopic.status === 400 && r.status === 200
      && dRow?.topic === 'AVL' && dRow?.subtopic === 'Rotations' && dRow?.subtopic_id === v2Rot && dRow?.syllabus_version_id === S.v2, `${badTopic.status} ${r.status} ${JSON.stringify(dRow)}`);
    f = await dbFails('UPDATE questions SET subtopic_id = $2 WHERE id = $1', [r.data.id, S.sRot], /subtopic is not part of its syllabus version/);
    check('042 DB: a question\'s subtopic_id must belong to its own syllabus version', f.failed, f.message);
    r = await api('POST', '/questions/draft', { ...draftBody, id: S.qHeapsApproved, question_text: `syllabus heaps approved ${tag}`, topic: 'AVL' }, teacher);
    const moved = await one(`SELECT q.syllabus_version_id, q.topic, (SELECT count(*)::int FROM question_syllabus_remaps r WHERE r.question_id = q.id AND r.kind = 'author_edit') AS edits
      FROM questions q WHERE q.id = $1`, [S.qHeapsApproved]);
    check('042: the author\'s edit of the sent-back question moves it to the current version (history row)', r.status === 200 && moved.syllabus_version_id === S.v2
      && moved.topic === 'AVL' && moved.edits === 1, `${r.status} ${JSON.stringify(r.data)} ${JSON.stringify(moved)}`);

    // ---- database backstops ----
    const locks = [
      await dbFails(`INSERT INTO syllabus_units (syllabus_version_id, code, title) VALUES ($1, 'U9', 'x')`, [S.v2], /content is locked/),
      await dbFails(`UPDATE syllabus_topics SET title = 'renamed' WHERE id = $1`, [S.tAvl], /content is locked/),
      await dbFails('UPDATE course_outcomes SET is_active = FALSE WHERE id = $1', [v2co1], /content is locked/),
      await dbFails('UPDATE syllabus_subtopics SET is_active = FALSE WHERE id = $1', [v2Rot], /content is locked/),
    ];
    check('042 DB: units, topics, subtopics and COs of an ACTIVE or SUPERSEDED version cannot be created, changed or deactivated', locks.every((x) => x.failed), JSON.stringify(locks.map((x) => x.message)));
    const vlocks = [
      await dbFails(`UPDATE syllabus_versions SET extracted_units = '{}' WHERE id = $1`, [S.v2], /cannot change/),
      await dbFails(`UPDATE syllabus_versions SET status = 'ACTIVE' WHERE id = $1`, [S.v1], /Invalid syllabus version transition: SUPERSEDED -> ACTIVE/),
      await dbFails('DELETE FROM syllabus_versions WHERE id = $1', [S.v1], /cannot be deleted/),
      await dbFails('UPDATE course_offerings SET syllabus_version_id = $1 WHERE id = $2', [S.v1, S.off], /must be its ACTIVE version/),
    ];
    check('042 DB: an approved version is immutable (fields, status, deletion) and the offering points only at its ACTIVE version', vlocks.every((x) => x.failed), JSON.stringify(vlocks.map((x) => x.message)));
    const hatchOn = async () => db.query("SELECT set_config('app.syllabus_remap', 'on', true)");
    const hatch = [
      await txnFails([hatchOn], 'UPDATE questions SET syllabus_version_id = $2 WHERE id = $1', [S.qKeep, S.v1], /only onto its offering's ACTIVE syllabus version/),
      await dbFails('UPDATE questions SET syllabus_version_id = $2 WHERE id = $1', [S.qKeep, S.v1], /content is locked/),
      await txnFails([hatchOn], 'UPDATE questions SET marks = 9 WHERE id = $1', [S.qKeep], /content is locked/),
    ];
    check('042 DB: the re-mapping hatch moves a locked question only onto the ACTIVE version and opens no other column', hatch.every((x) => x.failed), JSON.stringify(hatch.map((x) => x.message)));

    // ---- analytics: generation readiness and subtopic coverage equal SQL truth ----
    r = await api('GET', `/question-bank/analytics?course_offering_id=${S.off}`, null, hod);
    const ready = await one(`SELECT COUNT(*)::int AS active_total, COUNT(*) FILTER (WHERE question_has_verified_mapping(q.id) AND q.syllabus_version_id = $2)::int AS generation_eligible,
        COUNT(*) FILTER (WHERE NOT question_has_verified_mapping(q.id))::int AS not_eligible_unverified,
        COUNT(*) FILTER (WHERE question_has_verified_mapping(q.id) AND q.syllabus_version_id <> $2)::int AS not_eligible_other_version
      FROM questions q WHERE q.course_offering_id = $1 AND q.question_status = 'ACTIVE'`, [S.off, S.v2]);
    check('042 analytics: generation readiness (eligible / unverified / left on the old version) equals SQL truth; subtopic coverage reported', r.status === 200
      && JSON.stringify(r.data.generation_readiness) === JSON.stringify(ready) && Array.isArray(r.data.active_by_subtopic) && ready.not_eligible_other_version === 1,
    `${JSON.stringify(r.data.generation_readiness)} vs ${JSON.stringify(ready)}`);
  }

  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `, ${failed.length} FAILED` : ''}`);
  await db.end();
  process.exit(failed.length ? 1 : 0);
}
main().catch(async (e) => { console.error('\nSmoke test aborted:', e.message); try { await db.end(); } catch { /* ignore */ } process.exit(2); });
