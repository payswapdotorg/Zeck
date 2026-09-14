/**
 * VAL-045 acceptance criteria 4 + 6 — the discrimination suite: the
 * savings-attribution analysis proven against controlled fakes by
 * driving the PURE derivations adversarially per the spec's five named
 * probe families:
 *
 *   * the UNCITED CLAIM — an attribution claim whose evidence citation
 *     misses recorded members (an uncited claim, a partial population)
 *     or cites phantom members each FAILs the citation completeness
 *     with the member named — while the full-population citation
 *     PASSES;
 *   * the DOUBLE-COUNT — the same ledger entry attributed to two
 *     mechanisms simultaneously FAILs with BOTH claims named (and a
 *     claim citing its own entry twice likewise FAILs) — while the
 *     single-attribution split PASSES;
 *   * the FORCED RESIDUAL — the unattributed residual claimed as a
 *     mechanism without that mechanism's recorded evidence FAILs with
 *     the mechanism and the excess named (both sides); an
 *     under-attribution, a hidden residual and an inflated residual
 *     each FAIL likewise — while the honest reported residual PASSES;
 *   * the SWAPPED BASELINE — a claim measured against an unstated,
 *     swapped or hypothetical baseline (never the RECORDED incumbent
 *     per VAL-044's adjusted model) each FAILs named (the swapped
 *     shape with both sides named) — while the recorded-baseline split
 *     PASSES;
 *   * the GAPPED SERIES — the attribution's generation series gapped
 *     or mismatched against VAL-036's recorded maturity curves FAILs
 *     named — while the matching series PASSES.
 *
 * Plus the reconciliation identity (attributed + residual = recorded
 * total per family and per generation; a non-reconciling attribution
 * FAILs with both sides named), the honesty matrix (measured never
 * estimated; honest none-reported boundaries), the refusal honesty,
 * the digest/identity determinism, the app-contract family
 * (`verifySavingsAttributionAppContract`) catching every fake-world
 * knob at the boundary, the report ledger's append-only exactly-once
 * discipline, and the honest control over the fixture stack (every
 * offline row per its pin; every probe row's adversarial variant
 * FAILing its named criterion).
 */

import { describe, expect, test } from "vitest";
import { runSavingsAttributionApp } from "../../benchmarks/validation/apps/savings-attribution/application";
import {
  attributionRowById,
  declaredSplitTotalsOf,
  familyEconomicsById,
  OFFLINE_CORPUS_ROWS,
  SAVINGS_ATTRIBUTION_CORPUS,
} from "../../benchmarks/validation/apps/savings-attribution/corpus";
import {
  createAttributionFakeApiWorld,
  createAttributionHistoryPort,
  createAttributionReportLedger,
  createHonestAttributionStack,
  createTickClock,
} from "../../benchmarks/validation/apps/savings-attribution/fixtures";
import type { TransportImplementation } from "../../benchmarks/validation/harness/harness";
import type {
  LabUsage,
  LabVerificationCriterion,
} from "../../benchmarks/validation/platform/derive";
import { maturityReportDigestOf } from "../../benchmarks/validation/platform/determinization-maturity";
import type {
  AppAttributionObservation,
  AttributionAnalysisFacts,
  AttributionClaim,
  AttributionCorpusRow,
  AttributionRunResult,
  FamilyAttributionSplit,
} from "../../benchmarks/validation/platform/savings-attribution";
import {
  attributionCitationDigestOf,
  attributionClaimDigestOf,
  attributionEntryDigestOf,
  attributionInputDigestOf,
  canonicalAttributionCitationOf,
  canonicalAttributionSplitOf,
  deriveAttributionEvidenceCitation,
  deriveAttributionHonesty,
  deriveAttributionReconciliation,
  deriveAttributionRefusalHonesty,
  deriveAttributionVerdictKind,
  deriveCounterfactualFidelity,
  deriveGenerationSeriesIntegrity,
  deriveNoDoubleCount,
  deriveResidualHonesty,
  driveAttributionAnalysis,
  incumbentBaselineDigestOf,
  recordedCounterfactualOf,
  recordedSavingsTotalDigestOf,
  residualClaimDigestOf,
  savingsAttributionReportDigestOf,
  verifySavingsAttributionAppContract,
} from "../../benchmarks/validation/platform/savings-attribution";

const REVISION = "7d42e5700000000000000000000000000000000aa";

const ragEconomics = familyEconomicsById("rag-retrieval");
const textEconomics = familyEconomicsById("text-summarization");
const invoiceEconomics = familyEconomicsById("invoice-extraction");
const translationEconomics = familyEconomicsById("translation-glossary");
if (
  ragEconomics === null ||
  textEconomics === null ||
  invoiceEconomics === null ||
  translationEconomics === null
) {
  throw new Error("the pinned family economics are incomplete");
}

/** The canonical honest split over one family's recorded economics. */
const canonicalSplitOf = (familyId: string): FamilyAttributionSplit => {
  const economics = familyEconomicsById(familyId);
  if (economics === null) {
    throw new Error(`no pinned economics for ${familyId}`);
  }
  return canonicalAttributionSplitOf({
    familyId,
    ledgerEntries: economics.ledgerEntries,
    lifecycleRecords: economics.lifecycleRecords,
    baselines: economics.baselines,
    recordedTotals: economics.recordedTotals,
  });
};

const rowById = (rowId: string): AttributionCorpusRow => {
  const row = attributionRowById(rowId);
  if (row === null) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

const taskIndexOf = (rowId: string): number => {
  const index = SAVINGS_ATTRIBUTION_CORPUS.findIndex((row) => row.rowId === rowId);
  if (index < 0) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return index;
};

const criterionOf = (criteria: readonly LabVerificationCriterion[], id: string) =>
  criteria.find((criterion) => criterion.criterionId === id);

// ---------------------------------------------------------------------------
// Family 1: the uncited claim (the citation-completeness catch)
// ---------------------------------------------------------------------------

describe("VAL-045 discrimination: the uncited claim", () => {
  test("the FULL-population citation PASSES over every recorded family (the control)", () => {
    for (const familyId of [
      "rag-retrieval",
      "text-summarization",
      "code-search",
      "invoice-extraction",
      "translation-glossary",
    ]) {
      const verdict = deriveAttributionEvidenceCitation({
        lifecycleRecords: familyEconomicsById(familyId)?.lifecycleRecords ?? [],
        generations: familyEconomicsById(familyId)?.generations ?? [],
        ledgerEntries: familyEconomicsById(familyId)?.ledgerEntries ?? [],
        baselines: familyEconomicsById(familyId)?.baselines ?? [],
        recordedTotals: familyEconomicsById(familyId)?.recordedTotals ?? [],
        split: canonicalSplitOf(familyId),
      });
      expect(verdict.complete, familyId).toBe(true);
      expect(verdict.phantomLedgerEntryIds).toEqual([]);
      expect(verdict.uncitedLedgerEntryIds).toEqual([]);
      expect(verdict.uncitedClaims).toEqual([]);
      expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
    }
  });

  test("an UNCITED claim (a nonzero claim with no citations at all) FAILs naming the claim", () => {
    const canonical = canonicalSplitOf("rag-retrieval");
    const uncited: FamilyAttributionSplit = {
      ...canonical,
      claims: canonical.claims.map((claim) =>
        claim.generation === 2 && claim.mechanism === "cache"
          ? { ...claim, citedLedgerEntryIds: [], citedLifecycleProposalIds: [] }
          : claim,
      ),
    };
    const verdict = deriveAttributionEvidenceCitation({
      lifecycleRecords: ragEconomics.lifecycleRecords,
      generations: ragEconomics.generations,
      ledgerEntries: ragEconomics.ledgerEntries,
      baselines: ragEconomics.baselines,
      recordedTotals: ragEconomics.recordedTotals,
      split: uncited,
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.uncitedClaims).toEqual([{ mechanism: "cache", generation: 2 }]);
    const claimsCite = criterionOf(verdict.criteria, "attribution-citation-claims-cite-evidence");
    expect(claimsCite?.status).toBe("FAIL");
    expect(claimsCite?.evidence.join(" ")).toContain("UNCITED-CLAIM");
    expect(claimsCite?.evidence.join(" ")).toContain("cache@g2");
    // The dropped members also become a partial population.
    expect(criterionOf(verdict.criteria, "attribution-citation-full-population")?.status).toBe(
      "FAIL",
    );
  });

  test("a PARTIAL population (a dropped ledger entry / lifecycle citation) FAILs naming the missed member", () => {
    const canonical = canonicalSplitOf("rag-retrieval");
    const droppedEntry = canonical.claims[0]?.citedLedgerEntryIds[0] ?? "";
    const entryVerdict = deriveAttributionEvidenceCitation({
      lifecycleRecords: ragEconomics.lifecycleRecords,
      generations: ragEconomics.generations,
      ledgerEntries: ragEconomics.ledgerEntries,
      baselines: ragEconomics.baselines,
      recordedTotals: ragEconomics.recordedTotals,
      split: {
        ...canonical,
        claims: canonical.claims.map((claim) =>
          claim.citedLedgerEntryIds.includes(droppedEntry)
            ? { ...claim, citedLedgerEntryIds: [] }
            : claim,
        ),
      },
    });
    expect(entryVerdict.complete).toBe(false);
    expect(entryVerdict.uncitedLedgerEntryIds).toEqual([droppedEntry]);
    const fullPopulation = criterionOf(
      entryVerdict.criteria,
      "attribution-citation-full-population",
    );
    expect(fullPopulation?.status).toBe("FAIL");
    expect(fullPopulation?.evidence.join(" ")).toContain("PARTIAL-POPULATION");
    expect(fullPopulation?.evidence.join(" ")).toContain(droppedEntry);

    // A dropped lifecycle citation likewise.
    const droppedLifecycle = canonical.claims[0]?.citedLifecycleProposalIds[0] ?? "";
    const lifecycleVerdict = deriveAttributionEvidenceCitation({
      lifecycleRecords: ragEconomics.lifecycleRecords,
      generations: ragEconomics.generations,
      ledgerEntries: ragEconomics.ledgerEntries,
      baselines: ragEconomics.baselines,
      recordedTotals: ragEconomics.recordedTotals,
      split: {
        ...canonical,
        claims: canonical.claims.map((claim) =>
          claim.citedLifecycleProposalIds.includes(droppedLifecycle)
            ? { ...claim, citedLifecycleProposalIds: [] }
            : claim,
        ),
      },
    });
    expect(lifecycleVerdict.complete).toBe(false);
    expect(lifecycleVerdict.uncitedLifecycleProposalIds).toEqual([droppedLifecycle]);
    expect(
      criterionOf(lifecycleVerdict.criteria, "attribution-citation-full-population")?.status,
    ).toBe("FAIL");
  });

  test("a PHANTOM citation FAILs naming the member; an EMPTY basis FAILs the minimum", () => {
    const canonical = canonicalSplitOf("rag-retrieval");
    const phantom = deriveAttributionEvidenceCitation({
      lifecycleRecords: ragEconomics.lifecycleRecords,
      generations: ragEconomics.generations,
      ledgerEntries: ragEconomics.ledgerEntries,
      baselines: ragEconomics.baselines,
      recordedTotals: ragEconomics.recordedTotals,
      split: {
        ...canonical,
        claims: canonical.claims.map((claim) =>
          claim.generation === 1
            ? { ...claim, citedLedgerEntryIds: [...claim.citedLedgerEntryIds, "led-phantom-1"] }
            : claim,
        ),
      },
    });
    expect(phantom.complete).toBe(false);
    expect(phantom.phantomLedgerEntryIds).toEqual(["led-phantom-1"]);
    const noPhantom = criterionOf(phantom.criteria, "attribution-citation-no-phantom-members");
    expect(noPhantom?.status).toBe("FAIL");
    expect(noPhantom?.evidence.join(" ")).toContain("PHANTOM-CITATION");

    // A phantom lifecycle citation likewise.
    const phantomLifecycle = deriveAttributionEvidenceCitation({
      lifecycleRecords: ragEconomics.lifecycleRecords,
      generations: ragEconomics.generations,
      ledgerEntries: ragEconomics.ledgerEntries,
      baselines: ragEconomics.baselines,
      recordedTotals: ragEconomics.recordedTotals,
      split: {
        ...canonical,
        claims: canonical.claims.map((claim) => ({
          ...claim,
          citedLifecycleProposalIds: [...claim.citedLifecycleProposalIds, "cand-phantom-x"],
        })),
      },
    });
    expect(phantomLifecycle.phantomLifecycleProposalIds).toEqual(["cand-phantom-x"]);

    // An empty recorded basis is not evidence (an attribution from
    // nothing never passes).
    const empty = deriveAttributionEvidenceCitation({
      lifecycleRecords: [],
      generations: [],
      ledgerEntries: [],
      baselines: [],
      recordedTotals: [],
      split: { claims: [], residual: [] },
    });
    expect(empty.complete).toBe(false);
    expect(empty.minimumEvidence).toBe(false);
    expect(criterionOf(empty.criteria, "attribution-citation-minimum-evidence")?.status).toBe(
      "FAIL",
    );
  });
});

// ---------------------------------------------------------------------------
// Family 2: the double-count (each ledger entry at most one mechanism)
// ---------------------------------------------------------------------------

describe("VAL-045 discrimination: the double-count", () => {
  test("the canonical split attributes each ledger entry to exactly ONE mechanism (the control)", () => {
    for (const familyId of ["rag-retrieval", "code-search", "invoice-extraction"]) {
      const verdict = deriveNoDoubleCount({ split: canonicalSplitOf(familyId) });
      expect(verdict.undoubled, familyId).toBe(true);
      expect(verdict.doubleCountedEntries).toEqual([]);
      expect(verdict.selfDoubleCitingClaims).toEqual([]);
      expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
    }
  });

  test("a DOUBLE-COUNT (one entry cited by two mechanisms) FAILs with BOTH claims named", () => {
    const canonical = canonicalSplitOf("rag-retrieval");
    const victim = canonical.claims[0];
    if (victim === undefined) {
      throw new Error("the RAG canonical split holds no claims");
    }
    const doubleCounted: FamilyAttributionSplit = {
      ...canonical,
      claims: [
        ...canonical.claims,
        {
          mechanism: "reuse",
          generation: victim.generation,
          claimedMicroUsd: 0,
          citedLedgerEntryIds: [...victim.citedLedgerEntryIds],
          citedLifecycleProposalIds: [],
          baselineDigest: victim.baselineDigest,
          baselineBasis: "recorded" as const,
        },
      ],
    };
    const verdict = deriveNoDoubleCount({ split: doubleCounted });
    expect(verdict.undoubled).toBe(false);
    expect(verdict.doubleCountedEntries).toHaveLength(1);
    expect(verdict.doubleCountedEntries[0]?.entryId).toBe(victim.citedLedgerEntryIds[0]);
    // BOTH claims named: the first mechanism AND the second mechanism.
    expect(verdict.doubleCountedEntries[0]?.firstMechanism).toBe(victim.mechanism);
    expect(verdict.doubleCountedEntries[0]?.secondMechanism).toBe("reuse");
    const noDouble = criterionOf(verdict.criteria, "attribution-no-double-count");
    expect(noDouble?.status).toBe("FAIL");
    expect(noDouble?.evidence.join(" ")).toContain("DOUBLE-COUNT");
    expect(noDouble?.evidence.join(" ")).toContain(
      `${victim.citedLedgerEntryIds[0]}(${victim.mechanism}+reuse)`,
    );
  });

  test("a SELF-DOUBLE-CITE (a claim citing its own entry twice) FAILs naming the claim", () => {
    const canonical = canonicalSplitOf("rag-retrieval");
    const victim = canonical.claims[0];
    if (victim === undefined) {
      throw new Error("the RAG canonical split holds no claims");
    }
    const selfDouble: FamilyAttributionSplit = {
      ...canonical,
      claims: canonical.claims.map((claim) =>
        claim === victim
          ? {
              ...claim,
              citedLedgerEntryIds: [...claim.citedLedgerEntryIds, ...claim.citedLedgerEntryIds],
            }
          : claim,
      ),
    };
    const verdict = deriveNoDoubleCount({ split: selfDouble });
    expect(verdict.undoubled).toBe(false);
    expect(verdict.selfDoubleCitingClaims).toEqual([
      { mechanism: victim.mechanism, generation: victim.generation },
    ]);
    const selfLeg = criterionOf(verdict.criteria, "attribution-no-self-double-cite");
    expect(selfLeg?.status).toBe("FAIL");
    expect(selfLeg?.evidence.join(" ")).toContain("SELF-DOUBLE-CITE");
  });
});

// ---------------------------------------------------------------------------
// Family 3: the forced residual (the residual is reported, never forced)
// ---------------------------------------------------------------------------

describe("VAL-045 discrimination: the forced residual", () => {
  test("the honest LARGE residual PASSES (reported, never forced — the control)", () => {
    const verdict = deriveResidualHonesty({
      ledgerEntries: textEconomics.ledgerEntries,
      recordedTotals: textEconomics.recordedTotals,
      split: canonicalSplitOf("text-summarization"),
    });
    expect(verdict.honest).toBe(true);
    expect(verdict.forcedResiduals).toEqual([]);
    expect(verdict.hiddenResidualGenerations).toEqual([]);
    // 320 of 410 micro-USD honestly unattributed (most savings
    // unattributed, never forced into the cache mechanism).
    const declared = declaredSplitTotalsOf(rowById("text-summarization-large-honest-residual"));
    expect(declared.residualMicroUsd).toBe(320);
    expect(declared.attributedTotalMicroUsd).toBe(90);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("the residual claimed as a mechanism (a claim exceeding its evidence) FAILs with the mechanism + both sides named", () => {
    const canonical = canonicalSplitOf("text-summarization");
    const forced: FamilyAttributionSplit = {
      ...canonical,
      claims: canonical.claims.map((claim) =>
        claim.generation === 1 ? { ...claim, claimedMicroUsd: claim.claimedMicroUsd + 160 } : claim,
      ),
    };
    const verdict = deriveResidualHonesty({
      ledgerEntries: textEconomics.ledgerEntries,
      recordedTotals: textEconomics.recordedTotals,
      split: forced,
    });
    expect(verdict.honest).toBe(false);
    expect(verdict.forcedResiduals).toHaveLength(1);
    expect(verdict.forcedResiduals[0]?.mechanism).toBe("cache");
    expect(verdict.forcedResiduals[0]?.generation).toBe(1);
    expect(verdict.forcedResiduals[0]?.claimedMicroUsd).toBe(200);
    expect(verdict.forcedResiduals[0]?.citedEvidenceMicroUsd).toBe(40);
    const neverForced = criterionOf(verdict.criteria, "attribution-residual-never-forced");
    expect(neverForced?.status).toBe("FAIL");
    expect(neverForced?.evidence.join(" ")).toContain("FORCED-RESIDUAL");
    expect(neverForced?.evidence.join(" ")).toContain("claimed=200,evidence=40");
  });

  test("an UNDER-attribution, a HIDDEN residual and an INFLATED residual each FAIL (both sides named)", () => {
    const canonical = canonicalSplitOf("rag-retrieval");
    // Under-attribution: ONE claim below its cited evidence.
    const under = deriveResidualHonesty({
      ledgerEntries: ragEconomics.ledgerEntries,
      recordedTotals: ragEconomics.recordedTotals,
      split: {
        ...canonical,
        claims: canonical.claims.map((claim) =>
          claim.generation === 1 && claim.mechanism === "deterministicization"
            ? { ...claim, claimedMicroUsd: claim.claimedMicroUsd - 10 }
            : claim,
        ),
      },
    });
    expect(under.honest).toBe(false);
    expect(under.underAttributions).toHaveLength(1);
    const underLeg = criterionOf(under.criteria, "attribution-no-under-attribution");
    expect(underLeg?.status).toBe("FAIL");
    expect(underLeg?.evidence.join(" ")).toContain("UNDER-ATTRIBUTION");

    // Hidden residual: an existing residual not reported.
    const hidden = deriveResidualHonesty({
      ledgerEntries: ragEconomics.ledgerEntries,
      recordedTotals: ragEconomics.recordedTotals,
      split: {
        ...canonical,
        residual: canonical.residual.map((claim) =>
          claim.generation === 2 ? { ...claim, reported: false } : claim,
        ),
      },
    });
    expect(hidden.honest).toBe(false);
    expect(hidden.hiddenResidualGenerations).toEqual([2]);
    const reportedLeg = criterionOf(hidden.criteria, "attribution-residual-reported");
    expect(reportedLeg?.status).toBe("FAIL");
    expect(reportedLeg?.evidence.join(" ")).toContain("HIDDEN-RESIDUAL");

    // Inflated residual: the reported number does not match the
    // recorded basis — BOTH sides named.
    const inflated = deriveResidualHonesty({
      ledgerEntries: ragEconomics.ledgerEntries,
      recordedTotals: ragEconomics.recordedTotals,
      split: {
        ...canonical,
        residual: canonical.residual.map((claim) =>
          claim.generation === 3
            ? { ...claim, residualMicroUsd: claim.residualMicroUsd + 5 }
            : claim,
        ),
      },
    });
    expect(inflated.honest).toBe(false);
    expect(inflated.mismatchedResidualGenerations).toHaveLength(1);
    expect(inflated.mismatchedResidualGenerations[0]?.reportedResidualMicroUsd).toBe(40);
    expect(inflated.mismatchedResidualGenerations[0]?.recordedResidualMicroUsd).toBe(35);
    const matchesLeg = criterionOf(inflated.criteria, "attribution-residual-matches-recorded");
    expect(matchesLeg?.status).toBe("FAIL");
    expect(matchesLeg?.evidence.join(" ")).toContain("RESIDUAL-MISMATCH");
  });
});

// ---------------------------------------------------------------------------
// Family 4: the swapped baseline (the counterfactual fidelity)
// ---------------------------------------------------------------------------

describe("VAL-045 discrimination: the swapped baseline", () => {
  test("the RECORDED incumbent baseline per VAL-044's adjusted model PASSES (the control)", () => {
    for (const familyId of [
      "rag-retrieval",
      "text-summarization",
      "code-search",
      "invoice-extraction",
      "translation-glossary",
    ]) {
      const verdict = deriveCounterfactualFidelity({
        baselines: familyEconomicsById(familyId)?.baselines ?? [],
        split: canonicalSplitOf(familyId),
      });
      expect(verdict.faithful, familyId).toBe(true);
      expect(verdict.infidelities).toEqual([]);
      expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
    }
    // The recorded counterfactual IS the incumbent minus the
    // replacement (VAL-044's adjusted model).
    const baseline = ragEconomics.baselines[0];
    if (baseline === undefined) {
      throw new Error("the RAG economics hold no baselines");
    }
    expect(recordedCounterfactualOf(baseline)).toBe(
      baseline.incumbentAdjustedCostMicroUsd - baseline.replacementAdjustedCostMicroUsd,
    );
    // Every ledger entry's number EQUALS its baseline's counterfactual.
    for (const entry of ragEconomics.ledgerEntries) {
      const baselineForEntry = ragEconomics.baselines.find(
        (candidate) =>
          candidate.generation === entry.generation && candidate.mechanism === entry.mechanism,
      );
      if (baselineForEntry === undefined) {
        throw new Error(`no recorded baseline for ${entry.mechanism}@g${entry.generation}`);
      }
      expect(entry.microUsd).toBe(recordedCounterfactualOf(baselineForEntry));
    }
  });

  test("an UNSTATED baseline (no digest cited) FAILs naming the claim", () => {
    const canonical = canonicalSplitOf("rag-retrieval");
    const verdict = deriveCounterfactualFidelity({
      baselines: ragEconomics.baselines,
      split: {
        ...canonical,
        claims: canonical.claims.map((claim) =>
          claim.generation === 3 ? { ...claim, baselineDigest: "" } : claim,
        ),
      },
    });
    expect(verdict.faithful).toBe(false);
    expect(verdict.infidelities.filter((shape) => shape.shape === "unstated")).toHaveLength(2);
    const stated = criterionOf(verdict.criteria, "attribution-baseline-stated");
    expect(stated?.status).toBe("FAIL");
    expect(stated?.evidence.join(" ")).toContain("UNSTATED-BASELINE");
  });

  test("a SWAPPED baseline (another generation's recorded baseline) FAILs with BOTH digests named", () => {
    const canonical = canonicalSplitOf("invoice-extraction");
    const generation3Reuse = invoiceEconomics.baselines.find(
      (baseline) => baseline.generation === 3 && baseline.mechanism === "reuse",
    );
    if (generation3Reuse === undefined) {
      throw new Error("the invoice economics hold no g3 reuse baseline");
    }
    const verdict = deriveCounterfactualFidelity({
      baselines: invoiceEconomics.baselines,
      split: {
        ...canonical,
        claims: canonical.claims.map((claim) =>
          claim.generation === 1 && claim.mechanism === "reuse"
            ? { ...claim, baselineDigest: incumbentBaselineDigestOf(generation3Reuse) }
            : claim,
        ),
      },
    });
    expect(verdict.faithful).toBe(false);
    const swappedShape = verdict.infidelities.find((shape) => shape.shape === "swapped");
    expect(swappedShape?.mechanism).toBe("reuse");
    expect(swappedShape?.generation).toBe(1);
    // BOTH sides named: the cited digest AND the recorded digest.
    expect(swappedShape?.citedBaselineDigest).toBe(incumbentBaselineDigestOf(generation3Reuse));
    const recorded = invoiceEconomics.baselines.find(
      (baseline) => baseline.generation === 1 && baseline.mechanism === "reuse",
    );
    expect(swappedShape?.recordedBaselineDigest).toBe(
      recorded === undefined ? "" : incumbentBaselineDigestOf(recorded),
    );
    const notSwapped = criterionOf(verdict.criteria, "attribution-baseline-not-swapped");
    expect(notSwapped?.status).toBe("FAIL");
    expect(notSwapped?.evidence.join(" ")).toContain("SWAPPED-BASELINE");
    expect(notSwapped?.evidence.join(" ")).toContain("cited=");
    expect(notSwapped?.evidence.join(" ")).toContain("recorded=");
  });

  test("a HYPOTHETICAL baseline (an unrecorded digest or basis) FAILs named; a wrong number FAILs with both sides", () => {
    const canonical = canonicalSplitOf("rag-retrieval");
    // A digest no recorded baseline holds.
    const hypothetical = deriveCounterfactualFidelity({
      baselines: ragEconomics.baselines,
      split: {
        ...canonical,
        claims: canonical.claims.map((claim) =>
          claim.generation === 1 ? { ...claim, baselineDigest: "ffffffff" } : claim,
        ),
      },
    });
    expect(hypothetical.faithful).toBe(false);
    expect(
      hypothetical.infidelities.filter((shape) => shape.shape === "hypothetical"),
    ).toHaveLength(2);
    const recordedLeg = criterionOf(hypothetical.criteria, "attribution-baseline-recorded");
    expect(recordedLeg?.status).toBe("FAIL");
    expect(recordedLeg?.evidence.join(" ")).toContain("HYPOTHETICAL-BASELINE");

    // A non-recorded BASIS fails likewise even with the right digest.
    const basis = deriveCounterfactualFidelity({
      baselines: ragEconomics.baselines,
      split: {
        ...canonical,
        claims: canonical.claims.map((claim) =>
          claim.generation === 2 ? { ...claim, baselineBasis: "hypothetical" as const } : claim,
        ),
      },
    });
    expect(basis.faithful).toBe(false);
    expect(basis.infidelities.every((shape) => shape.shape === "hypothetical")).toBe(true);

    // A number that does not equal the recorded counterfactual FAILs
    // with BOTH sides named.
    const mismatched = deriveCounterfactualFidelity({
      baselines: ragEconomics.baselines,
      split: {
        ...canonical,
        claims: canonical.claims.map((claim) =>
          claim.generation === 1 && claim.mechanism === "reuse"
            ? { ...claim, claimedMicroUsd: claim.claimedMicroUsd + 1 }
            : claim,
        ),
      },
    });
    expect(mismatched.faithful).toBe(false);
    const numberLeg = criterionOf(mismatched.criteria, "attribution-counterfactual-number");
    expect(numberLeg?.status).toBe("FAIL");
    expect(numberLeg?.evidence.join(" ")).toContain("COUNTERFACTUAL-MISMATCH");
    expect(numberLeg?.evidence.join(" ")).toContain("claimed=31,recorded=30");
  });
});

// ---------------------------------------------------------------------------
// Family 5: the gapped series (the maturity linkage)
// ---------------------------------------------------------------------------

describe("VAL-045 discrimination: the gapped series", () => {
  test("a series MATCHING VAL-036's recorded generations PASSES (the control)", () => {
    for (const familyId of [
      "rag-retrieval",
      "text-summarization",
      "code-search",
      "invoice-extraction",
      "translation-glossary",
    ]) {
      const verdict = deriveGenerationSeriesIntegrity({
        recordedGenerations: familyEconomicsById(familyId)?.generations ?? [],
        split: canonicalSplitOf(familyId),
      });
      expect(verdict.integral, familyId).toBe(true);
      expect(verdict.missingGenerations).toEqual([]);
      expect(verdict.unrecordedGenerations).toEqual([]);
      expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
    }
  });

  test("a GAPPED series (a recorded generation the attribution missed) FAILs naming it", () => {
    const canonical = canonicalSplitOf("translation-glossary");
    const verdict = deriveGenerationSeriesIntegrity({
      recordedGenerations: translationEconomics.generations,
      split: {
        ...canonical,
        claims: canonical.claims.filter((claim) => claim.generation !== 2),
      },
    });
    expect(verdict.integral).toBe(false);
    expect(verdict.missingGenerations).toEqual([2]);
    const matches = criterionOf(verdict.criteria, "attribution-series-matches-maturity");
    expect(matches?.status).toBe("FAIL");
    expect(matches?.evidence.join(" ")).toContain("GAPPED-SERIES");
    expect(matches?.evidence.join(" ")).toContain("missingGenerations:2");
  });

  test("a MISMATCHED series (a generation the maturity curves do not hold) and an EMPTY series each FAIL named", () => {
    const canonical = canonicalSplitOf("rag-retrieval");
    const mismatched = deriveGenerationSeriesIntegrity({
      recordedGenerations: ragEconomics.generations,
      split: {
        ...canonical,
        claims: canonical.claims.map((claim) =>
          claim.generation === 3 ? { ...claim, generation: 9 } : claim,
        ),
      },
    });
    expect(mismatched.integral).toBe(false);
    expect(mismatched.unrecordedGenerations).toEqual([9]);
    const fabricated = criterionOf(
      mismatched.criteria,
      "attribution-series-no-fabricated-generations",
    );
    expect(fabricated?.status).toBe("FAIL");
    expect(fabricated?.evidence.join(" ")).toContain("MISMATCHED-SERIES");

    const empty = deriveGenerationSeriesIntegrity({
      recordedGenerations: ragEconomics.generations,
      split: { claims: [], residual: [] },
    });
    expect(empty.integral).toBe(false);
    expect(empty.minimumSeries).toBe(false);
    expect(criterionOf(empty.criteria, "attribution-series-minimum")?.status).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// The reconciliation identity (attributed + residual = recorded total)
// ---------------------------------------------------------------------------

describe("VAL-045 discrimination: the reconciliation identity", () => {
  test("attributed + residual EQUALS the recorded total per family and per generation (the control)", () => {
    for (const familyId of [
      "rag-retrieval",
      "text-summarization",
      "code-search",
      "invoice-extraction",
      "translation-glossary",
    ]) {
      const economics = familyEconomicsById(familyId);
      const verdict = deriveAttributionReconciliation({
        recordedTotals: economics?.recordedTotals ?? [],
        split: canonicalSplitOf(familyId),
      });
      expect(verdict.reconciled, familyId).toBe(true);
      expect(verdict.mismatchedGenerations).toEqual([]);
      expect(verdict.attributedTotalMicroUsd + verdict.residualTotalMicroUsd).toBe(
        verdict.recordedTotalMicroUsd,
      );
      expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
    }
    // The four CANDIDATE_KINDS mechanisms are attributed SEPARATELY.
    const rag = deriveAttributionReconciliation({
      recordedTotals: ragEconomics.recordedTotals,
      split: canonicalSplitOf("rag-retrieval"),
    });
    expect(Object.keys(rag.attributedByMechanism).sort()).toEqual([
      "cache",
      "competence",
      "deterministicization",
      "reuse",
    ]);
    expect(rag.attributedByMechanism).toEqual({
      reuse: 80,
      cache: 100,
      competence: 60,
      deterministicization: 160,
    });
    expect(rag.residualTotalMicroUsd).toBe(95);
    expect(rag.recordedTotalMicroUsd).toBe(495);
  });

  test("a non-reconciling generation and a family-total mismatch each FAIL with BOTH sides named", () => {
    const canonical = canonicalSplitOf("rag-retrieval");
    // A generation whose attributed + residual exceeds the recorded
    // total — BOTH sides named (ONE g1 claim inflated by 20).
    const mismatched = deriveAttributionReconciliation({
      recordedTotals: ragEconomics.recordedTotals,
      split: {
        ...canonical,
        claims: canonical.claims.map((claim) =>
          claim.generation === 1 && claim.mechanism === "deterministicization"
            ? { ...claim, claimedMicroUsd: claim.claimedMicroUsd + 20 }
            : claim,
        ),
      },
    });
    expect(mismatched.reconciled).toBe(false);
    expect(mismatched.mismatchedGenerations).toHaveLength(1);
    expect(mismatched.mismatchedGenerations[0]?.generation).toBe(1);
    expect(mismatched.mismatchedGenerations[0]?.attributedPlusResidualMicroUsd).toBe(200);
    expect(mismatched.mismatchedGenerations[0]?.recordedTotalMicroUsd).toBe(180);
    const identity = criterionOf(
      mismatched.criteria,
      "attribution-reconciliation-identity-per-generation",
    );
    expect(identity?.status).toBe("FAIL");
    expect(identity?.evidence.join(" ")).toContain("NON-RECONCILING-ATTRIBUTION");
    expect(identity?.evidence.join(" ")).toContain("attributed+residual=200,recorded=180");
    // The family total likewise (the residual dropped).
    const familyTotal = criterionOf(
      mismatched.criteria,
      "attribution-reconciliation-identity-family-total",
    );
    expect(familyTotal?.status).toBe("FAIL");
    expect(familyTotal?.evidence.join(" ")).toContain("FAMILY-TOTAL-MISMATCH");

    // A dropped residual breaks the family identity alone (the
    // per-generation numbers each still hold only via the residual).
    const droppedResidual = deriveAttributionReconciliation({
      recordedTotals: ragEconomics.recordedTotals,
      split: { ...canonical, residual: [] },
    });
    expect(droppedResidual.reconciled).toBe(false);
    expect(droppedResidual.attributedTotalMicroUsd).toBe(400);
    expect(droppedResidual.residualTotalMicroUsd).toBe(0);
    expect(droppedResidual.recordedTotalMicroUsd).toBe(495);

    // NO recorded basis FAILs the identity's basis.
    const noBasis = deriveAttributionReconciliation({
      recordedTotals: [],
      split: canonicalSplitOf("rag-retrieval"),
    });
    expect(noBasis.reconciled).toBe(false);
    expect(criterionOf(noBasis.criteria, "attribution-reconciliation-recorded-basis")?.status).toBe(
      "FAIL",
    );
  });
});

// ---------------------------------------------------------------------------
// The honesty matrix (measured never estimated; honest boundaries)
// ---------------------------------------------------------------------------

describe("VAL-045 discrimination: the honesty matrix", () => {
  test("MEASURED baselines with honestly none-reported offline usage PASS (the control); ESTIMATED FAILs named", () => {
    const measured = deriveAttributionHonesty({
      baselines: ragEconomics.baselines,
      reportedUsage: null,
      liveRail: false,
    });
    expect(measured.honest).toBe(true);
    expect(measured.estimatedBaselines).toEqual([]);
    expect(measured.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);

    // A baseline whose adjusted costs were estimated, not measured.
    const estimated = deriveAttributionHonesty({
      baselines: ragEconomics.baselines.map((baseline) =>
        baseline.generation === 2 ? { ...baseline, measured: false } : baseline,
      ),
      reportedUsage: null,
      liveRail: false,
    });
    expect(estimated.honest).toBe(false);
    expect(estimated.estimatedBaselines).toEqual([
      { mechanism: "cache", generation: 2 },
      { mechanism: "deterministicization", generation: 2 },
    ]);
    const neverEstimated = criterionOf(
      estimated.criteria,
      "attribution-honesty-baselines-measured",
    );
    expect(neverEstimated?.status).toBe("FAIL");
    expect(neverEstimated?.evidence.join(" ")).toContain("ESTIMATED-BASELINE");

    // The live rail's measured usage is honest (the only place usage
    // is admissible).
    const liveUsage: LabUsage = { inputTokens: 30, outputTokens: 6 };
    const live = deriveAttributionHonesty({
      baselines: ragEconomics.baselines,
      reportedUsage: liveUsage,
      liveRail: true,
    });
    expect(live.honest).toBe(true);
    expect(live.noneReportedUsageHonest).toBe(true);
  });

  test("a FABRICATED offline usage FAILs the none-reported boundary (named)", () => {
    const fabricatedUsage: LabUsage = { inputTokens: 5, outputTokens: 1, costUsd: 0.00001 };
    const verdict = deriveAttributionHonesty({
      baselines: ragEconomics.baselines,
      reportedUsage: fabricatedUsage,
      liveRail: false,
    });
    expect(verdict.honest).toBe(false);
    expect(verdict.fabricatedUsage).toBe(true);
    expect(verdict.noneReportedUsageHonest).toBe(false);
    const boundary = criterionOf(verdict.criteria, "attribution-honesty-none-reported-boundary");
    expect(boundary?.status).toBe("FAIL");
    expect(boundary?.evidence.join(" ")).toContain("FABRICATED-USAGE");
  });
});

// ---------------------------------------------------------------------------
// The refusal honesty (a refusal is honest only when justified)
// ---------------------------------------------------------------------------

describe("VAL-045 discrimination: the refusal honesty", () => {
  test("justified refusals PASS; unjustified refusals FAIL (both directions)", () => {
    // The phantom family: nothing recorded — the family-unrecorded
    // refusal is justified.
    expect(
      deriveAttributionRefusalHonesty({
        refusal: { reason: "family-unrecorded" },
        lifecycleRecordCount: 0,
        generationCount: 0,
        ledgerEntryCount: 0,
        recordedTotalCount: 0,
      }).honest,
    ).toBe(true);
    // The tool-routing family: a lifecycle + generations without
    // savings — the no-savings-recorded refusal is justified.
    expect(
      deriveAttributionRefusalHonesty({
        refusal: { reason: "no-savings-recorded" },
        lifecycleRecordCount: 1,
        generationCount: 2,
        ledgerEntryCount: 0,
        recordedTotalCount: 0,
      }).honest,
    ).toBe(true);
    // A RECORDED family WITH savings refusing is dishonest (both
    // directions).
    expect(
      deriveAttributionRefusalHonesty({
        refusal: { reason: "family-unrecorded" },
        lifecycleRecordCount: 6,
        generationCount: 3,
        ledgerEntryCount: 6,
        recordedTotalCount: 3,
      }).honest,
    ).toBe(false);
    expect(
      deriveAttributionRefusalHonesty({
        refusal: { reason: "no-savings-recorded" },
        lifecycleRecordCount: 6,
        generationCount: 3,
        ledgerEntryCount: 6,
        recordedTotalCount: 3,
      }).honest,
    ).toBe(false);
    // No refusal is honest by default.
    expect(
      deriveAttributionRefusalHonesty({
        refusal: null,
        lifecycleRecordCount: 0,
        generationCount: 0,
        ledgerEntryCount: 0,
        recordedTotalCount: 0,
      }).honest,
    ).toBe(true);
  });

  test("the verdict derivation orders its failure modes honestly", () => {
    // An honest refusal is no-evidence-honest; a dishonest refusal is
    // attribution-invalid (never passable).
    expect(
      deriveAttributionVerdictKind({
        refusal: { reason: "family-unrecorded" },
        refusalHonesty: deriveAttributionRefusalHonesty({
          refusal: { reason: "family-unrecorded" },
          lifecycleRecordCount: 0,
          generationCount: 0,
          ledgerEntryCount: 0,
          recordedTotalCount: 0,
        }),
        citation: null,
        noDoubleCount: null,
        residualHonesty: null,
        reconciliation: null,
        counterfactual: null,
        generationSeries: null,
        honesty: null,
        inputUnchanged: true,
        failure: null,
      }),
    ).toBe("no-evidence-honest");
    expect(
      deriveAttributionVerdictKind({
        refusal: { reason: "family-unrecorded" },
        refusalHonesty: deriveAttributionRefusalHonesty({
          refusal: { reason: "family-unrecorded" },
          lifecycleRecordCount: 6,
          generationCount: 3,
          ledgerEntryCount: 6,
          recordedTotalCount: 3,
        }),
        citation: null,
        noDoubleCount: null,
        residualHonesty: null,
        reconciliation: null,
        counterfactual: null,
        generationSeries: null,
        honesty: null,
        inputUnchanged: true,
        failure: null,
      }),
    ).toBe("attribution-invalid");
    // A dispatch failure is an invalid run (recorded honestly, never
    // smoothed into a pass).
    expect(
      deriveAttributionVerdictKind({
        refusal: null,
        refusalHonesty: null,
        citation: null,
        noDoubleCount: null,
        residualHonesty: null,
        reconciliation: null,
        counterfactual: null,
        generationSeries: null,
        honesty: null,
        inputUnchanged: true,
        failure: { category: "provider-unavailable", message: "upstream 503" },
      }),
    ).toBe("attribution-invalid");
  });
});

// ---------------------------------------------------------------------------
// The digest / identity determinism (payload-free, discriminating)
// ---------------------------------------------------------------------------

describe("VAL-045 discrimination: the digest + identity determinism", () => {
  test("every digest is deterministic and payload-free (FNV-1a 8-hex)", () => {
    const entry = ragEconomics.ledgerEntries[0];
    if (entry === undefined) {
      throw new Error("the RAG economics hold no ledger entries");
    }
    expect(attributionEntryDigestOf(entry)).toBe(attributionEntryDigestOf(entry));
    expect(attributionEntryDigestOf(entry)).toMatch(/^[0-9a-f]{8}$/);
    const baseline = ragEconomics.baselines[0];
    if (baseline === undefined) {
      throw new Error("the RAG economics hold no baselines");
    }
    expect(incumbentBaselineDigestOf(baseline)).toBe(incumbentBaselineDigestOf(baseline));
    expect(incumbentBaselineDigestOf(baseline)).toMatch(/^[0-9a-f]{8}$/);
    const total = ragEconomics.recordedTotals[0];
    if (total === undefined) {
      throw new Error("the RAG economics hold no recorded totals");
    }
    expect(recordedSavingsTotalDigestOf(total)).toBe(recordedSavingsTotalDigestOf(total));
    expect(recordedSavingsTotalDigestOf(total)).toMatch(/^[0-9a-f]{8}$/);
    const claim = canonicalSplitOf("rag-retrieval").claims[0];
    if (claim === undefined) {
      throw new Error("the RAG canonical split holds no claims");
    }
    expect(attributionClaimDigestOf(claim)).toBe(attributionClaimDigestOf(claim));
    expect(attributionClaimDigestOf(claim)).toMatch(/^[0-9a-f]{8}$/);
    const residualClaim = canonicalSplitOf("rag-retrieval").residual[0];
    if (residualClaim === undefined) {
      throw new Error("the RAG canonical split holds no residual claims");
    }
    expect(residualClaimDigestOf(residualClaim)).toBe(residualClaimDigestOf(residualClaim));
    const citation = canonicalAttributionCitationOf({
      ledgerEntries: ragEconomics.ledgerEntries,
      lifecycleRecords: ragEconomics.lifecycleRecords,
      baselines: ragEconomics.baselines,
      recordedTotals: ragEconomics.recordedTotals,
    });
    expect(attributionCitationDigestOf(citation)).toBe(attributionCitationDigestOf(citation));
    expect(attributionCitationDigestOf(citation)).toMatch(/^[0-9a-f]{8}$/);
    const ragMaturityReport = ragEconomics.maturityReports[0];
    if (ragMaturityReport === undefined) {
      throw new Error("the RAG economics hold no maturity report");
    }
    const report = {
      familyId: "rag-retrieval",
      attributed: { reuse: 80, cache: 100, competence: 60, deterministicization: 160 },
      residualMicroUsd: 95,
      claimedTotalMicroUsd: 495,
      claimDigests: [attributionClaimDigestOf(claim)],
      residualDigests: [residualClaimDigestOf(residualClaim)],
      citationDigest: attributionCitationDigestOf(citation),
      maturityReportDigest: maturityReportDigestOf(ragMaturityReport),
    };
    expect(savingsAttributionReportDigestOf(report)).toBe(savingsAttributionReportDigestOf(report));
    const facts: AttributionAnalysisFacts = createAttributionHistoryPort().facts();
    expect(attributionInputDigestOf(facts)).toBe(attributionInputDigestOf(facts));
    expect(attributionInputDigestOf(facts)).toMatch(/^[0-9a-f]{8}$/);
  });

  test("the digests DISCRIMINATE (different facts, different digests)", () => {
    const entry = ragEconomics.ledgerEntries[0];
    const baseline = ragEconomics.baselines[0];
    const total = ragEconomics.recordedTotals[0];
    if (entry === undefined || baseline === undefined || total === undefined) {
      throw new Error("the RAG economics are incomplete");
    }
    expect(attributionEntryDigestOf(entry)).not.toBe(
      attributionEntryDigestOf({ ...entry, microUsd: entry.microUsd + 1 }),
    );
    expect(incumbentBaselineDigestOf(baseline)).not.toBe(
      incumbentBaselineDigestOf({
        ...baseline,
        incumbentAdjustedCostMicroUsd: baseline.incumbentAdjustedCostMicroUsd + 1,
      }),
    );
    expect(recordedSavingsTotalDigestOf(total)).not.toBe(
      recordedSavingsTotalDigestOf({ ...total, totalMicroUsd: total.totalMicroUsd + 1 }),
    );
    const claim = canonicalSplitOf("rag-retrieval").claims[0];
    if (claim === undefined) {
      throw new Error("the RAG canonical split holds no claims");
    }
    expect(attributionClaimDigestOf(claim)).not.toBe(
      attributionClaimDigestOf({ ...claim, claimedMicroUsd: claim.claimedMicroUsd + 1 }),
    );
    // The input digest discriminates the facts view (a rewritten
    // recorded history changes it).
    const honest = createAttributionHistoryPort();
    const mutatedFacts: AttributionAnalysisFacts = {
      ...honest.facts(),
      accountingEntryCount: honest.facts().accountingEntryCount + 1,
    };
    expect(attributionInputDigestOf(honest.facts())).not.toBe(
      attributionInputDigestOf(mutatedFacts),
    );
    // The citation digest discriminates a dropped member.
    const citation = canonicalAttributionCitationOf({
      ledgerEntries: ragEconomics.ledgerEntries,
      lifecycleRecords: ragEconomics.lifecycleRecords,
      baselines: ragEconomics.baselines,
      recordedTotals: ragEconomics.recordedTotals,
    });
    expect(attributionCitationDigestOf(citation)).not.toBe(
      attributionCitationDigestOf({
        ...citation,
        ledgerEntryDigests: citation.ledgerEntryDigests.slice(0, -1),
      }),
    );
    // The report digest discriminates the residual (a folded residual
    // changes it).
    const residualClaim = canonicalSplitOf("rag-retrieval").residual[0];
    if (residualClaim === undefined) {
      throw new Error("the RAG canonical split holds no residual claims");
    }
    const reportBase = {
      familyId: "rag-retrieval",
      attributed: { reuse: 80, cache: 100, competence: 60, deterministicization: 160 },
      residualMicroUsd: 95,
      claimedTotalMicroUsd: 495,
      claimDigests: [attributionClaimDigestOf(claim)],
      residualDigests: [residualClaimDigestOf(residualClaim)],
      citationDigest: attributionCitationDigestOf(citation),
      maturityReportDigest: null,
    };
    expect(savingsAttributionReportDigestOf(reportBase)).not.toBe(
      savingsAttributionReportDigestOf({
        ...reportBase,
        residualMicroUsd: 0,
        attributed: { ...reportBase.attributed, cache: 195 },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// The app contract over the fake-world knobs (the boundary catch)
// ---------------------------------------------------------------------------

describe("VAL-045 discrimination: the app contract over the fake-world knobs", () => {
  type Knobs = {
    readonly terminal?: "COMPLETED" | "FAILED";
    readonly attributedsplit?: boolean;
    readonly foldedresidual?: boolean;
    readonly gapped?: boolean;
    readonly inflatedtotal?: boolean;
    readonly unreported?: boolean;
  };

  async function runAppWithKnobs(
    options: Knobs,
  ): Promise<Awaited<ReturnType<typeof runSavingsAttributionApp>>> {
    const clock = createTickClock();
    const world = createAttributionFakeApiWorld({
      clock,
      ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
      ...(options.attributedsplit === true ? { attributedsplit: true } : {}),
      ...(options.foldedresidual === true ? { foldedresidual: true } : {}),
      ...(options.gapped === true ? { gapped: true } : {}),
      ...(options.inflatedtotal === true ? { inflatedtotal: true } : {}),
      ...(options.unreported === true ? { unreported: true } : {}),
    });
    return runSavingsAttributionApp({
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
        configuration: { suite: "val-045-discrimination" },
      },
      runSuffix: "discrimination",
      taskIndex: taskIndexOf("rag-retrieval-all-mechanisms-attributed"),
    });
  }

  test("the honest world passes the boundary contract (the control)", async () => {
    const outcome = await runAppWithKnobs({});
    expect(outcome.passed).toBe(true);
    expect(outcome.appCriteria.filter((criterion) => criterion.status === "FAIL")).toEqual([]);
    expect(outcome.reportRecorded).toBe(true);
    expect(outcome.residualMicroUsd).toBe(95);
    expect(outcome.claimedTotalMicroUsd).toBe(495);
  });

  test("EVERY fake-world knob FAILs a specific boundary criterion (never a silent pass)", async () => {
    const knobToCriterion: readonly { readonly knob: Knobs; readonly criterionId: string }[] = [
      { knob: { attributedsplit: true }, criterionId: "app-attributed-split-read-back" },
      { knob: { foldedresidual: true }, criterionId: "app-residual-read-back" },
      { knob: { gapped: true }, criterionId: "app-generation-series-read-back" },
      {
        knob: { inflatedtotal: true },
        criterionId: "app-attribution-reconciliation-identity-per-generation",
      },
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

  test("verifySavingsAttributionAppContract re-derives every leg over a DIRECT observation (never trusting the platform)", () => {
    const row = rowById("rag-retrieval-all-mechanisms-attributed");
    const declared = declaredSplitTotalsOf(row);
    const generations = [...new Set(row.split.claims.map((claim) => claim.generation))].sort(
      (left, right) => left - right,
    );
    // The honest observation: every leg re-derives PASS at the boundary.
    const honestObservation: AppAttributionObservation = {
      executionId: "exec-1",
      replayed: false,
      rejection: null,
      terminal: "COMPLETED",
      verificationStatuses: ["PASS", "PASS"],
      attributed: declared.attributed,
      residualMicroUsd: declared.residualMicroUsd,
      claimedTotalMicroUsd: declared.attributedTotalMicroUsd + declared.residualMicroUsd,
      perGeneration: generations.map((generation) => {
        const perMechanism = {
          reuse: 0,
          cache: 0,
          competence: 0,
          deterministicization: 0,
        } as Record<"reuse" | "cache" | "competence" | "deterministicization", number>;
        for (const claim of row.split.claims) {
          if (claim.generation === generation) {
            perMechanism[claim.mechanism] += claim.claimedMicroUsd;
          }
        }
        const recordedTotal =
          ragEconomics.recordedTotals.find((total) => total.generation === generation)
            ?.totalMicroUsd ?? 0;
        return {
          generation,
          perMechanism,
          residualMicroUsd:
            row.split.residual.find((claim) => claim.generation === generation)?.residualMicroUsd ??
            0,
          recordedTotalMicroUsd: recordedTotal,
        };
      }),
      refusalReason: null,
      reportRecorded: true,
      observedModelCalls: 0,
      trajectoryDigest: "abcd1234",
    };
    const honest = verifySavingsAttributionAppContract({
      row,
      observation: honestObservation,
    });
    expect(honest.every((criterion) => criterion.status === "PASS")).toBe(true);

    // An inflated split read-back FAILs the split read-back leg.
    const inflatedSplit = verifySavingsAttributionAppContract({
      row,
      observation: {
        ...honestObservation,
        attributed: { ...declared.attributed, cache: declared.attributed.cache + 25 },
      },
    });
    expect(criterionOf(inflatedSplit, "app-attributed-split-read-back")?.status).toBe("FAIL");

    // A folded residual read-back FAILs the residual honesty leg (the
    // residual surfaced as zero, folded into a mechanism).
    const folded = verifySavingsAttributionAppContract({
      row,
      observation: {
        ...honestObservation,
        attributed: { ...declared.attributed, cache: declared.attributed.cache + 95 },
        residualMicroUsd: 0,
      },
    });
    expect(criterionOf(folded, "app-residual-read-back")?.status).toBe("FAIL");

    // A gapped surface FAILs the generation-series read-back leg.
    const gapped = verifySavingsAttributionAppContract({
      row,
      observation: {
        ...honestObservation,
        perGeneration: honestObservation.perGeneration.filter((split) => split.generation !== 2),
      },
    });
    expect(criterionOf(gapped, "app-generation-series-read-back")?.status).toBe("FAIL");
    expect(criterionOf(gapped, "app-generation-series-read-back")?.evidence.join(" ")).toContain(
      "GAPPED-SERIES-READ-BACK",
    );

    // An inflated recorded total FAILs the boundary reconciliation.
    const inflatedTotal = verifySavingsAttributionAppContract({
      row,
      observation: {
        ...honestObservation,
        perGeneration: honestObservation.perGeneration.map((split) => ({
          ...split,
          recordedTotalMicroUsd: split.recordedTotalMicroUsd + 50,
        })),
      },
    });
    expect(
      criterionOf(inflatedTotal, "app-attribution-reconciliation-identity-per-generation")?.status,
    ).toBe("FAIL");

    // An unreported report on an established row FAILs the landing leg.
    const unreported = verifySavingsAttributionAppContract({
      row,
      observation: { ...honestObservation, reportRecorded: false },
    });
    expect(criterionOf(unreported, "app-report-landing")?.status).toBe("FAIL");

    // An over-dispatched run FAILs the own-dispatches leg.
    const overDispatched = verifySavingsAttributionAppContract({
      row,
      observation: { ...honestObservation, observedModelCalls: 2 },
    });
    expect(criterionOf(overDispatched, "app-own-dispatches")?.status).toBe("FAIL");

    // A refusal row's read-back must match its pinned refusal reason.
    const refusalRow = rowById("unrecorded-family-attribution-refusal");
    const refusalObservation: AppAttributionObservation = {
      ...honestObservation,
      attributed: { reuse: 0, cache: 0, competence: 0, deterministicization: 0 },
      residualMicroUsd: 0,
      claimedTotalMicroUsd: 0,
      perGeneration: [],
      refusalReason: "family-unrecorded",
      reportRecorded: false,
    };
    const refusal = verifySavingsAttributionAppContract({
      row: refusalRow,
      observation: refusalObservation,
    });
    expect(refusal.every((criterion) => criterion.status === "PASS")).toBe(true);
    const refusalMismatch = verifySavingsAttributionAppContract({
      row: refusalRow,
      observation: { ...refusalObservation, refusalReason: "no-savings-recorded" },
    });
    expect(criterionOf(refusalMismatch, "app-refusal-read-back")?.status).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// The report ledger exactly-once (append-only)
// ---------------------------------------------------------------------------

describe("VAL-045 discrimination: the report ledger is append-only exactly-once", () => {
  test("the identical re-append REPLAYS; a DIFFERENT report under the same family is REFUSED", async () => {
    const ledger = createAttributionReportLedger();
    const canonical = canonicalSplitOf("rag-retrieval");
    const ragMaturityReport = ragEconomics.maturityReports[0];
    if (ragMaturityReport === undefined) {
      throw new Error("the RAG economics hold no maturity report");
    }
    const reconciliation = deriveAttributionReconciliation({
      recordedTotals: ragEconomics.recordedTotals,
      split: canonical,
    });
    const report = {
      familyId: "rag-retrieval",
      attributed: reconciliation.attributedByMechanism,
      residualMicroUsd: reconciliation.residualTotalMicroUsd,
      claimedTotalMicroUsd:
        reconciliation.attributedTotalMicroUsd + reconciliation.residualTotalMicroUsd,
      claimDigests: canonical.claims.map((claim) => attributionClaimDigestOf(claim)),
      residualDigests: canonical.residual.map((claim) => residualClaimDigestOf(claim)),
      citationDigest: attributionCitationDigestOf(
        canonicalAttributionCitationOf({
          ledgerEntries: ragEconomics.ledgerEntries,
          lifecycleRecords: ragEconomics.lifecycleRecords,
          baselines: ragEconomics.baselines,
          recordedTotals: ragEconomics.recordedTotals,
        }),
      ),
      maturityReportDigest: maturityReportDigestOf(ragMaturityReport),
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
      attributed: { ...report.attributed, cache: report.attributed.cache + 95 },
      residualMicroUsd: 0,
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

describe("VAL-045 discrimination: the honest controls over the fixture stack", () => {
  test("every offline row over the honest stack behaves per its pin", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const stack = createHonestAttributionStack();
      const result: AttributionRunResult = await driveAttributionAnalysis({
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
      if (row.expected.verdict === "attribution-established") {
        expect(result.reportLanded?.accepted, `${row.rowId} report landed`).toBe(true);
        expect(result.citation?.complete, `${row.rowId} citation complete`).toBe(true);
        expect(result.noDoubleCount?.undoubled, `${row.rowId} undoubled`).toBe(true);
        expect(result.residualHonesty?.honest, `${row.rowId} residual honest`).toBe(true);
        expect(result.reconciliation?.reconciled, `${row.rowId} reconciled`).toBe(true);
        expect(result.counterfactual?.faithful, `${row.rowId} counterfactual faithful`).toBe(true);
        expect(result.generationSeries?.integral, `${row.rowId} series integral`).toBe(true);
        expect(result.honesty?.honest, `${row.rowId} honest`).toBe(true);
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
      mutate: (row: AttributionCorpusRow) => AttributionCorpusRow,
    ): Promise<AttributionRunResult> => {
      const row = mutate(rowById(rowId));
      const stack = createHonestAttributionStack();
      return driveAttributionAnalysis({
        row,
        analysis: stack.history,
        reportLedger: stack.reportLedger,
        now: stack.clock.now,
      });
    };

    // uncited-claim: the claim's citations dropped entirely.
    const uncited = await driveVariant("probe-uncited-claim", (row) => {
      const target = row.split.claims[0];
      if (target === undefined) {
        throw new Error("the uncited probe holds no claims");
      }
      return {
        ...row,
        split: {
          ...row.split,
          claims: row.split.claims.map((claim: AttributionClaim) =>
            claim === target
              ? { ...claim, citedLedgerEntryIds: [], citedLifecycleProposalIds: [] }
              : claim,
          ),
        },
      };
    });
    expect(uncited.terminal).toBe("FAILED");
    expect(uncited.verdict).toBe("attribution-invalid");
    expect(criterionOf(uncited.criteria, "attribution-citation-claims-cite-evidence")?.status).toBe(
      "FAIL",
    );
    expect(uncited.citation?.uncitedClaims).toHaveLength(1);

    // double-count: one entry cited by two mechanisms.
    const doubleCount = await driveVariant("probe-double-count", (row) => {
      const victim = row.split.claims[0];
      if (victim === undefined) {
        throw new Error("the double-count probe holds no claims");
      }
      return {
        ...row,
        split: {
          ...row.split,
          claims: [
            ...row.split.claims,
            {
              mechanism: "reuse",
              generation: victim.generation,
              claimedMicroUsd: victim.claimedMicroUsd,
              citedLedgerEntryIds: [...victim.citedLedgerEntryIds],
              citedLifecycleProposalIds: [],
              baselineDigest: victim.baselineDigest,
              baselineBasis: "recorded" as const,
            },
          ],
        },
      };
    });
    expect(doubleCount.terminal).toBe("FAILED");
    expect(doubleCount.verdict).toBe("attribution-invalid");
    expect(criterionOf(doubleCount.criteria, "attribution-no-double-count")?.status).toBe("FAIL");
    expect(doubleCount.noDoubleCount?.doubleCountedEntries).toHaveLength(1);

    // forced-residual: the residual forced into the cache mechanism.
    const forced = await driveVariant("probe-forced-residual", (row) => ({
      ...row,
      split: {
        ...row.split,
        claims: row.split.claims.map((claim) =>
          claim.generation === 1
            ? { ...claim, claimedMicroUsd: claim.claimedMicroUsd + 160 }
            : claim,
        ),
      },
    }));
    expect(forced.terminal).toBe("FAILED");
    expect(forced.verdict).toBe("attribution-invalid");
    expect(criterionOf(forced.criteria, "attribution-residual-never-forced")?.status).toBe("FAIL");
    expect(forced.residualHonesty?.forcedResiduals).toHaveLength(1);

    // swapped-baseline: the claim cites another generation's baseline.
    const swapped = await driveVariant("probe-swapped-baseline", (row) => {
      const generation3Reuse = invoiceEconomics.baselines.find(
        (baseline) => baseline.generation === 3 && baseline.mechanism === "reuse",
      );
      if (generation3Reuse === undefined) {
        throw new Error("the invoice economics hold no g3 reuse baseline");
      }
      return {
        ...row,
        split: {
          ...row.split,
          claims: row.split.claims.map((claim) =>
            claim.generation === 1 && claim.mechanism === "reuse"
              ? { ...claim, baselineDigest: incumbentBaselineDigestOf(generation3Reuse) }
              : claim,
          ),
        },
      };
    });
    expect(swapped.terminal).toBe("FAILED");
    expect(swapped.verdict).toBe("attribution-invalid");
    expect(criterionOf(swapped.criteria, "attribution-baseline-not-swapped")?.status).toBe("FAIL");
    expect(swapped.counterfactual?.infidelities[0]?.shape).toBe("swapped");

    // gapped-series: a generation's claims dropped.
    const gapped = await driveVariant("probe-gapped-series", (row) => ({
      ...row,
      split: {
        ...row.split,
        claims: row.split.claims.filter((claim) => claim.generation !== 2),
      },
    }));
    expect(gapped.terminal).toBe("FAILED");
    expect(gapped.verdict).toBe("attribution-invalid");
    expect(criterionOf(gapped.criteria, "attribution-series-matches-maturity")?.status).toBe(
      "FAIL",
    );
    expect(gapped.generationSeries?.missingGenerations).toEqual([2]);

    // Every adversarial shape withheld its report (nothing lands).
    for (const result of [uncited, doubleCount, forced, swapped, gapped]) {
      expect(result.reportsAppended).toBe(0);
      expect(result.reportLanded).toBeNull();
    }
  });
});
