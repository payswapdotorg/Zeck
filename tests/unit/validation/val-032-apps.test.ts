/**
 * VAL-032 acceptance criterion 1: the learning-discovery customer
 * application rides the public SDK boundary end to end against a
 * controlled fake transport (the discovery-submission phase — one OWN
 * durable execution per row under its OWN idempotency key; the
 * observation phase — the completion poll, the result retrieval (the
 * verification statuses, the route's model-call count, the honest
 * offline-none usage, the discovery outcome read back) and the events
 * read re-deriving the discovery trajectory digest over the public
 * journal; the assertion phase — the PURE per-row discovery contract
 * re-derived AT the boundary), and its pinned task slice matches the
 * repository configuration file and the corpus. The fake world
 * implements the platform's OWN discovery semantics at the customer
 * boundary (the per-row create semantics at the POST boundary; the
 * honest terminal shapes at the read boundary — an honest REFUSAL is a
 * COMPLETED discovery, never a fabricated failure; the canonical
 * discovery trajectories at the events read) so the app's per-row
 * assertions are exercised honestly.
 *
 * Discrimination: the fake-miner variants (UNCITED / PARTIAL /
 * FABRICATED / SMOOTHING / HIDING) each FAIL a specific mechanical
 * criterion and NEVER land their dishonest proposal in the candidate
 * registry; the MUTATING registry variants (the frozen-state rewrite,
 * the promoted candidate) FAIL the no-application discipline; the
 * fake-world knobs (terminal override, uncited / partial / fabricated
 * read-back, smoothing, an applied read-back) each FAIL the boundary
 * contract — while the honest world passes every offline row (proposal
 * rows landing COMPLETE proposals at the `proposed` stage, refusal rows
 * reporting their pinned reasons, refusals recording NOTHING).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  LEARNING_DISCOVERY_TASKS,
  runLearningDiscoveryApp,
} from "../../../benchmarks/validation/apps/learning-discovery/application";
import {
  discoverySubmissionKey,
  discoveryTaskBodyFor,
  LEARNING_DISCOVERY_CORPUS,
  LEARNING_DISCOVERY_ROW_IDS,
  LEARNING_DISCOVERY_TASK_KIND,
  learningDiscoveryRowById,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
  pinnedCitationOf,
  pinnedProposalOf,
  REFERENCED_REPLAY_ROWS,
  recordedObservationsOf,
  recordedPopulationIdOf,
} from "../../../benchmarks/validation/apps/learning-discovery/corpus";
import {
  createCandidateRegistry,
  createDiscoveryMiner,
  createLearningDiscoveryFakeApiWorld,
  createReplayLedgerInput,
  createTickClock,
  type FakeMinerVariant,
} from "../../../benchmarks/validation/apps/learning-discovery/fixtures";
import { workloadReplayRowById } from "../../../benchmarks/validation/apps/workload-replay/corpus";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { HarnessEvidence } from "../../../benchmarks/validation/harness/evidence";
import type { TransportImplementation } from "../../../benchmarks/validation/harness/harness";
import type {
  LearningDiscoveryCorpusRow,
  LearningDiscoveryResult,
} from "../../../benchmarks/validation/platform/learning-discovery";
import {
  canonicalCitationOf,
  deriveHonestDiscoveryOutcome,
  driveLearningDiscovery,
  isCandidateKind,
  isDiscoveryProbeKind,
  PROPOSAL_LIFECYCLE_STAGE,
} from "../../../benchmarks/validation/platform/learning-discovery";

const REVISION = "0ab099a1d066a775e3d47f40e8f0b4cd02073371";

const baseConfig = {
  applicationId: "app-1",
  baseUrl: "http://fake-zeck.local",
  tokenEnvVar: "ZECK_VALIDATION_TOKEN",
  applicationRevision: REVISION,
  corpusRevision: REVISION,
  integrationSurface: "sdk",
  pollIntervalMs: 1,
  completionTimeoutMs: 5_000,
};

/** Run one app row over the fake API world (the boundary discrimination knobs). */
async function runAppOverFakeWorld(options: {
  readonly taskIndex: number;
  readonly terminal?: "COMPLETED" | "FAILED";
  readonly uncited?: boolean;
  readonly partial?: boolean;
  readonly fabricated?: boolean;
  readonly smoothing?: boolean;
  readonly mutating?: boolean;
}): Promise<{
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly outcome: Awaited<ReturnType<typeof runLearningDiscoveryApp>>;
  readonly createdExecutions: number;
}> {
  const clock = createTickClock();
  const world = createLearningDiscoveryFakeApiWorld({
    clock,
    ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    ...(options.uncited === true ? { uncited: true } : {}),
    ...(options.partial === true ? { partial: true } : {}),
    ...(options.fabricated === true ? { fabricated: true } : {}),
    ...(options.smoothing === true ? { smoothing: true } : {}),
    ...(options.mutating === true ? { mutating: true } : {}),
  });
  const outcome = await runLearningDiscoveryApp({
    config: baseConfig,
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
      configuration: { suite: "val-032-apps" },
    },
    runSuffix: "unit",
    taskIndex: options.taskIndex,
  });
  return {
    evidence: outcome.evidence,
    passed: outcome.passed,
    outcome,
    createdExecutions: world.createdExecutions,
  };
}

/** Drive one offline row over a purpose-built fake stack (the miner/registry seams). */
async function driveRowOverStack(options: {
  readonly row: LearningDiscoveryCorpusRow;
  readonly variant?: FakeMinerVariant;
  readonly registryMutation?: "mutate-recorded-population" | "promote-proposal";
}): Promise<LearningDiscoveryResult> {
  const clock = createTickClock();
  const ledgerInput = createReplayLedgerInput();
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
    now: clock.now,
  });
}

/** The task index of one corpus row. */
function taskIndexOf(rowId: string): number {
  const index = LEARNING_DISCOVERY_CORPUS.findIndex((row) => row.rowId === rowId);
  if (index < 0) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return index;
}

const rowById = (rowId: string): LearningDiscoveryCorpusRow => {
  const row = learningDiscoveryRowById(rowId);
  if (row === null) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

// ---------------------------------------------------------------------------
// The pinned task slice ↔ corpus ↔ config.json consistency
// ---------------------------------------------------------------------------

describe("VAL-032 app task-slice consistency", () => {
  test("the exported task slice mirrors the corpus exactly", () => {
    expect(LEARNING_DISCOVERY_TASKS.length).toBe(LEARNING_DISCOVERY_CORPUS.length);
    for (const [index, task] of LEARNING_DISCOVERY_TASKS.entries()) {
      const row = LEARNING_DISCOVERY_CORPUS[index];
      expect(task.rowId).toBe(row?.rowId);
      expect(task.kind).toBe(LEARNING_DISCOVERY_TASK_KIND);
      expect(task.replayPopulationRefs).toEqual(row?.replayPopulationRefs);
      expect(task.candidateKind).toBe(row?.candidateKind);
      expect(task.populationSize).toBe(row?.population.length);
      expect(task.distinctTrajectoryDigests).toBe(
        new Set(row?.population.map((observation) => observation.trajectoryDigest) ?? []).size,
      );
      expect(task.replayIdentities).toBe(row?.population.length);
      expect(task.expectedEmitsProposal).toBe(row?.expected.emitsProposal);
      expect(task.expectedKind).toBe(row?.expected.kind);
      expect(task.expectedRefusalReason).toBe(row?.expected.refusalReason);
      expect(task.expectedStructureDigest).toBe(row?.expected.minedStructureDigest);
      expect(task.trajectoryClassSize).toBe(row?.expectedTrajectoryClass.length);
      expect(task.expectedModelCalls).toBe(row?.expected.modelCalls);
      expect(task.probe ?? null).toBe(row?.probe?.kind ?? null);
      expect(task.liveGate ?? null).toEqual(row?.liveGate?.envVars ?? null);
    }
  });

  test("config.json mirrors the exported task slice", async () => {
    const config = JSON.parse(
      await readFile(
        join(
          import.meta.dirname,
          "../../../benchmarks/validation/apps/learning-discovery/config.json",
        ),
        "utf-8",
      ),
    ) as { tasks: Record<string, unknown>[]; tokenEnvVar: string; integrationSurface: string };
    expect(config.tasks.length).toBe(LEARNING_DISCOVERY_TASKS.length);
    for (const [index, task] of config.tasks.entries()) {
      const exported = LEARNING_DISCOVERY_TASKS[index];
      expect(task.rowId).toBe(exported?.rowId);
      expect(task.kind).toBe(exported?.kind);
      expect(task.replayPopulationRefs).toEqual(exported?.replayPopulationRefs);
      expect(task.candidateKind).toBe(exported?.candidateKind);
      expect(task.populationSize).toBe(exported?.populationSize);
      expect(task.distinctTrajectoryDigests).toBe(exported?.distinctTrajectoryDigests);
      expect(task.replayIdentities).toBe(exported?.replayIdentities);
      expect(task.expectedEmitsProposal).toBe(exported?.expectedEmitsProposal);
      expect(task.expectedKind).toBe(exported?.expectedKind);
      expect(task.expectedRefusalReason).toBe(exported?.expectedRefusalReason);
      expect(task.expectedStructureDigest).toBe(exported?.expectedStructureDigest);
      expect(task.trajectoryClassSize).toBe(exported?.trajectoryClassSize);
      expect(task.expectedModelCalls).toBe(exported?.expectedModelCalls);
      expect(task.probe ?? null).toBe(exported?.probe ?? null);
      expect(task.liveGate ?? null).toEqual(exported?.liveGate ?? null);
    }
    expect(config.tokenEnvVar).toBe("ZECK_VALIDATION_TOKEN");
    expect(config.integrationSurface).toBe("sdk");
  });

  test("the corpus is well-formed (unique ids, valid kinds, recorded populations, honest oracles)", () => {
    const rowIds = LEARNING_DISCOVERY_CORPUS.map((row) => row.rowId);
    expect(new Set(rowIds).size).toBe(rowIds.length);
    expect(LEARNING_DISCOVERY_ROW_IDS).toEqual(rowIds);
    expect(learningDiscoveryRowById("cross-workload-reuse-candidate")?.rowId).toBe(
      "cross-workload-reuse-candidate",
    );
    expect(learningDiscoveryRowById("nonexistent")).toBeNull();
    const referencedIds = new Set<string>();
    for (const row of LEARNING_DISCOVERY_CORPUS) {
      // The declared candidate kind is a vocabulary member.
      expect(isCandidateKind(row.candidateKind), `${row.rowId} kind`).toBe(true);
      if (row.probe !== undefined) {
        expect(isDiscoveryProbeKind(row.probe.kind), `${row.rowId} probe`).toBe(true);
      }
      // Every replay-population reference resolves in VAL-031's recorded
      // corpus, and the row's recorded population IS the referenced
      // populations' recorded observations (never rewritten).
      expect(row.replayPopulationRefs.length).toBeGreaterThan(0);
      for (const ref of row.replayPopulationRefs) {
        const replayRow = workloadReplayRowById(ref);
        expect(replayRow, `${row.rowId} ref ${ref}`).not.toBeNull();
        referencedIds.add(ref);
      }
      expect(row.population).toEqual(
        row.replayPopulationRefs.flatMap((ref) => recordedObservationsOf(ref)),
      );
      expect(row.population.length).toBeGreaterThan(0);
      // Every recorded identity is unique within its population.
      expect(new Set(row.population.map((observation) => observation.replayIdentity)).size).toBe(
        row.population.length,
      );
      // The honest oracle: the pinned outcome IS the PURE derivation's.
      const honest = deriveHonestDiscoveryOutcome({
        candidateKind: row.candidateKind,
        population: row.population,
      });
      expect(row.expected.emitsProposal).toBe(honest.proposal !== null);
      expect(row.expected.kind).toBe(honest.proposal?.kind ?? null);
      expect(row.expected.refusalReason).toBe(honest.refusal?.reason ?? null);
      expect(row.expected.minedStructureDigest).toBe(honest.proposal?.minedStructureDigest ?? null);
      expect(row.expected.terminal).toBe("COMPLETED");
      // The pinned trajectory class is the canonical discovery
      // trajectory's single-member class.
      expect(row.expectedTrajectoryClass).toHaveLength(1);
      // The pinned proposal (when one is emitted) cites the FULL
      // population at the proposed stage under the derived identity.
      const pinned = pinnedProposalOf(row);
      expect(pinned?.proposalId ?? null).toBe(honest.proposal?.proposalId ?? null);
      if (pinned !== null) {
        expect(pinned.citation).toEqual(canonicalCitationOf(row.population));
        expect(pinned.lifecycleStage).toBe(PROPOSAL_LIFECYCLE_STAGE);
      } else {
        expect(pinnedCitationOf(row)).toEqual(canonicalCitationOf(row.population));
      }
      // Offline rows never demand a dispatch; the live row exactly one.
      if (row.liveGate === undefined) {
        expect(row.needsDispatch).toBe(false);
        expect(row.expected.modelCalls).toBe(0);
      } else {
        expect(row.needsDispatch).toBe(true);
        expect(row.expected.modelCalls).toBe(1);
        expect(row.liveGate.envVars).toEqual(["OPENROUTER_API_KEY"]);
      }
    }
    // The referenced-replay-rows slice: every distinct reference, in
    // first-reference order, resolving in VAL-031's corpus.
    expect(REFERENCED_REPLAY_ROWS.map((replayRow) => replayRow.rowId)).toEqual([...referencedIds]);
    for (const replayRow of REFERENCED_REPLAY_ROWS) {
      expect(workloadReplayRowById(replayRow.rowId)?.rowId).toBe(replayRow.rowId);
    }
    // The population-id convention pins the ledger identity basis.
    expect(recordedPopulationIdOf("rag-retrieval-replay-population")).toBe(
      "val-031-rag-retrieval-replay-population",
    );
  });

  test("the submission fingerprint discipline is stable (one OWN key + body per row)", () => {
    expect(discoverySubmissionKey({ runSuffix: "unit", taskIndex: 3 })).toBe("val-032-app-unit-3");
    // Each row's key is its own — never another row's.
    const keys = [0, 1, 2].map((taskIndex) =>
      discoverySubmissionKey({ runSuffix: "unit", taskIndex }),
    );
    expect(new Set(keys).size).toBe(3);
    const body = discoveryTaskBodyFor({
      rowId: "rag-retrieval-deterministicization-candidate",
      candidateKind: "deterministicization",
    });
    expect(body).toEqual({
      kind: LEARNING_DISCOVERY_TASK_KIND,
      rowId: "rag-retrieval-deterministicization-candidate",
      candidateKind: "deterministicization",
      discovery: { phase: "propose" },
    });
  });

  test("the live row is env-gated (offline the gate is closed; the credential opens it)", () => {
    const liveRows = LEARNING_DISCOVERY_CORPUS.filter((row) => row.needsDispatch);
    expect(liveRows).toHaveLength(1);
    const liveRow = liveRows[0] as LearningDiscoveryCorpusRow;
    expect(liveRow.rowId).toBe("live-discovery-confirmation");
    expect(liveRow.liveGate?.envVars).toEqual(["OPENROUTER_API_KEY"]);
    expect(liveGateOpen(liveRow, {})).toBe(false);
    expect(liveGateOpen(liveRow, { OPENROUTER_API_KEY: "operator-authorized" })).toBe(true);
    // Every offline row is always drivable.
    for (const row of OFFLINE_CORPUS_ROWS) {
      expect(liveGateOpen(row, {})).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The app over the honest fake world (every offline row passes)
// ---------------------------------------------------------------------------

describe("VAL-032 app over the honest fake world", () => {
  test("every offline row PASSES with valid evidence (its OWN durable execution)", async () => {
    for (const [taskIndex, row] of LEARNING_DISCOVERY_CORPUS.entries()) {
      if (row.liveGate !== undefined) {
        continue;
      }
      const run = await runAppOverFakeWorld({ taskIndex });
      expect(
        run.passed,
        `${row.rowId} app passed (criteria: ${JSON.stringify(
          run.outcome.appCriteria.filter((criterion) => criterion.status === "FAIL"),
        )})`,
      ).toBe(true);
      expect(validateHarnessEvidence(run.evidence)).toEqual([]);
      const failed = run.outcome.appCriteria.filter((criterion) => criterion.status === "FAIL");
      expect(failed, `${row.rowId}: ${JSON.stringify(failed)}`).toEqual([]);
      // The discovery submission landed its OWN durable execution (one
      // submission per row — never a replay, never a rejection).
      expect(run.createdExecutions).toBe(1);
      expect(run.outcome.submission.replayed).toBe(false);
      expect(run.outcome.submission.rejection).toBeNull();
      expect(run.outcome.submission.executionId).not.toBe("");
      // The observed terminal is the honest one (a refusal is COMPLETED).
      expect(run.outcome.observedTerminal).toBe("COMPLETED");
      // The app-side trajectory digest is a member of the pinned class.
      expect(row.expectedTrajectoryClass).toContain(run.outcome.trajectoryDigest ?? "");
      // The discovery made its OWN dispatches (zero offline).
      expect(run.outcome.observedModelCalls).toBe(0);
      // The usage is honestly none-reported offline.
      expect(run.outcome.usage).toBeNull();
    }
  });

  test("the proposal rows read back COMPLETE proposals at the proposed stage", async () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter((candidate) => candidate.expected.emitsProposal)) {
      const run = await runAppOverFakeWorld({ taskIndex: taskIndexOf(row.rowId) });
      expect(run.passed, `${row.rowId} passed`).toBe(true);
      const proposal = run.outcome.outcome.proposal;
      expect(proposal, `${row.rowId} read-back proposal`).not.toBeNull();
      expect(proposal?.kind).toBe(row.expected.kind);
      expect(proposal?.lifecycleStage).toBe(PROPOSAL_LIFECYCLE_STAGE);
      expect(proposal?.minedStructureDigest).toBe(row.expected.minedStructureDigest);
      // The read-back citation is the FULL canonical population citation.
      expect(proposal?.citation).toEqual(pinnedCitationOf(row));
      expect(run.outcome.outcome.refusal).toBeNull();
      // The boundary re-derivations PASS (citation + conservatism).
      expect(
        run.outcome.appCriteria.find(
          (criterion) => criterion.criterionId === "app-citation-completeness-summary",
        )?.status,
      ).toBe("PASS");
      expect(
        run.outcome.appCriteria.find(
          (criterion) => criterion.criterionId === "app-conservatism-no-variance-smoothing",
        )?.status,
      ).toBe("PASS");
    }
  });

  test("the refusal rows read back HONEST refusals with their pinned reasons", async () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) => !candidate.expected.emitsProposal,
    )) {
      const run = await runAppOverFakeWorld({ taskIndex: taskIndexOf(row.rowId) });
      expect(run.passed, `${row.rowId} passed`).toBe(true);
      // The positive refusal row: the varying-population refusal.
      expect(run.outcome.outcome.proposal).toBeNull();
      expect(run.outcome.outcome.refusal?.reason).toBe(row.expected.refusalReason);
      // An honest refusal is a COMPLETED discovery — never a fabricated failure.
      expect(run.outcome.observedTerminal).toBe("COMPLETED");
    }
    // The pinned refusal rows: the varying population and the guard.
    const varying = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("order-settlement-varying-refusal"),
    });
    expect(varying.outcome.outcome.refusal?.reason).toBe("varying-population");
    const guard = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("oversized-batch-guard-refusal"),
    });
    expect(guard.outcome.outcome.refusal?.reason).toBe("no-dispatched-work");
    expect(guard.outcome.observedModelCalls).toBe(0);
  });

  test("the run identity is the VAL-032 work order and the latencies are measured", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("tool-loop-competence-candidate"),
    });
    expect(run.passed).toBe(true);
    expect(run.evidence.workOrder).toBe("VAL-032");
    expect(run.evidence.program).toBe("zeck-validation");
    expect(run.evidence.integrationSurface).toBe("sdk");
    expect(run.evidence.request?.taskKind).toBe(LEARNING_DISCOVERY_TASK_KIND);
    // The measured submission latency (never estimated).
    expect(run.outcome.submissionLatencyMs).toBeGreaterThan(0);
    expect(run.evidence.timings.submitMs).not.toBeNull();
  });

  test("the pinned discovery trajectories are single-member classes reproduced over the public journal", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const run = await runAppOverFakeWorld({ taskIndex: taskIndexOf(row.rowId) });
      expect(run.outcome.trajectoryDigest).toBe(row.expectedTrajectoryClass[0] ?? "");
      // The class member IS the canonical trajectory digest (the app's
      // re-derivation over the public journal equals the pin).
      expect(row.expectedTrajectoryClass).toHaveLength(1);
    }
    // Proposal rows and refusal rows hold DISTINCT trajectory shapes
    // (the proposal shape carries the citation/verification/registry
    // steps; the refusal shape the refusal-recorded step).
    const proposal = rowById("rag-retrieval-deterministicization-candidate");
    const refusal = rowById("order-settlement-varying-refusal");
    expect(proposal.expectedTrajectoryClass[0]).not.toBe(refusal.expectedTrajectoryClass[0]);
  });
});

// ---------------------------------------------------------------------------
// The registry landing (only verified proposals land; refusals record nothing)
// ---------------------------------------------------------------------------

describe("VAL-032 discovery registry landing (the driver over the fake stack)", () => {
  test("only VERIFIED proposals land at the proposed stage; refusals record NOTHING", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const ledgerInput = createReplayLedgerInput();
      const registry = createCandidateRegistry();
      const result = await driveLearningDiscovery({
        row,
        ledgerInput,
        miner: createDiscoveryMiner(),
        registry,
        now: createTickClock().now,
      });
      expect(result.terminal, `${row.rowId} terminal`).toBe("COMPLETED");
      if (row.expected.emitsProposal) {
        expect(result.registryRecording?.accepted).toBe(true);
        expect(result.registryRecording?.replayed).toBe(false);
        expect(registry.recordedProposalIds).toEqual([result.proposal?.proposalId]);
        // The ONLY stage a discovery proposal may land at.
        expect(registry.facts().candidates[0]?.lifecycleStage).toBe(PROPOSAL_LIFECYCLE_STAGE);
        expect(registry.facts().appliedCandidateCount).toBe(0);
      } else {
        // A refusal records nothing — no candidate, no landing.
        expect(result.registryRecording).toBeNull();
        expect(registry.recordedProposalIds).toEqual([]);
        expect(registry.facts().candidates).toHaveLength(0);
      }
    }
  });

  test("the registry is append-only: an identical re-run REPLAYS the immutable identity", async () => {
    const row = rowById("rag-retrieval-deterministicization-candidate");
    const ledgerInput = createReplayLedgerInput();
    const registry = createCandidateRegistry();
    const first = await driveLearningDiscovery({
      row,
      ledgerInput,
      miner: createDiscoveryMiner(),
      registry,
      now: createTickClock().now,
    });
    const second = await driveLearningDiscovery({
      row,
      ledgerInput,
      miner: createDiscoveryMiner(),
      registry,
      now: createTickClock().now,
    });
    // The re-run's discovery REPLAYS the recorded candidate — the
    // identity is immutable and the registry holds exactly ONE row.
    expect(second.terminal).toBe("COMPLETED");
    expect(second.registryRecording?.replayed).toBe(true);
    expect(second.proposal?.proposalId).toBe(first.proposal?.proposalId);
    expect(registry.recordedProposalIds).toEqual([first.proposal?.proposalId]);
    expect(registry.facts().candidates).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The fake-miner discriminations (each variant FAILs a mechanical criterion)
// ---------------------------------------------------------------------------

describe("VAL-032 app discriminations (the fake-miner variants)", () => {
  test("an UNCITED miner proposal FAILs citation-full-population and never lands", async () => {
    const result = await driveRowOverStack({
      row: rowById("probe-uncited-proposal"),
      variant: "uncited",
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
    // The dishonest proposal never landed in the registry.
    expect(result.registryRecording).toBeNull();
    expect(createCandidateRegistry().recordedProposalIds).toEqual([]);
  });

  test("a PARTIAL-population citation FAILs (a stability claim from N-1 replays)", async () => {
    const result = await driveRowOverStack({
      row: rowById("probe-partial-population"),
      variant: "partial",
    });
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

  test("a FABRICATED citation FAILs citation-no-fabrication with the phantom members named", async () => {
    const result = await driveRowOverStack({
      row: rowById("probe-fabricated-citation"),
      variant: "fabricated",
    });
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

  test("a VARIANCE-SMOOTHING proposal FAILs conservatism (and the kind fidelity)", async () => {
    const result = await driveRowOverStack({
      row: rowById("probe-variance-smoothing"),
      variant: "smoothing",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.proposal?.kind).toBe("deterministicization");
    // The citation itself is complete — the fabrication is the KIND.
    expect(result.citation?.complete).toBe(true);
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
    // population — the kind-fidelity catch fires too.
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "kind-fidelity")?.status,
    ).toBe("FAIL");
    // The smoothed proposal never landed.
    expect(result.registryRecording).toBeNull();
  });

  test("a HIDING miner (a refusal over learnable structure) FAILs refusal-justified", async () => {
    const result = await driveRowOverStack({
      row: rowById("rag-retrieval-deterministicization-candidate"),
      variant: "hiding",
    });
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

  test("a MUTATING registry (a frozen-state rewrite on propose) FAILs no-application-frozen-inputs", async () => {
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
    expect(ledgerInput.frozenDigest()).not.toBe(beforeDigest);
    expect(result.noApplication.frozenInputUnchanged).toBe(false);
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "no-application-frozen-inputs")
        ?.status,
    ).toBe("FAIL");
    expect(
      result.criteria
        .find((criterion) => criterion.criterionId === "no-application-frozen-inputs")
        ?.evidence.join(" "),
    ).toContain("STATE-MUTATION");
  });

  test("a PROMOTING registry (an applied candidate) FAILs no-application-registry-inert", async () => {
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
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "no-application-registry-inert")
        ?.status,
    ).toBe("FAIL");
    expect(
      result.criteria
        .find((criterion) => criterion.criterionId === "no-application-registry-inert")
        ?.evidence.join(" "),
    ).toContain("APPLIED-CANDIDATES");
  });
});

// ---------------------------------------------------------------------------
// The fake-world boundary discriminations (the read-back knobs)
// ---------------------------------------------------------------------------

describe("VAL-032 app discriminations (the fake-world knobs)", () => {
  test("a terminal override that contradicts the oracle FAILs the expected terminal", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("cross-workload-reuse-candidate"),
      terminal: "FAILED",
    });
    expect(run.passed).toBe(false);
    expect(
      run.outcome.appCriteria.find((criterion) => criterion.criterionId === "app-expected-terminal")
        ?.status,
    ).toBe("FAIL");
    expect(
      run.outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-terminal-criteria-agreement",
      )?.status,
    ).toBe("FAIL");
  });

  test("an UNCITED read-back proposal FAILs the boundary citation completeness", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("cross-workload-reuse-candidate"),
      uncited: true,
    });
    expect(run.passed).toBe(false);
    expect(
      run.outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-citation-full-population",
      )?.status,
    ).toBe("FAIL");
    expect(
      run.outcome.appCriteria
        .find((criterion) => criterion.criterionId === "app-citation-full-population")
        ?.evidence.join(" "),
    ).toContain("UNCITED-PROPOSAL");
  });

  test("a PARTIAL read-back citation FAILs the boundary completeness (a partial population)", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("rag-retrieval-deterministicization-candidate"),
      partial: true,
    });
    expect(run.passed).toBe(false);
    expect(
      run.outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-citation-full-population",
      )?.status,
    ).toBe("FAIL");
    expect(
      run.outcome.appCriteria
        .find((criterion) => criterion.criterionId === "app-citation-full-population")
        ?.evidence.join(" "),
    ).toContain("PARTIAL-POPULATION");
  });

  test("a FABRICATED read-back citation FAILs the boundary no-fabrication leg", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("tool-loop-competence-candidate"),
      fabricated: true,
    });
    expect(run.passed).toBe(false);
    expect(
      run.outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-citation-no-fabrication",
      )?.status,
    ).toBe("FAIL");
    expect(
      run.outcome.appCriteria
        .find((criterion) => criterion.criterionId === "app-citation-no-fabrication")
        ?.evidence.join(" "),
    ).toContain("FABRICATED-CITATION");
  });

  test("a SMOOTHED read-back outcome FAILs the boundary refusal honesty (a fabricated proposal)", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("order-settlement-varying-refusal"),
      smoothing: true,
    });
    expect(run.passed).toBe(false);
    // The pinned oracle demands an honest refusal — a deterministicization
    // proposal over the varying population never passes.
    expect(run.outcome.outcome.proposal?.kind).toBe("deterministicization");
    expect(
      run.outcome.appCriteria.find((criterion) => criterion.criterionId === "app-refusal-honest")
        ?.status,
    ).toBe("FAIL");
    expect(
      run.outcome.appCriteria
        .find((criterion) => criterion.criterionId === "app-refusal-honest")
        ?.evidence.join(" "),
    ).toContain("FABRICATED-OUTCOME");
    // The fabricated proposal never carries a refusal reason — the
    // refusal leg surfaces the fabrication, not a drifted reason.
    expect(
      run.outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-refusal-reason-pinned",
      )?.status,
    ).toBeUndefined();
  });

  test("an APPLIED read-back proposal FAILs the boundary lifecycle stage", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("tool-loop-competence-candidate"),
      mutating: true,
    });
    expect(run.passed).toBe(false);
    expect(run.outcome.outcome.proposal?.lifecycleStage).toBe("promoted");
    expect(
      run.outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-proposal-lifecycle-proposed",
      )?.status,
    ).toBe("FAIL");
    expect(
      run.outcome.appCriteria
        .find((criterion) => criterion.criterionId === "app-proposal-lifecycle-proposed")
        ?.evidence.join(" "),
    ).toContain("APPLIED-PROPOSAL");
  });
});
