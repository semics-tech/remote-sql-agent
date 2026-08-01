import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type * as ProtocolModule from '@remote-sql-agent/protocol';
import type * as CredentialsModule from '../src/credentials.js';

/**
 * A reconnect can replace `this.#stream` with a new, live stream while the
 * old one — abandoned, but still a live EventEmitter — has an 'error' or
 * 'end' event still queued. grpc-js does not guarantee that a stream's
 * events all land before the next one starts, so a slow-arriving event from
 * the *previous* stream must not be allowed to tear down the *new* session.
 * Before this fix, `#handleDisconnect` had no way to tell which stream an
 * event came from and reacted to it regardless.
 */

class FakeStream extends EventEmitter {
  written: unknown[] = [];
  write(msg: unknown): boolean {
    this.written.push(msg);
    return true;
  }
  end(): void {}
}

const sessionCalls: FakeStream[] = [];
const fakeClose = vi.fn();

vi.mock('@remote-sql-agent/protocol', async (importOriginal) => {
  const actual = await importOriginal<typeof ProtocolModule>();
  return {
    ...actual,
    WorkerHubClient: class {
      session(): FakeStream {
        const stream = new FakeStream();
        sessionCalls.push(stream);
        return stream;
      }
      close = fakeClose;
    },
  };
});

vi.mock('../src/credentials.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CredentialsModule>();
  return {
    ...actual,
    buildCallMetadata: vi.fn(async () => ({}) as never),
    buildChannelCredentials: vi.fn(() => ({}) as never),
  };
});

const { ControlPlaneSession } = await import('../src/session.js');
const { loadWorkerConfig } = await import('../src/config.js');

const logger = pino({ level: 'silent' });
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rsagent-session-'));
  sessionCalls.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function config() {
  const path = join(dir, 'worker.yaml');
  writeFileSync(path, 'controlPlane:\n  address: localhost:8443\n  tls:\n    enabled: false\n');
  return loadWorkerConfig(path);
}

function helloAck(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    msg: {
      $case: 'helloAck' as const,
      helloAck: {
        workerId: 'w1',
        capabilities: ['observe'],
        config: undefined,
        serverVersion: '0.2.0',
        commandSigningPublicKey: '',
        ...overrides,
      },
    },
  };
}

describe('a stale stream cannot tear down the session that replaced it', () => {
  it('ignores a late error from an abandoned stream once a new one is live', async () => {
    const onDisconnect = vi.fn();
    const session = new ControlPlaneSession(
      config(),
      logger,
      { onReady: vi.fn(), onMessage: vi.fn(), onDisconnect },
      () => ({
        msg: {
          $case: 'hello',
          hello: {
            hostName: 'h',
            workerVersion: '0.2.0',
            maxCapability: 'readOnly',
            instances: [],
            credentialPublicKey: '',
          },
        },
      }),
    );

    session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionCalls).toHaveLength(1);
    const stream1 = sessionCalls[0]!;
    stream1.emit('data', helloAck());
    expect(session.connected).toBe(true);

    // stream1 breaks; a reconnect is scheduled.
    stream1.emit('error', new Error('connection reset'));
    expect(session.connected).toBe(false);
    expect(onDisconnect).toHaveBeenCalledTimes(1);

    // Let the backoff timer fire and the reconnect create stream2.
    await vi.runOnlyPendingTimersAsync();
    expect(sessionCalls).toHaveLength(2);
    const stream2 = sessionCalls[1]!;
    stream2.emit('data', helloAck());
    expect(session.connected).toBe(true);

    // stream1's error already fired once above; simulate its trailing 'end'
    // arriving late, after stream2 is the live session.
    stream1.emit('end');

    expect(session.connected).toBe(true);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });
});
