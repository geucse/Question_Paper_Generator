import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { authenticator } from 'otplib';

// Startup fails in every environment (not only production) if JWT_SECRET is missing or shorter than 32 characters.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error(
    'JWT_SECRET is missing or too short. ' +
    'A strong secret (min 32 characters) is required in every environment. ' +
    'Set JWT_SECRET in your .env file.'
  );
}
const JWT_ISSUER = 'exam-portal-api';
const JWT_AUDIENCE = 'exam-portal-app';

export async function hashPassword(pw) {
  return argon2.hash(pw, { type: argon2.argon2id });
}

export async function verifyPassword(hash, pw) {
  try {
    return await argon2.verify(hash, pw);
  } catch {
    return false;
  }
}

export function hashCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

export function generateOtp() {
  return String(crypto.randomInt(100000, 999999));
}

// issuer/audience/algorithm are fixed and always checked on verify — a
// token signed for a different service, or with a different algorithm,
// is rejected outright rather than silently accepted (spec section 12:
// "issuer/audience validation + restricted algorithms").
export function signJwt(payload, expiresIn) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn, issuer: JWT_ISSUER, audience: JWT_AUDIENCE, algorithm: 'HS256' });
}

export function verifyJwt(token) {
  return jwt.verify(token, JWT_SECRET, { issuer: JWT_ISSUER, audience: JWT_AUDIENCE, algorithms: ['HS256'] });
}

export function generateTotpSecret() {
  return authenticator.generateSecret();
}

export function totpKeyUri(secret, email, issuer = 'ExamPortal') {
  return authenticator.keyuri(email, issuer, secret);
}

// A verifier with its own options: the global authenticator's options are never mutated (that would change
// every other caller's window). window 1 = the previous, current and next 30-second step.
const totpVerifier = authenticator.clone({ window: 1 });

// Step offset (-1, 0, 1) of a valid code, or null. Replay protection uses currentTotpStep() + delta.
export function totpDelta(secret, token) {
  if (typeof token !== 'string' || !/^\d{6}$/.test(token) || !secret) return null;
  try {
    const d = totpVerifier.checkDelta(token, secret);
    return Number.isInteger(d) ? d : null;
  } catch {
    return null;
  }
}
export const currentTotpStep = (now = Date.now()) => Math.floor(now / 30000);

export function verifyTotp(secret, token) {
  return totpDelta(secret, token) !== null;
}

// Constant-time comparison of two hex digests (OTP and reset-code hashes).
export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !/^[0-9a-f]*$/i.test(a + b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

// Session length: at most 8 hours, and never past the account's access_deadline (any role that has one).
// 0 means the deadline has passed: no session may be issued.
export const SESSION_MAX_SECONDS = 8 * 3600;
export function sessionLifetimeSeconds(user, now = Date.now()) {
  if (!user?.access_deadline) return SESSION_MAX_SECONDS;
  const left = Math.floor((new Date(user.access_deadline).getTime() - now) / 1000);
  return Math.max(0, Math.min(SESSION_MAX_SECONDS, left));
}
export function issueSession(user) {
  const seconds = sessionLifetimeSeconds(user);
  if (seconds <= 0) return null;
  return signJwt({ sub: user.id, role: user.role, tv: user.token_version }, seconds);
}

// Verified against for an unknown email, so a missing account costs the same time as a wrong password.
let dummyHash = null;
export async function dummyPasswordHash() {
  if (!dummyHash) dummyHash = hashPassword(crypto.randomBytes(16).toString('hex'));
  return dummyHash;
}

export function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Deliberately simple, deterministic rules rather than a complex scoring
// library — easy to state to a user in one sentence, easy to test.
export function validatePasswordStrength(password, email) {
  const errors = [];
  if (!password || password.length < 10) errors.push('must be at least 10 characters');
  if (!/[a-z]/.test(password)) errors.push('must include a lowercase letter');
  if (!/[A-Z]/.test(password)) errors.push('must include an uppercase letter');
  if (!/[0-9]/.test(password)) errors.push('must include a number');
  if (email && password.toLowerCase().includes(email.split('@')[0].toLowerCase())) {
    errors.push('must not contain your email username');
  }
  return errors;
}

// Reset tokens are random, single-use, and stored hashed (same pattern as
// OTP codes) — never compared or logged in plaintext.
export function generateResetToken() {
  return crypto.randomBytes(32).toString('hex');
}

// One-time account-setup code for an invited account (same shape and storage as a reset token: 256 bits,
// stored only as its SHA-256 hash in otp_codes).
export const generateSetupToken = generateResetToken;

// Normalize question text (lowercase, strip whitespace/punctuation) before hashing,
// so trivial rewording still collides for exact-duplicate detection.
export function normalizeQuestionHash(text) {
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}
