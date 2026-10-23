import { useContext, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { NavContext } from '../lib/navContext';

// Small shared UI pieces for the pivot pages (kept deliberately tiny). useAsync lives in ../lib/useAsync.js.

export function Messages({ error, reasons = [], ok }) {
  return (
    <>
      {error && (
        <div className="alert alert-error">
          {error}
          {reasons.length > 0 && <ul style={{ margin: '6px 0 0 18px' }}>{reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
        </div>
      )}
      {ok && <div className="alert alert-ok">{ok}</div>}
    </>
  );
}

export function Loading({ what = '' }) {
  return <p className="hint" role="status">Loading{what ? ` ${what}` : ''}…</p>;
}

// What a screen shows before its data arrived: the error if loading failed, otherwise a loading line.
export function Pending({ error, reasons = [], what }) {
  return error ? <Messages error={error} reasons={reasons} ok="" /> : <Loading what={what} />;
}

// Any promise rejection no screen handled (a click handler that threw, a background refresh) becomes a visible,
// dismissible message instead of failing silently.
export function UnhandledErrors() {
  const [messages, setMessages] = useState([]);
  useEffect(() => {
    const onRejection = (event) => {
      const msg = event.reason?.data?.error || event.reason?.message || 'An action failed';
      setMessages((m) => [...m.slice(-2), msg]);
    };
    window.addEventListener('unhandledrejection', onRejection);
    return () => window.removeEventListener('unhandledrejection', onRejection);
  }, []);
  if (!messages.length) return null;
  return (
    <div className="alert alert-error" role="alert">
      {messages.map((m, i) => <div key={i}>{m}</div>)}
      <button className="btn-ghost btn-sm" style={{ marginTop: 6 }} onClick={() => setMessages([])}>Dismiss</button>
    </div>
  );
}

export function StatusBadge({ status }) {
  const cls = ['PRINT_READY', 'COE_APPROVED', 'VALIDATED', 'ACTIVE', 'APPROVE'].includes(status) ? 'badge-approved'
    : ['CHANGES_REQUIRED', 'REGENERATED', 'REJECTED'].includes(status) ? 'badge-rejected' : 'badge-pending';
  return <span className={`badge ${cls}`}>{String(status || '').replaceAll('_', ' ')}</span>;
}

// primary: the screen's main navigation. Inside the shell it renders as the sidebar's items (the same buttons, so
// names, order and active state are unchanged) plus a heading for the active section in place; elsewhere, inline.
export function Tabs({ tabs, active, onChange, primary = false }) {
  const nav = useContext(NavContext);
  if (primary && nav) {
    const label = tabs.find(([k]) => k === active)?.[1];
    return (
      <>
        {nav.slot && createPortal(tabs.map(([key, l]) => (
          <button key={key} className={active === key ? 'active' : ''} aria-current={active === key ? 'page' : undefined}
            onClick={() => { onChange(key); nav.onNavigate(); }}>{l}</button>
        )), nav.slot)}
        {label && <h2 className="section-title">{label}</h2>}
      </>
    );
  }
  return (
    <div className="tabs" role="group">
      {tabs.map(([key, label]) => (
        <button key={key} className={`tab ${active === key ? 'active' : ''}`} aria-pressed={active === key} onClick={() => onChange(key)}>{label}</button>
      ))}
    </div>
  );
}
