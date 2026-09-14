/**
 * The economic-controls-competing execution driver (VAL-043,
 * acceptance criteria 3, 4 and 5).
 *
 * Drives one competing-stack experiment row through the platform
 * path: the landed execution's chain runs the ARM DECISIONS BEFORE
 * DISPATCH (the DECLARED COMPETITOR CONFIGURATION revision + digest,
 * the model-selection table, the retry posture, the variance
 * declaration and — for fixed-cost arms — the per-round budget bound
 * priced from the pinned manifest, all recorded in the durable
 * planning decision BEFORE the first dispatch), then each
 * pre-registered round runs through the COMPETING stack:
 *
 *   * each round is ONE REQUEST through the competitor's own
 *     interface (the injected competing executor — the recorded
 *     competitor-interface replay offline, the REAL model gateway
 *     over the REAL OpenRouter rail live). The competitor's
 *     automatic-provider-fallback happens INSIDE its boundary: one
 *     request reports the AGGREGATE usage its gateway saw (internal
 *     attempts included — the amortization is the request's own
 *     measured usage, never a second request), bounded by the
 *     declared retry posture;
 *   * the fixed-cost budget gate fires BEFORE each dispatch (the
 *     pinned per-round bound is the worst case over the row's
 *     declared task classes' model selections — priced from the
 *     pinned manifest, never under-reserving);
 *   * the client-side bounded retry applies to RETRYABLE
 *     transport-level categories only (a request the competitor's
 *     interface failed terminally — after ITS OWN internal fallbacks
 *     — surfaces as the round's honest failure);
 *   * every round's usage converges through the normalization core
 *     onto the canonical micro-USD basis (per-fact through the
 *     ROUTED rail's pinned manifest entry; the rail's own reported
 *     charge rides as a CROSS-CHECK OBSERVATION only — never the
 *     basis), and every round is sealed + evaluated + aggregated
 *     through the INJECTED accounting rails (the REAL recorder, the
 *     REAL evaluation oracle and the REAL accounting aggregate —
 *     imported from the VAL-040 delivery, never copied, never
 *     modified);
 *   * the comparison is derived + validated against the frozen
 *     VAL-040 protocol (the Wilson 95% interval REQUIRED, the
 *     threshold attainment recomputed, the pre-registered slice
 *     enforced, the statistical minimums enforced).
 *
 * The competing-slice oracles (each mechanical): the
 * CONFIGURATION-CONFORMANCE oracle (an applied setting the declared
 * configuration does not name FAILs — the undocumented-toggle
 * masquerade catch), the CONFIGURATION-INTEGRITY oracle (the content
 * digest agreement — an in-place bound mutation FAILs), the
 * MODEL-SELECTION-CONFORMANCE oracle (a round riding a rail the
 * model-selection table does not declare for its class FAILs), the
 * RETRY-POSTURE-CONFORMANCE oracle (a request exceeding the declared
 * automatic-fallback bound FAILs), the BEHAVIOR-VARIANCE oracle (a
 * competitor behavior change between runs — nondeterministic routing
 * — either reproduces or FAILs unless declared as honest variance
 * with the confidence carried), the REPLAY-FIDELITY oracle (an
 * offline executor reporting usage that disagrees with the recorded
 * competitor-interface trace FAILs — the token-understatement catch),
 * the CHARGE-OBSERVATION-SEPARATION oracle (the rail's own charge is
 * an observation, never the basis — the mixed-basis conflation catch)
 * and the FROZEN-PORTFOLIO reference integrity (the VAL-030 content
 * digests agree).
 *
 * The verdict is MECHANICAL: any failure, any failed criterion →
 * verdict fail → terminal FAILED (never a partial-success shortcut).
 */

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
  type CompetitorConfigRevision,
  competitorConfigFor,
  deriveBehaviorVariance,
  deriveCompetitorConfigConformance,
  deriveCompetitorConfigIntegrity,
  deriveRetryPostureConformance,
  routeForClass,
} from "./competitor-config";

// ---------------------------------------------------------------------------
// The executor seam (the competing dispatch — INJECTED)
// ---------------------------------------------------------------------------

/** The usage one competitor request observed (the gateway's own report). */
export interface CompetitorRoundUsage {
  /** The request's aggregate input tokens (the gateway's report). */
  readonly inputTokens: number;
  /** The request's aggregate output tokens (the gateway's report). */
  readonly outputTokens: number;
  /** The currency the route's pinned price is denominated in (the manifest's own). */
  readonly currency: PriceCurrency;
  /**
   * The competitor's OWN reported charge for the request (its
   * generation-data cost field — a CROSS-CHECK OBSERVATION, never
   * the comparison basis).
   */
  readonly costUsd?: number;
}

/** The outcome of ONE request through the competitor's interface. */
export interface CompetitorRoundDispatchOutcome {
  readonly kind: "success" | "failure" | "skipped";
  readonly content?: string;
  readonly usage?: CompetitorRoundUsage;
  readonly category?: string;
  readonly message?: string;
  readonly latencyMs: number;
  readonly requestDigest: string;
  /** A competitor-side quote observed on the request (ESTIMATE facts — separate, never conflated). */
  readonly estimateQuote?: { readonly inputTokens: number; readonly outputTokens: number };
  readonly skipReason?: string;
  /** The model-selection route the request rode (null on skips). */
  readonly route: { readonly provider: string; readonly model: string } | null;
  /**
   * The pool endpoint the competitor's gateway routed the request to
   * (the observation the behavior-variance oracle keys on — null on
   * skips).
   */
  readonly routedEndpoint: string | null;
  /**
   * The internal attempts the competitor's automatic fallback made
   * for this ONE request (the retry amortization inside its
   * boundary; the reported usage is the aggregate).
   */
  readonly internalAttempts: number;
  /** The configuration settings the competitor applied to THIS request. */
  readonly appliedSettings: readonly string[];
}

/** The competing executor seam: one request per call. */
export type CompetitorExecutor = (input: {
  readonly executionId: string;
  readonly taskId: string;
  /** The client-side attempt number (the competitor's internal retries are inside one request). */
  readonly attempt: number;
  readonly taskClass: string;
}) => Promise<CompetitorRoundDispatchOutcome>;

// ---------------------------------------------------------------------------
// The corpus row contract (the oracle)
// ---------------------------------------------------------------------------

/** One recorded internal attempt of the competitor's automatic fallback. */
export interface CompetitorTraceAttempt {
  readonly outcome: "success" | "failure";
  /** The failure category (failures only). */
  readonly category?: string;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  readonly latencyMs: number;
}

/**
 * One recorded competitor-interface trace round: the request's task
 * class, the pool endpoint the gateway routed it to (the observation
 * the variance oracle keys on) and — for offline rows — the recorded
 * facts the replay executor settles (the internal attempts, the
 * gateway's OWN reported aggregate usage, the gateway's OWN reported
 * charge, the settled response).
 */
export interface CompetitorTraceRound {
  readonly taskId: string;
  /** The task class (the model-selection table's key). */
  readonly taskClass: string;
  /** The pool endpoint the competitor's gateway routed this request to (an observation). */
  readonly routedEndpoint: string;
  /** The recorded trace facts (offline rows; live rows leave absent). */
  readonly recorded?: {
    /** The internal attempts the automatic fallback made (bounded by the declared posture). */
    readonly internalAttempts: readonly CompetitorTraceAttempt[];
    /** The competitor's OWN reported usage for the request (the aggregate — the accounting basis). */
    readonly reportedUsage: { readonly inputTokens: number; readonly outputTokens: number };
    /** The competitor's OWN reported charge (USD — a cross-check observation, never the basis). */
    readonly reportedChargeUsd?: number;
    /** The response text the settled request produced (success requests). */
    readonly responseText?: string;
    /** A competitor-side quote observed on the request (estimate facts — separate). */
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
 * The competing-stack corpus row — structurally an economic corpus
 * row (the VAL-040 criteria derivations ride it unchanged) extended
 * with the competitor declarations: WHICH pinned configuration
 * revision declared the stack this row rode, and the per-round trace
 * plans (class + endpoint + the recorded competitor-interface facts).
 */
export interface CompetingCorpusRow {
  readonly rowId: string;
  readonly description: string;
  /** The arm manifest entry (the VAL-040 frozen grammar). */
  readonly arm: EconomicArm;
  /**
   * WHICH pinned competitor-configuration revision declared this
   * row's stack (content-addressed alongside the price manifests).
   */
  readonly competitorConfigRevision: string;
  /** The per-round trace plans (class/endpoint + the recorded facts). */
  readonly competingReplay: readonly CompetitorTraceRound[];
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

/** One driven competing round (one request through the competitor's interface). */
export interface CompetingDrivenRound extends DrivenRoundResult {
  /** The task class the round ran under (the model-selection table's key). */
  readonly taskClass: string;
  /** The model-selection route the round's request rode (null on skips). */
  readonly route: { readonly provider: string; readonly model: string } | null;
  /** The pool endpoint the gateway routed the request to (the variance observation). */
  readonly routedEndpoint: string | null;
  /** The internal attempts the competitor's automatic fallback made for the request. */
  readonly internalAttempts: number;
  /** The configuration settings the competitor applied to the round's request. */
  readonly appliedSettings: readonly string[];
  /** The competitor's own charge observation for the request (never the basis). */
  readonly chargeObservationUsd: number | null;
}

/** The full competing row run result (the honest outcome contract). */
export interface CompetingRunResult extends EconomicRunResult {
  readonly rounds: readonly CompetingDrivenRound[];
}

// ---------------------------------------------------------------------------
// The chain options + the execution chain
// ---------------------------------------------------------------------------

interface ChainOptions {
  readonly executionId: string;
  readonly row: CompetingCorpusRow;
  readonly lifecycle: EconomicLifecyclePort;
  readonly executor: CompetitorExecutor;
  readonly rails: EconomicAccountingRails;
  readonly tasks: readonly GoldenTask[];
  readonly manifest: PriceManifestRevision;
  readonly config: CompetitorConfigRevision;
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
}

/** Generate the next per-call key fragment (per-decision distinct). */
function nextCallKey(counter: { count: number }): string {
  counter.count += 1;
  return `k${counter.count}`;
}

/** The derived observed outcome of one request round (PURE — the final request decides). */
function observedOutcomeOfRequest(finalOutcome: CompetitorRoundDispatchOutcome): ObservedOutcome {
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
 * Derive the worst-case micro-USD cost of ONE request round over the
 * model selections of the ROW'S DECLARED TASK CLASSES (PURE — the
 * conservative fixed-cost bound: the pinned max tokens priced at BOTH
 * tiers of every route the row's rounds can ride, the fallback
 * included; a BATCHED route's worst case rounds the pinned max tokens
 * UP to the whole batch increment before pricing — composing the
 * manifest's own metering semantics with the frozen VAL-040 per-token
 * pricer so the gate never under-reserves).
 */
export function deriveCompetingRoundBudgetBoundMicroUsd(input: {
  readonly manifest: PriceManifestRevision;
  readonly config: CompetitorConfigRevision;
  /** The task classes the row's rounds declare (the routes they can ride). */
  readonly taskClasses: readonly string[];
  readonly maxTokens: number;
}): string {
  const classes = new Set(input.taskClasses);
  const routes = [
    ...input.config.routes.filter((route) => classes.has(route.taskClass)),
    input.config.fallbackRoute,
  ];
  const bounds = routes.map((route) => {
    // A batched route's worst case: the pinned max tokens rounded UP
    // to the whole batch increment (the manifest's own metering
    // semantics — resolved through the pinned entry, never assumed).
    const entry = resolveListPrice(input.manifest, route.provider, route.model, "input");
    const batch =
      entry !== null && entry.metering === "batched" && Number.isInteger(entry.batchSize)
        ? Math.max(1, entry.batchSize ?? 1)
        : 1;
    const worstTokens = Math.ceil(Math.max(0, input.maxTokens) / batch) * batch;
    return BigInt(
      deriveRoundBudgetBoundMicroUsd({
        manifest: input.manifest,
        provider: route.provider,
        model: route.model,
        maxTokens: worstTokens,
      }),
    );
  });
  return bounds.reduce((max, bound) => (bound > max ? bound : max)).toString();
}

/**
 * The task classes a row's rounds declare (PURE — the distinct
 * classes of the row's trace plans, in first-appearance order).
 */
export function taskClassesOfRow(row: CompetingCorpusRow): readonly string[] {
  const classes: string[] = [];
  for (const plan of row.competingReplay) {
    if (!classes.includes(plan.taskClass)) {
      classes.push(plan.taskClass);
    }
  }
  return classes;
}

/**
 * Drive ONE landed execution's competing machinery: authorize → plan
 * → the durable planning decision carrying the ARM DECISIONS (the
 * declared competitor configuration revision + digest + the
 * model-selection table + the retry posture + the variance
 * declaration + the fixed-cost budget bound — BEFORE the first
 * request) → queue → start → the pre-registered rounds (the
 * fixed-cost budget gate before each request; the client-side
 * bounded retry; the competitor's requests with their aggregate
 * usage; the normalized, sealed, evaluated accounting) → the rounds'
 * return. Any failure is honest (never a partial-success shortcut).
 */
async function driveCompetingChain(options: ChainOptions): Promise<{
  readonly rounds: readonly CompetingDrivenRound[];
  readonly budgetStopAfter: number | null;
  readonly usageFacts: readonly UsageFact[];
  readonly failure: { readonly category: string; readonly message: string } | null;
  readonly journal: readonly EconomicJournalRecord[];
}> {
  const { executionId, row, lifecycle, executor, rails } = options;
  const key = (): string => nextCallKey(options.keyCounter);
  const journal: EconomicJournalRecord[] = [];
  const usageFacts: UsageFact[] = [];
  const rounds: CompetingDrivenRound[] = [];
  let failure: { category: string; message: string } | null = null;
  let budgetStopAfter: number | null = null;
  const plans = new Map(row.competingReplay.map((plan) => [plan.taskId, plan]));

  // ---- the canonical prologue ----
  await lifecycle.transition({
    executionId,
    step: "authorize",
    reason: "val-043-authorize",
    callKey: key(),
  });
  await lifecycle.transition({ executionId, step: "plan", reason: "val-043-plan", callKey: key() });

  // ---- the ARM DECISIONS (made BEFORE any request) ----
  // The DECLARED COMPETITOR CONFIGURATION (the revision + digest +
  // the model-selection table + the retry posture + the variance
  // declaration) and — for fixed-cost arms — the budget plan (the
  // pinned budget, the per-round worst-case bound priced from the
  // pinned manifest over the row's declared classes' selections, the
  // declared stop rule). The decision is DURABLE before the first
  // request: the competing stack's whole configuration posture is
  // pinned before anything dispatches.
  const rowClasses = taskClassesOfRow(row);
  const roundBoundMicroUsd =
    row.arm.kind === "fixed-cost"
      ? deriveCompetingRoundBudgetBoundMicroUsd({
          manifest: options.manifest,
          config: options.config,
          taskClasses: rowClasses,
          maxTokens: row.arm.maxTokensPerRound,
        })
      : null;
  const armDecision: Record<string, unknown> = {
    kind:
      row.arm.kind === "fixed-cost"
        ? "competing-fixed-cost-budget-plan"
        : "competing-fixed-quality-plan",
    competitorConfigRevision: row.competitorConfigRevision,
    competitorConfigDigest: options.config.digest,
    competitorStack: "openrouter-gateway (the competing instantiation)",
    modelSelection: options.config.routes.map((route) => ({
      taskClass: route.taskClass,
      provider: route.provider,
      model: route.model,
    })),
    fallbackSelection: {
      taskClass: options.config.fallbackRoute.taskClass,
      provider: options.config.fallbackRoute.provider,
      model: options.config.fallbackRoute.model,
    },
    retryPosture: {
      maxInternalRetries: options.config.entries.find(
        (entry) => entry.name === "automatic-provider-fallback",
      )?.bound.maxInternalRetries,
      accounting:
        "the internal retries amortize INSIDE the competitor's boundary (one request, aggregate usage)",
    },
    varianceDeclaration:
      "the pool routing is declared honest variance (nondeterministic routing carried with the Wilson 95% interval)",
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
      strategyClass: "economic-controls-competing",
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
    reason: "val-043-queue",
    callKey: key(),
  });
  await lifecycle.transition({
    executionId,
    step: "start",
    reason: "val-043-start",
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
        message: `the pre-registered task ${taskId} has no golden task or trace plan in the slice corpus`,
      };
      break;
    }

    // ---- the fixed-cost budget gate — BEFORE the request ----
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

    // ---- the request loop (client-side bounded retry on RETRYABLE
    //      transport categories only; the competitor's OWN internal
    //      fallback happens inside each request) ----
    const requestOutcomes: CompetitorRoundDispatchOutcome[] = [];
    let finalOutcome: CompetitorRoundDispatchOutcome | null = null;
    let skipped = false;
    for (let attempt = 1; ; attempt += 1) {
      const outcome = await executor({
        executionId,
        taskId,
        attempt,
        taskClass: plan.taskClass,
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
        requestOutcomes.push(outcome);
        break;
      }
      const retryable = isRetryableDispatchCategory(outcome.category ?? "");
      if (!retryable || attempt > options.retry.maxExtraAttempts) {
        finalOutcome = outcome;
        requestOutcomes.push(outcome);
        break;
      }
      requestOutcomes.push(outcome);
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
        message: `the round ${taskId} never settled a request outcome`,
      };
      break;
    }

    // ---- the usage facts: each REQUEST's aggregate usage prices
    //      through the ROUTED rail (the competitor's internal retry
    //      amortization is INSIDE the aggregate — the honest
    //      granularity of its interface); the final request carries
    //      direct-execution scope, client-side retries carry
    //      retry-overhead; the competitor-side quote rides as a
    //      SEPARATE estimate fact ----
    const roundFacts: UsageFact[] = [];
    for (const [index, outcome] of requestOutcomes.entries()) {
      const isFinal = index === requestOutcomes.length - 1;
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
    const observed = observedOutcomeOfRequest(finalOutcome);
    const latencyMs = requestOutcomes.reduce((sum, outcome) => sum + outcome.latencyMs, 0);
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
      source: `val-043:${row.rowId}:${options.manifest.revision}`,
      scope: fact.scope,
    }));
    measuredSoFarMicroUsd += BigInt(basis.measuredMicroUsd);

    // ---- the round's journal record (the settled request — digests only) ----
    {
      const record: EconomicJournalRecord = {
        ordinal: journal.length + 1,
        kind: finalOutcome.kind === "success" ? "round" : "failure",
        digest: economicDigestOf({
          taskId,
          requests: requestOutcomes.length,
          requestDigest: finalOutcome.requestDigest,
          verdict: evaluation.verdict,
          route: finalOutcome.route,
          routedEndpoint: finalOutcome.routedEndpoint,
          internalAttempts: finalOutcome.internalAttempts,
        }),
        detail: `round:${taskId}:${finalOutcome.kind}:${finalOutcome.routedEndpoint ?? "none"} (internalAttempts ${finalOutcome.internalAttempts})`,
      };
      journal.push(record);
      await lifecycle.recordStepEvent({ executionId, record });
    }

    // ---- the round's accounted run: sealed through the REAL recorder ----
    const roundStart = options.now().toISOString();
    const events: RoundAccountingInput["events"] = [
      { kind: "run-start", data: { corpusTask: taskId, arm: row.arm.armId }, at: roundStart },
      ...requestOutcomes.map((outcome, index) => ({
        kind: (outcome.kind === "failure" && index === requestOutcomes.length - 1
          ? "error-surfaced"
          : "model-choice") as RoundAccountingInput["events"][number]["kind"],
        data: {
          ...(outcome.kind === "failure" && index === requestOutcomes.length - 1
            ? { code: outcome.category ?? "unknown", retryable: false }
            : {
                requestDigest: outcome.requestDigest,
                request: index + 1,
                route: outcome.route,
                routedEndpoint: outcome.routedEndpoint,
                internalAttempts: outcome.internalAttempts,
                appliedSettings: [...outcome.appliedSettings],
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

    rounds.push({
      taskId,
      executed: true,
      attempts: requestOutcomes.length,
      observed,
      usageFacts: roundFacts,
      latencyMs,
      record,
      evaluation,
      taskClass: plan.taskClass,
      route: finalOutcome.route,
      routedEndpoint: finalOutcome.routedEndpoint,
      internalAttempts: finalOutcome.internalAttempts,
      appliedSettings: [...finalOutcome.appliedSettings],
      chargeObservationUsd: finalOutcome.usage?.costUsd ?? null,
    });
  }

  return { rounds, budgetStopAfter, usageFacts, failure, journal };
}

// ---------------------------------------------------------------------------
// The row driver
// ---------------------------------------------------------------------------

/**
 * Drive one competing-stack corpus row to settlement through the
 * platform path: the landed execution's competing chain (the arm
 * decisions BEFORE dispatch → the pre-registered rounds with the
 * budget gate before each request and the client-side bounded retry
 * → the normalized, sealed, evaluated, aggregated accounting), the
 * observed terminal READ BACK from the ledger, the normalized
 * comparison derived + validated against the frozen VAL-040 protocol,
 * and the row-level mechanical criteria (the VAL-040 criteria families
 * + the competing-slice oracles). The honest terminal is FAILED when
 * any failure was observed, any criterion failed or any comparison
 * violation surfaced — never a partial-success shortcut.
 */
export async function driveCompetingRow(options: {
  readonly row: CompetingCorpusRow;
  readonly lifecycle: EconomicLifecyclePort;
  /** The competing dispatch executor (recorded trace replay offline; REAL gateway live). */
  readonly executor: CompetitorExecutor;
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
  /** An override configuration (the discrimination battery's mutated bounds). */
  readonly configOverride?: CompetitorConfigRevision;
  /** The arm's own threshold claim (never trusted — the gaming catch). */
  readonly claimedThresholdMet?: boolean;
}): Promise<CompetingRunResult> {
  const runStartedAt = options.now().getTime();
  const keyCounter = { count: 0 };
  const manifest = options.manifestOverride ?? manifestFor(options.row.arm.priceRevision);
  const config =
    options.configOverride ?? competitorConfigFor(options.row.competitorConfigRevision);
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
    };
  }
  const executionId = landed[0];

  const chain = await driveCompetingChain({
    executionId,
    row: options.row,
    lifecycle: options.lifecycle,
    executor: options.executor,
    rails: options.rails,
    tasks: options.tasks,
    manifest,
    config,
    metadata: options.metadata,
    environmentIdentity: options.environmentIdentity,
    corpusVersion: options.corpusVersion,
    retry: options.retry,
    now: options.now,
    keyCounter,
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
      // The comparison verifies the manifest that ACTUALLY priced
      // the runs (the registry's declared revision, or the override
      // the discrimination battery injected — a mutated table with a
      // stale digest fails its own digest integrity mechanically).
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
    reason: "val-043-verify",
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
    ...deriveCompetingSliceCriteria({
      row: options.row,
      rounds: chain.rounds,
      config,
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
        ? "val-043-verified"
        : `val-043-${chain.failure?.category ?? "protocol-violation"}`,
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
  };
}

// ---------------------------------------------------------------------------
// The competing-slice oracles (the mechanical verification)
// ---------------------------------------------------------------------------

/**
 * Derive the competing-slice criteria (PURE — the VAL-043 verification
 * core): the configuration-conformance oracle (an UNDOCUMENTED
 * configuration toggle FAILs — the masquerade catch), the
 * configuration-integrity oracle (the content-digest agreement), the
 * model-selection-conformance oracle (a request riding a rail the
 * model-selection table does not declare for its class FAILs), the
 * retry-posture-conformance oracle (a request exceeding the declared
 * automatic-fallback bound FAILs), the behavior-variance oracle (a
 * competitor behavior change between runs either reproduces or FAILs
 * unless declared as honest variance with the confidence carried),
 * the replay-fidelity oracle (the offline executor's reported usage
 * equals the recorded competitor-interface trace — the
 * token-understatement catch), the charge-observation-separation
 * oracle (the rail's own charge is an observation, never the basis)
 * and the frozen-portfolio reference integrity (the VAL-030 content
 * digests agree).
 */
export function deriveCompetingSliceCriteria(input: {
  readonly row: CompetingCorpusRow;
  readonly rounds: readonly CompetingDrivenRound[];
  readonly config: CompetitorConfigRevision;
}): readonly LabVerificationCriterion[] {
  const { row, rounds, config } = input;
  const criteria: LabVerificationCriterion[] = [];

  // 1. Configuration conformance: every APPLIED setting is declared
  //    (the undocumented-toggle masquerade catch — the verification
  //    core).
  const appliedSettings = rounds.flatMap((round) => round.appliedSettings);
  const conformance = deriveCompetitorConfigConformance({
    config,
    appliedSettings,
  });
  criteria.push({
    criterionId: "configuration-conformance",
    strategy: "deterministic",
    status: conformance.conformant ? "PASS" : "FAIL",
    evidence: [
      `configRevision:${config.revision}`,
      ...conformance.evidence,
      ...(conformance.conformant
        ? []
        : [
            "the undocumented-configuration masquerade: something the competitor does that its declared configuration does not name FAILs mechanically",
          ]),
    ],
  });

  // 2. Configuration integrity: the digest of the configuration that
  //    ACTUALLY declared this run's stack (the registry's pinned
  //    revision, or the override the discrimination battery injected
  //    — an in-place bound mutation with a stale digest fails its own
  //    digest integrity mechanically).
  const integrity = deriveCompetitorConfigIntegrity({
    revision: config.revision,
    registry: [config],
  });
  criteria.push({
    criterionId: "configuration-integrity",
    strategy: "deterministic",
    status: integrity.agreed ? "PASS" : "FAIL",
    evidence: integrity.evidence,
  });

  // 3. Model-selection conformance: every round's request rode the
  //    model-selection table's route for its class (the fallback for
  //    unnamed classes).
  const misroutes = rounds
    .filter((round) => round.route !== null)
    .filter((round) => {
      const expected = routeForClass(config, round.taskClass);
      return round.route?.provider !== expected.provider || round.route?.model !== expected.model;
    });
  criteria.push({
    criterionId: "model-selection-conformance",
    strategy: "deterministic",
    status: misroutes.length === 0 ? "PASS" : "FAIL",
    evidence: [
      `requests:${rounds.length}`,
      `selections:${config.routes.map((route) => `${route.taskClass}→${route.provider}`).join(" | ")}`,
      `misroutes:${misroutes.length}`,
      ...misroutes.map(
        (round) => `misrouted:${round.taskId}→${round.route?.provider}/${round.route?.model}`,
      ),
      misroutes.length === 0
        ? "conformant (every request rode the model-selection table's declared rail for its class)"
        : "NON-CONFORMANT (a request rode a rail the model-selection table does not declare for its class)",
    ],
  });

  // 4. Retry-posture conformance: every request's internal attempts
  //    stayed within the declared automatic-fallback bound.
  const posture = deriveRetryPostureConformance({
    config,
    observations: rounds.map((round) => ({
      taskId: round.taskId,
      internalAttempts: round.internalAttempts,
    })),
  });
  criteria.push({
    criterionId: "retry-posture-conformance",
    strategy: "deterministic",
    status: posture.conformant ? "PASS" : "FAIL",
    evidence: posture.evidence,
  });

  // 5. Behavior variance (the reproducibility oracle): the
  //    competitor's routing either reproduces or the variance is
  //    DECLARED honest variance (the Wilson 95% confidence carries
  //    the comparison — enforced by the protocol battery, never
  //    waived).
  const variance = deriveBehaviorVariance({
    config,
    observations: rounds
      .filter((round) => round.routedEndpoint !== null)
      .map((round) => ({
        taskClass: round.taskClass,
        routedEndpoint: round.routedEndpoint as string,
      })),
  });
  criteria.push({
    criterionId: "behavior-variance-declared",
    strategy: "deterministic",
    status: variance.conformant ? "PASS" : "FAIL",
    evidence: variance.evidence,
  });

  // 6. Replay fidelity (offline rows): the executor's reported usage
  //    equals the recorded competitor-interface trace (a token
  //    understatement — a fabricated amortization — FAILs
  //    mechanically), and the observed endpoint/internal-attempt
  //    counts match the recorded trace.
  if (!row.needsDispatch) {
    const infidelities: string[] = [];
    for (const round of rounds) {
      const plan = row.competingReplay.find((candidate) => candidate.taskId === round.taskId);
      const recorded = plan?.recorded;
      if (recorded === undefined) {
        infidelities.push(`${round.taskId}:no-recorded-trace (an offline round must be recorded)`);
        continue;
      }
      const inputFacts = round.usageFacts.filter(
        (fact) => fact.tier === "input" && fact.kind === "measured",
      );
      const outputFacts = round.usageFacts.filter(
        (fact) => fact.tier === "output" && fact.kind === "measured",
      );
      // One request = one aggregate fact pair (the competitor's
      // interface granularity); the client-side attempt index maps
      // 1:1 (the offline traces carry no client-side retries).
      const reportedInput = inputFacts[0]?.tokens;
      const reportedOutput = outputFacts[0]?.tokens;
      if (reportedInput !== recorded.reportedUsage.inputTokens) {
        infidelities.push(
          `${round.taskId}:input ${String(reportedInput)} != recorded aggregate ${recorded.reportedUsage.inputTokens}`,
        );
      }
      if (reportedOutput !== recorded.reportedUsage.outputTokens) {
        infidelities.push(
          `${round.taskId}:output ${String(reportedOutput)} != recorded aggregate ${recorded.reportedUsage.outputTokens}`,
        );
      }
      if (round.internalAttempts !== recorded.internalAttempts.length) {
        infidelities.push(
          `${round.taskId}:internalAttempts ${round.internalAttempts} != recorded ${recorded.internalAttempts.length}`,
        );
      }
      if (round.routedEndpoint !== plan?.routedEndpoint) {
        infidelities.push(
          `${round.taskId}:endpoint ${round.routedEndpoint ?? "none"} != recorded ${plan?.routedEndpoint ?? "none"}`,
        );
      }
    }
    criteria.push({
      criterionId: "replay-fidelity",
      strategy: "deterministic",
      status: infidelities.length === 0 ? "PASS" : "FAIL",
      evidence: [
        `requests:${rounds.length}`,
        `infidelities:${infidelities.length}`,
        ...infidelities,
        ...(infidelities.length === 0
          ? [
              "conformant (the reported usage equals the recorded competitor-interface trace — the aggregate the gateway saw, never understated)",
            ]
          : [
              "NON-CONFORMANT (the reported usage or observations disagree with the recorded trace — a token understatement or a fabricated amortization)",
            ]),
      ],
    });
  }

  // 7. Charge-observation separation: the competitor's own reported
  //    charges are CROSS-CHECK OBSERVATIONS ONLY — every sealed cost
  //    fact's source is manifest-priced (the pinned revision), and
  //    every round that observed a charge also carries measured
  //    manifest-normalized usage facts (the mixed-basis conflation
  //    catch: a cost-per-resolved computed from the rail's own
  //    charge amounts instead of the manifest-priced tokens).
  const roundsWithCharge = rounds.filter((round) => round.chargeObservationUsd !== null);
  const chargelessUsage = roundsWithCharge.filter(
    (round) => round.usageFacts.filter((fact) => fact.kind === "measured").length === 0,
  );
  const manifestPricedSources = rounds.every((round) =>
    round.record.cost.every((fact) => fact.source.includes(`:${row.arm.priceRevision}`)),
  );
  const separationOk = chargelessUsage.length === 0 && manifestPricedSources;
  criteria.push({
    criterionId: "charge-observation-separation",
    strategy: "deterministic",
    status: separationOk ? "PASS" : "FAIL",
    evidence: [
      `chargeObservations:${roundsWithCharge.length}`,
      `chargelessMeasuredUsage:${chargelessUsage.length}`,
      `manifestPricedCostFacts:${String(manifestPricedSources)}`,
      ...(roundsWithCharge.length === 0
        ? []
        : [
            `observedCharges:${roundsWithCharge
              .map((round) => `${round.taskId}=${round.chargeObservationUsd?.toFixed(6)}USD`)
              .join(" ")}`,
          ]),
      separationOk
        ? "separated (the rail's own charges are cross-check observations only; the canonical basis prices measured tokens through the pinned manifest — every arm compares at the SAME public list prices)"
        : "CONFLATED (a charge observation without measured usage, or a cost fact outside the manifest basis — the mixed-basis conflation)",
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
      `configDigest:${config.digest.slice(0, 24)}… (the competitor configuration is content-addressed alongside the price manifests)`,
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
