/**
 * VAL-046 acceptance criteria 1, 2 and 5 (the app + the corpus's
 * well-formedness): the substrate-cost application on the public SDK
 * boundary, the corpus's digest/revision consistency, the live gating
 * and the customer-boundary discriminations.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { manifestRevisionOf } from "../../../benchmarks/validation/apps/economic-baseline/pricing";
import { runSubstrateApp } from "../../../benchmarks/validation/apps/economic-substrate-runtime/application";
import {
  SUBSTRATE_CORPUS,
  SUBSTRATE_TASK_KIND,
  substrateRowById,
  taskBodyFor,
} from "../../../benchmarks/validation/apps/economic-substrate-runtime/corpus";
import type { SubstrateCorpusRow } from "../../../benchmarks/validation/apps/economic-substrate-runtime/driver";
import {
  deriveSubstrateFamilySynthesis,
  driveSubstrateRow,
  liveSubstratePlanDigestOf,
} from "../../../benchmarks/validation/apps/economic-substrate-runtime/driver";
import {
  applySubstrateAdversarialVariant,
  createFakeLedger,
  createFakeLifecycle,
  createFakeSubmissionSeam,
  createRealAccountingRails,
  createSubstrateFakeApiWorld,
  createTickClock,
  windowInputsForRow,
} from "../../../benchmarks/validation/apps/economic-substrate-runtime/fixtures";
import {
  deriveSubstrateManifestIntegrity,
  substrateManifestRevisionOf,
} from "../../../benchmarks/validation/apps/economic-substrate-runtime/pricing";
import {
  SUBSTRATE_TELEMETRY,
  substrateWindowFactsOf,
} from "../../../benchmarks/validation/apps/economic-substrate-runtime/telemetry";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { TransportImplementation } from "../../../benchmarks/validation/harness/harness";

const REVISION = "7c31a09be1d4c05e3f6a2b8d9e0c1a2b3c4d5e6f";

const baseConfig = {
  applicationId: "app-1",
  baseUrl: "https://fake.example.test",
  tokenEnvVar: "ZECK_VALIDATION_TOKEN",
  applicationRevision: REVISION,
  corpusRevision: REVISION,
  integrationSurface: "synthesis:recorded-substrate-telemetry",
  pollIntervalMs: 10,
  completionTimeoutMs: 5_000,
};

const rowById = (rowId: string): SubstrateCorpusRow => {
  const row = substrateRowById(rowId);
  if (row === null) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

const taskIndexOf = (rowId: string): number => {
  const index = SUBSTRATE_CORPUS.findIndex((candidate) => candidate.rowId === rowId);
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
  const world = createSubstrateFakeApiWorld({
    clock,
    ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    ...(options.verificationStatuses === undefined
      ? {}
      : { verificationStatuses: options.verificationStatuses }),
    ...(options.fabricatePassWithFail === undefined
      ? {}
      : { fabricatePassWithFail: options.fabricatePassWithFail }),
  });
  const outcome = await runSubstrateApp({
    config: baseConfig,
    token: "test-token",
    transport: options.transport ?? world.transport,
    now: clock.now,
    sleep: async () => {},
    environment: {
      runtime: "node test",
      toolchain: "vitest",
      database: "none",
      configuration: { suite: "val-046-apps" },
    },
    runSuffix: "unit",
    taskIndex: options.taskIndex,
  });
  return { outcome, createdExecutions: world.createdExecutions };
}

// ---------------------------------------------------------------------------
// The corpus + the configuration (consistency)
// ---------------------------------------------------------------------------

describe("VAL-046 corpus + configuration consistency", () => {
  const configPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../benchmarks/validation/apps/economic-substrate-runtime/config.json",
  );
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    tasks: { rowId: string; kind: string }[];
  };

  test("config.json mirrors the exported task slice exactly", () => {
    const expected = SUBSTRATE_CORPUS.map((row) => row.rowId);
    expect(config.tasks.map((task) => task.rowId)).toEqual(expected);
    for (const task of config.tasks) {
      expect(task.kind).toBe(SUBSTRATE_TASK_KIND);
    }
  });

  test("every window digest reference resolves and re-derives identically", () => {
    for (const row of SUBSTRATE_CORPUS) {
      for (const reference of row.windowSet) {
        if (reference.live === true) {
          expect(reference.recordedDigest).toBe(liveSubstratePlanDigestOf());
          continue;
        }
        const window = SUBSTRATE_TELEMETRY.find(
          (candidate) => candidate.windowId === reference.windowId,
        );
        expect(window, reference.windowId).toBeDefined();
        if (window !== undefined) {
          const facts = substrateWindowFactsOf(window);
          expect(reference.priceRevision).toBe(window.priceRevision);
          expect(reference.recordedDigest).toMatch(/^[0-9a-f]{8}$/);
          expect(reference.recordedDigest.length).toBeGreaterThan(0);
          void facts;
        }
      }
    }
  });

  test("every window's pinned substrate price revision is known and integrity-agreed", () => {
    for (const window of SUBSTRATE_TELEMETRY) {
      const manifest = substrateManifestRevisionOf(window.priceRevision);
      expect(manifest).not.toBeNull();
      expect(deriveSubstrateManifestIntegrity({ revision: window.priceRevision }).agreed).toBe(
        true,
      );
    }
  });

  test("every composed arm input's pinned price revision is known in the VAL-040 registry", () => {
    for (const row of SUBSTRATE_CORPUS) {
      for (const reference of row.armSet) {
        expect(manifestRevisionOf(reference.priceRevision)).not.toBeNull();
      }
    }
  });

  test("the honest rows carry pinned syntheses; the probes declare adversarial variants", () => {
    for (const row of SUBSTRATE_CORPUS) {
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

  test("the honest fixture inputs equal the corpus's own honest input resolution", () => {
    for (const row of SUBSTRATE_CORPUS.filter(
      (candidate) =>
        !candidate.needsDispatch &&
        candidate.adversarial !== "post-hoc-exclusion" &&
        candidate.adversarial !== "remeasurement",
    )) {
      const fromFixtures = windowInputsForRow(row);
      const fromCorpus = row.windowSet.map((reference) => {
        const window = SUBSTRATE_TELEMETRY.find(
          (candidate) => candidate.windowId === reference.windowId,
        );
        if (window === undefined) {
          throw new Error(`missing window ${reference.windowId}`);
        }
        return { ...reference, facts: substrateWindowFactsOf(window) };
      });
      expect(fromFixtures.length).toBe(fromCorpus.length);
      for (const [index, window] of fromFixtures.entries()) {
        expect(window.recordedDigest).toBe(fromCorpus[index]?.recordedDigest);
        expect(window.facts.totalMicroUsd).toBe(fromCorpus[index]?.facts.totalMicroUsd);
        expect(window.facts.servedRuns).toBe(fromCorpus[index]?.facts.servedRuns);
      }
    }
  });

  test("the live row is honestly NOT RUN without the credential", () => {
    const live = SUBSTRATE_CORPUS.filter((row) => row.needsDispatch);
    expect(live.length).toBe(1);
    const row = live[0];
    expect(row?.liveGate?.envVars).toEqual(["OPENROUTER_API_KEY"]);
    expect(row?.liveGate?.requirement).toContain("operator-authorized");
    expect(row?.family).toBe("readiness-adjusted-comparison");
  });

  test("every recorded window's telemetry is internally consistent (restarts/evictions have durations)", () => {
    for (const window of SUBSTRATE_TELEMETRY) {
      const facts = substrateWindowFactsOf(window);
      if (facts.restarts > 0) {
        expect(facts.restartStartupMs).toBeGreaterThan(0);
      }
      if (facts.evictions > 0) {
        expect(facts.evictedWastedMs).toBeGreaterThan(0);
      }
      expect(facts.firstDispatchedAtMs).toBeGreaterThanOrEqual(facts.firstUsableAtMs);
    }
  });
});

// ---------------------------------------------------------------------------
// The app over the honest fake world
// ---------------------------------------------------------------------------

describe("VAL-046 app over the honest fake world", () => {
  test("every row's submission lands ONE durable execution with valid evidence", async () => {
    for (const [index] of SUBSTRATE_CORPUS.entries()) {
      const { outcome, createdExecutions } = await runAppOverFakeWorld({ taskIndex: index });
      expect(createdExecutions, SUBSTRATE_CORPUS[index]?.rowId).toBe(1);
      expect(outcome.observedTerminal).toBe(SUBSTRATE_CORPUS[index]?.expected.terminal);
      expect(outcome.passed).toBe(true);
      const violations = validateHarnessEvidence(outcome.evidence);
      expect(violations).toEqual([]);
      expect(outcome.submissionLatencyMs.length).toBe(1);
      expect(outcome.submissionLatencyMs[0]).toBeGreaterThanOrEqual(0);
    }
  });

  test("the honest verdict rows settle COMPLETED with all-PASS statuses (all three verdict kinds)", async () => {
    for (const rowId of [
      "substrate-cost-per-run-three-fleet-synthesis",
      "substrate-amortized-null-resolved-incomparable",
      "readiness-adjusted-below-minimum-honest-refusal",
    ]) {
      const index = taskIndexOf(rowId);
      const { outcome } = await runAppOverFakeWorld({ taskIndex: index });
      expect(outcome.observedTerminal).toBe("COMPLETED");
      expect(outcome.verificationStatuses.every((status) => status === "PASS")).toBe(true);
      for (const criterion of outcome.substrateCriteria) {
        expect(criterion.status).toBe("PASS");
      }
    }
  });

  test("the probe rows settle FAILED honestly (the failure is the verified outcome)", async () => {
    const index = taskIndexOf("probe-startup-hiding");
    const { outcome } = await runAppOverFakeWorld({ taskIndex: index });
    expect(outcome.observedTerminal).toBe("FAILED");
    expect(outcome.verificationStatuses).toContain("FAIL");
    expect(outcome.passed).toBe(true);
  });

  test("a same-key re-submission replays the committed receipt (no second execution)", async () => {
    const clock = createTickClock();
    const world = createSubstrateFakeApiWorld({ clock });
    const run = async () =>
      runSubstrateApp({
        config: baseConfig,
        token: "test-token",
        transport: world.transport,
        now: clock.now,
        sleep: async () => {},
        environment: {
          runtime: "node test",
          toolchain: "vitest",
          database: "none",
          configuration: { suite: "val-046-apps" },
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

describe("VAL-046 app customer-boundary discriminations", () => {
  test("a FABRICATED pass-with-fail FAILs the app honestly (anyFail→FAILED at the boundary)", async () => {
    const index = taskIndexOf("probe-reserved-measured-conflation");
    const { outcome } = await runAppOverFakeWorld({
      taskIndex: index,
      fabricatePassWithFail: true,
    });
    expect(outcome.observedTerminal).toBe("COMPLETED");
    expect(outcome.verificationStatuses).toContain("FAIL");
    expect(outcome.passed).toBe(false);
    const agreement = outcome.substrateCriteria.find(
      (criterion) => criterion.criterionId === "app-terminal-criteria-agreement",
    );
    expect(agreement?.status).toBe("FAIL");
  });

  test("a terminal override FAILs every mismatched row", async () => {
    const index = taskIndexOf("substrate-cost-per-run-three-fleet-synthesis");
    const { outcome } = await runAppOverFakeWorld({ taskIndex: index, terminal: "FAILED" });
    expect(outcome.observedTerminal).toBe("FAILED");
    expect(outcome.passed).toBe(false);
    const expected = outcome.substrateCriteria.find(
      (criterion) => criterion.criterionId === "app-expected-terminal",
    );
    expect(expected?.status).toBe("FAIL");
  });

  test("a fabricated all-PASS status list over a FAILED-expected row FAILs the agreement", async () => {
    const index = taskIndexOf("probe-failure-amortization-away");
    const { outcome } = await runAppOverFakeWorld({
      taskIndex: index,
      terminal: "FAILED",
      verificationStatuses: ["PASS", "PASS"],
    });
    expect(outcome.passed).toBe(false);
    const agreement = outcome.substrateCriteria.find(
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
    expect(outcome.substrateCriteria[0]?.criterionId).toBe("submission-landed");
    expect(outcome.substrateCriteria[0]?.status).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// The fixture variants against the pure oracles (the app-level catch)
// ---------------------------------------------------------------------------

describe("VAL-046 fixture variants (each denatured shape FAILs its specific oracle)", () => {
  const headlineRow = rowById("substrate-cost-per-run-three-fleet-synthesis");
  const reliabilityRow = rowById("substrate-reliability-failure-amortization-synthesis");
  const honest = windowInputsForRow(headlineRow);
  const honestReliability = windowInputsForRow(reliabilityRow);

  test("the STARTUP-HIDING variant FAILs the startup-cost-inclusion oracle", () => {
    const startup = deriveSubstrateFamilySynthesis({
      row: headlineRow,
      windows: applySubstrateAdversarialVariant(honest, { startupHiding: true }),
      modelSide: null,
    });
    expect(startup.familyConformant).toBe(false);
  });

  test("the READINESS-INFLATION variant FAILs the readiness-probe-honesty oracle", () => {
    const family = deriveSubstrateFamilySynthesis({
      row: rowById("readiness-adjusted-effective-comparison-synthesis"),
      windows: applySubstrateAdversarialVariant(honest, { readinessInflation: true }),
      modelSide: null,
    });
    expect(family.familyConformant).toBe(false);
  });

  test("the RESERVED-CONFLATION variant FAILs the reserved-measured-separation oracle", () => {
    const family = deriveSubstrateFamilySynthesis({
      row: headlineRow,
      windows: applySubstrateAdversarialVariant(honest, { reservedConflation: true }),
      modelSide: null,
    });
    expect(family.familyConformant).toBe(false);
  });

  test("the FAILURE-AMORTIZATION-AWAY variant FAILs the failure-amortization oracle", () => {
    const family = deriveSubstrateFamilySynthesis({
      row: reliabilityRow,
      windows: applySubstrateAdversarialVariant(honestReliability, {
        failureAmortizationAway: true,
      }),
      modelSide: null,
    });
    expect(family.familyConformant).toBe(false);
  });

  test("the RE-MEASURED variant FAILs the input-integrity oracle (masquerade named)", () => {
    const family = deriveSubstrateFamilySynthesis({
      row: reliabilityRow,
      windows: applySubstrateAdversarialVariant(honest, { remeasurement: true }),
      modelSide: null,
    });
    expect(family.familyConformant).toBe(false);
  });

  test("the SILENT-ABSORPTION variant FAILs the readiness-adjusted family oracle", () => {
    const family = deriveSubstrateFamilySynthesis({
      row: rowById("readiness-adjusted-effective-comparison-synthesis"),
      windows: applySubstrateAdversarialVariant(honest, { silentAbsorption: true }),
      modelSide: null,
    });
    expect(family.familyConformant).toBe(false);
    expect(family.verdict).toBe("adversarial-failed");
  });

  test("each PROBE row's declared variant reproduces through windowInputsForRow (the row-level catch)", () => {
    const expectations: Record<string, string> = {
      "probe-startup-hiding": "startup-cost-inclusion",
      "probe-readiness-inflation": "readiness-probe-honesty",
      "probe-reserved-measured-conflation": "reserved-measured-separation",
      "probe-failure-amortization-away": "failure-amortization-completeness",
      "probe-post-hoc-exclusion": "confidence-and-minimum",
      "probe-sample-size-violation": "below-minimum-refusal-honesty",
      "probe-remeasurement-masquerade": "substrate-input-integrity",
    };
    for (const [rowId] of Object.entries(expectations)) {
      const row = rowById(rowId);
      const windows = windowInputsForRow(row);
      // The post-hoc exclusion drops one window; every other variant
      // keeps the full set with the denatured shape applied.
      if (row.adversarial === "post-hoc-exclusion") {
        expect(windows.length).toBe(row.windowSet.length - 1);
      } else {
        expect(windows.length).toBe(row.windowSet.length);
      }
    }
  });

  test("the driver over the post-hoc-exclusion probe fails on the missing window (the honest drive path)", async () => {
    const row = rowById("probe-post-hoc-exclusion");
    const clock = createTickClock();
    const ledger = createFakeLedger(clock);
    const seam = createFakeSubmissionSeam({ ledger });
    const lifecycle = createFakeLifecycle({ ledger });
    const submission = await seam({
      key: `val-046-apps-${row.rowId}`,
      body: taskBodyFor({ row }),
    });
    const result = await driveSubstrateRow({
      row,
      lifecycle,
      windows: windowInputsForRow(row),
      rails: createRealAccountingRails(),
      metadata: {
        program: "zeck-validation",
        workOrder: "VAL-046",
        baseRevision: REVISION,
        applicationRevision: REVISION,
        corpusRevision: REVISION,
        integrationSurface: "synthesis:recorded-substrate-telemetry",
        environment: {
          runtime: "node test",
          toolchain: "vitest",
          database: "none",
          configuration: { suite: "val-046-apps" },
        },
        observedAt: clock.now().toISOString(),
      },
      environmentIdentity: `val-046-apps-${row.rowId}`,
      baseline: ledger.facts(),
      worldFacts: ledger.facts,
      landedProvider: async () => [submission.executionId],
      now: clock.now,
    });
    expect(result.terminal).toBe("FAILED");
    const confidence = result.criteria.find(
      (criterion) => criterion.criterionId === "confidence-and-minimum",
    );
    expect(confidence?.status).toBe("FAIL");
    expect(confidence?.evidence.join(" ")).toContain("post-hoc-excluded");
  });
});
