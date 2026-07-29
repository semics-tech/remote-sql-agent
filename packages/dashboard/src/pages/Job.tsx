import { Link, useParams } from 'react-router-dom';
import { lazy, Suspense, useEffect, useState } from 'react';
import { useDiff, useJob, useJobHistory, useJobVersions, type HistoryRun } from '../api.js';
import { Panel, QueryState, Empty, RunTape, StatusDot } from '../components.jsx';
import {
  formatDateTime,
  formatDuration,
  notifyLevel,
  runStatusClass,
  runStatusLabel,
  stepAction,
} from '../format.js';
import { describeSchedule } from '@rsagent/protocol/browser';

// Monaco is ~2 MB; it only appears on the Versions tab, so it must not be in
// the bundle that renders the estate grid.
const MonacoDiff = lazy(() => import('../MonacoDiff.jsx'));

type Tab = 'steps' | 'history' | 'versions';

/** §9.3 Job detail — Steps, History (SSMS "View History"), Versions. */
export function Job() {
  const { instanceId, jobUuid } = useParams();
  const [tab, setTab] = useState<Tab>('steps');
  const job = useJob(instanceId, jobUuid);
  const history = useJobHistory(instanceId, jobUuid);

  const definition = job.data?.definition ?? null;

  return (
    <div className="page">
      <QueryState isLoading={job.isLoading} error={job.error}>
        <div className="page-head">
          <h2>{job.data?.name}</h2>
          {job.data?.isDrifted ? <span className="badge drift">Drifted</span> : null}
          {job.data?.enabled === false ? <span className="badge neutral">Disabled</span> : null}
          {job.data?.activity?.state === 'executing' ? (
            <span className="badge running">Running</span>
          ) : null}
        </div>
        <p className="page-sub">
          <Link to={`/instances/${instanceId}`}>← back to instance</Link>
          {' · '}
          <span className="mono">{job.data?.categoryName ?? 'uncategorised'}</span>
          {' · owner '}
          <span className="mono">{job.data?.ownerLoginName ?? 'unknown'}</span>
          {' · version '}
          <span className="mono">{job.data?.currentVersionNo}</span>
          {' · last 20 runs '}
          <RunTape runs={history.data?.runs ?? []} />
        </p>
        {job.data?.description ? <p className="page-sub">{job.data.description}</p> : null}
      </QueryState>

      <div className="tabs">
        <button className={tab === 'steps' ? 'active' : ''} onClick={() => setTab('steps')}>
          Steps &amp; Schedules
        </button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          History
        </button>
        <button className={tab === 'versions' ? 'active' : ''} onClick={() => setTab('versions')}>
          Versions
        </button>
      </div>

      {tab === 'steps' ? (
        <StepsTab definition={definition} />
      ) : tab === 'history' ? (
        <HistoryTab runs={history.data?.runs ?? []} isLoading={history.isLoading} error={history.error} />
      ) : (
        <VersionsTab instanceId={instanceId} jobUuid={jobUuid} />
      )}
    </div>
  );
}

function StepsTab({ definition }: { definition: NonNullable<ReturnType<typeof useJob>['data']>['definition'] }) {
  const [openStep, setOpenStep] = useState<number | null>(1);

  if (!definition) return <Empty title="No definition recorded yet" hint="The worker has not sent a snapshot for this job." />;

  return (
    <>
      <Panel title={`Steps (${definition.steps.length})`}>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th style={{ width: 40 }}>#</th>
                <th>Step name</th>
                <th>Type</th>
                <th>Database</th>
                <th>On success</th>
                <th>On failure</th>
                <th className="right">Retries</th>
              </tr>
            </thead>
            <tbody>
              {definition.steps.map((s) => (
                <tr
                  key={s.stepId}
                  className="expandable"
                  onClick={() => setOpenStep(openStep === s.stepId ? null : s.stepId)}
                >
                  <td className="num muted">{s.stepId}</td>
                  <td className="nowrap">
                    {definition.startStepId === s.stepId ? '▸ ' : ''}
                    {s.name}
                  </td>
                  <td className="nowrap muted">{s.subsystem}</td>
                  <td className="nowrap muted mono">{s.databaseName ?? '—'}</td>
                  <td className="nowrap muted">{stepAction(s.onSuccessAction, s.onSuccessStepId)}</td>
                  <td className="nowrap muted">{stepAction(s.onFailAction, s.onFailStepId)}</td>
                  <td className="right num muted">{s.retryAttempts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {definition.steps
        .filter((s) => s.stepId === openStep)
        .map((s) => (
          <Panel key={s.stepId} title={`Step ${s.stepId} — ${s.name} (${s.subsystem})`}>
            <div style={{ padding: 11 }}>
              <pre className="code">{s.command || '(empty)'}</pre>
            </div>
          </Panel>
        ))}

      <Panel title={`Schedules (${definition.schedules.length})`}>
        {definition.schedules.length === 0 ? (
          <Empty title="Not scheduled" hint="This job only runs when started manually or by an alert." />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Enabled</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {definition.schedules.map((s) => (
                  <tr key={s.name}>
                    <td className="nowrap">{s.name}</td>
                    <td className="muted">{s.enabled ? 'Yes' : 'No'}</td>
                    <td className="muted">{describeSchedule(s)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Notifications">
        <dl className="kv">
          <dt>Email</dt>
          <dd>
            {definition.notifications.emailOperatorName ?? '—'}{' '}
            <span className="faint">({notifyLevel(definition.notifications.emailLevel)})</span>
          </dd>
          <dt>Page</dt>
          <dd>
            {definition.notifications.pageOperatorName ?? '—'}{' '}
            <span className="faint">({notifyLevel(definition.notifications.pageLevel)})</span>
          </dd>
          <dt>Write to the Windows event log</dt>
          <dd className="muted">{notifyLevel(definition.notifications.eventlogLevel)}</dd>
        </dl>
      </Panel>
    </>
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
  const list = versions.data?.versions ?? [];
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
                  <th>Origin</th>
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
                      {v.origin === 'local' ? (
                        <span className="badge drift" title="Changed on the server itself, e.g. in SSMS">
                          on-premise edit
                        </span>
                      ) : v.origin === 'remote' ? (
                        <span className="badge online">dashboard change</span>
                      ) : (
                        <span className="badge neutral">first seen</span>
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
                            language={languageFor(c.stepName)}
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

function languageFor(_stepName: string): string {
  // Monaco has no SQL Agent dialect; plain 'sql' highlights T-SQL adequately and
  // is right for the overwhelming majority of step bodies.
  return 'sql';
}

function truncate(value: string | null, max: number): string {
  if (!value) return '—';
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
