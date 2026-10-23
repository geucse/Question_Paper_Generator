import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { BellIcon } from './components/shell/icons';

export default function NotificationBell({ token }) {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  const ref = useRef();

  async function refreshCount() {
    try {
      const res = await api.get('/notifications/unread-count', token);
      setCount(res.count);
    } catch { /* the next poll retries; an ended session is handled by api.js */ }
  }

  // Polls with the CURRENT token: after a password change App hands over the new token and this effect restarts,
  // so the old (now revoked) token is never sent again (it used to sign the user out on the next poll).
  useEffect(() => {
    let stopped = false;
    const poll = () => api.get('/notifications/unread-count', token)
      .then((res) => { if (!stopped) setCount(res.count); })
      .catch(() => { /* the next poll retries; an ended session is handled by api.js */ });
    poll();
    const interval = setInterval(poll, 15000); // simple poll, no websocket in this build
    return () => { stopped = true; clearInterval(interval); };
  }, [token]);

  useEffect(() => {
    function onClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  async function toggle() {
    setError('');
    if (!open) {
      try { setItems(await api.get('/notifications', token)); } catch (e) { setError(e.message || 'Could not load notifications'); }
    }
    setOpen(!open);
  }

  async function markAllRead() {
    setError('');
    try {
      await api.post('/notifications/read-all', null, token);
      setItems(items.map(i => ({ ...i, read_at: i.read_at || new Date().toISOString() })));
      setCount(0);
    } catch (e) { setError(e.message || 'Could not mark notifications read'); }
  }

  async function markOneRead(id) {
    setError('');
    try {
      await api.post(`/notifications/${id}/read`, null, token);
      setItems(items.map(i => i.id === id ? { ...i, read_at: new Date().toISOString() } : i));
      refreshCount();
    } catch (e) { setError(e.message || 'Could not mark the notification read'); }
  }

  return (
    <div style={{ position: 'relative' }} ref={ref} onKeyDown={(e) => { if (e.key === 'Escape' && open) setOpen(false); }}>
      <button className="icon-btn" aria-label={count > 0 ? `Notifications, ${count} unread` : 'Notifications'} aria-expanded={open} aria-haspopup="true" onClick={toggle}>
        <BellIcon />
        {count > 0 && <span className="ge-count" aria-hidden="true">{count > 9 ? '9+' : count}</span>}
      </button>
      {open && (
        <div className="ge-pop" role="region" aria-label="Notifications">
          <div className="ge-pop-head">
            <strong style={{ fontSize: '0.9rem' }}>Notifications</strong>
            <button className="btn-ghost btn-sm" onClick={markAllRead}>Mark all read</button>
          </div>
          {error && <div className="alert alert-error" style={{ margin: 8 }}>{error}</div>}
          {items.length === 0 && !error && <div className="hint" style={{ padding: 14, margin: 0 }}>You have no notifications.</div>}
          {items.map(n => (
            <button key={n.id} className={`ge-notif${n.read_at ? '' : ' unread'}`} onClick={() => !n.read_at && markOneRead(n.id)}
              aria-label={`${n.read_at ? '' : 'Unread: '}${n.message}`}>
              <span>{n.message}</span>
              <time dateTime={n.created_at}>{new Date(n.created_at).toLocaleString()}</time>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
