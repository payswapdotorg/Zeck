/**
 * WorkflowOS integration domain barrel (WORK-016).
 */

export type {
  AgentProvider,
  AgentRuntimeIdentity,
  AgentSessionObservation,
  AgentSessionTask,
  ByoaAgentProvider,
  ByoaExternalAgent,
  ByoaExternalDescriptor,
} from "./byoa";
export {
  BYOA_RUNTIME_KIND,
  sanitizeFailureReason,
  validateByoaDescriptor,
} from "./byoa";
export type {
  WorkflowOsArtifactReference,
  WorkflowOsEventReference,
  WorkflowOsEvidenceReceipt,
  WorkflowOsSubmissionReceipt,
  WorkflowOsVerificationEvidence,
} from "./receipt";
export { buildEvidenceReceipt, buildSubmissionReceipt, workflowosWorkRefOf } from "./receipt";
export type {
  IntegrationActor,
  SubmissionCheck,
  WorkflowOsExternalProvenance,
  WorkflowOsSubmissionRequest,
} from "./submission";
export {
  isValidIntegrationIdempotencyKey,
  SUBMISSION_FORBIDDEN_KEYS,
  SUBMISSION_INPUT_KEYS,
  submissionToExecutionInput,
  validateSubmissionRequest,
} from "./submission";
