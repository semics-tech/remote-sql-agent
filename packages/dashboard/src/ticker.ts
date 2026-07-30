import { useEffect, useState } from 'react';

/**
 * A one-second clock, running only while something on screen depends on it.
 *
 * Durations of runs in flight are drawn against "now", so without this they
 * would advance in jumps whenever a poll or a live event happened to land — a
 * timer that freezes for five seconds and then leaps reads as a broken page,
 * even though the underlying data was never wrong.
 *
 * Gated on `active` rather than left running: an estate with nothing executing
 * should not re-render every second forever.
 */
export function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return undefined;
    // Immediately, so switching to active does not wait a second for the first
    // reading — which would otherwise show a duration one tick stale.
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  return now;
}

/**
 * Elapsed time as of now, from a figure the server measured when it replied.
 *
 * Deliberately *not* computed from the run's start time against the browser
 * clock. That start time comes from SQL Server, by way of the worker and the
 * control plane, and any disagreement between those clocks and this one shows
 * up directly as a wrong duration — a laptop a few minutes fast would report
 * every run as having been going for minutes before it began.
 *
 * Measuring forward from the moment the response arrived removes all of that:
 * the only clock involved in the delta is the local one, measuring against
 * itself.
 */
export function liveElapsedSeconds(
  serverElapsedSeconds: number | null,
  fetchedAtMs: number,
  nowMs: number,
): number | null {
  if (serverElapsedSeconds === null) return null;
  // Clamped at zero: a cached response can be newer than `now` by a millisecond
  // or two, and a timer must never run backwards.
  const sinceFetch = Math.max(0, Math.floor((nowMs - fetchedAtMs) / 1000));
  return serverElapsedSeconds + sinceFetch;
}
