/**
 * Public contract barrel of the `sandbox` module.
 *
 * This file is the ONLY supported import surface for other modules and for
 * the API layer (`IMPLEMENTATION.md` §2, `spec/contracts.md` "Public
 * module rule"). Everything else under `src/modules/sandbox/` is private to
 * this module.
 *
 * WORK-012 introduces compute environments and sandbox execution
 * (ENV-001/ENV-002, `spec/architecture.md` §15; ADR-0004 normative): the
 * sandbox is an execution ENVIRONMENT — one compute substrate among the
 * ADR-0016 substrate family — never a second execution system and never a
 * new authority:
 *
 *  - `ComputeEnvironmentSpec`/`ComputeEnvironmentRecord`: the
 *    provider-neutral environment contract (kind, resource limits,
 *    network/filesystem/secret policies, runtime requirement, cost
 *    expectation) — Docker/Kubernetes/OCI vocabularies are structurally
 *    absent (discrimination M14); provider mechanics live behind
 *    `src/platform/sandbox/`;
 *  - the environment catalog: stable per-application identity,
 *    content-addressed WRITE-ONCE specifications (digest convergence) and
 *    a small explicit lifecycle (available ⇄ suspended → retired);
 *  - `SandboxExecution`: the governed admission chain (policy admission
 *    REQUIRED — the WORK-007 engine decides the isolation/host/secret
 *    facts; capability admission REQUIRED — the WORK-005 registry decides
 *    the runtime capability; budget admission fail-closed for costed
 *    compute; resource limits mandatory and explicit), the immutable
 *    runtime-metadata snapshot bound to the parent execution (criterion 4)
 *    and the dispatch boundary that resolves a substrate provider and
 *    executes the ADMITTED snapshot with the platform runtimes;
 *  - `no-execution` is FIRST CLASS: a plan may require no compute runtime
 *    at all — its dispatch is a structural no-op that never consults a
 *    provider (M17);
 *  - evidence rides the executions EventEnvelope ledger as step events
 *    (`sandbox-admitted` / `sandbox-denied` / `sandbox-completed`) through
 *    the REQUIRED ledger seam — the canonical write path.
 *
 * Authority seams (consulted, never bypassed, never reimplemented):
 *  - policy admission: `SandboxAdmission` (REQUIRED at service
 *    construction — no default-allow exists);
 *  - capability resolution: `SandboxCapabilityResolution` (REQUIRED);
 *  - budget reservation: the WORK-004 `BudgetAuthority` (fail-closed for
 *    costed environments);
 *  - execution identity/lifecycle/evidence: `SandboxExecutionLedger`
 *    (REQUIRED — the executions public service behind it).
 */

import type { ModuleDescriptor } from "../../shared/module";
import type { EnvironmentCatalog, EnvironmentCatalogDeps } from "./application/environment-catalog";
import { createEnvironmentCatalog } from "./application/environment-catalog";
import type { SandboxService, SandboxServiceDeps } from "./application/sandbox-service";
import { createSandboxService } from "./application/sandbox-service";
import type {
  ComputeEnvironmentRecord,
  ComputeEnvironmentRegistrationInput,
  ComputeEnvironmentSpec,
  EnvironmentLifecycleStatus,
  SandboxCostExpectation,
  SandboxEgressMode,
  SandboxEnvironmentKind,
  SandboxFilesystemPolicy,
  SandboxNetworkPolicy,
  SandboxResourceLimits,
  SandboxRuntimeRequirement,
  SandboxSecretPolicy,
  SandboxWorkspaceMode,
} from "./domain/environment";
import {
  canonicalEnvironmentJson,
  canTransitionEnvironment,
  ENVIRONMENT_LIFECYCLE_STATUSES,
  ENVIRONMENT_TRANSITIONS,
  IMPLEMENTED_SANDBOX_KINDS,
  isEnvironmentLifecycleStatus,
  isSandboxEnvironmentKind,
  isTerminalEnvironmentStatus,
  kindExecutes,
  refLooksLikeHostPath,
  SANDBOX_EGRESS_MODES,
  SANDBOX_ENVIRONMENT_KINDS,
  SANDBOX_WORKSPACE_MODES,
  validateComputeEnvironmentSpec,
  validateEnvironmentRegistration,
} from "./domain/environment";
import type {
  SandboxCreateInput,
  SandboxDenialClass,
  SandboxDenialCode,
  SandboxExecutionRecord,
  SandboxExecutionStatus,
  SandboxFailureClass,
  SandboxOutcomeClass,
  SandboxPolicyEvidence,
  SandboxRuntimeMetadata,
  SandboxTask,
} from "./domain/sandbox";
import {
  canTransitionSandbox,
  containsRawSecretValue,
  isSandboxExecutionStatus,
  isTerminalSandboxStatus,
  SANDBOX_DENIAL_CLASSES,
  SANDBOX_EXECUTION_STATUSES,
  SANDBOX_FAILURE_CLASSES,
  SANDBOX_KEY_PATTERN,
  SANDBOX_OUTCOME_CLASSES,
  SANDBOX_STATUS_TRANSITIONS,
  sandboxRequestFingerprint,
  TERMINAL_SANDBOX_STATUSES,
  validateSandboxTask,
} from "./domain/sandbox";
import type {
  SandboxAdmission,
  SandboxAdmissionDecision,
  SandboxAdmissionRequest,
} from "./ports/sandbox-admission";
import type { SandboxCapabilityResolution } from "./ports/sandbox-capability-gate";
import type {
  LedgerStepEvent,
  LedgerStepEventOutcome,
  SandboxExecutionLedger,
  SandboxStepEventCommand,
} from "./ports/sandbox-ledger";
import type {
  SandboxExecutionObservation,
  SandboxProvider,
  SandboxProviderRegistry,
  SandboxRuntimeSpec,
} from "./ports/sandbox-provider";
import { createSandboxProviderRegistry } from "./ports/sandbox-provider";
import type {
  ClaimOutcome,
  InsertEnvironmentInput,
  InsertSandboxInput,
  SandboxStore,
} from "./ports/sandbox-store";

export const moduleDescriptor: ModuleDescriptor = { id: "sandbox" };

// Adapters are re-exported for composition roots (the WORK-003/005/007/010
// precedent: factories and provider-neutral adapters cross the barrel;
// provider SDK types never do).
export {
  ContainerSandboxProvider,
  createPolicySandboxAdmission,
  createSandboxCapabilityGate,
  createSandboxExecutionLedgerAdapter,
  DEFAULT_SANDBOX_IMAGE,
  InMemorySandboxStore,
  ProcessSandboxProvider,
  SANDBOX_KIND_TO_ISOLATION,
  SqlSandboxStore,
} from "./adapters";
// Application services (the catalog + the governed sandbox lifecycle).
// Domain: the provider-neutral environment contract + sandbox execution.
// Ports: the required authority seams + the neutral substrate contract.
export type {
  ClaimOutcome,
  ComputeEnvironmentRecord,
  ComputeEnvironmentRegistrationInput,
  ComputeEnvironmentSpec,
  EnvironmentCatalog,
  EnvironmentCatalogDeps,
  EnvironmentLifecycleStatus,
  InsertEnvironmentInput,
  InsertSandboxInput,
  LedgerStepEvent,
  LedgerStepEventOutcome,
  SandboxAdmission,
  SandboxAdmissionDecision,
  SandboxAdmissionRequest,
  SandboxCapabilityResolution,
  SandboxCostExpectation,
  SandboxCreateInput,
  SandboxDenialClass,
  SandboxDenialCode,
  SandboxEgressMode,
  SandboxEnvironmentKind,
  SandboxExecutionLedger,
  SandboxExecutionObservation,
  SandboxExecutionRecord,
  SandboxExecutionStatus,
  SandboxFailureClass,
  SandboxFilesystemPolicy,
  SandboxNetworkPolicy,
  SandboxOutcomeClass,
  SandboxPolicyEvidence,
  SandboxProvider,
  SandboxProviderRegistry,
  SandboxResourceLimits,
  SandboxRuntimeMetadata,
  SandboxRuntimeRequirement,
  SandboxRuntimeSpec,
  SandboxSecretPolicy,
  SandboxService,
  SandboxServiceDeps,
  SandboxStepEventCommand,
  SandboxStore,
  SandboxTask,
  SandboxWorkspaceMode,
};
export {
  canonicalEnvironmentJson,
  canTransitionEnvironment,
  canTransitionSandbox,
  containsRawSecretValue,
  createEnvironmentCatalog,
  createSandboxProviderRegistry,
  createSandboxService,
  ENVIRONMENT_LIFECYCLE_STATUSES,
  ENVIRONMENT_TRANSITIONS,
  IMPLEMENTED_SANDBOX_KINDS,
  isEnvironmentLifecycleStatus,
  isSandboxEnvironmentKind,
  isSandboxExecutionStatus,
  isTerminalEnvironmentStatus,
  isTerminalSandboxStatus,
  kindExecutes,
  refLooksLikeHostPath,
  SANDBOX_DENIAL_CLASSES,
  SANDBOX_EGRESS_MODES,
  SANDBOX_ENVIRONMENT_KINDS,
  SANDBOX_EXECUTION_STATUSES,
  SANDBOX_FAILURE_CLASSES,
  SANDBOX_KEY_PATTERN,
  SANDBOX_OUTCOME_CLASSES,
  SANDBOX_STATUS_TRANSITIONS,
  SANDBOX_WORKSPACE_MODES,
  sandboxRequestFingerprint,
  TERMINAL_SANDBOX_STATUSES,
  validateComputeEnvironmentSpec,
  validateEnvironmentRegistration,
  validateSandboxTask,
};
