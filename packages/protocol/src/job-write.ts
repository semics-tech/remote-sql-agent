/**
 * Whether a job can be edited at all, on the instance it lives on.
 *
 * SQL Server decides this, not us. `sp_update_job` refuses a job owned by a
 * different login unless the caller is `sysadmin`:
 *
 *   IF ( (@x_owner_sid <> SUSER_SID())
 *        AND (ISNULL(IS_SRVROLEMEMBER(N'sysadmin'), 0) <> 1)
 *        AND (@enable_only_used <> 1 OR ISNULL(IS_MEMBER(N'SQLAgentOperatorRole'), 0) <> 1))
 *     RAISERROR(14525, -1, -1)
 *
 * On a typical estate most jobs are owned by `sa`, so without one of the routes
 * below a worker can mirror everything and edit almost nothing.
 *
 * Note the third clause: **enable, disable, start and stop are unaffected** and
 * work on any job regardless of owner. Only editing a definition is refused.
 *
 * This rule lives in the contracts package because both ends apply it — the
 * worker before it attempts a write, the dashboard before it offers one. Two
 * implementations would drift, and the symptom would be a save button that is
 * offered and then fails.
 */

/** What a worker reported it can edit on one instance. */
export interface JobWriteMode {
  /** `SUSER_SNAME()` as the worker sees it, not what config claims. */
  sqlLoginName: string;
  /** `IS_SRVROLEMEMBER('sysadmin')`. Everything is editable if set. */
  isSysadmin: boolean;
  /** deploy/sql/worker-write-wrapper.sql is installed and callable. */
  wrapperInstalled: boolean;
  /** That install permits the allowlist to be managed from the dashboard. */
  wrapperAllowsDashboardManagement: boolean;
  /** Jobs the wrapper currently permits. Empty is the default. */
  allowlistedJobs: string[];
}

/** A worker that has not reported yet can edit nothing. */
export const NO_JOB_WRITE: JobWriteMode = {
  sqlLoginName: '',
  isSysadmin: false,
  wrapperInstalled: false,
  wrapperAllowsDashboardManagement: false,
  allowlistedJobs: [],
};

export function canEditJob(
  mode: JobWriteMode,
  job: { name: string; ownerLoginName: string | null },
): boolean {
  if (mode.isSysadmin) return true;
  // Comparisons are case-insensitive throughout: SQL Server logins are, and the
  // allowlist is matched against a job name SQL Server also treats
  // case-insensitively under the default collation. Comparing exactly would
  // refuse edits SQL Server would have accepted.
  if (job.ownerLoginName && job.ownerLoginName.toLowerCase() === mode.sqlLoginName.toLowerCase()) {
    return true;
  }
  if (!mode.wrapperInstalled) return false;
  return mode.allowlistedJobs.some((name) => name.toLowerCase() === job.name.toLowerCase());
}

/** Why an edit is unavailable, in terms an operator can act on. */
export function explainJobWriteBlock(
  mode: JobWriteMode,
  job: { name: string; ownerLoginName: string | null },
): string | null {
  if (canEditJob(mode, job)) return null;

  const owner = job.ownerLoginName ?? 'an unknown login';
  const base =
    `SQL Server will not let this worker edit "${job.name}", because the job is owned by ` +
    `${owner} and the worker connects as ${mode.sqlLoginName || 'an unknown login'}. ` +
    `Enabling, disabling, starting and stopping still work.`;

  if (!mode.wrapperInstalled) {
    return (
      `${base} To edit it, a DBA installs deploy/sql/worker-write-wrapper.sql on this instance — ` +
      `that grants editing of named jobs without giving the worker sysadmin.`
    );
  }
  if (!mode.wrapperAllowsDashboardManagement) {
    return (
      `${base} The write wrapper is installed but maintained by a DBA on this instance, so add ` +
      `the job to msdb.dbo.rsagent_write_allowlist there.`
    );
  }
  return `${base} Put it under central management to allow editing.`;
}
