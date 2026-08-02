import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/db/client.js';
import { pruneRetention } from '../src/domain/ingest.js';
import {
  agentLogEntries,
  auditExportQueue,
  auditLog,
  commands,
  jobHistory,
  notificationChannels,
  notificationDeliveries,
  notificationEvents,
} from '../src/db/schema.js';
import { setupTestDatabase, seedInstance, truncateAll } from './helpers/db.js';

/**
 * What retention actually removes, and — just as important — what it never
 * touches.
 *
 * The review found four tables the original `pruneRetention` never reached at
 * all: `notification_events`, `notification_deliveries`, `commands` and
 * `audit_export_queue`, all four growing without bound. `audit_export_queue` is
 * the one that matters most in practice — it is enqueued unconditionally on
 * every audited action and nothing ever drains it while OTLP export is
 * disabled, which is the default.
 */

let db: Database;
let close: () => Promise<void>;
let instanceId: string;

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 90;

beforeAll(async () => {
  ({ db, close } = await setupTestDatabase('retention'));
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await truncateAll(db);
  ({ instanceId } = await seedInstance(db));
});

const OLD = new Date(Date.now() - (RETENTION_DAYS + 10) * DAY_MS);
const RECENT = new Date(Date.now() - 1 * DAY_MS);

async function countRows(table: Parameters<typeof db.select>[0] extends never ? never : unknown) {
  // Typed loosely on purpose: this helper is reused across several unrelated
  // tables below, and drizzle's per-table select type would need repeating for
  // each one otherwise.
  const rows = await db.select().from(table as never);
  return rows.length;
}

describe('what already worked', () => {
  it('still prunes old job history and agent log entries', async () => {
    await db.insert(jobHistory).values([
      {
        instanceId,
        jobUuid: '11111111-1111-4111-8111-111111111111',
        sqlInstanceId: 1,
        stepId: 0,
        runStatus: 1,
        runDatetime: OLD,
      },
      {
        instanceId,
        jobUuid: '11111111-1111-4111-8111-111111111111',
        sqlInstanceId: 2,
        stepId: 0,
        runStatus: 1,
        runDatetime: RECENT,
      },
    ]);
    await db.insert(agentLogEntries).values([
      { instanceId, loggedAt: OLD, message: 'old', dedupeKey: 'a' },
      { instanceId, loggedAt: RECENT, message: 'new', dedupeKey: 'b' },
    ]);

    await pruneRetention(db, RETENTION_DAYS);

    expect(await countRows(jobHistory)).toBe(1);
    expect(await countRows(agentLogEntries)).toBe(1);
  });
});

describe('the tables retention never reached', () => {
  it('prunes old notification events, and their deliveries cascade with them', async () => {
    const [channel] = await db
      .insert(notificationChannels)
      .values({ name: 'ops', kind: 'webhook', secret: 'https://example.test/hook' })
      .returning({ id: notificationChannels.id });

    const [oldEvent] = await db
      .insert(notificationEvents)
      .values({
        kind: 'job.failed',
        dedupeKey: 'old-event',
        instanceId,
        payload: {},
        occurredAt: OLD,
      })
      .returning({ id: notificationEvents.id });
    const [recentEvent] = await db
      .insert(notificationEvents)
      .values({
        kind: 'job.failed',
        dedupeKey: 'recent-event',
        instanceId,
        payload: {},
        occurredAt: RECENT,
      })
      .returning({ id: notificationEvents.id });

    await db.insert(notificationDeliveries).values([
      { eventId: oldEvent!.id, channelId: channel!.id, throttleKey: 'k1' },
      { eventId: recentEvent!.id, channelId: channel!.id, throttleKey: 'k2' },
    ]);

    await pruneRetention(db, RETENTION_DAYS);

    expect(await countRows(notificationEvents)).toBe(1);
    const remainingEvents = await db.select().from(notificationEvents);
    expect(remainingEvents[0]!.id).toBe(recentEvent!.id);

    // The delivery for the pruned event went with it — deleting the event
    // alone is enough, on the FK's own onDelete: 'cascade'.
    const remainingDeliveries = await db.select().from(notificationDeliveries);
    expect(remainingDeliveries).toHaveLength(1);
    expect(remainingDeliveries[0]!.eventId).toBe(recentEvent!.id);
  });

  it('prunes old completed commands but never a command still in flight', async () => {
    const { workerId } = await seedInstance(db, 'CMDHOST');
    const jobUuid = '22222222-2222-4222-8222-222222222222';

    await db.insert(commands).values([
      // Old, but never touched: still pending_approval, no completedAt.
      { type: 'toggleJob', instanceId, workerId, jobUuid, payload: {}, state: 'pending_approval', issuedAt: OLD },
      // Old and terminal: this is what should be pruned.
      {
        type: 'toggleJob',
        instanceId,
        workerId,
        jobUuid,
        payload: {},
        state: 'succeeded',
        issuedAt: OLD,
        completedAt: OLD,
      },
      // Terminal, but recent: kept.
      {
        type: 'toggleJob',
        instanceId,
        workerId,
        jobUuid,
        payload: {},
        state: 'failed',
        issuedAt: RECENT,
        completedAt: RECENT,
      },
    ]);

    await pruneRetention(db, RETENTION_DAYS);

    const remaining = await db.select({ state: commands.state }).from(commands);
    expect(remaining.map((r) => r.state).sort()).toEqual(['failed', 'pending_approval']);
  });

  it('prunes stale audit-export-queue rows, which is what stops them growing forever when OTLP is off', async () => {
    // writeAudit enqueues into this table on every audited action regardless of
    // whether export is enabled, and nothing drains it while export is off —
    // the default. Age is the only backstop it has.
    const [oldAudit] = await db
      .insert(auditLog)
      .values({ actorType: 'user', actor: 'dba', action: 'test.old' })
      .returning({ id: auditLog.id });
    const [recentAudit] = await db
      .insert(auditLog)
      .values({ actorType: 'user', actor: 'dba', action: 'test.recent' })
      .returning({ id: auditLog.id });

    await db.insert(auditExportQueue).values([
      { auditLogId: oldAudit!.id, createdAt: OLD },
      { auditLogId: recentAudit!.id, createdAt: RECENT },
    ]);

    await pruneRetention(db, RETENTION_DAYS);

    const remaining = await db.select().from(auditExportQueue);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.auditLogId).toBe(recentAudit!.id);

    // audit_log itself is never touched by retention — append-only, by design.
    const auditRows = await db.select().from(auditLog);
    expect(auditRows).toHaveLength(2);
  });
});
