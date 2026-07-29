import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { JobDefinition } from '@remote-sql-agent/protocol/browser';
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

export function useJob(instanceId: string | undefined, jobUuid: string | undefined) {
  return useQuery({
    queryKey: ['job', instanceId, jobUuid],
    queryFn: () => get<JobDetail>(`/api/instances/${instanceId}/jobs/${jobUuid}`),
    enabled: Boolean(instanceId && jobUuid),
    refetchInterval: LIVE_REFRESH_MS,
  });
}

export function useJobHistory(instanceId: string | undefined, jobUuid: string | undefined) {
  return useQuery({
    queryKey: ['history', instanceId, jobUuid],
    queryFn: () => get<{ runs: HistoryRun[] }>(`/api/instances/${instanceId}/jobs/${jobUuid}/history?limit=50`),
    enabled: Boolean(instanceId && jobUuid),
    refetchInterval: LIVE_REFRESH_MS,
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
  issuedAt: string;
  completedAt: string | null;
  expiresAt: string | null;
}

export interface InstanceCapabilities {
  hostName: string;
  workerCapabilities: string[];
  yourPermissions: string[];
  approvalRequiredForJobWrite: boolean;
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
