// Request ids, the central error handler and log hygiene (implementation prompt §2/§4: no secrets or internal
// errors in logs or responses). Responses carry a generic message and the request id; the server log carries a
// single JSON line with the error's name, code, constraint and a credential-redacted message. Never pg's
// `detail`/`where` (they contain row values), query parameters or request bodies.
import crypto from 'crypto';
import { flagSuspicious } from './security.js';
import { redact, redactUrl } from './redact.js';

export function requestId(req, res, next) {
  req.id = crypto.randomUUID(); // never trust an inbound id
  res.setHeader('X-Request-Id', req.id);
  next();
}

export { redact, redactUrl };

export function describeError(err, { withStack = false } = {}) {
  const out = {
    name: err?.name,
    code: err?.code,
    constraint: err?.constraint,
    table: err?.table,
    message: redact(err?.message ?? err).slice(0, 300),
  };
  if (withStack && err?.stack) out.stack = redact(err.stack);
  return out;
}

const PG = {
  '22P02': [400, 'Invalid identifier or value'],
  '22001': [400, 'A value is too long'],
  '22003': [400, 'A number is out of range'],
  '22007': [400, 'Invalid date or time'],
  '22008': [400, 'Invalid date or time'],
  '23502': [400, 'A required value is missing'],
  '23514': [400, 'A value is not allowed'],
  '23503': [409, 'A referenced record does not exist or is still in use'],
  '23505': [409, 'A record with these details already exists'],
  '40001': [409, 'Concurrent update; please retry'],
  '40P01': [409, 'Concurrent update; please retry'],
  P0001: [409, 'The change was refused by a data-integrity rule'],
  57014: [503, 'The request took too long'],
};
const UNAVAILABLE = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', '57P01', '57P03', 'RATE_LIMIT_STORE_UNAVAILABLE'];

export function classifyError(err) {
  if (err?.type === 'entity.parse.failed') return [400, 'Malformed JSON body'];
  if (err?.type === 'entity.too.large' || err?.code === 'LIMIT_FILE_SIZE') return [413, 'Request body too large'];
  if (err?.name === 'MulterError') return [400, 'Invalid upload'];
  if (UNAVAILABLE.includes(err?.code) || /^08/.test(String(err?.code || ''))) return [503, 'Service temporarily unavailable'];
  if (PG[err?.code]) return PG[err.code];
  return [500, 'Internal server error'];
}

// eslint-disable-next-line no-unused-vars
export async function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const [status, message] = classifyError(err);
  if (err?.type === 'entity.parse.failed') {
    try { await flagSuspicious(req, 'malformed_request', { path: req.path }); } catch { /* logging must not mask the 400 */ }
  }
  console.error(JSON.stringify({
    level: 'error', request_id: req.id ?? null, method: req.method, path: req.path, status,
    user_id: req.user?.id ?? null, error: describeError(err, { withStack: status >= 500 }),
  }));
  res.status(status).json({ error: message, request_id: req.id ?? null });
}
