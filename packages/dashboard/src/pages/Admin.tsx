import { useState } from 'react';
import { useAudit, useWorkers } from '../api.js';
import { Panel, QueryState, Empty } from '../components.jsx';
import { formatDateTime, formatRelative } from '../format.js';

type Tab = 'workers' | 'audit';

/** §9.7 Admin — workers and capabilities, audit log. */
export function Admin() {
  const [tab, setTab] = useState<Tab>('workers');

  return (
    <div className="page">
      <div className="page-head">
        <h2>Administration</h2>
      </div>
      <p className="page-sub">
        Workers report a local capability ceiling that this control plane cannot raise. The
        effective capability of a worker is always the smaller of what is granted here and what the
        worker allows itself.
      </p>

      <div className="tabs">
        <button className={tab === 'workers' ? 'active' : ''} onClick={() => setTab('workers')}>
          Workers
        </button>
        <button className={tab === 'audit' ? 'active' : ''} onClick={() => setTab('audit')}>
          Audit log
        </button>
      </div>

      {tab === 'workers' ? <Workers /> : <Audit />}
    </div>
  );
}

function Workers() {
  const { data, isLoading, error } = useWorkers();
  const workers = data?.workers ?? [];

  return (
    <QueryState isLoading={isLoading} error={error}>
      <Panel title={`Workers (${workers.length})`}>
        {workers.length === 0 ? (
          <Empty title="No workers enrolled" />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Host</th>
                  <th>Status</th>
                  <th className="right">Instances</th>
                  <th>Version</th>
                  <th>Granted</th>
                  <th>Local ceiling</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {workers.map((w) => (
                  <tr key={w.id}>
                    <td className="nowrap mono">{w.hostName}</td>
                    <td>
                      <span className={`badge ${w.online ? 'online' : 'offline'}`}>
                        {w.online ? 'Connected' : 'Offline'}
                      </span>
                    </td>
                    <td className="right num">{w.instanceCount}</td>
                    <td className="nowrap muted mono">{w.version ?? '—'}</td>
                    <td className="muted mono">
                      {w.capabilities.length > 0 ? w.capabilities.join(', ') : 'observe only'}
                    </td>
                    <td>
                      <span className="badge neutral">{w.maxCapabilityReported ?? 'unknown'}</span>
                    </td>
                    <td className="nowrap muted">{formatRelative(w.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </QueryState>
  );
}

function Audit() {
  const { data, isLoading, error } = useAudit();
  const entries = data?.entries ?? [];

  return (
    <QueryState isLoading={isLoading} error={error}>
      <Panel title={`Audit log (${entries.length} most recent)`}>
        {entries.length === 0 ? (
          <Empty title="Nothing audited yet" />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Target</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td className="nowrap mono">{formatDateTime(e.at)}</td>
                    <td className="nowrap">
                      <span className="badge neutral">{e.actorType}</span>{' '}
                      <span className="mono">{e.actor}</span>
                    </td>
                    <td className="nowrap mono">{e.action}</td>
                    <td className="nowrap faint mono">{e.target?.slice(0, 8) ?? '—'}</td>
                    <td className="mono faint" style={{ fontSize: 11.5 }}>
                      {e.detail ? JSON.stringify(e.detail).slice(0, 140) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </QueryState>
  );
}
