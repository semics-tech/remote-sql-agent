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
  onIssued,
}: {
  instanceId: string;
  job: JobDetail;
  onIssued: (message: string) => void;
}) {
  const capabilities = useInstanceCapabilities(instanceId);
  const actions = useJobActions(instanceId, job.jobUuid);
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const workerCan = (capability: string): boolean =>
    capabilities.data?.workerCapabilities.includes(capability) ?? false;

  const running = job.activity?.state === 'executing';

  async function issue(label: string, fn: () => Promise<{ requiresApproval: boolean }>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await fn();
      onIssued(
        result.requiresApproval
          ? `${label} is waiting for a second person to approve it.`
          : `${label} sent to the worker.`,
      );
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
            disabled={busy}
            onClick={() =>
              void issue(job.enabled ? 'Disable job' : 'Enable job', () =>
                actions.toggle(!job.enabled, job.currentDefinitionHash ?? undefined),
              )
            }
          >
            {job.enabled ? 'Disable' : 'Enable'}
          </button>
        ) : null}

        {workerCan('job.run') && can('job.run') ? (
          running ? (
            <button className="action" disabled={busy} onClick={() => void issue('Stop job', actions.stop)}>
              Stop
            </button>
          ) : (
            <button
              className="action"
              disabled={busy}
              onClick={() => void issue('Start job', () => actions.run())}
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
