import express from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { get, all, withTransaction } from '../db.js';
import { requireAuth, requireRole } from '../middleware.js';
import { QUESTION_TYPES, OBJECTIVE_TYPES, normalizeQuestionType, normalizeQuestionData, validateQuestionByType, answerDataFromRow, parseAnswerData } from '../question-types.js';
import { SHEET_COLUMNS, TEMPLATE_EXAMPLES } from '../question-export.js';
import { logAudit } from '../audit.js';
import { normalizeQuestionHash } from '../auth.js';
import { computeEmbedding, embeddingToSqlLiteral } from '../embeddings.js';
import { createCanonicalQuestion, setCourseOutcomes, resolveCourseOutcomeCodes } from '../canonical.js';
import { classifyAgainstBank, persistCandidates } from '../dedup.js';
import { resolvePlacement } from '../syllabus-versioning.js';
import { BLOOM_LEVELS } from '../taxonomy.js';

// File size kept deliberately small (2MB is plenty for 200 rows of text). The parser is SheetJS 0.20.3 from the
// SheetJS CDN (the npm registry's `xlsx` stops at 0.18.5, which has prototype-pollution/ReDoS advisories); a
// spreadsheet is still untrusted input, so a tight size cap limits what a crafted file can cost.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
const router = express.Router();

const REQUIRED = ['question_text', 'difficulty', 'marks'];
const VALID_DIFFICULTY = ['easy', 'medium', 'hard'];
const VALID_BLOOM = BLOOM_LEVELS;
const BLOCKING = ['EXACT_DUPLICATE', 'LIKELY_DUPLICATE'];
// A row that is not inserted yet: matches nothing in findCandidates' `id != $n`.
const NO_QUESTION_ID = '00000000-0000-0000-0000-000000000000';

// What the duplicate pipeline (dedup.js) compares, for a spreadsheet row.
function dedupProbe(r, type, bloom) {
  const text = String(r.question_text);
  return { id: NO_QUESTION_ID, question_text: text, question_hash: r.__hash || normalizeQuestionHash(text),
    embedding: embeddingToSqlLiteral(computeEmbedding(text)), model_answer: r.model_answer || null, question_type: type,
    marks: Number(r.marks), topic: r.topic || null, difficulty: String(r.difficulty).toLowerCase(), submitted_bloom_level: bloom };
}

// The teacher's active assignment for the offering (and section, when given). No section given: a teacher
// assigned to one section of the offering uploads into that section. A given section must be an active section
// of that same offering (also enforced by the composite FK, migration 040).
async function findAssignment(teacherId, offeringId, sectionId) {
  return get(`
    SELECT tca.course_offering_id, tca.section_id, co.subject_id
    FROM teacher_course_assignments tca
    JOIN course_offerings co ON co.id = tca.course_offering_id
    WHERE tca.teacher_id = $1 AND tca.course_offering_id = $2 AND tca.is_active = TRUE
      AND ($3::uuid IS NULL OR tca.section_id IS NULL OR tca.section_id = $3::uuid)
      AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM sections s WHERE s.id = $3::uuid AND s.course_offering_id = tca.course_offering_id AND s.is_active))
    ORDER BY tca.section_id NULLS FIRST, tca.created_at
    LIMIT 1
  `, [teacherId, offeringId || null, sectionId || null]);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const conflict = (message) => Object.assign(new Error(message), { conflict: true });

router.post('/', requireAuth, requireRole('teacher'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const { course_offering_id, section_id } = req.body;
  if (!UUID_RE.test(String(course_offering_id || '')) || (section_id && !UUID_RE.test(String(section_id)))) {
    return res.status(400).json({ error: 'course_offering_id (and section_id, when given) must be valid ids' });
  }
  const assignment = await findAssignment(req.user.id, course_offering_id, section_id);
  if (!assignment) {
    return res.status(403).json({ error: 'You are not assigned to that course offering/section' });
  }
  const resolvedSectionId = section_id || assignment.section_id || null;

  let rows;
  try {
    // cellFormula/cellHTML/cellNF disabled: only plain values are parsed out,
    // which avoids exercising the more complex (and more vulnerability-prone)
    // code paths in the parser for a file we don't trust.
    const wb = XLSX.read(req.file.buffer, {
      type: 'buffer', cellFormula: false, cellHTML: false, cellNF: false, sheetStubs: false
    });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true });
    if (rows.length > 200) {
      return res.status(400).json({ error: 'File has too many rows (max 200)' });
    }
  } catch (e) {
    return res.status(400).json({ error: 'Could not parse file as Excel/CSV' });
  }

  // Academic context for validating rows: the offering's CURRENT syllabus version.
  const ctx = await get('SELECT syllabus_version_id FROM course_offerings WHERE id = $1', [assignment.course_offering_id]);
  const cos = new Set();
  const topics = new Set();
  if (ctx?.syllabus_version_id) {
    (await all('SELECT code FROM course_outcomes WHERE syllabus_version_id = $1 AND is_active', [ctx.syllabus_version_id])).forEach(r => cos.add(r.code.toLowerCase()));
    (await all(`SELECT t.title FROM syllabus_topics t JOIN syllabus_units u ON u.id = t.syllabus_unit_id
                WHERE u.syllabus_version_id = $1 AND t.is_active AND u.is_active`, [ctx.syllabus_version_id])).forEach(r => topics.add(r.title.toLowerCase()));
  }
  // Subtopics (spec §8) by topic, loaded once and only if some row names one: lower topic -> lower subtopic -> title.
  let subtopicIndex = null;
  async function loadSubtopics() {
    if (subtopicIndex) return subtopicIndex;
    subtopicIndex = new Map();
    if (!ctx?.syllabus_version_id) return subtopicIndex;
    const rowsSt = await all(`
      SELECT t.title AS topic, st.title, st.id FROM syllabus_subtopics st
      JOIN syllabus_topics t ON t.id = st.syllabus_topic_id JOIN syllabus_units u ON u.id = t.syllabus_unit_id
      WHERE u.syllabus_version_id = $1 AND st.is_active AND t.is_active AND u.is_active`, [ctx.syllabus_version_id]);
    for (const r of rowsSt) {
      const key = r.topic.trim().toLowerCase();
      if (!subtopicIndex.has(key)) subtopicIndex.set(key, new Map());
      subtopicIndex.get(key).set(r.title.trim().toLowerCase(), { title: r.title.trim(), id: r.id ?? null });
    }
    return subtopicIndex;
  }

  const errors = [];
  const warnings = [];
  const validRows = [];
  const seenInFile = new Set();

  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    const rowNum = idx + 2; // account for header row
    const rowErrors = [];
    const rowWarnings = [];

    for (const field of REQUIRED) {
      if (!row[field] || String(row[field]).trim() === '') rowErrors.push(`missing ${field}`);
    }
    if (row.difficulty && !VALID_DIFFICULTY.includes(String(row.difficulty).toLowerCase())) {
      rowErrors.push(`invalid difficulty '${row.difficulty}'`);
    }
    if (row.marks && (isNaN(Number(row.marks)) || Number(row.marks) <= 0)) {
      rowErrors.push('marks must be a positive number');
    }

    // Controlled metadata (spec 8): Bloom, CO and topic must be valid for this syllabus.
    const bloom = String(row.bloom_level || '').trim().toLowerCase();
    if (!bloom) rowErrors.push('missing bloom_level');
    else if (!VALID_BLOOM.includes(bloom)) rowErrors.push(`invalid bloom_level '${row.bloom_level}'`);

    // Case-insensitively de-duplicated, keeping the spelling typed; the first code is the primary CO.
    const coList = [...new Map(String(row.co || '').split(/[,;/\s]+/).map(c => c.trim()).filter(Boolean).map(c => [c.toLowerCase(), c])).values()];
    if (coList.length === 0) rowErrors.push('missing co');
    else for (const c of coList) if (!cos.has(c.toLowerCase())) rowErrors.push(`invalid CO '${c}' for this syllabus`);

    const topicKey = String(row.topic || '').trim().toLowerCase();
    if (!topicKey) rowErrors.push('missing topic');
    else if (topics.size > 0 && !topics.has(topicKey)) rowErrors.push(`topic '${row.topic}' not in syllabus`);
    const topicOk = !!topicKey && (topics.size === 0 || topics.has(topicKey));

    // Optional subtopic: must be an active subtopic of the row's topic in this syllabus (the quality gate's rule),
    // stored with the syllabus spelling.
    // Stored as the subtopic's id too (questions.subtopic_id, migration 042).
    const rawSub = String(row.subtopic || '').trim();
    let subtopic = null;
    let subtopicId = null;
    if (rawSub) {
      if (rawSub.length > 200) rowErrors.push('subtopic exceeds 200 characters');
      else if (topicOk) {
        const hit = (await loadSubtopics()).get(topicKey)?.get(rawSub.toLowerCase()) || null;
        if (!hit) rowErrors.push(`subtopic '${rawSub}' is not under topic '${String(row.topic).trim()}' in this syllabus`);
        else { subtopic = hit.title; subtopicId = hit.id; }
      }
    }
    if (String(row.answer_data ?? '').trim() && parseAnswerData(row.answer_data) === null) rowErrors.push('answer_data is not a valid JSON object');

    // Question type (spec §8): any of the 13 types; legacy objective/subjective accepted. Without a type,
    // a row with all four options is an MCQ and anything else descriptive (previous behaviour).
    const hasOptions = ['option_a', 'option_b', 'option_c', 'option_d'].every(k => String(row[k] || '').trim());
    const qType = normalizeQuestionType(row.question_type || (hasOptions ? 'mcq' : 'descriptive'));
    const answerData = answerDataFromRow(row);
    if (!qType) rowErrors.push(`invalid question_type '${row.question_type}'`);
    else {
      // Diagram rows are imported as DRAFT (a file can't travel in a spreadsheet): the teacher attaches it and
      // submits through /submit. Previous rules and messages kept for MCQ (one message when options or answer are missing) and
      // for descriptive types (model answer); the new types use the shared type-specific rules.
      if (qType === 'mcq' && (!hasOptions || !String(row.correct_answer || '').trim())) {
        rowErrors.push('objective question needs options a-d and correct_answer (MCQ)');
      } else {
        for (const e of validateQuestionByType({ ...row, question_type: qType, answer_data: answerData })) rowErrors.push(e);
      }
      if (!OBJECTIVE_TYPES.includes(qType) && String(row.model_answer || '').trim().length < 5) {
        rowErrors.push(qType === 'descriptive' ? 'subjective question needs a model_answer' : `${qType} question needs a model_answer`);
      }
      if (qType === 'diagram') rowWarnings.push('diagram question: saved as a DRAFT when you confirm. Attach the diagram, then submit it from My questions');
      // What is still missing before the question could become ACTIVE (not needed to submit), as warnings.
      for (const w of validateQuestionByType({ ...row, question_type: qType, answer_data: answerData, attachment_count: 1 }, { forActivation: true })) {
        if (!rowErrors.includes(w)) rowWarnings.push(`before ACTIVE: ${w}`);
      }
    }

    if (row.question_text) {
      const hash = normalizeQuestionHash(String(row.question_text));
      if (seenInFile.has(hash)) rowErrors.push('duplicate question within this file');
      seenInFile.add(hash);

      const existing = await get('SELECT id FROM questions WHERE course_offering_id = $1 AND question_hash = $2',
        [assignment.course_offering_id, hash]);
      if (existing) rowErrors.push('duplicate candidate: already in the bank');
      row.__hash = hash;
    }

    // Similar (not identical) questions are flagged, never rejected (spec §13): the row is kept and saved as a
    // DRAFT at confirm time for the teacher to resolve. Confirm re-checks against the bank as it is then.
    if (rowErrors.length === 0 && qType !== 'diagram') {
      const blocking = (await classifyAgainstBank(dedupProbe(row, qType, bloom), assignment.course_offering_id))
        .filter((c) => BLOCKING.includes(c.classification));
      if (blocking.length > 0) {
        rowWarnings.push(`possible duplicate of an existing question (${Math.round(blocking[0].similarity * 100)}% similar): it will be saved as a DRAFT for you to resolve before submitting`);
      }
    }

    if (rowErrors.length > 0) {
      errors.push({ row: rowNum, errors: rowErrors });
    } else {
      if (rowWarnings.length) warnings.push({ row: rowNum, warnings: rowWarnings });
      // The same per-type normal form as a draft save (question-types.js normalizeQuestionData): MCQ letter ->
      // option text, upper-cased keys, and options / answer data the type does not use dropped.
      const norm = normalizeQuestionData({ ...row, question_type: qType, answer_data: answerData });
      validRows.push({ ...row, __row: rowNum, __type: qType, __bloom: bloom, __cos: coList, __subtopic: subtopic, __subtopic_id: subtopicId,
        __answer_data: Object.keys(norm.answer_data).length ? norm.answer_data : null, __correct: norm.correct_answer,
        __options: { option_a: norm.option_a, option_b: norm.option_b, option_c: norm.option_c, option_d: norm.option_d } });
    }
  }

  // Nothing is imported yet. Valid rows are held for the teacher to confirm.
  const batch = await get(`
    INSERT INTO bulk_upload_batches (uploaded_by, course_offering_id, file_name, total_rows, valid_rows, error_rows, status, error_report, payload)
    VALUES ($1, $2, $3, $4, $5, $6, 'validated', $7, $8)
    RETURNING id
  `, [req.user.id, assignment.course_offering_id, req.file.originalname, rows.length, validRows.length, errors.length,
    JSON.stringify(errors), JSON.stringify({ rows: validRows, section_id: resolvedSectionId, subject_id: assignment.subject_id,
      syllabus_version_id: ctx?.syllabus_version_id || null })]);

  await logAudit({
    userId: req.user.id, action: 'bulk_upload_validated', entityId: batch.id,
    details: { total: rows.length, valid: validRows.length, errors: errors.length }, ip: req.ip
  });

  res.json({
    batchId: batch.id, total_rows: rows.length, valid_rows: validRows.length, error_rows: errors.length, errors, warnings,
    needs_confirmation: validRows.length > 0, created_question_ids: [],
  });
});

// Confirm: only now are the valid rows created, inside one transaction (never as ACTIVE). A row that passes
// everything /submit checks becomes SUBMITTED with its canonical question and (unverified, source 'bulk')
// CO mapping, exactly like a /submit. Diagram rows and rows with a possible duplicate become DRAFTs the
// teacher finishes through /submit, so an imported row can never skip a check /submit enforces.
router.post('/:batchId/confirm', requireAuth, requireRole('teacher'), async (req, res) => {
  const batch = await get(`SELECT * FROM bulk_upload_batches WHERE id = $1 AND uploaded_by = $2`, [req.params.batchId, req.user.id]);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  if (batch.status !== 'validated') return res.status(409).json({ error: `Batch is already ${batch.status}` });

  const { rows, section_id, subject_id, syllabus_version_id } = batch.payload;
  const refuse = async (status, error) => {
    await logAudit({ userId: req.user.id, action: 'bulk_upload_confirm_refused', entityId: batch.id, details: { error }, ip: req.ip });
    return res.status(status).json({ error });
  };
  if (!(await findAssignment(req.user.id, batch.course_offering_id, section_id))) {
    return refuse(403, 'You are no longer assigned to that course offering/section');
  }
  // COs and topics were checked against the syllabus version current at validation; a changed syllabus
  // means the file must be validated again (nothing is silently dropped or remapped).
  const current = await get('SELECT syllabus_version_id FROM course_offerings WHERE id = $1', [batch.course_offering_id]);
  if (!syllabus_version_id || current?.syllabus_version_id !== syllabus_version_id) {
    return refuse(409, "The course offering's syllabus changed after this file was validated. Upload the file again.");
  }

  const created = [];
  try {
    await withTransaction(async (txn) => {
      // Claim the batch first so a double-click cannot import twice (a refusal below rolls the claim back).
      const claimed = await txn.run(`UPDATE bulk_upload_batches SET status = 'confirmed' WHERE id = $1 AND status = 'validated'`, [batch.id]);
      if (claimed.rowCount !== 1) throw conflict('Batch was already confirmed');
      for (const r of rows) {
        // COs are re-resolved against the same syllabus version; a CO deactivated since validation refuses the batch.
        const cos = await resolveCourseOutcomeCodes(syllabus_version_id, r.__cos, txn);
        if (!cos.primaryId || cos.missing.length) {
          throw conflict(`Row ${r.__row}: course outcome ${cos.missing.join(', ') || '(none)'} is no longer active in this syllabus. Upload the file again.`);
        }
        const probe = dedupProbe(r, r.__type, r.__bloom);
        const reasons = [];
        let classified = [];
        if (r.__type === 'diagram') reasons.push('needs_diagram');
        else {
          // Inside the transaction, so rows inserted earlier in this batch are candidates too.
          classified = await classifyAgainstBank(probe, batch.course_offering_id, txn);
          if (classified.some((c) => BLOCKING.includes(c.classification))) reasons.push('duplicate_candidate');
        }
        const isDraft = reasons.length > 0;
        // A batch validated before 042 carries the subtopic title only: its id is resolved in the same version.
        let subtopicId = r.__subtopic_id ?? null;
        if (r.__subtopic && !subtopicId) {
          const place = await resolvePlacement(txn, syllabus_version_id, { topic: r.topic, subtopic: r.__subtopic });
          if (!place.ok) throw conflict(`Row ${r.__row}: ${place.error}. Upload the file again.`);
          subtopicId = place.subtopicId;
        }
        const q = await txn.get(`
          INSERT INTO questions (subject_id, course_offering_id, section_id, submitted_by, question_type, question_text,
            option_a, option_b, option_c, option_d, correct_answer, model_answer, difficulty, topic, subtopic, marks, question_hash,
            embedding, submitted_bloom_level, submitted_cos, syllabus_version_id, is_draft, status, question_status, submitted_at,
            bulk_batch_id, answer_data, subtopic_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::vector,$19,$20,$21,$22::boolean,'pending',$23,
            CASE WHEN $22::boolean THEN NULL ELSE now() END,$24,$25::jsonb,$26)
          RETURNING *
        `, [subject_id, batch.course_offering_id, section_id, req.user.id, r.__type, String(r.question_text),
          ...(r.__options ? ['option_a', 'option_b', 'option_c', 'option_d'].map((k) => r.__options[k])
            : [r.option_a || null, r.option_b || null, r.option_c || null, r.option_d || null]), // batches validated before 4a
          r.__correct ?? (r.correct_answer || null), r.model_answer || null,
          String(r.difficulty).toLowerCase(), r.topic || null, r.__subtopic ?? null, Number(r.marks), r.__hash, probe.embedding,
          r.__bloom, r.__cos, syllabus_version_id, isDraft, isDraft ? 'DRAFT' : 'SUBMITTED', batch.id,
          r.__answer_data ? JSON.stringify(r.__answer_data) : null, subtopicId]);
        if (classified.length) await persistCandidates(q.id, classified, txn);
        let canonicalId = null;
        if (!isDraft) {
          canonicalId = await createCanonicalQuestion(q, txn);
          await setCourseOutcomes(canonicalId, cos, 'bulk', req.user.id, false, txn);
        }
        created.push({ id: q.id, row: r.__row, type: r.__type, question_status: isDraft ? 'DRAFT' : 'SUBMITTED', canonical_question_id: canonicalId, reasons, cos: r.__cos });
      }
    });
  } catch (err) {
    if (err.conflict) return refuse(409, err.message);
    throw err;
  }

  for (const c of created) {
    await logAudit({ userId: req.user.id, action: 'question_bulk_imported', entityId: c.id, ip: req.ip,
      details: { batch_id: batch.id, row: c.row, question_type: c.type, question_status: c.question_status,
        canonical_question_id: c.canonical_question_id, course_outcomes: c.cos, draft_reasons: c.reasons } });
    if (c.question_status === 'SUBMITTED') {
      await logAudit({ userId: req.user.id, action: 'question_final_submit', entityId: c.id, ip: req.ip,
        details: { from: null, to: 'SUBMITTED', canonical_question_id: c.canonical_question_id, via: 'bulk_upload', batch_id: batch.id } });
    }
  }
  const drafts = created.filter((c) => c.question_status === 'DRAFT');
  await logAudit({ userId: req.user.id, action: 'bulk_upload_confirmed', entityId: batch.id,
    details: { submitted: created.length - drafts.length, drafted: drafts.length }, ip: req.ip });
  res.json({ batchId: batch.id, submitted: created.length - drafts.length, drafted: drafts.length,
    created_question_ids: created.map((c) => c.id), drafts: drafts.map((c) => ({ row: c.row, question_id: c.id, reasons: c.reasons })) });
});

router.get('/template', requireAuth, requireRole('teacher'), (req, res) => {
  const wb = XLSX.utils.book_new();
  // One example row per question type, in the column layout the question-bank export uses (question-export.js).
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(TEMPLATE_EXAMPLES, { header: SHEET_COLUMNS }), 'Questions');
  // Reference sheet: every accepted type and the columns it needs (spec §8, §10).
  const needs = {
    mcq: 'option_a..option_d, correct_answer (option text or letter)', true_false: 'correct_answer = TRUE or FALSE',
    assertion_reason: 'assertion, reason, correct_answer = A/B/C/D', numerical: 'expected_value (number), optional tolerance, unit',
    fill_blank: 'answers (one per ___ blank, separated by |)', programming: 'language, optional constraints, model_answer',
    case_study: 'case_text, model_answer', diagram: 'model_answer; imported as a DRAFT - attach the diagram (PNG or JPEG), then submit it from My questions',
  };
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(QUESTION_TYPES.map((t) => ({
    question_type: t.code, name: t.label, required_columns: needs[t.code] || 'model_answer',
  }))), 'Question types');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=question_template.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

export default router;
