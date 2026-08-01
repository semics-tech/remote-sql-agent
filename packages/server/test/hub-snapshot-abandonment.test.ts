import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { sweepAbandonedSnapshots, type PendingSnapshot } from '../src/hub/hub.js';

/**
 * A chunked snapshot that stops arriving mid-way — worker crash, or an
 * instance detached while a chunk is in flight — must not sit in memory for
 * the life of the session. Every accumulated chunk holds full T-SQL step
 * bodies, which routinely contain connection strings (CLAUDE.md).
 */

const logger = pino({ level: 'silent' });

const SNAPSHOT_ABANDON_MS = 10 * 60 * 1000;

function pending(startedAt: number): PendingSnapshot {
  return { instanceName: 'HOST1', jobs: [], startedAt };
}

describe('sweepAbandonedSnapshots', () => {
  it('discards a snapshot that has sat incomplete past the abandon window', () => {
    const map = new Map<string, PendingSnapshot>([
      ['HOST1:abc', pending(Date.now() - SNAPSHOT_ABANDON_MS - 1)],
    ]);

    sweepAbandonedSnapshots(map, logger);

    expect(map.size).toBe(0);
  });

  it('leaves a snapshot that is still within the abandon window alone', () => {
    const map = new Map<string, PendingSnapshot>([['HOST1:abc', pending(Date.now() - 1000)]]);

    sweepAbandonedSnapshots(map, logger);

    expect(map.size).toBe(1);
  });

  it('sweeps only the entries that have aged out, keeping the rest', () => {
    const map = new Map<string, PendingSnapshot>([
      ['HOST1:old', pending(Date.now() - SNAPSHOT_ABANDON_MS - 1)],
      ['HOST1:fresh', pending(Date.now() - 1000)],
    ]);

    sweepAbandonedSnapshots(map, logger);

    expect([...map.keys()]).toEqual(['HOST1:fresh']);
  });
});
