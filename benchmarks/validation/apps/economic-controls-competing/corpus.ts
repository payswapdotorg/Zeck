/**
 * The economic-controls-competing corpus (VAL-043, AC1): the declared
 * rows of the COMPETING-STACK benchmark experiment. Per row: the ARM
 * MANIFEST ENTRY (the arm kind, the pinned price revision, the
 * pre-registered corpus slice, the statistical minimums, the pinned
 * threshold or budget), the DECLARED COMPETITOR CONFIGURATION
 * revision (content-addressed alongside the price manifests), the
 * FROZEN PORTFOLIO reference (VAL-030 baseline revisions, by content
 * digest — never copied) and the EXPECTED NORMALIZED OUTCOME the
 * protocol derivation must reproduce (the run/resolved counts and the
 * canonical micro-USD economics derived through the REAL accounting
 * derivations over the recorded competitor-interface traces + the
 * pinned manifest + the declared model-selection routing).
 *
 * The offline rows are deterministically reproducible (the recorded
 * competitor-interface traces + the pinned manifest — zero
 * credentials, zero network); the live rows are env-gated on the
 * operator-authorized OpenRouter rail and demand REAL requests
 * through the competitor's REAL interface.
 *
 * Rows never embed list prices: the arms declare WHICH pinned
 * revision priced their runs; pricing resolves through the manifest
 * registry only.
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
import { competitorConfigFor, routeForClass } from "./competitor-config";
import {
  type CompetingCorpusRow,
  type CompetitorTraceRound,
  deriveCompetingRoundBudgetBoundMicroUsd,
  type ExpectedNormalizedOutcome,
  taskClassesOfRow,
} from "./driver";

/** The task kind every row's submission carries (the app's task vocabulary). */
export const COMPETING_TASK_KIND = "economic-controls-competing.experiment.v1";

/** The corpus version the evaluations carry. */
export const COMPETING_CORPUS_VERSION = "val-043-competing-stack-v1";

/** The live rail's pinned model (the manifest's openrouter entry — priced as declared). */
export const LIVE_RAIL_MODEL = "meta-llama/llama-3.3-70b-instruct";

// ---------------------------------------------------------------------------
// The golden tasks of the arms' pre-registered slices
// ---------------------------------------------------------------------------

/**
 * The golden tasks of one arm's pre-registered slice (deterministic
 * derivation from the slice identities): compact confirmation tasks
 * whose deterministic oracles (terminal COMPLETED + the response
 * containing "confirm") are exactly what the recorded traces and the
 * live confirmation rounds settle.
 */
export function competingTasksForArm(arm: EconomicArm): readonly GoldenTask[] {
  const scenarioId = arm.corpusSlice[0]?.split("#")[0] ?? `val-043-comp-${arm.armId}`;
  return arm.corpusSlice.map((taskId) => {
    const index = Number.parseInt(taskId.split("#")[1] ?? "0", 10);
    return {
      taskId,
      family: "text" as const,
      scenarioId,
      description: `Competing-stack experiment round ${index}: confirm the settlement round of the ${arm.armId} arm so the round's quality verdict and measured usage feed the normalized cost-per-resolved accounting.`,
      input: {
        instruction: `Confirm settlement round ${index} of the competing-stack experiment.`,
        arm: arm.armId,
        round: index,
      },
      environmentState: {
        fixtures: [],
        description:
          "the economics lab's controlled competing-round world (no environment fixtures)",
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
            "the round must not exceed the arm's pinned economics (budget or slice) nor the competitor's declared configuration bounds",
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
function frozenPortfolioOf(appId: string): CompetingCorpusRow["frozenPortfolio"] {
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

/** The observed outcome of one recorded trace round's settled request (PURE). */
function observedOfTraceRound(round: CompetitorTraceRound): ObservedOutcome {
  const recorded = round.recorded;
  const final = recorded?.internalAttempts[recorded.internalAttempts.length - 1];
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

/**
 * The usage facts of one recorded trace round's request (the
 * expected-outcome derivation's input — routed through the declared
 * model-selection table, priced per fact through the pinned manifest;
 * ONE aggregate fact pair per request: the competitor's interface
 * granularity).
 */
function usageFactsOfTraceRound(
  row: CompetingCorpusRow,
  round: CompetitorTraceRound,
): readonly UsageFact[] {
  const manifest = manifestFor(row.arm.priceRevision);
  const config = competitorConfigFor(row.competitorConfigRevision);
  const route = routeForClass(config, round.taskClass);
  const currency = railCurrencyOf(manifest, route.provider, route.model);
  const facts: UsageFact[] = [];
  const recorded = round.recorded;
  if (recorded === undefined) {
    return facts;
  }
  facts.push({
    provider: route.provider,
    model: route.model,
    tier: "input",
    currency,
    tokens: recorded.reportedUsage.inputTokens,
    kind: "measured",
    scope: "direct-execution",
    ...(recorded.reportedChargeUsd === undefined
      ? {}
      : { chargedAmount: String(recorded.reportedChargeUsd) }),
  });
  facts.push({
    provider: route.provider,
    model: route.model,
    tier: "output",
    currency,
    tokens: recorded.reportedUsage.outputTokens,
    kind: "measured",
    scope: "direct-execution",
    ...(recorded.reportedChargeUsd === undefined
      ? {}
      : { chargedAmount: String(recorded.reportedChargeUsd) }),
  });
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
 * Derive the expected normalized outcome of one row's recorded traces
 * (PURE — the REAL derivations over the declared fixtures + the
 * pinned manifest + the declared model-selection routing + the
 * fixed-cost budget-gate simulation): the run/resolved counts, the
 * measured and estimated micro-USD totals, the canonical
 * cost-per-resolved (NULL when nothing resolves) and the Wilson 95%
 * interval — exactly what the protocol derivation must reproduce at
 * run time.
 */
export function expectedCompetingOutcomeOf(row: CompetingCorpusRow): ExpectedNormalizedOutcome {
  const manifest = manifestFor(row.arm.priceRevision);
  const config = competitorConfigFor(row.competitorConfigRevision);
  const tasks = competingTasksForArm(row.arm);
  const usageFacts: UsageFact[] = [];
  let resolved = 0;
  let executed = 0;
  let measuredSoFar = 0n;
  // The fixed-cost arm's BEFORE-dispatch budget bound (the worst case
  // over the row's declared classes' model selections — the same
  // conservative derivation the driver records in its durable
  // planning decision).
  const roundBoundMicroUsd =
    row.arm.kind === "fixed-cost"
      ? BigInt(
          deriveCompetingRoundBudgetBoundMicroUsd({
            manifest,
            config,
            taskClasses: taskClassesOfRow(row),
            maxTokens: row.arm.maxTokensPerRound,
          }),
        )
      : null;
  const budgetMicroUsd =
    row.arm.kind === "fixed-cost" ? BigInt(row.arm.pinnedBudgetMicroUsd) : null;
  const rounds = row.arm.corpusSlice
    .map((taskId) => row.competingReplay.find((plan) => plan.taskId === taskId))
    .filter((plan): plan is CompetitorTraceRound => plan !== undefined);
  for (const plan of rounds) {
    // The fixed-cost budget gate — BEFORE the request (the declared
    // prefix stop).
    if (roundBoundMicroUsd !== null && budgetMicroUsd !== null) {
      if (budgetMicroUsd - measuredSoFar < roundBoundMicroUsd) {
        break;
      }
    }
    const observed = observedOfTraceRound(plan);
    const roundFacts = usageFactsOfTraceRound(row, plan);
    usageFacts.push(...roundFacts);
    measuredSoFar += BigInt(normalizeArmCosts(roundFacts, manifest).measuredMicroUsd);
    executed += 1;
    const task = tasks.find((candidate) => candidate.taskId === plan.taskId);
    if (task === undefined) {
      continue;
    }
    const evaluation = evaluateRun({
      task,
      corpusVersion: COMPETING_CORPUS_VERSION,
      observed,
    });
    const latencyMs =
      plan.recorded?.internalAttempts.reduce((sum, attempt) => sum + attempt.latencyMs, 0) ?? 0;
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

const FQ_DEFAULT: FixedQualityArm = {
  armId: "fq-competing-default",
  kind: "fixed-quality",
  integrationSurface: "stack:openrouter",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-043-comp-default", 8),
  minimumSamples: 8,
  pinnedThreshold: { resolutionRate: 0.75 },
};

const FQ_ROUTED: FixedQualityArm = {
  armId: "fq-competing-routed",
  kind: "fixed-quality",
  integrationSurface: "stack:openrouter",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-043-comp-routed", 8),
  minimumSamples: 8,
  pinnedThreshold: { resolutionRate: 0.75 },
};

const FQ_EURO: FixedQualityArm = {
  armId: "fq-competing-eur",
  kind: "fixed-quality",
  integrationSurface: "stack:openrouter",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-043-comp-eur", 6),
  minimumSamples: 6,
  pinnedThreshold: { resolutionRate: 0.75 },
};

const FQ_CORRECTED: FixedQualityArm = {
  armId: "fq-competing-corrected",
  kind: "fixed-quality",
  integrationSurface: "stack:openrouter",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-043-comp-corrected", 6),
  minimumSamples: 6,
  pinnedThreshold: { resolutionRate: 0.75 },
};

const FC_DEFAULT: FixedCostArm = {
  armId: "fc-competing-default",
  kind: "fixed-cost",
  integrationSurface: "stack:openrouter",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-043-comp-fc", 6),
  minimumSamples: 6,
  pinnedBudgetMicroUsd: "400",
  maxTokensPerRound: 64,
};

const FC_STOP: FixedCostArm = {
  armId: "fc-competing-stop",
  kind: "fixed-cost",
  integrationSurface: "stack:openrouter",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-043-comp-stop", 8),
  minimumSamples: 3,
  pinnedBudgetMicroUsd: "70",
  maxTokensPerRound: 64,
};

const FC_ZERO: FixedCostArm = {
  armId: "fc-competing-zero",
  kind: "fixed-cost",
  integrationSurface: "stack:openrouter",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-043-comp-zero", 6),
  minimumSamples: 6,
  pinnedBudgetMicroUsd: "1200",
  maxTokensPerRound: 96,
};

const FQ_LIVE: FixedQualityArm = {
  armId: "fq-competing-live",
  kind: "fixed-quality",
  integrationSurface: "stack:openrouter",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-043-comp-live", 4),
  minimumSamples: 3,
  pinnedThreshold: { resolutionRate: 0.5 },
};

const FC_LIVE: FixedCostArm = {
  armId: "fc-competing-live",
  kind: "fixed-cost",
  integrationSurface: "stack:openrouter",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-043-comp-livefc", 4),
  minimumSamples: 3,
  pinnedBudgetMicroUsd: "600",
  maxTokensPerRound: 64,
};

// ---------------------------------------------------------------------------
// The trace plans (the recorded competitor-interface facts)
// ---------------------------------------------------------------------------

/** One recorded successful internal attempt. */
function ok(usage: { inputTokens: number; outputTokens: number }, latencyMs: number) {
  return { outcome: "success" as const, usage, latencyMs };
}

/** One recorded failed internal attempt. */
function fail(
  category: string,
  usage: { inputTokens: number; outputTokens: number },
  latencyMs: number,
) {
  return { outcome: "failure" as const, usage, category, latencyMs };
}

/**
 * The row-1 plans: 8 extract requests through the competitor's
 * default pool — 7 settle on the primary endpoint, round 8 exhausts
 * TWO internal fallbacks (the rate-limited primary + the secondary)
 * before the tertiary settles it: ONE request, aggregate usage
 * (360 in / 50 out — the amortization inside the competitor's
 * boundary), routed to the pool's tertiary endpoint (the variance
 * observation). Round 1 carries the competitor-side quote (reported
 * separately, never conflated).
 */
const TRACES_DEFAULT: readonly CompetitorTraceRound[] = [
  {
    taskId: FQ_DEFAULT.corpusSlice[0] as string,
    taskClass: "extract",
    routedEndpoint: "openrouter-pool-primary",
    recorded: {
      internalAttempts: [ok({ inputTokens: 120, outputTokens: 30 }, 820)],
      reportedUsage: { inputTokens: 120, outputTokens: 30 },
      reportedChargeUsd: 0.0000219,
      responseText: "confirm",
      estimateQuote: { inputTokens: 100, outputTokens: 20 },
    },
  },
  ...FQ_DEFAULT.corpusSlice.slice(1, 7).map((taskId) => ({
    taskId,
    taskClass: "extract",
    routedEndpoint: "openrouter-pool-primary",
    recorded: {
      internalAttempts: [ok({ inputTokens: 120, outputTokens: 30 }, 810)],
      reportedUsage: { inputTokens: 120, outputTokens: 30 },
      reportedChargeUsd: 0.0000219,
      responseText: "confirm",
    },
  })),
  {
    taskId: FQ_DEFAULT.corpusSlice[7] as string,
    taskClass: "extract",
    routedEndpoint: "openrouter-pool-tertiary",
    recorded: {
      internalAttempts: [
        fail("rate-limit", { inputTokens: 120, outputTokens: 10 }, 300),
        fail("rate-limit", { inputTokens: 120, outputTokens: 10 }, 320),
        ok({ inputTokens: 120, outputTokens: 30 }, 650),
      ],
      reportedUsage: { inputTokens: 360, outputTokens: 50 },
      reportedChargeUsd: 0.000056,
      responseText: "confirm",
    },
  },
];

/**
 * The row-2 plans: the competitor's per-class catalog selection —
 * summarize (retry-relay), extract (openrouter) and transform-batch
 * (batch-relay); the summarize class's third request exhausts ONE
 * internal fallback (bounded by the declared posture) and lands on
 * the pool's secondary endpoint (the variance observation); the
 * batched rail's ceil-to-batch metering charges 520 → 1000 tokens.
 */
const TRACES_ROUTED: readonly CompetitorTraceRound[] = [
  {
    taskId: FQ_ROUTED.corpusSlice[0] as string,
    taskClass: "summarize",
    routedEndpoint: "retry-pool-primary",
    recorded: {
      internalAttempts: [ok({ inputTokens: 150, outputTokens: 35 }, 600)],
      reportedUsage: { inputTokens: 150, outputTokens: 35 },
      reportedChargeUsd: 0.0000261,
      responseText: "confirm",
    },
  },
  {
    taskId: FQ_ROUTED.corpusSlice[1] as string,
    taskClass: "summarize",
    routedEndpoint: "retry-pool-primary",
    recorded: {
      internalAttempts: [ok({ inputTokens: 150, outputTokens: 35 }, 610)],
      reportedUsage: { inputTokens: 150, outputTokens: 35 },
      reportedChargeUsd: 0.0000261,
      responseText: "confirm",
    },
  },
  {
    taskId: FQ_ROUTED.corpusSlice[2] as string,
    taskClass: "summarize",
    routedEndpoint: "retry-pool-secondary",
    recorded: {
      internalAttempts: [
        fail("rate-limit", { inputTokens: 150, outputTokens: 10 }, 300),
        ok({ inputTokens: 150, outputTokens: 35 }, 650),
      ],
      reportedUsage: { inputTokens: 300, outputTokens: 45 },
      reportedChargeUsd: 0.0000441,
      responseText: "confirm",
    },
  },
  {
    taskId: FQ_ROUTED.corpusSlice[3] as string,
    taskClass: "extract",
    routedEndpoint: "openrouter-pool-primary",
    recorded: {
      internalAttempts: [ok({ inputTokens: 120, outputTokens: 30 }, 820)],
      reportedUsage: { inputTokens: 120, outputTokens: 30 },
      reportedChargeUsd: 0.0000219,
      responseText: "confirm",
      estimateQuote: { inputTokens: 100, outputTokens: 20 },
    },
  },
  {
    taskId: FQ_ROUTED.corpusSlice[4] as string,
    taskClass: "extract",
    routedEndpoint: "openrouter-pool-primary",
    recorded: {
      internalAttempts: [ok({ inputTokens: 120, outputTokens: 30 }, 800)],
      reportedUsage: { inputTokens: 120, outputTokens: 30 },
      reportedChargeUsd: 0.0000219,
      responseText: "confirm",
    },
  },
  {
    taskId: FQ_ROUTED.corpusSlice[5] as string,
    taskClass: "extract",
    routedEndpoint: "openrouter-pool-primary",
    recorded: {
      internalAttempts: [ok({ inputTokens: 120, outputTokens: 30 }, 830)],
      reportedUsage: { inputTokens: 120, outputTokens: 30 },
      reportedChargeUsd: 0.0000219,
      responseText: "confirm",
    },
  },
  {
    taskId: FQ_ROUTED.corpusSlice[6] as string,
    taskClass: "transform-batch",
    routedEndpoint: "batch-pool-primary",
    recorded: {
      internalAttempts: [ok({ inputTokens: 400, outputTokens: 60 }, 610)],
      reportedUsage: { inputTokens: 400, outputTokens: 60 },
      reportedChargeUsd: 0.0000528,
      responseText: "confirm",
    },
  },
  {
    taskId: FQ_ROUTED.corpusSlice[7] as string,
    taskClass: "transform-batch",
    routedEndpoint: "batch-pool-primary",
    recorded: {
      internalAttempts: [ok({ inputTokens: 520, outputTokens: 60 }, 640)],
      reportedUsage: { inputTokens: 520, outputTokens: 60 },
      reportedChargeUsd: 0.0000832,
      responseText: "confirm",
    },
  },
];

/**
 * The row-3 plans: the competitor's EU-priced catalog entry
 * (translate → euro-relay, EUR per-1M metered) — 5 of 6 requests
 * confirm; the fourth fails honestly at the competitor boundary
 * (content policy: the gateway's moderation refusal); the EUR list
 * prices convert through the pinned FX table (1.03 USD/EUR) onto the
 * canonical micro-USD basis, and the gateway's OWN USD charge
 * observation rides as the cross-check (never the basis). Every
 * request rode the same EU pool endpoint (reproduced — no variance).
 */
const TRACES_EURO: readonly CompetitorTraceRound[] = FQ_EURO.corpusSlice.map((taskId, index) => ({
  taskId,
  taskClass: "translate",
  routedEndpoint: "eu-pool-primary",
  recorded:
    index === 3
      ? {
          internalAttempts: [fail("content-policy", { inputTokens: 200, outputTokens: 8 }, 640)],
          reportedUsage: { inputTokens: 200, outputTokens: 8 },
          reportedChargeUsd: 0.0000912,
        }
      : {
          internalAttempts: [ok({ inputTokens: 200, outputTokens: 40 }, 700)],
          reportedUsage: { inputTokens: 200, outputTokens: 40 },
          reportedChargeUsd: 0.00131,
          responseText: "confirm",
        },
}));

/**
 * The row-4 plans: the CORRECTED configuration revision (cmp-rev-002
 * tightens the automatic fallback to at most 1 internal retry) — 4
 * plain requests + 2 requests that each exhaust ONE internal
 * fallback (within the tightened posture: 2 total attempts each),
 * landing on the pool's secondary endpoint (the variance
 * observation). The aggregate usage amortizes the internal attempt
 * inside the competitor's boundary.
 */
const TRACES_CORRECTED: readonly CompetitorTraceRound[] = [
  ...FQ_CORRECTED.corpusSlice.slice(0, 4).map((taskId) => ({
    taskId,
    taskClass: "extract",
    routedEndpoint: "openrouter-pool-primary",
    recorded: {
      internalAttempts: [ok({ inputTokens: 120, outputTokens: 30 }, 810)],
      reportedUsage: { inputTokens: 120, outputTokens: 30 },
      reportedChargeUsd: 0.0000219,
      responseText: "confirm",
    },
  })),
  ...FQ_CORRECTED.corpusSlice.slice(4).map((taskId) => ({
    taskId,
    taskClass: "extract",
    routedEndpoint: "openrouter-pool-secondary",
    recorded: {
      internalAttempts: [
        fail("rate-limit", { inputTokens: 120, outputTokens: 10 }, 300),
        ok({ inputTokens: 120, outputTokens: 30 }, 650),
      ],
      reportedUsage: { inputTokens: 240, outputTokens: 40 },
      reportedChargeUsd: 0.000039,
      responseText: "confirm",
    },
  })),
];

/**
 * The row-5 plans: 5 confirmations + 1 honest content-policy refusal
 * at the competitor boundary (within the 400 µ$ budget; the
 * per-round bound 24 µ$ covers every request).
 */
const TRACES_FC: readonly CompetitorTraceRound[] = FC_DEFAULT.corpusSlice.map((taskId, index) => ({
  taskId,
  taskClass: "extract",
  routedEndpoint: "openrouter-pool-primary",
  recorded:
    index === 2
      ? {
          internalAttempts: [fail("content-policy", { inputTokens: 120, outputTokens: 5 }, 700)],
          reportedUsage: { inputTokens: 120, outputTokens: 5 },
          reportedChargeUsd: 0.0000147,
        }
      : {
          internalAttempts: [ok({ inputTokens: 120, outputTokens: 30 }, 820)],
          reportedUsage: { inputTokens: 120, outputTokens: 30 },
          reportedChargeUsd: 0.0000219,
          responseText: "confirm",
        },
}));

/**
 * The row-6 plans: the honest budget-stop row — the first requests
 * confirm, the third fails honestly; the pinned budget (70 µ$) stops
 * the arm after 3 of the 8 pre-registered rounds (the per-round
 * bound 24 µ$ — the worst case over the row's declared classes'
 * selections — decided BEFORE dispatch; the declared prefix stop).
 */
const TRACES_STOP: readonly CompetitorTraceRound[] = FC_STOP.corpusSlice.map((taskId, index) => ({
  taskId,
  taskClass: "extract",
  routedEndpoint: "openrouter-pool-primary",
  recorded:
    index === 2
      ? {
          internalAttempts: [fail("content-policy", { inputTokens: 120, outputTokens: 5 }, 700)],
          reportedUsage: { inputTokens: 120, outputTokens: 5 },
          reportedChargeUsd: 0.0000147,
        }
      : {
          internalAttempts: [ok({ inputTokens: 120, outputTokens: 30 }, 820)],
          reportedUsage: { inputTokens: 120, outputTokens: 30 },
          reportedChargeUsd: 0.0000219,
          responseText: "confirm",
        },
}));

/** The row-7 plans: every request fails honestly (nothing resolves). */
const TRACES_ZERO: readonly CompetitorTraceRound[] = FC_ZERO.corpusSlice.map((taskId) => ({
  taskId,
  taskClass: "extract",
  routedEndpoint: "openrouter-pool-primary",
  recorded: {
    internalAttempts: [fail("content-policy", { inputTokens: 200, outputTokens: 8 }, 650)],
    reportedUsage: { inputTokens: 200, outputTokens: 8 },
    reportedChargeUsd: 0.0000248,
  },
}));

/** The live row-1 plans: REAL requests through the competitor's real interface. */
const TRACES_LIVE_FQ: readonly CompetitorTraceRound[] = FQ_LIVE.corpusSlice.map((taskId) => ({
  taskId,
  taskClass: "extract",
  routedEndpoint: "live-openrouter-pool",
}));

/** The live row-2 plans: REAL requests under the pinned budget. */
const TRACES_LIVE_FC: readonly CompetitorTraceRound[] = FC_LIVE.corpusSlice.map((taskId) => ({
  taskId,
  taskClass: "extract",
  routedEndpoint: "live-openrouter-pool",
}));

// ---------------------------------------------------------------------------
// The row builder (the oracle's derivation)
// ---------------------------------------------------------------------------

/**
 * Build one offline corpus row with its PINNED expected normalized
 * outcome: the REAL derivations (the declared model-selection routing
 * + the recorded traces' aggregate usage + the pinned manifest + the
 * REAL evaluation and resolution thresholds + the Wilson interval)
 * run over the declared fixtures at module load — exactly what the
 * driver's own accounting must reproduce at run time.
 */
function competingRow(input: {
  readonly rowId: string;
  readonly description: string;
  readonly arm: EconomicArm;
  readonly competitorConfigRevision: string;
  readonly competingReplay: readonly CompetitorTraceRound[];
  readonly frozenPortfolio: CompetingCorpusRow["frozenPortfolio"];
}): CompetingCorpusRow {
  const row: CompetingCorpusRow = {
    rowId: input.rowId,
    description: input.description,
    arm: input.arm,
    competitorConfigRevision: input.competitorConfigRevision,
    competingReplay: input.competingReplay,
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
  return { ...row, expected: { ...row.expected, normalized: expectedCompetingOutcomeOf(row) } };
}

// ---------------------------------------------------------------------------
// The offline rows (deterministic — always drivable, zero credentials)
// ---------------------------------------------------------------------------

/** The offline rows (deterministic — always drivable, zero credentials). */
export const OFFLINE_CORPUS_ROWS: readonly CompetingCorpusRow[] = [
  competingRow({
    rowId: "fixed-quality-competitor-default-routing",
    description:
      "The headline competing fixed-quality row: 8 pre-registered extract requests through the competitor's default pool (openrouter/llama-3.3-70b, USD per-1M metered — rev-001). Seven requests settle on the primary endpoint (120+30 tokens each; the first carries a competitor-side quote reported SEPARATELY — never conflated); the eighth exhausts TWO internal fallbacks (rate-limited primary + secondary) before the tertiary settles it — ONE request with aggregate usage (360 in / 50 out: the retry amortization happens INSIDE the competitor's boundary and is priced as the request's own measured usage), routed to the tertiary endpoint (the declared honest variance in action). Threshold ≥ 0.75 over the full slice; the normalized comparison carries the measured cost-per-resolved and the Wilson 95% interval.",
    arm: FQ_DEFAULT,
    competitorConfigRevision: "cmp-rev-001",
    competingReplay: TRACES_DEFAULT,
    frozenPortfolio: frozenPortfolioOf("portfolio:text-generation"),
  }),
  competingRow({
    rowId: "fixed-quality-competitor-routed-classes",
    description:
      "The routed-classes row: the competitor's declared per-class catalog selection across its model-selection table — summarize → retry-relay (3 requests, one internally retried onto the secondary endpoint), extract → openrouter (3 requests, the first carrying a competitor-side quote) and transform-batch → batch-relay (2 requests with the batched rail's ceil-to-batch metering: 520 tokens round UP to the 1000-token increment). Every rail priced through the pinned manifest per fact; the heterogeneous pricing shapes converge onto the SAME canonical micro-USD basis.",
    arm: FQ_ROUTED,
    competitorConfigRevision: "cmp-rev-001",
    competingReplay: TRACES_ROUTED,
    frozenPortfolio: frozenPortfolioOf("portfolio:operations"),
  }),
  competingRow({
    rowId: "fixed-quality-competitor-eu-catalog",
    description:
      "The EU-catalog row: the competitor's EU-priced catalog entry (translate → euro-relay, EUR per-1M metered) — 5 of 6 requests confirm, the fourth fails honestly at the competitor boundary (the gateway's moderation refusal); the EUR list prices convert through the pinned FX table (1.03 USD/EUR) onto the canonical micro-USD basis, and the gateway's OWN USD charge observation rides as a cross-check (never the basis — every arm compares at the SAME pinned list prices). All requests rode the same EU pool endpoint (reproduced — no variance).",
    arm: FQ_EURO,
    competitorConfigRevision: "cmp-rev-001",
    competingReplay: TRACES_EURO,
    frozenPortfolio: frozenPortfolioOf("portfolio:rag"),
  }),
  competingRow({
    rowId: "fixed-quality-competitor-corrected-config",
    description:
      "The corrected-configuration row over the CORRECTED revision (cmp-rev-002 supersedes cmp-rev-001 — the automatic fallback tightened from 2 internal retries to 1): 6 extract requests, 4 plain + 2 that each exhaust ONE internal fallback (2 total attempts — within the tightened posture), landing on the pool's secondary endpoint (the declared honest variance). The aggregate usage (240 in / 40 out) amortizes the internal attempt inside the competitor's boundary; the retry-posture oracle verifies the tightened bound mechanically.",
    arm: FQ_CORRECTED,
    competitorConfigRevision: "cmp-rev-002",
    competingReplay: TRACES_CORRECTED,
    frozenPortfolio: frozenPortfolioOf("portfolio:tool-agent"),
  }),
  competingRow({
    rowId: "fixed-cost-competitor-within-budget",
    description:
      "The competing fixed-cost row: the arm pins a 400 µ$ budget (64-token completion budget per request — pinned explicitly, the 402 lesson) and measures the quality attained within it — 6 pre-registered requests all dispatch (the per-round bound 24 µ$ — the worst case over the extract class's selection — covers every request; the measured total 125 µ$ respects the budget with headroom), 5 confirm and 1 fails honestly (the gateway's moderation refusal); the quality-attained (5/6) and the measured cost-per-resolved carry the Wilson interval.",
    arm: FC_DEFAULT,
    competitorConfigRevision: "cmp-rev-001",
    competingReplay: TRACES_FC,
    frozenPortfolio: frozenPortfolioOf("portfolio:coding"),
  }),
  competingRow({
    rowId: "fixed-cost-competitor-budget-exhausted-honest-stop",
    description:
      "The honest budget-stop row: the arm pins 70 µ$ over 8 extract requests — the per-round bound (24 µ$) stops the arm after 3 of the 8 pre-registered rounds (the declared PREFIX stop, never a post-hoc exclusion); the executed prefix holds 2 resolved + 1 honest failure, the measured total (59 µ$) respects the budget, and the slice conformance is the prefix shape.",
    arm: FC_STOP,
    competitorConfigRevision: "cmp-rev-001",
    competingReplay: TRACES_STOP,
    frozenPortfolio: frozenPortfolioOf("portfolio:operations"),
  }),
  competingRow({
    rowId: "zero-resolved-competitor-null-discipline",
    description:
      "The NULL-discipline row: every request fails honestly at the competitor boundary (content policy) — NOTHING resolves, so the cost per successfully resolved outcome is NULL (never zero, never estimate-backed) while the measured cost of the failed requests is still recorded and the Wilson interval [0, high] is carried honestly on the comparison.",
    arm: FC_ZERO,
    competitorConfigRevision: "cmp-rev-001",
    competingReplay: TRACES_ZERO,
    frozenPortfolio: frozenPortfolioOf("portfolio:research"),
  }),
];

// ---------------------------------------------------------------------------
// The live rows (env-gated on the authorized rail; REAL requests)
// ---------------------------------------------------------------------------

/** The live rows (env-gated on the authorized rail; REAL requests). */
export const LIVE_CORPUS_ROWS: readonly CompetingCorpusRow[] = [
  {
    rowId: "live-fixed-quality-competitor-real-dispatch",
    description:
      "A REAL competing fixed-quality experiment (env-gated): 4 pre-registered extract requests driven through the competitor's REAL interface — the REAL model gateway over the REAL OpenRouter rail with the declared configuration (the pinned model, temperature UNSET — the competitor's documented default, max_tokens 64 pinned explicitly). The requests' REAL reported usage is measured (BYOK), the gateway's REAL pool routing is observed (the declared honest variance), and the competitor's own charge observation rides as the cross-check; the threshold attainment is recomputed from the REAL verdicts and the normalized comparison carries the measured cost-per-resolved and the Wilson interval over the live sample.",
    arm: FQ_LIVE,
    competitorConfigRevision: "cmp-rev-001",
    competingReplay: TRACES_LIVE_FQ,
    frozenPortfolio: frozenPortfolioOf("portfolio:text-generation"),
    needsDispatch: true,
    liveGate: {
      envVars: ["OPENROUTER_API_KEY"],
      requirement:
        "operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) covering the pinned chat model meta-llama/llama-3.3-70b-instruct — the REAL competing experiments demand REAL requests through the competitor's real interface with measured usage",
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
    rowId: "live-fixed-cost-competitor-real-budget",
    description:
      "A REAL competing fixed-cost experiment (env-gated): the arm pins a 600 µ$ budget (64-token completion budget per request) and measures the quality attained within it over 4 REAL requests — the budget gate decides BEFORE each request (the pinned per-round bound priced from the manifest), the usage is measured, and the quality-attained carries the Wilson interval.",
    arm: FC_LIVE,
    competitorConfigRevision: "cmp-rev-001",
    competingReplay: TRACES_LIVE_FC,
    frozenPortfolio: frozenPortfolioOf("portfolio:research"),
    needsDispatch: true,
    liveGate: {
      envVars: ["OPENROUTER_API_KEY"],
      requirement:
        "operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) covering the pinned chat model meta-llama/llama-3.3-70b-instruct — the REAL competing experiments demand REAL requests through the competitor's real interface with measured usage",
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
export const COMPETING_CORPUS: readonly CompetingCorpusRow[] = [
  ...OFFLINE_CORPUS_ROWS,
  ...LIVE_CORPUS_ROWS,
];

/** Whether every env var of the row's live gate is present. */
export function liveGateOpen(row: CompetingCorpusRow, env: NodeJS.ProcessEnv): boolean {
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
  return `val-043-app-${options.runSuffix}-${options.taskIndex}`;
}

/**
 * The app's task body for one row's submission: REFERENCES ONLY —
 * the row, the arm identity, the arm kind, the pinned price revision,
 * the declared competitor configuration revision (the digest-frozen
 * configuration reference) and the slice/minimum shape. Never a
 * price, never a token price, never a configuration bound (the
 * platform resolves pricing and the competitor configuration through
 * the registries).
 */
export function taskBodyFor(options: {
  readonly row: CompetingCorpusRow;
}): Record<string, unknown> {
  const { row } = options;
  return {
    kind: COMPETING_TASK_KIND,
    rowId: row.rowId,
    armId: row.arm.armId,
    armKind: row.arm.kind,
    priceRevision: row.arm.priceRevision,
    competitorConfigRevision: row.competitorConfigRevision,
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
export const COMPETING_ROW_IDS: readonly string[] = COMPETING_CORPUS.map((row) => row.rowId);

/** Look up one corpus row by id (the config task slice references rows by id). */
export function competingRowById(rowId: string): CompetingCorpusRow | null {
  return COMPETING_CORPUS.find((row) => row.rowId === rowId) ?? null;
}
