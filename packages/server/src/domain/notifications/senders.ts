import { createTransport } from 'nodemailer';
import { z } from 'zod';
import type { NotificationChannelKind } from '../../db/schema.js';
import {
  renderNotification,
  toHtml,
  toPlainText,
  toSlackPayload,
  toTeamsPayload,
  toWebhookPayload,
  type NotificationEventView,
} from './render.js';

/**
 * Delivery to each channel kind.
 *
 * Every sender either returns cleanly or throws with a message an operator can
 * act on. "Delivery failed" tells nobody anything; "Slack returned 404
 * invalid_token" tells them the webhook was revoked.
 */

export interface Channel {
  id: string;
  name: string;
  kind: NotificationChannelKind;
  config: Record<string, unknown>;
  secret: string | null;
}

export interface SendContext {
  publicUrl: string;
  /** Bounded so a hung collector cannot wedge the delivery loop. */
  timeoutMs: number;
}

export const emailConfigSchema = z.object({
  host: z.string().min(1, 'SMTP host is required.'),
  port: z.coerce.number().int().min(1).max(65535).default(587),
  /** Implicit TLS (465). Port 587 negotiates STARTTLS instead. */
  secure: z.boolean().default(false),
  username: z.string().optional(),
  from: z.string().min(1, 'A From address is required.'),
  to: z.array(z.string().min(1)).min(1, 'At least one recipient is required.'),
});

export const webhookConfigSchema = z.object({
  /** Extra headers, e.g. an Authorization value for a private endpoint. */
  headers: z.record(z.string(), z.string()).default({}),
});

export type EmailConfig = z.infer<typeof emailConfigSchema>;

export class NotificationSendError extends Error {
  constructor(
    message: string,
    /** False for authentication or configuration faults: retrying will not fix
     * a revoked webhook, and hammering it just delays the operator noticing. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'NotificationSendError';
  }
}

export async function sendNotification(
  channel: Channel,
  event: NotificationEventView,
  context: SendContext,
): Promise<void> {
  const rendered = renderNotification(event, context.publicUrl);

  switch (channel.kind) {
    case 'email':
      return sendEmail(channel, rendered.title, toPlainText(rendered), toHtml(rendered), context);
    case 'slack':
      return postJson(channel, toSlackPayload(rendered), {}, context, 'Slack');
    case 'teams':
      return postJson(channel, toTeamsPayload(rendered), {}, context, 'Teams');
    case 'webhook': {
      const { headers } = webhookConfigSchema.parse(channel.config);
      return postJson(channel, toWebhookPayload(event, rendered), headers, context, 'Webhook');
    }
  }
}

async function sendEmail(
  channel: Channel,
  subject: string,
  text: string,
  html: string,
  context: SendContext,
): Promise<void> {
  const config = emailConfigSchema.parse(channel.config);

  const transport = createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    // An unauthenticated relay is normal on an internal network, so credentials
    // are only attached when a username is actually configured.
    auth: config.username ? { user: config.username, pass: channel.secret ?? '' } : undefined,
    // Only when a password is actually going over the link. `secure: false`
    // means "start in the clear and upgrade with STARTTLS", and nodemailer
    // treats the upgrade as optional — so an active MITM that simply omits the
    // STARTTLS capability gets the whole `AUTH` exchange in cleartext, with no
    // error anywhere. Requiring it turns that into a connection failure.
    //
    // Not required on an unauthenticated relay: those are normal on an internal
    // network, frequently have no TLS at all, and there is no credential to
    // protect — refusing them would break the common case to defend nothing.
    requireTLS: Boolean(config.username) && !config.secure,
    connectionTimeout: context.timeoutMs,
    greetingTimeout: context.timeoutMs,
    socketTimeout: context.timeoutMs,
  });

  try {
    await transport.sendMail({
      from: config.from,
      to: config.to.join(', '),
      subject,
      text,
      html,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { responseCode?: number }).responseCode;
    // 5xx SMTP is a permanent rejection — a bad recipient or a refused sender.
    throw new NotificationSendError(
      `SMTP delivery to ${config.host}:${config.port} failed: ${message}`,
      code === undefined || code < 500,
    );
  } finally {
    transport.close();
  }
}

/**
 * Hosts a webhook may never reach, whatever an administrator types.
 *
 * Deliberately narrow. This product lives *inside* the firewall, so an internal
 * relay on an RFC1918 address is the normal webhook target, not the exception —
 * blocking private ranges wholesale would break the primary use case and become
 * a flag every estate turns off.
 *
 * What is blocked is the link-local range, which is never a legitimate webhook
 * target and is where every cloud provider parks its instance metadata service.
 * `169.254.169.254` hands out role credentials to anything that asks.
 *
 * The boundary, stated rather than implied: this checks the *literal* host. A
 * name that resolves to a link-local address gets through, and resolving here
 * would not close it either — DNS can answer differently for the check and for
 * the request. What does close the oracle is that the response body is never
 * returned to the caller and redirects are refused, so even a request that
 * lands somewhere it should not tells the sender nothing back.
 */
const BLOCKED_HOST_PATTERNS = [
  // 169.254.0.0/16. The decimal, octal and hex spellings of the same address
  // need no patterns of their own: `new URL()` normalises `http://2852039166/`,
  // `http://0xa9fea9fe/` and `http://0251.0376.0251.0376/` all to this form.
  // Checked rather than assumed — three patterns for them were written first
  // and turned out to be dead code.
  /^169\.254\./u,
  // The same range IPv4-mapped. `[::ffff:169.254.169.254]` does *not* survive
  // as a dotted quad — `new URL()` renders it `[::ffff:a9fe:a9fe]` — so
  // matching on `::ffff:169.254.` would have missed every one of these.
  /^\[?::ffff:a9fe:/iu,
  /^\[?fe80:/iu,
  // The names cloud providers publish for the same endpoint.
  /^metadata\.google\.internal$/iu,
  /^metadata\.goog$/iu,
];

/** Throws unless this URL is one a webhook is allowed to reach. */
export function assertWebhookUrlAllowed(raw: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NotificationSendError(`${label} webhook URL is not a valid URL.`, false);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NotificationSendError(
      `${label} webhook URL must be http or https, not ${url.protocol.replace(':', '')}.`,
      false,
    );
  }

  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    throw new NotificationSendError(
      `${label} webhook URL points at the link-local range, which is where cloud ` +
        'instance metadata lives. Refusing to send there.',
      false,
    );
  }

  return url;
}

async function postJson(
  channel: Channel,
  body: unknown,
  headers: Record<string, string>,
  context: SendContext,
  label: string,
): Promise<void> {
  const raw = channel.secret;
  if (!raw) {
    throw new NotificationSendError(`${label} channel "${channel.name}" has no webhook URL.`, false);
  }
  const url = assertWebhookUrlAllowed(raw, label);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), context.timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
      // A redirect is a second request to somewhere the check above never saw,
      // which would hand back exactly the reachability this is meant to remove.
      // No legitimate webhook endpoint answers a POST with a redirect.
      redirect: 'error',
    });

    if (!response.ok) {
      throw new NotificationSendError(
        // Status and statusText only. Echoing the body made `/test` a readable
        // oracle: point a channel at any host, press Test, and read the reply
        // out of the error message. The body is of no use to an operator
        // diagnosing their own webhook and of considerable use to anyone
        // probing the network the control plane sits in.
        `${label} returned ${response.status} ${response.statusText}.`,
        // 4xx other than 408/429 means the request itself is wrong.
        response.status >= 500 || response.status === 408 || response.status === 429,
      );
    }
  } catch (err) {
    if (err instanceof NotificationSendError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new NotificationSendError(`${label} did not respond within ${context.timeoutMs}ms.`, true);
    }
    throw new NotificationSendError(
      `${label} delivery failed: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A recognisable but unusable fragment of a secret, for the channel list.
 *
 * Webhook URLs keep their host and the first few characters of the path, which
 * is enough to tell the release channel from the alerts channel. SMTP passwords
 * get nothing but a length.
 */
export function secretHint(kind: NotificationChannelKind, secret: string): string {
  if (kind === 'email') return `${secret.length} characters`;
  try {
    const url = new URL(secret);
    const tail = url.pathname.replaceAll('/', '').slice(0, 6);
    return `${url.host}/…${tail}`;
  } catch {
    return `${secret.slice(0, 4)}…`;
  }
}

/** Reject a webhook that is not a URL we would ever POST to. */
export function assertWebhookUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NotificationSendError('That webhook URL is not a valid URL.', false);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new NotificationSendError('A webhook URL must be http or https.', false);
  }
}
