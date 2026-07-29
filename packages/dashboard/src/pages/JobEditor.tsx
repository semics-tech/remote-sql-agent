import { lazy, Suspense, useState } from 'react';
import type { JobDefinition, JobStep } from '@remote-sql-agent/protocol/browser';
import { describeSchedule, toHumaneSchedule } from '@remote-sql-agent/protocol/browser';
import { useJobActions, type JobDetail } from '../api.js';
import { Panel, Empty } from '../components.jsx';
import { notifyLevel, stepAction } from '../format.js';

const MonacoEditor = lazy(() => import('../MonacoEditor.jsx'));

/**
 * Job editor (§9.4).
 *
 * Edits a full JobDefinition.v1 and submits it as one command. Partial edits
 * are deliberately not offered: the write path applies a whole definition so
 * that what you see here is exactly what msdb will hold afterwards, which is
 * the property the round-trip fidelity test pins down.
 *
 * The base definition hash travels with the save so the worker can refuse if
 * someone changed the job in SSMS while this form was open.
 */
export function JobEditor({
  instanceId,
  job,
  onSaved,
  onCancel,
}: {
  instanceId: string;
  job: JobDetail;
  onSaved: (message: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<JobDefinition>(() =>
    structuredClone(job.definition as JobDefinition),
  );
  const [selectedStep, setSelectedStep] = useState(draft.steps[0]?.stepId ?? 1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const actions = useJobActions(instanceId, job.jobUuid);

  if (!job.definition) {
    return <Empty title="Nothing to edit" hint="No definition has been mirrored for this job." />;
  }

  const step = draft.steps.find((s) => s.stepId === selectedStep);

  function updateStep(stepId: number, patch: Partial<JobStep>): void {
    setDraft((d) => ({
      ...d,
      steps: d.steps.map((s) => (s.stepId === stepId ? { ...s, ...patch } : s)),
    }));
  }

  async function save(allowOverwrite: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await actions.save(
        draft,
        job.currentDefinitionHash ?? undefined,
        allowOverwrite,
      );
      onSaved(
        result.requiresApproval
          ? 'Saved. The change is waiting for a second person to approve it.'
          : 'Saved and sent to the worker.',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Save failed.';
      setError(message);
      if (/conflict/iu.test(message)) setConflict(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error ? <div className="error">{error}</div> : null}

      {conflict ? (
        <div className="panel" style={{ borderColor: 'var(--drift)' }}>
          <div className="panel-head" style={{ color: 'var(--drift)' }}>
            This job changed on the server while you were editing
          </div>
          <div style={{ padding: 11 }}>
            <p className="muted" style={{ marginTop: 0 }}>
              Someone edited this job on-premise — probably in SSMS — after you opened it. Your
              change was not applied. Reload to see their version and redo your edit on top of it,
              or overwrite it if you are sure yours should win.
            </p>
            <button className="action" onClick={onCancel} style={{ marginRight: 6 }}>
              Reload their version
            </button>
            <button className="action" disabled={busy} onClick={() => void save(true)}>
              Overwrite with mine
            </button>
          </div>
        </div>
      ) : null}

      <Panel title="Job">
        <div className="editor-grid">
          <label htmlFor="job-name">Name</label>
          <input
            id="job-name"
            type="text"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />

          <label htmlFor="job-desc">Description</label>
          <input
            id="job-desc"
            type="text"
            value={draft.description ?? ''}
            onChange={(e) => setDraft({ ...draft, description: e.target.value || null })}
          />

          <label htmlFor="job-enabled">Enabled</label>
          <div>
            <input
              id="job-enabled"
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            />
          </div>

          <label htmlFor="job-start">Start at step</label>
          <select
            id="job-start"
            value={draft.startStepId}
            onChange={(e) => setDraft({ ...draft, startStepId: Number(e.target.value) })}
          >
            {draft.steps.map((s) => (
              <option key={s.stepId} value={s.stepId}>
                {s.stepId}. {s.name}
              </option>
            ))}
          </select>
        </div>
      </Panel>

      <Panel title={`Steps (${draft.steps.length})`}>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th style={{ width: 40 }}>#</th>
                <th>Step name</th>
                <th>Type</th>
                <th>On success</th>
                <th>On failure</th>
                <th className="right">Retries</th>
              </tr>
            </thead>
            <tbody>
              {draft.steps.map((s) => (
                <tr
                  key={s.stepId}
                  className="expandable"
                  onClick={() => setSelectedStep(s.stepId)}
                  style={s.stepId === selectedStep ? { background: 'var(--bg-selected)' } : undefined}
                >
                  <td className="num muted">{s.stepId}</td>
                  <td className="nowrap">{s.name}</td>
                  <td className="nowrap muted">{s.subsystem}</td>
                  <td className="nowrap muted">{stepAction(s.onSuccessAction, s.onSuccessStepId)}</td>
                  <td className="nowrap muted">{stepAction(s.onFailAction, s.onFailStepId)}</td>
                  <td className="right num muted">{s.retryAttempts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {step ? (
        <Panel title={`Step ${step.stepId} — ${step.name}`}>
          <div className="editor-grid">
            <label htmlFor="step-name">Step name</label>
            <input
              id="step-name"
              type="text"
              value={step.name}
              onChange={(e) => updateStep(step.stepId, { name: e.target.value })}
            />

            <label htmlFor="step-db">Database</label>
            <input
              id="step-db"
              type="text"
              value={step.databaseName ?? ''}
              onChange={(e) => updateStep(step.stepId, { databaseName: e.target.value || null })}
            />

            <label htmlFor="step-retries">Retry attempts</label>
            <input
              id="step-retries"
              type="text"
              inputMode="numeric"
              value={String(step.retryAttempts)}
              onChange={(e) =>
                updateStep(step.stepId, { retryAttempts: Number(e.target.value) || 0 })
              }
            />
          </div>

          <div style={{ padding: '0 11px 11px' }}>
            <div className="editor-label">Command</div>
            <Suspense fallback={<pre className="code">{step.command}</pre>}>
              <MonacoEditor
                value={step.command}
                language={step.subsystem === 'PowerShell' ? 'powershell' : 'sql'}
                onChange={(value) => updateStep(step.stepId, { command: value })}
              />
            </Suspense>
          </div>
        </Panel>
      ) : null}

      <Panel title={`Schedules (${draft.schedules.length})`}>
        {draft.schedules.length === 0 ? (
          <Empty title="Not scheduled" />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Enabled</th>
                  <th>Occurs</th>
                  <th>Starts</th>
                </tr>
              </thead>
              <tbody>
                {draft.schedules.map((s, index) => (
                  <tr key={s.name}>
                    <td className="nowrap">{s.name}</td>
                    <td>
                      <input
                        type="checkbox"
                        checked={s.enabled}
                        aria-label={`${s.name} enabled`}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            schedules: d.schedules.map((x, i) =>
                              i === index ? { ...x, enabled: e.target.checked } : x,
                            ),
                          }))
                        }
                      />
                    </td>
                    <td className="muted">{describeSchedule(s)}</td>
                    <td className="muted mono">{toHumaneSchedule(s).startDate}</td>
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
            {draft.notifications.emailOperatorName ?? '—'}{' '}
            <span className="faint">({notifyLevel(draft.notifications.emailLevel)})</span>
          </dd>
        </dl>
      </Panel>

      <div className="action-bar">
        <button className="action primary" disabled={busy} onClick={() => void save(false)}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
        <button className="action" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <span className="faint">
          Saving replaces the whole job definition on the server, exactly as shown here.
        </span>
      </div>
    </>
  );
}
