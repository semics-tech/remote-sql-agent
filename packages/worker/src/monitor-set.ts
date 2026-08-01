import type { Logger } from 'pino';
import type { InstanceConfig as WireInstanceConfig, InstanceInfo, WorkerMessage } from '@remote-sql-agent/protocol';
import { instanceConfigSchema, type InstanceConfig } from './config.js';
import { InstanceMonitor, type PollIntervals } from './instance-monitor.js';
import type { Outbox } from './outbox.js';
import {
  CredentialDecryptError,
  decryptCredential,
  type CredentialKeyPair,
} from './credential-key.js';

/**
 * The set of instances this worker is monitoring.
 *
 * Two sources feed it and they behave differently on purpose:
 *
 *   file   — entries in worker.yaml. Owned by whoever administers the host, and
 *            never removed by anything the control plane says.
 *   remote — configured from the dashboard. Reconciled to match exactly, so an
 *            instance removed there actually stops being monitored.
 *
 * Keeping the distinction means a control plane that has been taken over cannot
 * silently detach a worker from the instances its own operators configured.
 */

export type ConfigSource = 'file' | 'remote';

export interface InstanceConfigOutcome {
  instanceName: string;
  status: 'connected' | 'auth_failed' | 'unreachable' | 'decrypt_failed' | 'awaiting_credentials';
  detail: string;
}

interface Entry {
  monitor: InstanceMonitor;
  source: ConfigSource;
  /** Changes whenever the effective connection settings do. */
  signature: string;
}

export interface MonitorSetDeps {
  outbox: Outbox;
  logger: Logger;
  emit: (message: WorkerMessage) => boolean;
  credentialKey: CredentialKeyPair;
}

/** How often to retry a `worker.yaml` instance that would not connect. */
const RETRY_INTERVAL_MS = 60_000;

export class MonitorSet {
  #entries = new Map<string, Entry>();
  #intervals: PollIntervals | null = null;
  /**
   * `worker.yaml` instances that have not connected yet.
   *
   * These used to be dropped on the floor. `#ensure` returned an outcome
   * without inserting an entry, and `addLocal`'s outcomes are discarded by the
   * caller — so on a Windows reboot, where the service starts before msdb is
   * accepting connections, the worker gave up on the instance permanently,
   * reported zero instances, and went on touching its health file every 30 s.
   * Both unit files claim the worker exits on "no reachable SQL instance"; it
   * does not, and this is what makes that claim safe to drop rather than fix
   * by exiting.
   */
  #awaitingFirstConnect = new Map<string, InstanceConfig>();
  #retryTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: MonitorSetDeps) {}

  get size(): number {
    return this.#entries.size;
  }

  /** Instances configured on this host that have never connected. */
  get awaitingFirstConnect(): string[] {
    return [...this.#awaitingFirstConnect.keys()];
  }

  /** Stop retrying. Called on shutdown; safe to call twice. */
  stopRetrying(): void {
    if (this.#retryTimer) clearInterval(this.#retryTimer);
    this.#retryTimer = null;
  }

  #scheduleRetries(): void {
    if (this.#retryTimer || this.#awaitingFirstConnect.size === 0) return;
    this.#retryTimer = setInterval(() => {
      void this.#retryPending();
    }, RETRY_INTERVAL_MS);
    this.#retryTimer.unref();
  }

  async #retryPending(): Promise<void> {
    for (const [name, config] of [...this.#awaitingFirstConnect]) {
      const outcome = await this.#ensure(config, 'file', signatureOf(config));
      if (outcome.status === 'connected') {
        this.deps.logger.info({ instance: name }, 'Instance reachable again; now monitoring');
      }
    }
    if (this.#awaitingFirstConnect.size === 0) this.stopRetrying();
  }

  get(instanceName: string): InstanceMonitor | undefined {
    return this.#entries.get(instanceName)?.monitor;
  }

  monitors(): InstanceMonitor[] {
    return [...this.#entries.values()].map((e) => e.monitor);
  }

  /** Poll intervals are remembered so a later arrival starts on the same cadence. */
  setIntervals(intervals: PollIntervals): void {
    this.#intervals = intervals;
  }

  instanceInfos(): InstanceInfo[] {
    return this.monitors().map((m) => ({
      instanceName: m.instanceName,
      sqlVersion: m.identity?.sqlVersion ?? '',
      sqlEdition: m.identity?.sqlEdition ?? '',
      agentStatus: m.identity?.agentStatus ?? 'unknown',
      serverName: m.identity?.serverName ?? '',
      // Absent until the instance has connected once. An unknown write mode is
      // reported as "can edit nothing", so the dashboard errs towards saying an
      // edit is unavailable rather than offering one that fails.
      writeMode: m.writeMode ?? {
        sqlLoginName: '',
        isSysadmin: false,
        wrapperInstalled: false,
        wrapperAllowsDashboardManagement: false,
        allowlistedJobs: [],
      },
    }));
  }

  /** Bring up the instances listed in worker.yaml. */
  async addLocal(configs: InstanceConfig[]): Promise<InstanceConfigOutcome[]> {
    const outcomes: InstanceConfigOutcome[] = [];
    for (const config of configs) {
      outcomes.push(await this.#ensure(config, 'file', signatureOf(config)));
    }
    return outcomes;
  }

  /**
   * Make the remote-managed set match what the control plane asked for.
   *
   * Instances whose settings are unchanged keep their existing connection: a
   * reconnect drops the definition-hash cache, which would make every job on
   * that instance look changed on the next poll.
   */
  async reconcileRemote(wire: WireInstanceConfig[]): Promise<InstanceConfigOutcome[]> {
    const outcomes: InstanceConfigOutcome[] = [];
    const wanted = new Set<string>();

    for (const remote of wire) {
      wanted.add(remote.instanceName);

      const existing = this.#entries.get(remote.instanceName);
      if (existing?.source === 'file') {
        // worker.yaml wins. Saying so is better than silently ignoring the
        // dashboard's version and leaving an admin confused about which applies.
        outcomes.push({
          instanceName: remote.instanceName,
          status: 'connected',
          detail: 'This instance is configured in worker.yaml on the host, which takes precedence.',
        });
        continue;
      }

      let config: InstanceConfig;
      try {
        config = this.#toInstanceConfig(remote);
      } catch (err) {
        if (err instanceof AwaitingCredential) {
          outcomes.push({
            instanceName: remote.instanceName,
            status: 'awaiting_credentials',
            detail: err.message,
          });
          continue;
        }
        outcomes.push({
          instanceName: remote.instanceName,
          status: 'decrypt_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      const signature = signatureOf(config);
      if (existing && existing.signature === signature && existing.monitor.connectionPool) {
        outcomes.push({
          instanceName: remote.instanceName,
          status: 'connected',
          detail: '',
        });
        continue;
      }

      outcomes.push(await this.#ensure(config, 'remote', signature));
    }

    // Anything the dashboard no longer lists, and that the host did not
    // configure itself, stops being monitored.
    for (const [name, entry] of [...this.#entries]) {
      if (entry.source === 'remote' && !wanted.has(name)) {
        this.deps.logger.info({ instance: name }, 'Instance removed in the dashboard; disconnecting');
        await entry.monitor.close().catch(() => undefined);
        this.#entries.delete(name);
      }
    }

    return outcomes;
  }

  async #ensure(
    config: InstanceConfig,
    source: ConfigSource,
    signature: string,
  ): Promise<InstanceConfigOutcome> {
    const previous = this.#entries.get(config.name);
    if (previous) {
      await previous.monitor.close().catch(() => undefined);
      this.#entries.delete(config.name);
    }

    const monitor = new InstanceMonitor({
      config,
      outbox: this.deps.outbox,
      logger: this.deps.logger,
      emit: this.deps.emit,
    });

    try {
      await monitor.connect();
    } catch (err) {
      const status = classifyConnectionError(err);
      // A host-configured instance keeps being retried. `unreachable` is
      // routinely transient — a Windows reboot starts this service before msdb
      // accepts connections — and giving up on the first attempt is how a
      // worker ends up monitoring nothing while reporting itself healthy.
      // `auth_failed` is retried too: a rotated login is fixed by an
      // administrator, not by restarting the service.
      if (source === 'file') {
        if (!this.#awaitingFirstConnect.has(config.name)) {
          this.deps.logger.error(
            { err, instance: config.name, status, retryInMs: RETRY_INTERVAL_MS },
            'Could not connect to SQL Server instance; will keep retrying',
          );
        }
        this.#awaitingFirstConnect.set(config.name, config);
        this.#scheduleRetries();
      } else {
        this.deps.logger.error(
          { err, instance: config.name, status },
          'Could not connect to SQL Server instance',
        );
      }
      return {
        instanceName: config.name,
        status,
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    this.#awaitingFirstConnect.delete(config.name);
    this.#entries.set(config.name, { monitor, source, signature });

    // A newly configured instance must not sit idle until the next reconnect:
    // an admin who has just added it is watching for it to appear.
    if (this.#intervals) {
      try {
        await monitor.refreshIdentity();
        await monitor.sendSnapshot();
        monitor.startPolling(this.#intervals);
      } catch (err) {
        this.deps.logger.error(
          { err, instance: config.name },
          'Connected but failed to start monitoring',
        );
      }
    }

    this.deps.logger.info(
      { instance: config.name, server: config.server, source },
      'Monitoring instance',
    );
    return { instanceName: config.name, status: 'connected', detail: '' };
  }

  /** Decrypt the credential and shape it the way the pool builder expects. */
  #toInstanceConfig(remote: WireInstanceConfig): InstanceConfig {
    const { server, port } = splitServerAddress(remote.serverAddress);

    const base = {
      name: remote.instanceName,
      server,
      ...(port === undefined ? {} : { port }),
      encrypt: remote.encryptTls,
      trustServerCertificate: remote.trustServerCertificate,
    };

    if (remote.authMode !== 'sql') {
      // Integrated: the service account is the credential and nothing is stored.
      return instanceConfigSchema.parse(base);
    }

    if (!remote.credentialCiphertext) {
      throw new AwaitingCredential(
        'No SQL credential has been supplied for this instance yet.',
      );
    }

    const { password } = decryptCredential(
      remote.credentialCiphertext,
      remote.credentialKeyFingerprint,
      this.deps.credentialKey,
    );

    return instanceConfigSchema.parse({ ...base, user: remote.loginName, password });
  }

  startPollingAll(intervals: PollIntervals): void {
    this.#intervals = intervals;
    for (const { monitor } of this.#entries.values()) monitor.startPolling(intervals);
  }

  async closeAll(): Promise<void> {
    this.stopRetrying();
    this.#awaitingFirstConnect.clear();
    await Promise.all(this.monitors().map((m) => m.close().catch(() => undefined)));
    this.#entries.clear();
  }
}

/** Not an error so much as a state: configured, but not yet usable. */
class AwaitingCredential extends Error {}

/**
 * Everything that changes how the worker connects.
 *
 * The password is included via its ciphertext, so a rotated credential forces a
 * reconnect while an unchanged one does not.
 */
function signatureOf(config: InstanceConfig): string {
  return JSON.stringify([
    config.server,
    config.port ?? null,
    config.user ?? null,
    config.password ?? null,
    config.encrypt,
    config.trustServerCertificate,
  ]);
}

/**
 * "localhost", "localhost,1433", "localhost\\SQL2019" and the combination.
 *
 * A named instance stays in the server string — SQL Server's browser service
 * resolves it, and splitting it off would break the connection.
 */
export function splitServerAddress(address: string): { server: string; port?: number } {
  const commaIndex = address.lastIndexOf(',');
  if (commaIndex === -1) return { server: address.trim() };

  const port = Number(address.slice(commaIndex + 1).trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { server: address.trim() };
  }
  return { server: address.slice(0, commaIndex).trim(), port };
}

/**
 * Tell a rejected login apart from an unreachable server.
 *
 * This distinction is the whole reason the status travels back: "wrong
 * password" should put a re-enter prompt in front of an admin, and "host
 * unreachable" should not.
 */
export function classifyConnectionError(err: unknown): 'auth_failed' | 'unreachable' {
  const code = (err as { code?: string }).code;
  const number = (err as { number?: number }).number;
  const message = err instanceof Error ? err.message : String(err);

  // 18456 is SQL Server's own "Login failed for user". ELOGIN is what tedious
  // reports for the same thing.
  if (number === 18456 || code === 'ELOGIN' || /login failed/iu.test(message)) {
    return 'auth_failed';
  }
  return 'unreachable';
}

export { CredentialDecryptError };
