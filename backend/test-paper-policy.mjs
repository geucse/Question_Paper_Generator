// Pure-logic tests for the paper workflow policy (no database, no npm packages needed):
//   node --test test-paper-policy.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  PAPER_STATUSES, PAPER_TRANSITIONS, canTransitionPaper, validationOutcome, coeApprovalBlockers,
  normalizeRequiredApprovals, OVERRIDE_RESET_FROM, paperAccessFor, VALIDATOR_ACCESS_STATUSES, REPLACEABLE_IN,
  ASSIGNMENT_END_REASONS, ISSUE_TYPES, ISSUE_STATUSES, MANUAL_ISSUE_CLOSE, ISSUE_REPORTABLE_IN, ISSUE_CLOSABLE_IN,
  COE_SEND_BACK_FROM, canReportIssue, canCloseIssue, planIssueCarry, LIVE_PAPER_STATUSES, REGENERATABLE_STATUSES, REVISABLE_STATUSES,
} from './src/paper-policy.js';

test('every status has a transition entry and only targets known statuses', () => {
  assert.deepEqual(Object.keys(PAPER_TRANSITIONS).sort(), [...PAPER_STATUSES].sort());
  for (const targets of Object.values(PAPER_TRANSITIONS)) for (const t of targets) assert.ok(PAPER_STATUSES.includes(t), t);
});

test('the happy path is reachable one step at a time', () => {
  const path = ['DRAFT', 'GENERATING', 'GENERATED', 'VALIDATION_PENDING', 'VALIDATED', 'COE_APPROVED', 'PRINT_READY', 'ARCHIVED'];
  for (let i = 1; i < path.length; i++) assert.ok(canTransitionPaper(path[i - 1], path[i]), `${path[i - 1]} -> ${path[i]}`);
});

test('no skipping: approval and print steps cannot be jumped', () => {
  assert.equal(canTransitionPaper('GENERATED', 'VALIDATED'), false);
  assert.equal(canTransitionPaper('VALIDATION_PENDING', 'COE_APPROVED'), false);
  assert.equal(canTransitionPaper('VALIDATED', 'PRINT_READY'), false);
  assert.equal(canTransitionPaper('GENERATED', 'PRINT_READY'), false);
});

test('PRINT_READY and ARCHIVED are locked', () => {
  for (const to of PAPER_STATUSES.filter((s) => s !== 'ARCHIVED')) assert.equal(canTransitionPaper('PRINT_READY', to), false, to);
  for (const to of PAPER_STATUSES) assert.equal(canTransitionPaper('ARCHIVED', to), false, to);
  assert.equal(canTransitionPaper('PRINT_READY', 'GENERATED', { override: true }), false, 'override never unlocks');
});

test('admin override can only return a stuck, unlocked paper to GENERATED', () => {
  for (const from of OVERRIDE_RESET_FROM) {
    assert.equal(canTransitionPaper(from, 'GENERATED'), false, `${from} without override`);
    assert.equal(canTransitionPaper(from, 'GENERATED', { override: true }), true, `${from} with override`);
  }
  assert.equal(canTransitionPaper('VALIDATION_PENDING', 'VALIDATED', { override: true }), true, 'normal step still fine');
  assert.equal(canTransitionPaper('VALIDATION_PENDING', 'COE_APPROVED', { override: true }), false, 'override approves nothing');
});

test('required approvals: default 4, accepts 3..4, falls back to 4 otherwise', () => {
  assert.equal(normalizeRequiredApprovals(undefined), 4);
  assert.equal(normalizeRequiredApprovals('3'), 3);
  for (const bad of [0, 1, 2, 5, 3.5, 'x', null]) assert.equal(normalizeRequiredApprovals(bad), 4, String(bad));
});

test('validation outcome waits for all 4 decisions', () => {
  const r = validationOutcome(['APPROVE', 'APPROVE', 'APPROVE', null]);
  assert.equal(r.allDecided, false); assert.equal(r.nextStatus, null);
});

test('validation outcome: default rule needs 4/4; a 3-of-4 policy tolerates one objection', () => {
  const split = ['APPROVE', 'APPROVE', 'APPROVE', 'CHANGES_REQUIRED'];
  assert.equal(validationOutcome(split).nextStatus, 'CHANGES_REQUIRED');
  assert.equal(validationOutcome(split, 3).nextStatus, 'VALIDATED');
  assert.equal(validationOutcome(['APPROVE', 'APPROVE', 'CHANGES_REQUIRED', 'CHANGES_REQUIRED'], 3).nextStatus, 'CHANGES_REQUIRED');
  const all = validationOutcome(['APPROVE', 'APPROVE', 'APPROVE', 'APPROVE']);
  assert.equal(all.nextStatus, 'VALIDATED'); assert.equal(all.allApproved, true);
});

test('COE approval blockers list every unmet condition', () => {
  assert.deepEqual(coeApprovalBlockers({ paperStatus: 'VALIDATED', totalValidators: 4, approvals: 4, requiredApprovals: 4, openIssues: 0 }), []);
  const b = coeApprovalBlockers({ paperStatus: 'VALIDATION_PENDING', totalValidators: 3, approvals: 2, requiredApprovals: 4, openIssues: 1 });
  assert.equal(b.length, 4);
  assert.match(b.join(' '), /VALIDATED/); assert.match(b.join(' '), /exactly 4/); assert.match(b.join(' '), /At least 4/); assert.match(b.join(' '), /open/);
});

// The database trigger carries its own copy of the transition table. It was first defined in 036; later
// migrations redefine it (039 added the COE send-back), so the newest definition is the one in force.
const MIGRATIONS = new URL('./migrations/', import.meta.url);
const readMigration = (f) => fs.readFileSync(new URL(f, MIGRATIONS), 'utf8');
function newestMigrationDefining(re) {
  const files = fs.readdirSync(MIGRATIONS).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  return files.filter((f) => re.test(readMigration(f))).at(-1);
}

test('the newest enforce_paper_lifecycle transition table matches paper-policy.js', () => {
  const file = newestMigrationDefining(/CREATE OR REPLACE FUNCTION enforce_paper_lifecycle\(\)/);
  assert.ok(file >= '039_', `expected 039 or later, got ${file}`);
  const sqlText = readMigration(file);
  const block = sqlText.slice(sqlText.indexOf('v_allowed := CASE OLD.paper_status'), sqlText.indexOf('END;', sqlText.indexOf('v_allowed := CASE OLD.paper_status')));
  const fromSql = {};
  for (const m of block.matchAll(/WHEN '(\w+)'\s+THEN ARRAY\[([^\]]*)\]/g)) {
    fromSql[m[1]] = [...m[2].matchAll(/'(\w+)'/g)].map((x) => x[1]);
  }
  for (const [from, targets] of Object.entries(PAPER_TRANSITIONS)) {
    if (from === 'PRINT_READY' || from === 'ARCHIVED') continue; // handled by the explicit lock branches in the trigger
    assert.deepEqual(fromSql[from], targets, `SQL vs JS for ${from}`);
  }
  const m = sqlText.match(/IF v_override AND NEW\.paper_status = 'GENERATED'\s+AND OLD\.paper_status IN \(([^)]*)\)/);
  assert.ok(m, 'override clause in SQL');
  assert.deepEqual([...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]), OVERRIDE_RESET_FROM, 'override list in SQL');
  assert.deepEqual(OVERRIDE_RESET_FROM, ['VALIDATION_PENDING', 'VALIDATED', 'COE_APPROVED']);
});

test('the technical reset never overturns a CHANGES_REQUIRED verdict (§36)', () => {
  assert.equal(OVERRIDE_RESET_FROM.includes('CHANGES_REQUIRED'), false);
  assert.equal(canTransitionPaper('CHANGES_REQUIRED', 'GENERATED', { override: true }), false);
  const sqlText = readMigration(newestMigrationDefining(/CREATE OR REPLACE FUNCTION enforce_paper_lifecycle\(\)/));
  assert.match(sqlText, /cannot discard a CHANGES_REQUIRED decision/, 'lifecycle refuses a reset over a CHANGES_REQUIRED decision');
  const guard = readMigration(newestMigrationDefining(/CREATE OR REPLACE FUNCTION guard_validator_assignment\(\)/));
  assert.match(guard, /NEW\.deactivation_reason NOT IN \('paper_reset', 'paper_regenerated', 'paper_archived'\)/, 'a decided assignment ends only by supersession or reset');
});

// ---- 039: send-back, issue windows, validator access ----
const q = (xs) => xs.map((x) => `'${x}'`).join(', ');

test('COE send-back: VALIDATED -> CHANGES_REQUIRED only; approved/locked papers never go back', () => {
  assert.equal(canTransitionPaper('VALIDATED', 'CHANGES_REQUIRED'), true);
  for (const from of ['COE_APPROVED', 'PRINT_READY', 'ARCHIVED']) assert.equal(canTransitionPaper(from, 'CHANGES_REQUIRED'), false, from);
  for (const from of COE_SEND_BACK_FROM) assert.equal(canTransitionPaper(from, 'CHANGES_REQUIRED'), true, from);
  assert.match(readMigration('039_paper_workflow_integrity.sql'), /recorded COE send-back/, 'the DB requires a send-back record');
});

test('issue windows and statuses in migration 039 match paper-policy.js', () => {
  const sql = readMigration(newestMigrationDefining(/CREATE OR REPLACE FUNCTION enforce_paper_issue_rules\(\)/));
  assert.ok(sql.includes(`v_status NOT IN (${q(ISSUE_REPORTABLE_IN)})`), 'reportable statuses');
  assert.ok(sql.includes(`v_status NOT IN (${q(ISSUE_CLOSABLE_IN)})`), 'closable statuses');
  assert.ok(sql.includes(`CHECK (status IN (${q(ISSUE_STATUSES)}))`), 'issue status CHECK');
  assert.ok(sql.includes(`deactivation_reason IN (${q(ASSIGNMENT_END_REASONS)})`), 'assignment end reasons CHECK');
  assert.deepEqual(MANUAL_ISSUE_CLOSE, ISSUE_STATUSES.filter((x) => x === 'resolved' || x === 'wont_fix'));
  for (const s of [...ISSUE_REPORTABLE_IN, ...ISSUE_CLOSABLE_IN, ...REPLACEABLE_IN, ...VALIDATOR_ACCESS_STATUSES, ...COE_SEND_BACK_FROM]) assert.ok(PAPER_STATUSES.includes(s), s);
  for (const s of PAPER_STATUSES) {
    assert.equal(canReportIssue(s), ISSUE_REPORTABLE_IN.includes(s), s);
    assert.equal(canCloseIssue(s), ISSUE_CLOSABLE_IN.includes(s), s);
  }
  assert.equal(ISSUE_TYPES.length, 13);
  assert.ok(readMigration('028_examination_domain.sql').includes(q(ISSUE_TYPES.slice(0, 5))), 'issue types as in the 028 CHECK');
});

test('paper access by status: validator only while under validation, COE in scope always', () => {
  for (const s of PAPER_STATUSES) {
    const v = paperAccessFor({ role: 'validator', assignedActive: true, paperStatus: s });
    const open = VALIDATOR_ACCESS_STATUSES.includes(s);
    assert.equal(v.view, open, `validator view ${s}`);
    assert.equal(v.answerKey, open, `validator answer key ${s}`);
    assert.equal(v.reportIssue, open && ISSUE_REPORTABLE_IN.includes(s), `validator report ${s}`);
    assert.equal(v.decide, s === 'VALIDATION_PENDING', `validator decide ${s}`);
    assert.deepEqual(paperAccessFor({ role: 'validator', assignedActive: false, paperStatus: s }), { view: false, answerKey: false, reportIssue: false, decide: false }, `ended validator ${s}`);
    const c = paperAccessFor({ role: 'coe', inScope: true, paperStatus: s });
    assert.equal(c.view && c.answerKey, true, `COE ${s}`);
    assert.equal(c.decide || c.reportIssue, false, `COE never decides/reports ${s}`);
    assert.equal(paperAccessFor({ role: 'coe', inScope: false, paperStatus: s }).view, false, `COE out of scope ${s}`);
    for (const role of ['hod', 'reviewer', 'teacher', 'admin']) assert.equal(paperAccessFor({ role, inScope: true, assignedActive: true, paperStatus: s }).view, false, `${role} ${s}`);
  }
  for (const s of ['COE_APPROVED', 'PRINT_READY', 'ARCHIVED', 'REGENERATED', 'CHANGES_REQUIRED']) {
    assert.equal(paperAccessFor({ role: 'validator', assignedActive: true, paperStatus: s }).answerKey, false, `answer key of a ${s} paper is COE-only`);
  }
});

test('planIssueCarry: replaced questions resolved, kept and paper-level issues carried', () => {
  const issues = [{ id: 'a', question_id: 'q1' }, { id: 'b', question_id: 'q9' }, { id: 'c', question_id: null }];
  const { resolve, carry } = planIssueCarry(issues, ['q1', 'q2']);
  assert.deepEqual(resolve.map((i) => i.id), ['b']);
  assert.deepEqual(carry.map((i) => i.id), ['a', 'c']);
  assert.deepEqual(planIssueCarry([], ['q1']), { resolve: [], carry: [] });
});

// ---- 039: one live paper per examination, regeneration, frozen generation results ----
test('live paper statuses: in progress (printed counted separately); mirrored by the 039 one-live-paper trigger', () => {
  for (const st of LIVE_PAPER_STATUSES) assert.ok(PAPER_STATUSES.includes(st), st);
  for (const st of ['DRAFT', 'REGENERATED', 'ARCHIVED', 'PRINT_READY']) assert.equal(LIVE_PAPER_STATUSES.includes(st), false, st);
  assert.deepEqual(REVISABLE_STATUSES, ['PRINT_READY']);
  assert.deepEqual([...LIVE_PAPER_STATUSES, ...REVISABLE_STATUSES].sort(), PAPER_STATUSES.filter((x) => !['DRAFT', 'REGENERATED', 'ARCHIVED'].includes(x)).sort());
  const sql = readMigration(newestMigrationDefining(/CREATE OR REPLACE FUNCTION check_one_live_paper_per_examination\(\)/));
  const m = sql.match(/v_live_statuses TEXT\[\] := ARRAY\[([^\]]*)\]/);
  assert.ok(m, 'v_live_statuses in the trigger');
  assert.deepEqual([...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]), LIVE_PAPER_STATUSES);
  assert.ok(sql.includes(`paper_status IN (${q(LIVE_PAPER_STATUSES)})`), 'the grandfathering NOTICE uses the same list');
  assert.match(sql, /uq_one_printed_paper_per_examination/, 'at most one PRINT_READY paper per examination');
  assert.match(sql, /NEW\.paper_status IN \('GENERATING', 'PRINT_READY'\)/, 'status changes into the counted sets are checked too');
});

test('regeneration starts exactly from the statuses that may become REGENERATED', () => {
  assert.deepEqual(REGENERATABLE_STATUSES, Object.entries(PAPER_TRANSITIONS).filter(([, to]) => to.includes('REGENERATED')).map(([from]) => from));
});

test('the newest enforce_paper_lifecycle freezes what the generator decided', () => {
  const sqlText = readMigration(newestMigrationDefining(/CREATE OR REPLACE FUNCTION enforce_paper_lifecycle\(\)/));
  const block = sqlText.slice(sqlText.indexOf('v_generation_cols TEXT[] := ARRAY['), sqlText.indexOf('];', sqlText.indexOf('v_generation_cols TEXT[] := ARRAY[')));
  const cols = [...block.matchAll(/'(\w+)'/g)].map((x) => x[1]);
  for (const c of ['examination_id', 'generation_seed', 'blueprint_version_id', 'paper_version', 'format_config', 'candidate_metrics', 'constraint_overrides', 'bloom_realized']) {
    assert.ok(cols.includes(c), c);
  }
});
