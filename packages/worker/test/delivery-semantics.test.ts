import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type { Outbox } from '../src/outbox.js';

/**
 * What "sent" means, and what a redelivery reports.
 *
 * Both of these were wrong in the same direction: the worker believed something
 * had happened that had not. A message counted as undelivered when it had in
 * fact been queued, and a command counted as successful when it had in fact
 * failed. Neither produces an error anywhere — the estate just stops matching
 * what the dashboard says about it.
 */

const dir = mkdtempSync(join(tmpdir(), 'rsagent-delivery-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// Backpressure
// ---------------------------------------------------------------------------

/** A duplex stream whose `write()` return value the test controls. */
class FakeStream extends EventEmitter {
  writeReturns = true;
  written: unknown[] = [];
  write(message: unknown): boolean {
    this.written.push(message);
    return this.writeReturns;
  }
  end(): void {}
}

const stream = new FakeStream();

vi.mock('@remote-sql-agent/protocol', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    WorkerHubClient: class {
      session() {
        return stream;
      }
      close(): void {}
    },
  };
});

const { ControlPlaneSession } = await import('../src/session.js');
const { loadWorkerConfig } = await import('../src/config.js');

function connectedSession() {
  const keyFile = join(dir, 'worker.key');
  writeFileSync(keyFile, 'rsak_0123456789abcdef\n');
  const path = join(dir, `${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(
    path,
    [
      'controlPlane:',
      '  address: cp.example.test:8443',
      '  tls:',
      '    enabled: false',
      '  auth:',
      '    mode: token',
      `    keyFile: ${keyFile}`,
    ].join('\n'),
  );

  const session = new ControlPlaneSession(
    loadWorkerConfig(path),
    pino({ level: 'silent' }),
    { onReady: () => undefined, onMessage: () => undefined, onDisconnect: () => undefined },
    () => ({ msg: undefined }),
  );
  return session;
}

describe('a write the stream buffers rather than refuses', () => {
  beforeEach(() => {
    stream.writeReturns = true;
    stream.written = [];
    stream.removeAllListeners();
  });

  it('counts as sent, because it was', async () => {
    const session = connectedSession();
    session.start();
    await vi.waitFor(() => expect(stream.written.length).toBeGreaterThan(0));
    // HelloAck is what flips the session to connected.
    stream.emit('data', {
      msg: { $case: 'helloAck', helloAck: { capabilities: ['observe'], commandSigningPublicKey: '', workerId: 'w1' } },
    });
    expect(session.connected).toBe(true);

    // `write()` returning false is backpressure: the message *was* queued and
    // the boolean asks the caller to pause. Returning it verbatim meant every
    // message past the high water mark was delivered *and* outboxed — duplicates
    // on the control plane, and an outbox that grew without bound whenever the
    // pollers outran the link.
    stream.writeReturns = false;
    expect(session.send({ msg: undefined })).toBe(true);
    expect(session.backpressured).toBe(true);

    // And it clears when the stream drains, so the state cannot stick on.
    stream.emit('drain');
    expect(session.backpressured).toBe(false);

    session.stop();
  });

  it('still reports false when there is genuinely no stream', async () => {
    const session = connectedSession();
    // Never started: nothing to write to, and that is the one case where the
    // caller really does have to keep the payload.
    expect(session.send({ msg: undefined })).toBe(false);
    session.stop();
  });
});

// ---------------------------------------------------------------------------
// Redelivery
// ---------------------------------------------------------------------------

describe('a command that is delivered twice', () => {
  let outbox: Outbox;

  beforeEach(async () => {
    const { Outbox } = await import('../src/outbox.js');
    outbox = new Outbox(join(dir, `${Math.random().toString(36).slice(2)}.sqlite`), 1000);
  });

  afterEach(() => outbox.close());

  it('reports the outcome that was recorded, not a synthesised success', () => {
    outbox.recordAppliedCommand('failed-command', false, 'SqlError');
    outbox.recordAppliedCommand('ok-command', true, null);

    // The bug: the idempotency gate checked only that the id existed and
    // returned `success: true`. So a redelivered command that msdb had refused
    // came back green, and the only way to find out was to go and look at the
    // job.
    expect(outbox.appliedCommandOutcome('failed-command')).toEqual({
      success: false,
      result: 'SqlError',
    });
    expect(outbox.appliedCommandOutcome('ok-command')).toEqual({ success: true, result: null });
    expect(outbox.appliedCommandOutcome('never-seen')).toBeNull();
  });

  it('keeps the first outcome when the same id is recorded again', () => {
    // ON CONFLICT DO NOTHING: the first attempt is the one that touched msdb.
    outbox.recordAppliedCommand('c', false, 'SqlError');
    outbox.recordAppliedCommand('c', true, null);
    expect(outbox.appliedCommandOutcome('c')?.success).toBe(false);
  });

  it('is reported by the handler as the failure it was', async () => {
    // End to end through the real gate, not just the store. The pool is never
    // touched: a redelivery is answered before anything reaches msdb, which is
    // the whole point of the record.
    const { generateKeyPairSync } = await import('node:crypto');
    const { signCommand, toTimestamp } = await import('@remote-sql-agent/protocol');
    const { handleCommand } = await import('../src/command-handler.js');

    // RSA-SHA256, matching SIGNING_ALGORITHM. An ed25519 key here throws
    // "Unsupported crypto operation" from createSign, which is a confusing way
    // to find out the algorithm is not what the server's other tests use.
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    const command = {
      id: '99999999-9999-4999-8999-999999999999',
      instanceName: 'MSSQLSERVER',
      issuedAt: toTimestamp(new Date()),
      signature: new Uint8Array(),
      payload: {
        $case: 'toggleJob',
        toggleJob: {
          jobUuid: '11111111-1111-4111-8111-111111111111',
          enabled: false,
          baseDefinitionHash: '',
        },
      },
    } as never as Parameters<typeof signCommand>[0];
    // `signCommand` returns the signature; the command carries it.
    (command as { signature: Uint8Array }).signature = signCommand(command, privatePem);

    outbox.recordAppliedCommand(command.id, false, 'SqlError');

    const result = await handleCommand(command, {
      pool: undefined as never,
      instanceName: 'MSSQLSERVER',
      capabilities: ['observe', 'job.toggle'],
      outbox,
      logger: pino({ level: 'silent' }),
      commandSigningPublicKey: publicPem,
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SqlError');
    expect(result.errorDetail).toMatch(/already attempted/iu);
  });
});
