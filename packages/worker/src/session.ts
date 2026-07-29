import type * as grpc from '@grpc/grpc-js';
import type { Logger } from 'pino';
import {
  WorkerHubClient,
  type ServerMessage,
  type WorkerMessage,
  type ConfigUpdate,
  type Capability,
  effectiveCapabilities,
  isMaxCapabilityTier,
} from '@remote-sql-agent/protocol';
import type { WorkerConfig } from './config.js';
import { Backoff } from './backoff.js';
import { buildCallMetadata, buildChannelCredentials, CredentialError } from './credentials.js';

/**
 * The persistent outbound session to the control plane.
 *
 * The worker always dials out — there is no listening socket anywhere on the
 * SQL host. This is the property the whole product rests on (§3.2.1) and
 * nothing in this file may ever open a port.
 */

export interface SessionEvents {
  onReady: (capabilities: Capability[], config: ConfigUpdate | undefined) => void;
  /** Every server message except HelloAck: commands and configuration. */
  onMessage: (message: ServerMessage) => void;
  onDisconnect: (reason: string) => void;
}

export class ControlPlaneSession {
  #client: WorkerHubClient | null = null;
  #stream: grpc.ClientDuplexStream<WorkerMessage, ServerMessage> | null = null;
  #backoff: Backoff;
  #stopped = false;
  #connected = false;
  #reconnectTimer: NodeJS.Timeout | null = null;

  /** Effective capabilities, re-derived locally rather than trusted from the server. */
  #capabilities: Capability[] = ['observe'];

  /** PEM public key used to verify that a command really came from the control
   * plane. Delivered in HelloAck over the authenticated channel. */
  #commandSigningPublicKey = '';

  constructor(
    private readonly config: WorkerConfig,
    private readonly logger: Logger,
    private readonly events: SessionEvents,
    private readonly buildHello: () => WorkerMessage,
  ) {
    this.#backoff = new Backoff(
      config.controlPlane.reconnect.initialDelayMs,
      config.controlPlane.reconnect.maxDelayMs,
      config.controlPlane.reconnect.jitterRatio,
    );
  }

  get connected(): boolean {
    return this.#connected;
  }

  get capabilities(): Capability[] {
    return this.#capabilities;
  }

  get commandSigningPublicKey(): string {
    return this.#commandSigningPublicKey;
  }

  start(): void {
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#stream?.end();
    this.#client?.close();
    this.#connected = false;
  }

  /**
   * Send a message. Returns false when the stream is not writable, which is the
   * caller's signal to keep the payload in the outbox rather than drop it.
   */
  send(message: WorkerMessage): boolean {
    if (!this.#stream || !this.#connected) return false;
    try {
      return this.#stream.write(message);
    } catch (err) {
      this.logger.warn({ err }, 'Failed to write to control plane stream');
      return false;
    }
  }

  #connect(): void {
    void this.#connectAsync();
  }

  async #connectAsync(): Promise<void> {
    if (this.#stopped) return;

    const address = this.config.controlPlane.address;
    this.logger.info(
      { address, attempt: this.#backoff.attempt, authMode: this.config.controlPlane.auth.mode },
      'Connecting to control plane',
    );

    if (!this.config.controlPlane.tls.enabled) {
      this.logger.warn(
        'Control plane connection is NOT using TLS. This is acceptable only for local development.',
      );
    }

    // Credentials are resolved per connection rather than once at startup: an
    // Entra token is short-lived and a rotated API key must be picked up on the
    // next reconnect without restarting the service.
    let metadata: grpc.Metadata;
    try {
      metadata = await buildCallMetadata(this.config);
    } catch (err) {
      // A missing or unreadable credential is not transient. Log it plainly and
      // keep retrying on the same backoff, so the operator sees the reason
      // rather than a generic connection failure.
      const message = err instanceof CredentialError ? err.message : String(err);
      this.logger.error({ err }, `Cannot present a worker credential: ${message}`);
      this.#scheduleReconnect('missing credential');
      return;
    }

    this.#client = new WorkerHubClient(address, buildChannelCredentials(this.config), {
      'grpc.keepalive_time_ms': 30_000,
      'grpc.keepalive_timeout_ms': 10_000,
      'grpc.keepalive_permit_without_calls': 1,
      'grpc.max_receive_message_length': 32 * 1024 * 1024,
    });

    const stream = this.#client.session(metadata);
    this.#stream = stream;

    stream.on('data', (message: ServerMessage) => {
      const msg = message.msg;
      if (!msg) return;

      if (msg.$case === 'helloAck') {
        const ack = msg.helloAck;
        // Re-derive the effective set locally. The server's arithmetic is
        // advisory; the worker's own ceiling is the authority (§6.3).
        const ceiling = isMaxCapabilityTier(this.config.maxCapability)
          ? this.config.maxCapability
          : 'readOnly';
        this.#capabilities = effectiveCapabilities(ack.capabilities, ceiling);

        if (ack.capabilities.length !== this.#capabilities.length) {
          this.logger.warn(
            { granted: ack.capabilities, effective: this.#capabilities, ceiling },
            'Control plane granted capabilities beyond this worker local ceiling; the extra grants are ignored',
          );
        }

        this.#commandSigningPublicKey = ack.commandSigningPublicKey;
        if (!this.#commandSigningPublicKey && this.#capabilities.length > 1) {
          // Without it, no command can be verified — and an unverifiable command
          // must never be applied, so say why now rather than at apply time.
          this.logger.error(
            'The control plane granted write capabilities but sent no command signing key. ' +
              'Commands cannot be verified and will all be refused.',
          );
        }

        this.#connected = true;
        this.#backoff.reset();
        this.logger.info(
          { workerId: ack.workerId, capabilities: this.#capabilities },
          'Session established',
        );
        this.events.onReady(this.#capabilities, ack.config);
        return;
      }

      this.events.onMessage(message);
    });

    stream.on('error', (err: Error) => {
      this.#handleDisconnect(`stream error: ${err.message}`);
    });

    stream.on('end', () => {
      this.#handleDisconnect('server closed the stream');
    });

    // Hello must be the first message: the server keys the whole session off it.
    stream.write(this.buildHello());
  }

  #handleDisconnect(reason: string): void {
    if (!this.#connected && this.#reconnectTimer) return; // already scheduled
    this.#connected = false;
    this.#stream = null;
    this.#client?.close();
    this.#client = null;

    this.events.onDisconnect(reason);
    if (this.#stopped) return;

    // An authentication failure is a configuration problem, not a blip. Say so
    // explicitly rather than burying it in a generic reconnect warning that an
    // operator will read as a network issue.
    if (/UNAUTHENTICATED|PERMISSION_DENIED/u.test(reason)) {
      this.logger.error(
        { reason, authMode: this.config.controlPlane.auth.mode },
        'The control plane rejected this worker credential. Check that the worker is enrolled and ' +
          'its key or certificate has not been revoked or expired.',
      );
    }

    this.#scheduleReconnect(reason);
  }

  #scheduleReconnect(reason: string): void {
    if (this.#stopped || this.#reconnectTimer) return;
    const delay = this.#backoff.next();
    this.logger.warn({ reason, retryInMs: delay }, 'Disconnected from control plane');
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
    this.#reconnectTimer.unref();
  }
}
