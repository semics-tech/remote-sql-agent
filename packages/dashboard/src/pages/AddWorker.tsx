import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useWorkerAdmin,
  usePendingWorkers,
  type EnrolmentTokenResult,
  type PendingWorker,
} from '../api.js';
import { Panel, Empty, QueryState } from '../components.jsx';
import { formatDateTime, formatRelative } from '../format.js';
import { InstanceConfigPanel } from './InstanceConfig.jsx';

/**
 * Adding a SQL Server host to the estate.
 *
 * Three steps, in the order they actually happen: generate a token, run one
 * command on the host, then say which instances to monitor. Nobody edits YAML
 * on the box, which is the difference between onboarding fifty servers and
 * onboarding five.
 *
 * SQL credentials are asked for in step three, not in the install command — and
 * they are encrypted in this browser before they leave it. See
 * InstanceConfig.tsx for that, and docs/security.md for why.
 */

const CAPABILITY_PRESETS = [
  {
    key: 'readOnly',
    label: 'Read only',
    detail: 'Mirror jobs, history and activity. Nothing can be changed from here.',
    capabilities: [] as string[],
  },
  {
    key: 'operate',
    label: 'Operate',
    detail: 'Also enable, disable, start and stop jobs.',
    capabilities: ['job.toggle', 'job.run'],
  },
  {
    key: 'full',
    label: 'Full',
    detail: 'Also edit job definitions and schedules.',
    capabilities: ['job.toggle', 'job.run', 'schedule.write', 'job.write', 'operator.write'],
  },
];

export function AddWorker() {
  const [hostName, setHostName] = useState('');
  const [preset, setPreset] = useState('readOnly');
  const [issued, setIssued] = useState<EnrolmentTokenResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const admin = useWorkerAdmin();
  const pending = usePendingWorkers();

  async function generate(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const chosen = CAPABILITY_PRESETS.find((p) => p.key === preset)!;
      setIssued(
        await admin.createEnrolmentToken({
          hostName: hostName.trim(),
          credentialMode: 'token',
          capabilities: chosen.capabilities,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create an enrolment token.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h2>Add a worker</h2>
      </div>
      <p className="page-sub">
        <Link to="/estate">← back to the estate</Link>
        {' · '}A worker runs alongside SQL Server and connects <strong>outbound only</strong>. It
        opens no port, so no inbound firewall rule is needed on the SQL host.
      </p>

      {error ? <div className="error">{error}</div> : null}

      <Panel title="1. Name the host">
        <div className="editor-grid">
          <label htmlFor="host-name">Host name</label>
          <input
            id="host-name"
            type="text"
            value={hostName}
            placeholder="sqlprod01"
            onChange={(e) => setHostName(e.target.value)}
          />

          <label htmlFor="preset">What it may do</label>
          <div>
            <select id="preset" value={preset} onChange={(e) => setPreset(e.target.value)}>
              {CAPABILITY_PRESETS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
            <div className="faint" style={{ marginTop: 4 }}>
              {CAPABILITY_PRESETS.find((p) => p.key === preset)?.detail}{' '}
              The worker also has its own local ceiling in <span className="mono">worker.yaml</span>,
              which this cannot raise — the effective permission is the lower of the two.
            </div>
          </div>
        </div>

        <div className="action-bar">
          <button
            className="action primary"
            disabled={busy || hostName.trim().length === 0}
            onClick={() => void generate()}
          >
            {busy ? 'Generating…' : 'Generate install command'}
          </button>
          <span className="faint">
            The token is single use, expires within the hour, and only works for this host name.
          </span>
        </div>
      </Panel>

      {issued ? (
        <InstallCommands issued={issued} />
      ) : (
        // The step stays in place before a token exists. A numbered sequence
        // that jumps from 1 to 3 reads as something failing to render.
        <Panel title="2. Run it on the SQL Server host">
          <div className="empty">
            <strong>Generate the install command first</strong>
            <span>
              You will get a one-liner for Windows or Linux, carrying a single-use token bound to
              that host.
            </span>
          </div>
        </Panel>
      )}

      <QueryState isLoading={pending.isLoading} error={pending.error}>
        <Panel title="3. Waiting to be told what to monitor">
          {(pending.data?.workers.length ?? 0) === 0 ? (
            <Empty
              title="No workers waiting"
              hint="A worker appears here within a few seconds of running the install command."
            />
          ) : (
            <div style={{ padding: '0 0 4px' }}>
              {pending.data!.workers.map((worker) => (
                <PendingWorkerRow key={worker.workerId} worker={worker} />
              ))}
            </div>
          )}
        </Panel>
      </QueryState>
    </div>
  );
}

function InstallCommands({ issued }: { issued: EnrolmentTokenResult }) {
  const [platform, setPlatform] = useState<'windows' | 'linux' | 'manual'>('windows');

  return (
    <Panel title="2. Run this on the SQL Server host">
      <div className="tabs inline">
        <button
          className={platform === 'windows' ? 'active' : ''}
          onClick={() => setPlatform('windows')}
        >
          Windows
        </button>
        <button className={platform === 'linux' ? 'active' : ''} onClick={() => setPlatform('linux')}>
          Linux
        </button>
        <button
          className={platform === 'manual' ? 'active' : ''}
          onClick={() => setPlatform('manual')}
        >
          Already installed
        </button>
      </div>

      <div style={{ padding: 11 }}>
        <p className="muted" style={{ marginTop: 0 }}>
          {platform === 'windows'
            ? 'From an elevated PowerShell session on the SQL Server host:'
            : platform === 'linux'
              ? 'From a shell on the SQL Server host, as root:'
              : 'If the worker binary is already on the host, enrol it directly:'}
        </p>

        <CopyBlock text={issued.install[platform]} />

        <p className="faint">
          Expires {formatDateTime(issued.expiresAt)} ({formatRelative(issued.expiresAt)}). The token
          is shown once — it is not stored anywhere it can be read again. If you lose it, generate
          another.
        </p>

        <p className="muted">
          The installer asks for no SQL credentials. The worker connects, reports in, and waits;
          you tell it which instances to monitor below.
        </p>
      </div>
    </Panel>
  );
}

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="copy-block">
      <pre className="code">{text}</pre>
      <button
        className="action"
        onClick={() => {
          void navigator.clipboard
            .writeText(text)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
            // Clipboard access needs a secure context; select-and-copy still works.
            .catch(() => undefined);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function PendingWorkerRow({ worker }: { worker: PendingWorker }) {
  const [open, setOpen] = useState(true);

  return (
    <div className="pending-worker">
      <div className="pending-worker-head">
        <span className={`badge ${worker.online ? 'online' : 'offline'}`}>
          {worker.online ? 'Connected' : 'Offline'}
        </span>
        <span className="mono" style={{ fontWeight: 600 }}>
          {worker.hostName}
        </span>
        <span className="faint">
          enrolled {formatRelative(worker.createdAt)} · worker {worker.version ?? 'unknown'}
        </span>
        <button className="action" style={{ marginLeft: 'auto' }} onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Configure'}
        </button>
      </div>

      {open ? (
        worker.hasCredentialKey ? (
          <InstanceConfigPanel workerId={worker.workerId} hostName={worker.hostName} />
        ) : (
          <div className="empty">
            <strong>Waiting for this worker to publish its encryption key</strong>
            <span>
              It does that the first time it connects. Credentials cannot be set until then,
              because there would be nothing to encrypt them to.
            </span>
          </div>
        )
      ) : null}
    </div>
  );
}
