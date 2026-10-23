// Account provisioning helpers shared by routes/users.js and routes/admin.js (PIVOT_SPEC_V2 §2, §4, §5).
//   - Identity: employee_id, full_name, official email (lower-cased), role, campus, institution.
//   - Scopes are granted in the same transaction as the account. Teachers get none at creation: their scopes come
//     from teacher assignments (a department-level teacher scope would match every offering of the department).
//   - New accounts get an unusable password and a one-time account-setup code delivered by email; no password ever
//     crosses the wire or appears in a response.
import validator from 'validator';
import { get, all } from './db.js';
import { hashCode, generateSetupToken, hashPassword } from './auth.js';
import crypto from 'crypto';
import { logAudit } from './audit.js';
import { deliverCode, OtpDeliveryError } from './otp-delivery.js';
import { isUuid } from './scopes.js';
import { checkAcademic } from './academic-scope.js';

export const ROLES = ['admin', 'hod', 'reviewer', 'teacher', 'coe', 'validator'];
export const PROVISIONABLE_BY = { admin: ROLES, hod: ['teacher', 'reviewer'] };
export const MAX_SCOPE_ROWS = 20;

export const normalizeEmail = (e) => (typeof e === 'string' ? e.trim().toLowerCase() : '');

export function validateIdentity({ email, full_name: fullName, employee_id: employeeId }) {
  const errors = [];
  if (!validator.isEmail(normalizeEmail(email))) errors.push('A valid official email is required');
  const name = typeof fullName === 'string' ? fullName.trim() : '';
  if (name.length < 2 || name.length > 120) errors.push('Full name is required (2-120 characters)');
  if (typeof employeeId !== 'string' || !/^[A-Za-z0-9._/-]{2,40}$/.test(employeeId.trim())) {
    errors.push('Employee ID is required (2-40 letters, digits or . _ / -)');
  }
  return errors;
}

// The scopes an account of `role` gets, validated against the hierarchy. Returns
// { scopes: [{ campusId, departmentId, programId }], institutionId, campusId, departmentId } or { error }.
export async function resolveScopePlan(db, { role, campusId, departmentId = null, scopes = null }) {
  if (!ROLES.includes(role)) return { error: 'Unknown role' };
  if (!isUuid(campusId)) return { error: 'campus_id is required' };
  const campus = await db.get('SELECT id, institution_id FROM campuses WHERE id = $1 AND is_active', [campusId]);
  if (!campus) return { error: 'That campus does not exist or is inactive' };
  const checkDept = async (campus_, dept) => {
    if (!isUuid(dept)) return 'department_id is malformed';
    const d = await db.get('SELECT id, campus_id FROM departments WHERE id = $1 AND is_active', [dept]);
    if (!d) return 'That department does not exist or is inactive';
    if (d.campus_id !== campus_) return 'That department belongs to another campus';
    return null;
  };
  const base = { institutionId: campus.institution_id, campusId, departmentId: departmentId || null };
  if (['hod', 'reviewer', 'teacher'].includes(role)) {
    if (!departmentId) return { error: `department_id is required for the ${role} role` };
    const err = await checkDept(campusId, departmentId);
    if (err) return { error: err };
    return { ...base, scopes: role === 'teacher' ? [] : [{ campusId, departmentId, programId: null }] };
  }
  if (departmentId) {
    const err = await checkDept(campusId, departmentId);
    if (err) return { error: err };
  }
  if (role === 'admin') return { ...base, scopes: [{ campusId, departmentId: null, programId: null }] };
  // coe / validator: explicit rows, default = the whole campus.
  const rows = Array.isArray(scopes) && scopes.length ? scopes : [{ campus_id: campusId }];
  if (rows.length > MAX_SCOPE_ROWS) return { error: `At most ${MAX_SCOPE_ROWS} scope rows` };
  const out = [];
  for (const r of rows) {
    const row = { campusId: r?.campus_id || campusId, departmentId: r?.department_id || null, programId: r?.program_id || null };
    const err = await checkScopeRow(db, row);
    if (err) return { error: err };
    out.push(row);
  }
  return { ...base, scopes: out };
}

// One scope row against the hierarchy: an active campus; the department on that campus; the program on that
// campus (and in that department when one is given). Returns an error message or null.
export async function checkScopeRow(db, { campusId, departmentId = null, programId = null }) {
  if (!isUuid(campusId)) return 'Every scope row needs a valid campus';
  if (!(await db.get('SELECT id FROM campuses WHERE id = $1 AND is_active', [campusId]))) return 'A scope row names an unknown or inactive campus';
  if (departmentId) {
    if (!isUuid(departmentId)) return 'department_id is malformed';
    const d = await db.get('SELECT id, campus_id FROM departments WHERE id = $1 AND is_active', [departmentId]);
    if (!d) return 'That department does not exist or is inactive';
    if (d.campus_id !== campusId) return 'That department belongs to another campus';
  }
  if (programId) {
    if (!isUuid(programId)) return 'program_id is malformed';
    const p = await db.get('SELECT id, department_id, campus_id FROM programs WHERE id = $1 AND is_active', [programId]);
    if (!p) return 'That program does not exist or is inactive';
    if (p.campus_id !== campusId || (departmentId && p.department_id !== departmentId)) return 'That program is not part of the given campus/department';
  }
  return null;
}

// May `actor` manage `target`'s account? Admin: anyone. HOD: teacher/reviewer accounts whose home campus and
// department its active hod scope covers (user_scopes, logged through authorize()).
export async function canManage(actor, target) {
  if (actor.role === 'admin') return { allowed: true };
  if (actor.role !== 'hod' || !['teacher', 'reviewer'].includes(target.role)) {
    return { allowed: false, error: 'You can only manage teacher/reviewer accounts in a department your HOD scope covers' };
  }
  const a = await checkAcademic(actor, 'manage', { campus_id: target.campus_id, department_id: target.department_id }, 'user', target.id);
  return a.allowed ? { allowed: true } : { allowed: false, error: 'You can only manage teacher/reviewer accounts in a department your HOD scope covers' };
}

export async function isLastActiveAdmin(db, targetId) {
  const row = await db.get("SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND is_active AND id <> $1", [targetId]);
  return (row?.n ?? 0) === 0;
}

// Scopes derivable from identity and active assignments, re-granted on reactivation. COE/validator scopes are
// explicit decisions and must be granted again by the admin.
export async function baseScopesFor(db, user) {
  if (['hod', 'reviewer'].includes(user.role) && user.campus_id && user.department_id) {
    return [{ campusId: user.campus_id, departmentId: user.department_id, programId: null, courseOfferingId: null }];
  }
  if (user.role === 'admin' && user.campus_id) return [{ campusId: user.campus_id, departmentId: null, programId: null, courseOfferingId: null }];
  if (user.role === 'teacher') {
    const rows = await db.all(`
      SELECT DISTINCT co.campus_id, p.department_id, co.program_id, co.id AS course_offering_id
      FROM teacher_course_assignments t JOIN course_offerings co ON co.id = t.course_offering_id JOIN programs p ON p.id = co.program_id
      WHERE t.teacher_id = $1 AND t.is_active`, [user.id]);
    return rows.map((r) => ({ campusId: r.campus_id, departmentId: r.department_id, programId: r.program_id, courseOfferingId: r.course_offering_id }));
  }
  return [];
}

export const inviteTtlHours = () => Math.min(Math.max(Number(process.env.ACCOUNT_INVITE_TTL_HOURS) || 72, 1), 24 * 14);

// A random, never-disclosed password: the account is unusable until the setup code is redeemed.
export async function unusablePasswordHash() {
  return hashPassword(crypto.randomBytes(32).toString('base64url'));
}

// Burn earlier setup codes and store a new one (hashed). Returns the plaintext code for delivery only.
export async function issueAccountSetup(db, userId) {
  const token = generateSetupToken();
  await db.run("UPDATE otp_codes SET used = TRUE WHERE user_id = $1 AND purpose = 'account_setup' AND used = FALSE", [userId]);
  await db.run(`INSERT INTO otp_codes (user_id, code_hash, purpose, expires_at) VALUES ($1, $2, 'account_setup', now() + make_interval(hours => $3))`,
    [userId, hashCode(token), inviteTtlHours()]);
  return token;
}

// Email the setup code. False (and audited) when delivery is not configured or the send failed; the account stays
// in place and the admin/HOD can resend once mail works.
export async function deliverInvite(user, token, req) {
  try {
    await deliverCode(user.email, token, 'account_setup');
    return true;
  } catch (e) {
    if (!(e instanceof OtpDeliveryError)) throw e;
    await logAudit({ userId: req.user.id, action: 'account_invite_delivery_failed', entityId: user.id, details: { kind: e.kind }, ip: req.ip });
    return false;
  }
}

export async function listScopes(userId) {
  return all(`SELECT id, role, campus_id, department_id, program_id, course_offering_id FROM user_scopes WHERE user_id = $1 AND is_active ORDER BY created_at`, [userId]);
}
