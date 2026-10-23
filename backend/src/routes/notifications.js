import express from 'express';
import { all, run, get } from '../db.js';
import { requireAuth } from '../middleware.js';

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const rows = await all(`
    SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50
  `, [req.user.id]);
  res.json(rows);
});

router.get('/unread-count', requireAuth, async (req, res) => {
  const row = await get(`SELECT COUNT(*)::int as c FROM notifications WHERE user_id = $1 AND read_at IS NULL`, [req.user.id]);
  res.json({ count: row.c });
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Only the owner's own notification; anything else (someone else's, missing, malformed) is 404, never a fake ok.
router.post('/:id/read', requireAuth, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Notification not found' });
  const r = await run(`UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2 RETURNING id`, [req.params.id, req.user.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Notification not found' });
  res.json({ ok: true });
});

router.post('/read-all', requireAuth, async (req, res) => {
  await run(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [req.user.id]);
  res.json({ ok: true });
});

export default router;
