import { useEffect, useState } from 'react';
import Login from './Login';
import TeacherDashboard from './TeacherDashboard';
import ReviewerDashboard from './ReviewerDashboard';
import COEDashboard from './pages/COE/COEDashboard';
import ValidatorDashboard from './pages/Validator/ValidatorDashboard';
import AdminDashboard from './pages/Admin/AdminDashboard';
import AnalyticsPanel from './components/AnalyticsPanel';
import LifecyclePanel from './components/LifecyclePanel';
import LegacyPapers from './components/LegacyPapers';
import { Tabs } from './components/ui';
import ErrorBoundary from './components/ErrorBoundary';
import AppShell from './components/shell/AppShell';
import RoleOverview from './components/shell/RoleOverview';
import ChangePasswordModal from './ChangePasswordModal';
import { api } from './api';

// HOD / reviewer: question lifecycle (the PIVOT state machine), the existing review
// workspace (batches, CO/Bloom/unit verification), dataset coverage and (HOD) the read-only legacy papers.
function QuestionBankHome({ token, user }) {
  const [tab, setTab] = useState('lifecycle');
  return (
    <div>
      <Tabs tabs={[['lifecycle', 'Question lifecycle'], ['work', 'Review workspace'], ['analytics', 'Analytics & coverage'],
        ...(user.role === 'hod' ? [['legacy', 'Legacy papers']] : [])]} active={tab} onChange={setTab} primary />
      {tab === 'lifecycle' && <LifecyclePanel token={token} user={user} />}
      {tab === 'work' && <ReviewerDashboard token={token} user={user} />}
      {tab === 'analytics' && <AnalyticsPanel token={token} />}
      {tab === 'legacy' && user.role === 'hod' && <LegacyPapers token={token} />}
    </div>
  );
}

// Teacher: the existing authoring screens plus where each question is in its lifecycle.
// 'Revise & resubmit' on a changes-requested question opens it in the authoring screen.
function TeacherHome({ token, user }) {
  const [tab, setTab] = useState('author');
  const [reviseId, setReviseId] = useState(null);
  return (
    <div>
      <Tabs tabs={[['author', 'Write & submit'], ['lifecycle', 'Question status']]} active={tab} onChange={setTab} primary />
      {tab === 'author'
        ? <TeacherDashboard token={token} user={user} reviseId={reviseId} onReviseOpened={() => setReviseId(null)} />
        : <LifecyclePanel token={token} user={user} onRevise={(id) => { setReviseId(id); setTab('author'); }} />}
    </div>
  );
}

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('portal_token'));
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(!!token);
  const [showChangePassword, setShowChangePassword] = useState(false);

  useEffect(() => {
    // No token: nothing to fetch. `loading` starts false without a token, and every path that clears the token
    // (sign out, a rejected /auth/me whose .finally() below ends loading) leaves it false, so there is nothing to reset.
    if (!token) return;
    api.get('/auth/me', token)
      .then(setUser)
      .catch(() => { setToken(null); localStorage.removeItem('portal_token'); })
      .finally(() => setLoading(false));
  }, [token]);

  function handleLogin(newToken, newUser) {
    localStorage.setItem('portal_token', newToken);
    setToken(newToken);
    setUser(newUser);
  }

  function logout() {
    // Best-effort: bump token_version server-side so this token can't be
    // replayed even if it leaked, before dropping local state. If this
    // call fails (e.g. offline), still proceed to clear local state — a
    // client-side "sign out" should never get stuck waiting on the network.
    if (token) api.post('/auth/logout', null, token).catch(() => {});
    localStorage.removeItem('portal_token');
    setToken(null);
    setUser(null);
  }

  if (loading) return <p className="hint" role="status" style={{ padding: 24 }}>Loading your workspace…</p>;
  if (!token || !user) return <Login onLogin={handleLogin} />;

  async function refreshUser(newToken) {
    const t = newToken || token;
    if (newToken) {
      localStorage.setItem('portal_token', newToken);
      setToken(newToken);
    }
    const fresh = await api.get('/auth/me', t);
    setUser(fresh);
  }

  if (user.must_change_password) {
    return <ChangePasswordModal token={token} force onSuccess={refreshUser} onLogout={logout} />;
  }

  return (
    <>
      <AppShell user={user} token={token} onLogout={logout} onChangePassword={() => setShowChangePassword(true)}
        overview={(refreshKey) => <RoleOverview role={user.role} token={token} refreshKey={refreshKey} />}>
        {/* A screen that fails to render keeps the shell (sign out, change password) usable. */}
        <ErrorBoundary>
          {user.role === 'teacher' && <TeacherHome token={token} user={user} />}
          {['hod', 'reviewer'].includes(user.role) && <QuestionBankHome token={token} user={user} />}
          {user.role === 'coe' && <COEDashboard token={token} user={user} onUserChange={() => refreshUser()} />}
          {user.role === 'validator' && <ValidatorDashboard token={token} />}
          {user.role === 'admin' && <AdminDashboard token={token} user={user} legacy={<ReviewerDashboard token={token} user={user} />} />}
        </ErrorBoundary>
      </AppShell>
      {showChangePassword && <ChangePasswordModal token={token} onClose={() => setShowChangePassword(false)} onSuccess={refreshUser} />}
    </>
  );
}
