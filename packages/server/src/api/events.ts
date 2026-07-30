/**
 * Live update channel (server → browser).
 *
 * Server-sent events rather than a WebSocket: everything here flows one way,
 * SSE reconnects on its own, and it is plain HTTP so it survives corporate
 * proxies that mangle upgrade requests. A WebSocket would buy a return channel
 * this design has no use for — the browser already has a REST API.
 *
 * What travels is an *invalidation signal*, not data: "job X on instance Y
 * changed". The dashboard then refetches through the normal authenticated
 * routes. That keeps RBAC in exactly one place. Pushing rows down this stream
 * would mean re-implementing every permission check on a second path, which is
 * how an SSE endpoint quietly becomes a way to read things you should not.
 */

export type LiveEvent =
  | { type: 'activity'; instanceId: string }
  | { type: 'history'; instanceId: string }
  | { type: 'definition'; instanceId: string; jobUuid: string }
  | { type: 'command'; instanceId: string }
  | { type: 'worker' };

type Subscriber = (event: LiveEvent) => void;

/**
 * Cap on concurrent streams.
 *
 * Each is a held-open socket. Generous for a tool whose audience is a DBA team,
 * and low enough that a misbehaving client cannot exhaust the process.
 */
const MAX_SUBSCRIBERS = 200;

export class EventBroker {
  #subscribers = new Set<Subscriber>();

  get size(): number {
    return this.#subscribers.size;
  }

  /** Returns an unsubscribe function, or null when at capacity. */
  subscribe(fn: Subscriber): (() => void) | null {
    if (this.#subscribers.size >= MAX_SUBSCRIBERS) return null;
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }

  publish(event: LiveEvent): void {
    // Copied before iterating: a subscriber that throws is removed by its own
    // error handler, and mutating the set mid-iteration would skip others.
    for (const fn of [...this.#subscribers]) {
      try {
        fn(event);
      } catch {
        // A broken stream must never break ingestion. The route's own close
        // handler removes it.
      }
    }
  }
}

/** SSE framing. A comment line doubles as the keepalive. */
export function formatEvent(event: LiveEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** Proxies buffer streamed responses by default; this asks them not to. */
export const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
  // Set here because hijacking the reply skips the onSend hook that normally
  // applies them.
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
} as const;

export const SSE_KEEPALIVE_MS = 25_000;
