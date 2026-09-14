/**
 * VAL-044 acceptance criteria 1 and 2 (the app-side consistency + the
 * app-level discrimination floor): the customer application over the
 * fake public API world + the fixture variants' specific catches.
 *
 *   * the exported task slice mirrors the corpus exactly and
 *     config.json mirrors the exported task slice (the
 *     repository-reproducible, secret-free configuration);
 *   * the corpus well-formedness: digest references resolve to the
 *     RECORDED arm corpora (the digests re-derive exactly), the
 *     pre-registered arm sets cover all three arms, the pinned price
 *     revisions are valid in the manifest registry, the honest rows
 *     carry pinned syntheses, the probe rows declare their adversarial
 *     variants, the live gating;
 *   * every row's submission lands ONE durable execution over the
 *     honest fake world (the create/replay semantics at the POST
 *     boundary) and settles to its expected terminal (the honest
 *     COMPLETED verdict rows AND the honestly-FAILED probe rows);
 *   * the customer-boundary discriminations: a FABRICATED
 *     pass-with-fail FAILs the app honestly; a terminal override
 *     FAILs every mismatched row; a submission that never lands FAILs
 *     honestly (never a fabricated completion);
 *   * each fixture variant FAILs its specific criterion over the pure
 *     oracles (the quality-inflated, latency-omitting,
 *     failure-hiding, estimate-conflating and re-measured shapes).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  ADJUSTED_TASKS,
  runAdjustedApp,
} from "../../../benchmarks/validation/apps/economic-adjusted-cost/application";
import {
  ADJUSTED_CORPUS,
  ADJUSTED_ROW_IDS,
  ADJUSTED_TASK_KIND,
  adjustedRowById,
  honestInputsOf,
  minimumSamplesOf,
} from "../../../benchmarks/validation/apps/economic-adjusted-cost/corpus";
import {
  deriveEstimateMeasureSeparation,
  deriveFailureAdjustmentCompleteness,
  deriveInputIntegrity,
  deriveLatencyAdjustmentInclusion,
  deriveQualityAdjustmentHonesty,
  liveArmDigestOf,
  recordedArmFactsOf,
} from "../../../benchmarks/validation/apps/economic-adjusted-cost/driver";
import {
  applyAdversarialVariant,
  createAdjustedFakeApiWorld,
  createTickClock,
  honestInputsOf as fixturesHonestInputsOf,
  inputsForRow,
} from "../../../benchmarks/validation/apps/economic-adjusted-cost/fixtures";
import { manifestRevisionOf } from "../../../benchmarks/validation/apps/economic-baseline/pricing";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { TransportImplementation } from "../../../benchmarks/validation/harness/harness";

const baseConfig = {
  applicationId: "app-1",
  baseUrl: "http://fake.local",
  tokenEnvVar: "ZECK_VALIDATION_TOKEN",
  applicationRevision: "test",
  corpusRevision: "test",
  integrationSurface: "synthesis:recorded-arm-corpora",
  pollIntervalMs: 1,
  completionTimeoutMs: 60_000,
};

/** Run the app over the fake world with optional discrimination knobs. */
async function runAppOverFakeWorld(options: {
  readonly taskIndex: number;
  readonly terminal?: "COMPLETED" | "FAILED";
  readonly verificationStatuses?: readonly string[];
  readonly fabricatePassWithFail?: boolean;
  readonly transport?: TransportImplementation;
}): Promise<{
  readonly outcome: Awaited<ReturnType<typeof runAdjustedApp>>;
  readonly createdExecutions: number;
}> {
  const clock = createTickClock();
  const world = createAdjustedFakeApiWorld({
    clock,
    ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    ...(options.verificationStatuses === undefined
      ? {}
      : { verificationStatuses: options.verificationStatuses }),
    ...(options.fabricatePassWithFail === undefined
      ? {}
      : { fabricatePassWithFail: options.fabricatePassWithFail }),
  });
  const outcome = await runAdjustedApp({
    config: baseConfig,
    token: "test-token",
    transport: options.transport ?? world.transport,
    now: clock.now,
    sleep: async () => {},
    environment: {
      runtime: "node test",
      toolchain: "vitest",
      database: "none",
      configuration: { suite: "val-044-apps" },
    },
    runSuffix: "unit",
    taskIndex: options.taskIndex,
  });
  return { outcome, createdExecutions: world.createdExecutions };
}

/** The task index of one corpus row. */
function taskIndexOf(rowId: string): number {
  const index = ADJUSTED_CORPUS.findIndex((row) => row.rowId === rowId);
  if (index < 0) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return index;
}

// ---------------------------------------------------------------------------
// The pinned task slice ↔ corpus ↔ config.json consistency
// ---------------------------------------------------------------------------

describe("VAL-044 app task-slice consistency", () => {
  test("the exported task slice mirrors the corpus exactly", () => {
    expect(ADJUSTED_TASKS.length).toBe(ADJUSTED_CORPUS.length);
    for (const [index, task] of ADJUSTED_TASKS.entries()) {
      const row = ADJUSTED_CORPUS[index];
      expect(task.rowId).toBe(row?.rowId);
      expect(task.kind).toBe(ADJUSTED_TASK_KIND);
      expect(task.expectedTerminal).toBe(row?.expected.terminal);
      expect(task.family).toBe(row?.family);
      expect(task.expectedVerdict).toBe(row?.expected.verdict);
      expect(task.minimumInputs).toBe(row?.minimumInputs);
      expect(task.minimumSamplesPerInput).toBe(row?.minimumSamplesPerInput);
      expect(task.armSetSize).toBe(row?.armSet.length);
      const asPinned = task as {
        latencyBudgetMs?: number;
        adversarial?: string;
        liveGate?: readonly string[];
      };
      if (row?.latencyBudgetMs === undefined) {
        expect(asPinned.latencyBudgetMs).toBeUndefined();
      } else {
        expect(asPinned.latencyBudgetMs).toBe(row.latencyBudgetMs);
      }
      if (row?.adversarial === undefined) {
        expect(asPinned.adversarial).toBeUndefined();
      } else {
        expect(asPinned.adversarial).toBe(row.adversarial);
      }
      if (row?.liveGate === undefined) {
        expect(asPinned.liveGate).toBeUndefined();
      } else {
        expect(asPinned.liveGate).toEqual(row.liveGate.envVars);
      }
      expect(task.appCreated).toBe(row?.expected.appCreated);
      expect(task.replayedSubmissions).toBe(row?.expected.replayedSubmissions);
      expect(task.rejectedSubmissions).toBe(row?.expected.rejectedSubmissions);
    }
  });

  test("config.json mirrors the exported task slice", async () => {
    const raw = await readFile(
      join("benchmarks", "validation", "apps", "economic-adjusted-cost", "config.json"),
      "utf8",
    );
    const config = JSON.parse(raw) as {
      readonly integrationSurface: string;
      readonly tokenEnvVar: string;
      readonly tasks: readonly Record<string, unknown>[];
    };
    expect(config.tasks.length).toBe(ADJUSTED_TASKS.length);
    expect(config.tokenEnvVar).toBe("ZECK_VALIDATION_TOKEN");
    expect(config.integrationSurface).toBe("synthesis:recorded-arm-corpora");
    for (const [index, task] of config.tasks.entries()) {
      expect(task.rowId).toBe(ADJUSTED_TASKS[index]?.rowId);
      expect(task.kind).toBe(ADJUSTED_TASK_KIND);
      expect(task.expectedTerminal).toBe(ADJUSTED_TASKS[index]?.expectedTerminal);
      expect(task.family).toBe(ADJUSTED_TASKS[index]?.family);
      expect(task.expectedVerdict).toBe(ADJUSTED_TASKS[index]?.expectedVerdict);
      expect(task.minimumSamplesPerInput).toBe(ADJUSTED_TASKS[index]?.minimumSamplesPerInput);
      expect(task.armSetSize).toBe(ADJUSTED_TASKS[index]?.armSetSize);
    }
  });

  test("config.json is secret-free", async () => {
    const raw = await readFile(
      join("benchmarks", "validation", "apps", "economic-adjusted-cost", "config.json"),
      "utf8",
    );
    // The env-var NAME rides the live row's gate (never a secret
    // VALUE); no credential VALUE may appear anywhere.
    expect(raw).not.toContain("sk-");
    expect(raw).not.toMatch(/"(apiKey|api_key|password|secret)"\s*:/i);
  });
});

// ---------------------------------------------------------------------------
// The corpus well-formedness
// ---------------------------------------------------------------------------

describe("VAL-044 corpus well-formedness", () => {
  test("the row ids are unique and the row lookup agrees", () => {
    expect(new Set(ADJUSTED_ROW_IDS).size).toBe(ADJUSTED_ROW_IDS.length);
    for (const rowId of ADJUSTED_ROW_IDS) {
      expect(adjustedRowById(rowId)?.rowId).toBe(rowId);
    }
    expect(adjustedRowById("no-such-row")).toBeNull();
  });

  test("every digest reference resolves in the RECORDED arm corpora and re-derives exactly", () => {
    for (const row of ADJUSTED_CORPUS) {
      expect(row.armSet.length).toBeGreaterThan(0);
      for (const reference of row.armSet) {
        const resolved = recordedArmFactsOf(reference);
        expect(resolved).not.toBeNull();
        if (row.needsDispatch) {
          // The live row references the arms' LIVE rows: the digest is
          // the arm-declaration digest (never an outcome copy).
          const live = resolved?.row as {
            readonly arm: { readonly armId: string; readonly corpusSlice: readonly string[] };
          };
          expect(reference.recordedDigest).toBe(
            liveArmDigestOf({
              armLabel: reference.armLabel,
              corpusRowId: reference.corpusRowId,
              armId: live.arm.armId,
              sliceSize: live.arm.corpusSlice.length,
            }),
          );
        } else {
          expect(resolved?.facts).toBeDefined();
          const integrity = deriveInputIntegrity({
            inputs: [{ ...reference, recorded: resolved?.facts as never }],
          });
          expect(integrity.conformant).toBe(true);
        }
      }
    }
  });

  test("every offline honest row's arm set covers all three recorded control arms", () => {
    for (const row of ADJUSTED_CORPUS.filter(
      (candidate) => !candidate.needsDispatch && candidate.adversarial === undefined,
    )) {
      const labels = new Set(row.armSet.map((reference) => reference.armLabel));
      expect(labels).toEqual(new Set(["direct", "optimized", "competing"]));
    }
  });

  test("every input's pinned price revision is known in the manifest registry", () => {
    for (const row of ADJUSTED_CORPUS) {
      for (const reference of row.armSet) {
        const manifest = manifestRevisionOf(reference.priceRevision);
        expect(manifest).not.toBeNull();
      }
    }
  });

  test("the honest rows carry pinned syntheses; the probes declare adversarial variants", () => {
    for (const row of ADJUSTED_CORPUS) {
      if (row.needsDispatch) {
        expect(row.expected.synthesis).toBeUndefined();
        expect(row.liveGate?.envVars).toContain("OPENROUTER_API_KEY");
      } else if (row.adversarial === undefined) {
        expect(row.expected.synthesis).toBeDefined();
        expect(row.expected.terminal).toBe("COMPLETED");
      } else {
        expect(row.adversarial.length).toBeGreaterThan(0);
        expect(row.expected.terminal).toBe("FAILED");
        expect(row.expected.synthesis).toBeUndefined();
      }
    }
  });

  test("the per-arm minimums agree with the referenced arms' own declared minimums", () => {
    for (const row of ADJUSTED_CORPUS.filter(
      (candidate) =>
        candidate.rowId !== "quality-adjusted-below-minimum-honest-refusal" &&
        candidate.rowId !== "probe-below-minimum-comparability-claim" &&
        !candidate.needsDispatch,
    )) {
      expect(row.minimumSamplesPerInput).toBe(minimumSamplesOf(row.armSet));
      expect(row.minimumInputs).toBe(row.armSet.length);
    }
  });

  test("the honest fixture inputs equal the corpus's own honest input resolution", () => {
    for (const row of ADJUSTED_CORPUS.filter((candidate) => !candidate.needsDispatch)) {
      const fromCorpus = honestInputsOf(row.armSet);
      const fromFixtures = fixturesHonestInputsOf(row.armSet);
      expect(fromFixtures.length).toBe(fromCorpus.length);
      for (const [index, input] of fromFixtures.entries()) {
        expect(input.recordedDigest).toBe(fromCorpus[index]?.recordedDigest);
        expect(input.recorded.measuredCostMicroUsd).toBe(
          fromCorpus[index]?.recorded.measuredCostMicroUsd,
        );
      }
    }
  });

  test("the live row is honestly NOT RUN without the credential", async () => {
    const live = ADJUSTED_CORPUS.filter((row) => row.needsDispatch);
    expect(live.length).toBe(1);
    const row = live[0];
    expect(row?.liveGate?.envVars).toEqual(["OPENROUTER_API_KEY"]);
    expect(row?.liveGate?.requirement).toContain("operator-authorized");
    expect(row?.armSet.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// The app over the honest fake world
// ---------------------------------------------------------------------------

describe("VAL-044 app over the honest fake world", () => {
  test("every row's submission lands ONE durable execution with valid evidence", async () => {
    for (const [index] of ADJUSTED_CORPUS.entries()) {
      const { outcome, createdExecutions } = await runAppOverFakeWorld({ taskIndex: index });
      expect(createdExecutions).toBe(1);
      expect(outcome.observedTerminal).toBe(ADJUSTED_CORPUS[index]?.expected.terminal);
      expect(outcome.passed).toBe(true);
      const violations = validateHarnessEvidence(outcome.evidence);
      expect(violations).toEqual([]);
      expect(outcome.submissionLatencyMs.length).toBe(1);
      expect(outcome.submissionLatencyMs[0]).toBeGreaterThanOrEqual(0);
    }
  });

  test("the honest verdict rows settle COMPLETED with all-PASS statuses (all three verdict kinds)", async () => {
    for (const rowId of [
      "quality-adjusted-three-arm-synthesis",
      "quality-adjusted-null-attainment-incomparable",
      "quality-adjusted-below-minimum-honest-refusal",
    ]) {
      const index = taskIndexOf(rowId);
      const { outcome } = await runAppOverFakeWorld({ taskIndex: index });
      expect(outcome.observedTerminal).toBe("COMPLETED");
      expect(outcome.verificationStatuses.every((status) => status === "PASS")).toBe(true);
      for (const criterion of outcome.adjustedCriteria) {
        expect(criterion.status).toBe("PASS");
      }
    }
  });

  test("the probe rows settle FAILED honestly (the failure is the verified outcome)", async () => {
    const index = taskIndexOf("probe-quality-inflated-denominator");
    const { outcome } = await runAppOverFakeWorld({ taskIndex: index });
    expect(outcome.observedTerminal).toBe("FAILED");
    expect(outcome.verificationStatuses).toContain("FAIL");
    expect(outcome.passed).toBe(true);
  });

  test("a same-key re-submission replays the committed receipt (no second execution)", async () => {
    const clock = createTickClock();
    const world = createAdjustedFakeApiWorld({ clock });
    const run = async () =>
      runAdjustedApp({
        config: baseConfig,
        token: "test-token",
        transport: world.transport,
        now: clock.now,
        sleep: async () => {},
        environment: {
          runtime: "node test",
          toolchain: "vitest",
          database: "none",
          configuration: { suite: "val-044-apps" },
        },
        runSuffix: "unit",
        taskIndex: 0,
      });
    const first = await run();
    const second = await run();
    expect(world.createdExecutions).toBe(1);
    expect(first.passed).toBe(true);
    expect(second.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The customer-boundary discriminations
// ---------------------------------------------------------------------------

describe("VAL-044 app customer-boundary discriminations", () => {
  test("a FABRICATED pass-with-fail FAILs the app honestly (anyFail→FAILED at the boundary)", async () => {
    const index = taskIndexOf("probe-estimate-conflation");
    const { outcome } = await runAppOverFakeWorld({
      taskIndex: index,
      fabricatePassWithFail: true,
    });
    expect(outcome.observedTerminal).toBe("COMPLETED");
    expect(outcome.verificationStatuses).toContain("FAIL");
    expect(outcome.passed).toBe(false);
    const agreement = outcome.adjustedCriteria.find(
      (criterion) => criterion.criterionId === "app-terminal-criteria-agreement",
    );
    expect(agreement?.status).toBe("FAIL");
  });

  test("a terminal override FAILs every mismatched row", async () => {
    const index = taskIndexOf("quality-adjusted-three-arm-synthesis");
    const { outcome } = await runAppOverFakeWorld({ taskIndex: index, terminal: "FAILED" });
    expect(outcome.observedTerminal).toBe("FAILED");
    expect(outcome.passed).toBe(false);
    const expected = outcome.adjustedCriteria.find(
      (criterion) => criterion.criterionId === "app-expected-terminal",
    );
    expect(expected?.status).toBe("FAIL");
  });

  test("a fabricated all-PASS status list over a FAILED-expected row FAILs the agreement", async () => {
    const index = taskIndexOf("probe-failure-hiding");
    const { outcome } = await runAppOverFakeWorld({
      taskIndex: index,
      terminal: "FAILED",
      verificationStatuses: ["PASS", "PASS"],
    });
    expect(outcome.passed).toBe(false);
    const agreement = outcome.adjustedCriteria.find(
      (criterion) => criterion.criterionId === "app-terminal-criteria-agreement",
    );
    expect(agreement?.status).toBe("FAIL");
  });

  test("a submission that never lands FAILs honestly (never a fabricated completion)", async () => {
    const rejectingTransport: TransportImplementation = async () =>
      new Response(JSON.stringify({ code: "CAPABILITY_UNAVAILABLE", retryable: false }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    const { outcome, createdExecutions } = await runAppOverFakeWorld({
      taskIndex: 0,
      transport: rejectingTransport,
    });
    expect(createdExecutions).toBe(0);
    expect(outcome.observedTerminal).toBeNull();
    expect(outcome.passed).toBe(false);
    expect(outcome.adjustedCriteria[0]?.criterionId).toBe("submission-landed");
    expect(outcome.adjustedCriteria[0]?.status).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// Each fixture variant FAILs its specific criterion (the pure oracles)
// ---------------------------------------------------------------------------

describe("VAL-044 fixture variants (each denatured shape FAILs its specific criterion)", () => {
  const headlineRow = adjustedRowById("quality-adjusted-three-arm-synthesis");
  const latencyRow = adjustedRowById("latency-adjusted-three-arm-synthesis");
  const honest = honestInputsOf(headlineRow?.armSet ?? []);

  test("the QUALITY-INFLATED variant FAILs the quality-adjustment-honesty oracle", () => {
    const quality = deriveQualityAdjustmentHonesty({
      inputs: applyAdversarialVariant(honest, { qualityInflation: true }),
    });
    expect(quality.conformant).toBe(false);
    expect(quality.evidence.join(" ")).toContain("QUALITY-INFLATED DENOMINATOR");
    const honestQuality = deriveQualityAdjustmentHonesty({ inputs: honest });
    expect(honestQuality.conformant).toBe(true);
  });

  test("the LATENCY-OMITTING variant FAILs the latency-adjustment-inclusion oracle", () => {
    const latency = deriveLatencyAdjustmentInclusion({
      inputs: applyAdversarialVariant(honest, { latencyOmission: true }),
      budgetMs: latencyRow?.latencyBudgetMs ?? 1000,
    });
    expect(latency.conformant).toBe(false);
    expect(latency.evidence.join(" ")).toContain("LATENCY-OMITTING COMPARISON");
    const honestLatency = deriveLatencyAdjustmentInclusion({
      inputs: honest,
      budgetMs: latencyRow?.latencyBudgetMs ?? 1000,
    });
    expect(honestLatency.conformant).toBe(true);
  });

  test("the FAILURE-HIDING variant FAILs the failure-adjustment-completeness oracle", () => {
    const failure = deriveFailureAdjustmentCompleteness({
      inputs: applyAdversarialVariant(honest, { failureHiding: true }),
    });
    expect(failure.conformant).toBe(false);
    expect(failure.evidence.join(" ")).toContain("FAILURE-HIDING COMPARISON");
    const honestFailure = deriveFailureAdjustmentCompleteness({ inputs: honest });
    expect(honestFailure.conformant).toBe(true);
  });

  test("the ESTIMATE-CONFLATING variant FAILs the estimate-measure-separation oracle", () => {
    const separation = deriveEstimateMeasureSeparation({
      inputs: applyAdversarialVariant(honest, { estimateConflation: true }),
    });
    expect(separation.conformant).toBe(false);
    expect(separation.evidence.join(" ")).toContain("ESTIMATE-CONFLATION");
    const honestSeparation = deriveEstimateMeasureSeparation({ inputs: honest });
    expect(honestSeparation.conformant).toBe(true);
  });

  test("the RE-MEASURED variant FAILs the input-integrity oracle (masquerade named)", () => {
    const integrity = deriveInputIntegrity({
      inputs: applyAdversarialVariant(honest, { remeasurement: true }),
    });
    expect(integrity.conformant).toBe(false);
    expect(integrity.evidence.join(" ")).toContain("RE-MEASUREMENT MASQUERADE");
    const honestIntegrity = deriveInputIntegrity({ inputs: honest });
    expect(honestIntegrity.conformant).toBe(true);
  });

  test("each PROBE row's declared variant reproduces through inputsForRow (the row-level catch)", () => {
    const expectations: Record<string, string> = {
      "probe-quality-inflated-denominator": "quality-adjustment-honesty",
      "probe-latency-omission": "latency-adjustment-inclusion",
      "probe-failure-hiding": "failure-adjustment-completeness",
      "probe-estimate-conflation": "estimate-measure-separation",
      "probe-remeasurement-masquerade": "input-integrity-digest-verified",
      "probe-below-minimum-comparability-claim": "below-minimum-refusal-honesty",
    };
    for (const [rowId] of Object.entries(expectations)) {
      const row = adjustedRowById(rowId);
      if (row === null) {
        throw new Error(`missing probe row ${rowId}`);
      }
      const inputs = inputsForRow(row);
      // The honest bundle is denatured exactly as the row declares.
      const integrity = deriveInputIntegrity({ inputs });
      expect(integrity.verdicts.length).toBe(row.armSet.length);
    }
  });
});
