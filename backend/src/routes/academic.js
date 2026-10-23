import express from 'express';
import { get, all, run, withTransaction } from '../db.js';
import { requireAuth, requireRole } from '../middleware.js';
import { logAudit } from '../audit.js';
import { notify, notifyMany } from '../notifications.js';
import { grantScope, revokeAssignmentScope } from '../scopes.js';
import { isUuid, departmentContext, programContext, checkAcademic, guardOffering, hodCoversSql } from '../academic-scope.js';
import { normalizeQuestionHash } from '../auth.js';
import { activateSyllabusVersion } from '../syllabus-versioning.js';

// Authorization (PIVOT_SPEC_V2 §2, §4, §39): every route resolves its object, then checks it through authorize()
// (academic-scope.js): HOD = an active hod scope over the object's campus + department (user_scopes, never
// users.department_id); teacher = an active assignment to the offering; reviewer = an active assignment plus
// reviewer scope. Admin is technical-only: it builds the structure (departments, programs, offerings, sections,
// accounts) and takes no part in syllabus content, staffing (assignments) or previous-year papers.
// Order in every route: resolve (404), authorize (403), check state (400/409), write.

const router = express.Router();

// The offering an object belongs to. The version query is the same text as before (existing callers/mocks).
const OWNER_SQL = {
  version: 'SELECT * FROM syllabus_versions WHERE id = $1',
  // Content rows also carry their version's status: only a DRAFT version's content can change (migration 042).
  course_outcome: `SELECT c.id, sv.course_offering_id, sv.status AS version_status, sv.version_number FROM course_outcomes c
    JOIN syllabus_versions sv ON sv.id = c.syllabus_version_id WHERE c.id = $1`,
  unit: `SELECT su.id, sv.course_offering_id, sv.status AS version_status, sv.version_number FROM syllabus_units su
    JOIN syllabus_versions sv ON sv.id = su.syllabus_version_id WHERE su.id = $1`,
  topic: `SELECT st.id, sv.course_offering_id, sv.status AS version_status, sv.version_number FROM syllabus_topics st JOIN syllabus_units su ON su.id = st.syllabus_unit_id
              JOIN syllabus_versions sv ON sv.id = su.syllabus_version_id WHERE st.id = $1`,
  subtopic: `SELECT ss.id, sv.course_offering_id, sv.status AS version_status, sv.version_number FROM syllabus_subtopics ss JOIN syllabus_topics st ON st.id = ss.syllabus_topic_id
    JOIN syllabus_units su ON su.id = st.syllabus_unit_id JOIN syllabus_versions sv ON sv.id = su.syllabus_version_id WHERE ss.id = $1`,
  teacher_assignment: 'SELECT * FROM teacher_course_assignments WHERE id = $1',
  reviewer_assignment: 'SELECT * FROM reviewer_assignments WHERE id = $1',
};

// Resolve an object by kind, then guard its offering. 404 for unknown or malformed ids (never a 500 from the
// UUID cast), 403 out of scope. Returns { row, ctx } or null when the response has been sent.
async function guardObject(req, res, kind, id, mode) {
  const row = isUuid(id) ? await get(OWNER_SQL[kind], [id]) : null;
  if (!row) { res.status(404).json({ error: 'Not found' }); return null; }
  const ctx = await guardOffering(req, res, row.course_offering_id, mode);
  return ctx ? { row, ctx } : null;
}

// Map an INSERT failure to a clear status without echoing database text (spec §4: no internal errors in responses).
function insertError(res, e, duplicateMsg, invalidMsg) {
  if (e.code === '23505') return res.status(409).json({ error: duplicateMsg });
  if (['23503', '23502', '23514', '22P02', '22007', '22008', '22003'].includes(e.code)) return res.status(400).json({ error: invalidMsg });
  if (/Syllabus content is locked/.test(String(e.message))) return res.status(409).json({ error: 'This syllabus version is no longer a draft: its content is locked' });
  throw e;
}

// Syllabus content (units, topics, subtopics, COs) changes only while its version is DRAFT (also enforced by
// trg_guard_syllabus_content). Sends 409 and returns false otherwise.
function draftOnly(res, status, versionNumber) {
  if (status === 'DRAFT') return true;
  res.status(409).json({ error: `Syllabus version ${versionNumber} is ${status}: its content is locked. Start a new version from it to change the syllabus.`,
    version_status: status });
  return false;
}

// ============ READ: teacher's own view ============

// A teacher's own active assignments — this is what drives which
// course_offering_id/section_id a question submission can attach to.
router.get('/my-assignments', requireAuth, requireRole('teacher'), async (req, res) => {
  const rows = await all(`
    SELECT
      tca.id as assignment_id, tca.assignment_role, tca.section_id,
      s.name as section_name,
      co.id as course_offering_id, co.semester, co.offering_code,
      subj.id as subject_id, subj.subject_code, subj.course_title,
      prog.id as program_id, prog.name as program_name, prog.code as program_code,
      sess.id as academic_session_id, sess.label as academic_session_label
    FROM teacher_course_assignments tca
    JOIN course_offerings co ON co.id = tca.course_offering_id
    JOIN subjects subj ON subj.id = co.subject_id
    JOIN programs prog ON prog.id = co.program_id
    JOIN academic_sessions sess ON sess.id = co.academic_session_id
    LEFT JOIN sections s ON s.id = tca.section_id
    WHERE tca.teacher_id = $1 AND tca.is_active = TRUE
    ORDER BY sess.start_date DESC NULLS LAST, subj.course_title ASC
  `, [req.user.id]);
  res.json(rows);
});

// A reviewer's own active assignments.
router.get('/my-reviewer-assignments', requireAuth, requireRole('reviewer'), async (req, res) => {
  const rows = await all(`
    SELECT ra.id as assignment_id, co.id as course_offering_id, co.semester, co.offering_code,
      subj.subject_code, subj.course_title, sess.label as academic_session_label
    FROM reviewer_assignments ra
    JOIN course_offerings co ON co.id = ra.course_offering_id
    JOIN subjects subj ON subj.id = co.subject_id
    JOIN academic_sessions sess ON sess.id = co.academic_session_id
    WHERE ra.reviewer_id = $1 AND ra.is_active = TRUE
    ORDER BY sess.start_date DESC NULLS LAST
  `, [req.user.id]);
  res.json(rows);
});

// ============ READ: reference lists (admin/HOD management screens) ============

// Course offerings: admin sees all (structure picker); an HOD those its hod scope covers; a reviewer those it is
// actively assigned to and still holds reviewer scope for.
router.get('/course-offerings', requireAuth, requireRole('admin', 'hod', 'reviewer'), async (req, res) => {
  const params = [];
  let filter = '';
  if (req.user.role === 'hod') {
    params.push(req.user.id);
    filter = `WHERE ${hodCoversSql('$1', 'co.campus_id', 'dept.id')}`;
  } else if (req.user.role === 'reviewer') {
    params.push(req.user.id);
    filter = `WHERE co.id IN (SELECT course_offering_id FROM reviewer_assignments WHERE reviewer_id = $1 AND is_active = TRUE)
      AND user_has_scope($1, 'reviewer', co.campus_id, dept.id, NULL, NULL)`;
  }
  const rows = await all(`
    SELECT
      co.id as course_offering_id, co.semester, co.offering_code, co.status, co.campus_id,
      subj.id as subject_id, subj.subject_code, subj.course_title,
      prog.id as program_id, prog.name as program_name,
      sess.id as academic_session_id, sess.label as academic_session_label,
      dept.id as department_id, dept.name as department_name
    FROM course_offerings co
    JOIN subjects subj ON subj.id = co.subject_id
    JOIN programs prog ON prog.id = co.program_id
    JOIN departments dept ON dept.id = prog.department_id
    JOIN academic_sessions sess ON sess.id = co.academic_session_id
    ${filter}
    ORDER BY sess.start_date DESC NULLS LAST, subj.course_title ASC
  `, params);
  res.json(rows);
});

const DEPARTMENTS_SQL = `
  SELECT d.*, ca.name AS campus_name, cl.name AS college_name
  FROM departments d LEFT JOIN campuses ca ON ca.id = d.campus_id LEFT JOIN colleges cl ON cl.id = d.college_id
  WHERE d.is_active = TRUE`;
router.get('/departments', requireAuth, requireRole('admin', 'hod'), async (req, res) => {
  res.json(req.user.role === 'admin'
    ? await all(`${DEPARTMENTS_SQL} ORDER BY d.name`)
    : await all(`${DEPARTMENTS_SQL} AND ${hodCoversSql('$1', 'd.campus_id', 'd.id')} ORDER BY d.name`, [req.user.id]));
});

router.get('/programs', requireAuth, requireRole('admin', 'hod'), async (req, res) => {
  const rows = req.user.role === 'admin'
    ? await all('SELECT p.*, d.name as department_name FROM programs p JOIN departments d ON d.id = p.department_id WHERE p.is_active = TRUE ORDER BY p.name')
    : await all(`SELECT p.*, d.name as department_name FROM programs p JOIN departments d ON d.id = p.department_id
                 WHERE p.is_active = TRUE AND ${hodCoversSql('$1', 'p.campus_id', 'p.department_id')} ORDER BY p.name`, [req.user.id]);
  res.json(rows);
});

// Subjects and sessions are an institution-wide catalogue (no campus/department columns); they grant no access.
router.get('/subjects', requireAuth, requireRole('admin', 'hod'), async (req, res) => {
  res.json(await all('SELECT * FROM subjects WHERE is_active = TRUE ORDER BY course_title'));
});

router.get('/sessions', requireAuth, requireRole('admin', 'hod'), async (req, res) => {
  res.json(await all('SELECT * FROM academic_sessions ORDER BY start_date DESC NULLS LAST'));
});

// Pickers for creating a department (technical structure work).
router.get('/campuses', requireAuth, requireRole('admin'), async (req, res) => {
  res.json(await all('SELECT id, name, code FROM campuses WHERE is_active ORDER BY name'));
});

router.get('/colleges', requireAuth, requireRole('admin'), async (req, res) => {
  const campusId = req.query.campus_id ? String(req.query.campus_id) : null;
  if (campusId && !isUuid(campusId)) return res.status(400).json({ error: 'campus_id must be a UUID' });
  res.json(await all('SELECT id, campus_id, name, code FROM colleges WHERE is_active AND ($1::uuid IS NULL OR campus_id = $1::uuid) ORDER BY name', [campusId]));
});

router.get('/sections', requireAuth, requireRole('admin', 'hod'), async (req, res) => {
  const { course_offering_id } = req.query;
  if (!course_offering_id) return res.status(400).json({ error: 'course_offering_id is required' });
  const ctx = await guardOffering(req, res, String(course_offering_id), 'structure');
  if (!ctx) return;
  res.json(await all('SELECT * FROM sections WHERE course_offering_id = $1 ORDER BY name', [ctx.course_offering_id]));
});

// Teachers an HOD can assign: active teachers whose home campus + department the HOD's scope covers.
// (Admin manages accounts through /users; assigning teachers is the HOD's staffing decision.)
router.get('/teachers', requireAuth, requireRole('hod'), async (req, res) => {
  res.json(await all(`SELECT id, email, department_id FROM users
    WHERE role = 'teacher' AND is_active = TRUE AND ${hodCoversSql('$1', 'campus_id', 'department_id')} ORDER BY email`, [req.user.id]));
});

// Spec §12: the HOD sees reviewer workload before assigning/reassigning.
// pending_questions counts questions awaiting a reviewer decision in the offerings the reviewer is assigned to
// (shared offerings count for every assigned reviewer). Every count covers only offerings the CALLING HOD's scope
// covers: a reviewer also assigned in another department or campus does not reveal that department's figures.
const IN_MY_SCOPE = `JOIN course_offerings co ON co.id = ra.course_offering_id JOIN programs p ON p.id = co.program_id
       AND ${hodCoversSql('$1', 'co.campus_id', 'p.department_id')}`;
const REVIEWER_WORKLOAD_SQL = `
  SELECT u.id, u.email, u.full_name, u.department_id,
    (SELECT COUNT(*)::int FROM reviewer_assignments ra ${IN_MY_SCOPE} WHERE ra.reviewer_id = u.id AND ra.is_active) AS active_offerings,
    (SELECT COUNT(*)::int FROM questions q
       JOIN reviewer_assignments ra ON ra.course_offering_id = q.course_offering_id AND ra.reviewer_id = u.id AND ra.is_active ${IN_MY_SCOPE}
      WHERE q.question_status IN ('SUBMITTED', 'UNDER_REVIEW', 'RESUBMITTED') AND q.submitted_by <> u.id) AS pending_questions,
    (SELECT COUNT(*)::int FROM questions q
       JOIN reviewer_assignments ra ON ra.course_offering_id = q.course_offering_id AND ra.reviewer_id = u.id AND ra.is_active ${IN_MY_SCOPE}
      WHERE q.question_status = 'APPROVED' AND q.submitted_by <> u.id) AS awaiting_activation
  FROM users u
  WHERE u.role = 'reviewer' AND u.is_active = TRUE`;

router.get('/reviewers', requireAuth, requireRole('hod'), async (req, res) => {
  res.json(await all(`${REVIEWER_WORKLOAD_SQL} AND ${hodCoversSql('$1', 'u.campus_id', 'u.department_id')} ORDER BY u.email`, [req.user.id]));
});

// ============ WRITE: building the hierarchy ============
// Departments are admin-only structure work. The college (and with it the campus and institution) is resolved
// explicitly: the given college; else the campus's only active college; else the institution's only active
// college. More than one match is refused with the candidates listed, never a silent default.
router.post('/departments', requireAuth, requireRole('admin'), async (req, res) => {
  const { name, code, description, campus_id = null, college_id = null } = req.body || {};
  if (!name || !code) return res.status(400).json({ error: 'name and code are required' });
  if ((campus_id && !isUuid(campus_id)) || (college_id && !isUuid(college_id))) {
    return res.status(400).json({ error: 'campus_id/college_id must be UUIDs' });
  }
  const cols = await all(`
    SELECT c.id, c.campus_id, ca.institution_id FROM colleges c JOIN campuses ca ON ca.id = c.campus_id
    WHERE c.is_active AND ca.is_active AND ($1::uuid IS NULL OR c.id = $1::uuid) AND ($2::uuid IS NULL OR c.campus_id = $2::uuid)`,
  [college_id || null, campus_id || null]);
  if (!cols.length) {
    return res.status(400).json({ error: college_id ? 'That college does not exist, is inactive, or is not on that campus' : 'No active college found for that campus' });
  }
  if (cols.length > 1) return res.status(400).json({ error: 'More than one college matches: choose college_id', colleges: cols.map((c) => c.id) });
  const col = cols[0];
  let dept;
  try {
    dept = await get(`INSERT INTO departments (name, code, description, institution_id, campus_id, college_id)
                      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [name, String(code).toUpperCase(), description || null, col.institution_id, col.campus_id, col.id]);
  } catch (e) {
    return insertError(res, e, 'That department code is already in use (codes are unique across campuses)', 'Could not create department: invalid values');
  }
  await logAudit({ userId: req.user.id, action: 'department_created', entityId: dept.id,
    details: { campus_id: col.campus_id, college_id: col.id, code: dept.code }, ip: req.ip });
  res.json(dept);
});

// Programs: admin in any active department; an HOD in a department its scope covers (its own by default).
router.post('/programs', requireAuth, requireRole('admin', 'hod'), async (req, res) => {
  const { name, code, degree_type, duration_years } = req.body || {};
  const deptId = req.user.role === 'admin' ? req.body?.department_id : (req.body?.department_id || req.user.department_id);
  if (!name || !code || !deptId) return res.status(400).json({ error: 'name, code, and department_id are required' });
  const d = await departmentContext(deptId);
  if (!d || !d.is_active) return res.status(400).json({ error: 'department_id must be an active department' });
  const a = await checkAcademic(req.user, 'structure', d, 'department', d.department_id);
  if (!a.allowed) return res.status(403).json({ error: a.reason });
  let program;
  try {
    program = await get(`
      INSERT INTO programs (department_id, name, code, degree_type, duration_years) VALUES ($1, $2, $3, $4, $5) RETURNING *
    `, [d.department_id, name, String(code).toUpperCase(), degree_type || null, duration_years || null]);
  } catch (e) {
    return insertError(res, e, 'That program code already exists in this department', 'Could not create program: invalid values');
  }
  await logAudit({ userId: req.user.id, action: 'program_created', entityId: program.id, details: { department_id: d.department_id }, ip: req.ip });
  res.json(program);
});

// Subjects are department-agnostic identities (they get scoped to a
// department only via which program includes them) — any admin/HOD can
// define one, since a subject with no program_subjects link does nothing yet.
router.post('/subjects', requireAuth, requireRole('admin', 'hod'), async (req, res) => {
  const { subject_code, course_title, description, credits, theory_hours, category } = req.body || {};
  if (!subject_code || !course_title) return res.status(400).json({ error: 'subject_code and course_title are required' });
  let subject;
  try {
    subject = await get(`
      INSERT INTO subjects (subject_code, course_title, description, credits, theory_hours, category)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
    `, [String(subject_code).toUpperCase(), course_title, description || null, credits || null, theory_hours || 0, category || null]);
  } catch (e) {
    return insertError(res, e, 'That subject_code already exists', 'Could not create subject: invalid values');
  }
  await logAudit({ userId: req.user.id, action: 'subject_created', entityId: subject.id, ip: req.ip });
  res.json(subject);
});

router.post('/sessions', requireAuth, requireRole('admin'), async (req, res) => {
  const { label, start_date, end_date, status } = req.body || {};
  if (!label) return res.status(400).json({ error: 'label is required (e.g. "2027-2028")' });
  let session;
  try {
    session = await get(`
      INSERT INTO academic_sessions (label, start_date, end_date, status) VALUES ($1, $2, $3, $4) RETURNING *
    `, [label, start_date || null, end_date || null, status || 'upcoming']);
  } catch (e) {
    return insertError(res, e, 'That session label already exists', 'Could not create session: invalid values');
  }
  await logAudit({ userId: req.user.id, action: 'academic_session_created', entityId: session.id, ip: req.ip });
  res.json(session);
});

router.post('/course-offerings', requireAuth, requireRole('admin', 'hod'), async (req, res) => {
  const { subject_id, program_id, academic_session_id, semester, offering_code } = req.body || {};
  if (!subject_id || !program_id || !academic_session_id || !semester) {
    return res.status(400).json({ error: 'subject_id, program_id, academic_session_id, and semester are required' });
  }
  const p = await programContext(program_id);
  if (!p || !p.is_active) return res.status(400).json({ error: 'program_id must be an active program' });
  const a = await checkAcademic(req.user, 'structure', p, 'program', p.program_id);
  if (!a.allowed) return res.status(403).json({ error: a.reason });
  const subject = isUuid(subject_id) ? await get('SELECT id FROM subjects WHERE id = $1 AND is_active', [subject_id]) : null;
  if (!subject) return res.status(400).json({ error: 'subject_id must be an active subject' });
  const session = isUuid(academic_session_id) ? await get('SELECT id FROM academic_sessions WHERE id = $1', [academic_session_id]) : null;
  if (!session) return res.status(400).json({ error: 'academic_session_id must be an existing academic session' });
  let offering;
  try {
    offering = await get(`
      INSERT INTO course_offerings (subject_id, program_id, academic_session_id, semester, offering_code, status)
      VALUES ($1, $2, $3, $4, $5, 'active') RETURNING *
    `, [subject.id, p.program_id, session.id, semester, offering_code || null]);
  } catch (e) {
    return insertError(res, e, 'This course offering already exists (subject, program, session and semester)', 'Could not create course offering: invalid values');
  }
  await logAudit({ userId: req.user.id, action: 'course_offering_created', entityId: offering.id, details: { program_id: p.program_id }, ip: req.ip });
  res.json(offering);
});

router.post('/sections', requireAuth, requireRole('admin', 'hod'), async (req, res) => {
  const { course_offering_id, name, code } = req.body || {};
  if (!course_offering_id || !name) return res.status(400).json({ error: 'course_offering_id and name are required' });
  const ctx = await guardOffering(req, res, course_offering_id, 'structure');
  if (!ctx) return;
  let section;
  try {
    section = await get('INSERT INTO sections (course_offering_id, name, code) VALUES ($1, $2, $3) RETURNING *',
      [ctx.course_offering_id, name, code || null]);
  } catch (e) {
    return insertError(res, e, 'A section with that name already exists for this offering', 'Could not create section: invalid values');
  }
  await logAudit({ userId: req.user.id, action: 'section_created', entityId: section.id, ip: req.ip });
  res.json(section);
});

// ============ WRITE: assignments (the HOD's staffing decisions; spec §2, §12) ============

router.get('/assignments/teacher', requireAuth, requireRole('hod'), async (req, res) => {
  const { course_offering_id } = req.query;
  if (!course_offering_id) return res.status(400).json({ error: 'course_offering_id is required' });
  const ctx = await guardOffering(req, res, String(course_offering_id), 'manage');
  if (!ctx) return;
  res.json(await all(`
    SELECT tca.*, u.email as teacher_email, s.name as section_name
    FROM teacher_course_assignments tca
    JOIN users u ON u.id = tca.teacher_id
    LEFT JOIN sections s ON s.id = tca.section_id
    WHERE tca.course_offering_id = $1 ORDER BY tca.created_at DESC
  `, [ctx.course_offering_id]));
});

// Assigning a teacher grants teacher scope on the offering (data access to its question bank), so it is the
// HOD's decision: the offering and the teacher's home department must both be inside the HOD's scope, the
// teacher must be active, and a section must be an active section of this offering.
router.post('/assignments/teacher', requireAuth, requireRole('hod'), async (req, res) => {
  const { teacher_id, course_offering_id, section_id, assignment_role } = req.body || {};
  if (!teacher_id || !course_offering_id) return res.status(400).json({ error: 'teacher_id and course_offering_id are required' });
  const ctx = await guardOffering(req, res, course_offering_id, 'manage');
  if (!ctx) return;
  const teacher = isUuid(teacher_id) ? await get("SELECT * FROM users WHERE id = $1 AND role = 'teacher'", [teacher_id]) : null;
  if (!teacher) return res.status(404).json({ error: 'Teacher not found' });
  if (!teacher.is_active) return res.status(400).json({ error: 'Teacher is not active' });
  const home = await checkAcademic(req.user, 'manage', { campus_id: teacher.campus_id, department_id: teacher.department_id }, 'user', teacher.id);
  if (!home.allowed) return res.status(403).json({ error: 'That teacher is outside your department' });
  if (section_id) {
    const sec = isUuid(section_id)
      ? await get('SELECT id FROM sections WHERE id = $1 AND course_offering_id = $2 AND is_active', [section_id, ctx.course_offering_id]) : null;
    if (!sec) return res.status(400).json({ error: 'That section does not belong to this course offering (or is inactive)' });
  }
  let assignment;
  try {
    assignment = await get(`
      INSERT INTO teacher_course_assignments (teacher_id, course_offering_id, section_id, assignment_role)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [teacher.id, ctx.course_offering_id, section_id || null, assignment_role || 'instructor']);
  } catch (e) {
    return insertError(res, e, 'That assignment already exists', 'Could not create assignment: invalid values');
  }
  await grantScope({ userId: teacher.id, role: 'teacher', campusId: ctx.campus_id, departmentId: ctx.department_id, programId: ctx.program_id, courseOfferingId: ctx.course_offering_id, grantedBy: req.user.id });
  await logAudit({ userId: req.user.id, action: 'teacher_assigned', entityId: assignment.id, details: { teacher_id: teacher.id, course_offering_id: ctx.course_offering_id, section_id: section_id || null }, ip: req.ip });
  await notify(teacher.id, 'course_assigned', 'You have been assigned to a new course offering.', ctx.course_offering_id);
  res.json(assignment);
});

// Ending an assignment also ends the teacher scope it granted (unless another active assignment to the same
// offering remains), in the same transaction, audited with the revoked scope ids.
router.post('/assignments/teacher/:id/deactivate', requireAuth, requireRole('hod'), async (req, res) => {
  const g = await guardObject(req, res, 'teacher_assignment', req.params.id, 'manage');
  if (!g) return;
  const out = await withTransaction(async (txn) => {
    const upd = await txn.get('UPDATE teacher_course_assignments SET is_active = FALSE, updated_at = now() WHERE id = $1 AND is_active RETURNING id', [g.row.id]);
    if (!upd) return null;
    const other = await txn.get('SELECT 1 AS x FROM teacher_course_assignments WHERE teacher_id = $1 AND course_offering_id = $2 AND is_active', [g.row.teacher_id, g.ctx.course_offering_id]);
    const revoked = other ? [] : await revokeAssignmentScope({ userId: g.row.teacher_id, role: 'teacher', campusId: g.ctx.campus_id,
      departmentId: g.ctx.department_id, programId: g.ctx.program_id, courseOfferingId: g.ctx.course_offering_id, by: req.user.id }, txn);
    await logAudit({ userId: req.user.id, action: 'teacher_unassigned', entityId: g.row.id, ip: req.ip,
      details: { teacher_id: g.row.teacher_id, course_offering_id: g.ctx.course_offering_id, scopes_revoked: revoked.map((r) => r.id), reason: 'assignment_deactivated' } }, txn);
    return { revoked };
  });
  if (!out) return res.status(409).json({ error: 'That assignment is already inactive' });
  res.json({ ok: true, scopes_revoked: out.revoked.length });
});

router.get('/assignments/reviewer', requireAuth, requireRole('hod'), async (req, res) => {
  const { course_offering_id } = req.query;
  if (!course_offering_id) return res.status(400).json({ error: 'course_offering_id is required' });
  const ctx = await guardOffering(req, res, String(course_offering_id), 'manage');
  if (!ctx) return;
  res.json(await all(`
    SELECT ra.*, u.email as reviewer_email
    FROM reviewer_assignments ra JOIN users u ON u.id = ra.reviewer_id
    WHERE ra.course_offering_id = $1 ORDER BY ra.created_at DESC
  `, [ctx.course_offering_id]));
});

router.post('/assignments/reviewer', requireAuth, requireRole('hod'), async (req, res) => {
  const { reviewer_id, course_offering_id } = req.body || {};
  if (!reviewer_id || !course_offering_id) return res.status(400).json({ error: 'reviewer_id and course_offering_id are required' });
  const ctx = await guardOffering(req, res, course_offering_id, 'manage');
  if (!ctx) return;
  const reviewer = isUuid(reviewer_id) ? await get("SELECT * FROM users WHERE id = $1 AND role = 'reviewer'", [reviewer_id]) : null;
  if (!reviewer) return res.status(404).json({ error: 'Reviewer not found' });
  if (!reviewer.is_active) return res.status(400).json({ error: 'Reviewer is not active' });
  // Optional institutional rule (spec 12): reviewer cannot review a course they currently teach.
  if (process.env.REVIEWER_CANNOT_TEACH_OFFERING === 'true') {
    const teaches = await get('SELECT 1 AS x FROM teacher_course_assignments WHERE teacher_id = $1 AND course_offering_id = $2 AND is_active', [reviewer.id, ctx.course_offering_id]);
    if (teaches) return res.status(400).json({ error: 'Reviewer currently teaches this course offering' });
  }
  const home = await checkAcademic(req.user, 'manage', { campus_id: reviewer.campus_id, department_id: reviewer.department_id }, 'user', reviewer.id);
  if (!home.allowed) return res.status(403).json({ error: 'That reviewer is outside your department' });
  let assignment;
  try {
    assignment = await get(`
      INSERT INTO reviewer_assignments (reviewer_id, course_offering_id, assigned_by) VALUES ($1, $2, $3) RETURNING *
    `, [reviewer.id, ctx.course_offering_id, req.user.id]);
  } catch (e) {
    return insertError(res, e, 'That reviewer is already assigned to this course offering', 'Could not create assignment: invalid values');
  }
  await grantScope({ userId: reviewer.id, role: 'reviewer', campusId: ctx.campus_id, departmentId: ctx.department_id, programId: ctx.program_id, grantedBy: req.user.id });
  await logAudit({ userId: req.user.id, action: 'reviewer_assigned', entityId: assignment.id, details: { reviewer_id: reviewer.id, course_offering_id: ctx.course_offering_id }, ip: req.ip });
  await notify(reviewer.id, 'reviewer_assigned', 'You have been assigned to review a new course offering.', ctx.course_offering_id);
  res.json(assignment);
});

// The reviewer's program-level scope is revoked once no active assignment in that program remains. Seats on
// open review batches stop working at once (authorization.js reviewerSeat checks the assignment); the HOD
// replaces the reviewer there through /review/batches/:id/reassign.
router.post('/assignments/reviewer/:id/deactivate', requireAuth, requireRole('hod'), async (req, res) => {
  const g = await guardObject(req, res, 'reviewer_assignment', req.params.id, 'manage');
  if (!g) return;
  const out = await withTransaction(async (txn) => {
    const upd = await txn.get('UPDATE reviewer_assignments SET is_active = FALSE WHERE id = $1 AND is_active RETURNING id', [g.row.id]);
    if (!upd) return null;
    const revoked = await revokeAssignmentScope({ userId: g.row.reviewer_id, role: 'reviewer', campusId: g.ctx.campus_id,
      departmentId: g.ctx.department_id, programId: g.ctx.program_id, by: req.user.id }, txn);
    await logAudit({ userId: req.user.id, action: 'reviewer_unassigned', entityId: g.row.id, ip: req.ip,
      details: { reviewer_id: g.row.reviewer_id, course_offering_id: g.ctx.course_offering_id, scopes_revoked: revoked.map((r) => r.id), reason: 'assignment_deactivated' } }, txn);
    return { revoked };
  });
  if (!out) return res.status(409).json({ error: 'That assignment is already inactive' });
  res.json({ ok: true, scopes_revoked: out.revoked.length });
});

// ============ Syllabus versioning ============
// Lifecycle (migration 042, src/syllabus-versioning.js): DRAFT -> TEACHER_VERIFIED -> HOD_REVIEW -> ACTIVE -> SUPERSEDED,
// REJECTED from any state before ACTIVE (with a reason), and a reasoned return to DRAFT from TEACHER_VERIFIED or
// HOD_REVIEW. The DB guard checks every transition; these routes add who may take it:
//   create, verify, submit for review  the HOD in scope, or a teacher assigned to the offering (verify / submit:
//                                      only the teacher who created the version);
//   return to draft, approve, reject   the HOD in scope (admin is technical-only, spec §2).
// Content is entered as structured units/topics/subtopics/COs by the HOD while the version is DRAFT; there is no AI
// extraction pipeline in this build (extraction_status stays 'pending'). A new version is usually started from the
// current one (routes/syllabus-changes.js 'from-current'), which copies its content forward as a DRAFT.
// Approving (activation) supersedes the previous version and runs change detection in the same transaction.

router.get('/syllabus-versions', requireAuth, requireRole('hod', 'teacher'), async (req, res) => {
  const { course_offering_id } = req.query;
  if (!course_offering_id) return res.status(400).json({ error: 'course_offering_id is required' });
  const ctx = await guardOffering(req, res, String(course_offering_id), 'view');
  if (!ctx) return;
  const rows = await all(`
    SELECT sv.*, uu.email as uploaded_by_email, vu.email as verified_by_email, au.email as approved_by_email,
      (SELECT COUNT(*)::int FROM syllabus_changes sc WHERE sc.new_version_id = sv.id) AS change_count
    FROM syllabus_versions sv
    LEFT JOIN users uu ON uu.id = sv.uploaded_by
    LEFT JOIN users vu ON vu.id = sv.verified_by
    LEFT JOIN users au ON au.id = sv.approved_by
    WHERE sv.course_offering_id = $1
    ORDER BY sv.version_number DESC
  `, [ctx.course_offering_id]);
  res.json(rows);
});

// The official syllabus is the HOD's: only the HOD in scope creates a version (by entering it, or by uploading the
// PDF, routes/syllabus-upload.js). Teachers and reviewers read it; they cannot create, replace or publish it.
router.post('/syllabus-versions', requireAuth, requireRole('hod'), async (req, res) => {
  const { course_offering_id, extracted_units, notes } = req.body || {};
  if (!course_offering_id) return res.status(400).json({ error: 'course_offering_id is required' });
  const ctx = await guardOffering(req, res, course_offering_id, 'manage');
  if (!ctx) return;
  if (!extracted_units && !notes) {
    return res.status(400).json({ error: 'Provide the syllabus content as extracted_units (structured) or notes (free text)' });
  }
  if (notes != null && String(notes).length > 20000) return res.status(400).json({ error: 'notes is at most 20000 characters' });

  const lastVersion = await get(`
    SELECT COALESCE(MAX(version_number), 0) as v FROM syllabus_versions WHERE course_offering_id = $1
  `, [ctx.course_offering_id]);
  let version;
  try {
    version = await get(`
      INSERT INTO syllabus_versions (course_offering_id, version_number, extracted_units, uploaded_by, extraction_status, verification_status, approval_status, status)
      VALUES ($1, $2, $3, $4, 'pending', 'pending', 'pending', 'DRAFT') RETURNING *
    `, [ctx.course_offering_id, lastVersion.v + 1, JSON.stringify({ notes: notes || null, units: extracted_units || null }), req.user.id]);
  } catch (e) {
    // UNIQUE (course_offering_id, version_number): another version was created at the same moment.
    return insertError(res, e, 'Another syllabus version was created for this offering at the same time; reload and try again', 'Could not create the syllabus version: invalid values');
  }

  await logAudit({ userId: req.user.id, action: 'syllabus_version_created', entityId: version.id, details: { course_offering_id: ctx.course_offering_id, version_number: version.version_number, status: 'DRAFT' }, ip: req.ip });
  res.json(version);
});

// One status move of a version, conditional on the state it was checked in (a concurrent move gets 409). The DB guard
// re-checks the transition and its preconditions; its message is safe to show.
const VERSION_REFUSAL = /Invalid syllabus version transition|is incomplete|needs a reason|must record|approved by an active HOD|already has an ACTIVE/;
async function moveVersion(res, version, from, sets, params) {
  try {
    const upd = await run(`UPDATE syllabus_versions SET ${sets}, updated_at = now() WHERE id = $1 AND status = $2 RETURNING id`, [version.id, from, ...params]);
    if (upd.rowCount !== 1) { res.status(409).json({ error: 'This syllabus version changed meanwhile; reload and try again' }); return false; }
    return true;
  } catch (e) {
    if (VERSION_REFUSAL.test(String(e.message))) { res.status(400).json({ error: e.message }); return false; }
    throw e;
  }
}

async function contentProblems(versionId) {
  return (await get('SELECT syllabus_version_content_problems($1) AS problems', [versionId]))?.problems || [];
}

// Verify (DRAFT -> TEACHER_VERIFIED): the HOD in scope confirms the extracted/entered content (units with topics,
// COs) against the official document. (The status name predates HOD-only syllabus governance.)
router.post('/syllabus-versions/:id/verify', requireAuth, requireRole('hod'), async (req, res) => {
  const g = await guardObject(req, res, 'version', req.params.id, 'manage');
  if (!g) return;
  const version = g.row;
  if (version.status !== 'DRAFT') return res.status(409).json({ error: `Only a DRAFT version can be verified (this one is ${version.status})` });
  const problems = await contentProblems(version.id);
  if (problems.length) return res.status(400).json({ error: `This version cannot be verified yet: it needs ${problems.join(' and ')}`, problems });
  if (!(await moveVersion(res, version, 'DRAFT', "status = 'TEACHER_VERIFIED', verified_by = $3", [req.user.id]))) return;
  await logAudit({ userId: req.user.id, action: 'syllabus_version_verified', entityId: version.id, details: { from: 'DRAFT', to: 'TEACHER_VERIFIED' }, ip: req.ip });
  res.json({ ok: true, status: 'TEACHER_VERIFIED' });
});

// Submit for HOD review (TEACHER_VERIFIED -> HOD_REVIEW): the same people who may verify.
router.post('/syllabus-versions/:id/submit-review', requireAuth, requireRole('hod'), async (req, res) => {
  const g = await guardObject(req, res, 'version', req.params.id, 'manage');
  if (!g) return;
  const version = g.row;
  if (version.status !== 'TEACHER_VERIFIED') return res.status(409).json({ error: `Only a teacher-verified version can go to HOD review (this one is ${version.status})` });
  if (!(await moveVersion(res, version, 'TEACHER_VERIFIED', "status = 'HOD_REVIEW', submitted_for_review_by = $3", [req.user.id]))) return;
  await logAudit({ userId: req.user.id, action: 'syllabus_version_submitted_for_review', entityId: version.id, details: { from: 'TEACHER_VERIFIED', to: 'HOD_REVIEW' }, ip: req.ip });
  res.json({ ok: true, status: 'HOD_REVIEW' });
});

// Return to draft for corrections (TEACHER_VERIFIED / HOD_REVIEW -> DRAFT): the HOD, with a reason. Verification is
// cleared; the creator is notified.
router.post('/syllabus-versions/:id/return', requireAuth, requireRole('hod'), async (req, res) => {
  const reason = String(req.body?.reason || '').trim();
  const g = await guardObject(req, res, 'version', req.params.id, 'manage');
  if (!g) return;
  const version = g.row;
  if (!['TEACHER_VERIFIED', 'HOD_REVIEW'].includes(version.status)) {
    return res.status(409).json({ error: `Only a verified version or one in HOD review can be returned to draft (this one is ${version.status})` });
  }
  if (reason.length < 3 || reason.length > 1000) return res.status(400).json({ error: 'A reason (3 to 1000 characters) is required to return a version to draft' });
  if (!(await moveVersion(res, version, version.status, "status = 'DRAFT', returned_reason = $3", [reason]))) return;
  await logAudit({ userId: req.user.id, action: 'syllabus_version_returned', entityId: version.id, details: { from: version.status, to: 'DRAFT', reason }, ip: req.ip });
  if (version.uploaded_by && version.uploaded_by !== req.user.id) {
    await notify(version.uploaded_by, 'syllabus_returned', `Syllabus version ${version.version_number} was returned to draft: ${reason}`, version.id);
  }
  res.json({ ok: true, status: 'DRAFT' });
});

// Approving a syllabus version is the HOD's academic decision (spec §2). Only a version in HOD review (teacher-verified
// and submitted) with at least one active unit with a topic and one active CO is approved. Activation, superseding the
// previous version, change detection and every question move are one transaction (src/syllabus-versioning.js).
// The scope check runs before the status check, so an out-of-scope HOD learns nothing about the version.
router.post('/syllabus-versions/:id/approve', requireAuth, requireRole('hod'), async (req, res) => {
  const g = await guardObject(req, res, 'version', req.params.id, 'manage');
  if (!g) return;
  const version = g.row;
  if (version.status === 'TEACHER_VERIFIED' || version.status === 'DRAFT') {
    return res.status(400).json({ error: version.status === 'DRAFT'
      ? 'This version must be teacher-verified and submitted for HOD review before it can be approved'
      : 'This teacher-verified version must be submitted for HOD review before it can be approved' });
  }
  // Only a version in HOD review is approved. Re-approving the current version would re-run change detection;
  // re-approving a superseded one would make an old syllabus current. A new version is the way to change the syllabus.
  if (version.status !== 'HOD_REVIEW') {
    return res.status(409).json({ error: `Only a syllabus version in HOD review can be approved (this one is ${version.status}); start a new version to change the syllabus` });
  }
  const problems = await contentProblems(version.id);
  if (problems.length) return res.status(400).json({ error: `This version cannot be approved yet: it needs ${problems.join(' and ')}`, problems });

  let out;
  try {
    out = await withTransaction((txn) => activateSyllabusVersion(txn, { versionId: version.id, actor: req.user, ip: req.ip, logAudit }));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    if (VERSION_REFUSAL.test(String(e.message))) return res.status(400).json({ error: e.message });
    throw e;
  }
  const { summary } = out;
  const n = out.version.version_number;
  const byAuthor = new Map();
  for (const q of [...summary.sent_back, ...summary.flagged]) byAuthor.set(q.submitted_by, (byAuthor.get(q.submitted_by) || 0) + 1);
  for (const [authorId, count] of byAuthor) {
    await notify(authorId, 'syllabus_changed', `Syllabus version ${n} of one of your course offerings is now active: ${count} of your question(s) map to changed syllabus items and need re-mapping.`, version.id);
  }
  if (summary.flagged.length || summary.sent_back.length) {
    const reviewers = await all('SELECT DISTINCT reviewer_id FROM reviewer_assignments WHERE course_offering_id = $1 AND is_active', [out.offeringId]);
    await notifyMany(reviewers.map((r) => r.reviewer_id), 'syllabus_changed',
      `Syllabus version ${n} is now active: ${summary.flagged.length + summary.sent_back.length} question(s) of the offering are affected by the changes.`, version.id);
  }
  res.json({
    ok: true, status: 'ACTIVE', previous_version_id: summary.previous_version_id,
    changes: summary.changes.length, questions_remapped: summary.remapped.length, questions_sent_back: summary.sent_back.length,
    questions_flagged: summary.flagged.length, questions_unmapped: summary.unmapped.length, questions_skipped: summary.skipped.length,
  });
});

// Reject (DRAFT / TEACHER_VERIFIED / HOD_REVIEW -> REJECTED): the HOD, with a reason. The ACTIVE version is never
// rejected (a new version replaces it); a superseded or rejected one is final.
router.post('/syllabus-versions/:id/reject', requireAuth, requireRole('hod'), async (req, res) => {
  const reason = String(req.body?.reason || '').trim();
  const g = await guardObject(req, res, 'version', req.params.id, 'manage');
  if (!g) return;
  const version = g.row;
  if (version.status === 'ACTIVE') return res.status(409).json({ error: 'The ACTIVE syllabus version cannot be rejected: approve a new version to replace it' });
  if (['SUPERSEDED', 'REJECTED'].includes(version.status)) return res.status(409).json({ error: `This syllabus version is already ${version.status}` });
  if (reason.length < 3 || reason.length > 1000) return res.status(400).json({ error: 'A reason (3 to 1000 characters) is required to reject a syllabus version' });
  if (!(await moveVersion(res, version, version.status, "status = 'REJECTED', rejected_by = $3, rejection_reason = $4", [req.user.id, reason]))) return;
  await logAudit({ userId: req.user.id, action: 'syllabus_version_rejected', entityId: version.id, details: { from: version.status, to: 'REJECTED', reason }, ip: req.ip });
  if (version.uploaded_by && version.uploaded_by !== req.user.id) {
    await notify(version.uploaded_by, 'syllabus_rejected', `Your syllabus submission was rejected: ${reason}`, version.id);
  }
  res.json({ ok: true, status: 'REJECTED' });
});

// ============ Course Outcomes (COs) ============
// COs belong to one syllabus version and are never rewritten when a later
// version changes them (spec section 8) — a new version gets its own CO
// rows. This is what question submissions and reviewer verification map
// against (question_course_outcomes, see canonical.js / questions.js).
// Reads: the offering's HOD, assigned teachers and assigned reviewers. Writes: the HOD, and only while the version is
// DRAFT (409 otherwise; trg_guard_syllabus_content, migration 042, enforces the same in the database).

router.get('/syllabus-versions/:id/course-outcomes', requireAuth, requireRole('hod', 'teacher', 'reviewer'), async (req, res) => {
  const g = await guardObject(req, res, 'version', req.params.id, 'view');
  if (!g) return;
  res.json(await all(`
    SELECT * FROM course_outcomes WHERE syllabus_version_id = $1 AND is_active = TRUE ORDER BY sequence, code
  `, [g.row.id]));
});

// Convenience lookup for the question-submission form: "give me the COs for
// whichever syllabus version is currently active on this course offering",
// so a teacher never has to know the syllabus_version_id directly.
router.get('/course-offerings/:id/course-outcomes', requireAuth, requireRole('hod', 'teacher', 'reviewer'), async (req, res) => {
  const ctx = await guardOffering(req, res, req.params.id, 'view');
  if (!ctx) return;
  if (!ctx.syllabus_version_id) return res.json([]);
  res.json(await all(`
    SELECT * FROM course_outcomes WHERE syllabus_version_id = $1 AND is_active = TRUE ORDER BY sequence, code
  `, [ctx.syllabus_version_id]));
});

router.post('/syllabus-versions/:id/course-outcomes', requireAuth, requireRole('hod'), async (req, res) => {
  const { code, description, sequence } = req.body || {};
  if (!code || !description) return res.status(400).json({ error: 'code and description are required' });
  const g = await guardObject(req, res, 'version', req.params.id, 'manage');
  if (!g) return;
  if (!draftOnly(res, g.row.status, g.row.version_number)) return;
  let co;
  try {
    co = await get(`
      INSERT INTO course_outcomes (syllabus_version_id, code, description, sequence)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [g.row.id, code, description, Number(sequence) || 0]);
  } catch (e) {
    return insertError(res, e, 'That CO code already exists for this syllabus version', 'Could not create CO: invalid values');
  }
  await logAudit({ userId: req.user.id, action: 'course_outcome_created', entityId: co.id, details: { code }, ip: req.ip });
  res.json(co);
});

router.post('/course-outcomes/:id/deactivate', requireAuth, requireRole('hod'), async (req, res) => {
  const g = await guardObject(req, res, 'course_outcome', req.params.id, 'manage');
  if (!g) return;
  if (!draftOnly(res, g.row.version_status, g.row.version_number)) return;
  await run('UPDATE course_outcomes SET is_active = FALSE, updated_at = now() WHERE id = $1', [g.row.id]);
  await logAudit({ userId: req.user.id, action: 'course_outcome_deactivated', entityId: g.row.id, ip: req.ip });
  res.json({ ok: true });
});

// ============ Syllabus Units & Topics ============
// Same pattern and same authority rules as Course Outcomes above: scoped
// to one syllabus version, never rewritten by a later version. Units
// contain topics; a topic is only ever meaningful in the context of its
// own unit, so topic lookups are always scoped by syllabus_unit_id, never
// fetched as a flat global list.

router.get('/syllabus-versions/:id/units', requireAuth, requireRole('hod', 'teacher', 'reviewer'), async (req, res) => {
  const g = await guardObject(req, res, 'version', req.params.id, 'view');
  if (!g) return;
  res.json(await all(`
    SELECT * FROM syllabus_units WHERE syllabus_version_id = $1 AND is_active = TRUE ORDER BY sequence, code
  `, [g.row.id]));
});

// Convenience lookup mirroring /course-offerings/:id/course-outcomes — "give
// me the units for whichever syllabus version is active on this offering".
router.get('/course-offerings/:id/units', requireAuth, requireRole('hod', 'teacher', 'reviewer'), async (req, res) => {
  const ctx = await guardOffering(req, res, req.params.id, 'view');
  if (!ctx) return;
  if (!ctx.syllabus_version_id) return res.json([]);
  res.json(await all(`
    SELECT * FROM syllabus_units WHERE syllabus_version_id = $1 AND is_active = TRUE ORDER BY sequence, code
  `, [ctx.syllabus_version_id]));
});

router.get('/units/:id/topics', requireAuth, requireRole('hod', 'teacher', 'reviewer'), async (req, res) => {
  const g = await guardObject(req, res, 'unit', req.params.id, 'view');
  if (!g) return;
  res.json(await all(`
    SELECT * FROM syllabus_topics WHERE syllabus_unit_id = $1 AND is_active = TRUE ORDER BY sequence, title
  `, [g.row.id]));
});

// Syllabus content is academic work (spec §2: Admin is technical-only), so units, topics and subtopics
// are written by the HOD of the offering's department only, and every write is scope-checked.
router.post('/syllabus-versions/:id/units', requireAuth, requireRole('hod'), async (req, res) => {
  const { code, title, sequence } = req.body || {};
  if (!code || !title) return res.status(400).json({ error: 'code and title are required' });
  const g = await guardObject(req, res, 'version', req.params.id, 'manage');
  if (!g) return;
  if (!draftOnly(res, g.row.status, g.row.version_number)) return;
  let unit;
  try {
    unit = await get(`
      INSERT INTO syllabus_units (syllabus_version_id, code, title, sequence)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [g.row.id, code, title, Number(sequence) || 0]);
  } catch (e) {
    return insertError(res, e, 'That unit code already exists for this syllabus version', 'Could not create unit: invalid values');
  }
  await logAudit({ userId: req.user.id, action: 'syllabus_unit_created', entityId: unit.id, details: { code }, ip: req.ip });
  res.json(unit);
});

router.post('/units/:id/topics', requireAuth, requireRole('hod'), async (req, res) => {
  const { title, sequence } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title is required' });
  const g = await guardObject(req, res, 'unit', req.params.id, 'manage');
  if (!g) return;
  if (!draftOnly(res, g.row.version_status, g.row.version_number)) return;
  let topic;
  try {
    topic = await get(`
      INSERT INTO syllabus_topics (syllabus_unit_id, title, sequence)
      VALUES ($1, $2, $3) RETURNING *
    `, [g.row.id, title, Number(sequence) || 0]);
  } catch (e) {
    return insertError(res, e, 'That topic already exists under this unit', 'Could not create topic: invalid values');
  }
  await logAudit({ userId: req.user.id, action: 'syllabus_topic_created', entityId: topic.id, details: { title }, ip: req.ip });
  res.json(topic);
});

router.post('/units/:id/deactivate', requireAuth, requireRole('hod'), async (req, res) => {
  const g = await guardObject(req, res, 'unit', req.params.id, 'manage');
  if (!g) return;
  if (!draftOnly(res, g.row.version_status, g.row.version_number)) return;
  await run('UPDATE syllabus_units SET is_active = FALSE, updated_at = now() WHERE id = $1', [g.row.id]);
  await logAudit({ userId: req.user.id, action: 'syllabus_unit_deactivated', entityId: g.row.id, ip: req.ip });
  res.json({ ok: true });
});

router.post('/topics/:id/deactivate', requireAuth, requireRole('hod'), async (req, res) => {
  const g = await guardObject(req, res, 'topic', req.params.id, 'manage');
  if (!g) return;
  if (!draftOnly(res, g.row.version_status, g.row.version_number)) return;
  await run('UPDATE syllabus_topics SET is_active = FALSE, updated_at = now() WHERE id = $1', [g.row.id]);
  await logAudit({ userId: req.user.id, action: 'syllabus_topic_deactivated', entityId: g.row.id, ip: req.ip });
  res.json({ ok: true });
});

// ---- Subtopics (spec §3, §8): Unit -> Topic -> Subtopic ----
router.get('/topics/:id/subtopics', requireAuth, requireRole('hod', 'teacher', 'reviewer'), async (req, res) => {
  const g = await guardObject(req, res, 'topic', req.params.id, 'view');
  if (!g) return;
  res.json(await all('SELECT id, title, sort_order FROM syllabus_subtopics WHERE syllabus_topic_id = $1 AND is_active ORDER BY sort_order, title', [g.row.id]));
});

router.post('/topics/:id/subtopics', requireAuth, requireRole('hod'), async (req, res) => {
  const title = String(req.body?.title || '').trim();
  if (!title || title.length > 200) return res.status(400).json({ error: 'title is required (max 200 characters)' });
  const g = await guardObject(req, res, 'topic', req.params.id, 'manage');
  if (!g) return;
  if (!draftOnly(res, g.row.version_status, g.row.version_number)) return;
  let sub;
  try {
    sub = await get(`INSERT INTO syllabus_subtopics (syllabus_topic_id, title, sort_order, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
      [g.row.id, title, Number(req.body?.sort_order) || 0, req.user.id]);
  } catch (e) {
    return insertError(res, e, 'That subtopic already exists under this topic', 'Could not create subtopic: invalid values');
  }
  await logAudit({ userId: req.user.id, action: 'syllabus_subtopic_created', entityId: sub.id, details: { title, topic_id: g.row.id }, ip: req.ip });
  res.status(201).json(sub);
});

router.post('/subtopics/:id/deactivate', requireAuth, requireRole('hod'), async (req, res) => {
  const g = await guardObject(req, res, 'subtopic', req.params.id, 'manage');
  if (!g) return;
  if (!draftOnly(res, g.row.version_status, g.row.version_number)) return;
  await run('UPDATE syllabus_subtopics SET is_active = FALSE WHERE id = $1', [g.row.id]);
  await logAudit({ userId: req.user.id, action: 'syllabus_subtopic_deactivated', entityId: g.row.id, ip: req.ip });
  res.json({ ok: true });
});

// A reviewer verifying a question's unit/topic needs to know "given this
// question's course offering, which unit does this topic actually belong
// to" so the backend can validate the pair rather than trust two
// independently-supplied IDs. Used by review-batches.js's verdict/resolve
// endpoints — "Unit/Topic must come from valid syllabus relationships,
// enforced on the backend too" (spec section 3). syllabusVersionId: the question's own version (a question is
// verified against the syllabus it was written for); defaults to the offering's current version.
// subtopicId (optional) must be an active subtopic of the given topic (a subtopic needs its topic).
export async function validateUnitTopicPair(courseOfferingId, unitId, topicId, syllabusVersionId = null, subtopicId = null) {
  if (!unitId && !topicId && !subtopicId) return { valid: true };
  if ((unitId && !isUuid(unitId)) || (topicId && !isUuid(topicId)) || (subtopicId && !isUuid(subtopicId))) return { valid: false, error: 'Unit/topic/subtopic id is malformed' };
  if (subtopicId && !topicId) return { valid: false, error: 'A subtopic is verified together with its topic' };
  let versionId = syllabusVersionId;
  if (!versionId) {
    const offering = await get('SELECT syllabus_version_id FROM course_offerings WHERE id = $1', [courseOfferingId]);
    versionId = offering?.syllabus_version_id;
  }
  if (!versionId) return { valid: false, error: 'This course offering has no active syllabus version' };
  if (unitId) {
    const unit = await get('SELECT id FROM syllabus_units WHERE id = $1 AND syllabus_version_id = $2 AND is_active = TRUE', [unitId, versionId]);
    if (!unit) return { valid: false, error: 'That unit does not belong to this question\'s syllabus version' };
  }
  if (topicId) {
    const topic = await get(`
      SELECT t.id FROM syllabus_topics t JOIN syllabus_units u ON u.id = t.syllabus_unit_id
      WHERE t.id = $1 AND u.syllabus_version_id = $2 AND t.is_active = TRUE
        AND ($3::uuid IS NULL OR t.syllabus_unit_id = $3)
    `, [topicId, versionId, unitId || null]);
    if (!topic) return { valid: false, error: 'That topic does not belong to the given unit/syllabus version' };
  }
  if (subtopicId) {
    const sub = await get('SELECT id FROM syllabus_subtopics WHERE id = $1 AND syllabus_topic_id = $2 AND is_active', [subtopicId, topicId]);
    if (!sub) return { valid: false, error: 'That subtopic does not belong to the given topic' };
  }
  return { valid: true };
}

// ============ User account management ============
// Moved to routes/users.js (mounted at /api/academic/users, before this router): provisioning with scopes and
// out-of-band invitations, deactivation that revokes scopes and sessions, reactivation and role change.

// ============ Previous-year paper management ============
// This is what actually powers the "never repeat last year's question"
// constraint — before this phase, the only way to populate it was hand-editing
// seed.js. Previous-year papers are academic data of the offering's department, so only its HOD manages
// them (spec §2: admin is technical-only).
// Subject-wide rows (course_offering_id NULL, from legacy/seed data) apply to every offering of the subject: they
// are listed read-only (subject_wide) and can be removed only by an HOD whose scope covers every offering of the
// subject, so one department never deletes another department's data.

router.get('/previous-year-papers', requireAuth, requireRole('hod'), async (req, res) => {
  const { course_offering_id } = req.query;
  if (!course_offering_id) return res.status(400).json({ error: 'course_offering_id is required' });
  const ctx = await guardOffering(req, res, String(course_offering_id), 'manage');
  if (!ctx) return;
  const rows = await all(`
    SELECT p.*, (p.course_offering_id IS NULL) AS subject_wide, u.email as added_by_email FROM previous_year_papers p
    LEFT JOIN users u ON u.id = p.added_by
    WHERE p.course_offering_id = $1 OR (p.course_offering_id IS NULL AND p.subject_id = $2)
    ORDER BY p.year DESC NULLS LAST, p.created_at DESC
  `, [ctx.course_offering_id, ctx.subject_id]);
  res.json(rows);
});

// Accepts a batch of question texts pasted in at once (one per line in the
// UI) — this is how a real previous-year paper gets entered: a handful to a
// few dozen questions in one go, not one at a time.
router.post('/previous-year-papers', requireAuth, requireRole('hod'), async (req, res) => {
  const { course_offering_id, year, questions } = req.body || {};
  if (!course_offering_id || !year || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'course_offering_id, year, and a non-empty questions array are required' });
  }
  const ctx = await guardOffering(req, res, course_offering_id, 'manage');
  if (!ctx) return;

  let added = 0;
  let skippedDuplicates = 0;
  for (const rawText of questions) {
    const text = String(rawText || '').trim();
    if (!text) continue;
    const hash = normalizeQuestionHash(text);
    const existing = await get(`
      SELECT id FROM previous_year_papers WHERE course_offering_id = $1 AND question_hash = $2
    `, [ctx.course_offering_id, hash]);
    if (existing) { skippedDuplicates++; continue; }
    await run(`
      INSERT INTO previous_year_papers (subject_id, course_offering_id, year, question_hash, question_text, added_by)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [ctx.subject_id, ctx.course_offering_id, Number(year), hash, text, req.user.id]);
    added++;
  }

  await logAudit({ userId: req.user.id, action: 'previous_year_papers_added', entityId: ctx.course_offering_id, details: { year, added, skippedDuplicates }, ip: req.ip });
  res.json({ added, skippedDuplicates, total_submitted: questions.length });
});

router.delete('/previous-year-papers/:id', requireAuth, requireRole('hod'), async (req, res) => {
  const entry = isUuid(req.params.id) ? await get('SELECT * FROM previous_year_papers WHERE id = $1', [req.params.id]) : null;
  if (!entry) return res.status(404).json({ error: 'Not found' });
  if (entry.course_offering_id) {
    if (!(await guardOffering(req, res, entry.course_offering_id, 'manage'))) return;
  } else {
    const c = await get(`
      SELECT COUNT(*) FILTER (WHERE user_has_scope($2, 'hod', co.campus_id, p.department_id, NULL, NULL))::int AS in_scope,
             COUNT(*) FILTER (WHERE NOT user_has_scope($2, 'hod', co.campus_id, p.department_id, NULL, NULL))::int AS out_of_scope
      FROM course_offerings co JOIN programs p ON p.id = co.program_id WHERE co.subject_id = $1`, [entry.subject_id, req.user.id]);
    if (!c?.in_scope || c.out_of_scope) {
      return res.status(403).json({ error: 'This subject-wide entry also applies to course offerings outside your department/campus' });
    }
  }
  await run('DELETE FROM previous_year_papers WHERE id = $1', [entry.id]);
  await logAudit({ userId: req.user.id, action: 'previous_year_paper_removed', entityId: entry.id, ip: req.ip,
    details: { course_offering_id: entry.course_offering_id || null, subject_id: entry.subject_id || null, subject_wide: !entry.course_offering_id } });
  res.json({ ok: true });
});

export default router;
