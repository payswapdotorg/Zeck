/**
 * VAL-044 acceptance criterion 6 — discrimination tests proving the
 * ADJUSTED-COST synthesis against controlled fakes (every family FAILs
 * mechanically; every family has an honest control that PASSES):
 *
 *   * QUALITY INFLATION — an input's claimed attainment above the
 *     attainment RECOMPUTED from the recorded runs' own resolution
 *     counts: the quality-adjustment-honesty oracle FAILs (the
 *     inflated denominator would deflate the adjusted cost — the
 *     derivation decides, never the claim);
 *   * LATENCY OMISSION — a comparison whose inputs carry no (or
 *     short) per-run latencies while claiming a latency adjustment:
 *     the latency-adjustment-inclusion oracle FAILs (the weighting
 *     would be fabricated);
 *   * FAILURE HIDING — a comparison that zeroes the retry-overhead
 *     share and the failed rounds' cost out of the amortization: the
 *     failure-adjustment-completeness oracle FAILs (the measured
 *     total must reconstruct from BOTH decompositions);
 *   * ESTIMATE CONFLATION — a comparison that absorbs the estimate
 *     share into the measured basis: the estimate/measure-separation
 *     oracle FAILs (the adjusted cost would be quote-backed);
 *   * BELOW-MINIMUM — a comparison below the pre-registered minimums
 *     that CLAIMS a comparability verdict (or drops a pre-registered
 *     arm post-hoc): the refusal-honesty and confidence-and-minimum
 *     oracles FAIL (the honest outcome is the refusal);
 *   * RE-MEASUREMENT MASQUERADE — an input bundle whose facts are not
 *     the RECORDED corpus's own result (a re-measured outcome, a
 *     disagreeing digest, an unresolvable reference, an unpinned
 *     price revision): the input-integrity oracle FAILs (the
 *     synthesis derives over RECORDED results — digest-verified,
 *     never re-run, never re-priced);
 *   * the Wilson-confidence application (a CONFIDENCE-LESS comparison
 *     FAILs the battery), the digest discipline, the honest controls
 *     over the whole fixture stack, and the AC4 probes (the
 *     declared-digest disagreement and the unpinned pricing each FAIL
 *     mechanically).
 */

import { describe, expect, test } from "vitest";
import { wilsonInterval } from "../../benchmarks/validation/accounting/aggregate";
import {
  ADJUSTED_CORPUS,
  honestInputsOf,
  OFFLINE_CONTROL_ROWS,
  PROBE_ROWS,
  taskBodyFor,
} from "../../benchmarks/validation/apps/economic-adjusted-cost/corpus";
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
} from "../../benchmarks/validation/apps/economic-adjusted-cost/driver";
import {
  applyAdversarialVariant,
  createFakeLedger,
  createFakeLifecycle,
  createFakeSubmissionSeam,
  createRealAccountingRails,
  createTickClock,
  inputsForRow,
} from "../../benchmarks/validation/apps/economic-adjusted-cost/fixtures";
import { deriveManifestIntegrity } from "../../benchmarks/validation/apps/economic-baseline/pricing";
import type { LabVerificationCriterion } from "../../benchmarks/validation/platform/derive";
import type { RunMetadata } from "../../benchmarks/validation/run-identity";

const REVISION = "3359788a11c0d2f7e5a4b6c8d9e0f1a2b3c4d5e6f";

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
    configuration: { suite: "val-044-discrimination" },
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

const criterionOf = (
  result: { readonly criteria: readonly LabVerificationCriterion[] },
  id: string,
): LabVerificationCriterion | undefined =>
  result.criteria.find((criterion) => criterion.criterionId === id);

/** The headline arm set's honest recorded inputs (the comparable basis). */
const headline = (): readonly RecordedArmInput[] =>
  honestInputsOf(rowById("quality-adjusted-three-arm-synthesis").armSet);

/** Drive one row over a purpose-built leaky stack (the discrimination harness). */
async function driveRowOverLeakyStack(options: {
  readonly row: AdjustedCorpusRow;
  /** The denatured input bundles (the adversarial knobs' output). */
  readonly inputs?: readonly RecordedArmInput[];
}): Promise<ReturnType<typeof driveAdjustedRow>> {
  const clock = createTickClock();
  const ledger = createFakeLedger(clock);
  const seam = createFakeSubmissionSeam({ ledger });
  const lifecycle = createFakeLifecycle({ ledger });
  const baseline = ledger.facts();
  const submission = await seam({
    key: `val-044-disc-${options.row.rowId}`,
    body: taskBodyFor({ row: options.row }),
  });
  return driveAdjustedRow({
    row: options.row,
    lifecycle,
    inputs: options.inputs ?? inputsForRow(options.row),
    rails: createRealAccountingRails(),
    metadata: metadataOf(clock.now().toISOString()),
    environmentIdentity: `val-044-disc-${options.row.rowId}`,
    baseline,
    worldFacts: ledger.facts,
    landedProvider: async () => [submission.executionId],
    now: clock.now,
  });
}

/** One input bundle with a replaced digest (the digest-disagreement fake). */
function withDigest(input: RecordedArmInput, digest: string): RecordedArmInput {
  return { ...input, recordedDigest: digest };
}

// ---------------------------------------------------------------------------
// Family 1: the QUALITY-INFLATED denominator (the verification core)
// ---------------------------------------------------------------------------

describe("discrimination: quality inflation", () => {
  test("the derivation-level catch: a claimed attainment above the recomputed one FAILs named", () => {
    const inputs = applyAdversarialVariant(headline(), { qualityInflation: true });
    const verdict = deriveQualityAdjustmentHonesty({ inputs });
    expect(verdict.conformant).toBe(false);
    const evidence = verdict.evidence.join(" ");
    expect(evidence).toContain("QUALITY-INFLATED DENOMINATOR");
    // The inflated claim is NAMED with both sides (claimed > recomputed).
    expect(evidence).toContain("direct:fixed-quality-direct-default-rail");
    expect(evidence).toMatch(/claimed \d+\.\d{4} > recomputed \d+\.\d{4}/);
  });

  test("the verified-attainment control: a claim AT the recomputed attainment passes", () => {
    const inputs = headline();
    const pooled = pooledFactsOf(inputs);
    const attainment = pooled.runs > 0 ? pooled.resolved / pooled.runs : 0;
    const honest = inputs.map((input, index) =>
      index === 0 ? { ...input, claimed: { attainment } } : input,
    );
    const verdict = deriveQualityAdjustmentHonesty({ inputs: honest });
    expect(verdict.conformant).toBe(true);
    expect(verdict.attainment).toBe(attainment);
    expect(verdict.evidence.join(" ")).toContain("honest denominator");
  });

  test("the row-level catch: the quality-inflated PROBE row FAILs its named criterion", async () => {
    const row = rowById("probe-quality-inflated-denominator");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("FAILED");
    const honesty = criterionOf(result, "quality-adjustment-honesty");
    expect(honesty?.status).toBe("FAIL");
    expect(honesty?.evidence.join(" ")).toContain("QUALITY-INFLATED DENOMINATOR");
    expect(result.observedTerminal).toBe("FAILED");
  });

  test("the honest control: the verified denominator PASSES with the exact adjusted cost", async () => {
    const row = rowById("quality-adjusted-three-arm-synthesis");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(criterionOf(result, "quality-adjustment-honesty")?.status).toBe("PASS");
    const pooled = pooledFactsOf(headline());
    // measured × runs / verifiedAttainment (exact BigInt rational, half-up).
    expect(BigInt(result.synthesis?.adjustedCostMicroUsd ?? "0")).toBe(
      (pooled.measuredMicroUsd * BigInt(pooled.runs) + BigInt(pooled.resolved) / 2n) /
        BigInt(pooled.resolved),
    );
  });
});

// ---------------------------------------------------------------------------
// Family 2: the LATENCY-OMITTING comparison
// ---------------------------------------------------------------------------

describe("discrimination: latency omission", () => {
  test("the derivation-level catch: stripped per-run latencies FAILs named", () => {
    const inputs = applyAdversarialVariant(headline(), { latencyOmission: true });
    const verdict = deriveLatencyAdjustmentInclusion({ inputs, budgetMs: 1000 });
    expect(verdict.conformant).toBe(false);
    const evidence = verdict.evidence.join(" ");
    expect(evidence).toContain("LATENCY-OMITTING COMPARISON");
    // Every input whose latency list no longer covers its runs is named.
    expect(evidence).toContain("latencies 0 != runs");
  });

  test("the derivation-level catch: a SHORT latency list FAILs named (partial omission)", () => {
    const inputs = headline().map((input, index) =>
      index === 0
        ? { ...input, recorded: { ...input.recorded, perRunLatencyMs: [100, 100] } }
        : input,
    );
    const verdict = deriveLatencyAdjustmentInclusion({ inputs, budgetMs: 1000 });
    expect(verdict.conformant).toBe(false);
    expect(verdict.evidence.join(" ")).toContain("LATENCY-OMITTING COMPARISON");
  });

  test("the row-level catch: the latency-omission PROBE row FAILs its named criterion", async () => {
    const row = rowById("probe-latency-omission");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("FAILED");
    const inclusion = criterionOf(result, "latency-adjustment-inclusion");
    expect(inclusion?.status).toBe("FAIL");
    expect(inclusion?.evidence.join(" ")).toContain("LATENCY-OMITTING COMPARISON");
  });

  test("the honest control: the weighting is exact — (measured / resolved) / compliance", () => {
    const inputs = headline();
    const verdict = deriveLatencyAdjustmentInclusion({ inputs, budgetMs: 1000 });
    expect(verdict.conformant).toBe(true);
    const pooled = pooledFactsOf(inputs);
    const latencies = inputs.flatMap((input) => input.recorded.perRunLatencyMs);
    expect(latencies.length).toBe(pooled.runs);
    const compliant = latencies.filter((latency) => latency <= 1000).length;
    expect(verdict.latencyCompliance).toBe(compliant / latencies.length);
    expect(BigInt(verdict.latencyAdjustedCostMicroUsd ?? "0")).toBe(
      (pooled.measuredMicroUsd * BigInt(latencies.length) +
        BigInt(pooled.resolved * compliant) / 2n) /
        BigInt(pooled.resolved * compliant),
    );
  });

  test("the honest stop-prefix control: the declared stop's latencies ride the weighting", async () => {
    const row = rowById("latency-adjusted-honest-stop-prefix");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(criterionOf(result, "latency-adjustment-inclusion")?.status).toBe("PASS");
    // The executed prefix's OWN latencies (one per executed run) feed the
    // compliance — the stop is data, never dropped.
    const inputs = honestInputsOf(row.armSet);
    const latencies = inputs.flatMap((input) => input.recorded.perRunLatencyMs);
    const runs = inputs.reduce((sum, input) => sum + input.recorded.runCount, 0);
    expect(latencies.length).toBe(runs);
    expect(result.synthesis?.latencyCompliance).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Family 3: the FAILURE-HIDING comparison
// ---------------------------------------------------------------------------

describe("discrimination: failure hiding", () => {
  test("the derivation-level catch: zeroed retry/failed shares FAILs named", () => {
    const inputs = applyAdversarialVariant(headline(), { failureHiding: true });
    const verdict = deriveFailureAdjustmentCompleteness({ inputs });
    expect(verdict.conformant).toBe(false);
    const evidence = verdict.evidence.join(" ");
    expect(evidence).toContain("FAILURE-HIDING COMPARISON");
    // The dropped RETRY-OVERHEAD share is named per input (the headline
    // arms' failed rounds carry no measured cost — the retry amortization
    // is the share the knob hides).
    expect(evidence).toContain("measured 193 != direct 176 + retry 0");
    expect(evidence).toContain("measured 554 != direct 536 + retry 0");
  });

  test("the derivation-level catch: the failed rounds' cost hidden from the amortization FAILs named", () => {
    // The zero-resolved arms hold ALL their measured cost in the failed
    // rounds' share — hiding it breaks the resolved+failed reconstruction.
    const zero = honestInputsOf(rowById("quality-adjusted-null-attainment-incomparable").armSet);
    const hidden = zero.map((input) => ({
      ...input,
      recorded: { ...input.recorded, failedRoundsMicroUsd: "0" },
    }));
    const verdict = deriveFailureAdjustmentCompleteness({ inputs: hidden });
    expect(verdict.conformant).toBe(false);
    const evidence = verdict.evidence.join(" ");
    expect(evidence).toContain("FAILURE-HIDING COMPARISON");
    expect(evidence).toContain("!= resolvedRounds 0 + failedRounds 0");
    expect(evidence).toContain("direct:zero-resolved-direct-null-discipline");
  });

  test("the row-level catch: the failure-hiding PROBE row FAILs its named criterion", async () => {
    const row = rowById("probe-failure-hiding");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("FAILED");
    const completeness = criterionOf(result, "failure-adjustment-completeness");
    expect(completeness?.status).toBe("FAIL");
    expect(completeness?.evidence.join(" ")).toContain("FAILURE-HIDING COMPARISON");
  });

  test("the honest control: the fully-amortized comparison PASSES with the retry-overhead counted", () => {
    const inputs = headline();
    const verdict = deriveFailureAdjustmentCompleteness({ inputs });
    expect(verdict.conformant).toBe(true);
    // The direct arm's per-attempt retry-overhead facts ride into the
    // synthesis inputs (retries and failed attempts are amortized IN,
    // never hidden).
    const direct = inputs.find((input) => input.armLabel === "direct");
    expect(direct).toBeDefined();
    expect(BigInt(direct?.recorded.retryOverheadMicroUsd ?? "0")).toBeGreaterThan(0n);
    const pooled = pooledFactsOf(inputs);
    expect(BigInt(verdict.failureAdjustedCostMicroUsd ?? "0")).toBe(
      (pooled.measuredMicroUsd + BigInt(pooled.resolved) / 2n) / BigInt(pooled.resolved),
    );
  });

  test("the honest NULL control: nothing resolved → NULL, never zero, never estimate-backed", () => {
    const zero = honestInputsOf(rowById("quality-adjusted-null-attainment-incomparable").armSet);
    const verdict = deriveFailureAdjustmentCompleteness({ inputs: zero });
    expect(verdict.conformant).toBe(true);
    expect(verdict.failureAdjustedCostMicroUsd).toBeNull();
    expect(verdict.evidence.join(" ")).toContain("never zero, never estimate-backed");
  });
});

// ---------------------------------------------------------------------------
// Family 4: the ESTIMATE-CONFLATING comparison
// ---------------------------------------------------------------------------

describe("discrimination: estimate conflation", () => {
  test("the derivation-level catch: the estimate share absorbed into the measured basis FAILs named", () => {
    const inputs = applyAdversarialVariant(headline(), { estimateConflation: true });
    const verdict = deriveEstimateMeasureSeparation({ inputs });
    expect(verdict.conformant).toBe(false);
    const evidence = verdict.evidence.join(" ");
    expect(evidence).toContain("ESTIMATE-CONFLATION");
    // The absorbed share is named against the RECORDED measured basis.
    expect(evidence).toContain("the estimate share was absorbed");
  });

  test("the row-level catch: the estimate-conflation PROBE row FAILs its named criterion", async () => {
    const row = rowById("probe-estimate-conflation");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("FAILED");
    const separation = criterionOf(result, "estimate-measure-separation");
    expect(separation?.status).toBe("FAIL");
    expect(separation?.evidence.join(" ")).toContain("ESTIMATE-CONFLATION");
  });

  test("the honest control: the estimate share rides SEPARATELY (never inside the basis)", async () => {
    const row = rowById("failure-adjusted-three-arm-synthesis");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(criterionOf(result, "estimate-measure-separation")?.status).toBe("PASS");
    // The pooled estimate total rides as its own reported figure while
    // the measured basis stays exactly the recorded measured totals.
    const inputs = headline();
    const pooled = pooledFactsOf(inputs);
    expect(pooled.estimatedMicroUsd).toBeGreaterThan(0n);
    expect(result.synthesis?.measuredCostMicroUsd).toBe(pooled.measuredMicroUsd.toString());
    expect(result.synthesis?.estimatedCostMicroUsd).toBe(pooled.estimatedMicroUsd.toString());
  });
});

// ---------------------------------------------------------------------------
// Family 5: the BELOW-MINIMUM comparability claim + the set discipline
// ---------------------------------------------------------------------------

describe("discrimination: below-minimum comparability claim", () => {
  test("the derivation-level catch: a below-minimum comparability CLAIM FAILs named", () => {
    const row = rowById("probe-below-minimum-comparability-claim");
    const inputs = honestInputsOf(row.armSet);
    const refusal = deriveBelowMinimumRefusalHonesty({ row, inputs });
    expect(refusal.belowMinimum).toBe(true);
    expect(refusal.conformant).toBe(false);
    expect(refusal.evidence.join(" ")).toContain("BELOW-MINIMUM COMPARABILITY CLAIM");
  });

  test("the derivation-level catch: post-hoc exclusion and undeclared inputs each FAIL named", () => {
    const row = rowById("quality-adjusted-three-arm-synthesis");
    const inputs = honestInputsOf(row.armSet);
    // A pre-registered arm dropped post-hoc (2 of 3 inputs present —
    // the competing arm is the dropped one).
    const excluded = deriveConfidenceAndMinimum({ row, inputs: inputs.slice(0, 2) });
    expect(excluded.conformant).toBe(false);
    expect(excluded.evidence.join(" ")).toContain("post-hoc-excluded:competing:");
    // An input OUTSIDE the pre-registered arm set (the honest direct
    // headline row declared a SECOND time under a different row id).
    const first = inputs[0];
    if (first === undefined) {
      throw new Error("the headline arm set is empty");
    }
    const impostor: RecordedArmInput = {
      ...first,
      corpusRowId: "fixed-quality-direct-euro-rail",
    };
    const undeclared = deriveConfidenceAndMinimum({ row, inputs: [...inputs, impostor] });
    expect(undeclared.conformant).toBe(false);
    expect(undeclared.evidence.join(" ")).toContain("undeclared-input:");
  });

  test("the row-level catch: the below-minimum claim PROBE row FAILs its named criterion", async () => {
    const row = rowById("probe-below-minimum-comparability-claim");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("FAILED");
    const refusal = criterionOf(result, "below-minimum-refusal-honesty");
    expect(refusal?.status).toBe("FAIL");
    expect(refusal?.evidence.join(" ")).toContain("BELOW-MINIMUM COMPARABILITY CLAIM");
  });

  test("the honest control: the at-minimum comparison PASSES and the honest refusal stands", async () => {
    const row = rowById("quality-adjusted-three-arm-synthesis");
    const inputs = honestInputsOf(row.armSet);
    const confidence = deriveConfidenceAndMinimum({ row, inputs });
    expect(confidence.conformant).toBe(true);
    expect(confidence.belowMinimum).toBe(false);
    expect(confidence.wilson).not.toBeNull();
    // The honest refusal row: below the minimum, the synthesis REFUSES —
    // and the refusal IS the verified outcome (the row COMPLETES).
    const refusalRow = rowById("quality-adjusted-below-minimum-honest-refusal");
    const result = await driveRowOverLeakyStack({ row: refusalRow });
    expect(result.terminal).toBe("COMPLETED");
    expect(criterionOf(result, "below-minimum-refusal-honesty")?.status).toBe("PASS");
    const verdict = deriveAdjustedSynthesis({ row: refusalRow, inputs: inputsForRow(refusalRow) });
    expect(verdict.verdict).toBe("refused-below-minimum");
  });
});

// ---------------------------------------------------------------------------
// Family 6: the RE-MEASUREMENT masquerade (the input-integrity oracle)
// ---------------------------------------------------------------------------

describe("discrimination: re-measurement masquerade", () => {
  test("the derivation-level catch: a re-measured run count FAILs named, field by field", () => {
    const inputs = applyAdversarialVariant(headline(), { remeasurement: true });
    const verdict = deriveInputIntegrity({ inputs });
    expect(verdict.conformant).toBe(false);
    const evidence = verdict.evidence.join(" ");
    expect(evidence).toContain("RE-MEASUREMENT MASQUERADE");
    expect(evidence).toContain("runCount");
  });

  test("the derivation-level catch: a disagreeing digest FAILs named", () => {
    const inputs = headline();
    const first = inputs[0];
    if (first === undefined) {
      throw new Error("the headline arm set is empty");
    }
    const verdict = deriveInputIntegrity({
      inputs: [withDigest(first, "deadbeef"), ...(inputs.slice(1) ?? [])],
    });
    expect(verdict.conformant).toBe(false);
    expect(verdict.evidence.join(" ")).toContain("DIGEST-DISAGREED");
    expect(verdict.verdicts[0]?.failureReason).toBe("digest-disagreed");
  });

  test("the derivation-level catch: an unresolvable reference FAILs named", () => {
    const inputs = headline();
    const first = inputs[0];
    if (first === undefined) {
      throw new Error("the headline arm set is empty");
    }
    const ghost: RecordedArmInput = { ...first, corpusRowId: "no-such-recorded-row" };
    const verdict = deriveInputIntegrity({ inputs: [ghost] });
    expect(verdict.conformant).toBe(false);
    expect(verdict.evidence.join(" ")).toContain("UNRESOLVABLE DIGEST REFERENCE");
    expect(verdict.verdicts[0]?.failureReason).toBe("unresolvable-reference");
  });

  test("the row-level catch: the re-measurement PROBE row FAILs its named criterion", async () => {
    const row = rowById("probe-remeasurement-masquerade");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("FAILED");
    const integrity = criterionOf(result, "input-integrity-digest-verified");
    expect(integrity?.status).toBe("FAIL");
    expect(integrity?.evidence.join(" ")).toContain("RE-MEASUREMENT MASQUERADE");
  });

  test("the honest control: the digest-verified recorded inputs all verify", () => {
    const inputs = headline();
    const verdict = deriveInputIntegrity({ inputs });
    expect(verdict.conformant).toBe(true);
    for (const item of verdict.verdicts) {
      expect(item.integrity).toBe(true);
      expect(item.failureReason).toBeNull();
      // The re-derived digest EQUALS the declared one (digest references).
      const resolved = recordedArmFactsOf(item.reference);
      expect(resolved).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Family 7: the WILSON-confidence application (the frozen battery)
// ---------------------------------------------------------------------------

describe("discrimination: the Wilson-confidence application", () => {
  test("the derivation-level catch: a CONFIDENCE-LESS comparison FAILs the battery", () => {
    // A comparison pooled over NO runs carries no Wilson interval and
    // FAILs the frozen battery (the interval is required on every
    // comparison, never optional).
    const liveRow = rowById("live-adjusted-synthesis-real-comparison");
    const confidence = deriveConfidenceAndMinimum({ row: liveRow, inputs: [] });
    expect(confidence.wilson).toBeNull();
    expect(confidence.conformant).toBe(false);
    expect(confidence.evidence.join(" ")).toContain("CONFIDENCE-LESS COMPARISON");
    expect(confidence.evidence.join(" ")).toContain("BELOW-MINIMUM");
  });

  test("the honest control: every comparison carries the Wilson 95% interval bracketing the pooled rate", async () => {
    const row = rowById("quality-adjusted-three-arm-synthesis");
    const result = await driveRowOverLeakyStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    const pooled = pooledFactsOf(honestInputsOf(row.armSet));
    const wilson = result.synthesis?.wilson;
    expect(wilson).not.toBeNull();
    if (wilson !== undefined && wilson !== null) {
      expect(wilson.low).toBeLessThanOrEqual(pooled.resolved / pooled.runs);
      expect(wilson.high).toBeGreaterThanOrEqual(pooled.resolved / pooled.runs);
      const pinned = wilsonInterval(pooled.resolved, pooled.runs);
      expect(wilson.low).toBeCloseTo(pinned.low, 12);
      expect(wilson.high).toBeCloseTo(pinned.high, 12);
    }
    expect(criterionOf(result, "confidence-and-minimum")?.status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// Family 8: the DIGEST discipline
// ---------------------------------------------------------------------------

describe("discrimination: the digest discipline", () => {
  test("the recorded-arm digest is deterministic and discriminating", () => {
    const resolved = recordedArmFactsOf({
      armLabel: "direct",
      corpusRowId: "fixed-quality-direct-default-rail",
      recordedDigest: "",
      priceRevision: "rev-001",
    });
    if (resolved === null) {
      throw new Error("the direct headline row failed to resolve");
    }
    const digest = recordedArmDigestOf({
      armLabel: "direct",
      corpusRowId: "fixed-quality-direct-default-rail",
      facts: resolved.facts,
    });
    expect(digest).toBe(
      recordedArmDigestOf({
        armLabel: "direct",
        corpusRowId: "fixed-quality-direct-default-rail",
        facts: resolved.facts,
      }),
    );
    const reMeasured = {
      ...resolved.facts,
      runCount: resolved.facts.runCount + 1,
    };
    expect(digest).not.toBe(
      recordedArmDigestOf({
        armLabel: "direct",
        corpusRowId: "fixed-quality-direct-default-rail",
        facts: reMeasured,
      }),
    );
  });

  test("the live-arm digest binds the arm identity (never an outcome copy)", () => {
    const declared = liveArmDigestOf({
      armLabel: "direct",
      corpusRowId: "live-fixed-quality-direct-real-dispatch",
      armId: "fq-direct-live",
      sliceSize: 4,
    });
    expect(declared).toBe(
      liveArmDigestOf({
        armLabel: "direct",
        corpusRowId: "live-fixed-quality-direct-real-dispatch",
        armId: "fq-direct-live",
        sliceSize: 4,
      }),
    );
    expect(declared).not.toBe(
      liveArmDigestOf({
        armLabel: "direct",
        corpusRowId: "live-fixed-quality-direct-real-dispatch",
        armId: "fq-direct-live",
        sliceSize: 5,
      }),
    );
    // The declaration digest is NOT the recorded-outcome digest shape.
    const resolved = recordedArmFactsOf({
      armLabel: "direct",
      corpusRowId: "live-fixed-quality-direct-real-dispatch",
      recordedDigest: "",
      priceRevision: "rev-001",
    });
    if (resolved === null) {
      throw new Error("the direct live row failed to resolve");
    }
    expect(declared).not.toBe(
      recordedArmDigestOf({
        armLabel: "direct",
        corpusRowId: "live-fixed-quality-direct-real-dispatch",
        facts: resolved.facts,
      }),
    );
  });

  test("the honest and re-measured input bundles carry separable digests", () => {
    const honest = headline();
    const reMeasured = applyAdversarialVariant(honest, { remeasurement: true });
    expect(economicDigestOf(honest.map((input) => [input.armLabel, input.recorded]))).not.toBe(
      economicDigestOf(reMeasured.map((input) => [input.armLabel, input.recorded])),
    );
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
      expect(result.failure).toBeNull();
    }
  });

  test("every adversarial PROBE row FAILs its NAMED criterion honestly", async () => {
    const named: Readonly<Record<string, string>> = {
      "probe-quality-inflated-denominator": "quality-adjustment-honesty",
      "probe-latency-omission": "latency-adjustment-inclusion",
      "probe-failure-hiding": "failure-adjustment-completeness",
      "probe-estimate-conflation": "estimate-measure-separation",
      "probe-remeasurement-masquerade": "input-integrity-digest-verified",
      "probe-below-minimum-comparability-claim": "below-minimum-refusal-honesty",
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
  test("a declared-digest disagreement FAILs the manifest integrity", () => {
    const verdict = deriveManifestIntegrity({
      revision: "rev-001",
      declaredDigest: "sha256:not-the-pinned-digest",
    });
    expect(verdict.digestAgrees).toBe(false);
    expect(verdict.agreed).toBe(false);
    // The honest shape: the pinned revision's own integrity agrees.
    const honest = deriveManifestIntegrity({ revision: "rev-001" });
    expect(honest.agreed).toBe(true);
  });

  test("an input whose pinned price revision fails manifest integrity FAILs named", () => {
    const inputs = headline();
    const first = inputs[0];
    if (first === undefined) {
      throw new Error("the headline arm set is empty");
    }
    const unpinned: RecordedArmInput = { ...first, priceRevision: "rev-999" };
    const verdict = deriveInputIntegrity({ inputs: [unpinned] });
    expect(verdict.conformant).toBe(false);
    expect(verdict.evidence.join(" ")).toContain("UNPINNED PRICING");
    expect(verdict.verdicts[0]?.failureReason).toBe("manifest-integrity-failed");
  });
});
