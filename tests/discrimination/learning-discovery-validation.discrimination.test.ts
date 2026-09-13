/**
 * VAL-032 acceptance criterion 6 — discrimination tests proving the
 * learned-structure discovery against controlled fakes (the six AC6
 * families over the PURE platform derivations):
 *
 *   * the FABRICATED CITATION — a proposal whose evidence citation is
 *     uncited (empty), partial (a missing replay identity or a missing
 *     trajectory digest), or fabricated (a phantom digest that is not a
 *     member of the recorded population) FAILs the evidence-citation
 *     completeness mechanically, with the fabricated or uncited members
 *     named — while the FULL honest citation over the very same
 *     population PASSES;
 *
 *   * the KIND INFIDELITY — a proposal whose declared candidate kind
 *     contradicts the mined structure (a reuse proposal over a
 *     single-workload population; a deterministicization proposal over
 *     the honestly-varying population) FAILs the candidate-kind
 *     fidelity in each direction, and a proposal citing a structure
 *     digest the miner never derived FAILs as a fabricated structure —
 *     while every honest kind over its own mined structure PASSES;
 *
 *   * the VARIANCE SMOOTHING — a deterministicization proposal over an
 *     honestly-varying population (VAL-031's reported variance) FAILs
 *     the conservatism derivation (the variance is REPORTED, never
 *     smoothed) — while a stable-segment proposal, a cache proposal
 *     over legitimately-varying trajectories (real structure, not
 *     smoothing) and an honest refusal all stay conservative;
 *
 *   * the DISHONEST REFUSAL — a refusal that hides learnable structure
 *     (the declared kind's signal fires but the discovery refuses
 *     anyway) FAILs exactly like an invented proposal, and a malformed
 *     outcome (a refusal alongside a proposal, or neither) FAILs the
 *     well-formedness — while the three justified refusals
 *     (varying-population, no-dispatched-work, no-learnable-structure)
 *     PASS;
 *
 *   * the STATE MUTATION — a proposal whose recording changes the
 *     frozen-input digest, lands past the `proposed` lifecycle stage,
 *     or sits in a registry holding applied candidates FAILs the
 *     no-application discipline — while the read-only discovery stays
 *     inert;
 *
 *   * the IDENTITY LAXITY — the proposal identity and the canonical
 *     citation are deterministic, content-derived and discriminating,
 *     and the candidate registry is append-only exactly-once (an
 *     identical re-proposal REPLAYS; a different proposal under a
 *     recorded id is REFUSED).
 */

import { describe, expect, test } from "vitest";
import { runLearningDiscoveryApp } from "../../benchmarks/validation/apps/learning-discovery/application";
import {
  LEARNING_DISCOVERY_CORPUS,
  learningDiscoveryRowById,
  OFFLINE_CORPUS_ROWS,
} from "../../benchmarks/validation/apps/learning-discovery/corpus";
import {
  createCandidateRegistry,
  createDiscoveryMiner,
  createLearningDiscoveryFakeApiWorld,
  createReplayLedgerInput,
  createTickClock,
} from "../../benchmarks/validation/apps/learning-discovery/fixtures";
import type { TransportImplementation } from "../../benchmarks/validation/harness/harness";
import type {
  CandidateKind,
  CandidateRegistryFacts,
  DiscoveryProposalRecord,
  LearningDiscoveryCorpusRow,
  MinedLearnableStructure,
  ProposalEvidenceCitation,
  RecordedReplayObservation,
} from "../../benchmarks/validation/platform/learning-discovery";
import {
  CANDIDATE_KINDS,
  canonicalCitationOf,
  deriveCandidateKindFidelity,
  deriveConservatism,
  deriveEvidenceCitationCompleteness,
  deriveHonestDiscoveryOutcome,
  deriveNoApplication,
  deriveRefusalHonesty,
  driveLearningDiscovery,
  kindSignalSizeOf,
  mineLearnableStructureOf,
  PROPOSAL_LIFECYCLE_STAGE,
  proposalIdentityIdOf,
  recordedPopulationDigestOf,
} from "../../benchmarks/validation/platform/learning-discovery";
import { longitudinalDigestOf } from "../../benchmarks/validation/platform/longitudinal-baseline";

const REVISION = "0ab099a1d066a775e3d47f40e8f0b4cd02073371";

const rowById = (rowId: string): LearningDiscoveryCorpusRow => {
  const row = learningDiscoveryRowById(rowId);
  if (row === null) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

const taskIndexOf = (rowId: string): number => {
  const index = LEARNING_DISCOVERY_CORPUS.findIndex((row) => row.rowId === rowId);
  if (index < 0) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return index;
};

/** The honest proposal record of one row's population (the oracle's own). */
function honestProposalOf(row: LearningDiscoveryCorpusRow): DiscoveryProposalRecord {
  const honest = deriveHonestDiscoveryOutcome({
    candidateKind: row.candidateKind,
    population: row.population,
  });
  if (honest.proposal === null) {
    throw new Error(`the row ${row.rowId} holds no honest proposal`);
  }
  return honest.proposal;
}

/** The honest mined structure of one row's population. */
function honestStructureOf(row: LearningDiscoveryCorpusRow): MinedLearnableStructure {
  return mineLearnableStructureOf(row.population);
}

/** A proposal record with one field overridden (the adversarial shapes). */
function withKind(proposal: DiscoveryProposalRecord, kind: CandidateKind): DiscoveryProposalRecord {
  const basis = {
    kind,
    citation: proposal.citation,
    minedStructureDigest: proposal.minedStructureDigest,
    lifecycleStage: proposal.lifecycleStage,
  };
  return { ...basis, proposalId: proposalIdentityIdOf(basis) };
}

// ---------------------------------------------------------------------------
// Family 1: the fabricated citation (the evidence-completeness catch)
// ---------------------------------------------------------------------------

describe("VAL-032 discrimination: the fabricated citation", () => {
  const ragRow = rowById("rag-retrieval-deterministicization-candidate");
  const citationOver = (
    citation: ProposalEvidenceCitation,
    population: readonly RecordedReplayObservation[] = ragRow.population,
  ) => deriveEvidenceCitationCompleteness({ population, citation });

  test("an UNCITED proposal (an empty evidence citation) FAILs", () => {
    const verdict = citationOver({ trajectoryDigests: [], replayIdentities: [] });
    expect(verdict.complete).toBe(false);
    expect(verdict.citedTrajectoryDigests).toBe(0);
    expect(verdict.citedReplayIdentities).toBe(0);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "citation-full-population")
        ?.status,
    ).toBe("FAIL");
    expect(
      verdict.criteria
        .find((criterion) => criterion.criterionId === "citation-full-population")
        ?.evidence.join(" "),
    ).toContain("UNCITED-PROPOSAL");
    // An empty citation fabricates nothing — the no-fabrication leg passes.
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "citation-no-fabrication")
        ?.status,
    ).toBe("PASS");
  });

  test("a PARTIAL population (a missing replay identity) FAILs", () => {
    const full = canonicalCitationOf(ragRow.population);
    const verdict = citationOver({
      trajectoryDigests: full.trajectoryDigests,
      replayIdentities: full.replayIdentities.slice(0, -1),
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.uncitedReplayIdentities).toEqual([
      full.replayIdentities[full.replayIdentities.length - 1],
    ]);
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
    const varying = rowById("order-settlement-cache-candidate");
    const full = canonicalCitationOf(varying.population);
    expect(full.trajectoryDigests).toHaveLength(2);
    const verdict = citationOver(
      {
        trajectoryDigests: full.trajectoryDigests.slice(0, -1),
        replayIdentities: full.replayIdentities,
      },
      varying.population,
    );
    expect(verdict.complete).toBe(false);
    expect(verdict.uncitedTrajectoryDigests).toHaveLength(1);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "citation-full-population")
        ?.status,
    ).toBe("FAIL");
  });

  test("a FABRICATED citation (a phantom digest AND a phantom identity) FAILs with the members named", () => {
    const full = canonicalCitationOf(ragRow.population);
    const phantomDigest = longitudinalDigestOf(["phantom-trajectory", "discrimination"]);
    const phantomIdentity = `exp-workload-replay-${longitudinalDigestOf(["phantom-identity", "discrimination"])}`;
    const verdict = citationOver({
      trajectoryDigests: [...full.trajectoryDigests, phantomDigest],
      replayIdentities: [...full.replayIdentities, phantomIdentity],
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.fabricatedTrajectoryDigests).toEqual([phantomDigest]);
    expect(verdict.fabricatedReplayIdentities).toEqual([phantomIdentity]);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "citation-no-fabrication")
        ?.status,
    ).toBe("FAIL");
    expect(
      verdict.criteria
        .find((criterion) => criterion.criterionId === "citation-no-fabrication")
        ?.evidence.join(" "),
    ).toContain("FABRICATED-CITATION");
    expect(
      verdict.criteria
        .find((criterion) => criterion.criterionId === "citation-no-fabrication")
        ?.evidence.join(" "),
    ).toContain(phantomDigest);
  });

  test("the FULL honest citation PASSES; empty-declared-signal edges FAIL", () => {
    // The honest control: the canonical citation over the very same
    // population is COMPLETE.
    const honest = citationOver(canonicalCitationOf(ragRow.population));
    expect(honest.complete).toBe(true);
    expect(honest.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
    // An empty declared-digest signal with full identities is still
    // uncited (the digest side of the citation is empty).
    const full = canonicalCitationOf(ragRow.population);
    const emptyDigests = citationOver({
      trajectoryDigests: [],
      replayIdentities: full.replayIdentities,
    });
    expect(emptyDigests.complete).toBe(false);
    expect(emptyDigests.uncitedTrajectoryDigests).toEqual(full.trajectoryDigests);
    const emptyIdentities = citationOver({
      trajectoryDigests: full.trajectoryDigests,
      replayIdentities: [],
    });
    expect(emptyIdentities.complete).toBe(false);
    expect(emptyIdentities.uncitedReplayIdentities).toEqual(full.replayIdentities);
  });

  test("a single-observation population is not evidence for a generalization", () => {
    const single = ragRow.population.slice(0, 1);
    const verdict = citationOver(canonicalCitationOf(single), single);
    expect(verdict.minimumEvidence).toBe(false);
    expect(verdict.complete).toBe(false);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "citation-minimum-evidence")
        ?.status,
    ).toBe("FAIL");
    expect(
      verdict.criteria
        .find((criterion) => criterion.criterionId === "citation-minimum-evidence")
        ?.evidence.join(" "),
    ).toContain("SINGLE-OBSERVATION");
  });
});

// ---------------------------------------------------------------------------
// Family 2: the kind infidelity (the candidate-kind fidelity catch)
// ---------------------------------------------------------------------------

describe("VAL-032 discrimination: the kind infidelity", () => {
  test("a proposal kind contradicting the mined structure FAILs each direction", () => {
    // A REUSE proposal over a single-workload population: the reuse
    // signal (shapes across DISTINCT workloads) is empty — a mismatch.
    const ragRow = rowById("rag-retrieval-deterministicization-candidate");
    const ragStructure = honestStructureOf(ragRow);
    expect(kindSignalSizeOf(ragStructure, "reuse")).toBe(0);
    const reuseProposal = withKind(honestProposalOf(ragRow), "reuse");
    const reuseVerdict = deriveCandidateKindFidelity({
      proposal: reuseProposal,
      structure: ragStructure,
    });
    expect(reuseVerdict.faithful).toBe(false);
    expect(
      reuseVerdict.criteria.find((criterion) => criterion.criterionId === "kind-fidelity")?.status,
    ).toBe("FAIL");
    expect(
      reuseVerdict.criteria
        .find((criterion) => criterion.criterionId === "kind-fidelity")
        ?.evidence.join(" "),
    ).toContain("KIND-MISMATCH");

    // A DETERMINISTICIZATION proposal over the varying population: the
    // deterministicization signal is empty (the population honestly
    // varies) — the reverse-direction mismatch.
    const varyingRow = rowById("order-settlement-cache-candidate");
    const varyingStructure = honestStructureOf(varyingRow);
    expect(kindSignalSizeOf(varyingStructure, "deterministicization")).toBe(0);
    const varyingProposal = withKind(honestProposalOf(varyingRow), "deterministicization");
    const varyingVerdict = deriveCandidateKindFidelity({
      proposal: varyingProposal,
      structure: varyingStructure,
    });
    expect(varyingVerdict.faithful).toBe(false);
    expect(
      varyingVerdict.criteria.find((criterion) => criterion.criterionId === "kind-fidelity")
        ?.status,
    ).toBe("FAIL");
  });

  test("a FABRICATED structure digest (a structure the mining did not derive) FAILs", () => {
    const row = rowById("tool-loop-competence-candidate");
    const structure = honestStructureOf(row);
    const honest = honestProposalOf(row);
    const fabricated = {
      ...honest,
      minedStructureDigest: longitudinalDigestOf(["fabricated-structure", row.rowId]),
      proposalId: honest.proposalId,
    };
    const verdict = deriveCandidateKindFidelity({ proposal: fabricated, structure });
    expect(verdict.faithful).toBe(false);
    expect(verdict.structureDigestMatches).toBe(false);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "mined-structure-digest")
        ?.status,
    ).toBe("FAIL");
    expect(
      verdict.criteria
        .find((criterion) => criterion.criterionId === "mined-structure-digest")
        ?.evidence.join(" "),
    ).toContain("FABRICATED-STRUCTURE");
  });

  test("every honest kind over its own mined structure PASSES", () => {
    const rowsByKind: Record<CandidateKind, string> = {
      reuse: "cross-workload-reuse-candidate",
      cache: "order-settlement-cache-candidate",
      competence: "tool-loop-competence-candidate",
      deterministicization: "rag-retrieval-deterministicization-candidate",
    };
    for (const kind of CANDIDATE_KINDS) {
      const row = rowById(rowsByKind[kind]);
      const honest = deriveHonestDiscoveryOutcome({
        candidateKind: kind,
        population: row.population,
      });
      expect(honest.proposal?.kind, `${kind} emits its proposal`).toBe(kind);
      const verdict = deriveCandidateKindFidelity({
        proposal: honest.proposal as DiscoveryProposalRecord,
        structure: honest.structure,
      });
      expect(verdict.faithful, `${kind} faithful`).toBe(true);
      expect(verdict.signalSize, `${kind} signal`).toBeGreaterThan(0);
      expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Family 3: the variance smoothing (the conservatism catch)
// ---------------------------------------------------------------------------

describe("VAL-032 discrimination: the variance smoothing", () => {
  test("a deterministicization proposal over the VARYING population FAILs (the variance is never smoothed)", () => {
    const row = rowById("order-settlement-varying-refusal");
    const structure = honestStructureOf(row);
    expect(structure.varyingSegments).toHaveLength(1);
    expect(structure.varyingSegments[0]?.observedDigests).toHaveLength(2);
    // The variance-smoothing proposal: a deterministicization candidate
    // citing the full varying population anyway.
    const basis = {
      kind: "deterministicization" as const,
      citation: canonicalCitationOf(row.population),
      minedStructureDigest: structure.digest,
      lifecycleStage: PROPOSAL_LIFECYCLE_STAGE,
    };
    const smoothing = { ...basis, proposalId: proposalIdentityIdOf(basis) };
    const verdict = deriveConservatism({ proposal: smoothing, structure });
    expect(verdict.conservative).toBe(false);
    expect(verdict.varyingWorkloadIds).toEqual(structure.varyingSegments.map((r) => r.workloadId));
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
    // The variance-report leg PASSES even under the smoothing attempt:
    // the report rides the structure, never the proposal.
    expect(
      verdict.criteria.find(
        (criterion) => criterion.criterionId === "conservatism-variance-reported",
      )?.status,
    ).toBe("PASS");
  });

  test("the conservative controls: a stable segment, a cache-over-variance, and an honest refusal", () => {
    // A deterministicization proposal over the STABLE rag population.
    const ragRow = rowById("rag-retrieval-deterministicization-candidate");
    const ragVerdict = deriveConservatism({
      proposal: honestProposalOf(ragRow),
      structure: honestStructureOf(ragRow),
    });
    expect(ragVerdict.conservative).toBe(true);
    expect(ragVerdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
    // A CACHE proposal over the varying population: the input→output
    // transformation is REAL structure — not smoothing.
    const varyingRow = rowById("order-settlement-cache-candidate");
    const cacheVerdict = deriveConservatism({
      proposal: honestProposalOf(varyingRow),
      structure: honestStructureOf(varyingRow),
    });
    expect(cacheVerdict.conservative).toBe(true);
    expect(cacheVerdict.varyingWorkloadIds).toHaveLength(1);
    // An honest refusal (a null proposal) is always conservative.
    const refusalVerdict = deriveConservatism({
      proposal: null,
      structure: honestStructureOf(rowById("order-settlement-varying-refusal")),
    });
    expect(refusalVerdict.conservative).toBe(true);
    expect(refusalVerdict.proposalKind).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Family 4: the dishonest refusal (the refusal-honesty catch)
// ---------------------------------------------------------------------------

describe("VAL-032 discrimination: the dishonest refusal", () => {
  test("a HIDING refusal (the declared kind's signal fires but the discovery refuses) FAILs", () => {
    const row = rowById("rag-retrieval-deterministicization-candidate");
    const structure = honestStructureOf(row);
    expect(kindSignalSizeOf(structure, "deterministicization")).toBeGreaterThan(0);
    const verdict = deriveRefusalHonesty({
      candidateKind: "deterministicization",
      refusal: { reason: "no-learnable-structure" },
      proposalEmitted: false,
      structure,
    });
    expect(verdict.honest).toBe(false);
    expect(verdict.justified).toBe(false);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "refusal-justified")?.status,
    ).toBe("FAIL");
    expect(
      verdict.criteria
        .find((criterion) => criterion.criterionId === "refusal-justified")
        ?.evidence.join(" "),
    ).toContain("UNJUSTIFIED-REFUSAL");
    // The refusal-honesty catch fires for the other kinds too: a cache
    // refusal over a population with a firing cache signal.
    const cacheVerdict = deriveRefusalHonesty({
      candidateKind: "cache",
      refusal: { reason: "no-learnable-structure" },
      proposalEmitted: false,
      structure: honestStructureOf(rowById("order-settlement-cache-candidate")),
    });
    expect(cacheVerdict.honest).toBe(false);
  });

  test("the three JUSTIFIED refusals pass (varying-population, no-dispatched-work, no-learnable-structure)", () => {
    const varying = deriveRefusalHonesty({
      candidateKind: "deterministicization",
      refusal: { reason: "varying-population" },
      proposalEmitted: false,
      structure: honestStructureOf(rowById("order-settlement-varying-refusal")),
    });
    expect(varying.honest).toBe(true);
    expect(varying.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
    const guard = deriveRefusalHonesty({
      candidateKind: "deterministicization",
      refusal: { reason: "no-dispatched-work" },
      proposalEmitted: false,
      structure: honestStructureOf(rowById("oversized-batch-guard-refusal")),
    });
    expect(guard.honest).toBe(true);
    // A reuse question over a single-workload population: no
    // cross-workload shape — an honest no-learnable-structure refusal.
    const noStructure = deriveRefusalHonesty({
      candidateKind: "reuse",
      refusal: { reason: "no-learnable-structure" },
      proposalEmitted: false,
      structure: honestStructureOf(rowById("rag-retrieval-deterministicization-candidate")),
    });
    expect(noStructure.honest).toBe(true);
    // A refusal justified for one kind is NOT justified for another: a
    // no-learnable-structure refusal over a firing signal is hiding.
    expect(
      deriveRefusalHonesty({
        candidateKind: "deterministicization",
        refusal: { reason: "no-learnable-structure" },
        proposalEmitted: false,
        structure: honestStructureOf(rowById("order-settlement-varying-refusal")),
      }).justified,
    ).toBe(false);
  });

  test("a MALFORMED outcome (refusal XOR proposal violated) FAILs in both directions", () => {
    const structure = honestStructureOf(rowById("rag-retrieval-deterministicization-candidate"));
    // A refusal ALONGSIDE a proposal: both emitted.
    const bothEmitted = deriveRefusalHonesty({
      candidateKind: "deterministicization",
      refusal: { reason: "no-learnable-structure" },
      proposalEmitted: true,
      structure,
    });
    expect(bothEmitted.honest).toBe(false);
    expect(
      bothEmitted.criteria.find((criterion) => criterion.criterionId === "refusal-well-formed")
        ?.status,
    ).toBe("FAIL");
    expect(
      bothEmitted.criteria
        .find((criterion) => criterion.criterionId === "refusal-well-formed")
        ?.evidence.join(" "),
    ).toContain("MALFORMED-OUTCOME");
    // NEITHER emitted: no refusal and no proposal.
    const neither = deriveRefusalHonesty({
      candidateKind: "deterministicization",
      refusal: null,
      proposalEmitted: false,
      structure,
    });
    expect(neither.honest).toBe(false);
    expect(
      neither.criteria.find((criterion) => criterion.criterionId === "refusal-well-formed")?.status,
    ).toBe("FAIL");
    // The well-formed control: a refusal with no proposal is honest.
    const wellFormed = deriveRefusalHonesty({
      candidateKind: "deterministicization",
      refusal: { reason: "varying-population" },
      proposalEmitted: false,
      structure: honestStructureOf(rowById("order-settlement-varying-refusal")),
    });
    expect(wellFormed.honest).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Family 5: the state mutation (the no-application catch)
// ---------------------------------------------------------------------------

describe("VAL-032 discrimination: the state mutation", () => {
  const row = rowById("rag-retrieval-deterministicization-candidate");
  const proposal = honestProposalOf(row);
  const frozenDigest = recordedPopulationDigestOf(row.population);
  const facts = (applied: number): CandidateRegistryFacts => ({
    candidates: [
      {
        proposalId: proposal.proposalId,
        kind: proposal.kind,
        lifecycleStage: applied > 0 ? "promoted" : proposal.lifecycleStage,
        citationDigest: longitudinalDigestOf([
          proposal.citation.trajectoryDigests,
          proposal.citation.replayIdentities,
        ]),
        minedStructureDigest: proposal.minedStructureDigest,
      },
    ],
    appliedCandidateCount: applied,
  });

  test("a CHANGED frozen-input digest FAILs (the discovery mutated frozen state)", () => {
    const verdict = deriveNoApplication({
      beforeFrozenDigest: frozenDigest,
      afterFrozenDigest: longitudinalDigestOf(["mutated-frozen-state"]),
      proposal,
      registryFacts: facts(0),
    });
    expect(verdict.inert).toBe(false);
    expect(verdict.frozenInputUnchanged).toBe(false);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "no-application-frozen-inputs")
        ?.status,
    ).toBe("FAIL");
    expect(
      verdict.criteria
        .find((criterion) => criterion.criterionId === "no-application-frozen-inputs")
        ?.evidence.join(" "),
    ).toContain("STATE-MUTATION");
  });

  test("an APPLIED proposal stage (past proposed) FAILs", () => {
    const applied = { ...proposal, lifecycleStage: "promoted" as const };
    const verdict = deriveNoApplication({
      beforeFrozenDigest: frozenDigest,
      afterFrozenDigest: frozenDigest,
      proposal: applied,
      registryFacts: facts(1),
    });
    expect(verdict.proposalStageProposed).toBe(false);
    expect(verdict.inert).toBe(false);
    expect(
      verdict.criteria.find(
        (criterion) => criterion.criterionId === "no-application-lifecycle-stage",
      )?.status,
    ).toBe("FAIL");
    expect(
      verdict.criteria
        .find((criterion) => criterion.criterionId === "no-application-lifecycle-stage")
        ?.evidence.join(" "),
    ).toContain("APPLIED-PROPOSAL");
  });

  test("a MUTATED registry (applied candidates held) FAILs; the read-only discovery stays inert", () => {
    const mutated = deriveNoApplication({
      beforeFrozenDigest: frozenDigest,
      afterFrozenDigest: frozenDigest,
      proposal,
      registryFacts: facts(1),
    });
    expect(mutated.appliedCandidateCount).toBe(1);
    expect(mutated.inert).toBe(false);
    expect(
      mutated.criteria.find(
        (criterion) => criterion.criterionId === "no-application-registry-inert",
      )?.status,
    ).toBe("FAIL");
    // The honest control: an unchanged frozen digest, a proposal at the
    // proposed stage, and a registry holding proposals only.
    const inert = deriveNoApplication({
      beforeFrozenDigest: frozenDigest,
      afterFrozenDigest: frozenDigest,
      proposal,
      registryFacts: facts(0),
    });
    expect(inert.inert).toBe(true);
    expect(inert.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
    // An honest refusal is inert too (nothing recorded, nothing mutated).
    const refusalInert = deriveNoApplication({
      beforeFrozenDigest: frozenDigest,
      afterFrozenDigest: frozenDigest,
      proposal: null,
      registryFacts: { candidates: [], appliedCandidateCount: 0 },
    });
    expect(refusalInert.inert).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Family 6: the mining + the honest outcome + the identity determinism
// ---------------------------------------------------------------------------

describe("VAL-032 discrimination: the mining, the honest outcome, and the identity", () => {
  test("the mining derives each population's honest structure (reuse spans workloads; variance reported; guard empty)", () => {
    // The reuse population: one shape across TWO distinct workloads.
    const reuseStructure = honestStructureOf(rowById("cross-workload-reuse-candidate"));
    expect(reuseStructure.reuseCandidates).toHaveLength(1);
    expect(reuseStructure.reuseCandidates[0]?.workloadIds).toHaveLength(2);
    expect(reuseStructure.reuseCandidates[0]?.occurrences).toBe(8);
    // The varying population: NO deterministicization candidate and the
    // honest variance report (two observed digests).
    const varyingStructure = honestStructureOf(rowById("order-settlement-varying-refusal"));
    expect(varyingStructure.deterministicizationCandidates).toHaveLength(0);
    expect(varyingStructure.varyingSegments).toHaveLength(1);
    expect(varyingStructure.varyingSegments[0]?.observedDigests).toHaveLength(2);
    // The varying population still holds the stable input→output signal.
    expect(varyingStructure.cacheCandidates).toHaveLength(1);
    expect(varyingStructure.cacheCandidates[0]?.occurrences).toBe(4);
    // The guard population: no dispatched work, no signal at all.
    const guardStructure = honestStructureOf(rowById("oversized-batch-guard-refusal"));
    expect(guardStructure.dispatchedObservations).toBe(0);
    expect(guardStructure.populationSize).toBe(3);
    for (const kind of CANDIDATE_KINDS) {
      expect(kindSignalSizeOf(guardStructure, kind)).toBe(0);
    }
    // The tool-loop population: the recurring competence pattern.
    const competenceStructure = honestStructureOf(rowById("tool-loop-competence-candidate"));
    expect(kindSignalSizeOf(competenceStructure, "competence")).toBeGreaterThan(0);
    expect(competenceStructure.deterministicizationCandidates).toHaveLength(1);
  });

  test("the honest discovery outcome: a proposal per firing kind; the three honest refusals", () => {
    const rowsByKind: Record<CandidateKind, string> = {
      reuse: "cross-workload-reuse-candidate",
      cache: "order-settlement-cache-candidate",
      competence: "tool-loop-competence-candidate",
      deterministicization: "rag-retrieval-deterministicization-candidate",
    };
    for (const kind of CANDIDATE_KINDS) {
      const row = rowById(rowsByKind[kind]);
      const outcome = deriveHonestDiscoveryOutcome({
        candidateKind: kind,
        population: row.population,
      });
      expect(outcome.proposal?.kind, `${kind} proposal kind`).toBe(kind);
      expect(outcome.refusal).toBeNull();
      // The proposal cites the FULL canonical population.
      expect(outcome.proposal?.citation).toEqual(canonicalCitationOf(row.population));
      // The proposal cites the miner's own structure digest.
      expect(outcome.proposal?.minedStructureDigest).toBe(outcome.structure.digest);
      expect(outcome.proposal?.lifecycleStage).toBe(PROPOSAL_LIFECYCLE_STAGE);
    }
    // The honest refusals: the varying population, the guard population,
    // and the no-structure question (reuse over a single workload).
    const varying = deriveHonestDiscoveryOutcome({
      candidateKind: "deterministicization",
      population: rowById("order-settlement-varying-refusal").population,
    });
    expect(varying.proposal).toBeNull();
    expect(varying.refusal?.reason).toBe("varying-population");
    const guard = deriveHonestDiscoveryOutcome({
      candidateKind: "deterministicization",
      population: rowById("oversized-batch-guard-refusal").population,
    });
    expect(guard.proposal).toBeNull();
    expect(guard.refusal?.reason).toBe("no-dispatched-work");
    const noStructure = deriveHonestDiscoveryOutcome({
      candidateKind: "reuse",
      population: rowById("rag-retrieval-deterministicization-candidate").population,
    });
    expect(noStructure.proposal).toBeNull();
    expect(noStructure.refusal?.reason).toBe("no-learnable-structure");
  });

  test("the proposal identity and the canonical citation are deterministic and discriminating", () => {
    const row = rowById("cross-workload-reuse-candidate");
    const proposal = honestProposalOf(row);
    // Deterministic: the same content always derives the same identity.
    expect(proposalIdentityIdOf(proposal)).toBe(proposal.proposalId);
    expect(proposalIdentityIdOf(proposal)).toBe(proposalIdentityIdOf({ ...proposal }));
    // The derived cand-<kind>-<digest> form.
    expect(proposal.proposalId).toMatch(/^cand-learning-discovery-[0-9a-f]{8}$/);
    // Discriminating: a different kind, citation, structure digest or
    // lifecycle stage derives a DIFFERENT identity.
    expect(proposalIdentityIdOf(withKind(proposal, "cache"))).not.toBe(proposal.proposalId);
    expect(
      proposalIdentityIdOf({
        ...proposal,
        citation: {
          trajectoryDigests: proposal.citation.trajectoryDigests.slice(0, -1),
          replayIdentities: proposal.citation.replayIdentities,
        },
      }),
    ).not.toBe(proposal.proposalId);
    expect(
      proposalIdentityIdOf({
        ...proposal,
        minedStructureDigest: longitudinalDigestOf(["other-structure"]),
      }),
    ).not.toBe(proposal.proposalId);
    expect(proposalIdentityIdOf({ ...proposal, lifecycleStage: "observed" })).not.toBe(
      proposal.proposalId,
    );
    // The canonical citation: distinct digests SORTED, identities in
    // population order.
    const citation = canonicalCitationOf(row.population);
    expect(citation.trajectoryDigests).toEqual([...citation.trajectoryDigests].sort());
    expect(citation.replayIdentities).toEqual(row.population.map((o) => o.replayIdentity));
    expect(new Set(citation.trajectoryDigests).size).toBe(citation.trajectoryDigests.length);
  });
});

// ---------------------------------------------------------------------------
// Family 7: the app contract over the fake-world knob variants
// ---------------------------------------------------------------------------

/** Run one app row over the fake API world (the customer-boundary catch). */
async function runAppOverFakeWorld(options: {
  readonly rowId: string;
  readonly uncited?: boolean;
  readonly mutating?: boolean;
}): Promise<Awaited<ReturnType<typeof runLearningDiscoveryApp>>> {
  const clock = createTickClock();
  const world = createLearningDiscoveryFakeApiWorld({
    clock,
    ...(options.uncited === true ? { uncited: true } : {}),
    ...(options.mutating === true ? { mutating: true } : {}),
  });
  return runLearningDiscoveryApp({
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
      configuration: { suite: "val-032-discrimination" },
    },
    runSuffix: "disc",
    taskIndex: taskIndexOf(options.rowId),
  });
}

describe("VAL-032 discrimination: the app contract over the fake-world knobs", () => {
  test("the honest world passes every offline row's app contract (the control)", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const outcome = await runAppOverFakeWorld({ rowId: row.rowId });
      expect(
        outcome.passed,
        `${row.rowId} app contract (criteria: ${JSON.stringify(
          outcome.appCriteria.filter((criterion) => criterion.status === "FAIL"),
        )})`,
      ).toBe(true);
    }
  });

  test("an UNCITED read-back proposal FAILs the boundary contract", async () => {
    const outcome = await runAppOverFakeWorld({
      rowId: "cross-workload-reuse-candidate",
      uncited: true,
    });
    expect(outcome.passed).toBe(false);
    expect(
      outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-citation-full-population",
      )?.status,
    ).toBe("FAIL");
    expect(
      outcome.appCriteria
        .find((criterion) => criterion.criterionId === "app-citation-full-population")
        ?.evidence.join(" "),
    ).toContain("UNCITED-PROPOSAL");
  });

  test("an APPLIED read-back proposal FAILs the boundary lifecycle stage", async () => {
    const outcome = await runAppOverFakeWorld({
      rowId: "rag-retrieval-deterministicization-candidate",
      mutating: true,
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.outcome.proposal?.lifecycleStage).toBe("promoted");
    expect(
      outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-proposal-lifecycle-proposed",
      )?.status,
    ).toBe("FAIL");
    expect(
      outcome.appCriteria
        .find((criterion) => criterion.criterionId === "app-proposal-lifecycle-proposed")
        ?.evidence.join(" "),
    ).toContain("APPLIED-PROPOSAL");
  });
});

// ---------------------------------------------------------------------------
// Family 8: the registry exactly-once (the append-only catch)
// ---------------------------------------------------------------------------

describe("VAL-032 discrimination: the registry exactly-once", () => {
  test("an identical re-proposal REPLAYS; a DIFFERENT proposal under a recorded id is REFUSED", async () => {
    const row = rowById("rag-retrieval-deterministicization-candidate");
    const registry = createCandidateRegistry();
    const proposal = honestProposalOf(row);
    const first = await registry.propose(proposal);
    expect(first).toEqual({ accepted: true, replayed: false, refused: false });
    // The duplicate: an IDENTICAL proposal under the same derived id.
    const duplicate = await registry.propose(proposal);
    expect(duplicate).toEqual({ accepted: true, replayed: true, refused: false });
    expect(registry.facts().candidates).toHaveLength(1);
    // The impostor: a DIFFERENT proposal (a fabricated citation) under
    // the already-recorded id — REFUSED, the registry unchanged.
    const impostor = {
      ...proposal,
      citation: {
        trajectoryDigests: ["00000000"],
        replayIdentities: proposal.citation.replayIdentities,
      },
    };
    const refused = await registry.propose(impostor);
    expect(refused).toEqual({ accepted: false, replayed: false, refused: true });
    expect(registry.facts().candidates).toHaveLength(1);
    // The recorded candidate is the honest one, at the proposed stage.
    expect(registry.recordedProposalIds).toEqual([proposal.proposalId]);
    expect(registry.facts().candidates[0]?.lifecycleStage).toBe(PROPOSAL_LIFECYCLE_STAGE);
    expect(registry.facts().appliedCandidateCount).toBe(0);
  });

  test("a refusal-honest driver run records NOTHING (the empty-registry control)", async () => {
    const registry = createCandidateRegistry();
    const result = await driveLearningDiscovery({
      row: rowById("order-settlement-varying-refusal"),
      ledgerInput: createReplayLedgerInput(),
      miner: createDiscoveryMiner(),
      registry,
      now: createTickClock().now,
    });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.registryRecording).toBeNull();
    expect(registry.recordedProposalIds).toEqual([]);
    expect(registry.facts().candidates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The battery-level honest control (every offline discovery row)
// ---------------------------------------------------------------------------

describe("VAL-032 discrimination: the honest discovery runs (the control)", () => {
  test("every offline row's discovery run passes honestly over the fixture stack", async () => {
    for (const offlineRow of OFFLINE_CORPUS_ROWS) {
      const result = await driveLearningDiscovery({
        row: offlineRow,
        ledgerInput: createReplayLedgerInput(),
        miner: createDiscoveryMiner(),
        registry: createCandidateRegistry(),
        now: createTickClock().now,
      });
      expect(result.terminal, `${offlineRow.rowId} terminal`).toBe("COMPLETED");
      expect(
        result.proposal?.kind ?? result.refusal?.reason ?? null,
        `${offlineRow.rowId} outcome`,
      ).toBe(offlineRow.expected.kind ?? offlineRow.expected.refusalReason);
      expect(result.latencyMs, `${offlineRow.rowId} latency measured`).toBeGreaterThanOrEqual(0);
      expect(result.usage, `${offlineRow.rowId} offline usage none-reported`).toBeNull();
      expect(result.observedModelCalls, `${offlineRow.rowId} own dispatches`).toBe(0);
      const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
      expect(failed, `${offlineRow.rowId}: ${JSON.stringify(failed)}`).toEqual([]);
    }
  });
});
