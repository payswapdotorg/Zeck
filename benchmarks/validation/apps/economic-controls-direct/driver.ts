/**
 * The economic-controls-direct execution driver (VAL-041, acceptance
 * criteria 4 and 5 — the DIRECT-PROVIDER control arm).
 *
 * Drives one direct-provider experiment row through the platform
 * path: the landed execution's chain runs the ARM DECISIONS BEFORE
 * DISPATCH (the DIRECT integration surface, the pinned provider/model
 * rail, the pinned price revision + digest and — for fixed-cost arms —
 * the per-round budget bound priced from the pinned manifest, all
 * recorded in the durable planning decision BEFORE the first
 * dispatch), then each pre-registered round runs through the DIRECT
 * rail:
 *
 *   * each round is ONE REQUEST issued DIRECTLY to the pinned
 *     provider (the injected direct executor — the recorded control
 *     trace replay offline, the REAL model gateway over the REAL
 *     OpenRouter rail live). NO Zeck agent platform, NO gateway
 *     middle layer, NO reuse/cache shortcut rides the dispatch: the
 *     provider dispatch reports the platform/gateway artifacts it
 *     observed, and the ARM-CONFORMANCE oracle FAILs any non-empty
 *     artifact list MECHANICALLY with the artifact named (a
 *     shortcut-riding row fails);
 *   * the direct granularity is PER ATTEMPT: the client-side bounded
 *     retry (RETRYABLE transport categories only) re-issues the
 *     request itself, so every attempt's own measured usage is a
 *     separate fact (the amortization never hides inside a gateway
 *     boundary — failed attempts carry retry-overhead scope, the
 *     settling attempt direct-execution scope);
 *   * the fixed-cost budget gate fires BEFORE each dispatch (the
 *     pinned per-round bound priced from the pinned manifest over the
 *     arm's own pinned rail — never under-reserving);
 *   * every round's usage converges through the normalization core
 *     (mixed-currency conflation FAILs; estimate-backed
 *     cost-per-resolved is REFUSED), the runs seal through the REAL
 *     accounting rails, and the normalized comparison is derived and
 *     validated against the frozen VAL-040 protocol (sample
 *     sufficiency, slice conformance, threshold recomputation,
 *     budget respect, manifest agreement — post-hoc arm exclusion and
 *     sample-size violations FAIL mechanically).
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
import {
  computeManifestDigest,
  deriveManifestIntegrity,
  resolveListPrice,
} from "../economic-baseline/pricing";
import type { EconomicArm } from "../economic-baseline/protocol";
import {
  deriveNormalizedComparison,
  type NormalizedArmComparison,
} from "../economic-baseline/protocol";

// ---------------------------------------------------------------------------
// The executor seam (the direct dispatch — INJECTED)
// ---------------------------------------------------------------------------

/** The usage one direct dispatch attempt observed (the provider's own report). */
export interface DirectRoundUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** The currency the attempt's usage is denominated in (the pinned rail's own). */
  readonly currency: PriceCurrency;
  /**
   * The provider's OWN reported charge for the attempt (a
   * cross-check observation, never the comparison basis).
   */
  readonly costUsd?: number;
}

/**
 * The outcome of ONE direct dispatch attempt. The direct path reports
 * the PLATFORM/GATEWAY ARTIFACTS it observed on the dispatch — an
 * honest direct dispatch carries an EMPTY list (a shortcut-riding
 * dispatch names what it saw, and the arm-conformance oracle FAILs it).
 */
export interface DirectDispatchOutcome {
  readonly kind: "success" | "failure" | "skipped";
  readonly content?: string;
  readonly usage?: DirectRoundUsage;
  readonly category?: string;
  readonly message?: string;
  readonly latencyMs: number;
  readonly requestDigest: string;
  /** A provider-side quote observed on the attempt (ESTIMATE facts — separate, never conflated). */
  readonly estimateQuote?: { readonly inputTokens: number; readonly outputTokens: number };
  readonly skipReason?: string;
  /** The platform/gateway artifacts observed on the dispatch (MUST be empty on a direct path). */
  readonly platformArtifacts: readonly string[];
}

/** The direct executor seam: one attempt per call (the bounded retry is the driver's). */
export type DirectExecutor = (input: {
  readonly executionId: string;
  readonly taskId: string;
  readonly attempt: number;
}) => Promise<DirectDispatchOutcome>;

// ---------------------------------------------------------------------------
// The corpus row contract (the oracle)
// ---------------------------------------------------------------------------

/** One recorded client-side attempt of a direct request (the direct granularity). */
export interface DirectTraceAttempt {
  readonly outcome: "success" | "failure";
  /** The failure category (failures only). */
  readonly category?: string;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  readonly latencyMs: number;
}

/**
 * One recorded direct-rail trace round: the per-attempt facts the
 * replay executor settles (offline rows; live rows leave the record
 * absent). The adversarial probe fields denature the honest shape:
 * `usageCurrency` (usage denominated in a currency that mismatches
 * the pinned rail's — the mixed-currency conflation), `platformArtifacts`
 * (a dispatch that rode a platform shortcut), `estimateOnly` (the
 * round reports ONLY a quote — the estimate-backed cost), and
 * `postHocExcluded` (the executor refuses the failed round — the
 * post-hoc arm exclusion).
 */
export interface DirectTraceRound {
  readonly taskId: string;
  readonly recorded?: {
    /** The client-side attempts in order (the bounded retry's recorded sequence). */
    readonly attempts: readonly DirectTraceAttempt[];
    /** The settling attempt's response text (success rounds). */
    readonly responseText?: string;
    /** The currency the recorded usage is denominated in (defaults to the rail's own). */
    readonly usageCurrency?: PriceCurrency;
    /** The provider's OWN reported charge (USD — a cross-check observation, never the basis). */
    readonly reportedChargeUsd?: number;
    /** A provider-side quote observed on the round (estimate facts — separate). */
    readonly estimateQuote?: { readonly inputTokens: number; readonly outputTokens: number };
    /** The platform/gateway artifacts the recorded dispatch observed (the shortcut-riding probe). */
    readonly platformArtifacts?: readonly string[];
    /** The estimate-only shape: the round reports ONLY the quote (the estimate-backed probe). */
    readonly estimateOnly?: boolean;
    /** The post-hoc exclusion shape: the executor refuses this round (the exclusion probe). */
    readonly postHocExcluded?: boolean;
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
 * The direct-provider corpus row — structurally an economic corpus
 * row (the VAL-040 criteria derivations ride it unchanged) extended
 * with the DIRECT declarations: the pre-registered per-round trace
 * plans (the recorded control traces) and the frozen-portfolio
 * reference (digests only).
 */
export interface DirectCorpusRow {
  readonly rowId: string;
  readonly description: string;
  /** The arm manifest entry (the VAL-040 frozen grammar; a direct-provider integration surface). */
  readonly arm: EconomicArm;
  /** The per-round trace plans (the recorded control traces). */
  readonly directReplay: readonly DirectTraceRound[];
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

/** One driven direct round (one request issued directly to the pinned provider). */
export interface DirectDrivenRound extends DrivenRoundResult {
  /** The platform/gateway artifacts the round's settling dispatch observed (must be empty). */
  readonly platformArtifacts: readonly string[];
  /** The provider's own charge observation for the round (never the basis). */
  readonly chargeObservationUsd: number | null;
}

/** The full direct row run result (the honest outcome contract). */
export interface DirectRunResult extends EconomicRunResult {
  readonly rounds: readonly DirectDrivenRound[];
}

// ---------------------------------------------------------------------------
// The direct-arm derivations (PURE)
// ---------------------------------------------------------------------------

/** The direct integration surface prefix (the arm-conformance vocabulary). */
export const DIRECT_SURFACE_PREFIX = "direct:";

/** Whether an arm declares the DIRECT integration surface (a direct-provider arm). */
export function isDirectSurface(arm: EconomicArm): boolean {
  return arm.integrationSurface.startsWith(DIRECT_SURFACE_PREFIX);
}

/**
 * Derive the worst-case micro-USD cost of ONE direct request round
 * (PURE — the conservative fixed-cost bound): the pinned max tokens
 * priced at BOTH tiers of the arm's OWN pinned rail through the
 * VAL-040 per-token pricer, so the gate never under-reserves.
 */
export function deriveDirectRoundBudgetBoundMicroUsd(input: {
  readonly manifest: PriceManifestRevision;
  readonly arm: EconomicArm;
}): string {
  if (input.arm.kind !== "fixed-cost") {
    throw new Error("the direct round budget bound is a fixed-cost-arm derivation");
  }
  return deriveRoundBudgetBoundMicroUsd({
    manifest: input.manifest,
    provider: input.arm.provider,
    model: input.arm.model,
    maxTokens: input.arm.maxTokensPerRound,
  });
}

/**
 * The ARM-CONFORMANCE oracle (PURE — the VAL-041 verification core):
 * the provider dispatches carry NO platform/gateway artifacts — no
 * reuse/cache shortcut signatures, no platform mediation markers —
 * and every round rode the arm's OWN pinned provider/model rail (a
 * direct arm has no routing table: the arm's pinned rail IS the
 * path). A shortcut-riding round (any non-empty artifact list) FAILs
 * MECHANICALLY with the artifact named; a round riding any other
 * rail FAILs with both rails named.
 */
export function deriveDirectPathConformance(input: {
  readonly arm: EconomicArm;
  readonly rounds: readonly DirectDrivenRound[];
}): {
  readonly conformant: boolean;
  readonly evidence: readonly string[];
} {
  const { arm, rounds } = input;
  const riddenArtifacts: string[] = [];
  const misroutes: string[] = [];
  for (const round of rounds) {
    for (const artifact of round.platformArtifacts) {
      riddenArtifacts.push(`${round.taskId}:${artifact}`);
    }
    const usageFacts = round.usageFacts.filter((fact) => fact.kind === "measured");
    for (const fact of usageFacts) {
      if (fact.provider !== arm.provider || fact.model !== arm.model) {
        misroutes.push(`${round.taskId}:${fact.provider}/${fact.model}`);
      }
    }
  }
  const surfaceOk = isDirectSurface(arm);
  const conformant = surfaceOk && riddenArtifacts.length === 0 && misroutes.length === 0;
  return {
    conformant,
    evidence: [
      `integrationSurface:${arm.integrationSurface}`,
      `pinnedRail:${arm.provider}/${arm.model}`,
      `requests:${rounds.length}`,
      `artifacts:${riddenArtifacts.length}`,
      ...riddenArtifacts,
      `misroutes:${misroutes.length}`,
      ...misroutes,
      surfaceOk
        ? "surface:direct (the arm declares the direct-provider integration surface)"
        : "surface:NON-DIRECT (the arm does not declare the direct integration surface)",
      conformant
        ? "conformant (every dispatch rode the pinned rail directly — no platform mediation, no reuse/cache shortcut)"
        : "NON-CONFORMANT (a dispatch carried a platform/gateway artifact or rode a rail other than the arm's pinned one — the shortcut-riding catch)",
    ],
  };
}

/**
 * The NORMALIZATION oracle (PURE — the direct cost-basis integrity):
 * the cost-per-resolved is MEASURED-ONLY — an estimate-backed shape
 * (resolved rounds yet zero measured facts while estimates exist)
 * FAILs mechanically, and every normalization failure (mixed-currency
 * conflation, unpinned pricing) FAILs with the reason named.
 */
export function deriveDirectCostBasisIntegrity(input: {
  readonly rounds: readonly DirectDrivenRound[];
  readonly usageFacts: readonly UsageFact[];
  readonly manifest: PriceManifestRevision;
}): {
  readonly conformant: boolean;
  readonly evidence: readonly string[];
} {
  const basis = normalizeArmCosts(input.usageFacts, input.manifest);
  const resolvedRounds = input.rounds.filter(
    (round) => round.observed.terminalStatus === "COMPLETED",
  );
  const measuredFacts = input.usageFacts.filter((fact) => fact.kind === "measured");
  const estimateFacts = input.usageFacts.filter((fact) => fact.kind === "estimate");
  const estimateBacked =
    resolvedRounds.length > 0 && measuredFacts.length === 0 && estimateFacts.length > 0;
  const conflation = basis.failures;
  const conformant = !estimateBacked && conflation.length === 0;
  return {
    conformant,
    evidence: [
      `rounds:${input.rounds.length}`,
      `resolvedRounds:${resolvedRounds.length}`,
      `measuredFacts:${measuredFacts.length}`,
      `estimateFacts:${estimateFacts.length}`,
      `failures:${conflation.length}`,
      ...conflation.map((failure) => `${failure.provider}/${failure.tier}: ${failure.reason}`),
      estimateBacked
        ? "ESTIMATE-BACKED COST: resolved rounds carry no measured usage — the cost-per-resolved is refused mechanically (estimates are never conflated)"
        : "measured-only basis (the cost-per-resolved is backed by measured facts; estimates ride separately)",
      conformant
        ? "conformant (every usage fact converged onto the canonical micro-USD basis in the pinned currencies)"
        : "NON-CONFORMANT (a mixed-currency conflation or an estimate-backed cost basis)",
    ],
  };
}

/**
 * The MANIFEST oracle (PURE): the manifest that ACTUALLY priced the
 * runs is the arm's PINNED revision, and its integrity agrees (the
 * declared revision is known in the registry and its recomputed
 * digest agrees — an in-place price mutation FAILs mechanically).
 */
export function deriveDirectManifestIntegrity(input: {
  readonly manifest: PriceManifestRevision;
  readonly arm: EconomicArm;
}): {
  readonly conformant: boolean;
  readonly evidence: readonly string[];
} {
  const integrity = deriveManifestIntegrity({ revision: input.manifest.revision });
  // The manifest that ACTUALLY priced the runs must also agree with
  // ITS OWN recorded digest (an in-place price edit with a stale
  // digest — the discrimination battery's mutated table — FAILs here
  // mechanically, independently of the registry lookup).
  const selfDigestAgrees =
    computeManifestDigest(input.manifest.tables, input.manifest.fx) === input.manifest.digest;
  const pinned = input.manifest.revision === input.arm.priceRevision;
  const conformant = integrity.agreed && selfDigestAgrees && pinned;
  return {
    conformant,
    evidence: [
      ...integrity.evidence,
      `selfDigest:${selfDigestAgrees ? "AGREED" : "DISAGREED (the tables that priced the runs do not digest to the recorded digest — an in-place price mutation)"}`,
      `armPinnedRevision:${input.arm.priceRevision}`,
      `pricedRevision:${input.manifest.revision}`,
      pinned
        ? "pinned (the runs were priced through the arm's declared revision)"
        : "UNPINNED (the runs were priced through a revision the arm does not declare)",
      conformant
        ? "conformant (the pinned price revision priced every run; the manifest digest agrees)"
        : "NON-CONFORMANT (an unpinned or mutated price revision priced the runs)",
    ],
  };
}

/**
 * The SAMPLE-SIZE oracle (PURE): the executed slice holds the
 * pre-registered minimum sample size (a starved sample FAILs
 * mechanically) and NO round was excluded post-hoc (a skipped round
 * in a fixed-quality arm's full slice — or a non-prefix exclusion in
 * a fixed-cost arm — FAILs with the skip named).
 */
export function deriveDirectSampleDiscipline(input: {
  readonly row: DirectCorpusRow;
  readonly rounds: readonly DirectDrivenRound[];
  readonly skippedTaskIds: readonly string[];
  readonly budgetStopAfter: number | null;
}): {
  readonly conformant: boolean;
  readonly evidence: readonly string[];
} {
  const { row, rounds, skippedTaskIds } = input;
  const executed = rounds.length;
  const minimum = row.arm.minimumSamples;
  const sufficient = executed >= minimum;
  // A fixed-cost arm's honest stop is the declared PREFIX stop (the
  // budget gate); any skipped round BEFORE the stop is an exclusion.
  const honestPrefixStop = input.budgetStopAfter !== null;
  const excluded = skippedTaskIds.filter((taskId) => {
    if (honestPrefixStop) {
      const stopIndex = input.budgetStopAfter ?? 0;
      const taskIndex = row.arm.corpusSlice.indexOf(taskId);
      return taskIndex < 0 || taskIndex < stopIndex;
    }
    return true;
  });
  const conformant = sufficient && excluded.length === 0;
  return {
    conformant,
    evidence: [
      `slice:${row.arm.corpusSlice.length}`,
      `executed:${executed}`,
      `minimumSamples:${minimum}`,
      `skipped:${skippedTaskIds.length}`,
      `excluded:${excluded.length}`,
      ...excluded.map((taskId) => `post-hoc-excluded:${taskId}`),
      sufficient
        ? "sufficient (the executed sample holds the pre-registered minimum)"
        : `SAMPLE-STARVED: ${executed} executed < ${minimum} pre-registered (the minimum was weakened after the fact or the sample was truncated)`,
      ...(honestPrefixStop
        ? [`budgetStopAfter:${input.budgetStopAfter} (the declared prefix stop)`]
        : []),
      conformant
        ? "conformant (the pre-registered sample discipline held)"
        : "NON-CONFORMANT (a post-hoc arm exclusion or a sample-size violation)",
    ],
  };
}

// ---------------------------------------------------------------------------
// The chain options + the execution chain
// ---------------------------------------------------------------------------

interface ChainOptions {
  readonly executionId: string;
  readonly row: DirectCorpusRow;
  readonly lifecycle: EconomicLifecyclePort;
  readonly executor: DirectExecutor;
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

/** The derived observed outcome of one direct round (PURE — the settling attempt decides). */
function observedOutcomeOfRequest(finalOutcome: DirectDispatchOutcome): ObservedOutcome {
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

/** The pinned rail's declared currency (the manifest's own denomination). */
function railCurrencyOf(manifest: PriceManifestRevision, arm: EconomicArm): PriceCurrency {
  const entry = resolveListPrice(manifest, arm.provider, arm.model, "input");
  if (entry === null) {
    throw new Error(`no pinned list-price entry for ${arm.provider}/${arm.model}`);
  }
  return entry.currency;
}

/**
 * Drive ONE landed execution's direct machinery: authorize → plan →
 * the durable planning decision carrying the ARM DECISIONS (the
 * direct integration surface, the pinned rail, the pinned price
 * revision + digest, the fixed-cost budget bound — BEFORE the first
 * request) → queue → start → the pre-registered rounds (the
 * fixed-cost budget gate before each request; the client-side
 * bounded retry with PER-ATTEMPT usage facts; the normalized,
 * sealed, evaluated accounting) → the rounds' return. Any failure is
 * honest (never a partial-success shortcut).
 */
async function driveDirectChain(options: ChainOptions): Promise<{
  readonly rounds: readonly DirectDrivenRound[];
  readonly budgetStopAfter: number | null;
  readonly usageFacts: readonly UsageFact[];
  readonly failure: { readonly category: string; readonly message: string } | null;
  readonly journal: readonly EconomicJournalRecord[];
  readonly skippedTaskIds: readonly string[];
}> {
  const { executionId, row, lifecycle, executor, rails } = options;
  const key = (): string => nextCallKey(options.keyCounter);
  const journal: EconomicJournalRecord[] = [];
  const usageFacts: UsageFact[] = [];
  const rounds: DirectDrivenRound[] = [];
  const skippedTaskIds: string[] = [];
  let failure: { category: string; message: string } | null = null;
  let budgetStopAfter: number | null = null;
  const plans = new Map(row.directReplay.map((plan) => [plan.taskId, plan]));

  // ---- the canonical prologue ----
  await lifecycle.transition({
    executionId,
    step: "authorize",
    reason: "val-041-authorize",
    callKey: key(),
  });
  await lifecycle.transition({ executionId, step: "plan", reason: "val-041-plan", callKey: key() });

  // ---- the ARM DECISIONS (made BEFORE any request) ----
  const roundBoundMicroUsd =
    row.arm.kind === "fixed-cost"
      ? deriveDirectRoundBudgetBoundMicroUsd({ manifest: options.manifest, arm: row.arm })
      : null;
  const armDecision: Record<string, unknown> = {
    kind:
      row.arm.kind === "fixed-cost" ? "direct-fixed-cost-budget-plan" : "direct-fixed-quality-plan",
    integrationSurface: row.arm.integrationSurface,
    directPath:
      "provider-called-directly (no Zeck agent platform, no gateway middle layer, no reuse/cache shortcut)",
    pinnedRail: { provider: row.arm.provider, model: row.arm.model },
    priceRevision: row.arm.priceRevision,
    priceDigest: options.manifest.digest,
    retryAccounting:
      "the client-side bounded retry re-issues the request itself (per-attempt usage facts; failed attempts carry retry-overhead scope)",
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
      strategyClass: "economic-controls-direct",
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
    reason: "val-041-queue",
    callKey: key(),
  });
  await lifecycle.transition({
    executionId,
    step: "start",
    reason: "val-041-start",
    callKey: key(),
  });

  // ---- the work rounds (the pre-registered order) ----
  const slice = row.arm.corpusSlice;
  let measuredSoFarMicroUsd = 0n;
  for (const [roundIndex, taskId] of slice.entries()) {
    const task = options.tasks.find((candidate) => candidate.taskId === taskId);
    const _plan = plans.get(taskId);
    if (task === undefined) {
      failure = {
        category: "slice-task-missing",
        message: `the pre-registered task ${taskId} has no golden task in the slice corpus`,
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
    //      transport categories only; each attempt is a SEPARATE
    //      direct request with its own measured usage) ----
    const requestOutcomes: DirectDispatchOutcome[] = [];
    let finalOutcome: DirectDispatchOutcome | null = null;
    let skipped = false;
    for (let attempt = 1; ; attempt += 1) {
      const outcome = await executor({ executionId, taskId, attempt });
      if (outcome.kind === "skipped") {
        skipped = true;
        skippedTaskIds.push(taskId);
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

    // ---- the usage facts: PER ATTEMPT (the direct granularity — the
    //      bounded retry's failed attempts are the row's own
    //      retry-overhead, never amortized inside a gateway
    //      boundary); the settling attempt carries direct-execution
    //      scope; the provider-side quote rides as a SEPARATE
    //      estimate fact ----
    const roundFacts: UsageFact[] = [];
    for (const [index, outcome] of requestOutcomes.entries()) {
      const isFinal = index === requestOutcomes.length - 1;
      if (outcome.usage !== undefined) {
        roundFacts.push({
          provider: row.arm.provider,
          model: row.arm.model,
          tier: "input",
          currency: outcome.usage.currency,
          tokens: outcome.usage.inputTokens,
          kind: "measured",
          scope: isFinal ? "direct-execution" : "retry-overhead",
          ...(outcome.usage.costUsd === undefined || !isFinal
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
          ...(outcome.usage.costUsd === undefined || !isFinal
            ? {}
            : { chargedAmount: String(outcome.usage.costUsd) }),
        });
      }
    }
    if (finalOutcome.estimateQuote !== undefined) {
      const quoteCurrency = railCurrencyOf(options.manifest, row.arm);
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
      source: `val-041:${row.rowId}:${options.manifest.revision}`,
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
          platformArtifacts: [...finalOutcome.platformArtifacts],
        }),
        detail: `round:${taskId}:${finalOutcome.kind} (attempts ${requestOutcomes.length})`,
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
                platformArtifacts: [...outcome.platformArtifacts],
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
      platformArtifacts: [...finalOutcome.platformArtifacts],
      chargeObservationUsd: finalOutcome.usage?.costUsd ?? null,
    });
  }

  return { rounds, budgetStopAfter, usageFacts, failure, journal, skippedTaskIds };
}

// ---------------------------------------------------------------------------
// The row driver
// ---------------------------------------------------------------------------

/**
 * Drive one direct-provider corpus row to settlement through the
 * platform path: the landed execution's direct chain (the arm
 * decisions BEFORE dispatch → the pre-registered rounds with the
 * budget gate before each request and the client-side bounded retry
 * → the normalized, sealed, evaluated, aggregated accounting), the
 * observed terminal READ BACK from the ledger, the normalized
 * comparison derived + validated against the frozen VAL-040 protocol,
 * and the row-level mechanical criteria (the VAL-040 criteria families
 * + the direct-path oracles). The honest terminal is FAILED when any
 * failure was observed, any criterion failed or any comparison
 * violation surfaced — never a partial-success shortcut.
 */
export async function driveDirectRow(options: {
  readonly row: DirectCorpusRow;
  readonly lifecycle: EconomicLifecyclePort;
  /** The direct dispatch executor (recorded trace replay offline; REAL gateway live). */
  readonly executor: DirectExecutor;
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
  /** The arm's own threshold claim (never trusted — the gaming catch). */
  readonly claimedThresholdMet?: boolean;
}): Promise<DirectRunResult> {
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

  const chain = await driveDirectChain({
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
    reason: "val-041-verify",
    callKey: nextCallKey(keyCounter),
  });
  const finalFacts = await Promise.resolve(options.worldFacts());
  const usageFailureCount = normalizeArmCosts(chain.usageFacts, manifest).failures.length;

  const rowCriteria: LabVerificationCriterion[] = [
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
    ...deriveDirectSliceCriteria({
      row: options.row,
      rounds: chain.rounds,
      manifest,
      usageFacts: chain.usageFacts,
      skippedTaskIds: chain.skippedTaskIds,
      budgetStopAfter: chain.budgetStopAfter,
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
        ? "val-041-verified"
        : `val-041-${chain.failure?.category ?? "protocol-violation"}`,
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
// The direct-slice oracles (the mechanical verification)
// ---------------------------------------------------------------------------

/**
 * Derive the direct-slice criteria (PURE — the VAL-041 verification
 * core): the ARM-CONFORMANCE oracle (the provider dispatches carry no
 * platform/gateway artifacts and ride the arm's own pinned rail — a
 * shortcut-riding row FAILs with the artifact named), the cost-basis
 * oracle (a mixed-currency conflation or an estimate-backed cost
 * FAILs), the manifest oracle (an unpinned or mutated price revision
 * FAILs via the manifest integrity derivation), the sample-discipline
 * oracle (below the pre-registered minimum or a post-hoc arm
 * exclusion FAILs), the replay fidelity (the offline executor's
 * reported usage equals the recorded control trace), the
 * charge-observation separation (the provider's own charge is an
 * observation, never the basis) and the frozen-portfolio reference
 * integrity (the VAL-030 content digests agree).
 */
export function deriveDirectSliceCriteria(input: {
  readonly row: DirectCorpusRow;
  readonly rounds: readonly DirectDrivenRound[];
  readonly manifest: PriceManifestRevision;
  readonly usageFacts: readonly UsageFact[];
  readonly skippedTaskIds: readonly string[];
  readonly budgetStopAfter: number | null;
}): readonly LabVerificationCriterion[] {
  const { row, rounds, manifest } = input;
  const criteria: LabVerificationCriterion[] = [];

  // 1. Direct-path conformance (the arm-conformance oracle).
  const path = deriveDirectPathConformance({ arm: row.arm, rounds });
  criteria.push({
    criterionId: "direct-path-conformance",
    strategy: "deterministic",
    status: path.conformant ? "PASS" : "FAIL",
    evidence: path.evidence,
  });

  // 2. The direct cost-basis integrity (the normalization oracle).
  const costBasis = deriveDirectCostBasisIntegrity({
    rounds,
    usageFacts: input.usageFacts,
    manifest,
  });
  criteria.push({
    criterionId: "direct-cost-basis-measured",
    strategy: "deterministic",
    status: costBasis.conformant ? "PASS" : "FAIL",
    evidence: costBasis.evidence,
  });

  // 3. The manifest oracle (pinned + integral).
  const manifestIntegrity = deriveDirectManifestIntegrity({ manifest, arm: row.arm });
  criteria.push({
    criterionId: "direct-manifest-integrity",
    strategy: "deterministic",
    status: manifestIntegrity.conformant ? "PASS" : "FAIL",
    evidence: manifestIntegrity.evidence,
  });

  // 4. The sample discipline (the sample-size + post-hoc-exclusion oracle).
  const sample = deriveDirectSampleDiscipline({
    row,
    rounds,
    skippedTaskIds: input.skippedTaskIds,
    budgetStopAfter: input.budgetStopAfter,
  });
  criteria.push({
    criterionId: "direct-sample-discipline",
    strategy: "deterministic",
    status: sample.conformant ? "PASS" : "FAIL",
    evidence: sample.evidence,
  });

  // 5. The replay fidelity (offline rows): the executor's reported
  //    usage equals the recorded control trace (a token understatement
  //    FAILs mechanically) and the attempt counts match the record.
  if (!row.needsDispatch) {
    const infidelities: string[] = [];
    for (const round of rounds) {
      const plan = row.directReplay.find((candidate) => candidate.taskId === round.taskId);
      const recorded = plan?.recorded;
      if (recorded === undefined) {
        infidelities.push(`${round.taskId}:no-recorded-trace (an offline round must be recorded)`);
        continue;
      }
      const attemptsWithUsage = recorded.attempts.filter((attempt) => attempt.usage !== undefined);
      const measuredFacts = round.usageFacts.filter((fact) => fact.kind === "measured");
      if (measuredFacts.length !== attemptsWithUsage.length * 2) {
        infidelities.push(
          `${round.taskId}:factPairs ${measuredFacts.length / 2} != recorded attempts ${attemptsWithUsage.length}`,
        );
      }
      if (round.attempts !== recorded.attempts.length) {
        infidelities.push(
          `${round.taskId}:attempts ${round.attempts} != recorded ${recorded.attempts.length}`,
        );
      }
    }
    criteria.push({
      criterionId: "direct-replay-fidelity",
      strategy: "deterministic",
      status: infidelities.length === 0 ? "PASS" : "FAIL",
      evidence: [
        `requests:${rounds.length}`,
        `infidelities:${infidelities.length}`,
        ...infidelities,
        ...(infidelities.length === 0
          ? [
              "conformant (the reported usage equals the recorded control trace — per attempt, never understated)",
            ]
          : [
              "NON-CONFORMANT (the reported usage or attempt count disagrees with the recorded trace)",
            ]),
      ],
    });
  }

  // 6. The charge-observation separation: the provider's own reported
  //    charges are CROSS-CHECK OBSERVATIONS ONLY — every sealed cost
  //    fact's source is manifest-priced (the pinned revision).
  const manifestPricedSources = rounds.every((round) =>
    round.record.cost.every((fact) => fact.source.includes(`:${row.arm.priceRevision}`)),
  );
  criteria.push({
    criterionId: "charge-observation-separation",
    strategy: "deterministic",
    status: manifestPricedSources ? "PASS" : "FAIL",
    evidence: [
      `chargeObservations:${rounds.filter((round) => round.chargeObservationUsd !== null).length}`,
      `manifestPricedCostFacts:${String(manifestPricedSources)}`,
      manifestPricedSources
        ? "separated (the provider's own charges are cross-check observations only; the canonical basis prices measured tokens through the pinned manifest)"
        : "CONFLATED (a cost fact outside the manifest basis)",
    ],
  });

  // 7. The frozen-portfolio reference integrity: the VAL-030 content
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
    ],
  });

  return criteria;
}

/** The VAL-040 criteria + app-contract derivations (imported, never copied). */
/** The REAL accounting rails re-export (the VAL-040 delivery's own binding). */
export {
  createRealAccountingRails,
  deriveEconomicRowCriteria,
  economicDigestOf,
  verifyEconomicAppContract,
} from "../economic-baseline/driver";
/** The pinned manifest integrity re-export (the pricing oracle's basis). */
export { deriveManifestIntegrity } from "../economic-baseline/pricing";
