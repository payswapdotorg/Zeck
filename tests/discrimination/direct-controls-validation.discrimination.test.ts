/**
 * VAL-041 acceptance criterion 6 — discrimination tests proving the
 * DIRECT-PROVIDER control arm against controlled fakes (every family
 * FAILs mechanically; every family has an honest control that PASSES):
 *
 *   * PLATFORM-SHORTCUT MASQUERADE — a dispatch that rode (and
 *     reports) a platform/gateway artifact — a reuse/cache shortcut
 *     signature or a platform mediation marker — or whose measured
 *     facts rode a rail other than the arm's pinned one: the
 *     ARM-CONFORMANCE oracle FAILs (the verification core — a
 *     quietly-shortcut direct run is mechanically visible);
 *   * MIXED-CURRENCY CONFLATION — usage denominated in a currency
 *     that mismatches the pinned rail's price denomination (GBP sits
 *     outside the pinned FX table): the normalization FAILs;
 *   * ESTIMATE-BACKED COST-PER-RESOLUTION — rounds that report ONLY
 *     quotes (no measured usage) with resolved outcomes: the
 *     cost-basis oracle FAILs (estimates never conflate);
 *   * POST-HOC ARM EXCLUSION — an executor that drops (skips) the
 *     failed rounds from the executed slice to game the comparison:
 *     the sample-discipline oracle FAILs;
 *   * SAMPLE-SIZE VIOLATION — an executor that truncates the sample
 *     below the declared statistical minimum: the sufficiency oracle
 *     FAILs (the honest fixed-cost budget-stop PREFIX is the honest
 *     stop, never an exclusion);
 *   * MUTATED PRICING — a run priced against a MUTATED manifest table
 *     (an in-place price edit with a stale digest) or an UNPINNED
 *     revision the arm does not declare: the manifest-integrity
 *     agreement FAILs;
 *   * the Wilson-confidence application (a CONFIDENCE-LESS comparison
 *     FAILs the frozen validation battery), the digest discipline,
 *     the honest controls over the whole fixture stack, and the AC4
 *     probes (the below-minimum arm declaration and the
 *     declared-digest disagreement each FAIL mechanically).
 */

import { describe, expect, test } from "vitest";
import type { ArmAggregate } from "../../benchmarks/validation/accounting/aggregate";
import type { UsageFact } from "../../benchmarks/validation/apps/economic-baseline/normalization";
import { manifestFor } from "../../benchmarks/validation/apps/economic-baseline/normalization";
import type { PriceManifestRevision } from "../../benchmarks/validation/apps/economic-baseline/pricing";
import { deriveManifestIntegrity } from "../../benchmarks/validation/apps/economic-baseline/pricing";
import {
  deriveNormalizedComparison,
  validateArmDeclaration,
  validateNormalizedComparison,
  wilsonInterval,
} from "../../benchmarks/validation/apps/economic-baseline/protocol";
import {
  DIRECT_CORPUS,
  DIRECT_CORPUS_VERSION,
  directTasksForArm,
  OFFLINE_CONTROL_ROWS,
  PROBE_ROWS,
  taskBodyFor,
} from "../../benchmarks/validation/apps/economic-controls-direct/corpus";
import {
  createRealAccountingRails,
  type DirectCorpusRow,
  type DirectDrivenRound,
  deriveDirectCostBasisIntegrity,
  deriveDirectManifestIntegrity,
  deriveDirectPathConformance,
  deriveDirectSampleDiscipline,
  driveDirectRow,
  economicDigestOf,
} from "../../benchmarks/validation/apps/economic-controls-direct/driver";
import {
  createDirectReplayExecutor,
  createFakeLedger,
  createFakeLifecycle,
  createFakeSubmissionSeam,
  createTickClock,
  type DirectReplayExecutorKnobs,
  mutatedManifestOf,
} from "../../benchmarks/validation/apps/economic-controls-direct/fixtures";
import type { LabVerificationCriterion } from "../../benchmarks/validation/platform/derive";
import type { ValidationRunRecord } from "../../benchmarks/validation/recorder/record";
import type { RunMetadata } from "../../benchmarks/validation/run-identity";

const REVISION = "4362068a11c0d2f7e5a4b6c8d9e0f1a2b3c4d5e6";

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
    configuration: { suite: "val-041-discrimination" },
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

const criterionOf = (
  result: { readonly criteria: readonly LabVerificationCriterion[] },
  id: string,
): LabVerificationCriterion | undefined =>
  result.criteria.find((criterion) => criterion.criterionId === id);

/** Build a REAL-shaped accounting aggregate literal for the derivation-level probes. */
function aggregateOf(
  runs: number,
  resolved: number,
  measuredMicroUsd: string,
  estimatedMicroUsd: string,
): ArmAggregate {
  const confidence = wilsonInterval(resolved, runs);
  return {
    arm: "probe",
    corpusSlice: "probe",
    runCount: runs,
    resolvedCount: resolved,
    resolutionRate: runs === 0 ? 0 : resolved / runs,
    resolutionConfidence: { low: confidence.low, high: confidence.high },
    measuredCostMicroUsd: measuredMicroUsd,
    estimatedCostMicroUsd: estimatedMicroUsd,
    costPerResolvedMicroUsd: resolved > 0 ? measuredMicroUsd : null,
    latency: { mean: 1, p95: 1, max: 1 },
  };
}

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

/** One synthetic driven round for the PURE derivation-level probes. */
function syntheticRound(input: {
  readonly taskId: string;
  readonly terminalStatus?: "COMPLETED" | "FAILED";
  readonly platformArtifacts?: readonly string[];
  readonly usageFacts?: readonly UsageFact[];
}): DirectDrivenRound {
  const status = input.terminalStatus ?? "COMPLETED";
  return {
    taskId: input.taskId,
    executed: true,
    attempts: 1,
    observed: {
      terminalStatus: status,
      verificationStatuses: status === "COMPLETED" ? ["PASS"] : [],
      responseText: status === "COMPLETED" ? "confirm" : null,
      outputShapeFields: [],
      environmentEffects: [],
      retryableErrorsSurfaced: 0,
    },
    usageFacts: [...(input.usageFacts ?? [])],
    latencyMs: 10,
    record: syntheticRecord(),
    evaluation: { verdict: status === "COMPLETED" ? "pass" : "fail" } as never,
    platformArtifacts: [...(input.platformArtifacts ?? [])],
    chargeObservationUsd: null,
  };
}

/** Drive one row over a purpose-built leaky stack (the discrimination harness). */
async function driveRowOverLeakyStack(options: {
  readonly row: DirectCorpusRow;
  readonly knobs?: DirectReplayExecutorKnobs;
  readonly manifestOverride?: PriceManifestRevision;
  readonly claimedThresholdMet?: boolean;
}): Promise<ReturnType<typeof driveDirectRow>> {
  const clock = createTickClock();
  const ledger = createFakeLedger(clock);
  const seam = createFakeSubmissionSeam({ ledger });
  const lifecycle = createFakeLifecycle({ ledger });
  const executor = createDirectReplayExecutor({
    row: options.row,
    clock,
    ...(options.knobs === undefined ? {} : { knobs: options.knobs }),
  });
  const baseline = ledger.facts();
  const submission = await seam({
    key: `val-041-disc-${options.row.rowId}`,
    body: taskBodyFor({ row: options.row }),
  });
  return driveDirectRow({
    row: options.row,
    lifecycle,
    executor,
    rails: createRealAccountingRails(),
    tasks: directTasksForArm(options.row.arm),
    metadata: metadataOf(clock.now().toISOString()),
    environmentIdentity: `val-041-disc-${options.row.rowId}`,
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
}

// ---------------------------------------------------------------------------
// Family 1: the PLATFORM-SHORTCUT masquerade (the verification core)
// ---------------------------------------------------------------------------

describe("discrimination: platform-shortcut masquerade", () => {
  test("the derivation-level catch: a smuggled artifact FAILs with the artifact named", () => {
    const arm = rowById("fixed-quality-direct-default-rail").arm;
    const verdict = deriveDirectPathConformance({
      arm,
      rounds: [
        syntheticRound({
          taskId: "val-041-direct-default#001",
          platformArtifacts: ["reuse-cache-signature:zeck-reuse-layer"],
        }),
      ],
    });
    expect(verdict.conformant).toBe(false);
    expect(verdict.evidence.join(" ")).toContain("reuse-cache-signature:zeck-reuse-layer");
  });

  test("the derivation-level catch: a misrouted measured fact FAILs with both rails named", () => {
    const arm = rowById("fixed-quality-direct-default-rail").arm;
    const verdict = deriveDirectPathConformance({
      arm,
      rounds: [
        syntheticRound({
          taskId: "val-041-direct-default#001",
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
        }),
      ],
    });
    expect(verdict.conformant).toBe(false);
    const evidence = verdict.evidence.join(" ");
    expect(evidence).toContain("misroutes:1");
    expect(evidence).toContain("euro-relay/euro-small-v1");
  });

  test("the row-level catch: a masquerading executor FAILs mechanically", async () => {
    const row = rowById("fixed-quality-direct-default-rail");
    const result = await driveRowOverLeakyStack({
      row,
      knobs: { shortcutArtifact: "platform-mediation-marker:agent-gateway" },
    });
    expect(result.terminal).toBe("FAILED");
    const conformance = criterionOf(result, "direct-path-conformance");
    expect(conformance?.status).toBe("FAIL");
    expect(conformance?.evidence.join(" ")).toContain("platform-mediation-marker:agent-gateway");
  });

  test("the row-level catch: the shortcut-riding PROBE row FAILs with both artifacts named", async () => {
    const row = rowById("probe-platform-shortcut-masquerade");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("FAILED");
    const conformance = criterionOf(result, "direct-path-conformance");
    expect(conformance?.status).toBe("FAIL");
    const evidence = conformance?.evidence.join(" ") ?? "";
    expect(evidence).toContain("reuse-cache-signature:zeck-reuse-layer");
    expect(evidence).toContain("platform-mediation-marker:agent-gateway");
  });

  test("the honest control: the direct dispatch over the pinned rail PASSES", async () => {
    const row = rowById("fixed-quality-direct-default-rail");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(criterionOf(result, "direct-path-conformance")?.status).toBe("PASS");
    expect(result.rounds.every((round) => round.platformArtifacts.length === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Family 2: the MIXED-CURRENCY conflation
// ---------------------------------------------------------------------------

describe("discrimination: mixed-currency conflation", () => {
  test("the derivation-level catch: GBP facts against the USD rail FAIL named", () => {
    const manifest = manifestFor("rev-001");
    const verdict = deriveDirectCostBasisIntegrity({
      rounds: [syntheticRound({ taskId: "probe#001" })],
      usageFacts: [
        {
          provider: "openrouter",
          model: "meta-llama/llama-3.3-70b-instruct",
          tier: "input",
          currency: "GBP",
          tokens: 120,
          kind: "measured",
          scope: "direct-execution",
        },
      ],
      manifest,
    });
    expect(verdict.conformant).toBe(false);
    expect(verdict.evidence.join(" ")).toContain("MIXED-CURRENCY CONFLATION");
  });

  test("the row-level catch: a GBP-denominated executor FAILs mechanically", async () => {
    const row = rowById("fixed-quality-direct-default-rail");
    const result = await driveRowOverLeakyStack({ row, knobs: { conflateCurrency: "GBP" } });
    expect(result.terminal).toBe("FAILED");
    const basis = criterionOf(result, "direct-cost-basis-measured");
    const integrity = criterionOf(result, "normalization-integrity");
    expect(basis?.status).toBe("FAIL");
    expect(integrity?.status).toBe("FAIL");
    expect(basis?.evidence.join(" ")).toContain("MIXED-CURRENCY CONFLATION");
  });

  test("the honest control: the EUR and JPY rails converge onto the SAME canonical basis", async () => {
    const euro = await driveRowOverLeakyStack({ row: rowById("fixed-quality-direct-euro-rail") });
    const tokyo = await driveRowOverLeakyStack({ row: rowById("fixed-quality-direct-tokyo-rail") });
    expect(euro.terminal).toBe("COMPLETED");
    expect(tokyo.terminal).toBe("COMPLETED");
    expect(criterionOf(euro, "direct-cost-basis-measured")?.status).toBe("PASS");
    expect(criterionOf(tokyo, "direct-cost-basis-measured")?.status).toBe("PASS");
    expect(euro.comparison?.measuredCostMicroUsd).not.toBe("0");
    expect(tokyo.comparison?.measuredCostMicroUsd).not.toBe("0");
    // The heterogeneous per-1M EUR / per-1K JPY denominations both
    // converge through the pinned FX table onto micro-USD.
    expect(euro.comparison?.measuredCostMicroUsd).toBe(
      rowById("fixed-quality-direct-euro-rail").expected.normalized?.measuredCostMicroUsd,
    );
    expect(tokyo.comparison?.measuredCostMicroUsd).toBe(
      rowById("fixed-quality-direct-tokyo-rail").expected.normalized?.measuredCostMicroUsd,
    );
  });
});

// ---------------------------------------------------------------------------
// Family 3: the ESTIMATE-BACKED cost-per-resolution
// ---------------------------------------------------------------------------

describe("discrimination: estimate-backed cost-per-resolution", () => {
  test("the derivation-level catch: resolved rounds with ONLY estimate facts FAIL named", () => {
    const manifest = manifestFor("rev-001");
    const verdict = deriveDirectCostBasisIntegrity({
      rounds: [syntheticRound({ taskId: "probe#001" })],
      usageFacts: [
        {
          provider: "openrouter",
          model: "meta-llama/llama-3.3-70b-instruct",
          tier: "input",
          currency: "USD",
          tokens: 120,
          kind: "estimate",
          scope: "direct-execution",
        },
      ],
      manifest,
    });
    expect(verdict.conformant).toBe(false);
    expect(verdict.evidence.join(" ")).toContain("ESTIMATE-BACKED COST");
  });

  test("the row-level catch: an estimate-only executor FAILs mechanically", async () => {
    const row = rowById("fixed-quality-direct-default-rail");
    const result = await driveRowOverLeakyStack({ row, knobs: { estimateOnly: true } });
    expect(result.terminal).toBe("FAILED");
    const basis = criterionOf(result, "direct-cost-basis-measured");
    expect(basis?.status).toBe("FAIL");
    expect(basis?.evidence.join(" ")).toContain("ESTIMATE-BACKED COST");
  });

  test("the honest control: measured facts + a separate quote PASS (never conflated)", async () => {
    const row = rowById("fixed-quality-direct-default-rail");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(criterionOf(result, "direct-cost-basis-measured")?.status).toBe("PASS");
    // The first round's provider-side quote rides as a SEPARATE
    // estimate basis — never inside the measured cost-per-resolved.
    expect(result.comparison?.estimatedCostMicroUsd).not.toBe("0");
    expect(result.comparison?.measuredCostMicroUsd).not.toBe("0");
    expect(result.comparison?.costPerResolvedMicroUsd).toBe(
      result.comparison?.measuredCostMicroUsd === "0"
        ? null
        : result.comparison?.costPerResolvedMicroUsd,
    );
  });
});

// ---------------------------------------------------------------------------
// Family 4: the POST-HOC ARM EXCLUSION
// ---------------------------------------------------------------------------

describe("discrimination: post-hoc arm exclusion", () => {
  test("the derivation-level catch: a skipped non-resolved task FAILs with the task named", () => {
    const row = rowById("fixed-quality-direct-euro-rail");
    const verdict = deriveDirectSampleDiscipline({
      row,
      rounds: row.arm.corpusSlice
        .slice(0, 5)
        .map((taskId) => syntheticRound({ taskId, terminalStatus: "COMPLETED" })),
      skippedTaskIds: [row.arm.corpusSlice[3] ?? "unknown"],
      budgetStopAfter: null,
    });
    expect(verdict.conformant).toBe(false);
    expect(verdict.evidence.join(" ")).toContain(
      `post-hoc-excluded:${row.arm.corpusSlice[3] ?? "unknown"}`,
    );
  });

  test("the row-level catch: an executor dropping the failed rounds FAILs mechanically", async () => {
    const row = rowById("fixed-quality-direct-euro-rail");
    const result = await driveRowOverLeakyStack({ row, knobs: { dropFailedRounds: true } });
    expect(result.terminal).toBe("FAILED");
    const discipline = criterionOf(result, "direct-sample-discipline");
    expect(discipline?.status).toBe("FAIL");
    expect(discipline?.evidence.join(" ")).toContain("post-hoc-excluded:");
  });

  test("the honest control: the honest failure STAYS in the executed slice", async () => {
    const row = rowById("fixed-quality-direct-euro-rail");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(criterionOf(result, "direct-sample-discipline")?.status).toBe("PASS");
    // The content-policy failure is a DATA POINT: the full
    // pre-registered slice executed (6 rounds, none skipped).
    expect(result.rounds).toHaveLength(row.arm.corpusSlice.length);
    expect(result.comparison?.sliceConformant ?? false).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Family 5: the SAMPLE-SIZE VIOLATION (the honest budget-stop PREFIX)
// ---------------------------------------------------------------------------

describe("discrimination: sample-size violation", () => {
  test("the derivation-level catch: a below-minimum executed sample FAILs named", () => {
    const row = rowById("fixed-quality-direct-default-rail");
    const verdict = deriveDirectSampleDiscipline({
      row,
      rounds: row.arm.corpusSlice.slice(0, 3).map((taskId) => syntheticRound({ taskId })),
      skippedTaskIds: [],
      budgetStopAfter: null,
    });
    expect(verdict.conformant).toBe(false);
    expect(verdict.evidence.join(" ")).toContain("SAMPLE-STARVED");
  });

  test("the row-level catch: a truncating executor FAILs the sufficiency oracle", async () => {
    const row = rowById("fixed-quality-direct-default-rail");
    const result = await driveRowOverLeakyStack({ row, knobs: { truncateSamples: 3 } });
    expect(result.terminal).toBe("FAILED");
    const discipline = criterionOf(result, "direct-sample-discipline");
    expect(discipline?.status).toBe("FAIL");
    expect(discipline?.evidence.join(" ")).toContain("SAMPLE-STARVED");
  });

  test("the honest control: the at-minimum executed sample PASSES", async () => {
    const row = rowById("fixed-quality-direct-euro-rail");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.rounds).toHaveLength(row.arm.minimumSamples);
    expect(result.comparison?.samplesSufficient ?? false).toBe(true);
  });

  test("the honest budget-stop PREFIX is the honest stop, never an exclusion", async () => {
    const row = rowById("fixed-cost-direct-budget-exhausted-honest-stop");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(criterionOf(result, "direct-sample-discipline")?.status).toBe("PASS");
    // The declared prefix stop: 3 of 8 pre-registered rounds executed
    // (the budget gate fired BEFORE the fourth dispatch), the executed
    // prefix holds the minimum (3), and the stop is a prefix — never a
    // post-hoc exclusion of a failed round.
    expect(result.budgetStopAfter).toBe(3);
    expect(result.rounds).toHaveLength(3);
    expect(criterionOf(result, "budget-stop-honesty")?.status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// Family 6: the MUTATED / UNPINNED PRICING (the manifest integrity)
// ---------------------------------------------------------------------------

describe("discrimination: mutated and unpinned pricing", () => {
  test("the row-level catch: a MUTATED manifest table with a stale digest FAILs", async () => {
    const row = rowById("fixed-quality-direct-default-rail");
    const mutatedManifest = mutatedManifestOf("rev-001", {
      provider: "openrouter",
      tier: "input",
      price: "0.01",
    });
    const result = await driveRowOverLeakyStack({ row, manifestOverride: mutatedManifest });
    expect(result.terminal).toBe("FAILED");
    const integrity = criterionOf(result, "direct-manifest-integrity");
    expect(integrity?.status).toBe("FAIL");
    expect(integrity?.evidence.join(" ")).toContain("selfDigest:DISAGREED");
  });

  test("the row-level catch: an UNPINNED revision the arm does not declare FAILs", async () => {
    const row = rowById("fixed-quality-direct-default-rail");
    // The arm pins rev-001; the runs are priced through the corrected
    // rev-002 table — an honest correction, but NOT the declared one.
    const result = await driveRowOverLeakyStack({
      row,
      manifestOverride: manifestFor("rev-002"),
    });
    expect(result.terminal).toBe("FAILED");
    const integrity = criterionOf(result, "direct-manifest-integrity");
    expect(integrity?.status).toBe("FAIL");
    expect(integrity?.evidence.join(" ")).toContain("UNPINNED");
  });

  test("the honest control: the arm's own pinned corrected revision PASSES", async () => {
    const row = rowById("fixed-quality-direct-corrected-price");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(criterionOf(result, "direct-manifest-integrity")?.status).toBe("PASS");
    expect(criterionOf(result, "manifest-integrity")?.status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// Family 7: the WILSON-confidence application (the frozen battery)
// ---------------------------------------------------------------------------

describe("discrimination: the Wilson-confidence application", () => {
  test("the derivation-level catch: a CONFIDENCE-LESS comparison FAILs the battery", () => {
    const row = rowById("fixed-quality-direct-default-rail");
    const comparison = deriveNormalizedComparison({
      arm: row.arm,
      aggregate: aggregateOf(8, 7, "210", "17"),
      executedTaskIds: row.arm.corpusSlice,
    });
    const confidenceless = {
      ...comparison,
      resolutionConfidence: null,
    };
    const violations = validateNormalizedComparison(confidenceless);
    expect(violations.some((violation) => violation.reason.includes("CONFIDENCE-LESS"))).toBe(true);
  });

  test("the honest control: every comparison carries the Wilson 95% interval", async () => {
    const row = rowById("fixed-quality-direct-default-rail");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    const confidence = result.comparison?.resolutionConfidence;
    expect(confidence).not.toBeNull();
    const resolved = result.comparison?.resolvedCount ?? 0;
    const runs = result.comparison?.runCount ?? 0;
    if (confidence !== null && confidence !== undefined) {
      expect(confidence.low).toBeLessThanOrEqual(resolved / runs);
      expect(confidence.high).toBeGreaterThanOrEqual(resolved / runs);
      const pinned = wilsonInterval(resolved, runs);
      expect(confidence.low).toBeCloseTo(pinned.low, 12);
      expect(confidence.high).toBeCloseTo(pinned.high, 12);
    }
    expect(criterionOf(result, "accounting-rails-aggregate")?.status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// Family 8: the DIGEST discipline
// ---------------------------------------------------------------------------

describe("discrimination: the digest discipline", () => {
  test("the economic digest is deterministic and discriminating", () => {
    const shape = { arm: "fq-direct-default", slice: 8, minimum: 8 };
    expect(economicDigestOf(shape)).toBe(economicDigestOf({ ...shape }));
    expect(economicDigestOf(shape)).not.toBe(economicDigestOf({ ...shape, minimum: 7 }));
  });

  test("the request digests separate honest and masquerading dispatches", async () => {
    const row = rowById("fixed-quality-direct-default-rail");
    const honest = await driveRowOverLeakyStack({ row });
    const masquerade = await driveRowOverLeakyStack({
      row,
      knobs: { shortcutArtifact: "reuse-cache-signature:zeck-reuse-layer" },
    });
    expect(honest.terminal).toBe("COMPLETED");
    expect(masquerade.terminal).toBe("FAILED");
    const honestDigest = economicDigestOf(
      honest.rounds.map((round) => [round.taskId, round.platformArtifacts]),
    );
    const leakyDigest = economicDigestOf(
      masquerade.rounds.map((round) => [round.taskId, round.platformArtifacts]),
    );
    expect(honestDigest).not.toBe(leakyDigest);
  });
});

// ---------------------------------------------------------------------------
// Family 9: the honest controls over the whole fixture stack
// ---------------------------------------------------------------------------

describe("discrimination: the honest controls over the fixture stack", () => {
  test("every honest control row COMPLETES over the honest stack", async () => {
    for (const row of OFFLINE_CONTROL_ROWS) {
      const result = await driveRowOverLeakyStack({ row });
      expect(result.terminal, `${row.rowId} terminal`).toBe("COMPLETED");
      const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
      expect(failed, `${row.rowId}: ${JSON.stringify(failed)}`).toEqual([]);
      expect(result.observedTerminal).toBe("COMPLETED");
    }
  });

  test("every adversarial PROBE row FAILs its NAMED criterion honestly", async () => {
    const named: Readonly<Record<string, string>> = {
      "probe-platform-shortcut-masquerade": "direct-path-conformance",
      "probe-mixed-currency-conflation": "direct-cost-basis-measured",
      "probe-estimate-backed-cost": "direct-cost-basis-measured",
      "probe-post-hoc-arm-exclusion": "direct-sample-discipline",
      "probe-sample-size-violation": "direct-sample-discipline",
    };
    for (const row of PROBE_ROWS) {
      const result = await driveRowOverLeakyStack({ row });
      expect(result.terminal, `${row.rowId} terminal`).toBe("FAILED");
      const criterion = criterionOf(result, named[row.rowId] ?? "");
      expect(criterion?.status, `${row.rowId} ${named[row.rowId] ?? "?"}`).toBe("FAIL");
      // The honest failure shape: the row's own read-back agrees and
      // the observed terminal is FAILED (never a fabricated pass).
      expect(result.observedTerminal).toBe("FAILED");
      expect(criterionOf(result, "observed-terminal-readback")?.status).toBe("PASS");
    }
  });
});

// ---------------------------------------------------------------------------
// Family 10: the AC4 probes (the mechanical verification battery)
// ---------------------------------------------------------------------------

describe("discrimination: the AC4 probes", () => {
  test("a below-minimum arm declaration FAILs the frozen grammar", () => {
    const row = rowById("fixed-quality-direct-default-rail");
    const belowMinimum = {
      ...row.arm,
      minimumSamples: 12,
    };
    expect(validateArmDeclaration(belowMinimum).length).toBeGreaterThan(0);
  });

  test("a declared-digest disagreement FAILs the manifest integrity", () => {
    const verdict = deriveManifestIntegrity({
      revision: "rev-001",
      declaredDigest: "sha256:not-the-pinned-digest",
    });
    expect(verdict.digestAgrees).toBe(false);
    expect(verdict.agreed).toBe(false);
    const direct = deriveDirectManifestIntegrity({
      manifest: manifestFor("rev-001"),
      arm: rowById("fixed-quality-direct-default-rail").arm,
    });
    expect(direct.conformant).toBe(true);
    // The mutated table carries the SAME declared digest while its
    // content changed — the self-digest disagreement is mechanical.
    const mutated = deriveDirectManifestIntegrity({
      manifest: mutatedManifestOf("rev-001", {
        provider: "openrouter",
        tier: "input",
        price: "0.01",
      }),
      arm: rowById("fixed-quality-direct-default-rail").arm,
    });
    expect(mutated.conformant).toBe(false);
  });
});
