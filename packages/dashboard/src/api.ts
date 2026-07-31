import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { JobDefinition, JobWriteMode } from '@remote-sql-agent/protocol/browser';
import { apiFetch } from './auth.jsx';

/** Typed client for the control plane read API. */

export interface EstateInstance {
  instanceId: string;
  instanceName: string;
  hostName: string;
  serverName: string | null;
  sqlVersion: string | null;
  sqlEdition: string | null;
  agentStatus: string;
  environmentTag: string | null;
  lastSeenAt: string | null;
  workerConnected: boolean;
  jobCount: number;
  failedLast24h: number;
  runningNow: number;
  driftedJobs: number;
}

export interface JobSummary {
  jobUuid: string;
  name: string;
  enabled: boolean;
  categoryName: string | null;
  ownerLoginName: string | null;
  description: string | null;
  currentVersionNo: number;
  isDrifted: boolean;
  driftDetectedAt: string | null;
  lastRunStatus: number | null;
  lastRunAt: string | null;
  lastRunDurationSeconds: number | null;
  nextRunAt: string | null;
  deletedAt: string | null;
  activityState: string | null;
  activityStepName: string | null;
  activityStartedAt: string | null;
}

export interface JobDetail extends JobSummary {
  instanceId: string;
  /** Hash of the definition currently mirrored. Sent with every write as the
   * base for conflict detection. */
  currentDefinitionHash: string | null;
  definition: JobDefinition | null;
  activity: {
    state: string;
    currentStepId: number | null;
    currentStepName: string | null;
    startedAt: string | null;
    nextScheduledRunAt: string | null;
  } | null;
}

export interface HistoryStep {
  sqlInstanceId: number;
  stepId: number;
  stepName: string | null;
  runStatus: number;
  runDatetime: string;
  runDurationSeconds: number;
  message: string | null;
  retriesAttempted: number;
  sqlSeverity: number;
  sqlMessageId: number;
}

export interface HistoryRun {
  sqlInstanceId: number;
  runDatetime: string;
  runStatus: number;
  runDurationSeconds: number;
  message: string | null;
  steps: HistoryStep[];
}

export interface JobVersion {
  id: string;
  versionNo: number;
  definitionHash: string;
  origin: 'initial' | 'local' | 'remote';
  commandId: string | null;
  createdBy: string | null;
  detectedAt: string;
}

export interface FieldChange {
  kind: 'field';
  path: string;
  before: unknown;
  after: unknown;
}

export interface StepChange {
  kind: 'step';
  change: 'added' | 'removed' | 'modified';
  stepId: number;
  stepName: string;
  fields?: FieldChange[];
  commandBefore?: string;
  commandAfter?: string;
}

export interface ScheduleChange {
  kind: 'schedule';
  change: 'added' | 'removed' | 'modified';
  name: string;
  fields?: FieldChange[];
}

export type Change = FieldChange | StepChange | ScheduleChange;

export interface DiffResult {
  from: { versionNo: number; detectedAt: string; origin: string };
  to: { versionNo: number; detectedAt: string; origin: string };
  changes: Change[];
}

export interface SearchHit {
  instanceId: string;
  instanceName: string;
  hostName: string;
  jobUuid: string;
  jobName: string;
  enabled: boolean;
  isDrifted: boolean;
  nameMatched: boolean;
  matchingSteps: Array<{ stepId: number; stepName: string; excerpt: string }>;
}

export interface WorkerRow {
  id: string;
  hostName: string;
  version: string | null;
  capabilities: string[];
  maxCapabilityReported: string | null;
  connectedAt: string | null;
  lastSeenAt: string | null;
  certExpiresAt: string | null;
  certRevokedAt: string | null;
  instanceCount: number;
  online: boolean;
}

export interface AuditEntry {
  id: string;
  at: string;
  actorType: string;
  actor: string;
  action: string;
  target: string | null;
  detail: unknown;
  remoteAddress: string | null;
}

export interface AgentLogEntry {
  id: string;
  loggedAt: string;
  severity: string | null;
  message: string;
  processInfo: string | null;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      // Response body was not JSON; the status text is the best we have.
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

/** Live-ish views poll; static ones do not. Kept in one place so the refresh
 * story is legible rather than scattered across components. */
const LIVE_REFRESH_MS = 5_000;

/**
 * The cadence while something is actually happening.
 *
 * Five seconds is fine for a page nobody is staring at, and far too slow when
 * an operator has just pressed Start and is waiting to see the job move. This
 * only applies to the one job being watched, so the extra requests are bounded.
 */
const ACTIVE_REFRESH_MS = 1_500;

export function useEstate() {
  return useQuery({
    queryKey: ['estate'],
    queryFn: () => get<{ instances: EstateInstance[] }>('/api/estate'),
    refetchInterval: LIVE_REFRESH_MS,
  });
}

export function useInstance(instanceId: string | undefined) {
  return useQuery({
    queryKey: ['instance', instanceId],
    queryFn: () => get<EstateInstance & { workerOnline: boolean; workerId: string; capabilities: string[]; maxCapabilityReported: string | null; workerVersion: string | null; id: string }>(`/api/instances/${instanceId}`),
    enabled: Boolean(instanceId),
    refetchInterval: LIVE_REFRESH_MS,
  });
}

export function useJobs(instanceId: string | undefined) {
  return useQuery({
    queryKey: ['jobs', instanceId],
    queryFn: () => get<{ jobs: JobSummary[] }>(`/api/instances/${instanceId}/jobs`),
    enabled: Boolean(instanceId),
    refetchInterval: LIVE_REFRESH_MS,
  });
}

export function useJob(
  instanceId: string | undefined,
  jobUuid: string | undefined,
  live = false,
) {
  return useQuery({
    queryKey: ['job', instanceId, jobUuid],
    queryFn: () => get<JobDetail>(`/api/instances/${instanceId}/jobs/${jobUuid}`),
    enabled: Boolean(instanceId && jobUuid),
    refetchInterval: live ? ACTIVE_REFRESH_MS : LIVE_REFRESH_MS,
  });
}

export function useJobHistory(
  instanceId: string | undefined,
  jobUuid: string | undefined,
  live = false,
) {
  return useQuery({
    queryKey: ['history', instanceId, jobUuid],
    queryFn: () => get<{ runs: HistoryRun[] }>(`/api/instances/${instanceId}/jobs/${jobUuid}/history?limit=50`),
    enabled: Boolean(instanceId && jobUuid),
    refetchInterval: live ? ACTIVE_REFRESH_MS : LIVE_REFRESH_MS,
  });
}

export function useJobVersions(instanceId: string | undefined, jobUuid: string | undefined) {
  return useQuery({
    queryKey: ['versions', instanceId, jobUuid],
    queryFn: () => get<{ versions: JobVersion[] }>(`/api/instances/${instanceId}/jobs/${jobUuid}/versions`),
    enabled: Boolean(instanceId && jobUuid),
  });
}

export function useDiff(
  instanceId: string | undefined,
  jobUuid: string | undefined,
  from: number | null,
  to: number | null,
) {
  return useQuery({
    queryKey: ['diff', instanceId, jobUuid, from, to],
    queryFn: () =>
      get<DiffResult>(`/api/instances/${instanceId}/jobs/${jobUuid}/diff?from=${from}&to=${to}`),
    enabled: Boolean(instanceId && jobUuid && from !== null && to !== null && from !== to),
  });
}

export function useSearch(query: string) {
  return useQuery({
    queryKey: ['search', query],
    queryFn: () => get<{ query: string; hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(query)}`),
    enabled: query.trim().length >= 2,
  });
}

export function useWorkers() {
  return useQuery({
    queryKey: ['workers'],
    queryFn: () => get<{ workers: WorkerRow[] }>('/api/workers'),
    refetchInterval: LIVE_REFRESH_MS,
  });
}

export function useAudit() {
  return useQuery({
    queryKey: ['audit'],
    queryFn: () => get<{ entries: AuditEntry[] }>('/api/audit?limit=200'),
  });
}

// ---------------------------------------------------------------------------
// Write path (M4)
// ---------------------------------------------------------------------------

export interface CommandRow {
  id: string;
  type: string;
  state:
    | 'pending_approval'
    | 'approved'
    | 'dispatched'
    | 'succeeded'
    | 'failed'
    | 'expired'
    | 'rejected';
  instanceId: string;
  instanceName: string;
  hostName: string;
  jobUuid: string | null;
  jobName: string | null;
  payload: Record<string, unknown>;
  issuedBy: string | null;
  approvedBy: string | null;
  resultCode: string | null;
  resultDetail: string | null;
  sqlErrorNumber: number | null;
  issuedAt: string;
  completedAt: string | null;
  expiresAt: string | null;
}

export interface InstanceCapabilities {
  hostName: string;
  workerCapabilities: string[];
  yourPermissions: string[];
  approvalRequiredForJobWrite: boolean;
  /**
   * What SQL Server itself will permit on this instance, which is a separate
   * question from what this product grants. A worker can hold job.write and
   * still be unable to edit a job owned by another login.
   */
  jobWriteMode: JobWriteMode;
}

export interface IssuedCommand {
  id: string;
  state: string;
  requiresApproval: boolean;
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await apiFetch(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
    // The server's refusal messages explain *why* — surfacing them verbatim is
    // more use than a generic failure toast.
    throw new Error(detail.detail ?? detail.error ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export function useInstanceCapabilities(instanceId: string | undefined) {
  return useQuery({
    queryKey: ['capabilities', instanceId],
    queryFn: () => get<InstanceCapabilities>(`/api/instances/${instanceId}/capabilities`),
    enabled: Boolean(instanceId),
  });
}

export function useCommands(state?: CommandRow['state']) {
  return useQuery({
    queryKey: ['commands', state ?? 'all'],
    queryFn: () =>
      get<{ commands: CommandRow[]; pendingApproval: number }>(
        `/api/commands?limit=100${state ? `&state=${state}` : ''}`,
      ),
    refetchInterval: LIVE_REFRESH_MS,
  });
}

/** States a command will not move on from. */
const TERMINAL_COMMAND_STATES = ['succeeded', 'failed', 'expired', 'rejected'] as const;

/**
 * Wait for a command the caller just issued to reach a terminal state.
 *
 * Issuing a command only queues and dispatches it. Whether msdb accepted it is
 * decided on the SQL host and arrives seconds later, so anything that reports
 * success at the point of issue is guessing — and until this existed, the job
 * editor guessed, said "Saved and sent to the worker.", and never corrected
 * itself when the worker refused the change.
 *
 * Resolves with the command however it ends, or null if it is still running
 * when we stop waiting. Still-running is not failure: the worker may be
 * offline and the command legitimately queued, which the caller words
 * differently.
 */
export async function awaitCommandOutcome(
  commandId: string,
  { timeoutMs = 15_000, intervalMs = 700 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<CommandRow | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const command = await get<CommandRow>(`/api/commands/${commandId}`);
    if ((TERMINAL_COMMAND_STATES as readonly string[]).includes(command.state)) return command;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Turn a failed command into something an operator can act on.
 *
 * SQL Server's own text is kept — a DBA will want the exact wording — but the
 * cases that have a specific remedy get told what it is, because the raw
 * message describes the rule rather than the way out of it.
 */
export function explainCommandFailure(command: CommandRow): string {
  const detail = command.resultDetail?.trim();

  // 14525: the job is owned by another login and the worker is not sysadmin.
  // The message names the rule and not one of the three things that resolve it.
  if (command.sqlErrorNumber === 14525) {
    return (
      'SQL Server refused the change because this job is owned by a different login, ' +
      'and the worker is not a member of sysadmin. Nothing was changed. ' +
      'Enable and disable still work on jobs the worker does not own — only editing is refused.'
    );
  }

  if (command.state === 'rejected') {
    return detail ? `The change was rejected: ${detail}` : 'The change was rejected.';
  }
  if (command.state === 'expired') {
    return 'The worker did not pick this change up before it expired. Nothing was changed.';
  }
  if (command.resultCode === 'CapabilityDenied') {
    return detail ?? 'This worker is not permitted to make that change.';
  }
  if (command.resultCode === 'Conflict') {
    return detail ?? 'The job changed on the server while you were editing it.';
  }
  return detail
    ? `The worker could not apply the change: ${detail}`
    : 'The worker could not apply the change. Nothing was changed.';
}

export function useJobActions(instanceId: string | undefined, jobUuid: string | undefined) {
  const queryClient = useQueryClient();
  const base = `/api/instances/${instanceId}/jobs/${jobUuid}`;

  // Every action invalidates broadly: a command changes job state, version
  // history, and the command queue, and the operator should see all three move.
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries();
  };

  return {
    toggle: async (enabled: boolean, baseDefinitionHash?: string) => {
      const result = await send<IssuedCommand>(`${base}/toggle`, 'POST', {
        enabled,
        baseDefinitionHash,
      });
      await refresh();
      return result;
    },
    run: async (stepName?: string) => {
      const result = await send<IssuedCommand>(`${base}/run`, 'POST', { stepName });
      await refresh();
      return result;
    },
    stop: async () => {
      const result = await send<IssuedCommand>(`${base}/stop`, 'POST', {});
      await refresh();
      return result;
    },
    save: async (definition: unknown, baseDefinitionHash?: string, allowOverwrite = false) => {
      const result = await send<IssuedCommand>(base, 'PUT', {
        definition,
        baseDefinitionHash,
        allowOverwrite,
      });
      await refresh();
      return result;
    },
    remove: async (baseDefinitionHash?: string) => {
      const result = await send<IssuedCommand>(base, 'DELETE', { baseDefinitionHash });
      await refresh();
      return result;
    },
    /**
     * Put this job under central management, or take it out.
     *
     * Also invalidates capabilities, because the allowlist lives there — the
     * save button unlocks off the back of this and would otherwise stay
     * disabled until something else happened to refetch.
     */
    setWriteAllowed: async (allowed: boolean) => {
      const result = await send<IssuedCommand>(`${base}/write-allowed`, 'POST', { allowed });
      await refresh();
      await queryClient.invalidateQueries({ queryKey: ['capabilities'] });
      return result;
    },
  };
}

export function useCommandApproval() {
  const queryClient = useQueryClient();
  return {
    approve: async (commandId: string) => {
      await send(`/api/commands/${commandId}/approve`, 'POST', {});
      await queryClient.invalidateQueries();
    },
    reject: async (commandId: string, reason: string) => {
      await send(`/api/commands/${commandId}/reject`, 'POST', { reason });
      await queryClient.invalidateQueries();
    },
  };
}

export function useAgentLog(instanceId: string | undefined) {
  return useQuery({
    queryKey: ['agent-log', instanceId],
    queryFn: () => get<{ entries: AgentLogEntry[] }>(`/api/instances/${instanceId}/agent-log`),
    enabled: Boolean(instanceId),
  });
}

// ---------------------------------------------------------------------------
// Operations overview
// ---------------------------------------------------------------------------

export interface RunningJob {
  instanceId: string;
  instanceName: string;
  hostName: string;
  jobUuid: string;
  jobName: string;
  currentStepId: number | null;
  currentStepName: string | null;
  currentStepNumber: number | null;
  stepCount: number | null;
  startedAt: string | null;
  /** Measured by the server when it replied; tick it forward from there. */
  elapsedSeconds: number | null;
  averageSeconds: number | null;
  lastDurationSeconds: number | null;
  overrunRatio: number | null;
  isLongRunning: boolean;
}

export interface FailedRun {
  instanceId: string;
  instanceName: string;
  hostName: string;
  jobUuid: string;
  jobName: string;
  runDatetime: string;
  runDurationSeconds: number;
  message: string | null;
  consecutiveFailures: number;
}

export interface WorkerHealth {
  workerId: string;
  hostName: string;
  version: string | null;
  online: boolean;
  lastSeenAt: string | null;
  instanceCount: number;
  agentsNotRunning: number;
}

export interface Overview {
  totals: {
    instances: number;
    jobs: number;
    jobsDisabled: number;
    runningNow: number;
    longRunning: number;
    failedLast24h: number;
    workersOnline: number;
    workersOffline: number;
    agentsStopped: number;
  };
  running: RunningJob[];
  failures: FailedRun[];
  workers: WorkerHealth[];
}

export function useOverview() {
  return useQuery({
    queryKey: ['overview'],
    queryFn: () => get<Overview>('/api/overview'),
    refetchInterval: LIVE_REFRESH_MS,
  });
}

// ---------------------------------------------------------------------------
// Job statistics
// ---------------------------------------------------------------------------

export interface RunPoint {
  sqlInstanceId: number;
  runDatetime: string;
  runStatus: number;
  runDurationSeconds: number;
}

export interface StepStat {
  stepId: number;
  stepName: string | null;
  runs: number;
  failures: number;
  averageSeconds: number;
  maxSeconds: number;
  lastSeconds: number | null;
}

export interface CurrentRun {
  startedAt: string | null;
  elapsedSeconds: number | null;
  currentStepId: number | null;
  currentStepName: string | null;
  completedSteps: Array<{
    stepId: number;
    stepName: string | null;
    runStatus: number;
    startedAt: string;
    runDurationSeconds: number;
    message: string | null;
  }>;
}

export interface JobStats {
  windowDays: number;
  totalRuns: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  retried: number;
  successRate: number | null;
  duration: {
    averageSeconds: number | null;
    medianSeconds: number | null;
    p95Seconds: number | null;
    minSeconds: number | null;
    maxSeconds: number | null;
    lastSeconds: number | null;
    trend: number | null;
  };
  recentRuns: RunPoint[];
  steps: StepStat[];
  currentRun: CurrentRun | null;
}

/**
 * Poll faster while a run is in flight.
 *
 * A five-second tick is fine for a static page and far too slow to watch a job
 * move between steps, which is the entire point of the live graph.
 */
export function useJobStats(
  instanceId: string | undefined,
  jobUuid: string | undefined,
  live: boolean,
) {
  return useQuery({
    queryKey: ['job-stats', instanceId, jobUuid],
    queryFn: () => get<JobStats>(`/api/instances/${instanceId}/jobs/${jobUuid}/stats`),
    enabled: Boolean(instanceId && jobUuid),
    refetchInterval: live ? ACTIVE_REFRESH_MS : LIVE_REFRESH_MS,
  });
}

// ---------------------------------------------------------------------------
// Cross-estate grouping
// ---------------------------------------------------------------------------

export type GroupKey = 'name' | 'category' | 'owner' | 'schedule' | 'instance';

export interface GroupMember {
  instanceId: string;
  instanceName: string;
  hostName: string;
  jobUuid: string;
  jobName: string;
  enabled: boolean;
  categoryName: string | null;
  ownerLoginName: string | null;
  scheduleSummary: string;
  lastRunStatus: number | null;
  lastRunAt: string | null;
  lastRunDurationSeconds: number | null;
  nextRunAt: string | null;
  running: boolean;
}

export interface JobGroup {
  key: string;
  label: string;
  members: GroupMember[];
  total: number;
  failing: number;
  running: number;
  disabled: number;
  neverRun: number;
}

export function useJobGroups(groupBy: GroupKey, filter: string) {
  return useQuery({
    queryKey: ['job-groups', groupBy, filter],
    queryFn: () =>
      get<{ groupBy: GroupKey; groups: JobGroup[]; truncated: boolean }>(
        `/api/jobs/groups?by=${groupBy}${filter ? `&filter=${encodeURIComponent(filter)}` : ''}`,
      ),
    refetchInterval: LIVE_REFRESH_MS,
  });
}

// ---------------------------------------------------------------------------
// Worker onboarding
// ---------------------------------------------------------------------------

export interface PendingWorker {
  workerId: string;
  hostName: string;
  version: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  hasCredentialKey: boolean;
  configuredInstances: number;
  liveInstances: number;
  online: boolean;
}

export interface InstanceConfigView {
  id: string;
  workerId: string;
  instanceName: string;
  serverAddress: string;
  authMode: 'integrated' | 'sql';
  loginName: string | null;
  hasCredential: boolean;
  credentialUpdatedAt: string | null;
  encryptTls: boolean;
  trustServerCertificate: boolean;
  environmentTag: string | null;
  status:
    | 'awaiting_credentials'
    | 'pending'
    | 'connected'
    | 'auth_failed'
    | 'unreachable'
    | 'decrypt_failed';
  statusDetail: string | null;
  statusAt: string | null;
}

export interface EnrolmentTokenResult {
  token: string;
  expiresAt: string;
  hostName: string;
  note: string;
  install: { windows: string; linux: string; manual: string };
}

export function usePendingWorkers() {
  return useQuery({
    queryKey: ['pending-workers'],
    queryFn: () => get<{ workers: PendingWorker[] }>('/api/workers/awaiting-setup'),
    refetchInterval: LIVE_REFRESH_MS,
  });
}

export function useInstanceConfigs(workerId: string | undefined) {
  return useQuery({
    queryKey: ['instance-configs', workerId],
    queryFn: () =>
      get<{ configs: InstanceConfigView[] }>(`/api/workers/${workerId}/instance-configs`),
    enabled: Boolean(workerId),
    refetchInterval: LIVE_REFRESH_MS,
  });
}

export function useWorkerAdmin() {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries();

  return {
    createEnrolmentToken: async (input: {
      hostName: string;
      credentialMode: 'token' | 'mtls' | 'entra';
      capabilities: string[];
    }) => send<EnrolmentTokenResult>('/api/enrolment-tokens', 'POST', input),

    setCapabilities: async (workerId: string, capabilities: string[]) => {
      const result = await send<{ capabilities: string[]; note: string }>(
        `/api/workers/${workerId}/capabilities`,
        'POST',
        { capabilities },
      );
      await refresh();
      return result;
    },

    /** The key a credential must be encrypted to before it is submitted. */
    credentialKey: async (workerId: string) =>
      send<{ publicKeyPem: string; fingerprint: string }>(
        `/api/workers/${workerId}/credential-key`,
        'GET',
      ),

    saveInstanceConfig: async (
      workerId: string,
      input: {
        instanceName: string;
        serverAddress: string;
        authMode: 'integrated' | 'sql';
        loginName?: string | null;
        credentialCiphertext?: string | null;
        credentialKeyFingerprint?: string | null;
        encryptTls?: boolean;
        trustServerCertificate?: boolean;
        environmentTag?: string | null;
      },
    ) => {
      const result = await send<{ config: InstanceConfigView; delivered: boolean; note: string }>(
        `/api/workers/${workerId}/instance-configs`,
        'PUT',
        input,
      );
      await refresh();
      return result;
    },

    removeInstanceConfig: async (workerId: string, configId: string) => {
      await send(`/api/workers/${workerId}/instance-configs/${configId}`, 'DELETE');
      await refresh();
    },
  };
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export type ChannelKind = 'email' | 'slack' | 'teams' | 'webhook';

export type NotificationEventKind =
  | 'job.failed'
  | 'job.succeeded'
  | 'job.recovered'
  | 'job.long_running'
  | 'worker.offline'
  | 'command.failed';

export interface NotificationChannel {
  id: string;
  name: string;
  kind: ChannelKind;
  config: Record<string, unknown>;
  hasSecret: boolean;
  secretHint: string | null;
  enabled: boolean;
  lastDeliveredAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

export interface NotificationRule {
  id: string;
  name: string;
  enabled: boolean;
  events: NotificationEventKind[];
  instanceIds: string[];
  jobNameContains: string | null;
  channelIds: string[];
  throttleMinutes: number;
}

export interface NotificationDelivery {
  id: string;
  state: 'pending' | 'sent' | 'failed' | 'suppressed';
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
  createdAt: string;
  channelName: string;
  channelKind: ChannelKind;
  eventKind: NotificationEventKind;
  eventPayload: Record<string, unknown>;
  occurredAt: string;
}

export function useNotificationChannels() {
  return useQuery({
    queryKey: ['notification-channels'],
    queryFn: () => get<{ channels: NotificationChannel[] }>('/api/notifications/channels'),
  });
}

export function useNotificationRules() {
  return useQuery({
    queryKey: ['notification-rules'],
    queryFn: () => get<{ rules: NotificationRule[] }>('/api/notifications/rules'),
  });
}

export function useNotificationDeliveries() {
  return useQuery({
    queryKey: ['notification-deliveries'],
    queryFn: () =>
      get<{ deliveries: NotificationDelivery[] }>('/api/notifications/deliveries?limit=100'),
    refetchInterval: LIVE_REFRESH_MS,
  });
}

export function useNotificationAdmin() {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries();

  return {
    saveChannel: async (input: {
      id?: string;
      name: string;
      kind: ChannelKind;
      config: Record<string, unknown>;
      secret?: string;
      enabled: boolean;
    }) => {
      const result = await send<NotificationChannel>('/api/notifications/channels', 'POST', input);
      await refresh();
      return result;
    },
    removeChannel: async (channelId: string) => {
      await send(`/api/notifications/channels/${channelId}`, 'DELETE');
      await refresh();
    },
    testChannel: async (channelId: string) =>
      send<{ sent: boolean }>(`/api/notifications/channels/${channelId}/test`, 'POST', {}),
    saveRule: async (input: {
      id?: string;
      name: string;
      enabled: boolean;
      events: NotificationEventKind[];
      instanceIds: string[];
      jobNameContains?: string | null;
      channelIds: string[];
      throttleMinutes: number;
    }) => {
      const result = await send<NotificationRule>('/api/notifications/rules', 'POST', input);
      await refresh();
      return result;
    },
    removeRule: async (ruleId: string) => {
      await send(`/api/notifications/rules/${ruleId}`, 'DELETE');
      await refresh();
    },
  };
}
