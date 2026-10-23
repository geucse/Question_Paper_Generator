// Encryption at rest for TOTP secrets (AES-256-GCM). Format: 'v1.<iv b64url>.<tag b64url>.<ciphertext b64url>'.
// The additional authenticated data binds a ciphertext to its account ('totp:<user id>'), so a sealed secret
// copied onto another user's row does not open. Migration 040 refuses any non-sealed value in users.totp_secret.
//
// Key: TOTP_ENCRYPTION_KEY (32 bytes, 64 hex characters or base64). Required in production (startup refuses
// without it). Outside production a missing key is derived from JWT_SECRET with HKDF, with a one-time warning,
// so local development works without extra setup. Rotating the key means every user re-enrols their
// authenticator; there is deliberately no multi-key ring.
import crypto from 'crypto';
import { parseKey32, isProduction } from './runtime-config.js';

export class SecretBoxError extends Error {
  constructor(message = 'Sealed secret cannot be opened') { super(message); this.name = 'SecretBoxError'; }
}

const b64u = (buf) => buf.toString('base64url');
const SEALED_RE = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]+)$/;

export function totpKeyProblems(env = process.env) {
  if (!env.TOTP_ENCRYPTION_KEY) {
    return isProduction(env) ? ['TOTP_ENCRYPTION_KEY is required in production (32 bytes, hex or base64: openssl rand -hex 32)'] : [];
  }
  return parseKey32(env.TOTP_ENCRYPTION_KEY) ? [] : ['TOTP_ENCRYPTION_KEY must be exactly 32 bytes, given as 64 hex characters or base64'];
}

let cachedKey = null;
let warned = false;
export function loadTotpKey(env = process.env) {
  if (cachedKey && env === process.env) return cachedKey;
  let key;
  if (env.TOTP_ENCRYPTION_KEY) {
    key = parseKey32(env.TOTP_ENCRYPTION_KEY);
    if (!key) throw new Error('TOTP_ENCRYPTION_KEY must be exactly 32 bytes, given as 64 hex characters or base64');
  } else if (isProduction(env)) {
    throw new Error('TOTP_ENCRYPTION_KEY is required in production (32 bytes, hex or base64): openssl rand -hex 32');
  } else {
    if (!env.JWT_SECRET) throw new Error('JWT_SECRET is required to derive the development TOTP key');
    key = Buffer.from(crypto.hkdfSync('sha256', env.JWT_SECRET, 'exam-portal-dev', 'totp-secret-v1', 32));
    if (!warned && env === process.env) {
      warned = true;
      console.warn('[totp] TOTP_ENCRYPTION_KEY is not set: authenticator secrets are encrypted with a development key derived from JWT_SECRET. Set TOTP_ENCRYPTION_KEY (openssl rand -hex 32) before real use.');
    }
  }
  if (env === process.env) cachedKey = key;
  return key;
}

export function sealSecret(plain, aad, key = loadTotpKey()) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(aad)));
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `v1.${b64u(iv)}.${b64u(cipher.getAuthTag())}.${b64u(ct)}`;
}

export function openSecret(sealed, aad, key = loadTotpKey()) {
  const m = SEALED_RE.exec(typeof sealed === 'string' ? sealed : '');
  if (!m) throw new SecretBoxError('Stored secret is not in the sealed format');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(m[1], 'base64url'));
    decipher.setAAD(Buffer.from(String(aad)));
    decipher.setAuthTag(Buffer.from(m[2], 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(m[3], 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretBoxError();
  }
}

export function __resetKeyForTests() {
  if (process.env.NODE_ENV !== 'test') throw new Error('test only');
  cachedKey = null; warned = false;
}
