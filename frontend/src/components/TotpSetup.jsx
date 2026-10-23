import { useState } from 'react';
import { api } from '../api';

// Authenticator (TOTP, RFC 6238) enrolment. Shared by every role that can turn it on;
// the COE must enable it before final paper approval (PIVOT_SPEC_V2 §29).
// Setting up an authenticator needs the current password. Replacing an ENABLED one needs a current code from it
// (the password alone is not enough); someone who lost it asks the administrator to reset it, after which the
// password is enough again. The existing authenticator keeps working until the new one is confirmed.
export default function TotpSetup({ token, user, purpose, onEnabled }) {
  const [secret, setSecret] = useState(null);
  const [uri, setUri] = useState(null);
  const [code, setCode] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [currentTotp, setCurrentTotp] = useState('');
  const [enabled, setEnabled] = useState(!!user?.totp_enabled);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);

  async function start() {
    setError(null); setDone(false);
    try {
      const body = replacing ? { current_totp: currentTotp } : { current_password: currentPassword };
      const res = await api.post('/auth/totp/setup', body, token);
      setSecret(res.secret);
      setUri(res.otpauth_url);
      setCurrentPassword(''); setCurrentTotp('');
    } catch (e) { setError(e.data?.error || e.message); }
  }

  async function confirm() {
    setError(null);
    try {
      await api.post('/auth/totp/confirm', { code }, token);
      setEnabled(true); setDone(true);
      setSecret(null); setUri(null); setCode('');
      if (onEnabled) onEnabled();
    } catch (e) { setError(e.data?.error || e.message); }
  }

  // After a confirmed enrolment in this session the authenticator is enabled and no longer flagged for re-enrolment.
  const replacing = enabled && (done || !user?.totp_reenroll_required);
  const canStart = replacing ? currentTotp.length === 6 : currentPassword.length > 0;
  return (
    <div className="card">
      <h3 className="section-title">Authenticator app (TOTP)</h3>
      <p className="hint" style={{ marginBottom: 12 }}>
        {purpose || 'Adds a second factor to sensitive actions.'} Add this account to Google Authenticator, Authy,
        or any RFC 6238-compatible app.
      </p>
      {user?.totp_reenroll_required && !enabled && (
        <div className="alert alert-warn">Your authenticator was reset during a security upgrade; set it up again.</div>
      )}
      {done && <div className="alert alert-ok">Authenticator enabled. A security notice was sent to your email.</div>}
      {enabled && !done && !secret && <div className="alert alert-ok">Authenticator is enabled for this account.</div>}
      {!secret && (
        <div>
          {replacing ? (
            <div className="field">
              <label htmlFor="totp-current-code">A current code from your authenticator app</label>
              <input id="totp-current-code" className="mono" maxLength={6} inputMode="numeric" value={currentTotp} onChange={(e) => setCurrentTotp(e.target.value.replace(/\D/g, ''))} />
            </div>
          ) : (
            <div className="field">
              <label htmlFor="totp-current-password">Current password</label>
              <input id="totp-current-password" type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
            </div>
          )}
          <button className="btn-primary" onClick={start} disabled={!canStart}>{replacing ? 'Replace authenticator' : 'Set up authenticator'}</button>
          {replacing && <p className="hint" style={{ marginTop: 6 }}>Your current authenticator keeps working until the new one is confirmed. Lost it? Ask the administrator to reset your authenticator; you can then set up a new one with your password.</p>}
        </div>
      )}
      {secret && (
        <div>
          <p className="hint">Enter this secret key in your authenticator app (shown once; this setup expires in 10 minutes):</p>
          <p className="mono" style={{ background: '#eef1f7', padding: 10, borderRadius: 6, wordBreak: 'break-all' }}>{secret}</p>
          <p className="hint" style={{ marginTop: 6 }}>Or use this URI: <span className="mono">{uri}</span></p>
          <div className="field" style={{ marginTop: 10 }}>
            <label htmlFor="totp-confirm">Enter the 6-digit code from the app to confirm</label>
            <input id="totp-confirm" className="mono" maxLength={6} inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          </div>
          <button className="btn-primary" onClick={confirm} disabled={code.length !== 6}>Confirm &amp; enable</button>
        </div>
      )}
      {error && <div className="alert alert-error" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}
