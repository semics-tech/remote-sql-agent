import { z } from 'zod';

/**
 * Admin-configurable control over what the SQL Server Agent error log
 * (`AgentLogBatch` -> `agentLogEntries`, §5.2) is allowed to carry past
 * ingestion into the control plane. Enforced entirely server-side, at the
 * point a batch is received — a row that does not pass never gets stored, so
 * it can never reach the dashboard or an export.
 *
 * Deliberately declarative rather than a scriptable rule (no JS/eval): the
 * product has no "run arbitrary T-SQL" command and does not add an
 * admin-configured code-execution path here either — the same reasoning, for
 * the same reason (§6 of docs/security.md).
 */

export const AGENT_LOG_SEVERITIES = ['error', 'warning', 'info'] as const;
export type AgentLogSeverity = (typeof AGENT_LOG_SEVERITIES)[number];

export const DEFAULT_ALLOWED_SEVERITIES: readonly AgentLogSeverity[] = AGENT_LOG_SEVERITIES;

export const SCRUB_RULE_ACTIONS = ['redact', 'drop'] as const;
export type ScrubRuleAction = (typeof SCRUB_RULE_ACTIONS)[number];

/** Caps applied at write time — bound the per-batch scrub work, not a defence against ReDoS. */
export const MAX_SCRUB_RULES = 20;
export const MAX_SCRUB_PATTERN_LENGTH = 200;
export const MAX_SCRUB_DESCRIPTION_LENGTH = 200;

export const scrubRuleSchema = z.object({
  /** Client-generated, so the rule list has a stable React key across edits. */
  id: z.string().min(1).max(64),
  description: z.string().max(MAX_SCRUB_DESCRIPTION_LENGTH),
  /** Regex source, case-insensitive, matched against `message` and `processInfo`. */
  pattern: z.string().min(1).max(MAX_SCRUB_PATTERN_LENGTH),
  /** redact: replace matches with '[redacted]'. drop: discard the whole row. */
  action: z.enum(SCRUB_RULE_ACTIONS),
});
export type ScrubRule = z.infer<typeof scrubRuleSchema>;

export const agentLogScrubConfigSchema = z.object({
  allowedSeverities: z.array(z.enum(AGENT_LOG_SEVERITIES)),
  rules: z.array(scrubRuleSchema).max(MAX_SCRUB_RULES),
});
export type AgentLogScrubConfigInput = z.infer<typeof agentLogScrubConfigSchema>;

export const DEFAULT_AGENT_LOG_SCRUB_CONFIG: AgentLogScrubConfigInput = {
  allowedSeverities: [...DEFAULT_ALLOWED_SEVERITIES],
  rules: [],
};

/** Compiles every rule's pattern; throws with the offending rule's id on the first failure. */
export function assertScrubRulesCompile(rules: readonly ScrubRule[]): void {
  for (const rule of rules) {
    try {
      compileScrubPattern(rule.pattern);
    } catch {
      throw new Error(`Rule "${rule.description || rule.id}" has an invalid pattern: ${rule.pattern}`);
    }
  }
}

/** Case-insensitive, matched against `message`/`processInfo`, never against step bodies. */
export function compileScrubPattern(pattern: string): RegExp {
  return new RegExp(pattern, 'giu');
}
