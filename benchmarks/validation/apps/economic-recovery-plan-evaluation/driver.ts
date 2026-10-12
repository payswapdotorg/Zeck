/**
 * The economic-recovery-plan-evaluation driver (PCR-003 — the P1
 * program's three-arm replay evaluation with explicit outcome
 * thresholds).
 *
 * THE THREE-ARM FRESH RUN (the exact-revision rule): per targeted
 * multi-provider cell, all three arms re-run FRESH at ONE revision, in
 * ONE process, over the SAME corpus-derived request stream and the SAME
 * arm-agnostic deterministic synthetic supply:
 *
 *  - UN-RETRIED DIRECT — the capstone's own direct-baseline executor
 *    (`experiments/ppr-027/driver.ts`, imported read-only): one attempt
 *    on the primary supply, no retry, no cache;
 *  - STRONG-OPTIMIZED — the capstone's own optimized-baseline executor:
 *    the 3-attempt retry ladder + provider fallback chain +
 *    content-addressed cache + normalization shim (never a strawman);
 *  - MEDIATED-WITH-PLAN — the real Zeck public API stack (the PPR-027
 *    composed experiment world) with plan mode ON through the PCR-002
 *    evaluation configuration (`ComposeExperimentOptions.recovery`),
 *    composing the bounded ladder [same-provider retry, alternate-
 *    provider failover] through the PCR-001 plan composer at the traced
 *    retry/failover seam, every composed step recorded through the
 *    EXISTING WORK-049 seam.
 *
 * REUSE, DO NOT REBUILD: the arms' mechanics are the capstone's own
 * executors and composed stack, imported and invoked — this driver adds
 * ONLY the evaluation: the plan-mode wiring (the corpus's declared
 * policy), the per-attempt evidence capture, the mechanical violations
 * scan, the aggregation, the threshold verdicts and the honest labels.
 *
 * PER-ATTEMPT EVIDENCE (the deterministic replay discipline): every
 * physical dispatch of every arm is recorded with its draw identity
 * (the transport stream key), its route, its outcome and fault class,
 * its DRAWN synthetic latency, its measured synthetic cost, its usage,
 * and — for the mediated-with-plan arm — the failure attribution and
 * the strategy verdict of the plan step that drove it. Every record is
 * VERIFIED against the transport's own pure draw functions
 * (`outcomeOf`) — the evidence is self-verifying and reproducible by
 * re-run (identical digests); wall-clock values and run identities are
 * excluded from every digest projection.
 *
 * FAIL-CLOSED ALWAYS: any reconstruction mismatch (a fault/latency the
 * journals cannot account for, a draw the pure functions cannot
 * reproduce, a missing dispatch fact) is a typed error naming the
 * occurrence — never a guess, never a silent default.
 *
 * HONEST LABELS: every number this driver emits carries its
 * synthetic-supply / synthetic-cost / synthetic-latency label; no
 * market or production claims; a threshold miss with honest attribution
 * is a valid delivery (the program's truth discipline).
 */

import { createHash } from "node:crypto";
import { captureBaseline } from "../../../../compat/harness/baseline-runner";
import { runCorpus } from "../../../../compat/harness/corpus-runner";
import {
  composeExperimentStack,
  type ExperimentRecoveryPlanInputs,
  type ExperimentStack,
} from "../../../../experiments/ppr-027/compose";
import type { SubjectEdge, WorkloadRequest } from "../../../../experiments/ppr-027/config";
import { edgeOf } from "../../../../experiments/ppr-027/config";
import {
  baselineTasksOf,
  buildCellCorpus,
  createDirectBaselineExecutor,
  createExperimentDriver,
  createOptimizedBaselineExecutor,
  type RequestRecord,
} from "../../../../experiments/ppr-027/driver";
import { experimentTraceSource } from "../../../../experiments/ppr-027/sweep";
import { createSyntheticSupply, outcomeOf } from "../../../../experiments/ppr-027/transport";
import { canonicalJson, createEvaluationDigestPort, type EvaluationDigestPort } from "./canonical";
import {
  ARM_ATTEMPT_BOUNDS,
  ARM_IDS,
  type ArmId,
  BASE_REVISION,
  CORPUS_VERSION,
  COST_BASIS_NOTE,
  EVALUATION_ID,
  type EvaluationCell,
  LATENCY_BASIS_NOTE,
  MEDIATED_PLAN_CONFIGURATION,
  MEDIATED_PLAN_CONSTRAINTS,
  MEDIATED_PLAN_PROVIDER_ALTERNATES,
  MEDIATED_PLAN_QUALITY_FACTS,
  MEDIATED_PLAN_RETRY_CLAIM,
  MEDIATED_PLAN_STEP_ID,
  SYNTHETIC_LABELS,
  THRESHOLDS,
} from "./corpus";
import { EVALUATION_GOVERNED_IR } from "./governed-ir";

// ---------------------------------------------------------------------------
// The boundary disciplines (the customer boundary — VAL-002 AC7 — forbids
// `src/**` imports from the application tree; see canonical.ts and
// governed-ir.ts for the repository's own established answers)
// ---------------------------------------------------------------------------

/** The composed-plan value's type — the LAB's own interface type (never `src/**`). */
export type ComposedRecoveryPlan = Parameters<
  NonNullable<ExperimentRecoveryPlanInputs["onPlanComposed"]>
>[0];

/** The evaluation's digest port (byte-identical to the platform's — pinned in-suite). */
const evaluationDigestPort: EvaluationDigestPort = createEvaluationDigestPort();

/** The per-attempt evidence's digest helper (canonical form → sha256 hex). */
function sha256HexOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

// ---------------------------------------------------------------------------
// The mediated-with-plan arm's plan inputs (the PCR-002 evaluation
// configuration): the corpus's declared policy wiring plus the
// evaluation's observers (the per-plan evidence hooks).
//
// The governed IR is the PINNED CAPTURED CONSTANT (governed-ir.ts — the
// platform's own construction output, byte-equality pinned in-suite);
// the digest port is the app-local byte-identical port (canonical.ts —
// pinned in-suite). The boundary disciplines are documented in each
// module's header.
// ---------------------------------------------------------------------------

export function mediatedPlanInputsWithObservers(options: {
  readonly onPlanComposed: (plan: ComposedRecoveryPlan) => void;
  readonly onDecisionRecords: (count: number) => void;
}): ExperimentRecoveryPlanInputs {
  return {
    planConfiguration: MEDIATED_PLAN_CONFIGURATION,
    qualityFacts: MEDIATED_PLAN_QUALITY_FACTS,
    constraints: MEDIATED_PLAN_CONSTRAINTS,
    retryClaim: MEDIATED_PLAN_RETRY_CLAIM,
    providerAlternates: MEDIATED_PLAN_PROVIDER_ALTERNATES,
    ir: EVALUATION_GOVERNED_IR,
    stepId: MEDIATED_PLAN_STEP_ID,
    digest: evaluationDigestPort,
    onPlanComposed: options.onPlanComposed,
    onDecisionRecords: (records) => {
      options.onDecisionRecords(records.length);
    },
  };
}

// ---------------------------------------------------------------------------
// The per-attempt evidence (typed, deterministic, self-verifying)
// ---------------------------------------------------------------------------

/** The attribution projection of a mediated-arm failure (deterministic — observedAt and attributionId excluded). */
export interface AttributionEvidence {
  readonly failureClass: string;
  readonly signal: string;
  readonly component: string;
  readonly stepId: string;
  readonly route: { readonly provider: string; readonly model: string };
  readonly observationDigest: string;
}

/** The strategy-verdict projection of the plan step (or app-owned ladder step) that drove an attempt. */
export interface StrategyVerdictEvidence {
  readonly move: string;
  readonly dimension: string | null;
  readonly candidateId: string;
  readonly strategy: string;
  readonly claimCostMicroUsd: string;
  readonly authority: "recovery-plane" | "app-owned";
}

/** One physical dispatch attempt (the per-attempt evidence record). */
export interface AttemptEvidence {
  readonly armId: ArmId;
  readonly cellId: string;
  /** The transport draw identity (the physical stream key the draws hashed on). */
  readonly streamKey: string;
  readonly baseTaskId: string;
  readonly requestIndex: number;
  readonly rep: number;
  readonly attempt: number;
  readonly providerId: string;
  readonly surface: string;
  readonly modalityClass: string;
  readonly outcome: "success" | "failure";
  readonly failureCategory: "rate-limit" | "timeout" | "provider-unavailable" | null;
  readonly retryable: boolean | null;
  /** The DRAWN synthetic latency (synthetic-latency label); null for the deterministic substrate plane. */
  readonly latencyMs: number | null;
  /** The measured synthetic charge of THIS attempt (synthetic-cost label). */
  readonly costNanoUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly attribution: AttributionEvidence | null;
  readonly strategyVerdict: StrategyVerdictEvidence | null;
}

/** One logical-request occurrence's rollup (the end-to-end evidence). */
export interface OccurrenceEvidence {
  readonly armId: ArmId;
  readonly cellId: string;
  readonly baseTaskId: string;
  readonly requestIndex: number;
  readonly rep: number;
  readonly logicalKey: string;
  readonly surface: string;
  readonly outcome: "resolved" | "failed";
  readonly resolutionClass:
    | "resolved-first-attempt"
    | "resolved-after-recovery"
    | "failed"
    | "replayed-durably"
    | "cache-hit"
    | "deterministic-substrate";
  readonly attempts: number;
  /** The summed drawn synthetic latencies of the occurrence's attempts (null when no supply dispatch). */
  readonly totalLatencyMs: number | null;
  readonly costNanoUsd: number;
  readonly attemptStreamKeys: readonly string[];
}

/** One composed plan's deterministic projection (the mediated arm's recovery evidence). */
export interface PlanEvidence {
  readonly executionId: string;
  readonly planSteps: readonly {
    readonly move: string;
    readonly dimension: string | null;
    readonly candidateId: string;
    readonly strategy: string;
    readonly claimCostMicroUsd: string;
    readonly failoverRoute: string | null;
  }[];
  readonly terminal: string;
  readonly rootFailureClass: string;
  readonly rootFailureSignal: string;
  readonly rootObservationDigest: string;
}

/** One policy/budget violation (the hard gate's evidence — any entry is delivery-blocking). */
export interface ViolationRecord {
  readonly kind:
    | "attempt-bound-exceeded"
    | "budget-ceiling-exceeded"
    | "plan-bound-exceeded"
    | "plan-artifact-invalid"
    | "route-policy-violation"
    | "task-outcome-incoherent";
  readonly armId: ArmId;
  readonly cellId: string;
  readonly detail: string;
}

/** A raised, named evaluation error (fail-closed; never a silent skip). */
export class EvaluationReconstructionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationReconstructionError";
  }
}

// ---------------------------------------------------------------------------
// The shared helpers
// ---------------------------------------------------------------------------

const NO_OP_SLEEPER = async (): Promise<void> => {};

/**
 * The deterministic per-attempt verification: re-derive the outcome from
 * the transport's own pure draw functions and require byte-equal facts
 * (outcome, fault class, drawn latency, measured cost, usage,
 * retryability). The per-attempt evidence is thereby SELF-VERIFYING —
 * reproducible by re-run by construction.
 */
function verifyAgainstDraws(options: {
  readonly streamKey: string;
  readonly attempt: number;
  readonly providerId: string;
  readonly edge: SubjectEdge;
  readonly request: WorkloadRequest;
  readonly evidence: {
    readonly outcome: "success" | "failure";
    readonly failureCategory: string | null;
    readonly retryable: boolean | null;
    readonly latencyMs: number | null;
    readonly costNanoUsd: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
}): void {
  const drawn = outcomeOf({
    providerId: options.providerId,
    edge: options.edge,
    request: options.request,
    streamKey: options.streamKey,
    attempt: options.attempt,
  });
  if (drawn.ok === true) {
    if (
      options.evidence.outcome !== "success" ||
      options.evidence.latencyMs !== drawn.latencyMs ||
      options.evidence.costNanoUsd !== drawn.costNanoUsd ||
      options.evidence.inputTokens !== drawn.usage.inputTokens ||
      options.evidence.outputTokens !== drawn.usage.outputTokens
    ) {
      throw new EvaluationReconstructionError(
        `draw verification mismatch at ${options.streamKey} attempt ${options.attempt} on ${options.providerId}: the pure draw succeeds (latency ${drawn.latencyMs}, cost ${drawn.costNanoUsd}) but the evidence records ${options.evidence.outcome}/${options.evidence.latencyMs}/${options.evidence.costNanoUsd}`,
      );
    }
    return;
  }
  if (
    options.evidence.outcome !== "failure" ||
    options.evidence.failureCategory !== drawn.category ||
    options.evidence.retryable !== drawn.retryable ||
    options.evidence.latencyMs !== drawn.latencyMs ||
    options.evidence.costNanoUsd !== drawn.costNanoUsd ||
    options.evidence.inputTokens !== drawn.usage.inputTokens ||
    options.evidence.outputTokens !== drawn.usage.outputTokens
  ) {
    throw new EvaluationReconstructionError(
      `draw verification mismatch at ${options.streamKey} attempt ${options.attempt} on ${options.providerId}: the pure draw fails with ${drawn.category} (retryable ${drawn.retryable}, latency ${drawn.latencyMs}, cost ${drawn.costNanoUsd}) but the evidence records ${options.evidence.outcome}/${options.evidence.failureCategory}/${options.evidence.retryable}/${options.evidence.latencyMs}/${options.evidence.costNanoUsd}`,
    );
  }
}

/** The percentile under the sweep's own convention (ceil-index; null when no samples). */
export function percentileOf(samples: readonly number[], p: 0.95 | 0.99): number | null {
  if (samples.length === 0) {
    return null;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? null;
}

function meanOf(samples: readonly number[]): number | null {
  if (samples.length === 0) {
    return null;
  }
  return Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length);
}

/** The attribution projection (deterministic fields only). */
function attributionEvidenceOf(plan: ComposedRecoveryPlan): AttributionEvidence {
  return {
    failureClass: plan.failure.failureClass,
    signal: plan.failure.observation.signal,
    component: plan.failure.observation.component,
    stepId: plan.failure.observation.stepId ?? "",
    route: plan.failure.observation.routeRef ?? { provider: "", model: "" },
    observationDigest: plan.failure.observation.observationDigest,
  };
}

// ---------------------------------------------------------------------------
// The mediated-with-plan arm (the real stack, plan mode ON)
// ---------------------------------------------------------------------------

interface MediatedArmRun {
  readonly taskOutcomes: readonly { readonly taskId: string; readonly outcome: string }[];
  readonly tasksTotal: number;
  readonly tasksResolved: number;
  readonly attempts: readonly AttemptEvidence[];
  readonly occurrences: readonly OccurrenceEvidence[];
  readonly plans: readonly PlanEvidence[];
  readonly decisionRecordCount: number;
  readonly nanoCost: number;
  readonly supplyDispatches: number;
  readonly substrateDeterministic: number;
  readonly durableReplays: number;
  readonly transportFaults: number;
  readonly invalidPlanArtifacts: readonly string[];
}

/**
 * Run the mediated-with-plan arm for one cell: the REAL experiment stack
 * (the public API world, the model gateway, the executions authority)
 * with plan mode ON through the PCR-002 evaluation configuration, the
 * corpus driven through the ACR-007 boundary by the capstone's own
 * experiment driver, every composed plan observed (and validated through
 * the plane's own total validation), every attempt reconstructed from
 * the stack's own journals and VERIFIED against the transport's pure
 * draw functions.
 */
async function runMediatedWithPlanArm(options: {
  readonly cell: EvaluationCell;
  readonly now: () => string;
  /**
   * The plan-artifact validation hook (the hard gate's plan-artifact leg).
   * ABSENT at the standalone run — the evaluation's hard-gate basis then
   * carries plan-artifact validation IN-SUITE: the test suites inject the
   * recovery plane's OWN total validation (validateRecoveryPlan — an
   * injection from the unrestricted test tree) over every composed plan
   * of the full evaluation; the deterministic-replay identity (the
   * re-run digest equality) makes the in-suite validation a validation
   * of the committed evidence (see the threshold report's T3 basis).
   */
  readonly planArtifactValidator?: (plan: ComposedRecoveryPlan) => void;
}): Promise<MediatedArmRun> {
  const cell = options.cell;
  const corpus = buildCellCorpus(cell.subject, cell.modality, cell.volume, cell.repetitions);
  const composedPlans: ComposedRecoveryPlan[] = [];
  let decisionRecordCount = 0;
  const sleepJournal: number[] = [];

  const stack: ExperimentStack = await composeExperimentStack({
    subject: cell.subject,
    providerConfig: "multi",
    providerIds: cell.providerIds,
    retryCooldownMs: 0,
    sleeper: async (ms) => {
      sleepJournal.push(ms);
    },
    recovery: {
      planMode: "on",
      plan: mediatedPlanInputsWithObservers({
        onPlanComposed: (plan) => {
          composedPlans.push(plan);
        },
        onDecisionRecords: (count) => {
          decisionRecordCount += count;
        },
      }),
    },
  });
  try {
    const driverBundle = createExperimentDriver({
      subject: cell.subject,
      stack,
      cellId: cell.cellId,
      corpus,
    });
    const report = await runCorpus({
      driver: driverBundle.driver,
      expected: {
        applicationId: stack.applicationId,
        pin: {
          upstreamRevision: cell.subject.upstreamRevision,
          integrationRevision: cell.subject.integrationRevision,
        },
      },
      corpus: corpus.map((task) => ({
        taskId: task.taskId,
        title: task.title,
        instruction: task.instruction,
      })),
      traceSource: experimentTraceSource(stack),
      now: options.now,
    });

    // ---- the per-attempt reconstruction (fail-closed on any mismatch) ----
    const requestRecords = driverBundle.requestRecords();
    const dispatchFacts = stack.dispatchFacts();
    const factsByExecution = new Map(dispatchFacts.map((fact) => [fact.executionId, fact]));
    const faults = [...stack.transport.facts().faults];
    const drawnLatencies = sleepJournal.filter((ms) => ms > 0);
    let faultCursor = 0;
    let latencyCursor = 0;
    let occurrenceCounter = 0;
    let planCursor = 0;
    const attempts: AttemptEvidence[] = [];
    const occurrences: OccurrenceEvidence[] = [];
    const invalidPlanArtifacts: string[] = [];

    const totalCorpusRequests = corpus.reduce((sum, task) => sum + task.requests.length, 0);
    if (requestRecords.length !== totalCorpusRequests) {
      throw new EvaluationReconstructionError(
        `cell ${cell.cellId}: the driver's request records (${requestRecords.length}) do not match the corpus requests (${totalCorpusRequests})`,
      );
    }

    let recordCursor = 0;
    for (const task of corpus) {
      for (const [index, request] of task.requests.entries()) {
        const record: RequestRecord | undefined = requestRecords[recordCursor];
        recordCursor += 1;
        if (record === undefined) {
          throw new EvaluationReconstructionError(
            `cell ${cell.cellId}: missing request record for ${task.baseTaskId} index ${index}`,
          );
        }
        const edge = edgeOf(cell.subject, request.edgeId);
        const isSubstrate = edge.surface === "sandbox-program-execution";
        const baseStreamKey = `${cell.cellId}:${task.baseTaskId}:i${index}`;
        const logicalKey = `${cell.subject.subjectId}:${task.baseTaskId}:${index}`;

        if (record.replayed) {
          // The durable replay: zero provider exposure, the durable outcome stands.
          if (record.outcome !== "resolved") {
            throw new EvaluationReconstructionError(
              `cell ${cell.cellId}: a replayed occurrence at ${baseStreamKey} is not resolved (the fresh-key mechanism mints a new key after failure — a replayed failure is unrepresentable)`,
            );
          }
          occurrences.push({
            armId: "mediated-with-plan",
            cellId: cell.cellId,
            baseTaskId: task.baseTaskId,
            requestIndex: index,
            rep: task.rep,
            logicalKey,
            surface: edge.surface,
            outcome: "resolved",
            resolutionClass: "replayed-durably",
            attempts: 0,
            totalLatencyMs: null,
            costNanoUsd: 0,
            attemptStreamKeys: [],
          });
          continue;
        }

        const fact = factsByExecution.get(record.executionId);
        if (fact === undefined) {
          throw new EvaluationReconstructionError(
            `cell ${cell.cellId}: no dispatch fact for the non-replayed execution ${record.executionId} (${baseStreamKey})`,
          );
        }

        if (isSubstrate) {
          // The deterministic substrate plane (PPR-024): modelCalls 0, no supply dispatch.
          attempts.push({
            armId: "mediated-with-plan",
            cellId: cell.cellId,
            streamKey: baseStreamKey,
            baseTaskId: task.baseTaskId,
            requestIndex: index,
            rep: task.rep,
            attempt: 1,
            providerId: "deterministic",
            surface: edge.surface,
            modalityClass: edge.modalityClass,
            outcome: "success",
            failureCategory: null,
            retryable: null,
            latencyMs: null,
            costNanoUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            attribution: null,
            strategyVerdict: null,
          });
          occurrences.push({
            armId: "mediated-with-plan",
            cellId: cell.cellId,
            baseTaskId: task.baseTaskId,
            requestIndex: index,
            rep: task.rep,
            logicalKey,
            surface: edge.surface,
            outcome: "resolved",
            resolutionClass: "deterministic-substrate",
            attempts: 1,
            totalLatencyMs: null,
            costNanoUsd: 0,
            attemptStreamKeys: [baseStreamKey],
          });
          continue;
        }

        // A model-plane occurrence: the physical dispatch stream key
        // carries the occurrence suffix (each fresh logical dispatch
        // draws fresh provider behavior).
        occurrenceCounter += 1;
        const streamKey = `${baseStreamKey}:d${occurrenceCounter}`;
        const totalAttempts = fact.attempt;
        const finalSucceeded = fact.outcome === "provider-success";
        const failedAttempts = finalSucceeded ? totalAttempts - 1 : totalAttempts;

        // The composed plan of this recovery incident (composition order
        // === execution order; the execution binding cross-checked).
        let plan: ComposedRecoveryPlan | undefined;
        if (failedAttempts > 0) {
          plan = composedPlans[planCursor];
          planCursor += 1;
          if (plan === undefined) {
            throw new EvaluationReconstructionError(
              `cell ${cell.cellId}: a failing first attempt at ${streamKey} composed no plan`,
            );
          }
          const joinedExecution = plan.steps[0]?.context.executionId;
          if (joinedExecution !== undefined && joinedExecution !== record.executionId) {
            throw new EvaluationReconstructionError(
              `cell ${cell.cellId}: the composed plan's execution binding ${joinedExecution} does not match the failing execution ${record.executionId}`,
            );
          }
          if (options.planArtifactValidator !== undefined) {
            try {
              options.planArtifactValidator(plan);
            } catch (error) {
              invalidPlanArtifacts.push(
                `${streamKey}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
        }

        let occurrenceCost = 0;
        let occurrenceLatency = 0;
        const attemptStreamKeys: string[] = [];
        for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
          const isFinal = attempt === totalAttempts;
          let providerId: string;
          let outcomeKind: "success" | "failure";
          let failureCategory: "rate-limit" | "timeout" | "provider-unavailable" | null = null;
          let retryable: boolean | null = null;
          let latencyMs: number;
          let costNanoUsd: number;
          let inputTokens: number;
          let outputTokens: number;
          if (isFinal && finalSucceeded) {
            providerId = fact.providerId;
            outcomeKind = "success";
            const drawn = drawnLatencies[latencyCursor];
            latencyCursor += 1;
            if (drawn === undefined || drawn !== fact.latencyMs) {
              throw new EvaluationReconstructionError(
                `cell ${cell.cellId}: the final success latency at ${streamKey} cannot be reconstructed from the sleep journal`,
              );
            }
            latencyMs = fact.latencyMs;
            const drawnOutcome = outcomeOf({
              providerId,
              edge,
              request,
              streamKey,
              attempt,
            });
            costNanoUsd = drawnOutcome.costNanoUsd;
            inputTokens = fact.usage.inputTokens;
            outputTokens = fact.usage.outputTokens;
          } else {
            const fault = faults[faultCursor];
            if (fault === undefined) {
              throw new EvaluationReconstructionError(
                `cell ${cell.cellId}: the fault journal cannot account for attempt ${attempt} at ${streamKey}`,
              );
            }
            faultCursor += 1;
            const drawn = drawnLatencies[latencyCursor];
            latencyCursor += 1;
            if (drawn === undefined) {
              throw new EvaluationReconstructionError(
                `cell ${cell.cellId}: the sleep journal cannot account for attempt ${attempt} at ${streamKey}`,
              );
            }
            latencyMs = drawn;
            providerId = fault.providerId;
            outcomeKind = "failure";
            failureCategory = fault.category;
            retryable = fault.category !== "provider-unavailable";
            const drawnOutcome = outcomeOf({
              providerId,
              edge,
              request,
              streamKey,
              attempt,
            });
            costNanoUsd = drawnOutcome.costNanoUsd;
            inputTokens = drawnOutcome.usage.inputTokens;
            outputTokens = drawnOutcome.usage.outputTokens;
          }
          attemptStreamKeys.push(streamKey);
          occurrenceCost += costNanoUsd;
          occurrenceLatency += latencyMs;

          // The strategy verdict of the plan step that drove this attempt.
          let strategyVerdict: StrategyVerdictEvidence | null = null;
          if (plan !== undefined && attempt >= 2) {
            const step = plan.steps[attempt - 2];
            if (step !== undefined) {
              strategyVerdict = {
                move: step.move.kind,
                dimension: step.move.kind === "re-route" ? step.move.dimension : null,
                candidateId: step.selection.selected?.candidateId ?? "",
                strategy: step.selection.selected?.strategy ?? "",
                claimCostMicroUsd:
                  step.selection.selected?.evaluation?.expectedSuccessfulResolutionCostMicroUsd ??
                  "",
                authority: "recovery-plane",
              };
            }
          }

          const evidence: AttemptEvidence = {
            armId: "mediated-with-plan",
            cellId: cell.cellId,
            streamKey,
            baseTaskId: task.baseTaskId,
            requestIndex: index,
            rep: task.rep,
            attempt,
            providerId,
            surface: edge.surface,
            modalityClass: edge.modalityClass,
            outcome: outcomeKind,
            failureCategory,
            retryable,
            latencyMs,
            costNanoUsd,
            inputTokens,
            outputTokens,
            attribution: plan === undefined ? null : attributionEvidenceOf(plan),
            strategyVerdict,
          };
          // SELF-VERIFYING EVIDENCE: the record must re-derive from the
          // transport's own pure draw functions (identical inputs →
          // identical draws — the deterministic replay discipline).
          verifyAgainstDraws({
            streamKey,
            attempt,
            providerId,
            edge,
            request,
            evidence,
          });
          attempts.push(evidence);
        }

        occurrences.push({
          armId: "mediated-with-plan",
          cellId: cell.cellId,
          baseTaskId: task.baseTaskId,
          requestIndex: index,
          rep: task.rep,
          logicalKey,
          surface: edge.surface,
          outcome: finalSucceeded ? "resolved" : "failed",
          resolutionClass: finalSucceeded
            ? totalAttempts === 1
              ? "resolved-first-attempt"
              : "resolved-after-recovery"
            : "failed",
          attempts: totalAttempts,
          totalLatencyMs: occurrenceLatency,
          costNanoUsd: occurrenceCost,
          attemptStreamKeys,
        });
      }
    }

    if (faultCursor !== faults.length) {
      throw new EvaluationReconstructionError(
        `cell ${cell.cellId}: ${faults.length - faultCursor} fault(s) left unaccounted after reconstruction`,
      );
    }
    if (latencyCursor !== drawnLatencies.length) {
      throw new EvaluationReconstructionError(
        `cell ${cell.cellId}: ${drawnLatencies.length - latencyCursor} drawn latency(ies) left unaccounted after reconstruction`,
      );
    }
    if (planCursor !== composedPlans.length) {
      throw new EvaluationReconstructionError(
        `cell ${cell.cellId}: ${composedPlans.length - planCursor} composed plan(s) left unassigned`,
      );
    }

    const planEvidence: PlanEvidence[] = composedPlans.map((plan) => ({
      executionId: plan.steps[0]?.context.executionId ?? "",
      planSteps: plan.steps.map((step) => ({
        move: step.move.kind,
        dimension: step.move.kind === "re-route" ? step.move.dimension : null,
        candidateId: step.selection.selected?.candidateId ?? "",
        strategy: step.selection.selected?.strategy ?? "",
        claimCostMicroUsd:
          step.selection.selected?.evaluation?.expectedSuccessfulResolutionCostMicroUsd ?? "",
        failoverRoute:
          step.move.kind === "re-route" && step.move.dimension === "provider"
            ? (step.facts.reroute.provider?.selection.selected?.route.provider ?? null)
            : null,
      })),
      terminal: plan.terminal.kind,
      rootFailureClass: plan.failure.failureClass,
      rootFailureSignal: plan.failure.observation.signal,
      rootObservationDigest: plan.failure.observation.observationDigest,
    }));

    const taskOutcomes = report.runOutcomes.map((entry) => ({
      taskId: entry.taskId,
      outcome: entry.outcome,
    }));
    const tasksResolved = taskOutcomes.filter((entry) => entry.outcome === "PASS").length;

    return {
      taskOutcomes,
      tasksTotal: taskOutcomes.length,
      tasksResolved,
      attempts,
      occurrences,
      plans: planEvidence,
      decisionRecordCount,
      nanoCost: stack.transport.facts().nanoCharged,
      supplyDispatches: attempts.filter((candidate) => candidate.providerId !== "deterministic")
        .length,
      substrateDeterministic: attempts.filter(
        (candidate) => candidate.providerId === "deterministic",
      ).length,
      durableReplays: occurrences.filter((entry) => entry.resolutionClass === "replayed-durably")
        .length,
      transportFaults: faults.length,
      invalidPlanArtifacts,
    };
  } finally {
    await stack.close();
  }
}

// ---------------------------------------------------------------------------
// The baseline arms (the capstone's own executors over wrapped transports)
// ---------------------------------------------------------------------------

/** One wrapped-transport dispatch record (the baselines' per-attempt journal). */
interface BaselineDispatchRecord {
  readonly providerId: string;
  readonly attempt: number;
  readonly streamKey: string;
  readonly ok: boolean;
  readonly category: "rate-limit" | "timeout" | "provider-unavailable" | null;
  readonly retryable: boolean | null;
  readonly latencyMs: number;
  readonly costNanoUsd: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

interface BaselineArmRun {
  readonly tasksTotal: number;
  readonly tasksResolved: number;
  readonly attempts: readonly AttemptEvidence[];
  readonly occurrences: readonly OccurrenceEvidence[];
  readonly nanoCost: number;
  readonly supplyDispatches: number;
  readonly cacheHits: number;
  readonly transportFaults: number;
}

/** Wrap a fresh synthetic transport with the per-dispatch evidence journal. */
function wrappedTransport(options: {
  readonly journal: BaselineDispatchRecord[];
}): ReturnType<typeof createSyntheticSupply> {
  const inner = createSyntheticSupply({ sleeper: NO_OP_SLEEPER });
  return {
    async dispatch(dispatch) {
      const outcome = await inner.dispatch(dispatch);
      options.journal.push({
        providerId: dispatch.providerId,
        attempt: dispatch.attempt,
        streamKey: dispatch.streamKey,
        ok: outcome.ok,
        category: outcome.ok ? null : outcome.category,
        retryable: outcome.ok ? null : outcome.retryable,
        latencyMs: outcome.latencyMs,
        costNanoUsd: outcome.costNanoUsd,
        usage: outcome.usage,
      });
      return outcome;
    },
    facts: () => inner.facts(),
  };
}

/**
 * Run one baseline arm (un-retried direct or strong-optimized) for one
 * cell: the capstone's OWN executor over a fresh wrapped transport
 * (fresh accounting; identical draws — the transport is arm-agnostic),
 * every dispatch journaled and verified against the pure draw functions.
 */
async function runBaselineArm(options: {
  readonly cell: EvaluationCell;
  readonly armId: "un-retried-direct" | "strong-optimized";
  readonly now: () => string;
}): Promise<BaselineArmRun> {
  const cell = options.cell;
  const corpus = buildCellCorpus(cell.subject, cell.modality, cell.volume, cell.repetitions);
  const journal: BaselineDispatchRecord[] = [];
  const transport = wrappedTransport({ journal });
  const executor =
    options.armId === "un-retried-direct"
      ? createDirectBaselineExecutor({
          subject: cell.subject,
          transport,
          cellId: cell.cellId,
          corpus,
          providerIds: cell.providerIds,
          sleeper: NO_OP_SLEEPER,
        })
      : createOptimizedBaselineExecutor({
          subject: cell.subject,
          transport,
          cellId: cell.cellId,
          corpus,
          providerIds: cell.providerIds,
          sleeper: NO_OP_SLEEPER,
        });
  const record = await captureBaseline({
    kind: options.armId === "un-retried-direct" ? "direct-baseline" : "optimized-baseline",
    executor,
    corpus: baselineTasksOf(corpus),
    now: options.now,
  });

  // ---- the per-attempt reconstruction over the journal ----
  const attempts: AttemptEvidence[] = [];
  const occurrences: OccurrenceEvidence[] = [];
  const resolvedDigests = new Set<string>();
  let cursor = 0;
  for (const task of corpus) {
    for (const [index, request] of task.requests.entries()) {
      const edge = edgeOf(cell.subject, request.edgeId);
      const digest = createHash("sha256")
        .update(
          `${cell.subject.subjectId}:${task.baseTaskId}:${index}:${request.edgeId}:${request.inputTokens}:${request.outputTokens}`,
        )
        .digest("hex")
        .slice(0, 32);
      const logicalKey = `${cell.subject.subjectId}:${task.baseTaskId}:${index}`;

      if (options.armId === "strong-optimized" && resolvedDigests.has(digest)) {
        // The app-owned content-addressed cache: zero exposure, resolved.
        occurrences.push({
          armId: options.armId,
          cellId: cell.cellId,
          baseTaskId: task.baseTaskId,
          requestIndex: index,
          rep: task.rep,
          logicalKey,
          surface: edge.surface,
          outcome: "resolved",
          resolutionClass: "cache-hit",
          attempts: 0,
          totalLatencyMs: null,
          costNanoUsd: 0,
          attemptStreamKeys: [],
        });
        continue;
      }

      const armAttempts: AttemptEvidence[] = [];
      while (cursor < journal.length) {
        const dispatch = journal[cursor];
        if (dispatch === undefined) {
          throw new EvaluationReconstructionError(
            `cell ${cell.cellId}: the baseline journal ended mid-occurrence`,
          );
        }
        const expectedStreamKey = `${cell.cellId}:${task.baseTaskId}:r${task.rep}:i${index}`;
        if (dispatch.streamKey !== expectedStreamKey) {
          throw new EvaluationReconstructionError(
            `cell ${cell.cellId}: the ${options.armId} journal's draw identity ${dispatch.streamKey} does not match the expected ${expectedStreamKey}`,
          );
        }
        const expectedProvider =
          options.armId === "un-retried-direct"
            ? (cell.providerIds[0] ?? "supply-a")
            : (cell.providerIds[Math.min(dispatch.attempt - 1, cell.providerIds.length - 1)] ??
              cell.providerIds[0] ??
              "supply-a");
        if (dispatch.providerId !== expectedProvider) {
          throw new EvaluationReconstructionError(
            `cell ${cell.cellId}: the ${options.armId} ladder addressed ${dispatch.providerId} where its own policy addresses ${expectedProvider} (${expectedStreamKey} attempt ${dispatch.attempt})`,
          );
        }
        const evidence: AttemptEvidence = {
          armId: options.armId,
          cellId: cell.cellId,
          streamKey: dispatch.streamKey,
          baseTaskId: task.baseTaskId,
          requestIndex: index,
          rep: task.rep,
          attempt: dispatch.attempt,
          providerId: dispatch.providerId,
          surface: edge.surface,
          modalityClass: edge.modalityClass,
          outcome: dispatch.ok ? "success" : "failure",
          failureCategory: dispatch.category,
          retryable: dispatch.retryable,
          latencyMs: dispatch.latencyMs,
          costNanoUsd: dispatch.costNanoUsd,
          inputTokens: dispatch.usage.inputTokens,
          outputTokens: dispatch.usage.outputTokens,
          attribution: null,
          strategyVerdict:
            options.armId === "strong-optimized" && dispatch.attempt > 1
              ? {
                  move: "app-owned-retry-ladder",
                  dimension: "provider-fallback-chain",
                  candidateId: `app-owned-attempt-${dispatch.attempt}`,
                  strategy: "app-owned",
                  claimCostMicroUsd: "n/a (app-owned ladder — no recovery plane)",
                  authority: "app-owned",
                }
              : null,
        };
        verifyAgainstDraws({
          streamKey: dispatch.streamKey,
          attempt: dispatch.attempt,
          providerId: dispatch.providerId,
          edge,
          request,
          evidence,
        });
        armAttempts.push(evidence);
        cursor += 1;
        if (dispatch.ok) {
          break;
        }
        // The optimized ladder stops at a non-retryable fault (its own
        // declared policy); the direct arm never retries.
        const ladderBound = ARM_ATTEMPT_BOUNDS[options.armId];
        if (!dispatch.retryable || dispatch.attempt >= ladderBound) {
          break;
        }
      }
      const resolved =
        armAttempts.length > 0 && armAttempts[armAttempts.length - 1]?.outcome === "success";
      if (resolved) {
        resolvedDigests.add(digest);
      }
      attempts.push(...armAttempts);
      occurrences.push({
        armId: options.armId,
        cellId: cell.cellId,
        baseTaskId: task.baseTaskId,
        requestIndex: index,
        rep: task.rep,
        logicalKey,
        surface: edge.surface,
        outcome: resolved ? "resolved" : "failed",
        resolutionClass: resolved
          ? armAttempts.length === 1
            ? "resolved-first-attempt"
            : "resolved-after-recovery"
          : "failed",
        attempts: armAttempts.length,
        totalLatencyMs: armAttempts.reduce((sum, candidate) => sum + (candidate.latencyMs ?? 0), 0),
        costNanoUsd: armAttempts.reduce((sum, candidate) => sum + candidate.costNanoUsd, 0),
        attemptStreamKeys: armAttempts.map((candidate) => candidate.streamKey),
      });
    }
  }
  if (cursor !== journal.length) {
    throw new EvaluationReconstructionError(
      `cell ${cell.cellId}: ${journal.length - cursor} baseline dispatch(es) left unaccounted after reconstruction`,
    );
  }

  const tasksResolved = record.taskRuns.filter((run) => run.succeeded === true).length;
  return {
    tasksTotal: record.taskRuns.length,
    tasksResolved,
    attempts,
    occurrences,
    nanoCost: transport.facts().nanoCharged,
    supplyDispatches: journal.length,
    cacheHits: occurrences.filter((entry) => entry.resolutionClass === "cache-hit").length,
    transportFaults: transport.facts().faults.length,
  };
}

// ---------------------------------------------------------------------------
// The cell evaluation (all three arms, fresh, one revision, one process)
// ---------------------------------------------------------------------------

/** One arm's per-cell summary. */
export interface ArmCellSummary {
  readonly armId: ArmId;
  readonly cellId: string;
  readonly tasksTotal: number;
  readonly tasksResolved: number;
  readonly requestsTotal: number;
  readonly requestsResolved: number;
  readonly attemptsTotal: number;
  readonly supplyDispatches: number;
  readonly durableReplaysOrCacheHits: number;
  readonly substrateDeterministic: number;
  readonly nanoCost: number;
  readonly microPerResolvedTask: number | null;
  readonly microPerResolvedRequest: number | null;
  readonly faultsByCategory: {
    readonly rateLimit: number;
    readonly timeout: number;
    readonly unavailable: number;
  };
  readonly faultsTotal: number;
}

/** One cell's full evaluation result (the committed artifact's shape). */
export interface CellEvaluationResult {
  readonly cellId: string;
  readonly capstoneCellId: string;
  readonly subjectId: string;
  readonly dimensions: {
    readonly volume: string;
    readonly repetitions: number;
    readonly providerConfig: "multi";
    readonly modality: string;
  };
  readonly corpus: { readonly tasks: number; readonly requests: number };
  readonly arms: Readonly<Record<ArmId, ArmCellSummary>>;
  readonly attempts: readonly AttemptEvidence[];
  readonly occurrences: readonly OccurrenceEvidence[];
  readonly plans: readonly PlanEvidence[];
  readonly decisionRecordCount: number;
  readonly violations: readonly ViolationRecord[];
  readonly digest: string;
  readonly wallMs: number;
  readonly notes: readonly string[];
}

function armCellSummaryOf(options: {
  readonly armId: ArmId;
  readonly cellId: string;
  readonly tasksTotal: number;
  readonly tasksResolved: number;
  readonly occurrences: readonly OccurrenceEvidence[];
  readonly attempts: readonly AttemptEvidence[];
  readonly nanoCost: number;
  readonly supplyDispatches: number;
  readonly durableReplaysOrCacheHits: number;
  readonly substrateDeterministic: number;
}): ArmCellSummary {
  const requestsResolved = options.occurrences.filter(
    (entry) => entry.outcome === "resolved",
  ).length;
  const faultsByCategory = { rateLimit: 0, timeout: 0, unavailable: 0 };
  let faultsTotal = 0;
  for (const attempt of options.attempts) {
    if (attempt.outcome === "failure" && attempt.failureCategory !== null) {
      faultsTotal += 1;
      if (attempt.failureCategory === "rate-limit") {
        faultsByCategory.rateLimit += 1;
      } else if (attempt.failureCategory === "timeout") {
        faultsByCategory.timeout += 1;
      } else {
        faultsByCategory.unavailable += 1;
      }
    }
  }
  return {
    armId: options.armId,
    cellId: options.cellId,
    tasksTotal: options.tasksTotal,
    tasksResolved: options.tasksResolved,
    requestsTotal: options.occurrences.length,
    requestsResolved,
    attemptsTotal: options.attempts.length,
    supplyDispatches: options.supplyDispatches,
    durableReplaysOrCacheHits: options.durableReplaysOrCacheHits,
    substrateDeterministic: options.substrateDeterministic,
    nanoCost: options.nanoCost,
    microPerResolvedTask:
      options.tasksResolved > 0 ? options.nanoCost / options.tasksResolved / 1000 : null,
    microPerResolvedRequest:
      requestsResolved > 0 ? options.nanoCost / requestsResolved / 1000 : null,
    faultsByCategory,
    faultsTotal,
  };
}

/** The violations scan's input (pure — the mechanical hard-gate oracle). */
export interface ViolationScanInput {
  readonly cell: EvaluationCell;
  readonly armRuns: readonly {
    readonly armId: ArmId;
    readonly occurrences: readonly OccurrenceEvidence[];
    readonly attempts: readonly AttemptEvidence[];
  }[];
  readonly mediatedPlans: readonly PlanEvidence[];
  readonly invalidPlanArtifacts: readonly string[];
  readonly mediatedTasksTotal: number;
  readonly mediatedTasksResolved: number;
}

/**
 * The mechanical policy/budget violations scan (the hard gate's
 * oracle — PURE): attempt bounds, the per-execution budget ceiling,
 * the plan step bound, the plan-artifact validity, the route policy
 * and the task↔request outcome coherence, over every attempt of every
 * arm. Any record is delivery-blocking evidence.
 */
export function scanViolations(input: ViolationScanInput): ViolationRecord[] {
  const violations: ViolationRecord[] = [];
  const runBudgetNano = 10_000_000; // the driver's declared per-execution constraint (10000 micro-USD)
  for (const run of input.armRuns) {
    const bound = ARM_ATTEMPT_BOUNDS[run.armId];
    for (const occurrence of run.occurrences) {
      if (occurrence.attempts > bound) {
        violations.push({
          kind: "attempt-bound-exceeded",
          armId: run.armId,
          cellId: input.cell.cellId,
          detail: `occurrence ${occurrence.logicalKey} (rep ${occurrence.rep}) took ${occurrence.attempts} attempts — the arm's declared bound is ${bound}`,
        });
      }
      if (occurrence.costNanoUsd > runBudgetNano) {
        violations.push({
          kind: "budget-ceiling-exceeded",
          armId: run.armId,
          cellId: input.cell.cellId,
          detail: `occurrence ${occurrence.logicalKey} charged ${occurrence.costNanoUsd} nano-USD — the declared per-execution budget ceiling is ${runBudgetNano}`,
        });
      }
    }
    for (const attempt of run.attempts) {
      const allowedRoutes =
        run.armId === "mediated-with-plan"
          ? [...input.cell.providerIds, "deterministic"]
          : [...input.cell.providerIds];
      if (!allowedRoutes.includes(attempt.providerId)) {
        violations.push({
          kind: "route-policy-violation",
          armId: run.armId,
          cellId: input.cell.cellId,
          detail: `attempt ${attempt.attempt} at ${attempt.streamKey} addressed the unregistered route ${attempt.providerId}`,
        });
      }
    }
  }
  for (const plan of input.mediatedPlans) {
    if (plan.planSteps.length > MEDIATED_PLAN_CONFIGURATION.maxPlanSteps) {
      violations.push({
        kind: "plan-bound-exceeded",
        armId: "mediated-with-plan",
        cellId: input.cell.cellId,
        detail: `a composed plan carries ${plan.planSteps.length} steps — the configured bound is ${MEDIATED_PLAN_CONFIGURATION.maxPlanSteps}`,
      });
    }
  }
  for (const invalid of input.invalidPlanArtifacts) {
    violations.push({
      kind: "plan-artifact-invalid",
      armId: "mediated-with-plan",
      cellId: input.cell.cellId,
      detail: `a composed plan failed the plane's own total validation: ${invalid}`,
    });
  }
  const mediatedTaskFailures = input.mediatedTasksTotal - input.mediatedTasksResolved;
  const mediatedOccurrenceFailures =
    input.armRuns
      .find((run) => run.armId === "mediated-with-plan")
      ?.occurrences.filter((entry) => entry.outcome === "failed").length ?? 0;
  if (mediatedTaskFailures > 0 !== mediatedOccurrenceFailures > 0) {
    violations.push({
      kind: "task-outcome-incoherent",
      armId: "mediated-with-plan",
      cellId: input.cell.cellId,
      detail: `the runner reports ${mediatedTaskFailures} failed task(s) while the occurrence evidence records ${mediatedOccurrenceFailures} failed request(s) — the task↔request outcome coherence is broken`,
    });
  }
  return violations;
}

/**
 * The cell's content digest: sha256 over the canonical projection of
 * the cell's evidence (per-arm summaries, per-arm attempts and
 * occurrences, the mediated arm's composed plans, the violations) —
 * deterministic (wall-clock and run identities excluded) and
 * discriminating (any evidence change is a different digest). Exported
 * so the digest discipline is verifiable: a tampered evidence record
 * digests differently.
 */
export function cellDigestOf(cell: Omit<CellEvaluationResult, "digest">): string {
  const armsInput: Record<string, unknown> = {};
  for (const armId of ARM_IDS) {
    armsInput[armId] = {
      summary: cell.arms[armId],
      attempts: cell.attempts.filter((attempt) => attempt.armId === armId),
      occurrences: cell.occurrences.filter((occurrence) => occurrence.armId === armId),
      ...(armId === "mediated-with-plan" ? { plans: cell.plans } : {}),
    };
  }
  return sha256HexOf({
    cellId: cell.cellId,
    arms: armsInput,
    violations: cell.violations,
  });
}

/**
 * Run ONE targeted cell's three-arm evaluation: all three arms FRESH at
 * this revision, in this process, over the same corpus and the same
 * arm-agnostic synthetic supply — then the mechanical violations scan
 * and the deterministic digest.
 */
export async function runEvaluationCell(options: {
  readonly cell: EvaluationCell;
  readonly now?: () => string;
  /** The plan-artifact validation hook (see runMediatedWithPlanArm — in-suite by default). */
  readonly planArtifactValidator?: (plan: ComposedRecoveryPlan) => void;
}): Promise<CellEvaluationResult> {
  const cell = options.cell;
  const now = options.now ?? (() => new Date().toISOString());
  const wallStartedAt = Date.now();

  const mediated = await runMediatedWithPlanArm({
    cell,
    now,
    ...(options.planArtifactValidator === undefined
      ? {}
      : { planArtifactValidator: options.planArtifactValidator }),
  });
  const direct = await runBaselineArm({ cell, armId: "un-retried-direct", now });
  const optimized = await runBaselineArm({ cell, armId: "strong-optimized", now });

  const arms: Record<ArmId, ArmCellSummary> = {
    "un-retried-direct": armCellSummaryOf({
      armId: "un-retried-direct",
      cellId: cell.cellId,
      tasksTotal: direct.tasksTotal,
      tasksResolved: direct.tasksResolved,
      occurrences: direct.occurrences,
      attempts: direct.attempts,
      nanoCost: direct.nanoCost,
      supplyDispatches: direct.supplyDispatches,
      durableReplaysOrCacheHits: direct.cacheHits,
      substrateDeterministic: 0,
    }),
    "strong-optimized": armCellSummaryOf({
      armId: "strong-optimized",
      cellId: cell.cellId,
      tasksTotal: optimized.tasksTotal,
      tasksResolved: optimized.tasksResolved,
      occurrences: optimized.occurrences,
      attempts: optimized.attempts,
      nanoCost: optimized.nanoCost,
      supplyDispatches: optimized.supplyDispatches,
      durableReplaysOrCacheHits: optimized.cacheHits,
      substrateDeterministic: 0,
    }),
    "mediated-with-plan": armCellSummaryOf({
      armId: "mediated-with-plan",
      cellId: cell.cellId,
      tasksTotal: mediated.tasksTotal,
      tasksResolved: mediated.tasksResolved,
      occurrences: mediated.occurrences,
      attempts: mediated.attempts,
      nanoCost: mediated.nanoCost,
      supplyDispatches: mediated.supplyDispatches,
      durableReplaysOrCacheHits: mediated.durableReplays,
      substrateDeterministic: mediated.substrateDeterministic,
    }),
  };

  // ---- the mechanical violations scan (the hard gate's evidence) ----
  const violations = scanViolations({
    cell,
    armRuns: [
      { armId: "un-retried-direct", occurrences: direct.occurrences, attempts: direct.attempts },
      {
        armId: "strong-optimized",
        occurrences: optimized.occurrences,
        attempts: optimized.attempts,
      },
      {
        armId: "mediated-with-plan",
        occurrences: mediated.occurrences,
        attempts: mediated.attempts,
      },
    ],
    mediatedPlans: mediated.plans,
    invalidPlanArtifacts: mediated.invalidPlanArtifacts,
    mediatedTasksTotal: mediated.tasksTotal,
    mediatedTasksResolved: mediated.tasksResolved,
  });

  const digest = cellDigestOf({
    cellId: cell.cellId,
    capstoneCellId: cell.capstoneCellId,
    subjectId: cell.subjectId,
    dimensions: {
      volume: cell.volume,
      repetitions: cell.repetitions,
      providerConfig: "multi",
      modality: cell.modality,
    },
    corpus: {
      tasks: arms["mediated-with-plan"].tasksTotal,
      requests: arms["mediated-with-plan"].requestsTotal,
    },
    arms,
    attempts: [...direct.attempts, ...optimized.attempts, ...mediated.attempts],
    occurrences: [...direct.occurrences, ...optimized.occurrences, ...mediated.occurrences],
    plans: mediated.plans,
    decisionRecordCount: mediated.decisionRecordCount,
    violations,
    wallMs: 0,
    notes: [],
  });

  return {
    cellId: cell.cellId,
    capstoneCellId: cell.capstoneCellId,
    subjectId: cell.subjectId,
    dimensions: {
      volume: cell.volume,
      repetitions: cell.repetitions,
      providerConfig: "multi",
      modality: cell.modality,
    },
    corpus: {
      tasks: arms["mediated-with-plan"].tasksTotal,
      requests: arms["mediated-with-plan"].requestsTotal,
    },
    arms,
    attempts: [...direct.attempts, ...optimized.attempts, ...mediated.attempts],
    occurrences: [...direct.occurrences, ...optimized.occurrences, ...mediated.occurrences],
    plans: mediated.plans,
    decisionRecordCount: mediated.decisionRecordCount,
    violations,
    digest,
    wallMs: Date.now() - wallStartedAt,
    notes: [
      COST_BASIS_NOTE,
      LATENCY_BASIS_NOTE,
      "all three arms ran FRESH at this revision in one process over the same corpus and the same arm-agnostic deterministic synthetic supply (the exact-revision rule)",
    ],
  };
}

// ---------------------------------------------------------------------------
// The aggregation + the threshold verdicts (ACR-008 §7)
// ---------------------------------------------------------------------------

/** One arm's aggregate over the targeted cells. */
export interface ArmAggregate {
  readonly armId: ArmId;
  readonly cells: number;
  readonly tasksTotal: number;
  readonly tasksResolved: number;
  readonly taskResolutionRate: number | null;
  readonly requestsTotal: number;
  readonly requestsResolved: number;
  readonly requestResolutionRate: number | null;
  readonly attemptsTotal: number;
  readonly supplyDispatches: number;
  readonly durableReplaysOrCacheHits: number;
  readonly substrateDeterministic: number;
  readonly nanoCost: number;
  readonly microPerResolvedTask: number | null;
  readonly microPerResolvedRequest: number | null;
  readonly faultsTotal: number;
  readonly faultsByCategory: {
    readonly rateLimit: number;
    readonly timeout: number;
    readonly unavailable: number;
  };
}

function armAggregateOf(cells: readonly CellEvaluationResult[], armId: ArmId): ArmAggregate {
  let tasksTotal = 0;
  let tasksResolved = 0;
  let requestsTotal = 0;
  let requestsResolved = 0;
  let attemptsTotal = 0;
  let supplyDispatches = 0;
  let reuse = 0;
  let substrate = 0;
  let nanoCost = 0;
  const faultsByCategory = { rateLimit: 0, timeout: 0, unavailable: 0 };
  for (const cell of cells) {
    const arm = cell.arms[armId];
    tasksTotal += arm.tasksTotal;
    tasksResolved += arm.tasksResolved;
    requestsTotal += arm.requestsTotal;
    requestsResolved += arm.requestsResolved;
    attemptsTotal += arm.attemptsTotal;
    supplyDispatches += arm.supplyDispatches;
    reuse += arm.durableReplaysOrCacheHits;
    substrate += arm.substrateDeterministic;
    nanoCost += arm.nanoCost;
    faultsByCategory.rateLimit += arm.faultsByCategory.rateLimit;
    faultsByCategory.timeout += arm.faultsByCategory.timeout;
    faultsByCategory.unavailable += arm.faultsByCategory.unavailable;
  }
  return {
    armId,
    cells: cells.length,
    tasksTotal,
    tasksResolved,
    taskResolutionRate: tasksTotal > 0 ? tasksResolved / tasksTotal : null,
    requestsTotal,
    requestsResolved,
    requestResolutionRate: requestsTotal > 0 ? requestsResolved / requestsTotal : null,
    attemptsTotal,
    supplyDispatches,
    durableReplaysOrCacheHits: reuse,
    substrateDeterministic: substrate,
    nanoCost,
    microPerResolvedTask: tasksResolved > 0 ? nanoCost / tasksResolved / 1000 : null,
    microPerResolvedRequest: requestsResolved > 0 ? nanoCost / requestsResolved / 1000 : null,
    faultsTotal:
      faultsByCategory.rateLimit + faultsByCategory.timeout + faultsByCategory.unavailable,
    faultsByCategory,
  };
}

/** One latency-tail group (p95/p99 over drawn synthetic latencies). */
export interface LatencyTailGroup {
  readonly key: string;
  readonly samples: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly p99Ms: number | null;
  readonly meanMs: number | null;
}

function tailGroupOf(key: string, samples: readonly number[]): LatencyTailGroup {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    key,
    samples: samples.length,
    p50Ms: samples.length === 0 ? null : (sorted[Math.floor(sorted.length / 2)] ?? null),
    p95Ms: percentileOf(samples, 0.95),
    p99Ms: percentileOf(samples, 0.99),
    meanMs: meanOf(samples),
  };
}

/** The complete latency-tail accounting (per attempt by class and route; per occurrence end-to-end). */
export interface LatencyTailAccounting {
  readonly perAttemptByClass: readonly LatencyTailGroup[];
  readonly perAttemptByRoute: readonly LatencyTailGroup[];
  readonly perOccurrence: readonly LatencyTailGroup[];
  readonly basisNote: string;
}

function latencyTailAccountingOf(cells: readonly CellEvaluationResult[]): LatencyTailAccounting {
  const byClass = new Map<string, number[]>();
  const byRoute = new Map<string, number[]>();
  const byOccurrence = new Map<string, number[]>();
  for (const cell of cells) {
    for (const attempt of cell.attempts) {
      if (attempt.latencyMs === null) {
        continue;
      }
      const classKey = `${attempt.armId}:${
        attempt.outcome === "success" ? "success" : attempt.failureCategory
      }`;
      byClass.set(classKey, [...(byClass.get(classKey) ?? []), attempt.latencyMs]);
      const routeKey = `${attempt.armId}:${attempt.providerId}`;
      byRoute.set(routeKey, [...(byRoute.get(routeKey) ?? []), attempt.latencyMs]);
    }
    for (const occurrence of cell.occurrences) {
      if (occurrence.totalLatencyMs === null) {
        continue;
      }
      const key = `${occurrence.armId}:${occurrence.resolutionClass}`;
      byOccurrence.set(key, [...(byOccurrence.get(key) ?? []), occurrence.totalLatencyMs]);
    }
  }
  const sortedEntries = (map: Map<string, number[]>) =>
    [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return {
    perAttemptByClass: sortedEntries(byClass).map(([key, samples]) => tailGroupOf(key, samples)),
    perAttemptByRoute: sortedEntries(byRoute).map(([key, samples]) => tailGroupOf(key, samples)),
    perOccurrence: sortedEntries(byOccurrence).map(([key, samples]) => tailGroupOf(key, samples)),
    basisNote: LATENCY_BASIS_NOTE,
  };
}

/** The full threshold verdict set (every number labeled; misses carry attribution). */
export interface ThresholdVerdictSet {
  readonly resolution: {
    readonly threshold: string;
    readonly mediatedTaskResolutionRate: number | null;
    readonly optimizedTaskResolutionRate: number | null;
    readonly deltaPercentagePoints: number | null;
    readonly mediatedRequestResolutionRate: number | null;
    readonly optimizedRequestResolutionRate: number | null;
    readonly cellsWhereMediatedAtLeastOptimized: number;
    readonly cellsTotal: number;
    readonly verdict: "met" | "missed";
    readonly attribution: string | null;
  };
  readonly cost: {
    readonly threshold: string;
    readonly mediatedMicroPerResolvedTask: number | null;
    readonly optimizedMicroPerResolvedTask: number | null;
    readonly mediatedExposuresPerResolvedRequest: number | null;
    readonly optimizedExposuresPerResolvedRequest: number | null;
    readonly verdict: "met" | "documented-tradeoff";
    readonly attribution: string;
  };
  readonly violations: {
    readonly threshold: string;
    readonly count: number;
    readonly verdict: "met" | "delivery-blocking";
    readonly records: readonly ViolationRecord[];
  };
  readonly latencyTails: {
    readonly threshold: string;
    readonly accounting: LatencyTailAccounting;
    readonly mediatedRecoveredP95Ms: number | null;
    readonly optimizedRecoveredP95Ms: number | null;
    readonly verdict: "accounted";
  };
  readonly pcr004Eligibility: {
    readonly sequentialPlansReachedResolutionThreshold: boolean;
    readonly hedgedModeEligible: boolean;
    readonly statement: string;
  };
}

/** The full evaluation aggregate (the committed artifact's shape). */
export interface EvaluationAggregate {
  readonly version: 1;
  readonly evaluationId: string;
  readonly corpusVersion: string;
  readonly baseRevision: string;
  readonly cells: readonly CellEvaluationResult[];
  readonly arms: Readonly<Record<ArmId, ArmAggregate>>;
  readonly latencyTails: LatencyTailAccounting;
  readonly verdicts: ThresholdVerdictSet;
  readonly digest: string;
  readonly labels: typeof SYNTHETIC_LABELS;
}

/**
 * Aggregate the cell results and derive the threshold verdicts
 * (ACR-008 §7): resolution equal-or-better vs the FRESH strong baseline
 * in the targeted cells; failure-adjusted cost improved-or-documented;
 * ZERO policy/budget violations (the hard gate); explicit latency-tail
 * tradeoff accounting; the PCR-004 eligibility statement derived from
 * the measured evidence.
 */
export function aggregateEvaluation(cells: readonly CellEvaluationResult[]): EvaluationAggregate {
  const mediated = armAggregateOf(cells, "mediated-with-plan");
  const direct = armAggregateOf(cells, "un-retried-direct");
  const optimized = armAggregateOf(cells, "strong-optimized");
  const tails = latencyTailAccountingOf(cells);

  const resolutionDelta =
    mediated.taskResolutionRate !== null && optimized.taskResolutionRate !== null
      ? (mediated.taskResolutionRate - optimized.taskResolutionRate) * 100
      : null;
  const cellsWhereMediatedAtLeastOptimized = cells.filter(
    (cell) =>
      cell.arms["mediated-with-plan"].tasksResolved >= cell.arms["strong-optimized"].tasksResolved,
  ).length;
  const resolutionMet =
    mediated.taskResolutionRate !== null &&
    optimized.taskResolutionRate !== null &&
    mediated.taskResolutionRate >= optimized.taskResolutionRate;

  const costImproved =
    mediated.microPerResolvedTask !== null &&
    optimized.microPerResolvedTask !== null &&
    mediated.microPerResolvedTask <= optimized.microPerResolvedTask;
  const mediatedExposuresPerResolved =
    mediated.requestsResolved > 0 ? mediated.supplyDispatches / mediated.requestsResolved : null;
  const optimizedExposuresPerResolved =
    optimized.requestsResolved > 0 ? optimized.supplyDispatches / optimized.requestsResolved : null;
  const costAttribution = costImproved
    ? "the mediated-with-plan arm resolved its outcomes at a lower or equal failure-adjusted synthetic cost per resolved task than the fresh strong-optimized arm (synthetic-cost label)"
    : `the mediated-with-plan arm paid a higher failure-adjusted synthetic cost per resolved task (${mediated.microPerResolvedTask?.toFixed(3)} vs ${optimized.microPerResolvedTask?.toFixed(3)} micro-USD, synthetic-cost); attribution: the composed ladder re-exposes the incumbent supply on its retry step before failing over (measured supply exposures per resolved request ${mediatedExposuresPerResolved?.toFixed(4)} vs ${optimizedExposuresPerResolved?.toFixed(4)}) and the mediated arm re-exposes every unresolved logical request on its next corpus occurrence while the optimized arm's cache absorbs repeats of resolved ones — a documented tradeoff under the improved-or-documented threshold, never a silent regression`;

  const violationRecords = cells.flatMap((cell) => cell.violations);
  const mediatedRecoveredP95 =
    tails.perOccurrence.find((group) => group.key === "mediated-with-plan:resolved-after-recovery")
      ?.p95Ms ?? null;
  const optimizedRecoveredP95 =
    tails.perOccurrence.find((group) => group.key === "strong-optimized:resolved-after-recovery")
      ?.p95Ms ?? null;

  const verdicts: ThresholdVerdictSet = {
    resolution: {
      threshold: THRESHOLDS.resolution,
      mediatedTaskResolutionRate: mediated.taskResolutionRate,
      optimizedTaskResolutionRate: optimized.taskResolutionRate,
      deltaPercentagePoints: resolutionDelta,
      mediatedRequestResolutionRate: mediated.requestResolutionRate,
      optimizedRequestResolutionRate: optimized.requestResolutionRate,
      cellsWhereMediatedAtLeastOptimized,
      cellsTotal: cells.length,
      verdict: resolutionMet ? "met" : "missed",
      attribution: resolutionMet
        ? null
        : `the mediated-with-plan arm resolved ${mediated.tasksResolved}/${mediated.tasksTotal} tasks vs the fresh strong-optimized arm's ${optimized.tasksResolved}/${optimized.tasksTotal} in the targeted multi-provider cells — see the per-cell table for the concentrating cells`,
    },
    cost: {
      threshold: THRESHOLDS.cost,
      mediatedMicroPerResolvedTask: mediated.microPerResolvedTask,
      optimizedMicroPerResolvedTask: optimized.microPerResolvedTask,
      mediatedExposuresPerResolvedRequest: mediatedExposuresPerResolved,
      optimizedExposuresPerResolvedRequest: optimizedExposuresPerResolved,
      verdict: costImproved ? "met" : "documented-tradeoff",
      attribution: costAttribution,
    },
    violations: {
      threshold: "zero policy/budget violations (the hard gate)",
      count: violationRecords.length,
      verdict: violationRecords.length === 0 ? "met" : "delivery-blocking",
      records: violationRecords,
    },
    latencyTails: {
      threshold: THRESHOLDS.latencyTails,
      accounting: tails,
      mediatedRecoveredP95Ms: mediatedRecoveredP95,
      optimizedRecoveredP95Ms: optimizedRecoveredP95,
      verdict: "accounted",
    },
    pcr004Eligibility: {
      sequentialPlansReachedResolutionThreshold: resolutionMet,
      hedgedModeEligible: !resolutionMet,
      statement: resolutionMet
        ? `PCR-004 (hedged execution) is NOT eligible on this evidence: sequential plans REACHED the resolution threshold on the side-effect-safe idempotent targeted cells (mediated-with-plan task resolution ${((mediated.taskResolutionRate ?? 0) * 100).toFixed(2)}% >= strong-optimized ${((optimized.taskResolutionRate ?? 0) * 100).toFixed(2)}%, measured fresh over ${cells.length} multi-provider cells; ACR-008 §5 admits hedging only on evidence that sequential plans CANNOT reach the threshold)`
        : `PCR-004 (hedged execution) IS eligible on this evidence: sequential plans did NOT reach the resolution threshold on the side-effect-safe idempotent targeted cells (mediated-with-plan task resolution ${((mediated.taskResolutionRate ?? 0) * 100).toFixed(2)}% < strong-optimized ${((optimized.taskResolutionRate ?? 0) * 100).toFixed(2)}%, measured fresh over ${cells.length} multi-provider cells) — the ACR-008 §5 eligibility condition is met by measurement`,
    },
  };

  const digest = sha256HexOf({
    version: 1,
    evaluationId: EVALUATION_ID,
    corpusVersion: CORPUS_VERSION,
    baseRevision: BASE_REVISION,
    cellDigests: cells.map((cell) => ({ cellId: cell.cellId, digest: cell.digest })),
    arms: { mediated, direct, optimized },
    verdicts,
  });

  return {
    version: 1,
    evaluationId: EVALUATION_ID,
    corpusVersion: CORPUS_VERSION,
    baseRevision: BASE_REVISION,
    cells,
    arms: {
      "un-retried-direct": direct,
      "strong-optimized": optimized,
      "mediated-with-plan": mediated,
    },
    latencyTails: tails,
    verdicts,
    digest,
    labels: SYNTHETIC_LABELS,
  };
}
