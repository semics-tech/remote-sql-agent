import type sql from 'mssql';
import type { Logger } from 'pino';
import {
  COMMAND_CAPABILITY,
  canonicaliseJobWithHash,
  commandKind,
  fromTimestamp,
  isCommandFresh,
  parseJobDefinition,
  scheduleDefinitionSchema,
  operatorDefinitionSchema,
  toTimestamp,
  verifyCommandSignature,
  type Capability,
  type Command,
  type CommandResult,
  type CommandKind,
  type JobDefinitionBlob,
} from '@remote-sql-agent/protocol';
import type { Outbox } from './outbox.js';
import { readJobs } from './sql/agent-repo.js';
import {
  SqlApplyError,
  deleteJob,
  deleteSchedule,
  startJob,
  stopJob,
  toggleJob,
  upsertJob,
  upsertOperator,
  upsertSchedule,
  setJobWriteAllowed,
} from './sql/agent-writer.js';

/**
 * Applying commands on the worker (§6.4).
 *
 * Five gates, in this order, before anything touches msdb:
 *
 *   1. signature      — the control plane really issued this
 *   2. freshness      — it is not a replay of an old capture
 *   3. capability     — this worker's *own* ceiling permits it
 *   4. idempotency    — it has not already been applied
 *   5. conflict       — live state still matches what the operator edited
 *
 * Every gate fails closed. In particular (3) is checked against local config,
 * not against anything the control plane said, so a compromised control plane
 * cannot talk a read-only worker into writing.
 */

export interface CommandContext {
  pool: sql.ConnectionPool;
  instanceName: string;
  capabilities: Capability[];
  outbox: Outbox;
  logger: Logger;
  commandSigningPublicKey: string;
}

interface ApplyOutcome {
  success: boolean;
  errorCode: string;
  errorDetail: string;
  sqlErrorNumber: number;
  resultingJob?: JobDefinitionBlob | undefined;
}

export async function handleCommand(
  command: Command,
  context: CommandContext,
): Promise<CommandResult> {
  const kind = commandKind(command) as CommandKind;
  const log = context.logger.child({ commandId: command.id, kind });

  const outcome = await evaluateAndApply(command, kind, context, log);

  if (outcome.success) {
    log.info('Command applied');
  } else {
    log.warn({ code: outcome.errorCode, detail: outcome.errorDetail }, 'Command refused or failed');
  }

  return {
    commandId: command.id,
    success: outcome.success,
    errorCode: outcome.errorCode,
    errorDetail: outcome.errorDetail,
    sqlErrorNumber: outcome.sqlErrorNumber,
    resultingJob: outcome.resultingJob,
    appliedAt: toTimestamp(new Date()),
  };
}

async function evaluateAndApply(
  command: Command,
  kind: CommandKind,
  context: CommandContext,
  log: Logger,
): Promise<ApplyOutcome> {
  // --- 1. Signature -------------------------------------------------------
  if (!context.commandSigningPublicKey) {
    return refuse(
      'NoSigningKey',
      'This worker has no command signing key, so it cannot verify that the control plane issued this command.',
    );
  }
  if (!verifyCommandSignature(command, context.commandSigningPublicKey)) {
    // Either forged, or tampered with in flight. Neither is worth applying, and
    // both are worth shouting about.
    log.error('Command signature verification failed');
    return refuse(
      'BadSignature',
      'The command signature did not verify against the control plane public key.',
    );
  }

  // --- 2. Freshness -------------------------------------------------------
  const issuedAt = fromTimestamp(command.issuedAt);
  if (!issuedAt || !isCommandFresh(issuedAt.getTime(), Date.now())) {
    return refuse(
      'Stale',
      'The command is outside the replay window. Re-issue it from the dashboard.',
    );
  }

  // --- 3. Capability ceiling ----------------------------------------------
  const required = COMMAND_CAPABILITY[kind];
  if (!required) {
    // A command this worker version does not model must never be guessed at.
    return refuse('UnknownCommand', `This worker version does not implement "${kind}".`);
  }
  if (!context.capabilities.includes(required)) {
    return refuse(
      'CapabilityDenied',
      `This worker is not permitted to ${required}. Its effective capabilities are: ` +
        `${context.capabilities.join(', ')}. Raise maxCapability in worker.yaml if that is intended.`,
    );
  }

  // --- 4. Idempotency -----------------------------------------------------
  const previous = context.outbox.appliedCommandOutcome(command.id);
  if (previous) {
    // Replay the outcome that was recorded, rather than asserting success.
    // Checking only that the id existed meant a redelivered command which had
    // *failed* came back green: the operator was told a change had applied that
    // msdb had refused, and the only way to find out otherwise was to look at
    // the job. The point of the record is what happened, not that it happened.
    log.info(
      { previousOutcome: previous.success ? 'succeeded' : 'failed' },
      'Command already applied; replaying the recorded outcome',
    );
    return {
      success: previous.success,
      errorCode: previous.success ? '' : previous.result ?? 'Unknown',
      errorDetail: previous.success
        ? 'Already applied.'
        : `Already attempted, and it failed: ${previous.result ?? 'no detail recorded'}.`,
      sqlErrorNumber: 0,
    };
  }

  // --- 5. Apply -----------------------------------------------------------
  try {
    const outcome = await apply(command, kind, context);
    context.outbox.recordAppliedCommand(command.id, outcome.success, outcome.errorCode || null);
    return outcome;
  } catch (err) {
    if (err instanceof SqlApplyError) {
      // A SQL failure is recorded as applied-and-failed so a redelivery does not
      // retry something that may have partially succeeded.
      context.outbox.recordAppliedCommand(command.id, false, 'SqlError');
      return {
        success: false,
        errorCode: 'SqlError',
        errorDetail: err.message,
        sqlErrorNumber: err.sqlErrorNumber,
      };
    }
    throw err;
  }
}

async function apply(
  command: Command,
  kind: CommandKind,
  context: CommandContext,
): Promise<ApplyOutcome> {
  const payload = command.payload;
  if (!payload) return refuse('Invalid', 'The command carried no payload.');

  switch (payload.$case) {
    case 'toggleJob': {
      const { jobUuid, enabled, baseDefinitionHash } = payload.toggleJob;
      const conflict = await checkConflict(context, jobUuid, baseDefinitionHash, false);
      if (conflict) return conflict;
      await toggleJob(context.pool, jobUuid, enabled);
      return ok(await readJobBlob(context, jobUuid));
    }

    case 'runJob': {
      // Deliberately no conflict check: starting a job is about the job as it
      // is right now, and refusing because someone edited a step body would be
      // an obstruction rather than a safeguard.
      await startJob(context.pool, payload.runJob.jobUuid, payload.runJob.stepName || undefined);
      return ok(undefined);
    }

    case 'stopJob':
      await stopJob(context.pool, payload.stopJob.jobUuid);
      return ok(undefined);

    case 'upsertJob': {
      const { jobUuid, canonicalJson, baseDefinitionHash, allowOverwrite } = payload.upsertJob;

      let definition;
      try {
        definition = parseJobDefinition(canonicalJson);
      } catch (err) {
        return refuse(
          'Invalid',
          `The job definition failed validation on the worker: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (jobUuid) {
        const conflict = await checkConflict(context, jobUuid, baseDefinitionHash, allowOverwrite);
        if (conflict) return conflict;
      }

      const result = await upsertJob(context.pool, jobUuid, definition);
      return ok(await readJobBlob(context, result.jobUuid));
    }

    case 'deleteJob': {
      const { jobUuid, baseDefinitionHash } = payload.deleteJob;
      const conflict = await checkConflict(context, jobUuid, baseDefinitionHash, false);
      if (conflict) return conflict;
      await deleteJob(context.pool, jobUuid);
      return ok(undefined);
    }

    case 'upsertSchedule': {
      const parsed = scheduleDefinitionSchema.safeParse(
        JSON.parse(payload.upsertSchedule.canonicalJson),
      );
      if (!parsed.success) return refuse('Invalid', 'The schedule definition failed validation.');
      await upsertSchedule(context.pool, parsed.data);
      return ok(undefined);
    }

    case 'deleteSchedule':
      await deleteSchedule(context.pool, payload.deleteSchedule.scheduleUuid);
      return ok(undefined);

    case 'upsertOperator': {
      const parsed = operatorDefinitionSchema.safeParse(
        JSON.parse(payload.upsertOperator.canonicalJson),
      );
      if (!parsed.success) return refuse('Invalid', 'The operator definition failed validation.');
      await upsertOperator(context.pool, parsed.data);
      return ok(undefined);
    }

    case 'deleteOperator':
      return refuse(
        'Unsupported',
        'Deleting an operator by id is not supported; delete it by name from SSMS.',
      );

    case 'setJobWriteAllowed': {
      // Put a job under central management, or take it out again. Applied by
      // the wrapper's own procedure rather than a direct write, so the refusal
      // when an instance is DBA-managed comes from msdb — the control plane
      // cannot talk its way past a posture chosen on the SQL host.
      const { jobName, allowed } = payload.setJobWriteAllowed;
      try {
        await setJobWriteAllowed(context.pool, jobName, allowed);
        return ok(undefined);
      } catch (err) {
        if (err instanceof SqlApplyError) {
          return {
            success: false,
            errorCode: 'SqlError',
            errorDetail: err.message,
            sqlErrorNumber: err.sqlErrorNumber,
          };
        }
        throw err;
      }
    }

    default:
      return refuse('UnknownCommand', 'This worker version does not implement that command.');
  }
}

/**
 * Refuse if live state has moved since the operator started editing (§7.3).
 *
 * Flag and ask, never last-write-wins: the dashboard shows a three-way view and
 * the operator explicitly chooses to rebase or overwrite. `allowOverwrite` is
 * that explicit choice, and is itself audited.
 */
async function checkConflict(
  context: CommandContext,
  jobUuid: string,
  baseDefinitionHash: string,
  allowOverwrite: boolean,
): Promise<ApplyOutcome | null> {
  // An empty base hash means "create", or an operator action with no definition
  // to conflict with.
  if (!baseDefinitionHash || allowOverwrite) return null;

  const blob = await readJobBlob(context, jobUuid);
  if (!blob) {
    return refuse(
      'Conflict',
      'That job no longer exists on this instance. Refresh and try again.',
    );
  }

  if (blob.definitionHash !== baseDefinitionHash) {
    return {
      success: false,
      errorCode: 'Conflict',
      errorDetail:
        'The job has changed on the server since this edit was started. ' +
        'Review the differences and choose whether to rebase or overwrite.',
      sqlErrorNumber: 0,
      // Return live state so the dashboard can render the three-way view without
      // waiting for the next definition poll.
      resultingJob: blob,
    };
  }

  return null;
}

async function readJobBlob(
  context: CommandContext,
  jobUuid: string,
): Promise<JobDefinitionBlob | undefined> {
  const { jobs } = await readJobs(context.pool);
  const job = jobs.find((j) => j.jobUuid === jobUuid.toLowerCase());
  if (!job) return undefined;

  const { canonicalJson, hash } = canonicaliseJobWithHash(job.definition);
  return {
    jobUuid: job.jobUuid,
    canonicalJson,
    definitionHash: hash,
    dateModified: toTimestamp(job.dateModified),
  };
}

function ok(resultingJob: JobDefinitionBlob | undefined): ApplyOutcome {
  return { success: true, errorCode: '', errorDetail: '', sqlErrorNumber: 0, resultingJob };
}

function refuse(code: string, detail: string): ApplyOutcome {
  return { success: false, errorCode: code, errorDetail: detail, sqlErrorNumber: 0 };
}
