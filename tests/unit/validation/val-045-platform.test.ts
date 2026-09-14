/**
 * VAL-045 acceptance criteria 1, 2, 4, 5: the savings-attribution
 * platform slice against controlled fakes — the attribution
 * vocabulary (the mechanism / verdict / refusal / probe vocabularies;
 * the unattributed-residual sentinel; the counterfactual bases), the
 * PURE derivations that make an attribution claim trustworthy (the
 * evidence-citation matrix — a full-population pass and each phantom
 * / uncited / partial-population / empty-basis shape FAILing with the
 * member named; the no-double-count matrix — each shape FAILing with
 * BOTH claims named; the residual-honesty matrix — forced / hidden /
 * inflated / under-attributed shapes FAILing with both sides named
 * while the honest large residual passes; the reconciliation matrix —
 * the identity holding per generation while each non-reconciling
 * shape FAILs with both sides named; the counterfactual matrix — the
 * recorded baseline passing while the unstated / swapped /
 * hypothetical / mismatched-number shapes FAIL named; the
 * generation-series matrix — matching VAL-036's curves passing while
 * the gapped / mismatched / empty shapes FAIL; the honesty matrix —
 * measured baselines passing while the estimated-baseline and
 * fabricated-usage shapes FAIL), the refusal honesty, the digest
 * discipline (deterministic, canonical, payload-free), the
 * append-only report ledger, the driver over every offline corpus
 * row, and the ADVERSARIAL worlds (the GAPPED / SWAPPED-BASELINE /
 * UNRECONCILED / MUTATING economics variants).
 */

import { describe, expect, test } from "vitest";
import {
  declaredSplitTotalsOf,
  familyEconomicsById,
  OFFLINE_CORPUS_ROWS,
} from "../../../benchmarks/validation/apps/savings-attribution/corpus";
import {
  createAttributionHistoryPort,
  createAttributionReportLedger,
  createHonestAttributionStack,
  type FakeEconomicsVariant,
} from "../../../benchmarks/validation/apps/savings-attribution/fixtures";
import type { LabUsage } from "../../../benchmarks/validation/platform/derive";
import type {
  AttributionClaim,
  AttributionCorpusRow,
  FamilyAttributionSplit,
} from "../../../benchmarks/validation/platform/savings-attribution";
import {
  ATTRIBUTION_EXPERIMENT_KIND,
  ATTRIBUTION_LEARNING_PHASE,
  ATTRIBUTION_MECHANISMS,
  ATTRIBUTION_PROBE_KINDS,
  ATTRIBUTION_REFUSAL_REASONS,
  ATTRIBUTION_VERDICTS,
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
  deriveAttributionRowCriteria,
  deriveAttributionVerdictKind,
  deriveCounterfactualFidelity,
  deriveGenerationSeriesIntegrity,
  deriveNoDoubleCount,
  deriveResidualHonesty,
  driveAttributionAnalysis,
  incumbentBaselineDigestOf,
  isAttributionProbeKind,
  isAttributionRefusalReason,
  isAttributionVerdictKind,
  isCounterfactualBasis,
  recordedCounterfactualOf,
  recordedSavingsTotalDigestOf,
  residualClaimDigestOf,
  savingsAttributionReportDigestOf,
  UNATTRIBUTED_RESIDUAL,
  verifySavingsAttributionAppContract,
} from "../../../benchmarks/validation/platform/savings-attribution";

const ragEconomics = familyEconomicsById("rag-retrieval");
const largeResidualEconomics = familyEconomicsById("text-summarization");
const cacheDominantEconomics = familyEconomicsById("code-search");
const reuseDominantEconomics = familyEconomicsById("invoice-extraction");
const detDominantEconomics = familyEconomicsById("translation-glossary");
if (
  ragEconomics === null ||
  largeResidualEconomics === null ||
  cacheDominantEconomics === null ||
  reuseDominantEconomics === null ||
  detDominantEconomics === null
) {
  throw new Error("the pinned family economics are incomplete");
}

const rowById = (rowId: string): AttributionCorpusRow => {
  const row = OFFLINE_CORPUS_ROWS.find((candidate) => candidate.rowId === rowId);
  if (row === undefined) {
    throw new Error(`no offline corpus row ${rowId}`);
  }
  return row;
};

/** The honest split over the RAG family's pinned economics. */
const ragSplit: FamilyAttributionSplit = canonicalAttributionSplitOf({
  familyId: "rag-retrieval",
  ledgerEntries: ragEconomics.ledgerEntries,
  lifecycleRecords: ragEconomics.lifecycleRecords,
  baselines: ragEconomics.baselines,
  recordedTotals: ragEconomics.recordedTotals,
});

/** The honest split over the large-residual family's economics. */
const largeResidualSplit: FamilyAttributionSplit = canonicalAttributionSplitOf({
  familyId: "text-summarization",
  ledgerEntries: largeResidualEconomics.ledgerEntries,
  lifecycleRecords: largeResidualEconomics.lifecycleRecords,
  baselines: largeResidualEconomics.baselines,
  recordedTotals: largeResidualEconomics.recordedTotals,
});

/** Mutate one claim of a split (PURE builder for the adversarial shapes). */
function withClaim(
  split: FamilyAttributionSplit,
  mechanism: AttributionClaim["mechanism"],
  generation: number,
  mutate: (claim: AttributionClaim) => AttributionClaim,
): FamilyAttributionSplit {
  return {
    ...split,
    claims: split.claims.map((claim) =>
      claim.mechanism === mechanism && claim.generation === generation ? mutate(claim) : claim,
    ),
  };
}

describe("VAL-045 platform vocabulary pins", () => {
  test("the learning phase + experiment kind are pinned", () => {
    expect(ATTRIBUTION_LEARNING_PHASE).toBe("attribution");
    expect(ATTRIBUTION_EXPERIMENT_KIND).toBe("savings-attribution");
  });

  test("the attribution mechanisms are the CANDIDATE_KINDS four + the residual sentinel (guarded)", () => {
    expect([...ATTRIBUTION_MECHANISMS]).toEqual([
      "reuse",
      "cache",
      "competence",
      "deterministicization",
    ]);
    expect(UNATTRIBUTED_RESIDUAL).toBe("residual");
  });

  test("the verdict / refusal / probe vocabularies are pinned (guarded)", () => {
    expect([...ATTRIBUTION_VERDICTS]).toEqual([
      "attribution-established",
      "no-evidence-honest",
      "attribution-invalid",
    ]);
    for (const verdict of ATTRIBUTION_VERDICTS) {
      expect(isAttributionVerdictKind(verdict)).toBe(true);
    }
    expect([...ATTRIBUTION_REFUSAL_REASONS]).toEqual(["family-unrecorded", "no-savings-recorded"]);
    for (const reason of ATTRIBUTION_REFUSAL_REASONS) {
      expect(isAttributionRefusalReason(reason)).toBe(true);
    }
    expect([...ATTRIBUTION_PROBE_KINDS]).toEqual([
      "uncited-claim",
      "double-count",
      "forced-residual",
      "swapped-baseline",
      "gapped-series",
    ]);
    for (const probe of ATTRIBUTION_PROBE_KINDS) {
      expect(isAttributionProbeKind(probe)).toBe(true);
    }
    expect(isAttributionProbeKind("inflated-total")).toBe(false);
  });

  test("the counterfactual bases: recorded is the only admissible basis (guarded)", () => {
    expect(isCounterfactualBasis("recorded")).toBe(true);
    expect(isCounterfactualBasis("hypothetical")).toBe(true);
    expect(isCounterfactualBasis("estimated")).toBe(false);
  });

  test("the corpus covers every honest split shape + every probe + both refusals over 12 offline rows", () => {
    expect(OFFLINE_CORPUS_ROWS).toHaveLength(12);
    const probes = new Set(
      OFFLINE_CORPUS_ROWS.filter((row) => row.probe !== undefined).map((row) => row.probe?.kind),
    );
    expect(probes.size).toBe(ATTRIBUTION_PROBE_KINDS.length);
    const refusals = OFFLINE_CORPUS_ROWS.filter((row) => row.expected.refusalReason !== null);
    expect(refusals.map((row) => row.expected.refusalReason).sort()).toEqual([
      "family-unrecorded",
      "no-savings-recorded",
    ]);
    // The honest split shapes: all-four-mechanisms, large residual,
    // cache-dominant, reuse-dominant, deterministicization-dominant.
    const allMechanisms = declaredSplitTotalsOf(rowById("rag-retrieval-all-mechanisms-attributed"));
    expect(ATTRIBUTION_MECHANISMS.every((kind) => (allMechanisms.attributed[kind] ?? 0) > 0)).toBe(
      true,
    );
    expect(allMechanisms.residualMicroUsd).toBeGreaterThan(0);
    const largeResidual = declaredSplitTotalsOf(
      rowById("text-summarization-large-honest-residual"),
    );
    expect(largeResidual.residualMicroUsd).toBeGreaterThan(
      largeResidual.attributedTotalMicroUsd * 2,
    );
    const cacheDominant = declaredSplitTotalsOf(rowById("code-search-cache-dominant"));
    expect(cacheDominant.attributed.cache).toBeGreaterThan(
      cacheDominant.attributedTotalMicroUsd * 0.8,
    );
    const reuseDominant = declaredSplitTotalsOf(rowById("invoice-extraction-reuse-dominant"));
    expect(reuseDominant.attributed.reuse).toBeGreaterThan(
      reuseDominant.attributedTotalMicroUsd * 0.8,
    );
    const detDominant = declaredSplitTotalsOf(
      rowById("translation-glossary-deterministicization-dominant"),
    );
    expect(detDominant.attributed.deterministicization).toBeGreaterThan(
      detDominant.attributedTotalMicroUsd * 0.8,
    );
  });
});

describe("VAL-045 evidence-citation matrix", () => {
  test("the canonical full-population citation PASSES over the RAG family", () => {
    const verdict = deriveAttributionEvidenceCitation({
      lifecycleRecords: ragEconomics.lifecycleRecords,
      generations: ragEconomics.generations,
      ledgerEntries: ragEconomics.ledgerEntries,
      baselines: ragEconomics.baselines,
      recordedTotals: ragEconomics.recordedTotals,
      split: ragSplit,
    });
    expect(verdict.complete).toBe(true);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("an UNCITED claim (a nonzero claim with no citations) FAILs naming the claim", () => {
    const split = withClaim(ragSplit, "cache", 2, (claim) => ({
      ...claim,
      citedLedgerEntryIds: [],
      citedLifecycleProposalIds: [],
    }));
    const verdict = deriveAttributionEvidenceCitation({
      lifecycleRecords: ragEconomics.lifecycleRecords,
      generations: ragEconomics.generations,
      ledgerEntries: ragEconomics.ledgerEntries,
      baselines: ragEconomics.baselines,
      recordedTotals: ragEconomics.recordedTotals,
      split,
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.uncitedClaims).toEqual([{ mechanism: "cache", generation: 2 }]);
    expect(
      verdict.criteria.find(
        (criterion) => criterion.criterionId === "attribution-citation-claims-cite-evidence",
      )?.status,
    ).toBe("FAIL");
  });

  test("a PARTIAL population (a dropped ledger entry citation) FAILs naming the missed entry", () => {
    const dropped = ragEconomics.ledgerEntries[0]?.entryId ?? "";
    const split = withClaim(ragSplit, "deterministicization", 1, (claim) => ({
      ...claim,
      citedLedgerEntryIds: [],
    }));
    const verdict = deriveAttributionEvidenceCitation({
      lifecycleRecords: ragEconomics.lifecycleRecords,
      generations: ragEconomics.generations,
      ledgerEntries: ragEconomics.ledgerEntries,
      baselines: ragEconomics.baselines,
      recordedTotals: ragEconomics.recordedTotals,
      split,
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.uncitedLedgerEntryIds).toEqual([dropped]);
    expect(
      verdict.criteria.find(
        (criterion) => criterion.criterionId === "attribution-citation-full-population",
      )?.status,
    ).toBe("FAIL");
  });

  test("a PHANTOM citation (a cited entry not in the population) FAILs naming it", () => {
    const split = withClaim(ragSplit, "cache", 2, (claim) => ({
      ...claim,
      citedLedgerEntryIds: [...claim.citedLedgerEntryIds, "led-fabricated-entry"],
    }));
    const verdict = deriveAttributionEvidenceCitation({
      lifecycleRecords: ragEconomics.lifecycleRecords,
      generations: ragEconomics.generations,
      ledgerEntries: ragEconomics.ledgerEntries,
      baselines: ragEconomics.baselines,
      recordedTotals: ragEconomics.recordedTotals,
      split,
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.phantomLedgerEntryIds).toEqual(["led-fabricated-entry"]);
    expect(
      verdict.criteria.find(
        (criterion) => criterion.criterionId === "attribution-citation-no-phantom-members",
      )?.status,
    ).toBe("FAIL");
  });

  test("a PHANTOM lifecycle citation FAILs naming it", () => {
    const split = withClaim(ragSplit, "reuse", 1, (claim) => ({
      ...claim,
      citedLifecycleProposalIds: [...claim.citedLifecycleProposalIds, "cand-fabricated-proposal"],
    }));
    const verdict = deriveAttributionEvidenceCitation({
      lifecycleRecords: ragEconomics.lifecycleRecords,
      generations: ragEconomics.generations,
      ledgerEntries: ragEconomics.ledgerEntries,
      baselines: ragEconomics.baselines,
      recordedTotals: ragEconomics.recordedTotals,
      split,
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.phantomLifecycleProposalIds).toEqual(["cand-fabricated-proposal"]);
  });

  test("an EMPTY basis (no recorded generations) FAILs the minimum evidence", () => {
    const verdict = deriveAttributionEvidenceCitation({
      lifecycleRecords: [],
      generations: [],
      ledgerEntries: [],
      baselines: [],
      recordedTotals: [],
      split: { claims: [], residual: [] },
    });
    expect(verdict.minimumEvidence).toBe(false);
    expect(verdict.complete).toBe(false);
  });

  test("a canonical citation digest is carried on the verdict (the full population's fingerprint)", () => {
    const canonical = canonicalAttributionCitationOf({
      ledgerEntries: ragEconomics.ledgerEntries,
      lifecycleRecords: ragEconomics.lifecycleRecords,
      baselines: ragEconomics.baselines,
      recordedTotals: ragEconomics.recordedTotals,
    });
    const verdict = deriveAttributionEvidenceCitation({
      lifecycleRecords: ragEconomics.lifecycleRecords,
      generations: ragEconomics.generations,
      ledgerEntries: ragEconomics.ledgerEntries,
      baselines: ragEconomics.baselines,
      recordedTotals: ragEconomics.recordedTotals,
      split: ragSplit,
    });
    expect(verdict.citationDigest).toBe(attributionCitationDigestOf(canonical));
  });
});

describe("VAL-045 no-double-count matrix", () => {
  test("the canonical split attributes each entry to exactly ONE mechanism", () => {
    const verdict = deriveNoDoubleCount({ split: ragSplit });
    expect(verdict.undoubled).toBe(true);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("a DOUBLE-COUNT (one entry cited by two claims) FAILs with BOTH claims named", () => {
    const sharedEntry = ragEconomics.ledgerEntries.find(
      (entry) => entry.generation === 2 && entry.mechanism === "cache",
    );
    if (sharedEntry === undefined) {
      throw new Error("no cache g2 entry");
    }
    const split = withClaim(ragSplit, "deterministicization", 2, (claim) => ({
      ...claim,
      citedLedgerEntryIds: [...claim.citedLedgerEntryIds, sharedEntry.entryId],
    }));
    const verdict = deriveNoDoubleCount({ split });
    expect(verdict.undoubled).toBe(false);
    expect(verdict.doubleCountedEntries).toHaveLength(1);
    const doubleCounted = verdict.doubleCountedEntries[0];
    expect(doubleCounted?.entryId).toBe(sharedEntry.entryId);
    expect(doubleCounted?.firstMechanism).toBe("cache");
    expect(doubleCounted?.secondMechanism).toBe("deterministicization");
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "attribution-no-double-count")
        ?.status,
    ).toBe("FAIL");
    expect(
      verdict.criteria
        .find((criterion) => criterion.criterionId === "attribution-no-double-count")
        ?.evidence.join(" "),
    ).toContain("cache+deterministicization");
  });

  test("a SELF-DOUBLE-CITE (one claim citing an entry twice) FAILs naming the claim", () => {
    const split = withClaim(ragSplit, "reuse", 1, (claim) => ({
      ...claim,
      citedLedgerEntryIds: [...claim.citedLedgerEntryIds, ...claim.citedLedgerEntryIds],
    }));
    const verdict = deriveNoDoubleCount({ split });
    expect(verdict.undoubled).toBe(false);
    expect(verdict.selfDoubleCitingClaims).toEqual([{ mechanism: "reuse", generation: 1 }]);
  });

  test("the double-count also breaks the residual honesty (the number exceeds its evidence)", () => {
    const sharedEntry = ragEconomics.ledgerEntries.find(
      (entry) => entry.generation === 2 && entry.mechanism === "cache",
    );
    if (sharedEntry === undefined) {
      throw new Error("no cache g2 entry");
    }
    const split = withClaim(ragSplit, "deterministicization", 2, (claim) => ({
      ...claim,
      citedLedgerEntryIds: [...claim.citedLedgerEntryIds, sharedEntry.entryId],
    }));
    const residual = deriveResidualHonesty({
      ledgerEntries: ragEconomics.ledgerEntries,
      recordedTotals: ragEconomics.recordedTotals,
      split,
    });
    // The deterministicization g2 claim cites both its own entry and
    // the cache entry: its claimed number (40) is BELOW the cited
    // evidence (40 + 100) — the under-attribution leg catches the
    // inflated evidence population.
    expect(residual.honest).toBe(false);
    expect(residual.underAttributions).toHaveLength(1);
  });
});

describe("VAL-045 residual-honesty matrix", () => {
  test("the honest large residual PASSES (reported, never forced)", () => {
    const verdict = deriveResidualHonesty({
      ledgerEntries: largeResidualEconomics.ledgerEntries,
      recordedTotals: largeResidualEconomics.recordedTotals,
      split: largeResidualSplit,
    });
    expect(verdict.honest).toBe(true);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
    const declared = declaredSplitTotalsOf(rowById("text-summarization-large-honest-residual"));
    expect(declared.residualMicroUsd).toBe(320);
  });

  test("a FORCED RESIDUAL (a claim exceeding its cited evidence) FAILs with the mechanism and excess named", () => {
    const split = withClaim(largeResidualSplit, "cache", 1, (claim) => ({
      ...claim,
      claimedMicroUsd: claim.claimedMicroUsd + 160,
    }));
    const verdict = deriveResidualHonesty({
      ledgerEntries: largeResidualEconomics.ledgerEntries,
      recordedTotals: largeResidualEconomics.recordedTotals,
      split,
    });
    expect(verdict.honest).toBe(false);
    expect(verdict.forcedResiduals).toEqual([
      {
        mechanism: "cache",
        generation: 1,
        claimedMicroUsd: 200,
        citedEvidenceMicroUsd: 40,
      },
    ]);
    expect(
      verdict.criteria.find(
        (criterion) => criterion.criterionId === "attribution-residual-never-forced",
      )?.status,
    ).toBe("FAIL");
  });

  test("a claim with NO citations and a nonzero number FAILs as a forced residual", () => {
    const split = withClaim(largeResidualSplit, "cache", 2, (claim) => ({
      ...claim,
      citedLedgerEntryIds: [],
      citedLifecycleProposalIds: [],
      claimedMicroUsd: 160,
    }));
    const verdict = deriveResidualHonesty({
      ledgerEntries: largeResidualEconomics.ledgerEntries,
      recordedTotals: largeResidualEconomics.recordedTotals,
      split,
    });
    expect(verdict.forcedResiduals).toEqual([
      { mechanism: "cache", generation: 2, claimedMicroUsd: 160, citedEvidenceMicroUsd: 0 },
    ]);
  });

  test("an UNDER-attribution (a claim below its evidence) FAILs with both sides named", () => {
    const split = withClaim(ragSplit, "reuse", 1, (claim) => ({
      ...claim,
      claimedMicroUsd: claim.claimedMicroUsd - 10,
    }));
    const verdict = deriveResidualHonesty({
      ledgerEntries: ragEconomics.ledgerEntries,
      recordedTotals: ragEconomics.recordedTotals,
      split,
    });
    expect(verdict.honest).toBe(false);
    expect(verdict.underAttributions).toEqual([
      { mechanism: "reuse", generation: 1, claimedMicroUsd: 20, citedEvidenceMicroUsd: 30 },
    ]);
  });

  test("a HIDDEN residual (an existing residual not reported) FAILs naming the generation", () => {
    const split: FamilyAttributionSplit = {
      claims: largeResidualSplit.claims,
      residual: largeResidualSplit.residual.map((claim) =>
        claim.generation === 1 ? { ...claim, reported: false } : claim,
      ),
    };
    const verdict = deriveResidualHonesty({
      ledgerEntries: largeResidualEconomics.ledgerEntries,
      recordedTotals: largeResidualEconomics.recordedTotals,
      split,
    });
    expect(verdict.honest).toBe(false);
    expect(verdict.hiddenResidualGenerations).toEqual([1]);
  });

  test("an INFLATED residual FAILs with both sides named", () => {
    const split: FamilyAttributionSplit = {
      claims: largeResidualSplit.claims,
      residual: largeResidualSplit.residual.map((claim) =>
        claim.generation === 1
          ? { ...claim, residualMicroUsd: claim.residualMicroUsd + 55 }
          : claim,
      ),
    };
    const verdict = deriveResidualHonesty({
      ledgerEntries: largeResidualEconomics.ledgerEntries,
      recordedTotals: largeResidualEconomics.recordedTotals,
      split,
    });
    expect(verdict.honest).toBe(false);
    expect(verdict.mismatchedResidualGenerations).toEqual([
      { generation: 1, reportedResidualMicroUsd: 215, recordedResidualMicroUsd: 160 },
    ]);
  });
});

describe("VAL-045 reconciliation matrix", () => {
  test("the identity HOLDS per generation and per family over the canonical splits", () => {
    for (const economics of [
      ragEconomics,
      largeResidualEconomics,
      cacheDominantEconomics,
      reuseDominantEconomics,
      detDominantEconomics,
    ]) {
      const split = canonicalAttributionSplitOf({
        familyId: economics.familyId,
        ledgerEntries: economics.ledgerEntries,
        lifecycleRecords: economics.lifecycleRecords,
        baselines: economics.baselines,
        recordedTotals: economics.recordedTotals,
      });
      const verdict = deriveAttributionReconciliation({
        recordedTotals: economics.recordedTotals,
        split,
      });
      expect(verdict.reconciled, economics.familyId).toBe(true);
      expect(verdict.attributedTotalMicroUsd + verdict.residualTotalMicroUsd).toBe(
        verdict.recordedTotalMicroUsd,
      );
      expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
    }
  });

  test("a non-reconciling generation FAILs with BOTH sides named", () => {
    const split = withClaim(ragSplit, "reuse", 1, (claim) => ({
      ...claim,
      claimedMicroUsd: claim.claimedMicroUsd + 10,
    }));
    const verdict = deriveAttributionReconciliation({
      recordedTotals: ragEconomics.recordedTotals,
      split,
    });
    expect(verdict.reconciled).toBe(false);
    expect(verdict.mismatchedGenerations).toEqual([
      {
        generation: 1,
        attributedPlusResidualMicroUsd: 190,
        recordedTotalMicroUsd: 180,
      },
    ]);
    expect(
      verdict.criteria.find(
        (criterion) =>
          criterion.criterionId === "attribution-reconciliation-identity-per-generation",
      )?.status,
    ).toBe("FAIL");
  });

  test("the family-total identity FAILs when the residual is dropped (both sides named)", () => {
    const split: FamilyAttributionSplit = {
      claims: ragSplit.claims,
      residual: ragSplit.residual.map((claim) => ({ ...claim, residualMicroUsd: 0 })),
    };
    const verdict = deriveAttributionReconciliation({
      recordedTotals: ragEconomics.recordedTotals,
      split,
    });
    expect(verdict.reconciled).toBe(false);
    expect(verdict.attributedTotalMicroUsd).toBe(400);
    expect(verdict.residualTotalMicroUsd).toBe(0);
    expect(verdict.recordedTotalMicroUsd).toBe(495);
    expect(
      verdict.criteria.find(
        (criterion) => criterion.criterionId === "attribution-reconciliation-identity-family-total",
      )?.status,
    ).toBe("FAIL");
  });

  test("NO recorded basis (no recorded totals) FAILs the identity's basis", () => {
    const verdict = deriveAttributionReconciliation({
      recordedTotals: [],
      split: { claims: [], residual: [] },
    });
    expect(verdict.reconciled).toBe(false);
    expect(
      verdict.criteria.find(
        (criterion) => criterion.criterionId === "attribution-reconciliation-recorded-basis",
      )?.status,
    ).toBe("FAIL");
  });

  test("the per-mechanism attributed totals are derived separately over the vocabulary", () => {
    const verdict = deriveAttributionReconciliation({
      recordedTotals: ragEconomics.recordedTotals,
      split: ragSplit,
    });
    expect(verdict.attributedByMechanism).toEqual({
      reuse: 80,
      cache: 100,
      competence: 60,
      deterministicization: 160,
    });
  });
});

describe("VAL-045 counterfactual matrix", () => {
  test("the canonical split measures every claim against its OWN recorded baseline", () => {
    const verdict = deriveCounterfactualFidelity({
      baselines: ragEconomics.baselines,
      split: ragSplit,
    });
    expect(verdict.faithful).toBe(true);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("an UNSTATED baseline (no digest cited) FAILs naming the claim", () => {
    const split = withClaim(ragSplit, "cache", 2, (claim) => ({
      ...claim,
      baselineDigest: "",
    }));
    const verdict = deriveCounterfactualFidelity({
      baselines: ragEconomics.baselines,
      split,
    });
    expect(verdict.faithful).toBe(false);
    expect(verdict.infidelities).toHaveLength(1);
    expect(verdict.infidelities[0]?.shape).toBe("unstated");
    expect(verdict.infidelities[0]?.mechanism).toBe("cache");
    expect(verdict.infidelities[0]?.generation).toBe(2);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "attribution-baseline-stated")
        ?.status,
    ).toBe("FAIL");
  });

  test("a SWAPPED baseline (another generation's recorded baseline) FAILs with BOTH sides named", () => {
    const swappedBaseline = ragEconomics.baselines.find(
      (baseline) => baseline.generation === 3 && baseline.mechanism === "reuse",
    );
    if (swappedBaseline === undefined) {
      throw new Error("no reuse g3 baseline");
    }
    const split = withClaim(ragSplit, "reuse", 1, (claim) => ({
      ...claim,
      baselineDigest: incumbentBaselineDigestOf(swappedBaseline),
    }));
    const verdict = deriveCounterfactualFidelity({
      baselines: ragEconomics.baselines,
      split,
    });
    expect(verdict.faithful).toBe(false);
    expect(verdict.infidelities[0]?.shape).toBe("swapped");
    expect(verdict.infidelities[0]?.citedBaselineDigest).toBe(
      incumbentBaselineDigestOf(swappedBaseline),
    );
    expect(verdict.infidelities[0]?.recordedBaselineDigest).toBe(
      incumbentBaselineDigestOf(
        ragEconomics.baselines.find(
          (baseline) => baseline.generation === 1 && baseline.mechanism === "reuse",
        ) ?? {
          familyId: "none",
          generation: 0,
          mechanism: "reuse",
          incumbentAdjustedCostMicroUsd: 0,
          replacementAdjustedCostMicroUsd: 0,
          measured: true,
        },
      ),
    );
    expect(
      verdict.criteria.find(
        (criterion) => criterion.criterionId === "attribution-baseline-not-swapped",
      )?.status,
    ).toBe("FAIL");
  });

  test("a HYPOTHETICAL baseline (a digest no recorded baseline holds) FAILs named", () => {
    const split = withClaim(ragSplit, "competence", 3, (claim) => ({
      ...claim,
      baselineDigest: "deadbeef",
    }));
    const verdict = deriveCounterfactualFidelity({
      baselines: ragEconomics.baselines,
      split,
    });
    expect(verdict.faithful).toBe(false);
    expect(verdict.infidelities[0]?.shape).toBe("hypothetical");
    expect(
      verdict.criteria.find(
        (criterion) => criterion.criterionId === "attribution-baseline-recorded",
      )?.status,
    ).toBe("FAIL");
  });

  test("a hypothetical BASIS (basis !== recorded) FAILs named even with the right digest", () => {
    const split = withClaim(ragSplit, "cache", 2, (claim) => ({
      ...claim,
      baselineBasis: "hypothetical" as const,
    }));
    const verdict = deriveCounterfactualFidelity({
      baselines: ragEconomics.baselines,
      split,
    });
    expect(verdict.faithful).toBe(false);
    expect(verdict.infidelities[0]?.shape).toBe("hypothetical");
  });

  test("a number that does not equal the recorded counterfactual FAILs with both sides named", () => {
    const split = withClaim(ragSplit, "deterministicization", 1, (claim) => ({
      ...claim,
      claimedMicroUsd: claim.claimedMicroUsd + 5,
      citedLedgerEntryIds: claim.citedLedgerEntryIds,
    }));
    const verdict = deriveCounterfactualFidelity({
      baselines: ragEconomics.baselines,
      split,
    });
    expect(verdict.faithful).toBe(false);
    expect(verdict.infidelities[0]?.shape).toBe("counterfactual-mismatch");
    expect(verdict.infidelities[0]?.claimedMicroUsd).toBe(125);
    expect(verdict.infidelities[0]?.recordedCounterfactualMicroUsd).toBe(120);
  });

  test("the recorded counterfactual is the incumbent minus the replacement (VAL-044's model)", () => {
    const baseline = ragEconomics.baselines[0];
    if (baseline === undefined) {
      throw new Error("no baseline");
    }
    expect(recordedCounterfactualOf(baseline)).toBe(
      baseline.incumbentAdjustedCostMicroUsd - baseline.replacementAdjustedCostMicroUsd,
    );
    // Every pinned entry's number EQUALS its baseline's counterfactual.
    for (const entry of ragEconomics.ledgerEntries) {
      const baselineFor = ragEconomics.baselines.find(
        (candidate) =>
          candidate.generation === entry.generation && candidate.mechanism === entry.mechanism,
      );
      expect(baselineFor === undefined ? 0 : recordedCounterfactualOf(baselineFor)).toBe(
        entry.microUsd,
      );
    }
  });
});

describe("VAL-045 generation-series matrix", () => {
  test("a series matching VAL-036's recorded generations PASSES", () => {
    const verdict = deriveGenerationSeriesIntegrity({
      recordedGenerations: detDominantEconomics.generations,
      split: canonicalAttributionSplitOf({
        familyId: "translation-glossary",
        ledgerEntries: detDominantEconomics.ledgerEntries,
        lifecycleRecords: detDominantEconomics.lifecycleRecords,
        baselines: detDominantEconomics.baselines,
        recordedTotals: detDominantEconomics.recordedTotals,
      }),
    });
    expect(verdict.integral).toBe(true);
    expect(verdict.seriesGenerations).toEqual([1, 2, 3]);
    expect(verdict.maturityGenerations).toEqual([1, 2, 3]);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("a GAPPED series (a recorded generation the attribution missed) FAILs naming it", () => {
    const split: FamilyAttributionSplit = {
      claims: ragSplit.claims.filter((claim) => claim.generation !== 2),
      residual: ragSplit.residual,
    };
    const verdict = deriveGenerationSeriesIntegrity({
      recordedGenerations: ragEconomics.generations,
      split,
    });
    expect(verdict.integral).toBe(false);
    expect(verdict.missingGenerations).toEqual([2]);
    expect(
      verdict.criteria.find(
        (criterion) => criterion.criterionId === "attribution-series-matches-maturity",
      )?.status,
    ).toBe("FAIL");
  });

  test("a MISMATCHED series (a generation the maturity curves do not hold) FAILs naming it", () => {
    const fabricatedClaim: AttributionClaim = {
      mechanism: "reuse",
      generation: 7,
      claimedMicroUsd: 0,
      citedLedgerEntryIds: [],
      citedLifecycleProposalIds: [],
      baselineDigest: "",
      baselineBasis: "recorded",
    };
    const verdict = deriveGenerationSeriesIntegrity({
      recordedGenerations: ragEconomics.generations,
      split: { claims: [...ragSplit.claims, fabricatedClaim], residual: ragSplit.residual },
    });
    expect(verdict.integral).toBe(false);
    expect(verdict.unrecordedGenerations).toEqual([7]);
    expect(
      verdict.criteria.find(
        (criterion) => criterion.criterionId === "attribution-series-no-fabricated-generations",
      )?.status,
    ).toBe("FAIL");
  });

  test("an EMPTY series FAILs the minimum", () => {
    const verdict = deriveGenerationSeriesIntegrity({
      recordedGenerations: ragEconomics.generations,
      split: { claims: [], residual: [] },
    });
    expect(verdict.integral).toBe(false);
    expect(verdict.minimumSeries).toBe(false);
  });
});

describe("VAL-045 honesty matrix", () => {
  test("a fully measured offline analysis with none-reported usage is HONEST", () => {
    const verdict = deriveAttributionHonesty({
      baselines: ragEconomics.baselines,
      reportedUsage: null,
      liveRail: false,
    });
    expect(verdict.honest).toBe(true);
    expect(verdict.noneReportedUsageHonest).toBe(true);
  });

  test("an ESTIMATED baseline FAILs named (by mechanism + generation)", () => {
    const withEstimated = ragEconomics.baselines.map((baseline) =>
      baseline.generation === 2 && baseline.mechanism === "cache"
        ? { ...baseline, measured: false }
        : baseline,
    );
    const verdict = deriveAttributionHonesty({
      baselines: withEstimated,
      reportedUsage: null,
      liveRail: false,
    });
    expect(verdict.honest).toBe(false);
    expect(verdict.estimatedBaselines).toEqual([{ mechanism: "cache", generation: 2 }]);
    expect(
      verdict.criteria.find(
        (criterion) => criterion.criterionId === "attribution-honesty-baselines-measured",
      )?.status,
    ).toBe("FAIL");
  });

  test("a FABRICATED offline usage FAILs (usage is none-reported offline, measured only live)", () => {
    const fabricatedUsage: LabUsage = { inputTokens: 10, outputTokens: 2 };
    const verdict = deriveAttributionHonesty({
      baselines: ragEconomics.baselines,
      reportedUsage: fabricatedUsage,
      liveRail: false,
    });
    expect(verdict.honest).toBe(false);
    expect(verdict.fabricatedUsage).toBe(true);
  });

  test("a MEASURED live usage is honest on the live rail", () => {
    const verdict = deriveAttributionHonesty({
      baselines: ragEconomics.baselines,
      reportedUsage: { inputTokens: 30, outputTokens: 6 },
      liveRail: true,
    });
    expect(verdict.honest).toBe(true);
    expect(verdict.noneReportedUsageHonest).toBe(true);
  });
});

describe("VAL-045 refusal honesty + verdict derivation", () => {
  test("both honest refusal reasons match their own recorded states", () => {
    expect(
      deriveAttributionRefusalHonesty({
        refusal: { reason: "family-unrecorded" },
        lifecycleRecordCount: 0,
        generationCount: 0,
        ledgerEntryCount: 0,
        recordedTotalCount: 0,
      }).honest,
    ).toBe(true);
    expect(
      deriveAttributionRefusalHonesty({
        refusal: { reason: "no-savings-recorded" },
        lifecycleRecordCount: 1,
        generationCount: 2,
        ledgerEntryCount: 0,
        recordedTotalCount: 0,
      }).honest,
    ).toBe(true);
  });

  test("a refusal the recorded state does not justify FAILs (dishonest)", () => {
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
        lifecycleRecordCount: 0,
        generationCount: 0,
        ledgerEntryCount: 0,
        recordedTotalCount: 0,
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
  });

  test("the verdict derivation: trustworthy legs establish; a FAILing leg invalidates", () => {
    const citation = deriveAttributionEvidenceCitation({
      lifecycleRecords: ragEconomics.lifecycleRecords,
      generations: ragEconomics.generations,
      ledgerEntries: ragEconomics.ledgerEntries,
      baselines: ragEconomics.baselines,
      recordedTotals: ragEconomics.recordedTotals,
      split: ragSplit,
    });
    const noDoubleCount = deriveNoDoubleCount({ split: ragSplit });
    const residualHonesty = deriveResidualHonesty({
      ledgerEntries: ragEconomics.ledgerEntries,
      recordedTotals: ragEconomics.recordedTotals,
      split: ragSplit,
    });
    const reconciliation = deriveAttributionReconciliation({
      recordedTotals: ragEconomics.recordedTotals,
      split: ragSplit,
    });
    const counterfactual = deriveCounterfactualFidelity({
      baselines: ragEconomics.baselines,
      split: ragSplit,
    });
    const generationSeries = deriveGenerationSeriesIntegrity({
      recordedGenerations: ragEconomics.generations,
      split: ragSplit,
    });
    const honesty = deriveAttributionHonesty({
      baselines: ragEconomics.baselines,
      reportedUsage: null,
      liveRail: false,
    });
    const base = {
      refusal: null,
      refusalHonesty: null,
      citation,
      noDoubleCount,
      residualHonesty,
      reconciliation,
      counterfactual,
      generationSeries,
      honesty,
      inputUnchanged: true,
      failure: null,
    };
    expect(deriveAttributionVerdictKind(base)).toBe("attribution-established");
    expect(
      deriveAttributionVerdictKind({
        ...base,
        counterfactual: { ...counterfactual, faithful: false },
      }),
    ).toBe("attribution-invalid");
    expect(
      deriveAttributionVerdictKind({
        ...base,
        noDoubleCount: { ...noDoubleCount, undoubled: false },
      }),
    ).toBe("attribution-invalid");
    expect(
      deriveAttributionVerdictKind({
        ...base,
        refusal: { reason: "family-unrecorded" },
        refusalHonesty: deriveAttributionRefusalHonesty({
          refusal: { reason: "family-unrecorded" },
          lifecycleRecordCount: 0,
          generationCount: 0,
          ledgerEntryCount: 0,
          recordedTotalCount: 0,
        }),
      }),
    ).toBe("no-evidence-honest");
  });
});

describe("VAL-045 digest + identity determinism", () => {
  test("every digest is deterministic, canonical and payload-free (FNV-1a only)", () => {
    const entry = ragEconomics.ledgerEntries[0];
    if (entry === undefined) {
      throw new Error("the RAG family economics hold no ledger entries");
    }
    expect(attributionEntryDigestOf(entry)).toBe(attributionEntryDigestOf(entry));
    expect(attributionEntryDigestOf(entry)).toMatch(/^[0-9a-f]{8}$/);
    const baseline = ragEconomics.baselines[0];
    if (baseline === undefined) {
      throw new Error("the RAG family economics hold no baselines");
    }
    expect(incumbentBaselineDigestOf(baseline)).toBe(incumbentBaselineDigestOf(baseline));
    expect(incumbentBaselineDigestOf(baseline)).toMatch(/^[0-9a-f]{8}$/);
    const claim = ragSplit.claims[0];
    if (claim === undefined) {
      throw new Error("the RAG canonical split holds no claims");
    }
    expect(attributionClaimDigestOf(claim)).toBe(attributionClaimDigestOf(claim));
    const residualClaim = ragSplit.residual[0];
    if (residualClaim === undefined) {
      throw new Error("the RAG canonical split holds no residual claims");
    }
    expect(residualClaimDigestOf(residualClaim)).toBe(residualClaimDigestOf(residualClaim));
    const total = ragEconomics.recordedTotals[0];
    if (total === undefined) {
      throw new Error("the RAG family economics hold no recorded totals");
    }
    expect(recordedSavingsTotalDigestOf(total)).toBe(recordedSavingsTotalDigestOf(total));
  });

  test("the digests DISCRIMINATE (different facts, different digests)", () => {
    const entry = ragEconomics.ledgerEntries[0];
    if (entry === undefined) {
      throw new Error("the RAG family economics hold no ledger entries");
    }
    expect(attributionEntryDigestOf(entry)).not.toBe(
      attributionEntryDigestOf({ ...entry, microUsd: entry.microUsd + 1 }),
    );
    const baseline = ragEconomics.baselines[0];
    if (baseline === undefined) {
      throw new Error("the RAG family economics hold no baselines");
    }
    expect(incumbentBaselineDigestOf(baseline)).not.toBe(
      incumbentBaselineDigestOf({
        ...baseline,
        incumbentAdjustedCostMicroUsd: baseline.incumbentAdjustedCostMicroUsd + 1,
      }),
    );
    // The swapped baseline is a DIFFERENT digest from the recorded one.
    const reuseG1 = ragEconomics.baselines.find(
      (candidate) => candidate.generation === 1 && candidate.mechanism === "reuse",
    );
    const reuseG3 = ragEconomics.baselines.find(
      (candidate) => candidate.generation === 3 && candidate.mechanism === "reuse",
    );
    if (reuseG1 === undefined || reuseG3 === undefined) {
      throw new Error("the reuse baselines are incomplete");
    }
    expect(incumbentBaselineDigestOf(reuseG1)).not.toBe(incumbentBaselineDigestOf(reuseG3));
  });

  test("the input digest is stable for the honest port", () => {
    const honest = createAttributionHistoryPort();
    const first = attributionInputDigestOf(honest.facts());
    const second = attributionInputDigestOf(honest.facts());
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{8}$/);
  });

  test("the report digest is deterministic and discriminates residuals", () => {
    const report = {
      familyId: "rag-retrieval",
      attributed: { reuse: 80, cache: 100, competence: 60, deterministicization: 160 },
      residualMicroUsd: 95,
      claimedTotalMicroUsd: 495,
      claimDigests: ["a1b2c3d4"],
      residualDigests: ["b2c3d4e5"],
      citationDigest: "deadbeef",
      maturityReportDigest: null,
    };
    expect(savingsAttributionReportDigestOf(report)).toBe(savingsAttributionReportDigestOf(report));
    expect(savingsAttributionReportDigestOf(report)).not.toBe(
      savingsAttributionReportDigestOf({ ...report, residualMicroUsd: 0 }),
    );
  });
});

describe("VAL-045 the report ledger is append-only", () => {
  test("an identical re-append REPLAYS (idempotent)", async () => {
    const ledger = createAttributionReportLedger();
    const report = {
      familyId: "rag-retrieval",
      attributed: { reuse: 80, cache: 100, competence: 60, deterministicization: 160 },
      residualMicroUsd: 95,
      claimedTotalMicroUsd: 495,
      claimDigests: ["a1b2c3d4"],
      residualDigests: ["b2c3d4e5"],
      citationDigest: "deadbeef",
      maturityReportDigest: null,
    };
    const first = await ledger.append(report);
    const second = await ledger.append(report);
    expect(first).toEqual({ accepted: true, replayed: false, refused: false });
    expect(second).toEqual({ accepted: true, replayed: true, refused: false });
    expect(ledger.reportsFor("rag-retrieval")).toHaveLength(1);
  });

  test("a DIFFERENT report under the same family is REFUSED", async () => {
    const ledger = createAttributionReportLedger();
    const report = {
      familyId: "rag-retrieval",
      attributed: { reuse: 80, cache: 100, competence: 60, deterministicization: 160 },
      residualMicroUsd: 95,
      claimedTotalMicroUsd: 495,
      claimDigests: ["a1b2c3d4"],
      residualDigests: ["b2c3d4e5"],
      citationDigest: "deadbeef",
      maturityReportDigest: null,
    };
    await ledger.append(report);
    const impostor = await ledger.append({ ...report, residualMicroUsd: 0 });
    expect(impostor).toEqual({ accepted: false, replayed: false, refused: true });
    expect(ledger.reportsFor("rag-retrieval")).toHaveLength(1);
    expect(ledger.reportsFor("rag-retrieval")[0]?.residualMicroUsd).toBe(95);
  });
});

describe("VAL-045 the driver over every offline corpus row", () => {
  test("every offline row COMPLETES over the honest stack (the honest oracle)", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const stack = createHonestAttributionStack();
      const result = await driveAttributionAnalysis({
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
      "unrecorded-family-attribution-refusal",
      "no-savings-family-attribution-refusal",
    ]) {
      const row = rowById(rowId);
      const stack = createHonestAttributionStack();
      const result = await driveAttributionAnalysis({
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
    const row = rowById("rag-retrieval-all-mechanisms-attributed");
    const stack = createHonestAttributionStack();
    const first = await driveAttributionAnalysis({
      row,
      analysis: stack.history,
      reportLedger: stack.reportLedger,
      now: stack.clock.now,
    });
    const second = await driveAttributionAnalysis({
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
    const landed = stack.reportLedger.reportsFor("rag-retrieval")[0];
    expect(landed?.residualMicroUsd).toBe(95);
    expect(landed?.claimedTotalMicroUsd).toBe(495);
    expect(landed?.maturityReportDigest).not.toBeNull();
  });

  test("the row ids are the pinned membership (12 offline rows)", () => {
    const rowIds = OFFLINE_CORPUS_ROWS.map((row) => row.rowId);
    expect(rowIds).toHaveLength(12);
    expect(rowIds).toContain("rag-retrieval-all-mechanisms-attributed");
    expect(rowIds).toContain("no-savings-family-attribution-refusal");
  });

  test("a dispatch-demanding row without a dispatch seam is a configuration error", async () => {
    const liveRow = rowById("rag-retrieval-all-mechanisms-attributed");
    const demanding = { ...liveRow, needsDispatch: true } as AttributionCorpusRow;
    const stack = createHonestAttributionStack();
    await expect(
      driveAttributionAnalysis({
        row: demanding,
        analysis: stack.history,
        reportLedger: stack.reportLedger,
        now: stack.clock.now,
      }),
    ).rejects.toThrow("demands a dispatch seam");
  });
});

describe("VAL-045 adversarial worlds (the fake economics variants)", () => {
  const driveOver = async (
    rowId: string,
    variant: FakeEconomicsVariant,
  ): Promise<{
    readonly terminal: string;
    readonly verdict: string;
    readonly failedCriteria: readonly string[];
  }> => {
    const row = rowById(rowId);
    const history = createAttributionHistoryPort(variant);
    const reportLedger = createAttributionReportLedger();
    const result = await driveAttributionAnalysis({
      row,
      analysis: history,
      reportLedger,
      now: createHonestAttributionStack().clock.now,
    });
    return {
      terminal: result.terminal,
      verdict: result.verdict,
      failedCriteria: result.criteria
        .filter((criterion) => criterion.status === "FAIL")
        .map((criterion) => criterion.criterionId),
    };
  };

  test("the GAPPED history FAILs the deterministicization-dominant row (a generation the served curves lack)", async () => {
    const outcome = await driveOver("translation-glossary-deterministicization-dominant", "gapped");
    expect(outcome.terminal).toBe("FAILED");
    expect(outcome.verdict).toBe("attribution-invalid");
    expect(outcome.failedCriteria).toContain("attribution-series-no-fabricated-generations");
  });

  test("the SWAPPED-BASELINE history FAILs the reuse-dominant row (the counterfactual leg)", async () => {
    const outcome = await driveOver("invoice-extraction-reuse-dominant", "swappedbaseline");
    expect(outcome.terminal).toBe("FAILED");
    expect(outcome.verdict).toBe("attribution-invalid");
    expect(outcome.failedCriteria).toContain("attribution-baseline-recorded");
  });

  test("the UNRECONCILED history FAILs the reconciliation legs (the totals no longer match)", async () => {
    const outcome = await driveOver("rag-retrieval-all-mechanisms-attributed", "unreconciled");
    expect(outcome.terminal).toBe("FAILED");
    expect(outcome.verdict).toBe("attribution-invalid");
    expect(outcome.failedCriteria).toContain("attribution-reconciliation-identity-per-generation");
    expect(outcome.failedCriteria).toContain("attribution-residual-matches-recorded");
  });

  test("the MUTATING history FAILs the read-only discipline (the facts digest drifted)", async () => {
    const outcome = await driveOver("rag-retrieval-all-mechanisms-attributed", "mutating");
    expect(outcome.terminal).toBe("FAILED");
    expect(outcome.verdict).toBe("attribution-invalid");
    expect(outcome.failedCriteria).toContain("attribution-input-read-only");
  });

  test("every adversarial world keeps the family facts digest stable for the honest variant families", () => {
    const honest = createAttributionHistoryPort();
    const gapped = createAttributionHistoryPort("gapped");
    expect(attributionInputDigestOf(honest.facts())).toBe(attributionInputDigestOf(gapped.facts()));
  });
});

describe("VAL-045 the row criteria contract + the corpus consistency", () => {
  test("the honest row criteria PASS; a mutated verdict FAILs the expected-verdict leg", () => {
    const row = rowById("code-search-cache-dominant");
    const split = canonicalAttributionSplitOf({
      familyId: "code-search",
      ledgerEntries: cacheDominantEconomics.ledgerEntries,
      lifecycleRecords: cacheDominantEconomics.lifecycleRecords,
      baselines: cacheDominantEconomics.baselines,
      recordedTotals: cacheDominantEconomics.recordedTotals,
    });
    const criteria = deriveAttributionRowCriteria({
      row,
      refusal: null,
      refusalHonesty: null,
      citation: deriveAttributionEvidenceCitation({
        lifecycleRecords: cacheDominantEconomics.lifecycleRecords,
        generations: cacheDominantEconomics.generations,
        ledgerEntries: cacheDominantEconomics.ledgerEntries,
        baselines: cacheDominantEconomics.baselines,
        recordedTotals: cacheDominantEconomics.recordedTotals,
        split,
      }),
      noDoubleCount: deriveNoDoubleCount({ split }),
      residualHonesty: deriveResidualHonesty({
        ledgerEntries: cacheDominantEconomics.ledgerEntries,
        recordedTotals: cacheDominantEconomics.recordedTotals,
        split,
      }),
      reconciliation: deriveAttributionReconciliation({
        recordedTotals: cacheDominantEconomics.recordedTotals,
        split,
      }),
      counterfactual: deriveCounterfactualFidelity({
        baselines: cacheDominantEconomics.baselines,
        split,
      }),
      generationSeries: deriveGenerationSeriesIntegrity({
        recordedGenerations: cacheDominantEconomics.generations,
        split,
      }),
      honesty: deriveAttributionHonesty({
        baselines: cacheDominantEconomics.baselines,
        reportedUsage: null,
        liveRail: false,
      }),
      reportLanded: { accepted: true, replayed: false },
      reportsAppended: 1,
      inputUnchanged: true,
      observedModelCalls: 0,
      verdict: "attribution-established",
      failure: null,
    });
    expect(criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
    const mutated = deriveAttributionRowCriteria({
      row,
      refusal: null,
      refusalHonesty: null,
      citation: null,
      noDoubleCount: null,
      residualHonesty: null,
      reconciliation: null,
      counterfactual: null,
      generationSeries: null,
      honesty: null,
      reportLanded: null,
      reportsAppended: 0,
      inputUnchanged: true,
      observedModelCalls: 0,
      verdict: "attribution-invalid",
      failure: null,
    });
    expect(
      mutated.find((criterion) => criterion.criterionId === "attribution-expected-verdict")?.status,
    ).toBe("FAIL");
  });

  test("every family's pinned economics satisfy the attribution identity + counterfactual consistency", () => {
    for (const economics of [
      ragEconomics,
      largeResidualEconomics,
      cacheDominantEconomics,
      reuseDominantEconomics,
      detDominantEconomics,
    ]) {
      const split = canonicalAttributionSplitOf({
        familyId: economics.familyId,
        ledgerEntries: economics.ledgerEntries,
        lifecycleRecords: economics.lifecycleRecords,
        baselines: economics.baselines,
        recordedTotals: economics.recordedTotals,
      });
      // The reconciliation identity over the canonical split.
      const reconciliation = deriveAttributionReconciliation({
        recordedTotals: economics.recordedTotals,
        split,
      });
      expect(reconciliation.reconciled, economics.familyId).toBe(true);
      // Every claim measures against its own recorded baseline.
      const counterfactual = deriveCounterfactualFidelity({
        baselines: economics.baselines,
        split,
      });
      expect(counterfactual.faithful, economics.familyId).toBe(true);
      // No double counts and no forced residuals.
      expect(deriveNoDoubleCount({ split }).undoubled, economics.familyId).toBe(true);
      expect(
        deriveResidualHonesty({
          ledgerEntries: economics.ledgerEntries,
          recordedTotals: economics.recordedTotals,
          split,
        }).honest,
        economics.familyId,
      ).toBe(true);
      // The full-population citation.
      expect(
        deriveAttributionEvidenceCitation({
          lifecycleRecords: economics.lifecycleRecords,
          generations: economics.generations,
          ledgerEntries: economics.ledgerEntries,
          baselines: economics.baselines,
          recordedTotals: economics.recordedTotals,
          split,
        }).complete,
        economics.familyId,
      ).toBe(true);
    }
  });

  test("the app contract oracle: an honest observation PASSES; a gapped surface FAILs the series read-back", () => {
    const row = rowById("rag-retrieval-all-mechanisms-attributed");
    const declared = declaredSplitTotalsOf(row);
    const honestCriteria = verifySavingsAttributionAppContract({
      row,
      observation: {
        executionId: "exec-1",
        replayed: false,
        rejection: null,
        terminal: "COMPLETED",
        verificationStatuses: ["PASS"],
        attributed: declared.attributed,
        residualMicroUsd: declared.residualMicroUsd,
        claimedTotalMicroUsd: declared.attributedTotalMicroUsd + declared.residualMicroUsd,
        perGeneration: [1, 2, 3].map((generation) => ({
          generation,
          perMechanism: {
            reuse: row.split.claims
              .filter((claim) => claim.generation === generation && claim.mechanism === "reuse")
              .reduce((total, claim) => total + claim.claimedMicroUsd, 0),
            cache: row.split.claims
              .filter((claim) => claim.generation === generation && claim.mechanism === "cache")
              .reduce((total, claim) => total + claim.claimedMicroUsd, 0),
            competence: row.split.claims
              .filter(
                (claim) => claim.generation === generation && claim.mechanism === "competence",
              )
              .reduce((total, claim) => total + claim.claimedMicroUsd, 0),
            deterministicization: row.split.claims
              .filter(
                (claim) =>
                  claim.generation === generation && claim.mechanism === "deterministicization",
              )
              .reduce((total, claim) => total + claim.claimedMicroUsd, 0),
          },
          residualMicroUsd:
            row.split.residual.find((claim) => claim.generation === generation)?.residualMicroUsd ??
            0,
          recordedTotalMicroUsd:
            ragEconomics.recordedTotals.find((record) => record.generation === generation)
              ?.totalMicroUsd ?? 0,
        })),
        refusalReason: null,
        reportRecorded: true,
        observedModelCalls: 0,
        trajectoryDigest: "0123abcd",
      },
    });
    expect(honestCriteria.every((criterion) => criterion.status === "PASS")).toBe(true);
    // The gapped surface: generation 2 dropped from the read-back.
    const gappedCriteria = verifySavingsAttributionAppContract({
      row,
      observation: {
        executionId: "exec-1",
        replayed: false,
        rejection: null,
        terminal: "COMPLETED",
        verificationStatuses: ["PASS"],
        attributed: declared.attributed,
        residualMicroUsd: declared.residualMicroUsd,
        claimedTotalMicroUsd: declared.attributedTotalMicroUsd + declared.residualMicroUsd,
        perGeneration: [],
        refusalReason: null,
        reportRecorded: true,
        observedModelCalls: 0,
        trajectoryDigest: "0123abcd",
      },
    });
    const seriesCriterion = gappedCriteria.find(
      (criterion) => criterion.criterionId === "app-generation-series-read-back",
    );
    expect(seriesCriterion?.status).toBe("FAIL");
    expect(seriesCriterion?.evidence.join(" ")).toContain("GAPPED-SERIES-READ-BACK");
  });
});
