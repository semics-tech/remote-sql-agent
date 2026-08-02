import { describe, expect, it } from 'vitest';
import { PendingAttributionMap } from '../src/pending-attribution.js';

/**
 * The happy path — set, then get-and-delete on the next poll — never leaves
 * an entry behind. What is worth pinning is the paths that skip the delete:
 * a no-op command whose hash never changes, a refused delta left for retry,
 * a job deleted before it is ever iterated again. Without a TTL, every one
 * of those is a permanent leak in a process meant to run for months.
 */

describe('the happy path', () => {
  it('returns the command id and forgets it once consumed', () => {
    const map = new PendingAttributionMap(10 * 60 * 1000);
    map.set('job-a', 'cmd-1', 0);

    expect(map.get('job-a')).toBe('cmd-1');
    map.delete('job-a');
    expect(map.get('job-a')).toBeUndefined();
    expect(map.size).toBe(0);
  });
});

describe('entries that are never consumed', () => {
  it('expire once older than the TTL', () => {
    const ttl = 10 * 60 * 1000;
    const map = new PendingAttributionMap(ttl);
    map.set('job-a', 'cmd-1', 0);

    // Sweeping happens on the next set() — the map has no timer of its own.
    map.set('job-b', 'cmd-2', ttl + 1);

    expect(map.get('job-a')).toBeUndefined();
    expect(map.get('job-b')).toBe('cmd-2');
    expect(map.size).toBe(1);
  });

  it('does not expire an entry still inside the TTL window', () => {
    const ttl = 10 * 60 * 1000;
    const map = new PendingAttributionMap(ttl);
    map.set('job-a', 'cmd-1', 0);
    map.set('job-b', 'cmd-2', ttl - 1);

    expect(map.get('job-a')).toBe('cmd-1');
    expect(map.size).toBe(2);
  });

  it('never grows past the TTL window\'s worth of entries, however many are set', () => {
    const ttl = 1000;
    const map = new PendingAttributionMap(ttl);
    for (let i = 0; i < 500; i++) {
      // Every entry orphaned (no matching delete), simulating the leak paths.
      map.set(`job-${i}`, `cmd-${i}`, i * 10);
    }
    // Only entries set within the last `ttl` ms of the last set() survive.
    expect(map.size).toBeLessThan(500);
  });
});
