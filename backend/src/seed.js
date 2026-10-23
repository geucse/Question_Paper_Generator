import 'dotenv/config';
import './seed-guard.js';
import { pool, get, run } from './db.js';
import { hashPassword, normalizeQuestionHash } from './auth.js';
import { grantScope } from './scopes.js';

// Default hierarchy created by migration 023 (institution > campus > college).
const INSTITUTION_ID = '00000000-0000-0000-0000-000000000001';
const CAMPUS_ID = '00000000-0000-0000-0000-000000000002';
const COLLEGE_ID = '00000000-0000-0000-0000-000000000003';

// Readable development names ('Dev Teacher 1'); identity is the employee id, never the name (spec §5).
const devName = (email) => {
  const local = email.split('@')[0];
  const m = /^([a-z]+?)(\d*)$/.exec(local);
  const word = (m ? m[1] : local).replace(/^./, (c) => c.toUpperCase());
  return `Dev ${word === 'Hod' ? 'HOD' : word === 'Coe' ? 'COE' : word}${m && m[2] ? ` ${m[2]}` : ''}`;
};

async function seed() {
  // ---- Academic hierarchy: one department -> one program -> one subject
  // -> one course offering (this session, this semester) -> one section.
  let dept = await get("SELECT id FROM departments WHERE code = 'CSE'");
  if (!dept) {
    dept = await get(`
      INSERT INTO departments (name, code, description, institution_id, campus_id, college_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
    `, ['Computer Science & Engineering', 'CSE', 'Department of Computer Science & Engineering', INSTITUTION_ID, CAMPUS_ID, COLLEGE_ID]);
  }
  const departmentId = dept.id;

  let program = await get("SELECT id FROM programs WHERE department_id = $1 AND code = 'BTECH-CSE'", [departmentId]);
  if (!program) {
    program = await get(`
      INSERT INTO programs (department_id, name, code, degree_type, duration_years, institution_id, campus_id, college_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id
    `, [departmentId, 'B.Tech Computer Science & Engineering', 'BTECH-CSE', 'UG', 4, INSTITUTION_ID, CAMPUS_ID, COLLEGE_ID]);
  }
  const programId = program.id;

  let subject = await get("SELECT id FROM subjects WHERE subject_code = 'DSA101'");
  if (!subject) {
    subject = await get(`
      INSERT INTO subjects (subject_code, course_title, description, credits, theory_hours, category)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
    `, ['DSA101', 'Data Structures & Algorithms', 'Core CSE subject covering fundamental data structures and algorithm design.', 4, 3, 'core']);
  }
  const subjectId = subject.id;

  await run(`
    INSERT INTO program_subjects (program_id, subject_id, curriculum_role, effective_from)
    VALUES ($1, $2, 'core', '2025-01-01') ON CONFLICT DO NOTHING
  `, [programId, subjectId]);

  let session = await get("SELECT id FROM academic_sessions WHERE label = '2026-2027'");
  if (!session) {
    session = await get(`
      INSERT INTO academic_sessions (label, start_date, end_date, status)
      VALUES ($1, $2, $3, 'active') RETURNING id
    `, ['2026-2027', '2026-07-01', '2027-06-30']);
  }
  const sessionId = session.id;

  let offering = await get(`
    SELECT id FROM course_offerings
    WHERE program_id = $1 AND subject_id = $2 AND academic_session_id = $3 AND semester = 3
  `, [programId, subjectId, sessionId]);
  if (!offering) {
    offering = await get(`
      INSERT INTO course_offerings (subject_id, program_id, academic_session_id, semester, offering_code, status)
      VALUES ($1, $2, $3, 3, 'DSA101-2026-S3', 'active') RETURNING id
    `, [subjectId, programId, sessionId]);
  }
  const offeringId = offering.id;

  let section = await get("SELECT id FROM sections WHERE course_offering_id = $1 AND name = 'A'", [offeringId]);
  if (!section) {
    section = await get(`
      INSERT INTO sections (course_offering_id, name, code) VALUES ($1, 'A', 'CSE-3A') RETURNING id
    `, [offeringId]);
  }
  const sectionId = section.id;

  let sectionB = await get("SELECT id FROM sections WHERE course_offering_id = $1 AND name = 'B'", [offeringId]);
  if (!sectionB) {
    sectionB = await get(`
      INSERT INTO sections (course_offering_id, name, code) VALUES ($1, 'B', 'CSE-3B') RETURNING id
    `, [offeringId]);
  }

  // ---- A second subject + offering, so teacher1 has more than one active
  // assignment and the frontend's course-offering picker (not just the
  // single-offering banner) is actually exercised. ----
  let subject2 = await get("SELECT id FROM subjects WHERE subject_code = 'OS201'");
  if (!subject2) {
    subject2 = await get(`
      INSERT INTO subjects (subject_code, course_title, description, credits, theory_hours, category)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
    `, ['OS201', 'Operating Systems', 'Core CSE subject covering process management, memory, and file systems.', 4, 3, 'core']);
  }
  const subject2Id = subject2.id;
  await run(`
    INSERT INTO program_subjects (program_id, subject_id, curriculum_role, effective_from)
    VALUES ($1, $2, 'core', '2025-01-01') ON CONFLICT DO NOTHING
  `, [programId, subject2Id]);

  let offering2 = await get(`
    SELECT id FROM course_offerings WHERE program_id = $1 AND subject_id = $2 AND academic_session_id = $3 AND semester = 4
  `, [programId, subject2Id, sessionId]);
  if (!offering2) {
    offering2 = await get(`
      INSERT INTO course_offerings (subject_id, program_id, academic_session_id, semester, offering_code, status)
      VALUES ($1, $2, $3, 4, 'OS201-2026-S4', 'active') RETURNING id
    `, [subject2Id, programId, sessionId]);
  }
  const offering2Id = offering2.id;
  const users = [
    { email: 'admin@portal.edu', role: 'admin', password: 'Admin@12345', deadline: null, dept: null },
    { email: 'hod@portal.edu', role: 'hod', password: 'Hod@12345', deadline: null, dept: departmentId },
    { email: 'reviewer@portal.edu', role: 'reviewer', password: 'Review@123', deadline: null, dept: departmentId },
    { email: 'teacher1@portal.edu', role: 'teacher', password: 'Teach@123', deadline: '2027-12-31T23:59:59.000Z', dept: departmentId },
    { email: 'teacher2@portal.edu', role: 'teacher', password: 'Teach@123', deadline: '2027-12-31T23:59:59.000Z', dept: departmentId },
    { email: 'teacher3@portal.edu', role: 'teacher', password: 'Teach@123', deadline: '2027-12-31T23:59:59.000Z', dept: departmentId },
    { email: 'teacher4@portal.edu', role: 'teacher', password: 'Teach@123', deadline: '2027-12-31T23:59:59.000Z', dept: departmentId },
    { email: 'coe@portal.edu', role: 'coe', password: 'Coe@123456', deadline: null, dept: null },
    ...[1, 2, 3, 4, 5].map(i => ({ email: `validator${i}@portal.edu`, role: 'validator', password: 'Valid@12345', deadline: null, dept: null })),
  ];

  const userIds = {};
  for (const u of users) {
    let existing = await get('SELECT id FROM users WHERE email = $1', [u.email]);
    if (!existing) {
      const hash = await hashPassword(u.password);
      existing = await get(`
        INSERT INTO users (email, password_hash, role, department_id, access_deadline)
        VALUES ($1, $2, $3, $4, $5) RETURNING id
      `, [u.email, hash, u.role, u.dept, u.deadline]);
    }
    userIds[u.email] = existing.id;
  }

  // ---- Identity + scopes (PIVOT_SPEC_V2 sections 4-5). Nothing else in the app
  // creates scopes, so seeded users get them here. All dev accounts: campus = default campus.
  let emp = 1;
  for (const u of users) {
    await run(`UPDATE users SET institution_id = $1, campus_id = $2, employee_id = COALESCE(employee_id, $3), full_name = COALESCE(full_name, $4) WHERE id = $5`,
      [INSTITUTION_ID, CAMPUS_ID, `EMP-DEV-${String(emp++).padStart(3, '0')}`, devName(u.email), userIds[u.email]]);
    if (u.role === 'admin') {
      await grantScope({ userId: userIds[u.email], role: 'admin', campusId: CAMPUS_ID });
    } else if (['hod', 'reviewer'].includes(u.role)) {
      await grantScope({ userId: userIds[u.email], role: u.role, campusId: CAMPUS_ID, departmentId });
    } else if (u.role === 'coe') {
      await grantScope({ userId: userIds[u.email], role: 'coe', campusId: CAMPUS_ID, programId });
    } else if (u.role === 'validator') {
      await grantScope({ userId: userIds[u.email], role: 'validator', campusId: CAMPUS_ID });
    } else if (u.role === 'teacher') {
      await grantScope({ userId: userIds[u.email], role: 'teacher', campusId: CAMPUS_ID, departmentId, programId, courseOfferingId: offeringId });
    }
  }

  // ---- Teacher course assignments: every teacher is assigned to this one
  // offering/section for now (multi-assignment support exists in the schema
  // for when a real deployment has teachers across several offerings).
  for (const email of ['teacher1@portal.edu', 'teacher2@portal.edu', 'teacher3@portal.edu', 'teacher4@portal.edu']) {
    const existing = await get(`
      SELECT id FROM teacher_course_assignments WHERE teacher_id = $1 AND course_offering_id = $2
    `, [userIds[email], offeringId]);
    if (!existing) {
      await run(`
        INSERT INTO teacher_course_assignments (teacher_id, course_offering_id, section_id, assignment_role)
        VALUES ($1, $2, $3, 'instructor')
      `, [userIds[email], offeringId, sectionId]);
    }
  }

  // teacher1 also teaches OS201 — this is what makes the offering picker
  // in the teacher dashboard actually show more than one option.
  const t1SecondOffering = await get(`
    SELECT id FROM teacher_course_assignments WHERE teacher_id = $1 AND course_offering_id = $2
  `, [userIds['teacher1@portal.edu'], offering2Id]);
  if (!t1SecondOffering) {
    await run(`
      INSERT INTO teacher_course_assignments (teacher_id, course_offering_id, section_id, assignment_role)
      VALUES ($1, $2, NULL, 'instructor')
    `, [userIds['teacher1@portal.edu'], offering2Id]);
  }

  // reviewer@portal.edu reviews the DSA101 offering.
  const reviewerAssignment = await get(`
    SELECT id FROM reviewer_assignments WHERE reviewer_id = $1 AND course_offering_id = $2
  `, [userIds['reviewer@portal.edu'], offeringId]);
  if (!reviewerAssignment) {
    await run(`
      INSERT INTO reviewer_assignments (reviewer_id, course_offering_id, assigned_by)
      VALUES ($1, $2, $3)
    `, [userIds['reviewer@portal.edu'], offeringId, userIds['hod@portal.edu']]);
  }

  // Sample previous-year question hashes so the "never repeat" constraint has something to exclude
  const prevYearQs = [
    'What is the time complexity of merge sort in the average case',
    'Define a binary search tree and its properties'
  ];
  for (const text of prevYearQs) {
    const hash = normalizeQuestionHash(text);
    const existing = await get('SELECT id FROM previous_year_papers WHERE question_hash = $1', [hash]);
    if (!existing) {
      await run(`
        INSERT INTO previous_year_papers (subject_id, course_offering_id, year, question_hash, question_text)
        VALUES ($1, $2, 2025, $3, $4)
      `, [subjectId, offeringId, hash, text]);
    }
  }

  console.log('Seed complete.');
  console.log('Department (CSE):', departmentId);
  console.log('Program (BTECH-CSE):', programId);
  console.log('Subject (DSA101):', subjectId, '| Subject (OS201):', subject2Id);
  console.log('Course offering (DSA101, 2026-2027, sem 3):', offeringId);
  console.log('Course offering (OS201, 2026-2027, sem 4):', offering2Id);
  console.log('Sections A, B under DSA101 offering');
  console.log('teacher1 is assigned to BOTH offerings (to exercise the offering picker); teacher2-4 to DSA101 only.');
  console.log('reviewer@portal.edu is assigned to review the DSA101 offering.');
  console.log('\nLocal development only. Login credentials (password + emailed code; the code is delivered through '
    + 'OTP_DELIVERY_PROVIDER, or with DEV_OTP_CONSOLE=reveal it is printed in the server log, never in an API response):');
  users.forEach(u => console.log(`  ${u.role.padEnd(10)} ${u.email.padEnd(22)} password: ${u.password}`));
  console.log('\nNote: the COE must also enable TOTP before final paper approval (Authenticator tab; setup asks for the current password).');

  await pool.end();
}

seed().catch(async (err) => {
  console.error('Seed failed:', err.message);
  await pool.end();
  process.exit(1);
});
