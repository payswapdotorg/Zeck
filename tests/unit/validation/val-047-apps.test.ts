/**
 * VAL-047 acceptance criteria 1, 2 and 5 (the app + the corpus's
 * well-formedness): the longitudinal cost-curve application on the
 * public SDK boundary, the corpus's digest/revision/window consistency,
 * the live gating and the customer-boundary discriminations.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { manifestRevisionOf } from "../../../benchmarks/validation/apps/economic-baseline/pricing";
import { runCurveApp } from "../../../benchmarks/validation/apps/economic-longitudinal-curve/application";
import {
  CURVE_CORPUS,
  CURVE_ROW_IDS,
  CURVE_TASK_KIND,
  curveAttributionResultOf,
  curveLedgerById,
  curveRowById,
  liveGateOpen,
  taskBodyFor,
} from "../../../benchmarks/validation/apps/economic-longitudinal-curve/corpus";
import type { CurveCorpusRow } from "../../../benchmarks/validation/apps/economic-longitudinal-curve/driver";
import {
  deriveCurveFamilySynthesis,
  driveCurveRow,
  liveCurvePlanDigestOf,
  recordedCurvePointDigestOf,
} from "../../../benchmarks/validation/apps/economic-longitudinal-curve/driver";
import {
  createCurveFakeApiWorld,
  createFakeLedger,
  createFakeLifecycle,
  createFakeSubmissionSeam,
  createRealAccountingRails,
  createTickClock,
  curveInputsForRow,
  honestCurveInputsOf,
} from "../../../benchmarks/validation/apps/economic-longitudinal-curve/fixtures";
import { deriveSubstrateManifestIntegrity } from "../../../benchmarks/validation/apps/economic-substrate-runtime/pricing";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { TransportImplementation } from "../../../benchmarks/validation/harness/harness";
import type { RunMetadata } from "../../../benchmarks/validation/run-identity";

const REVISION = "7c31a09be1d4c05e3f6a2b8d9e0c1a2b3c4d5e6f";

const baseConfig = {
  applicationId: "app-1",
  baseUrl: "https://fake.example.test",
  tokenEnvVar: "ZECK_VALIDATION_TOKEN",
  applicationRevision: REVISION,
  corpusRevision: REVISION,
  integrationSurface: "curve:recorded-longitudinal-history",
  pollIntervalMs: 10,
  completionTimeoutMs: 5_000,
};

const metadataOf = (observedAt: string): RunMetadata => ({
  program: "zeck-validation",
  workOrder: "VAL-047",
  baseRevision: REVISION,
  applicationRevision: REVISION,
  corpusRevision: "val-047-longitudinal-curve-v1",
  integrationSurface: "curve:recorded-longitudinal-history",
  environment: {
    runtime: "node test",
    toolchain: "vitest",
    database: "none",
    configuration: { suite: "val-047-apps" },
  },
  observedAt,
});

const rowById = (rowId: string): CurveCorpusRow => {
  const row = curveRowById(rowId);
  if (row === null) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

const taskIndexOf = (rowId: string): number => {
  const index = CURVE_CORPUS.findIndex((candidate) => candidate.rowId === rowId);
  if (index < 0) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return index;
};

/** Run the app over the fake API world (the transport-level fake). */
async function runAppOverFakeWorld(options: {
  readonly taskIndex: number;
  readonly clock?: ReturnType<typeof createTickClock>;
  readonly terminal?: "COMPLETED" | "FAILED";
  readonly verificationStatuses?: readonly string[];
  readonly fabricatePassWithFail?: boolean;
  readonly transport?: TransportImplementation;
}) {
  const clock = options.clock ?? createTickClock();
  const world = createCurveFakeApiWorld({
    clock,
    ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    ...(options.verificationStatuses === undefined
      ? {}
      : { verificationStatuses: options.verificationStatuses }),
    ...(options.fabricatePassWithFail === undefined
      ? {}
      : { fabricatePassWithFail: options.fabricatePassWithFail }),
  });
  const outcome = await runCurveApp({
    config: baseConfig,
    token: "test-token",
    transport: options.transport ?? world.transport,
    now: clock.now,
    sleep: async () => {},
    environment: {
      runtime: "node test",
      toolchain: "vitest",
      database: "none",
      configuration: { suite: "val-047-apps" },
    },
    runSuffix: "unit",
    taskIndex: options.taskIndex,
  });
  return { outcome, createdExecutions: world.createdExecutions };
}

// ---------------------------------------------------------------------------
// The corpus + the configuration (consistency)
// ---------------------------------------------------------------------------

describe("VAL-047 corpus + configuration consistency", () => {
  const configPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../benchmarks/validation/apps/economic-longitudinal-curve/config.json",
  );
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    tasks: { rowId: string; kind: string }[];
  };

  test("config.json mirrors the exported task slice exactly", () => {
    expect(config.tasks.map((task) => task.rowId)).toEqual([...CURVE_ROW_IDS]);
    for (const task of config.tasks) {
      expect(task.kind).toBe(CURVE_TASK_KIND);
    }
  });

  test("every row id is unique", () => {
    expect(new Set(CURVE_ROW_IDS).size).toBe(CURVE_ROW_IDS.length);
  });

  test("every honest row's declared window matches its ledger's recorded span", () => {
    for (const row of CURVE_CORPUS) {
      const ledger = curveLedgerById(row.workloadClass);
      if (ledger === null || row.needsDispatch) {
        continue;
      }
      const sorted = [...ledger.points].sort((left, right) => left.generation - right.generation);
      const from = sorted[0]?.generation ?? 0;
      const to = sorted[sorted.length - 1]?.generation ?? 0;
      if (row.adversarial === "cherry-picked-window" || row.adversarial === "extrapolating") {
        // The probe rows honestly declare their denatured windows.
        continue;
      }
      expect(row.declaredWindow.fromGeneration, row.rowId).toBe(from);
      expect(row.declaredWindow.toGeneration, row.rowId).toBe(to);
      expect(row.pointSet.length, row.rowId).toBe(to - from + 1);
    }
  });

  test("every point digest reference resolves and re-derives identically (the extrapolating probe's fabricated point excepted)", () => {
    for (const row of CURVE_CORPUS) {
      for (const reference of row.pointSet) {
        if (reference.live === true) {
          expect(reference.recordedDigest).toBe(liveCurvePlanDigestOf());
          continue;
        }
        const ledger = curveLedgerById(reference.workloadClass);
        const point = ledger?.points.find(
          (candidate) => candidate.generation === reference.generation,
        );
        if (point === undefined) {
          // Only the extrapolating probe's fabricated generation-4
          // reference may sit beyond the recorded evidence.
          expect(row.adversarial).toBe("extrapolating");
          expect(reference.generation).toBe(4);
          continue;
        }
        expect(reference.modelPriceRevision, row.rowId).toBe(point.modelPriceRevision);
        expect(reference.substratePriceRevision, row.rowId).toBe(point.substratePriceRevision);
        expect(reference.recordedDigest, row.rowId).toMatch(/^[0-9a-f]{8}$/);
        expect(reference.recordedDigest, row.rowId).toBe(recordedCurvePointDigestOf(point));
      }
    }
  });

  test("every pinned price revision is known in the VAL-040 + VAL-046 manifests", () => {
    for (const row of CURVE_CORPUS) {
      for (const reference of row.pointSet) {
        expect(manifestRevisionOf(reference.modelPriceRevision), row.rowId).not.toBeNull();
        expect(
          deriveSubstrateManifestIntegrity({ revision: reference.substratePriceRevision }).agreed,
          row.rowId,
        ).toBe(true);
      }
    }
    for (const ledger of curveLedgerById("invoice-extraction")
      ? [curveLedgerById("invoice-extraction")]
      : []) {
      for (const point of ledger?.points ?? []) {
        expect(manifestRevisionOf(point.modelPriceRevision)).not.toBeNull();
      }
    }
  });

  test("the honest rows carry pinned curve outcomes; the probes declare adversarial variants", () => {
    for (const row of CURVE_CORPUS) {
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

  test("the pinned syntheses re-derive identically through the REAL derivations", () => {
    for (const row of CURVE_CORPUS) {
      if (row.expected.synthesis === undefined) {
        continue;
      }
      const inputs = curveInputsForRow(row);
      const family = deriveCurveFamilySynthesis({
        row,
        points: inputs.points,
        attribution: inputs.attribution,
      });
      expect(family.synthesis?.verdict, row.rowId).toBe(row.expected.synthesis?.verdict);
      expect(family.synthesis?.perPointCostPerOutcomeMicroUsd.join(","), row.rowId).toBe(
        row.expected.synthesis?.perPointCostPerOutcomeMicroUsd.join(","),
      );
    }
  });

  test("the live gating: the live row is NOT RUN without the credential", () => {
    const live = CURVE_CORPUS.filter((row) => row.needsDispatch);
    expect(live).toHaveLength(1);
    const row = live[0];
    expect(row).toBeDefined();
    if (row === undefined) {
      return;
    }
    expect(liveGateOpen(row, {})).toBe(false);
    expect(liveGateOpen(row, { OPENROUTER_API_KEY: "" })).toBe(false);
    expect(liveGateOpen(row, { OPENROUTER_API_KEY: "operator-credential" })).toBe(true);
  });

  test("the recorded attribution results reconcile with the imported VAL-045 economics", () => {
    const rag1 = curveAttributionResultOf("rag-retrieval", 1);
    expect(rag1.attributedMicroUsd.deterministicization).toBe(120);
    expect(rag1.attributedMicroUsd.reuse).toBe(30);
    expect(rag1.residualMicroUsd).toBe(30);
    expect(rag1.ledgerEntryDigests).toHaveLength(2);
    const tool1 = curveAttributionResultOf("tool-routing", 1);
    expect(tool1.attributedMicroUsd.reuse).toBe(0);
    expect(tool1.residualMicroUsd).toBe(0);
    expect(tool1.ledgerEntryDigests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The app over the honest fake world
// ---------------------------------------------------------------------------

describe("VAL-047 the app over the honest fake world", () => {
  test("every offline row lands ONE durable execution and settles its honest terminal", async () => {
    for (const [index, row] of CURVE_CORPUS.filter(
      (candidate) => !candidate.needsDispatch,
    ).entries()) {
      const { outcome, createdExecutions } = await runAppOverFakeWorld({ taskIndex: index });
      expect(outcome.observedTerminal, row.rowId).toBe(row.expected.terminal);
      expect(outcome.passed, row.rowId).toBe(true);
      expect(createdExecutions, row.rowId).toBe(1);
      expect(outcome.submissionLatencyMs, row.rowId).toHaveLength(1);
      const evidenceViolations = validateHarnessEvidence(outcome.evidence);
      expect(evidenceViolations, row.rowId).toEqual([]);
    }
  });

  test("the app's task bodies carry references only (never a price, never a result copy)", () => {
    for (const row of CURVE_CORPUS) {
      const body = taskBodyFor({ row });
      expect(body.kind).toBe(CURVE_TASK_KIND);
      expect(body.rowId).toBe(row.rowId);
      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/microUsd|amount|token[s]?[:"]/);
      expect((body.preRegisteredPointSet as unknown[]).length).toBe(row.pointSet.length);
    }
  });
});

// ---------------------------------------------------------------------------
// The customer-boundary discriminations
// ---------------------------------------------------------------------------

describe("VAL-047 customer-boundary discriminations", () => {
  test("a fabricated pass-with-fail FAILs the app contract (the anyFail→FAILED invariant)", async () => {
    const probeIndex = taskIndexOf("probe-residual-hiding");
    const { outcome } = await runAppOverFakeWorld({
      taskIndex: probeIndex,
      fabricatePassWithFail: true,
    });
    expect(outcome.observedTerminal).toBe("COMPLETED");
    expect(outcome.verificationStatuses).toContain("FAIL");
    expect(outcome.passed).toBe(false);
    const agreement = outcome.curveCriteria.find(
      (criterion) => criterion.criterionId === "app-terminal-criteria-agreement",
    );
    expect(agreement?.status).toBe("FAIL");
  });

  test("a terminal override FAILs the expected-terminal criterion", async () => {
    const honestIndex = taskIndexOf("invoice-extraction-cost-per-outcome-trajectory");
    const { outcome } = await runAppOverFakeWorld({
      taskIndex: honestIndex,
      terminal: "FAILED",
    });
    expect(outcome.observedTerminal).toBe("FAILED");
    expect(outcome.passed).toBe(false);
    const expected = outcome.curveCriteria.find(
      (criterion) => criterion.criterionId === "app-expected-terminal",
    );
    expect(expected?.status).toBe("FAIL");
  });

  test("a fabricated all-PASS result on a FAILED-expected row FAILs the app contract", async () => {
    const probeIndex = taskIndexOf("probe-cohort-hiding");
    const { outcome } = await runAppOverFakeWorld({
      taskIndex: probeIndex,
      terminal: "COMPLETED",
      verificationStatuses: ["PASS", "PASS"],
    });
    expect(outcome.observedTerminal).toBe("COMPLETED");
    expect(outcome.passed).toBe(false);
  });

  test("a rejected submission FAILs honestly with no fabricated completion", async () => {
    const rejectingTransport: TransportImplementation = async () =>
      new Response(JSON.stringify({ code: "CAPABILITY_UNAVAILABLE", retryable: false }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      });
    const { outcome, createdExecutions } = await runAppOverFakeWorld({
      taskIndex: 0,
      transport: rejectingTransport,
    });
    expect(createdExecutions).toBe(0);
    expect(outcome.observedTerminal).toBeNull();
    expect(outcome.passed).toBe(false);
    expect(outcome.curveCriteria[0]?.criterionId).toBe("submission-landed");
    expect(outcome.curveCriteria[0]?.status).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// Each fixture variant FAILs its specific criterion (the driver over the knobs)
// ---------------------------------------------------------------------------

describe("VAL-047 each fixture variant FAILs its specific criterion", () => {
  /** Drive one row over the honest stack with optional input overrides. */
  async function driveRow(row: CurveCorpusRow) {
    const clock = createTickClock();
    const ledger = createFakeLedger(clock);
    const seam = createFakeSubmissionSeam({ ledger });
    const lifecycle = createFakeLifecycle({ ledger });
    const honest = honestCurveInputsOf(row);
    const baseline = ledger.facts();
    const submission = await seam({
      key: `val-047-apps-${row.rowId}`,
      body: taskBodyFor({ row }),
    });
    const inputs = curveInputsForRow(row);
    return driveCurveRow({
      row,
      lifecycle,
      points: inputs.points,
      attribution: inputs.attribution,
      recordedLedger: honest.recordedLedger,
      recordedAttribution: honest.recordedAttribution,
      rails: createRealAccountingRails(),
      metadata: metadataOf(clock.now().toISOString()),
      environmentIdentity: `val-047-apps-${row.rowId}`,
      baseline,
      worldFacts: ledger.facts,
      landedProvider: async () => [submission.executionId],
      now: clock.now,
    });
  }

  test("the honest fixture inputs equal the corpus's own honest resolution", () => {
    for (const row of CURVE_CORPUS.filter(
      (candidate) =>
        !candidate.needsDispatch &&
        candidate.adversarial !== "extrapolating" &&
        candidate.adversarial !== "post-hoc-exclusion" &&
        candidate.adversarial !== "remeasurement" &&
        candidate.adversarial !== "regime-normalizing" &&
        candidate.adversarial !== "residual-hiding",
    )) {
      const fromFixtures = curveInputsForRow(row);
      const fromCorpus = honestCurveInputsOf(row);
      expect(fromFixtures.points.length, row.rowId).toBe(fromCorpus.points.length);
      for (const [index, point] of fromFixtures.points.entries()) {
        expect(point.recordedDigest, row.rowId).toBe(fromCorpus.points[index]?.recordedDigest);
        expect(point.facts.measuredModelCostMicroUsd, row.rowId).toBe(
          fromCorpus.points[index]?.facts.measuredModelCostMicroUsd,
        );
      }
    }
  });

  test.each([
    ["probe-cherry-picked-window", "window-honesty"],
    ["probe-regime-normalizing", "price-regime-marking"],
    ["probe-extrapolating", "no-extrapolation"],
    ["probe-residual-hiding", "improvement-rate-reconciliation"],
    ["probe-cohort-hiding", "cohort-honesty"],
    ["probe-post-hoc-exclusion", "confidence-and-minimum"],
    ["probe-sample-size-violation", "below-minimum-refusal-honesty"],
    ["probe-remeasurement-masquerade", "curve-input-integrity"],
  ])("%s drives to FAILED with its named criterion FAILing", async (rowId, criterionId) => {
    const result = await driveRow(rowById(rowId));
    expect(result.terminal).toBe("FAILED");
    const criterion = result.criteria.find((entry) => entry.criterionId === criterionId);
    expect(criterion?.status).toBe("FAIL");
  });

  test("the honest rows drive to COMPLETED over the fake stack (the app's own basis)", async () => {
    for (const rowId of [
      "invoice-extraction-cost-per-outcome-trajectory",
      "code-search-plateau-maturity-verdict",
      "tool-routing-never-materialized",
      "rag-retrieval-improvement-rate-decomposition",
    ]) {
      const result = await driveRow(rowById(rowId));
      expect(result.terminal, rowId).toBe("COMPLETED");
      expect(
        result.criteria.filter((criterion) => criterion.status === "FAIL"),
        rowId,
      ).toEqual([]);
    }
  });
});
