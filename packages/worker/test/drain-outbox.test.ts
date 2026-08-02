import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { OutboxRow } from '../src/outbox.js';
import { drainOutbox, type DrainSource, type DrainTarget } from '../src/drain-outbox.js';

/**
 * A row that is not valid JSON can never succeed no matter how many times
 * it is retried. Before this, parsing it threw straight out of a plain
 * event/timer callback with nothing above to catch it — fatal to the whole
 * process, and with it every instance this worker was watching.
 */

const logger = pino({ level: 'silent' });

function row(id: number, payload: string): OutboxRow {
  return { id, kind: 'history', instanceName: 'INST1', payload, createdAt: Date.now() };
}

/** An in-memory stand-in for Outbox — real rows only ever hold valid JSON
 * (enqueue() stringifies them), so a poisoned row has to be injected directly. */
function fakeOutbox(rows: OutboxRow[]): DrainSource & { remaining: () => OutboxRow[] } {
  let queue = [...rows];
  return {
    peek: (limit) => queue.slice(0, limit),
    acknowledge: (ids) => {
      queue = queue.filter((r) => !ids.includes(r.id));
    },
    remaining: () => queue,
  };
}

function fakeSession(sendResults: boolean[] = []): DrainTarget & { sent: unknown[] } {
  const sent: unknown[] = [];
  let i = 0;
  return {
    connected: true,
    sent,
    send: (message) => {
      sent.push(message);
      const ok = sendResults[i] ?? true;
      i += 1;
      return ok;
    },
  };
}

describe('a poisoned row does not stop the drain', () => {
  it('drops an unparseable row and keeps sending the rest', () => {
    const outbox = fakeOutbox([
      row(1, JSON.stringify({ msg: { $case: 'heartbeat', heartbeat: { n: 1 } } })),
      row(2, '{not valid json'),
      row(3, JSON.stringify({ msg: { $case: 'heartbeat', heartbeat: { n: 3 } } })),
    ]);
    const session = fakeSession();

    expect(() => drainOutbox(outbox, session, logger)).not.toThrow();

    expect(session.sent).toHaveLength(2);
    expect(outbox.remaining()).toHaveLength(0);
  });

  it('leaves later rows queued when the session applies backpressure', () => {
    const outbox = fakeOutbox([
      row(1, JSON.stringify({ msg: { $case: 'heartbeat', heartbeat: { n: 1 } } })),
      row(2, JSON.stringify({ msg: { $case: 'heartbeat', heartbeat: { n: 2 } } })),
    ]);
    const session = fakeSession([false]); // first send is refused (backpressure)

    drainOutbox(outbox, session, logger);

    // send() is called for the refused row too — session.send always sees
    // the attempt — but nothing is acknowledged since none succeeded.
    expect(session.sent).toHaveLength(1);
    expect(outbox.remaining()).toHaveLength(2);
  });

  it('does nothing while disconnected', () => {
    const outbox = fakeOutbox([row(1, JSON.stringify({ msg: { $case: 'heartbeat', heartbeat: { n: 1 } } }))]);
    const session = fakeSession();
    session.connected = false;

    drainOutbox(outbox, session, logger);

    expect(session.sent).toHaveLength(0);
    expect(outbox.remaining()).toHaveLength(1);
  });
});
