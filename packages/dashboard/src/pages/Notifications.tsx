import { useState } from 'react';
import {
  useEstate,
  useNotificationAdmin,
  useNotificationChannels,
  useNotificationDeliveries,
  useNotificationRules,
  type ChannelKind,
  type NotificationChannel,
  type NotificationEventKind,
  type NotificationRule,
} from '../api.js';
import { Panel, QueryState, Empty } from '../components.jsx';
import { formatDateTime, formatRelative } from '../format.js';

/**
 * Where alerts go, and for what.
 *
 * Two objects rather than one: a channel is *where* (a Slack webhook, an SMTP
 * relay), a rule is *what and for which part of the estate*. Collapsing them
 * would mean re-entering a webhook URL for every rule that uses it, and
 * re-entering secrets is how they end up in a wiki.
 */

const EVENTS: Array<{ key: NotificationEventKind; label: string; detail: string }> = [
  { key: 'job.failed', label: 'Job failed', detail: 'A run finished with a failure' },
  {
    key: 'job.long_running',
    label: 'Job running long',
    detail: "Well past that job's own average for a successful run",
  },
  {
    key: 'job.recovered',
    label: 'Job recovered',
    detail: 'First success after one or more failures',
  },
  {
    key: 'worker.offline',
    label: 'Worker offline',
    detail: 'A worker stopped reporting. Its jobs keep running regardless.',
  },
  {
    key: 'command.failed',
    label: 'Change failed',
    detail: 'A change from this dashboard was refused or failed to apply',
  },
  {
    key: 'job.succeeded',
    label: 'Job succeeded',
    detail: 'Every successful run. Noisy — usually you want "recovered" instead.',
  },
];

const CHANNEL_KINDS: Array<{ key: ChannelKind; label: string; secretLabel: string; hint: string }> = [
  {
    key: 'slack',
    label: 'Slack',
    secretLabel: 'Incoming webhook URL',
    hint: 'Slack → your app → Incoming Webhooks. The URL is the credential; anyone holding it can post to that channel.',
  },
  {
    key: 'teams',
    label: 'Microsoft Teams',
    secretLabel: 'Incoming webhook URL',
    hint: 'Teams channel → Connectors → Incoming Webhook.',
  },
  {
    key: 'email',
    label: 'Email',
    secretLabel: 'SMTP password',
    hint: 'An internal relay usually needs no credentials at all — leave the username blank.',
  },
  {
    key: 'webhook',
    label: 'Webhook',
    secretLabel: 'URL to POST to',
    hint: 'Receives the event as JSON. For piping into something else.',
  },
];

type Tab = 'rules' | 'channels' | 'history';

export function Notifications() {
  const [tab, setTab] = useState<Tab>('rules');

  return (
    <>
      <div className="tabs inline">
        <button className={tab === 'rules' ? 'active' : ''} onClick={() => setTab('rules')}>
          Rules
        </button>
        <button className={tab === 'channels' ? 'active' : ''} onClick={() => setTab('channels')}>
          Channels
        </button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          Recent alerts
        </button>
      </div>

      {tab === 'rules' ? <Rules /> : tab === 'channels' ? <Channels /> : <History />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

function Channels() {
  const { data, isLoading, error } = useNotificationChannels();
  const admin = useNotificationAdmin();
  const [editing, setEditing] = useState<NotificationChannel | 'new' | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const channels = data?.channels ?? [];

  async function test(channel: NotificationChannel): Promise<void> {
    setTesting(channel.id);
    setResult(null);
    try {
      await admin.testChannel(channel.id);
      setResult({ ok: true, message: `Test message sent to ${channel.name}.` });
    } catch (err) {
      setResult({
        ok: false,
        message: err instanceof Error ? err.message : 'The test message failed.',
      });
    } finally {
      setTesting(null);
    }
  }

  return (
    <QueryState isLoading={isLoading} error={error}>
      {result ? (
        <div className={result.ok ? 'notice' : 'error'}>{result.message}</div>
      ) : null}

      <Panel
        title={`Channels (${channels.length})`}
        actions={
          <button className="action" onClick={() => setEditing('new')}>
            Add a channel
          </button>
        }
      >
        {channels.length === 0 ? (
          <Empty
            title="No channels yet"
            hint="Add somewhere for alerts to go — a Slack or Teams webhook, or an SMTP relay."
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Target</th>
                  <th>Last delivery</th>
                  <th style={{ width: 190 }} />
                </tr>
              </thead>
              <tbody>
                {channels.map((c) => (
                  <tr key={c.id}>
                    <td className="nowrap">
                      {c.name}
                      {!c.enabled ? <span className="badge neutral"> disabled</span> : null}
                    </td>
                    <td className="muted">{CHANNEL_KINDS.find((k) => k.key === c.kind)?.label}</td>
                    <td className="muted mono">
                      {/* Enough to tell two webhooks apart, useless to anyone
                          who reads it over a shoulder. */}
                      {c.kind === 'email'
                        ? String((c.config as { to?: string[] }).to?.join(', ') ?? '—')
                        : (c.secretHint ?? '—')}
                    </td>
                    <td className="nowrap">
                      {c.lastError ? (
                        <span className="badge failed" title={c.lastError}>
                          failing
                        </span>
                      ) : c.lastDeliveredAt ? (
                        <span className="muted">{formatRelative(c.lastDeliveredAt)}</span>
                      ) : (
                        <span className="faint">never used</span>
                      )}
                    </td>
                    <td className="nowrap">
                      <button
                        className="action"
                        disabled={testing === c.id}
                        onClick={() => void test(c)}
                      >
                        {testing === c.id ? 'Sending…' : 'Send test'}
                      </button>
                      <button className="action" onClick={() => setEditing(c)}>
                        Edit
                      </button>
                      <button
                        className="action danger"
                        onClick={() => void admin.removeChannel(c.id)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {editing ? (
        <ChannelForm
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </QueryState>
  );
}

function ChannelForm({
  existing,
  onClose,
}: {
  existing: NotificationChannel | null;
  onClose: () => void;
}) {
  const admin = useNotificationAdmin();
  const [name, setName] = useState(existing?.name ?? '');
  const [kind, setKind] = useState<ChannelKind>(existing?.kind ?? 'slack');
  const [secret, setSecret] = useState('');
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);

  const emailConfig = (existing?.config ?? {}) as {
    host?: string;
    port?: number;
    secure?: boolean;
    username?: string;
    from?: string;
    to?: string[];
  };
  const [host, setHost] = useState(emailConfig.host ?? '');
  const [port, setPort] = useState(String(emailConfig.port ?? 587));
  const [secure, setSecure] = useState(emailConfig.secure ?? false);
  const [username, setUsername] = useState(emailConfig.username ?? '');
  const [from, setFrom] = useState(emailConfig.from ?? '');
  const [to, setTo] = useState((emailConfig.to ?? []).join(', '));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const meta = CHANNEL_KINDS.find((k) => k.key === kind)!;

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await admin.saveChannel({
        id: existing?.id,
        name: name.trim(),
        kind,
        enabled,
        secret: secret || undefined,
        config:
          kind === 'email'
            ? {
                host: host.trim(),
                port: Number(port) || 587,
                secure,
                username: username.trim() || undefined,
                from: from.trim(),
                to: to
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              }
            : {},
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that channel.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" style={{ borderColor: 'var(--accent)' }}>
      <div className="panel-head">{existing ? `Edit ${existing.name}` : 'Add a channel'}</div>
      {error ? <div className="error">{error}</div> : null}

      <div className="editor-grid">
        <label htmlFor="ch-name">Name</label>
        <input
          id="ch-name"
          type="text"
          value={name}
          placeholder="DBA on-call"
          onChange={(e) => setName(e.target.value)}
        />

        <label htmlFor="ch-kind">Type</label>
        <div>
          <select
            id="ch-kind"
            value={kind}
            disabled={Boolean(existing)}
            onChange={(e) => setKind(e.target.value as ChannelKind)}
          >
            {CHANNEL_KINDS.map((k) => (
              <option key={k.key} value={k.key}>
                {k.label}
              </option>
            ))}
          </select>
          <div className="faint">{meta.hint}</div>
        </div>

        {kind === 'email' ? (
          <>
            <label htmlFor="ch-host">SMTP host</label>
            <input id="ch-host" type="text" value={host} onChange={(e) => setHost(e.target.value)} />

            <label htmlFor="ch-port">Port</label>
            <div>
              <input
                id="ch-port"
                type="text"
                inputMode="numeric"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                style={{ width: 90 }}
              />
              <label className="inline-check" style={{ marginLeft: 16 }}>
                <input
                  type="checkbox"
                  checked={secure}
                  onChange={(e) => setSecure(e.target.checked)}
                />
                Implicit TLS
              </label>
              <div className="faint">
                Port 587 negotiates STARTTLS; port 465 needs implicit TLS ticked.
              </div>
            </div>

            <label htmlFor="ch-from">From</label>
            <input
              id="ch-from"
              type="text"
              value={from}
              placeholder="sqlagent@corp.example.com"
              onChange={(e) => setFrom(e.target.value)}
            />

            <label htmlFor="ch-to">To</label>
            <input
              id="ch-to"
              type="text"
              value={to}
              placeholder="dba@corp.example.com, oncall@corp.example.com"
              onChange={(e) => setTo(e.target.value)}
            />

            <label htmlFor="ch-user">SMTP username</label>
            <div>
              <input
                id="ch-user"
                type="text"
                value={username}
                autoComplete="off"
                onChange={(e) => setUsername(e.target.value)}
              />
              <div className="faint">Leave blank for an unauthenticated internal relay.</div>
            </div>
          </>
        ) : null}

        <label htmlFor="ch-secret">{meta.secretLabel}</label>
        <div>
          <input
            id="ch-secret"
            type="password"
            value={secret}
            autoComplete="new-password"
            placeholder={existing?.hasSecret ? 'unchanged' : ''}
            onChange={(e) => setSecret(e.target.value)}
          />
          <div className="faint">
            {existing?.hasSecret
              ? 'Stored. Leave blank to keep it; it is never shown again.'
              : 'Stored on the control plane and never returned by the API.'}
          </div>
        </div>

        <label htmlFor="ch-enabled">Enabled</label>
        <div>
          <input
            id="ch-enabled"
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
        </div>
      </div>

      <div className="action-bar">
        <button
          className="action primary"
          disabled={busy || name.trim().length === 0}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Save channel'}
        </button>
        <button className="action" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <span className="faint">Send a test afterwards — that is when a typo shows up.</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function Rules() {
  const rules = useNotificationRules();
  const channels = useNotificationChannels();
  const admin = useNotificationAdmin();
  const [editing, setEditing] = useState<NotificationRule | 'new' | null>(null);

  const list = rules.data?.rules ?? [];
  const channelName = (id: string): string =>
    channels.data?.channels.find((c) => c.id === id)?.name ?? 'removed channel';

  return (
    <QueryState isLoading={rules.isLoading} error={rules.error}>
      <Panel
        title={`Rules (${list.length})`}
        actions={
          <button
            className="action"
            disabled={(channels.data?.channels.length ?? 0) === 0}
            onClick={() => setEditing('new')}
          >
            Add a rule
          </button>
        }
      >
        {(channels.data?.channels.length ?? 0) === 0 ? (
          <Empty
            title="Add a channel first"
            hint="A rule needs somewhere to send to. Set up a channel, then come back."
          />
        ) : list.length === 0 ? (
          <Empty
            title="No rules yet"
            hint="Nothing is being sent anywhere. A good first rule: job failures, everywhere, to your on-call channel."
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Events</th>
                  <th>Scope</th>
                  <th>Sends to</th>
                  <th className="right">Throttle</th>
                  <th style={{ width: 140 }} />
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap">
                      {r.name}
                      {!r.enabled ? <span className="badge neutral"> paused</span> : null}
                    </td>
                    <td className="muted">
                      {r.events.map((e) => EVENTS.find((x) => x.key === e)?.label ?? e).join(', ')}
                    </td>
                    <td className="muted">
                      {r.instanceIds.length === 0
                        ? 'every instance'
                        : `${r.instanceIds.length} instance(s)`}
                      {r.jobNameContains ? (
                        <span className="mono"> · name contains “{r.jobNameContains}”</span>
                      ) : null}
                    </td>
                    <td className="muted">{r.channelIds.map(channelName).join(', ')}</td>
                    <td className="right nowrap muted">
                      {r.throttleMinutes === 0 ? 'none' : `${r.throttleMinutes} min`}
                    </td>
                    <td className="nowrap">
                      <button className="action" onClick={() => setEditing(r)}>
                        Edit
                      </button>
                      <button className="action danger" onClick={() => void admin.removeRule(r.id)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {editing ? (
        <RuleForm existing={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
    </QueryState>
  );
}

function RuleForm({
  existing,
  onClose,
}: {
  existing: NotificationRule | null;
  onClose: () => void;
}) {
  const admin = useNotificationAdmin();
  const channels = useNotificationChannels();
  const estate = useEstate();

  const [name, setName] = useState(existing?.name ?? '');
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [events, setEvents] = useState<NotificationEventKind[]>(
    existing?.events ?? ['job.failed'],
  );
  const [instanceIds, setInstanceIds] = useState<string[]>(existing?.instanceIds ?? []);
  const [jobNameContains, setJobName] = useState(existing?.jobNameContains ?? '');
  const [channelIds, setChannelIds] = useState<string[]>(existing?.channelIds ?? []);
  const [throttleMinutes, setThrottle] = useState(String(existing?.throttleMinutes ?? 60));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((x) => x !== value) : [...list, value];

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await admin.saveRule({
        id: existing?.id,
        name: name.trim(),
        enabled,
        events,
        instanceIds,
        jobNameContains: jobNameContains.trim() || null,
        channelIds,
        throttleMinutes: Number(throttleMinutes) || 0,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that rule.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" style={{ borderColor: 'var(--accent)' }}>
      <div className="panel-head">{existing ? `Edit ${existing.name}` : 'Add a rule'}</div>
      {error ? <div className="error">{error}</div> : null}

      <div className="editor-grid">
        <label htmlFor="rule-name">Name</label>
        <input
          id="rule-name"
          type="text"
          value={name}
          placeholder="Production failures"
          onChange={(e) => setName(e.target.value)}
        />

        <label>Send on</label>
        <div className="check-list">
          {EVENTS.map((e) => (
            <label key={e.key} className="inline-check">
              <input
                type="checkbox"
                checked={events.includes(e.key)}
                onChange={() => setEvents(toggle(events, e.key))}
              />
              <span>
                {e.label}
                <span className="faint"> — {e.detail}</span>
              </span>
            </label>
          ))}
        </div>

        <label>Instances</label>
        <div className="check-list">
          <label className="inline-check">
            <input
              type="checkbox"
              checked={instanceIds.length === 0}
              onChange={() => setInstanceIds([])}
            />
            <span>
              Every instance
              <span className="faint"> — including ones enrolled later</span>
            </span>
          </label>
          {(estate.data?.instances ?? []).map((i) => (
            <label key={i.instanceId} className="inline-check">
              <input
                type="checkbox"
                checked={instanceIds.includes(i.instanceId)}
                onChange={() => setInstanceIds(toggle(instanceIds, i.instanceId))}
              />
              <span className="mono">
                {i.hostName}\{i.instanceName}
              </span>
            </label>
          ))}
        </div>

        <label htmlFor="rule-jobname">Only jobs named like</label>
        <div>
          <input
            id="rule-jobname"
            type="text"
            value={jobNameContains}
            placeholder="backup"
            onChange={(e) => setJobName(e.target.value)}
          />
          <div className="faint">Case-insensitive substring. Leave blank for every job.</div>
        </div>

        <label>Send to</label>
        <div className="check-list">
          {(channels.data?.channels ?? []).map((c) => (
            <label key={c.id} className="inline-check">
              <input
                type="checkbox"
                checked={channelIds.includes(c.id)}
                onChange={() => setChannelIds(toggle(channelIds, c.id))}
              />
              <span>
                {c.name} <span className="faint">({c.kind})</span>
              </span>
            </label>
          ))}
        </div>

        <label htmlFor="rule-throttle">Throttle</label>
        <div>
          <input
            id="rule-throttle"
            type="text"
            inputMode="numeric"
            value={throttleMinutes}
            onChange={(e) => setThrottle(e.target.value)}
            style={{ width: 90 }}
          />{' '}
          minutes
          <div className="faint">
            One alert per job per window. A job failing every five minutes should page once, not
            288 times a day. Zero sends every one.
          </div>
        </div>

        <label htmlFor="rule-enabled">Enabled</label>
        <div>
          <input
            id="rule-enabled"
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
        </div>
      </div>

      <div className="action-bar">
        <button
          className="action primary"
          disabled={busy || name.trim().length === 0 || events.length === 0 || channelIds.length === 0}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Save rule'}
        </button>
        <button className="action" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delivery history
// ---------------------------------------------------------------------------

/**
 * What was actually sent — including what was throttled.
 *
 * Showing suppressed rows is the point. Someone who sees nothing arriving needs
 * to tell "the throttle is working" from "the pipeline is broken", and only the
 * record can tell them which.
 */
function History() {
  const { data, isLoading, error } = useNotificationDeliveries();
  const deliveries = data?.deliveries ?? [];

  return (
    <QueryState isLoading={isLoading} error={error}>
      <Panel title={`Recent alerts (${deliveries.length})`}>
        {deliveries.length === 0 ? (
          <Empty
            title="Nothing sent yet"
            hint="Alerts appear here as they are raised, including any that were throttled."
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Event</th>
                  <th>Job</th>
                  <th>Channel</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id}>
                    <td className="nowrap mono">{formatDateTime(d.occurredAt)}</td>
                    <td className="nowrap muted">
                      {EVENTS.find((e) => e.key === d.eventKind)?.label ?? d.eventKind}
                    </td>
                    <td className="nowrap">
                      {String(d.eventPayload.jobName ?? d.eventPayload.hostName ?? '—')}
                    </td>
                    <td className="nowrap muted">{d.channelName}</td>
                    <td>
                      {d.state === 'sent' ? (
                        <span className="badge online">sent</span>
                      ) : d.state === 'suppressed' ? (
                        <span className="badge neutral" title={d.lastError ?? ''}>
                          throttled
                        </span>
                      ) : d.state === 'failed' ? (
                        <span className="badge failed" title={d.lastError ?? ''}>
                          failed after {d.attempts}
                        </span>
                      ) : (
                        <span className="badge neutral" title={d.lastError ?? ''}>
                          queued
                        </span>
                      )}
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
