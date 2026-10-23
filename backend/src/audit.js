import { all, withTransaction } from './db.js';
import crypto from 'crypto';

// Each audit entry's hash includes the previous entry's hash, forming a chain.
// The user's email is stored directly on the row (not just user_id) so entries
// are human-readable without a join, AND the email is part of what gets hashed —
// so quietly editing the email on an old row (e.g. to hide who did something)
// breaks the chain just as much as editing the action or entity would.
//
// Appends are serialised by a transaction-level advisory lock, so concurrent writers can't read the same
// prev_hash and fork the chain; ids are taken under the lock, so id order = chain order (verifyChain).
// Pass the caller's transaction (logAudit(entry, txn)) to make the audit row part of the change it records:
// it commits or rolls back with it. The lock is then held until that COMMIT, so the audit append must be
// the LAST statement of the transaction. Without a transaction the append runs in its own short one.
const CHAIN_LOCK = 'audit_log:chain';

export async function logAudit(entry, db = null) {
  if (db) return appendAudit(db, entry);
  return withTransaction((txn) => appendAudit(txn, entry));
}

async function appendAudit(db, { userId, action, entityId, details, ip }) {
  const user = userId ? await db.get('SELECT email FROM users WHERE id = $1', [userId]) : null;
  const userEmail = user ? user.email : 'unknown';

  await db.run('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [CHAIN_LOCK]);
  const last = await db.get('SELECT entry_hash FROM audit_log ORDER BY id DESC LIMIT 1');
  const prevHash = last ? last.entry_hash : 'GENESIS';
  const detailsStr = JSON.stringify(details || {});
  const createdAt = new Date().toISOString();

  const payload = `${prevHash}|${userId}|${userEmail}|${action}|${entityId}|${detailsStr}|${ip}|${createdAt}`;
  const entryHash = crypto.createHash('sha256').update(payload).digest('hex');

  await db.run(`
    INSERT INTO audit_log (user_id, user_email, action, entity_id, details, ip_address, prev_hash, entry_hash, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [userId, userEmail, action, entityId, detailsStr, ip, prevHash, entryHash, createdAt]);
}

export async function verifyChain() {
  const rows = await all('SELECT * FROM audit_log ORDER BY id ASC');
  let prevHash = 'GENESIS';
  for (const row of rows) {
    const createdAtIso = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
    const payload = `${prevHash}|${row.user_id}|${row.user_email}|${row.action}|${row.entity_id}|${row.details}|${row.ip_address}|${createdAtIso}`;
    const expected = crypto.createHash('sha256').update(payload).digest('hex');
    if (expected !== row.entry_hash) {
      return { valid: false, brokenAt: row.id };
    }
    prevHash = row.entry_hash;
  }
  return { valid: true, checked: rows.length };
}
