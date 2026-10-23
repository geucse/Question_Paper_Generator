// Dataset quality / coverage (PIVOT_SPEC_V2 section 17). HOD and reviewer, each within their own scope:
//   hod      -> questions of offerings whose campus + department an active hod scope covers (SCOPE_SQL);
//   reviewer -> questions of offerings the reviewer is actively assigned to, inside an active reviewer scope
//               (the same population as the reviewer's lifecycle list), never the whole campus.
// A requested course_offering_id is checked through authorize('view_analytics') (logged; 403 out of scope).
// Also the question-bank export (same scopes), in the bulk import layout.
import express from 'express';
import { all, get } from '../db.js';
import { requireAuth, requireRole } from '../middleware.js';
import { authorize } from '../authorization.js';
import { SCOPE_SQL, isUuid } from '../scopes.js';
import * as XLSX from 'xlsx';
import { logAudit } from '../audit.js';
import { SHEET_COLUMNS, exportRow } from '../question-export.js';
import { TRANSITIONS } from './questions-lifecycle.js';

const QUESTION_STATUSES = Object.keys(TRANSITIONS);

const router = express.Router();

// The guard sits on the route, not router.use: this router is mounted at /api/question-bank next to the
// question and lifecycle routers, and a router-level guard would refuse teachers on every path there.
router.get('/analytics', requireAuth, requireRole('hod', 'reviewer'), async (req, res) => {
  const role = req.user.role;
  const offering = req.query.course_offering_id ? String(req.query.course_offering_id) : null;
  if (offering && !isUuid(offering)) return res.status(400).json({ error: 'course_offering_id is malformed' });
  const authz = await authorize(req.user, 'view_analytics', { course_offering_id: offering, type: 'analytics', id: offering });
  if (!authz.allowed) return res.status(403).json({ error: authz.reason });

  // $1 = user, $2 = role (SCOPE_SQL), $3 = optional offering. Every query references all three.
  const ASSIGNED = role === 'reviewer'
    ? 'AND EXISTS (SELECT 1 FROM reviewer_assignments ra WHERE ra.reviewer_id = $1 AND ra.course_offering_id = q.course_offering_id AND ra.is_active)'
    : '';
  const P = [req.user.id, role, offering];
  const FROM = (joins = '') => `FROM questions q JOIN course_offerings co ON co.id = q.course_offering_id JOIN programs p ON p.id = co.program_id ${joins}
    WHERE ${SCOPE_SQL} ${ASSIGNED} AND ($3::uuid IS NULL OR q.course_offering_id = $3::uuid)`;
  // Only ACTIVE questions feed paper generation, so coverage is measured on ACTIVE.
  const ACTIVE = "AND q.question_status = 'ACTIVE'";
  const bloomExpr = 'COALESCE(cq.verified_bloom_level, q.bloom_level, q.submitted_bloom_level)';
  const CQ = 'LEFT JOIN canonical_questions cq ON cq.id = q.canonical_question_id';
  // A canonical record keeps CO mappings of earlier syllabus versions as history (042); only the question's own count.
  const CO_JOIN = `JOIN question_course_outcomes qco ON qco.canonical_question_id = q.canonical_question_id
    JOIN course_outcomes oc ON oc.id = qco.course_outcome_id AND oc.syllabus_version_id = q.syllabus_version_id`;
  const UNIT_JOIN = `${CQ} JOIN syllabus_units su ON su.id = cq.verified_syllabus_unit_id`;
  const TOPIC_JOIN = `${CQ} LEFT JOIN syllabus_topics st ON st.id = cq.verified_syllabus_topic_id`;
  const SUBTOPIC_JOIN = `${TOPIC_JOIN} LEFT JOIN syllabus_subtopics vst ON vst.id = cq.verified_syllabus_subtopic_id
    LEFT JOIN syllabus_subtopics qst ON qst.id = q.subtopic_id`;
  // CO, unit and topic codes repeat across offerings (every syllabus has a CO1 and a Unit 1), so those figures are
  // grouped by offering and never merged. Bloom, CO, topic and subtopic are split into reviewer-verified and unverified
  // (teacher or AI suggestion; spec §17: never presented as if confirmed). A CO mapping counts as verified only with a
  // recorded verifier, the rule generation uses (042). generation_readiness splits ACTIVE questions into those a new
  // examination may use (verified mapping on the offering's current version), those whose mapping is unverified, and
  // those left on another (superseded) version until they are mapped.
  const OFF = 'co.id AS offering_id, co.offering_code';

  const [byStatus, byDifficulty, byType, byBloom, byCO, byUnit, byTopic, bySubtopic, readiness, usage, dup, unitDiff, coBloom] = await Promise.all([
    all(`SELECT q.question_status AS key, COUNT(*)::int AS n ${FROM()} GROUP BY 1 ORDER BY 1`, P),
    all(`SELECT q.difficulty AS key, COUNT(*)::int AS n ${FROM()} ${ACTIVE} GROUP BY 1 ORDER BY 1`, P),
    all(`SELECT q.question_type AS key, COUNT(*)::int AS n ${FROM()} ${ACTIVE} GROUP BY 1 ORDER BY 1`, P),
    all(`SELECT ${bloomExpr} AS key, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE cq.verified_bloom_level IS NOT NULL)::int AS verified,
                COUNT(*) FILTER (WHERE cq.verified_bloom_level IS NULL)::int AS unverified
         ${FROM(CQ)} ${ACTIVE} GROUP BY 1 ORDER BY 1`, P),
    all(`SELECT ${OFF}, oc.code AS key, COUNT(DISTINCT q.id)::int AS n,
                COUNT(DISTINCT q.id) FILTER (WHERE qco.verified_by IS NOT NULL)::int AS verified,
                COUNT(DISTINCT q.id) FILTER (WHERE qco.verified_by IS NULL)::int AS unverified
         ${FROM(CO_JOIN)} ${ACTIVE} GROUP BY 1, 2, 3 ORDER BY 2, 3`, P),
    all(`SELECT ${OFF}, su.code AS key, COUNT(*)::int AS n ${FROM(UNIT_JOIN)} ${ACTIVE} GROUP BY 1, 2, 3 ORDER BY 2, 3`, P),
    all(`SELECT ${OFF}, COALESCE(st.title, NULLIF(trim(q.topic), '')) AS key, COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE cq.verified_syllabus_topic_id IS NOT NULL)::int AS verified,
                COUNT(*) FILTER (WHERE cq.verified_syllabus_topic_id IS NULL)::int AS unverified
         ${FROM(TOPIC_JOIN)} ${ACTIVE} GROUP BY 1, 2, 3 ORDER BY 2, 3`, P),
    all(`SELECT ${OFF}, COALESCE(st.title, NULLIF(trim(q.topic), '')) AS topic,
                COALESCE(vst.title, qst.title, NULLIF(trim(q.subtopic), '')) AS key, COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE cq.verified_syllabus_subtopic_id IS NOT NULL)::int AS verified,
                COUNT(*) FILTER (WHERE cq.verified_syllabus_subtopic_id IS NULL)::int AS unverified
         ${FROM(SUBTOPIC_JOIN)} ${ACTIVE} AND COALESCE(vst.title, qst.title, NULLIF(trim(q.subtopic), '')) IS NOT NULL
         GROUP BY 1, 2, 3, 4 ORDER BY 2, 3, 4`, P),
    get(`SELECT COUNT(*)::int AS active_total,
                COUNT(*) FILTER (WHERE question_has_verified_mapping(q.id) AND q.syllabus_version_id = co.syllabus_version_id)::int AS generation_eligible,
                COUNT(*) FILTER (WHERE NOT question_has_verified_mapping(q.id))::int AS not_eligible_unverified,
                COUNT(*) FILTER (WHERE question_has_verified_mapping(q.id) AND q.syllabus_version_id IS DISTINCT FROM co.syllabus_version_id)::int AS not_eligible_other_version
         ${FROM()} ${ACTIVE}`, P),
    get(`SELECT COUNT(*) FILTER (WHERE q.times_used = 0)::int AS never_used,
                COUNT(*) FILTER (WHERE q.last_used_at > now() - interval '180 days')::int AS used_last_180_days,
                COUNT(*)::int AS active_total ${FROM()} ${ACTIVE}`, P),
    get(`SELECT COUNT(DISTINCT r.id)::int AS pending_candidates
         ${FROM('JOIN question_relationships r ON r.source_question_id = q.id')} AND r.status = 'pending' AND r.relationship_type = 'duplicate'`, P),
    all(`SELECT ${OFF}, su.code AS row, q.difficulty AS col, COUNT(*)::int AS n ${FROM(UNIT_JOIN)} ${ACTIVE} GROUP BY 1, 2, 3, 4 ORDER BY 2, 3, 4`, P),
    all(`SELECT ${OFF}, oc.code AS row, ${bloomExpr} AS col, COUNT(DISTINCT q.id)::int AS n ${FROM(`${CQ} ${CO_JOIN}`)} ${ACTIVE} GROUP BY 1, 2, 3, 4 ORDER BY 2, 3, 4`, P),
  ]);

  res.json({
    scope: { role, course_offering_id: offering },
    by_status: byStatus, active_by_difficulty: byDifficulty, active_by_type: byType, active_by_bloom: byBloom,
    active_by_co: byCO, active_by_unit: byUnit, active_by_topic: byTopic, active_by_subtopic: bySubtopic,
    generation_readiness: readiness || { active_total: 0, generation_eligible: 0, not_eligible_unverified: 0, not_eligible_other_version: 0 },
    usage, duplicate_candidates: dup?.pending_candidates ?? 0,
    coverage: { unit_x_difficulty: unitDiff, co_x_bloom: coBloom },
  });
});

// ---- Question-bank export (spec §34 "import/export where supported") ----
// The bulk import layout (question-export.js), so a file can be edited and imported again. Only what the caller may
// already list: a teacher their own questions; a reviewer the non-draft questions of offerings they are actively
// assigned to, in scope, never their own; an HOD the non-draft questions in scope (the lifecycle list's rules).
// ?course_offering_id narrows it (checked through authorize('view_analytics') for reviewers and HODs), ?status too.
// Admin, COE and validators never (the examination side reads the bank only through generation). Audited, bounded.
const EXPORT_LIMIT = 2000;
router.get('/export', requireAuth, requireRole('teacher', 'hod', 'reviewer'), async (req, res) => {
  const role = req.user.role;
  const offering = req.query.course_offering_id ? String(req.query.course_offering_id) : null;
  if (offering && !isUuid(offering)) return res.status(400).json({ error: 'course_offering_id is malformed' });
  const status = req.query.status ? String(req.query.status).toUpperCase() : null;
  if (status && !QUESTION_STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status', statuses: QUESTION_STATUSES });
  if (role !== 'teacher') {
    const authz = await authorize(req.user, 'view_analytics', { course_offering_id: offering, type: 'question_export', id: offering });
    if (!authz.allowed) return res.status(403).json({ error: authz.reason });
  }
  // $1 user, $2 role, $3 offering, $4 status, $5 limit; every branch references $1 and $2.
  const where = role === 'teacher' ? `q.submitted_by = $1 AND $2::text = 'teacher'`
    : role === 'reviewer' ? `q.submitted_by <> $1 AND q.question_status <> 'DRAFT' AND ${SCOPE_SQL}
        AND EXISTS (SELECT 1 FROM reviewer_assignments ra WHERE ra.reviewer_id = $1 AND ra.course_offering_id = q.course_offering_id AND ra.is_active)`
      : `q.question_status <> 'DRAFT' AND ${SCOPE_SQL}`;
  const rows = await all(`
    SELECT q.question_type, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_answer, q.model_answer,
           q.difficulty, q.topic, q.subtopic, q.marks, q.answer_data,
           COALESCE(cq.verified_bloom_level, q.bloom_level, q.submitted_bloom_level) AS bloom,
           COALESCE((SELECT array_agg(oc.code ORDER BY (qco.relationship_type = 'primary') DESC, oc.sequence, oc.code)
                       FROM question_course_outcomes qco JOIN course_outcomes oc ON oc.id = qco.course_outcome_id
                      WHERE qco.canonical_question_id = q.canonical_question_id
                        AND (q.syllabus_version_id IS NULL OR oc.syllabus_version_id = q.syllabus_version_id)), q.submitted_cos) AS cos
    FROM questions q
    JOIN course_offerings co ON co.id = q.course_offering_id
    JOIN programs p ON p.id = co.program_id
    LEFT JOIN canonical_questions cq ON cq.id = q.canonical_question_id
    WHERE ${where} AND ($3::uuid IS NULL OR q.course_offering_id = $3::uuid) AND ($4::text IS NULL OR q.question_status = $4::text)
    ORDER BY q.created_at, q.id
    LIMIT $5`, [req.user.id, role, offering, status, EXPORT_LIMIT]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.map(exportRow), { header: SHEET_COLUMNS }), 'Questions');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  await logAudit({ userId: req.user.id, action: 'question_bank_exported', entityId: offering, ip: req.ip,
    details: { role, course_offering_id: offering, status, rows: rows.length, truncated: rows.length === EXPORT_LIMIT } });
  res.setHeader('Content-Disposition', 'attachment; filename=question_bank_export.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

export default router;
