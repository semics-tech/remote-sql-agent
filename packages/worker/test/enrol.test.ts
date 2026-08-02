import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as ProtocolModule from '@remote-sql-agent/protocol';
import type * as CredentialsModule from '../src/credentials.js';
import type * as CredentialKeyModule from '../src/credential-key.js';

/**
 * enrol() used to hardcode `workerVersion: '0.1.0'` in the Hello it sends the
 * control plane — already wrong the moment index.ts's own WORKER_VERSION
 * moved to 0.2.0, since nothing kept the two in step. Both now come from the
 * one shared constant in version.ts.
 */

let capturedRequest: { workerVersion?: string } | null = null;

vi.mock('@remote-sql-agent/protocol', async (importOriginal) => {
  const actual = await importOriginal<typeof ProtocolModule>();
  return {
    ...actual,
    EnrolmentClient: class {
      enrol(
        request: { workerVersion?: string },
        _metadata: unknown,
        callback: (err: unknown, value?: unknown) => void,
      ): void {
        capturedRequest = request;
        callback(null, { workerId: 'w1', workerKey: 'test-worker-key' });
      }
      close(): void {}
    },
  };
});

vi.mock('../src/credentials.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CredentialsModule>();
  return {
    ...actual,
    buildChannelCredentials: vi.fn(() => ({}) as never),
    writeWorkerKey: vi.fn(),
  };
});

vi.mock('../src/credential-key.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CredentialKeyModule>();
  return {
    ...actual,
    loadOrCreateCredentialKey: vi.fn(() => ({ fingerprint: 'deadbeef'.repeat(4) }) as never),
  };
});

const { enrol } = await import('../src/enrol.js');
const { WORKER_VERSION } = await import('../src/version.js');

let dir: string;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rsagent-enrol-'));
  capturedRequest = null;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

describe('enrol() reports the worker\'s real version', () => {
  it('sends the shared WORKER_VERSION, not a hardcoded literal', async () => {
    const configPath = join(dir, 'worker.yaml');
    writeFileSync(
      configPath,
      [
        'controlPlane:',
        '  address: localhost:8443',
        '  tls:',
        '    enabled: false',
        '  auth:',
        '    mode: token',
        `    keyFile: ${join(dir, 'worker.key')}`,
      ].join('\n'),
    );

    await enrol({ configPath, token: 'rsen_test' });

    expect(capturedRequest?.workerVersion).toBe(WORKER_VERSION);
    expect(capturedRequest?.workerVersion).not.toBe('0.1.0');
  });
});
