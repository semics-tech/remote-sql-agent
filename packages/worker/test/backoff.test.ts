import { describe, expect, it } from 'vitest';
import { Backoff } from '../src/backoff.js';

describe('Backoff', () => {
  /** random() fixed at 0.5 makes the jitter term exactly zero. */
  const noJitter = () => 0.5;

  it('grows exponentially from the initial delay', () => {
    const b = new Backoff(1000, 60_000, 0.3, noJitter);
    expect([b.next(), b.next(), b.next(), b.next()]).toEqual([1000, 2000, 4000, 8000]);
  });

  it('caps at the maximum delay', () => {
    const b = new Backoff(1000, 5000, 0.3, noJitter);
    const delays = Array.from({ length: 8 }, () => b.next());
    expect(Math.max(...delays)).toBe(5000);
    expect(delays.at(-1)).toBe(5000);
  });

  it('resets to the initial delay after a successful connect', () => {
    const b = new Backoff(1000, 60_000, 0.3, noJitter);
    b.next();
    b.next();
    b.reset();
    expect(b.next()).toBe(1000);
  });

  it('applies jitter within the configured ratio', () => {
    // Jitter is what stops 50+ workers reconnecting in lockstep after a control
    // plane restart and knocking it straight back over.
    const low = new Backoff(1000, 60_000, 0.3, () => 0);
    const high = new Backoff(1000, 60_000, 0.3, () => 1);
    expect(low.next()).toBe(700);
    expect(high.next()).toBe(1300);
  });

  it('never returns a negative delay even with full negative jitter', () => {
    const b = new Backoff(1000, 60_000, 1, () => 0);
    expect(b.next()).toBeGreaterThanOrEqual(0);
  });

  it('produces a spread of delays across many workers at the same attempt', () => {
    const delays = new Set(
      Array.from({ length: 50 }, (_, i) => new Backoff(1000, 60_000, 0.3, () => i / 50).next()),
    );
    expect(delays.size).toBeGreaterThan(20);
  });

  it('tracks the attempt count', () => {
    const b = new Backoff(1000, 60_000, 0.3, noJitter);
    expect(b.attempt).toBe(0);
    b.next();
    b.next();
    expect(b.attempt).toBe(2);
    b.reset();
    expect(b.attempt).toBe(0);
  });
});
