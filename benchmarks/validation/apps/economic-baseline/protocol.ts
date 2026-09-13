/**
 * The fixed-quality / fixed-cost experiment protocol (VAL-040,
 * acceptance criteria 1 + 4 — the FROZEN grammar every later
 * economics work order (VAL-041 direct-provider controls, VAL-042
 * optimized non-Zeck baseline, VAL-043 competing stack) must
 * execute).
 *
 * The arm-declaration grammar formalizes the VAL-005 comparator
 * vocabulary for the economics wave:
 *
 *   * FIXED-QUALITY arms pin a DECLARED resolution/quality threshold
 *     (drawn from the evaluation oracle's resolution discipline) and
 *     measure the COST TO ATTAIN it — every task of the
 *     PRE-REGISTERED corpus slice runs, the cost-per-resolved is the
 *     headline, and the threshold attainment is RECOMPUTED from the
 *     accounted runs (an arm's own claim never decides — the
 *     threshold-gaming catch);
 *   * FIXED-COST arms pin a micro-USD budget and measure the QUALITY
 *     ATTAINED WITHIN it — rounds dispatch in the pre-registered
 *     order while the remaining budget covers the pinned per-round
 *     bound (decided BEFORE dispatch), budget exhaustion is an
 *     honest declared stop (never a post-hoc exclusion), and the
 *     measured total must respect the pinned budget;
 *   * BOTH kinds declare: the pinned price revision that priced the
 *     runs (prices never inline), the pre-registered corpus slice (in
 *     execution order), and the statistical minimums (minimum sample
 *     size — enforced mechanically);
 *   * the declaration is DIGEST-FROZEN at pin time (the comparators'
 *     fairness discipline): executing arms against drifted terms — a
 *     post-hoc threshold change, a slice substitution, a minimum
 *     weakened after the fact — is mechanically rejected;
 *   * every comparison carries the Wilson 95% interval on the
 *     resolution rate (the VAL-006 accounting discipline, imported
 *     from the REAL accounting module — never re-implemented here):
 *     a confidence-less comparison FAILS the validation battery.
 *
 * Everything here is PURE over the pinned manifest + the accounted
 * runs.
 */

import { createHash } from "node:crypto";
import type { ArmAggregate } from "../../accounting/aggregate";
import { wilsonInterval } from "../../accounting/aggregate";
import { deriveCostPerResolved } from "./normalization";
import { deriveManifestIntegrity, manifestRevisionOf, type PriceManifestRevision } from "./pricing";

// ---------------------------------------------------------------------------
// The frozen arm grammar
// ---------------------------------------------------------------------------

/** The experiment kinds the economics wave runs. */
export type ExperimentKind = "fixed-quality" | "fixed-cost";

/** The shared arm declaration terms (the grammar's mandatory fields). */
export interface EconomicArmTerms {
  /** The arm identity (unique within the experiment). */
  readonly armId: string;
  readonly kind: ExperimentKind;
  /** The integration surface the arm rides (sdk / provider / stack). */
  readonly integrationSurface: string;
  /** The provider rail the arm executes through (priced in the manifest). */
  readonly provider: string;
  readonly model: string;
  /**
   * WHICH pinned manifest revision priced this arm's runs — prices
   * are NEVER copied inline into an arm declaration.
   */
  readonly priceRevision: string;
  /**
   * The PRE-REGISTERED corpus slice: the task identities in execution
   * order, declared BEFORE any run (no post-hoc exclusion).
   */
  readonly corpusSlice: readonly string[];
  /** The statistical minimum: the executed sample size must reach it. */
  readonly minimumSamples: number;
}

/** A fixed-quality arm: the threshold is pinned, cost-to-attain is measured. */
export interface FixedQualityArm {
  readonly armId: string;
  readonly kind: "fixed-quality";
  readonly integrationSurface: string;
  readonly provider: string;
  readonly model: string;
  readonly priceRevision: string;
  readonly corpusSlice: readonly string[];
  readonly minimumSamples: number;
  /**
   * The DECLARED resolution/quality threshold (the pinned resolution
   * rate the arm must attain; drawn from the evaluation rubric's
   * resolution discipline — declared BEFORE the runs, never moved
   * after them).
   */
  readonly pinnedThreshold: { readonly resolutionRate: number };
}

/** A fixed-cost arm: the budget is pinned, quality-attained is measured. */
export interface FixedCostArm {
  readonly armId: string;
  readonly kind: "fixed-cost";
  readonly integrationSurface: string;
  readonly provider: string;
  readonly model: string;
  readonly priceRevision: string;
  readonly corpusSlice: readonly string[];
  readonly minimumSamples: number;
  /** The pinned micro-USD budget (integer string). */
  readonly pinnedBudgetMicroUsd: string;
  /**
   * The pinned per-round completion budget (max tokens per dispatch —
   * the OpenRouter unaffordable-budget 402 lesson: completion budgets
   * are pinned explicitly, never omitted).
   */
  readonly maxTokensPerRound: number;
}

/** One declared experiment arm (either kind). */
export type EconomicArm = FixedQualityArm | FixedCostArm;

/** One arm-declaration violation. */
export interface ArmDeclarationViolation {
  readonly armId: string;
  readonly reason: string;
}

/** Canonical JSON: sorted keys, no insignificant whitespace. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/**
 * Validate one arm declaration against the frozen grammar (PURE):
 * mandatory terms present, the pinned price revision EXISTS in the
 * manifest, the pre-registered slice is non-empty with distinct task
 * identities, the statistical minimum is at least 2 (a comparison
 * needs a sample), the pinned quantity is well-formed (a threshold
 * in (0,1]; a positive integer-string budget), and — for
 * fixed-quality arms — the declared threshold is anchored in the
 * evaluation oracle's resolution discipline (in (0,1], attainable in
 * principle at the declared minimum). Inline PRICES are structurally
 * absent: the grammar has no price field, so an arm cannot smuggle a
 * per-token price — pricing resolves through the manifest only.
 */
export function validateArmDeclaration(arm: EconomicArm): readonly ArmDeclarationViolation[] {
  const violations: ArmDeclarationViolation[] = [];
  const fail = (reason: string): void => {
    violations.push({ armId: arm.armId, reason });
  };
  if (arm.armId.length === 0) {
    return [{ armId: "", reason: "the arm identity is required" }];
  }
  if (arm.integrationSurface.length === 0) {
    fail("the integration surface is required");
  }
  if (arm.provider.length === 0 || arm.model.length === 0) {
    fail("the provider rail and model are required (priced through the manifest)");
  }
  if (manifestRevisionOf(arm.priceRevision) === null) {
    fail(`the pinned price revision ${arm.priceRevision} is not in the manifest registry`);
  }
  if (arm.corpusSlice.length === 0) {
    fail("the pre-registered corpus slice is required (an arm cannot run an empty slice)");
  }
  const distinct = new Set(arm.corpusSlice);
  if (distinct.size !== arm.corpusSlice.length) {
    fail("the pre-registered corpus slice has duplicate task identities");
  }
  if (!Number.isInteger(arm.minimumSamples) || arm.minimumSamples < 2) {
    fail("the minimum sample size must be an integer ≥ 2 (a comparison needs a sample)");
  }
  if (arm.corpusSlice.length < arm.minimumSamples) {
    fail(
      `the pre-registered slice (${arm.corpusSlice.length} tasks) cannot reach the declared minimum sample size ${arm.minimumSamples}`,
    );
  }
  if (arm.kind === "fixed-quality") {
    const threshold = arm.pinnedThreshold.resolutionRate;
    if (!(threshold > 0 && threshold <= 1)) {
      fail("the pinned resolution threshold must be in (0,1]");
    }
  } else {
    if (!/^\d+$/.test(arm.pinnedBudgetMicroUsd) || BigInt(arm.pinnedBudgetMicroUsd) <= 0n) {
      fail("the pinned budget must be a positive micro-USD integer string");
    }
    if (!Number.isInteger(arm.maxTokensPerRound) || arm.maxTokensPerRound <= 0) {
      fail("the per-round completion budget (max tokens) must be pinned explicitly and positive");
    }
  }
  return violations;
}

/** The pinned experiment: the declaration digest freezes the terms. */
export interface PinnedExperiment {
  readonly arms: readonly EconomicArm[];
  readonly digest: string;
}

/**
 * Pin an experiment (PURE): validate every arm's grammar, reject
 * duplicate arm identities, and freeze the terms under the
 * declaration digest (drifted terms — a post-hoc threshold change, a
 * slice substitution, a weakened minimum — fail digest conformance
 * mechanically at verification time).
 */
export function pinExperiment(arms: readonly EconomicArm[]): PinnedExperiment {
  if (arms.length === 0) {
    throw new Error("an experiment must declare at least one arm");
  }
  const identities = new Set(arms.map((arm) => arm.armId));
  if (identities.size !== arms.length) {
    throw new Error("arm identities must be unique within the experiment");
  }
  const violations = arms.flatMap((arm) => validateArmDeclaration(arm));
  if (violations.length > 0) {
    throw new Error(
      `arm declarations violate the frozen grammar: ${violations
        .map((violation) => `${violation.armId}: ${violation.reason}`)
        .join("; ")}`,
    );
  }
  const digest = `sha256:${createHash("sha256").update(canonicalJson(arms)).digest("hex")}`;
  return Object.freeze({ arms, digest });
}

/**
 * Verify the executed arms against the pinned experiment (PURE — the
 * declaration-drift catch): the executed arm declarations must be
 * EXACTLY the pinned ones (canonical equality), so any term changed
 * after pinning (threshold gaming by moving the threshold, slice
 * substitution, a weakened minimum) is a fairness violation.
 */
export function verifyDeclarationDrift(
  pinned: PinnedExperiment,
  executed: readonly EconomicArm[],
): readonly string[] {
  const violations: string[] = [];
  for (const arm of executed) {
    const pinnedArm = pinned.arms.find((candidate) => candidate.armId === arm.armId);
    if (pinnedArm === undefined) {
      violations.push(`undeclared arm executed: ${arm.armId}`);
      continue;
    }
    if (canonicalJson(arm) !== canonicalJson(pinnedArm)) {
      violations.push(
        `arm ${arm.armId} executed drifted declaration terms (the pinned terms are digest-frozen)`,
      );
    }
  }
  for (const arm of pinned.arms) {
    if (!executed.some((candidate) => candidate.armId === arm.armId)) {
      violations.push(`declared arm never executed: ${arm.armId}`);
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// The protocol derivations (each its own mechanical criterion)
// ---------------------------------------------------------------------------

/** The slice-conformance verdict (the post-hoc exclusion catch). */
export interface SliceConformanceVerdict {
  readonly conformant: boolean;
  readonly evidence: readonly string[];
}

/**
 * Derive the executed-slice conformance (PURE): the executed task
 * identities must be EXACTLY the pre-registered slice for
 * fixed-quality arms (every task runs — dropping a non-resolved task
 * is a post-hoc exclusion and FAILS); for fixed-cost arms the
 * executed set must be a PREFIX of the pre-registered order (the
 * declared budget stop — honest), never a cherry-picked subset, and
 * never a task outside the slice.
 */
export function deriveSliceConformance(input: {
  readonly arm: EconomicArm;
  readonly executedTaskIds: readonly string[];
}): SliceConformanceVerdict {
  const declared = input.arm.corpusSlice;
  const executed = input.executedTaskIds;
  if (input.arm.kind === "fixed-quality") {
    const declaredSet = new Set(declared);
    const executedSet = new Set(executed);
    const same =
      executed.length === declared.length &&
      executed.every((taskId) => declaredSet.has(taskId)) &&
      declared.every((taskId) => executedSet.has(taskId));
    return {
      conformant: same,
      evidence: [
        `kind:fixed-quality`,
        `declared:${declared.length}`,
        `executed:${executed.length}`,
        `missing:${declared.filter((taskId) => !executedSet.has(taskId)).join("|") || "none"}`,
        `extra:${executed.filter((taskId) => !declaredSet.has(taskId)).join("|") || "none"}`,
        same
          ? "conformant (every pre-registered task executed)"
          : "NON-CONFORMANT (a fixed-quality arm must execute its full pre-registered slice — post-hoc exclusion is forbidden)",
      ],
    };
  }
  // fixed-cost: the executed set must be a PREFIX of the declared order.
  let prefix = true;
  for (const [index, taskId] of executed.entries()) {
    if (declared[index] !== taskId) {
      prefix = false;
      break;
    }
  }
  const within = executed.length <= declared.length;
  return {
    conformant: prefix && within,
    evidence: [
      "kind:fixed-cost",
      `declared:${declared.length}`,
      `executed:${executed.length}`,
      `prefix:${String(prefix && within)}`,
      `nextAfterStop:${declared[executed.length] ?? "slice-exhausted"}`,
      prefix && within
        ? "conformant (the budget stop is a declared prefix stop — never a cherry-pick)"
        : "NON-CONFORMANT (the fixed-cost arm must execute the pre-registered ORDER as a prefix — a cherry-picked subset is a post-hoc exclusion)",
    ],
  };
}

/** Derive the sample sufficiency (PURE — the minimum enforced). */
export function deriveSampleSufficiency(input: {
  readonly arm: EconomicArm;
  readonly executedCount: number;
}): { readonly sufficient: boolean; readonly evidence: readonly string[] } {
  const sufficient = input.executedCount >= input.arm.minimumSamples;
  return {
    sufficient,
    evidence: [
      `minimum:${input.arm.minimumSamples}`,
      `executed:${input.executedCount}`,
      sufficient
        ? "sufficient (the statistical minimum is met)"
        : "INSUFFICIENT (the executed sample is below the declared statistical minimum — the comparison is invalid)",
    ],
  };
}

/**
 * Derive the threshold attainment of a fixed-quality arm (PURE — the
 * gaming catch): the attainment is RECOMPUTED from the accounted
 * runs' own resolution rate; an arm's claimed thresholdMet NEVER
 * decides (a claim above the observed rate is threshold gaming and
 * FAILS mechanically).
 */
export function deriveThresholdAttainment(input: {
  readonly arm: FixedQualityArm;
  readonly observedResolutionRate: number;
  readonly claimedMet?: boolean;
}): { readonly met: boolean; readonly evidence: readonly string[] } {
  const observed = input.observedResolutionRate;
  const met = observed >= input.arm.pinnedThreshold.resolutionRate;
  const gamed = input.claimedMet === true && !met;
  return {
    met,
    evidence: [
      `pinnedThreshold:${input.arm.pinnedThreshold.resolutionRate}`,
      `observedResolutionRate:${observed}`,
      `recomputedMet:${String(met)}`,
      ...(input.claimedMet === undefined ? [] : [`claimedMet:${String(input.claimedMet)}`]),
      gamed
        ? "THRESHOLD GAMING (the claim disagrees with the recomputed attainment — the derivation decides, never the claim)"
        : "attainment recomputed from the accounted runs",
    ],
  };
}

/**
 * Derive the budget respect of a fixed-cost arm (PURE): the MEASURED
 * total must respect the pinned budget (the estimate total is
 * reported separately and never substitutes).
 */
export function deriveBudgetRespect(input: {
  readonly arm: FixedCostArm;
  readonly measuredMicroUsd: string;
  readonly estimatedMicroUsd: string;
}): { readonly respected: boolean; readonly evidence: readonly string[] } {
  const measured = BigInt(input.measuredMicroUsd);
  const budget = BigInt(input.arm.pinnedBudgetMicroUsd);
  const respected = measured <= budget;
  return {
    respected,
    evidence: [
      `pinnedBudgetMicroUsd:${input.arm.pinnedBudgetMicroUsd}`,
      `measuredMicroUsd:${input.measuredMicroUsd}`,
      `estimatedMicroUsd:${input.estimatedMicroUsd}`,
      `headroom:${(budget - measured).toString()}`,
      respected
        ? "respected (the measured total is within the pinned budget)"
        : "BREACHED (the measured total exceeds the pinned budget)",
    ],
  };
}

// ---------------------------------------------------------------------------
// The normalized comparison (the protocol's output, confidence-carried)
// ---------------------------------------------------------------------------

/** The normalized per-arm comparison on the canonical basis. */
export interface NormalizedArmComparison {
  readonly armId: string;
  readonly kind: ExperimentKind;
  readonly corpusSlice: readonly string[];
  readonly priceRevision: string;
  readonly runCount: number;
  readonly resolvedCount: number;
  readonly resolutionRate: number;
  /**
   * The Wilson 95% interval on the resolution rate — REQUIRED on
   * every comparison (a null here is a confidence-less comparison
   * and FAILS the validation battery).
   */
  readonly resolutionConfidence: { readonly low: number; readonly high: number } | null;
  readonly measuredCostMicroUsd: string;
  readonly estimatedCostMicroUsd: string;
  /**
   * Micro-USD per successfully resolved outcome — NULL when nothing
   * resolved (never zero, never estimate-backed).
   */
  readonly costPerResolvedMicroUsd: string | null;
  readonly estimateBacking: boolean;
  /** fixed-quality: the recomputed attainment + the cost to attain. */
  readonly threshold?: {
    readonly pinned: number;
    readonly observed: number;
    readonly met: boolean;
    readonly claimedMet?: boolean;
  };
  /** fixed-cost: the measured budget respect + the quality attained. */
  readonly budget?: {
    readonly pinnedMicroUsd: string;
    readonly measuredMicroUsd: string;
    readonly respected: boolean;
    readonly qualityAttained: number;
  };
  readonly samplesSufficient: boolean;
  readonly sliceConformant: boolean;
  readonly manifestAgreed: boolean;
  readonly evidence: readonly string[];
}

/**
 * Derive one arm's normalized comparison (PURE): folds the REAL
 * accounting aggregate (the injected rails' roll-up — resolution
 * count, measured/estimated totals, Wilson) together with the
 * protocol facts (slice conformance, sample sufficiency, threshold
 * attainment recomputed, budget respect, manifest integrity, the
 * canonical cost-per-resolved) into the comparison record every
 * later economics work order reports through.
 *
 * The optional `manifestUsed` is the manifest that ACTUALLY priced
 * the runs (the driver's pricing basis): its own digest integrity is
 * verified — a mutated table with a stale digest FAILS the
 * comparison's manifest agreement mechanically (the unpinned-pricing
 * catch, beyond the registry lookup).
 */
export function deriveNormalizedComparison(input: {
  readonly arm: EconomicArm;
  /** The REAL accounting aggregate over the arm's accounted runs. */
  readonly aggregate: ArmAggregate;
  /** The executed task identities, in execution order. */
  readonly executedTaskIds: readonly string[];
  /** The arm's own threshold claim (never trusted — the gaming catch). */
  readonly claimedThresholdMet?: boolean;
  /** The manifest that actually priced the runs (defaults to the registry's declared revision). */
  readonly manifestUsed?: PriceManifestRevision;
}): NormalizedArmComparison {
  const aggregate = input.aggregate;
  const perResolved = deriveCostPerResolved({
    measuredMicroUsd: aggregate.measuredCostMicroUsd,
    estimatedMicroUsd: aggregate.estimatedCostMicroUsd,
    resolvedCount: aggregate.resolvedCount,
  });
  const slice = deriveSliceConformance({
    arm: input.arm,
    executedTaskIds: input.executedTaskIds,
  });
  const samples = deriveSampleSufficiency({
    arm: input.arm,
    executedCount: input.executedTaskIds.length,
  });
  const manifest =
    input.manifestUsed === undefined
      ? deriveManifestIntegrity({ revision: input.arm.priceRevision })
      : deriveManifestIntegrity({
          revision: input.manifestUsed.revision,
          registry: [input.manifestUsed],
        });
  // The manifest that priced the runs must ALSO be the arm's DECLARED
  // revision (pricing at a different revision than declared — however
  // honest that revision's own digest — is undeclared pricing).
  const manifestAgreed =
    manifest.agreed &&
    (input.manifestUsed === undefined || input.manifestUsed.revision === input.arm.priceRevision);
  const evidence: string[] = [
    `arm:${input.arm.armId}`,
    `kind:${input.arm.kind}`,
    `slice:${input.arm.corpusSlice.length} declared / ${input.executedTaskIds.length} executed`,
    `runs:${aggregate.runCount}`,
    `resolved:${aggregate.resolvedCount}`,
    `resolutionRate:${aggregate.resolutionRate}`,
    `wilson95:[${aggregate.resolutionConfidence.low.toFixed(4)}, ${aggregate.resolutionConfidence.high.toFixed(4)}]`,
    `measuredMicroUsd:${aggregate.measuredCostMicroUsd}`,
    `estimatedMicroUsd:${aggregate.estimatedCostMicroUsd}`,
    ...(perResolved.costPerResolvedMicroUsd === null
      ? ["costPerResolved:null"]
      : [`costPerResolved:${perResolved.costPerResolvedMicroUsd}`]),
    `priceRevision:${input.arm.priceRevision} (${manifest.agreed ? "integrity-agreed" : "integrity-FAILED"})`,
  ];
  const comparison: NormalizedArmComparison = {
    armId: input.arm.armId,
    kind: input.arm.kind,
    corpusSlice: input.arm.corpusSlice,
    priceRevision: input.arm.priceRevision,
    runCount: aggregate.runCount,
    resolvedCount: aggregate.resolvedCount,
    resolutionRate: aggregate.resolutionRate,
    resolutionConfidence: { ...aggregate.resolutionConfidence },
    measuredCostMicroUsd: aggregate.measuredCostMicroUsd,
    estimatedCostMicroUsd: aggregate.estimatedCostMicroUsd,
    costPerResolvedMicroUsd: perResolved.costPerResolvedMicroUsd,
    estimateBacking: perResolved.estimateBacking,
    samplesSufficient: samples.sufficient,
    sliceConformant: slice.conformant,
    manifestAgreed,
    evidence: [...evidence, ...slice.evidence, ...samples.evidence, ...perResolved.evidence],
  };
  if (input.arm.kind === "fixed-quality") {
    const attainment = deriveThresholdAttainment({
      arm: input.arm,
      observedResolutionRate: aggregate.resolutionRate,
      ...(input.claimedThresholdMet === undefined ? {} : { claimedMet: input.claimedThresholdMet }),
    });
    return {
      ...comparison,
      threshold: {
        pinned: input.arm.pinnedThreshold.resolutionRate,
        observed: aggregate.resolutionRate,
        met: attainment.met,
        ...(input.claimedThresholdMet === undefined
          ? {}
          : { claimedMet: input.claimedThresholdMet }),
      },
      evidence: [...comparison.evidence, ...attainment.evidence],
    };
  }
  const budget = deriveBudgetRespect({
    arm: input.arm,
    measuredMicroUsd: aggregate.measuredCostMicroUsd,
    estimatedMicroUsd: aggregate.estimatedCostMicroUsd,
  });
  return {
    ...comparison,
    budget: {
      pinnedMicroUsd: input.arm.pinnedBudgetMicroUsd,
      measuredMicroUsd: aggregate.measuredCostMicroUsd,
      respected: budget.respected,
      qualityAttained: aggregate.resolutionRate,
    },
    evidence: [...comparison.evidence, ...budget.evidence],
  };
}

/** One comparison-validation violation (the mechanical battery). */
export interface ComparisonViolation {
  readonly armId: string;
  readonly reason: string;
}

/**
 * Validate a normalized comparison (PURE — the mechanical battery of
 * AC4): Wilson confidence REQUIRED (a confidence-less comparison
 * FAILs), samples sufficient, slice conformant (no post-hoc
 * exclusion), manifest integrity agreed, cost-per-resolved NULL-safe
 * (never zero-backed, never estimate-backed — an estimate-backed
 * cost-per-resolution FAILS even when a number is claimed), and the
 * arm-kind criterion recomputed (fixed-quality: threshold attainment
 * recomputed from the OBSERVED rate, a gamed claim FAILs; fixed-cost:
 * the measured total respects the pinned budget).
 */
export function validateNormalizedComparison(
  comparison: NormalizedArmComparison,
): readonly ComparisonViolation[] {
  const violations: ComparisonViolation[] = [];
  const fail = (reason: string): void => {
    violations.push({ armId: comparison.armId, reason });
  };
  if (comparison.resolutionConfidence === null) {
    fail("CONFIDENCE-LESS COMPARISON: the Wilson 95% interval is required on every comparison");
  } else {
    const { low, high } = comparison.resolutionConfidence;
    if (!(low <= comparison.resolutionRate && comparison.resolutionRate <= high)) {
      fail("the Wilson interval must bracket the observed resolution rate");
    }
    if (!(low >= 0 && high <= 1)) {
      fail("the Wilson interval must lie within [0,1]");
    }
  }
  if (!comparison.samplesSufficient) {
    fail("SAMPLE-SIZE VIOLATION: the executed sample is below the declared statistical minimum");
  }
  if (!comparison.sliceConformant) {
    fail("POST-HOC ARM EXCLUSION: the executed slice is not the pre-registered slice");
  }
  if (!comparison.manifestAgreed) {
    fail(
      "UNPINNED PRICING: the declared price revision failed manifest integrity (digest disagreement)",
    );
  }
  if (comparison.resolvedCount > 0 && comparison.costPerResolvedMicroUsd === null) {
    if (comparison.estimateBacking) {
      fail(
        "ESTIMATE-BACKED COST-PER-RESOLUTION: no measured fact settled, yet resolved outcomes exist — cost-per-resolved is never estimate-backed",
      );
    } else {
      fail("cost-per-resolved is null while outcomes resolved (never zero-backed)");
    }
  }
  if (comparison.resolvedCount === 0 && comparison.costPerResolvedMicroUsd !== null) {
    fail(
      "cost-per-resolved must be NULL when nothing resolved (never zero, never estimate-backed)",
    );
  }
  if (comparison.kind === "fixed-quality" && comparison.threshold !== undefined) {
    const recomputed = comparison.threshold.observed >= comparison.threshold.pinned;
    if (comparison.threshold.met !== recomputed) {
      fail(
        "THRESHOLD RECOMPUTATION MISMATCH: the recorded attainment disagrees with the recomputed one",
      );
    }
    if (!recomputed) {
      fail(
        "THRESHOLD NOT ATTAINED: the observed resolution rate is below the pinned threshold (the fixed-quality arm did not attain its declared quality)",
      );
    }
    if (comparison.threshold.claimedMet === true && !recomputed) {
      fail("THRESHOLD GAMING: the claim says attained while the recomputation says not");
    }
  }
  if (
    comparison.kind === "fixed-cost" &&
    comparison.budget !== undefined &&
    !comparison.budget.respected
  ) {
    fail("BUDGET BREACH: the measured total exceeds the fixed-cost arm's pinned budget");
  }
  return violations;
}

/**
 * The Wilson interval re-export (the REAL accounting module's
 * derivation — imported, never re-implemented; the protocol carries
 * it on every comparison).
 */
export { wilsonInterval };
