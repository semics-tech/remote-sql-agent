import { z } from 'zod';

/**
 * Admin-configurable redaction of the free-text `message` field on a job's
 * run history (`HistoryBatch` -> `jobHistory`, mirrors msdb.dbo.sysjobhistory).
 * A step's output message can carry whatever the step itself printed — a
 * connection string, row data, anything — and this lets an admin strip it
 * before it is ever stored.
 *
 * Redact-only, deliberately: `runStatus`, `stepId`, timing and the rest of a
 * history row feed failure-rate stats, retry tracking and "which step is this
 * job on right now" elsewhere in the product (domain/stats.ts, job-flow.ts).
 * A rule that could drop or hide a whole row would silently corrupt those —
 * so there is no drop action here, unlike the Agent-error-log scrubbing this
 * is deliberately not built on top of (log-scrub.ts). Every row that arrives
 * is still stored; only text inside `message` can be replaced.
 */

export const MAX_HISTORY_SCRUB_RULES = 20;
export const MAX_HISTORY_SCRUB_PATTERN_LENGTH = 200;
export const MAX_HISTORY_SCRUB_DESCRIPTION_LENGTH = 200;

export const historyScrubRuleSchema = z.object({
  /** Client-generated, so the rule list has a stable React key across edits. */
  id: z.string().min(1).max(64),
  description: z.string().max(MAX_HISTORY_SCRUB_DESCRIPTION_LENGTH),
  /** Regex source, case-insensitive, matched against the history row's `message` only. */
  pattern: z.string().min(1).max(MAX_HISTORY_SCRUB_PATTERN_LENGTH),
});
export type HistoryScrubRule = z.infer<typeof historyScrubRuleSchema>;

export const historyScrubConfigSchema = z.object({
  rules: z.array(historyScrubRuleSchema).max(MAX_HISTORY_SCRUB_RULES),
});
export type HistoryScrubConfigInput = z.infer<typeof historyScrubConfigSchema>;

export const DEFAULT_HISTORY_SCRUB_CONFIG: HistoryScrubConfigInput = { rules: [] };

/** Case-insensitive, matched against `message` only, never against step bodies. */
export function compileHistoryScrubPattern(pattern: string): RegExp {
  return new RegExp(pattern, 'giu');
}

/** Compiles every rule's pattern; throws with the offending rule's id/description on the first failure. */
export function assertHistoryScrubRulesCompile(rules: readonly HistoryScrubRule[]): void {
  for (const rule of rules) {
    try {
      compileHistoryScrubPattern(rule.pattern);
    } catch {
      throw new Error(`Rule "${rule.description || rule.id}" has an invalid pattern: ${rule.pattern}`);
    }
  }
}
