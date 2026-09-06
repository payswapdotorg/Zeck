/**
 * The provider-neutral release-control port (WORK-047 / D-06).
 *
 * DURABLE RELEASE AUTHORITY LIVES IN POSTGRESQL — the authoritative
 * relational store — NEVER in CI/CD, provider control planes or
 * dashboards (invariant 2). CI/CD and the deploy tooling are
 * operational MECHANISMS that drive this store through the governed
 * paths; the release ledger is append-only where evidence is
 * concerned and immutable where attribution is concerned.
 *
 * THE RELEASE IDENTITY (the RELEASE-IDENTITY checkpoint): a release
 * is the promotable unit — the exact Git revision plus the manifest
 * digest (the repository-resident deployment manifest set at that
 * revision). Its id is content-addressed and deterministic: two
 * operators at the same revision compute the same release id. A
 * release that is not tied to an exact 40-hex commit is
 * unrepresentable (fail closed at the store boundary).
 *
 * THE PROMOTION LADDER (the PROMOTION-GATES checkpoint): local → ci
 * → preview → staging → production (environments.json
 * promotionOrder; ci is a check phase, not a hosting environment).
 * Promotion into a phase requires the phase's gate evidence —
 * validation, migration, health, smoke and the phase-specific
 * requirements — recorded as append-only gate results. Activation of
 * a hosting environment's deployment additionally requires a
 * recorded `promoted` decision: the pointer never moves without the
 * journal.
 *
 * ROLLBACK (the ROLLBACK-SAFETY checkpoint): a rollback changes the
 * ACTIVE DEPLOYMENT POINTER of one environment and appends a
 * rollback event — nothing else. Durable execution/business state is
 * untouched by construction: the store's statements address the
 * release_control schema only (proven by the isolation tests).
 *
 * The store is the ONLY writer of the release_control schema
 * (migration 0029); every governed mutation is idempotent or
 * append-only, with typed refusals (never a silent default).
 */

// ---------------------------------------------------------------------------
// Vocabulary (closed, pinned by the architecture suite)
// ---------------------------------------------------------------------------

/** The promotion ladder phases (environments.json promotionOrder). */
export const RELEASE_PHASES = ["local", "ci", "preview", "staging", "production"] as const;
export type ReleasePhase = (typeof RELEASE_PHASES)[number];

/** The identity-bearing hosting environments (ci is a check phase). */
export const HOSTING_ENVIRONMENTS = ["local", "preview", "staging", "production"] as const;
export type HostingEnvironment = (typeof HOSTING_ENVIRONMENTS)[number];

export function isReleasePhase(value: string): value is ReleasePhase {
  return (RELEASE_PHASES as readonly string[]).includes(value);
}

export function isHostingEnvironment(value: string): value is HostingEnvironment {
  return (HOSTING_ENVIRONMENTS as readonly string[]).includes(value);
}

export const GATE_STATUSES = ["passed", "failed"] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];

export const GATE_EVIDENCE_SOURCES = ["tool-run", "external-attach"] as const;
export type GateEvidenceSource = (typeof GATE_EVIDENCE_SOURCES)[number];

export const PROMOTION_DECISIONS = ["promoted", "refused"] as const;
export type PromotionDecision = (typeof PROMOTION_DECISIONS)[number];

// ---------------------------------------------------------------------------
// Records (the ledger shapes)
// ---------------------------------------------------------------------------

export interface ReleaseRecord {
  /** Content-addressed: sha256(["zeck-release-v1", gitRevision, manifestDigest]). */
  readonly releaseId: string;
  /** The EXACT 40-hex Git revision (immutable attribution). */
  readonly gitRevision: string;
  /** sha256 over the manifest sources at that revision. */
  readonly manifestDigest: string;
  readonly recordedAt: string;
  readonly recordedBy: string;
}

export interface EnvironmentDeploymentRecord {
  readonly releaseId: string;
  /** The hosting environment the deployment identity is bound to. */
  readonly environment: HostingEnvironment;
  /** The D-01 deployment identity id for this release+environment. */
  readonly deploymentIdentityId: string;
  readonly resourceDigest: string;
  readonly recordedAt: string;
  readonly recordedBy: string;
}

export interface GateResultRecord {
  readonly releaseId: string;
  /** The phase the gate evidence applies to (incl. the ci check phase). */
  readonly environment: ReleasePhase;
  readonly gateKind: string;
  readonly attempt: number;
  readonly status: GateStatus;
  /** sha256 over the canonical evidence payload (bounded). */
  readonly evidenceDigest: string;
  /** Bounded human/机器-readable evidence summary (≤ 4096 chars). */
  readonly evidenceDetail: string;
  readonly source: GateEvidenceSource;
  readonly recordedAt: string;
  readonly recordedBy: string;
}

export interface PromotionDecisionRecord {
  readonly id: string;
  readonly releaseId: string;
  readonly fromPhase: ReleasePhase | "none";
  readonly toPhase: ReleasePhase;
  readonly decision: PromotionDecision;
  readonly reason: string;
  readonly actor: string;
  readonly decidedAt: string;
}

export interface RollbackRecord {
  readonly id: string;
  readonly environment: HostingEnvironment;
  readonly fromReleaseId: string;
  readonly toReleaseId: string;
  readonly reason: string;
  readonly actor: string;
  readonly recordedAt: string;
}

export interface ActiveDeploymentRecord {
  readonly environment: HostingEnvironment;
  readonly releaseId: string;
  readonly deploymentIdentityId: string;
  readonly activatedAt: string;
  readonly activatedBy: string;
}

export interface ReleaseInspection {
  readonly release: ReleaseRecord | null;
  readonly environmentDeployments: readonly EnvironmentDeploymentRecord[];
  readonly effectiveGates: readonly GateResultRecord[];
  readonly promotions: readonly PromotionDecisionRecord[];
  readonly rollbacks: readonly RollbackRecord[];
  readonly activeDeployments: readonly ActiveDeploymentRecord[];
}

// ---------------------------------------------------------------------------
// The store port
// ---------------------------------------------------------------------------

export interface ReleaseControlStore {
  /** Idempotent release recording (exact-revision, content-addressed). */
  readonly recordRelease: (input: {
    readonly gitRevision: string;
    readonly manifestDigest: string;
    readonly actor: string;
  }) => Promise<ReleaseRecord>;

  /** Idempotent identity binding per (release, hosting environment). */
  readonly recordEnvironmentDeployment: (input: {
    readonly releaseId: string;
    readonly environment: HostingEnvironment;
    readonly deploymentIdentityId: string;
    readonly resourceDigest: string;
    readonly actor: string;
  }) => Promise<EnvironmentDeploymentRecord>;

  /** Append-only gate evidence (the attempt ordinal is assigned here). */
  readonly recordGateResult: (input: {
    readonly releaseId: string;
    readonly environment: ReleasePhase;
    readonly gateKind: string;
    readonly status: GateStatus;
    readonly evidenceDigest: string;
    readonly evidenceDetail: string;
    readonly source: GateEvidenceSource;
    readonly actor: string;
  }) => Promise<GateResultRecord>;

  /** The effective (latest-attempt) gate results for one phase. */
  readonly effectiveGateResults: (
    releaseId: string,
    environment: ReleasePhase,
  ) => Promise<readonly GateResultRecord[]>;

  /** Append-only promotion journal (refusals are evidence too). */
  readonly recordPromotionDecision: (input: {
    readonly releaseId: string;
    readonly fromPhase: ReleasePhase | "none";
    readonly toPhase: ReleasePhase;
    readonly decision: PromotionDecision;
    readonly reason: string;
    readonly actor: string;
  }) => Promise<PromotionDecisionRecord>;

  /** The governed pointer activation (policy-enforced, journal-linked). */
  readonly activate: (input: {
    readonly environment: HostingEnvironment;
    readonly releaseId: string;
    readonly requiredGates: readonly string[];
    readonly actor: string;
  }) => Promise<ActiveDeploymentRecord>;

  /** The governed rollback (append-only event + pointer flip; release_control only). */
  readonly rollback: (input: {
    readonly environment: HostingEnvironment;
    readonly toReleaseId: string;
    readonly requiredGates: readonly string[];
    readonly reason: string;
    readonly actor: string;
  }) => Promise<ActiveDeploymentRecord>;

  /** The active deployment of one environment (or null). */
  readonly activeDeployment: (
    environment: HostingEnvironment,
  ) => Promise<ActiveDeploymentRecord | null>;

  /** Full inspection of the release ledger (all environments, or one). */
  readonly inspect: (environment?: HostingEnvironment) => Promise<ReleaseInspection>;

  /** Inspection scoped to one release. */
  readonly inspectRelease: (releaseId: string) => Promise<ReleaseInspection>;
}

// ---------------------------------------------------------------------------
// Typed refusals (fail closed, never silent)
// ---------------------------------------------------------------------------

export class ReleaseControlError extends Error {
  readonly refusal: ReleaseRefusal;
  constructor(refusal: ReleaseRefusal) {
    super(refusal.message);
    this.name = "ReleaseControlError";
    this.refusal = refusal;
  }
}

export type ReleaseRefusal =
  | { readonly kind: "invalid-revision"; readonly message: string }
  | { readonly kind: "unknown-release"; readonly message: string }
  | { readonly kind: "identity-mismatch"; readonly message: string }
  | {
      readonly kind: "gates-missing";
      readonly message: string;
      readonly missing: readonly string[];
    }
  | { readonly kind: "no-journal-entry"; readonly message: string }
  | { readonly kind: "no-active-deployment"; readonly message: string }
  | { readonly kind: "same-release"; readonly message: string }
  | { readonly kind: "not-deployed"; readonly message: string };

// ---------------------------------------------------------------------------
// The deterministic release identity
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

export const RELEASE_IDENTITY_SCHEMA_VERSION = 1;

const GIT_REVISION_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The content-addressed release id: deterministic over the exact Git
 * revision and the manifest digest. Two operators at the same
 * revision compute the identical id — the auditable release
 * attribution anchor.
 */
export function releaseIdentityId(gitRevision: string, manifestDigest: string): string {
  return createHash("sha256")
    .update(
      [`zeck-release-v${RELEASE_IDENTITY_SCHEMA_VERSION}`, gitRevision, manifestDigest].join("\n"),
      "utf8",
    )
    .digest("hex");
}

/** sha256 hex of a canonical evidence payload (the digest contract). */
export function evidenceDigestOf(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** Fail-closed validation of the release identity inputs. */
export function validateReleaseIdentityInputs(
  gitRevision: string,
  manifestDigest: string,
): { readonly valid: boolean; readonly message?: string } {
  if (!GIT_REVISION_PATTERN.test(gitRevision)) {
    return {
      valid: false,
      message: `a release must be tied to an exact 40-hex Git commit (got: "${gitRevision.slice(0, 60)}")`,
    };
  }
  if (!SHA256_HEX_PATTERN.test(manifestDigest)) {
    return {
      valid: false,
      message: `the release manifest digest must be 64-hex sha256 (got: "${manifestDigest.slice(0, 60)}")`,
    };
  }
  return { valid: true };
}
