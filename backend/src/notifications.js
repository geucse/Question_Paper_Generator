import { run } from './db.js';

// Fire-and-forget-ish helper for in-app notifications. Deliberately doesn't
// throw on failure to the caller's main flow — a notification failing to
// write should never block the actual action (submitting a question,
// approving a paper, etc.) that triggered it.
export async function notify(userId, type, message, entityId = null) {
  if (!userId) return;
  try {
    await run(`
      INSERT INTO notifications (user_id, type, message, entity_id) VALUES ($1, $2, $3, $4)
    `, [userId, type, message, entityId]);
  } catch (err) {
    console.error('Failed to write notification (non-fatal):', err.message);
  }
}

export async function notifyMany(userIds, type, message, entityId = null) {
  await Promise.all(userIds.map(uid => notify(uid, type, message, entityId)));
}
