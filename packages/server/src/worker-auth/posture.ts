import { and, count, gt, isNull, or } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { workerCredentials } from '../db/schema.js';
import type { WorkerCredentialMode } from '../db/schema.js';
import type { ServerConfig } from '../config.js';

/**
 * Startup review of how workers actually authenticate.
 *
 * `token` is a bearer secret: whoever reads it can be that worker until it is
 * revoked. `mtls` and `entra` both prove possession of a key that never crosses
 * the wire, and since certificates renew themselves (`renewal.ts`) mTLS no
 * longer costs an operator anything to keep running. So a real deployment still
 * on API keys is worth saying out loud, once, with the number of workers it
 * applies to.
 *
 * Deliberately not driven by `NODE_ENV`. Nothing else in this server reads it,
 * it is unset in most container images, and a security warning that silently
 * switches itself off when an environment variable is missing is the kind of
 * control CLAUDE.md is about. The question is answered instead from facts the
 * deployment has to get right anyway: TLS being required, and the public URL
 * being a real one. Both are false only where someone has explicitly configured
 * a development box, so the warning fails *on* rather than off.
 */

export interface AuthPostureFacts {
  requireTls: boolean;
  publicUrl: string;
  enabledModes: string[];
  /** Live credentials by mode: not revoked, not expired. */
  liveCredentials: Record<WorkerCredentialMode, number>;
}

export interface AuthPostureFinding {
  level: 'warn' | 'info';
  message: string;
}

/** True unless this looks like someone's laptop. */
export function looksLikeRealDeployment(facts: Pick<AuthPostureFacts, 'requireTls' | 'publicUrl'>): boolean {
  if (!facts.requireTls) return false; // RSAGENT_GRPC_REQUIRE_TLS=false is documented as dev-only.

  let host: string;
  try {
    host = new URL(facts.publicUrl).hostname.toLowerCase();
  } catch {
    // An unparseable public URL is not evidence of development.
    return true;
  }
  return !(host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]');
}

export function reviewAuthPosture(facts: AuthPostureFacts): AuthPostureFinding[] {
  if (!looksLikeRealDeployment(facts)) return [];

  const findings: AuthPostureFinding[] = [];
  const tokenWorkers = facts.liveCredentials.token ?? 0;

  if (tokenWorkers > 0) {
    findings.push({
      level: 'warn',
      message:
        `${tokenWorkers} worker credential(s) on this control plane are API keys (auth mode "token"). ` +
        'An API key is a bearer secret: anything that can read it can impersonate that worker. ' +
        'Prefer "entra" on Azure or Arc-enabled hosts, and "mtls" everywhere else — mTLS certificates ' +
        'now renew themselves, so it costs nothing to keep running. See docs/authentication.md.',
    });
  }

  // Distinct from the above, and the reason it is separate: the hub accepts any
  // mode in `enabledModes` from any worker, so an estate that has migrated every
  // worker to mTLS is still reachable with a leaked API key until `token` comes
  // off the list. Migrating the workers is the work; this is the step that banks
  // it, and it is easy to finish the first and never do the second.
  if (tokenWorkers === 0 && facts.enabledModes.includes('token')) {
    findings.push({
      level: 'info',
      message:
        'No worker uses API-key authentication, but "token" is still in RSAGENT_WORKER_AUTH_MODES. ' +
        'Removing it means a leaked or forgotten key cannot open a session at all.',
    });
  }

  return findings;
}

/** Count credentials that could actually authenticate right now. */
export async function countLiveCredentials(
  db: Database,
): Promise<Record<WorkerCredentialMode, number>> {
  const rows = await db
    .select({ mode: workerCredentials.mode, total: count() })
    .from(workerCredentials)
    .where(
      and(
        isNull(workerCredentials.revokedAt),
        or(isNull(workerCredentials.expiresAt), gt(workerCredentials.expiresAt, new Date())),
      ),
    )
    .groupBy(workerCredentials.mode);

  const out = { token: 0, mtls: 0, entra: 0 } as Record<WorkerCredentialMode, number>;
  for (const row of rows) out[row.mode] = Number(row.total);
  return out;
}

export async function gatherAuthPostureFacts(
  db: Database,
  config: ServerConfig,
): Promise<AuthPostureFacts> {
  return {
    requireTls: config.workerAuth.requireTls,
    publicUrl: config.publicUrl,
    enabledModes: config.workerAuth.enabledModes,
    liveCredentials: await countLiveCredentials(db),
  };
}
