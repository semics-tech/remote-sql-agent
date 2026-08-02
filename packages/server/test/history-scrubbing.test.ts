import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { HistoryRow, HistoryScrubConfigInput } from '@remote-sql-agent/protocol';
import { toTimestamp } from '@remote-sql-agent/protocol';
import type { Database } from '../src/db/client.js';
import {
  applyHistoryScrubRules,
  getHistoryScrubConfig,
  setHistoryScrubConfig,
} from '../src/domain/history-scrubbing.js';
import { ingestHistory } from '../src/domain/ingest.js';
import { jobHistory } from '../src/db/schema.js';
import { setupTestDatabase, seedInstance, truncateAll } from './helpers/db.js';

/**
 * `applyHistoryScrubRules` is the enforcement point ahead of `ingestHistory`
 * in hub.ts. Redact-only, on purpose: `runStatus`, `stepId` and timing here
 * feed failure-rate stats and "which step is this job on" derivation
 * elsewhere (domain/stats.ts, job-flow.ts), so a rule can never drop or
 * otherwise alter a row — only text inside `message` can change.
 */

let rowCounter = 0;

function row(overrides: Partial<HistoryRow> = {}): HistoryRow {
  rowCounter++;
  return {
    instanceId: rowCounter,
    jobUuid: '33333333-3333-4333-8333-333333333333',
    stepId: 1,
    stepName: 'Step 1',
    runStatus: 1,
    runDatetime: toTimestamp(new Date('2026-08-01T02:00:00Z')),
    runDurationSeconds: 10,
    message: 'Job step completed successfully.',
    retriesAttempted: 0,
    server: 'SQL01',
    sqlSeverity: 0,
    sqlMessageId: 0,
    ...overrides,
  };
}

const NO_RULES: HistoryScrubConfigInput = { rules: [] };

describe('applyHistoryScrubRules', () => {
  it('is a no-op with no rules configured', () => {
    const rows = [row(), row({ runStatus: 0 })];
    const result = applyHistoryScrubRules(NO_RULES, rows);
    expect(result.rows).toEqual(rows);
    expect(result.redactedCount).toBe(0);
  });

  it('redacts a match in message, leaving every other field untouched', () => {
    const rules: HistoryScrubConfigInput = {
      rules: [{ id: 'r1', description: 'connection strings', pattern: 'Password=[^;]+' }],
    };
    const original = row({ message: 'Connect failed: Password=hunter2;Server=x' });

    const result = applyHistoryScrubRules(rules, [original]);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.message).toBe('Connect failed: [redacted];Server=x');
    expect(result.redactedCount).toBe(1);
    // Everything else is the exact same row.
    expect(result.rows[0]!.runStatus).toBe(original.runStatus);
    expect(result.rows[0]!.stepId).toBe(original.stepId);
    expect(result.rows[0]!.runDurationSeconds).toBe(original.runDurationSeconds);
    expect(result.rows[0]!.instanceId).toBe(original.instanceId);
  });

  it('never drops a row, even when every rule matches', () => {
    const rules: HistoryScrubConfigInput = {
      rules: [{ id: 'r1', description: '', pattern: '.*' }],
    };
    const rows = [row(), row({ runStatus: 0 })];

    const result = applyHistoryScrubRules(rules, rows);

    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((r) => r.runStatus)).toEqual([1, 0]);
  });

  it('leaves a row untouched when no rule matches', () => {
    const rules: HistoryScrubConfigInput = { rules: [{ id: 'r1', description: '', pattern: 'nomatch' }] };
    const original = row();
    const result = applyHistoryScrubRules(rules, [original]);
    expect(result.rows[0]).toEqual(original);
    expect(result.redactedCount).toBe(0);
  });

  it('applies multiple rules to the same message', () => {
    const rules: HistoryScrubConfigInput = {
      rules: [
        { id: 'r1', description: '', pattern: 'foo' },
        { id: 'r2', description: '', pattern: 'bar' },
      ],
    };
    const result = applyHistoryScrubRules(rules, [row({ message: 'foo and bar' })]);
    expect(result.rows[0]!.message).toBe('[redacted] and [redacted]');
  });

  it('matches case-insensitively', () => {
    const rules: HistoryScrubConfigInput = { rules: [{ id: 'r1', description: '', pattern: 'SECRET' }] };
    const result = applyHistoryScrubRules(rules, [row({ message: 'the secret value' })]);
    expect(result.rows[0]!.message).toBe('the [redacted] value');
  });
});

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await setupTestDatabase('history_scrubbing'));
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await truncateAll(db);
});

describe('setHistoryScrubConfig / getHistoryScrubConfig', () => {
  it('returns the default (unfiltered) config for a worker with no row', async () => {
    const { workerId } = await seedInstance(db);
    expect(await getHistoryScrubConfig(db, workerId)).toEqual(NO_RULES);
  });

  it('stores and round-trips a config', async () => {
    const { workerId } = await seedInstance(db);
    const config: HistoryScrubConfigInput = {
      rules: [{ id: 'r1', description: 'noise', pattern: 'noise' }],
    };

    await setHistoryScrubConfig(db, workerId, config, null);

    expect(await getHistoryScrubConfig(db, workerId)).toEqual(config);
  });

  it('rejects a rule whose pattern does not compile, and stores nothing', async () => {
    const { workerId } = await seedInstance(db);
    const config: HistoryScrubConfigInput = {
      rules: [{ id: 'r1', description: 'broken', pattern: '(unclosed' }],
    };

    await expect(setHistoryScrubConfig(db, workerId, config, null)).rejects.toThrow();
    expect(await getHistoryScrubConfig(db, workerId)).toEqual(NO_RULES);
  });

  it('rejects input failing schema validation', async () => {
    const { workerId } = await seedInstance(db);
    await expect(
      setHistoryScrubConfig(db, workerId, { rules: [{ id: '', description: '', pattern: '' }] }, null),
    ).rejects.toThrow();
  });
});

describe('the gate hub.ts applies to an incoming HistoryBatch', () => {
  it('a redacted message is what lands in job_history, and run_status/step_id are unaffected', async () => {
    const { workerId, instanceId } = await seedInstance(db);
    await setHistoryScrubConfig(
      db,
      workerId,
      { rules: [{ id: 'r1', description: '', pattern: 'Password=[^;]+' }] },
      null,
    );

    const batch: HistoryRow[] = [
      row({ message: 'Connect failed: Password=hunter2;Server=x', runStatus: 0 }),
    ];

    // Exactly what hub.ts's 'history' case does: load the config, redact,
    // ingest — nothing is ever dropped.
    const config = await getHistoryScrubConfig(db, workerId);
    const { rows } = applyHistoryScrubRules(config, batch);
    await ingestHistory(db, instanceId, rows);

    const stored = await db.select().from(jobHistory).where(eq(jobHistory.instanceId, instanceId));
    expect(stored).toHaveLength(1);
    expect(stored[0]!.message).toBe('Connect failed: [redacted];Server=x');
    expect(stored[0]!.runStatus).toBe(0);
    expect(stored[0]!.stepId).toBe(1);
  });
});
