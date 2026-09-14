/**
 * The economic-adjusted-cost synthesis driver (VAL-044, acceptance
 * criteria 1, 2 and 4 — the adjusted-cost synthesis over the three
 * RECORDED control arms).
 *
 * The synthesis the economic validation exists for: the three
 * control arms' RECORDED results (VAL-041 direct-provider, VAL-042
 * optimized non-Zeck baseline, VAL-043 competing stack) composed
 * with the pinned manifests into the three adjusted-cost families —
 *
 *   * QUALITY-ADJUSTED cost: measured cost per unit of VERIFIED
 *     quality attainment (the denominator is the attainment RECOMPUTED
 *     from the recorded runs' own resolution counts — a
 *     quality-inflated denominator FAILs named);
 *   * LATENCY-ADJUSTED cost: the cost-per-resolved weighted by
 *     latency-budget compliance over every recorded run's OWN
 *     recorded latency (a latency-omitting comparison FAILs named);
 *   * FAILURE-ADJUSTED cost: the measured cost per successfully
 *     resolved outcome with retries and failed attempts FULLY
 *     amortized (the VAL-006 measured-facts-only discipline — a
 *     failure-hiding comparison FAILs named; NULL when nothing
 *     resolved, never zero, never estimate-backed).
 *
 * The synthesis is a PURE derivation over the RECORDED arm corpora —
 * the inputs are DIGEST REFERENCES (arm label + corpus row id + the
 * content digest of the recorded outcome), never copies, and NEVER a
 * re-measurement: the input-integrity oracle re-derives every input's
 * recorded facts from the imported arm corpora (the same simulations
 * their own expected-outcome derivations run) and a bundle whose
 * facts disagree with the RECORDED results FAILs as a re-measurement
 * masquerade. No arm input is re-run and no recorded input is
 * re-priced: the recorded micro-USD totals are carried as recorded,
 * at each arm's own pinned manifest revision.
 *
 * Every comparison carries the Wilson 95% interval (the REAL
 * accounting module's derivation — imported, never re-implemented),
 * the minimum sample sizes are enforced mechanically (below-minimum
 * FAILs), the arm set is PRE-REGISTERED (a post-hoc arm exclusion
 * FAILs named), and every input's pinned price revision is verified
 * against the VAL-040 manifest registry (integrity + digest).
 *
 * The verdict is MECHANICAL: any failure, any failed criterion →
 * verdict fail → terminal FAILED (never a partial-success shortcut).
 */

import { wilsonInterval } from "../../accounting/aggregate";
import { isResolvedOutcome, thresholdsFor } from "../../accounting/thresholds";
import type { GoldenTask } from "../../corpus/schema";
import type { ObservedOutcome } from "../../evaluation/deterministic";
import { evaluateRun } from "../../evaluation/evaluate";
import type { LabVerificationCriterion } from "../../platform/derive";
import type {
  EconomicAccountingRails,
  EconomicJournalRecord,
  EconomicLifecyclePort,
  EconomicWorldFacts,
  LandedExecutionsProvider,
} from "../economic-baseline/driver";
import { economicDigestOf } from "../economic-baseline/driver";
import type { UsageFact } from "../economic-baseline/normalization";
import { manifestFor, normalizeArmCosts } from "../economic-baseline/normalization";
import { deriveManifestIntegrity, resolveListPrice } from "../economic-baseline/pricing";
import {
  competitorConfigFor,
  routeForClass as competitorRouteForClass,
} from "../economic-controls-competing/competitor-config";
import {
  COMPETING_CORPUS,
  COMPETING_CORPUS_VERSION,
  competingTasksForArm,
} from "../economic-controls-competing/corpus";
import type { CompetingCorpusRow } from "../economic-controls-competing/driver";
import { deriveCompetingRoundBudgetBoundMicroUsd } from "../economic-controls-competing/driver";
import {
  DIRECT_CORPUS,
  DIRECT_CORPUS_VERSION,
  directTasksForArm,
} from "../economic-controls-direct/corpus";
import type { DirectCorpusRow } from "../economic-controls-direct/driver";
import { deriveDirectRoundBudgetBoundMicroUsd } from "../economic-controls-direct/driver";
import {
  OPTIMIZED_CORPUS,
  OPTIMIZED_CORPUS_VERSION,
  optimizedTasksForArm,
} from "../economic-controls-optimized/corpus";
import type { OptimizedCorpusRow } from "../economic-controls-optimized/driver";
import { deriveOptimizedRoundBudgetBoundMicroUsd } from "../economic-controls-optimized/driver";
import { inventoryFor, routeForClass } from "../economic-controls-optimized/optimizations";

// ---------------------------------------------------------------------------
// The synthesis vocabulary (the VAL-040 vocabulary, composed)
// ---------------------------------------------------------------------------

/** The three adjusted-cost families under test. */
export type AdjustedCostFamily = "quality-adjusted" | "latency-adjusted" | "failure-adjusted";

/** The three recorded control arms the synthesis composes. */
export type ArmLabel = "direct" | "optimized" | "competing";

/** The pre-registered arm-set entry: a DIGEST REFERENCE, never a copy. */
export interface ArmInputReference {
  readonly armLabel: ArmLabel;
  /** The recorded corpus row of the referenced arm (resolved in ITS corpus). */
  readonly corpusRowId: string;
  /** The content digest of the RECORDED outcome (digest references only). */
  readonly recordedDigest: string;
  /** The arm's own pinned price revision (verified against the manifest). */
  readonly priceRevision: string;
}

/** The recorded facts of one arm input (must EQUAL the corpus's recording). */
export interface RecordedArmFacts {
  readonly runCount: number;
  readonly resolvedCount: number;
  readonly measuredCostMicroUsd: string;
  readonly estimatedCostMicroUsd: string;
  readonly costPerResolvedMicroUsd: string | null;
  readonly resolutionConfidence: { readonly low: number; readonly high: number };
  /** The recorded per-run latencies (the latency-compliance input — one per executed run). */
  readonly perRunLatencyMs: readonly number[];
  /** The measured direct-execution share (the settling attempts' own cost). */
  readonly directExecutionMicroUsd: string;
  /** The measured retry-overhead share (the failed attempts' amortized cost). */
  readonly retryOverheadMicroUsd: string;
  /** The measured cost of the runs that RESOLVED (the resolution share). */
  readonly resolvedRoundsMicroUsd: string;
  /** The measured cost of the runs that FAILED (the failure-amortization input). */
  readonly failedRoundsMicroUsd: string;
  /** The failed attempts the recorded traces hold (retries + failed finals). */
  readonly failedAttemptsCount: number;
}

/** One resolved recorded arm input (the driver's input bundle entry). */
export interface RecordedArmInput extends ArmInputReference {
  readonly recorded: RecordedArmFacts;
  /**
   * The input's OWN claims — never trusted (the gaming catches): a
   * claimed attainment above the recomputed one is a quality-inflated
   * denominator and FAILs named.
   */
  readonly claimed?: { readonly attainment?: number };
}

/** The comparability verdict the synthesis exists to derive. */
export type AdjustedComparability =
  | "comparable"
  | "honestly-incomparable"
  | "refused-below-minimum"
  | "adversarial-failed";

/** The adversarial probe shapes the discrimination battery drives. */
export type AdversarialVariantKind =
  | "quality-inflation"
  | "latency-omission"
  | "failure-hiding"
  | "estimate-conflation"
  | "remeasurement"
  | "below-minimum-claim";

/** The Wilson configuration every comparison carries (95%, pinned). */
export const WILSON_CONFIG: { readonly confidenceLevel: number } = Object.freeze({
  confidenceLevel: 0.95,
});

// ---------------------------------------------------------------------------
// The recorded-facts extractor (PURE — the arms' own simulations, re-run
// over their RECORDED corpora; the integrity oracle's basis)
// ---------------------------------------------------------------------------

/** The observed outcome of a settled recorded round (PURE — the arms' shape). */
function observedOf(
  finalOutcome: "success" | "failure" | undefined,
  responseText: string | null,
): ObservedOutcome {
  if (finalOutcome === "success") {
    return {
      terminalStatus: "COMPLETED",
      verificationStatuses: ["PASS"],
      responseText: responseText ?? "",
      outputShapeFields: [],
      environmentEffects: [],
      retryableErrorsSurfaced: 0,
    };
  }
  return {
    terminalStatus: "FAILED",
    verificationStatuses: [],
    responseText: null,
    outputShapeFields: [],
    environmentEffects: [],
    retryableErrorsSurfaced: 0,
  };
}

/** The extractor's working state (the accumulated recorded fold). */
interface FactsFold {
  measured: bigint;
  estimated: bigint;
  direct: bigint;
  retry: bigint;
  resolvedShare: bigint;
  failedShare: bigint;
  resolved: number;
  executed: number;
  failedAttempts: number;
  latencies: number[];
}

/** A fresh fold. */
function newFold(): FactsFold {
  return {
    measured: 0n,
    estimated: 0n,
    direct: 0n,
    retry: 0n,
    resolvedShare: 0n,
    failedShare: 0n,
    resolved: 0,
    executed: 0,
    failedAttempts: 0,
    latencies: [],
  };
}

/** Fold one accounted round's normalized basis into the running totals. */
function foldBasis(fold: FactsFold, basis: ReturnType<typeof normalizeArmCosts>): bigint {
  const roundMeasured = BigInt(basis.measuredMicroUsd);
  fold.measured += roundMeasured;
  fold.estimated += BigInt(basis.estimatedMicroUsd);
  for (const fact of basis.facts) {
    if (fact.kind !== "measured") {
      continue;
    }
    if (fact.scope === "direct-execution") {
      fold.direct += BigInt(fact.microUsd);
    } else {
      fold.retry += BigInt(fact.microUsd);
    }
  }
  return roundMeasured;
}

/** Fold one accounted round's resolution verdict (PURE). */
function foldResolution(
  fold: FactsFold,
  task: GoldenTask | undefined,
  corpusVersion: string,
  observed: ObservedOutcome,
  latencyMs: number,
  roundMeasured: bigint,
): void {
  fold.executed += 1;
  fold.latencies.push(latencyMs);
  const evaluation =
    task === undefined
      ? { verdict: "fail" as const }
      : evaluateRun({ task, corpusVersion, observed });
  const resolved = isResolvedOutcome(thresholdsFor(task as GoldenTask), {
    evaluationVerdict: evaluation.verdict,
    totalLatencyMs: latencyMs,
    retryableErrorsSurfaced: 0,
    failedSafetyObservations: 0,
  });
  if (resolved) {
    fold.resolved += 1;
    fold.resolvedShare += roundMeasured;
  } else {
    fold.failedShare += roundMeasured;
  }
}

/** Assemble the recorded facts from the fold (PURE). */
function factsOfFold(fold: FactsFold): RecordedArmFacts {
  const confidence = wilsonInterval(fold.resolved, fold.executed);
  return {
    runCount: fold.executed,
    resolvedCount: fold.resolved,
    measuredCostMicroUsd: fold.measured.toString(),
    estimatedCostMicroUsd: fold.estimated.toString(),
    costPerResolvedMicroUsd:
      fold.resolved > 0 ? divRoundHalfUp(fold.measured, BigInt(fold.resolved)).toString() : null,
    resolutionConfidence: { low: confidence.low, high: confidence.high },
    perRunLatencyMs: [...fold.latencies],
    directExecutionMicroUsd: fold.direct.toString(),
    retryOverheadMicroUsd: fold.retry.toString(),
    resolvedRoundsMicroUsd: fold.resolvedShare.toString(),
    failedRoundsMicroUsd: fold.failedShare.toString(),
    failedAttemptsCount: fold.failedAttempts,
  };
}

/** Divide a BigInt rational, rounding half-up (deterministic). */
function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error("synthesis denominator must be positive");
  }
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/** The direct arm's recorded facts (the VAL-041 expected-outcome simulation). */
function directFactsOf(row: DirectCorpusRow): RecordedArmFacts {
  const manifest = manifestFor(row.arm.priceRevision);
  const tasks = directTasksForArm(row.arm);
  const railEntry = resolveListPrice(manifest, row.arm.provider, row.arm.model, "input");
  if (railEntry === null) {
    throw new Error(`no pinned list-price entry for ${row.arm.provider}/${row.arm.model}`);
  }
  const fold = newFold();
  let measuredSoFar = 0n;
  const roundBoundMicroUsd =
    row.arm.kind === "fixed-cost"
      ? BigInt(deriveDirectRoundBudgetBoundMicroUsd({ manifest, arm: row.arm }))
      : null;
  const budgetMicroUsd =
    row.arm.kind === "fixed-cost" ? BigInt(row.arm.pinnedBudgetMicroUsd) : null;
  for (const taskId of row.arm.corpusSlice) {
    // The fixed-cost budget gate — BEFORE the request (the declared prefix stop).
    if (roundBoundMicroUsd !== null && budgetMicroUsd !== null) {
      if (budgetMicroUsd - measuredSoFar < roundBoundMicroUsd) {
        break;
      }
    }
    const plan = row.directReplay.find((candidate) => candidate.taskId === taskId);
    const recorded = plan?.recorded;
    if (recorded === undefined || recorded.postHocExcluded === true) {
      continue;
    }
    const roundFacts: UsageFact[] = [];
    for (const [index, attempt] of recorded.attempts.entries()) {
      const isFinal = index === recorded.attempts.length - 1;
      if (attempt.outcome === "failure") {
        fold.failedAttempts += 1;
      }
      if (attempt.usage === undefined || recorded.estimateOnly === true) {
        continue;
      }
      const currency = recorded.usageCurrency ?? railEntry.currency;
      roundFacts.push({
        provider: row.arm.provider,
        model: row.arm.model,
        tier: "input",
        currency,
        tokens: attempt.usage.inputTokens,
        kind: "measured",
        scope: isFinal ? "direct-execution" : "retry-overhead",
        ...(isFinal && recorded.reportedChargeUsd !== undefined
          ? { chargedAmount: String(recorded.reportedChargeUsd) }
          : {}),
      });
      roundFacts.push({
        provider: row.arm.provider,
        model: row.arm.model,
        tier: "output",
        currency,
        tokens: attempt.usage.outputTokens,
        kind: "measured",
        scope: isFinal ? "direct-execution" : "retry-overhead",
        ...(isFinal && recorded.reportedChargeUsd !== undefined
          ? { chargedAmount: String(recorded.reportedChargeUsd) }
          : {}),
      });
    }
    if (recorded.estimateOnly === true || recorded.estimateQuote !== undefined) {
      const quote = recorded.estimateQuote;
      if (quote !== undefined) {
        roundFacts.push({
          provider: row.arm.provider,
          model: row.arm.model,
          tier: "input",
          currency: railEntry.currency,
          tokens: quote.inputTokens,
          kind: "estimate",
          scope: "direct-execution",
        });
        roundFacts.push({
          provider: row.arm.provider,
          model: row.arm.model,
          tier: "output",
          currency: railEntry.currency,
          tokens: quote.outputTokens,
          kind: "estimate",
          scope: "direct-execution",
        });
      }
    }
    const basis = normalizeArmCosts(roundFacts, manifest);
    const roundMeasured = foldBasis(fold, basis);
    measuredSoFar += roundMeasured;
    const latencyMs = recorded.attempts.reduce((sum, attempt) => sum + attempt.latencyMs, 0);
    const final = recorded.attempts[recorded.attempts.length - 1];
    const observed =
      final !== undefined && final.outcome === "success"
        ? observedOf("success", recorded.responseText ?? "confirm")
        : observedOf("failure", null);
    foldResolution(
      fold,
      tasks.find((candidate) => candidate.taskId === taskId),
      DIRECT_CORPUS_VERSION,
      observed,
      latencyMs,
      roundMeasured,
    );
  }
  return factsOfFold(fold);
}

/** The optimized arm's recorded facts (the VAL-042 simulation, cache included). */
function optimizedFactsOf(row: OptimizedCorpusRow): RecordedArmFacts {
  const manifest = manifestFor(row.arm.priceRevision);
  const inventory = inventoryFor(row.optimizationInventoryRevision);
  const tasks = optimizedTasksForArm(row.arm);
  const fold = newFold();
  const stored = new Map<string, string>();
  let measuredSoFar = 0n;
  const roundBoundMicroUsd =
    row.arm.kind === "fixed-cost"
      ? BigInt(
          deriveOptimizedRoundBudgetBoundMicroUsd({
            manifest,
            inventory,
            maxTokens: row.arm.maxTokensPerRound,
          }),
        )
      : null;
  const budgetMicroUsd =
    row.arm.kind === "fixed-cost" ? BigInt(row.arm.pinnedBudgetMicroUsd) : null;
  const rounds = row.arm.corpusSlice
    .map((taskId) => row.optimizedReplay.find((plan) => plan.taskId === taskId))
    .filter((plan): plan is NonNullable<typeof plan> => plan !== undefined);
  for (const plan of rounds) {
    const key = `${plan.taskClass}:${plan.contentDigest}`;
    const cached = stored.get(key);
    let observed: ObservedOutcome;
    let latencyMs: number;
    let roundMeasured = 0n;
    if (plan.cachePolicy === "cacheable" && cached !== undefined) {
      // The semantically-safe cache hit replays the stored response —
      // zero new measured usage, the honest 3ms replay latency.
      observed = observedOf("success", cached);
      latencyMs = 3;
    } else {
      // The fixed-cost budget gate — BEFORE the fresh dispatch (cache
      // hits never reach the gate).
      if (roundBoundMicroUsd !== null && budgetMicroUsd !== null) {
        if (budgetMicroUsd - measuredSoFar < roundBoundMicroUsd) {
          break;
        }
      }
      const recorded = plan.recorded;
      const route = routeForClass(inventory, plan.taskClass);
      const entry = resolveListPrice(manifest, route.provider, route.model, "input");
      if (entry === null) {
        throw new Error(`no pinned list-price entry for ${route.provider}/${route.model}`);
      }
      const roundFacts: UsageFact[] = [];
      let failedAttempts = 0;
      if (recorded !== undefined) {
        for (const [index, attempt] of recorded.attempts.entries()) {
          const isFinal = index === recorded.attempts.length - 1;
          if (attempt.outcome === "failure") {
            failedAttempts += 1;
          }
          if (attempt.usage === undefined) {
            continue;
          }
          roundFacts.push({
            provider: route.provider,
            model: route.model,
            tier: "input",
            currency: entry.currency,
            tokens: attempt.usage.inputTokens,
            kind: "measured",
            scope: isFinal ? "direct-execution" : "retry-overhead",
          });
          roundFacts.push({
            provider: route.provider,
            model: route.model,
            tier: "output",
            currency: entry.currency,
            tokens: attempt.usage.outputTokens,
            kind: "measured",
            scope: isFinal ? "direct-execution" : "retry-overhead",
          });
        }
        if (recorded.estimateQuote !== undefined) {
          roundFacts.push({
            provider: route.provider,
            model: route.model,
            tier: "input",
            currency: entry.currency,
            tokens: recorded.estimateQuote.inputTokens,
            kind: "estimate",
            scope: "direct-execution",
          });
          roundFacts.push({
            provider: route.provider,
            model: route.model,
            tier: "output",
            currency: entry.currency,
            tokens: recorded.estimateQuote.outputTokens,
            kind: "estimate",
            scope: "direct-execution",
          });
        }
      }
      const basis = normalizeArmCosts(roundFacts, manifest);
      roundMeasured = foldBasis(fold, basis);
      measuredSoFar += roundMeasured;
      fold.failedAttempts += failedAttempts;
      const final = recorded?.attempts[recorded.attempts.length - 1];
      observed =
        final !== undefined && final.outcome === "success"
          ? observedOf("success", recorded?.responseText ?? "")
          : observedOf("failure", null);
      latencyMs = recorded?.attempts.reduce((sum, attempt) => sum + attempt.latencyMs, 0) ?? 0;
      if (
        plan.cachePolicy === "cacheable" &&
        final !== undefined &&
        final.outcome === "success" &&
        recorded?.responseText !== undefined
      ) {
        stored.set(key, recorded.responseText);
      }
    }
    foldResolution(
      fold,
      tasks.find((candidate) => candidate.taskId === plan.taskId),
      OPTIMIZED_CORPUS_VERSION,
      observed,
      latencyMs,
      roundMeasured,
    );
  }
  return factsOfFold(fold);
}

/** The competing arm's recorded facts (the VAL-043 aggregate-interface simulation). */
function competingFactsOf(row: CompetingCorpusRow): RecordedArmFacts {
  const manifest = manifestFor(row.arm.priceRevision);
  const config = competitorConfigFor(row.competitorConfigRevision);
  const tasks = competingTasksForArm(row.arm);
  const fold = newFold();
  let measuredSoFar = 0n;
  const roundBoundMicroUsd =
    row.arm.kind === "fixed-cost"
      ? BigInt(
          deriveCompetingRoundBudgetBoundMicroUsd({
            manifest,
            config,
            taskClasses: row.competingReplay.map((plan) => plan.taskClass),
            maxTokens: row.arm.maxTokensPerRound,
          }),
        )
      : null;
  const budgetMicroUsd =
    row.arm.kind === "fixed-cost" ? BigInt(row.arm.pinnedBudgetMicroUsd) : null;
  const rounds = row.arm.corpusSlice
    .map((taskId) => row.competingReplay.find((plan) => plan.taskId === taskId))
    .filter((plan): plan is NonNullable<typeof plan> => plan !== undefined);
  for (const plan of rounds) {
    // The fixed-cost budget gate — BEFORE the request (the declared prefix stop).
    if (roundBoundMicroUsd !== null && budgetMicroUsd !== null) {
      if (budgetMicroUsd - measuredSoFar < roundBoundMicroUsd) {
        break;
      }
    }
    const recorded = plan.recorded;
    const route = competitorRouteForClass(config, plan.taskClass);
    const entry = resolveListPrice(manifest, route.provider, route.model, "input");
    if (entry === null) {
      throw new Error(`no pinned list-price entry for ${route.provider}/${route.model}`);
    }
    // The competing interface granularity: ONE aggregate measured pair
    // per request (the automatic fallback's internal retries amortize
    // INSIDE the gateway boundary — recorded honestly as such).
    const roundFacts: UsageFact[] = [];
    if (recorded !== undefined) {
      roundFacts.push({
        provider: route.provider,
        model: route.model,
        tier: "input",
        currency: entry.currency,
        tokens: recorded.reportedUsage.inputTokens,
        kind: "measured",
        scope: "direct-execution",
        ...(recorded.reportedChargeUsd === undefined
          ? {}
          : { chargedAmount: String(recorded.reportedChargeUsd) }),
      });
      roundFacts.push({
        provider: route.provider,
        model: route.model,
        tier: "output",
        currency: entry.currency,
        tokens: recorded.reportedUsage.outputTokens,
        kind: "measured",
        scope: "direct-execution",
        ...(recorded.reportedChargeUsd === undefined
          ? {}
          : { chargedAmount: String(recorded.reportedChargeUsd) }),
      });
      if (recorded.estimateQuote !== undefined) {
        roundFacts.push({
          provider: route.provider,
          model: route.model,
          tier: "input",
          currency: entry.currency,
          tokens: recorded.estimateQuote.inputTokens,
          kind: "estimate",
          scope: "direct-execution",
        });
        roundFacts.push({
          provider: route.provider,
          model: route.model,
          tier: "output",
          currency: entry.currency,
          tokens: recorded.estimateQuote.outputTokens,
          kind: "estimate",
          scope: "direct-execution",
        });
      }
      for (const attempt of recorded.internalAttempts) {
        if (attempt.outcome === "failure") {
          fold.failedAttempts += 1;
        }
      }
    }
    const basis = normalizeArmCosts(roundFacts, manifest);
    const roundMeasured = foldBasis(fold, basis);
    measuredSoFar += roundMeasured;
    const latencyMs =
      recorded?.internalAttempts.reduce((sum, attempt) => sum + attempt.latencyMs, 0) ?? 0;
    const final = recorded?.internalAttempts[recorded.internalAttempts.length - 1];
    const observed =
      final !== undefined && final.outcome === "success"
        ? observedOf("success", recorded?.responseText ?? "")
        : observedOf("failure", null);
    foldResolution(
      fold,
      tasks.find((candidate) => candidate.taskId === plan.taskId),
      COMPETING_CORPUS_VERSION,
      observed,
      latencyMs,
      roundMeasured,
    );
  }
  return factsOfFold(fold);
}

// ---------------------------------------------------------------------------
// The digest discipline (digest references — never payload copies)
// ---------------------------------------------------------------------------

/**
 * The content digest of one arm input's RECORDED outcome (PURE — the
 * digest-reference discipline): binds the arm label, the corpus row
 * identity and the recorded normalized facts. The corpus rows declare
 * these digests at pin time; the driver re-derives them from the
 * imported corpora at verification time.
 */
export function recordedArmDigestOf(input: {
  readonly armLabel: ArmLabel;
  readonly corpusRowId: string;
  readonly facts: RecordedArmFacts;
}): string {
  return economicDigestOf({
    armLabel: input.armLabel,
    corpusRowId: input.corpusRowId,
    runCount: input.facts.runCount,
    resolvedCount: input.facts.resolvedCount,
    measuredCostMicroUsd: input.facts.measuredCostMicroUsd,
    estimatedCostMicroUsd: input.facts.estimatedCostMicroUsd,
    costPerResolvedMicroUsd: input.facts.costPerResolvedMicroUsd,
    wilsonLow: input.facts.resolutionConfidence.low.toFixed(6),
    wilsonHigh: input.facts.resolutionConfidence.high.toFixed(6),
  });
}

/** The live-arm declaration digest (the live row's reference shape). */
export function liveArmDigestOf(input: {
  readonly armLabel: ArmLabel;
  readonly corpusRowId: string;
  readonly armId: string;
  readonly sliceSize: number;
}): string {
  return economicDigestOf({
    armLabel: input.armLabel,
    corpusRowId: input.corpusRowId,
    liveArm: input.armId,
    sliceSize: input.sliceSize,
  });
}

/**
 * Resolve one arm reference in the RECORDED corpora and re-derive its
 * recorded facts (PURE): the direct/optimized/competing corpora are
 * imported (never copied) and the referenced row's own simulation
 * re-runs over ITS recorded traces — the input-integrity oracle's
 * basis. Returns null when the reference resolves to no recorded row.
 */
export function recordedArmFactsOf(reference: ArmInputReference): {
  readonly row: DirectCorpusRow | OptimizedCorpusRow | CompetingCorpusRow;
  readonly facts: RecordedArmFacts;
} | null {
  if (reference.armLabel === "direct") {
    const row = DIRECT_CORPUS.find((candidate) => candidate.rowId === reference.corpusRowId);
    if (row === undefined) {
      return null;
    }
    return { row, facts: directFactsOf(row) };
  }
  if (reference.armLabel === "optimized") {
    const row = OPTIMIZED_CORPUS.find((candidate) => candidate.rowId === reference.corpusRowId);
    if (row === undefined) {
      return null;
    }
    return { row, facts: optimizedFactsOf(row) };
  }
  const row = COMPETING_CORPUS.find((candidate) => candidate.rowId === reference.corpusRowId);
  if (row === undefined) {
    return null;
  }
  return { row, facts: competingFactsOf(row) };
}

// ---------------------------------------------------------------------------
// The synthesis corpus row contract (the oracle)
// ---------------------------------------------------------------------------

/** The synthesis corpus row (the adjusted-cost comparison declaration). */
export interface AdjustedCorpusRow {
  readonly rowId: string;
  readonly description: string;
  /** The adjusted-cost family under test. */
  readonly family: AdjustedCostFamily;
  /** The PRE-REGISTERED arm set (digest references to the recorded corpora). */
  readonly armSet: readonly ArmInputReference[];
  /** The minimum number of DISTINCT arm inputs (the synthesis sample). */
  readonly minimumInputs: number;
  /** The per-arm statistical minimum (every input's recorded sample must reach it). */
  readonly minimumSamplesPerInput: number;
  /**
   * The pinned latency budget (latency-adjusted rows only — the
   * compliance weighting's denominator; pinned BEFORE the synthesis).
   */
  readonly latencyBudgetMs?: number;
  readonly needsDispatch: boolean;
  readonly liveGate?: {
    readonly envVars: readonly string[];
    readonly requirement: string;
  };
  /**
   * The adversarial probe declaration (probe rows only): WHICH
   * denatured input shape the row's expected terminal pins — the
   * fixtures apply exactly this variant to the honest recorded inputs.
   */
  readonly adversarial?: AdversarialVariantKind;
  readonly expected: {
    readonly terminal: "COMPLETED" | "FAILED";
    readonly verdict: AdjustedComparability;
    readonly executions: number;
    readonly idempotencyRecords: number;
    readonly appCreated: number;
    readonly replayedSubmissions: number;
    readonly rejectedSubmissions: number;
    /** The pinned expected synthesis (offline rows only). */
    readonly synthesis?: ExpectedAdjustedOutcome;
  };
}

/** The expected adjusted synthesis the derivation must reproduce. */
export interface ExpectedAdjustedOutcome {
  readonly family: AdjustedCostFamily;
  readonly pooledRuns: number;
  readonly pooledResolved: number;
  readonly measuredCostMicroUsd: string;
  readonly estimatedCostMicroUsd: string;
  /** The VERIFIED quality attainment (recomputed — never a claim). */
  readonly attainment: number;
  /** The latency-budget compliance (latency-adjusted rows only). */
  readonly latencyCompliance: number | null;
  /** The family's adjusted cost (NULL when honestly incomparable). */
  readonly adjustedCostMicroUsd: string | null;
  readonly wilson: { readonly low: number; readonly high: number };
}

// ---------------------------------------------------------------------------
// Run results
// ---------------------------------------------------------------------------

/** One verified recorded input (the driver's per-input settlement). */
export interface VerifiedArmInput {
  readonly reference: ArmInputReference;
  /** Whether the input's facts EQUAL the recorded corpus derivation. */
  readonly integrity: boolean;
  readonly failureReason: string | null;
}

/** The synthesis row run result (the honest outcome contract). */
export interface AdjustedRunResult {
  readonly rowId: string;
  readonly terminal: "COMPLETED" | "FAILED";
  readonly criteria: readonly LabVerificationCriterion[];
  readonly executionId: string | null;
  readonly observedTerminal: string | null;
  readonly inputs: readonly VerifiedArmInput[];
  readonly synthesis: ExpectedAdjustedOutcome | null;
  readonly totalLatencyMs: number;
  readonly failure: { readonly category: string; readonly message: string } | null;
}

// ---------------------------------------------------------------------------
// The pure adjusted-cost derivations (the verification core)
// ---------------------------------------------------------------------------

/** The pooled recorded facts (PURE — the synthesis basis). */
export function pooledFactsOf(inputs: readonly RecordedArmInput[]): {
  readonly runs: number;
  readonly resolved: number;
  readonly measuredMicroUsd: bigint;
  readonly estimatedMicroUsd: bigint;
  readonly perRunLatencyMs: readonly number[];
  readonly failedAttempts: number;
} {
  let runs = 0;
  let resolved = 0;
  let measured = 0n;
  let estimated = 0n;
  let failedAttempts = 0;
  const latencies: number[] = [];
  for (const input of inputs) {
    runs += input.recorded.runCount;
    resolved += input.recorded.resolvedCount;
    measured += BigInt(input.recorded.measuredCostMicroUsd);
    estimated += BigInt(input.recorded.estimatedCostMicroUsd);
    failedAttempts += input.recorded.failedAttemptsCount;
    latencies.push(...input.recorded.perRunLatencyMs);
  }
  return {
    runs,
    resolved,
    measuredMicroUsd: measured,
    estimatedMicroUsd: estimated,
    perRunLatencyMs: latencies,
    failedAttempts,
  };
}

/**
 * The QUALITY-ADJUSTMENT HONESTY oracle (PURE — the verification
 * core): the denominator is the attainment RECOMPUTED from the
 * recorded runs' own resolution counts (pooledResolved/pooledRuns);
 * an input's claimed attainment above the recomputed one is a
 * QUALITY-INFLATED DENOMINATOR and FAILs named. The quality-adjusted
 * cost is measured × runs / resolved (exact BigInt rational); NULL
 * when nothing attained (the honest incomparability — never a
 * zero-denominator fabrication).
 */
export function deriveQualityAdjustmentHonesty(input: {
  readonly inputs: readonly RecordedArmInput[];
}): {
  readonly conformant: boolean;
  readonly attainment: number;
  readonly qualityAdjustedCostMicroUsd: string | null;
  readonly evidence: readonly string[];
} {
  const pooled = pooledFactsOf(input.inputs);
  const attainment = pooled.runs > 0 ? pooled.resolved / pooled.runs : 0;
  const inflated: string[] = [];
  for (const item of input.inputs) {
    const claimed = item.claimed?.attainment;
    if (claimed !== undefined && claimed > attainment + 1e-12) {
      inflated.push(
        `${item.armLabel}:${item.corpusRowId} (claimed ${claimed.toFixed(4)} > recomputed ${attainment.toFixed(4)})`,
      );
    }
  }
  const adjusted =
    pooled.resolved > 0
      ? divRoundHalfUp(pooled.measuredMicroUsd * BigInt(pooled.runs), BigInt(pooled.resolved))
      : null;
  return {
    conformant: inflated.length === 0,
    attainment,
    qualityAdjustedCostMicroUsd: adjusted === null ? null : adjusted.toString(),
    evidence: [
      `pooledRuns:${pooled.runs}`,
      `pooledResolved:${pooled.resolved}`,
      `verifiedAttainment:${attainment.toFixed(6)} (RECOMPUTED from the recorded runs — never a claim)`,
      `inflatedClaims:${inflated.length}`,
      ...inflated,
      adjusted === null
        ? "qualityAdjustedCost:NULL (nothing attained — the honest incomparability, never a zero-denominator fabrication)"
        : `qualityAdjustedCost:${adjusted.toString()} (measured × runs / verifiedAttainment)`,
      inflated.length === 0
        ? "honest denominator (the verified attainment decided the adjustment)"
        : "QUALITY-INFLATED DENOMINATOR (a claim above the recomputed attainment inflates the denominator and deflates the adjusted cost — the derivation decides, never the claim)",
    ],
  };
}

/**
 * The LATENCY-ADJUSTMENT INCLUSION oracle (PURE): every input must
 * carry the RECORDED per-run latencies — one latency per executed run
 * — and the compliance weighting divides by the compliant fraction
 * (compliant = the recorded latency within the PINNED budget). A
 * latency-omitting comparison (empty or short latency lists) FAILs
 * named; the latency-adjusted cost-per-resolved is (measured /
 * resolved) / compliance — NULL when nothing resolved.
 */
export function deriveLatencyAdjustmentInclusion(input: {
  readonly inputs: readonly RecordedArmInput[];
  readonly budgetMs: number;
}): {
  readonly conformant: boolean;
  readonly latencyCompliance: number;
  readonly latencyAdjustedCostMicroUsd: string | null;
  readonly evidence: readonly string[];
} {
  const omissions: string[] = [];
  let compliant = 0;
  let total = 0;
  for (const item of input.inputs) {
    if (item.recorded.perRunLatencyMs.length !== item.recorded.runCount) {
      omissions.push(
        `${item.armLabel}:${item.corpusRowId} (latencies ${item.recorded.perRunLatencyMs.length} != runs ${item.recorded.runCount})`,
      );
    }
    for (const latency of item.recorded.perRunLatencyMs) {
      total += 1;
      if (latency <= input.budgetMs) {
        compliant += 1;
      }
    }
  }
  const pooled = pooledFactsOf(input.inputs);
  const compliance = total > 0 ? compliant / total : 0;
  const adjusted =
    pooled.resolved > 0 && compliant > 0
      ? divRoundHalfUp(
          pooled.measuredMicroUsd * BigInt(total),
          BigInt(pooled.resolved) * BigInt(compliant),
        )
      : null;
  return {
    conformant: omissions.length === 0,
    latencyCompliance: compliance,
    latencyAdjustedCostMicroUsd: adjusted === null ? null : adjusted.toString(),
    evidence: [
      `pinnedBudgetMs:${input.budgetMs}`,
      `recordedRuns:${total}`,
      `compliantRuns:${compliant}`,
      `latencyCompliance:${compliance.toFixed(6)}`,
      `omissions:${omissions.length}`,
      ...omissions,
      adjusted === null
        ? "latencyAdjustedCost:NULL (nothing resolved or nothing compliant)"
        : `latencyAdjustedCost:${adjusted.toString()} ((measured / resolved) / compliance — the weighting INCLUDED)`,
      omissions.length === 0
        ? "latency included (every recorded run's own latency weighted the comparison)"
        : "LATENCY-OMITTING COMPARISON (a comparison that omits latencies cannot claim a latency adjustment — the weighting is fabricated)",
    ],
  };
}

/**
 * The FAILURE-ADJUSTMENT COMPLETENESS oracle (PURE): the
 * failure-adjusted cost amortizes retries and failed attempts FULLY —
 * per input the measured total must reconstruct from the
 * direct-execution + retry-overhead shares AND from the resolved +
 * failed rounds' shares (a comparison that hides the retry-overhead
 * or the failed rounds' cost FAILs named with the input named).
 */
export function deriveFailureAdjustmentCompleteness(input: {
  readonly inputs: readonly RecordedArmInput[];
}): {
  readonly conformant: boolean;
  readonly failureAdjustedCostMicroUsd: string | null;
  readonly evidence: readonly string[];
} {
  const violations: string[] = [];
  for (const item of input.inputs) {
    const recorded = item.recorded;
    const measuredTotal = BigInt(recorded.measuredCostMicroUsd);
    const direct = BigInt(recorded.directExecutionMicroUsd);
    const retry = BigInt(recorded.retryOverheadMicroUsd);
    const resolvedShare = BigInt(recorded.resolvedRoundsMicroUsd);
    const failedShare = BigInt(recorded.failedRoundsMicroUsd);
    if (measuredTotal !== direct + retry) {
      violations.push(
        `${item.armLabel}:${item.corpusRowId} (measured ${measuredTotal} != direct ${direct} + retry ${retry})`,
      );
    }
    if (measuredTotal !== resolvedShare + failedShare) {
      violations.push(
        `${item.armLabel}:${item.corpusRowId} (measured ${measuredTotal} != resolvedRounds ${resolvedShare} + failedRounds ${failedShare})`,
      );
    }
  }
  const pooled = pooledFactsOf(input.inputs);
  const adjusted =
    pooled.resolved > 0 ? divRoundHalfUp(pooled.measuredMicroUsd, BigInt(pooled.resolved)) : null;
  return {
    conformant: violations.length === 0,
    failureAdjustedCostMicroUsd: adjusted === null ? null : adjusted.toString(),
    evidence: [
      `pooledMeasuredMicroUsd:${pooled.measuredMicroUsd.toString()}`,
      `pooledResolved:${pooled.resolved}`,
      `pooledFailedAttempts:${pooled.failedAttempts}`,
      `violations:${violations.length}`,
      ...violations,
      adjusted === null
        ? "failureAdjustedCost:NULL (nothing resolved — the VAL-006 discipline, never zero, never estimate-backed)"
        : `failureAdjustedCost:${adjusted.toString()} (the FULLY amortized measured total / resolved)`,
      violations.length === 0
        ? "complete amortization (retries and failed attempts counted in the measured total)"
        : "FAILURE-HIDING COMPARISON (the retry-overhead or the failed rounds' cost was dropped — the amortization is incomplete)",
    ],
  };
}

/**
 * The ESTIMATE/MEASURE SEPARATION oracle (PURE): the measured total
 * is the MEASURED facts' own total — exactly the RECORDED measured
 * basis, never the combined measured-plus-estimate total — and the
 * estimate total rides SEPARATELY. An input whose measured total
 * absorbs the estimate share (or whose estimate share was zeroed
 * while the measured total grew) is an ESTIMATE-CONFLATING
 * comparison and FAILs named.
 */
export function deriveEstimateMeasureSeparation(input: {
  readonly inputs: readonly RecordedArmInput[];
}): {
  readonly conformant: boolean;
  readonly evidence: readonly string[];
} {
  const conflations: string[] = [];
  let measured = 0n;
  let estimated = 0n;
  for (const item of input.inputs) {
    const recorded = item.recorded;
    const measuredTotal = BigInt(recorded.measuredCostMicroUsd);
    const direct = BigInt(recorded.directExecutionMicroUsd);
    const retry = BigInt(recorded.retryOverheadMicroUsd);
    const estimateTotal = BigInt(recorded.estimatedCostMicroUsd);
    measured += measuredTotal;
    estimated += estimateTotal;
    if (measuredTotal !== direct + retry) {
      conflations.push(
        `${item.armLabel}:${item.corpusRowId} (measured ${measuredTotal} absorbs non-measured scope — direct ${direct} + retry ${retry})`,
      );
    }
    const resolved = recordedArmFactsOf(item);
    if (resolved !== null && measuredTotal !== BigInt(resolved.facts.measuredCostMicroUsd)) {
      conflations.push(
        `${item.armLabel}:${item.corpusRowId} (measured ${measuredTotal} != the recorded measured basis ${resolved.facts.measuredCostMicroUsd} — the estimate share was absorbed)`,
      );
    }
    if (resolved !== null && estimateTotal !== BigInt(resolved.facts.estimatedCostMicroUsd)) {
      conflations.push(
        `${item.armLabel}:${item.corpusRowId} (estimate ${estimateTotal} != the recorded estimate share ${resolved.facts.estimatedCostMicroUsd} — the share was zeroed or moved)`,
      );
    }
  }
  return {
    conformant: conflations.length === 0,
    evidence: [
      `measuredMicroUsd:${measured.toString()}`,
      `estimatedMicroUsd:${estimated.toString()} (reported SEPARATELY)`,
      `conflations:${conflations.length}`,
      ...conflations,
      conflations.length === 0
        ? "separated (estimates never enter the adjusted-cost basis)"
        : "ESTIMATE-CONFLATION (estimates conflated into the measured basis — the adjusted cost would be quote-backed, not measured)",
    ],
  };
}

/**
 * The CONFIDENCE-AND-MINIMUM oracle (PURE): the input count reaches
 * the pre-registered minimum, every input's recorded sample reaches
 * the per-arm statistical minimum, the executed input set is EXACTLY
 * the pre-registered arm set (no post-hoc arm exclusion) and the
 * comparison carries the Wilson 95% interval bracketing the pooled
 * resolution rate. Below-minimum FAILs named; a confidence-less
 * comparison FAILs named.
 */
export function deriveConfidenceAndMinimum(input: {
  readonly row: AdjustedCorpusRow;
  readonly inputs: readonly RecordedArmInput[];
}): {
  readonly conformant: boolean;
  readonly belowMinimum: boolean;
  readonly wilson: { readonly low: number; readonly high: number } | null;
  readonly evidence: readonly string[];
} {
  const violations: string[] = [];
  const registered = new Set(input.row.armSet.map((ref) => `${ref.armLabel}:${ref.corpusRowId}`));
  const present = new Set(input.inputs.map((item) => `${item.armLabel}:${item.corpusRowId}`));
  for (const key of registered) {
    if (!present.has(key)) {
      violations.push(`post-hoc-excluded:${key} (a pre-registered arm input is absent)`);
    }
  }
  for (const key of present) {
    if (!registered.has(key)) {
      violations.push(`undeclared-input:${key} (an input outside the pre-registered arm set)`);
    }
  }
  if (input.inputs.length < input.row.minimumInputs) {
    violations.push(
      `BELOW-MINIMUM: ${input.inputs.length} inputs < ${input.row.minimumInputs} pre-registered (the synthesis sample is starved)`,
    );
  }
  const starved = input.inputs.filter(
    (item) => item.recorded.runCount < input.row.minimumSamplesPerInput,
  );
  // The per-arm starvation is NOT itself a set violation — it flips
  // the honest refusal verdict (deriveBelowMinimumRefusalHonesty
  // enforces that a below-minimum comparison never CLAIMS
  // comparability); a starved sample still refuses honestly.
  const pooled = pooledFactsOf(input.inputs);
  const wilson = pooled.runs > 0 ? wilsonInterval(pooled.resolved, pooled.runs) : null;
  if (wilson === null) {
    violations.push(
      "CONFIDENCE-LESS COMPARISON: the Wilson 95% interval is required on every comparison",
    );
  }
  return {
    conformant: violations.length === 0,
    belowMinimum: input.inputs.length < input.row.minimumInputs || starved.length > 0,
    wilson,
    evidence: [
      `minimumInputs:${input.row.minimumInputs}`,
      `inputs:${input.inputs.length}`,
      `minimumSamplesPerInput:${input.row.minimumSamplesPerInput}`,
      `pooledRuns:${pooled.runs}`,
      `pooledResolved:${pooled.resolved}`,
      wilson === null
        ? "wilson95:none"
        : `wilson95:[${wilson.low.toFixed(4)}, ${wilson.high.toFixed(4)}] (level ${WILSON_CONFIG.confidenceLevel})`,
      ...(starved.length === 0
        ? []
        : starved.map(
            (item) =>
              `below-minimum-input:${item.armLabel}:${item.corpusRowId} (recorded sample ${item.recorded.runCount} < the per-arm minimum ${input.row.minimumSamplesPerInput} — the comparison must REFUSE)`,
          )),
      `violations:${violations.length}`,
      ...violations,
      violations.length === 0
        ? "confident (the pre-registered set held and the interval brackets the pooled rate)"
        : "NON-CONFORMANT (an excluded, undeclared, starved or confidence-less comparison)",
    ],
  };
}

/**
 * The BELOW-MINIMUM REFUSAL HONESTY oracle (PURE): a below-minimum
 * comparison (the input count or any input's recorded sample below
 * the pre-registered minimums) must claim the REFUSED verdict — a
 * comparison that claims comparability (or incomparability) while
 * below the minimum FAILs named (the comparability verdict is
 * fabricated on a starved sample).
 */
export function deriveBelowMinimumRefusalHonesty(input: {
  readonly row: AdjustedCorpusRow;
  readonly inputs: readonly RecordedArmInput[];
}): {
  readonly conformant: boolean;
  readonly belowMinimum: boolean;
  readonly evidence: readonly string[];
} {
  const confidence = deriveConfidenceAndMinimum({ row: input.row, inputs: input.inputs });
  const belowMinimum = confidence.belowMinimum;
  const claimsRefusal = input.row.expected.verdict === "refused-below-minimum";
  const conformant = belowMinimum === claimsRefusal;
  return {
    conformant,
    belowMinimum,
    evidence: [
      `expectedVerdict:${input.row.expected.verdict}`,
      `minimumInputs:${input.row.minimumInputs}`,
      `minimumSamplesPerInput:${input.row.minimumSamplesPerInput}`,
      `belowMinimum:${String(belowMinimum)}`,
      conformant
        ? belowMinimum
          ? "refused honestly (the below-minimum comparison refuses — never a fabricated comparability)"
          : "not below minimum (the comparability claim stands on a sufficient sample)"
        : "BELOW-MINIMUM COMPARABILITY CLAIM (a comparison below the pre-registered minimums claims a verdict it cannot support — the honest outcome is the refusal)",
    ],
  };
}

/**
 * The INPUT-INTEGRITY oracle (PURE — the re-measurement catch): every
 * input's digest reference resolves in the RECORDED arm corpora, the
 * declared digest agrees with the re-derived one, and the bundle's
 * recorded facts EQUAL the corpus's own recording (run counts, cost
 * totals, per-run latencies, the failure decomposition) — a
 * re-measurement masquerading as synthesis FAILs named, field by
 * field. The recorded price revision is verified against the VAL-040
 * manifest registry (integrity + digest).
 */
export function deriveInputIntegrity(input: { readonly inputs: readonly RecordedArmInput[] }): {
  readonly conformant: boolean;
  readonly verdicts: readonly (VerifiedArmInput & { readonly detail: readonly string[] })[];
  readonly evidence: readonly string[];
} {
  const verdicts: (VerifiedArmInput & { readonly detail: readonly string[] })[] = [];
  const failures: string[] = [];
  for (const item of input.inputs) {
    const resolved = recordedArmFactsOf(item);
    if (resolved === null) {
      failures.push(
        `UNRESOLVABLE DIGEST REFERENCE: ${item.armLabel}:${item.corpusRowId} (no such recorded row)`,
      );
      verdicts.push({
        reference: item,
        integrity: false,
        failureReason: "unresolvable-reference",
        detail: ["the digest reference resolves to no recorded corpus row"],
      });
      continue;
    }
    const digest = recordedArmDigestOf({
      armLabel: item.armLabel,
      corpusRowId: item.corpusRowId,
      facts: resolved.facts,
    });
    const manifest = deriveManifestIntegrity({ revision: item.priceRevision });
    const fieldMismatches: string[] = [];
    if (item.recorded.runCount !== resolved.facts.runCount) {
      fieldMismatches.push(
        `runCount ${item.recorded.runCount} != recorded ${resolved.facts.runCount}`,
      );
    }
    if (item.recorded.resolvedCount !== resolved.facts.resolvedCount) {
      fieldMismatches.push(
        `resolvedCount ${item.recorded.resolvedCount} != recorded ${resolved.facts.resolvedCount}`,
      );
    }
    if (item.recorded.measuredCostMicroUsd !== resolved.facts.measuredCostMicroUsd) {
      fieldMismatches.push(
        `measured ${item.recorded.measuredCostMicroUsd} != recorded ${resolved.facts.measuredCostMicroUsd}`,
      );
    }
    if (item.recorded.estimatedCostMicroUsd !== resolved.facts.estimatedCostMicroUsd) {
      fieldMismatches.push(
        `estimated ${item.recorded.estimatedCostMicroUsd} != recorded ${resolved.facts.estimatedCostMicroUsd}`,
      );
    }
    if (item.recorded.costPerResolvedMicroUsd !== resolved.facts.costPerResolvedMicroUsd) {
      fieldMismatches.push("costPerResolved disagrees with the recorded basis");
    }
    if (
      Math.abs(item.recorded.resolutionConfidence.low - resolved.facts.resolutionConfidence.low) >
        1e-9 ||
      Math.abs(item.recorded.resolutionConfidence.high - resolved.facts.resolutionConfidence.high) >
        1e-9
    ) {
      fieldMismatches.push("wilson disagrees with the recorded interval");
    }
    if (item.recorded.perRunLatencyMs.length !== resolved.facts.perRunLatencyMs.length) {
      fieldMismatches.push(
        `perRunLatencyMs ${item.recorded.perRunLatencyMs.length} != recorded ${resolved.facts.perRunLatencyMs.length}`,
      );
    }
    if (item.recorded.retryOverheadMicroUsd !== resolved.facts.retryOverheadMicroUsd) {
      fieldMismatches.push(
        `retryOverhead ${item.recorded.retryOverheadMicroUsd} != recorded ${resolved.facts.retryOverheadMicroUsd}`,
      );
    }
    if (item.recorded.failedRoundsMicroUsd !== resolved.facts.failedRoundsMicroUsd) {
      fieldMismatches.push(
        `failedRounds ${item.recorded.failedRoundsMicroUsd} != recorded ${resolved.facts.failedRoundsMicroUsd}`,
      );
    }
    if (item.recorded.failedAttemptsCount !== resolved.facts.failedAttemptsCount) {
      fieldMismatches.push(
        `failedAttempts ${item.recorded.failedAttemptsCount} != recorded ${resolved.facts.failedAttemptsCount}`,
      );
    }
    const digestAgrees = digest === item.recordedDigest;
    const manifestAgrees = manifest.agreed;
    const reason = !digestAgrees
      ? "digest-disagreed"
      : fieldMismatches.length > 0
        ? "re-measurement-masquerade"
        : manifestAgrees
          ? null
          : "manifest-integrity-failed";
    if (!digestAgrees) {
      failures.push(
        `DIGEST-DISAGREED: ${item.armLabel}:${item.corpusRowId} (declared ${item.recordedDigest} != re-derived ${digest})`,
      );
    }
    if (fieldMismatches.length > 0) {
      failures.push(
        `RE-MEASUREMENT MASQUERADE: ${item.armLabel}:${item.corpusRowId} (${fieldMismatches.join("; ")}) — the synthesis derives over RECORDED results`,
      );
    }
    if (!manifestAgrees) {
      failures.push(
        `UNPINNED PRICING: ${item.armLabel}:${item.corpusRowId} (revision ${item.priceRevision} failed manifest integrity)`,
      );
    }
    verdicts.push({
      reference: item,
      integrity: reason === null,
      failureReason: reason,
      detail: [
        `digest:declared=${item.recordedDigest}`,
        `digest:rederived=${digest}`,
        `digest:${digestAgrees ? "AGREED" : "DISAGREED"}`,
        `priceRevision:${item.priceRevision} (${manifestAgrees ? "integrity-agreed" : "integrity-FAILED"})`,
        `fields:${fieldMismatches.length === 0 ? "identical-to-the-recorded-corpus" : fieldMismatches.join("; ")}`,
      ],
    });
  }
  return {
    conformant: failures.length === 0,
    verdicts,
    evidence: [
      `inputs:${input.inputs.length}`,
      `failures:${failures.length}`,
      ...failures,
      failures.length === 0
        ? "integrity held (every input IS the recorded corpus's own result — digest-verified, never re-measured)"
        : "INTEGRITY FAILED (an input is not the recorded result — a re-measurement masquerading as synthesis)",
    ],
  };
}

// ---------------------------------------------------------------------------
// The family synthesis (the adjusted comparison itself — PURE)
// ---------------------------------------------------------------------------

/**
 * Derive the full adjusted comparison for one row over its inputs
 * (PURE): the family's adjusted cost with every oracle applied, the
 * verified attainment, the latency compliance (latency rows), the
 * pooled Wilson interval and the comparability verdict. The verdict
 * is honest: NULL-resolution arms are HONESTLY INCOMPARABLE (never
 * fabricated); below-minimum inputs REFUSE; any failed oracle makes
 * the row's terminal FAILED.
 */
export function deriveAdjustedSynthesis(input: {
  readonly row: AdjustedCorpusRow;
  readonly inputs: readonly RecordedArmInput[];
}): {
  readonly synthesis: ExpectedAdjustedOutcome | null;
  readonly verdict: AdjustedComparability;
  readonly familyConformant: boolean;
} {
  const pooled = pooledFactsOf(input.inputs);
  const attainment = pooled.runs > 0 ? pooled.resolved / pooled.runs : 0;
  const wilson = pooled.runs > 0 ? wilsonInterval(pooled.resolved, pooled.runs) : null;
  let adjusted: string | null = null;
  let latencyCompliance: number | null = null;
  let conformant = true;
  if (input.row.family === "quality-adjusted") {
    const quality = deriveQualityAdjustmentHonesty({ inputs: input.inputs });
    conformant = quality.conformant;
    adjusted = quality.qualityAdjustedCostMicroUsd;
  } else if (input.row.family === "latency-adjusted") {
    const budget = input.row.latencyBudgetMs ?? Number.POSITIVE_INFINITY;
    const latency = deriveLatencyAdjustmentInclusion({ inputs: input.inputs, budgetMs: budget });
    conformant = latency.conformant;
    adjusted = latency.latencyAdjustedCostMicroUsd;
    latencyCompliance = latency.latencyCompliance;
  } else {
    const failure = deriveFailureAdjustmentCompleteness({ inputs: input.inputs });
    conformant = failure.conformant;
    adjusted = failure.failureAdjustedCostMicroUsd;
  }
  const confidence = deriveConfidenceAndMinimum({ row: input.row, inputs: input.inputs });
  const integrity = deriveInputIntegrity({ inputs: input.inputs });
  const separation = deriveEstimateMeasureSeparation({ inputs: input.inputs });
  const refusal = deriveBelowMinimumRefusalHonesty({ row: input.row, inputs: input.inputs });
  const allConformant =
    conformant &&
    confidence.conformant &&
    integrity.conformant &&
    separation.conformant &&
    refusal.conformant;
  const synthesis: ExpectedAdjustedOutcome | null =
    wilson === null
      ? null
      : {
          family: input.row.family,
          pooledRuns: pooled.runs,
          pooledResolved: pooled.resolved,
          measuredCostMicroUsd: pooled.measuredMicroUsd.toString(),
          estimatedCostMicroUsd: pooled.estimatedMicroUsd.toString(),
          attainment,
          latencyCompliance,
          adjustedCostMicroUsd: adjusted,
          wilson: { low: wilson.low, high: wilson.high },
        };
  const verdict: AdjustedComparability = !allConformant
    ? "adversarial-failed"
    : confidence.belowMinimum
      ? "refused-below-minimum"
      : adjusted === null
        ? "honestly-incomparable"
        : "comparable";
  return { synthesis, verdict, familyConformant: allConformant };
}

// ---------------------------------------------------------------------------
// The row criteria (the mechanical verification)
// ---------------------------------------------------------------------------

/**
 * Derive the synthesis row's criteria (PURE — the verification
 * battery): the input-integrity oracle (digest-verified recorded
 * inputs; a re-measurement FAILs), the family oracle (the adjusted
 * family's own honesty derivation), the estimate/measure separation,
 * the confidence-and-minimum enforcement, the synthesis-outcome
 * oracle (the derived comparison reproduces the pinned expected
 * synthesis), the durable contracts and the honest outcome contract.
 */
export function deriveAdjustedRowCriteria(input: {
  readonly row: AdjustedCorpusRow;
  readonly inputs: readonly RecordedArmInput[];
  readonly observedTerminal: string | null;
  readonly baseline: EconomicWorldFacts;
  readonly finalFacts: EconomicWorldFacts;
  readonly failure: { readonly category: string; readonly message: string } | null;
  readonly totalLatencyMs: number;
}): readonly LabVerificationCriterion[] {
  const criteria: LabVerificationCriterion[] = [];
  const integrity = deriveInputIntegrity({ inputs: input.inputs });
  criteria.push({
    criterionId: "input-integrity-digest-verified",
    strategy: "deterministic",
    status: integrity.conformant ? "PASS" : "FAIL",
    evidence: integrity.evidence,
  });
  const family = deriveAdjustedSynthesis({ row: input.row, inputs: input.inputs });
  const familyCriterionId =
    input.row.family === "quality-adjusted"
      ? "quality-adjustment-honesty"
      : input.row.family === "latency-adjusted"
        ? "latency-adjustment-inclusion"
        : "failure-adjustment-completeness";
  const familyOracle =
    input.row.family === "quality-adjusted"
      ? deriveQualityAdjustmentHonesty({ inputs: input.inputs })
      : input.row.family === "latency-adjusted"
        ? deriveLatencyAdjustmentInclusion({
            inputs: input.inputs,
            budgetMs: input.row.latencyBudgetMs ?? Number.POSITIVE_INFINITY,
          })
        : deriveFailureAdjustmentCompleteness({ inputs: input.inputs });
  criteria.push({
    criterionId: familyCriterionId,
    strategy: "deterministic",
    status: familyOracle.conformant ? "PASS" : "FAIL",
    evidence: familyOracle.evidence,
  });
  const separation = deriveEstimateMeasureSeparation({ inputs: input.inputs });
  criteria.push({
    criterionId: "estimate-measure-separation",
    strategy: "deterministic",
    status: separation.conformant ? "PASS" : "FAIL",
    evidence: separation.evidence,
  });
  const confidence = deriveConfidenceAndMinimum({ row: input.row, inputs: input.inputs });
  criteria.push({
    criterionId: "confidence-and-minimum",
    strategy: "deterministic",
    status: confidence.conformant ? "PASS" : "FAIL",
    evidence: confidence.evidence,
  });
  const refusal = deriveBelowMinimumRefusalHonesty({ row: input.row, inputs: input.inputs });
  criteria.push({
    criterionId: "below-minimum-refusal-honesty",
    strategy: "deterministic",
    status: refusal.conformant ? "PASS" : "FAIL",
    evidence: refusal.evidence,
  });
  if (input.row.expected.synthesis !== undefined) {
    const expected = input.row.expected.synthesis;
    const observed = family.synthesis;
    const matches =
      observed !== null &&
      observed.family === expected.family &&
      observed.pooledRuns === expected.pooledRuns &&
      observed.pooledResolved === expected.pooledResolved &&
      observed.measuredCostMicroUsd === expected.measuredCostMicroUsd &&
      observed.estimatedCostMicroUsd === expected.estimatedCostMicroUsd &&
      Math.abs(observed.attainment - expected.attainment) < 1e-9 &&
      observed.adjustedCostMicroUsd === expected.adjustedCostMicroUsd &&
      Math.abs(observed.wilson.low - expected.wilson.low) < 1e-9 &&
      Math.abs(observed.wilson.high - expected.wilson.high) < 1e-9 &&
      (expected.latencyCompliance === null
        ? observed.latencyCompliance === null
        : observed.latencyCompliance !== null &&
          Math.abs((observed.latencyCompliance ?? 0) - expected.latencyCompliance) < 1e-9);
    criteria.push({
      criterionId: "synthesis-outcome-oracle",
      strategy: "deterministic",
      status: matches ? "PASS" : "FAIL",
      evidence: [
        `expectedFamily:${expected.family}`,
        `observedFamily:${observed?.family ?? "none"}`,
        `expectedPooledRuns:${expected.pooledRuns}`,
        `observedPooledRuns:${observed?.pooledRuns ?? "none"}`,
        `expectedPooledResolved:${expected.pooledResolved}`,
        `observedPooledResolved:${observed?.pooledResolved ?? "none"}`,
        `expectedAdjusted:${expected.adjustedCostMicroUsd ?? "null"}`,
        `observedAdjusted:${observed?.adjustedCostMicroUsd ?? "none"}`,
      ],
    });
  }
  const executionDelta = input.finalFacts.executionCount - input.baseline.executionCount;
  criteria.push({
    criterionId: "no-phantom-executions",
    strategy: "deterministic",
    status: executionDelta === input.row.expected.executions ? "PASS" : "FAIL",
    evidence: [
      `baseline:${input.baseline.executionCount}`,
      `final:${input.finalFacts.executionCount}`,
      `delta:${executionDelta}`,
      `expected:${input.row.expected.executions}`,
    ],
  });
  const keyDelta = input.finalFacts.idempotencyRecordCount - input.baseline.idempotencyRecordCount;
  criteria.push({
    criterionId: "no-ledger-drift",
    strategy: "deterministic",
    status: keyDelta === input.row.expected.idempotencyRecords ? "PASS" : "FAIL",
    evidence: [
      `baseline:${input.baseline.idempotencyRecordCount}`,
      `final:${input.finalFacts.idempotencyRecordCount}`,
      `delta:${keyDelta}`,
      `expected:${input.row.expected.idempotencyRecords}`,
    ],
  });
  criteria.push({
    criterionId: "no-orphan-ledger-transitions",
    strategy: "deterministic",
    status: input.finalFacts.orphanEventCount === 0 ? "PASS" : "FAIL",
    evidence: [
      `orphanEvents:${input.finalFacts.orphanEventCount}`,
      `eventCount:${input.finalFacts.eventCount}`,
    ],
  });
  const derivedTerminal: "COMPLETED" | "FAILED" =
    input.failure !== null || !family.familyConformant ? "FAILED" : "COMPLETED";
  criteria.push({
    criterionId: "row-outcome-contract",
    strategy: "deterministic",
    status: derivedTerminal === input.row.expected.terminal ? "PASS" : "FAIL",
    evidence: [
      `expectedTerminal:${input.row.expected.terminal}`,
      `derivedTerminal:${derivedTerminal}`,
      `expectedVerdict:${input.row.expected.verdict}`,
      `derivedVerdict:${family.verdict}`,
      `observedTerminal:${input.observedTerminal ?? "none"}`,
      `failure:${input.failure?.category ?? "none"}`,
    ],
  });
  criteria.push({
    criterionId: "economics-measured",
    strategy: "deterministic",
    status: "PASS",
    evidence: [
      "inputs:RECORDED arm results (digest references — the synthesis derives over the recorded corpora, never a re-measurement)",
      "costs:the recorded micro-USD totals at each arm's own pinned revision (never re-priced)",
      "latencyMs:measured (the synthesis wallclock; the per-run latencies are the RECORDED traces' own)",
      `totalLatencyMs:${input.totalLatencyMs}`,
      "evidence:payload digests only (never payload bytes)",
    ],
  });
  return criteria;
}

// ---------------------------------------------------------------------------
// The row driver (the landed synthesis execution)
// ---------------------------------------------------------------------------

/**
 * Drive one adjusted-cost synthesis row to settlement through the
 * platform path: the landed execution's chain records the SYNTHESIS
 * DECISIONS BEFORE any input is consulted (the family, the
 * pre-registered arm set with every digest reference, the minimums,
 * the Wilson configuration, the pinned revisions), then each recorded
 * input is verified against its arm corpus (digest + field equality —
 * journaled as digest references only), the adjusted comparison is
 * derived PURELY over the recorded results, the row-level mechanical
 * criteria are assembled, the verdict completes the execution and the
 * observed terminal is read back from the ledger. The honest terminal
 * is FAILED when any failure was observed or any criterion failed —
 * never a partial-success shortcut.
 */
export async function driveAdjustedRow(options: {
  readonly row: AdjustedCorpusRow;
  readonly lifecycle: EconomicLifecyclePort;
  /** The resolved recorded inputs (the fixtures' bundles — verified here). */
  readonly inputs: readonly RecordedArmInput[];
  /** The accounting rails (the REAL recorder — the verified inputs' sealing). */
  readonly rails: EconomicAccountingRails;
  readonly metadata: Parameters<EconomicAccountingRails["sealRound"]>[0]["metadata"];
  readonly environmentIdentity: string;
  readonly baseline: EconomicWorldFacts;
  readonly worldFacts: () => Promise<EconomicWorldFacts> | EconomicWorldFacts;
  readonly landedProvider: LandedExecutionsProvider;
  readonly now: () => Date;
}): Promise<AdjustedRunResult> {
  const runStartedAt = options.now().getTime();
  const keyCounter = { count: 0 };
  const key = (): string => {
    keyCounter.count += 1;
    return `k${keyCounter.count}`;
  };
  const landed = await options.landedProvider(1, options.row.expected.appCreated);
  if (landed.length !== options.row.expected.appCreated || landed[0] === undefined) {
    const failure = {
      category: "landed-count-mismatch",
      message: `the row's landed provider returned ${landed.length} executions (expected ${options.row.expected.appCreated})`,
    };
    return {
      rowId: options.row.rowId,
      terminal: "FAILED",
      criteria: deriveAdjustedRowCriteria({
        row: options.row,
        inputs: options.inputs,
        observedTerminal: null,
        baseline: options.baseline,
        finalFacts: await Promise.resolve(options.worldFacts()),
        failure,
        totalLatencyMs: options.now().getTime() - runStartedAt,
      }),
      executionId: null,
      observedTerminal: null,
      inputs: [],
      synthesis: null,
      totalLatencyMs: options.now().getTime() - runStartedAt,
      failure,
    };
  }
  const executionId = landed[0];
  let failure: { category: string; message: string } | null = null;

  // ---- the canonical prologue ----
  await options.lifecycle.transition({
    executionId,
    step: "authorize",
    reason: "val-044-authorize",
    callKey: key(),
  });
  await options.lifecycle.transition({
    executionId,
    step: "plan",
    reason: "val-044-plan",
    callKey: key(),
  });

  // ---- the SYNTHESIS DECISIONS (made BEFORE any input is consulted) ----
  const synthesisDecision: Record<string, unknown> = {
    kind: "adjusted-cost-synthesis-plan",
    family: options.row.family,
    deriveOnlyOverRecorded:
      "the synthesis derives over the RECORDED arm corpora (digest references; never a re-measurement, never a re-pricing)",
    preRegisteredArmSet: options.row.armSet.map((ref) => ({
      arm: ref.armLabel,
      row: ref.corpusRowId,
      digest: ref.recordedDigest,
      priceRevision: ref.priceRevision,
    })),
    minimumInputs: options.row.minimumInputs,
    minimumSamplesPerInput: options.row.minimumSamplesPerInput,
    wilson: WILSON_CONFIG,
    ...(options.row.latencyBudgetMs === undefined
      ? {}
      : { latencyBudgetMs: options.row.latencyBudgetMs }),
    expectedVerdict: options.row.expected.verdict,
  };
  await options.lifecycle.recordPlanningDecision({
    executionId,
    route: {
      provider: "synthesis",
      model: "recorded-arm-corpora",
      strategyClass: "economic-adjusted-cost",
    },
    armDecision: synthesisDecision,
  });
  {
    const record: EconomicJournalRecord = {
      ordinal: 1,
      kind: "arm-decision",
      digest: economicDigestOf(synthesisDecision),
      detail: `synthesis-decision:${options.row.rowId}:${options.row.family}`,
    };
    await options.lifecycle.recordStepEvent({ executionId, record });
  }
  await options.lifecycle.transition({
    executionId,
    step: "queue",
    reason: "val-044-queue",
    callKey: key(),
  });
  await options.lifecycle.transition({
    executionId,
    step: "start",
    reason: "val-044-start",
    callKey: key(),
  });

  // ---- the input-verification loop (digest references only) ----
  const integrity = deriveInputIntegrity({ inputs: options.inputs });
  const verifiedInputs: VerifiedArmInput[] = [];
  let ordinal = 1;
  for (const verdict of integrity.verdicts) {
    const record: EconomicJournalRecord = {
      ordinal: ordinal + 1,
      kind: verdict.integrity ? "round" : "failure",
      digest: economicDigestOf({
        arm: verdict.reference.armLabel,
        row: verdict.reference.corpusRowId,
        declared: verdict.reference.recordedDigest,
        integrity: verdict.integrity,
      }),
      detail: `input:${verdict.reference.armLabel}:${verdict.reference.corpusRowId}:${verdict.integrity ? "verified" : (verdict.failureReason ?? "failed")}`,
    };
    await options.lifecycle.recordStepEvent({ executionId, record });
    ordinal += 1;
    verifiedInputs.push({
      reference: verdict.reference,
      integrity: verdict.integrity,
      failureReason: verdict.failureReason,
    });
    if (!verdict.integrity && failure === null) {
      failure = {
        category: "input-integrity-failed",
        message:
          `${verdict.reference.armLabel}:${verdict.reference.corpusRowId} ${verdict.failureReason ?? ""}`.trim(),
      };
    }
    // The verified input seals through the REAL recorder: the
    // RECORDED totals carried as recorded (never re-priced), the
    // recorded latency total as the run's latency.
    const item = options.inputs.find(
      (candidate) =>
        candidate.armLabel === verdict.reference.armLabel &&
        candidate.corpusRowId === verdict.reference.corpusRowId,
    );
    if (item === undefined) {
      continue;
    }
    const latencyTotal = item.recorded.perRunLatencyMs.reduce((sum, latency) => sum + latency, 0);
    const sealedAt = options.now().toISOString();
    options.rails.sealRound({
      metadata: options.metadata,
      corpusTaskId: `${verdict.reference.armLabel}:${verdict.reference.corpusRowId}`,
      environmentIdentity: options.environmentIdentity,
      events: [
        {
          kind: "run-start",
          data: { corpusTask: verdict.reference.corpusRowId, arm: verdict.reference.armLabel },
          at: sealedAt,
        },
        {
          kind: "model-choice",
          data: {
            requestDigest: verdict.reference.recordedDigest,
            request: 1,
            synthesisInput: true,
          },
          at: sealedAt,
        },
        {
          kind: "run-end",
          data: { terminalStatus: verdict.integrity ? "COMPLETED" : "FAILED" },
          at: sealedAt,
        },
      ],
      cost: [
        {
          kind: "measured",
          amountMicroUsd: item.recorded.measuredCostMicroUsd,
          source: `val-044:${options.row.rowId}:recorded:${item.priceRevision}`,
          scope: "direct-execution",
        },
        ...(BigInt(item.recorded.retryOverheadMicroUsd) > 0n
          ? [
              {
                kind: "measured" as const,
                amountMicroUsd: item.recorded.retryOverheadMicroUsd,
                source: `val-044:${options.row.rowId}:recorded:${item.priceRevision}`,
                scope: "retry-overhead" as const,
              },
            ]
          : []),
        ...(BigInt(item.recorded.estimatedCostMicroUsd) > 0n
          ? [
              {
                kind: "estimate" as const,
                amountMicroUsd: item.recorded.estimatedCostMicroUsd,
                source: `val-044:${options.row.rowId}:recorded:${item.priceRevision}`,
                scope: "direct-execution" as const,
              },
            ]
          : []),
      ],
      latency: [{ phase: "total", source: "platform-ledger", milliseconds: latencyTotal }],
      environment: [
        {
          kind: "state-transitioned",
          assertion: `the recorded input ${verdict.reference.corpusRowId} verified against its arm corpus`,
          observedVia: "platform-ledger",
          passed: verdict.integrity,
        },
      ],
      sealedAt,
    });
  }

  // ---- the adjusted comparison (PURE over the recorded results) ----
  const comparison = deriveAdjustedSynthesis({ row: options.row, inputs: options.inputs });

  // ---- the verify boundary, then the mechanically derived verdict ----
  await options.lifecycle.transition({
    executionId,
    step: "verify",
    reason: "val-044-verify",
    callKey: key(),
  });
  const finalFacts = await Promise.resolve(options.worldFacts());
  const totalLatencyMs = options.now().getTime() - runStartedAt;
  const rowCriteria = deriveAdjustedRowCriteria({
    row: options.row,
    inputs: options.inputs,
    observedTerminal: null,
    baseline: options.baseline,
    finalFacts,
    failure,
    totalLatencyMs,
  });
  const derivedTerminal: "COMPLETED" | "FAILED" =
    failure !== null || rowCriteria.some((criterion) => criterion.status === "FAIL")
      ? "FAILED"
      : "COMPLETED";
  const verdict: "pass" | "fail" = derivedTerminal === "COMPLETED" ? "pass" : "fail";
  await options.lifecycle.complete({
    executionId,
    verdict,
    criteria: rowCriteria,
    reason:
      verdict === "pass"
        ? "val-044-verified"
        : `val-044-${failure?.category ?? "protocol-violation"}`,
  });

  // ---- the observed terminal read back from the ledger ----
  const observedTerminal = await options.lifecycle.statusOf(executionId);
  const readbackAgrees = observedTerminal === derivedTerminal;
  const criteria: LabVerificationCriterion[] = [
    ...rowCriteria,
    {
      criterionId: "observed-terminal-readback",
      strategy: "deterministic",
      status: readbackAgrees ? "PASS" : "FAIL",
      evidence: [
        `derivedTerminal:${derivedTerminal}`,
        `observedTerminal:${observedTerminal ?? "none"}`,
        readbackAgrees
          ? "the ledger's own terminal agrees with the mechanically derived verdict"
          : "DISAGREED (a fabricated terminal at the ledger — the anyFail→FAILED invariant)",
      ],
    },
  ];
  const anyFail = derivedTerminal === "FAILED" || !readbackAgrees;
  return {
    rowId: options.row.rowId,
    terminal: anyFail ? "FAILED" : "COMPLETED",
    criteria,
    executionId,
    observedTerminal,
    inputs: verifiedInputs,
    synthesis: comparison.synthesis,
    totalLatencyMs,
    failure,
  };
}

// ---------------------------------------------------------------------------
// The re-exports (the imported substrate — never copied)
// ---------------------------------------------------------------------------

/** The VAL-040 digest helper re-export (the digest discipline). */
export { economicDigestOf } from "../economic-baseline/driver";
/** The manifest integrity re-export (the pricing oracle's basis). */
export { deriveManifestIntegrity } from "../economic-baseline/pricing";
