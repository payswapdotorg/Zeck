/**
 * VAL-034 acceptance criterion 1 + 2: the shadow-execution customer
 * application rides the public SDK boundary end to end against a
 * controlled fake transport (the submission phase — one OWN durable
 * execution per row under its OWN idempotency key; the observation
 * phase — the completion poll observing the honest terminal (an
 * honest divergence is an honest FAILED; an honest refusal is a
 * COMPLETED run), the result retrieval surfacing the verification
 * statuses, the route's model-call count (zero offline), the honest
 * none-reported offline usage, the shadow verdict read back, the
 * lifecycle landing (the shadow stage ONLY), the per-case comparison
 * records, the customer-facing served outcomes (the served-source pin
 * — ALWAYS the incumbent's), the shadow cost measurement, the served
 * accounting and the exercised capabilities, and the events read
 * re-deriving the shadow trajectory digest over the public journal;
 * the assertion phase — the PURE per-row shadow contract re-derived
 * AT the boundary), and its pinned task slice matches the repository
 * configuration file and the corpus. The fake world implements the
 * platform's OWN shadow semantics at the customer boundary (the
 * per-row create semantics at the POST boundary; the honest terminal
 * shapes at the read boundary; the canonical shadow trajectories at
 * the events read) so the app's per-row assertions are exercised
 * honestly.
 *
 * Discrimination: the FAKE-LIFECYCLE variants (SKIP-TO-CANARIED /
 * WRONG-STAGE / EVIDENCE-LESS / REWRITE-REGISTRY), the
 * FAKE-SHADOW-LEDGER DOUBLE-BOOKING variant, the FAKE-TRAFFIC-SOURCE
 * variants (DROPPED / DUPLICATED / MIXED-UP), the FAKE-SERVING-PATH
 * leak shapes (LEAKY / DISGUISED) and the FAKE-SHADOW-RUNTIME
 * variants (ESCAPING / AGGREGATE-ONLY / SUBSET-COMPARED / SMOOTHING /
 * UNMEASURED) each FAIL a specific mechanical criterion and never
 * land their dishonest shadow transition in the candidate lifecycle —
 * while the honest stack passes every offline row, the lifecycle
 * appends `differentially-evaluated → shadow-executed` ONLY, the
 * divergence + shadow-cost ledgers are append-only, and the registry's
 * EXISTING entries are never rewritten.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  adversarialCasesOf,
  historicalCasesOf,
  phantomProposalIdOf,
} from "../../../benchmarks/validation/apps/equivalence-testing/corpus";
import { recordedObservationsOf } from "../../../benchmarks/validation/apps/learning-discovery/corpus";
import {
  runShadowExecutionApp,
  SHADOW_EXECUTION_TASKS,
} from "../../../benchmarks/validation/apps/shadow-execution/application";
import {
  LIVE_CORPUS_ROWS,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
  PINNED_REGISTRY_ENTRIES,
  pinnedShadowRunOf,
  priorWalkOf,
  REFERENCED_REPLAY_POPULATION_REFS,
  SHADOW_EXECUTION_CORPUS,
  SHADOW_EXECUTION_ROW_IDS,
  SHADOW_EXECUTION_TASK_KIND,
  shadowRowById,
  shadowSubmissionKey,
  shadowTaskBodyFor,
} from "../../../benchmarks/validation/apps/shadow-execution/corpus";
import {
  createCandidateRegistry,
  createHonestShadowStack,
  createIncumbentExecutor,
  createLifecycleLedger,
  createServingPath,
  createShadowFakeApiWorld,
  createShadowLedger,
  createShadowRuntime,
  createTickClock,
  createTrafficSource,
  type FakeLifecycleVariant,
  type FakeServingPathVariant,
  type FakeShadowLedgerVariant,
  type FakeShadowRuntimeVariant,
  type FakeTrafficSourceVariant,
} from "../../../benchmarks/validation/apps/shadow-execution/fixtures";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { HarnessEvidence } from "../../../benchmarks/validation/harness/evidence";
import type { TransportImplementation } from "../../../benchmarks/validation/harness/harness";
import {
  EQUIVALENT_STAGE,
  isAcceptanceCriterionKind,
  isReplacementShape,
  OFFLINE_REPLAY_STAGE,
} from "../../../benchmarks/validation/platform/equivalence-testing";
import type {
  ShadowCorpusRow,
  ShadowRunResult,
} from "../../../benchmarks/validation/platform/shadow-execution";
import {
  driveShadowRun,
  isShadowProbeKind,
  isShadowVerdictKind,
  SERVED_SOURCE_PIN,
  SHADOW_SOURCE_STAGE,
  SHADOW_STAGE,
} from "../../../benchmarks/validation/platform/shadow-execution";

const REVISION = "439c0b4c11d1c9a5b6f00112233445566778899aa";

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
  readonly leaked?: boolean;
  readonly disguised?: boolean;
  readonly dropped?: boolean;
  readonly aggregateOnly?: boolean;
  readonly smoothed?: boolean;
  readonly billed?: boolean;
  readonly skipped?: boolean;
  readonly escaping?: boolean;
  readonly unmeasured?: boolean;
}): Promise<{
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly outcome: Awaited<ReturnType<typeof runShadowExecutionApp>>;
  readonly createdExecutions: number;
}> {
  const clock = createTickClock();
  const world = createShadowFakeApiWorld({
    clock,
    ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    ...(options.leaked === true ? { leaked: true } : {}),
    ...(options.disguised === true ? { disguised: true } : {}),
    ...(options.dropped === true ? { dropped: true } : {}),
    ...(options.aggregateOnly === true ? { aggregateOnly: true } : {}),
    ...(options.smoothed === true ? { smoothed: true } : {}),
    ...(options.billed === true ? { billed: true } : {}),
    ...(options.skipped === true ? { skipped: true } : {}),
    ...(options.escaping === true ? { escaping: true } : {}),
    ...(options.unmeasured === true ? { unmeasured: true } : {}),
  });
  const outcome = await runShadowExecutionApp({
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
      configuration: { suite: "val-034-apps" },
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

/**
 * Drive one offline row over a purpose-built fake stack (the seams
 * under test — one variant knob per seam).
 */
async function driveRowOverStack(options: {
  readonly row: ShadowCorpusRow;
  readonly lifecycleVariant?: FakeLifecycleVariant;
  readonly shadowLedgerVariant?: FakeShadowLedgerVariant;
  readonly trafficSourceVariant?: FakeTrafficSourceVariant;
  readonly servingPathVariant?: FakeServingPathVariant;
  readonly runtimeVariant?: FakeShadowRuntimeVariant;
}): Promise<{
  readonly result: ShadowRunResult;
  readonly registry: ReturnType<typeof createCandidateRegistry>;
  readonly lifecycle: ReturnType<typeof createLifecycleLedger>;
  readonly shadowLedger: ReturnType<typeof createShadowLedger>;
}> {
  const clock = createTickClock();
  const registry = createCandidateRegistry();
  const servingPath = createServingPath(
    options.servingPathVariant === undefined ? undefined : { variant: options.servingPathVariant },
  );
  const lifecycle = createLifecycleLedger({
    ...(options.lifecycleVariant === undefined ? {} : { variant: options.lifecycleVariant }),
    registry,
  });
  const shadowLedger = createShadowLedger(
    options.shadowLedgerVariant === undefined
      ? undefined
      : { variant: options.shadowLedgerVariant, servingPath },
  );
  const result = await driveShadowRun({
    row: options.row,
    registry,
    lifecycle,
    shadowLedger,
    incumbentExecutor: createIncumbentExecutor(),
    trafficSource: createTrafficSource(
      options.trafficSourceVariant === undefined
        ? undefined
        : { variant: options.trafficSourceVariant },
    ),
    servingPath,
    shadowRuntime: createShadowRuntime(
      options.runtimeVariant === undefined ? undefined : { variant: options.runtimeVariant },
    ),
    now: clock.now,
  });
  return { result, registry, lifecycle, shadowLedger };
}

/** The task index of one corpus row. */
function taskIndexOf(rowId: string): number {
  const index = SHADOW_EXECUTION_CORPUS.findIndex((row) => row.rowId === rowId);
  if (index < 0) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return index;
}

const rowById = (rowId: string): ShadowCorpusRow => {
  const row = shadowRowById(rowId);
  if (row === null) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

const criterionOf = (result: ShadowRunResult, criterionId: string) =>
  result.criteria.find((criterion) => criterion.criterionId === criterionId);

const appCriterionOf = (
  outcome: Awaited<ReturnType<typeof runShadowExecutionApp>>,
  criterionId: string,
) => outcome.appCriteria.find((criterion) => criterion.criterionId === criterionId);

// ---------------------------------------------------------------------------
// The pinned task slice ↔ corpus ↔ config.json consistency
// ---------------------------------------------------------------------------

describe("VAL-034 app task-slice consistency", () => {
  test("the exported task slice mirrors the corpus exactly", () => {
    expect(SHADOW_EXECUTION_TASKS.length).toBe(SHADOW_EXECUTION_CORPUS.length);
    for (const [index, task] of SHADOW_EXECUTION_TASKS.entries()) {
      const row = SHADOW_EXECUTION_CORPUS[index];
      expect(task.rowId).toBe(row?.rowId);
      expect(task.kind).toBe(SHADOW_EXECUTION_TASK_KIND);
      expect(task.sourceProposalId).toBe(row?.sourceProposalId);
      expect(task.replacementShape).toBe(row?.replacementShape);
      expect([...task.declaredCapabilities]).toEqual([...(row?.declaredCapabilities ?? [])]);
      expect([...task.grantedIsolationSurface]).toEqual([...(row?.grantedIsolationSurface ?? [])]);
      expect(task.criterionKind).toBe(row?.acceptanceCriterion.kind);
      expect([...task.toleratedCaseIds]).toEqual([
        ...(row?.acceptanceCriterion.toleratedCaseIds ?? []),
      ]);
      expect(task.populationSize).toBe(row?.trafficPopulation.length);
      expect(task.historicalCases).toBe(
        row?.trafficPopulation.filter((tcase) => tcase.source === "historical-replay").length,
      );
      expect(task.injectedProbes).toBe(
        row?.trafficPopulation.filter((tcase) => tcase.source === "adversarial").length,
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
          "../../../benchmarks/validation/apps/shadow-execution/config.json",
        ),
        "utf-8",
      ),
    ) as { tasks: Record<string, unknown>[]; tokenEnvVar: string; integrationSurface: string };
    expect(config.tasks.length).toBe(SHADOW_EXECUTION_TASKS.length);
    for (const [index, task] of config.tasks.entries()) {
      const exported = SHADOW_EXECUTION_TASKS[index];
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
      expect(task.injectedProbes).toBe(exported?.injectedProbes);
      expect(task.workloadClasses).toBe(exported?.workloadClasses);
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
    const rowIds = SHADOW_EXECUTION_CORPUS.map((row) => row.rowId);
    expect(new Set(rowIds).size).toBe(rowIds.length);
    expect(SHADOW_EXECUTION_ROW_IDS).toEqual(rowIds);
    expect(shadowRowById("rag-deterministic-function-shadow-agreement")?.rowId).toBe(
      "rag-deterministic-function-shadow-agreement",
    );
    expect(shadowRowById("nonexistent")).toBeNull();

    const registryProposalIds = new Set(PINNED_REGISTRY_ENTRIES.map((pin) => pin.proposalId));
    for (const row of SHADOW_EXECUTION_CORPUS) {
      // The vocabulary legs: shapes, criteria, verdicts, probes.
      expect(isReplacementShape(row.replacementShape), `${row.rowId} shape`).toBe(true);
      expect(
        isAcceptanceCriterionKind(row.acceptanceCriterion.kind),
        `${row.rowId} criterion`,
      ).toBe(true);
      expect(isShadowVerdictKind(row.expected.verdict), `${row.rowId} verdict`).toBe(true);
      if (row.probe !== undefined) {
        expect(isShadowProbeKind(row.probe.kind), `${row.rowId} probe`).toBe(true);
      }
      // The shadowed candidate is a registry member whose recorded walk
      // reaches differentially-evaluated — every row EXCEPT the
      // unregistered-refusal row, whose phantom citation is deliberately
      // NOT a member, and the premature-refusal row, whose member's walk
      // never started.
      if (row.expected.refusalReason === "candidate-unregistered") {
        expect(row.sourceProposalId).toBe(phantomProposalIdOf());
        expect(registryProposalIds.has(row.sourceProposalId)).toBe(false);
      } else {
        expect(registryProposalIds.has(row.sourceProposalId), `${row.rowId} registry member`).toBe(
          true,
        );
      }
      // The traffic population: unique case ids, well-formed digests,
      // the declared capability set within the granted surface, the
      // workload-mix basis covering every case.
      const caseIds = row.trafficPopulation.map((tcase) => tcase.caseId);
      expect(new Set(caseIds).size, `${row.rowId} unique cases`).toBe(caseIds.length);
      expect(row.trafficPopulation.length).toBeGreaterThan(0);
      for (const tcase of row.trafficPopulation) {
        expect(tcase.inputDigest).toMatch(/^[0-9a-f]{8}$/);
        expect(tcase.incumbentDigest).toMatch(/^[0-9a-f]{8}$/);
        expect(tcase.classDigests.length).toBeGreaterThan(0);
        expect(tcase.classDigests).toContain(tcase.incumbentDigest);
        expect(row.trafficWorkloadClasses[tcase.caseId], `${row.rowId} mix class`).toBeDefined();
      }
      for (const capability of row.declaredCapabilities) {
        expect(
          row.grantedIsolationSurface.includes(capability),
          `${row.rowId} declaration within surface`,
        ).toBe(true);
      }
      // The honest oracle: the pinned verdict IS the PURE derivation's
      // over the row's own population (never asserted, always derived).
      const { regression } = pinnedShadowRunOf(row);
      if (row.expected.refusalReason !== null) {
        expect(row.expected.verdict).toBe("honest-refusal");
        expect(row.expected.divergenceCaseIds).toEqual([]);
      } else if (regression.mechanicalDivergenceCaseIds.length > 0) {
        expect(row.expected.verdict).toBe("honest-divergence");
        expect(row.expected.divergenceCaseIds).toEqual([...regression.mechanicalDivergenceCaseIds]);
        expect(row.expected.terminal).toBe("FAILED");
      } else {
        expect(row.expected.verdict).toBe("shadow-agreement");
        expect(row.expected.divergenceCaseIds).toEqual([]);
        expect(row.expected.terminal).toBe("COMPLETED");
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
    // The verdict distribution: 10 offline shadow agreements (4 honest
    // shapes + 6 probes) + 1 honest divergence + 2 honest refusals,
    // plus 1 live shadow agreement.
    const agreements = SHADOW_EXECUTION_CORPUS.filter(
      (row) => row.expected.verdict === "shadow-agreement",
    ).length;
    const divergences = SHADOW_EXECUTION_CORPUS.filter(
      (row) => row.expected.verdict === "honest-divergence",
    ).length;
    const refusals = SHADOW_EXECUTION_CORPUS.filter(
      (row) => row.expected.verdict === "honest-refusal",
    ).length;
    expect(agreements).toBe(11);
    expect(divergences).toBe(1);
    expect(refusals).toBe(2);
    expect(OFFLINE_CORPUS_ROWS).toHaveLength(13);
    expect(LIVE_CORPUS_ROWS).toHaveLength(1);
  });

  test("the traffic populations are the recorded replay populations + the pinned probes", () => {
    for (const ref of REFERENCED_REPLAY_POPULATION_REFS) {
      const observations = recordedObservationsOf(ref);
      expect(observations.length).toBeGreaterThan(0);
      const identities = observations.map((observation) => observation.replayIdentity);
      expect(new Set(identities).size).toBe(identities.length);
      // The historical case builder re-declares the recorded facts
      // exactly (identity, input digest, trajectory digest, class).
      const cases = historicalCasesOf([ref]);
      expect(cases.map((tcase) => tcase.caseId)).toEqual(identities);
      for (const tcase of cases) {
        expect(tcase.source).toBe("historical-replay");
      }
    }
    // Every row's traffic population is exactly the cited recorded
    // populations' observations plus the pinned injected probes.
    const ragRow = rowById("rag-deterministic-function-shadow-agreement");
    expect(ragRow.trafficPopulation).toEqual([
      ...historicalCasesOf(["rag-retrieval-replay-population"]),
      ...adversarialCasesOf({ rowId: ragRow.rowId, count: 2 }),
    ]);
    // The cross-workload row replays TWO recorded populations.
    const reuseRow = rowById("reuse-removed-call-shadow-honest-divergence");
    expect(reuseRow.trafficPopulation).toEqual([
      ...historicalCasesOf(["text-summarize-replay-population", "probe-duplicate-replay"]),
      ...adversarialCasesOf({ rowId: reuseRow.rowId, count: 2 }),
    ]);
    // The tool-loop row's first injected probe carries the TWO-member
    // pinned class (the honest tolerance basis).
    const toolRow = rowById("tool-loop-reusable-tool-shadow-tolerance");
    const toolProbes = toolRow.trafficPopulation.filter((tcase) => tcase.source === "adversarial");
    expect(toolProbes[0]?.classDigests).toHaveLength(2);
    expect(toolProbes[1]?.classDigests).toHaveLength(1);
    // The workload-mix basis: every cited population ref is a class and
    // the injected probes are their own class.
    for (const tcase of ragRow.trafficPopulation) {
      if (tcase.source === "adversarial") {
        expect(ragRow.trafficWorkloadClasses[tcase.caseId]).toBe("injected-probe");
      } else {
        expect(ragRow.trafficWorkloadClasses[tcase.caseId]).toBe("rag-retrieval-replay-population");
      }
    }
  });

  test("every shadowed candidate's prior walk reaches differentially-evaluated (VAL-033's landing)", () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      if (row.expected.refusalReason !== null) {
        // The refusal rows' candidates never started (or never
        // registered) — the fake ledger pre-seeds no walk for them.
        continue;
      }
      const walk = priorWalkOf(row);
      expect(
        walk.map((transition) => transition.toStage),
        `${row.rowId} prior walk`,
      ).toEqual([OFFLINE_REPLAY_STAGE, EQUIVALENT_STAGE]);
      for (const transition of walk) {
        expect(transition.proposalId).toBe(row.sourceProposalId);
        expect(transition.evidenceDigest).toMatch(/^[0-9a-f]{8}$/);
      }
      expect(walk[0]?.ordinal).toBe(1);
      expect(walk[1]?.ordinal).toBe(2);
    }
    // The stage vocabulary: the shadow append lands at shadow-executed
    // ONLY — everything past it is beyond this slice's scope.
    expect(SHADOW_STAGE).toBe("shadow-executed");
    expect(SHADOW_SOURCE_STAGE).toBe("differentially-evaluated");
  });

  test("the submission fingerprint discipline is stable (one OWN key + body per row)", () => {
    expect(shadowSubmissionKey({ runSuffix: "unit", taskIndex: 3 })).toBe("val-034-app-unit-3");
    const keys = [0, 1, 2].map((taskIndex) =>
      shadowSubmissionKey({ runSuffix: "unit", taskIndex }),
    );
    expect(new Set(keys).size).toBe(3);
    const body = shadowTaskBodyFor({
      rowId: "rag-deterministic-function-shadow-agreement",
      sourceProposalId: "cand-learning-discovery-e519d75f",
      replacementShape: "deterministic-function",
    });
    expect(body).toEqual({
      kind: SHADOW_EXECUTION_TASK_KIND,
      rowId: "rag-deterministic-function-shadow-agreement",
      sourceProposalId: "cand-learning-discovery-e519d75f",
      replacementShape: "deterministic-function",
      // The shadow-execute-only, observation-only declaration (task
      // semantics — never provider selection, never canary/promotion).
      shadow: { phase: "shadow-execute", mode: "observation-only" },
    });
  });

  test("the live row is env-gated (offline the gate is closed; the credential opens it)", () => {
    const liveRows = SHADOW_EXECUTION_CORPUS.filter((row) => row.needsDispatch);
    expect(liveRows).toHaveLength(1);
    const liveRow = liveRows[0] as ShadowCorpusRow;
    expect(liveRow.rowId).toBe("live-split-preprocessing-shadow-confirmation");
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

describe("VAL-034 app over the honest fake world", () => {
  test("every AGREEMENT and REFUSAL row PASSES with valid evidence (its OWN durable execution)", async () => {
    for (const [taskIndex, row] of SHADOW_EXECUTION_CORPUS.entries()) {
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
      // The shadow submission landed its OWN durable execution (one
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
    const row = rowById("reuse-removed-call-shadow-honest-divergence");
    const run = await runAppOverFakeWorld({ taskIndex: taskIndexOf(row.rowId) });
    // The boundary re-derivation honestly FAILs the criterion leg (every
    // case diverged under exact-digest-equality) — the divergence is
    // recorded case-by-case, never smoothed into an app pass.
    expect(run.outcome.observedTerminal).toBe("FAILED");
    expect(appCriterionOf(run.outcome, "app-expected-terminal")?.status).toBe("PASS");
    expect(appCriterionOf(run.outcome, "app-verdict-kind-pinned")?.status).toBe("PASS");
    expect(appCriterionOf(run.outcome, "app-divergence-cases-pinned")?.status).toBe("PASS");
    expect(appCriterionOf(run.outcome, "app-regression-agreement-under-criterion")?.status).toBe(
      "FAIL",
    );
    expect(appCriterionOf(run.outcome, "app-regression-no-smoothing")?.status).toBe("PASS");
    expect(appCriterionOf(run.outcome, "app-terminal-criteria-agreement")?.status).toBe("PASS");
    expect(run.outcome.verdict?.kind).toBe("honest-divergence");
    expect([...(run.outcome.verdict?.divergenceCaseIds ?? [])]).toEqual([
      ...row.expected.divergenceCaseIds,
    ]);
    // The honest divergence still lands the shadow transition — the
    // comparison IS the record.
    expect(run.outcome.lifecycleLanding?.finalStage).toBe(SHADOW_STAGE);
    // Every per-case comparison record carries BOTH sides' digests and
    // its own honest non-agreement claim.
    expect(run.outcome.comparisons).toHaveLength(row.trafficPopulation.length);
    for (const comparison of run.outcome.comparisons) {
      expect(comparison.incumbentDigest).toMatch(/^[0-9a-f]{8}$/);
      expect(comparison.shadowDigest).toMatch(/^[0-9a-f]{8}$/);
      expect(comparison.shadowDigest).not.toBe(comparison.incumbentDigest);
      expect(comparison.claimedAgrees).toBe(false);
    }
    expect(run.outcome.aggregate).toEqual({
      assertedAgreement: false,
      assertedDivergenceCount: row.expected.divergenceCaseIds.length,
    });
    expect(run.outcome.submission.rejection).toBeNull();
    expect(run.outcome.observedModelCalls).toBe(0);
  });

  test("the agreement rows serve the incumbent's outcome on EVERY case (the served-source pin)", async () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) => candidate.expected.verdict === "shadow-agreement",
    )) {
      const run = await runAppOverFakeWorld({ taskIndex: taskIndexOf(row.rowId) });
      expect(run.passed, `${row.rowId} passed`).toBe(true);
      expect(run.outcome.verdict?.kind).toBe("shadow-agreement");
      expect(run.outcome.verdict?.refusalReason).toBeNull();
      expect(run.outcome.verdict?.divergenceCaseIds).toEqual([]);
      expect(run.outcome.verdict?.leakKind).toBeNull();
      expect(run.outcome.lifecycleLanding).toEqual({
        proposalId: row.sourceProposalId,
        finalStage: SHADOW_STAGE,
      });
      // The customer-facing served outcomes are ALWAYS the incumbent's
      // (source + digest — the observation-only proof at the boundary).
      expect(run.outcome.servedOutcomes).toHaveLength(row.trafficPopulation.length);
      for (const served of run.outcome.servedOutcomes) {
        expect(served.servedSource).toBe(SERVED_SOURCE_PIN);
        const tcase = row.trafficPopulation.find((candidate) => candidate.caseId === served.caseId);
        expect(served.servedDigest).toBe(tcase?.incumbentDigest);
      }
      // The shadow cost is measured and booked to the shadow ledger
      // while the served accounting bills the incumbent ONLY.
      expect(run.outcome.shadowCost).not.toBeNull();
      expect(run.outcome.servedIncumbentMicroUsd).toBe(run.outcome.servedCostMicroUsd);
      expect(run.outcome.shadowLedgerBookedMicroUsd).toBe(run.outcome.shadowCost?.microUsd);
      // The boundary re-derivations PASS (isolated, complete, honest,
      // separated).
      expect(appCriterionOf(run.outcome, "app-serving-isolation-summary")?.status).toBe("PASS");
      expect(appCriterionOf(run.outcome, "app-population-completeness-summary")?.status).toBe(
        "PASS",
      );
      expect(appCriterionOf(run.outcome, "app-regression-honesty-summary")?.status).toBe("PASS");
      expect(appCriterionOf(run.outcome, "app-cost-separation-summary")?.status).toBe("PASS");
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
      expect(run.outcome.comparisons).toEqual([]);
      expect(run.outcome.servedOutcomes).toEqual([]);
      expect(run.outcome.shadowCost).toBeNull();
    }
    const unregistered = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("unregistered-candidate-shadow-refusal"),
    });
    expect(unregistered.outcome.verdict?.refusalReason).toBe("candidate-unregistered");
    const premature = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("premature-candidate-shadow-refusal"),
    });
    expect(premature.outcome.verdict?.refusalReason).toBe("candidate-not-differentially-evaluated");
  });

  test("the run identity is the VAL-034 work order and the latencies are measured", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("rag-deterministic-function-shadow-agreement"),
    });
    expect(run.passed).toBe(true);
    expect(run.evidence.workOrder).toBe("VAL-034");
    expect(run.evidence.program).toBe("zeck-validation");
    expect(run.evidence.integrationSurface).toBe("sdk");
    expect(run.evidence.request?.taskKind).toBe(SHADOW_EXECUTION_TASK_KIND);
    // The measured submission latency (never estimated).
    expect(run.outcome.submissionLatencyMs).toBeGreaterThan(0);
    expect(run.evidence.timings.submitMs).not.toBeNull();
  });

  test("the pinned shadow trajectories are single-member classes reproduced over the public journal", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const run = await runAppOverFakeWorld({ taskIndex: taskIndexOf(row.rowId) });
      expect(run.outcome.trajectoryDigest).toBe(row.expectedTrajectoryClass[0] ?? "");
      expect(row.expectedTrajectoryClass).toHaveLength(1);
    }
    // The executed and the refusal shapes hold DISTINCT trajectories
    // (the executed shape carries the traffic/incumbent/shadow/
    // comparison/booking/landing steps; the refusal shape the refusal
    // step).
    const executed = rowById("rag-deterministic-function-shadow-agreement");
    const refusal = rowById("unregistered-candidate-shadow-refusal");
    expect(executed.expectedTrajectoryClass[0]).not.toBe(refusal.expectedTrajectoryClass[0]);
  });
});

// ---------------------------------------------------------------------------
// The lifecycle + shadow-ledger landing over the fake stack (append-only;
// registry read-only; the served outcome pinned to the incumbent)
// ---------------------------------------------------------------------------

describe("VAL-034 lifecycle landing (the driver over the fake stack)", () => {
  test("executed verdicts append differentially-evaluated → shadow-executed ONLY", async () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) => candidate.expected.refusalReason === null,
    )) {
      const stack = createHonestShadowStack();
      const result = await driveShadowRun({
        row,
        registry: stack.registry,
        lifecycle: stack.lifecycle,
        shadowLedger: stack.shadowLedger,
        incumbentExecutor: stack.incumbentExecutor,
        trafficSource: stack.trafficSource,
        servingPath: stack.servingPath,
        shadowRuntime: stack.shadowRuntime,
        now: stack.clock.now,
      });
      expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
      expect(result.ledgerLanding?.accepted, `${row.rowId} landing accepted`).toBe(true);
      // The walk is EXACTLY the recorded VAL-033 walk + the single
      // shadow append — never beyond (no canary/promotion — VAL-035's
      // scope).
      const walk = stack.lifecycle
        .transitionsFor(row.sourceProposalId)
        .map((transition) => transition.toStage);
      expect(walk, `${row.rowId} walk`).toEqual([
        OFFLINE_REPLAY_STAGE,
        EQUIVALENT_STAGE,
        SHADOW_STAGE,
      ]);
      for (const transition of stack.lifecycle.transitionsFor(row.sourceProposalId)) {
        expect(transition.evidenceDigest).toMatch(/^[0-9a-f]{8}$/);
        expect(transition.proposalId).toBe(row.sourceProposalId);
      }
      expect(stack.lifecycle.landedProposalIds).toEqual([row.sourceProposalId]);
      expect(result.stageDiscipline?.disciplined).toBe(true);
      // The served outcome is ALWAYS the incumbent's (the driver's own
      // serving-isolation verdict) and the shadow cost is separated.
      expect(result.servingIsolation?.isolated).toBe(true);
      expect(result.servingIsolation?.leakKind).toBeNull();
      expect(result.costSeparation?.separated).toBe(true);
      expect(result.shadowCostBooked).toBe(true);
      // The divergence + shadow-cost ledgers appended exactly the
      // mechanical record.
      expect(stack.shadowLedger.divergencesFor(row.sourceProposalId)).toHaveLength(
        row.expected.divergenceCaseIds.length,
      );
      expect(stack.shadowLedger.costsFor(row.sourceProposalId)).toHaveLength(1);
    }
  });

  test("the registry's EXISTING entries are never rewritten by an honest run", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const stack = createHonestShadowStack();
      const digestBefore = stack.registry.digest();
      const entriesBefore = stack.registry.store().size;
      await driveShadowRun({
        row,
        registry: stack.registry,
        lifecycle: stack.lifecycle,
        shadowLedger: stack.shadowLedger,
        incumbentExecutor: stack.incumbentExecutor,
        trafficSource: stack.trafficSource,
        servingPath: stack.servingPath,
        shadowRuntime: stack.shadowRuntime,
        now: stack.clock.now,
      });
      expect(stack.registry.digest(), `${row.rowId} registry unchanged`).toBe(digestBefore);
      expect(stack.registry.store().size, `${row.rowId} no entries added or removed`).toBe(
        entriesBefore,
      );
      // Every pinned member is still a member at the proposed stage (the
      // premature-refusal row's degenerate single-replay entry included).
      for (const pin of PINNED_REGISTRY_ENTRIES) {
        expect(stack.registry.store().get(pin.proposalId)?.lifecycleStage).toBe("proposed");
      }
    }
  });

  test("an honest re-drive REPLAYS the shadow walk (append-only idempotence)", async () => {
    const row = rowById("rag-deterministic-function-shadow-agreement");
    const stack = createHonestShadowStack();
    const drive = () =>
      driveShadowRun({
        row,
        registry: stack.registry,
        lifecycle: stack.lifecycle,
        shadowLedger: stack.shadowLedger,
        incumbentExecutor: stack.incumbentExecutor,
        trafficSource: stack.trafficSource,
        servingPath: stack.servingPath,
        shadowRuntime: stack.shadowRuntime,
        now: stack.clock.now,
      });
    const first = await drive();
    expect(first.terminal).toBe("COMPLETED");
    const second = await drive();
    expect(second.terminal).toBe("COMPLETED");
    // The identical re-append REPLAYS: still exactly the recorded walk
    // plus the single shadow append.
    expect(second.ledgerLanding?.replayed).toBe(true);
    expect(second.ledgerLanding?.accepted).toBe(true);
    expect(stack.lifecycle.transitionsFor(row.sourceProposalId)).toHaveLength(3);
    expect(stack.lifecycle.landedProposalIds).toEqual([row.sourceProposalId]);
    // The divergence + shadow-cost ledgers are append-only: the
    // re-drive re-books identically (no double entries).
    expect(stack.shadowLedger.costsFor(row.sourceProposalId)).toHaveLength(1);
    expect(stack.registry.digest()).toBe(createCandidateRegistry().digest());
  });

  test("the refusal rows append NOTHING (lifecycle, divergences, shadow cost)", async () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) => candidate.expected.verdict === "honest-refusal",
    )) {
      const stack = createHonestShadowStack();
      const result = await driveShadowRun({
        row,
        registry: stack.registry,
        lifecycle: stack.lifecycle,
        shadowLedger: stack.shadowLedger,
        incumbentExecutor: stack.incumbentExecutor,
        trafficSource: stack.trafficSource,
        servingPath: stack.servingPath,
        shadowRuntime: stack.shadowRuntime,
        now: stack.clock.now,
      });
      expect(result.terminal).toBe("COMPLETED");
      expect(result.verdict).toBe("honest-refusal");
      expect(result.refusalHonesty?.honest).toBe(true);
      // Nothing executed, nothing landed, nothing booked.
      expect(result.regressionHonesty).toBeNull();
      expect(result.ledgerLanding).toBeNull();
      expect(result.divergencesAppended).toBe(0);
      expect(result.shadowCostBooked).toBe(false);
      expect(stack.lifecycle.landedProposalIds).toEqual([]);
      expect(stack.shadowLedger.divergenceProposalIds).toEqual([]);
      expect(
        stack.shadowLedger.costsFor(row.sourceProposalId),
        `${row.rowId} refusal books no shadow cost`,
      ).toEqual([]);
      if (row.expected.refusalReason === "candidate-not-differentially-evaluated") {
        expect(stack.lifecycle.transitionsFor(row.sourceProposalId)).toEqual([]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The fake-lifecycle + fake-shadow-ledger discriminations (each variant
// FAILs a mechanical criterion)
// ---------------------------------------------------------------------------

describe("VAL-034 app discriminations (the fake-lifecycle + fake-shadow-ledger variants)", () => {
  test("a SKIP-TO-CANARIED ledger (a skipped-stage promotion) FAILs the stage discipline", async () => {
    const { result } = await driveRowOverStack({
      row: rowById("probe-skipped-stage"),
      lifecycleVariant: "skip-to-canaried",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.stageDiscipline?.beyondScopeStages).toEqual(["canaried"]);
    expect(criterionOf(result, "stage-discipline-never-beyond-shadow")?.status).toBe("FAIL");
    expect(
      criterionOf(result, "stage-discipline-never-beyond-shadow")?.evidence.join(" "),
    ).toContain("SKIPPED-STAGE");
    // The append is not the single shadow-executed landing either.
    expect(criterionOf(result, "stage-discipline-landing")?.status).toBe("FAIL");
    expect(criterionOf(result, "stage-discipline-landing-is-shadow-stage")?.status).toBe("FAIL");
  });

  test("a WRONG-STAGE ledger (a property-tested landing) FAILs the stage discipline", async () => {
    const { result } = await driveRowOverStack({
      row: rowById("probe-skipped-stage"),
      lifecycleVariant: "wrong-stage",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.stageDiscipline?.wrongStageLandings).toEqual(["property-tested"]);
    expect(criterionOf(result, "stage-discipline-landing-is-shadow-stage")?.status).toBe("FAIL");
    expect(
      criterionOf(result, "stage-discipline-landing-is-shadow-stage")?.evidence.join(" "),
    ).toContain("WRONG-STAGE-LANDING");
  });

  test("an EVIDENCE-LESS ledger (transitions without evidence) FAILs the stage discipline", async () => {
    const { result } = await driveRowOverStack({
      row: rowById("probe-skipped-stage"),
      lifecycleVariant: "evidence-less",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.stageDiscipline?.evidenceLessOrdinals).toHaveLength(1);
    expect(criterionOf(result, "stage-discipline-every-transition-evidenced")?.status).toBe("FAIL");
    expect(
      criterionOf(result, "stage-discipline-every-transition-evidenced")?.evidence.join(" "),
    ).toContain("EVIDENCE-LESS-TRANSITION");
  });

  test("a REWRITE-REGISTRY ledger (a candidate rewrite) FAILs the read-only discipline", async () => {
    const { result, registry } = await driveRowOverStack({
      row: rowById("probe-skipped-stage"),
      lifecycleVariant: "rewrite-registry",
    });
    expect(result.terminal).toBe("FAILED");
    // The verdict itself was honest — the rewrite happened at the
    // append: the registry's frozen digest CHANGED (a rewritten candidate).
    expect(result.servingIsolation?.isolated).toBe(true);
    expect(registry.store().get("cand-learning-discovery-e519d75f")?.lifecycleStage).toBe(
      "promoted",
    );
    expect(criterionOf(result, "registry-read-only")?.status).toBe("FAIL");
    expect(criterionOf(result, "registry-read-only")?.evidence.join(" ")).toContain(
      "REGISTRY-MUTATION",
    );
  });

  test("a DOUBLE-BOOKING shadow ledger (the customer billed for the shadow) FAILs", async () => {
    const { result } = await driveRowOverStack({
      row: rowById("probe-billed-shadow"),
      shadowLedgerVariant: "double-booking",
    });
    expect(result.terminal).toBe("FAILED");
    // The shadow's cost landed in the served totals — the customer is
    // billed for the shadow.
    expect(result.costSeparation?.separated).toBe(false);
    expect(result.costSeparation?.billedOntoServedMicroUsd).toBe(
      2 * rowById("probe-billed-shadow").trafficPopulation.length + 1,
    );
    expect(criterionOf(result, "cost-served-excludes-shadow")?.status).toBe("FAIL");
    expect(criterionOf(result, "cost-served-excludes-shadow")?.evidence.join(" ")).toContain(
      "BILLED-SHADOW",
    );
    // The billed shadow is untrustworthy: the verdict is shadow-invalid
    // and the shadow transition never lands.
    expect(result.verdict).toBe("shadow-invalid");
    expect(result.ledgerLanding).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The fake-traffic-source discriminations (the population catch)
// ---------------------------------------------------------------------------

describe("VAL-034 app discriminations (the fake-traffic-source variants)", () => {
  test("a DROPPED case (a recorded case never compared) FAILs the population completeness", async () => {
    const row = rowById("probe-dropped-case");
    const { result } = await driveRowOverStack({
      row,
      trafficSourceVariant: "dropped",
    });
    expect(result.terminal).toBe("FAILED");
    const dropped = row.trafficPopulation[row.trafficPopulation.length - 1]?.caseId ?? "";
    expect(result.populationCompleteness?.missingCaseIds).toEqual([dropped]);
    expect(criterionOf(result, "population-no-dropped-case")?.status).toBe("FAIL");
    expect(criterionOf(result, "population-no-dropped-case")?.evidence.join(" ")).toContain(
      "DROPPED-CASE",
    );
    // The dropped case was never served either, and its comparison
    // record never existed — the untrustworthy shadow never lands.
    expect(criterionOf(result, "serving-every-case-served")?.status).toBe("FAIL");
    expect(criterionOf(result, "regression-per-case-evidence")?.status).toBe("FAIL");
    expect(result.verdict).toBe("shadow-invalid");
    expect(result.ledgerLanding).toBeNull();
  });

  test("a DUPLICATED case (an inflated mix weight) FAILs the population completeness", async () => {
    const { result } = await driveRowOverStack({
      row: rowById("probe-dropped-case"),
      trafficSourceVariant: "duplicated",
    });
    expect(result.terminal).toBe("FAILED");
    const duplicated = rowById("probe-dropped-case").trafficPopulation[0]?.caseId ?? "";
    // The duplicated case is named (the observed array holds it twice).
    expect(result.populationCompleteness?.duplicatedCaseIds).toEqual([duplicated, duplicated]);
    expect(criterionOf(result, "population-no-duplicated-case")?.status).toBe("FAIL");
    expect(criterionOf(result, "population-no-duplicated-case")?.evidence.join(" ")).toContain(
      "DUPLICATED-CASE",
    );
    expect(result.verdict).toBe("shadow-invalid");
    expect(result.ledgerLanding).toBeNull();
  });

  test("a MIXED-UP population (a foreign case swapped in) FAILs with both cases named", async () => {
    const row = rowById("probe-dropped-case");
    const { result } = await driveRowOverStack({
      row,
      trafficSourceVariant: "mixed-up",
    });
    expect(result.terminal).toBe("FAILED");
    const last = row.trafficPopulation[row.trafficPopulation.length - 1]?.caseId ?? "";
    expect(result.populationCompleteness?.foreignCaseIds).toEqual([`foreign-traffic-${last}`]);
    expect(result.populationCompleteness?.missingCaseIds).toEqual([last]);
    expect(criterionOf(result, "population-no-foreign-case")?.status).toBe("FAIL");
    expect(criterionOf(result, "population-no-foreign-case")?.evidence.join(" ")).toContain(
      "FOREIGN-CASE",
    );
    expect(result.verdict).toBe("shadow-invalid");
    expect(result.ledgerLanding).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The fake-serving-path discriminations (the leak shapes)
// ---------------------------------------------------------------------------

describe("VAL-034 app discriminations (the fake-serving-path variants)", () => {
  test("a LEAKY serving path (the replacement's outcome served) FAILs the serving isolation", async () => {
    const { result } = await driveRowOverStack({
      row: rowById("probe-leaked-outcome"),
      servingPathVariant: "leaky",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.servingIsolation?.isolated).toBe(false);
    expect(result.servingIsolation?.leakKind).toBe("explicit-leak");
    expect(result.servingIsolation?.leakedCaseIds).toEqual(
      rowById("probe-leaked-outcome").trafficPopulation.map((tcase) => tcase.caseId),
    );
    expect(criterionOf(result, "serving-source-pinned-incumbent")?.status).toBe("FAIL");
    expect(criterionOf(result, "serving-source-pinned-incumbent")?.evidence.join(" ")).toContain(
      "LEAKED-SHADOW",
    );
    // The leaked shadow is untrustworthy: never a passable outcome.
    expect(result.verdict).toBe("shadow-invalid");
    expect(result.ledgerLanding).toBeNull();
  });

  test("a DISGUISED leak (the shadow's digest under the incumbent source) FAILs just the same", async () => {
    // The honest-divergence row's shadow digests genuinely differ from
    // the incumbent's — the disguised serve carries the shadow's own
    // digest under a claimed incumbent source.
    const row = rowById("reuse-removed-call-shadow-honest-divergence");
    const { result, shadowLedger } = await driveRowOverStack({
      row,
      servingPathVariant: "disguised",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.servingIsolation?.isolated).toBe(false);
    expect(result.servingIsolation?.leakKind).toBe("disguised-leak");
    expect(result.servingIsolation?.leakedCaseIds).toHaveLength(row.trafficPopulation.length);
    expect(criterionOf(result, "serving-digest-is-incumbents")?.status).toBe("FAIL");
    expect(criterionOf(result, "serving-digest-is-incumbents")?.evidence.join(" ")).toContain(
      "LEAKED-SHADOW-DISGUISED",
    );
    expect(result.verdict).toBe("shadow-invalid");
    expect(result.ledgerLanding).toBeNull();
    // The leak never lands, but the mechanically-derived divergences
    // are still recorded case-by-case (the honest record survives).
    expect(result.divergencesAppended).toBe(row.expected.divergenceCaseIds.length);
    expect(shadowLedger.divergencesFor(row.sourceProposalId)).toHaveLength(
      row.expected.divergenceCaseIds.length,
    );
  });
});

// ---------------------------------------------------------------------------
// The fake-shadow-runtime discriminations (each variant FAILs mechanically)
// ---------------------------------------------------------------------------

describe("VAL-034 app discriminations (the fake-shadow-runtime variants)", () => {
  test("an ESCAPING runtime (network access mid-shadow) is a containment violation that never lands", async () => {
    const { result, lifecycle } = await driveRowOverStack({
      row: rowById("probe-mid-shadow-escape"),
      runtimeVariant: "escaping",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("containment-violation");
    expect(result.isolation?.escapeDirections).toEqual(["network-access"]);
    expect(criterionOf(result, "isolation-no-escape")?.status).toBe("FAIL");
    expect(criterionOf(result, "isolation-no-escape")?.evidence.join(" ")).toContain(
      "CONTAINMENT-VIOLATION",
    );
    // The violating shadow never lands — never silently forgiven.
    expect(result.ledgerLanding).toBeNull();
    expect(lifecycle.landedProposalIds).toEqual([]);
  });

  test("an AGGREGATE-ONLY runtime (an asserted aggregate without per-case records) FAILs", async () => {
    const { result } = await driveRowOverStack({
      row: rowById("probe-smoothed-aggregate"),
      runtimeVariant: "aggregate-only",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.regressionHonesty?.perCaseEvidenceComplete).toBe(false);
    expect(result.regressionHonesty?.missingCaseIds).toEqual(
      rowById("probe-smoothed-aggregate").trafficPopulation.map((tcase) => tcase.caseId),
    );
    expect(criterionOf(result, "regression-per-case-evidence")?.status).toBe("FAIL");
    expect(criterionOf(result, "regression-per-case-evidence")?.evidence.join(" ")).toContain(
      "AGGREGATE-ONLY",
    );
    expect(result.verdict).toBe("shadow-invalid");
    expect(result.ledgerLanding).toBeNull();
  });

  test("a SUBSET-COMPARED runtime (an asserted agreement from a subset) FAILs", async () => {
    const row = rowById("probe-smoothed-aggregate");
    const { result } = await driveRowOverStack({
      row,
      runtimeVariant: "subset-compared",
    });
    expect(result.terminal).toBe("FAILED");
    const missing = row.trafficPopulation[row.trafficPopulation.length - 1]?.caseId ?? "";
    expect(result.regressionHonesty?.missingCaseIds).toEqual([missing]);
    expect(criterionOf(result, "regression-per-case-evidence")?.status).toBe("FAIL");
    expect(result.verdict).toBe("shadow-invalid");
    expect(result.ledgerLanding).toBeNull();
  });

  test("a SMOOTHING runtime (a divergent case claimed agreeing) FAILs the honesty leg", async () => {
    const row = rowById("probe-smoothed-aggregate");
    const { result, shadowLedger } = await driveRowOverStack({
      row,
      runtimeVariant: "smoothing",
    });
    expect(result.terminal).toBe("FAILED");
    const smoothed = row.trafficPopulation[0]?.caseId ?? "";
    expect(result.regressionHonesty?.mechanicalDivergenceCaseIds).toEqual([smoothed]);
    expect(result.regressionHonesty?.smoothedCaseIds).toEqual([smoothed]);
    expect(criterionOf(result, "regression-no-smoothing")?.status).toBe("FAIL");
    expect(criterionOf(result, "regression-no-smoothing")?.evidence.join(" ")).toContain(
      "DIVERGENCE-SMOOTHING",
    );
    // The asserted aggregate contradicts the per-case evidence too.
    expect(criterionOf(result, "regression-aggregate-honest")?.status).toBe("FAIL");
    // The smoothed divergence never lands and never books its dishonest
    // record into the divergence ledger.
    expect(result.ledgerLanding).toBeNull();
    expect(shadowLedger.divergenceProposalIds).toEqual([]);
    expect(criterionOf(result, "divergence-ledger-case-by-case")?.status).toBe("FAIL");
  });

  test("an UNMEASURED shadow cost FAILs the cost separation", async () => {
    const { result } = await driveRowOverStack({
      row: rowById("probe-smoothed-aggregate"),
      runtimeVariant: "unmeasured",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.shadowCostBooked).toBe(false);
    expect(result.costSeparation?.shadowCostMeasured).toBe(false);
    expect(criterionOf(result, "cost-shadow-measured")?.status).toBe("FAIL");
    expect(criterionOf(result, "cost-shadow-measured")?.evidence.join(" ")).toContain(
      "UNMEASURED-SHADOW-COST",
    );
    expect(criterionOf(result, "cost-shadow-ledger-books-shadow")?.status).toBe("FAIL");
    expect(result.verdict).toBe("shadow-invalid");
    expect(result.ledgerLanding).toBeNull();
  });
});
