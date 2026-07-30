import { Link } from 'react-router-dom';
import { useOverview, type FailedRun, type RunningJob, type WorkerHealth } from '../api.js';
import { Panel, QueryState, Empty } from '../components.jsx';
import { formatDateTime, formatDuration, formatRelative } from '../format.js';
import { liveElapsedSeconds, useTicker } from '../ticker.js';

/**
 * The operations overview.
 *
 * The estate grid answers "what exists". This answers "what should I look at
 * first", which is the question someone actually opens this tool with. Ordered
 * by urgency rather than alphabetically: running work, then overruns, then
 * failures, then workers.
 */
export function Overview() {
  const { data, isLoading, error, dataUpdatedAt } = useOverview();
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
            <RunningTable rows={longRunning} fetchedAt={dataUpdatedAt} />
          </Panel>
        ) : null}

        <Panel title={`Running now (${running.length})`}>
          {running.length === 0 ? (
            <Empty
              title="Nothing running"
              hint="Jobs appear here the moment SQL Agent reports them as executing."
            />
          ) : (
            <RunningTable rows={running} fetchedAt={dataUpdatedAt} />
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

/**
 * What is running, counting up in real time.
 *
 * The elapsed figure the server sends is a measurement taken when it replied,
 * so it is stale the moment it arrives. Ticking it forward locally is what
 * makes this read as a live view rather than a page that refreshes.
 */
function RunningTable({ rows, fetchedAt }: { rows: RunningJob[]; fetchedAt: number }) {
  const now = useTicker(rows.length > 0);

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Job</th>
            <th>Instance</th>
            <th>Current step</th>
            <th className="right">Running for</th>
            <th className="right">Expected</th>
            <th>Progress</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const elapsed = liveElapsedSeconds(r.elapsedSeconds, fetchedAt, now);
            const eta = describeEta(elapsed, r.averageSeconds);

            return (
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
                  {r.currentStepName ? (
                    <>
                      {r.currentStepId ? `${r.currentStepId}. ` : ''}
                      {r.currentStepName}
                      {r.currentStepNumber !== null && r.stepCount !== null ? (
                        <span className="faint">
                          {' '}
                          ({r.currentStepNumber} of {r.stepCount})
                        </span>
                      ) : null}
                    </>
                  ) : (
                    // The flow has run out of steps: the run is finishing and
                    // the final history row has not landed yet.
                    <span className="faint">finishing</span>
                  )}
                </td>
                <td
                  className="right nowrap mono"
                  title={describeBaseline(r.averageSeconds, r.lastDurationSeconds)}
                >
                  {formatDuration(elapsed)}
                </td>
                <td className={`right nowrap mono ${eta ? `eta-${eta.state}` : 'faint'}`}>
                  {eta ? eta.label : <span title={NO_BASELINE_HINT}>—</span>}
                </td>
                <td style={{ minWidth: 140 }}>
                  <ProgressBar elapsed={elapsed} average={r.averageSeconds} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const NO_BASELINE_HINT =
  'No estimate: this job has fewer than three successful runs in the last 30 days.';

export interface EtaReading {
  label: string;
  state: 'ok' | 'near' | 'over';
}

/**
 * How much longer this run has to go, against its own average.
 *
 * Phrased as time rather than a percentage because the question being asked is
 * "can I wait for this, or should I go and look at it", and an answer of "84%"
 * does not settle that for a job that takes six hours.
 *
 * Past the average it keeps counting, as an overrun rather than a stalled
 * "0s left" — a run that is late is the one thing on this page worth reading,
 * and rounding it away to zero would hide exactly that.
 */
export function describeEta(
  elapsedSeconds: number | null,
  averageSeconds: number | null,
): EtaReading | null {
  if (elapsedSeconds === null || averageSeconds === null || averageSeconds <= 0) return null;

  const remaining = Math.round(averageSeconds) - elapsedSeconds;
  if (remaining > 0) {
    return { label: `${formatDuration(remaining)} left`, state: 'ok' };
  }

  const over = -remaining;
  // Matches the server's overrun test, so the wording and the "long" badge
  // never contradict each other.
  const state = elapsedSeconds >= averageSeconds * 2 ? 'over' : 'near';
  return { label: `over by ${formatDuration(over)}`, state };
}

/** The tooltip behind the running timer: what this job normally does. */
export function describeBaseline(
  averageSeconds: number | null,
  lastDurationSeconds: number | null,
): string {
  const parts: string[] = [];
  if (averageSeconds !== null) {
    parts.push(`Usually ${formatDuration(Math.round(averageSeconds))}`);
  }
  if (lastDurationSeconds !== null) {
    parts.push(`last run ${formatDuration(lastDurationSeconds)}`);
  }
  if (parts.length === 0) return 'No successful run on record to compare this against.';
  if (averageSeconds === null) {
    return `${parts.join(' · ')}. Too few successful runs for an average.`;
  }
  return `${parts.join(' · ')}. Averaged over successful runs in the last 30 days.`;
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
