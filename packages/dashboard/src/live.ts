import { useEffect, useRef, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';

/**
 * Live updates over server-sent events.
 *
 * The stream carries "this changed, refetch it" rather than data, so the
 * dashboard keeps reading through the normal authenticated API and there is
 * only ever one place permissions are decided.
 *
 * Polling stays on as a fallback. If the stream drops — a proxy timeout, a
 * control-plane restart — the page keeps working, just less promptly, and
 * EventSource reconnects on its own.
 */

export type LiveEvent =
  | { type: 'activity'; instanceId: string }
  | { type: 'history'; instanceId: string }
  | { type: 'definition'; instanceId: string; jobUuid: string }
  | { type: 'command'; instanceId: string }
  | { type: 'worker' };

/**
 * Query key prefixes each event invalidates.
 *
 * Prefixes rather than exact keys: react-query matches by prefix, so
 * `['job-stats']` covers every job's stats without this file needing to know
 * which one is on screen.
 */
const AFFECTED: Record<LiveEvent['type'], string[][]> = {
  activity: [['estate'], ['overview'], ['jobs'], ['job'], ['job-stats'], ['job-groups']],
  history: [['estate'], ['overview'], ['jobs'], ['job'], ['job-stats'], ['history'], ['job-groups']],
  definition: [['job'], ['jobs'], ['versions'], ['job-groups']],
  command: [['commands'], ['job'], ['job-stats']],
  worker: [['estate'], ['overview'], ['workers'], ['pending-workers'], ['instance']],
};

/**
 * Events are coalesced before anything refetches.
 *
 * A run with ten steps produces a burst as each completes; invalidating per
 * event would fire ten rounds of requests for one visible change.
 */
const COALESCE_MS = 200;

export function useLiveEvents(): { connected: boolean } {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  // Held in a ref so the effect never re-runs and tears down the stream.
  const clientRef = useRef<QueryClient>(queryClient);
  clientRef.current = queryClient;

  useEffect(() => {
    let pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = (): void => {
      timer = null;
      const keys = [...pending].map((k) => JSON.parse(k) as string[]);
      pending = new Set();
      for (const queryKey of keys) {
        void clientRef.current.invalidateQueries({ queryKey });
      }
    };

    const source = new EventSource('/api/events', { withCredentials: true });

    source.onopen = () => setConnected(true);

    source.onmessage = (message: MessageEvent<string>) => {
      let event: LiveEvent;
      try {
        event = JSON.parse(message.data) as LiveEvent;
      } catch {
        return;
      }

      for (const key of AFFECTED[event.type] ?? []) pending.add(JSON.stringify(key));
      if (!timer) timer = setTimeout(flush, COALESCE_MS);
    };

    source.onerror = () => {
      // EventSource retries by itself; this only reflects the state so the UI
      // can say whether it is live. Closing here would defeat the reconnect.
      setConnected(false);
    };

    return () => {
      if (timer) clearTimeout(timer);
      source.close();
    };
  }, []);

  return { connected };
}
