import { describe, expect, it } from 'vitest';
import {
  looksLikeRealDeployment,
  reviewAuthPosture,
  type AuthPostureFacts,
} from '../src/worker-auth/posture.js';

/**
 * The startup review that tells an operator their workers are still on API keys.
 *
 * The property worth protecting here is that it fails *on*: the signal is
 * derived from deployment facts rather than a mode flag, so a real deployment
 * that has configured nothing in particular still gets warned. Half these cases
 * exist to stop someone later "fixing" it into silence.
 */

function facts(overrides: Partial<AuthPostureFacts> = {}): AuthPostureFacts {
  return {
    requireTls: true,
    publicUrl: 'https://rsagent.corp.example.com',
    enabledModes: ['token'],
    liveCredentials: { token: 0, mtls: 0, entra: 0 },
    ...overrides,
  };
}

describe('looksLikeRealDeployment', () => {
  it('treats TLS plus a routable public URL as real', () => {
    expect(looksLikeRealDeployment({ requireTls: true, publicUrl: 'https://rsagent.corp' })).toBe(
      true,
    );
  });

  it('treats the documented dev opt-out as development', () => {
    // RSAGENT_GRPC_REQUIRE_TLS=false is what the startup error tells people to
    // set for local development, so it is the one unambiguous dev signal.
    expect(looksLikeRealDeployment({ requireTls: false, publicUrl: 'https://rsagent.corp' })).toBe(
      false,
    );
  });

  it.each(['http://localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080'])(
    'treats %s as development',
    (publicUrl) => {
      expect(looksLikeRealDeployment({ requireTls: true, publicUrl })).toBe(false);
    },
  );

  it('does not treat an unparseable public URL as development', () => {
    // Failing open here would mean a misconfigured production deployment is
    // exactly the one that never gets warned.
    expect(looksLikeRealDeployment({ requireTls: true, publicUrl: 'not a url' })).toBe(true);
  });

  it('treats a plain-http non-local URL as real', () => {
    // Ugly, but it is somebody's estate — and one behind a TLS-terminating
    // proxy that forgot to set RSAGENT_PUBLIC_URL looks exactly like this.
    expect(looksLikeRealDeployment({ requireTls: true, publicUrl: 'http://rsagent.corp' })).toBe(
      true,
    );
  });
});

describe('reviewAuthPosture', () => {
  it('says nothing on a development box', () => {
    expect(
      reviewAuthPosture(
        facts({ requireTls: false, liveCredentials: { token: 5, mtls: 0, entra: 0 } }),
      ),
    ).toEqual([]);
  });

  it('warns, with a count, when workers authenticate by API key', () => {
    const findings = reviewAuthPosture(
      facts({ liveCredentials: { token: 3, mtls: 1, entra: 0 } }),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.level).toBe('warn');
    expect(findings[0]?.message).toContain('3 worker credential(s)');
    expect(findings[0]?.message).toContain('docs/authentication.md');
  });

  it('stays quiet once every worker has moved off API keys', () => {
    const findings = reviewAuthPosture(
      facts({
        enabledModes: ['mtls', 'entra'],
        liveCredentials: { token: 0, mtls: 4, entra: 2 },
      }),
    );
    expect(findings).toEqual([]);
  });

  it('points out that token is still accepted after the workers have migrated', () => {
    // The weakest enabled mode is what the estate is actually exposed to.
    // Migrating every worker and leaving `token` in the list banks nothing.
    const findings = reviewAuthPosture(
      facts({
        enabledModes: ['mtls', 'token'],
        liveCredentials: { token: 0, mtls: 4, entra: 0 },
      }),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.level).toBe('info');
    expect(findings[0]?.message).toContain('RSAGENT_WORKER_AUTH_MODES');
  });

  it('does not nag about enabled modes while token workers still exist', () => {
    // They would have to be migrated first, so the removal advice is premature
    // and the warning above already covers it.
    const findings = reviewAuthPosture(
      facts({
        enabledModes: ['mtls', 'token'],
        liveCredentials: { token: 2, mtls: 4, entra: 0 },
      }),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.level).toBe('warn');
  });
});
