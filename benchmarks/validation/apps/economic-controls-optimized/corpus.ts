/**
 * The economic-controls-optimized corpus (VAL-042, AC1): the declared
 * rows of the STRONG OPTIMIZED NON-ZECK baseline experiment. Per row:
 * the ARM MANIFEST ENTRY (the arm kind, the pinned price revision, the
 * pre-registered corpus slice, the statistical minimums, the pinned
 * threshold or budget), the DECLARED OPTIMIZATION INVENTORY revision
 * (content-addressed alongside the price manifests), the FROZEN
 * PORTFOLIO reference (VAL-030 baseline revisions, by content digest —
 * never copied) and the EXPECTED NORMALIZED OUTCOME the protocol
 * derivation must reproduce (the run/resolved counts and the canonical
 * micro-USD economics derived through the REAL accounting derivations
 * over the recorded rounds + the pinned manifest + the simulated
 * optimized stack).
 *
 * The offline rows are deterministically reproducible (the recorded
 * VAL-006-style accounting replays + the deterministic cache
 * simulation — zero credentials, zero network); the live rows are
 * env-gated on the operator-authorized OpenRouter rail and demand
 * REAL optimized dispatches through the REAL platform path.
 *
 * Rows never embed list prices: the arms declare WHICH pinned revision
 * priced their runs; pricing resolves through the manifest registry
 * only.
 */

import { wilsonInterval } from "../../accounting/aggregate";
import { isResolvedOutcome, thresholdsFor } from "../../accounting/thresholds";
import type { GoldenTask } from "../../corpus/schema";
import type { ObservedOutcome } from "../../evaluation/deterministic";
import { evaluateRun } from "../../evaluation/evaluate";
import type { UsageFact } from "../economic-baseline/normalization";
import {
  deriveCostPerResolved,
  manifestFor,
  normalizeArmCosts,
} from "../economic-baseline/normalization";
import { resolveListPrice } from "../economic-baseline/pricing";
import type { EconomicArm, FixedCostArm, FixedQualityArm } from "../economic-baseline/protocol";
import { OFFLINE_CORPUS_ROWS as FROZEN_PORTFOLIO_ROWS } from "../longitudinal-baseline/corpus";
import {
  deriveOptimizedRoundBudgetBoundMicroUsd,
  type ExpectedNormalizedOutcome,
  type OptimizedCorpusRow,
  type OptimizedRecordedRound,
} from "./driver";
import { inventoryFor, routeForClass } from "./optimizations";

/** The task kind every row's submission carries (the app's task vocabulary). */
export const OPTIMIZED_TASK_KIND = "economic-controls-optimized.experiment.v1";

/** The corpus version the evaluations carry. */
export const OPTIMIZED_CORPUS_VERSION = "val-042-optimized-baseline-v1";

/** The live rail's pinned model (the manifest's openrouter entry — priced as declared). */
export const LIVE_RAIL_MODEL = "meta-llama/llama-3.3-70b-instruct";

// ---------------------------------------------------------------------------
// The golden tasks of the arms' pre-registered slices
// ---------------------------------------------------------------------------

/**
 * The golden tasks of one arm's pre-registered slice (deterministic
 * derivation from the slice identities): compact confirmation tasks
 * whose deterministic oracles (terminal COMPLETED + the response
 * containing "confirm") are exactly what the recorded replays, the
 * cached responses and the live confirmation rounds settle.
 */
export function optimizedTasksForArm(arm: EconomicArm): readonly GoldenTask[] {
  const scenarioId = arm.corpusSlice[0]?.split("#")[0] ?? `val-042-opt-${arm.armId}`;
  return arm.corpusSlice.map((taskId) => {
    const index = Number.parseInt(taskId.split("#")[1] ?? "0", 10);
    return {
      taskId,
      family: "text" as const,
      scenarioId,
      description: `Optimized-baseline experiment round ${index}: confirm the settlement round of the ${arm.armId} arm so the round's quality verdict and measured usage feed the normalized cost-per-resolved accounting.`,
      input: {
        instruction: `Confirm settlement round ${index} of the optimized baseline experiment.`,
        arm: arm.armId,
        round: index,
      },
      environmentState: {
        fixtures: [],
        description:
          "the economics lab's controlled optimized-round world (no environment fixtures)",
      },
      expectedOutcome: {
        terminalStatus: "COMPLETED" as const,
        containsText: ["confirm"],
      },
      forbiddenOutcomes: ["an empty response", "a refusal to confirm", "an unconfirmed settlement"],
      qualityRubric: [
        {
          name: "confirmation",
          weight: 1,
          measurement: "the response confirms the settlement round",
        },
      ],
      safetyConstraints: [
        {
          kind: "authority-boundary" as const,
          constraint:
            "the round must not exceed the arm's pinned economics (budget or slice) nor the declared optimization bounds",
        },
      ],
      evaluation: {
        method: "deterministic" as const,
        detail: "the terminal-status and contains-text oracles decide the round's verdict",
      },
      determinism: "deterministic" as const,
      provenance: {
        source: "synthetic-authored" as const,
        license: "repository-license" as const,
        authoredFor: "zeck-validation" as const,
        external: false as const,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// The frozen-portfolio references (VAL-030 baseline revisions, by digest)
// ---------------------------------------------------------------------------

/**
 * The frozen-portfolio reference for one app: the manifest entry of
 * the VAL-030 corpus row whose frozen app artifact matches — the
 * content digests of the frozen baseline (never the artifacts copied).
 */
function frozenPortfolioOf(appId: string): OptimizedCorpusRow["frozenPortfolio"] {
  const frozen = FROZEN_PORTFOLIO_ROWS.find((row) => row.appArtifact.appId === appId);
  if (frozen === undefined) {
    throw new Error(`the frozen portfolio declares no app artifact for ${appId}`);
  }
  return {
    appId: frozen.manifest.appId,
    appDigest: frozen.manifest.appDigest,
    workloadId: frozen.manifest.workloadId,
    workloadRevision: frozen.manifest.workloadRevision,
    workloadDigest: frozen.manifest.workloadDigest,
    manifestDigest: frozen.manifest.manifestDigest,
  };
}

// ---------------------------------------------------------------------------
// The expected-normalized-outcome derivation (the oracle)
// ---------------------------------------------------------------------------

/**
 * The rail's declared currency for one provider/model (the manifest's
 * own denomination).
 */
function railCurrencyOf(
  manifest: ReturnType<typeof manifestFor>,
  provider: string,
  model: string,
): "USD" | "EUR" | "JPY" | "GBP" {
  const entry = resolveListPrice(manifest, provider, model, "input");
  if (entry === null) {
    throw new Error(`no pinned list-price entry for ${provider}/${model}`);
  }
  return entry.currency;
}

/** The observed outcome of one recorded round's final attempt (PURE). */
function observedOfRecordedRound(round: OptimizedRecordedRound): ObservedOutcome {
  const recorded = round.recorded;
  const final = recorded?.attempts[recorded.attempts.length - 1];
  if (final !== undefined && final.outcome === "success") {
    return {
      terminalStatus: "COMPLETED",
      verificationStatuses: ["PASS"],
      responseText: recorded?.responseText ?? "",
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

/** The observed outcome of one cache-served round (the cached response replays). */
function observedOfCacheHit(responseText: string): ObservedOutcome {
  return {
    terminalStatus: "COMPLETED",
    verificationStatuses: ["PASS"],
    responseText,
    outputShapeFields: [],
    environmentEffects: [],
    retryableErrorsSurfaced: 0,
  };
}

/**
 * The usage facts of one recorded round's fresh dispatch (the
 * expected-outcome derivation's input — routed through the inventory's
 * routing table, priced per fact through the pinned manifest).
 */
function usageFactsOfRecordedRound(
  row: OptimizedCorpusRow,
  round: OptimizedRecordedRound,
): readonly UsageFact[] {
  const manifest = manifestFor(row.arm.priceRevision);
  const inventory = inventoryFor(row.optimizationInventoryRevision);
  const route = routeForClass(inventory, round.taskClass);
  const currency = railCurrencyOf(manifest, route.provider, route.model);
  const facts: UsageFact[] = [];
  const recorded = round.recorded;
  if (recorded === undefined) {
    return facts;
  }
  for (const [index, attempt] of recorded.attempts.entries()) {
    const isFinal = index === recorded.attempts.length - 1;
    if (attempt.usage === undefined) {
      continue;
    }
    facts.push({
      provider: route.provider,
      model: route.model,
      tier: "input",
      currency,
      tokens: attempt.usage.inputTokens,
      kind: "measured",
      scope: isFinal ? "direct-execution" : "retry-overhead",
    });
    facts.push({
      provider: route.provider,
      model: route.model,
      tier: "output",
      currency,
      tokens: attempt.usage.outputTokens,
      kind: "measured",
      scope: isFinal ? "direct-execution" : "retry-overhead",
    });
  }
  if (recorded.estimateQuote !== undefined) {
    facts.push({
      provider: route.provider,
      model: route.model,
      tier: "input",
      currency,
      tokens: recorded.estimateQuote.inputTokens,
      kind: "estimate",
      scope: "direct-execution",
    });
    facts.push({
      provider: route.provider,
      model: route.model,
      tier: "output",
      currency,
      tokens: recorded.estimateQuote.outputTokens,
      kind: "estimate",
      scope: "direct-execution",
    });
  }
  return facts;
}

/**
 * Derive the expected normalized outcome of one row's optimized
 * replay (PURE — the REAL derivations over the declared fixtures +
 * the pinned manifest + the deterministic cache simulation): the
 * cache replays exactly the driver's own component (cacheable rounds
 * with a stored (class, content) identity are served from the cache
 * — zero new measured usage; fresh-only rounds and rounds whose
 * original failed always dispatch fresh), the fixed-cost budget gate
 * stops the arm at the declared prefix (BEFORE each fresh dispatch —
 * cache hits consume no budget), the run/resolved counts, the
 * measured and estimated micro-USD totals, the canonical
 * cost-per-resolved (NULL when nothing resolves) and the Wilson 95%
 * interval — exactly what the protocol derivation must reproduce at
 * run time.
 */
export function expectedOptimizedOutcomeOf(row: OptimizedCorpusRow): ExpectedNormalizedOutcome {
  const manifest = manifestFor(row.arm.priceRevision);
  const inventory = inventoryFor(row.optimizationInventoryRevision);
  const tasks = optimizedTasksForArm(row.arm);
  const usageFacts: UsageFact[] = [];
  const stored = new Map<string, string>();
  let resolved = 0;
  let executed = 0;
  let measuredSoFar = 0n;
  // The fixed-cost arm's BEFORE-dispatch budget bound (the worst case
  // over every routed rail — the same conservative derivation the
  // driver records in its durable planning decision).
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
    .filter((plan): plan is OptimizedRecordedRound => plan !== undefined);
  for (const plan of rounds) {
    const key = `${plan.taskClass}:${plan.contentDigest}`;
    const cached = stored.get(key);
    let observed: ObservedOutcome;
    if (plan.cachePolicy === "cacheable" && cached !== undefined) {
      observed = observedOfCacheHit(cached);
    } else {
      // The fixed-cost budget gate — BEFORE the fresh dispatch (the
      // declared prefix stop; cache hits never reach this gate).
      if (roundBoundMicroUsd !== null && budgetMicroUsd !== null) {
        if (budgetMicroUsd - measuredSoFar < roundBoundMicroUsd) {
          break;
        }
      }
      observed = observedOfRecordedRound(plan);
      const roundFacts = usageFactsOfRecordedRound(row, plan);
      usageFacts.push(...roundFacts);
      measuredSoFar += BigInt(normalizeArmCosts(roundFacts, manifest).measuredMicroUsd);
      const recorded = plan.recorded;
      const final = recorded?.attempts[recorded.attempts.length - 1];
      if (
        plan.cachePolicy === "cacheable" &&
        final !== undefined &&
        final.outcome === "success" &&
        recorded?.responseText !== undefined
      ) {
        stored.set(key, recorded.responseText);
      }
    }
    executed += 1;
    const task = tasks.find((candidate) => candidate.taskId === plan.taskId);
    if (task === undefined) {
      continue;
    }
    const evaluation = evaluateRun({
      task,
      corpusVersion: OPTIMIZED_CORPUS_VERSION,
      observed,
    });
    const recorded = plan.recorded;
    const latencyMs =
      cached !== undefined && plan.cachePolicy === "cacheable"
        ? 3
        : (recorded?.attempts.reduce((sum, attempt) => sum + attempt.latencyMs, 0) ?? 0);
    const facts = {
      evaluationVerdict: evaluation.verdict,
      totalLatencyMs: latencyMs,
      retryableErrorsSurfaced: 0,
      failedSafetyObservations: 0,
    };
    if (isResolvedOutcome(thresholdsFor(task), facts)) {
      resolved += 1;
    }
  }
  const basis = normalizeArmCosts(usageFacts, manifest);
  const perResolved = deriveCostPerResolved({
    measuredMicroUsd: basis.measuredMicroUsd,
    estimatedMicroUsd: basis.estimatedMicroUsd,
    resolvedCount: resolved,
  });
  const confidence = wilsonInterval(resolved, executed);
  return {
    runCount: executed,
    resolvedCount: resolved,
    measuredCostMicroUsd: basis.measuredMicroUsd,
    estimatedCostMicroUsd: basis.estimatedMicroUsd,
    costPerResolvedMicroUsd: perResolved.costPerResolvedMicroUsd,
    resolutionConfidence: { low: confidence.low, high: confidence.high },
  };
}

// ---------------------------------------------------------------------------
// The arms (the manifest entries the rows declare)
// ---------------------------------------------------------------------------

/** The slice builder: <scenario>#<zero-padded index> identities in order. */
function sliceOf(scenarioId: string, size: number): readonly string[] {
  return Array.from(
    { length: size },
    (_, index) => `${scenarioId}#${String(index + 1).padStart(3, "0")}`,
  );
}

const FQ_ROUTED: FixedQualityArm = {
  armId: "fq-optimized-routing",
  kind: "fixed-quality",
  integrationSurface: "sdk",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-042-opt-routing", 8),
  minimumSamples: 8,
  pinnedThreshold: { resolutionRate: 0.75 },
};

const FQ_COMPRESSED: FixedQualityArm = {
  armId: "fq-optimized-compression",
  kind: "fixed-quality",
  integrationSurface: "sdk",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-042-opt-compress", 6),
  minimumSamples: 6,
  pinnedThreshold: { resolutionRate: 0.75 },
};

const FQ_BATCHED: FixedQualityArm = {
  armId: "fq-optimized-batch",
  kind: "fixed-quality",
  integrationSurface: "sdk",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-042-opt-batch", 6),
  minimumSamples: 6,
  pinnedThreshold: { resolutionRate: 0.75 },
};

const FC_STRETCH: FixedCostArm = {
  armId: "fc-optimized-stretch",
  kind: "fixed-cost",
  integrationSurface: "sdk",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-042-opt-stretch", 8),
  minimumSamples: 5,
  pinnedBudgetMicroUsd: "61",
  maxTokensPerRound: 64,
};

const FC_STOP: FixedCostArm = {
  armId: "fc-optimized-stop",
  kind: "fixed-cost",
  integrationSurface: "sdk",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-042-opt-stop", 8),
  minimumSamples: 3,
  pinnedBudgetMicroUsd: "70",
  maxTokensPerRound: 64,
};

const FC_ZERO: FixedCostArm = {
  armId: "fc-optimized-zero",
  kind: "fixed-cost",
  integrationSurface: "sdk",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-042-opt-zero", 6),
  minimumSamples: 6,
  pinnedBudgetMicroUsd: "200",
  maxTokensPerRound: 64,
};

const FQ_FRESH_ONLY: FixedQualityArm = {
  armId: "fq-optimized-fresh-only",
  kind: "fixed-quality",
  integrationSurface: "sdk",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-042-opt-fresh", 6),
  minimumSamples: 6,
  pinnedThreshold: { resolutionRate: 0.75 },
};

const FQ_LIVE: FixedQualityArm = {
  armId: "fq-optimized-live",
  kind: "fixed-quality",
  integrationSurface: "sdk",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-042-opt-live", 4),
  minimumSamples: 3,
  pinnedThreshold: { resolutionRate: 0.5 },
};

const FC_LIVE: FixedCostArm = {
  armId: "fc-optimized-live",
  kind: "fixed-cost",
  integrationSurface: "sdk",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-042-opt-livefc", 4),
  minimumSamples: 3,
  pinnedBudgetMicroUsd: "600",
  maxTokensPerRound: 64,
};

// ---------------------------------------------------------------------------
// The round plans (the optimized slice declarations + recorded facts)
// ---------------------------------------------------------------------------

/** One recorded successful attempt. */
function ok(usage: { inputTokens: number; outputTokens: number }, latencyMs: number) {
  return { outcome: "success" as const, usage, latencyMs };
}

/** One recorded failed attempt. */
function fail(
  category: string,
  usage: { inputTokens: number; outputTokens: number },
  latencyMs: number,
) {
  return { outcome: "failure" as const, usage, category, latencyMs };
}

/** The row-1 plans: three routed classes, one retry-amortized round, two cache hits. */
const PLANS_ROUTED: readonly OptimizedRecordedRound[] = [
  {
    taskId: FQ_ROUTED.corpusSlice[0] as string,
    taskClass: "summarize",
    contentDigest: "doc-sum-101",
    cachePolicy: "cacheable",
    recorded: {
      attempts: [ok({ inputTokens: 150, outputTokens: 35 }, 600)],
      rawInputTokens: 250,
      responseText: "confirm",
    },
  },
  {
    taskId: FQ_ROUTED.corpusSlice[1] as string,
    taskClass: "summarize",
    contentDigest: "doc-sum-102",
    cachePolicy: "cacheable",
    recorded: {
      attempts: [
        fail("rate-limit", { inputTokens: 150, outputTokens: 10 }, 300),
        ok({ inputTokens: 150, outputTokens: 35 }, 650),
      ],
      rawInputTokens: 250,
      responseText: "confirm",
    },
  },
  {
    taskId: FQ_ROUTED.corpusSlice[2] as string,
    taskClass: "extract",
    contentDigest: "doc-ext-201",
    cachePolicy: "cacheable",
    recorded: {
      attempts: [ok({ inputTokens: 120, outputTokens: 30 }, 820)],
      rawInputTokens: 200,
      responseText: "confirm",
      estimateQuote: { inputTokens: 100, outputTokens: 20 },
    },
  },
  {
    taskId: FQ_ROUTED.corpusSlice[3] as string,
    taskClass: "extract",
    contentDigest: "doc-ext-202",
    cachePolicy: "fresh-only",
    recorded: {
      attempts: [ok({ inputTokens: 120, outputTokens: 30 }, 800)],
      rawInputTokens: 200,
      responseText: "confirm",
    },
  },
  {
    taskId: FQ_ROUTED.corpusSlice[4] as string,
    taskClass: "transform-batch",
    contentDigest: "doc-bat-301",
    cachePolicy: "cacheable",
    recorded: {
      attempts: [ok({ inputTokens: 400, outputTokens: 60 }, 610)],
      rawInputTokens: 600,
      responseText: "confirm",
    },
  },
  {
    taskId: FQ_ROUTED.corpusSlice[5] as string,
    taskClass: "transform-batch",
    contentDigest: "doc-bat-302",
    cachePolicy: "cacheable",
    recorded: {
      attempts: [ok({ inputTokens: 520, outputTokens: 60 }, 640)],
      rawInputTokens: 780,
      responseText: "confirm",
    },
  },
  {
    taskId: FQ_ROUTED.corpusSlice[6] as string,
    taskClass: "summarize",
    contentDigest: "doc-sum-101",
    cachePolicy: "cacheable",
  },
  {
    taskId: FQ_ROUTED.corpusSlice[7] as string,
    taskClass: "extract",
    contentDigest: "doc-ext-201",
    cachePolicy: "cacheable",
  },
];

/** The row-2 plans: every round compressed within the tightened rev-002 bound. */
const PLANS_COMPRESSED: readonly OptimizedRecordedRound[] = FQ_COMPRESSED.corpusSlice.map(
  (taskId, index) => ({
    taskId,
    taskClass: "extract",
    contentDigest: `doc-compress-2${String(index + 1).padStart(2, "0")}`,
    cachePolicy: "cacheable",
    recorded: {
      attempts: [ok({ inputTokens: 120, outputTokens: 30 }, 800)],
      rawInputTokens: 200,
      responseText: "confirm",
      ...(index === 0 ? { estimateQuote: { inputTokens: 100, outputTokens: 20 } } : {}),
    },
  }),
);

/** The row-3 plans: the batched rail's uneven ceil-to-batch counts. */
const PLANS_BATCHED: readonly OptimizedRecordedRound[] = FQ_BATCHED.corpusSlice.map(
  (taskId, index) => ({
    taskId,
    taskClass: "transform-batch",
    contentDigest: `doc-batch-3${String(index + 1).padStart(2, "0")}`,
    cachePolicy: "cacheable",
    recorded: {
      attempts: [
        ok(
          {
            inputTokens: [400, 450, 500, 280, 520, 490][index] ?? 400,
            outputTokens: 60,
          },
          610,
        ),
      ],
      rawInputTokens: [600, 675, 750, 420, 780, 735][index] ?? 600,
      responseText: "confirm",
    },
  }),
);

/** The row-4 plans: the cache stretches the pinned budget across the full slice. */
const PLANS_STRETCH: readonly OptimizedRecordedRound[] = [
  {
    taskId: FC_STRETCH.corpusSlice[0] as string,
    taskClass: "summarize",
    contentDigest: "doc-stretch-401",
    cachePolicy: "cacheable",
    recorded: {
      attempts: [ok({ inputTokens: 50, outputTokens: 14 }, 600)],
      rawInputTokens: 84,
      responseText: "confirm",
    },
  },
  {
    taskId: FC_STRETCH.corpusSlice[1] as string,
    taskClass: "extract",
    contentDigest: "doc-stretch-402",
    cachePolicy: "cacheable",
    recorded: {
      attempts: [ok({ inputTokens: 48, outputTokens: 12 }, 700)],
      rawInputTokens: 80,
      responseText: "confirm",
    },
  },
  {
    taskId: FC_STRETCH.corpusSlice[2] as string,
    taskClass: "summarize",
    contentDigest: "doc-stretch-403",
    cachePolicy: "fresh-only",
    recorded: {
      attempts: [fail("content-policy", { inputTokens: 50, outputTokens: 4 }, 500)],
      rawInputTokens: 84,
    },
  },
  {
    taskId: FC_STRETCH.corpusSlice[3] as string,
    taskClass: "extract",
    contentDigest: "doc-stretch-404",
    cachePolicy: "cacheable",
    recorded: {
      attempts: [ok({ inputTokens: 48, outputTokens: 12 }, 720)],
      rawInputTokens: 80,
      responseText: "confirm",
    },
  },
  {
    taskId: FC_STRETCH.corpusSlice[4] as string,
    taskClass: "summarize",
    contentDigest: "doc-stretch-401",
    cachePolicy: "cacheable",
  },
  {
    taskId: FC_STRETCH.corpusSlice[5] as string,
    taskClass: "extract",
    contentDigest: "doc-stretch-402",
    cachePolicy: "cacheable",
  },
  {
    taskId: FC_STRETCH.corpusSlice[6] as string,
    taskClass: "summarize",
    contentDigest: "doc-stretch-403",
    cachePolicy: "cacheable",
    recorded: {
      attempts: [ok({ inputTokens: 50, outputTokens: 14 }, 610)],
      rawInputTokens: 84,
      responseText: "confirm",
    },
  },
  {
    taskId: FC_STRETCH.corpusSlice[7] as string,
    taskClass: "extract",
    contentDigest: "doc-stretch-404",
    cachePolicy: "cacheable",
  },
];

/** The row-5 plans: the honest budget stop after the declared prefix. */
const PLANS_STOP: readonly OptimizedRecordedRound[] = FC_STOP.corpusSlice.map((taskId, index) => ({
  taskId,
  taskClass: "extract",
  contentDigest: `doc-stop-5${String(index + 1).padStart(2, "0")}`,
  cachePolicy: "fresh-only",
  recorded:
    index === 2
      ? {
          attempts: [fail("content-policy", { inputTokens: 120, outputTokens: 5 }, 700)],
          rawInputTokens: 200,
        }
      : {
          attempts: [ok({ inputTokens: 120, outputTokens: 30 }, 820)],
          rawInputTokens: 200,
          responseText: "confirm",
        },
}));

/** The row-6 plans: every fresh dispatch fails honestly (nothing resolves). */
const PLANS_ZERO: readonly OptimizedRecordedRound[] = FC_ZERO.corpusSlice.map((taskId) => ({
  taskId,
  taskClass: "summarize",
  contentDigest: `doc-zero-6${taskId.split("#")[1] ?? "00"}`,
  cachePolicy: "fresh-only",
  recorded: {
    attempts: [fail("content-policy", { inputTokens: 50, outputTokens: 8 }, 650)],
    rawInputTokens: 84,
  },
}));

/** The row-7 plans: the fresh-only collision pairs (the cache never serves). */
const PLANS_FRESH_ONLY: readonly OptimizedRecordedRound[] = FQ_FRESH_ONLY.corpusSlice.map(
  (taskId, index) => ({
    taskId,
    taskClass: "summarize",
    contentDigest: `doc-fresh-7${String(Math.floor(index / 2) + 1).padStart(2, "0")}`,
    cachePolicy: index % 2 === 0 ? "cacheable" : "fresh-only",
    recorded: {
      attempts: [ok({ inputTokens: 50, outputTokens: 14 }, 600)],
      rawInputTokens: 84,
      responseText: "confirm",
    },
  }),
);

/** The live row-1 plans: REAL dispatches + REAL cache hits on duplicate content. */
const PLANS_LIVE_FQ: readonly OptimizedRecordedRound[] = [
  {
    taskId: FQ_LIVE.corpusSlice[0] as string,
    taskClass: "extract",
    contentDigest: "doc-live-701",
    cachePolicy: "cacheable",
  },
  {
    taskId: FQ_LIVE.corpusSlice[1] as string,
    taskClass: "extract",
    contentDigest: "doc-live-702",
    cachePolicy: "cacheable",
  },
  {
    taskId: FQ_LIVE.corpusSlice[2] as string,
    taskClass: "extract",
    contentDigest: "doc-live-701",
    cachePolicy: "cacheable",
  },
  {
    taskId: FQ_LIVE.corpusSlice[3] as string,
    taskClass: "extract",
    contentDigest: "doc-live-702",
    cachePolicy: "fresh-only",
  },
];

/** The live row-2 plans: four REAL fresh-only dispatches under the pinned budget. */
const PLANS_LIVE_FC: readonly OptimizedRecordedRound[] = FC_LIVE.corpusSlice.map((taskId) => ({
  taskId,
  taskClass: "extract",
  contentDigest: `doc-livefc-${taskId.split("#")[1] ?? "00"}`,
  cachePolicy: "fresh-only",
}));

// ---------------------------------------------------------------------------
// The row builder (the oracle's derivation)
// ---------------------------------------------------------------------------

/**
 * Build one offline corpus row with its PINNED expected normalized
 * outcome: the REAL derivations (the deterministic cache simulation +
 * the routed usage facts + the pinned manifest + the REAL evaluation
 * and resolution thresholds + the Wilson interval) run over the
 * declared fixtures at module load — exactly what the driver's own
 * accounting must reproduce at run time.
 */
function optimizedRow(input: {
  readonly rowId: string;
  readonly description: string;
  readonly arm: EconomicArm;
  readonly optimizationInventoryRevision: string;
  readonly optimizedReplay: readonly OptimizedRecordedRound[];
  readonly frozenPortfolio: OptimizedCorpusRow["frozenPortfolio"];
}): OptimizedCorpusRow {
  const row: OptimizedCorpusRow = {
    rowId: input.rowId,
    description: input.description,
    arm: input.arm,
    optimizationInventoryRevision: input.optimizationInventoryRevision,
    optimizedReplay: input.optimizedReplay,
    frozenPortfolio: input.frozenPortfolio,
    needsDispatch: false,
    expected: {
      terminal: "COMPLETED",
      executions: 1,
      idempotencyRecords: 1,
      appCreated: 1,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
    },
  };
  return { ...row, expected: { ...row.expected, normalized: expectedOptimizedOutcomeOf(row) } };
}

// ---------------------------------------------------------------------------
// The offline rows (deterministic — always drivable, zero credentials)
// ---------------------------------------------------------------------------

/** The offline rows (deterministic — always drivable, zero credentials). */
export const OFFLINE_CORPUS_ROWS: readonly OptimizedCorpusRow[] = [
  optimizedRow({
    rowId: "fixed-quality-optimized-routing-cache-amortized",
    description:
      "The headline optimized fixed-quality row: 8 pre-registered rounds across THREE routed classes (summarize → retry-relay, extract → openrouter, transform-batch → batch-relay — every rail priced through the pinned manifest rev-001), one retry-amortized round (a rate-limited first attempt recovered by the bounded retry — the failed attempt's tokens are measured retry-overhead facts of the same run), and TWO semantically-safe cache hits (rounds 7-8 replay the cached responses of rounds 1 and 3 — zero new measured cost, honestly attributed). Threshold ≥ 0.75 over the full slice; the normalized comparison carries the measured cost-per-resolved and the Wilson 95% interval.",
    arm: FQ_ROUTED,
    optimizationInventoryRevision: "opt-rev-001",
    optimizedReplay: PLANS_ROUTED,
    frozenPortfolio: frozenPortfolioOf("portfolio:text-generation"),
  }),
  optimizedRow({
    rowId: "fixed-quality-optimized-prompt-compression",
    description:
      "The prompt-compression row over the CORRECTED inventory revision (opt-rev-002 supersedes opt-rev-001 — the maximum compressed ratio tightened from 0.75 to 0.70): 6 extract rounds, each dispatched at 120 input tokens against a 200-token raw payload (ratio 0.60 — within the tightened bound), the first round carrying a planner estimate quote reported SEPARATELY (never conflated). All rounds dispatch fresh (distinct content — no cache hits); the compression bound is verified mechanically per round.",
    arm: FQ_COMPRESSED,
    optimizationInventoryRevision: "opt-rev-002",
    optimizedReplay: PLANS_COMPRESSED,
    frozenPortfolio: frozenPortfolioOf("portfolio:rag"),
  }),
  optimizedRow({
    rowId: "fixed-quality-optimized-batch-throughput",
    description:
      "The batched-throughput row: 6 transform-batch rounds coalesced onto the batched rail (batch-relay, USD per-1M, batched @500 — the provider-side optimization feature priced through the manifest's own batched entries), with UNEVEN token counts (400/450/500/280/520/490 input tokens) exercising the ceil-to-batch metering (520 → 1000 charged) exactly.",
    arm: FQ_BATCHED,
    optimizationInventoryRevision: "opt-rev-001",
    optimizedReplay: PLANS_BATCHED,
    frozenPortfolio: frozenPortfolioOf("portfolio:operations"),
  }),
  optimizedRow({
    rowId: "fixed-cost-optimized-cache-budget-stretch",
    description:
      "The budget-stretch row: the arm pins a 61 µ$ budget (64-token completion budget per round; the per-round bound 25 µ$ is the worst case over EVERY routed rail, priced from the pinned manifest BEFORE dispatch) and runs 8 pre-registered rounds — 5 fresh dispatches (one failing honestly, content policy) + 3 semantically-safe cache hits. The cache stretches the budget honestly: WITHOUT the cache the arm would stop after 6 rounds; WITH the declared response-cache optimization the FULL slice completes within the same pinned budget (measured 42 µ$ ≤ 61 µ$) — the quality-attained rises at the same budget, never a post-hoc exclusion.",
    arm: FC_STRETCH,
    optimizationInventoryRevision: "opt-rev-001",
    optimizedReplay: PLANS_STRETCH,
    frozenPortfolio: frozenPortfolioOf("portfolio:tool-agent"),
  }),
  optimizedRow({
    rowId: "fixed-cost-optimized-budget-exhausted-honest-stop",
    description:
      "The honest budget-stop row: the arm pins 70 µ$ over 8 fresh-only extract rounds — the per-round bound (25 µ$, the worst case over the routing table) stops the arm after 3 of the 8 pre-registered rounds (the declared PREFIX stop, never a post-hoc exclusion); the executed prefix holds 2 resolved + 1 honest failure, the measured total (59 µ$) respects the budget, and the slice conformance is the prefix shape.",
    arm: FC_STOP,
    optimizationInventoryRevision: "opt-rev-001",
    optimizedReplay: PLANS_STOP,
    frozenPortfolio: frozenPortfolioOf("portfolio:operations"),
  }),
  optimizedRow({
    rowId: "zero-resolved-optimized-null-discipline",
    description:
      "The NULL-discipline row: every fresh dispatch fails honestly (content policy) — NOTHING resolves, so the cost per successfully resolved outcome is NULL (never zero, never estimate-backed) while the measured cost of the failed rounds is still recorded and the Wilson interval [0, high] is carried honestly on the comparison. Failures never populate the response cache (the failed rounds' duplicates would dispatch fresh — recorded honestly in the budget-stretch row).",
    arm: FC_ZERO,
    optimizationInventoryRevision: "opt-rev-001",
    optimizedReplay: PLANS_ZERO,
    frozenPortfolio: frozenPortfolioOf("portfolio:rag"),
  }),
  optimizedRow({
    rowId: "fresh-only-optimized-cache-inert",
    description:
      "The cache-inert control: the response-cache optimization is ACTIVE but every ODD round's duplicate content belongs to a FRESH-ONLY task (rounds 2, 4, 6 share the content digests of rounds 1, 3, 5 — the collision pairs) — correctness demands a fresh dispatch, so the honest optimized stack NEVER serves them from the cache: 6 fresh dispatches, 3 stored entries, ZERO cache hits. The fresh-only safety rule is the row's whole point (the discrimination battery drives the unsafe-reuse variant against exactly this shape).",
    arm: FQ_FRESH_ONLY,
    optimizationInventoryRevision: "opt-rev-001",
    optimizedReplay: PLANS_FRESH_ONLY,
    frozenPortfolio: frozenPortfolioOf("portfolio:coding"),
  }),
];

// ---------------------------------------------------------------------------
// The live rows (env-gated on the authorized rail; REAL model dispatch)
// ---------------------------------------------------------------------------

/** The live rows (env-gated on the authorized rail; REAL model dispatch). */
export const LIVE_CORPUS_ROWS: readonly OptimizedCorpusRow[] = [
  {
    rowId: "live-fixed-quality-optimized-real-dispatch",
    description:
      "A REAL optimized fixed-quality experiment (env-gated): 4 pre-registered extract rounds driven through the optimized stack over the REAL OpenRouter rail — rounds 1-2 make REAL compressed dispatches through the routed pinned model (BYOK; measured usage, 64-token completion budget), round 3 is a REAL cache hit (the duplicate content replays the cached REAL response of round 1 — no second dispatch, no second charge), round 4 is a fresh-only collision (correctness demands a fresh dispatch — REAL dispatch on duplicate content). The threshold attainment is recomputed from the REAL verdicts; the normalized comparison carries the measured cost-per-resolved and the Wilson interval over the live sample.",
    arm: FQ_LIVE,
    optimizationInventoryRevision: "opt-rev-001",
    optimizedReplay: PLANS_LIVE_FQ,
    frozenPortfolio: frozenPortfolioOf("portfolio:text-generation"),
    needsDispatch: true,
    liveGate: {
      envVars: ["OPENROUTER_API_KEY"],
      requirement:
        "operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) covering the pinned chat model meta-llama/llama-3.3-70b-instruct — the REAL optimized experiments demand REAL model dispatches with measured usage",
    },
    expected: {
      terminal: "COMPLETED",
      executions: 1,
      idempotencyRecords: 1,
      appCreated: 1,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
    },
  },
  {
    rowId: "live-fixed-cost-optimized-real-budget",
    description:
      "A REAL optimized fixed-cost experiment (env-gated): the arm pins a 600 µ$ budget (64-token completion budget per round) and measures the quality attained within it over 4 REAL fresh-only dispatches — the budget gate decides BEFORE each dispatch (the pinned per-round bound, the worst case over the routing table, priced from the manifest), the usage is measured, and the quality-attained carries the Wilson interval.",
    arm: FC_LIVE,
    optimizationInventoryRevision: "opt-rev-001",
    optimizedReplay: PLANS_LIVE_FC,
    frozenPortfolio: frozenPortfolioOf("portfolio:research"),
    needsDispatch: true,
    liveGate: {
      envVars: ["OPENROUTER_API_KEY"],
      requirement:
        "operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) covering the pinned chat model meta-llama/llama-3.3-70b-instruct — the REAL optimized experiments demand REAL model dispatches with measured usage",
    },
    expected: {
      terminal: "COMPLETED",
      executions: 1,
      idempotencyRecords: 1,
      appCreated: 1,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
    },
  },
];

/** The full pinned corpus (offline rows first, live rows last). */
export const OPTIMIZED_CORPUS: readonly OptimizedCorpusRow[] = [
  ...OFFLINE_CORPUS_ROWS,
  ...LIVE_CORPUS_ROWS,
];

/** Whether every env var of the row's live gate is present. */
export function liveGateOpen(row: OptimizedCorpusRow, env: NodeJS.ProcessEnv): boolean {
  if (row.liveGate === undefined) {
    return true;
  }
  return row.liveGate.envVars.every((name) => (env[name] ?? "").length > 0);
}

// ---------------------------------------------------------------------------
// The submission keys + task bodies (the app's fingerprint discipline)
// ---------------------------------------------------------------------------

/** The app's idempotency key for one row's submission. */
export function submissionKey(options: {
  readonly runSuffix: string;
  readonly taskIndex: number;
}): string {
  return `val-042-app-${options.runSuffix}-${options.taskIndex}`;
}

/**
 * The app's task body for one row's submission: REFERENCES ONLY —
 * the row, the arm identity, the arm kind, the pinned price revision,
 * the declared optimization inventory revision (the digest-frozen
 * optimization set reference) and the slice/minimum shape. Never a
 * price, never a token price, never an optimization bound (the
 * platform resolves pricing and the inventory through the registries).
 */
export function taskBodyFor(options: {
  readonly row: OptimizedCorpusRow;
}): Record<string, unknown> {
  const { row } = options;
  return {
    kind: OPTIMIZED_TASK_KIND,
    rowId: row.rowId,
    armId: row.arm.armId,
    armKind: row.arm.kind,
    priceRevision: row.arm.priceRevision,
    optimizationInventoryRevision: row.optimizationInventoryRevision,
    frozenPortfolio: {
      appId: row.frozenPortfolio.appId,
      workloadId: row.frozenPortfolio.workloadId,
      workloadRevision: row.frozenPortfolio.workloadRevision,
      manifestDigest: row.frozenPortfolio.manifestDigest,
    },
    sliceSize: row.arm.corpusSlice.length,
    minimumSamples: row.arm.minimumSamples,
    pinned:
      row.arm.kind === "fixed-quality"
        ? `resolutionRate>=${row.arm.pinnedThreshold.resolutionRate}`
        : `budgetMicroUsd=${row.arm.pinnedBudgetMicroUsd}`,
    ...(row.liveGate === undefined ? {} : { liveGate: row.liveGate.envVars }),
  };
}

/** The row ids in corpus order (config.json mirrors this slice). */
export const OPTIMIZED_ROW_IDS: readonly string[] = OPTIMIZED_CORPUS.map((row) => row.rowId);

/** Look up one corpus row by id (the config task slice references rows by id). */
export function optimizedRowById(rowId: string): OptimizedCorpusRow | null {
  return OPTIMIZED_CORPUS.find((row) => row.rowId === rowId) ?? null;
}
