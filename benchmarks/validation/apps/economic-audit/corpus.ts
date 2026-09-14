/**
 * The economic-audit corpus (VAL-049, AC1): the declared rows of the
 * REPRODUCIBILITY AND ANTI-GAMING AUDIT — the mechanical audit of the
 * recorded economic evidence (VAL-041..048).
 *
 * Every row declares, per the work order's AC1: the AUDITED INPUT
 * DIGESTS (content-digest references into each audited work order's
 * OWN recorded corpus — never copies), the AUDIT ARM under test
 * (REPRODUCIBILITY | ANTI-GAMING | BOUNDS) and the EXPECTED AUDIT
 * VERDICT (REPRODUCIBLE-VERIFIED / BOUNDS-HELD / GAMING-DETECTED with
 * the exact mechanism NAMED / NOT-AUDITABLE with the reason NAMED).
 *
 * THE CORPUS (29 rows):
 *
 *   * SEVEN honest REPRODUCIBILITY rows — the recorded verdicts of
 *     VAL-041..048 re-derived end-to-end from their digest-referenced
 *     recorded inputs, bit-stable (the controls' recorded arm facts,
 *     the VAL-044 adjusted-cost verdicts, the VAL-045 attribution
 *     splits, the VAL-046 substrate window facts, the VAL-047
 *     longitudinal curve points, the VAL-048 cross-workload verdicts,
 *     and the declared-divergence record over the corpus's own
 *     extrapolated-point discipline);
 *   * TWO honest NOT-AUDITABLE boundary rows (the live measured slices
 *     demand the operator credential; the payload bytes were never
 *     recorded — digest references only);
 *   * ONE honest offline BOUNDS row (the recorded confidence interval
 *     floor of the live re-run oracle) + exactly ONE env-gated live
 *     re-run row (honest NOT RUN without the credential);
 *   * TEN anti-gaming single-vector probe rows (every gaming vector
 *     the discrimination batteries warned about — each expected
 *     GAMING-DETECTED with the mechanism NAMED) + THREE cross-vector
 *     combination rows (each expected GAMING-DETECTED with BOTH
 *     mechanisms named) + ONE honest gaming-detected finding with an
 *     accepted-risk record (the resolution-honesty positive path);
 *   * FOUR adversarial AUDIT-probe rows (the rubber-stamp confession,
 *     the favorable-subset audit, the off-bounds re-run claim, the
 *     unresolved finding — each expected to FAIL its NAMED criterion).
 *
 * The honest verdicts are pinned at module load by running the SAME
 * replay engine the driver runs at verification time — the expected
 * outcome IS the mechanically derived one.
 */

import { economicDigestOf } from "../economic-baseline/driver";
import { recordedCompetitiveArmOf } from "../economic-competitive-benchmark/driver";
import { LONGITUDINAL_LEDGERS } from "../economic-longitudinal-curve/corpus";
import {
  type AuditAdversarialKind,
  type AuditArm,
  type AuditBoundary,
  type AuditCorpusRow,
  type AuditedEvidenceReference,
  type AuditedWorkOrder,
  type AuditFindingResolution,
  auditEvidenceDigestOf,
  type BoundsDeclaration,
  GAMING_MECHANISM_OF,
  type GamingVector,
  offlineRowIdsOf,
  replayRecordedEvidenceOf,
} from "./driver";

/** The task kind every row's submission carries (the app's task vocabulary). */
export const AUDIT_TASK_KIND = "economic-audit.experiment.v1";

/** The corpus version the audit carries. */
export const AUDIT_CORPUS_VERSION = "val-049-economic-audit-v1";

/** The complete audited work-order vocabulary (the audit's declared scope). */
export const AUDITED_WORK_ORDERS: readonly AuditedWorkOrder[] = [
  "VAL-041",
  "VAL-042",
  "VAL-043",
  "VAL-044",
  "VAL-045",
  "VAL-046",
  "VAL-047",
  "VAL-048",
];

// ---------------------------------------------------------------------------
// The evidence-reference builders (digest references — never copies)
// ---------------------------------------------------------------------------

/** Pin ONE recorded evidence reference (PURE — the replay runs at pin time). */
function recordedRefOf(
  workOrder: AuditedWorkOrder,
  corpusRowId: string,
  divergence?: { readonly cause: string },
): AuditedEvidenceReference {
  const replay = replayRecordedEvidenceOf({ workOrder, corpusRowId });
  if (!replay.resolvable) {
    throw new Error(
      `the audited evidence ${workOrder}:${corpusRowId} failed to resolve (${replay.unresolvableReason})`,
    );
  }
  return {
    workOrder,
    corpusRowId,
    recordedDigest: replay.recomputedDigest,
    recordedVerdict: replay.replayedVerdict,
    ...(divergence === undefined ? {} : { declaredDivergence: divergence }),
  };
}

/** Pin the COMPLETE offline corpus of one audited work order (the honest scope). */
function offlineRefsOf(workOrder: AuditedWorkOrder): readonly AuditedEvidenceReference[] {
  return offlineRowIdsOf(workOrder).map((rowId) => recordedRefOf(workOrder, rowId));
}

/** Pin one LIVE measured-slice reference (the honest NOT-AUDITABLE boundary). */
function liveRefOf(workOrder: AuditedWorkOrder, corpusRowId: string): AuditedEvidenceReference {
  return {
    workOrder,
    corpusRowId,
    recordedDigest: economicDigestOf({ workOrder, corpusRowId, live: "measured-slice" }),
    recordedVerdict: "live-measured-slice",
  };
}

/** The headline cohort's alternative arms + the VAL-048 headline row (the anti-gaming grounding basis). */
const HEADLINE_GROUNDING_REFS: readonly AuditedEvidenceReference[] = [
  recordedRefOf("VAL-041", "fixed-quality-direct-default-rail"),
  recordedRefOf("VAL-042", "fixed-quality-optimized-routing-cache-amortized"),
  recordedRefOf("VAL-043", "fixed-quality-competitor-default-routing"),
  recordedRefOf("VAL-048", "confirmation-fixed-quality-quality-adjusted-ranking"),
];

/** The direct arm's recorded resolution rate (the offline bounds floor's measured value). */
function directRecordedRate(): number {
  const resolved = recordedCompetitiveArmOf({
    armKind: "direct",
    corpusRowId: "fixed-quality-direct-default-rail",
    recordedDigest: "",
    priceRevision: "",
    workloadClass: "",
  });
  if (resolved === null || resolved.arm.facts.runCount === 0) {
    throw new Error("the direct arm's recorded facts failed to re-derive");
  }
  return resolved.arm.facts.resolvedCount / resolved.arm.facts.runCount;
}

// ---------------------------------------------------------------------------
// The row builder (the honest oracle's derivation)
// ---------------------------------------------------------------------------

/** Build one audit row with its PINNED expected audit verdict (PURE). */
function auditRow(input: {
  readonly rowId: string;
  readonly description: string;
  readonly arm: AuditArm;
  readonly auditedWorkOrders?: readonly AuditedWorkOrder[];
  readonly evidence: readonly AuditedEvidenceReference[];
  readonly gamingVectors?: readonly GamingVector[];
  readonly combinedVectors?: readonly GamingVector[];
  readonly findingResolution?: AuditFindingResolution;
  readonly boundary?: AuditBoundary;
  readonly boundsDeclaration?: BoundsDeclaration;
  readonly claimed?: AuditCorpusRow["claimed"];
  readonly adversarial?: AuditAdversarialKind;
  readonly verdict?: AuditCorpusRow["expected"]["verdict"];
  readonly terminal?: "COMPLETED" | "FAILED";
  readonly mechanism?: string;
  readonly reason?: string;
}): AuditCorpusRow {
  const verdict = input.verdict ?? "REPRODUCIBLE-VERIFIED";
  return {
    rowId: input.rowId,
    description: input.description,
    arm: input.arm,
    auditedWorkOrders: input.auditedWorkOrders ?? [],
    evidence: input.evidence,
    ...(input.gamingVectors === undefined ? {} : { gamingVectors: input.gamingVectors }),
    ...(input.combinedVectors === undefined ? {} : { combinedVectors: input.combinedVectors }),
    ...(input.findingResolution === undefined
      ? {}
      : { findingResolution: input.findingResolution }),
    ...(input.boundary === undefined ? {} : { boundary: input.boundary }),
    ...(input.boundsDeclaration === undefined
      ? {}
      : { boundsDeclaration: input.boundsDeclaration }),
    ...(input.claimed === undefined ? {} : { claimed: input.claimed }),
    needsDispatch: false,
    ...(input.adversarial === undefined ? {} : { adversarial: input.adversarial }),
    expected: {
      terminal: input.terminal ?? "COMPLETED",
      verdict,
      ...(input.mechanism === undefined ? {} : { mechanism: input.mechanism }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(verdict === "NOT-AUDITABLE" || input.adversarial !== undefined
        ? {}
        : { groundedOn: auditEvidenceDigestOf(input.evidence) }),
      executions: 1,
      idempotencyRecords: 1,
      appCreated: 1,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
    },
  };
}

/** The mechanism string of one vector set (singles + combinations — the pinned NAMED mechanism). */
function mechanismOf(vectors: readonly GamingVector[]): string {
  return vectors.map((vector) => GAMING_MECHANISM_OF[vector]).join(" + ");
}

// ---------------------------------------------------------------------------
// The honest REPRODUCIBILITY rows (the recorded verdicts replayed bit-stable)
// ---------------------------------------------------------------------------

const REPRODUCIBILITY_ROWS: readonly AuditCorpusRow[] = [
  auditRow({
    rowId: "replay-controls-recorded-arms",
    description:
      "The REPRODUCIBILITY replay of the recorded controls (VAL-041 + VAL-042 + VAL-043): every offline row of the three control corpora re-derived end-to-end — the arm facts re-extracted through the final integrated machinery's own extractor and the recomputed digests compared against the pinned recorded digests AND the corpora's own public digest builders (bit-stable). A verdict that flips on replay FAILs named; the honest FAILED probes are recorded evidence too (their declared shapes digest-bound).",
    arm: "REPRODUCIBILITY",
    auditedWorkOrders: ["VAL-041", "VAL-042", "VAL-043"],
    evidence: [
      ...offlineRefsOf("VAL-041"),
      ...offlineRefsOf("VAL-042"),
      ...offlineRefsOf("VAL-043"),
    ],
  }),
  auditRow({
    rowId: "replay-adjusted-cost-verdicts",
    description:
      "The REPRODUCIBILITY replay of the VAL-044 adjusted-cost verdicts: every offline row of the adjusted-cost corpus re-derived — the honest control rows' verdicts re-derived through the corpus's own synthesis derivation (deriveAdjustedSynthesis over the honest inputs) and the digest over the recorded shape recomputed bit-stable against both the pinned digest and the reference builder's digest.",
    arm: "REPRODUCIBILITY",
    auditedWorkOrders: ["VAL-044"],
    evidence: offlineRefsOf("VAL-044"),
  }),
  auditRow({
    rowId: "replay-savings-attribution-splits",
    description:
      "The REPRODUCIBILITY replay of the VAL-045 savings attribution: every offline row of the attribution corpus re-derived — the declared split totals recomputed through the corpus's own derivation (declaredSplitTotalsOf) and the digest over the recorded verdict + split recomputed bit-stable against the pinned digest, with the corpus's own attribution input digest as the cross-check.",
    arm: "REPRODUCIBILITY",
    auditedWorkOrders: ["VAL-045"],
    evidence: offlineRefsOf("VAL-045"),
  }),
  auditRow({
    rowId: "replay-substrate-window-facts",
    description:
      "The REPRODUCIBILITY replay of the VAL-046 substrate runtime: every offline row of the substrate corpus re-derived — each row's window digests recomputed through the corpus's own window-facts builder (windowReferenceOf) and the digest over the recorded shape recomputed bit-stable against the pinned digest.",
    arm: "REPRODUCIBILITY",
    auditedWorkOrders: ["VAL-046"],
    evidence: offlineRefsOf("VAL-046"),
  }),
  auditRow({
    rowId: "replay-longitudinal-curve-points",
    description:
      "The REPRODUCIBILITY replay of the VAL-047 longitudinal curves: every offline row of the curve corpus re-derived — each row's point digests recomputed through the corpus's own point-reference builder and the digest over the recorded shape recomputed bit-stable against the pinned digest.",
    arm: "REPRODUCIBILITY",
    auditedWorkOrders: ["VAL-047"],
    evidence: offlineRefsOf("VAL-047"),
  }),
  auditRow({
    rowId: "replay-cross-workload-verdicts",
    description:
      "The REPRODUCIBILITY replay of the VAL-048 cross-workload verdicts: every offline row of the competitive corpus re-derived — the honest control rows' verdicts re-derived through the final integrated machinery's own synthesis (deriveCompetitiveSynthesis over the honest recorded inputs) with the recomputed arm digests folded into the recorded digest, and the honest FAILED probes' declared shapes digest-bound. The strongest replay: the complete cross-workload record reproduced bit-stable.",
    arm: "REPRODUCIBILITY",
    auditedWorkOrders: ["VAL-048"],
    evidence: offlineRefsOf("VAL-048"),
  }),
];

// ---------------------------------------------------------------------------
// The honest divergence record (permitted WITH cause, named)
// ---------------------------------------------------------------------------

/** The first ledger's first generation BEYOND its recorded points (the extrapolation boundary). */
function extrapolatedGenerationOf(): {
  readonly workloadClass: string;
  readonly generation: number;
} {
  const ledger = LONGITUDINAL_LEDGERS[0];
  if (ledger === undefined || ledger.points.length === 0) {
    throw new Error("the longitudinal ledgers hold no points");
  }
  const maxGeneration = Math.max(...ledger.points.map((point) => point.generation));
  return { workloadClass: ledger.workloadClass, generation: maxGeneration + 3 };
}

const DIVERGENCE_ROW: AuditCorpusRow = (() => {
  const beyond = extrapolatedGenerationOf();
  const ref = recordedRefOf("VAL-047", `${beyond.workloadClass}@${beyond.generation}`, {
    cause:
      "extrapolated-beyond-the-recorded-ledger (the curve corpus's own fabricated-point discipline — a declared extrapolation, never a recorded point; the divergence is honest because it is declared with its cause)",
  });
  return auditRow({
    rowId: "replay-declared-divergence-recorded",
    description:
      "The honest DIVERGENCE RECORD: an audited curve reference one generation beyond the recorded ledger — the corpus's own fabricated-point discipline returns a declared extrapolation digest, the replay DETECTS the divergence (the point is not a recorded point) and the declared cause permits it (an honest divergence record with cause is permitted where declared; a silent divergence would FAIL named). The verdict stays REPRODUCIBLE-VERIFIED with the divergence recorded in evidence.",
    arm: "REPRODUCIBILITY",
    evidence: [ref],
  });
})();

// ---------------------------------------------------------------------------
// The honest NOT-AUDITABLE boundary rows (the reason NAMED)
// ---------------------------------------------------------------------------

const BOUNDARY_ROWS: readonly AuditCorpusRow[] = [
  auditRow({
    rowId: "boundary-live-measured-slices-not-auditable",
    description:
      "The honest NOT-AUDITABLE boundary over the LIVE measured slices: the VAL-044 live adjusted-cost row and the VAL-048 live competitive row ride MEASURED economics from REAL dispatches — their measured facts cannot be re-derived offline (the recorded digests are declaration digests; the measured slice demands the operator credential). The audit refuses to certify what it cannot replay: NOT-AUDITABLE with the reason NAMED (never a fabricated replay, never a rubber stamp).",
    arm: "REPRODUCIBILITY",
    evidence: [
      liveRefOf("VAL-044", "live-adjusted-synthesis-real-comparison"),
      liveRefOf("VAL-048", "live-competitive-real-dispatch-slice"),
    ],
    boundary: {
      kind: "live-measured-slice",
      reason:
        "the live measured slices' economics demand REAL dispatches on the operator-authorized rail (env OPENROUTER_API_KEY) — offline replay is impossible and honestly refused",
    },
    verdict: "NOT-AUDITABLE",
    reason:
      "the live measured slices' economics demand REAL dispatches on the operator-authorized rail (env OPENROUTER_API_KEY) — offline replay is impossible and honestly refused",
  }),
  auditRow({
    rowId: "boundary-payload-bytes-never-recorded",
    description:
      "The honest NOT-AUDITABLE boundary over the PAYLOAD BYTES: the program's evidence discipline records payload DIGESTS only — never payload bytes — so a byte-level replay of any recorded payload is structurally impossible (the audit verifies digests, never bytes). NOT-AUDITABLE with the reason NAMED: the discipline itself is the boundary.",
    arm: "REPRODUCIBILITY",
    evidence: [],
    boundary: {
      kind: "payload-bytes-never-recorded",
      reason:
        "the evidence discipline records payload digests only (never bytes) — a byte-level replay has no recorded input to re-derive",
    },
    verdict: "NOT-AUDITABLE",
    reason:
      "the evidence discipline records payload digests only (never bytes) — a byte-level replay has no recorded input to re-derive",
  }),
];

// ---------------------------------------------------------------------------
// The honest BOUNDS row (the offline floor of the live re-run oracle)
// ---------------------------------------------------------------------------

const BOUNDS_ROWS: readonly AuditCorpusRow[] = [
  auditRow({
    rowId: "bounds-recorded-confidence-offline",
    description:
      "The offline floor of the BOUNDS-HELD oracle: the direct arm's recorded fixed-quality window — its measured resolution rate re-checked against its RECORDED declared Wilson confidence interval (recomputed through the arm's own recorded facts). The sampled re-run value sits inside the recorded bounds: BOUNDS-HELD (the live re-run slice's machinery exists and is exercised offline over the deterministic recorded sample).",
    arm: "BOUNDS",
    evidence: [recordedRefOf("VAL-041", "fixed-quality-direct-default-rail")],
    boundsDeclaration: {
      armKind: "direct",
      corpusRowId: "fixed-quality-direct-default-rail",
      measuredRate: directRecordedRate(),
    },
    verdict: "BOUNDS-HELD",
  }),
];

// ---------------------------------------------------------------------------
// The anti-gaming rows (every vector + the cross-vector combinations)
// ---------------------------------------------------------------------------

/** One single-vector anti-gaming probe row (each expected GAMING-DETECTED, mechanism NAMED). */
function gamingRow(
  rowId: string,
  description: string,
  vector: GamingVector,
  evidence: readonly AuditedEvidenceReference[],
  findingResolution?: AuditFindingResolution,
): AuditCorpusRow {
  return auditRow({
    rowId,
    description,
    arm: "ANTI-GAMING",
    evidence,
    gamingVectors: [vector],
    ...(findingResolution === undefined ? {} : { findingResolution }),
    verdict: "GAMING-DETECTED",
    mechanism: mechanismOf([vector]),
  });
}

const SCOPE_EVIDENCE_REFS: readonly AuditedEvidenceReference[] = offlineRefsOf("VAL-048");

const ANTI_GAMING_SINGLE_ROWS: readonly AuditCorpusRow[] = [
  gamingRow(
    "probe-vector-quality-inflation",
    "The QUALITY-INFLATION vector re-probed against the final integrated machinery: the zeck arm's resolved count inflated (the denominator inflated — the cost per resolved deflated) on the honest headline inputs. The input-integrity oracle catches the denatured bundle's digest disagreement with the recorded arm digest: GAMING-DETECTED with the mechanism NAMED.",
    "quality-inflation",
    HEADLINE_GROUNDING_REFS,
  ),
  gamingRow(
    "probe-vector-latency-omission",
    "The LATENCY-OMISSION vector re-probed: every recorded round's latency zeroed out on the honest headline inputs (the latency-compliance weighting's basis destroyed). The input-integrity oracle catches the digest disagreement (the recorded digest binds the round latencies): GAMING-DETECTED with the mechanism NAMED.",
    "latency-omission",
    HEADLINE_GROUNDING_REFS,
  ),
  gamingRow(
    "probe-vector-failure-hiding",
    "The FAILURE-HIDING vector re-probed: the failed rounds dropped from the honest headline bundles (the failure costs vanished from the amortized basis). The input-integrity oracle catches the digest disagreement (the recorded digest binds every round — resolved and failed alike): GAMING-DETECTED with the mechanism NAMED.",
    "failure-hiding",
    HEADLINE_GROUNDING_REFS,
  ),
  gamingRow(
    "probe-vector-estimate-conflation",
    "The ESTIMATE-CONFLATION vector re-probed: a claimed measured cost equal to the planner estimate on the honest headline arms (the estimate/measure separation destroyed). The estimate-measure-separation oracle (the final integrated machinery's own) catches the conflation: GAMING-DETECTED with the mechanism NAMED.",
    "estimate-conflation",
    HEADLINE_GROUNDING_REFS,
  ),
  gamingRow(
    "probe-vector-post-hoc-exclusion",
    "The POST-HOC-EXCLUSION vector re-probed at the audit scope: an audit scope that excludes the VAL-048 corpus's honest FAILED probe rows after seeing them (the unfavorable evidence excluded post-hoc). The favorable-subset oracle catches the omission with the omitted rows NAMED: GAMING-DETECTED with the mechanism NAMED.",
    "post-hoc-exclusion",
    SCOPE_EVIDENCE_REFS,
  ),
  gamingRow(
    "probe-vector-window-cherry-picking",
    "The WINDOW-CHERRY-PICKING vector re-probed at the audit scope: an audit scope that samples only the favorable fixed-quality-confirmation window (the zero-resolved and budget-stop classes omitted). The favorable-subset oracle catches the omission with the omitted rows NAMED: GAMING-DETECTED with the mechanism NAMED.",
    "window-cherry-picking",
    SCOPE_EVIDENCE_REFS,
  ),
  gamingRow(
    "probe-vector-regime-normalization",
    "The REGIME-NORMALIZATION vector re-probed: a hidden normalization rescaling every measured cost on the honest headline inputs (the recorded regime quietly renormalized). The input-integrity oracle catches the digest disagreement (the recorded digest binds the micro-USD costs): GAMING-DETECTED with the mechanism NAMED.",
    "regime-normalization",
    HEADLINE_GROUNDING_REFS,
  ),
  gamingRow(
    "probe-vector-hidden-weights",
    "The HIDDEN-WEIGHTS vector re-probed: a portfolio-weighted aggregate claimed WITHOUT declared weights (the weighting buried — the aggregate's basis hidden). The weighting-disclosure oracle (the final integrated machinery's own) catches the hidden weights: GAMING-DETECTED with the mechanism NAMED.",
    "hidden-weights",
    SCOPE_EVIDENCE_REFS,
  ),
  gamingRow(
    "probe-vector-silent-drops",
    "The SILENT-DROPS vector re-probed at the audit scope: the under-powered budget-stop row silently dropped from the audit scope (the honest refusal disappears). The favorable-subset oracle catches the drop with the dropped row NAMED: GAMING-DETECTED with the mechanism NAMED.",
    "silent-drops",
    SCOPE_EVIDENCE_REFS,
  ),
  gamingRow(
    "probe-vector-re-measurement-masquerade",
    "The RE-MEASUREMENT-MASQUERADE vector re-probed: a re-measured cost on the zeck arm's first block masquerading as the recorded derivation. The input-integrity oracle catches the field-by-field disagreement (the digest binds every block's cost): GAMING-DETECTED with the mechanism NAMED.",
    "re-measurement-masquerade",
    HEADLINE_GROUNDING_REFS,
  ),
];

const ANTI_GAMING_COMBINATION_ROWS: readonly AuditCorpusRow[] = [
  auditRow({
    rowId: "probe-combination-quality-inflation-latency-omission",
    description:
      "The CROSS-VECTOR COMBINATION quality-inflation + latency-omission re-probed: BOTH denaturings applied to the honest headline inputs at once — a row that would pass neither probe in isolation games the combination only if the machinery missed it. The input-integrity oracle catches the combined denaturing with BOTH mechanisms named: GAMING-DETECTED.",
    arm: "ANTI-GAMING",
    evidence: HEADLINE_GROUNDING_REFS,
    combinedVectors: ["quality-inflation", "latency-omission"],
    verdict: "GAMING-DETECTED",
    mechanism: mechanismOf(["quality-inflation", "latency-omission"]),
  }),
  auditRow({
    rowId: "probe-combination-window-cherry-picking-post-hoc-exclusion",
    description:
      "The CROSS-VECTOR COMBINATION window-cherry-picking + post-hoc-exclusion re-probed at the audit scope: an audit that samples only the favorable window AND excludes the honest FAILED probes post-hoc (the two scope dishonesties composed). The favorable-subset oracle catches the combined omission with ALL omitted rows NAMED and BOTH mechanisms named: GAMING-DETECTED.",
    arm: "ANTI-GAMING",
    evidence: SCOPE_EVIDENCE_REFS,
    combinedVectors: ["window-cherry-picking", "post-hoc-exclusion"],
    verdict: "GAMING-DETECTED",
    mechanism: mechanismOf(["window-cherry-picking", "post-hoc-exclusion"]),
  }),
  auditRow({
    rowId: "probe-combination-hidden-weights-silent-drops",
    description:
      "The CROSS-VECTOR COMBINATION hidden-weights + silent-drops re-probed: a portfolio aggregate claimed with hidden weights WHILE the under-powered stop class is silently dropped from the audit scope (the machinery-side and audit-side dishonesties composed). BOTH oracles fire — the weighting-disclosure catch AND the favorable-subset catch with the dropped row NAMED: GAMING-DETECTED with BOTH mechanisms named.",
    arm: "ANTI-GAMING",
    evidence: SCOPE_EVIDENCE_REFS,
    combinedVectors: ["hidden-weights", "silent-drops"],
    verdict: "GAMING-DETECTED",
    mechanism: mechanismOf(["hidden-weights", "silent-drops"]),
  }),
];

/** The honest gaming-detected finding with an accepted-risk record (the resolution-honesty positive path). */
const RESOLUTION_ROW: AuditCorpusRow = auditRow({
  rowId: "probe-finding-accepted-risk-recorded",
  description:
    "The resolution-honesty positive path: a gaming-detected finding (the re-measurement masquerade caught, mechanism NAMED) reported as an ACCEPTED RISK with the accepted-risk record's digest carried — the finding is not silently resolved (a resolved claim without a fix digest would FAIL named); the accepted-risk record is the honest disposition. GAMING-DETECTED with the mechanism NAMED and the resolution grounded.",
  arm: "ANTI-GAMING",
  evidence: HEADLINE_GROUNDING_REFS,
  gamingVectors: ["re-measurement-masquerade"],
  findingResolution: {
    status: "accepted-risk",
    acceptedRiskDigest: economicDigestOf({
      finding: "re-measurement-masquerade",
      disposition: "accepted-risk",
      acceptedBy: "operator",
      record: "the re-measured-cost finding accepted as a recorded risk with the digest carried",
    }),
  },
  verdict: "GAMING-DETECTED",
  mechanism: mechanismOf(["re-measurement-masquerade"]),
});

// ---------------------------------------------------------------------------
// The adversarial AUDIT-probe rows (each FAILs its NAMED criterion)
// ---------------------------------------------------------------------------

/** The favorable subset of the VAL-044 corpus (the honest control rows ONLY — the probes omitted). */
function favorableSubsetOf(): readonly AuditedEvidenceReference[] {
  return offlineRowIdsOf("VAL-044")
    .filter((rowId) => !rowId.startsWith("probe-"))
    .map((rowId) => recordedRefOf("VAL-044", rowId));
}

const ADVERSARIAL_PROBE_ROWS: readonly AuditCorpusRow[] = [
  auditRow({
    rowId: "probe-audit-rubber-stamp",
    description:
      "The RUBBER-STAMP audit probe: an audit row that claims verification WITHOUT re-derivation (the skip confessed in the row's own claim surface) over the complete VAL-044 scope. The rubber-stamp-detection oracle FAILs it MECHANICALLY (the re-derivation must actually execute — the engine runs it regardless, and the claimed skip is the named offense).",
    arm: "REPRODUCIBILITY",
    auditedWorkOrders: ["VAL-044"],
    evidence: offlineRefsOf("VAL-044"),
    claimed: { skipRederivation: true },
    adversarial: "rubber-stamp",
    verdict: "adversarial-failed",
    terminal: "FAILED",
  }),
  auditRow({
    rowId: "probe-audit-favorable-subset",
    description:
      "The FAVORABLE-SUBSET audit probe: an audit of the VAL-044 record that samples ONLY the favorable control rows — the six honest FAILED probes omitted (the quality-inflated-denominator, latency-omission, failure-hiding, estimate-conflation, re-measurement-masquerade and below-minimum-comparability probes are recorded evidence too). The favorable-subset-sampling oracle FAILs it MECHANICALLY with the omitted rows NAMED.",
    arm: "REPRODUCIBILITY",
    auditedWorkOrders: ["VAL-044"],
    evidence: favorableSubsetOf(),
    adversarial: "favorable-subset",
    verdict: "adversarial-failed",
    terminal: "FAILED",
  }),
  auditRow({
    rowId: "probe-audit-off-bounds",
    description:
      "The OFF-BOUNDS audit probe: a BOUNDS row declaring a sampled re-run rate of 0.5 (below the direct arm's recorded Wilson lower bound 0.6756) while claiming the held verdict — the measurement was noise, not signal, and the claimed held verdict is a fabrication. The bounds-held oracle FAILs it MECHANICALLY with the offending value and the violated bound NAMED.",
    arm: "BOUNDS",
    evidence: [recordedRefOf("VAL-041", "fixed-quality-direct-default-rail")],
    boundsDeclaration: {
      armKind: "direct",
      corpusRowId: "fixed-quality-direct-default-rail",
      measuredRate: 0.5,
    },
    claimed: { boundsClaim: { measuredRate: 0.5, claimedHeld: true } },
    adversarial: "off-bounds",
    verdict: "adversarial-failed",
    terminal: "FAILED",
  }),
  auditRow({
    rowId: "probe-audit-unresolved-finding",
    description:
      "The UNRESOLVED-FINDING audit probe: a gaming-detected finding (the quality-inflation vector, caught and NAMED) reported as resolved WITHOUT a fix digest and WITHOUT an accepted-risk record — the finding evaporates. The resolution-honesty oracle FAILs it MECHANICALLY (a resolved finding must carry a fix or an accepted-risk record, or stay open).",
    arm: "ANTI-GAMING",
    evidence: HEADLINE_GROUNDING_REFS,
    gamingVectors: ["quality-inflation"],
    findingResolution: { status: "resolved" },
    adversarial: "unresolved-finding",
    verdict: "adversarial-failed",
    terminal: "FAILED",
  }),
];

// ---------------------------------------------------------------------------
// The live row (env-gated — the ONE REAL re-run audit slice)
// ---------------------------------------------------------------------------

const LIVE_CORPUS_ROWS: readonly AuditCorpusRow[] = [
  {
    rowId: "live-audit-real-rerun-slice",
    description:
      "The reproducibility arm's LIVE slice (env-gated): sampled re-runs with REAL dispatches on the ONE pinned OpenRouter rail (BYOK, measured usage, max_tokens 32 pinned, temperature unset per the provider's documented default) — the measured economics checked against the RECORDED declared bounds (the recorded live windows' Wilson intervals), recorded through the REAL recorder with honest economics. Without the credential the row is honestly NOT RUN (never fabricated).",
    arm: "BOUNDS",
    auditedWorkOrders: [],
    evidence: [
      liveRefOf("VAL-048", "live-competitive-real-dispatch-slice"),
      liveRefOf("VAL-041", "live-fixed-quality-direct-real-dispatch"),
    ],
    needsDispatch: true,
    liveGate: {
      envVars: ["OPENROUTER_API_KEY"],
      requirement:
        "operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) covering the pinned chat model meta-llama/llama-3.3-70b-instruct — the REAL re-run slice demands REAL workload dispatches on the pinned rail (BYOK, measured usage, max_tokens 32 pinned explicitly, temperature unset per the provider's documented default)",
    },
    expected: {
      terminal: "COMPLETED",
      verdict: "BOUNDS-HELD",
      executions: 1,
      idempotencyRecords: 1,
      appCreated: 1,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
    },
  },
];

// ---------------------------------------------------------------------------
// The pinned corpus (offline rows first, live rows last)
// ---------------------------------------------------------------------------

/** The honest offline rows (reproducibility + boundaries + bounds + anti-gaming). */
export const OFFLINE_CONTROL_ROWS: readonly AuditCorpusRow[] = [
  ...REPRODUCIBILITY_ROWS,
  DIVERGENCE_ROW,
  ...BOUNDARY_ROWS,
  ...BOUNDS_ROWS,
  ...ANTI_GAMING_SINGLE_ROWS,
  ...ANTI_GAMING_COMBINATION_ROWS,
  RESOLUTION_ROW,
];

/** The adversarial audit-probe rows (each FAILs its named criterion honestly). */
export const PROBE_ROWS: readonly AuditCorpusRow[] = ADVERSARIAL_PROBE_ROWS;

/** The offline rows (honest controls first, probes last — deterministic, zero credentials). */
export const OFFLINE_CORPUS_ROWS: readonly AuditCorpusRow[] = [
  ...OFFLINE_CONTROL_ROWS,
  ...PROBE_ROWS,
];

/** The full pinned corpus (offline rows first, live rows last). */
export const AUDIT_CORPUS: readonly AuditCorpusRow[] = [
  ...OFFLINE_CORPUS_ROWS,
  ...LIVE_CORPUS_ROWS,
];

/** Whether every env var of the row's live gate is present. */
export function liveGateOpen(row: AuditCorpusRow, env: NodeJS.ProcessEnv): boolean {
  if (row.liveGate === undefined) {
    return true;
  }
  return row.liveGate.envVars.every((name) => (env[name] ?? "").length > 0);
}

// ---------------------------------------------------------------------------
// The submission keys + task bodies (the app's fingerprint discipline)
// ---------------------------------------------------------------------------

/** The app's idempotency key for one row's submission. */
export function submissionKey(options: {
  readonly runSuffix: string;
  readonly taskIndex: number;
}): string {
  return `val-049-app-${options.runSuffix}-${options.taskIndex}`;
}

/**
 * The app's task body for one row's submission: REFERENCES ONLY — the
 * row, the audit arm, the audited work orders, the audited input
 * DIGEST references, the gaming vectors under probe and the expected
 * audit verdict. Never a price, never a recorded result copy (the
 * platform resolves the recorded corpora through their registries).
 */
export function taskBodyFor(options: { readonly row: AuditCorpusRow }): Record<string, unknown> {
  const { row } = options;
  return {
    kind: AUDIT_TASK_KIND,
    rowId: row.rowId,
    arm: row.arm,
    auditedWorkOrders: [...row.auditedWorkOrders],
    auditedEvidence: row.evidence.map((reference) => ({
      workOrder: reference.workOrder,
      corpusRowId: reference.corpusRowId,
      recordedDigest: reference.recordedDigest,
    })),
    ...(row.gamingVectors === undefined ? {} : { gamingVectors: [...row.gamingVectors] }),
    ...(row.combinedVectors === undefined ? {} : { combinedVectors: [...row.combinedVectors] }),
    ...(row.boundary === undefined ? {} : { boundaryKind: row.boundary.kind }),
    ...(row.adversarial === undefined ? {} : { adversarial: row.adversarial }),
    expectedVerdict: row.expected.verdict,
    ...(row.liveGate === undefined ? {} : { liveGate: row.liveGate.envVars }),
  };
}

/** The row ids in corpus order (config.json mirrors this slice). */
export const AUDIT_ROW_IDS: readonly string[] = AUDIT_CORPUS.map((row) => row.rowId);

/** Look up one corpus row by id (the config task slice references rows by id). */
export function auditRowById(rowId: string): AuditCorpusRow | null {
  return AUDIT_CORPUS.find((row) => row.rowId === rowId) ?? null;
}

// ---------------------------------------------------------------------------
// The corpus fingerprint (the deterministic-corpus digest)
// ---------------------------------------------------------------------------

/**
 * The corpus's input digest over the full pinned recorded basis (PURE
 * — the deterministic-corpus fingerprint the config carries): every
 * audited evidence digest, in corpus order.
 */
export function pinnedAuditInputDigest(): string {
  return economicDigestOf({
    corpus: AUDIT_CORPUS_VERSION,
    evidence: AUDIT_CORPUS.flatMap((row) =>
      row.evidence.map((reference) => [
        row.rowId,
        reference.workOrder,
        reference.corpusRowId,
        reference.recordedDigest,
      ]),
    ),
  });
}
