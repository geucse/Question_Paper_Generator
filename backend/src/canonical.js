import { get as dbGet, all as dbAll, run as dbRun } from './db.js';

// pg returns jsonb as an object; bind parameters for ::jsonb need JSON text.
const jsonParam = (v) => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));

// Key-sorted JSON, so two answer_data objects compare by content. NULL, undefined and {} are equal
// (the draft route stores an empty answer_data as NULL).
export function stableJson(v) {
  const norm = (x) => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().map((k) => [k, norm(x[k])]));
    return x;
  };
  let value = v;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { /* compare as text */ } }
  if (value == null || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)) return 'null';
  return JSON.stringify(norm(value));
}

// Every exported function here takes an optional `db` handle as its last
// parameter — defaulting to the plain auto-commit get/run from db.js, but
// accepting the {get, run} shape returned by db.js's withTransaction() so a
// caller can make a whole multi-step canonicalization atomic. Without this,
// a crash between (for example) inserting canonical_questions and inserting
// its question_versions row would leave a canonical question with no
// current version — a real data-integrity gap, not a cosmetic one.

// Called exactly once per submission, the first time it is submitted (/submit
// or a bulk confirm; never at draft time — a draft isn't an institutional asset
// yet). Later resubmissions go through appendCanonicalVersion below. By this point the
// duplicate-decision flow has already run: if the teacher confirmed "this
// is the same as an existing question", /duplicate-decision short-circuits
// the submission (status becomes withdrawn_duplicate) and this function is
// never reached for that submission — see linkToCanonical below for that
// path instead. So any submission that reaches here is, as far as the
// system currently knows, a genuinely new canonical question.
//
// Note on `q.embedding`: this is the value as read straight back from the
// `questions` row (pg returns pgvector columns as their literal text form,
// e.g. "[0.1,0.2,...]"), NOT a freshly computed JS array — so it is passed
// straight through as a bind parameter and cast with `::vector`, exactly
// the same way the existing near-duplicate queries in ai-review.js and
// questions.js already do. Use embeddingToSqlLiteral() only when you have
// computed a fresh array from computeEmbedding(), not when relaying an
// already-stored value.
export async function createCanonicalQuestion(q, db = { get: dbGet, run: dbRun }) {
  const normalized = q.question_text.toLowerCase().replace(/\s+/g, ' ').trim();

  const canonical = await db.get(`
    INSERT INTO canonical_questions
      (subject_id, canonical_text, normalized_text, question_type, question_hash,
       quality_status, workflow_status, applicability_status, embedding)
    VALUES ($1, $2, $3, $4, $5, 'pending', 'submitted', 'active', $6::vector)
    RETURNING id
  `, [q.subject_id, q.question_text, normalized, q.question_type, q.question_hash, q.embedding || null]);

  const version = await db.get(`
    INSERT INTO question_versions
      (canonical_question_id, version_number, question_text, question_type, marks,
       option_a, option_b, option_c, option_d, correct_answer, answer_data, subtopic, created_by, change_reason, is_current)
    VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, 'Initial submission', TRUE)
    RETURNING id
  `, [canonical.id, q.question_text, q.question_type, q.marks,
      q.option_a || null, q.option_b || null, q.option_c || null, q.option_d || null,
      q.correct_answer || null, jsonParam(q.answer_data), q.subtopic || null, q.submitted_by]);

  await db.run('UPDATE canonical_questions SET current_version_id = $1 WHERE id = $2', [version.id, canonical.id]);

  if (q.model_answer && q.model_answer.trim().length > 0) {
    await db.run(`
      INSERT INTO canonical_answers (canonical_question_id, version_number, answer_text, created_by, status, is_current)
      VALUES ($1, 1, $2, $3, 'draft', TRUE)
    `, [canonical.id, q.model_answer, q.submitted_by]);
  }

  await db.run(`
    INSERT INTO question_canonicalization_events (canonical_question_id, submission_id, action, reason, performed_by)
    VALUES ($1, $2, 'created_canonical', 'New teacher submission, no confirmed match found', $3)
  `, [canonical.id, q.id, q.submitted_by]);

  await db.run('UPDATE questions SET canonical_question_id = $1 WHERE id = $2', [canonical.id, q.id]);

  return canonical.id;
}

// A resubmission after CHANGES_REQUESTED (or a re-submit after the author withdrew a submission to draft)
// is the SAME institutional question, not a new one (spec §14: Q102 v1/v2/v3, history kept). So instead of a
// second canonical question it appends a version to the one this submission already belongs to, and moves
// current_version_id to it - paper snapshots read current_version_id, so later papers reference the new
// version and earlier snapshots keep theirs. Reviewer-verified difficulty/Bloom/unit/topic and the CO mapping
// stay on the canonical question. Identical content adds no version (versionUnchanged). The canonical answer
// is versioned the same way and never deleted. Must run inside the caller's transaction.
export async function appendCanonicalVersion(q, { actorId, changeReason }, db = { get: dbGet, run: dbRun }) {
  const cid = q.canonical_question_id;
  const canonical = await db.get('SELECT id, current_version_id FROM canonical_questions WHERE id = $1 FOR UPDATE', [cid]);
  if (!canonical) throw new Error('Canonical question not found');
  const current = canonical.current_version_id
    ? await db.get('SELECT * FROM question_versions WHERE id = $1', [canonical.current_version_id])
    : null;
  const same = (a, b) => (a ?? null) === (b ?? null);
  const unchanged = !!current && same(current.question_text, q.question_text) && same(current.question_type, q.question_type)
    && Number(current.marks) === Number(q.marks)
    && ['option_a', 'option_b', 'option_c', 'option_d', 'correct_answer', 'subtopic'].every((k) => same(current[k] || null, q[k] || null))
    && stableJson(current.answer_data) === stableJson(q.answer_data);

  let versionNumber = current?.version_number || 1;
  if (!unchanged) {
    versionNumber = (await db.get('SELECT COALESCE(MAX(version_number), 0) + 1 AS n FROM question_versions WHERE canonical_question_id = $1', [cid])).n;
    // Cleared before the insert so the one-current-version index (migration 038) holds at every statement.
    await db.run('UPDATE question_versions SET is_current = FALSE WHERE canonical_question_id = $1 AND is_current', [cid]);
    const v = await db.get(`
      INSERT INTO question_versions (canonical_question_id, version_number, question_text, question_type, marks,
        option_a, option_b, option_c, option_d, correct_answer, answer_data, subtopic, created_by, change_reason, is_current)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, TRUE) RETURNING id
    `, [cid, versionNumber, q.question_text, q.question_type, q.marks, q.option_a || null, q.option_b || null, q.option_c || null,
        q.option_d || null, q.correct_answer || null, jsonParam(q.answer_data), q.subtopic || null, actorId, changeReason]);
    await db.run(`
      UPDATE canonical_questions SET current_version_id = $1, canonical_text = $2, normalized_text = $3, question_type = $4,
        question_hash = $5, embedding = COALESCE($6::vector, embedding), updated_at = now()
      WHERE id = $7
    `, [v.id, q.question_text, q.question_text.toLowerCase().replace(/\s+/g, ' ').trim(), q.question_type, q.question_hash, q.embedding || null, cid]);
  }

  const answer = await db.get('SELECT id, answer_text FROM canonical_answers WHERE canonical_question_id = $1 AND is_current = TRUE', [cid]);
  const newAnswer = q.model_answer && q.model_answer.trim().length > 0 ? q.model_answer : null;
  let answerVersioned = false;
  if ((newAnswer && answer?.answer_text !== newAnswer) || (!newAnswer && answer)) {
    if (answer) await db.run("UPDATE canonical_answers SET is_current = FALSE, status = 'superseded' WHERE id = $1", [answer.id]);
    if (newAnswer) {
      const n = (await db.get('SELECT COALESCE(MAX(version_number), 0) + 1 AS n FROM canonical_answers WHERE canonical_question_id = $1', [cid])).n;
      await db.run(`
        INSERT INTO canonical_answers (canonical_question_id, version_number, answer_text, created_by, status, is_current)
        VALUES ($1, $2, $3, $4, 'draft', TRUE)
      `, [cid, n, newAnswer, actorId]);
    }
    answerVersioned = true;
  }
  return { canonicalQuestionId: cid, versionNumber: Number(versionNumber), versionUnchanged: unchanged, answerVersioned };
}

// Called when a teacher confirms "Use Existing Question" during duplicate
// resolution (spec section 14): the new submission's original wording and
// answer are preserved on its own `questions` row (never overwritten), it
// is simply LINKED to the same canonical question the matched question
// already belongs to — no redundant canonical question is created.
export async function linkToCanonical(submissionId, canonicalQuestionId, similarityScore, source, performedBy, reason, db = { get: dbGet, run: dbRun }) {
  await db.run('UPDATE questions SET canonical_question_id = $1 WHERE id = $2', [canonicalQuestionId, submissionId]);
  await db.run(`
    INSERT INTO question_canonicalization_events
      (canonical_question_id, submission_id, action, similarity_score, reason, performed_by)
    VALUES ($1, $2, 'linked_to_canonical', $3, $4, $5)
  `, [canonicalQuestionId, submissionId, similarityScore, reason, performedBy]);
}

// Replace this canonical question's CO mapping. Deliberately a full
// replace (delete + reinsert) rather than a diff — CO mapping changes are
// infrequent and this keeps the "what does it map to right now" query
// trivial, while question_canonicalization_events / audit_log (call site's
// job) still capture that a change happened and by whom.
export async function setCourseOutcomes(canonicalQuestionId, { primaryId, secondaryIds = [] }, sourceLabel, actorUserId, verified, db = { get: dbGet, run: dbRun }) {
  await db.run('DELETE FROM question_course_outcomes WHERE canonical_question_id = $1', [canonicalQuestionId]);
  const rows = [];
  if (primaryId) rows.push({ coId: primaryId, type: 'primary' });
  for (const id of secondaryIds) {
    if (id && id !== primaryId) rows.push({ coId: id, type: 'secondary' });
  }
  for (const r of rows) {
    await db.run(`
      INSERT INTO question_course_outcomes
        (canonical_question_id, course_outcome_id, relationship_type, source, verified_by, verified_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (canonical_question_id, course_outcome_id) DO UPDATE SET relationship_type = $3, source = $4, verified_by = $5, verified_at = $6
    `, [canonicalQuestionId, r.coId, r.type, sourceLabel, verified ? actorUserId : null, verified ? new Date() : null]);
  }
}

// CO codes as a teacher typed them (bulk spreadsheet), resolved against ONE syllabus version: COs belong
// to their syllabus context (spec §9), so 'CO3' only means something there. The first code is the PRIMARY
// CO, the rest SECONDARY (same model as /submit). `missing` lists codes (as typed) with no active CO there.
export async function resolveCourseOutcomeCodes(syllabusVersionId, codes, db = { get: dbGet, all: dbAll, run: dbRun }) {
  const typed = new Map();
  for (const c of codes || []) {
    const t = String(c).trim();
    if (t && !typed.has(t.toLowerCase())) typed.set(t.toLowerCase(), t);
  }
  if (!syllabusVersionId || typed.size === 0) return { primaryId: null, secondaryIds: [], missing: [...typed.values()] };
  const rows = await db.all(`
    SELECT id, lower(code) AS code FROM course_outcomes
    WHERE syllabus_version_id = $1 AND is_active AND lower(code) = ANY($2::text[])
  `, [syllabusVersionId, [...typed.keys()]]);
  const byCode = new Map(rows.map((r) => [r.code, r.id]));
  const ids = [...typed.keys()].map((k) => byCode.get(k)).filter(Boolean);
  return { primaryId: ids[0] || null, secondaryIds: ids.slice(1), missing: [...typed.entries()].filter(([k]) => !byCode.has(k)).map(([, t]) => t) };
}

// Everything a reviewer or a teacher needs to see about the canonical
// question a submission belongs to: current wording/marks, the canonical
// answer, reviewer-verified classification, and its CO mapping.
export async function getCanonicalDetail(canonicalQuestionId) {
  if (!canonicalQuestionId) return null;
  const canonical = await dbGet('SELECT * FROM canonical_questions WHERE id = $1', [canonicalQuestionId]);
  if (!canonical) return null;
  const currentVersion = canonical.current_version_id
    ? await dbGet('SELECT * FROM question_versions WHERE id = $1', [canonical.current_version_id])
    : null;
  const currentAnswer = await dbGet(`
    SELECT * FROM canonical_answers WHERE canonical_question_id = $1 AND is_current = TRUE
  `, [canonicalQuestionId]);
  const courseOutcomes = await dbGet(`
    SELECT json_agg(json_build_object(
      'course_outcome_id', qco.course_outcome_id, 'code', co.code, 'description', co.description,
      'relationship_type', qco.relationship_type, 'source', qco.source, 'verified_by', qco.verified_by
    )) as cos
    FROM question_course_outcomes qco JOIN course_outcomes co ON co.id = qco.course_outcome_id
    WHERE qco.canonical_question_id = $1
  `, [canonicalQuestionId]);
  return { canonical, currentVersion, currentAnswer, courseOutcomes: courseOutcomes.cos || [] };
}
