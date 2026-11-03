import { afterEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { context, trace } from '@opentelemetry/api';
import type { ServerConfig } from '../src/config.js';
import { getTracer, startTracing, stopTracing, tracingEnabled } from '../src/tracing.js';

/**
 * startTracing wires the OpenTelemetry 3.x SDK into the API by hand (the SDK's
 * own `register()` is gone), so this checks the wiring itself: a real global
 * provider, and a context manager that keeps the active span across awaits.
 * No database or collector is needed; nothing is exported (the endpoint is
 * never contacted before shutdown, which swallows the flush failure).
 */
function config(trace: Partial<ServerConfig['trace']> = {}): ServerConfig {
  return {
    trace: {
      otlpEnabled: true,
      otlpEndpoint: 'http://127.0.0.1:9/v1/traces',
      otlpHeaders: {},
      serviceName: 'rsagent-test',
      sampleRatio: 1,
      ...trace,
    },
  } as ServerConfig;
}

const logger = pino({ level: 'silent' });

afterEach(async () => {
  await stopTracing();
});

describe('tracing', () => {
  it('is disabled without an endpoint', () => {
    expect(tracingEnabled(config({ otlpEndpoint: undefined }))).toBe(false);
    expect(tracingEnabled(config({ otlpEnabled: false }))).toBe(false);
    expect(tracingEnabled(config())).toBe(true);
  });

  it('leaves the API no-op when disabled', () => {
    startTracing(config({ otlpEnabled: false }), logger);
    expect(getTracer().startSpan('x').isRecording()).toBe(false);
  });

  it('records spans and keeps the active span across awaits once started', async () => {
    startTracing(config(), logger);
    const tracer = getTracer();

    await tracer.startActiveSpan('outer', async (outer) => {
      expect(outer.isRecording()).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(trace.getSpan(context.active())).toBe(outer);
      const child = tracer.startSpan('inner');
      expect(child.spanContext().traceId).toBe(outer.spanContext().traceId);
      child.end();
      outer.end();
    });
  });

  it('honours a sample ratio of 0', () => {
    startTracing(config({ sampleRatio: 0 }), logger);
    expect(getTracer().startSpan('dropped').isRecording()).toBe(false);
  });

  it('is a no-op again after stopTracing', async () => {
    startTracing(config(), logger);
    await stopTracing();
    expect(getTracer().startSpan('after').isRecording()).toBe(false);
  });
});
