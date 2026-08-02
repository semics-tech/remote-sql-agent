import { readFileSync } from 'node:fs';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import type { Logger } from 'pino';
import type { CertificateRenewalResponse, WorkerMessage } from '@remote-sql-agent/protocol';
import type { WorkerConfig } from './config.js';
import { generateCsr } from './csr.js';
import { writeSecretFile } from './secret-file.js';

/**
 * Keeps this worker's mTLS client certificate current.
 *
 * The control plane issues 90-day certificates and enforces expiry on every
 * connection. Before this existed, enrolment was the only issuance path, so a
 * certificate reaching its expiry meant a worker that could no longer connect
 * and an administrator who had to mint a fresh single-use token for the host —
 * per host, every quarter, across the estate. Nothing warned first.
 *
 * So: renew at half-life, over the session the current certificate already
 * authenticated, exactly as kubelet and EST `simplereenroll` do. Renewing early
 * is the whole point — it leaves a window as long as the renewal interval in
 * which every attempt can fail harmlessly and be retried, while the certificate
 * in hand still works.
 *
 * A worker that stays offline past its expiry cannot recover on its own and has
 * to be re-enrolled. That is deliberate: recovering from it would need a second
 * credential kept for the purpose, which is a standing key whose only job is to
 * be valid after the primary one stopped being.
 */

/** How far into the certificate's life to renew. Vault Agent's heuristic. */
const RENEW_AT_LIFETIME_FRACTION = 0.5;

/**
 * Spread across an estate so a hundred workers enrolled by the same script on
 * the same afternoon do not all renew in the same minute forever after.
 */
const JITTER_FRACTION = 0.05;

/** Between failed attempts. Small against the half-lifetime of runway available. */
const RETRY_DELAY_MS = 60 * 60 * 1000;

/** A renewal that gets no answer at all should not wedge the state machine. */
const RESPONSE_TIMEOUT_MS = 60_000;

/**
 * setTimeout is capped at 2^31-1 ms (~24.9 days) and silently fires *immediately*
 * past it — which for a 90-day certificate renewing at 45 days would mean
 * renewing in a hot loop from the moment the session came up.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface RenewerDeps {
  send: (message: WorkerMessage) => boolean;
  /** Called once a new certificate is on disk, to prove it works while the old one still does. */
  reconnect: (reason: string) => void;
}

export class CertificateRenewer {
  #timer: NodeJS.Timeout | null = null;
  #responseTimer: NodeJS.Timeout | null = null;
  /** Held between sending a CSR and the reply that certifies it. */
  #pendingPrivateKeyPem: string | null = null;
  #stopped = false;

  constructor(
    private readonly config: WorkerConfig,
    private readonly logger: Logger,
    private readonly deps: RenewerDeps,
  ) {}

  get enabled(): boolean {
    return this.config.controlPlane.auth.mode === 'mtls';
  }

  /** Called whenever a session reaches Ready. Safe to call repeatedly. */
  onSessionReady(): void {
    if (!this.enabled || this.#stopped) return;
    this.#clearTimers();
    this.#pendingPrivateKeyPem = null;
    this.#scheduleFromCertificate();
  }

  onDisconnect(): void {
    // The reply can only arrive on a live session, so a disconnect mid-renewal
    // abandons this attempt rather than leaving a key waiting for a certificate
    // that will never come.
    this.#clearTimers();
    this.#pendingPrivateKeyPem = null;
  }

  stop(): void {
    this.#stopped = true;
    this.#clearTimers();
    this.#pendingPrivateKeyPem = null;
  }

  /** Feed the server's reply in. Ignored unless a renewal is actually outstanding. */
  onResponse(response: CertificateRenewalResponse): void {
    if (!this.enabled || this.#stopped) return;

    const privateKeyPem = this.#pendingPrivateKeyPem;
    this.#pendingPrivateKeyPem = null;
    if (this.#responseTimer) {
      clearTimeout(this.#responseTimer);
      this.#responseTimer = null;
    }

    if (!privateKeyPem) {
      this.logger.warn('Received a certificate renewal response without an outstanding request');
      return;
    }

    if (!response.success || !response.certificatePem) {
      this.logger.error(
        { detail: response.errorDetail },
        'The control plane refused to renew this certificate. The current one is still valid; retrying.',
      );
      this.#scheduleRetry();
      return;
    }

    try {
      this.#install(response.certificatePem, response.caCertificatePem, privateKeyPem);
    } catch (err) {
      this.logger.error({ err }, 'Failed to store the renewed certificate; retrying');
      this.#scheduleRetry();
      return;
    }

    this.logger.info(
      { notAfter: response.notAfter ? tsToDate(response.notAfter)?.toISOString() : undefined },
      'Installed a renewed client certificate; reconnecting so it takes effect',
    );

    // Reconnect now rather than waiting for the old certificate to lapse. The
    // new one is only actually exercised by a TLS handshake, and finding out it
    // does not work is worth vastly more now — with weeks of validity left on
    // the old one and an operator able to intervene — than at expiry.
    this.deps.reconnect('client certificate renewed');
  }

  // ---------------------------------------------------------------------------

  #clearTimers(): void {
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#responseTimer) clearTimeout(this.#responseTimer);
    this.#timer = null;
    this.#responseTimer = null;
  }

  #scheduleFromCertificate(): void {
    const certPath = this.config.controlPlane.tls.clientCertPath;
    if (!certPath) return;

    let certificate: X509Certificate;
    try {
      certificate = new X509Certificate(readFileSync(certPath));
    } catch (err) {
      // Not fatal here: the session this runs on is already established, so the
      // certificate plainly worked. Something is wrong with reading it back,
      // and renewal is what would have fixed expiry — say so loudly.
      this.logger.error(
        { err, certPath },
        'Cannot read the client certificate to schedule renewal. This worker will NOT renew ' +
          'automatically and will stop connecting when its certificate expires.',
      );
      return;
    }

    const notBefore = Date.parse(certificate.validFrom);
    const notAfter = Date.parse(certificate.validTo);
    if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter) || notAfter <= notBefore) {
      this.logger.error(
        { validFrom: certificate.validFrom, validTo: certificate.validTo },
        'The client certificate has an unusable validity window; not scheduling renewal',
      );
      return;
    }

    const lifetimeMs = notAfter - notBefore;
    const jitterMs = lifetimeMs * JITTER_FRACTION * Math.random();
    const renewAt = notBefore + lifetimeMs * RENEW_AT_LIFETIME_FRACTION + jitterMs;
    const delay = Math.max(0, renewAt - Date.now());

    if (delay === 0) {
      this.logger.info(
        { notAfter: new Date(notAfter).toISOString() },
        'Client certificate is past half its lifetime; renewing now',
      );
      this.#requestRenewal();
      return;
    }

    this.logger.info(
      {
        notAfter: new Date(notAfter).toISOString(),
        renewAt: new Date(renewAt).toISOString(),
      },
      'Scheduled client certificate renewal',
    );
    this.#armTimer(delay);
  }

  /**
   * Arm the renewal timer, re-arming across the setTimeout ceiling rather than
   * firing early. A 90-day certificate renews at ~45 days, which is comfortably
   * past the cap.
   */
  #armTimer(delayMs: number): void {
    if (delayMs > MAX_TIMEOUT_MS) {
      this.#timer = setTimeout(() => this.#armTimer(delayMs - MAX_TIMEOUT_MS), MAX_TIMEOUT_MS);
      this.#timer.unref();
      return;
    }
    this.#timer = setTimeout(() => this.#requestRenewal(), delayMs);
    this.#timer.unref();
  }

  #scheduleRetry(): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => this.#requestRenewal(), RETRY_DELAY_MS);
    this.#timer.unref();
  }

  #requestRenewal(): void {
    if (this.#stopped || !this.enabled) return;
    this.#timer = null;

    let generated;
    try {
      generated = generateCsr(this.config.hostName);
    } catch (err) {
      this.logger.error({ err }, 'Could not generate a renewal CSR; retrying');
      this.#scheduleRetry();
      return;
    }

    const accepted = this.deps.send({
      msg: {
        $case: 'certificateRenewal',
        certificateRenewal: { csrPem: generated.csrPem },
      },
    });

    if (!accepted) {
      // Offline. Renewal only works on a live session, and `onSessionReady`
      // recomputes from the certificate on reconnect, so there is nothing to
      // hold here — the next successful connection picks it up.
      this.logger.warn('Not connected; deferring certificate renewal to the next session');
      return;
    }

    this.#pendingPrivateKeyPem = generated.privateKeyPem;
    this.#responseTimer = setTimeout(() => {
      this.#responseTimer = null;
      if (!this.#pendingPrivateKeyPem) return;
      this.#pendingPrivateKeyPem = null;
      this.logger.warn('No response to the certificate renewal request; retrying later');
      this.#scheduleRetry();
    }, RESPONSE_TIMEOUT_MS);
    this.#responseTimer.unref();

    this.logger.info('Requested a renewed client certificate');
  }

  /**
   * Put the new pair on disk.
   *
   * Checked against each other first. The key and the certificate live in two
   * files and cannot be replaced in one atomic step, so the failure worth
   * engineering away is writing a pair that never matched — a mismatch survives
   * restarts and locks the worker out exactly as an expiry would. Verifying
   * before either rename leaves only the gap between the two renames, which
   * contains no I/O.
   */
  #install(certificatePem: string, caCertificatePem: string, privateKeyPem: string): void {
    const { clientCertPath, clientKeyPath, caCertPath } = this.config.controlPlane.tls;
    if (!clientCertPath || !clientKeyPath) {
      throw new Error('controlPlane.tls.clientCertPath and clientKeyPath must be set for mTLS.');
    }

    const certificate = new X509Certificate(certificatePem);
    if (!certificate.checkPrivateKey(createPrivateKey(privateKeyPem))) {
      throw new Error(
        'The renewed certificate does not match the key it was requested for; discarding it.',
      );
    }

    writeSecretFile(clientKeyPath, privateKeyPem);
    writeSecretFile(clientCertPath, certificatePem);

    // Only when the operator asked us to manage the trust anchor. A caCertPath
    // they pointed at their own CA bundle is not ours to overwrite.
    if (caCertPath && caCertificatePem) {
      writeSecretFile(caCertPath, caCertificatePem, 0o644);
    }
  }
}

function tsToDate(ts: { seconds?: unknown; nanos?: unknown }): Date | undefined {
  const seconds = typeof ts.seconds === 'bigint' ? Number(ts.seconds) : Number(ts.seconds ?? NaN);
  if (!Number.isFinite(seconds)) return undefined;
  return new Date(seconds * 1000);
}
