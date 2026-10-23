// Object-level guards for the academic routes (academic.js, /questions/mistakes): resolve the object, then
// authorize() it (logged in authorization_log), then let the route check state and write.
// Spec §2: admin is technical-only, so only 'structure' (departments/programs/offerings/sections) lets the
// technical admin through, as 'technical_admin'; every academic content or staffing decision is the HOD's.
import { authorize } from './authorization.js';
import { offeringContext } from './scopes.js';

export { isUuid, UUID_RE, offeringContext, departmentContext, programContext, hodCoversSql } from './scopes.js';

// mode: 'view' (syllabus reads: HOD in scope, assigned teacher, assigned reviewer in scope),
// 'manage' (HOD in scope only), 'structure' (HOD in scope, or the technical admin).
export function checkAcademic(user, mode, ctx, type = 'course_offering', id = ctx?.course_offering_id) {
  const action = mode === 'structure' ? (user.role === 'admin' ? 'technical_admin' : 'manage_academic_structure')
    : mode === 'view' ? 'view_academic_context' : 'manage_academic_context';
  return authorize(user, action, {
    type, id: id ?? null, campus_id: ctx?.campus_id ?? null,
    department_id: ctx?.department_id ?? null, program_id: ctx?.program_id ?? null, course_offering_id: ctx?.course_offering_id ?? null,
  });
}

// Route guard: 404 for an unknown or malformed offering id, 403 out of scope. Returns the offering context, or
// null when the response has already been sent.
export async function guardOffering(req, res, offeringId, mode) {
  const ctx = await offeringContext(offeringId);
  if (!ctx) { res.status(404).json({ error: 'Course offering not found' }); return null; }
  const a = await checkAcademic(req.user, mode, ctx);
  if (!a.allowed) { res.status(403).json({ error: a.reason }); return null; }
  return ctx;
}
