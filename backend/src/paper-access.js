// Shared access rules for examination-domain papers (spec §4: COE/validator
// access is restricted to their examination assignments/scope). Used by
// routes/examinations.js and routes/coe-approval.js so both apply the same check.
// Access also follows the paper status (paper-policy.js paperAccessFor): a COE whose scope covers the
// paper's examination (campus, department, program and offering, user_has_scope) sees the paper and its
// answer key in every status; an actively assigned validator only while it is under validation
// (VALIDATION_PENDING or VALIDATED) AND only while they are still eligible (validator scope for the
// examination, active account, no COE/author conflict, the independence policy): the same rules the decision
// route re-checks (validator-eligibility.js). A validator who lost scope or became conflicted after the
// assignment loses the paper, the answer key and issue reporting at once, not when the COE replaces them.
// From COE approval on, and on superseded revisions, validators are out.
import { get, all } from './db.js';
import { paperAccessFor } from './paper-policy.js';
import { validatorProblems } from './validator-eligibility.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// null for an unknown or malformed id, so every /examinations and /coe paper route answers 404, never a 500.
export async function loadPaper(paperId) {
  if (!UUID_RE.test(String(paperId))) return null;
  return get(`
    SELECT ep.*, e.campus_id, e.program_id, pr.department_id, e.exam_type, e.maximum_marks, e.course_offering_id AS exam_offering_id
    FROM exam_papers ep JOIN examinations e ON e.id = ep.examination_id JOIN programs pr ON pr.id = e.program_id
    WHERE ep.id = $1`, [paperId]);
}

// The academic context a paper (loadPaper row) or an examination (examinations row joined with programs for
// department_id) belongs to, in the shape authorize()/user_has_scope expect.
export const paperScope = (paper) => ({
  campus_id: paper.campus_id, department_id: paper.department_id ?? null, program_id: paper.program_id ?? null,
  course_offering_id: paper.exam_offering_id ?? null,
});
export const examScope = (exam) => ({
  campus_id: exam.campus_id, department_id: exam.department_id ?? null, program_id: exam.program_id ?? null,
  course_offering_id: exam.course_offering_id ?? null,
});

// The same context read inside a transaction (decision and issue routes), keyed like a loadPaper row.
export async function paperContext(db, examinationId) {
  return db.get(`SELECT e.campus_id, e.program_id, e.course_offering_id AS exam_offering_id, pr.department_id
                 FROM examinations e JOIN programs pr ON pr.id = e.program_id WHERE e.id = $1`, [examinationId]);
}

// Does this COE's scope cover that context? Program-, department- and offering-limited scopes are honoured
// (a campus-only check would let a COE of program P1 act on program P2's papers and answer keys).
export async function coeCovers(user, s) {
  const row = await get('SELECT user_has_scope($1, $2, $3, $4, $5, $6) AS has_scope',
    [user.id, 'coe', s.campus_id, s.department_id ?? null, s.program_id ?? null, s.course_offering_id ?? null]);
  return row?.has_scope === true;
}
export const coeCoversPaper = (user, paper) => coeCovers(user, paperScope(paper));

// { view, answerKey, reportIssue, decide, reason? } for this user on this paper.
export async function paperAccess(user, paper) {
  const none = paperAccessFor({ role: null });
  if (!paper || !user) return none;
  if (user.role === 'coe') {
    return paperAccessFor({ role: 'coe', inScope: await coeCoversPaper(user, paper), paperStatus: paper.paper_status });
  }
  if (user.role === 'validator') {
    const mine = await get('SELECT id, assigned_by FROM paper_validator_assignments WHERE paper_id = $1 AND validator_id = $2 AND is_active', [paper.id, user.id]);
    const open = paperAccessFor({ role: 'validator', assignedActive: !!mine, paperStatus: paper.paper_status });
    if (!open.view) return none;
    // Still eligible now (the decision route runs the same check under its locks).
    const problems = (await validatorProblems({ get, all }, { paper, validatorIds: [user.id],
      coeIds: [mine.assigned_by, paper.generated_by].filter(Boolean) })).get(user.id);
    if (problems.length) return { ...none, reason: `You can no longer work on this paper: ${problems.join('; ')}` };
    return open;
  }
  return none;
}

// COE in scope, or an eligible validator actively assigned while the paper is under validation. Anything else is denied.
export async function canSeePaper(user, paper) {
  return (await paperAccess(user, paper)).view;
}
