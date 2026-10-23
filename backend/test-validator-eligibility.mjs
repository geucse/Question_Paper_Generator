// Pure-logic tests for the validator eligibility rules (spec §27), no database:
//   node --test test-validator-eligibility.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { conflictReasons, CONFLICT, reviewerConflict, validatorProblems, candidateValidators } from './src/validator-eligibility.js';

const ok = { id: 'v1', role: 'validator', status: 'ACTIVE', is_active: true };
const base = { user: ok, hasScope: true, isCoe: false, isAuthor: false, reviewerSources: [], policyOn: false };

test('an active validator in scope with no conflict is eligible', () => {
  assert.deepEqual(conflictReasons(base), []);
});

test('each rule gives its exact reason', () => {
  assert.deepEqual(conflictReasons({ ...base, user: null }), [CONFLICT.missing]);
  assert.deepEqual(conflictReasons({ ...base, user: { ...ok, role: 'teacher' } }), [CONFLICT.notValidator]);
  assert.deepEqual(conflictReasons({ ...base, user: { ...ok, status: 'INACTIVE' } }), [CONFLICT.inactive]);
  assert.deepEqual(conflictReasons({ ...base, user: { ...ok, is_active: false } }), [CONFLICT.inactive], 'is_active alone (academic.js deactivation) counts');
  assert.deepEqual(conflictReasons({ ...base, hasScope: false }), [CONFLICT.scope]);
  assert.deepEqual(conflictReasons({ ...base, isCoe: true }), [CONFLICT.coe]);
  assert.deepEqual(conflictReasons({ ...base, isAuthor: true }), [CONFLICT.author]);
  assert.equal(CONFLICT.coe, 'COE cannot be a validator for their own paper');
  assert.equal(CONFLICT.author, 'Validator cannot be an author of questions in the paper');
});

test('a reviewer conflict counts only when the independence policy is on', () => {
  assert.deepEqual(conflictReasons({ ...base, reviewerSources: ['review round decision'] }), []);
  const r = conflictReasons({ ...base, reviewerSources: ['reviewer verdict', 'approved the question', 'reviewer verdict'], policyOn: true });
  assert.deepEqual(r, [reviewerConflict(['approved the question', 'reviewer verdict'])]);
  assert.match(r[0], /^Validator reviewed a question in this paper \(approved the question, reviewer verdict\)/);
});

test('several problems are listed in a stable order', () => {
  const r = conflictReasons({ user: { ...ok, role: 'coe', status: 'INACTIVE' }, hasScope: false, isCoe: true, isAuthor: true, reviewerSources: ['x'], policyOn: true });
  assert.deepEqual(r, [CONFLICT.notValidator, CONFLICT.inactive, CONFLICT.scope, CONFLICT.coe, CONFLICT.author, reviewerConflict(['x'])]);
});

// A scripted db stub: answers the helper's queries from fixed data.
function stubDb({ users, scope = () => true, authors = [], reviewers = [], policy = 'false' }) {
  const log = [];
  const pick = (text, params) => {
    log.push(text);
    if (/system_state/.test(text)) return [{ value: policy }];
    if (/paper_question_authors/.test(text) && !/WITH a AS/.test(text)) return authors.map((a) => ({ author_id: a }));
    if (/paper_question_reviewers/.test(text) && !/WITH a AS/.test(text)) return reviewers;
    if (/FROM users WHERE id = \$1/.test(text)) return [users[params[0]]].filter(Boolean);
    if (/FROM user_scopes/.test(text)) return [];
    if (/user_has_scope/.test(text)) return [{ has_scope: scope(params[0], params[1], params[2]) }];
    throw new Error('unexpected ' + text);
  };
  return { log, get: async (t, p) => pick(t, p)[0] || null, all: async (t, p) => pick(t, p) };
}

test('validatorProblems: re-checks every rule and locks the users/scope rows inside a transaction', async () => {
  const users = { v1: ok, v2: { ...ok, id: 'v2', is_active: false }, t: { ...ok, id: 't', role: 'teacher' } };
  const db = stubDb({ users, authors: ['t'], scope: (id) => id !== 'v3', reviewers: [{ reviewer_id: 'v1', source: 'review round decision' }], policy: 'true' });
  const m = await validatorProblems(db, { paper: { id: 'p', campus_id: 'c' }, validatorIds: ['v1', 'v2', 't', 'v3', 'v1'], coeIds: ['coe'], lock: true });
  assert.deepEqual([...m.keys()], ['v1', 'v2', 't', 'v3'], 'deduplicated, in order');
  assert.deepEqual(m.get('v1'), [reviewerConflict(['review round decision'])]);
  assert.deepEqual(m.get('v2'), [CONFLICT.inactive]);
  assert.deepEqual(m.get('t'), [CONFLICT.notValidator, CONFLICT.author]);
  assert.deepEqual(m.get('v3'), [CONFLICT.missing]);
  assert.ok(db.log.some((t) => /FROM users WHERE id = \$1 FOR SHARE/.test(t)) && db.log.some((t) => /user_scopes .*FOR SHARE/.test(t)));
});

test('candidateValidators maps the set-based listing through the same reasons', async () => {
  const db = {
    get: async () => ({ value: 'true' }),
    all: async () => [
      { id: 'v1', full_name: 'A', email: 'a@x', role: 'validator', status: 'ACTIVE', is_active: true, has_scope: true, is_author: false, reviewer_sources: [], assigned_as: 2 },
      { id: 'v2', full_name: 'B', email: 'b@x', role: 'validator', status: 'INACTIVE', is_active: false, has_scope: true, is_author: true, reviewer_sources: ['reviewer verdict'], assigned_as: null },
    ],
  };
  const rows = await candidateValidators(db, { paper: { id: 'p', campus_id: 'c' }, coeIds: [] });
  assert.deepEqual(rows[0], { id: 'v1', full_name: 'A', email: 'a@x', assigned_as: 2, conflicts: [] });
  assert.deepEqual(rows[1].conflicts, [CONFLICT.inactive, CONFLICT.author, reviewerConflict(['reviewer verdict'])]);
});
