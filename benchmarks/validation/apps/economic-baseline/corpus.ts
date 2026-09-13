/**
 * The economic-baseline corpus (VAL-040, AC1): the declared rows of
 * the fixed-quality / fixed-cost experiment protocol. Per row: the
 * ARM MANIFEST ENTRY (the arm kind, the pinned price revision, the
 * pre-registered corpus slice, the statistical minimums, the pinned
 * threshold or budget) and the EXPECTED NORMALIZED OUTCOME the
 * protocol derivation must reproduce (the run/resolved counts and
 * the canonical micro-USD economics derived through the REAL
 * accounting derivations over the recorded rounds + the pinned
 * manifest — the declared-fixture-digest pattern).
 *
 * The offline rows are deterministically reproducible (the recorded
 * VAL-006-style accounting replays + the pinned manifest — zero
 * credentials, zero network); the live rows are env-gated on the
 * operator-authorized OpenRouter rail and demand REAL model
 * dispatches through the REAL platform path.
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
import type { EconomicCorpusRow, ExpectedNormalizedOutcome, RecordedRound } from "./driver";
import type { UsageFact } from "./normalization";
import { deriveCostPerResolved, manifestFor, normalizeArmCosts } from "./normalization";
import { resolveListPrice } from "./pricing";
import type { EconomicArm, FixedCostArm, FixedQualityArm } from "./protocol";

/** The task kind every row's submission carries (the app's task vocabulary). */
export const ECONOMIC_TASK_KIND = "economic-baseline.experiment.v1";

/** The corpus version the evaluations carry. */
export const ECONOMIC_CORPUS_VERSION = "val-040-economic-baseline-v1";

/** The live rail's pinned model (the manifest's openrouter entry — priced as declared). */
export const LIVE_RAIL_MODEL = "meta-llama/llama-3.3-70b-instruct";

// ---------------------------------------------------------------------------
// The golden tasks of the arms' pre-registered slices
// ---------------------------------------------------------------------------

/** The rail's declared currency for one provider/model (the manifest's own denomination). */
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

/**
 * The golden tasks of one arm's pre-registered slice (deterministic
 * derivation from the slice identities): compact confirmation tasks
 * whose deterministic oracles (terminal COMPLETED + the response
 * containing "confirm") are exactly what the recorded replays and
 * the live confirmation rounds settle.
 */
export function economicTasksForArm(arm: EconomicArm): readonly GoldenTask[] {
  const scenarioId = arm.corpusSlice[0]?.split("#")[0] ?? `val-040-econ-${arm.armId}`;
  return arm.corpusSlice.map((taskId) => {
    const index = Number.parseInt(taskId.split("#")[1] ?? "0", 10);
    return {
      taskId,
      family: "text" as const,
      scenarioId,
      description: `Economic-baseline experiment round ${index}: confirm the settlement round of the ${arm.armId} arm so the round's quality verdict and measured usage feed the normalized cost-per-resolved accounting.`,
      input: {
        instruction: `Confirm settlement round ${index} of the economic baseline experiment.`,
        arm: arm.armId,
        round: index,
      },
      environmentState: {
        fixtures: [],
        description: "the economics lab's controlled round world (no environment fixtures)",
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
          constraint: "the round must not exceed the arm's pinned economics (budget or slice)",
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
// The recorded rounds (the deterministic offline accounting replays)
// ---------------------------------------------------------------------------

/** Build one successful recorded round (a single settled attempt). */
function successRound(
  taskId: string,
  usage: { inputTokens: number; outputTokens: number },
  latencyMs: number,
  options?: { readonly estimateQuote?: { inputTokens: number; outputTokens: number } },
): RecordedRound {
  return {
    taskId,
    attempts: [{ outcome: "success", usage, latencyMs }],
    responseText: "confirm",
    ...(options?.estimateQuote === undefined ? {} : { estimateQuote: options.estimateQuote }),
  };
}

/** Build one failed recorded round (a terminal non-retryable failure). */
function failedRound(
  taskId: string,
  usage: { inputTokens: number; outputTokens: number },
  latencyMs: number,
  category: string,
): RecordedRound {
  return {
    taskId,
    attempts: [{ outcome: "failure", usage, category, latencyMs }],
  };
}

/** Build one retry-amortized recorded round (a retryable failure recovered by the bounded retry). */
function retriedRound(
  taskId: string,
  failedUsage: { inputTokens: number; outputTokens: number },
  failedLatencyMs: number,
  successUsage: { inputTokens: number; outputTokens: number },
  successLatencyMs: number,
): RecordedRound {
  return {
    taskId,
    attempts: [
      {
        outcome: "failure",
        usage: failedUsage,
        category: "rate-limit",
        latencyMs: failedLatencyMs,
      },
      { outcome: "success", usage: successUsage, latencyMs: successLatencyMs },
    ],
    responseText: "confirm",
  };
}

/** The usage facts of one recorded round (the expected-outcome derivation's input). */
function usageFactsOfRecordedRound(arm: EconomicArm, round: RecordedRound): readonly UsageFact[] {
  const manifest = manifestFor(arm.priceRevision);
  const currency = railCurrencyOf(manifest, arm.provider, arm.model);
  const facts: UsageFact[] = [];
  for (const [index, attempt] of round.attempts.entries()) {
    const isFinal = index === round.attempts.length - 1;
    facts.push({
      provider: arm.provider,
      model: arm.model,
      tier: "input",
      currency,
      tokens: attempt.usage.inputTokens,
      kind: "measured",
      scope: isFinal ? "direct-execution" : "retry-overhead",
    });
    facts.push({
      provider: arm.provider,
      model: arm.model,
      tier: "output",
      currency,
      tokens: attempt.usage.outputTokens,
      kind: "measured",
      scope: isFinal ? "direct-execution" : "retry-overhead",
    });
  }
  if (round.estimateQuote !== undefined) {
    facts.push({
      provider: arm.provider,
      model: arm.model,
      tier: "input",
      currency,
      tokens: round.estimateQuote.inputTokens,
      kind: "estimate",
      scope: "direct-execution",
    });
    facts.push({
      provider: arm.provider,
      model: arm.model,
      tier: "output",
      currency,
      tokens: round.estimateQuote.outputTokens,
      kind: "estimate",
      scope: "direct-execution",
    });
  }
  return facts;
}

/** The observed outcome of one recorded round (the evaluation oracle's input). */
function observedOfRecordedRound(round: RecordedRound): ObservedOutcome {
  const final = round.attempts[round.attempts.length - 1];
  if (final !== undefined && final.outcome === "success") {
    return {
      terminalStatus: "COMPLETED",
      verificationStatuses: ["PASS"],
      responseText: round.responseText ?? "",
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
 * Derive the expected normalized outcome of one row's recorded
 * rounds (PURE — the REAL derivations over the declared fixtures +
 * the pinned manifest): the run/resolved counts, the measured and
 * estimated micro-USD totals, the canonical cost-per-resolved (NULL
 * when nothing resolves) and the Wilson 95% interval — exactly what
 * the protocol derivation must reproduce at run time.
 */
export function expectedNormalizedOutcomeOf(
  arm: EconomicArm,
  replay: readonly RecordedRound[],
): ExpectedNormalizedOutcome {
  const manifest = manifestFor(arm.priceRevision);
  const tasks = economicTasksForArm(arm);
  const usageFacts = replay.flatMap((round) => usageFactsOfRecordedRound(arm, round));
  const basis = normalizeArmCosts(usageFacts, manifest);
  let resolved = 0;
  for (const round of replay) {
    const task = tasks.find((candidate) => candidate.taskId === round.taskId);
    if (task === undefined) {
      continue;
    }
    const evaluation = evaluateRun({
      task,
      corpusVersion: ECONOMIC_CORPUS_VERSION,
      observed: observedOfRecordedRound(round),
    });
    const latencyMs = round.attempts.reduce((sum, attempt) => sum + attempt.latencyMs, 0);
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
  const perResolved = deriveCostPerResolved({
    measuredMicroUsd: basis.measuredMicroUsd,
    estimatedMicroUsd: basis.estimatedMicroUsd,
    resolvedCount: resolved,
  });
  const confidence = wilsonInterval(resolved, replay.length);
  return {
    runCount: replay.length,
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

const FQ_OPENROUTER: FixedQualityArm = {
  armId: "fq-openrouter",
  kind: "fixed-quality",
  integrationSurface: "sdk",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-040-econ-openrouter", 8),
  minimumSamples: 8,
  pinnedThreshold: { resolutionRate: 0.75 },
};

const FQ_EURO: FixedQualityArm = {
  armId: "fq-euro",
  kind: "fixed-quality",
  integrationSurface: "sdk",
  provider: "euro-relay",
  model: "euro-small-v1",
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-040-econ-euro", 8),
  minimumSamples: 8,
  pinnedThreshold: { resolutionRate: 0.75 },
};

const FQ_TOKYO: FixedQualityArm = {
  armId: "fq-tokyo",
  kind: "fixed-quality",
  integrationSurface: "sdk",
  provider: "tokyo-relay",
  model: "tokyo-mini-v1",
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-040-econ-tokyo", 8),
  minimumSamples: 8,
  pinnedThreshold: { resolutionRate: 0.75 },
};

const FQ_BATCH: FixedQualityArm = {
  armId: "fq-batch",
  kind: "fixed-quality",
  integrationSurface: "sdk",
  provider: "batch-relay",
  model: "batch-medium-v1",
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-040-econ-batch", 8),
  minimumSamples: 8,
  pinnedThreshold: { resolutionRate: 0.75 },
};

const FQ_RETRY: FixedQualityArm = {
  armId: "fq-retry",
  kind: "fixed-quality",
  integrationSurface: "sdk",
  provider: "retry-relay",
  model: "retry-small-v1",
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-040-econ-retry", 8),
  minimumSamples: 8,
  pinnedThreshold: { resolutionRate: 0.75 },
};

const FC_OPENROUTER: FixedCostArm = {
  armId: "fc-openrouter",
  kind: "fixed-cost",
  integrationSurface: "sdk",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-040-econ-fc", 6),
  minimumSamples: 6,
  pinnedBudgetMicroUsd: "400",
  maxTokensPerRound: 64,
};

const FC_BUDGET_STOP: FixedCostArm = {
  armId: "fc-budget-stop",
  kind: "fixed-cost",
  integrationSurface: "sdk",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-040-econ-stop", 8),
  minimumSamples: 3,
  pinnedBudgetMicroUsd: "70",
  maxTokensPerRound: 64,
};

const FC_ZERO_RESOLVED: FixedCostArm = {
  armId: "fc-zero-resolved",
  kind: "fixed-cost",
  integrationSurface: "sdk",
  provider: "euro-relay",
  model: "euro-small-v1",
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-040-econ-zero", 6),
  minimumSamples: 6,
  pinnedBudgetMicroUsd: "1200",
  maxTokensPerRound: 96,
};

const FQ_OPENROUTER_LIVE: FixedQualityArm = {
  armId: "fq-openrouter-live",
  kind: "fixed-quality",
  integrationSurface: "sdk",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-040-econ-live", 4),
  minimumSamples: 3,
  pinnedThreshold: { resolutionRate: 0.5 },
};

const FC_OPENROUTER_LIVE: FixedCostArm = {
  armId: "fc-openrouter-live",
  kind: "fixed-cost",
  integrationSurface: "sdk",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-040-econ-livefc", 4),
  minimumSamples: 3,
  pinnedBudgetMicroUsd: "600",
  maxTokensPerRound: 64,
};

// ---------------------------------------------------------------------------
// The recorded rounds per offline row (deterministic replays)
// ---------------------------------------------------------------------------

/** Row 1's replays: 8 confirmed rounds (the first carries a planner estimate quote). */
const REPLAYS_OPENROUTER: readonly RecordedRound[] = [
  successRound(
    FQ_OPENROUTER.corpusSlice[0] as string,
    { inputTokens: 120, outputTokens: 30 },
    850,
    { estimateQuote: { inputTokens: 100, outputTokens: 20 } },
  ),
  ...FQ_OPENROUTER.corpusSlice
    .slice(1)
    .map((taskId) => successRound(taskId, { inputTokens: 120, outputTokens: 30 }, 820)),
];

/** Row 2's replays: 6 confirmed + 2 honest content-policy failures. */
const REPLAYS_EURO: readonly RecordedRound[] = FQ_EURO.corpusSlice.map((taskId, index) =>
  index === 3 || index === 6
    ? failedRound(taskId, { inputTokens: 200, outputTokens: 8 }, 640, "content-policy")
    : successRound(taskId, { inputTokens: 200, outputTokens: 40 }, 700),
);

/** Row 3's replays: 7 confirmed + 1 honest failure (the mixed-unit arm). */
const REPLAYS_TOKYO: readonly RecordedRound[] = FQ_TOKYO.corpusSlice.map((taskId, index) =>
  index === 4
    ? failedRound(taskId, { inputTokens: 300, outputTokens: 6 }, 540, "content-policy")
    : successRound(taskId, { inputTokens: 300, outputTokens: 50 }, 600),
);

/**
 * Row 4's replays: 8 confirmed rounds with UNEVEN token counts (the
 * ceil-to-batch metering exercise: 300/500/700/1200/450/999/1000/1234
 * input tokens against the 500-token batch).
 */
const REPLAYS_BATCH: readonly RecordedRound[] = FQ_BATCH.corpusSlice.map((taskId, index) =>
  successRound(
    taskId,
    { inputTokens: [300, 500, 700, 1200, 450, 999, 1000, 1234][index] ?? 500, outputTokens: 60 },
    610,
  ),
);

/** Row 5's replays: 5 simple + 3 retry-amortized rounds (rate-limit recovered). */
const REPLAYS_RETRY: readonly RecordedRound[] = FQ_RETRY.corpusSlice.map((taskId, index) =>
  index < 5
    ? successRound(taskId, { inputTokens: 150, outputTokens: 35 }, 600)
    : retriedRound(
        taskId,
        { inputTokens: 150, outputTokens: 10 },
        300,
        { inputTokens: 150, outputTokens: 35 },
        650,
      ),
);

/** Row 6's replays: 5 confirmed + 1 honest failure (within budget). */
const REPLAYS_FC_OPENROUTER: readonly RecordedRound[] = FC_OPENROUTER.corpusSlice.map(
  (taskId, index) =>
    index === 2
      ? failedRound(taskId, { inputTokens: 120, outputTokens: 5 }, 700, "content-policy")
      : successRound(taskId, { inputTokens: 120, outputTokens: 30 }, 820),
);

/**
 * Row 7's replays: the budget-stop row — the first rounds confirm,
 * the third fails honestly; the pinned budget (70 µ$) stops the arm
 * after 3 of the 8 pre-registered rounds (the honest prefix stop).
 */
const REPLAYS_BUDGET_STOP: readonly RecordedRound[] = FC_BUDGET_STOP.corpusSlice.map(
  (taskId, index) =>
    index === 2
      ? failedRound(taskId, { inputTokens: 120, outputTokens: 5 }, 700, "content-policy")
      : successRound(taskId, { inputTokens: 120, outputTokens: 30 }, 820),
);

/** Row 8's replays: every round fails honestly (nothing resolves). */
const REPLAYS_ZERO: readonly RecordedRound[] = FC_ZERO_RESOLVED.corpusSlice.map((taskId) =>
  failedRound(taskId, { inputTokens: 200, outputTokens: 8 }, 650, "content-policy"),
);

// ---------------------------------------------------------------------------
// The offline rows (deterministic — always drivable, zero credentials)
// ---------------------------------------------------------------------------

/** The offline rows (deterministic — always drivable, zero credentials). */
export const OFFLINE_CORPUS_ROWS: readonly EconomicCorpusRow[] = [
  {
    rowId: "fixed-quality-openrouter-usd-metered",
    description:
      "A fixed-quality experiment row: the openrouter arm (USD, per-1M, metered — rev-001) pins resolution ≥ 0.75 over 8 pre-registered rounds and measures the cost to attain it. Every round confirms (120+30 tokens each; the first round carries a planner estimate quote reported SEPARATELY — never conflated); the normalized comparison carries the measured cost-per-resolved and the Wilson 95% interval.",
    arm: FQ_OPENROUTER,
    replay: REPLAYS_OPENROUTER,
    needsDispatch: false,
    expected: {
      terminal: "COMPLETED",
      executions: 1,
      idempotencyRecords: 1,
      appCreated: 1,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
      normalized: expectedNormalizedOutcomeOf(FQ_OPENROUTER, REPLAYS_OPENROUTER),
    },
  },
  {
    rowId: "fixed-quality-euro-relay-eur",
    description:
      "A fixed-quality experiment row over the mixed-currency arm: euro-relay (EUR, per-1M, metered) — 6 of 8 rounds confirm, 2 fail honestly (content policy); the EUR list prices convert through the pinned FX table (1.03 USD/EUR) onto the canonical micro-USD basis; the failed rounds' measured cost stays in the arm's total (amortized over the 6 resolved outcomes).",
    arm: FQ_EURO,
    replay: REPLAYS_EURO,
    needsDispatch: false,
    expected: {
      terminal: "COMPLETED",
      executions: 1,
      idempotencyRecords: 1,
      appCreated: 1,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
      normalized: expectedNormalizedOutcomeOf(FQ_EURO, REPLAYS_EURO),
    },
  },
  {
    rowId: "fixed-quality-tokyo-relay-jpy-per-1k",
    description:
      "A fixed-quality experiment row over the mixed-unit arm: tokyo-relay (JPY, per-1K, metered) — 7 of 8 rounds confirm; the per-1K list prices reduce to the exact per-token basis and the JPY amounts convert through the pinned FX table (6250 µ$/JPY) — a heterogeneous pricing shape that converges onto the SAME canonical basis as the USD arms.",
    arm: FQ_TOKYO,
    replay: REPLAYS_TOKYO,
    needsDispatch: false,
    expected: {
      terminal: "COMPLETED",
      executions: 1,
      idempotencyRecords: 1,
      appCreated: 1,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
      normalized: expectedNormalizedOutcomeOf(FQ_TOKYO, REPLAYS_TOKYO),
    },
  },
  {
    rowId: "fixed-quality-batch-relay-batched",
    description:
      "A fixed-quality experiment row over the batched-metering arm: batch-relay (USD, per-1M, batched @500 tokens) — 8 confirmed rounds with UNEVEN token counts; the metering rounds usage UP to whole 500-token batches before pricing (300→500, 999→1000, 1234→1500 — the ceil-to-batch discipline priced exactly).",
    arm: FQ_BATCH,
    replay: REPLAYS_BATCH,
    needsDispatch: false,
    expected: {
      terminal: "COMPLETED",
      executions: 1,
      idempotencyRecords: 1,
      appCreated: 1,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
      normalized: expectedNormalizedOutcomeOf(FQ_BATCH, REPLAYS_BATCH),
    },
  },
  {
    rowId: "fixed-quality-retry-amortization",
    description:
      "A fixed-quality experiment row over the retry-amortization arm: retry-relay (USD, per-1M, metered) — 3 of the 8 rounds recover a rate-limited first attempt through the bounded retry (the failed attempt's tokens are measured retry-overhead facts of the SAME run); all 8 rounds confirm, and the cost-per-resolved AMORTIZES the retry overhead (the resolved outcome's cost includes its retries).",
    arm: FQ_RETRY,
    replay: REPLAYS_RETRY,
    needsDispatch: false,
    expected: {
      terminal: "COMPLETED",
      executions: 1,
      idempotencyRecords: 1,
      appCreated: 1,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
      normalized: expectedNormalizedOutcomeOf(FQ_RETRY, REPLAYS_RETRY),
    },
  },
  {
    rowId: "fixed-cost-openrouter-within-budget",
    description:
      "A fixed-cost experiment row: the openrouter arm pins a 400 µ$ budget (64-token completion budget per round) and measures the quality attained within it — 6 pre-registered rounds all dispatch (the measured total 125 µ$ respects the budget with headroom), 5 confirm and 1 fails honestly; the quality-attained (5/6) and the measured cost-per-resolved carry the Wilson interval.",
    arm: FC_OPENROUTER,
    replay: REPLAYS_FC_OPENROUTER,
    needsDispatch: false,
    expected: {
      terminal: "COMPLETED",
      executions: 1,
      idempotencyRecords: 1,
      appCreated: 1,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
      normalized: expectedNormalizedOutcomeOf(FC_OPENROUTER, REPLAYS_FC_OPENROUTER),
    },
  },
  {
    rowId: "fixed-cost-budget-exhausted-honest-stop",
    description:
      "A fixed-cost experiment row exercising the honest budget stop: the arm pins 70 µ$ — the per-round bound (24 µ$, priced from the pinned manifest BEFORE dispatch) stops the arm after 3 of the 8 pre-registered rounds (the declared PREFIX stop, never a post-hoc exclusion); the executed prefix holds 2 resolved + 1 honest failure, the measured total respects the budget, and the slice conformance is the prefix shape.",
    arm: FC_BUDGET_STOP,
    replay: REPLAYS_BUDGET_STOP,
    needsDispatch: false,
    expected: {
      terminal: "COMPLETED",
      executions: 1,
      idempotencyRecords: 1,
      appCreated: 1,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
      normalized: expectedNormalizedOutcomeOf(FC_BUDGET_STOP, REPLAYS_BUDGET_STOP.slice(0, 3)),
    },
  },
  {
    rowId: "zero-resolved-null-cost-per-resolved",
    description:
      "A fixed-cost experiment row pinning the VAL-006 NULL discipline: every round fails honestly (content policy) — NOTHING resolves, so the cost per successfully resolved outcome is NULL (never zero, never estimate-backed) while the measured cost of the failed rounds is still recorded and the Wilson interval [0, high] is carried honestly on the comparison.",
    arm: FC_ZERO_RESOLVED,
    replay: REPLAYS_ZERO,
    needsDispatch: false,
    expected: {
      terminal: "COMPLETED",
      executions: 1,
      idempotencyRecords: 1,
      appCreated: 1,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
      normalized: expectedNormalizedOutcomeOf(FC_ZERO_RESOLVED, REPLAYS_ZERO),
    },
  },
];

// ---------------------------------------------------------------------------
// The live rows (env-gated on the authorized rail; REAL model dispatch)
// ---------------------------------------------------------------------------

/** The live rows (env-gated on the authorized rail; REAL model dispatch). */
export const LIVE_CORPUS_ROWS: readonly EconomicCorpusRow[] = [
  {
    rowId: "live-fixed-quality-openrouter-real-dispatch",
    description:
      "A REAL fixed-quality experiment (env-gated): the openrouter arm pins resolution ≥ 0.5 over 4 pre-registered rounds, each driven by a REAL model dispatch through the REAL platform model gateway (BYOK; measured usage, 64-token completion budget). The threshold attainment is recomputed from the REAL verdicts; the normalized comparison carries the measured cost-per-resolved and the Wilson interval over the live sample.",
    arm: FQ_OPENROUTER_LIVE,
    needsDispatch: true,
    liveGate: {
      envVars: ["OPENROUTER_API_KEY"],
      requirement:
        "operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) covering the pinned chat model meta-llama/llama-3.3-70b-instruct — the REAL fixed-quality experiment demands REAL model dispatches",
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
    rowId: "live-fixed-cost-openrouter-real-budget",
    description:
      "A REAL fixed-cost experiment (env-gated): the openrouter arm pins a 600 µ$ budget (64-token completion budget per round) and measures the quality attained within it over 4 REAL dispatches — the budget gate decides BEFORE each dispatch (the pinned per-round bound priced from the manifest), the usage is measured, and the quality-attained carries the Wilson interval.",
    arm: FC_OPENROUTER_LIVE,
    needsDispatch: true,
    liveGate: {
      envVars: ["OPENROUTER_API_KEY"],
      requirement:
        "operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) covering the pinned chat model meta-llama/llama-3.3-70b-instruct — the REAL fixed-cost experiment demands REAL model dispatches",
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
export const ECONOMIC_CORPUS: readonly EconomicCorpusRow[] = [
  ...OFFLINE_CORPUS_ROWS,
  ...LIVE_CORPUS_ROWS,
];

/** Whether every env var of the row's live gate is present. */
export function liveGateOpen(row: EconomicCorpusRow, env: NodeJS.ProcessEnv): boolean {
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
  return `val-040-app-${options.runSuffix}-${options.taskIndex}`;
}

/**
 * The app's task body for one row's submission: REFERENCES ONLY —
 * the row, the arm identity, the arm kind, the pinned price revision
 * and the slice/minimum shape. Never a price, never a token price,
 * never a budget number beyond the pinned budget reference (the
 * platform resolves pricing through the manifest).
 */
export function taskBodyFor(options: { readonly row: EconomicCorpusRow }): Record<string, unknown> {
  const { row } = options;
  return {
    kind: ECONOMIC_TASK_KIND,
    rowId: row.rowId,
    armId: row.arm.armId,
    armKind: row.arm.kind,
    priceRevision: row.arm.priceRevision,
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
export const ECONOMIC_ROW_IDS: readonly string[] = ECONOMIC_CORPUS.map((row) => row.rowId);

/** Look up one corpus row by id (the config task slice references rows by id). */
export function economicRowById(rowId: string): EconomicCorpusRow | null {
  return ECONOMIC_CORPUS.find((row) => row.rowId === rowId) ?? null;
}
