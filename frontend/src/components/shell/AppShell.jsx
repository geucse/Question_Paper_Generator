import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import BrandMark from './BrandMark';
import NotificationBell from '../../NotificationBell';
import { UnhandledErrors } from '../ui';
import { NavContext } from '../../lib/navContext';
import { ROLE_NAMES, WORKSPACES } from '../../brand';
import { MenuIcon, CloseIcon } from './icons';

// The signed-in frame: header (brand, notifications, user), a role-aware sidebar and the page heading. Each role's
// main tabs render INTO the sidebar (Tabs primary -> NavContext slot), so the existing screens keep their own state
// and their buttons keep their names; nothing here decides what a role may do (the server does, per request).
export default function AppShell({ user, token, onLogout, onChangePassword, overview, children }) {
  const [slot, setSlot] = useState(null);
  const [open, setOpen] = useState(false);
  const [navCount, setNavCount] = useState(0);
  const sidebar = useRef(null);
  const menuBtn = useRef(null);
  const close = useCallback(() => { setOpen(false); }, []);
  const ctx = useMemo(() => ({ slot, onNavigate: () => { setOpen(false); setNavCount((n) => n + 1); } }), [slot]);
  const [title, description] = WORKSPACES[user.role] || ['Workspace', ''];
  const roleName = ROLE_NAMES[user.role] || user.role;
  const who = user.full_name || user.email;

  // Drawer (narrow screens): Escape closes it and returns focus to the menu button; opening moves focus into it.
  useEffect(() => {
    if (!open) return undefined;
    sidebar.current?.querySelector('button')?.focus();
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); menuBtn.current?.focus(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="ge-header">
        <div className="ge-header-left">
          <button ref={menuBtn} className="icon-btn ge-menu-btn" aria-label={open ? 'Close navigation' : 'Open navigation'} aria-expanded={open}
            aria-controls="ge-sidebar" onClick={() => setOpen(!open)}>{open ? <CloseIcon /> : <MenuIcon />}</button>
          <BrandMark />
        </div>
        <div className="ge-header-right">
          <NotificationBell token={token} />
          <div className="ge-user" title={`${who} (${roleName})`}>
            <span className="ge-avatar" aria-hidden="true">{String(who || '?').trim().charAt(0).toUpperCase()}</span>
            <span className="ge-user-text"><strong>{who}</strong><span>{roleName}</span></span>
          </div>
        </div>
      </header>
      <div className="ge-body">
        <aside id="ge-sidebar" ref={sidebar} className={`ge-sidebar${open ? ' open' : ''}`} aria-label="Portal navigation">
          <div className="ge-nav-label" id="ge-nav-label">{title}</div>
          <nav className="ge-nav" aria-labelledby="ge-nav-label" ref={setSlot} />
          <div className="ge-sidebar-foot">
            <button onClick={() => { close(); onChangePassword(); }}>Change password</button>
            <button className="ge-signout" onClick={onLogout}>Sign out</button>
          </div>
        </aside>
        {open && <button className="ge-scrim open" aria-label="Close navigation" tabIndex={-1} onClick={close} />}
        <main id="main" className="main" tabIndex={-1}>
          <div className="ge-page-head">
            <div>
              <h1>{title}</h1>
              {description && <p>{description}</p>}
            </div>
            <div className="ge-page-tools"><span className="ge-pill">{roleName}</span></div>
          </div>
          <UnhandledErrors />
          {overview && overview(navCount)}
          {/* A screen that fails to render keeps the shell (sign out, change password) usable. */}
          <NavContext.Provider value={ctx}>{children}</NavContext.Provider>
        </main>
      </div>
    </div>
  );
}
