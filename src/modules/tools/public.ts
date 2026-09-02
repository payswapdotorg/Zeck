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
  createDeterministicReplacementExecutor,
  createExecutionLedgerAdapter,
  createPolicyToolAdmission,
  createSynthesisSandboxExecutor,
  createSynthesizedAdapterFactory,
  createToolCapabilityGate,
  DETERMINISTIC_INPUT_ENV,
  InMemorySynthesisStore,
  replacementConfinementCheck,
  SCHEMA_VALIDATOR_CONTRACT,
  SEED_BUILT_IN_TOOL_FACTS,
  SqlSynthesisStore,
  SqlToolInvocationStore,
  SYNTH_INPUT_ENV,
  schemaValidatorAdapter,
} from "./adapters";
export { isToolFieldSchema } from "./domain/schema";
// Domain: the provider-neutral tool contract (acceptance criterion 1).
// Domain: tool field schemas (input/output shape contracts).
// Domain: the invocation journal vocabulary (outcome/failure/denial classes).
// Application: the tool registry (tool admission) + the governed runtime.
// Ports: adapter, registry, admission, capability gate, store, ledger.
export type {
  BindLedgerSequenceInput,
  ClaimDispatchingInput,
  ClaimOutcome,
  DeterministicReplacementDispatch,
  DeterministicReplacementExecutor,
  DeterministicReplacementRun,
  ExecutionLedger,
  LedgerStepEvent,
  LedgerStepEventOutcome,
  RecordDeniedInput,
  RecordOutcomeInput,
  RegisteredTool,
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
  canonicalOutputJson,
  canonicalSynthesisJson,
  checkAgainstSchema,
  createSynthesisService,
  createToolRegistry,
  createToolRuntime,
  parseSynthesizedOutput,
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
  synthesisSubmissionFingerprint,
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
  validateSynthesisRequest,
  validateToolContract,
};
