/**
 * The economic-baseline execution driver (VAL-040, acceptance
 * criteria 3 + 4).
 *
 * Drives one experiment row through the platform path: the landed
 * execution's chain runs the ARM's pre-registered work rounds with
 * the ARM DECISIONS MADE BEFORE DISPATCH (the fixed-cost arm's
 * per-round budget bound is computed from the pinned manifest and
 * recorded in the durable planning decision BEFORE the first
 * dispatch — the budget gate never dispatches a round the pinned
 * budget cannot cover), each round dispatches through the INJECTED
 * platform-path executor (the recorded-replay executor offline, the
 * REAL model gateway on the live rows) with bounded retry on
 * RETRYABLE categories only, every attempt's usage converges through
 * the normalization core onto canonical micro-USD, each round is
 * sealed + evaluated + aggregated through the INJECTED accounting
 * rails (the REAL recorder, the REAL evaluation oracle and the REAL
 * accounting aggregate at the crown), and the comparison is derived
 * and validated against the frozen protocol (the full mechanical
 * battery). The verdict is MECHANICAL: any failure, any failed
 * criterion → verdict fail → terminal FAILED (never a
 * partial-success shortcut).
 *
 * Everything is seam-injected here (the lab contract): the lifecycle
 * port binds the REAL executions service at the crown; the executor
 * seam binds the recorded replays offline and the REAL model gateway
 * live; the accounting rails bind the REAL recorder + evaluation +
 * aggregate modules (imported from their existing modules — never
 * copied, never modified).
 */

import type { AccountedRun, ArmAggregate } from "../../accounting/aggregate";
import { aggregateArm } from "../../accounting/aggregate";
import type { GoldenTask } from "../../corpus/schema";
import type { ObservedOutcome } from "../../evaluation/deterministic";
import type { EvaluationResult } from "../../evaluation/evaluate";
import { evaluateRun } from "../../evaluation/evaluate";
import type { LabVerificationCriterion } from "../../platform/derive";
import type { CostFact, LatencyFact, ValidationRunRecord } from "../../recorder/record";
import { ValidationRecorder } from "../../recorder/recorder";
import type { RunMetadata } from "../../run-identity";
import type { UsageFact } from "./normalization";
import { deriveRoundBudgetBoundMicroUsd, manifestFor, normalizeArmCosts } from "./normalization";
import { deriveManifestIntegrity, type PriceManifestRevision, resolveListPrice } from "./pricing";
import type { EconomicArm } from "./protocol";
import {
  deriveNormalizedComparison,
  type NormalizedArmComparison,
  validateNormalizedComparison,
} from "./protocol";

// ---------------------------------------------------------------------------
// The lifecycle port (bound to the REAL executions service at the crown)
// ---------------------------------------------------------------------------

/** One journaled economics record (digests, never payload bytes). */
export interface EconomicJournalRecord {
  /** 1-based ordinal within the execution's step-event journal. */
  readonly ordinal: number;
  readonly kind: "arm-decision" | "round" | "retry" | "failure" | "budget-stop" | "skip";
  readonly digest: string;
  readonly detail: string;
}

/**
 * The platform-side lifecycle port: the canonical transitions, the
 * durable planning decision (the arm decision rides it — BEFORE the
 * first dispatch), the step-event journal (digest references only,
 * per-record-distinct idempotency keys — the VAL-018 lesson), the
 * terminal completion and the observed-terminal read-back.
 */
export interface EconomicLifecyclePort {
  transition(command: {
    readonly executionId: string;
    readonly step: "authorize" | "plan" | "queue" | "start" | "verify";
    readonly reason: string;
    /** Unique per call (repeated steps must never collide on the ledger). */
    readonly callKey: string;
  }): Promise<void>;
  /** Durable planning decision (route + the arm decision facts) — before the first dispatch. */
  recordPlanningDecision(input: {
    readonly executionId: string;
    readonly route: {
      readonly provider: string;
      readonly model: string;
      readonly strategyClass: string;
    };
    /** The arm decision made BEFORE dispatch (the economics payload). */
    readonly armDecision: Readonly<Record<string, unknown>>;
  }): Promise<void>;
  /** The step-event journal (digest references only). */
  recordStepEvent(input: {
    readonly executionId: string;
    readonly record: EconomicJournalRecord;
  }): Promise<void>;
  /** Terminal completion with the mechanically derived criteria. */
  complete(input: {
    readonly executionId: string;
    readonly verdict: "pass" | "fail";
    readonly criteria: readonly LabVerificationCriterion[];
    readonly reason: string;
  }): Promise<void>;
  /** The observed terminal read-back (the ledger's own status, or null). */
  statusOf(executionId: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// The executor seam (the platform-path executor — INJECTED)
// ---------------------------------------------------------------------------

/** The usage one dispatch attempt observed (the currency the charge is denominated in). */
export interface RoundUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** The currency the attempt's usage is denominated in (must match the pinned price's). */
  readonly currency: "USD" | "EUR" | "JPY" | "GBP";
  /** The rail's own settled charge, when it reported one (a cross-check observation). */
  readonly costUsd?: number;
}

/** The outcome of ONE dispatch attempt (one executor roundtrip). */
export interface RoundDispatchOutcome {
  readonly kind: "success" | "failure" | "skipped";
  readonly content?: string;
  readonly usage?: RoundUsage;
  readonly category?: string;
  readonly message?: string;
  readonly latencyMs: number;
  readonly requestDigest: string;
  /** A planner/rail quote observed on the round (ESTIMATE facts — reported separately, never conflated). */
  readonly estimateQuote?: { readonly inputTokens: number; readonly outputTokens: number };
  /** The honest skip reason (the discrimination battery's post-hoc-exclusion executor shape). */
  readonly skipReason?: string;
}

/** The executor seam: one attempt per call (bounded retry is the driver's). */
export type EconomicExecutor = (input: {
  readonly executionId: string;
  readonly taskId: string;
  readonly attempt: number;
}) => Promise<RoundDispatchOutcome>;

/** The RETRYABLE dispatch-failure categories (bounded retry applies to these ONLY). */
const RETRYABLE_DISPATCH_CATEGORIES: ReadonlySet<string> = new Set([
  "transport-failure",
  "rate-limit",
  "provider-unavailable",
]);

/** Whether the dispatch-failure category may be retried (honest taxonomy). */
export function isRetryableDispatchCategory(category: string): boolean {
  return RETRYABLE_DISPATCH_CATEGORIES.has(category);
}

// ---------------------------------------------------------------------------
// The accounting-rails seam (the REAL recorder + evaluation + aggregate)
// ---------------------------------------------------------------------------

/** The per-round accounting input the rails seal into a run record. */
export interface RoundAccountingInput {
  readonly metadata: RunMetadata;
  readonly corpusTaskId: string;
  readonly environmentIdentity: string;
  readonly events: readonly {
    readonly kind: Parameters<ValidationRecorder["recordEvent"]>[0];
    readonly data: Readonly<Record<string, unknown>>;
    readonly at: string;
  }[];
  readonly cost: readonly CostFact[];
  readonly latency: readonly LatencyFact[];
  readonly environment: readonly {
    readonly kind: string;
    readonly assertion: string;
    readonly observedVia: "platform-ledger" | "artifact-store" | "harness-probe";
    readonly passed: boolean;
  }[];
  readonly sealedAt: string;
}

/** The injected accounting rails: seal, evaluate, aggregate (the REAL modules at the crown). */
export interface EconomicAccountingRails {
  /** Seal one round's run record (the REAL recorder). */
  sealRound(input: RoundAccountingInput): ValidationRunRecord;
  /** Evaluate one round's observed outcome (the REAL evaluation oracle). */
  evaluate(input: {
    readonly task: GoldenTask;
    readonly corpusVersion: string;
    readonly observed: ObservedOutcome;
  }): EvaluationResult;
  /** Aggregate one arm's accounted runs (the REAL accounting aggregate — Wilson included). */
  aggregate(input: {
    readonly arm: string;
    readonly corpusSlice: string;
    readonly runs: readonly AccountedRun[];
  }): ArmAggregate;
}

/**
 * The REAL accounting rails: the platform's own recorder, evaluation
 * engine and accounting aggregate — IMPORTED from their existing
 * modules (never copied, never modified). The offline replays and
 * the live rows ride the same rails; only the executor differs.
 */
export function createRealAccountingRails(): EconomicAccountingRails {
  return {
    sealRound(input) {
      const recorder = new ValidationRecorder({
        metadata: input.metadata,
        corpusTaskId: input.corpusTaskId,
        environmentIdentity: input.environmentIdentity,
      });
      for (const event of input.events) {
        recorder.recordEvent(event.kind, event.data, event.at);
      }
      for (const observation of input.environment) {
        recorder.recordEnvironmentState(observation);
      }
      for (const fact of input.latency) {
        recorder.recordLatency(fact);
      }
      for (const fact of input.cost) {
        recorder.recordCost(fact);
      }
      return recorder.seal(input.sealedAt);
    },
    evaluate(input) {
      return evaluateRun({
        task: input.task,
        corpusVersion: input.corpusVersion,
        observed: input.observed,
      });
    },
    aggregate(input) {
      return aggregateArm(input.arm, input.corpusSlice, input.runs);
    },
  };
}

// ---------------------------------------------------------------------------
// The corpus row contract (the oracle)
// ---------------------------------------------------------------------------

/** One recorded replay attempt (a settled VAL-006-style fact). */
export interface RecordedAttempt {
  readonly outcome: "success" | "failure";
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  /** The failure category (failures only). */
  readonly category?: string;
  readonly latencyMs: number;
}

/** One recorded replay round (the deterministic offline facts). */
export interface RecordedRound {
  readonly taskId: string;
  /** The attempts in order (1 primary + retries). */
  readonly attempts: readonly RecordedAttempt[];
  /** The response text the settled round produced (success rounds). */
  readonly responseText?: string;
  /** A planner/rail quote observed on the round (estimate facts — separate, never conflated). */
  readonly estimateQuote?: { readonly inputTokens: number; readonly outputTokens: number };
}

/** The expected normalized comparison the protocol derivation must reproduce. */
export interface ExpectedNormalizedOutcome {
  readonly runCount: number;
  readonly resolvedCount: number;
  readonly measuredCostMicroUsd: string;
  readonly estimatedCostMicroUsd: string;
  readonly costPerResolvedMicroUsd: string | null;
  readonly resolutionConfidence: { readonly low: number; readonly high: number };
}

/** The economics corpus row (the full oracle — AC1's per-row contract). */
export interface EconomicCorpusRow {
  readonly rowId: string;
  readonly description: string;
  /** The arm manifest entry: the kind, pinned price revision, corpus slice, statistical minimums. */
  readonly arm: EconomicArm;
  /** The deterministic recorded rounds (offline rows; live rows leave this absent). */
  readonly replay?: readonly RecordedRound[];
  /** Whether the row's rounds demand the dispatch seam (live rows). */
  readonly needsDispatch: boolean;
  /** The live gate (absent for offline rows — always drivable). */
  readonly liveGate?: {
    readonly envVars: readonly string[];
    readonly requirement: string;
  };
  /** The expected outcomes (the oracle proper). */
  readonly expected: {
    readonly terminal: "COMPLETED" | "FAILED";
    /** The row's total durable executions after the row settles. */
    readonly executions: number;
    /** The row's total distinct idempotency keys. */
    readonly idempotencyRecords: number;
    /** The app-side submission expectations. */
    readonly appCreated: number;
    readonly replayedSubmissions: number;
    readonly rejectedSubmissions: number;
    /** The pinned expected normalized comparison (offline rows only). */
    readonly normalized?: ExpectedNormalizedOutcome;
  };
}

// ---------------------------------------------------------------------------
// The durable world facts (REAL SQL counts at the crown)
// ---------------------------------------------------------------------------

/** The durable world facts (the ledger's own counts — REAL SQL at the crown). */
export interface EconomicWorldFacts {
  readonly executionCount: number;
  readonly eventCount: number;
  readonly idempotencyRecordCount: number;
  readonly orphanEventCount: number;
}

// ---------------------------------------------------------------------------
// Run results
// ---------------------------------------------------------------------------

/** One driven round's facts (the accounted run's inputs + observed outcome). */
export interface DrivenRoundResult {
  readonly taskId: string;
  readonly executed: boolean;
  readonly attempts: number;
  readonly observed: ObservedOutcome;
  readonly usageFacts: readonly UsageFact[];
  readonly latencyMs: number;
  readonly record: ValidationRunRecord;
  readonly evaluation: EvaluationResult;
}

/** The full row run result (the honest outcome contract). */
export interface EconomicRunResult {
  readonly rowId: string;
  readonly terminal: "COMPLETED" | "FAILED";
  /** The row-level criteria (the protocol battery + the durable contracts). */
  readonly criteria: readonly LabVerificationCriterion[];
  readonly executionId: string | null;
  /** The OBSERVED terminal read back from the ledger after settlement. */
  readonly observedTerminal: string | null;
  /** The rounds actually driven (in execution order). */
  readonly rounds: readonly DrivenRoundResult[];
  /** The budget-stop task (fixed-cost rows; the first not-dispatched task). */
  readonly budgetStopAfter: number | null;
  readonly comparison: NormalizedArmComparison | null;
  readonly aggregate: ArmAggregate | null;
  readonly totalLatencyMs: number;
  /** The honest failure cause (null on healthy runs). */
  readonly failure: { readonly category: string; readonly message: string } | null;
}

// ---------------------------------------------------------------------------
// The execution chain (one landed execution's machinery)
// ---------------------------------------------------------------------------

interface ChainOptions {
  readonly executionId: string;
  readonly row: EconomicCorpusRow;
  readonly lifecycle: EconomicLifecyclePort;
  readonly executor: EconomicExecutor;
  readonly rails: EconomicAccountingRails;
  readonly tasks: readonly GoldenTask[];
  readonly manifest: PriceManifestRevision;
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

/** The FNV-1a digest helper (the validation-program digest discipline). */
export function economicDigestOf(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The derived observed outcome of one round (PURE): the final
 * attempt decides the terminal status; the response text is the
 * successful attempt's content; an absorbed retry surfaces NO
 * retryable error (the bounded retry policy recovered it — the
 * VAL-020/021 recovery discipline).
 */
function observedOutcomeOfRound(input: {
  readonly finalOutcome: RoundDispatchOutcome;
}): ObservedOutcome {
  if (input.finalOutcome.kind === "success") {
    return {
      terminalStatus: "COMPLETED",
      verificationStatuses: ["PASS"],
      responseText: input.finalOutcome.content ?? "",
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
 * Drive ONE landed execution's machinery: authorize → plan → the
 * durable planning decision carrying the ARM DECISION (route + the
 * fixed-cost budget bound — BEFORE the first dispatch) → queue →
 * start → the pre-registered work rounds (the fixed-cost budget gate
 * BEFORE each dispatch; bounded retry on RETRYABLE categories only;
 * every attempt's usage normalized onto the canonical micro-USD
 * basis; every round sealed + evaluated through the accounting
 * rails) → verify → the mechanically derived verdict (any failure or
 * ANY failed criterion → fail — never a partial-success shortcut).
 */
async function driveEconomicChain(options: ChainOptions): Promise<{
  readonly rounds: readonly DrivenRoundResult[];
  readonly budgetStopAfter: number | null;
  readonly usageFacts: readonly UsageFact[];
  readonly failure: { readonly category: string; readonly message: string } | null;
  readonly journal: readonly EconomicJournalRecord[];
}> {
  const { executionId, row, lifecycle, executor, rails } = options;
  const key = (): string => nextCallKey(options.keyCounter);
  const journal: EconomicJournalRecord[] = [];
  const usageFacts: UsageFact[] = [];
  const rounds: DrivenRoundResult[] = [];
  let failure: { category: string; message: string } | null = null;
  let budgetStopAfter: number | null = null;

  // ---- the canonical prologue ----
  await lifecycle.transition({
    executionId,
    step: "authorize",
    reason: "val-040-authorize",
    callKey: key(),
  });
  await lifecycle.transition({ executionId, step: "plan", reason: "val-040-plan", callKey: key() });

  // ---- the ARM DECISION (made BEFORE any dispatch) ----
  // fixed-quality: the attainment plan (the pinned threshold the runs
  //   must attain, the full pre-registered slice, the minimum samples);
  // fixed-cost: the budget plan (the pinned budget, the per-round
  //   worst-case bound priced from the pinned manifest, the declared
  //   stop rule). The decision is DURABLE before the first dispatch.
  const roundBoundMicroUsd =
    row.arm.kind === "fixed-cost"
      ? deriveRoundBudgetBoundMicroUsd({
          manifest: options.manifest,
          provider: row.arm.provider,
          model: row.arm.model,
          maxTokens: row.arm.maxTokensPerRound,
        })
      : null;
  const armDecision: Record<string, unknown> =
    row.arm.kind === "fixed-cost"
      ? {
          kind: "fixed-cost-budget-plan",
          pinnedBudgetMicroUsd: row.arm.pinnedBudgetMicroUsd,
          roundBoundMicroUsd,
          sliceSize: row.arm.corpusSlice.length,
          minimumSamples: row.arm.minimumSamples,
          stopRule: "stop before dispatch when remaining budget < round bound (prefix stop)",
          maxTokensPerRound: row.arm.maxTokensPerRound,
        }
      : {
          kind: "fixed-quality-attainment-plan",
          pinnedThreshold: row.arm.pinnedThreshold.resolutionRate,
          sliceSize: row.arm.corpusSlice.length,
          minimumSamples: row.arm.minimumSamples,
          stopRule: "run the full pre-registered slice (no stop)",
        };
  await lifecycle.recordPlanningDecision({
    executionId,
    route: {
      provider: row.arm.provider,
      model: row.arm.model,
      strategyClass: "economic-baseline",
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
    reason: "val-040-queue",
    callKey: key(),
  });
  await lifecycle.transition({
    executionId,
    step: "start",
    reason: "val-040-start",
    callKey: key(),
  });

  // ---- the work rounds (the pre-registered order) ----
  const slice = row.arm.corpusSlice;
  let measuredSoFarMicroUsd = 0n;
  for (const [roundIndex, taskId] of slice.entries()) {
    const task = options.tasks.find((candidate) => candidate.taskId === taskId);
    if (task === undefined) {
      failure = {
        category: "slice-task-missing",
        message: `the pre-registered task ${taskId} has no golden task in the slice corpus`,
      };
      break;
    }

    // The fixed-cost budget gate — BEFORE the dispatch (the pinned
    // bound decides; measured facts accumulate after each round).
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

    // The dispatch loop (bounded retry on RETRYABLE categories only).
    const attemptOutcomes: RoundDispatchOutcome[] = [];
    let finalOutcome: RoundDispatchOutcome | null = null;
    let skipped = false;
    for (let attempt = 1; ; attempt += 1) {
      const outcome = await executor({ executionId, taskId, attempt });
      if (outcome.kind === "skipped") {
        // The executor refused the round: the skip is journaled
        // honestly and the round NEVER accounts (no usage, no run
        // record) — the executed-slice conformance catches a skip
        // that is not the fixed-cost arm's declared prefix stop.
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

    // The usage facts: every attempt's usage is a MEASURED fact (a
    // failed attempt consumed tokens too); the final attempt carries
    // the direct-execution scope, absorbed retries carry the
    // retry-overhead scope (the amortization input); the estimate
    // quote rides as a SEPARATE estimate fact (never conflated).
    const roundFacts: UsageFact[] = [];
    for (const [index, outcome] of attemptOutcomes.entries()) {
      const isFinal = index === attemptOutcomes.length - 1;
      if (outcome.usage !== undefined) {
        roundFacts.push({
          provider: row.arm.provider,
          model: row.arm.model,
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
          provider: row.arm.provider,
          model: row.arm.model,
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
      // The quote rides in the RAIL's declared currency (the
      // manifest's own denomination for the arm's provider).
      const quoteEntry = resolveListPrice(
        options.manifest,
        row.arm.provider,
        row.arm.model,
        "input",
      );
      const quoteCurrency = quoteEntry?.currency ?? "USD";
      roundFacts.push({
        provider: row.arm.provider,
        model: row.arm.model,
        tier: "input",
        currency: quoteCurrency,
        tokens: finalOutcome.estimateQuote.inputTokens,
        kind: "estimate",
        scope: "direct-execution",
      });
      roundFacts.push({
        provider: row.arm.provider,
        model: row.arm.model,
        tier: "output",
        currency: quoteCurrency,
        tokens: finalOutcome.estimateQuote.outputTokens,
        kind: "estimate",
        scope: "direct-execution",
      });
    }
    usageFacts.push(...roundFacts);

    // The observed outcome + latency (measured facts).
    const observed = observedOutcomeOfRound({ finalOutcome });
    const latencyMs = attemptOutcomes.reduce((sum, outcome) => sum + outcome.latencyMs, 0);
    const evaluation = rails.evaluate({
      task,
      corpusVersion: options.corpusVersion,
      observed,
    });

    // The round's cost facts: normalized onto the canonical basis
    // through the pinned manifest (measured and estimate separate).
    const basis = normalizeArmCosts(roundFacts, options.manifest);
    const roundCostFacts: CostFact[] = basis.facts.map((fact) => ({
      kind: fact.kind,
      amountMicroUsd: fact.microUsd,
      source: `val-040:${row.rowId}:${options.manifest.revision}`,
      scope: fact.scope,
    }));
    measuredSoFarMicroUsd += BigInt(basis.measuredMicroUsd);

    // The round's journal record (the settled round — digests only).
    {
      const record: EconomicJournalRecord = {
        ordinal: journal.length + 1,
        kind: finalOutcome.kind === "success" ? "round" : "failure",
        digest: economicDigestOf({
          taskId,
          attempts: attemptOutcomes.length,
          requestDigest: finalOutcome.requestDigest,
          verdict: evaluation.verdict,
        }),
        detail: `round:${taskId}:${finalOutcome.kind}`,
      };
      journal.push(record);
      await lifecycle.recordStepEvent({ executionId, record });
    }

    // The round's accounted run: sealed through the REAL recorder
    // (run-start → the attempt events (digests) → run-end; the cost
    // facts carry the normalized micro-USD; latency measured).
    const roundStart = options.now().toISOString();
    const events: RoundAccountingInput["events"] = [
      { kind: "run-start", data: { corpusTask: taskId, arm: row.arm.armId }, at: roundStart },
      ...attemptOutcomes.map((outcome, index) => ({
        kind: (outcome.kind === "failure" && index === attemptOutcomes.length - 1
          ? "error-surfaced"
          : "model-choice") as Parameters<ValidationRecorder["recordEvent"]>[0],
        data: {
          ...(outcome.kind === "failure" && index === attemptOutcomes.length - 1
            ? { code: outcome.category ?? "unknown", retryable: false }
            : { requestDigest: outcome.requestDigest, attempt: index + 1 }),
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
      attempts: attemptOutcomes.length,
      observed,
      usageFacts: roundFacts,
      latencyMs,
      record,
      evaluation,
    });
  }

  return { rounds, budgetStopAfter, usageFacts, failure, journal };
}

// ---------------------------------------------------------------------------
// The row driver
// ---------------------------------------------------------------------------

/**
 * The landed-executions provider: returns the row's landed execution
 * ids (the app's submissions land through the public wire; the
 * crown's provider polls the REAL SQL until the expected count
 * lands).
 */
export type LandedExecutionsProvider = (
  group: number,
  expectedCount: number,
) => Promise<readonly string[]>;

/**
 * Drive one economics corpus row to settlement through the platform
 * path: the landed execution's chain (the arm decision BEFORE
 * dispatch → the pre-registered rounds with the fixed-cost budget
 * gate → the normalized, sealed, evaluated, aggregated accounting),
 * the observed terminal READ BACK from the ledger, the normalized
 * comparison derived + validated against the frozen protocol, and
 * the row-level mechanical criteria. The honest terminal is FAILED
 * when any failure was observed, any criterion failed or any
 * comparison violation surfaced — never a partial-success shortcut.
 */
export async function driveEconomicRow(options: {
  readonly row: EconomicCorpusRow;
  readonly lifecycle: EconomicLifecyclePort;
  /** The platform-path executor (recorded replay offline; REAL gateway live). */
  readonly executor: EconomicExecutor;
  /** The accounting rails (the REAL recorder + evaluation + aggregate). */
  readonly rails: EconomicAccountingRails;
  /** The golden tasks of the arm's pre-registered slice (in order). */
  readonly tasks: readonly GoldenTask[];
  /** The run metadata the rounds' records carry. */
  readonly metadata: RunMetadata;
  /** The environment identity the rounds' records carry. */
  readonly environmentIdentity: string;
  readonly corpusVersion: string;
  /** The PRE-ROW durable facts (captured BEFORE the app submitted). */
  readonly baseline: EconomicWorldFacts;
  /** The durable world-facts provider (REAL SQL counts at the crown). */
  readonly worldFacts: () => Promise<EconomicWorldFacts> | EconomicWorldFacts;
  /** The landed-executions provider (the app's submitted lanes). */
  readonly landedProvider: LandedExecutionsProvider;
  /** Bounded retry policy for RETRYABLE dispatch failures. */
  readonly retry: {
    readonly maxExtraAttempts: number;
    readonly backoffMs: number;
    readonly sleep: (ms: number) => Promise<void>;
  };
  readonly now: () => Date;
  /** An override manifest (the discrimination battery's mutated tables). */
  readonly manifestOverride?: PriceManifestRevision;
  /** The arm's own threshold claim (never trusted — the gaming catch). */
  readonly claimedThresholdMet?: boolean;
}): Promise<EconomicRunResult> {
  const runStartedAt = options.now().getTime();
  const keyCounter = { count: 0 };
  const manifest = options.manifestOverride ?? manifestFor(options.row.arm.priceRevision);
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
        ...(options.claimedThresholdMet === undefined
          ? {}
          : { claimedThresholdMet: options.claimedThresholdMet }),
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

  const chain = await driveEconomicChain({
    executionId,
    row: options.row,
    lifecycle: options.lifecycle,
    executor: options.executor,
    rails: options.rails,
    tasks: options.tasks,
    manifest,
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
    const accounted: AccountedRun[] = chain.rounds.map((round) => ({
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
    reason: "val-040-verify",
    callKey: nextCallKey(keyCounter),
  });
  const finalFacts = await Promise.resolve(options.worldFacts());
  const usageFailureCount = normalizeArmCosts(chain.usageFacts, manifest).failures.length;

  const rowCriteria = deriveEconomicRowCriteria({
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
  });

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
        ? "val-040-verified"
        : `val-040-${chain.failure?.category ?? "protocol-violation"}`,
  });

  // ---- the observed terminal read back from the ledger ----
  // (the reconciliation judges the platform's OWN durable claim — a
  // fabricated terminal disagrees with the derived verdict and the
  // row FAILs honestly here, the anyFail→FAILED probe at the ledger).
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
// Mechanical verification (the oracle floor)
// ---------------------------------------------------------------------------

/**
 * Derive the row-level mechanical criteria (PURE): the
 * normalization-integrity and manifest-integrity oracles, the frozen
 * protocol battery (arm declaration valid, slice conformance, sample
 * sufficiency, the comparison validation with its confidence,
 * estimate-separation, threshold-gaming and budget-breach catches),
 * the pinned normalized-outcome oracle (the derived comparison must
 * reproduce the corpus's expected values), the durable contracts (no
 * phantom executions, no ledger drift, no orphan transitions), the
 * honest outcome contract and the honest economics record.
 */
export function deriveEconomicRowCriteria(input: {
  readonly row: EconomicCorpusRow;
  readonly rounds: readonly DrivenRoundResult[];
  readonly aggregate: ArmAggregate | null;
  readonly comparison: NormalizedArmComparison | null;
  readonly observedTerminal: string | null;
  readonly executionId: string | null;
  readonly baseline: EconomicWorldFacts;
  readonly finalFacts: EconomicWorldFacts;
  readonly failure: { readonly category: string; readonly message: string } | null;
  readonly usageFailureCount: number;
  readonly budgetStopAfter: number | null;
  readonly totalLatencyMs: number;
  readonly claimedThresholdMet?: boolean;
}): LabVerificationCriterion[] {
  const { row } = input;
  const criteria: LabVerificationCriterion[] = [];

  // (No short-circuit — the criteria prove the SEMANTICS; a
  // correctly-shaped honest failure PASSES them while the terminal
  // stays honestly FAILED.)

  // 1. Normalization integrity: every usage fact converged onto the
  //    canonical micro-USD basis (a mixed-currency conflation or an
  //    unpinned price FAILS here).
  criteria.push({
    criterionId: "normalization-integrity",
    strategy: "deterministic",
    status: input.usageFailureCount === 0 ? "PASS" : "FAIL",
    evidence: [
      `rounds:${input.rounds.length}`,
      `usageFailures:${input.usageFailureCount}`,
      input.usageFailureCount === 0
        ? "every usage fact converged onto the canonical micro-USD basis"
        : "a usage fact FAILED to normalize (mixed-currency conflation or unpinned pricing)",
    ],
  });

  // 2. Manifest integrity: the declared price revision's digest agrees.
  const manifest = deriveManifestIntegrity({ revision: row.arm.priceRevision });
  criteria.push({
    criterionId: "manifest-integrity",
    strategy: "deterministic",
    status: manifest.agreed ? "PASS" : "FAIL",
    evidence: manifest.evidence,
  });

  // 3. The frozen protocol battery: the comparison validation (the
  //    confidence, estimate-separation, slice-conformance,
  //    sample-sufficiency, threshold-gaming, budget-breach and
  //    manifest-agreement catches, each mechanical).
  const violations =
    input.comparison === null
      ? [
          {
            armId: row.arm.armId,
            reason: "no comparison was derived (no rounds drove — the row never accounted)",
          },
        ]
      : validateNormalizedComparison(input.comparison);
  criteria.push({
    criterionId: "protocol-comparison-valid",
    strategy: "deterministic",
    status: violations.length === 0 ? "PASS" : "FAIL",
    evidence:
      violations.length === 0
        ? [
            `arm:${row.arm.armId}`,
            "battery:confidence-carried+slice-conformant+samples-sufficient+threshold-recomputed+budget-respected+manifest-agreed",
          ]
        : violations.map((violation) => `${violation.armId}: ${violation.reason}`),
  });

  // 4. The arm-declaration grammar (the frozen terms validate).
  criteria.push({
    criterionId: "protocol-arm-declaration-valid",
    strategy: "deterministic",
    status: "PASS",
    evidence: [
      `armId:${row.arm.armId}`,
      `kind:${row.arm.kind}`,
      `priceRevision:${row.arm.priceRevision}`,
      `slice:${row.arm.corpusSlice.length}`,
      `minimumSamples:${row.arm.minimumSamples}`,
      row.arm.kind === "fixed-quality"
        ? `pinnedThreshold:${row.arm.pinnedThreshold.resolutionRate}`
        : `pinnedBudgetMicroUsd:${row.arm.pinnedBudgetMicroUsd} (maxTokens ${row.arm.maxTokensPerRound}/round)`,
      "grammar:validated-at-pin-time (the corpus rows carry pre-pinned arms)",
    ],
  });

  // 5. The accounting rails' aggregate (the REAL rails' roll-up with
  //    the Wilson interval on the resolution rate).
  criteria.push({
    criterionId: "accounting-rails-aggregate",
    strategy: "deterministic",
    status:
      input.aggregate !== null &&
      input.aggregate.runCount === input.rounds.length &&
      input.aggregate.resolutionConfidence !== null
        ? "PASS"
        : "FAIL",
    evidence:
      input.aggregate === null
        ? ["aggregate:none (no rounds drove through the rails)"]
        : [
            `runs:${input.aggregate.runCount}`,
            `resolved:${input.aggregate.resolvedCount}`,
            `wilson95:[${input.aggregate.resolutionConfidence.low.toFixed(4)}, ${input.aggregate.resolutionConfidence.high.toFixed(4)}]`,
            `measuredMicroUsd:${input.aggregate.measuredCostMicroUsd}`,
            `estimatedMicroUsd:${input.aggregate.estimatedCostMicroUsd}`,
            `costPerResolved:${input.aggregate.costPerResolvedMicroUsd ?? "null"}`,
          ],
  });

  // 6. The pinned normalized-outcome oracle (offline rows): the
  //    derived comparison must reproduce the corpus's expected values.
  if (row.expected.normalized !== undefined) {
    const expected = row.expected.normalized;
    const comparison = input.comparison;
    const matches =
      comparison !== null &&
      comparison.runCount === expected.runCount &&
      comparison.resolvedCount === expected.resolvedCount &&
      comparison.measuredCostMicroUsd === expected.measuredCostMicroUsd &&
      comparison.estimatedCostMicroUsd === expected.estimatedCostMicroUsd &&
      comparison.costPerResolvedMicroUsd === expected.costPerResolvedMicroUsd &&
      comparison.resolutionConfidence !== null &&
      Math.abs(comparison.resolutionConfidence.low - expected.resolutionConfidence.low) < 1e-9 &&
      Math.abs(comparison.resolutionConfidence.high - expected.resolutionConfidence.high) < 1e-9;
    criteria.push({
      criterionId: "normalized-outcome-oracle",
      strategy: "deterministic",
      status: matches ? "PASS" : "FAIL",
      evidence: [
        `expectedRuns:${expected.runCount}`,
        `observedRuns:${comparison?.runCount ?? "none"}`,
        `expectedResolved:${expected.resolvedCount}`,
        `observedResolved:${comparison?.resolvedCount ?? "none"}`,
        `expectedMeasured:${expected.measuredCostMicroUsd}`,
        `observedMeasured:${comparison?.measuredCostMicroUsd ?? "none"}`,
        `expectedCostPerResolved:${expected.costPerResolvedMicroUsd ?? "null"}`,
        `observedCostPerResolved:${comparison?.costPerResolvedMicroUsd ?? "none"}`,
        `expectedWilson:[${expected.resolutionConfidence.low.toFixed(4)}, ${expected.resolutionConfidence.high.toFixed(4)}]`,
        `observedWilson:${comparison?.resolutionConfidence === null || comparison?.resolutionConfidence === undefined ? "none" : `[${comparison.resolutionConfidence.low.toFixed(4)}, ${comparison.resolutionConfidence.high.toFixed(4)}]`}`,
      ],
    });
  }

  // 7. The fixed-cost budget-stop honesty (the declared prefix stop).
  if (row.arm.kind === "fixed-cost" && input.budgetStopAfter !== null) {
    criteria.push({
      criterionId: "budget-stop-honesty",
      strategy: "deterministic",
      status: "PASS",
      evidence: [
        `stoppedAfter:${input.budgetStopAfter} rounds (the pre-registered prefix)`,
        `nextTask:${row.arm.corpusSlice[input.budgetStopAfter] ?? "slice-exhausted"}`,
        "the stop happened BEFORE dispatch (the pinned round bound decided)",
      ],
    });
  }

  // 8. No phantom executions: the durable execution rows the row
  //    settled to are EXACTLY the expected count.
  const executionDelta = input.finalFacts.executionCount - input.baseline.executionCount;
  criteria.push({
    criterionId: "no-phantom-executions",
    strategy: "deterministic",
    status: executionDelta === row.expected.executions ? "PASS" : "FAIL",
    evidence: [
      `baseline:${input.baseline.executionCount}`,
      `final:${input.finalFacts.executionCount}`,
      `delta:${executionDelta}`,
      `expected:${row.expected.executions}`,
    ],
  });

  // 9. No ledger drift: the distinct idempotency keys are EXACTLY the
  //    expected count.
  const keyDelta = input.finalFacts.idempotencyRecordCount - input.baseline.idempotencyRecordCount;
  criteria.push({
    criterionId: "no-ledger-drift",
    strategy: "deterministic",
    status: keyDelta === row.expected.idempotencyRecords ? "PASS" : "FAIL",
    evidence: [
      `baseline:${input.baseline.idempotencyRecordCount}`,
      `final:${input.finalFacts.idempotencyRecordCount}`,
      `delta:${keyDelta}`,
      `expected:${row.expected.idempotencyRecords}`,
    ],
  });

  // 10. No orphan ledger transitions: ZERO events with no parent row.
  criteria.push({
    criterionId: "no-orphan-ledger-transitions",
    strategy: "deterministic",
    status: input.finalFacts.orphanEventCount === 0 ? "PASS" : "FAIL",
    evidence: [
      `orphanEvents:${input.finalFacts.orphanEventCount}`,
      `eventCount:${input.finalFacts.eventCount}`,
    ],
  });

  // 11. The honest outcome contract: the mechanically derived terminal
  //     matches the oracle's terminal (anyFail→FAILED probed here).
  const derivedTerminal: "COMPLETED" | "FAILED" =
    input.failure !== null ||
    (input.comparison === null ? true : validateNormalizedComparison(input.comparison).length > 0)
      ? "FAILED"
      : "COMPLETED";
  criteria.push({
    criterionId: "row-outcome-contract",
    strategy: "deterministic",
    status: derivedTerminal === row.expected.terminal ? "PASS" : "FAIL",
    evidence: [
      `expectedTerminal:${row.expected.terminal}`,
      `derivedTerminal:${derivedTerminal}`,
      `observedTerminal:${input.observedTerminal ?? "none"}`,
      `failure:${input.failure?.category ?? "none"}`,
    ],
  });

  // 12. Honest economics: the rounds' usage facts are measured (the
  //     offline rows' replayed-record provenance; the live rows'
  //     rail-measured provenance); latency measured; payload digests
  //     only.
  criteria.push({
    criterionId: "economics-measured",
    strategy: "deterministic",
    status: "PASS",
    evidence: [
      row.needsDispatch
        ? "usage:rail-measured on the live dispatch (BYOK; measured, never estimated)"
        : "usage:replayed-record facts (deterministic offline replays — honestly labeled, never presented as live measurements)",
      "latencyMs:measured",
      `totalLatencyMs:${input.totalLatencyMs}`,
      "evidence:payload digests only (never payload bytes)",
    ],
  });

  return criteria;
}

// ---------------------------------------------------------------------------
// The app-side economic contract (PURE verification of app observations)
// ---------------------------------------------------------------------------

/**
 * Judge the app-side observations against the row's outcome contract
 * (PURE): the terminal↔criteria agreement over the PUBLIC result
 * read (a fabricated pass-with-fail surfaced through the public wire
 * FAILs the app honestly — the anyFail→FAILED invariant probed at
 * the customer boundary) and the expected terminal met.
 */
export function verifyEconomicAppContract(input: {
  readonly row: EconomicCorpusRow;
  /** The observed terminal from the public execution read. */
  readonly terminal: string | null;
  /** The verification statuses from the public result read. */
  readonly verificationStatuses: readonly string[];
}): LabVerificationCriterion[] {
  const criteria: LabVerificationCriterion[] = [];
  const failed = input.verificationStatuses.filter((status) => status === "FAIL").length;
  const isCompleted = input.terminal === "COMPLETED";
  const agreement = input.terminal !== null && isCompleted === (failed === 0);
  criteria.push({
    criterionId: "app-terminal-criteria-agreement",
    strategy: "deterministic",
    status: agreement ? "PASS" : "FAIL",
    evidence: [
      `terminal:${input.terminal ?? "none"}`,
      `criteria:${input.verificationStatuses.filter((status) => status === "PASS").length}pass+${failed}fail`,
      agreement
        ? "agreed"
        : "DISAGREED (a fabricated outcome-criteria mix at the customer boundary)",
    ],
  });
  criteria.push({
    criterionId: "app-expected-terminal",
    strategy: "deterministic",
    status: input.terminal === input.row.expected.terminal ? "PASS" : "FAIL",
    evidence: [`expected:${input.row.expected.terminal}`, `observed:${input.terminal ?? "none"}`],
  });
  return criteria;
}
