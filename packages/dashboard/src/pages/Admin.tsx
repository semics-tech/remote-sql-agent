import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { CAPABILITIES, MAX_CAPABILITY_TIERS, effectiveCapabilities } from '@remote-sql-agent/protocol/browser';
import type { MaxCapabilityTier } from '@remote-sql-agent/protocol/browser';
import { useAudit, useWorkerAdmin, useWorkers, type WorkerRow } from '../api.js';
import { Panel, QueryState, Empty } from '../components.jsx';
import { formatDateTime, formatRelative } from '../format.js';
import { InstanceConfigPanel } from './InstanceConfig.jsx';
import { Notifications } from './Notifications.jsx';
import { EnvironmentGrants } from './EnvironmentGrants.jsx';

type Tab = 'workers' | 'access' | 'notifications' | 'audit';

/** §9.7 Admin — workers and capabilities, notifications, audit log. */
export function Admin() {
  const [tab, setTab] = useState<Tab>('workers');

  return (
    <div className="page">
      <div className="page-head">
        <h2>Administration</h2>
      </div>

      <div className="tabs">
        <button className={tab === 'workers' ? 'active' : ''} onClick={() => setTab('workers')}>
          Workers
        </button>
        <button className={tab === 'access' ? 'active' : ''} onClick={() => setTab('access')}>
          Access
        </button>
        <button
          className={tab === 'notifications' ? 'active' : ''}
          onClick={() => setTab('notifications')}
        >
          Notifications
        </button>
        <button className={tab === 'audit' ? 'active' : ''} onClick={() => setTab('audit')}>
          Audit log
        </button>
      </div>

      {tab === 'workers' ? (
        <Workers />
      ) : tab === 'access' ? (
        <EnvironmentGrants />
      ) : tab === 'notifications' ? (
        <Notifications />
      ) : (
        <Audit />
      )}
    </div>
  );
}

function Workers() {
  const { data, isLoading, error } = useWorkers();
  const [expanded, setExpanded] = useState<string | null>(null);
  const workers = data?.workers ?? [];

  return (
    <QueryState isLoading={isLoading} error={error}>
      <p className="page-sub">
        A worker reports a ceiling from its own <span className="mono">worker.yaml</span> that this
        control plane cannot raise. What a worker can actually do is always the smaller of what is
        granted here and what it allows itself — so a worker pinned to read-only stays read-only
        even if this control plane is fully compromised.
      </p>

      <Panel
        title={`Workers (${workers.length})`}
        actions={
          <Link to="/estate/add-worker" className="action">
            Add a worker
          </Link>
        }
      >
        {workers.length === 0 ? (
          <Empty
            title="No workers enrolled"
            hint="Add one to start mirroring a SQL Server host."
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Host</th>
                  <th>Status</th>
                  <th className="right">Instances</th>
                  <th>Version</th>
                  <th>Can actually do</th>
                  <th>Local ceiling</th>
                  <th>Last seen</th>
                  <th style={{ width: 100 }} />
                </tr>
              </thead>
              <tbody>
                {workers.map((w) => (
                  // Fragment with an explicit key: a worker renders two sibling
                  // rows, and React needs the key on the wrapper rather than
                  // on each row.
                  <Fragment key={w.id}>
                    <tr>
                      <td className="nowrap mono">{w.hostName}</td>
                      <td>
                        <span className={`badge ${w.online ? 'online' : 'offline'}`}>
                          {w.online ? 'Connected' : 'Offline'}
                        </span>
                      </td>
                      <td className="right num">{w.instanceCount}</td>
                      <td className="nowrap muted mono">{w.version ?? '—'}</td>
                      <td className="muted mono">{describeEffective(w)}</td>
                      <td>
                        <span className="badge neutral">{w.maxCapabilityReported ?? 'unknown'}</span>
                      </td>
                      <td className="nowrap muted">{formatRelative(w.lastSeenAt)}</td>
                      <td className="nowrap">
                        <button
                          className="action"
                          onClick={() => setExpanded(expanded === w.id ? null : w.id)}
                        >
                          {expanded === w.id ? 'Close' : 'Manage'}
                        </button>
                      </td>
                    </tr>
                    {expanded === w.id ? (
                      <tr>
                        <td colSpan={8} style={{ padding: 0, background: 'var(--bg-raised)' }}>
                          <WorkerDetail worker={w} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </QueryState>
  );
}

/**
 * What this worker can do in practice.
 *
 * Computed here the same way the worker computes it, because showing the raw
 * grant tells an administrator a command will work when the worker is going to
 * refuse it.
 */
function describeEffective(worker: WorkerRow): string {
  const ceiling = (worker.maxCapabilityReported ?? 'readOnly') as MaxCapabilityTier;
  const tier = ceiling in MAX_CAPABILITY_TIERS ? ceiling : 'readOnly';
  const effective = effectiveCapabilities(worker.capabilities, tier);
  return effective.length <= 1 ? 'observe only' : effective.filter((c) => c !== 'observe').join(', ');
}

function WorkerDetail({ worker }: { worker: WorkerRow }) {
  return (
    <div style={{ padding: 11 }}>
      <CapabilityEditor worker={worker} />
      <div className="editor-label" style={{ marginTop: 14 }}>
        Instances this worker monitors
      </div>
      <InstanceConfigPanel
        workerId={worker.id}
        hostName={worker.hostName}
        liveInstanceCount={worker.instanceCount}
      />
    </div>
  );
}

/**
 * Granting and revoking capabilities.
 *
 * Shows all three layers side by side — what is granted, what the host allows,
 * and what results — because the interesting case is when they disagree and an
 * administrator needs to see *which* of the two is blocking them.
 */
function CapabilityEditor({ worker }: { worker: WorkerRow }) {
  const admin = useWorkerAdmin();
  const [granted, setGranted] = useState<string[]>(worker.capabilities);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ceilingName = (worker.maxCapabilityReported ?? 'readOnly') as MaxCapabilityTier;
  const ceiling = ceilingName in MAX_CAPABILITY_TIERS ? ceilingName : 'readOnly';
  const allowedByHost = new Set<string>(MAX_CAPABILITY_TIERS[ceiling]);
  const effective = effectiveCapabilities(granted, ceiling);

  const dirty = JSON.stringify([...granted].sort()) !== JSON.stringify([...worker.capabilities].sort());

  // `granted` only takes its initial value from `worker.capabilities` — a
  // prop that a 5s poll refreshes underneath this component. Without this,
  // an operator who has not touched anything watches checkboxes that stopped
  // reflecting the live worker the moment the panel opened, and an operator
  // mid-edit would have that edit clobbered by every poll if this ran
  // unconditionally — hence only resyncing while nothing is unsaved.
  // `worker.capabilities` is the only thing that should retrigger this —
  // `dirty` is read to decide whether to skip, not something a change in it
  // alone should cause a resync for.
  useEffect(() => {
    if (dirty) return;
    setGranted(worker.capabilities);
  }, [worker.capabilities]);

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await admin.setCapabilities(worker.id, granted);
      setNote(result.note);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change capabilities.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error ? <div className="error">{error}</div> : null}
      {note ? <div className="notice">{note}</div> : null}

      <div className="editor-label">What {worker.hostName} may be asked to do</div>
      <div className="capability-grid">
        {CAPABILITIES.filter((c) => c !== 'observe').map((capability) => {
          const blockedByHost = !allowedByHost.has(capability);
          return (
            <label
              key={capability}
              className={`inline-check ${blockedByHost ? 'blocked' : ''}`}
              title={
                blockedByHost
                  ? `Blocked on the host: worker.yaml sets maxCapability to "${ceiling}". Granting this here has no effect until that is raised on the SQL Server itself.`
                  : undefined
              }
            >
              <input
                type="checkbox"
                checked={granted.includes(capability)}
                onChange={() =>
                  setGranted(
                    granted.includes(capability)
                      ? granted.filter((c) => c !== capability)
                      : [...granted, capability],
                  )
                }
              />
              <span className="mono">{capability}</span>
              {blockedByHost ? <span className="faint"> — blocked by the host</span> : null}
            </label>
          );
        })}
      </div>

      <p className="faint" style={{ margin: '8px 0 0' }}>
        Effective: <span className="mono">{effective.join(', ')}</span>. Granting something the
        host does not allow is harmless — the worker recomputes this itself on every session and
        ignores anything above its own ceiling.
      </p>

      {dirty ? (
        <div className="action-bar">
          <button className="action primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save capabilities'}
          </button>
          <button className="action" disabled={busy} onClick={() => setGranted(worker.capabilities)}>
            Discard
          </button>
        </div>
      ) : null}
    </>
  );
}

function Audit() {
  const { data, isLoading, error } = useAudit();
  const entries = data?.entries ?? [];

  return (
    <QueryState isLoading={isLoading} error={error}>
      <Panel title={`Audit log (${entries.length} most recent)`}>
        {entries.length === 0 ? (
          <Empty title="Nothing audited yet" />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Target</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td className="nowrap mono">{formatDateTime(e.at)}</td>
                    <td className="nowrap">
                      <span className="badge neutral">{e.actorType}</span>{' '}
                      <span className="mono">{e.actor}</span>
                    </td>
                    <td className="nowrap mono">{e.action}</td>
                    <td className="nowrap faint mono">{e.target?.slice(0, 8) ?? '—'}</td>
                    <td className="mono faint" style={{ fontSize: 11.5 }}>
                      {e.detail ? JSON.stringify(e.detail).slice(0, 140) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </QueryState>
  );
}
