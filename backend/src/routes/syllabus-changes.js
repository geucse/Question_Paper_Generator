// Syllabus versions after approval (phase 4b, migration 042; brain.md §6; PIVOT_SPEC_V2 §9, §14, §38):
//   POST /course-offerings/:id/syllabus-versions/from-current  start a DRAFT version from the ACTIVE one (content copied)
//   GET  /course-offerings/:id/syllabus-tree                    the ACTIVE version's units > topics > subtopics and COs
//   GET  /syllabus-versions/:id/tree                            the same for one version (a question's own version)
//   GET  /syllabus-versions/:id/changes                         what activating the version changed, and the questions it affected
//   GET  /course-offerings/:id/syllabus-changes                 the same for the offering's ACTIVE version (reviewers' screen)
//   GET  /question-mapping                                       the HOD's questions that need a syllabus mapping
//   POST /questions/:id/syllabus-mapping                         map one of them onto the ACTIVE version, with a reason
// Mounted at /api/academic. Every route resolves its object (404), authorizes it through academic-scope.js
// (authorize(), logged; HOD = active hod scope, teacher/reviewer = active assignment in scope; admin never), then
// checks state. Every change is audited.
import express from 'express';
import { get, all, withTransaction } from '../db.js';
import { requireAuth, requireRole } from '../middleware.js';
import { logAudit } from '../audit.js';
import { isUuid, guardOffering, offeringContext } from '../academic-scope.js';
import { SCOPE_SQL } from '../scopes.js';
import { loadSyllabusTree, copySyllabusContent } from '../syllabus-versioning.js';
import { BLOOM_LEVELS } from '../taxonomy.js';

const router = express.Router();
// Bloom levels: the shared definition (taxonomy.js).

async function guardVersion(req, res, id, mode) {
  const version = isUuid(id) ? await get('SELECT * FROM syllabus_versions WHERE id = $1', [id]) : null;
  if (!version) { res.status(404).json({ error: 'Not found' }); return null; }
  const ctx = await guardOffering(req, res, version.course_offering_id, mode);
  return ctx ? { version, ctx } : null;
}

// ---- New version from the current one ----
// The HOD starts the next version from the offering's ACTIVE version: its active units, topics, subtopics and COs
// are copied into a new DRAFT (based_on_version_id), which the HOD then edits. One transaction under the offering
// lock, so two copies never take the same version number.
router.post('/course-offerings/:id/syllabus-versions/from-current', requireAuth, requireRole('hod'), async (req, res) => {
  const ctx = await guardOffering(req, res, req.params.id, 'manage');
  if (!ctx) return;
  const notes = req.body?.notes == null ? null : String(req.body.notes).trim();
  if (notes && notes.length > 20000) return res.status(400).json({ error: 'notes is at most 20000 characters' });
  const out = await withTransaction(async (txn) => {
    const off = await txn.get('SELECT id, syllabus_version_id FROM course_offerings WHERE id = $1 FOR UPDATE', [ctx.course_offering_id]);
    const current = off?.syllabus_version_id
      ? await txn.get("SELECT id, version_number FROM syllabus_versions WHERE id = $1 AND status = 'ACTIVE'", [off.syllabus_version_id]) : null;
    if (!current) return { status: 409, error: 'This offering has no ACTIVE syllabus version to start from: create a new version instead' };
    const next = await txn.get('SELECT COALESCE(MAX(version_number), 0) + 1 AS n FROM syllabus_versions WHERE course_offering_id = $1', [ctx.course_offering_id]);
    const version = await txn.get(`
      INSERT INTO syllabus_versions (course_offering_id, version_number, extracted_units, uploaded_by, based_on_version_id, status)
      VALUES ($1, $2, $3, $4, $5, 'DRAFT') RETURNING *`,
    [ctx.course_offering_id, next.n, JSON.stringify({ notes: notes || `Started from version ${current.version_number}`, units: null }), req.user.id, current.id]);
    const copied = await copySyllabusContent(txn, current.id, version.id, req.user.id);
    await logAudit({ userId: req.user.id, action: 'syllabus_version_created', entityId: version.id, ip: req.ip,
      details: { course_offering_id: ctx.course_offering_id, version_number: version.version_number, status: 'DRAFT', based_on_version_id: current.id, copied } }, txn);
    return { version, copied };
  });
  if (out.status) return res.status(out.status).json({ error: out.error });
  res.status(201).json({ ...out.version, copied: out.copied });
});

// ---- Syllabus trees (the question form's unit > topic > subtopic selects, the reviewer's verification lists) ----
router.get('/course-offerings/:id/syllabus-tree', requireAuth, requireRole('hod', 'teacher', 'reviewer'), async (req, res) => {
  const ctx = await guardOffering(req, res, req.params.id, 'view');
  if (!ctx) return;
  if (!ctx.syllabus_version_id) return res.json({ syllabus_version_id: null, version_number: null, units: [], course_outcomes: [] });
  const v = await get('SELECT id, version_number, status FROM syllabus_versions WHERE id = $1', [ctx.syllabus_version_id]);
  const tree = await loadSyllabusTree({ all }, ctx.syllabus_version_id);
  res.json({ syllabus_version_id: v?.id || ctx.syllabus_version_id, version_number: v?.version_number ?? null, status: v?.status ?? null, units: tree.units, course_outcomes: tree.cos });
});

router.get('/syllabus-versions/:id/tree', requireAuth, requireRole('hod', 'teacher', 'reviewer'), async (req, res) => {
  const g = await guardVersion(req, res, req.params.id, 'view');
  if (!g) return;
  const tree = await loadSyllabusTree({ all }, g.version.id);
  res.json({ syllabus_version_id: g.version.id, version_number: g.version.version_number, status: g.version.status, units: tree.units, course_outcomes: tree.cos });
});

// ---- Change report of one activation ----
// The HOD in scope and the offering's assigned reviewers. Each change lists the questions it made review-required,
// with their current state: resolved once the question is on the new version (mapped or revised), retired, or rejected.
// A reviewer never sees drafts or their own questions here (the lifecycle list's rule).
router.get('/syllabus-versions/:id/changes', requireAuth, requireRole('hod', 'reviewer'), async (req, res) => {
  const g = await guardVersion(req, res, req.params.id, 'view');
  if (!g) return;
  res.json(await changeReport(req, g.version));
});

// The same report for the offering's current (ACTIVE) version: reviewers cannot list versions, so their screen asks by
// offering. { version: null, changes: [] } when the offering has no ACTIVE version.
router.get('/course-offerings/:id/syllabus-changes', requireAuth, requireRole('hod', 'reviewer'), async (req, res) => {
  const ctx = await guardOffering(req, res, req.params.id, 'view');
  if (!ctx) return;
  const version = ctx.syllabus_version_id ? await get('SELECT * FROM syllabus_versions WHERE id = $1', [ctx.syllabus_version_id]) : null;
  if (!version) return res.json({ version: null, previous_version: null, questions_remapped_unchanged: 0, changes: [] });
  res.json(await changeReport(req, version));
});

async function changeReport(req, version) {
  const previous = await get(`SELECT id, version_number, status FROM syllabus_versions
    WHERE id = COALESCE((SELECT old_version_id FROM syllabus_changes WHERE new_version_id = $1 LIMIT 1),
                        (SELECT id FROM syllabus_versions WHERE superseded_by_version_id = $1 LIMIT 1))`, [version.id]);
  const changes = await all(`
    SELECT id, change_type, entity_type, entity_id, old_entity_id, new_entity_id, old_value, new_value, match_rule, detected_at
    FROM syllabus_changes WHERE new_version_id = $1
    ORDER BY array_position(ARRAY['unit','topic','subtopic','course_outcome'], entity_type), change_type, entity_id`, [version.id]);
  const reviewer = req.user.role === 'reviewer';
  const affected = changes.length ? await all(`
    SELECT aq.syllabus_change_id, aq.question_id, aq.impact_type, aq.original_status, aq.new_status AS status_after_detection,
           aq.action_taken, aq.reason, aq.reviewed, aq.review_outcome, aq.reviewed_at,
           q.question_text, q.question_type, q.question_status, q.marks, q.topic, q.subtopic, q.syllabus_version_id, q.course_offering_id,
           (q.submitted_by = $3) AS is_mine,
           (q.syllabus_version_id = $2) AS on_new_version,
           (q.syllabus_version_id = $2 OR q.question_status IN ('RETIRED', 'REJECTED')) AS resolved,
           CASE WHEN q.submitted_by = $3 THEN NULL ELSE u.email END AS author_email
    FROM affected_questions aq
    JOIN questions q ON q.id = aq.question_id
    LEFT JOIN users u ON u.id = q.submitted_by
    WHERE aq.syllabus_change_id = ANY($1::bigint[])
      AND ($4::boolean = FALSE OR (q.question_status <> 'DRAFT' AND q.submitted_by <> $3))
    ORDER BY q.question_status, q.created_at`, [changes.map((c) => c.id), version.id, req.user.id, reviewer]) : [];
  const remapped = await get(`SELECT COUNT(*)::int AS n FROM question_syllabus_remaps WHERE to_version_id = $1 AND kind = 'auto_unchanged'`, [version.id]);
  return {
    version: { id: version.id, course_offering_id: version.course_offering_id, version_number: version.version_number, status: version.status, approved_at: version.approved_at },
    previous_version: previous || null,
    questions_remapped_unchanged: remapped?.n ?? 0,
    changes: changes.map((c) => ({ ...c, affected_questions: affected.filter((a) => String(a.syllabus_change_id) === String(c.id)) })),
  };
}

// ---- Questions that need a syllabus mapping (spec §38: legacy data is mapped by a human, never guessed) ----
// The HOD's questions (SCOPE_SQL: an active hod scope covers the offering), optionally one offering, of three kinds:
//   no_syllabus_version   legacy questions without a syllabus version;
//   superseded_version    questions left on a superseded version (affected by a change, unmapped, or in review then);
//   unverified_mapping    APPROVED / ACTIVE / RETIRED questions on the ACTIVE version without a reviewer-verified topic,
//                         CO or Bloom level (not generation-eligible: question_has_verified_mapping, migration 042).
// REJECTED questions are never listed. Bounded: 200 rows.
const MAPPING_KINDS = ['no_syllabus_version', 'superseded_version', 'unverified_mapping'];
router.get('/question-mapping', requireAuth, requireRole('hod'), async (req, res) => {
  const offering = req.query.course_offering_id ? String(req.query.course_offering_id) : null;
  if (offering) {
    if (!isUuid(offering)) return res.status(400).json({ error: 'course_offering_id is malformed' });
    if (!(await guardOffering(req, res, offering, 'manage'))) return;
  }
  const kind = req.query.kind ? String(req.query.kind) : null;
  if (kind && !MAPPING_KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of: ${MAPPING_KINDS.join(', ')}` });
  const rows = await all(`
    SELECT * FROM (
      SELECT q.id, q.question_text, q.question_type, q.question_status, q.marks, q.difficulty, q.topic, q.subtopic,
             q.course_offering_id, co.offering_code, s.subject_code, s.course_title,
             q.syllabus_version_id, sv.version_number, sv.status AS version_status,
             co.syllabus_version_id AS current_version_id, cur.version_number AS current_version_number,
             CASE WHEN q.syllabus_version_id IS NULL THEN 'no_syllabus_version'
                  WHEN sv.status = 'SUPERSEDED' THEN 'superseded_version'
                  ELSE 'unverified_mapping' END AS kind,
             EXISTS (SELECT 1 FROM review_batch_items rbi JOIN review_batches rb ON rb.id = rbi.review_batch_id
                      WHERE rbi.question_id = q.id AND rbi.outcome IS NULL AND rb.status <> 'cancelled') AS in_review_round,
             (SELECT json_agg(json_build_object('change_type', sc.change_type, 'entity_type', sc.entity_type, 'entity_id', sc.entity_id) ORDER BY sc.id)
                FROM affected_questions aq JOIN syllabus_changes sc ON sc.id = aq.syllabus_change_id
               WHERE aq.question_id = q.id AND sc.new_version_id = co.syllabus_version_id) AS syllabus_changes,
             q.created_at
      FROM questions q
      JOIN course_offerings co ON co.id = q.course_offering_id
      JOIN programs p ON p.id = co.program_id
      LEFT JOIN subjects s ON s.id = q.subject_id
      LEFT JOIN syllabus_versions sv ON sv.id = q.syllabus_version_id
      LEFT JOIN syllabus_versions cur ON cur.id = co.syllabus_version_id
      WHERE ${SCOPE_SQL} AND ($3::uuid IS NULL OR q.course_offering_id = $3::uuid) AND q.question_status <> 'REJECTED'
        AND (q.syllabus_version_id IS NULL OR sv.status = 'SUPERSEDED'
             OR (sv.status = 'ACTIVE' AND q.question_status IN ('APPROVED', 'ACTIVE', 'RETIRED') AND NOT question_has_verified_mapping(q.id)))
    ) x
    WHERE ($4::text IS NULL OR x.kind = $4::text)
    ORDER BY x.offering_code NULLS LAST, x.kind, x.created_at
    LIMIT 200`, [req.user.id, 'hod', offering, kind]);
  res.json({ questions: rows, kinds: MAPPING_KINDS });
});

// ---- Map one question onto its offering's ACTIVE version ----
// The HOD in scope sets the question's syllabus version and the verified unit, topic, subtopic and COs (and, when the
// question has none yet or the HOD corrects it, the verified Bloom level), all from that version, with a reason
// (>= 10 characters). Refused for a question in an open review round (its reviewers decide first), for an editable
// one (the author re-maps it by editing: the form uses the current syllabus), for REJECTED ones, and for a question
// whose canonical record another live question shares. A locked question moves through the 042 re-mapping hatch.
const MAPPABLE = ['SUBMITTED', 'RESUBMITTED', 'APPROVED', 'ACTIVE', 'RETIRED'];
const httpErr = (status, body) => Object.assign(new Error(body.error), { status, body });

router.post('/questions/:id/syllabus-mapping', requireAuth, requireRole('hod'), async (req, res) => {
  const b = req.body || {};
  const reason = String(b.reason || '').trim();
  const ids = { unit: b.syllabus_unit_id || null, topic: b.syllabus_topic_id || null, subtopic: b.syllabus_subtopic_id || null, primary: b.primary_course_outcome_id || null };
  const secondary = Array.isArray(b.secondary_course_outcome_ids) ? [...new Set(b.secondary_course_outcome_ids.filter(Boolean))] : [];
  const q = isUuid(req.params.id) ? await get('SELECT id, course_offering_id, question_status, canonical_question_id, syllabus_version_id, subtopic_id FROM questions WHERE id = $1', [req.params.id]) : null;
  if (!q) return res.status(404).json({ error: 'Question not found' });
  const ctx = await guardOffering(req, res, q.course_offering_id, 'manage');
  if (!ctx) return;

  if (reason.length < 10 || reason.length > 1000) return res.status(400).json({ error: 'A reason of 10 to 1000 characters is required to map a question' });
  if (!ids.topic || !ids.primary) return res.status(400).json({ error: 'syllabus_topic_id and primary_course_outcome_id are required' });
  if ([ids.unit, ids.topic, ids.subtopic, ids.primary, ...secondary].some((v) => v && !isUuid(v))) return res.status(400).json({ error: 'Syllabus ids must be valid ids' });
  if (b.bloom_level != null && b.bloom_level !== '' && !BLOOM_LEVELS.includes(b.bloom_level)) {
    return res.status(400).json({ error: `bloom_level must be one of: ${BLOOM_LEVELS.join(', ')}` });
  }
  if (!MAPPABLE.includes(q.question_status)) {
    return res.status(409).json({ error: ['DRAFT', 'CHANGES_REQUESTED'].includes(q.question_status)
      ? 'The author re-maps an editable question by editing it (the question form uses the current syllabus)'
      : `A ${q.question_status} question cannot be mapped`, question_status: q.question_status });
  }
  if (!q.canonical_question_id) return res.status(409).json({ error: 'This question has no canonical record yet; it is mapped when it is submitted' });
  const off = await offeringContext(q.course_offering_id);
  const versionId = off?.syllabus_version_id;
  const target = versionId ? await get("SELECT id, version_number FROM syllabus_versions WHERE id = $1 AND status = 'ACTIVE'", [versionId]) : null;
  if (!target) return res.status(409).json({ error: 'This offering has no ACTIVE syllabus version to map onto' });

  // Every id must belong to the target version (and to each other).
  const topic = await get(`SELECT t.id, t.title, u.id AS unit_id FROM syllabus_topics t JOIN syllabus_units u ON u.id = t.syllabus_unit_id
    WHERE t.id = $1 AND u.syllabus_version_id = $2 AND t.is_active AND u.is_active`, [ids.topic, target.id]);
  if (!topic) return res.status(400).json({ error: 'That topic is not part of the offering\'s ACTIVE syllabus version' });
  if (ids.unit && ids.unit !== topic.unit_id) return res.status(400).json({ error: 'That unit does not contain the chosen topic' });
  const sub = ids.subtopic ? await get('SELECT id, title FROM syllabus_subtopics WHERE id = $1 AND syllabus_topic_id = $2 AND is_active', [ids.subtopic, topic.id]) : null;
  if (ids.subtopic && !sub) return res.status(400).json({ error: 'That subtopic is not under the chosen topic' });
  const coIds = [ids.primary, ...secondary.filter((id) => id !== ids.primary)];
  const cos = await all('SELECT id, code FROM course_outcomes WHERE id = ANY($1::uuid[]) AND syllabus_version_id = $2 AND is_active', [coIds, target.id]);
  if (cos.length !== coIds.length) return res.status(400).json({ error: 'Course outcome(s) are not part of the offering\'s ACTIVE syllabus version' });

  let out;
  try {
    out = await withTransaction(async (txn) => {
      const locked = await txn.get('SELECT id, question_status, syllabus_version_id, subtopic_id, canonical_question_id FROM questions WHERE id = $1 FOR UPDATE', [q.id]);
      if (!locked || locked.question_status !== q.question_status || locked.canonical_question_id !== q.canonical_question_id) {
        throw httpErr(409, { error: 'This question changed meanwhile; reload and try again' });
      }
      const round = await txn.get(`SELECT 1 AS x FROM review_batch_items rbi JOIN review_batches rb ON rb.id = rbi.review_batch_id
        WHERE rbi.question_id = $1 AND rbi.outcome IS NULL AND rb.status <> 'cancelled'`, [q.id]);
      if (round) throw httpErr(409, { error: 'This question is in an open review round: its reviewers decide first' });
      const shared = await txn.get(`SELECT 1 AS x FROM questions WHERE canonical_question_id = $1 AND id <> $2 AND question_status <> 'REJECTED'`, [q.canonical_question_id, q.id]);
      if (shared) throw httpErr(409, { error: 'This question shares its canonical record with another question; map it through a re-review instead' });
      const cq = await txn.get(`SELECT verified_syllabus_unit_id, verified_syllabus_topic_id, verified_syllabus_subtopic_id, verified_bloom_level
        FROM canonical_questions WHERE id = $1 FOR UPDATE`, [q.canonical_question_id]);
      const oldCos = await txn.all(`SELECT qco.course_outcome_id, qco.relationship_type, qco.verified_by, oc.syllabus_version_id
        FROM question_course_outcomes qco JOIN course_outcomes oc ON oc.id = qco.course_outcome_id WHERE qco.canonical_question_id = $1`, [q.canonical_question_id]);
      const bloom = b.bloom_level || null;
      if (!bloom && !cq.verified_bloom_level) throw httpErr(400, { error: 'This question has no reviewer-verified Bloom level: choose one (bloom_level)' });

      await txn.get("SELECT set_config('app.syllabus_remap', 'on', true)");
      await txn.run('UPDATE questions SET syllabus_version_id = $1, subtopic_id = $2 WHERE id = $3', [target.id, sub?.id || null, q.id]);
      await txn.run(`UPDATE canonical_questions SET verified_syllabus_unit_id = $1, verified_syllabus_topic_id = $2, verified_syllabus_subtopic_id = $3,
          verified_bloom_level = COALESCE($4, verified_bloom_level), verified_by = $5, verified_at = now(), verified_by_reviewer_ids = NULL,
          quality_status = 'human_verified', updated_at = now()
        WHERE id = $6`, [topic.unit_id, topic.id, sub?.id || null, bloom, req.user.id, q.canonical_question_id]);
      // The mapping to the target version's COs is replaced; mappings to other versions' COs stay as history.
      await txn.run(`DELETE FROM question_course_outcomes WHERE canonical_question_id = $1
        AND course_outcome_id IN (SELECT id FROM course_outcomes WHERE syllabus_version_id = $2)`, [q.canonical_question_id, target.id]);
      for (const [i, coId] of coIds.entries()) {
        await txn.run(`INSERT INTO question_course_outcomes (canonical_question_id, course_outcome_id, relationship_type, source, verified_by, verified_at)
          VALUES ($1, $2, $3, 'hod_mapping', $4, now())`, [q.canonical_question_id, coId, i === 0 ? 'primary' : 'secondary', req.user.id]);
      }
      const oldMapping = { syllabus_version_id: locked.syllabus_version_id, subtopic_id: locked.subtopic_id, unit_id: cq.verified_syllabus_unit_id,
        topic_id: cq.verified_syllabus_topic_id, verified_subtopic_id: cq.verified_syllabus_subtopic_id, bloom_level: cq.verified_bloom_level,
        course_outcomes: oldCos.map((c) => ({ id: c.course_outcome_id, relationship_type: c.relationship_type, syllabus_version_id: c.syllabus_version_id, verified: !!c.verified_by })) };
      const newMapping = { syllabus_version_id: target.id, subtopic_id: sub?.id || null, unit_id: topic.unit_id, topic_id: topic.id, verified_subtopic_id: sub?.id || null,
        bloom_level: bloom || cq.verified_bloom_level, course_outcomes: coIds.map((id, i) => ({ id, relationship_type: i === 0 ? 'primary' : 'secondary' })) };
      await txn.run(`INSERT INTO question_syllabus_remaps (question_id, from_version_id, to_version_id, kind, old_mapping, new_mapping, reason, performed_by)
        VALUES ($1, $2, $3, 'hod_mapping', $4::jsonb, $5::jsonb, $6, $7)`, [q.id, locked.syllabus_version_id, target.id, JSON.stringify(oldMapping), JSON.stringify(newMapping), reason, req.user.id]);
      const resolved = await txn.run(`UPDATE affected_questions SET reviewed = TRUE, review_outcome = 'remapped', reviewed_by = $2, reviewed_at = now()
        WHERE question_id = $1 AND reviewed IS NOT TRUE RETURNING id`, [q.id, req.user.id]);
      const eligible = await txn.get('SELECT question_has_verified_mapping($1) AS ok', [q.id]);
      await logAudit({ userId: req.user.id, action: 'question_syllabus_mapped', entityId: q.id, ip: req.ip,
        details: { question_status: locked.question_status, reason, old: oldMapping, new: newMapping, affected_rows_resolved: resolved.rowCount } }, txn);
      return { eligible: eligible?.ok === true, version: target };
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json(e.body);
    if (/subtopic is not part|re-mapping moves|content is locked/.test(String(e.message))) return res.status(409).json({ error: e.message });
    throw e;
  }
  res.json({ ok: true, syllabus_version_id: out.version.id, version_number: out.version.version_number, generation_eligible: out.eligible });
});

export default router;
