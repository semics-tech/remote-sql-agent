import type { Logger } from 'pino';
import type { WorkerMessage } from '@remote-sql-agent/protocol';
import type { OutboxRow } from './outbox.js';

const OUTBOX_DRAIN_BATCH = 50;

/** The slice of ControlPlaneSession this needs — narrowed so a test double
 * does not have to fake the whole gRPC session. */
export interface DrainTarget {
  connected: boolean;
  send(message: WorkerMessage): boolean;
}

/** The slice of Outbox this needs — narrowed for the same reason, and
 * because a real Outbox has no way to write a row that is not valid JSON,
 * which is exactly the case worth testing. */
export interface DrainSource {
  peek(limit: number): OutboxRow[];
  acknowledge(ids: number[]): void;
}

/**
 * Ship whatever is queued while the session can take it.
 *
 * A row that is not valid JSON can never succeed no matter how many times it
 * is retried — unlike a send failure, which is backpressure and worth
 * leaving queued. Parsing it inside the loop, rather than once up front,
 * used to mean one corrupted row threw out of a plain event/timer callback
 * with no catch above it anywhere: an uncaught exception there is fatal to
 * the whole process, taking down monitoring for every instance this worker
 * watches over one bad row in the queue.
 */
export function drainOutbox(outbox: DrainSource, session: DrainTarget, logger: Logger): void {
  if (!session.connected) return;
  for (;;) {
    const batch = outbox.peek(OUTBOX_DRAIN_BATCH);
    if (batch.length === 0) return;

    const sent: number[] = [];
    let stoppedEarly = false;
    for (const row of batch) {
      let message: WorkerMessage;
      try {
        message = JSON.parse(row.payload) as WorkerMessage;
      } catch (err) {
        logger.error({ err, outboxRowId: row.id }, 'Discarding an outbox row that is not valid JSON');
        sent.push(row.id);
        continue;
      }
      if (!session.send(message)) {
        stoppedEarly = true;
        break;
      }
      sent.push(row.id);
    }
    outbox.acknowledge(sent);

    // Stopped early: the stream is no longer accepting writes. Leave the rest
    // queued rather than spinning.
    if (stoppedEarly) return;
  }
}
