/**
 * The validation recorder public barrel (VAL-004).
 *
 * The cross-application recorder: universal run records with identity,
 * linkage, trajectory events, environment state, latency and cost
 * facts; enforced deep secret redaction; append-only versioned
 * storage; canonical export and trajectory diffing. Validation
 * telemetry is EVIDENCE, never authority: nothing here feeds back into
 * Zeck's execution decisions.
 */

export {
  type ReconstructedDecision,
  reconstructTimeline,
  type TelemetryGap,
  type TelemetryGapClassification,
  TRAJECTORY_EVENT_KINDS,
  type TrajectoryEvent,
  type TrajectoryEventKind,
} from "./events";
export {
  diffTrajectory,
  exportDataset,
  exportRecord,
  type RunDatasetEntry,
  type TrajectoryDiffEntry,
  timelinesOf,
} from "./export";
export {
  type CostFact,
  type EnvironmentStateObservation,
  type LatencyFact,
  linkageFromRunMetadata,
  type RunLinkage,
  type RunRecordViolation,
  type ValidationRunRecord,
  validateRunRecord,
} from "./record";
export { ValidationRecorder } from "./recorder";
export {
  containsSecretShaped,
  findResidualSecrets,
  isSecretKeyName,
  REDACTED,
  redactDeep,
} from "./redact";
export {
  InMemoryRunRecordStore,
  JsonlRunRecordStore,
  type RunRecordStore,
} from "./store";
