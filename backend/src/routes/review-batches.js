import express from 'express';
import { get, all, run, withTransaction } from '../db.js';
import { requireAuth, requireRole } from '../middleware.js';
import { logAudit } from '../audit.js';
import { notify, notifyMany } from '../notifications.js';
import { authorize, reviewerSeat } from '../authorization.js';
import { SCOPE_SQL, offeringContext } from '../scopes.js';
import { QUESTION_ATTACHMENTS_SQL } from '../paper-attachments.js';
import { CLASSIFICATION_FIELDS, classificationState, reviewDecisionState, openReviewItem } from '../review-decision.js';

import { validateUnitTopicPair } from './academic.js';
import { BLOOM_LEVELS } from '../taxonomy.js';

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOSED = ['closed', 'cancelled'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];
// Bloom levels: the shared definition (taxonomy.js).
const isId = (v) => typeof v === 'string' && UUID_RE.test(v);

// Spec §12: metadata changes must record old value, new value, reason, who and when.
// Returns the verified fields a resolution would change on the canonical question.
// A change that overwrites an existing verified value needs a reason; filling an empty one does not.
async function verifiedFieldChanges(questionId, finals) {
  const cq = await get(`
    SELECT cq.id, cq.verified_difficulty, cq.verified_bloom_level, cq.verified_syllabus_unit_id, cq.verified_syllabus_topic_id,
           cq.verified_syllabus_subtopic_id
    FROM questions q JOIN canonical_questions cq ON cq.id = q.canonical_question_id WHERE q.id = $1`, [questionId]);
  if (!cq) return [];
  const cos = (await all(`SELECT course_outcome_id FROM question_course_outcomes WHERE canonical_question_id = $1 ORDER BY course_outcome_id`, [cq.id]))
    .map((r) => r.course_outcome_id);
  const pairs = [
    ['difficulty', cq.verified_difficulty, finals.final_difficulty],
    ['bloom_level', cq.verified_bloom_level, finals.final_bloom_level],
    ['syllabus_unit_id', cq.verified_syllabus_unit_id, finals.final_syllabus_unit_id],
    ['syllabus_topic_id', cq.verified_syllabus_topic_id, finals.final_syllabus_topic_id],
    ['syllabus_subtopic_id', cq.verified_syllabus_subtopic_id, finals.final_syllabus_subtopic_id],
  ];
  const changes = pairs
    .filter(([, , next]) => !!next)
    .filter(([, prev, next]) => String(prev ?? '') !== String(next))
    .map(([field, prev, next]) => ({ field, old_value: prev ?? null, new_value: next, overwrites: prev != null }));
  if (finals.final_course_outcome_id && !cos.includes(finals.final_course_outcome_id)) {
    changes.push({ field: 'course_outcomes', old_value: cos, new_value: [...cos, finals.final_course_outcome_id], overwrites: false });
  }
  return changes;
}

// Shared by both the manual HOD/admin /resolve endpoint and the automatic
// consensus finalization below — the only two places allowed to write
// canonical_questions.verified_*. Writes only the fields actually given
// (never guesses at a field nobody classified), and always leaves an
// explicit review_resolutions row as the record of how the value was
// decided (spec sections 22-23: explicit record, never a silent average).
// verifierIds (042): every reviewer whose verdicts formed a consensus; the recorded verifier (verified_by) is
// decidedBy, else the first of them, so a consensus of several reviewers is a verified mapping too.
async function recordResolution(questionId, { finalDifficulty, finalBloomLevel, finalCourseOutcomeId, finalSyllabusUnitId, finalSyllabusTopicId, finalSyllabusSubtopicId }, resolutionMethod, decidedBy, reason, verifierIds = null) {
  const verifier = decidedBy || verifierIds?.[0] || null;
  const reviewerIds = verifierIds?.length ? verifierIds : null;
  return withTransaction(async (txn) => {
    const resolution = await txn.get(`
      INSERT INTO review_resolutions
        (question_id, final_difficulty, final_bloom_level, final_course_outcome_id, final_syllabus_unit_id, final_syllabus_topic_id,
         final_syllabus_subtopic_id, resolution_method, decided_by, reason, verified_by_reviewer_ids)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid[]) RETURNING *
    `, [questionId, finalDifficulty || null, finalBloomLevel || null, finalCourseOutcomeId || null,
        finalSyllabusUnitId || null, finalSyllabusTopicId || null, finalSyllabusSubtopicId || null, resolutionMethod, decidedBy || null, reason || null, reviewerIds]);

    const q = await txn.get('SELECT canonical_question_id, submitted_by FROM questions WHERE id = $1', [questionId]);
    if (q?.canonical_question_id) {
      const sets = [];
      const params = [];
      let i = 1;
      if (finalDifficulty) { sets.push(`verified_difficulty = $${i++}`); params.push(finalDifficulty); }
      if (finalBloomLevel) { sets.push(`verified_bloom_level = $${i++}`); params.push(finalBloomLevel); }
      if (finalSyllabusUnitId) { sets.push(`verified_syllabus_unit_id = $${i++}`); params.push(finalSyllabusUnitId); }
      if (finalSyllabusTopicId) { sets.push(`verified_syllabus_topic_id = $${i++}`); params.push(finalSyllabusTopicId); }
      if (finalSyllabusSubtopicId) { sets.push(`verified_syllabus_subtopic_id = $${i++}`); params.push(finalSyllabusSubtopicId); }
      else if (finalSyllabusTopicId) {
        // A new topic without a subtopic: a verified subtopic of another topic no longer applies.
        sets.push(`verified_syllabus_subtopic_id = CASE WHEN verified_syllabus_subtopic_id IN (SELECT id FROM syllabus_subtopics WHERE syllabus_topic_id = $${i++}) THEN verified_syllabus_subtopic_id ELSE NULL END`);
        params.push(finalSyllabusTopicId);
      }
      if (sets.length > 0) {
        sets.push(`verified_by = $${i++}`); params.push(verifier);
        sets.push(`verified_by_reviewer_ids = $${i++}::uuid[]`); params.push(reviewerIds);
        sets.push(`verified_at = now()`);
        sets.push(`quality_status = 'human_verified'`);
        params.push(q.canonical_question_id);
        await txn.run(`UPDATE canonical_questions SET ${sets.join(', ')} WHERE id = $${i}`, params);
      }
      if (finalCourseOutcomeId) {
        await txn.run(`
          INSERT INTO question_course_outcomes (canonical_question_id, course_outcome_id, relationship_type, source, verified_by, verified_at, verified_by_reviewer_ids)
          VALUES ($1, $2, 'primary', 'reviewer', $3, now(), $4::uuid[])
          ON CONFLICT (canonical_question_id, course_outcome_id) DO UPDATE SET relationship_type = 'primary', source = 'reviewer', verified_by = $3, verified_at = now(),
            verified_by_reviewer_ids = $4::uuid[]
        `, [q.canonical_question_id, finalCourseOutcomeId, verifier, reviewerIds]);
      }
    }
    return { resolution, submittedBy: q?.submitted_by || null };
  });
}

// Called once a batch reaches review_complete: for every question whose review round is still open,
// record the classification fields its reviewers agree on (a single reviewer counts as trivially unanimous)
// as 'single_reviewer_consensus'. A field where reviewers disagreed is left alone for the HOD's explicit
// /resolve call (see the disagreements endpoint below). Only resolutions newer than the latest verdict count
// (classificationState), so a question re-batched after a resubmission is finalized again. This is what makes
// the common "one reviewer, no conflict" case not require an extra manual HOD click for every question.
async function finalizeUnanimousQuestions(batchId) {
  const items = await all('SELECT question_id FROM review_batch_items WHERE review_batch_id = $1 AND outcome IS NULL', [batchId]);
  for (const item of items) {
    const cls = await classificationState(batchId, item.question_id);
    if (cls.verdicts.length === 0) continue;
    if (cls.resolutions.some((r) => r.resolution_method === 'single_reviewer_consensus')) continue; // already recorded for these verdicts
    const unanimous = {};
    for (const f of CLASSIFICATION_FIELDS) if (cls.values[f].length === 1) unanimous[f] = cls.values[f][0];
    if (Object.keys(unanimous).length === 0) continue; // total disagreement on every field — nothing to auto-record
    const single = cls.verdicts.length === 1;
    // The reviewers whose verdicts agree (verdicts are ordered by creation, so the first is the earliest).
    const verifierIds = [...new Set(cls.verdicts.map((v) => v.reviewer_id))];
    await recordResolution(item.question_id, {
      finalDifficulty: unanimous.verified_difficulty,
      finalBloomLevel: unanimous.verified_bloom_level,
      finalCourseOutcomeId: unanimous.verified_course_outcome_id,
      finalSyllabusUnitId: unanimous.verified_syllabus_unit_id,
      finalSyllabusTopicId: unanimous.verified_syllabus_topic_id,
      finalSyllabusSubtopicId: unanimous.verified_syllabus_subtopic_id,
    }, 'single_reviewer_consensus', single ? cls.verdicts[0].reviewer_id : null, single ? 'Single reviewer, no conflict' : 'All reviewers agreed', verifierIds);
  }
}

// Authorization (spec §2, §4, §12): every batch route goes through authorize() (logged in authorization_log).
// 'manage_review_batch' = the HOD whose active hod scope covers the batch's offering (user_scopes, never
// users.department_id); admin is technical-only and refused centrally. 'view_review_batch' adds a reviewer with a
// live seat (authorization.js reviewerSeat: not revoked, assignment active, still in reviewer scope).
// Returns true, or sends 403 and returns false.
async function guardBatch(req, res, batch, action = 'manage_review_batch') {
  const authz = await authorize(req.user, action, { review_batch_id: batch.id, course_offering_id: batch.course_offering_id, type: 'review_batch', id: batch.id });
  if (!authz.allowed) { res.status(403).json({ error: authz.reason }); return false; }
  return true;
}

// A batch by path id: 404 for a malformed or unknown id (never a 500 from the UUID cast).
async function loadBatch(id) {
  return isId(id) ? get('SELECT * FROM review_batches WHERE id = $1', [id]) : null;
}

// A reviewer assignment that can take a seat on a batch of this offering: active, its reviewer an active
// reviewer account that still holds reviewer scope over the offering's campus and department.
const ELIGIBLE_RA_SQL = `
  SELECT ra.* FROM reviewer_assignments ra JOIN users u ON u.id = ra.reviewer_id
  WHERE ra.id = $1 AND ra.course_offering_id = $2 AND ra.is_active = TRUE AND u.is_active = TRUE AND u.role = 'reviewer'
    AND user_has_scope(u.id, 'reviewer', $3, $4, NULL, NULL)`;

// ---- HOD: create a review batch and assign subject-specialist reviewers ----
// (spec sections 5, 21). A batch groups a set of already-submitted
// questions from one course offering; one or more reviewers are then put
// on it, each reviewing independently.

router.post('/batches', requireAuth, requireRole('hod'), async (req, res) => {
  const { course_offering_id, title, question_ids, due_at } = req.body || {};
  if (!course_offering_id || !title) return res.status(400).json({ error: 'course_offering_id and title are required' });
  if (!UUID_RE.test(String(course_offering_id))) return res.status(400).json({ error: 'course_offering_id is malformed' });
  if (question_ids != null && (!Array.isArray(question_ids) || question_ids.some((v) => typeof v !== 'string' || !UUID_RE.test(v)))) {
    return res.status(400).json({ error: 'question_ids must be an array of question ids' });
  }
  const ctx = await offeringContext(course_offering_id);
  if (!ctx) return res.status(404).json({ error: 'Course offering not found' });
  const scope = await authorize(req.user, 'manage_review_batch', { course_offering_id: ctx.course_offering_id, type: 'course_offering', id: ctx.course_offering_id });
  if (!scope.allowed) return res.status(403).json({ error: scope.reason });

  // Default to every submitted / resubmitted / under-review question of this offering that is not in an open
  // review round, so an HOD doesn't have to hand pick IDs for the common "review everything new" case.
  const explicit = Array.isArray(question_ids) && question_ids.length ? [...new Set(question_ids)] : null;
  const rows = await all(`
    SELECT q.id, q.question_status FROM questions q
    WHERE q.course_offering_id = $1 AND q.question_status IN ('SUBMITTED', 'RESUBMITTED', 'UNDER_REVIEW')
      AND ($2::uuid[] IS NULL OR q.id = ANY($2::uuid[]))
      AND NOT EXISTS (SELECT 1 FROM review_batch_items rbi JOIN review_batches rb ON rb.id = rbi.review_batch_id
                      WHERE rbi.question_id = q.id AND rbi.outcome IS NULL AND rb.status <> 'cancelled')
  `, [course_offering_id, explicit]);
  if (explicit && rows.length !== explicit.length) {
    const ok = new Set(rows.map((r) => r.id));
    return res.status(400).json({
      error: 'Some questions cannot go into this batch: they must belong to this course offering, be submitted, resubmitted or under review, and not already be in an open review batch',
      question_ids: explicit.filter((id) => !ok.has(id)),
    });
  }
  if (rows.length === 0) {
    return res.status(400).json({ error: 'No eligible questions to put in this batch (already in an open batch, drafted, or none submitted yet)' });
  }

  // Putting questions in a batch is the HOD's 'send to review' (spec §2, §12): same permission as the lifecycle
  // move. All rows share the offering, so one check covers them.
  const authz = await authorize(req.user, 'assign_review', { question_id: rows[0].id, action: 'assign_review', type: 'question', id: rows[0].id });
  if (!authz.allowed) return res.status(403).json({ error: authz.reason });

  let result;
  try {
    result = await withTransaction(async (txn) => {
      const b = await txn.get(`
        INSERT INTO review_batches (course_offering_id, created_by_hod_id, title, due_at)
        VALUES ($1, $2, $3, $4) RETURNING *
      `, [course_offering_id, req.user.id, title, due_at || null]);
      const moved = [];
      for (const q of rows) {
        await txn.run('INSERT INTO review_batch_items (review_batch_id, question_id) VALUES ($1, $2)', [b.id, q.id]);
        if (q.question_status !== 'UNDER_REVIEW') {
          const upd = await txn.run("UPDATE questions SET question_status = 'UNDER_REVIEW' WHERE id = $1 AND question_status = $2 RETURNING id", [q.id, q.question_status]);
          if (upd.rowCount !== 1) throw Object.assign(new Error('A question changed state while the batch was being created; try again'), { status: 409 });
          moved.push(q);
        }
      }
      return { batch: b, moved };
    });
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ error: err.message });
    if (err.code === '23505') return res.status(409).json({ error: 'A question was put in another review batch at the same time; try again' });
    throw err;
  }
  const { batch, moved } = result;

  await logAudit({ userId: req.user.id, action: 'review_batch_created', entityId: batch.id,
    details: { question_count: rows.length, sent_to_review: moved.length }, ip: req.ip });
  for (const q of moved) {
    await logAudit({ userId: req.user.id, action: 'question_transition_under_review', entityId: q.id, ip: req.ip,
      details: { from: q.question_status, to: 'UNDER_REVIEW', reason: null, notes: `Review batch "${title}"`, review_batch_id: batch.id } });
  }
  res.json({ ...batch, question_count: rows.length, sent_to_review: moved.length });
});

router.post('/batches/:id/assign', requireAuth, requireRole('hod'), async (req, res) => {
  const { reviewer_assignment_ids } = req.body || {};
  if (!Array.isArray(reviewer_assignment_ids) || reviewer_assignment_ids.length === 0) {
    return res.status(400).json({ error: 'reviewer_assignment_ids (array) is required' });
  }
  if (reviewer_assignment_ids.some((v) => !isId(v))) return res.status(400).json({ error: 'reviewer_assignment_ids must be reviewer assignment ids' });
  const batch = await loadBatch(req.params.id);
  if (!batch) return res.status(404).json({ error: 'Not found' });
  if (!(await guardBatch(req, res, batch))) return;
  if (CLOSED.includes(batch.status)) return res.status(409).json({ error: `This review batch is ${batch.status}` });
  const ctx = await offeringContext(batch.course_offering_id);

  const skipped = [];
  const notified = await withTransaction(async (txn) => {
    const done = [];
    let added = 0;
    for (const raId of [...new Set(reviewer_assignment_ids)]) {
      const ra = await txn.get(ELIGIBLE_RA_SQL, [raId, batch.course_offering_id, ctx?.campus_id ?? null, ctx?.department_id ?? null]);
      // Not an active assignment of this offering, or its reviewer is inactive / out of scope: reported, not seated.
      if (!ra || !ctx?.campus_id || !ctx?.department_id) { skipped.push(raId); continue; }
      const ins = await txn.run(`
        INSERT INTO review_batch_reviewers (review_batch_id, reviewer_assignment_id)
        VALUES ($1, $2) ON CONFLICT (review_batch_id, reviewer_assignment_id) DO NOTHING RETURNING id
      `, [batch.id, raId]);
      added += ins.rowCount;
      done.push(ra.reviewer_id);
    }
    if (added > 0) {
      // A reviewer joining a completed batch reopens it, so decisions wait for them.
      await txn.run(`UPDATE review_batches SET status = 'in_progress', completed_at = NULL WHERE id = $1 AND status = 'review_complete'`, [batch.id]);
    }
    if (done.length > 0) {
      await txn.run(`UPDATE review_batches SET status = 'assigned' WHERE id = $1 AND status = 'created'`, [batch.id]);
    }
    return done;
  });
  if (notified.length === 0) {
    return res.status(400).json({ error: 'None of the given reviewer_assignment_ids are active assignments of an active, in-scope reviewer for this course offering', skipped });
  }

  await notifyMany(notified, 'review_assigned',
    `You have been assigned to review batch "${batch.title}".`, batch.id);
  await logAudit({ userId: req.user.id, action: 'review_batch_assigned', entityId: batch.id, details: { reviewer_count: notified.length, skipped }, ip: req.ip });
  res.json({ ok: true, reviewers_notified: notified.length, skipped });
});

// Reassign a late/declined reviewer WITHOUT deleting the historical record
// (spec section 24): the old row is marked 'revoked', a new one is created.
// Only a reviewer who has not completed can be replaced: a completed reviewer's verdicts are part of the
// review decision (src/review-decision.js), and revoking them would let a dissenting verdict be discarded.
router.post('/batches/:id/reassign', requireAuth, requireRole('hod'), async (req, res) => {
  const { old_reviewer_assignment_id, new_reviewer_assignment_id, reason } = req.body || {};
  const batch = await loadBatch(req.params.id);
  if (!batch) return res.status(404).json({ error: 'Not found' });
  if (!(await guardBatch(req, res, batch))) return;
  if (!isId(old_reviewer_assignment_id) || !isId(new_reviewer_assignment_id)) {
    return res.status(400).json({ error: 'old_reviewer_assignment_id and new_reviewer_assignment_id must be reviewer assignment ids' });
  }
  if (CLOSED.includes(batch.status)) return res.status(409).json({ error: `This review batch is ${batch.status}` });
  const oldRow = await get(`
    SELECT * FROM review_batch_reviewers WHERE review_batch_id = $1 AND reviewer_assignment_id = $2
  `, [batch.id, old_reviewer_assignment_id]);
  if (!oldRow) return res.status(404).json({ error: 'That reviewer is not on this batch' });
  if (!['assigned', 'in_progress'].includes(oldRow.status)) {
    return res.status(409).json({ error: `Only a reviewer who has not completed can be reassigned (this one is ${oldRow.status}). Add another reviewer for a re-review instead.` });
  }
  if (old_reviewer_assignment_id === new_reviewer_assignment_id) return res.status(400).json({ error: 'Choose a different reviewer' });
  const ctx = await offeringContext(batch.course_offering_id);
  const newRa = ctx?.campus_id && ctx?.department_id
    ? await get(ELIGIBLE_RA_SQL, [new_reviewer_assignment_id, batch.course_offering_id, ctx.campus_id, ctx.department_id]) : null;
  if (!newRa) return res.status(400).json({ error: 'new_reviewer_assignment_id is not an active assignment of an active, in-scope reviewer for this offering' });

  // Conditional on the old row still being pending, so a reviewer completing meanwhile is never revoked.
  const moved = await withTransaction(async (txn) => {
    const rev = await txn.run(`UPDATE review_batch_reviewers SET status = 'revoked', updated_at = now()
      WHERE id = $1 AND status IN ('assigned', 'in_progress') RETURNING id`, [oldRow.id]);
    if (rev.rowCount !== 1) return false;
    await txn.run(`
      INSERT INTO review_batch_reviewers (review_batch_id, reviewer_assignment_id)
      VALUES ($1, $2) ON CONFLICT (review_batch_id, reviewer_assignment_id) DO UPDATE SET status = 'assigned', updated_at = now()
    `, [batch.id, new_reviewer_assignment_id]);
    return true;
  });
  if (!moved) return res.status(409).json({ error: 'That reviewer completed the batch meanwhile; reload and try again' });

  await notify(newRa.reviewer_id, 'review_assigned', `You have been assigned to review batch "${batch.title}" (reassigned from another reviewer).`, batch.id);
  await logAudit({ userId: req.user.id, action: 'review_batch_reassigned', entityId: batch.id,
    details: { old_reviewer_assignment_id, new_reviewer_assignment_id, old_status: oldRow.status, reason: reason ? String(reason).slice(0, 500) : null }, ip: req.ip });
  res.json({ ok: true });
});

// ---- Listing / detail ----

// HOD: batches of offerings its hod scope covers. Reviewer: batches where it holds a live seat (not revoked,
// assignment active, offering still inside its reviewer scope). Admin: none (technical-only, spec §2).
router.get('/batches', requireAuth, requireRole('hod', 'reviewer'), async (req, res) => {
  if (req.user.role === 'reviewer') {
    const rows = await all(`
      SELECT rb.*, co.offering_code, rbr.status as my_status, rbr.id as reviewer_assignment_link_id
      FROM review_batches rb
      JOIN review_batch_reviewers rbr ON rbr.review_batch_id = rb.id
      JOIN reviewer_assignments ra ON ra.id = rbr.reviewer_assignment_id
      JOIN course_offerings co ON co.id = rb.course_offering_id
      JOIN programs p ON p.id = co.program_id
      WHERE ra.reviewer_id = $1 AND rbr.status <> 'revoked' AND ra.is_active AND ra.course_offering_id = rb.course_offering_id
        AND ${SCOPE_SQL}
      ORDER BY rb.created_at DESC LIMIT 200
    `, [req.user.id, 'reviewer']);
    return res.json(rows);
  }
  const rows = await all(`
    SELECT rb.*, co.offering_code,
      (SELECT COUNT(*) FROM review_batch_items WHERE review_batch_id = rb.id) as question_count,
      (SELECT COUNT(*) FROM review_batch_reviewers WHERE review_batch_id = rb.id AND status != 'revoked') as reviewer_count
    FROM review_batches rb
    JOIN course_offerings co ON co.id = rb.course_offering_id
    JOIN programs p ON p.id = co.program_id
    WHERE ${SCOPE_SQL}
    ORDER BY rb.created_at DESC LIMIT 200
  `, [req.user.id, 'hod']);
  res.json(rows);
});

// Full batch detail: every question in it, every reviewer's per-question
// verdict, and a DISAGREEMENT flag wherever completed reviewers gave
// different verified_difficulty/verified_bloom_level/verified_course_outcome_id
// for the same question — the values themselves are always shown side by
// side, never averaged into one number (spec section 23).
// The HOD in scope, or a reviewer with a live seat (a revoked seat, a deactivated assignment or a lost scope ends
// access at once). assignment_active per seat tells the HOD whom to replace through /reassign.
router.get('/batches/:id', requireAuth, requireRole('hod', 'reviewer'), async (req, res) => {
  const batch = await loadBatch(req.params.id);
  if (!batch) return res.status(404).json({ error: 'Not found' });
  if (!(await guardBatch(req, res, batch, 'view_review_batch'))) return;

  const reviewers = await all(`
    SELECT rbr.*, u.email as reviewer_email, u.id as reviewer_id, ra.is_active AS assignment_active
    FROM review_batch_reviewers rbr
    JOIN reviewer_assignments ra ON ra.id = rbr.reviewer_assignment_id
    JOIN users u ON u.id = ra.reviewer_id
    WHERE rbr.review_batch_id = $1
    ORDER BY rbr.created_at
  `, [batch.id]);

  const items = await all(`
    SELECT q.*, u.email as teacher_email, rbi.outcome AS review_outcome, rbi.decided_at AS review_decided_at,
           ${QUESTION_ATTACHMENTS_SQL} AS attachments
    FROM review_batch_items rbi
    JOIN questions q ON q.id = rbi.question_id
    JOIN users u ON u.id = q.submitted_by
    WHERE rbi.review_batch_id = $1
    ORDER BY q.submitted_at ASC
  `, [batch.id]);
  // Independent review (brain.md §8): a reviewer sees other reviewers' verdicts, the disagreement flags and
  // the resolution only after completing the batch themselves. HOD views are unchanged.
  const mine = reviewers.find((r) => r.reviewer_id === req.user.id && r.status !== 'revoked');
  const seeAll = req.user.role !== 'reviewer' || mine?.status === 'completed';

  const questions = [];
  for (const q of items) {
    const verdicts = await all(`
      SELECT qr.*, u.email as reviewer_email, co.code as verified_co_code,
        su.code as verified_unit_code, st.title as verified_topic_title, sst.title as verified_subtopic_title
      FROM question_reviews qr
      JOIN users u ON u.id = qr.reviewer_id
      LEFT JOIN course_outcomes co ON co.id = qr.verified_course_outcome_id
      LEFT JOIN syllabus_units su ON su.id = qr.verified_syllabus_unit_id
      LEFT JOIN syllabus_topics st ON st.id = qr.verified_syllabus_topic_id
      LEFT JOIN syllabus_subtopics sst ON sst.id = qr.verified_syllabus_subtopic_id
      WHERE qr.review_batch_id = $1 AND qr.question_id = $2
      ORDER BY qr.created_at
    `, [batch.id, q.id]);

    const resolution = await get(`
      SELECT * FROM review_resolutions WHERE question_id = $1 ORDER BY created_at DESC LIMIT 1
    `, [q.id]);
    const cls = await classificationState(batch.id, q.id);
    // What this reviewer may now decide for the question (applied through POST /questions/:id/transition).
    let decision = null;
    if (req.user.role === 'reviewer' && seeAll && q.question_status === 'UNDER_REVIEW' && !q.review_outcome) {
      const st = await reviewDecisionState(q.id, req.user.id);
      decision = { allowed: st.allowed, blockers: st.blockers, refusals: st.refusals };
    }

    questions.push({
      question: q,
      verdicts: seeAll ? verdicts : verdicts.filter((v) => v.reviewer_id === req.user.id),
      disagreement: seeAll && cls.conflicting.length > 0,
      unresolved_fields: seeAll && !q.review_outcome ? cls.unresolved : [],
      resolution: seeAll ? (resolution || null) : null,
      decision,
    });
  }

  res.json({ batch, reviewers, questions });
});

// ---- Reviewer: per-question verdict (spec section 21) ----
// A reviewer can accept/reject/request_revision, and independently
// verify/change Bloom, difficulty, and CO — plus flag ambiguity/duplicate
// and approve the answer. Submitting on a question the reviewer authored
// themselves is blocked at the database level (trigger on question_reviews)
// as well as here, per spec section 25's conflict-of-interest rule.
router.post('/batches/:id/questions/:questionId/verdict', requireAuth, requireRole('reviewer'), async (req, res) => {
  const { decision, verified_difficulty, verified_bloom_level, verified_course_outcome_id,
    verified_syllabus_unit_id, verified_syllabus_topic_id, verified_syllabus_subtopic_id,
    flagged_ambiguous, flagged_duplicate, answer_approved, comment } = req.body || {};
  if (!isId(req.params.id) || !isId(req.params.questionId)) return res.status(404).json({ error: 'That question is not part of this review batch' });
  if (!['accept', 'reject', 'request_revision'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be accept, reject, or request_revision' });
  }
  if (['reject', 'request_revision'].includes(decision) && !comment) {
    return res.status(400).json({ error: 'A comment explaining why is required for reject or request_revision' });
  }
  // An accept is this reviewer's approval (spec §11 'final reviewer decision'): it verifies the full
  // classification and the answer (brain.md §8).
  if (decision === 'accept') {
    const missing = [['difficulty', verified_difficulty], ['Bloom level', verified_bloom_level], ['course outcome', verified_course_outcome_id],
      ['unit', verified_syllabus_unit_id], ['topic', verified_syllabus_topic_id]].filter(([, v]) => !v).map(([n]) => n);
    if (missing.length) return res.status(400).json({ error: `An accept verdict must verify the ${missing.join(', ')}` });
    if (!answer_approved) return res.status(400).json({ error: 'An accept verdict must approve the answer' });
    if (flagged_ambiguous || flagged_duplicate) {
      return res.status(400).json({ error: 'A question flagged as ambiguous or a possible duplicate cannot be accepted; request revision or reject it' });
    }
  }
  if (verified_difficulty && !DIFFICULTIES.includes(verified_difficulty)) return res.status(400).json({ error: `verified_difficulty must be one of: ${DIFFICULTIES.join(', ')}` });
  if (verified_bloom_level && !BLOOM_LEVELS.includes(verified_bloom_level)) return res.status(400).json({ error: `verified_bloom_level must be one of: ${BLOOM_LEVELS.join(', ')}` });
  if ([verified_course_outcome_id, verified_syllabus_unit_id, verified_syllabus_topic_id, verified_syllabus_subtopic_id].some((v) => v && !isId(v))) {
    return res.status(400).json({ error: 'Course outcome, unit, topic and subtopic must be valid ids' });
  }

  const item = await get(`
    SELECT rbi.id, rbi.outcome, rb.status AS batch_status, q.submitted_by, q.course_offering_id, q.question_status,
           COALESCE(q.syllabus_version_id, co.syllabus_version_id) AS syllabus_version_id
    FROM review_batch_items rbi
    JOIN review_batches rb ON rb.id = rbi.review_batch_id
    JOIN questions q ON q.id = rbi.question_id
    JOIN course_offerings co ON co.id = q.course_offering_id
    WHERE rbi.review_batch_id = $1 AND rbi.question_id = $2
  `, [req.params.id, req.params.questionId]);
  if (!item) return res.status(404).json({ error: 'That question is not part of this review batch' });

  if (item.submitted_by === req.user.id) {
    return res.status(403).json({ error: 'You cannot review a question you submitted yourself (conflict of interest)' });
  }
  // Scope and seat before any state: a reviewer outside this batch learns nothing about its outcomes, its status or
  // the question's status (and the denial is logged by authorize()).
  const authz = await authorize(req.user, 'review_question', { question_id: req.params.questionId, type: 'question', id: req.params.questionId });
  if (!authz.allowed) return res.status(403).json({ error: authz.reason });
  const onBatch = await reviewerSeat(req.params.id, req.user.id);
  if (!onBatch) return res.status(403).json({ error: 'You are not assigned to this review batch' });
  if (item.outcome) return res.status(409).json({ error: `This question's review in this batch is already decided (${item.outcome})` });
  if (CLOSED.includes(item.batch_status)) return res.status(409).json({ error: 'This review batch is closed' });
  if (item.question_status !== 'UNDER_REVIEW') {
    return res.status(409).json({ error: `Verdicts can only be recorded while the question is under review (it is ${item.question_status})` });
  }

  // Unit/Topic must come from valid syllabus relationships of the question's own syllabus version (the same
  // version its CO is checked against) — enforced here, not just by what a frontend dropdown happens to offer.
  if (verified_syllabus_unit_id || verified_syllabus_topic_id || verified_syllabus_subtopic_id) {
    const { valid, error } = await validateUnitTopicPair(item.course_offering_id, verified_syllabus_unit_id, verified_syllabus_topic_id, item.syllabus_version_id,
      verified_syllabus_subtopic_id || null);
    if (!valid) return res.status(400).json({ error });
  }
  if (verified_course_outcome_id) {
    const okCo = UUID_RE.test(String(verified_course_outcome_id)) && await get(
      'SELECT id FROM course_outcomes WHERE id = $1 AND syllabus_version_id = $2 AND is_active = TRUE', [verified_course_outcome_id, item.syllabus_version_id]);
    if (!okCo) return res.status(400).json({ error: 'That course outcome does not belong to the question\'s syllabus version' });
  }

  try {
    await withTransaction(async (txn) => {
      // Same lock as applying a decision, so a decision cannot race a verdict change.
      await txn.get('SELECT id FROM review_batches WHERE id = $1 FOR UPDATE', [req.params.id]);
      const still = await txn.get('SELECT outcome FROM review_batch_items WHERE id = $1', [item.id]);
      if (still?.outcome) throw Object.assign(new Error('This question\'s review was decided meanwhile'), { status: 409 });
      await txn.run(`
        INSERT INTO question_reviews
          (review_batch_id, question_id, reviewer_id, decision, verified_difficulty, verified_bloom_level,
           verified_course_outcome_id, verified_syllabus_unit_id, verified_syllabus_topic_id,
           flagged_ambiguous, flagged_duplicate, answer_approved, comment, verified_syllabus_subtopic_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (review_batch_id, question_id, reviewer_id) DO UPDATE SET
          decision = $4, verified_difficulty = $5, verified_bloom_level = $6, verified_course_outcome_id = $7,
          verified_syllabus_unit_id = $8, verified_syllabus_topic_id = $9,
          flagged_ambiguous = $10, flagged_duplicate = $11, answer_approved = $12, comment = $13,
          verified_syllabus_subtopic_id = $14, updated_at = now()
      `, [req.params.id, req.params.questionId, req.user.id, decision, verified_difficulty || null, verified_bloom_level || null,
          verified_course_outcome_id || null, verified_syllabus_unit_id || null, verified_syllabus_topic_id || null,
          !!flagged_ambiguous, !!flagged_duplicate, !!answer_approved, comment || null, verified_syllabus_subtopic_id || null]);

      await txn.run(`
        UPDATE review_batch_reviewers SET status = 'in_progress', started_at = COALESCE(started_at, now()), completed_at = NULL, updated_at = now()
        WHERE id = $1
      `, [onBatch.id]);
      // A changed verdict reopens a completed batch, so decisions wait for this reviewer to complete again.
      await txn.run(`UPDATE review_batches SET status = 'in_progress', completed_at = NULL
        WHERE id = $1 AND status IN ('created', 'assigned', 'review_complete')`, [req.params.id]);
    });
  } catch (dbErr) {
    if (dbErr.status) return res.status(dbErr.status).json({ error: dbErr.message });
    // The reject_self_review trigger (016) is a defense-in-depth backstop in case the application-level check
    // above is ever bypassed. withTransaction has already rolled back both statements together. Any other
    // database error goes to the central handler: database text never reaches the client (spec §4).
    if (/own submitted question/i.test(String(dbErr.message))) {
      return res.status(403).json({ error: 'You cannot review a question you submitted yourself (conflict of interest)' });
    }
    throw dbErr;
  }

  await logAudit({ userId: req.user.id, action: 'question_reviewed', entityId: req.params.questionId, details: { decision, batch: req.params.id }, ip: req.ip });
  res.json({ ok: true });
});

// A reviewer marks their whole batch complete — only allowed once every
// item has a verdict from them (spec section 24: "required questions are
// reviewed... mandatory fields populated").
router.post('/batches/:id/complete', requireAuth, requireRole('reviewer'), async (req, res) => {
  const { reviewer_summary, recommendation, recommendation_score } = req.body || {};
  if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const batchRow = await get('SELECT id, status, title FROM review_batches WHERE id = $1', [req.params.id]);
  if (!batchRow) return res.status(404).json({ error: 'Not found' });
  // The seat first (logged through authorize() on a denial), so the batch's status is only told to its reviewers.
  const onBatch = await reviewerSeat(req.params.id, req.user.id);
  if (!onBatch) {
    const authz = await authorize(req.user, 'view_review_batch', { review_batch_id: req.params.id, type: 'review_batch', id: req.params.id });
    return res.status(403).json({ error: authz.allowed ? 'You are not assigned to this review batch' : authz.reason });
  }
  if (CLOSED.includes(batchRow.status)) return res.status(409).json({ error: `This review batch is ${batchRow.status}` });
  let score = null;
  if (recommendation_score !== undefined && recommendation_score !== null && recommendation_score !== '') {
    score = Number(recommendation_score);
    if (!Number.isFinite(score) || score < 0 || score >= 1000) return res.status(400).json({ error: 'recommendation_score must be a number from 0 to 999.99' });
  }
  if (!reviewer_summary) return res.status(400).json({ error: 'A reviewer summary is required to complete a batch' });

  // Under the batch lock (the same lock a verdict and a decision take), so a close, a verdict change or a
  // decision cannot interleave with the completeness check and the status moves.
  const out = await withTransaction(async (txn) => {
    const locked = await txn.get('SELECT status FROM review_batches WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (CLOSED.includes(locked?.status)) return { status: 409, error: `This review batch is ${locked.status}` };
    // Only open rounds count, and never a question this reviewer authored (they can't give a verdict on it).
    const missing = await txn.get(`
      SELECT COUNT(*)::int as c FROM review_batch_items rbi JOIN questions q ON q.id = rbi.question_id
      WHERE rbi.review_batch_id = $1 AND rbi.outcome IS NULL AND q.submitted_by <> $2
        AND NOT EXISTS (SELECT 1 FROM question_reviews qr WHERE qr.review_batch_id = $1 AND qr.question_id = rbi.question_id AND qr.reviewer_id = $2)
    `, [req.params.id, req.user.id]);
    if (missing.c > 0) return { status: 400, error: `${missing.c} question(s) in this batch still need your verdict before you can complete it` };
    const upd = await txn.run(`
      UPDATE review_batch_reviewers SET status = 'completed', completed_at = now(), reviewer_summary = $1,
        recommendation = $2, recommendation_score = $3, updated_at = now()
      WHERE id = $4 AND status <> 'revoked' RETURNING id
    `, [reviewer_summary, recommendation || null, score, onBatch.id]);
    if (upd.rowCount === 0) return { status: 409, error: 'Your seat on this batch was revoked meanwhile' };
    const allDone = await txn.get(`
      SELECT COUNT(*)::int as pending FROM review_batch_reviewers WHERE review_batch_id = $1 AND status NOT IN ('completed', 'revoked')
    `, [req.params.id]);
    if (allDone.pending === 0) {
      await txn.run(`UPDATE review_batches SET status = 'review_complete', completed_at = now() WHERE id = $1 AND status NOT IN ('closed', 'cancelled')`, [req.params.id]);
    }
    return { allDone: allDone.pending === 0 };
  });
  if (out.status) return res.status(out.status).json({ error: out.error });

  if (out.allDone) {
    await finalizeUnanimousQuestions(req.params.id);
    const batch = await get('SELECT * FROM review_batches WHERE id = $1', [req.params.id]);
    const batchReviewers = await all(`
      SELECT DISTINCT ra.reviewer_id FROM review_batch_reviewers rbr JOIN reviewer_assignments ra ON ra.id = rbr.reviewer_assignment_id
      WHERE rbr.review_batch_id = $1 AND rbr.status <> 'revoked'`, [req.params.id]);
    await notifyMany(batchReviewers.map((r) => r.reviewer_id), 'review_decisions_ready',
      `Every reviewer finished batch "${batch.title}": apply the decisions in Review batches.`, batch.id);
    if (batch.created_by_hod_id) {
      await notify(batch.created_by_hod_id, 'review_completed', `All reviewers finished batch "${batch.title}".`, batch.id);
    }
  }

  await logAudit({ userId: req.user.id, action: 'review_batch_reviewer_completed', entityId: req.params.id, ip: req.ip });
  res.json({ ok: true });
});

// ---- Disagreement surfacing + explicit resolution (spec sections 22-23) ----
// Never silently averaged: this endpoint only ever REPORTS distinct values
// side by side. Resolving them requires the separate /resolve call below,
// which explicitly records who decided and why.
router.get('/batches/:id/disagreements', requireAuth, requireRole('hod'), async (req, res) => {
  const batch = await loadBatch(req.params.id);
  if (!batch) return res.status(404).json({ error: 'Not found' });
  if (!(await guardBatch(req, res, batch))) return;

  const items = await all('SELECT question_id FROM review_batch_items WHERE review_batch_id = $1', [batch.id]);
  const disagreements = [];
  for (const item of items) {
    const cls = await classificationState(batch.id, item.question_id);
    if (cls.conflicting.length > 0) {
      disagreements.push({
        question_id: item.question_id, conflicting_fields: cls.conflicting,
        verdicts: cls.verdicts.map((v) => ({ reviewer_id: v.reviewer_id, reviewer_email: v.reviewer_email,
          ...Object.fromEntries(CLASSIFICATION_FIELDS.map((f) => [f, v[f] ?? null])) })),
        resolved: cls.unresolved.length === 0,
      });
    }
  }
  res.json({ disagreements });
});

// The HOD in scope explicitly records the final academic classification for
// a question. This is the ONLY place canonical_questions.verified_* gets
// updated — it is written here whether reviewers agreed unanimously
// (resolution_method='single_reviewer_consensus' / passed straight through)
// or disagreed and a human had to decide (hod_override / additional_reviewer
// / re_review). The value is never computed as an average of the
// question_reviews rows.
router.post('/questions/:questionId/resolve', requireAuth, requireRole('hod'), async (req, res) => {
  const { final_difficulty, final_bloom_level, final_course_outcome_id,
    final_syllabus_unit_id, final_syllabus_topic_id, final_syllabus_subtopic_id, resolution_method, reason } = req.body || {};
  if (!isId(req.params.questionId)) return res.status(404).json({ error: 'Not found' });
  if (!resolution_method || !['hod_override', 'additional_reviewer', 're_review'].includes(resolution_method)) {
    return res.status(400).json({ error: 'resolution_method must be hod_override, additional_reviewer or re_review (consensus is recorded automatically)' });
  }
  if (!final_difficulty && !final_bloom_level && !final_course_outcome_id && !final_syllabus_unit_id && !final_syllabus_topic_id && !final_syllabus_subtopic_id) {
    return res.status(400).json({ error: 'Provide at least one final_* value to resolve' });
  }
  if (final_difficulty && !DIFFICULTIES.includes(final_difficulty)) return res.status(400).json({ error: `final_difficulty must be one of: ${DIFFICULTIES.join(', ')}` });
  if (final_bloom_level && !BLOOM_LEVELS.includes(final_bloom_level)) return res.status(400).json({ error: `final_bloom_level must be one of: ${BLOOM_LEVELS.join(', ')}` });
  if ([final_course_outcome_id, final_syllabus_unit_id, final_syllabus_topic_id, final_syllabus_subtopic_id].some((v) => v && !isId(v))) {
    return res.status(400).json({ error: 'final course outcome, unit, topic and subtopic must be valid ids' });
  }
  const q = await get('SELECT * FROM questions WHERE id = $1', [req.params.questionId]);
  if (!q) return res.status(404).json({ error: 'Not found' });
  const ctx = await offeringContext(q.course_offering_id);
  const scope = await authorize(req.user, 'manage_review_batch', { course_offering_id: ctx?.course_offering_id ?? null, type: 'question', id: q.id });
  if (!ctx || !scope.allowed) return res.status(403).json({ error: scope.reason || 'That question is outside your scope' });
  // Classification is settled during review; an approved question changes only through a new review (§12, §14).
  if (!(await openReviewItem(q.id))) {
    return res.status(409).json({ error: 'This question has no open review round. Its classification is settled during review; an approved question changes only through a new review.' });
  }
  if (resolution_method === 'hod_override' && !reason) {
    return res.status(400).json({ error: 'A reason is required when overriding reviewer classification' });
  }
  // Checked against the question's own syllabus version (the one its reviewers verified against).
  const svId = q.syllabus_version_id || ctx.syllabus_version_id;
  if (final_syllabus_unit_id || final_syllabus_topic_id || final_syllabus_subtopic_id) {
    const { valid, error } = await validateUnitTopicPair(q.course_offering_id, final_syllabus_unit_id, final_syllabus_topic_id, svId, final_syllabus_subtopic_id || null);
    if (!valid) return res.status(400).json({ error });
  }
  if (final_course_outcome_id) {
    const okCo = svId && await get('SELECT id FROM course_outcomes WHERE id = $1 AND syllabus_version_id = $2 AND is_active = TRUE', [final_course_outcome_id, svId]);
    if (!okCo) return res.status(400).json({ error: 'That course outcome does not belong to the question\'s syllabus version' });
  }
  const changes = await verifiedFieldChanges(q.id, req.body);
  if (changes.some((c) => c.overwrites) && !(reason && String(reason).trim().length >= 3)) {
    return res.status(400).json({ error: 'A reason is required when changing an already verified value', changes });
  }

  const resolutionResult = await recordResolution(q.id, {
    finalDifficulty: final_difficulty, finalBloomLevel: final_bloom_level, finalCourseOutcomeId: final_course_outcome_id,
    finalSyllabusUnitId: final_syllabus_unit_id, finalSyllabusTopicId: final_syllabus_topic_id, finalSyllabusSubtopicId: final_syllabus_subtopic_id,
  }, resolution_method, req.user.id, reason);

  await logAudit({ userId: req.user.id, action: 'review_resolution_recorded', entityId: q.id,
    details: { resolution_method, reason: reason || null, changes }, ip: req.ip });
  await notify(q.submitted_by, 'question_classification_resolved',
    `The academic classification for one of your questions was finalized (${resolution_method.replace(/_/g, ' ')}).`, q.id);
  res.json(resolutionResult.resolution);
});

// HOD closes a batch — only once every question in it has its review decision applied. A closed batch takes
// no verdicts, so an open round in it could never be decided and its question would stay UNDER_REVIEW.
// Disagreements are covered by the decisions themselves (spec section 24: "conflicts are resolved or
// explicitly escalated"): an approval needs an explicit resolution of every conflicting field
// (review-decision.js), any other decision sends the question back. A late reviewer is replaced through
// /reassign, not by closing.
router.post('/batches/:id/close', requireAuth, requireRole('hod'), async (req, res) => {
  const batch = await loadBatch(req.params.id);
  if (!batch) return res.status(404).json({ error: 'Not found' });
  if (!(await guardBatch(req, res, batch))) return;
  if (CLOSED.includes(batch.status)) return res.status(409).json({ error: `This review batch is already ${batch.status}` });

  const items = await all('SELECT question_id FROM review_batch_items WHERE review_batch_id = $1 AND outcome IS NULL', [batch.id]);
  if (items.length > 0) {
    return res.status(409).json({
      error: `${items.length} question(s) in this batch have no review decision yet: the reviewers complete the batch and apply the decisions first`,
      question_ids: items.map((i) => i.question_id),
    });
  }
  const closed = await run(`UPDATE review_batches SET status = 'closed', completed_at = COALESCE(completed_at, now())
    WHERE id = $1 AND status NOT IN ('closed', 'cancelled')`, [batch.id]);
  if (closed.rowCount !== 1) return res.status(409).json({ error: 'The batch was closed meanwhile' });
  await logAudit({ userId: req.user.id, action: 'review_batch_closed', entityId: batch.id, ip: req.ip });
  res.json({ ok: true });
});

// ---- Reviewer dashboard: everything needing this reviewer's attention in
// one call, so the frontend doesn't have to stitch together five separate
// list endpoints itself (spec section 1). ----
router.get('/dashboard', requireAuth, requireRole('reviewer'), async (req, res) => {
  const batches = await all(`
    SELECT rb.id, rb.title, rb.status, rb.due_at,
      subj.subject_code, subj.course_title, sess.label as academic_session_label, co.semester,
      sv.version_number as syllabus_version_number,
      (SELECT COUNT(*) FROM review_batch_items WHERE review_batch_id = rb.id) as question_count,
      (SELECT COUNT(*) FROM question_reviews qr WHERE qr.review_batch_id = rb.id AND qr.reviewer_id = $1) as reviewed_count
    FROM review_batches rb
    JOIN review_batch_reviewers rbr ON rbr.review_batch_id = rb.id
    JOIN reviewer_assignments ra ON ra.id = rbr.reviewer_assignment_id
    JOIN course_offerings co ON co.id = rb.course_offering_id
    JOIN subjects subj ON subj.id = co.subject_id
    LEFT JOIN academic_sessions sess ON sess.id = co.academic_session_id
    JOIN programs p ON p.id = co.program_id
    LEFT JOIN syllabus_versions sv ON sv.id = co.syllabus_version_id
    WHERE ra.reviewer_id = $1 AND rbr.status != 'revoked' AND ra.is_active AND ra.course_offering_id = rb.course_offering_id
      AND ${SCOPE_SQL}
    ORDER BY rb.status = 'assigned' DESC, rb.due_at ASC NULLS LAST, rb.created_at DESC
  `, [req.user.id, 'reviewer']);

  // Conflict count per batch, and an overall unresolved-conflict total —
  // same "distinct non-null values across this batch's reviewers" logic as
  // /batches/:id/disagreements, just rolled up per batch instead of
  // expanded per question.
  let unresolvedConflicts = 0;
  for (const b of batches) {
    const items = await all('SELECT question_id FROM review_batch_items WHERE review_batch_id = $1 AND outcome IS NULL', [b.id]);
    let conflictCount = 0;
    for (const item of items) {
      if ((await classificationState(b.id, item.question_id)).unresolved.length > 0) conflictCount++;
    }
    b.conflict_count = conflictCount;
    unresolvedConflicts += conflictCount;
  }

  const completedReviews = await get(`SELECT COUNT(*)::int as c FROM question_reviews WHERE reviewer_id = $1`, [req.user.id]);
  const needingRevision = await get(`SELECT COUNT(*)::int as c FROM question_reviews WHERE reviewer_id = $1 AND decision = 'request_revision'`, [req.user.id]);
  const pendingQuestions = batches.reduce((sum, b) => sum + Math.max(0, Number(b.question_count) - Number(b.reviewed_count)), 0);

  res.json({
    batches,
    summary: {
      assigned_batches: batches.length,
      pending_questions: pendingQuestions,
      completed_reviews: completedReviews.c,
      questions_needing_revision: needingRevision.c,
      unresolved_conflicts: unresolvedConflicts,
    },
  });
});

export default router;
