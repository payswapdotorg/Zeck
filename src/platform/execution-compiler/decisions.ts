/**
 * Representation-ladder decision construction (platform
 * execution-compiler plane; WORK-050 / E1.1 charter stage 2).
 *
 * The compiler is the LEGITIMATE decision-record author the WORK-049
 * design anticipated: every MATERIAL optimization decision — the
 * representation choice between the base (untransformed governed
 * plan) and the compiled variant — is recorded through the WORK-049
 * evidence contract (`buildOptimizationDecision`), with:
 *
 *  - the governing constraints (validated, non-empty — a decision
 *    without its governing inputs is unprovenanced optimization and
 *    is rejected before it exists);
 *  - both candidate representations with their bounded, attributed
 *    cost claims (the claims are explicit INPUTS — later E1.1 stages
 *    wire observed/estimated derivation from real telemetry);
 *  - the deterministic selection through the WORK-049 cost model
 *    (`selectCandidate`: expected successful-resolution cost
 *    ascending, ties by the representation ladder, then candidateId);
 *  - the transformation basis from the CLOSED WORK-049 vocabulary —
 *    `identity` when the compilation changed nothing, else
 *    `representation-substitution` — with a bounded detail carrying
 *    the compilation provenance (input IR, output variant, trace
 *    digest, pass list);
 *  - provenance: the base IR's identity chain (planId → irId), and
 *    the compiled candidate's `variantIrId` referencing the exact
 *    output variant.
 *
 * QUALITY-PRESERVING ECONOMICS (ADR-0020): the selection is evaluated
 * against the assurance threshold; a cheaper candidate below the
 * threshold is INVALID — if no candidate is admissible, NO decision
 * record is produced and the outcome is a typed pass rejection
 * (`ladder-no-admissible-candidate`), never a below-threshold
 * selection.
 *
 * The record is EVIDENCE ONLY: nothing in this plane (or anywhere)
 * consults it for authorization; the durable append happens through
 * the existing WORK-049 store at the caller's seam.
 */

import type { OptimizationConstraint } from "../execution-ir/constraints";
import { validateConstraintSet } from "../execution-ir/constraints";
import type { CandidateRepresentation } from "../execution-ir/cost-model";
import { representationLadderRank, selectCandidate } from "../execution-ir/cost-model";
import type { OptimizationDecisionRecord } from "../execution-ir/decision-record";
import { buildOptimizationDecision } from "../execution-ir/decision-record";
import type { ExecutionIr, IrDigestPort } from "../execution-ir/ir";
import type { RepresentationClaims } from "./catalog";

const DETAIL_MAX = 500;

function boundedDetail(text: string): string {
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}…` : text;
}

export interface LadderSelection {
  readonly kind: "selected" | "no-admissible-candidate";
  readonly selectedCandidateId: string | null;
  readonly representationClass: string | null;
  readonly ladderRank: number | null;
  readonly decisionRecord: OptimizationDecisionRecord | null;
}

export interface BuildLadderDecisionInput {
  /** The validated base (governed) Execution IR. */
  readonly ir: ExecutionIr;
  /** The governing constraint set (must be NON-EMPTY). */
  readonly constraints: readonly OptimizationConstraint[];
  /** The compiler-configured ladder claims (already validated). */
  readonly claims: RepresentationClaims;
  /** The assurance threshold for the quality-preserving selection. */
  readonly qualityThreshold: number;
  /** The final compiled variant identity. */
  readonly variantIrId: string;
  /** The input IR identity (the base candidate's variantIrId). */
  readonly inputIrId: string;
  /** Did any transformation change the IR (basis selection)? */
  readonly changed: boolean;
  /** The bounded pass list actually applied (provenance evidence). */
  readonly appliedPasses: readonly string[];
  /** The compilation trace digest (provenance evidence). */
  readonly traceDigest: string;
  /** Decision-record scope. */
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId?: string;
  /** The explicit recorded-at instant (an input — determinism). */
  readonly recordedAt: string;
  readonly digest: IrDigestPort;
}

/**
 * Build the material representation decision: evaluate both ladder
 * candidates through the WORK-049 cost model, select deterministically
 * (quality-preserving), and record the full evidence contract. When no
 * candidate meets the assurance threshold, NO record exists and the
 * outcome is the typed no-admissible outcome (never a
 * below-threshold selection).
 */
export function buildLadderDecision(input: BuildLadderDecisionInput): LadderSelection {
  const constraints = validateConstraintSet(input.constraints);
  if (constraints.length === 0) {
    // Fail closed (the WORK-049 rule): a decision without governing
    // inputs is unprovenanced optimization.
    throw new Error(
      "the representation decision requires at least one governing constraint (unprovenanced optimization is rejected)",
    );
  }

  const baseCandidate: CandidateRepresentation = {
    candidateId: input.claims.base.candidateId,
    representationClass: input.claims.base
      .representationClass as CandidateRepresentation["representationClass"],
    description: "the untransformed governed plan representation (identity candidate)",
    claim: input.claims.base.claim,
    variantIrId: input.inputIrId,
  };
  const compiledCandidate: CandidateRepresentation = {
    candidateId: input.claims.compiled.candidateId,
    representationClass: input.claims.compiled
      .representationClass as CandidateRepresentation["representationClass"],
    description: "the compiled optimized variant (semantics-preserving transformations applied)",
    claim: input.claims.compiled.claim,
    variantIrId: input.variantIrId,
  };

  const selection = selectCandidate([baseCandidate, compiledCandidate], input.qualityThreshold);
  if (selection.selected === null) {
    return {
      kind: "no-admissible-candidate",
      selectedCandidateId: null,
      representationClass: null,
      ladderRank: null,
      decisionRecord: null,
    };
  }
  const selected = selection.selected;

  const transformationBasis = {
    code: (input.changed ? "representation-substitution" : "identity") as
      | "identity"
      | "representation-substitution",
    detail: boundedDetail(
      `execution-compiler;passes=${input.appliedPasses.join(",") || "none"};inputIr=${input.inputIrId};outputVariant=${input.variantIrId};traceDigest=${input.traceDigest};equivalence=semantic-core-digest`,
    ),
  };

  const record = buildOptimizationDecision(
    {
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
      ir: input.ir,
      constraints,
      candidates: [baseCandidate, compiledCandidate],
      qualityThreshold: input.qualityThreshold,
      selectedCandidateId: selected.candidateId,
      transformationBasis,
      recordedAt: input.recordedAt,
    },
    input.digest,
  );

  return {
    kind: "selected",
    selectedCandidateId: selected.candidateId,
    representationClass: selected.representationClass,
    ladderRank: representationLadderRank(selected.representationClass),
    decisionRecord: record,
  };
}
