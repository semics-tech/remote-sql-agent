import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { constants, publicEncrypt } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CredentialDecryptError,
  decryptCredential,
  fingerprintPublicKey,
  loadOrCreateCredentialKey,
} from '../src/credential-key.js';
import { classifyConnectionError, splitServerAddress } from '../src/monitor-set.js';

/**
 * These tests stand in for the browser: they encrypt with the published public
 * key exactly as the dashboard does, and check the worker can open it. If this
 * ever breaks, credential onboarding silently stops working — the ciphertext
 * still stores fine, and nothing fails until a worker tries to log in.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rsagent-key-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** What packages/dashboard/src/crypto.ts does, via WebCrypto, in the browser. */
function encryptAsBrowser(publicKeyPem: string, password: string): string {
  return publicEncrypt(
    { key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(JSON.stringify({ password }), 'utf8'),
  ).toString('base64');
}

describe('credential key', () => {
  it('generates once and reloads the same key afterwards', () => {
    const path = join(dir, 'credential.key');
    const first = loadOrCreateCredentialKey(path);
    const second = loadOrCreateCredentialKey(path);

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.publicKeyPem).toBe(first.publicKeyPem);
  });

  it('writes the private key readable only by its owner', () => {
    const path = join(dir, 'credential.key');
    loadOrCreateCredentialKey(path);

    // Anything that can read this file can read this host's SQL password.
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('refuses to write the key through a symlink planted at the path', () => {
    const path = join(dir, 'credential.key');
    const elsewhere = join(dir, 'attacker-readable.key');
    symlinkSync(elsewhere, path);

    // The dangerous shape is check-then-create: the path is empty when asked
    // about and a symlink by the time it is written, so the private key lands
    // wherever the link points. Creating with O_EXCL makes that unreachable —
    // the kernel refuses the path outright, and the worker fails to start
    // rather than quietly handing out the key.
    expect(() => loadOrCreateCredentialKey(path)).toThrow();
    expect(existsSync(elsewhere)).toBe(false);
  });

  it('adopts the key already on disk when another process wins the race', () => {
    const path = join(dir, 'credential.key');
    const winner = loadOrCreateCredentialKey(path);

    // Standing in for a second worker that got there first: whatever is on
    // disk is what this host can decrypt with, so a later start must load it
    // rather than overwrite it and strand every credential encrypted to it.
    const loser = loadOrCreateCredentialKey(path);

    expect(loser.fingerprint).toBe(winner.fingerprint);
    expect(readFileSync(path, 'utf8')).toBe(winner.privateKeyPem);
  });

  it('exports only the public half', () => {
    const path = join(dir, 'credential.key');
    const key = loadOrCreateCredentialKey(path);

    expect(key.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    expect(key.publicKeyPem).not.toContain('PRIVATE KEY');
    expect(readFileSync(path, 'utf8')).toContain('PRIVATE KEY');
  });

  it('fingerprints the key itself, not its text', () => {
    const key = loadOrCreateCredentialKey(join(dir, 'credential.key'));
    // Trailing whitespace differences must not produce a different fingerprint,
    // or a round trip through a form field would look like a re-keyed worker.
    expect(fingerprintPublicKey(`${key.publicKeyPem.trimEnd()}\n\n`)).toBe(key.fingerprint);
    expect(key.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('decryptCredential', () => {
  it('opens what the browser encrypted', () => {
    const key = loadOrCreateCredentialKey(join(dir, 'credential.key'));
    const ciphertext = encryptAsBrowser(key.publicKeyPem, 'S3cret-passw0rd!');

    expect(decryptCredential(ciphertext, key.fingerprint, key)).toEqual({
      password: 'S3cret-passw0rd!',
    });
  });

  it('handles a password with non-ASCII characters', () => {
    const key = loadOrCreateCredentialKey(join(dir, 'credential.key'));
    const password = 'pÅssw0rd–ünï©ode✓';
    const ciphertext = encryptAsBrowser(key.publicKeyPem, password);
    expect(decryptCredential(ciphertext, key.fingerprint, key).password).toBe(password);
  });

  it('reports a stale fingerprint distinctly from a bad password', () => {
    const key = loadOrCreateCredentialKey(join(dir, 'credential.key'));
    const ciphertext = encryptAsBrowser(key.publicKeyPem, 'irrelevant');

    // The two need completely different responses from an operator, so they
    // must not surface as the same error.
    expect(() => decryptCredential(ciphertext, 'f'.repeat(64), key)).toThrow(
      /encrypted to a different key/iu,
    );
  });

  it('refuses ciphertext encrypted to another worker key', () => {
    const mine = loadOrCreateCredentialKey(join(dir, 'mine.key'));
    const theirs = loadOrCreateCredentialKey(join(dir, 'theirs.key'));
    const ciphertext = encryptAsBrowser(theirs.publicKeyPem, 'not for me');

    // Fingerprint check bypassed, so this exercises the decryption itself: one
    // host must never be able to read another host's credential.
    expect(() => decryptCredential(ciphertext, '', mine)).toThrow(CredentialDecryptError);
  });

  it('rejects a payload that decrypts but is not a credential', () => {
    const key = loadOrCreateCredentialKey(join(dir, 'credential.key'));
    const junk = publicEncrypt(
      { key: key.publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from('not json at all', 'utf8'),
    ).toString('base64');

    expect(() => decryptCredential(junk, key.fingerprint, key)).toThrow(/expected format/iu);
  });

  it('rejects an empty password rather than trying to log in with one', () => {
    const key = loadOrCreateCredentialKey(join(dir, 'credential.key'));
    const empty = encryptAsBrowser(key.publicKeyPem, '');
    expect(() => decryptCredential(empty, key.fingerprint, key)).toThrow(/no password/iu);
  });

  it('rejects a truncated blob', () => {
    const key = loadOrCreateCredentialKey(join(dir, 'credential.key'));
    const ciphertext = encryptAsBrowser(key.publicKeyPem, 'password');
    expect(() => decryptCredential(ciphertext.slice(0, 100), key.fingerprint, key)).toThrow(
      CredentialDecryptError,
    );
  });
});

describe('splitServerAddress', () => {
  it.each([
    ['localhost', { server: 'localhost' }],
    ['localhost,1433', { server: 'localhost', port: 1433 }],
    // A named instance stays in the server string: the SQL Browser resolves it.
    ['sqlprod01\\SQL2019', { server: 'sqlprod01\\SQL2019' }],
    ['sqlprod01\\SQL2019,1435', { server: 'sqlprod01\\SQL2019', port: 1435 }],
    ['  sqlprod01  ', { server: 'sqlprod01' }],
    // Not a port: keep it whole rather than silently dropping part of the name.
    ['host,notaport', { server: 'host,notaport' }],
    ['host,99999', { server: 'host,99999' }],
  ])('parses %s', (input, expected) => {
    expect(splitServerAddress(input)).toEqual(expected);
  });
});

describe('classifyConnectionError', () => {
  it('recognises a rejected login', () => {
    expect(classifyConnectionError(Object.assign(new Error('x'), { number: 18456 }))).toBe(
      'auth_failed',
    );
    expect(classifyConnectionError(Object.assign(new Error('x'), { code: 'ELOGIN' }))).toBe(
      'auth_failed',
    );
    expect(classifyConnectionError(new Error("Login failed for user 'rsagent'."))).toBe(
      'auth_failed',
    );
  });

  it('treats anything else as unreachable', () => {
    // Misreporting this as auth_failed would tell an admin to re-enter a
    // password that was never the problem.
    expect(classifyConnectionError(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }))).toBe(
      'unreachable',
    );
    expect(classifyConnectionError(new Error('getaddrinfo ENOTFOUND sqlprod01'))).toBe(
      'unreachable',
    );
  });
});
