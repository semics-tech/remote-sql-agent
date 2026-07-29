import type { NotificationEventKind } from '../../db/schema.js';

/**
 * One event, four wire formats.
 *
 * Every channel renders from the same neutral description rather than each
 * sender inventing its own wording, so a failure reads identically in Slack, in
 * Teams and in the email that follows it. That matters more than it sounds:
 * during an incident people are comparing these side by side.
 */

export interface NotificationEventView {
  kind: NotificationEventKind;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

export type Severity = 'critical' | 'warning' | 'info' | 'good';

export interface RenderedNotification {
  /** Subject line / card title. */
  title: string;
  /** One sentence saying what happened. */
  summary: string;
  /** Ordered label/value pairs; the detail a DBA needs before opening a laptop. */
  facts: Array<{ label: string; value: string }>;
  /** Verbatim SQL Server error text, when there is one. */
  detail: string | null;
  severity: Severity;
  /** Deep link into the dashboard, when the event names a job. */
  url: string | null;
}

const SEVERITY_COLOUR: Record<Severity, string> = {
  critical: 'C0342C',
  warning: 'B5730D',
  info: '5B6775',
  good: '1A7F4B',
};

const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: '🔴',
  warning: '🟠',
  info: '⚪',
  good: '🟢',
};

export function severityColour(severity: Severity): string {
  return SEVERITY_COLOUR[severity];
}

function str(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : '';
}

function num(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** hh:mm:ss, matching how durations read everywhere else in the product. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return 'unknown';
  const s = Math.max(0, Math.trunc(seconds));
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

export function renderNotification(
  event: NotificationEventView,
  publicUrl: string,
): RenderedNotification {
  const p = event.payload;
  const jobName = str(p, 'jobName') || 'a job';
  const instanceName = str(p, 'instanceName');
  const hostName = str(p, 'hostName');
  const where = hostName && instanceName ? `${hostName}\\${instanceName}` : instanceName || hostName;

  const instanceId = str(p, 'instanceId');
  const jobUuid = str(p, 'jobUuid');
  const url =
    instanceId && jobUuid
      ? `${publicUrl.replace(/\/+$/u, '')}/instances/${instanceId}/jobs/${jobUuid}`
      : instanceId
        ? `${publicUrl.replace(/\/+$/u, '')}/instances/${instanceId}`
        : null;

  const base = { detail: str(p, 'message') || null, url };

  switch (event.kind) {
    case 'job.failed': {
      const streak = num(p, 'consecutiveFailures') ?? 1;
      return {
        ...base,
        severity: 'critical',
        title: `Job failed: ${jobName}`,
        summary:
          streak > 1
            ? `${jobName} on ${where} has now failed ${streak} runs in a row.`
            : `${jobName} failed on ${where}.`,
        facts: [
          { label: 'Instance', value: where },
          { label: 'Ran for', value: formatDuration(num(p, 'runDurationSeconds')) },
          { label: 'Failed step', value: str(p, 'stepName') || 'not reported' },
          { label: 'Consecutive failures', value: String(streak) },
        ],
      };
    }

    case 'job.recovered':
      return {
        ...base,
        severity: 'good',
        title: `Job recovered: ${jobName}`,
        summary: `${jobName} on ${where} succeeded after ${num(p, 'previousFailures') ?? 1} failed run(s).`,
        facts: [
          { label: 'Instance', value: where },
          { label: 'Ran for', value: formatDuration(num(p, 'runDurationSeconds')) },
        ],
      };

    case 'job.succeeded':
      return {
        ...base,
        severity: 'good',
        title: `Job succeeded: ${jobName}`,
        summary: `${jobName} completed on ${where}.`,
        facts: [
          { label: 'Instance', value: where },
          { label: 'Ran for', value: formatDuration(num(p, 'runDurationSeconds')) },
        ],
      };

    case 'job.long_running': {
      const elapsed = num(p, 'elapsedSeconds');
      const average = num(p, 'averageSeconds');
      return {
        ...base,
        severity: 'warning',
        title: `Job running long: ${jobName}`,
        summary:
          average === null
            ? `${jobName} on ${where} has been running for ${formatDuration(elapsed)}.`
            : `${jobName} on ${where} has been running for ${formatDuration(elapsed)}, against a usual ${formatDuration(Math.round(average))}.`,
        facts: [
          { label: 'Instance', value: where },
          { label: 'Running for', value: formatDuration(elapsed) },
          { label: 'Usually takes', value: average === null ? 'no baseline yet' : formatDuration(Math.round(average)) },
          { label: 'Current step', value: str(p, 'currentStepName') || 'not reported' },
        ],
      };
    }

    case 'worker.offline':
      return {
        ...base,
        severity: 'warning',
        title: `Worker offline: ${hostName}`,
        summary:
          `The worker on ${hostName} stopped reporting. Its jobs are still running — ` +
          'SQL Agent does not depend on the worker — but the estate view is stale.',
        facts: [
          { label: 'Host', value: hostName },
          { label: 'Instances affected', value: String(num(p, 'instanceCount') ?? 0) },
          { label: 'Last seen', value: str(p, 'lastSeenAt') || 'unknown' },
        ],
      };

    case 'command.failed':
      return {
        ...base,
        severity: 'critical',
        title: `Change failed: ${jobName}`,
        summary: `A ${str(p, 'commandType') || 'change'} on ${where} was refused or failed to apply.`,
        facts: [
          { label: 'Instance', value: where },
          { label: 'Command', value: str(p, 'commandType') || 'unknown' },
          { label: 'Reason', value: str(p, 'resultCode') || 'unknown' },
          { label: 'Issued by', value: str(p, 'issuedBy') || 'unknown' },
        ],
      };
  }
}

// ---------------------------------------------------------------------------
// Per-channel bodies
// ---------------------------------------------------------------------------

export function toPlainText(rendered: RenderedNotification): string {
  const lines = [rendered.summary, ''];
  for (const fact of rendered.facts) lines.push(`${fact.label}: ${fact.value}`);
  if (rendered.detail) lines.push('', rendered.detail);
  if (rendered.url) lines.push('', rendered.url);
  return lines.join('\n');
}

export function toHtml(rendered: RenderedNotification): string {
  const rows = rendered.facts
    .map(
      (f) =>
        `<tr><td style="padding:2px 12px 2px 0;color:#5b6775">${escapeHtml(f.label)}</td>` +
        `<td style="padding:2px 0"><strong>${escapeHtml(f.value)}</strong></td></tr>`,
    )
    .join('');

  return [
    `<div style="font-family:-apple-system,Segoe UI,system-ui,sans-serif;font-size:14px;color:#16202b">`,
    `<p style="margin:0 0 12px"><span style="color:#${severityColour(rendered.severity)}">●</span> `,
    `<strong>${escapeHtml(rendered.summary)}</strong></p>`,
    `<table style="border-collapse:collapse;font-size:13px">${rows}</table>`,
    rendered.detail
      ? `<pre style="background:#f6f7f9;border:1px solid #d6dbe2;border-radius:3px;padding:8px;` +
        `font-size:12px;white-space:pre-wrap">${escapeHtml(rendered.detail)}</pre>`
      : '',
    rendered.url ? `<p style="margin:12px 0 0"><a href="${escapeHtml(rendered.url)}">Open in Remote SQL Agent</a></p>` : '',
    '</div>',
  ].join('');
}

/** Slack Block Kit. `text` is kept populated for notification previews. */
export function toSlackPayload(rendered: RenderedNotification): unknown {
  const fields = rendered.facts.map((f) => ({
    type: 'mrkdwn',
    text: `*${f.label}*\n${f.value}`,
  }));

  const blocks: unknown[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${SEVERITY_EMOJI[rendered.severity]} *${rendered.title}*\n${rendered.summary}`,
      },
    },
    // Slack rejects a section with more than ten fields, and two columns of
    // five is already more than anyone reads on a phone.
    { type: 'section', fields: fields.slice(0, 10) },
  ];

  if (rendered.detail) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `\`\`\`${truncate(rendered.detail, 2500)}\`\`\`` },
    });
  }
  if (rendered.url) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open job' },
          url: rendered.url,
        },
      ],
    });
  }

  return { text: `${rendered.title} — ${rendered.summary}`, blocks };
}

/** Teams still ingests legacy MessageCard on incoming webhooks. */
export function toTeamsPayload(rendered: RenderedNotification): unknown {
  return {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    themeColor: severityColour(rendered.severity),
    summary: rendered.title,
    title: rendered.title,
    text: rendered.summary,
    sections: [
      {
        facts: rendered.facts.map((f) => ({ name: f.label, value: f.value })),
        text: rendered.detail ? `<pre>${escapeHtml(truncate(rendered.detail, 2000))}</pre>` : undefined,
      },
    ],
    potentialAction: rendered.url
      ? [
          {
            '@type': 'OpenUri',
            name: 'Open in Remote SQL Agent',
            targets: [{ os: 'default', uri: rendered.url }],
          },
        ]
      : undefined,
  };
}

/** Generic webhook: the event as data, for whatever the site pipes it into. */
export function toWebhookPayload(
  event: NotificationEventView,
  rendered: RenderedNotification,
): unknown {
  return {
    kind: event.kind,
    severity: rendered.severity,
    title: rendered.title,
    summary: rendered.summary,
    occurredAt: event.occurredAt.toISOString(),
    url: rendered.url,
    detail: rendered.detail,
    payload: event.payload,
  };
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
