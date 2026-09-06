/**
 * The bounded telemetry sink (WORK-047 / D-06).
 *
 * IMPLEMENTATION INVARIANTS:
 *
 * - NEVER THROWS: every emission path is wrapped; a telemetry failure
 *   is counted, never propagated into the observed request/execution
 *   path (telemetry is observation, not authority).
 *
 * - DETERMINISTIC TRACE IDENTITY: the W3C trace id is derived from
 *   the STABLE correlation identity (sha256 over the primary
 *   business identifier), in a fixed priority order — executionId →
 *   workflowInstanceId → releaseId → correlationKey → sandboxId →
 *   requestId → environment. An operator reconstructs an execution
 *   end-to-end from the execution id alone; no side-channel mapping
 *   exists or is needed. Span ids are random (they are not join
 *   keys).
 *
 * - BOUNDED: buffers, attribute counts, value lengths, names and
 *   messages are capped by the port constants; overflow is dropped
 *   and counted (drop counters are observable via stats()).
 *
 * - SECRET-FREE AT ADMISSION: records are redaction-classified BEFORE
 *   buffering; rejected records never enter any buffer and never
 *   reach an exporter.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  type CorrelationIdentity,
  type ExportOutcome,
  isTelemetryLevel,
  TELEMETRY_BOUNDS,
  type TelemetryBatch,
  type TelemetryExporter,
  type TelemetryLogRecord,
  type TelemetryMetric,
  type TelemetrySink,
  type TelemetrySpan,
  type TelemetryStats,
} from "./port";
import { redactTelemetryAttributes, redactTelemetryMessage } from "./redaction";

const TRACE_IDENTITY_PREFIX = "zeck-telemetry-trace-v1";

/** The stable identity a trace id is derived from (fixed priority order). */
export function traceIdentityOf(correlation: CorrelationIdentity): string {
  const primary =
    correlation.executionId ??
    correlation.workflowInstanceId ??
    correlation.releaseId ??
    correlation.correlationKey ??
    correlation.sandboxId ??
    correlation.requestId ??
    `environment:${correlation.environment}`;
  return `${TRACE_IDENTITY_PREFIX}:${primary}`;
}

/** The deterministic W3C trace id (32 lowercase hex) for a correlation identity. */
export function traceIdOf(correlation: CorrelationIdentity): string {
  return createHash("sha256")
    .update(traceIdentityOf(correlation), "utf8")
    .digest("hex")
    .slice(0, 32);
}

function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

export interface BoundedTelemetrySinkOptions {
  readonly exporter: TelemetryExporter;
  /** The clock (ISO timestamps); default: real time. */
  readonly now?: () => Date;
  /** Span-id generator (tests pin determinism); default: crypto random. */
  readonly generateSpanId?: () => string;
}

interface MutableStats {
  spansEmitted: number;
  metricsEmitted: number;
  logsEmitted: number;
  spansDropped: number;
  metricsDropped: number;
  logsDropped: number;
  recordsRejected: number;
  attributesRedacted: number;
  exportsAccepted: number;
  exportsRejected: number;
}

/** The concrete bounded sink (the port shape + flush for the host loop). */
export class BoundedTelemetrySink implements TelemetrySink {
  private readonly exporter: TelemetryExporter;
  private readonly now: () => Date;
  private readonly generateSpanId: () => string;
  private readonly spans: TelemetrySpan[] = [];
  private readonly metrics: TelemetryMetric[] = [];
  private readonly logs: TelemetryLogRecord[] = [];
  private readonly statsState: MutableStats = {
    spansEmitted: 0,
    metricsEmitted: 0,
    logsEmitted: 0,
    spansDropped: 0,
    metricsDropped: 0,
    logsDropped: 0,
    recordsRejected: 0,
    attributesRedacted: 0,
    exportsAccepted: 0,
    exportsRejected: 0,
  };

  constructor(options: BoundedTelemetrySinkOptions) {
    this.exporter = options.exporter;
    this.now = options.now ?? (() => new Date());
    this.generateSpanId = options.generateSpanId ?? newSpanId;
  }

  async emitSpan(
    span: Omit<TelemetrySpan, "traceId" | "spanId"> & { readonly parentSpanId?: string },
  ): Promise<void> {
    try {
      if (
        span.name.length === 0 ||
        span.name.length > TELEMETRY_BOUNDS.maxNameLength ||
        span.startedAt === undefined ||
        span.endedAt === undefined
      ) {
        this.statsState.recordsRejected += 1;
        return;
      }
      if (span.correlation.environment === undefined) {
        this.statsState.recordsRejected += 1;
        return;
      }
      const classified = redactTelemetryAttributes(span.attributes);
      if (!classified.admissible) {
        this.statsState.recordsRejected += 1;
        return;
      }
      this.statsState.attributesRedacted += classified.redactions;
      if (this.spans.length >= TELEMETRY_BOUNDS.maxBufferedSpans) {
        this.statsState.spansDropped += 1;
        return;
      }
      this.spans.push({
        traceId: traceIdOf(span.correlation),
        spanId: this.generateSpanId(),
        parentSpanId: span.parentSpanId,
        name: span.name,
        status: span.status,
        startedAt: span.startedAt,
        endedAt: span.endedAt,
        correlation: span.correlation,
        attributes: classified.attributes,
      });
      this.statsState.spansEmitted += 1;
    } catch {
      this.statsState.recordsRejected += 1;
    }
  }

  async emitMetric(
    metric: Omit<TelemetryMetric, "timestamp"> & { readonly timestamp?: string },
  ): Promise<void> {
    try {
      if (
        metric.name.length === 0 ||
        metric.name.length > TELEMETRY_BOUNDS.maxNameLength ||
        !Number.isFinite(metric.value)
      ) {
        this.statsState.recordsRejected += 1;
        return;
      }
      if (metric.correlation.environment === undefined) {
        this.statsState.recordsRejected += 1;
        return;
      }
      const classified = redactTelemetryAttributes(metric.attributes);
      if (!classified.admissible) {
        this.statsState.recordsRejected += 1;
        return;
      }
      this.statsState.attributesRedacted += classified.redactions;
      if (this.metrics.length >= TELEMETRY_BOUNDS.maxBufferedMetrics) {
        this.statsState.metricsDropped += 1;
        return;
      }
      this.metrics.push({
        name: metric.name,
        kind: metric.kind,
        value: metric.value,
        unit: metric.unit?.slice(0, 32),
        timestamp: metric.timestamp ?? this.now().toISOString(),
        correlation: metric.correlation,
        attributes: classified.attributes,
      });
      this.metricsEmittedCounter();
    } catch {
      this.statsState.recordsRejected += 1;
    }
  }

  async emitLog(
    log: Omit<TelemetryLogRecord, "timestamp" | "traceId"> & { readonly timestamp?: string },
  ): Promise<void> {
    try {
      if (!isTelemetryLevel(log.level)) {
        this.statsState.recordsRejected += 1;
        return;
      }
      if (log.correlation.environment === undefined) {
        this.statsState.recordsRejected += 1;
        return;
      }
      const classified = redactTelemetryAttributes(log.attributes);
      if (!classified.admissible) {
        this.statsState.recordsRejected += 1;
        return;
      }
      this.statsState.attributesRedacted += classified.redactions;
      if (this.logs.length >= TELEMETRY_BOUNDS.maxBufferedLogs) {
        this.statsState.logsDropped += 1;
        return;
      }
      this.logs.push({
        traceId: traceIdOf(log.correlation),
        level: log.level,
        message: redactTelemetryMessage(log.message),
        timestamp: log.timestamp ?? this.now().toISOString(),
        correlation: log.correlation,
        attributes: classified.attributes,
      });
      this.statsState.logsEmitted += 1;
    } catch {
      this.statsState.recordsRejected += 1;
    }
  }

  stats(): TelemetryStats {
    return { ...this.statsState };
  }

  /** Buffered records awaiting export (bounded; inspection/testing). */
  buffered(): TelemetryBatch {
    return { spans: [...this.spans], metrics: [...this.metrics], logs: [...this.logs] };
  }

  /**
   * Export the buffered records in bounded batches. Never throws:
   * export outcomes are classified (accepted/rejected, transient
   * retries bounded) and counted.
   */
  async flush(): Promise<ExportOutcome[]> {
    const outcomes: ExportOutcome[] = [];
    while (this.spans.length + this.metrics.length + this.logs.length > 0) {
      const batch: TelemetryBatch = {
        spans: this.spans.splice(0, TELEMETRY_BOUNDS.maxExportBatch),
        metrics: this.metrics.splice(0, TELEMETRY_BOUNDS.maxExportBatch),
        logs: this.logs.splice(0, TELEMETRY_BOUNDS.maxExportBatch),
      };
      const total = batch.spans.length + batch.metrics.length + batch.logs.length;
      let outcome = await this.invokeExporter(batch);
      let attempts = 0;
      while (
        outcome.kind === "rejected" &&
        !outcome.permanent &&
        attempts < TELEMETRY_BOUNDS.maxExportRetries
      ) {
        attempts += 1;
        outcome = await this.invokeExporter(batch);
      }
      if (outcome.kind === "accepted") {
        this.statsState.exportsAccepted += total;
      } else {
        this.statsState.exportsRejected += total;
      }
      outcomes.push(outcome);
    }
    return outcomes;
  }

  private async invokeExporter(batch: TelemetryBatch): Promise<ExportOutcome> {
    try {
      return await this.exporter.export(batch);
    } catch (error) {
      return {
        kind: "rejected",
        reason: `exporter threw: ${(error as Error).message.slice(0, 120)}`,
        permanent: false,
      };
    }
  }

  private metricsEmittedCounter(): void {
    this.statsState.metricsEmitted += 1;
  }
}

// ---------------------------------------------------------------------------
// Test/in-process utilities (shared by the integration suites)
// ---------------------------------------------------------------------------

/**
 * Bind a sink to one deployment environment: every emission whose
 * correlation has no environment gets the bound one (the instrumented
 * seam supplies the business identity; the wiring supplies the
 * environment). Records are still rejected if they arrive already
 * bound to a DIFFERENT environment (cross-environment attribution is

 * unrepresentable).
 */
export function bindSinkEnvironment(
  sink: TelemetrySink,
  environment: NonNullable<CorrelationIdentity["environment"]>,
): TelemetrySink {
  const bind = <T extends { readonly correlation: CorrelationIdentity }>(record: T): T => {
    if (record.correlation.environment === undefined) {
      return { ...record, correlation: { ...record.correlation, environment } };
    }
    return record;
  };
  return {
    emitSpan: async (span) => sink.emitSpan(bind(span)),
    emitMetric: async (metric) => sink.emitMetric(bind(metric)),
    emitLog: async (log) => sink.emitLog(bind(log)),
    stats: () => sink.stats(),
  };
}

export interface InMemoryExporter {
  readonly exporter: TelemetryExporter;
  /** Every batch handed to the exporter (bounded by the caller's flushes). */
  readonly batches: readonly TelemetryBatch[];
  /** The last HTTP-classified outcome to simulate (tests). */
  failWith?: { readonly kind: "rejected"; readonly reason: string; readonly permanent: boolean };
}

/** A collecting exporter for tests and local logs-only flows. */
export function createInMemoryExporter(): InMemoryExporter {
  const batches: TelemetryBatch[] = [];
  const handle: InMemoryExporter = {
    batches,
    failWith: undefined,
    exporter: {
      export: async (batch: TelemetryBatch): Promise<ExportOutcome> => {
        if (handle.failWith !== undefined) {
          return handle.failWith;
        }
        batches.push(batch);
        return {
          kind: "accepted",
          accepted: batch.spans.length + batch.metrics.length + batch.logs.length,
        };
      },
    },
  };
  return handle;
}
