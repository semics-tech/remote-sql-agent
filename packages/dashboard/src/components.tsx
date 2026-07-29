import type { ReactNode } from 'react';
import { runStatusClass, runStatusLabel, formatDateTime, formatDuration } from './format.js';
import type { HistoryRun } from './api.js';

export function StatusDot({ status }: { status: number | null | undefined }) {
  return (
    <span className="status">
      <span className={`dot ${runStatusClass(status)}`} aria-hidden="true" />
      {runStatusLabel(status)}
    </span>
  );
}

/**
 * The run tape: one tick per run, oldest on the left.
 *
 * This is the signature element. A job's *pattern* of failure — every Tuesday,
 * or continuously since last Thursday — is the thing a DBA actually needs, and
 * it is invisible in SSMS without opening each job's history in turn.
 */
export function RunTape({ runs, max = 20 }: { runs: HistoryRun[]; max?: number }) {
  if (runs.length === 0) return <span className="tape-empty">never run</span>;

  // `runs` arrives newest-first; the tape reads left-to-right as oldest-to-newest
  // so it matches the direction of time on every other chart a DBA reads.
  const recent = runs.slice(0, max).reverse();
  const label = `${recent.length} most recent runs, oldest first: ${recent
    .map((r) => runStatusLabel(r.runStatus))
    .join(', ')}`;

  return (
    <span className="tape" role="img" aria-label={label} title={label}>
      {recent.map((r) => (
        <i key={r.sqlInstanceId} className={runStatusClass(r.runStatus)} />
      ))}
    </span>
  );
}

export function Panel({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <header className="panel-head">
        <span>{title}</span>
        {actions ? <span style={{ marginLeft: 'auto' }}>{actions}</span> : null}
      </header>
      {children}
    </section>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {hint ? <span>{hint}</span> : null}
    </div>
  );
}

export function QueryState({
  isLoading,
  error,
  children,
}: {
  isLoading: boolean;
  error: unknown;
  children: ReactNode;
}) {
  if (error) {
    const message = error instanceof Error ? error.message : String(error);
    return (
      <div className="error">
        Could not load this view: {message}. The control plane may be restarting — this retries
        automatically.
      </div>
    );
  }
  if (isLoading) return <div className="empty">Loading…</div>;
  return <>{children}</>;
}

export function LastRunCell({
  status,
  at,
  durationSeconds,
}: {
  status: number | null;
  at: string | null;
  durationSeconds: number | null;
}) {
  if (at === null) return <span className="faint">Never run</span>;
  return (
    <span className="status" title={`${formatDateTime(at)} · ran for ${formatDuration(durationSeconds)}`}>
      <span className={`dot ${runStatusClass(status)}`} aria-hidden="true" />
      {formatDateTime(at)}
    </span>
  );
}
