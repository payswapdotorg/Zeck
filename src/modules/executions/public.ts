/**
 * Public contract barrel of the `executions` module.
 *
 * This file is the ONLY supported import surface for other modules and for
 * the API layer (`IMPLEMENTATION.md` §2, `spec/contracts.md` "Public
 * module rule"). Everything else under `src/modules/executions/` is private
 * to this module.
 *
 * WORK-006 introduces the execution identity, lifecycle and event core:
 * the `Execution` primary abstraction (`spec/architecture.md` §2.1), its
 * frozen state machine (`spec/contracts.md` transition table — the single
 * write path), the append-only ordered `EventEnvelope` ledger with
 * per-execution gapless sequences, durable verification-result records and
 * the completion binding, and request-idempotent creation
 * (`createExecution(input, idempotencyKey, actor)` — provider selection is
 * forbidden in the public create contract; the provider fabric underneath
 * is the models/connections fabric from WORK-003, never named here).
 *
 * Authority seams (consulted, never bypassed, never reimplemented):
 *  - policy admission: `ExecutionAuthorizationPort` (REQUIRED at service
 *    construction — no default-allow exists; the engine is WORK-007);
 *  - budget reservation at dispatch: the WORK-004 `BudgetAuthority`
 *    (`src/modules/budgets/public.ts`) passed as an optional service dep.
 *
 * WORK-028 adds the LONG-RUNNING, RESUMABLE execution extension (LNG-001/
 * 002/003): durable integrity-protected CHECKPOINTS, the single-owner
 * execution LEASE (monotonic epochs, guarded transitions, fail-closed
 * conflicts), deterministic WAKE-UPS, the durable recoverable long-running
 * OPERATION state, and the resume re-admission authority seams
 * (`ResumePolicyReAdmission` / `ResourceReAdmission` — REQUIRED at
 * long-running service construction, no default-allow exists; the
 * resource seam is implemented by the sandbox module's
 * `createExecutionResumeReadmission` adapter). The extension COMPOSES
 * with the frozen lifecycle: `createLongRunningExecutionService` moves
 * status only through the frozen transition commands and records all
 * checkpoint/lease/wake-up evidence on the SAME EventEnvelope ledger.
 */

import type { ModuleDescriptor } from "../../shared/module";
import type {
  AppliedTransition,
  ExecutionService,
  ExecutionTransitionCommand,
  PlanningDecisionRecordOutcome,
  RecordPlanningDecisionInput,
  RecordStepEventInput,
  StepEventOutcome,
  TransitionOutcome,
} from "./application/execution-service";
import { createExecutionService } from "./application/execution-service";
import type {
  AcquireLeaseCommand,
  ApplyWakeUpsCommand,
  ApplyWakeUpsOutcome,
  CheckpointOutcome,
  InterruptExecutionCommand,
  InterruptOutcome,
  LeaseOutcome,
  LeaseReleaseOutcome,
  LongRunningActor,
  LongRunningExecutionService,
  LongRunningExecutionServiceDeps,
  PauseExecutionCommand,
  PauseOutcome,
  PauseWakeUpRequest,
  RecordCheckpointCommand,
  ReleaseLeaseCommand,
  RenewLeaseCommand,
  ResumeExecutionCommand,
  ResumeOutcome,
  ResumeWorkerRequest,
  ScheduleWakeUpCommand,
  TerminateExecutionCommand,
  TerminateOutcome,
  WakeUpApplicationAction,
  WakeUpOutcome,
  WorkerClaim,
  WorkerTransitionCommand,
} from "./application/long-running-service";
import { createLongRunningExecutionService } from "./application/long-running-service";
import type {
  CheckpointContents,
  CheckpointRecord,
  MaterialChangeDimension,
  ResumeFacts,
} from "./domain/checkpoint";
import {
  canonicalCheckpointJson,
  checkpointDigestInput,
  checkpointIncompatibility,
  checkpointIntegrityFailure,
  MATERIAL_CHANGE_DIMENSIONS,
  materialChangeBetween,
  materialFactsOf,
  validateCheckpointContents,
  validateResumeFacts,
} from "./domain/checkpoint";
import type {
  AppendEventInput,
  EventCommand,
  EventEnvelope,
  StepEventCommand,
} from "./domain/event";
import {
  eventTypeFor,
  isStepEventCommand,
  PLANNING_DECISION_EVENT_TYPE,
  POLICY_DENIED_EVENT_TYPE,
  STEP_EVENT_COMMANDS,
} from "./domain/event";
import type {
  ExecutionActor,
  ExecutionConstraints,
  ExecutionCreateInput,
  ExecutionReceipt,
  ExecutionRecord,
} from "./domain/execution";
import { CREATE_INPUT_KEYS, FORBIDDEN_INPUT_KEYS } from "./domain/execution";
import type { LeaseGuard, LeaseRecord, LeaseReleaseCause, LeaseState } from "./domain/lease";
import { classifyLease, LEASE_RELEASE_CAUSES, leaseGuardRejection } from "./domain/lease";
import type {
  LongRunningOperationKind,
  LongRunningOperationRecord,
  LongRunningOperationStatus,
} from "./domain/longrunning";
import {
  executionScopedDiscriminator,
  LONG_RUNNING_OPERATION_KINDS,
  longRunningOperationKey,
} from "./domain/longrunning";
import type { ExecutionCommand, ExecutionStatus, TransitionEdge } from "./domain/state-machine";
import {
  canTransition,
  EXECUTION_COMMANDS,
  EXECUTION_STATES,
  isExecutionCommand,
  isExecutionStatus,
  isTerminal,
  NON_TERMINAL_STATUSES,
  nextState,
  TERMINAL_STATUSES,
  TRANSITION_TABLE,
} from "./domain/state-machine";
import type {
  VerificationResultInput,
  VerificationResultRecord,
  VerificationResultStatus,
} from "./domain/verification";
import type { WakeUpRecord, WakeUpStatus } from "./domain/wakeup";
import { compareWakeUpOrder, WAKE_UP_STATUSES } from "./domain/wakeup";
import type { AdmissionEvidence, ExecutionAuthorizationPort } from "./ports/authorization";
import type { ExecutionsIdempotencyPort } from "./ports/execution-idempotency";
import type { ExecutionStore } from "./ports/execution-store";
import type { LongRunningExecutionStore } from "./ports/long-running-store";
import type {
  ResourceReAdmission,
  ResumePolicyReAdmission,
  ResumeReAdmissionDecision,
  ResumeReAdmissionRequest,
} from "./ports/resume-admission";

export const moduleDescriptor: ModuleDescriptor = { id: "executions" };

// Application services + commands/outcomes.
// Domain: execution identity + create contract (provider-selection-free).
// Domain: the frozen state machine (single legality oracle).
// Domain: EventEnvelope ledger + durable verification results.
// Module ports (provider-neutral; implemented by adapters).
export type {
  // The long-running extension (WORK-028): commands and outcomes.
  AcquireLeaseCommand,
  AdmissionEvidence,
  AppendEventInput,
  AppliedTransition,
  ApplyWakeUpsCommand,
  ApplyWakeUpsOutcome,
  CheckpointContents,
  CheckpointOutcome,
  CheckpointRecord,
  EventCommand,
  EventEnvelope,
  ExecutionActor,
  ExecutionAuthorizationPort,
  ExecutionCommand,
  ExecutionConstraints,
  ExecutionCreateInput,
  ExecutionReceipt,
  ExecutionRecord,
  ExecutionService,
  ExecutionStatus,
  ExecutionStore,
  ExecutionsIdempotencyPort,
  ExecutionTransitionCommand,
  InterruptExecutionCommand,
  InterruptOutcome,
  LeaseGuard,
  LeaseOutcome,
  LeaseRecord,
  LeaseReleaseCause,
  LeaseReleaseOutcome,
  LeaseState,
  LongRunningActor,
  LongRunningExecutionService,
  LongRunningExecutionServiceDeps,
  LongRunningExecutionStore,
  LongRunningOperationKind,
  LongRunningOperationRecord,
  LongRunningOperationStatus,
  MaterialChangeDimension,
  PauseExecutionCommand,
  PauseOutcome,
  PauseWakeUpRequest,
  PlanningDecisionRecordOutcome,
  RecordCheckpointCommand,
  RecordPlanningDecisionInput,
  RecordStepEventInput,
  ReleaseLeaseCommand,
  RenewLeaseCommand,
  ResourceReAdmission,
  ResumeExecutionCommand,
  ResumeFacts,
  ResumeOutcome,
  ResumePolicyReAdmission,
  ResumeReAdmissionDecision,
  ResumeReAdmissionRequest,
  ResumeWorkerRequest,
  ScheduleWakeUpCommand,
  StepEventCommand,
  StepEventOutcome,
  TerminateExecutionCommand,
  TerminateOutcome,
  TransitionEdge,
  TransitionOutcome,
  VerificationResultInput,
  VerificationResultRecord,
  VerificationResultStatus,
  WakeUpApplicationAction,
  WakeUpOutcome,
  WakeUpRecord,
  WakeUpStatus,
  WorkerClaim,
  WorkerTransitionCommand,
};
export {
  CREATE_INPUT_KEYS,
  canonicalCheckpointJson,
  canTransition,
  checkpointDigestInput,
  checkpointIncompatibility,
  checkpointIntegrityFailure,
  classifyLease,
  compareWakeUpOrder,
  createExecutionService,
  createLongRunningExecutionService,
  EXECUTION_COMMANDS,
  EXECUTION_STATES,
  eventTypeFor,
  executionScopedDiscriminator,
  FORBIDDEN_INPUT_KEYS,
  isExecutionCommand,
  isExecutionStatus,
  isStepEventCommand,
  isTerminal,
  LEASE_RELEASE_CAUSES,
  LONG_RUNNING_OPERATION_KINDS,
  leaseGuardRejection,
  longRunningOperationKey,
  MATERIAL_CHANGE_DIMENSIONS,
  materialChangeBetween,
  materialFactsOf,
  NON_TERMINAL_STATUSES,
  nextState,
  PLANNING_DECISION_EVENT_TYPE,
  POLICY_DENIED_EVENT_TYPE,
  STEP_EVENT_COMMANDS,
  TERMINAL_STATUSES,
  TRANSITION_TABLE,
  validateCheckpointContents,
  validateResumeFacts,
  WAKE_UP_STATUSES,
};
