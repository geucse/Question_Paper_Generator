import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';

// Account administration (PIVOT_SPEC_V2 §2, §4, §5). Admin provisions every role with its scopes; an HOD
// provisions teacher/reviewer accounts in its own department. New accounts receive a one-time setup code by email
// and choose their own password: no password is ever shown here.
const ADMIN_ROLES = ['teacher', 'reviewer', 'hod', 'coe', 'validator', 'admin'];
const HOD_ROLES = ['teacher', 'reviewer'];
const NEEDS_DEPARTMENT = ['teacher', 'reviewer', 'hod'];
const SCOPED_ROLES = ['coe', 'validator'];
const emptyForm = () => ({ email: '', full_name: '', employee_id: '', role: 'teacher', campus_id: '', department_id: '', access_deadline: '', scopes: [{ campus_id: '', department_id: '', program_id: '' }] });

function ScopeRows({ rows, onChange, hierarchy, idPrefix }) {
  const set = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="field" style={{ gridColumn: '1 / -1' }}>
      <label>Scope (where this person may act; at least one row)</label>
      {rows.map((r, i) => (
        <div className="row" key={i} style={{ gap: 8, alignItems: 'flex-end' }}>
          <div className="field"><label htmlFor={`${idPrefix}-campus-${i}`}>Campus</label>
            <select id={`${idPrefix}-campus-${i}`} value={r.campus_id} onChange={(e) => set(i, { campus_id: e.target.value, department_id: '', program_id: '' })}>
              <option value="">— choose —</option>
              {hierarchy.campuses.filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></div>
          <div className="field"><label htmlFor={`${idPrefix}-dept-${i}`}>Department (optional)</label>
            <select id={`${idPrefix}-dept-${i}`} value={r.department_id} disabled={!r.campus_id} onChange={(e) => set(i, { department_id: e.target.value, program_id: '' })}>
              <option value="">Whole campus</option>
              {hierarchy.departments.filter((d) => d.campus_id === r.campus_id).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select></div>
          <div className="field"><label htmlFor={`${idPrefix}-prog-${i}`}>Program (optional)</label>
            <select id={`${idPrefix}-prog-${i}`} value={r.program_id} disabled={!r.campus_id} onChange={(e) => set(i, { program_id: e.target.value })}>
              <option value="">All programs</option>
              {hierarchy.programs.filter((p) => p.campus_id === r.campus_id && (!r.department_id || p.department_id === r.department_id))
                .map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></div>
          {rows.length > 1 && <button type="button" className="btn-ghost btn-sm" onClick={() => onChange(rows.filter((_, j) => j !== i))}>Remove</button>}
        </div>
      ))}
      <button type="button" className="btn-ghost btn-sm" onClick={() => onChange([...rows, { campus_id: '', department_id: '', program_id: '' }])} disabled={rows.length >= 20}>Add scope row</button>
    </div>
  );
}

const cleanRows = (rows) => rows.filter((r) => r.campus_id).map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v)));

export default function UserManagement({ token, user }) {
  const isAdmin = user.role === 'admin';
  const [users, setUsers] = useState([]);
  const [hierarchy, setHierarchy] = useState({ campuses: [], departments: [], programs: [] });
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [created, setCreated] = useState(null);
  const [roleEdit, setRoleEdit] = useState(null);

  // Users first, then (admin) the hierarchy; any failure becomes the screen error. Never rejects.
  const load = useCallback(() => api.get('/academic/users', token)
    .then((rows) => {
      setUsers(rows);
      return isAdmin ? api.get('/admin/hierarchy', token).then(setHierarchy) : undefined;
    })
    .catch((e) => setError(e.data?.error || e.message)), [token, isAdmin]);
  useEffect(() => { load(); }, [load]);

  const names = useMemo(() => ({
    campus: Object.fromEntries(hierarchy.campuses.map((c) => [c.id, c.name])),
    dept: Object.fromEntries(hierarchy.departments.map((d) => [d.id, d.name])),
    prog: Object.fromEntries(hierarchy.programs.map((p) => [p.id, p.name])),
  }), [hierarchy]);

  const roles = isAdmin ? ADMIN_ROLES : HOD_ROLES;
  const identityOk = form.email.includes('@') && form.full_name.trim().length >= 2 && form.employee_id.trim().length >= 2;
  const placementOk = !isAdmin || (form.campus_id && (!NEEDS_DEPARTMENT.includes(form.role) || form.department_id)
    && (!SCOPED_ROLES.includes(form.role) || cleanRows(form.scopes).length > 0));

  async function createUser() {
    setError(null); setNotice(null); setCreated(null);
    const body = { email: form.email, full_name: form.full_name, employee_id: form.employee_id, role: form.role };
    if (isAdmin) {
      body.campus_id = form.campus_id;
      if (form.department_id) body.department_id = form.department_id;
      if (SCOPED_ROLES.includes(form.role)) body.scopes = cleanRows(form.scopes);
    }
    if (form.role === 'teacher' && form.access_deadline) body.access_deadline = new Date(`${form.access_deadline}T23:59:59`).toISOString();
    try {
      const res = await api.post('/academic/users', body, token);
      setCreated(res);
      setForm(emptyForm());
      await load();
    } catch (e) { setError(e.data?.error || e.message); }
  }

  async function resend(u) {
    setError(null); setNotice(null);
    try {
      const res = await api.post(`/academic/users/${u.id}/resend-invite`, null, token);
      setNotice(res.invite_delivered ? `A new setup code was emailed to ${u.email}; earlier codes no longer work.` : 'The invitation email could not be sent. Check the mail settings and try again.');
      if (res.dev_setup_token) setCreated({ email: u.email, invite_delivered: res.invite_delivered, dev_setup_token: res.dev_setup_token });
    } catch (e) { setError(e.data?.error || e.message); }
  }

  async function deactivate(u) {
    const reason = window.prompt(`Deactivate ${u.email}? Their sessions end and every scope is revoked. Reason (recorded in the audit log):`);
    if (reason === null) return;
    setError(null); setNotice(null);
    try {
      const res = await api.post(`/academic/users/${u.id}/deactivate`, { reason }, token);
      setNotice(`${u.email} deactivated; ${res.revoked_scopes} scope(s) revoked.`);
      await load();
    } catch (e) { setError(e.data?.error || e.message); }
  }

  async function resetAuthenticator(u) {
    const reason = window.prompt(`Reset the authenticator of ${u.email}? Their sessions end and they must set up a new authenticator (with their password) before their next approval. Reason, at least 10 characters (recorded in the audit log):`);
    if (reason === null) return;
    setError(null); setNotice(null);
    try {
      const res = await api.post(`/academic/users/${u.id}/reset-authenticator`, { reason }, token);
      setNotice(`Authenticator of ${u.email} reset; ${res.notice_sent ? 'they were notified by email' : 'the email notice could not be sent (they still see an in-app notice)'}.`);
      await load();
    } catch (e) { setError(e.data?.error || e.message); }
  }

  // Admin incident response: end every session of this account now (POST /auth/users/:id/force-logout).
  async function forceLogout(u) {
    if (!window.confirm(`Sign ${u.email} out of every session now? They can sign in again with their password.`)) return;
    setError(null); setNotice(null);
    try {
      await api.post(`/auth/users/${u.id}/force-logout`, null, token);
      setNotice(`Every session of ${u.email} was signed out.`);
    } catch (e) { setError(e.data?.error || e.message); }
  }

  async function reactivate(u) {
    setError(null); setNotice(null);
    try {
      const res = await api.post(`/academic/users/${u.id}/reactivate`, null, token);
      setNotice(res.needs_scope_grant
        ? `${u.email} reactivated. COE and validator scopes are not restored automatically: grant them again under Access scopes.`
        : `${u.email} reactivated; ${res.restored_scopes} scope(s) restored.`);
      await load();
    } catch (e) { setError(e.data?.error || e.message); }
  }

  async function changeRole() {
    setError(null); setNotice(null);
    const body = { role: roleEdit.role, campus_id: roleEdit.campus_id, reason: roleEdit.reason };
    if (roleEdit.department_id) body.department_id = roleEdit.department_id;
    if (SCOPED_ROLES.includes(roleEdit.role)) body.scopes = cleanRows(roleEdit.scopes);
    try {
      await api.post(`/academic/users/${roleEdit.id}/role`, body, token);
      setNotice(`Role changed to ${roleEdit.role}. The person's sessions ended; earlier scopes and assignments were revoked.`);
      setRoleEdit(null);
      await load();
    } catch (e) { setError(e.data?.error || e.message); }
  }

  const scopeLabel = (s) => [names.campus[s.campus_id] || 'campus', s.department_id && (names.dept[s.department_id] || 'department'),
    s.program_id && (names.prog[s.program_id] || 'program'), s.course_offering_id && 'offering'].filter(Boolean).join(' / ');
  const roleEditOk = roleEdit && roleEdit.reason.trim().length >= 10 && roleEdit.campus_id
    && (!NEEDS_DEPARTMENT.includes(roleEdit.role) || roleEdit.department_id);

  return (
    <div>
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 className="section-title">Create a new account</h3>
        <p className="hint" style={{ marginBottom: 12 }}>
          There is no public sign-up. The new person receives a one-time setup code by email (valid 72 hours) and chooses
          their own password on the sign-in page under "Set up a new account".
          {!isAdmin && ' Accounts you create belong to your department.'}
        </p>
        <div className="grid-2">
          <div className="field"><label htmlFor="um-email">Official email</label><input id="um-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@institution.edu" /></div>
          <div className="field"><label htmlFor="um-name">Full name</label><input id="um-name" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></div>
          <div className="field"><label htmlFor="um-emp">Employee ID</label><input id="um-emp" value={form.employee_id} onChange={(e) => setForm({ ...form, employee_id: e.target.value })} /></div>
          <div className="field"><label htmlFor="um-role">Role</label>
            <select id="um-role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {roles.map((r) => <option key={r} value={r}>{r}</option>)}
            </select></div>
          {isAdmin && (
            <div className="field"><label htmlFor="um-campus">Campus</label>
              <select id="um-campus" value={form.campus_id} onChange={(e) => setForm({ ...form, campus_id: e.target.value, department_id: '', scopes: [{ campus_id: e.target.value, department_id: '', program_id: '' }] })}>
                <option value="">— choose —</option>
                {hierarchy.campuses.filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></div>
          )}
          {isAdmin && form.role !== 'admin' && !SCOPED_ROLES.includes(form.role) && (
            <div className="field"><label htmlFor="um-dept">Department</label>
              <select id="um-dept" value={form.department_id} disabled={!form.campus_id} onChange={(e) => setForm({ ...form, department_id: e.target.value })}>
                <option value="">— choose —</option>
                {hierarchy.departments.filter((d) => d.campus_id === form.campus_id).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select></div>
          )}
          {form.role === 'teacher' && (
            <div className="field"><label htmlFor="um-deadline">Access deadline (optional)</label><input id="um-deadline" type="date" value={form.access_deadline} onChange={(e) => setForm({ ...form, access_deadline: e.target.value })} /></div>
          )}
          {isAdmin && SCOPED_ROLES.includes(form.role) && (
            <ScopeRows rows={form.scopes} hierarchy={hierarchy} idPrefix="um-scope" onChange={(scopes) => setForm({ ...form, scopes })} />
          )}
        </div>
        {form.role === 'teacher' && <p className="hint">Teachers get course access when the HOD assigns them to a course offering.</p>}
        {error && <div className="alert alert-error">{error}</div>}
        {notice && <div className="alert alert-ok">{notice}</div>}
        {created && (created.invite_delivered
          ? <div className="alert alert-ok">Account created. A one-time setup code was emailed to {created.email} (valid 72 hours).</div>
          : <div className="alert alert-warn">Account created, but the invitation email could not be sent. Use "Resend invitation" once mail delivery works.</div>)}
        {created?.dev_setup_token && (
          <div className="card" style={{ background: '#f4f6fa' }}>
            Development only: DEV_EXPOSE_ACCOUNT_SETUP_TOKEN is enabled on this server. Setup code for {created.email}: <code className="mono" style={{ wordBreak: 'break-all' }}>{created.dev_setup_token}</code>
          </div>
        )}
        <button className="btn-primary" onClick={createUser} disabled={!identityOk || !placementOk}>Create account</button>
      </div>

      <h3 className="section-title">Existing accounts</h3>
      {users.length === 0 && <p className="hint">No accounts to show.</p>}
      {users.map((u) => (
        <div className="list-item" key={u.id} style={{ flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div>{u.full_name || u.email} <span className="badge badge-draft" style={{ textTransform: 'capitalize' }}>{u.role}</span></div>
            <div className="meta">
              {u.email}{u.employee_id ? ` · ${u.employee_id}` : ''} · {u.campus_name || 'No campus'}{u.department_name ? ` / ${u.department_name}` : ''}
              {' · '}{u.is_active ? 'Active' : 'Deactivated'}
              {u.must_change_password ? ' · Awaiting account setup' : ''}
              {u.access_deadline ? ` · Access until ${new Date(u.access_deadline).toLocaleDateString()}` : ''}
              {u.totp_enabled ? ' · Authenticator on' : u.totp_reenroll_required ? ' · Authenticator must be set up again' : ''}
            </div>
            {(u.scopes || []).length > 0 && (
              <div className="meta">{u.scopes.map((s) => <span key={s.id} className="badge badge-pending" style={{ marginRight: 4 }}>{s.role}: {scopeLabel(s)}</span>)}</div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {u.is_active && u.must_change_password && <button className="btn-ghost btn-sm" onClick={() => resend(u)}>Resend invitation</button>}
            {isAdmin && u.id !== user.id && <button className="btn-ghost btn-sm" onClick={() => setRoleEdit({ id: u.id, email: u.email, role: u.role === 'validator' ? 'coe' : 'validator', campus_id: u.campus_id || '', department_id: '', reason: '', scopes: [{ campus_id: u.campus_id || '', department_id: '', program_id: '' }] })}>Change role</button>}
            {isAdmin && u.id !== user.id && u.is_active && u.totp_enabled && <button className="btn-ghost btn-sm" onClick={() => resetAuthenticator(u)}>Reset authenticator</button>}
            {isAdmin && u.id !== user.id && u.is_active && <button className="btn-ghost btn-sm" onClick={() => forceLogout(u)}>Sign out everywhere</button>}
            {u.id !== user.id && (u.is_active
              ? <button className="btn-danger btn-sm" onClick={() => deactivate(u)}>Deactivate</button>
              : <button className="btn-primary btn-sm" onClick={() => reactivate(u)}>Reactivate</button>)}
          </div>
          {roleEdit?.id === u.id && (
            <div className="card" style={{ width: '100%', marginTop: 8 }}>
              <h4>Change the role of {u.email}</h4>
              <p className="hint">Every current scope and role assignment of this person ends, and their sessions are signed out.</p>
              <div className="grid-2">
                <div className="field"><label htmlFor="re-role">New role</label>
                  <select id="re-role" value={roleEdit.role} onChange={(e) => setRoleEdit({ ...roleEdit, role: e.target.value })}>
                    {ADMIN_ROLES.filter((r) => r !== u.role).map((r) => <option key={r} value={r}>{r}</option>)}
                  </select></div>
                <div className="field"><label htmlFor="re-campus">Campus</label>
                  <select id="re-campus" value={roleEdit.campus_id} onChange={(e) => setRoleEdit({ ...roleEdit, campus_id: e.target.value, department_id: '' })}>
                    <option value="">— choose —</option>
                    {hierarchy.campuses.filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select></div>
                {NEEDS_DEPARTMENT.includes(roleEdit.role) && (
                  <div className="field"><label htmlFor="re-dept">Department</label>
                    <select id="re-dept" value={roleEdit.department_id} onChange={(e) => setRoleEdit({ ...roleEdit, department_id: e.target.value })}>
                      <option value="">— choose —</option>
                      {hierarchy.departments.filter((d) => d.campus_id === roleEdit.campus_id).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select></div>
                )}
                {SCOPED_ROLES.includes(roleEdit.role) && (
                  <ScopeRows rows={roleEdit.scopes} hierarchy={hierarchy} idPrefix="re-scope" onChange={(scopes) => setRoleEdit({ ...roleEdit, scopes })} />
                )}
                <div className="field" style={{ gridColumn: '1 / -1' }}><label htmlFor="re-reason">Reason (at least 10 characters, audited)</label>
                  <input id="re-reason" value={roleEdit.reason} onChange={(e) => setRoleEdit({ ...roleEdit, reason: e.target.value })} /></div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-primary" disabled={!roleEditOk} onClick={changeRole}>Change role</button>
                <button className="btn-ghost" onClick={() => setRoleEdit(null)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
