// What the review batch's verdicts allow for an UNDER_REVIEW question (PIVOT_SPEC_V2 §2, §7, §11; brain.md §5, §8).
// Shared by POST /questions/:id/transition (which applies the decision) and the review-batch routes (which show it).
//
// The rule: a question's review round is its open review_batch_items row (outcome IS NULL, migration 038).
// Once every reviewer on that batch (except the question's author) has completed the batch and given a verdict:
//   - APPROVED          only if every verdict is 'accept', no classification field is in unresolved
//                       disagreement, and difficulty, Bloom, CO and topic are all settled;
//   - REJECTED          only if every verdict is 'reject' (the only way a submitted question is rejected:
//                       CHANGES_REQUESTED -> REJECTED does not exist, so nobody rejects alone after a split round);
//   - CHANGES_REQUESTED if at least one verdict is 'reject' or 'request_revision'.
// One reviewer is a complete review. Several must agree; a split decision is never averaged - the reviewer
// requests changes, or the HOD adds or reassigns a reviewer for a re-review. Every outcome is an explicit,
// audited reviewer action.

import { get, all } from './db.js';

// The subtopic (042) is verified like the other fields but is optional: a question may cover its whole topic.
export const CLASSIFICATION_FIELDS = ['verified_difficulty', 'verified_bloom_level', 'verified_course_outcome_id',
  'verified_syllabus_unit_id', 'verified_syllabus_topic_id', 'verified_syllabus_subtopic_id'];
const FINAL_FIELD = {
  verified_difficulty: 'final_difficulty', verified_bloom_level: 'final_bloom_level', verified_course_outcome_id: 'final_course_outcome_id',
  verified_syllabus_unit_id: 'final_syllabus_unit_id', verified_syllabus_topic_id: 'final_syllabus_topic_id',
  verified_syllabus_subtopic_id: 'final_syllabus_subtopic_id',
};
const FIELD_LABEL = {
  verified_difficulty: 'difficulty', verified_bloom_level: 'Bloom level', verified_course_outcome_id: 'course outcome',
  verified_syllabus_unit_id: 'unit', verified_syllabus_topic_id: 'topic', verified_syllabus_subtopic_id: 'subtopic',
};
export const labelFields = (fields) => fields.map((f) => FIELD_LABEL[f]).join(', ');
const REQUIRED_FOR_APPROVAL = ['verified_difficulty', 'verified_bloom_level', 'verified_course_outcome_id', 'verified_syllabus_topic_id'];
const DEFAULT_DB = { get, all };

// The question's open review round (at most one: unique index from migration 038).
export async function openReviewItem(questionId, db = DEFAULT_DB) {
  return db.get(`
    SELECT rbi.id, rbi.review_batch_id, rbi.created_at, rb.status AS batch_status, q.submitted_by
    FROM review_batch_items rbi
    JOIN review_batches rb ON rb.id = rbi.review_batch_id
    JOIN questions q ON q.id = rbi.question_id
    WHERE rbi.question_id = $1 AND rbi.outcome IS NULL AND rb.status <> 'cancelled'
    ORDER BY rbi.created_at DESC LIMIT 1`, [questionId]);
}

// Classification per field for one question in one batch (non-revoked reviewers only).
//   values[f]    distinct verdict values
//   conflicting  fields with more than one value
//   unresolved   conflicting fields with no explicit (non-consensus) resolution created at/after the latest verdict
//   final[f]     latest fresh explicit resolution value, else the unanimous verdict value, else null
//   resolutions  every resolution newer than the latest verdict (newest first)
// A resolution older than the latest verdict belongs to an earlier opinion and does not count.
export async function classificationState(batchId, questionId, db = DEFAULT_DB) {
  const verdicts = await db.all(`
    SELECT qr.*, u.email AS reviewer_email
    FROM question_reviews qr JOIN users u ON u.id = qr.reviewer_id
    WHERE qr.review_batch_id = $1 AND qr.question_id = $2
      AND EXISTS (SELECT 1 FROM review_batch_reviewers rbr JOIN reviewer_assignments ra ON ra.id = rbr.reviewer_assignment_id
                  WHERE rbr.review_batch_id = qr.review_batch_id AND ra.reviewer_id = qr.reviewer_id AND rbr.status <> 'revoked')
    ORDER BY qr.created_at`, [batchId, questionId]);
  const empty = { verdicts, values: {}, resolutions: [], conflicting: [], unresolved: [], final: {} };
  for (const f of CLASSIFICATION_FIELDS) { empty.values[f] = []; empty.final[f] = null; }
  if (verdicts.length === 0) return empty;

  const latest = verdicts.reduce((m, v) => {
    const t = new Date(v.updated_at || v.created_at);
    return t > m ? t : m;
  }, new Date(0));
  const resolutions = await db.all(`
    SELECT * FROM review_resolutions WHERE question_id = $1 AND created_at >= $2
    ORDER BY created_at DESC, id DESC`, [questionId, latest]);
  const explicit = resolutions.filter((r) => r.resolution_method !== 'single_reviewer_consensus');

  const values = {}; const conflicting = []; const unresolved = []; const final = {};
  for (const f of CLASSIFICATION_FIELDS) {
    values[f] = [...new Set(verdicts.map((v) => v[f]).filter((v) => v !== null && v !== undefined))];
    const decided = explicit.find((r) => r[FINAL_FIELD[f]] != null);
    if (values[f].length > 1) {
      conflicting.push(f);
      if (!decided) unresolved.push(f);
    }
    final[f] = decided ? decided[FINAL_FIELD[f]] : (values[f].length === 1 ? values[f][0] : null);
  }
  return { verdicts, values, resolutions, conflicting, unresolved, final };
}

// What `reviewerId` may do with an UNDER_REVIEW question. `blockers` apply to every target;
// `refusals[target]` explains a target that is not allowed once the blockers are clear.
// knownItem: the open round when the caller already loaded it (null = none); undefined = look it up.
export async function reviewDecisionState(questionId, reviewerId, db = DEFAULT_DB, knownItem) {
  const item = knownItem === undefined ? await openReviewItem(questionId, db) : knownItem;
  if (!item) {
    return { item: null, me: null, verdicts: [], allowed: [], refusals: {},
      blockers: ['This question is not in an open review batch. The HOD puts it in a review batch with its reviewers; each reviewer records a verdict there.'] };
  }
  const reviewers = await db.all(`
    SELECT ra.reviewer_id, rbr.status, u.email
    FROM review_batch_reviewers rbr
    JOIN reviewer_assignments ra ON ra.id = rbr.reviewer_assignment_id
    JOIN users u ON u.id = ra.reviewer_id
    WHERE rbr.review_batch_id = $1 AND rbr.status <> 'revoked'`, [item.review_batch_id]);
  // The author never reviews their own question (spec §39.3), so only the other reviewers count for it.
  const eligible = reviewers.filter((r) => r.reviewer_id !== item.submitted_by);
  const me = eligible.find((r) => r.reviewer_id === reviewerId) || null;
  const cls = await classificationState(item.review_batch_id, questionId, db);

  const blockers = [];
  if (!me) blockers.push('You are not a reviewer on this question\'s review batch');
  if (eligible.length === 0) blockers.push('No reviewer who can review this question is on its batch: the HOD must add one');
  const pending = eligible.filter((r) => r.status !== 'completed');
  if (pending.length) blockers.push(`Waiting for ${pending.length} reviewer(s) to complete the review batch: ${pending.map((r) => r.email).join(', ')}`);
  const silent = eligible.filter((r) => !cls.verdicts.some((v) => v.reviewer_id === r.reviewer_id));
  if (silent.length) blockers.push(`No verdict on this question yet from: ${silent.map((r) => r.email).join(', ')}`);
  const base = { item, me, verdicts: cls.verdicts, classification: cls };
  if (blockers.length) return { ...base, allowed: [], refusals: {}, blockers };

  const kinds = new Set(cls.verdicts.map((v) => v.decision));
  const split = kinds.size > 1 ? `Reviewers disagree on the decision (${[...kinds].join(' / ')})` : null;
  const allowed = []; const refusals = {};

  if (kinds.has('reject') || kinds.has('request_revision')) allowed.push('CHANGES_REQUESTED');
  else refusals.CHANGES_REQUESTED = 'Every reviewer accepted this question; change your verdict to request revision first';

  if (kinds.size === 1 && kinds.has('reject')) allowed.push('REJECTED');
  else refusals.REJECTED = split
    ? `${split}: rejection needs every reviewer to reject; request changes, or ask the HOD to add or reassign a reviewer for a re-review`
    : 'Rejection needs every reviewer to reject the question';

  const missing = REQUIRED_FOR_APPROVAL.filter((f) => !cls.final[f]);
  if (!(kinds.size === 1 && kinds.has('accept'))) {
    refusals.APPROVED = split
      ? `${split}: approval needs every reviewer to accept; request changes, or ask the HOD to add or reassign a reviewer for a re-review`
      : 'Approval needs every reviewer to accept the question';
  } else if (cls.unresolved.length) {
    refusals.APPROVED = `Reviewers disagree on the ${labelFields(cls.unresolved)}: the HOD must record an explicit resolution first`;
  } else if (missing.length) {
    refusals.APPROVED = `Approval needs a reviewer-verified ${labelFields(missing)}`;
  } else if (cls.verdicts.some((v) => !v.answer_approved || v.flagged_ambiguous || v.flagged_duplicate)) {
    refusals.APPROVED = 'Approval needs every reviewer to approve the answer with no ambiguity or duplicate flag';
  } else {
    allowed.push('APPROVED');
  }
  return { ...base, allowed, refusals, blockers };
}
