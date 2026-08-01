import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateCommandSigningKeyPair, signingKeyFingerprint } from '../src/signing.js';

/**
 * The value a worker pins and the control plane prints.
 *
 * These two have to agree exactly or pinning is worse than not pinning: a
 * mismatch refuses the session, so a fingerprint that is computed differently
 * on each side takes the estate offline rather than leaving it insecure.
 */

describe('signingKeyFingerprint', () => {
  it('is a stable sha256 hex digest', () => {
    const { publicKeyPem } = generateCommandSigningKeyPair();
    const fingerprint = signingKeyFingerprint(publicKeyPem);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(signingKeyFingerprint(publicKeyPem)).toBe(fingerprint);
  });

  it('differs between keys', () => {
    const a = signingKeyFingerprint(generateCommandSigningKeyPair().publicKeyPem);
    const b = signingKeyFingerprint(generateCommandSigningKeyPair().publicKeyPem);
    expect(a).not.toBe(b);
  });

  it('is unmoved by line endings and trailing whitespace', () => {
    // Over the DER, not the PEM, so a key copied through a Windows editor still
    // matches the pin an operator took from a Linux host.
    const { publicKeyPem } = generateCommandSigningKeyPair();
    const crlf = publicKeyPem.replaceAll('\n', '\r\n');
    expect(signingKeyFingerprint(crlf)).toBe(signingKeyFingerprint(publicKeyPem));
    expect(signingKeyFingerprint(`${publicKeyPem}\n\n`)).toBe(signingKeyFingerprint(publicKeyPem));
  });

  it('returns empty rather than throwing on a key it cannot parse', () => {
    // Keeps the caller's comparison total. An unparseable key can never equal a
    // 64-character pin, so this still fails closed.
    expect(signingKeyFingerprint('not a key')).toBe('');
    expect(signingKeyFingerprint('')).toBe('');
  });

  const hasOpenssl = (() => {
    try {
      execFileSync('openssl', ['version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  // Skipped rather than failed where openssl is absent: the point is to catch a
  // divergence from the documented command, not to require the tool.
  it.skipIf(!hasOpenssl)('matches what openssl prints, which is what the docs tell operators to run', () => {
    // The docs tell an operator to run
    //   openssl pkey -pubin -outform DER | openssl dgst -sha256
    // so if this ever stops agreeing, every pinned worker refuses its session.
    const dir = mkdtempSync(join(tmpdir(), 'rsagent-fp-'));
    try {
      const { publicKeyPem } = generateCommandSigningKeyPair();
      const pemPath = join(dir, 'signing.pub');
      writeFileSync(pemPath, publicKeyPem);

      const der = execFileSync('openssl', ['pkey', '-pubin', '-in', pemPath, '-outform', 'DER']);
      const derPath = join(dir, 'signing.der');
      writeFileSync(derPath, der);
      const digest = execFileSync('openssl', ['dgst', '-sha256', derPath]).toString();

      expect(digest.trim()).toContain(signingKeyFingerprint(publicKeyPem));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
