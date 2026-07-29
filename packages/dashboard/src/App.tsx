import { NavLink, Route, Routes, useParams } from 'react-router-dom';
import { useCommands, useEstate } from './api.js';
import { useAuth } from './auth.jsx';
import { Commands } from './pages/Commands.jsx';
import { Estate } from './pages/Estate.jsx';
import { Overview } from './pages/Overview.jsx';
import { Jobs } from './pages/Jobs.jsx';
import { AddWorker } from './pages/AddWorker.jsx';
import { Instance } from './pages/Instance.jsx';
import { Job } from './pages/Job.jsx';
import { Search } from './pages/Search.jsx';
import { Admin } from './pages/Admin.jsx';
import { SignIn } from './pages/SignIn.jsx';

export function App() {
  const { user, loading, can, signOut } = useAuth();
  // Surfaced in the nav so an approver notices work waiting for them without
  // having to go looking for it.
  const commands = useCommands('pending_approval');
  const pendingApproval = user ? (commands.data?.pendingApproval ?? 0) : 0;

  if (loading) {
    return <div className="empty">Loading…</div>;
  }

  // Everything behind the sign-in wall. The server enforces this independently;
  // this only avoids rendering screens that would return 401 on every request.
  if (!user) {
    return <SignIn />;
  }

  return (
    <div className="app">
      <header className="titlebar">
        <h1>
          Remote SQL Agent <span>· estate control plane</span>
        </h1>
        <nav>
          <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
            Overview
          </NavLink>
          <NavLink to="/estate" className={({ isActive }) => (isActive ? 'active' : '')}>
            Estate
          </NavLink>
          <NavLink to="/jobs" className={({ isActive }) => (isActive ? 'active' : '')}>
            Jobs
          </NavLink>
          <NavLink to="/search" className={({ isActive }) => (isActive ? 'active' : '')}>
            Search
          </NavLink>
          <NavLink to="/commands" className={({ isActive }) => (isActive ? 'active' : '')}>
            Commands
            {pendingApproval > 0 ? <span className="nav-badge">{pendingApproval}</span> : null}
          </NavLink>
          {can('worker.admin') || can('user.admin') || can('audit.read') ? (
            <NavLink to="/admin" className={({ isActive }) => (isActive ? 'active' : '')}>
              Administration
            </NavLink>
          ) : null}
        </nav>
        <div className="titlebar-user">
          <span className="badge neutral" title={`Signed in via ${user.identityProvider}`}>
            {user.role}
          </span>
          <span className="muted">{user.displayName ?? user.username}</span>
          <button className="action" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <div className="shell">
        <ObjectTree />
        <main className="main">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/estate" element={<Estate />} />
            <Route path="/estate/add-worker" element={<AddWorker />} />
            <Route path="/jobs" element={<Jobs />} />
            <Route path="/instances/:instanceId" element={<Instance />} />
            <Route path="/instances/:instanceId/jobs/:jobUuid" element={<Job />} />
            <Route path="/search" element={<Search />} />
            <Route path="/commands" element={<Commands />} />
            <Route path="/admin" element={<Admin />} />
            <Route
              path="*"
              element={
                <div className="page">
                  <div className="empty">
                    <strong>That page does not exist</strong>
                    <a href="/">Back to the estate</a>
                  </div>
                </div>
              }
            />
          </Routes>
        </main>
      </div>
    </div>
  );
}

/** The Object Explorer analogue: hosts and their instances, always present. */
function ObjectTree() {
  const { data } = useEstate();
  const { instanceId } = useParams();
  const instances = data?.instances ?? [];

  const byHost = new Map<string, typeof instances>();
  for (const i of instances) {
    const existing = byHost.get(i.hostName);
    if (existing) existing.push(i);
    else byHost.set(i.hostName, [i]);
  }

  return (
    <aside className="sidebar">
      <div className="tree-group">Servers</div>
      {byHost.size === 0 ? (
        <div style={{ padding: '6px 12px' }} className="faint">
          No workers connected
        </div>
      ) : (
        [...byHost.entries()].map(([host, list]) => (
          <div key={host}>
            <div
              className="tree-item"
              style={{ fontWeight: 600, cursor: 'default' }}
              aria-hidden="true"
            >
              <span className="mono">{host}</span>
            </div>
            {list.map((i) => (
              <NavLink
                key={i.instanceId}
                to={`/instances/${i.instanceId}`}
                className={`tree-item ${instanceId === i.instanceId ? 'active' : ''}`}
                style={{ paddingLeft: 26 }}
              >
                <span
                  className={`dot ${i.workerConnected && i.agentStatus === 'running' ? 'succeeded' : i.workerConnected ? 'retry' : 'failed'}`}
                  aria-hidden="true"
                />
                {i.instanceName}
                <span className="sub">
                  {i.failedLast24h > 0 ? `${i.failedLast24h} failed` : `${i.jobCount} jobs`}
                </span>
              </NavLink>
            ))}
          </div>
        ))
      )}
    </aside>
  );
}
