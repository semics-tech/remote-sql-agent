import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerConfig } from '../src/config.js';

/**
 * Entra (Azure AD) token acquisition.
 *
 * The worker never imports @azure/msal-node itself: it asks @azure/identity's
 * DefaultAzureCredential for a token, and identity drives msal-node
 * (ManagedIdentityApplication) underneath. msal-node is forced to v7 by a pnpm
 * override, so these tests pin down the surface we depend on, with identity
 * mocked, and the msal behaviours that surface into our error handling.
 */

const getToken = vi.fn();
const ctor = vi.fn();
let constructFailure: Error | null = null;

vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {
    constructor(options?: unknown) {
      if (constructFailure) throw constructFailure;
      ctor(options);
    }
    getToken(scope: string) {
      return getToken(scope);
    }
  },
}));

const { acquireEntraToken, buildCallMetadata, CredentialError } = await import(
  '../src/credentials.js'
);

function entraConfig(auth: Record<string, unknown>): WorkerConfig {
  return { controlPlane: { auth: { mode: 'entra', ...auth }, tls: { enabled: false } } } as never;
}

beforeEach(() => {
  getToken.mockReset();
  ctor.mockReset();
  constructFailure = null;
});

describe('acquireEntraToken: token acquisition', () => {
  it('returns the access token string from the credential', async () => {
    getToken.mockResolvedValue({ token: 'jwt-1', expiresOnTimestamp: Date.now() + 3_600_000 });
    await expect(acquireEntraToken('api://rsagent')).resolves.toBe('jwt-1');
  });

  it('appends /.default to a bare audience', async () => {
    getToken.mockResolvedValue({ token: 't' });
    await acquireEntraToken('api://rsagent');
    expect(getToken).toHaveBeenCalledWith('api://rsagent/.default');
  });

  it('leaves an audience that already ends in /.default alone', async () => {
    getToken.mockResolvedValue({ token: 't' });
    await acquireEntraToken('api://rsagent/.default');
    expect(getToken).toHaveBeenCalledWith('api://rsagent/.default');
  });

  it('builds the credential with no options when no clientId is configured (system-assigned identity)', async () => {
    getToken.mockResolvedValue({ token: 't' });
    await acquireEntraToken('api://rsagent');
    expect(ctor).toHaveBeenCalledWith(undefined);
  });

  it('passes a clientId as managedIdentityClientId (user-assigned identity)', async () => {
    getToken.mockResolvedValue({ token: 't' });
    await acquireEntraToken('api://rsagent', 'client-guid');
    expect(ctor).toHaveBeenCalledWith({ managedIdentityClientId: 'client-guid' });
  });
});

describe('acquireEntraToken: cache and refresh', () => {
  // msal caches inside a credential instance, and we build a fresh credential
  // per call (one per reconnect). So every call goes back to the identity
  // endpoint and a token that has rotated is picked up. If a credential is
  // ever cached in this module, this test must change deliberately.
  it('asks for a new token on every call, so a rotated token is picked up', async () => {
    getToken
      .mockResolvedValueOnce({ token: 'old', expiresOnTimestamp: Date.now() - 1 })
      .mockResolvedValueOnce({ token: 'new', expiresOnTimestamp: Date.now() + 3_600_000 });

    await expect(acquireEntraToken('api://rsagent')).resolves.toBe('old');
    await expect(acquireEntraToken('api://rsagent')).resolves.toBe('new');
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(ctor).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a previous failure: a call after an error can succeed', async () => {
    getToken.mockRejectedValueOnce(new Error('IMDS unreachable')).mockResolvedValueOnce({ token: 'ok' });
    await expect(acquireEntraToken('api://rsagent')).rejects.toThrow('IMDS unreachable');
    await expect(acquireEntraToken('api://rsagent')).resolves.toBe('ok');
  });
});

describe('acquireEntraToken: error path', () => {
  it('wraps a credential construction failure in a CredentialError that names the fix', async () => {
    constructFailure = new Error('boom');

    const err = await acquireEntraToken('api://rsagent').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CredentialError);
    expect((err as Error).message).toContain('managed identity');
    expect((err as Error).message).toContain('boom');
  });

  it('throws a CredentialError naming the scope when getToken returns null', async () => {
    getToken.mockResolvedValue(null);
    const err = await acquireEntraToken('api://rsagent').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CredentialError);
    expect((err as Error).message).toContain('api://rsagent/.default');
  });

  it('throws a CredentialError when the token string is empty', async () => {
    getToken.mockResolvedValue({ token: '' });
    await expect(acquireEntraToken('api://rsagent')).rejects.toBeInstanceOf(CredentialError);
  });

  it('lets an msal/identity failure from getToken propagate unchanged', async () => {
    const unavailable = Object.assign(new Error('ManagedIdentityCredential: Authentication failed'), {
      name: 'CredentialUnavailableError',
    });
    getToken.mockRejectedValue(unavailable);
    await expect(acquireEntraToken('api://rsagent')).rejects.toBe(unavailable);
  });
});

describe('buildCallMetadata: entra mode', () => {
  it('sets a Bearer authorization header from the acquired token', async () => {
    getToken.mockResolvedValue({ token: 'jwt-2' });
    const md = await buildCallMetadata(entraConfig({ audience: 'api://rsagent' }));
    expect(md.get('authorization')).toEqual(['Bearer jwt-2']);
  });

  it('forwards the configured clientId', async () => {
    getToken.mockResolvedValue({ token: 't' });
    await buildCallMetadata(entraConfig({ audience: 'api://rsagent', clientId: 'cid' }));
    expect(ctor).toHaveBeenCalledWith({ managedIdentityClientId: 'cid' });
  });

  it('refuses to run without an audience, before touching identity', async () => {
    await expect(buildCallMetadata(entraConfig({}))).rejects.toBeInstanceOf(CredentialError);
    expect(ctor).not.toHaveBeenCalled();
  });

  it('surfaces a failed acquisition so the session can report it', async () => {
    getToken.mockResolvedValue(null);
    await expect(buildCallMetadata(entraConfig({ audience: 'api://rsagent' }))).rejects.toBeInstanceOf(
      CredentialError,
    );
  });
});
