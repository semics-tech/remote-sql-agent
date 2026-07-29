import { createHash } from 'node:crypto';
import {
  jobDefinitionSchema,
  operatorDefinitionSchema,
  alertDefinitionSchema,
  type JobDefinition,
  type OperatorDefinition,
  type AlertDefinition,
} from './job-definition.js';

/**
 * Canonical serialisation.
 *
 * Worker and control plane must derive identical bytes — and therefore
 * identical SHA-256 hashes — from the same job, or every job on the estate
 * reports as permanently drifted. The rules:
 *
 *   1. Object keys sorted lexicographically (by UTF-16 code unit, i.e. plain
 *      `Array.prototype.sort`), recursively.
 *   2. No insignificant whitespace: `JSON.stringify` with no indent.
 *   3. Arrays whose order is not semantically meaningful are sorted before
 *      serialisation (steps by stepId, schedules by name, targetServers by
 *      name). Step order *is* meaningful and is expressed by stepId, not by
 *      array position.
 *   4. Text bodies normalised: CRLF/CR -> LF, trailing whitespace stripped per
 *      line, trailing blank lines removed. SSMS, sqlcmd and sp_add_jobstep all
 *      disagree about line endings; without this every job would drift the
 *      first time anyone opened it in a different tool.
 *   5. `undefined` is never emitted — the zod schemas make every field present,
 *      nullable where optional.
 */

/** CRLF/CR -> LF, strip per-line trailing whitespace, strip trailing blank lines. */
export function normaliseText(input: string): string {
  return input
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''))
    .join('\n')
    .replace(/\n+$/u, '');
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export function sortKeysDeep(value: unknown): JsonValue {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(src).sort()) {
      const v = src[key];
      // Defensive: zod-parsed values never carry undefined, but a hand-built
      // object might, and JSON.stringify would silently drop the key — which
      // would change the hash rather than fail loudly.
      if (v === undefined) continue;
      out[key] = sortKeysDeep(v);
    }
    return out;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Non-finite number cannot be canonicalised: ${String(value)}`);
    }
    // -0 and 0 must serialise identically.
    return value === 0 ? 0 : value;
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  throw new Error(`Unsupported value in canonical serialisation: ${typeof value}`);
}

/**
 * Apply semantic normalisation to a job before key sorting: text bodies and the
 * ordering of collections whose array position carries no meaning.
 */
export function normaliseJobDefinition(job: JobDefinition): JobDefinition {
  return {
    ...job,
    description: job.description === null ? null : normaliseText(job.description),
    steps: [...job.steps]
      .sort((a, b) => a.stepId - b.stepId)
      .map((s) => ({ ...s, command: normaliseText(s.command) })),
    schedules: [...job.schedules].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    targetServers: [...job.targetServers].sort(),
  };
}

/** Validate, normalise and canonically serialise a job definition. */
export function canonicaliseJob(job: unknown): string {
  const parsed = jobDefinitionSchema.parse(job);
  return JSON.stringify(sortKeysDeep(normaliseJobDefinition(parsed)));
}

export function canonicaliseOperator(op: unknown): string {
  const parsed = operatorDefinitionSchema.parse(op);
  return JSON.stringify(sortKeysDeep(parsed));
}

export function canonicaliseAlert(alert: unknown): string {
  const parsed = alertDefinitionSchema.parse(alert);
  const normalised: AlertDefinition = {
    ...parsed,
    notificationMessage:
      parsed.notificationMessage === null ? null : normaliseText(parsed.notificationMessage),
  };
  return JSON.stringify(sortKeysDeep(normalised));
}

/**
 * Deterministic JSON for any plain value: recursively key-sorted, no
 * insignificant whitespace. Used for definition hashing and for command
 * payload hashing in signing.ts.
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/** SHA-256 hex digest of a canonical JSON string. */
export function hashCanonical(canonicalJson: string): string {
  return createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}

export interface CanonicalResult<T> {
  definition: T;
  canonicalJson: string;
  hash: string;
}

/** One-shot: validate -> normalise -> serialise -> hash. */
export function canonicaliseJobWithHash(job: unknown): CanonicalResult<JobDefinition> {
  const parsed = jobDefinitionSchema.parse(job);
  const normalised = normaliseJobDefinition(parsed);
  const canonicalJson = JSON.stringify(sortKeysDeep(normalised));
  return { definition: normalised, canonicalJson, hash: hashCanonical(canonicalJson) };
}

export function canonicaliseOperatorWithHash(op: unknown): CanonicalResult<OperatorDefinition> {
  const parsed = operatorDefinitionSchema.parse(op);
  const canonicalJson = JSON.stringify(sortKeysDeep(parsed));
  return { definition: parsed, canonicalJson, hash: hashCanonical(canonicalJson) };
}

export function canonicaliseAlertWithHash(alert: unknown): CanonicalResult<AlertDefinition> {
  const parsed = alertDefinitionSchema.parse(alert);
  const canonicalJson = canonicaliseAlert(parsed);
  return { definition: parsed, canonicalJson, hash: hashCanonical(canonicalJson) };
}

/** Parse canonical JSON back into a validated definition. */
export function parseJobDefinition(canonicalJson: string): JobDefinition {
  return jobDefinitionSchema.parse(JSON.parse(canonicalJson));
}
