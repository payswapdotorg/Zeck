/**
 * VAL-049 acceptance criterion 6 — the discrimination battery: the
 * REPRODUCIBILITY AND ANTI-GAMING AUDIT machinery against controlled
 * fakes.
 *
 * Every catch the work order names is probed at THREE levels: the
 * derivation-level catch (the PURE oracle over the controlled-fake
 * shapes — the NAMED evidence asserted verbatim), the row-level catch
 * (the mutated row or the fake probe set driven over the purpose-built
 * leaky stack — the landed execution chain with the REAL accounting
 * rails), and the honest control (the honest shape PASSING the same
 * oracle — the contrast pair every discrimination demands):
 *
 *   * a FLIPPED VERDICT on replay FAILs named (the re-derivation
 *     executes and catches the flip — a recorded verdict that does not
 *     reproduce);
 *   * an OUT-OF-BOUNDS re-run reported as held FAILs named (the
 *     offending measured value AND the violated bound both named);
 *   * an UNDETECTED GAMING VECTOR FAILs named (vector-not-caught with
 *     the machinery's miss named);
 *   * a COMBINATION-GAMING case — a row passing each probe in isolation
 *     but gaming the combination — FAILs with BOTH mechanisms named
 *     (combination-not-caught / combination-not-probed);
 *   * a RUBBER-STAMP audit FAILs (verification without re-derivation);
 *   * a FAVORABLE-SUBSET audit FAILs with the omitted rows NAMED;
 *   * an UNRESOLVED FINDING (gaming-detected reported resolved with no
 *     fix and no accepted-risk record) FAILs named;
 *   * VERDICT GROUNDING: an ungrounded verdict FAILs named; a digest
 *     disagreement FAILs named; an unresolvable reference FAILs named;
 *   * the audit-verdict vocabulary is MECHANICAL
 *     (REPRODUCIBLE-VERIFIED / BOUNDS-HELD / GAMING-DETECTED with the
 *     mechanism NAMED / NOT-AUDITABLE with the reason NAMED) — each
 *     derived over controlled shapes;
 *   * the digest discipline (deterministic + discriminating) and the
 *     honest controls over the leaky fixture stack.
 */

import { describe, expect, test } from "vitest";
import {
  AUDIT_CORPUS,
  OFFLINE_CORPUS_ROWS,
  pinnedAuditInputDigest,
  taskBodyFor,
} from "../../benchmarks/validation/apps/economic-audit/corpus";
import type {
  AuditAdversarialKind,
  AuditCorpusRow,
  AuditedEvidenceReference,
  GamingProbeResult,
  GamingVector,
  ReplayOutcome,
} from "../../benchmarks/validation/apps/economic-audit/driver";
import {
  auditEvidenceDigestOf,
  deriveAuditVerdict,
  deriveBoundsHeld,
  deriveFavorableSubsetSampling,
  deriveGamingProbeCompleteness,
  deriveReplayBitStability,
  deriveResolutionHonesty,
  deriveRubberStampDetection,
  deriveVerdictGrounding,
  driveAuditRow,
  GAMING_MECHANISM_OF,
  offlineRowIdsOf,
  replayRecordedEvidenceOf,
} from "../../benchmarks/validation/apps/economic-audit/driver";
import {
  applyGamingVariant,
  combinationGamingProbeOf,
  createFakeLedger,
  createFakeLifecycle,
  createFakeSubmissionSeam,
  createRealAccountingRails,
  createTickClock,
  gamingProbesFor,
  honestCompetitiveInputsOf,
  singleGamingProbeOf,
} from "../../benchmarks/validation/apps/economic-audit/fixtures";
import { HEADLINE_COHORT } from "../../benchmarks/validation/apps/economic-competitive-benchmark/corpus";
import { deriveCompetitiveInputIntegrity } from "../../benchmarks/validation/apps/economic-competitive-benchmark/driver";
import type { LabVerificationCriterion } from "../../benchmarks/validation/platform/derive";
import type { RunMetadata } from "../../benchmarks/validation/run-identity";

const REVISION = "d49b0a7c2e1f5a8d3b6c9e0f4a7d2b5c8e1f3a6d";

const metadataOf = (observedAt: string): RunMetadata => ({
  program: "zeck-validation",
  workOrder: "VAL-049",
  baseRevision: REVISION,
  applicationRevision: REVISION,
  corpusRevision: "val-049-economic-audit-v1",
  integrationSurface: "audit:recorded-evidence-replay",
  environment: {
    runtime: "node test",
    toolchain: "vitest",
    database: "none",
    configuration: { suite: "val-049-discrimination" },
  },
  observedAt,
});

const rowById = (rowId: string): AuditCorpusRow => {
  const row = AUDIT_CORPUS.find((candidate) => candidate.rowId === rowId);
  if (row === undefined) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

const criterionOf = (
  result: { criteria: readonly LabVerificationCriterion[] },
  id: string | undefined,
) => result.criteria.find((criterion) => criterion.criterionId === id);

/** The replays of one row's evidence (the re-derivation trace). */
const replaysOf = (row: AuditCorpusRow) =>
  row.evidence.map((reference) => replayRecordedEvidenceOf(reference));

/** A controlled-fake probe the machinery MISSED (the miss named in evidence). */
const missedProbeOf = (vector: GamingVector): GamingProbeResult => ({
  vectors: [vector],
  caught: false,
  mechanisms: [],
  evidence: [`NOT CAUGHT (the machinery missed the ${vector} gaming attempt)`],
});

/** A controlled-fake combination probe the machinery MISSED. */
const missedCombinationProbeOf = (vectors: readonly GamingVector[]): GamingProbeResult => ({
  vectors: [...vectors],
  caught: false,
  mechanisms: vectors.map((vector) => GAMING_MECHANISM_OF[vector]),
  evidence: ["NOT CAUGHT (each probe in isolation caught but the combination gamed the machinery)"],
});

/** Drive one row (honest OR controlled-fake) over the leaky stack. */
async function driveRowOverLeakyStack(options: {
  readonly row: AuditCorpusRow;
  readonly probes?: readonly GamingProbeResult[];
}) {
  const clock = createTickClock();
  const ledger = createFakeLedger(clock);
  const seam = createFakeSubmissionSeam({ ledger });
  const lifecycle = createFakeLifecycle({ ledger });
  const baseline = ledger.facts();
  const submission = await seam({
    key: `val-049-disc-${options.row.rowId}`,
    body: taskBodyFor({ row: options.row }),
  });
  const result = await driveAuditRow({
    row: options.row,
    lifecycle,
    probes: options.probes ?? gamingProbesFor(options.row),
    rails: createRealAccountingRails(),
    metadata: metadataOf(clock.now().toISOString()),
    environmentIdentity: `val-049-disc-${options.row.rowId}`,
    baseline,
    worldFacts: ledger.facts,
    landedProvider: async () => [submission.executionId],
    now: clock.now,
  });
  return { result, lifecycle, ledger };
}

// ---------------------------------------------------------------------------
// 1. a flipped verdict on replay (the reproducibility arm's core catch)
// ---------------------------------------------------------------------------

describe("discrimination: a flipped verdict on replay", () => {
  test("the derivation-level catch: BOTH verdicts NAMED (recorded vs re-derived)", () => {
    const row = rowById("replay-adjusted-cost-verdicts");
    const reference = row.evidence[0];
    if (reference === undefined) {
      throw new Error("unreachable");
    }
    const honest = replayRecordedEvidenceOf(reference);
    // The controlled fake: the RE-DERIVATION returns a different verdict
    // than the recorded one (a recorded verdict that does not reproduce).
    const flippedReplay: ReplayOutcome = {
      ...honest,
      replayedVerdict: "flipped-on-the-actual-replay",
    };
    const stability = deriveReplayBitStability({
      row,
      replays: [flippedReplay, ...replaysOf(row).slice(1)],
      rederivationsExecuted: row.evidence.length,
    });
    expect(stability.conformant).toBe(false);
    const evidence = stability.evidence.join(" ");
    expect(evidence).toContain("verdict-flipped-on-replay");
    expect(evidence).toContain(reference.corpusRowId);
    expect(evidence).toContain(`recorded ${reference.recordedVerdict}`);
    expect(evidence).toContain("re-derived flipped-on-the-actual-replay");
  });

  test("the honest control: the recorded verdict re-derives identically", () => {
    const row = rowById("replay-adjusted-cost-verdicts");
    const stability = deriveReplayBitStability({
      row,
      replays: replaysOf(row),
      rederivationsExecuted: row.evidence.length,
    });
    expect(stability.conformant).toBe(true);
    expect(stability.evidence.join(" ")).toContain("violations:0");
  });

  test("the row-level catch: the mutated row FAILs audit-input-integrity over the leaky stack", async () => {
    const row = rowById("replay-adjusted-cost-verdicts");
    const reference = row.evidence[0];
    if (reference === undefined) {
      throw new Error("unreachable");
    }
    const flipped: AuditedEvidenceReference = {
      ...reference,
      recordedVerdict: "a-verdict-that-never-recorded",
    };
    const mutated: AuditCorpusRow = {
      ...row,
      evidence: [flipped, ...row.evidence.slice(1)],
    };
    const { result } = await driveRowOverLeakyStack({ row: mutated });
    expect(result.terminal).toBe("FAILED");
    const criterion = criterionOf(result, "audit-input-integrity");
    expect(criterion?.status).toBe("FAIL");
    expect(criterion?.evidence.join(" ")).toContain("verdict-flipped-on-replay");
    expect(criterion?.evidence.join(" ")).toContain("recorded a-verdict-that-never-recorded");
    // The re-derivation EXECUTED and caught the flip (never a rubber stamp).
    expect(result.replays).toHaveLength(mutated.evidence.length);
    expect(criterionOf(result, "observed-terminal-readback")?.status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// 2. an out-of-bounds re-run reported as held (the bounds arm's catch)
// ---------------------------------------------------------------------------

describe("discrimination: an out-of-bounds re-run reported as held", () => {
  test("the derivation-level catch: the offending value AND the violated bound both NAMED", () => {
    const honestRow = rowById("bounds-recorded-confidence-offline");
    const honestBounds = deriveBoundsHeld({ row: honestRow });
    expect(honestBounds.conformant).toBe(true);
    expect(honestBounds.evidence.join(" ")).toContain(
      "held (the sampled re-run's measured rate sits inside the recorded declared bounds)",
    );
    const recordedBounds = honestBounds.evidence.find((entry) =>
      entry.startsWith("recordedBounds:"),
    );
    expect(recordedBounds).toBeDefined();

    const row = rowById("probe-audit-off-bounds");
    const oracle = deriveBoundsHeld({ row });
    expect(oracle.conformant).toBe(false);
    const evidence = oracle.evidence.join(" ");
    // The offending measured value NAMED.
    expect(evidence).toContain("measuredRate:0.500000");
    // The violated bound NAMED (the very interval the honest row derived).
    expect(evidence).toContain(recordedBounds ?? "");
    expect(evidence).toContain("violates the recorded bounds");
    expect(evidence).toContain("the measurement was noise, not signal");
    // The dishonest held claim was refused (never trusted).
    expect(row.claimed?.boundsClaim?.claimedHeld).toBe(true);
    expect(evidence).toContain("OFF-BOUNDS");
  });

  test("a controlled off-bounds value BELOW the interval floor FAILs with the value named", () => {
    const row = rowById("bounds-recorded-confidence-offline");
    const honestBounds = deriveBoundsHeld({ row });
    const recordedBounds = honestBounds.evidence.find((entry) =>
      entry.startsWith("recordedBounds:"),
    );
    const low = Number.parseFloat(
      (recordedBounds ?? "recordedBounds:[0,0]").slice("recordedBounds:[".length).split(",")[0] ??
        "0",
    );
    const declaration = row.boundsDeclaration;
    if (declaration === undefined) {
      throw new Error("unreachable");
    }
    const below = Math.max(0, low / 2);
    const mutated: AuditCorpusRow = {
      ...row,
      boundsDeclaration: {
        ...declaration,
        measuredRate: below,
      },
    };
    const oracle = deriveBoundsHeld({ row: mutated });
    expect(oracle.conformant).toBe(false);
    const evidence = oracle.evidence.join(" ");
    expect(evidence).toContain(`measuredRate:${below.toFixed(6)}`);
    expect(evidence).toContain("OFF-BOUNDS");
    expect(evidence).toContain(recordedBounds ?? "");
  });

  test("the row-level catch: the off-bounds probe row FAILs bounds-held over the leaky stack", async () => {
    const row = rowById("probe-audit-off-bounds");
    const { result } = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("FAILED");
    const criterion = criterionOf(result, "bounds-held");
    expect(criterion?.status).toBe("FAIL");
    expect(criterion?.evidence.join(" ")).toContain("OFF-BOUNDS");
    expect(criterion?.evidence.join(" ")).toContain("measuredRate:0.500000");
    expect(criterionOf(result, "observed-terminal-readback")?.status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// 3. an undetected gaming vector (the anti-gaming arm's completeness catch)
// ---------------------------------------------------------------------------

describe("discrimination: an undetected gaming vector", () => {
  test("the derivation-level catch: vector-not-caught with the machinery's miss NAMED", () => {
    const row = rowById("probe-vector-quality-inflation");
    const oracle = deriveGamingProbeCompleteness({
      row,
      probes: [missedProbeOf("quality-inflation")],
    });
    expect(oracle.conformant).toBe(false);
    const evidence = oracle.evidence.join(" ");
    expect(evidence).toContain("vector-not-caught:quality-inflation");
    expect(evidence).toContain("the machinery missed the gaming attempt");
    expect(evidence).toContain("violations:1");
  });

  test("the honest control: the machinery CATCHES the denatured shape (the contrast pair)", () => {
    const row = rowById("probe-vector-quality-inflation");
    const probe = singleGamingProbeOf("quality-inflation");
    expect(probe.caught).toBe(true);
    expect(probe.mechanisms).toEqual([GAMING_MECHANISM_OF["quality-inflation"]]);
    const oracle = deriveGamingProbeCompleteness({ row, probes: [probe] });
    expect(oracle.conformant).toBe(true);
    expect(oracle.evidence.join(" ")).toContain(
      `caught:quality-inflation -> ${GAMING_MECHANISM_OF["quality-inflation"]}`,
    );
  });

  test("a scope-level vector missed by the input-integrity machinery FAILs named (the right oracle must fire)", () => {
    // The controlled fake: the input-integrity machinery alone cannot
    // catch a scope-level vector — the probe reports the miss honestly
    // and the completeness oracle FAILs with the machinery's miss named.
    const row = rowById("probe-vector-post-hoc-exclusion");
    const integrityOnly = deriveCompetitiveInputIntegrity({
      arms: applyGamingVariant(
        honestCompetitiveInputsOf(HEADLINE_COHORT.armSet),
        "post-hoc-exclusion",
      ),
    });
    expect(integrityOnly.conformant).toBe(true);
    const oracle = deriveGamingProbeCompleteness({
      row,
      probes: [
        {
          vectors: ["post-hoc-exclusion"],
          caught: false,
          mechanisms: [],
          evidence: ["NOT CAUGHT (the machinery missed the post-hoc-exclusion gaming attempt)"],
        },
      ],
    });
    expect(oracle.conformant).toBe(false);
    expect(oracle.evidence.join(" ")).toContain("vector-not-caught:post-hoc-exclusion");
    // The honest machinery catches it through the favorable-subset oracle.
    expect(singleGamingProbeOf("post-hoc-exclusion").caught).toBe(true);
  });

  test("a caught vector with the mechanism UNNAMED FAILs named", () => {
    const row = rowById("probe-vector-latency-omission");
    const oracle = deriveGamingProbeCompleteness({
      row,
      probes: [
        {
          vectors: ["latency-omission"],
          caught: true,
          mechanisms: ["an-unnamed-mechanism"],
          evidence: ["caught:an-unnamed-mechanism"],
        },
      ],
    });
    expect(oracle.conformant).toBe(false);
    expect(oracle.evidence.join(" ")).toContain("mechanism-not-named:latency-omission");
  });

  test("a vector with NO probe at all FAILs named", () => {
    const row = rowById("probe-vector-regime-normalization");
    const oracle = deriveGamingProbeCompleteness({ row, probes: [] });
    expect(oracle.conformant).toBe(false);
    expect(oracle.evidence.join(" ")).toContain("vector-not-probed:regime-normalization");
  });

  test("the row-level catch: the miss-fake probe set FAILs gaming-probe-completeness over the leaky stack", async () => {
    const row = rowById("probe-vector-quality-inflation");
    const { result } = await driveRowOverLeakyStack({
      row,
      probes: [missedProbeOf("quality-inflation")],
    });
    expect(result.terminal).toBe("FAILED");
    const criterion = criterionOf(result, "gaming-probe-completeness");
    expect(criterion?.status).toBe("FAIL");
    expect(criterion?.evidence.join(" ")).toContain("vector-not-caught:quality-inflation");
    expect(criterionOf(result, "observed-terminal-readback")?.status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// 4. a combination-gaming case (each probe passes in isolation)
// ---------------------------------------------------------------------------

describe("discrimination: a combination-gaming case", () => {
  test("singles-only probes: combination-not-probed FAILs named", () => {
    const row = rowById("probe-combination-quality-inflation-latency-omission");
    const oracle = deriveGamingProbeCompleteness({
      row,
      probes: [singleGamingProbeOf("quality-inflation"), singleGamingProbeOf("latency-omission")],
    });
    expect(oracle.conformant).toBe(false);
    expect(oracle.evidence.join(" ")).toContain(
      "combination-not-probed:quality-inflation+latency-omission",
    );
  });

  test("an uncaught combination probe: combination-not-caught FAILs with the miss named", () => {
    const row = rowById("probe-combination-quality-inflation-latency-omission");
    const oracle = deriveGamingProbeCompleteness({
      row,
      probes: [
        singleGamingProbeOf("quality-inflation"),
        singleGamingProbeOf("latency-omission"),
        missedCombinationProbeOf(["quality-inflation", "latency-omission"]),
      ],
    });
    expect(oracle.conformant).toBe(false);
    const evidence = oracle.evidence.join(" ");
    expect(evidence).toContain("combination-not-caught:quality-inflation+latency-omission");
    expect(evidence).toContain(
      "each probe in isolation caught but the combination gamed the machinery",
    );
  });

  test("the machinery-level honest control: the COMBINED denaturing is still caught", () => {
    // The final integrated machinery over the honestly-composed attack:
    // BOTH denaturings applied to the honest headline inputs at once.
    const combined = applyGamingVariant(
      applyGamingVariant(honestCompetitiveInputsOf(HEADLINE_COHORT.armSet), "quality-inflation"),
      "latency-omission",
    );
    const integrity = deriveCompetitiveInputIntegrity({ arms: combined });
    expect(integrity.conformant).toBe(false);
    expect(integrity.evidence.join(" ")).toContain("RE-MEASUREMENT MASQUERADE");
    // The honest inputs themselves stay conformant (the contrast pair).
    expect(
      deriveCompetitiveInputIntegrity({ arms: honestCompetitiveInputsOf(HEADLINE_COHORT.armSet) })
        .conformant,
    ).toBe(true);
  });

  test("the honest control: the combination probe caught with BOTH mechanisms named", () => {
    const row = rowById("probe-combination-quality-inflation-latency-omission");
    const probe = combinationGamingProbeOf(["quality-inflation", "latency-omission"]);
    expect(probe.caught).toBe(true);
    const oracle = deriveGamingProbeCompleteness({ row, probes: [probe] });
    expect(oracle.conformant).toBe(true);
    const evidence = oracle.evidence.join(" ");
    expect(evidence).toContain(`caught-combination:quality-inflation+latency-omission ->`);
    expect(evidence).toContain(GAMING_MECHANISM_OF["quality-inflation"]);
    expect(evidence).toContain(GAMING_MECHANISM_OF["latency-omission"]);
    expect(evidence).toContain("violations:0");
  });

  test("the row-level catches: singles-only FAILs, the full probe set COMPLETES", async () => {
    const row = rowById("probe-combination-quality-inflation-latency-omission");
    const singlesOnly = await driveRowOverLeakyStack({
      row,
      probes: [singleGamingProbeOf("quality-inflation"), singleGamingProbeOf("latency-omission")],
    });
    expect(singlesOnly.result.terminal).toBe("FAILED");
    const criterion = criterionOf(singlesOnly.result, "gaming-probe-completeness");
    expect(criterion?.status).toBe("FAIL");
    expect(criterion?.evidence.join(" ")).toContain("combination-not-probed");
    expect(criterionOf(singlesOnly.result, "observed-terminal-readback")?.status).toBe("PASS");

    const honest = await driveRowOverLeakyStack({ row });
    expect(honest.result.terminal).toBe("COMPLETED");
    expect(honest.result.criteria.filter((entry) => entry.status === "FAIL")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. a rubber-stamp audit (verification without re-derivation)
// ---------------------------------------------------------------------------

describe("discrimination: a rubber-stamp audit", () => {
  test("the derivation-level catch: the claimed skip is the NAMED offense", () => {
    const row = rowById("probe-audit-rubber-stamp");
    const oracle = deriveRubberStampDetection({
      row,
      rederivationsExecuted: row.evidence.length,
    });
    expect(oracle.conformant).toBe(false);
    const evidence = oracle.evidence.join(" ");
    expect(evidence).toContain("claimedSkipRederivation:yes (the rubber-stamp confession)");
    expect(evidence).toContain(
      "RUBBER STAMP (verification claimed without re-derivation — the audit must re-derive, not rubber-stamp)",
    );
  });

  test("a zero re-derivation trace FAILs even WITHOUT the confession", () => {
    const row = rowById("replay-adjusted-cost-verdicts");
    const oracle = deriveRubberStampDetection({ row, rederivationsExecuted: 0 });
    expect(oracle.conformant).toBe(false);
    expect(oracle.evidence.join(" ")).toContain("rederivationsExecuted:0");
    // The bit-stability oracle names the un-executed re-derivation too.
    const stability = deriveReplayBitStability({
      row,
      replays: [],
      rederivationsExecuted: 0,
    });
    expect(stability.conformant).toBe(false);
    expect(stability.evidence.join(" ")).toContain("rederivation-not-executed (0 of ");
  });

  test("the honest control: the re-derivation actually executes (the trace named)", () => {
    const row = rowById("replay-cross-workload-verdicts");
    const replays = replaysOf(row);
    const oracle = deriveRubberStampDetection({
      row,
      rederivationsExecuted: replays.length,
    });
    expect(oracle.conformant).toBe(true);
    expect(oracle.evidence.join(" ")).toContain(
      `rederivationsExecuted:${replays.length}/${row.evidence.length}`,
    );
    expect(oracle.evidence.join(" ")).toContain(
      "the re-derivation actually executed (never a rubber stamp)",
    );
  });

  test("the row-level catch: the rubber-stamp probe row FAILs over the leaky stack", async () => {
    const row = rowById("probe-audit-rubber-stamp");
    const { result } = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("FAILED");
    const criterion = criterionOf(result, "rubber-stamp-detection");
    expect(criterion?.status).toBe("FAIL");
    expect(criterion?.evidence.join(" ")).toContain("RUBBER STAMP");
    // The engine ran the re-derivation REGARDLESS (the confession is the
    // named offense — the replays still executed).
    expect(result.replays).toHaveLength(row.evidence.length);
    expect(criterionOf(result, "observed-terminal-readback")?.status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// 6. a favorable-subset audit (the omitted rows NAMED)
// ---------------------------------------------------------------------------

describe("discrimination: a favorable-subset audit", () => {
  test("the derivation-level catch: every omitted row NAMED (the honest FAILED probes are evidence too)", () => {
    const row = rowById("probe-audit-favorable-subset");
    const oracle = deriveFavorableSubsetSampling({ row });
    expect(oracle.conformant).toBe(false);
    const expectedOmitted = offlineRowIdsOf("VAL-044")
      .filter((rowId) => rowId.startsWith("probe-"))
      .map((rowId) => `VAL-044:${rowId}`);
    expect(expectedOmitted.length).toBeGreaterThanOrEqual(6);
    expect(oracle.omitted).toEqual(expectedOmitted);
    const evidence = oracle.evidence.join(" ");
    expect(evidence).toContain("OMITTED-ROWS:");
    for (const omitted of expectedOmitted) {
      expect(evidence).toContain(omitted);
    }
  });

  test("the honest control: the complete declared scope PASSES", () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) => candidate.arm === "REPRODUCIBILITY" && candidate.adversarial === undefined,
    )) {
      const oracle = deriveFavorableSubsetSampling({ row });
      expect(oracle.conformant, row.rowId).toBe(true);
      expect(oracle.omitted, row.rowId).toEqual([]);
      expect(oracle.evidence.join(" "), row.rowId).toContain("complete-scope");
    }
  });

  test("a controlled favorable-subset shape over another work order FAILs with its rows NAMED", () => {
    // The controlled fake: an audit of the VAL-048 record that omits the
    // honest FAILED probes AND the under-powered stop class.
    const complete = offlineRowIdsOf("VAL-048");
    const dropped = complete.filter(
      (rowId) => rowId.startsWith("probe-") || rowId.includes("budget-stop"),
    );
    expect(dropped.length).toBeGreaterThanOrEqual(2);
    const row = rowById("probe-vector-window-cherry-picking");
    const controlled: AuditCorpusRow = {
      ...row,
      arm: "REPRODUCIBILITY",
      auditedWorkOrders: ["VAL-048"],
      evidence: row.evidence.filter((reference) => !dropped.includes(reference.corpusRowId)),
    };
    const oracle = deriveFavorableSubsetSampling({ row: controlled });
    expect(oracle.conformant).toBe(false);
    expect(oracle.omitted).toEqual(dropped.map((rowId) => `VAL-048:${rowId}`));
    expect(oracle.evidence.join(" ")).toContain(`OMITTED-ROWS:VAL-048:${dropped[0]}`);
  });

  test("the arm boundary: an ANTI-GAMING row probes inputs, never the scope (the honest shape)", () => {
    const row = rowById("probe-vector-quality-inflation");
    const oracle = deriveFavorableSubsetSampling({ row });
    expect(oracle.conformant).toBe(true);
    expect(oracle.evidence.join(" ")).toContain(
      "scope:none (the arm probes inputs, not the recorded corpus scope)",
    );
  });

  test("the row-level catch: the favorable-subset probe row FAILs over the leaky stack", async () => {
    const row = rowById("probe-audit-favorable-subset");
    const { result } = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("FAILED");
    const criterion = criterionOf(result, "favorable-subset-sampling");
    expect(criterion?.status).toBe("FAIL");
    const evidence = criterion?.evidence.join(" ") ?? "";
    expect(evidence).toContain("OMITTED-ROWS:");
    expect(evidence).toContain("VAL-044:probe-");
    expect(criterionOf(result, "observed-terminal-readback")?.status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// 7. an unresolved finding (gaming-detected reported resolved, no record)
// ---------------------------------------------------------------------------

describe("discrimination: an unresolved finding", () => {
  test("the derivation-level catch: resolved WITHOUT a fix or accepted-risk record FAILs named", () => {
    const row = rowById("probe-audit-unresolved-finding");
    expect(row.findingResolution).toEqual({ status: "resolved" });
    const oracle = deriveResolutionHonesty({ row });
    expect(oracle.conformant).toBe(false);
    const evidence = oracle.evidence.join(" ");
    expect(evidence).toContain("status:resolved");
    expect(evidence).toContain("fixDigest:none");
    expect(evidence).toContain("acceptedRiskDigest:none");
    expect(evidence).toContain("UNRESOLVED-FINDING");
    expect(evidence).toContain("without a fix or an accepted-risk record");
  });

  test("the honest resolution shapes: a fix digest, an accepted-risk record, or open", () => {
    const base = rowById("probe-finding-accepted-risk-recorded");
    const withFix = deriveResolutionHonesty({
      row: {
        ...base,
        findingResolution: { status: "resolved", fixDigest: "ab12cd34" },
      },
    });
    expect(withFix.conformant).toBe(true);
    expect(withFix.evidence.join(" ")).toContain("resolution-honest");
    const withRisk = deriveResolutionHonesty({ row: base });
    expect(withRisk.conformant).toBe(true);
    expect(withRisk.evidence.join(" ")).toContain("accepted-risk");
    const open = deriveResolutionHonesty({
      row: { ...base, findingResolution: { status: "open" } },
    });
    expect(open.conformant).toBe(true);
    expect(open.evidence.join(" ")).toContain("status:open");
    // An accepted-risk WITHOUT its record digest FAILs too (the honest
    // disposition demands the record).
    const riskless = deriveResolutionHonesty({
      row: { ...base, findingResolution: { status: "accepted-risk" } },
    });
    expect(riskless.conformant).toBe(false);
    expect(riskless.evidence.join(" ")).toContain("UNRESOLVED-FINDING");
  });

  test("the row-level catch: the unresolved-finding probe row FAILs over the leaky stack", async () => {
    const row = rowById("probe-audit-unresolved-finding");
    const { result } = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("FAILED");
    const criterion = criterionOf(result, "resolution-honesty");
    expect(criterion?.status).toBe("FAIL");
    expect(criterion?.evidence.join(" ")).toContain("UNRESOLVED-FINDING");
    expect(criterionOf(result, "observed-terminal-readback")?.status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// 8. verdict grounding (an ungrounded verdict, a digest disagreement,
//    an unresolvable reference)
// ---------------------------------------------------------------------------

describe("discrimination: verdict grounding", () => {
  test("an UNGROUNDED verdict (no cited digest) FAILs named", () => {
    const row = rowById("replay-cross-workload-verdicts");
    const mutated: AuditCorpusRow = {
      ...row,
      expected: { ...row.expected, groundedOn: undefined },
    };
    const oracle = deriveVerdictGrounding({ row: mutated, replays: replaysOf(mutated) });
    expect(oracle.conformant).toBe(false);
    expect(oracle.evidence.join(" ")).toContain(
      "UNGROUNDED (the verdict cites no evidence digest)",
    );
  });

  test("a DIGEST DISAGREEMENT between the cited grounding and the evidence used FAILs named", () => {
    const row = rowById("replay-cross-workload-verdicts");
    const mutated: AuditCorpusRow = {
      ...row,
      expected: { ...row.expected, groundedOn: "deadbeef" },
    };
    const oracle = deriveVerdictGrounding({ row: mutated, replays: replaysOf(mutated) });
    expect(oracle.conformant).toBe(false);
    const evidence = oracle.evidence.join(" ");
    expect(evidence).toContain("declaredGrounding:deadbeef");
    expect(evidence).toContain("recomputedGrounding:");
    expect(evidence).toContain(
      "UNGROUNDED (the verdict's cited digest disagrees with the evidence actually used)",
    );
    // The honest row's cited digest agrees with its own evidence.
    const honest = deriveVerdictGrounding({ row, replays: replaysOf(row) });
    expect(honest.conformant).toBe(true);
    expect(honest.evidence.join(" ")).toContain(
      "grounded (the verdict cites the digest of the evidence actually used)",
    );
  });

  test("an UNRESOLVABLE reference FAILs named (integrity AND grounding degrade together)", () => {
    const row = rowById("replay-substrate-window-facts");
    const reference = row.evidence[0];
    if (reference === undefined) {
      throw new Error("unreachable");
    }
    const unresolvable: AuditedEvidenceReference = {
      workOrder: reference.workOrder,
      corpusRowId: "no-such-recorded-row",
      recordedDigest: "00000000",
      recordedVerdict: "none",
    };
    const mutated: AuditCorpusRow = { ...row, evidence: [unresolvable] };
    const replay = replayRecordedEvidenceOf(unresolvable);
    expect(replay.resolvable).toBe(false);
    const stability = deriveReplayBitStability({
      row: mutated,
      replays: [replay],
      rederivationsExecuted: 1,
    });
    expect(stability.conformant).toBe(false);
    expect(stability.evidence.join(" ")).toContain("unresolvable:VAL-046:no-such-recorded-row");
    // The grounding digest degrades over the unresolvable reference too.
    const grounding = deriveVerdictGrounding({ row: mutated, replays: [replay] });
    expect(grounding.conformant).toBe(false);
    expect(grounding.evidence.join(" ")).toContain("UNGROUNDED");
  });

  test("the NOT-AUDITABLE control: grounded on the declared reason (or refused without one)", () => {
    const row = rowById("boundary-live-measured-slices-not-auditable");
    const oracle = deriveVerdictGrounding({ row, replays: replaysOf(row) });
    expect(oracle.conformant).toBe(true);
    expect(oracle.evidence.join(" ")).toContain("grounded-on-the-declared-boundary");
    // A NOT-AUDITABLE verdict with NO reason is ungrounded (the reason
    // IS the grounding for the honest boundary).
    const reasonless: AuditCorpusRow = {
      ...row,
      expected: { ...row.expected, reason: undefined },
    };
    const refused = deriveVerdictGrounding({ row: reasonless, replays: replaysOf(reasonless) });
    expect(refused.conformant).toBe(false);
    expect(refused.evidence.join(" ")).toContain(
      "UNGROUNDED (a NOT-AUDITABLE verdict must name its reason and declare its boundary)",
    );
  });

  test("the row-level catch: the ungrounded row FAILs verdict-grounding over the leaky stack", async () => {
    const row = rowById("replay-cross-workload-verdicts");
    const mutated: AuditCorpusRow = {
      ...row,
      expected: { ...row.expected, groundedOn: "deadbeef" },
    };
    const { result } = await driveRowOverLeakyStack({ row: mutated });
    expect(result.terminal).toBe("FAILED");
    const criterion = criterionOf(result, "verdict-grounding");
    expect(criterion?.status).toBe("FAIL");
    expect(criterion?.evidence.join(" ")).toContain("declaredGrounding:deadbeef");
    expect(criterionOf(result, "observed-terminal-readback")?.status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// 9. the live-slice boundary discipline (the replay-level honesty)
// ---------------------------------------------------------------------------

describe("discrimination: the live-slice boundary discipline", () => {
  const liveRow = rowById("live-audit-real-rerun-slice");

  test("a REPRODUCIBILITY row replaying a LIVE slice WITHOUT the boundary declaration FAILs named", () => {
    const liveRef = liveRow.evidence[1];
    if (liveRef === undefined) {
      throw new Error("unreachable");
    }
    const controlled: AuditCorpusRow = {
      ...rowById("replay-cross-workload-verdicts"),
      auditedWorkOrders: [],
      evidence: [liveRef],
    };
    const replay = replayRecordedEvidenceOf(liveRef);
    expect(replay.liveSlice).toBe(true);
    const stability = deriveReplayBitStability({
      row: controlled,
      replays: [replay],
      rederivationsExecuted: 1,
    });
    expect(stability.conformant).toBe(false);
    expect(stability.evidence.join(" ")).toContain("live-slice-not-replayable");
    expect(stability.evidence.join(" ")).toContain(
      "a REPRODUCIBILITY row may not replay a live measured slice — the honest boundary row declares it",
    );
  });

  test("the honest control: the declared live-slice boundary PASSES (the boundary evidence named)", () => {
    const row = rowById("boundary-live-measured-slices-not-auditable");
    const stability = deriveReplayBitStability({
      row,
      replays: replaysOf(row),
      rederivationsExecuted: row.evidence.length,
    });
    expect(stability.conformant).toBe(true);
    const evidence = stability.evidence.join(" ");
    expect(evidence).toContain("VAL-044:live-adjusted-synthesis-real-comparison:live-slice");
    expect(evidence).toContain("VAL-048:live-competitive-real-dispatch-slice:live-slice");
    expect(evidence).toContain("(boundary)");
  });

  test("a DECLARED boundary that does not hold FAILs named over the leaky stack", async () => {
    // The controlled fake: the payload-bytes boundary row claims the
    // live-measured-slice kind while citing OFFLINE evidence — the
    // declared boundary must name a real unauditable surface.
    const offlineRef = rowById("replay-adjusted-cost-verdicts").evidence[0];
    if (offlineRef === undefined) {
      throw new Error("unreachable");
    }
    const falseBoundary: AuditCorpusRow = {
      ...rowById("boundary-payload-bytes-never-recorded"),
      boundary: {
        kind: "live-measured-slice",
        reason: "a fabricated boundary kind over offline evidence",
      },
      evidence: [offlineRef],
    };
    const { result } = await driveRowOverLeakyStack({ row: falseBoundary });
    expect(result.terminal).toBe("FAILED");
    const criterion = criterionOf(result, "not-auditable-boundary");
    expect(criterion?.status).toBe("FAIL");
    expect(criterion?.evidence.join(" ")).toContain(
      "the declared boundary does not hold (the boundary must name a real unauditable surface)",
    );
    expect(criterionOf(result, "observed-terminal-readback")?.status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// 10. the mechanical audit-verdict vocabulary (each over controlled shapes)
// ---------------------------------------------------------------------------

describe("discrimination: the mechanical audit-verdict vocabulary", () => {
  test("REPRODUCIBLE-VERIFIED derives from the arm alone (boundary stripped)", () => {
    const row = rowById("boundary-payload-bytes-never-recorded");
    const controlled: AuditCorpusRow = {
      ...row,
      boundary: undefined,
      adversarial: undefined,
    };
    const verdict = deriveAuditVerdict({ row: controlled, replays: [], probes: [] });
    expect(verdict).toEqual({ verdict: "REPRODUCIBLE-VERIFIED", mechanism: null, reason: null });
  });

  test("BOUNDS-HELD derives from the bounds arm (the adversarial claim stripped)", () => {
    const row = rowById("probe-audit-off-bounds");
    const controlled: AuditCorpusRow = {
      ...row,
      adversarial: undefined,
      claimed: undefined,
    };
    const verdict = deriveAuditVerdict({ row: controlled, replays: [], probes: [] });
    expect(verdict).toEqual({ verdict: "BOUNDS-HELD", mechanism: null, reason: null });
  });

  test("GAMING-DETECTED carries the joined NAMED mechanisms (singles + combination)", () => {
    const row = rowById("replay-cross-workload-verdicts");
    const controlled: AuditCorpusRow = {
      ...row,
      arm: "ANTI-GAMING",
      gamingVectors: ["quality-inflation"],
      combinedVectors: ["window-cherry-picking", "post-hoc-exclusion"],
    };
    const verdict = deriveAuditVerdict({ row: controlled, replays: [], probes: [] });
    expect(verdict.verdict).toBe("GAMING-DETECTED");
    expect(verdict.mechanism).toBe(
      [
        GAMING_MECHANISM_OF["quality-inflation"],
        GAMING_MECHANISM_OF["window-cherry-picking"],
        GAMING_MECHANISM_OF["post-hoc-exclusion"],
      ].join(" + "),
    );
    expect(verdict.reason).toBeNull();
  });

  test("NOT-AUDITABLE carries the boundary's own NAMED reason", () => {
    const row = rowById("replay-cross-workload-verdicts");
    const controlled: AuditCorpusRow = {
      ...row,
      boundary: {
        kind: "payload-bytes-never-recorded",
        reason: "the controlled boundary's named reason",
      },
    };
    const verdict = deriveAuditVerdict({ row: controlled, replays: [], probes: [] });
    expect(verdict).toEqual({
      verdict: "NOT-AUDITABLE",
      mechanism: null,
      reason: "the controlled boundary's named reason",
    });
  });

  test("an adversarial declaration derives adversarial-failed and REFUSES first (the precedence)", () => {
    const row = rowById("replay-cross-workload-verdicts");
    const controlled: AuditCorpusRow = {
      ...row,
      arm: "ANTI-GAMING",
      boundary: {
        kind: "payload-bytes-never-recorded",
        reason: "a boundary the adversarial declaration outranks",
      },
      adversarial: "rubber-stamp" as AuditAdversarialKind,
    };
    const verdict = deriveAuditVerdict({ row: controlled, replays: [], probes: [] });
    expect(verdict).toEqual({ verdict: "adversarial-failed", mechanism: null, reason: null });
    // The corpus's own adversarial rows derive the same refusal.
    for (const probe of OFFLINE_CORPUS_ROWS.filter((entry) => entry.adversarial !== undefined)) {
      const derived = deriveAuditVerdict({ row: probe, replays: [], probes: [] });
      expect(derived.verdict, probe.rowId).toBe("adversarial-failed");
    }
  });
});

// ---------------------------------------------------------------------------
// 11. the digest discipline (deterministic + discriminating)
// ---------------------------------------------------------------------------

describe("discrimination: the digest discipline", () => {
  test("the grounding digest is deterministic and discriminating per FIELD", () => {
    const base = {
      workOrder: "VAL-044" as const,
      corpusRowId: "some-recorded-row",
      recordedDigest: "aaaaaaaa",
    };
    const first = auditEvidenceDigestOf([base]);
    expect(first).toMatch(/^[0-9a-f]{8}$/);
    expect(auditEvidenceDigestOf([{ ...base }])).toBe(first);
    expect(auditEvidenceDigestOf([{ ...base, workOrder: "VAL-045" }])).not.toBe(first);
    expect(auditEvidenceDigestOf([{ ...base, corpusRowId: "another-row" }])).not.toBe(first);
    expect(auditEvidenceDigestOf([{ ...base, recordedDigest: "bbbbbbbb" }])).not.toBe(first);
    // The reference ORDER discriminates (the corpus order is pinned).
    expect(auditEvidenceDigestOf([base, { ...base, corpusRowId: "second" }])).not.toBe(
      auditEvidenceDigestOf([{ ...base, corpusRowId: "second" }, base]),
    );
  });

  test("the pinned corpus input digest is deterministic (the config's fingerprint)", () => {
    expect(pinnedAuditInputDigest()).toMatch(/^[0-9a-f]{8}$/);
    expect(pinnedAuditInputDigest()).toBe(pinnedAuditInputDigest());
  });
});

// ---------------------------------------------------------------------------
// 12. the honest controls over the leaky fixture stack
// ---------------------------------------------------------------------------

describe("discrimination: the honest controls over the leaky fixture stack", () => {
  /** Each adversarial audit-probe row's NAMED criterion (the honest failure). */
  const probeNamedCriterion: Readonly<Record<string, string>> = {
    "probe-audit-rubber-stamp": "rubber-stamp-detection",
    "probe-audit-favorable-subset": "favorable-subset-sampling",
    "probe-audit-off-bounds": "bounds-held",
    "probe-audit-unresolved-finding": "resolution-honesty",
  };

  test("every honest verdict SHAPE COMPLETES over the leaky stack (one per kind)", async () => {
    // One representative row per arm and verdict kind: the replay, the
    // declared divergence, both boundaries, the offline bounds floor, a
    // single-vector gaming detection, a combination detection and the
    // accepted-risk resolution.
    for (const rowId of [
      "replay-controls-recorded-arms",
      "replay-declared-divergence-recorded",
      "boundary-live-measured-slices-not-auditable",
      "boundary-payload-bytes-never-recorded",
      "bounds-recorded-confidence-offline",
      "probe-vector-re-measurement-masquerade",
      "probe-combination-hidden-weights-silent-drops",
      "probe-finding-accepted-risk-recorded",
    ]) {
      const row = rowById(rowId);
      const { result } = await driveRowOverLeakyStack({ row });
      expect(result.terminal, rowId).toBe("COMPLETED");
      const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
      expect(failed, `${rowId}: ${JSON.stringify(failed)}`).toEqual([]);
      expect(result.observedTerminal, rowId).toBe("COMPLETED");
      expect(result.auditVerdict.verdict, rowId).toBe(row.expected.verdict);
      expect(result.auditVerdict.mechanism ?? "none", rowId).toBe(row.expected.mechanism ?? "none");
      expect(result.auditVerdict.reason ?? "none", rowId).toBe(row.expected.reason ?? "none");
      // The re-derivation executed on every reference (never a rubber stamp).
      expect(result.replays, rowId).toHaveLength(row.evidence.length);
    }
  });

  test("every adversarial audit-probe row FAILs its NAMED criterion honestly", async () => {
    const probes = OFFLINE_CORPUS_ROWS.filter((row) => row.adversarial !== undefined);
    expect(probes).toHaveLength(4);
    expect(new Set(probes.map((row) => row.adversarial)).size).toBe(4);
    for (const row of probes) {
      const { result } = await driveRowOverLeakyStack({ row });
      expect(result.terminal, row.rowId).toBe("FAILED");
      const named = probeNamedCriterion[row.rowId];
      expect(named, row.rowId).toBeDefined();
      expect(criterionOf(result, named)?.status, `${row.rowId} ${named}`).toBe("FAIL");
      expect(result.observedTerminal, row.rowId).toBe("FAILED");
      expect(criterionOf(result, "observed-terminal-readback")?.status, row.rowId).toBe("PASS");
    }
  });
});
