import { useEffect, useState } from 'react';
import type { JobDefinition } from '@remote-sql-agent/protocol/browser';
import type { JobStats } from '../api.js';
import { formatDuration, runStatusClass, stepAction } from '../format.js';

/**
 * The step flow, with the running step marked.
 *
 * A DBA watching a long job wants two things SSMS cannot give them at a glance:
 * which step it is on, and whether that is taking longer than it usually does.
 * Both are here, per step, so "step 3 is at four minutes against a usual forty
 * seconds" is legible without opening anything.
 *
 * One SQL Server behaviour shapes this entirely: msdb writes a step's history
 * row when the step *finishes*. So a completed step has a real duration, and
 * the running step has none — its elapsed time has to be derived from the run's
 * start and the durations of the steps already done.
 */

export type StepState = 'succeeded' | 'failed' | 'running' | 'pending' | 'skipped';

export interface StepView {
  stepId: number;
  name: string;
  subsystem: string;
  state: StepState;
  /** Seconds this run, when known. */
  actualSeconds: number | null;
  averageSeconds: number | null;
  lastSeconds: number | null;
  onSuccess: string;
  onFail: string;
  message: string | null;
}

/**
 * Merge the definition with this run's history and the per-step baselines.
 *
 * Exported so the shape is testable without a DOM: the state assignment here is
 * the part that would be wrong in a way nobody notices.
 */
export function buildStepViews(
  definition: JobDefinition | null,
  stats: JobStats | undefined,
  elapsedOverride: number | null,
): StepView[] {
  if (!definition) return [];

  const baselines = new Map((stats?.steps ?? []).map((s) => [s.stepId, s]));
  const current = stats?.currentRun ?? null;
  const completed = new Map((current?.completedSteps ?? []).map((s) => [s.stepId, s]));

  // Time the running step has been going: the run's elapsed, less everything
  // already accounted for by finished steps.
  const accountedFor = (current?.completedSteps ?? []).reduce(
    (total, s) => total + s.runDurationSeconds,
    0,
  );
  const currentStepElapsed =
    elapsedOverride !== null ? Math.max(0, elapsedOverride - accountedFor) : null;

  return [...definition.steps]
    .sort((a, b) => a.stepId - b.stepId)
    .map((step) => {
      const done = completed.get(step.stepId);
      const baseline = baselines.get(step.stepId);
      const isCurrent = current?.currentStepId === step.stepId;

      let state: StepState;
      let actualSeconds: number | null = null;

      if (isCurrent) {
        state = 'running';
        actualSeconds = currentStepElapsed;
      } else if (done) {
        state = done.runStatus === 1 ? 'succeeded' : done.runStatus === 0 ? 'failed' : 'skipped';
        actualSeconds = done.runDurationSeconds;
      } else {
        // Not started, or branched past. Without a full execution trace these
        // are indistinguishable, so both read as "pending" rather than
        // asserting something the data does not support.
        state = 'pending';
      }

      return {
        stepId: step.stepId,
        name: step.name,
        subsystem: step.subsystem,
        state,
        actualSeconds,
        averageSeconds: baseline?.averageSeconds ?? null,
        lastSeconds: baseline?.lastSeconds ?? null,
        onSuccess: stepAction(step.onSuccessAction, step.onSuccessStepId),
        onFail: stepAction(step.onFailAction, step.onFailStepId),
        message: done?.message ?? null,
      };
    });
}

export function StepGraph({
  definition,
  stats,
  running,
}: {
  definition: JobDefinition | null;
  stats: JobStats | undefined;
  running: boolean;
}) {
  const startedAt = stats?.currentRun?.startedAt ?? null;
  const elapsed = useLiveElapsed(running ? startedAt : null, stats?.currentRun?.elapsedSeconds ?? null);
  const steps = buildStepViews(definition, stats, running ? elapsed : null);

  if (steps.length === 0) return null;

  return (
    <div className="step-graph">
      {running ? (
        <div className="step-graph-head">
          <span className="badge running">Running</span>
          <span className="mono">{formatDuration(elapsed)}</span>
          {stats?.duration.averageSeconds !== null && stats?.duration.averageSeconds !== undefined ? (
            <span className="faint">
              usually {formatDuration(Math.round(stats.duration.averageSeconds))}
            </span>
          ) : null}
        </div>
      ) : null}

      <ol className="step-flow">
        {steps.map((step, index) => (
          <li key={step.stepId} className={`step-node ${step.state}`}>
            {index > 0 ? <span className="step-connector" aria-hidden="true" /> : null}

            <div className="step-node-body">
              <div className="step-node-head">
                <span className={`dot ${dotClass(step.state)}`} aria-hidden="true" />
                <span className="step-node-id">{step.stepId}</span>
                <span className="step-node-name">{step.name}</span>
                <span className="faint">{step.subsystem}</span>
              </div>

              <div className="step-node-timing">
                <StepTiming step={step} />
              </div>

              <div className="step-node-flow faint">
                ✓ {step.onSuccess} · ✗ {step.onFail}
              </div>

              {step.message && step.state === 'failed' ? (
                <div className="step-node-message">{step.message}</div>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Duration for one step, against what it normally takes.
 *
 * Only says "slower than usual" once a step is meaningfully over: a step that
 * usually takes two seconds and took three is not news.
 */
function StepTiming({ step }: { step: StepView }) {
  if (step.state === 'pending') {
    return (
      <span className="faint">
        {step.averageSeconds === null
          ? 'not run before'
          : `usually ${formatDuration(Math.round(step.averageSeconds))}`}
      </span>
    );
  }

  const actual = step.actualSeconds;
  const average = step.averageSeconds;
  const over =
    actual !== null && average !== null && average > 0 && actual > average * 1.5 && actual - average >= 10;

  return (
    <>
      <span className="mono">{formatDuration(actual)}</span>
      {average !== null ? (
        <span className={over ? 'step-over' : 'faint'}>
          {' '}
          {over ? '▲' : ''} usually {formatDuration(Math.round(average))}
        </span>
      ) : null}
      {step.lastSeconds !== null && step.state === 'running' ? (
        <span className="faint"> · last time {formatDuration(step.lastSeconds)}</span>
      ) : null}
    </>
  );
}

function dotClass(state: StepState): string {
  switch (state) {
    case 'succeeded':
      return runStatusClass(1);
    case 'failed':
      return runStatusClass(0);
    case 'running':
      return runStatusClass(4);
    case 'skipped':
      return runStatusClass(3);
    default:
      return '';
  }
}

/**
 * A ticking elapsed counter between polls.
 *
 * The server's figure is authoritative and arrives every second or two; this
 * fills the gaps so the number moves smoothly rather than jumping. It resets to
 * the server's value on every refresh, so it cannot drift.
 */
function useLiveElapsed(startedAt: string | null, serverElapsed: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!startedAt) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  if (!startedAt) return serverElapsed;

  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) return serverElapsed;
  return Math.max(0, Math.round((now - started) / 1000));
}
