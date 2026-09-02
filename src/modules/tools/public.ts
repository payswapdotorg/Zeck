/**
 * Public contract barrel of the `tools` module.
 *
 * This file is the ONLY supported import surface for other modules and for
 * the API layer (`IMPLEMENTATION.md` §2, `spec/contracts.md` "Public
 * module rule"). Everything else under `src/modules/tools/` is private
 * to this module.
 *
 * WORK-010 introduces the governed tool runtime (TOL-001/TOL-002, `spec/
 * architecture.md` §13): the provider-neutral `ToolContract` (identity,
 * capability identity, input/output schemas, execution requirements,
 * side-effect class, network/secret requirements, cost expectations,
 * evidence contract — every dimension declared once and validated at
 * registration), the tool registry (tool admission: identity → validated
 * contract + bound adapter), and `createToolRuntime` — the admission chain
 * that consults, in order, the WORK-007 policy authority (REQUIRED
 * `ToolAdmission` seam — no default-allow exists), the WORK-004 budget
 * authority (costed tools fail closed without it) and the WORK-005
 * capability registry (REQUIRED `ToolCapabilityResolution` seam) BEFORE
 * the durable-intent boundary and any adapter execution. Every invocation
 * — admitted or denied — is durable evidence on `tools.tool_invocations`
 * (migration 0005) bound to its parent execution, and rides the executions
 * module's canonical EventEnvelope ledger as step events through the
 * REQUIRED `ExecutionLedger` seam (`execution.tool-requested`,
 * `execution.tool-result`, `execution.tool-denied`).
 *
 * Tool outcomes are observations on the tool axis (`tool-success` /
 * `tool-failure`), physically disjoint from verification and provider
 * classes; tools cannot mutate customer-domain workflow state or platform
 * authority state (the adapter port hands them no such surface).
 *
 * WORK-021 adds the deterministic-replacement EXECUTION seam for the
 * deterministicization lifecycle (DTR-001..004): the
 * `DeterministicReplacementExecutor` port — its only implementation
 * wraps the sandbox module's public service exactly like the
 * synthesis executor (every replacement run is a fully admitted,
 * dispatched and journaled sandbox execution; substrate confinement
 * before dispatch; the pure-compute static scan as defense in depth).
 * Learning records and gates; tools executes; the sandbox admits.
 *
 * WORK-027 adds the governed computer-use capability family (CUI-001/002/
 * 003): browser, desktop and terminal interaction as ONE provider-neutral
 * contract family (validated capability declarations, the explicit
 * desktop capability envelope, the browser isolation profile with
 * ambient-host-inheritance fixed to "none"), the deterministic-first
 * ROUTE evaluation (pure; a sufficient verified deterministic route
 * yields zero GUI stages — the escalation ladder deterministic ->
 * browser -> desktop is a frozen, physically ascending order), the
 * governed session service (the full admission chain — policy, budget,
 * capability, secret mediation — BEFORE any environment interaction,
 * crash-safe keyed operations, journal-then-fail denials), the simulated
 * isolated environment rail (keyed convergence, egress confinement, the
 * no-ambient-inheritance proof surface) and the sandbox terminal
 * executor (every terminal-exec action is a fully admitted sandbox
 * execution — the approved WORK-012 boundary). Computer-use sessions are
 * subordinate bookkeeping: never a second execution identity, never a
 * second event authority (evidence rides the canonical EventEnvelope
 * ledger through this module's recordStepEvent seam).
 *
 * WORK-018 adds governed program synthesis INSIDE the tool abstraction
 * (TOL-004): synthesized tools are ephemeral, content-addressed
 * artifacts with explicit schemas/capabilities; compilation and
 * execution occur ONLY inside the sandbox manager (the REQUIRED
 * `SynthesisSandboxExecutor` seam — its only implementation wraps the
 * sandbox module's public service); static validation + runtime tests
 * gate usability (the `draft → validated → usable` lifecycle with
 * terminal `rejected`/`retired`, physically guarded by migration
 * 0011); source, build digest, test evidence and execution provenance
 * are durable; and synthesized code cannot obtain capabilities beyond
 * policy grants — the SAME registry/runtime admission chain governs
 * every invocation, and the executor confines the substrate layer to
 * the target environment's grants before dispatch.
 */

import type { ModuleDescriptor } from "../../shared/module";
import type {
  ComputerUseActionDispatchResult,
  ComputerUseActionRequest,
  ComputerUseEscalationRequest,
  ComputerUseService,
  ComputerUseServiceDeps,
  ComputerUseSessionReceipt,
  ComputerUseTrajectory,
} from "./application/computer-use-service";
import {
  COMPUTER_USE_INPUT_MAX,
  COMPUTER_USE_OBSERVATION_CONTENT_MAX,
  createComputerUseService,
} from "./application/computer-use-service";
import type {
  SubmitProgramOutcome,
  SynthesisActor,
  SynthesisService,
  SynthesisServiceDeps,
} from "./application/synthesis-service";
import {
  createSynthesisService,
  SYNTHESIS_DEFAULT_TIMEOUT_MS,
} from "./application/synthesis-service";
import { createToolRegistry } from "./application/tool-registry";
import type { ToolRuntime, ToolRuntimeDeps } from "./application/tool-runtime";
import { createToolRuntime, toolRequestFingerprint } from "./application/tool-runtime";
import type {
  AmbientHostInheritance,
  ComputerUseActionRecord,
  ComputerUseActionStatus,
  ComputerUseActionType,
  ComputerUseActor,
  ComputerUseAdmissionSnapshot,
  ComputerUseBrowserProfile,
  ComputerUseCapabilityDeclaration,
  ComputerUseCapabilityKind,
  ComputerUseCheck,
  ComputerUseDesktopEnvelope,
  ComputerUseEscalationRecord,
  ComputerUseMode,
  ComputerUseModeContext,
  ComputerUseObservationEvidence,
  ComputerUseObservationRecord,
  ComputerUseOperationRecord,
  ComputerUsePolicyEvidence,
  ComputerUseQualityConfidence,
  ComputerUseRedactionClass,
  ComputerUseRetentionClass,
  ComputerUseRouteEvidence,
  ComputerUseRouteStage,
  ComputerUseSessionRecord,
  ComputerUseSessionRequest,
  ComputerUseSessionStatus,
  ComputerUseSideEffectClass,
  ComputerUseTaskKind,
  ComputerUseTerminalPolicy,
  ComputerUseTrajectoryEntry,
} from "./domain/computer-use";
import {
  ACTION_OBSERVATION_TYPES,
  ACTION_SIDE_EFFECTS,
  AMBIENT_HOST_INHERITANCE,
  BROWSER_COOKIE_JAR_POLICY,
  COMPUTER_USE_ACTION_STATUSES,
  COMPUTER_USE_DESKTOP_GRANTS,
  COMPUTER_USE_MODES,
  COMPUTER_USE_OBSERVATION_TYPES,
  COMPUTER_USE_OPERATION_KINDS,
  COMPUTER_USE_OPERATION_STATUSES,
  COMPUTER_USE_QUALITY_MAX,
  COMPUTER_USE_QUALITY_MIN,
  COMPUTER_USE_REDACTION_CLASSES,
  COMPUTER_USE_RETENTION_CLASSES,
  COMPUTER_USE_SESSION_STATUSES,
  COMPUTER_USE_SESSION_TRANSITIONS,
  COMPUTER_USE_SIDE_EFFECT_CLASSES,
  canonicalComputerUseJson,
  computerUseActionDispatchKey,
  computerUseBudgetReleaseKey,
  computerUseBudgetReserveKey,
  computerUseBudgetSettleKey,
  computerUseEnvOpenKey,
  computerUseEscalationKey,
  computerUseObservationDigest,
  computerUseSessionCreateKey,
  computerUseSessionFingerprint,
  computerUseTerminationKey,
  DESKTOP_ACTION_GRANTS,
  MODE_ACTION_VOCABULARIES,
  nextComputerUseMode,
  priorComputerUseModes,
  serializeObservationEvidence,
  TERMINAL_COMPUTER_USE_SESSION_STATUSES,
  validateComputerUseCapability,
  validateComputerUseSessionRequest,
} from "./domain/computer-use";
import type {
  ToolDenialClass,
  ToolFailureClass,
  ToolInvocationRecord,
  ToolInvocationRequest,
  ToolInvocationResult,
  ToolInvocationStatus,
  ToolOutcomeClass,
  ToolPolicyEvidence,
} from "./domain/invocation";
import {
  TOOL_DENIAL_CLASSES,
  TOOL_FAILURE_CLASSES,
  TOOL_INVOCATION_STATUSES,
  TOOL_OUTCOME_CLASSES,
} from "./domain/invocation";
import type { SchemaCheck, ToolFieldSchema, ToolFieldSpec, ToolFieldType } from "./domain/schema";
import { checkAgainstSchema, TOOL_FIELD_TYPES } from "./domain/schema";
import type {
  SynthesisLanguage,
  SynthesisRejection,
  SynthesisRejectionPhase,
  SynthesisRequest,
  SynthesisRuntimeTests,
  SynthesisStaticValidation,
  SynthesisTestCase,
  SynthesisTestCaseEvidence,
  SynthesizedProgramRecord,
  SynthesizedProgramStatus,
  SynthesizedToolFact,
  ToolFactOrigin,
} from "./domain/synthesis";
import {
  canonicalOutputJson,
  canonicalSynthesisJson,
  parseSynthesizedOutput,
  SYNTHESIS_FORBIDDEN_SOURCE_TOKENS,
  SYNTHESIS_INPUT_JSON_MAX,
  SYNTHESIS_KEY_PATTERN,
  SYNTHESIS_LANGUAGES,
  SYNTHESIS_SOURCE_BOUNDS,
  SYNTHESIS_TEST_CASE_BOUNDS,
  SYNTHESIZED_PROGRAM_STATUSES,
  SYNTHESIZED_PROGRAM_TRANSITIONS,
  SYNTHESIZED_TOOL_ID_PATTERN,
  scanLanguageSubset,
  synthesisSubmissionFingerprint,
  TERMINAL_SYNTHESIZED_STATUSES,
  TOOL_FACT_ORIGINS,
  validateSynthesisRequest,
} from "./domain/synthesis";
import type {
  ToolCapabilityIdentity,
  ToolContract,
  ToolCostExpectations,
  ToolEgressMode,
  ToolEvidenceContract,
  ToolExecutionRequirements,
  ToolNetworkRequirements,
  ToolSecretAccessMode,
  ToolSecretRequirements,
  ToolSideEffectClass,
} from "./domain/tool";
import {
  TOOL_EGRESS_MODES,
  TOOL_SECRET_ACCESS_MODES,
  TOOL_SIDE_EFFECT_CLASSES,
  validateToolContract,
} from "./domain/tool";
import type {
  ComputerUseCapabilityGate,
  ComputerUseCapabilityGateDecision,
  ComputerUseCapabilityGateRequest,
  ComputerUsePolicyAdmission,
  ComputerUsePolicyAdmissionDecision,
  ComputerUsePolicyAdmissionRequest,
  ComputerUseSecretMediation,
  ComputerUseSecretMediationOutcome,
  ComputerUseSecretMediationRequest,
} from "./ports/computer-use-admission";
import type {
  ComputerUseEnvironment,
  ComputerUseEnvironmentActionRequest,
  ComputerUseEnvironmentActionResult,
  ComputerUseEnvironmentActivityEntry,
  ComputerUseEnvironmentCloseRequest,
  ComputerUseEnvironmentContextState,
  ComputerUseEnvironmentFailure,
  ComputerUseEnvironmentObservationResult,
  ComputerUseEnvironmentObserveRequest,
  ComputerUseEnvironmentOpenRequest,
  ComputerUseEnvironmentOpenResult,
  ComputerUseObservationFrame,
} from "./ports/computer-use-environment";
import type { ComputerUseCapabilityRegistry, RegisterOutcome } from "./ports/computer-use-registry";
import type {
  ComputerUseActionFinalizeInput,
  ComputerUseActionInsertInput,
  ComputerUseActionInsertOutcome,
  ComputerUseActionLedgerBinding,
  ComputerUseEscalationInsertInput,
  ComputerUseEscalationInsertOutcome,
  ComputerUseObservationInsertInput,
  ComputerUseObservationInsertOutcome,
  ComputerUseOperationBeginInput,
  ComputerUseOperationBeginOutcome,
  ComputerUseSessionInsertInput,
  ComputerUseSessionInsertOutcome,
  ComputerUseSessionMutationOutcome,
  ComputerUseSessionPatch,
  ComputerUseSessionStatusMutation,
  ComputerUseStore,
} from "./ports/computer-use-store";
import type {
  ComputerUseTerminalDispatch,
  ComputerUseTerminalExecutor,
  ComputerUseTerminalRun,
} from "./ports/computer-use-terminal";
import type {
  DeterministicReplacementDispatch,
  DeterministicReplacementExecutor,
  DeterministicReplacementRun,
} from "./ports/deterministic-replacement-executor";
import type {
  ExecutionLedger,
  LedgerStepEvent,
  LedgerStepEventOutcome,
} from "./ports/execution-ledger";
import type { SynthesizedToolAdapterFactory } from "./ports/synthesis-adapter-factory";
import type {
  SynthesisSandboxDispatch,
  SynthesisSandboxExecutor,
  SynthesisSandboxResult,
} from "./ports/synthesis-sandbox";
import type {
  SynthesisInsertInput,
  SynthesisInsertOutcome,
  SynthesisStore,
  SynthesisTransitionInput,
} from "./ports/synthesis-store";
import type {
  ToolAdapter,
  ToolDispatch,
  ToolDispatchContext,
  ToolObservation,
} from "./ports/tool-adapter";
import type {
  ToolAdmission,
  ToolAdmissionDecision,
  ToolAdmissionRequest,
} from "./ports/tool-admission";
import type { ToolCapabilityResolution } from "./ports/tool-capability-gate";
import type {
  BindLedgerSequenceInput,
  ClaimDispatchingInput,
  ClaimOutcome,
  RecordDeniedInput,
  RecordOutcomeInput,
  ToolInvocationStore,
} from "./ports/tool-invocation-store";
import type { RegisteredTool, RegisterToolOutcome, ToolRegistry } from "./ports/tool-registry";

export const moduleDescriptor: ModuleDescriptor = { id: "tools" };

// Adapters are re-exported for composition roots (the WORK-003/005/007
// precedent: factories and provider-neutral adapters cross the barrel;
// provider SDK types never do).
export {
  BUILT_IN_TOOLS,
  CALCULATOR_CONTRACT,
  calculatorAdapter,
  confinementCheck,
  createComputerUseCapabilityGate,
  createConnectionComputerUseSecretMediation,
  createDeterministicReplacementExecutor,
  createExecutionLedgerAdapter,
  createPolicyComputerUseAdmission,
  createPolicyToolAdmission,
  createSandboxComputerUseTerminal,
  createSimulatedComputerUseEnvironment,
  createSimulatedComputerUseHostWorld,
  createSynthesisSandboxExecutor,
  createSynthesizedAdapterFactory,
  createToolCapabilityGate,
  DETERMINISTIC_INPUT_ENV,
  InMemoryComputerUseRegistry,
  InMemoryComputerUseStore,
  InMemorySynthesisStore,
  registerComputerUseCapability,
  replacementConfinementCheck,
  SCHEMA_VALIDATOR_CONTRACT,
  SEED_BUILT_IN_TOOL_FACTS,
  SimulatedComputerUseEnvironment,
  SqlComputerUseStore,
  SqlSynthesisStore,
  SqlToolInvocationStore,
  SYNTH_INPUT_ENV,
  schemaValidatorAdapter,
  terminalConfinementCheck,
} from "./adapters";
export { isToolFieldSchema } from "./domain/schema";
// Domain: the provider-neutral tool contract (acceptance criterion 1).
// Domain: tool field schemas (input/output shape contracts).
// Domain: the invocation journal vocabulary (outcome/failure/denial classes).
// Application: the tool registry (tool admission) + the governed runtime.
// Ports: adapter, registry, admission, capability gate, store, ledger.
export type {
  AmbientHostInheritance,
  BindLedgerSequenceInput,
  ClaimDispatchingInput,
  ClaimOutcome,
  ComputerUseActionDispatchResult,
  ComputerUseActionFinalizeInput,
  ComputerUseActionInsertInput,
  ComputerUseActionInsertOutcome,
  ComputerUseActionLedgerBinding,
  ComputerUseActionRecord,
  ComputerUseActionRequest,
  ComputerUseActionStatus,
  ComputerUseActionType,
  ComputerUseActor,
  ComputerUseAdmissionSnapshot,
  ComputerUseBrowserProfile,
  ComputerUseCapabilityDeclaration,
  ComputerUseCapabilityGate,
  ComputerUseCapabilityGateDecision,
  ComputerUseCapabilityGateRequest,
  ComputerUseCapabilityKind,
  ComputerUseCapabilityRegistry,
  ComputerUseCheck,
  ComputerUseDesktopEnvelope,
  ComputerUseEnvironment,
  ComputerUseEnvironmentActionRequest,
  ComputerUseEnvironmentActionResult,
  ComputerUseEnvironmentActivityEntry,
  ComputerUseEnvironmentCloseRequest,
  ComputerUseEnvironmentContextState,
  ComputerUseEnvironmentFailure,
  ComputerUseEnvironmentObservationResult,
  ComputerUseEnvironmentObserveRequest,
  ComputerUseEnvironmentOpenRequest,
  ComputerUseEnvironmentOpenResult,
  ComputerUseEscalationInsertInput,
  ComputerUseEscalationInsertOutcome,
  ComputerUseEscalationRecord,
  ComputerUseEscalationRequest,
  ComputerUseMode,
  ComputerUseModeContext,
  ComputerUseObservationEvidence,
  ComputerUseObservationFrame,
  ComputerUseObservationInsertInput,
  ComputerUseObservationInsertOutcome,
  ComputerUseObservationRecord,
  ComputerUseOperationBeginInput,
  ComputerUseOperationBeginOutcome,
  ComputerUseOperationRecord,
  ComputerUsePolicyAdmission,
  ComputerUsePolicyAdmissionDecision,
  ComputerUsePolicyAdmissionRequest,
  ComputerUsePolicyEvidence,
  ComputerUseQualityConfidence,
  ComputerUseRedactionClass,
  ComputerUseRetentionClass,
  ComputerUseRouteEvidence,
  ComputerUseRouteStage,
  ComputerUseSecretMediation,
  ComputerUseSecretMediationOutcome,
  ComputerUseSecretMediationRequest,
  ComputerUseService,
  ComputerUseServiceDeps,
  ComputerUseSessionInsertInput,
  ComputerUseSessionInsertOutcome,
  ComputerUseSessionMutationOutcome,
  ComputerUseSessionPatch,
  ComputerUseSessionReceipt,
  ComputerUseSessionRecord,
  ComputerUseSessionRequest,
  ComputerUseSessionStatus,
  ComputerUseSessionStatusMutation,
  ComputerUseSideEffectClass,
  ComputerUseStore,
  ComputerUseTaskKind,
  ComputerUseTerminalDispatch,
  ComputerUseTerminalExecutor,
  ComputerUseTerminalPolicy,
  ComputerUseTerminalRun,
  ComputerUseTrajectory,
  ComputerUseTrajectoryEntry,
  DeterministicReplacementDispatch,
  DeterministicReplacementExecutor,
  DeterministicReplacementRun,
  ExecutionLedger,
  LedgerStepEvent,
  LedgerStepEventOutcome,
  RecordDeniedInput,
  RecordOutcomeInput,
  RegisteredTool,
  RegisterOutcome,
  RegisterToolOutcome,
  SchemaCheck,
  SubmitProgramOutcome,
  SynthesisActor,
  SynthesisInsertInput,
  SynthesisInsertOutcome,
  SynthesisLanguage,
  SynthesisRejection,
  SynthesisRejectionPhase,
  SynthesisRequest,
  SynthesisRuntimeTests,
  SynthesisSandboxDispatch,
  SynthesisSandboxExecutor,
  SynthesisSandboxResult,
  SynthesisService,
  SynthesisServiceDeps,
  SynthesisStaticValidation,
  SynthesisStore,
  SynthesisTestCase,
  SynthesisTestCaseEvidence,
  SynthesisTransitionInput,
  SynthesizedProgramRecord,
  SynthesizedProgramStatus,
  SynthesizedToolAdapterFactory,
  SynthesizedToolFact,
  ToolAdapter,
  ToolAdmission,
  ToolAdmissionDecision,
  ToolAdmissionRequest,
  ToolCapabilityIdentity,
  ToolCapabilityResolution,
  ToolContract,
  ToolCostExpectations,
  ToolDenialClass,
  ToolDispatch,
  ToolDispatchContext,
  ToolEgressMode,
  ToolEvidenceContract,
  ToolExecutionRequirements,
  ToolFactOrigin,
  ToolFailureClass,
  ToolFieldSchema,
  ToolFieldSpec,
  ToolFieldType,
  ToolInvocationRecord,
  ToolInvocationRequest,
  ToolInvocationResult,
  ToolInvocationStatus,
  ToolInvocationStore,
  ToolNetworkRequirements,
  ToolObservation,
  ToolOutcomeClass,
  ToolPolicyEvidence,
  ToolRegistry,
  ToolRuntime,
  ToolRuntimeDeps,
  ToolSecretAccessMode,
  ToolSecretRequirements,
  ToolSideEffectClass,
};
export {
  ACTION_OBSERVATION_TYPES,
  ACTION_SIDE_EFFECTS,
  AMBIENT_HOST_INHERITANCE,
  BROWSER_COOKIE_JAR_POLICY,
  COMPUTER_USE_ACTION_STATUSES,
  COMPUTER_USE_DESKTOP_GRANTS,
  COMPUTER_USE_INPUT_MAX,
  COMPUTER_USE_MODES,
  COMPUTER_USE_OBSERVATION_CONTENT_MAX,
  COMPUTER_USE_OBSERVATION_TYPES,
  COMPUTER_USE_OPERATION_KINDS,
  COMPUTER_USE_OPERATION_STATUSES,
  COMPUTER_USE_QUALITY_MAX,
  COMPUTER_USE_QUALITY_MIN,
  COMPUTER_USE_REDACTION_CLASSES,
  COMPUTER_USE_RETENTION_CLASSES,
  COMPUTER_USE_SESSION_STATUSES,
  COMPUTER_USE_SESSION_TRANSITIONS,
  COMPUTER_USE_SIDE_EFFECT_CLASSES,
  canonicalComputerUseJson,
  canonicalOutputJson,
  canonicalSynthesisJson,
  checkAgainstSchema,
  computerUseActionDispatchKey,
  computerUseBudgetReleaseKey,
  computerUseBudgetReserveKey,
  computerUseBudgetSettleKey,
  computerUseEnvOpenKey,
  computerUseEscalationKey,
  computerUseObservationDigest,
  computerUseSessionCreateKey,
  computerUseSessionFingerprint,
  computerUseTerminationKey,
  createComputerUseService,
  createSynthesisService,
  createToolRegistry,
  createToolRuntime,
  DESKTOP_ACTION_GRANTS,
  MODE_ACTION_VOCABULARIES,
  nextComputerUseMode,
  parseSynthesizedOutput,
  priorComputerUseModes,
  SYNTHESIS_DEFAULT_TIMEOUT_MS,
  SYNTHESIS_FORBIDDEN_SOURCE_TOKENS,
  SYNTHESIS_INPUT_JSON_MAX,
  SYNTHESIS_KEY_PATTERN,
  SYNTHESIS_LANGUAGES,
  SYNTHESIS_SOURCE_BOUNDS,
  SYNTHESIS_TEST_CASE_BOUNDS,
  SYNTHESIZED_PROGRAM_STATUSES,
  SYNTHESIZED_PROGRAM_TRANSITIONS,
  SYNTHESIZED_TOOL_ID_PATTERN,
  scanLanguageSubset,
  serializeObservationEvidence,
  synthesisSubmissionFingerprint,
  TERMINAL_COMPUTER_USE_SESSION_STATUSES,
  TERMINAL_SYNTHESIZED_STATUSES,
  TOOL_DENIAL_CLASSES,
  TOOL_EGRESS_MODES,
  TOOL_FACT_ORIGINS,
  TOOL_FAILURE_CLASSES,
  TOOL_FIELD_TYPES,
  TOOL_INVOCATION_STATUSES,
  TOOL_OUTCOME_CLASSES,
  TOOL_SECRET_ACCESS_MODES,
  TOOL_SIDE_EFFECT_CLASSES,
  toolRequestFingerprint,
  validateComputerUseCapability,
  validateComputerUseSessionRequest,
  validateSynthesisRequest,
  validateToolContract,
};
