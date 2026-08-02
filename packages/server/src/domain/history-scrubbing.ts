import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { jobHistoryScrubConfigs } from '../db/schema.js';
import type { HistoryRow, HistoryScrubConfigInput } from '@remote-sql-agent/protocol';
import {
  DEFAULT_HISTORY_SCRUB_CONFIG,
  historyScrubConfigSchema,
  assertHistoryScrubRulesCompile,
  compileHistoryScrubPattern,
} from '@remote-sql-agent/protocol';

/**
 * Admin-controlled redaction of a job history row's `message` before it is
 * stored (`hub.ts` case `'history'`, ahead of `ingest.ts`'s `ingestHistory`).
 * Deliberately redact-only — see the comment on `jobHistoryScrubConfigs` in
 * schema.ts for why a row is never dropped here.
 */

export async function getHistoryScrubConfig(
  db: Database,
  workerId: string,
): Promise<HistoryScrubConfigInput> {
  const [row] = await db
    .select({ rules: jobHistoryScrubConfigs.rules })
    .from(jobHistoryScrubConfigs)
    .where(eq(jobHistoryScrubConfigs.workerId, workerId));

  // No row configured for this worker means unfiltered — the default is the
  // behaviour every worker had before this feature existed.
  if (!row) return DEFAULT_HISTORY_SCRUB_CONFIG;
  return { rules: row.rules };
}

export async function setHistoryScrubConfig(
  db: Database,
  workerId: string,
  input: unknown,
  updatedBy: string | null,
): Promise<HistoryScrubConfigInput> {
  const parsed = historyScrubConfigSchema.parse(input);
  // Rejects a rule whose pattern does not compile before it is ever stored.
  // Re-thrown with a statusCode so the API's error handler answers 400, not
  // 500 — this is bad input, not a server fault.
  try {
    assertHistoryScrubRulesCompile(parsed.rules);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid scrub rule';
    throw Object.assign(new Error(message), { statusCode: 400 });
  }

  await db
    .insert(jobHistoryScrubConfigs)
    .values({ workerId, rules: parsed.rules, updatedBy })
    .onConflictDoUpdate({
      target: jobHistoryScrubConfigs.workerId,
      set: { rules: parsed.rules, updatedAt: new Date(), updatedBy },
    });

  return parsed;
}

export interface HistoryScrubResult {
  rows: HistoryRow[];
  redactedCount: number;
}

const REDACTED = '[redacted]';

/**
 * Pure — no DB access. Every row that comes in goes out; only `message` can
 * change. `runStatus`, `stepId`, timing and everything else that feeds stats
 * and live-step derivation elsewhere is passed through untouched.
 */
export function applyHistoryScrubRules(
  config: HistoryScrubConfigInput,
  rows: readonly HistoryRow[],
): HistoryScrubResult {
  if (config.rules.length === 0) {
    return { rows: [...rows], redactedCount: 0 };
  }

  const compiledRules = config.rules.map((rule) => compileHistoryScrubPattern(rule.pattern));

  const outRows: HistoryRow[] = [];
  let redactedCount = 0;

  for (const row of rows) {
    let message = row.message;
    let redacted = false;

    for (const regex of compiledRules) {
      // A regex with the global flag carries match position in `lastIndex`
      // across calls; reset before each `.test()` or a later row could start
      // matching from the wrong offset.
      regex.lastIndex = 0;
      if (!regex.test(message)) continue;
      redacted = true;
      message = message.replace(regex, REDACTED);
    }

    if (redacted) redactedCount++;
    outRows.push(redacted ? { ...row, message } : row);
  }

  return { rows: outRows, redactedCount };
}
