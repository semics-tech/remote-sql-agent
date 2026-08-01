import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { loadWorkerConfig } from '../src/config.js';
import { ControlPlaneSession } from '../src/session.js';

/**
 * The worker must never be alive, reporting healthy, and monitoring nothing.
 *
 * That is not a hypothetical combination — it was reachable three separate
 * ways, and in every one of them the health file kept being written on schedule
 * while the process watched nothing at all. A product whose entire value is
 * "you can see every server at once" fails silently when this happens, so the
 * cases are pinned individually.
 */

const dir = mkdtempSync(join(tmpdir(), 'rsagent-liveness-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function configWith(yaml: string) {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(path, yaml);
  return loadWorkerConfig(path);
}

describe('a connect attempt that throws outside the credential block', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('schedules a reconnect instead of leaving an unhandled rejection', async () => {
    // A typo'd caCertPath: `readFileSync` throws ENOENT out of
    // `buildChannelCredentials`, which sits *outside* the try/catch that only
    // ever wrapped `buildCallMetadata`. `#connect()` was `void
    // this.#connectAsync()`, so the rejection was unhandled, the reconnect was
    // never scheduled, and the process neither retried nor exited — a worker
    // that runs forever doing nothing.
    // The key file has to be real. Without it `buildCallMetadata` throws first,
    // and that path *was* already caught — so the test would pass against the
    // unfixed code and prove nothing. The failure has to come from the CA path,
    // which is the part that sat outside the try.
    const keyFile = join(dir, 'worker.key');
    writeFileSync(keyFile, 'rsak_0123456789abcdef\n');

    const config = configWith(
      [
        'controlPlane:',
        '  address: cp.example.test:8443',
        '  tls:',
        '    enabled: true',
        `    caCertPath: ${join(dir, 'does-not-exist.crt')}`,
        '  auth:',
        '    mode: token',
        `    keyFile: ${keyFile}`,
      ].join('\n'),
    );

    const warnings: string[] = [];
    const logger = pino(
      { level: 'trace' },
      { write: (line: string) => warnings.push(line) },
    );

    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => rejections.push(err);
    process.on('unhandledRejection', onRejection);

    const session = new ControlPlaneSession(
      config,
      logger,
      { onReady: () => undefined, onMessage: () => undefined, onDisconnect: () => undefined },
      () => ({ msg: undefined }),
    );

    try {
      session.start();
      // Let the rejected promise settle and the handler run.
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      expect(rejections).toEqual([]);
      // "Disconnected from control plane" is emitted by #scheduleReconnect, so
      // seeing it is the proof that the retry path was actually reached.
      expect(warnings.join('\n')).toMatch(/Disconnected from control plane/u);
    } finally {
      session.stop();
      process.off('unhandledRejection', onRejection);
    }
  });
});

describe('an instance that will not connect on first attempt', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.doUnmock('../src/instance-monitor.js');
  });

  it('is retried rather than dropped for the life of the process', async () => {
    // The case that bites on every Windows reboot: the service starts before
    // msdb is accepting connections. `#ensure` returned an outcome without
    // inserting an entry and `addLocal`'s outcomes are discarded by the caller,
    // so the instance was gone until somebody restarted the worker — while it
    // reported zero instances and kept touching its health file.
    let attempts = 0;
    const startPolling = vi.fn();

    vi.doMock('../src/instance-monitor.js', () => ({
      InstanceMonitor: class {
        readonly instanceName = 'MSSQLSERVER';
        readonly connectionPool = {};
        identity = null;
        writeMode = null;
        connect = vi.fn(() => {
          attempts += 1;
          return attempts === 1
            ? Promise.reject(new Error('ECONNREFUSED'))
            : Promise.resolve();
        });
        refreshIdentity = vi.fn(() => Promise.resolve());
        sendSnapshot = vi.fn(() => Promise.resolve());
        startPolling = startPolling;
        close = vi.fn(() => Promise.resolve());
      },
    }));

    const { MonitorSet } = await import('../src/monitor-set.js');
    const set = new MonitorSet({
      outbox: {} as never,
      logger: pino({ level: 'silent' }),
      emit: () => true,
      credentialKey: {} as never,
    });

    try {
      const outcomes = await set.addLocal([
        {
          name: 'MSSQLSERVER',
          server: 'localhost',
          auth: { mode: 'integrated' },
          encrypt: true,
          trustServerCertificate: true,
        } as never,
      ]);

      expect(outcomes[0]!.status).not.toBe('connected');
      expect(set.size).toBe(0);
      // Still known about, and still being chased.
      expect(set.awaitingFirstConnect).toEqual(['MSSQLSERVER']);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(attempts).toBe(2);
      expect(set.size).toBe(1);
      expect(set.awaitingFirstConnect).toEqual([]);
    } finally {
      await set.closeAll();
    }
  });
});
