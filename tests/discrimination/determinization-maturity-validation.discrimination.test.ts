/**
 * VAL-036 acceptance criterion 4 + 6 — the discrimination suite: the
 * determinization-maturity analysis proven against controlled fakes by
 * driving the PURE derivations adversarially per the spec's five named
 * probe families:
 *
 *   * the UNCITED CLAIM — a maturity claim whose evidence citation
 *     misses recorded members (an uncited claim, a partial population)
 *     or cites phantom members each FAILs the citation completeness
 *     with the member named — while the full-population citation
 *     PASSES;
 *   * the GAPPED SERIES — a missing generation, a generation whose
 *     measurements are absent, an extrapolated or fabricated point, or
 *     a point citing an unrecorded digest each FAILs the curve-series
 *     integrity, named — while the gapless recorded series PASSES;
 *   * the MISCLASSIFIED FAMILY — every direction (a variable family
 *     claimed stable, a stable family claimed variable, a trending
 *     family claimed stable, ...) FAILs the classification fidelity
 *     with BOTH sides named — while the four honest classes over their
 *     own shapes PASS;
 *   * the UNRECONCILED SAVINGS — an aggregate-only number, a
 *     non-summing breakdown, a mismatched per-mechanism number (both
 *     sides named) or an inflated total each FAILs the savings
 *     reconciliation — while the canonical per-mechanism
 *     ledger-matched attribution PASSES;
 *   * the INSUFFICIENT-EVIDENCE TREND — a trend or stability claim
 *     from fewer than the pinned minimum generations FAILs as
 *     evidence-stretching — while the honest
 *     immature-insufficient-evidence classification PASSES.
 *
 * Plus the honest controls: the honesty matrix (measured never
 * estimated; honest none-reported boundaries), the refusal honesty,
 * the digest/identity determinism, `verifyDeterminizationMaturityAppContract`
 * catching every fake-world knob at the boundary, the report ledger's
 * append-only exactly-once discipline, and the honest control over the
 * fixture stack (every offline row per its pin; every probe row's
 * adversarial variant FAILing its named criterion).
 */

import { describe, expect, test } from "vitest";
import { runDeterminizationMaturityApp } from "../../benchmarks/validation/apps/determinization-maturity/application";
import {
  DETERMINIZATION_MATURITY_CORPUS,
  familyHistoryById,
  maturityRowById,
  OFFLINE_CORPUS_ROWS,
} from "../../benchmarks/validation/apps/determinization-maturity/corpus";
import {
  createHonestMaturityStack,
  createMaturityFakeApiWorld,
  createMaturityHistoryPort,
  createMaturityReportLedger,
  createTickClock,
} from "../../benchmarks/validation/apps/determinization-maturity/fixtures";
import type { TransportImplementation } from "../../benchmarks/validation/harness/harness";
import type {
  LabUsage,
  LabVerificationCriterion,
} from "../../benchmarks/validation/platform/derive";
import type {
  AppMaturityObservation,
  MaturityClassification,
  MaturityCorpusRow,
  MaturityRunResult,
  PromotionGenerationRecord,
} from "../../benchmarks/validation/platform/determinization-maturity";
import {
  accountingEntryDigestOf,
  canonicalCurveSeriesOf,
  canonicalMaturityCitationOf,
  canonicalSavingsAttributionOf,
  curvePointDigestOf,
  deriveCurveSeriesIntegrity,
  deriveMaturityClassification,
  deriveMaturityEvidenceCitation,
  deriveMaturityHonesty,
  deriveMaturityRefusalHonesty,
  deriveMaturityVerdictKind,
  deriveSavingsReconciliation,
  driveMaturityAnalysis,
  familyLifecycleDigestOf,
  generationRecordDigestOf,
  isEvidenceStretchingClaim,
  MATURITY_CLASSIFICATIONS,
  MINIMUM_GENERATIONS_FOR_TREND,
  maturityCitationDigestOf,
  maturityInputDigestOf,
  maturityReportDigestOf,
  observedMaturityClassificationOf,
  STABILITY_WINDOW_GENERATIONS,
  savingsAttributionDigestOf,
  verifyDeterminizationMaturityAppContract,
} from "../../benchmarks/validation/platform/determinization-maturity";

const REVISION = "1b9018200000000000000000000000000000000aa";

const ragHistory = familyHistoryById("rag-retrieval");
const trendingHistory = familyHistoryById("text-summarization");
const variableHistory = familyHistoryById("order-settlement");
const immatureHistory = familyHistoryById("support-triage");
if (
  ragHistory === null ||
  trendingHistory === null ||
  variableHistory === null ||
  immatureHistory === null
) {
  throw new Error("the pinned family histories are incomplete");
}

const rowById = (rowId: string): MaturityCorpusRow => {
  const row = maturityRowById(rowId);
  if (row === null) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

const taskIndexOf = (rowId: string): number => {
  const index = DETERMINIZATION_MATURITY_CORPUS.findIndex((row) => row.rowId === rowId);
  if (index < 0) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return index;
};

const criterionOf = (criteria: readonly LabVerificationCriterion[], id: string) =>
  criteria.find((criterion) => criterion.criterionId === id);

/** The canonical citation over one family's recorded population. */
const citationOf = (history: NonNullable<ReturnType<typeof familyHistoryById>>) =>
  canonicalMaturityCitationOf({
    lifecycleRecords: history.lifecycleRecords,
    generations: history.generations,
    accountingEntries: history.accountingEntries,
  });

// ---------------------------------------------------------------------------
// Family 1: the uncited claim (the citation-completeness catch)
// ---------------------------------------------------------------------------

describe("VAL-036 discrimination: the uncited claim", () => {
  test("the FULL-population citation PASSES over every recorded family (the control)", () => {
    for (const history of [ragHistory, trendingHistory, variableHistory, immatureHistory]) {
      const verdict = deriveMaturityEvidenceCitation({
        lifecycleRecords: history.lifecycleRecords,
        generations: history.generations,
        accountingEntries: history.accountingEntries,
        citation: citationOf(history),
      });
      expect(verdict.complete, history.familyId).toBe(true);
      expect(verdict.phantomLifecycleProposalIds).toEqual([]);
      expect(verdict.uncitedLifecycleProposalIds).toEqual([]);
      expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
    }
  });

  test("an UNCITED claim (a dropped lifecycle member) FAILs naming the missed member", () => {
    const full = citationOf(ragHistory);
    const dropped = ragHistory.lifecycleRecords[0]?.proposalId ?? "";
    const verdict = deriveMaturityEvidenceCitation({
      lifecycleRecords: ragHistory.lifecycleRecords,
      generations: ragHistory.generations,
      accountingEntries: ragHistory.accountingEntries,
      citation: {
        ...full,
        lifecycleProposalIds: full.lifecycleProposalIds.filter((id) => id !== dropped),
      },
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.uncitedLifecycleProposalIds).toEqual([dropped]);
    const fullPopulation = criterionOf(verdict.criteria, "citation-full-population");
    expect(fullPopulation?.status).toBe("FAIL");
    expect(fullPopulation?.evidence.join(" ")).toContain("PARTIAL-POPULATION");
    expect(fullPopulation?.evidence.join(" ")).toContain(dropped);
  });

  test("a PARTIAL population (a dropped generation digest or accounting digest) FAILs naming the missed member", () => {
    const full = citationOf(ragHistory);
    const droppedGeneration = full.generationDigests[0] ?? "";
    const generationVerdict = deriveMaturityEvidenceCitation({
      lifecycleRecords: ragHistory.lifecycleRecords,
      generations: ragHistory.generations,
      accountingEntries: ragHistory.accountingEntries,
      citation: {
        ...full,
        generationDigests: full.generationDigests.filter((digest) => digest !== droppedGeneration),
      },
    });
    expect(generationVerdict.complete).toBe(false);
    expect(generationVerdict.uncitedGenerationDigests).toEqual([droppedGeneration]);
    expect(criterionOf(generationVerdict.criteria, "citation-full-population")?.status).toBe(
      "FAIL",
    );

    const droppedAccounting = full.accountingEntryDigests[1] ?? "";
    const accountingVerdict = deriveMaturityEvidenceCitation({
      lifecycleRecords: ragHistory.lifecycleRecords,
      generations: ragHistory.generations,
      accountingEntries: ragHistory.accountingEntries,
      citation: {
        ...full,
        accountingEntryDigests: full.accountingEntryDigests.filter(
          (digest) => digest !== droppedAccounting,
        ),
      },
    });
    expect(accountingVerdict.complete).toBe(false);
    expect(accountingVerdict.uncitedAccountingDigests).toEqual([droppedAccounting]);
    expect(criterionOf(accountingVerdict.criteria, "citation-full-population")?.status).toBe(
      "FAIL",
    );
  });

  test("a PHANTOM citation (a cited member that is not recorded) and an EMPTY population each FAIL", () => {
    const full = citationOf(ragHistory);
    const phantom = deriveMaturityEvidenceCitation({
      lifecycleRecords: ragHistory.lifecycleRecords,
      generations: ragHistory.generations,
      accountingEntries: ragHistory.accountingEntries,
      citation: {
        ...full,
        lifecycleProposalIds: [...full.lifecycleProposalIds, "cand-learning-discovery-phantom-1"],
        generationDigests: [...full.generationDigests, "ffffffff"],
      },
    });
    expect(phantom.complete).toBe(false);
    expect(phantom.phantomLifecycleProposalIds).toEqual(["cand-learning-discovery-phantom-1"]);
    expect(phantom.phantomGenerationDigests).toEqual(["ffffffff"]);
    const noPhantom = criterionOf(phantom.criteria, "citation-no-phantom-members");
    expect(noPhantom?.status).toBe("FAIL");
    expect(noPhantom?.evidence.join(" ")).toContain("PHANTOM-CITATION");

    // An empty population is not evidence (a generalization from
    // nothing never passes).
    const empty = deriveMaturityEvidenceCitation({
      lifecycleRecords: [],
      generations: [],
      accountingEntries: [],
      citation: { lifecycleProposalIds: [], generationDigests: [], accountingEntryDigests: [] },
    });
    expect(empty.complete).toBe(false);
    expect(empty.minimumEvidence).toBe(false);
    expect(criterionOf(empty.criteria, "citation-minimum-evidence")?.status).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// Family 2: the gapped series (the curve-integrity catch)
// ---------------------------------------------------------------------------

describe("VAL-036 discrimination: the gapped series", () => {
  test("the GAPLESS recorded series PASSES over every recorded family (the control)", () => {
    for (const history of [ragHistory, trendingHistory, variableHistory, immatureHistory]) {
      const verdict = deriveCurveSeriesIntegrity({
        recordedGenerations: history.generations,
        points: canonicalCurveSeriesOf(history.familyId, history.generations),
      });
      expect(verdict.integral, history.familyId).toBe(true);
      expect(verdict.missingGenerations).toEqual([]);
      expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
    }
  });

  test("a MISSING generation FAILs the gapless leg (named by its ordinal)", () => {
    const canonical = canonicalCurveSeriesOf("text-summarization", trendingHistory.generations);
    const verdict = deriveCurveSeriesIntegrity({
      recordedGenerations: trendingHistory.generations,
      points: canonical.filter((point) => point.generation !== 3),
    });
    expect(verdict.integral).toBe(false);
    expect(verdict.missingGenerations).toEqual([3]);
    const gapless = criterionOf(verdict.criteria, "curve-series-gapless");
    expect(gapless?.status).toBe("FAIL");
    expect(gapless?.evidence.join(" ")).toContain("GAPPED-SERIES");
    expect(gapless?.evidence.join(" ")).toContain("missingGenerations:3");
  });

  test("an UNMEASURED generation FAILs the measured leg (named by its ordinal)", () => {
    const canonical = canonicalCurveSeriesOf("rag-retrieval", ragHistory.generations);
    const verdict = deriveCurveSeriesIntegrity({
      recordedGenerations: ragHistory.generations,
      points: canonical.map((point) =>
        point.generation === 4 ? { ...point, measured: false } : point,
      ),
    });
    expect(verdict.integral).toBe(false);
    expect(verdict.unmeasuredGenerations).toEqual([4]);
    const measured = criterionOf(verdict.criteria, "curve-every-generation-measured");
    expect(measured?.status).toBe("FAIL");
    expect(measured?.evidence.join(" ")).toContain("ABSENT-MEASUREMENTS");
  });

  test("an EXTRAPOLATED point, a FABRICATED point, an UNRECORDED digest and an EMPTY series each FAIL (named)", () => {
    const canonical = canonicalCurveSeriesOf("rag-retrieval", ragHistory.generations);
    const extrapolated = deriveCurveSeriesIntegrity({
      recordedGenerations: ragHistory.generations,
      points: canonical.map((point) =>
        point.generation === 4 ? { ...point, pointSource: "extrapolated" as const } : point,
      ),
    });
    expect(extrapolated.integral).toBe(false);
    expect(extrapolated.extrapolatedGenerations).toEqual([4]);
    const unrecordedPoint = criterionOf(extrapolated.criteria, "curve-recorded-measurements-only");
    expect(unrecordedPoint?.status).toBe("FAIL");
    expect(unrecordedPoint?.evidence.join(" ")).toContain("UNRECORDED-POINT");
    expect(unrecordedPoint?.evidence.join(" ")).toContain("extrapolatedGenerations:4");

    const fabricated = deriveCurveSeriesIntegrity({
      recordedGenerations: ragHistory.generations,
      points: canonical.map((point) =>
        point.generation === 2 ? { ...point, pointSource: "fabricated" as const } : point,
      ),
    });
    expect(fabricated.integral).toBe(false);
    expect(fabricated.fabricatedGenerations).toEqual([2]);
    expect(criterionOf(fabricated.criteria, "curve-recorded-measurements-only")?.status).toBe(
      "FAIL",
    );

    const unrecordedDigest = deriveCurveSeriesIntegrity({
      recordedGenerations: ragHistory.generations,
      points: canonical.map((point) =>
        point.generation === 1 ? { ...point, generationDigest: "ffffffff" } : point,
      ),
    });
    expect(unrecordedDigest.integral).toBe(false);
    expect(unrecordedDigest.unrecordedDigestGenerations).toEqual([1]);
    const digestLeg = criterionOf(
      unrecordedDigest.criteria,
      "curve-points-cite-recorded-generations",
    );
    expect(digestLeg?.status).toBe("FAIL");
    expect(digestLeg?.evidence.join(" ")).toContain("UNRECORDED-GENERATION-DIGEST");

    const empty = deriveCurveSeriesIntegrity({
      recordedGenerations: ragHistory.generations,
      points: [],
    });
    expect(empty.integral).toBe(false);
    expect(empty.minimumSeries).toBe(false);
    expect(criterionOf(empty.criteria, "curve-minimum-series")?.status).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// Family 3: the misclassified family (the classification-fidelity catch)
// ---------------------------------------------------------------------------

describe("VAL-036 discrimination: the misclassified family", () => {
  test("the four honest classes over their own shapes PASS (the control)", () => {
    const honest: readonly [string, MaturityClassification][] = [
      ["rag-retrieval", "determinized-stable"],
      ["text-summarization", "determinizing-trending"],
      ["order-settlement", "variable-resilient"],
      ["support-triage", "immature-insufficient-evidence"],
    ];
    for (const [familyId, claimed] of honest) {
      const history = familyHistoryById(familyId);
      if (history === null) {
        throw new Error(`no pinned history for ${familyId}`);
      }
      const verdict = deriveMaturityClassification({
        generations: history.generations,
        claimed,
      });
      expect(verdict.fidelity, familyId).toBe(true);
      expect(verdict.observed, familyId).toBe(claimed);
      expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
    }
  });

  test("each MISCLASSIFIED direction FAILs with BOTH sides named (claimed vs observed)", () => {
    const directions: readonly {
      readonly familyId: string;
      readonly claimed: MaturityClassification;
    }[] = [
      { familyId: "rag-retrieval", claimed: "variable-resilient" },
      { familyId: "rag-retrieval", claimed: "determinizing-trending" },
      { familyId: "text-summarization", claimed: "determinized-stable" },
      { familyId: "text-summarization", claimed: "variable-resilient" },
      { familyId: "order-settlement", claimed: "determinized-stable" },
      { familyId: "order-settlement", claimed: "determinizing-trending" },
    ];
    for (const { familyId, claimed } of directions) {
      const history = familyHistoryById(familyId);
      if (history === null) {
        throw new Error(`no pinned history for ${familyId}`);
      }
      const verdict = deriveMaturityClassification({ generations: history.generations, claimed });
      expect(verdict.fidelity, `${familyId} claimed ${claimed}`).toBe(false);
      expect(verdict.observed).not.toBe(claimed);
      const fidelity = criterionOf(verdict.criteria, "classification-fidelity");
      expect(fidelity?.status).toBe("FAIL");
      expect(fidelity?.evidence.join(" ")).toContain("MISCLASSIFIED-FAMILY");
      // BOTH sides named: the claimed classification AND the observed one.
      expect(fidelity?.evidence.join(" ")).toContain(`claimed:${claimed}`);
      expect(fidelity?.evidence.join(" ")).toContain(`observed:${verdict.observed}`);
    }
  });

  test("the corpus's claimed classifications are exactly the PURE observed derivation (never asserted)", () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const history = familyHistoryById(row.familyId);
      if (history === null || history.generations.length === 0) {
        // The phantom / generation-less families: the honest immature
        // classification is the only claimable one.
        expect(row.claimedClassification).toBe("immature-insufficient-evidence");
        continue;
      }
      expect(row.claimedClassification, `${row.rowId} observed`).toBe(
        observedMaturityClassificationOf(history.generations),
      );
    }
    // The classification vocabulary is the honest four (guarded).
    expect([...MATURITY_CLASSIFICATIONS]).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Family 4: the unreconciled savings (the economics catch)
// ---------------------------------------------------------------------------

describe("VAL-036 discrimination: the unreconciled savings", () => {
  test("the canonical per-mechanism ledger-matched attribution PASSES (the control)", () => {
    for (const history of [ragHistory, trendingHistory, variableHistory, immatureHistory]) {
      const claimed = canonicalSavingsAttributionOf(history.accountingEntries);
      const verdict = deriveSavingsReconciliation({
        accountingLedger: history.accountingEntries,
        claimedSavings: claimed,
      });
      expect(verdict.reconciled, history.familyId).toBe(true);
      expect(verdict.perMechanismPresent).toBe(true);
      expect(verdict.mismatchedMechanisms).toEqual([]);
      expect(verdict.breakdownSumsToTotal).toBe(true);
      expect(verdict.totalMatchesLedger).toBe(true);
      expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
      // The four CANDIDATE_KINDS mechanisms are attributed SEPARATELY.
      expect(Object.keys(claimed.perMechanism ?? {}).sort()).toEqual([
        "cache",
        "competence",
        "deterministicization",
        "reuse",
      ]);
    }
  });

  test("an AGGREGATE-ONLY claim FAILs and a NON-SUMMING breakdown FAILs", () => {
    // Aggregate-only: a savings number without its per-mechanism
    // breakdown never passes.
    const aggregateOnly = deriveSavingsReconciliation({
      accountingLedger: ragHistory.accountingEntries,
      claimedSavings: {
        totalMicroUsd: canonicalSavingsAttributionOf(ragHistory.accountingEntries).totalMicroUsd,
        perMechanism: null,
      },
    });
    expect(aggregateOnly.reconciled).toBe(false);
    expect(aggregateOnly.perMechanismPresent).toBe(false);
    const breakdown = criterionOf(
      aggregateOnly.criteria,
      "savings-per-mechanism-breakdown-present",
    );
    expect(breakdown?.status).toBe("FAIL");
    expect(breakdown?.evidence.join(" ")).toContain("AGGREGATE-ONLY");

    // Non-summing: the per-mechanism numbers do not sum to the claimed
    // total.
    const canonical = canonicalSavingsAttributionOf(ragHistory.accountingEntries);
    const nonSumming = deriveSavingsReconciliation({
      accountingLedger: ragHistory.accountingEntries,
      claimedSavings: {
        totalMicroUsd: canonical.totalMicroUsd + 7,
        perMechanism: canonical.perMechanism,
      },
    });
    expect(nonSumming.reconciled).toBe(false);
    expect(nonSumming.breakdownSumsToTotal).toBe(false);
    expect(criterionOf(nonSumming.criteria, "savings-breakdown-sums-to-total")?.status).toBe(
      "FAIL",
    );
  });

  test("a MISMATCHED per-mechanism number and an INFLATED total each FAIL with both sides named", () => {
    const canonical = canonicalSavingsAttributionOf(ragHistory.accountingEntries);
    // Mismatched per-mechanism: the claimed reuse number does not match
    // the recorded ledger's reuse total — BOTH sides named.
    const mismatched = deriveSavingsReconciliation({
      accountingLedger: ragHistory.accountingEntries,
      claimedSavings: {
        totalMicroUsd: canonical.totalMicroUsd + 1,
        perMechanism:
          canonical.perMechanism === null
            ? null
            : { ...canonical.perMechanism, reuse: canonical.perMechanism.reuse + 1 },
      },
    });
    expect(mismatched.reconciled).toBe(false);
    const mismatch = mismatched.mismatchedMechanisms.find((entry) => entry.mechanism === "reuse");
    expect(mismatch?.claimedMicroUsd).toBe((canonical.perMechanism?.reuse ?? 0) + 1);
    expect(mismatch?.recordedMicroUsd).toBe(canonical.perMechanism?.reuse ?? 0);
    const matchesLedgers = criterionOf(mismatched.criteria, "savings-breakdown-matches-ledgers");
    expect(matchesLedgers?.status).toBe("FAIL");
    expect(matchesLedgers?.evidence.join(" ")).toContain("UNRECONCILED-SAVINGS");
    expect(matchesLedgers?.evidence.join(" ")).toContain("claimed=");
    expect(matchesLedgers?.evidence.join(" ")).toContain("recorded=");

    // Inflated total: the claimed aggregate does not match the recorded
    // ledger total — both sides named.
    const inflated = deriveSavingsReconciliation({
      accountingLedger: ragHistory.accountingEntries,
      claimedSavings: {
        totalMicroUsd: canonical.totalMicroUsd + 50,
        perMechanism: canonical.perMechanism,
      },
    });
    expect(inflated.reconciled).toBe(false);
    expect(inflated.totalMatchesLedger).toBe(false);
    const total = criterionOf(inflated.criteria, "savings-total-matches-ledger");
    expect(total?.status).toBe("FAIL");
    expect(total?.evidence.join(" ")).toContain("TOTAL-MISMATCH");
    expect(total?.evidence.join(" ")).toContain(`claimedTotal:${canonical.totalMicroUsd + 50}`);
    expect(total?.evidence.join(" ")).toContain(`recordedTotal:${canonical.totalMicroUsd}`);
  });
});

// ---------------------------------------------------------------------------
// Family 5: the insufficient-evidence trend (the evidence-stretching catch)
// ---------------------------------------------------------------------------

describe("VAL-036 discrimination: the insufficient-evidence trend", () => {
  test("a TREND claim from fewer than the minimum generations FAILs as evidence-stretching (named)", () => {
    // The support-triage family holds 2 generations (below the pinned
    // minimum of 3): a trending claim stretches the evidence.
    expect(immatureHistory.generations.length).toBeLessThan(MINIMUM_GENERATIONS_FOR_TREND);
    const verdict = deriveMaturityClassification({
      generations: immatureHistory.generations,
      claimed: "determinizing-trending",
    });
    expect(verdict.fidelity).toBe(false);
    expect(verdict.observed).toBe("immature-insufficient-evidence");
    expect(verdict.stretchedTrend).toBe(true);
    const stretching = criterionOf(verdict.criteria, "classification-no-evidence-stretching");
    expect(stretching?.status).toBe("FAIL");
    expect(stretching?.evidence.join(" ")).toContain("INSUFFICIENT-EVIDENCE-TREND");
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(false);
  });

  test("a STABILITY claim from insufficient evidence FAILs likewise; the honest immature classification PASSES (the control)", () => {
    const stretched = deriveMaturityClassification({
      generations: immatureHistory.generations,
      claimed: "determinized-stable",
    });
    expect(stretched.fidelity).toBe(false);
    expect(stretched.stretchedTrend).toBe(true);
    expect(criterionOf(stretched.criteria, "classification-no-evidence-stretching")?.status).toBe(
      "FAIL",
    );

    // The honest verdict: the family MUST be classified
    // immature-insufficient-evidence — never stretched into a trend.
    const honest = deriveMaturityClassification({
      generations: immatureHistory.generations,
      claimed: "immature-insufficient-evidence",
    });
    expect(honest.fidelity).toBe(true);
    expect(honest.stretchedTrend).toBe(false);
    expect(honest.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("the evidence-stretching boundaries are the pinned thresholds (PURE)", () => {
    expect(MINIMUM_GENERATIONS_FOR_TREND).toBe(3);
    expect(STABILITY_WINDOW_GENERATIONS).toBe(2);
    // A trend/stability claim from fewer than the minimum generations
    // is evidence-stretching; from the minimum it is not.
    expect(isEvidenceStretchingClaim("determinizing-trending", 2)).toBe(true);
    expect(isEvidenceStretchingClaim("determinized-stable", 2)).toBe(true);
    expect(isEvidenceStretchingClaim("determinizing-trending", 3)).toBe(false);
    expect(isEvidenceStretchingClaim("determinized-stable", 3)).toBe(false);
    // The honest weak classifications never stretch (they claim nothing
    // stronger than the evidence).
    expect(isEvidenceStretchingClaim("variable-resilient", 1)).toBe(false);
    expect(isEvidenceStretchingClaim("immature-insufficient-evidence", 1)).toBe(false);
    // The pinned threshold shapes over synthetic series: a full-
    // displacement zero-variance 2-generation series is STILL immature
    // (below the minimum); a 3-generation monotone series is trending.
    const fullTwo: PromotionGenerationRecord[] = [1, 2].map((generation) => ({
      familyId: "synthetic",
      generation,
      baselineModelCalls: 10,
      displacedModelCalls: 10,
      measuredCostMicroUsd: 100,
      measuredLatencyMs: 50,
      perMechanismDisplacements: {
        reuse: 0,
        cache: 0,
        competence: 0,
        deterministicization: 10,
      },
      measured: true,
      lifecycleProposalIds: [`cand-synthetic-${generation}`],
    }));
    expect(observedMaturityClassificationOf(fullTwo)).toBe("immature-insufficient-evidence");
    const monotoneThree: PromotionGenerationRecord[] = [1, 2, 3].map((generation) => ({
      familyId: "synthetic",
      generation,
      baselineModelCalls: 10,
      displacedModelCalls: 2 * generation,
      measuredCostMicroUsd: 100,
      measuredLatencyMs: 50,
      perMechanismDisplacements: {
        reuse: 0,
        cache: 0,
        competence: 0,
        deterministicization: 2 * generation,
      },
      measured: true,
      lifecycleProposalIds: [`cand-synthetic-${generation}`],
    }));
    expect(observedMaturityClassificationOf(monotoneThree)).toBe("determinizing-trending");
  });
});

// ---------------------------------------------------------------------------
// The honesty matrix (measured never estimated; honest boundaries)
// ---------------------------------------------------------------------------

describe("VAL-036 discrimination: the honesty matrix", () => {
  test("MEASURED generations with honestly none-reported offline usage PASS (the control); ESTIMATED FAILs named", () => {
    const measured = deriveMaturityHonesty({
      generations: ragHistory.generations,
      reportedUsage: null,
      liveRail: false,
    });
    expect(measured.honest).toBe(true);
    expect(measured.estimatedGenerations).toEqual([]);
    expect(measured.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);

    // A generation whose measurements were estimated, not measured.
    const estimated = deriveMaturityHonesty({
      generations: ragHistory.generations.map((generation) =>
        generation.generation === 2 ? { ...generation, measured: false } : generation,
      ),
      reportedUsage: null,
      liveRail: false,
    });
    expect(estimated.honest).toBe(false);
    expect(estimated.estimatedGenerations).toEqual([2]);
    const neverEstimated = criterionOf(estimated.criteria, "honesty-measured-never-estimated");
    expect(neverEstimated?.status).toBe("FAIL");
    expect(neverEstimated?.evidence.join(" ")).toContain("ESTIMATED-MEASUREMENT");

    // The live rail's measured usage is honest (the only place usage is
    // admissible).
    const liveUsage: LabUsage = { inputTokens: 12, outputTokens: 3 };
    const live = deriveMaturityHonesty({
      generations: ragHistory.generations,
      reportedUsage: liveUsage,
      liveRail: true,
    });
    expect(live.honest).toBe(true);
    expect(live.noneReportedUsageHonest).toBe(true);
  });

  test("a FABRICATED offline usage FAILs the none-reported boundary (named)", () => {
    const fabricatedUsage: LabUsage = { inputTokens: 5, outputTokens: 1, costUsd: 0.00001 };
    const verdict = deriveMaturityHonesty({
      generations: ragHistory.generations,
      reportedUsage: fabricatedUsage,
      liveRail: false,
    });
    expect(verdict.honest).toBe(false);
    expect(verdict.fabricatedUsage).toBe(true);
    expect(verdict.noneReportedUsageHonest).toBe(false);
    const boundary = criterionOf(verdict.criteria, "honesty-none-reported-boundary");
    expect(boundary?.status).toBe("FAIL");
    expect(boundary?.evidence.join(" ")).toContain("FABRICATED-USAGE");
  });
});

// ---------------------------------------------------------------------------
// The refusal honesty (a refusal is honest only when justified)
// ---------------------------------------------------------------------------

describe("VAL-036 discrimination: the refusal honesty", () => {
  test("justified refusals PASS; unjustified refusals FAIL (both directions)", () => {
    // The phantom family: nothing recorded — the family-unrecorded
    // refusal is justified.
    expect(
      deriveMaturityRefusalHonesty({
        refusal: { reason: "family-unrecorded" },
        lifecycleRecordCount: 0,
        generationCount: 0,
      }).honest,
    ).toBe(true);
    // The tool-routing family: a lifecycle without generations — the
    // no-generations-recorded refusal is justified.
    expect(
      deriveMaturityRefusalHonesty({
        refusal: { reason: "no-generations-recorded" },
        lifecycleRecordCount: 1,
        generationCount: 0,
      }).honest,
    ).toBe(true);
    // A RECORDED family with generations refusing is dishonest (both
    // directions).
    expect(
      deriveMaturityRefusalHonesty({
        refusal: { reason: "family-unrecorded" },
        lifecycleRecordCount: 4,
        generationCount: 4,
      }).honest,
    ).toBe(false);
    expect(
      deriveMaturityRefusalHonesty({
        refusal: { reason: "no-generations-recorded" },
        lifecycleRecordCount: 4,
        generationCount: 4,
      }).honest,
    ).toBe(false);
    // No refusal is honest by default.
    expect(
      deriveMaturityRefusalHonesty({
        refusal: null,
        lifecycleRecordCount: 0,
        generationCount: 0,
      }).honest,
    ).toBe(true);
  });

  test("the verdict derivation orders its failure modes honestly", () => {
    // An honest refusal is immaturity-honest; a dishonest refusal is
    // maturity-invalid (never passable).
    expect(
      deriveMaturityVerdictKind({
        refusal: { reason: "family-unrecorded" },
        refusalHonesty: deriveMaturityRefusalHonesty({
          refusal: { reason: "family-unrecorded" },
          lifecycleRecordCount: 0,
          generationCount: 0,
        }),
        citation: null,
        curveIntegrity: null,
        classification: null,
        savingsReconciliation: null,
        honesty: null,
        inputUnchanged: true,
        failure: null,
      }),
    ).toBe("immaturity-honest");
    expect(
      deriveMaturityVerdictKind({
        refusal: { reason: "family-unrecorded" },
        refusalHonesty: deriveMaturityRefusalHonesty({
          refusal: { reason: "family-unrecorded" },
          lifecycleRecordCount: 4,
          generationCount: 4,
        }),
        citation: null,
        curveIntegrity: null,
        classification: null,
        savingsReconciliation: null,
        honesty: null,
        inputUnchanged: true,
        failure: null,
      }),
    ).toBe("maturity-invalid");
    // A dispatch failure is an invalid run (recorded honestly, never
    // smoothed into a pass).
    expect(
      deriveMaturityVerdictKind({
        refusal: null,
        refusalHonesty: null,
        citation: null,
        curveIntegrity: null,
        classification: null,
        savingsReconciliation: null,
        honesty: null,
        inputUnchanged: true,
        failure: { category: "provider-unavailable", message: "upstream 503" },
      }),
    ).toBe("maturity-invalid");
  });
});

// ---------------------------------------------------------------------------
// The digest / identity determinism (payload-free, discriminating)
// ---------------------------------------------------------------------------

describe("VAL-036 discrimination: the digest + identity determinism", () => {
  test("every digest is deterministic and payload-free (FNV-1a 8-hex)", () => {
    const lifecycle = ragHistory.lifecycleRecords[0];
    if (lifecycle === undefined) {
      throw new Error("the RAG family history holds no lifecycle records");
    }
    expect(familyLifecycleDigestOf(lifecycle)).toBe(familyLifecycleDigestOf(lifecycle));
    expect(familyLifecycleDigestOf(lifecycle)).toMatch(/^[0-9a-f]{8}$/);
    const generation = ragHistory.generations[0];
    if (generation === undefined) {
      throw new Error("the RAG family history holds no generations");
    }
    expect(generationRecordDigestOf(generation)).toBe(generationRecordDigestOf(generation));
    expect(generationRecordDigestOf(generation)).toMatch(/^[0-9a-f]{8}$/);
    const entry = ragHistory.accountingEntries[0];
    if (entry === undefined) {
      throw new Error("the RAG family history holds no accounting entries");
    }
    expect(accountingEntryDigestOf(entry)).toBe(accountingEntryDigestOf(entry));
    expect(accountingEntryDigestOf(entry)).toMatch(/^[0-9a-f]{8}$/);
    const point = canonicalCurveSeriesOf("rag-retrieval", ragHistory.generations)[0];
    if (point === undefined) {
      throw new Error("the RAG family history holds no curve points");
    }
    expect(curvePointDigestOf(point)).toBe(curvePointDigestOf(point));
    expect(curvePointDigestOf(point)).toMatch(/^[0-9a-f]{8}$/);
    const citation = citationOf(ragHistory);
    expect(maturityCitationDigestOf(citation)).toBe(maturityCitationDigestOf(citation));
    expect(maturityCitationDigestOf(citation)).toMatch(/^[0-9a-f]{8}$/);
    const savings = canonicalSavingsAttributionOf(ragHistory.accountingEntries);
    expect(savingsAttributionDigestOf(savings)).toBe(savingsAttributionDigestOf(savings));
    const report = {
      familyId: "rag-retrieval",
      classification: "determinized-stable" as const,
      curvePointDigests: [point.generationDigest],
      savings,
      citationDigest: maturityCitationDigestOf(citation),
    };
    expect(maturityReportDigestOf(report)).toBe(maturityReportDigestOf(report));
    const facts = createMaturityHistoryPort().facts();
    expect(maturityInputDigestOf(facts)).toBe(maturityInputDigestOf(facts));
    expect(maturityInputDigestOf(facts)).toMatch(/^[0-9a-f]{8}$/);
  });

  test("the digests DISCRIMINATE (different facts, different digests)", () => {
    const lifecycle = ragHistory.lifecycleRecords[0];
    const generation = ragHistory.generations[0];
    const entry = ragHistory.accountingEntries[0];
    if (lifecycle === undefined || generation === undefined || entry === undefined) {
      throw new Error("the RAG family history is incomplete");
    }
    expect(familyLifecycleDigestOf(lifecycle)).not.toBe(
      familyLifecycleDigestOf({ ...lifecycle, generation: lifecycle.generation + 1 }),
    );
    expect(generationRecordDigestOf(generation)).not.toBe(
      generationRecordDigestOf({
        ...generation,
        displacedModelCalls: generation.displacedModelCalls + 1,
      }),
    );
    expect(accountingEntryDigestOf(entry)).not.toBe(
      accountingEntryDigestOf({ ...entry, microUsd: entry.microUsd + 1 }),
    );
    const point = canonicalCurveSeriesOf("rag-retrieval", ragHistory.generations)[0];
    if (point === undefined) {
      throw new Error("the RAG family history holds no curve points");
    }
    expect(curvePointDigestOf(point)).not.toBe(
      curvePointDigestOf({ ...point, measuredCostMicroUsd: point.measuredCostMicroUsd + 1 }),
    );
    // The input digest discriminates the facts view (a rewritten
    // recorded history changes it).
    const honest = createMaturityHistoryPort();
    const mutatedFacts = {
      ...honest.facts(),
      lifecycleRecordCount: honest.facts().lifecycleRecordCount + 1,
    };
    expect(maturityInputDigestOf(honest.facts())).not.toBe(maturityInputDigestOf(mutatedFacts));
    // The citation digest discriminates a dropped member.
    const citation = citationOf(ragHistory);
    expect(maturityCitationDigestOf(citation)).not.toBe(
      maturityCitationDigestOf({
        ...citation,
        lifecycleProposalIds: citation.lifecycleProposalIds.slice(0, -1),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// The app contract over the fake-world knobs (the boundary catch)
// ---------------------------------------------------------------------------

describe("VAL-036 discrimination: the app contract over the fake-world knobs", () => {
  type Knobs = {
    readonly terminal?: "COMPLETED" | "FAILED";
    readonly uncited?: boolean;
    readonly gapped?: boolean;
    readonly extrapolated?: boolean;
    readonly misclassified?: boolean;
    readonly aggregatesavings?: boolean;
    readonly unreconciled?: boolean;
    readonly unreported?: boolean;
  };

  async function runAppWithKnobs(
    options: Knobs,
  ): Promise<Awaited<ReturnType<typeof runDeterminizationMaturityApp>>> {
    const clock = createTickClock();
    const world = createMaturityFakeApiWorld({
      clock,
      ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
      ...(options.uncited === true ? { uncited: true } : {}),
      ...(options.gapped === true ? { gapped: true } : {}),
      ...(options.extrapolated === true ? { extrapolated: true } : {}),
      ...(options.misclassified === true ? { misclassified: true } : {}),
      ...(options.aggregatesavings === true ? { aggregatesavings: true } : {}),
      ...(options.unreconciled === true ? { unreconciled: true } : {}),
      ...(options.unreported === true ? { unreported: true } : {}),
    });
    return runDeterminizationMaturityApp({
      config: {
        applicationId: "app-1",
        baseUrl: "http://fake-zeck.local",
        tokenEnvVar: "ZECK_VALIDATION_TOKEN",
        applicationRevision: REVISION,
        corpusRevision: REVISION,
        integrationSurface: "sdk",
        pollIntervalMs: 1,
        completionTimeoutMs: 5_000,
      },
      token: "zeck-token-fake",
      transport: world.transport as TransportImplementation,
      now: clock.now,
      sleep: async () => {
        clock.tick();
      },
      environment: {
        runtime: "node test",
        toolchain: "vitest",
        database: "none",
        configuration: { suite: "val-036-discrimination" },
      },
      runSuffix: "discrimination",
      taskIndex: taskIndexOf("rag-retrieval-determinized-stable"),
    });
  }

  test("the honest world passes the boundary contract (the control)", async () => {
    const outcome = await runAppWithKnobs({});
    expect(outcome.passed).toBe(true);
    expect(outcome.appCriteria.filter((criterion) => criterion.status === "FAIL")).toEqual([]);
    expect(outcome.classification).toBe("determinized-stable");
    expect(outcome.reportRecorded).toBe(true);
  });

  test("EVERY fake-world knob FAILs a specific boundary criterion (never a silent pass)", async () => {
    // The uncited knob surfaces the citation digests the boundary
    // observation does not carry — that family is caught by the
    // DRIVER-level citation oracle (the probe-variant suite below);
    // every other knob is caught AT the boundary.
    const knobToCriterion: readonly { readonly knob: Knobs; readonly criterionId: string }[] = [
      { knob: { gapped: true }, criterionId: "app-curve-series-gapless" },
      { knob: { extrapolated: true }, criterionId: "app-curve-recorded-measurements-only" },
      { knob: { misclassified: true }, criterionId: "app-classification-read-back" },
      {
        knob: { aggregatesavings: true },
        criterionId: "app-savings-per-mechanism-breakdown-present",
      },
      { knob: { unreconciled: true }, criterionId: "app-savings-total-matches-ledger" },
      { knob: { unreported: true }, criterionId: "app-report-landing" },
    ];
    for (const { knob, criterionId } of knobToCriterion) {
      const outcome = await runAppWithKnobs(knob);
      expect(outcome.passed, criterionId).toBe(false);
      const criterion = outcome.appCriteria.find((c) => c.criterionId === criterionId);
      expect(criterion, criterionId).toBeDefined();
      expect(criterion?.status, criterionId).toBe("FAIL");
    }
    // A terminal override FAILs the harness's own outcome assertion
    // (the honest terminal is the run's contract — never smoothed).
    const failed = await runAppWithKnobs({ terminal: "FAILED" });
    expect(failed.passed).toBe(false);
    expect(failed.observedTerminal).toBe("FAILED");
  });

  test("verifyDeterminizationMaturityAppContract re-derives every leg over a DIRECT observation (never trusting the platform)", () => {
    const row = rowById("rag-retrieval-determinized-stable");
    // The honest observation: every leg re-derives PASS at the boundary.
    const honestObservation: AppMaturityObservation = {
      executionId: "exec-1",
      replayed: false,
      rejection: null,
      terminal: "COMPLETED",
      verificationStatuses: ["PASS", "PASS"],
      classification: row.claimedClassification,
      refusalReason: null,
      curveSeries: row.curveSeries.map((point) => ({
        generation: point.generation,
        displacedModelCalls: point.displacedModelCalls,
        measuredCostMicroUsd: point.measuredCostMicroUsd,
        measuredLatencyMs: point.measuredLatencyMs,
        measured: point.measured,
        pointSource: point.pointSource,
        generationDigest: point.generationDigest,
        lifecycleProposalIds: [...point.lifecycleProposalIds],
      })),
      savings: row.claimedSavings,
      reportRecorded: true,
      observedModelCalls: 0,
      trajectoryDigest: "abcd1234",
    };
    const honest = verifyDeterminizationMaturityAppContract({
      row,
      observation: honestObservation,
    });
    expect(honest.every((criterion) => criterion.status === "PASS")).toBe(true);

    // A misclassified read-back FAILs the classification read-back leg
    // (the platform surfaced a different classification than the claim).
    const misclassified = verifyDeterminizationMaturityAppContract({
      row,
      observation: {
        ...honestObservation,
        classification: "variable-resilient",
      },
    });
    expect(criterionOf(misclassified, "app-classification-read-back")?.status).toBe("FAIL");

    // A curve read-back that CONTRADICTS the claim FAILs the boundary
    // re-derivation of the fidelity (the read-back series itself no
    // longer supports the claimed stable classification).
    const contradictingCurve = verifyDeterminizationMaturityAppContract({
      row,
      observation: {
        ...honestObservation,
        curveSeries: honestObservation.curveSeries.map((point) => ({
          ...point,
          displacedModelCalls: point.generation === 4 ? 4 : point.displacedModelCalls,
        })),
      },
    });
    expect(criterionOf(contradictingCurve, "app-classification-fidelity-re-derived")?.status).toBe(
      "FAIL",
    );

    // An aggregate-only read-back FAILs the boundary reconciliation.
    const aggregateOnly = verifyDeterminizationMaturityAppContract({
      row,
      observation: {
        ...honestObservation,
        savings: { totalMicroUsd: row.claimedSavings.totalMicroUsd, perMechanism: null },
      },
    });
    expect(criterionOf(aggregateOnly, "app-savings-per-mechanism-breakdown-present")?.status).toBe(
      "FAIL",
    );

    // An unreported report on an established row FAILs the landing leg.
    const unreported = verifyDeterminizationMaturityAppContract({
      row,
      observation: { ...honestObservation, reportRecorded: false },
    });
    expect(criterionOf(unreported, "app-report-landing")?.status).toBe("FAIL");

    // An over-dispatched run FAILs the own-dispatches leg.
    const overDispatched = verifyDeterminizationMaturityAppContract({
      row,
      observation: { ...honestObservation, observedModelCalls: 2 },
    });
    expect(criterionOf(overDispatched, "app-own-dispatches")?.status).toBe("FAIL");

    // A refusal row's read-back must match its pinned refusal reason.
    const refusalRow = rowById("unrecorded-family-maturity-refusal");
    const refusalObservation: AppMaturityObservation = {
      ...honestObservation,
      classification: "immature-insufficient-evidence",
      refusalReason: "family-unrecorded",
      curveSeries: [],
      savings: refusalRow.claimedSavings,
      reportRecorded: false,
    };
    const refusal = verifyDeterminizationMaturityAppContract({
      row: refusalRow,
      observation: refusalObservation,
    });
    expect(refusal.every((criterion) => criterion.status === "PASS")).toBe(true);
    const refusalMismatch = verifyDeterminizationMaturityAppContract({
      row: refusalRow,
      observation: { ...refusalObservation, refusalReason: "no-generations-recorded" },
    });
    expect(criterionOf(refusalMismatch, "app-refusal-read-back")?.status).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// The report ledger exactly-once (append-only)
// ---------------------------------------------------------------------------

describe("VAL-036 discrimination: the report ledger is append-only exactly-once", () => {
  test("the identical re-append REPLAYS; a DIFFERENT report under the same family is REFUSED", async () => {
    const ledger = createMaturityReportLedger();
    const savings = canonicalSavingsAttributionOf(ragHistory.accountingEntries);
    const report = {
      familyId: "rag-retrieval",
      classification: "determinized-stable" as const,
      curvePointDigests: canonicalCurveSeriesOf("rag-retrieval", ragHistory.generations).map(
        (point) => curvePointDigestOf(point),
      ),
      savings,
      citationDigest: maturityCitationDigestOf(citationOf(ragHistory)),
    };
    const first = await ledger.append(report);
    expect(first).toEqual({ accepted: true, replayed: false, refused: false });
    // The IDENTICAL re-append REPLAYS (idempotent — exactly-once).
    const second = await ledger.append(report);
    expect(second).toEqual({ accepted: true, replayed: true, refused: false });
    expect(ledger.reportsFor("rag-retrieval")).toHaveLength(1);
    // A DIFFERENT report under the same familyId is REFUSED.
    const impostor = await ledger.append({
      ...report,
      classification: "variable-resilient" as const,
    });
    expect(impostor).toEqual({ accepted: false, replayed: false, refused: true });
    expect(ledger.reportsFor("rag-retrieval")).toHaveLength(1);
    expect(ledger.appendLog()).toHaveLength(3);
    expect(ledger.appendLog().filter((entry) => entry.replayed)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The honest controls over the fixture stack (the AC6 close)
// ---------------------------------------------------------------------------

describe("VAL-036 discrimination: the honest controls over the fixture stack", () => {
  test("every offline row over the honest stack behaves per its pin", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const stack = createHonestMaturityStack();
      const result: MaturityRunResult = await driveMaturityAnalysis({
        row,
        analysis: stack.history,
        reportLedger: stack.reportLedger,
        now: stack.clock.now,
      });
      expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
      expect(result.verdict, `${row.rowId} verdict`).toBe(row.expected.verdict);
      const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
      expect(failed, `${row.rowId}: ${JSON.stringify(failed)}`).toEqual([]);
      expect(result.observedModelCalls, `${row.rowId} own dispatches`).toBe(
        row.expected.modelCalls,
      );
      expect(result.usage, `${row.rowId} offline usage none-reported`).toBeNull();
      expect(result.inputUnchanged, `${row.rowId} read-only input`).toBe(true);
      expect(result.latencyMs, `${row.rowId} latency measured`).toBeGreaterThanOrEqual(0);
      if (row.expected.verdict === "maturity-established") {
        expect(result.reportLanded?.accepted, `${row.rowId} report landed`).toBe(true);
      } else {
        expect(result.refusal?.reason, `${row.rowId} refusal reason`).toBe(
          row.expected.refusalReason,
        );
        expect(result.reportsAppended, `${row.rowId} refusal appends nothing`).toBe(0);
      }
    }
  });

  test("the five probe rows' ADVERSARIAL variants each FAIL their named criterion (the AC6 core)", async () => {
    const driveVariant = async (
      rowId: string,
      mutate: (row: MaturityCorpusRow) => MaturityCorpusRow,
    ): Promise<MaturityRunResult> => {
      const row = mutate(rowById(rowId));
      const stack = createHonestMaturityStack();
      return driveMaturityAnalysis({
        row,
        analysis: stack.history,
        reportLedger: stack.reportLedger,
        now: stack.clock.now,
      });
    };

    // uncited-claim: the citation drops a recorded lifecycle member.
    const uncited = await driveVariant("probe-uncited-claim", (row) => ({
      ...row,
      citation: {
        ...row.citation,
        lifecycleProposalIds: row.citation.lifecycleProposalIds.slice(0, -1),
      },
    }));
    expect(uncited.terminal).toBe("FAILED");
    expect(uncited.verdict).toBe("maturity-invalid");
    expect(criterionOf(uncited.criteria, "citation-full-population")?.status).toBe("FAIL");
    expect(uncited.citation?.uncitedLifecycleProposalIds).toHaveLength(1);

    // gapped-series: the curve series drops generation 3.
    const gapped = await driveVariant("probe-gapped-series", (row) => ({
      ...row,
      curveSeries: row.curveSeries.filter((point) => point.generation !== 3),
    }));
    expect(gapped.terminal).toBe("FAILED");
    expect(gapped.verdict).toBe("maturity-invalid");
    expect(criterionOf(gapped.criteria, "curve-series-gapless")?.status).toBe("FAIL");
    expect(gapped.curveIntegrity?.missingGenerations).toEqual([3]);

    // misclassified-family: the variable family claimed stable.
    const misclassified = await driveVariant("probe-misclassified-family", (row) => ({
      ...row,
      claimedClassification: "determinized-stable",
    }));
    expect(misclassified.terminal).toBe("FAILED");
    expect(misclassified.verdict).toBe("maturity-invalid");
    const fidelity = criterionOf(misclassified.criteria, "classification-fidelity");
    expect(fidelity?.status).toBe("FAIL");
    expect(fidelity?.evidence.join(" ")).toContain("MISCLASSIFIED-FAMILY");
    expect(fidelity?.evidence.join(" ")).toContain("claimed:determinized-stable");
    expect(fidelity?.evidence.join(" ")).toContain("observed:variable-resilient");

    // unreconciled-savings: the aggregate-only shape (no per-mechanism
    // breakdown).
    const aggregateOnly = await driveVariant("probe-unreconciled-savings", (row) => ({
      ...row,
      claimedSavings: { totalMicroUsd: row.claimedSavings.totalMicroUsd, perMechanism: null },
    }));
    expect(aggregateOnly.terminal).toBe("FAILED");
    expect(aggregateOnly.verdict).toBe("maturity-invalid");
    expect(
      criterionOf(aggregateOnly.criteria, "savings-per-mechanism-breakdown-present")?.status,
    ).toBe("FAIL");

    // insufficient-evidence-trend: the 2-generation family claimed
    // trending — the evidence-stretching catch.
    const stretched = await driveVariant("probe-insufficient-evidence-trend", (row) => ({
      ...row,
      claimedClassification: "determinizing-trending",
    }));
    expect(stretched.terminal).toBe("FAILED");
    expect(stretched.verdict).toBe("maturity-invalid");
    expect(criterionOf(stretched.criteria, "classification-no-evidence-stretching")?.status).toBe(
      "FAIL",
    );
    expect(stretched.classification?.stretchedTrend).toBe(true);

    // Every adversarial shape withheld its report (nothing lands).
    for (const result of [uncited, gapped, misclassified, aggregateOnly, stretched]) {
      expect(result.reportsAppended).toBe(0);
      expect(result.reportLanded).toBeNull();
    }
  });
});
