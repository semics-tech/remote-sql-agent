import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, lt, or } from 'drizzle-orm';
import {
  APPROVAL_REQUIRED_BY_DEFAULT,
  COMMAND_CAPABILITY,
  canonicaliseJobWithHash,
  effectiveCapabilities,
  isMaxCapabilityTier,
  signCommand,
  toTimestamp,
  type Capability,
  type Command,
  type CommandKind,
  type Role,
} from '@remote-sql-agent/protocol';
import type { Database } from '../db/client.js';
import { commands, instances, jobs, users, workers, type CommandState } from '../db/schema.js';
import type { ServerConfig } from '../config.js';
import type { WorkerRegistry } from '../hub/registry.js';
import { writeAudit } from './audit.js';
import type { Logger } from 'pino';

/**
 * The command pipeline (§6.4).
 *
 *   dashboard action
 *     -> RBAC check (the API layer)
 *     -> capability check against the target worker
 *     -> persisted with the full intended definition, before anything is sent
 *     -> [optional] second-person approval
 *     -> signed and streamed to the worker
 *     -> worker validates signature, ceiling, freshness, idempotency, conflict
 *     -> result streamed back, persisted, version history updated
 *
 * The command is persisted *before* dispatch on purpose: the audit trail must
 * record what was asked for even when application fails, is refused, or the
 * worker never receives it.
 */

export class CommandError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

export interface CreateCommandInput {
  instanceId: string;
  kind: CommandKind;
  jobUuid?: string | null;
  /** Typed payload matching the command kind; stored verbatim for audit. */
  payload: Record<string, unknown>;
  /** Definition hash the edit was made against, for conflict detection. */
  baseDefinitionHash?: string | null;
  issuedBy: string;
  issuedByUsername: string;
  /** Decides whether the four-eyes rule applies to this issuer. */
  issuedByRole: Role;
  remoteAddress?: string | null;
}

export interface CreateCommandResult {
  id: string;
  state: CommandState;
  requiresApproval: boolean;
}

export class CommandService {
  constructor(
    private readonly db: Database,
    private readonly config: ServerConfig,
    private readonly registry: WorkerRegistry,
    private readonly signingPrivateKeyPem: string,
    private readonly logger: Logger,
  ) {}

  /**
   * Resolve the worker behind an instance and the capabilities that would
   * actually apply, i.e. the server grant intersected with the worker's own
   * reported ceiling. Showing the raw grant would tell an operator a command
   * will work when the worker is going to refuse it.
   */
  async effectiveCapabilitiesFor(instanceId: string): Promise<{
    workerId: string;
    hostName: string;
    capabilities: Capability[];
  }> {
    const [row] = await this.db
      .select({
        workerId: workers.id,
        hostName: workers.hostName,
        granted: workers.capabilities,
        ceiling: workers.maxCapabilityReported,
      })
      .from(instances)
      .innerJoin(workers, eq(workers.id, instances.workerId))
      .where(eq(instances.id, instanceId));

    if (!row) throw new CommandError(404, 'NotFound', 'No such instance.');

    // A worker that has never connected has reported no ceiling. Treat that as
    // read-only: failing closed is the only safe reading of "unknown".
    const reported = row.ceiling ?? '';
    const ceiling = isMaxCapabilityTier(reported) ? reported : 'readOnly';
    return {
      workerId: row.workerId,
      hostName: row.hostName,
      capabilities: effectiveCapabilities(row.granted, ceiling),
    };
  }

  /**
   * Whether this command needs a second person to approve it.
   *
   * Three things must line up: the site turned the rule on, the command kind is
   * one that changes a definition, and the issuer's role is not exempt. Exposed
   * so the dashboard can tell the operator *before* they start editing whether
   * their save will apply or queue.
   */
  requiresApproval(kind: CommandKind, role: Role): boolean {
    return (
      this.config.requireApprovalForJobWrite &&
      APPROVAL_REQUIRED_BY_DEFAULT.includes(kind) &&
      !this.config.approvalExemptRoles.includes(role)
    );
  }

  async create(input: CreateCommandInput): Promise<CreateCommandResult> {
    const required = COMMAND_CAPABILITY[input.kind];
    const { workerId, hostName, capabilities } = await this.effectiveCapabilitiesFor(
      input.instanceId,
    );

    if (!capabilities.includes(required)) {
      // Refuse here rather than dispatching and letting the worker reject it:
      // the operator gets an immediate, accurate reason, and we do not spend a
      // round trip discovering something we already knew.
      throw new CommandError(
        403,
        'CapabilityDenied',
        `Worker ${hostName} cannot ${required}. Its effective capabilities are: ${capabilities.join(', ')}. ` +
          `Grant the capability in Administration, and check the worker's own maxCapability setting.`,
      );
    }

    const requiresApproval = this.requiresApproval(input.kind, input.issuedByRole);

    const [row] = await this.db
      .insert(commands)
      .values({
        type: input.kind,
        instanceId: input.instanceId,
        workerId,
        jobUuid: input.jobUuid ?? null,
        payload: input.payload as never,
        baseDefinitionHash: input.baseDefinitionHash ?? null,
        state: requiresApproval ? 'pending_approval' : 'approved',
        issuedBy: input.issuedBy,
        approvedAt: requiresApproval ? null : new Date(),
        expiresAt: new Date(Date.now() + this.config.commandTtlSeconds * 1000),
      })
      .returning({ id: commands.id, state: commands.state });

    if (!row) throw new CommandError(500, 'Internal', 'Failed to record the command.');

    await writeAudit(this.db, {
      actorType: 'user',
      actor: input.issuedByUsername,
      action: 'command.issued',
      target: row.id,
      detail: {
        type: input.kind,
        instanceId: input.instanceId,
        jobUuid: input.jobUuid,
        requiresApproval,
        payload: auditablePayload(input.payload),
      },
      remoteAddress: input.remoteAddress ?? null,
    });

    if (!requiresApproval) await this.dispatch(row.id);

    return { id: row.id, state: row.state, requiresApproval };
  }

  /**
   * Approve a pending command.
   *
   * The approver must be a different person from the issuer. Without that, the
   * approval step is theatre — the whole point is that two people saw the
   * change (§6.4).
   */
  async approve(commandId: string, approverId: string, approverUsername: string, remoteAddress: string | null): Promise<void> {
    const [command] = await this.db.select().from(commands).where(eq(commands.id, commandId));
    if (!command) throw new CommandError(404, 'NotFound', 'No such command.');
    if (command.state !== 'pending_approval') {
      throw new CommandError(409, 'NotPending', `This command is already ${command.state}.`);
    }
    if (command.issuedBy === approverId) {
      throw new CommandError(
        403,
        'SelfApproval',
        'A command must be approved by someone other than the person who issued it.',
      );
    }
    if (command.expiresAt && command.expiresAt.getTime() < Date.now()) {
      await this.#markExpired(commandId);
      throw new CommandError(409, 'Expired', 'This command expired before it was approved.');
    }

    await this.db
      .update(commands)
      .set({ state: 'approved', approvedBy: approverId, approvedAt: new Date() })
      .where(eq(commands.id, commandId));

    await writeAudit(this.db, {
      actorType: 'user',
      actor: approverUsername,
      action: 'command.approved',
      target: commandId,
      detail: { type: command.type },
      remoteAddress,
    });

    await this.dispatch(commandId);
  }

  async reject(
    commandId: string,
    rejectorUsername: string,
    reason: string,
    remoteAddress: string | null,
  ): Promise<void> {
    const [command] = await this.db.select().from(commands).where(eq(commands.id, commandId));
    if (!command) throw new CommandError(404, 'NotFound', 'No such command.');
    if (command.state !== 'pending_approval') {
      throw new CommandError(409, 'NotPending', `This command is already ${command.state}.`);
    }

    await this.db
      .update(commands)
      .set({ state: 'rejected', resultDetail: reason, completedAt: new Date() })
      .where(eq(commands.id, commandId));

    await writeAudit(this.db, {
      actorType: 'user',
      actor: rejectorUsername,
      action: 'command.rejected',
      target: commandId,
      detail: { type: command.type, reason },
      remoteAddress,
    });
  }

  /**
   * Sign and stream a command to its worker.
   *
   * An offline worker is not an error: the command stays `approved` and is
   * dispatched when the worker next connects, or expires at its TTL. Commands
   * are deliberately never queued worker-side (§5.4).
   */
  async dispatch(commandId: string): Promise<boolean> {
    const [row] = await this.db
      .select({
        command: commands,
        instanceName: instances.instanceName,
      })
      .from(commands)
      .innerJoin(instances, eq(instances.id, commands.instanceId))
      .where(eq(commands.id, commandId));

    if (!row || row.command.state !== 'approved') return false;

    if (row.command.expiresAt && row.command.expiresAt.getTime() < Date.now()) {
      await this.#markExpired(commandId);
      return false;
    }

    const live = this.registry.get(row.command.workerId);
    if (!live) {
      this.logger.info(
        { commandId, workerId: row.command.workerId },
        'Worker is offline; command stays queued until it connects or expires',
      );
      return false;
    }

    const command = buildProtoCommand(
      row.command.id,
      row.command.type as CommandKind,
      row.instanceName,
      row.command.payload as Record<string, unknown>,
    );
    command.signature = signCommand(command, this.signingPrivateKeyPem);

    live.send({ msg: { $case: 'command', command } });

    await this.db
      .update(commands)
      .set({
        state: 'dispatched',
        dispatchedAt: new Date(),
        signature: Buffer.from(command.signature).toString('base64'),
      })
      .where(eq(commands.id, commandId));

    this.logger.info({ commandId, type: row.command.type }, 'Command dispatched');
    return true;
  }

  /** Dispatch everything queued for a worker that has just connected. */
  async dispatchPendingFor(workerId: string): Promise<number> {
    const pending = await this.db
      .select({ id: commands.id })
      .from(commands)
      .where(and(eq(commands.workerId, workerId), eq(commands.state, 'approved')))
      .orderBy(asc(commands.issuedAt));

    let sent = 0;
    for (const { id } of pending) {
      if (await this.dispatch(id)) sent += 1;
    }
    return sent;
  }

  /**
   * Record the outcome reported by the worker.
   *
   * Returns enough of the command for the caller to raise a notification about
   * it, or null when the command is unknown — which happens legitimately if a
   * worker reconnects and reports a result for something already expired.
   *
   * Scoped to the worker the command was dispatched to. Selecting on the id
   * alone let any authenticated worker finalise any command by guessing or
   * replaying an id, writing a forged audit row attributed to itself and
   * completing somebody else's change. A worker is trusted for its own
   * instances; it is not trusted for the estate.
   */
  async recordResult(params: {
    commandId: string;
    workerId: string;
    success: boolean;
    errorCode: string;
    errorDetail: string;
    sqlErrorNumber: number;
    hostName: string;
  }): Promise<{
    type: string;
    instanceId: string;
    jobUuid: string | null;
    issuedByUsername: string | null;
  } | null> {
    const [command] = await this.db
      .select()
      .from(commands)
      .where(and(eq(commands.id, params.commandId), eq(commands.workerId, params.workerId)));
    if (!command) {
      this.logger.warn(
        { commandId: params.commandId, workerId: params.workerId, hostName: params.hostName },
        'Result for a command this worker was not sent; ignoring',
      );
      return null;
    }

    await this.db
      .update(commands)
      .set({
        state: params.success ? 'succeeded' : 'failed',
        resultCode: params.success ? 'Ok' : params.errorCode,
        resultDetail: params.errorDetail || null,
        sqlErrorNumber: params.sqlErrorNumber || null,
        completedAt: new Date(),
      })
      .where(and(eq(commands.id, params.commandId), eq(commands.workerId, params.workerId)));

    await writeAudit(this.db, {
      actorType: 'worker',
      actor: params.hostName,
      action: params.success ? 'command.result' : 'command.result.failed',
      target: params.commandId,
      detail: {
        type: command.type,
        errorCode: params.errorCode || undefined,
        errorDetail: params.errorDetail || undefined,
        sqlErrorNumber: params.sqlErrorNumber || undefined,
      },
    });

    const [issuer] = command.issuedBy
      ? await this.db
          .select({ username: users.username })
          .from(users)
          .where(eq(users.id, command.issuedBy))
      : [];

    return {
      type: command.type,
      instanceId: command.instanceId,
      jobUuid: command.jobUuid,
      issuedByUsername: issuer?.username ?? null,
    };
  }

  /**
   * Expire commands that were never applied.
   *
   * A command that has been sitting unapproved or undelivered is not something
   * to apply later "when convenient" — the estate has moved on, and the
   * operator should re-issue against current state.
   */
  async expireStale(): Promise<number> {
    const expired = await this.db
      .update(commands)
      .set({
        state: 'expired',
        resultCode: 'Expired',
        resultDetail: 'The command expired before it was applied (worker offline or not approved in time).',
        completedAt: new Date(),
      })
      .where(
        and(
          or(
            eq(commands.state, 'pending_approval'),
            eq(commands.state, 'approved'),
            eq(commands.state, 'dispatched'),
          ),
          lt(commands.expiresAt, new Date()),
        ),
      )
      .returning({ id: commands.id });

    if (expired.length > 0) {
      this.logger.info({ count: expired.length }, 'Expired stale commands');
    }
    return expired.length;
  }

  async #markExpired(commandId: string): Promise<void> {
    await this.db
      .update(commands)
      .set({ state: 'expired', resultCode: 'Expired', completedAt: new Date() })
      .where(eq(commands.id, commandId));
  }

  /**
   * One command by id, with the same projection as `list`.
   *
   * Exists so the job editor can wait for the outcome of the save it just
   * issued. Creating a command only means it was queued and dispatched — the
   * worker may still refuse it seconds later, and until this existed there was
   * no way to ask about a single command without pulling the last hundred.
   */
  async byId(commandId: string) {
    const [row] = await this.list({ commandId, limit: 1 });
    return row ?? null;
  }

  async list(filter: { state?: CommandState; limit?: number; commandId?: string } = {}) {
    const conditions = [
      ...(filter.state ? [eq(commands.state, filter.state)] : []),
      ...(filter.commandId ? [eq(commands.id, filter.commandId)] : []),
    ];
    return this.db
      .select({
        id: commands.id,
        type: commands.type,
        state: commands.state,
        instanceId: commands.instanceId,
        instanceName: instances.instanceName,
        hostName: workers.hostName,
        jobUuid: commands.jobUuid,
        jobName: jobs.name,
        payload: commands.payload,
        issuedBy: commands.issuedBy,
        approvedBy: commands.approvedBy,
        resultCode: commands.resultCode,
        resultDetail: commands.resultDetail,
        // Written on failure since the write path shipped, but never selected —
        // so the one thing that lets a caller tell "you do not own this job"
        // (14525) from any other SQL failure was reaching the database and
        // stopping there.
        sqlErrorNumber: commands.sqlErrorNumber,
        issuedAt: commands.issuedAt,
        completedAt: commands.completedAt,
        expiresAt: commands.expiresAt,
      })
      .from(commands)
      .innerJoin(instances, eq(instances.id, commands.instanceId))
      .innerJoin(workers, eq(workers.id, commands.workerId))
      .leftJoin(
        jobs,
        and(eq(jobs.instanceId, commands.instanceId), eq(jobs.jobUuid, commands.jobUuid)),
      )
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(commands.issuedAt))
      .limit(Math.min(filter.limit ?? 100, 500));
  }

  async countPendingApproval(): Promise<number> {
    const rows = await this.db
      .select({ id: commands.id })
      .from(commands)
      .where(eq(commands.state, 'pending_approval'));
    return rows.length;
  }
}

/**
 * Map a stored payload onto the protobuf oneof.
 *
 * Explicit per kind rather than a generic spread: the wire contract is a closed
 * vocabulary, and a mismatch should fail here at compile time rather than
 * silently send an empty payload.
 */
export function buildProtoCommand(
  id: string,
  kind: CommandKind,
  instanceName: string,
  payload: Record<string, unknown>,
): Command {
  const base = {
    id,
    issuedAt: toTimestamp(new Date()),
    instanceName,
    signature: Buffer.alloc(0),
  };

  const str = (key: string): string => (typeof payload[key] === 'string' ? (payload[key] as string) : '');

  switch (kind) {
    case 'toggleJob':
      return {
        ...base,
        payload: {
          $case: 'toggleJob',
          toggleJob: {
            jobUuid: str('jobUuid'),
            enabled: payload.enabled === true,
            baseDefinitionHash: str('baseDefinitionHash'),
          },
        },
      };
    case 'runJob':
      return {
        ...base,
        payload: {
          $case: 'runJob',
          runJob: { jobUuid: str('jobUuid'), stepName: str('stepName') },
        },
      };
    case 'stopJob':
      return {
        ...base,
        payload: { $case: 'stopJob', stopJob: { jobUuid: str('jobUuid') } },
      };
    case 'upsertJob':
      return {
        ...base,
        payload: {
          $case: 'upsertJob',
          upsertJob: {
            jobUuid: str('jobUuid'),
            canonicalJson: str('canonicalJson'),
            baseDefinitionHash: str('baseDefinitionHash'),
            allowOverwrite: payload.allowOverwrite === true,
          },
        },
      };
    case 'deleteJob':
      return {
        ...base,
        payload: {
          $case: 'deleteJob',
          deleteJob: {
            jobUuid: str('jobUuid'),
            baseDefinitionHash: str('baseDefinitionHash'),
          },
        },
      };
    case 'upsertSchedule':
      return {
        ...base,
        payload: {
          $case: 'upsertSchedule',
          upsertSchedule: {
            scheduleUuid: str('scheduleUuid'),
            canonicalJson: str('canonicalJson'),
            baseDefinitionHash: str('baseDefinitionHash'),
          },
        },
      };
    case 'deleteSchedule':
      return {
        ...base,
        payload: {
          $case: 'deleteSchedule',
          deleteSchedule: {
            scheduleUuid: str('scheduleUuid'),
            baseDefinitionHash: str('baseDefinitionHash'),
          },
        },
      };
    case 'upsertOperator':
      return {
        ...base,
        payload: {
          $case: 'upsertOperator',
          upsertOperator: {
            operatorId: Number(payload.operatorId ?? 0),
            canonicalJson: str('canonicalJson'),
            baseDefinitionHash: str('baseDefinitionHash'),
          },
        },
      };
    case 'deleteOperator':
      return {
        ...base,
        payload: {
          $case: 'deleteOperator',
          deleteOperator: {
            operatorId: Number(payload.operatorId ?? 0),
            baseDefinitionHash: str('baseDefinitionHash'),
          },
        },
      };
    case 'setJobWriteAllowed':
      return {
        ...base,
        payload: {
          $case: 'setJobWriteAllowed',
          setJobWriteAllowed: {
            jobUuid: str('jobUuid'),
            // The allowlist is keyed on name, because that is what
            // sp_update_job takes and what a DBA reads when auditing it.
            jobName: str('jobName'),
            allowed: payload.allowed === true,
          },
        },
      };
  }
}

/** Validate and canonicalise a job definition submitted from the dashboard. */
/**
 * Fields of a command payload that may be written to the audit log.
 *
 * An **allowlist**, not a blocklist, and that is the whole point: a payload
 * field added for a new command kind is excluded until somebody decides it is
 * safe, rather than published to the SIEM the moment it is introduced.
 *
 * `canonicalJson` is the one deliberately absent — it is the full job
 * definition, and step bodies routinely carry connection strings (CLAUDE.md).
 * The pino config redacts `*.canonicalJson` for exactly this reason, but
 * `writeAudit` writes to a table and never passes through pino.
 */
const AUDITABLE_PAYLOAD_FIELDS = new Set([
  'jobUuid',
  'jobName',
  'enabled',
  'allowed',
  'stepName',
  'baseDefinitionHash',
  'allowOverwrite',
  'scheduleName',
  'operatorName',
]);

/**
 * A command payload reduced to what the audit trail needs.
 *
 * The definition is represented by its hash: enough to correlate an audit row
 * with a version in the timeline, which is what an auditor is actually doing,
 * without the trail becoming a second copy of every step body.
 */
export function auditablePayload(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) return {};

  const detail: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (AUDITABLE_PAYLOAD_FIELDS.has(key)) detail[key] = value;
  }

  const canonicalJson = (payload as { canonicalJson?: unknown }).canonicalJson;
  if (typeof canonicalJson === 'string' && canonicalJson.length > 0) {
    detail.definitionHash = createHash('sha256').update(canonicalJson).digest('hex');
    detail.definitionBytes = Buffer.byteLength(canonicalJson);
  }

  return detail;
}

export function prepareJobDefinition(definition: unknown): {
  canonicalJson: string;
  hash: string;
} {
  try {
    const { canonicalJson, hash } = canonicaliseJobWithHash(definition);
    return { canonicalJson, hash };
  } catch (err) {
    throw new CommandError(
      400,
      'InvalidDefinition',
      `That job definition is not valid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export { inArray };
