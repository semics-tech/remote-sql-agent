import type { Timestamp } from './gen/google/protobuf/timestamp.js';

/**
 * Date <-> protobuf Timestamp.
 *
 * ts-proto is configured with `useDate=false` so that wire types stay explicit
 * and a missing timestamp is distinguishable from the epoch — silently
 * treating an absent `run_datetime` as 1970-01-01 would put phantom rows at the
 * top of every history view.
 */

export function toTimestamp(date: Date): Timestamp {
  const ms = date.getTime();
  const seconds = Math.floor(ms / 1000);
  return { seconds, nanos: (ms - seconds * 1000) * 1e6 };
}

export function fromTimestamp(ts: Timestamp | undefined): Date | null {
  if (!ts) return null;
  return new Date(Number(ts.seconds) * 1000 + Math.round(ts.nanos / 1e6));
}

/** For fields where the caller has already established the timestamp is present. */
export function fromTimestampOrEpoch(ts: Timestamp | undefined): Date {
  return fromTimestamp(ts) ?? new Date(0);
}

export function toTimestampOrUndefined(date: Date | null | undefined): Timestamp | undefined {
  return date ? toTimestamp(date) : undefined;
}
