/**
 * VAL-041 acceptance criteria 4, 5 and 6 (the driver's oracles + the
 * discrimination floor): the direct-provider control arm's mechanical
 * verification.
 *
 *   * the arm-conformance matrix: an honest direct dispatch passes;
 *     every platform-artifact/shortcut shape FAILs with the artifact
 *     named (a reuse/cache shortcut signature, a platform mediation
 *     marker, a misrouted rail, a non-direct surface);
 *   * the normalization matrix: honest micro-USD passes; a
 *     mixed-currency conflation FAILs named; an estimate-backed cost
 *     FAILs named;
 *   * the manifest matrix: a pinned integral revision passes; an
 *     in-place price mutation FAILs its digest mechanically; an
 *     unpinned revision FAILs;
 *   * the sample-size matrix: at-minimum passes; below FAILs; a
 *     post-hoc arm exclusion FAILs named;
 *   * the Wilson-confidence application, the digest discipline, the
 *     driver over every offline row (the 7 honest controls COMPLETE;
 *     the 5 adversarial probes FAIL their named criteria), and the
 *     adversarial worlds over the honest rows through the executor
 *     knobs.
 */

import { describe, expect, test } from "vitest";
import { manifestFor } from "../../../benchmarks/validation/apps/economic-baseline/normalization";
import {
  DIRECT_CORPUS,
  DIRECT_CORPUS_VERSION,
  directTasksForArm,
  liveGateOpen,
  taskBodyFor,
} from "../../../benchmarks/validation/apps/economic-controls-direct/corpus";
import {
  DIRECT_SURFACE_PREFIX,
  type DirectCorpusRow,
  deriveDirectManifestIntegrity,
  deriveDirectPathConformance,
  deriveDirectRoundBudgetBoundMicroUsd,
  deriveDirectSampleDiscipline,
  driveDirectRow,
  economicDigestOf,
  isDirectSurface,
} from "../../../benchmarks/validation/apps/economic-controls-direct/driver";
import {
  createDirectReplayExecutor,
  createFakeLedger,
  createFakeLifecycle,
  createFakeSubmissionSeam,
  createTickClock,
  mutatedManifestOf,
} from "../../../benchmarks/validation/apps/economic-controls-direct/fixtures";
import type { LabVerificationCriterion } from "../../../benchmarks/validation/platform/derive";
import type { ValidationRunRecord } from "../../../benchmarks/validation/recorder/record";
import type { RunMetadata } from "../../../benchmarks/validation/run-identity";

const REVISION = "3f7e8ac6c0f2f0f47e1f2c0a1d3b1b9a2c4d5e6f";

const noSleep = async () => {};

const metadataOf = (observedAt: string): RunMetadata => ({
  program: "zeck-validation",
  workOrder: "VAL-041",
  baseRevision: REVISION,
  applicationRevision: REVISION,
  corpusRevision: REVISION,
  integrationSurface: "direct:openrouter",
  environment: {
    runtime: "node test",
    toolchain: "vitest",
    database: "none",
    configuration: { suite: "val-041-unit" },
  },
  observedAt,
});

const rowById = (rowId: string): DirectCorpusRow => {
  const row = DIRECT_CORPUS.find((candidate) => candidate.rowId === rowId);
  if (row === undefined) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

/** Drive one row over the honest offline stack (the unit oracle floor). */
async function driveRowOverHonestStack(
  row: DirectCorpusRow,
  options: {
    readonly knobs?: Parameters<typeof createDirectReplayExecutor>[0]["knobs"];
    readonly manifestOverride?: Parameters<typeof driveDirectRow>[0]["manifestOverride"];
    readonly claimedThresholdMet?: boolean;
  } = {},
) {
  const clock = createTickClock();
  const ledger = createFakeLedger(clock);
  const seam = createFakeSubmissionSeam({ ledger });
  const lifecycle = createFakeLifecycle({ ledger });
  const executor = createDirectReplayExecutor({ row, clock, knobs: options.knobs });
  const baseline = ledger.facts();
  const submission = await seam({
    key: `val-041-unit-${row.rowId}`,
    body: taskBodyFor({ row }),
  });
  const result = await driveDirectRow({
    row,
    lifecycle,
    executor,
    rails: { ...honestRails() },
    tasks: directTasksForArm(row.arm),
    metadata: metadataOf(clock.now().toISOString()),
    environmentIdentity: `val-041-unit-${row.rowId}`,
    corpusVersion: DIRECT_CORPUS_VERSION,
    baseline,
    worldFacts: ledger.facts,
    landedProvider: async () => [submission.executionId],
    retry: { maxExtraAttempts: 2, backoffMs: 1, sleep: noSleep },
    now: clock.now,
    ...(options.manifestOverride === undefined
      ? {}
      : { manifestOverride: options.manifestOverride }),
    ...(options.claimedThresholdMet === undefined
      ? {}
      : { claimedThresholdMet: options.claimedThresholdMet }),
  });
  return { result, lifecycle, ledger };
}

import { createRealAccountingRails } from "../../../benchmarks/validation/apps/economic-baseline/driver";

function honestRails() {
  return createRealAccountingRails();
}

const criterionOf = (
  result: { readonly criteria: readonly LabVerificationCriterion[] },
  id: string,
): LabVerificationCriterion | undefined =>
  result.criteria.find((criterion) => criterion.criterionId === id);

/** A minimal well-formed sealed run record for the synthetic oracle inputs. */
const syntheticRecord = (): ValidationRunRecord =>
  ({
    runId: `val-run-${"0".repeat(64)}`,
    revision: 1,
    sealedAt: "2026-01-01T00:00:00.000Z",
    linkage: { program: "zeck-validation", workOrder: "VAL-041" },
    trajectory: [],
    environmentState: [],
    latency: [],
    cost: [],
    telemetryGaps: [],
    digest: "d".repeat(64),
  }) as unknown as ValidationRunRecord;

// ---------------------------------------------------------------------------
// The arm-conformance oracle
// ---------------------------------------------------------------------------

describe("VAL-041 arm conformance (the direct-path oracle)", () => {
  test("every corpus arm declares the direct integration surface", () => {
    for (const row of DIRECT_CORPUS) {
      expect(isDirectSurface(row.arm)).toBe(true);
      expect(row.arm.integrationSurface.startsWith(DIRECT_SURFACE_PREFIX)).toBe(true);
    }
  });

  test("an honest direct dispatch over the pinned rail passes the oracle", async () => {
    const { result } = await driveRowOverHonestStack(rowById("fixed-quality-direct-default-rail"));
    const criterion = criterionOf(result, "direct-path-conformance");
    expect(criterion?.status).toBe("PASS");
    const path = deriveDirectPathConformance({
      arm: rowById("fixed-quality-direct-default-rail").arm,
      rounds: result.rounds,
    });
    expect(path.conformant).toBe(true);
    expect(path.evidence.join(" ")).toContain("no platform mediation");
  });

  test("a reuse/cache shortcut signature FAILs the oracle with the artifact named", async () => {
    const { result } = await driveRowOverHonestStack(rowById("fixed-quality-direct-default-rail"), {
      knobs: { shortcutArtifact: "reuse-cache-signature:zeck-reuse-layer" },
    });
    const criterion = criterionOf(result, "direct-path-conformance");
    expect(criterion?.status).toBe("FAIL");
    expect(criterion?.evidence.join(" ")).toContain("reuse-cache-signature:zeck-reuse-layer");
    expect(result.terminal).toBe("FAILED");
  });

  test("a platform mediation marker FAILs the oracle with the artifact named", async () => {
    const { result } = await driveRowOverHonestStack(rowById("fixed-quality-direct-euro-rail"), {
      knobs: { shortcutArtifact: "platform-mediation-marker:agent-gateway" },
    });
    const criterion = criterionOf(result, "direct-path-conformance");
    expect(criterion?.status).toBe("FAIL");
    expect(criterion?.evidence.join(" ")).toContain("platform-mediation-marker:agent-gateway");
    expect(result.terminal).toBe("FAILED");
  });

  test("the shortcut-riding PROBE row FAILs mechanically with both artifacts named", async () => {
    const { result } = await driveRowOverHonestStack(rowById("probe-platform-shortcut-masquerade"));
    const criterion = criterionOf(result, "direct-path-conformance");
    expect(criterion?.status).toBe("FAIL");
    const evidence = criterion?.evidence.join(" ") ?? "";
    expect(evidence).toContain("reuse-cache-signature:zeck-reuse-layer");
    expect(evidence).toContain("platform-mediation-marker:agent-gateway");
    expect(result.terminal).toBe("FAILED");
  });

  test("a round whose measured facts ride a rail other than the arm's pinned one FAILs", () => {
    const arm = rowById("fixed-quality-direct-default-rail").arm;
    const path = deriveDirectPathConformance({
      arm,
      rounds: [
        {
          taskId: "val-041-direct-default#001",
          executed: true,
          attempts: 1,
          observed: {
            terminalStatus: "COMPLETED",
            verificationStatuses: ["PASS"],
            responseText: "confirm",
            outputShapeFields: [],
            environmentEffects: [],
            retryableErrorsSurfaced: 0,
          },
          usageFacts: [
            {
              provider: "euro-relay",
              model: "euro-small-v1",
              tier: "input",
              currency: "EUR",
              tokens: 120,
              kind: "measured",
              scope: "direct-execution",
            },
          ],
          latencyMs: 10,
          record: syntheticRecord(),
          evaluation: { verdict: "pass" } as never,
          platformArtifacts: [],
          chargeObservationUsd: null,
        },
      ],
    });
    expect(path.conformant).toBe(false);
    expect(path.evidence.join(" ")).toContain("misroutes:1");
  });
});

// ---------------------------------------------------------------------------
// The normalization oracle
// ---------------------------------------------------------------------------

describe("VAL-041 normalization (the direct cost-basis oracle)", () => {
  test("honest micro-USD facts in the pinned currencies pass", async () => {
    const { result } = await driveRowOverHonestStack(rowById("fixed-quality-direct-euro-rail"));
    const criterion = criterionOf(result, "direct-cost-basis-measured");
    expect(criterion?.status).toBe("PASS");
    expect(criterion?.evidence.join(" ")).toContain("measured-only basis");
  });

  test("the EUR rail's prices converge through the pinned FX onto micro-USD", async () => {
    const { result } = await driveRowOverHonestStack(rowById("fixed-quality-direct-euro-rail"));
    expect(result.comparison?.measuredCostMicroUsd).toBe(
      rowById("fixed-quality-direct-euro-rail").expected.normalized?.measuredCostMicroUsd,
    );
    expect(result.comparison?.measuredCostMicroUsd).not.toBe("0");
  });

  test("the JPY per-1K rail's unit conversion converges onto the SAME canonical basis", async () => {
    const { result } = await driveRowOverHonestStack(rowById("fixed-quality-direct-tokyo-rail"));
    const criterion = criterionOf(result, "direct-cost-basis-measured");
    expect(criterion?.status).toBe("PASS");
    expect(result.comparison?.measuredCostMicroUsd).not.toBe("0");
  });

  test("a mixed-currency conflation FAILs named (GBP against the USD rail)", async () => {
    const { result } = await driveRowOverHonestStack(rowById("fixed-quality-direct-default-rail"), {
      knobs: { conflateCurrency: "GBP" },
    });
    const criterion = criterionOf(result, "direct-cost-basis-measured");
    const integrity = criterionOf(result, "normalization-integrity");
    expect(criterion?.status).toBe("FAIL");
    expect(integrity?.status).toBe("FAIL");
    expect(criterion?.evidence.join(" ")).toContain("mixed-currency");
    expect(result.terminal).toBe("FAILED");
  });

  test("the mixed-currency PROBE row FAILs named (the recorded GBP usage)", async () => {
    const { result } = await driveRowOverHonestStack(rowById("probe-mixed-currency-conflation"));
    expect(criterionOf(result, "direct-cost-basis-measured")?.status).toBe("FAIL");
    expect(criterionOf(result, "normalization-integrity")?.status).toBe("FAIL");
    expect(result.terminal).toBe("FAILED");
  });

  test("an estimate-backed cost FAILs named (quotes only, no measured usage)", async () => {
    const { result } = await driveRowOverHonestStack(rowById("fixed-quality-direct-default-rail"), {
      knobs: { estimateOnly: true },
    });
    const criterion = criterionOf(result, "direct-cost-basis-measured");
    expect(criterion?.status).toBe("FAIL");
    expect(criterion?.evidence.join(" ")).toContain("ESTIMATE-BACKED COST");
    expect(result.terminal).toBe("FAILED");
  });

  test("the estimate-backed PROBE row FAILs named and the cost-per-resolved is refused", async () => {
    const { result } = await driveRowOverHonestStack(rowById("probe-estimate-backed-cost"));
    expect(criterionOf(result, "direct-cost-basis-measured")?.status).toBe("FAIL");
    expect(result.comparison?.costPerResolvedMicroUsd).toBeNull();
    expect(result.terminal).toBe("FAILED");
  });

  test("the zero-resolved row holds the NULL discipline (never zero, never estimate-backed)", async () => {
    const { result } = await driveRowOverHonestStack(
      rowById("zero-resolved-direct-null-discipline"),
    );
    expect(result.terminal).toBe("COMPLETED");
    expect(result.comparison?.costPerResolvedMicroUsd).toBeNull();
    expect(result.comparison?.measuredCostMicroUsd).not.toBe("0");
  });
});

// ---------------------------------------------------------------------------
// The manifest oracle
// ---------------------------------------------------------------------------

describe("VAL-041 manifest integrity (the pinned-price oracle)", () => {
  test("a pinned integral revision passes", () => {
    const row = rowById("fixed-quality-direct-default-rail");
    const verdict = deriveDirectManifestIntegrity({
      manifest: manifestFor(row.arm.priceRevision),
      arm: row.arm,
    });
    expect(verdict.conformant).toBe(true);
  });

  test("an in-place price mutation FAILs its digest mechanically", async () => {
    const row = rowById("fixed-quality-direct-default-rail");
    const mutated = mutatedManifestOf(row.arm.priceRevision, {
      provider: "openrouter",
      tier: "input",
      price: "0.01",
    });
    const verdict = deriveDirectManifestIntegrity({ manifest: mutated, arm: row.arm });
    expect(verdict.conformant).toBe(false);
    expect(verdict.evidence.join(" ")).toContain("in-place price mutation");
    const { result } = await driveRowOverHonestStack(row, { manifestOverride: mutated });
    expect(criterionOf(result, "direct-manifest-integrity")?.status).toBe("FAIL");
    expect(result.terminal).toBe("FAILED");
  });

  test("an unpinned revision (the arm declares another) FAILs", async () => {
    const row = rowById("fixed-quality-direct-default-rail");
    const other = manifestFor("rev-002");
    const verdict = deriveDirectManifestIntegrity({ manifest: other, arm: row.arm });
    expect(verdict.conformant).toBe(false);
    expect(verdict.evidence.join(" ")).toContain("UNPINNED");
    const { result } = await driveRowOverHonestStack(row, { manifestOverride: other });
    expect(criterionOf(result, "direct-manifest-integrity")?.status).toBe("FAIL");
    expect(result.terminal).toBe("FAILED");
  });

  test("the corrected-revision row (rev-002) passes over its declared revision", async () => {
    const { result } = await driveRowOverHonestStack(
      rowById("fixed-quality-direct-corrected-price"),
    );
    expect(criterionOf(result, "direct-manifest-integrity")?.status).toBe("PASS");
    expect(result.terminal).toBe("COMPLETED");
  });
});

// ---------------------------------------------------------------------------
// The sample-size oracle
// ---------------------------------------------------------------------------

describe("VAL-041 sample discipline (the sample-size oracle)", () => {
  test("at-minimum passes (the honest control rows)", async () => {
    for (const rowId of [
      "fixed-quality-direct-default-rail",
      "fixed-cost-direct-within-budget",
      "fixed-cost-direct-budget-exhausted-honest-stop",
    ]) {
      const { result } = await driveRowOverHonestStack(rowById(rowId));
      expect(criterionOf(result, "direct-sample-discipline")?.status).toBe("PASS");
    }
  });

  test("the budget-stop row's declared PREFIX stop is not an exclusion", async () => {
    const { result } = await driveRowOverHonestStack(
      rowById("fixed-cost-direct-budget-exhausted-honest-stop"),
    );
    expect(result.budgetStopAfter).toBe(3);
    const discipline = deriveDirectSampleDiscipline({
      row: rowById("fixed-cost-direct-budget-exhausted-honest-stop"),
      rounds: result.rounds,
      skippedTaskIds: [],
      budgetStopAfter: result.budgetStopAfter,
    });
    expect(discipline.conformant).toBe(true);
    expect(result.terminal).toBe("COMPLETED");
  });

  test("a starved sample below the pre-registered minimum FAILs named", async () => {
    const { result } = await driveRowOverHonestStack(rowById("fixed-quality-direct-default-rail"), {
      knobs: { truncateSamples: 5 },
    });
    const criterion = criterionOf(result, "direct-sample-discipline");
    expect(criterion?.status).toBe("FAIL");
    expect(criterion?.evidence.join(" ")).toContain("SAMPLE-STARVED");
    expect(result.terminal).toBe("FAILED");
  });

  test("the sample-starved PROBE row FAILs named (5 executed < 8 minimum)", async () => {
    const { result } = await driveRowOverHonestStack(rowById("probe-sample-size-violation"));
    const criterion = criterionOf(result, "direct-sample-discipline");
    expect(criterion?.status).toBe("FAIL");
    expect(criterion?.evidence.join(" ")).toContain("SAMPLE-STARVED: 5 executed < 8");
    expect(result.rounds.length).toBe(5);
    expect(result.terminal).toBe("FAILED");
  });

  test("a post-hoc arm exclusion FAILs named (the failed round dropped)", async () => {
    const { result } = await driveRowOverHonestStack(rowById("fixed-quality-direct-default-rail"), {
      knobs: { dropFailedRounds: true },
    });
    const criterion = criterionOf(result, "direct-sample-discipline");
    expect(criterion?.status).toBe("FAIL");
    expect(criterion?.evidence.join(" ")).toContain("post-hoc-excluded");
    expect(result.terminal).toBe("FAILED");
  });

  test("the post-hoc-exclusion PROBE row FAILs named", async () => {
    const { result } = await driveRowOverHonestStack(rowById("probe-post-hoc-arm-exclusion"));
    const criterion = criterionOf(result, "direct-sample-discipline");
    expect(criterion?.status).toBe("FAIL");
    expect(criterion?.evidence.join(" ")).toContain("post-hoc-excluded");
    expect(result.terminal).toBe("FAILED");
  });
});

// ---------------------------------------------------------------------------
// Wilson confidence + digest discipline
// ---------------------------------------------------------------------------

describe("VAL-041 Wilson confidence + digest discipline", () => {
  test("every honest comparison carries the Wilson 95% interval bracketing the observed rate", async () => {
    const { result } = await driveRowOverHonestStack(rowById("fixed-quality-direct-default-rail"));
    const confidence = result.comparison?.resolutionConfidence;
    expect(confidence).not.toBeNull();
    const resolved = result.comparison?.resolvedCount ?? 0;
    const runs = result.comparison?.runCount ?? 0;
    expect(confidence?.low).toBeLessThanOrEqual(resolved / runs);
    expect(confidence?.high).toBeGreaterThanOrEqual(resolved / runs);
    expect(confidence?.low).toBeGreaterThanOrEqual(0);
    expect(confidence?.high).toBeLessThanOrEqual(1);
  });

  test("the zero-resolved row carries the honest [0, high] interval", async () => {
    const { result } = await driveRowOverHonestStack(
      rowById("zero-resolved-direct-null-discipline"),
    );
    expect(result.comparison?.resolutionConfidence?.low).toBe(0);
    expect(result.comparison?.resolutionConfidence?.high).toBeGreaterThan(0);
  });

  test("the digest helper is deterministic and payload-safe", () => {
    const a = economicDigestOf({ taskId: "t1", usage: { input: 120, output: 30 } });
    const b = economicDigestOf({ taskId: "t1", usage: { input: 120, output: 30 } });
    const c = economicDigestOf({ taskId: "t1", usage: { input: 121, output: 30 } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain("confirm");
  });

  test("the fixed-cost per-round budget bound is priced BEFORE dispatch from the pinned manifest", () => {
    const row = rowById("fixed-cost-direct-within-budget");
    const bound = deriveDirectRoundBudgetBoundMicroUsd({
      manifest: manifestFor(row.arm.priceRevision),
      arm: row.arm,
    });
    // 64 tokens at BOTH tiers of the openrouter rail: 64*0.12/1M +
    // 64*0.25/1M = 23.68 µ$ → the deterministic half-up bound 24.
    expect(bound).toBe("24");
    expect(Number.parseInt(bound, 10)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The driver over every offline row
// ---------------------------------------------------------------------------

describe("VAL-041 driver over the offline corpus", () => {
  test("every honest control row COMPLETES with the pinned normalized outcome", async () => {
    for (const row of DIRECT_CORPUS.filter(
      (candidate) => !candidate.needsDispatch && candidate.expected.terminal === "COMPLETED",
    )) {
      const { result } = await driveRowOverHonestStack(row);
      expect(result.terminal).toBe("COMPLETED");
      expect(result.failure).toBeNull();
      const normalized = row.expected.normalized;
      expect(normalized).toBeDefined();
      expect(result.comparison?.runCount).toBe(normalized?.runCount);
      expect(result.comparison?.resolvedCount).toBe(normalized?.resolvedCount);
      expect(result.comparison?.measuredCostMicroUsd).toBe(normalized?.measuredCostMicroUsd);
      expect(result.comparison?.estimatedCostMicroUsd).toBe(normalized?.estimatedCostMicroUsd);
      expect(result.comparison?.costPerResolvedMicroUsd).toBe(normalized?.costPerResolvedMicroUsd);
      expect(criterionOf(result, "normalized-outcome-oracle")?.status).toBe("PASS");
      expect(criterionOf(result, "observed-terminal-readback")?.status).toBe("PASS");
    }
  });

  test("every adversarial PROBE row FAILS its named criterion honestly", async () => {
    const expectations: Record<string, string> = {
      "probe-platform-shortcut-masquerade": "direct-path-conformance",
      "probe-mixed-currency-conflation": "direct-cost-basis-measured",
      "probe-estimate-backed-cost": "direct-cost-basis-measured",
      "probe-post-hoc-arm-exclusion": "direct-sample-discipline",
      "probe-sample-size-violation": "direct-sample-discipline",
    };
    for (const [rowId, criterionId] of Object.entries(expectations)) {
      const { result } = await driveRowOverHonestStack(rowById(rowId));
      expect(result.terminal).toBe("FAILED");
      expect(criterionOf(result, criterionId)?.status).toBe("FAIL");
      expect(criterionOf(result, "observed-terminal-readback")?.status).toBe("PASS");
    }
  });

  test("the per-attempt granularity: the bounded retry's failed attempt is a retry-overhead fact", async () => {
    const row = rowById("fixed-quality-direct-default-rail");
    const { result } = await driveRowOverHonestStack(row);
    const retried = result.rounds.find((round) => round.attempts === 2);
    expect(retried).toBeDefined();
    const scopes = retried?.usageFacts.map((fact) => fact.scope);
    expect(scopes).toContain("retry-overhead");
    expect(scopes).toContain("direct-execution");
    expect(retried?.usageFacts.length).toBe(4);
  });

  test("the arm decision is journaled BEFORE the first round (the durable planning decision)", async () => {
    const row = rowById("fixed-cost-direct-within-budget");
    const { lifecycle } = await driveRowOverHonestStack(row);
    const decisions = lifecycle.journal.decisions;
    expect(decisions.length).toBe(1);
    const decision = decisions[0];
    expect(decision?.armDecision.directPath).toContain("provider-called-directly");
    expect(decision?.armDecision.priceRevision).toBe(row.arm.priceRevision);
    expect(decision?.armDecision.roundBoundMicroUsd).toBe("24");
    expect(decision?.provider).toBe(row.arm.provider);
    expect(decision?.model).toBe(row.arm.model);
  });

  test("the threshold-gaming catch: the arm's own claim never decides (recomputed)", async () => {
    const { result } = await driveRowOverHonestStack(rowById("fixed-quality-direct-euro-rail"), {
      claimedThresholdMet: true,
    });
    // The threshold attainment is recomputed from the accounted runs:
    // the claimed flag rides the comparison as a recorded claim, and
    // the honest 5/6 attainment still satisfies the pinned 0.75.
    expect(result.terminal).toBe("COMPLETED");
    expect(criterionOf(result, "protocol-comparison-valid")?.status).toBe("PASS");
  });

  test("the live rows stay env-gated (honest NOT RUN without the credential)", () => {
    const live = DIRECT_CORPUS.filter((row) => row.needsDispatch);
    expect(live.length).toBe(2);
    for (const row of live) {
      expect(liveGateOpen(row, {})).toBe(false);
      expect(liveGateOpen(row, { OPENROUTER_API_KEY: "" })).toBe(false);
      expect(liveGateOpen(row, { OPENROUTER_API_KEY: "test-key" })).toBe(true);
      expect(row.expected.normalized).toBeUndefined();
    }
  });

  test("the task bodies carry references only — never an inline price", () => {
    for (const row of DIRECT_CORPUS) {
      const body = JSON.stringify(taskBodyFor({ row }));
      expect(body).not.toMatch(/"price"\s*:/);
      expect(body).not.toMatch(/0\.12/);
      expect(body).toContain(row.arm.priceRevision);
    }
  });
});
