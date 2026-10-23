// Legacy (pre-pivot) paper API.
//
// PIVOT_SPEC_V2 §1/§2: the HOD no longer generates, selects, edits or approves papers;
// the COE does that through /api/examinations and /api/coe. Every legacy write path
// now returns 410 Gone. What remains is read-only access for a HOD to the OLD papers
// of departments its hod scope covers (examination_id IS NULL), so history stays reachable. They are rendered
// from their paper_questions snapshots only (migration 040 rebuilt the missing ones of pre-029 papers, flagged).
// Examination-domain papers are never served here: they belong to the COE and the
// paper's assigned validators (src/paper-access.js).
//
// The previous implementation (candidate generation, recommendations, HOD blueprints)
// is in git history; data in paper_generation_requests / candidate_recommendations is untouched.
import express from 'express';
import { get, all } from '../db.js';
import { requireAuth, requireRole } from '../middleware.js';
import { logAudit } from '../audit.js';
import { streamPaperPdf, snapshotQuestion } from '../paper-pdf.js';
import { SCOPE_SQL, hodCovers, isUuid } from '../scopes.js';
import { paperQuestionAttachments, withImageData } from '../paper-attachments.js';

const router = express.Router();
router.use(requireAuth);

const retired = (what) => (req, res) => res.status(410).json({
  error: `${what} is retired. Examination papers are created, validated and approved by the COE via /api/examinations and /api/coe.`,
});

router.post('/generate', retired('Legacy paper generation'));
router.get('/blueprints', retired('Legacy HOD blueprints'));
router.post('/blueprints', retired('Legacy HOD blueprints'));
router.post('/blueprints/:id/deactivate', retired('Legacy HOD blueprints'));
router.get('/generation-requests/:id', retired('Legacy candidate generation'));
router.post('/generation-requests/:id/recommend', retired('Legacy candidate recommendation'));
router.post('/candidates/:paperId/select', retired('Legacy candidate selection'));
router.patch('/:id', retired('Editing papers through the legacy API'));

// A legacy paper the calling HOD may read, or an error. Campus and department come from the DB, never the
// request, and the HOD's coverage from its active hod scope (user_scopes; spec §4), never users.department_id.
async function loadLegacyPaperForHod(req, id) {
  if (!isUuid(id)) return { error: 'Not found', status: 404 };
  const paper = await get(`
    SELECT ep.*, subj.subject_code, subj.course_title, prog.name AS program_name, co.campus_id,
           prog.department_id, dept.name AS department_name, co.academic_session_id, co.semester,
           sess.label AS academic_session_label
    FROM exam_papers ep
    LEFT JOIN course_offerings co ON co.id = ep.course_offering_id
    LEFT JOIN programs prog ON prog.id = co.program_id
    LEFT JOIN departments dept ON dept.id = prog.department_id
    LEFT JOIN academic_sessions sess ON sess.id = co.academic_session_id
    LEFT JOIN subjects subj ON subj.id = ep.subject_id
    WHERE ep.id = $1`, [id]);
  // Same 404 for "missing", "examination-domain" and "out of scope": don't confirm existence.
  if (!paper || paper.examination_id || !paper.department_id
      || !(await hodCovers(req.user, { campus_id: paper.campus_id, department_id: paper.department_id }))) {
    return { error: 'Not found', status: 404 };
  }
  return { paper };
}

// The paper's questions from its frozen snapshots only (spec §28, invariant 7). The questions table is joined
// solely for its immutable created_at, to keep the historical order; no content column is read from it.
async function snapshotRows(paperId) {
  return all(`
    SELECT pq.question_id, pq.question_text_snapshot, pq.marks_snapshot, pq.metadata_snapshot, pq.section_name, pq.slot_number
    FROM paper_questions pq LEFT JOIN questions q ON q.id = pq.question_id
    WHERE pq.paper_id = $1
    ORDER BY pq.slot_number NULLS LAST, array_position(ARRAY['easy','medium','hard'], pq.metadata_snapshot->>'difficulty'), q.created_at, pq.question_id`, [paperId]);
}

router.get('/', requireRole('hod'), async (req, res) => {
  res.json(await all(`
    SELECT ep.id, ep.title, ep.status, ep.paper_status, ep.created_at, ep.locked_at, ep.course_offering_id
    FROM exam_papers ep
    JOIN course_offerings co ON co.id = ep.course_offering_id
    JOIN programs p ON p.id = co.program_id
    WHERE ep.examination_id IS NULL AND ${SCOPE_SQL}
      AND ep.status NOT IN ('candidate', 'discarded')
    ORDER BY ep.created_at DESC LIMIT 200`, [req.user.id, 'hod']));
});

router.get('/:id', requireRole('hod'), async (req, res) => {
  const { paper, error, status } = await loadLegacyPaperForHod(req, req.params.id);
  if (error) return res.status(status).json({ error });
  const questions = (await snapshotRows(paper.id)).map(snapshotQuestion).map((q) => ({
    id: q.id, question_text: q.question_text, question_type: q.question_type, difficulty: q.difficulty, marks: q.marks,
    topic: q.topic, reconstructed: q.reconstructed, snapshot_missing: q.snapshot_missing,
  }));
  res.json({ paper, questions });
});

router.get('/:id/pdf', requireRole('hod'), async (req, res) => {
  const { paper, error, status } = await loadLegacyPaperForHod(req, req.params.id);
  if (error) return res.status(status).json({ error });
  const rows = await snapshotRows(paper.id);
  const files = await paperQuestionAttachments(paper, rows);
  const questions = rows.map((r) => ({ ...snapshotQuestion(r), attachments: withImageData(files.get(r.question_id)) }));
  const includeAnswers = req.query.include_answers === '1' || req.query.include_answers === 'true';
  const inline = req.query.inline === '1' || req.query.inline === 'true';
  await logAudit({ userId: req.user.id, action: 'paper_pdf_downloaded', entityId: paper.id,
    details: { includeAnswers, status: paper.status, legacy: true, ...(inline ? { inline: true } : {}) }, ip: req.ip });
  streamPaperPdf(res, { paper, questions, includeAnswers, inline });
});

export default router;
