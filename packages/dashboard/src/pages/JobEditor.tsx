import { lazy, Suspense, useMemo, useState } from 'react';
import type { JobDefinition, JobStep } from '@remote-sql-agent/protocol/browser';
import {
  StepAction,
  addStep,
  describeSchedule,
  moveStep,
  removeStep,
  toHumaneSchedule,
  updateStep,
} from '@remote-sql-agent/protocol/browser';
import { useInstanceCapabilities, useJobActions, type JobDetail } from '../api.js';
import { Panel, Empty } from '../components.jsx';
import { notifyLevel, stepAction } from '../format.js';
import { useAuth } from '../auth.jsx';

const MonacoEditor = lazy(() => import('../MonacoEditor.jsx'));

/**
 * The job, editable in place.
 *
 * There is no separate "edit page": clicking a job lands here, the way opening
 * a job in SSMS lands on its properties. Read-only is a *state* of this screen
 * rather than a different screen, so an operator who cannot write sees exactly
 * the layout they would edit, with the controls disabled and a reason given.
 *
 * A save submits the whole definition as one command, so what is on screen is
 * exactly what msdb ends up holding — the property the round-trip fidelity test
 * pins down. The base hash travels with it so the worker refuses if someone
 * changed the job in SSMS while this was open.
 */
export function JobEditor({
  instanceId,
  job,
  onSaved,
}: {
  instanceId: string;
  job: JobDetail;
  onSaved: (message: string) => void;
}) {
  const original = job.definition as JobDefinition | null;
  const [draft, setDraft] = useState<JobDefinition | null>(() =>
    original ? structuredClone(original) : null,
  );
  const [selectedStep, setSelectedStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [conflict, setConflict] = useState(false);

  const actions = useJobActions(instanceId, job.jobUuid);
  const capabilities = useInstanceCapabilities(instanceId);
  const { can } = useAuth();

  const workerCanWrite = capabilities.data?.workerCapabilities.includes('job.write') ?? false;
  const editable = workerCanWrite && can('job.write');
  const needsApproval = capabilities.data?.approvalRequiredForJobWrite ?? false;

  // Structural comparison rather than a dirty flag per field: a step moved and
  // moved back is not a change, and offering to save it invites a pointless
  // command through the approval flow.
  const dirty = useMemo(
    () => draft !== null && JSON.stringify(draft) !== JSON.stringify(original),
    [draft, original],
  );

  if (!original || !draft) {
    return <Empty title="Nothing to edit" hint="No definition has been mirrored for this job." />;
  }

  const step = draft.steps.find((s) => s.stepId === selectedStep) ?? draft.steps[0];

  /** Every structural edit goes through the protocol helpers, which renumber
   * steps and repair "go to step N" references. Doing it here by hand is how
   * a job silently ends up branching to the wrong step. */
  function structural(fn: () => { definition: JobDefinition; warnings: string[] }): void {
    const result = fn();
    setDraft(result.definition);
    setWarnings(result.warnings);
  }

  function patchStep(stepId: number, patch: Partial<JobStep>): void {
    setDraft((d) => (d ? updateStep(d, stepId, patch) : d));
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
      setConflict(false);
      setWarnings([]);
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

  function discard(): void {
    setDraft(structuredClone(original!));
    setWarnings([]);
    setError(null);
    setConflict(false);
  }

  return (
    <>
      {error ? <div className="error">{error}</div> : null}

      {warnings.length > 0 ? (
        <div className="notice">
          <div>
            <strong>Reference changes made for you</strong>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
          <button className="action" onClick={() => setWarnings([])}>
            Dismiss
          </button>
        </div>
      ) : null}

      {conflict ? (
        <div className="panel" style={{ borderColor: 'var(--drift)' }}>
          <div className="panel-head" style={{ color: 'var(--drift)' }}>
            This job changed on the server while you were editing
          </div>
          <div style={{ padding: 11 }}>
            <p className="muted" style={{ marginTop: 0 }}>
              Someone edited this job on-premise — probably in SSMS — after you opened it. Your
              change was not applied. Discard to see their version and redo your edit on top of it,
              or overwrite it if you are sure yours should win.
            </p>
            <button className="action" onClick={discard} style={{ marginRight: 6 }}>
              Discard mine and reload
            </button>
            <button className="action" disabled={busy} onClick={() => void save(true)}>
              Overwrite with mine
            </button>
          </div>
        </div>
      ) : null}

      {!editable ? (
        <div className="notice">
          {workerCanWrite
            ? 'Your role does not allow editing jobs, so this is read-only.'
            : `Worker ${capabilities.data?.hostName ?? ''} is not permitted to write, so this is read-only. ` +
              'Grant it job.write in Administration and raise its local maxCapability.'}
        </div>
      ) : null}

      <Panel title="Job">
        <div className="editor-grid">
          <label htmlFor="job-name">Name</label>
          <input
            id="job-name"
            type="text"
            value={draft.name}
            disabled={!editable}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />

          <label htmlFor="job-desc">Description</label>
          <input
            id="job-desc"
            type="text"
            value={draft.description ?? ''}
            disabled={!editable}
            onChange={(e) => setDraft({ ...draft, description: e.target.value || null })}
          />

          <label htmlFor="job-category">Category</label>
          <input
            id="job-category"
            type="text"
            value={draft.categoryName ?? ''}
            disabled={!editable}
            onChange={(e) => setDraft({ ...draft, categoryName: e.target.value || null })}
          />

          <label htmlFor="job-enabled">Enabled</label>
          <div>
            <input
              id="job-enabled"
              type="checkbox"
              checked={draft.enabled}
              disabled={!editable}
              onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            />
          </div>

          <label htmlFor="job-start">Start at step</label>
          <select
            id="job-start"
            value={draft.startStepId}
            disabled={!editable}
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

      <Panel
        title={`Steps (${draft.steps.length})`}
        actions={
          editable ? (
            <button
              className="action"
              onClick={() =>
                structural(() => {
                  const result = addStep(draft, { afterStepId: step?.stepId ?? null });
                  // Select what was just created: the operator's next action is
                  // always to type into it.
                  setSelectedStep((step?.stepId ?? draft.steps.length) + 1);
                  return result;
                })
              }
            >
              Add step
            </button>
          ) : undefined
        }
      >
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
                {editable ? <th style={{ width: 130 }}>Order</th> : null}
              </tr>
            </thead>
            <tbody>
              {draft.steps.map((s, index) => (
                <tr
                  key={s.stepId}
                  className="expandable"
                  onClick={() => setSelectedStep(s.stepId)}
                  style={s.stepId === step?.stepId ? { background: 'var(--bg-selected)' } : undefined}
                >
                  <td className="num muted">{s.stepId}</td>
                  <td className="nowrap">
                    {draft.startStepId === s.stepId ? '▸ ' : ''}
                    {s.name}
                  </td>
                  <td className="nowrap muted">{s.subsystem}</td>
                  <td className="nowrap muted">{stepAction(s.onSuccessAction, s.onSuccessStepId)}</td>
                  <td className="nowrap muted">{stepAction(s.onFailAction, s.onFailStepId)}</td>
                  <td className="right num muted">{s.retryAttempts}</td>
                  {editable ? (
                    <td className="nowrap" onClick={(e) => e.stopPropagation()}>
                      <button
                        className="action icon"
                        aria-label={`Move ${s.name} up`}
                        disabled={index === 0}
                        onClick={() => structural(() => moveStep(draft, s.stepId, 'up'))}
                      >
                        ↑
                      </button>
                      <button
                        className="action icon"
                        aria-label={`Move ${s.name} down`}
                        disabled={index === draft.steps.length - 1}
                        onClick={() => structural(() => moveStep(draft, s.stepId, 'down'))}
                      >
                        ↓
                      </button>
                      <button
                        className="action icon danger"
                        aria-label={`Remove ${s.name}`}
                        onClick={() => structural(() => removeStep(draft, s.stepId))}
                      >
                        ✕
                      </button>
                    </td>
                  ) : null}
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
              disabled={!editable}
              onChange={(e) => patchStep(step.stepId, { name: e.target.value })}
            />

            <label htmlFor="step-type">Type</label>
            <select
              id="step-type"
              value={step.subsystem}
              disabled={!editable}
              onChange={(e) =>
                patchStep(step.stepId, { subsystem: e.target.value as JobStep['subsystem'] })
              }
            >
              {['TSQL', 'CmdExec', 'PowerShell', 'SSIS'].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>

            <label htmlFor="step-db">Database</label>
            <input
              id="step-db"
              type="text"
              value={step.databaseName ?? ''}
              disabled={!editable}
              onChange={(e) => patchStep(step.stepId, { databaseName: e.target.value || null })}
            />

            <label htmlFor="step-success">On success</label>
            <StepActionPicker
              id="step-success"
              action={step.onSuccessAction}
              targetStepId={step.onSuccessStepId}
              steps={draft.steps}
              currentStepId={step.stepId}
              disabled={!editable}
              onChange={(onSuccessAction, onSuccessStepId) =>
                patchStep(step.stepId, { onSuccessAction, onSuccessStepId })
              }
            />

            <label htmlFor="step-fail">On failure</label>
            <StepActionPicker
              id="step-fail"
              action={step.onFailAction}
              targetStepId={step.onFailStepId}
              steps={draft.steps}
              currentStepId={step.stepId}
              disabled={!editable}
              onChange={(onFailAction, onFailStepId) =>
                patchStep(step.stepId, { onFailAction, onFailStepId })
              }
            />

            <label htmlFor="step-retries">Retry attempts</label>
            <input
              id="step-retries"
              type="text"
              inputMode="numeric"
              value={String(step.retryAttempts)}
              disabled={!editable}
              onChange={(e) =>
                patchStep(step.stepId, { retryAttempts: Number(e.target.value) || 0 })
              }
            />

            <label htmlFor="step-retry-interval">Retry interval (minutes)</label>
            <input
              id="step-retry-interval"
              type="text"
              inputMode="numeric"
              value={String(step.retryIntervalMinutes)}
              disabled={!editable}
              onChange={(e) =>
                patchStep(step.stepId, { retryIntervalMinutes: Number(e.target.value) || 0 })
              }
            />
          </div>

          <div style={{ padding: '0 11px 11px' }}>
            <div className="editor-label">Command</div>
            <Suspense fallback={<pre className="code">{step.command}</pre>}>
              <MonacoEditor
                value={step.command}
                language={step.subsystem === 'PowerShell' ? 'powershell' : 'sql'}
                readOnly={!editable}
                onChange={(value) => patchStep(step.stepId, { command: value })}
              />
            </Suspense>
          </div>
        </Panel>
      ) : null}

      <Panel title={`Schedules (${draft.schedules.length})`}>
        {draft.schedules.length === 0 ? (
          <Empty title="Not scheduled" hint="This job only runs when started manually or by an alert." />
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
                        disabled={!editable}
                        aria-label={`${s.name} enabled`}
                        onChange={(e) =>
                          setDraft((d) =>
                            d
                              ? {
                                  ...d,
                                  schedules: d.schedules.map((x, i) =>
                                    i === index ? { ...x, enabled: e.target.checked } : x,
                                  ),
                                }
                              : d,
                          )
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
          <dt>Page</dt>
          <dd>
            {draft.notifications.pageOperatorName ?? '—'}{' '}
            <span className="faint">({notifyLevel(draft.notifications.pageLevel)})</span>
          </dd>
          <dt>Write to the Windows event log</dt>
          <dd className="muted">{notifyLevel(draft.notifications.eventlogLevel)}</dd>
        </dl>
        <div style={{ padding: '0 11px 11px' }} className="faint">
          These are SQL Agent's own operator notifications, set per instance. Estate-wide alerting
          to email, Slack or Teams is configured in Administration → Notifications.
        </div>
      </Panel>

      {/* Only present once there is something to save. A permanently visible
          save bar on a read-only screen is just noise. */}
      {editable && dirty ? (
        <div className="action-bar sticky">
          <button className="action primary" disabled={busy} onClick={() => void save(false)}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
          <button className="action" disabled={busy} onClick={discard}>
            Discard
          </button>
          <span className="faint">
            Replaces the whole job definition on the server, exactly as shown here.
            {needsApproval ? ' Another person will need to approve it before it applies.' : ''}
          </span>
        </div>
      ) : null}
    </>
  );
}

/**
 * The on-success / on-failure control.
 *
 * Two inputs that behave as one: the target step only exists for "go to step",
 * and offering a step picker that is ignored for the other three actions is how
 * people end up believing they set a branch they did not.
 */
function StepActionPicker({
  id,
  action,
  targetStepId,
  steps,
  currentStepId,
  disabled,
  onChange,
}: {
  id: string;
  action: number;
  targetStepId: number;
  steps: JobStep[];
  currentStepId: number;
  disabled: boolean;
  onChange: (action: number, targetStepId: number) => void;
}) {
  const others = steps.filter((s) => s.stepId !== currentStepId);
  const fallbackTarget = others[0]?.stepId ?? currentStepId;

  return (
    <div className="inline-fields">
      <select
        id={id}
        value={action}
        disabled={disabled}
        onChange={(e) => {
          const next = Number(e.target.value);
          onChange(next, next === StepAction.GoToStep ? targetStepId || fallbackTarget : 0);
        }}
      >
        <option value={StepAction.QuitWithSuccess}>Quit reporting success</option>
        <option value={StepAction.QuitWithFailure}>Quit reporting failure</option>
        <option value={StepAction.GoToNextStep}>Go to the next step</option>
        <option value={StepAction.GoToStep} disabled={others.length === 0}>
          Go to step…
        </option>
      </select>

      {action === StepAction.GoToStep ? (
        <select
          aria-label="Target step"
          value={targetStepId || fallbackTarget}
          disabled={disabled}
          onChange={(e) => onChange(StepAction.GoToStep, Number(e.target.value))}
        >
          {others.map((s) => (
            <option key={s.stepId} value={s.stepId}>
              {s.stepId}. {s.name}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}
