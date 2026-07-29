import { NavLink, Route, Routes, useParams } from 'react-router-dom';
import { useEstate } from './api.js';
import { Estate } from './pages/Estate.jsx';
import { Instance } from './pages/Instance.jsx';
import { Job } from './pages/Job.jsx';
import { Search } from './pages/Search.jsx';
import { Admin } from './pages/Admin.jsx';

export function App() {
  return (
    <div className="app">
      <header className="titlebar">
        <h1>
          Remote SQL Agent <span>· estate control plane</span>
        </h1>
        <nav>
          <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
            Estate
          </NavLink>
          <NavLink to="/search" className={({ isActive }) => (isActive ? 'active' : '')}>
            Search
          </NavLink>
          <NavLink to="/admin" className={({ isActive }) => (isActive ? 'active' : '')}>
            Administration
          </NavLink>
        </nav>
      </header>

      <div className="shell">
        <ObjectTree />
        <main className="main">
          <Routes>
            <Route path="/" element={<Estate />} />
            <Route path="/instances/:instanceId" element={<Instance />} />
            <Route path="/instances/:instanceId/jobs/:jobUuid" element={<Job />} />
            <Route path="/search" element={<Search />} />
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
