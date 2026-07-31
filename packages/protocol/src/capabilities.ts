/**
 * Worker capability model (§6.3).
 *
 * Three independent gates must all allow a command before it reaches msdb:
 *   1. the dashboard user's RBAC role (control plane, per request),
 *   2. the worker's server-side capability grant (control plane, per command),
 *   3. the worker's *local* ceiling from worker.yaml (on the worker itself).
 *
 * (3) is the one that survives control-plane compromise, so the worker
 * re-derives the effective set itself and never trusts the server's arithmetic.
 */

export const CAPABILITIES = [
  'observe',
  'job.toggle',
  'job.run',
  'schedule.write',
  'job.write',
  'operator.write',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** `observe` is implicit and cannot be revoked — a worker that cannot observe is useless. */
export const ALWAYS_GRANTED: readonly Capability[] = ['observe'];

/**
 * Named ceilings a site can pin in worker.yaml. Ordered by increasing power;
 * a ceiling grants everything at or below its tier.
 */
export const MAX_CAPABILITY_TIERS = {
  readOnly: ['observe'],
  operate: ['observe', 'job.toggle', 'job.run'],
  schedule: ['observe', 'job.toggle', 'job.run', 'schedule.write'],
  full: ['observe', 'job.toggle', 'job.run', 'schedule.write', 'job.write', 'operator.write'],
} as const satisfies Record<string, readonly Capability[]>;

export type MaxCapabilityTier = keyof typeof MAX_CAPABILITY_TIERS;

export const MAX_CAPABILITY_TIER_NAMES = Object.keys(MAX_CAPABILITY_TIERS) as MaxCapabilityTier[];

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

export function isMaxCapabilityTier(value: string): value is MaxCapabilityTier {
  return value in MAX_CAPABILITY_TIERS;
}

/**
 * Intersect a server-side grant with the worker's local ceiling. Unknown
 * capability strings from the server are dropped rather than passed through:
 * a newer control plane must not be able to smuggle a capability past an older
 * worker that has no idea what it means.
 */
export function effectiveCapabilities(
  serverGrant: readonly string[],
  ceiling: MaxCapabilityTier,
): Capability[] {
  const allowed = new Set<string>(MAX_CAPABILITY_TIERS[ceiling]);
  const granted = new Set<Capability>(ALWAYS_GRANTED);
  for (const cap of serverGrant) {
    if (isCapability(cap) && allowed.has(cap)) granted.add(cap);
  }
  return CAPABILITIES.filter((c) => granted.has(c));
}

/** Command type -> capability required to apply it. */
export const COMMAND_CAPABILITY = {
  toggleJob: 'job.toggle',
  runJob: 'job.run',
  stopJob: 'job.run',
  upsertJob: 'job.write',
  deleteJob: 'job.write',
  upsertSchedule: 'schedule.write',
  deleteSchedule: 'schedule.write',
  upsertOperator: 'operator.write',
  deleteOperator: 'operator.write',
  // Deliberately job.write and not a capability of its own. Adding a job to the
  // write allowlist is exactly as consequential as editing it — it is the act
  // that makes editing possible — so anyone who could do one could already do
  // the other, and a separate capability would only be a second switch to
  // forget to turn off.
  setJobWriteAllowed: 'job.write',
} as const satisfies Record<string, Capability>;

export type CommandKind = keyof typeof COMMAND_CAPABILITY;

export const COMMAND_KINDS = Object.keys(COMMAND_CAPABILITY) as CommandKind[];

export function isCommandKind(value: string): value is CommandKind {
  return value in COMMAND_CAPABILITY;
}

/** Commands requiring a second approver by default (§6.4). */
export const APPROVAL_REQUIRED_BY_DEFAULT: readonly CommandKind[] = [
  'upsertJob',
  'deleteJob',
  'upsertOperator',
  'deleteOperator',
];
