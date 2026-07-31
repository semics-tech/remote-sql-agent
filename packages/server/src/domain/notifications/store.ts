import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import {
  notificationChannelKind,
  notificationChannels,
  notificationDeliveries,
  notificationEventKind,
  notificationEvents,
  notificationRules,
} from '../../db/schema.js';
import { assertWebhookUrl, emailConfigSchema, secretHint, webhookConfigSchema } from './senders.js';

/** CRUD for notification channels and rules, with secrets kept out of reads. */

export const channelInputSchema = z.object({
  /** Present when editing; absent when creating. */
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(128),
  kind: z.enum(notificationChannelKind),
  config: z.record(z.string(), z.unknown()).default({}),
  /** Omitted on edit to keep the stored secret rather than blank it. */
  secret: z.string().max(4096).optional(),
  enabled: z.boolean().default(true),
});

export type ChannelInput = z.infer<typeof channelInputSchema>;

export const ruleInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(128),
  enabled: z.boolean().default(true),
  events: z.array(z.enum(notificationEventKind)).min(1, 'Choose at least one event.'),
  instanceIds: z.array(z.string().uuid()).default([]),
  jobNameContains: z.string().max(128).nullish(),
  channelIds: z.array(z.string().uuid()).min(1, 'Choose at least one channel.'),
  throttleMinutes: z.number().int().min(0).max(10_080).default(60),
});

export type RuleInput = z.infer<typeof ruleInputSchema>;

export interface ChannelView {
  id: string;
  name: string;
  kind: (typeof notificationChannelKind)[number];
  config: Record<string, unknown>;
  hasSecret: boolean;
  secretHint: string | null;
  enabled: boolean;
  lastDeliveredAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
}

export async function listChannels(db: Database): Promise<ChannelView[]> {
  const rows = await db.select().from(notificationChannels).orderBy(notificationChannels.name);
  // `secret` is never projected. The hint is enough to tell two webhooks apart
  // and useless to anyone who reads the response.
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    config: r.config,
    hasSecret: r.secret !== null,
    secretHint: r.secretHint,
    enabled: r.enabled,
    lastDeliveredAt: r.lastDeliveredAt,
    lastError: r.lastError,
    lastErrorAt: r.lastErrorAt,
  }));
}

export class NotificationConfigError extends Error {
  readonly statusCode = 400;
  readonly code = 'InvalidChannel';
}

/**
 * Validate a channel's settings for its kind before storing it.
 *
 * Catching a missing SMTP host here rather than at delivery time is the
 * difference between an error the admin sees while they are looking at the form
 * and a notification that silently never arrives.
 */
function validateChannel(input: ChannelInput, hasStoredSecret: boolean): void {
  switch (input.kind) {
    case 'email': {
      const parsed = emailConfigSchema.safeParse(input.config);
      if (!parsed.success) {
        throw new NotificationConfigError(parsed.error.issues.map((i) => i.message).join(' '));
      }
      break;
    }
    case 'slack':
    case 'teams': {
      if (!input.secret && !hasStoredSecret) {
        throw new NotificationConfigError(
          `A ${input.kind} channel needs an incoming webhook URL.`,
        );
      }
      if (input.secret) assertWebhookUrl(input.secret);
      break;
    }
    case 'webhook': {
      if (!input.secret && !hasStoredSecret) {
        throw new NotificationConfigError('A webhook channel needs a URL to POST to.');
      }
      if (input.secret) assertWebhookUrl(input.secret);
      const parsed = webhookConfigSchema.safeParse(input.config);
      if (!parsed.success) throw new NotificationConfigError('Those headers are not valid.');
      break;
    }
  }
}

export async function saveChannel(
  db: Database,
  input: ChannelInput & { actorId: string | null },
): Promise<ChannelView> {
  const existing = input.id
    ? (await db.select().from(notificationChannels).where(eq(notificationChannels.id, input.id)))[0]
    : undefined;

  validateChannel(input, existing?.secret != null);

  const secretFields = input.secret
    ? { secret: input.secret, secretHint: secretHint(input.kind, input.secret) }
    : {};

  const values = {
    name: input.name,
    kind: input.kind,
    config: input.config,
    enabled: input.enabled,
    ...secretFields,
  };

  const [row] = existing
    ? await db
        .update(notificationChannels)
        .set(values)
        .where(eq(notificationChannels.id, existing.id))
        .returning({ id: notificationChannels.id })
    : await db
        .insert(notificationChannels)
        .values({ ...values, createdBy: input.actorId })
        .returning({ id: notificationChannels.id });

  if (!row) throw new NotificationConfigError('Failed to save the channel.');

  const saved = (await listChannels(db)).find((c) => c.id === row.id);
  if (!saved) throw new NotificationConfigError('Failed to read back the channel.');
  return saved;
}

export async function deleteChannel(db: Database, channelId: string): Promise<void> {
  await db.delete(notificationChannels).where(eq(notificationChannels.id, channelId));
}

export async function listRules(db: Database) {
  return db.select().from(notificationRules).orderBy(notificationRules.name);
}

export async function saveRule(db: Database, input: RuleInput & { actorId: string | null }) {
  const values = {
    name: input.name,
    enabled: input.enabled,
    events: input.events,
    instanceIds: input.instanceIds,
    jobNameContains: input.jobNameContains ?? null,
    channelIds: input.channelIds,
    throttleMinutes: input.throttleMinutes,
  };

  const [row] = input.id
    ? await db
        .update(notificationRules)
        .set(values)
        .where(eq(notificationRules.id, input.id))
        .returning()
    : await db
        .insert(notificationRules)
        .values({ ...values, createdBy: input.actorId })
        .returning();

  if (!row) throw new NotificationConfigError('Failed to save the rule.');
  return row;
}

export async function deleteRule(db: Database, ruleId: string): Promise<void> {
  await db.delete(notificationRules).where(eq(notificationRules.id, ruleId));
}

/**
 * Recent delivery attempts, including the suppressed ones.
 *
 * Showing throttled rows is the point: an operator who sees nothing arriving
 * needs to be able to tell "the throttle is working" from "the pipeline is
 * broken", and only the record can tell them which.
 */
export async function listDeliveries(db: Database, limit: number) {
  return db
    .select({
      id: notificationDeliveries.id,
      state: notificationDeliveries.state,
      attempts: notificationDeliveries.attempts,
      lastError: notificationDeliveries.lastError,
      sentAt: notificationDeliveries.sentAt,
      createdAt: notificationDeliveries.createdAt,
      channelName: notificationChannels.name,
      channelKind: notificationChannels.kind,
      eventKind: notificationEvents.kind,
      eventPayload: notificationEvents.payload,
      occurredAt: notificationEvents.occurredAt,
    })
    .from(notificationDeliveries)
    .innerJoin(notificationChannels, eq(notificationChannels.id, notificationDeliveries.channelId))
    .innerJoin(notificationEvents, eq(notificationEvents.id, notificationDeliveries.eventId))
    .orderBy(desc(notificationDeliveries.createdAt))
    .limit(Math.min(limit, 500));
}
