/**
 * VAL-043 acceptance criterion 6 — discrimination tests proving the
 * competing-stack arm against controlled fakes (every family FAILS
 * mechanically; every family has an honest control that PASSES):
 *
 *   * UNDECLARED CONFIGURATION MASQUERADE — an executor that applies
 *     (and reports) a setting the declared configuration does not
 *     name: the configuration-conformance oracle FAILs (the
 *     verification core — something the competitor does that its
 *     declared configuration does not name is mechanically visible);
 *   * SILENT ROUTING CHANGE — the competitor's pool routing
 *     equivalent requests to different endpoints under a PINNED-
 *     ORDERING configuration (variance "none"): the behavior-variance
 *     oracle FAILs (a competitor behavior change between runs must be
 *     declared as honest variance, with the confidence carried);
 *   * MIXED-CURRENCY CONFLATION — usage denominated in a currency
 *     that mismatches the routed rail's pinned price denomination
 *     (GBP sits outside the pinned FX table): the normalization
 *     FAILs;
 *   * ESTIMATE-BACKED COST-PER-RESOLUTION — requests that report ONLY
 *     quotes (no measured usage) with resolved outcomes: the
 *     comparison FAILs (estimates never conflate);
 *   * POST-HOC ARM EXCLUSION — an executor that drops the failed
 *     requests from the executed slice: the slice-conformance oracle
 *     FAILs;
 *   * SAMPLE-SIZE VIOLATION — an executor that truncates the sample
 *     below the declared statistical minimum: the sufficiency oracle
 *     FAILs;
 *   * MUTATED CONFIGURATION — an arm declaring a configuration
 *     revision whose bound was edited IN PLACE (stale digest): the
 *     configuration-integrity agreement FAILs;
 *   * UNPINNED PRICING — an arm priced against a MUTATED manifest
 *     table (an in-place price edit with a stale digest): the
 *     manifest-integrity agreement FAILs;
 *   * ROUTING DEVIATION — a class routed onto a rail the
 *     model-selection table does not declare for it: the
 *     model-selection-conformance oracle FAILs;
 *   * UNDECLARED RETRY ESCALATION — a request reporting more internal
 *     attempts than the recorded trace / the declared posture: the
 *     retry-posture and replay-fidelity oracles FAIL;
 *   * FABRICATED OBSERVATION — an endpoint observation that
 *     contradicts the recorded trace: the replay-fidelity oracle
 *     FAILs;
 *   * the AC4 probes: the below-minimum arm, the CONFIDENCE-LESS
 *     comparison and the declared-digest disagreement each FAIL
 *     mechanically.
 */

import { describe, expect, test } from "vitest";
import type { ArmAggregate } from "../../benchmarks/validation/accounting/aggregate";
import type { PriceManifestRevision } from "../../benchmarks/validation/apps/economic-baseline/pricing";
import {
  deriveNormalizedComparison,
  deriveSampleSufficiency,
  validateArmDeclaration,
  validateNormalizedComparison,
  wilsonInterval,
} from "../../benchmarks/validation/apps/economic-baseline/protocol";
import type { CompetitorConfigRevision } from "../../benchmarks/validation/apps/economic-controls-competing/competitor-config";
import {
  competitorConfigFor,
  deriveBehaviorVariance,
  deriveCompetitorConfigConformance,
  deriveCompetitorConfigIntegrity,
} from "../../benchmarks/validation/apps/economic-controls-competing/competitor-config";
import {
  COMPETING_CORPUS,
  COMPETING_CORPUS_VERSION,
  competingTasksForArm,
  taskBodyFor,
} from "../../benchmarks/validation/apps/economic-controls-competing/corpus";
import {
  type CompetingCorpusRow,
  createRealAccountingRails,
  driveCompetingRow,
} from "../../benchmarks/validation/apps/economic-controls-competing/driver";
import {
  type CompetingReplayExecutorKnobs,
  createCompetingReplayExecutor,
  createFakeLedger,
  createFakeLifecycle,
  createFakeSubmissionSeam,
  createTickClock,
  mutatedCompetitorConfigOf,
  mutatedManifestOf,
  pinnedOrderingConfigOf,
} from "../../benchmarks/validation/apps/economic-controls-competing/fixtures";
import type { RunMetadata } from "../../benchmarks/validation/run-identity";

const REVISION = "054a041530ecffe0f82df8faf343fc5ece3b1046";

const noSleep = async () => {};

const metadataOf = (observedAt: string): RunMetadata => ({
  program: "zeck-validation",
  workOrder: "VAL-043",
  baseRevision: REVISION,
  applicationRevision: REVISION,
  corpusRevision: REVISION,
  integrationSurface: "stack:openrouter",
  environment: {
    runtime: "node test",
    toolchain: "vitest",
    database: "none",
    configuration: { suite: "val-043-discrimination" },
  },
  observedAt,
});

const rowById = (rowId: string): CompetingCorpusRow => {
  const row = COMPETING_CORPUS.find((candidate) => candidate.rowId === rowId);
  if (row === undefined) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

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

/** Drive one row over a purpose-built leaky stack. */
async function driveRowOverLeakyStack(options: {
  readonly row: CompetingCorpusRow;
  readonly knobs?: CompetingReplayExecutorKnobs;
  readonly manifestOverride?: PriceManifestRevision;
  readonly configOverride?: CompetitorConfigRevision;
  readonly claimedThresholdMet?: boolean;
}): Promise<ReturnType<typeof driveCompetingRow>> {
  const clock = createTickClock();
  const ledger = createFakeLedger(clock);
  const seam = createFakeSubmissionSeam({ ledger });
  const lifecycle = createFakeLifecycle({ ledger });
  const executor = createCompetingReplayExecutor({
    row: options.row,
    clock,
    ...(options.knobs === undefined ? {} : { knobs: options.knobs }),
  });
  const baseline = ledger.facts();
  const submission = await seam({
    key: `val-043-disc-${options.row.rowId}`,
    body: taskBodyFor({ row: options.row }),
  });
  return driveCompetingRow({
    row: options.row,
    lifecycle,
    executor,
    rails: createRealAccountingRails(),
    tasks: competingTasksForArm(options.row.arm),
    metadata: metadataOf(clock.now().toISOString()),
    environmentIdentity: `val-043-disc-${options.row.rowId}`,
    corpusVersion: COMPETING_CORPUS_VERSION,
    baseline,
    worldFacts: ledger.facts,
    landedProvider: async () => [submission.executionId],
    retry: { maxExtraAttempts: 2, backoffMs: 1, sleep: noSleep },
    now: clock.now,
    ...(options.manifestOverride === undefined
      ? {}
      : { manifestOverride: options.manifestOverride }),
    ...(options.configOverride === undefined ? {} : { configOverride: options.configOverride }),
    ...(options.claimedThresholdMet === undefined
      ? {}
      : { claimedThresholdMet: options.claimedThresholdMet }),
  });
}

// ---------------------------------------------------------------------------
// Family 1: the UNDECLARED CONFIGURATION masquerade (the verification core)
// ---------------------------------------------------------------------------

describe("discrimination: undeclared-configuration masquerade", () => {
  test("the derivation-level catch: an applied setting outside the declaration FAILs", () => {
    const row = rowById("fixed-quality-competitor-default-routing");
    const config = competitorConfigFor(row.competitorConfigRevision);
    const verdict = deriveCompetitorConfigConformance({
      config,
      appliedSettings: ["model-selection-by-task-class", "negotiated-rate-side-channel"],
    });
    expect(verdict.conformant).toBe(false);
    expect(verdict.undeclared).toEqual(["negotiated-rate-side-channel"]);
  });

  test("the row-level catch: a masquerading executor FAILs mechanically", async () => {
    const row = rowById("fixed-quality-competitor-default-routing");
    const result = await driveRowOverLeakyStack({
      row,
      knobs: { undeclaredToggle: "undocumented-preference-toggle" },
    });
    expect(result.terminal).toBe("FAILED");
    const conformance = result.criteria.find((c) => c.criterionId === "configuration-conformance");
    expect(conformance?.status).toBe("FAIL");
    expect(conformance?.evidence.join(" ")).toContain("undocumented-preference-toggle");
  });

  test("the honest control: the declared configuration set PASSES", async () => {
    const row = rowById("fixed-quality-competitor-default-routing");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.criteria.find((c) => c.criterionId === "configuration-conformance")?.status).toBe(
      "PASS",
    );
  });
});

// ---------------------------------------------------------------------------
// Family 2: the SILENT ROUTING CHANGE (the reproducibility oracle)
// ---------------------------------------------------------------------------

describe("discrimination: silent routing change", () => {
  test("the derivation-level catch: observed variance under a PINNED-ordering config FAILs", () => {
    const row = rowById("fixed-quality-competitor-routed-classes");
    const pinned = pinnedOrderingConfigOf(row.competitorConfigRevision);
    // The row's own summarize class records differing endpoints (the
    // honest trace) — under the pinned-ordering config that variance
    // is a silent routing change.
    const verdict = deriveBehaviorVariance({
      config: pinned,
      observations: [
        { taskClass: "summarize", routedEndpoint: "retry-pool-primary" },
        { taskClass: "summarize", routedEndpoint: "retry-pool-secondary" },
      ],
    });
    expect(verdict.varianceObserved).toBe(true);
    expect(verdict.conformant).toBe(false);
  });

  test("the row-level catch: the varying trace under the pinned-ordering config FAILs", async () => {
    const row = rowById("fixed-quality-competitor-routed-classes");
    const result = await driveRowOverLeakyStack({
      row,
      configOverride: pinnedOrderingConfigOf(row.competitorConfigRevision),
    });
    expect(result.terminal).toBe("FAILED");
    const variance = result.criteria.find((c) => c.criterionId === "behavior-variance-declared");
    expect(variance?.status).toBe("FAIL");
    expect(variance?.evidence.join(" ")).toContain("SILENT ROUTING CHANGE");
  });

  test("the honest control: the SAME variance under the DECLARED config PASSES", async () => {
    const row = rowById("fixed-quality-competitor-routed-classes");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    const variance = result.criteria.find((c) => c.criterionId === "behavior-variance-declared");
    expect(variance?.status).toBe("PASS");
    expect(variance?.evidence.join(" ")).toContain("honest variance");
  });

  test("the honest control: identical endpoints under the pinned-ordering config PASS", async () => {
    const row = rowById("fixed-quality-competitor-eu-catalog");
    const result = await driveRowOverLeakyStack({
      row,
      configOverride: pinnedOrderingConfigOf(row.competitorConfigRevision),
    });
    expect(result.terminal).toBe("COMPLETED");
    const variance = result.criteria.find((c) => c.criterionId === "behavior-variance-declared");
    expect(variance?.status).toBe("PASS");
    expect(variance?.evidence.join(" ")).toContain("reproduced");
  });
});

// ---------------------------------------------------------------------------
// Family 3: the MIXED-CURRENCY conflation
// ---------------------------------------------------------------------------

describe("discrimination: mixed-currency conflation", () => {
  test("the row-level catch: GBP-denominated usage against the USD rails FAILs mechanically", async () => {
    const row = rowById("fixed-quality-competitor-default-routing");
    const result = await driveRowOverLeakyStack({ row, knobs: { conflateCurrency: "GBP" } });
    expect(result.terminal).toBe("FAILED");
    const normalization = result.criteria.find((c) => c.criterionId === "normalization-integrity");
    expect(normalization?.status).toBe("FAIL");
  });

  test("the honest control: the routed rails' own denominations converge", async () => {
    const row = rowById("fixed-quality-competitor-eu-catalog");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.criteria.find((c) => c.criterionId === "normalization-integrity")?.status).toBe(
      "PASS",
    );
  });
});

// ---------------------------------------------------------------------------
// Family 4: the ESTIMATE-BACKED cost-per-resolution
// ---------------------------------------------------------------------------

describe("discrimination: estimate-backed cost-per-resolution", () => {
  test("the comparison-level catch: the estimate-backed comparison FAILs", () => {
    const row = rowById("fixed-quality-competitor-default-routing");
    const comparison = deriveNormalizedComparison({
      arm: row.arm,
      aggregate: aggregateOf(8, 8, "0", "210"),
      executedTaskIds: row.arm.corpusSlice,
    });
    expect(comparison.estimateBacking).toBe(true);
    const violations = validateNormalizedComparison(comparison);
    expect(
      violations.some((violation) =>
        violation.reason.includes("ESTIMATE-BACKED COST-PER-RESOLUTION"),
      ),
    ).toBe(true);
  });

  test("the row-level catch: an estimate-only executor FAILs mechanically", async () => {
    const row = rowById("fixed-quality-competitor-default-routing");
    const result = await driveRowOverLeakyStack({ row, knobs: { estimateOnly: true } });
    expect(result.terminal).toBe("FAILED");
    const protocol = result.criteria.find((c) => c.criterionId === "protocol-comparison-valid");
    expect(protocol?.status).toBe("FAIL");
    expect(protocol?.evidence.join(" ")).toContain("ESTIMATE-BACKED");
  });

  test("the honest control: measured facts + a separate quote PASS", async () => {
    const row = rowById("fixed-quality-competitor-default-routing");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.comparison?.estimatedCostMicroUsd).toBe("17");
    expect(result.comparison?.measuredCostMicroUsd).toBe("210");
  });
});

// ---------------------------------------------------------------------------
// Family 5: the POST-HOC ARM EXCLUSION
// ---------------------------------------------------------------------------

describe("discrimination: post-hoc arm exclusion", () => {
  test("the derivation-level catch: a dropped non-resolved task FAILs conformance", () => {
    const row = rowById("fixed-cost-competitor-within-budget");
    // The executed slice drops the failed round — not the full
    // pre-registered slice and not a prefix.
    const executed = row.arm.corpusSlice.filter((taskId) => taskId !== row.arm.corpusSlice[2]);
    const comparison = deriveNormalizedComparison({
      arm: row.arm,
      aggregate: aggregateOf(5, 5, "110", "0"),
      executedTaskIds: executed,
    });
    expect(comparison.sliceConformant).toBe(false);
    expect(
      validateNormalizedComparison(comparison).some((violation) =>
        violation.reason.includes("POST-HOC ARM EXCLUSION"),
      ),
    ).toBe(true);
  });

  test("the row-level catch: an executor dropping the failed requests FAILs mechanically", async () => {
    const row = rowById("fixed-cost-competitor-within-budget");
    const result = await driveRowOverLeakyStack({ row, knobs: { dropFailedRounds: true } });
    expect(result.terminal).toBe("FAILED");
    const protocol = result.criteria.find((c) => c.criterionId === "protocol-comparison-valid");
    expect(protocol?.status).toBe("FAIL");
    expect(protocol?.evidence.join(" ")).toContain("POST-HOC ARM EXCLUSION");
  });

  test("the honest control: the failed requests stay in the executed slice", async () => {
    const row = rowById("fixed-cost-competitor-within-budget");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.comparison?.sliceConformant ?? false).toBe(true);
    expect(result.rounds).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// Family 6: the SAMPLE-SIZE VIOLATION
// ---------------------------------------------------------------------------

describe("discrimination: sample-size violation", () => {
  test("the derivation-level catch: a below-minimum executed sample FAILs", () => {
    const row = rowById("fixed-quality-competitor-default-routing");
    const verdict = deriveSampleSufficiency({ arm: row.arm, executedCount: 3 });
    expect(verdict.sufficient).toBe(false);
  });

  test("the row-level catch: a truncating executor FAILs the sufficiency oracle", async () => {
    const row = rowById("fixed-quality-competitor-default-routing");
    const result = await driveRowOverLeakyStack({ row, knobs: { truncateSamples: 3 } });
    expect(result.terminal).toBe("FAILED");
    const protocol = result.criteria.find((c) => c.criterionId === "protocol-comparison-valid");
    expect(protocol?.status).toBe("FAIL");
    expect(protocol?.evidence.join(" ")).toContain("SAMPLE-SIZE VIOLATION");
  });

  test("the honest control: the full pre-registered slice PASSES", async () => {
    const row = rowById("fixed-quality-competitor-default-routing");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.comparison?.samplesSufficient ?? false).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Family 7: the MUTATED CONFIGURATION (the digest agreement)
// ---------------------------------------------------------------------------

describe("discrimination: mutated configuration", () => {
  test("the derivation-level catch: an in-place bound edit breaks the digest agreement", () => {
    const mutated = mutatedCompetitorConfigOf("cmp-rev-001", {
      name: "automatic-provider-fallback",
      bound: { maxInternalRetries: 99 },
    });
    const verdict = deriveCompetitorConfigIntegrity({
      revision: "cmp-rev-001",
      registry: [mutated],
    });
    expect(verdict.digestAgrees).toBe(false);
    expect(verdict.agreed).toBe(false);
  });

  test("the row-level catch: an arm declaring the mutated configuration FAILs mechanically", async () => {
    const row = rowById("fixed-quality-competitor-default-routing");
    const mutated = mutatedCompetitorConfigOf(row.competitorConfigRevision, {
      name: "automatic-provider-fallback",
      bound: { maxInternalRetries: 99 },
    });
    const result = await driveRowOverLeakyStack({ row, configOverride: mutated });
    expect(result.terminal).toBe("FAILED");
    const integrity = result.criteria.find((c) => c.criterionId === "configuration-integrity");
    expect(integrity?.status).toBe("FAIL");
    expect(integrity?.evidence.join(" ")).toContain("digest:DISAGREED");
  });

  test("the honest control: the pinned configuration revision PASSES", async () => {
    const row = rowById("fixed-quality-competitor-corrected-config");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.criteria.find((c) => c.criterionId === "configuration-integrity")?.status).toBe(
      "PASS",
    );
  });
});

// ---------------------------------------------------------------------------
// Family 8: the UNPINNED PRICING (the mutated manifest)
// ---------------------------------------------------------------------------

describe("discrimination: unpinned pricing", () => {
  test("the row-level catch: a MUTATED manifest table with a stale digest FAILs", async () => {
    const row = rowById("fixed-quality-competitor-default-routing");
    const mutatedManifest = mutatedManifestOf("rev-001", {
      provider: "openrouter",
      tier: "input",
      price: "0.01",
    });
    const result = await driveRowOverLeakyStack({
      row,
      manifestOverride: mutatedManifest,
    });
    expect(result.terminal).toBe("FAILED");
    const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
    expect(failed.map((criterion) => criterion.criterionId)).toContain("protocol-comparison-valid");
    expect(
      failed
        .find((criterion) => criterion.criterionId === "protocol-comparison-valid")
        ?.evidence.join(" ")
        .includes("UNPINNED PRICING"),
    ).toBe(true);
  });

  test("the honest control: the pinned revision's manifest integrity PASSES", async () => {
    const row = rowById("fixed-quality-competitor-default-routing");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.criteria.find((c) => c.criterionId === "manifest-integrity")?.status).toBe(
      "PASS",
    );
  });
});

// ---------------------------------------------------------------------------
// Family 9: the ROUTING DEVIATION (the model-selection table)
// ---------------------------------------------------------------------------

describe("discrimination: routing deviation", () => {
  test("the row-level catch: a class routed onto an undeclared rail FAILs", async () => {
    const row = rowById("fixed-quality-competitor-routed-classes");
    const result = await driveRowOverLeakyStack({
      row,
      knobs: { misrouteClass: "summarize" },
    });
    expect(result.terminal).toBe("FAILED");
    const misroute = result.criteria.find((c) => c.criterionId === "model-selection-conformance");
    expect(misroute?.status).toBe("FAIL");
    expect(misroute?.evidence.join(" ")).toContain("misrouted");
  });

  test("the honest control: every request rode the declared rail", async () => {
    const row = rowById("fixed-quality-competitor-routed-classes");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(
      result.criteria.find((c) => c.criterionId === "model-selection-conformance")?.status,
    ).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// Family 10: the UNDECLARED RETRY ESCALATION
// ---------------------------------------------------------------------------

describe("discrimination: undeclared retry escalation", () => {
  test("the row-level catch: a request exceeding the declared posture FAILs", async () => {
    const row = rowById("fixed-quality-competitor-default-routing");
    // +3 on the eighth request's recorded 3 internal attempts → 6
    // attempts, beyond cmp-rev-001's declared 2-retry bound (3 max).
    const result = await driveRowOverLeakyStack({
      row,
      knobs: { exceedInternalAttempts: 3 },
    });
    expect(result.terminal).toBe("FAILED");
    const posture = result.criteria.find((c) => c.criterionId === "retry-posture-conformance");
    expect(posture?.status).toBe("FAIL");
    expect(posture?.evidence.join(" ")).toContain("exceeded");
  });

  test("the honest control: the recorded internal attempts stay within the bound", async () => {
    const row = rowById("fixed-quality-competitor-corrected-config");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.criteria.find((c) => c.criterionId === "retry-posture-conformance")?.status).toBe(
      "PASS",
    );
  });
});

// ---------------------------------------------------------------------------
// Family 11: the FABRICATED OBSERVATION (the trace contradiction)
// ---------------------------------------------------------------------------

describe("discrimination: fabricated observation", () => {
  test("the row-level catch: an endpoint observation contradicting the trace FAILs", async () => {
    const row = rowById("fixed-quality-competitor-eu-catalog");
    const result = await driveRowOverLeakyStack({
      row,
      knobs: { fabricateEndpoint: "pool-shadow-fabricated" },
    });
    expect(result.terminal).toBe("FAILED");
    const fidelity = result.criteria.find((c) => c.criterionId === "replay-fidelity");
    expect(fidelity?.status).toBe("FAIL");
    expect(fidelity?.evidence.join(" ")).toContain("endpoint");
  });
});

// ---------------------------------------------------------------------------
// The AC4 probes (the mechanical verification battery)
// ---------------------------------------------------------------------------

describe("discrimination: the AC4 probes", () => {
  test("a below-minimum arm declaration FAILs the frozen grammar", () => {
    const row = rowById("fixed-quality-competitor-default-routing");
    const belowMinimum = {
      ...row.arm,
      minimumSamples: 12,
    };
    expect(validateArmDeclaration(belowMinimum).length).toBeGreaterThan(0);
  });

  test("a CONFIDENCE-LESS comparison FAILs the validation battery", () => {
    const row = rowById("fixed-quality-competitor-default-routing");
    const comparison = deriveNormalizedComparison({
      arm: row.arm,
      aggregate: aggregateOf(8, 8, "210", "17"),
      executedTaskIds: row.arm.corpusSlice,
    });
    const confidenceless = {
      ...comparison,
      resolutionConfidence: null,
    };
    const violations = validateNormalizedComparison(confidenceless);
    expect(violations.some((violation) => violation.reason.includes("CONFIDENCE-LESS"))).toBe(true);
  });

  test("a declared-digest disagreement FAILs the configuration integrity", () => {
    const row = rowById("fixed-quality-competitor-default-routing");
    const verdict = deriveCompetitorConfigIntegrity({
      revision: row.competitorConfigRevision,
      declaredDigest: "sha256:not-the-pinned-digest",
    });
    expect(verdict.digestAgrees).toBe(false);
    expect(verdict.agreed).toBe(false);
  });
});
