import { useState } from 'react';
import { api } from './api';

export default function ChangePasswordModal({ token, onClose, force, onSuccess, onLogout }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(null); setNotice(null);
    if (newPassword !== confirmPassword) {
      setError('New password and confirmation do not match.');
      return;
    }
    setLoading(true);
    try {
      const res = await api.post('/auth/change-password', { current_password: currentPassword, new_password: newPassword }, token);
      setNotice('Password changed successfully.');
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
      if (onSuccess) await onSuccess(res.token);
    } catch (e) {
      setError(e.data?.details ? `${e.message}: ${e.data.details.join(', ')}` : e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="ge-dialog-backdrop" onClick={force ? undefined : onClose}
      onKeyDown={(e) => { if (e.key === 'Escape' && !force && onClose) onClose(); }}>
      <div className="login-card" role="dialog" aria-modal="true" aria-labelledby="cp-title" style={{ maxWidth: 400, width: '100%' }} onClick={e => e.stopPropagation()}>
        <h1 id="cp-title" style={{ fontSize: '1.3rem', marginBottom: 12 }}>{force ? 'You must set a new password' : 'Change password'}</h1>
        {force && (
          <p className="hint" style={{ marginBottom: 12 }}>
            This account has to choose a new password before it can be used. Enter the current password you were
            given and choose a new one; the rest of the portal stays locked until you do.
          </p>
        )}
        {error && <div className="alert alert-error">{error}</div>}
        {notice && <div className="alert alert-ok">{notice}</div>}
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="cp-current">Current password</label>
            <input id="cp-current" type="password" autoFocus autoComplete="current-password" required value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="cp-new">New password</label>
            <input id="cp-new" type="password" autoComplete="new-password" required value={newPassword} onChange={e => setNewPassword(e.target.value)} />
            <p className="hint">At least 10 characters, with an uppercase letter, a lowercase letter, and a number.</p>
          </div>
          <div className="field">
            <label htmlFor="cp-confirm">Confirm new password</label>
            <input id="cp-confirm" type="password" autoComplete="new-password" required value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} />
          </div>
          <button className="btn-primary" type="submit" disabled={loading} style={{ width: '100%' }}>
            {loading ? 'Updating...' : 'Update password'}
          </button>
          {!force && (
            <button type="button" className="btn-ghost btn-sm" style={{ width: '100%', marginTop: 8 }} onClick={onClose}>
              Close
            </button>
          )}
          {force && onLogout && (
            <button type="button" className="btn-ghost btn-sm" style={{ width: '100%', marginTop: 8 }} onClick={onLogout}>
              Sign out
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
