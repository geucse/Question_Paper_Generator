// Examination domain (PIVOT_SPEC_V2 sections 19-30): COE -> generate -> 4 validators.
// Reads the question bank, never writes to it.
import express from 'express';
import { authorize, getUserCampusIds } from '../authorization.js';
import { get, all, run, withTransaction } from '../db.js';
import { logAudit } from '../audit.js';
import { requireAuth, requireRole } from '../middleware.js';
import {
  generatePaper, GenerationError, GenerationConflict, blueprintConfigErrors, blueprintContextErrors, blueprintTargetNotes,
  normalizeCoDistribution, normalizeOverride, legacyTargetError, explainFeasibility, resolvedTargets, normalizeSections,
  sanitizeSections, loadEligiblePool, loadRecentlyUsed,
} from '../exam-generator.js';
import { loadPaper, canSeePaper, paperAccess, paperScope, examScope, coeCovers, paperContext } from '../paper-access.js';
import {
  normalizeRequiredApprovals, validationOutcome, VALIDATOR_COUNT, REPLACEABLE_IN,
  ISSUE_TYPES, MANUAL_ISSUE_CLOSE, VALIDATOR_ACCESS_STATUSES, canReportIssue, canCloseIssue,
  LIVE_PAPER_STATUSES, REGENERATABLE_STATUSES, REVISABLE_STATUSES,
} from '../paper-policy.js';
import { streamPaperPdf, snapshotQuestion, printLabels } from '../paper-pdf.js';
import { notify, notifyMany } from '../notifications.js';
import { validatorProblems, candidateValidators } from '../validator-eligibility.js';
import { notifyPaperCoes, notifyValidators, notifyEndedAssignments } from '../paper-notifications.js';
import { carryIssuesToRevision, referralRecipients, IssueConflict } from '../paper-issues.js';
import { paperValidationView, snapshotForCheck } from '../paper-validation-view.js';
import { paperSectionsView } from '../paper-sections.js';
import { paperQuestionAttachments, publicAttachment, withImageData } from '../paper-attachments.js';
import { resolveStored } from '../attachment-scan.js';
import crypto from 'crypto';

const router = express.Router();
router.use(requireAuth);

const CHECKLIST = ['question_correctness', 'syllabus_relevance', 'co_mapping_correct', 'bloom_levels_correct',
  'difficulty_appropriate', 'marks_distribution_ok', 'formatting_ok', 'numbering_correct',
  'spelling_grammar_ok', 'instructions_clear', 'layout_acceptable'];
export const EXAM_TYPES = ['mid_term', 'end_term', 'quiz', 'supplementary', 'makeup'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A refusal decided inside a transaction: rolls the transaction back and becomes the HTTP response.
class Refusal extends Error {
  constructor(status, error, extra = {}) { super(error); this.status = status; this.body = { error, ...extra }; }
}

const EXAM_SQL = `SELECT e.*, p.campus_id AS prog_campus, p.department_id FROM examinations e JOIN programs p ON p.id = e.program_id`;

// Campus list of the COE: only for listing validator ACCOUNTS of those campuses (no examination data).
async function coeCampuses(user) { return getUserCampusIds(user.id, 'coe'); }
// Lists of examination data are filtered by the COE's full scope (campus, department, program, offering), the
// same rule as paper access (paper-access.js coeCovers): a program-limited COE never sees another program's rows.
// e = examinations, pr = programs; $1 = the COE's user id.
const COE_SCOPE_SQL = `user_has_scope($1, 'coe', e.campus_id, pr.department_id, e.program_id, e.course_offering_id)`;

// Institution-wide approval threshold (spec §27, default 4 of 4). Frozen onto the paper at assignment time.
export async function currentRequiredApprovals() {
  const row = await get("SELECT value FROM system_state WHERE key = 'required_validator_approvals'");
  return normalizeRequiredApprovals(row?.value);
}

// ---------- Examinations ----------
router.post(['/', '/examinations'], requireRole('coe'), async (req, res) => {
  const { course_offering_id, syllabus_version_id, exam_type, maximum_marks, duration_minutes, exam_date } = req.body || {};
  if (!course_offering_id || !exam_type || !(Number(maximum_marks) > 0) || !(Number(duration_minutes) > 0)) {
    return res.status(400).json({ error: 'course_offering_id, exam_type, maximum_marks and duration_minutes are required' });
  }
  if (!EXAM_TYPES.includes(exam_type)) return res.status(400).json({ error: `exam_type must be one of: ${EXAM_TYPES.join(', ')}` });
  if (!UUID_RE.test(String(course_offering_id))) return res.status(404).json({ error: 'Course offering not found' });
  // Academic context is DERIVED from the offering; client-supplied campus/program/subject ids are ignored.
  const off = await get(`
    SELECT co.id, co.subject_id, co.program_id, co.academic_session_id, co.semester, co.syllabus_version_id,
           p.campus_id, p.college_id, p.department_id
    FROM course_offerings co JOIN programs p ON p.id = co.program_id WHERE co.id = $1`, [course_offering_id]);
  if (!off) return res.status(404).json({ error: 'Course offering not found' });

  const authz = await authorize(req.user, 'create_examination', { campus_id: off.campus_id, department_id: off.department_id, program_id: off.program_id,
    course_offering_id: off.id, type: 'examination' });
  if (!authz.allowed) return res.status(403).json({ error: authz.reason });

  const svId = syllabus_version_id || off.syllabus_version_id;
  if (!svId) return res.status(400).json({ error: 'This course offering has no HOD-approved syllabus version yet' });
  if (!UUID_RE.test(String(svId))) return res.status(400).json({ error: 'syllabus_version_id is malformed' });
  const sv = await get('SELECT id, approval_status, status, effective_to FROM syllabus_versions WHERE id = $1 AND course_offering_id = $2', [svId, off.id]);
  if (!sv) return res.status(400).json({ error: 'Syllabus version does not belong to this course offering' });
  if (sv.approval_status !== 'hod_approved') return res.status(400).json({ error: 'Syllabus version must be HOD-approved before an examination can use it' });
  // Spec §14, §39.5: a new examination uses the offering's CURRENT (ACTIVE, migration 042) syllabus version. A
  // superseded version stays valid only for examinations already on it.
  if (sv.id !== off.syllabus_version_id || sv.status !== 'ACTIVE' || sv.effective_to) {
    return res.status(400).json({ error: "That syllabus version is not the offering's current one (superseded, or not in effect): examinations use the offering's current syllabus version",
      current_syllabus_version_id: off.syllabus_version_id || null });
  }

  try {
    const { rows } = await run(`
      INSERT INTO examinations (campus_id, college_id, program_id, academic_session_id, semester, course_offering_id,
        subject_id, syllabus_version_id, exam_type, maximum_marks, duration_minutes, exam_date, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [off.campus_id, off.college_id, off.program_id, off.academic_session_id, off.semester, off.id,
       off.subject_id, svId, exam_type, maximum_marks, duration_minutes, exam_date || null, req.user.id]);
    await logAudit({ userId: req.user.id, action: 'examination_created', entityId: rows[0].id, details: { exam_type, course_offering_id }, ip: req.ip });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An examination of this type already exists for this offering, session and semester' });
    throw err;
  }
});

// live_paper_count: papers in progress (at most one); printed_paper_count: PRINT_READY papers (revise those).
router.get('/', requireRole('coe'), async (req, res) => {
  res.json(await all(`
    SELECT e.*, s.subject_code, s.course_title, co.offering_code,
           (SELECT COUNT(*)::int FROM exam_papers ep WHERE ep.examination_id = e.id) AS paper_count,
           (SELECT COUNT(*)::int FROM exam_papers ep WHERE ep.examination_id = e.id AND ep.paper_status = ANY($2::text[])) AS live_paper_count,
           (SELECT COUNT(*)::int FROM exam_papers ep WHERE ep.examination_id = e.id AND ep.paper_status = 'PRINT_READY') AS printed_paper_count
    FROM examinations e JOIN subjects s ON s.id = e.subject_id JOIN course_offerings co ON co.id = e.course_offering_id
    JOIN programs pr ON pr.id = e.program_id
    WHERE ${COE_SCOPE_SQL} ORDER BY e.created_at DESC LIMIT 200`, [req.user.id, LIVE_PAPER_STATUSES]));
});

// Offerings the COE may create examinations for (feeds the Create Examination form).
router.get('/offerings', requireRole('coe'), async (req, res) => {
  res.json(await all(`
    SELECT co.id, co.offering_code, co.semester, co.syllabus_version_id, s.subject_code, s.course_title, sv.approval_status
    FROM course_offerings co JOIN subjects s ON s.id = co.subject_id JOIN programs pr ON pr.id = co.program_id
    LEFT JOIN syllabus_versions sv ON sv.id = co.syllabus_version_id
    WHERE user_has_scope($1, 'coe', co.campus_id, pr.department_id, co.program_id, co.id) ORDER BY s.subject_code LIMIT 300`, [req.user.id]));
});

// ---------- Versioned blueprints (spec 21) ----------
// Active course outcome codes of the examination's frozen syllabus version (CO targets must name one).
async function activeCoCodes(exam, db = { all }) {
  return (await db.all('SELECT code FROM course_outcomes WHERE syllabus_version_id = $1 AND is_active ORDER BY sequence, code', [exam.syllabus_version_id])).map((r) => r.code);
}

// Validates and normalises a blueprint draft for this examination. Returns { errors, notes, row } where row holds
// the columns to store. Shared by the save route and the feasibility dry run, so both judge a draft the same way.
async function prepareBlueprint(exam, b) {
  const errors = [];
  const counts = ['easy_count', 'medium_count', 'hard_count'].map((k) => Number(b[k] || 0));
  if (counts.some((c) => !Number.isInteger(c) || c < 0) || counts.reduce((a, c) => a + c, 0) === 0) {
    return { errors: ['easy/medium/hard counts must be non-negative integers and not all zero'], notes: [], row: null, input: true };
  }
  if (b.sections != null && !Array.isArray(b.sections)) return { errors: ['sections must be a list'], notes: [], row: null, input: true };
  if (Array.isArray(b.sections) && b.sections.some((x) => !x || typeof x !== 'object' || Array.isArray(x))) {
    return { errors: ['each section must be an object'], notes: [], row: null, input: true };
  }
  const total = b.total_marks == null || b.total_marks === '' ? Number(exam.maximum_marks) : Number(b.total_marks);
  // validateSelection prefers the blueprint total, so a mismatch would silently produce a paper that disagrees with the exam.
  if (total !== Number(exam.maximum_marks)) errors.push(`total_marks (${total}) must equal the examination's maximum marks (${exam.maximum_marks})`);
  const co = normalizeCoDistribution(b.co_distribution, await activeCoCodes(exam));
  const bloom = b.bloom_distribution && typeof b.bloom_distribution === 'object' && Object.keys(b.bloom_distribution).length
    ? Object.fromEntries(Object.entries(b.bloom_distribution).map(([k, v]) => [String(k).trim().toLowerCase(), v])) : null;
  // Duplicate Bloom keys after lowercasing would collapse silently in the object above; report them instead.
  const bloomKeys = Object.keys(b.bloom_distribution || {}).map((k) => String(k).trim().toLowerCase());
  if (new Set(bloomKeys).size !== bloomKeys.length) errors.push('Each Bloom level may be listed only once');
  const row = {
    easy_count: counts[0], medium_count: counts[1], hard_count: counts[2], total_marks: total, sections: sanitizeSections(b.sections),
    co_distribution: co.value && Object.keys(co.value).length ? co.value : null, bloom_distribution: bloom,
    reuse_lookback_exams: Number(b.reuse_lookback_exams ?? 2),
  };
  if (!Number.isInteger(row.reuse_lookback_exams) || row.reuse_lookback_exams < 0) errors.push('reuse_lookback_exams must be a non-negative whole number');
  errors.push(...co.errors, ...blueprintConfigErrors(row));
  return { errors, notes: blueprintTargetNotes(row), row };
}

// Why a stored blueprint version can't generate for this examination now (legacy soft targets, CO deactivated).
async function contextErrors(exam, bp) {
  return [legacyTargetError(bp), ...blueprintContextErrors(bp, await activeCoCodes(exam))].filter(Boolean);
}

router.post('/blueprints', requireRole('coe'), async (req, res) => {
  const b = req.body || {};
  const exam = await get(EXAM_SQL + ' WHERE e.id = $1', [b.examination_id]);
  if (!exam) return res.status(404).json({ error: 'Examination not found' });
  if (!(await coeCovers(req.user, examScope(exam)))) return res.status(403).json({ error: 'No COE scope for this examination' });

  // Sections, CO and Bloom targets (hard for every blueprint created from now on). Checked here so an
  // impossible blueprint is refused when it is written, not discovered at generation.
  const p = await prepareBlueprint(exam, b);
  if (p.input) return res.status(400).json({ error: p.errors[0] });
  if (p.errors.length) return res.status(400).json({ error: 'Blueprint is not consistent', reasons: p.errors });
  const bp = p.row;

  let out;
  try {
    out = await withTransaction(async (txn) => {
      // Serialises concurrent saves for this examination (version numbers, the single active version); the 039
      // unique indexes are the backstop. NO KEY UPDATE does not block the FK checks of a running generation.
      await txn.get('SELECT id FROM examinations WHERE id = $1 FOR NO KEY UPDATE', [exam.id]);
      const prev = await txn.get('SELECT id, version_number FROM paper_blueprints WHERE examination_id = $1 ORDER BY version_number DESC LIMIT 1', [exam.id]);
      if (prev) await txn.run('UPDATE paper_blueprints SET is_active = FALSE WHERE examination_id = $1 AND is_active', [exam.id]);
      const dept = await txn.get('SELECT department_id FROM programs WHERE id = $1', [exam.program_id]);
      const row = await txn.get(`
        INSERT INTO paper_blueprints (name, description, department_id, easy_count, medium_count, hard_count, created_by, is_active,
          bloom_distribution, overall_difficulty_target, examination_id, course_offering_id, version_number, supersedes_id,
          total_marks, co_distribution, reuse_lookback_exams, sections, hard_targets)
        VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,TRUE) RETURNING *`,
        [String(b.name || `${exam.exam_type} blueprint`).slice(0, 200), b.description || null, dept.department_id, bp.easy_count, bp.medium_count, bp.hard_count, req.user.id,
         bp.bloom_distribution ? JSON.stringify(bp.bloom_distribution) : null, b.overall_difficulty_target || null,
         exam.id, exam.course_offering_id, prev ? prev.version_number + 1 : 1, prev ? prev.id : null,
         bp.total_marks, bp.co_distribution ? JSON.stringify(bp.co_distribution) : null, bp.reuse_lookback_exams,
         bp.sections ? JSON.stringify(bp.sections) : null]);
      // Audit last: logAudit holds the chain lock until COMMIT.
      await logAudit({ userId: req.user.id, action: 'blueprint_version_created', entityId: row.id, details: {
        examination_id: exam.id, version: row.version_number, supersedes_id: prev?.id || null, hard_targets: true,
        co_distribution: bp.co_distribution, bloom_distribution: bp.bloom_distribution, total_marks: bp.total_marks,
        sections: bp.sections?.length || 0,
        internal_choices: (bp.sections || []).filter((x) => x.attempt_count != null).map((x) => `${x.name}: ${x.attempt_count}/${x.question_count}`),
      }, ip: req.ip }, txn);
      return row;
    });
  } catch (err) {
    if (err.code === '23505' && /uq_paper_blueprints_/.test(err.constraint || err.message || '')) {
      return res.status(409).json({ error: 'Another blueprint version was saved at the same moment; reload and try again' });
    }
    throw err;
  }
  res.status(201).json({ ...out, target_notes: p.notes });
});

const withTargetMode = (b) => ({ ...b, target_mode: b.hard_targets ? 'hard' : 'legacy_soft', generation_blocked_reason: legacyTargetError(b) });

router.get('/blueprints', requireRole('coe'), async (req, res) => {
  const { examination_id } = req.query;
  if (examination_id && !UUID_RE.test(String(examination_id))) return res.json([]);
  const rows = await all(`
    SELECT b.*, (SELECT COUNT(*)::int FROM exam_papers ep WHERE ep.blueprint_version_id = b.id) AS paper_count
    FROM paper_blueprints b JOIN examinations e ON e.id = b.examination_id JOIN programs pr ON pr.id = e.program_id
    WHERE ${COE_SCOPE_SQL} AND ($2::uuid IS NULL OR b.examination_id = $2::uuid)
    ORDER BY b.examination_id, b.version_number DESC LIMIT 100`, [req.user.id, examination_id || null]);
  res.json(rows.map(withTargetMode));
});

// One blueprint version in full: sections as normalised for generation, resolved targets and the papers using it.
router.get('/blueprints/:blueprintId', requireRole('coe'), async (req, res) => {
  if (!UUID_RE.test(req.params.blueprintId)) return res.status(404).json({ error: 'Blueprint not found' });
  const row = await get(`SELECT b.*, e.campus_id AS exam_campus_id, pr.department_id AS exam_department_id, e.program_id AS exam_program_id,
                                e.course_offering_id AS exam_offering_id
                         FROM paper_blueprints b JOIN examinations e ON e.id = b.examination_id JOIN programs pr ON pr.id = e.program_id WHERE b.id = $1`, [req.params.blueprintId]);
  if (!row) return res.status(404).json({ error: 'Blueprint not found' });
  const { exam_campus_id: campusId, exam_department_id: departmentId, exam_program_id: programId, exam_offering_id: offeringId, ...bp } = row;
  if (!(await coeCovers(req.user, { campus_id: campusId, department_id: departmentId, program_id: programId, course_offering_id: offeringId }))) {
    return res.status(403).json({ error: 'No COE scope for this examination' });
  }
  const papers = await all('SELECT id, paper_version, paper_status, generated_at FROM exam_papers WHERE blueprint_version_id = $1 ORDER BY paper_version', [bp.id]);
  const prev = bp.supersedes_id ? await get('SELECT version_number FROM paper_blueprints WHERE id = $1', [bp.supersedes_id]) : null;
  res.json({ ...withTargetMode(bp), sections_normalized: normalizeSections(bp).filter((x) => x.name), targets: resolvedTargets(bp),
    target_notes: blueprintTargetNotes(bp), supersedes_version: prev?.version_number ?? null, papers });
});


// ---------- Generate (spec 22-25) ----------
// hooks: { excludeQuestionIds, prepare, finalize } run inside the generation transaction (exam-generator.js);
// finalize may return details for the paper_generated audit row; after(out) runs once it has committed.
// The audit rows are written by the wrapper below as the LAST statements of the generation transaction.
async function runGeneration(req, res, { exam, blueprint, parentPaperId = null, excludeQuestionIds, prepare, finalize, after }) {
  const authz = await authorize(req.user, 'generate_paper', { ...examScope(exam), type: 'paper' });
  if (!authz.allowed) return res.status(403).json({ error: authz.reason });
  let ov;
  try { ov = normalizeOverride(req.body?.override); } catch (e) {
    if (e instanceof GenerationError) return res.status(422).json({ error: 'Paper cannot be generated', code: e.code, reasons: e.reasons });
    throw e;
  }
  if (ov) {
    // The generating COE approves the override (spec §29); recorded as its own authorization decision.
    const oz = await authorize(req.user, 'override_generation_targets', { ...examScope(exam), type: 'paper' });
    if (!oz.allowed) return res.status(403).json({ error: oz.reason });
  }
  const ctx = await contextErrors(exam, blueprint);
  if (ctx.length) {
    return res.status(422).json({ error: 'Paper cannot be generated', code: legacyTargetError(blueprint) ? 'LEGACY_BLUEPRINT' : 'CONFIG', reasons: ctx });
  }
  try {
    const out = await generatePaper({ exam, blueprint, userId: req.user.id, seed: req.body?.seed, parentPaperId, override: ov,
      excludeQuestionIds, prepare,
      finalize: async (txn, gen) => {
        const extra = finalize ? await finalize(txn, gen) : null;
        // Audit last: logAudit holds the chain lock until COMMIT.
        await logAudit({ userId: req.user.id, action: 'paper_generated', entityId: gen.paperId, details: {
          examination_id: exam.id, blueprint_id: blueprint.id, blueprint_version: blueprint.version_number, paper_version: gen.paperVersion,
          seed: gen.seed, parent: parentPaperId, attempt: gen.attempt, target_mode: gen.targets.mode,
          constraint_overrides: gen.overrides ? { relax: gen.overrides.relax, reason: gen.overrides.reason } : null,
          excluded_question_ids: gen.excluded_question_ids || [] }, ip: req.ip }, txn);
        if (gen.overrides) {
          // Spec: constraint overrides are recorded — on the paper, in paper_constraint_overrides and in the audit log.
          await logAudit({ userId: req.user.id, action: 'generation_constraint_override', entityId: gen.paperId, details: {
            relaxed: gen.overrides.relax, reason: gen.overrides.reason, original_targets: gen.overrides.original_targets, achieved: gen.overrides.achieved,
            strict_failure: gen.overrides.strict_failure, approved_by: req.user.id, approval_basis: 'generating_coe', blueprint_id: blueprint.id }, ip: req.ip }, txn);
        }
        return extra;
      } });
    if (after) await after(out);
    return res.status(201).json(out);
  } catch (err) {
    if (err instanceof GenerationError) return res.status(422).json({ error: 'Paper cannot be generated', code: err.code, reasons: err.reasons });
    if (err instanceof GenerationConflict) return res.status(409).json({ error: err.message, reasons: err.reasons, ...err.details });
    if (err instanceof Refusal) return res.status(err.status).json(err.body);
    if (err instanceof IssueConflict) return res.status(409).json({ error: err.message });
    throw err;
  }
}

// One live paper per examination (migration 039): a second candidate is a regeneration of the live one.
router.post('/:examId/generate', requireRole('coe'), async (req, res) => {
  const exam = await get(EXAM_SQL + ' WHERE e.id = $1', [req.params.examId]);
  if (!exam) return res.status(404).json({ error: 'Examination not found' });
  const blueprint = await get('SELECT * FROM paper_blueprints WHERE id = $1 AND examination_id = $2', [req.body?.blueprint_id, exam.id]);
  if (!blueprint) return res.status(400).json({ error: 'blueprint_id is required and must belong to this examination' });
  return runGeneration(req, res, { exam, blueprint });
});

// Feasibility dry run (spec §23): would this blueprint version (or an unsaved draft) generate now, and if not,
// why and which override would make it possible. This route NEVER writes: no transaction, no advisory lock,
// no reservation, no audit row (authorize() still logs the access decision). It always answers 200 with the
// verdict; only malformed input is a 400/404 and scope a 403.
router.post('/:examId/feasibility', requireRole('coe'), async (req, res) => {
  const body = req.body || {};
  const exam = await get(EXAM_SQL + ' WHERE e.id = $1', [req.params.examId]);
  if (!exam) return res.status(404).json({ error: 'Examination not found' });
  const authz = await authorize(req.user, 'generate_paper', { ...examScope(exam), type: 'paper' });
  if (!authz.allowed) return res.status(403).json({ error: authz.reason });
  let bp; let notes = [];
  if (body.blueprint_id) {
    bp = UUID_RE.test(String(body.blueprint_id)) ? await get('SELECT * FROM paper_blueprints WHERE id = $1 AND examination_id = $2', [body.blueprint_id, exam.id]) : null;
    if (!bp) return res.status(400).json({ error: 'blueprint_id must be a blueprint version of this examination' });
    notes = blueprintTargetNotes(bp);
  } else if (body.blueprint && typeof body.blueprint === 'object' && !Array.isArray(body.blueprint)) {
    const p = await prepareBlueprint(exam, body.blueprint);
    if (p.errors.length) return res.json({ feasible: false, code: 'CONFIG', reasons: p.errors, target_notes: p.notes });
    bp = { ...p.row, id: null, hard_targets: true, version_number: 'draft' };
    notes = p.notes;
  } else {
    return res.status(400).json({ error: 'Send blueprint_id (a saved version) or blueprint (a draft)' });
  }
  const ctx = await contextErrors(exam, bp);
  if (ctx.length) return res.json({ feasible: false, code: legacyTargetError(bp) ? 'LEGACY_BLUEPRINT' : 'CONFIG', reasons: ctx, target_notes: notes });
  let ov;
  try { ov = normalizeOverride(body.override); } catch (e) {
    if (e instanceof GenerationError) return res.status(422).json({ error: 'Invalid override', code: e.code, reasons: e.reasons });
    throw e;
  }
  const pool = await loadEligiblePool(exam);
  const recent = await loadRecentlyUsed(exam, bp.reuse_lookback_exams);
  const seed = body.seed ? String(body.seed) : crypto.randomBytes(8).toString('hex');
  res.json({ ...explainFeasibility(pool, bp, seed, recent, exam, ov), eligible_count: pool.length, seed, target_notes: notes,
    note: 'Read-only check: nothing was saved or reserved. The question bank and other papers\' reservations can change before you generate.' });
});

// Regenerate = a NEW paper revision; the old one is kept as REGENERATED (history is never edited).
// In the generation transaction: lock and re-check the parent, then (once the new revision is built) resolve
// the parent's open issues on replaced questions and carry the rest, supersede the parent, write the revision
// rows and the audit rows. The parent's validator assignments are ended by the database (migration 039), never here.
router.post('/papers/:paperId/regenerate', requireRole('coe'), async (req, res) => {
  const paper = await loadPaper(req.params.paperId);
  if (!paper) return res.status(404).json({ error: 'Paper not found' });
  if (!(await canSeePaper(req.user, paper))) return res.status(403).json({ error: 'Not allowed' });
  if (!REGENERATABLE_STATUSES.includes(paper.paper_status)) {
    return res.status(409).json({ error: `Cannot regenerate a paper in status ${paper.paper_status}` });
  }
  const exam = await get(EXAM_SQL + ' WHERE e.id = $1', [paper.examination_id]);
  // Any version of THIS examination's blueprint (default: the one the paper was generated from), never another's.
  const bpId = req.body?.blueprint_id || paper.blueprint_version_id;
  const blueprint = bpId && (!req.body?.blueprint_id || UUID_RE.test(String(req.body.blueprint_id)))
    ? await get('SELECT * FROM paper_blueprints WHERE id = $1 AND examination_id = $2', [bpId, paper.examination_id]) : null;
  if (!blueprint) return res.status(400).json({ error: 'blueprint_id must be a blueprint version of this paper\'s examination' });
  const reason = (req.body?.reason || '').trim();
  if (reason.length < 3) return res.status(400).json({ error: 'A reason is required' });
  // Regeneration should actually fix flagged questions (default): questions with open issues are left out.
  // Read in the generation transaction AFTER the parent row lock (issues are closed under the same lock), so the
  // exclusion, the revision row and the audit row all match the parent's open issues at commit.
  const excludeFlagged = req.body?.exclude_flagged_questions !== false;

  const lockParent = async (txn) => {
    const parent = await txn.get('SELECT id, paper_status FROM exam_papers WHERE id = $1 FOR UPDATE', [paper.id]);
    if (!REGENERATABLE_STATUSES.includes(parent?.paper_status)) throw new Refusal(409, `The paper changed meanwhile (now ${parent?.paper_status}); reload`);
    return parent;
  };
  return runGeneration(req, res, {
    exam, blueprint, parentPaperId: paper.id,
    prepare: async (txn) => {
      await lockParent(txn);
      const flagged = excludeFlagged
        ? (await txn.all(`SELECT DISTINCT question_id FROM paper_issues WHERE paper_id = $1 AND status = 'open' AND question_id IS NOT NULL`, [paper.id])).map((r) => r.question_id)
        : [];
      return { excludeQuestionIds: flagged };
    },
    finalize: async (txn, out) => {
      const parent = await lockParent(txn);
      const flagged = out.excluded_question_ids;
      const version = out.paperVersion;  // computed under the generation lock
      // Issues first, while the parent is still closable (migration 039 refuses closing on REGENERATED).
      const carry = await carryIssuesToRevision(txn, { parentPaperId: paper.id, newPaperId: out.paperId, newVersion: version, questionIds: out.questionIds, userId: req.user.id });
      const sup = await txn.run(`UPDATE exam_papers SET paper_status = 'REGENERATED' WHERE id = $1 AND paper_status = $2 RETURNING id`, [paper.id, parent.paper_status]);
      if (sup.rowCount !== 1) throw new Refusal(409, 'The paper changed meanwhile; reload');
      await txn.run(`INSERT INTO paper_revisions (paper_id, revision_number, change_type, change_description, changed_by, previous_snapshot, new_snapshot)
                     VALUES ($1,$2,'question_regenerated',$3,$4,$5,$6)`,
        [out.paperId, version, reason, req.user.id,
         JSON.stringify({ paper_id: paper.id, status: parent.paper_status, paper_version: paper.paper_version, blueprint_version_id: paper.blueprint_version_id, open_issue_ids: carry.open_issue_ids }),
         JSON.stringify({ paper_id: out.paperId, paper_version: version, seed: out.seed, blueprint_id: blueprint.id, blueprint_version: blueprint.version_number, excluded_question_ids: flagged })]);
      if (carry.resolved.length || carry.carried.length) {
        await txn.run(`INSERT INTO paper_revisions (paper_id, revision_number, change_type, change_description, changed_by, previous_snapshot, new_snapshot)
                       VALUES ($1,$2,'issue_resolution',$3,$4,$5,$6)`,
          [out.paperId, version, `${carry.resolved.length} issue(s) resolved by replacement, ${carry.carried.length} carried to this revision`, req.user.id,
           JSON.stringify({ paper_id: paper.id, open_issue_ids: carry.open_issue_ids }), JSON.stringify({ resolved: carry.resolved, carried: carry.carried })]);
      }
      // Audit rows last (the generation's own rows follow in runGeneration).
      await logAudit({ userId: req.user.id, action: 'paper_superseded', entityId: paper.id, details: {
        from: parent.paper_status, to: 'REGENERATED', superseded_by: out.paperId, paper_version: version, reason }, ip: req.ip }, txn);
      if (carry.resolved.length || carry.carried.length || flagged.length) {
        await logAudit({ userId: req.user.id, action: 'paper_issues_carried', entityId: out.paperId,
          details: { parent: paper.id, new_paper: out.paperId, resolved: carry.resolved, carried: carry.carried, excluded_question_ids: flagged }, ip: req.ip }, txn);
      }
      return carry;
    },
    after: async () => {
      await notifyEndedAssignments(paper.id, 'paper_regenerated', 'this revision was superseded by a new one; your validation assignment has ended.');
    },
  });
});

// Revise a printed paper (spec §28: once PRINT_READY the paper is locked; "any later change creates a new paper
// revision"). Generates the next version with the printed paper as its parent and a revision row; the printed
// paper itself is not touched: it stays PRINT_READY (it is what was printed, keeps its validators and approval)
// until the revision is marked PRINT_READY, when the same transaction archives it (routes/coe-approval.js).
// The revision then runs the normal workflow (4 validators, COE approval with TOTP). Only one paper may be in
// progress per examination (migration 039), so a second revision while one is in progress is refused.
router.post('/papers/:paperId/revise', requireRole('coe'), async (req, res) => {
  const paper = await loadPaper(req.params.paperId);
  if (!paper) return res.status(404).json({ error: 'Paper not found' });
  if (!(await canSeePaper(req.user, paper))) return res.status(403).json({ error: 'Not allowed' });
  if (!REVISABLE_STATUSES.includes(paper.paper_status)) {
    return res.status(409).json({ error: `Only a PRINT_READY paper is revised; this one is ${paper.paper_status} (regenerate a paper that is still in progress)` });
  }
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 10 || reason.length > 1000) return res.status(400).json({ error: 'A reason of at least 10 characters is required to revise a printed paper' });
  const exam = await get(EXAM_SQL + ' WHERE e.id = $1', [paper.examination_id]);
  const bpId = req.body?.blueprint_id || paper.blueprint_version_id;
  const blueprint = bpId && (!req.body?.blueprint_id || UUID_RE.test(String(req.body.blueprint_id)))
    ? await get('SELECT * FROM paper_blueprints WHERE id = $1 AND examination_id = $2', [bpId, paper.examination_id]) : null;
  if (!blueprint) return res.status(400).json({ error: 'blueprint_id must be a blueprint version of this paper\'s examination' });

  // Held FOR UPDATE until COMMIT: a concurrent archive of the printed paper waits, then sees the revision.
  const lockPrinted = async (txn) => {
    const parent = await txn.get('SELECT id, paper_status FROM exam_papers WHERE id = $1 FOR UPDATE', [paper.id]);
    if (!REVISABLE_STATUSES.includes(parent?.paper_status)) throw new Refusal(409, `The paper changed meanwhile (now ${parent?.paper_status}); reload`);
    return parent;
  };
  return runGeneration(req, res, {
    exam, blueprint, parentPaperId: paper.id,
    prepare: async (txn) => { await lockPrinted(txn); return null; },
    finalize: async (txn, out) => {
      await txn.run(`INSERT INTO paper_revisions (paper_id, revision_number, change_type, change_description, changed_by, previous_snapshot, new_snapshot)
                     VALUES ($1,$2,'question_regenerated',$3,$4,$5,$6)`,
        [out.paperId, out.paperVersion, reason, req.user.id,
         JSON.stringify({ paper_id: paper.id, status: 'PRINT_READY', paper_version: paper.paper_version, blueprint_version_id: paper.blueprint_version_id, revision_of_printed: true }),
         JSON.stringify({ paper_id: out.paperId, paper_version: out.paperVersion, seed: out.seed, blueprint_id: blueprint.id, blueprint_version: blueprint.version_number })]);
      // Audit rows last (the generation's own rows follow in runGeneration).
      await logAudit({ userId: req.user.id, action: 'printed_paper_revision_started', entityId: paper.id, details: {
        printed_paper: paper.id, printed_version: paper.paper_version, revision: out.paperId, revision_version: out.paperVersion, reason }, ip: req.ip }, txn);
      return null;
    },
  });
});

// Per-question CO codes recorded at generation (exam-generator.js questionCos), {} for older papers.
function candidateCos(paper) {
  let cm = paper.candidate_metrics;
  if (typeof cm === 'string') { try { cm = JSON.parse(cm); } catch { cm = null; } }
  const qc = cm?.question_cos;
  return qc && typeof qc === 'object' && !Array.isArray(qc) ? qc : {};
}

// ---------- Papers ----------
router.get('/papers', requireRole('coe'), async (req, res) => {
  res.json(await all(`
    SELECT ep.id, ep.title, ep.paper_status, ep.paper_version, ep.generated_at, ep.generation_seed, ep.examination_id, ep.required_approvals,
           e.exam_type, s.subject_code,
           (SELECT COUNT(*)::int FROM paper_validator_assignments v WHERE v.paper_id = ep.id AND v.is_active) AS validators,
           (SELECT COUNT(*)::int FROM paper_validator_assignments v WHERE v.paper_id = ep.id AND v.is_active AND v.decision = 'APPROVE') AS approvals,
           (SELECT COUNT(*)::int FROM paper_issues i WHERE i.paper_id = ep.id AND i.status = 'open') AS open_issues
    FROM exam_papers ep JOIN examinations e ON e.id = ep.examination_id JOIN subjects s ON s.id = e.subject_id
    JOIN programs pr ON pr.id = e.program_id
    WHERE ${COE_SCOPE_SQL} ORDER BY ep.created_at DESC LIMIT 200`, [req.user.id]));
});

router.get('/papers/:paperId', async (req, res) => {
  const paper = await loadPaper(req.params.paperId);
  if (!paper) return res.status(404).json({ error: 'Paper not found' });
  const access = await paperAccess(req.user, paper);
  if (!access.view) return res.status(403).json({ error: access.reason || 'Not allowed' });
  const rows = await all(`
    SELECT pq.slot_number, pq.question_id, pq.question_text_snapshot AS text, pq.marks_snapshot AS marks,
           pq.metadata_snapshot AS meta, pq.selection_reason, pq.section_name, pq.section_index
    FROM paper_questions pq WHERE pq.paper_id = $1 ORDER BY pq.slot_number NULLS LAST`, [paper.id]);
  // The files each question's snapshot refers to (paper-attachments.js); opened through /papers/:id/attachments/:id.
  const files = await paperQuestionAttachments(paper, rows.map((q) => ({ question_id: q.question_id, metadata_snapshot: q.meta })));
  // cos: CO codes frozen on the paper at generation (none for papers generated before they were recorded);
  // print_label: how the printed paper numbers the question (Q3, or Q2(a) inside an "attempt any 1" choice).
  const frozenCos = candidateCos(paper);
  const questions = rows.map((q) => ({ ...q, cos: frozenCos[q.question_id] || [], attachments: (files.get(q.question_id) || []).map(publicAttachment) }));
  const bp = paper.blueprint_version_id
    ? await get('SELECT id, version_number, name, hard_targets, co_distribution, bloom_distribution FROM paper_blueprints WHERE id = $1', [paper.blueprint_version_id]) : null;
  const sendBacks = await all('SELECT from_status, reason, created_at FROM paper_send_backs WHERE paper_id = $1 ORDER BY created_at DESC', [paper.id]);
  const myAssignment = req.user.role === 'validator' ? await get(`
    SELECT id AS assignment_id, validator_number, validation_round, decision, comments, checklist_results, decided_at
    FROM paper_validator_assignments WHERE paper_id = $1 AND validator_id = $2 AND is_active`, [paper.id, req.user.id]) : null;
  const { candidate_metrics, ...rest } = paper;
  // Section headings, rules and per-section check from the paper's frozen format_config (never the live blueprint).
  const sectionView = paperSectionsView(paper.format_config, questions.map(snapshotForCheck));
  const labels = printLabels(questions, sectionView);
  res.json({
    ...rest, validation: candidate_metrics?.validation || null, questions: questions.map((q) => ({ ...q, print_label: labels.get(q.question_id) || null })),
    sections: sectionView,
    targets: candidate_metrics?.targets || null,
    blueprint: bp && { id: bp.id, version_number: bp.version_number, name: bp.name, hard_targets: bp.hard_targets, target_mode: bp.hard_targets ? 'hard' : 'legacy_soft' },
    validation_view: paperValidationView({ report: candidate_metrics?.validation, blueprint: bp, formatConfig: paper.format_config, questions, targets: candidate_metrics?.targets }),
    send_backs: sendBacks, access, ...(req.user.role === 'validator' ? { my_assignment: myAssignment } : {}),
  });
});

// Validator candidates. With ?paper_id= the list is for that paper: validators of its campus, each with the
// conflicts that would make the assignment fail (the same rules the assignment applies).
router.get('/validators', requireRole('coe'), async (req, res) => {
  if (req.query.paper_id) {
    const paper = UUID_RE.test(String(req.query.paper_id)) ? await loadPaper(req.query.paper_id) : null;
    if (!paper) return res.status(404).json({ error: 'Paper not found' });
    if (!(await canSeePaper(req.user, paper))) return res.status(403).json({ error: 'Not allowed' });
    return res.json(await candidateValidators({ get, all }, { paper, coeIds: [req.user.id, paper.generated_by].filter(Boolean) }));
  }
  const campuses = await coeCampuses(req.user);
  res.json(await all(`
    SELECT DISTINCT u.id, u.full_name, u.email FROM users u JOIN user_scopes s ON s.user_id = u.id AND s.role = 'validator' AND s.is_active
    WHERE u.role = 'validator' AND u.is_active AND s.campus_id = ANY($1::uuid[]) ORDER BY u.email`, [campuses]));
});

// ---------- Validators ----------
const dbConflict = (err) => err?.code === '23505' || /cannot be removed|recorded decision|not an active validator|can only be assigned/.test(err?.message || '');

// Full assignment of four (a new validation round). Race-safe: everything is re-checked under the paper row
// lock, and assignments of the previous round are ended ('reassigned'), never deleted.
router.post('/papers/:paperId/validators', requireRole('coe'), async (req, res) => {
  const { validator_ids } = req.body || {};
  if (!Array.isArray(validator_ids) || validator_ids.length !== VALIDATOR_COUNT) return res.status(400).json({ error: `Exactly ${VALIDATOR_COUNT} validators required` });
  if (new Set(validator_ids).size !== VALIDATOR_COUNT) return res.status(400).json({ error: `All ${VALIDATOR_COUNT} validators must be distinct` });
  if (!validator_ids.every((v) => UUID_RE.test(String(v)))) return res.status(400).json({ error: 'validator_ids must be user ids' });

  const paper = await loadPaper(req.params.paperId);
  if (!paper) return res.status(404).json({ error: 'Paper not found' });
  if (!(await canSeePaper(req.user, paper))) return res.status(403).json({ error: 'Cross-campus access denied' });
  // Early checks for readable errors; the authoritative ones run again inside the transaction.
  if (paper.paper_status !== 'GENERATED' && paper.paper_status !== 'VALIDATION_PENDING') {
    return res.status(409).json({ error: `Validators can only be assigned to a GENERATED paper (current: ${paper.paper_status})` });
  }
  if (paper.candidate_metrics?.validation && paper.candidate_metrics.validation.passed === false) {
    return res.status(409).json({ error: 'Automated validation failed; regenerate the paper first' });
  }
  const coeIds = [req.user.id, paper.generated_by].filter(Boolean);
  for (let i = 0; i < VALIDATOR_COUNT; i++) {
    const authz = await authorize(req.user, 'assign_validator', {
      validator_id: validator_ids[i], coe_ids: coeIds, paper_id: paper.id, ...paperScope(paper), type: 'validator_assignment',
    });
    if (!authz.allowed) return res.status(403).json({ error: `Validator ${i + 1}: ${authz.reason}`, validator_id: validator_ids[i], reasons: authz.reasons || [] });
  }

  let out;
  try {
    out = await withTransaction(async (txn) => {
      const p = await txn.get('SELECT id, paper_status, required_approvals, generated_by, candidate_metrics FROM exam_papers WHERE id = $1 FOR UPDATE', [paper.id]);
      if (!['GENERATED', 'VALIDATION_PENDING'].includes(p?.paper_status)) throw new Refusal(409, `Validators can only be assigned to a GENERATED paper (current: ${p?.paper_status})`);
      if (p.candidate_metrics?.validation?.passed === false) throw new Refusal(409, 'Automated validation failed; regenerate the paper first');
      const current = await txn.all('SELECT id, validator_id, decision FROM paper_validator_assignments WHERE paper_id = $1 AND is_active FOR UPDATE', [p.id]);
      if (current.some((a) => a.decision)) throw new Refusal(409, 'Validators have already started deciding; replace an undecided validator or regenerate');
      const problems = await validatorProblems(txn, { paper, validatorIds: validator_ids,
        coeIds: [req.user.id, p.generated_by].filter(Boolean), lock: true });
      const bad = validator_ids.findIndex((v) => problems.get(v).length);
      if (bad >= 0) throw new Refusal(403, `Validator ${bad + 1}: ${problems.get(validator_ids[bad]).join('; ')}`, { validator_id: validator_ids[bad], reasons: problems.get(validator_ids[bad]) });
      const ended = current.length ? await txn.all(`
        UPDATE paper_validator_assignments SET is_active = FALSE, deactivated_by = $2, deactivation_reason = 'reassigned'
        WHERE paper_id = $1 AND is_active RETURNING id, validator_id`, [p.id, req.user.id]) : [];
      const { round } = await txn.get('SELECT COALESCE(MAX(validation_round), 0)::int + 1 AS round FROM paper_validator_assignments WHERE paper_id = $1', [p.id]);
      for (let i = 0; i < VALIDATOR_COUNT; i++) {
        await txn.run('INSERT INTO paper_validator_assignments (paper_id, validator_id, validator_number, assigned_by, validation_round) VALUES ($1,$2,$3,$4,$5)',
          [p.id, validator_ids[i], i + 1, req.user.id, round]);
      }
      // The threshold is frozen on first assignment so a later policy change can't move the goalposts mid-review.
      const required = p.required_approvals || (await currentRequiredApprovals());
      await txn.run(`UPDATE exam_papers SET paper_status = 'VALIDATION_PENDING', required_approvals = COALESCE(required_approvals, $2) WHERE id = $1`,
        [p.id, required]);
      // Audit last: logAudit holds the chain lock until COMMIT.
      await logAudit({ userId: req.user.id, action: 'validators_assigned', entityId: paper.id,
        details: { validator_ids, required_approvals: required, round, ended_assignment_ids: ended.map((e) => e.id) }, ip: req.ip }, txn);
      return { required, round, ended };
    });
  } catch (err) {
    if (err instanceof Refusal) return res.status(err.status).json(err.body);
    if (dbConflict(err)) return res.status(409).json({ error: 'Validator assignment changed concurrently; reload' });
    throw err;
  }
  for (let i = 0; i < VALIDATOR_COUNT; i++) {
    await notifyValidators([validator_ids[i]], paper.id, 'validation_assigned', `you are validator ${i + 1} (round ${out.round}).`);
  }
  await notifyValidators(out.ended.map((e) => e.validator_id).filter((v) => !validator_ids.includes(v)), paper.id, 'validation_unassigned',
    'the COE assigned a new set of validators; your assignment has ended.');
  res.json({ message: '4 validators assigned', paper_status: 'VALIDATION_PENDING', required_approvals: out.required, round: out.round });
});

// Replace ONE undecided validator (spec §27: the COE keeps exactly four active validators). The other three
// assignments and their decisions are untouched; a recorded decision is never discarded here.
router.post('/papers/:paperId/validators/:validatorNumber/replace', requireRole('coe'), async (req, res) => {
  const n = Number(req.params.validatorNumber);
  const { validator_id } = req.body || {};
  const reason = String(req.body?.reason || '').trim();
  if (!Number.isInteger(n) || n < 1 || n > VALIDATOR_COUNT) return res.status(400).json({ error: `Validator number must be 1 to ${VALIDATOR_COUNT}` });
  if (typeof validator_id !== 'string' || !UUID_RE.test(validator_id)) return res.status(400).json({ error: 'validator_id is required' });
  if (reason.length < 10 || reason.length > 1000) return res.status(400).json({ error: 'A reason of at least 10 characters is required to replace a validator' });

  const paper = await loadPaper(req.params.paperId);
  if (!paper) return res.status(404).json({ error: 'Paper not found' });
  if (!(await canSeePaper(req.user, paper))) return res.status(403).json({ error: 'Cross-campus access denied' });
  const authz = await authorize(req.user, 'assign_validator', {
    validator_id, coe_ids: [req.user.id, paper.generated_by].filter(Boolean), paper_id: paper.id, ...paperScope(paper), type: 'validator_assignment',
  });
  if (!authz.allowed) return res.status(403).json({ error: `New validator: ${authz.reason}`, reasons: authz.reasons || [] });

  let out;
  try {
    out = await withTransaction(async (txn) => {
      const p = await txn.get('SELECT id, paper_status, generated_by FROM exam_papers WHERE id = $1 FOR UPDATE', [paper.id]);
      if (!REPLACEABLE_IN.includes(p?.paper_status)) throw new Refusal(409, `Validators can only be replaced while the paper awaits validation (current: ${p?.paper_status})`);
      const old = await txn.get('SELECT * FROM paper_validator_assignments WHERE paper_id = $1 AND validator_number = $2 AND is_active FOR UPDATE', [p.id, n]);
      if (!old) throw new Refusal(404, 'No active validator in that slot');
      if (old.decision) {
        throw new Refusal(409, `Validator ${n} already recorded a decision; recorded decisions are never replaced. Replace an undecided validator, or send the paper back and regenerate it.`);
      }
      if (old.validator_id === validator_id) throw new Refusal(400, 'The new validator must be a different person');
      if (await txn.get('SELECT 1 AS x FROM paper_validator_assignments WHERE paper_id = $1 AND validator_id = $2 AND is_active', [p.id, validator_id])) {
        throw new Refusal(409, 'That validator is already assigned to this paper');
      }
      const problems = (await validatorProblems(txn, { paper, validatorIds: [validator_id],
        coeIds: [req.user.id, p.generated_by].filter(Boolean), lock: true })).get(validator_id);
      if (problems.length) throw new Refusal(403, `New validator: ${problems.join('; ')}`, { reasons: problems });
      const ended = await txn.run(`
        UPDATE paper_validator_assignments SET is_active = FALSE, deactivated_by = $2, deactivation_reason = 'replaced', deactivation_note = $3
        WHERE id = $1 AND is_active RETURNING id`, [old.id, req.user.id, reason]);
      if (ended.rowCount !== 1) throw new Refusal(409, 'Validator assignment changed concurrently; reload');
      const row = await txn.get(`
        INSERT INTO paper_validator_assignments (paper_id, validator_id, validator_number, assigned_by, validation_round, replaces_assignment_id)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [p.id, validator_id, n, req.user.id, old.validation_round, old.id]);
      await logAudit({ userId: req.user.id, action: 'validator_replaced', entityId: paper.id, details: {
        validator_number: n, old_validator_id: old.validator_id, new_validator_id: validator_id,
        old_assignment_id: old.id, new_assignment_id: row.id, round: old.validation_round, reason }, ip: req.ip }, txn);
      return { old, newId: row.id };
    });
  } catch (err) {
    if (err instanceof Refusal) return res.status(err.status).json(err.body);
    if (dbConflict(err)) return res.status(409).json({ error: 'Validator assignment changed concurrently; reload' });
    throw err;
  }
  await notifyValidators([validator_id], paper.id, 'validation_assigned', `you are validator ${n} (replacing a previous validator).`);
  await notifyValidators([out.old.validator_id], paper.id, 'validation_unassigned', `the COE replaced you as validator ${n}: ${reason}`);
  res.json({ message: `Validator ${n} replaced`, assignment_id: out.newId });
});

// COE view of the assignments. Undecided active rows carry `problems` (computed on every read, so it never
// goes stale): reasons the validator can no longer decide, meaning the COE should replace them.
// ?history=1 adds the ended rows of every round. On a superseded paper (REGENERATED, ARCHIVED before printing)
// the ended rows of the last round are returned too, so the comments that caused it stay visible.
router.get('/papers/:paperId/validators', async (req, res) => {
  const paper = await loadPaper(req.params.paperId);
  if (!paper) return res.status(404).json({ error: 'Paper not found' });
  if (req.user.role !== 'coe' || !(await canSeePaper(req.user, paper))) return res.status(403).json({ error: 'Not allowed' });
  const history = req.query.history === '1' || req.query.history === 'true';
  const superseded = ['REGENERATED', 'ARCHIVED'].includes(paper.paper_status);
  const rows = await all(`
    SELECT pva.id AS assignment_id, pva.validator_number, pva.validator_id, pva.validation_round, pva.assigned_at, pva.replaces_assignment_id,
           pva.decision, pva.comments, pva.decided_at, pva.is_active, pva.deactivated_at, pva.deactivation_reason, pva.deactivation_note,
           u.email, u.full_name, db.email AS deactivated_by_email
    FROM paper_validator_assignments pva JOIN users u ON u.id = pva.validator_id LEFT JOIN users db ON db.id = pva.deactivated_by
    WHERE pva.paper_id = $1 AND (pva.is_active OR $2::boolean
          OR ($3::boolean AND pva.deactivation_reason IN ('paper_regenerated', 'paper_archived')))
    ORDER BY pva.validation_round, pva.validator_number, pva.assigned_at`, [paper.id, history, superseded]);
  const pending = rows.filter((r) => r.is_active && !r.decision);
  let problems = new Map();
  if (pending.length && ['GENERATED', 'VALIDATION_PENDING'].includes(paper.paper_status)) {
    // The paper's COEs: whoever generated it and whoever assigned its active validators.
    const assigners = (await all('SELECT DISTINCT assigned_by FROM paper_validator_assignments WHERE paper_id = $1 AND is_active', [paper.id])).map((r) => r.assigned_by);
    const coeIds = [...new Set([paper.generated_by, ...assigners].filter(Boolean))];
    problems = await validatorProblems({ get, all }, { paper, validatorIds: pending.map((r) => r.validator_id), coeIds });
  }
  res.json(rows.map((r) => ({ ...r, problems: r.is_active && !r.decision ? (problems.get(r.validator_id) || []) : [] })));
});

// The validator's own record: every assignment, active or ended, with their decision. `can_open` says whether
// the paper itself is still open to them (paper-policy.js VALIDATOR_ACCESS_STATUSES, and their validator scope
// still covers the examination; paper-access.js gives the full reason when it is not).
router.get('/my-validations', requireRole('validator'), async (req, res) => {
  res.json(await all(`
    SELECT pva.id AS assignment_id, ep.id AS paper_id, ep.title, ep.paper_status, ep.paper_version, e.exam_type, s.subject_code,
           pva.validator_number, pva.validation_round, pva.decision, pva.comments, pva.checklist_results, pva.decided_at,
           pva.is_active, pva.deactivation_reason, pva.deactivated_at,
           (pva.is_active AND ep.paper_status = ANY($2::text[])
            AND user_has_scope(pva.validator_id, 'validator', e.campus_id, pr.department_id, e.program_id, e.course_offering_id)) AS can_open
    FROM paper_validator_assignments pva JOIN exam_papers ep ON ep.id = pva.paper_id
    JOIN examinations e ON e.id = ep.examination_id JOIN subjects s ON s.id = e.subject_id JOIN programs pr ON pr.id = e.program_id
    WHERE pva.validator_id = $1 ORDER BY pva.assigned_at DESC LIMIT 200`, [req.user.id, VALIDATOR_ACCESS_STATUSES]));
});

// A validator's decision. Inside one transaction (lock order: paper row, assignment row, users/scopes): the
// paper must await validation, the caller must still hold an active undecided assignment, and every
// eligibility rule is re-checked (scope, active account, COE/author conflict, independence policy).
router.post('/papers/:paperId/validate', requireRole('validator'), async (req, res) => {
  const { decision, comments, checklist } = req.body || {};
  if (!['APPROVE', 'CHANGES_REQUIRED'].includes(decision)) return res.status(400).json({ error: 'Invalid decision' });
  if (decision === 'CHANGES_REQUIRED' && !(comments || '').trim()) return res.status(400).json({ error: 'Comments are required with CHANGES_REQUIRED' });
  if (decision === 'APPROVE' && !(checklist && CHECKLIST.every((k) => checklist[k] === true))) {
    return res.status(400).json({ error: 'Every checklist item must be confirmed to approve', checklist_items: CHECKLIST });
  }
  const authz = await authorize(req.user, 'validate_paper', { paper_id: req.params.paperId, type: 'paper_validation' });
  if (!authz.allowed) return res.status(403).json({ error: authz.reason });

  const result = await withTransaction(async (txn) => {
    const paper = await txn.get('SELECT id, paper_status, required_approvals, generated_by, examination_id FROM exam_papers WHERE id = $1 FOR UPDATE', [req.params.paperId]);
    if (!paper || paper.paper_status !== 'VALIDATION_PENDING') return { status: 409, error: `Paper is not awaiting validation (status: ${paper?.paper_status})` };
    const mine = await txn.get('SELECT id, decision, assigned_by FROM paper_validator_assignments WHERE paper_id = $1 AND validator_id = $2 AND is_active FOR UPDATE', [paper.id, req.user.id]);
    if (!mine) return { status: 403, error: 'You are no longer assigned to this paper' };
    if (mine.decision) return { status: 409, error: 'You have already submitted a decision for this paper' };
    const ctx = await paperContext(txn, paper.examination_id);
    const problems = (await validatorProblems(txn, { paper: { ...ctx, id: paper.id }, validatorIds: [req.user.id],
      coeIds: [mine.assigned_by, paper.generated_by].filter(Boolean), lock: true })).get(req.user.id);
    if (problems.length) {
      return { status: 403, error: `You can no longer decide on this paper: ${problems.join('; ')}. The COE has been asked to replace you.`, refused: problems };
    }

    const upd = await txn.run(`UPDATE paper_validator_assignments SET decision = $1, comments = $2, checklist_results = $3, decided_at = now()
                               WHERE id = $4 AND is_active AND decision IS NULL RETURNING id`,
      [decision, comments || null, JSON.stringify(checklist || {}), mine.id]);
    if (upd.rowCount !== 1) return { status: 409, error: 'Your assignment changed meanwhile; reload' };
    const c = checklist || {};
    await txn.run(`INSERT INTO paper_validation_reviews (paper_id, validator_id, assignment_id, ${CHECKLIST.join(',')}, overall_decision, comments)
                   VALUES ($1,$2,$3,${CHECKLIST.map((_, i) => `$${i + 4}`).join(',')},$${CHECKLIST.length + 4},$${CHECKLIST.length + 5})`,
      [paper.id, req.user.id, mine.id, ...CHECKLIST.map((k) => (k in c ? !!c[k] : null)), decision, comments || null]);

    const rows = await txn.all('SELECT decision FROM paper_validator_assignments WHERE paper_id = $1 AND is_active', [paper.id]);
    const outcome = validationOutcome(rows.map((r) => r.decision), paper.required_approvals);
    if (outcome.nextStatus) {
      await txn.run('UPDATE exam_papers SET paper_status = $1 WHERE id = $2', [outcome.nextStatus, paper.id]);
    }
    // Audit last: logAudit holds the chain lock until COMMIT.
    await logAudit({ userId: req.user.id, action: 'paper_validation_submitted', entityId: paper.id,
      details: { decision, assignment_id: mine.id, all_decided: outcome.allDecided, approvals: outcome.approvals, required: outcome.required, next_status: outcome.nextStatus }, ip: req.ip }, txn);
    return { ...outcome, assignmentId: mine.id };
  });
  if (result.refused) {
    await logAudit({ userId: req.user.id, action: 'paper_validation_refused', entityId: req.params.paperId, details: { decision, problems: result.refused }, ip: req.ip });
    await notifyPaperCoes(req.params.paperId, 'validator_needs_replacement', `a validator can no longer decide (${result.refused.join('; ')}); replace them to finish validation.`);
  }
  if (result.error) return res.status(result.status || 409).json({ error: result.error, ...(result.refused ? { reasons: result.refused } : {}) });
  if (result.nextStatus) {
    await notifyPaperCoes(req.params.paperId, 'paper_validation_outcome',
      `validation finished: ${result.nextStatus} (${result.approvals}/${VALIDATOR_COUNT} approved, ${result.required} required).`);
  }
  res.json({
    message: 'Decision recorded', all_decided: result.allDecided, all_approved: result.allApproved,
    approvals: result.approvals, required_approvals: result.required, paper_status: result.nextStatus || 'VALIDATION_PENDING',
  });
});

// A file a paper question's snapshot refers to (a diagram), for whoever may see the paper (paper-access.js: the COE
// in scope, an eligible validator while it is under validation). Only files of THIS paper's questions, only while
// the stored file is the one recorded (paper-attachments.js), never a quarantined one. Never cached by the browser.
router.get('/papers/:paperId/attachments/:attachmentId', async (req, res) => {
  const paper = await loadPaper(req.params.paperId);
  if (!paper) return res.status(404).json({ error: 'Paper not found' });
  const access = await paperAccess(req.user, paper);
  if (!access.view) return res.status(403).json({ error: access.reason || 'Not allowed' });
  if (!UUID_RE.test(req.params.attachmentId)) return res.status(404).json({ error: 'File not found' });
  const rows = await all(`
    SELECT pq.question_id, pq.metadata_snapshot FROM paper_questions pq
    JOIN question_attachments a ON a.question_id = pq.question_id
    WHERE pq.paper_id = $1 AND a.id = $2`, [paper.id, req.params.attachmentId]);
  const files = await paperQuestionAttachments(paper, rows);
  const att = [...files.values()].flat().find((a) => a.id === req.params.attachmentId && a.available);
  if (!att) return res.status(404).json({ error: 'File not found' });
  res.set('Cache-Control', 'no-store');
  res.type(att.file_type);
  res.sendFile(resolveStored(att.file_path));
});

// ---------- Printable paper (spec §19 paper_pdf) ----------
// Built from the paper's own snapshots, never from the live question bank or blueprint, so the
// PDF of a historical paper always matches what was validated: questions from paper_questions,
// section headings, instructions and internal choices from format_config. Access follows the
// paper status (paper-access.js): the COE in campus scope always; an assigned
// validator, with the answer key they need to check correctness, only while the
// paper is under validation. The answer key of an approved or locked paper is
// therefore COE-only. Anything not PRINT_READY carries a DRAFT watermark. Diagrams recorded in the snapshots are
// embedded (PNG/JPEG). ?inline=1 serves it for the browser's viewer (preview / print) instead of as a download.
router.get('/papers/:paperId/pdf', async (req, res) => {
  const paper = await loadPaper(req.params.paperId);
  if (!paper) return res.status(404).json({ error: 'Paper not found' });
  const access = await paperAccess(req.user, paper);
  if (!access.view) return res.status(403).json({ error: access.reason || 'Not allowed' });
  const includeAnswers = req.query.include_answers === '1' || req.query.include_answers === 'true';
  if (includeAnswers && !access.answerKey) {
    return res.status(403).json({ error: `The answer key is not available to you for a paper in status ${paper.paper_status}` });
  }
  const meta = await get(`
    SELECT s.subject_code, s.course_title, p.name AS program_name, d.name AS department_name,
           sess.label AS academic_session_label, e.semester, e.exam_type, e.exam_date, c.name AS campus_name, e.syllabus_version_id
    FROM examinations e
    JOIN subjects s ON s.id = e.subject_id
    JOIN programs p ON p.id = e.program_id
    LEFT JOIN departments d ON d.id = p.department_id
    LEFT JOIN academic_sessions sess ON sess.id = e.academic_session_id
    LEFT JOIN campuses c ON c.id = e.campus_id
    WHERE e.id = $1`, [paper.examination_id]);
  const rows = await all(`
    SELECT pq.slot_number, pq.question_id, pq.question_text_snapshot, pq.marks_snapshot, pq.metadata_snapshot, pq.section_name
    FROM paper_questions pq WHERE pq.paper_id = $1 ORDER BY pq.slot_number NULLS LAST`, [paper.id]);
  const files = await paperQuestionAttachments(paper, rows);
  const frozenCos = candidateCos(paper); // CO codes frozen at generation, never the live CO mapping
  // Unit of each question for the internal analysis page: its snapshot topic in the examination's syllabus version
  // (immutable once active), never the live question bank. Only read for the internal copy.
  const unitOf = new Map();
  if (includeAnswers && meta?.syllabus_version_id) {
    for (const u of await all(`SELECT lower(trim(t.title)) AS topic, u.code, u.title, u.sequence FROM syllabus_topics t
        JOIN syllabus_units u ON u.id = t.syllabus_unit_id WHERE u.syllabus_version_id = $1`, [meta.syllabus_version_id])) {
      unitOf.set(u.topic, { code: u.code, title: u.title, sequence: u.sequence });
    }
  }
  const questions = rows.map((r) => {
    const q = snapshotQuestion(r);
    return { ...q, cos: frozenCos[r.question_id] || [], unit: unitOf.get(String(q.topic || '').trim().toLowerCase()) || null, attachments: withImageData(files.get(r.question_id)) };
  });
  const sections = paperSectionsView(paper.format_config, questions); // frozen section rules, never the live blueprint
  const inline = req.query.inline === '1' || req.query.inline === 'true';
  await logAudit({ userId: req.user.id, action: 'paper_pdf_downloaded', entityId: paper.id,
    details: { include_answers: includeAnswers, paper_status: paper.paper_status, ...(inline ? { inline: true } : {}) }, ip: req.ip });
  streamPaperPdf(res, { paper: { ...paper, ...(meta || {}) }, questions, sections, includeAnswers, inline });
});

// ---------- Issues (validators report; COE closes; master questions are never edited) ----------
// Reported by an actively assigned validator while the paper is VALIDATION_PENDING or VALIDATED (before or
// after their own decision), who is still eligible (scope, active account, conflicts: the decision route's
// rules). Checked under the paper row lock and again by the database (migration 039). The issue row and its
// audit row commit together.
router.post('/papers/:paperId/issues', requireRole('validator'), async (req, res) => {
  const { question_id, issue_type } = req.body || {};
  const description = String(req.body?.description || '').trim();
  if (!ISSUE_TYPES.includes(issue_type) || description.length < 5 || description.length > 2000) {
    return res.status(400).json({ error: 'A valid issue_type and a description of 5 to 2000 characters are required', issue_types: ISSUE_TYPES });
  }
  if (question_id != null && question_id !== '' && !UUID_RE.test(String(question_id))) return res.status(400).json({ error: 'question_id is not part of this paper' });
  const qid = question_id || null;
  const authz = await authorize(req.user, 'validate_paper', { paper_id: req.params.paperId, type: 'paper_validation' });
  if (!authz.allowed) return res.status(403).json({ error: authz.reason });

  const out = await withTransaction(async (txn) => {
    const p = await txn.get('SELECT id, paper_status, generated_by, examination_id FROM exam_papers WHERE id = $1 FOR UPDATE', [req.params.paperId]);
    if (!p || !canReportIssue(p.paper_status)) {
      return { status: 409, error: `Issues can be reported only while the paper is VALIDATION_PENDING or VALIDATED (current: ${p?.paper_status})` };
    }
    const mine = await txn.get('SELECT id, assigned_by FROM paper_validator_assignments WHERE paper_id = $1 AND validator_id = $2 AND is_active', [p.id, req.user.id]);
    if (!mine) return { status: 403, error: 'Not assigned to validate this paper' };
    const ctx = await paperContext(txn, p.examination_id);
    const problems = (await validatorProblems(txn, { paper: { ...ctx, id: p.id }, validatorIds: [req.user.id],
      coeIds: [mine.assigned_by, p.generated_by].filter(Boolean), lock: true })).get(req.user.id);
    if (problems.length) return { status: 403, error: `You can no longer work on this paper: ${problems.join('; ')}` };
    if (qid && !(await txn.get('SELECT 1 AS x FROM paper_questions WHERE paper_id = $1 AND question_id = $2', [p.id, qid]))) {
      return { status: 400, error: 'question_id is not part of this paper' };
    }
    const dup = await txn.get(`SELECT id FROM paper_issues WHERE paper_id = $1 AND reported_by = $2 AND status = 'open' AND issue_type = $3
                               AND question_id IS NOT DISTINCT FROM $4::uuid AND lower(trim(description)) = lower($5)`,
      [p.id, req.user.id, issue_type, qid, description]);
    if (dup) return { status: 409, error: 'You already reported this issue', issue_id: dup.id };
    const row = await txn.get('INSERT INTO paper_issues (paper_id, question_id, issue_type, description, reported_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [p.id, qid, issue_type, description, req.user.id]);
    const slot = qid ? await txn.get('SELECT slot_number FROM paper_questions WHERE paper_id = $1 AND question_id = $2', [p.id, qid]) : null;
    // Audit last: logAudit holds the chain lock until COMMIT.
    await logAudit({ userId: req.user.id, action: 'paper_issue_reported', entityId: p.id,
      details: { issue_id: row.id, issue_type, question_id: qid, paper_status: p.paper_status }, ip: req.ip }, txn);
    return { row, paperStatus: p.paper_status, slot: slot?.slot_number ?? null };
  });
  if (out.error) return res.status(out.status).json({ error: out.error, ...(out.issue_id ? { issue_id: out.issue_id } : {}) });
  await notifyPaperCoes(req.params.paperId, 'paper_issue_reported', `a validator reported a ${issue_type} issue${out.slot ? ` on Q${out.slot}` : ''}.`);
  res.status(201).json(out.row);
});

// The COE sees every issue with reporter and resolver; a validator sees only their own (independence: no
// anchoring on what the other validators found).
router.get('/papers/:paperId/issues', async (req, res) => {
  const paper = await loadPaper(req.params.paperId);
  if (!paper) return res.status(404).json({ error: 'Paper not found' });
  if (!(await canSeePaper(req.user, paper))) return res.status(403).json({ error: 'Not allowed' });
  res.json(await all(`
    SELECT pi.id, pi.question_id, pi.issue_type, pi.description, pi.status, pi.resolution, pi.resolved_at, pi.created_at,
           pi.carried_from_issue_id, pi.carried_to_issue_id, (pi.reported_by = $2) AS mine,
           CASE WHEN $3 = 'coe' THEN u.email END AS reported_by_email, CASE WHEN $3 = 'coe' THEN ru.email END AS resolved_by_email,
           (SELECT slot_number FROM paper_questions pq WHERE pq.paper_id = pi.paper_id AND pq.question_id = pi.question_id) AS slot_number,
           src.paper_version AS carried_from_version, r.created_at AS referred_at, r.recipient_role AS referred_to_role,
           cardinality(r.recipients) AS referred_to_count
    FROM paper_issues pi JOIN users u ON u.id = pi.reported_by LEFT JOIN users ru ON ru.id = pi.resolved_by
    LEFT JOIN paper_issues ci ON ci.id = pi.carried_from_issue_id LEFT JOIN exam_papers src ON src.id = ci.paper_id
    LEFT JOIN paper_issue_referrals r ON r.issue_id = COALESCE(pi.origin_issue_id, pi.id)
    WHERE pi.paper_id = $1 AND ($3 = 'coe' OR pi.reported_by = $2)
    ORDER BY (pi.status = 'open') DESC, pi.created_at DESC`, [paper.id, req.user.id, req.user.role]));
});

// Close an issue exactly once (spec §30): resolved = the problem does not apply to this paper (the paper
// itself never changes, §28; only a regeneration replaces content), wont_fix = accepted as is.
router.post('/issues/:issueId/resolve', requireRole('coe'), async (req, res) => {
  const { status } = req.body || {};
  const resolution = String(req.body?.resolution || '').trim();
  if (!MANUAL_ISSUE_CLOSE.includes(status) || resolution.length < 10 || resolution.length > 2000) {
    return res.status(400).json({ error: `status (${MANUAL_ISSUE_CLOSE.join('|')}) and a resolution of at least 10 characters are required`, statuses: MANUAL_ISSUE_CLOSE });
  }
  if (!UUID_RE.test(req.params.issueId)) return res.status(404).json({ error: 'Issue not found' });
  const issue = await get('SELECT id, paper_id, reported_by, status FROM paper_issues WHERE id = $1', [req.params.issueId]);
  if (!issue) return res.status(404).json({ error: 'Issue not found' });
  const paper = await loadPaper(issue.paper_id);
  if (!(await canSeePaper(req.user, paper))) return res.status(403).json({ error: 'Not allowed' });
  let out;
  try {
    out = await withTransaction(async (txn) => {
      const p = await txn.get('SELECT id, paper_status FROM exam_papers WHERE id = $1 FOR UPDATE', [issue.paper_id]);
      if (!canCloseIssue(p?.paper_status)) return { status: 409, error: `Issues of a ${p?.paper_status} paper cannot be closed` };
      const upd = await txn.get(`UPDATE paper_issues SET status = $1, resolution = $2, resolved_by = $3, resolved_at = now(), updated_at = now()
                                 WHERE id = $4 AND status = 'open' RETURNING *`, [status, resolution, req.user.id, issue.id]);
      if (!upd) {
        const cur = await txn.get('SELECT status FROM paper_issues WHERE id = $1', [issue.id]);
        return { status: 409, error: 'This issue was already closed', current_status: cur?.status };
      }
      // Audit last, in the same transaction: the closure and its record commit together.
      await logAudit({ userId: req.user.id, action: 'paper_issue_resolved', entityId: issue.paper_id,
        details: { issue_id: issue.id, old_status: 'open', new_status: status, resolution, paper_status: p.paper_status }, ip: req.ip }, txn);
      return { issue: upd, paperStatus: p.paper_status };
    });
  } catch (err) {
    if (/cannot be closed|already closed|Only an active COE|resolution of at least/.test(err.message || '')) return res.status(409).json({ error: err.message });
    throw err;
  }
  if (out.error) return res.status(out.status).json({ error: out.error, ...(out.current_status ? { current_status: out.current_status } : {}) });
  await notify(issue.reported_by, 'paper_issue_closed',
    `An issue you reported was marked ${status === 'wont_fix' ? "won't fix" : 'resolved'}: ${resolution}`, issue.paper_id);
  res.json({ ok: true, issue: out.issue });
});

// Refer the source question to whoever can fix it (spec §27 "Reviewer separately fixes the source question").
// The examination side never writes the bank (§1): this records the request and notifies; the reviewer uses
// the normal lifecycle (ACTIVE -> CHANGES_REQUESTED). The notification carries only the COE's note and the
// issue type, never the paper, exam, slot or the validator's text (§15 exposure).
router.post('/issues/:issueId/refer', requireRole('coe'), async (req, res) => {
  const note = String(req.body?.note || '').trim();
  if (note.length < 10 || note.length > 1000) return res.status(400).json({ error: 'A note of 10 to 1000 characters is required' });
  if (!UUID_RE.test(req.params.issueId)) return res.status(404).json({ error: 'Issue not found' });
  const issue = await get('SELECT id, paper_id, question_id, issue_type, origin_issue_id FROM paper_issues WHERE id = $1', [req.params.issueId]);
  if (!issue) return res.status(404).json({ error: 'Issue not found' });
  const paper = await loadPaper(issue.paper_id);
  if (!(await canSeePaper(req.user, paper))) return res.status(403).json({ error: 'Not allowed' });
  if (!issue.question_id) return res.status(400).json({ error: 'Only an issue about a question can be referred' });
  const origin = issue.origin_issue_id || issue.id;
  const rcp = await referralRecipients({ get, all }, issue.question_id);
  if (!rcp?.ids.length) return res.status(409).json({ error: "No active reviewer or HOD covers this question's offering; ask the HOD to assign a reviewer" });
  let row;
  try {
    // The referral and its audit row commit together; notifications follow the commit.
    row = await withTransaction(async (txn) => {
      const ref = await txn.get(`INSERT INTO paper_issue_referrals (issue_id, question_id, referred_by, recipients, recipient_role, note)
                                 VALUES ($1,$2,$3,$4::uuid[],$5,$6) RETURNING id, created_at`, [origin, issue.question_id, req.user.id, rcp.ids, rcp.role, note]);
      await logAudit({ userId: req.user.id, action: 'paper_issue_referred', entityId: issue.paper_id,
        details: { issue_id: issue.id, origin_issue_id: origin, question_id: issue.question_id, recipient_role: rcp.role, recipients: rcp.ids, note, referral_id: ref?.id }, ip: req.ip }, txn);
      return ref;
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'This issue was already referred' });
    throw err;
  }
  await notifyMany(rcp.ids, 'question_referred_by_examination',
    `The examination cell asked for a review of this source question (${issue.issue_type}): ${note}`, issue.question_id);
  res.status(201).json({ referred_to_role: rcp.role, referred_to_count: rcp.ids.length, referred_at: row?.created_at || null });
});

export default router;
