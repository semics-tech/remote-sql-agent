/**
 * jobUuid -> commandId for changes a worker just made itself, so the next
 * observed delta for that job can be attributed to the command rather than
 * reported as an on-prem edit.
 *
 * The happy path consumes an entry on the very next poll that sees the job's
 * hash change. Several paths never reach that: a toggle applied to a value
 * the job already had produces no hash change at all, a delta the server
 * refuses is deliberately left for retry and may never succeed, and a job
 * deleted before its next poll is never iterated again. All three leave an
 * entry orphaned — for a worker meant to run for months, permanently. The
 * TTL bounds that: generous relative to a normal poll interval, since the
 * cost of expiring one early is only that one delta going unattributed.
 */
export class PendingAttributionMap {
  #entries = new Map<string, { commandId: string; setAt: number }>();

  constructor(private readonly ttlMs: number) {}

  set(jobUuid: string, commandId: string, now = Date.now()): void {
    this.#sweep(now);
    this.#entries.set(jobUuid, { commandId, setAt: now });
  }

  get(jobUuid: string): string | undefined {
    return this.#entries.get(jobUuid)?.commandId;
  }

  delete(jobUuid: string): void {
    this.#entries.delete(jobUuid);
  }

  get size(): number {
    return this.#entries.size;
  }

  #sweep(now: number): void {
    const cutoff = now - this.ttlMs;
    for (const [jobUuid, entry] of this.#entries) {
      if (entry.setAt > cutoff) continue;
      this.#entries.delete(jobUuid);
    }
  }
}
