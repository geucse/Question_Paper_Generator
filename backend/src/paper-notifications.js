// In-app notifications of the paper workflow (spec §27). Called AFTER the change has committed; like
// notifications.js, a failure here is logged and never undoes or blocks the action.
import { get, all } from './db.js';
import { notifyMany } from './notifications.js';
import { validatorProblems } from './validator-eligibility.js';

async function safe(fn) {
  try { return await fn(); } catch (err) { console.error('Paper notification failed (non-fatal):', err.message); return null; }
}

// "CS101 end_term paper v2" — enough for the recipient to find the paper, nothing more.
export async function paperLabel(paperId) {
  const r = await get(`
    SELECT ep.paper_version, e.exam_type, s.subject_code
    FROM exam_papers ep JOIN examinations e ON e.id = ep.examination_id JOIN subjects s ON s.id = e.subject_id
    WHERE ep.id = $1`, [paperId]);
  return r ? `${r.subject_code} ${r.exam_type} paper v${r.paper_version}` : 'Examination paper';
}

// The paper's COEs: active COE accounts that generated it, created its examination or assigned its active
// validators, and that still hold COE scope for the examination's campus.
export async function paperCoeIds(paperId) {
  const rows = await all(`
    SELECT DISTINCT u.id FROM users u
    JOIN exam_papers ep ON ep.id = $1 JOIN examinations e ON e.id = ep.examination_id
    WHERE u.role = 'coe' AND u.is_active
      AND (u.id = ep.generated_by OR u.id = e.created_by
           OR u.id IN (SELECT assigned_by FROM paper_validator_assignments WHERE paper_id = $1 AND is_active))
      AND user_has_scope(u.id, 'coe', e.campus_id)`, [paperId]);
  return rows.map((r) => r.id);
}

export async function notifyPaperCoes(paperId, type, text) {
  return safe(async () => notifyMany(await paperCoeIds(paperId), type, `${await paperLabel(paperId)}: ${text}`, paperId));
}

export async function notifyValidators(validatorIds, paperId, type, text) {
  if (!validatorIds?.length) return null;
  return safe(async () => notifyMany([...new Set(validatorIds)], type, `${await paperLabel(paperId)}: ${text}`, paperId));
}

// Validators whose assignments a supersession trigger ended (migration 039). Each paper is regenerated or
// archived once, so the rows with that reason are exactly the ones just ended.
export async function notifyEndedAssignments(paperId, reason, text) {
  return safe(async () => {
    const rows = await all('SELECT DISTINCT validator_id FROM paper_validator_assignments WHERE paper_id = $1 AND deactivation_reason = $2', [paperId, reason]);
    return notifyValidators(rows.map((r) => r.validator_id), paperId, 'validation_ended', text);
  });
}

// A validator was deactivated or lost scope: tell the COE of each paper where they still have an undecided
// active assignment that can no longer be completed, so the COE replaces them.
export async function notifyValidatorsNeedingReplacement(validatorId, why) {
  return safe(async () => {
    const rows = await all(`
      SELECT pva.paper_id, pva.validator_number, ep.generated_by, e.campus_id
      FROM paper_validator_assignments pva JOIN exam_papers ep ON ep.id = pva.paper_id JOIN examinations e ON e.id = ep.examination_id
      WHERE pva.validator_id = $1 AND pva.is_active AND pva.decision IS NULL AND ep.paper_status = 'VALIDATION_PENDING'`, [validatorId]);
    for (const r of rows) {
      const problems = (await validatorProblems({ get, all }, {
        paper: { id: r.paper_id, campus_id: r.campus_id }, validatorIds: [validatorId], coeIds: [r.generated_by],
      })).get(validatorId);
      if (problems.length) {
        await notifyPaperCoes(r.paper_id, 'validator_needs_replacement', `validator ${r.validator_number} ${why}; replace them to finish validation`);
      }
    }
    return rows.length;
  });
}
