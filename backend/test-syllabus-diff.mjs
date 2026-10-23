// Unit tests for syllabus change detection (migration 042, src/syllabus-versioning.js), no database needed:
//   node --test test-syllabus-diff.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { diffSyllabus, classifyQuestion, pairUp, norm, describeChanges, questionMapping, resolvePlacement } from './src/syllabus-versioning.js';

const tree = (units, cos) => ({ units, cos });
const unit = (id, code, title, topics = []) => ({ id, code, title, topics });
const topic = (id, title, subtopics = []) => ({ id, title, subtopics });
const co = (id, code, description) => ({ id, code, description });
const kinds = (d) => d.changes.map((c) => `${c.entity_type}:${c.change_type}:${c.entity_id}`).sort();

test('norm: case, width and whitespace never make a change', () => {
  assert.equal(norm('  Binary   SEARCH\tTrees '), 'binary search trees');
  assert.equal(norm('ＣＯ１'), 'co1');
  assert.equal(norm(null), '');
});

test('identical syllabi (different ids, ordering, spacing) produce no change and map every item', () => {
  const prev = tree([unit('u1', 'Unit 1', 'Trees', [topic('t1', 'AVL', [topic('s1', 'Rotations')]), topic('t2', 'Heaps')])], [co('c1', 'CO1', 'Explain trees')]);
  const next = tree([unit('U1', 'UNIT 1', ' trees ', [topic('T2', 'heaps'), topic('T1', 'AVL', [topic('S1', 'rotations')])])], [co('C1', 'co1', 'explain  trees')]);
  const d = diffSyllabus(prev, next);
  assert.deepEqual(d.changes, []);
  assert.deepEqual(classifyQuestion({ topicId: 't1', subtopicId: 's1', coIds: ['c1'] }, d),
    { kind: 'unchanged', mapping: { unitId: 'U1', topicId: 'T1', subtopicId: 'S1', coIds: ['C1'] } });
});

test('units: same code + new title = RENAMED; same title + new code = RENAMED; otherwise REMOVED / ADDED', () => {
  const prev = tree([unit('u1', 'U1', 'Trees'), unit('u2', 'U2', 'Graphs'), unit('u3', 'U3', 'Sorting')], []);
  const next = tree([unit('n1', 'U1', 'Trees and heaps'), unit('n2', 'U9', 'Graphs'), unit('n4', 'U4', 'Hashing')], []);
  const d = diffSyllabus(prev, next);
  assert.deepEqual(kinds(d), ['unit:ADDED:U4', 'unit:REMOVED:U3', 'unit:RENAMED:U1', 'unit:RENAMED:U9']);
  assert.equal(d.changes.find((c) => c.entity_id === 'U9').match_rule, 'same title, different code');
  assert.deepEqual(d.changes.find((c) => c.entity_id === 'U1').old_value, { code: 'U1', title: 'Trees' });
});

test('topics: same title under the matched unit = unchanged; under another unit = MODIFIED (moved); a retitled topic is REMOVED + ADDED', () => {
  const prev = tree([unit('u1', 'U1', 'Trees', [topic('t1', 'AVL'), topic('t2', 'Heaps'), topic('t3', 'B-trees')]), unit('u2', 'U2', 'Graphs', [topic('t4', 'BFS')])], []);
  const next = tree([unit('n1', 'U1', 'Trees', [topic('T1', 'AVL'), topic('T3', 'B+ trees')]), unit('n2', 'U2', 'Graphs', [topic('T4', 'BFS'), topic('T2', 'Heaps')])], []);
  const d = diffSyllabus(prev, next);
  assert.deepEqual(kinds(d), ['topic:ADDED:B+ trees', 'topic:MODIFIED:Heaps', 'topic:REMOVED:B-trees']);
  assert.match(d.changes.find((c) => c.change_type === 'MODIFIED').match_rule, /moved from unit U1 to unit U2/);
  assert.equal(d.status.topic.get('t1').type, 'UNCHANGED');
  assert.equal(d.status.topic.get('t2').newId, 'T2');
});

test('subtopics: same title under the matched topic = unchanged; moved = MODIFIED; removed / added', () => {
  const prev = tree([unit('u1', 'U1', 'Trees', [topic('t1', 'AVL', [topic('s1', 'Rotations'), topic('s2', 'Balance factor')]), topic('t2', 'Heaps', [topic('s3', 'Heapify')])])], []);
  const next = tree([unit('n1', 'U1', 'Trees', [topic('T1', 'AVL', [topic('S1', 'Rotations')]), topic('T2', 'Heaps', [topic('S2', 'Balance factor'), topic('S4', 'Build heap')])])], []);
  const d = diffSyllabus(prev, next);
  assert.deepEqual(kinds(d), ['subtopic:ADDED:Build heap', 'subtopic:MODIFIED:Balance factor', 'subtopic:REMOVED:Heapify']);
});

test('COs: same code + new description = MODIFIED; same description + new code = RENAMED; removed / added', () => {
  const prev = tree([], [co('c1', 'CO1', 'Explain trees'), co('c2', 'CO2', 'Apply graphs'), co('c3', 'CO3', 'Analyse sorting'), co('c4', 'CO4', 'Design hashing')]);
  const next = tree([], [co('C1', 'CO1', 'Explain trees'), co('C2', 'CO2', 'Apply graph algorithms'), co('C3', 'CO5', 'Analyse sorting'), co('C6', 'CO6', 'Evaluate designs')]);
  const d = diffSyllabus(prev, next);
  assert.deepEqual(kinds(d), ['course_outcome:ADDED:CO6', 'course_outcome:MODIFIED:CO2', 'course_outcome:REMOVED:CO4', 'course_outcome:RENAMED:CO5']);
});

test('ambiguous keys never match (two units share a normalized code)', () => {
  const r = pairUp([{ id: 'a', k: 'X' }, { id: 'b', k: 'x' }], [{ id: 'A', k: 'X' }], [(i) => norm(i.k)]);
  assert.deepEqual(r.pairs, []); assert.equal(r.oldLeft.length, 2); assert.equal(r.newLeft.length, 1);
  const s = pairUp([{ id: 'a', k: 1 }], [{ id: 'A', j: 1 }], [{ old: (i) => String(i.k), neu: (i) => String(i.j) }]);
  assert.equal(s.pairs[0].neu.id, 'A');
});

test('classifyQuestion: unit renamed, topic moved, subtopic or CO changed = affected (with every change); unknown item = unmapped', () => {
  const prev = tree([unit('u1', 'U1', 'Trees', [topic('t1', 'AVL', [topic('s1', 'Rotations')]), topic('t2', 'Heaps')])], [co('c1', 'CO1', 'Explain'), co('c2', 'CO2', 'Apply')]);
  const next = tree([unit('n1', 'U1', 'Trees and heaps', [topic('T1', 'AVL')]), unit('n2', 'U2', 'Heaps', [topic('T2', 'Heaps')])], [co('C1', 'CO1', 'Explain'), co('C2', 'CO2', 'Apply well')]);
  const d = diffSyllabus(prev, next);
  const at = (r) => r.changes.map((i) => `${d.changes[i].entity_type}:${d.changes[i].change_type}`).sort();
  assert.deepEqual(at(classifyQuestion({ topicId: 't1', coIds: ['c1'] }, d)), ['unit:RENAMED']);
  assert.deepEqual(at(classifyQuestion({ topicId: 't1', subtopicId: 's1', coIds: ['c2'] }, d)), ['course_outcome:MODIFIED', 'subtopic:REMOVED', 'unit:RENAMED']);
  assert.deepEqual(at(classifyQuestion({ unitId: 'u1', topicId: 't2', coIds: [] }, d)), ['topic:MODIFIED', 'unit:RENAMED']);
  assert.deepEqual(classifyQuestion({ topicId: 'zzz', coIds: [] }, d), { kind: 'unmapped' });
  assert.deepEqual(classifyQuestion({ topicId: null, coIds: ['c1'] }, d), { kind: 'unmapped' });
  assert.deepEqual(classifyQuestion({ topicId: 't1', coIds: ['inactive-co'] }, d), { kind: 'unmapped' });
});

test('describeChanges names each change and the version; questionMapping prefers verified ids, never guesses an ambiguous title', () => {
  const text = describeChanges([{ entity_type: 'topic', change_type: 'REMOVED', entity_id: 'Heaps' }, { entity_type: 'course_outcome', change_type: 'MODIFIED', entity_id: 'CO2' }], 4);
  assert.match(text, /^Syllabus version 4 changed \(topic "Heaps" removed; CO "CO2" modified\)/);
  const prev = tree([unit('u1', 'U1', 'Trees', [topic('t1', 'AVL', [topic('s1', 'Rotations')])]), unit('u2', 'U2', 'More', [topic('t9', 'avl')])], []);
  assert.deepEqual(questionMapping({ verified_syllabus_topic_id: 't1', subtopic: 'rotations', co_ids: ['c1'] }, prev), { unitId: 'u1', topicId: 't1', subtopicId: 's1', coIds: ['c1'] });
  assert.equal(questionMapping({ topic: 'AVL', co_ids: [] }, prev), null, 'two topics are titled AVL: not guessed');
  assert.equal(questionMapping({ verified_syllabus_topic_id: 'gone', topic: 'AVL', co_ids: [] }, prev), null, 'a verified topic outside the version is not replaced by the title');
  assert.equal(questionMapping({ verified_syllabus_topic_id: 't1', subtopic: 'Splay', co_ids: [] }, prev).subtopicId, 'unknown');
});

test('resolvePlacement: ids and titles checked against the version; syllabus spelling stored; a version without topics accepts free text', async () => {
  const db = (topics, subs) => ({ all: async (text) => (/FROM syllabus_topics/.test(text) ? topics : subs) });
  const topics = [{ id: 't1', title: 'Trees' }, { id: 't2', title: 'Graphs' }];
  const subs = [{ id: 's1', title: 'Rotations' }];
  assert.deepEqual(await resolvePlacement(db(topics, subs), 'v', { topic: ' trees ', subtopic: 'ROTATIONS' }), { ok: true, topic: 'Trees', topicId: 't1', subtopic: 'Rotations', subtopicId: 's1' });
  assert.equal((await resolvePlacement(db(topics, subs), 'v', { topicId: 't9' })).ok, false);
  assert.match((await resolvePlacement(db(topics, subs), 'v', { topic: 'Trees', subtopicId: 's9' })).error, /not under topic 'Trees'/);
  assert.match((await resolvePlacement(db([...topics, { id: 't3', title: 'trees' }], subs), 'v', { topic: 'Trees' })).error, /more than one unit/);
  assert.deepEqual(await resolvePlacement(db([], []), 'v', { topic: 'Anything' }), { ok: true, topic: 'Anything', topicId: null, subtopic: null, subtopicId: null });
  assert.equal((await resolvePlacement(db([], []), null, { topic: 'X', subtopic: 'Y' })).ok, false, 'no syllabus: no subtopic');
  assert.deepEqual(await resolvePlacement(db(topics, subs), 'v', {}), { ok: true, topic: null, topicId: null, subtopic: null, subtopicId: null });
});
