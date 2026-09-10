/**
 * Bounded rollback (platform competence-economics plane; WORK-056 /
 * E1.1 — ADR-0019, ADR-0020).
 *
 * ROLLBACK IS BOUNDED AND TYPED (the Work Order's sixth
 * architecture invariant): a degraded promotion reverts to the
 * PRIOR representation with RECORDED evidence — never silent, never
 * partial, never unbounded:
 *
 *  - a ROLLBACK RECORD is a typed, content-addressed value
 *    (`rollbackId` = digest over the canonical form) carrying the
 *    promoted record being reverted, the exact stage transition
 *    (from → to, exactly one stage back — the PRIOR
 *    representation, never a jump to an arbitrary stage), the
 *    closed degradation reason, the BOUNDED degradation evidence
 *    ([1, 64] typed entries), the REVERTED record value (the
 *    restore directive as DATA — the record at the prior stage),
 *    the requesting authority and the explicit recorded-at instant;
 *  - the reason↔evidence COHERENCE is enforced: an
 *    `equivalence-degraded` rollback must carry at least one
 *    equivalence degradation entry; a `quality-degraded` rollback a
 *    quality entry; an `economics-degraded` rollback an economics
 *    entry; a `policy-revoked` rollback a policy entry (a rollback
 *    without its typed evidence is a typed rejection — never a
 *    silent revert);
 *  - the requesting authority must be INDEPENDENT (not a trajectory
 *    executor, not the miner — the same LEARNING-NONAUTHORITY
 *    discipline: agents never roll back their own promotions
 *    either);
 *  - application is PURE and IDEMPOTENT (`applyRollbackRecord`):
 *    applying the rollback to the promoted record yields the
 *    reverted record; applying it AGAIN (to the already-reverted
 *    record) is a bounded no-op returning the same value; applying
 *    it to a foreign record is a typed rejection (never a silent
 *    partial state).
 *
 * Pure and deterministic: no clock, no randomness, no ambient state
 * (architecture invariant 5). The rollback is DATA + RULES executed
 * through the EXISTING seams (the caller records it — the
 * decision-record ride in `decisions.ts`); this module authorizes
 * nothing.
 */

import { canonicalJson, isCanonicalizable } from "../execution-ir/canonical";
import type { IrDigestPort } from "../execution-ir/ir";
import {
  AUTHORITY_ID_PATTERN,
  boundedDetail,
  MAX_ROLLBACK_EVIDENCE_ENTRIES,
  PROMOTION_STAGE_RANK,
  type PromotionStage,
  ROLLBACK_REASON_CODES,
  type RollbackReasonCode,
  reject,
  SHA256_HEX_PATTERN,
} from "./catalog";
import type { CompetenceRecord } from "./record";
import { buildCompetenceRecord, validateCompetenceRecord } from "./record";

// ---------------------------------------------------------------------------
// The degradation evidence (typed, closed)
// ---------------------------------------------------------------------------

/**
 * One typed degradation entry — the evidence that a promotion
 * degraded. The kind must COHERE with the rollback reason (the
 * reason↔evidence coherence below).
 */
export type DegradationEvidence =
  | {
      readonly kind: "equivalence";
      /**
       * The failing equivalence component (differential / property /
       * replay — the closed vocabulary).
       */
      readonly component: "differential" | "property" | "replay";
      /** Bounded human-auditable detail. */
      readonly detail: string;
    }
  | {
      readonly kind: "quality";
      /** The observed quality that fell below the governing floor. */
      readonly observedQuality: number;
      /** Bounded human-auditable detail. */
      readonly detail: string;
    }
  | {
      readonly kind: "economics";
      /** The regressed expected cost (integer micro-USD string). */
      readonly observedCostMicroUsd: string;
      /** Bounded human-auditable detail. */
      readonly detail: string;
    }
  | {
      readonly kind: "policy";
      /** Bounded human-auditable detail (the policy authority's revocation). */
      readonly detail: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Total, deterministic validation of one degradation entry. */
export function validateDegradationEvidence(value: unknown): DegradationEvidence {
  if (!isRecord(value)) {
    reject("rollback-shape", "a degradation entry must be an object");
  }
  const record = value;
  const detail = record.detail;
  if (typeof detail !== "string" || detail.length === 0 || detail.length > 500) {
    reject("rollback-shape", "a degradation entry must carry bounded detail");
  }
  switch (record.kind) {
    case "equivalence":
      if (
        record.component !== "differential" &&
        record.component !== "property" &&
        record.component !== "replay"
      ) {
        reject("rollback-shape", "equivalence degradation must name its failing component", {
          got: boundedDetail(String(record.component)),
        });
      }
      return value as DegradationEvidence;
    case "quality":
      if (
        typeof record.observedQuality !== "number" ||
        !Number.isFinite(record.observedQuality) ||
        record.observedQuality < 0 ||
        record.observedQuality > 1
      ) {
        reject("rollback-shape", "quality degradation must carry the observed quality in [0, 1]", {
          got: boundedDetail(String(record.observedQuality)),
        });
      }
      return value as DegradationEvidence;
    case "economics":
      if (
        typeof record.observedCostMicroUsd !== "string" ||
        !/^(0|[1-9][0-9]{0,17})$/.test(record.observedCostMicroUsd)
      ) {
        reject(
          "rollback-shape",
          "economics degradation must carry the observed cost as an integer micro-USD string",
          { got: boundedDetail(String(record.observedCostMicroUsd)) },
        );
      }
      return value as DegradationEvidence;
    case "policy":
      return value as DegradationEvidence;
    default:
      reject("rollback-shape", "the degradation kind is outside the closed vocabulary", {
        got: boundedDetail(String(record.kind)),
      });
  }
}

/** The reason↔evidence coherence table (the closed mapping). */
const REASON_REQUIRED_KIND: Readonly<Record<RollbackReasonCode, DegradationEvidence["kind"]>> = {
  "equivalence-degraded": "equivalence",
  "quality-degraded": "quality",
  "economics-degraded": "economics",
  "policy-revoked": "policy",
};

// ---------------------------------------------------------------------------
// The rollback record
// ---------------------------------------------------------------------------

/** The frozen rollback-basis statement. */
export const ROLLBACK_BASIS =
  "prior-representation-restored;one-stage-back-exactly;reason-evidence-coherence-required;bounded-degradation-evidence;independent-requesting-authority;content-addressed-identity;idempotent-pure-apply;recorded-never-silent";

/**
 * THE bounded rollback record — typed, content-addressed DATA
 * reverting a degraded promotion to the prior representation.
 */
export interface RollbackRecord {
  /** Content-derived identity: sha256 over the canonical rollback form. */
  readonly rollbackId: string;
  /** The promoted record being rolled back (at its promoted stage). */
  readonly promotedRecord: CompetenceRecord;
  /** The stage being reverted FROM. */
  readonly fromStage: PromotionStage;
  /** The stage being reverted TO (exactly one stage back). */
  readonly toStage: PromotionStage;
  /** EXACTLY ONE closed degradation reason. */
  readonly reason: RollbackReasonCode;
  /** The bounded degradation evidence ([1, 64] typed entries). */
  readonly degradedEvidence: readonly DegradationEvidence[];
  /** The REVERTED record value (the restored representation — DATA). */
  readonly revertedRecord: CompetenceRecord;
  /** The authority identity executing the rollback (independent). */
  readonly requestedBy: string;
  /** The explicit recorded-at instant (an INPUT, never ambient). */
  readonly recordedAt: string;
  /** The frozen, human-auditable rollback basis. */
  readonly rollbackBasis: string;
}

/** The rollback form excluding the derived identity. */
type RollbackForm = Omit<RollbackRecord, "rollbackId">;

/** The rollback construction input. */
export interface RollbackInput {
  /** The promoted record being rolled back (rank >= shadow). */
  readonly promotedRecord: CompetenceRecord;
  /** EXACTLY ONE closed degradation reason. */
  readonly reason: RollbackReasonCode;
  /** The bounded degradation evidence ([1, 64] typed entries). */
  readonly degradedEvidence: readonly DegradationEvidence[];
  /** The authority identity executing the rollback (independent). */
  readonly requestedBy: string;
  /** The explicit recorded-at instant. */
  readonly recordedAt: string;
  readonly digest: IrDigestPort;
}

/**
 * Build the bounded rollback record: total validation, the
 * reason↔evidence coherence, the independence discipline and the
 * exactly-one-stage-back revert, then the content-addressed
 * identity.
 *
 * Fail-closed BEFORE the rollback exists:
 *  - the promoted record must be a valid record at stage rank >= 1
 *    (a `candidate`-stage record has nothing to roll back);
 *  - the degradation reason must be one of the closed four WITH its
 *    coherent typed evidence entry present;
 *  - the evidence set must be bounded and non-empty;
 *  - the requesting authority must differ from every trajectory
 *    executor and the miner (no self-rollback);
 *  - the reverted record is DERIVED (one stage back — never
 *    caller-supplied, never a jump).
 */
export function buildRollback(input: RollbackInput, digest: IrDigestPort): RollbackRecord {
  const promoted = validateCompetenceRecord(input.promotedRecord, digest);
  if (
    typeof input.reason !== "string" ||
    !(ROLLBACK_REASON_CODES as readonly string[]).includes(input.reason)
  ) {
    reject("rollback-shape", "the degradation reason is outside the closed vocabulary", {
      got: boundedDetail(String(input.reason)),
    });
  }
  if (!Array.isArray(input.degradedEvidence) || input.degradedEvidence.length === 0) {
    reject("rollback-shape", "a rollback requires its degradation evidence (never silent)");
  }
  if (input.degradedEvidence.length > MAX_ROLLBACK_EVIDENCE_ENTRIES) {
    reject("rollback-shape", "the degradation evidence exceeds the bound", {
      bound: MAX_ROLLBACK_EVIDENCE_ENTRIES,
      got: input.degradedEvidence.length,
    });
  }
  const evidence = input.degradedEvidence.map((entry) => validateDegradationEvidence(entry));
  // The reason↔evidence coherence: the typed evidence must carry the
  // reason's own kind (an equivalence-degraded rollback without
  // equivalence evidence is a typed rejection).
  const requiredKind = REASON_REQUIRED_KIND[input.reason];
  if (!evidence.some((entry) => entry.kind === requiredKind)) {
    reject("rollback-shape", "the rollback reason requires its coherent degradation evidence", {
      reason: input.reason,
      requiredKind,
    });
  }
  if (typeof input.requestedBy !== "string" || !AUTHORITY_ID_PATTERN.test(input.requestedBy)) {
    reject("rollback-shape", "the rollback requires its requesting authority identity", {
      got: boundedDetail(String(input.requestedBy)),
    });
  }
  if (
    promoted.trajectoryExecutors.includes(input.requestedBy) ||
    promoted.minedBy === input.requestedBy
  ) {
    reject("rollback-shape", "the requesting authority is a trajectory executor or the miner");
  }
  if (typeof input.recordedAt !== "string" || input.recordedAt.length === 0) {
    reject("rollback-shape", "recordedAt must be a non-empty string");
  }

  const fromRank = PROMOTION_STAGE_RANK[promoted.stage];
  if (fromRank < 1) {
    reject("rollback-shape", "a candidate-stage record has no promotion to roll back", {
      stage: promoted.stage,
    });
  }
  const toStage: PromotionStage = stageOfRank(fromRank - 1);
  const revertedRecord = buildCompetenceRecord({
    scope: promoted.scope,
    capabilityId: promoted.capabilityId,
    tags: promoted.tags,
    environment: promoted.environment,
    trajectoryDigest: promoted.trajectoryDigest,
    trajectoryExecutors: promoted.trajectoryExecutors,
    minedBy: promoted.minedBy,
    expectedOutcome: promoted.expectedOutcome,
    claim: promoted.claim,
    stage: toStage,
    digest,
  });

  const form: RollbackForm = {
    promotedRecord: promoted,
    fromStage: promoted.stage,
    toStage,
    reason: input.reason,
    degradedEvidence: evidence,
    revertedRecord,
    requestedBy: input.requestedBy,
    recordedAt: input.recordedAt,
    rollbackBasis: ROLLBACK_BASIS,
  };
  if (!isCanonicalizable(form)) {
    reject("rollback-shape", "rollback form is not canonicalizable");
  }
  const rollbackId = digest.sha256Hex(canonicalJson(form));
  return { rollbackId, ...form };
}

/**
 * Total, deterministic validation of a (deserialized) rollback
 * record: the full construction discipline re-proven AND identity
 * verification — `rollbackId` must be the digest of the canonical
 * form (tampered or foreign values are rejected at read time).
 */
export function validateRollbackRecord(value: unknown, digest: IrDigestPort): RollbackRecord {
  if (!isRecord(value)) {
    reject("rollback-shape", "rollback record must be an object");
  }
  const record = value;
  if (typeof record.rollbackId !== "string" || !SHA256_HEX_PATTERN.test(record.rollbackId)) {
    reject("rollback-shape", "rollbackId must be a sha256 hex digest", {
      got: boundedDetail(String(record.rollbackId)),
    });
  }
  if (record.rollbackBasis !== ROLLBACK_BASIS) {
    reject("rollback-shape", "rollback basis is outside the frozen vocabulary", {
      got: boundedDetail(String(record.rollbackBasis)),
    });
  }
  const rebuilt = buildRollback(
    {
      promotedRecord: record.promotedRecord as CompetenceRecord,
      reason: record.reason as RollbackReasonCode,
      degradedEvidence: record.degradedEvidence as readonly DegradationEvidence[],
      requestedBy: record.requestedBy as string,
      recordedAt: record.recordedAt as string,
      digest,
    },
    digest,
  );
  if (rebuilt.rollbackId !== record.rollbackId) {
    reject("rollback-shape", "rollback content does not digest to the claimed identity", {
      claimed: record.rollbackId,
      computed: rebuilt.rollbackId,
    });
  }
  return record as unknown as RollbackRecord;
}

// ---------------------------------------------------------------------------
// The idempotent application (pure — data + rules)
// ---------------------------------------------------------------------------

/**
 * Apply the rollback to a competence record — PURE and IDEMPOTENT:
 *
 *  - applying it to the PROMOTED record yields the reverted record
 *    (the prior representation restored);
 *  - applying it AGAIN (to the already-reverted record) is a
 *    bounded no-op returning the same value (never a second
 *    reversion, never a partial state);
 *  - applying it to any OTHER record is a typed rejection (the
 *    rollback never silently applies where it does not belong).
 */
export function applyRollbackRecord(
  rollback: RollbackRecord,
  record: CompetenceRecord,
): CompetenceRecord {
  if (record.recordId === rollback.promotedRecord.recordId) {
    return rollback.revertedRecord;
  }
  if (record.recordId === rollback.revertedRecord.recordId) {
    // Idempotent no-op: already reverted (IDENTITY-IDEMPOTENCY).
    return record;
  }
  reject("rollback-shape", "the rollback does not apply to this record", {
    rollbackId: rollback.rollbackId,
    recordId: record.recordId,
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function stageOfRank(rank: number): PromotionStage {
  const stage = Object.entries(PROMOTION_STAGE_RANK).find(([, value]) => value === rank)?.[0];
  if (stage === undefined) {
    reject("rollback-shape", "the promotion stage rank is outside the closed vocabulary", {
      rank,
    });
  }
  return stage as PromotionStage;
}
