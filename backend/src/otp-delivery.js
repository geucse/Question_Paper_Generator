// The one place that decides how a login code, password-reset code or account-setup code leaves the server.
// Codes are never put in an API response and never written to a log in full, except by the explicit,
// development-only console mode below.
//
// Providers (OTP_DELIVERY_PROVIDER):
//   smtp     Real email through nodemailer. Required in production (the server refuses to start otherwise).
//            SMTP_HOST, SMTP_PORT and SMTP_FROM are required; SMTP_USER/SMTP_PASS together or not at all
//            (an unauthenticated internal relay). SMTP_SECURE=true for implicit TLS (port 465); otherwise
//            STARTTLS is required unless SMTP_REQUIRE_TLS=false.
//   console  Development only, and only with the explicit flag DEV_OTP_CONSOLE:
//              DEV_OTP_CONSOLE=masked (or true)  logs 'code=12****' (enough to see delivery happened)
//              DEV_OTP_CONSOLE=reveal            logs the full code, so a developer can sign in locally
//            NODE_ENV=production ignores the flag and refuses to start.
// With neither configured outside production, delivery throws OtpDeliveryError('not_configured') and the
// routes answer 503 instead of pretending a code was sent.
//
// DEV_EXPOSE_ACCOUNT_SETUP_TOKEN=true (development only, never honoured in production) additionally returns the
// one-time account-setup code in the account-creation response, for local testing without a mail server.

export class OtpDeliveryError extends Error {
  // kind: 'not_configured' | 'send_failed'. The message never contains the destination or the code.
  constructor(kind) {
    super(kind === 'not_configured' ? 'Code delivery is not configured' : 'Code delivery failed');
    this.name = 'OtpDeliveryError';
    this.kind = kind;
  }
}

const isProd = (env) => env.NODE_ENV === 'production';

export function resolveDeliveryConfig(env = process.env) {
  const flag = String(env.DEV_OTP_CONSOLE || '').trim().toLowerCase();
  const consoleMode = isProd(env) ? null : flag === 'reveal' ? 'reveal' : ['masked', 'true'].includes(flag) ? 'masked' : null;
  const provider = env.OTP_DELIVERY_PROVIDER || (isProd(env) ? 'smtp' : consoleMode ? 'console' : 'none');
  return { provider, consoleMode };
}

function smtpProblems(env) {
  const p = [];
  if (!env.SMTP_HOST) p.push('SMTP_HOST is required for SMTP delivery');
  if (!/^\d+$/.test(String(env.SMTP_PORT || ''))) p.push('SMTP_PORT must be a port number');
  if (!env.SMTP_FROM) p.push('SMTP_FROM is required for SMTP delivery');
  if (!!env.SMTP_USER !== !!env.SMTP_PASS) p.push('SMTP_USER and SMTP_PASS must be set together (or both left empty for an unauthenticated relay)');
  return p;
}

// Configuration problems as messages naming variables (never values). In production every problem refuses startup.
export function otpDeliveryProblems(env = process.env) {
  const { provider, consoleMode } = resolveDeliveryConfig(env);
  const p = [];
  if (isProd(env)) {
    if (provider !== 'smtp') p.push('OTP_DELIVERY_PROVIDER must be "smtp" in production (login and reset codes must be emailed)');
    if (env.DEV_OTP_CONSOLE) p.push('DEV_OTP_CONSOLE must not be set in production');
    if (env.DEV_EXPOSE_ACCOUNT_SETUP_TOKEN && env.DEV_EXPOSE_ACCOUNT_SETUP_TOKEN !== 'false') p.push('DEV_EXPOSE_ACCOUNT_SETUP_TOKEN must not be set in production');
    if (provider === 'smtp') p.push(...smtpProblems(env));
    return p;
  }
  if (provider === 'smtp') p.push(...smtpProblems(env));
  else if (provider === 'console') { if (!consoleMode) p.push('OTP_DELIVERY_PROVIDER=console needs DEV_OTP_CONSOLE=masked or DEV_OTP_CONSOLE=reveal (development only)'); }
  else if (provider === 'none') p.push('No code delivery configured: set OTP_DELIVERY_PROVIDER=smtp with SMTP_*, or DEV_OTP_CONSOLE=reveal for local development');
  else p.push('OTP_DELIVERY_PROVIDER must be "smtp" or "console"');
  return p;
}

export function otpDeliveryStatus(env = process.env) {
  const { provider } = resolveDeliveryConfig(env);
  const configured = otpDeliveryProblems(env).length === 0;
  return { provider: ['smtp', 'console'].includes(provider) ? provider : 'none', configured };
}

// Startup check: production throws (the caller refuses to start); elsewhere it only warns.
export function assertOtpDeliveryConfig(env = process.env) {
  const problems = otpDeliveryProblems(env);
  if (!problems.length) {
    const { provider, consoleMode } = resolveDeliveryConfig(env);
    if (provider === 'console') console.warn(`[otp-delivery] development console delivery (${consoleMode}); codes are not emailed`);
    return;
  }
  if (isProd(env)) throw new Error(`OTP delivery is misconfigured: ${problems.join('; ')}`);
  console.warn(`[otp-delivery] ${problems.join('; ')}. Sign-in, password reset and invitations will answer 503 until this is set.`);
}

export const devSecretsExposed = (env = process.env) => env.NODE_ENV !== 'production' && env.DEV_EXPOSE_ACCOUNT_SETUP_TOKEN === 'true';

export const maskCode = (c) => { const s = String(c); return s.length <= 8 ? s.slice(0, 2) + '*'.repeat(Math.max(0, s.length - 2)) : `${s.slice(0, 4)}…`; };
export function maskEmail(e) {
  const s = String(e || ''); const at = s.indexOf('@');
  return at > 0 ? `${s[0]}***@${s.slice(at + 1)}` : '***';
}

let transport = null;
let transportForTests = null;
async function getTransport(env) {
  if (transportForTests) return transportForTests;
  if (!transport) {
    const nodemailer = (await import('nodemailer')).default;
    transport = nodemailer.createTransport({
      host: env.SMTP_HOST, port: Number(env.SMTP_PORT),
      secure: env.SMTP_SECURE === 'true',
      requireTLS: env.SMTP_SECURE !== 'true' && env.SMTP_REQUIRE_TLS !== 'false',
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  }
  return transport;
}
export function setTransportForTests(t) {
  if (process.env.NODE_ENV !== 'test') throw new Error('setTransportForTests is for tests only');
  transportForTests = t;
}

const SUBJECTS = {
  login: 'Your Exam Portal login code',
  password_reset: 'Your Exam Portal password reset code',
  account_setup: 'Your Exam Portal account is ready',
};
function bodyFor(purpose, code, env) {
  if (purpose === 'account_setup') {
    const hours = Number(env.ACCOUNT_INVITE_TTL_HOURS) || 72;
    return `Your Exam Portal account is ready. Your one-time setup code is:\n\n${code}\n\nOpen ${env.PORTAL_URL || 'the portal'}, choose "Set up a new account" and enter this code to choose your password. It expires in ${hours} hours and works once. If you did not expect this, ignore this email.`;
  }
  if (purpose === 'password_reset') {
    return `Your password reset code is:\n\n${code}\n\nIt expires in 30 minutes and can only be used once. If you did not request this, you can ignore this email.`;
  }
  return `Your login code is: ${code}\n\nIt expires in 5 minutes and can only be used once. If you did not try to sign in, someone may know your password: change it.`;
}

// destination: the user's email. purpose: 'login' | 'password_reset' | 'account_setup'.
export async function deliverCode(destination, code, purpose, env = process.env) {
  const { provider, consoleMode } = resolveDeliveryConfig(env);
  if (provider === 'smtp' && !smtpProblems(env).length) {
    try {
      const t = await getTransport(env);
      await t.sendMail({ from: env.SMTP_FROM, to: destination, subject: SUBJECTS[purpose] || 'Your Exam Portal code', text: bodyFor(purpose, code, env) });
      return { delivered: true, provider: 'smtp' };
    } catch (err) {
      console.error(`[otp-delivery] smtp send failed purpose=${purpose} to=${maskEmail(destination)} err=${err?.code || err?.responseCode || 'error'}`);
      throw new OtpDeliveryError('send_failed');
    }
  }
  if (provider === 'console' && consoleMode) {
    console.log(`[otp-delivery:console] purpose=${purpose} to=${maskEmail(destination)} code=${consoleMode === 'reveal' ? code : maskCode(code)}`);
    return { delivered: true, provider: 'console' };
  }
  throw new OtpDeliveryError('not_configured');
}

const NOTICES = {
  totp_changed: ['Your authenticator app was changed', 'The authenticator app used for your Exam Portal approvals was just changed. If this was not you, contact the administrator immediately.'],
  password_changed: ['Your password was changed', 'The password of your Exam Portal account was just changed. If this was not you, reset it now and contact the administrator.'],
  account_locked: ['Your account was locked', 'Too many incorrect passwords were entered from a signed-in session of your Exam Portal account. Sign-in is paused for 15 minutes and every session was signed out. If this was not you, reset your password and contact the administrator.'],
  totp_reset: ['Your authenticator was reset', 'The administrator reset the authenticator app of your Exam Portal account. Set it up again before your next approval. If you did not ask for this, contact the administrator immediately.'],
};
// Security notices carry no code or secret. Best effort: false on any failure, never throws.
export async function deliverNotice(destination, kind, env = process.env) {
  const [subject, text] = NOTICES[kind] || [];
  if (!subject) return false;
  const { provider, consoleMode } = resolveDeliveryConfig(env);
  try {
    if (provider === 'smtp' && !smtpProblems(env).length) {
      await (await getTransport(env)).sendMail({ from: env.SMTP_FROM, to: destination, subject, text });
      return true;
    }
    if (provider === 'console' && consoleMode) {
      console.log(`[otp-delivery:console] notice=${kind} to=${maskEmail(destination)}`);
      return true;
    }
  } catch (err) {
    console.error(`[otp-delivery] notice ${kind} to=${maskEmail(destination)} failed err=${err?.code || err?.responseCode || 'error'}`);
  }
  return false;
}
