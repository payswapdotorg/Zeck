/**
 * The provider-neutral observability port (WORK-047 / D-06; D1.0 §18
 * "operational telemetry": traces, metrics and bounded structured
 * logs with stable execution/release correlation).
 *
 * AUTHORITY BOUNDARY (the OBSERVABILITY-BOUNDARY checkpoint): this
 * port is a SINK. Telemetry observes what the authorities already
 * decided; it never drives, authorizes or confirms anything. No
 * observability surface reads or writes domain state, no exporter
 * response can change Zeck state, and no dashboard/provider control
 * plane is ever consulted as a source of truth. The OTLP protocol is
 * a TRANSPORT (like HTTP or the S3-compatible object protocol): the
 * adapter (`otlp.ts`) speaks it; the port carries no vendor words.
 *
 * CORRELATION (AC4): every record carries the stable correlation
 * identity already owned by the existing planes — execution ids, the
 * D-03 dispatch correlation keys, sandbox ids, worker claim ids,
 * release ids, environment identities and request ids. The trace id
 * is DERIVED deterministically from that stable identity, so an
 * operator can reconstruct an execution end-to-end from the business
 * identifier alone — no side-channel mapping is required.
 *
 * BOUNDEDNESS (invariant 6): buffers, attribute counts, value
 * lengths, message lengths and export batches are bounded in the
 * port contract itself; the bounds are fail-closed constants (an
 * unbounded policy is unrepresentable), and overflow is DROPPED and
 * COUNTED — never buffered without limit, never allowed to slow or
 * break the observed path.
 *
 * SECRET-FREE (invariant 4): telemetry material never transports
 * secrets. Secret-shaped attribute KEYS are rejected outright;
 * credential-shaped VALUES are redacted or the record is rejected
 * (strict mode); see redaction.ts.
 */

import type { EnvironmentId } from "../deployment/naming";

// ---------------------------------------------------------------------------
// Correlation identity
// ---------------------------------------------------------------------------

/**
 * The stable correlation identity attached to every telemetry record.
 * All fields are reference-only (ids and keys) — payload material,
 * credentials and free-form business data are unrepresentable here.
 *
 * The `environment` binding is filled by the composition through
 * `bindSinkEnvironment` (the instrumented seam knows the business
 * identity; the wiring knows the deployment environment). A record
 * that reaches a sink UNBOUND is rejected fail-closed — every
 * record is attributable to an environment.
 */
export interface CorrelationIdentity {
  /** The environment the observing process represents (composition-bound). */
  readonly environment?: EnvironmentId | "ci";
  readonly tenantId?: string;
  readonly applicationId?: string;
  /** The frozen execution identity (executions authority). */
  readonly executionId?: string;
  /** The D-03 dispatch correlation key (queue transport). */
  readonly correlationKey?: string;
  /** The sandbox identity (sandbox authority). */
  readonly sandboxId?: string;
  /** The D-05 worker claim identity (compute plane). */
  readonly claimId?: string;
  /** The workflow instance identity (durable orchestration). */
  readonly workflowInstanceId?: string;
  /** The D-06 release identity (release control). */
  readonly releaseId?: string;
  /** The control-plane request identity. */
  readonly requestId?: string;
}

// ---------------------------------------------------------------------------
// Telemetry records (the neutral shapes; OTLP mapping lives in otlp.ts)
// ---------------------------------------------------------------------------

export const TELEMETRY_LEVELS = ["debug", "info", "warn", "error"] as const;
export type TelemetryLevel = (typeof TELEMETRY_LEVELS)[number];

export const TELEMETRY_SPAN_STATUSES = ["unset", "ok", "error"] as const;
export type TelemetrySpanStatus = (typeof TELEMETRY_SPAN_STATUSES)[number];

export const TELEMETRY_METRIC_KINDS = ["counter", "gauge"] as const;
export type TelemetryMetricKind = (typeof TELEMETRY_METRIC_KINDS)[number];

/** Bounded attributes: string→string only, count- and length-bounded. */
export type TelemetryAttributes = Readonly<Record<string, string>>;

export interface TelemetrySpan {
  /** W3C trace id (32 lowercase hex) — derived from the correlation identity. */
  readonly traceId: string;
  /** Span id (16 lowercase hex). */
  readonly spanId: string;
  readonly parentSpanId?: string;
  /** The dotted instrumented-operation name (bounded, no free-form text). */
  readonly name: string;
  readonly status: TelemetrySpanStatus;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly correlation: CorrelationIdentity;
  readonly attributes: TelemetryAttributes;
}

export interface TelemetryMetric {
  readonly name: string;
  readonly kind: TelemetryMetricKind;
  readonly value: number;
  readonly unit?: string;
  readonly timestamp: string;
  readonly correlation: CorrelationIdentity;
  readonly attributes: TelemetryAttributes;
}

export interface TelemetryLogRecord {
  /** The derived trace id — logs join the execution/release chain (the OTLP logRecord traceId). */
  readonly traceId: string;
  readonly level: TelemetryLevel;
  /** Bounded message (length-capped by the sink; never a payload dump). */
  readonly message: string;
  readonly timestamp: string;
  readonly correlation: CorrelationIdentity;
  readonly attributes: TelemetryAttributes;
}

// ---------------------------------------------------------------------------
// Bounds (fail-closed constants; an unbounded policy is unrepresentable)
// ---------------------------------------------------------------------------

export const TELEMETRY_BOUNDS = Object.freeze({
  /** Maximum buffered spans before dropping (and counting the drop). */
  maxBufferedSpans: 1024,
  /** Maximum buffered metrics before dropping. */
  maxBufferedMetrics: 512,
  /** Maximum buffered log records before dropping. */
  maxBufferedLogs: 1024,
  /** Maximum attributes per record. */
  maxAttributes: 32,
  /** Maximum characters per attribute value. */
  maxAttributeLength: 256,
  /** Maximum characters per log message. */
  maxMessageLength: 512,
  /** Maximum characters per span/metric name. */
  maxNameLength: 128,
  /** Maximum records per export batch. */
  maxExportBatch: 128,
  /** Maximum export retry attempts (transient classification only). */
  maxExportRetries: 2,
});

// ---------------------------------------------------------------------------
// Export classification (the exporter never throws into the observed path)
// ---------------------------------------------------------------------------

export type ExportOutcome =
  | { readonly kind: "accepted"; readonly accepted: number }
  | { readonly kind: "rejected"; readonly reason: string; readonly permanent: boolean };

export interface TelemetryExporter {
  /** Export one bounded batch. MUST NOT throw; classify instead. */
  readonly export: (batch: TelemetryBatch) => Promise<ExportOutcome>;
}

export interface TelemetryBatch {
  readonly spans: readonly TelemetrySpan[];
  readonly metrics: readonly TelemetryMetric[];
  readonly logs: readonly TelemetryLogRecord[];
}

/** The no-op exporter (observability export unconfigured: logs-only mode). */
export function createNoopExporter(): TelemetryExporter {
  return {
    export: async () => ({ kind: "accepted", accepted: 0 }),
  };
}

// ---------------------------------------------------------------------------
// The sink (what the instrumented seams consume)
// ---------------------------------------------------------------------------

/**
 * The telemetry sink consumed by the instrumented seams. Every method
 * is bounded, redaction-enforcing and NEVER throws — telemetry
 * observation must not break the request/execution path.
 */
export interface TelemetrySink {
  readonly emitSpan: (
    span: Omit<TelemetrySpan, "traceId" | "spanId"> & { readonly parentSpanId?: string },
  ) => Promise<void>;
  readonly emitMetric: (
    metric: Omit<TelemetryMetric, "timestamp"> & { readonly timestamp?: string },
  ) => Promise<void>;
  readonly emitLog: (
    log: Omit<TelemetryLogRecord, "timestamp" | "traceId"> & { readonly timestamp?: string },
  ) => Promise<void>;
  /** Bounded observability of the observability plane itself. */
  readonly stats: () => TelemetryStats;
}

export interface TelemetryStats {
  readonly spansEmitted: number;
  readonly metricsEmitted: number;
  readonly logsEmitted: number;
  readonly spansDropped: number;
  readonly metricsDropped: number;
  readonly logsDropped: number;
  readonly recordsRejected: number;
  readonly attributesRedacted: number;
  readonly exportsAccepted: number;
  readonly exportsRejected: number;
}

// ---------------------------------------------------------------------------
// Alerts (COST-QUOTA-GUARDS: observable before exhaustion, actionable)
// ---------------------------------------------------------------------------

export const ALERT_SEVERITIES = ["info", "warning", "critical"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_KINDS = [
  "quota-warning",
  "quota-critical",
  "error-rate",
  "deployment-failure",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export interface OperationalAlert {
  readonly kind: AlertKind;
  readonly severity: AlertSeverity;
  /** The subject the alert is about (concern/metric identity). */
  readonly subject: string;
  readonly detail: string;
  /** The actionable operator guidance (bounded, runbook-pointing). */
  readonly action: string;
}

/** Quota utilization snapshot of one guarded resource (authority-sourced). */
export interface QuotaUtilizationSnapshot {
  /** The guard identity (e.g. "compute-claims"). */
  readonly guard: string;
  readonly environment: string;
  /** Current utilization from the authoritative store. */
  readonly used: number;
  /** The limit (authority-declared or policy-declared). */
  readonly limit: number;
}

/** Pure alert evaluation input: snapshots + thresholds. */
export interface QuotaGuardThresholds {
  readonly warnAtPct: number;
  readonly criticalAtPct: number;
}

// ---------------------------------------------------------------------------
// Closed-vocabulary helpers (pinned by the architecture suite)
// ---------------------------------------------------------------------------

export function isTelemetryLevel(value: string): value is TelemetryLevel {
  return (TELEMETRY_LEVELS as readonly string[]).includes(value);
}

export function isAlertKind(value: string): value is AlertKind {
  return (ALERT_KINDS as readonly string[]).includes(value);
}

export function isAlertSeverity(value: string): value is AlertSeverity {
  return (ALERT_SEVERITIES as readonly string[]).includes(value);
}
