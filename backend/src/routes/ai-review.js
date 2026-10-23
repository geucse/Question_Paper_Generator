import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { get, all, run } from '../db.js';
import { requireAuth, requireRole } from '../middleware.js';
import { logAudit } from '../audit.js';
import { notifyMany } from '../notifications.js';
import { classifyAgainstBank } from '../dedup.js';
import { hodsInScope } from '../scopes.js';
import { PRINTABLE_IMAGE_TYPES } from '../question-types.js';
import { heuristicReview, reviewPrompt, typeRuleIssues } from '../ai-review-content.js';

const router = express.Router();

// AI review is advisory (PIVOT_SPEC_V2 §39 invariant 10): it stores findings, never status.
// It runs only while the author can still act on them.
const AI_REVIEWABLE_STATES = ['DRAFT', 'SUBMITTED', 'CHANGES_REQUESTED', 'RESUBMITTED'];
// The author may dispute findings while the question is visible to the HOD and still undecided.
const DISPUTABLE_STATES = ['SUBMITTED', 'RESUBMITTED', 'UNDER_REVIEW'];
const MAX_DISPUTE_LEN = 2000;
function parseFindings(text) {
  try { const v = JSON.parse(text || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

// One client, no conversation state kept between calls. Each review below is
// a single, independent request — nothing about a previous teacher's
// question, or this teacher's previous questions, is ever included in the
// prompt. That's what "non-persistent" means in practice here.
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

async function aiTextReview(q) {
  // Used if no ANTHROPIC_API_KEY is configured, so the feature still works (minus the language-quality checks)
  // rather than hard-failing submission. Type-aware either way (ai-review-content.js).
  if (!anthropic) return heuristicReview(q);
  const prompt = reviewPrompt(q);

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = response.content.find(b => b.type === 'text')?.text || '{"issues":[]}';
    const cleaned = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return [...(Array.isArray(parsed.issues) ? parsed.issues : []), ...typeRuleIssues(q)];
  } catch (e) {
    console.error('AI review call failed, falling back to heuristics:', e.message);
    return heuristicReview(q);
  }
}

router.post('/:questionId', requireAuth, requireRole('teacher'), async (req, res) => {
  const q = await get('SELECT * FROM questions WHERE id = $1 AND submitted_by = $2', [req.params.questionId, req.user.id]);
  if (!q) return res.status(404).json({ error: 'Not found' });
  if (!AI_REVIEWABLE_STATES.includes(q.question_status)) {
    return res.status(409).json({
      error: `AI review only runs while the author can still change the question (${AI_REVIEWABLE_STATES.join(', ')}); this question is ${q.question_status}`,
      question_status: q.question_status,
    });
  }

  // The type rules need the question's files (diagram questions); only clean files count, as in the quality gate.
  const files = await get(`SELECT COUNT(*) FILTER (WHERE scan_status = 'clean')::int AS attachment_count,
      COUNT(*) FILTER (WHERE scan_status = 'clean' AND file_type = ANY($2::text[]))::int AS diagram_image_count
    FROM question_attachments WHERE question_id = $1`, [q.id, PRINTABLE_IMAGE_TYPES]);
  const languageIssues = await aiTextReview({ ...q, attachment_count: files?.attachment_count ?? 0, diagram_image_count: files?.diagram_image_count ?? 0 });

  // Deterministic checks run alongside the AI call — duplicate detection and
  // topic-balance never depend on model judgment, only on the database.
  // Reuses the same classification pipeline the submission preview screen
  // uses (backend/src/dedup.js), so an AI-review "possible duplicate"
  // finding and the preview screen's finding are always the same
  // classification, computed the same way — not two independently-tuned
  // thresholds that could disagree with each other.
  const dupeCandidates = await classifyAgainstBank(q, q.course_offering_id);
  const exactOrLikely = dupeCandidates.filter(c => c.classification === 'EXACT_DUPLICATE' || c.classification === 'LIKELY_DUPLICATE');
  const related = dupeCandidates.filter(c => c.classification === 'RELATED');

  const topicCounts = await all(`
    SELECT topic, COUNT(*) as cnt FROM questions
    WHERE course_offering_id = $1 AND question_status IN ('APPROVED','ACTIVE') AND topic IS NOT NULL
    GROUP BY topic
  `, [q.course_offering_id]);
  const avgCount = topicCounts.length ? topicCounts.reduce((s, t) => s + Number(t.cnt), 0) / topicCounts.length : 0;
  const thisTopic = topicCounts.find(t => t.topic === q.topic);
  const overrepresented = thisTopic && avgCount > 0 && Number(thisTopic.cnt) > avgCount * 1.5;

  const allIssues = [
    ...languageIssues,
    ...exactOrLikely.map(c => ({
      type: c.classification === 'EXACT_DUPLICATE' ? 'duplicate' : 'near_duplicate',
      detail: `Classified ${c.classification} against an existing question (${Math.round(c.similarity * 100)}% similar) — ${c.reasons.join(' ')}`,
    })),
    ...related.map(c => ({
      type: 'related_question',
      detail: `Classified RELATED to an existing question (${Math.round(c.similarity * 100)}% similar) — not treated as a duplicate, but worth a glance.`,
    })),
    ...(overrepresented ? [{ type: 'topic_imbalance', detail: `"${q.topic}" already has ${thisTopic.cnt} approved questions, well above the subject average` }] : []),
  ];

  const outcome = allIssues.length === 0 ? 'no_issues' : 'issues_found';
  // Findings only: status / question_status / is_draft are never written here, so no lifecycle trigger fires.
  // Conditional on the state checked above so a concurrent transition is never overwritten.
  const saved = await run(`
    UPDATE questions SET ai_review_notes = $1, ai_reviewed_at = now(), ai_review_dispute = NULL, ai_review_disputed_at = NULL
    WHERE id = $2 AND submitted_by = $3 AND question_status = $4 RETURNING id
  `, [JSON.stringify(allIssues), q.id, req.user.id, q.question_status]);
  if (!saved.rowCount) return res.status(409).json({ error: 'The question changed state while the AI review ran; nothing was saved' });

  // Only the findings are persisted. The prompt and raw model response are never written to the database or logs.
  await logAudit({ userId: req.user.id, action: 'ai_review_completed', entityId: q.id,
    details: { advisory: true, outcome, issue_count: allIssues.length, question_status: q.question_status }, ip: req.ip });

  res.json({ advisory: true, outcome, issues: allIssues, question_status: q.question_status });
});

// The author disagrees with the AI findings: the note is recorded and the in-scope HODs are told.
// Advisory only; the question's status does not change (§39 inv. 10). One dispute per AI run (a re-run clears it).
router.post('/:questionId/appeal', requireAuth, requireRole('teacher'), async (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (reason.length < 3 || reason.length > MAX_DISPUTE_LEN) {
    return res.status(400).json({ error: `Explain why you disagree (3-${MAX_DISPUTE_LEN} characters)` });
  }
  const q = await get('SELECT id, course_offering_id, question_status, ai_review_notes, ai_review_dispute FROM questions WHERE id = $1 AND submitted_by = $2',
    [req.params.questionId, req.user.id]);
  if (!q) return res.status(404).json({ error: 'Not found' });
  if (!DISPUTABLE_STATES.includes(q.question_status)) {
    return res.status(409).json({ error: `AI findings can be disputed only while the question is ${DISPUTABLE_STATES.join(', ')}`, question_status: q.question_status });
  }
  if (parseFindings(q.ai_review_notes).length === 0) return res.status(409).json({ error: 'There are no AI findings to dispute' });
  if (q.ai_review_dispute) return res.status(409).json({ error: 'These findings were already disputed' });

  const saved = await run(`
    UPDATE questions SET ai_review_dispute = $1, ai_review_disputed_at = now()
    WHERE id = $2 AND submitted_by = $3 AND question_status = ANY($4::text[]) AND ai_review_dispute IS NULL RETURNING id
  `, [reason, q.id, req.user.id, DISPUTABLE_STATES]);
  if (!saved.rowCount) return res.status(409).json({ error: 'The question changed while the dispute was saved; nothing was recorded' });

  await logAudit({ userId: req.user.id, action: 'ai_review_disputed', entityId: q.id, details: { reason, question_status: q.question_status }, ip: req.ip });
  const hods = await hodsInScope(q.course_offering_id);
  await notifyMany(hods.map((h) => h.id), 'ai_review_disputed', 'A teacher disputed the automated findings on a question in your scope.', q.id);
  res.json({ ok: true, advisory: true, question_status: q.question_status, notified: hods.length });
});

export default router;
