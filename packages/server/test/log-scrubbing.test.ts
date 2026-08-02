import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AgentLogRow, AgentLogScrubConfigInput } from '@remote-sql-agent/protocol';
import { toTimestamp } from '@remote-sql-agent/protocol';
import type { Database } from '../src/db/client.js';
import { applyScrubRules, getScrubConfig, setScrubConfig } from '../src/domain/log-scrubbing.js';
import { ingestAgentLog } from '../src/domain/ingest.js';
import { agentLogEntries } from '../src/db/schema.js';
import { setupTestDatabase, seedInstance, truncateAll } from './helpers/db.js';

/**
 * `applyScrubRules` is the enforcement point ahead of `ingestAgentLog` in
 * hub.ts — a row it drops never reaches `agentLogEntries`, so it can never
 * reach the dashboard or an export. Pure, so most of this needs no database;
 * `setScrubConfig`'s validation does, since it round-trips through the table.
 */

function row(overrides: Partial<AgentLogRow> = {}): AgentLogRow {
  return {
    loggedAt: undefined,
    severity: 'info',
    message: 'Job completed successfully.',
    processInfo: 'JOB OUTCOME',
    ...overrides,
  };
}

const ALL_SEVERITIES: AgentLogScrubConfigInput = { allowedSeverities: ['error', 'warning', 'info'], rules: [] };

describe('applyScrubRules — severity filtering', () => {
  it('keeps rows at an allowed severity and drops the rest', () => {
    const config: AgentLogScrubConfigInput = { allowedSeverities: ['error'], rules: [] };
    const rows = [row({ severity: 'error' }), row({ severity: 'warning' }), row({ severity: 'info' })];

    const result = applyScrubRules(config, rows);

    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]!.severity).toBe('error');
    expect(result.droppedCount).toBe(2);
    expect(result.redactedCount).toBe(0);
  });

  it('drops everything when nothing is allowed', () => {
    const config: AgentLogScrubConfigInput = { allowedSeverities: [], rules: [] };
    const result = applyScrubRules(config, [row(), row({ severity: 'error' })]);
    expect(result.kept).toHaveLength(0);
    expect(result.droppedCount).toBe(2);
  });

  it('drops a severity string it does not recognise, rather than passing it through', () => {
    const config: AgentLogScrubConfigInput = { allowedSeverities: ['error', 'warning', 'info'], rules: [] };
    const result = applyScrubRules(config, [row({ severity: 'debug' })]);
    expect(result.kept).toHaveLength(0);
    expect(result.droppedCount).toBe(1);
  });

  it('is a no-op with the default config', () => {
    const rows = [row({ severity: 'error' }), row({ severity: 'warning' }), row({ severity: 'info' })];
    const result = applyScrubRules(ALL_SEVERITIES, rows);
    expect(result.kept).toEqual(rows);
    expect(result.droppedCount).toBe(0);
  });
});

describe('applyScrubRules — redact rules', () => {
  it('replaces every match in message and processInfo, leaving other fields alone', () => {
    const config: AgentLogScrubConfigInput = {
      ...ALL_SEVERITIES,
      rules: [{ id: 'r1', description: 'connection strings', pattern: 'Password=[^;]+', action: 'redact' }],
    };
    const rows = [
      row({
        message: 'Connect failed: Password=hunter2;Server=x',
        processInfo: 'Password=hunter2',
      }),
    ];

    const result = applyScrubRules(config, rows);

    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]!.message).toBe('Connect failed: [redacted];Server=x');
    expect(result.kept[0]!.processInfo).toBe('[redacted]');
    expect(result.redactedCount).toBe(1);
    expect(result.droppedCount).toBe(0);
  });

  it('leaves a row untouched when no rule matches', () => {
    const config: AgentLogScrubConfigInput = {
      ...ALL_SEVERITIES,
      rules: [{ id: 'r1', description: '', pattern: 'nomatch', action: 'redact' }],
    };
    const original = row();
    const result = applyScrubRules(config, [original]);
    expect(result.kept[0]).toEqual(original);
    expect(result.redactedCount).toBe(0);
  });

  it('applies multiple rules to the same row', () => {
    const config: AgentLogScrubConfigInput = {
      ...ALL_SEVERITIES,
      rules: [
        { id: 'r1', description: '', pattern: 'foo', action: 'redact' },
        { id: 'r2', description: '', pattern: 'bar', action: 'redact' },
      ],
    };
    const result = applyScrubRules(config, [row({ message: 'foo and bar', processInfo: '' })]);
    expect(result.kept[0]!.message).toBe('[redacted] and [redacted]');
  });
});

describe('applyScrubRules — drop rules', () => {
  it('discards the whole row on a match, and does not apply later rules to it', () => {
    const config: AgentLogScrubConfigInput = {
      ...ALL_SEVERITIES,
      rules: [
        { id: 'r1', description: 'backup noise', pattern: 'backup', action: 'drop' },
        { id: 'r2', description: '', pattern: 'backup', action: 'redact' },
      ],
    };
    const kept = row({ message: 'Job completed', processInfo: '' });
    const dropped = row({ message: 'Backup started', processInfo: '' });

    const result = applyScrubRules(config, [kept, dropped]);

    expect(result.kept).toEqual([kept]);
    expect(result.droppedCount).toBe(1);
    expect(result.redactedCount).toBe(0);
  });

  it('matches case-insensitively and against processInfo too', () => {
    const config: AgentLogScrubConfigInput = {
      ...ALL_SEVERITIES,
      rules: [{ id: 'r1', description: '', pattern: 'SQLSERVERAGENT', action: 'drop' }],
    };
    const result = applyScrubRules(config, [row({ message: 'noise', processInfo: 'sqlserveragent' })]);
    expect(result.kept).toHaveLength(0);
  });
});

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await setupTestDatabase('log_scrubbing'));
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await truncateAll(db);
});

describe('setScrubConfig / getScrubConfig', () => {
  it('returns the default (unfiltered) config for a worker with no row', async () => {
    const { workerId } = await seedInstance(db);
    expect(await getScrubConfig(db, workerId)).toEqual(ALL_SEVERITIES);
  });

  it('stores and round-trips a config', async () => {
    const { workerId } = await seedInstance(db);
    const config: AgentLogScrubConfigInput = {
      allowedSeverities: ['error'],
      rules: [{ id: 'r1', description: 'noise', pattern: 'noise', action: 'drop' }],
    };

    await setScrubConfig(db, workerId, config, null);

    expect(await getScrubConfig(db, workerId)).toEqual(config);
  });

  it('rejects a rule whose pattern does not compile, and stores nothing', async () => {
    const { workerId } = await seedInstance(db);
    const config: AgentLogScrubConfigInput = {
      allowedSeverities: ['error'],
      rules: [{ id: 'r1', description: 'broken', pattern: '(unclosed', action: 'drop' }],
    };

    await expect(setScrubConfig(db, workerId, config, null)).rejects.toThrow();
    expect(await getScrubConfig(db, workerId)).toEqual(ALL_SEVERITIES);
  });

  it('rejects input failing schema validation', async () => {
    const { workerId } = await seedInstance(db);
    await expect(
      setScrubConfig(db, workerId, { allowedSeverities: ['critical'], rules: [] }, null),
    ).rejects.toThrow();
  });
});

describe('the gate hub.ts applies to an incoming AgentLogBatch', () => {
  it('a scrubbed row never reaches agent_log_entries, and an unconfigured worker is unaffected', async () => {
    const { workerId, instanceId } = await seedInstance(db);
    await setScrubConfig(
      db,
      workerId,
      { allowedSeverities: ['error', 'warning', 'info'], rules: [{ id: 'r1', description: '', pattern: 'backup', action: 'drop' }] },
      null,
    );

    const batch: AgentLogRow[] = [
      row({ message: 'Backup job started', loggedAt: toTimestamp(new Date('2026-08-01T02:00:00Z')) }),
      row({ message: 'Job completed successfully', loggedAt: toTimestamp(new Date('2026-08-01T02:01:00Z')) }),
    ];

    // Exactly what hub.ts's 'agentLog' case does: load the config, filter,
    // ingest only what survives.
    const config = await getScrubConfig(db, workerId);
    const { kept } = applyScrubRules(config, batch);
    await ingestAgentLog(db, instanceId, kept);

    const stored = await db.select().from(agentLogEntries).where(eq(agentLogEntries.instanceId, instanceId));
    expect(stored).toHaveLength(1);
    expect(stored[0]!.message).toBe('Job completed successfully');
  });
});
