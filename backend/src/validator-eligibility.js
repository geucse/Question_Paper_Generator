// Who may validate a paper (PIVOT_SPEC_V2 §27). One rule set, used when the COE assigns, replaces or lists
// validators and again inside the decision transaction, so a validator who lost scope, was deactivated or
// became conflicted after assignment cannot decide.
// The author and reviewer sets are the SQL functions paper_question_authors() / paper_question_reviewers()
// (migration 039). This module imports nothing from authorization.js, so authorization.js can use it.

export const CONFLICT = {
  missing: 'Validator account not found',
  notValidator: 'User is not a validator',
  inactive: 'Validator is not active',
  scope: 'Validator does not have required scope',
  coe: 'COE cannot be a validator for their own paper',
  author: 'Validator cannot be an author of questions in the paper',
};
export const reviewerConflict = (sources) =>
  `Validator reviewed a question in this paper (${sources.join(', ')}); institutional policy requires independent validators`;

// Pure, so the set-based listing and validatorProblems produce identical text, in a stable order.
// Both status and is_active are checked: academic.js deactivation sets only is_active, and the 025 sync
// trigger maps status -> is_active, never the reverse.
export function conflictReasons({ user, hasScope, isCoe, isAuthor, reviewerSources = [], policyOn }) {
  if (!user) return [CONFLICT.missing];
  const out = [];
  if (user.role !== 'validator') out.push(CONFLICT.notValidator);
  if (user.status !== 'ACTIVE' || user.is_active === false) out.push(CONFLICT.inactive);
  if (!hasScope) out.push(CONFLICT.scope);
  if (isCoe) out.push(CONFLICT.coe);
  if (isAuthor) out.push(CONFLICT.author);
  if (policyOn && reviewerSources.length) out.push(reviewerConflict([...new Set(reviewerSources)].sort()));
  return out;
}

// Optional institutional policy (admin setting, routes/admin.js): validator ≠ reviewer of any question in the paper.
export async function independencePolicyOn(db) {
  const r = await db.get("SELECT value FROM system_state WHERE key = 'validator_excludes_question_reviewers'");
  return String(r?.value).toLowerCase() === 'true';
}

// The examination context a validator's scope must cover: campus, and the department, program and offering when
// known, so a program- or offering-limited validator scope is honoured (user_has_scope treats NULL as "any").
export const scopeParams = (paper) => [paper.campus_id, paper.department_id ?? null, paper.program_id ?? null,
  paper.exam_offering_id ?? paper.course_offering_id ?? null];

// db: { get, all } — the pool helpers or a withTransaction txn. paper: { id, campus_id, department_id?, program_id?,
// exam_offering_id? } (paper-access.js loadPaper returns all of them).
// coeIds: the paper's COEs (the acting/assigning COE and exam_papers.generated_by).
// lock = true inside an assignment/decision transaction: the users row and validator scope rows are read
// FOR SHARE, so a concurrent deactivation or scope revocation waits for (or is seen by) this transaction.
// Lock order everywhere: paper row, then assignment rows, then users / user_scopes.
// Returns Map(validatorId -> [reasons]); an empty list means eligible.
export async function validatorProblems(db, { paper, validatorIds, coeIds = [], lock = false }) {
  const authors = new Set((await db.all('SELECT author_id FROM paper_question_authors($1)', [paper.id])).map((r) => r.author_id));
  const policyOn = await independencePolicyOn(db);
  const reviewers = policyOn ? await db.all('SELECT reviewer_id, source FROM paper_question_reviewers($1)', [paper.id]) : [];
  const out = new Map();
  for (const id of [...new Set(validatorIds)]) {
    const user = await db.get(`SELECT id, role, status, is_active FROM users WHERE id = $1${lock ? ' FOR SHARE' : ''}`, [id]);
    if (lock && user) await db.all("SELECT id FROM user_scopes WHERE user_id = $1 AND role = 'validator' AND is_active FOR SHARE", [id]);
    const s = user ? await db.get('SELECT user_has_scope($1, $2, $3, $4, $5, $6) AS has_scope', [id, 'validator', ...scopeParams(paper)]) : null;
    out.set(id, conflictReasons({
      user, hasScope: s?.has_scope === true, isCoe: coeIds.includes(id), isAuthor: authors.has(id),
      reviewerSources: reviewers.filter((r) => r.reviewer_id === id).map((r) => r.source), policyOn,
    }));
  }
  return out;
}

// Candidates for GET /examinations/validators?paper_id= in one query (no N+1): every validator with a
// validator scope on the paper's campus, each with its conflicts. Inactive accounts are listed with their
// conflict rather than hidden, so the COE sees why someone cannot be chosen.
export async function candidateValidators(db, { paper, coeIds = [] }) {
  const policyOn = await independencePolicyOn(db);
  const rows = await db.all(`
    WITH a AS (SELECT author_id FROM paper_question_authors($1)),
         r AS (SELECT reviewer_id, array_agg(DISTINCT source ORDER BY source) AS sources FROM paper_question_reviewers($1) GROUP BY 1)
    SELECT DISTINCT u.id, u.full_name, u.email, u.role, u.status, u.is_active,
           user_has_scope(u.id, 'validator', $2, $3, $4, $5) AS has_scope,
           EXISTS (SELECT 1 FROM a WHERE a.author_id = u.id) AS is_author,
           COALESCE(r.sources, '{}') AS reviewer_sources,
           (SELECT v.validator_number FROM paper_validator_assignments v WHERE v.paper_id = $1 AND v.validator_id = u.id AND v.is_active) AS assigned_as
    FROM users u
    JOIN user_scopes s ON s.user_id = u.id AND s.role = 'validator' AND s.is_active AND s.campus_id = $2
    LEFT JOIN r ON r.reviewer_id = u.id
    WHERE u.role = 'validator'
    ORDER BY u.email`, [paper.id, ...scopeParams(paper)]);
  return rows.map((u) => ({
    id: u.id, full_name: u.full_name, email: u.email, assigned_as: u.assigned_as ?? null,
    conflicts: conflictReasons({
      user: u, hasScope: u.has_scope === true, isCoe: coeIds.includes(u.id), isAuthor: u.is_author === true,
      reviewerSources: u.reviewer_sources || [], policyOn,
    }),
  }));
}
