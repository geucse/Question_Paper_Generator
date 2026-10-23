// Demo dataset seed: 14 subjects of the 2023 CSE syllabus with 20 SAMPLE questions each (src/demo-dataset.js).
//
//   npm run seed            (first: the base accounts, CSE department, B.Tech program and 2026-2027 session)
//   npm run seed:demo       (this script)          npm run seed:demo -- --check   (validate the dataset only)
//
// How it writes: it starts the real API in-process (as the route tests do) and performs every change as the
// responsible role through the normal routes: the HOD creates subjects, offerings and syllabus versions and
// verifies and approves them, assigns teachers and reviewers and runs review batches; teachers write and submit
// questions with their subject's own COs; reviewers verify classification, decide and activate. So every
// validation, scope check, quality gate, audit entry and database trigger applies exactly as in normal use. The
// interactive sign-in (password + one-time code) is replaced by short-lived tokens minted for the seeded demo
// accounts, which the API checks like any other token (account active, token_version, role, scope).
//
// Only the demo accounts are created directly in the database, following seed.js (the app has no other way to
// create the first accounts). It refuses to run in production (seed-guard.js), and it is idempotent: it reads what
// already exists and only moves things forward, so running it again creates nothing twice.
//
// Every question it creates is DEMO / SAMPLE content (not an official examination question): the subjects carry
// that label in their description and the offerings end in -DEMO. See docs/demo-data/CATALOG.md.
import 'dotenv/config';
import './seed-guard.js';
import { loadDemoDataset, datasetSummary, lifecyclePlan, DEMO_LABEL } from './demo-dataset.js';

// Database and auth modules are loaded only when seeding: `--check` validates the dataset with no database and no
// .env (auth.js requires JWT_SECRET at import).
let pool; let get; let all; let run; let hashPassword; let grantScope;
async function loadRuntime() {
  ({ pool, get, all, run } = await import('./db.js'));
  ({ hashPassword } = await import('./auth.js'));
  ({ grantScope } = await import('./scopes.js'));
}

const CHECK_ONLY = process.argv.includes('--check');
const INSTITUTION_ID = '00000000-0000-0000-0000-000000000001';
const CAMPUS_ID = '00000000-0000-0000-0000-000000000002';
const COLLEGE_ID = '00000000-0000-0000-0000-000000000003';
const SESSION_LABEL = '2026-2027';
const TEACHERS = ['teacher1@portal.edu', 'teacher2@portal.edu', 'teacher3@portal.edu', 'teacher4@portal.edu'];
const REVIEWERS = ['reviewer@portal.edu', 'reviewer2@portal.edu', 'reviewer3@portal.edu'];

// Lifecycle plan per subject (demo-dataset.js lifecyclePlan): four questions stay out of the ACTIVE bank, one each
// DRAFT, SUBMITTED, CHANGES_REQUESTED and APPROVED, chosen so the ACTIVE questions still cover every unit and CO.
// Scenario D: in TCS 571, question 16 goes through a full revision cycle before it becomes ACTIVE.
const REVISION_SUBJECT = 'TCS 571';
const REVISION_POSITION = 16;
const plans = new Map();
export const plannedStatus = (subject, position) => {
  if (!plans.has(subject.code)) plans.set(subject.code, lifecyclePlan(subject, { keepActive: subject.code === REVISION_SUBJECT ? [REVISION_POSITION] : [] }));
  return plans.get(subject.code).get(position);
};
const isRevisionCase = (code, position) => code === REVISION_SUBJECT && position === REVISION_POSITION;

const log = (...a) => console.log('[seed:demo]', ...a);
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

// ---------------------------------------------------------------------------------------------------------------
// API client (the real server, started in this process)
// ---------------------------------------------------------------------------------------------------------------
let base; let signJwt;
const tokens = {};
async function startApi() {
  process.env.PORT = process.env.SEED_API_PORT || '4599';
  process.env.GLOBAL_RATE_MAX = process.env.GLOBAL_RATE_MAX || '1000000';
  process.env.RATE_LIMIT_STORE = process.env.RATE_LIMIT_STORE || 'memory';
  ({ signJwt } = await import('./auth.js'));
  await import('./server.js');
  base = `http://127.0.0.1:${process.env.PORT}/api`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).status) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('The API did not start');
}
async function tokenFor(email) {
  const u = await get('SELECT id, token_version FROM users WHERE email = $1 AND is_active', [email]);
  if (!u) throw new Error(`Demo account ${email} is missing or inactive (run npm run seed first)`);
  tokens[email] = signJwt({ sub: u.id, tv: u.token_version }, '30m');
  return tokens[email];
}
async function api(email, method, path, body, { allow = [] } = {}) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[email] || await tokenFor(email)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok || allow.includes(res.status)) return { status: res.status, data };
  const err = new Error(`${method} ${path} as ${email} -> ${res.status}: ${data.error || JSON.stringify(data).slice(0, 300)}${data.details ? ` (${JSON.stringify(data.details)})` : ''}${data.validation_errors ? ` (${data.validation_errors.join('; ')})` : ''}`);
  err.status = res.status; err.data = data;
  throw err;
}

// ---------------------------------------------------------------------------------------------------------------
// Demo accounts beyond seed.js (same conventions: published dev passwords, employee ids, scopes)
// ---------------------------------------------------------------------------------------------------------------
async function ensureUser({ email, role, password, departmentId, scope }) {
  let u = await get('SELECT id FROM users WHERE email = $1', [email]);
  if (!u) {
    u = await get('INSERT INTO users (email, password_hash, role, department_id) VALUES ($1, $2, $3, $4) RETURNING id',
      [email, await hashPassword(password), role, departmentId]);
    const n = (await get("SELECT COUNT(*)::int AS n FROM users WHERE employee_id LIKE 'EMP-DEMO-%'")).n + 1;
    await run('UPDATE users SET institution_id = $1, campus_id = $2, employee_id = $3, full_name = $4 WHERE id = $5',
      [INSTITUTION_ID, CAMPUS_ID, `EMP-DEMO-${String(n).padStart(3, '0')}`, `Demo ${email.split('@')[0]}`, u.id]);
  }
  await grantScope({ userId: u.id, ...scope });
  return u.id;
}

async function baseContext() {
  const dept = await get("SELECT id FROM departments WHERE code = 'CSE'");
  const program = dept && await get("SELECT id FROM programs WHERE department_id = $1 AND code = 'BTECH-CSE'", [dept.id]);
  const session = await get('SELECT id FROM academic_sessions WHERE label = $1', [SESSION_LABEL]);
  const hod = await get("SELECT id FROM users WHERE email = 'hod@portal.edu'");
  if (!dept || !program || !session || !hod) throw new Error('Run `npm run seed` first: the demo seed builds on its department, program, session and accounts');
  // A second department, so out-of-scope access can be demonstrated (scenario F).
  let ece = await get("SELECT id FROM departments WHERE code = 'ECE'");
  if (!ece) {
    ece = await get('INSERT INTO departments (name, code, description, institution_id, campus_id, college_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      ['Electronics & Communication Engineering', 'ECE', 'Demo department used to show out-of-scope access being refused', INSTITUTION_ID, CAMPUS_ID, COLLEGE_ID]);
  }
  for (const email of ['reviewer2@portal.edu', 'reviewer3@portal.edu']) {
    await ensureUser({ email, role: 'reviewer', password: 'Review@123', departmentId: dept.id, scope: { role: 'reviewer', campusId: CAMPUS_ID, departmentId: dept.id } });
  }
  await ensureUser({ email: 'reviewer.ece@portal.edu', role: 'reviewer', password: 'Review@123', departmentId: ece.id, scope: { role: 'reviewer', campusId: CAMPUS_ID, departmentId: ece.id } });
  return { departmentId: dept.id, programId: program.id, sessionId: session.id, eceId: ece.id };
}

// ---------------------------------------------------------------------------------------------------------------
// Subject, offering and the HOD-verified syllabus version
// ---------------------------------------------------------------------------------------------------------------
const unitTitle = (u) => {
  const head = /^([^:]{3,80}?)\s*:/.exec(u.text)?.[1];
  return `Unit ${u.number}: ${head || u.text.slice(0, 80)}`.slice(0, 200);
};

async function ensureSubjectAndOffering(s, ctx) {
  let subject = await get('SELECT id FROM subjects WHERE subject_code = $1', [s.code]);
  if (!subject) {
    subject = (await api('hod@portal.edu', 'POST', '/academic/subjects', {
      subject_code: s.code, course_title: s.title, category: s.category === 'DE' ? 'elective' : 'core',
      description: `${DEMO_LABEL}. Official syllabus: Graphic Era (Deemed to be University) CSE 2023, Semester ${s.semester}, pages ${s.pages.join('-')}.`,
    })).data;
  }
  let offering = await get('SELECT id, syllabus_version_id FROM course_offerings WHERE subject_id = $1 AND program_id = $2 AND academic_session_id = $3 AND semester = $4',
    [subject.id, ctx.programId, ctx.sessionId, s.semester]);
  if (!offering) {
    offering = (await api('hod@portal.edu', 'POST', '/academic/course-offerings', {
      subject_id: subject.id, program_id: ctx.programId, academic_session_id: ctx.sessionId, semester: s.semester,
      offering_code: `${s.code.replace(/\s+/g, '')}-2026-S${s.semester}-DEMO`,
    })).data;
  }
  return { subjectId: subject.id, offeringId: offering.id };
}

async function ensureSyllabus(s, offeringId) {
  const active = await get("SELECT id FROM syllabus_versions WHERE course_offering_id = $1 AND status = 'ACTIVE'", [offeringId]);
  if (active) return active.id;
  let version = await get("SELECT id, status FROM syllabus_versions WHERE course_offering_id = $1 AND status IN ('DRAFT', 'TEACHER_VERIFIED', 'HOD_REVIEW') ORDER BY version_number LIMIT 1", [offeringId]);
  if (!version) {
    const flags = (s.hod_flags || []).map((f) => `HOD flag ${f.co}: ${f.issue}`);
    const corrections = (s.corrections || []).map((c) => `Correction unit ${c.unit}: "${c.from}" -> "${c.to}" (${c.reason})`);
    version = (await api('hod@portal.edu', 'POST', '/academic/syllabus-versions', {
      course_offering_id: offeringId,
      extracted_units: s.units.map((u) => ({ number: u.number, hours: u.hours, text: u.text })),
      notes: [`Source: ${s.code} ${s.title}, Syllabus-2023-New.pdf pages ${s.pages.join('-')}; extracted by syllabus-parse.js and verified by the HOD.`, ...corrections, ...flags].join('\n'),
    })).data;
  }
  if (version.status === 'DRAFT' || !version.status) {
    // Course outcomes exactly as printed; units and the HOD-verified topics.
    const haveCos = new Set((await all('SELECT code FROM course_outcomes WHERE syllabus_version_id = $1 AND is_active', [version.id])).map((r) => r.code));
    for (const [i, co] of s.course_outcomes.entries()) {
      if (!haveCos.has(co.code)) await api('hod@portal.edu', 'POST', `/academic/syllabus-versions/${version.id}/course-outcomes`, { code: co.code, description: co.text, sequence: i + 1 });
    }
    for (const u of s.units) {
      let unit = await get('SELECT id FROM syllabus_units WHERE syllabus_version_id = $1 AND code = $2 AND is_active', [version.id, `U${u.number}`]);
      if (!unit) unit = (await api('hod@portal.edu', 'POST', `/academic/syllabus-versions/${version.id}/units`, { code: `U${u.number}`, title: unitTitle(u), sequence: u.number })).data;
      const haveTopics = new Set((await all('SELECT lower(title) AS t FROM syllabus_topics WHERE syllabus_unit_id = $1 AND is_active', [unit.id])).map((r) => r.t));
      for (const [i, title] of (s.topics[String(u.number)] || []).entries()) {
        if (!haveTopics.has(title.toLowerCase())) await api('hod@portal.edu', 'POST', `/academic/units/${unit.id}/topics`, { title, sequence: i + 1 });
      }
    }
    await api('hod@portal.edu', 'POST', `/academic/syllabus-versions/${version.id}/verify`, {});
    version.status = 'TEACHER_VERIFIED';
  }
  if (version.status === 'TEACHER_VERIFIED') { await api('hod@portal.edu', 'POST', `/academic/syllabus-versions/${version.id}/submit-review`, {}); version.status = 'HOD_REVIEW'; }
  if (version.status === 'HOD_REVIEW') await api('hod@portal.edu', 'POST', `/academic/syllabus-versions/${version.id}/approve`, {});
  return version.id;
}

async function ensureAssignments(index, offeringId) {
  const teachers = [TEACHERS[index % 4], TEACHERS[(index + 1) % 4]];
  for (const email of teachers) {
    const t = await get('SELECT id FROM users WHERE email = $1', [email]);
    const has = await get('SELECT id FROM teacher_course_assignments WHERE teacher_id = $1 AND course_offering_id = $2 AND is_active', [t.id, offeringId]);
    if (!has) await api('hod@portal.edu', 'POST', '/academic/assignments/teacher', { teacher_id: t.id, course_offering_id: offeringId, assignment_role: 'instructor' });
  }
  const reviewer = REVIEWERS[index % 3];
  const r = await get('SELECT id FROM users WHERE email = $1', [reviewer]);
  let ra = await get('SELECT id FROM reviewer_assignments WHERE reviewer_id = $1 AND course_offering_id = $2 AND is_active', [r.id, offeringId]);
  if (!ra) ra = (await api('hod@portal.edu', 'POST', '/academic/assignments/reviewer', { reviewer_id: r.id, course_offering_id: offeringId })).data;
  return { teachers, reviewer, reviewerAssignmentId: ra.id };
}

// ---------------------------------------------------------------------------------------------------------------
// Questions: written, submitted, reviewed, decided and activated through the lifecycle routes
// ---------------------------------------------------------------------------------------------------------------
// Scenario D's first version omits the last sentence; the reviewer asks for it and the author restores it.
const firstVersionText = (text) => {
  const parts = text.split(/(?<=[.?!])\s+(?=[A-Z])/);
  return parts.length > 1 ? parts.slice(0, -1).join(' ') : `${text} (first draft)`;
};
const REVISION_COMMENT = 'Please state exactly what the answer must cover (add the final instruction), so that the marking is unambiguous.';

async function placement(versionId, q) {
  const row = await get(`SELECT t.id AS topic_id, u.id AS unit_id FROM syllabus_topics t JOIN syllabus_units u ON u.id = t.syllabus_unit_id
    WHERE u.syllabus_version_id = $1 AND u.code = $2 AND lower(t.title) = lower($3) AND t.is_active AND u.is_active`, [versionId, `U${q.unit_number}`, q.topic_title]);
  if (!row) throw new Error(`Topic "${q.topic_title}" of unit ${q.unit_number} is not in the syllabus version`);
  const cos = await all('SELECT id, code FROM course_outcomes WHERE syllabus_version_id = $1 AND is_active AND code = ANY($2::text[])', [versionId, q.cos]);
  const primary = cos.find((c) => c.code === q.cos[0]);
  if (!primary || cos.length !== q.cos.length) throw new Error(`COs ${q.cos.join(', ')} are not all in the syllabus version`);
  return { topicId: row.topic_id, unitId: row.unit_id, primaryCoId: primary.id, secondaryCoIds: cos.filter((c) => c.id !== primary.id).map((c) => c.id) };
}

const draftBody = (q, offeringId, topicId, text) => ({
  course_offering_id: offeringId, question_type: q.question_type, question_text: text, marks: q.marks, difficulty: q.difficulty,
  bloom_level: q.bloom_level, model_answer: q.model_answer, option_a: q.option_a, option_b: q.option_b, option_c: q.option_c,
  option_d: q.option_d, correct_answer: q.correct_answer, answer_data: q.answer_data, syllabus_topic_id: topicId,
});

async function seedQuestions(s, offeringId, versionId, asg) {
  // Current state of every demo question of this offering (read-only; matched by text, the dataset has no duplicates).
  const rows = await all('SELECT id, question_text, question_status, submitted_by FROM questions WHERE course_offering_id = $1', [offeringId]);
  const items = [];
  for (const [i, q] of s.questions.entries()) {
    const position = i + 1;
    const revision = isRevisionCase(s.code, position);
    const texts = [norm(q.question_text), ...(revision ? [norm(firstVersionText(q.question_text))] : [])];
    const row = rows.find((r) => texts.includes(norm(r.question_text)));
    items.push({ q, position, revision, target: plannedStatus(s, position), author: asg.teachers[i % 2], id: row?.id, status: row?.question_status || null,
      place: await placement(versionId, q) });
  }

  // Create missing drafts.
  for (const it of items.filter((x) => !x.id)) {
    const text = it.revision ? firstVersionText(it.q.question_text) : it.q.question_text;
    const out = (await api(it.author, 'POST', '/questions/draft', draftBody(it.q, offeringId, it.place.topicId, text))).data;
    it.id = out.id; it.status = 'DRAFT';
  }

  // Rounds: submit -> batch -> verdicts -> decisions -> activation, until every question has reached its plan.
  for (let round = 1; round <= 4; round++) {
    let progressed = false;
    // Submit (or resubmit after revision) with the subject's own COs.
    for (const it of items) {
      const wantsSubmit = (it.status === 'DRAFT' && it.target !== 'DRAFT')
        || (it.status === 'CHANGES_REQUESTED' && it.revision && it.target === 'ACTIVE' && it.revisedOnce);
      if (!wantsSubmit) continue;
      await api(it.author, 'POST', `/questions/${it.id}/submit`, { primary_course_outcome_id: it.place.primaryCoId, secondary_course_outcome_ids: it.place.secondaryCoIds });
      it.status = it.status === 'DRAFT' ? 'SUBMITTED' : 'RESUBMITTED';
      progressed = true;
    }
    // A review batch for everything waiting for review (except questions planned to stay SUBMITTED).
    const toReview = items.filter((it) => ['SUBMITTED', 'RESUBMITTED'].includes(it.status) && it.target !== 'SUBMITTED');
    if (toReview.length) {
      const batch = (await api('hod@portal.edu', 'POST', '/review/batches', {
        course_offering_id: offeringId, title: `${s.code} demo review round ${round}`, question_ids: toReview.map((it) => it.id),
      })).data;
      const batchId = batch.id || batch.batch?.id;
      await api('hod@portal.edu', 'POST', `/review/batches/${batchId}/assign`, { reviewer_assignment_ids: [asg.reviewerAssignmentId] });
      for (const it of toReview) {
        const revise = it.target === 'CHANGES_REQUESTED' || (it.revision && !it.revisedOnce);
        await api(asg.reviewer, 'POST', `/review/batches/${batchId}/questions/${it.id}/verdict`, revise
          ? { decision: 'request_revision', comment: REVISION_COMMENT }
          : { decision: 'accept', verified_difficulty: it.q.difficulty, verified_bloom_level: it.q.bloom_level, verified_course_outcome_id: it.place.primaryCoId,
            verified_syllabus_unit_id: it.place.unitId, verified_syllabus_topic_id: it.place.topicId, answer_approved: true,
            comment: 'Checked: syllabus alignment, correctness, clarity, CO validity, Bloom fit, difficulty, answer key and marks.' });
        it.decision = revise ? 'CHANGES_REQUESTED' : 'APPROVED';
        it.status = 'UNDER_REVIEW';
      }
      await api(asg.reviewer, 'POST', `/review/batches/${batchId}/complete`, { reviewer_summary: `Demo review of ${toReview.length} question(s) for ${s.code}.` });
      for (const it of toReview) {
        await api(asg.reviewer, 'POST', `/questions/${it.id}/transition`, { target_status: it.decision, reason: it.decision === 'CHANGES_REQUESTED' ? REVISION_COMMENT : undefined });
        it.status = it.decision;
      }
      progressed = true;
    }
    // Scenario D: the author revises the returned question (restores the missing instruction).
    for (const it of items.filter((x) => x.revision && x.status === 'CHANGES_REQUESTED' && !x.revisedOnce)) {
      await api(it.author, 'POST', '/questions/draft', { id: it.id, ...draftBody(it.q, offeringId, it.place.topicId, it.q.question_text) });
      it.revisedOnce = true; progressed = true;
    }
    // Activation of approved questions planned to be ACTIVE (the quality gate runs on each).
    for (const it of items.filter((x) => x.status === 'APPROVED' && x.target === 'ACTIVE')) {
      const asHod = await api('hod@portal.edu', 'POST', `/questions/${it.id}/transition`, { target_status: 'ACTIVE' }, { allow: [403] });
      if (asHod.status === 403) await api(asg.reviewer, 'POST', `/questions/${it.id}/transition`, { target_status: 'ACTIVE' });
      it.status = 'ACTIVE'; progressed = true;
    }
    if (!progressed) break;
  }
  const off = items.filter((it) => it.status !== it.target);
  if (off.length) throw new Error(`${s.code}: ${off.map((it) => `Q${it.position} is ${it.status}, planned ${it.target}`).join('; ')}`);
  return items.reduce((m, it) => { m[it.status] = (m[it.status] || 0) + 1; return m; }, {});
}

// ---------------------------------------------------------------------------------------------------------------
async function main() {
  const { subjects, errors } = loadDemoDataset();
  if (errors.length) { console.error('[seed:demo] The demo dataset is invalid; nothing was seeded:\n  ' + errors.join('\n  ')); process.exit(1); }
  const summary = datasetSummary(subjects);
  log(`dataset valid: ${summary.subjects} subjects, ${summary.questions} questions, ${summary.course_outcomes} COs, ${summary.units} units, ${summary.topics} topics`);
  if (CHECK_ONLY) return;
  await loadRuntime();

  const ctx = await baseContext();
  await startApi();
  const totals = {};
  for (const [index, s] of subjects.entries()) {
    const { offeringId } = await ensureSubjectAndOffering(s, ctx);
    const versionId = await ensureSyllabus(s, offeringId);
    const asg = await ensureAssignments(index, offeringId);
    const counts = await seedQuestions(s, offeringId, versionId, asg);
    for (const [k, v] of Object.entries(counts)) totals[k] = (totals[k] || 0) + v;
    log(`${s.code.padEnd(8)} ${s.title}: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
  // Scenario E: a revised syllabus version of TCS 571 started from the current one (left in DRAFT for the HOD).
  const tcs571 = await get("SELECT co.id FROM course_offerings co JOIN subjects s ON s.id = co.subject_id WHERE s.subject_code = 'TCS 571' AND co.academic_session_id = $1", [ctx.sessionId]);
  if (tcs571 && !(await get("SELECT id FROM syllabus_versions WHERE course_offering_id = $1 AND status = 'DRAFT'", [tcs571.id]))) {
    await api('hod@portal.edu', 'POST', `/academic/course-offerings/${tcs571.id}/syllabus-versions/from-current`, {});
  }
  log(`done: ${Object.entries(totals).map(([k, v]) => `${k} ${v}`).join(', ')} (${DEMO_LABEL})`);
  log('demo accounts: the ones printed by `npm run seed`, plus reviewer2@portal.edu, reviewer3@portal.edu and reviewer.ece@portal.edu (password Review@123)');
  await pool.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('[seed:demo] failed:', err.message);
  try { await pool?.end(); } catch { /* closed */ }
  process.exit(1);
});
