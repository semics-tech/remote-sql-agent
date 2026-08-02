import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import forge from 'node-forge';
import { pino } from 'pino';
import type { WorkerMessage } from '@remote-sql-agent/protocol';
import { CertificateRenewer } from '../src/cert-renewal.js';
import { generateCsr } from '../src/csr.js';
import type { WorkerConfig } from '../src/config.js';

/**
 * The renewal state machine, with the clock faked.
 *
 * These cover the cases that only show up on a timescale nobody exercises by
 * hand: a certificate already past half its life, a renewal that is refused, and
 * the one that made the whole feature necessary — a delay longer than
 * setTimeout's 24.9-day ceiling, which fires *immediately* rather than late.
 */

const logger = pino({ level: 'silent' });
const DAY = 24 * 60 * 60 * 1000;

let dir: string;
let sent: WorkerMessage[];
let reconnects: string[];

/**
 * Advance a day at a time until the first request goes out, and stop there.
 *
 * Running past it would count the hourly retries for a reply the test never
 * sends, and each retry generates a 3072-bit key — which is both the wrong
 * assertion and slow enough to matter.
 */
function advanceUntilSent(renewer: CertificateRenewer, budgetDays: number): number {
  for (let day = 1; day <= budgetDays; day++) {
    vi.advanceTimersByTime(DAY);
    if (sent.length > 0) {
      renewer.stop();
      return day;
    }
  }
  throw new Error(`No renewal request within ${budgetDays} days`);
}

/** A CA, so the test issues certificates the same shape the control plane does. */
function makeCa(): { key: forge.pki.rsa.PrivateKey; cert: forge.pki.Certificate } {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(2020, 0, 1);
  cert.validity.notAfter = new Date(2040, 0, 1);
  const attrs = [{ name: 'commonName', value: 'Test CA' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'basicConstraints', cA: true }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { key: keys.privateKey, cert };
}

const ca = makeCa();

/** Issue a leaf certificate over `publicKeyPem`, valid for `days` from `from`. */
function issue(publicKeyPem: string, from: Date, days: number): string {
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKeyPem);
  cert.serialNumber = `01${Math.floor(Math.random() * 1e12).toString(16)}`;
  cert.validity.notBefore = from;
  cert.validity.notAfter = new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
  cert.setSubject([{ name: 'commonName', value: 'worker-1' }]);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([{ name: 'basicConstraints', cA: false }]);
  cert.sign(ca.key, forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
}

/** A matching key + certificate pair on disk, as enrolment would have left it. */
function seedPair(from: Date, days: number): { certPath: string; keyPath: string } {
  const { csrPem, privateKeyPem } = generateCsr('worker-1');
  void csrPem;
  const publicKeyPem = createPublicKey(privateKeyPem).export({
    type: 'spki',
    format: 'pem',
  }) as string;

  const certPath = join(dir, 'worker.crt');
  const keyPath = join(dir, 'worker.key');
  writeFileSync(certPath, issue(publicKeyPem, from, days));
  writeFileSync(keyPath, privateKeyPem);
  return { certPath, keyPath };
}

function makeConfig(overrides: {
  mode?: 'token' | 'mtls' | 'entra';
  certPath?: string;
  keyPath?: string;
  caCertPath?: string;
}): WorkerConfig {
  return {
    hostName: 'worker-1',
    controlPlane: {
      address: 'localhost:8443',
      auth: { mode: overrides.mode ?? 'mtls' },
      tls: {
        enabled: true,
        clientCertPath: overrides.certPath,
        clientKeyPath: overrides.keyPath,
        caCertPath: overrides.caCertPath,
      },
      reconnect: { initialDelayMs: 1000, maxDelayMs: 60000, jitterRatio: 0.3 },
    },
  } as unknown as WorkerConfig;
}

function makeRenewer(config: WorkerConfig): CertificateRenewer {
  return new CertificateRenewer(config, logger, {
    send: (message) => {
      sent.push(message);
      return true;
    },
    reconnect: (reason) => reconnects.push(reason),
  });
}

/** The CSR the renewer just sent, and a certificate issued over it. */
function certifyOutstandingCsr(from: Date, days: number): string {
  const message = sent.at(-1);
  if (message?.msg?.$case !== 'certificateRenewal') throw new Error('No CSR was sent');
  const csr = forge.pki.certificationRequestFromPem(message.msg.certificateRenewal.csrPem);
  if (!csr.publicKey) throw new Error('CSR carries no public key');
  return issue(forge.pki.publicKeyToPem(csr.publicKey), from, days);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rsagent-renewal-'));
  sent = [];
  reconnects = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('CertificateRenewer', () => {
  it('does nothing in token mode', () => {
    const { certPath, keyPath } = seedPair(new Date('2026-01-01'), 90);
    vi.setSystemTime(new Date('2026-03-01'));

    const renewer = makeRenewer(makeConfig({ mode: 'token', certPath, keyPath }));
    renewer.onSessionReady();
    vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000);

    expect(renewer.enabled).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('renews immediately when the certificate is already past half its life', () => {
    const { certPath, keyPath } = seedPair(new Date('2026-01-01'), 90);
    // Day 60 of 90.
    vi.setSystemTime(new Date('2026-03-02'));

    makeRenewer(makeConfig({ certPath, keyPath })).onSessionReady();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.msg?.$case).toBe('certificateRenewal');
  });

  it('waits until half life when the certificate is fresh', () => {
    const { certPath, keyPath } = seedPair(new Date('2026-01-01'), 90);
    vi.setSystemTime(new Date('2026-01-02'));

    const renewer = makeRenewer(makeConfig({ certPath, keyPath }));
    renewer.onSessionReady();
    expect(sent).toHaveLength(0);

    // Day 44 of 90: short of half life even before jitter.
    vi.advanceTimersByTime(43 * DAY);
    expect(sent).toHaveLength(0);

    // Half life is day 45, and jitter adds up to 5% of the lifetime (4.5 days).
    const firedOnDay = 44 + advanceUntilSent(renewer, 8);
    expect(firedOnDay).toBeGreaterThanOrEqual(45);
    expect(firedOnDay).toBeLessThanOrEqual(50);
  });

  it('does not fire early when the delay exceeds the setTimeout ceiling', () => {
    // 300-day certificate renews at ~150 days — six times setTimeout's 24.9-day
    // cap. Passing that delay straight to setTimeout fires it on the next tick,
    // which would renew in a loop from the moment the session came up.
    const { certPath, keyPath } = seedPair(new Date('2026-01-01'), 300);
    vi.setSystemTime(new Date('2026-01-02'));

    const renewer = makeRenewer(makeConfig({ certPath, keyPath }));
    renewer.onSessionReady();

    // Well past the 24.9-day ceiling, and past it several times over.
    vi.advanceTimersByTime(25 * DAY);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(123 * DAY);
    expect(sent).toHaveLength(0);

    // Half life is day 150; jitter adds up to 15 days.
    const firedOnDay = 149 + advanceUntilSent(renewer, 18);
    expect(firedOnDay).toBeGreaterThanOrEqual(150);
    expect(firedOnDay).toBeLessThanOrEqual(166);
  });

  it('installs a renewed certificate and reconnects to prove it works', () => {
    const { certPath, keyPath } = seedPair(new Date('2026-01-01'), 90);
    const caCertPath = join(dir, 'ca.crt');
    vi.setSystemTime(new Date('2026-03-02'));

    const renewer = makeRenewer(makeConfig({ certPath, keyPath, caCertPath }));
    renewer.onSessionReady();

    const before = readFileSync(certPath, 'utf8');
    const renewed = certifyOutstandingCsr(new Date('2026-03-02'), 90);

    renewer.onResponse({
      success: true,
      errorDetail: '',
      certificatePem: renewed,
      caCertificatePem: forge.pki.certificateToPem(ca.cert),
      notAfter: undefined,
    });

    const after = readFileSync(certPath, 'utf8');
    expect(after).not.toBe(before);
    expect(after.trim()).toBe(renewed.trim());
    expect(reconnects).toEqual(['client certificate renewed']);

    // The pair on disk has to still match, or the worker has locked itself out.
    expect(
      new X509Certificate(after).checkPrivateKey(createPrivateKey(readFileSync(keyPath, 'utf8'))),
    ).toBe(true);

    expect(readFileSync(caCertPath, 'utf8').trim()).toBe(
      forge.pki.certificateToPem(ca.cert).trim(),
    );
  });

  it('keeps the private key secret-file permissions on renewal', () => {
    const { certPath, keyPath } = seedPair(new Date('2026-01-01'), 90);
    vi.setSystemTime(new Date('2026-03-02'));

    const renewer = makeRenewer(makeConfig({ certPath, keyPath }));
    renewer.onSessionReady();
    renewer.onResponse({
      success: true,
      errorDetail: '',
      certificatePem: certifyOutstandingCsr(new Date('2026-03-02'), 90),
      caCertificatePem: '',
      notAfter: undefined,
    });

    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it('refuses a certificate that does not match the key it asked for', () => {
    const { certPath, keyPath } = seedPair(new Date('2026-01-01'), 90);
    vi.setSystemTime(new Date('2026-03-02'));

    const renewer = makeRenewer(makeConfig({ certPath, keyPath }));
    renewer.onSessionReady();

    const originalCert = readFileSync(certPath, 'utf8');
    const originalKey = readFileSync(keyPath, 'utf8');

    // A certificate over somebody else's key. Installing it would leave a
    // mismatched pair on disk, which survives restarts and locks the worker out
    // exactly as an expiry would.
    const stranger = generateCsr('worker-1').privateKeyPem;
    const strangerPublic = createPublicKey(stranger).export({
      type: 'spki',
      format: 'pem',
    }) as string;

    renewer.onResponse({
      success: true,
      errorDetail: '',
      certificatePem: issue(strangerPublic, new Date('2026-03-02'), 90),
      caCertificatePem: '',
      notAfter: undefined,
    });

    expect(readFileSync(certPath, 'utf8')).toBe(originalCert);
    expect(readFileSync(keyPath, 'utf8')).toBe(originalKey);
    expect(reconnects).toEqual([]);
  });

  it('keeps the existing certificate and retries when renewal is refused', () => {
    const { certPath, keyPath } = seedPair(new Date('2026-01-01'), 90);
    vi.setSystemTime(new Date('2026-03-02'));

    const renewer = makeRenewer(makeConfig({ certPath, keyPath }));
    renewer.onSessionReady();
    const original = readFileSync(certPath, 'utf8');

    renewer.onResponse({
      success: false,
      errorDetail: 'Worker auth mode "mtls" is not enabled on this control plane.',
      certificatePem: '',
      caCertificatePem: '',
      notAfter: undefined,
    });

    expect(readFileSync(certPath, 'utf8')).toBe(original);
    expect(reconnects).toEqual([]);

    // Retried an hour later rather than abandoned: there are weeks of validity
    // left, so a refusal now is not a reason to stop trying.
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(61 * 60 * 1000);
    expect(sent).toHaveLength(2);
  });

  it('retries when the response never arrives', () => {
    const { certPath, keyPath } = seedPair(new Date('2026-01-01'), 90);
    vi.setSystemTime(new Date('2026-03-02'));

    const renewer = makeRenewer(makeConfig({ certPath, keyPath }));
    renewer.onSessionReady();
    expect(sent).toHaveLength(1);

    vi.advanceTimersByTime(61_000);
    expect(sent).toHaveLength(1);

    vi.advanceTimersByTime(61 * 60 * 1000);
    expect(sent).toHaveLength(2);
  });

  it('abandons an outstanding renewal when the session drops', () => {
    const { certPath, keyPath } = seedPair(new Date('2026-01-01'), 90);
    vi.setSystemTime(new Date('2026-03-02'));

    const renewer = makeRenewer(makeConfig({ certPath, keyPath }));
    renewer.onSessionReady();
    const original = readFileSync(certPath, 'utf8');
    const renewed = certifyOutstandingCsr(new Date('2026-03-02'), 90);

    renewer.onDisconnect();

    // A reply for a request whose key we dropped must not be installed: the key
    // it was issued over no longer exists anywhere.
    renewer.onResponse({
      success: true,
      errorDetail: '',
      certificatePem: renewed,
      caCertificatePem: '',
      notAfter: undefined,
    });

    expect(readFileSync(certPath, 'utf8')).toBe(original);
    expect(reconnects).toEqual([]);
  });

  it('stops scheduling once stopped', () => {
    const { certPath, keyPath } = seedPair(new Date('2026-01-01'), 90);
    vi.setSystemTime(new Date('2026-01-02'));

    const renewer = makeRenewer(makeConfig({ certPath, keyPath }));
    renewer.onSessionReady();
    renewer.stop();

    vi.advanceTimersByTime(90 * 24 * 60 * 60 * 1000);
    expect(sent).toHaveLength(0);
  });

  it('survives an unreadable certificate without throwing', () => {
    const renewer = makeRenewer(
      makeConfig({ certPath: join(dir, 'missing.crt'), keyPath: join(dir, 'missing.key') }),
    );
    expect(() => renewer.onSessionReady()).not.toThrow();
    expect(sent).toHaveLength(0);
  });
});
