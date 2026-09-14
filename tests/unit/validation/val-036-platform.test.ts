/**
 * VAL-036 acceptance criteria 1, 2, 4, 5: the determinization-maturity
 * platform slice against controlled fakes — the maturity vocabulary
 * (the classification / verdict / refusal / probe vocabularies; the
 * pinned thresholds — the minimum generations for a trend, the
 * stability window; the curve-point sources), the PURE derivations
 * that make a maturity claim trustworthy (the evidence-citation
 * matrix — a full-population pass and each phantom / uncited /
 * partial-population / empty-population shape FAILing with the member
 * named; the curve-integrity matrix — a gapless measured pass while
 * each gapped / unmeasured / extrapolated / fabricated /
 * unrecorded-digest shape FAILs, named; the classification-fidelity
 * matrix — each honest class over its own shape passing while every
 * misclassification FAILs with both sides named and the
 * insufficient-evidence trend FAILs as evidence-stretching; the
 * savings-reconciliation matrix — a per-mechanism ledger-matched pass
 * while the aggregate-only / mismatched / non-summing shapes FAIL
 * with both sides named; the honesty matrix — measured passes while
 * the estimated-measurement and fabricated-usage shapes FAIL), the
 * refusal honesty, the digest discipline (deterministic, canonical,
 * payload-free), the append-only report ledger, the driver over
 * every offline corpus row, and the ADVERSARIAL worlds (the
 * GAPPED / UNMEASURED / UNRECONCILED / MUTATING history variants).
 */

import { describe, expect, test } from "vitest";
import {
  FAMILY_HISTORIES,
  familyHistoryById,
  OFFLINE_CORPUS_ROWS,
} from "../../../benchmarks/validation/apps/determinization-maturity/corpus";
import {
  createHonestMaturityStack,
  createMaturityHistoryPort,
  createMaturityReportLedger,
  type FakeHistoryVariant,
} from "../../../benchmarks/validation/apps/determinization-maturity/fixtures";
import type { LabUsage } from "../../../benchmarks/validation/platform/derive";
import type {
  AccountingLedgerEntry,
  CurvePointShape,
  MaturityCorpusRow,
  PromotionGenerationRecord,
  SavingsAttribution,
} from "../../../benchmarks/validation/platform/determinization-maturity";
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
  deriveMaturityRowCriteria,
  deriveMaturityVerdictKind,
  deriveSavingsReconciliation,
  driveMaturityAnalysis,
  generationRecordDigestOf,
  isCurvePointSource,
  isEvidenceStretchingClaim,
  isMaturityClassification,
  isMaturityProbeKind,
  isMaturityRefusalReason,
  isMaturityVerdictKind,
  MATURITY_CLASSIFICATIONS,
  MATURITY_EXPERIMENT_KIND,
  MATURITY_LEARNING_PHASE,
  MATURITY_PROBE_KINDS,
  MATURITY_REFUSAL_REASONS,
  MATURITY_VERDICTS,
  MINIMUM_GENERATIONS_FOR_TREND,
  maturityCitationDigestOf,
  maturityInputDigestOf,
  maturityReportDigestOf,
  observedMaturityClassificationOf,
  STABILITY_WINDOW_GENERATIONS,
  savingsAttributionDigestOf,
} from "../../../benchmarks/validation/platform/determinization-maturity";
import { longitudinalDigestOf } from "../../../benchmarks/validation/platform/longitudinal-baseline";

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
  const row = OFFLINE_CORPUS_ROWS.find((candidate) => candidate.rowId === rowId);
  if (row === undefined) {
    throw new Error(`no offline corpus row ${rowId}`);
  }
  return row;
};

/** A deterministic generation record builder (the measured basis). */
function generationOf(input: {
  readonly familyId?: string;
  readonly generation: number;
  readonly baseline: number;
  readonly displaced: number;
  readonly measured?: boolean;
}): PromotionGenerationRecord {
  return {
    familyId: input.familyId ?? "test-family",
    generation: input.generation,
    baselineModelCalls: input.baseline,
    displacedModelCalls: input.displaced,
    measuredCostMicroUsd: 100 * input.generation,
    measuredLatencyMs: 50 * input.generation,
    perMechanismDisplacements: {
      reuse: 0,
      cache: 0,
      competence: 0,
      deterministicization: input.displaced,
    },
    measured: input.measured ?? true,
    lifecycleProposalIds: [`cand-test-${input.generation}`],
  };
}

/** The honest savings over the RAG family's pinned ledger. */
const ragSavings: SavingsAttribution = canonicalSavingsAttributionOf(ragHistory.accountingEntries);

describe("VAL-036 platform vocabulary pins", () => {
  test("the learning phase + experiment kind are pinned", () => {
    expect(MATURITY_LEARNING_PHASE).toBe("maturity");
    expect(MATURITY_EXPERIMENT_KIND).toBe("determinization-maturity");
  });

  test("the maturity classifications are the honest four (guarded)", () => {
    expect([...MATURITY_CLASSIFICATIONS]).toEqual([
      "determinized-stable",
      "determinizing-trending",
      "variable-resilient",
      "immature-insufficient-evidence",
    ]);
    for (const classification of MATURITY_CLASSIFICATIONS) {
      expect(isMaturityClassification(classification)).toBe(true);
    }
    expect(isMaturityClassification("determinized")).toBe(false);
  });

  test("the verdict / refusal / probe vocabularies are pinned (guarded)", () => {
    expect([...MATURITY_VERDICTS]).toEqual([
      "maturity-established",
      "immaturity-honest",
      "maturity-invalid",
    ]);
    for (const verdict of MATURITY_VERDICTS) {
      expect(isMaturityVerdictKind(verdict)).toBe(true);
    }
    expect([...MATURITY_REFUSAL_REASONS]).toEqual(["family-unrecorded", "no-generations-recorded"]);
    for (const reason of MATURITY_REFUSAL_REASONS) {
      expect(isMaturityRefusalReason(reason)).toBe(true);
    }
    expect([...MATURITY_PROBE_KINDS]).toEqual([
      "uncited-claim",
      "gapped-series",
      "misclassified-family",
      "unreconciled-savings",
      "insufficient-evidence-trend",
    ]);
    for (const probe of MATURITY_PROBE_KINDS) {
      expect(isMaturityProbeKind(probe)).toBe(true);
    }
    expect(isMaturityProbeKind("fabricated-trend")).toBe(false);
  });

  test("the thresholds are pinned: minimum generations for a trend + the stability window", () => {
    expect(MINIMUM_GENERATIONS_FOR_TREND).toBe(3);
    expect(STABILITY_WINDOW_GENERATIONS).toBe(2);
  });

  test("the curve-point sources: recorded is the only admissible source (guarded)", () => {
    expect(isCurvePointSource("recorded")).toBe(true);
    expect(isCurvePointSource("extrapolated")).toBe(true);
    expect(isCurvePointSource("fabricated")).toBe(true);
    expect(isCurvePointSource("estimated")).toBe(false);
  });

  test("the corpus covers every classification + every probe + both refusals over 11 offline rows", () => {
    expect(OFFLINE_CORPUS_ROWS).toHaveLength(11);
    const claimed = new Set(OFFLINE_CORPUS_ROWS.map((row) => row.claimedClassification));
    expect(claimed.has("determinized-stable")).toBe(true);
    expect(claimed.has("determinizing-trending")).toBe(true);
    expect(claimed.has("variable-resilient")).toBe(true);
    expect(claimed.has("immature-insufficient-evidence")).toBe(true);
    const probes = new Set(
      OFFLINE_CORPUS_ROWS.filter((row) => row.probe !== undefined).map((row) => row.probe?.kind),
    );
    expect(probes.size).toBe(MATURITY_PROBE_KINDS.length);
    const refusals = OFFLINE_CORPUS_ROWS.filter((row) => row.expected.refusalReason !== null);
    expect(refusals.map((row) => row.expected.refusalReason).sort()).toEqual([
      "family-unrecorded",
      "no-generations-recorded",
    ]);
  });
});

describe("VAL-036 evidence-citation matrix", () => {
  test("the canonical full-population citation PASSES over the RAG family", () => {
    const citation = canonicalMaturityCitationOf({
      lifecycleRecords: ragHistory.lifecycleRecords,
      generations: ragHistory.generations,
      accountingEntries: ragHistory.accountingEntries,
    });
    const verdict = deriveMaturityEvidenceCitation({
      lifecycleRecords: ragHistory.lifecycleRecords,
      generations: ragHistory.generations,
      accountingEntries: ragHistory.accountingEntries,
      citation,
    });
    expect(verdict.complete).toBe(true);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("an UNCITED claim (a dropped lifecycle member) FAILs naming the missed member", () => {
    const full = canonicalMaturityCitationOf({
      lifecycleRecords: ragHistory.lifecycleRecords,
      generations: ragHistory.generations,
      accountingEntries: ragHistory.accountingEntries,
    });
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
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "citation-full-population")
        ?.status,
    ).toBe("FAIL");
  });

  test("a partial population (a dropped accounting digest) FAILs naming the missed digest", () => {
    const full = canonicalMaturityCitationOf({
      lifecycleRecords: ragHistory.lifecycleRecords,
      generations: ragHistory.generations,
      accountingEntries: ragHistory.accountingEntries,
    });
    const dropped = full.accountingEntryDigests[0] ?? "";
    const verdict = deriveMaturityEvidenceCitation({
      lifecycleRecords: ragHistory.lifecycleRecords,
      generations: ragHistory.generations,
      accountingEntries: ragHistory.accountingEntries,
      citation: { ...full, accountingEntryDigests: full.accountingEntryDigests.slice(1) },
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.uncitedAccountingDigests).toEqual([dropped]);
  });

  test("a PHANTOM citation (a cited member not in the population) FAILs naming it", () => {
    const full = canonicalMaturityCitationOf({
      lifecycleRecords: ragHistory.lifecycleRecords,
      generations: ragHistory.generations,
      accountingEntries: ragHistory.accountingEntries,
    });
    const verdict = deriveMaturityEvidenceCitation({
      lifecycleRecords: ragHistory.lifecycleRecords,
      generations: ragHistory.generations,
      accountingEntries: ragHistory.accountingEntries,
      citation: {
        ...full,
        generationDigests: [...full.generationDigests, "fabricated-generation-digest"],
      },
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.phantomGenerationDigests).toEqual(["fabricated-generation-digest"]);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "citation-no-phantom-members")
        ?.status,
    ).toBe("FAIL");
  });

  test("an EMPTY population (no recorded generations) FAILs the minimum evidence", () => {
    const verdict = deriveMaturityEvidenceCitation({
      lifecycleRecords: ragHistory.lifecycleRecords,
      generations: [],
      accountingEntries: [],
      citation: { lifecycleProposalIds: [], generationDigests: [], accountingEntryDigests: [] },
    });
    expect(verdict.minimumEvidence).toBe(false);
    expect(verdict.complete).toBe(false);
  });
});

describe("VAL-036 curve-series integrity matrix", () => {
  test("the canonical gapless recorded series PASSES over the trending family", () => {
    const points = canonicalCurveSeriesOf("text-summarization", trendingHistory.generations);
    const verdict = deriveCurveSeriesIntegrity({
      recordedGenerations: trendingHistory.generations,
      points,
    });
    expect(verdict.integral).toBe(true);
    expect(verdict.seriesGenerations).toEqual([1, 2, 3, 4]);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("a GAPPED series (generation 3 missing) FAILs naming the missing generation", () => {
    const points = canonicalCurveSeriesOf("text-summarization", trendingHistory.generations).filter(
      (point) => point.generation !== 3,
    );
    const verdict = deriveCurveSeriesIntegrity({
      recordedGenerations: trendingHistory.generations,
      points,
    });
    expect(verdict.integral).toBe(false);
    expect(verdict.missingGenerations).toEqual([3]);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "curve-series-gapless")
        ?.status,
    ).toBe("FAIL");
  });

  test("a generation with ABSENT measurements FAILs named", () => {
    const points = canonicalCurveSeriesOf("text-summarization", trendingHistory.generations).map(
      (point) => (point.generation === 2 ? { ...point, measured: false } : point),
    );
    const verdict = deriveCurveSeriesIntegrity({
      recordedGenerations: trendingHistory.generations,
      points,
    });
    expect(verdict.integral).toBe(false);
    expect(verdict.unmeasuredGenerations).toEqual([2]);
  });

  test("an EXTRAPOLATED point FAILs and is named", () => {
    const points = canonicalCurveSeriesOf("text-summarization", trendingHistory.generations).map(
      (point) =>
        point.generation === 4 ? { ...point, pointSource: "extrapolated" as const } : point,
    );
    const verdict = deriveCurveSeriesIntegrity({
      recordedGenerations: trendingHistory.generations,
      points,
    });
    expect(verdict.integral).toBe(false);
    expect(verdict.extrapolatedGenerations).toEqual([4]);
    expect(
      verdict.criteria.find(
        (criterion) => criterion.criterionId === "curve-recorded-measurements-only",
      )?.status,
    ).toBe("FAIL");
  });

  test("a FABRICATED point FAILs and is named", () => {
    const points: readonly CurvePointShape[] = canonicalCurveSeriesOf(
      "text-summarization",
      trendingHistory.generations,
    ).map((point) =>
      point.generation === 4 ? { ...point, pointSource: "fabricated" as const } : point,
    );
    const verdict = deriveCurveSeriesIntegrity({
      recordedGenerations: trendingHistory.generations,
      points,
    });
    expect(verdict.integral).toBe(false);
    expect(verdict.fabricatedGenerations).toEqual([4]);
  });

  test("a point citing an UNRECORDED generation digest FAILs named", () => {
    const points = canonicalCurveSeriesOf("text-summarization", trendingHistory.generations).map(
      (point) =>
        point.generation === 1 ? { ...point, generationDigest: "not-a-recorded-digest" } : point,
    );
    const verdict = deriveCurveSeriesIntegrity({
      recordedGenerations: trendingHistory.generations,
      points,
    });
    expect(verdict.integral).toBe(false);
    expect(verdict.unrecordedDigestGenerations).toEqual([1]);
  });

  test("an EMPTY series FAILs the minimum series", () => {
    const verdict = deriveCurveSeriesIntegrity({ recordedGenerations: [], points: [] });
    expect(verdict.integral).toBe(false);
    expect(verdict.minimumSeries).toBe(false);
  });
});

describe("VAL-036 classification-fidelity matrix", () => {
  test("the observed thresholds pin each honest class over its own shape", () => {
    expect(observedMaturityClassificationOf(ragHistory.generations)).toBe("determinized-stable");
    expect(observedMaturityClassificationOf(trendingHistory.generations)).toBe(
      "determinizing-trending",
    );
    expect(observedMaturityClassificationOf(variableHistory.generations)).toBe(
      "variable-resilient",
    );
    expect(observedMaturityClassificationOf(immatureHistory.generations)).toBe(
      "immature-insufficient-evidence",
    );
  });

  test("each honest claim over its own shape PASSES fidelity", () => {
    for (const history of [ragHistory, trendingHistory, variableHistory, immatureHistory]) {
      const verdict = deriveMaturityClassification({
        generations: history.generations,
        claimed: observedMaturityClassificationOf(history.generations),
      });
      expect(verdict.fidelity).toBe(true);
      expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
    }
  });

  test("a variable-resilient family claimed determinized-stable FAILs with both sides named", () => {
    const verdict = deriveMaturityClassification({
      generations: variableHistory.generations,
      claimed: "determinized-stable",
    });
    expect(verdict.fidelity).toBe(false);
    expect(verdict.claimed).toBe("determinized-stable");
    expect(verdict.observed).toBe("variable-resilient");
    const failed = verdict.criteria.find(
      (criterion) => criterion.criterionId === "classification-fidelity",
    );
    expect(failed?.status).toBe("FAIL");
    expect(failed?.evidence.join(" ")).toContain("claimed:determinized-stable");
    expect(failed?.evidence.join(" ")).toContain("observed:variable-resilient");
  });

  test("a determinized-stable family claimed variable-resilient FAILs with both sides named", () => {
    const verdict = deriveMaturityClassification({
      generations: ragHistory.generations,
      claimed: "variable-resilient",
    });
    expect(verdict.fidelity).toBe(false);
    expect(verdict.claimed).toBe("variable-resilient");
    expect(verdict.observed).toBe("determinized-stable");
  });

  test("a trending family claimed stable FAILs and vice versa", () => {
    expect(
      deriveMaturityClassification({
        generations: trendingHistory.generations,
        claimed: "determinized-stable",
      }).fidelity,
    ).toBe(false);
    expect(
      deriveMaturityClassification({
        generations: ragHistory.generations,
        claimed: "determinizing-trending",
      }).fidelity,
    ).toBe(false);
  });

  test("a TREND claim from insufficient evidence FAILs as evidence-stretching (never stretched)", () => {
    const verdict = deriveMaturityClassification({
      generations: immatureHistory.generations,
      claimed: "determinizing-trending",
    });
    expect(verdict.fidelity).toBe(false);
    expect(verdict.stretchedTrend).toBe(true);
    expect(verdict.observed).toBe("immature-insufficient-evidence");
    expect(
      verdict.criteria.find(
        (criterion) => criterion.criterionId === "classification-no-evidence-stretching",
      )?.status,
    ).toBe("FAIL");
  });

  test("a STABILITY claim from insufficient evidence FAILs as evidence-stretching too", () => {
    expect(
      deriveMaturityClassification({
        generations: immatureHistory.generations,
        claimed: "determinized-stable",
      }).stretchedTrend,
    ).toBe(true);
    expect(isEvidenceStretchingClaim("determinized-stable", 2)).toBe(true);
    expect(isEvidenceStretchingClaim("immature-insufficient-evidence", 2)).toBe(false);
  });

  test("the stable threshold demands full displacement AND zero variance across the window", () => {
    const notFullDisplacement = [
      generationOf({ generation: 1, baseline: 10, displaced: 6 }),
      generationOf({ generation: 2, baseline: 10, displaced: 6 }),
      generationOf({ generation: 3, baseline: 10, displaced: 6 }),
    ];
    expect(observedMaturityClassificationOf(notFullDisplacement)).not.toBe("determinized-stable");
    const varianceInsideWindow = [
      generationOf({ generation: 1, baseline: 10, displaced: 4 }),
      generationOf({ generation: 2, baseline: 10, displaced: 6 }),
      generationOf({ generation: 3, baseline: 8, displaced: 8 }),
      generationOf({ generation: 4, baseline: 8, displaced: 7 }),
    ];
    expect(observedMaturityClassificationOf(varianceInsideWindow)).not.toBe("determinized-stable");
    const fullAndFlat = [
      generationOf({ generation: 1, baseline: 10, displaced: 4 }),
      generationOf({ generation: 2, baseline: 8, displaced: 8 }),
      generationOf({ generation: 3, baseline: 8, displaced: 8 }),
    ];
    expect(observedMaturityClassificationOf(fullAndFlat)).toBe("determinized-stable");
  });

  test("the trending threshold demands monotone growth over at least the minimum generations", () => {
    const nonMonotone = [
      generationOf({ generation: 1, baseline: 10, displaced: 4 }),
      generationOf({ generation: 2, baseline: 10, displaced: 2 }),
      generationOf({ generation: 3, baseline: 10, displaced: 6 }),
    ];
    expect(observedMaturityClassificationOf(nonMonotone)).toBe("variable-resilient");
    const flatNoGrowth = [
      generationOf({ generation: 1, baseline: 10, displaced: 5 }),
      generationOf({ generation: 2, baseline: 10, displaced: 5 }),
      generationOf({ generation: 3, baseline: 10, displaced: 5 }),
    ];
    expect(observedMaturityClassificationOf(flatNoGrowth)).toBe("variable-resilient");
  });
});

describe("VAL-036 savings-reconciliation matrix", () => {
  test("the canonical per-mechanism savings RECONCILE with the RAG family's ledgers", () => {
    const verdict = deriveSavingsReconciliation({
      accountingLedger: ragHistory.accountingEntries,
      claimedSavings: ragSavings,
    });
    expect(verdict.reconciled).toBe(true);
    expect(verdict.perMechanismPresent).toBe(true);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("an AGGREGATE-ONLY number (no per-mechanism breakdown) FAILs", () => {
    const verdict = deriveSavingsReconciliation({
      accountingLedger: ragHistory.accountingEntries,
      claimedSavings: { totalMicroUsd: ragSavings.totalMicroUsd, perMechanism: null },
    });
    expect(verdict.reconciled).toBe(false);
    expect(verdict.perMechanismPresent).toBe(false);
    expect(
      verdict.criteria.find(
        (criterion) => criterion.criterionId === "savings-per-mechanism-breakdown-present",
      )?.status,
    ).toBe("FAIL");
  });

  test("a MISMATCHED per-mechanism number FAILs with both sides named", () => {
    const mismatched: SavingsAttribution = {
      totalMicroUsd: ragSavings.totalMicroUsd,
      perMechanism:
        ragSavings.perMechanism === null
          ? null
          : { ...ragSavings.perMechanism, reuse: ragSavings.perMechanism.reuse + 7 },
    };
    const verdict = deriveSavingsReconciliation({
      accountingLedger: ragHistory.accountingEntries,
      claimedSavings: mismatched,
    });
    expect(verdict.reconciled).toBe(false);
    expect(verdict.mismatchedMechanisms).toHaveLength(1);
    expect(verdict.mismatchedMechanisms[0]?.mechanism).toBe("reuse");
    expect(verdict.mismatchedMechanisms[0]?.claimedMicroUsd).toBe(
      (ragSavings.perMechanism?.reuse ?? 0) + 7,
    );
    expect(verdict.mismatchedMechanisms[0]?.recordedMicroUsd).toBe(
      ragSavings.perMechanism?.reuse ?? 0,
    );
  });

  test("a total that does not match the ledger FAILs with both sides named", () => {
    const inflated: SavingsAttribution = {
      totalMicroUsd: ragSavings.totalMicroUsd + 3,
      perMechanism: ragSavings.perMechanism,
    };
    const verdict = deriveSavingsReconciliation({
      accountingLedger: ragHistory.accountingEntries,
      claimedSavings: inflated,
    });
    expect(verdict.reconciled).toBe(false);
    expect(verdict.totalMatchesLedger).toBe(false);
    expect(verdict.recordedTotalMicroUsd).toBe(ragSavings.totalMicroUsd);
    const failed = verdict.criteria.find(
      (criterion) => criterion.criterionId === "savings-total-matches-ledger",
    );
    expect(failed?.status).toBe("FAIL");
    expect(failed?.evidence.join(" ")).toContain(`claimedTotal:${ragSavings.totalMicroUsd + 3}`);
    expect(failed?.evidence.join(" ")).toContain(`recordedTotal:${ragSavings.totalMicroUsd}`);
  });

  test("a breakdown that does not SUM to its claimed total FAILs", () => {
    const nonSumming: SavingsAttribution = {
      totalMicroUsd: ragSavings.totalMicroUsd,
      perMechanism:
        ragSavings.perMechanism === null
          ? null
          : { ...ragSavings.perMechanism, cache: ragSavings.perMechanism.cache + 1 },
    };
    const verdict = deriveSavingsReconciliation({
      accountingLedger: ragHistory.accountingEntries,
      claimedSavings: nonSumming,
    });
    expect(verdict.breakdownSumsToTotal).toBe(false);
    expect(verdict.reconciled).toBe(false);
  });

  test("the per-mechanism attribution separates all four CANDIDATE_KINDS mechanisms", () => {
    const ledger: readonly AccountingLedgerEntry[] = [
      { familyId: "f", generation: 1, mechanism: "reuse", microUsd: 10, latencyDeltaMs: 1 },
      { familyId: "f", generation: 1, mechanism: "cache", microUsd: 20, latencyDeltaMs: 2 },
      { familyId: "f", generation: 2, mechanism: "competence", microUsd: 30, latencyDeltaMs: 3 },
      {
        familyId: "f",
        generation: 2,
        mechanism: "deterministicization",
        microUsd: 40,
        latencyDeltaMs: 4,
      },
    ];
    const attribution = canonicalSavingsAttributionOf(ledger);
    expect(attribution.perMechanism).toEqual({
      reuse: 10,
      cache: 20,
      competence: 30,
      deterministicization: 40,
    });
    expect(attribution.totalMicroUsd).toBe(100);
    expect(
      deriveSavingsReconciliation({ accountingLedger: ledger, claimedSavings: attribution })
        .reconciled,
    ).toBe(true);
  });
});

describe("VAL-036 honesty matrix", () => {
  test("a fully measured offline analysis with none-reported usage is HONEST", () => {
    const verdict = deriveMaturityHonesty({
      generations: ragHistory.generations,
      reportedUsage: null,
      liveRail: false,
    });
    expect(verdict.honest).toBe(true);
    expect(verdict.noneReportedUsageHonest).toBe(true);
  });

  test("an ESTIMATED measurement FAILs named", () => {
    const withEstimated = ragHistory.generations.map((generation) =>
      generation.generation === 2 ? { ...generation, measured: false } : generation,
    );
    const verdict = deriveMaturityHonesty({
      generations: withEstimated,
      reportedUsage: null,
      liveRail: false,
    });
    expect(verdict.honest).toBe(false);
    expect(verdict.estimatedGenerations).toEqual([2]);
    expect(
      verdict.criteria.find(
        (criterion) => criterion.criterionId === "honesty-measured-never-estimated",
      )?.status,
    ).toBe("FAIL");
  });

  test("a FABRICATED offline usage FAILs (usage is none-reported offline, measured only live)", () => {
    const fabricatedUsage: LabUsage = { inputTokens: 10, outputTokens: 2 };
    const verdict = deriveMaturityHonesty({
      generations: ragHistory.generations,
      reportedUsage: fabricatedUsage,
      liveRail: false,
    });
    expect(verdict.honest).toBe(false);
    expect(verdict.fabricatedUsage).toBe(true);
  });

  test("a MEASURED live usage is honest on the live rail", () => {
    const verdict = deriveMaturityHonesty({
      generations: ragHistory.generations,
      reportedUsage: { inputTokens: 30, outputTokens: 6 },
      liveRail: true,
    });
    expect(verdict.honest).toBe(true);
    expect(verdict.noneReportedUsageHonest).toBe(true);
  });
});

describe("VAL-036 refusal honesty + verdict derivation", () => {
  test("both honest refusal reasons match their own recorded states", () => {
    expect(
      deriveMaturityRefusalHonesty({
        refusal: { reason: "family-unrecorded" },
        lifecycleRecordCount: 0,
        generationCount: 0,
      }).honest,
    ).toBe(true);
    expect(
      deriveMaturityRefusalHonesty({
        refusal: { reason: "no-generations-recorded" },
        lifecycleRecordCount: 1,
        generationCount: 0,
      }).honest,
    ).toBe(true);
  });

  test("a refusal the recorded state does not justify FAILs (dishonest)", () => {
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
        lifecycleRecordCount: 0,
        generationCount: 0,
      }).honest,
    ).toBe(false);
  });

  test("the verdict derivation: trustworthy legs establish; a FAILing leg invalidates", () => {
    const citation = deriveMaturityEvidenceCitation({
      lifecycleRecords: ragHistory.lifecycleRecords,
      generations: ragHistory.generations,
      accountingEntries: ragHistory.accountingEntries,
      citation: canonicalMaturityCitationOf({
        lifecycleRecords: ragHistory.lifecycleRecords,
        generations: ragHistory.generations,
        accountingEntries: ragHistory.accountingEntries,
      }),
    });
    const curve = deriveCurveSeriesIntegrity({
      recordedGenerations: ragHistory.generations,
      points: canonicalCurveSeriesOf("rag-retrieval", ragHistory.generations),
    });
    const classification = deriveMaturityClassification({
      generations: ragHistory.generations,
      claimed: "determinized-stable",
    });
    const savings = deriveSavingsReconciliation({
      accountingLedger: ragHistory.accountingEntries,
      claimedSavings: ragSavings,
    });
    const honesty = deriveMaturityHonesty({
      generations: ragHistory.generations,
      reportedUsage: null,
      liveRail: false,
    });
    expect(
      deriveMaturityVerdictKind({
        refusal: null,
        refusalHonesty: null,
        citation,
        curveIntegrity: curve,
        classification,
        savingsReconciliation: savings,
        honesty,
        inputUnchanged: true,
        failure: null,
      }),
    ).toBe("maturity-established");
    expect(
      deriveMaturityVerdictKind({
        refusal: null,
        refusalHonesty: null,
        citation,
        curveIntegrity: curve,
        classification: { ...classification, fidelity: false },
        savingsReconciliation: savings,
        honesty,
        inputUnchanged: true,
        failure: null,
      }),
    ).toBe("maturity-invalid");
  });
});

describe("VAL-036 digest + identity determinism", () => {
  test("every digest is deterministic, canonical and payload-free (FNV-1a only)", () => {
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
    const point = canonicalCurveSeriesOf("rag-retrieval", ragHistory.generations)[0];
    if (point === undefined) {
      throw new Error("the RAG family history holds no curve points");
    }
    expect(curvePointDigestOf(point)).toBe(curvePointDigestOf(point));
    expect(maturityCitationDigestOf(rowById("rag-retrieval-determinized-stable").citation)).toBe(
      maturityCitationDigestOf(rowById("rag-retrieval-determinized-stable").citation),
    );
    expect(savingsAttributionDigestOf(ragSavings)).toBe(savingsAttributionDigestOf(ragSavings));
  });

  test("the digests DISCRIMINATE (different facts, different digests)", () => {
    const generation = ragHistory.generations[0];
    if (generation === undefined) {
      throw new Error("the RAG family history holds no generations");
    }
    expect(generationRecordDigestOf(generation)).not.toBe(
      generationRecordDigestOf({
        ...generation,
        displacedModelCalls: generation.displacedModelCalls + 1,
      }),
    );
    const ledgerEntry = ragHistory.accountingEntries[0];
    if (ledgerEntry === undefined) {
      throw new Error("the RAG family history holds no accounting entries");
    }
    expect(accountingEntryDigestOf(ledgerEntry)).not.toBe(
      accountingEntryDigestOf({ ...ledgerEntry, microUsd: 999 }),
    );
  });

  test("the input digest is stable for the honest port and order-independent in its facts", () => {
    const honest = createMaturityHistoryPort();
    const first = maturityInputDigestOf(honest.facts());
    const second = maturityInputDigestOf(honest.facts());
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{8}$/);
  });

  test("the report digest is deterministic and discriminates classifications", () => {
    const report = {
      familyId: "rag-retrieval",
      classification: "determinized-stable" as const,
      curvePointDigests: ["a1b2c3d4"],
      savings: ragSavings,
      citationDigest: "deadbeef",
    };
    expect(maturityReportDigestOf(report)).toBe(maturityReportDigestOf(report));
    expect(maturityReportDigestOf(report)).not.toBe(
      maturityReportDigestOf({ ...report, classification: "variable-resilient" as const }),
    );
  });
});

describe("VAL-036 the report ledger is append-only", () => {
  test("an identical re-append REPLAYS (idempotent)", async () => {
    const ledger = createMaturityReportLedger();
    const report = {
      familyId: "rag-retrieval",
      classification: "determinized-stable" as const,
      curvePointDigests: ["a1b2c3d4"],
      savings: ragSavings,
      citationDigest: "deadbeef",
    };
    const first = await ledger.append(report);
    const second = await ledger.append(report);
    expect(first).toEqual({ accepted: true, replayed: false, refused: false });
    expect(second).toEqual({ accepted: true, replayed: true, refused: false });
    expect(ledger.reportsFor("rag-retrieval")).toHaveLength(1);
  });

  test("a DIFFERENT report under the same family is REFUSED", async () => {
    const ledger = createMaturityReportLedger();
    const report = {
      familyId: "rag-retrieval",
      classification: "determinized-stable" as const,
      curvePointDigests: ["a1b2c3d4"],
      savings: ragSavings,
      citationDigest: "deadbeef",
    };
    await ledger.append(report);
    const impostor = await ledger.append({
      ...report,
      classification: "variable-resilient" as const,
    });
    expect(impostor).toEqual({ accepted: false, replayed: false, refused: true });
    expect(ledger.reportsFor("rag-retrieval")).toHaveLength(1);
    expect(ledger.reportsFor("rag-retrieval")[0]?.classification).toBe("determinized-stable");
  });
});

describe("VAL-036 the driver over every offline corpus row", () => {
  const rowIds = OFFLINE_CORPUS_ROWS.map((row) => row.rowId);

  test("every offline row COMPLETES over the honest stack (the honest oracle)", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const stack = createHonestMaturityStack();
      const result = await driveMaturityAnalysis({
        row,
        analysis: stack.history,
        reportLedger: stack.reportLedger,
        now: stack.clock.now,
      });
      expect(result.terminal, `${row.rowId} terminal`).toBe("COMPLETED");
      expect(result.verdict, `${row.rowId} verdict`).toBe(row.expected.verdict);
      expect(result.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
      expect(result.usage).toBeNull();
      expect(result.observedModelCalls).toBe(0);
      expect(result.inputUnchanged).toBe(true);
      expect(result.failure).toBeNull();
    }
  });

  test("the honest-refusal rows append NOTHING to the report ledger", async () => {
    for (const rowId of [
      "unrecorded-family-maturity-refusal",
      "no-generations-family-maturity-refusal",
    ]) {
      const row = rowById(rowId);
      const stack = createHonestMaturityStack();
      const result = await driveMaturityAnalysis({
        row,
        analysis: stack.history,
        reportLedger: stack.reportLedger,
        now: stack.clock.now,
      });
      expect(result.refusal).not.toBeNull();
      expect(result.reportsAppended).toBe(0);
      expect(stack.reportLedger.appendLog()).toHaveLength(0);
    }
  });

  test("the established rows land their reports; the identical re-drive REPLAYS", async () => {
    const row = rowById("rag-retrieval-determinized-stable");
    const stack = createHonestMaturityStack();
    const first = await driveMaturityAnalysis({
      row,
      analysis: stack.history,
      reportLedger: stack.reportLedger,
      now: stack.clock.now,
    });
    const second = await driveMaturityAnalysis({
      row,
      analysis: stack.history,
      reportLedger: stack.reportLedger,
      now: stack.clock.now,
    });
    expect(first.reportLanded?.accepted).toBe(true);
    expect(first.reportLanded?.replayed).toBe(false);
    expect(second.reportLanded?.accepted).toBe(true);
    expect(second.reportLanded?.replayed).toBe(true);
    expect(stack.reportLedger.reportsFor("rag-retrieval")).toHaveLength(1);
  });

  test("the latency is always measured (never estimated) and the row ids are the pinned membership", () => {
    expect(rowIds).toHaveLength(11);
    expect(rowIds).toContain("rag-retrieval-determinized-stable");
    expect(rowIds).toContain("support-triage-immature-insufficient-evidence");
  });

  test("a dispatch-demanding row without a dispatch seam is a configuration error", async () => {
    const liveRow = rowById("rag-retrieval-determinized-stable");
    const demanding = { ...liveRow, needsDispatch: true } as MaturityCorpusRow;
    const stack = createHonestMaturityStack();
    await expect(
      driveMaturityAnalysis({
        row: demanding,
        analysis: stack.history,
        reportLedger: stack.reportLedger,
        now: stack.clock.now,
      }),
    ).rejects.toThrow("demands a dispatch seam");
  });
});

describe("VAL-036 adversarial worlds (the fake history variants)", () => {
  const driveOver = async (
    rowId: string,
    variant: FakeHistoryVariant,
  ): Promise<{ readonly terminal: string; readonly verdict: string }> => {
    const row = rowById(rowId);
    const history = createMaturityHistoryPort(variant);
    const reportLedger = createMaturityReportLedger();
    const result = await driveMaturityAnalysis({
      row,
      analysis: history,
      reportLedger,
      now: createHonestMaturityStack().clock.now,
    });
    return { terminal: result.terminal, verdict: result.verdict };
  };

  test("the GAPPED history FAILs the trending row (a phantom citation over the dropped generation)", async () => {
    const outcome = await driveOver("text-summarization-determinizing-trending", "gapped");
    expect(outcome.terminal).toBe("FAILED");
    expect(outcome.verdict).toBe("maturity-invalid");
  });

  test("the UNMEASURED history FAILs the stable row (the citation no longer matches the recorded generations)", async () => {
    const outcome = await driveOver("rag-retrieval-determinized-stable", "unmeasured");
    expect(outcome.terminal).toBe("FAILED");
    expect(outcome.verdict).toBe("maturity-invalid");
  });

  test("the UNRECONCILED history FAILs the savings leg (the claims no longer match the ledgers)", async () => {
    const outcome = await driveOver("rag-retrieval-determinized-stable", "unreconciled");
    expect(outcome.terminal).toBe("FAILED");
    expect(outcome.verdict).toBe("maturity-invalid");
  });

  test("the MUTATING history FAILs the read-only discipline (a fabricated record the citation missed)", async () => {
    const outcome = await driveOver("rag-retrieval-determinized-stable", "mutating");
    expect(outcome.terminal).toBe("FAILED");
    expect(outcome.verdict).toBe("maturity-invalid");
  });

  test("every adversarial world keeps the family facts digest stable for the honest variant families", async () => {
    const honest = createMaturityHistoryPort();
    const gapped = createMaturityHistoryPort("gapped");
    expect(maturityInputDigestOf(honest.facts())).toBe(maturityInputDigestOf(gapped.facts()));
  });
});

describe("VAL-036 the row criteria contract", () => {
  test("the honest row criteria PASS; a mutated verdict FAILs the expected-verdict leg", () => {
    const row = rowById("order-settlement-variable-resilient");
    const criteria = deriveMaturityRowCriteria({
      row,
      refusal: null,
      refusalHonesty: null,
      citation: deriveMaturityEvidenceCitation({
        lifecycleRecords: variableHistory.lifecycleRecords,
        generations: variableHistory.generations,
        accountingEntries: variableHistory.accountingEntries,
        citation: canonicalMaturityCitationOf({
          lifecycleRecords: variableHistory.lifecycleRecords,
          generations: variableHistory.generations,
          accountingEntries: variableHistory.accountingEntries,
        }),
      }),
      curveIntegrity: deriveCurveSeriesIntegrity({
        recordedGenerations: variableHistory.generations,
        points: canonicalCurveSeriesOf("order-settlement", variableHistory.generations),
      }),
      classification: deriveMaturityClassification({
        generations: variableHistory.generations,
        claimed: "variable-resilient",
      }),
      savingsReconciliation: deriveSavingsReconciliation({
        accountingLedger: variableHistory.accountingEntries,
        claimedSavings: canonicalSavingsAttributionOf(variableHistory.accountingEntries),
      }),
      honesty: deriveMaturityHonesty({
        generations: variableHistory.generations,
        reportedUsage: null,
        liveRail: false,
      }),
      reportLanded: { accepted: true, replayed: false },
      reportsAppended: 1,
      inputUnchanged: true,
      observedModelCalls: 0,
      verdict: "maturity-established",
      failure: null,
    });
    expect(criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
    const mutated = deriveMaturityRowCriteria({
      row,
      refusal: null,
      refusalHonesty: null,
      citation: null,
      curveIntegrity: null,
      classification: null,
      savingsReconciliation: null,
      honesty: null,
      reportLanded: null,
      reportsAppended: 0,
      inputUnchanged: true,
      observedModelCalls: 0,
      verdict: "maturity-invalid",
      failure: null,
    });
    expect(
      mutated.find((criterion) => criterion.criterionId === "maturity-expected-verdict")?.status,
    ).toBe("FAIL");
    expect(
      mutated.find((criterion) => criterion.criterionId === "maturity-report-landing")?.status,
    ).toBe("FAIL");
  });

  test("the criteria name the input-read-only catch when the history mutates", () => {
    const row = rowById("rag-retrieval-determinized-stable");
    const criteria = deriveMaturityRowCriteria({
      row,
      refusal: null,
      refusalHonesty: null,
      citation: null,
      curveIntegrity: null,
      classification: null,
      savingsReconciliation: null,
      honesty: null,
      reportLanded: { accepted: true, replayed: false },
      reportsAppended: 1,
      inputUnchanged: false,
      observedModelCalls: 0,
      verdict: "maturity-established",
      failure: null,
    });
    const readOnly = criteria.find(
      (criterion) => criterion.criterionId === "maturity-input-read-only",
    );
    expect(readOnly?.status).toBe("FAIL");
    expect(readOnly?.evidence.join(" ")).toContain("MUTATED-INPUT");
  });
});

describe("VAL-036 corpus consistency", () => {
  test("every row's citation cites its family's FULL recorded population", () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const history = familyHistoryById(row.familyId);
      if (history === null) {
        expect(row.citation.lifecycleProposalIds).toHaveLength(0);
        continue;
      }
      const verdict = deriveMaturityEvidenceCitation({
        lifecycleRecords: history.lifecycleRecords,
        generations: history.generations,
        accountingEntries: history.accountingEntries,
        citation: row.citation,
      });
      if (history.generations.length === 0) {
        // The honest no-generations family: the citation is complete in
        // its membership but the population holds no generations (the
        // honest refusal basis — never fabricated into evidence).
        expect(verdict.phantomLifecycleProposalIds).toHaveLength(0);
        expect(verdict.uncitedLifecycleProposalIds).toHaveLength(0);
        expect(verdict.minimumEvidence).toBe(false);
        continue;
      }
      expect(verdict.complete, `${row.rowId} citation`).toBe(true);
    }
  });

  test("the pinned histories hold the promised generation counts", () => {
    expect(FAMILY_HISTORIES).toHaveLength(5);
    expect(ragHistory.generations).toHaveLength(4);
    expect(trendingHistory.generations).toHaveLength(4);
    expect(variableHistory.generations).toHaveLength(4);
    expect(immatureHistory.generations).toHaveLength(2);
    expect(familyHistoryById("tool-routing")?.generations).toHaveLength(0);
  });

  test("the digest basis is payload-free (FNV-1a over canonical structures)", () => {
    expect(longitudinalDigestOf(["a", 1])).toBe(longitudinalDigestOf(["a", 1]));
    expect(longitudinalDigestOf(["a", 1])).not.toBe(longitudinalDigestOf(["a", 2]));
    expect(longitudinalDigestOf("string")).toMatch(/^[0-9a-f]{8}$/);
  });
});
