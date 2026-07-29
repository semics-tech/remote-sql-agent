import { describe, expect, it, beforeAll } from 'vitest';
import {
  generateCommandSigningKeyPair,
  signCommand,
  verifyCommandSignature,
  commandPayloadHash,
  isCommandFresh,
  MAX_COMMAND_AGE_MS,
  type CommandSigningKeyPair,
} from '../src/signing.js';
import type { Command } from '../src/gen/rsagent/v1/worker.js';

function command(overrides: Partial<Command> = {}): Command {
  return {
    id: '2f1c2a3e-0000-4000-8000-000000000001',
    issuedAt: { seconds: 1_770_000_000, nanos: 0 },
    instanceName: 'SQLPROD01\\INST1',
    signature: Buffer.alloc(0),
    payload: { $case: 'toggleJob', toggleJob: { jobUuid: 'job-1', enabled: false, baseDefinitionHash: 'abc' } },
    ...overrides,
  };
}

let keys: CommandSigningKeyPair;
let otherKeys: CommandSigningKeyPair;

beforeAll(() => {
  keys = generateCommandSigningKeyPair();
  otherKeys = generateCommandSigningKeyPair();
});

describe('command signing', () => {
  it('verifies a signature it just produced', () => {
    const c = command();
    c.signature = signCommand(c, keys.privateKeyPem);
    expect(verifyCommandSignature(c, keys.publicKeyPem)).toBe(true);
  });

  it('rejects a signature from a different key', () => {
    const c = command();
    c.signature = signCommand(c, otherKeys.privateKeyPem);
    expect(verifyCommandSignature(c, keys.publicKeyPem)).toBe(false);
  });

  it('rejects an unsigned command', () => {
    expect(verifyCommandSignature(command(), keys.publicKeyPem)).toBe(false);
  });

  it.each([
    ['id', (c: Command) => (c.id = 'tampered')],
    ['instanceName', (c: Command) => (c.instanceName = 'SQLPROD02\\INST1')],
    ['issuedAt', (c: Command) => (c.issuedAt = { seconds: 1_770_000_001, nanos: 0 })],
    [
      'payload value',
      (c: Command) => {
        c.payload = {
          $case: 'toggleJob',
          toggleJob: { jobUuid: 'job-1', enabled: true, baseDefinitionHash: 'abc' },
        };
      },
    ],
    [
      'payload type',
      (c: Command) => {
        c.payload = { $case: 'deleteJob', deleteJob: { jobUuid: 'job-1', baseDefinitionHash: 'abc' } };
      },
    ],
  ])('detects tampering with %s', (_field, tamper) => {
    const c = command();
    c.signature = signCommand(c, keys.privateKeyPem);
    tamper(c);
    expect(verifyCommandSignature(c, keys.publicKeyPem)).toBe(false);
  });

  it('is not fooled by shifting field boundaries', () => {
    // Without length-prefixing, ("ab","c") and ("a","bc") would sign the same
    // bytes and a signature could be lifted from one command onto another.
    const a = command({ id: 'ab', instanceName: 'c' });
    const b = command({ id: 'a', instanceName: 'bc' });
    a.signature = signCommand(a, keys.privateKeyPem);
    b.signature = a.signature;
    expect(verifyCommandSignature(b, keys.publicKeyPem)).toBe(false);
  });

  it('hashes payloads independently of key order', () => {
    const a = command();
    const b = command({
      payload: {
        $case: 'toggleJob',
        toggleJob: { baseDefinitionHash: 'abc', enabled: false, jobUuid: 'job-1' },
      },
    });
    expect(commandPayloadHash(a)).toBe(commandPayloadHash(b));
  });
});

describe('replay window', () => {
  const now = 1_770_000_000_000;

  it('accepts a command issued just now', () => {
    expect(isCommandFresh(now, now)).toBe(true);
  });

  it('accepts a command within the replay window', () => {
    expect(isCommandFresh(now - MAX_COMMAND_AGE_MS + 1000, now)).toBe(true);
  });

  it('rejects a command older than the replay window', () => {
    expect(isCommandFresh(now - MAX_COMMAND_AGE_MS - 1000, now)).toBe(false);
  });

  it('tolerates modest clock skew but rejects the far future', () => {
    expect(isCommandFresh(now + 30_000, now)).toBe(true);
    expect(isCommandFresh(now + 10 * 60_000, now)).toBe(false);
  });
});
