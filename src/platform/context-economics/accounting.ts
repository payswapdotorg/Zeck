/**
 * Duplication accounting (platform context-economics plane;
 * WORK-052 / E1.1).
 *
 * Architecture invariant 7: "Duplication accounting is evidence
 * (decision records), not a ledger of authority." This module builds
 * the duplication-accounting EVIDENCE records for reuse and
 * coalescing outcomes through the EXISTING WORK-049 evidence
 * contract (`buildOptimizationDecision`): what was reused, what was
 * coalesced, what duplicate work was avoided — recorded with the
 * governing constraints, the compared candidate representations
 * (fresh execution vs the reused/coalesced representation, both with
 * bounded attributed cost claims), the deterministic selection, and
 * the exact provenance chain (plan → IR → variant → decision).
 *
 * The record is EVIDENCE ONLY (the WORK-049 contract, unchanged):
 *
 *  - this plane holds NO store, NO SQL, NO admission/authorization
 *    vocabulary — the durable append happens through the EXISTING
 *    `SqlOptimizationDecisionStore` at the CALLER's seam (the same
 *    pattern WORK-050 uses), where the unique (application_id,
 *    decision_id) index makes concurrent identical accountings
 *    converge to exactly one durable row;
 *  - the accounting decision record never authorizes anything — no
 *    runtime path consults it for authorization (boundary-proven);
 *  - building the record VALIDATES everything fail-closed through
 *    the foundation: unattributed or unbounded cost claims are
 *    rejected before the record exists; the selected representation
 *    must satisfy the quality threshold (a reuse whose recorded
 *    quality is below the caller's threshold is a typed rejection —
 *    the caller re-executes rather than records a dishonest
 *    below-threshold reuse).
 *
 * Determinism: the record is content-addressed (`decisionId` is the
 * digest of the canonical form); identical accounting inputs
 * (including the explicit `recordedAt`) produce the identical
 * record — concurrent coalesced participants observing the same
 * leader outcome build the identical record, and the durable append
 * converges (one row, N−1 replays).
 */

import type { OptimizationConstraint } from "../execution-ir/constraints";
import type { CandidateRepresentation, CostClaim } from "../execution-ir/cost-model";
import type { OptimizationDecisionRecord } from "../execution-ir/decision-record";
import { buildOptimizationDecision } from "../execution-ir/decision-record";
import type { ExecutionIr, IrDigestPort } from "../execution-ir/ir";
import { type DuplicationOutcomeKind, reject } from "./catalog";

const DETAIL_MAX = 500;

function boundedDetail(text: string): string {
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}…` : text;
}

// ---------------------------------------------------------------------------
// The accounting input
// ---------------------------------------------------------------------------

/**
 * The duplication outcome evidence: what happened, structurally.
 * Each kind carries the bounded facts the decision-record detail
 * preserves (the audit trail of the avoided duplication).
 */
export type DuplicationOutcome =
  | {
      readonly kind: "cache-reuse";
      /** The tenant-safe cache key of the reused entry. */
      readonly cacheKey: string;
      /** The reused value's content digest. */
      readonly contentDigest: string;
      /** The memo key (the compiler annotation the reuse consumed). */
      readonly memoKey: string;
    }
  | {
      readonly kind: "prefix-reuse";
      readonly prefixKey: string;
      readonly prefixSegments: number;
      readonly prefixTokens: number;
    }
  | {
      readonly kind: "coalesced-join";
      readonly leaderExecutionId: string;
      /** The tenant-safe equivalence key the joiner joined under. */
      readonly equivalenceKey: string;
    }
  | {
      readonly kind: "coalesce-led";
      readonly joinerCount: number;
      readonly equivalenceKey: string;
    };

/** The economics of the accounting (both claims bounded + attributed). */
export interface DuplicationEconomics {
  /** The claim of the fresh execution that was avoided (or led). */
  readonly freshExecution: CostClaim;
  /** The claim of the representation that actually happened. */
  readonly avoidedExecution: CostClaim;
}

/** The duplication-accounting record input. */
export interface DuplicationAccountingInput {
  /** The governed Execution IR the duplication happened under. */
  readonly ir: ExecutionIr;
  /** The governing constraints (validated, non-empty). */
  readonly constraints: readonly OptimizationConstraint[];
  readonly scope: {
    readonly applicationId: string;
    readonly tenantId: string;
    readonly executionId?: string;
  };
  readonly outcome: DuplicationOutcome;
  readonly economics: DuplicationEconomics;
  /** The assurance threshold the reuse quality was evaluated against. */
  readonly qualityThreshold: number;
  /** The explicit recorded-at instant (an input — determinism). */
  readonly recordedAt: string;
}

/** The candidate ids of the accounting comparison (closed). */
const FRESH_CANDIDATE_ID = "fresh-execution";
const REUSED_CANDATE_IDS: Readonly<Record<DuplicationOutcomeKind, string>> = {
  "cache-reuse": "reused-memo-entry",
  "prefix-reuse": "reused-prefix-cache",
  "coalesced-join": "coalesced-join",
  "coalesce-led": "coalesce-led-execution",
};

// ---------------------------------------------------------------------------
// The accounting record construction
// ---------------------------------------------------------------------------

/**
 * Build the duplication-accounting decision record: the outcome
 * evidence (what was avoided), the economic comparison (the fresh
 * execution's claim vs the reused/coalesced representation's claim —
 * both bounded and attributed, validated through the foundation
 * BEFORE the record exists), the selection (the reused
 * representation — quality-preserving: its recorded quality must
 * meet the caller's threshold or the accounting is a typed
 * rejection, never a dishonest record), and the provenance chain.
 *
 * The record appends through the EXISTING WORK-049 store at the
 * caller's seam — this module holds no store, no SQL, no admission
 * vocabulary (architecture-proven).
 */
export function buildDuplicationAccountingRecord(
  input: DuplicationAccountingInput,
  digest: IrDigestPort,
): OptimizationDecisionRecord {
  const reusedCandidateId = REUSED_CANDATE_IDS[input.outcome.kind];
  const candidates: CandidateRepresentation[] = [
    {
      candidateId: FRESH_CANDIDATE_ID,
      representationClass: "deterministic-computation",
      description: "the fresh execution of the duplicate work (what was avoided or led)",
      claim: input.economics.freshExecution,
    },
    {
      candidateId: reusedCandidateId,
      representationClass: "cache-reuse",
      description: outcomeDescription(input.outcome),
      claim: input.economics.avoidedExecution,
    },
  ];

  return buildOptimizationDecision(
    {
      applicationId: input.scope.applicationId,
      tenantId: input.scope.tenantId,
      ...(input.scope.executionId === undefined ? {} : { executionId: input.scope.executionId }),
      ir: input.ir,
      constraints: input.constraints,
      candidates,
      qualityThreshold: input.qualityThreshold,
      selectedCandidateId: reusedCandidateId,
      transformationBasis: {
        code: "representation-substitution",
        detail: boundedDetail(outcomeDetail(input.outcome)),
      },
      recordedAt: input.recordedAt,
    },
    digest,
  );
}

function outcomeDescription(outcome: DuplicationOutcome): string {
  switch (outcome.kind) {
    case "cache-reuse":
      return "the memo entry was reused instead of recomputed";
    case "prefix-reuse":
      return "the prompt/prefix cache entry was reused";
    case "coalesced-join":
      return "this execution joined an equivalent in-flight leader";
    case "coalesce-led":
      return "this execution led a coalesced duplicate group";
  }
}

function outcomeDetail(outcome: DuplicationOutcome): string {
  switch (outcome.kind) {
    case "cache-reuse":
      return `duplication-accounting:cache-reuse; cacheKey=${outcome.cacheKey}; contentDigest=${outcome.contentDigest}; memoKey=${outcome.memoKey}`;
    case "prefix-reuse":
      return `duplication-accounting:prefix-reuse; prefixKey=${outcome.prefixKey}; prefixSegments=${outcome.prefixSegments}; prefixTokens=${outcome.prefixTokens}`;
    case "coalesced-join":
      return `duplication-accounting:coalesced-join; leaderExecutionId=${outcome.leaderExecutionId}; equivalenceKey=${outcome.equivalenceKey}`;
    case "coalesce-led":
      return `duplication-accounting:coalesce-led; joinerCount=${outcome.joinerCount}; equivalenceKey=${outcome.equivalenceKey}`;
  }
}

// ---------------------------------------------------------------------------
// Coalesced-group accounting (the shared outcome record)
// ---------------------------------------------------------------------------

/**
 * Build the accounting record for a coalesced group's OUTCOME: every
 * participant (leader and joiners alike) observed the identical
 * outcome, so each builds the SAME record content from the shared
 * facts — the durable append through the existing store's unique
 * (application_id, decision_id) index converges the N concurrent
 * appends to exactly one durable row (the WORK-049 idempotence
 * contract). The leader's record carries `coalesce-led`; joiners
 * carry `coalesced-join` (their records differ in ROLE evidence, so
 * each role appends exactly once — the group's total duplication
 * accounting is N rows, one per participant identity, all
 * idempotent under re-append).
 */
export function buildCoalescedAccountingRecord(
  input: Omit<DuplicationAccountingInput, "outcome"> & {
    readonly role: "leader" | "joiner";
    readonly leaderExecutionId: string;
    readonly equivalenceKey: string;
    readonly joinerCount: number;
  },
  digest: IrDigestPort,
): OptimizationDecisionRecord {
  if (input.role === "leader") {
    return buildDuplicationAccountingRecord(
      {
        ...input,
        outcome: {
          kind: "coalesce-led",
          joinerCount: input.joinerCount,
          equivalenceKey: input.equivalenceKey,
        },
      },
      digest,
    );
  }
  return buildDuplicationAccountingRecord(
    {
      ...input,
      outcome: {
        kind: "coalesced-join",
        leaderExecutionId: input.leaderExecutionId,
        equivalenceKey: input.equivalenceKey,
      },
    },
    digest,
  );
}

// ---------------------------------------------------------------------------
// Honest-boundary helper
// ---------------------------------------------------------------------------

/**
 * The accounting precondition check: a coalesced/reused outcome may
 * only be recorded when the observed outcome actually final (the
 * mechanism guarantees this — appends happen after settle). Exposed
 * for callers that want the fail-closed assertion at their seam.
 */
export function assertRecordableOutcome(outcome: DuplicationOutcome): void {
  switch (outcome.kind) {
    case "cache-reuse":
      if (!/^[0-9a-f]{64}$/.test(outcome.contentDigest)) {
        reject("accounting-shape", "a cache-reuse outcome must carry a content digest");
      }
      break;
    case "coalesced-join":
      if (outcome.leaderExecutionId.length === 0) {
        reject("accounting-shape", "a coalesced-join outcome must carry its leader identity");
      }
      break;
    default:
      break;
  }
}
