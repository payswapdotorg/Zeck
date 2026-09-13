/**
 * VAL-033 acceptance criterion 1: the equivalence-testing customer
 * application rides the public SDK boundary end to end against a
 * controlled fake transport (the submission phase — one OWN durable
 * execution per row under its OWN idempotency key; the observation
 * phase — the completion poll observing the honest terminal (an honest
 * divergence is an honest FAILED; an honest refusal is a COMPLETED
 * run), the result retrieval surfacing the verification statuses, the
 * route's model-call count (zero offline), the honest none-reported
 * offline usage, the equivalence verdict read back, the lifecycle
 * landing (the equivalence stage ONLY), the per-case outcomes and the
 * exercised capabilities, and the events read re-deriving the
 * equivalence trajectory digest over the public journal; the assertion
 * phase — the PURE per-row equivalence contract re-derived AT the
 * boundary), and its pinned task slice matches the repository
 * configuration file and the corpus. The fake world implements the
 * platform's OWN equivalence semantics at the customer boundary (the
 * per-row create semantics at the POST boundary; the honest terminal
 * shapes at the read boundary; the canonical equivalence trajectories
 * at the events read) so the app's per-row assertions are exercised
 * honestly.
 *
 * Discrimination: the FAKE-LEDGER variants (SKIP-TO-PROMOTED /
 * SKIP-OFFLINE-REPLAY / EVIDENCE-LESS / REWRITE-REGISTRY) and the
 * FAKE-REPLACEMENT-RUNTIME variants (ESCAPING / UNCITED / PARTIAL /
 * UNCHECKED / SMOOTHING) each FAIL a specific mechanical criterion and
 * never land their dishonest verdict in the candidate lifecycle — while
 * the honest stack passes every offline row, the lifecycle appends
 * `proposed → offline-replayed → differentially-evaluated` ONLY, and
 * the registry's EXISTING entries are never rewritten.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  EQUIVALENCE_TESTING_TASKS,
  runEquivalenceTestingApp,
} from "../../../benchmarks/validation/apps/equivalence-testing/application";
import {
  adversarialCasesOf,
  EQUIVALENCE_TESTING_CORPUS,
  EQUIVALENCE_TESTING_ROW_IDS,
  EQUIVALENCE_TESTING_TASK_KIND,
  equivalenceRowById,
  equivalenceSubmissionKey,
  equivalenceTaskBodyFor,
  historicalCasesOf,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
  PINNED_REGISTRY_ENTRIES,
  phantomProposalIdOf,
  pinnedRunOf,
  REFERENCED_REPLAY_POPULATION_REFS,
} from "../../../benchmarks/validation/apps/equivalence-testing/corpus";
import {
  createCandidateRegistry,
  createEquivalenceFakeApiWorld,
  createIncumbentExecutor,
  createLifecycleLedger,
  createReplacementRuntime,
  createTickClock,
  type FakeLedgerVariant,
  type FakeReplacementRuntimeVariant,
} from "../../../benchmarks/validation/apps/equivalence-testing/fixtures";
import { recordedObservationsOf } from "../../../benchmarks/validation/apps/learning-discovery/corpus";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { HarnessEvidence } from "../../../benchmarks/validation/harness/evidence";
import type { TransportImplementation } from "../../../benchmarks/validation/harness/harness";
import type {
  EquivalenceCorpusRow,
  EquivalenceRunResult,
} from "../../../benchmarks/validation/platform/equivalence-testing";
import {
  driveEquivalenceRun,
  EQUIVALENT_STAGE,
  isAcceptanceCriterionKind,
  isEquivalenceProbeKind,
  isEquivalenceVerdictKind,
  isReplacementShape,
  OFFLINE_REPLAY_STAGE,
} from "../../../benchmarks/validation/platform/equivalence-testing";

const REVISION = "1fab7a7e3705c2030eb13076d134c1c351590512";

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
  readonly unchecked?: boolean;
  readonly smoothing?: boolean;
  readonly escaping?: boolean;
  readonly skipped?: boolean;
}): Promise<{
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly outcome: Awaited<ReturnType<typeof runEquivalenceTestingApp>>;
  readonly createdExecutions: number;
}> {
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
  const outcome = await runEquivalenceTestingApp({
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
      configuration: { suite: "val-033-apps" },
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

/** Drive one offline row over a purpose-built fake stack (the seams under test). */
async function driveRowOverStack(options: {
  readonly row: EquivalenceCorpusRow;
  readonly runtimeVariant?: FakeReplacementRuntimeVariant;
  readonly ledgerVariant?: FakeLedgerVariant;
}): Promise<{ readonly result: EquivalenceRunResult }> {
  const clock = createTickClock();
  const registry = createCandidateRegistry();
  const result = await driveEquivalenceRun({
    row: options.row,
    registry,
    ledger: createLifecycleLedger({
      ...(options.ledgerVariant === undefined ? {} : { variant: options.ledgerVariant }),
      registry,
    }),
    incumbentExecutor: createIncumbentExecutor(),
    replacementRuntime: createReplacementRuntime({
      ...(options.runtimeVariant === undefined ? {} : { variant: options.runtimeVariant }),
    }),
    now: clock.now,
  });
  return { result };
}

/** The task index of one corpus row. */
function taskIndexOf(rowId: string): number {
  const index = EQUIVALENCE_TESTING_CORPUS.findIndex((row) => row.rowId === rowId);
  if (index < 0) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return index;
}

const rowById = (rowId: string): EquivalenceCorpusRow => {
  const row = equivalenceRowById(rowId);
  if (row === null) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

const criterionOf = (result: EquivalenceRunResult, criterionId: string) =>
  result.criteria.find((criterion) => criterion.criterionId === criterionId);

const appCriterionOf = (
  outcome: Awaited<ReturnType<typeof runEquivalenceTestingApp>>,
  criterionId: string,
) => outcome.appCriteria.find((criterion) => criterion.criterionId === criterionId);

// ---------------------------------------------------------------------------
// The pinned task slice ↔ corpus ↔ config.json consistency
// ---------------------------------------------------------------------------

describe("VAL-033 app task-slice consistency", () => {
  test("the exported task slice mirrors the corpus exactly", () => {
    expect(EQUIVALENCE_TESTING_TASKS.length).toBe(EQUIVALENCE_TESTING_CORPUS.length);
    for (const [index, task] of EQUIVALENCE_TESTING_TASKS.entries()) {
      const row = EQUIVALENCE_TESTING_CORPUS[index];
      expect(task.rowId).toBe(row?.rowId);
      expect(task.kind).toBe(EQUIVALENCE_TESTING_TASK_KIND);
      expect(task.sourceProposalId).toBe(row?.sourceProposalId);
      expect(task.replacementShape).toBe(row?.replacementShape);
      expect([...task.declaredCapabilities]).toEqual([...(row?.declaredCapabilities ?? [])]);
      expect([...task.grantedIsolationSurface]).toEqual([...(row?.grantedIsolationSurface ?? [])]);
      expect(task.criterionKind).toBe(row?.acceptanceCriterion.kind);
      expect([...task.toleratedCaseIds]).toEqual([
        ...(row?.acceptanceCriterion.toleratedCaseIds ?? []),
      ]);
      expect(task.populationSize).toBe(row?.differentialPopulation.length);
      expect(task.historicalCases).toBe(
        row?.differentialPopulation.filter((dcase) => dcase.source === "historical-replay").length,
      );
      expect(task.adversarialCases).toBe(
        row?.differentialPopulation.filter((dcase) => dcase.source === "adversarial").length,
      );
      expect(task.expectedVerdict).toBe(row?.expected.verdict);
      expect(task.expectedRefusalReason).toBe(row?.expected.refusalReason);
      expect(task.expectedDivergenceCaseIds).toBe(row?.expected.divergenceCaseIds.length);
      expect(task.expectedTerminal).toBe(row?.expected.terminal);
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
          "../../../benchmarks/validation/apps/equivalence-testing/config.json",
        ),
        "utf-8",
      ),
    ) as { tasks: Record<string, unknown>[]; tokenEnvVar: string; integrationSurface: string };
    expect(config.tasks.length).toBe(EQUIVALENCE_TESTING_TASKS.length);
    for (const [index, task] of config.tasks.entries()) {
      const exported = EQUIVALENCE_TESTING_TASKS[index];
      expect(task.rowId).toBe(exported?.rowId);
      expect(task.kind).toBe(exported?.kind);
      expect(task.sourceProposalId).toBe(exported?.sourceProposalId);
      expect(task.replacementShape).toBe(exported?.replacementShape);
      expect(task.declaredCapabilities).toEqual([...(exported?.declaredCapabilities ?? [])]);
      expect(task.grantedIsolationSurface).toEqual([...(exported?.grantedIsolationSurface ?? [])]);
      expect(task.criterionKind).toBe(exported?.criterionKind);
      expect(task.toleratedCaseIds).toEqual([...(exported?.toleratedCaseIds ?? [])]);
      expect(task.populationSize).toBe(exported?.populationSize);
      expect(task.historicalCases).toBe(exported?.historicalCases);
      expect(task.adversarialCases).toBe(exported?.adversarialCases);
      expect(task.expectedVerdict).toBe(exported?.expectedVerdict);
      expect(task.expectedRefusalReason).toBe(exported?.expectedRefusalReason);
      expect(task.expectedDivergenceCaseIds).toBe(exported?.expectedDivergenceCaseIds);
      expect(task.expectedTerminal).toBe(exported?.expectedTerminal);
      expect(task.trajectoryClassSize).toBe(exported?.trajectoryClassSize);
      expect(task.expectedModelCalls).toBe(exported?.expectedModelCalls);
      expect(task.probe ?? null).toBe(exported?.probe ?? null);
      expect(task.liveGate ?? null).toEqual(exported?.liveGate ?? null);
    }
    expect(config.tokenEnvVar).toBe("ZECK_VALIDATION_TOKEN");
    expect(config.integrationSurface).toBe("sdk");
  });

  test("the corpus is well-formed (unique ids, registry membership, recorded populations, honest oracles)", () => {
    const rowIds = EQUIVALENCE_TESTING_CORPUS.map((row) => row.rowId);
    expect(new Set(rowIds).size).toBe(rowIds.length);
    expect(EQUIVALENCE_TESTING_ROW_IDS).toEqual(rowIds);
    expect(equivalenceRowById("rag-deterministic-function-exact")?.rowId).toBe(
      "rag-deterministic-function-exact",
    );
    expect(equivalenceRowById("nonexistent")).toBeNull();

    const registryProposalIds = new Set(PINNED_REGISTRY_ENTRIES.map((pin) => pin.proposalId));
    for (const row of EQUIVALENCE_TESTING_CORPUS) {
      // The vocabulary legs: shapes, criteria, verdicts, probes.
      expect(isReplacementShape(row.replacementShape), `${row.rowId} shape`).toBe(true);
      expect(
        isAcceptanceCriterionKind(row.acceptanceCriterion.kind),
        `${row.rowId} criterion`,
      ).toBe(true);
      expect(isEquivalenceVerdictKind(row.expected.verdict), `${row.rowId} verdict`).toBe(true);
      if (row.probe !== undefined) {
        expect(isEquivalenceProbeKind(row.probe.kind), `${row.rowId} probe`).toBe(true);
      }
      // The source proposal is a registry member (the read-only input) —
      // every row EXCEPT the unregistered-refusal row, whose phantom
      // citation is deliberately NOT a member.
      if (row.expected.refusalReason === "proposal-unregistered") {
        expect(row.sourceProposalId).toBe(phantomProposalIdOf());
        expect(registryProposalIds.has(row.sourceProposalId)).toBe(false);
      } else {
        expect(registryProposalIds.has(row.sourceProposalId), `${row.rowId} registry member`).toBe(
          true,
        );
      }
      // The differential population: unique case ids, well-formed
      // digests, the declared capability set within the granted surface.
      const caseIds = row.differentialPopulation.map((dcase) => dcase.caseId);
      expect(new Set(caseIds).size, `${row.rowId} unique cases`).toBe(caseIds.length);
      expect(row.differentialPopulation.length).toBeGreaterThan(0);
      for (const dcase of row.differentialPopulation) {
        expect(dcase.inputDigest).toMatch(/^[0-9a-f]{8}$/);
        expect(dcase.incumbentDigest).toMatch(/^[0-9a-f]{8}$/);
        expect(dcase.classDigests.length).toBeGreaterThan(0);
        expect(dcase.classDigests).toContain(dcase.incumbentDigest);
      }
      for (const capability of row.declaredCapabilities) {
        expect(
          row.grantedIsolationSurface.includes(capability),
          `${row.rowId} declaration within surface`,
        ).toBe(true);
      }
      // The honest oracle: the pinned verdict IS the PURE derivation's
      // over the row's own population (never asserted, always derived).
      const { differential } = pinnedRunOf(row);
      if (row.expected.refusalReason !== null) {
        expect(row.expected.verdict).toBe("honest-refusal");
        expect(row.expected.divergenceCaseIds).toEqual([]);
      } else if (differential.equivalent) {
        expect(row.expected.verdict).toBe("equivalence-pass");
        expect(row.expected.divergenceCaseIds).toEqual([]);
      } else {
        expect(row.expected.verdict).toBe("honest-divergence");
        expect(row.expected.divergenceCaseIds).toEqual(
          differential.divergences.map((divergence) => divergence.caseId),
        );
        expect(row.expected.terminal).toBe("FAILED");
      }
      // Offline rows never dispatch; the live row exactly one REAL round.
      if (row.liveGate === undefined) {
        expect(row.needsDispatch).toBe(false);
        expect(row.expected.modelCalls).toBe(0);
      } else {
        expect(row.needsDispatch).toBe(true);
        expect(row.expected.modelCalls).toBe(1);
        expect(row.liveGate.envVars).toEqual(["OPENROUTER_API_KEY"]);
      }
      // The pinned trajectory class is the canonical run trajectory's
      // single-member class.
      expect(row.expectedTrajectoryClass).toHaveLength(1);
    }
    // The verdict distribution: 10 offline passes (4 honest shapes + 6
    // probes) + 1 honest divergence + 2 honest refusals, plus 1 live pass.
    const passes = EQUIVALENCE_TESTING_CORPUS.filter(
      (row) => row.expected.verdict === "equivalence-pass",
    ).length;
    const divergences = EQUIVALENCE_TESTING_CORPUS.filter(
      (row) => row.expected.verdict === "honest-divergence",
    ).length;
    const refusals = EQUIVALENCE_TESTING_CORPUS.filter(
      (row) => row.expected.verdict === "honest-refusal",
    ).length;
    expect(passes).toBe(11);
    expect(divergences).toBe(1);
    expect(refusals).toBe(2);
  });

  test("the historical cases are the proposals' recorded replay citations (read-only, never rewritten)", () => {
    for (const ref of REFERENCED_REPLAY_POPULATION_REFS) {
      const observations = recordedObservationsOf(ref);
      expect(observations.length).toBeGreaterThan(0);
      const identities = observations.map((observation) => observation.replayIdentity);
      expect(new Set(identities).size).toBe(identities.length);
      // The historical case builder re-declares the recorded facts
      // exactly (identity, input digest, trajectory digest, class).
      const cases = historicalCasesOf([ref]);
      expect(cases.map((dcase) => dcase.caseId)).toEqual(identities);
      for (const [index, dcase] of cases.entries()) {
        const observation = observations[index];
        expect(dcase.source).toBe("historical-replay");
        expect(dcase.sourceRef).toBe(observation?.replayIdentity);
        expect(dcase.inputDigest).toBe(observation?.inputDigest);
        expect(dcase.incumbentDigest).toBe(observation?.trajectoryDigest);
        expect(dcase.classDigests).toContain(observation?.trajectoryDigest);
      }
    }
    // Every row's historical half is exactly the cited populations'
    // recorded observations (in first-reference order).
    const ragRow = rowById("rag-deterministic-function-exact");
    const ragHistorical = ragRow.differentialPopulation.filter(
      (dcase) => dcase.source === "historical-replay",
    );
    expect(ragHistorical).toEqual(historicalCasesOf(["rag-retrieval-replay-population"]));
    // The adversarial pins are deterministic per (row, ordinal) with the
    // designated two-member ordinal carrying both members.
    const toolRow = rowById("tool-loop-reusable-tool-tolerance");
    const toolAdversarial = adversarialCasesOf({
      rowId: "tool-loop-reusable-tool-tolerance",
      count: 2,
      twoMemberOn: 1,
    });
    expect(toolAdversarial[0]?.classDigests).toHaveLength(2);
    expect(toolAdversarial[1]?.classDigests).toHaveLength(1);
    expect(
      toolRow.differentialPopulation.filter((dcase) => dcase.source === "adversarial"),
    ).toEqual(toolAdversarial);
  });

  test("the submission fingerprint discipline is stable (one OWN key + body per row)", () => {
    expect(equivalenceSubmissionKey({ runSuffix: "unit", taskIndex: 3 })).toBe(
      "val-033-app-unit-3",
    );
    const keys = [0, 1, 2].map((taskIndex) =>
      equivalenceSubmissionKey({ runSuffix: "unit", taskIndex }),
    );
    expect(new Set(keys).size).toBe(3);
    const body = equivalenceTaskBodyFor({
      rowId: "rag-deterministic-function-exact",
      sourceProposalId: "cand-learning-discovery-e519d75f",
      replacementShape: "deterministic-function",
    });
    expect(body).toEqual({
      kind: EQUIVALENCE_TESTING_TASK_KIND,
      rowId: "rag-deterministic-function-exact",
      sourceProposalId: "cand-learning-discovery-e519d75f",
      replacementShape: "deterministic-function",
      // The differentially-evaluate-only declaration (task semantics —
      // never provider selection, never shadow/canary/promotion).
      equivalence: { phase: "differentially-evaluate" },
    });
  });

  test("the live row is env-gated (offline the gate is closed; the credential opens it)", () => {
    const liveRows = EQUIVALENCE_TESTING_CORPUS.filter((row) => row.needsDispatch);
    expect(liveRows).toHaveLength(1);
    const liveRow = liveRows[0] as EquivalenceCorpusRow;
    expect(liveRow.rowId).toBe("live-split-preprocessing-confirmation");
    expect(liveRow.liveGate?.envVars).toEqual(["OPENROUTER_API_KEY"]);
    expect(liveGateOpen(liveRow, {})).toBe(false);
    expect(liveGateOpen(liveRow, { OPENROUTER_API_KEY: "operator-authorized" })).toBe(true);
    // Every offline row is always drivable.
    for (const row of OFFLINE_CORPUS_ROWS) {
      expect(liveGateOpen(row, {})).toBe(true);
      expect(row.liveGate).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// The app over the honest fake world (every offline row behaves per its pin)
// ---------------------------------------------------------------------------

describe("VAL-033 app over the honest fake world", () => {
  test("every PASS and REFUSAL row PASSES with valid evidence (its OWN durable execution)", async () => {
    for (const [taskIndex, row] of EQUIVALENCE_TESTING_CORPUS.entries()) {
      if (row.expected.verdict === "honest-divergence" || row.liveGate !== undefined) {
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
      // The equivalence submission landed its OWN durable execution (one
      // submission per row — never a replay, never a rejection).
      expect(run.createdExecutions).toBe(1);
      expect(run.outcome.submission.replayed).toBe(false);
      expect(run.outcome.submission.rejection).toBeNull();
      expect(run.outcome.submission.executionId).not.toBe("");
      // The observed terminal is the honest one (a refusal is COMPLETED).
      expect(run.outcome.observedTerminal).toBe(row.expected.terminal);
      // The app-side trajectory digest is a member of the pinned class.
      expect(row.expectedTrajectoryClass).toContain(run.outcome.trajectoryDigest ?? "");
      // The run made its OWN dispatches (zero offline) and the usage is
      // honestly none-reported offline.
      expect(run.outcome.observedModelCalls).toBe(0);
      expect(run.outcome.usage).toBeNull();
    }
  });

  test("the honest-divergence row behaves per its pin (an honest FAILED, never smoothed)", async () => {
    const row = rowById("reuse-removed-call-honest-divergence");
    const run = await runAppOverFakeWorld({ taskIndex: taskIndexOf(row.rowId) });
    // The boundary re-derivation honestly FAILs the criterion leg (every
    // case diverged under exact-digest-equality) — the divergence is
    // recorded, never smoothed into an app pass.
    expect(run.outcome.observedTerminal).toBe("FAILED");
    expect(appCriterionOf(run.outcome, "app-expected-terminal")?.status).toBe("PASS");
    expect(appCriterionOf(run.outcome, "app-verdict-kind-pinned")?.status).toBe("PASS");
    expect(appCriterionOf(run.outcome, "app-divergence-cases-pinned")?.status).toBe("PASS");
    expect(appCriterionOf(run.outcome, "app-differential-criterion-satisfied")?.status).toBe(
      "FAIL",
    );
    expect(appCriterionOf(run.outcome, "app-divergence-honesty-no-smoothing")?.status).toBe("PASS");
    expect(appCriterionOf(run.outcome, "app-terminal-criteria-agreement")?.status).toBe("PASS");
    expect(run.outcome.verdict?.kind).toBe("honest-divergence");
    expect([...(run.outcome.verdict?.divergenceCaseIds ?? [])]).toEqual([
      ...row.expected.divergenceCaseIds,
    ]);
    // The honest divergence still lands the evaluation at the equivalence stage.
    expect(run.outcome.lifecycleLanding?.finalStage).toBe(EQUIVALENT_STAGE);
    expect(run.outcome.submission.rejection).toBeNull();
    expect(run.outcome.observedModelCalls).toBe(0);
  });

  test("the pass rows read back equivalence-pass verdicts landed at the equivalence stage ONLY", async () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) => candidate.expected.verdict === "equivalence-pass",
    )) {
      const run = await runAppOverFakeWorld({ taskIndex: taskIndexOf(row.rowId) });
      expect(run.passed, `${row.rowId} passed`).toBe(true);
      expect(run.outcome.verdict?.kind).toBe("equivalence-pass");
      expect(run.outcome.verdict?.refusalReason).toBeNull();
      expect(run.outcome.verdict?.divergenceCaseIds).toEqual([]);
      expect(run.outcome.verdict?.escapeDirections).toEqual([]);
      expect(run.outcome.lifecycleLanding).toEqual({
        proposalId: row.sourceProposalId,
        finalStage: EQUIVALENT_STAGE,
      });
      // Both sides' outcome digests are readable at the boundary and the
      // boundary re-derivations PASS (checked, unsmoothed, contained).
      expect(run.outcome.outcomes).toHaveLength(row.differentialPopulation.length);
      expect(appCriterionOf(run.outcome, "app-criterion-checked")?.status).toBe("PASS");
      expect(appCriterionOf(run.outcome, "app-divergence-honesty-no-smoothing")?.status).toBe(
        "PASS",
      );
      expect(appCriterionOf(run.outcome, "app-isolation-no-escape")?.status).toBe("PASS");
    }
  });

  test("the refusal rows read back HONEST refusals with their pinned reasons", async () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) => candidate.expected.verdict === "honest-refusal",
    )) {
      const run = await runAppOverFakeWorld({ taskIndex: taskIndexOf(row.rowId) });
      expect(run.passed, `${row.rowId} passed`).toBe(true);
      expect(run.outcome.verdict?.kind).toBe("honest-refusal");
      expect(run.outcome.verdict?.refusalReason).toBe(row.expected.refusalReason);
      // An honest refusal is a COMPLETED run — never a fabricated
      // failure — and nothing lands in the candidate lifecycle.
      expect(run.outcome.observedTerminal).toBe("COMPLETED");
      expect(run.outcome.lifecycleLanding).toBeNull();
    }
    const unregistered = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("unregistered-proposal-refusal"),
    });
    expect(unregistered.outcome.verdict?.refusalReason).toBe("proposal-unregistered");
    const insufficient = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("single-replay-evidence-refusal"),
    });
    expect(insufficient.outcome.verdict?.refusalReason).toBe("proposal-evidence-insufficient");
  });

  test("the run identity is the VAL-033 work order and the latencies are measured", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("rag-deterministic-function-exact"),
    });
    expect(run.passed).toBe(true);
    expect(run.evidence.workOrder).toBe("VAL-033");
    expect(run.evidence.program).toBe("zeck-validation");
    expect(run.evidence.integrationSurface).toBe("sdk");
    expect(run.evidence.request?.taskKind).toBe(EQUIVALENCE_TESTING_TASK_KIND);
    // The measured submission latency (never estimated).
    expect(run.outcome.submissionLatencyMs).toBeGreaterThan(0);
    expect(run.evidence.timings.submitMs).not.toBeNull();
  });

  test("the pinned equivalence trajectories are single-member classes reproduced over the public journal", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const run = await runAppOverFakeWorld({ taskIndex: taskIndexOf(row.rowId) });
      expect(run.outcome.trajectoryDigest).toBe(row.expectedTrajectoryClass[0] ?? "");
      expect(row.expectedTrajectoryClass).toHaveLength(1);
    }
    // The evaluated and the refusal shapes hold DISTINCT trajectories
    // (the evaluated shape carries the population/incumbent/replacement/
    // verification/landing steps; the refusal shape the refusal step).
    const evaluated = rowById("rag-deterministic-function-exact");
    const refusal = rowById("unregistered-proposal-refusal");
    expect(evaluated.expectedTrajectoryClass[0]).not.toBe(refusal.expectedTrajectoryClass[0]);
  });
});

// ---------------------------------------------------------------------------
// The lifecycle landing over the fake stack (append-only; registry read-only)
// ---------------------------------------------------------------------------

describe("VAL-033 lifecycle landing (the driver over the fake stack)", () => {
  test("evaluated verdicts append proposed → offline-replayed → differentially-evaluated ONLY", async () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) => candidate.expected.refusalReason === null,
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
      expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
      expect(result.ledgerLanding?.accepted, `${row.rowId} landing accepted`).toBe(true);
      // The walk is EXACTLY the equivalence walk — never beyond (no
      // shadow/canary/promotion — VAL-034/035's scope).
      const walk = ledger
        .transitionsFor(row.sourceProposalId)
        .map((transition) => transition.toStage);
      expect(walk, `${row.rowId} walk`).toEqual([OFFLINE_REPLAY_STAGE, EQUIVALENT_STAGE]);
      for (const transition of ledger.transitionsFor(row.sourceProposalId)) {
        expect(transition.evidenceDigest).toMatch(/^[0-9a-f]{8}$/);
        expect(transition.proposalId).toBe(row.sourceProposalId);
      }
      expect(ledger.landedProposalIds).toEqual([row.sourceProposalId]);
      expect(result.stageDiscipline?.disciplined).toBe(true);
    }
  });

  test("the registry's EXISTING entries are never rewritten by an honest run", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const clock = createTickClock();
      const registry = createCandidateRegistry();
      const digestBefore = registry.digest();
      const entriesBefore = registry.store().size;
      await driveEquivalenceRun({
        row,
        registry,
        ledger: createLifecycleLedger(),
        incumbentExecutor: createIncumbentExecutor(),
        replacementRuntime: createReplacementRuntime(),
        now: clock.now,
      });
      expect(registry.digest(), `${row.rowId} registry unchanged`).toBe(digestBefore);
      expect(registry.store().size, `${row.rowId} no entries added or removed`).toBe(entriesBefore);
      // Every pinned member is still a member at the proposed stage (the
      // refusal row's degenerate single-replay entry included).
      for (const pin of PINNED_REGISTRY_ENTRIES) {
        expect(registry.store().get(pin.proposalId)?.lifecycleStage).toBe("proposed");
      }
    }
  });

  test("an honest re-drive REPLAYS the lifecycle walk (append-only idempotence)", async () => {
    const row = rowById("rag-deterministic-function-exact");
    const clock = createTickClock();
    const registry = createCandidateRegistry();
    const ledger = createLifecycleLedger();
    const drive = () =>
      driveEquivalenceRun({
        row,
        registry,
        ledger,
        incumbentExecutor: createIncumbentExecutor(),
        replacementRuntime: createReplacementRuntime(),
        now: clock.now,
      });
    const first = await drive();
    expect(first.terminal).toBe("COMPLETED");
    const second = await drive();
    expect(second.terminal).toBe("COMPLETED");
    // The identical re-append REPLAYS: still exactly the equivalence walk.
    expect(second.ledgerLanding?.replayed).toBe(true);
    expect(second.ledgerLanding?.accepted).toBe(true);
    expect(ledger.transitionsFor(row.sourceProposalId)).toHaveLength(2);
    expect(ledger.landedProposalIds).toEqual([row.sourceProposalId]);
    expect(registry.digest()).toBe(createCandidateRegistry().digest());
  });

  test("the refusal rows append NOTHING to the candidate lifecycle", async () => {
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
      expect(result.refusalHonesty?.honest).toBe(true);
      // Nothing executed, nothing landed.
      expect(result.differential).toBeNull();
      expect(result.ledgerLanding).toBeNull();
      expect(ledger.landedProposalIds).toEqual([]);
      expect(ledger.transitionsFor(row.sourceProposalId)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// The fake-ledger discriminations (each variant FAILs a mechanical criterion)
// ---------------------------------------------------------------------------

describe("VAL-033 app discriminations (the fake-ledger variants)", () => {
  test("a SKIP-TO-PROMOTED ledger (a skipped-stage promotion) FAILs the stage discipline", async () => {
    const { result } = await driveRowOverStack({
      row: rowById("probe-skipped-stage"),
      ledgerVariant: "skip-to-promoted",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.stageDiscipline?.beyondScopeStages).toEqual(["promoted"]);
    expect(criterionOf(result, "stage-discipline-never-beyond-equivalence")?.status).toBe("FAIL");
    expect(
      criterionOf(result, "stage-discipline-never-beyond-equivalence")?.evidence.join(" "),
    ).toContain("SKIPPED-STAGE");
    // The promotion is out of the equivalence slice's scope — the walk
    // never holds the equivalence landing shape either.
    expect(criterionOf(result, "stage-discipline-landing")?.status).toBe("FAIL");
  });

  test("a SKIP-OFFLINE-REPLAY ledger (a jumped rung) FAILs the stage discipline", async () => {
    const { result } = await driveRowOverStack({
      row: rowById("probe-skipped-stage"),
      ledgerVariant: "skip-offline-replay",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.stageDiscipline?.skippedStageTransitions).toHaveLength(1);
    expect(criterionOf(result, "stage-discipline-no-jumps")?.status).toBe("FAIL");
    expect(criterionOf(result, "stage-discipline-no-jumps")?.evidence.join(" ")).toContain(
      "SKIPPED-STAGE",
    );
  });

  test("an EVIDENCE-LESS ledger (transitions without evidence) FAILs the stage discipline", async () => {
    const { result } = await driveRowOverStack({
      row: rowById("probe-skipped-stage"),
      ledgerVariant: "evidence-less",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.stageDiscipline?.evidenceLessOrdinals).toHaveLength(2);
    expect(criterionOf(result, "stage-discipline-every-transition-evidenced")?.status).toBe("FAIL");
    expect(
      criterionOf(result, "stage-discipline-every-transition-evidenced")?.evidence.join(" "),
    ).toContain("EVIDENCE-LESS-TRANSITION");
  });

  test("a REWRITE-REGISTRY ledger (a proposal rewrite) FAILs the read-only discipline", async () => {
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
    // The verdict itself was honest — the rewrite happened at the
    // append: the registry's frozen digest CHANGED (a rewritten proposal).
    expect(result.differential?.equivalent).toBe(true);
    expect(registry.digest()).not.toBe(digestBefore);
    expect(registry.store().get("cand-learning-discovery-e519d75f")?.lifecycleStage).toBe(
      "promoted",
    );
    expect(criterionOf(result, "registry-read-only")?.status).toBe("FAIL");
    expect(criterionOf(result, "registry-read-only")?.evidence.join(" ")).toContain(
      "REGISTRY-MUTATION",
    );
  });
});

// ---------------------------------------------------------------------------
// The fake-replacement-runtime discriminations (each variant FAILs mechanically)
// ---------------------------------------------------------------------------

describe("VAL-033 app discriminations (the fake-replacement-runtime variants)", () => {
  test("an ESCAPING runtime (network access) is a containment violation that never lands", async () => {
    const clock = createTickClock();
    const registry = createCandidateRegistry();
    const ledger = createLifecycleLedger();
    const result = await driveEquivalenceRun({
      row: rowById("probe-containment-escape"),
      registry,
      ledger,
      incumbentExecutor: createIncumbentExecutor(),
      replacementRuntime: createReplacementRuntime({ variant: "escaping" }),
      now: clock.now,
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("containment-violation");
    expect(result.isolation?.escapeDirections).toEqual(["network-access"]);
    expect(criterionOf(result, "isolation-no-escape")?.status).toBe("FAIL");
    expect(criterionOf(result, "isolation-no-escape")?.evidence.join(" ")).toContain(
      "CONTAINMENT-VIOLATION",
    );
    // The violating verdict never lands — never silently forgiven.
    expect(result.ledgerLanding).toBeNull();
    expect(ledger.landedProposalIds).toEqual([]);
  });

  test("an UNCITED runtime verdict FAILs the provenance chain and never lands", async () => {
    const { result } = await driveRowOverStack({
      row: rowById("probe-broken-provenance"),
      runtimeVariant: "uncited",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("evaluation-invalid");
    expect(result.provenance?.complete).toBe(false);
    expect(criterionOf(result, "provenance-proposal-cited")?.status).toBe("FAIL");
    expect(criterionOf(result, "provenance-proposal-cited")?.evidence.join(" ")).toContain(
      "UNCITED-VERDICT",
    );
    expect(result.ledgerLanding).toBeNull();
  });

  test("a PARTIAL population (the pinned adversarial cases dropped) FAILs", async () => {
    const { result } = await driveRowOverStack({
      row: rowById("probe-partial-population"),
      runtimeVariant: "partial",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.provenance?.missingAdversarialCaseIds).toHaveLength(2);
    expect(criterionOf(result, "provenance-full-population")?.status).toBe("FAIL");
    expect(criterionOf(result, "provenance-full-population")?.evidence.join(" ")).toContain(
      "PARTIAL-POPULATION",
    );
    // The unchecked surface fires too: the dropped cases were never checked.
    expect(criterionOf(result, "criterion-checked")?.status).toBe("FAIL");
    expect(result.ledgerLanding).toBeNull();
  });

  test("an UNCHECKED criterion (stated but never checked) FAILs and never lands", async () => {
    const { result } = await driveRowOverStack({
      row: rowById("probe-unchecked-criterion"),
      runtimeVariant: "unchecked",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.differential?.fullyEvaluated).toBe(false);
    expect(result.differential?.unevaluatedCaseIds).toHaveLength(
      rowById("probe-unchecked-criterion").differentialPopulation.length,
    );
    expect(criterionOf(result, "criterion-checked")?.status).toBe("FAIL");
    expect(criterionOf(result, "criterion-checked")?.evidence.join(" ")).toContain(
      "UNCHECKED-CRITERION",
    );
    expect(result.ledgerLanding).toBeNull();
  });

  test("a SMOOTHING runtime (a divergent case claimed equivalent) FAILs the honesty leg", async () => {
    const { result } = await driveRowOverStack({
      row: rowById("probe-divergence-smoothing"),
      runtimeVariant: "smoothing",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.differential?.divergences).toHaveLength(1);
    expect(result.differential?.smoothedDivergences).toHaveLength(1);
    expect(criterionOf(result, "divergence-honesty-no-smoothing")?.status).toBe("FAIL");
    expect(criterionOf(result, "divergence-honesty-no-smoothing")?.evidence.join(" ")).toContain(
      "DIVERGENCE-SMOOTHING",
    );
    // The smoothed verdict never lands.
    expect(result.ledgerLanding).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The fake-world boundary discriminations (the read-back knobs)
// ---------------------------------------------------------------------------

describe("VAL-033 app discriminations (the fake-world knobs)", () => {
  test("a terminal override that contradicts the oracle FAILs the expected terminal", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("rag-deterministic-function-exact"),
      terminal: "FAILED",
    });
    expect(run.passed).toBe(false);
    expect(appCriterionOf(run.outcome, "app-expected-terminal")?.status).toBe("FAIL");
    expect(appCriterionOf(run.outcome, "app-terminal-criteria-agreement")?.status).toBe("FAIL");
  });

  test("an UNCITED read-back (no lifecycle landing surfaced) FAILs the boundary landing", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("rag-deterministic-function-exact"),
      uncited: true,
    });
    expect(run.passed).toBe(false);
    expect(run.outcome.lifecycleLanding).toBeNull();
    expect(appCriterionOf(run.outcome, "app-lifecycle-landing-present")?.status).toBe("FAIL");
    expect(
      appCriterionOf(run.outcome, "app-lifecycle-landing-present")?.evidence.join(" "),
    ).toContain("MISSING-LANDING");
  });

  test("a PARTIAL read-back (only the historical outcomes) FAILs the boundary checked surface", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("rag-deterministic-function-exact"),
      partial: true,
    });
    expect(run.passed).toBe(false);
    expect(run.outcome.outcomes).toHaveLength(4);
    expect(appCriterionOf(run.outcome, "app-criterion-checked")?.status).toBe("FAIL");
    expect(appCriterionOf(run.outcome, "app-criterion-checked")?.evidence.join(" ")).toContain(
      "UNCHECKED-CRITERION",
    );
  });

  test("an UNCHECKED read-back (no outcomes surfaced at all) FAILs the boundary outcomes leg", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("rag-deterministic-function-exact"),
      unchecked: true,
    });
    expect(run.passed).toBe(false);
    expect(run.outcome.outcomes).toEqual([]);
    expect(appCriterionOf(run.outcome, "app-outcomes-readable")?.status).toBe("FAIL");
    expect(appCriterionOf(run.outcome, "app-outcomes-readable")?.evidence.join(" ")).toContain(
      "MISSING-OUTCOMES",
    );
  });

  test("a SMOOTHED read-back (a perturbed case claimed equivalent) FAILs the boundary honesty", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("rag-deterministic-function-exact"),
      smoothing: true,
    });
    expect(run.passed).toBe(false);
    expect(appCriterionOf(run.outcome, "app-divergence-honesty-no-smoothing")?.status).toBe("FAIL");
    expect(
      appCriterionOf(run.outcome, "app-divergence-honesty-no-smoothing")?.evidence.join(" "),
    ).toContain("DIVERGENCE-SMOOTHING");
    expect(appCriterionOf(run.outcome, "app-differential-criterion-satisfied")?.status).toBe(
      "FAIL",
    );
    // The boundary never trusts the claimed verdict kind: the read-back
    // still claims equivalence-pass — the re-derivation contradicts it.
    expect(run.outcome.verdict?.kind).toBe("equivalence-pass");
  });

  test("an ESCAPING read-back (network access exercised) FAILs the boundary isolation", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("rag-deterministic-function-exact"),
      escaping: true,
    });
    expect(run.passed).toBe(false);
    expect(run.outcome.exercisedCapabilities).toContain("network-access");
    expect(appCriterionOf(run.outcome, "app-isolation-no-escape")?.status).toBe("FAIL");
    expect(appCriterionOf(run.outcome, "app-isolation-no-escape")?.evidence.join(" ")).toContain(
      "CONTAINMENT-VIOLATION",
    );
  });

  test("a SKIPPED read-back (the landing surfaces past the equivalence stage) FAILs", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("rag-deterministic-function-exact"),
      skipped: true,
    });
    expect(run.passed).toBe(false);
    expect(run.outcome.lifecycleLanding?.finalStage).toBe("promoted");
    expect(
      appCriterionOf(run.outcome, "app-lifecycle-landing-equivalence-stage-only")?.status,
    ).toBe("FAIL");
    expect(
      appCriterionOf(run.outcome, "app-lifecycle-landing-equivalence-stage-only")?.evidence.join(
        " ",
      ),
    ).toContain("OUT-OF-SCOPE-LANDING");
  });
});
