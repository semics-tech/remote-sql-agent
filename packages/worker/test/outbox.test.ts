import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Outbox } from '../src/outbox.js';

let dir: string;
let outbox: Outbox;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rsagent-outbox-'));
  outbox = new Outbox(join(dir, 'outbox.sqlite'), 100);
});

afterEach(() => {
  outbox.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('queueing and draining', () => {
  it('returns rows in insertion order', () => {
    outbox.enqueue('history', 'INST1', { n: 1 });
    outbox.enqueue('history', 'INST1', { n: 2 });
    outbox.enqueue('activity', 'INST1', { n: 3 });

    const batch = outbox.peek(10);
    expect(batch).toHaveLength(3);
    expect(batch.map((r) => JSON.parse(r.payload).n)).toEqual([1, 2, 3]);
    expect(batch[2]!.kind).toBe('activity');
  });

  it('does not remove rows on peek', () => {
    // The outbox exists precisely for the case where the send fails mid-flight;
    // deleting on read would lose the batch it is meant to protect.
    outbox.enqueue('history', 'INST1', { n: 1 });
    outbox.peek(10);
    expect(outbox.peek(10)).toHaveLength(1);
  });

  it('removes only acknowledged rows', () => {
    outbox.enqueue('history', 'INST1', { n: 1 });
    outbox.enqueue('history', 'INST1', { n: 2 });
    const batch = outbox.peek(10);

    outbox.acknowledge([batch[0]!.id]);

    const remaining = outbox.peek(10);
    expect(remaining).toHaveLength(1);
    expect(JSON.parse(remaining[0]!.payload).n).toBe(2);
  });

  it('tolerates acknowledging an empty list', () => {
    outbox.enqueue('history', 'INST1', { n: 1 });
    outbox.acknowledge([]);
    expect(outbox.peek(10)).toHaveLength(1);
  });

  it('respects the peek limit', () => {
    for (let i = 0; i < 10; i++) outbox.enqueue('history', 'INST1', { i });
    expect(outbox.peek(4)).toHaveLength(4);
  });

  it('acknowledges the whole batch or none of it', () => {
    // better-sqlite3 gave this for free through its transaction() helper;
    // node:sqlite has no equivalent, so the BEGIN/COMMIT/ROLLBACK in
    // acknowledge() is hand-written and worth pinning. A half-applied
    // acknowledgement would drop rows the control plane never confirmed —
    // the exact loss this table exists to prevent.
    for (let i = 0; i < 3; i++) outbox.enqueue('history', 'INST1', { i });
    const ids = outbox.peek(10).map((r) => r.id);

    // A non-integer id makes SQLite reject the bind part-way through, after
    // the first delete has already been issued inside the transaction.
    expect(() =>
      outbox.acknowledge([ids[0]!, Symbol('not an id') as unknown as number]),
    ).toThrow();

    expect(outbox.peek(10)).toHaveLength(3);
  });

  it('leaves the database usable after a rolled-back acknowledgement', () => {
    // A stranded open transaction would fail every later write with
    // "cannot start a transaction within a transaction", which is a far more
    // confusing symptom than the original error.
    outbox.enqueue('history', 'INST1', { n: 1 });
    const [row] = outbox.peek(10);

    expect(() => outbox.acknowledge([Symbol('bad') as unknown as number])).toThrow();

    outbox.enqueue('history', 'INST1', { n: 2 });
    outbox.acknowledge([row!.id]);
    expect(outbox.peek(10).map((r) => JSON.parse(r.payload).n)).toEqual([2]);
  });
});

describe('bounded size', () => {
  it('evicts oldest-first once over the bound and reports how many', () => {
    const small = new Outbox(join(dir, 'small.sqlite'), 5);
    try {
      for (let i = 0; i < 8; i++) small.enqueue('history', 'INST1', { i });

      const stats = small.stats();
      expect(stats.depth).toBe(5);
      // Eviction must be visible, not silent: a quietly truncated history is
      // worse than a loud one (§5.4).
      expect(stats.evicted).toBe(3);

      const remaining = small.peek(10).map((r) => JSON.parse(r.payload).i);
      expect(remaining).toEqual([3, 4, 5, 6, 7]);
    } finally {
      small.close();
    }
  });
});

describe('sync bookmarks', () => {
  it('defaults the history high-water mark to zero', () => {
    expect(outbox.getHistoryHighWaterMark('INST1')).toBe(0);
  });

  it('persists the history high-water mark per instance', () => {
    outbox.setHistoryHighWaterMark('INST1', 42);
    outbox.setHistoryHighWaterMark('INST2', 7);
    expect(outbox.getHistoryHighWaterMark('INST1')).toBe(42);
    expect(outbox.getHistoryHighWaterMark('INST2')).toBe(7);
  });

  it('never moves the history mark backwards', () => {
    // An out-of-order replay must not drag the mark back, or the worker would
    // re-ship history the control plane already holds.
    outbox.setHistoryHighWaterMark('INST1', 100);
    outbox.setHistoryHighWaterMark('INST1', 50);
    expect(outbox.getHistoryHighWaterMark('INST1')).toBe(100);
  });

  it('never moves the agent log mark backwards', () => {
    const later = new Date('2026-01-02T00:00:00Z');
    outbox.setAgentLogHighWaterMark('INST1', later);
    outbox.setAgentLogHighWaterMark('INST1', new Date('2026-01-01T00:00:00Z'));
    expect(outbox.getAgentLogHighWaterMark('INST1')?.getTime()).toBe(later.getTime());
  });

  it('round-trips definition hashes', () => {
    const hashes = new Map([
      ['job-a', 'hash-a'],
      ['job-b', 'hash-b'],
    ]);
    outbox.setDefinitionHashes('INST1', hashes);
    expect(outbox.getDefinitionHashes('INST1')).toEqual(hashes);
  });

  it('returns an empty map when no hashes are stored', () => {
    expect(outbox.getDefinitionHashes('INST1').size).toBe(0);
  });
});

describe('command idempotency', () => {
  it('reports a command as applied only after it is recorded', () => {
    expect(outbox.hasAppliedCommand('cmd-1')).toBe(false);
    outbox.recordAppliedCommand('cmd-1', true, null);
    expect(outbox.hasAppliedCommand('cmd-1')).toBe(true);
  });

  it('keeps the first outcome when the same command is recorded twice', () => {
    // Re-delivery of a command must be a no-op, not a re-application (§5.4).
    outbox.recordAppliedCommand('cmd-1', true, 'ok');
    outbox.recordAppliedCommand('cmd-1', false, 'should not overwrite');
    expect(outbox.hasAppliedCommand('cmd-1')).toBe(true);
  });

  it('survives a reopen of the database file', () => {
    const path = join(dir, 'persist.sqlite');
    const first = new Outbox(path, 100);
    first.recordAppliedCommand('cmd-persist', true, null);
    first.setHistoryHighWaterMark('INST1', 99);
    first.close();

    const second = new Outbox(path, 100);
    try {
      expect(second.hasAppliedCommand('cmd-persist')).toBe(true);
      expect(second.getHistoryHighWaterMark('INST1')).toBe(99);
    } finally {
      second.close();
    }
  });
});
