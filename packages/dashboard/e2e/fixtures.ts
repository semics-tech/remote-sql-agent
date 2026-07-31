import type { Locator, Page, Route } from '@playwright/test';
import { jobDefinitionSchema, type JobDefinition } from '@remote-sql-agent/protocol';

/**
 * A stubbed control plane.
 *
 * Every screen reads through `fetch('/api/...')`, so intercepting that gives a
 * whole dashboard with no server, no Postgres and no SQL Server. The API
 * contract is already tested for real end to end; what is untested, and what
 * these fixtures exist to reach, is the browser.
 *
 * Responses are deliberately literal rather than generated. A fixture that
 * computes its own expected value tends to agree with a broken implementation.
 */

/**
 * Scope to one panel by its heading.
 *
 * The overview lists the same job in more than one panel on purpose — a
 * long-running job appears under both "Running longer than usual" and "Running
 * now" — so an unscoped row lookup is genuinely ambiguous rather than merely
 * strict.
 */
export function panel(page: Page, title: string | RegExp): Locator {
  return page.locator('section.panel', {
    has: page.locator('header.panel-head', { hasText: title }),
  });
}

export const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
export const JOB_UUID = '22222222-2222-4222-8222-222222222222';

export const ADMIN = {
  user: {
    id: '33333333-3333-4333-8333-333333333333',
    username: 'admin',
    displayName: 'Ada Lovelace',
    role: 'Admin',
    identityProvider: 'local',
    roleFromIdp: false,
  },
  permissions: [
    'job.read',
    'job.write',
    'job.toggle',
    'job.start',
    'worker.admin',
    'user.admin',
    'audit.read',
  ],
};

/**
 * A three-step job whose flow is a plain 1 -> 2 -> 3 chain.
 *
 * Parsed through the real schema before it is handed to a test. A hand-written
 * fixture drifts from the contract silently, and the symptom is not a clear
 * failure — an earlier version of this file omitted `notifications`, and the
 * job editor rendered a blank page rather than complaining.
 */
export function linearDefinition(): JobDefinition {
  return jobDefinitionSchema.parse({
    schemaVersion: 'JobDefinition.v1',
    name: 'Nightly Maintenance',
    description: 'Fixture job.',
    enabled: true,
    categoryName: 'Database Maintenance',
    ownerLoginName: 'sa',
    startStepId: 1,
    notifications: {
      emailOperatorName: 'On Call',
      emailLevel: 2,
      netsendOperatorName: null,
      netsendLevel: 0,
      pageOperatorName: null,
      pageLevel: 0,
      eventlogLevel: 2,
      deleteLevel: 0,
    },
    steps: [
      step(1, 'Check integrity', 3, 0, 4, 3),
      step(2, 'Rebuild indexes', 3, 0, 4, 3),
      step(3, 'Update statistics', 1, 0, 2, 0),
    ],
    schedules: [],
    targetServers: ['(local)'],
  });
}

function step(
  stepId: number,
  name: string,
  onSuccessAction: number,
  onSuccessStepId: number,
  onFailAction: number,
  onFailStepId: number,
) {
  return {
    stepId,
    name,
    subsystem: 'TSQL',
    command: `-- ${name}\nSELECT 1;`,
    databaseName: 'master',
    databaseUserName: null,
    onSuccessAction,
    onSuccessStepId,
    onFailAction,
    onFailStepId,
    retryAttempts: 0,
    retryIntervalMinutes: 0,
    outputFileName: null,
    flags: 0,
    proxyName: null,
  };
}

export function jobSummary(overrides: Record<string, unknown> = {}) {
  return {
    jobUuid: JOB_UUID,
    name: 'Nightly Maintenance',
    enabled: true,
    categoryName: 'Database Maintenance',
    ownerLoginName: 'sa',
    description: 'Fixture job.',
    currentVersionNo: 4,
    isDrifted: false,
    driftDetectedAt: null,
    lastRunStatus: 1,
    lastRunAt: '2026-07-30T02:00:00.000Z',
    lastRunDurationSeconds: 240,
    nextRunAt: '2026-07-31T02:00:00.000Z',
    deletedAt: null,
    activityState: 'idle',
    activityStepName: null,
    activityStartedAt: null,
    ...overrides,
  };
}

export function jobDetail(overrides: Record<string, unknown> = {}) {
  return {
    ...jobSummary(),
    instanceId: INSTANCE_ID,
    currentDefinitionHash: 'a'.repeat(64),
    definition: linearDefinition(),
    activity: null,
    ...overrides,
  };
}

/** A job mid-run, on step 2 of 3, 90 seconds in, averaging 200. */
export function runningJob(overrides: Record<string, unknown> = {}) {
  return {
    instanceId: INSTANCE_ID,
    instanceName: 'MSSQLSERVER',
    hostName: 'SQLPROD01',
    jobUuid: JOB_UUID,
    jobName: 'Nightly Maintenance',
    currentStepId: 2,
    currentStepName: 'Rebuild indexes',
    currentStepNumber: 2,
    stepCount: 3,
    startedAt: '2026-07-30T02:00:00.000Z',
    elapsedSeconds: 90,
    averageSeconds: 200,
    lastDurationSeconds: 240,
    overrunRatio: 0.45,
    isLongRunning: false,
    ...overrides,
  };
}

export function overview(overrides: Record<string, unknown> = {}) {
  return {
    totals: {
      instances: 1,
      jobs: 12,
      jobsDisabled: 1,
      runningNow: 1,
      longRunning: 0,
      failedLast24h: 0,
      workersOnline: 1,
      workersOffline: 0,
      agentsStopped: 0,
    },
    running: [runningJob()],
    failures: [],
    workers: [],
    ...overrides,
  };
}

export function estateJob(overrides: Record<string, unknown> = {}) {
  return {
    instanceId: INSTANCE_ID,
    instanceName: 'MSSQLSERVER',
    hostName: 'SQLPROD01',
    environmentTag: 'production',
    jobUuid: JOB_UUID,
    jobName: 'Nightly Maintenance',
    enabled: true,
    categoryName: 'Database Maintenance',
    ownerLoginName: 'sa',
    lastRunStatus: 1,
    lastRunAt: '2026-07-30T02:04:00.000Z',
    lastRunDurationSeconds: 240,
    nextRunAt: '2026-07-31T02:00:00.000Z',
    elapsedSeconds: null,
    averageSeconds: 200,
    facets: ['succeeded'],
    ...overrides,
  };
}

/** The `/api/jobs` envelope. Counts default to what `jobs` actually contains. */
export function estateJobs(
  jobs: Array<Record<string, unknown>> = [estateJob()],
  overrides: Record<string, unknown> = {},
) {
  const counts: Record<string, number> = {
    running: 0,
    longRunning: 0,
    failed: 0,
    succeeded: 0,
    retry: 0,
    cancelled: 0,
    neverRun: 0,
    disabled: 0,
    drifted: 0,
  };
  for (const job of jobs) {
    for (const facet of (job.facets as string[]) ?? []) counts[facet] = (counts[facet] ?? 0) + 1;
  }
  return {
    jobs,
    counts,
    total: jobs.length,
    matched: jobs.length,
    returned: jobs.length,
    truncated: false,
    ...overrides,
  };
}

/** The `/api/environment-grants` envelope. */
export function environmentGrants(overrides: Record<string, unknown> = {}) {
  return {
    grants: [
      {
        id: '55555555-5555-4555-8555-555555555555',
        subjectKind: 'entra_group',
        subjectKey: '11111111-2222-3333-4444-555555555555',
        subjectLabel: 'production DBAs',
        environmentTag: 'production',
        role: 'Editor',
        createdAt: '2026-07-01T09:00:00.000Z',
      },
    ],
    environments: ['production', 'uat'],
    untaggedInstances: [],
    ...overrides,
  };
}

/** Default responses, by pathname. Each test overrides what it cares about. */
export function defaultRoutes(): Record<string, unknown> {
  return {
    '/api/auth/config': { localEnabled: true, entraEnabled: false, entraLoginUrl: '' },
    '/api/auth/me': ADMIN,
    '/api/overview': overview(),
    '/api/jobs': estateJobs(),
    '/api/estate': { instances: [] },
    '/api/environment-grants': environmentGrants(),
    '/api/commands': { commands: [], pendingApproval: 0 },
    [`/api/instances/${INSTANCE_ID}/jobs/${JOB_UUID}`]: jobDetail(),
    [`/api/instances/${INSTANCE_ID}/jobs/${JOB_UUID}/history`]: { runs: [] },
    [`/api/instances/${INSTANCE_ID}/jobs/${JOB_UUID}/stats`]: null,
    [`/api/instances/${INSTANCE_ID}/jobs/${JOB_UUID}/versions`]: { versions: [] },
    // The editor is only editable when the worker's own ceiling allows writes
    // *and* the operator has the permission — the two-gate model. Both have to
    // be present here or every editing test silently exercises the read-only
    // view instead.
    [`/api/instances/${INSTANCE_ID}/capabilities`]: {
      hostName: 'SQLPROD01',
      workerCapabilities: ['job.read', 'job.write', 'job.toggle', 'job.start'],
      yourPermissions: ADMIN.permissions,
      approvalRequiredForJobWrite: false,
    },
  };
}

/**
 * A stubbed response: either a literal body, or a function called per request.
 *
 * The function form is what makes "the worker applied it" testable — the same
 * path has to answer differently before and after a command is issued, and a
 * literal cannot.
 */
export type RouteBody = unknown | (() => unknown);

export interface MockOptions {
  /** Merged over defaultRoutes(). A null value returns 404. */
  routes?: Record<string, RouteBody>;
  /** Called for anything not matched, so a test can assert on writes. */
  onUnmatched?: (route: Route, pathname: string) => Promise<boolean> | boolean;
}

/**
 * Serve the stubbed API for a page.
 *
 * `/api/events` is answered with a `retry` directive far in the future rather
 * than being aborted: EventSource reconnects on failure, and a test that
 * silently retries a dead stream every three seconds is a test that
 * intermittently times out for reasons unrelated to what it is checking.
 */
export async function mockApi(page: Page, options: MockOptions = {}): Promise<void> {
  const routes = { ...defaultRoutes(), ...(options.routes ?? {}) };

  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;

    if (pathname === '/api/events') {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'retry: 86400000\n\n',
      });
      return;
    }

    if (pathname in routes) {
      const stub = routes[pathname];
      const body = typeof stub === 'function' ? (stub as () => unknown)() : stub;
      if (body === null) {
        await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
      return;
    }

    if (options.onUnmatched && (await options.onUnmatched(route, pathname))) return;

    // Anything unstubbed is an empty success rather than a hang, so a screen
    // gaining a new call does not fail every unrelated test at once.
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}
