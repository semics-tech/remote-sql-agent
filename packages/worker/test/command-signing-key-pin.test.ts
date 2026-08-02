import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { generateCommandSigningKeyPair, signingKeyFingerprint } from '@remote-sql-agent/protocol';
import type * as ProtocolModule from '@remote-sql-agent/protocol';
import type * as CredentialsModule from '../src/credentials.js';

/**
 * A pinned `commandSigningKeyFingerprint` is what makes the per-command
 * signature actually defend against a TLS-terminating proxy substituting its
 * own key (see the field comment in config.ts and the exploit scenario in
 * docs/security-audit.md). Without a test, nothing stops the tear-down branch
 * in session.ts's `helloAck` handler from silently regressing into "log a
 * warning and continue" the next time that code is touched.
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

const pinnedKeyPair = generateCommandSigningKeyPair();
const pinnedFingerprint = signingKeyFingerprint(pinnedKeyPair.publicKeyPem);
const otherKeyPair = generateCommandSigningKeyPair();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rsagent-session-pin-'));
  sessionCalls.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function config(fingerprint: string) {
  const path = join(dir, 'worker.yaml');
  writeFileSync(
    path,
    [
      'controlPlane:',
      '  address: localhost:8443',
      '  tls:',
      '    enabled: false',
      `  commandSigningKeyFingerprint: ${fingerprint}`,
      '',
    ].join('\n'),
  );
  return loadWorkerConfig(path);
}

function helloAck(commandSigningPublicKey: string) {
  return {
    msg: {
      $case: 'helloAck' as const,
      helloAck: {
        workerId: 'w1',
        capabilities: ['observe'],
        config: undefined,
        serverVersion: '0.2.0',
        commandSigningPublicKey,
      },
    },
  };
}

function startSession(fingerprint: string, onDisconnect = vi.fn()) {
  const session = new ControlPlaneSession(
    config(fingerprint),
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
  return { session, onDisconnect };
}

describe('a pinned command signing key fingerprint', () => {
  it('refuses the session when HelloAck presents a key that does not match the pin', async () => {
    const { session, onDisconnect } = startSession(pinnedFingerprint);

    session.start();
    await vi.advanceTimersByTimeAsync(0);
    const stream = sessionCalls[0]!;

    // A proxy terminating TLS between here and the control plane could supply
    // this HelloAck with its own key instead of the pinned one.
    stream.emit('data', helloAck(otherKeyPair.publicKeyPem));

    expect(session.connected).toBe(false);
    expect(session.commandSigningPublicKey).toBe('');
    expect(onDisconnect).toHaveBeenCalledWith(
      expect.stringContaining('command signing key did not match the pin'),
    );
  });

  it('accepts the session when HelloAck presents exactly the pinned key', async () => {
    const { session, onDisconnect } = startSession(pinnedFingerprint);

    session.start();
    await vi.advanceTimersByTimeAsync(0);
    const stream = sessionCalls[0]!;

    stream.emit('data', helloAck(pinnedKeyPair.publicKeyPem));

    expect(session.connected).toBe(true);
    expect(session.commandSigningPublicKey).toBe(pinnedKeyPair.publicKeyPem);
    expect(onDisconnect).not.toHaveBeenCalled();
  });
});
