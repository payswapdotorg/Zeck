/**
 * Public contract barrel of the WorkflowOS integration (WORK-016).
 *
 * Integrations are adapters for external systems: `public.ts` is the only
 * supported import surface, `adapters/` owns external client
 * implementations (the only location allowed to import WorkflowOS or
 * framework SDKs — the dependency engine's `@workflowos/*` boundary), and
 * `internal/` is never imported from outside.
 *
 * WORK-016 exposes TWO provider-neutral contracts through this barrel:
 *
 *  1. THE WORKFLOWOS EXECUTION SUBMISSION ADAPTER (WOS-001..004) —
 *     WorkflowOS submits work through one provider-independent execution
 *     contract; WorkflowOS remains authoritative for its own workflow
 *     state (the integration holds NO WorkflowOS-state surface); Zeck
 *     returns receipts, artifacts and verification evidence as public-
 *     contract DATA — it never transitions WorkflowOS state.
 *
 *  2. THE BYOA INTEROP CONTRACT (AGT-007/ACP-005) — externally-built
 *     agents/frameworks become governed execution participants through
 *     provider-neutral adapters: registration consumes the WORK-011
 *     agent registry authority; the runtime wrapper implements the agents
 *     module's public `AgentProvider` port; every dispatch flows through
 *     the agents session service's admission chain (policy → capability
 *     → budget → execution → verification). No framework type crosses
 *     this barrel.
 *
 * AUTHORITY MAP (everything is consumed, nothing is duplicated):
 *   executions → the executions module's public service (the only write
 *   path and the only read path for execution state);
 *   agents → the WORK-011 registry (identity/versions/selections);
 *   policy/capability/budget/verification → their owning module
 *   authorities, consulted through the services above (this integration
 *   has NO admission, NO arbitration and NO verification logic).
 */

export const integrationId = "workflowos" as const;

export type WorkflowOsIntegrationId = typeof integrationId;

export type {
  ByoaInteropDeps,
  ByoaRegistrationOutcome,
  ByoaRegistrationRequest,
  WorkflowOsIntegrationDeps,
  WorkflowOsIntegrationService,
} from "./application";
export {
  createByoaAgentProvider,
  createWorkflowOsIntegrationService,
  registerByoaAgent,
  validateByoaRegistration,
} from "./application";
export type {
  AgentProvider,
  AgentRuntimeIdentity,
  AgentSessionObservation,
  AgentSessionTask,
  ByoaAgentProvider,
  ByoaExternalAgent,
  ByoaExternalDescriptor,
  IntegrationActor,
  SubmissionCheck,
  WorkflowOsArtifactReference,
  WorkflowOsEventReference,
  WorkflowOsEvidenceReceipt,
  WorkflowOsExternalProvenance,
  WorkflowOsSubmissionReceipt,
  WorkflowOsSubmissionRequest,
  WorkflowOsVerificationEvidence,
} from "./domain";
// Domain: the WorkflowOS submission contract + concept mapping.
// Domain: receipts/evidence (pure projections over public reads).
// Domain: the BYOA neutral contracts.
// Application: the submission/receipt service + the BYOA interop.
// Ports: the consumed authority seams.
export {
  BYOA_RUNTIME_KIND,
  buildEvidenceReceipt,
  buildSubmissionReceipt,
  isValidIntegrationIdempotencyKey,
  SUBMISSION_FORBIDDEN_KEYS,
  SUBMISSION_INPUT_KEYS,
  sanitizeFailureReason,
  submissionToExecutionInput,
  validateByoaDescriptor,
  validateSubmissionRequest,
  workflowosWorkRefOf,
} from "./domain";
export type { ByoaAgentsAuthority, WorkflowOsExecutionsAuthority } from "./ports";
