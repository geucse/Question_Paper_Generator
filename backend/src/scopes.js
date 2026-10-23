import { get, all, run } from './db.js';

// One place for scope logic (PIVOT_SPEC_V2 §4: role + scope from user_scopes). Imports only db.js, so
// authorization.js and every route can use it without an import cycle.

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

// List predicate: does an active scope of user ${u} with role ${r} cover the row's campus, department, program and
// offering? Expects aliases co (course_offerings: id, campus_id, program_id) and p (programs: department_id) unless
// others are given. A NULL scope level means "any" (the same matching as user_has_scope, migration 024), so a
// reviewer scope limited to one program covers only that program's offerings. HOD scopes are department-level
// (enforced by chk_user_scopes_hod_department_level, migration 040 section F).
export const scopeSql = (u = '$1', r = '$2', { co = 'co', p = 'p' } = {}) => `EXISTS (
  SELECT 1 FROM user_scopes s
  WHERE s.user_id = ${u} AND s.role = ${r} AND s.is_active
    AND (s.effective_from IS NULL OR s.effective_from <= now())
    AND (s.effective_until IS NULL OR s.effective_until > now())
    AND (s.campus_id IS NULL OR s.campus_id = ${co}.campus_id)
    AND (s.department_id IS NULL OR s.department_id = ${p}.department_id)
    AND (s.program_id IS NULL OR s.program_id = ${co}.program_id)
    AND (s.course_offering_id IS NULL OR s.course_offering_id = ${co}.id))`;
export const SCOPE_SQL = scopeSql();

// Inline HOD predicate for list routes over rows that carry their own campus/department columns (users,
// departments, programs, offerings). Both levels must be known: user_has_scope treats a NULL argument as "any",
// so a row with no department would otherwise be visible to every HOD of the campus.
export const hodCoversSql = (userParam, campusExpr, deptExpr) =>
  `(${campusExpr} IS NOT NULL AND ${deptExpr} IS NOT NULL AND user_has_scope(${userParam}, 'hod', ${campusExpr}, ${deptExpr}, NULL, NULL))`;

// Academic context of a course offering: { course_offering_id, program_id, campus_id, department_id, subject_id,
// syllabus_version_id } or null (unknown or malformed id). co.campus_id is kept equal to programs.campus_id by
// trg_sync_offering_campus (migration 031).
export async function offeringContext(id, db = { get }) {
  if (!isUuid(id)) return null;
  return db.get(`SELECT co.id AS course_offering_id, co.program_id, co.campus_id, p.department_id, co.subject_id, co.syllabus_version_id
                 FROM course_offerings co JOIN programs p ON p.id = co.program_id WHERE co.id = $1`, [id]);
}
export async function departmentContext(id) {
  if (!isUuid(id)) return null;
  return get('SELECT d.id AS department_id, d.campus_id, d.college_id, d.is_active FROM departments d WHERE d.id = $1', [id]);
}
export async function programContext(id) {
  if (!isUuid(id)) return null;
  return get('SELECT p.id AS program_id, p.campus_id, p.department_id, p.is_active FROM programs p WHERE p.id = $1', [id]);
}

// Does this HOD hold an active scope covering that campus + department? Unknown levels are denied, never widened.
export async function hodCovers(user, ctx) {
  if (user?.role !== 'hod' || !ctx?.campus_id || !ctx?.department_id) return false;
  const row = await get("SELECT user_has_scope($1, 'hod', $2, $3, NULL, NULL) AS has_scope", [user.id, ctx.campus_id, ctx.department_id]);
  return row?.has_scope === true;
}

// Insert a scope unless an identical active one already exists. Pass a transaction as `db` to make the grant part
// of the change it belongs to (account provisioning, role change). The partial unique index uq_user_scopes_active
// (migration 040) de-duplicates active rows, NULL levels included; a concurrent identical grant (23505) returns
// the row that won. Revoked rows stay as history.
export async function grantScope({ userId, role, campusId = null, departmentId = null, programId = null, courseOfferingId = null, grantedBy = null }, db = { get }) {
  const find = () => db.get(`
    SELECT id FROM user_scopes
    WHERE user_id = $1 AND role = $2 AND is_active = TRUE
      AND campus_id IS NOT DISTINCT FROM $3::uuid
      AND department_id IS NOT DISTINCT FROM $4::uuid
      AND program_id IS NOT DISTINCT FROM $5::uuid
      AND course_offering_id IS NOT DISTINCT FROM $6::uuid`,
    [userId, role, campusId, departmentId, programId, courseOfferingId]);
  const existing = await find();
  if (existing) return existing.id;
  try {
    const row = await db.get(`
      INSERT INTO user_scopes (user_id, role, campus_id, department_id, program_id, course_offering_id, granted_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [userId, role, campusId, departmentId, programId, courseOfferingId, grantedBy]);
    return row.id;
  } catch (err) {
    if (err.code !== '23505') throw err;
    const again = await find();
    if (!again) throw err;
    return again.id;
  }
}

// Revoke one scope, recording who and why. Returns the revoked row (null if it was not active).
export async function revokeScope(scopeId, { by = null, reason = null } = {}, db = { get }) {
  return db.get(`UPDATE user_scopes SET is_active = FALSE, revoked_at = now(), revoked_by = $2, revoke_reason = $3, updated_at = now()
                 WHERE id = $1 AND is_active RETURNING *`, [scopeId, by, reason]);
}

// Revoke every active scope of a user (deactivation, role change). Returns the revoked rows.
export async function revokeAllScopes(db, userId, { by = null, reason = null } = {}) {
  return db.all(`UPDATE user_scopes SET is_active = FALSE, revoked_at = now(), revoked_by = $2, revoke_reason = $3, updated_at = now()
                 WHERE user_id = $1 AND is_active
                 RETURNING id, role, campus_id, department_id, program_id, course_offering_id`, [userId, by, reason]);
}

// Revoke the scope grantScope() created for an assignment (academic.js assignment routes). Reviewer scopes are
// program-level and shared by all of the reviewer's offerings in that program, so they are kept while another
// active reviewer assignment in the same program remains. A manually granted scope of exactly the same shape is
// revoked too (the admin can grant it again). The revocation is recorded on the row (revoked_at/by/reason, the
// same history as revokeScope). Returns the revoked rows [{ id }].
export async function revokeAssignmentScope({ userId, role, campusId, departmentId, programId, courseOfferingId = null, by = null, reason = 'assignment_ended' }, db = { all }) {
  const keep = role === 'reviewer' ? `AND NOT EXISTS (SELECT 1 FROM reviewer_assignments ra JOIN course_offerings co ON co.id = ra.course_offering_id
                     WHERE ra.reviewer_id = $1 AND ra.is_active AND co.program_id = $5::uuid)` : '';
  return db.all(`UPDATE user_scopes SET is_active = FALSE, updated_at = now(), revoked_at = now(), revoked_by = $7, revoke_reason = $8
    WHERE user_id = $1 AND role = $2 AND is_active
      AND campus_id IS NOT DISTINCT FROM $3::uuid AND department_id IS NOT DISTINCT FROM $4::uuid
      AND program_id IS NOT DISTINCT FROM $5::uuid AND course_offering_id IS NOT DISTINCT FROM $6::uuid ${keep}
    RETURNING id`, [userId, role, campusId, departmentId, programId, courseOfferingId, by, reason]);
}

// Active HODs whose active scope covers a course offering (its campus / department): the same rule that
// decides who sees a question in the HOD lists and who may send it to review (authorize('assign_review')),
// so the people notified are exactly the people who can act. Returns [{ id }].
export async function hodsInScope(courseOfferingId) {
  return all(`
    SELECT DISTINCT u.id FROM users u
    JOIN user_scopes s ON s.user_id = u.id AND s.role = 'hod' AND s.is_active
      AND (s.effective_from IS NULL OR s.effective_from <= now()) AND (s.effective_until IS NULL OR s.effective_until > now())
    JOIN course_offerings co ON co.id = $1
    JOIN programs p ON p.id = co.program_id
    WHERE u.role = 'hod' AND u.is_active = TRUE
      AND (s.campus_id IS NULL OR s.campus_id = co.campus_id)
      AND (s.department_id IS NULL OR s.department_id = p.department_id)`, [courseOfferingId]);
}
