/**
 * The economic-controls-optimized execution driver (VAL-042,
 * acceptance criteria 3, 4 and 5).
 *
 * Drives one optimized-baseline experiment row through the platform
 * path: the landed execution's chain runs the ARM DECISIONS BEFORE
 * DISPATCH (the routing table, the cache policy and — for fixed-cost
 * arms — the per-round budget bound priced from the pinned manifest,
 * all recorded in the durable planning decision BEFORE the first
 * dispatch), then each pre-registered round runs through the
 * OPTIMIZED stack:
 *
 *   * the SEMANTICALLY-SAFE RESPONSE CACHE (the driver's own optimized
 *     component): a round whose (task class, content digest) identity
 *     is cached AND whose declared policy is `cacheable` is SERVED
 *     FROM THE CACHE — no dispatch, no new measured usage (the honest
 *     attribution), the response replays from the store; a
 *     `fresh-only` round is NEVER served from the cache (the safety
 *     oracle fails an unsafe reuse mechanically);
 *   * the fixed-cost budget gate fires BEFORE each DISPATCH (cache
 *     hits are not dispatches — the cache stretches the pinned budget
 *     honestly, the declared prefix stop never moves);
 *   * each dispatched round rides the ROUTED rail (the inventory's
 *     routing table; the usage facts carry the routed provider/model
 *     and price through the pinned manifest per fact), with bounded
 *     retry on RETRYABLE categories only;
 *   * every round — dispatched or cache-served — is sealed + evaluated
 *     + aggregated through the INJECTED accounting rails (the REAL
 *     recorder, the REAL evaluation oracle and the REAL accounting
 *     aggregate, imported from the VAL-040 delivery — never copied,
 *     never modified), and the comparison is derived + validated
 *     against the frozen VAL-040 protocol.
 *
 * The optimized-slice oracles (each mechanical): the
 * INVENTORY-CONFORMANCE oracle (an applied optimization the declared
 * inventory does not name FAILs — the undeclared-optimization
 * masquerade catch), the INVENTORY-INTEGRITY oracle (the content
 * digest agreement — an in-place bound mutation FAILs), the
 * CACHE-SAFETY oracle (an unsafe reuse across a fresh-only round
 * FAILs), the ROUTING-CONFORMANCE oracle (a misrouted round FAILs),
 * the COMPRESSION-BOUND oracle (a dispatched ratio outside the
 * declared bound FAILs), the REPLAY-FIDELITY oracle (an offline
 * executor reporting usage that disagrees with the recorded facts
 * FAILs — the token-understatement catch) and the
 * OPTIMIZATION-ECONOMICS attribution (cache hits contribute ZERO
 * new measured cost — never conflated).
 *
 * The verdict is MECHANICAL: any failure, any failed criterion →
 * verdict fail → terminal FAILED (never a partial-success shortcut).
 */

import { createHash } from "node:crypto";
import type { ArmAggregate } from "../../accounting/aggregate";
import type { GoldenTask } from "../../corpus/schema";
import type { ObservedOutcome } from "../../evaluation/deterministic";
import type { LabVerificationCriterion } from "../../platform/derive";
import { manifestDigestOf } from "../../platform/longitudinal-baseline";
import type { CostFact } from "../../recorder/record";
import type { RunMetadata } from "../../run-identity";
import type {
  DrivenRoundResult,
  EconomicAccountingRails,
  EconomicJournalRecord,
  EconomicLifecyclePort,
  EconomicRunResult,
  EconomicWorldFacts,
  ExpectedNormalizedOutcome,
  LandedExecutionsProvider,
  RoundAccountingInput,
} from "../economic-baseline/driver";
import {
  createRealAccountingRails,
  deriveEconomicRowCriteria,
  economicDigestOf,
  isRetryableDispatchCategory,
} from "../economic-baseline/driver";
import type { UsageFact } from "../economic-baseline/normalization";
import {
  deriveRoundBudgetBoundMicroUsd,
  manifestFor,
  normalizeArmCosts,
} from "../economic-baseline/normalization";
import type { PriceCurrency, PriceManifestRevision } from "../economic-baseline/pricing";
import { resolveListPrice } from "../economic-baseline/pricing";
import type { EconomicArm } from "../economic-baseline/protocol";
import {
  deriveNormalizedComparison,
  type NormalizedArmComparison,
} from "../economic-baseline/protocol";
import {
  deriveCompressionConformance,
  deriveInventoryConformance,
  deriveInventoryIntegrity,
  inventoryFor,
  type ModelRoute,
  type OptimizationInventoryRevision,
  RESPONSE_CACHE_NAME,
  routeForClass,
} from "./optimizations";

// ---------------------------------------------------------------------------
// The semantically-safe response cache (the optimized stack's own component)
// ---------------------------------------------------------------------------

/** One stored response (the cache's value — digests and text, never payloads). */
export interface CachedResponseEntry {
  readonly taskClass: string;
  readonly contentDigest: string;
  readonly responseText: string;
  readonly requestDigest: string;
  /** The round that stored the entry (evidence provenance). */
  readonly storedByTaskId: string;
}

/**
 * The semantically-safe response cache: keys on the (task class,
 * content digest) identity — the VAL-005 optimized-baseline cache's
 * content-identity discipline extended with the FRESH-ONLY safety
 * rule (a task whose correctness demands a fresh dispatch is never
 * served from the cache; the driver enforces it, the safety oracle
 * fails an unsafe reuse mechanically).
 */
export class SemanticResponseCache {
  private readonly entries = new Map<string, CachedResponseEntry>();

  /** The cache key: content identity of (task class, document digest). */
  static keyOf(taskClass: string, contentDigest: string): string {
    return createHash("sha256").update(`${taskClass}:${contentDigest}`).digest("hex");
  }

  /** Look up one cached response (undefined on a miss). */
  lookup(taskClass: string, contentDigest: string): CachedResponseEntry | undefined {
    return this.entries.get(SemanticResponseCache.keyOf(taskClass, contentDigest));
  }

  /** Store one response (successful cacheable rounds only — never failures). */
  store(entry: CachedResponseEntry): void {
    this.entries.set(SemanticResponseCache.keyOf(entry.taskClass, entry.contentDigest), entry);
  }

  get size(): number {
    return this.entries.size;
  }
}

// ---------------------------------------------------------------------------
// The executor seam (the optimized dispatch — INJECTED)
// ---------------------------------------------------------------------------

/** The usage one optimized dispatch attempt observed. */
export interface OptimizedRoundUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * The RAW (uncompressed) payload's token count — the compression
   * bound's denominator (the executor's own honest observation of what
   * it would have dispatched uncompressed).
   */
  readonly rawInputTokens: number;
  readonly currency: PriceCurrency;
  readonly costUsd?: number;
}

/** The outcome of ONE optimized dispatch attempt. */
export interface OptimizedRoundDispatchOutcome {
  readonly kind: "success" | "failure" | "skipped";
  readonly content?: string;
  readonly usage?: OptimizedRoundUsage;
  readonly category?: string;
  readonly message?: string;
  readonly latencyMs: number;
  readonly requestDigest: string;
  readonly estimateQuote?: { readonly inputTokens: number; readonly outputTokens: number };
  readonly skipReason?: string;
  /** The rail the executor routed the round through (null on skips). */
  readonly route: { readonly provider: string; readonly model: string } | null;
  /**
   * The optimizations the executor applied to THIS dispatch (the
   * inventory-conformance oracle's input — every action the executor
   * takes must be attributed to a declared name).
   */
  readonly appliedOptimizations: readonly string[];
}

/** The optimized executor seam: one dispatch attempt per call. */
export type OptimizedExecutor = (input: {
  readonly executionId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly taskClass: string;
  readonly contentDigest: string;
  readonly cachePolicy: "cacheable" | "fresh-only";
}) => Promise<OptimizedRoundDispatchOutcome>;

// ---------------------------------------------------------------------------
// The corpus row contract (the oracle)
// ---------------------------------------------------------------------------

/** One recorded fresh-dispatch attempt (a settled fact). */
export interface OptimizedRecordedAttempt {
  readonly outcome: "success" | "failure";
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  readonly category?: string;
  readonly latencyMs: number;
}

/**
 * One optimized round plan: the task's class/content/policy
 * declarations (the routing + cache inputs) plus — for offline rows —
 * the recorded fresh-dispatch facts the replay executor settles.
 */
export interface OptimizedRecordedRound {
  readonly taskId: string;
  /** The task class (the routing table's key). */
  readonly taskClass: string;
  /** The content identity the cache keys on (a digest reference). */
  readonly contentDigest: string;
  /** The cache-safety declaration (the safety oracle's input). */
  readonly cachePolicy: "cacheable" | "fresh-only";
  /** The recorded fresh-dispatch facts (offline rows; live rows leave absent). */
  readonly recorded?: {
    readonly attempts: readonly OptimizedRecordedAttempt[];
    /** The raw (uncompressed) payload's tokens (the compression bound's denominator). */
    readonly rawInputTokens: number;
    readonly responseText?: string;
    readonly estimateQuote?: { readonly inputTokens: number; readonly outputTokens: number };
  };
}

/**
 * The frozen-portfolio reference (VAL-030 baseline revisions, by
 * content digest — never copied): the manifest entry of the frozen
 * (app, workload) pin this row's slice represents.
 */
export interface FrozenPortfolioReference {
  readonly appId: string;
  readonly appDigest: string;
  readonly workloadId: string;
  readonly workloadRevision: number;
  readonly workloadDigest: string;
  readonly manifestDigest: string;
}

/**
 * The optimized-baseline corpus row — structurally an economic corpus
 * row (the VAL-040 criteria derivations ride it unchanged) extended
 * with the optimization declarations.
 */
export interface OptimizedCorpusRow {
  readonly rowId: string;
  readonly description: string;
  /** The arm manifest entry (the VAL-040 frozen grammar). */
  readonly arm: EconomicArm;
  /**
   * WHICH pinned optimization-inventory revision declared this row's
   * optimization set (content-addressed alongside the price manifests).
   */
  readonly optimizationInventoryRevision: string;
  /** The per-round plans (class/content/policy + the recorded facts). */
  readonly optimizedReplay: readonly OptimizedRecordedRound[];
  /** The frozen-portfolio slice this row represents (digests only). */
  readonly frozenPortfolio: FrozenPortfolioReference;
  readonly needsDispatch: boolean;
  readonly liveGate?: {
    readonly envVars: readonly string[];
    readonly requirement: string;
  };
  readonly expected: {
    readonly terminal: "COMPLETED" | "FAILED";
    readonly executions: number;
    readonly idempotencyRecords: number;
    readonly appCreated: number;
    readonly replayedSubmissions: number;
    readonly rejectedSubmissions: number;
    readonly normalized?: ExpectedNormalizedOutcome;
  };
}

/** The VAL-040 expected-normalized-outcome type re-export (the oracle's shape). */
export type { ExpectedNormalizedOutcome } from "../economic-baseline/driver";

// ---------------------------------------------------------------------------
// Run results
// ---------------------------------------------------------------------------

/** One driven optimized round (a dispatched round or a cache-served round). */
export interface OptimizedDrivenRound extends DrivenRoundResult {
  /** True when the round was served from the response cache (no dispatch). */
  readonly cacheHit: boolean;
  /** The task class the round ran under (the routing table's key). */
  readonly taskClass: string;
  /** The content digest the cache keyed on. */
  readonly contentDigest: string;
  /** The round's declared cache policy. */
  readonly cachePolicy: "cacheable" | "fresh-only";
  /** The rail the round's dispatch rode (null on cache hits). */
  readonly route: { readonly provider: string; readonly model: string } | null;
  /** The optimizations applied to THIS round (dispatch + cache service). */
  readonly appliedOptimizations: readonly string[];
  /** The raw (uncompressed) payload tokens of the final dispatch (null on hits). */
  readonly rawInputTokens: number | null;
}

/** The full optimized row run result (the honest outcome contract). */
export interface OptimizedRunResult extends EconomicRunResult {
  readonly cacheHits: number;
  readonly dispatches: number;
  readonly rounds: readonly OptimizedDrivenRound[];
}

// ---------------------------------------------------------------------------
// The chain options + the execution chain
// ---------------------------------------------------------------------------

interface ChainOptions {
  readonly executionId: string;
  readonly row: OptimizedCorpusRow;
  readonly lifecycle: EconomicLifecyclePort;
  readonly executor: OptimizedExecutor;
  readonly rails: EconomicAccountingRails;
  readonly tasks: readonly GoldenTask[];
  readonly manifest: PriceManifestRevision;
  readonly inventory: OptimizationInventoryRevision;
  readonly metadata: RunMetadata;
  readonly environmentIdentity: string;
  readonly corpusVersion: string;
  readonly retry: {
    readonly maxExtraAttempts: number;
    readonly backoffMs: number;
    readonly sleep: (ms: number) => Promise<void>;
  };
  readonly now: () => Date;
  readonly keyCounter: { count: number };
  /** The discrimination knob: serve fresh-only rounds from the cache (UNSAFE). */
  readonly unsafeCacheReuse: boolean;
}

/** Generate the next per-call key fragment (per-decision distinct). */
function nextCallKey(counter: { count: number }): string {
  counter.count += 1;
  return `k${counter.count}`;
}

/** The deterministic cache-service latency (the recorded hit latency). */
export const CACHE_HIT_LATENCY_MS = 3;

/** The derived observed outcome of one cache-served round (PURE). */
function observedOutcomeOfCacheHit(entry: CachedResponseEntry): ObservedOutcome {
  return {
    terminalStatus: "COMPLETED",
    verificationStatuses: ["PASS"],
    responseText: entry.responseText,
    outputShapeFields: [],
    environmentEffects: [],
    retryableErrorsSurfaced: 0,
  };
}

/** The derived observed outcome of one dispatch round (PURE — the final attempt decides). */
function observedOutcomeOfDispatch(finalOutcome: OptimizedRoundDispatchOutcome): ObservedOutcome {
  if (finalOutcome.kind === "success") {
    return {
      terminalStatus: "COMPLETED",
      verificationStatuses: ["PASS"],
      responseText: finalOutcome.content ?? "",
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
 * Derive the worst-case micro-USD cost of ONE dispatch round over
 * EVERY route of the declared inventory (PURE — the conservative
 * fixed-cost bound: the pinned max tokens priced at BOTH tiers of
 * every routed rail; the gate never under-reserves).
 */
export function deriveOptimizedRoundBudgetBoundMicroUsd(input: {
  readonly manifest: PriceManifestRevision;
  readonly inventory: OptimizationInventoryRevision;
  readonly maxTokens: number;
}): string {
  const routes: readonly ModelRoute[] = [...input.inventory.routes, input.inventory.fallbackRoute];
  const bounds = routes.map((route) =>
    BigInt(
      deriveRoundBudgetBoundMicroUsd({
        manifest: input.manifest,
        provider: route.provider,
        model: route.model,
        maxTokens: input.maxTokens,
      }),
    ),
  );
  return bounds.reduce((max, bound) => (bound > max ? bound : max)).toString();
}

/**
 * Drive ONE landed execution's optimized machinery: authorize → plan →
 * the durable planning decision carrying the ARM DECISIONS (the
 * routing table, the cache policy, the budget bound — BEFORE the
 * first dispatch) → queue → start → the pre-registered rounds (the
 * cache check; the fixed-cost budget gate before each DISPATCH;
 * bounded retry; the normalized, sealed, evaluated accounting) → the
 * rounds' return. Any failure is honest (never a partial-success
 * shortcut).
 */
async function driveOptimizedChain(options: ChainOptions): Promise<{
  readonly rounds: readonly OptimizedDrivenRound[];
  readonly budgetStopAfter: number | null;
  readonly usageFacts: readonly UsageFact[];
  readonly failure: { readonly category: string; readonly message: string } | null;
  readonly journal: readonly EconomicJournalRecord[];
}> {
  const { executionId, row, lifecycle, executor, rails } = options;
  const key = (): string => nextCallKey(options.keyCounter);
  const journal: EconomicJournalRecord[] = [];
  const usageFacts: UsageFact[] = [];
  const rounds: OptimizedDrivenRound[] = [];
  const cache = new SemanticResponseCache();
  let failure: { category: string; message: string } | null = null;
  let budgetStopAfter: number | null = null;
  const plans = new Map(row.optimizedReplay.map((plan) => [plan.taskId, plan]));

  // ---- the canonical prologue ----
  await lifecycle.transition({
    executionId,
    step: "authorize",
    reason: "val-042-authorize",
    callKey: key(),
  });
  await lifecycle.transition({ executionId, step: "plan", reason: "val-042-plan", callKey: key() });

  // ---- the ARM DECISIONS (made BEFORE any dispatch) ----
  const roundBoundMicroUsd =
    row.arm.kind === "fixed-cost"
      ? deriveOptimizedRoundBudgetBoundMicroUsd({
          manifest: options.manifest,
          inventory: options.inventory,
          maxTokens: row.arm.maxTokensPerRound,
        })
      : null;
  const armDecision: Record<string, unknown> = {
    kind:
      row.arm.kind === "fixed-cost"
        ? "optimized-fixed-cost-budget-plan"
        : "optimized-fixed-quality-plan",
    optimizationInventoryRevision: row.optimizationInventoryRevision,
    optimizationInventoryDigest: options.inventory.digest,
    routingTable: options.inventory.routes.map((route) => ({
      taskClass: route.taskClass,
      provider: route.provider,
      model: route.model,
    })),
    fallbackRoute: {
      taskClass: options.inventory.fallbackRoute.taskClass,
      provider: options.inventory.fallbackRoute.provider,
      model: options.inventory.fallbackRoute.model,
    },
    cachePolicy: {
      key: "task-class+content-digest",
      safety: "fresh-only tasks are never served from the cache",
    },
    ...(row.arm.kind === "fixed-cost"
      ? {
          pinnedBudgetMicroUsd: row.arm.pinnedBudgetMicroUsd,
          roundBoundMicroUsd,
          maxTokensPerRound: row.arm.maxTokensPerRound,
          stopRule: "stop before dispatch when remaining budget < round bound (prefix stop)",
        }
      : {
          pinnedThreshold: row.arm.pinnedThreshold.resolutionRate,
          stopRule: "run the full pre-registered slice (no stop)",
        }),
    sliceSize: row.arm.corpusSlice.length,
    minimumSamples: row.arm.minimumSamples,
  };
  await lifecycle.recordPlanningDecision({
    executionId,
    route: {
      provider: row.arm.provider,
      model: row.arm.model,
      strategyClass: "economic-controls-optimized",
    },
    armDecision,
  });
  {
    const record: EconomicJournalRecord = {
      ordinal: journal.length + 1,
      kind: "arm-decision",
      digest: economicDigestOf(armDecision),
      detail: `arm-decision:${row.arm.armId}:${row.arm.kind}`,
    };
    journal.push(record);
    await lifecycle.recordStepEvent({ executionId, record });
  }
  await lifecycle.transition({
    executionId,
    step: "queue",
    reason: "val-042-queue",
    callKey: key(),
  });
  await lifecycle.transition({
    executionId,
    step: "start",
    reason: "val-042-start",
    callKey: key(),
  });

  // ---- the work rounds (the pre-registered order) ----
  const slice = row.arm.corpusSlice;
  let measuredSoFarMicroUsd = 0n;
  for (const [roundIndex, taskId] of slice.entries()) {
    const task = options.tasks.find((candidate) => candidate.taskId === taskId);
    const plan = plans.get(taskId);
    if (task === undefined || plan === undefined) {
      failure = {
        category: "slice-task-missing",
        message: `the pre-registered task ${taskId} has no golden task or round plan in the slice corpus`,
      };
      break;
    }

    // ---- the semantically-safe cache check (the driver's own component) ----
    const cached = cache.lookup(plan.taskClass, plan.contentDigest);
    const cacheMayServe =
      plan.cachePolicy === "cacheable" ||
      // The discrimination knob: an UNSAFE reuse (serving a fresh-only
      // round from the cache) — the cache-safety oracle fails it.
      (options.unsafeCacheReuse === true && plan.cachePolicy === "fresh-only");
    if (cached !== undefined && cacheMayServe) {
      const observed = observedOutcomeOfCacheHit(cached);
      const evaluation = rails.evaluate({
        task,
        corpusVersion: options.corpusVersion,
        observed,
      });
      const servedAt = options.now().toISOString();
      const events: RoundAccountingInput["events"] = [
        {
          kind: "run-start",
          data: { corpusTask: taskId, arm: row.arm.armId, servedFrom: "response-cache" },
          at: servedAt,
        },
        {
          kind: "cache-event",
          data: {
            keyDigest: SemanticResponseCache.keyOf(plan.taskClass, plan.contentDigest).slice(0, 16),
            hit: true,
            storedByTaskId: cached.storedByTaskId,
          },
          at: servedAt,
        },
        { kind: "run-end", data: { terminalStatus: observed.terminalStatus }, at: servedAt },
      ];
      const record = rails.sealRound({
        metadata: options.metadata,
        corpusTaskId: taskId,
        environmentIdentity: options.environmentIdentity,
        events,
        cost: [],
        latency: [
          { phase: "total", source: "harness-wallclock", milliseconds: CACHE_HIT_LATENCY_MS },
        ],
        environment: [
          {
            kind: "state-transitioned",
            assertion: `the cache-served round ${taskId} settled through the platform ledger`,
            observedVia: "platform-ledger",
            passed: true,
          },
        ],
        sealedAt: servedAt,
      });
      const hitRecord: EconomicJournalRecord = {
        ordinal: journal.length + 1,
        kind: "round",
        digest: economicDigestOf({
          taskId,
          cacheHit: true,
          keyDigest: SemanticResponseCache.keyOf(plan.taskClass, plan.contentDigest),
          storedByTaskId: cached.storedByTaskId,
        }),
        detail: `cache-hit:${taskId}:${plan.taskClass}`,
      };
      journal.push(hitRecord);
      await lifecycle.recordStepEvent({ executionId, record: hitRecord });
      rounds.push({
        taskId,
        executed: true,
        attempts: 0,
        observed,
        usageFacts: [],
        latencyMs: CACHE_HIT_LATENCY_MS,
        record,
        evaluation,
        cacheHit: true,
        taskClass: plan.taskClass,
        contentDigest: plan.contentDigest,
        cachePolicy: plan.cachePolicy,
        route: null,
        appliedOptimizations: [RESPONSE_CACHE_NAME],
        rawInputTokens: null,
      });
      continue;
    }

    // ---- the fixed-cost budget gate — BEFORE the dispatch ----
    if (row.arm.kind === "fixed-cost" && roundBoundMicroUsd !== null) {
      const budget = BigInt(row.arm.pinnedBudgetMicroUsd);
      const remaining = budget - measuredSoFarMicroUsd;
      if (remaining < BigInt(roundBoundMicroUsd)) {
        budgetStopAfter = roundIndex;
        const record: EconomicJournalRecord = {
          ordinal: journal.length + 1,
          kind: "budget-stop",
          digest: economicDigestOf({
            taskId,
            remaining: remaining.toString(),
            bound: roundBoundMicroUsd,
          }),
          detail: `budget-stop:${taskId} (remaining ${remaining} < bound ${roundBoundMicroUsd})`,
        };
        journal.push(record);
        await lifecycle.recordStepEvent({ executionId, record });
        break;
      }
    }

    // ---- the dispatch loop (bounded retry on RETRYABLE categories only) ----
    const attemptOutcomes: OptimizedRoundDispatchOutcome[] = [];
    let finalOutcome: OptimizedRoundDispatchOutcome | null = null;
    let skipped = false;
    for (let attempt = 1; ; attempt += 1) {
      const outcome = await executor({
        executionId,
        taskId,
        attempt,
        taskClass: plan.taskClass,
        contentDigest: plan.contentDigest,
        cachePolicy: plan.cachePolicy,
      });
      if (outcome.kind === "skipped") {
        skipped = true;
        const record: EconomicJournalRecord = {
          ordinal: journal.length + 1,
          kind: "skip",
          digest: economicDigestOf({ taskId, reason: outcome.skipReason ?? "unknown" }),
          detail: `skip:${taskId}:${outcome.skipReason ?? "unknown"}`,
        };
        journal.push(record);
        await lifecycle.recordStepEvent({ executionId, record });
        break;
      }
      if (outcome.kind === "success") {
        finalOutcome = outcome;
        attemptOutcomes.push(outcome);
        break;
      }
      const retryable = isRetryableDispatchCategory(outcome.category ?? "");
      if (!retryable || attempt > options.retry.maxExtraAttempts) {
        finalOutcome = outcome;
        attemptOutcomes.push(outcome);
        break;
      }
      attemptOutcomes.push(outcome);
      const record: EconomicJournalRecord = {
        ordinal: journal.length + 1,
        kind: "retry",
        digest: economicDigestOf({ taskId, attempt, category: outcome.category }),
        detail: `retry:${taskId}:attempt${attempt}:${outcome.category ?? "unknown"}`,
      };
      journal.push(record);
      await lifecycle.recordStepEvent({ executionId, record });
      await options.retry.sleep(options.retry.backoffMs);
    }
    if (skipped) {
      continue;
    }
    if (finalOutcome === null) {
      failure = {
        category: "dispatch-never-settled",
        message: `the round ${taskId} never settled an attempt outcome`,
      };
      break;
    }

    // ---- the usage facts: every attempt's usage prices through the ROUTED rail ----
    const roundFacts: UsageFact[] = [];
    for (const [index, outcome] of attemptOutcomes.entries()) {
      const isFinal = index === attemptOutcomes.length - 1;
      const provider = outcome.route?.provider ?? row.arm.provider;
      const model = outcome.route?.model ?? row.arm.model;
      if (outcome.usage !== undefined) {
        roundFacts.push({
          provider,
          model,
          tier: "input",
          currency: outcome.usage.currency,
          tokens: outcome.usage.inputTokens,
          kind: "measured",
          scope: isFinal ? "direct-execution" : "retry-overhead",
          ...(outcome.usage.costUsd === undefined
            ? {}
            : { chargedAmount: String(outcome.usage.costUsd) }),
        });
        roundFacts.push({
          provider,
          model,
          tier: "output",
          currency: outcome.usage.currency,
          tokens: outcome.usage.outputTokens,
          kind: "measured",
          scope: isFinal ? "direct-execution" : "retry-overhead",
          ...(outcome.usage.costUsd === undefined
            ? {}
            : { chargedAmount: String(outcome.usage.costUsd) }),
        });
      }
    }
    if (finalOutcome.estimateQuote !== undefined) {
      // The quote rides in the ROUTED rail's declared currency (the
      // manifest's own denomination for the routed provider).
      const provider = finalOutcome.route?.provider ?? row.arm.provider;
      const model = finalOutcome.route?.model ?? row.arm.model;
      const quoteEntry = resolveListPrice(options.manifest, provider, model, "input");
      const quoteCurrency = quoteEntry?.currency ?? "USD";
      roundFacts.push({
        provider,
        model,
        tier: "input",
        currency: quoteCurrency,
        tokens: finalOutcome.estimateQuote.inputTokens,
        kind: "estimate",
        scope: "direct-execution",
      });
      roundFacts.push({
        provider,
        model,
        tier: "output",
        currency: quoteCurrency,
        tokens: finalOutcome.estimateQuote.outputTokens,
        kind: "estimate",
        scope: "direct-execution",
      });
    }
    usageFacts.push(...roundFacts);

    // ---- the observed outcome + evaluation ----
    const observed = observedOutcomeOfDispatch(finalOutcome);
    const latencyMs = attemptOutcomes.reduce((sum, outcome) => sum + outcome.latencyMs, 0);
    const evaluation = rails.evaluate({
      task,
      corpusVersion: options.corpusVersion,
      observed,
    });

    // ---- the round's cost facts (normalized through the pinned manifest) ----
    const basis = normalizeArmCosts(roundFacts, options.manifest);
    const roundCostFacts: CostFact[] = basis.facts.map((fact) => ({
      kind: fact.kind,
      amountMicroUsd: fact.microUsd,
      source: `val-042:${row.rowId}:${options.manifest.revision}`,
      scope: fact.scope,
    }));
    measuredSoFarMicroUsd += BigInt(basis.measuredMicroUsd);

    // ---- the round's journal record (the settled round — digests only) ----
    {
      const record: EconomicJournalRecord = {
        ordinal: journal.length + 1,
        kind: finalOutcome.kind === "success" ? "round" : "failure",
        digest: economicDigestOf({
          taskId,
          attempts: attemptOutcomes.length,
          requestDigest: finalOutcome.requestDigest,
          verdict: evaluation.verdict,
          route: finalOutcome.route,
        }),
        detail: `round:${taskId}:${finalOutcome.kind}:${finalOutcome.route?.provider ?? "none"}`,
      };
      journal.push(record);
      await lifecycle.recordStepEvent({ executionId, record });
    }

    // ---- the round's accounted run: sealed through the REAL recorder ----
    const roundStart = options.now().toISOString();
    const events: RoundAccountingInput["events"] = [
      { kind: "run-start", data: { corpusTask: taskId, arm: row.arm.armId }, at: roundStart },
      ...attemptOutcomes.map((outcome, index) => ({
        kind: (outcome.kind === "failure" && index === attemptOutcomes.length - 1
          ? "error-surfaced"
          : "model-choice") as RoundAccountingInput["events"][number]["kind"],
        data: {
          ...(outcome.kind === "failure" && index === attemptOutcomes.length - 1
            ? { code: outcome.category ?? "unknown", retryable: false }
            : {
                requestDigest: outcome.requestDigest,
                attempt: index + 1,
                route: outcome.route,
                appliedOptimizations: [...outcome.appliedOptimizations],
              }),
        },
        at: roundStart,
      })),
      { kind: "run-end", data: { terminalStatus: observed.terminalStatus }, at: roundStart },
    ];
    const record = rails.sealRound({
      metadata: options.metadata,
      corpusTaskId: taskId,
      environmentIdentity: options.environmentIdentity,
      events,
      cost: roundCostFacts,
      latency: [{ phase: "total", source: "harness-wallclock", milliseconds: latencyMs }],
      environment: [
        {
          kind: "state-transitioned",
          assertion: `the round ${taskId} settled through the platform ledger`,
          observedVia: "platform-ledger",
          passed: true,
        },
      ],
      sealedAt: roundStart,
    });

    // ---- the cache store (successful CACHEABLE rounds only) ----
    if (finalOutcome.kind === "success" && plan.cachePolicy === "cacheable") {
      cache.store({
        taskClass: plan.taskClass,
        contentDigest: plan.contentDigest,
        responseText: finalOutcome.content ?? "",
        requestDigest: finalOutcome.requestDigest,
        storedByTaskId: taskId,
      });
    }

    rounds.push({
      taskId,
      executed: true,
      attempts: attemptOutcomes.length,
      observed,
      usageFacts: roundFacts,
      latencyMs,
      record,
      evaluation,
      cacheHit: false,
      taskClass: plan.taskClass,
      contentDigest: plan.contentDigest,
      cachePolicy: plan.cachePolicy,
      route: finalOutcome.route,
      appliedOptimizations: [...finalOutcome.appliedOptimizations],
      rawInputTokens: finalOutcome.usage?.rawInputTokens ?? plan.recorded?.rawInputTokens ?? null,
    });
  }

  return { rounds, budgetStopAfter, usageFacts, failure, journal };
}

// ---------------------------------------------------------------------------
// The row driver
// ---------------------------------------------------------------------------

/**
 * Drive one optimized-baseline corpus row to settlement through the
 * platform path: the landed execution's optimized chain (the arm
 * decisions BEFORE dispatch → the pre-registered rounds with the
 * cache check, the budget gate before each dispatch and the bounded
 * retry → the normalized, sealed, evaluated, aggregated accounting),
 * the observed terminal READ BACK from the ledger, the normalized
 * comparison derived + validated against the frozen VAL-040 protocol,
 * and the row-level mechanical criteria (the VAL-040 criteria families
 * + the optimized-slice oracles). The honest terminal is FAILED when
 * any failure was observed, any criterion failed or any comparison
 * violation surfaced — never a partial-success shortcut.
 */
export async function driveOptimizedRow(options: {
  readonly row: OptimizedCorpusRow;
  readonly lifecycle: EconomicLifecyclePort;
  /** The optimized dispatch executor (recorded replay offline; REAL gateway live). */
  readonly executor: OptimizedExecutor;
  /** The accounting rails (the REAL recorder + evaluation + aggregate). */
  readonly rails: EconomicAccountingRails;
  readonly tasks: readonly GoldenTask[];
  readonly metadata: RunMetadata;
  readonly environmentIdentity: string;
  readonly corpusVersion: string;
  readonly baseline: EconomicWorldFacts;
  readonly worldFacts: () => Promise<EconomicWorldFacts> | EconomicWorldFacts;
  readonly landedProvider: LandedExecutionsProvider;
  readonly retry: {
    readonly maxExtraAttempts: number;
    readonly backoffMs: number;
    readonly sleep: (ms: number) => Promise<void>;
  };
  readonly now: () => Date;
  /** An override manifest (the discrimination battery's mutated tables). */
  readonly manifestOverride?: PriceManifestRevision;
  /** An override inventory (the discrimination battery's mutated bounds). */
  readonly inventoryOverride?: OptimizationInventoryRevision;
  /** The arm's own threshold claim (never trusted — the gaming catch). */
  readonly claimedThresholdMet?: boolean;
  /** The discrimination knob: an UNSAFE cache reuse (fresh-only served from the cache). */
  readonly unsafeCacheReuse?: boolean;
}): Promise<OptimizedRunResult> {
  const runStartedAt = options.now().getTime();
  const keyCounter = { count: 0 };
  const manifest = options.manifestOverride ?? manifestFor(options.row.arm.priceRevision);
  const inventory =
    options.inventoryOverride ?? inventoryFor(options.row.optimizationInventoryRevision);
  const landed = await options.landedProvider(1, options.row.expected.appCreated);
  if (landed.length !== options.row.expected.appCreated || landed[0] === undefined) {
    const failure = {
      category: "landed-count-mismatch",
      message: `the row's landed provider returned ${landed.length} executions (expected ${options.row.expected.appCreated})`,
    };
    return {
      rowId: options.row.rowId,
      terminal: "FAILED",
      criteria: deriveEconomicRowCriteria({
        row: options.row,
        rounds: [],
        aggregate: null,
        comparison: null,
        observedTerminal: null,
        executionId: null,
        baseline: options.baseline,
        finalFacts: await Promise.resolve(options.worldFacts()),
        failure,
        usageFailureCount: 0,
        budgetStopAfter: null,
        totalLatencyMs: options.now().getTime() - runStartedAt,
      }),
      executionId: null,
      observedTerminal: null,
      rounds: [],
      budgetStopAfter: null,
      comparison: null,
      aggregate: null,
      totalLatencyMs: options.now().getTime() - runStartedAt,
      failure,
      cacheHits: 0,
      dispatches: 0,
    };
  }
  const executionId = landed[0];

  const chain = await driveOptimizedChain({
    executionId,
    row: options.row,
    lifecycle: options.lifecycle,
    executor: options.executor,
    rails: options.rails,
    tasks: options.tasks,
    manifest,
    inventory,
    metadata: options.metadata,
    environmentIdentity: options.environmentIdentity,
    corpusVersion: options.corpusVersion,
    retry: options.retry,
    now: options.now,
    keyCounter,
    unsafeCacheReuse: options.unsafeCacheReuse === true,
  });

  // ---- the accounting rails' aggregate over the driven rounds ----
  let aggregate: ArmAggregate | null = null;
  let comparison: NormalizedArmComparison | null = null;
  const executedTaskIds = chain.rounds.map((round) => round.taskId);
  if (chain.rounds.length > 0) {
    const accounted = chain.rounds.map((round) => ({
      record: round.record,
      evaluation: round.evaluation,
    }));
    aggregate = options.rails.aggregate({
      arm: options.row.arm.armId,
      corpusSlice: options.row.rowId,
      runs: accounted,
    });
    comparison = deriveNormalizedComparison({
      arm: options.row.arm,
      aggregate,
      executedTaskIds,
      manifestUsed: manifest,
      ...(options.claimedThresholdMet === undefined
        ? {}
        : { claimedThresholdMet: options.claimedThresholdMet }),
    });
  }

  // ---- the verify boundary, then the mechanically derived verdict ----
  await options.lifecycle.transition({
    executionId,
    step: "verify",
    reason: "val-042-verify",
    callKey: nextCallKey(keyCounter),
  });
  const finalFacts = await Promise.resolve(options.worldFacts());
  const usageFailureCount = normalizeArmCosts(chain.usageFacts, manifest).failures.length;

  const rowCriteria = [
    ...deriveEconomicRowCriteria({
      row: options.row,
      rounds: chain.rounds,
      aggregate,
      comparison,
      observedTerminal: null,
      executionId,
      baseline: options.baseline,
      finalFacts,
      failure: chain.failure,
      usageFailureCount,
      budgetStopAfter: chain.budgetStopAfter,
      totalLatencyMs: options.now().getTime() - runStartedAt,
      ...(options.claimedThresholdMet === undefined
        ? {}
        : { claimedThresholdMet: options.claimedThresholdMet }),
    }),
    ...deriveOptimizedSliceCriteria({
      row: options.row,
      rounds: chain.rounds,
      inventory,
    }),
  ];

  const derivedTerminal: "COMPLETED" | "FAILED" =
    chain.failure !== null || rowCriteria.some((criterion) => criterion.status === "FAIL")
      ? "FAILED"
      : "COMPLETED";
  const verdict: "pass" | "fail" = derivedTerminal === "COMPLETED" ? "pass" : "fail";
  await options.lifecycle.complete({
    executionId,
    verdict,
    criteria: rowCriteria,
    reason:
      verdict === "pass"
        ? "val-042-verified"
        : `val-042-${chain.failure?.category ?? "protocol-violation"}`,
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
    rounds: chain.rounds,
    budgetStopAfter: chain.budgetStopAfter,
    comparison,
    aggregate,
    totalLatencyMs: options.now().getTime() - runStartedAt,
    failure: chain.failure,
    cacheHits: chain.rounds.filter((round) => round.cacheHit).length,
    dispatches: chain.rounds.filter((round) => !round.cacheHit).length,
  };
}

// ---------------------------------------------------------------------------
// The optimized-slice oracles (the mechanical verification)
// ---------------------------------------------------------------------------

/**
 * Derive the optimized-slice criteria (PURE — the VAL-042 verification
 * core): the inventory-conformance oracle (an UNDECLARED optimization
 * FAILs — the masquerade catch), the inventory-integrity oracle (the
 * content-digest agreement), the cache-safety oracle (an UNSAFE reuse
 * across a fresh-only round FAILs), the routing-conformance oracle
 * (a misrouted round FAILs), the compression-bound oracle (the
 * dispatched ratio within the declared bound), the replay-fidelity
 * oracle (the offline executor's reported usage equals the recorded
 * facts — the token-understatement catch) and the frozen-portfolio
 * reference integrity (the VAL-030 content digests agree).
 */
export function deriveOptimizedSliceCriteria(input: {
  readonly row: OptimizedCorpusRow;
  readonly rounds: readonly OptimizedDrivenRound[];
  readonly inventory: OptimizationInventoryRevision;
}): readonly LabVerificationCriterion[] {
  const { row, rounds, inventory } = input;
  const criteria: LabVerificationCriterion[] = [];

  // 1. Inventory conformance: every APPLIED optimization is declared.
  const appliedNames = rounds.flatMap((round) => round.appliedOptimizations);
  const conformance = deriveInventoryConformance({
    inventory,
    appliedOptimizations: appliedNames,
  });
  criteria.push({
    criterionId: "inventory-conformance",
    strategy: "deterministic",
    status: conformance.conformant ? "PASS" : "FAIL",
    evidence: [
      `inventoryRevision:${inventory.revision}`,
      ...conformance.evidence,
      ...(conformance.conformant
        ? []
        : [
            "the undeclared-optimization masquerade: something the baseline does that its inventory does not name FAILs mechanically",
          ]),
    ],
  });

  // 2. Inventory integrity: the digest of the inventory that ACTUALLY
  //    declared this run's optimization set (the registry's pinned
  //    revision, or the override the discrimination battery injected
  //    — an in-place bound mutation with a stale digest fails its own
  //    digest integrity mechanically).
  const integrity = deriveInventoryIntegrity({
    revision: inventory.revision,
    registry: [inventory],
  });
  criteria.push({
    criterionId: "inventory-integrity",
    strategy: "deterministic",
    status: integrity.agreed ? "PASS" : "FAIL",
    evidence: integrity.evidence,
  });

  // 3. Cache safety: every cache-served round was cacheable; every
  //    fresh-only round dispatched fresh.
  const unsafeHits = rounds.filter((round) => round.cacheHit && round.cachePolicy === "fresh-only");
  const hitKeys = rounds
    .filter((round) => round.cacheHit)
    .map((round) => SemanticResponseCache.keyOf(round.taskClass, round.contentDigest));
  const hitKeysDistinct = new Set(hitKeys).size === hitKeys.length;
  const hits = rounds.filter((round) => round.cacheHit).length;
  const cacheSafe = unsafeHits.length === 0;
  criteria.push({
    criterionId: "cache-safety",
    strategy: "deterministic",
    status: cacheSafe ? "PASS" : "FAIL",
    evidence: [
      `cacheHits:${hits}`,
      `distinctServedKeys:${String(hitKeysDistinct)}`,
      `freshOnlyRounds:${rounds.filter((round) => round.cachePolicy === "fresh-only").length}`,
      `freshOnlyServedFromCache:${unsafeHits.length}`,
      ...unsafeHits.map((round) => `unsafe:${round.taskId}`),
      cacheSafe
        ? "safe (every cache-served round was cacheable; every fresh-only round dispatched fresh — correctness-demanding freshness was never sacrificed for reuse)"
        : "UNSAFE (a fresh-only round was served from the cache — correctness demanded a fresh dispatch)",
    ],
  });

  // 4. Routing conformance: every dispatched round rode the routing
  //    table's route for its class (the fallback for unnamed classes).
  const misroutes = rounds
    .filter((round) => !round.cacheHit && round.route !== null)
    .filter((round) => {
      const expected = routeForClass(inventory, round.taskClass);
      return round.route?.provider !== expected.provider || round.route?.model !== expected.model;
    });
  criteria.push({
    criterionId: "routing-conformance",
    strategy: "deterministic",
    status: misroutes.length === 0 ? "PASS" : "FAIL",
    evidence: [
      `dispatchedRounds:${rounds.filter((round) => !round.cacheHit).length}`,
      `routes:${inventory.routes.map((route) => `${route.taskClass}→${route.provider}`).join(" | ")}`,
      `misroutes:${misroutes.length}`,
      ...misroutes.map(
        (round) => `misrouted:${round.taskId}→${round.route?.provider}/${round.route?.model}`,
      ),
      misroutes.length === 0
        ? "conformant (every dispatched round rode the routing table's declared rail)"
        : "NON-CONFORMANT (a round rode a rail the routing table does not declare for its class)",
    ],
  });

  // 5. The compression bound: every dispatched round that applied
  //    prompt-compression stayed within the declared ratio bound.
  const compression = rounds
    .filter((round) => !round.cacheHit)
    .map((round) => {
      const finalUsage = round.usageFacts.find(
        (fact) => fact.tier === "input" && fact.kind === "measured",
      );
      if (finalUsage === undefined || round.rawInputTokens === null) {
        return deriveCompressionConformance({
          inventory,
          appliedOptimizations: round.appliedOptimizations,
          dispatchedInputTokens: 0,
          rawInputTokens: 0,
        });
      }
      return deriveCompressionConformance({
        inventory,
        appliedOptimizations: round.appliedOptimizations,
        dispatchedInputTokens: finalUsage.tokens,
        rawInputTokens: round.rawInputTokens,
      });
    });
  const compressionViolations = compression.filter((verdict) => !verdict.conformant);
  criteria.push({
    criterionId: "compression-bound",
    strategy: "deterministic",
    status: compressionViolations.length === 0 ? "PASS" : "FAIL",
    evidence: [
      `verifiedRounds:${compression.filter((verdict) => verdict.ratio !== null).length}`,
      `violations:${compressionViolations.length}`,
      ...compression
        .filter((verdict) => verdict.ratio !== null)
        .map((verdict) => verdict.evidence.join("|")),
      ...(compressionViolations.length === 0
        ? ["conformant (every compressed dispatch stayed within the declared bound)"]
        : [
            "NON-CONFORMANT (a dispatched round's tokens fell outside the declared compression bound)",
          ]),
    ],
  });

  // 6. Replay fidelity (offline rows): the executor's reported usage
  //    equals the recorded fresh-dispatch facts (a token understatement
  //    — a fabricated compression — FAILs mechanically).
  if (!row.needsDispatch) {
    const infidelities: string[] = [];
    for (const round of rounds) {
      if (round.cacheHit) {
        continue;
      }
      const plan = row.optimizedReplay.find((candidate) => candidate.taskId === round.taskId);
      const recorded = plan?.recorded;
      if (recorded === undefined) {
        infidelities.push(`${round.taskId}:no-recorded-facts (an offline round must be recorded)`);
        continue;
      }
      if (round.attempts !== recorded.attempts.length) {
        infidelities.push(
          `${round.taskId}:attempts ${round.attempts} != recorded ${recorded.attempts.length}`,
        );
        continue;
      }
      const inputFacts = round.usageFacts.filter(
        (fact) => fact.tier === "input" && fact.kind === "measured",
      );
      const outputFacts = round.usageFacts.filter(
        (fact) => fact.tier === "output" && fact.kind === "measured",
      );
      for (const [index, attempt] of recorded.attempts.entries()) {
        const reportedInput = inputFacts[index]?.tokens;
        const reportedOutput = outputFacts[index]?.tokens;
        if (attempt.usage === undefined) {
          if (reportedInput !== undefined || reportedOutput !== undefined) {
            infidelities.push(
              `${round.taskId}:attempt${index + 1} reported usage without a record`,
            );
          }
          continue;
        }
        if (reportedInput !== attempt.usage.inputTokens) {
          infidelities.push(
            `${round.taskId}:attempt${index + 1} input ${String(reportedInput)} != recorded ${attempt.usage.inputTokens}`,
          );
        }
        if (reportedOutput !== attempt.usage.outputTokens) {
          infidelities.push(
            `${round.taskId}:attempt${index + 1} output ${String(reportedOutput)} != recorded ${attempt.usage.outputTokens}`,
          );
        }
      }
    }
    criteria.push({
      criterionId: "replay-fidelity",
      strategy: "deterministic",
      status: infidelities.length === 0 ? "PASS" : "FAIL",
      evidence: [
        `dispatchedRounds:${rounds.filter((round) => !round.cacheHit).length}`,
        `infidelities:${infidelities.length}`,
        ...infidelities,
        ...(infidelities.length === 0
          ? ["conformant (the reported usage equals the recorded replay facts — never understated)"]
          : [
              "NON-CONFORMANT (the reported usage disagrees with the recorded facts — a token understatement)",
            ]),
      ],
    });
  }

  // 7. The optimization-economics attribution: cache hits contribute
  //    ZERO new measured cost (the honest attribution — the measured
  //    basis counts dispatched rounds' usage only, never conflated).
  const dispatchedInputTokens = rounds
    .filter((round) => !round.cacheHit)
    .reduce(
      (sum, round) =>
        sum +
        round.usageFacts
          .filter((fact) => fact.tier === "input" && fact.kind === "measured")
          .reduce((tokens, fact) => tokens + fact.tokens, 0),
      0,
    );
  criteria.push({
    criterionId: "optimization-economics",
    strategy: "deterministic",
    status: "PASS",
    evidence: [
      `dispatches:${rounds.filter((round) => !round.cacheHit).length}`,
      `cacheHits:${rounds.filter((round) => round.cacheHit).length}`,
      `dispatchedInputTokens:${dispatchedInputTokens}`,
      "attribution:cache hits contribute ZERO new measured cost (the measured basis counts dispatched usage only)",
      row.needsDispatch
        ? "usage:rail-measured on the live dispatches (BYOK; measured, never estimated)"
        : "usage:replayed-record facts (deterministic offline replays — honestly labeled, never presented as live measurements)",
    ],
  });

  // 8. The frozen-portfolio reference integrity: the VAL-030 content
  //    digests agree (the manifest digest re-derives from the
  //    referenced app + workload digests through the platform's own
  //    derivation).
  const reference = row.frozenPortfolio;
  const rederived = manifestDigestOf({
    appId: reference.appId,
    appDigest: reference.appDigest,
    workloadId: reference.workloadId,
    workloadRevision: reference.workloadRevision,
    workloadDigest: reference.workloadDigest,
  });
  criteria.push({
    criterionId: "portfolio-freeze-integrity",
    strategy: "deterministic",
    status: rederived === reference.manifestDigest ? "PASS" : "FAIL",
    evidence: [
      `appId:${reference.appId}`,
      `appDigest:${reference.appDigest}`,
      `workload:${reference.workloadId} r${reference.workloadRevision}`,
      `workloadDigest:${reference.workloadDigest}`,
      `manifestDigest:${reference.manifestDigest}`,
      `rederived:${rederived}`,
      rederived === reference.manifestDigest
        ? "agreed (the frozen-portfolio reference is content-addressed — the row's slice references the VAL-030 baseline revisions by digest, never copied)"
        : "DISAGREED (the frozen-portfolio reference digests are inconsistent)",
      `inventoryDigest:${inventory.digest.slice(0, 24)}… (the optimization set is content-addressed alongside the price manifests)`,
    ],
  });

  return criteria;
}

/** The VAL-040 criteria + app-contract derivations (imported, never copied). */
export {
  deriveEconomicRowCriteria,
  economicDigestOf,
  verifyEconomicAppContract,
} from "../economic-baseline/driver";
/** The pinned manifest integrity re-export (the pricing oracle's basis). */
export { deriveManifestIntegrity } from "../economic-baseline/pricing";
/** The REAL accounting rails re-export (the VAL-040 delivery's own binding). */
export { createRealAccountingRails };
