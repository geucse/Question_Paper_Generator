// Shared setup for route tests (no database). Run: node --import ./test/register.mjs --test test/
import './env.mjs';
import { sql, resetRules, log } from './mock-db.mjs';
import { signJwt } from '../src/auth.js';
import { setTransportForTests } from '../src/otp-delivery.js';

// Every email the server sends (login codes, reset and setup codes, security notices) lands here instead of SMTP.
// mailControl.fail = true makes the next sends fail like an unreachable mail server.
export const mail = [];
export const mailControl = { fail: false };
setTransportForTests({
  sendMail: async (m) => {
    if (mailControl.fail) throw Object.assign(new Error('connect ECONNREFUSED smtp.test'), { code: 'ECONNECTION' });
    mail.push(m);
    return { messageId: `m${mail.length}` };
  },
  verify: async () => !mailControl.fail,
});

export { sql, log };
export const IDS = {
  campusA: 'c0000000-0000-0000-0000-00000000000a', campusB: 'c0000000-0000-0000-0000-00000000000b',
  dept: 'd0000000-0000-0000-0000-000000000001', prog: 'f0000000-0000-0000-0000-000000000001',
  off: 'a0000000-0000-0000-0000-000000000001', sv: 'b0000000-0000-0000-0000-000000000001',
  subj: 'e0000000-0000-0000-0000-000000000001',
};
// Phase 3: a second department on campus A (A2) and a second campus (B1), so every scope rule is tested against
// a same-campus other department AND another campus (IDOR matrix, test/academic-scope.test.mjs, test/idor.test.mjs).
Object.assign(IDS, {
  subjA2: 'e0000000-0000-0000-0000-0000000000a2',
  deptA2: 'd0000000-0000-0000-0000-0000000000a2', progA2: 'f0000000-0000-0000-0000-0000000000a2',
  offA2: 'a0000000-0000-0000-0000-0000000000a2', svA2: 'b0000000-0000-0000-0000-0000000000a2',
  subjB: 'e0000000-0000-0000-0000-0000000000b1',
  deptB: 'd0000000-0000-0000-0000-0000000000b1', progB: 'f0000000-0000-0000-0000-0000000000b1',
  offB: 'a0000000-0000-0000-0000-0000000000b1', svB: 'b0000000-0000-0000-0000-0000000000b1',
});
const mk = (n, role) => ({ id: `0000000${n}-0000-0000-0000-000000000000`, email: `${role}${n}@t.edu`, role, is_active: true, status: 'ACTIVE', token_version: 0, must_change_password: false, access_deadline: null, department_id: IDS.dept, campus_id: IDS.campusA });
const at = (hex, role, department_id, campus_id) => ({ ...mk(0, role), id: `${hex}-0000-0000-0000-000000000000`, email: `${role}-${hex}@t.edu`, department_id, campus_id });
export const USERS = {
  teacher: mk(1, 'teacher'), reviewer: mk(2, 'reviewer'), hod: mk(3, 'hod'), coe: mk(4, 'coe'), admin: mk(5, 'admin'),
  v1: mk(6, 'validator'), v2: mk(7, 'validator'), v3: mk(8, 'validator'), v4: mk(9, 'validator'),
  teacherA2: at('a2000001', 'teacher', IDS.deptA2, IDS.campusA), reviewerA2: at('a2000002', 'reviewer', IDS.deptA2, IDS.campusA),
  hodA2: at('a2000003', 'hod', IDS.deptA2, IDS.campusA),
  teacherB: at('b1000001', 'teacher', IDS.deptB, IDS.campusB), reviewerB: at('b1000002', 'reviewer', IDS.deptB, IDS.campusB),
  hodB: at('b1000003', 'hod', IDS.deptB, IDS.campusB), coeB: at('b1000004', 'coe', null, IDS.campusB),
  vB: at('b1000006', 'validator', null, IDS.campusB),
};
// Academic context of each offering (the shape of scopes.js offeringContext). Also the default answer to that
// query in baseRules, so routes that resolve an offering work in tests that do not install the scope world.
export const OFFERINGS = {
  [IDS.off]: { course_offering_id: IDS.off, program_id: IDS.prog, campus_id: IDS.campusA, department_id: IDS.dept, subject_id: IDS.subj, syllabus_version_id: IDS.sv },
  [IDS.offA2]: { course_offering_id: IDS.offA2, program_id: IDS.progA2, campus_id: IDS.campusA, department_id: IDS.deptA2, subject_id: IDS.subjA2, syllabus_version_id: IDS.svA2 },
  [IDS.offB]: { course_offering_id: IDS.offB, program_id: IDS.progB, campus_id: IDS.campusB, department_id: IDS.deptB, subject_id: IDS.subjB, syllabus_version_id: IDS.svB },
};
export const tokenFor = (key) => signJwt({ sub: USERS[key].id, tv: 0 }, '1h');

export function baseRules() {
  resetRules();
  sql(/INSERT INTO (audit_log|authorization_log|request_log|suspicious_activity|notifications)/i, []);
  sql(/FROM (audit_log|blocked_ips|system_state|request_log|slow_query_log|suspicious_activity)/i, []);
  sql(/FROM users WHERE id = \$1$/i, (p) => [Object.values(USERS).find((u) => u.id === p[0])].filter(Boolean));
  sql(/user_has_scope/i, [{ has_scope: true }]);
  sql(/SELECT DISTINCT campus_id FROM user_scopes/i, [{ campus_id: IDS.campusA }]);
  // Every logAudit takes the audit-chain advisory lock (audit.js); generation also takes the offering lock.
  sql(/pg_advisory_xact_lock/i, []);
  sql(/FROM course_offerings co JOIN programs p ON p.id = co.program_id WHERE co.id = \$1/i, (p) => [OFFERINGS[p[0]]].filter(Boolean));
  // Files of a paper's questions (paper-attachments.js): none unless a test scripts them.
  sql(/FROM question_attachments a WHERE a.question_id = ANY\(\$1::uuid\[\]\)/i, []);
  // Health probes; TOTP step-up bookkeeping (totp.js): no recent failures, the step is consumed, the attempt logged.
  sql(/^SELECT 1$/, [{ '?column?': 1 }]);
  sql(/INSERT INTO step_up_auth_log/i, []);
  sql(/FROM step_up_auth_log/i, [{ n: 0 }]);
  sql(/^UPDATE users SET totp_last_used_step/i, [{ id: 'x' }]);
  sql(/^UPDATE users SET totp_reenroll_required = TRUE WHERE id = \$1/i, []);
  // TOTP key check (totp-key-check.js): recorded on first use, so it matches from then on.
  sql(/^INSERT INTO system_state \(key, value, updated_at\) VALUES \(\$1, \$2, now\(\)\) ON CONFLICT \(key\) DO NOTHING RETURNING value/i, (p) => [{ value: p[1] }]);
  // Question placement (migration 042, syllabus-versioning.js resolvePlacement): the offering's current version, its
  // topics and a topic's subtopics. Tests about placement script their own rows.
  sql(/^SELECT syllabus_version_id FROM course_offerings WHERE id = \$1$/i, (p) => [{ syllabus_version_id: OFFERINGS[p[0]]?.syllabus_version_id ?? IDS.sv }]);
  sql(/^SELECT t.id, t.title FROM syllabus_topics t JOIN syllabus_units u ON u.id = t.syllabus_unit_id WHERE u.syllabus_version_id = \$1 AND t.is_active AND u.is_active$/i,
    [{ id: PLACEMENT.topic, title: 'Trees' }]);
  sql(/^SELECT id, title FROM syllabus_subtopics WHERE syllabus_topic_id = \$1 AND is_active$/i, [{ id: PLACEMENT.subtopic, title: 'Rotations' }]);
  mail.length = 0; mailControl.fail = false;
}
// Default syllabus rows for question placement (baseRules): topic 'Trees' with subtopic 'Rotations'.
export const PLACEMENT = { topic: '22220000-0000-0000-0000-0000000000ff', subtopic: '33330000-0000-0000-0000-0000000000ff' };

// ---------------------------------------------------------------------------------------------------------------
// Opt-in scope-aware world (phase 3). installWorld() replaces the permissive "has_scope: true" stub with rules that
// evaluate user_has_scope, object resolution and assignment lookups against WORLD, an in-memory fixture of three
// contexts: A1 (campus A, IDS.dept), A2 (campus A, IDS.deptA2), B1 (campus B, IDS.deptB). Call after baseRules().
// ---------------------------------------------------------------------------------------------------------------
export const CTX = {
  A1: { n: 'a1', campus: IDS.campusA, dept: IDS.dept, prog: IDS.prog, off: IDS.off, sv: IDS.sv, subj: IDS.subj, teacher: 'teacher', reviewer: 'reviewer', hod: 'hod' },
  A2: { n: 'a2', campus: IDS.campusA, dept: IDS.deptA2, prog: IDS.progA2, off: IDS.offA2, sv: IDS.svA2, subj: IDS.subjA2, teacher: 'teacherA2', reviewer: 'reviewerA2', hod: 'hodA2' },
  B1: { n: 'b1', campus: IDS.campusB, dept: IDS.deptB, prog: IDS.progB, off: IDS.offB, sv: IDS.svB, subj: IDS.subjB, teacher: 'teacherB', reviewer: 'reviewerB', hod: 'hodB' },
};
// Fixed object ids per context: oid('unit', 'A1') -> '11110000-0000-0000-0000-0000000000a1'.
const PREFIX = { unit: '11110000', topic: '22220000', subtopic: '33330000', co: '44440000', section: '5ec00000', section_off: '5ec10000',
  tca: '66660000', ra: '77770000', pyp: '88880000', question: '9a000000', batch: '9b000000', notification: '9c000000', paper: '9d000000',
  sv_pending: 'b1110000', sv_draft: 'b2220000', unit_d: '11120000', topic_d: '22210000', subtopic_d: '33310000', co_d: '44410000' };
export const oid = (kind, ctx) => `${PREFIX[kind]}-0000-0000-0000-0000000000${CTX[ctx].n}`;
export const PYP_NULL = '88880000-0000-0000-0000-00000000000f'; // subject-wide previous-year row (course_offering_id NULL)

export function freshWorld() {
  const w = { offerings: {}, departments: {}, programs: {}, versions: {}, cos: [], units: [], topics: [], subtopics: [], sections: [],
    tca: [], ra: [], pyp: [], scopes: [], questions: [] };
  const scope = (who, role, campus_id, department_id = null, program_id = null, course_offering_id = null) =>
    w.scopes.push({ id: `5c0${w.scopes.length.toString(16).padStart(5, '0')}-0000-0000-0000-000000000000`, user_id: USERS[who].id, role, campus_id, department_id, program_id, course_offering_id, is_active: true });
  for (const [name, c] of Object.entries(CTX)) {
    w.offerings[c.off] = { ...OFFERINGS[c.off] };
    w.departments[c.dept] = { department_id: c.dept, campus_id: c.campus, college_id: null, is_active: true };
    w.programs[c.prog] = { program_id: c.prog, campus_id: c.campus, department_id: c.dept, is_active: true };
    // The ACTIVE version (migration 042 lifecycle), a verified successor in HOD review (only HOD_REVIEW is approved),
    // and a DRAFT (the only state whose content may change) created by the offering's teacher.
    w.versions[c.sv] = { id: c.sv, course_offering_id: c.off, version_number: 1, status: 'ACTIVE', verification_status: 'teacher_verified', approval_status: 'hod_approved', uploaded_by: USERS[c.teacher].id };
    w.versions[oid('sv_pending', name)] = { id: oid('sv_pending', name), course_offering_id: c.off, version_number: 2, status: 'HOD_REVIEW', verification_status: 'teacher_verified', approval_status: 'pending', uploaded_by: USERS[c.teacher].id };
    w.versions[oid('sv_draft', name)] = { id: oid('sv_draft', name), course_offering_id: c.off, version_number: 3, status: 'DRAFT', verification_status: 'pending', approval_status: 'pending', uploaded_by: USERS[c.teacher].id };
    w.cos.push({ id: oid('co', name), course_offering_id: c.off, syllabus_version_id: c.sv, code: 'CO1', is_active: true });
    w.units.push({ id: oid('unit', name), course_offering_id: c.off, syllabus_version_id: c.sv, code: 'U1', is_active: true });
    w.topics.push({ id: oid('topic', name), course_offering_id: c.off, syllabus_unit_id: oid('unit', name), title: 'T1', is_active: true });
    w.subtopics.push({ id: oid('subtopic', name), course_offering_id: c.off, syllabus_topic_id: oid('topic', name), title: 'S1', is_active: true });
    w.cos.push({ id: oid('co_d', name), course_offering_id: c.off, syllabus_version_id: oid('sv_draft', name), code: 'CO1', is_active: true });
    w.units.push({ id: oid('unit_d', name), course_offering_id: c.off, syllabus_version_id: oid('sv_draft', name), code: 'U1', is_active: true });
    w.topics.push({ id: oid('topic_d', name), course_offering_id: c.off, syllabus_unit_id: oid('unit_d', name), title: 'T1', is_active: true });
    w.subtopics.push({ id: oid('subtopic_d', name), course_offering_id: c.off, syllabus_topic_id: oid('topic_d', name), title: 'S1', is_active: true });
    w.sections.push({ id: oid('section', name), course_offering_id: c.off, name: 'A', is_active: true });
    w.sections.push({ id: oid('section_off', name), course_offering_id: c.off, name: 'Z', is_active: false });
    w.tca.push({ id: oid('tca', name), teacher_id: USERS[c.teacher].id, course_offering_id: c.off, section_id: null, is_active: true });
    w.ra.push({ id: oid('ra', name), reviewer_id: USERS[c.reviewer].id, course_offering_id: c.off, is_active: true });
    w.pyp.push({ id: oid('pyp', name), course_offering_id: c.off, subject_id: c.subj, year: 2024 });
    w.questions.push({ id: oid('question', name), submitted_by: USERS[c.teacher].id, course_offering_id: c.off });
    scope(c.hod, 'hod', c.campus, c.dept);
    scope(c.reviewer, 'reviewer', c.campus, c.dept, c.prog);
    scope(c.teacher, 'teacher', c.campus, c.dept, c.prog, c.off);
  }
  w.pyp.push({ id: PYP_NULL, course_offering_id: null, subject_id: IDS.subj, year: 2019 });
  scope('coe', 'coe', IDS.campusA); scope('coeB', 'coe', IDS.campusB);
  for (const v of ['v1', 'v2', 'v3', 'v4']) scope(v, 'validator', IDS.campusA);
  scope('vB', 'validator', IDS.campusB);
  return w;
}
export let WORLD;

// user_has_scope (migration 024): a NULL argument or a NULL scope level matches anything.
export const userHasScope = ([uid, role, campus, dept, prog, off]) => WORLD.scopes.some((s) => s.user_id === uid && s.role === role && s.is_active !== false
  && [[campus, s.campus_id], [dept, s.department_id], [prog, s.program_id], [off, s.course_offering_id]].every(([want, have]) => want == null || have == null || want === have));
// SCOPE_SQL (scopes.js) over an offering: the row's campus, department, program and offering must be covered
// (NULL scope level = any).
export const scopeCovers = (userId, role, off) => {
  const o = WORLD.offerings[off];
  return !!o && WORLD.scopes.some((s) => s.user_id === userId && s.role === role && s.is_active !== false
    && (s.campus_id == null || s.campus_id === o.campus_id) && (s.department_id == null || s.department_id === o.department_id)
    && (s.program_id == null || s.program_id === o.program_id) && (s.course_offering_id == null || s.course_offering_id === o.course_offering_id));
};
const byId = (rows, id) => rows.filter((r) => r.id === id);
const userById = (id) => Object.values(USERS).find((u) => u.id === id);
// The version a content row belongs to (unit / CO directly, topic through its unit, subtopic through its topic).
const versionOfContent = (r) => {
  if (r.syllabus_version_id) return WORLD.versions[r.syllabus_version_id];
  if (r.syllabus_unit_id) return versionOfContent(WORLD.units.find((u) => u.id === r.syllabus_unit_id) || {});
  if (r.syllabus_topic_id) return versionOfContent(WORLD.topics.find((t) => t.id === r.syllabus_topic_id) || {});
  return undefined;
};
const ownerRow = (rows, id) => byId(rows, id).map((r) => ({ id: r.id, course_offering_id: r.course_offering_id,
  version_status: versionOfContent(r)?.status, version_number: versionOfContent(r)?.version_number }));

export function installWorld() {
  WORLD = freshWorld();
  // Generic writes on academic tables succeed (recorded in `log`; tests assert none happen on a denial).
  sql(/^(INSERT INTO|UPDATE|DELETE FROM) (sections|teacher_course_assignments|reviewer_assignments|syllabus_versions|syllabus_units|syllabus_topics|syllabus_subtopics|course_outcomes|previous_year_papers|user_scopes|programs|course_offerings|departments|subjects|academic_sessions|questions|syllabus_changes)\b/i,
    () => [{ id: '99999999-0000-0000-0000-000000000001' }]);
  sql(/^UPDATE questions SET question_status = 'CHANGES_REQUESTED'/i, []);
  // Ending an assignment really ends it (a second deactivate is refused with 409).
  sql(/^UPDATE (teacher_course_assignments|reviewer_assignments) SET is_active = FALSE.* WHERE id = \$1 AND is_active RETURNING id/i, (p, t) => {
    const a = byId(/teacher/.test(t) ? WORLD.tca : WORLD.ra, p[0]).find((r) => r.is_active);
    if (!a) return [];
    a.is_active = false; return [{ id: a.id }];
  });
  sql(/^UPDATE user_scopes SET is_active = FALSE, updated_at = now\(\), revoked_at = now\(\), revoked_by = \$7, revoke_reason = \$8 WHERE user_id = \$1 AND role = \$2/i, (p, t) => {
    const hit = WORLD.scopes.filter((s) => s.is_active && s.user_id === p[0] && s.role === p[1] && s.campus_id === p[2] && s.department_id === p[3]
      && (s.program_id ?? null) === p[4] && (s.course_offering_id ?? null) === p[5]);
    if (/NOT EXISTS \(SELECT 1 FROM reviewer_assignments/.test(t)
        && WORLD.ra.some((a) => a.reviewer_id === p[0] && a.is_active && WORLD.offerings[a.course_offering_id]?.program_id === p[4])) return [];
    hit.forEach((s) => { Object.assign(s, { is_active: false, revoked_by: p[6], revoke_reason: p[7] }); });
    return hit.map((s) => ({ id: s.id }));
  });
  sql(/^SELECT id FROM user_scopes WHERE user_id = \$1 AND role = \$2 AND is_active/i, []);
  // Scope checks: checkScope / hodCovers / getUserCampusIds / the reviewer-seat EXISTS.
  sql(/^SELECT user_has_scope\(\$1, \$2, \$3, \$4, \$5, \$6\)/i, (p) => [{ has_scope: userHasScope(p) }]);
  sql(/^SELECT user_has_scope\(\$1, 'hod', \$2, \$3, NULL, NULL\)/i, (p) => [{ has_scope: userHasScope([p[0], 'hod', p[1], p[2]]) }]);
  sql(/SELECT DISTINCT campus_id FROM user_scopes/i, (p) => [...new Set(WORLD.scopes.filter((s) => s.user_id === p[0] && s.role === p[1] && s.is_active && s.campus_id).map((s) => s.campus_id))].map((campus_id) => ({ campus_id })));
  // Object resolution.
  sql(/FROM course_offerings co JOIN programs p ON p.id = co.program_id WHERE co.id = \$1/i, (p) => [WORLD.offerings[p[0]]].filter(Boolean));
  sql(/SELECT d.id AS department_id, d.campus_id/i, (p) => [WORLD.departments[p[0]]].filter(Boolean));
  sql(/SELECT p.id AS program_id, p.campus_id/i, (p) => [WORLD.programs[p[0]]].filter(Boolean));
  sql(/^SELECT (\*|id, syllabus_version_id) FROM course_offerings WHERE id = \$1 FOR UPDATE/i, (p) => {
    const o = WORLD.offerings[p[0]]; return o ? [{ id: o.course_offering_id, syllabus_version_id: o.syllabus_version_id }] : [];
  });
  sql(/^SELECT \* FROM syllabus_versions WHERE id = \$1/i, (p) => [WORLD.versions[p[0]]].filter(Boolean));
  // Activation (src/syllabus-versioning.js): the version re-checked in HOD_REVIEW, the previous ACTIVE one, complete
  // content, empty trees and no questions on the previous version unless a test scripts them.
  sql(/^SELECT id, version_number, verified_by FROM syllabus_versions WHERE id = \$1 AND status = 'HOD_REVIEW' FOR UPDATE/i,
    (p) => [WORLD.versions[p[0]]].filter((v) => v?.status === 'HOD_REVIEW').map((v) => ({ id: v.id, version_number: v.version_number, verified_by: USERS.teacher.id })));
  sql(/^SELECT id, version_number FROM syllabus_versions WHERE id = \$1 AND status = 'ACTIVE'/i,
    (p) => [WORLD.versions[p[0]]].filter((v) => v?.status === 'ACTIVE').map((v) => ({ id: v.id, version_number: v.version_number })));
  sql(/^SELECT syllabus_version_content_problems\(\$1\) AS problems/i, [{ problems: [] }]);
  sql(/^SELECT (id, code, title, sequence FROM syllabus_units|t.id, t.title, t.sequence, t.syllabus_unit_id FROM syllabus_topics|st.id, st.title, st.sort_order, st.syllabus_topic_id FROM syllabus_subtopics|id, code, description, sequence FROM course_outcomes)/i, []);
  sql(/FROM questions q LEFT JOIN canonical_questions cq ON cq.id = q.canonical_question_id WHERE q.course_offering_id = \$1 AND q.syllabus_version_id = \$2 AND q.question_status <> 'REJECTED'/i, []);
  sql(/^SELECT DISTINCT reviewer_id FROM reviewer_assignments WHERE course_offering_id = \$1 AND is_active/i,
    (p) => WORLD.ra.filter((a) => a.course_offering_id === p[0] && a.is_active).map((a) => ({ reviewer_id: a.reviewer_id })));
  sql(/^SELECT COALESCE\(MAX\(version_number\), 0\) as v FROM syllabus_versions/i, [{ v: 1 }]);
  sql(/FROM course_outcomes c JOIN syllabus_versions sv/i, (p) => ownerRow(WORLD.cos, p[0]));
  sql(/FROM syllabus_units su JOIN syllabus_versions sv/i, (p) => ownerRow(WORLD.units, p[0]));
  sql(/FROM syllabus_topics st JOIN syllabus_units su/i, (p) => ownerRow(WORLD.topics, p[0]));
  sql(/FROM syllabus_subtopics ss JOIN syllabus_topics st/i, (p) => ownerRow(WORLD.subtopics, p[0]));
  sql(/^SELECT \* FROM (teacher_course_assignments|reviewer_assignments) WHERE id = \$1$/i, (p, t) => byId(/teacher/.test(t) ? WORLD.tca : WORLD.ra, p[0]));
  sql(/FROM teacher_course_assignments WHERE teacher_id = \$1 AND course_offering_id = \$2 AND is_active/i,
    (p) => WORLD.tca.filter((a) => a.teacher_id === p[0] && a.course_offering_id === p[1] && a.is_active).map(() => ({ x: 1 })));
  sql(/SELECT id FROM reviewer_assignments WHERE course_offering_id = \$1 AND reviewer_id = \$2 AND is_active/i,
    (p) => WORLD.ra.filter((a) => a.course_offering_id === p[0] && a.reviewer_id === p[1] && a.is_active).map((a) => ({ id: a.id })));
  sql(/^SELECT \* FROM users WHERE id = \$1 AND role = '(teacher|reviewer)'/i, (p, t) => [userById(p[0])].filter((u) => u && t.includes(`'${u.role}'`)));
  sql(/^SELECT id FROM sections WHERE id = \$1 AND course_offering_id = \$2 AND is_active/i,
    (p) => WORLD.sections.filter((s) => s.id === p[0] && s.course_offering_id === p[1] && s.is_active).map((s) => ({ id: s.id })));
  sql(/^SELECT \* FROM previous_year_papers WHERE id = \$1/i, (p) => byId(WORLD.pyp, p[0]));
  sql(/^SELECT id FROM previous_year_papers WHERE course_offering_id = \$1 AND question_hash = \$2/i, []);
  sql(/COUNT\(\*\) FILTER \(WHERE user_has_scope\(\$2, 'hod'/i, (p) => {
    const offs = Object.values(WORLD.offerings).filter((o) => o.subject_id === p[0]);
    const ins = offs.filter((o) => userHasScope([p[1], 'hod', o.campus_id, o.department_id])).length;
    return [{ in_scope: ins, out_of_scope: offs.length - ins }];
  });
  // Lists (object rows of one offering).
  sql(/^SELECT \* FROM sections WHERE course_offering_id = \$1/i, (p) => WORLD.sections.filter((s) => s.course_offering_id === p[0]));
  sql(/FROM teacher_course_assignments tca JOIN users u ON u.id = tca.teacher_id LEFT JOIN sections/i, (p) => WORLD.tca.filter((a) => a.course_offering_id === p[0]));
  sql(/FROM reviewer_assignments ra JOIN users u ON u.id = ra.reviewer_id WHERE ra.course_offering_id = \$1/i, (p) => WORLD.ra.filter((a) => a.course_offering_id === p[0]));
  sql(/FROM syllabus_versions sv LEFT JOIN users uu/i, (p) => Object.values(WORLD.versions).filter((v) => v.course_offering_id === p[0]));
  sql(/^SELECT \* FROM course_outcomes WHERE syllabus_version_id = \$1/i, (p) => WORLD.cos.filter((c) => c.syllabus_version_id === p[0]));
  sql(/^SELECT \* FROM syllabus_units WHERE syllabus_version_id = \$1/i, (p) => WORLD.units.filter((u) => u.syllabus_version_id === p[0]));
  sql(/^SELECT \* FROM syllabus_topics WHERE syllabus_unit_id = \$1/i, (p) => WORLD.topics.filter((t) => t.syllabus_unit_id === p[0]));
  sql(/FROM syllabus_subtopics WHERE syllabus_topic_id = \$1/i, (p) => WORLD.subtopics.filter((t) => t.syllabus_topic_id === p[0]));
  sql(/FROM previous_year_papers p LEFT JOIN users u/i, (p) => WORLD.pyp.filter((r) => r.course_offering_id === p[0] || (r.course_offering_id == null && r.subject_id === p[1]))
    .map((r) => ({ ...r, subject_wide: r.course_offering_id == null })));
  // Questions: authorization.js loadQuestionContext.
  sql(/FROM questions q JOIN course_offerings co ON co.id = q.course_offering_id JOIN programs p ON p.id = co.program_id WHERE q.id = \$1/i, (p) => {
    const q = WORLD.questions.find((x) => x.id === p[0]); const o = q && WORLD.offerings[q.course_offering_id];
    return q && o ? [{ id: q.id, submitted_by: q.submitted_by, course_offering_id: q.course_offering_id, campus_id: o.campus_id, program_id: o.program_id, department_id: o.department_id }] : [];
  });
  // A teacher's quality report (authorization.js authorizeTeacherQuality): an assignment or a question in an
  // offering the HOD's scope covers.
  sql(/^SELECT EXISTS \(SELECT 1 FROM users t WHERE t.id = \$3 AND t.role = 'teacher'/i, (p) => {
    const t = userById(p[2]);
    const offs = [...WORLD.tca.filter((a) => a.teacher_id === p[2]).map((a) => a.course_offering_id),
      ...WORLD.questions.filter((q) => q.submitted_by === p[2]).map((q) => q.course_offering_id)];
    return [{ ok: !!t && t.role === 'teacher' && offs.some((o) => scopeCovers(p[0], p[1], o)) }];
  });
  sql(/WHERE q.submitted_by = \$3 AND EXISTS \( SELECT 1 FROM user_scopes s/i, []);
}

// Data-changing statements, minus the bookkeeping every request may write (audit, authorization log, notifications).
export const writes = () => log.filter((l) => /^(INSERT INTO|UPDATE|DELETE FROM)/i.test(l.text)
  && !/^INSERT INTO (audit_log|authorization_log|request_log|suspicious_activity|notifications|step_up_auth_log)/i.test(l.text));

let started;
export async function start() {
  if (!started) {
    baseRules();
    started = import('../src/server.js');
    await started;
    for (let i = 0; i < 50; i++) {
      try { const r = await fetch(`http://localhost:${process.env.PORT}/api/health`); if (r.status) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
export async function call(method, path, body, who) {
  const res = await fetch(`http://localhost:${process.env.PORT}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${tokenFor(who)}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
