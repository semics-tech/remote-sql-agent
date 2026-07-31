import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadWorkerConfig } from '../src/config.js';

/**
 * What a nested block falls back to when worker.yaml omits it.
 *
 * This is the common case, not an edge one: an enrolled worker gets a
 * worker.yaml with little more than `controlPlane.address` in it, so almost
 * every value below is arrived at by omission on a real host.
 *
 * Worth pinning because zod 4 changed how these blocks get their values.
 * `.default(v)` hands back `v` untouched, so it has to spell out every field;
 * `.prefault(v)` parses `v` through the schema, so the field defaults above
 * are the only place a number appears. The schema uses `.prefault({})`.
 *
 * TypeScript already rejects a `.default()` that is missing a field, so the
 * gap this covers is the one it cannot see: a restated default with the
 * wrong *value* in it. These numbers are the poll intervals and reconnect
 * backoff every enrolled worker runs on, and nothing else asserts them.
 */
describe('worker config defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rsagent-config-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function load(yaml: string) {
    const path = join(dir, `${Math.random().toString(36).slice(2)}.yaml`);
    writeFileSync(path, yaml);
    return loadWorkerConfig(path);
  }

  const minimal = 'controlPlane:\n  address: cp.example.test:8443\n';

  it('fills in every nested block a minimal file leaves out', () => {
    const config = load(minimal);

    expect(config.controlPlane.auth.mode).toBe('token');
    expect(config.controlPlane.tls.enabled).toBe(true);
    expect(config.controlPlane.reconnect).toEqual({
      initialDelayMs: 1_000,
      maxDelayMs: 60_000,
      jitterRatio: 0.3,
    });
    expect(config.outbox).toEqual({ path: './run/outbox.sqlite', maxRows: 100_000 });
    expect(config.polling).toEqual({
      definitionSeconds: 30,
      historySeconds: 10,
      activitySeconds: 10,
      agentLogSeconds: 60,
      heartbeatSeconds: 30,
      historyBatchSize: 500,
    });
  });

  it('defaults maxCapability to the lowest tier, not the highest', () => {
    // The one default here that is a security boundary: a worker that arrives
    // without an explicit ceiling must observe and nothing else.
    expect(load(minimal).maxCapability).toBe('readOnly');
    expect(load(minimal).instances).toEqual([]);
  });

  it('keeps the other fields in a block that is only partly specified', () => {
    // Naming one field must not blank its siblings.
    const config = load(
      'controlPlane:\n' +
        '  address: cp.example.test:8443\n' +
        '  reconnect:\n' +
        '    maxDelayMs: 5000\n',
    );

    expect(config.controlPlane.reconnect.maxDelayMs).toBe(5_000);
    expect(config.controlPlane.reconnect.initialDelayMs).toBe(1_000);
    expect(config.controlPlane.reconnect.jitterRatio).toBe(0.3);
  });

  it('lets an explicit value win over the default', () => {
    const config = load(
      'controlPlane:\n' +
        '  address: cp.example.test:8443\n' +
        '  tls:\n' +
        '    enabled: false\n' +
        'maxCapability: full\n',
    );

    expect(config.controlPlane.tls.enabled).toBe(false);
    expect(config.maxCapability).toBe('full');
  });
});
