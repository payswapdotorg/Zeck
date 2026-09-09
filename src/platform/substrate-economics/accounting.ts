/**
 * Substrate-selection accounting (platform substrate-economics plane;
 * WORK-054 / E1.1 charter wave member 4 — ADR-0019, ADR-0020).
 *
 * THE WORK-049 DECISION-RECORD RIDE: a material substrate selection
 * (the least-expense-sufficient choice among declared candidates) is
 * recorded as an `OptimizationDecisionRecord` through the foundation's
 * OWN `buildOptimizationDecision` contract — exactly the WORK-052
 * accounting precedent — and appended by the caller through the
 * EXISTING `SqlOptimizationDecisionStore` at its seam:
 *
 *  - the governing constraints are the IR's OWN constraint set (the
 *    selection constraints are derived from it read-only, and this
 *    module FAILS CLOSED when the selection record's constraints do
 *    not match the derivation — a selection accounted against
 *    constraints it was not selected under is unprovenanced and is
 *    rejected before the record exists);
 *  - every SUFFICIENT (substrate, mode) verdict becomes one candidate
 *    representation of the SAME representation class (the substrate
 *    choice routes WHERE the work runs — ADR-0020's "alternative
 *    compute substrate" — it does not change the work's representation
 *    class), carrying the composite claim: expected cost = the
 *    expected successful-resolution cost (startup + execution,
 *    reliability-adjusted — the WORK-049 formula), expected latency =
 *    the TOTAL readiness + execution latency, quality/reliability from
 *    the substrate's execution claim, and the explicit basis naming
 *    the selection record (bounded attribution);
 *  - the selected candidate is the selection's winner (the foundation
 *    re-validates the selection discipline: the selected candidate
 *    must satisfy the quality threshold — quality-preserving
 *    economics — and the record is rejected before it exists if any
 *    hard constraint is violated);
 *  - the transformation basis is `representation-substitution` with a
 *    bounded detail carrying the exact substrate/mode/provenance
 *    (substrate identity + version + mode + adapterRef + selectionId +
 *    factsDigest) — the ADR-0020 "alternative compute substrate"
 *    substitution;
 *  - provenance rides the FOUNDATION's own chain (planId → irId →
 *    decision; `recordedVia: execution-ir-foundation`) — this plane
 *    holds NO store, NO SQL, NO migration (architecture invariant 8:
 *    the sole durable surface remains the WORK-049 decision-record
 *    store; the migration count stays 29).
 *
 * The record is EVIDENCE ONLY (invariant 5 / ADR-0020): nothing here
 * or anywhere consults it for authorization; budgets, policy,
 * capabilities and the sandbox admission path remain the authorities.
 */

import type { OptimizationConstraint } from "../execution-ir/constraints";
import { validateConstraintSet } from "../execution-ir/constraints";
import type { CandidateRepresentation, RepresentationClass } from "../execution-ir/cost-model";
import { REPRESENTATION_CLASSES } from "../execution-ir/cost-model";
import type { OptimizationDecisionRecord } from "../execution-ir/decision-record";
import { buildOptimizationDecision } from "../execution-ir/decision-record";
import type { ExecutionIr, IrDigestPort } from "../execution-ir/ir";
import { boundedDetail, rejectSubstrate } from "./catalog";
import type { SubstrateSelectionResult } from "./selection";
import { deriveSelectionConstraints } from "./selection";

const CANDIDATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DETAIL_MAX = 500;

/** The accounting input — everything the record needs, explicitly. */
export interface SubstrateAccountingInput {
  readonly applicationId: string;
  readonly tenantId: string;
  /** The execution this selection belongs to, when plan-bound. */
  readonly executionId?: string;
  /** The derived (validated) Execution IR the selection routes. */
  readonly ir: ExecutionIr;
  /** The IR's governing constraint set (validated; must carry the hard quality floor). */
  readonly constraints: readonly OptimizationConstraint[];
  /** The selection result (must carry a SELECTED outcome). */
  readonly selection: SubstrateSelectionResult;
  /**
   * The representation class of the work being substrate-routed
   * (caller-declared from the frozen ladder — e.g.
   * `programmatic-execution` for sandboxed programmatic work). The
   * substrate choice never changes the work's representation class.
   */
  readonly representationClass: RepresentationClass;
  /** The compiled variant identity, when the selection rides post-compilation. */
  readonly variantIrId?: string;
  readonly recordedAt: string;
}

function candidateIdOf(substrateId: string, mode: string): string {
  const candidateId = `substrate-${substrateId}-${mode}`;
  if (!CANDIDATE_ID_PATTERN.test(candidateId)) {
    rejectSubstrate("accounting-shape", "candidate id derivation left the neutral slug universe", {
      candidateId: boundedDetail(candidateId),
    });
  }
  return candidateId;
}

/**
 * Build the substrate-selection accounting record — a WORK-049
 * `OptimizationDecisionRecord` through the foundation's own builder,
 * with the selection's composite claims as candidates and the
 * selection's winner as the selected representation.
 *
 * Fail-closed BEFORE the record exists:
 *  - the selection outcome must be `selected` (a no-selection is not
 *    an optimization decision — its evidence is the selection record
 *    itself);
 *  - the selection constraints must be the READ-ONLY derivation of the
 *    IR's own constraint set (provenance coherence — a mismatch is a
 *    typed rejection, never a silent re-derivation);
 *  - the representation class must be on the frozen ladder;
 *  - the foundation's own validation (claims, selection, hard
 *    constraints, quality threshold) applies WHOLESALE.
 */
export function buildSubstrateAccountingRecord(
  input: SubstrateAccountingInput,
  digest: IrDigestPort,
): OptimizationDecisionRecord {
  if (input.selection.outcome !== "selected" || input.selection.selected === null) {
    rejectSubstrate(
      "accounting-shape",
      "only a SELECTED substrate selection can be accounted as an optimization decision (a no-selection is the selection record's own evidence)",
      { outcome: input.selection.outcome },
    );
  }
  if (
    typeof input.representationClass !== "string" ||
    !(REPRESENTATION_CLASSES as readonly string[]).includes(input.representationClass)
  ) {
    rejectSubstrate(
      "accounting-shape",
      "representationClass must be on the frozen foundation ladder",
      {
        got: boundedDetail(input.representationClass),
      },
    );
  }
  const constraints = validateConstraintSet(input.constraints);
  const derived = deriveSelectionConstraints(constraints);
  // Provenance coherence: the selection must have been selected under
  // EXACTLY the constraints derivable from the IR's set (read-only).
  const selectionConstraints = input.selection.record.constraints;
  if (JSON.stringify(selectionConstraints) !== JSON.stringify(derived.constraints)) {
    rejectSubstrate(
      "accounting-shape",
      "the selection record's constraints do not match the read-only derivation of the IR's constraint set (unprovenanced selection accounting)",
      {
        derived: boundedDetail(derived.constraints),
        selection: boundedDetail(selectionConstraints),
      },
    );
  }
  const sourceConstraintIds = input.selection.record.sourceConstraintIds;
  const expectedSourceIds = derived.sourceConstraintIds;
  if (
    JSON.stringify([...sourceConstraintIds].sort()) !==
    JSON.stringify([...expectedSourceIds].sort())
  ) {
    rejectSubstrate(
      "accounting-shape",
      "the selection record's source constraint provenance is incoherent",
      {
        expected: boundedDetail(expectedSourceIds),
        got: boundedDetail(sourceConstraintIds),
      },
    );
  }

  const selected = input.selection.selected;
  const selectionId = input.selection.record.selectionId;
  const factsDigest = input.selection.record.provenance.factsDigest;
  const basisSource = `substrate-economics:${selectionId}`.slice(0, 200);

  const candidates: CandidateRepresentation[] = input.selection.verdicts
    .filter((verdict) => verdict.sufficient)
    .map((verdict) => ({
      candidateId: candidateIdOf(verdict.substrateId, verdict.mode),
      representationClass: input.representationClass,
      ...(input.variantIrId === undefined ? {} : { variantIrId: input.variantIrId }),
      claim: {
        expectedCostMicroUsd: verdict.economics.expectedSuccessfulResolutionCostMicroUsd,
        expectedLatencyMs: verdict.economics.totalLatencyMs,
        expectedQuality: verdict.economics.execution.expectedQuality,
        expectedReliability: verdict.economics.execution.expectedReliability,
        basis: {
          basis: verdict.economics.execution.basis.basis,
          source: basisSource,
          ...(verdict.economics.execution.basis.evidenceDigest === undefined
            ? {}
            : { evidenceDigest: verdict.economics.execution.basis.evidenceDigest }),
        },
      },
    }));

  if (candidates.length === 0) {
    rejectSubstrate(
      "accounting-shape",
      "a selected outcome must carry at least one sufficient candidate",
    );
  }

  const detail =
    `substrate ${selected.substrateId}@${selected.version} mode ${selected.mode} via adapter ${selected.adapterRef}; selection ${selectionId}; facts ${factsDigest}`.slice(
      0,
      DETAIL_MAX,
    );

  return buildOptimizationDecision(
    {
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
      ir: input.ir,
      constraints,
      candidates,
      selectedCandidateId: candidateIdOf(selected.substrateId, selected.mode),
      qualityThreshold: derived.constraints.minQuality,
      transformationBasis: {
        code: "representation-substitution",
        detail,
      },
      recordedAt: input.recordedAt,
    },
    digest,
  );
}
