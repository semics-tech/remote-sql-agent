import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { eq } from 'drizzle-orm';
import { generateCommandSigningKeyPair } from '@remote-sql-agent/protocol';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import {
  NodeTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { Database } from '../src/db/client.js';
import { loadConfig } from '../src/config.js';
import { CommandService } from '../src/domain/commands.js';
import { WorkerRegistry, type LiveWorker } from '../src/hub/registry.js';
import { commands, workers } from '../src/db/schema.js';
import { setupTestDatabase, seedInstance, truncateAll } from './helpers/db.js';

/**
 * One span per command, dispatch to result-or-expiry (see tracing.ts and the
 * span handling in commands.ts). A `SimpleSpanProcessor` over an in-memory
 * exporter, registered as the real global tracer provider, exercises the same
 * `getTracer()` call sites production code uses — no mocking of the tracing
 * module itself, which is the point: a mock tracer would happily agree that a
 * span was started with the right name even if the real API rejected the call.
 */

let db: Database;
let close: () => Promise<void>;
const logger = pino({ level: 'silent' });
const exporter = new InMemorySpanExporter();

const config = loadConfig({
  RSAGENT_DATABASE_URL: 'postgres://x:y@localhost:5432/z',
  RSAGENT_PUBLIC_URL: 'https://rsagent.example.com',
  RSAGENT_GRPC_REQUIRE_TLS: 'false',
} as NodeJS.ProcessEnv);

const signingKeyPem = generateCommandSigningKeyPair().privateKeyPem;

beforeAll(async () => {
  ({ db, close } = await setupTestDatabase('command_tracing'));
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
});

afterAll(async () => {
  trace.disable();
  await close();
});

beforeEach(async () => {
  await truncateAll(db);
});

afterEach(() => {
  exporter.reset();
});

function service() {
  return new CommandService(db, config, new WorkerRegistry(), signingKeyPem, logger);
}

function fakeLiveWorker(workerId: string): LiveWorker {
  return {
    workerId,
    hostName: 'SQL01',
    instanceIds: new Map(),
    send: () => undefined,
    disconnect: () => undefined,
    connectedAt: new Date(),
  };
}

async function createdCommand() {
  const { workerId, instanceId } = await seedInstance(db, 'SQL01');
  // Enough capability for `create` to get past its own gate — what's under
  // test here is span lifecycle, not the capability check.
  await db
    .update(workers)
    .set({ capabilities: ['observe', 'job.toggle'], maxCapabilityReported: 'operate' })
    .where(eq(workers.id, workerId));

  const created = await service().create({
    instanceId,
    kind: 'toggleJob',
    jobUuid: '44444444-4444-4444-8444-444444444444',
    payload: { jobUuid: '44444444-4444-4444-8444-444444444444', enabled: false },
    issuedBy: '00000000-0000-4000-8000-000000000000',
    issuedByUsername: 'dba',
    issuedByRole: 'Admin',
  });
  return { commandId: created.id, workerId, instanceId };
}

async function dispatchedCommand() {
  const { commandId, workerId, instanceId } = await createdCommand();
  const registry = new WorkerRegistry();
  registry.register(fakeLiveWorker(workerId));
  const svc = new CommandService(db, config, registry, signingKeyPem, logger);
  const dispatched = await svc.dispatch(commandId);
  expect(dispatched).toBe(true);
  return { commandId, workerId, instanceId, svc };
}

function findSpan(name: string): ReadableSpan | undefined {
  return exporter.getFinishedSpans().find((s) => s.name === name);
}

describe('command spans', () => {
  it('starts a span when a command is actually sent to a worker, with its identifying attributes', async () => {
    const { commandId, workerId, svc } = await dispatchedCommand();

    // Not yet finished — recordResult hasn't run — so the span isn't in the
    // exporter yet. Drive it to completion, on the same service instance
    // dispatch() ran on (the span lives in its in-memory map — see the
    // comment on #commandSpans), to assert both that it started and what was
    // recorded on it at dispatch time.
    await svc.recordResult({
      commandId,
      workerId,
      success: true,
      errorCode: '',
      errorDetail: '',
      sqlErrorNumber: 0,
      hostName: 'SQL01',
    });

    const span = findSpan('command toggleJob');
    expect(span).toBeDefined();
    expect(span!.attributes['rsagent.command.id']).toBe(commandId);
    expect(span!.attributes['rsagent.command.type']).toBe('toggleJob');
    expect(span!.attributes['rsagent.instance.name']).toBe('MSSQLSERVER');
    expect(span!.attributes['rsagent.worker.id']).toBe(workerId);
  });

  it('does not start a span for a command left queued because the worker is offline', async () => {
    const { commandId } = await createdCommand();

    const dispatched = await service().dispatch(commandId);
    expect(dispatched).toBe(false);

    expect(findSpan('command toggleJob')).toBeUndefined();
  });

  it('ends the span OK on a successful result', async () => {
    const { commandId, workerId, svc } = await dispatchedCommand();

    await svc.recordResult({
      commandId,
      workerId,
      success: true,
      errorCode: '',
      errorDetail: '',
      sqlErrorNumber: 0,
      hostName: 'SQL01',
    });

    const span = findSpan('command toggleJob');
    expect(span!.status.code).toBe(SpanStatusCode.OK);
  });

  it('ends the span as an error on a failed result, with the error code attached', async () => {
    const { commandId, workerId, svc } = await dispatchedCommand();

    await svc.recordResult({
      commandId,
      workerId,
      success: false,
      errorCode: 'SqlError',
      errorDetail: 'Login failed',
      sqlErrorNumber: 18456,
      hostName: 'SQL01',
    });

    const span = findSpan('command toggleJob');
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.attributes['rsagent.command.error_code']).toBe('SqlError');
  });

  it('ends a dispatched command left with no reply once it expires', async () => {
    const { commandId, svc } = await dispatchedCommand();

    // expireStale() only picks up rows already past their TTL; backdate this
    // one directly rather than waiting out the real commandTtlSeconds.
    await db
      .update(commands)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(commands.id, commandId));

    await svc.expireStale();

    const span = findSpan('command toggleJob');
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.status.message).toBe('Expired');
  });

  it('ignores a result for a command no span was ever opened for', async () => {
    // recordResult on an unknown command id returns null before touching any
    // span bookkeeping — asserting this doesn't throw is the test.
    const outcome = await service().recordResult({
      commandId: '55555555-5555-4555-8555-555555555555',
      workerId: '66666666-6666-4666-8666-666666666666',
      success: true,
      errorCode: '',
      errorDetail: '',
      sqlErrorNumber: 0,
      hostName: 'SQL01',
    });
    expect(outcome).toBeNull();
  });
});
