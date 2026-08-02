import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { agentLogScrubConfigs } from '../db/schema.js';
import type { AgentLogRow, AgentLogScrubConfigInput } from '@remote-sql-agent/protocol';
import {
  DEFAULT_AGENT_LOG_SCRUB_CONFIG,
  agentLogScrubConfigSchema,
  assertScrubRulesCompile,
  compileScrubPattern,
} from '@remote-sql-agent/protocol';

/**
 * Admin-controlled filtering of the SQL Server Agent error log before it is
 * stored (`hub.ts` case `'agentLog'`, ahead of `ingest.ts`'s `ingestAgentLog`).
 * A row that does not pass here is never written, so it can never reach the
 * dashboard, an export, or anywhere else `agentLogEntries` is read from.
 */

export async function getScrubConfig(db: Database, workerId: string): Promise<AgentLogScrubConfigInput> {
  const [row] = await db
    .select({
      allowedSeverities: agentLogScrubConfigs.allowedSeverities,
      rules: agentLogScrubConfigs.rules,
    })
    .from(agentLogScrubConfigs)
    .where(eq(agentLogScrubConfigs.workerId, workerId));

  // No row configured for this worker means unfiltered — the default is the
  // behaviour every worker had before this feature existed.
  if (!row) return DEFAULT_AGENT_LOG_SCRUB_CONFIG;
  return { allowedSeverities: row.allowedSeverities, rules: row.rules };
}

export async function setScrubConfig(
  db: Database,
  workerId: string,
  input: unknown,
  updatedBy: string | null,
): Promise<AgentLogScrubConfigInput> {
  const parsed = agentLogScrubConfigSchema.parse(input);
  // Rejects a rule whose pattern does not compile before it is ever stored,
  // rather than discovering it the next time a batch arrives. Re-thrown with
  // a statusCode so the API's error handler answers 400, not 500 — this is
  // bad input, not a server fault.
  try {
    assertScrubRulesCompile(parsed.rules);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid scrub rule';
    throw Object.assign(new Error(message), { statusCode: 400 });
  }

  await db
    .insert(agentLogScrubConfigs)
    .values({
      workerId,
      allowedSeverities: parsed.allowedSeverities,
      rules: parsed.rules,
      updatedBy,
    })
    .onConflictDoUpdate({
      target: agentLogScrubConfigs.workerId,
      set: {
        allowedSeverities: parsed.allowedSeverities,
        rules: parsed.rules,
        updatedAt: new Date(),
        updatedBy,
      },
    });

  return parsed;
}

export interface ScrubResult {
  kept: AgentLogRow[];
  droppedCount: number;
  redactedCount: number;
}

const REDACTED = '[redacted]';

/**
 * Pure — no DB access. Severity filtering runs first (an unrecognised
 * severity string is dropped, not passed through: the point of this feature
 * is that the admin's allow-list is what decides, not an assumption about
 * what a future worker version might send). Remaining rows are checked
 * against each rule in order; `drop` short-circuits the row, `redact`
 * replaces every match in `message` and `processInfo` and keeps checking the
 * rest of the rules.
 */
export function applyScrubRules(
  config: AgentLogScrubConfigInput,
  rows: readonly AgentLogRow[],
): ScrubResult {
  const allowedSeverities = new Set<string>(config.allowedSeverities);
  const compiledRules = config.rules.map((rule) => ({
    rule,
    regex: compileScrubPattern(rule.pattern),
  }));

  const kept: AgentLogRow[] = [];
  let droppedCount = 0;
  let redactedCount = 0;

  rowLoop: for (const row of rows) {
    if (!allowedSeverities.has(row.severity)) {
      droppedCount++;
      continue;
    }

    let message = row.message;
    let processInfo = row.processInfo;
    let redacted = false;

    for (const { rule, regex } of compiledRules) {
      // A regex with the global flag carries match position in `lastIndex`
      // across calls; reset before each `.test()` or a row further along in
      // the batch could silently start matching from the wrong offset.
      regex.lastIndex = 0;
      const matchesMessage = regex.test(message);
      regex.lastIndex = 0;
      const matchesProcessInfo = regex.test(processInfo);
      if (!matchesMessage && !matchesProcessInfo) continue;

      if (rule.action === 'drop') {
        droppedCount++;
        continue rowLoop;
      }

      redacted = true;
      message = message.replace(regex, REDACTED);
      processInfo = processInfo.replace(regex, REDACTED);
    }

    if (redacted) redactedCount++;
    kept.push({ ...row, message, processInfo });
  }

  return { kept, droppedCount, redactedCount };
}
