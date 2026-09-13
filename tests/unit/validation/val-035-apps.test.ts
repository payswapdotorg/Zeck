/**
 * VAL-035 acceptance criterion 1 + 2: the canary-promotion customer
 * application rides the public SDK boundary end to end against a
 * controlled fake transport (the submission phase — one OWN durable
 * execution per row under its OWN idempotency key; the observation
 * phase — the completion poll observing the honest terminal (a clean
 * promotion and an honest refusal are COMPLETED runs; an honest
 * budget-breach rollback is an honest FAILED), the result retrieval
 * surfacing the verification statuses, the route's model-call count
 * (zero offline), the honest none-reported offline usage, the canary
 * verdict read back (the kind, the refusal reason, the breaching step,
 * the final stage), the lifecycle landing (the pinned final stage
 * ONLY), the read-back canary decisions with their policy citations
 * and checks, the per-case slice comparisons, the rollback events +
 * the rollback-plan record, the customer-facing served outcomes, the
 * canary cost measurement, the served accounting, the canary-ledger
 * booking with its marker and the exercised capabilities, and the
 * events read re-deriving the canary trajectory digest over the public
 * journal; the assertion phase — the PURE per-row canary contract
 * re-derived AT the boundary), and its pinned task slice matches the
 * repository configuration file and the corpus.
 *
 * Discrimination: the FAKE-LIFECYCLE variants (JUMP-TO-PROMOTED /
 * BROKEN-WALK / WRONG-STAGE / EVIDENCE-LESS / REWRITE-REGISTRY), the
 * FAKE-CANARY-LEDGER variants (SMOOTHING-DECISIONS / DECISIONLESS /
 * UNMARKED-DOUBLE-BOOKING), the FAKE-SERVING-PATH variants (OVER-SLICE
 * / PARTIAL-ROLLBACK) and the FAKE-CANARY-RUNTIME variants (ESCAPING /
 * BREACHING / UNMEASURED) each FAIL a specific mechanical criterion and
 * never land their dishonest canary/promoted transition in the
 * candidate lifecycle — while the honest stack passes every offline
 * row, the lifecycle appends `shadow-executed → canaried → promoted`
 * one evidenced rung at a time, the decision / divergence / rollback /
 * cost ledgers are append-only, and the registry's EXISTING entries are
 * never rewritten.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  CANARY_PROMOTION_TASKS,
  runCanaryPromotionApp,
} from "../../../benchmarks/validation/apps/canary-promotion/application";
import {
  CANARY_PROMOTION_CORPUS,
  CANARY_PROMOTION_ROW_IDS,
  CANARY_PROMOTION_TASK_KIND,
  canaryRowById,
  canarySubmissionKey,
  canaryTaskBodyFor,
  DEFAULT_RAMP_SCHEDULE,
  LIVE_CORPUS_ROWS,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
  PINNED_REGISTRY_ENTRIES,
  pinnedCanaryRampOf,
  priorWalkOf,
  REFERENCED_REPLAY_POPULATION_REFS,
} from "../../../benchmarks/validation/apps/canary-promotion/corpus";
import {
  createCanaryFakeApiWorld,
  createCanaryLedger,
  createCanaryRuntime,
  createCanaryServingPath,
  createCandidateRegistry,
  createHonestCanaryStack,
  createIncumbentExecutor,
  createLifecycleLedger,
  createTickClock,
  createTrafficSource,
  type FakeCanaryLedgerVariant,
  type FakeCanaryRuntimeVariant,
  type FakeLifecycleVariant,
  type FakeServingPathVariant,
} from "../../../benchmarks/validation/apps/canary-promotion/fixtures";
import {
  adversarialCasesOf,
  historicalCasesOf,
  phantomProposalIdOf,
} from "../../../benchmarks/validation/apps/equivalence-testing/corpus";
import { recordedObservationsOf } from "../../../benchmarks/validation/apps/learning-discovery/corpus";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { HarnessEvidence } from "../../../benchmarks/validation/harness/evidence";
import type { TransportImplementation } from "../../../benchmarks/validation/harness/harness";
import type {
  CanaryCorpusRow,
  CanaryRunResult,
} from "../../../benchmarks/validation/platform/canary-promotion";
import {
  CANARY_REQUIRED_PRIOR_WALK,
  CANARY_SOURCE_STAGE,
  CANARY_STAGE,
  driveCanaryRun,
  isCanaryProbeKind,
  isCanaryVerdictKind,
  isRampScheduleWellFormed,
  PROMOTED_STAGE,
  sliceCaseIdsOf,
} from "../../../benchmarks/validation/platform/canary-promotion";
import {
  isAcceptanceCriterionKind,
  isReplacementShape,
} from "../../../benchmarks/validation/platform/equivalence-testing";

const REVISION = "bfc5a8d4c11d1c9a5b6f00112233445566778899aa";

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

/** The fake API world's boundary discrimination knobs. */
interface WorldKnobs {
  readonly terminal?: "COMPLETED" | "FAILED";
  readonly skipped?: boolean;
  readonly unchecked?: boolean;
  readonly smoothed?: boolean;
  readonly overslice?: boolean;
  readonly foreigntenant?: boolean;
  readonly partialrollback?: boolean;
  readonly planmissing?: boolean;
  readonly escaping?: boolean;
  readonly unmeasured?: boolean;
  readonly unmarked?: boolean;
  readonly billed?: boolean;
}

/** Run one app row over the fake API world (the boundary discrimination knobs). */
async function runAppOverFakeWorld(options: {
  readonly taskIndex: number;
  readonly knobs?: WorldKnobs;
}): Promise<{
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly outcome: Awaited<ReturnType<typeof runCanaryPromotionApp>>;
  readonly createdExecutions: number;
}> {
  const knobs = options.knobs ?? {};
  const clock = createTickClock();
  const world = createCanaryFakeApiWorld({
    clock,
    ...(knobs.terminal === undefined ? {} : { terminal: knobs.terminal }),
    ...(knobs.skipped === true ? { skipped: true } : {}),
    ...(knobs.unchecked === true ? { unchecked: true } : {}),
    ...(knobs.smoothed === true ? { smoothed: true } : {}),
    ...(knobs.overslice === true ? { overslice: true } : {}),
    ...(knobs.foreigntenant === true ? { foreigntenant: true } : {}),
    ...(knobs.partialrollback === true ? { partialrollback: true } : {}),
    ...(knobs.planmissing === true ? { planmissing: true } : {}),
    ...(knobs.escaping === true ? { escaping: true } : {}),
    ...(knobs.unmeasured === true ? { unmeasured: true } : {}),
    ...(knobs.unmarked === true ? { unmarked: true } : {}),
    ...(knobs.billed === true ? { billed: true } : {}),
  });
  const outcome = await runCanaryPromotionApp({
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
      configuration: { suite: "val-035-apps" },
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
  readonly row: CanaryCorpusRow;
  readonly lifecycleVariant?: FakeLifecycleVariant;
  readonly canaryLedgerVariant?: FakeCanaryLedgerVariant;
  readonly servingPathVariant?: FakeServingPathVariant;
  readonly runtimeVariant?: FakeCanaryRuntimeVariant;
}): Promise<{
  readonly result: CanaryRunResult;
  readonly registry: ReturnType<typeof createCandidateRegistry>;
  readonly lifecycle: ReturnType<typeof createLifecycleLedger>;
  readonly canaryLedger: ReturnType<typeof createCanaryLedger>;
}> {
  const clock = createTickClock();
  const registry = createCandidateRegistry();
  const servingPath = createCanaryServingPath(
    options.servingPathVariant === undefined ? undefined : { variant: options.servingPathVariant },
  );
  const lifecycle = createLifecycleLedger({
    ...(options.lifecycleVariant === undefined ? {} : { variant: options.lifecycleVariant }),
    registry,
  });
  const canaryLedger = createCanaryLedger(
    options.canaryLedgerVariant === undefined
      ? undefined
      : { variant: options.canaryLedgerVariant, servingPath },
  );
  const result = await driveCanaryRun({
    row: options.row,
    registry,
    lifecycle,
    canaryLedger,
    incumbentExecutor: createIncumbentExecutor(),
    trafficSource: createTrafficSource(),
    servingPath,
    canaryRuntime: createCanaryRuntime(
      options.runtimeVariant === undefined ? undefined : { variant: options.runtimeVariant },
    ),
    now: clock.now,
  });
  return { result, registry, lifecycle, canaryLedger };
}

/** The task index of one corpus row. */
function taskIndexOf(rowId: string): number {
  const index = CANARY_PROMOTION_CORPUS.findIndex((row) => row.rowId === rowId);
  if (index < 0) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return index;
}

const rowById = (rowId: string): CanaryCorpusRow => {
  const row = canaryRowById(rowId);
  if (row === null) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

const criterionOf = (result: CanaryRunResult, criterionId: string) =>
  result.criteria.find((criterion) => criterion.criterionId === criterionId);

const appCriterionOf = (
  outcome: Awaited<ReturnType<typeof runCanaryPromotionApp>>,
  criterionId: string,
) => outcome.appCriteria.find((criterion) => criterion.criterionId === criterionId);

/** The steps a row's ramp actually executes (the full ramp, or up to the breach). */
function executedStepCountOf(row: CanaryCorpusRow): number {
  return row.expected.breachingStepIndex === null
    ? row.rampSchedule.length
    : row.expected.breachingStepIndex;
}

// ---------------------------------------------------------------------------
// The pinned task slice ↔ corpus ↔ config.json consistency
// ---------------------------------------------------------------------------

describe("VAL-035 app task-slice consistency", () => {
  test("the exported task slice mirrors the corpus exactly", () => {
    expect(CANARY_PROMOTION_TASKS.length).toBe(CANARY_PROMOTION_CORPUS.length);
    for (const [index, task] of CANARY_PROMOTION_TASKS.entries()) {
      const row = CANARY_PROMOTION_CORPUS[index];
      expect(task.rowId).toBe(row?.rowId);
      expect(task.kind).toBe(CANARY_PROMOTION_TASK_KIND);
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
      expect(task.rampSchedule).toEqual(row?.rampSchedule.map((step) => step.trafficFraction));
      expect(task.maxDivergencesPerStep).toBe(row?.failureBudget.maxDivergencesPerStep);
      expect(task.expectedVerdict).toBe(row?.expected.verdict);
      expect(task.expectedRefusalReason).toBe(row?.expected.refusalReason);
      expect(task.expectedBreachingStepIndex).toBe(row?.expected.breachingStepIndex);
      expect(task.expectedFinalStage).toBe(row?.expected.finalStage);
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
          "../../../benchmarks/validation/apps/canary-promotion/config.json",
        ),
        "utf-8",
      ),
    ) as { tasks: Record<string, unknown>[]; tokenEnvVar: string; integrationSurface: string };
    expect(config.tasks.length).toBe(CANARY_PROMOTION_TASKS.length);
    for (const [index, task] of config.tasks.entries()) {
      const exported = CANARY_PROMOTION_TASKS[index];
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
      expect(task.rampSchedule).toEqual([...(exported?.rampSchedule ?? [])]);
      expect(task.maxDivergencesPerStep).toBe(exported?.maxDivergencesPerStep);
      expect(task.expectedVerdict).toBe(exported?.expectedVerdict);
      expect(task.expectedRefusalReason).toBe(exported?.expectedRefusalReason);
      expect(task.expectedBreachingStepIndex).toBe(exported?.expectedBreachingStepIndex);
      expect(task.expectedFinalStage).toBe(exported?.expectedFinalStage);
      expect(task.expectedTerminal).toBe(exported?.expectedTerminal);
      expect(task.trajectoryClassSize).toBe(exported?.trajectoryClassSize);
      expect(task.expectedModelCalls).toBe(exported?.expectedModelCalls);
      expect(task.probe ?? null).toBe(exported?.probe ?? null);
      expect(task.liveGate ?? null).toEqual(exported?.liveGate ?? null);
    }
    expect(config.tokenEnvVar).toBe("ZECK_VALIDATION_TOKEN");
    expect(config.integrationSurface).toBe("sdk");
  });

  test("the corpus is well-formed (unique ids, registry membership, stated policies, honest oracles)", () => {
    const rowIds = CANARY_PROMOTION_CORPUS.map((row) => row.rowId);
    expect(new Set(rowIds).size).toBe(rowIds.length);
    expect(CANARY_PROMOTION_ROW_IDS).toEqual(rowIds);
    expect(canaryRowById("rag-deterministic-function-clean-promotion")?.rowId).toBe(
      "rag-deterministic-function-clean-promotion",
    );
    expect(canaryRowById("nonexistent")).toBeNull();

    const registryProposalIds = new Set(PINNED_REGISTRY_ENTRIES.map((pin) => pin.proposalId));
    for (const row of CANARY_PROMOTION_CORPUS) {
      // The vocabulary legs: shapes, criteria, verdicts, probes.
      expect(isReplacementShape(row.replacementShape), `${row.rowId} shape`).toBe(true);
      expect(
        isAcceptanceCriterionKind(row.acceptanceCriterion.kind),
        `${row.rowId} criterion`,
      ).toBe(true);
      expect(isCanaryVerdictKind(row.expected.verdict), `${row.rowId} verdict`).toBe(true);
      if (row.probe !== undefined) {
        expect(isCanaryProbeKind(row.probe.kind), `${row.rowId} probe`).toBe(true);
      }
      // The pinned policy is well-formed: a strictly-increasing ramp
      // ending at the full-traffic step, a stated failure budget, a
      // stated tolerance.
      expect(isRampScheduleWellFormed(row.rampSchedule), `${row.rowId} ramp well-formed`).toBe(
        true,
      );
      expect(row.rampSchedule[row.rampSchedule.length - 1]?.trafficFraction).toBe(1);
      expect(row.failureBudget.maxDivergencesPerStep).toBeGreaterThanOrEqual(0);
      // The canaried candidate is a registry member whose recorded walk
      // reaches shadow-executed — every row EXCEPT the
      // unregistered-refusal row, whose phantom citation is deliberately
      // NOT a member, and the premature-refusal row, whose member's walk
      // never reached the canary's source rung.
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
      // over the row's own population and policy (never asserted,
      // always derived) — the breaching step and the final stage agree.
      const ramp = pinnedCanaryRampOf(row);
      if (row.expected.refusalReason !== null) {
        expect(row.expected.verdict).toBe("honest-refusal");
        expect(row.expected.breachingStepIndex).toBeNull();
        expect(row.expected.finalStage).toBeNull();
        expect(row.expected.terminal).toBe("COMPLETED");
      } else if (ramp.breachingStepIndex !== null) {
        expect(row.expected.verdict).toBe("honest-rollback");
        expect(row.expected.breachingStepIndex).toBe(ramp.breachingStepIndex);
        expect(row.expected.finalStage).toBe(CANARY_STAGE);
        expect(row.expected.terminal).toBe("FAILED");
      } else {
        expect(row.expected.verdict).toBe("clean-promotion");
        expect(row.expected.breachingStepIndex).toBeNull();
        expect(row.expected.finalStage).toBe(PROMOTED_STAGE);
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
    // The verdict distribution: 8 offline clean promotions (4 honest
    // shapes + 4 clean probes) + 3 honest rollbacks + 2 honest
    // refusals, plus 1 live clean promotion.
    const promotions = CANARY_PROMOTION_CORPUS.filter(
      (row) => row.expected.verdict === "clean-promotion",
    ).length;
    const rollbacks = CANARY_PROMOTION_CORPUS.filter(
      (row) => row.expected.verdict === "honest-rollback",
    ).length;
    const refusals = CANARY_PROMOTION_CORPUS.filter(
      (row) => row.expected.verdict === "honest-refusal",
    ).length;
    expect(promotions).toBe(9);
    expect(rollbacks).toBe(3);
    expect(refusals).toBe(2);
    expect(OFFLINE_CORPUS_ROWS).toHaveLength(13);
    expect(LIVE_CORPUS_ROWS).toHaveLength(1);
    // Every probe vocabulary member is declared by exactly one row.
    const probeKinds = CANARY_PROMOTION_CORPUS.flatMap((row) =>
      row.probe === undefined ? [] : [row.probe.kind],
    );
    expect(new Set(probeKinds).size).toBe(probeKinds.length);
    expect(probeKinds.sort()).toEqual([
      "mid-canary-escape",
      "over-slice",
      "partial-rollback",
      "skipped-lifecycle",
      "smoothed-breach",
      "unchecked-policy",
    ]);
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
    const ragRow = rowById("rag-deterministic-function-clean-promotion");
    expect(ragRow.trafficPopulation).toEqual([
      ...historicalCasesOf(["rag-retrieval-replay-population"]),
      ...adversarialCasesOf({ rowId: ragRow.rowId, count: 2 }),
    ]);
    // The cross-workload row replays TWO recorded populations.
    const reuseRow = rowById("reuse-removed-call-budget-breach-rollback");
    expect(reuseRow.trafficPopulation).toEqual([
      ...historicalCasesOf(["text-summarize-replay-population", "probe-duplicate-replay"]),
      ...adversarialCasesOf({ rowId: reuseRow.rowId, count: 2 }),
    ]);
    // The tool-loop row's first injected probe carries the TWO-member
    // pinned class (the honest tolerance basis).
    const toolRow = rowById("tool-loop-reusable-tool-clean-promotion-tolerance");
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

  test("every canaried candidate's prior walk reaches shadow-executed (VAL-034's landing)", () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      if (row.expected.refusalReason !== null) {
        // The refusal rows' candidates never registered (or never
        // earned the canary's source rung) — no shadow-executed walk.
        continue;
      }
      const walk = priorWalkOf(row);
      expect(
        walk.map((transition) => transition.toStage),
        `${row.rowId} prior walk`,
      ).toEqual([...CANARY_REQUIRED_PRIOR_WALK]);
      for (const transition of walk) {
        expect(transition.proposalId).toBe(row.sourceProposalId);
        expect(transition.evidenceDigest).toMatch(/^[0-9a-f]{8}$/);
      }
      expect(walk[0]?.ordinal).toBe(1);
      expect(walk[1]?.ordinal).toBe(2);
      expect(walk[2]?.ordinal).toBe(3);
    }
    // The stage vocabulary: the canary advances FROM VAL-034's landing
    // through canaried to promoted — the FINAL stage.
    expect(CANARY_SOURCE_STAGE).toBe("shadow-executed");
    expect(CANARY_STAGE).toBe("canaried");
    expect(PROMOTED_STAGE).toBe("promoted");
    expect(DEFAULT_RAMP_SCHEDULE.map((step) => step.trafficFraction)).toEqual([0.05, 0.25, 0.5, 1]);
  });

  test("the submission fingerprint discipline is stable (one OWN key + body per row)", () => {
    expect(canarySubmissionKey({ runSuffix: "unit", taskIndex: 3 })).toBe("val-035-app-unit-3");
    const keys = [0, 1, 2].map((taskIndex) =>
      canarySubmissionKey({ runSuffix: "unit", taskIndex }),
    );
    expect(new Set(keys).size).toBe(3);
    const body = canaryTaskBodyFor({
      rowId: "rag-deterministic-function-clean-promotion",
      sourceProposalId: "cand-learning-discovery-e519d75f",
      replacementShape: "deterministic-function",
    });
    expect(body).toEqual({
      kind: CANARY_PROMOTION_TASK_KIND,
      rowId: "rag-deterministic-function-clean-promotion",
      sourceProposalId: "cand-learning-discovery-e519d75f",
      replacementShape: "deterministic-function",
      // The governed-ramp declaration (task semantics — never provider
      // selection; the platform keeps the route authority).
      canary: { phase: "canary", mode: "governed-ramp" },
    });
  });

  test("the live row is env-gated (offline the gate is closed; the credential opens it)", () => {
    const liveRows = CANARY_PROMOTION_CORPUS.filter((row) => row.needsDispatch);
    expect(liveRows).toHaveLength(1);
    const liveRow = liveRows[0] as CanaryCorpusRow;
    expect(liveRow.rowId).toBe("live-split-preprocessing-canary-confirmation");
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

describe("VAL-035 app over the honest fake world", () => {
  test("every CLEAN-PROMOTION and REFUSAL row PASSES with valid evidence (its OWN durable execution)", async () => {
    for (const [taskIndex, row] of CANARY_PROMOTION_CORPUS.entries()) {
      if (row.expected.verdict === "honest-rollback" || row.liveGate !== undefined) {
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
      // The canary submission landed its OWN durable execution (one
      // submission per row — never a replay, never a rejection).
      expect(run.createdExecutions).toBe(1);
      expect(run.outcome.submission.replayed).toBe(false);
      expect(run.outcome.submission.rejection).toBeNull();
      expect(run.outcome.submission.executionId).not.toBe("");
      // The observed terminal is the honest one (a refusal COMPLETES).
      expect(run.outcome.observedTerminal).toBe(row.expected.terminal);
      // The app-side trajectory digest is a member of the pinned class.
      expect(row.expectedTrajectoryClass).toContain(run.outcome.trajectoryDigest ?? "");
      // The run made its OWN dispatches (zero offline) and the usage is
      // honestly none-reported offline.
      expect(run.outcome.observedModelCalls).toBe(0);
      expect(run.outcome.usage).toBeNull();
    }
  });

  test("the honest-rollback rows behave per their pin (an honest FAILED, never smoothed)", async () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) => candidate.expected.verdict === "honest-rollback",
    )) {
      const run = await runAppOverFakeWorld({ taskIndex: taskIndexOf(row.rowId) });
      // The boundary re-derivation honestly FAILs the observed-breach
      // leg (the step's divergence count beyond its pinned budget) —
      // the breach is recorded case-by-case, never smoothed into an
      // app pass — while every OTHER boundary leg passes.
      expect(run.outcome.observedTerminal).toBe("FAILED");
      expect(appCriterionOf(run.outcome, "app-expected-terminal")?.status).toBe("PASS");
      expect(appCriterionOf(run.outcome, "app-verdict-kind-pinned")?.status).toBe("PASS");
      expect(appCriterionOf(run.outcome, "app-final-stage-pinned")?.status).toBe("PASS");
      expect(appCriterionOf(run.outcome, "app-breach-observed-beyond-budget")?.status).toBe("FAIL");
      expect(
        appCriterionOf(run.outcome, "app-breach-observed-beyond-budget")?.evidence.join(" "),
      ).toContain("HONEST-BREACH");
      expect(appCriterionOf(run.outcome, "app-breach-beyond-budget-rolls-back")?.status).toBe(
        "PASS",
      );
      expect(appCriterionOf(run.outcome, "app-breach-count-never-smoothed")?.status).toBe("PASS");
      expect(appCriterionOf(run.outcome, "app-rollback-plan-exercised")?.status).toBe("PASS");
      expect(appCriterionOf(run.outcome, "app-rollback-complete-mechanical")?.status).toBe("PASS");
      expect(appCriterionOf(run.outcome, "app-terminal-criteria-agreement")?.status).toBe("PASS");
      expect(run.outcome.verdict?.kind).toBe("honest-rollback");
      expect(run.outcome.verdict?.breachingStepIndex).toBe(row.expected.breachingStepIndex);
      // The honest rollback lands the `canaried` rung ONLY — never the
      // promoted rung.
      expect(run.outcome.lifecycleLanding).toEqual({
        proposalId: row.sourceProposalId,
        finalStage: CANARY_STAGE,
      });
      // The breaching step's decision is breach-rollback with its
      // stated-and-checked policy; the ramp stops at the breach.
      expect(run.outcome.decisions).toHaveLength(executedStepCountOf(row));
      const breachingDecision = run.outcome.decisions.find(
        (decision) => decision.stepIndex === row.expected.breachingStepIndex,
      );
      expect(breachingDecision?.kind).toBe("breach-rollback");
      expect(breachingDecision?.budgetLimit).toBe(row.failureBudget.maxDivergencesPerStep);
      expect(breachingDecision?.observedDivergenceCount).toBeGreaterThan(
        row.failureBudget.maxDivergencesPerStep,
      );
      // The rollback event is complete (no residual serving the
      // replacement) and the plan is surfaced as recorded.
      expect(run.outcome.rollbackEvents).toHaveLength(1);
      expect(run.outcome.rollbackEvents[0]?.residualReplacementCaseIds).toEqual([]);
      expect(run.outcome.rollbackPlanRecorded).toBe(true);
      expect(run.outcome.submission.rejection).toBeNull();
      expect(run.outcome.observedModelCalls).toBe(0);
    }
  });

  test("the clean-promotion rows read back their full ramp, their slice serves and their separated cost", async () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) => candidate.expected.verdict === "clean-promotion",
    )) {
      const run = await runAppOverFakeWorld({ taskIndex: taskIndexOf(row.rowId) });
      expect(run.passed, `${row.rowId} passed`).toBe(true);
      expect(run.outcome.verdict).toEqual({
        kind: "clean-promotion",
        refusalReason: null,
        breachingStepIndex: null,
        finalStage: PROMOTED_STAGE,
      });
      expect(run.outcome.lifecycleLanding).toEqual({
        proposalId: row.sourceProposalId,
        finalStage: PROMOTED_STAGE,
      });
      // The full ramp decided: every step's decision advances within
      // its budget with its stated-and-checked policy.
      expect(run.outcome.decisions).toHaveLength(row.rampSchedule.length);
      for (const decision of run.outcome.decisions) {
        expect(decision.kind).toBe("advance");
        expect(decision.observedDivergenceCount).toBeLessThanOrEqual(decision.budgetLimit);
        expect(decision.policyCitations.failureBudgetStated).toBe(true);
        expect(decision.policyCitations.toleranceStated).toBe(true);
        expect(decision.policyChecks.rampChecked).toBe(true);
        expect(decision.policyChecks.budgetChecked).toBe(true);
        expect(decision.policyChecks.toleranceChecked).toBe(true);
      }
      // The customer-facing served outcomes: the replacement serves
      // ONLY inside each step's granted slice — the incumbent serves
      // the remainder.
      const populationCaseIds = row.trafficPopulation.map((tcase) => tcase.caseId);
      for (const step of row.rampSchedule) {
        const serves = run.outcome.servedOutcomes.filter(
          (serve) => serve.stepIndex === step.stepIndex,
        );
        expect(serves).toHaveLength(row.trafficPopulation.length);
        const slice = sliceCaseIdsOf(populationCaseIds, step.trafficFraction);
        for (const serve of serves) {
          if (slice.includes(serve.caseId)) {
            expect(serve.servedSource).toBe("replacement");
          } else {
            expect(serve.servedSource).toBe("incumbent");
          }
        }
      }
      // The canary cost is measured and booked to the canary ledger
      // under its canary marker while the served accounting bills the
      // incumbent ONLY (the customer is never billed for the canary).
      expect(run.outcome.canaryCost).not.toBeNull();
      expect(run.outcome.servedIncumbentMicroUsd).toBe(run.outcome.servedCostMicroUsd);
      expect(run.outcome.canaryLedgerBookedMicroUsd).toBe(run.outcome.canaryCost?.microUsd);
      expect(run.outcome.canaryMarkerPresent).toBe(true);
      expect(run.outcome.rollbackEvents).toEqual([]);
      // The boundary re-derivations PASS (explicit, honest, complete,
      // isolated, separated).
      expect(appCriterionOf(run.outcome, "app-policy-explicitness-summary")?.status).toBe("PASS");
      expect(appCriterionOf(run.outcome, "app-breach-honesty-summary")?.status).toBe("PASS");
      expect(appCriterionOf(run.outcome, "app-rollback-completeness-summary")?.status).toBe("PASS");
      expect(appCriterionOf(run.outcome, "app-slice-isolation-summary")?.status).toBe("PASS");
      expect(appCriterionOf(run.outcome, "app-canary-cost-separation-summary")?.status).toBe(
        "PASS",
      );
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
      expect(run.outcome.decisions).toEqual([]);
      expect(run.outcome.sliceComparisons).toEqual([]);
      expect(run.outcome.rollbackEvents).toEqual([]);
      expect(run.outcome.servedOutcomes).toEqual([]);
      expect(run.outcome.canaryCost).toBeNull();
    }
    const unregistered = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("unregistered-candidate-canary-refusal"),
    });
    expect(unregistered.outcome.verdict?.refusalReason).toBe("candidate-unregistered");
    const premature = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("not-yet-shadow-executed-canary-refusal"),
    });
    expect(premature.outcome.verdict?.refusalReason).toBe("candidate-not-shadow-executed");
  });

  test("the run identity is the VAL-035 work order and the latencies are measured", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("rag-deterministic-function-clean-promotion"),
    });
    expect(run.passed).toBe(true);
    expect(run.evidence.workOrder).toBe("VAL-035");
    expect(run.evidence.program).toBe("zeck-validation");
    expect(run.evidence.integrationSurface).toBe("sdk");
    expect(run.evidence.request?.taskKind).toBe(CANARY_PROMOTION_TASK_KIND);
    // The measured submission latency (never estimated).
    expect(run.outcome.submissionLatencyMs).toBeGreaterThan(0);
    expect(run.evidence.timings.submitMs).not.toBeNull();
  });

  test("the pinned canary trajectories are single-member classes reproduced over the public journal", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const run = await runAppOverFakeWorld({ taskIndex: taskIndexOf(row.rowId) });
      expect(run.outcome.trajectoryDigest).toBe(row.expectedTrajectoryClass[0] ?? "");
      expect(row.expectedTrajectoryClass).toHaveLength(1);
    }
    // The executed and the refusal shapes hold DISTINCT trajectories
    // (the executed shape carries the traffic/slice/canary/decision/
    // booking/landing steps; the refusal shape the refusal step).
    const executed = rowById("rag-deterministic-function-clean-promotion");
    const refusal = rowById("unregistered-candidate-canary-refusal");
    expect(executed.expectedTrajectoryClass[0]).not.toBe(refusal.expectedTrajectoryClass[0]);
    // The clean-promotion and the honest-rollback shapes hold DISTINCT
    // trajectories too (the rollback carries the rollback-exercised
    // step and lands one rung fewer).
    const rollback = rowById("reuse-removed-call-budget-breach-rollback");
    expect(executed.expectedTrajectoryClass[0]).not.toBe(rollback.expectedTrajectoryClass[0]);
  });
});

// ---------------------------------------------------------------------------
// The lifecycle + canary-ledger landing over the fake stack (append-only;
// registry read-only; one evidenced rung at a time)
// ---------------------------------------------------------------------------

describe("VAL-035 lifecycle landing (the driver over the fake stack)", () => {
  test("executed verdicts append shadow-executed → canaried → promoted one evidenced rung", async () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) => candidate.expected.refusalReason === null,
    )) {
      const stack = createHonestCanaryStack();
      const result = await driveCanaryRun({
        row,
        registry: stack.registry,
        lifecycle: stack.lifecycle,
        canaryLedger: stack.canaryLedger,
        incumbentExecutor: stack.incumbentExecutor,
        trafficSource: stack.trafficSource,
        servingPath: stack.servingPath,
        canaryRuntime: stack.canaryRuntime,
        now: stack.clock.now,
      });
      expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
      // The walk is EXACTLY the recorded VAL-033 + VAL-034 walk plus
      // the canary append — one evidenced rung at a time (canaried,
      // then promoted ONLY on a clean full ramp).
      const walk = stack.lifecycle
        .transitionsFor(row.sourceProposalId)
        .map((transition) => transition.toStage);
      const expectedWalk: string[] = [
        ...CANARY_REQUIRED_PRIOR_WALK,
        CANARY_STAGE,
        ...(row.expected.finalStage === PROMOTED_STAGE ? [PROMOTED_STAGE] : []),
      ];
      expect(walk, `${row.rowId} walk`).toEqual(expectedWalk);
      for (const transition of stack.lifecycle.transitionsFor(row.sourceProposalId)) {
        expect(transition.evidenceDigest).toMatch(/^[0-9a-f]{8}$/);
        expect(transition.proposalId).toBe(row.sourceProposalId);
      }
      expect(result.landings.canaried?.accepted, `${row.rowId} canaried landing`).toBe(true);
      if (row.expected.verdict === "clean-promotion") {
        expect(result.landings.promoted?.accepted, `${row.rowId} promoted landing`).toBe(true);
      } else {
        expect(result.landings.promoted, `${row.rowId} rollback never promotes`).toBeNull();
      }
      expect(stack.lifecycle.landedProposalIds).toEqual([row.sourceProposalId]);
      // The governed-ramp legs: the decisions appended exactly the
      // executed steps, the divergences recorded case-by-case, the
      // rollback exercised only on the breach, the canary cost booked.
      expect(result.decisionsAppended, `${row.rowId} decisions`).toBe(executedStepCountOf(row));
      expect(stack.canaryLedger.decisionsFor(row.sourceProposalId)).toHaveLength(
        executedStepCountOf(row),
      );
      const expectedDivergences = pinnedCanaryRampOf(row)
        .divergencesByStep.filter(
          (entry) =>
            row.expected.breachingStepIndex === null ||
            entry.stepIndex <= row.expected.breachingStepIndex,
        )
        .reduce((total, entry) => total + entry.divergenceCaseIds.length, 0);
      expect(result.divergencesAppended, `${row.rowId} divergences`).toBe(expectedDivergences);
      expect(stack.canaryLedger.divergencesFor(row.sourceProposalId)).toHaveLength(
        expectedDivergences,
      );
      expect(result.rollbackEventsAppended, `${row.rowId} rollback events`).toBe(
        row.expected.breachingStepIndex === null ? 0 : 1,
      );
      expect(result.canaryCostBooked, `${row.rowId} canary cost booked`).toBe(true);
      for (const cost of stack.canaryLedger.canaryCostsFor(row.sourceProposalId)) {
        expect(cost.marker).toBe("canary");
      }
      // The mechanical legs of the trustworthy ramp.
      expect(result.policyExplicitness?.explicit).toBe(true);
      expect(result.lifecycleCompleteness?.complete).toBe(true);
      expect(result.breachHonesty?.honest).toBe(true);
      expect(result.rollbackCompleteness?.complete).toBe(true);
      expect(result.sliceIsolation?.isolated).toBe(true);
      expect(result.costSeparation?.separated).toBe(true);
      expect(result.isolation?.contained).toBe(true);
      // The served accounting bills the incumbent ONLY (the canary
      // cost is measured apart, never billed).
      const accounting = stack.servingPath.servedAccounting();
      expect(accounting.billedMicroUsd).toBe(accounting.incumbentMicroUsd);
    }
  });

  test("the registry's EXISTING entries are never rewritten by an honest run", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const stack = createHonestCanaryStack();
      const digestBefore = stack.registry.digest();
      const entriesBefore = stack.registry.store().size;
      await driveCanaryRun({
        row,
        registry: stack.registry,
        lifecycle: stack.lifecycle,
        canaryLedger: stack.canaryLedger,
        incumbentExecutor: stack.incumbentExecutor,
        trafficSource: stack.trafficSource,
        servingPath: stack.servingPath,
        canaryRuntime: stack.canaryRuntime,
        now: stack.clock.now,
      });
      expect(stack.registry.digest(), `${row.rowId} registry unchanged`).toBe(digestBefore);
      expect(stack.registry.store().size, `${row.rowId} no entries added or removed`).toBe(
        entriesBefore,
      );
      // Every pinned member is still a member at the proposed stage
      // (the canary verdict APPENDS to the lifecycle, it never
      // rewrites a proposal).
      for (const pin of PINNED_REGISTRY_ENTRIES) {
        expect(stack.registry.store().get(pin.proposalId)?.lifecycleStage).toBe("proposed");
      }
    }
  });

  test("an honest re-drive REPLAYS the canary walk (append-only idempotence)", async () => {
    const row = rowById("rag-deterministic-function-clean-promotion");
    const stack = createHonestCanaryStack();
    const drive = () =>
      driveCanaryRun({
        row,
        registry: stack.registry,
        lifecycle: stack.lifecycle,
        canaryLedger: stack.canaryLedger,
        incumbentExecutor: stack.incumbentExecutor,
        trafficSource: stack.trafficSource,
        servingPath: stack.servingPath,
        canaryRuntime: stack.canaryRuntime,
        now: stack.clock.now,
      });
    const first = await drive();
    expect(first.terminal).toBe("COMPLETED");
    const second = await drive();
    expect(second.terminal).toBe("COMPLETED");
    // The identical re-append REPLAYS: still exactly the recorded walk
    // plus the canaried + promoted append — never a rewrite.
    expect(second.landings.canaried?.replayed).toBe(true);
    expect(second.landings.canaried?.accepted).toBe(true);
    expect(second.landings.promoted?.replayed).toBe(true);
    expect(second.landings.promoted?.accepted).toBe(true);
    expect(stack.lifecycle.transitionsFor(row.sourceProposalId)).toHaveLength(5);
    expect(stack.lifecycle.landedProposalIds).toEqual([row.sourceProposalId]);
    // The canary ledgers are append-only: the re-drive re-appends
    // identically (no new decision rows, no double bookings).
    expect(stack.canaryLedger.decisionsFor(row.sourceProposalId)).toHaveLength(
      row.rampSchedule.length,
    );
    const costsAfterFirst = stack.canaryLedger.canaryCostsFor(row.sourceProposalId).length;
    await drive();
    expect(stack.canaryLedger.canaryCostsFor(row.sourceProposalId)).toHaveLength(costsAfterFirst);
    expect(stack.registry.digest()).toBe(createCandidateRegistry().digest());
  });

  test("the refusal rows append NOTHING (lifecycle, decisions, divergences, rollback, cost)", async () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) => candidate.expected.verdict === "honest-refusal",
    )) {
      const stack = createHonestCanaryStack();
      const result = await driveCanaryRun({
        row,
        registry: stack.registry,
        lifecycle: stack.lifecycle,
        canaryLedger: stack.canaryLedger,
        incumbentExecutor: stack.incumbentExecutor,
        trafficSource: stack.trafficSource,
        servingPath: stack.servingPath,
        canaryRuntime: stack.canaryRuntime,
        now: stack.clock.now,
      });
      expect(result.terminal).toBe("COMPLETED");
      expect(result.verdict).toBe("honest-refusal");
      expect(result.refusalHonesty?.honest).toBe(true);
      // Nothing executed, nothing landed, nothing booked.
      expect(result.refusal?.reason).toBe(row.expected.refusalReason);
      expect(result.landings.canaried).toBeNull();
      expect(result.landings.promoted).toBeNull();
      expect(result.decisionsAppended).toBe(0);
      expect(result.divergencesAppended).toBe(0);
      expect(result.rollbackEventsAppended).toBe(0);
      expect(result.canaryCostBooked).toBe(false);
      expect(stack.lifecycle.landedProposalIds).toEqual([]);
      expect(stack.canaryLedger.decisionProposalIds).toEqual([]);
      expect(
        stack.canaryLedger.canaryCostsFor(row.sourceProposalId),
        `${row.rowId} refusal books no canary cost`,
      ).toEqual([]);
      expect(stack.canaryLedger.rollbackEventsFor(row.sourceProposalId)).toEqual([]);
      if (row.expected.refusalReason === "candidate-not-shadow-executed") {
        // The premature candidate's recorded walk ends at
        // differentially-evaluated — never canaried.
        const walk = stack.lifecycle
          .transitionsFor(row.sourceProposalId)
          .map((transition) => transition.toStage);
        expect(walk).toEqual(["offline-replayed", "differentially-evaluated"]);
      } else {
        expect(stack.lifecycle.transitionsFor(row.sourceProposalId)).toEqual([]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The fake-lifecycle + fake-canary-ledger discriminations (each variant
// FAILs a mechanical criterion)
// ---------------------------------------------------------------------------

describe("VAL-035 app discriminations (the fake-lifecycle + fake-canary-ledger variants)", () => {
  test("a JUMP-TO-PROMOTED ledger (the append skips the canaried rung) FAILs the lifecycle completeness", async () => {
    const { result, lifecycle } = await driveRowOverStack({
      row: rowById("probe-skipped-lifecycle"),
      lifecycleVariant: "jump-to-promoted",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("canary-invalid");
    // The append landed `promoted` DIRECTLY — a jumped rung.
    expect(result.lifecycleCompleteness?.jumpedRungOrdinals).toHaveLength(1);
    expect(criterionOf(result, "lifecycle-one-rung-at-a-time")?.status).toBe("FAIL");
    expect(criterionOf(result, "lifecycle-one-rung-at-a-time")?.evidence.join(" ")).toContain(
      "JUMPED-RUNG",
    );
    expect(criterionOf(result, "lifecycle-landing-shape")?.status).toBe("FAIL");
    expect(criterionOf(result, "canary-ledger-landing")?.status).toBe("FAIL");
    // The dishonest append never lands a second rung: the promoted
    // append under the recorded key is REFUSED.
    expect(result.landings.promoted?.accepted).toBe(false);
    expect(lifecycle.landedProposalIds).toEqual([
      rowById("probe-skipped-lifecycle").sourceProposalId,
    ]);
  });

  test("a BROKEN-WALK ledger (the shadow rung dropped) makes the honest run REFUSE where the row pinned a promotion", async () => {
    const { result, lifecycle } = await driveRowOverStack({
      row: rowById("probe-skipped-lifecycle"),
      lifecycleVariant: "broken-walk",
    });
    expect(result.terminal).toBe("FAILED");
    // The candidate never earned the canary's source rung — the honest
    // run refuses (candidate-not-shadow-executed) where the row pinned
    // a clean promotion: the verdict contract FAILs.
    expect(result.refusal?.reason).toBe("candidate-not-shadow-executed");
    expect(result.refusalHonesty?.honest).toBe(true);
    expect(criterionOf(result, "canary-verdict-contract")?.status).toBe("FAIL");
    expect(criterionOf(result, "canary-verdict-contract")?.evidence.join(" ")).toContain(
      "VERDICT-MISMATCH",
    );
    // Nothing executed, nothing landed.
    expect(result.landings.canaried).toBeNull();
    expect(lifecycle.landedProposalIds).toEqual([]);
  });

  test("a WRONG-STAGE ledger (a property-tested landing) FAILs the lifecycle completeness", async () => {
    const { result } = await driveRowOverStack({
      row: rowById("probe-skipped-lifecycle"),
      lifecycleVariant: "wrong-stage",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("canary-invalid");
    expect(result.lifecycleCompleteness?.wrongStageLandings).toEqual(["property-tested"]);
    expect(criterionOf(result, "lifecycle-landing-stages-legal")?.status).toBe("FAIL");
    expect(criterionOf(result, "lifecycle-landing-stages-legal")?.evidence.join(" ")).toContain(
      "ILLEGAL-LANDING",
    );
  });

  test("an EVIDENCE-LESS ledger (appends without evidence) FAILs the lifecycle completeness", async () => {
    const { result } = await driveRowOverStack({
      row: rowById("probe-skipped-lifecycle"),
      lifecycleVariant: "evidence-less",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("canary-invalid");
    expect(result.lifecycleCompleteness?.unevidencedAppendedOrdinals).toHaveLength(2);
    expect(criterionOf(result, "lifecycle-appended-transitions-evidenced")?.status).toBe("FAIL");
    expect(
      criterionOf(result, "lifecycle-appended-transitions-evidenced")?.evidence.join(" "),
    ).toContain("UNEVIDENCED-APPEND");
  });

  test("a REWRITE-REGISTRY ledger (a candidate rewrite) FAILs the read-only discipline", async () => {
    const { result, registry } = await driveRowOverStack({
      row: rowById("probe-skipped-lifecycle"),
      lifecycleVariant: "rewrite-registry",
    });
    expect(result.terminal).toBe("FAILED");
    // The verdict legs themselves were honest — the rewrite happened
    // at the append: the registry's frozen digest CHANGED (a rewritten
    // candidate) and the read-only criterion FAILs the row.
    expect(result.policyExplicitness?.explicit).toBe(true);
    expect(result.verdict).toBe("clean-promotion");
    expect(registry.store().get("cand-learning-discovery-e519d75f")?.lifecycleStage).toBe(
      "promoted",
    );
    expect(criterionOf(result, "canary-registry-read-only")?.status).toBe("FAIL");
    expect(criterionOf(result, "canary-registry-read-only")?.evidence.join(" ")).toContain(
      "REGISTRY-MUTATION",
    );
  });

  test("a SMOOTHING-DECISIONS canary ledger (a beyond-budget decision rewritten to advance) FAILs the breach honesty", async () => {
    const { result, lifecycle } = await driveRowOverStack({
      row: rowById("probe-smoothed-breach"),
      canaryLedgerVariant: "smoothing-decisions",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("canary-invalid");
    // The beyond-budget step's decision was rewritten to `advance` —
    // a smoothed breach that advances anyway.
    expect(result.breachHonesty?.smoothedBreachStepIndexes).toEqual([1]);
    expect(criterionOf(result, "breach-beyond-budget-rolls-back")?.status).toBe("FAIL");
    expect(criterionOf(result, "breach-beyond-budget-rolls-back")?.evidence.join(" ")).toContain(
      "SMOOTHED-BREACH",
    );
    // The smoothed canary is untrustworthy: nothing ever lands.
    expect(result.landings.canaried).toBeNull();
    expect(lifecycle.landedProposalIds).toEqual([]);
  });

  test("a DECISIONLESS canary ledger (an executed step without its decision) FAILs the policy explicitness", async () => {
    const { result, lifecycle } = await driveRowOverStack({
      row: rowById("probe-unchecked-policy"),
      canaryLedgerVariant: "decisionless",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("canary-invalid");
    // The first executed step's decision never landed — its policy was
    // never stated.
    expect(result.policyExplicitness?.decisionlessStepIndexes).toEqual([1]);
    expect(criterionOf(result, "policy-every-executed-step-decided")?.status).toBe("FAIL");
    expect(criterionOf(result, "policy-every-executed-step-decided")?.evidence.join(" ")).toContain(
      "DECISIONLESS-STEP",
    );
    expect(result.landings.canaried).toBeNull();
    expect(lifecycle.landedProposalIds).toEqual([]);
  });

  test("an UNMARKED-DOUBLE-BOOKING canary ledger (the customer billed for the canary) FAILs the cost separation", async () => {
    const { result, lifecycle } = await driveRowOverStack({
      row: rowById("rag-deterministic-function-clean-promotion"),
      canaryLedgerVariant: "unmarked-double-booking",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("canary-invalid");
    // The canary's cost landed in the served totals AND lost its
    // canary marker — the customer is billed for the canary.
    expect(result.costSeparation?.billed).toBe(true);
    expect(result.costSeparation?.markerMissing).toBe(true);
    expect(criterionOf(result, "canary-cost-never-billed")?.status).toBe("FAIL");
    expect(criterionOf(result, "canary-cost-never-billed")?.evidence.join(" ")).toContain(
      "BILLED-CANARY",
    );
    expect(criterionOf(result, "canary-cost-marker-present")?.status).toBe("FAIL");
    expect(criterionOf(result, "canary-cost-marker-present")?.evidence.join(" ")).toContain(
      "UNMARKED-CANARY-COST",
    );
    expect(result.landings.canaried).toBeNull();
    expect(lifecycle.landedProposalIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The fake-serving-path discriminations (the slice / rollback catches)
// ---------------------------------------------------------------------------

describe("VAL-035 app discriminations (the fake-serving-path variants)", () => {
  test("an OVER-SLICE serving path (the replacement served beyond the pinned slice) FAILs the slice isolation", async () => {
    const row = rowById("probe-over-slice");
    const { result, lifecycle } = await driveRowOverStack({
      row,
      lifecycleVariant: undefined,
      servingPathVariant: "over-slice",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("canary-invalid");
    // The first non-slice case of every step was served the
    // replacement — an unpromoted candidate serving beyond its canary
    // slice, named per step.
    expect(result.sliceIsolation?.overSliceCaseIds.length).toBeGreaterThan(0);
    for (const named of result.sliceIsolation?.overSliceCaseIds ?? []) {
      expect(named).toMatch(/^step-[1-4]:/);
    }
    expect(criterionOf(result, "slice-no-over-slice-serve")?.status).toBe("FAIL");
    expect(criterionOf(result, "slice-no-over-slice-serve")?.evidence.join(" ")).toContain(
      "OVER-SLICE",
    );
    // The over-slice canary is untrustworthy: never a passable outcome.
    expect(result.landings.canaried).toBeNull();
    expect(lifecycle.landedProposalIds).toEqual([]);
  });

  test("a PARTIAL-ROLLBACK serving path (a residual case still serving the replacement) FAILs the rollback completeness", async () => {
    const row = rowById("probe-partial-rollback");
    const { result, lifecycle } = await driveRowOverStack({
      row,
      servingPathVariant: "partial-rollback",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("canary-invalid");
    // The revert LEFT the last slice case serving the replacement —
    // never partial — and the residual is NAMED.
    const sliceAtBreach = sliceCaseIdsOf(
      row.trafficPopulation.map((tcase) => tcase.caseId),
      row.rampSchedule[0]?.trafficFraction ?? 1,
    );
    const residual = sliceAtBreach[sliceAtBreach.length - 1];
    expect(result.rollbackCompleteness?.residualReplacementCaseIds).toEqual([residual]);
    expect(criterionOf(result, "rollback-complete-mechanical")?.status).toBe("FAIL");
    expect(criterionOf(result, "rollback-complete-mechanical")?.evidence.join(" ")).toContain(
      "PARTIAL-ROLLBACK",
    );
    expect(criterionOf(result, "rollback-complete-mechanical")?.evidence.join(" ")).toContain(
      residual,
    );
    // The partial rollback is untrustworthy: nothing ever lands.
    expect(result.landings.canaried).toBeNull();
    expect(lifecycle.landedProposalIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The fake-canary-runtime discriminations (each variant FAILs mechanically)
// ---------------------------------------------------------------------------

describe("VAL-035 app discriminations (the fake-canary-runtime variants)", () => {
  test("an ESCAPING runtime (network access mid-canary) is a containment violation that never lands", async () => {
    const { result, lifecycle } = await driveRowOverStack({
      row: rowById("probe-mid-canary-escape"),
      runtimeVariant: "escaping",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("containment-violation");
    expect(result.isolation?.escapeDirections).toEqual(["network-access"]);
    expect(criterionOf(result, "isolation-no-escape")?.status).toBe("FAIL");
    expect(criterionOf(result, "isolation-no-escape")?.evidence.join(" ")).toContain(
      "CONTAINMENT-VIOLATION",
    );
    // The violating canary never lands — never silently forgiven.
    expect(result.landings.canaried).toBeNull();
    expect(lifecycle.landedProposalIds).toEqual([]);
  });

  test("a BREACHING runtime over a ZERO-budget row triggers the honest rollback where the row pinned a promotion (the verdict contract FAILs)", async () => {
    const { result, lifecycle } = await driveRowOverStack({
      row: rowById("order-settlement-retrieval-clean-promotion"),
      runtimeVariant: "breaching",
    });
    expect(result.terminal).toBe("FAILED");
    // The perturbed slice case diverges beyond the zero budget: the
    // step FAILs honestly and the run rolls back — but the row pinned
    // a clean promotion, so the verdict contract FAILs (the observed
    // verdict is an honest rollback, never a fabricated promotion).
    expect(result.verdict).toBe("honest-rollback");
    expect(result.breachHonesty?.breachingStepIndexes).toEqual([1]);
    expect(result.breachHonesty?.honest).toBe(true);
    expect(result.rollbackCompleteness?.complete).toBe(true);
    expect(result.landings.canaried?.accepted).toBe(true);
    expect(result.landings.promoted).toBeNull();
    expect(criterionOf(result, "canary-verdict-contract")?.status).toBe("FAIL");
    expect(criterionOf(result, "canary-verdict-contract")?.evidence.join(" ")).toContain(
      "VERDICT-MISMATCH",
    );
    // The honest rollback still lands ONLY the canaried rung.
    const walk = lifecycle
      .transitionsFor(rowById("order-settlement-retrieval-clean-promotion").sourceProposalId)
      .map((transition) => transition.toStage);
    expect(walk).toEqual([...CANARY_REQUIRED_PRIOR_WALK, CANARY_STAGE]);
  });

  test("an UNMEASURED canary runtime (the canary cost never measured) FAILs the cost separation", async () => {
    const { result, lifecycle } = await driveRowOverStack({
      row: rowById("rag-deterministic-function-clean-promotion"),
      runtimeVariant: "unmeasured",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.verdict).toBe("canary-invalid");
    expect(result.canaryCostBooked).toBe(false);
    expect(result.costSeparation?.unmeasured).toBe(true);
    expect(result.costSeparation?.unbooked).toBe(true);
    expect(criterionOf(result, "canary-cost-measured")?.status).toBe("FAIL");
    expect(criterionOf(result, "canary-cost-measured")?.evidence.join(" ")).toContain(
      "UNMEASURED-CANARY",
    );
    expect(criterionOf(result, "canary-cost-booked-apart")?.status).toBe("FAIL");
    expect(result.landings.canaried).toBeNull();
    expect(lifecycle.landedProposalIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The fake-world boundary knobs (the app contract catches every knob)
// ---------------------------------------------------------------------------

describe("VAL-035 app discriminations (the fake-world boundary knobs)", () => {
  test("the honest world passes the boundary contract for the rollback row (the control: only the honest-breach leg FAILs)", async () => {
    const run = await runAppOverFakeWorld({
      taskIndex: taskIndexOf("reuse-removed-call-budget-breach-rollback"),
    });
    // The boundary re-derivation honestly FAILs the observed-breach leg
    // (the recorded divergence count beyond the pinned budget) — never
    // a silent pass — while every other boundary leg passes.
    expect(run.outcome.observedTerminal).toBe("FAILED");
    expect(run.outcome.appCriteria.filter((criterion) => criterion.status === "FAIL")).toEqual([
      run.outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-breach-observed-beyond-budget",
      ),
    ]);
    expect(run.outcome.verdict?.kind).toBe("honest-rollback");
    expect(run.outcome.lifecycleLanding?.finalStage).toBe(CANARY_STAGE);
  });

  test("EVERY fake-world knob FAILs a specific boundary criterion (never a silent pass)", async () => {
    const knobToCriterion: readonly { readonly knob: WorldKnobs; readonly criterionId: string }[] =
      [
        { knob: { terminal: "COMPLETED" }, criterionId: "app-expected-terminal" },
        { knob: { skipped: true }, criterionId: "app-final-stage-pinned" },
        { knob: { unchecked: true }, criterionId: "app-policy-every-item-checked" },
        { knob: { smoothed: true }, criterionId: "app-breach-beyond-budget-rolls-back" },
        { knob: { overslice: true }, criterionId: "app-slice-no-over-slice-serve" },
        { knob: { foreigntenant: true }, criterionId: "app-slice-no-over-slice-serve" },
        { knob: { partialrollback: true }, criterionId: "app-rollback-complete-mechanical" },
        { knob: { planmissing: true }, criterionId: "app-rollback-plan-recorded" },
        { knob: { escaping: true }, criterionId: "app-verdict-kind-pinned" },
        { knob: { unmeasured: true }, criterionId: "app-canary-cost-measured" },
        { knob: { unmarked: true }, criterionId: "app-canary-cost-marker-present" },
        { knob: { billed: true }, criterionId: "app-canary-cost-never-billed" },
      ];
    // The honest-rollback row: its breaching step, its rollback event
    // and its served outcomes make every knob visible at the boundary
    // read-back.
    const taskIndex = taskIndexOf("reuse-removed-call-budget-breach-rollback");
    for (const { knob, criterionId } of knobToCriterion) {
      const run = await runAppOverFakeWorld({ taskIndex, knobs: knob });
      expect(run.passed, criterionId).toBe(false);
      const criterion = run.outcome.appCriteria.find((c) => c.criterionId === criterionId);
      expect(criterion, criterionId).toBeDefined();
      expect(criterion?.status, criterionId).toBe("FAIL");
      // The foreign-tenant serve is NAMED in the evidence.
      if (knob.foreigntenant === true) {
        expect(criterion?.evidence.join(" "), criterionId).toContain("foreign-tenant-case");
      }
    }
  });
});
