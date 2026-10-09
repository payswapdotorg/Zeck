/**
 * The PPR-025 execution driver — the execution-plane worker that takes
 * every execution the adapter creates (through the public API) and
 * executes it through the executions authority's own public commands,
 * dispatching by task kind across the delegated surfaces (the identical
 * discipline PPR-018/019/020/022/023/024 established, composed for the
 * multi-surface shape this proof certifies):
 *
 *   authorize → plan → recordPlanningDecision (durable route facts)
 *   → queue → start (+ budget reservation estimate)
 *   → step event tool-requested
 *   → [CHAT/IMAGE/ASR/TTS] gateway.complete (identity → admission →
 *     capability → rail → durable intent → credential materialization →
 *     adapter call → GLM supply)
 *     [EMBEDDINGS] the Zeck-side DETERMINISTIC embeddings executor (the
 *     recorded supply boundary: /embeddings → 404; a real deterministic
 *     computation, strategyClass "deterministic-embeddings", modelCalls
 *     0 — disclosed in the execution graph, never a fixture)
 *   → step event tool-result (the normalized result fact: a chat turn,
 *     an embeddings result, an image/transcript/audio fact — the public
 *     output fact the adapter reads back)
 *   → verify → pass (mechanical verification criteria) | fail
 *
 * The response facts ride the execution's public event ledger — the same
 * ledger the public API exposes at GET /executions/:id/events. Nothing
 * flows back to the application except through the public boundary.
 */

import type { ApiWorld } from "../../../tests/unit/api/world";
import type { ExecutionActor, ExecutionRecord } from "../../../src/modules/executions/public";
import type { ModelRequest } from "../../../src/modules/models/domain/request";
import type { ModelDispatchResult } from "../../../src/modules/models/application/model-gateway";
import {
  buildRailEnvelope,
  COMPLETION_TASK_KIND,
  EMBEDDINGS_TASK_KIND,
  encodeModelRequest,
  hasImagePart,
  IMAGE_TASK_KIND,
  parseOpenWebUiTask,
  SPEECH_TASK_KIND,
  TRANSCRIPTION_TASK_KIND,
  turnOfStructuredOutput,
  type OpenWebUiCompletionTask,
} from "./rail-protocol";
import {
  DETERMINISTIC_EMBEDDINGS_MODEL,
  DETERMINISTIC_EMBEDDINGS_DIMENSIONS,
  RAIL_MODEL,
  RAIL_VISION_MODEL,
} from "./zai-config";
import {
  DETERMINISTIC_EMBEDDINGS_STRATEGY,
  deterministicEmbeddingOf,
  isWellFormedEmbedding,
} from "./embeddings";

/** The model-plane dispatch seam over the real gateway. */
export interface RailGateway {
  complete(request: ModelRequest): Promise<ModelDispatchResult>;
}

export interface WorkerHooks {
  /** Recorded for every rail dispatch outcome (the battery's telemetry axis). */
  onRailOutcome(fact: {
    readonly executionId: string;
    readonly attemptId: string;
    readonly outcome: "provider-success" | "provider-failure";
    readonly latencyMs: number | null;
    readonly usage: { inputTokens: number; outputTokens: number } | null;
    readonly replayed: boolean;
  }): void;
  /** Recorded for every deterministic embeddings outcome (the honest strategy axis). */
  onDeterministicOutcome(fact: {
    readonly executionId: string;
    readonly outcome: "deterministic-success" | "deterministic-failure";
    readonly latencyMs: number | null;
    readonly vectorCount: number;
  }): void;
}

export interface WorkerOptions {
  readonly world: ApiWorld;
  readonly gateway: RailGateway;
  readonly hooks?: WorkerHooks;
  /** Minimum interval between rail dispatches (supply pacing). */
  readonly minDispatchIntervalMs?: number;
  /**
   * The Zeck-OWNED bounded retry for retryable provider-axis failures
   * (rate-limit/timeout/network): ACR-007 §1 — "Zeck owns …
   * policy-permitted retry, escalation and continuation" for the
   * delegated edge. ONE retry after a cooldown; both attempts are
   * recorded honestly (never an application-side shadow retry).
   */
  readonly retryCooldownMs?: number;
  /** The sleeper (injectable for tests). */
  readonly sleeper?: (ms: number) => Promise<void>;
}

export interface ExecutionDriver {
  /**
   * Execute one CREATED execution through the authority's commands to a
   * terminal status. Throws only on infrastructure bugs; provider-axis
   * and deterministic-axis failures land the execution in FAILED (the
   * honest terminal state).
   */
  execute(record: ExecutionRecord, actor: ExecutionActor): Promise<void>;
}

/** The route model for one chat task (the rail's execution-plane choice). */
export function routeModelOf(task: { kind: string; messages?: readonly unknown[] }): string {
  if (task.kind === COMPLETION_TASK_KIND) {
    return (task.messages ?? []).some((message) => hasImagePart(message))
      ? RAIL_VISION_MODEL
      : RAIL_MODEL;
  }
  return RAIL_MODEL;
}

export function createExecutionDriver(options: WorkerOptions): ExecutionDriver {
  const { world, gateway, hooks } = options;
  const executions = world.executions;
  const minInterval = options.minDispatchIntervalMs ?? 0;
  const retryCooldownMs = options.retryCooldownMs ?? 20_000;
  const sleep = options.sleeper ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastDispatchStartedAt = 0;
  const pace = async (): Promise<void> => {
    if (minInterval <= 0) {
      return;
    }
    const wait = lastDispatchStartedAt + minInterval - Date.now();
    if (wait > 0) {
      await sleep(wait);
    }
  };

  /**
   * Dispatch through the gateway with the Zeck-owned bounded retry for
   * retryable provider-axis failures (one cooldown retry — the
   * platform's policy-permitted retry, both attempts recorded).
   */
  const dispatchWithPolicyRetry = async (
    request: Parameters<RailGateway["complete"]>[0],
    record: ExecutionRecord,
    actor: ExecutionActor,
  ): Promise<ModelDispatchResult> => {
    await pace();
    lastDispatchStartedAt = Date.now();
    const first = await gateway.complete(request);
    if (first.outcome.kind === "provider-failure" && first.outcome.failure.retryable) {
      await executions.recordStepEvent(
        {
          applicationId: record.applicationId,
          executionId: record.id,
          actor,
          command: "tool-result",
          cause: "model-rail-retryable-failure",
          reference: { tool: "model-rail", attemptId: first.attemptId },
          payload: {
            tool: "model-rail",
            kind: "model-failure",
            category: first.outcome.failure.category,
            retryable: true,
            policyRetry: "scheduled",
          },
        },
        `ppr-025-rail-${record.id}-retry-note`,
      );
      await sleep(retryCooldownMs);
      await pace();
      lastDispatchStartedAt = Date.now();
      const second = await gateway.complete(request);
      return second;
    }
    return first;
  };

  const failExecution = async (
    record: ExecutionRecord,
    actor: ExecutionActor,
    reason: string,
    key: (step: string) => string,
    criterion: string,
  ): Promise<void> => {
    await executions.transition(
      {
        command: "fail",
        applicationId: record.applicationId,
        executionId: record.id,
        ...actor,
        reason: reason.slice(0, 200),
        verificationResults: [
          {
            criterionId: criterion,
            strategy: "mechanical-validation",
            status: "FAIL",
            recordedBy: "ppr-025-execution-driver",
          },
        ],
      },
      key("fail"),
    );
  };

  const execute = async (record: ExecutionRecord, actor: ExecutionActor): Promise<void> => {
    const task = parseOpenWebUiTask(record.task as Record<string, unknown>);
    const key = (step: string) => `ppr-025-driver-${record.id}-${step}`;

    // The canonical lifecycle drive (VAL-010's sequence).
    for (const step of ["authorize", "plan"] as const) {
      await executions.transition(
        { command: step, applicationId: record.applicationId, executionId: record.id, ...actor },
        key(step),
      );
    }

    // The route identity + the durable planning decision (route = neutral
    // strings), recorded on the ledger before dispatch. Every kind routes
    // honestly: the chat/image/audio surfaces to the model rail; the
    // embeddings surface to the DETERMINISTIC executor (modelCalls 0).
    const isModelTask =
      task !== null &&
      (task.kind === COMPLETION_TASK_KIND ||
        task.kind === IMAGE_TASK_KIND ||
        task.kind === TRANSCRIPTION_TASK_KIND ||
        task.kind === SPEECH_TASK_KIND);
    const isDeterministicTask = task !== null && task.kind === EMBEDDINGS_TASK_KIND;
    const routeModel = task === null ? RAIL_MODEL : routeModelOf(task);
    const mediaModelOf = (kind: string): string =>
      kind === IMAGE_TASK_KIND
        ? "glm-image"
        : kind === TRANSCRIPTION_TASK_KIND
          ? "glm-asr"
          : "glm-tts";
    const routeRef = isDeterministicTask
      ? { provider: "deterministic", model: DETERMINISTIC_EMBEDDINGS_MODEL }
      : isModelTask && task !== null && task.kind !== COMPLETION_TASK_KIND
        ? { provider: "custom", model: mediaModelOf(task.kind) }
        : { provider: "custom", model: routeModel };
    const strategyId = isDeterministicTask
      ? DETERMINISTIC_EMBEDDINGS_STRATEGY.strategyId
      : "ppr-025-model-rail";
    const strategyClass = isDeterministicTask
      ? DETERMINISTIC_EMBEDDINGS_STRATEGY.strategyClass
      : "model-rail";
    const modelCalls = isDeterministicTask ? 0 : 1;
    await executions.recordPlanningDecision(
      {
        applicationId: record.applicationId,
        executionId: record.id,
        tenantId: record.tenantId,
        actorId: actor.actorId,
        decisionId: `decision-${record.id}`,
        planId: `plan-${record.id}`,
        payload: {
          candidates: [
            {
              strategyId,
              plan: {
                strategyClass,
                modelCalls,
                steps: [{ routeRef }],
              },
            },
          ],
          selectedStrategyId: strategyId,
        },
      },
      key("decision"),
    );

    await executions.transition(
      { command: "queue", applicationId: record.applicationId, executionId: record.id, ...actor },
      key("queue"),
    );
    await executions.transition(
      {
        command: "start",
        applicationId: record.applicationId,
        executionId: record.id,
        ...actor,
        dispatch: { operationId: `dispatch-${record.id}`, amountMicroUsd: "5000" },
      },
      key("start"),
    );

    if (task === null) {
      // A malformed task is an honest FAILED execution (never a guess).
      await failExecution(
        record,
        actor,
        "task shape rejected by the execution driver",
        key,
        "task-shape",
      );
      return;
    }

    await executions.recordStepEvent(
      {
        applicationId: record.applicationId,
        executionId: record.id,
        actor,
        command: "tool-requested",
        cause: isDeterministicTask
          ? "deterministic-embeddings-dispatch"
          : "model-rail-dispatch",
        reference: {
          tool: isDeterministicTask ? "deterministic-embeddings" : "model-rail",
          ...(isDeterministicTask
            ? {}
            : { provider: "custom", model: task.kind === COMPLETION_TASK_KIND ? routeModel : mediaModelOf(task.kind) }),
        },
        payload: {
          tool: isDeterministicTask ? "deterministic-embeddings" : "model-rail",
          edge: task.edge,
          kind: task.kind,
          ...(task.kind === COMPLETION_TASK_KIND
            ? {
                role: task.role,
                rail: task.rail,
                ...(task.taskLabel === undefined ? {} : { taskLabel: task.taskLabel }),
                requestMessages: task.messages.length,
                vision: task.messages.some((message) => hasImagePart(message)),
              }
            : {}),
          ...(task.kind === EMBEDDINGS_TASK_KIND
            ? { inputCount: task.input.length, wire: task.wire, dimensions: DETERMINISTIC_EMBEDDINGS_DIMENSIONS }
            : {}),
        },
      },
      key("tool-requested"),
    );

    // ------------------------------------------------------------------
    // THE DETERMINISTIC EMBEDDINGS PLANE (the recorded supply boundary)
    // ------------------------------------------------------------------
    if (task.kind === EMBEDDINGS_TASK_KIND) {
      const startedAt = Date.now();
      let vectors: (readonly number[])[];
      try {
        vectors = task.input.map((text) => deterministicEmbeddingOf(text));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        hooks?.onDeterministicOutcome({
          executionId: record.id,
          outcome: "deterministic-failure",
          latencyMs: Date.now() - startedAt,
          vectorCount: 0,
        });
        await executions.recordStepEvent(
          {
            applicationId: record.applicationId,
            executionId: record.id,
            actor,
            command: "tool-result",
            cause: "deterministic-embeddings-failure",
            reference: { tool: "deterministic-embeddings" },
            payload: { tool: "deterministic-embeddings", error: message.slice(0, 300) },
          },
          key("tool-result-failure"),
        );
        await failExecution(
          record,
          actor,
          `deterministic embeddings failure (${message.slice(0, 120)})`,
          key,
          "embeddings-dispatch",
        );
        return;
      }
      // The mechanical verification: every vector well-formed AND the
      // recomputation is byte-identical (determinism is CHECKED, never
      // assumed — the honest strategy axis).
      const wellFormed = vectors.every(
        (vector) => isWellFormedEmbedding(vector).ok,
      );
      const recomputedIdentical = vectors.every(
        (vector, index) =>
          JSON.stringify(vector) === JSON.stringify(deterministicEmbeddingOf(task.input[index] ?? "")),
      );
      const ok = wellFormed && recomputedIdentical;
      hooks?.onDeterministicOutcome({
        executionId: record.id,
        outcome: ok ? "deterministic-success" : "deterministic-failure",
        latencyMs: Date.now() - startedAt,
        vectorCount: vectors.length,
      });
      await executions.recordStepEvent(
        {
          applicationId: record.applicationId,
          executionId: record.id,
          actor,
          command: "tool-result",
          cause: ok ? "deterministic-embeddings-result" : "deterministic-embeddings-failure",
          reference: { tool: "deterministic-embeddings" },
          payload: {
            tool: "deterministic-embeddings",
            kind: "embeddings-result",
            dimensions: DETERMINISTIC_EMBEDDINGS_DIMENSIONS,
            vectors: vectors.length,
            modelCalls: 0,
            strategy: DETERMINISTIC_EMBEDDINGS_STRATEGY.strategyClass,
            // The full transportable vectors (the adapter reads this back
            // and returns them through the public boundary — the durable
            // evidence of the delegated embeddings computation).
            embeddings: vectors.map((vector) => [...vector]),
          },
        },
        key("tool-result"),
      );
      if (!ok) {
        await failExecution(
          record,
          actor,
          "deterministic embeddings verification failed (well-formedness or determinism)",
          key,
          "embeddings-dispatch",
        );
        return;
      }
      await executions.transition(
        { command: "verify", applicationId: record.applicationId, executionId: record.id, ...actor },
        key("verify"),
      );
      await executions.transition(
        {
          command: "pass",
          applicationId: record.applicationId,
          executionId: record.id,
          ...actor,
          verificationResults: [
            {
              criterionId: "embeddings-wellformed",
              strategy: "mechanical-fixed-dimension-unit-norm",
              status: "PASS",
              recordedBy: "ppr-025-execution-driver",
              evidence: [`deterministic:${record.id}`],
            },
            {
              criterionId: "embeddings-deterministic",
              strategy: "mechanical-recomputation-identity",
              status: recomputedIdentical ? "PASS" : "FAIL",
              recordedBy: "ppr-025-execution-driver",
            },
          ],
        },
        key("pass"),
      );
      return;
    }

    // ----------------------------------------------------------------------
    // THE MODEL PLANE (the rail: chat, image, asr, tts)
    // ----------------------------------------------------------------------
    const request = encodeModelRequest(buildRailEnvelope(task), task.kind === COMPLETION_TASK_KIND ? routeModel : mediaModelOf(task.kind));

    let dispatch: ModelDispatchResult;
    try {
      dispatch = await dispatchWithPolicyRetry(request, record, actor);
    } catch (error) {
      // Pre-dispatch rejections (identity/scope/admission) — record and fail.
      const message = error instanceof Error ? error.message : String(error);
      await executions.recordStepEvent(
        {
          applicationId: record.applicationId,
          executionId: record.id,
          actor,
          command: "tool-denied",
          cause: "gateway-rejection",
          reference: { tool: "model-rail" },
          payload: { tool: "model-rail", rejection: message.slice(0, 200) },
        },
        key("tool-denied"),
      );
      await failExecution(
        record,
        actor,
        `model gateway rejected the dispatch: ${message.slice(0, 160)}`,
        key,
        "rail-dispatch",
      );
      hooks?.onRailOutcome({
        executionId: record.id,
        attemptId: "",
        outcome: "provider-failure",
        latencyMs: null,
        usage: null,
        replayed: false,
      });
      return;
    }

    hooks?.onRailOutcome({
      executionId: record.id,
      attemptId: dispatch.attemptId,
      outcome: dispatch.outcome.kind,
      latencyMs:
        dispatch.outcome.kind === "provider-success"
          ? dispatch.outcome.response.providerLatencyMs
          : dispatch.outcome.failure.durationMs,
      usage:
        dispatch.outcome.kind === "provider-success"
          ? {
              inputTokens: dispatch.outcome.response.usage.inputTokens,
              outputTokens: dispatch.outcome.response.usage.outputTokens,
            }
          : null,
      replayed: false,
    });

    if (dispatch.outcome.kind === "provider-failure") {
      await executions.recordStepEvent(
        {
          applicationId: record.applicationId,
          executionId: record.id,
          actor,
          command: "tool-result",
          cause: "model-rail-provider-failure",
          reference: { tool: "model-rail", attemptId: dispatch.attemptId },
          payload: {
            tool: "model-rail",
            kind: "model-failure",
            category: dispatch.outcome.failure.category,
            retryable: dispatch.outcome.failure.retryable,
          },
        },
        key("tool-result-failure"),
      );
      await failExecution(
        record,
        actor,
        `provider-axis failure (${dispatch.outcome.failure.category})`,
        key,
        "rail-dispatch",
      );
      return;
    }

    const response = dispatch.outcome.response;

    // The normalized result fact rides the PUBLIC ledger (the output fact),
    // per task kind — the adapter reads the fact of ITS kind back.
    if (task.kind === COMPLETION_TASK_KIND) {
      const completionTask = task as OpenWebUiCompletionTask;
      const turn = turnOfStructuredOutput(response.structuredOutput) ?? {
        content: response.content.join(""),
        toolCalls: [],
        finishReason: response.stopReason,
      };
      const wellFormed = turn.content.length > 0 || turn.toolCalls.length > 0;
      const usageRecorded = response.usage.inputTokens > 0 || response.usage.outputTokens > 0;
      await executions.recordStepEvent(
        {
          applicationId: record.applicationId,
          executionId: record.id,
          actor,
          command: "tool-result",
          cause: "model-rail-completion",
          reference: { tool: "model-rail", attemptId: dispatch.attemptId },
          payload: {
            tool: "model-rail",
            kind: "model-completion",
            content: turn.content,
            toolCalls: [...turn.toolCalls],
            finishReason: turn.finishReason,
            usage: {
              // Key names deliberately avoid the wire scrubber's
              // secret-shaped-key pattern (it redacts any *token* key).
              input: response.usage.inputTokens,
              output: response.usage.outputTokens,
            },
            providerLatencyMs: response.providerLatencyMs,
            stopReason: response.stopReason,
          },
        },
        key("tool-result"),
      );
      await executions.transition(
        { command: "verify", applicationId: record.applicationId, executionId: record.id, ...actor },
        key("verify"),
      );
      await executions.transition(
        {
          command: "pass",
          applicationId: record.applicationId,
          executionId: record.id,
          ...actor,
          verificationResults: [
            {
              criterionId: "result-wellformed",
              strategy: "mechanical-nonempty",
              status: wellFormed ? "PASS" : "FAIL",
              recordedBy: "ppr-025-execution-driver",
              evidence: [`tool-result:${dispatch.attemptId}`],
            },
            {
              criterionId: "usage-recorded",
              strategy: "mechanical-usage-presence",
              status: usageRecorded ? "PASS" : "INCONCLUSIVE",
              recordedBy: "ppr-025-execution-driver",
            },
            ...(completionTask.taskLabel === undefined
              ? []
              : [
                  {
                    criterionId: "auxiliary-turn-labeled",
                    strategy: "mechanical-attribution-label",
                    status: "PASS" as const,
                    recordedBy: "ppr-025-execution-driver",
                  },
                ]),
          ],
        },
        key("pass"),
      );
      return;
    }

    // The media facts (image / transcript / audio) — the structured
    // output IS the fact; record it verbatim with its kind.
    const structured = response.structuredOutput;
    const mediaOk = structured !== null;
    await executions.recordStepEvent(
      {
        applicationId: record.applicationId,
        executionId: record.id,
        actor,
        command: "tool-result",
        cause: mediaOk ? "model-rail-media-result" : "model-rail-malformed-result",
        reference: { tool: "model-rail", attemptId: dispatch.attemptId },
        payload: mediaOk
          ? {
              tool: "model-rail",
              kind: structured?.name ?? "unknown",
              ...(structured?.json as Readonly<Record<string, unknown>>),
            }
          : { tool: "model-rail", error: "no structured media fact on the response" },
      },
      key("tool-result"),
    );
    await executions.transition(
      { command: "verify", applicationId: record.applicationId, executionId: record.id, ...actor },
      key("verify"),
    );
    await executions.transition(
      {
        command: "pass",
        applicationId: record.applicationId,
        executionId: record.id,
        ...actor,
        verificationResults: [
          {
            criterionId: "media-result-wellformed",
            strategy: "mechanical-structured-fact-presence",
            status: mediaOk ? "PASS" : "FAIL",
            recordedBy: "ppr-025-execution-driver",
            evidence: [`tool-result:${dispatch.attemptId}`],
          },
        ],
      },
      key("pass"),
    );
  };

  return { execute };
}

/** The route identity the rail's planning decisions record (neutral strings). */
export const RAIL_STRATEGY = {
  strategyId: "ppr-025-model-rail",
  strategyClass: "model-rail",
} as const;
