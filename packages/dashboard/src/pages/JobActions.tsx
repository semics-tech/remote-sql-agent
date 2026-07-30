import { useState } from 'react';
import { useInstanceCapabilities, useJobActions, type JobDetail } from '../api.js';
import { useAuth } from '../auth.jsx';

/**
 * The action bar on a job.
 *
 * Buttons are hidden when the *worker* cannot perform the action, not merely
 * when the user lacks permission: an Editor looking at a read-only worker
 * should see that nothing can be changed here, rather than a button that
 * always fails. Hover text explains which of the two is missing.
 */
export function JobActions({
  instanceId,
  job,
  pendingEnabled,
  onIssued,
  onStarting,
  onToggling,
}: {
  instanceId: string;
  job: JobDetail;
  /** The enabled state asked for and not yet confirmed, or null when settled. */
  pendingEnabled: boolean | null;
  onIssued: (message: string) => void;
  /** Fired the instant a start is accepted, so the page can show it running
   * before SQL Agent's activity poll catches up. */
  onStarting?: () => void;
  /** Likewise for enable/disable — the page owns the optimistic state because
   * the heading badge and the polling rate both depend on it. */
  onToggling?: (enabled: boolean) => void;
}) {
  const capabilities = useInstanceCapabilities(instanceId);
  const actions = useJobActions(instanceId, job.jobUuid);
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const workerCan = (capability: string): boolean =>
    capabilities.data?.workerCapabilities.includes(capability) ?? false;

  const running = job.activity?.state === 'executing';

  async function issue(
    label: string,
    fn: () => Promise<{ requiresApproval: boolean }>,
    { silentOnSuccess = false } = {},
  ): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await fn();
      if (result.requiresApproval) {
        onIssued(`${label} is waiting for a second person to approve it.`);
      } else if (!silentOnSuccess) {
        onIssued(`${label} sent to the worker.`);
      }
      // Otherwise say nothing: the state badge and the run timeline already
      // show what happened, and a banner repeating it is one more thing to
      // dismiss.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  if (capabilities.isLoading) return null;

  const nothingPossible =
    !workerCan('job.toggle') && !workerCan('job.run') && !workerCan('job.write');

  return (
    <>
      <div className="action-bar">
        {workerCan('job.toggle') && can('job.toggle') ? (
          <button
            className="action"
            // Disabled while the change is in flight rather than hidden: the
            // button is where the operator is looking, so it is where the
            // progress belongs.
            disabled={busy || pendingEnabled !== null}
            onClick={() =>
              void issue(
                job.enabled ? 'Disable job' : 'Enable job',
                async () => {
                  const next = !job.enabled;
                  const result = await actions.toggle(
                    next,
                    job.currentDefinitionHash ?? undefined,
                  );
                  // Only once accepted, and never when it is queued for
                  // approval — showing "Disabling…" for a change nobody has
                  // approved would be a lie the page never resolves.
                  if (!result.requiresApproval) onToggling?.(next);
                  return result;
                },
                { silentOnSuccess: true },
              )
            }
          >
            {pendingEnabled !== null
              ? pendingEnabled
                ? 'Enabling…'
                : 'Disabling…'
              : job.enabled
                ? 'Disable'
                : 'Enable'}
          </button>
        ) : null}

        {workerCan('job.run') && can('job.run') ? (
          running ? (
            <button
              className="action"
              disabled={busy}
              onClick={() => void issue('Stop job', actions.stop, { silentOnSuccess: true })}
            >
              Stop
            </button>
          ) : (
            <button
              className="action"
              disabled={busy}
              onClick={() =>
                void issue(
                  'Start job',
                  async () => {
                    const result = await actions.run();
                    // Only after the command is accepted. Flipping the UI to
                    // "running" on click would show a state that a refused
                    // command never reaches.
                    if (!result.requiresApproval) onStarting?.();
                    return result;
                  },
                  { silentOnSuccess: true },
                )
              }
            >
              Start job
            </button>
          )
        ) : null}

        {nothingPossible ? (
          <span className="faint">
            Worker {capabilities.data?.hostName} is observe-only, so nothing here can be changed.
            Grant it capabilities in Administration and raise its local maxCapability.
          </span>
        ) : null}
      </div>

      {error ? <div className="error">{error}</div> : null}
    </>
  );
}
