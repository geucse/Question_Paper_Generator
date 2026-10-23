// Validator issues across paper revisions (PIVOT_SPEC_V2 §27, §30). The examination side never writes the
// question bank (§1): a referral only records the request and notifies the people who can fix the source.
import { hodsInScope } from './scopes.js';
import { planIssueCarry } from './paper-policy.js';

export class IssueConflict extends Error {
  constructor(message = 'The issue changed meanwhile; reload and try again') { super(message); this.status = 409; }
}

// Runs INSIDE the regeneration transaction, after the new revision is GENERATED and before the parent leaves
// GENERATED/CHANGES_REQUIRED (issues of a REGENERATED paper can no longer be closed, migration 039).
// Open issues about a question the new revision dropped are resolved by the replacement; the others are
// copied onto the new revision and the parent's row becomes carried_forward.
export async function carryIssuesToRevision(txn, { parentPaperId, newPaperId, newVersion, questionIds, userId }) {
  const open = await txn.all(`SELECT * FROM paper_issues WHERE paper_id = $1 AND status = 'open' ORDER BY created_at FOR UPDATE`, [parentPaperId]);
  const { resolve, carry } = planIssueCarry(open, questionIds);
  for (const i of resolve) {
    const r = await txn.run(`UPDATE paper_issues SET status = 'resolved', resolution = $2, resolved_by = $3, resolved_at = now(), updated_at = now()
                             WHERE id = $1 AND status = 'open' RETURNING id`,
      [i.id, `Question replaced by regeneration (paper v${newVersion})`, userId]);
    if (r.rowCount !== 1) throw new IssueConflict();
  }
  const carried = [];
  for (const i of carry) {
    const copy = await txn.get(`
      INSERT INTO paper_issues (paper_id, question_id, issue_type, description, reported_by, carried_from_issue_id, origin_issue_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [newPaperId, i.question_id, i.issue_type, i.description, i.reported_by, i.id, i.origin_issue_id || i.id]);
    const r = await txn.run(`UPDATE paper_issues SET status = 'carried_forward', resolution = $2, resolved_by = $3, resolved_at = now(),
                               carried_to_issue_id = $4, updated_at = now()
                             WHERE id = $1 AND status = 'open' RETURNING id`,
      [i.id, `Still open; carried to paper v${newVersion}`, userId, copy.id]);
    if (r.rowCount !== 1) throw new IssueConflict();
    carried.push({ from: i.id, to: copy.id, question_id: i.question_id });
  }
  return {
    open_issue_ids: open.map((i) => i.id),
    resolved: resolve.map((i) => ({ issue_id: i.id, question_id: i.question_id })),
    carried,
  };
}

// Who fixes the source question (§27 "Reviewer separately fixes the source question"): the active reviewers
// assigned to the question's offering who hold reviewer scope; otherwise the HODs whose scope covers it.
// Never the author. Returns { role, ids } or null when the question does not exist.
export async function referralRecipients(db, questionId) {
  const q = await db.get(`
    SELECT q.submitted_by, q.course_offering_id, co.campus_id, p.department_id
    FROM questions q JOIN course_offerings co ON co.id = q.course_offering_id JOIN programs p ON p.id = co.program_id
    WHERE q.id = $1`, [questionId]);
  if (!q) return null;
  const reviewers = await db.all(`
    SELECT DISTINCT u.id FROM reviewer_assignments ra JOIN users u ON u.id = ra.reviewer_id
    WHERE ra.course_offering_id = $1 AND ra.is_active AND u.is_active AND u.role = 'reviewer' AND u.id IS DISTINCT FROM $2
      AND user_has_scope(u.id, 'reviewer', $3, $4, NULL, NULL)`, [q.course_offering_id, q.submitted_by, q.campus_id, q.department_id]);
  if (reviewers.length) return { role: 'reviewer', ids: reviewers.map((r) => r.id) };
  const hods = (await hodsInScope(q.course_offering_id)).filter((h) => h.id !== q.submitted_by);
  return { role: 'hod', ids: hods.map((h) => h.id) };
}
