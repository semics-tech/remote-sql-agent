import { trace, type Tracer } from '@opentelemetry/api';
import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import type { Logger } from 'pino';
import type { ServerConfig } from './config.js';

/**
 * Request and command-lifecycle tracing (vendor-neutral), the tracing
 * counterpart to `domain/audit-export.ts`'s log export — same OTLP-over-HTTP
 * shape, same "the collector is the operator's choice, not ours" reasoning.
 *
 * Deliberately narrower than a full APM integration: no auto-instrumentation.
 * `@opentelemetry/instrumentation-http` patches `node:http` by monkey-patching
 * `require`, which has to happen before anything else imports that module —
 * exactly backwards from how this file is imported (after Fastify, after
 * `node:http`, from `index.ts`'s own import graph). Doing it correctly means a
 * separate file loaded via `node --import` before the entrypoint, which is a
 * real change to how the process starts for a benefit this file does not need:
 * a plain Fastify hook gets a span per request without any of that.
 *
 * The two things this instruments — HTTP requests and worker commands — are
 * NOT linked into one trace. A command dispatched from a route handler often
 * completes seconds to minutes after that handler has already returned 200, so
 * nesting the command span under the request span would misrepresent the
 * request's duration. They are correlated in the collector the ordinary way:
 * by time and by `rsagent.command.id` / the audit log, not by trace context.
 */

const SERVICE_VERSION = '0.2.0';
const TRACER_NAME = 'rsagent.server';

let provider: NodeTracerProvider | null = null;

export function tracingEnabled(config: ServerConfig): boolean {
  return config.trace.otlpEnabled && Boolean(config.trace.otlpEndpoint);
}

/**
 * Register the global tracer provider. Idempotent no-op when tracing is
 * disabled: every call site below gets its tracer from `getTracer()`, which
 * returns the OpenTelemetry API's own no-op implementation when no provider
 * has been registered — so nothing here needs an `if (enabled)` branch.
 */
export function startTracing(config: ServerConfig, logger: Logger): void {
  if (!tracingEnabled(config)) {
    logger.info(
      'Trace export is disabled. Set RSAGENT_TRACE_OTLP_ENDPOINT to forward request and ' +
        'command spans to a collector.',
    );
    return;
  }

  const exporter = new OTLPTraceExporter({
    url: config.trace.otlpEndpoint,
    headers: config.trace.otlpHeaders,
  });

  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.trace.serviceName,
      [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
    }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
    // Below 1 lets a large estate cap trace volume without touching the
    // collector; the default of 1 (every request and command traced) is right
    // for the traffic this product actually sees — a handful of operators,
    // not a public API.
    sampler:
      config.trace.sampleRatio < 1
        ? new TraceIdRatioBasedSampler(config.trace.sampleRatio)
        : undefined,
  });
  provider.register();

  logger.info(
    { endpoint: config.trace.otlpEndpoint, sampleRatio: config.trace.sampleRatio },
    'Trace export to OpenTelemetry collector enabled',
  );
}

export async function stopTracing(): Promise<void> {
  await provider?.forceFlush().catch(() => undefined);
  await provider?.shutdown().catch(() => undefined);
  provider = null;
}

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME, SERVICE_VERSION);
}
