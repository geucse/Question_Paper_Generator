// Browser checks of the pivot screens against a MOCKED API (no backend or database needed).
// They verify UI wiring only: what each role sees, which buttons exist, that reasons are required,
// and what request each action sends. Real authorization is covered by the backend route tests.
//
//   cd frontend
//   npx playwright install chromium     # once (Playwright itself is a devDependency)
//   npm run test:e2e                    # builds with --mode e2e into dist-e2e, then runs this file
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const DIST = process.env.E2E_DIST || path.join(__dirname, '..', 'dist-e2e');
if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error(`No build at ${DIST}. Run \`npm run test:e2e\` (or \`npm run build:e2e\` first), see the header.`);
  process.exit(2);
}
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' -> ' + detail}`); };

async function session(user, handlers) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const calls = [];
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('http://mock.local/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api', '') + url.search;
    const body = req.postData() ? ((b) => { try { return JSON.parse(b); } catch { return b; } })(req.postData()) : null;
    calls.push({ method: req.method(), path, body });
    let res = [200, req.method() === 'GET' ? [] : {}]; // list endpoints by default
    if (path === '/auth/me') res = [200, user];
    else if (path.startsWith('/notifications')) res = [200, path.includes('count') ? { count: 0 } : []];
    for (const [m, re, fn] of handlers) if (req.method() === m && re.test(path)) { res = fn(body, path); break; }
    // A handler returns [status, json] or [status, rawBody, contentType] (e.g. a PDF).
    await route.fulfill({ status: res[0], contentType: res[2] || 'application/json', headers: { 'access-control-allow-origin': '*' },
      body: res[2] ? res[1] : JSON.stringify(res[1]) });
  });
  await page.addInitScript(() => localStorage.setItem('portal_token', 'tok'));
  await page.route('http://app.local/**', (r) => {
    const rel = new URL(r.request().url()).pathname.replace(/^\/+/, '') || 'index.html';
    const file = path.join(DIST, rel);
    const target = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(DIST, 'index.html');
    return r.fulfill({ status: 200, contentType: TYPES[path.extname(target)] || 'application/octet-stream', body: fs.readFileSync(target) });
  });
  await page.goto('http://app.local/');
  return { browser, page, calls, errors };
}

(async () => {
  // ---- Teacher: lifecycle status + withdraw ----
  {
    const s = await session({ id: 't', email: 't@x', role: 'teacher', totp_enabled: false }, [
      ['GET', /^\/question-bank\/lifecycle/, () => [200, { questions: [{ id: 'q1', question_text: 'Explain AVL rotations', question_status: 'SUBMITTED', is_mine: true, marks: 4 },
        { id: 'q2', question_text: 'Define a heap', question_status: 'CHANGES_REQUESTED', is_mine: true }], counts: { SUBMITTED: 1, CHANGES_REQUESTED: 1 } }]],
      ['GET', /retirement-reasons/, () => [200, ['Outdated']]],
      ['POST', /\/q1\/transition/, () => [200, { question_status: 'DRAFT' }]],
    ]);
    const { page, calls, errors } = s;
    await page.getByRole('button', { name: 'Question status' }).click();
    await page.getByText('Explain AVL rotations').waitFor();
    check('teacher sees lifecycle list with status badges', await page.getByText('Changes requested', { exact: true }).first().isVisible());
    check('teacher gets the revise-and-resubmit hint and button on a changes-requested question', await page.getByText(/Use “Revise & resubmit”/).isVisible()
      && await page.getByRole('button', { name: 'Revise & resubmit' }).isVisible());
    await page.getByRole('button', { name: 'Withdraw to draft' }).click();
    await page.getByText('Moved to Draft').waitFor();
    const t = calls.find((c) => c.method === 'POST' && /transition/.test(c.path));
    check('withdraw posts DRAFT transition', t && t.body.target_status === 'DRAFT', JSON.stringify(t));
    check('teacher: no page errors', errors.length === 0, errors.join('; '));
    await s.browser.close();
  }
  // ---- Teacher: "Revise & resubmit" opens the question in the right section, once ----
  {
    const sub = { id: 'q7', question_text: 'Compare AVL and red-black trees', question_type: 'long_answer', question_status: 'CHANGES_REQUESTED', difficulty: 'medium', marks: 6,
      change_request_reason: 'Add a worked example', model_answer: 'Both are balanced BSTs', course_offering_id: 'o1' };
    const s = await session({ id: 't', email: 't@x', role: 'teacher' }, [
      ['GET', /^\/question-bank\/lifecycle/, () => [200, { questions: [{ ...sub, is_mine: true }], counts: { CHANGES_REQUESTED: 1 } }]],
      ['GET', /retirement-reasons/, () => [200, []]],
      ['GET', /^\/academic\/my-assignments/, () => [200, [{ assignment_id: 'a1', course_offering_id: 'o1', section_id: null, subject_code: 'CS1', course_title: 'DS', program_code: 'BT', academic_session_label: '2026', semester: 3 }]]],
      ['GET', /^\/questions\/mine\?type=subjective/, () => [200, [{ ...sub }]]],
      ['GET', /^\/questions\/q7\/preview/, () => [200, { question: sub }]],
    ]);
    const { page, calls, errors } = s;
    await page.getByRole('button', { name: 'Question status' }).click();
    await page.getByRole('button', { name: 'Revise & resubmit' }).click();
    await page.getByText('Revising: changes requested').waitFor();
    check('revise opens the subjective section with the question and the change request', await page.getByText('Reviewer asked for: Add a worked example').isVisible()
      && (await page.locator('textarea').first().inputValue()) === 'Compare AVL and red-black trees'
      && await page.getByRole('button', { name: 'Subjective questions', exact: true }).evaluate((b) => b.classList.contains('active')));
    await page.waitForTimeout(500);
    check('the revised question is fetched exactly once (no effect loop)', calls.filter((c) => c.path === '/questions/q7/preview').length === 1, String(calls.filter((c) => c.path === '/questions/q7/preview').length));
    check('the section list reloads for the subjective section', calls.some((c) => c.path === '/questions/mine?type=subjective'));
    await page.getByRole('button', { name: 'Objective questions', exact: true }).click();
    check('switching section afterwards starts a new question there', await page.getByText('New objective question').isVisible());
    check('teacher revise: no page errors', errors.length === 0, errors.join('; '));
    await s.browser.close();
  }
  // ---- Reviewer: quality gate errors are shown; request changes needs a reason; no reject outside review batches ----
  {
    const s = await session({ id: 'r', email: 'r@x', role: 'reviewer' }, [
      ['GET', /^\/question-bank\/lifecycle/, () => [200, { questions: [{ id: 'q3', question_text: 'Approved question', question_status: 'APPROVED', is_mine: false, author_email: 'a@x' },
        { id: 'q4', question_text: 'Under review question', question_status: 'UNDER_REVIEW', is_mine: false },
        { id: 'q5', question_text: 'My own approved question', question_status: 'APPROVED', is_mine: true }], counts: {} }]],
      ['GET', /retirement-reasons/, () => [200, ['Outdated']]],
      ['POST', /\/q3\/transition/, (b) => (b.target_status === 'ACTIVE'
        ? [400, { error: 'Quality gate failed - question cannot be ACTIVE', validation_errors: ["Topic is not part of the question's syllabus version"] }] : [200, {}])],
      ['GET', /^\/review\/dashboard/, () => [200, { summary: {}, batches: [] }]],
    ]);
    const { page, calls, errors } = s;
    await page.getByText('Approved question', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Activate (quality gate)' }).click();
    await page.getByText(/Topic is not part/).waitFor();
    check('reviewer sees quality-gate reasons', true);
    check('reviewer: decisions on UNDER_REVIEW questions are pointed to Review batches', await page.getByText(/Record your verdict under Review batches/).isVisible());
    check('reviewer: no Reject button on the lifecycle screen', (await page.getByRole('button', { name: 'Reject', exact: true }).count()) === 0);
    check('reviewer: no actions on their own question', (await page.getByRole('button', { name: 'Activate (quality gate)' }).count()) === 1);
    await page.getByRole('button', { name: 'Request changes' }).first().click();
    const confirm = page.getByRole('button', { name: 'Confirm' });
    check('request changes requires a reason (confirm disabled)', await confirm.isDisabled());
    await page.getByLabel(/Reason \(request changes\)/).fill('Ambiguous wording');
    await confirm.click();
    await page.waitForTimeout(200);
    const t = calls.find((c) => c.method === 'POST' && /q3\/transition/.test(c.path) && c.body.target_status === 'CHANGES_REQUESTED');
    check('request changes posts its reason', t && t.body.reason === 'Ambiguous wording', JSON.stringify(t));
    check('reviewer: no legacy paper tabs', (await page.getByRole('button', { name: 'Generate paper' }).count()) === 0);
    check('reviewer: no page errors', errors.length === 0, errors.join('; '));
    await s.browser.close();
  }
  // ---- HOD: retire with a reason from the list; no paper approval tab ----
  {
    const s = await session({ id: 'h', email: 'h@x', role: 'hod' }, [
      ['GET', /^\/question-bank\/lifecycle/, () => [200, { questions: [{ id: 'q5', question_text: 'Active question', question_status: 'ACTIVE', is_mine: false, times_used: 2 }], counts: { ACTIVE: 1 } }]],
      ['GET', /retirement-reasons/, () => [200, ['Outdated', 'Incorrect']]],
      ['POST', /\/q5\/transition/, () => [200, {}]],
    ]);
    const { page, calls, errors } = s;
    await page.getByText('Active question').waitFor();
    await page.getByRole('button', { name: 'Retire', exact: true }).click();
    await page.getByLabel(/Reason \(retire\)/).selectOption('Incorrect');
    await page.getByRole('button', { name: 'Confirm' }).click();
    await page.waitForTimeout(200);
    const t = calls.find((c) => c.method === 'POST' && /q5\/transition/.test(c.path));
    check('HOD retire posts RETIRED with reason', t && t.body.target_status === 'RETIRED' && t.body.reason === 'Incorrect', JSON.stringify(t));
    await page.getByRole('button', { name: 'Review workspace' }).click();
    check('HOD: no legacy Paper approval tab', (await page.getByRole('button', { name: 'Paper approval' }).count()) === 0);
    check('HOD: no page errors', errors.length === 0, errors.join('; '));
    await s.browser.close();
  }
  // ---- COE: TOTP required, blockers shown, archive ----
  {
    let me = { id: 'c', email: 'coe@x', role: 'coe', totp_enabled: false };
    const paper = { id: 'p1', title: 'end_term paper v1', paper_status: 'VALIDATED', paper_version: 1, generation_seed: 's', generator_version: 'g', maximum_marks: 18, required_approvals: 4, questions: [{ question_id: 'q1', slot_number: 1, text: 'Q text', marks: 2 }] };
    const s = await session(me, [
      ['GET', /^\/examinations\/papers$/, () => [200, [{ id: 'p1', subject_code: 'CS1', exam_type: 'end_term', paper_version: 1, paper_status: paper.paper_status, validators: 4, approvals: 4, required_approvals: 4, open_issues: 1 }]]],
      ['GET', /^\/examinations\/papers\/p1$/, () => [200, paper]],
      ['GET', /^\/examinations\/papers\/p1\/issues/, () => [200, [{ id: 'i1', issue_type: 'spelling', description: 'typo', status: 'open' }]]],
      ['GET', /^\/examinations\/papers\/p1\/validators/, () => [200, []]],
      ['GET', /^\/examinations\/validators/, () => [200, []]],
      ['GET', /^\/examinations(\/offerings)?$/, () => [200, []]],
      ['GET', /^\/coe\/papers\/p1\/coe-status/, () => [200, { validator_approvals: 4, required_approvals: 4, blockers: paper.paper_status === 'VALIDATED' ? ['1 validator issue(s) are still open; resolve or close them first'] : [] }]],
      ['POST', /^\/auth\/totp\/setup/, () => [200, { secret: 'ABC', otpauth_url: 'otpauth://x' }]],
      ['POST', /^\/auth\/totp\/confirm/, () => { me.totp_enabled = true; return [200, {}]; }],
      ['POST', /^\/coe\/papers\/p1\/archive/, () => [200, { paper_status: 'ARCHIVED' }]],
    ]);
    const { page, calls, errors } = s;
    await page.getByText(/Final paper approval needs your authenticator/).waitFor();
    check('COE without TOTP sees setup prompt', true);
    await page.getByRole('button', { name: 'Papers', exact: true }).click();
    await page.getByText(/approvals 4\/4 needed/).waitFor();
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await page.getByText('Final COE approval').waitFor();
    await page.getByText(/validator issue\(s\) are still open/).first().waitFor();
    check('blockers listed on approval card', true);
    check('approval asks to set up TOTP instead of a code box', (await page.getByLabel('Authenticator code').count()) === 0 && await page.getByRole('button', { name: 'Set it up', exact: true }).isVisible());
    check('PDF buttons present (download, preview, print)', await page.getByRole('button', { name: 'Download paper', exact: true }).isVisible()
      && await page.getByRole('button', { name: 'Preview paper', exact: true }).isVisible() && await page.getByRole('button', { name: 'Print paper', exact: true }).isVisible());
    await page.getByRole('button', { name: 'Set it up', exact: true }).click();
    check('authenticator setup is disabled until the current password is entered', await page.getByRole('button', { name: 'Set up authenticator' }).isDisabled());
    await page.getByLabel('Current password').fill('Coe@123456');
    await page.getByRole('button', { name: 'Set up authenticator' }).click();
    // The click only starts the request: wait (up to 3 s) until the mock has recorded it, then check its body.
    // (Reading `calls` immediately after the click raced the request and failed intermittently.)
    let setupCall;
    for (let t = 0; t < 3000 && !setupCall; t += 50) {
      setupCall = calls.find((c) => c.method === 'POST' && c.path === '/auth/totp/setup');
      if (!setupCall) await page.waitForTimeout(50);
    }
    check('authenticator setup sends the current password (re-authentication)', setupCall && setupCall.body.current_password === 'Coe@123456', JSON.stringify(setupCall));
    await page.getByLabel(/6-digit code from the app/).fill('123456');
    await page.getByRole('button', { name: /Confirm/ }).click();
    await page.getByText(/Authenticator enabled\. A security notice was sent/).waitFor();
    await page.waitForTimeout(300);
    check('after enabling TOTP the warning disappears', (await page.getByText(/Final paper approval needs your authenticator/).count()) === 0);
    check('me refreshed after enabling TOTP', calls.filter((c) => c.path === '/auth/me').length >= 2);
    // archive flow on a PRINT_READY paper
    paper.paper_status = 'PRINT_READY';
    await page.getByRole('button', { name: 'Papers', exact: true }).click();
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await page.getByText('Archive', { exact: true }).waitFor();
    const archiveBtn = page.getByRole('button', { name: 'Archive paper' });
    check('archive needs a 10+ char reason', await archiveBtn.isDisabled());
    await page.locator('#archive-reason').fill('end of 2026 exam cycle');
    await archiveBtn.click();
    await page.getByText('Paper archived').waitFor();
    const a = calls.find((c) => c.method === 'POST' && /archive/.test(c.path));
    check('archive posts reason', a && a.body.reason === 'end of 2026 exam cycle', JSON.stringify(a));
    check('COE: no page errors', errors.length === 0, errors.join('; '));
    await s.browser.close();
  }
  // ---- Admin: accounts (no demo stub, every role, invitation instead of a password) ----
  {
    const s = await session({ id: 'a', email: 'a@x', role: 'admin' }, [
      ['GET', /^\/admin\/system/, () => [200, { users: [], papers: [], questions: [], recent_denials: [], migrations: { n: 37 }, attachments: [{ scan_status: 'failed', n: 2 }],
        readiness: { status: 'degraded', failing: [], checks: { database: 'ok', clamav: 'unavailable' }, protections: { upload_scanning: 'scanner unavailable: new uploads are quarantined' } } }]],
      ['GET', /^\/admin\/hierarchy/, () => [200, { campuses: [{ id: 'c1', name: 'Main', is_active: true }], departments: [{ id: 'd1', name: 'CSE', campus_id: 'c1' }], programs: [{ id: 'p1', name: 'BTech', campus_id: 'c1', department_id: 'd1' }] }]],
      ['GET', /^\/academic\/users/, () => [200, [{ id: 'u9', email: 'new@x', full_name: 'New Person', role: 'validator', is_active: true, must_change_password: true, scopes: [{ id: 's1', role: 'validator', campus_id: 'c1' }] }]]],
      ['POST', /^\/academic\/users$/, (b) => [201, { id: 'u10', email: b.email, role: b.role, invite_delivered: true, scopes: [] }]],
      ['POST', /^\/admin\/attachments\/rescan/, () => [200, { scanned: 2, clean: 2, infected: 0, failed: 0, missing: 0, conflict: 0 }]],
    ]);
    const { page, calls, errors } = s;
    await page.getByText('Protections').waitFor();
    check('admin system shows the active protections', await page.getByText(/new uploads are quarantined/).isVisible());
    await page.getByRole('button', { name: 'Rescan unscanned uploads' }).click();
    await page.getByText(/Rescanned 2: 2 clean/).waitFor();
    await page.getByRole('button', { name: 'Accounts', exact: true }).click();
    await page.getByText('Create a new account').waitFor();
    const roles = await page.getByLabel('Role', { exact: true }).locator('option').allTextContents();
    check('admin can provision COE and validator accounts', roles.includes('coe') && roles.includes('validator'), JSON.stringify(roles));
    check('no demo-mode password stub on the accounts screen', (await page.getByText(/Demo mode|Temporary password/).count()) === 0);
    check('create stays disabled until identity and placement are filled', await page.getByRole('button', { name: 'Create account' }).isDisabled());
    await page.getByLabel('Official email').fill('Val@x.edu'); await page.getByLabel('Full name').fill('Val One'); await page.getByLabel('Employee ID').fill('EMP-1');
    await page.getByLabel('Role', { exact: true }).selectOption('validator');
    await page.locator('#um-campus').selectOption('c1'); // home campus; it also prefills the first scope row
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByText(/A one-time setup code was emailed to Val@x.edu/).waitFor();
    const create = calls.find((c) => c.method === 'POST' && c.path === '/academic/users');
    check('create sends identity, campus and scope rows', create && create.body.employee_id === 'EMP-1' && create.body.campus_id === 'c1' && create.body.scopes?.[0]?.campus_id === 'c1', JSON.stringify(create));
    check('a pending account offers Resend invitation', await page.getByRole('button', { name: 'Resend invitation' }).isVisible());
    check('admin accounts: no page errors', errors.length === 0, errors.join('; '));
    await s.browser.close();
  }
  // ---- Forced password change can still sign out ----
  {
    const s = await session({ id: 't', email: 't@x', role: 'teacher', must_change_password: true }, []);
    const { page, calls, errors } = s;
    await page.getByText('You must set a new password').waitFor();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByText('Set up a new account').waitFor();
    check('forced password change screen offers Sign out (and signs out)', calls.some((c) => c.method === 'POST' && c.path === '/auth/logout'));
    check('forced change: no page errors', errors.length === 0, errors.join('; '));
    await s.browser.close();
  }
  // ---- Admin: validation policy ----
  {
    const s = await session({ id: 'a', email: 'a@x', role: 'admin' }, [
      ['GET', /^\/admin\/system/, () => [200, { users: [], papers: [], questions: [], recent_denials: [], migrations: { n: 37 } }]],
      ['GET', /^\/admin\/settings\/validation-policy/, () => [200, { required_approvals: 4 }]],
      ['PUT', /^\/admin\/settings\/validation-policy/, () => [200, { required_approvals: 3 }]],
    ]);
    const { page, calls, errors } = s;
    await page.getByRole('button', { name: 'Validation policy' }).click();
    await page.getByText(/Current:/).waitFor();
    await page.getByLabel('Required approvals').selectOption('3');
    const save = page.getByRole('button', { name: 'Save' });
    check('policy change needs a reason', await save.isDisabled());
    await page.locator('#policy-reason').fill('Senate resolution 12/2026');
    await save.click();
    await page.getByText('Policy updated').waitFor();
    const p = calls.find((c) => c.method === 'PUT');
    check('policy PUT carries value + reason', p && p.body.required_approvals === 3 && /Senate/.test(p.body.reason), JSON.stringify(p));
    check('admin: no page errors', errors.length === 0, errors.join('; '));
    await s.browser.close();
  }
  // ---- Teacher: 13 question types — type selector and type-specific fields reach the API ----
  {
    const s = await session({ id: 't', email: 't@x', role: 'teacher' }, [
      ['GET', /^\/academic\/my-assignments/, () => [200, [{ assignment_id: 'a1', course_offering_id: 'o1', section_id: null, subject_code: 'CS1', course_title: 'DS', program_code: 'BT', academic_session_label: '2026', semester: 3 }]]],
      ['POST', /^\/questions\/draft/, () => [200, { id: 'd1', created: true }]],
    ]);
    const { page, calls, errors } = s;
    await page.getByLabel('Question type').waitFor();
    const objectiveTypes = await page.getByLabel('Question type').locator('option').allTextContents();
    check('objective tab offers the 5 objective types', JSON.stringify(objectiveTypes) === JSON.stringify(['MCQ', 'True/False', 'Assertion-Reason', 'Fill in the Blank', 'Numerical']), JSON.stringify(objectiveTypes));
    await page.getByLabel('Question type').selectOption('numerical');
    await page.locator('textarea').first().fill('How many comparisons does binary search need for 1024 items?');
    await page.getByLabel('Expected answer').fill('11');
    await page.getByLabel('Unit (optional)').fill('comparisons');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await page.waitForTimeout(300);
    const d = calls.find((c) => c.method === 'POST' && /questions\/draft/.test(c.path));
    check('numerical draft sends type + answer_data', d && d.body.question_type === 'numerical' && d.body.answer_data.expected_value === 11 && d.body.answer_data.unit === 'comparisons', JSON.stringify(d && d.body));
    await page.getByRole('button', { name: 'Subjective questions' }).click();
    const subj = await page.getByLabel('Question type').locator('option').allTextContents();
    check('subjective tab offers the other 8 types', subj.length === 8 && subj.includes('Programming') && subj.includes('Diagram'), JSON.stringify(subj));
    await page.getByLabel('Question type').selectOption('programming');
    check('programming shows a language field', await page.getByLabel('Language').isVisible());
    check('teacher types: no page errors', errors.length === 0, errors.join('; '));
    await s.browser.close();
  }
  // ---- COE: sections, CO/Bloom targets and a recorded override reach the API ----
  {
    const s = await session({ id: 'c', email: 'coe@x', role: 'coe', totp_enabled: true }, [
      ['GET', /^\/examinations$/, () => [200, [{ id: 'e1', exam_type: 'end_term', subject_code: 'CS1', maximum_marks: 20, status: 'active', papers: 0 }]]],
      ['GET', /^\/examinations\/blueprints/, () => [200, [{ id: 'bp1', version_number: 1, easy_count: 4, medium_count: 3, hard_count: 1, total_marks: 20, is_active: true, sections: [{ name: 'Section A' }] }]]],
      ['POST', /^\/examinations\/blueprints/, () => [201, { id: 'bp2' }]],
      ['POST', /^\/examinations\/e1\/generate/, () => [422, { error: 'Paper cannot be generated', reasons: ['CO target CO4=1 but only 0 eligible question(s) map to CO4'] }]],
    ]);
    const { page, calls, errors } = s;
    await page.getByRole('button', { name: 'Blueprint & generate' }).click();
    await page.getByRole('button', { name: 'Add section' }).click();
    await page.getByRole('button', { name: 'Add section' }).click();
    await page.locator('#sec-n-0').fill('5'); await page.locator('#sec-mpq-0').fill('1');
    await page.locator('.card').filter({ has: page.locator('#sec-name-0') }).getByLabel('MCQ').check();
    await page.locator('#sec-n-1').fill('3'); await page.locator('#sec-total-1').fill('15');
    await page.locator('#bp-easy_count').fill('4'); await page.locator('#bp-medium_count').fill('3'); await page.locator('#bp-hard_count').fill('1'); // = the 8 section questions
    await page.locator('#bp-co').fill('CO1:3, co2=3');
    await page.locator('#bl-apply').fill('50'); await page.locator('#bl-remember').fill('50');
    const fix = page.locator('.alert-warn').filter({ hasText: 'Fix before saving' });
    check('the filled-in blueprint draft has no problems', (await fix.count()) === 0, (await fix.count()) ? await fix.innerText() : '');
    await page.getByRole('button', { name: 'Save as new blueprint version' }).click();
    await page.getByText('New blueprint version saved').waitFor();
    const b = calls.find((c) => c.method === 'POST' && /blueprints/.test(c.path)).body;
    check('blueprint sends 2 sections with their rules', b.sections.length === 2 && b.sections[0].question_types[0] === 'mcq' && b.sections[0].marks_per_question === 1 && b.sections[1].total_marks === 15 && b.sections[1].marks_per_question === undefined, JSON.stringify(b.sections));
    check('blueprint sends CO and Bloom targets', b.co_distribution.CO1 === 3 && b.co_distribution.CO2 === 3 && b.bloom_distribution.apply === 50, JSON.stringify([b.co_distribution, b.bloom_distribution]));
    await page.getByLabel(/Relax CO\/Bloom targets/).check();
    const gen = page.getByRole('button', { name: 'Generate paper' });
    check('override needs a dimension and a 10+ char reason before generating', await gen.isDisabled());
    await page.getByLabel('CO targets', { exact: true }).check();
    await page.locator('#gen-ov-reason').fill('New course, bank still being built');
    await gen.click();
    await page.getByText(/CO4=1 but only 0/).waitFor();
    const g = calls.find((c) => c.method === 'POST' && /generate/.test(c.path)).body;
    check('generate sends the override; generator reasons are shown', g.override.relax.join() === 'co' && /New course/.test(g.override.reason), JSON.stringify(g));
    check('COE blueprint: no page errors', errors.length === 0, errors.join('; '));
    await s.browser.close();
  }
  // ---- Validator: queue, paper review, PDF actions, issue report and decision ----
  {
    const FAKE_PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj '
      + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
    const paper = { id: 'p7', title: 'end_term CS1 v1', paper_status: 'VALIDATION_PENDING', paper_version: 1, maximum_marks: 6,
      my_assignment: { validator_number: 2, validation_round: 1, decision: null },
      questions: [{ question_id: 'q1', slot_number: 1, text: 'Define a binary search tree', marks: 2, meta: { question_type: 'short_answer', difficulty: 'easy', bloom_level: 'remember', topic: 'Trees' } },
        { question_id: 'q2', slot_number: 2, text: 'Prove AVL height is O(log n)', marks: 4, meta: { question_type: 'long_answer', difficulty: 'hard', bloom_level: 'evaluate', topic: 'Trees' } }] };
    const s = await session({ id: 'v', email: 'v@x', role: 'validator' }, [
      ['GET', /^\/validators\/my-validations/, () => [200, [
        { assignment_id: 'a1', paper_id: 'p7', subject_code: 'CS1', exam_type: 'end_term', paper_version: 1, paper_status: 'VALIDATION_PENDING', validator_number: 2, validation_round: 1, is_active: true, can_open: true },
        { assignment_id: 'a0', paper_id: 'p6', subject_code: 'CS0', exam_type: 'mid_term', paper_version: 2, paper_status: 'PRINT_READY', validator_number: 1, validation_round: 1, is_active: false, can_open: false, deactivation_reason: 'replaced' }]]],
      ['GET', /^\/examinations\/papers\/p7\/pdf/, () => [200, FAKE_PDF, 'application/pdf']],
      ['GET', /^\/examinations\/papers\/p7\/issues/, () => [200, []]],
      ['GET', /^\/examinations\/papers\/p7$/, () => [200, paper]],
      ['POST', /^\/examinations\/papers\/p7\/issues/, () => [201, { id: 'i1' }]],
      ['POST', /^\/validators\/papers\/p7\/validate/, () => [200, { decision: 'CHANGES_REQUIRED' }]],
    ]);
    const { page, calls, errors } = s;
    await page.getByText(/Assignment ended/).waitFor();
    check('validator queue explains an ended assignment and offers no Review for it', await page.getByText(/Assignment ended: replaced by the COE/).isVisible()
      && (await page.getByRole('button', { name: 'Review', exact: true }).count()) === 1);
    check('validator sees no authoring, COE or admin actions', (await page.getByRole('button', { name: /Generate paper|Save draft|Archive paper|Create account|Approve \(activate\)/ }).count()) === 0);
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await page.getByText('Prove AVL height is O(log n)').waitFor();
    check('validator review lists the paper questions', await page.getByText('Define a binary search tree').isVisible());
    check('validator PDF buttons present (download, preview, print with answer key)', await page.getByRole('button', { name: 'Download PDF with answer key' }).isVisible()
      && await page.getByRole('button', { name: 'Preview PDF with answer key' }).isVisible() && await page.getByRole('button', { name: 'Print PDF with answer key' }).isVisible());
    await page.getByRole('button', { name: 'Preview PDF with answer key' }).click();
    await page.locator('iframe[title="PDF with answer key preview"]').waitFor();
    const pv = calls.find((c) => c.method === 'GET' && /\/pdf/.test(c.path));
    check('preview fetches the answer-key PDF inline and shows it in a frame', pv && /include_answers=1/.test(pv.path) && /inline=1/.test(pv.path), JSON.stringify(pv));
    await page.getByRole('button', { name: 'Close PDF with answer key preview' }).click();
    check('preview can be closed', (await page.locator('iframe[title="PDF with answer key preview"]').count()) === 0);
    const approve = page.getByRole('button', { name: 'Approve', exact: true });
    const changes = page.getByRole('button', { name: 'Changes required', exact: true });
    check('approve stays disabled until every checklist item is ticked', await approve.isDisabled());
    check('changes required stays disabled without comments', await changes.isDisabled());
    const report = page.getByRole('button', { name: 'Report issue' });
    check('an issue needs a description of at least 5 characters', await report.isDisabled());
    await page.locator('#issue-q').selectOption('q2');
    await page.locator('#issue-type').selectOption('wrong_bloom');
    await page.locator('#issue-desc').fill('Bloom level should be analyze');
    await report.click();
    await page.getByText('Issue reported').waitFor();
    const iss = calls.find((c) => c.method === 'POST' && /\/issues/.test(c.path));
    check('issue report posts question, type and trimmed description', iss && iss.body.question_id === 'q2' && iss.body.issue_type === 'wrong_bloom' && iss.body.description === 'Bloom level should be analyze', JSON.stringify(iss));
    for (const box of await page.locator('.card').filter({ hasText: 'Your decision' }).locator('input[type=checkbox]').all()) await box.check();
    check('approve is enabled once the checklist is complete', await approve.isEnabled());
    await page.locator('#decision-comments').fill('Q2 Bloom level is wrong');
    await changes.click();
    await page.getByText('Changes requested', { exact: true }).waitFor();
    const dec = calls.find((c) => c.method === 'POST' && /\/validate$/.test(c.path));
    check('decision posts CHANGES_REQUIRED with the full checklist and comments', dec && dec.body.decision === 'CHANGES_REQUIRED' && dec.body.comments === 'Q2 Bloom level is wrong'
      && Object.keys(dec.body.checklist).length === 11, JSON.stringify(dec && dec.body));
    check('validator: no page errors', errors.length === 0, errors.join('; '));
    await s.browser.close();
  }
  // ---- HOD: syllabus versions screen (every state, every stored content shape) and its change report ----
  {
    const OFF = 'o1';
    const versions = [
      { id: 'sv4', version_number: 4, status: 'DRAFT', extracted_units: null, created_at: '2026-10-01T10:00:00Z', uploaded_by_email: 'h@x', returned_reason: 'Unit 3 title is wrong' },
      { id: 'sv3', version_number: 3, status: 'HOD_REVIEW', extracted_units: '{"notes":"2027 revision","units":null}', created_at: '2026-09-01T10:00:00Z', verified_by_email: 't@x' },
      { id: 'sv2', version_number: 2, status: 'ACTIVE', extracted_units: { notes: 'Started from version 1', units: null }, created_at: '2026-08-01T10:00:00Z', approved_by_email: 'h@x', change_count: 2 },
      { id: 'sv1', version_number: 1, status: 'SUPERSEDED', extracted_units: 'plain text syllabus, not JSON', created_at: '2026-01-01T10:00:00Z', superseded_at: '2026-08-01T10:00:00Z', change_count: 0 },
      { id: 'sv0', version_number: 5, status: 'REJECTED', extracted_units: '', created_at: '2026-10-02T10:00:00Z', rejection_reason: 'Duplicate of version 4' },
    ];
    const tree = { version_number: 2, units: [{ id: 'u1', code: 'U1', title: 'Trees', topics: [{ id: 't1', title: 'AVL trees', subtopics: [{ id: 'st1', title: 'Rotations' }] }] }],
      course_outcomes: [{ id: 'co1', code: 'CO1', description: 'Analyse trees' }, { id: 'co2', code: 'CO2', description: 'Apply hashing' }] };
    const report = { version: { version_number: 2, course_offering_id: OFF }, previous_version: { version_number: 1 }, questions_remapped_unchanged: 5,
      changes: [{ id: 1, entity_type: 'topic', entity_id: 'Splay trees', change_type: 'REMOVED', match_rule: 'title', old_value: { title: 'Splay trees' }, new_value: null,
        affected_questions: [{ question_id: 'q9', question_text: 'Explain splaying', question_status: 'ACTIVE', action_taken: 'flagged', author_email: 'a@x', resolved: false }] },
      { id: 2, entity_type: 'course_outcome', entity_id: 'CO3', change_type: 'MODIFIED', match_rule: 'code', old_value: { description: 'old' }, new_value: { description: 'new' }, affected_questions: [] }] };
    const s = await session({ id: 'h', email: 'h@x', role: 'hod' }, [
      ['GET', /^\/question-bank\/lifecycle/, () => [200, { questions: [], counts: {} }]],
      ['GET', /^\/questions\/queue/, () => [200, []]],
      ['GET', /^\/academic\/course-offerings$/, () => [200, [{ course_offering_id: OFF, subject_code: 'CS1', course_title: 'Data Structures', academic_session_label: '2026-27', semester: 3 }]]],
      ['GET', /^\/academic\/syllabus-versions\?course_offering_id=o1/, () => [200, versions]],
      ['GET', /^\/academic\/syllabus-versions\/sv2\/changes/, () => [200, report]],
      ['GET', /^\/academic\/syllabus-versions\/[^/]+\/(course-outcomes|units)/, () => [200, []]],
      ['GET', /^\/academic\/course-offerings\/o1\/syllabus-tree/, () => [200, tree]],
      ['POST', /^\/academic\/syllabus-versions\/sv4\/verify/, () => [200, { status: 'TEACHER_VERIFIED' }]],
      ['POST', /^\/academic\/questions\/q9\/syllabus-mapping/, () => [200, { version_number: 2, generation_eligible: true }]],
    ]);
    const { page, calls, errors } = s;
    await page.getByRole('button', { name: 'Review workspace' }).click();
    await page.getByRole('button', { name: 'Manage academics' }).click();
    await page.getByRole('button', { name: 'Syllabus versions' }).click();
    await page.getByText('Version 4', { exact: true }).waitFor();
    check('syllabus versions screen renders every state without crashing', errors.length === 0 && (await page.locator('.card').filter({ hasText: /^Version \d/ }).count()) >= 5, errors.join('; '));
    check('state badges shown (Draft, In HOD review, Active, Superseded, Rejected)', await page.getByText('In HOD review', { exact: true }).isVisible()
      && await page.getByText('Superseded', { exact: true }).isVisible() && await page.getByText('Rejected', { exact: true }).isVisible());
    check('returned and rejected reasons are shown', await page.getByText(/Returned to draft: Unit 3 title is wrong/).isVisible() && await page.getByText(/Rejected: Duplicate of version 4/).isVisible());
    check('stored content of every shape is displayed (null, JSON string, object, plain text)', await page.getByText('(no content recorded)').first().isVisible()
      && await page.getByText(/2027 revision/).isVisible() && await page.getByText('plain text syllabus, not JSON').isVisible());
    check('only the ACTIVE version offers "New version from current"', await page.getByRole('button', { name: 'New version from current (version 2)' }).isVisible());
    check('state-appropriate actions: Verify (draft) and Approve (in review), one each', (await page.getByRole('button', { name: 'Verify content' }).count()) === 1
      && (await page.getByRole('button', { name: 'Approve (activate)' }).count()) === 1);
    await page.getByRole('button', { name: 'Verify content' }).click();
    await page.getByText('Verified. Send it for HOD review next.').waitFor();
    check('verify posts to the draft version', calls.some((c) => c.method === 'POST' && c.path === '/academic/syllabus-versions/sv4/verify'));
    await page.getByRole('button', { name: 'Changes from the previous version (2)' }).click();
    await page.getByText(/Version 2 replaced version 1/).waitFor();
    check('change report lists removed topic and its flagged question', await page.getByText(/Topic “Splay trees” removed/).isVisible() && await page.getByText('Explain splaying').isVisible());
    check('HOD gets Map and Retire on an affected ACTIVE question', await page.getByRole('button', { name: 'Map to version 2' }).isVisible() && await page.getByRole('button', { name: 'Retire', exact: true }).isVisible());
    check('syllabus versions: no page errors', errors.length === 0, errors.join('; '));
    await s.browser.close();
  }
  // ---- HOD: question mapping screen (ACTIVE questions without a verified mapping) ----
  {
    const tree = { version_number: 2, units: [{ id: 'u1', code: 'U1', title: 'Trees', topics: [{ id: 't1', title: 'AVL trees', subtopics: [{ id: 'st1', title: 'Rotations' }] }] }],
      course_outcomes: [{ id: 'co1', code: 'CO1', description: 'Analyse trees' }, { id: 'co2', code: 'CO2', description: 'Apply hashing' }] };
    const rows = [
      { id: 'q1', question_text: 'Explain AVL rotations', question_status: 'ACTIVE', kind: 'unverified_mapping', subject_code: 'CS1', offering_code: 'CS1-A', course_offering_id: 'o1', version_number: 2, current_version_id: 'sv2', current_version_number: 2, in_review_round: false, syllabus_changes: null },
      { id: 'q2', question_text: 'Legacy heap question', question_status: 'DRAFT', kind: 'no_syllabus_version', subject_code: 'CS1', course_offering_id: 'o1', current_version_id: 'sv2', current_version_number: 2, in_review_round: false },
      { id: 'q3', question_text: 'Question in review', question_status: 'SUBMITTED', kind: 'superseded_version', subject_code: 'CS1', course_offering_id: 'o1', version_number: 1, current_version_id: 'sv2', current_version_number: 2, in_review_round: true,
        syllabus_changes: [{ change_type: 'RENAMED', entity_type: 'topic', entity_id: 'Heaps' }] },
    ];
    const s = await session({ id: 'h', email: 'h@x', role: 'hod' }, [
      ['GET', /^\/question-bank\/lifecycle/, () => [200, { questions: [], counts: {} }]],
      ['GET', /^\/questions\/queue/, () => [200, []]],
      ['GET', /^\/academic\/course-offerings$/, () => [200, [{ course_offering_id: 'o1', subject_code: 'CS1', course_title: 'Data Structures', academic_session_label: '2026-27', semester: 3 }]]],
      ['GET', /^\/academic\/question-mapping/, (b, p) => [200, { questions: /kind=unverified_mapping/.test(p) ? rows.slice(0, 1) : rows }]],
      ['GET', /^\/academic\/course-offerings\/o1\/syllabus-tree/, () => [200, tree]],
      ['POST', /^\/academic\/questions\/q1\/syllabus-mapping/, () => [200, { version_number: 2, generation_eligible: true }]],
    ]);
    const { page, calls, errors } = s;
    await page.getByRole('button', { name: 'Review workspace' }).click();
    await page.getByRole('button', { name: 'Manage academics' }).click();
    await page.getByRole('button', { name: 'Question mapping' }).click();
    await page.getByText('Explain AVL rotations').waitFor();
    const meta = (re) => page.locator('.meta').filter({ hasText: re });
    check('mapping list shows why each question needs mapping', await meta(/Mapping not reviewer-verified · CS1 CS1-A · on version 2 · current version 2/).isVisible()
      && await meta(/No syllabus version \(legacy\)/).isVisible() && await meta(/affected by: Topic “Heaps” renamed/).isVisible());
    check('only mappable questions outside a review round get a Map button', (await page.getByRole('button', { name: 'Map', exact: true }).count()) === 1
      && await page.getByText('In an open review round: its reviewers decide first.').isVisible() && await page.getByText('The author re-maps it by editing it.').isVisible());
    await page.locator('#map-kind').selectOption('unverified_mapping');
    await page.waitForTimeout(200);
    check('kind filter is sent to the server', calls.some((c) => c.method === 'GET' && /question-mapping\?kind=unverified_mapping/.test(c.path)));
    await page.getByRole('button', { name: 'Map', exact: true }).click();
    await page.locator('#map-q1-unit').waitFor();
    const mapBtn = page.getByRole('button', { name: 'Map question' });
    check('mapping needs topic, primary CO and a 10+ char reason', await mapBtn.isDisabled());
    await page.locator('#map-q1-unit').selectOption('u1');
    await page.locator('#map-q1-topic').selectOption('t1');
    await page.locator('#map-q1-subtopic').selectOption('st1');
    await page.locator('#map-q1-co').selectOption('co1');
    await page.getByLabel('CO2', { exact: true }).check();
    await page.locator('#map-q1-bloom').selectOption('analyze');
    await page.locator('#map-q1-reason').fill('short');
    check('a short reason keeps mapping disabled', await mapBtn.isDisabled());
    await page.locator('#map-q1-reason').fill('Topic unchanged in version 2');
    await mapBtn.click();
    await page.getByText(/Mapped to version 2\. It is generation-eligible\./).waitFor();
    const m = calls.find((c) => c.method === 'POST' && /syllabus-mapping/.test(c.path));
    check('mapping posts unit, topic, subtopic, COs, Bloom and reason', m && m.body.syllabus_unit_id === 'u1' && m.body.syllabus_topic_id === 't1' && m.body.syllabus_subtopic_id === 'st1'
      && m.body.primary_course_outcome_id === 'co1' && m.body.secondary_course_outcome_ids.join() === 'co2' && m.body.bloom_level === 'analyze' && m.body.reason === 'Topic unchanged in version 2', JSON.stringify(m && m.body));
    check('question mapping: no page errors', errors.length === 0, errors.join('; '));
    await s.browser.close();
  }
  // ---- Admin: technical only, no academic action anywhere it can navigate ----
  {
    const s = await session({ id: 'a', email: 'a@x', role: 'admin' }, [
      ['GET', /^\/admin\/system/, () => [200, { users: [], papers: [], questions: [], recent_denials: [], migrations: { n: 42 } }]],
      ['GET', /^\/admin\/hierarchy/, () => [200, { campuses: [], departments: [], programs: [] }]],
      ['GET', /^\/admin\/settings\/validation-policy/, () => [200, { required_approvals: 4 }]],
      ['GET', /^\/admin\/settings\/validator-independence/, () => [200, {}]],
    ]);
    const { page, errors } = s;
    await page.getByText('Technical administration').waitFor();
    const ACADEMIC = /^(Approve|Approve \(activate\)|Activate.*|Retire|Reject|Request changes|Generate paper|Map|Map question|Map to version.*|Verify content|Submit for HOD review|New version from current.*|Save draft|Submit|Create review batch|\+ Create review batch|Assign people|Syllabus versions|Question mapping|Previous-year papers|Review batches|Question lifecycle|Changes required|Archive paper|Final approval.*|Send back.*|Report issue)$/;
    const seen = new Set();
    const offending = new Set();
    const sweep = async () => {
      for (const name of await page.getByRole('button').allInnerTexts()) { const n = name.trim(); seen.add(n); if (ACADEMIC.test(n)) offending.add(n); }
    };
    for (const tab of ['System', 'Accounts', 'Access scopes', 'Validation policy', 'Emergency override', 'Structure & security']) {
      await page.getByRole('button', { name: tab, exact: true }).click();
      await page.waitForTimeout(150);
      await sweep();
      if (tab === 'Structure & security') {
        for (const sub of ['Manage academics', 'Build hierarchy', 'User accounts', 'Security & audit', 'Threat monitor', 'Authenticator setup']) {
          const b = page.getByRole('button', { name: sub, exact: true });
          if (await b.count()) { await b.first().click(); await page.waitForTimeout(150); await sweep(); }
        }
      }
    }
    check('admin sees no academic action buttons on any tab', offending.size === 0, [...offending].join(', '));
    check('admin navigation reached the structure screens (sweep is not vacuous)', seen.has('Build hierarchy') && seen.has('Create account') && seen.has('Rescan unscanned uploads'), [...seen].join(' | '));
    check('admin sweep: no page errors', errors.length === 0, errors.join('; '));
    await s.browser.close();
  }
  // ---- HOD: upload the official syllabus PDF; the extraction is shown for review, nothing is activated ----
  {
    const OFF = 'o1';
    const created = { version: { id: 'sv7', version_number: 3, status: 'DRAFT' }, extraction_id: 9,
      course: { code: 'TCS 571', title: 'Big Data Visualization', semester: 5, pages: [130, 131], total_hours: 46,
        course_outcomes: [{ code: 'CO1', text: 'Create and adapt visualizations to represent complex data sets.' }, { code: 'CO2', text: 'Analyze data using visualizations.' }],
        units: [{ number: 1, hours: 10, topics: 6 }, { number: 2, hours: 10, topics: 7, label_missing_in_source: true }] },
      warnings: ['Unit 2 has no "Unit 2" label in the source; it was identified by its row number'],
      next: 'Review the extracted COs, units and topics, correct anything that differs from the PDF, then verify, submit and approve the version.' };
    let uploads = 0;
    const s = await session({ id: 'h', email: 'h@x', role: 'hod' }, [
      ['GET', /^\/question-bank\/lifecycle/, () => [200, { questions: [], counts: {} }]],
      ['GET', /^\/questions\/queue/, () => [200, []]],
      ['GET', /^\/academic\/course-offerings$/, () => [200, [{ course_offering_id: OFF, subject_code: 'TCS 571', course_title: 'Big Data Visualization', academic_session_label: '2026-27', semester: 5 }]]],
      ['GET', /^\/academic\/syllabus-versions\?course_offering_id=o1/, () => [200, uploads ? [{ id: 'sv7', version_number: 3, status: 'DRAFT', created_at: '2026-10-23T10:00:00Z',
        uploaded_by_email: 'h@x', extracted_units: { source: 'pdf', pages: [130, 131], file_sha256: 'ab', units: [] } }] : []]],
      ['GET', /^\/academic\/syllabus-versions\/[^/]+\/(course-outcomes|units)/, () => [200, []]],
      ['POST', /^\/academic\/course-offerings\/o1\/syllabus-upload/, () => (++uploads === 1
        ? [422, { error: 'The PDF does not contain the syllabus of TCS 571. Check that this is the right document.', courses_found: [{ code: 'TCS 101', title: 'Intro', semester: 1, pages: [1, 3] }, { code: 'TCS 201', title: 'PPS', semester: 2, pages: [4, 6] }] }]
        : [201, created])],
    ]);
    const { page, calls, errors } = s;
    await page.getByRole('button', { name: 'Review workspace' }).click();
    await page.getByRole('button', { name: 'Manage academics' }).click();
    await page.getByRole('button', { name: 'Syllabus versions' }).click();
    await page.getByText('Upload the official syllabus (PDF)').waitFor();
    check('upload: disabled until a file is chosen', await page.getByRole('button', { name: 'Upload and extract' }).isDisabled());
    const pdf = { name: 'Syllabus-2023.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 demo') };
    await page.locator('#syl-upload-file').setInputFiles(pdf);
    await page.getByRole('button', { name: 'Upload and extract' }).click();
    await page.getByText(/does not contain the syllabus of TCS 571/).waitFor();
    check('upload: the wrong document is explained and the courses it contains are listed', await page.getByText('Courses found in this PDF (2)').isVisible());
    await page.locator('#syl-upload-file').setInputFiles(pdf);
    await page.getByRole('button', { name: 'Upload and extract' }).click();
    await page.getByText(/Version 3 created as a draft from TCS 571 Big Data Visualization/).waitFor();
    await page.getByRole('button', { name: 'View the official PDF (pages 130–131)' }).waitFor({ timeout: 5000 }).catch(() => {}); // the version list reloads after the upload
    check('upload: posts multipart to the offering\'s upload route', calls.filter((c) => c.method === 'POST' && c.path === '/academic/course-offerings/o1/syllabus-upload').length === 2);
    check('upload: printed COs, units with hours and the warnings are shown for review',
      await page.getByText('Create and adapt visualizations to represent complex data sets.').isVisible()
      && await page.getByText('Unit 2 (no label in the PDF)').isVisible() && await page.getByText(/identified by its row number/).first().isVisible());
    check('upload: the new draft shows its steps and a link to the official PDF', await page.getByRole('button', { name: 'View the official PDF (pages 130–131)' }).isVisible()
      && await page.getByText('Review and correct the content').isVisible());
    check('upload: nothing is approved by the upload', !calls.some((c) => c.method === 'POST' && /\/(verify|submit-review|approve)$/.test(c.path)));
    check('upload: no page errors', errors.length === 0, errors.join('; '));
    await s.browser.close();
  }
  // ---- Teacher: the official syllabus is read-only ----
  {
    const s = await session({ id: 't', email: 't@x', role: 'teacher' }, [
      ['GET', /^\/academic\/my-assignments/, () => [200, [{ assignment_id: 'a1', course_offering_id: 'o1', section_id: null, subject_code: 'TCS 571', course_title: 'Big Data Visualization', program_code: 'BT', academic_session_label: '2026-27', semester: 5 }]]],
      ['GET', /^\/question-bank\/lifecycle/, () => [200, { questions: [], counts: {} }]],
      ['GET', /^\/academic\/course-offerings\/o1\/syllabus-tree/, () => [200, { version_number: 2,
        units: [{ id: 'u1', code: 'U1', title: 'Unit 1: Techniques', topics: [{ id: 't1', title: 'Metaphor Visualization', subtopics: [] }] }],
        course_outcomes: [{ id: 'co1', code: 'CO1', description: 'Create and adapt visualizations to represent complex data sets.' }] }]],
      ['GET', /^\/academic\/syllabus-versions\?course_offering_id=o1/, () => [200, [{ id: 'sv2', version_number: 2, status: 'ACTIVE', extracted_units: { source: 'pdf', pages: [130, 131] } },
        { id: 'sv3', version_number: 3, status: 'DRAFT', extracted_units: null }]]],
    ]);
    const { page, calls, errors } = s;
    await page.getByRole('button', { name: 'Syllabus', exact: true }).click();
    await page.getByText('Official syllabus', { exact: true }).waitFor();
    await page.getByText('Create and adapt visualizations to represent complex data sets.').waitFor({ timeout: 5000 }).catch(() => {});
    await page.getByText(/A new version is being prepared by your HOD/).waitFor({ timeout: 5000 }).catch(() => {});
    check('teacher syllabus: read-only (no create, verify or submit controls)', (await page.getByRole('button', { name: /Submit new version|Verify|Send for HOD review|Upload/ }).count()) === 0);
    check('teacher syllabus: the active version\'s COs and topics are shown', await page.getByText('Create and adapt visualizations to represent complex data sets.').isVisible());
    check('teacher syllabus: the HOD\'s pending version is mentioned, the active one stays in force', await page.getByText(/A new version is being prepared by your HOD/).isVisible());
    check('teacher syllabus: link to the official PDF', await page.getByRole('button', { name: 'View the official PDF (pages 130–131)' }).isVisible());
    check('teacher syllabus: no writes', !calls.some((c) => c.method !== 'GET' && /syllabus/.test(c.path)));
    check('teacher syllabus: no page errors', errors.length === 0, errors.join('; '));
    await s.browser.close();
  }
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error('E2E aborted:', e.message); process.exit(2); });
