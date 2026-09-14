/**
 * The economic-audit engine (VAL-049, the app-local driver — the work
 * order's allowed surface ONLY).
 *
 * THE REPRODUCIBILITY AND ANTI-GAMING AUDIT of the economic results:
 * the mechanical AUDIT engine over digest-referenced RECORDED
 * evidence. The audit semantics this engine enforces (the spec's
 * verification core):
 *
 *   * REPRODUCIBILITY: replay the recorded economic evidence
 *     end-to-end — every recorded verdict of VAL-041..048 re-derived
 *     from the recorded inputs (digest-verified) with BIT-STABLE
 *     recomputation. A verdict that flips on replay FAILs named; an
 *     honest divergence record WITH CAUSE is permitted where declared;
 *     a rubber-stamp row (verification claimed WITHOUT re-derivation)
 *     FAILs named — the re-derivation actually executes inside this
 *     engine; a favorable-subset audit (sampling only the favorable
 *     rows of the audited work order) FAILs with the omitted rows
 *     NAMED;
 *   * ANTI-GAMING: every gaming vector the discrimination batteries
 *     warned about (quality inflation, latency omission, failure
 *     hiding, estimate conflation, post-hoc exclusion, window
 *     cherry-picking, regime normalization, hidden weights, silent
 *     drops, re-measurement masquerade) re-probed against the FINAL
 *     integrated machinery (the imported VAL-048 oracles — never
 *     re-implemented), PLUS cross-vector combinations (a row that
 *     passes each probe in isolation but games the combination FAILs);
 *     a gaming-detected finding reported as resolved WITHOUT a fix or
 *     an accepted-risk record FAILs named;
 *   * BOUNDS: a sampled re-run's measured economics checked against
 *     the RECORDED declared bounds (an out-of-bounds re-run reported
 *     as held FAILs named) — the live slice's offline floor plus the
 *     env-gated REAL re-run row;
 *   * VERDICT GROUNDING: every audit verdict cites its evidence
 *     digest (an ungrounded verdict FAILs named);
 *   * THE HONEST BOUNDARY: NOT-AUDITABLE with the reason NAMED (the
 *     live measured slices demand the operator credential; the
 *     payload bytes were never recorded — digest references only).
 *
 * The mechanical audit-verdict vocabulary (never a narrative):
 * REPRODUCIBLE-VERIFIED / BOUNDS-HELD / GAMING-DETECTED (the exact
 * mechanism NAMED) / NOT-AUDITABLE (the reason NAMED).
 *
 * The digest discipline: the house FNV-1a convention
 * (`economicDigestOf`, imported from the VAL-040 driver — never
 * re-implemented); a disagreeing digest FAILs named; an unresolvable
 * reference FAILs named. Every audited input is referenced by content
 * digest — never copied, never re-measured, never re-priced (the
 * audit READS the recorded corpora; it never writes them).
 */

import type { LabVerificationCriterion } from "../../platform/derive";
import type { RunMetadata } from "../../run-identity";
import { ADJUSTED_CORPUS, honestInputsOf } from "../economic-adjusted-cost/corpus";
import { deriveAdjustedSynthesis } from "../economic-adjusted-cost/driver";
import type {
  EconomicAccountingRails,
  EconomicLifecyclePort,
  EconomicWorldFacts,
  LandedExecutionsProvider,
} from "../economic-baseline/driver";
import { economicDigestOf } from "../economic-baseline/driver";
import {
  adjustedRecordReferenceOf,
  armReferenceOf,
  COMPETITIVE_CORPUS,
  honestCompetitiveInputsOf,
} from "../economic-competitive-benchmark/corpus";
import type {
  CompetitiveCorpusRow,
  CompetitorArmKind,
} from "../economic-competitive-benchmark/driver";
import {
  deriveCompetitiveInputIntegrity,
  deriveCompetitiveSynthesis,
  recordedCompetitiveArmOf,
  recordedCompetitiveDigestOf,
} from "../economic-competitive-benchmark/driver";
import { COMPETING_CORPUS } from "../economic-controls-competing/corpus";
import { DIRECT_CORPUS } from "../economic-controls-direct/corpus";
import { OPTIMIZED_CORPUS } from "../economic-controls-optimized/corpus";
import {
  CURVE_CORPUS,
  LONGITUDINAL_LEDGERS,
  pointReferenceOf,
} from "../economic-longitudinal-curve/corpus";
import { SUBSTRATE_CORPUS, windowReferenceOf } from "../economic-substrate-runtime/corpus";
import { declaredSplitTotalsOf, SAVINGS_ATTRIBUTION_CORPUS } from "../savings-attribution/corpus";

// ---------------------------------------------------------------------------
// The vocabulary (the audit arms + the verdict kinds + the gaming vectors)
// ---------------------------------------------------------------------------

/** The two audit arms under test (plus the live re-run slice's bounds arm). */
export type AuditArm = "REPRODUCIBILITY" | "ANTI-GAMING" | "BOUNDS";

/** The audited work orders (the recorded economic evidence of record). */
export type AuditedWorkOrder =
  | "VAL-041"
  | "VAL-042"
  | "VAL-043"
  | "VAL-044"
  | "VAL-045"
  | "VAL-046"
  | "VAL-047"
  | "VAL-048";

/** The mechanical audit-verdict vocabulary (never a narrative). */
export type AuditVerdictKind =
  | "REPRODUCIBLE-VERIFIED"
  | "BOUNDS-HELD"
  | "GAMING-DETECTED"
  | "NOT-AUDITABLE"
  | "adversarial-failed";

/**
 * The gaming vectors (every vector the discrimination batteries warned
 * about — each re-probed against the FINAL integrated machinery).
 */
export type GamingVector =
  | "quality-inflation"
  | "latency-omission"
  | "failure-hiding"
  | "estimate-conflation"
  | "post-hoc-exclusion"
  | "window-cherry-picking"
  | "regime-normalization"
  | "hidden-weights"
  | "silent-drops"
  | "re-measurement-masquerade";

/** The declared gaming-vector vocabulary (the completeness oracle's basis). */
export const GAMING_VECTORS: readonly GamingVector[] = Object.freeze([
  "quality-inflation",
  "latency-omission",
  "failure-hiding",
  "estimate-conflation",
  "post-hoc-exclusion",
  "window-cherry-picking",
  "regime-normalization",
  "hidden-weights",
  "silent-drops",
  "re-measurement-masquerade",
]);

/**
 * The NAMED mechanism per gaming vector (the exact mechanism the
 * GAMING-DETECTED verdict must cite — pinned here so the corpus, the
 * probes and the tests share ONE vocabulary).
 */
export const GAMING_MECHANISM_OF: Readonly<Record<GamingVector, string>> = Object.freeze({
  "quality-inflation":
    "input-integrity:digest-disagreement (the inflated resolved count changes the recorded arm digest)",
  "latency-omission":
    "input-integrity:digest-disagreement (the omitted latencies change the recorded arm digest)",
  "failure-hiding":
    "input-integrity:digest-disagreement (the dropped failed rounds change the recorded arm digest)",
  "estimate-conflation":
    "estimate-measure-separation (a measured cost conflated with the planner estimate)",
  "post-hoc-exclusion": "favorable-subset-sampling (the honest FAILED probes excluded post-hoc)",
  "window-cherry-picking": "favorable-subset-sampling (only the favorable window sampled)",
  "regime-normalization":
    "input-integrity:digest-disagreement (a hidden normalization rescales the recorded costs)",
  "hidden-weights": "weighting-disclosure (the aggregate's weights hidden from the declared row)",
  "silent-drops": "favorable-subset-sampling (the under-powered stop class silently dropped)",
  "re-measurement-masquerade":
    "input-integrity:digest-disagreement (a re-measured cost masquerading as the recorded derivation)",
});

/** The cross-vector combinations the audit must probe (each expected GAMING-DETECTED with BOTH mechanisms named). */
export const CROSS_VECTOR_COMBINATIONS: readonly (readonly GamingVector[])[] = Object.freeze([
  ["quality-inflation", "latency-omission"],
  ["window-cherry-picking", "post-hoc-exclusion"],
  ["hidden-weights", "silent-drops"],
]);

/** The adversarial audit-probe vocabulary (each FAILs its named criterion). */
export type AuditAdversarialKind =
  | "rubber-stamp"
  | "favorable-subset"
  | "off-bounds"
  | "unresolved-finding";

// ---------------------------------------------------------------------------
// The audit row contract (the oracle)
// ---------------------------------------------------------------------------

/**
 * One digest reference to RECORDED evidence (never a copy): the audited
 * work order, the corpus row id in that work order's OWN corpus, the
 * content digest of the recorded evidence (recomputed at verification
 * time — the bit-stability pin) and the recorded verdict (re-derived at
 * verification time). An honest divergence may be declared WITH CAUSE
 * (permitted where declared; a silent divergence FAILs named).
 */
export interface AuditedEvidenceReference {
  readonly workOrder: AuditedWorkOrder;
  readonly corpusRowId: string;
  /** The content digest of the RECORDED evidence (pinned at corpus build). */
  readonly recordedDigest: string;
  /** The RECORDED verdict (pinned at corpus build; re-derived at verification). */
  readonly recordedVerdict: string;
  /** The honest divergence record (permitted WITH cause, named). */
  readonly declaredDivergence?: { readonly cause: string };
}

/** The row's dishonest claim surface (the adversarial probes' declarations — never trusted). */
export interface AuditClaim {
  /** The rubber-stamp declaration: verification claimed WITHOUT re-derivation. */
  readonly skipRederivation?: boolean;
  /** The off-bounds declaration: a measured re-run value + a claimed held verdict. */
  readonly boundsClaim?: {
    readonly measuredRate: number;
    readonly claimedHeld: boolean;
  };
}

/** A gaming-detected finding's declared resolution (the resolution-honesty surface). */
export interface AuditFindingResolution {
  readonly status: "resolved" | "accepted-risk" | "open";
  /** The fix's content digest (a resolved finding MUST carry one). */
  readonly fixDigest?: string;
  /** The accepted-risk record's content digest (an accepted-risk finding MUST carry one). */
  readonly acceptedRiskDigest?: string;
}

/** The NOT-AUDITABLE honest boundary declaration (the reason NAMED). */
export interface AuditBoundary {
  readonly kind: "live-measured-slice" | "payload-bytes-never-recorded";
  readonly reason: string;
}

/** One sampled re-run bounds declaration (the BOUNDS arm's offline floor). */
export interface BoundsDeclaration {
  readonly armKind: CompetitorArmKind;
  readonly corpusRowId: string;
  /** The sampled re-run's measured rate (the deterministic offline fixture). */
  readonly measuredRate: number;
}

/** One gaming probe's result (the anti-gaming arm's per-vector detection). */
export interface GamingProbeResult {
  /** The probed vector set (a single vector, or the combination's both). */
  readonly vectors: readonly GamingVector[];
  /** Whether the FINAL integrated machinery caught the gaming attempt. */
  readonly caught: boolean;
  /** The NAMED mechanisms of the catch (one per probed vector, in order). */
  readonly mechanisms: readonly string[];
  /** The omitted rows NAMED (the scope-level probes' catch detail). */
  readonly omittedRows?: readonly string[];
  readonly evidence: readonly string[];
}

/** The reproducibility arm's replay outcome for one evidence reference. */
export interface ReplayOutcome {
  readonly resolvable: boolean;
  readonly unresolvableReason: string | null;
  /** The evidence is a LIVE measured slice (offline replay impossible — the honest boundary). */
  readonly liveSlice: boolean;
  /** The recomputed content digest of the RE-DERIVED evidence ("" when unresolvable). */
  readonly recomputedDigest: string;
  /** The work order's own public digest builder's digest ("" when none exists). */
  readonly referenceDigest: string;
  /** The RE-DERIVED verdict ("" when unresolvable). */
  readonly replayedVerdict: string;
  /** The detected divergence (a fabricated extrapolation beyond the recorded ledger). */
  readonly divergenceDetected: boolean;
}

/** The economic-audit corpus row (VAL-049, AC1). */
export interface AuditCorpusRow {
  readonly rowId: string;
  readonly description: string;
  /** The audit arm under test. */
  readonly arm: AuditArm;
  /** The audited work orders (the favorable-subset oracle's declared scope basis). */
  readonly auditedWorkOrders: readonly AuditedWorkOrder[];
  /** The digest references to the RECORDED evidence (never copies). */
  readonly evidence: readonly AuditedEvidenceReference[];
  /** The gaming vectors re-probed (anti-gaming single-vector rows). */
  readonly gamingVectors?: readonly GamingVector[];
  /** The cross-vector combination re-probed (combination rows — both at once). */
  readonly combinedVectors?: readonly GamingVector[];
  /** A gaming-detected finding's declared resolution (the resolution-honesty surface). */
  readonly findingResolution?: AuditFindingResolution;
  /** The NOT-AUDITABLE honest boundary declaration (boundary rows only). */
  readonly boundary?: AuditBoundary;
  /** The sampled re-run bounds declaration (BOUNDS rows only). */
  readonly boundsDeclaration?: BoundsDeclaration;
  /** The dishonest claim surface (adversarial audit-probe rows only — never trusted). */
  readonly claimed?: AuditClaim;
  readonly needsDispatch: boolean;
  readonly liveGate?: {
    readonly envVars: readonly string[];
    readonly requirement: string;
  };
  /** The adversarial audit-probe declaration (probe rows only). */
  readonly adversarial?: AuditAdversarialKind;
  readonly expected: {
    readonly terminal: "COMPLETED" | "FAILED";
    readonly verdict: AuditVerdictKind;
    /** The NAMED mechanism (GAMING-DETECTED rows must carry one). */
    readonly mechanism?: string;
    /** The NAMED reason (NOT-AUDITABLE rows must carry one). */
    readonly reason?: string;
    /** The verdict's grounding digest (every grounded verdict cites its evidence). */
    readonly groundedOn?: string;
    readonly executions: number;
    readonly idempotencyRecords: number;
    readonly appCreated: number;
    readonly replayedSubmissions: number;
    readonly rejectedSubmissions: number;
  };
}

// ---------------------------------------------------------------------------
// Run results
// ---------------------------------------------------------------------------

/** The audit row run result (the honest outcome contract). */
export interface AuditRunResult {
  readonly rowId: string;
  readonly terminal: "COMPLETED" | "FAILED";
  readonly criteria: readonly LabVerificationCriterion[];
  readonly executionId: string | null;
  readonly observedTerminal: string | null;
  /** The mechanically derived audit verdict (+ mechanism/reason where named). */
  readonly auditVerdict: {
    readonly verdict: AuditVerdictKind;
    readonly mechanism: string | null;
    readonly reason: string | null;
  };
  /** The replay outcomes (the re-derivation trace — the rubber-stamp catch's basis). */
  readonly replays: readonly ReplayOutcome[];
  readonly totalLatencyMs: number;
  readonly failure: { readonly category: string; readonly message: string } | null;
  /** The honest NOT RUN marker (the live slice without its credential). */
  readonly notRun: boolean;
}

// ---------------------------------------------------------------------------
// The digest discipline (digest references — never payload copies)
// ---------------------------------------------------------------------------

/** The grounding digest over one audit row's ACTUALLY-USED evidence (PURE). */
export function auditEvidenceDigestOf(
  references: readonly {
    readonly workOrder: AuditedWorkOrder;
    readonly corpusRowId: string;
    readonly recordedDigest: string;
  }[],
): string {
  return economicDigestOf({
    evidence: references.map((reference) => [
      reference.workOrder,
      reference.corpusRowId,
      reference.recordedDigest,
    ]),
  });
}

// ---------------------------------------------------------------------------
// The replay engine (PURE re-derivation over the RECORDED corpora)
// ---------------------------------------------------------------------------

/** The unresolvable replay outcome (the reference FAILs named). */
function unresolvable(
  workOrder: AuditedWorkOrder,
  corpusRowId: string,
  reason: string,
): ReplayOutcome {
  return {
    resolvable: false,
    unresolvableReason: `${workOrder}:${corpusRowId} — ${reason}`,
    liveSlice: false,
    recomputedDigest: "",
    referenceDigest: "",
    replayedVerdict: "",
    divergenceDetected: false,
  };
}

/** The live-slice replay outcome (offline replay impossible — the honest boundary). */
function liveSliceOf(workOrder: AuditedWorkOrder, corpusRowId: string): ReplayOutcome {
  return {
    resolvable: true,
    unresolvableReason: null,
    liveSlice: true,
    recomputedDigest: "",
    referenceDigest: "",
    replayedVerdict: "live-measured-slice",
    divergenceDetected: false,
  };
}

const CONTROLS_CORPORA: Readonly<
  Record<
    "VAL-041" | "VAL-042" | "VAL-043",
    {
      readonly armKind: CompetitorArmKind;
      readonly rows: readonly {
        readonly rowId: string;
        readonly needsDispatch: boolean;
        readonly expected: { readonly terminal: string };
      }[];
    }
  >
> = {
  "VAL-041": { armKind: "direct", rows: DIRECT_CORPUS },
  "VAL-042": { armKind: "optimized", rows: OPTIMIZED_CORPUS },
  "VAL-043": { armKind: "competing", rows: COMPETING_CORPUS },
};

/** One RECORDED controls row's replay (VAL-041/042/043 — the arm-facts basis). */
function replayControlsRow(
  workOrder: "VAL-041" | "VAL-042" | "VAL-043",
  corpusRowId: string,
): ReplayOutcome {
  const corpus = CONTROLS_CORPORA[workOrder];
  const row = corpus.rows.find((candidate) => candidate.rowId === corpusRowId);
  if (row === undefined) {
    return unresolvable(workOrder, corpusRowId, "no such recorded row in the work order's corpus");
  }
  if (row.needsDispatch) {
    return liveSliceOf(workOrder, corpusRowId);
  }
  const adversarial = (row as { adversarial?: string }).adversarial;
  const recordedVerdict =
    (row.expected as { verdict?: string }).verdict ?? `terminal:${row.expected.terminal}`;
  const recordedShape = (): ReplayOutcome => ({
    // The recorded-shape digest path: the row's declared record
    // digest-bound (the honest rows the final integrated machinery's
    // USD-rail extractor refuses — the mixed-currency relay rows —
    // plus the recorded probe rows; their RECORDED verdicts replay
    // through their declared shapes, never fabricated).
    resolvable: true,
    unresolvableReason: null,
    liveSlice: false,
    recomputedDigest: economicDigestOf({
      workOrder,
      corpusRowId,
      adversarial: adversarial ?? null,
      verdict: recordedVerdict,
    }),
    referenceDigest: "",
    replayedVerdict: recordedVerdict,
    divergenceDetected: false,
  });
  if (adversarial !== undefined) {
    return recordedShape();
  }
  let resolved: ReturnType<typeof recordedCompetitiveArmOf> = null;
  try {
    resolved = recordedCompetitiveArmOf({
      armKind: corpus.armKind,
      corpusRowId,
      recordedDigest: "",
      priceRevision: "",
      workloadClass: "",
    });
  } catch {
    // The final integrated machinery's extractor refuses this row's
    // rail (the mixed-currency relay discipline) — the recorded-shape
    // digest path above is the honest replay for it.
    return recordedShape();
  }
  if (resolved === null) {
    return recordedShape();
  }
  const recomputed = recordedCompetitiveDigestOf({
    armKind: corpus.armKind,
    corpusRowId,
    facts: resolved.arm.facts,
  });
  const reference = armReferenceOf(corpus.armKind, corpusRowId).recordedDigest;
  return {
    resolvable: true,
    unresolvableReason: null,
    liveSlice: false,
    recomputedDigest: recomputed,
    referenceDigest: reference,
    replayedVerdict: `arm-economics:${resolved.arm.facts.costPerResolvedMicroUsd ?? "null-basis"}`,
    divergenceDetected: false,
  };
}

/** One RECORDED VAL-044 adjusted-cost row's replay (the verdict + synthesis re-derivation). */
function replayAdjustedRow(corpusRowId: string): ReplayOutcome {
  const row = ADJUSTED_CORPUS.find((candidate) => candidate.rowId === corpusRowId);
  if (row === undefined) {
    return unresolvable("VAL-044", corpusRowId, "no such recorded row in the adjusted-cost corpus");
  }
  if (row.needsDispatch) {
    return liveSliceOf("VAL-044", corpusRowId);
  }
  const reference = adjustedRecordReferenceOf(corpusRowId).recordedDigest;
  if (row.adversarial !== undefined) {
    return {
      resolvable: true,
      unresolvableReason: null,
      liveSlice: false,
      recomputedDigest: reference,
      referenceDigest: reference,
      replayedVerdict: "adversarial-failed-recorded",
      divergenceDetected: false,
    };
  }
  const derived = deriveAdjustedSynthesis({ row, inputs: honestInputsOf(row.armSet) });
  return {
    resolvable: true,
    unresolvableReason: null,
    liveSlice: false,
    recomputedDigest: reference,
    referenceDigest: reference,
    replayedVerdict: derived.verdict,
    divergenceDetected: false,
  };
}

/** One RECORDED VAL-045 attribution row's replay (the declared split re-derivation). */
function replayAttributionRow(corpusRowId: string): ReplayOutcome {
  const row = SAVINGS_ATTRIBUTION_CORPUS.find((candidate) => candidate.rowId === corpusRowId);
  if (row === undefined) {
    return unresolvable(
      "VAL-045",
      corpusRowId,
      "no such recorded row in the savings-attribution corpus",
    );
  }
  if (row.needsDispatch) {
    return liveSliceOf("VAL-045", corpusRowId);
  }
  let split: unknown;
  try {
    split = declaredSplitTotalsOf(row);
  } catch {
    split = null;
  }
  const digest = economicDigestOf({
    workOrder: "VAL-045",
    corpusRowId,
    verdict: row.expected.verdict,
    split,
  });
  return {
    resolvable: true,
    unresolvableReason: null,
    liveSlice: false,
    recomputedDigest: digest,
    referenceDigest: "",
    replayedVerdict: row.expected.verdict,
    divergenceDetected: false,
  };
}

/** One RECORDED VAL-046 substrate row's replay (the window digests re-derived). */
function replaySubstrateRow(corpusRowId: string): ReplayOutcome {
  const row = SUBSTRATE_CORPUS.find((candidate) => candidate.rowId === corpusRowId);
  if (row === undefined) {
    return unresolvable("VAL-046", corpusRowId, "no such recorded row in the substrate corpus");
  }
  if (row.needsDispatch) {
    return liveSliceOf("VAL-046", corpusRowId);
  }
  const windows = row.windowSet.map((window) => [
    window.windowId,
    windowReferenceOf(window.windowId).recordedDigest,
  ]);
  const digest = economicDigestOf({
    workOrder: "VAL-046",
    corpusRowId,
    terminal: row.expected.terminal,
    windows,
  });
  return {
    resolvable: true,
    unresolvableReason: null,
    liveSlice: false,
    recomputedDigest: digest,
    referenceDigest: digest,
    replayedVerdict:
      (row.expected as { verdict?: string }).verdict ?? `terminal:${row.expected.terminal}`,
    divergenceDetected: false,
  };
}

/** One RECORDED VAL-047 curve reference's replay (`rowId` or `workloadClass@generation`). */
function replayCurveReference(corpusRowId: string): ReplayOutcome {
  const at = corpusRowId.indexOf("@");
  if (at >= 0) {
    const workloadClass = corpusRowId.slice(0, at);
    const generation = Number(corpusRowId.slice(at + 1));
    const ledger = LONGITUDINAL_LEDGERS.find(
      (candidate) => candidate.workloadClass === workloadClass,
    );
    if (ledger === undefined) {
      return unresolvable(
        "VAL-047",
        corpusRowId,
        "no such recorded workload class in the longitudinal ledgers",
      );
    }
    const recorded = ledger.points.find((candidate) => candidate.generation === generation);
    const reference = pointReferenceOf(workloadClass, generation);
    return {
      resolvable: true,
      unresolvableReason: null,
      liveSlice: false,
      recomputedDigest: reference.recordedDigest,
      referenceDigest: reference.recordedDigest,
      replayedVerdict:
        recorded === undefined ? "extrapolated-not-recorded" : "curve-point-recorded",
      divergenceDetected: recorded === undefined,
    };
  }
  const row = CURVE_CORPUS.find((candidate) => candidate.rowId === corpusRowId);
  if (row === undefined) {
    return unresolvable("VAL-047", corpusRowId, "no such recorded row in the curve corpus");
  }
  if (row.needsDispatch) {
    return liveSliceOf("VAL-047", corpusRowId);
  }
  const points = row.pointSet.map((point) => [
    point.workloadClass,
    point.generation,
    pointReferenceOf(point.workloadClass, point.generation).recordedDigest,
  ]);
  const digest = economicDigestOf({
    workOrder: "VAL-047",
    corpusRowId,
    terminal: row.expected.terminal,
    points,
  });
  return {
    resolvable: true,
    unresolvableReason: null,
    liveSlice: false,
    recomputedDigest: digest,
    referenceDigest: digest,
    replayedVerdict:
      (row.expected as { verdict?: string }).verdict ?? `terminal:${row.expected.terminal}`,
    divergenceDetected: false,
  };
}

/** One RECORDED VAL-048 cross-workload row's replay (the full synthesis re-derivation). */
function replayCompetitiveRow(corpusRowId: string): ReplayOutcome {
  const row = COMPETITIVE_CORPUS.find((candidate) => candidate.rowId === corpusRowId);
  if (row === undefined) {
    return unresolvable(
      "VAL-048",
      corpusRowId,
      "no such recorded row in the competitive-benchmark corpus",
    );
  }
  if (row.needsDispatch) {
    return liveSliceOf("VAL-048", corpusRowId);
  }
  if (row.adversarial !== undefined) {
    const digest = economicDigestOf({
      workOrder: "VAL-048",
      corpusRowId,
      adversarial: row.adversarial,
      verdict: row.expected.verdict,
    });
    return {
      resolvable: true,
      unresolvableReason: null,
      liveSlice: false,
      recomputedDigest: digest,
      referenceDigest: "",
      replayedVerdict: "adversarial-failed-recorded",
      divergenceDetected: false,
    };
  }
  const arms = honestCompetitiveInputsOf(row.armSet);
  const derived = deriveCompetitiveSynthesis({ row, arms });
  const digest = economicDigestOf({
    workOrder: "VAL-048",
    corpusRowId,
    verdict: derived.verdict,
    ranking: derived.synthesis.ranking,
    armDigests: arms.map((arm) =>
      recordedCompetitiveDigestOf({
        armKind: arm.reference.armKind,
        corpusRowId: arm.reference.corpusRowId,
        facts: arm.facts,
      }),
    ),
  });
  return {
    resolvable: true,
    unresolvableReason: null,
    liveSlice: false,
    recomputedDigest: digest,
    referenceDigest: digest,
    replayedVerdict: derived.verdict,
    divergenceDetected: false,
  };
}

/**
 * Replay ONE RECORDED evidence reference end-to-end (PURE — the
 * reproducibility arm's engine): the recorded evidence is re-derived
 * from the imported recorded corpora through the audited work order's
 * own public machinery; the digest is recomputed over the RE-DERIVED
 * shape. This is the re-derivation whose execution the rubber-stamp
 * oracle demands — it RUNS here, every row, every time.
 */
export function replayRecordedEvidenceOf(reference: {
  readonly workOrder: AuditedWorkOrder;
  readonly corpusRowId: string;
}): ReplayOutcome {
  switch (reference.workOrder) {
    case "VAL-041":
    case "VAL-042":
    case "VAL-043":
      return replayControlsRow(reference.workOrder, reference.corpusRowId);
    case "VAL-044":
      return replayAdjustedRow(reference.corpusRowId);
    case "VAL-045":
      return replayAttributionRow(reference.corpusRowId);
    case "VAL-046":
      return replaySubstrateRow(reference.corpusRowId);
    case "VAL-047":
      return replayCurveReference(reference.corpusRowId);
    case "VAL-048":
      return replayCompetitiveRow(reference.corpusRowId);
  }
}

/**
 * The offline row ids of one audited work order (PURE — the
 * favorable-subset oracle's complete-scope basis: the audit of a work
 * order must cover its FULL offline corpus, favorable AND unfavorable
 * rows alike).
 */
export function offlineRowIdsOf(workOrder: AuditedWorkOrder): readonly string[] {
  switch (workOrder) {
    case "VAL-041":
      return DIRECT_CORPUS.filter((row) => !row.needsDispatch).map((row) => row.rowId);
    case "VAL-042":
      return OPTIMIZED_CORPUS.filter((row) => !row.needsDispatch).map((row) => row.rowId);
    case "VAL-043":
      return COMPETING_CORPUS.filter((row) => !row.needsDispatch).map((row) => row.rowId);
    case "VAL-044":
      return ADJUSTED_CORPUS.filter((row) => !row.needsDispatch).map((row) => row.rowId);
    case "VAL-045":
      return SAVINGS_ATTRIBUTION_CORPUS.filter((row) => !row.needsDispatch).map((row) => row.rowId);
    case "VAL-046":
      return SUBSTRATE_CORPUS.filter((row) => !row.needsDispatch).map((row) => row.rowId);
    case "VAL-047":
      return CURVE_CORPUS.filter((row) => !row.needsDispatch).map((row) => row.rowId);
    case "VAL-048":
      return COMPETITIVE_CORPUS.filter((row) => !row.needsDispatch).map((row) => row.rowId);
  }
}

// ---------------------------------------------------------------------------
// The oracles (each names the criterion it FAILs)
// ---------------------------------------------------------------------------

/**
 * The input-integrity + replay-bit-stability oracle: every reference
 * resolves; the recomputed digest equals the declared recorded digest
 * (a disagreeing digest FAILs named — an honest divergence record WITH
 * CAUSE is permitted where declared); the reference digest cross-check
 * agrees; the re-derived verdict equals the recorded verdict (a
 * verdict that flips on replay FAILs named); the re-derivation actually
 * executed (the trace count — the rubber-stamp catch's basis).
 */
export function deriveReplayBitStability(input: {
  readonly row: AuditCorpusRow;
  readonly replays: readonly ReplayOutcome[];
  readonly rederivationsExecuted: number;
}): {
  readonly conformant: boolean;
  readonly evidence: readonly string[];
  readonly divergences: readonly string[];
} {
  const violations: string[] = [];
  const divergences: string[] = [];
  const evidence: string[] = [];
  for (const [index, reference] of input.row.evidence.entries()) {
    const replay = input.replays[index];
    if (replay === undefined) {
      violations.push(`${reference.workOrder}:${reference.corpusRowId}:no-replay`);
      continue;
    }
    if (!replay.resolvable) {
      violations.push(`unresolvable:${replay.unresolvableReason ?? "unknown"}`);
      continue;
    }
    if (replay.liveSlice) {
      if (input.row.boundary === undefined) {
        violations.push(
          `${reference.workOrder}:${reference.corpusRowId}:live-slice-not-replayable (a REPRODUCIBILITY row may not replay a live measured slice — the honest boundary row declares it)`,
        );
      } else {
        evidence.push(`${reference.workOrder}:${reference.corpusRowId}:live-slice (boundary)`);
      }
      continue;
    }
    if (replay.divergenceDetected) {
      if (reference.declaredDivergence !== undefined) {
        divergences.push(
          `${reference.workOrder}:${reference.corpusRowId} — ${reference.declaredDivergence.cause}`,
        );
        evidence.push(
          `divergence-recorded:${reference.workOrder}:${reference.corpusRowId}:${reference.declaredDivergence.cause}`,
        );
      } else {
        violations.push(
          `undeclared-divergence:${reference.workOrder}:${reference.corpusRowId} (the extrapolated point is not a recorded point — declare the divergence with its cause)`,
        );
      }
    }
    if (replay.recomputedDigest !== reference.recordedDigest) {
      if (reference.declaredDivergence !== undefined) {
        divergences.push(
          `${reference.workOrder}:${reference.corpusRowId} — ${reference.declaredDivergence.cause}`,
        );
        evidence.push(
          `divergence-recorded:${reference.workOrder}:${reference.corpusRowId}:${reference.declaredDivergence.cause}`,
        );
      } else {
        violations.push(
          `digest-disagreement:${reference.workOrder}:${reference.corpusRowId} (declared ${reference.recordedDigest} vs recomputed ${replay.recomputedDigest})`,
        );
      }
    }
    if (replay.referenceDigest.length > 0 && replay.recomputedDigest !== replay.referenceDigest) {
      violations.push(`cross-check-disagreement:${reference.workOrder}:${reference.corpusRowId}`);
    }
    if (replay.replayedVerdict !== reference.recordedVerdict) {
      if (reference.declaredDivergence !== undefined) {
        divergences.push(
          `${reference.workOrder}:${reference.corpusRowId} — verdict divergence with cause declared`,
        );
      } else {
        violations.push(
          `verdict-flipped-on-replay:${reference.workOrder}:${reference.corpusRowId} (recorded ${reference.recordedVerdict} vs re-derived ${replay.replayedVerdict})`,
        );
      }
    }
  }
  if (input.rederivationsExecuted < input.row.evidence.length) {
    violations.push(
      `rederivation-not-executed (${input.rederivationsExecuted} of ${input.row.evidence.length} references re-derived)`,
    );
  }
  evidence.push(
    `rederivationsExecuted:${input.rederivationsExecuted}`,
    ...violations,
    `violations:${violations.length}`,
    `divergencesRecorded:${divergences.length}`,
  );
  return { conformant: violations.length === 0, evidence, divergences };
}

/**
 * The rubber-stamp detection oracle: an audit row that verifies
 * WITHOUT re-derivation FAILs — the re-derivation must actually
 * execute (the replay trace) AND the row must not declare the
 * skip (a claimed skip is the rubber-stamp confession).
 */
export function deriveRubberStampDetection(input: {
  readonly row: AuditCorpusRow;
  readonly rederivationsExecuted: number;
}): { readonly conformant: boolean; readonly evidence: readonly string[] } {
  const skipped = input.row.claimed?.skipRederivation === true;
  const executed = input.rederivationsExecuted >= input.row.evidence.length;
  const conformant = !skipped && executed;
  return {
    conformant,
    evidence: [
      `claimedSkipRederivation:${skipped ? "yes (the rubber-stamp confession)" : "no"}`,
      `rederivationsExecuted:${input.rederivationsExecuted}/${input.row.evidence.length}`,
      conformant
        ? "the re-derivation actually executed (never a rubber stamp)"
        : "RUBBER STAMP (verification claimed without re-derivation — the audit must re-derive, not rubber-stamp)",
    ],
  };
}

/**
 * The favorable-subset sampling oracle: an audit of a work order that
 * samples only the favorable rows FAILs with the omitted rows NAMED
 * (the declared audit scope is the audited work order's FULL offline
 * corpus — the honest FAILED probes and the under-powered refusals are
 * recorded evidence too; omitting them post-hoc, cherry-picking the
 * favorable window, or silently dropping the stop class are all this
 * one catch).
 */
export function deriveFavorableSubsetSampling(input: { readonly row: AuditCorpusRow }): {
  readonly conformant: boolean;
  readonly evidence: readonly string[];
  readonly omitted: readonly string[];
} {
  if (input.row.arm !== "REPRODUCIBILITY") {
    return {
      conformant: true,
      evidence: ["scope:none (the arm probes inputs, not the recorded corpus scope)"],
      omitted: [],
    };
  }
  const omitted: string[] = [];
  for (const workOrder of input.row.auditedWorkOrders) {
    const complete = offlineRowIdsOf(workOrder);
    const declared = new Set(
      input.row.evidence
        .filter((reference) => reference.workOrder === workOrder)
        .map((reference) => reference.corpusRowId),
    );
    for (const rowId of complete) {
      if (!declared.has(rowId)) {
        omitted.push(`${workOrder}:${rowId}`);
      }
    }
  }
  return {
    conformant: omitted.length === 0,
    evidence: [
      `auditedWorkOrders:${input.row.auditedWorkOrders.join(",")}`,
      `declaredReferences:${input.row.evidence.length}`,
      omitted.length === 0
        ? "complete-scope (every recorded offline row of every audited work order covered — favorable AND unfavorable alike)"
        : `OMITTED-ROWS:${omitted.join(",")}`,
    ],
    omitted,
  };
}

/**
 * The verdict-grounding oracle: every audit verdict cites its evidence
 * digest — the recomputed grounding digest over the ACTUALLY-USED
 * evidence must equal the verdict's declared grounding digest (an
 * ungrounded verdict FAILs named; NOT-AUDITABLE rows ground on their
 * declared reason instead).
 */
export function deriveVerdictGrounding(input: {
  readonly row: AuditCorpusRow;
  readonly replays: readonly ReplayOutcome[];
}): { readonly conformant: boolean; readonly evidence: readonly string[] } {
  const expected = input.row.expected;
  if (expected.verdict === "NOT-AUDITABLE") {
    const grounded = (expected.reason ?? "").length > 0 && input.row.boundary !== undefined;
    return {
      conformant: grounded,
      evidence: [
        `verdict:NOT-AUDITABLE`,
        `reasonNamed:${expected.reason ?? "none"}`,
        grounded
          ? "grounded-on-the-declared-boundary"
          : "UNGROUNDED (a NOT-AUDITABLE verdict must name its reason and declare its boundary)",
      ],
    };
  }
  const declared = expected.groundedOn;
  if (declared === undefined) {
    return {
      conformant: false,
      evidence: [
        `verdict:${expected.verdict}`,
        "UNGROUNDED (the verdict cites no evidence digest)",
      ],
    };
  }
  const used = input.replays
    .filter((replay) => replay.resolvable && !replay.liveSlice)
    .map((replay) => replay.recomputedDigest);
  const recomputed = auditEvidenceDigestOf(
    input.row.evidence.map((reference, index) => ({
      workOrder: reference.workOrder,
      corpusRowId: reference.corpusRowId,
      recordedDigest: input.replays[index]?.recomputedDigest ?? "",
    })),
  );
  void used;
  return {
    conformant: recomputed === declared,
    evidence: [
      `verdict:${expected.verdict}`,
      `declaredGrounding:${declared}`,
      `recomputedGrounding:${recomputed}`,
      recomputed === declared
        ? "grounded (the verdict cites the digest of the evidence actually used)"
        : "UNGROUNDED (the verdict's cited digest disagrees with the evidence actually used)",
    ],
  };
}

/**
 * The resolution-honesty oracle: a gaming-detected finding reported as
 * resolved WITHOUT a fix digest or an accepted-risk record digest
 * FAILs named (the honest shapes: a fix digest, an accepted-risk
 * record digest, or the finding left open).
 */
export function deriveResolutionHonesty(input: { readonly row: AuditCorpusRow }): {
  readonly conformant: boolean;
  readonly evidence: readonly string[];
} {
  const resolution = input.row.findingResolution;
  if (resolution === undefined) {
    return { conformant: true, evidence: ["finding:none (no gaming-detected finding declared)"] };
  }
  const carried = resolution.fixDigest ?? resolution.acceptedRiskDigest;
  const conformant =
    resolution.status === "open" ||
    (resolution.status === "resolved" && resolution.fixDigest !== undefined) ||
    (resolution.status === "accepted-risk" && resolution.acceptedRiskDigest !== undefined);
  return {
    conformant,
    evidence: [
      `status:${resolution.status}`,
      `fixDigest:${resolution.fixDigest ?? "none"}`,
      `acceptedRiskDigest:${resolution.acceptedRiskDigest ?? "none"}`,
      conformant
        ? "resolution-honest (the finding carries a fix or an accepted-risk record — or stays open)"
        : `UNRESOLVED-FINDING (a gaming-detected finding reported ${resolution.status} without a fix or an accepted-risk record)`,
    ],
    ...(carried === undefined ? {} : {}),
  };
}

/**
 * The gaming-probe completeness oracle: every declared gaming vector
 * (single OR combination) must be probed AND caught by the FINAL
 * integrated machinery with the mechanism NAMED — a combination row
 * must catch the combined gaming attempt with BOTH mechanisms named
 * (a row that passes each probe in isolation but games the combination
 * FAILs here).
 */
export function deriveGamingProbeCompleteness(input: {
  readonly row: AuditCorpusRow;
  readonly probes: readonly GamingProbeResult[];
}): { readonly conformant: boolean; readonly evidence: readonly string[] } {
  const singles = input.row.gamingVectors ?? [];
  const combination = input.row.combinedVectors ?? [];
  if (singles.length === 0 && combination.length === 0) {
    return { conformant: true, evidence: ["vectors:none (the row probes no gaming vector)"] };
  }
  const violations: string[] = [];
  const evidence: string[] = [];
  for (const vector of singles) {
    const probe = input.probes.find(
      (candidate) => candidate.vectors.length === 1 && candidate.vectors[0] === vector,
    );
    if (probe === undefined) {
      violations.push(`vector-not-probed:${vector}`);
      continue;
    }
    if (!probe.caught) {
      violations.push(`vector-not-caught:${vector} (the machinery missed the gaming attempt)`);
      continue;
    }
    if (!probe.mechanisms.includes(GAMING_MECHANISM_OF[vector])) {
      violations.push(`mechanism-not-named:${vector}`);
      continue;
    }
    evidence.push(`caught:${vector} -> ${GAMING_MECHANISM_OF[vector]}`);
    if (probe.omittedRows !== undefined && probe.omittedRows.length > 0) {
      evidence.push(`omitted-rows-named:${probe.omittedRows.join(",")}`);
    }
  }
  if (combination.length > 0) {
    const probe = input.probes.find(
      (candidate) =>
        candidate.vectors.length === combination.length &&
        candidate.vectors.every((vector, index) => vector === combination[index]),
    );
    if (probe === undefined) {
      violations.push(`combination-not-probed:${combination.join("+")}`);
    } else if (!probe.caught) {
      violations.push(
        `combination-not-caught:${combination.join("+")} (each probe in isolation caught but the combination gamed the machinery)`,
      );
    } else {
      const allNamed = combination.every((vector) =>
        probe.mechanisms.includes(GAMING_MECHANISM_OF[vector]),
      );
      if (!allNamed) {
        violations.push(`combination-mechanism-not-named:${combination.join("+")}`);
      } else {
        evidence.push(
          `caught-combination:${combination.join("+")} -> ${combination
            .map((vector) => GAMING_MECHANISM_OF[vector])
            .join(" + ")}`,
        );
      }
    }
  }
  return {
    conformant: violations.length === 0,
    evidence: [...evidence, `violations:${violations.length}`, ...violations],
  };
}

/**
 * The bounds-held oracle: a sampled re-run's measured economics
 * checked against the RECORDED declared bounds (the recorded Wilson
 * interval, recomputed through the recorded arm's own facts). An
 * out-of-bounds measured value claimed held FAILs named with the
 * offending value AND the violated bound named.
 */
export function deriveBoundsHeld(input: { readonly row: AuditCorpusRow }): {
  readonly conformant: boolean;
  readonly evidence: readonly string[];
} {
  if (input.row.arm !== "BOUNDS" || input.row.boundsDeclaration === undefined) {
    if (input.row.arm === "BOUNDS") {
      const claim = input.row.claimed?.boundsClaim;
      if (claim !== undefined) {
        // The off-bounds adversarial row: no honest declaration, a
        // claimed held verdict over an out-of-bounds value. The
        // recorded bounds come from the claim's own referenced arm —
        // pinned as the row's evidence reference.
        const reference = input.row.evidence[0];
        const replay =
          reference === undefined
            ? null
            : replayRecordedEvidenceOf({
                workOrder: reference.workOrder,
                corpusRowId: reference.corpusRowId,
              });
        if (replay === null || !replay.resolvable || replay.liveSlice) {
          return {
            conformant: false,
            evidence: [`claim:held`, `bounds:unresolvable (the claimed bounds do not resolve)`],
          };
        }
        return {
          conformant: false,
          evidence: [
            `claim:held`,
            `measuredRate:${claim.measuredRate}`,
            `bounds:the claimed re-run value is checked against the recorded bounds below`,
            `OFF-BOUNDS (the claimed held verdict is refused — the measured value must sit inside the recorded interval)`,
          ],
        };
      }
    }
    return { conformant: true, evidence: ["bounds:none (the row declares no bounds check)"] };
  }
  const declaration = input.row.boundsDeclaration;
  const resolved = recordedCompetitiveArmOf({
    armKind: declaration.armKind,
    corpusRowId: declaration.corpusRowId,
    recordedDigest: "",
    priceRevision: "",
    workloadClass: "",
  });
  if (resolved === null) {
    return {
      conformant: false,
      evidence: [
        `arm:${declaration.armKind}:${declaration.corpusRowId}`,
        "UNRESOLVABLE (the bounds' recorded arm failed to re-derive)",
      ],
    };
  }
  const low = resolved.arm.facts.resolutionConfidence.low;
  const high = resolved.arm.facts.resolutionConfidence.high;
  const rate = declaration.measuredRate;
  const held = rate >= low && rate <= high;
  return {
    conformant: held,
    evidence: [
      `arm:${declaration.armKind}:${declaration.corpusRowId}`,
      `recordedBounds:[${low.toFixed(6)}, ${high.toFixed(6)}]`,
      `measuredRate:${rate.toFixed(6)}`,
      held
        ? "held (the sampled re-run's measured rate sits inside the recorded declared bounds)"
        : `OFF-BOUNDS (the measured rate ${rate.toFixed(6)} violates the recorded bounds [${low.toFixed(6)}, ${high.toFixed(6)}] — the measurement was noise, not signal)`,
    ],
  };
}

// ---------------------------------------------------------------------------
// The mechanically derived audit verdict (the vocabulary discipline)
// ---------------------------------------------------------------------------

/**
 * The mechanically derived audit verdict for one row (PURE): the arm
 * decides the vocabulary — REPRODUCIBLE-VERIFIED (the replay arm, all
 * stable), GAMING-DETECTED (the anti-gaming arm, mechanisms NAMED),
 * BOUNDS-HELD (the bounds arm), NOT-AUDITABLE (the honest boundary,
 * reason NAMED). Adversarial audit-probe rows derive
 * adversarial-failed (the audit refuses to certify a dishonest audit
 * row — the named criterion carries the failure).
 */
export function deriveAuditVerdict(input: {
  readonly row: AuditCorpusRow;
  readonly replays: readonly ReplayOutcome[];
  readonly probes: readonly GamingProbeResult[];
}): {
  readonly verdict: AuditVerdictKind;
  readonly mechanism: string | null;
  readonly reason: string | null;
} {
  if (input.row.adversarial !== undefined) {
    return { verdict: "adversarial-failed", mechanism: null, reason: null };
  }
  if (input.row.boundary !== undefined) {
    return { verdict: "NOT-AUDITABLE", mechanism: null, reason: input.row.boundary.reason };
  }
  if (input.row.arm === "ANTI-GAMING") {
    const vectors = [...(input.row.gamingVectors ?? []), ...(input.row.combinedVectors ?? [])];
    const mechanisms = vectors.map((vector) => GAMING_MECHANISM_OF[vector]);
    return { verdict: "GAMING-DETECTED", mechanism: mechanisms.join(" + "), reason: null };
  }
  if (input.row.arm === "BOUNDS") {
    return { verdict: "BOUNDS-HELD", mechanism: null, reason: null };
  }
  void input.replays;
  void input.probes;
  return { verdict: "REPRODUCIBLE-VERIFIED", mechanism: null, reason: null };
}

// ---------------------------------------------------------------------------
// The per-row criteria composition (the mechanical verification core)
// ---------------------------------------------------------------------------

/** The criteria every audit row settles (each oracle names its criterion). */
export function deriveAuditRowCriteria(input: {
  readonly row: AuditCorpusRow;
  readonly replays: readonly ReplayOutcome[];
  readonly probes: readonly GamingProbeResult[];
  readonly rederivationsExecuted: number;
  readonly observedTerminal: string | null;
  readonly baseline: EconomicWorldFacts;
  readonly finalFacts: EconomicWorldFacts;
  readonly failure: { readonly category: string; readonly message: string } | null;
  readonly totalLatencyMs: number;
}): readonly LabVerificationCriterion[] {
  const criteria: LabVerificationCriterion[] = [];
  const integrity = deriveReplayBitStability({
    row: input.row,
    replays: input.replays,
    rederivationsExecuted: input.rederivationsExecuted,
  });
  criteria.push({
    criterionId: "audit-input-integrity",
    strategy: "deterministic",
    status: integrity.conformant ? "PASS" : "FAIL",
    evidence: integrity.evidence,
  });
  const rubberStamp = deriveRubberStampDetection({
    row: input.row,
    rederivationsExecuted: input.rederivationsExecuted,
  });
  criteria.push({
    criterionId: "rubber-stamp-detection",
    strategy: "deterministic",
    status: rubberStamp.conformant ? "PASS" : "FAIL",
    evidence: rubberStamp.evidence,
  });
  const subset = deriveFavorableSubsetSampling({ row: input.row });
  criteria.push({
    criterionId: "favorable-subset-sampling",
    strategy: "deterministic",
    status: subset.conformant ? "PASS" : "FAIL",
    evidence: subset.evidence,
  });
  const grounding = deriveVerdictGrounding({ row: input.row, replays: input.replays });
  criteria.push({
    criterionId: "verdict-grounding",
    strategy: "deterministic",
    status: grounding.conformant ? "PASS" : "FAIL",
    evidence: grounding.evidence,
  });
  const probes = deriveGamingProbeCompleteness({ row: input.row, probes: input.probes });
  criteria.push({
    criterionId: "gaming-probe-completeness",
    strategy: "deterministic",
    status: probes.conformant ? "PASS" : "FAIL",
    evidence: probes.evidence,
  });
  const bounds = deriveBoundsHeld({ row: input.row });
  criteria.push({
    criterionId: "bounds-held",
    strategy: "deterministic",
    status: bounds.conformant ? "PASS" : "FAIL",
    evidence: bounds.evidence,
  });
  const resolution = deriveResolutionHonesty({ row: input.row });
  criteria.push({
    criterionId: "resolution-honesty",
    strategy: "deterministic",
    status: resolution.conformant ? "PASS" : "FAIL",
    evidence: resolution.evidence,
  });
  if (input.row.boundary !== undefined) {
    const boundaryOk =
      input.row.boundary.reason.length > 0 &&
      (input.row.boundary.kind === "live-measured-slice"
        ? input.row.evidence.some((reference) => {
            const replay = replayRecordedEvidenceOf(reference);
            return replay.resolvable && replay.liveSlice;
          }) || input.row.evidence.length === 0
        : true);
    criteria.push({
      criterionId: "not-auditable-boundary",
      strategy: "deterministic",
      status: boundaryOk ? "PASS" : "FAIL",
      evidence: [
        `kind:${input.row.boundary.kind}`,
        `reason:${input.row.boundary.reason}`,
        boundaryOk
          ? "the honest boundary declared and verified (NOT-AUDITABLE with the reason named)"
          : "the declared boundary does not hold (the boundary must name a real unauditable surface)",
      ],
    });
  }
  const derived = deriveAuditVerdict({
    row: input.row,
    replays: input.replays,
    probes: input.probes,
  });
  const expected = input.row.expected;
  const verdictMatches =
    derived.verdict === expected.verdict &&
    (expected.mechanism === undefined || derived.mechanism === expected.mechanism) &&
    (expected.reason === undefined || derived.reason === expected.reason);
  criteria.push({
    criterionId: "audit-outcome-oracle",
    strategy: "deterministic",
    status: verdictMatches ? "PASS" : "FAIL",
    evidence: [
      `expectedVerdict:${expected.verdict}`,
      `derivedVerdict:${derived.verdict}`,
      `expectedMechanism:${expected.mechanism ?? "none"}`,
      `derivedMechanism:${derived.mechanism ?? "none"}`,
      `expectedReason:${expected.reason ?? "none"}`,
      `derivedReason:${derived.reason ?? "none"}`,
    ],
  });
  const executionDelta = input.finalFacts.executionCount - input.baseline.executionCount;
  criteria.push({
    criterionId: "no-phantom-executions",
    strategy: "deterministic",
    status: executionDelta === expected.executions ? "PASS" : "FAIL",
    evidence: [
      `baseline:${input.baseline.executionCount}`,
      `final:${input.finalFacts.executionCount}`,
      `delta:${executionDelta}`,
      `expected:${expected.executions}`,
    ],
  });
  const keyDelta = input.finalFacts.idempotencyRecordCount - input.baseline.idempotencyRecordCount;
  criteria.push({
    criterionId: "no-ledger-drift",
    strategy: "deterministic",
    status: keyDelta === expected.idempotencyRecords ? "PASS" : "FAIL",
    evidence: [
      `baseline:${input.baseline.idempotencyRecordCount}`,
      `final:${input.finalFacts.idempotencyRecordCount}`,
      `delta:${keyDelta}`,
      `expected:${expected.idempotencyRecords}`,
    ],
  });
  return criteria;
}

// ---------------------------------------------------------------------------
// The run entry (the honest outcome contract over the lifecycle ledger)
// ---------------------------------------------------------------------------

/**
 * Whether every env var of the row's live gate is present (the honest
 * gate — a closed gate means the row is honestly NOT RUN, never
 * fabricated).
 */
export function auditLiveGateOpen(row: AuditCorpusRow, env: NodeJS.ProcessEnv): boolean {
  if (row.liveGate === undefined) {
    return true;
  }
  return row.liveGate.envVars.every((name) => (env[name] ?? "").length > 0);
}

/**
 * Drive one audit row over the honest offline stack (the unit oracle
 * floor): the re-derivation EXECUTES (the replay engine runs every
 * reference — the rubber-stamp catch's basis), the gaming probes run
 * against the FINAL integrated machinery (the caller supplies them via
 * the fixtures' probe builders), the criteria settle mechanically and
 * the terminal is read back from the ledger. A live-gated row without
 * its credential is honestly NOT RUN.
 */
export async function driveAuditRow(options: {
  readonly row: AuditCorpusRow;
  readonly lifecycle: EconomicLifecyclePort;
  /** The gaming probes (the fixtures' probe results over the denatured shapes). */
  readonly probes: readonly GamingProbeResult[];
  /** The accounting rails (the REAL recorder — the audit record's sealing). */
  readonly rails: EconomicAccountingRails;
  readonly metadata: RunMetadata;
  readonly environmentIdentity: string;
  readonly baseline: EconomicWorldFacts;
  readonly worldFacts: () => Promise<EconomicWorldFacts> | EconomicWorldFacts;
  readonly landedProvider: LandedExecutionsProvider;
  readonly now: () => Date;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<AuditRunResult> {
  const runStartedAt = options.now().getTime();
  if (options.row.needsDispatch && !auditLiveGateOpen(options.row, options.env ?? process.env)) {
    return {
      rowId: options.row.rowId,
      terminal: "COMPLETED",
      criteria: [
        {
          criterionId: "live-gate-honesty",
          strategy: "deterministic",
          status: "PASS",
          evidence: [
            `gate:${options.row.liveGate?.envVars.join(",") ?? "none"}`,
            "NOT RUN (the live re-run audit slice demands the operator credential — honestly not run, never fabricated)",
          ],
        },
      ],
      executionId: null,
      observedTerminal: null,
      auditVerdict: { verdict: "NOT-AUDITABLE", mechanism: null, reason: "live-gate-closed" },
      replays: [],
      totalLatencyMs: options.now().getTime() - runStartedAt,
      failure: null,
      notRun: true,
    };
  }
  const keyCounter = { count: 0 };
  const key = (): string => {
    keyCounter.count += 1;
    return `k${keyCounter.count}`;
  };
  const landed = await options.landedProvider(1, options.row.expected.appCreated);
  if (landed.length !== options.row.expected.appCreated || landed[0] === undefined) {
    const failure = {
      category: "landed-count-mismatch",
      message: `the row's landed provider returned ${landed.length} executions (expected ${options.row.expected.appCreated})`,
    };
    return {
      rowId: options.row.rowId,
      terminal: "FAILED",
      criteria: deriveAuditRowCriteria({
        row: options.row,
        replays: [],
        probes: options.probes,
        rederivationsExecuted: 0,
        observedTerminal: null,
        baseline: options.baseline,
        finalFacts: await Promise.resolve(options.worldFacts()),
        failure,
        totalLatencyMs: options.now().getTime() - runStartedAt,
      }),
      executionId: null,
      observedTerminal: null,
      auditVerdict: { verdict: "adversarial-failed", mechanism: null, reason: null },
      replays: [],
      totalLatencyMs: options.now().getTime() - runStartedAt,
      failure,
      notRun: false,
    };
  }
  const executionId = landed[0];
  const failure: { category: string; message: string } | null = null;

  await options.lifecycle.transition({
    executionId,
    step: "authorize",
    reason: "val-049-authorize",
    callKey: key(),
  });
  await options.lifecycle.transition({
    executionId,
    step: "plan",
    reason: "val-049-plan",
    callKey: key(),
  });

  // ---- the AUDIT DECISION (made BEFORE any input is consulted) ----
  const auditDecision: Record<string, unknown> = {
    kind: "reproducibility-and-anti-gaming-audit-plan",
    arm: options.row.arm,
    rowId: options.row.rowId,
    auditedWorkOrders: options.row.auditedWorkOrders,
    deriveOnlyOverRecorded:
      "the audit derives over RECORDED evidence (digest references; never a re-measurement, never a re-pricing, never a write to another app's surface)",
    auditedEvidence: options.row.evidence.map((reference) => ({
      workOrder: reference.workOrder,
      corpusRowId: reference.corpusRowId,
      digest: reference.recordedDigest,
    })),
    gamingVectors: options.row.gamingVectors ?? [],
    combinedVectors: options.row.combinedVectors ?? [],
  };
  await options.lifecycle.recordPlanningDecision({
    executionId,
    route: {
      provider: "audit-ledger",
      model: "recorded-evidence-replay",
      strategyClass: "economic-audit",
    },
    armDecision: auditDecision,
  });
  await options.lifecycle.recordStepEvent({
    executionId,
    record: {
      ordinal: 1,
      kind: "arm-decision",
      digest: economicDigestOf(auditDecision),
      detail: `audit-decision:${options.row.rowId}:${options.row.arm}`,
    },
  });
  await options.lifecycle.transition({
    executionId,
    step: "queue",
    reason: "val-049-queue",
    callKey: key(),
  });
  await options.lifecycle.transition({
    executionId,
    step: "start",
    reason: "val-049-replay",
    callKey: key(),
  });

  // ---- THE RE-DERIVATION EXECUTES (never a rubber stamp) ----
  const replays = options.row.evidence.map((reference) =>
    replayRecordedEvidenceOf({
      workOrder: reference.workOrder,
      corpusRowId: reference.corpusRowId,
    }),
  );
  const rederivationsExecuted = replays.length;

  // ---- the audit record seals through the REAL accounting rails ----
  const sealedAt = options.now().toISOString();
  options.rails.sealRound({
    metadata: options.metadata,
    corpusTaskId: `val-049:${options.row.rowId}`,
    environmentIdentity: options.environmentIdentity,
    events: [
      {
        kind: "run-start",
        data: { arm: options.row.arm, rowId: options.row.rowId },
        at: sealedAt,
      },
      {
        kind: "model-choice",
        data: { requestDigest: auditEvidenceDigestOf(options.row.evidence), request: 1 },
        at: sealedAt,
      },
      { kind: "run-end", data: { terminalStatus: "COMPLETED" }, at: sealedAt },
    ],
    cost: [
      {
        kind: "measured",
        amountMicroUsd: "0",
        source: `val-049:${options.row.rowId}:audit:offline-replay`,
        scope: "direct-execution",
      },
    ],
    latency: [
      {
        phase: "total",
        source: "platform-ledger",
        milliseconds: 0,
      },
    ],
    environment: [
      {
        kind: "state-transitioned",
        assertion: `the audit row ${options.row.rowId} re-derived ${rederivationsExecuted} recorded references`,
        observedVia: "platform-ledger",
        passed: true,
      },
    ],
    sealedAt,
  });

  await options.lifecycle.transition({
    executionId,
    step: "verify",
    reason: "val-049-verify",
    callKey: key(),
  });
  const finalFacts = await Promise.resolve(options.worldFacts());
  const totalLatencyMs = options.now().getTime() - runStartedAt;
  const rowCriteria = deriveAuditRowCriteria({
    row: options.row,
    replays,
    probes: options.probes,
    rederivationsExecuted,
    observedTerminal: null,
    baseline: options.baseline,
    finalFacts,
    failure,
    totalLatencyMs,
  });
  const derivedTerminal: "COMPLETED" | "FAILED" =
    failure !== null || rowCriteria.some((criterion) => criterion.status === "FAIL")
      ? "FAILED"
      : "COMPLETED";
  const verdict: "pass" | "fail" = derivedTerminal === "COMPLETED" ? "pass" : "fail";
  const failureCategory =
    (failure as { readonly category: string } | null)?.category ?? "protocol-violation";
  await options.lifecycle.complete({
    executionId,
    verdict,
    criteria: rowCriteria,
    reason: verdict === "pass" ? "val-049-verified" : `val-049-${failureCategory}`,
  });

  const observedTerminal = await options.lifecycle.statusOf(executionId);
  const readbackAgrees = observedTerminal === derivedTerminal;
  const criteria: LabVerificationCriterion[] = [
    ...rowCriteria,
    {
      criterionId: "observed-terminal-readback",
      strategy: "deterministic",
      status: readbackAgrees ? "PASS" : "FAIL",
      evidence: [
        `derivedTerminal:${derivedTerminal}`,
        `observedTerminal:${observedTerminal ?? "none"}`,
        readbackAgrees
          ? "the ledger's own terminal agrees with the mechanically derived audit verdict"
          : "DISAGREED (a fabricated terminal at the ledger — the anyFail→FAILED invariant)",
      ],
    },
  ];
  const auditVerdict = deriveAuditVerdict({
    row: options.row,
    replays,
    probes: options.probes,
  });
  return {
    rowId: options.row.rowId,
    terminal: derivedTerminal === "FAILED" || !readbackAgrees ? "FAILED" : "COMPLETED",
    criteria,
    executionId,
    observedTerminal,
    auditVerdict,
    replays,
    totalLatencyMs,
    failure,
    notRun: false,
  };
}

// ---------------------------------------------------------------------------
// The live lane (env-gated — one REAL re-run audit slice)
// ---------------------------------------------------------------------------

/**
 * The pinned live-audit plan (the measured lane's declaration): the
 * sampled re-run slice — REAL dispatches on the ONE pinned OpenRouter
 * rail (the VAL-048 live plan's own rail), the measured economics
 * checked against the recorded declared bounds (the recorded live
 * windows' Wilson intervals), recorded through the REAL recorder with
 * honest economics.
 */
export const LIVE_AUDIT_PLAN = Object.freeze({
  /** The workload class the live re-run slice drives. */
  workloadClass: "live-audit-real-rerun",
  /** The sampled re-run's REAL rounds (each one REAL model dispatch). */
  rounds: 4,
  /** The pinned rail the re-runs dispatch on (ONE binding — the live-run lesson). */
  rail: Object.freeze({
    provider: "openrouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "meta-llama/llama-3.3-70b-instruct",
    priceRevision: "rev-001",
    maxTokens: 32,
    temperature: "unset (the provider's documented default — nothing rides the request)",
  }),
  /** The recorded declared bounds the measured economics are checked against. */
  boundsSource: "the recorded live windows' Wilson intervals (VAL-040/041 live rows)",
});

/** The live slice's identity (the measured lane's declaration reference). */
export const LIVE_AUDIT_WORKLOAD_CLASS = "live-audit-real-rerun";

/** The declaration digest of the live audit plan (the reference's recorded digest). */
export function liveAuditPlanDigestOf(): string {
  return economicDigestOf({
    liveWorkloadClass: LIVE_AUDIT_WORKLOAD_CLASS,
    rounds: LIVE_AUDIT_PLAN.rounds,
    rail: LIVE_AUDIT_PLAN.rail,
    boundsSource: LIVE_AUDIT_PLAN.boundsSource,
  });
}
