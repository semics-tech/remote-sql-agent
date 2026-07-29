import { Link } from 'react-router-dom';
import { useState } from 'react';
import { useEstate } from '../api.js';
import { Panel, QueryState, Empty } from '../components.jsx';
import { formatRelative } from '../format.js';

/** §9.1 Estate overview — the answer to "what is broken across the estate". */
export function Estate() {
  const { data, isLoading, error } = useEstate();
  const [tag, setTag] = useState<string>('all');

  const instances = data?.instances ?? [];
  const tags = [...new Set(instances.map((i) => i.environmentTag).filter(Boolean))] as string[];
  const visible = tag === 'all' ? instances : instances.filter((i) => i.environmentTag === tag);

  const totals = visible.reduce(
    (acc, i) => ({
      jobs: acc.jobs + i.jobCount,
      failed: acc.failed + i.failedLast24h,
      running: acc.running + i.runningNow,
      drifted: acc.drifted + i.driftedJobs,
      offline: acc.offline + (i.workerConnected ? 0 : 1),
    }),
    { jobs: 0, failed: 0, running: 0, drifted: 0, offline: 0 },
  );

  return (
    <div className="page">
      <div className="page-head">
        <h2>Estate</h2>
        {tags.length > 0 ? (
          <select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Filter by environment">
            <option value="all">All environments</option>
            {tags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <p className="page-sub">
        Every SQL Server Agent instance reporting to this control plane. SQL Agent still runs the
        jobs — this mirrors what it is doing.
      </p>

      <QueryState isLoading={isLoading} error={error}>
        <section className="panel">
          <div className="stat-row">
            <div className="stat">
              <div className="n">{visible.length}</div>
              <div className="l">Instances</div>
            </div>
            <div className="stat">
              <div className="n">{totals.jobs}</div>
              <div className="l">Jobs</div>
            </div>
            <div className={`stat ${totals.failed > 0 ? 'alert' : ''}`}>
              <div className="n">{totals.failed}</div>
              <div className="l">Failed, last 24h</div>
            </div>
            <div className="stat">
              <div className="n">{totals.running}</div>
              <div className="l">Running now</div>
            </div>
            <div className={`stat ${totals.drifted > 0 ? 'warn' : ''}`}>
              <div className="n">{totals.drifted}</div>
              <div className="l">Drifted</div>
            </div>
            <div className={`stat ${totals.offline > 0 ? 'alert' : ''}`}>
              <div className="n">{totals.offline}</div>
              <div className="l">Workers offline</div>
            </div>
          </div>
        </section>

        <Panel title="Instances">
          {visible.length === 0 ? (
            <Empty
              title="No instances yet"
              hint="Install a worker on a SQL Server host and point it at this control plane."
            />
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Instance</th>
                    <th>Host</th>
                    <th>Worker</th>
                    <th>Agent</th>
                    <th className="right">Jobs</th>
                    <th className="right">Failed 24h</th>
                    <th className="right">Running</th>
                    <th className="right">Drifted</th>
                    <th>Version</th>
                    <th>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((i) => (
                    <tr key={i.instanceId}>
                      <td className="nowrap">
                        <Link to={`/instances/${i.instanceId}`}>{i.instanceName}</Link>
                      </td>
                      <td className="nowrap mono">{i.hostName}</td>
                      <td>
                        <span className={`badge ${i.workerConnected ? 'online' : 'offline'}`}>
                          {i.workerConnected ? 'Connected' : 'Offline'}
                        </span>
                      </td>
                      <td>
                        <span className="status">
                          <span
                            className={`dot ${i.agentStatus === 'running' ? 'succeeded' : i.agentStatus === 'stopped' ? 'failed' : ''}`}
                            aria-hidden="true"
                          />
                          {i.agentStatus === 'running'
                            ? 'Running'
                            : i.agentStatus === 'stopped'
                              ? 'Stopped'
                              : 'Unknown'}
                        </span>
                      </td>
                      <td className="right num">{i.jobCount}</td>
                      <td className="right num">
                        {i.failedLast24h > 0 ? (
                          <span className="badge failed">{i.failedLast24h}</span>
                        ) : (
                          <span className="faint">0</span>
                        )}
                      </td>
                      <td className="right num">
                        {i.runningNow > 0 ? (
                          <span className="badge running">{i.runningNow}</span>
                        ) : (
                          <span className="faint">0</span>
                        )}
                      </td>
                      <td className="right num">
                        {i.driftedJobs > 0 ? (
                          <span className="badge drift">{i.driftedJobs}</span>
                        ) : (
                          <span className="faint">0</span>
                        )}
                      </td>
                      <td className="nowrap muted">{i.sqlVersion ?? '—'}</td>
                      <td className="nowrap muted">{formatRelative(i.lastSeenAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </QueryState>
    </div>
  );
}
