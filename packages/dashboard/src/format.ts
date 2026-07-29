/**
 * Presentation helpers.
 *
 * SSMS terminology is used verbatim (§9): "Succeeded", "Failed", "Retry",
 * "Cancelled", "In progress". A DBA should be able to read this screen and the
 * SSMS Job Activity Monitor side by side without translating.
 */

export const RUN_STATUS = {
  0: 'Failed',
  1: 'Succeeded',
  2: 'Retry',
  3: 'Cancelled',
  4: 'In progress',
} as const;

export type RunStatusCode = keyof typeof RUN_STATUS;

export function runStatusLabel(status: number | null | undefined): string {
  if (status === null || status === undefined) return 'Never run';
  return RUN_STATUS[status as RunStatusCode] ?? `Unknown (${status})`;
}

/** CSS class matching the status vocabulary in styles.css. */
export function runStatusClass(status: number | null | undefined): string {
  switch (status) {
    case 0:
      return 'failed';
    case 1:
      return 'succeeded';
    case 2:
      return 'retry';
    case 3:
      return 'cancelled';
    case 4:
      return 'running';
    default:
      return '';
  }
}

/** SSMS-style duration: 00:01:30, not "90s". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  const s = Math.max(0, Math.trunc(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';
  const deltaSeconds = Math.round((then - Date.now()) / 1000);
  const abs = Math.abs(deltaSeconds);

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 7],
    ['week', 4.35],
    ['month', 12],
    ['year', Number.POSITIVE_INFINITY],
  ];

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  let value = deltaSeconds;
  let remaining = abs;
  for (const [unit, size] of units) {
    if (remaining < size) return rtf.format(Math.round(value), unit);
    remaining /= size;
    value /= size;
  }
  return rtf.format(Math.round(value), 'year');
}

/** Notification levels as SSMS words. */
export function notifyLevel(level: number): string {
  return ['Never', 'When the job succeeds', 'When the job fails', 'When the job completes'][level] ?? 'Never';
}

/** on_success_action / on_fail_action as SSMS words. */
export function stepAction(action: number, targetStepId: number): string {
  switch (action) {
    case 1:
      return 'Quit reporting success';
    case 2:
      return 'Quit reporting failure';
    case 3:
      return 'Go to the next step';
    case 4:
      return `Go to step ${targetStepId}`;
    default:
      return `Unknown (${action})`;
  }
}
