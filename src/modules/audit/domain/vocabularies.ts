/**
 * The closed vocabularies and bounds of the audit module (WORK-059 /
 * SEC-004 domain).
 *
 * COMPLETENESS IS HONEST (architecture invariant 5): the action-kind
 * vocabulary below is the EXACT declared observation scope of this
 * Work Order — the three existing seams (execution lifecycle
 * transitions, policy admission decisions, optimization decision
 * records) plus the audit plane's own governed procedures (export,
 * legal hold, retention policy, governed purge). Every governed
 * action kind DECLARED here is recorded when its seam is wired; every
 * governed action kind NOT declared here is an explicit NOT-recorded
 * boundary (budget reservations, model dispatches, tool invocations,
 * sandbox transitions, artifact writes, verification outcomes,
 * learning telemetry, release operations, workflow events) — recorded
 * in the evidence document, never silently implied.
 *
 * The vocabularies are frozen at the migration (CHECK-bound in
 * PostgreSQL) and duplicated here as the typed truth for validation;
 * the architecture tests keep both in sync.
 */

/** Observed governed action kinds (the declared completeness scope). */
export const AUDIT_ACTION_KINDS = [
  "execution.created",
  "execution.transitioned",
  "policy.decision",
  "decision.recorded",
  "audit.export-generated",
  "audit.legal-hold-placed",
  "audit.legal-hold-released",
  "retention.policy-adopted",
  "retention.purge-executed",
] as const;
export type AuditActionKind = (typeof AUDIT_ACTION_KINDS)[number];

/** Actor identity classes (the WHO). */
export const AUDIT_ACTOR_KINDS = [
  "human-principal",
  "service-principal",
  "system-procedure",
] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

/** Target identity classes (the WHAT'S TARGET). */
export const AUDIT_TARGET_KINDS = ["execution", "decision", "application"] as const;
export type AuditTargetKind = (typeof AUDIT_TARGET_KINDS)[number];

/**
 * The observation seams (the PROVENANCE surface): the EXISTING
 * authority seams the projection observes. The vocabulary names the
 * seam, never a provider — and no seam in this list authorizes
 * anything: the projection observes, it never decides.
 */
export const AUDIT_SEAMS = [
  "executions.create",
  "executions.transition",
  "policies.admission",
  "optimization-decisions",
  "audit.export",
  "audit.legal-hold",
  "retention.policy",
  "retention.purge",
] as const;
export type AuditSeam = (typeof AUDIT_SEAMS)[number];

/** Legal-hold scopes: an application-wide hold or a single-target hold. */
export const AUDIT_HOLD_SCOPES = ["application", "target"] as const;
export type AuditHoldScope = (typeof AUDIT_HOLD_SCOPES)[number];

/**
 * Bounds for audit content. Bounded by construction: audit detail is
 * reference-typed evidence (identifiers, codes, small structured
 * facts) — never a payload dump.
 */
export const AUDIT_BOUNDS = Object.freeze({
  /** Max actor-id / why / reason text length (characters). */
  actorIdMax: 128,
  whyMax: 500,
  reasonMax: 500,
  /** Max action-detail JSON size in bytes (canonical form). */
  detailMaxBytes: 4096,
  /** Max action-detail nesting depth. */
  detailMaxDepth: 6,
  /** Max keys per detail object level. */
  detailMaxKeys: 32,
  /** Max string value length inside detail (before redaction caps). */
  detailValueMax: 512,
  /** Max records carried by one compliance export. */
  exportRecordsMax: 200,
  /** Max purge-manifest entries carried by one compliance export. */
  exportManifestsMax: 200,
  /** Max records deleted by one governed purge batch. */
  purgeBatchMax: 500,
  /** Max retention horizon (days) — unbounded retention is unrepresentable. */
  retentionDaysMax: 3650,
  /** Max retention horizon lower bound (days). */
  retentionDaysMin: 1,
  /** Environment label bound. */
  environmentMax: 64,
  /** Bounded provenance/identity text. */
  targetIdMax: 256,
  sourceRecordIdMax: 256,
  commandMax: 128,
  operationKeyMax: 256,
});

/** The chain genesis digest (the predecessor of the first record). */
export const AUDIT_CHAIN_GENESIS = "0".repeat(64);
