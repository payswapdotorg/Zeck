/**
 * Public contract barrel of the `policies` module.
 *
 * This file is the ONLY supported import surface for other modules and for
 * the API layer (`IMPLEMENTATION.md` §2, `spec/contracts.md` "Public
 * module rule"). Everything else under `src/modules/policies/` is private
 * to this module.
 *
 * WORK-007 introduces the policy authority (POL-001/002/003): the five-scope
 * precedence resolution (platform > application > user > task > execution),
 * the nine-dimension typed restriction vocabulary (cost, quality, latency,
 * provider/model, tool, network, secrets, autonomy, isolation), monotonic
 * tightening (a lower authority can never weaken a higher prohibition), and
 * the admission boundary — the executions `authorize` seam and the models
 * `DispatchAdmission` seam both consult THIS authority (no default-allow
 * exists anywhere; with no configured set every admission fails closed).
 * Every decision carries durable admission provenance (effective policy set
 * version + content hash + resolved restriction-set digest) which the
 * executions EventEnvelope ledger records.
 */

import type { ModuleDescriptor } from "../../shared/module";
import { createDispatchAdmission } from "./adapters/dispatch-admission";
import { createExecutionAuthorization } from "./adapters/execution-authorization";
import { InMemoryPolicyStore } from "./adapters/in-memory-policy-store";
import { nodePolicyHasher } from "./adapters/node-policy-hasher";
import type { PolicyAuthorityOptions } from "./application/policy-authority";
import { createPolicyAuthority } from "./application/policy-authority";
import type {
  DispatchFacts,
  ExecutionAdmissionFacts,
  FactDenial,
  FactsCheck,
} from "./domain/admission";
import { evaluateDispatchFacts, evaluateExecutionFacts } from "./domain/admission";
import {
  assertLearnedOutputFreeOfRestrictions,
  learnedOutputRestrictionViolations,
  RESTRICTION_DIMENSION_VOCABULARY,
  RESTRICTION_FIELD_VOCABULARY,
} from "./domain/learned-output-boundary";
import type {
  AutonomyMode,
  AutonomyRestriction,
  CostRestriction,
  EgressMode,
  IsolationLevel,
  IsolationRestriction,
  LatencyRestriction,
  NetworkRestriction,
  PolicyDenial,
  PolicyDimension,
  PolicyDocument,
  PolicyRequestContext,
  PolicyResolution,
  PolicyScope,
  PolicySelector,
  PolicySet,
  PolicySetIdentity,
  ProviderModelRestriction,
  QualityRestriction,
  RestrictionSet,
  SecretsRestriction,
  TighteningCheck,
  ToolRestriction,
  ValidationIssue,
  Weakening,
} from "./domain/policy";
import {
  AUTONOMY_MODES,
  canonicalPolicyJson,
  checkMonotonicTightening,
  DIMENSION_FIELD_ORDERS,
  documentApplies,
  EGRESS_MODES,
  ISOLATION_LEVELS,
  isEmptyRestrictionSet,
  POLICY_DIMENSIONS,
  POLICY_SCOPES,
  resolvePolicy,
  SECRET_ACCESS_MODES,
  scopeRank,
  tightenRestrictionSets,
  validatePolicySet,
} from "./domain/policy";
import type {
  PolicyAdmissionEvidence,
  PolicyAdmissionRequest,
  PolicyAdmissionResult,
  PolicyAuthority,
  PolicyDenialDetail,
  PolicyDispatchRequest,
  PolicyHasher,
  PolicyPublishOutcome,
  PolicySetRecord,
  PolicyStore,
} from "./ports/policy-authority";

export const moduleDescriptor: ModuleDescriptor = { id: "policies" };

export { FACT_LADDERS } from "./domain/admission";
// Domain: scope precedence + restriction vocabulary (POL-001/POL-002/POL-003).
// Domain: admission fact evaluation (the typed decision core).
// Application: the policy authority (publish arbitration + admission).
// Ports: store + hasher seams (WORK-005 store-port precedent).
// Adapters: node hasher, in-memory store, and the two REQUIRED seam
// implementations (executions authorize seam; models dispatch seam).
export type {
  AutonomyMode,
  AutonomyRestriction,
  CostRestriction,
  DispatchFacts,
  EgressMode,
  ExecutionAdmissionFacts,
  FactDenial,
  FactsCheck,
  IsolationLevel,
  IsolationRestriction,
  LatencyRestriction,
  NetworkRestriction,
  PolicyAdmissionEvidence,
  PolicyAdmissionRequest,
  PolicyAdmissionResult,
  PolicyAuthority,
  PolicyAuthorityOptions,
  PolicyDenial,
  PolicyDenialDetail,
  PolicyDimension,
  PolicyDispatchRequest,
  PolicyDocument,
  PolicyHasher,
  PolicyPublishOutcome,
  PolicyRequestContext,
  PolicyResolution,
  PolicyScope,
  PolicySelector,
  PolicySet,
  PolicySetIdentity,
  PolicySetRecord,
  PolicyStore,
  ProviderModelRestriction,
  QualityRestriction,
  RestrictionSet,
  SecretsRestriction,
  TighteningCheck,
  ToolRestriction,
  ValidationIssue,
  Weakening,
};
export {
  AUTONOMY_MODES,
  assertLearnedOutputFreeOfRestrictions,
  canonicalPolicyJson,
  checkMonotonicTightening,
  createDispatchAdmission,
  createExecutionAuthorization,
  createPolicyAuthority,
  DIMENSION_FIELD_ORDERS,
  documentApplies,
  EGRESS_MODES,
  evaluateDispatchFacts,
  evaluateExecutionFacts,
  InMemoryPolicyStore,
  ISOLATION_LEVELS,
  isEmptyRestrictionSet,
  learnedOutputRestrictionViolations,
  nodePolicyHasher,
  POLICY_DIMENSIONS,
  POLICY_SCOPES,
  RESTRICTION_DIMENSION_VOCABULARY,
  RESTRICTION_FIELD_VOCABULARY,
  resolvePolicy,
  SECRET_ACCESS_MODES,
  scopeRank,
  tightenRestrictionSets,
  validatePolicySet,
};
