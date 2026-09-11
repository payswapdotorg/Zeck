/**
 * Public contract barrel of the `audit` module (WORK-059 / D-08 /
 * SEC-004 — advanced audit and compliance controls).
 *
 * This file is the ONLY supported import surface for other modules and
 * for the API layer (`IMPLEMENTATION.md` §2, `spec/contracts.md`
 * "Public module rule"). Everything else under `src/modules/audit/`
 * is private to this module.
 *
 * WORK-059 introduces the append-only AUDIT PROJECTION of governed
 * actions with the full who/what/when/why provenance chain, the
 * compliance evidence export, the bounded retention policy and the
 * legal hold:
 *
 *  - `AuditRecord`/`AuditSubmission`: typed append-only evidence —
 *    content-addressed identity (idempotent observation), hash-chained
 *    integrity (gapless per-application chain, tamper-detectable),
 *    DB-enforced immutability (migration 0031 rejects
 *    UPDATE/DELETE/TRUNCATE; the ONLY deletion is the governed
 *    retention purge, transaction-gated and evidenced);
 *  - observation happens through EXISTING seams only: the execution
 *    lifecycle (create/transition), the policy-admission seam and the
 *    optimization decision-record append seam — via the observer
 *    adapters below (the wrapped authorities remain the authorities;
 *    their outcomes pass through verbatim);
 *  - `ComplianceExport`: governed, bounded export with a verifiable
 *    chain proof (deterministic round-trip verification);
 *  - retention: bounded-by-construction policies (unbounded retention
 *    is unrepresentable) + the governed purge (the only deletion
 *    path, evidence + head update in one transaction);
 *  - legal hold: a hold on a scope suspends retention expiry; holds
 *    are themselves audited.
 *
 * THE NON-AUTHORITY BOUNDARY (audit is EVIDENCE, never authority —
 * architecture invariant 2): there is NO admission, authorization,
 * allow/deny, reservation or settlement surface anywhere in this
 * module. No code path consults the audit projection for
 * authorization (boundary-proven by the architecture tests; the
 * discrimination suite proves a weakened surface is rejected).
 * Authoritative state stays in the existing module stores — the audit
 * projection is a projection, never a second ledger.
 *
 * COMPLETENESS IS HONEST (invariant 5): the recorded action kinds are
 * exactly the closed `AUDIT_ACTION_KINDS` vocabulary; everything else
 * (budget reservations, model dispatches, tool invocations, sandbox
 * transitions, artifact writes, verification outcomes, learning
 * telemetry, release operations, workflow events) is an explicit
 * NOT-recorded boundary — see docs/work-items/WORK-059.md.
 */

import type { ModuleDescriptor } from "../../shared/module";

export const moduleDescriptor: ModuleDescriptor = { id: "audit" };

export type {
  AdmissionSeamLike,
  DecisionStoreSeamLike,
  ObservedDecisionRecord,
  ObservingAdmissionOptions,
  ObservingDecisionStoreOptions,
  ObservingExecutionServiceOptions,
} from "./adapters";
// Adapters are re-exported for composition roots (the WORK-003/005/007
// precedent: factories and provider-neutral adapters cross the barrel;
// provider SDK types never do).
export {
  createAuditNodeDigest,
  createObservingAdmission,
  createObservingDecisionStore,
  createObservingExecutionService,
  InMemoryAuditStore,
  SqlAuditStore,
} from "./adapters";
// Application services: the projection write path, the governed
// export, retention and legal holds.
export type {
  AuditService,
  AuditServiceOptions,
  ComplianceExportRequest,
  ComplianceExportService,
  ComplianceExportServiceOptions,
  LegalHoldService,
  LegalHoldServiceOptions,
  RetentionService,
  RetentionServiceOptions,
} from "./application";
export {
  createAuditService,
  createComplianceExportService,
  createLegalHoldService,
  createRetentionService,
} from "./application";
// Domain: the typed record, scrub gate, chain verification, export,
// holds and retention policies (provider-neutral, dependency-light).
export type {
  AdoptPolicyInput,
  AuditAction,
  AuditActionKind,
  AuditActor,
  AuditActorKind,
  AuditDigestPort,
  AuditPolicyContext,
  AuditProvenance,
  AuditRationale,
  AuditRecord,
  AuditRecordForm,
  AuditSeam,
  AuditSubmission,
  AuditTarget,
  AuditTargetKind,
  ChainVerification,
  ChainViolation,
  ChainViolationCode,
  ComplianceExport,
  ComplianceExportForm,
  ExportVerification,
  ExportViolation,
  ExportViolationCode,
  LegalHoldRecord,
  LegalHoldValidationError,
  PlaceHoldInput,
  PurgeManifest,
  PurgeManifestEntry,
  RetentionPolicyRecord,
  RetentionValidationError,
  ScrubResult,
} from "./domain";
export {
  AUDIT_ACTION_KINDS,
  AUDIT_ACTOR_KINDS,
  AUDIT_BOUNDS,
  AUDIT_CHAIN_GENESIS,
  AUDIT_HOLD_SCOPES,
  AUDIT_RECORD_INVARIANT_CODES,
  AUDIT_SEAMS,
  AUDIT_TARGET_KINDS,
  AuditValidationError,
  auditChainGenesis,
  auditIdentityForm,
  buildComplianceExport,
  CHAIN_VIOLATION_CODES,
  canonicalAuditJson,
  canonicalAuditRecordForm,
  chainLinkSubmission,
  computeAuditRecordDigest,
  computeAuditRecordId,
  computePurgeCutoff,
  isCanonicalizable,
  LegalHoldValidationError as LegalHoldValidationErrorValue,
  purgeManifestCommitment,
  purgeManifestOfRecord,
  RetentionValidationError as RetentionValidationErrorValue,
  scrubAuditDetail,
  scrubAuditText,
  validateAdoptPolicyInput,
  validateAuditRecord,
  validateAuditSubmission,
  validateLegalHoldRecord,
  validatePlaceHoldInput,
  validatePurgeManifest,
  validateRetentionPolicyRecord,
  verifyAuditChain,
  verifyComplianceExport,
} from "./domain";
// Ports: the provider-neutral durable contracts (append/read/governed
// purge only — evidence-shaped by construction).
export type {
  AuditAppendOutcome,
  AuditChainHead,
  AuditListOptions,
  AuditRecordStore,
  GovernedPurgeInput,
  GovernedPurgeOutcome,
  LegalHoldStore,
  RetentionPolicyStore,
} from "./ports";
export { AuditProjectionError, AuditStoreError } from "./ports";
