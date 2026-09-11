/**
 * Platform observability barrel (WORK-047 / D-06).
 */

export {
  type AvailabilityTargetRecord,
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
export {
  AVAILABILITY_OUTCOMES,
  AvailabilityComputationError,
  type AvailabilityInterval,
  type AvailabilityOutcome,
  type AvailabilityRevisionIdentity,
  type AvailabilityWindowInput,
  type AvailabilityWindowRecord,
  availabilityAlertOf,
  availabilityOutcomeOfReadiness,
  computeAvailabilityWindow,
  isCriticalAvailabilityAlert,
  MAX_AVAILABILITY_INTERVALS,
  PRODUCTION_AVAILABILITY_TARGET_FLOOR_PCT,
} from "./availability";
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
