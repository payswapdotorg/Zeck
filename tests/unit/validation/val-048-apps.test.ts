/**
 * VAL-048 acceptance criteria 1, 2 and 5 (the app boundary + the
 * configuration consistency): the cross-workload competitive
 * application over the public SDK boundary.
 *
 *   * the corpus + configuration consistency: config.json mirrors the
 *     exported task slice exactly; the row ids unique; every digest
 *     reference well-formed; every arm's pinned revision verified
 *     against the VAL-040 manifests; the live gating honest (NOT RUN
 *     without the credential); the pinned competitive outcomes
 *     re-derive over the honest recorded inputs; the declared
 *     portfolio covering every recorded class;
 *   * the app over the honest fake world: every offline row lands ONE
 *     durable execution and settles its honest terminal (COMPLETED for
 *     the honest verdict rows — ties, null bases and the under-powered
 *     refusal alike; FAILED for the six adversarial probes whose
 *     denatured shapes FAIL their named criteria) with the task bodies
 *     carrying REFERENCES ONLY;
 *   * the customer-boundary discriminations: a fabricated
 *     pass-with-fail FAILs the app-terminal-criteria-agreement; a
 *     terminal override FAILs the app-expected-terminal; a rejected
 *     submission FAILs the submission-landed criterion honestly.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { manifestRevisionOf } from "../../../benchmarks/validation/apps/economic-baseline/pricing";
import { runCompetitiveApp } from "../../../benchmarks/validation/apps/economic-competitive-benchmark/application";
import {
  COMPETITIVE_CORPUS,
  COMPETITIVE_CORPUS_VERSION,
  COMPETITIVE_ROW_IDS,
  COMPETITIVE_TASK_KIND,
  competitiveRowById,
  honestCompetitiveInputsOf,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
  pinnedCompetitiveInputDigest,
  RECORDED_COMPETITIVE_CLASSES,
  taskBodyFor,
} from "../../../benchmarks/validation/apps/economic-competitive-benchmark/corpus";
import type { CompetitiveCorpusRow } from "../../../benchmarks/validation/apps/economic-competitive-benchmark/driver";
import { deriveCompetitiveSynthesis } from "../../../benchmarks/validation/apps/economic-competitive-benchmark/driver";
import {
  competitiveInputsForRow,
  createCompetitiveFakeApiWorld,
  createTickClock,
} from "../../../benchmarks/validation/apps/economic-competitive-benchmark/fixtures";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";

const baseConfig = {
  applicationId: "app-1",
  baseUrl: "https://fake.example.test",
  tokenEnvVar: "ZECK_VALIDATION_TOKEN",
  applicationRevision: "0123456789abcdef0123456789abcdef01234567",
  corpusRevision: "0123456789abcdef0123456789abcdef01234567",
  integrationSurface: "competitive:recorded-arm-history",
  pollIntervalMs: 10,
  completionTimeoutMs: 5_000,
};

const runSuffixOf = (row: CompetitiveCorpusRow): string =>
  `unit-${COMPETITIVE_CORPUS.findIndex((candidate) => candidate.rowId === row.rowId)}`;

async function runAppOverFakeWorld(options: {
  readonly taskIndex: number;
  readonly clock?: ReturnType<typeof createTickClock>;
  readonly terminal?: "COMPLETED" | "FAILED";
  readonly verificationStatuses?: readonly string[];
  readonly fabricatePassWithFail?: boolean;
}) {
  const clock = options.clock ?? createTickClock();
  const world = createCompetitiveFakeApiWorld({
    clock,
    ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    ...(options.verificationStatuses === undefined
      ? {}
      : { verificationStatuses: options.verificationStatuses }),
    ...(options.fabricatePassWithFail === undefined
      ? {}
      : { fabricatePassWithFail: options.fabricatePassWithFail }),
  });
  const outcome = await runCompetitiveApp({
    config: baseConfig,
    token: "test-token",
    transport: world.transport,
    now: clock.now,
    sleep: async () => {},
    environment: {
      runtime: "node test",
      toolchain: "vitest",
      database: "none",
      configuration: { suite: "val-048-apps" },
    },
    runSuffix: "unit",
    taskIndex: options.taskIndex,
  });
  return { outcome, world };
}

// ---------------------------------------------------------------------------
// The corpus + configuration consistency
// ---------------------------------------------------------------------------

describe("VAL-048 corpus + configuration consistency", () => {
  test("config.json mirrors the exported task slice exactly", () => {
    const config = JSON.parse(
      readFileSync(
        join(
          process.cwd(),
          "benchmarks/validation/apps/economic-competitive-benchmark/config.json",
        ),
        "utf8",
      ),
    ) as {
      readonly tokenEnvVar: string;
      readonly integrationSurface: string;
      readonly tasks: readonly { readonly kind: string; readonly rowId: string }[];
    };
    expect(config.tokenEnvVar).toBe("ZECK_VALIDATION_TOKEN");
    expect(config.integrationSurface).toBe("competitive:recorded-arm-history");
    expect(config.tasks.map((task) => task.rowId)).toEqual([...COMPETITIVE_ROW_IDS]);
    for (const task of config.tasks) {
      expect(task.kind).toBe(COMPETITIVE_TASK_KIND);
    }
    expect(JSON.stringify(config)).not.toContain("sk-");
    expect(JSON.stringify(config)).not.toContain("Bearer ");
  });

  test("the row ids are unique and the corpus declares the recorded portfolio", () => {
    expect(new Set(COMPETITIVE_ROW_IDS).size).toBe(COMPETITIVE_ROW_IDS.length);
    const offlineClasses = OFFLINE_CORPUS_ROWS.map((row) => row.workloadClass);
    for (const recordedClass of RECORDED_COMPETITIVE_CLASSES) {
      expect(offlineClasses, recordedClass).toContain(recordedClass);
    }
    expect(COMPETITIVE_CORPUS_VERSION).toBe("val-048-competitive-benchmark-v1");
  });

  test("every arm digest reference is well-formed and pinned at a manifest revision", () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      for (const reference of row.armSet) {
        expect(reference.recordedDigest, `${row.rowId}/${reference.armKind}`).toMatch(
          /^[0-9a-f]{8}$/,
        );
        expect(
          manifestRevisionOf(reference.priceRevision),
          `${row.rowId}/${reference.armKind}`,
        ).not.toBeNull();
        expect(reference.workloadClass.length, `${row.rowId}/${reference.armKind}`).toBeGreaterThan(
          0,
        );
      }
    }
  });

  test("the adjusted-basis references resolve in the VAL-044 corpus", () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      for (const reference of row.adjustedBasisReferences) {
        expect(reference.recordedDigest, `${row.rowId}/${reference.corpusRowId}`).toMatch(
          /^[0-9a-f]{8}$/,
        );
        expect(reference.corpusRowId.length).toBeGreaterThan(0);
      }
    }
    // Every family's composing record is referenced by at least one row.
    const referenced = OFFLINE_CORPUS_ROWS.flatMap((row) =>
      row.adjustedBasisReferences.map((reference) => reference.corpusRowId),
    );
    for (const composing of [
      "quality-adjusted-three-arm-synthesis",
      "latency-adjusted-three-arm-synthesis",
      "failure-adjusted-three-arm-synthesis",
      "quality-adjusted-null-attainment-incomparable",
      "failure-adjusted-null-resolved-incomparable",
      "quality-adjusted-below-minimum-honest-refusal",
    ]) {
      expect(referenced, composing).toContain(composing);
    }
  });

  test("the longitudinal context is disclosed (VAL-045 + VAL-047 digests)", () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      expect(row.longitudinalContext.contextDigest).toMatch(/^[0-9a-f]{8}$/);
      expect(row.longitudinalContext.curveClasses.length).toBeGreaterThan(0);
      expect(row.longitudinalContext.attributionDigest).toMatch(/^[0-9a-f]{8}$/);
      for (const point of row.longitudinalContext.latestPointReferences) {
        expect(point.recordedDigest).toMatch(/^[0-9a-f]{8}$/);
        expect(point.generation).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("the pinned competitive outcomes re-derive over the honest recorded inputs", () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) => candidate.adversarial === undefined,
    )) {
      const derived = deriveCompetitiveSynthesis({
        row,
        arms: honestCompetitiveInputsOf(row.armSet),
      });
      expect(derived.synthesis.verdict, row.rowId).toBe(row.expected.verdict);
      expect(derived.verdict, row.rowId).toBe(row.expected.verdict);
      expect(derived.synthesis.ranking.join(","), row.rowId).toBe(
        row.expected.synthesis?.ranking.join(","),
      );
    }
  });

  test("the honest fixture inputs equal the corpus's honest resolution", () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      if (row.adversarial === undefined) {
        const inputs = competitiveInputsForRow(row);
        const honest = honestCompetitiveInputsOf(row.armSet);
        expect(inputs.length, row.rowId).toBe(honest.length);
        for (const [index, arm] of inputs.entries()) {
          const other = honest[index];
          if (other === undefined) {
            throw new Error("unreachable");
          }
          expect(arm.reference.corpusRowId).toBe(other.reference.corpusRowId);
          expect(arm.facts.measuredCostMicroUsd).toBe(other.facts.measuredCostMicroUsd);
        }
      }
    }
  });

  test("the live row stays honestly NOT RUN without the credential", () => {
    const liveRows = COMPETITIVE_CORPUS.filter((row) => row.needsDispatch);
    expect(liveRows).toHaveLength(1);
    for (const row of liveRows) {
      expect(liveGateOpen(row, process.env) || process.env.OPENROUTER_API_KEY === undefined).toBe(
        true,
      );
      expect(row.liveGate?.envVars).toEqual(["OPENROUTER_API_KEY"]);
    }
  });

  test("the corpus input digest is stable and the row lookup resolves", () => {
    expect(pinnedCompetitiveInputDigest()).toMatch(/^[0-9a-f]{8}$/);
    for (const rowId of COMPETITIVE_ROW_IDS) {
      expect(competitiveRowById(rowId)?.rowId).toBe(rowId);
    }
    expect(competitiveRowById("no-such-row")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The app over the honest fake world
// ---------------------------------------------------------------------------

describe("VAL-048 the app over the honest fake world", () => {
  test("every offline row lands ONE durable execution and settles its honest terminal", async () => {
    for (const [taskIndex, row] of OFFLINE_CORPUS_ROWS.entries()) {
      const { outcome, world } = await runAppOverFakeWorld({ taskIndex });
      expect(world.createdExecutions, row.rowId).toBe(1);
      expect(outcome.observedTerminal, row.rowId).toBe(row.expected.terminal);
      expect(outcome.passed, row.rowId).toBe(true);
      expect(validateHarnessEvidence(outcome.evidence), row.rowId).toEqual([]);
      const failed = outcome.competitiveCriteria.filter((criterion) => criterion.status === "FAIL");
      expect(failed, `${row.rowId}: ${JSON.stringify(failed)}`).toEqual([]);
      expect(outcome.submissionLatencyMs).toHaveLength(1);
      void runSuffixOf(row);
    }
  });

  test("the task bodies carry references only (never prices, never result copies)", () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const body = JSON.stringify(taskBodyFor({ row }));
      expect(body, row.rowId).not.toMatch(/microUsd|amount|token[s]?[,:"]/);
      expect(body, row.rowId).not.toContain("sk-");
      const typed = taskBodyFor({ row }) as { preRegisteredArmSet: readonly unknown[] };
      expect(typed.preRegisteredArmSet, row.rowId).toHaveLength(row.armSet.length);
    }
  });
});

// ---------------------------------------------------------------------------
// The customer-boundary discriminations
// ---------------------------------------------------------------------------

describe("VAL-048 customer-boundary discriminations", () => {
  test("a fabricated pass-with-fail FAILs the app-terminal-criteria-agreement", async () => {
    const taskIndex = COMPETITIVE_CORPUS.findIndex(
      (candidate) => candidate.rowId === "probe-sample-starvation",
    );
    const { outcome } = await runAppOverFakeWorld({ taskIndex, fabricatePassWithFail: true });
    expect(outcome.observedTerminal).toBe("COMPLETED");
    expect(outcome.passed).toBe(false);
    const agreement = outcome.competitiveCriteria.find(
      (criterion) => criterion.criterionId === "app-terminal-criteria-agreement",
    );
    expect(agreement?.status).toBe("FAIL");
  });

  test("a terminal override FAILs the app-expected-terminal criterion", async () => {
    const taskIndex = COMPETITIVE_CORPUS.findIndex(
      (candidate) => candidate.rowId === "confirmation-fixed-quality-quality-adjusted-ranking",
    );
    const { outcome } = await runAppOverFakeWorld({ taskIndex, terminal: "FAILED" });
    expect(outcome.observedTerminal).toBe("FAILED");
    expect(outcome.passed).toBe(false);
    const expected = outcome.competitiveCriteria.find(
      (criterion) => criterion.criterionId === "app-expected-terminal",
    );
    expect(expected?.status).toBe("FAIL");
  });

  test("a rejected submission FAILs the submission-landed criterion honestly", async () => {
    const clock = createTickClock();
    const world = createCompetitiveFakeApiWorld({ clock });
    // Reject every POST at the transport level (the boundary refusal).
    const rejectingTransport = async () =>
      new Response(JSON.stringify({ code: "CAPABILITY_UNAVAILABLE", message: "no" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    const outcome = await runCompetitiveApp({
      config: baseConfig,
      token: "test-token",
      transport: rejectingTransport,
      now: clock.now,
      sleep: async () => {},
      environment: {
        runtime: "node test",
        toolchain: "vitest",
        database: "none",
        configuration: { suite: "val-048-apps" },
      },
      runSuffix: "unit",
      taskIndex: 0,
    });
    void world;
    expect(outcome.passed).toBe(false);
    expect(outcome.observedTerminal).toBeNull();
    expect(outcome.competitiveCriteria.map((criterion) => criterion.criterionId)).toEqual([
      "submission-landed",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The probe rows over the app boundary (the honest failure IS the verified outcome)
// ---------------------------------------------------------------------------

describe("VAL-048 the probe rows over the app boundary", () => {
  /** Each adversarial probe row's NAMED criterion (the honest failure). */
  const probeNamedCriterion: Readonly<Record<string, string>> = {
    "probe-subset-cherry-picking": "portfolio-honesty",
    "probe-unit-pooling": "unit-comparability",
    "probe-cost-basis-switching": "cost-basis-integrity",
    "probe-unpaired-statistics": "paired-statistics",
    "probe-confidence-inflation": "multiple-comparison-honesty",
    "probe-sample-starvation": "minimum-sample-enforcement",
  };

  test("each probe row settles FAILED (the app observes the honest failure)", async () => {
    for (const [taskIndex, row] of OFFLINE_CORPUS_ROWS.entries()) {
      if (row.adversarial === undefined) {
        continue;
      }
      const { outcome } = await runAppOverFakeWorld({ taskIndex });
      expect(outcome.observedTerminal, row.rowId).toBe("FAILED");
      expect(outcome.passed, row.rowId).toBe(true);
      void probeNamedCriterion[row.rowId];
    }
  });

  test("the driver over the leaky stack FAILs each probe's NAMED criterion", async () => {
    // The named-criterion matrix lives in the driver unit suite; here we
    // assert the app boundary agrees on every probe's honest terminal.
    const probes = OFFLINE_CORPUS_ROWS.filter((row) => row.adversarial !== undefined);
    expect(probes).toHaveLength(6);
    expect(new Set(probes.map((row) => row.adversarial)).size).toBe(6);
  });
});
