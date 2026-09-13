/**
 * VAL-033 acceptance criteria 4 + 6 — discrimination tests proving the
 * equivalence testing against controlled fakes (the six AC6 families
 * over the PURE platform derivations):
 *
 *   * the BROKEN PROVENANCE — a verdict that cites NO proposal (an
 *     uncited verdict), cites a proposal the registry never recorded
 *     (a phantom citation), or cites a proposal other than the row's
 *     pinned source FAILs the provenance completeness mechanically —
 *     while the complete chain (a registry member, cited, matched to
 *     the pin, full population covered) PASSES;
 *
 *   * the PARTIAL POPULATION — a differential population that drops
 *     the pinned adversarial cases or covers only a subset of the
 *     proposal's cited replay identities FAILs, and a covered identity
 *     the proposal never cited is a FABRICATED population — while the
 *     full cited population + every pinned adversarial case PASSES;
 *
 *   * the UNCHECKED CRITERION — a criterion stated but never checked
 *     (an empty checked surface), a checkable-but-unchecked case, a
 *     missing outcome, or an UNSTATED criterion (a replacement
 *     accepted under no criterion at all) each FAIL the differential
 *     equivalence mechanically — while the mechanically evaluated
 *     full population PASSES;
 *
 *   * the DIVERGENCE SMOOTHING — a divergent case claimed equivalent
 *     (a smoothed divergence) FAILs the honesty leg on top of the
 *     divergence itself, and a satisfied case claimed NON-equivalent
 *     is a false-divergence claim that FAILs identically — while the
 *     HONEST divergence is recorded case-by-case, never smoothed;
 *
 *   * the SKIPPED STAGE — any lifecycle append that jumps PAST the
 *     differentially-evaluated stage (an out-of-scope promotion),
 *     jumps a ladder rung (offline-replay skipped), or lands without
 *     its evidence FAILs the stage discipline, and a registry REWRITE
 *     (mutating a proposal's own entry) FAILs the read-only
 *     discipline — while the evidenced equivalence walk PASSES;
 *
 *   * the CONTAINMENT ESCAPE — a replacement exercising ANY of the
 *     four pinned escape directions (network access, platform state
 *     mutation, credential access, tenant-boundary crossing) is a
 *     containment VIOLATION that FAILs and never lands — while the
 *     within-surface, within-declaration exercise is contained.
 *
 * Plus the honest controls: every criterion kind over its own
 * replacement shape PASSES (exact digest equality over the
 * deterministic function; digest-class equality over the retrieval
 * pipeline; per-case tolerance over the reusable tool), the honest
 * replacement run per shape is deterministic and mechanical, the
 * digest/identity derivations are deterministic and discriminating,
 * the verdict-kind derivation orders its failure modes honestly, the
 * app contract catches every fake-world knob, and the lifecycle
 * ledger is append-only exactly-once.
 */

import { describe, expect, test } from "vitest";
import { runEquivalenceTestingApp } from "../../benchmarks/validation/apps/equivalence-testing/application";
import {
  EQUIVALENCE_TESTING_CORPUS,
  equivalenceRowById,
  OFFLINE_CORPUS_ROWS,
  PINNED_REGISTRY_ENTRIES,
  pinnedRunOf,
} from "../../benchmarks/validation/apps/equivalence-testing/corpus";
import {
  createCandidateRegistry,
  createEquivalenceFakeApiWorld,
  createIncumbentExecutor,
  createLifecycleLedger,
  createReplacementRuntime,
  createTickClock,
} from "../../benchmarks/validation/apps/equivalence-testing/fixtures";
import type { TransportImplementation } from "../../benchmarks/validation/harness/harness";
import type {
  DifferentialCase,
  DifferentialEquivalenceVerdict,
  EquivalenceCorpusRow,
  LifecycleTransitionRecord,
  ReplacementIsolationVerdict,
} from "../../benchmarks/validation/platform/equivalence-testing";
import {
  criterionSatisfiedForCase,
  deriveDifferentialEquivalence,
  deriveEquivalenceVerdictKind,
  deriveHonestReplacementRun,
  deriveProvenanceCompleteness,
  deriveReplacementIsolation,
  deriveStageDiscipline,
  differentialCaseDigestOf,
  differentialPopulationDigestOf,
  differentialVerdictDigestOf,
  driveEquivalenceRun,
  EQUIVALENT_STAGE,
  equivalenceRegistryDigestOf,
  ISOLATION_ESCAPE_DIRECTIONS,
  isBeyondEquivalenceScope,
  lifecycleEvidenceDigestOf,
  lifecycleStageIndexOf,
  OFFLINE_REPLAY_STAGE,
  REPLACEMENT_SHAPES,
  referenceReplacementOutcomeDigestOf,
} from "../../benchmarks/validation/platform/equivalence-testing";
import { CANDIDATE_LIFECYCLE_STAGES } from "../../benchmarks/validation/platform/learning-discovery";
import { longitudinalDigestOf } from "../../benchmarks/validation/platform/longitudinal-baseline";

const REVISION = "1fab7a7e3705c2030eb13076d134c1c351590512";

const rowById = (rowId: string): EquivalenceCorpusRow => {
  const row = equivalenceRowById(rowId);
  if (row === null) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

const taskIndexOf = (rowId: string): number => {
  const index = EQUIVALENCE_TESTING_CORPUS.findIndex((row) => row.rowId === rowId);
  if (index < 0) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return index;
};

/** The honest registry pin of one row's source proposal. */
function registryPinOf(row: EquivalenceCorpusRow) {
  const pin = PINNED_REGISTRY_ENTRIES.find((entry) => entry.proposalId === row.sourceProposalId);
  if (pin === undefined) {
    throw new Error(`the row ${row.rowId} cites no registry member`);
  }
  return pin;
}

/** The row's historical replay identities (the proposal's own citation). */
const historicalIdentitiesOf = (row: EquivalenceCorpusRow) =>
  row.differentialPopulation
    .filter((dcase) => dcase.source === "historical-replay")
    .map((dcase) => dcase.sourceRef);

/** The row's pinned adversarial case ids. */
const adversarialIdsOf = (row: EquivalenceCorpusRow) =>
  row.differentialPopulation
    .filter((dcase) => dcase.source === "adversarial")
    .map((dcase) => dcase.caseId);

/** Build the provenance-completeness input over one row (the honest basis). */
function provenanceBasisOf(row: EquivalenceCorpusRow) {
  const pin = registryPinOf(row);
  return {
    registryProposalIds: PINNED_REGISTRY_ENTRIES.map((entry) => entry.proposalId),
    expectedProposalId: row.sourceProposalId,
    citedProposalId: row.sourceProposalId as string | null,
    proposalCitedReplayIdentities: [...pin.citation.replayIdentities],
    pinnedAdversarialCaseIds: adversarialIdsOf(row),
    coveredReplayIdentities: historicalIdentitiesOf(row),
    coveredAdversarialCaseIds: adversarialIdsOf(row),
  };
}

/** Build the differential-equivalence input over one row (the honest basis). */
function differentialBasisOf(row: EquivalenceCorpusRow) {
  const { honestRun } = pinnedRunOf(row);
  return {
    population: [...row.differentialPopulation],
    criterion: row.acceptanceCriterion,
    incumbentOutcomes: row.differentialPopulation.map((dcase) => ({
      caseId: dcase.caseId,
      digest: dcase.incumbentDigest,
    })),
    replacementOutcomes: honestRun.outcomes.map((outcome) => ({ ...outcome })),
    evaluatedCaseIds: [...honestRun.evaluatedCaseIds],
  };
}

/** The evidenced equivalence walk over one row (the honest transitions). */
function honestWalkOf(row: EquivalenceCorpusRow): readonly LifecycleTransitionRecord[] {
  return [
    {
      proposalId: row.sourceProposalId,
      toStage: OFFLINE_REPLAY_STAGE,
      evidenceDigest: lifecycleEvidenceDigestOf({
        proposalId: row.sourceProposalId,
        stage: OFFLINE_REPLAY_STAGE,
        members: historicalIdentitiesOf(row),
      }),
      ordinal: 1,
    },
    {
      proposalId: row.sourceProposalId,
      toStage: EQUIVALENT_STAGE,
      evidenceDigest: lifecycleEvidenceDigestOf({
        proposalId: row.sourceProposalId,
        stage: EQUIVALENT_STAGE,
        members: [pinnedRunOf(row).differential.digest],
      }),
      ordinal: 2,
    },
  ];
}

// ---------------------------------------------------------------------------
// Family 1: the broken provenance (the citation catch)
// ---------------------------------------------------------------------------

describe("VAL-033 discrimination: the broken provenance", () => {
  const row = rowById("rag-deterministic-function-exact");

  test("an UNCITED verdict (no proposal citation) FAILs", () => {
    const verdict = deriveProvenanceCompleteness({
      ...provenanceBasisOf(row),
      citedProposalId: null,
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.citedProposalId).toBeNull();
    const cited = verdict.criteria.find((c) => c.criterionId === "provenance-proposal-cited");
    expect(cited?.status).toBe("FAIL");
    expect(cited?.evidence.join(" ")).toContain("UNCITED-VERDICT");
  });

  test("a PHANTOM citation (an id the registry never recorded) FAILs", () => {
    const phantom = `cand-learning-discovery-${longitudinalDigestOf(["phantom", "discrimination"])}`;
    const verdict = deriveProvenanceCompleteness({
      ...provenanceBasisOf(row),
      citedProposalId: phantom,
    });
    expect(verdict.complete).toBe(false);
    const cited = verdict.criteria.find((c) => c.criterionId === "provenance-proposal-cited");
    expect(cited?.status).toBe("FAIL");
    expect(cited?.evidence.join(" ")).toContain("PHANTOM-CITATION");
  });

  test("a citation that mismatches the row's pinned proposal FAILs", () => {
    const other = PINNED_REGISTRY_ENTRIES.find(
      (entry) => entry.proposalId !== row.sourceProposalId,
    );
    expect(other).toBeDefined();
    const verdict = deriveProvenanceCompleteness({
      ...provenanceBasisOf(row),
      citedProposalId: (other ?? { proposalId: "" }).proposalId,
    });
    expect(verdict.complete).toBe(false);
    const matched = verdict.criteria.find(
      (c) => c.criterionId === "provenance-proposal-matches-pin",
    );
    expect(matched?.status).toBe("FAIL");
    expect(matched?.evidence.join(" ")).toContain("PROPOSAL-MISMATCH");
  });

  test("the COMPLETE provenance chain PASSES (cited registry member + full population)", () => {
    const verdict = deriveProvenanceCompleteness(provenanceBasisOf(row));
    expect(verdict.complete).toBe(true);
    expect(verdict.missingReplayIdentities).toEqual([]);
    expect(verdict.missingAdversarialCaseIds).toEqual([]);
    expect(verdict.fabricatedReplayIdentities).toEqual([]);
    for (const criterion of verdict.criteria) {
      expect(criterion.status, criterion.criterionId).toBe("PASS");
    }
  });
});

// ---------------------------------------------------------------------------
// Family 2: the partial population (the coverage catch)
// ---------------------------------------------------------------------------

describe("VAL-033 discrimination: the partial population", () => {
  const row = rowById("rag-deterministic-function-exact");

  test("a population missing the PINNED ADVERSARIAL cases FAILs with the cases named", () => {
    const verdict = deriveProvenanceCompleteness({
      ...provenanceBasisOf(row),
      coveredAdversarialCaseIds: [],
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.missingAdversarialCaseIds).toEqual(adversarialIdsOf(row));
    const full = verdict.criteria.find((c) => c.criterionId === "provenance-full-population");
    expect(full?.status).toBe("FAIL");
    expect(full?.evidence.join(" ")).toContain("PARTIAL-POPULATION");
  });

  test("a population covering only a SUBSET of the cited replay identities FAILs", () => {
    const identities = historicalIdentitiesOf(row);
    expect(identities.length).toBeGreaterThanOrEqual(4);
    const verdict = deriveProvenanceCompleteness({
      ...provenanceBasisOf(row),
      coveredReplayIdentities: identities.slice(0, 1),
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.missingReplayIdentities).toEqual(identities.slice(1));
    const full = verdict.criteria.find((c) => c.criterionId === "provenance-full-population");
    expect(full?.status).toBe("FAIL");
    expect(full?.evidence.join(" ")).toContain("PARTIAL-POPULATION");
  });

  test("a FABRICATED coverage (an identity the proposal never cited) FAILs", () => {
    const phantomIdentity = `exp-workload-replay-${longitudinalDigestOf(["fabricated", "replay"])}`;
    const verdict = deriveProvenanceCompleteness({
      ...provenanceBasisOf(row),
      coveredReplayIdentities: [...historicalIdentitiesOf(row), phantomIdentity],
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.fabricatedReplayIdentities).toEqual([phantomIdentity]);
    const fabricated = verdict.criteria.find(
      (c) => c.criterionId === "provenance-no-fabricated-coverage",
    );
    expect(fabricated?.status).toBe("FAIL");
    expect(fabricated?.evidence.join(" ")).toContain("FABRICATED-POPULATION");
  });
});

// ---------------------------------------------------------------------------
// Family 3: the unchecked criterion (the explicitness catch)
// ---------------------------------------------------------------------------

describe("VAL-033 discrimination: the unchecked criterion", () => {
  const row = rowById("rag-deterministic-function-exact");

  test("a criterion STATED but NEVER checked (an empty checked surface) FAILs", () => {
    const verdict = deriveDifferentialEquivalence({
      ...differentialBasisOf(row),
      evaluatedCaseIds: [],
    });
    expect(verdict.fullyEvaluated).toBe(false);
    expect(verdict.unevaluatedCaseIds).toEqual(
      row.differentialPopulation.map((dcase) => dcase.caseId),
    );
    expect(verdict.equivalent).toBe(false);
    const checked = verdict.criteria.find((c) => c.criterionId === "criterion-checked");
    expect(checked?.status).toBe("FAIL");
    expect(checked?.evidence.join(" ")).toContain("UNCHECKED-CRITERION");
  });

  test("a CHECKABLE-BUT-UNCHECKED case (one case dropped from the surface) FAILs with the case named", () => {
    const caseIds = row.differentialPopulation.map((dcase) => dcase.caseId);
    const dropped = caseIds[caseIds.length - 1] ?? "";
    const verdict = deriveDifferentialEquivalence({
      ...differentialBasisOf(row),
      evaluatedCaseIds: caseIds.filter((caseId) => caseId !== dropped),
    });
    expect(verdict.fullyEvaluated).toBe(false);
    expect(verdict.unevaluatedCaseIds).toEqual([dropped]);
    expect(verdict.equivalent).toBe(false);
    const checked = verdict.criteria.find((c) => c.criterionId === "criterion-checked");
    expect(checked?.status).toBe("FAIL");
    expect(checked?.evidence.join(" ")).toContain(dropped);
  });

  test("a MISSING OUTCOME (a case with no recorded replacement outcome) FAILs", () => {
    const basis = differentialBasisOf(row);
    const verdict = deriveDifferentialEquivalence({
      ...basis,
      replacementOutcomes: basis.replacementOutcomes.slice(0, 1),
    });
    expect(verdict.fullyEvaluated).toBe(false);
    expect(verdict.missingOutcomeCaseIds).toHaveLength(row.differentialPopulation.length - 1);
    expect(verdict.equivalent).toBe(false);
    const checked = verdict.criteria.find((c) => c.criterionId === "criterion-checked");
    expect(checked?.status).toBe("FAIL");
  });

  test("an UNSTATED criterion (a replacement accepted under no criterion) FAILs", () => {
    const verdict = deriveDifferentialEquivalence({
      ...differentialBasisOf(row),
      criterion: null,
    });
    expect(verdict.criterionExplicit).toBe(false);
    expect(verdict.criterionKind).toBeNull();
    expect(verdict.equivalent).toBe(false);
    const explicit = verdict.criteria.find((c) => c.criterionId === "criterion-explicit");
    expect(explicit?.status).toBe("FAIL");
    expect(explicit?.evidence.join(" ")).toContain("UNSTATED-CRITERION");
  });

  test("a MALFORMED tolerance (a tolerated id outside the population) FAILs", () => {
    const verdict = deriveDifferentialEquivalence({
      ...differentialBasisOf(rowById("tool-loop-reusable-tool-tolerance")),
      criterion: {
        kind: "per-case-tolerance",
        toleratedCaseIds: ["adversarial-nonexistent-1", "adversarial-nonexistent-2"],
      },
    });
    expect(verdict.equivalent).toBe(false);
    const tolerance = verdict.criteria.find(
      (c) => c.criterionId === "criterion-well-formed-tolerance",
    );
    expect(tolerance?.status).toBe("FAIL");
    expect(tolerance?.evidence.join(" ")).toContain("MALFORMED-CRITERION");
  });

  test("the mechanically evaluated full population PASSES (the control)", () => {
    const verdict = deriveDifferentialEquivalence(differentialBasisOf(row));
    expect(verdict.equivalent).toBe(true);
    expect(verdict.fullyEvaluated).toBe(true);
    expect(verdict.divergences).toEqual([]);
    expect(verdict.smoothedDivergences).toEqual([]);
    for (const criterion of verdict.criteria) {
      expect(criterion.status, criterion.criterionId).toBe("PASS");
    }
  });
});

// ---------------------------------------------------------------------------
// Family 4: the divergence smoothing (the honesty catch)
// ---------------------------------------------------------------------------

describe("VAL-033 discrimination: the divergence smoothing", () => {
  const row = rowById("reuse-removed-call-honest-divergence");

  test("a divergence recorded as a PASS (a smoothed divergence) FAILs the honesty leg", () => {
    const basis = differentialBasisOf(row);
    // The removed-call shape diverges on every case; the runtime CLAIMS
    // equivalence for the first one (the smoothing).
    const smoothed = basis.replacementOutcomes.map((outcome, index) =>
      index === 0 ? { ...outcome, claimedEquivalent: true } : { ...outcome },
    );
    const verdict = deriveDifferentialEquivalence({ ...basis, replacementOutcomes: smoothed });
    expect(verdict.divergences).toHaveLength(row.differentialPopulation.length);
    expect(verdict.smoothedDivergences).toHaveLength(1);
    expect(verdict.equivalent).toBe(false);
    const honesty = verdict.criteria.find(
      (c) => c.criterionId === "divergence-honesty-no-smoothing",
    );
    expect(honesty?.status).toBe("FAIL");
    expect(honesty?.evidence.join(" ")).toContain("DIVERGENCE-SMOOTHING");
  });

  test("an HONEST divergence is recorded case-by-case, never smoothed (the control)", () => {
    const verdict = deriveDifferentialEquivalence(differentialBasisOf(row));
    expect(verdict.divergences).toHaveLength(row.differentialPopulation.length);
    expect(verdict.smoothedDivergences).toEqual([]);
    expect(verdict.equivalent).toBe(false);
    const honesty = verdict.criteria.find(
      (c) => c.criterionId === "divergence-honesty-no-smoothing",
    );
    expect(honesty?.status).toBe("PASS");
    const satisfied = verdict.criteria.find(
      (c) => c.criterionId === "differential-criterion-satisfied",
    );
    expect(satisfied?.status).toBe("FAIL");
    expect(satisfied?.evidence.join(" ")).toContain("HONEST-DIVERGENCE");
    // Every divergence carries BOTH digests (the incumbent's and the
    // replacement's) — the honest record.
    for (const divergence of verdict.divergences) {
      expect(divergence.incumbentDigest).toMatch(/^[0-9a-f]{8}$/);
      expect(divergence.replacementDigest).toMatch(/^[0-9a-f]{8}$/);
      expect(divergence.replacementDigest).not.toBe(divergence.incumbentDigest);
    }
  });

  test("a SATISFIED case claimed NON-equivalent is a false-divergence claim that FAILs", () => {
    const basis = differentialBasisOf(rowById("rag-deterministic-function-exact"));
    const lying = basis.replacementOutcomes.map((outcome) => ({
      ...outcome,
      claimedEquivalent: false,
    }));
    const verdict = deriveDifferentialEquivalence({ ...basis, replacementOutcomes: lying });
    expect(verdict.divergences).toEqual([]);
    expect(verdict.smoothedDivergences).toHaveLength(basis.population.length);
    expect(verdict.equivalent).toBe(false);
    const honesty = verdict.criteria.find(
      (c) => c.criterionId === "divergence-honesty-no-smoothing",
    );
    expect(honesty?.status).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// Family 5: the skipped stage (the lifecycle discipline catch)
// ---------------------------------------------------------------------------

describe("VAL-033 discrimination: the skipped stage", () => {
  const row = rowById("rag-deterministic-function-exact");

  test("the evidenced equivalence walk PASSES (the control)", () => {
    const verdict = deriveStageDiscipline({
      proposalStage: "proposed",
      transitions: honestWalkOf(row),
      expectedLanding: true,
    });
    expect(verdict.disciplined).toBe(true);
    expect(verdict.walk).toEqual([OFFLINE_REPLAY_STAGE, EQUIVALENT_STAGE]);
    for (const criterion of verdict.criteria) {
      expect(criterion.status, criterion.criterionId).toBe("PASS");
    }
  });

  test("any jump PAST the differentially-evaluated stage FAILs (an out-of-scope promotion)", () => {
    // Every stage past differentially-evaluated is beyond the slice's scope.
    for (const stage of CANDIDATE_LIFECYCLE_STAGES) {
      expect(isBeyondEquivalenceScope(stage)).toBe(
        lifecycleStageIndexOf(stage) > lifecycleStageIndexOf(EQUIVALENT_STAGE),
      );
    }
    const beyond = CANDIDATE_LIFECYCLE_STAGES.filter(isBeyondEquivalenceScope);
    expect(beyond).toEqual([
      "property-tested",
      "mutation-tested",
      "shadow-executed",
      "canaried",
      "promoted",
    ]);
    for (const stage of beyond) {
      const verdict = deriveStageDiscipline({
        proposalStage: "proposed",
        transitions: [
          ...honestWalkOf(row),
          {
            proposalId: row.sourceProposalId,
            toStage: stage,
            evidenceDigest: longitudinalDigestOf(["evidence", stage]),
            ordinal: 3,
          },
        ],
        expectedLanding: true,
      });
      expect(verdict.disciplined, stage).toBe(false);
      expect(verdict.beyondScopeStages).toEqual([stage]);
      const never = verdict.criteria.find(
        (c) => c.criterionId === "stage-discipline-never-beyond-equivalence",
      );
      expect(never?.status, stage).toBe("FAIL");
      expect(never?.evidence.join(" ")).toContain("SKIPPED-STAGE");
    }
  });

  test("a walk that JUMPS a rung (offline-replayed skipped) FAILs", () => {
    const verdict = deriveStageDiscipline({
      proposalStage: "proposed",
      transitions: [honestWalkOf(row)[1] as LifecycleTransitionRecord],
      expectedLanding: true,
    });
    expect(verdict.disciplined).toBe(false);
    expect(verdict.skippedStageTransitions).toHaveLength(1);
    const jumps = verdict.criteria.find((c) => c.criterionId === "stage-discipline-no-jumps");
    expect(jumps?.status).toBe("FAIL");
    expect(jumps?.evidence.join(" ")).toContain("SKIPPED-STAGE");
  });

  test("an EVIDENCE-LESS transition FAILs (a landing without its evidence digest)", () => {
    const walk = honestWalkOf(row).map((transition, index) =>
      index === 1 ? { ...transition, evidenceDigest: "" } : { ...transition },
    );
    const verdict = deriveStageDiscipline({
      proposalStage: "proposed",
      transitions: walk,
      expectedLanding: true,
    });
    expect(verdict.disciplined).toBe(false);
    expect(verdict.evidenceLessOrdinals).toEqual([2]);
    const evidenced = verdict.criteria.find(
      (c) => c.criterionId === "stage-discipline-every-transition-evidenced",
    );
    expect(evidenced?.status).toBe("FAIL");
    expect(evidenced?.evidence.join(" ")).toContain("EVIDENCE-LESS-TRANSITION");
  });

  test("a walk starting from a NON-PROPOSED candidate FAILs (not yet testable)", () => {
    const verdict = deriveStageDiscipline({
      proposalStage: "characterized",
      transitions: honestWalkOf(row),
      expectedLanding: true,
    });
    expect(verdict.disciplined).toBe(false);
    const source = verdict.criteria.find(
      (c) => c.criterionId === "stage-discipline-source-proposed",
    );
    expect(source?.status).toBe("FAIL");
    expect(source?.evidence.join(" ")).toContain("NOT-PROPOSED");
  });

  test("a REGISTRY REWRITE (mutating a proposal's own entry) FAILs the read-only discipline", async () => {
    const clock = createTickClock();
    const registry = createCandidateRegistry();
    const digestBefore = registry.digest();
    const result = await driveEquivalenceRun({
      row: rowById("probe-skipped-stage"),
      registry,
      ledger: createLifecycleLedger({ variant: "rewrite-registry", registry }),
      incumbentExecutor: createIncumbentExecutor(),
      replacementRuntime: createReplacementRuntime(),
      now: clock.now,
    });
    expect(result.terminal).toBe("FAILED");
    // The verdict itself was honest — the rewrite happened at the append.
    expect(result.differential?.equivalent).toBe(true);
    expect(registry.digest()).not.toBe(digestBefore);
    const readonly = result.criteria.find((c) => c.criterionId === "registry-read-only");
    expect(readonly?.status).toBe("FAIL");
    expect(readonly?.evidence.join(" ")).toContain("REGISTRY-MUTATION");
  });
});

// ---------------------------------------------------------------------------
// Family 6: the containment escape (the untrusted-code discipline catch)
// ---------------------------------------------------------------------------

describe("VAL-033 discrimination: the containment escape", () => {
  const declared = ["pure-computation", "granted-fixture-read"];
  const granted = ["pure-computation", "granted-fixture-read"];

  test("EACH escape direction is a containment VIOLATION that FAILs and names the direction", () => {
    for (const direction of ISOLATION_ESCAPE_DIRECTIONS) {
      const verdict = deriveReplacementIsolation({
        declaredCapabilities: declared,
        grantedSurface: granted,
        exercisedCapabilities: [...declared, direction],
      });
      expect(verdict.contained, direction).toBe(false);
      expect(verdict.containment, direction).toBe("violation");
      expect(verdict.escapeDirections, direction).toEqual([direction]);
      expect(verdict.undeclaredExercises, direction).toEqual([direction]);
      const escapeLeg = verdict.criteria.find((c) => c.criterionId === "isolation-no-escape");
      expect(escapeLeg?.status, direction).toBe("FAIL");
      expect(escapeLeg?.evidence.join(" "), direction).toContain("CONTAINMENT-VIOLATION");
      expect(escapeLeg?.evidence.join(" "), direction).toContain(direction);
    }
  });

  test("the CONTAINED control passes (within surface, within declaration)", () => {
    const verdict = deriveReplacementIsolation({
      declaredCapabilities: declared,
      grantedSurface: granted,
      exercisedCapabilities: declared,
    });
    expect(verdict.contained).toBe(true);
    expect(verdict.containment).toBe("contained");
    expect(verdict.escapeDirections).toEqual([]);
    for (const criterion of verdict.criteria) {
      expect(criterion.status, criterion.criterionId).toBe("PASS");
    }
  });

  test("an UNDECLARED exercise and an UNGRANTED demand each FAIL (the other isolation legs)", () => {
    // An undeclared-but-granted exercise: contained==false (undeclared leg).
    const undeclared: ReplacementIsolationVerdict = deriveReplacementIsolation({
      declaredCapabilities: ["pure-computation"],
      grantedSurface: granted,
      exercisedCapabilities: ["pure-computation", "granted-fixture-read"],
    });
    expect(undeclared.contained).toBe(false);
    expect(
      undeclared.criteria.find((c) => c.criterionId === "isolation-exercised-declared")?.status,
    ).toBe("FAIL");
    // A declared-but-ungranted demand: contained==false (declaration leg).
    const ungranted = deriveReplacementIsolation({
      declaredCapabilities: ["pure-computation", "network-access"],
      grantedSurface: granted,
      exercisedCapabilities: ["pure-computation"],
    });
    expect(ungranted.contained).toBe(false);
    expect(
      ungranted.criteria.find((c) => c.criterionId === "isolation-declared-within-surface")?.status,
    ).toBe("FAIL");
    expect(
      ungranted.criteria
        .find((c) => c.criterionId === "isolation-declared-within-surface")
        ?.evidence.join(" "),
    ).toContain("UNGRANTED-DEMAND");
  });

  test("an empty surface with an empty exercise is contained (the removed-call shape)", () => {
    const verdict = deriveReplacementIsolation({
      declaredCapabilities: [],
      grantedSurface: [],
      exercisedCapabilities: [],
    });
    expect(verdict.contained).toBe(true);
    for (const criterion of verdict.criteria) {
      expect(criterion.status, criterion.criterionId).toBe("PASS");
    }
  });
});

// ---------------------------------------------------------------------------
// The honest controls: criterion kinds, replacement shapes, digest determinism
// ---------------------------------------------------------------------------

describe("VAL-033 discrimination: the honest criterion kinds and replacement shapes", () => {
  test("every honest criterion kind over its own shape PASSES (equality NOT required)", () => {
    const exact = deriveDifferentialEquivalence(
      differentialBasisOf(rowById("rag-deterministic-function-exact")),
    );
    expect(exact.criterionKind).toBe("exact-digest-equality");
    expect(exact.equivalent).toBe(true);
    const klass = deriveDifferentialEquivalence(
      differentialBasisOf(rowById("order-settlement-retrieval-class")),
    );
    expect(klass.criterionKind).toBe("digest-class-equality");
    expect(klass.equivalent).toBe(true);
    const tolerance = deriveDifferentialEquivalence(
      differentialBasisOf(rowById("tool-loop-reusable-tool-tolerance")),
    );
    expect(tolerance.criterionKind).toBe("per-case-tolerance");
    expect(tolerance.equivalent).toBe(true);
    // The tolerance row's criterion is well formed (its tolerated set
    // cites population members only) and the two-member adversarial
    // class is the honest semantic-equivalence basis.
    expect(
      tolerance.criteria.find((c) => c.criterionId === "criterion-well-formed-tolerance")?.status,
    ).toBe("PASS");
    const toolRow = rowById("tool-loop-reusable-tool-tolerance");
    const twoMember = toolRow.differentialPopulation.find(
      (dcase) => dcase.classDigests.length === 2,
    );
    expect(twoMember).toBeDefined();
  });

  test("the honest replacement run per shape is deterministic and mechanical", () => {
    const row = rowById("rag-deterministic-function-exact");
    for (const shape of REPLACEMENT_SHAPES) {
      const run = deriveHonestReplacementRun({
        sourceProposalId: row.sourceProposalId,
        replacementShape: shape,
        declaredCapabilities: row.declaredCapabilities,
        acceptanceCriterion: row.acceptanceCriterion,
        population: row.differentialPopulation,
      });
      const again = deriveHonestReplacementRun({
        sourceProposalId: row.sourceProposalId,
        replacementShape: shape,
        declaredCapabilities: row.declaredCapabilities,
        acceptanceCriterion: row.acceptanceCriterion,
        population: row.differentialPopulation,
      });
      expect(JSON.stringify(again), shape).toBe(JSON.stringify(run));
      // The checked surface is the FULL population; the citation is the
      // source proposal; the exercised capabilities are the declaration.
      expect(run.evaluatedCaseIds).toEqual(row.differentialPopulation.map((dcase) => dcase.caseId));
      expect(run.citedProposalId).toBe(row.sourceProposalId);
      expect(run.exercisedCapabilities).toEqual([...row.declaredCapabilities]);
      // Every outcome digest is the shape's deterministic reference
      // member, and every claim is the MECHANICAL criterion evaluation.
      for (const [index, outcome] of run.outcomes.entries()) {
        const dcase = row.differentialPopulation[index] as DifferentialCase;
        expect(outcome.caseId).toBe(dcase.caseId);
        expect(outcome.digest).toBe(
          referenceReplacementOutcomeDigestOf({
            shape,
            caseId: dcase.caseId,
            inputDigest: dcase.inputDigest,
            classDigests: dcase.classDigests,
          }),
        );
        expect(outcome.claimedEquivalent).toBe(
          criterionSatisfiedForCase({
            dcase,
            replacementDigest: outcome.digest,
            incumbentDigest: dcase.incumbentDigest,
            criterion: row.acceptanceCriterion,
          }),
        );
      }
      // The removed-call shape produces a NOVEL digest on every case
      // (the redundant call is gone by construction); the
      // deterministic-function shape reproduces the canonical member.
      if (shape === "removed-call") {
        for (const outcome of run.outcomes) {
          const dcase = row.differentialPopulation.find(
            (candidate) => candidate.caseId === outcome.caseId,
          );
          expect(outcome.digest).not.toBe(dcase?.incumbentDigest);
        }
      }
      if (shape === "deterministic-function") {
        for (const outcome of run.outcomes) {
          const dcase = row.differentialPopulation.find(
            (candidate) => candidate.caseId === outcome.caseId,
          );
          expect(outcome.digest).toBe(dcase?.classDigests.slice().sort()[0]);
        }
      }
    }
  });

  test("the digest + identity derivations are deterministic, canonical and discriminating", () => {
    const row = rowById("rag-deterministic-function-exact");
    const population = row.differentialPopulation;
    // Case digests are deterministic and discriminating (a perturbed
    // field changes the digest; the class member ORDER does not).
    const first = population[0] as DifferentialCase;
    expect(differentialCaseDigestOf(first)).toBe(differentialCaseDigestOf(first));
    expect(differentialCaseDigestOf({ ...first, caseId: `${first.caseId}-x` })).not.toBe(
      differentialCaseDigestOf(first),
    );
    expect(
      differentialCaseDigestOf({ ...first, classDigests: [...first.classDigests].reverse() }),
    ).toBe(differentialCaseDigestOf(first));
    // Population digests are order-independent and discriminating.
    expect(differentialPopulationDigestOf(population)).toBe(
      differentialPopulationDigestOf([...population].reverse()),
    );
    expect(differentialPopulationDigestOf(population.slice(0, 1))).not.toBe(
      differentialPopulationDigestOf(population),
    );
    // Verdict digests: stable for the same verdict shape, discriminating
    // across smoothed vs honest divergences.
    const honest: DifferentialEquivalenceVerdict = deriveDifferentialEquivalence(
      differentialBasisOf(row),
    );
    const honestRepeat = deriveDifferentialEquivalence(differentialBasisOf(row));
    expect(differentialVerdictDigestOf(honest)).toBe(differentialVerdictDigestOf(honestRepeat));
    const divergent = deriveDifferentialEquivalence(
      differentialBasisOf(rowById("reuse-removed-call-honest-divergence")),
    );
    expect(differentialVerdictDigestOf(divergent)).not.toBe(differentialVerdictDigestOf(honest));
    // Lifecycle evidence digests are discriminating per (proposal, stage,
    // members) — an evidence-less digest is the empty string the stage
    // discipline catches.
    const evidence = lifecycleEvidenceDigestOf({
      proposalId: row.sourceProposalId,
      stage: OFFLINE_REPLAY_STAGE,
      members: historicalIdentitiesOf(row),
    });
    expect(evidence).toMatch(/^[0-9a-f]{8}$/);
    expect(
      lifecycleEvidenceDigestOf({
        proposalId: row.sourceProposalId,
        stage: OFFLINE_REPLAY_STAGE,
        members: historicalIdentitiesOf(row).slice(0, 1),
      }),
    ).not.toBe(evidence);
    // The registry facts digest is deterministic and discriminating (a
    // rewritten proposal changes it).
    const registry = createCandidateRegistry();
    expect(registry.digest()).toBe(createCandidateRegistry().digest());
    const mutated = createCandidateRegistry();
    const entry = mutated.store().get(row.sourceProposalId);
    if (entry === undefined) {
      throw new Error(`the registry holds no pin for ${row.sourceProposalId}`);
    }
    mutated.store().set(row.sourceProposalId, { ...entry, lifecycleStage: "promoted" });
    expect(mutated.digest()).not.toBe(registry.digest());
  });

  test("the verdict-kind derivation orders its failure modes honestly", () => {
    const pass = deriveDifferentialEquivalence(
      differentialBasisOf(rowById("rag-deterministic-function-exact")),
    );
    const divergence = deriveDifferentialEquivalence(
      differentialBasisOf(rowById("reuse-removed-call-honest-divergence")),
    );
    const provenance = deriveProvenanceCompleteness(
      provenanceBasisOf(rowById("rag-deterministic-function-exact")),
    );
    const contained = deriveReplacementIsolation({
      declaredCapabilities: ["pure-computation"],
      grantedSurface: ["pure-computation"],
      exercisedCapabilities: ["pure-computation"],
    });
    const escaped = deriveReplacementIsolation({
      declaredCapabilities: ["pure-computation"],
      grantedSurface: ["pure-computation"],
      exercisedCapabilities: ["pure-computation", "network-access"],
    });
    // A refusal always wins (the honest refusal).
    expect(
      deriveEquivalenceVerdictKind({
        refusal: { reason: "proposal-unregistered" },
        isolation: escaped,
        differential: divergence,
        provenance,
      }),
    ).toBe("honest-refusal");
    // A containment violation beats the evaluation legs.
    expect(
      deriveEquivalenceVerdictKind({
        refusal: null,
        isolation: escaped,
        differential: pass,
        provenance,
      }),
    ).toBe("containment-violation");
    // A missing leg or an untrustworthy shape is evaluation-invalid.
    expect(
      deriveEquivalenceVerdictKind({
        refusal: null,
        isolation: contained,
        differential: null,
        provenance,
      }),
    ).toBe("evaluation-invalid");
    expect(
      deriveEquivalenceVerdictKind({
        refusal: null,
        isolation: contained,
        differential: pass,
        provenance: { ...provenance, complete: false },
      }),
    ).toBe("evaluation-invalid");
    const unchecked = { ...pass, fullyEvaluated: false };
    expect(
      deriveEquivalenceVerdictKind({
        refusal: null,
        isolation: contained,
        differential: unchecked,
        provenance,
      }),
    ).toBe("evaluation-invalid");
    const smoothed = { ...divergence, smoothedDivergences: divergence.divergences };
    expect(
      deriveEquivalenceVerdictKind({
        refusal: null,
        isolation: contained,
        differential: smoothed,
        provenance,
      }),
    ).toBe("evaluation-invalid");
    const unstated = { ...pass, criterionExplicit: false };
    expect(
      deriveEquivalenceVerdictKind({
        refusal: null,
        isolation: contained,
        differential: unstated,
        provenance,
      }),
    ).toBe("evaluation-invalid");
    // The honest terminal kinds.
    expect(
      deriveEquivalenceVerdictKind({
        refusal: null,
        isolation: contained,
        differential: divergence,
        provenance,
      }),
    ).toBe("honest-divergence");
    expect(
      deriveEquivalenceVerdictKind({
        refusal: null,
        isolation: contained,
        differential: pass,
        provenance,
      }),
    ).toBe("equivalence-pass");
  });
});

// ---------------------------------------------------------------------------
// The app contract over the fake-world knobs (the boundary catch)
// ---------------------------------------------------------------------------

describe("VAL-033 discrimination: the app contract over the fake-world knobs", () => {
  type Knobs = {
    readonly terminal?: "COMPLETED" | "FAILED";
    readonly uncited?: boolean;
    readonly partial?: boolean;
    readonly unchecked?: boolean;
    readonly smoothing?: boolean;
    readonly escaping?: boolean;
    readonly skipped?: boolean;
  };

  async function runAppWithKnobs(
    options: Knobs,
  ): Promise<Awaited<ReturnType<typeof runEquivalenceTestingApp>>> {
    const clock = createTickClock();
    const world = createEquivalenceFakeApiWorld({
      clock,
      ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
      ...(options.uncited === true ? { uncited: true } : {}),
      ...(options.partial === true ? { partial: true } : {}),
      ...(options.unchecked === true ? { unchecked: true } : {}),
      ...(options.smoothing === true ? { smoothing: true } : {}),
      ...(options.escaping === true ? { escaping: true } : {}),
      ...(options.skipped === true ? { skipped: true } : {}),
    });
    return runEquivalenceTestingApp({
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
      sleep: async (ms) => {
        clock.advance(ms);
      },
      environment: {
        runtime: "node test",
        toolchain: "vitest",
        database: "none",
        configuration: { suite: "val-033-discrimination" },
      },
      runSuffix: "discrimination",
      taskIndex: taskIndexOf("rag-deterministic-function-exact"),
    });
  }

  test("the honest world passes the boundary contract (the control)", async () => {
    const outcome = await runAppWithKnobs({});
    expect(outcome.passed).toBe(true);
    expect(outcome.appCriteria.filter((criterion) => criterion.status === "FAIL")).toEqual([]);
  });

  test("EVERY fake-world knob FAILs a specific boundary criterion (never a silent pass)", async () => {
    const knobToCriterion: readonly { readonly knob: Knobs; readonly criterionId: string }[] = [
      { knob: { terminal: "FAILED" }, criterionId: "app-expected-terminal" },
      { knob: { uncited: true }, criterionId: "app-lifecycle-landing-present" },
      { knob: { partial: true }, criterionId: "app-criterion-checked" },
      { knob: { unchecked: true }, criterionId: "app-outcomes-readable" },
      { knob: { smoothing: true }, criterionId: "app-divergence-honesty-no-smoothing" },
      { knob: { escaping: true }, criterionId: "app-isolation-no-escape" },
      { knob: { skipped: true }, criterionId: "app-lifecycle-landing-equivalence-stage-only" },
    ];
    for (const { knob, criterionId } of knobToCriterion) {
      const outcome = await runAppWithKnobs(knob);
      expect(outcome.passed, criterionId).toBe(false);
      const criterion = outcome.appCriteria.find((c) => c.criterionId === criterionId);
      expect(criterion, criterionId).toBeDefined();
      expect(criterion?.status, criterionId).toBe("FAIL");
    }
  });
});

// ---------------------------------------------------------------------------
// The lifecycle ledger exactly-once + the honest battery control
// ---------------------------------------------------------------------------

describe("VAL-033 discrimination: the ledger exactly-once and the honest control", () => {
  test("the lifecycle ledger is append-only exactly-once (replays and refusals)", async () => {
    const ledger = createLifecycleLedger();
    const record = {
      proposalId: "cand-learning-discovery-aaaaaaaa",
      toStage: OFFLINE_REPLAY_STAGE,
      evidenceDigest: lifecycleEvidenceDigestOf({
        proposalId: "cand-learning-discovery-aaaaaaaa",
        stage: OFFLINE_REPLAY_STAGE,
        members: ["exp-workload-replay-11111111"],
      }),
    };
    const first = await ledger.append(record);
    expect(first).toEqual({ accepted: true, replayed: false, refused: false });
    // The IDENTICAL re-append REPLAYS (idempotent — exactly-once).
    const second = await ledger.append(record);
    expect(second).toEqual({ accepted: true, replayed: true, refused: false });
    expect(ledger.transitionsFor(record.proposalId)).toHaveLength(1);
    // A DIFFERENT transition under the recorded key is REFUSED (the
    // identity's evidence is immutable).
    const impostor = await ledger.append({
      ...record,
      evidenceDigest: lifecycleEvidenceDigestOf({
        proposalId: record.proposalId,
        stage: OFFLINE_REPLAY_STAGE,
        members: ["exp-workload-replay-99999999"],
      }),
    });
    expect(impostor).toEqual({ accepted: false, replayed: false, refused: true });
    expect(ledger.transitionsFor(record.proposalId)).toHaveLength(1);
    // The refused impostor never landed.
    expect(ledger.landedProposalIds).toEqual([record.proposalId]);
    // The served transitions are defensive copies (a caller-side push
    // never mutates the ledger's own record).
    const served = ledger.transitionsFor(record.proposalId);
    expect(served).toHaveLength(1);
  });

  test("the honest control: every offline row's equivalence run behaves per its pin over the fixture stack", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const clock = createTickClock();
      const registry = createCandidateRegistry();
      const result = await driveEquivalenceRun({
        row,
        registry,
        ledger: createLifecycleLedger(),
        incumbentExecutor: createIncumbentExecutor(),
        replacementRuntime: createReplacementRuntime(),
        now: clock.now,
      });
      expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
      if (row.expected.verdict === "honest-divergence") {
        // The honest divergence FAILs its criterion leg honestly — the
        // divergence is recorded case-by-case, never smoothed — while
        // every OTHER leg passes.
        expect(
          result.criteria.find((c) => c.criterionId === "differential-criterion-satisfied")?.status,
          `${row.rowId} criterion satisfied`,
        ).toBe("FAIL");
        expect(
          result.criteria.find((c) => c.criterionId === "divergence-honesty-no-smoothing")?.status,
          `${row.rowId} honesty`,
        ).toBe("PASS");
      } else {
        const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
        expect(failed, `${row.rowId}: ${JSON.stringify(failed)}`).toEqual([]);
      }
      expect(result.verdict).toBe(row.expected.verdict);
      expect(result.observedModelCalls).toBe(0);
      expect(result.usage).toBeNull();
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  test("the honest control's registry facts view mirrors the pinned registry membership", () => {
    const registry = createCandidateRegistry();
    const facts = registry.facts();
    expect(facts.proposals.map((proposal) => proposal.proposalId).sort()).toEqual(
      PINNED_REGISTRY_ENTRIES.map((entry) => entry.proposalId).sort(),
    );
    // Every pinned member sits at the proposed stage (the read-only
    // input the equivalence slice advances FROM); zero applied candidates.
    for (const proposal of facts.proposals) {
      expect(proposal.lifecycleStage).toBe("proposed");
    }
    expect(facts.appliedCandidateCount).toBe(0);
    expect(equivalenceRegistryDigestOf(facts)).toBe(registry.digest());
  });
});
