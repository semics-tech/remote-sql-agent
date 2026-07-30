import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Database } from '../src/db/client.js';
import {
  notificationChannels,
  notificationDeliveries,
  notificationEvents,
  notificationRules,
} from '../src/db/schema.js';
import { NotificationService } from '../src/domain/notifications/service.js';
import { ingestHistory } from '../src/domain/ingest.js';
import { loadConfig } from '../src/config.js';
import { setupTestDatabase, seedInstance, truncateAll } from './helpers/db.js';
import { renderNotification } from '../src/domain/notifications/render.js';

/**
 * The property that matters most here is that a *replayed* history batch does
 * not notify twice. The worker's outbox replays on every reconnect, so
 * "detection runs again over rows we already have" is the normal case.
 */

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never;

let db: Database;
let close: () => Promise<void>;
let service: NotificationService;

const config = loadConfig({
  RSAGENT_DATABASE_URL: 'postgres://x:y@localhost:5432/z',
  RSAGENT_PUBLIC_URL: 'https://rsagent.example.com',
  RSAGENT_GRPC_REQUIRE_TLS: 'false',
} as NodeJS.ProcessEnv);

beforeAll(async () => {
  ({ db, close } = await setupTestDatabase('notifications'));
  service = new NotificationService(db, config, logger);
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await truncateAll(db);
});

/** A channel that captures rather than sends, so nothing leaves the test. */
async function seedChannel(name = 'ops'): Promise<string> {
  const [row] = await db
    .insert(notificationChannels)
    .values({
      name,
      kind: 'webhook',
      config: {},
      secret: 'https://example.invalid/hook',
      secretHint: 'example.invalid/…hook',
    })
    .returning({ id: notificationChannels.id });
  return row!.id;
}

async function seedRule(
  channelId: string,
  overrides: Partial<typeof notificationRules.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(notificationRules)
    .values({
      name: `rule-${Math.round(performance.now() * 1000)}`,
      events: ['job.failed', 'job.recovered', 'job.long_running'],
      channelIds: [channelId],
      throttleMinutes: 0,
      ...overrides,
    })
    .returning({ id: notificationRules.id });
  return row!.id;
}

function historyRow(overrides: {
  instanceId: number;
  jobUuid: string;
  runStatus: number;
  stepId?: number;
  seconds?: number;
}) {
  return {
    instanceId: BigInt(overrides.instanceId) as never,
    jobUuid: overrides.jobUuid,
    stepId: overrides.stepId ?? 0,
    stepName: overrides.stepId ? `Step ${overrides.stepId}` : '',
    runStatus: overrides.runStatus,
    runDatetime: { seconds: BigInt(1_700_000_000 + (overrides.seconds ?? 0)), nanos: 0 } as never,
    runDurationSeconds: 30,
    message: overrides.runStatus === 0 ? 'The step failed.' : 'The job succeeded.',
    retriesAttempted: 0,
    server: 'TESTHOST',
    sqlSeverity: 0,
    sqlMessageId: 0,
  };
}

async function seedJob(db: Database, instanceId: string, jobUuid: string, name: string) {
  await db.execute(
    `INSERT INTO jobs (instance_id, job_uuid, name) VALUES ('${instanceId}', '${jobUuid}', '${name}')` as never,
  );
}

const JOB_UUID = '11111111-1111-4111-8111-111111111111';

describe('run outcome detection', () => {
  it('raises one event for a failed run and none for a replay', async () => {
    const { instanceId } = await seedInstance(db);
    await seedJob(db, instanceId, JOB_UUID, 'Nightly Backup');
    const channelId = await seedChannel();
    await seedRule(channelId);

    const rows = [historyRow({ instanceId: 100, jobUuid: JOB_UUID, runStatus: 0 })];

    const first = await ingestHistory(db, instanceId, rows);
    await service.onRunsIngested(instanceId, first.newRuns);

    // Exactly what the worker does after a reconnect: the same batch again.
    const replay = await ingestHistory(db, instanceId, rows);
    await service.onRunsIngested(instanceId, replay.newRuns);

    expect(replay.newRuns).toHaveLength(0);

    const events = await db.select().from(notificationEvents);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('job.failed');

    const deliveries = await db.select().from(notificationDeliveries);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.state).toBe('pending');
  });

  it('counts consecutive failures so a streak reads differently from a blip', async () => {
    const { instanceId } = await seedInstance(db);
    await seedJob(db, instanceId, JOB_UUID, 'Nightly Backup');
    await seedRule(await seedChannel());

    for (const [index, id] of [100, 101, 102].entries()) {
      const result = await ingestHistory(db, instanceId, [
        historyRow({ instanceId: id, jobUuid: JOB_UUID, runStatus: 0, seconds: index * 3600 }),
      ]);
      await service.onRunsIngested(instanceId, result.newRuns);
    }

    const events = await db
      .select()
      .from(notificationEvents)
      .where(eq(notificationEvents.kind, 'job.failed'));

    const streaks = events
      .map((e) => e.payload.consecutiveFailures)
      .sort((a, b) => Number(a) - Number(b));
    expect(streaks).toEqual([1, 2, 3]);
  });

  it('raises a recovery only when a success follows a failure', async () => {
    const { instanceId } = await seedInstance(db);
    await seedJob(db, instanceId, JOB_UUID, 'Nightly Backup');
    await seedRule(await seedChannel());

    const fail = await ingestHistory(db, instanceId, [
      historyRow({ instanceId: 100, jobUuid: JOB_UUID, runStatus: 0 }),
    ]);
    await service.onRunsIngested(instanceId, fail.newRuns);

    const ok = await ingestHistory(db, instanceId, [
      historyRow({ instanceId: 101, jobUuid: JOB_UUID, runStatus: 1, seconds: 3600 }),
    ]);
    await service.onRunsIngested(instanceId, ok.newRuns);

    const again = await ingestHistory(db, instanceId, [
      historyRow({ instanceId: 102, jobUuid: JOB_UUID, runStatus: 1, seconds: 7200 }),
    ]);
    await service.onRunsIngested(instanceId, again.newRuns);

    const kinds = (await db.select().from(notificationEvents)).map((e) => e.kind);
    expect(kinds.filter((k) => k === 'job.recovered')).toHaveLength(1);
    // Two successes were recorded, but only the first counts as a recovery.
    expect(kinds.filter((k) => k === 'job.succeeded')).toHaveLength(2);
  });

  it('does not queue a delivery for an event no rule subscribes to', async () => {
    const { instanceId } = await seedInstance(db);
    await seedJob(db, instanceId, JOB_UUID, 'Nightly Backup');
    const channelId = await seedChannel();
    await seedRule(channelId, { events: ['worker.offline'] });

    const result = await ingestHistory(db, instanceId, [
      historyRow({ instanceId: 100, jobUuid: JOB_UUID, runStatus: 0 }),
    ]);
    await service.onRunsIngested(instanceId, result.newRuns);

    // The event is still recorded — the record is not conditional on anyone
    // being subscribed — but nothing is queued.
    expect(await db.select().from(notificationEvents)).toHaveLength(1);
    expect(await db.select().from(notificationDeliveries)).toHaveLength(0);
  });
});

describe('rule scoping', () => {
  it('ignores instances outside the rule scope', async () => {
    const a = await seedInstance(db, 'HOST-A');
    const b = await seedInstance(db, 'HOST-B');
    await seedJob(db, a.instanceId, JOB_UUID, 'Nightly Backup');
    await seedJob(db, b.instanceId, JOB_UUID, 'Nightly Backup');

    const channelId = await seedChannel();
    await seedRule(channelId, { instanceIds: [a.instanceId] });

    for (const instanceId of [a.instanceId, b.instanceId]) {
      const result = await ingestHistory(db, instanceId, [
        historyRow({ instanceId: 100, jobUuid: JOB_UUID, runStatus: 0 }),
      ]);
      await service.onRunsIngested(instanceId, result.newRuns);
    }

    const deliveries = await db.select().from(notificationDeliveries);
    expect(deliveries).toHaveLength(1);

    const [event] = await db
      .select()
      .from(notificationEvents)
      .where(eq(notificationEvents.id, deliveries[0]!.eventId));
    expect(event!.instanceId).toBe(a.instanceId);
  });

  it('filters on the job name', async () => {
    const { instanceId } = await seedInstance(db);
    const other = '22222222-2222-4222-8222-222222222222';
    await seedJob(db, instanceId, JOB_UUID, 'Nightly Backup');
    await seedJob(db, instanceId, other, 'Cleanup temp tables');

    await seedRule(await seedChannel(), { jobNameContains: 'backup' });

    for (const [index, jobUuid] of [JOB_UUID, other].entries()) {
      const result = await ingestHistory(db, instanceId, [
        historyRow({ instanceId: 100 + index, jobUuid, runStatus: 0 }),
      ]);
      await service.onRunsIngested(instanceId, result.newRuns);
    }

    expect(await db.select().from(notificationEvents)).toHaveLength(2);
    // Case-insensitive: "backup" matches "Nightly Backup".
    expect(await db.select().from(notificationDeliveries)).toHaveLength(1);
  });

  it('lets the shortest throttle window win when rules disagree', async () => {
    const { instanceId } = await seedInstance(db);
    await seedJob(db, instanceId, JOB_UUID, 'Flapping job');
    const channelId = await seedChannel();
    await seedRule(channelId, { name: 'everything', throttleMinutes: 0 });
    await seedRule(channelId, { name: 'quiet', throttleMinutes: 60 });

    const first = await ingestHistory(db, instanceId, [
      historyRow({ instanceId: 100, jobUuid: JOB_UUID, runStatus: 0 }),
    ]);
    await service.onRunsIngested(instanceId, first.newRuns);
    await db
      .update(notificationDeliveries)
      .set({ state: 'sent', sentAt: new Date() })
      .where(eq(notificationDeliveries.channelId, channelId));

    const second = await ingestHistory(db, instanceId, [
      historyRow({ instanceId: 101, jobUuid: JOB_UUID, runStatus: 0, seconds: 60 }),
    ]);
    await service.onRunsIngested(instanceId, second.newRuns);

    // A rule set to zero means "send me all of these". An unrelated chattier
    // rule must not silently mute it — that is a surprise in the direction of
    // missing an incident.
    const pending = (await db.select().from(notificationDeliveries)).filter(
      (d) => d.state === 'pending',
    );
    expect(pending).toHaveLength(1);
  });

  it('sends one delivery when two rules name the same channel', async () => {
    const { instanceId } = await seedInstance(db);
    await seedJob(db, instanceId, JOB_UUID, 'Nightly Backup');
    const channelId = await seedChannel();
    await seedRule(channelId, { name: 'rule-one' });
    await seedRule(channelId, { name: 'rule-two' });

    const result = await ingestHistory(db, instanceId, [
      historyRow({ instanceId: 100, jobUuid: JOB_UUID, runStatus: 0 }),
    ]);
    await service.onRunsIngested(instanceId, result.newRuns);

    expect(await db.select().from(notificationDeliveries)).toHaveLength(1);
  });
});

describe('throttling', () => {
  it('suppresses a repeat inside the window and records why', async () => {
    const { instanceId } = await seedInstance(db);
    await seedJob(db, instanceId, JOB_UUID, 'Flapping job');
    const channelId = await seedChannel();
    await seedRule(channelId, { throttleMinutes: 60 });

    const first = await ingestHistory(db, instanceId, [
      historyRow({ instanceId: 100, jobUuid: JOB_UUID, runStatus: 0 }),
    ]);
    await service.onRunsIngested(instanceId, first.newRuns);

    // Mark the first delivery as sent, which is what starts the window.
    await db
      .update(notificationDeliveries)
      .set({ state: 'sent', sentAt: new Date() })
      .where(eq(notificationDeliveries.channelId, channelId));

    const second = await ingestHistory(db, instanceId, [
      historyRow({ instanceId: 101, jobUuid: JOB_UUID, runStatus: 0, seconds: 300 }),
    ]);
    await service.onRunsIngested(instanceId, second.newRuns);

    const deliveries = await db.select().from(notificationDeliveries);
    const suppressed = deliveries.filter((d) => d.state === 'suppressed');
    expect(suppressed).toHaveLength(1);
    // The record says a decision was made, so silence is distinguishable from
    // a broken pipeline.
    expect(suppressed[0]!.lastError).toContain('Throttled');
  });

  it('does not throttle a different job on the same channel', async () => {
    const { instanceId } = await seedInstance(db);
    const other = '22222222-2222-4222-8222-222222222222';
    await seedJob(db, instanceId, JOB_UUID, 'Job A');
    await seedJob(db, instanceId, other, 'Job B');
    const channelId = await seedChannel();
    await seedRule(channelId, { throttleMinutes: 60 });

    const first = await ingestHistory(db, instanceId, [
      historyRow({ instanceId: 100, jobUuid: JOB_UUID, runStatus: 0 }),
    ]);
    await service.onRunsIngested(instanceId, first.newRuns);
    await db
      .update(notificationDeliveries)
      .set({ state: 'sent', sentAt: new Date() })
      .where(eq(notificationDeliveries.channelId, channelId));

    const second = await ingestHistory(db, instanceId, [
      historyRow({ instanceId: 101, jobUuid: other, runStatus: 0, seconds: 60 }),
    ]);
    await service.onRunsIngested(instanceId, second.newRuns);

    const pending = (await db.select().from(notificationDeliveries)).filter(
      (d) => d.state === 'pending',
    );
    expect(pending).toHaveLength(1);
  });
});

describe('rendering', () => {
  it('names the job and links to it', () => {
    const rendered = renderNotification(
      {
        kind: 'job.failed',
        occurredAt: new Date('2026-07-29T02:00:00Z'),
        payload: {
          jobName: 'Nightly Backup',
          instanceName: 'MSSQLSERVER',
          hostName: 'sqlprod01',
          instanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          jobUuid: JOB_UUID,
          consecutiveFailures: 3,
          runDurationSeconds: 95,
        },
      },
      'https://rsagent.example.com/',
    );

    expect(rendered.severity).toBe('critical');
    expect(rendered.title).toBe('Job failed: Nightly Backup');
    expect(rendered.summary).toContain('failed 3 runs in a row');
    expect(rendered.facts).toContainEqual({ label: 'Ran for', value: '00:01:35' });
    // The trailing slash on the public URL must not double up.
    expect(rendered.url).toBe(
      `https://rsagent.example.com/instances/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/jobs/${JOB_UUID}`,
    );
  });

  it('says there is no baseline rather than inventing one', () => {
    const rendered = renderNotification(
      {
        kind: 'job.long_running',
        occurredAt: new Date(),
        payload: { jobName: 'Reindex', hostName: 'sqlprod01', elapsedSeconds: 7200 },
      },
      'https://rsagent.example.com',
    );
    expect(rendered.summary).toContain('02:00:00');
    expect(rendered.facts).toContainEqual({ label: 'Usually takes', value: 'no baseline yet' });
  });
});
