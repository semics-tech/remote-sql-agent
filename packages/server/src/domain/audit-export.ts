import { asc, eq, inArray, lte } from 'drizzle-orm';
import { logs, SeverityNumber, type Logger as OtelLogger } from '@opentelemetry/api-logs';
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import type { Logger } from 'pino';
import type { Database } from '../db/client.js';
import { auditExportQueue, auditLog } from '../db/schema.js';
import type { ServerConfig } from '../config.js';

/**
 * Audit export (vendor-neutral).
 *
 * The database is the source of truth and is written synchronously with the
 * action being audited. Export is a separate, queued, at-least-once delivery to
 * an OpenTelemetry collector — so a SIEM outage degrades to "the SIEM is
 * behind", never to "the request failed" or "the event is gone".
 *
 * OTLP rather than a vendor SDK: every common destination (Azure Monitor,
 * Splunk, Datadog, Elastic, Loki, Chronicle) either ingests OTLP directly or
 * sits behind a collector that does, so the choice of backend stays the
 * operator's rather than ours.
 */

const SERVICE_VERSION = '0.1.0';

/** Actions that represent a security-relevant failure rather than normal use. */
const WARNING_ACTIONS = new Set([
  'auth.login.failed',
  'worker.auth.failed',
  'command.rejected',
  'command.result.failed',
]);

export class AuditExporter {
  #provider: LoggerProvider | null = null;
  #otel: OtelLogger | null = null;
  #timer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(
    private readonly db: Database,
    private readonly config: ServerConfig,
    private readonly logger: Logger,
  ) {}

  get enabled(): boolean {
    return this.config.audit.otlpEnabled && Boolean(this.config.audit.otlpEndpoint);
  }

  start(): void {
    if (!this.enabled) {
      this.logger.info(
        'Audit export is disabled; the audit trail is retained in the database only. ' +
          'Set RSAGENT_AUDIT_OTLP_ENDPOINT to forward it to a collector.',
      );
      return;
    }

    const exporter = new OTLPLogExporter({
      url: this.config.audit.otlpEndpoint,
      headers: this.config.audit.otlpHeaders,
    });

    this.#provider = new LoggerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: this.config.audit.serviceName,
        [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
      }),
      processors: [new BatchLogRecordProcessor({ exporter })],
    });

    logs.setGlobalLoggerProvider(this.#provider);
    this.#otel = this.#provider.getLogger('rsagent.audit', SERVICE_VERSION);

    this.#timer = setInterval(() => {
      void this.drain();
    }, this.config.audit.exportIntervalMs);
    this.#timer.unref();

    this.logger.info(
      { endpoint: this.config.audit.otlpEndpoint },
      'Audit export to OpenTelemetry collector enabled',
    );
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    // Flush rather than drop: shutdown is exactly when the last few audit
    // events matter most.
    await this.#provider?.forceFlush().catch(() => undefined);
    await this.#provider?.shutdown().catch(() => undefined);
  }

  /**
   * Deliver queued events. At-least-once: a row is removed only after the
   * record has been handed to the batch processor, and a failure leaves it
   * queued with a backoff.
   */
  async drain(): Promise<number> {
    if (!this.enabled || !this.#otel || this.#running) return 0;
    this.#running = true;

    try {
      const pending = await this.db
        .select({
          queueId: auditExportQueue.id,
          attempts: auditExportQueue.attempts,
          id: auditLog.id,
          at: auditLog.at,
          actorType: auditLog.actorType,
          actor: auditLog.actor,
          action: auditLog.action,
          target: auditLog.target,
          detail: auditLog.detail,
          remoteAddress: auditLog.remoteAddress,
        })
        .from(auditExportQueue)
        .innerJoin(auditLog, eq(auditLog.id, auditExportQueue.auditLogId))
        .where(lte(auditExportQueue.nextAttemptAt, new Date()))
        .orderBy(asc(auditExportQueue.createdAt))
        .limit(this.config.audit.exportBatchSize);

      if (pending.length === 0) return 0;

      const delivered: string[] = [];
      const failed: Array<{ queueId: string; attempts: number; error: string }> = [];

      for (const row of pending) {
        try {
          this.#otel.emit({
            timestamp: row.at,
            severityNumber: WARNING_ACTIONS.has(row.action)
              ? SeverityNumber.WARN
              : SeverityNumber.INFO,
            severityText: WARNING_ACTIONS.has(row.action) ? 'WARN' : 'INFO',
            body: `${row.actor} ${row.action}${row.target ? ` ${row.target}` : ''}`,
            attributes: {
              'event.name': row.action,
              'event.domain': 'rsagent.audit',
              'rsagent.audit.id': row.id,
              'rsagent.actor': row.actor,
              'rsagent.actor_type': row.actorType,
              'rsagent.target': row.target ?? '',
              'client.address': row.remoteAddress ?? '',
              // Detail is arbitrary per action; serialise rather than flatten so
              // no field name can collide with a semantic-convention attribute.
              'rsagent.detail': row.detail ? JSON.stringify(row.detail) : '',
            },
          });
          delivered.push(row.queueId);
        } catch (err) {
          failed.push({
            queueId: row.queueId,
            attempts: row.attempts + 1,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (delivered.length > 0) {
        await this.db.delete(auditExportQueue).where(inArray(auditExportQueue.id, delivered));
      }

      for (const failure of failed) {
        if (failure.attempts >= this.config.audit.maxAttempts) {
          // Give up on the export, never on the record: the row stays in
          // audit_log, and dropping it from the queue is logged loudly so the
          // gap in the SIEM is discoverable.
          this.logger.error(
            { queueId: failure.queueId, error: failure.error, attempts: failure.attempts },
            'Audit event exceeded its export retry budget and was dropped from the export queue. ' +
              'It remains in the database; the external sink is missing it.',
          );
          await this.db.delete(auditExportQueue).where(eq(auditExportQueue.id, failure.queueId));
          continue;
        }

        const backoffMs = Math.min(2 ** failure.attempts * 1000, 5 * 60 * 1000);
        await this.db
          .update(auditExportQueue)
          .set({
            attempts: failure.attempts,
            lastError: failure.error.slice(0, 1000),
            nextAttemptAt: new Date(Date.now() + backoffMs),
          })
          .where(eq(auditExportQueue.id, failure.queueId));
      }

      return delivered.length;
    } catch (err) {
      this.logger.error({ err }, 'Audit export drain failed');
      return 0;
    } finally {
      this.#running = false;
    }
  }
}
