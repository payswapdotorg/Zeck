/**
 * Public contract barrel of the `compatibility` integration (PPR-017 /
 * ACR-006 — the Application Execution Compatibility layer).
 *
 * This file is the ONLY supported import surface of the compatibility
 * layer for other modules, the API layer, the SDK surfaces and the
 * website (apps/dashboard). Everything else under
 * `src/integrations/compatibility/` is private to this integration
 * (the public-module rule of `spec/contracts.md`, applied to the
 * integration zone by the dependency engine).
 *
 * WHAT THIS LAYER IS (ACR-006): the NON-AUTHORITATIVE
 * compatibility/evidence layer external applications are audited
 * against — the application execution graph + execution-surface
 * taxonomy (additive to the 22-family capability manifest), the
 * compatibility evidence record, the strict five-rule
 * AI_EXECUTION_COMPLETE admission machine, static no-bypass
 * reconciliation, the proof-environment egress observation/deny
 * harness, Zeck trace correlation THROUGH the executions public
 * surface, and the Demo Mirror registry binding.
 *
 * WHAT IT IS NOT: it executes no work, chooses no providers, owns no
 * budgets, verifies no customer-domain outcomes and is no second
 * optimizer (ACR-006 Non-goals). It never weakens the 22-family
 * capability manifest, never alters the frozen execution lifecycle,
 * and never carries a status that was not DERIVED from evidence by
 * `evaluateCompatibility`.
 *
 * ZONE NOTE (PPR-017 design decision, recorded in the delivery report):
 * the layer lives in the integration zone (like workflowos/edge), not
 * `src/modules/` — the frozen architecture module table
 * (spec/architecture.md §6) is pinned by uneditable tests, and the
 * integration zone is the sanctioned home for non-authoritative layers
 * that delegate to the existing authorities. The dependency engine
 * enforces the identical module conventions here (public barrel only,
 * layer direction, internal-never-crosses).
 *
 * SIBLING CONSUMERS (PPR-018 Aider / PPR-019 Cline): declare your
 * pinned application's execution graph with `validateExecutionGraph`
 * types, record your proof in a `CompatibilityEvidenceRecord`, wrap
 * your proof runtime in `createEgressDenyHarness`, correlate through
 * `createCompatibilityService({ traceSource })` (bind
 * `createExecutionsServiceTraceSource` in-process, or implement
 * `ZeckTraceSource` over the SDK wire reads), assess with
 * `service.assess(record, inventory)`, and register your demo by
 * binding a `DemoMirrorEntry` to your record id — the status can never
 * be asserted, only derived.
 */

export const integrationId = "compatibility" as const;

export type CompatibilityIntegrationId = typeof integrationId;

export {
  defaultDemoEntries,
  defaultDemoRegistry,
  EXAMPLE_CODING_ASSISTANT_RECORD,
  EXAMPLE_RAG_KNOWLEDGE_APP_RECORD,
  FIXTURE_EVIDENCE_RECORDS,
  fixtureRecordOf,
} from "./adapters/demo-fixtures";
export type {
  DemoRecordSourceIssue,
  FileDemoRecordSource,
  FileDemoRecordSourceOptions,
  SourcedEvidenceRecord,
} from "./adapters/demo-record-source";
export { createFileDemoRecordSource } from "./adapters/demo-record-source";
export type {
  EgressAllowlistHarnessOptions,
  EgressAllowRule,
} from "./adapters/egress-allowlist-harness";
export {
  createEgressAllowlistHarness,
  EGRESS_DEFAULT_DENY_NOTE,
} from "./adapters/egress-allowlist-harness";
export type {
  EgressDenyHarnessOptions,
  OutboundTransport,
} from "./adapters/egress-deny-harness";
export {
  createEgressDenyHarness,
  hostMatchesPattern,
} from "./adapters/egress-deny-harness";
export type { ExecutionsTraceSourceOptions } from "./adapters/executions-trace-source";
// Adapters: the concrete seams (executions public service, egress
// harness, file store, and the PPR-017 fixture demos).
export { createExecutionsServiceTraceSource } from "./adapters/executions-trace-source";
export type { FileEvidenceStoreOptions } from "./adapters/file-evidence-store";
export {
  createFileCompatibilityEvidenceStore,
  InvalidEvidenceRecordFileError,
} from "./adapters/file-evidence-store";
export type {
  CompatibilityService,
  CompatibilityServiceOptions,
} from "./application/compatibility-service";
// Application: the proof orchestration + the demo registry binding.
export {
  CompatibilityFlowError,
  createCompatibilityService,
} from "./application/compatibility-service";
export type {
  DemoMirrorEntry,
  DemoMirrorProjection,
  DemoMirrorRegistry,
  DemoMirrorResolution,
  DemoRegistryIssue,
} from "./application/demo-registry";
export {
  resolveDemoMirrorEntry,
  validateDemoRegistry,
} from "./application/demo-registry";
export type {
  DemoRunEntry,
  DemoRunService,
  DemoRunServiceOptions,
} from "./application/demo-run-service";
export { createDemoRunService } from "./application/demo-run-service";
export type {
  PinnedRuntimeRegistry,
  PinnedRuntimeRegistryOptions,
  RegisteredRuntimeDescriptor,
} from "./application/runtime-registry";
export { createRuntimeRegistry } from "./application/runtime-registry";
export type {
  BaselineIssue,
  BaselineKind,
  BaselineRunRecord,
  BaselineTaskRun,
} from "./domain/baselines";
// Domain: baseline capture + labeling (baselines are never Zeck evidence).
export {
  assertNotZeckEvidence,
  BASELINE_KINDS,
  baselineComparisonFact,
  isBaselineKind,
  validateBaselineRun,
} from "./domain/baselines";
export type {
  CredentialErasureResult,
  CredentialPresenceSource,
} from "./domain/credential-erasure";
// Domain: provider-credential erasure (ACR-007 §5).
export {
  checkProviderCredentialErasure,
  scrubbedEnvironmentOf,
} from "./domain/credential-erasure";
export type {
  ComparisonFact,
  CompatibilityEvidenceRecord,
  DelegatedEdgeDisposition,
  DelegatedEdgeEvidence,
  DirectProviderEdgeDisposition,
  DirectProviderEdgeEvidence,
  EdgeDisposition,
  EdgeDispositionEntry,
  EdgeDispositionKind,
  EgressObservation,
  EgressViolation,
  EvidenceBasis,
  EvidenceRecordIssue,
  LimitationEntry,
  NonAiEdgeDisposition,
  NonAiEdgeEvidence,
  NotRunCause,
  NotRunEdgeDisposition,
  NotRunEdgeEvidence,
  ProviderCredentialFact,
  RuntimeEvidence,
  ZeckTraceFact,
} from "./domain/evidence";
// Domain: the compatibility evidence record.
export {
  dispositionOf,
  EVIDENCE_BASES,
  validateCompatibilityEvidenceRecord,
} from "./domain/evidence";
export type {
  ApplicationExecutionGraph,
  DiscoveredEdgeInventory,
  ExecutionGraphEdge,
  GraphValidationIssue,
} from "./domain/execution-graph";
// Domain: the application execution graph + discovered inventories.
export {
  edgeById,
  validateDiscoveredInventory,
  validateExecutionGraph,
  validateExecutionGraphEdge,
} from "./domain/execution-graph";
export type { ExecutionSurface } from "./domain/execution-surfaces";
// Domain: the execution-surface taxonomy (additive; ACR-006 §1).
export {
  EXECUTION_SURFACE_LABELS,
  EXECUTION_SURFACE_TAXONOMY_NOTE,
  EXECUTION_SURFACES,
  isExecutionSurface,
} from "./domain/execution-surfaces";
export type {
  CapabilityDiscoveryMeasurement,
  CustomizationCoverageMeasurement,
  DeterminismReuseMeasurement,
  DiagnosisRecoveryMeasurement,
  EngineeringSurfaceMeasurement,
  FailureRetryMeasurement,
  LatencyTailMeasurement,
  MeasurementBasis,
  MeasurementDimension,
  MeasurementEntry,
  MeasurementIssue,
  MeasurementSet,
  OutcomeSuccessMeasurement,
  ProviderPortabilityMeasurement,
  QualityVerificationMeasurement,
  ReproducibilityMeasurement,
  TelemetryExplainabilityMeasurement,
  UsageCostMeasurement,
} from "./domain/measurements";
// Domain: the reusable thirteen-dimension measurement schema.
export {
  isMeasurementBasis,
  isMeasurementDimension,
  latencyTailOf,
  MEASUREMENT_BASES,
  MEASUREMENT_DIMENSIONS,
  medianOf,
  notMeasuredDimensions,
  percentileOf,
  validateMeasurementEntry,
  validateMeasurementSet,
} from "./domain/measurements";
export type {
  StaticFindingKind,
  StaticNoBypassFinding,
} from "./domain/no-bypass";
// Domain: static no-bypass reconciliation.
export {
  hasHardCoverageDefect,
  reconcileExecutionGraph,
  STATIC_FINDING_KINDS,
} from "./domain/no-bypass";
export type {
  ApplicationIdentity,
  PinnedApplication,
  RevisionPin,
  RevisionValidationIssue,
} from "./domain/revisions";
// Domain: exact revision pinning.
export {
  revisionPinsEqual,
  validateApplicationIdentity,
  validatePinnedApplication,
  validateRevisionPin,
} from "./domain/revisions";
export type {
  EdgeExecutionObservation,
  RunNotRunCause,
  RunOutcome,
  RuntimeBinding,
  RuntimeBindingIssue,
  RuntimeSessionDescriptor,
  TaskRunOutcome,
} from "./domain/runtime";
// Domain: the pinned-application runtime contract + run-level outcomes.
export {
  deriveRunOutcome,
  isRunOutcome,
  RUN_OUTCOMES,
  runtimeBindingIssues,
  runtimeBindingMatches,
  runtimeBindingOf,
  validateRuntimeBinding,
  validateTaskRunOutcome,
} from "./domain/runtime";
export type {
  AdmissionFinding,
  AdmissionRuleId,
  AdmissionRuleResult,
  CompatibilityAssessment,
  CompatibilityStatus,
} from "./domain/status";
// Domain: the strict status admission machine (the ONE status source).
export {
  COMPATIBILITY_ADMISSION_RULES,
  COMPATIBILITY_STATUSES,
  evaluateCompatibility,
} from "./domain/status";
export type {
  DemoRunExecutor,
  DemoRunResult,
} from "./ports/demo-run";
export type { EgressDenyHarness, EgressDenyRule } from "./ports/egress-harness";
export { EgressBlockedError } from "./ports/egress-harness";
export type { CompatibilityEvidenceStore } from "./ports/evidence-store";
export type {
  CorrelatedRunReport,
  PinnedRuntimeDriver,
  PinnedRuntimeSession,
  PinnedRuntimeTask,
  RuntimeRegistryIssue,
  RuntimeStartContext,
} from "./ports/runtime";
export type {
  TraceEventView,
  TraceExecutionView,
  TraceRead,
  TraceRouteFacts,
  TraceUsageFacts,
  TraceVerificationView,
  ZeckTraceSource,
} from "./ports/zeck-trace";
// Ports: the outbound seams.
export { traceFactResolved, zeckTraceFactOf } from "./ports/zeck-trace";
