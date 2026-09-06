/**
 * Platform observability barrel (WORK-047 / D-06).
 */

export {
  DEFAULT_QUOTA_THRESHOLDS,
  evaluateOperationalAlerts,
  evaluateQuotaAlerts,
  hasCriticalAlert,
  loadQuotaGuardsPolicy,
  type OperationalMetricSnapshot,
  type OperationalThreshold,
  type QuotaAlertPolicy,
  type QuotaGuardRule,
  type QuotaGuardsPolicy,
  QuotaGuardsPolicyError,
} from "./alerts";
export { loadTelemetryConfig, type TelemetryConfig, TelemetryConfigError } from "./config";
export { createOtlpExporter, type OtlpExporterOptions } from "./otlp";
export * from "./port";
export * from "./redaction";
export {
  BoundedTelemetrySink,
  type BoundedTelemetrySinkOptions,
  bindSinkEnvironment,
  createInMemoryExporter,
  type InMemoryExporter,
  traceIdentityOf,
  traceIdOf,
} from "./telemetry";
