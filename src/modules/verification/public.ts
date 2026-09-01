/**
 * Public contract barrel of the `verification` module.
 *
 * This file is the ONLY supported import surface for other modules and
 * for the API layer (`IMPLEMENTATION.md` §2, `spec/contracts.md` "Public
 * module rule"). Everything else under `src/modules/verification/` is
 * private to this module.
 *
 * WORK-013 introduces the verification AUTHORITY (VER-001…VER-004,
 * INT-005; `spec/architecture.md` §18): the independent evidence
 * authority over execution quality —
 *
 *  - the `VerificationResult` evidence record (PASS | FAIL |
 *    INCONCLUSIVE with mandatory evidence, criteria binding, evaluator
 *    identity/version, target revision binding, policy provenance and
 *    the full WHO/WHAT/WHEN/WHY/WITH-WHICH-EVIDENCE provenance chain);
 *    provider HTTP success, tool success and model self-certification
 *    can NEVER produce PASS (they are not verdicts — they are evidence
 *    at best);
 *  - the evaluator contracts: deterministic evaluators (schema,
 *    invariant, digest, exact-match, reference — the deterministic-first
 *    rule applied to verification itself), model-based evaluators
 *    (judgment adapters behind the provider-neutral ModelJudge port —
 *    never authorities, never policy, may honestly return
 *    INCONCLUSIVE) and the mediated human/user evaluation path
 *    (explicit, attributable, policy-authorized, provenance-preserving
 *    request/decision records — never a customer-domain state machine);
 *  - the governed evaluation flow: tenant/execution binding → REQUIRED
 *    policy admission → durable evaluation intent on the canonical
 *    executions ledger → deterministic-first evaluation → immutable
 *    results → conclusion (INCONCLUSIVE is never acceptance) →
 *    completion THROUGH the executions authority (`pass` bound to ≥1
 *    durable PASS result) or the replanning-boundary report (the
 *    PLANNER decides replan/escalation — the verifier reports);
 *  - candidate comparison: explicit, planner-gated
 *    (plannerAuthorization), criteria-bound, identity-preserving and
 *    INCONCLUSIVE under unresolved uncertainty — never a forced winner;
 *  - verification is substrate-neutral (ACR-003/ADR-0016): the target
 *    may be an execution output, plan revision, artifact, tool output,
 *    model output, structured record or comparison candidate.
 */

import type { ModuleDescriptor } from "../../shared/module";
import {
  createDeterministicEvaluatorBank,
  createDigestEvaluator,
  createExactMatchEvaluator,
  createInvariantEvaluator,
  createReferenceEvaluator,
  createSchemaEvaluator,
} from "./adapters/deterministic-evaluators";
import type { EconomicDeliveryEvidenceSource } from "./adapters/economic-delivery";
import {
  createEconomicDeliveryResolver,
  economicDeliveryFacts,
} from "./adapters/economic-delivery";
import {
  createExecutionLedgerAdapter,
  createExecutionTransitionAdapter,
} from "./adapters/execution-ledger";
import { InMemoryVerificationStore } from "./adapters/in-memory-verification-store";
import { createModelJudgeEvaluator } from "./adapters/model-judge-evaluator";
import { createPolicyVerificationAdmission } from "./adapters/policy-verification-admission";
import { SqlVerificationStore } from "./adapters/sql-verification-store";
import {
  createArtifactTargetResolver,
  createPlanRevisionResolver,
} from "./adapters/target-resolvers";
import type {
  CompareCandidatesInput,
  RequestHumanEvaluationInput,
  VerificationActor,
  VerificationService,
  VerificationServiceDeps,
  VerifyExecutionInput,
  VerifyTargetInput,
} from "./application/verification-service";
import { createVerificationService } from "./application/verification-service";
import type {
  CandidateComparisonRecord,
  ComparisonCandidate,
  PlannerAuthorization,
} from "./domain/comparison";
import { validateComparison, validatePlannerAuthorization } from "./domain/comparison";
import type {
  ReplanningDecision,
  UnmetCriterion,
  VerificationConclusion,
} from "./domain/conclusion";
import { deriveConclusion } from "./domain/conclusion";
import type {
  CriteriaDeclarationIssues,
  CriterionKind,
  VerificationCriteria,
} from "./domain/criteria";
import {
  CRITERION_KINDS,
  DETERMINISTIC_CRITERION_KINDS,
  isCriterionKind,
  isDeterministicCriterionKind,
  JUDGED_CRITERION_KINDS,
  validateCriteriaDeclaration,
} from "./domain/criteria";
import type {
  EvaluationContext,
  EvaluationOutcome,
  Evaluator,
  EvidenceBundle,
} from "./domain/evaluator";
import { selectEvaluator } from "./domain/evaluator";
import type {
  HumanDecisionInput,
  HumanDecisionStatus,
  HumanEvaluationRequestRecord,
} from "./domain/human";
import {
  HUMAN_DECISION_STATUSES,
  isHumanDecisionStatus,
  validateHumanDecision,
} from "./domain/human";
import type {
  EvaluatorIdentity,
  ResultProvenance,
  VerificationPolicyEvidence,
  VerificationResultRecord,
  VerificationStatus,
  VerificationTarget,
  VerificationTargetKind,
} from "./domain/result";
import {
  EVALUATOR_KINDS,
  isEvaluatorKind,
  isVerificationStatus,
  isVerificationTargetKind,
  VERIFICATION_STATUSES,
  VERIFICATION_TARGET_KINDS,
  validateResult,
} from "./domain/result";
import type { ModelJudge, ModelJudgeRequest, ModelJudgment } from "./ports/model-judge";
import type { ReplanningBoundary, ReplanningOutcomeInput } from "./ports/replanning-boundary";
import { replanningOutcomeOf } from "./ports/replanning-boundary";
import type {
  TargetResolution,
  TargetResolver,
  TargetResolverInput,
} from "./ports/target-resolvers";
import type {
  VerificationAdmission,
  VerificationAdmissionAction,
  VerificationAdmissionDecision,
  VerificationAdmissionRequest,
} from "./ports/verification-admission";
import { VERIFICATION_ADMISSION_ACTIONS } from "./ports/verification-admission";
import type {
  ExecutionPassInput,
  ExecutionTransitionInput,
  ExecutionTransitionOutcome,
  ExecutionTransitionPort,
  VerificationLedger,
  VerificationLedgerEvent,
  VerificationLedgerOutcome,
} from "./ports/verification-ledger";
import type {
  AnswerHumanRequestInput,
  AnswerHumanRequestOutcome,
  BindLedgerSequenceInput,
  ClaimEvaluationInput,
  ClaimEvaluationOutcome,
  CompleteEvaluationInput,
  EvaluationJournalRecord,
  EvaluationJournalStatus,
  VerificationStore,
} from "./ports/verification-store";

export const moduleDescriptor: ModuleDescriptor = { id: "verification" };

// Application: the governed verification service.
// Domain: criteria, result model, evaluator contracts, human path, comparison, conclusions.
// Ports: the outbound seams (admission, ledger, transitions, store, judge, boundary, resolvers).
// Adapters: policy admission over the real WORK-007 engine, execution ledger +
// transitions over the real executions service, SQL + in-memory stores, the
// deterministic evaluator bank, the model-judge evaluator, target resolvers.
export type {
  AnswerHumanRequestInput,
  AnswerHumanRequestOutcome,
  BindLedgerSequenceInput,
  CandidateComparisonRecord,
  ClaimEvaluationInput,
  ClaimEvaluationOutcome,
  CompareCandidatesInput,
  ComparisonCandidate,
  CompleteEvaluationInput,
  CriteriaDeclarationIssues,
  CriterionKind,
  EconomicDeliveryEvidenceSource,
  EvaluationContext,
  EvaluationJournalRecord,
  EvaluationJournalStatus,
  EvaluationOutcome,
  Evaluator,
  EvaluatorIdentity,
  EvidenceBundle,
  ExecutionPassInput,
  ExecutionTransitionInput,
  ExecutionTransitionOutcome,
  ExecutionTransitionPort,
  HumanDecisionInput,
  HumanDecisionStatus,
  HumanEvaluationRequestRecord,
  ModelJudge,
  ModelJudgeRequest,
  ModelJudgment,
  PlannerAuthorization,
  ReplanningBoundary,
  ReplanningDecision,
  ReplanningOutcomeInput,
  RequestHumanEvaluationInput,
  ResultProvenance,
  TargetResolution,
  TargetResolver,
  TargetResolverInput,
  UnmetCriterion,
  VerificationActor,
  VerificationAdmission,
  VerificationAdmissionAction,
  VerificationAdmissionDecision,
  VerificationAdmissionRequest,
  VerificationConclusion,
  VerificationCriteria,
  VerificationLedger,
  VerificationLedgerEvent,
  VerificationLedgerOutcome,
  VerificationPolicyEvidence,
  VerificationResultRecord,
  VerificationService,
  VerificationServiceDeps,
  VerificationStatus,
  VerificationStore,
  VerificationTarget,
  VerificationTargetKind,
  VerifyExecutionInput,
  VerifyTargetInput,
};
export {
  CRITERION_KINDS,
  createArtifactTargetResolver,
  createDeterministicEvaluatorBank,
  createDigestEvaluator,
  createEconomicDeliveryResolver,
  createExactMatchEvaluator,
  createExecutionLedgerAdapter,
  createExecutionTransitionAdapter,
  createInvariantEvaluator,
  createModelJudgeEvaluator,
  createPlanRevisionResolver,
  createPolicyVerificationAdmission,
  createReferenceEvaluator,
  createSchemaEvaluator,
  createVerificationService,
  DETERMINISTIC_CRITERION_KINDS,
  deriveConclusion,
  EVALUATOR_KINDS,
  economicDeliveryFacts,
  HUMAN_DECISION_STATUSES,
  InMemoryVerificationStore,
  isCriterionKind,
  isDeterministicCriterionKind,
  isEvaluatorKind,
  isHumanDecisionStatus,
  isVerificationStatus,
  isVerificationTargetKind,
  JUDGED_CRITERION_KINDS,
  replanningOutcomeOf,
  SqlVerificationStore,
  selectEvaluator,
  VERIFICATION_ADMISSION_ACTIONS,
  VERIFICATION_STATUSES,
  VERIFICATION_TARGET_KINDS,
  validateComparison,
  validateCriteriaDeclaration,
  validateHumanDecision,
  validatePlannerAuthorization,
  validateResult,
};
