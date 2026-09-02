/**
 * Public contract barrel of the edge integration (WORK-029,
 * EDGE-001/002/003).
 *
 * Integrations are adapters for external systems: `public.ts` is the
 * only supported import surface, `adapters/` owns external client
 * implementations (the simulated edge controller is the in-process
 * reference rail — real controller adapters arrive with their own Work
 * Orders), and `internal/` is never imported from outside.
 *
 * Zeck is the GOVERNANCE/ORCHESTRATION plane for edge, hard-latency and
 * embodied substrates — NEVER the safety-critical control loop: this
 * integration owns device registration/revocation, the human-approval
 * ledger, the IMMUTABLE safety envelopes, the governed command journal,
 * sensor/command/actuation provenance and the deterministic
 * reconnect reconciliation. The hard-real-time loop lives on the LOCAL
 * controller behind the `EdgeControllerAdapter` seam (no
 * loop/scheduling surface exists anywhere in this integration).
 */

export const integrationId = "edge" as const;

export type EdgeIntegrationId = typeof integrationId;

// -- the governed service -----------------------------------------------------

export {
  createEdgeService,
  type EdgeApprovalReceipt,
  type EdgeCommandReceipt,
  type EdgeDeviceReceipt,
  type EdgeEnvelopeReceipt,
  type EdgeReconciliationReceipt,
  type EdgeService,
  type EdgeServiceDeps,
} from "./application/edge-service";

// -- the domain contracts (provider-neutral, vendor-free) ---------------------

export type {
  EdgeActuationClass,
  EdgeActuationEventRecord,
  EdgeActuatorChannel,
  EdgeApprovalDecisionInput,
  EdgeApprovalRecord,
  EdgeApprovalRequestInput,
  EdgeApprovalStatus,
  EdgeApprovalSubjectKind,
  EdgeCommandEffectClass,
  EdgeCommandKind,
  EdgeCommandRecord,
  EdgeCommandRequest,
  EdgeCommandStatus,
  EdgeDeviceRecord,
  EdgeDeviceRegistrationRequest,
  EdgeDeviceStatus,
  EdgeDisconnectedPolicy,
  EdgeEnvelopeAdmission,
  EdgeEnvelopeAdmissionRequest,
  EdgeEnvelopeRecord,
  EdgeEnvelopeStatus,
  EdgeHealthReport,
  EdgeHealthStatus,
  EdgeOperationKind,
  EdgePolicyEvidence,
  EdgeReconciliationRecord,
  EdgeReconciliationReport,
  EdgeReportedActuation,
  EdgeSafetyEnvelopeContent,
  EdgeSensorObservationInput,
  EdgeSensorObservationRecord,
  EdgeSensorObservationType,
  EdgeSensorRetention,
  EdgeViolationKind,
  EdgeWorkloadClass,
} from "./domain/edge";
export {
  canonicalEdgeJson,
  EDGE_ACTUATION_CLASSES,
  EDGE_ACTUATOR_CHANNELS,
  EDGE_APPROVAL_STATUSES,
  EDGE_COMMAND_EFFECT_CLASS_BY_KIND,
  EDGE_COMMAND_EFFECT_CLASSES,
  EDGE_COMMAND_KINDS,
  EDGE_COMMAND_STATUSES,
  EDGE_DEVICE_STATUSES,
  EDGE_DISCONNECTED_POLICIES,
  EDGE_ENVELOPE_STATUSES,
  EDGE_HEALTH_STATUSES,
  EDGE_KEY_PATTERN,
  EDGE_KEY_PREFIXES,
  EDGE_MAGNITUDE_MAX,
  EDGE_MAGNITUDE_MIN,
  EDGE_OPERATION_KINDS,
  EDGE_SENSOR_OBSERVATION_TYPES,
  EDGE_SENSOR_RETENTIONS,
  EDGE_TOOL_FACTS,
  EDGE_VIOLATION_KINDS,
  EDGE_WORKLOAD_CLASSES,
  edgeApprovalAuthorizes,
  edgeChannelAtom,
  edgeCommandFingerprint,
  edgeCommandFreshness,
  edgeDeviceFingerprint,
  edgeEnvelopeCoversCommand,
  edgeEnvelopeFingerprint,
  edgeFingerprintOf,
  edgeSensorObservationFingerprint,
  isEdgeActuationClass,
  isEdgeActuatorChannel,
  isEdgeApprovalStatus,
  isEdgeCommandKind,
  isEdgeCommandStatus,
  isEdgeDeviceStatus,
  isEdgeDisconnectedPolicy,
  isEdgeEnvelopeStatus,
  isEdgeHealthStatus,
  isEdgeOperationKind,
  isEdgeSensorObservationType,
  isEdgeSensorRetention,
  isEdgeWorkloadClass,
  validateEdgeApprovalDecision,
  validateEdgeApprovalRequest,
  validateEdgeCommandRequest,
  validateEdgeDeviceRegistration,
  validateEdgeEnvelopeRequest,
  validateEdgeHealthReport,
  validateEdgeSensorObservation,
} from "./domain/edge";

// -- the ports (the REQUIRED authority + substrate seams) ----------------------

export type {
  EdgeCapabilityGate,
  EdgeCapabilityGateDecision,
  EdgeCapabilityGateRequest,
  EdgePolicyAdmission,
  EdgePolicyAdmissionDecision,
  EdgePolicyAdmissionRequest,
} from "./ports/edge-admission";
export type {
  EdgeCommandDispatch,
  EdgeControllerAdapter,
  EdgeDispatchAck,
} from "./ports/edge-controller";
export type {
  EdgeExecutionLedger,
  EdgeLedgerStepEvent,
  EdgeLedgerStepEventOutcome,
  EdgeStepEventCommand,
} from "./ports/edge-ledger";
export type { EdgeStore } from "./ports/edge-store";

// -- the adapters (the replaceable substrate + durable state) ------------------

export { createEdgeExecutionLedgerAdapter } from "./adapters/execution-ledger";
export {
  createEdgeCapabilityGate,
  createPolicyEdgeAdmission,
  InMemoryEdgeStore,
  SqlEdgeStore,
} from "./adapters/index";
export {
  createSimulatedEdgeController,
  type SimulatedEdgeController,
} from "./adapters/simulated-edge-controller";
