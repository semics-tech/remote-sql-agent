import type { ServerMessage } from '@rsagent/protocol';

/**
 * In-memory registry of live worker sessions.
 *
 * Deliberately not persisted: a connection is only "live" for the process that
 * holds the socket. Control-plane HA is a non-goal for v1 (§2), and pretending
 * a connection is reachable from another node would be worse than not having
 * the feature.
 */

export interface LiveWorker {
  workerId: string;
  hostName: string;
  instanceIds: Map<string, string>; // instanceName -> instances.id
  send: (message: ServerMessage) => void;
  disconnect: (reason: string) => void;
  connectedAt: Date;
}

export class WorkerRegistry {
  readonly #byWorkerId = new Map<string, LiveWorker>();

  register(worker: LiveWorker): void {
    // A worker reconnecting before the old session is reaped would otherwise
    // leave a stale entry that swallows commands into a dead socket.
    const existing = this.#byWorkerId.get(worker.workerId);
    if (existing && existing !== worker) {
      existing.disconnect('superseded by a newer session from the same worker');
    }
    this.#byWorkerId.set(worker.workerId, worker);
  }

  unregister(workerId: string, session: LiveWorker): void {
    // Only remove if this exact session is still the registered one, so a slow
    // teardown of an old session cannot evict its replacement.
    if (this.#byWorkerId.get(workerId) === session) {
      this.#byWorkerId.delete(workerId);
    }
  }

  get(workerId: string): LiveWorker | undefined {
    return this.#byWorkerId.get(workerId);
  }

  isOnline(workerId: string): boolean {
    return this.#byWorkerId.has(workerId);
  }

  onlineWorkerIds(): string[] {
    return [...this.#byWorkerId.keys()];
  }

  get size(): number {
    return this.#byWorkerId.size;
  }
}
