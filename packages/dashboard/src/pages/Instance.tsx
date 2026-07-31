import { Link, useParams } from 'react-router';
import { useMemo, useState } from 'react';
import { useAgentLog, useInstance, useJobs } from '../api.js';
import { Panel, QueryState, Empty, LastRunCell } from '../components.jsx';
import { formatDateTime, formatDuration, formatRelative } from '../format.js';

type Tab = 'jobs' | 'log';

/** §9.2 Instance view — the SSMS Object Explorer node, expanded. */
export function Instance() {
  const { instanceId } = useParams();
  const [tab, setTab] = useState<Tab>('jobs');
  const [filter, setFilter] = useState('');

  const instance = useInstance(instanceId);
  const jobs = useJobs(instanceId);

  const visible = useMemo(() => {
    const all = jobs.data?.jobs ?? [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((j) => j.name.toLowerCase().includes(needle));
  }, [jobs.data, filter]);

  return (
    <div className="page">
      <QueryState isLoading={instance.isLoading} error={instance.error}>
        <div className="page-head">
          <h2>{instance.data?.instanceName}</h2>
          <span className={`badge ${instance.data?.workerOnline ? 'online' : 'offline'}`}>
            {instance.data?.workerOnline ? 'Worker connected' : 'Worker offline'}
          </span>
          <span className="badge neutral">
            {instance.data?.capabilities?.includes('job.write') ? 'Write enabled' : 'Read only'}
          </span>
        </div>
        <p className="page-sub mono">
          {instance.data?.hostName} · {instance.data?.sqlEdition} · {instance.data?.sqlVersion} ·
          Agent {instance.data?.agentStatus} · last seen {formatRelative(instance.data?.lastSeenAt)}
        </p>
      </QueryState>

      <div className="tabs">
        <button className={tab === 'jobs' ? 'active' : ''} onClick={() => setTab('jobs')}>
          Jobs
        </button>
        <button className={tab === 'log' ? 'active' : ''} onClick={() => setTab('log')}>
          Error Log
        </button>
      </div>

      {tab === 'jobs' ? (
        <QueryState isLoading={jobs.isLoading} error={jobs.error}>
          <Panel
            title={`Jobs (${visible.length})`}
            actions={
              <input
                type="search"
                placeholder="Filter jobs"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                aria-label="Filter jobs by name"
              />
            }
          >
            {visible.length === 0 ? (
              <Empty
                title={filter ? 'No jobs match that filter' : 'No jobs on this instance'}
                hint={filter ? 'Clear the filter to see everything.' : undefined}
              />
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Enabled</th>
                      <th>Status</th>
                      <th>Last run</th>
                      <th className="right">Duration</th>
                      <th>Next run</th>
                      <th>Category</th>
                      <th className="right">Ver</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((j) => (
                      <tr key={j.jobUuid}>
                        <td className="nowrap">
                          <Link to={`/instances/${instanceId}/jobs/${j.jobUuid}`}>{j.name}</Link>
                        </td>
                        <td>
                          {j.enabled ? (
                            <span className="muted">Yes</span>
                          ) : (
                            <span className="faint">No</span>
                          )}
                        </td>
                        <td>
                          {j.activityState === 'executing' ? (
                            <span className="badge running">Running</span>
                          ) : (
                            <span className="faint">Idle</span>
                          )}
                        </td>
                        <td className="nowrap">
                          <LastRunCell
                            status={j.lastRunStatus}
                            at={j.lastRunAt}
                            durationSeconds={j.lastRunDurationSeconds}
                          />
                        </td>
                        <td className="right nowrap mono">
                          {formatDuration(j.lastRunDurationSeconds)}
                        </td>
                        <td className="nowrap muted">{formatDateTime(j.nextRunAt)}</td>
                        <td className="nowrap muted">{j.categoryName ?? '—'}</td>
                        <td className="right num muted">{j.currentVersionNo}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </QueryState>
      ) : (
        <AgentLog instanceId={instanceId} />
      )}
    </div>
  );
}

function AgentLog({ instanceId }: { instanceId: string | undefined }) {
  const { data, isLoading, error } = useAgentLog(instanceId);
  const entries = data?.entries ?? [];

  return (
    <QueryState isLoading={isLoading} error={error}>
      <Panel title="SQL Server Agent error log">
        {entries.length === 0 ? (
          <Empty
            title="No log entries"
            hint="Reading the Agent error log needs EXECUTE on xp_readerrorlog. A least-privileged worker login does not have it, and the worker disables log streaming rather than asking for more rights."
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Logged at</th>
                  <th>Severity</th>
                  <th>Source</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td className="nowrap mono">{formatDateTime(e.loggedAt)}</td>
                    <td>
                      <span className="status">
                        <span
                          className={`dot ${e.severity === 'error' ? 'failed' : e.severity === 'warning' ? 'retry' : ''}`}
                          aria-hidden="true"
                        />
                        {e.severity ?? 'info'}
                      </span>
                    </td>
                    <td className="nowrap muted mono">{e.processInfo ?? '—'}</td>
                    <td className="mono">{e.message}</td>
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
