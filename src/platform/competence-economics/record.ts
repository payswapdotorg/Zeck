/**
 * Typed competence records (platform competence-economics plane;
 * WORK-056 / E1.1 — ADR-0019, ADR-0020 "verified competence" as a
 * selectable representation).
 *
 * COMPETENCE IS A SELECTABLE REPRESENTATION (the Work Order's
 * objective): a competence record is a TYPED, CONTENT-ADDRESSED
 * value carrying exactly the Work Order's four evidence loads —
 *
 *   the TRAJECTORY DIGEST (what successful work was observed),
 *   the APPLICABILITY BOUNDS (where the competence applies),
 *   the EXPECTED-OUTCOME EVIDENCE (what it achieved, with its
 *   verification binding and explicit basis),
 *   the COST (the foundation's OWN explicit-basis `CostClaim` —
 *   the exact evidence shape the WORK-049 selection machinery
 *   consumes, so a record is selectable as decision evidence
 *   through the EXISTING seams, never self-asserting).
 *
 * The discipline, fail-closed and total:
 *
 *  - records are CONTENT-ADDRESSED: `recordId` is the digest of the
 *    canonical record form (the same inputs always produce the
 *    byte-identical record — determinism, IDENTITY-IDEMPOTENCY),
 *    and a tampered value fails read-time validation with a typed
 *    identity-mismatch rejection;
 *  - records are TENANT-SCOPED through the merged context-economics
 *    plane's OWN key discipline (`TenantCacheScope` + the
 *    artifact-result key class — the "reusable artifacts/results"
 *    semantics; the tenant identity is a STRUCTURAL component of
 *    the derived corpus key, so cross-tenant reuse is
 *    unrepresentable — the WORK-052 discipline, consumed);
 *  - records carry their PROMOTION STAGE (one of the closed four);
 *    mining always emits `candidate`, promotion produces the
 *    advanced-stage record value, rollback produces the reverted
 *    one — every stage transition is a new content-addressed value
 *    (the auditable stage lineage);
 *  - the SELF-ASSERTION GUARD rides the record itself: the record
 *    carries its trajectory executors and its miner, and a record
 *    whose miner IS one of its trajectory executors is rejected at
 *    construction AND at read time (an agent NEVER marks its own
 *    output as competence — LEARNING-NONAUTHORITY, enforced
 *    structurally, not by convention);
 *  - unattributed records are rejected: no miner identity, no
 *    repetition evidence (observation count below the minimum), no
 *    explicit basis → no competence record (invariant 1).
 *
 * Pure and deterministic: no clock, no randomness, no ambient state
 * (architecture invariant 5). The record is DECISION EVIDENCE,
 * never an authorization: no permission semantics ride on it and no
 * authority surface consults it (boundary-proven).
 */

import type { TenantCacheScope } from "../context-economics/keys";
import { deriveTenantScopedCacheKey, validateTenantCacheScope } from "../context-economics/keys";
import { canonicalJson, isCanonicalizable } from "../execution-ir/canonical";
import type { CostClaim } from "../execution-ir/cost-model";
import { validateCostClaim } from "../execution-ir/cost-model";
import type { IrDigestPort } from "../execution-ir/ir";
import type { EnvironmentFingerprint } from "../failure-recovery/fingerprint";
import { validateEnvironmentFingerprint } from "../failure-recovery/fingerprint";
import {
  AUTHORITY_ID_PATTERN,
  boundedDetail,
  CAPABILITY_REF_PATTERN,
  MAX_APPLICABILITY_TAGS,
  MIN_SUCCESSFUL_TRAJECTORIES,
  PROMOTION_STAGES,
  type PromotionStage,
  reject,
  SHA256_HEX_PATTERN,
  TAG_PATTERN,
} from "./catalog";

// ---------------------------------------------------------------------------
// The expected-outcome evidence (explicit-basis, verification-bound)
// ---------------------------------------------------------------------------

/**
 * The expected-outcome evidence of a competence record — what the
 * observed successful trajectories actually achieved, with the
 * EXPLICIT basis and the verification binding. The expected quality
 * is the CONSERVATIVE minimum over the observations (evidence
 * quality never exceeds the weakest observation); the expected
 * reliability is the observed success ratio. Both are INPUTS the
 * mining derives honestly (never self-raised here).
 */
export interface ExpectedOutcomeEvidence {
  /** The number of distinct successful trajectories observed (>= 2). */
  readonly observationCount: number;
  /** The conservative minimum observed quality in [0, 1]. */
  readonly expectedQuality: number;
  /** The observed success ratio in (0, 1]. */
  readonly expectedReliability: number;
  /**
   * The verification authority's binding: the strategy that verified
   * the successful outcomes and the earliest verification identity
   * (the verification authority's own measurement — recorded, never
   * re-judged here: VERIFICATION-SEPARATION).
   */
  readonly verificationBinding: {
    readonly strategy: string;
    readonly verificationId: string;
  };
  /** The explicit evidence basis (bounded attribution source). */
  readonly basis: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Total, deterministic validation of the expected-outcome evidence. */
export function validateExpectedOutcomeEvidence(value: unknown): ExpectedOutcomeEvidence {
  if (!isRecord(value)) {
    reject("record-shape", "expected-outcome evidence must be an object");
  }
  const record = value;
  if (
    typeof record.observationCount !== "number" ||
    !Number.isInteger(record.observationCount) ||
    record.observationCount < MIN_SUCCESSFUL_TRAJECTORIES
  ) {
    reject("record-unattributed", "observation count is below the repetition minimum", {
      minimum: MIN_SUCCESSFUL_TRAJECTORIES,
      got: boundedDetail(String(record.observationCount)),
    });
  }
  if (
    typeof record.expectedQuality !== "number" ||
    !Number.isFinite(record.expectedQuality) ||
    record.expectedQuality < 0 ||
    record.expectedQuality > 1
  ) {
    reject("record-shape", "expected quality must be a probability in [0, 1]", {
      got: boundedDetail(String(record.expectedQuality)),
    });
  }
  if (
    typeof record.expectedReliability !== "number" ||
    !Number.isFinite(record.expectedReliability) ||
    record.expectedReliability <= 0 ||
    record.expectedReliability > 1
  ) {
    reject("record-shape", "expected reliability must be in (0, 1]", {
      got: boundedDetail(String(record.expectedReliability)),
    });
  }
  if (
    !isRecord(record.verificationBinding) ||
    typeof record.verificationBinding.strategy !== "string" ||
    record.verificationBinding.strategy.length === 0 ||
    record.verificationBinding.strategy.length > 64 ||
    typeof record.verificationBinding.verificationId !== "string" ||
    record.verificationBinding.verificationId.length === 0 ||
    record.verificationBinding.verificationId.length > 128
  ) {
    reject("record-unattributed", "expected-outcome evidence must carry its verification binding");
  }
  if (typeof record.basis !== "string" || record.basis.length === 0 || record.basis.length > 200) {
    reject("record-unattributed", "expected-outcome evidence must carry its explicit basis", {
      got: boundedDetail(String(record.basis)),
    });
  }
  return value as unknown as ExpectedOutcomeEvidence;
}

// ---------------------------------------------------------------------------
// The competence record
// ---------------------------------------------------------------------------

/** The frozen basis statement of every competence record. */
export const COMPETENCE_RECORD_BASIS =
  "competence-is-evidence-never-authority;content-addressed-identity;tenant-scoped-corpus;miner-must-differ-from-executors;explicit-basis-outcome-and-cost;promotion-stage-in-canonical-form";

/**
 * The typed competence record — DECISION EVIDENCE carrying the
 * trajectory digest, the applicability bounds, the expected-outcome
 * evidence and the cost. Selectable as a candidate representation
 * through the EXISTING seams; never an authorization; never
 * self-asserted.
 */
export interface CompetenceRecord {
  /** Content-derived identity: sha256 over the canonical record form. */
  readonly recordId: string;
  /** The tenant scope (structural — cross-tenant reuse is unrepresentable). */
  readonly scope: TenantCacheScope;
  /** WHERE the competence applies: the governed capability (neutral slug). */
  readonly capabilityId: string;
  /** WHERE the competence applies: the bounded neutral applicability tags. */
  readonly tags: readonly string[];
  /** WHERE the competence applies: the observed environment fingerprint. */
  readonly environment: EnvironmentFingerprint;
  /** sha256 over the canonical trajectory-evidence form (EXECUTION-PROVENANCE). */
  readonly trajectoryDigest: string;
  /** The executor identities of the observed trajectories (bounded set). */
  readonly trajectoryExecutors: readonly string[];
  /** The mining authority identity (must differ from every executor). */
  readonly minedBy: string;
  /** The expected-outcome evidence (verification-bound, explicit basis). */
  readonly expectedOutcome: ExpectedOutcomeEvidence;
  /** The cost evidence — the foundation's OWN explicit-basis CostClaim. */
  readonly claim: CostClaim;
  /** The promotion stage (closed vocabulary; mining emits `candidate`). */
  readonly stage: PromotionStage;
  /** The frozen, human-auditable record basis. */
  readonly recordBasis: string;
}

/** The record form excluding the derived identity. */
type CompetenceRecordForm = Omit<CompetenceRecord, "recordId">;

/** Canonical record form — the exact bytes the recordId covers. */
export function canonicalCompetenceRecordForm(form: CompetenceRecordForm): string {
  if (!isCanonicalizable(form)) {
    throw new TypeError("competence record form is not canonicalizable");
  }
  return canonicalJson(form);
}

// ---------------------------------------------------------------------------
// Construction (content-addressed, total validation)
// ---------------------------------------------------------------------------

/** The competence-record construction input. */
export interface CompetenceRecordInput {
  readonly scope: TenantCacheScope;
  readonly capabilityId: string;
  readonly tags: readonly string[];
  readonly environment: EnvironmentFingerprint;
  readonly trajectoryDigest: string;
  readonly trajectoryExecutors: readonly string[];
  /** The mining authority identity (NEVER one of the executors). */
  readonly minedBy: string;
  readonly expectedOutcome: ExpectedOutcomeEvidence;
  readonly claim: CostClaim;
  readonly stage: PromotionStage;
  readonly digest: IrDigestPort;
}

/**
 * Build a competence record: total validation then the
 * content-addressed identity.
 *
 * Fail-closed BEFORE the record exists:
 *  - the scope, capability, tags and environment must be well-formed
 *    and bounded (applicability bounds are typed);
 *  - the trajectory digest must be a sha256; the executor set must
 *    be bounded, unique and non-empty;
 *  - the miner must be a bounded authority identity AND must differ
 *    from every trajectory executor (the self-assertion guard —
 *    LEARNING-NONAUTHORITY);
 *  - the expected-outcome evidence must meet the repetition minimum;
 *  - the claim must be the foundation's own validated explicit-basis
 *    CostClaim;
 *  - the stage must be one of the closed four.
 */
export function buildCompetenceRecord(input: CompetenceRecordInput): CompetenceRecord {
  const scope = validateTenantCacheScope(input.scope);
  if (typeof input.capabilityId !== "string" || !CAPABILITY_REF_PATTERN.test(input.capabilityId)) {
    reject("record-shape", "capabilityId must be a bounded neutral slug", {
      got: boundedDetail(String(input.capabilityId)),
    });
  }
  if (!Array.isArray(input.tags) || input.tags.length === 0) {
    reject("record-shape", "a competence record must declare at least one applicability tag");
  }
  if (input.tags.length > MAX_APPLICABILITY_TAGS) {
    reject("record-shape", "applicability tags exceed the bound", {
      bound: MAX_APPLICABILITY_TAGS,
      got: input.tags.length,
    });
  }
  const tags: string[] = [];
  const seenTags = new Set<string>();
  for (const tag of input.tags) {
    if (typeof tag !== "string" || !TAG_PATTERN.test(tag)) {
      reject("record-shape", "applicability tags must be bounded neutral slugs", {
        got: boundedDetail(String(tag)),
      });
    }
    if (seenTags.has(tag)) {
      reject("record-shape", "applicability tags must be unique", { tag });
    }
    seenTags.add(tag);
    tags.push(tag);
  }
  // Canonical order: sorted, deterministic identity regardless of input order.
  tags.sort();

  const environment = validateEnvironmentFingerprint(input.environment, input.digest);
  if (
    typeof input.trajectoryDigest !== "string" ||
    !SHA256_HEX_PATTERN.test(input.trajectoryDigest)
  ) {
    reject("record-shape", "trajectoryDigest must be a sha256 hex digest", {
      got: boundedDetail(String(input.trajectoryDigest)),
    });
  }
  if (!Array.isArray(input.trajectoryExecutors) || input.trajectoryExecutors.length === 0) {
    reject("record-unattributed", "a competence record must carry its trajectory executors");
  }
  if (input.trajectoryExecutors.length > MAX_APPLICABILITY_TAGS) {
    reject("record-shape", "trajectory executor set exceeds the bound", {
      bound: MAX_APPLICABILITY_TAGS,
      got: input.trajectoryExecutors.length,
    });
  }
  const executors: string[] = [];
  const seenExecutors = new Set<string>();
  for (const executor of input.trajectoryExecutors) {
    if (typeof executor !== "string" || !AUTHORITY_ID_PATTERN.test(executor)) {
      reject("record-shape", "trajectory executors must be bounded neutral identities", {
        got: boundedDetail(String(executor)),
      });
    }
    if (seenExecutors.has(executor)) {
      reject("record-shape", "trajectory executors must be unique", { executor });
    }
    seenExecutors.add(executor);
    executors.push(executor);
  }
  executors.sort();

  if (typeof input.minedBy !== "string" || !AUTHORITY_ID_PATTERN.test(input.minedBy)) {
    reject("record-unattributed", "a competence record must carry its mining authority identity", {
      got: boundedDetail(String(input.minedBy)),
    });
  }
  if (executors.includes(input.minedBy)) {
    // THE self-assertion guard: an agent NEVER marks its own output
    // as competence. The miner must be an independent mining
    // authority, distinct from every trajectory executor.
    reject(
      "record-self-asserted",
      "the mining authority is one of the trajectory executors (self-asserted competence is rejected)",
      { minedBy: input.minedBy },
    );
  }
  const expectedOutcome = validateExpectedOutcomeEvidence(input.expectedOutcome);
  const claim = validateCostClaim(input.claim);
  if (
    typeof input.stage !== "string" ||
    !(PROMOTION_STAGES as readonly string[]).includes(input.stage)
  ) {
    reject("record-shape", "the promotion stage is outside the closed vocabulary", {
      got: boundedDetail(String(input.stage)),
    });
  }
  if (expectedOutcome.observationCount < MIN_SUCCESSFUL_TRAJECTORIES) {
    // Mining honesty: single lucky runs never become competence.
    reject("record-unattributed", "the repetition evidence is below the mining minimum", {
      minimum: MIN_SUCCESSFUL_TRAJECTORIES,
      got: expectedOutcome.observationCount,
    });
  }

  const form: CompetenceRecordForm = {
    scope,
    capabilityId: input.capabilityId,
    tags,
    environment,
    trajectoryDigest: input.trajectoryDigest,
    trajectoryExecutors: executors,
    minedBy: input.minedBy,
    expectedOutcome,
    claim,
    stage: input.stage,
    recordBasis: COMPETENCE_RECORD_BASIS,
  };
  const recordId = input.digest.sha256Hex(canonicalJson(form));
  return { recordId, ...form };
}

// ---------------------------------------------------------------------------
// Total validation of a (deserialized) record
// ---------------------------------------------------------------------------

/**
 * Total, deterministic validation of a competence-record value
 * (e.g. after a round-trip): the full construction discipline
 * re-proven (bounds, uniqueness, the self-assertion guard, the
 * repetition minimum) AND identity verification — `recordId` must be
 * the digest of the canonical form (tampered or foreign values are
 * rejected at read time, never served).
 */
export function validateCompetenceRecord(value: unknown, digest: IrDigestPort): CompetenceRecord {
  if (!isRecord(value)) {
    reject("record-shape", "competence record must be an object");
  }
  const record = value;
  if (typeof record.recordId !== "string" || !SHA256_HEX_PATTERN.test(record.recordId)) {
    reject("record-shape", "recordId must be a sha256 hex digest", {
      got: boundedDetail(String(record.recordId)),
    });
  }
  if (record.recordBasis !== COMPETENCE_RECORD_BASIS) {
    reject("record-shape", "record basis is outside the frozen vocabulary", {
      got: boundedDetail(String(record.recordBasis)),
    });
  }
  // Re-prove the construction discipline (fail closed on any weakened
  // input — the read-time self-assertion guard included).
  const rebuilt = buildCompetenceRecord({
    scope: record.scope as TenantCacheScope,
    capabilityId: record.capabilityId as string,
    tags: record.tags as readonly string[],
    environment: record.environment as EnvironmentFingerprint,
    trajectoryDigest: record.trajectoryDigest as string,
    trajectoryExecutors: record.trajectoryExecutors as readonly string[],
    minedBy: record.minedBy as string,
    expectedOutcome: record.expectedOutcome as ExpectedOutcomeEvidence,
    claim: record.claim as CostClaim,
    stage: record.stage as PromotionStage,
    digest,
  });
  if (rebuilt.recordId !== record.recordId) {
    reject("record-shape", "record content does not digest to the claimed identity", {
      claimed: record.recordId,
      computed: rebuilt.recordId,
    });
  }
  return record as unknown as CompetenceRecord;
}

// ---------------------------------------------------------------------------
// The tenant-scoped corpus key (the merged plane's own discipline)
// ---------------------------------------------------------------------------

/**
 * Derive the tenant-scoped corpus key of a competence record's
 * applicability shape — through the MERGED context-economics plane's
 * own `deriveTenantScopedCacheKey` (the artifact-result key class:
 * competence records ARE reusable artifacts/results; the tenant
 * identity is a structural component of the key, so cross-tenant
 * corpus lookups can never collide — the WORK-052 discipline,
 * consumed read-only, never re-implemented).
 */
export function competenceCorpusKey(
  scope: TenantCacheScope,
  capabilityId: string,
  tags: readonly string[],
  digest: IrDigestPort,
): string {
  const validatedScope = validateTenantCacheScope(scope);
  if (typeof capabilityId !== "string" || !CAPABILITY_REF_PATTERN.test(capabilityId)) {
    reject("retrieval-input-shape", "the corpus key requires a bounded capability slug");
  }
  const canonicalTags = [...new Set(tags)].filter(
    (tag) => typeof tag === "string" && TAG_PATTERN.test(tag),
  );
  if (canonicalTags.length !== tags.length) {
    reject("retrieval-input-shape", "the corpus key requires bounded unique tags");
  }
  canonicalTags.sort();
  const key = deriveTenantScopedCacheKey(
    validatedScope,
    "artifact-result",
    { capabilityId, tags: canonicalTags },
    digest,
  );
  return key.key;
}
