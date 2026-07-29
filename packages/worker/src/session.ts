import * as grpc from '@grpc/grpc-js';
import { readFileSync } from 'node:fs';
import type { Logger } from 'pino';
import {
  WorkerHubClient,
  type ServerMessage,
  type WorkerMessage,
  type ConfigUpdate,
  type Capability,
  effectiveCapabilities,
  isMaxCapabilityTier,
} from '@rsagent/protocol';
import type { WorkerConfig } from './config.js';
import { Backoff } from './backoff.js';

/**
 * The persistent outbound session to the control plane.
 *
 * The worker always dials out — there is no listening socket anywhere on the
 * SQL host. This is the property the whole product rests on (§3.2.1) and
 * nothing in this file may ever open a port.
 */

export interface SessionEvents {
  onReady: (capabilities: Capability[], config: ConfigUpdate | undefined) => void;
  onCommand: (message: ServerMessage) => void;
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

  #credentials(): grpc.ChannelCredentials {
    const tls = this.config.controlPlane.tls;
    if (!tls.enabled) {
      // Development only. M3 makes mTLS mandatory and removes this path.
      this.logger.warn(
        'Control plane connection is NOT using TLS. This is acceptable only for local development.',
      );
      return grpc.credentials.createInsecure();
    }

    const rootCert = tls.caCertPath ? readFileSync(tls.caCertPath) : null;
    const clientCert = tls.clientCertPath ? readFileSync(tls.clientCertPath) : null;
    const clientKey = tls.clientKeyPath ? readFileSync(tls.clientKeyPath) : null;
    return grpc.credentials.createSsl(rootCert, clientKey, clientCert);
  }

  #connect(): void {
    if (this.#stopped) return;

    const address = this.config.controlPlane.address;
    this.logger.info({ address, attempt: this.#backoff.attempt }, 'Connecting to control plane');

    this.#client = new WorkerHubClient(address, this.#credentials(), {
      'grpc.keepalive_time_ms': 30_000,
      'grpc.keepalive_timeout_ms': 10_000,
      'grpc.keepalive_permit_without_calls': 1,
      'grpc.max_receive_message_length': 32 * 1024 * 1024,
    });

    const stream = this.#client.session();
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

        this.#connected = true;
        this.#backoff.reset();
        this.logger.info(
          { workerId: ack.workerId, capabilities: this.#capabilities },
          'Session established',
        );
        this.events.onReady(this.#capabilities, ack.config);
        return;
      }

      this.events.onCommand(message);
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

    const delay = this.#backoff.next();
    this.logger.warn({ reason, retryInMs: delay }, 'Disconnected from control plane');
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
    this.#reconnectTimer.unref();
  }
}
