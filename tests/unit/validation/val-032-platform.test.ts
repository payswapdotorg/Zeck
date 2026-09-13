/**
 * VAL-032 acceptance criteria 1, 2, 4, 5: the learning-discovery
 * platform slice against controlled fakes — the candidate-kind
 * vocabulary (reuse/cache/competence/deterministicization; the
 * deterministicization lifecycle's candidate grammar with the
 * propose-only stage; the discovery-probe and refusal vocabularies),
 * the PURE derivations that make a proposal trustworthy (the
 * evidence-citation completeness matrix — a complete full-population
 * citation, an uncited proposal, a partial population, a fabricated
 * citation and a single-observation population each judged; the
 * candidate-kind fidelity — each kind matching its mined structure, a
 * mismatch or a fabricated structure digest FAILING; the conservatism
 * — deterministicization over variance FAILING while a cache proposal
 * over legitimate trajectory variance is real structure; the
 * no-application discipline — frozen inputs unchanged, proposals at
 * the `proposed` stage, no applied candidates; the refusal honesty —
 * justified refusals PASSING, a hiding or malformed outcome FAILING),
 * the digest discipline (deterministic, canonical, payload-free), and
 * the discovery driver over every offline corpus row — including the
 * ADVERSARIAL worlds: the UNCITED/PARTIAL/FABRICATED/SMOOTHING/HIDING
 * miner variants, the MUTATING candidate registry (the frozen-state
 * rewrite and the promoted candidate) and the mismatched ledger input.
 */

import { describe, expect, test } from "vitest";
import {
  LEARNING_DISCOVERY_CORPUS,
  OFFLINE_CORPUS_ROWS,
  recordedObservationsOf,
} from "../../../benchmarks/validation/apps/learning-discovery/corpus";
import {
  createCandidateRegistry,
  createDiscoveryMiner,
  createReplayLedgerInput,
  createTickClock,
  type FakeMinerVariant,
} from "../../../benchmarks/validation/apps/learning-discovery/fixtures";
import type {
  CandidateKind,
  LearningDiscoveryCorpusRow,
  LearningDiscoveryResult,
  ProposalEvidenceCitation,
} from "../../../benchmarks/validation/platform/learning-discovery";
import {
  CANDIDATE_KINDS,
  CANDIDATE_LIFECYCLE_STAGES,
  canonicalCitationOf,
  DISCOVERY_EXPERIMENT_KIND,
  DISCOVERY_LEARNING_PHASE,
  DISCOVERY_PROBE_KINDS,
  deriveCandidateKindFidelity,
  deriveConservatism,
  deriveEvidenceCitationCompleteness,
  deriveHonestDiscoveryOutcome,
  deriveNoApplication,
  deriveRefusalHonesty,
  driveLearningDiscovery,
  isAppliedLifecycleStage,
  isCandidateKind,
  isDiscoveryProbeKind,
  isRefusalReason,
  kindSignalSizeOf,
  minedStructureDigestOf,
  mineLearnableStructureOf,
  PROPOSAL_LIFECYCLE_STAGE,
  proposalIdentityIdOf,
  REFUSAL_REASONS,
} from "../../../benchmarks/validation/platform/learning-discovery";
import type { ControlDispatch } from "../../../benchmarks/validation/platform/longitudinal-baseline";
import { longitudinalDigestOf } from "../../../benchmarks/validation/platform/longitudinal-baseline";

const rowById = (rowId: string): LearningDiscoveryCorpusRow => {
  const row = LEARNING_DISCOVERY_CORPUS.find((candidate) => candidate.rowId === rowId);
  if (row === undefined) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

/** Drive one offline row over a purpose-built fake stack. */
async function driveRowOverStack(options: {
  readonly row: LearningDiscoveryCorpusRow;
  readonly variant?: FakeMinerVariant;
  readonly registryMutation?: "mutate-recorded-population" | "promote-proposal";
  readonly mismatchedLedger?: boolean;
  readonly dispatch?: ControlDispatch;
}): Promise<LearningDiscoveryResult> {
  const clock = createTickClock();
  const ledgerInput = createReplayLedgerInput({
    ...(options.mismatchedLedger === true ? { mismatch: true } : {}),
  });
  const miner = createDiscoveryMiner({
    ...(options.variant === undefined ? {} : { variant: options.variant }),
  });
  const registry = createCandidateRegistry({
    ...(options.registryMutation === undefined
      ? {}
      : { mutation: options.registryMutation, ledgerInput }),
  });
  return driveLearningDiscovery({
    row: options.row,
    ledgerInput,
    miner,
    registry,
    ...(options.dispatch === undefined ? {} : { dispatch: options.dispatch }),
    now: clock.now,
  });
}

// ---------------------------------------------------------------------------
// The vocabulary + the proposal identity
// ---------------------------------------------------------------------------

describe("VAL-032 platform vocabulary", () => {
  test("the discovery vocabulary is pinned (the discovery phase proposes, never applies)", () => {
    expect(DISCOVERY_LEARNING_PHASE).toBe("discovery");
    expect(DISCOVERY_EXPERIMENT_KIND).toBe("learning-discovery");
  });

  test("the candidate-kind vocabulary is pinned (four learnable structures)", () => {
    expect(CANDIDATE_KINDS).toEqual(["reuse", "cache", "competence", "deterministicization"]);
    for (const kind of CANDIDATE_KINDS) {
      expect(isCandidateKind(kind)).toBe(true);
    }
    expect(isCandidateKind("memoization")).toBe(false);
  });

  test("the discovery-probe vocabulary is pinned (five discriminations)", () => {
    expect(DISCOVERY_PROBE_KINDS).toEqual([
      "uncited-proposal",
      "partial-population",
      "fabricated-citation",
      "variance-smoothing",
      "state-mutation",
    ]);
    for (const kind of DISCOVERY_PROBE_KINDS) {
      expect(isDiscoveryProbeKind(kind)).toBe(true);
    }
    expect(isDiscoveryProbeKind("empty-citation")).toBe(false);
  });

  test("the candidate lifecycle grammar is pinned (propose-only; application is VAL-033+)", () => {
    expect(CANDIDATE_LIFECYCLE_STAGES).toEqual([
      "observed",
      "characterized",
      "proposed",
      "offline-replayed",
      "differentially-evaluated",
      "property-tested",
      "mutation-tested",
      "shadow-executed",
      "canaried",
      "promoted",
    ]);
    expect(PROPOSAL_LIFECYCLE_STAGE).toBe("proposed");
    // The pre-proposal stages are discovery's own; everything PAST
    // `proposed` is an application-level act.
    expect(isAppliedLifecycleStage("observed")).toBe(false);
    expect(isAppliedLifecycleStage("characterized")).toBe(false);
    expect(isAppliedLifecycleStage("proposed")).toBe(false);
    for (const stage of [
      "offline-replayed",
      "differentially-evaluated",
      "property-tested",
      "mutation-tested",
      "shadow-executed",
      "canaried",
      "promoted",
    ]) {
      expect(isAppliedLifecycleStage(stage)).toBe(true);
    }
  });

  test("the refusal vocabulary is pinned (three mechanically-justified reasons)", () => {
    expect(REFUSAL_REASONS).toEqual([
      "varying-population",
      "no-dispatched-work",
      "no-learnable-structure",
    ]);
    for (const reason of REFUSAL_REASONS) {
      expect(isRefusalReason(reason)).toBe(true);
    }
    expect(isRefusalReason("not-now")).toBe(false);
  });

  test("the proposal identity is the derived cand-<kind>-<digest> form over its own content", () => {
    const row = rowById("rag-retrieval-deterministicization-candidate");
    const honest = deriveHonestDiscoveryOutcome({
      candidateKind: row.candidateKind,
      population: row.population,
    });
    expect(honest.proposal).not.toBeNull();
    const proposal = honest.proposal as NonNullable<typeof honest.proposal>;
    expect(proposal.proposalId).toBe(
      `cand-${DISCOVERY_EXPERIMENT_KIND}-${longitudinalDigestOf([
        proposal.kind,
        proposal.citation.trajectoryDigests,
        proposal.citation.replayIdentities,
        proposal.minedStructureDigest,
        proposal.lifecycleStage,
      ])}`,
    );
    expect(proposal.lifecycleStage).toBe("proposed");
    // The identity is content-derived: the same content, the same id;
    // a different citation, a different id (never a minted random id).
    const mutated = proposalIdentityIdOf({
      kind: proposal.kind,
      citation: {
        trajectoryDigests: ["00000000"],
        replayIdentities: proposal.citation.replayIdentities,
      },
      minedStructureDigest: proposal.minedStructureDigest,
      lifecycleStage: proposal.lifecycleStage,
    });
    expect(mutated).not.toBe(proposal.proposalId);
  });
});

// ---------------------------------------------------------------------------
// Evidence-citation completeness (the discovery oracle's citation leg)
// ---------------------------------------------------------------------------

describe("VAL-032 deriveEvidenceCitationCompleteness", () => {
  const deterministicRow = rowById("rag-retrieval-deterministicization-candidate");
  const varyingRow = rowById("order-settlement-cache-candidate");

  test("a COMPLETE full-population citation over a deterministic population PASSES", () => {
    const citation = canonicalCitationOf(deterministicRow.population);
    const verdict = deriveEvidenceCitationCompleteness({
      population: deterministicRow.population,
      citation,
    });
    expect(verdict.complete).toBe(true);
    expect(verdict.populationSize).toBe(4);
    expect(verdict.citedTrajectoryDigests).toBe(1);
    expect(verdict.citedReplayIdentities).toBe(4);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("a COMPLETE citation over the VARYING population cites every digest AND every identity", () => {
    const citation = canonicalCitationOf(varyingRow.population);
    const verdict = deriveEvidenceCitationCompleteness({
      population: varyingRow.population,
      citation,
    });
    expect(verdict.complete).toBe(true);
    expect(verdict.citedTrajectoryDigests).toBe(2);
    expect(verdict.citedReplayIdentities).toBe(4);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("an UNCITED proposal (an empty citation) FAILS", () => {
    const verdict = deriveEvidenceCitationCompleteness({
      population: deterministicRow.population,
      citation: { trajectoryDigests: [], replayIdentities: [] },
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.citedReplayIdentities).toBe(0);
    const full = verdict.criteria.find(
      (criterion) => criterion.criterionId === "citation-full-population",
    );
    expect(full?.status).toBe("FAIL");
    expect(full?.evidence.join(" ")).toContain("UNCITED-PROPOSAL");
  });

  test("a PARTIAL population (a missing replay identity) FAILs", () => {
    const citation = canonicalCitationOf(deterministicRow.population);
    const partial: ProposalEvidenceCitation = {
      trajectoryDigests: citation.trajectoryDigests,
      replayIdentities: citation.replayIdentities.slice(0, -1),
    };
    const verdict = deriveEvidenceCitationCompleteness({
      population: deterministicRow.population,
      citation: partial,
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.uncitedReplayIdentities).toHaveLength(1);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "citation-full-population")
        ?.status,
    ).toBe("FAIL");
    expect(
      verdict.criteria
        .find((criterion) => criterion.criterionId === "citation-full-population")
        ?.evidence.join(" "),
    ).toContain("PARTIAL-POPULATION");
  });

  test("a PARTIAL population over the varying row (a missing digest) FAILs", () => {
    const citation = canonicalCitationOf(varyingRow.population);
    const partial: ProposalEvidenceCitation = {
      trajectoryDigests: citation.trajectoryDigests.slice(0, -1),
      replayIdentities: citation.replayIdentities,
    };
    const verdict = deriveEvidenceCitationCompleteness({
      population: varyingRow.population,
      citation: partial,
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.uncitedTrajectoryDigests).toHaveLength(1);
  });

  test("a FABRICATED citation (a phantom digest AND a phantom identity) FAILs with the members named", () => {
    const citation = canonicalCitationOf(deterministicRow.population);
    const phantomDigest = longitudinalDigestOf("phantom-digest");
    const phantomIdentity = "exp-workload-replay-00000000";
    const verdict = deriveEvidenceCitationCompleteness({
      population: deterministicRow.population,
      citation: {
        trajectoryDigests: [...citation.trajectoryDigests, phantomDigest],
        replayIdentities: [...citation.replayIdentities, phantomIdentity],
      },
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.fabricatedTrajectoryDigests).toEqual([phantomDigest]);
    expect(verdict.fabricatedReplayIdentities).toEqual([phantomIdentity]);
    const fabrication = verdict.criteria.find(
      (criterion) => criterion.criterionId === "citation-no-fabrication",
    );
    expect(fabrication?.status).toBe("FAIL");
    expect(fabrication?.evidence.join(" ")).toContain("FABRICATED-CITATION");
    expect(fabrication?.evidence.join(" ")).toContain(phantomDigest);
  });

  test("a single-observation population is not evidence for a generalization", () => {
    const single = deterministicRow.population.slice(0, 1);
    const verdict = deriveEvidenceCitationCompleteness({
      population: single,
      citation: canonicalCitationOf(single),
    });
    expect(verdict.complete).toBe(false);
    expect(
      verdict.criteria
        .find((criterion) => criterion.criterionId === "citation-minimum-evidence")
        ?.evidence.join(" "),
    ).toContain("SINGLE-OBSERVATION");
  });
});

// ---------------------------------------------------------------------------
// Candidate-kind fidelity (the proposal's kind matches the mined structure)
// ---------------------------------------------------------------------------

describe("VAL-032 deriveCandidateKindFidelity", () => {
  const cases: readonly [string, CandidateKind][] = [
    ["cross-workload-reuse-candidate", "reuse"],
    ["order-settlement-cache-candidate", "cache"],
    ["tool-loop-competence-candidate", "competence"],
    ["rag-retrieval-deterministicization-candidate", "deterministicization"],
  ];

  test.each(cases)(
    "the %s row's honest proposal is FAITHFUL to its mined structure",
    (rowId, kind) => {
      const row = rowById(rowId);
      const honest = deriveHonestDiscoveryOutcome({
        candidateKind: row.candidateKind,
        population: row.population,
      });
      expect(honest.proposal?.kind).toBe(kind);
      const verdict = deriveCandidateKindFidelity({
        proposal: honest.proposal as NonNullable<typeof honest.proposal>,
        structure: honest.structure,
      });
      expect(verdict.faithful).toBe(true);
      expect(verdict.signalSize).toBeGreaterThan(0);
      expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
    },
  );

  test("a KIND MISMATCH (a reuse proposal over a single-workload population) FAILs", () => {
    // The RAG population holds ONE workload: no sub-trajectory shape is
    // repeated ACROSS workloads — a reuse proposal over it is a mismatch.
    const row = rowById("rag-retrieval-deterministicization-candidate");
    const structure = mineLearnableStructureOf(row.population);
    expect(kindSignalSizeOf(structure, "reuse")).toBe(0);
    const basis = {
      kind: "reuse" as const,
      citation: canonicalCitationOf(row.population),
      minedStructureDigest: structure.digest,
      lifecycleStage: PROPOSAL_LIFECYCLE_STAGE,
    };
    const verdict = deriveCandidateKindFidelity({
      proposal: { ...basis, proposalId: proposalIdentityIdOf(basis) },
      structure,
    });
    expect(verdict.faithful).toBe(false);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "kind-fidelity")?.status,
    ).toBe("FAIL");
    expect(
      verdict.criteria
        .find((criterion) => criterion.criterionId === "kind-fidelity")
        ?.evidence.join(" "),
    ).toContain("KIND-MISMATCH");
  });

  test("a deterministicization proposal over the VARYING population is a kind mismatch", () => {
    const row = rowById("order-settlement-cache-candidate");
    const structure = mineLearnableStructureOf(row.population);
    expect(kindSignalSizeOf(structure, "deterministicization")).toBe(0);
    expect(structure.varyingSegments).toHaveLength(1);
    const basis = {
      kind: "deterministicization" as const,
      citation: canonicalCitationOf(row.population),
      minedStructureDigest: structure.digest,
      lifecycleStage: PROPOSAL_LIFECYCLE_STAGE,
    };
    const verdict = deriveCandidateKindFidelity({
      proposal: { ...basis, proposalId: proposalIdentityIdOf(basis) },
      structure,
    });
    expect(verdict.faithful).toBe(false);
  });

  test("a FABRICATED structure digest (a structure the mining did not derive) FAILs", () => {
    const row = rowById("rag-retrieval-deterministicization-candidate");
    const structure = mineLearnableStructureOf(row.population);
    const basis = {
      kind: "deterministicization" as const,
      citation: canonicalCitationOf(row.population),
      minedStructureDigest: longitudinalDigestOf("fabricated-structure"),
      lifecycleStage: PROPOSAL_LIFECYCLE_STAGE,
    };
    const verdict = deriveCandidateKindFidelity({
      proposal: { ...basis, proposalId: proposalIdentityIdOf(basis) },
      structure,
    });
    expect(verdict.faithful).toBe(false);
    expect(verdict.structureDigestMatches).toBe(false);
    expect(
      verdict.criteria
        .find((criterion) => criterion.criterionId === "mined-structure-digest")
        ?.evidence.join(" "),
    ).toContain("FABRICATED-STRUCTURE");
  });
});

// ---------------------------------------------------------------------------
// Conservatism (a varying segment is never a deterministicization candidate)
// ---------------------------------------------------------------------------

describe("VAL-032 deriveConservatism", () => {
  test("a deterministicization proposal over a DETERMINISTIC population is conservative", () => {
    const row = rowById("rag-retrieval-deterministicization-candidate");
    const honest = deriveHonestDiscoveryOutcome({
      candidateKind: row.candidateKind,
      population: row.population,
    });
    const verdict = deriveConservatism({
      proposal: honest.proposal,
      structure: honest.structure,
    });
    expect(verdict.conservative).toBe(true);
    expect(verdict.varyingWorkloadIds).toEqual([]);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("a deterministicization proposal over the VARYING population FAILs (variance smoothing)", () => {
    const row = rowById("order-settlement-cache-candidate");
    const structure = mineLearnableStructureOf(row.population);
    const basis = {
      kind: "deterministicization" as const,
      citation: canonicalCitationOf(row.population),
      minedStructureDigest: structure.digest,
      lifecycleStage: PROPOSAL_LIFECYCLE_STAGE,
    };
    const verdict = deriveConservatism({
      proposal: { ...basis, proposalId: proposalIdentityIdOf(basis) },
      structure,
    });
    expect(verdict.conservative).toBe(false);
    expect(verdict.varyingWorkloadIds).toHaveLength(1);
    expect(
      verdict.criteria.find(
        (criterion) => criterion.criterionId === "conservatism-no-variance-smoothing",
      )?.status,
    ).toBe("FAIL");
    expect(
      verdict.criteria
        .find((criterion) => criterion.criterionId === "conservatism-no-variance-smoothing")
        ?.evidence.join(" "),
    ).toContain("VARIANCE-SMOOTHING");
  });

  test("a CACHE proposal over the varying population is conservative (real structure, not smoothing)", () => {
    const row = rowById("order-settlement-cache-candidate");
    const honest = deriveHonestDiscoveryOutcome({
      candidateKind: "cache",
      population: row.population,
    });
    expect(honest.proposal?.kind).toBe("cache");
    const verdict = deriveConservatism({
      proposal: honest.proposal,
      structure: honest.structure,
    });
    // The population varies — but the cache signal (the stable
    // input→output transformation) is REAL structure over the variance.
    expect(verdict.varyingWorkloadIds).toHaveLength(1);
    expect(verdict.conservative).toBe(true);
  });

  test("an honest refusal is conservative and the variance is REPORTED, never smoothed", () => {
    const row = rowById("order-settlement-varying-refusal");
    const honest = deriveHonestDiscoveryOutcome({
      candidateKind: row.candidateKind,
      population: row.population,
    });
    expect(honest.proposal).toBeNull();
    expect(honest.refusal?.reason).toBe("varying-population");
    const verdict = deriveConservatism({ proposal: null, structure: honest.structure });
    expect(verdict.conservative).toBe(true);
    // The reported structure names the varying workload with BOTH its
    // observed digests — the honest report rides the structure.
    expect(
      verdict.criteria
        .find((criterion) => criterion.criterionId === "conservatism-variance-reported")
        ?.evidence.join(" "),
    ).toContain("golden:order-settlement");
    expect(honest.structure.varyingSegments[0]?.observedDigests).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// No-application (discovery proposes, never applies)
// ---------------------------------------------------------------------------

describe("VAL-032 deriveNoApplication", () => {
  const registryFactsOf = (applied: number) => ({
    candidates: [],
    appliedCandidateCount: applied,
  });

  test("an honest discovery is inert (frozen inputs unchanged, proposal at the proposed stage)", () => {
    const row = rowById("rag-retrieval-deterministicization-candidate");
    const honest = deriveHonestDiscoveryOutcome({
      candidateKind: row.candidateKind,
      population: row.population,
    });
    const verdict = deriveNoApplication({
      beforeFrozenDigest: "aaaaaaaa",
      afterFrozenDigest: "aaaaaaaa",
      proposal: honest.proposal,
      registryFacts: registryFactsOf(0),
    });
    expect(verdict.inert).toBe(true);
    expect(verdict.frozenInputUnchanged).toBe(true);
    expect(verdict.proposalStageProposed).toBe(true);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("a proposal whose recording MUTATED frozen state FAILs", () => {
    const verdict = deriveNoApplication({
      beforeFrozenDigest: "aaaaaaaa",
      afterFrozenDigest: "bbbbbbbb",
      proposal: null,
      registryFacts: registryFactsOf(0),
    });
    expect(verdict.inert).toBe(false);
    const mutation = verdict.criteria.find(
      (criterion) => criterion.criterionId === "no-application-frozen-inputs",
    );
    expect(mutation?.status).toBe("FAIL");
    expect(mutation?.evidence.join(" ")).toContain("STATE-MUTATION");
  });

  test("an APPLIED proposal (a stage past proposed) FAILs", () => {
    const row = rowById("rag-retrieval-deterministicization-candidate");
    const honest = deriveHonestDiscoveryOutcome({
      candidateKind: row.candidateKind,
      population: row.population,
    });
    const applied = {
      ...(honest.proposal as NonNullable<typeof honest.proposal>),
      lifecycleStage: "promoted" as const,
    };
    const verdict = deriveNoApplication({
      beforeFrozenDigest: "aaaaaaaa",
      afterFrozenDigest: "aaaaaaaa",
      proposal: applied,
      registryFacts: registryFactsOf(1),
    });
    expect(verdict.inert).toBe(false);
    expect(verdict.proposalStageProposed).toBe(false);
    expect(verdict.appliedCandidateCount).toBe(1);
    expect(
      verdict.criteria
        .find((criterion) => criterion.criterionId === "no-application-lifecycle-stage")
        ?.evidence.join(" "),
    ).toContain("APPLIED-PROPOSAL");
    expect(
      verdict.criteria
        .find((criterion) => criterion.criterionId === "no-application-registry-inert")
        ?.evidence.join(" "),
    ).toContain("APPLIED-CANDIDATES");
  });

  test("an honest refusal over a mutating world is still caught (frozen inputs are the floor)", () => {
    const verdict = deriveNoApplication({
      beforeFrozenDigest: "aaaaaaaa",
      afterFrozenDigest: "cccccccc",
      proposal: null,
      registryFacts: registryFactsOf(0),
    });
    expect(verdict.inert).toBe(false);
    expect(verdict.proposalStageProposed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Refusal honesty (a refusal is justified by the recorded structure)
// ---------------------------------------------------------------------------

describe("VAL-032 deriveRefusalHonesty", () => {
  test("the varying-population refusal is honest (justified by the reported variance)", () => {
    const row = rowById("order-settlement-varying-refusal");
    const structure = mineLearnableStructureOf(row.population);
    const verdict = deriveRefusalHonesty({
      candidateKind: row.candidateKind,
      refusal: { reason: "varying-population" },
      proposalEmitted: false,
      structure,
    });
    expect(verdict.honest).toBe(true);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("the no-dispatched-work refusal is honest (a guard-rejected population)", () => {
    const row = rowById("oversized-batch-guard-refusal");
    const structure = mineLearnableStructureOf(row.population);
    expect(structure.dispatchedObservations).toBe(0);
    const verdict = deriveRefusalHonesty({
      candidateKind: row.candidateKind,
      refusal: { reason: "no-dispatched-work" },
      proposalEmitted: false,
      structure,
    });
    expect(verdict.honest).toBe(true);
  });

  test("a HIDING refusal (the signal fires but the discovery refuses) FAILs", () => {
    const row = rowById("rag-retrieval-deterministicization-candidate");
    const structure = mineLearnableStructureOf(row.population);
    expect(kindSignalSizeOf(structure, "deterministicization")).toBeGreaterThan(0);
    const verdict = deriveRefusalHonesty({
      candidateKind: row.candidateKind,
      refusal: { reason: "no-learnable-structure" },
      proposalEmitted: false,
      structure,
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

  test("a MALFORMED outcome (a refusal alongside a proposal) FAILs", () => {
    const row = rowById("rag-retrieval-deterministicization-candidate");
    const structure = mineLearnableStructureOf(row.population);
    const verdict = deriveRefusalHonesty({
      candidateKind: row.candidateKind,
      refusal: { reason: "no-learnable-structure" },
      proposalEmitted: true,
      structure,
    });
    expect(verdict.honest).toBe(false);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "refusal-well-formed")?.status,
    ).toBe("FAIL");
    expect(
      verdict.criteria
        .find((criterion) => criterion.criterionId === "refusal-well-formed")
        ?.evidence.join(" "),
    ).toContain("MALFORMED-OUTCOME");
  });
});

// ---------------------------------------------------------------------------
// The digest discipline + the corpus pins
// ---------------------------------------------------------------------------

describe("VAL-032 digest discipline + the corpus pins", () => {
  test("the corpus pins are internally consistent (populations, outcomes, citations, classes)", () => {
    for (const row of LEARNING_DISCOVERY_CORPUS) {
      // Every replay-population reference resolves in VAL-031's corpus
      // and the recorded observations re-derive exactly.
      const expected = row.replayPopulationRefs.flatMap((ref) => recordedObservationsOf(ref));
      expect(row.population).toEqual(expected);
      // The expected outcome is the honest derivation over the
      // recorded population (the pure oracle).
      const honest = deriveHonestDiscoveryOutcome({
        candidateKind: row.candidateKind,
        population: row.population,
      });
      expect(row.expected.emitsProposal).toBe(honest.proposal !== null);
      expect(row.expected.kind).toBe(honest.proposal?.kind ?? null);
      expect(row.expected.refusalReason).toBe(honest.refusal?.reason ?? null);
      expect(row.expected.minedStructureDigest).toBe(honest.proposal?.minedStructureDigest ?? null);
      // The pinned trajectory class is the canonical discovery
      // trajectory's single-member class.
      expect(row.expectedTrajectoryClass).toHaveLength(1);
      expect(row.expectedTrajectoryClass[0]).toMatch(/^[0-9a-f]{8}$/);
      // Every observation's digests are payload-free FNV-1a constants.
      for (const observation of row.population) {
        expect(observation.trajectoryDigest).toMatch(/^[0-9a-f]{8}$/);
        expect(observation.subTrajectoryShapeDigest).toMatch(/^[0-9a-f]{8}$/);
        expect(observation.inputDigest).toMatch(/^[0-9a-f]{8}$/);
        expect(observation.outputDigest).toMatch(/^[0-9a-f]{8}$/);
        expect(observation.stepPatternDigest).toMatch(/^[0-9a-f]{8}$/);
        expect(observation.replayIdentity).toMatch(/^exp-workload-replay-[0-9a-f]{8}$/);
      }
    }
  });

  test("the mined structure digest is canonical and discriminating", () => {
    const rag = mineLearnableStructureOf(
      rowById("rag-retrieval-deterministicization-candidate").population,
    );
    const tool = mineLearnableStructureOf(rowById("tool-loop-competence-candidate").population);
    // Deterministic + canonical: the same population, the same digest.
    expect(
      mineLearnableStructureOf(rowById("rag-retrieval-deterministicization-candidate").population)
        .digest,
    ).toBe(rag.digest);
    expect(rag.digest).toMatch(/^[0-9a-f]{8}$/);
    expect(rag.digest).not.toBe(tool.digest);
    // The digest is a pure function of the canonical structure basis.
    expect(rag.digest).toBe(minedStructureDigestOf(rag));
    // Different structures, different digests.
    expect(kindSignalSizeOf(rag, "deterministicization")).toBe(1);
    expect(kindSignalSizeOf(tool, "competence")).toBe(1);
    expect(kindSignalSizeOf(tool, "reuse")).toBe(0);
  });

  test("the structural digests never leak payload bytes", () => {
    for (const row of LEARNING_DISCOVERY_CORPUS) {
      for (const observation of row.population) {
        for (const digest of [
          observation.trajectoryDigest,
          observation.subTrajectoryShapeDigest,
          observation.inputDigest,
          observation.outputDigest,
          observation.stepPatternDigest,
        ]) {
          expect(digest).not.toContain("CIT-201");
          expect(digest).not.toContain("ORD-501");
          expect(digest).not.toContain("notify");
          expect(digest).not.toContain("summary");
        }
      }
    }
  });

  test("the reuse population spans TWO workloads with EIGHT recorded identities", () => {
    const row = rowById("cross-workload-reuse-candidate");
    expect(row.population).toHaveLength(8);
    expect(new Set(row.population.map((observation) => observation.workloadId)).size).toBe(2);
    expect(new Set(row.population.map((observation) => observation.replayIdentity)).size).toBe(8);
    // The two workloads share the repeated sub-trajectory shape.
    expect(new Set(row.population.map((o) => o.subTrajectoryShapeDigest)).size).toBe(1);
    // The honestly-varying population reports TWO distinct digests.
    const varying = rowById("order-settlement-varying-refusal");
    expect(new Set(varying.population.map((o) => o.trajectoryDigest)).size).toBe(2);
    // The guard population recorded ZERO dispatched work.
    const guard = rowById("oversized-batch-guard-refusal");
    expect(guard.population.every((observation) => observation.dispatchedRounds === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The driver over every offline row (the honest stack)
// ---------------------------------------------------------------------------

describe("VAL-032 driver over the honest offline corpus", () => {
  test("every offline row reaches its oracle terminal with every criterion PASS", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const result = await driveRowOverStack({ row });
      expect(result.terminal, `${row.rowId} terminal`).toBe("COMPLETED");
      const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
      expect(failed, `${row.rowId}: ${JSON.stringify(failed)}`).toEqual([]);
      // The outcome reproduces the pinned oracle.
      expect(result.proposal?.kind ?? null).toBe(row.expected.kind);
      expect(result.refusal?.reason ?? null).toBe(row.expected.refusalReason);
      // Latency is always measured; usage is honestly null offline.
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.usage).toBeNull();
      expect(result.observedModelCalls).toBe(0);
    }
  });

  test("the proposal rows emit COMPLETE proposals that LAND in the candidate registry", async () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter((candidate) => candidate.expected.emitsProposal)) {
      const clock = createTickClock();
      const ledgerInput = createReplayLedgerInput();
      const registry = createCandidateRegistry();
      const result = await driveLearningDiscovery({
        row,
        ledgerInput,
        miner: createDiscoveryMiner(),
        registry,
        now: clock.now,
      });
      expect(result.proposal).not.toBeNull();
      expect(result.citation?.complete).toBe(true);
      expect(result.fidelity?.faithful).toBe(true);
      expect(result.conservatism.conservative).toBe(true);
      expect(result.noApplication.inert).toBe(true);
      // The proposal landed as a lifecycle candidate at the proposed stage.
      expect(result.registryRecording?.accepted).toBe(true);
      expect(result.registryRecording?.replayed).toBe(false);
      expect(registry.facts().candidates).toHaveLength(1);
      expect(registry.facts().candidates[0]?.lifecycleStage).toBe("proposed");
      expect(registry.facts().appliedCandidateCount).toBe(0);
      // The recorded id is the derived stable form.
      expect(registry.recordedProposalIds).toEqual([result.proposal?.proposalId]);
    }
  });

  test("the refusal rows refuse HONESTLY and record NOTHING in the candidate registry", async () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) => !candidate.expected.emitsProposal,
    )) {
      const clock = createTickClock();
      const ledgerInput = createReplayLedgerInput();
      const registry = createCandidateRegistry();
      const result = await driveLearningDiscovery({
        row,
        ledgerInput,
        miner: createDiscoveryMiner(),
        registry,
        now: clock.now,
      });
      expect(result.proposal).toBeNull();
      expect(result.refusal?.reason).toBe(row.expected.refusalReason);
      expect(result.refusalHonesty?.honest).toBe(true);
      expect(result.conservatism.conservative).toBe(true);
      // Nothing landed: a refusal records no candidate.
      expect(registry.recordedProposalIds).toEqual([]);
      expect(registry.facts().candidates).toHaveLength(0);
      expect(result.registryRecording).toBeNull();
      expect(result.noApplication.inert).toBe(true);
    }
  });

  test("the registry is append-only: an identical re-proposal REPLAYS, a different one is REFUSED", async () => {
    const row = rowById("rag-retrieval-deterministicization-candidate");
    const registry = createCandidateRegistry();
    const proposal = deriveHonestDiscoveryOutcome({
      candidateKind: row.candidateKind,
      population: row.population,
    }).proposal as NonNullable<ReturnType<typeof deriveHonestDiscoveryOutcome>["proposal"]>;
    const first = await registry.propose(proposal);
    expect(first.accepted).toBe(true);
    expect(first.replayed).toBe(false);
    const second = await registry.propose(proposal);
    expect(second.accepted).toBe(true);
    expect(second.replayed).toBe(true);
    expect(registry.facts().candidates).toHaveLength(1);
    const impostor = {
      ...proposal,
      citation: {
        trajectoryDigests: ["00000000"],
        replayIdentities: proposal.citation.replayIdentities,
      },
    };
    const refused = await registry.propose(impostor);
    expect(refused.refused).toBe(true);
    expect(registry.facts().candidates).toHaveLength(1);
  });

  test("a live row without a dispatch seam is a configuration error; with one it completes measured", async () => {
    const row = LEARNING_DISCOVERY_CORPUS.find((candidate) => candidate.needsDispatch);
    expect(row).toBeDefined();
    const liveRow = row as LearningDiscoveryCorpusRow;
    const clock = createTickClock();
    await expect(
      driveLearningDiscovery({
        row: liveRow,
        ledgerInput: createReplayLedgerInput(),
        miner: createDiscoveryMiner(),
        registry: createCandidateRegistry(),
        now: clock.now,
      }),
    ).rejects.toThrow("demands a dispatch seam");
    // With the seam bound, the discovery run completes honestly: ONE
    // REAL confirmation round, measured usage, the proposal landing.
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
    expect(result.proposal?.kind).toBe("deterministicization");
    expect(result.citation?.complete).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The adversarial worlds (the citation / smoothing / mutation catches)
// ---------------------------------------------------------------------------

describe("VAL-032 adversarial discovery worlds", () => {
  test("an UNCITED miner proposal FAILs and is NEVER proposed into the registry", async () => {
    const row = rowById("probe-uncited-proposal");
    const clock = createTickClock();
    const ledgerInput = createReplayLedgerInput();
    const registry = createCandidateRegistry();
    const result = await driveLearningDiscovery({
      row,
      ledgerInput,
      miner: createDiscoveryMiner({ variant: "uncited" }),
      registry,
      now: clock.now,
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.citation?.complete).toBe(false);
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "citation-full-population")
        ?.status,
    ).toBe("FAIL");
    expect(
      result.criteria
        .find((criterion) => criterion.criterionId === "citation-full-population")
        ?.evidence.join(" "),
    ).toContain("UNCITED-PROPOSAL");
    // The dishonest proposal never landed.
    expect(registry.recordedProposalIds).toEqual([]);
    expect(result.registryRecording).toBeNull();
  });

  test("a PARTIAL-population citation FAILs (a stability claim from N-1 replays)", async () => {
    const row = rowById("probe-partial-population");
    const result = await driveRowOverStack({ row, variant: "partial" });
    expect(result.terminal).toBe("FAILED");
    expect(result.citation?.uncitedReplayIdentities).toHaveLength(1);
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "citation-full-population")
        ?.status,
    ).toBe("FAIL");
    expect(
      result.criteria
        .find((criterion) => criterion.criterionId === "citation-full-population")
        ?.evidence.join(" "),
    ).toContain("PARTIAL-POPULATION");
  });

  test("a FABRICATED citation FAILs with the phantom members named", async () => {
    const row = rowById("probe-fabricated-citation");
    const result = await driveRowOverStack({ row, variant: "fabricated" });
    expect(result.terminal).toBe("FAILED");
    expect(result.citation?.fabricatedTrajectoryDigests).toHaveLength(1);
    expect(result.citation?.fabricatedReplayIdentities).toHaveLength(1);
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "citation-no-fabrication")
        ?.status,
    ).toBe("FAIL");
    expect(
      result.criteria
        .find((criterion) => criterion.criterionId === "citation-no-fabrication")
        ?.evidence.join(" "),
    ).toContain("FABRICATED-CITATION");
  });

  test("a VARIANCE-SMOOTHING proposal over the varying population FAILs (conservatism + fidelity)", async () => {
    const row = rowById("probe-variance-smoothing");
    const clock = createTickClock();
    const ledgerInput = createReplayLedgerInput();
    const registry = createCandidateRegistry();
    const result = await driveLearningDiscovery({
      row,
      ledgerInput,
      miner: createDiscoveryMiner({ variant: "smoothing" }),
      registry,
      now: clock.now,
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.proposal?.kind).toBe("deterministicization");
    // The citation itself is complete — the fabrication is the KIND.
    expect(result.citation?.complete).toBe(true);
    expect(result.conservatism.conservative).toBe(false);
    expect(
      result.criteria.find(
        (criterion) => criterion.criterionId === "conservatism-no-variance-smoothing",
      )?.status,
    ).toBe("FAIL");
    expect(
      result.criteria
        .find((criterion) => criterion.criterionId === "conservatism-no-variance-smoothing")
        ?.evidence.join(" "),
    ).toContain("VARIANCE-SMOOTHING");
    // The deterministicization signal is empty over the varying
    // population — the kind fidelity catches the mismatch too.
    expect(result.fidelity?.faithful).toBe(false);
    // The smoothed proposal never landed.
    expect(registry.recordedProposalIds).toEqual([]);
  });

  test("a MUTATING registry (a frozen-state rewrite on propose) FAILs the no-application leg", async () => {
    const row = rowById("probe-state-mutation");
    const clock = createTickClock();
    const ledgerInput = createReplayLedgerInput();
    const beforeDigest = ledgerInput.frozenDigest();
    const result = await driveLearningDiscovery({
      row,
      ledgerInput,
      miner: createDiscoveryMiner(),
      registry: createCandidateRegistry({ mutation: "mutate-recorded-population", ledgerInput }),
      now: clock.now,
    });
    expect(result.terminal).toBe("FAILED");
    // The proposal itself was honest — the mutation happened at the
    // recording: the frozen-input digest CHANGED.
    expect(result.citation?.complete).toBe(true);
    expect(ledgerInput.frozenDigest()).not.toBe(beforeDigest);
    expect(result.noApplication.frozenInputUnchanged).toBe(false);
    expect(result.noApplication.inert).toBe(false);
    expect(
      result.criteria
        .find((criterion) => criterion.criterionId === "no-application-frozen-inputs")
        ?.evidence.join(" "),
    ).toContain("STATE-MUTATION");
  });

  test("a PROMOTING registry (a candidate recorded past the proposed stage) FAILs", async () => {
    const row = rowById("probe-state-mutation");
    const clock = createTickClock();
    const ledgerInput = createReplayLedgerInput();
    const registry = createCandidateRegistry({ mutation: "promote-proposal", ledgerInput });
    const result = await driveLearningDiscovery({
      row,
      ledgerInput,
      miner: createDiscoveryMiner(),
      registry,
      now: clock.now,
    });
    expect(result.terminal).toBe("FAILED");
    expect(registry.facts().appliedCandidateCount).toBe(1);
    expect(result.noApplication.appliedCandidateCount).toBe(1);
    expect(result.noApplication.inert).toBe(false);
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "no-application-registry-inert")
        ?.status,
    ).toBe("FAIL");
  });

  test("a MISMATCHED ledger input (a drifted population serve) FAILs the read-only pin", async () => {
    const row = rowById("rag-retrieval-deterministicization-candidate");
    const result = await driveRowOverStack({ row, mismatchedLedger: true });
    expect(result.terminal).toBe("FAILED");
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "population-served-as-pinned")
        ?.status,
    ).toBe("FAIL");
    expect(
      result.criteria
        .find((criterion) => criterion.criterionId === "population-served-as-pinned")
        ?.evidence.join(" "),
    ).toContain("POPULATION-MISMATCH");
  });

  test("a HIDING miner (an unjustified refusal over learnable structure) FAILs", async () => {
    const row = rowById("rag-retrieval-deterministicization-candidate");
    const result = await driveRowOverStack({ row, variant: "hiding" });
    expect(result.terminal).toBe("FAILED");
    expect(result.proposal).toBeNull();
    expect(result.refusal?.reason).toBe("no-learnable-structure");
    expect(result.refusalHonesty?.honest).toBe(false);
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "refusal-justified")?.status,
    ).toBe("FAIL");
    expect(
      result.criteria
        .find((criterion) => criterion.criterionId === "refusal-justified")
        ?.evidence.join(" "),
    ).toContain("UNJUSTIFIED-REFUSAL");
  });
});
