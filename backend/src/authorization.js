import { get, query } from './db.js';
import { describeError } from './errors.js';
import { logAudit } from './audit.js';
import { normalizeRequiredApprovals, VALIDATOR_COUNT } from './paper-policy.js';
import { validatorProblems } from './validator-eligibility.js';
import { SCOPE_SQL, offeringContext } from './scopes.js';

/**
 * Central authorization layer - docs/development/PIVOT_SPEC_V2.md section 4
 *
 * Implements scope-based authorization:
 * - Role + Scope (not role alone)
 * - Campus isolation (Campus A data never appears in Campus B queries)
 * - Resource ownership checks
 * - Conflict rules (reviewer ≠ author, etc.)
 *
 * Usage:
 *   await authorize(req.user, 'review_question', question);
 *   await authorize(req.user, 'generate_paper', { campus_id, program_id });
 */

/**
 * Main authorization function
 * @param {Object} user - The authenticated user (from req.user)
 * @param {string} action - The action being attempted
 * @param {Object} resource - The resource or resource context
 * @returns {Promise<Object>} { allowed: boolean, reason?: string }
 */
export async function authorize(user, action, resource = {}) {
  if (!user || !user.id) {
    return { allowed: false, reason: 'Not authenticated' };
  }

  // PIVOT_SPEC_V2 section 2: Admin is technical-only and never takes part in
  // ordinary question or paper decisions.
  if (user.role === 'admin') {
    const ok = action === 'technical_admin';
    await logAuthzDecision(user, action, resource, ok ? 'allow' : 'deny', ok ? 'admin_technical' : 'admin_technical_only');
    return ok ? { allowed: true } : { allowed: false, reason: 'Admin is technical-only and cannot perform academic actions' };
  }

  // Route to specific authorization checks based on action
  let result;

  switch (action) {
    // Question Bank domain actions
    case 'create_question':
    case 'edit_own_question':
      result = await authorizeQuestionCreate(user, resource);
      break;

    // 'view_question' is the same rule as the workflow view (the former campus-only check let any HOD or reviewer
    // of the campus read another department's question).
    case 'view_question':
    case 'view_question_workflow':
      result = await authorizeQuestionWorkflowView(user, resource);
      break;

    case 'assign_reviewer':
      result = await authorizeReviewerAssignment(user, resource);
      break;

    case 'review_question':
    case 'activate_question':
      result = await authorizeQuestionReview(user, resource);
      break;

    case 'submit_question':
      result = await authorizeQuestionSubmit(user, resource);
      break;

    case 'assign_review':
    case 'retire_question':
    case 'restore_question':
      result = await authorizeQuestionManage(user, resource);
      break;

    // Examination domain actions
    // override_generation_targets: the generating COE is the approver of a CO/Bloom override (spec §29; admin
    // and HOD take no part, §2/§36). Same scope rule as generation, logged as its own action in authorization_log.
    case 'create_examination':
    case 'generate_paper':
    case 'override_generation_targets':
      result = await authorizePaperGeneration(user, resource);
      break;

    case 'assign_validator':
      result = await authorizeValidatorAssignment(user, resource);
      break;

    case 'validate_paper':
      result = await authorizePaperValidation(user, resource);
      break;

    case 'approve_paper_coe':
      result = await authorizeCOEApproval(user, resource);
      break;

    // Academic structure/content of one offering or department (academic.js). resource: { type, id, campus_id,
    // department_id, course_offering_id? }. Admin reaches structure routes as 'technical_admin' (academic-scope.js).
    case 'view_academic_context':
      result = await authorizeAcademicRead(user, resource);
      break;

    case 'manage_academic_context':    // syllabus/CO/unit/topic, assignments, previous-year papers
    case 'manage_academic_structure':  // programs, offerings, sections
      result = await authorizeAcademicManage(user, resource);
      break;

    // A teacher's submission-quality report (GET /questions/mistakes/:teacherId). resource: { teacher_id }
    case 'view_teacher_quality':
      result = await authorizeTeacherQuality(user, resource);
      break;

    // Question-bank analytics (spec §17). resource: { course_offering_id? }
    case 'view_analytics':
      result = await authorizeAnalytics(user, resource);
      break;

    // Review batches (spec §12, §21). resource: { review_batch_id, course_offering_id? }
    case 'view_review_batch':
    case 'manage_review_batch':
      result = await authorizeReviewBatch(user, { ...resource, manage: action === 'manage_review_batch' });
      break;

    default:
      result = { allowed: false, reason: `Unknown action: ${action}` };
  }

  await logAuthzDecision(user, action, resource, result.allowed ? 'allow' : 'deny', result.reason);
  return result;
}

/**
 * Check if user has required scope
 */
async function checkScope(userId, role, context = {}) {
  const { campus_id, department_id, program_id, course_offering_id } = context;

  const row = await get(`
    SELECT user_has_scope($1, $2, $3, $4, $5, $6) as has_scope
  `, [userId, role, campus_id, department_id, program_id, course_offering_id]);

  return row?.has_scope === true;
}

/**
 * Get user's accessible campus IDs (for query filtering)
 */
export async function getUserCampusIds(userId, role) {
  const rows = await query(`
    SELECT DISTINCT campus_id
    FROM user_scopes
    WHERE user_id = $1
      AND role = $2
      AND is_active = true
      AND (effective_from IS NULL OR effective_from <= now())
      AND (effective_until IS NULL OR effective_until > now())
      AND campus_id IS NOT NULL
  `, [userId, role]);

  return rows.map(r => r.campus_id);
}

// --- Question Bank Authorization ---

async function authorizeQuestionCreate(user, resource) {
  const { course_offering_id, campus_id, program_id } = resource;

  // Must be teacher or HOD
  if (!['teacher', 'hod'].includes(user.role)) {
    return { allowed: false, reason: 'Only teachers and HODs can create questions' };
  }

  // Check scope
  const hasScope = await checkScope(user.id, user.role, {
    campus_id,
    program_id,
    course_offering_id
  });

  if (!hasScope) {
    return { allowed: false, reason: 'No scope for this course offering' };
  }

  return { allowed: true };
}

// A question's review workflow (lifecycle history with reviewers' reasons and verdicts, its attachments):
// the author, a reviewer actively assigned to its offering (in scope), or an HOD whose scope covers its
// campus/department. Not other teachers, not the Examination domain.
async function authorizeQuestionWorkflowView(user, resource) {
  const q = await loadQuestionContext(resource.question_id);
  if (!q) return { allowed: false, reason: 'Question not found' };
  if (q.submitted_by === user.id) return { allowed: true };
  if (user.role === 'reviewer') return authorizeQuestionReview(user, resource);
  if (user.role === 'hod') {
    const hasScope = await checkScope(user.id, 'hod', { campus_id: q.campus_id, department_id: q.department_id });
    return hasScope ? { allowed: true } : { allowed: false, reason: 'Cross-campus or out-of-scope access denied' };
  }
  return { allowed: false, reason: 'Only the author, its assigned reviewers and the HOD can see this question\'s review workflow' };
}

async function authorizeReviewerAssignment(user, resource) {
  const { reviewer_id, question_author_id, campus_id, department_id } = resource;

  // Only HOD can assign reviewers
  if (user.role !== 'hod') {
    return { allowed: false, reason: 'Only HOD can assign reviewers' };
  }

  // Check HOD has scope for this department/campus
  const hasScope = await checkScope(user.id, 'hod', { campus_id, department_id });
  if (!hasScope) {
    return { allowed: false, reason: 'No scope for this department' };
  }

  // Conflict check: reviewer ≠ author
  if (reviewer_id === question_author_id) {
    return { allowed: false, reason: 'Reviewer cannot be the question author' };
  }

  // Check reviewer is active
  const reviewer = await get('SELECT status FROM users WHERE id = $1', [reviewer_id]);
  if (!reviewer || reviewer.status !== 'ACTIVE') {
    return { allowed: false, reason: 'Reviewer is not active' };
  }

  // Check reviewer has required scope
  const reviewerHasScope = await checkScope(reviewer_id, 'reviewer', { campus_id, department_id });
  if (!reviewerHasScope) {
    return { allowed: false, reason: 'Reviewer does not have required scope' };
  }

  return { allowed: true };
}

async function loadQuestionContext(question_id) {
  return get(`
    SELECT q.id, q.submitted_by, q.course_offering_id, co.campus_id, co.program_id, p.department_id
    FROM questions q
    JOIN course_offerings co ON co.id = q.course_offering_id
    JOIN programs p ON p.id = co.program_id
    WHERE q.id = $1
  `, [question_id]);
}

// Reviewer must: be a reviewer, not be the author, hold campus scope, and be
// actively assigned (by the HOD) to the question's course offering.
async function authorizeQuestionReview(user, resource) {
  if (user.role !== 'reviewer') {
    return { allowed: false, reason: 'Only reviewers can review questions' };
  }
  const q = await loadQuestionContext(resource.question_id);
  if (!q) return { allowed: false, reason: 'Question not found' };

  if (user.id === q.submitted_by) {
    return { allowed: false, reason: 'Cannot review your own question' };
  }
  // The program is passed too: a reviewer scope limited to one program (the shape assignments grant) does not
  // cover another program of the same department.
  const hasScope = await checkScope(user.id, 'reviewer', { campus_id: q.campus_id, department_id: q.department_id, program_id: q.program_id });
  if (!hasScope) return { allowed: false, reason: 'Cross-campus or out-of-scope access denied' };

  const assignment = await get(`
    SELECT id FROM reviewer_assignments
    WHERE course_offering_id = $1 AND reviewer_id = $2 AND is_active = true
  `, [q.course_offering_id, user.id]);
  if (!assignment) return { allowed: false, reason: 'Not assigned to review this course offering' };

  return { allowed: true };
}

async function authorizeQuestionSubmit(user, resource) {
  const q = await loadQuestionContext(resource.question_id);
  if (!q) return { allowed: false, reason: 'Question not found' };
  if (!['teacher', 'hod'].includes(user.role) || q.submitted_by !== user.id) {
    return { allowed: false, reason: 'Only the question author can submit' };
  }
  return { allowed: true };
}

// HOD actions (assign for review, retire, restore) within HOD's own scope. A reviewer may retire or restore
// only questions of an offering they are actively assigned to (the same rule as reviewing it).
async function authorizeQuestionManage(user, resource) {
  if (!['hod', 'reviewer'].includes(user.role)) {
    return { allowed: false, reason: 'Only HOD or reviewer can perform this action' };
  }
  if (resource.action === 'assign_review' && user.role !== 'hod') {
    return { allowed: false, reason: 'Only HOD can assign questions for review' };
  }
  if (user.role === 'reviewer') return authorizeQuestionReview(user, resource);
  const q = await loadQuestionContext(resource.question_id);
  if (!q) return { allowed: false, reason: 'Question not found' };
  const hasScope = await checkScope(user.id, user.role, { campus_id: q.campus_id, department_id: q.department_id });
  if (!hasScope) return { allowed: false, reason: 'Cross-campus or out-of-scope access denied' };
  return { allowed: true };
}

// --- Academic structure and content (academic.js) ---

// The HOD of the department, through an active hod scope (user_scopes, never users.department_id). user_has_scope
// treats a NULL level as "any", so an unknown campus/department is DENIED here, never widened.
async function authorizeAcademicManage(user, r) {
  if (user.role !== 'hod') return { allowed: false, reason: 'Only the HOD of this department can do this' };
  if (!r.campus_id || !r.department_id) return { allowed: false, reason: 'Unknown academic context' };
  return (await checkScope(user.id, 'hod', { campus_id: r.campus_id, department_id: r.department_id }))
    ? { allowed: true } : { allowed: false, reason: 'Outside your department/campus scope' };
}

// Syllabus content of an offering: the HOD in scope, a teacher actively assigned to the offering, or a reviewer
// actively assigned to it who still holds reviewer scope (the same rule as reviewing its questions).
async function authorizeAcademicRead(user, r) {
  if (user.role === 'hod') return authorizeAcademicManage(user, r);
  if (!r.course_offering_id || !r.campus_id || !r.department_id) return { allowed: false, reason: 'Unknown academic context' };
  if (user.role === 'teacher') {
    const a = await get('SELECT 1 AS x FROM teacher_course_assignments WHERE teacher_id = $1 AND course_offering_id = $2 AND is_active = TRUE', [user.id, r.course_offering_id]);
    return a ? { allowed: true } : { allowed: false, reason: 'You are not assigned to that course offering' };
  }
  if (user.role === 'reviewer') {
    if (!(await checkScope(user.id, 'reviewer', { campus_id: r.campus_id, department_id: r.department_id, program_id: r.program_id ?? null }))) {
      return { allowed: false, reason: 'Cross-campus or out-of-scope access denied' };
    }
    const a = await get(`
    SELECT id FROM reviewer_assignments
    WHERE course_offering_id = $1 AND reviewer_id = $2 AND is_active = true
  `, [r.course_offering_id, user.id]);
    return a ? { allowed: true } : { allowed: false, reason: 'Not assigned to review this course offering' };
  }
  return { allowed: false, reason: "Syllabus content is visible only to the offering's HOD, assigned teachers and assigned reviewers" };
}

// The HOD sees a teacher's submission-quality report only when the teacher teaches, or has submitted, in an
// offering the HOD's scope covers. notFound: the route answers 404 so other departments' staff are not confirmed.
async function authorizeTeacherQuality(user, { teacher_id }) {
  if (user.role !== 'hod') return { allowed: false, reason: "Only the HOD reviews a teacher's submissions" };
  const r = await get(`
    SELECT EXISTS (SELECT 1 FROM users t WHERE t.id = $3 AND t.role = 'teacher' AND (
        EXISTS (SELECT 1 FROM teacher_course_assignments tca JOIN course_offerings co ON co.id = tca.course_offering_id
                JOIN programs p ON p.id = co.program_id WHERE tca.teacher_id = t.id AND ${SCOPE_SQL})
     OR EXISTS (SELECT 1 FROM questions q JOIN course_offerings co ON co.id = q.course_offering_id
                JOIN programs p ON p.id = co.program_id WHERE q.submitted_by = t.id AND ${SCOPE_SQL}))) AS ok`,
  [user.id, 'hod', teacher_id]);
  return r?.ok ? { allowed: true } : { allowed: false, reason: 'Teacher not found in your scope', notFound: true };
}

// HOD within their scope; a reviewer only for offerings they are actively assigned to, inside reviewer scope.
async function authorizeAnalytics(user, { course_offering_id }) {
  if (!['hod', 'reviewer'].includes(user.role)) return { allowed: false, reason: 'Analytics is for the HOD and reviewers' };
  if (!course_offering_id) {
    return (await getUserCampusIds(user.id, user.role)).length ? { allowed: true } : { allowed: false, reason: 'No scope' };
  }
  const ctx = await offeringContext(course_offering_id);
  if (!ctx) return { allowed: false, reason: 'Course offering not found' };
  if (!ctx.campus_id || !ctx.department_id
      || !(await checkScope(user.id, user.role, { campus_id: ctx.campus_id, department_id: ctx.department_id,
        program_id: user.role === 'reviewer' ? ctx.program_id : null }))) {
    return { allowed: false, reason: 'That course offering is outside your scope' };
  }
  if (user.role === 'reviewer') {
    const a = await get(`
    SELECT id FROM reviewer_assignments
    WHERE course_offering_id = $1 AND reviewer_id = $2 AND is_active = true
  `, [ctx.course_offering_id, user.id]);
    if (!a) return { allowed: false, reason: 'Not assigned to this course offering' };
  }
  return { allowed: true };
}

// The calling reviewer's live seat on a batch: not revoked, the reviewer assignment still active and its
// offering still inside the reviewer's scope. A deactivated assignment or a revoked scope ends access at once.
export async function reviewerSeat(batchId, userId, db = { get }) {
  return db.get(`
    SELECT rbr.id, rbr.status FROM review_batch_reviewers rbr JOIN reviewer_assignments ra ON ra.id = rbr.reviewer_assignment_id
    WHERE rbr.review_batch_id = $1 AND ra.reviewer_id = $2 AND rbr.status != 'revoked' AND ra.is_active = TRUE
      AND EXISTS (SELECT 1 FROM review_batches rb JOIN course_offerings co ON co.id = rb.course_offering_id
                  JOIN programs p ON p.id = co.program_id
                  WHERE rb.id = rbr.review_batch_id AND ra.course_offering_id = rb.course_offering_id
                    AND user_has_scope($2, 'reviewer', co.campus_id, p.department_id, co.program_id, NULL))`, [batchId, userId]);
}

// HOD of the batch's offering (scope); a reviewer with a live seat may view, never manage.
async function authorizeReviewBatch(user, { review_batch_id, course_offering_id, manage }) {
  let offeringId = course_offering_id;
  if (!offeringId) {
    const b = await get('SELECT id, course_offering_id FROM review_batches WHERE id = $1', [review_batch_id]);
    if (!b) return { allowed: false, reason: 'Not found', notFound: true };
    offeringId = b.course_offering_id;
  }
  if (user.role === 'hod') {
    const ctx = await offeringContext(offeringId);
    if (!ctx?.campus_id || !ctx?.department_id) return { allowed: false, reason: 'Unknown academic context' };
    return (await checkScope(user.id, 'hod', { campus_id: ctx.campus_id, department_id: ctx.department_id }))
      ? { allowed: true } : { allowed: false, reason: 'That review batch is outside your scope' };
  }
  if (!manage && user.role === 'reviewer') {
    return (await reviewerSeat(review_batch_id, user.id)) ? { allowed: true } : { allowed: false, reason: 'You are not assigned to this review batch' };
  }
  return { allowed: false, reason: manage ? 'Only the HOD manages review batches' : 'Not allowed to see this review batch' };
}

// --- Examination Domain Authorization ---

// resource: the examination's context { campus_id, department_id?, program_id, course_offering_id? } (paper-access.js
// paperScope); every level given is checked, so program- and offering-limited COE scopes are honoured.
async function authorizePaperGeneration(user, resource) {
  const { campus_id, department_id, program_id, course_offering_id } = resource;

  // Must be COE
  if (user.role !== 'coe') {
    return { allowed: false, reason: 'Only COE can generate papers' };
  }

  // Check scope
  const hasScope = await checkScope(user.id, 'coe', { campus_id, department_id, program_id, course_offering_id });
  if (!hasScope) {
    return { allowed: false, reason: 'No scope for this campus/program' };
  }

  return { allowed: true };
}

// Spec §27 conflict rules (validator ≠ COE, ≠ author, active, campus scope, optional ≠ reviewer). The rules
// live in validator-eligibility.js so assignment, replacement, the candidate list and the decision-time
// re-check all apply the same set. resource: { validator_id, coe_ids, paper_id, campus_id }.
async function authorizeValidatorAssignment(user, resource) {
  // Must be COE
  if (user.role !== 'coe') {
    return { allowed: false, reason: 'Only COE can assign validators' };
  }
  const { validator_id, paper_id, campus_id, department_id, program_id, course_offering_id } = resource;
  // The assigning COE's own scope must cover the paper's examination (not just its campus).
  if (!(await checkScope(user.id, 'coe', { campus_id, department_id, program_id, course_offering_id }))) {
    return { allowed: false, reason: 'No COE scope for this examination' };
  }
  const coeIds = (resource.coe_ids || [resource.coe_id]).filter(Boolean);
  const problems = (await validatorProblems({ get, all: query }, {
    paper: { id: paper_id, campus_id, department_id, program_id, course_offering_id }, validatorIds: [validator_id], coeIds,
  })).get(validator_id);
  return problems.length ? { allowed: false, reason: problems.join('; '), reasons: problems } : { allowed: true };
}

async function authorizePaperValidation(user, resource) {
  const { paper_id } = resource;

  // Must be validator
  if (user.role !== 'validator') {
    return { allowed: false, reason: 'Only validators can validate papers' };
  }

  // Check if assigned to this paper
  const assignment = await get(`
    SELECT id FROM paper_validator_assignments
    WHERE paper_id = $1 AND validator_id = $2 AND is_active = true
  `, [paper_id, user.id]);

  if (!assignment) {
    return { allowed: false, reason: 'Not assigned to validate this paper' };
  }

  return { allowed: true };
}

async function authorizeCOEApproval(user, resource) {
  const { paper_id, campus_id, department_id, program_id, course_offering_id } = resource;

  // Must be COE
  if (user.role !== 'coe') {
    return { allowed: false, reason: 'Only COE can approve papers' };
  }

  // Check scope: the paper's whole context, so a program-limited COE cannot approve another program's paper.
  const hasScope = await checkScope(user.id, 'coe', { campus_id, department_id, program_id, course_offering_id });
  if (!hasScope) {
    return { allowed: false, reason: 'No COE scope for this examination' };
  }

  // Check all validators have approved
  const validatorCount = await get(`
    SELECT COUNT(*)::int as total,
           COUNT(*) FILTER (WHERE decision = 'APPROVE')::int as approved
    FROM paper_validator_assignments
    WHERE paper_id = $1 AND is_active = true
  `, [paper_id]);

  if (validatorCount.total !== VALIDATOR_COUNT) {
    return { allowed: false, reason: `Paper must have exactly ${VALIDATOR_COUNT} validators` };
  }

  // Spec §27: all 4 by default; configurable threshold frozen on the paper (see paper-policy.js).
  const required = normalizeRequiredApprovals(resource.required_approvals);
  if (validatorCount.approved < required) {
    return { allowed: false, reason: `At least ${required} of ${VALIDATOR_COUNT} validators must approve before COE approval (currently: ${validatorCount.approved})` };
  }

  return { allowed: true };
}

// --- Helper: Log authorization decision ---

async function logAuthzDecision(user, action, resource, decision, reason) {
  try {
    await query(`
      INSERT INTO authorization_log
        (user_id, action, resource_type, resource_id, decision, reason, campus_id, department_id, correlation_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      user.id,
      action,
      resource.type || 'unknown',
      resource.id || null,
      decision,
      reason || null,
      resource.campus_id || null,
      resource.department_id || null,
      resource.correlation_id || null
    ]);
  } catch (err) {
    console.error('Failed to log authorization decision:', JSON.stringify(describeError(err)));
  }
}
