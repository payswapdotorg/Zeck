/**
 * VAL-033 acceptance criteria 1, 2, 4, 5: the equivalence-testing
 * platform slice against controlled fakes — the replacement
 * vocabulary (the five shapes; the granted isolation surface's ALLOWED
 * capability set; the four escape directions; the containment
 * verdicts; the acceptance-criterion, verdict, refusal and probe
 * vocabularies; the lifecycle ladder's equivalence walk), the PURE
 * derivations that make a verdict trustworthy (the isolation matrix —
 * a contained pass and each escape direction FAILing; the
 * differential-equivalence matrix — an honest pass per criterion
 * kind, a divergence recorded honestly, an unstated/unchecked
 * criterion and a smoothed divergence each FAILing; the provenance
 * matrix — a full pass, an uncited verdict, a phantom citation, a
 * mismatched pin and each partial-population flavor FAILing; the
 * stage discipline — the honest walk passing while a skipped stage,
 * a jumped rung, an evidence-less transition and an out-of-scope
 * promotion each FAIL; the refusal honesty — justified refusals
 * passing while a hiding or malformed outcome FAILs), the digest
 * discipline (deterministic, canonical, payload-free), the identity
 * determinism, and the driver over every offline corpus row —
 * including the ADVERSARIAL worlds: the
 * ESCAPING/UNCITED/PARTIAL/UNCHECKED/SMOOTHING replacement-runtime
 * variants, the SKIP-STAGE/EVIDENCE-LESS/REWRITE-REGISTRY ledger
 * variants, the DIVERGENT incumbent executor and the dispatch seam
 * contract.
 */

import { describe, expect, test } from "vitest";
import {
  EQUIVALENCE_TESTING_CORPUS,
  OFFLINE_CORPUS_ROWS,
  PINNED_REGISTRY_ENTRIES,
  phantomProposalIdOf,
  pinnedRunOf,
  REGISTRY_SEED_PROPOSALS,
  singleReplayProposalPin,
} from "../../../benchmarks/validation/apps/equivalence-testing/corpus";
import {
  createCandidateRegistry,
  createIncumbentExecutor,
  createLifecycleLedger,
  createReplacementRuntime,
  createTickClock,
  type FakeLedgerVariant,
  type FakeReplacementRuntimeVariant,
} from "../../../benchmarks/validation/apps/equivalence-testing/fixtures";
import type {
  DifferentialCase,
  EquivalenceCorpusRow,
  EquivalenceRunResult,
} from "../../../benchmarks/validation/platform/equivalence-testing";
import {
  ACCEPTANCE_CRITERION_KINDS,
  CONTAINMENT_VERDICTS,
  deriveDifferentialEquivalence,
  deriveEquivalenceRefusalHonesty,
  deriveProvenanceCompleteness,
  deriveReplacementIsolation,
  deriveStageDiscipline,
  differentialVerdictDigestOf,
  driveEquivalenceRun,
  EQUIVALENCE_EXPERIMENT_KIND,
  EQUIVALENCE_LEARNING_PHASE,
  EQUIVALENCE_PROBE_KINDS,
  EQUIVALENCE_REFUSAL_REASONS,
  EQUIVALENCE_VERDICTS,
  EQUIVALENT_STAGE,
  ISOLATION_CAPABILITIES,
  ISOLATION_ESCAPE_DIRECTIONS,
  isAcceptanceCriterionKind,
  isBeyondEquivalenceScope,
  isEquivalenceProbeKind,
  isEquivalenceRefusalReason,
  isEquivalenceVerdictKind,
  isIsolationCapability,
  isIsolationEscapeDirection,
  isReplacementShape,
  lifecycleEvidenceDigestOf,
  lifecycleStageIndexOf,
  OFFLINE_REPLAY_STAGE,
  REPLACEMENT_SHAPES,
  referenceReplacementOutcomeDigestOf,
} from "../../../benchmarks/validation/platform/equivalence-testing";
import type { ControlDispatch } from "../../../benchmarks/validation/platform/longitudinal-baseline";

const rowById = (rowId: string): EquivalenceCorpusRow => {
  const row = EQUIVALENCE_TESTING_CORPUS.find((candidate) => candidate.rowId === rowId);
  if (row === undefined) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

/** Drive one offline row over a purpose-built fake stack. */
async function driveRowOverStack(options: {
  readonly row: EquivalenceCorpusRow;
  readonly runtimeVariant?: FakeReplacementRuntimeVariant;
  readonly ledgerVariant?: FakeLedgerVariant;
  readonly divergentIncumbent?: boolean;
  readonly dispatch?: ControlDispatch;
}): Promise<EquivalenceRunResult> {
  const clock = createTickClock();
  const registry = createCandidateRegistry();
  const ledger = createLifecycleLedger({
    ...(options.ledgerVariant === undefined ? {} : { variant: options.ledgerVariant }),
    registry,
  });
  return driveEquivalenceRun({
    row: options.row,
    registry,
    ledger,
    incumbentExecutor: createIncumbentExecutor({
      ...(options.divergentIncumbent === true ? { variant: "divergent" } : {}),
    }),
    replacementRuntime: createReplacementRuntime({
      ...(options.runtimeVariant === undefined ? {} : { variant: options.runtimeVariant }),
    }),
    ...(options.dispatch === undefined ? {} : { dispatch: options.dispatch }),
    now: clock.now,
  });
}

// ---------------------------------------------------------------------------
// The vocabulary + the lifecycle ladder
// ---------------------------------------------------------------------------

describe("VAL-033 platform vocabulary", () => {
  test("the equivalence vocabulary is pinned (equivalence tests and records, never promotes)", () => {
    expect(EQUIVALENCE_LEARNING_PHASE).toBe("equivalence");
    expect(EQUIVALENCE_EXPERIMENT_KIND).toBe("equivalence-testing");
  });

  test("the replacement-shape vocabulary is pinned (five shapes)", () => {
    expect(REPLACEMENT_SHAPES).toEqual([
      "deterministic-function",
      "retrieval-pipeline",
      "split-preprocessing-residual",
      "reusable-tool",
      "removed-call",
    ]);
    for (const shape of REPLACEMENT_SHAPES) {
      expect(isReplacementShape(shape)).toBe(true);
    }
    expect(isReplacementShape("model-rewrite")).toBe(false);
  });

  test("the isolation vocabulary is pinned (the ALLOWED surface + the four escape directions)", () => {
    expect(ISOLATION_CAPABILITIES).toEqual(["pure-computation", "granted-fixture-read"]);
    for (const capability of ISOLATION_CAPABILITIES) {
      expect(isIsolationCapability(capability)).toBe(true);
    }
    expect(isIsolationCapability("network-access")).toBe(false);
    expect(ISOLATION_ESCAPE_DIRECTIONS).toEqual([
      "network-access",
      "platform-state-mutation",
      "credential-access",
      "tenant-boundary-crossing",
    ]);
    for (const direction of ISOLATION_ESCAPE_DIRECTIONS) {
      expect(isIsolationEscapeDirection(direction)).toBe(true);
    }
    expect(isIsolationEscapeDirection("filesystem")).toBe(false);
    expect(CONTAINMENT_VERDICTS).toEqual(["contained", "violation"]);
  });

  test("the criterion / verdict / refusal / probe vocabularies are pinned", () => {
    expect(ACCEPTANCE_CRITERION_KINDS).toEqual([
      "exact-digest-equality",
      "digest-class-equality",
      "per-case-tolerance",
    ]);
    for (const kind of ACCEPTANCE_CRITERION_KINDS) {
      expect(isAcceptanceCriterionKind(kind)).toBe(true);
    }
    expect(isAcceptanceCriterionKind("eyeball")).toBe(false);
    expect(EQUIVALENCE_VERDICTS).toEqual([
      "equivalence-pass",
      "honest-divergence",
      "containment-violation",
      "honest-refusal",
      "evaluation-invalid",
    ]);
    for (const kind of EQUIVALENCE_VERDICTS) {
      expect(isEquivalenceVerdictKind(kind)).toBe(true);
    }
    expect(EQUIVALENCE_REFUSAL_REASONS).toEqual([
      "proposal-unregistered",
      "proposal-stage-not-proposed",
      "proposal-evidence-insufficient",
    ]);
    for (const reason of EQUIVALENCE_REFUSAL_REASONS) {
      expect(isEquivalenceRefusalReason(reason)).toBe(true);
    }
    expect(EQUIVALENCE_PROBE_KINDS).toEqual([
      "broken-provenance",
      "partial-population",
      "unchecked-criterion",
      "divergence-smoothing",
      "skipped-stage",
      "containment-escape",
    ]);
    for (const kind of EQUIVALENCE_PROBE_KINDS) {
      expect(isEquivalenceProbeKind(kind)).toBe(true);
    }
    expect(isEquivalenceProbeKind("empty-citation")).toBe(false);
  });

  test("the lifecycle ladder is pinned (equivalence-verified maps to differentially-evaluated ONLY)", () => {
    expect(EQUIVALENT_STAGE).toBe("differentially-evaluated");
    expect(OFFLINE_REPLAY_STAGE).toBe("offline-replayed");
    expect(lifecycleStageIndexOf("proposed")).toBe(2);
    expect(lifecycleStageIndexOf(OFFLINE_REPLAY_STAGE)).toBe(3);
    expect(lifecycleStageIndexOf(EQUIVALENT_STAGE)).toBe(4);
    // The equivalence slice's scope ends at differentially-evaluated:
    // everything past it is a later slice's act.
    expect(isBeyondEquivalenceScope("offline-replayed")).toBe(false);
    expect(isBeyondEquivalenceScope("differentially-evaluated")).toBe(false);
    for (const stage of [
      "property-tested",
      "mutation-tested",
      "shadow-executed",
      "canaried",
      "promoted",
    ]) {
      expect(isBeyondEquivalenceScope(stage as never)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Replacement isolation (the untrusted-code discipline)
// ---------------------------------------------------------------------------

describe("VAL-033 deriveReplacementIsolation", () => {
  test("a within-surface, within-declaration exercise is CONTAINED", () => {
    const verdict = deriveReplacementIsolation({
      declaredCapabilities: ["pure-computation", "granted-fixture-read"],
      grantedSurface: ["pure-computation", "granted-fixture-read"],
      exercisedCapabilities: ["pure-computation", "granted-fixture-read"],
    });
    expect(verdict.contained).toBe(true);
    expect(verdict.containment).toBe("contained");
    expect(verdict.escapeDirections).toEqual([]);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("an EMPTY granted surface with an empty exercise is contained (the removed-call shape)", () => {
    const verdict = deriveReplacementIsolation({
      declaredCapabilities: [],
      grantedSurface: [],
      exercisedCapabilities: [],
    });
    expect(verdict.contained).toBe(true);
  });

  test.each(ISOLATION_ESCAPE_DIRECTIONS)(
    "the %s escape direction is a containment VIOLATION (never silently forgiven)",
    (direction) => {
      const verdict = deriveReplacementIsolation({
        declaredCapabilities: ["pure-computation"],
        grantedSurface: ["pure-computation"],
        exercisedCapabilities: ["pure-computation", direction],
      });
      expect(verdict.contained).toBe(false);
      expect(verdict.containment).toBe("violation");
      expect(verdict.escapeDirections).toEqual([direction]);
      const escapeLeg = verdict.criteria.find(
        (criterion) => criterion.criterionId === "isolation-no-escape",
      );
      expect(escapeLeg?.status).toBe("FAIL");
      expect(escapeLeg?.evidence.join(" ")).toContain("CONTAINMENT-VIOLATION");
      expect(escapeLeg?.evidence.join(" ")).toContain(direction);
    },
  );

  test("a DECLARED capability outside the granted surface FAILs (an ungranted demand)", () => {
    const verdict = deriveReplacementIsolation({
      declaredCapabilities: ["pure-computation", "network-access"],
      grantedSurface: ["pure-computation"],
      exercisedCapabilities: ["pure-computation"],
    });
    expect(verdict.contained).toBe(false);
    expect(verdict.declaredNotGranted).toEqual(["network-access"]);
    expect(
      verdict.criteria.find(
        (criterion) => criterion.criterionId === "isolation-declared-within-surface",
      )?.status,
    ).toBe("FAIL");
  });

  test("an EXERCISED capability the replacement did not declare FAILs (an undeclared exercise)", () => {
    const verdict = deriveReplacementIsolation({
      declaredCapabilities: ["pure-computation"],
      grantedSurface: ["pure-computation", "granted-fixture-read"],
      exercisedCapabilities: ["pure-computation", "granted-fixture-read"],
    });
    expect(verdict.contained).toBe(false);
    expect(verdict.undeclaredExercises).toEqual(["granted-fixture-read"]);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "isolation-exercised-declared")
        ?.status,
    ).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// The differential evaluation oracle
// ---------------------------------------------------------------------------

describe("VAL-033 deriveDifferentialEquivalence", () => {
  /** A synthetic two-case population with single-member classes. */
  const population: readonly DifferentialCase[] = [
    {
      caseId: "case-a",
      source: "historical-replay",
      sourceRef: "exp-workload-replay-aaaaaaaa",
      inputDigest: "11111111",
      incumbentDigest: "aaaa1111",
      classDigests: ["aaaa1111"],
    },
    {
      caseId: "case-b",
      source: "adversarial",
      sourceRef: "adversarial-b",
      inputDigest: "22222222",
      incumbentDigest: "bbbb1111",
      classDigests: ["bbbb1111", "bbbb2222"],
    },
  ];
  const incumbentOutcomes = population.map((dcase) => ({
    caseId: dcase.caseId,
    digest: dcase.incumbentDigest,
  }));
  const evaluatedCaseIds = population.map((dcase) => dcase.caseId);

  test("an EXACT-DIGEST-EQUALITY pass over every case PASSES (checked, unsmoothed)", () => {
    const verdict = deriveDifferentialEquivalence({
      population,
      criterion: { kind: "exact-digest-equality" },
      incumbentOutcomes,
      replacementOutcomes: population.map((dcase) => ({
        caseId: dcase.caseId,
        digest: dcase.incumbentDigest,
        claimedEquivalent: true,
      })),
      evaluatedCaseIds,
    });
    expect(verdict.equivalent).toBe(true);
    expect(verdict.criterionExplicit).toBe(true);
    expect(verdict.fullyEvaluated).toBe(true);
    expect(verdict.divergences).toEqual([]);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("a DIGEST-CLASS-EQUALITY pass over a two-member class PASSES (equality not required)", () => {
    const verdict = deriveDifferentialEquivalence({
      population,
      criterion: { kind: "digest-class-equality" },
      incumbentOutcomes,
      replacementOutcomes: population.map((dcase) => ({
        caseId: dcase.caseId,
        // case-b's replacement answers with the OTHER class member.
        digest: dcase.caseId === "case-b" ? "bbbb2222" : dcase.incumbentDigest,
        claimedEquivalent: true,
      })),
      evaluatedCaseIds,
    });
    expect(verdict.equivalent).toBe(true);
    expect(verdict.divergences).toEqual([]);
  });

  test("a PER-CASE-TOLERANCE pass over an explicitly tolerated divergence PASSES", () => {
    const verdict = deriveDifferentialEquivalence({
      population,
      criterion: { kind: "per-case-tolerance", toleratedCaseIds: ["case-b"] },
      incumbentOutcomes,
      replacementOutcomes: population.map((dcase) => ({
        caseId: dcase.caseId,
        digest: dcase.caseId === "case-b" ? "cccc1111" : dcase.incumbentDigest,
        claimedEquivalent: true,
      })),
      evaluatedCaseIds,
    });
    expect(verdict.equivalent).toBe(true);
    // The tolerated divergence is NOT a divergence under the criterion.
    expect(verdict.divergences).toEqual([]);
  });

  test("an HONEST DIVERGENCE is recorded case-by-case (never smoothed) and FAILs", () => {
    const verdict = deriveDifferentialEquivalence({
      population,
      criterion: { kind: "exact-digest-equality" },
      incumbentOutcomes,
      replacementOutcomes: population.map((dcase) => ({
        caseId: dcase.caseId,
        digest: dcase.caseId === "case-a" ? "dddd1111" : dcase.incumbentDigest,
        claimedEquivalent: dcase.caseId !== "case-a",
      })),
      evaluatedCaseIds,
    });
    expect(verdict.equivalent).toBe(false);
    expect(verdict.divergences).toHaveLength(1);
    expect(verdict.divergences[0]?.caseId).toBe("case-a");
    expect(verdict.divergences[0]?.incumbentDigest).toBe("aaaa1111");
    expect(verdict.divergences[0]?.replacementDigest).toBe("dddd1111");
    expect(verdict.smoothedDivergences).toEqual([]);
    const divergence = verdict.criteria.find(
      (criterion) => criterion.criterionId === "differential-criterion-satisfied",
    );
    expect(divergence?.status).toBe("FAIL");
    expect(divergence?.evidence.join(" ")).toContain("HONEST-DIVERGENCE");
    // The honest recording itself passes the honesty leg.
    expect(
      verdict.criteria.find(
        (criterion) => criterion.criterionId === "divergence-honesty-no-smoothing",
      )?.status,
    ).toBe("PASS");
  });

  test("a SMOOTHED divergence (a divergent case claimed equivalent) FAILs the honesty leg", () => {
    const verdict = deriveDifferentialEquivalence({
      population,
      criterion: { kind: "exact-digest-equality" },
      incumbentOutcomes,
      replacementOutcomes: population.map((dcase) => ({
        caseId: dcase.caseId,
        digest: dcase.caseId === "case-a" ? "dddd1111" : dcase.incumbentDigest,
        claimedEquivalent: true,
      })),
      evaluatedCaseIds,
    });
    expect(verdict.equivalent).toBe(false);
    expect(verdict.smoothedDivergences).toHaveLength(1);
    expect(verdict.smoothedDivergences[0]?.caseId).toBe("case-a");
    const smoothing = verdict.criteria.find(
      (criterion) => criterion.criterionId === "divergence-honesty-no-smoothing",
    );
    expect(smoothing?.status).toBe("FAIL");
    expect(smoothing?.evidence.join(" ")).toContain("DIVERGENCE-SMOOTHING");
  });

  test("an UNSTATED criterion FAILs (a replacement accepted under no criterion)", () => {
    const verdict = deriveDifferentialEquivalence({
      population,
      criterion: null,
      incumbentOutcomes,
      replacementOutcomes: population.map((dcase) => ({
        caseId: dcase.caseId,
        digest: dcase.incumbentDigest,
        claimedEquivalent: true,
      })),
      evaluatedCaseIds,
    });
    expect(verdict.equivalent).toBe(false);
    expect(verdict.criterionExplicit).toBe(false);
    expect(verdict.criterionKind).toBeNull();
    const explicit = verdict.criteria.find(
      (criterion) => criterion.criterionId === "criterion-explicit",
    );
    expect(explicit?.status).toBe("FAIL");
    expect(explicit?.evidence.join(" ")).toContain("UNSTATED-CRITERION");
  });

  test("an UNCHECKED criterion FAILs (stated but never checked)", () => {
    const verdict = deriveDifferentialEquivalence({
      population,
      criterion: { kind: "exact-digest-equality" },
      incumbentOutcomes,
      replacementOutcomes: population.map((dcase) => ({
        caseId: dcase.caseId,
        digest: dcase.incumbentDigest,
        claimedEquivalent: true,
      })),
      evaluatedCaseIds: [],
    });
    expect(verdict.equivalent).toBe(false);
    expect(verdict.fullyEvaluated).toBe(false);
    expect(verdict.unevaluatedCaseIds).toEqual(["case-a", "case-b"]);
    const checked = verdict.criteria.find(
      (criterion) => criterion.criterionId === "criterion-checked",
    );
    expect(checked?.status).toBe("FAIL");
    expect(checked?.evidence.join(" ")).toContain("UNCHECKED-CRITERION");
  });

  test("a PARTIAL evaluation (a checkable-but-unchecked case) FAILs with the case named", () => {
    const verdict = deriveDifferentialEquivalence({
      population,
      criterion: { kind: "exact-digest-equality" },
      incumbentOutcomes,
      replacementOutcomes: [{ caseId: "case-a", digest: "aaaa1111", claimedEquivalent: true }],
      evaluatedCaseIds: ["case-a"],
    });
    expect(verdict.fullyEvaluated).toBe(false);
    expect(verdict.unevaluatedCaseIds).toEqual(["case-b"]);
    expect(verdict.missingOutcomeCaseIds).toEqual(["case-b"]);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "criterion-checked")?.status,
    ).toBe("FAIL");
  });

  test("a MALFORMED tolerance (a tolerated id outside the population) FAILs", () => {
    const verdict = deriveDifferentialEquivalence({
      population,
      criterion: { kind: "per-case-tolerance", toleratedCaseIds: ["case-a", "phantom-case"] },
      incumbentOutcomes,
      replacementOutcomes: population.map((dcase) => ({
        caseId: dcase.caseId,
        digest: dcase.incumbentDigest,
        claimedEquivalent: true,
      })),
      evaluatedCaseIds,
    });
    expect(verdict.equivalent).toBe(false);
    expect(
      verdict.criteria.find(
        (criterion) => criterion.criterionId === "criterion-well-formed-tolerance",
      )?.status,
    ).toBe("FAIL");
    expect(
      verdict.criteria
        .find((criterion) => criterion.criterionId === "criterion-well-formed-tolerance")
        ?.evidence.join(" "),
    ).toContain("MALFORMED-CRITERION");
  });

  test("a satisfied case claimed NON-equivalent is a false-divergence claim (an honesty defect)", () => {
    const verdict = deriveDifferentialEquivalence({
      population,
      criterion: { kind: "exact-digest-equality" },
      incumbentOutcomes,
      replacementOutcomes: population.map((dcase) => ({
        caseId: dcase.caseId,
        digest: dcase.incumbentDigest,
        claimedEquivalent: dcase.caseId !== "case-a",
      })),
      evaluatedCaseIds,
    });
    expect(verdict.smoothedDivergences).toHaveLength(1);
    expect(verdict.smoothedDivergences[0]?.caseId).toBe("case-a");
  });
});

// ---------------------------------------------------------------------------
// Provenance completeness (the verdict cites its proposal + its full population)
// ---------------------------------------------------------------------------

describe("VAL-033 deriveProvenanceCompleteness", () => {
  const registryProposalIds = [
    "cand-learning-discovery-aaaaaaaa",
    "cand-learning-discovery-bbbbbbbb",
  ];
  const proposalCitation = ["exp-workload-replay-11111111", "exp-workload-replay-22222222"];
  const pinnedAdversarial = ["adversarial-row-1", "adversarial-row-2"];
  const fullInput = {
    registryProposalIds,
    expectedProposalId: "cand-learning-discovery-aaaaaaaa",
    citedProposalId: "cand-learning-discovery-aaaaaaaa",
    proposalCitedReplayIdentities: proposalCitation,
    pinnedAdversarialCaseIds: pinnedAdversarial,
    coveredReplayIdentities: proposalCitation,
    coveredAdversarialCaseIds: pinnedAdversarial,
  };

  test("a COMPLETE provenance chain (cited proposal + full population) PASSES", () => {
    const verdict = deriveProvenanceCompleteness(fullInput);
    expect(verdict.complete).toBe(true);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("an UNCITED verdict (no proposal citation) FAILs", () => {
    const verdict = deriveProvenanceCompleteness({ ...fullInput, citedProposalId: null });
    expect(verdict.complete).toBe(false);
    const cited = verdict.criteria.find(
      (criterion) => criterion.criterionId === "provenance-proposal-cited",
    );
    expect(cited?.status).toBe("FAIL");
    expect(cited?.evidence.join(" ")).toContain("UNCITED-VERDICT");
  });

  test("a PHANTOM citation (an id the registry never recorded) FAILs", () => {
    const verdict = deriveProvenanceCompleteness({
      ...fullInput,
      citedProposalId: "cand-learning-discovery-cccccccc",
    });
    expect(verdict.complete).toBe(false);
    expect(
      verdict.criteria
        .find((criterion) => criterion.criterionId === "provenance-proposal-cited")
        ?.evidence.join(" "),
    ).toContain("PHANTOM-CITATION");
  });

  test("a citation that mismatches the row's pinned proposal FAILs", () => {
    const verdict = deriveProvenanceCompleteness({
      ...fullInput,
      citedProposalId: "cand-learning-discovery-bbbbbbbb",
    });
    expect(verdict.complete).toBe(false);
    expect(
      verdict.criteria.find(
        (criterion) => criterion.criterionId === "provenance-proposal-matches-pin",
      )?.status,
    ).toBe("FAIL");
  });

  test("a PARTIAL population missing the ADVERSARIAL cases FAILs", () => {
    const verdict = deriveProvenanceCompleteness({
      ...fullInput,
      coveredAdversarialCaseIds: ["adversarial-row-1"],
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.missingAdversarialCaseIds).toEqual(["adversarial-row-2"]);
    const full = verdict.criteria.find(
      (criterion) => criterion.criterionId === "provenance-full-population",
    );
    expect(full?.status).toBe("FAIL");
    expect(full?.evidence.join(" ")).toContain("PARTIAL-POPULATION");
  });

  test("a PARTIAL population missing a CITED replay identity FAILs", () => {
    const verdict = deriveProvenanceCompleteness({
      ...fullInput,
      coveredReplayIdentities: [proposalCitation[0] ?? ""],
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.missingReplayIdentities).toEqual([proposalCitation[1]]);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "provenance-full-population")
        ?.status,
    ).toBe("FAIL");
  });

  test("a FABRICATED coverage (a covered identity the proposal never cited) FAILs", () => {
    const verdict = deriveProvenanceCompleteness({
      ...fullInput,
      coveredReplayIdentities: [...proposalCitation, "exp-workload-replay-99999999"],
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.fabricatedReplayIdentities).toEqual(["exp-workload-replay-99999999"]);
    expect(
      verdict.criteria
        .find((criterion) => criterion.criterionId === "provenance-no-fabricated-coverage")
        ?.evidence.join(" "),
    ).toContain("FABRICATED-POPULATION");
  });
});

// ---------------------------------------------------------------------------
// Stage discipline (proposed → offline-replayed → differentially-evaluated ONLY)
// ---------------------------------------------------------------------------

describe("VAL-033 deriveStageDiscipline", () => {
  const evidence = (stage: string): string =>
    lifecycleEvidenceDigestOf({ proposalId: "cand-1", stage: stage as never, members: ["m"] });

  test("the honest walk (proposed → offline-replayed → differentially-evaluated, evidenced) PASSES", () => {
    const verdict = deriveStageDiscipline({
      proposalStage: "proposed",
      transitions: [
        {
          proposalId: "cand-1",
          toStage: "offline-replayed",
          evidenceDigest: evidence("offline-replayed"),
          ordinal: 1,
        },
        {
          proposalId: "cand-1",
          toStage: "differentially-evaluated",
          evidenceDigest: evidence("differentially-evaluated"),
          ordinal: 2,
        },
      ],
      expectedLanding: true,
    });
    expect(verdict.disciplined).toBe(true);
    expect(verdict.walk).toEqual(["offline-replayed", "differentially-evaluated"]);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("a walk that lands PAST the equivalence stage FAILs (a skipped-stage promotion)", () => {
    for (const beyond of ["shadow-executed", "canaried", "promoted"] as const) {
      const verdict = deriveStageDiscipline({
        proposalStage: "proposed",
        transitions: [
          {
            proposalId: "cand-1",
            toStage: "offline-replayed",
            evidenceDigest: evidence("offline-replayed"),
            ordinal: 1,
          },
          { proposalId: "cand-1", toStage: beyond, evidenceDigest: evidence(beyond), ordinal: 2 },
        ],
        expectedLanding: true,
      });
      expect(verdict.disciplined).toBe(false);
      expect(verdict.beyondScopeStages).toEqual([beyond]);
      const never = verdict.criteria.find(
        (criterion) => criterion.criterionId === "stage-discipline-never-beyond-equivalence",
      );
      expect(never?.status).toBe("FAIL");
      expect(never?.evidence.join(" ")).toContain("SKIPPED-STAGE");
    }
  });

  test("a walk that JUMPS a rung (offline-replayed skipped) FAILs", () => {
    const verdict = deriveStageDiscipline({
      proposalStage: "proposed",
      transitions: [
        {
          proposalId: "cand-1",
          toStage: "differentially-evaluated",
          evidenceDigest: evidence("differentially-evaluated"),
          ordinal: 1,
        },
      ],
      expectedLanding: true,
    });
    expect(verdict.disciplined).toBe(false);
    expect(verdict.skippedStageTransitions).toHaveLength(1);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "stage-discipline-no-jumps")
        ?.status,
    ).toBe("FAIL");
  });

  test("an EVIDENCE-LESS transition FAILs", () => {
    const verdict = deriveStageDiscipline({
      proposalStage: "proposed",
      transitions: [
        { proposalId: "cand-1", toStage: "offline-replayed", evidenceDigest: "", ordinal: 1 },
        {
          proposalId: "cand-1",
          toStage: "differentially-evaluated",
          evidenceDigest: evidence("differentially-evaluated"),
          ordinal: 2,
        },
      ],
      expectedLanding: true,
    });
    expect(verdict.disciplined).toBe(false);
    expect(verdict.evidenceLessOrdinals).toEqual([1]);
    const evidenced = verdict.criteria.find(
      (criterion) => criterion.criterionId === "stage-discipline-every-transition-evidenced",
    );
    expect(evidenced?.status).toBe("FAIL");
    expect(evidenced?.evidence.join(" ")).toContain("EVIDENCE-LESS-TRANSITION");
  });

  test("a walk starting from a NON-PROPOSED candidate FAILs", () => {
    const verdict = deriveStageDiscipline({
      proposalStage: "observed",
      transitions: [],
      expectedLanding: false,
    });
    expect(verdict.disciplined).toBe(false);
    expect(
      verdict.criteria.find(
        (criterion) => criterion.criterionId === "stage-discipline-source-proposed",
      )?.status,
    ).toBe("FAIL");
  });

  test("an expected landing with an EMPTY walk FAILs the landing leg", () => {
    const verdict = deriveStageDiscipline({
      proposalStage: "proposed",
      transitions: [],
      expectedLanding: true,
    });
    expect(verdict.disciplined).toBe(false);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "stage-discipline-landing")
        ?.status,
    ).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// Refusal honesty (a refusal is justified by the registry's own state)
// ---------------------------------------------------------------------------

describe("VAL-033 deriveEquivalenceRefusalHonesty", () => {
  test("the proposal-unregistered refusal is honest (a phantom identity)", () => {
    const verdict = deriveEquivalenceRefusalHonesty({
      refusal: { reason: "proposal-unregistered" },
      evaluationEmitted: false,
      registryEntry: null,
    });
    expect(verdict.honest).toBe(true);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("the proposal-evidence-insufficient refusal is honest (a single-replay citation)", () => {
    const verdict = deriveEquivalenceRefusalHonesty({
      refusal: { reason: "proposal-evidence-insufficient" },
      evaluationEmitted: false,
      registryEntry: {
        lifecycleStage: "proposed",
        citation: {
          trajectoryDigests: ["11111111"],
          replayIdentities: ["exp-workload-replay-11111111"],
        },
      },
    });
    expect(verdict.honest).toBe(true);
  });

  test("the proposal-stage-not-proposed refusal is honest (an observed-stage entry)", () => {
    const verdict = deriveEquivalenceRefusalHonesty({
      refusal: { reason: "proposal-stage-not-proposed" },
      evaluationEmitted: false,
      registryEntry: {
        lifecycleStage: "observed",
        citation: { trajectoryDigests: [], replayIdentities: [] },
      },
    });
    expect(verdict.honest).toBe(true);
  });

  test("a HIDING refusal (a testable proposal refused anyway) FAILs", () => {
    const verdict = deriveEquivalenceRefusalHonesty({
      refusal: { reason: "proposal-unregistered" },
      evaluationEmitted: false,
      registryEntry: {
        lifecycleStage: "proposed",
        citation: {
          trajectoryDigests: ["11111111", "22222222"],
          replayIdentities: ["exp-workload-replay-11111111", "exp-workload-replay-22222222"],
        },
      },
    });
    expect(verdict.honest).toBe(false);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "refusal-justified")?.status,
    ).toBe("FAIL");
    expect(
      verdict.criteria
        .find((criterion) => criterion.criterionId === "refusal-justified")
        ?.evidence.join(" "),
    ).toContain("UNJUSTIFIED-REFUSAL");
  });

  test("a MALFORMED outcome (a refusal alongside an evaluation) FAILs", () => {
    const verdict = deriveEquivalenceRefusalHonesty({
      refusal: { reason: "proposal-unregistered" },
      evaluationEmitted: true,
      registryEntry: null,
    });
    expect(verdict.honest).toBe(false);
    expect(
      verdict.criteria
        .find((criterion) => criterion.criterionId === "refusal-well-formed")
        ?.evidence.join(" "),
    ).toContain("MALFORMED-OUTCOME");
  });
});

// ---------------------------------------------------------------------------
// The digest discipline + identity determinism + the corpus pins
// ---------------------------------------------------------------------------

describe("VAL-033 digest discipline + identity determinism + the corpus pins", () => {
  test("the corpus pins are internally consistent (populations, verdicts, registry membership)", () => {
    for (const row of EQUIVALENCE_TESTING_CORPUS) {
      // The expected verdict is the honest derivation over the pinned
      // population (the pure oracle).
      const { differential } = pinnedRunOf(row);
      if (row.expected.verdict === "honest-refusal") {
        expect(row.expected.refusalReason).not.toBeNull();
        expect(row.expected.divergenceCaseIds).toEqual([]);
      } else if (row.expected.verdict === "honest-divergence") {
        expect(differential.equivalent).toBe(false);
        expect(row.expected.divergenceCaseIds).toEqual(
          differential.divergences.map((divergence) => divergence.caseId),
        );
      } else {
        expect(differential.equivalent, row.rowId).toBe(true);
        expect(row.expected.divergenceCaseIds).toEqual([]);
      }
      // Every source proposal (except the phantom) is a registry member.
      if (row.rowId !== "unregistered-proposal-refusal") {
        expect(
          REGISTRY_SEED_PROPOSALS.some((pin) => pin.proposalId === row.sourceProposalId),
          row.rowId,
        ).toBe(true);
      } else {
        expect(REGISTRY_SEED_PROPOSALS.some((pin) => pin.proposalId === row.sourceProposalId)).toBe(
          false,
        );
      }
      // The differential population carries both halves.
      expect(
        row.differentialPopulation.filter((dcase) => dcase.source === "historical-replay").length,
      ).toBeGreaterThanOrEqual(2);
      expect(
        row.differentialPopulation.filter((dcase) => dcase.source === "adversarial").length,
      ).toBe(2);
      // The pinned trajectory class is the canonical trajectory's
      // single-member class.
      expect(row.expectedTrajectoryClass).toHaveLength(1);
      expect(row.expectedTrajectoryClass[0]).toMatch(/^[0-9a-f]{8}$/);
      // Every case's digests are payload-free FNV-1a constants.
      for (const dcase of row.differentialPopulation) {
        expect(dcase.inputDigest).toMatch(/^[0-9a-f]{8}$/);
        expect(dcase.incumbentDigest).toMatch(/^[0-9a-f]{8}$/);
        for (const digest of dcase.classDigests) {
          expect(digest).toMatch(/^[0-9a-f]{8}$/);
        }
        if (dcase.source === "historical-replay") {
          expect(dcase.caseId).toMatch(/^exp-workload-replay-[0-9a-f]{8}$/);
        }
      }
    }
  });

  test("the historical cases are the proposals' own citations (the read-only input)", () => {
    for (const row of EQUIVALENCE_TESTING_CORPUS) {
      if (row.expected.verdict === "honest-refusal") {
        continue; // the refusal rows never execute their declared population
      }
      const pin = PINNED_REGISTRY_ENTRIES.find(
        (candidate) => candidate.proposalId === row.sourceProposalId,
      );
      if (pin === undefined) {
        continue; // the phantom row cites no registry member
      }
      const historical = row.differentialPopulation
        .filter((dcase) => dcase.source === "historical-replay")
        .map((dcase) => dcase.sourceRef);
      expect([...new Set(historical)].sort()).toEqual(
        [...new Set(pin.citation.replayIdentities)].sort(),
      );
    }
  });

  test("the reference replacement digest is deterministic, canonical and discriminating", () => {
    const basis = {
      shape: "reusable-tool" as const,
      caseId: "case-a",
      inputDigest: "11111111",
      classDigests: ["aaaa1111", "bbbb2222"],
    };
    const first = referenceReplacementOutcomeDigestOf(basis);
    expect(referenceReplacementOutcomeDigestOf(basis)).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{8}$/);
    // A different shape/class/case selects differently.
    expect(referenceReplacementOutcomeDigestOf({ ...basis, shape: "deterministic-function" })).toBe(
      "aaaa1111",
    );
    expect(referenceReplacementOutcomeDigestOf({ ...basis, caseId: "case-b" })).not.toBe(first);
    // The removed-call shape NEVER lands on a class member (the call
    // is gone: a novel digest by construction).
    const removed = referenceReplacementOutcomeDigestOf({
      shape: "removed-call",
      caseId: "case-a",
      inputDigest: "11111111",
      classDigests: ["aaaa1111"],
    });
    expect(removed).not.toBe("aaaa1111");
    expect(removed).toMatch(/^[0-9a-f]{8}$/);
  });

  test("the verdict digest + the lifecycle evidence digest are canonical and discriminating", () => {
    const verdictA = deriveDifferentialEquivalence({
      population: [],
      criterion: { kind: "exact-digest-equality" },
      incumbentOutcomes: [],
      replacementOutcomes: [],
      evaluatedCaseIds: [],
    });
    const verdictB = deriveDifferentialEquivalence({
      population: [],
      criterion: { kind: "digest-class-equality" },
      incumbentOutcomes: [],
      replacementOutcomes: [],
      evaluatedCaseIds: [],
    });
    expect(differentialVerdictDigestOf(verdictA)).toBe(differentialVerdictDigestOf(verdictA));
    expect(differentialVerdictDigestOf(verdictA)).not.toBe(differentialVerdictDigestOf(verdictB));
    expect(
      lifecycleEvidenceDigestOf({
        proposalId: "cand-1",
        stage: "offline-replayed",
        members: ["a"],
      }),
    ).not.toBe(
      lifecycleEvidenceDigestOf({
        proposalId: "cand-1",
        stage: "differentially-evaluated",
        members: ["a"],
      }),
    );
  });

  test("the structural digests never leak payload bytes", () => {
    for (const row of EQUIVALENCE_TESTING_CORPUS) {
      for (const dcase of row.differentialPopulation) {
        for (const digest of [dcase.inputDigest, dcase.incumbentDigest, ...dcase.classDigests]) {
          expect(digest).not.toContain("CIT-201");
          expect(digest).not.toContain("ORD-501");
          expect(digest).not.toContain("notify");
          expect(digest).not.toContain("summary");
        }
      }
    }
  });

  test("the corpus's verdict distribution is pinned (10 passes incl. 6 probes / 1 divergence / 2 refusals / 1 live)", () => {
    const offline = OFFLINE_CORPUS_ROWS;
    expect(offline.filter((row) => row.expected.verdict === "equivalence-pass")).toHaveLength(10);
    // Every probe row is an honest pass over the honest stack (the
    // adversarial variants FAIL in the discrimination phases).
    for (const row of offline.filter((candidate) => candidate.probe !== undefined)) {
      expect(row.expected.verdict).toBe("equivalence-pass");
    }
    expect(offline.filter((row) => row.expected.verdict === "honest-divergence")).toHaveLength(1);
    expect(offline.filter((row) => row.expected.verdict === "honest-refusal")).toHaveLength(2);
    expect(offline.filter((row) => row.probe !== undefined)).toHaveLength(6);
    expect(EQUIVALENCE_TESTING_CORPUS).toHaveLength(offline.length + 1);
    const live = EQUIVALENCE_TESTING_CORPUS[EQUIVALENCE_TESTING_CORPUS.length - 1];
    expect(live?.needsDispatch).toBe(true);
    expect(live?.liveGate?.envVars).toEqual(["OPENROUTER_API_KEY"]);
    expect(live?.expected.modelCalls).toBe(1);
    // The registry seed: 6 honest VAL-032 identities + the degenerate entry.
    expect(REGISTRY_SEED_PROPOSALS).toHaveLength(7);
    expect(singleReplayProposalPin().citation.replayIdentities).toHaveLength(1);
    expect(phantomProposalIdOf()).toMatch(/^cand-learning-discovery-[0-9a-f]{8}$/);
  });
});

// ---------------------------------------------------------------------------
// The driver over every offline row (the honest stack)
// ---------------------------------------------------------------------------

describe("VAL-033 driver over the honest offline corpus", () => {
  test("every offline row reaches its oracle terminal (honest rows all-PASS; the divergence FAILs honestly)", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const result = await driveRowOverStack({ row });
      expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
      const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
      if (row.expected.terminal === "COMPLETED") {
        expect(failed, `${row.rowId}: ${JSON.stringify(failed)}`).toEqual([]);
      } else {
        // The honest-divergence row: exactly the divergence pair FAILs
        // (the criterion divergence + its summary) — recorded, never
        // smoothed, and every honesty leg PASSES.
        expect(failed.map((criterion) => criterion.criterionId)).toEqual([
          "differential-criterion-satisfied",
          "differential-equivalence-summary",
        ]);
        expect(
          result.criteria.find(
            (criterion) => criterion.criterionId === "divergence-honesty-no-smoothing",
          )?.status,
        ).toBe("PASS");
      }
      // The verdict reproduces the pinned oracle.
      expect(result.verdict).toBe(row.expected.verdict);
      expect(result.refusal?.reason ?? null).toBe(row.expected.refusalReason);
      expect(result.differential?.divergences.map((divergence) => divergence.caseId) ?? []).toEqual(
        row.expected.divergenceCaseIds,
      );
      // Latency is always measured; usage is honestly null offline.
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.usage).toBeNull();
      expect(result.observedModelCalls).toBe(0);
    }
  });

  test("the equivalence-pass rows append the evidenced equivalence walk to the lifecycle", async () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) => candidate.expected.verdict === "equivalence-pass",
    )) {
      const clock = createTickClock();
      const registry = createCandidateRegistry();
      const ledger = createLifecycleLedger();
      const result = await driveEquivalenceRun({
        row,
        registry,
        ledger,
        incumbentExecutor: createIncumbentExecutor(),
        replacementRuntime: createReplacementRuntime(),
        now: clock.now,
      });
      expect(result.isolation?.contained).toBe(true);
      expect(result.differential?.equivalent).toBe(true);
      expect(result.provenance?.complete).toBe(true);
      expect(result.stageDiscipline?.disciplined).toBe(true);
      expect(result.ledgerLanding?.accepted).toBe(true);
      // The walk is exactly the equivalence walk, each transition evidenced.
      const walk = ledger
        .transitionsFor(row.sourceProposalId)
        .map((transition) => transition.toStage);
      expect(walk).toEqual(["offline-replayed", "differentially-evaluated"]);
      for (const transition of ledger.transitionsFor(row.sourceProposalId)) {
        expect(transition.evidenceDigest).toMatch(/^[0-9a-f]{8}$/);
      }
      expect(ledger.landedProposalIds).toEqual([row.sourceProposalId]);
    }
  });

  test("the honest-divergence row records its divergences case-by-case and still lands the evaluation", async () => {
    const row = rowById("reuse-removed-call-honest-divergence");
    const clock = createTickClock();
    const registry = createCandidateRegistry();
    const ledger = createLifecycleLedger();
    const result = await driveEquivalenceRun({
      row,
      registry,
      ledger,
      incumbentExecutor: createIncumbentExecutor(),
      replacementRuntime: createReplacementRuntime(),
      now: clock.now,
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("honest-divergence");
    // Every case diverged under the exact criterion — recorded honestly.
    expect(result.differential?.divergences).toHaveLength(row.differentialPopulation.length);
    expect(result.differential?.smoothedDivergences).toEqual([]);
    expect(
      result.criteria.find(
        (criterion) => criterion.criterionId === "differential-criterion-satisfied",
      )?.status,
    ).toBe("FAIL");
    expect(
      result.criteria.find(
        (criterion) => criterion.criterionId === "divergence-honesty-no-smoothing",
      )?.status,
    ).toBe("PASS");
    // The evaluation happened: the verdict still appends the walk.
    expect(result.ledgerLanding?.accepted).toBe(true);
    expect(ledger.transitionsFor(row.sourceProposalId).map((t) => t.toStage)).toEqual([
      "offline-replayed",
      "differentially-evaluated",
    ]);
  });

  test("the refusal rows refuse honestly and append NOTHING to the lifecycle", async () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) => candidate.expected.verdict === "honest-refusal",
    )) {
      const clock = createTickClock();
      const registry = createCandidateRegistry();
      const ledger = createLifecycleLedger();
      const result = await driveEquivalenceRun({
        row,
        registry,
        ledger,
        incumbentExecutor: createIncumbentExecutor(),
        replacementRuntime: createReplacementRuntime(),
        now: clock.now,
      });
      expect(result.terminal).toBe("COMPLETED");
      expect(result.verdict).toBe("honest-refusal");
      expect(result.refusal?.reason).toBe(row.expected.refusalReason);
      expect(result.refusalHonesty?.honest).toBe(true);
      // Nothing executed, nothing landed.
      expect(result.differential).toBeNull();
      expect(result.ledgerLanding).toBeNull();
      expect(ledger.landedProposalIds).toEqual([]);
    }
  });

  test("the lifecycle ledger is append-only: an identical re-append REPLAYS, an impostor is REFUSED", async () => {
    const ledger = createLifecycleLedger();
    const record = {
      proposalId: "cand-learning-discovery-aaaaaaaa",
      toStage: "offline-replayed" as const,
      evidenceDigest: lifecycleEvidenceDigestOf({
        proposalId: "cand-learning-discovery-aaaaaaaa",
        stage: "offline-replayed",
        members: ["exp-workload-replay-11111111"],
      }),
    };
    const first = await ledger.append(record);
    expect(first.accepted).toBe(true);
    expect(first.replayed).toBe(false);
    const second = await ledger.append(record);
    expect(second.accepted).toBe(true);
    expect(second.replayed).toBe(true);
    expect(ledger.transitionsFor(record.proposalId)).toHaveLength(1);
    const impostor = await ledger.append({
      ...record,
      evidenceDigest: lifecycleEvidenceDigestOf({
        proposalId: record.proposalId,
        stage: "offline-replayed",
        members: ["exp-workload-replay-99999999"],
      }),
    });
    expect(impostor.refused).toBe(true);
    expect(ledger.transitionsFor(record.proposalId)).toHaveLength(1);
  });

  test("a live row without a dispatch seam is a configuration error; with one it completes measured", async () => {
    const row = EQUIVALENCE_TESTING_CORPUS.find((candidate) => candidate.needsDispatch);
    expect(row).toBeDefined();
    const liveRow = row as EquivalenceCorpusRow;
    const clock = createTickClock();
    await expect(
      driveEquivalenceRun({
        row: liveRow,
        registry: createCandidateRegistry(),
        ledger: createLifecycleLedger(),
        incumbentExecutor: createIncumbentExecutor(),
        replacementRuntime: createReplacementRuntime(),
        now: clock.now,
      }),
    ).rejects.toThrow("demands a dispatch seam");
    // With the seam bound, the run completes honestly: ONE REAL
    // residual-AI round, measured usage, the verdict landing.
    const result = await driveRowOverStack({
      row: liveRow,
      dispatch: async () => ({
        kind: "success" as const,
        usage: { inputTokens: 30, outputTokens: 6, costUsd: 0.001 },
        latencyMs: 40,
      }),
    });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.observedModelCalls).toBe(1);
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 6, costUsd: 0.001 });
    expect(result.verdict).toBe("equivalence-pass");
    expect(result.provenance?.complete).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The adversarial worlds (the isolation / differential / provenance /
// stage / divergence catches)
// ---------------------------------------------------------------------------

describe("VAL-033 adversarial equivalence worlds", () => {
  test("an UNCITED runtime verdict FAILs and never lands (a broken provenance chain)", async () => {
    const row = rowById("probe-broken-provenance");
    const clock = createTickClock();
    const registry = createCandidateRegistry();
    const ledger = createLifecycleLedger();
    const result = await driveEquivalenceRun({
      row,
      registry,
      ledger,
      incumbentExecutor: createIncumbentExecutor(),
      replacementRuntime: createReplacementRuntime({ variant: "uncited" }),
      now: clock.now,
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("evaluation-invalid");
    expect(result.provenance?.complete).toBe(false);
    const cited = result.criteria.find(
      (criterion) => criterion.criterionId === "provenance-proposal-cited",
    );
    expect(cited?.status).toBe("FAIL");
    expect(cited?.evidence.join(" ")).toContain("UNCITED-VERDICT");
    // The unprovenanced verdict never lands.
    expect(result.ledgerLanding).toBeNull();
    expect(ledger.landedProposalIds).toEqual([]);
  });

  test("a PARTIAL population (the adversarial cases dropped) FAILs with the cases named", async () => {
    const row = rowById("probe-partial-population");
    const result = await driveRowOverStack({ row, runtimeVariant: "partial" });
    expect(result.terminal).toBe("FAILED");
    expect(result.provenance?.missingAdversarialCaseIds).toHaveLength(2);
    const full = result.criteria.find(
      (criterion) => criterion.criterionId === "provenance-full-population",
    );
    expect(full?.status).toBe("FAIL");
    expect(full?.evidence.join(" ")).toContain("PARTIAL-POPULATION");
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "criterion-checked")?.status,
    ).toBe("FAIL");
  });

  test("an UNCHECKED criterion (stated but never checked) FAILs", async () => {
    const row = rowById("probe-unchecked-criterion");
    const result = await driveRowOverStack({ row, runtimeVariant: "unchecked" });
    expect(result.terminal).toBe("FAILED");
    expect(result.differential?.fullyEvaluated).toBe(false);
    const checked = result.criteria.find(
      (criterion) => criterion.criterionId === "criterion-checked",
    );
    expect(checked?.status).toBe("FAIL");
    expect(checked?.evidence.join(" ")).toContain("UNCHECKED-CRITERION");
    // Nothing lands: the verdict is untrustworthy.
    expect(result.ledgerLanding).toBeNull();
  });

  test("a SMOOTHED divergence (a perturbed case claimed equivalent) FAILs the honesty leg", async () => {
    const row = rowById("probe-divergence-smoothing");
    const result = await driveRowOverStack({ row, runtimeVariant: "smoothing" });
    expect(result.terminal).toBe("FAILED");
    expect(result.differential?.divergences).toHaveLength(1);
    expect(result.differential?.smoothedDivergences).toHaveLength(1);
    const smoothing = result.criteria.find(
      (criterion) => criterion.criterionId === "divergence-honesty-no-smoothing",
    );
    expect(smoothing?.status).toBe("FAIL");
    expect(smoothing?.evidence.join(" ")).toContain("DIVERGENCE-SMOOTHING");
    // The smoothed verdict never lands.
    expect(result.ledgerLanding).toBeNull();
  });

  test("an ESCAPING runtime (network access) is a containment violation that never lands", async () => {
    const row = rowById("probe-containment-escape");
    const clock = createTickClock();
    const registry = createCandidateRegistry();
    const ledger = createLifecycleLedger();
    const result = await driveEquivalenceRun({
      row,
      registry,
      ledger,
      incumbentExecutor: createIncumbentExecutor(),
      replacementRuntime: createReplacementRuntime({ variant: "escaping" }),
      now: clock.now,
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("containment-violation");
    expect(result.isolation?.contained).toBe(false);
    expect(result.isolation?.escapeDirections).toEqual(["network-access"]);
    const escapeLeg = result.criteria.find(
      (criterion) => criterion.criterionId === "isolation-no-escape",
    );
    expect(escapeLeg?.status).toBe("FAIL");
    expect(escapeLeg?.evidence.join(" ")).toContain("CONTAINMENT-VIOLATION");
    // The violating verdict never lands.
    expect(result.ledgerLanding).toBeNull();
    expect(ledger.landedProposalIds).toEqual([]);
  });

  test("a SKIP-TO-PROMOTED ledger (a skipped-stage promotion) FAILs the stage discipline", async () => {
    const row = rowById("probe-skipped-stage");
    const result = await driveRowOverStack({ row, ledgerVariant: "skip-to-promoted" });
    expect(result.terminal).toBe("FAILED");
    expect(result.stageDiscipline?.beyondScopeStages).toEqual(["promoted"]);
    const never = result.criteria.find(
      (criterion) => criterion.criterionId === "stage-discipline-never-beyond-equivalence",
    );
    expect(never?.status).toBe("FAIL");
    expect(never?.evidence.join(" ")).toContain("SKIPPED-STAGE");
  });

  test("a SKIP-OFFLINE-REPLAY ledger (a jumped rung) FAILs the stage discipline", async () => {
    const row = rowById("probe-skipped-stage");
    const result = await driveRowOverStack({ row, ledgerVariant: "skip-offline-replay" });
    expect(result.terminal).toBe("FAILED");
    expect(result.stageDiscipline?.skippedStageTransitions).toHaveLength(1);
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "stage-discipline-no-jumps")
        ?.status,
    ).toBe("FAIL");
  });

  test("an EVIDENCE-LESS ledger (transitions without evidence) FAILs the stage discipline", async () => {
    const row = rowById("probe-skipped-stage");
    const result = await driveRowOverStack({ row, ledgerVariant: "evidence-less" });
    expect(result.terminal).toBe("FAILED");
    expect(result.stageDiscipline?.evidenceLessOrdinals).toHaveLength(2);
    expect(
      result.criteria.find(
        (criterion) => criterion.criterionId === "stage-discipline-every-transition-evidenced",
      )?.status,
    ).toBe("FAIL");
  });

  test("a REWRITE-REGISTRY ledger (a proposal rewrite) FAILs the read-only discipline", async () => {
    const row = rowById("probe-skipped-stage");
    const clock = createTickClock();
    const registry = createCandidateRegistry();
    const beforeDigest = registry.digest();
    const result = await driveEquivalenceRun({
      row,
      registry,
      ledger: createLifecycleLedger({ variant: "rewrite-registry", registry }),
      incumbentExecutor: createIncumbentExecutor(),
      replacementRuntime: createReplacementRuntime(),
      now: clock.now,
    });
    expect(result.terminal).toBe("FAILED");
    // The verdict itself was honest — the rewrite happened at the
    // append: the registry's frozen digest CHANGED.
    expect(result.differential?.equivalent).toBe(true);
    expect(registry.digest()).not.toBe(beforeDigest);
    const readonly = result.criteria.find(
      (criterion) => criterion.criterionId === "registry-read-only",
    );
    expect(readonly?.status).toBe("FAIL");
    expect(readonly?.evidence.join(" ")).toContain("REGISTRY-MUTATION");
  });

  test("a DIVERGENT incumbent executor (a drifted serve) FAILs the population pin", async () => {
    const row = rowById("rag-deterministic-function-exact");
    const result = await driveRowOverStack({ row, divergentIncumbent: true });
    expect(result.terminal).toBe("FAILED");
    const pin = result.criteria.find(
      (criterion) => criterion.criterionId === "population-served-as-pinned",
    );
    expect(pin?.status).toBe("FAIL");
    expect(pin?.evidence.join(" ")).toContain("POPULATION-MISMATCH");
  });

  test("an honest re-drive REPLAYS the lifecycle walk (append-only idempotence)", async () => {
    const row = rowById("rag-deterministic-function-exact");
    const clock = createTickClock();
    const registry = createCandidateRegistry();
    const ledger = createLifecycleLedger();
    const first = await driveEquivalenceRun({
      row,
      registry,
      ledger,
      incumbentExecutor: createIncumbentExecutor(),
      replacementRuntime: createReplacementRuntime(),
      now: clock.now,
    });
    expect(first.terminal).toBe("COMPLETED");
    const second = await driveEquivalenceRun({
      row,
      registry,
      ledger,
      incumbentExecutor: createIncumbentExecutor(),
      replacementRuntime: createReplacementRuntime(),
      now: clock.now,
    });
    expect(second.terminal).toBe("COMPLETED");
    // The identical re-append REPLAYS: still exactly the equivalence walk.
    expect(ledger.transitionsFor(row.sourceProposalId)).toHaveLength(2);
    expect(ledger.landedProposalIds).toEqual([row.sourceProposalId]);
    expect(second.ledgerLanding?.replayed).toBe(true);
  });

  test("a dispatch FAILURE on the live row FAILs honestly (never a fabricated completion)", async () => {
    const row = EQUIVALENCE_TESTING_CORPUS.find((candidate) => candidate.needsDispatch);
    expect(row).toBeDefined();
    const liveRow = row as EquivalenceCorpusRow;
    const result = await driveRowOverStack({
      row: liveRow,
      dispatch: async () => ({
        kind: "failure" as const,
        category: "provider-unavailable",
        message: "the provider is unavailable",
        retryable: true,
        latencyMs: 5,
      }),
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.failure?.category).toBe("provider-unavailable");
    expect(result.observedModelCalls).toBe(0);
  });
});
