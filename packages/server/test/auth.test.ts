import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/db/client.js';
import {
  hashPassword,
  verifyPassword,
  generateWorkerKey,
  hashWorkerKey,
  verifyWorkerKey,
  workerKeyPrefix,
  hashToken,
  safeEqualHex,
} from '../src/auth/passwords.js';
import {
  createSession,
  resolveSession,
  revokeSession,
  revokeAllSessionsForUser,
  pruneExpiredSessions,
} from '../src/auth/sessions.js';
import {
  authenticateLocal,
  createLocalUser,
  ensureBootstrapAdmin,
  setUserDisabled,
  setUserRole,
  upsertEntraUser,
} from '../src/auth/users.js';
import { EntraClient } from '../src/auth/entra.js';
import { setupTestDatabase, truncateAll } from './helpers/db.js';
import { pino } from 'pino';

let db: Database;
let close: () => Promise<void>;
const logger = pino({ level: 'silent' });

beforeAll(async () => {
  const setup = await setupTestDatabase('auth');
  db = setup.db;
  close = setup.close;
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await truncateAll(db);
});

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'Correct horse battery staple')).toBe(false);
  });

  it('produces a different hash for the same password each time', async () => {
    // Distinct salts; identical hashes would leak which users share a password.
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('treats a malformed hash as a failed verification, not an exception', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });
});

describe('worker keys', () => {
  it('issues a prefixed key whose stored prefix matches', () => {
    const { key, prefix } = generateWorkerKey();
    expect(key.startsWith('rsak_')).toBe(true);
    expect(workerKeyPrefix(key)).toBe(prefix);
    expect(prefix).toHaveLength(8);
  });

  it('round-trips through argon2id', async () => {
    const { key } = generateWorkerKey();
    const hash = await hashWorkerKey(key);
    expect(await verifyWorkerKey(hash, key)).toBe(true);
    expect(await verifyWorkerKey(hash, `${key}x`)).toBe(false);
  });

  it('generates unique keys', () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateWorkerKey().key));
    expect(keys.size).toBe(50);
  });
});

describe('constant-time comparison', () => {
  it('matches identical hex and rejects differing hex', () => {
    const a = hashToken('value');
    expect(safeEqualHex(a, hashToken('value'))).toBe(true);
    expect(safeEqualHex(a, hashToken('other'))).toBe(false);
  });

  it('rejects empty and mismatched lengths rather than throwing', () => {
    expect(safeEqualHex('', '')).toBe(false);
    expect(safeEqualHex('aabb', 'aa')).toBe(false);
  });
});

describe('local sign-in', () => {
  beforeEach(async () => {
    await createLocalUser(db, {
      username: 'dba',
      password: 'a-sufficiently-long-password',
      role: 'Editor',
    });
  });

  it('authenticates a valid user', async () => {
    const user = await authenticateLocal(db, 'dba', 'a-sufficiently-long-password');
    expect(user).toMatchObject({ username: 'dba', role: 'Editor', identityProvider: 'local' });
  });

  it('rejects a wrong password', async () => {
    expect(await authenticateLocal(db, 'dba', 'wrong')).toBeNull();
  });

  it('rejects an unknown user', async () => {
    expect(await authenticateLocal(db, 'nobody', 'whatever')).toBeNull();
  });

  it('rejects a disabled user', async () => {
    const [row] = await db.execute(`SELECT id FROM users WHERE username = 'dba'` as never);
    await setUserDisabled(db, (row as { id: string }).id, true);
    expect(await authenticateLocal(db, 'dba', 'a-sufficiently-long-password')).toBeNull();
  });
});

describe('sessions', () => {
  let userId: string;

  beforeEach(async () => {
    const user = await createLocalUser(db, {
      username: 'dba',
      password: 'a-sufficiently-long-password',
      role: 'Viewer',
    });
    userId = user!.id;
  });

  it('resolves a freshly created session', async () => {
    const { token } = await createSession(db, userId, 12, '127.0.0.1');
    const resolved = await resolveSession(db, token);
    expect(resolved?.user.username).toBe('dba');
  });

  it('does not resolve an unknown or absent token', async () => {
    expect(await resolveSession(db, 'not-a-token')).toBeNull();
    expect(await resolveSession(db, undefined)).toBeNull();
  });

  it('does not resolve an expired session', async () => {
    const { token } = await createSession(db, userId, -1, null);
    expect(await resolveSession(db, token)).toBeNull();
  });

  it('stops resolving once revoked', async () => {
    const { token } = await createSession(db, userId, 12, null);
    await revokeSession(db, token);
    expect(await resolveSession(db, token)).toBeNull();
  });

  it('invalidates every session for a user at once', async () => {
    const a = await createSession(db, userId, 12, null);
    const b = await createSession(db, userId, 12, null);
    await revokeAllSessionsForUser(db, userId);
    expect(await resolveSession(db, a.token)).toBeNull();
    expect(await resolveSession(db, b.token)).toBeNull();
  });

  it('stops resolving as soon as the user is disabled', async () => {
    // Disabling must take effect immediately, not at the session's natural
    // expiry — otherwise a dismissed employee keeps access for hours.
    const { token } = await createSession(db, userId, 12, null);
    await setUserDisabled(db, userId, true);
    expect(await resolveSession(db, token)).toBeNull();
  });

  it('stores only hashes, never the tokens themselves', async () => {
    const { token, csrfToken } = await createSession(db, userId, 12, null);
    const rows = await db.execute(`SELECT token_hash, csrf_token_hash FROM sessions` as never);
    const row = rows[0] as { token_hash: string; csrf_token_hash: string };
    expect(row.token_hash).not.toBe(token);
    expect(row.token_hash).toBe(hashToken(token));
    expect(row.csrf_token_hash).toBe(hashToken(csrfToken));
  });

  it('prunes expired sessions and leaves live ones', async () => {
    await createSession(db, userId, -1, null);
    const live = await createSession(db, userId, 12, null);
    expect(await pruneExpiredSessions(db)).toBe(1);
    expect(await resolveSession(db, live.token)).not.toBeNull();
  });
});

describe('Entra app-role mapping', () => {
  const client = new EntraClient({
    tenantId: 'tenant',
    clientId: 'client',
    appRoleMap: {
      'rsagent.viewer': 'Viewer',
      'rsagent.operator': 'Operator',
      'rsagent.editor': 'Editor',
      'rsagent.admin': 'Admin',
    },
    defaultRole: null,
  });

  it('maps a single app role', () => {
    expect(client.profileFromClaims({ oid: 'o1', roles: ['rsagent.editor'] }).role).toBe('Editor');
  });

  it('takes the most privileged when several are assigned', () => {
    const profile = client.profileFromClaims({
      oid: 'o1',
      roles: ['rsagent.viewer', 'rsagent.admin'],
    });
    expect(profile.role).toBe('Admin');
  });

  it('returns no role when nothing maps, rather than defaulting to Viewer', () => {
    // An unrecognised app role must not silently confer estate-wide read access.
    expect(client.profileFromClaims({ oid: 'o1', roles: ['something.else'] }).role).toBeNull();
    expect(client.profileFromClaims({ oid: 'o1' }).role).toBeNull();
  });

  it('honours an explicit default role when configured', () => {
    const withDefault = new EntraClient({
      tenantId: 'tenant',
      clientId: 'client',
      appRoleMap: { 'rsagent.admin': 'Admin' },
      defaultRole: 'Viewer',
    });
    expect(withDefault.profileFromClaims({ oid: 'o1', roles: [] }).role).toBe('Viewer');
  });

  it('refuses claims without an oid', () => {
    expect(() => client.profileFromClaims({ roles: ['rsagent.admin'] })).toThrow(/oid/u);
  });

  it('prefers preferred_username but falls back to upn then oid', () => {
    expect(client.profileFromClaims({ oid: 'o1', preferred_username: 'a@x' }).username).toBe('a@x');
    expect(client.profileFromClaims({ oid: 'o1', upn: 'b@x' }).username).toBe('b@x');
    expect(client.profileFromClaims({ oid: 'o1' }).username).toBe('o1');
  });
});

describe('Entra user provisioning', () => {
  const profile = {
    objectId: 'oid-123',
    tenantId: 'tenant',
    username: 'dba@example.com',
    displayName: 'A DBA',
    email: 'dba@example.com',
    role: 'Editor' as const,
    appRoles: ['rsagent.editor'],
    groupIds: ['11111111-2222-3333-4444-555555555555'],
    groupsTruncated: false,
  };

  it('creates a user on first sign-in', async () => {
    const user = await upsertEntraUser(db, profile);
    expect(user).toMatchObject({ username: 'dba@example.com', role: 'Editor', identityProvider: 'entra' });
  });

  it('matches on object id, not username, when the username changes', async () => {
    // A renamed user must keep the same account; matching on username would
    // create a duplicate, and matching on a *reassigned* username would hand
    // one person another's account.
    const first = await upsertEntraUser(db, profile);
    const renamed = await upsertEntraUser(db, { ...profile, username: 'newname@example.com' });
    expect(renamed.id).toBe(first.id);
    expect(renamed.username).toBe('newname@example.com');
  });

  it('re-syncs the role on every sign-in', async () => {
    await upsertEntraUser(db, profile);
    const downgraded = await upsertEntraUser(db, { ...profile, role: 'Viewer' });
    expect(downgraded.role).toBe('Viewer');
  });

  it('refuses to sign in a user with no mapped role', async () => {
    await expect(upsertEntraUser(db, { ...profile, role: null })).rejects.toThrow(/app role/iu);
  });

  it('refuses a locally disabled user even after a valid Entra sign-in', async () => {
    const user = await upsertEntraUser(db, profile);
    await setUserDisabled(db, user.id, true);
    await expect(upsertEntraUser(db, profile)).rejects.toThrow(/disabled/iu);
  });

  it('refuses to change an Entra-sourced role locally', async () => {
    // Accepting it silently would be worse: the change would survive until the
    // next sign-in and then revert with no explanation.
    const user = await upsertEntraUser(db, profile);
    await expect(setUserRole(db, user.id, 'Admin')).rejects.toThrow(/Entra/u);
  });
});

describe('bootstrap admin', () => {
  it('creates an admin when the database has no users', async () => {
    await ensureBootstrapAdmin(db, 'admin', 'a-configured-password', logger);
    const user = await authenticateLocal(db, 'admin', 'a-configured-password');
    expect(user?.role).toBe('Admin');
  });

  it('does nothing when a user already exists', async () => {
    await createLocalUser(db, { username: 'someone', password: 'password-1234', role: 'Viewer' });
    await ensureBootstrapAdmin(db, 'admin', 'a-configured-password', logger);
    expect(await authenticateLocal(db, 'admin', 'a-configured-password')).toBeNull();
  });

  it('generates a password when none is configured rather than using a default', async () => {
    await ensureBootstrapAdmin(db, 'admin', undefined, logger);
    // The critical property: no well-known password is ever accepted.
    for (const guess of ['admin', 'password', 'changeme', 'rsagent']) {
      expect(await authenticateLocal(db, 'admin', guess)).toBeNull();
    }
  });
});
