import express from 'express';
import { get, all, run, withTransaction } from '../db.js';
import { requireAuth, requireRole } from '../middleware.js';
import { logAudit } from '../audit.js';
import { normalizeQuestionHash } from '../auth.js';
import { computeEmbedding, embeddingToSqlLiteral } from '../embeddings.js';
import { notifyMany } from '../notifications.js';
import { createCanonicalQuestion, appendCanonicalVersion, linkToCanonical, setCourseOutcomes, getCanonicalDetail,
  resolveCourseOutcomeCodes, stableJson } from '../canonical.js';
import { classifyAgainstBank, persistCandidates } from '../dedup.js';
import { hodsInScope } from '../scopes.js';
import { authorize } from '../authorization.js';
import { EDITABLE_STATUSES, SUBMIT_TARGETS, SCOPE_SQL } from './questions-lifecycle.js';

// Bloom levels: the shared definition (taxonomy.js).
import { QUESTION_TYPE_CODES, OBJECTIVE_TYPES, PRINTABLE_IMAGE_TYPES, normalizeQuestionType, normalizeQuestionData, validateQuestionByType, typeLabel } from '../question-types.js';
import { QUESTION_ATTACHMENTS_SQL } from '../paper-attachments.js';
import { resolvePlacement } from '../syllabus-versioning.js';
import { BLOOM_LEVELS } from '../taxonomy.js';

const router = express.Router();

const MAX_MARKS = 100;
const MAX_TEXT_LEN = 4000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BLOCKING = ['EXACT_DUPLICATE', 'LIKELY_DUPLICATE'];
// Fields whose old and new value an edit records (spec §12); long content is only named (it is versioned at submit).
const METADATA_FIELDS = ['question_type', 'difficulty', 'submitted_bloom_level', 'topic', 'subtopic', 'marks'];
const CONTENT_FIELDS = ['question_text', 'option_a', 'option_b', 'option_c', 'option_d', 'correct_answer', 'model_answer'];

// ---- Central validation — every "stupid value" gets caught here, once,
// instead of scattered ad-hoc checks. Returns a list of human-readable
// problems; empty list means the draft is safe to save. ----
function validateQuestionInput(body) {
  const errors = [];
  const { question_type, question_text, difficulty, marks } = body;

  if (!normalizeQuestionType(question_type)) {
    errors.push(`question_type must be one of: ${QUESTION_TYPE_CODES.join(', ')}`);
  }
  if (!question_text || typeof question_text !== 'string' || question_text.trim().length < 5) {
    errors.push('question text must be at least 5 characters');
  }
  if (question_text && question_text.length > MAX_TEXT_LEN) {
    errors.push(`question text exceeds ${MAX_TEXT_LEN} characters`);
  }
  if (!['easy', 'medium', 'hard'].includes(difficulty)) {
    errors.push('difficulty must be easy, medium, or hard');
  }
  // Bloom level is optional at submission — a teacher who isn't sure can
  // leave it blank and let the reviewer set it (spec section 22's
  // hierarchy: teacher suggestion -> AI suggestion -> reviewer verified
  // value). If provided, it must be one of the six recognized levels.
  if (body.bloom_level && !BLOOM_LEVELS.includes(body.bloom_level)) {
    errors.push(`bloom_level must be one of: ${BLOOM_LEVELS.join(', ')}`);
  }

  const marksNum = Number(marks);
  if (marks === undefined || marks === null || marks === '' || Number.isNaN(marksNum)) {
    errors.push('marks must be a number');
  } else if (!Number.isInteger(marksNum)) {
    errors.push('marks must be a whole number');
  } else if (marksNum <= 0) {
    errors.push('marks must be greater than zero (negative or zero marks are not allowed)');
  } else if (marksNum > MAX_MARKS) {
    errors.push(`marks cannot exceed ${MAX_MARKS}`);
  }

  // Type-specific rules (spec §10) live in question-types.js, shared with bulk upload and the generator.
  if (normalizeQuestionType(question_type)) errors.push(...validateQuestionByType(body));
  if (body.model_answer && body.model_answer.length > MAX_TEXT_LEN) {
    errors.push(`model answer exceeds ${MAX_TEXT_LEN} characters`);
  }
  if (body.answer_data != null && JSON.stringify(body.answer_data).length > MAX_TEXT_LEN * 2) {
    errors.push('answer_data is too large');
  }
  return errors;
}

async function scopedQuestion(id, user) {
  const q = await get('SELECT * FROM questions WHERE id = $1', [id]);
  if (!q) return null;
  if (user.role === 'teacher' && q.submitted_by !== user.id) return null;
  return q;
}

// A teacher may only submit against a course_offering (optionally a
// specific section of it) they actually hold an active assignment for.
// Returns { courseOfferingId, sectionId, subjectId } or null if not permitted.
// A section must be an active section of that same offering (also enforced by the composite FK, migration 040).
async function resolveTeacherOffering(teacherId, courseOfferingId, sectionId) {
  if (!courseOfferingId || !UUID_RE.test(String(courseOfferingId)) || (sectionId && !UUID_RE.test(String(sectionId)))) return null;
  const assignment = await get(`
    SELECT tca.course_offering_id, tca.section_id, co.subject_id
    FROM teacher_course_assignments tca
    JOIN course_offerings co ON co.id = tca.course_offering_id
    WHERE tca.teacher_id = $1 AND tca.course_offering_id = $2 AND tca.is_active = TRUE
      AND (tca.section_id IS NULL OR tca.section_id = $3::uuid)
      AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM sections s WHERE s.id = $3::uuid AND s.course_offering_id = tca.course_offering_id AND s.is_active))
    LIMIT 1
  `, [teacherId, courseOfferingId, sectionId || null]);
  if (!assignment) return null;
  return {
    courseOfferingId: assignment.course_offering_id,
    sectionId: sectionId || assignment.section_id || null,
    subjectId: assignment.subject_id,
  };
}

// Attachments that have not passed the virus scan (a question with one cannot be submitted).
async function uncleanAttachments(questionId) {
  return (await all('SELECT scan_status FROM question_attachments WHERE question_id = $1', [questionId]))
    .filter((a) => a.scan_status !== 'clean');
}

// Duplicate classification shared by /preview and /submit, persisted so there's a durable record. Candidates
// that already belong to this question's canonical question are the same question by definition (e.g. a
// withdrawn duplicate linked to it), so they never block a resubmission.
async function duplicateCheck(q) {
  const classified = (await classifyAgainstBank(q, q.course_offering_id))
    .filter((r) => !(q.canonical_question_id && r.candidate.canonical_question_id === q.canonical_question_id));
  const persisted = await persistCandidates(q.id, classified);
  return {
    blocking: persisted.filter((r) => BLOCKING.includes(r.classification) && r.status === 'pending'),
    related: persisted.filter((r) => r.classification === 'RELATED' && r.status === 'pending'),
  };
}

// The teacher's CO choice at submission (spec §9: one PRIMARY, zero or more SECONDARY). Never trusted
// blindly: ids must be active COs of the question's syllabus version. Empty input = keep the current mapping.
async function parseCourseOutcomeInput(body, q) {
  const primary = body.primary_course_outcome_id || null;
  const secondaryRaw = Array.isArray(body.secondary_course_outcome_ids) ? body.secondary_course_outcome_ids.filter(Boolean) : [];
  if (!primary && secondaryRaw.length === 0) return { desired: null };
  if ([primary, ...secondaryRaw].some((v) => v && (typeof v !== 'string' || !UUID_RE.test(v)))) {
    return { error: 'Course outcome ids are malformed' };
  }
  if (!primary) return { error: 'Choose a primary course outcome before secondary ones' };
  const secondaryIds = [...new Set(secondaryRaw)].filter((v) => v !== primary);
  const ids = [primary, ...secondaryIds];
  const found = await all(`
    SELECT id FROM course_outcomes
    WHERE id = ANY($1::uuid[]) AND is_active
      AND syllabus_version_id = COALESCE($2::uuid, (SELECT syllabus_version_id FROM course_offerings WHERE id = $3))
  `, [ids, q.syllabus_version_id || null, q.course_offering_id]);
  const ok = new Set(found.map((r) => r.id));
  const invalid = ids.filter((v) => !ok.has(v));
  if (invalid.length) return { error: 'Course outcome(s) are not part of this question\'s syllabus', invalid };
  return { desired: { primaryId: primary, secondaryIds } };
}

function sameCoMapping(rows, desired) {
  const primary = rows.find((r) => r.relationship_type === 'primary')?.course_outcome_id || null;
  const secondary = rows.filter((r) => r.relationship_type !== 'primary').map((r) => r.course_outcome_id).sort();
  return primary === desired.primaryId && JSON.stringify(secondary) === JSON.stringify([...desired.secondaryIds].sort());
}

const stateChanged = () => Object.assign(new Error('Question state changed'), { code: 'QUESTION_STATE_CHANGED' });

// The offering's current (ACTIVE) syllabus version: what an editable question is written against (migration 042).
async function currentSyllabusVersion(courseOfferingId, db = { get }) {
  return (await db.get('SELECT syllabus_version_id FROM course_offerings WHERE id = $1', [courseOfferingId]))?.syllabus_version_id || null;
}
const placementInput = (body) => ({
  topicId: body.syllabus_topic_id && UUID_RE.test(String(body.syllabus_topic_id)) ? String(body.syllabus_topic_id) : null,
  topic: body.topic ?? null,
  subtopicId: body.subtopic_id && UUID_RE.test(String(body.subtopic_id)) ? String(body.subtopic_id) : null,
  subtopic: body.subtopic ?? null,
});

// Create / update a draft question (objective or subjective)
router.post('/draft', requireAuth, requireRole('teacher'), async (req, res) => {
  // Per-type normal form first (question-types.js normalizeQuestionData, shared with bulk import): an MCQ letter
  // becomes the option text, True/False and Assertion-Reason keys are upper-cased, and options / answers /
  // answer_data keys the type does not use are dropped. Validation then judges what will actually be stored.
  const norm = normalizeQuestionData(req.body || {});
  const body = norm ? { ...req.body, ...norm } : (req.body || {});
  const errors = validateQuestionInput(body);
  if (errors.length > 0) {
    return res.status(400).json({ error: 'Invalid question data', details: errors });
  }

  const { id, question_text, option_a, option_b, option_c, option_d,
    correct_answer, model_answer, difficulty, bloom_level, marks, course_offering_id, section_id } = body;
  const question_type = norm.question_type;
  const answerDataJson = Object.keys(norm.answer_data).length ? JSON.stringify(norm.answer_data) : null;
  const hash = normalizeQuestionHash(question_text);
  if ((body.syllabus_topic_id && !UUID_RE.test(String(body.syllabus_topic_id))) || (body.subtopic_id && !UUID_RE.test(String(body.subtopic_id)))) {
    return res.status(400).json({ error: 'Invalid question data', details: ['syllabus_topic_id / subtopic_id must be ids from the syllabus'] });
  }

  if (id) {
    const existing = await scopedQuestion(id, req.user);
    if (!existing) return res.status(404).json({ error: 'Draft not found' });
    // The lifecycle state decides, never the legacy status: only Draft and Changes-requested questions are
    // editable, and an edit keeps that state (a revision is resubmitted through /submit and comes back as
    // RESUBMITTED). Only content columns are written, so no lifecycle trigger fires; approved content is
    // also locked in the DB (migration 038). AI findings belong to the old content and are cleared.
    if (!EDITABLE_STATUSES.includes(existing.question_status)) {
      return res.status(400).json({ error: `A question in ${existing.question_status} cannot be edited; only Draft and Changes-requested questions can`, question_status: existing.question_status });
    }
    if (!(await resolveTeacherOffering(req.user.id, existing.course_offering_id, existing.section_id))) {
      return res.status(403).json({ error: 'You are no longer assigned to this course offering/section' });
    }
    // An editable question follows the offering's current syllabus: one left on a superseded version (a syllabus
    // change affected it) moves to the current version here, and its topic / subtopic must belong to that version.
    const targetVersion = (await currentSyllabusVersion(existing.course_offering_id)) || existing.syllabus_version_id || null;
    const place = await resolvePlacement({ all }, targetVersion, placementInput(body));
    if (!place.ok) return res.status(400).json({ error: 'Invalid question data', details: [place.error] });
    const moved = targetVersion !== (existing.syllabus_version_id || null);
    const updated = await withTransaction(async (txn) => {
      const row = await txn.get(`
        UPDATE questions SET question_type=$1, question_text=$2, option_a=$3, option_b=$4, option_c=$5, option_d=$6,
          correct_answer=$7, model_answer=$8, difficulty=$9, submitted_bloom_level=$10, topic=$11, marks=$12,
          question_hash=$13, embedding=$14::vector, answer_data=$16::jsonb, subtopic=$17, last_edited_at=now(),
          ai_review_notes=NULL, ai_reviewed_at=NULL, ai_review_dispute=NULL, ai_review_disputed_at=NULL,
          syllabus_version_id=$19, subtopic_id=$20
        WHERE id = $15 AND submitted_by = $18 AND question_status IN ('DRAFT', 'CHANGES_REQUESTED')
        RETURNING id, question_status
      `, [question_type, question_text, option_a || null, option_b || null, option_c || null, option_d || null,
        correct_answer || null, model_answer || null, difficulty, bloom_level || null, place.topic, Number(marks), hash,
        embeddingToSqlLiteral(computeEmbedding(question_text)), id, answerDataJson, place.subtopic, req.user.id, targetVersion, place.subtopicId]);
      if (row && moved && targetVersion) {
        await txn.run(`INSERT INTO question_syllabus_remaps (question_id, from_version_id, to_version_id, kind, old_mapping, new_mapping, reason, performed_by)
          VALUES ($1, $2, $3, 'author_edit', $4::jsonb, $5::jsonb, $6, $7)`,
        [id, existing.syllabus_version_id || null, targetVersion, JSON.stringify({ topic: existing.topic, subtopic: existing.subtopic, subtopic_id: existing.subtopic_id || null }),
          JSON.stringify({ topic: place.topic, subtopic: place.subtopic, subtopic_id: place.subtopicId }), 'Edited by the author against the current syllabus', req.user.id]);
      }
      return row;
    });
    if (!updated) return res.status(409).json({ error: 'This question changed state while you were editing it; reload and try again' });

    const topic = place.topic; const subtopic = place.subtopic;
    const next = { question_type, difficulty, submitted_bloom_level: bloom_level || null, topic: topic || null, subtopic, marks: Number(marks),
      question_text, option_a: option_a || null, option_b: option_b || null, option_c: option_c || null, option_d: option_d || null,
      correct_answer: correct_answer || null, model_answer: model_answer || null };
    const differs = (f) => String(existing[f] ?? '') !== String(next[f] ?? '');
    const metadataChanges = Object.fromEntries(METADATA_FIELDS.filter(differs).map((f) => [f, { old: existing[f] ?? null, new: next[f] ?? null }]));
    const contentChanged = CONTENT_FIELDS.filter(differs);
    if (stableJson(existing.answer_data) !== stableJson(answerDataJson)) contentChanged.push('answer_data');
    await logAudit({ userId: req.user.id, action: 'draft_updated', entityId: id, ip: req.ip,
      details: { question_status: updated.question_status, metadata_changes: metadataChanges, content_changed: contentChanged,
        ...(moved ? { syllabus_version_moved: { from: existing.syllabus_version_id || null, to: targetVersion } } : {}) } });
    return res.json({ id, updated: true, question_status: updated.question_status, ...(moved ? { syllabus_version_id: targetVersion } : {}) });
  } else {
    const offering = await resolveTeacherOffering(req.user.id, course_offering_id, section_id);
    if (!offering) {
      return res.status(403).json({ error: 'You are not assigned to that course offering/section' });
    }
    // Written against the offering's current syllabus version; topic / subtopic must belong to it (spec §8).
    const versionId = await currentSyllabusVersion(offering.courseOfferingId);
    const place = await resolvePlacement({ all }, versionId, placementInput(body));
    if (!place.ok) return res.status(400).json({ error: 'Invalid question data', details: [place.error] });
    try {
      const created = await get(`
        INSERT INTO questions (subject_id, course_offering_id, section_id, submitted_by, question_type, question_text,
          option_a, option_b, option_c, option_d, correct_answer, model_answer, difficulty, submitted_bloom_level, topic, marks,
          question_hash, embedding, is_draft, status, answer_data, subtopic, syllabus_version_id, subtopic_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::vector, TRUE, 'pending', $19::jsonb, $20, $21, $22)
        RETURNING id
      `, [offering.subjectId, offering.courseOfferingId, offering.sectionId, req.user.id, question_type, question_text,
        option_a || null, option_b || null, option_c || null, option_d || null, correct_answer || null, model_answer || null,
        difficulty, bloom_level || null, place.topic, Number(marks), hash, embeddingToSqlLiteral(computeEmbedding(question_text)), answerDataJson, place.subtopic,
        versionId, place.subtopicId]);
      await logAudit({ userId: req.user.id, action: 'draft_created', entityId: created.id, details: { question_type }, ip: req.ip });
      return res.json({ id: created.id, created: true });
    } catch (dbErr) {
      // Never echo database text (spec §4); the code is enough to diagnose from the server log.
      console.error('draft insert failed:', { code: dbErr.code, constraint: dbErr.constraint });
      return res.status(400).json({ error: 'Could not save this question' });
    }
  }
});

// Preview a single draft (question + attachments + validation warnings). The author's own screen: it shows
// the answers and runs the duplicate pipeline, which records candidates against the bank, so nobody else
// (another teacher, the HOD, reviewers, the Examination domain) can call it, and candidates are recorded only
// while the question is editable (a pending duplicate on a submitted question would block its quality gate).
router.get('/:id/preview', requireAuth, requireRole('teacher'), async (req, res) => {
  const q = await scopedQuestion(req.params.id, req.user);
  if (!q) return res.status(404).json({ error: 'Not found' });
  const editable = EDITABLE_STATUSES.includes(q.question_status);

  const attachments = await all('SELECT id, file_name, file_type, file_size_bytes, scan_status FROM question_attachments WHERE question_id = $1', [q.id]);

  const warnings = [];
  // Everything still missing before this question could become ACTIVE (spec §10), as warnings. Only files that
  // passed the virus scan count (the same rule as the 040 quality gate).
  const clean = attachments.filter((a) => a.scan_status === 'clean');
  if (attachments.some((a) => a.scan_status !== 'clean')) warnings.push('An attachment has not passed the virus scan; it cannot be used until it is scanned clean');
  warnings.push(...validateQuestionByType({ ...q, attachment_count: clean.length,
    diagram_image_count: clean.filter((a) => PRINTABLE_IMAGE_TYPES.includes(a.file_type)).length }, { forActivation: true }));

  // Full dedup pipeline (spec section 7): candidate retrieval -> multi-signal
  // classification -> EXACT_DUPLICATE / LIKELY_DUPLICATE / RELATED tiers,
  // persisted so there's a durable record of what the system found. See
  // backend/src/dedup.js for what's actually compared — never text
  // similarity alone.
  // EXACT_DUPLICATE/LIKELY_DUPLICATE candidates block submission until the
  // teacher explicitly resolves them; RELATED candidates are shown but
  // don't block — they're informational context, not a forced decision,
  // since "related but distinct" is a completely normal, valid outcome.
  const { blocking, related } = editable ? await duplicateCheck(q) : { blocking: [], related: [] };
  if (blocking.length > 0) {
    warnings.push(`${blocking.length} possible duplicate${blocking.length > 1 ? 's' : ''} found — resolve ${blocking.length > 1 ? 'them' : 'it'} below before submitting.`);
  }

  const prevYear = await get(`
    SELECT year, question_text FROM previous_year_papers WHERE course_offering_id = $1 AND question_hash = $2
  `, [q.course_offering_id, q.question_hash]);
  if (prevYear) {
    warnings.push(
      `This matches a ${prevYear.year || 'previous'}-year question` +
      (prevYear.question_text ? `: "${prevYear.question_text.slice(0, 80)}${prevYear.question_text.length > 80 ? '...' : ''}"` : '')
    );
  }

  const unclean = attachments.filter(a => a.scan_status !== 'clean');

  const toClientShape = r => ({
    relationship_id: r.id, target_question_id: r.target_question_id, target_question_text: r.candidate_question_text,
    similarity: Number(r.similarity_score), classification: r.classification, reasons: r.reasons, status: r.status,
  });

  // A draft is submitted, a changes-requested question is resubmitted; nothing else can be submitted.
  const submit_mode = q.question_status === 'DRAFT' ? 'submit' : q.question_status === 'CHANGES_REQUESTED' ? 'resubmit' : null;
  res.json({
    question: q, attachments, warnings,
    duplicate_candidates: blocking.map(toClientShape),
    related_candidates: related.map(toClientShape),
    submit_mode,
    can_submit: submit_mode !== null && unclean.length === 0 && blocking.length === 0,
  });
});

// The interactive resolution the teacher sees for a possible-duplicate
// match: either withdraw their own draft in favor of the existing question,
// or explicitly record "this is different" so it stops being flagged for
// this specific pair going forward. Only the submitting teacher can decide
// on their own still-draft question — this isn't a review/approval action.
// The interactive resolution the teacher sees for a possible-duplicate/
// related match, keyed by the specific relationship_id the /preview
// endpoint already computed and persisted — not a client-supplied
// target_question_id/similarity, since those are exactly the kind of
// values that must never be trusted from the client (spec section 12).
// Which decisions are even valid depends on the tier the system already
// classified this candidate as: EXACT_DUPLICATE/LIKELY_DUPLICATE offer
// use_existing/different; RELATED offers related/different — "use existing"
// makes no sense for something the system only called RELATED, since
// merging two genuinely different questions into one canonical record
// would be exactly the kind of silent, irreversible merge spec section 2
// forbids.
router.post('/:id/duplicate-decision', requireAuth, requireRole('teacher'), async (req, res) => {
  const { relationship_id, decision } = req.body;
  const q = await scopedQuestion(req.params.id, req.user);
  if (!q) return res.status(404).json({ error: 'Not found' });
  if (!EDITABLE_STATUSES.includes(q.question_status)) return res.status(400).json({ error: 'This question has already been submitted' });

  const relationship = await get(`
    SELECT * FROM question_relationships WHERE id = $1 AND source_question_id = $2
  `, [relationship_id, q.id]);
  if (!relationship) return res.status(404).json({ error: 'No such duplicate/related candidate for this question' });
  if (relationship.status !== 'pending') return res.status(400).json({ error: 'This candidate has already been resolved' });

  const isBlockingTier = relationship.classification === 'EXACT_DUPLICATE' || relationship.classification === 'LIKELY_DUPLICATE';
  const allowedDecisions = isBlockingTier ? ['use_existing', 'different'] : ['related', 'different'];
  if (!allowedDecisions.includes(decision)) {
    return res.status(400).json({ error: `For a ${relationship.classification} candidate, decision must be one of: ${allowedDecisions.join(', ')}` });
  }
  // Withdrawing and relinking a question that already went through review would orphan its own canonical
  // question and history; only a never-submitted draft can be withdrawn here.
  // A draft withdrawn from SUBMITTED already has its own canonical question (version 1, CO mapping), so it
  // counts as submitted here too.
  if (decision === 'use_existing' && (q.question_status !== 'DRAFT' || q.canonical_question_id)) {
    return res.status(400).json({ error: 'A question that was already submitted cannot be withdrawn as a duplicate here. Mark it different or related, or ask the reviewer to reject it as a duplicate.' });
  }

  const target = await get('SELECT id, canonical_question_id FROM questions WHERE id = $1', [relationship.target_question_id]);
  if (!target) return res.status(404).json({ error: 'The referenced question no longer exists' });

  if (decision === 'use_existing') {
    // All three writes (confirming the relationship, withdrawing this
    // submission, and linking it to the existing canonical question) must
    // land together — a crash between them would leave a withdrawn
    // question with no canonical link, or a canonical link recorded for a
    // submission that's still (wrongly) marked as an active draft.
    const withdrawn = await withTransaction(async (txn) => {
      // Conditional on the state checked above: a submit racing this withdrawal wins and nothing is written.
      const wd = await txn.run(`UPDATE questions SET status = 'withdrawn_duplicate', is_draft = FALSE
        WHERE id = $1 AND question_status = 'DRAFT' AND canonical_question_id IS NULL RETURNING id`, [q.id]);
      if (wd.rowCount !== 1) return false;
      await txn.run(`UPDATE question_relationships SET relationship_type = 'duplicate', status = 'confirmed', reviewed_by = $1 WHERE id = $2`, [req.user.id, relationship.id]);
      // Confirmed-equivalent path (spec section 14): this submission's own
      // wording/answer stay exactly as the teacher typed them on its own row
      // (never overwritten) — it is simply LINKED to the SAME canonical
      // question the existing match already belongs to, so no redundant
      // canonical question is created. If the matched question somehow has
      // no canonical question yet (shouldn't happen — only non-draft,
      // already-submitted questions can be a match target, and those always
      // get canonicalized at their own /submit time), skip the link rather
      // than fail the teacher's withdrawal.
      if (target.canonical_question_id) {
        await linkToCanonical(q.id, target.canonical_question_id, Number(relationship.similarity_score), relationship.source, req.user.id,
          `Teacher confirmed equivalence with an existing question (${Math.round(Number(relationship.similarity_score) * 100)}% similar, classified ${relationship.classification})`, txn);
      }
      return true;
    });
    if (!withdrawn) return res.status(409).json({ error: 'This question changed state meanwhile; reload and try again' });
    await logAudit({ userId: req.user.id, action: 'question_withdrawn_as_duplicate', entityId: q.id, details: { target_question_id: target.id, classification: relationship.classification }, ip: req.ip });
    return res.json({ ok: true, status: 'withdrawn_duplicate' });
  } else if (decision === 'related') {
    // Non-blocking acknowledgment: the teacher agrees these two questions
    // are related but are NOT the same question — both stay independent,
    // nothing is merged or withdrawn. Recorded so a reviewer/HOD can later
    // see the relationship (e.g. when checking for semantic redundancy
    // within a single generated paper).
    await run(`UPDATE question_relationships SET relationship_type = 'related', status = 'confirmed', reviewed_by = $1 WHERE id = $2`, [req.user.id, relationship.id]);
    await logAudit({ userId: req.user.id, action: 'question_marked_related', entityId: q.id, details: { target_question_id: target.id }, ip: req.ip });
    return res.json({ ok: true, status: 'confirmed_related' });
  } else {
    await run(`UPDATE question_relationships SET status = 'dismissed', reviewed_by = $1 WHERE id = $2`, [req.user.id, relationship.id]);
    await logAudit({ userId: req.user.id, action: 'question_duplicate_dismissed', entityId: q.id, details: { target_question_id: target.id, classification: relationship.classification }, ip: req.ip });
    return res.json({ ok: true, status: 'dismissed' });
  }
});

// Final submit — one pipeline for DRAFT -> SUBMITTED and CHANGES_REQUESTED -> RESUBMITTED (spec §7);
// /transition refuses both targets, so the attachment scan, duplicate check, canonical record and CO mapping
// can't be skipped. This is also the trigger point for the AI reviewer (called separately by the frontend
// right after this succeeds, advisory only) — kept as two calls so the AI step can be re-run without
// re-submitting.
router.post('/:id/submit', requireAuth, requireRole('teacher'), async (req, res) => {
  const q = await scopedQuestion(req.params.id, req.user);
  if (!q) return res.status(404).json({ error: 'Not found' });
  const from = q.question_status;
  const to = SUBMIT_TARGETS[from];
  if (!to) return res.status(400).json({ error: `Only Draft or Changes-requested questions can be submitted; this one is ${from}`, question_status: from });
  if (!(await resolveTeacherOffering(req.user.id, q.course_offering_id, q.section_id))) {
    return res.status(403).json({ error: 'You are no longer assigned to this course offering/section' });
  }
  // A question left on a superseded syllabus version is submitted against the offering's current one (042): its COs
  // are checked there and, in the transaction below, it moves there if its topic / subtopic exist in that version.
  const targetVersion = (await currentSyllabusVersion(q.course_offering_id)) || q.syllabus_version_id || null;
  const co = await parseCourseOutcomeInput(req.body || {}, { ...q, syllabus_version_id: targetVersion });
  if (co.error) return res.status(400).json({ error: co.error, ...(co.invalid ? { invalid: co.invalid } : {}) });

  if ((await uncleanAttachments(q.id)).length > 0) {
    return res.status(400).json({ error: 'One or more attachments have not passed the security scan yet' });
  }
  // Re-run the same classification pipeline the preview screen uses, so a
  // teacher can't bypass duplicate resolution by calling /submit directly
  // without ever loading /preview. Only EXACT_DUPLICATE/LIKELY_DUPLICATE
  // candidates that are still 'pending' block submission.
  const { blocking } = await duplicateCheck(q);
  if (blocking.length > 0) {
    return res.status(400).json({ error: 'This question has an unresolved possible duplicate — resolve it first (see the preview screen)' });
  }

  // Everything from here down is atomic: the canonical question (new, or a new version of the existing one),
  // the CO mapping and the state change. A crash midway can't leave a "submitted" question with no
  // canonical link, or a canonical change without the submission.
  let out;
  try {
    out = await withTransaction(async (txn) => {
      // Lock first: a double submit or an edit racing this submit waits here, then sees the new state.
      const locked = await txn.get('SELECT * FROM questions WHERE id = $1 AND submitted_by = $2 FOR UPDATE', [q.id, req.user.id]);
      if (!locked || locked.question_status !== from) throw stateChanged();
      let versionMove = null;
      if (targetVersion && targetVersion !== (locked.syllabus_version_id || null)) {
        const place = await resolvePlacement(txn, targetVersion, { topic: locked.topic, subtopic: locked.subtopic });
        if (!place.ok) {
          throw Object.assign(new Error(`${place.error}. Edit the question and choose its topic from the current syllabus.`), { code: 'PLACEMENT' });
        }
        await txn.run('UPDATE questions SET syllabus_version_id = $1, topic = $2, subtopic = $3, subtopic_id = $4 WHERE id = $5',
          [targetVersion, place.topic, place.subtopic, place.subtopicId, q.id]);
        await txn.run(`INSERT INTO question_syllabus_remaps (question_id, from_version_id, to_version_id, kind, old_mapping, new_mapping, reason, performed_by)
          VALUES ($1, $2, $3, 'author_edit', $4::jsonb, $5::jsonb, $6, $7)`,
        [q.id, locked.syllabus_version_id || null, targetVersion, JSON.stringify({ topic: locked.topic, subtopic: locked.subtopic, subtopic_id: locked.subtopic_id || null }),
          JSON.stringify({ topic: place.topic, subtopic: place.subtopic, subtopic_id: place.subtopicId }), 'Submitted by the author against the current syllabus', req.user.id]);
        versionMove = { from: locked.syllabus_version_id || null, to: targetVersion };
        Object.assign(locked, { syllabus_version_id: targetVersion, topic: place.topic, subtopic: place.subtopic, subtopic_id: place.subtopicId });
      }

      // The canonical work happens while the row is still editable; the state moves last. A first submission
      // creates the canonical question; a resubmission (or a re-submit after withdrawing to draft) appends a
      // version to the canonical question it already has (spec §14), keeping its verified data and COs.
      let canonicalId = locked.canonical_question_id;
      let created = false;
      let version = { versionNumber: 1, versionUnchanged: false };
      if (!canonicalId) {
        canonicalId = await createCanonicalQuestion(locked, txn);
        created = true;
      } else {
        version = await appendCanonicalVersion(locked, {
          actorId: req.user.id,
          changeReason: from === 'CHANGES_REQUESTED'
            ? `Revision after reviewer change request${locked.change_request_reason ? `: ${locked.change_request_reason.slice(0, 200)}` : ''}`
            : 'Edited after withdrawal to draft',
        }, txn);
      }

      // CO mapping: the teacher's choice replaces the current mapping only when it differs (recorded as
      // source 'manual', unverified until a reviewer confirms it). Without a choice the mapping is kept; a
      // bulk-imported draft with none yet gets the CO codes typed in its spreadsheet row.
      let coChange = null;
      let unmappedCos = [];
      const current = await txn.all('SELECT course_outcome_id, relationship_type FROM question_course_outcomes WHERE canonical_question_id = $1', [canonicalId]);
      if (co.desired) {
        if (!sameCoMapping(current, co.desired)) {
          await setCourseOutcomes(canonicalId, co.desired, 'manual', req.user.id, false, txn);
          coChange = { old: current, new: co.desired, source: 'manual' };
        }
      } else if (current.length === 0 && locked.submitted_cos?.length) {
        const mapped = await resolveCourseOutcomeCodes(locked.syllabus_version_id, locked.submitted_cos, txn);
        if (mapped.primaryId) {
          await setCourseOutcomes(canonicalId, mapped, 'bulk', req.user.id, false, txn);
          coChange = { old: [], new: { primaryId: mapped.primaryId, secondaryIds: mapped.secondaryIds }, source: 'bulk' };
        }
        unmappedCos = mapped.missing;
      }

      // Only question_status is written: trg_sync_question_status derives the legacy status/is_draft and the
      // DB transition guard checks DRAFT -> SUBMITTED / CHANGES_REQUESTED -> RESUBMITTED.
      const moved = await txn.get(`
        UPDATE questions SET question_status = $1,
          submitted_at = CASE WHEN $1::text = 'SUBMITTED' THEN now() ELSE submitted_at END
        WHERE id = $2 AND question_status = $3 RETURNING id`, [to, q.id, from]);
      if (!moved) throw stateChanged();
      return { canonicalId, created, version, coChange, unmappedCos, versionMove };
    });
  } catch (err) {
    if (err.code === 'PLACEMENT') return res.status(400).json({ error: err.message });
    if (err.code === 'QUESTION_STATE_CHANGED' || /Invalid question state/.test(err.message)) {
      return res.status(409).json({ error: 'This question changed state while you were submitting it; reload and try again' });
    }
    console.error('Question submit failed:', err.message);
    return res.status(500).json({ error: 'Could not submit this question' });
  }

  await logAudit({ userId: req.user.id, action: to === 'SUBMITTED' ? 'question_final_submit' : 'question_resubmitted', entityId: q.id, ip: req.ip,
    details: { from, to, canonical_question_id: out.canonicalId, canonical_created: out.created, version_number: out.version.versionNumber,
      version_unchanged: out.version.versionUnchanged, co_mapping_changed: !!out.coChange,
      ...(out.versionMove ? { syllabus_version_moved: out.versionMove } : {}),
      ...(out.unmappedCos.length ? { unmapped_cos: out.unmappedCos } : {}) } });
  if (out.coChange) {
    await logAudit({ userId: req.user.id, action: 'question_co_mapping_changed', entityId: q.id, ip: req.ip,
      details: { canonical_question_id: out.canonicalId, old: out.coChange.old, new: out.coChange.new, source: out.coChange.source } });
  }
  if (to === 'RESUBMITTED') {
    const hods = await hodsInScope(q.course_offering_id);
    await notifyMany(hods.map((h) => h.id), 'question_resubmitted', 'A revised question was resubmitted and is waiting to be sent back to review.', q.id);
  }
  res.json({ ok: true, question_status: to, canonical_question_id: out.canonicalId, canonical_created: out.created,
    version_number: out.version.versionNumber, version_unchanged: out.version.versionUnchanged, co_mapping_changed: !!out.coChange,
    ...(out.unmappedCos.length ? { unmapped_cos: out.unmappedCos } : {}) });
});

// Full academic picture behind one submission: the canonical question it
// belongs to, its current version/answer, reviewer-verified classification,
// and CO mapping. Teachers see this for their own submissions (so they can
// tell whether their wording ended up as the canonical one, or was merged
// into someone else's). Anyone else needs the question's workflow access (authorize 'view_question_workflow':
// a reviewer actively assigned to its offering in scope, or an HOD whose scope covers it); admin, COE and
// validators never (spec §2, §4).
router.get('/:id/canonical', requireAuth, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const q = await get('SELECT id, submitted_by, canonical_question_id FROM questions WHERE id = $1', [req.params.id]);
  if (!q) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'teacher' && q.submitted_by !== req.user.id) return res.status(404).json({ error: 'Not found' });
  if (q.submitted_by !== req.user.id) {
    const authz = await authorize(req.user, 'view_question_workflow', { question_id: q.id, type: 'question', id: q.id });
    if (!authz.allowed) return res.status(403).json({ error: authz.reason });
  }
  if (!q.canonical_question_id) return res.json({ canonical: null });
  const detail = await getCanonicalDetail(q.canonical_question_id);
  res.json(detail);
});

// Teacher's own list (drafts + submitted), optionally filtered by type
router.get('/mine', requireAuth, requireRole('teacher'), async (req, res) => {
  // ?type=objective|subjective lists the teacher's tab (a group of types); any single type code works too.
  const raw = String(req.query.type || '').toLowerCase();
  const types = raw === 'objective' ? OBJECTIVE_TYPES
    : raw === 'subjective' ? QUESTION_TYPE_CODES.filter((t) => !OBJECTIVE_TYPES.includes(t))
    : raw ? [normalizeQuestionType(raw)].filter(Boolean) : null;
  const rows = types
    ? await all('SELECT * FROM questions WHERE submitted_by = $1 AND question_type = ANY($2::text[]) ORDER BY created_at DESC', [req.user.id, types])
    : await all('SELECT * FROM questions WHERE submitted_by = $1 ORDER BY created_at DESC', [req.user.id]);
  res.json(rows);
});

// HOD attention list (read-only). Each row carries the full question (type data, answer key, model answer and its
// clean attachments) so the HOD judges the question itself, not a summary. AI checks are advisory and never change status (§39 inv. 10), so this lists only
// in-flight questions (SUBMITTED/RESUBMITTED/UNDER_REVIEW) whose author disputed the automated findings, or that a
// reviewer flagged under the retired pre-batch workflow. The HOD acts only through /transition (send to review) and
// review batches; decisions belong to the assigned reviewers (§2). Scope = the HOD's active user_scopes, like
// GET /lifecycle. Admin is excluded (§2). Bounded: at most 200 rows.
router.get('/queue', requireAuth, requireRole('hod'), async (req, res) => {
  const rows = await all(`
    SELECT q.id, q.question_text, q.question_type, q.difficulty, q.marks, q.topic, q.subtopic, q.question_status,
           q.option_a, q.option_b, q.option_c, q.option_d, q.correct_answer, q.model_answer, q.answer_data,
           q.submitted_by, q.submitted_at, q.ai_review_notes, q.ai_reviewed_at, q.ai_review_dispute, q.ai_review_disputed_at,
           u.email AS teacher_email, s.subject_code, co.offering_code, ${QUESTION_ATTACHMENTS_SQL} AS attachments,
           (SELECT json_agg(json_build_object('reviewer_email', ru.email, 'comment', rv.comment, 'created_at', rv.created_at) ORDER BY rv.created_at)
              FROM reviewer_verdicts rv JOIN users ru ON ru.id = rv.reviewer_id
             WHERE rv.question_id = q.id AND rv.verdict = 'needs_hod_attention') AS legacy_reviewer_flags
    FROM questions q
    JOIN users u ON u.id = q.submitted_by
    JOIN course_offerings co ON co.id = q.course_offering_id
    JOIN programs p ON p.id = co.program_id
    LEFT JOIN subjects s ON s.id = q.subject_id
    WHERE ${SCOPE_SQL}
      AND q.question_status IN ('SUBMITTED', 'RESUBMITTED', 'UNDER_REVIEW')
      AND (q.ai_review_dispute IS NOT NULL
           OR EXISTS (SELECT 1 FROM reviewer_verdicts rv WHERE rv.question_id = q.id AND rv.verdict = 'needs_hod_attention'))
    ORDER BY COALESCE(q.ai_review_disputed_at, q.submitted_at) DESC
    LIMIT 200`, [req.user.id, 'hod']);
  res.json(rows);
});

// ---- Legacy question decisions: RETIRED ----
// PIVOT_SPEC_V2 §2/§7/§12: only an assigned reviewer (never the author, within scope) approves, requests changes or
// rejects, from the question's review batch through POST /api/question-bank/:id/transition; the HOD sends
// submissions to review there. The pre-pivot HOD 'approve anyway' decision and the reviewer
// looks_good/needs_hod_attention verdict wrote the legacy `status`, which the 031 bridge turned into
// question_status changes without the transition guard, so they now return 410 (migration 038 also refuses
// such writes in the DB). reviewer_verdicts rows are kept (read by the HOD attention list and the
// validator-independence check). The old implementation is in git history.
const retiredDecision = (what, instead) => (req, res) => res.status(410).json({ error: `${what} is retired. ${instead}` });
router.post('/:id/review', requireAuth, retiredDecision('The legacy HOD escalation decision',
  'Questions are approved, sent back or rejected by their assigned reviewers via POST /api/question-bank/:id/transition; the HOD sends submissions to review there.'));
router.get('/reviewer-queue', requireAuth, retiredDecision('The legacy reviewer queue',
  'Use GET /api/question-bank/lifecycle?status=UNDER_REVIEW and the review batches under /api/review/batches.'));
router.post('/:id/reviewer-verdict', requireAuth, retiredDecision('The legacy reviewer verdict',
  'Record decisions with a review-batch verdict and POST /api/question-bank/:id/transition.'));

// ---- Mistake detection: automatic checks per teacher ----
// HOD only (spec §2: admin is technical-only), and only for a teacher who teaches or has submitted in an
// offering the HOD's scope covers (authorize 'view_teacher_quality'; 404 otherwise, so other departments' staff
// are not confirmed). Every figure counts only questions of offerings inside the HOD's scope: a teacher who also
// teaches in another department keeps that work private from this HOD.
router.get('/mistakes/:teacherId', requireAuth, requireRole('hod'), async (req, res) => {
  const teacherId = req.params.teacherId;
  if (!UUID_RE.test(teacherId)) return res.status(404).json({ error: 'Teacher not found in your scope' });
  const authz = await authorize(req.user, 'view_teacher_quality', { teacher_id: teacherId, type: 'user', id: teacherId });
  if (!authz.allowed) return res.status(authz.notFound ? 404 : 403).json({ error: authz.reason });
  const P = [req.user.id, 'hod', teacherId];
  const scoped = (joins = '') => `FROM questions q JOIN course_offerings co ON co.id = q.course_offering_id JOIN programs p ON p.id = co.program_id ${joins}
    WHERE q.submitted_by = $3 AND ${SCOPE_SQL}`;
  const issues = [];

  const dupes = await all(`SELECT q.question_hash, COUNT(*) AS cnt ${scoped()} GROUP BY q.question_hash HAVING COUNT(*) > 1`, P);
  dupes.forEach(d => issues.push({ type: 'duplicate_submission', detail: `Submitted ${d.cnt} near-identical questions`, hash: d.question_hash }));

  // Incomplete = what would stop the question from becoming ACTIVE, for every type (the shared rules of
  // question-types.js with forActivation, the same as the author's preview), plus invalid marks. Bounded.
  const submitted = await all(`SELECT q.id, q.question_text, q.question_type, q.option_a, q.option_b, q.option_c, q.option_d,
      q.correct_answer, q.model_answer, q.answer_data, q.marks,
      (SELECT COUNT(*) FROM question_attachments a WHERE a.question_id = q.id AND a.scan_status = 'clean')::int AS attachment_count,
      (SELECT COUNT(*) FROM question_attachments a WHERE a.question_id = q.id AND a.scan_status = 'clean' AND a.file_type = ANY($4::text[]))::int AS diagram_image_count
    ${scoped()} AND q.is_draft = FALSE AND q.question_status NOT IN ('REJECTED', 'RETIRED')
    ORDER BY q.submitted_at DESC NULLS LAST LIMIT 1000`, [...P, PRINTABLE_IMAGE_TYPES]);
  for (const q of submitted) {
    const problems = validateQuestionByType(q, { forActivation: true });
    if (!(Number(q.marks) > 0)) problems.push('Invalid marks');
    if (problems.length) issues.push({ type: 'incomplete_question', detail: `${typeLabel(q.question_type)}: ${problems.join('; ')}`, question_id: q.id, problems });
  }

  const difficultyCounts = await all(`SELECT q.difficulty, COUNT(*) AS cnt ${scoped()} AND q.is_draft = FALSE GROUP BY q.difficulty`, P);

  const topicCounts = await all(`SELECT q.topic, COUNT(*) AS cnt ${scoped()} AND q.is_draft = FALSE AND q.topic IS NOT NULL GROUP BY q.topic`, P);
  if (topicCounts.length > 1) {
    const avg = topicCounts.reduce((s, t) => s + Number(t.cnt), 0) / topicCounts.length;
    topicCounts.filter(t => Number(t.cnt) > avg * 1.5).forEach(t =>
      issues.push({ type: 'topic_imbalance', detail: `Topic "${t.topic}" has ${t.cnt} questions, well above this teacher's average of ${avg.toFixed(1)}` }));
  }

  const repeats = await all(`SELECT q.id, q.question_text, py.year AS matched_year
    ${scoped('JOIN previous_year_papers py ON py.question_hash = q.question_hash AND py.course_offering_id = q.course_offering_id')}`, P);
  repeats.forEach(q => issues.push({
    type: 'repeats_previous_year',
    detail: `Matches a ${q.matched_year || 'previous'}-year question`,
    question_id: q.id
  }));

  res.json({ teacherId, issues, difficulty_distribution: difficultyCounts, topic_distribution: topicCounts });
});

export default router;
