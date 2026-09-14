/**
 * The economic-controls-direct corpus (VAL-041, AC1): the declared
 * rows of the DIRECT-PROVIDER control experiment — the frozen
 * VAL-030 app portfolio replayed with providers called DIRECTLY (no
 * Zeck agent platform, no gateway middle layer, no reuse/cache
 * shortcut). Per row: the ARM MANIFEST ENTRY (the direct-provider
 * kind — a `direct:` integration surface over ONE pinned provider
 * rail — the pinned price revision from the VAL-040 PRICE_MANIFEST,
 * the fixed-quality or fixed-cost arm per the frozen protocol, the
 * pre-registered corpus slice, the statistical minimums), the FROZEN
 * PORTFOLIO reference (VAL-030 baseline revisions, by content digest
 * — never copied) and the EXPECTED NORMALIZED OUTCOME the protocol
 * derivation must reproduce (the run/resolved counts and the canonical
 * micro-USD economics derived through the REAL accounting
 * derivations over the recorded control traces + the pinned
 * manifest).
 *
 * The offline rows are deterministically reproducible (the recorded
 * control traces + the pinned manifest — zero credentials, zero
 * network): seven honest control rows PLUS the five adversarial
 * PROBE rows whose recorded shapes denature the direct path (the
 * platform-shortcut masquerade, the mixed-currency conflation, the
 * estimate-backed cost, the post-hoc arm exclusion, the sample-size
 * violation) — each probe's expected terminal is honestly FAILED
 * with its specific criterion named. The live rows are env-gated on
 * the operator-authorized OpenRouter rail and demand REAL direct
 * requests.
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
import type { DirectCorpusRow, DirectTraceRound } from "./driver";
import { deriveDirectRoundBudgetBoundMicroUsd } from "./driver";

/** The task kind every row's submission carries (the app's task vocabulary). */
export const DIRECT_TASK_KIND = "economic-controls-direct.experiment.v1";

/** The corpus version the evaluations carry. */
export const DIRECT_CORPUS_VERSION = "val-041-direct-controls-v1";

/** The live rail's pinned model (the manifest's openrouter entry — priced as declared). */
export const LIVE_RAIL_MODEL = "meta-llama/llama-3.3-70b-instruct";

// ---------------------------------------------------------------------------
// The golden tasks of the arms' pre-registered slices
// ---------------------------------------------------------------------------

/**
 * The golden tasks of one arm's pre-registered slice (deterministic
 * derivation from the slice identities): compact confirmation tasks
 * whose deterministic oracles (terminal COMPLETED + the response
 * containing "confirm") are exactly what the recorded control traces
 * and the live confirmation rounds settle.
 */
export function directTasksForArm(arm: EconomicArm): readonly GoldenTask[] {
  const scenarioId = arm.corpusSlice[0]?.split("#")[0] ?? `val-041-direct-${arm.armId}`;
  return arm.corpusSlice.map((taskId) => {
    const index = Number.parseInt(taskId.split("#")[1] ?? "0", 10);
    return {
      taskId,
      family: "text" as const,
      scenarioId,
      description: `Direct-provider control round ${index}: confirm the settlement round of the ${arm.armId} arm so the round's quality verdict and measured usage feed the normalized cost-per-resolved accounting.`,
      input: {
        instruction: `Confirm settlement round ${index} of the direct-provider control experiment.`,
        arm: arm.armId,
        round: index,
      },
      environmentState: {
        fixtures: [],
        description: "the economics lab's controlled direct-round world (no environment fixtures)",
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
            "the round must not exceed the arm's pinned economics (budget or slice) nor ride any platform shortcut",
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
function frozenPortfolioOf(appId: string): DirectCorpusRow["frozenPortfolio"] {
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

/** The rail's declared currency for the arm's pinned provider/model (the manifest's own). */
function railCurrencyOf(row: DirectCorpusRow): "USD" | "EUR" | "JPY" | "GBP" {
  const manifest = manifestFor(row.arm.priceRevision);
  const entry = resolveListPrice(manifest, row.arm.provider, row.arm.model, "input");
  if (entry === null) {
    throw new Error(`no pinned list-price entry for ${row.arm.provider}/${row.arm.model}`);
  }
  return entry.currency;
}

/**
 * Derive the expected normalized outcome of one row's recorded
 * control traces (PURE — the REAL derivations over the declared
 * fixtures + the pinned manifest + the fixed-cost budget-gate
 * simulation): the run/resolved counts, the measured and estimated
 * micro-USD totals, the canonical cost-per-resolved (NULL when
 * nothing resolves; REFUSED when estimate-backed) and the Wilson 95%
 * interval — exactly what the protocol derivation must reproduce at
 * run time.
 */
export function expectedDirectOutcomeOf(row: DirectCorpusRow): {
  runCount: number;
  resolvedCount: number;
  measuredCostMicroUsd: string;
  estimatedCostMicroUsd: string;
  costPerResolvedMicroUsd: string | null;
  resolutionConfidence: { low: number; high: number };
} {
  const manifest = manifestFor(row.arm.priceRevision);
  const tasks = directTasksForArm(row.arm);
  const usageFacts: UsageFact[] = [];
  let resolved = 0;
  let executed = 0;
  let measuredSoFar = 0n;
  const roundBoundMicroUsd =
    row.arm.kind === "fixed-cost"
      ? BigInt(deriveDirectRoundBudgetBoundMicroUsd({ manifest, arm: row.arm }))
      : null;
  const budgetMicroUsd =
    row.arm.kind === "fixed-cost" ? BigInt(row.arm.pinnedBudgetMicroUsd) : null;
  const railCurrency = railCurrencyOf(row);
  for (const taskId of row.arm.corpusSlice) {
    // The fixed-cost budget gate — BEFORE the request (the declared
    // prefix stop).
    if (roundBoundMicroUsd !== null && budgetMicroUsd !== null) {
      if (budgetMicroUsd - measuredSoFar < roundBoundMicroUsd) {
        break;
      }
    }
    const plan = row.directReplay.find((candidate) => candidate.taskId === taskId);
    const recorded = plan?.recorded;
    if (recorded === undefined || recorded.postHocExcluded === true) {
      // A skipped round (the sample-starved / post-hoc-exclusion
      // shapes): not executed, not resolved, no facts.
      continue;
    }
    const roundFacts: UsageFact[] = [];
    const attempts = recorded.attempts;
    for (const [index, attempt] of attempts.entries()) {
      const isFinal = index === attempts.length - 1;
      if (attempt.usage === undefined || recorded.estimateOnly === true) {
        continue;
      }
      roundFacts.push({
        provider: row.arm.provider,
        model: row.arm.model,
        tier: "input",
        currency: recorded.usageCurrency ?? railCurrency,
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
        currency: recorded.usageCurrency ?? railCurrency,
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
          currency: railCurrency,
          tokens: quote.inputTokens,
          kind: "estimate",
          scope: "direct-execution",
        });
        roundFacts.push({
          provider: row.arm.provider,
          model: row.arm.model,
          tier: "output",
          currency: railCurrency,
          tokens: quote.outputTokens,
          kind: "estimate",
          scope: "direct-execution",
        });
      }
    }
    usageFacts.push(...roundFacts);
    measuredSoFar += BigInt(normalizeArmCosts(roundFacts, manifest).measuredMicroUsd);
    executed += 1;
    const task = tasks.find((candidate) => candidate.taskId === taskId);
    if (task === undefined) {
      continue;
    }
    const final = attempts[attempts.length - 1];
    const observed: ObservedOutcome =
      final !== undefined && final.outcome === "success"
        ? {
            terminalStatus: "COMPLETED",
            verificationStatuses: ["PASS"],
            responseText: recorded.responseText ?? "confirm",
            outputShapeFields: [],
            environmentEffects: [],
            retryableErrorsSurfaced: 0,
          }
        : {
            terminalStatus: "FAILED",
            verificationStatuses: [],
            responseText: null,
            outputShapeFields: [],
            environmentEffects: [],
            retryableErrorsSurfaced: 0,
          };
    const evaluation = evaluateRun({
      task,
      corpusVersion: DIRECT_CORPUS_VERSION,
      observed,
    });
    const latencyMs = attempts.reduce((sum, attempt) => sum + attempt.latencyMs, 0);
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
  armId: "fq-direct-default",
  kind: "fixed-quality",
  integrationSurface: "direct:openrouter",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-041-direct-default", 8),
  minimumSamples: 8,
  pinnedThreshold: { resolutionRate: 0.75 },
};

const FQ_EURO: FixedQualityArm = {
  armId: "fq-direct-eur",
  kind: "fixed-quality",
  integrationSurface: "direct:euro-relay",
  provider: "euro-relay",
  model: "euro-small-v1",
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-041-direct-eur", 6),
  minimumSamples: 6,
  pinnedThreshold: { resolutionRate: 0.75 },
};

const FQ_TOKYO: FixedQualityArm = {
  armId: "fq-direct-jpy",
  kind: "fixed-quality",
  integrationSurface: "direct:tokyo-relay",
  provider: "tokyo-relay",
  model: "tokyo-mini-v1",
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-041-direct-jpy", 6),
  minimumSamples: 6,
  pinnedThreshold: { resolutionRate: 0.75 },
};

const FQ_REV2: FixedQualityArm = {
  armId: "fq-direct-rev2",
  kind: "fixed-quality",
  integrationSurface: "direct:openrouter",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-002",
  corpusSlice: sliceOf("val-041-direct-rev2", 6),
  minimumSamples: 6,
  pinnedThreshold: { resolutionRate: 0.75 },
};

const FC_DEFAULT: FixedCostArm = {
  armId: "fc-direct-default",
  kind: "fixed-cost",
  integrationSurface: "direct:openrouter",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-041-direct-fc", 6),
  minimumSamples: 6,
  pinnedBudgetMicroUsd: "400",
  maxTokensPerRound: 64,
};

const FC_STOP: FixedCostArm = {
  armId: "fc-direct-stop",
  kind: "fixed-cost",
  integrationSurface: "direct:openrouter",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-041-direct-stop", 8),
  minimumSamples: 3,
  pinnedBudgetMicroUsd: "70",
  maxTokensPerRound: 64,
};

const FC_ZERO: FixedCostArm = {
  armId: "fc-direct-zero",
  kind: "fixed-cost",
  integrationSurface: "direct:openrouter",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-041-direct-zero", 6),
  minimumSamples: 6,
  pinnedBudgetMicroUsd: "1200",
  maxTokensPerRound: 96,
};

const PROBE_SHORTCUT: FixedQualityArm = {
  armId: "fq-direct-probe-shortcut",
  kind: "fixed-quality",
  integrationSurface: "direct:openrouter",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-041-direct-probe-shortcut", 6),
  minimumSamples: 6,
  pinnedThreshold: { resolutionRate: 0.75 },
};

const PROBE_MIXED: FixedQualityArm = {
  armId: "fq-direct-probe-mixed",
  kind: "fixed-quality",
  integrationSurface: "direct:openrouter",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-041-direct-probe-mixed", 6),
  minimumSamples: 6,
  pinnedThreshold: { resolutionRate: 0.75 },
};

const PROBE_ESTIMATE: FixedQualityArm = {
  armId: "fq-direct-probe-estimate",
  kind: "fixed-quality",
  integrationSurface: "direct:openrouter",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-041-direct-probe-estimate", 6),
  minimumSamples: 6,
  pinnedThreshold: { resolutionRate: 0.75 },
};

const PROBE_EXCLUSION: FixedQualityArm = {
  armId: "fq-direct-probe-exclusion",
  kind: "fixed-quality",
  integrationSurface: "direct:openrouter",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-041-direct-probe-exclusion", 6),
  minimumSamples: 6,
  pinnedThreshold: { resolutionRate: 0.75 },
};

const PROBE_STARVED: FixedQualityArm = {
  armId: "fq-direct-probe-starved",
  kind: "fixed-quality",
  integrationSurface: "direct:openrouter",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-041-direct-probe-starved", 8),
  minimumSamples: 8,
  pinnedThreshold: { resolutionRate: 0.75 },
};

const FQ_LIVE: FixedQualityArm = {
  armId: "fq-direct-live",
  kind: "fixed-quality",
  integrationSurface: "direct:openrouter",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-041-direct-live", 4),
  minimumSamples: 3,
  pinnedThreshold: { resolutionRate: 0.5 },
};

const FC_LIVE: FixedCostArm = {
  armId: "fc-direct-live",
  kind: "fixed-cost",
  integrationSurface: "direct:openrouter",
  provider: "openrouter",
  model: LIVE_RAIL_MODEL,
  priceRevision: "rev-001",
  corpusSlice: sliceOf("val-041-direct-livefc", 4),
  minimumSamples: 3,
  pinnedBudgetMicroUsd: "600",
  maxTokensPerRound: 64,
};

// ---------------------------------------------------------------------------
// The trace plans (the recorded direct-rail control facts)
// ---------------------------------------------------------------------------

/** One recorded successful direct attempt. */
function ok(usage: { inputTokens: number; outputTokens: number }, latencyMs: number) {
  return { outcome: "success" as const, usage, latencyMs };
}

/** One recorded failed direct attempt. */
function fail(
  category: string,
  usage: { inputTokens: number; outputTokens: number },
  latencyMs: number,
) {
  return { outcome: "failure" as const, usage, category, latencyMs };
}

/**
 * The row-1 plans: 8 direct requests to the pinned openrouter rail
 * (USD per-1M metered — rev-001). Seven settle on the first attempt
 * (120 in / 30 out each; the first carries a provider-side quote
 * reported SEPARATELY — never conflated); the eighth exhausts ONE
 * client-side bounded retry (the rate-limited first attempt is the
 * row's own retry-overhead fact — the DIRECT granularity: per
 * attempt, never amortized inside a gateway boundary) before the
 * second attempt settles it.
 */
const TRACES_DEFAULT: readonly DirectTraceRound[] = [
  {
    taskId: FQ_DEFAULT.corpusSlice[0] as string,
    recorded: {
      attempts: [ok({ inputTokens: 120, outputTokens: 30 }, 820)],
      reportedChargeUsd: 0.0000219,
      responseText: "confirm",
      estimateQuote: { inputTokens: 100, outputTokens: 20 },
    },
  },
  ...FQ_DEFAULT.corpusSlice.slice(1, 7).map((taskId) => ({
    taskId,
    recorded: {
      attempts: [ok({ inputTokens: 120, outputTokens: 30 }, 810)],
      reportedChargeUsd: 0.0000219,
      responseText: "confirm",
    },
  })),
  {
    taskId: FQ_DEFAULT.corpusSlice[7] as string,
    recorded: {
      attempts: [
        fail("rate-limit", { inputTokens: 120, outputTokens: 10 }, 300),
        ok({ inputTokens: 120, outputTokens: 30 }, 650),
      ],
      reportedChargeUsd: 0.0000304,
      responseText: "confirm",
    },
  },
];

/**
 * The row-2 plans: the direct EU rail (euro-relay/euro-small-v1, EUR
 * per-1M metered) — 5 of 6 requests confirm; the fourth fails
 * honestly at the provider boundary (content policy). The EUR list
 * prices convert through the pinned FX table onto the canonical
 * micro-USD basis, and the provider's OWN USD charge observation
 * rides as the cross-check (never the basis).
 */
const TRACES_EURO: readonly DirectTraceRound[] = FQ_EURO.corpusSlice.map((taskId, index) => ({
  taskId,
  recorded:
    index === 3
      ? {
          attempts: [fail("content-policy", { inputTokens: 200, outputTokens: 8 }, 640)],
          reportedChargeUsd: 0.0000912,
        }
      : {
          attempts: [ok({ inputTokens: 200, outputTokens: 40 }, 700)],
          reportedChargeUsd: 0.00131,
          responseText: "confirm",
        },
}));

/**
 * The row-3 plans: the direct JP rail (tokyo-relay/tokyo-mini-v1, JPY
 * per-1K metered) — 6 requests confirm, the third exhausting ONE
 * client-side bounded retry (the rate-limited first attempt is the
 * row's own retry-overhead fact). The per-1K JPY list prices convert
 * through the pinned FX table onto the canonical micro-USD basis.
 */
const TRACES_TOKYO: readonly DirectTraceRound[] = FQ_TOKYO.corpusSlice.map((taskId, index) => ({
  taskId,
  recorded:
    index === 2
      ? {
          attempts: [
            fail("rate-limit", { inputTokens: 250, outputTokens: 12 }, 310),
            ok({ inputTokens: 250, outputTokens: 60 }, 660),
          ],
          reportedChargeUsd: 0.0000445,
          responseText: "confirm",
        }
      : {
          attempts: [ok({ inputTokens: 250, outputTokens: 60 }, 690)],
          reportedChargeUsd: 0.0000335,
          responseText: "confirm",
        },
}));

/**
 * The row-4 plans: the corrected-price row over rev-002 (the pinned
 * snapshot's corrected openrouter input price) — 6 plain confirmations
 * priced through the NEW revision (rev-001 stays readable and frozen;
 * the arm declares WHICH revision priced the runs).
 */
const TRACES_REV2: readonly DirectTraceRound[] = FQ_REV2.corpusSlice.map((taskId) => ({
  taskId,
  recorded: {
    attempts: [ok({ inputTokens: 120, outputTokens: 30 }, 800)],
    reportedChargeUsd: 0.0000219,
    responseText: "confirm",
  },
}));

/**
 * The row-5 plans: 5 confirmations + 1 honest content-policy refusal
 * at the provider boundary (within the 400 µ$ budget; the per-round
 * bound 24 µ$ covers every request).
 */
const TRACES_FC: readonly DirectTraceRound[] = FC_DEFAULT.corpusSlice.map((taskId, index) => ({
  taskId,
  recorded:
    index === 2
      ? {
          attempts: [fail("content-policy", { inputTokens: 120, outputTokens: 5 }, 700)],
          reportedChargeUsd: 0.0000147,
        }
      : {
          attempts: [ok({ inputTokens: 120, outputTokens: 30 }, 820)],
          reportedChargeUsd: 0.0000219,
          responseText: "confirm",
        },
}));

/**
 * The row-6 plans: the honest budget-stop row — the first requests
 * confirm, the third fails honestly; the pinned budget (70 µ$) stops
 * the arm after 3 of the 8 pre-registered rounds (the per-round
 * bound 24 µ$ decided BEFORE dispatch; the declared prefix stop).
 */
const TRACES_STOP: readonly DirectTraceRound[] = FC_STOP.corpusSlice.map((taskId, index) => ({
  taskId,
  recorded:
    index === 2
      ? {
          attempts: [fail("content-policy", { inputTokens: 120, outputTokens: 5 }, 700)],
          reportedChargeUsd: 0.0000147,
        }
      : {
          attempts: [ok({ inputTokens: 120, outputTokens: 30 }, 820)],
          reportedChargeUsd: 0.0000219,
          responseText: "confirm",
        },
}));

/** The row-7 plans: every request fails honestly (nothing resolves). */
const TRACES_ZERO: readonly DirectTraceRound[] = FC_ZERO.corpusSlice.map((taskId) => ({
  taskId,
  recorded: {
    attempts: [fail("content-policy", { inputTokens: 200, outputTokens: 8 }, 650)],
    reportedChargeUsd: 0.0000248,
  },
}));

/**
 * The probe-1 plans: the PLATFORM-SHORTCUT MASQUERADE — the third
 * request's recorded dispatch observed platform/gateway artifacts
 * (a reuse/cache shortcut signature + a platform mediation marker):
 * the dispatch did NOT ride the direct path, and the arm-conformance
 * oracle FAILs it mechanically with the artifacts named.
 */
const TRACES_PROBE_SHORTCUT: readonly DirectTraceRound[] = PROBE_SHORTCUT.corpusSlice.map(
  (taskId, index) => ({
    taskId,
    recorded:
      index === 2
        ? {
            attempts: [ok({ inputTokens: 120, outputTokens: 30 }, 640)],
            reportedChargeUsd: 0.0000219,
            responseText: "confirm",
            platformArtifacts: [
              "reuse-cache-signature:zeck-reuse-layer",
              "platform-mediation-marker:agent-gateway",
            ],
          }
        : {
            attempts: [ok({ inputTokens: 120, outputTokens: 30 }, 810)],
            reportedChargeUsd: 0.0000219,
            responseText: "confirm",
          },
  }),
);

/**
 * The probe-2 plans: the MIXED-CURRENCY CONFLATION — every request's
 * recorded usage is denominated in GBP while the pinned rail's price
 * is USD (and GBP sits outside the pinned FX table): every usage fact
 * FAILs to normalize onto the canonical micro-USD basis.
 */
const TRACES_PROBE_MIXED: readonly DirectTraceRound[] = PROBE_MIXED.corpusSlice.map((taskId) => ({
  taskId,
  recorded: {
    attempts: [ok({ inputTokens: 120, outputTokens: 30 }, 810)],
    usageCurrency: "GBP",
    reportedChargeUsd: 0.0000219,
    responseText: "confirm",
  },
}));

/**
 * The probe-3 plans: the ESTIMATE-BACKED COST — every request reports
 * ONLY a provider-side quote (no measured usage) while the rounds
 * resolve: the cost-per-resolved is REFUSED mechanically (estimates
 * are never conflated into the canonical basis).
 */
const TRACES_PROBE_ESTIMATE: readonly DirectTraceRound[] = PROBE_ESTIMATE.corpusSlice.map(
  (taskId) => ({
    taskId,
    recorded: {
      attempts: [ok({ inputTokens: 100, outputTokens: 20 }, 810)],
      estimateOnly: true,
      estimateQuote: { inputTokens: 100, outputTokens: 20 },
      responseText: "confirm",
    },
  }),
);

/**
 * The probe-4 plans: the POST-HOC ARM EXCLUSION — the sixth request
 * fails honestly at the provider boundary and the executor REFUSES
 * (skips) the failed round: the executed slice drops the non-resolved
 * task and the sample-discipline oracle FAILs the exclusion by name.
 */
const TRACES_PROBE_EXCLUSION: readonly DirectTraceRound[] = PROBE_EXCLUSION.corpusSlice.map(
  (taskId, index) => ({
    taskId,
    recorded:
      index === 5
        ? {
            attempts: [fail("content-policy", { inputTokens: 120, outputTokens: 5 }, 700)],
            reportedChargeUsd: 0.0000147,
            postHocExcluded: true,
          }
        : {
            attempts: [ok({ inputTokens: 120, outputTokens: 30 }, 820)],
            reportedChargeUsd: 0.0000219,
            responseText: "confirm",
          },
  }),
);

/**
 * The probe-5 plans: the SAMPLE-SIZE VIOLATION — the slice
 * pre-registers 8 rounds with a minimum of 8, but the trace holds
 * recorded plans for only the FIRST 5 (the executor honestly skips
 * the unrecorded tail): the executed sample is starved below the
 * pre-registered minimum and the sample-discipline oracle FAILs it.
 */
const TRACES_PROBE_STARVED: readonly DirectTraceRound[] = PROBE_STARVED.corpusSlice
  .slice(0, 5)
  .map((taskId) => ({
    taskId,
    recorded: {
      attempts: [ok({ inputTokens: 120, outputTokens: 30 }, 820)],
      reportedChargeUsd: 0.0000219,
      responseText: "confirm",
    },
  }));

/** The live row-1 plans: REAL direct requests to the pinned openrouter rail. */
const TRACES_LIVE_FQ: readonly DirectTraceRound[] = FQ_LIVE.corpusSlice.map((taskId) => ({
  taskId,
}));

/** The live row-2 plans: REAL direct requests under the pinned budget. */
const TRACES_LIVE_FC: readonly DirectTraceRound[] = FC_LIVE.corpusSlice.map((taskId) => ({
  taskId,
}));

// ---------------------------------------------------------------------------
// The row builders (the oracle's derivation)
// ---------------------------------------------------------------------------

/**
 * Build one offline corpus row with its PINNED expected normalized
 * outcome: the REAL derivations (the recorded control traces' per-
 * attempt usage + the pinned manifest + the REAL evaluation and
 * resolution thresholds + the Wilson interval) run over the declared
 * fixtures at module load — exactly what the driver's own accounting
 * must reproduce at run time.
 */
function directRow(input: {
  readonly rowId: string;
  readonly description: string;
  readonly arm: EconomicArm;
  readonly directReplay: readonly DirectTraceRound[];
  readonly frozenPortfolio: DirectCorpusRow["frozenPortfolio"];
  readonly terminal?: "COMPLETED" | "FAILED";
}): DirectCorpusRow {
  const row: DirectCorpusRow = {
    rowId: input.rowId,
    description: input.description,
    arm: input.arm,
    directReplay: input.directReplay,
    frozenPortfolio: input.frozenPortfolio,
    needsDispatch: false,
    expected: {
      terminal: input.terminal ?? "COMPLETED",
      executions: 1,
      idempotencyRecords: 1,
      appCreated: 1,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
    },
  };
  return { ...row, expected: { ...row.expected, normalized: expectedDirectOutcomeOf(row) } };
}

// ---------------------------------------------------------------------------
// The offline rows (deterministic — always drivable, zero credentials)
// ---------------------------------------------------------------------------

/** The honest offline control rows (deterministic, zero credentials). */
export const OFFLINE_CONTROL_ROWS: readonly DirectCorpusRow[] = [
  directRow({
    rowId: "fixed-quality-direct-default-rail",
    description:
      "The headline direct fixed-quality row: 8 pre-registered requests issued DIRECTLY to the pinned openrouter rail (llama-3.3-70b, USD per-1M metered — rev-001). Seven settle on the first attempt (120+30 tokens each; the first carries a provider-side quote reported SEPARATELY — never conflated); the eighth exhausts ONE client-side bounded retry — the rate-limited first attempt's own usage (120+10) is the row's retry-overhead fact, the DIRECT granularity (per attempt, never amortized inside a gateway boundary). Threshold ≥ 0.75 over the full slice; the normalized comparison carries the measured cost-per-resolved and the Wilson 95% interval.",
    arm: FQ_DEFAULT,
    directReplay: TRACES_DEFAULT,
    frozenPortfolio: frozenPortfolioOf("portfolio:text-generation"),
  }),
  directRow({
    rowId: "fixed-quality-direct-euro-rail",
    description:
      "The direct EU-rail row: providers called directly on the EU-priced rail (euro-relay/euro-small-v1, EUR per-1M metered) — 5 of 6 requests confirm, the fourth fails honestly at the provider boundary (content policy); the EUR list prices convert through the pinned FX table onto the canonical micro-USD basis, and the provider's OWN USD charge observation rides as a cross-check (never the basis — every arm compares at the SAME pinned list prices).",
    arm: FQ_EURO,
    directReplay: TRACES_EURO,
    frozenPortfolio: frozenPortfolioOf("portfolio:rag"),
  }),
  directRow({
    rowId: "fixed-quality-direct-tokyo-rail",
    description:
      "The direct JP-rail row: the pinned JP rail (tokyo-relay/tokyo-mini-v1, JPY per-1K metered) — 6 requests confirm, the third exhausting ONE client-side bounded retry (the failed attempt's own usage is the row's retry-overhead fact). The per-1K JPY list prices convert through the pinned FX table onto the canonical micro-USD basis — the heterogeneous unit shapes converge onto the SAME canonical basis.",
    arm: FQ_TOKYO,
    directReplay: TRACES_TOKYO,
    frozenPortfolio: frozenPortfolioOf("portfolio:operations"),
  }),
  directRow({
    rowId: "fixed-quality-direct-corrected-price",
    description:
      "The corrected-price row over rev-002 (the pinned snapshot's corrected openrouter input price — a correction is a NEW revision; rev-001 stays readable and frozen): 6 plain confirmations priced through the declared revision. The arm declares WHICH revision priced the runs; the manifest oracle verifies the pinned revision's integrity mechanically.",
    arm: FQ_REV2,
    directReplay: TRACES_REV2,
    frozenPortfolio: frozenPortfolioOf("portfolio:coding"),
  }),
  directRow({
    rowId: "fixed-cost-direct-within-budget",
    description:
      "The direct fixed-cost row: the arm pins a 400 µ$ budget (64-token completion budget per request — pinned explicitly, the 402 lesson) and measures the quality attained within it — 6 pre-registered requests all dispatch (the per-round bound 24 µ$ covers every request; the measured total respects the budget with headroom), 5 confirm and 1 fails honestly (the provider's content-policy refusal); the quality-attained (5/6) and the measured cost-per-resolved carry the Wilson interval.",
    arm: FC_DEFAULT,
    directReplay: TRACES_FC,
    frozenPortfolio: frozenPortfolioOf("portfolio:tool-agent"),
  }),
  directRow({
    rowId: "fixed-cost-direct-budget-exhausted-honest-stop",
    description:
      "The honest budget-stop row: the arm pins 70 µ$ over 8 requests — the per-round bound (24 µ$) stops the arm after 3 of the 8 pre-registered rounds (the declared PREFIX stop, never a post-hoc exclusion); the executed prefix holds 2 resolved + 1 honest failure, the measured total respects the budget, and the slice conformance is the prefix shape.",
    arm: FC_STOP,
    directReplay: TRACES_STOP,
    frozenPortfolio: frozenPortfolioOf("portfolio:operations"),
  }),
  directRow({
    rowId: "zero-resolved-direct-null-discipline",
    description:
      "The NULL-discipline row: every request fails honestly at the provider boundary (content policy) — NOTHING resolves, so the cost per successfully resolved outcome is NULL (never zero, never estimate-backed) while the measured cost of the failed requests is still recorded and the Wilson interval [0, high] is carried honestly on the comparison.",
    arm: FC_ZERO,
    directReplay: TRACES_ZERO,
    frozenPortfolio: frozenPortfolioOf("portfolio:research"),
  }),
];

/** The adversarial probe rows (each FAILs its named criterion honestly). */
export const PROBE_ROWS: readonly DirectCorpusRow[] = [
  directRow({
    rowId: "probe-platform-shortcut-masquerade",
    description:
      "The platform-shortcut masquerade probe: the third request's recorded dispatch observed platform/gateway artifacts (a reuse/cache shortcut signature + a platform mediation marker) — the dispatch did NOT ride the direct path. The arm-conformance oracle FAILs it MECHANICALLY with the artifacts named (a shortcut-riding row fails; the control's verification core).",
    arm: PROBE_SHORTCUT,
    directReplay: TRACES_PROBE_SHORTCUT,
    frozenPortfolio: frozenPortfolioOf("portfolio:text-generation"),
    terminal: "FAILED",
  }),
  directRow({
    rowId: "probe-mixed-currency-conflation",
    description:
      "The mixed-currency conflation probe: every request's recorded usage is denominated in GBP while the pinned rail's price is USD (and GBP sits outside the pinned FX table) — every usage fact FAILs to normalize onto the canonical micro-USD basis; the normalization oracle FAILs with the reason named.",
    arm: PROBE_MIXED,
    directReplay: TRACES_PROBE_MIXED,
    frozenPortfolio: frozenPortfolioOf("portfolio:rag"),
    terminal: "FAILED",
  }),
  directRow({
    rowId: "probe-estimate-backed-cost",
    description:
      "The estimate-backed cost probe: every request reports ONLY a provider-side quote (no measured usage) while the rounds resolve — the cost-per-resolved is REFUSED mechanically (estimates are never conflated into the canonical basis); the cost-basis oracle FAILs it by name.",
    arm: PROBE_ESTIMATE,
    directReplay: TRACES_PROBE_ESTIMATE,
    frozenPortfolio: frozenPortfolioOf("portfolio:coding"),
    terminal: "FAILED",
  }),
  directRow({
    rowId: "probe-post-hoc-arm-exclusion",
    description:
      "The post-hoc arm exclusion probe: the sixth request fails honestly at the provider boundary and the executor REFUSES (skips) the failed round — the executed slice drops the non-resolved task; the sample-discipline oracle FAILs the exclusion by name (an honest failure is a data point, never an exclusion).",
    arm: PROBE_EXCLUSION,
    directReplay: TRACES_PROBE_EXCLUSION,
    frozenPortfolio: frozenPortfolioOf("portfolio:tool-agent"),
    terminal: "FAILED",
  }),
  directRow({
    rowId: "probe-sample-size-violation",
    description:
      "The sample-size violation probe: the slice pre-registers 8 rounds with a minimum of 8, but the trace holds recorded plans for only the FIRST 5 — the executed sample is starved below the pre-registered minimum and the sample-discipline oracle FAILs it (the minimum was never weakened after the fact).",
    arm: PROBE_STARVED,
    directReplay: TRACES_PROBE_STARVED,
    frozenPortfolio: frozenPortfolioOf("portfolio:research"),
    terminal: "FAILED",
  }),
];

/** The offline rows (honest controls first, probes last — deterministic, zero credentials). */
export const OFFLINE_CORPUS_ROWS: readonly DirectCorpusRow[] = [
  ...OFFLINE_CONTROL_ROWS,
  ...PROBE_ROWS,
];

// ---------------------------------------------------------------------------
// The live rows (env-gated on the authorized rail; REAL requests)
// ---------------------------------------------------------------------------

/** The live rows (env-gated on the authorized rail; REAL direct requests). */
export const LIVE_CORPUS_ROWS: readonly DirectCorpusRow[] = [
  {
    rowId: "live-fixed-quality-direct-real-dispatch",
    description:
      "A REAL direct fixed-quality experiment (env-gated): 4 pre-registered requests issued DIRECTLY to the pinned openrouter rail (meta-llama/llama-3.3-70b-instruct, USD per-1M metered — rev-001) with measured usage (BYOK), no platform mediation, no reuse/cache shortcut; the threshold attainment is recomputed from the REAL verdicts and the normalized comparison carries the measured cost-per-resolved and the Wilson interval over the live sample.",
    arm: FQ_LIVE,
    directReplay: TRACES_LIVE_FQ,
    frozenPortfolio: frozenPortfolioOf("portfolio:text-generation"),
    needsDispatch: true,
    liveGate: {
      envVars: ["OPENROUTER_API_KEY"],
      requirement:
        "operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) covering the pinned chat model meta-llama/llama-3.3-70b-instruct — the REAL direct experiments demand REAL provider dispatches with measured usage",
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
    rowId: "live-fixed-cost-direct-real-budget",
    description:
      "A REAL direct fixed-cost experiment (env-gated): the arm pins a 600 µ$ budget (64-token completion budget per request) and measures the quality attained within it over 4 REAL direct requests — the budget gate decides BEFORE each request (the pinned per-round bound priced from the manifest), the usage is measured, and the quality-attained carries the Wilson interval.",
    arm: FC_LIVE,
    directReplay: TRACES_LIVE_FC,
    frozenPortfolio: frozenPortfolioOf("portfolio:research"),
    needsDispatch: true,
    liveGate: {
      envVars: ["OPENROUTER_API_KEY"],
      requirement:
        "operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) covering the pinned chat model meta-llama/llama-3.3-70b-instruct — the REAL direct experiments demand REAL provider dispatches with measured usage",
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
export const DIRECT_CORPUS: readonly DirectCorpusRow[] = [
  ...OFFLINE_CORPUS_ROWS,
  ...LIVE_CORPUS_ROWS,
];

/** Whether every env var of the row's live gate is present. */
export function liveGateOpen(row: DirectCorpusRow, env: NodeJS.ProcessEnv): boolean {
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
  return `val-041-app-${options.runSuffix}-${options.taskIndex}`;
}

/**
 * The app's task body for one row's submission: REFERENCES ONLY —
 * the row, the arm identity, the arm kind, the direct integration
 * surface, the pinned rail, the pinned price revision and the
 * slice/minimum shape. Never a price, never a token price (the
 * platform resolves pricing through the manifest registry).
 */
export function taskBodyFor(options: { readonly row: DirectCorpusRow }): Record<string, unknown> {
  const { row } = options;
  return {
    kind: DIRECT_TASK_KIND,
    rowId: row.rowId,
    armId: row.arm.armId,
    armKind: row.arm.kind,
    integrationSurface: row.arm.integrationSurface,
    provider: row.arm.provider,
    model: row.arm.model,
    priceRevision: row.arm.priceRevision,
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
export const DIRECT_ROW_IDS: readonly string[] = DIRECT_CORPUS.map((row) => row.rowId);

/** Look up one corpus row by id (the config task slice references rows by id). */
export function directRowById(rowId: string): DirectCorpusRow | null {
  return DIRECT_CORPUS.find((row) => row.rowId === rowId) ?? null;
}
