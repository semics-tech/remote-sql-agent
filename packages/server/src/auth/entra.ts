import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import type { Role } from '@rsagent/protocol';

/**
 * Microsoft Entra ID sign-in (OIDC authorisation code flow with PKCE).
 *
 * Implemented directly against the documented endpoints rather than through a
 * generic OIDC client library: the flow is small, and the parts that matter for
 * security — nonce binding, PKCE, issuer and audience checks, and how roles are
 * derived — are things worth being able to read in one file.
 *
 * PKCE is used even though this is a confidential client with a secret. It
 * costs nothing and removes authorisation-code interception from the threat
 * model entirely.
 */

export interface EntraConfig {
  tenantId: string;
  clientId: string;
  clientSecret?: string | undefined;
  appRoleMap: Record<string, Role>;
  defaultRole: Role | null;
}

export interface EntraProfile {
  /** `oid` — immutable per user per tenant. The only safe primary identifier:
   * UPN and email can both be reassigned to a different person. */
  objectId: string;
  tenantId: string;
  username: string;
  displayName: string | null;
  email: string | null;
  role: Role | null;
  appRoles: string[];
}

export interface PendingAuth {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
}

const AUTH_FLOW_TTL_MS = 10 * 60 * 1000;

export class EntraClient {
  readonly #config: EntraConfig;
  readonly #jwks: ReturnType<typeof createRemoteJWKSet>;
  readonly #issuers: string[];
  /** In-flight authorisation attempts, keyed by state. In-memory because a
   * flow that outlives a process restart is one the user should simply retry. */
  readonly #pending = new Map<string, PendingAuth>();

  constructor(config: EntraConfig) {
    this.#config = config;
    this.#jwks = createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${config.tenantId}/discovery/v2.0/keys`),
    );
    // v2.0 tokens use the first form; some tenant configurations still emit the
    // second. Both are legitimate for our tenant and neither is wildcarded.
    this.#issuers = [
      `https://login.microsoftonline.com/${config.tenantId}/v2.0`,
      `https://sts.windows.net/${config.tenantId}/`,
    ];
  }

  get clientId(): string {
    return this.#config.clientId;
  }

  /** Build the authorisation URL and remember what we must check on return. */
  beginSignIn(redirectUri: string): { url: string; state: string } {
    this.#prunePending();

    const state = randomBytes(24).toString('base64url');
    const nonce = randomBytes(24).toString('base64url');
    const codeVerifier = randomBytes(48).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

    this.#pending.set(state, {
      state,
      nonce,
      codeVerifier,
      redirectUri,
      createdAt: Date.now(),
    });

    const url = new URL(
      `https://login.microsoftonline.com/${this.#config.tenantId}/oauth2/v2.0/authorize`,
    );
    url.searchParams.set('client_id', this.#config.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_mode', 'query');
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');

    return { url: url.toString(), state };
  }

  /** Exchange the authorisation code and validate the resulting id_token. */
  async completeSignIn(code: string, state: string): Promise<EntraProfile> {
    const pending = this.#pending.get(state);
    if (!pending) {
      // Unknown state means either CSRF, a replayed callback, or a flow that
      // expired. None of them should proceed.
      throw new Error('Sign-in state is unknown or has expired. Start again.');
    }
    this.#pending.delete(state);

    if (Date.now() - pending.createdAt > AUTH_FLOW_TTL_MS) {
      throw new Error('Sign-in took too long. Start again.');
    }

    const body = new URLSearchParams({
      client_id: this.#config.clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.codeVerifier,
      scope: 'openid profile email',
    });
    if (this.#config.clientSecret) body.set('client_secret', this.#config.clientSecret);

    const response = await fetch(
      `https://login.microsoftonline.com/${this.#config.tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      },
    );

    if (!response.ok) {
      const detail = await response.text();
      // The response body can contain the client secret echoed back in some
      // error shapes; log the code only.
      throw new Error(`Entra token exchange failed (${response.status}): ${detail.slice(0, 200)}`);
    }

    const tokens = (await response.json()) as { id_token?: string };
    if (!tokens.id_token) throw new Error('Entra did not return an id_token.');

    return this.#profileFromIdToken(tokens.id_token, pending.nonce);
  }

  async #profileFromIdToken(idToken: string, expectedNonce: string): Promise<EntraProfile> {
    const { payload } = await jwtVerify(idToken, this.#jwks, {
      audience: this.#config.clientId,
      issuer: this.#issuers,
      clockTolerance: 60,
    });

    if (payload.nonce !== expectedNonce) {
      // Without this check, a token minted for a different session could be
      // replayed into this one.
      throw new Error('id_token nonce did not match the sign-in request.');
    }

    return this.profileFromClaims(payload);
  }

  /** Map validated claims onto our user model. */
  profileFromClaims(payload: JWTPayload): EntraProfile {
    const claims = payload as JWTPayload & {
      oid?: string;
      tid?: string;
      preferred_username?: string;
      name?: string;
      email?: string;
      upn?: string;
      roles?: string[];
    };

    const objectId = claims.oid;
    if (!objectId) throw new Error('id_token has no oid claim; cannot identify the user.');

    const appRoles = claims.roles ?? [];
    const role = this.#resolveRole(appRoles);

    return {
      objectId,
      tenantId: claims.tid ?? this.#config.tenantId,
      username: claims.preferred_username ?? claims.upn ?? objectId,
      displayName: claims.name ?? null,
      email: claims.email ?? claims.preferred_username ?? null,
      role,
      appRoles,
    };
  }

  /**
   * Resolve the dashboard role from Entra app roles.
   *
   * A user holding several roles gets the most privileged, which is what an
   * administrator assigning both `rsagent.viewer` and `rsagent.admin` means. An
   * unmapped user gets `defaultRole`, which is null by default — an
   * unrecognised app role must not silently confer estate-wide read access.
   */
  #resolveRole(appRoles: string[]): Role | null {
    const precedence: Role[] = ['Admin', 'Editor', 'Operator', 'Viewer'];
    const mapped = appRoles
      .map((r) => this.#config.appRoleMap[r])
      .filter((r): r is Role => r !== undefined);

    for (const role of precedence) {
      if (mapped.includes(role)) return role;
    }
    return this.#config.defaultRole;
  }

  #prunePending(): void {
    const cutoff = Date.now() - AUTH_FLOW_TTL_MS;
    for (const [state, pending] of this.#pending) {
      if (pending.createdAt < cutoff) this.#pending.delete(state);
    }
  }
}

/**
 * Validate an Entra *access* token presented by a worker using workload
 * identity. Separate from the sign-in path: different audience, no nonce, and
 * the subject is a service principal rather than a user.
 */
export class EntraWorkloadValidator {
  readonly #jwks: ReturnType<typeof createRemoteJWKSet>;
  readonly #issuers: string[];

  constructor(
    private readonly tenantId: string,
    private readonly audience: string,
  ) {
    this.#jwks = createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`),
    );
    this.#issuers = [
      `https://login.microsoftonline.com/${tenantId}/v2.0`,
      `https://sts.windows.net/${tenantId}/`,
    ];
  }

  /** Returns the calling principal's object id, or throws. */
  async validate(token: string): Promise<{ objectId: string; tenantId: string }> {
    const { payload } = await jwtVerify(token, this.#jwks, {
      audience: this.audience,
      issuer: this.#issuers,
      clockTolerance: 60,
    });

    const claims = payload as JWTPayload & { oid?: string; tid?: string };
    if (!claims.oid) throw new Error('Worker token has no oid claim.');
    if (claims.tid && claims.tid !== this.tenantId) {
      throw new Error('Worker token was issued by a different tenant.');
    }
    return { objectId: claims.oid, tenantId: claims.tid ?? this.tenantId };
  }
}
