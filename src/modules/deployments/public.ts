/**
 * Public contract barrel of the `deployments` module (WORK-023).
 *
 * This file is the ONLY supported import surface for other modules
 * and for the API layer (`IMPLEMENTATION.md` §2, `spec/contracts.md`
 * "Public module rule"). Everything else under
 * `src/modules/deployments/` is private to this module.
 *
 * WORK-023 introduces the provider-neutral deployment fabric
 * (MOD-001..004/010, ADR-0014/0015/0017):
 *
 *  - the IMMUTABLE VERSIONED `DeploymentProfile` and `DeploymentPlan`
 *    artifacts (provider-neutral modality/channel/capability/latency/
 *    resource/side-effect declarations; channel bindings name neutral
 *    adapter capability ids — vendor rails never cross);
 *  - the `Deployment` control-plane object: identity bound to
 *    application/environment/agent-version (MOD-002), pointing at ONE
 *    immutable plan version, moved between versions ONLY through
 *    guarded, journaled lifecycle operations (MOD-003: create/
 *    promote/rollback/suspend/resume/retire — idempotent,
 *    concurrency-safe, append-only evidence with actor, cause,
 *    prior/current version and execution provenance);
 *  - the modality-adapter seam (MOD-004): provider-neutral channel
 *    adapters that DESCRIBE bindings and never authorize, budget,
 *    admit or execute — duplicate authorities are unrepresentable in
 *    the port's shape;
 *  - BYOA representation (MOD-010): agent references may carry
 *    `agentKind: "byoa"` with an OPAQUE external descriptor — an
 *    external runtime is representable WITHOUT becoming a Zeck
 *    dependency.
 *
 * Deployment is Execution-ADJACENT (ADR-0014 invariant 1): nothing
 * here dispatches, executes or verifies; executions remain the runs
 * (the executions module's authority), and every deployed workload
 * ultimately executes through the existing Execution abstraction
 * under the existing policy/capability/budget/tenant/verification
 * authorities — unchanged.
 */

import type { ModuleDescriptor } from "../../shared/module";
import { createAgentInventoryAdapter } from "./adapters/agent-inventory-adapter";
import { createBudgetRealtimeAdmission } from "./adapters/budget-realtime-admission";
import { createCapabilityRealtimeAdmission } from "./adapters/capability-realtime-admission";
import { createConnectionsRealtimeSecretMediation } from "./adapters/connections-realtime-secret-mediation";
import { createSqlEnvironmentResolver } from "./adapters/environment-resolver-adapter";
import { InMemoryDeploymentStore } from "./adapters/in-memory-deployment-store";
import { InMemoryRealtimeStore } from "./adapters/in-memory-realtime-store";
import { createInProcessRealtimeRail } from "./adapters/in-process-realtime-rail";
import { createPlannerSubtaskRouter } from "./adapters/planner-subtask-router";
import { createPolicyRealtimeAdmission } from "./adapters/policy-realtime-admission";
import { createRealtimeExecutionLedgerAdapter } from "./adapters/realtime-execution-ledger";
import { createRealtimeModalityAdapter } from "./adapters/realtime-modality-adapter";
import { SqlDeploymentStore } from "./adapters/sql-deployment-store";
import { SqlRealtimeStore } from "./adapters/sql-realtime-store";
import type {
  DeploymentActor,
  DeploymentService,
  DeploymentServiceDeps,
} from "./application/deployment-service";
import { createDeploymentService } from "./application/deployment-service";
import type {
  RealtimeActor,
  RealtimeDeploymentFacts,
  RealtimeIngestOutcome,
  RealtimeSessionService,
  RealtimeSessionServiceDeps,
  StartRealtimeSessionOutcome,
} from "./application/realtime-session-service";
import { createRealtimeSessionService } from "./application/realtime-session-service";
import type {
  CreateDeploymentInput,
  DeploymentEventKind,
  DeploymentEventRecord,
  DeploymentMutationInput,
  DeploymentStatus,
  DeploymentValidation,
  PromoteDeploymentInput,
} from "./domain/deployment";
import {
  canTransitionDeployment,
  DEPLOYMENT_EVENT_KINDS,
  DEPLOYMENT_STATUS_TRANSITIONS,
  DEPLOYMENT_STATUSES,
  deploymentCreationFingerprint,
  isDeploymentEventKind,
  isDeploymentStatus,
  isTerminalDeploymentStatus,
  validateCause,
  validateCreateDeploymentInput,
} from "./domain/deployment";
import type {
  ChannelBinding,
  DeploymentPlan,
  DeploymentPlanInput,
  DeploymentSessionPolicy,
  PlanAgentRef,
  PlanValidation,
} from "./domain/plan";
import { canonicalPlanJson, validateDeploymentPlanInput } from "./domain/plan";
import type {
  DeploymentIoModality,
  DeploymentLatencyClass,
  DeploymentModality,
  DeploymentProfile,
  DeploymentProfileInput,
  DeploymentResourceClass,
  DeploymentSideEffectClass,
  ProfileValidation,
} from "./domain/profile";
import {
  canonicalProfileJson,
  DEPLOYMENT_CHANNEL_KINDS,
  DEPLOYMENT_IO_MODALITIES,
  DEPLOYMENT_LATENCY_CLASSES,
  DEPLOYMENT_MODALITIES,
  DEPLOYMENT_RESOURCE_CLASSES,
  DEPLOYMENT_SIDE_EFFECT_CLASSES,
  profileContainsRawSecretValue,
  validateDeploymentProfileInput,
} from "./domain/profile";
import type {
  RealtimeChannelKind,
  RealtimeEventDirection,
  RealtimeEventKind,
  RealtimeEventRecord,
  RealtimeInboundEventInput,
  RealtimeInboundKind,
  RealtimeRouteClass,
  RealtimeSessionRecord,
  RealtimeSessionStatus,
  RealtimeValidation,
  StartRealtimeSessionInput,
} from "./domain/realtime";
import {
  canTransitionRealtimeSession,
  deterministicRealtimeEventKey,
  isRealtimeChannelKind,
  isRealtimeEventKind,
  isRealtimeInboundKind,
  isRealtimeRouteClass,
  isRealtimeSessionStatus,
  isTerminalRealtimeSessionStatus,
  REALTIME_CHANNEL_KINDS,
  REALTIME_EVENT_DIRECTIONS,
  REALTIME_EVENT_KINDS,
  REALTIME_INBOUND_KINDS,
  REALTIME_ROUTE_CLASSES,
  REALTIME_SESSION_STATUSES,
  REALTIME_SESSION_TRANSITIONS,
  realtimeContainsRawSecretValue,
  realtimeEventBodyDigestBase,
  realtimeSessionCreationFingerprint,
  validateRealtimeInboundEvent,
  validateStartRealtimeSessionInput,
} from "./domain/realtime";
import type { AgentVersionFact, DeploymentAgentInventory } from "./ports/agent-inventory";
import type {
  DeploymentInsertInput,
  DeploymentInsertOutcome,
  DeploymentStore,
  GuardedMutation,
  JournalAppendInput,
  PlanInsertInput,
  PlanInsertOutcome,
  ProfileInsertInput,
  ProfileInsertOutcome,
} from "./ports/deployment-store";
import type { DeploymentEnvironmentResolver, EnvironmentRef } from "./ports/environment-resolver";
import type {
  ModalityAdapterDescriptor,
  ModalityAdapterRegistry,
  ModalityBindingCheck,
  ModalityChannelAdapter,
} from "./ports/modality-adapter";
import { createModalityAdapterRegistry } from "./ports/modality-adapter";
import type {
  RealtimeAdmissionEvidence,
  RealtimeBudgetAdmission,
  RealtimeBudgetReservation,
  RealtimeBudgetReserveCommand,
  RealtimeCapabilityAdmission,
  RealtimeCapabilityAdmissionDecision,
  RealtimeCapabilityAdmissionRequest,
  RealtimePolicyAction,
  RealtimePolicyAdmission,
  RealtimePolicyAdmissionDecision,
  RealtimePolicyAdmissionRequest,
  RealtimeSecretMediation,
  RealtimeSecretMediationOutcome,
  RealtimeSecretMediationRequest,
} from "./ports/realtime-admission";
import type {
  RealtimeEvidenceClass,
  RealtimeEvidenceInput,
  RealtimeEvidenceOutcome,
  RealtimeExecutionLedger,
  RealtimeExecutionOpenInput,
  RealtimeExecutionOpenOutcome,
} from "./ports/realtime-execution-ledger";
import type {
  RealtimeRail,
  RealtimeRailCallback,
  RealtimeRailDelivery,
  RealtimeRailDeliveryOutcome,
  RealtimeRailDescriptor,
  RealtimeRailSession,
  RealtimeRailSessionRequest,
} from "./ports/realtime-rail";
import type {
  RealtimeEventAppendInput,
  RealtimeEventAppendOutcome,
  RealtimeSessionInsertInput,
  RealtimeSessionInsertOutcome,
  RealtimeSessionMutation,
  RealtimeSessionMutationOutcome,
  RealtimeStore,
} from "./ports/realtime-store";
import type {
  RealtimeSubtaskRouter,
  RealtimeTurnRoute,
  RealtimeTurnRouteRequest,
} from "./ports/realtime-subtask-router";
import type {
  RealtimeTurnResponder,
  RealtimeTurnResponderRequest,
  RealtimeTurnResponse,
} from "./ports/realtime-turn-responder";

export const moduleDescriptor: ModuleDescriptor = { id: "deployments" };

export type {
  AgentVersionFact,
  ChannelBinding,
  CreateDeploymentInput,
  DeploymentActor,
  DeploymentAgentInventory,
  DeploymentEnvironmentResolver,
  DeploymentEventKind,
  DeploymentEventRecord,
  DeploymentInsertInput,
  DeploymentInsertOutcome,
  DeploymentIoModality,
  DeploymentLatencyClass,
  DeploymentModality,
  DeploymentMutationInput,
  DeploymentPlan,
  DeploymentPlanInput,
  DeploymentProfile,
  DeploymentProfileInput,
  DeploymentResourceClass,
  DeploymentService,
  DeploymentServiceDeps,
  DeploymentSessionPolicy,
  DeploymentSideEffectClass,
  DeploymentStatus,
  DeploymentStore,
  DeploymentValidation,
  EnvironmentRef,
  GuardedMutation,
  JournalAppendInput,
  ModalityAdapterDescriptor,
  ModalityAdapterRegistry,
  ModalityBindingCheck,
  ModalityChannelAdapter,
  PlanAgentRef,
  PlanInsertInput,
  PlanInsertOutcome,
  PlanValidation,
  ProfileInsertInput,
  ProfileInsertOutcome,
  ProfileValidation,
  PromoteDeploymentInput,
  // ---- WORK-024: realtime voice sessions (MOD-005/006/007) ----
  RealtimeActor,
  RealtimeAdmissionEvidence,
  RealtimeBudgetAdmission,
  RealtimeBudgetReservation,
  RealtimeBudgetReserveCommand,
  RealtimeCapabilityAdmission,
  RealtimeCapabilityAdmissionDecision,
  RealtimeCapabilityAdmissionRequest,
  RealtimeChannelKind,
  RealtimeDeploymentFacts,
  RealtimeEventAppendInput,
  RealtimeEventAppendOutcome,
  RealtimeEventDirection,
  RealtimeEventKind,
  RealtimeEventRecord,
  RealtimeEvidenceClass,
  RealtimeEvidenceInput,
  RealtimeEvidenceOutcome,
  RealtimeExecutionLedger,
  RealtimeExecutionOpenInput,
  RealtimeExecutionOpenOutcome,
  RealtimeInboundEventInput,
  RealtimeInboundKind,
  RealtimeIngestOutcome,
  RealtimePolicyAction,
  RealtimePolicyAdmission,
  RealtimePolicyAdmissionDecision,
  RealtimePolicyAdmissionRequest,
  RealtimeRail,
  RealtimeRailCallback,
  RealtimeRailDelivery,
  RealtimeRailDeliveryOutcome,
  RealtimeRailDescriptor,
  RealtimeRailSession,
  RealtimeRailSessionRequest,
  RealtimeRouteClass,
  RealtimeSecretMediation,
  RealtimeSecretMediationOutcome,
  RealtimeSecretMediationRequest,
  RealtimeSessionInsertInput,
  RealtimeSessionInsertOutcome,
  RealtimeSessionMutation,
  RealtimeSessionMutationOutcome,
  RealtimeSessionRecord,
  RealtimeSessionService,
  RealtimeSessionServiceDeps,
  RealtimeSessionStatus,
  RealtimeStore,
  RealtimeSubtaskRouter,
  RealtimeTurnResponder,
  RealtimeTurnResponderRequest,
  RealtimeTurnResponse,
  RealtimeTurnRoute,
  RealtimeTurnRouteRequest,
  RealtimeValidation,
  StartRealtimeSessionInput,
  StartRealtimeSessionOutcome,
};
// Adapters are re-exported for composition roots (the WORK-003/005/007
// precedent: factories and provider-neutral adapters cross the barrel;
// provider SDK types never do).
export {
  canonicalPlanJson,
  canonicalProfileJson,
  canTransitionDeployment,
  canTransitionRealtimeSession,
  createAgentInventoryAdapter,
  createBudgetRealtimeAdmission,
  createCapabilityRealtimeAdmission,
  createConnectionsRealtimeSecretMediation,
  createDeploymentService,
  createInProcessRealtimeRail,
  createModalityAdapterRegistry,
  createPlannerSubtaskRouter,
  createPolicyRealtimeAdmission,
  createRealtimeExecutionLedgerAdapter,
  createRealtimeModalityAdapter,
  createRealtimeSessionService,
  createSqlEnvironmentResolver,
  DEPLOYMENT_CHANNEL_KINDS,
  DEPLOYMENT_EVENT_KINDS,
  DEPLOYMENT_IO_MODALITIES,
  DEPLOYMENT_LATENCY_CLASSES,
  DEPLOYMENT_MODALITIES,
  DEPLOYMENT_RESOURCE_CLASSES,
  DEPLOYMENT_SIDE_EFFECT_CLASSES,
  DEPLOYMENT_STATUS_TRANSITIONS,
  DEPLOYMENT_STATUSES,
  deploymentCreationFingerprint,
  deterministicRealtimeEventKey,
  InMemoryDeploymentStore,
  InMemoryRealtimeStore,
  isDeploymentEventKind,
  isDeploymentStatus,
  isRealtimeChannelKind,
  isRealtimeEventKind,
  isRealtimeInboundKind,
  isRealtimeRouteClass,
  isRealtimeSessionStatus,
  isTerminalDeploymentStatus,
  isTerminalRealtimeSessionStatus,
  profileContainsRawSecretValue,
  REALTIME_CHANNEL_KINDS,
  REALTIME_EVENT_DIRECTIONS,
  REALTIME_EVENT_KINDS,
  REALTIME_INBOUND_KINDS,
  REALTIME_ROUTE_CLASSES,
  REALTIME_SESSION_STATUSES,
  REALTIME_SESSION_TRANSITIONS,
  realtimeContainsRawSecretValue,
  realtimeEventBodyDigestBase,
  realtimeSessionCreationFingerprint,
  SqlDeploymentStore,
  SqlRealtimeStore,
  validateCause,
  validateCreateDeploymentInput,
  validateDeploymentPlanInput,
  validateDeploymentProfileInput,
  validateRealtimeInboundEvent,
  validateStartRealtimeSessionInput,
};
