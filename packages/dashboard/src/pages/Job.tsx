import { Link, useParams } from 'react-router';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import {
  useDiff,
  useJob,
  useJobHistory,
  useJobStats,
  useJobVersions,
  type HistoryRun,
} from '../api.js';
import { Panel, QueryState, Empty, RunTape, StatusDot } from '../components.jsx';
import { formatDateTime, formatDuration, runStatusClass, runStatusLabel } from '../format.js';
import { JobActions } from './JobActions.jsx';
import { JobEditor } from './JobEditor.jsx';
import { JobSummary } from './JobSummary.jsx';
import { RunTimeline } from './RunTimeline.jsx';

// Monaco is ~2 MB; the diff view only appears on the Versions tab, so it must
// not be in the bundle that renders the estate grid.
const MonacoDiff = lazy(() => import('../MonacoDiff.jsx'));

type Tab = 'job' | 'history' | 'versions';

/**
 * How long to keep showing an enable/disable as in progress.
 *
 * Issuing the command only queues it, so nothing on this page can tell the
 * difference between "the worker is about to apply it" and "the worker is
 * offline and never will". Rather than leave the button in limbo, give up and
 * show what the server actually reports, with somewhere to go and look.
 */
const TOGGLE_TIMEOUT_MS = 20_000;

/**
 * How long to keep showing "Starting…" before giving up on it.
 *
 * Generous: SQL Agent's activity poll is ten seconds by default, and a worker
 * that has just applied the command polls immediately, so anything that is
 * going to start has started well inside this.
 */
const STARTING_TIMEOUT_MS = 30_000;

/**
 * A job.
 *
 * Opening a job puts you straight into its definition, editable if you are
 * allowed to edit it — the same thing SSMS does. Statistics sit above the tabs
 * because they are context for everything below, and the live step graph
 * appears there too once a run starts, so the page an operator is already
 * looking at becomes the progress view without them navigating anywhere.
 */
export function Job() {
  const { instanceId, jobUuid } = useParams();
  const [tab, setTab] = useState<Tab>('job');
  const [notice, setNotice] = useState<string | null>(null);
  // Set the moment a start is issued, cleared as soon as SQL Agent confirms.
  // Without it there is a window where the operator has pressed the button and
  // nothing on screen has changed.
  const [starting, setStarting] = useState(false);
  // The enabled state we have asked for and not yet seen confirmed. Same idea
  // as `starting`: the operator pressed a button and something must change.
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);
  const [toggleStalled, setToggleStalled] = useState(false);
  // The last run recorded when the start was issued. A short job can finish
  // before any poll observes it executing, and then "running" never becomes
  // true — this is what notices it ran anyway.
  const [startedFrom, setStartedFrom] = useState<string | null>(null);

  const settling = starting || pendingEnabled !== null;
  const jobQuery = useJob(instanceId, jobUuid, settling);
  const job = jobQuery.data;
  const running = job?.activity?.state === 'executing';
  const enabled = job?.enabled;

  const history = useJobHistory(instanceId, jobUuid, running || starting);
  const stats = useJobStats(instanceId, jobUuid, running || starting);

  // Three ways out of the optimistic state, because a job can finish faster
  // than the poll interval and "running" would then never be observed:
  //   1. SQL Agent reports it executing — the normal case;
  //   2. a new run appears in history — it started and finished between polls;
  //   3. a timeout — it never started, and a badge stuck on "Starting…" for
  //      the rest of the session is worse than admitting we do not know.
  useEffect(() => {
    if (!starting) return undefined;
    if (running) {
      setStarting(false);
      return undefined;
    }
    if (job?.lastRunAt && job.lastRunAt !== startedFrom) {
      setStarting(false);
      return undefined;
    }

    const timer = setTimeout(() => setStarting(false), STARTING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [starting, running, job?.lastRunAt, startedFrom]);

  useEffect(() => {
    if (pendingEnabled === null) return undefined;
    if (enabled === pendingEnabled) {
      setPendingEnabled(null);
      setToggleStalled(false);
      return undefined;
    }
    const timer = setTimeout(() => {
      setPendingEnabled(null);
      setToggleStalled(true);
    }, TOGGLE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pendingEnabled, enabled]);

  const definition = job?.definition ?? null;

  return (
    <div className="page">
      <QueryState isLoading={jobQuery.isLoading} error={jobQuery.error}>
        <div className="page-head">
          <h2>{job?.name}</h2>
          {pendingEnabled !== null ? (
            <span className="badge neutral" title="Sent to the worker; waiting for SQL Agent">
              {pendingEnabled ? 'Enabling…' : 'Disabling…'}
            </span>
          ) : enabled === false ? (
            <span className="badge neutral">Disabled</span>
          ) : null}
          {running ? (
            <span className="badge running">Running</span>
          ) : starting ? (
            <span className="badge running">Starting…</span>
          ) : null}
        </div>
        <p className="page-sub">
          <Link to={`/instances/${instanceId}`}>← back to instance</Link>
          {' · '}
          <span className="mono">{job?.categoryName ?? 'uncategorised'}</span>
          {' · owner '}
          <span className="mono">{job?.ownerLoginName ?? 'unknown'}</span>
          {' · version '}
          <span className="mono">{job?.currentVersionNo}</span>
          {' · last 20 runs '}
          <RunTape runs={history.data?.runs ?? []} />
        </p>
        {job?.description ? <p className="page-sub">{job.description}</p> : null}

        {job && instanceId ? (
          <JobActions
            instanceId={instanceId}
            job={job}
            pendingEnabled={pendingEnabled}
            onIssued={(message) => setNotice(message)}
            onStarting={() => {
              setStartedFrom(job.lastRunAt);
              setStarting(true);
            }}
            onToggling={(next) => {
              setToggleStalled(false);
              setPendingEnabled(next);
            }}
          />
        ) : null}
      </QueryState>

      {toggleStalled ? (
        <div className="notice">
          <span>
            SQL Agent has not confirmed that change yet. The job is still{' '}
            {enabled ? 'enabled' : 'disabled'} here — check{' '}
            <Link to="/commands">Commands</Link> for what became of it.
          </span>
          <button className="action" onClick={() => setToggleStalled(false)}>
            Dismiss
          </button>
        </div>
      ) : null}

      {notice ? (
        <div className="notice">
          {notice}
          <button className="action" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <Panel title={running ? 'This run' : starting ? 'Starting' : 'Last run'}>
        <div style={{ padding: 11 }}>
          {starting && !running ? (
            <p className="muted" style={{ margin: '0 0 8px' }}>
              Start sent. A short job can finish before SQL Server reports it as running — the
              timeline below will show the completed run either way.
            </p>
          ) : null}
          <RunTimeline
            definition={definition}
            stats={stats.data}
            history={history.data?.runs ?? []}
            running={running}
          />
        </div>
      </Panel>

      <JobSummary stats={stats.data} />

      <div className="tabs">
        <button className={tab === 'job' ? 'active' : ''} onClick={() => setTab('job')}>
          Job
        </button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          History
        </button>
        <button className={tab === 'versions' ? 'active' : ''} onClick={() => setTab('versions')}>
          Versions
        </button>
      </div>

      {tab === 'job' ? (
        job && instanceId ? (
          <JobEditor
            // Remounting on the current hash discards a stale draft once the job
            // has moved underneath the form, rather than letting the operator
            // keep editing a version that no longer exists.
            key={job.currentDefinitionHash ?? 'none'}
            instanceId={instanceId}
            job={job}
            onSaved={(message) => setNotice(message)}
          />
        ) : null
      ) : tab === 'history' ? (
        <HistoryTab
          runs={history.data?.runs ?? []}
          isLoading={history.isLoading}
          error={history.error}
        />
      ) : (
        <VersionsTab instanceId={instanceId} jobUuid={jobUuid} />
      )}
    </div>
  );
}

/** Visually equivalent to SSMS "View History": run rows, steps nested beneath. */
function HistoryTab({
  runs,
  isLoading,
  error,
}: {
  runs: HistoryRun[];
  isLoading: boolean;
  error: unknown;
}) {
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    if (open === null && runs.length > 0) setOpen(runs[0]!.sqlInstanceId);
  }, [runs, open]);

  return (
    <QueryState isLoading={isLoading} error={error}>
      <Panel title={`Run history (${runs.length})`}>
        {runs.length === 0 ? (
          <Empty
            title="No runs recorded"
            hint="History rows only appear when a step completes — that is a SQL Server limitation, not a sync delay."
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 24 }} />
                  <th>Run</th>
                  <th>Outcome</th>
                  <th className="right">Duration</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <RunRows
                    key={run.sqlInstanceId}
                    run={run}
                    open={open === run.sqlInstanceId}
                    onToggle={() => setOpen(open === run.sqlInstanceId ? null : run.sqlInstanceId)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </QueryState>
  );
}

function RunRows({ run, open, onToggle }: { run: HistoryRun; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className="expandable" onClick={onToggle}>
        <td className="faint">{open ? '▾' : '▸'}</td>
        <td className="nowrap mono">{formatDateTime(run.runDatetime)}</td>
        <td>
          <StatusDot status={run.runStatus} />
        </td>
        <td className="right nowrap mono">{formatDuration(run.runDurationSeconds)}</td>
        <td className="muted">{truncate(run.message, 110)}</td>
      </tr>
      {open
        ? run.steps.map((s) => (
            <tr key={s.sqlInstanceId} style={{ background: 'var(--bg-raised)' }}>
              <td />
              <td className="nowrap" style={{ paddingLeft: 26 }}>
                <span className="faint">Step {s.stepId}</span> {s.stepName}
                {s.retriesAttempted > 0 ? (
                  <span className="faint"> · retry {s.retriesAttempted}</span>
                ) : null}
              </td>
              <td>
                <span className="status">
                  <span className={`dot ${runStatusClass(s.runStatus)}`} aria-hidden="true" />
                  {runStatusLabel(s.runStatus)}
                </span>
              </td>
              <td className="right nowrap mono">{formatDuration(s.runDurationSeconds)}</td>
              <td className="mono" style={{ fontSize: 11.5, whiteSpace: 'pre-wrap' }}>
                {s.message}
              </td>
            </tr>
          ))
        : null}
    </>
  );
}

/** §7.2 Versions tab — timeline plus diff, with origin attribution. */
function VersionsTab({ instanceId, jobUuid }: { instanceId?: string; jobUuid?: string }) {
  const versions = useJobVersions(instanceId, jobUuid);
  // `?? []` would otherwise mint a new array every render, which the effect
  // below sees as "the list changed" even when it did not — re-running the
  // from/to initialization is harmless here, but the identity churn is exactly
  // what react-hooks/exhaustive-deps is flagging as a footgun elsewhere.
  const list = useMemo(() => versions.data?.versions ?? [], [versions.data]);
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);

  useEffect(() => {
    if (list.length >= 2 && from === null && to === null) {
      setTo(list[0]!.versionNo);
      setFrom(list[1]!.versionNo);
    }
  }, [list, from, to]);

  const diff = useDiff(instanceId, jobUuid, from, to);

  return (
    <QueryState isLoading={versions.isLoading} error={versions.error}>
      <Panel title={`Version history (${list.length})`}>
        {list.length === 0 ? (
          <Empty title="No versions recorded" />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th className="right" style={{ width: 50 }}>
                    Ver
                  </th>
                  <th>Detected</th>
                  <th>Changed</th>
                  <th>By</th>
                  <th>Hash</th>
                  <th style={{ width: 130 }}>Compare</th>
                </tr>
              </thead>
              <tbody>
                {list.map((v) => (
                  <tr key={v.id}>
                    <td className="right num">{v.versionNo}</td>
                    <td className="nowrap mono">{formatDateTime(v.detectedAt)}</td>
                    <td>
                      {/* Attribution, not alarm. Where a change came from is
                          history worth keeping; it is not a problem in itself. */}
                      {v.origin === 'local' ? (
                        <span className="muted">on the server</span>
                      ) : v.origin === 'remote' ? (
                        <span className="muted">from this dashboard</span>
                      ) : (
                        <span className="faint">first seen</span>
                      )}
                    </td>
                    <td className="muted">{v.createdBy ?? '—'}</td>
                    <td className="mono faint">{v.definitionHash.slice(0, 12)}</td>
                    <td className="nowrap">
                      <button
                        className="action"
                        style={{ padding: '2px 7px', marginRight: 4 }}
                        onClick={() => setFrom(v.versionNo)}
                        aria-pressed={from === v.versionNo}
                      >
                        {from === v.versionNo ? '● from' : 'from'}
                      </button>
                      <button
                        className="action"
                        style={{ padding: '2px 7px' }}
                        onClick={() => setTo(v.versionNo)}
                        aria-pressed={to === v.versionNo}
                      >
                        {to === v.versionNo ? '● to' : 'to'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {from !== null && to !== null && from !== to ? (
        <Panel title={`Changes from version ${from} to version ${to}`}>
          {diff.isLoading ? (
            <div className="empty">Loading diff…</div>
          ) : diff.data && diff.data.changes.length > 0 ? (
            <div>
              {diff.data.changes.map((c, idx) => (
                <div className="diff-block" key={idx}>
                  {c.kind === 'field' ? (
                    <div className="field-change">
                      <span className="muted">{c.path}</span>
                      <span>
                        <span className="before">{JSON.stringify(c.before)}</span>
                        {' → '}
                        <span className="after">{JSON.stringify(c.after)}</span>
                      </span>
                    </div>
                  ) : c.kind === 'schedule' ? (
                    <>
                      <div className="diff-head">
                        <strong>Schedule {c.change}:</strong> {c.name}
                      </div>
                      {(c.fields ?? []).map((f) => (
                        <div className="field-change" key={f.path}>
                          <span className="muted">{f.path.split('.').pop()}</span>
                          <span>
                            <span className="before">{JSON.stringify(f.before)}</span>
                            {' → '}
                            <span className="after">{JSON.stringify(f.after)}</span>
                          </span>
                        </div>
                      ))}
                    </>
                  ) : (
                    <>
                      <div className="diff-head">
                        <strong>
                          Step {c.stepId} {c.change}:
                        </strong>{' '}
                        {c.stepName}
                      </div>
                      {(c.fields ?? []).map((f) => (
                        <div className="field-change" key={f.path}>
                          <span className="muted">{f.path.split('.').pop()}</span>
                          <span>
                            <span className="before">{JSON.stringify(f.before)}</span>
                            {' → '}
                            <span className="after">{JSON.stringify(f.after)}</span>
                          </span>
                        </div>
                      ))}
                      {c.commandBefore !== undefined || c.commandAfter !== undefined ? (
                        <Suspense fallback={<div className="empty">Loading diff viewer…</div>}>
                          <MonacoDiff
                            original={c.commandBefore ?? ''}
                            modified={c.commandAfter ?? ''}
                            language="sql"
                          />
                        </Suspense>
                      ) : null}
                    </>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <Empty title="No differences" hint="These two versions are identical." />
          )}
        </Panel>
      ) : null}
    </QueryState>
  );
}

function truncate(value: string | null, max: number): string {
  if (!value) return '—';
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
