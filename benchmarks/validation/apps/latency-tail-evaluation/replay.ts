/**
 * The deterministic paced replay engine (PCL-003 — the evaluation's
 * core).
 *
 * THE REPLAY LAW (the work order's replay discipline): per cell, per
 * arm, every logical request occurrence of the capstone's own corpus
 * (ONE occurrence per repetition — the re-dispatching posture: the
 * evaluation measures the TAIL MECHANICS per exposure, not the
 * capstone's durable-replay reuse axis, which is the capstone's own
 * determinism-reuse dimension and out of this evaluation's scope,
 * disclosed) is ONE execution driven through the arm's paced ladder:
 *
 *  - the per-attempt provider behavior is drawn by the transport's own
 *    PURE functions (`outcomeOf` — imported through the lab's shared
 *    seam; the draws key on stream key, attempt and provider, NEVER on
 *    the arm — arm-agnostic fairness by construction);
 *  - the routing is the declared round-robin (the capstone's own
 *    discipline: first attempts rotate across the cell's supplies in
 *    corpus order; failover takes the next supply in the rotation) —
 *    arm-agnostic;
 *  - the PACING is the arm's own: the baseline arm replays the
 *    capstone's quoted posture (ONE policy retry, failover, 5 ms wait
 *    — the recovery plane's traced semantics, never the pacing plane);
 *    the tuned arm resolves every pacing decision through the PACING
 *    RESOLVER (the PCL-002 seam): retry admissibility by failure
 *    class, the bounded jittered backoff delay (the deterministic
 *    hash-drawn jitter), the class-aware cooldown state and re-entry
 *    admission (a held incumbent FAILS OVER; a held candidate is
 *    SKIPPED on the replay's virtual clock — the provider cooldown
 *    state is carried per provider from its latest failure, the
 *    declared model), and the progress-delivery mechanics record;
 *  - every execution's outcome is recorded as ONE PCL-001 typed
 *    outcome-latency fact (constructed fail-closed: closed
 *    vocabularies, the exact census reconciliation, the
 *    outcome-class/census/resolution agreements, the explicit basis)
 *    with its content address and canonical form;
 *  - every attempt's evidence is re-derivable from the transport's
 *    pure draws (self-verifying evidence — the suites re-derive every
 *    attempt and every pacing decision).
 *
 * THE DECLARED LATENCY MODEL (the explicit-basis discipline): the
 * outcome latency is the ladder's arithmetic — the sum of the drawn
 * per-attempt latencies plus the paced inter-attempt waits —
 * synthetic-latency, never wall-clock. The progress-observation layer
 * adds NO latency in this replay (the synthetic supplies are
 * synchronous request/response draws — no progress-poll loop exists
 * here; the progress-delivery mechanics are RECORDED in the facts,
 * never latency-differentiated — disclosed in the README and the
 * threshold report; the poll-quantization and event-stream effects
 * are operator-era live questions, never backfilled).
 *
 * Deterministic and total: the same cell, arm, resolver and digest
 * always produce the byte-identical replay (no clock, no randomness —
 * the jitter is a pure hash function of the stream key and attempt).
 */

import { createHash } from "node:crypto";
import { buildCellCorpus, outcomeOf } from "../shared/seam";
import { createNodeDigestPort, type DigestPort } from "./canonical";
import {
  BASELINE_POSTURE,
  FAILURE_CLASS_OF_SUPPLY_FAULT,
  SYNTHETIC_TRANSPORT_CAPABILITIES,
  syntheticModelOfClass,
} from "./configurations";
import type { EvaluationCell } from "./corpus";
import { edgeOfRequest, replayJitterDraw, replayStreamKeyOf } from "./corpus";
import {
  attemptCensusOf,
  type DispatchCooldownState,
  measuredCost,
  measuredLatency,
  notRunLatency,
  type OutcomeClass,
  type OutcomeFailureClass,
  type OutcomeLatencyFacts,
  outcomeLatencyFactsIdentity,
  outcomeLatencyFactsOf,
  outcomeLatencyLeg,
  progressDeliveryFacts,
  verificationProofOf,
} from "./facts";
import type { TailPacingConfiguration } from "./pacing";
import {
  LOCAL_PACING_RESOLVER_FACTORY,
  type PacingResolver,
  type PacingResolverFactory,
} from "./pacing";

/** One physical dispatch attempt's evidence (self-verifying against the transport's pure draws). */
export interface AttemptRecord {
  readonly streamKey: string;
  readonly attempt: number;
  readonly providerId: string;
  readonly model: string;
  /** original | retry (same provider) | fallback (alternate provider). */
  readonly move: "original" | "retry" | "fallback";
  /** The PCL-001 failure class of the attempt (null when the attempt succeeded). */
  readonly failureClass: OutcomeFailureClass | null;
  /** The drawn latency (ms, synthetic). */
  readonly latencyMs: number;
  /** The charged cost (nano-USD, synthetic schedule). */
  readonly costNanoUsd: number;
  /** The paced wait before this attempt (ms). */
  readonly waitBeforeMs: number;
  /** The cooldown state at this dispatch (the target provider's own state). */
  readonly cooldownAtDispatch: DispatchCooldownState;
}

/** One execution's replay record (the typed fact + the per-attempt evidence). */
export interface ExecutionRecord {
  readonly executionId: string;
  readonly streamKey: string;
  readonly taskId: string;
  readonly rep: number;
  readonly requestIndex: number;
  readonly edgeId: string;
  readonly outcomeClass: OutcomeClass;
  readonly resolved: boolean;
  readonly verificationOutcome: "pass" | "not-run";
  readonly outcomeLatencyMs: number;
  readonly sumLegsMs: number;
  readonly sumWaitsMs: number;
  readonly attempts: readonly AttemptRecord[];
  readonly facts: OutcomeLatencyFacts;
  readonly factsIdentity: string;
}

/** One arm's replay over one cell. */
export interface ArmReplayResult {
  readonly armId: string;
  readonly executions: readonly ExecutionRecord[];
  readonly totalAttempts: number;
  readonly totalCostNanoUsd: number;
  readonly maxElapsedMs: number;
  readonly dispatchBudgetViolations: number;
}

const FIRST_BYTE_NOT_RUN_OWNER =
  "the synthetic supply declares no first-byte profile (owner: PCL-003 evaluation; the transport draws completion latency only)";
const TERMINAL_VERIFICATION_NOT_RUN_OWNER =
  "the evaluation models no verification pass on a terminal failure (owner: PCL-003 evaluation)";
const TOTAL_COST_BASIS = "synthetic-price-schedule:transport-charges-per-physical-dispatch";
const VERIFICATION_COST_BASIS = "synthetic-price-schedule:no-verification-charge";

/** The per-execution identity (deterministic, bounded — the stream key's content address). */
function executionIdOf(armId: string, streamKey: string): string {
  return `${armId}:${createHash("sha256").update(streamKey, "utf8").digest("hex").slice(0, 32)}`;
}

/** The replay's injectable dependencies (the resolver factory + the digest port). */
export interface ReplayDeps {
  readonly resolverFactory?: PacingResolverFactory;
  readonly digest?: DigestPort;
}

/** The replay's arm input (either arm's declared posture). */
export interface ArmReplayInput {
  readonly armId: string;
  readonly pacing: TailPacingConfiguration | null;
  readonly posture?: {
    readonly policyRetryLimit: number;
    readonly interAttemptWaitMs: number;
    readonly driverPollIntervalMs: number;
  } | null;
}

/**
 * Replay ONE arm over ONE cell: every logical request occurrence of the
 * cell's corpus, one paced execution each, on the declared virtual
 * clock (sequential in corpus order — the provider cooldown state is
 * carried per provider from its latest failure).
 */
export function replayCellArm(
  cell: EvaluationCell,
  arm: ArmReplayInput,
  deps: ReplayDeps = {},
): ArmReplayResult {
  const resolverFactory = deps.resolverFactory ?? LOCAL_PACING_RESOLVER_FACTORY;
  const digest = deps.digest ?? createNodeDigestPort();
  const corpus = buildCellCorpus(cell.subject, cell.modality, cell.volume, cell.repetitions);
  const providers = [...cell.providerIds];
  const isTuned = arm.pacing !== null;
  const tuned: TailPacingConfiguration | null = arm.pacing;

  const executions: ExecutionRecord[] = [];
  let clock = 0;
  let rotationCursor = 0;
  let totalAttempts = 0;
  let totalCostNanoUsd = 0;
  let maxElapsedMs = 0;
  let dispatchBudgetViolations = 0;

  // The provider cooldown ledger (the tuned arm's class-aware cooldowns):
  // per provider, the LATEST failure's class, the clock position it
  // occurred at, and the clock position its cooldown lifts at (the
  // declared model — one active cooldown per provider, the most recent
  // failure's class governs).
  const cooldownFailureClass = new Map<string, OutcomeFailureClass>();
  const cooldownFailureClock = new Map<string, number>();
  const cooldownDeadline = new Map<string, number>();

  const cooldownRuleOf = (failureClass: OutcomeFailureClass) =>
    tuned?.cooldownDiscipline?.rules.find((candidate) => candidate.failureClass === failureClass);

  const providerHeld = (providerIndex: number): boolean => {
    const providerId = providers[providerIndex];
    if (providerId === undefined) {
      return false;
    }
    const deadline = cooldownDeadline.get(providerId);
    return deadline !== undefined && deadline > clock;
  };

  const cooldownStateFor = (providerIndex: number): DispatchCooldownState => {
    const providerId = providers[providerIndex];
    if (providerId === undefined || !isTuned) {
      return { kind: "none" };
    }
    const failedClass = cooldownFailureClass.get(providerId);
    if (failedClass === undefined) {
      return { kind: "none" };
    }
    const rule = cooldownRuleOf(failedClass);
    if (rule === undefined || rule.cooldownMs === 0) {
      return { kind: "none" };
    }
    const failureClock = cooldownFailureClock.get(providerId) ?? 0;
    const remaining = rule.cooldownMs - (clock - failureClock);
    if (remaining <= 0) {
      return { kind: "none" };
    }
    return { kind: "active", failureClass: failedClass, remainingMs: remaining };
  };

  for (const task of corpus) {
    for (const [requestIndex, request] of task.requests.entries()) {
      const streamKey = replayStreamKeyOf(cell.cellId, task.baseTaskId, requestIndex, task.rep);
      const edge = edgeOfRequest(cell.subject, request);
      const model = syntheticModelOfClass(edge.modalityClass);
      const executionId = executionIdOf(arm.armId, streamKey);

      // The per-execution resolver with the deterministic jitter draw
      // queue (the draw for attempt N is the pure hash of the stream
      // key and N — the composition's own entropy source,
      // deterministic, never ambient).
      const drawQueue = [2, 3, 4].map((attempt) => replayJitterDraw(streamKey, attempt));
      const resolver: PacingResolver = resolverFactory({
        ...(tuned === null ? {} : { configuration: tuned }),
        ...(tuned === null ? {} : { jitterDraw: () => (drawQueue.shift() ?? 0.5) as number }),
      });

      // ---- the first dispatch's provider: the round-robin candidate
      // (the tuned arm SKIPS candidates in an active cooldown — the
      // declared diversion policy; when every candidate is held, the
      // rotation candidate dispatches anyway and its active state is
      // recorded honestly) ----
      const rotationIndex = rotationCursor % providers.length;
      rotationCursor += 1;
      let currentProviderIndex = rotationIndex;
      if (isTuned && providerHeld(rotationIndex)) {
        // The rotation candidate is held: divert to the next candidate
        // not in an active cooldown (all held → keep the rotation
        // candidate, its active state recorded honestly).
        for (let offset = 1; offset < providers.length; offset += 1) {
          const candidateIndex = (rotationIndex + offset) % providers.length;
          if (!providerHeld(candidateIndex)) {
            currentProviderIndex = candidateIndex;
            break;
          }
        }
      }
      const firstCooldownState = cooldownStateFor(currentProviderIndex);

      // ---- the paced ladder ----
      const attempts: AttemptRecord[] = [];
      let original = 0;
      let retryCount = 0;
      let fallbackCount = 0;
      let verificationCount = 0;
      let elapsed = 0;
      let previousProviderIndex = -1;
      let pendingWaitMs = 0;
      let attemptNumber = 0;
      let ladderCostNanoUsd = 0;
      let outcomeClass: OutcomeClass = "failed-terminal";
      let resolved = false;

      const ladderLimit = isTuned
        ? (tuned?.retryPacing?.maxRetries ?? 0) + 1
        : (arm.posture?.policyRetryLimit ?? 0) + 1;

      while (attemptNumber < ladderLimit) {
        attemptNumber += 1;
        const providerId = providers[currentProviderIndex] ?? "supply-a";
        const cooldownAtDispatch =
          attemptNumber === 1 ? firstCooldownState : cooldownStateFor(currentProviderIndex);
        const draw = outcomeOf({
          providerId,
          edge,
          request,
          streamKey,
          attempt: attemptNumber,
        });
        elapsed += draw.latencyMs;
        ladderCostNanoUsd += draw.costNanoUsd;
        totalAttempts += 1;
        totalCostNanoUsd += draw.costNanoUsd;
        const failureClass: OutcomeFailureClass | null =
          draw.ok === true
            ? null
            : ((FAILURE_CLASS_OF_SUPPLY_FAULT[draw.category] as OutcomeFailureClass | undefined) ??
              null);
        if (draw.ok === false && failureClass === null) {
          throw new Error(
            `unknown synthetic supply fault category ${draw.category} at ${streamKey} attempt ${attemptNumber} (the closed mapping is fail-closed)`,
          );
        }
        const move: AttemptRecord["move"] =
          attemptNumber === 1
            ? "original"
            : currentProviderIndex === previousProviderIndex
              ? "retry"
              : "fallback";
        attempts.push({
          streamKey,
          attempt: attemptNumber,
          providerId,
          model,
          move,
          failureClass,
          latencyMs: draw.latencyMs,
          costNanoUsd: draw.costNanoUsd,
          waitBeforeMs: pendingWaitMs,
          cooldownAtDispatch,
        });
        if (move === "original") {
          original += 1;
        } else if (move === "retry") {
          retryCount += 1;
        } else {
          fallbackCount += 1;
        }

        if (draw.ok === true) {
          resolved = true;
          verificationCount = 1;
          outcomeClass =
            retryCount > 0
              ? "succeeded-after-retry"
              : fallbackCount > 0
                ? "succeeded-on-fallback"
                : "succeeded-first-attempt";
          break;
        }

        // The attempt FAILED. Enter the provider cooldown (the tuned
        // arm's class-aware discipline) and decide the next move.
        const failedClass = failureClass as OutcomeFailureClass;
        if (isTuned) {
          const rule = cooldownRuleOf(failedClass);
          if (rule !== undefined && rule.cooldownMs > 0) {
            cooldownFailureClass.set(providerId, failedClass);
            cooldownFailureClock.set(providerId, clock + elapsed);
            cooldownDeadline.set(providerId, clock + elapsed + rule.cooldownMs);
          }
        }
        if (attemptNumber + 1 > ladderLimit) {
          break;
        }

        if (!isTuned) {
          // The capstone's quoted posture: ONE policy retry on a
          // retryable failure, failing over to the next supply
          // (retry-once-next-supply).
          if (!draw.retryable) {
            break;
          }
          pendingWaitMs = arm.posture?.interAttemptWaitMs ?? 5;
          elapsed += pendingWaitMs;
          previousProviderIndex = currentProviderIndex;
          currentProviderIndex = (currentProviderIndex + 1) % providers.length;
          continue;
        }

        // The tuned arm: the pacing seam decides.
        if (!resolver.retryAdmits(failedClass)) {
          break;
        }
        const delayMs = resolver.retryDelayFor(attemptNumber + 1) ?? 0;
        pendingWaitMs = delayMs;
        elapsed += delayMs;
        const failureClock = cooldownFailureClock.get(providerId) ?? clock + elapsed - delayMs;
        const admission = resolver.admitCooldownReentry(
          failedClass,
          clock + elapsed - failureClock,
        );
        previousProviderIndex = currentProviderIndex;
        if (!admission.admissible) {
          // The incumbent is held: fail over to the next supply not in
          // an active cooldown (all held → the next cyclic supply).
          let failoverIndex = (currentProviderIndex + 1) % providers.length;
          for (let offset = 1; offset < providers.length; offset += 1) {
            const candidateIndex = (currentProviderIndex + offset) % providers.length;
            if (!providerHeld(candidateIndex)) {
              failoverIndex = candidateIndex;
              break;
            }
          }
          currentProviderIndex = failoverIndex;
        }
        // Admitted: the same provider re-dispatches (the retry move).
      }

      maxElapsedMs = Math.max(maxElapsedMs, elapsed);
      const budgetMs = isTuned
        ? (tuned?.timeoutContract.dispatchBudgetMs ?? Number.POSITIVE_INFINITY)
        : 30_000; // the capstone driver's own per-execution latency constraint (maxLatencyMs)
      if (elapsed > budgetMs) {
        dispatchBudgetViolations += 1;
      }

      const totalCostMicroUsd = Math.round(ladderCostNanoUsd / 1000);
      const progress = isTuned
        ? resolver.progressFacts(SYNTHETIC_TRANSPORT_CAPABILITIES, firstCooldownState)
        : null;
      const progressRecord =
        progress ??
        progressDeliveryFacts({
          mode: "polled",
          pollingInterval: measuredLatency(
            isTuned
              ? (tuned?.progressDelivery?.pollingIntervalMs ??
                  BASELINE_POSTURE.driverPollIntervalMs)
              : (arm.posture?.driverPollIntervalMs ?? BASELINE_POSTURE.driverPollIntervalMs),
            "progress.pollingInterval",
          ),
          cooldownAtDispatch: firstCooldownState,
        });

      const facts = outcomeLatencyFactsOf({
        outcomeClass,
        legs: attempts.map((attempt) =>
          outcomeLatencyLeg({
            legId: `${executionId}:a${attempt.attempt}`,
            route: { provider: attempt.providerId, model: attempt.model },
            ...(attempt.failureClass === null ? {} : { failureClass: attempt.failureClass }),
            firstByte: notRunLatency(FIRST_BYTE_NOT_RUN_OWNER, "legs.firstByte"),
            completion: measuredLatency(attempt.latencyMs, "legs.completion"),
          }),
        ),
        attemptCensus: attemptCensusOf({
          original,
          retry: retryCount,
          fallback: fallbackCount,
          verification: verificationCount,
        }),
        progress: progressRecord,
        cost: {
          totalIncludingDuplicates: measuredCost(totalCostMicroUsd, TOTAL_COST_BASIS),
          verification: measuredCost(0, VERIFICATION_COST_BASIS),
        },
        resolved,
        verification: resolved
          ? verificationProofOf({
              kind: "proved",
              outcome: "pass",
              resultIds: [`${executionId}:v1`],
            })
          : verificationProofOf({
              kind: "not-run",
              owner: TERMINAL_VERIFICATION_NOT_RUN_OWNER,
            }),
        basis: {
          executionId,
          route: {
            provider: attempts[0]?.providerId ?? providers[0] ?? "supply-a",
            model,
          },
          revision: 0,
          clockDiscipline: "wall-clock",
        },
      });
      executions.push({
        executionId,
        streamKey,
        taskId: task.taskId,
        rep: task.rep,
        requestIndex,
        edgeId: request.edgeId,
        outcomeClass,
        resolved,
        verificationOutcome: resolved ? "pass" : "not-run",
        outcomeLatencyMs: elapsed,
        sumLegsMs: attempts.reduce((sum, attempt) => sum + attempt.latencyMs, 0),
        sumWaitsMs: attempts.reduce((sum, attempt) => sum + attempt.waitBeforeMs, 0),
        attempts,
        facts,
        factsIdentity: outcomeLatencyFactsIdentity(facts, digest.sha256Hex),
      });
      clock += elapsed;
    }
  }

  return {
    armId: arm.armId,
    executions,
    totalAttempts,
    totalCostNanoUsd,
    maxElapsedMs,
    dispatchBudgetViolations,
  };
}
