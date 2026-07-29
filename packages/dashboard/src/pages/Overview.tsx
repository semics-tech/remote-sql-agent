import { Link } from 'react-router-dom';
import { useOverview, type FailedRun, type RunningJob, type WorkerHealth } from '../api.js';
import { Panel, QueryState, Empty } from '../components.jsx';
import { formatDateTime, formatDuration, formatRelative } from '../format.js';

/**
 * The operations overview.
 *
 * The estate grid answers "what exists". This answers "what should I look at
 * first", which is the question someone actually opens this tool with. Ordered
 * by urgency rather than alphabetically: running work, then overruns, then
 * failures, then workers.
 */
export function Overview() {
  const { data, isLoading, error } = useOverview();
  const totals = data?.totals;
  const running = data?.running ?? [];
  const longRunning = running.filter((r) => r.isLongRunning);

  return (
    <div className="page">
      <div className="page-head">
        <h2>Overview</h2>
      </div>
      <p className="page-sub">
        Everything happening across the estate right now. SQL Agent is still running the jobs —
        this is what it is doing.
      </p>

      <QueryState isLoading={isLoading} error={error}>
        <section className="panel">
          <div className="stat-row">
            <div className="stat">
              <div className="n">{totals?.runningNow ?? 0}</div>
              <div className="l">Running now</div>
            </div>
            <div className={`stat ${(totals?.longRunning ?? 0) > 0 ? 'warn' : ''}`}>
              <div className="n">{totals?.longRunning ?? 0}</div>
              <div className="l">Running long</div>
            </div>
            {/* Jobs, not runs. The list below counts individual failed runs,
                and one broken job accounts for most of them — labelling both
                "failed, last 24h" made the two numbers look contradictory. */}
            <div className={`stat ${(totals?.failedLast24h ?? 0) > 0 ? 'alert' : ''}`}>
              <div className="n">{totals?.failedLast24h ?? 0}</div>
              <div className="l">Jobs failing</div>
            </div>
            <div className={`stat ${(totals?.workersOffline ?? 0) > 0 ? 'alert' : ''}`}>
              <div className="n">{totals?.workersOffline ?? 0}</div>
              <div className="l">Workers offline</div>
            </div>
            <div className={`stat ${(totals?.agentsStopped ?? 0) > 0 ? 'alert' : ''}`}>
              <div className="n">{totals?.agentsStopped ?? 0}</div>
              <div className="l">Agents not running</div>
            </div>
            <div className="stat">
              <div className="n">{totals?.jobs ?? 0}</div>
              <div className="l">Jobs mirrored</div>
            </div>
            <div className="stat">
              <div className="n">{totals?.jobsDisabled ?? 0}</div>
              <div className="l">Disabled</div>
            </div>
          </div>
        </section>

        {longRunning.length > 0 ? (
          <Panel title={`Running longer than usual (${longRunning.length})`}>
            <RunningTable rows={longRunning} showBaseline />
          </Panel>
        ) : null}

        <Panel title={`Running now (${running.length})`}>
          {running.length === 0 ? (
            <Empty
              title="Nothing running"
              hint="Jobs appear here the moment SQL Agent reports them as executing."
            />
          ) : (
            <RunningTable rows={running} showBaseline />
          )}
        </Panel>

        <Panel title={`Failed runs, last 24 hours (${data?.failures.length ?? 0})`}>
          {(data?.failures.length ?? 0) === 0 ? (
            <Empty title="No failed runs in the last 24 hours" />
          ) : (
            <FailureTable rows={data!.failures} />
          )}
        </Panel>

        <Panel title={`Workers (${data?.workers.length ?? 0})`}>
          {(data?.workers.length ?? 0) === 0 ? (
            <Empty
              title="No workers enrolled"
              hint="Add one from the Estate page to start mirroring a SQL Server host."
            />
          ) : (
            <WorkerTable rows={data!.workers} />
          )}
        </Panel>
      </QueryState>
    </div>
  );
}

function RunningTable({ rows, showBaseline }: { rows: RunningJob[]; showBaseline: boolean }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Job</th>
            <th>Instance</th>
            <th>Current step</th>
            <th className="right">Running for</th>
            {showBaseline ? <th className="right">Usually</th> : null}
            <th>Progress</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.instanceId}:${r.jobUuid}`}>
              <td className="nowrap">
                <Link to={`/instances/${r.instanceId}/jobs/${r.jobUuid}`}>{r.jobName}</Link>
                {r.isLongRunning ? (
                  <>
                    {' '}
                    <span
                      className="badge drift"
                      title="Well past this job's own average for a successful run"
                    >
                      long
                    </span>
                  </>
                ) : null}
              </td>
              <td className="nowrap muted mono">
                {r.hostName}\{r.instanceName}
              </td>
              <td className="nowrap muted">
                {r.currentStepId ? `${r.currentStepId}. ` : ''}
                {r.currentStepName ?? '—'}
              </td>
              <td className="right nowrap mono">{formatDuration(r.elapsedSeconds)}</td>
              {showBaseline ? (
                <td className="right nowrap mono muted">
                  {r.averageSeconds === null ? (
                    <span className="faint" title="Fewer than three successful runs on record">
                      no baseline
                    </span>
                  ) : (
                    formatDuration(Math.round(r.averageSeconds))
                  )}
                </td>
              ) : null}
              <td style={{ minWidth: 140 }}>
                <ProgressBar elapsed={r.elapsedSeconds} average={r.averageSeconds} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Elapsed against this job's own average.
 *
 * Deliberately not capped at 100%: a run at three times its usual duration
 * should look wrong, and a bar sitting quietly at "full" would not.
 */
function ProgressBar({ elapsed, average }: { elapsed: number | null; average: number | null }) {
  if (elapsed === null || average === null || average <= 0) {
    return <span className="faint">—</span>;
  }

  const ratio = elapsed / average;
  const width = Math.min(100, ratio * 100);
  const state = ratio >= 2 ? 'over' : ratio >= 1 ? 'near' : 'ok';
  const label = `${Math.round(ratio * 100)}% of its usual duration`;

  return (
    <span className="progress" title={label} role="img" aria-label={label}>
      <span className={`progress-fill ${state}`} style={{ width: `${width}%` }} />
      {ratio > 1 ? <span className="progress-over">{ratio.toFixed(1)}×</span> : null}
    </span>
  );
}

function FailureTable({ rows }: { rows: FailedRun[] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Job</th>
            <th>Instance</th>
            <th>Failed at</th>
            <th className="right">Ran for</th>
            <th className="right">In a row</th>
            <th>Message</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.instanceId}:${r.jobUuid}:${r.runDatetime}`}>
              <td className="nowrap">
                <Link to={`/instances/${r.instanceId}/jobs/${r.jobUuid}`}>{r.jobName}</Link>
              </td>
              <td className="nowrap muted mono">
                {r.hostName}\{r.instanceName}
              </td>
              <td className="nowrap mono">{formatDateTime(r.runDatetime)}</td>
              <td className="right nowrap mono muted">{formatDuration(r.runDurationSeconds)}</td>
              <td className="right num">
                {/* One failure overnight and "every run since Tuesday" call for
                    completely different responses, and look identical without this. */}
                {r.consecutiveFailures > 1 ? (
                  <span className="badge failed">{r.consecutiveFailures}</span>
                ) : (
                  <span className="faint">1</span>
                )}
              </td>
              <td className="muted" title={r.message ?? ''}>
                {truncate(r.message, 90)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WorkerTable({ rows }: { rows: WorkerHealth[] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Host</th>
            <th>Status</th>
            <th className="right">Instances</th>
            <th>Agents</th>
            <th>Version</th>
            <th>Last seen</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((w) => (
            <tr key={w.workerId}>
              <td className="nowrap mono">{w.hostName}</td>
              <td>
                <span className={`badge ${w.online ? 'online' : 'offline'}`}>
                  {w.online ? 'Connected' : 'Offline'}
                </span>
              </td>
              <td className="right num">{w.instanceCount}</td>
              <td>
                {w.agentsNotRunning > 0 ? (
                  <span className="badge failed">{w.agentsNotRunning} not running</span>
                ) : (
                  <span className="faint">all running</span>
                )}
              </td>
              <td className="nowrap muted mono">{w.version ?? '—'}</td>
              <td className="nowrap muted">{formatRelative(w.lastSeenAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function truncate(value: string | null, max: number): string {
  if (!value) return '—';
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
