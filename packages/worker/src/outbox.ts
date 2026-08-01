import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type Database } from './sqlite.js';

/**
 * Local durable outbox (§5.4).
 *
 * History and log deltas queue here when the control plane is unreachable and
 * drain on reconnect. Bounded, with oldest-first eviction that is logged and
 * reported rather than silent — a quietly truncated audit trail is worse than
 * a noisy one.
 *
 * Commands are deliberately *not* queued here: an offline worker cannot receive
 * them, and the control plane holds pending commands with a TTL instead.
 */

export type OutboxKind = 'history' | 'activity' | 'agentLog';

export interface OutboxRow {
  id: number;
  kind: OutboxKind;
  instanceName: string;
  payload: string;
  createdAt: number;
}

export interface OutboxStats {
  depth: number;
  evicted: number;
}

export class Outbox {
  readonly #db: Database;
  readonly #maxRows: number;
  #evicted = 0;

  constructor(path: string, maxRows: number) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#maxRows = maxRows;

    // WAL keeps the writer from blocking on reads during a drain, and is the
    // difference between a wedged poller and a smooth one on a busy instance.
    //
    // Issued through exec() because node:sqlite has no pragma() helper. Worth
    // knowing: journal_mode returns the mode it actually settled on, and
    // exec() discards it. SQLite refuses WAL on a network filesystem and stays
    // in delete mode instead, so a worker whose state directory is on a share
    // is slower under drain but still correct. It is not silent corruption,
    // which is why this does not fail the start.
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA synchronous = NORMAL');

    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS outbox (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        kind          TEXT    NOT NULL,
        instance_name TEXT    NOT NULL,
        payload       TEXT    NOT NULL,
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbox_id_idx ON outbox (id);

      -- Idempotency records for applied commands (§5.4). Retained separately
      -- from the outbox because they must survive a drain.
      CREATE TABLE IF NOT EXISTS applied_commands (
        command_id TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL,
        success    INTEGER NOT NULL,
        result     TEXT
      );

      -- Sync bookmarks, so a worker restart does not re-ship all history.
      CREATE TABLE IF NOT EXISTS sync_state (
        instance_name           TEXT PRIMARY KEY,
        history_high_water_mark INTEGER NOT NULL DEFAULT 0,
        agent_log_high_water    INTEGER,
        definition_hashes       TEXT
      );
    `);
  }

  enqueue(kind: OutboxKind, instanceName: string, payload: unknown): void {
    this.#db
      .prepare(
        'INSERT INTO outbox (kind, instance_name, payload, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(kind, instanceName, JSON.stringify(payload), Date.now());
    this.#evictIfNeeded();
  }

  #evictIfNeeded(): void {
    const { depth } = this.#db.prepare('SELECT COUNT(*) AS depth FROM outbox').get() as {
      depth: number;
    };
    if (depth <= this.#maxRows) return;

    const excess = depth - this.#maxRows;
    const result = this.#db
      .prepare('DELETE FROM outbox WHERE id IN (SELECT id FROM outbox ORDER BY id ASC LIMIT ?)')
      .run(excess);
    // node:sqlite types changes as number | bigint — it hands back a number
    // until the count exceeds 2^53, which an outbox capped at maxRows never
    // will. Narrowed rather than asserted so the arithmetic stays honest.
    this.#evicted += Number(result.changes);
  }

  /** Read a batch without removing it; rows are only deleted once acknowledged. */
  peek(limit: number): OutboxRow[] {
    const rows = this.#db
      .prepare('SELECT id, kind, instance_name, payload, created_at FROM outbox ORDER BY id ASC LIMIT ?')
      .all(limit) as Array<{
      id: number;
      kind: string;
      instance_name: string;
      payload: string;
      created_at: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as OutboxKind,
      instanceName: r.instance_name,
      payload: r.payload,
      createdAt: r.created_at,
    }));
  }

  /**
   * Remove rows only after the send has been handed to the transport. Deleting
   * on read would lose the batch if the connection dropped mid-send — exactly
   * the case the outbox exists for.
   */
  acknowledge(ids: number[]): void {
    if (ids.length === 0) return;
    const del = this.#db.prepare('DELETE FROM outbox WHERE id = ?');

    // Written out rather than wrapped in a helper because node:sqlite has no
    // transaction() equivalent. The rollback matters: a partial acknowledgement
    // would drop rows the control plane never confirmed, which is the one
    // failure this whole table exists to prevent.
    this.#db.exec('BEGIN');
    try {
      for (const id of ids) del.run(id);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  stats(): OutboxStats {
    const { depth } = this.#db.prepare('SELECT COUNT(*) AS depth FROM outbox').get() as {
      depth: number;
    };
    return { depth, evicted: this.#evicted };
  }

  // -------------------------------------------------------------------------
  // Sync bookmarks
  // -------------------------------------------------------------------------

  getHistoryHighWaterMark(instanceName: string): number {
    const row = this.#db
      .prepare('SELECT history_high_water_mark AS hwm FROM sync_state WHERE instance_name = ?')
      .get(instanceName) as { hwm: number } | undefined;
    return row?.hwm ?? 0;
  }

  setHistoryHighWaterMark(instanceName: string, value: number): void {
    this.#db
      .prepare(
        `INSERT INTO sync_state (instance_name, history_high_water_mark)
         VALUES (?, ?)
         ON CONFLICT (instance_name) DO UPDATE SET
           history_high_water_mark = MAX(history_high_water_mark, excluded.history_high_water_mark)`,
      )
      .run(instanceName, value);
  }

  getAgentLogHighWaterMark(instanceName: string): Date | null {
    const row = this.#db
      .prepare('SELECT agent_log_high_water AS hwm FROM sync_state WHERE instance_name = ?')
      .get(instanceName) as { hwm: number | null } | undefined;
    return row?.hwm ? new Date(row.hwm) : null;
  }

  setAgentLogHighWaterMark(instanceName: string, value: Date): void {
    this.#db
      .prepare(
        `INSERT INTO sync_state (instance_name, agent_log_high_water)
         VALUES (?, ?)
         ON CONFLICT (instance_name) DO UPDATE SET
           agent_log_high_water = MAX(COALESCE(agent_log_high_water, 0), excluded.agent_log_high_water)`,
      )
      .run(instanceName, value.getTime());
  }

  /** Last-known definition hashes, so a restart does not re-upload every job. */
  getDefinitionHashes(instanceName: string): Map<string, string> {
    const row = this.#db
      .prepare('SELECT definition_hashes AS hashes FROM sync_state WHERE instance_name = ?')
      .get(instanceName) as { hashes: string | null } | undefined;
    if (!row?.hashes) return new Map();
    try {
      return new Map(Object.entries(JSON.parse(row.hashes) as Record<string, string>));
    } catch {
      return new Map();
    }
  }

  setDefinitionHashes(instanceName: string, hashes: Map<string, string>): void {
    const json = JSON.stringify(Object.fromEntries(hashes));
    this.#db
      .prepare(
        `INSERT INTO sync_state (instance_name, definition_hashes)
         VALUES (?, ?)
         ON CONFLICT (instance_name) DO UPDATE SET definition_hashes = excluded.definition_hashes`,
      )
      .run(instanceName, json);
  }

  // -------------------------------------------------------------------------
  // Command idempotency (§5.4)
  // -------------------------------------------------------------------------

  hasAppliedCommand(commandId: string): boolean {
    const row = this.#db
      .prepare('SELECT 1 AS present FROM applied_commands WHERE command_id = ?')
      .get(commandId);
    return row !== undefined;
  }

  /**
   * What happened the first time this command was applied, or null if it never
   * was.
   *
   * The outcome has always been stored; nothing read it. The idempotency gate
   * checked existence alone and synthesised `success: true`, so a redelivered
   * command that had *failed* was reported as having succeeded — the operator
   * saw a green result for a change msdb had refused.
   */
  appliedCommandOutcome(
    commandId: string,
  ): { success: boolean; result: string | null } | null {
    const row = this.#db
      .prepare('SELECT success, result FROM applied_commands WHERE command_id = ?')
      .get(commandId) as { success: number; result: string | null } | undefined;
    return row === undefined ? null : { success: row.success === 1, result: row.result };
  }

  recordAppliedCommand(commandId: string, success: boolean, result: string | null): void {
    this.#db
      .prepare(
        `INSERT INTO applied_commands (command_id, applied_at, success, result)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (command_id) DO NOTHING`,
      )
      .run(commandId, Date.now(), success ? 1 : 0, result);
  }

  close(): void {
    this.#db.close();
  }
}
