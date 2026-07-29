import sql from 'mssql';
import type { JobDefinition, JobStep, ScheduleDefinition } from '@remote-sql-agent/protocol';
import { SCHEMA_VERSION } from '@remote-sql-agent/protocol';

/**
 * Read access to msdb — the SQL Server Agent object graph.
 *
 * Every statement here is a static string literal with values bound as request
 * parameters (§5.2). No statement is ever assembled by concatenation, and the
 * repository-wide eslint rule enforces that mechanically.
 *
 * Privileges: everything in this file is satisfied by SQLAgentReaderRole in
 * msdb, except readAgentErrorLog() which needs elevated rights — it degrades
 * gracefully rather than failing the whole worker (see AgentLogUnavailable).
 */

export interface InstanceIdentity {
  serverName: string;
  sqlVersion: string;
  sqlEdition: string;
  agentStatus: 'running' | 'stopped' | 'unknown';
}

export interface JobRecord {
  jobUuid: string;
  definition: JobDefinition;
  dateModified: Date;
}

export interface HistoryRecord {
  sqlInstanceId: number;
  jobUuid: string;
  stepId: number;
  stepName: string;
  runStatus: number;
  runDatetime: Date;
  runDurationSeconds: number;
  message: string;
  retriesAttempted: number;
  server: string;
  sqlSeverity: number;
  sqlMessageId: number;
}

export interface ActivityRecord {
  jobUuid: string;
  state: string;
  currentStepId: number;
  currentStepName: string;
  startExecutionDate: Date | null;
  lastExecutedStepDate: Date | null;
  nextScheduledRunDate: Date | null;
  lastRunOutcome: number;
}

export interface AgentLogRecord {
  loggedAt: Date;
  severity: string;
  message: string;
  processInfo: string;
}

export class AgentLogUnavailable extends Error {
  constructor(cause: string) {
    super(`SQL Server Agent error log is not readable by this login: ${cause}`);
    this.name = 'AgentLogUnavailable';
  }
}

// ---------------------------------------------------------------------------
// Identity and health
// ---------------------------------------------------------------------------

const IDENTITY_QUERY = `
SELECT
    CAST(SERVERPROPERTY('ServerName')      AS NVARCHAR(256)) AS server_name,
    CAST(SERVERPROPERTY('ProductVersion')  AS NVARCHAR(128)) AS sql_version,
    CAST(SERVERPROPERTY('Edition')         AS NVARCHAR(128)) AS sql_edition
`;

/**
 * Agent service status. sysprocesses is readable by public and the Agent
 * registers itself with program_name 'SQLAgent - Generic Refresher', which is
 * the standard way to detect a running Agent without sysadmin rights.
 */
const AGENT_STATUS_QUERY = `
SELECT CASE WHEN EXISTS (
    SELECT 1 FROM master.dbo.sysprocesses
    WHERE program_name LIKE N'SQLAgent - Generic Refresher%'
) THEN 1 ELSE 0 END AS agent_running
`;

export async function readIdentity(pool: sql.ConnectionPool): Promise<InstanceIdentity> {
  const identity = await pool.request().query<{
    server_name: string;
    sql_version: string;
    sql_edition: string;
  }>(IDENTITY_QUERY);

  let agentStatus: InstanceIdentity['agentStatus'] = 'unknown';
  try {
    const agent = await pool.request().query<{ agent_running: number }>(AGENT_STATUS_QUERY);
    agentStatus = agent.recordset[0]?.agent_running === 1 ? 'running' : 'stopped';
  } catch {
    // Reading sysprocesses can be blocked in hardened environments; an unknown
    // Agent status is not a reason to give up on the whole instance.
    agentStatus = 'unknown';
  }

  const row = identity.recordset[0];
  return {
    serverName: row?.server_name ?? '',
    sqlVersion: row?.sql_version ?? '',
    sqlEdition: row?.sql_edition ?? '',
    agentStatus,
  };
}

// ---------------------------------------------------------------------------
// Job definitions
// ---------------------------------------------------------------------------

const JOBS_QUERY = `
SELECT
    j.job_id,
    j.name,
    j.description,
    j.enabled,
    j.start_step_id,
    j.date_modified,
    j.notify_level_email,
    j.notify_level_netsend,
    j.notify_level_page,
    j.notify_level_eventlog,
    j.delete_level,
    c.name              AS category_name,
    SUSER_SNAME(j.owner_sid) AS owner_login_name,
    op_email.name       AS email_operator_name,
    op_netsend.name     AS netsend_operator_name,
    op_page.name        AS page_operator_name
FROM        msdb.dbo.sysjobs        AS j
LEFT JOIN   msdb.dbo.syscategories  AS c          ON c.category_id = j.category_id
LEFT JOIN   msdb.dbo.sysoperators   AS op_email   ON op_email.id   = j.notify_email_operator_id
LEFT JOIN   msdb.dbo.sysoperators   AS op_netsend ON op_netsend.id = j.notify_netsend_operator_id
LEFT JOIN   msdb.dbo.sysoperators   AS op_page    ON op_page.id    = j.notify_page_operator_id
ORDER BY    j.name
`;

const STEPS_QUERY = `
SELECT
    s.job_id,
    s.step_id,
    s.step_name,
    s.subsystem,
    s.command,
    s.database_name,
    s.database_user_name,
    s.on_success_action,
    s.on_success_step_id,
    s.on_fail_action,
    s.on_fail_step_id,
    s.retry_attempts,
    s.retry_interval,
    s.output_file_name,
    s.flags,
    p.name AS proxy_name
FROM        msdb.dbo.sysjobsteps AS s
LEFT JOIN   msdb.dbo.sysproxies  AS p ON p.proxy_id = s.proxy_id
ORDER BY    s.job_id, s.step_id
`;

const SCHEDULES_QUERY = `
SELECT
    js.job_id,
    sch.name,
    sch.enabled,
    sch.freq_type,
    sch.freq_interval,
    sch.freq_subday_type,
    sch.freq_subday_interval,
    sch.freq_relative_interval,
    sch.freq_recurrence_factor,
    sch.active_start_date,
    sch.active_end_date,
    sch.active_start_time,
    sch.active_end_time
FROM        msdb.dbo.sysjobschedules AS js
INNER JOIN  msdb.dbo.sysschedules    AS sch ON sch.schedule_id = js.schedule_id
ORDER BY    js.job_id, sch.name
`;

const JOB_SERVERS_QUERY = `
SELECT
    js.job_id,
    CASE WHEN js.server_id = 0
         THEN CAST(SERVERPROPERTY('ServerName') AS NVARCHAR(256))
         ELSE ts.server_name
    END AS server_name
FROM        msdb.dbo.sysjobservers    AS js
LEFT JOIN   msdb.dbo.systargetservers AS ts ON ts.server_id = js.server_id
`;

interface JobRow {
  job_id: string;
  name: string;
  description: string | null;
  enabled: number;
  start_step_id: number;
  date_modified: Date;
  notify_level_email: number;
  notify_level_netsend: number;
  notify_level_page: number;
  notify_level_eventlog: number;
  delete_level: number;
  category_name: string | null;
  owner_login_name: string | null;
  email_operator_name: string | null;
  netsend_operator_name: string | null;
  page_operator_name: string | null;
}

interface StepRow {
  job_id: string;
  step_id: number;
  step_name: string;
  subsystem: string;
  command: string | null;
  database_name: string | null;
  database_user_name: string | null;
  on_success_action: number;
  on_success_step_id: number;
  on_fail_action: number;
  on_fail_step_id: number;
  retry_attempts: number;
  retry_interval: number;
  output_file_name: string | null;
  flags: number;
  proxy_name: string | null;
}

interface ScheduleRow {
  job_id: string;
  name: string;
  enabled: number;
  freq_type: number;
  freq_interval: number;
  freq_subday_type: number;
  freq_subday_interval: number;
  freq_relative_interval: number;
  freq_recurrence_factor: number;
  active_start_date: number;
  active_end_date: number;
  active_start_time: number;
  active_end_time: number;
}

/** msdb returns job_id as an uppercase GUID string; the control plane keys on lowercase. */
function normaliseUuid(value: string): string {
  return value.toLowerCase();
}

/**
 * `subsystem` is an open set in msdb (a site can register more). Anything we do
 * not model is mapped to CmdExec-with-a-warning rather than dropped, because
 * silently omitting a step would make the canonical definition wrong — and this
 * definition is what a write-back would install.
 */
const KNOWN_SUBSYSTEMS = new Set<JobStep['subsystem']>([
  'TSQL',
  'CmdExec',
  'PowerShell',
  'ANALYSISCOMMAND',
  'ANALYSISQUERY',
  'SSIS',
  'Distribution',
  'LogReader',
  'Merge',
  'Snapshot',
  'QueueReader',
]);

export interface ReadJobsResult {
  jobs: JobRecord[];
  /** Subsystems seen that this version does not model, for a one-time warning. */
  unknownSubsystems: string[];
}

export async function readJobs(pool: sql.ConnectionPool): Promise<ReadJobsResult> {
  const [jobRows, stepRows, scheduleRows, serverRows] = await Promise.all([
    pool.request().query<JobRow>(JOBS_QUERY),
    pool.request().query<StepRow>(STEPS_QUERY),
    pool.request().query<ScheduleRow>(SCHEDULES_QUERY),
    pool.request().query<{ job_id: string; server_name: string | null }>(JOB_SERVERS_QUERY),
  ]);

  const stepsByJob = groupBy(stepRows.recordset, (r) => normaliseUuid(r.job_id));
  const schedulesByJob = groupBy(scheduleRows.recordset, (r) => normaliseUuid(r.job_id));
  const serversByJob = groupBy(serverRows.recordset, (r) => normaliseUuid(r.job_id));
  const unknownSubsystems = new Set<string>();

  const jobs: JobRecord[] = jobRows.recordset.map((row) => {
    const jobUuid = normaliseUuid(row.job_id);

    const steps: JobStep[] = (stepsByJob.get(jobUuid) ?? []).map((s) => {
      const subsystem = s.subsystem as JobStep['subsystem'];
      if (!KNOWN_SUBSYSTEMS.has(subsystem)) unknownSubsystems.add(s.subsystem);
      return {
        stepId: s.step_id,
        name: s.step_name,
        subsystem: KNOWN_SUBSYSTEMS.has(subsystem) ? subsystem : 'CmdExec',
        command: s.command ?? '',
        databaseName: s.database_name,
        databaseUserName: s.database_user_name,
        onSuccessAction: s.on_success_action,
        onSuccessStepId: s.on_success_step_id,
        onFailAction: s.on_fail_action,
        onFailStepId: s.on_fail_step_id,
        retryAttempts: s.retry_attempts,
        retryIntervalMinutes: s.retry_interval,
        outputFileName: s.output_file_name,
        flags: s.flags,
        proxyName: s.proxy_name,
      };
    });

    const schedules: ScheduleDefinition[] = (schedulesByJob.get(jobUuid) ?? []).map((s) => ({
      name: s.name,
      enabled: s.enabled === 1,
      freqType: s.freq_type,
      freqInterval: s.freq_interval,
      freqSubdayType: s.freq_subday_type,
      freqSubdayInterval: s.freq_subday_interval,
      freqRelativeInterval: s.freq_relative_interval,
      freqRecurrenceFactor: s.freq_recurrence_factor,
      activeStartDate: s.active_start_date,
      activeEndDate: s.active_end_date,
      activeStartTime: s.active_start_time,
      activeEndTime: s.active_end_time,
    }));

    const definition: JobDefinition = {
      schemaVersion: SCHEMA_VERSION,
      name: row.name,
      description: row.description,
      enabled: row.enabled === 1,
      categoryName: row.category_name,
      ownerLoginName: row.owner_login_name,
      startStepId: row.start_step_id,
      notifications: {
        emailOperatorName: row.email_operator_name,
        emailLevel: row.notify_level_email,
        netsendOperatorName: row.netsend_operator_name,
        netsendLevel: row.notify_level_netsend,
        pageOperatorName: row.page_operator_name,
        pageLevel: row.notify_level_page,
        eventlogLevel: row.notify_level_eventlog,
        deleteLevel: row.delete_level,
      },
      steps,
      schedules,
      targetServers: (serversByJob.get(jobUuid) ?? [])
        .map((s) => s.server_name)
        .filter((n): n is string => n !== null),
    };

    return { jobUuid, definition, dateModified: row.date_modified };
  });

  return { jobs, unknownSubsystems: [...unknownSubsystems] };
}

/**
 * Cheap pre-filter for the definition poll: the maximum date_modified across
 * all jobs plus the job count. If neither has moved, no job definition can have
 * changed, and we skip serialising and hashing the whole estate (§5.3).
 *
 * The count is part of the check because date_modified alone would miss a
 * deletion, which does not touch any surviving row.
 */
const JOBS_FINGERPRINT_QUERY = `
SELECT
    COUNT(*)               AS job_count,
    MAX(j.date_modified)   AS max_date_modified
FROM msdb.dbo.sysjobs AS j
`;

export interface JobsFingerprint {
  jobCount: number;
  maxDateModified: Date | null;
}

export async function readJobsFingerprint(pool: sql.ConnectionPool): Promise<JobsFingerprint> {
  const result = await pool
    .request()
    .query<{ job_count: number; max_date_modified: Date | null }>(JOBS_FINGERPRINT_QUERY);
  const row = result.recordset[0];
  return {
    jobCount: row?.job_count ?? 0,
    maxDateModified: row?.max_date_modified ?? null,
  };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/**
 * Incremental history read, keyed on sysjobhistory.instance_id.
 *
 * run_date/run_time are separate integers (yyyymmdd / hhmmss) and run_duration
 * is an integer in HHMMSS shape, not seconds — decoding it as seconds is a
 * classic bug that makes a 1m30s run look like 130 seconds. msdb.dbo.agent_datetime
 * is the supported way to combine the date/time pair.
 */
const HISTORY_QUERY = `
SELECT TOP (@batchSize)
    h.instance_id,
    h.job_id,
    h.step_id,
    h.step_name,
    h.run_status,
    msdb.dbo.agent_datetime(h.run_date, h.run_time) AS run_datetime,
    (h.run_duration / 10000) * 3600
      + ((h.run_duration / 100) % 100) * 60
      + (h.run_duration % 100)                      AS run_duration_seconds,
    h.message,
    h.retries_attempted,
    h.server,
    h.sql_severity,
    h.sql_message_id
FROM     msdb.dbo.sysjobhistory AS h
WHERE    h.instance_id > @highWaterMark
ORDER BY h.instance_id ASC
`;

export async function readHistorySince(
  pool: sql.ConnectionPool,
  highWaterMark: number,
  batchSize: number,
): Promise<HistoryRecord[]> {
  const result = await pool
    .request()
    .input('highWaterMark', sql.BigInt, highWaterMark)
    .input('batchSize', sql.Int, batchSize)
    .query<{
      instance_id: number;
      job_id: string;
      step_id: number;
      step_name: string | null;
      run_status: number;
      run_datetime: Date | null;
      run_duration_seconds: number;
      message: string | null;
      retries_attempted: number;
      server: string | null;
      sql_severity: number;
      sql_message_id: number;
    }>(HISTORY_QUERY);

  return result.recordset
    .filter((r) => r.run_datetime !== null)
    .map((r) => ({
      sqlInstanceId: Number(r.instance_id),
      jobUuid: normaliseUuid(r.job_id),
      stepId: r.step_id,
      stepName: r.step_name ?? '',
      runStatus: r.run_status,
      runDatetime: r.run_datetime as Date,
      runDurationSeconds: r.run_duration_seconds,
      message: r.message ?? '',
      retriesAttempted: r.retries_attempted,
      server: r.server ?? '',
      sqlSeverity: r.sql_severity,
      sqlMessageId: r.sql_message_id,
    }));
}

/** Highest instance_id currently in msdb — used to seed the high-water mark. */
export async function readMaxHistoryId(pool: sql.ConnectionPool): Promise<number> {
  const result = await pool
    .request()
    .query<{ max_id: number | null }>(
      'SELECT MAX(h.instance_id) AS max_id FROM msdb.dbo.sysjobhistory AS h',
    );
  return Number(result.recordset[0]?.max_id ?? 0);
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

/**
 * Live-ish job activity. sysjobactivity accumulates one row per job per Agent
 * session, so it must be filtered to the current session or every restart adds
 * a duplicate set of stale rows.
 */
const ACTIVITY_QUERY = `
SELECT
    ja.job_id,
    ja.start_execution_date,
    ja.stop_execution_date,
    ja.last_executed_step_id,
    ja.last_executed_step_date,
    ja.next_scheduled_run_date,
    js.step_name AS current_step_name,
    jh.run_status AS last_run_outcome
FROM        msdb.dbo.sysjobactivity AS ja
LEFT JOIN   msdb.dbo.sysjobsteps    AS js
        ON  js.job_id = ja.job_id AND js.step_id = ja.last_executed_step_id
LEFT JOIN   msdb.dbo.sysjobhistory  AS jh
        ON  jh.instance_id = ja.job_history_id
WHERE       ja.session_id = (SELECT MAX(s.session_id) FROM msdb.dbo.syssessions AS s)
`;

export async function readActivity(pool: sql.ConnectionPool): Promise<ActivityRecord[]> {
  const result = await pool.request().query<{
    job_id: string;
    start_execution_date: Date | null;
    stop_execution_date: Date | null;
    last_executed_step_id: number | null;
    last_executed_step_date: Date | null;
    next_scheduled_run_date: Date | null;
    current_step_name: string | null;
    last_run_outcome: number | null;
  }>(ACTIVITY_QUERY);

  return result.recordset.map((r) => ({
    jobUuid: normaliseUuid(r.job_id),
    // A row with a start but no stop is a job currently executing. This is the
    // only signal available between step-completion history rows (§5.3).
    state: r.start_execution_date && !r.stop_execution_date ? 'executing' : 'idle',
    currentStepId: r.last_executed_step_id ?? 0,
    currentStepName: r.current_step_name ?? '',
    startExecutionDate: r.start_execution_date,
    lastExecutedStepDate: r.last_executed_step_date,
    nextScheduledRunDate: r.next_scheduled_run_date,
    lastRunOutcome: r.last_run_outcome ?? -1,
  }));
}

// ---------------------------------------------------------------------------
// Agent error log
// ---------------------------------------------------------------------------

/**
 * Tail the SQL Server Agent error log.
 *
 * xp_readerrorlog needs rights beyond SQLAgentReaderRole (securityadmin or
 * sysadmin), which a correctly least-privileged worker login will not have.
 * That is expected: the caller catches AgentLogUnavailable and disables this
 * poller rather than treating it as a fault. Log streaming is a nice-to-have;
 * requiring sysadmin for it would violate §5.2.
 */
export async function readAgentErrorLog(
  pool: sql.ConnectionPool,
  since: Date | null,
): Promise<AgentLogRecord[]> {
  const request = pool.request();
  request.input('logNumber', sql.Int, 0);
  request.input('logType', sql.Int, 2); // 2 = SQL Server Agent log
  if (since) {
    request.input('startDate', sql.DateTime, since);
  }

  try {
    const result = since
      ? await request.query<{ LogDate: Date; ProcessInfo: string; Text: string }>(
          'EXEC master.dbo.xp_readerrorlog @logNumber, @logType, NULL, NULL, @startDate',
        )
      : await request.query<{ LogDate: Date; ProcessInfo: string; Text: string }>(
          'EXEC master.dbo.xp_readerrorlog @logNumber, @logType',
        );

    return result.recordset.map((r) => ({
      loggedAt: r.LogDate,
      severity: classifySeverity(r.Text ?? ''),
      message: r.Text ?? '',
      processInfo: r.ProcessInfo ?? '',
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/permission|denied|EXECUTE/iu.test(message)) {
      throw new AgentLogUnavailable(message);
    }
    throw err;
  }
}

function classifySeverity(text: string): string {
  if (/\berror\b|\bfailed\b/iu.test(text)) return 'error';
  if (/\bwarning\b/iu.test(text)) return 'warning';
  return 'info';
}

// ---------------------------------------------------------------------------

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const existing = map.get(k);
    if (existing) existing.push(item);
    else map.set(k, [item]);
  }
  return map;
}
