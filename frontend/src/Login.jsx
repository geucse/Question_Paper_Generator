import { useState } from 'react';
import { api } from './api';
import BrandMark from './components/shell/BrandMark';
import { BRAND } from './brand';

// The sign-in frame: institution name or approved logo, the screen's title and a statement of how sign-in works.
function LoginFrame({ title, sub, children }) {
  return (
    <div className="login-wrap">
      <div className="login-stack">
        <main className="login-card" aria-labelledby="login-title">
          <div className="login-brand">
            <BrandMark product={false} />
            <h1 id="login-title">{title}</h1>
            <p className="login-sub">{sub}</p>
          </div>
          {children}
        </main>
        <p className="login-foot">{BRAND.product}. Authorised staff only; every sign-in is confirmed with a one-time code.</p>
      </div>
    </div>
  );
}

export default function Login({ onLogin }) {
  const [mode, setMode] = useState('login'); // 'login' | 'forgot' | 'setup' (redeem the code from an invitation email)
  const [step, setStep] = useState(1);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [pendingUserId, setPendingUserId] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [loading, setLoading] = useState(false);

  // ---- Forgot-password state ----
  const [resetStep, setResetStep] = useState(1);
  const [resetEmail, setResetEmail] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');

  async function submitPassword(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api.post('/auth/login/password', { email, password });
      setPendingUserId(res.otp_pending_for);
      setNotice(res.message);
      setStep(2);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function submitOtp(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api.post('/auth/login/otp', { userId: pendingUserId, code: otp });
      onLogin(res.token, res.user);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function switchToForgot() {
    setMode('forgot'); setError(null); setNotice(null);
    setResetStep(1); setResetEmail(email); setResetToken(''); setNewPassword('');
  }

  // An invited account redeems its one-time setup code with the same confirm call as a reset code.
  function switchToSetup() {
    setMode('setup'); setError(null); setNotice(null);
    setResetStep(2); setResetEmail(email); setResetToken(''); setNewPassword('');
  }

  function backToLogin() {
    setMode('login'); setError(null); setNotice(null); setStep(1);
  }

  async function requestReset(e) {
    e.preventDefault();
    setError(null); setNotice(null); setLoading(true);
    try {
      const res = await api.post('/auth/password-reset/request', { email: resetEmail });
      setNotice(res.message);
      // Always advance to step 2 regardless of whether the account exists —
      // the backend deliberately gives the same response either way, so the
      // UI must not use "did we get a token back" as a signal either.
      setResetStep(2);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function confirmReset(e) {
    e.preventDefault();
    setError(null); setLoading(true);
    try {
      await api.post('/auth/password-reset/confirm', { token: resetToken.trim(), new_password: newPassword });
      setNotice(mode === 'setup' ? 'Your account is ready. Sign in with your email and the password you just chose.' : 'Password updated. You can now sign in with your new password.');
      setMode('login');
      setPassword('');
      setEmail(resetEmail);
      setStep(1);
    } catch (e) {
      setError(e.data?.details ? `${e.message}: ${e.data.details.join(', ')}` : e.message);
    } finally {
      setLoading(false);
    }
  }

  if (mode === 'forgot' || mode === 'setup') {
    const setup = mode === 'setup';
    return (
      <LoginFrame title={setup ? 'Set up your account' : 'Reset your password'}
        sub={setup ? 'Enter the setup code from your invitation email' : resetStep === 1 ? "We'll send a reset code to your registered email." : 'Enter the code and choose a new password.'}>

          {error && <div className="alert alert-error">{error}</div>}
          {notice && <div className="alert alert-ok">{notice}</div>}

          {resetStep === 1 && (
            <form onSubmit={requestReset}>
              <div className="field">
                <label htmlFor="reset-email">Email</label>
                <input id="reset-email" type="email" autoComplete="email" required value={resetEmail} onChange={e => setResetEmail(e.target.value)} />
              </div>
              <button className="btn-primary" type="submit" disabled={loading} style={{ width: '100%' }}>
                {loading ? 'Sending...' : 'Send reset link'}
              </button>
              <button type="button" className="btn-ghost btn-sm" style={{ width: '100%', marginTop: 8 }} onClick={backToLogin}>
                Back to sign in
              </button>
            </form>
          )}

          {resetStep === 2 && (
            <form onSubmit={confirmReset}>
              <p className="hint">
                {setup ? 'The code was emailed to you when your account was created (valid 72 hours, single use). Ask your administrator to resend it if it expired.'
                  : 'Check your email for the reset code (valid 30 minutes, single use).'}
              </p>
              <div className="field">
                <label htmlFor="reset-code">{setup ? 'Setup code' : 'Reset code'}</label>
                <input id="reset-code" required value={resetToken} onChange={e => setResetToken(e.target.value)} className="mono" autoComplete="one-time-code" />
              </div>
              <div className="field">
                <label htmlFor="reset-new-password">{setup ? 'Choose a password' : 'New password'}</label>
                <input id="reset-new-password" type="password" autoComplete="new-password" required value={newPassword} onChange={e => setNewPassword(e.target.value)} />
                <p className="hint">At least 10 characters, with an uppercase letter, a lowercase letter, and a number.</p>
              </div>
              <button className="btn-primary" type="submit" disabled={loading} style={{ width: '100%' }}>
                {loading ? 'Updating...' : setup ? 'Set password' : 'Update password'}
              </button>
              <button type="button" className="btn-ghost btn-sm" style={{ width: '100%', marginTop: 8 }} onClick={backToLogin}>
                Back to sign in
              </button>
            </form>
          )}
      </LoginFrame>
    );
  }

  return (
    <LoginFrame title="Sign in" sub={`${BRAND.product}: question bank and examinations`}>
        <div className="step-indicator" aria-label={`Step ${step} of 2`} role="img">
          <span className={step >= 1 ? 'done' : ''} />
          <span className={step >= 2 ? 'done' : ''} />
        </div>

        {error && <div className="alert alert-error">{error}</div>}
        {notice && <div className="alert alert-ok">{notice}</div>}

        {step === 1 && (
          <form onSubmit={submitPassword}>
            <div className="field">
              <label htmlFor="login-email">Email</label>
              <input id="login-email" type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="login-password">Password</label>
              <input id="login-password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} />
            </div>
            <button className="btn-primary" type="submit" disabled={loading} style={{ width: '100%' }}>
              {loading ? 'Checking...' : 'Continue'}
            </button>
            <button type="button" className="btn-ghost btn-sm" style={{ width: '100%', marginTop: 8 }} onClick={switchToForgot}>
              Forgot password?
            </button>
            <button type="button" className="btn-ghost btn-sm" style={{ width: '100%', marginTop: 8 }} onClick={switchToSetup}>
              Set up a new account
            </button>
          </form>
        )}

        {step === 2 && (
          <form onSubmit={submitOtp}>
            <p className="hint">
              Check your email for the sign-in code. (Local development without a mail server: start the backend with
              DEV_OTP_CONSOLE=reveal and read the code from its log; see backend/.env.example.)
            </p>
            <div className="field">
              <label htmlFor="login-otp">Enter the 6-digit code</label>
              <input
                id="login-otp" type="text" inputMode="numeric" autoComplete="one-time-code" required maxLength={6} value={otp}
                onChange={e => setOtp(e.target.value.replace(/\D/g, ''))}
                placeholder="000000" className="mono" style={{ letterSpacing: '0.3em', fontSize: '1.1rem', textAlign: 'center' }}
              />
              <p className="hint">Code expires in 5 minutes. 3 incorrect attempts will invalidate it.</p>
            </div>
            <button className="btn-primary" type="submit" disabled={loading || otp.length !== 6} style={{ width: '100%' }}>
              {loading ? 'Verifying...' : 'Verify & Sign in'}
            </button>
            <button type="button" className="btn-ghost btn-sm" style={{ width: '100%', marginTop: 8 }} onClick={() => setStep(1)}>
              Back
            </button>
          </form>
        )}
    </LoginFrame>
  );
}
