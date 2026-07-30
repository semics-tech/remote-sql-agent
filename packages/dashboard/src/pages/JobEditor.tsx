import { Fragment, lazy, Suspense, useMemo, useState } from 'react';
import type { JobDefinition, JobStep } from '@remote-sql-agent/protocol/browser';
import {
  StepAction,
  addStep,
  describeSchedule,
  disableStep,
  enableStep,
  moveStep,
  reachableSteps,
  removeStep,
  reorderStep,
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
 *
 * Steps, schedules and notifications are separate sections of one form rather
 * than separate screens, because they are saved together: a draft that spans
 * all three needs one save bar, visible from wherever the last edit was made.
 */

type Section = 'steps' | 'schedules' | 'notifications';

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
  const [section, setSection] = useState<Section>('steps');
  // Null, not 1: the step list is the overview, and opening every job with one
  // step's body already expanded buries the shape of the job under a T-SQL
  // editor nobody asked for yet.
  const [expandedStep, setExpandedStep] = useState<number | null>(null);
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

      <div className="tabs subtabs">
        <button
          className={section === 'steps' ? 'active' : ''}
          onClick={() => setSection('steps')}
        >
          Steps <span className="tab-count">{draft.steps.length}</span>
        </button>
        <button
          className={section === 'schedules' ? 'active' : ''}
          onClick={() => setSection('schedules')}
        >
          Schedules <span className="tab-count">{draft.schedules.length}</span>
        </button>
        <button
          className={section === 'notifications' ? 'active' : ''}
          onClick={() => setSection('notifications')}
        >
          Notifications
        </button>
      </div>

      {section === 'steps' ? (
        <StepsSection
          draft={draft}
          editable={editable}
          expandedStep={expandedStep}
          onExpand={setExpandedStep}
          onStructural={structural}
          onPatchStep={patchStep}
        />
      ) : section === 'schedules' ? (
        <SchedulesSection
          draft={draft}
          editable={editable}
          onToggleSchedule={(index, enabled) =>
            setDraft((d) =>
              d
                ? {
                    ...d,
                    schedules: d.schedules.map((x, i) => (i === index ? { ...x, enabled } : x)),
                  }
                : d,
            )
          }
        />
      ) : (
        <NotificationsSection draft={draft} />
      )}

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
 * The step list, and one step's detail at a time.
 *
 * Collapsed by default because the list *is* the useful view: what the job
 * does, in order, and where it branches. The body of a step is a T-SQL editor
 * that fills the screen, so it opens on the row you asked for and nowhere else.
 */
function StepsSection({
  draft,
  editable,
  expandedStep,
  onExpand,
  onStructural,
  onPatchStep,
}: {
  draft: JobDefinition;
  editable: boolean;
  expandedStep: number | null;
  onExpand: (stepId: number | null) => void;
  onStructural: (fn: () => { definition: JobDefinition; warnings: string[] }) => void;
  onPatchStep: (stepId: number, patch: Partial<JobStep>) => void;
}) {
  // Which row is being dragged, and which row the pointer is currently over.
  const [dragging, setDragging] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const columns = editable ? 8 : 7;

  // SQL Agent has no disabled-step flag, so "will not run" and "nothing can
  // reach it" are the same condition — which means one control and one
  // explanation, rather than a switch and a separate warning that contradict
  // each other whenever someone rewires a job by hand in SSMS.
  const reachable = reachableSteps(draft);
  const disabledCount = draft.steps.filter((s) => !reachable.has(s.stepId)).length;

  function endDrag(): void {
    setDragging(null);
    setDropIndex(null);
  }

  return (
    <Panel
      title={`Steps (${draft.steps.length})`}
      actions={
        editable ? (
          <button
            className="action"
            onClick={() =>
              onStructural(() => {
                const after = expandedStep ?? null;
                const result = addStep(draft, { afterStepId: after });
                // Open what was just created: the next action is always to
                // type into it.
                onExpand((after ?? draft.steps.length) + 1);
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
              <th style={{ width: 52 }}>#</th>
              <th style={{ width: 44 }} title="Whether the job can reach this step at all">
                Runs
              </th>
              <th>Step name</th>
              <th>Type</th>
              <th>On success</th>
              <th>On failure</th>
              <th className="right">Retries</th>
              {editable ? <th style={{ width: 130 }}>Order</th> : null}
            </tr>
          </thead>
          <tbody>
            {draft.steps.map((s, index) => {
              const open = s.stepId === expandedStep;
              const runs = reachable.has(s.stepId);
              const rowClass = [
                'expandable',
                'step-row',
                runs ? '' : 'step-off',
                dragging === s.stepId ? 'dragging' : '',
                dropIndex === index && dragging !== null && dragging !== s.stepId
                  ? 'drop-target'
                  : '',
              ]
                .filter(Boolean)
                .join(' ');

              return (
                <Fragment key={s.stepId}>
                  <tr
                    className={rowClass}
                    draggable={editable}
                    onClick={() => onExpand(open ? null : s.stepId)}
                    onDragStart={(e) => {
                      setDragging(s.stepId);
                      e.dataTransfer.effectAllowed = 'move';
                      // Firefox will not start a drag without payload.
                      e.dataTransfer.setData('text/plain', String(s.stepId));
                    }}
                    onDragOver={(e) => {
                      if (dragging === null) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      setDropIndex(index);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragging !== null && dragging !== s.stepId) {
                        const moved = dragging;
                        onStructural(() => reorderStep(draft, moved, index));
                        // Step ids are positions, so the dragged step is now
                        // numbered by where it landed.
                        if (expandedStep === moved) onExpand(index + 1);
                      }
                      endDrag();
                    }}
                    onDragEnd={endDrag}
                  >
                    <td className="num muted nowrap">
                      {editable ? (
                        <span className="drag-grip" aria-hidden="true">
                          ⠿
                        </span>
                      ) : null}
                      {s.stepId}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={runs}
                        disabled={!editable}
                        aria-label={`${s.name} runs`}
                        title={
                          runs
                            ? 'Clear to route the job around this step. The step stays in the job.'
                            : 'This step cannot be reached, so it never runs. Tick to put it back in the flow.'
                        }
                        onChange={(e) =>
                          onStructural(() =>
                            e.target.checked
                              ? enableStep(draft, s.stepId)
                              : disableStep(draft, s.stepId),
                          )
                        }
                      />
                    </td>
                    <td className="nowrap">
                      <span className="faint">{open ? '▾' : '▸'}</span>{' '}
                      {draft.startStepId === s.stepId ? (
                        <span title="The job starts here">▸ </span>
                      ) : null}
                      {s.name}
                      {runs ? null : (
                        <>
                          {' '}
                          <span className="badge neutral">off</span>
                        </>
                      )}
                    </td>
                    <td className="nowrap muted">{s.subsystem}</td>
                    <td className="nowrap muted">
                      {stepAction(s.onSuccessAction, s.onSuccessStepId)}
                    </td>
                    <td className="nowrap muted">{stepAction(s.onFailAction, s.onFailStepId)}</td>
                    <td className="right num muted">{s.retryAttempts}</td>
                    {editable ? (
                      <td className="nowrap" onClick={(e) => e.stopPropagation()}>
                        {/* Kept alongside dragging, not replaced by it: reordering
                            has to be reachable from a keyboard. */}
                        <button
                          className="action icon"
                          aria-label={`Move ${s.name} up`}
                          disabled={index === 0}
                          onClick={() => {
                            onStructural(() => moveStep(draft, s.stepId, 'up'));
                            if (expandedStep === s.stepId) onExpand(s.stepId - 1);
                          }}
                        >
                          ↑
                        </button>
                        <button
                          className="action icon"
                          aria-label={`Move ${s.name} down`}
                          disabled={index === draft.steps.length - 1}
                          onClick={() => {
                            onStructural(() => moveStep(draft, s.stepId, 'down'));
                            if (expandedStep === s.stepId) onExpand(s.stepId + 1);
                          }}
                        >
                          ↓
                        </button>
                        <button
                          className="action icon danger"
                          aria-label={`Remove ${s.name}`}
                          onClick={() => {
                            onStructural(() => removeStep(draft, s.stepId));
                            if (expandedStep === s.stepId) onExpand(null);
                          }}
                        >
                          ✕
                        </button>
                      </td>
                    ) : null}
                  </tr>

                  {open ? (
                    <tr className="step-detail-row">
                      <td colSpan={columns}>
                        <StepDetail
                          step={s}
                          steps={draft.steps}
                          editable={editable}
                          onPatch={(patch) => onPatchStep(s.stepId, patch)}
                        />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {disabledCount > 0 ? (
        <div className="notice" style={{ margin: '0 11px 9px' }}>
          <span>
            <strong>
              {disabledCount === 1
                ? '1 step will not run'
                : `${disabledCount} steps will not run`}
            </strong>
            <br />
            SQL Agent has no switch for turning a step off, so this product does it the only way
            the server understands: the job is routed around the step, and the step stays exactly
            where it is. Nothing can reach it, so it never runs — including if you uninstall the
            worker. Tick <em>Runs</em> to put it back in the flow.
          </span>
        </div>
      ) : null}

      {editable ? (
        <div className="faint" style={{ padding: '0 11px 9px' }}>
          Drag a row to reorder, or use the arrows. SQL Agent numbers steps by position, so any
          &ldquo;go to step&rdquo; branches are repointed to follow the steps they name, and a step
          arriving at the end of the list stops the job rather than running off it.
        </div>
      ) : null}
    </Panel>
  );
}

/** One step's properties and its command body. */
function StepDetail({
  step,
  steps,
  editable,
  onPatch,
}: {
  step: JobStep;
  steps: JobStep[];
  editable: boolean;
  onPatch: (patch: Partial<JobStep>) => void;
}) {
  return (
    <div className="step-detail">
      <div className="editor-grid">
        <label htmlFor={`step-name-${step.stepId}`}>Step name</label>
        <input
          id={`step-name-${step.stepId}`}
          type="text"
          value={step.name}
          disabled={!editable}
          onChange={(e) => onPatch({ name: e.target.value })}
        />

        <label htmlFor={`step-type-${step.stepId}`}>Type</label>
        <select
          id={`step-type-${step.stepId}`}
          value={step.subsystem}
          disabled={!editable}
          onChange={(e) => onPatch({ subsystem: e.target.value as JobStep['subsystem'] })}
        >
          {['TSQL', 'CmdExec', 'PowerShell', 'SSIS'].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <label htmlFor={`step-db-${step.stepId}`}>Database</label>
        <input
          id={`step-db-${step.stepId}`}
          type="text"
          value={step.databaseName ?? ''}
          disabled={!editable}
          onChange={(e) => onPatch({ databaseName: e.target.value || null })}
        />

        <label htmlFor={`step-success-${step.stepId}`}>On success</label>
        <StepActionPicker
          id={`step-success-${step.stepId}`}
          action={step.onSuccessAction}
          targetStepId={step.onSuccessStepId}
          steps={steps}
          currentStepId={step.stepId}
          disabled={!editable}
          onChange={(onSuccessAction, onSuccessStepId) =>
            onPatch({ onSuccessAction, onSuccessStepId })
          }
        />

        <label htmlFor={`step-fail-${step.stepId}`}>On failure</label>
        <StepActionPicker
          id={`step-fail-${step.stepId}`}
          action={step.onFailAction}
          targetStepId={step.onFailStepId}
          steps={steps}
          currentStepId={step.stepId}
          disabled={!editable}
          onChange={(onFailAction, onFailStepId) => onPatch({ onFailAction, onFailStepId })}
        />

        <label htmlFor={`step-retries-${step.stepId}`}>Retry attempts</label>
        <input
          id={`step-retries-${step.stepId}`}
          type="text"
          inputMode="numeric"
          value={String(step.retryAttempts)}
          disabled={!editable}
          onChange={(e) => onPatch({ retryAttempts: Number(e.target.value) || 0 })}
        />

        <label htmlFor={`step-retry-interval-${step.stepId}`}>Retry interval (minutes)</label>
        <input
          id={`step-retry-interval-${step.stepId}`}
          type="text"
          inputMode="numeric"
          value={String(step.retryIntervalMinutes)}
          disabled={!editable}
          onChange={(e) => onPatch({ retryIntervalMinutes: Number(e.target.value) || 0 })}
        />
      </div>

      <div style={{ padding: '0 11px 11px' }}>
        <div className="editor-label">Command</div>
        <Suspense fallback={<pre className="code">{step.command}</pre>}>
          <MonacoEditor
            value={step.command}
            language={step.subsystem === 'PowerShell' ? 'powershell' : 'sql'}
            readOnly={!editable}
            onChange={(value) => onPatch({ command: value })}
          />
        </Suspense>
      </div>
    </div>
  );
}

function SchedulesSection({
  draft,
  editable,
  onToggleSchedule,
}: {
  draft: JobDefinition;
  editable: boolean;
  onToggleSchedule: (index: number, enabled: boolean) => void;
}) {
  return (
    <Panel title={`Schedules (${draft.schedules.length})`}>
      {draft.schedules.length === 0 ? (
        <Empty
          title="Not scheduled"
          hint="This job only runs when started manually or by an alert."
        />
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
                      onChange={(e) => onToggleSchedule(index, e.target.checked)}
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
  );
}

function NotificationsSection({ draft }: { draft: JobDefinition }) {
  return (
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
        These are SQL Agent&apos;s own operator notifications, set per instance. Estate-wide
        alerting to email, Slack or Teams is configured in Administration → Notifications.
      </div>
    </Panel>
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
