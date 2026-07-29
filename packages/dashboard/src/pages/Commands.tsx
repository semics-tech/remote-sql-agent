import { Link } from 'react-router-dom';
import { useState } from 'react';
import { useCommandApproval, useCommands, type CommandRow } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Panel, QueryState, Empty } from '../components.jsx';
import { formatDateTime, formatRelative } from '../format.js';

/**
 * §9.6 Commands and approvals.
 *
 * Every change to an on-premise Agent passes through here, including the ones
 * that failed. A command that was refused is as important to see as one that
 * succeeded — "why didn't my change apply?" is the question this screen exists
 * to answer.
 */

const STATE_LABEL: Record<CommandRow['state'], string> = {
  pending_approval: 'Waiting for approval',
  approved: 'Waiting for the worker',
  dispatched: 'Sent to the worker',
  succeeded: 'Applied',
  failed: 'Failed',
  expired: 'Expired',
  rejected: 'Rejected',
};

const STATE_CLASS: Record<CommandRow['state'], string> = {
  pending_approval: 'badge drift',
  approved: 'badge neutral',
  dispatched: 'badge running',
  succeeded: 'badge online',
  failed: 'badge failed',
  expired: 'badge neutral',
  rejected: 'badge neutral',
};

const TYPE_LABEL: Record<string, string> = {
  toggleJob: 'Enable/disable job',
  runJob: 'Start job',
  stopJob: 'Stop job',
  upsertJob: 'Save job',
  deleteJob: 'Delete job',
  upsertSchedule: 'Save schedule',
  deleteSchedule: 'Delete schedule',
  upsertOperator: 'Save operator',
  deleteOperator: 'Delete operator',
};

export function Commands() {
  const [filter, setFilter] = useState<CommandRow['state'] | 'all'>('all');
  const { data, isLoading, error } = useCommands(filter === 'all' ? undefined : filter);
  const { approve, reject } = useCommandApproval();
  const { can, user } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const commands = data?.commands ?? [];

  async function act(id: string, fn: () => Promise<void>): Promise<void> {
    setBusy(id);
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h2>Commands</h2>
        {data && data.pendingApproval > 0 ? (
          <span className="badge drift">{data.pendingApproval} waiting for approval</span>
        ) : null}
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as CommandRow['state'] | 'all')}
          aria-label="Filter by state"
        >
          <option value="all">All states</option>
          {(Object.keys(STATE_LABEL) as CommandRow['state'][]).map((s) => (
            <option key={s} value={s}>
              {STATE_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
      <p className="page-sub">
        Every change issued against an on-premise Agent, applied or not. SQL Agent runs the jobs —
        these are the instructions sent to it.
      </p>

      {actionError ? <div className="error">{actionError}</div> : null}

      <QueryState isLoading={isLoading} error={error}>
        <Panel title={`Commands (${commands.length})`}>
          {commands.length === 0 ? (
            <Empty title="No commands" hint="Changes made from the dashboard appear here." />
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Issued</th>
                    <th>Action</th>
                    <th>Target</th>
                    <th>State</th>
                    <th>Outcome</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {commands.map((c) => (
                    <tr key={c.id}>
                      <td className="nowrap mono">{formatDateTime(c.issuedAt)}</td>
                      <td className="nowrap">{TYPE_LABEL[c.type] ?? c.type}</td>
                      <td className="nowrap">
                        <span className="faint mono">
                          {c.hostName}\{c.instanceName}
                        </span>
                        {c.jobUuid ? (
                          <>
                            {' '}
                            <Link to={`/instances/${c.instanceId}/jobs/${c.jobUuid}`}>
                              {c.jobName ?? c.jobUuid.slice(0, 8)}
                            </Link>
                          </>
                        ) : null}
                      </td>
                      <td>
                        <span className={STATE_CLASS[c.state]}>{STATE_LABEL[c.state]}</span>
                        {c.state === 'pending_approval' && c.expiresAt ? (
                          <div className="faint" style={{ fontSize: 11 }}>
                            expires {formatRelative(c.expiresAt)}
                          </div>
                        ) : null}
                      </td>
                      <td className="muted" style={{ maxWidth: 380 }}>
                        {c.resultCode === 'Conflict' ? (
                          <>
                            <strong style={{ color: 'var(--drift)' }}>Conflict.</strong>{' '}
                            {c.resultDetail}
                          </>
                        ) : (
                          (c.resultDetail ?? (c.resultCode === 'Ok' ? '—' : ''))
                        )}
                      </td>
                      <td className="nowrap">
                        {c.state === 'pending_approval' && can('command.approve') ? (
                          <>
                            <button
                              className="action"
                              disabled={busy === c.id || c.issuedBy === user?.id}
                              title={
                                c.issuedBy === user?.id
                                  ? 'You issued this command. It needs a second person to approve it.'
                                  : 'Approve and send to the worker'
                              }
                              onClick={() => void act(c.id, () => approve(c.id))}
                              style={{ marginRight: 4 }}
                            >
                              Approve
                            </button>
                            <button
                              className="action"
                              disabled={busy === c.id}
                              onClick={() =>
                                void act(c.id, () => reject(c.id, 'Rejected from the dashboard'))
                              }
                            >
                              Reject
                            </button>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </QueryState>
    </div>
  );
}
