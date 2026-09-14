/**
 * VAL-044 acceptance criteria 4, 5 and 6 (the driver's oracles + the
 * discrimination floor): the adjusted-cost synthesis's mechanical
 * verification over the three RECORDED control arms.
 *
 *   * the five oracle matrices: the quality-adjustment honesty (an
 *     honest verified denominator passes; a quality-inflated claim
 *     FAILs named), the latency-adjustment inclusion (an honest
 *     weighted comparison passes; a latency-omitting one FAILs
 *     named), the failure-adjustment completeness (full amortization
 *     passes; failure hiding FAILs named), the estimate/measure
 *     separation (honest separation passes; conflation FAILs named)
 *     and the confidence-and-minimum enforcement (Wilson carried,
 *     minimums held, no post-hoc arm exclusion; a below-minimum
 *     comparability claim FAILs named);
 *   * the input-integrity matrix: the honest digest-referenced
 *     bundles verify against the RECORDED arm corpora; a
 *     re-measurement masquerading as synthesis FAILs named; a
 *     disagreeing digest FAILs; an unresolvable reference FAILs;
 *   * the Wilson/minimum enforcement, the digest discipline, the
 *     driver over EVERY offline row (the 7 honest verdict rows
 *     COMPLETE reproducing the pinned syntheses; the 6 adversarial
 *     probes FAIL their named criteria), and the adversarial worlds
 *     over the honest rows through the fixture knobs.
 */

import { describe, expect, test } from "vitest";
import {
  ADJUSTED_CORPUS,
  ADJUSTED_CORPUS_VERSION,
  honestInputsOf,
  taskBodyFor,
} from "../../../benchmarks/validation/apps/economic-adjusted-cost/corpus";
import {
  type AdjustedCorpusRow,
  deriveAdjustedSynthesis,
  deriveBelowMinimumRefusalHonesty,
  deriveConfidenceAndMinimum,
  deriveEstimateMeasureSeparation,
  deriveFailureAdjustmentCompleteness,
  deriveInputIntegrity,
  deriveLatencyAdjustmentInclusion,
  deriveQualityAdjustmentHonesty,
  driveAdjustedRow,
  economicDigestOf,
  liveArmDigestOf,
  pooledFactsOf,
  type RecordedArmInput,
  recordedArmDigestOf,
  recordedArmFactsOf,
} from "../../../benchmarks/validation/apps/economic-adjusted-cost/driver";
import {
  applyAdversarialVariant,
  createFakeLedger,
  createFakeLifecycle,
  createFakeSubmissionSeam,
  createRealAccountingRails,
  createTickClock,
  inputsForRow,
} from "../../../benchmarks/validation/apps/economic-adjusted-cost/fixtures";
import { manifestFor } from "../../../benchmarks/validation/apps/economic-baseline/normalization";
import { deriveManifestIntegrity } from "../../../benchmarks/validation/apps/economic-baseline/pricing";
import type { LabVerificationCriterion } from "../../../benchmarks/validation/platform/derive";
import type { RunMetadata } from "../../../benchmarks/validation/run-identity";

const REVISION = "3f7e8ac6c0f2f0f47e1f2c0a1d3b1b9a2c4d5e6f";

const _noSleep = async () => {};

const metadataOf = (observedAt: string): RunMetadata => ({
  program: "zeck-validation",
  workOrder: "VAL-044",
  baseRevision: REVISION,
  applicationRevision: REVISION,
  corpusRevision: REVISION,
  integrationSurface: "synthesis:recorded-arm-corpora",
  environment: {
    runtime: "node test",
    toolchain: "vitest",
    database: "none",
    configuration: { suite: "val-044-unit" },
  },
  observedAt,
});

const rowById = (rowId: string): AdjustedCorpusRow => {
  const row = ADJUSTED_CORPUS.find((candidate) => candidate.rowId === rowId);
  if (row === undefined) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

/** Drive one row over the honest offline stack (the unit oracle floor). */
async function driveRowOverHonestStack(
  row: AdjustedCorpusRow,
  options: { readonly inputs?: readonly RecordedArmInput[] } = {},
) {
  const clock = createTickClock();
  const ledger = createFakeLedger(clock);
  const seam = createFakeSubmissionSeam({ ledger });
  const lifecycle = createFakeLifecycle({ ledger });
  const baseline = ledger.facts();
  const submission = await seam({ key: `val-044-unit-${row.rowId}`, body: taskBodyFor({ row }) });
  const result = await driveAdjustedRow({
    row,
    lifecycle,
    inputs: options.inputs ?? inputsForRow(row),
    rails: createRealAccountingRails(),
    metadata: metadataOf(clock.now().toISOString()),
    environmentIdentity: `val-044-unit-${row.rowId}`,
    baseline,
    worldFacts: ledger.facts,
    landedProvider: async () => [submission.executionId],
    now: clock.now,
  });
  return { result, lifecycle, ledger };
}

const criterionOf = (
  result: { readonly criteria: readonly LabVerificationCriterion[] },
  id: string,
): LabVerificationCriterion | undefined =>
  result.criteria.find((criterion) => criterion.criterionId === id);

const headline = (): readonly RecordedArmInput[] =>
  honestInputsOf(rowById("quality-adjusted-three-arm-synthesis").armSet);

// ---------------------------------------------------------------------------
// The quality-adjustment honesty oracle
// ---------------------------------------------------------------------------

describe("VAL-044 quality adjustment honesty (the verified-denominator oracle)", () => {
  test("the honest quality-adjusted cost divides by the attainment RECOMPUTED from the recorded runs", () => {
    const inputs = headline();
    const quality = deriveQualityAdjustmentHonesty({ inputs });
    expect(quality.conformant).toBe(true);
    const pooled = pooledFactsOf(inputs);
    expect(quality.attainment).toBe(pooled.resolved / pooled.runs);
    expect(quality.evidence.join(" ")).toContain("RECOMPUTED");
  });

  test("the quality-adjusted cost is measured × runs / verifiedAttainment exactly", () => {
    const inputs = headline();
    const quality = deriveQualityAdjustmentHonesty({ inputs });
    const pooled = pooledFactsOf(inputs);
    expect(quality.qualityAdjustedCostMicroUsd).not.toBeNull();
    // 957 µ$ × 24 runs / 24 resolved (exact BigInt rational, half-up).
    expect(BigInt(quality.qualityAdjustedCostMicroUsd ?? "0")).toBe(
      (pooled.measuredMicroUsd * BigInt(pooled.runs) + BigInt(pooled.resolved) / 2n) /
        BigInt(pooled.resolved),
    );
  });

  test("a claimed attainment above the recomputed one FAILs named (the quality-inflated denominator)", () => {
    const inputs = applyAdversarialVariant(headline(), { qualityInflation: true });
    const quality = deriveQualityAdjustmentHonesty({ inputs });
    expect(quality.conformant).toBe(false);
    expect(quality.evidence.join(" ")).toContain("QUALITY-INFLATED DENOMINATOR");
  });

  test("the quality-inflated PROBE row FAILs its named criterion and nothing else", async () => {
    const { result } = await driveRowOverHonestStack(rowById("probe-quality-inflated-denominator"));
    const fails = result.criteria.filter((criterion) => criterion.status === "FAIL");
    expect(fails.map((criterion) => criterion.criterionId)).toEqual(["quality-adjustment-honesty"]);
    expect(result.terminal).toBe("FAILED");
  });

  test("nothing attained → the quality-adjusted cost is NULL (the honest incomparability)", () => {
    const inputs = honestInputsOf(rowById("quality-adjusted-null-attainment-incomparable").armSet);
    const quality = deriveQualityAdjustmentHonesty({ inputs });
    expect(quality.attainment).toBe(0);
    expect(quality.qualityAdjustedCostMicroUsd).toBeNull();
    expect(quality.evidence.join(" ")).toContain("honest incomparability");
  });

  test("the driver's synthesis decision is journaled BEFORE any input is consulted", async () => {
    const { lifecycle } = await driveRowOverHonestStack(
      rowById("quality-adjusted-three-arm-synthesis"),
    );
    const decisions = lifecycle.journal.decisions;
    expect(decisions.length).toBe(1);
    const decision = decisions[0];
    expect(decision?.armDecision.family).toBe("quality-adjusted");
    expect(decision?.armDecision.deriveOnlyOverRecorded).toContain("never a re-measurement");
    expect(Array.isArray(decision?.armDecision.preRegisteredArmSet)).toBe(true);
    expect(decision?.armDecision.wilson).toEqual({ confidenceLevel: 0.95 });
  });
});

// ---------------------------------------------------------------------------
// The latency-adjustment inclusion oracle
// ---------------------------------------------------------------------------

describe("VAL-044 latency adjustment inclusion (the latency-weighting oracle)", () => {
  const latencyRow = (): AdjustedCorpusRow => rowById("latency-adjusted-three-arm-synthesis");

  test("an honest latency-weighted comparison passes with the compliance carried", () => {
    const inputs = honestInputsOf(latencyRow().armSet);
    const latency = deriveLatencyAdjustmentInclusion({
      inputs,
      budgetMs: latencyRow().latencyBudgetMs ?? 1000,
    });
    expect(latency.conformant).toBe(true);
    expect(latency.latencyCompliance).toBeGreaterThan(0);
    expect(latency.latencyCompliance).toBeLessThanOrEqual(1);
    expect(latency.evidence.join(" ")).toContain("the weighting INCLUDED");
  });

  test("every recorded run's own latency feeds the compliance (one per executed run)", () => {
    const inputs = headline();
    for (const input of inputs) {
      expect(input.recorded.perRunLatencyMs.length).toBe(input.recorded.runCount);
      expect(input.recorded.perRunLatencyMs.length).toBeGreaterThan(0);
    }
  });

  test("the latency-adjusted cost is (measured / resolved) / compliance", () => {
    const inputs = honestInputsOf(latencyRow().armSet);
    const budgetMs = latencyRow().latencyBudgetMs ?? 1000;
    const latency = deriveLatencyAdjustmentInclusion({ inputs, budgetMs });
    const pooled = pooledFactsOf(inputs);
    const compliant = pooled.perRunLatencyMs.filter((ms) => ms <= budgetMs).length;
    const total = pooled.perRunLatencyMs.length;
    expect(BigInt(latency.latencyAdjustedCostMicroUsd ?? "0")).toBe(
      (pooled.measuredMicroUsd * BigInt(total) + BigInt(pooled.resolved * compliant) / 2n) /
        BigInt(pooled.resolved * compliant),
    );
  });

  test("a latency-omitting comparison FAILs named (the weighting would be fabricated)", () => {
    const inputs = applyAdversarialVariant(headline(), { latencyOmission: true });
    const latency = deriveLatencyAdjustmentInclusion({
      inputs,
      budgetMs: latencyRow().latencyBudgetMs ?? 1000,
    });
    expect(latency.conformant).toBe(false);
    expect(latency.evidence.join(" ")).toContain("LATENCY-OMITTING COMPARISON");
  });

  test("the latency-omission PROBE row FAILs its named criterion", async () => {
    const { result } = await driveRowOverHonestStack(rowById("probe-latency-omission"));
    expect(criterionOf(result, "latency-adjustment-inclusion")?.status).toBe("FAIL");
    expect(criterionOf(result, "latency-adjustment-inclusion")?.evidence.join(" ")).toContain(
      "LATENCY-OMITTING",
    );
    expect(result.terminal).toBe("FAILED");
  });

  test("the honest stop-prefix row's latencies ride the weighting (the stop is data, never dropped)", async () => {
    const { result } = await driveRowOverHonestStack(
      rowById("latency-adjusted-honest-stop-prefix"),
    );
    expect(result.terminal).toBe("COMPLETED");
    expect(result.synthesis?.pooledRuns).toBe(9);
    expect(result.synthesis?.latencyCompliance).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The failure-adjustment completeness oracle
// ---------------------------------------------------------------------------

describe("VAL-044 failure adjustment completeness (the amortization oracle)", () => {
  test("an honest fully-amortized comparison passes (retries + failed attempts counted)", () => {
    const inputs = headline();
    const failure = deriveFailureAdjustmentCompleteness({ inputs });
    expect(failure.conformant).toBe(true);
    expect(failure.evidence.join(" ")).toContain("complete amortization");
  });

  test("the direct arm's per-attempt retry-overhead facts ride into the synthesis inputs", () => {
    const direct = headline().find((input) => input.armLabel === "direct");
    expect(direct).toBeDefined();
    expect(BigInt(direct?.recorded.retryOverheadMicroUsd ?? "0")).toBeGreaterThan(0n);
    expect(direct?.recorded.failedAttemptsCount).toBeGreaterThan(0);
  });

  test("the failure-hiding shape FAILs named (the dropped retry/failed shares)", () => {
    const inputs = applyAdversarialVariant(headline(), { failureHiding: true });
    const failure = deriveFailureAdjustmentCompleteness({ inputs });
    expect(failure.conformant).toBe(false);
    expect(failure.evidence.join(" ")).toContain("FAILURE-HIDING COMPARISON");
    const direct = inputs.find((input) => input.armLabel === "direct");
    expect(direct?.recorded.retryOverheadMicroUsd).toBe("0");
  });

  test("the failure-hiding PROBE row FAILs its named criterion", async () => {
    const { result } = await driveRowOverHonestStack(rowById("probe-failure-hiding"));
    expect(criterionOf(result, "failure-adjustment-completeness")?.status).toBe("FAIL");
    expect(criterionOf(result, "failure-adjustment-completeness")?.evidence.join(" ")).toContain(
      "FAILURE-HIDING",
    );
    expect(result.terminal).toBe("FAILED");
  });

  test("nothing resolved → the failure-adjusted cost is NULL (never zero, never estimate-backed)", () => {
    const inputs = honestInputsOf(rowById("failure-adjusted-null-resolved-incomparable").armSet);
    const failure = deriveFailureAdjustmentCompleteness({ inputs });
    expect(failure.failureAdjustedCostMicroUsd).toBeNull();
    expect(failure.evidence.join(" ")).toContain("the VAL-006 discipline");
  });
});

// ---------------------------------------------------------------------------
// The estimate/measure separation oracle
// ---------------------------------------------------------------------------

describe("VAL-044 estimate/measure separation (the conflation oracle)", () => {
  test("the honest inputs keep the estimate share SEPARATE from the measured basis", () => {
    const inputs = headline();
    const separation = deriveEstimateMeasureSeparation({ inputs });
    expect(separation.conformant).toBe(true);
    expect(separation.evidence.join(" ")).toContain("reported SEPARATELY");
  });

  test("the estimate-conflating shape FAILs named (quotes absorbed into the measured basis)", () => {
    const inputs = applyAdversarialVariant(headline(), { estimateConflation: true });
    const separation = deriveEstimateMeasureSeparation({ inputs });
    expect(separation.conformant).toBe(false);
    expect(separation.evidence.join(" ")).toContain("ESTIMATE-CONFLATION");
    const conflated = inputs.find((input) => BigInt(input.recorded.estimatedCostMicroUsd) === 0n);
    expect(conflated).toBeDefined();
  });

  test("the estimate-conflation PROBE row FAILs its named criterion", async () => {
    const { result } = await driveRowOverHonestStack(rowById("probe-estimate-conflation"));
    expect(criterionOf(result, "estimate-measure-separation")?.status).toBe("FAIL");
    expect(criterionOf(result, "estimate-measure-separation")?.evidence.join(" ")).toContain(
      "ESTIMATE-CONFLATION",
    );
    expect(result.terminal).toBe("FAILED");
  });
});

// ---------------------------------------------------------------------------
// The confidence-and-minimum oracle (+ the refusal honesty)
// ---------------------------------------------------------------------------

describe("VAL-044 confidence and minimum enforcement", () => {
  test("every honest comparison carries the Wilson 95% interval bracketing the pooled rate", () => {
    const row = rowById("quality-adjusted-three-arm-synthesis");
    const confidence = deriveConfidenceAndMinimum({ row, inputs: honestInputsOf(row.armSet) });
    expect(confidence.conformant).toBe(true);
    expect(confidence.wilson).not.toBeNull();
    const pooled = pooledFactsOf(honestInputsOf(row.armSet));
    const rate = pooled.resolved / pooled.runs;
    expect(confidence.wilson?.low).toBeLessThanOrEqual(rate);
    expect(confidence.wilson?.high).toBeGreaterThanOrEqual(rate);
    expect(confidence.wilson?.low).toBeGreaterThanOrEqual(0);
    expect(confidence.wilson?.high).toBeLessThanOrEqual(1);
  });

  test("a post-hoc arm exclusion FAILs named (a pre-registered input dropped)", () => {
    const row = rowById("quality-adjusted-three-arm-synthesis");
    const excluded = honestInputsOf(row.armSet).slice(0, 2);
    const confidence = deriveConfidenceAndMinimum({ row, inputs: excluded });
    expect(confidence.conformant).toBe(false);
    expect(confidence.evidence.join(" ")).toContain("post-hoc-excluded");
  });

  test("an input outside the pre-registered arm set FAILs named", () => {
    const row = rowById("quality-adjusted-three-arm-synthesis");
    const extra = honestInputsOf(rowById("quality-adjusted-null-attainment-incomparable").armSet);
    const confidence = deriveConfidenceAndMinimum({ row, inputs: extra });
    expect(confidence.conformant).toBe(false);
    expect(confidence.evidence.join(" ")).toContain("undeclared-input");
    expect(confidence.evidence.join(" ")).toContain("post-hoc-excluded");
  });

  test("the honest below-minimum row REFUSES honestly (the refusal is the verified outcome)", async () => {
    const { result } = await driveRowOverHonestStack(
      rowById("quality-adjusted-below-minimum-honest-refusal"),
    );
    expect(result.terminal).toBe("COMPLETED");
    expect(criterionOf(result, "below-minimum-refusal-honesty")?.status).toBe("PASS");
    expect(result.synthesis?.adjustedCostMicroUsd).toBe("266");
  });

  test("a below-minimum comparability CLAIM FAILs named", () => {
    const row = rowById("probe-below-minimum-comparability-claim");
    const refusal = deriveBelowMinimumRefusalHonesty({
      row,
      inputs: honestInputsOf(row.armSet),
    });
    expect(refusal.belowMinimum).toBe(true);
    expect(refusal.conformant).toBe(false);
    expect(refusal.evidence.join(" ")).toContain("BELOW-MINIMUM COMPARABILITY CLAIM");
  });

  test("the below-minimum PROBE row FAILs its named criterion only", async () => {
    const { result } = await driveRowOverHonestStack(
      rowById("probe-below-minimum-comparability-claim"),
    );
    const fails = result.criteria.filter((criterion) => criterion.status === "FAIL");
    expect(fails.map((criterion) => criterion.criterionId)).toEqual([
      "below-minimum-refusal-honesty",
    ]);
    expect(result.terminal).toBe("FAILED");
  });
});

// ---------------------------------------------------------------------------
// The input-integrity oracle (the re-measurement catch)
// ---------------------------------------------------------------------------

describe("VAL-044 input integrity (the digest-verified recorded inputs)", () => {
  test("every honest input IS the recorded corpus's own result (digest + field equality)", () => {
    const integrity = deriveInputIntegrity({ inputs: headline() });
    expect(integrity.conformant).toBe(true);
    expect(integrity.verdicts.every((verdict) => verdict.integrity)).toBe(true);
    expect(integrity.evidence.join(" ")).toContain("digest-verified");
  });

  test("the honest inputs' facts EQUAL the arms' own recorded expected outcomes", () => {
    for (const input of headline()) {
      const resolved = recordedArmFactsOf(input);
      expect(resolved).not.toBeNull();
      const armCorpusRow = resolved?.row as {
        readonly expected: {
          readonly normalized?: {
            readonly runCount: number;
            readonly resolvedCount: number;
            readonly measuredCostMicroUsd: string;
          };
        };
      };
      expect(armCorpusRow.expected.normalized?.runCount).toBe(input.recorded.runCount);
      expect(armCorpusRow.expected.normalized?.resolvedCount).toBe(input.recorded.resolvedCount);
      expect(armCorpusRow.expected.normalized?.measuredCostMicroUsd).toBe(
        input.recorded.measuredCostMicroUsd,
      );
    }
  });

  test("a re-measurement masquerading as synthesis FAILs named (field by field)", () => {
    const inputs = applyAdversarialVariant(headline(), { remeasurement: true });
    const integrity = deriveInputIntegrity({ inputs });
    expect(integrity.conformant).toBe(false);
    const evidence = integrity.evidence.join(" ");
    expect(evidence).toContain("RE-MEASUREMENT MASQUERADE");
    expect(evidence).toContain("runCount");
  });

  test("a disagreeing digest FAILs named", () => {
    const inputs = headline().map((input, index) =>
      index === 0 ? { ...input, recordedDigest: "00000000" } : input,
    );
    const integrity = deriveInputIntegrity({ inputs });
    expect(integrity.conformant).toBe(false);
    expect(integrity.evidence.join(" ")).toContain("DIGEST-DISAGREED");
  });

  test("an unresolvable digest reference FAILs named", () => {
    const inputs = headline().map((input, index) =>
      index === 0 ? { ...input, corpusRowId: "no-such-recorded-row" } : input,
    );
    const integrity = deriveInputIntegrity({ inputs });
    expect(integrity.conformant).toBe(false);
    expect(integrity.evidence.join(" ")).toContain("UNRESOLVABLE DIGEST REFERENCE");
  });

  test("an input's pinned price revision is verified against the manifest registry", () => {
    for (const input of headline()) {
      expect(deriveManifestIntegrity({ revision: input.priceRevision }).agreed).toBe(true);
      expect(manifestFor(input.priceRevision).revision).toBe(input.priceRevision);
    }
    const mutated = headline().map((input, index) =>
      index === 0 ? { ...input, priceRevision: "rev-999" } : input,
    );
    const integrity = deriveInputIntegrity({ inputs: mutated });
    expect(integrity.conformant).toBe(false);
    expect(integrity.evidence.join(" ")).toContain("UNPINNED PRICING");
  });

  test("the re-measurement PROBE row FAILs its named criterion only", async () => {
    const { result } = await driveRowOverHonestStack(rowById("probe-remeasurement-masquerade"));
    const fails = result.criteria.filter((criterion) => criterion.status === "FAIL");
    expect(fails.map((criterion) => criterion.criterionId)).toEqual([
      "input-integrity-digest-verified",
    ]);
    expect(result.terminal).toBe("FAILED");
    expect(result.inputs.every((input) => input.integrity)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Digest discipline + the comparability verdicts
// ---------------------------------------------------------------------------

describe("VAL-044 digest discipline + comparability verdicts", () => {
  test("the recorded-arm digest is deterministic and discriminating", () => {
    const input = headline()[0];
    if (input === undefined) {
      throw new Error("the headline set is empty");
    }
    const a = recordedArmFactsOf(input);
    const b = recordedArmFactsOf(input);
    if (a === null || b === null) {
      throw new Error("the recorded facts failed to re-derive");
    }
    const digestA = recordedArmDigestOf({
      armLabel: "direct",
      corpusRowId: "fixed-quality-direct-default-rail",
      facts: a.facts,
    });
    const digestB = recordedArmDigestOf({
      armLabel: "direct",
      corpusRowId: "fixed-quality-direct-default-rail",
      facts: b.facts,
    });
    expect(digestA).toBe(digestB);
    const digestC = recordedArmDigestOf({
      armLabel: "direct",
      corpusRowId: "fixed-quality-direct-default-rail",
      facts: { ...a.facts, runCount: 99 },
    });
    expect(digestA).not.toBe(digestC);
    expect(digestA).not.toContain("confirm");
  });

  test("the live-arm declaration digest binds the arm identity (never an outcome copy)", () => {
    const digest = liveArmDigestOf({
      armLabel: "direct",
      corpusRowId: "live-fixed-quality-direct-real-dispatch",
      armId: "fq-direct-live",
      sliceSize: 4,
    });
    expect(digest).toBe(
      economicDigestOf({
        armLabel: "direct",
        corpusRowId: "live-fixed-quality-direct-real-dispatch",
        liveArm: "fq-direct-live",
        sliceSize: 4,
      }),
    );
  });

  test("the derived verdict reproduces the corpus's expected verdicts on the honest rows", () => {
    for (const row of ADJUSTED_CORPUS.filter(
      (candidate) => !candidate.needsDispatch && candidate.adversarial === undefined,
    )) {
      const derived = deriveAdjustedSynthesis({ row, inputs: honestInputsOf(row.armSet) });
      expect(derived.verdict).toBe(row.expected.verdict);
      expect(derived.familyConformant).toBe(true);
    }
  });

  test("the task bodies carry references only — never an inline price, never an outcome copy", () => {
    for (const row of ADJUSTED_CORPUS) {
      const body = JSON.stringify(taskBodyFor({ row }));
      expect(body).not.toMatch(/"price"\s*:/);
      expect(body).not.toMatch(/0\.12/);
      expect(body).not.toMatch(/"measuredCostMicroUsd"/);
      expect(body).not.toMatch(/"resolvedCount"/);
    }
  });

  test("the corpus version is pinned", () => {
    expect(ADJUSTED_CORPUS_VERSION).toBe("val-044-adjusted-cost-v1");
  });
});

// ---------------------------------------------------------------------------
// The driver over every offline row
// ---------------------------------------------------------------------------

describe("VAL-044 driver over the offline corpus", () => {
  test("every honest verdict row COMPLETES reproducing the pinned synthesis", async () => {
    for (const row of ADJUSTED_CORPUS.filter(
      (candidate) => !candidate.needsDispatch && candidate.adversarial === undefined,
    )) {
      const { result } = await driveRowOverHonestStack(row);
      expect(result.terminal).toBe("COMPLETED");
      expect(result.failure).toBeNull();
      expect(criterionOf(result, "synthesis-outcome-oracle")?.status).toBe("PASS");
      expect(criterionOf(result, "observed-terminal-readback")?.status).toBe("PASS");
      expect(result.synthesis?.pooledRuns).toBe(row.expected.synthesis?.pooledRuns);
      expect(result.synthesis?.pooledResolved).toBe(row.expected.synthesis?.pooledResolved);
      expect(result.synthesis?.measuredCostMicroUsd).toBe(
        row.expected.synthesis?.measuredCostMicroUsd,
      );
      expect(result.synthesis?.adjustedCostMicroUsd).toBe(
        row.expected.synthesis?.adjustedCostMicroUsd,
      );
    }
  });

  test("every adversarial PROBE row FAILS its named criterion honestly", async () => {
    const expectations: Record<string, string> = {
      "probe-quality-inflated-denominator": "quality-adjustment-honesty",
      "probe-latency-omission": "latency-adjustment-inclusion",
      "probe-failure-hiding": "failure-adjustment-completeness",
      "probe-estimate-conflation": "estimate-measure-separation",
      "probe-remeasurement-masquerade": "input-integrity-digest-verified",
      "probe-below-minimum-comparability-claim": "below-minimum-refusal-honesty",
    };
    for (const [rowId, criterionId] of Object.entries(expectations)) {
      const { result } = await driveRowOverHonestStack(rowById(rowId));
      expect(result.terminal).toBe("FAILED");
      expect(criterionOf(result, criterionId)?.status).toBe("FAIL");
      expect(criterionOf(result, "observed-terminal-readback")?.status).toBe("PASS");
    }
  });

  test("every verified input journals a digest reference (never payload bytes)", async () => {
    const { result } = await driveRowOverHonestStack(
      rowById("quality-adjusted-three-arm-synthesis"),
    );
    expect(result.inputs.length).toBe(3);
    for (const input of result.inputs) {
      expect(input.integrity).toBe(true);
      expect(input.reference.recordedDigest).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  test("the live row stays env-gated (honest NOT RUN without the credential)", async () => {
    const live = ADJUSTED_CORPUS.filter((row) => row.needsDispatch);
    expect(live.length).toBe(1);
    expect(live[0]?.liveGate?.envVars).toContain("OPENROUTER_API_KEY");
    expect(live[0]?.expected.synthesis).toBeUndefined();
    expect(live[0]?.armSet.every((reference) => reference.recordedDigest.length > 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The adversarial worlds (the honest rows driven through each knob)
// ---------------------------------------------------------------------------

describe("VAL-044 adversarial worlds over the honest rows", () => {
  test("the quality-inflation knob FAILs the honest quality row's named criterion", async () => {
    const row = rowById("quality-adjusted-three-arm-synthesis");
    const { result } = await driveRowOverHonestStack(row, {
      inputs: applyAdversarialVariant(honestInputsOf(row.armSet), { qualityInflation: true }),
    });
    expect(criterionOf(result, "quality-adjustment-honesty")?.status).toBe("FAIL");
    expect(result.terminal).toBe("FAILED");
  });

  test("the latency-omission knob FAILs the honest latency row's named criterion", async () => {
    const row = rowById("latency-adjusted-three-arm-synthesis");
    const { result } = await driveRowOverHonestStack(row, {
      inputs: applyAdversarialVariant(honestInputsOf(row.armSet), { latencyOmission: true }),
    });
    expect(criterionOf(result, "latency-adjustment-inclusion")?.status).toBe("FAIL");
    expect(result.terminal).toBe("FAILED");
  });

  test("the failure-hiding knob FAILs the honest failure row's named criterion", async () => {
    const row = rowById("failure-adjusted-three-arm-synthesis");
    const { result } = await driveRowOverHonestStack(row, {
      inputs: applyAdversarialVariant(honestInputsOf(row.armSet), { failureHiding: true }),
    });
    expect(criterionOf(result, "failure-adjustment-completeness")?.status).toBe("FAIL");
    expect(result.terminal).toBe("FAILED");
  });

  test("the estimate-conflation knob FAILs the honest failure row's separation criterion", async () => {
    const row = rowById("failure-adjusted-three-arm-synthesis");
    const { result } = await driveRowOverHonestStack(row, {
      inputs: applyAdversarialVariant(honestInputsOf(row.armSet), { estimateConflation: true }),
    });
    expect(criterionOf(result, "estimate-measure-separation")?.status).toBe("FAIL");
    expect(result.terminal).toBe("FAILED");
  });

  test("the remeasurement knob FAILs the honest quality row's integrity criterion", async () => {
    const row = rowById("quality-adjusted-three-arm-synthesis");
    const { result } = await driveRowOverHonestStack(row, {
      inputs: applyAdversarialVariant(honestInputsOf(row.armSet), { remeasurement: true }),
    });
    expect(criterionOf(result, "input-integrity-digest-verified")?.status).toBe("FAIL");
    expect(result.terminal).toBe("FAILED");
  });
});
