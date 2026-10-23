// Syllabus versioning (brain.md §6; PIVOT_SPEC_V2 §9, §14, §39.5; migration 042).
//
// Lifecycle: DRAFT -> TEACHER_VERIFIED -> HOD_REVIEW -> ACTIVE -> SUPERSEDED; REJECTED from any state before ACTIVE.
// The DB guard (trg_guard_syllabus_version) checks every transition; routes/academic.js adds roles, scope and reasons.
// Content (units, topics, subtopics, COs) changes only while a version is DRAFT (trg_guard_syllabus_content).
//
// Activation (activateSyllabusVersion) is one transaction: the previous ACTIVE version becomes SUPERSEDED, the new one
// ACTIVE, the offering points at it, the two versions are compared (diffSyllabus) and every question of the previous
// version is classified (classifyQuestion):
//   unchanged  every item it maps to (unit, topic, subtopic, COs) is UNCHANGED: re-mapped to the new version
//              (question_syllabus_remaps 'auto_unchanged', audited); it also stays eligible for examinations already
//              created on the previous version (exam-generator.js). Not moved (left for the HOD's mapping): a question
//              in an open review round (its reviewers verify against the version they started on) or one whose
//              canonical record another live question shares;
//   affected   an item it maps to was REMOVED, MODIFIED or RENAMED: an affected_questions row per change, and
//                APPROVED          -> CHANGES_REQUESTED with the reason (the lifecycle transition, audited);
//                ACTIVE / RETIRED  -> flagged only: the content is locked and examinations already created on the
//                                     previous version may still use it; it is not eligible for the new version
//                                     (it stays on the old one) until the HOD maps it, a reviewer requests changes,
//                                     or the HOD retires it;
//                other states      -> flagged: the author re-maps it when revising (DRAFT / CHANGES_REQUESTED), or
//                                     its reviewers see the flag (SUBMITTED / RESUBMITTED / UNDER_REVIEW);
//   unmapped   no topic of the previous version can be identified: left on the previous version; it appears in the
//              HOD's question-mapping list (routes/syllabus-changes.js).
//
// Matching rule between the two versions (norm(): case-, width- and whitespace-insensitive). Ordering (sequence) is
// presentation only and never a change. A key that is not unique on either side never matches.
//   unit     same code: same title = UNCHANGED, else RENAMED;  else same title (code changed) = RENAMED
//   CO       same code: same description = UNCHANGED, else MODIFIED (the outcome itself changed);
//            else same description (renumbered) = RENAMED
//   topic    same title under the matched unit = UNCHANGED;  else same title under another unit = MODIFIED (moved)
//   subtopic same title under the matched topic = UNCHANGED; else same title under another topic = MODIFIED (moved)
//   leftovers: previous version = REMOVED, new version = ADDED.
// Topics and subtopics have no code, so a retitled topic is REMOVED + ADDED: the system never guesses that two
// differently named topics are the same (spec: never guess missing academic information).

export const norm = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

// Pair items of two lists in passes; each pass matches an item when its key is unique among the remaining items
// on BOTH sides. A pass is a key function, or { old, neu } when the two sides compute their key differently.
// Returns { pairs: [{ old, neu, pass }], oldLeft, newLeft }.
export function pairUp(oldItems, newItems, passes) {
  let oldLeft = [...oldItems];
  let newLeft = [...newItems];
  const pairs = [];
  passes.forEach((p, pass) => {
    const keyOld = typeof p === 'function' ? p : p.old;
    const keyNew = typeof p === 'function' ? p : p.neu;
    const index = (items, keyFn) => {
      const m = new Map(); const dup = new Set();
      for (const it of items) {
        const k = keyFn(it);
        if (!k) continue;
        if (m.has(k)) dup.add(k); else m.set(k, it);
      }
      for (const k of dup) m.delete(k);
      return m;
    };
    const oi = index(oldLeft, keyOld); const ni = index(newLeft, keyNew);
    const matchedOld = new Set(); const matchedNew = new Set();
    for (const [k, o] of oi) {
      const n = ni.get(k);
      if (n) { pairs.push({ old: o, neu: n, pass }); matchedOld.add(o); matchedNew.add(n); }
    }
    oldLeft = oldLeft.filter((o) => !matchedOld.has(o));
    newLeft = newLeft.filter((n) => !matchedNew.has(n));
  });
  return { pairs, oldLeft, newLeft };
}

// tree: { units: [{ id, code, title, topics: [{ id, title, subtopics: [{ id, title }] }] }], cos: [{ id, code, description }] }
// (active items only). Returns { changes, status } where status[entity] maps an id of the previous version to
// { type: 'UNCHANGED' | 'RENAMED' | 'MODIFIED' | 'REMOVED', newId, change } (change = index into changes).
export function diffSyllabus(prev, next) {
  const changes = [];
  const status = { unit: new Map(), topic: new Map(), subtopic: new Map(), course_outcome: new Map() };
  const record = (entity_type, change_type, { o = null, n = null, key, rule, oldValue = null, newValue = null }) => {
    changes.push({ entity_type, change_type, entity_id: key, old_entity_id: o?.id ?? null, new_entity_id: n?.id ?? null,
      old_value: oldValue, new_value: newValue, match_rule: rule });
    return changes.length - 1;
  };
  const set = (entity, o, type, n, change = null) => status[entity].set(o.id, { type, newId: n?.id ?? null, change });

  // Units
  const unitVal = (u) => ({ code: u.code, title: u.title });
  const units = pairUp(prev.units, next.units, [(u) => norm(u.code), (u) => norm(u.title)]);
  for (const { old: o, neu: n, pass } of units.pairs) {
    if (pass === 0 && norm(o.title) === norm(n.title)) set('unit', o, 'UNCHANGED', n);
    else {
      set('unit', o, 'RENAMED', n, record('unit', 'RENAMED', { o, n, key: n.code, oldValue: unitVal(o), newValue: unitVal(n),
        rule: pass === 0 ? 'same code, different title' : 'same title, different code' }));
    }
  }
  for (const o of units.oldLeft) set('unit', o, 'REMOVED', null, record('unit', 'REMOVED', { o, key: o.code, oldValue: unitVal(o), rule: 'no unit with the same code or title' }));
  for (const n of units.newLeft) record('unit', 'ADDED', { n, key: n.code, newValue: unitVal(n), rule: 'no unit with the same code or title' });

  // Topics: under the matched unit first, then anywhere (moved).
  const unitOf = new Map(); const nextUnitCode = new Map(next.units.map((u) => [u.id, u.code]));
  const prevTopics = prev.units.flatMap((u) => (u.topics || []).map((t) => ({ ...t, unit: u })));
  const nextTopics = next.units.flatMap((u) => (u.topics || []).map((t) => ({ ...t, unit: u })));
  prevTopics.forEach((t) => unitOf.set(t.id, t.unit.id));
  const topicVal = (t) => ({ title: t.title, unit_code: t.unit.code });
  const topics = pairUp(prevTopics, nextTopics, [
    { old: (t) => { const nu = status.unit.get(t.unit.id)?.newId; return nu ? `${nu}|${norm(t.title)}` : null; },
      neu: (t) => `${t.unit.id}|${norm(t.title)}` },
    (t) => norm(t.title),
  ]);
  for (const { old: o, neu: n, pass } of topics.pairs) {
    if (pass === 0) set('topic', o, 'UNCHANGED', n);
    else {
      set('topic', o, 'MODIFIED', n, record('topic', 'MODIFIED', { o, n, key: n.title, oldValue: topicVal(o), newValue: topicVal(n),
        rule: `same title, moved from unit ${o.unit.code} to unit ${nextUnitCode.get(n.unit.id)}` }));
    }
  }
  for (const o of topics.oldLeft) set('topic', o, 'REMOVED', null, record('topic', 'REMOVED', { o, key: o.title, oldValue: topicVal(o), rule: 'no topic with the same title' }));
  for (const n of topics.newLeft) record('topic', 'ADDED', { n, key: n.title, newValue: topicVal(n), rule: 'no topic with the same title' });

  // Subtopics: under the matched topic first, then anywhere (moved).
  const prevSubs = prevTopics.flatMap((t) => (t.subtopics || []).map((s) => ({ ...s, topic: t })));
  const nextSubs = nextTopics.flatMap((t) => (t.subtopics || []).map((s) => ({ ...s, topic: t })));
  const subVal = (s) => ({ title: s.title, topic_title: s.topic.title });
  const subs = pairUp(prevSubs, nextSubs, [
    { old: (s) => { const nt = status.topic.get(s.topic.id)?.newId; return nt ? `${nt}|${norm(s.title)}` : null; },
      neu: (s) => `${s.topic.id}|${norm(s.title)}` },
    (s) => norm(s.title),
  ]);
  for (const { old: o, neu: n, pass } of subs.pairs) {
    if (pass === 0) set('subtopic', o, 'UNCHANGED', n);
    else {
      set('subtopic', o, 'MODIFIED', n, record('subtopic', 'MODIFIED', { o, n, key: n.title, oldValue: subVal(o), newValue: subVal(n),
        rule: `same title, moved from topic "${o.topic.title}" to topic "${n.topic.title}"` }));
    }
  }
  for (const o of subs.oldLeft) set('subtopic', o, 'REMOVED', null, record('subtopic', 'REMOVED', { o, key: o.title, oldValue: subVal(o), rule: 'no subtopic with the same title' }));
  for (const n of subs.newLeft) record('subtopic', 'ADDED', { n, key: n.title, newValue: subVal(n), rule: 'no subtopic with the same title' });

  // Course outcomes
  const coVal = (c) => ({ code: c.code, description: c.description });
  const cos = pairUp(prev.cos, next.cos, [(c) => norm(c.code), (c) => norm(c.description)]);
  for (const { old: o, neu: n, pass } of cos.pairs) {
    if (pass === 0 && norm(o.description) === norm(n.description)) set('course_outcome', o, 'UNCHANGED', n);
    else if (pass === 0) {
      set('course_outcome', o, 'MODIFIED', n, record('course_outcome', 'MODIFIED', { o, n, key: n.code, oldValue: coVal(o), newValue: coVal(n), rule: 'same code, different description' }));
    } else {
      set('course_outcome', o, 'RENAMED', n, record('course_outcome', 'RENAMED', { o, n, key: n.code, oldValue: coVal(o), newValue: coVal(n), rule: 'same description, different code' }));
    }
  }
  for (const o of cos.oldLeft) set('course_outcome', o, 'REMOVED', null, record('course_outcome', 'REMOVED', { o, key: o.code, oldValue: coVal(o), rule: 'no CO with the same code or description' }));
  for (const n of cos.newLeft) record('course_outcome', 'ADDED', { n, key: n.code, newValue: coVal(n), rule: 'no CO with the same code or description' });

  return { changes, status, unitOfTopic: unitOf };
}

// mapping: ids of the PREVIOUS version { unitId?, topicId, subtopicId?, coIds: [] }. Returns
//   { kind: 'unmapped' }                                    no topic, or an item not among the previous version's active items
//   { kind: 'unchanged', mapping: { unitId, topicId, subtopicId, coIds } }   ids of the NEW version
//   { kind: 'affected', changes: [change indexes] }
export function classifyQuestion(mapping, diff) {
  if (!mapping?.topicId) return { kind: 'unmapped' };
  const unitId = mapping.unitId || diff.unitOfTopic.get(mapping.topicId) || null;
  const items = [['unit', unitId], ['topic', mapping.topicId]];
  if (mapping.subtopicId) items.push(['subtopic', mapping.subtopicId]);
  for (const id of mapping.coIds || []) items.push(['course_outcome', id]);
  const affecting = new Set();
  const next = {};
  for (const [entity, id] of items) {
    const s = id ? diff.status[entity].get(id) : null;
    if (!s) return { kind: 'unmapped' };
    if (s.type === 'UNCHANGED') {
      if (entity === 'course_outcome') (next.coIds ||= []).push(s.newId);
      else next[`${entity}Id`] = s.newId;
    } else affecting.add(s.change);
  }
  if (affecting.size) return { kind: 'affected', changes: [...affecting].sort((a, b) => a - b) };
  return { kind: 'unchanged', mapping: { unitId: next.unitId, topicId: next.topicId, subtopicId: next.subtopicId || null, coIds: next.coIds || [] } };
}

// Human summary of the changes that affect a question (stored as its change-request reason and on its flag).
export function describeChanges(changes, versionNumber) {
  const label = { unit: 'unit', topic: 'topic', subtopic: 'subtopic', course_outcome: 'CO' };
  const parts = changes.map((c) => `${label[c.entity_type]} "${c.entity_id}" ${c.change_type.toLowerCase()}`);
  const text = `Syllabus version ${versionNumber} changed (${parts.join('; ')}): re-map the question to the current syllabus and resubmit it`;
  return text.length > 1000 ? `${text.slice(0, 997)}...` : text;
}

// ---------------------------------------------------------------------------------------------------------------
// Database helpers. Every function takes the caller's transaction handle ({ get, all, run }).
// ---------------------------------------------------------------------------------------------------------------

// The active content of one version as a tree (diffSyllabus input; also the question form's selects).
export async function loadSyllabusTree(db, versionId) {
  const units = await db.all(`SELECT id, code, title, sequence FROM syllabus_units WHERE syllabus_version_id = $1 AND is_active ORDER BY sequence, code`, [versionId]);
  const topics = await db.all(`SELECT t.id, t.title, t.sequence, t.syllabus_unit_id FROM syllabus_topics t JOIN syllabus_units u ON u.id = t.syllabus_unit_id
    WHERE u.syllabus_version_id = $1 AND t.is_active AND u.is_active ORDER BY t.sequence, t.title`, [versionId]);
  const subtopics = await db.all(`SELECT st.id, st.title, st.sort_order, st.syllabus_topic_id FROM syllabus_subtopics st
    JOIN syllabus_topics t ON t.id = st.syllabus_topic_id JOIN syllabus_units u ON u.id = t.syllabus_unit_id
    WHERE u.syllabus_version_id = $1 AND st.is_active AND t.is_active AND u.is_active ORDER BY st.sort_order, st.title`, [versionId]);
  const cos = await db.all(`SELECT id, code, description, sequence FROM course_outcomes WHERE syllabus_version_id = $1 AND is_active ORDER BY sequence, code`, [versionId]);
  return {
    units: units.map((u) => ({ ...u, topics: topics.filter((t) => t.syllabus_unit_id === u.id)
      .map((t) => ({ id: t.id, title: t.title, sequence: t.sequence, subtopics: subtopics.filter((s) => s.syllabus_topic_id === t.id).map((s) => ({ id: s.id, title: s.title, sort_order: s.sort_order })) })) })),
    cos,
  };
}

// A teacher's (or a spreadsheet row's) topic / subtopic, checked against one syllabus version. Input: topicId or topic
// title, subtopicId or subtopic title. Titles match case-insensitively; the stored values use the syllabus spelling.
// A version without any topic (legacy) accepts a free-text topic and no subtopic.
// Returns { ok: true, topic, topicId, subtopic, subtopicId } or { ok: false, error }.
export async function resolvePlacement(db, versionId, { topicId = null, topic = null, subtopicId = null, subtopic = null }) {
  const topicText = topic == null ? '' : String(topic).trim();
  const subText = subtopic == null ? '' : String(subtopic).trim();
  if (!topicId && !topicText) {
    if (subtopicId || subText) return { ok: false, error: 'Choose the topic before the subtopic' };
    return { ok: true, topic: null, topicId: null, subtopic: null, subtopicId: null };
  }
  if (topicText.length > 200 || subText.length > 200) return { ok: false, error: 'Topic and subtopic are at most 200 characters' };
  if (!versionId) {
    if (topicId || subtopicId || subText) return { ok: false, error: 'This course offering has no active syllabus version: a subtopic cannot be chosen yet' };
    return { ok: true, topic: topicText, topicId: null, subtopic: null, subtopicId: null };
  }
  const topics = await db.all(`SELECT t.id, t.title FROM syllabus_topics t JOIN syllabus_units u ON u.id = t.syllabus_unit_id
    WHERE u.syllabus_version_id = $1 AND t.is_active AND u.is_active`, [versionId]);
  let t = null;
  if (topicId) {
    t = topics.find((x) => x.id === topicId);
    if (!t) return { ok: false, error: 'That topic is not part of the current syllabus' };
  } else {
    if (topics.length === 0) {
      if (subText) return { ok: false, error: 'The current syllabus has no topics: a subtopic cannot be chosen' };
      return { ok: true, topic: topicText, topicId: null, subtopic: null, subtopicId: null };
    }
    const hits = topics.filter((x) => norm(x.title) === norm(topicText));
    if (hits.length === 0) return { ok: false, error: `Topic '${topicText}' is not part of the current syllabus` };
    if (hits.length > 1) return { ok: false, error: `Topic '${topicText}' appears in more than one unit: choose it from the list` };
    t = hits[0];
  }
  if (!subtopicId && !subText) return { ok: true, topic: t.title, topicId: t.id, subtopic: null, subtopicId: null };
  const subs = await db.all('SELECT id, title FROM syllabus_subtopics WHERE syllabus_topic_id = $1 AND is_active', [t.id]);
  const s = subtopicId ? subs.find((x) => x.id === subtopicId) : subs.find((x) => norm(x.title) === norm(subText));
  if (!s) return { ok: false, error: `Subtopic '${subText || 'chosen'}' is not under topic '${t.title}' in the current syllabus` };
  return { ok: true, topic: t.title, topicId: t.id, subtopic: s.title, subtopicId: s.id };
}

// Copy the active content of `fromVersionId` into the DRAFT `toVersionId` (units -> topics -> subtopics, COs).
export async function copySyllabusContent(db, fromVersionId, toVersionId, actorId) {
  const tree = await loadSyllabusTree(db, fromVersionId);
  const counts = { units: 0, topics: 0, subtopics: 0, cos: 0 };
  for (const u of tree.units) {
    const nu = await db.get('INSERT INTO syllabus_units (syllabus_version_id, code, title, sequence) VALUES ($1, $2, $3, $4) RETURNING id',
      [toVersionId, u.code, u.title, u.sequence ?? 0]);
    counts.units++;
    for (const t of u.topics) {
      const nt = await db.get('INSERT INTO syllabus_topics (syllabus_unit_id, title, sequence) VALUES ($1, $2, $3) RETURNING id', [nu.id, t.title, t.sequence ?? 0]);
      counts.topics++;
      for (const s of t.subtopics) {
        await db.run('INSERT INTO syllabus_subtopics (syllabus_topic_id, title, sort_order, created_by) VALUES ($1, $2, $3, $4)', [nt.id, s.title, s.sort_order ?? 0, actorId]);
        counts.subtopics++;
      }
    }
  }
  for (const c of tree.cos) {
    await db.run('INSERT INTO course_outcomes (syllabus_version_id, code, description, sequence) VALUES ($1, $2, $3, $4)', [toVersionId, c.code, c.description, c.sequence ?? 0]);
    counts.cos++;
  }
  return counts;
}

// Questions of the previous version with what they map to there. Topic: the reviewer-verified one, else the
// teacher's title when it names exactly one topic of that version. Subtopic: verified, else subtopic_id, else the
// title under the topic. COs: every mapping of the canonical record to a CO of that version.
const PREVIOUS_VERSION_QUESTIONS_SQL = `
  SELECT q.id, q.question_status, q.submitted_by, q.canonical_question_id, q.topic, q.subtopic, q.subtopic_id,
         cq.verified_syllabus_unit_id, cq.verified_syllabus_topic_id, cq.verified_syllabus_subtopic_id,
         COALESCE((SELECT array_agg(qco.course_outcome_id ORDER BY qco.course_outcome_id) FROM question_course_outcomes qco
                    JOIN course_outcomes oc ON oc.id = qco.course_outcome_id
                   WHERE qco.canonical_question_id = q.canonical_question_id AND oc.syllabus_version_id = $2), '{}') AS co_ids,
         (q.canonical_question_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM questions o WHERE o.canonical_question_id = q.canonical_question_id AND o.id <> q.id
               AND o.question_status <> 'REJECTED')) AS canonical_shared,
         EXISTS (SELECT 1 FROM review_batch_items rbi JOIN review_batches rb ON rb.id = rbi.review_batch_id
                  WHERE rbi.question_id = q.id AND rbi.outcome IS NULL AND rb.status <> 'cancelled') AS in_review_round
  FROM questions q
  LEFT JOIN canonical_questions cq ON cq.id = q.canonical_question_id
  WHERE q.course_offering_id = $1 AND q.syllabus_version_id = $2 AND q.question_status <> 'REJECTED'
  ORDER BY q.created_at, q.id`;

export function questionMapping(q, tree) {
  const topics = tree.units.flatMap((u) => u.topics.map((t) => ({ ...t, unitId: u.id })));
  let topic = q.verified_syllabus_topic_id ? topics.find((t) => t.id === q.verified_syllabus_topic_id) : null;
  if (!topic && !q.verified_syllabus_topic_id && q.topic) {
    const hits = topics.filter((t) => norm(t.title) === norm(q.topic));
    if (hits.length === 1) [topic] = hits;
  }
  if (!topic) return null;
  let subtopicId = q.verified_syllabus_subtopic_id || q.subtopic_id || null;
  if (!subtopicId && q.subtopic && String(q.subtopic).trim()) {
    const hits = topic.subtopics.filter((s) => norm(s.title) === norm(q.subtopic));
    subtopicId = hits.length === 1 ? hits[0].id : 'unknown';
  }
  return { unitId: q.verified_syllabus_unit_id || topic.unitId, topicId: topic.id, subtopicId, coIds: q.co_ids || [] };
}

const remapErr = (status, message) => Object.assign(new Error(message), { status });

// Activate a HOD_REVIEW version (POST /academic/syllabus-versions/:id/approve). Must run inside withTransaction; audit
// rows are appended last. Throws { status } errors for refusals. Returns a summary for the response and notifications.
export async function activateSyllabusVersion(txn, { versionId, actor, ip, logAudit }) {
  const version = await txn.get('SELECT * FROM syllabus_versions WHERE id = $1', [versionId]);
  const offering = await txn.get('SELECT id, syllabus_version_id FROM course_offerings WHERE id = $1 FOR UPDATE', [version.course_offering_id]);
  // Re-checked under the offering lock: two concurrent approvals cannot both switch it.
  const locked = await txn.get("SELECT id, version_number, verified_by FROM syllabus_versions WHERE id = $1 AND status = 'HOD_REVIEW' FOR UPDATE", [versionId]);
  if (!locked) throw remapErr(409, 'This syllabus version was decided meanwhile; reload and try again');
  const problems = (await txn.get('SELECT syllabus_version_content_problems($1) AS problems', [versionId]))?.problems || [];
  if (problems.length) throw remapErr(400, `This syllabus version is incomplete: it needs ${problems.join(' and ')}`);

  const prevId = offering.syllabus_version_id && offering.syllabus_version_id !== versionId ? offering.syllabus_version_id : null;
  const prev = prevId ? await txn.get("SELECT id, version_number FROM syllabus_versions WHERE id = $1 AND status = 'ACTIVE' FOR UPDATE", [prevId]) : null;

  const summary = { previous_version_id: prev?.id || null, changes: [], remapped: [], sent_back: [], flagged: [], unmapped: [], skipped: [] };
  let diff = null; let questions = []; let nextTree = null;
  if (prev) {
    const prevTree = await loadSyllabusTree(txn, prev.id);
    nextTree = await loadSyllabusTree(txn, versionId);
    diff = diffSyllabus(prevTree, nextTree);
    questions = (await txn.all(PREVIOUS_VERSION_QUESTIONS_SQL, [version.course_offering_id, prev.id])).map((q) => ({ ...q, mapping: questionMapping(q, prevTree) }));
    await txn.run(`UPDATE syllabus_versions SET status = 'SUPERSEDED', superseded_by_version_id = $1, updated_at = now() WHERE id = $2`, [versionId, prev.id]);
  }
  await txn.run(`UPDATE syllabus_versions SET status = 'ACTIVE', approved_by = $1, updated_at = now() WHERE id = $2`, [actor.id, versionId]);
  await txn.run('UPDATE course_offerings SET syllabus_version_id = $1, updated_at = now() WHERE id = $2', [versionId, version.course_offering_id]);

  if (diff) {
    const changeIds = [];
    for (const c of diff.changes) {
      const row = await txn.get(`
        INSERT INTO syllabus_changes (old_version_id, new_version_id, change_type, entity_type, entity_id, old_entity_id, new_entity_id,
          old_value, new_value, match_rule, detected_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11) RETURNING id`,
      [prev.id, versionId, c.change_type, c.entity_type, c.entity_id, c.old_entity_id, c.new_entity_id,
        c.old_value ? JSON.stringify(c.old_value) : null, c.new_value ? JSON.stringify(c.new_value) : null, c.match_rule, actor.id]);
      changeIds.push(row.id);
      summary.changes.push({ id: row.id, ...c });
    }

    let remapOn = false;
    for (const q of questions) {
      const result = q.mapping ? classifyQuestion(q.mapping, diff) : { kind: 'unmapped' };
      if (result.kind === 'unmapped') { summary.unmapped.push(q.id); continue; }
      if (result.kind === 'unchanged') {
        // Not moved: a canonical record another live question shares would carry this question's new mapping to
        // it; and reviewers of an open round verify against the version they started on (their verdicts name its
        // items). Both stay on the previous version and appear in the HOD's question-mapping list.
        if (q.canonical_shared || q.in_review_round) {
          summary.skipped.push({ id: q.id, reason: q.in_review_round
            ? 'It is in an open review round: map it through Question mapping once the reviewers have decided'
            : 'Its canonical record is shared with another question: map it through Question mapping' });
          continue;
        }
        if (!remapOn) { await txn.get("SELECT set_config('app.syllabus_remap', 'on', true)"); remapOn = true; }
        const m = result.mapping;
        const newSubtopicId = q.subtopic_id ? (diff.status.subtopic.get(q.subtopic_id)?.newId || null) : null;
        const moved = await txn.run(`UPDATE questions SET syllabus_version_id = $1, subtopic_id = $2 WHERE id = $3 AND syllabus_version_id = $4 RETURNING id`,
          [versionId, newSubtopicId, q.id, prev.id]);
        if (moved.rowCount !== 1) { summary.skipped.push({ id: q.id, reason: 'It changed meanwhile' }); continue; }
        if (q.canonical_question_id) {
          await txn.run(`UPDATE canonical_questions SET
              verified_syllabus_unit_id = CASE WHEN verified_syllabus_unit_id IS NULL THEN NULL ELSE $1::uuid END,
              verified_syllabus_topic_id = CASE WHEN verified_syllabus_topic_id IS NULL THEN NULL ELSE $2::uuid END,
              verified_syllabus_subtopic_id = CASE WHEN verified_syllabus_subtopic_id IS NULL THEN NULL ELSE $3::uuid END,
              updated_at = now()
            WHERE id = $4`, [m.unitId, m.topicId, q.verified_syllabus_subtopic_id ? m.subtopicId : null, q.canonical_question_id]);
          // The verified CO mapping carries over to the identical COs of the new version (verifier kept).
          await txn.run(`
            INSERT INTO question_course_outcomes (canonical_question_id, course_outcome_id, relationship_type, confidence, source,
              verified_by, verified_at, verified_by_reviewer_ids)
            SELECT qco.canonical_question_id, m.new_id, qco.relationship_type, qco.confidence, qco.source, qco.verified_by, qco.verified_at, qco.verified_by_reviewer_ids
              FROM question_course_outcomes qco
              JOIN unnest($2::uuid[], $3::uuid[]) AS m(old_id, new_id) ON m.old_id = qco.course_outcome_id
             WHERE qco.canonical_question_id = $1
            ON CONFLICT (canonical_question_id, course_outcome_id) DO NOTHING`,
          [q.canonical_question_id, q.co_ids, q.co_ids.map((id) => diff.status.course_outcome.get(id).newId)]);
        }
        await txn.run(`INSERT INTO question_syllabus_remaps (question_id, from_version_id, to_version_id, kind, old_mapping, new_mapping, reason, performed_by)
          VALUES ($1, $2, $3, 'auto_unchanged', $4::jsonb, $5::jsonb, $6, $7)`,
        [q.id, prev.id, versionId, JSON.stringify(q.mapping), JSON.stringify({ ...m, subtopicId: newSubtopicId ?? m.subtopicId }),
          `Every item it maps to is unchanged in version ${locked.version_number}`, actor.id]);
        summary.remapped.push({ id: q.id, mapping: m });
        continue;
      }
      // affected
      const affecting = result.changes.map((i) => ({ id: changeIds[i], ...diff.changes[i] }));
      const reason = describeChanges(affecting, locked.version_number);
      let to = q.question_status;
      if (q.question_status === 'APPROVED') {
        // The lifecycle move (checked by the 038 transition guard), with the specific reason.
        const sent = await txn.run(`UPDATE questions SET question_status = 'CHANGES_REQUESTED', change_request_reason = $2, change_requested_by = $3,
          change_requested_at = now() WHERE id = $1 AND question_status = 'APPROVED' RETURNING id`, [q.id, reason, actor.id]);
        if (sent.rowCount === 1) to = 'CHANGES_REQUESTED';
      }
      for (const c of affecting) {
        await txn.run(`INSERT INTO affected_questions (syllabus_change_id, question_id, canonical_question_id, impact_type, original_status, new_status, action_taken, reason)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
        [c.id, q.id, q.canonical_question_id, to === 'CHANGES_REQUESTED' ? 'needs_review' : 'needs_remapping', q.question_status, to,
          to === 'CHANGES_REQUESTED' ? 'changes_requested' : 'flagged', reason]);
      }
      const entry = { id: q.id, from: q.question_status, to, submitted_by: q.submitted_by, change_ids: affecting.map((c) => c.id), reason };
      (to === 'CHANGES_REQUESTED' ? summary.sent_back : summary.flagged).push(entry);
    }
  }

  // Audit last (logAudit holds the chain lock until COMMIT).
  const counts = (list) => list.reduce((acc, c) => { acc[c.change_type] = (acc[c.change_type] || 0) + 1; return acc; }, {});
  await logAudit({ userId: actor.id, action: 'syllabus_version_approved', entityId: versionId, ip,
    details: { course_offering_id: version.course_offering_id, from: 'HOD_REVIEW', to: 'ACTIVE', previous_version_id: prev?.id || null,
      changes: counts(summary.changes), questions_remapped: summary.remapped.length, questions_sent_back: summary.sent_back.map((q) => q.id),
      questions_flagged: summary.flagged.map((q) => q.id), questions_unmapped: summary.unmapped.length, questions_skipped: summary.skipped.map((q) => q.id) } }, txn);
  if (prev) {
    await logAudit({ userId: actor.id, action: 'syllabus_version_superseded', entityId: prev.id, ip,
      details: { from: 'ACTIVE', to: 'SUPERSEDED', superseded_by_version_id: versionId } }, txn);
  }
  for (const q of summary.remapped) {
    await logAudit({ userId: actor.id, action: 'question_syllabus_remapped', entityId: q.id, ip,
      details: { kind: 'auto_unchanged', from_version_id: prev.id, to_version_id: versionId, mapping: q.mapping } }, txn);
  }
  for (const q of summary.sent_back) {
    await logAudit({ userId: actor.id, action: 'question_transition_changes_requested', entityId: q.id, ip,
      details: { from: 'APPROVED', to: 'CHANGES_REQUESTED', reason: q.reason, notes: null, syllabus_version_id: versionId, syllabus_change_ids: q.change_ids } }, txn);
  }
  for (const q of summary.flagged) {
    await logAudit({ userId: actor.id, action: 'question_syllabus_flagged', entityId: q.id, ip,
      details: { question_status: q.from, syllabus_version_id: versionId, syllabus_change_ids: q.change_ids, reason: q.reason } }, txn);
  }
  for (const q of summary.skipped) {
    await logAudit({ userId: actor.id, action: 'question_syllabus_remap_skipped', entityId: q.id, ip,
      details: { from_version_id: prev.id, syllabus_version_id: versionId, reason: q.reason } }, txn);
  }
  return { version: locked, offeringId: version.course_offering_id, summary };
}
