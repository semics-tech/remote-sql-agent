import { z } from 'zod';
import { scheduleDefinitionSchema } from './schedule.js';

/**
 * JobDefinition.v1 — the canonical representation of a SQL Server Agent job.
 *
 * This schema is the contract the whole product hangs off. The worker
 * serialises msdb into it; the control plane stores, hashes and diffs it; the
 * worker applies it back through msdb sprocs. Worker and server must produce
 * byte-identical canonical JSON from the same job, so anything that varies
 * between two servers holding "the same" job is deliberately excluded:
 *
 *   - job_id / schedule_id  — per-instance identity, not definition
 *   - date_created / date_modified / version_number — metadata
 *   - originating_server — instance-local
 *
 * Anything a DBA would consider part of "what this job does" is included.
 */

export const SCHEMA_VERSION = 'JobDefinition.v1' as const;

/** sp_add_jobstep @subsystem values. */
export const StepSubsystem = z.enum([
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

/** on_success_action / on_fail_action. */
export const StepAction = {
  QuitWithSuccess: 1,
  QuitWithFailure: 2,
  GoToNextStep: 3,
  GoToStep: 4,
} as const;

export const jobStepSchema = z.object({
  stepId: z.number().int().min(1),
  name: z.string().min(1).max(128),
  subsystem: StepSubsystem,
  /** T-SQL / command body. Whitespace-normalised by the canonicaliser. */
  command: z.string(),
  databaseName: z.string().nullable(),
  databaseUserName: z.string().nullable(),
  onSuccessAction: z.number().int(),
  onSuccessStepId: z.number().int(),
  onFailAction: z.number().int(),
  onFailStepId: z.number().int(),
  retryAttempts: z.number().int().min(0),
  retryIntervalMinutes: z.number().int().min(0),
  outputFileName: z.string().nullable(),
  /** sysjobsteps.flags bitmask (append to output file, log to table, etc.). */
  flags: z.number().int().min(0),
  /** Proxy account name, or null to run as the Agent service account. */
  proxyName: z.string().nullable(),
});

export type JobStep = z.infer<typeof jobStepSchema>;

/**
 * Notification levels: 0=Never 1=OnSuccess 2=OnFailure 3=OnCompletion.
 * Operators are referenced by name rather than id — ids are instance-local and
 * would make an otherwise identical job hash differently on two servers.
 */
export const jobNotificationsSchema = z.object({
  emailOperatorName: z.string().nullable(),
  emailLevel: z.number().int().min(0).max(3),
  netsendOperatorName: z.string().nullable(),
  netsendLevel: z.number().int().min(0).max(3),
  pageOperatorName: z.string().nullable(),
  pageLevel: z.number().int().min(0).max(3),
  eventlogLevel: z.number().int().min(0).max(3),
  /** delete_level: automatically delete the job on this outcome. */
  deleteLevel: z.number().int().min(0).max(3),
});

export const jobDefinitionSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  name: z.string().min(1).max(128),
  description: z.string().nullable(),
  enabled: z.boolean(),
  categoryName: z.string().nullable(),
  ownerLoginName: z.string().nullable(),
  startStepId: z.number().int().min(1),
  notifications: jobNotificationsSchema,
  steps: z.array(jobStepSchema),
  /** Schedules attached to this job, sorted by name in canonical form. */
  schedules: z.array(scheduleDefinitionSchema),
  /** Target servers. Local-only in v1, but stored so MSX jobs round-trip. */
  targetServers: z.array(z.string()),
});

export type JobDefinition = z.infer<typeof jobDefinitionSchema>;

export const operatorDefinitionSchema = z.object({
  schemaVersion: z.literal('OperatorDefinition.v1'),
  name: z.string().min(1).max(128),
  enabled: z.boolean(),
  emailAddress: z.string().nullable(),
  pagerAddress: z.string().nullable(),
  netsendAddress: z.string().nullable(),
  weekdayPagerStartTime: z.number().int(),
  weekdayPagerEndTime: z.number().int(),
  saturdayPagerStartTime: z.number().int(),
  saturdayPagerEndTime: z.number().int(),
  sundayPagerStartTime: z.number().int(),
  sundayPagerEndTime: z.number().int(),
  pagerDays: z.number().int(),
});

export type OperatorDefinition = z.infer<typeof operatorDefinitionSchema>;

export const alertDefinitionSchema = z.object({
  schemaVersion: z.literal('AlertDefinition.v1'),
  name: z.string().min(1).max(128),
  enabled: z.boolean(),
  messageId: z.number().int(),
  severity: z.number().int(),
  databaseName: z.string().nullable(),
  eventDescriptionKeyword: z.string().nullable(),
  notificationMessage: z.string().nullable(),
  includeEventDescription: z.number().int(),
  delayBetweenResponses: z.number().int(),
  jobName: z.string().nullable(),
  performanceCondition: z.string().nullable(),
});

export type AlertDefinition = z.infer<typeof alertDefinitionSchema>;
