import sql from 'mssql';
import type { JobDefinition, ScheduleDefinition, OperatorDefinition } from '@remote-sql-agent/protocol';

/**
 * Write access to msdb.
 *
 * Everything here goes through the documented Agent stored procedures —
 * `sp_add_job`, `sp_update_jobstep`, `sp_add_jobschedule` and friends. The
 * worker never writes to the `sysjobs` tables directly: those are Microsoft's
 * to change, the sprocs carry validation we would otherwise have to reimplement,
 * and a direct write is how you end up with an Agent that has to be restarted to
 * notice its own configuration.
 *
 * Every value is bound as a request parameter. No statement in this file is
 * assembled by concatenation, and the repository eslint rule enforces that.
 */

export class SqlApplyError extends Error {
  constructor(
    message: string,
    readonly sqlErrorNumber: number,
  ) {
    super(message);
    this.name = 'SqlApplyError';
  }
}

function wrapSqlError(err: unknown): never {
  if (err instanceof Error && 'number' in err) {
    const number = Number((err as { number?: unknown }).number ?? 0);
    throw new SqlApplyError(err.message, number);
  }
  throw err;
}

/** msdb wants NULL, not empty string, for "not set". */
function nullIfEmpty(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}

// ---------------------------------------------------------------------------
// Simple operations
// ---------------------------------------------------------------------------

export async function toggleJob(
  pool: sql.ConnectionPool,
  jobUuid: string,
  enabled: boolean,
): Promise<void> {
  try {
    await pool
      .request()
      .input('job_id', sql.UniqueIdentifier, jobUuid)
      .input('enabled', sql.TinyInt, enabled ? 1 : 0)
      .execute('msdb.dbo.sp_update_job');
  } catch (err) {
    wrapSqlError(err);
  }
}

/**
 * Start a job.
 *
 * `sp_start_job` returns as soon as the Agent has accepted the request — it
 * does not wait for the job to finish, and must not be wrapped in a
 * transaction. The run shows up through the normal history poll like any other.
 */
export async function startJob(
  pool: sql.ConnectionPool,
  jobUuid: string,
  stepName?: string,
): Promise<void> {
  try {
    const request = pool.request().input('job_id', sql.UniqueIdentifier, jobUuid);
    if (nullIfEmpty(stepName)) request.input('step_name', sql.NVarChar(128), stepName);
    await request.execute('msdb.dbo.sp_start_job');
  } catch (err) {
    wrapSqlError(err);
  }
}

export async function stopJob(pool: sql.ConnectionPool, jobUuid: string): Promise<void> {
  try {
    await pool
      .request()
      .input('job_id', sql.UniqueIdentifier, jobUuid)
      .execute('msdb.dbo.sp_stop_job');
  } catch (err) {
    wrapSqlError(err);
  }
}

export async function deleteJob(pool: sql.ConnectionPool, jobUuid: string): Promise<void> {
  try {
    await pool
      .request()
      .input('job_id', sql.UniqueIdentifier, jobUuid)
      // Schedules created for this job and used by nothing else go with it;
      // leaving them behind would litter msdb with orphans.
      .input('delete_unused_schedule', sql.Bit, 1)
      .execute('msdb.dbo.sp_delete_job');
  } catch (err) {
    wrapSqlError(err);
  }
}

// ---------------------------------------------------------------------------
// Job upsert
// ---------------------------------------------------------------------------

export interface UpsertJobResult {
  jobUuid: string;
  created: boolean;
}

/**
 * Create or replace a job so that msdb matches the supplied definition exactly.
 *
 * Steps are replaced wholesale rather than diffed. `sp_delete_jobstep`
 * renumbers the steps that follow it, so an incremental reconcile would have to
 * track shifting ids through a sequence of mutations and would be wrong in
 * exactly the cases that matter (a step removed from the middle of a branching
 * job). Deleting all and re-adding in order is what makes the round trip
 * faithful, which is the property the whole write path is judged on.
 *
 * The whole thing runs in one transaction so a failure half way cannot leave a
 * job with some of its steps.
 */
export async function upsertJob(
  pool: sql.ConnectionPool,
  jobUuid: string,
  definition: JobDefinition,
): Promise<UpsertJobResult> {
  const transaction = pool.transaction();
  await transaction.begin();

  try {
    const exists = jobUuid ? await jobExists(transaction, jobUuid) : false;
    let effectiveJobId = jobUuid;
    let created = false;

    if (exists) {
      await updateJobProperties(transaction, effectiveJobId, definition);
      // Remove every step: @step_id = 0 is the documented "all steps" form.
      await new sql.Request(transaction)
        .input('job_id', sql.UniqueIdentifier, effectiveJobId)
        .input('step_id', sql.Int, 0)
        .execute('msdb.dbo.sp_delete_jobstep');
    } else {
      effectiveJobId = await addJob(transaction, definition);
      created = true;
    }

    for (const step of [...definition.steps].sort((a, b) => a.stepId - b.stepId)) {
      await new sql.Request(transaction)
        .input('job_id', sql.UniqueIdentifier, effectiveJobId)
        .input('step_name', sql.NVarChar(128), step.name)
        .input('subsystem', sql.NVarChar(40), step.subsystem)
        .input('command', sql.NVarChar(sql.MAX), step.command)
        .input('database_name', sql.NVarChar(128), nullIfEmpty(step.databaseName))
        .input('database_user_name', sql.NVarChar(128), nullIfEmpty(step.databaseUserName))
        .input('on_success_action', sql.TinyInt, step.onSuccessAction)
        .input('on_success_step_id', sql.Int, step.onSuccessStepId)
        .input('on_fail_action', sql.TinyInt, step.onFailAction)
        .input('on_fail_step_id', sql.Int, step.onFailStepId)
        .input('retry_attempts', sql.Int, step.retryAttempts)
        .input('retry_interval', sql.Int, step.retryIntervalMinutes)
        .input('output_file_name', sql.NVarChar(200), nullIfEmpty(step.outputFileName))
        .input('flags', sql.Int, step.flags)
        .input('proxy_name', sql.NVarChar(128), nullIfEmpty(step.proxyName))
        .execute('msdb.dbo.sp_add_jobstep');
    }

    // start_step_id can only be set once the step it names exists.
    if (definition.steps.length > 0) {
      await new sql.Request(transaction)
        .input('job_id', sql.UniqueIdentifier, effectiveJobId)
        .input('start_step_id', sql.Int, definition.startStepId)
        .execute('msdb.dbo.sp_update_job');
    }

    await reconcileJobSchedules(transaction, effectiveJobId, definition.schedules);

    if (created) {
      // Without a job server the job exists but the local Agent will not run it.
      await new sql.Request(transaction)
        .input('job_id', sql.UniqueIdentifier, effectiveJobId)
        .input('server_name', sql.NVarChar(128), '(LOCAL)')
        .execute('msdb.dbo.sp_add_jobserver');
    }

    await transaction.commit();
    return { jobUuid: effectiveJobId, created };
  } catch (err) {
    await transaction.rollback().catch(() => undefined);
    wrapSqlError(err);
  }
}

async function jobExists(transaction: sql.Transaction, jobUuid: string): Promise<boolean> {
  const result = await new sql.Request(transaction)
    .input('jobId', sql.UniqueIdentifier, jobUuid)
    .query<{ present: number }>(
      'SELECT 1 AS present FROM msdb.dbo.sysjobs WHERE job_id = @jobId',
    );
  return result.recordset.length > 0;
}

async function addJob(transaction: sql.Transaction, definition: JobDefinition): Promise<string> {
  const request = new sql.Request(transaction)
    .input('job_name', sql.NVarChar(128), definition.name)
    .input('enabled', sql.TinyInt, definition.enabled ? 1 : 0)
    .input('description', sql.NVarChar(512), nullIfEmpty(definition.description))
    .input('category_name', sql.NVarChar(128), nullIfEmpty(definition.categoryName))
    .input('owner_login_name', sql.NVarChar(128), nullIfEmpty(definition.ownerLoginName))
    .input('notify_level_email', sql.Int, definition.notifications.emailLevel)
    .input('notify_level_netsend', sql.Int, definition.notifications.netsendLevel)
    .input('notify_level_page', sql.Int, definition.notifications.pageLevel)
    .input('notify_level_eventlog', sql.Int, definition.notifications.eventlogLevel)
    .input('delete_level', sql.Int, definition.notifications.deleteLevel)
    .input(
      'notify_email_operator_name',
      sql.NVarChar(128),
      nullIfEmpty(definition.notifications.emailOperatorName),
    )
    .input(
      'notify_netsend_operator_name',
      sql.NVarChar(128),
      nullIfEmpty(definition.notifications.netsendOperatorName),
    )
    .input(
      'notify_page_operator_name',
      sql.NVarChar(128),
      nullIfEmpty(definition.notifications.pageOperatorName),
    )
    .output('job_id', sql.UniqueIdentifier);

  const result = await request.execute('msdb.dbo.sp_add_job');
  const jobId = result.output.job_id as string | undefined;
  if (!jobId) throw new Error('sp_add_job did not return a job_id.');
  return jobId.toLowerCase();
}

async function updateJobProperties(
  transaction: sql.Transaction,
  jobUuid: string,
  definition: JobDefinition,
): Promise<void> {
  await new sql.Request(transaction)
    .input('job_id', sql.UniqueIdentifier, jobUuid)
    .input('new_name', sql.NVarChar(128), definition.name)
    .input('enabled', sql.TinyInt, definition.enabled ? 1 : 0)
    .input('description', sql.NVarChar(512), nullIfEmpty(definition.description))
    .input('category_name', sql.NVarChar(128), nullIfEmpty(definition.categoryName))
    .input('owner_login_name', sql.NVarChar(128), nullIfEmpty(definition.ownerLoginName))
    .input('notify_level_email', sql.Int, definition.notifications.emailLevel)
    .input('notify_level_netsend', sql.Int, definition.notifications.netsendLevel)
    .input('notify_level_page', sql.Int, definition.notifications.pageLevel)
    .input('notify_level_eventlog', sql.Int, definition.notifications.eventlogLevel)
    .input('delete_level', sql.Int, definition.notifications.deleteLevel)
    .input(
      'notify_email_operator_name',
      sql.NVarChar(128),
      definition.notifications.emailOperatorName ?? '',
    )
    .input(
      'notify_netsend_operator_name',
      sql.NVarChar(128),
      definition.notifications.netsendOperatorName ?? '',
    )
    .input(
      'notify_page_operator_name',
      sql.NVarChar(128),
      definition.notifications.pageOperatorName ?? '',
    )
    .execute('msdb.dbo.sp_update_job');
}

/**
 * Make the job's attached schedules match the definition.
 *
 * Schedules are matched by name — the only identity a schedule has that is
 * stable across two instances, since `schedule_id` is instance-local.
 */
async function reconcileJobSchedules(
  transaction: sql.Transaction,
  jobUuid: string,
  schedules: ScheduleDefinition[],
): Promise<void> {
  const current = await new sql.Request(transaction)
    .input('jobId', sql.UniqueIdentifier, jobUuid)
    .query<{ name: string }>(
      `SELECT sch.name
       FROM   msdb.dbo.sysjobschedules AS js
       JOIN   msdb.dbo.sysschedules    AS sch ON sch.schedule_id = js.schedule_id
       WHERE  js.job_id = @jobId`,
    );

  const attached = new Set(current.recordset.map((r) => r.name));
  const wanted = new Set(schedules.map((s) => s.name));

  for (const schedule of schedules) {
    if (attached.has(schedule.name)) {
      await new sql.Request(transaction)
        .input('name', sql.NVarChar(128), schedule.name)
        .input('enabled', sql.TinyInt, schedule.enabled ? 1 : 0)
        .input('freq_type', sql.Int, schedule.freqType)
        .input('freq_interval', sql.Int, schedule.freqInterval)
        .input('freq_subday_type', sql.Int, schedule.freqSubdayType)
        .input('freq_subday_interval', sql.Int, schedule.freqSubdayInterval)
        .input('freq_relative_interval', sql.Int, schedule.freqRelativeInterval)
        .input('freq_recurrence_factor', sql.Int, schedule.freqRecurrenceFactor)
        .input('active_start_date', sql.Int, schedule.activeStartDate)
        .input('active_end_date', sql.Int, schedule.activeEndDate)
        .input('active_start_time', sql.Int, schedule.activeStartTime)
        .input('active_end_time', sql.Int, schedule.activeEndTime)
        .execute('msdb.dbo.sp_update_schedule');
    } else {
      await new sql.Request(transaction)
        .input('job_id', sql.UniqueIdentifier, jobUuid)
        .input('name', sql.NVarChar(128), schedule.name)
        .input('enabled', sql.TinyInt, schedule.enabled ? 1 : 0)
        .input('freq_type', sql.Int, schedule.freqType)
        .input('freq_interval', sql.Int, schedule.freqInterval)
        .input('freq_subday_type', sql.Int, schedule.freqSubdayType)
        .input('freq_subday_interval', sql.Int, schedule.freqSubdayInterval)
        .input('freq_relative_interval', sql.Int, schedule.freqRelativeInterval)
        .input('freq_recurrence_factor', sql.Int, schedule.freqRecurrenceFactor)
        .input('active_start_date', sql.Int, schedule.activeStartDate)
        .input('active_end_date', sql.Int, schedule.activeEndDate)
        .input('active_start_time', sql.Int, schedule.activeStartTime)
        .input('active_end_time', sql.Int, schedule.activeEndTime)
        .execute('msdb.dbo.sp_add_jobschedule');
    }
  }

  for (const name of attached) {
    if (wanted.has(name)) continue;
    await new sql.Request(transaction)
      .input('job_id', sql.UniqueIdentifier, jobUuid)
      .input('name', sql.NVarChar(128), name)
      // Detaching a schedule nothing else uses should remove it, not leave an
      // orphan behind for the next person to wonder about.
      .input('delete_unused_schedule', sql.Bit, 1)
      .execute('msdb.dbo.sp_detach_schedule');
  }
}

// ---------------------------------------------------------------------------
// Standalone schedules and operators
// ---------------------------------------------------------------------------

export async function upsertSchedule(
  pool: sql.ConnectionPool,
  schedule: ScheduleDefinition,
): Promise<void> {
  try {
    const existing = await pool
      .request()
      .input('name', sql.NVarChar(128), schedule.name)
      .query<{ present: number }>(
        'SELECT 1 AS present FROM msdb.dbo.sysschedules WHERE name = @name',
      );

    const procedure =
      existing.recordset.length > 0 ? 'msdb.dbo.sp_update_schedule' : 'msdb.dbo.sp_add_schedule';

    await pool
      .request()
      .input('name', sql.NVarChar(128), schedule.name)
      .input('enabled', sql.TinyInt, schedule.enabled ? 1 : 0)
      .input('freq_type', sql.Int, schedule.freqType)
      .input('freq_interval', sql.Int, schedule.freqInterval)
      .input('freq_subday_type', sql.Int, schedule.freqSubdayType)
      .input('freq_subday_interval', sql.Int, schedule.freqSubdayInterval)
      .input('freq_relative_interval', sql.Int, schedule.freqRelativeInterval)
      .input('freq_recurrence_factor', sql.Int, schedule.freqRecurrenceFactor)
      .input('active_start_date', sql.Int, schedule.activeStartDate)
      .input('active_end_date', sql.Int, schedule.activeEndDate)
      .input('active_start_time', sql.Int, schedule.activeStartTime)
      .input('active_end_time', sql.Int, schedule.activeEndTime)
      .execute(procedure);
  } catch (err) {
    wrapSqlError(err);
  }
}

export async function deleteSchedule(pool: sql.ConnectionPool, name: string): Promise<void> {
  try {
    await pool
      .request()
      .input('schedule_name', sql.NVarChar(128), name)
      .input('force_delete', sql.Bit, 0)
      .execute('msdb.dbo.sp_delete_schedule');
  } catch (err) {
    wrapSqlError(err);
  }
}

export async function upsertOperator(
  pool: sql.ConnectionPool,
  operator: OperatorDefinition,
): Promise<void> {
  try {
    const existing = await pool
      .request()
      .input('name', sql.NVarChar(128), operator.name)
      .query<{ present: number }>(
        'SELECT 1 AS present FROM msdb.dbo.sysoperators WHERE name = @name',
      );

    const procedure =
      existing.recordset.length > 0 ? 'msdb.dbo.sp_update_operator' : 'msdb.dbo.sp_add_operator';

    await pool
      .request()
      .input('name', sql.NVarChar(128), operator.name)
      .input('enabled', sql.TinyInt, operator.enabled ? 1 : 0)
      .input('email_address', sql.NVarChar(100), nullIfEmpty(operator.emailAddress))
      .input('pager_address', sql.NVarChar(100), nullIfEmpty(operator.pagerAddress))
      .input('netsend_address', sql.NVarChar(100), nullIfEmpty(operator.netsendAddress))
      .input('weekday_pager_start_time', sql.Int, operator.weekdayPagerStartTime)
      .input('weekday_pager_end_time', sql.Int, operator.weekdayPagerEndTime)
      .input('saturday_pager_start_time', sql.Int, operator.saturdayPagerStartTime)
      .input('saturday_pager_end_time', sql.Int, operator.saturdayPagerEndTime)
      .input('sunday_pager_start_time', sql.Int, operator.sundayPagerStartTime)
      .input('sunday_pager_end_time', sql.Int, operator.sundayPagerEndTime)
      .input('pager_days', sql.TinyInt, operator.pagerDays)
      .execute(procedure);
  } catch (err) {
    wrapSqlError(err);
  }
}

export async function deleteOperator(pool: sql.ConnectionPool, name: string): Promise<void> {
  try {
    await pool
      .request()
      .input('name', sql.NVarChar(128), name)
      // Reassign nothing: refuse rather than silently orphan a job's alerting.
      .input('reassign_to_operator', sql.NVarChar(128), null)
      .execute('msdb.dbo.sp_delete_operator');
  } catch (err) {
    wrapSqlError(err);
  }
}

/**
 * Put a job under central management, or take it out again.
 *
 * Goes through the wrapper's own procedure rather than writing to the table,
 * so an instance installed as DBA-managed refuses this from msdb itself. The
 * control plane cannot argue with that: the posture lives on the SQL host,
 * which is the same reason `maxCapability` lives in worker.yaml.
 *
 * Fails plainly when the wrapper is not installed at all — "could not find
 * stored procedure" is accurate, and the dashboard only offers this where the
 * worker has reported the wrapper present.
 */
export async function setJobWriteAllowed(
  pool: sql.ConnectionPool,
  jobName: string,
  allowed: boolean,
): Promise<void> {
  try {
    await pool
      .request()
      .input('job_name', sql.NVarChar(128), jobName)
      .input('allowed', sql.Bit, allowed ? 1 : 0)
      .execute('msdb.dbo.rsagent_set_job_write_allowed');
  } catch (err) {
    wrapSqlError(err);
  }
}
