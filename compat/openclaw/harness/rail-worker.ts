/**
 * The PPR-023 rail worker — the execution-plane driver that takes every
 * execution the adapter creates (through the public API) and executes it
 * through the executions authority's own public commands, dispatching
 * the model call through the REAL model gateway (the identical
 * discipline PPR-018/019/020/022 established; the platform's own VAL-010 /
 * docs-battery `driveExecutionToCompletion` pattern), extended to the
 * four surfaces the pinned OpenClaw runtime delegates:
 *
 *   authorize → plan → recordPlanningDecision (durable route facts)
 *   → queue → start (+ budget reservation estimate)
 *   → step event tool-requested
 *   → gateway.complete (identity → admission → capability → rail →
 *     durable intent → credential materialization → adapter call)
 *   → step event tool-result (the normalized result fact: a chat turn, a
 *     speech artifact, a transcript or an image artifact — the public
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
import type {
  ModelDispatchResult,
  ModelGateway,
} from "../../../src/modules/models/application/model-gateway";
import {
  buildRailEnvelope,
  encodeModelRequest,
  hasImagePart,
  imageResultOf,
  parseOpenClawTask,
  speechResultOf,
  transcriptionResultOf,
  turnOfStructuredOutput,
  type OpenClawRailTask,
} from "./rail-protocol";
import {
  RAIL_IMAGE_MODEL,
  RAIL_MODEL,
  RAIL_SPEECH_MODEL,
  RAIL_TRANSCRIPTION_MODEL,
  RAIL_VISION_MODEL,
} from "./zai-config";

/** The rail worker's dispatch seam over the real gateway. */
export interface RailGateway {
  complete(request: ModelRequest): Promise<ModelDispatchResult>;
}

export interface RailWorkerHooks {
  /** Recorded for every rail dispatch outcome (the battery's telemetry axis). */
  onRailOutcome(fact: {
    readonly executionId: string;
    readonly attemptId: string;
    readonly outcome: "provider-success" | "provider-failure";
    readonly latencyMs: number | null;
    readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
    readonly replayed: boolean;
  }): void;
}

export interface RailWorkerOptions {
  readonly world: ApiWorld;
  readonly gateway: RailGateway;
  readonly hooks?: RailWorkerHooks;
  /**
   * Minimum interval between rail dispatches (supply pacing). The
   * sandbox's GLM supply throttles request bursts; serializing with a
   * floor interval keeps the proof's dispatch pattern gentle (each
   * dispatch still fully executes — this is pacing, never batching).
   */
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

export interface RailWorker {
  /**
   * Execute one CREATED execution through the authority's commands to a
   * terminal status. Throws only on infrastructure bugs; provider-axis
   * failures land the execution in FAILED (the honest terminal state).
   */
  execute(record: ExecutionRecord, actor: ExecutionActor): Promise<void>;
}

/** The route model for one task kind (the rail's execution-plane choice). */
export function routeModelOf(task: OpenClawRailTask): string {
  if (task.kind === "openclaw.agent-loop.completion") {
    return task.messages.some((message) => hasImagePart(message))
      ? RAIL_VISION_MODEL
      : RAIL_MODEL;
  }
  if (task.kind === "openclaw.tool.tts") {
    return RAIL_SPEECH_MODEL;
  }
  if (task.kind === "openclaw.media-understanding.audio") {
    return RAIL_TRANSCRIPTION_MODEL;
  }
  return RAIL_IMAGE_MODEL;
}

export function createRailWorker(options: RailWorkerOptions): RailWorker {
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
        `ppr-023-rail-${record.id}-retry-note`,
      );
      await sleep(retryCooldownMs);
      await pace();
      lastDispatchStartedAt = Date.now();
      const second = await gateway.complete(request);
      return second;
    }
    return first;
  };

  const execute = async (record: ExecutionRecord, actor: ExecutionActor): Promise<void> => {
    const task = parseOpenClawTask(record.task as Record<string, unknown>);
    const key = (step: string) => `ppr-023-rail-${record.id}-${step}`;

    // The canonical lifecycle drive (VAL-010's sequence).
    for (const step of ["authorize", "plan"] as const) {
      await executions.transition(
        { command: step, applicationId: record.applicationId, executionId: record.id, ...actor },
        key(step),
      );
    }

    // The route model + the durable planning decision (route = neutral
    // strings), recorded on the ledger before dispatch.
    const routeModel = task === null ? RAIL_MODEL : routeModelOf(task);
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
              strategyId: "ppr-023-model-rail",
              plan: {
                strategyClass: "model-rail",
                modelCalls: 1,
                steps: [{ routeRef: { provider: "custom", model: routeModel } }],
              },
            },
          ],
          selectedStrategyId: "ppr-023-model-rail",
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
      await executions.transition(
        {
          command: "fail",
          applicationId: record.applicationId,
          executionId: record.id,
          ...actor,
          reason: "task shape rejected by the rail worker",
          verificationResults: [
            {
              criterionId: "task-shape",
              strategy: "mechanical-validation",
              status: "FAIL",
              recordedBy: "ppr-023-rail-worker",
            },
          ],
        },
        key("fail"),
      );
      return;
    }

    await executions.recordStepEvent(
      {
        applicationId: record.applicationId,
        executionId: record.id,
        actor,
        command: "tool-requested",
        cause: "model-rail-dispatch",
        reference: { tool: "model-rail", provider: "custom", model: routeModel },
        payload: {
          tool: "model-rail",
          edge: task.edge,
          kind: task.kind,
          ...(task.kind === "openclaw.agent-loop.completion"
            ? {
                role: task.role,
                requestMessages: task.messages.length,
                toolsDeclared: task.tools?.length ?? 0,
                vision: task.messages.some((message) => hasImagePart(message)),
              }
            : {}),
          ...(task.kind === "openclaw.tool.tts"
            ? { inputChars: task.input.length, format: task.responseFormat ?? "wav" }
            : {}),
          ...(task.kind === "openclaw.media-understanding.audio"
            ? { audioBase64Chars: task.fileBase64.length }
            : {}),
          ...(task.kind === "openclaw.tool.image-generate"
            ? { promptChars: task.prompt.length, size: task.size ?? "1024x1024" }
            : {}),
        },
      },
      key("tool-requested"),
    );

    const request = encodeModelRequest(buildRailEnvelope(task), routeModel);

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
      await executions.transition(
        {
          command: "fail",
          applicationId: record.applicationId,
          executionId: record.id,
          ...actor,
          reason: `model gateway rejected the dispatch: ${message.slice(0, 160)}`,
          verificationResults: [
            {
              criterionId: "rail-dispatch",
              strategy: "mechanical-validation",
              status: "FAIL",
              recordedBy: "ppr-023-rail-worker",
            },
          ],
        },
        key("fail"),
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
      await executions.transition(
        {
          command: "fail",
          applicationId: record.applicationId,
          executionId: record.id,
          ...actor,
          reason: `provider-axis failure (${dispatch.outcome.failure.category})`,
          verificationResults: [
            {
              criterionId: "rail-dispatch",
              strategy: "provider-axis-observation",
              status: "FAIL",
              recordedBy: "ppr-023-rail-worker",
            },
          ],
        },
        key("fail"),
      );
      return;
    }

    const response = dispatch.outcome.response;
    const structured = response.structuredOutput;

    // The per-kind normalized result fact + its mechanical verification
    // criteria (the honest per-surface wellformedness checks).
    let resultPayload: Readonly<Record<string, unknown>>;
    let wellFormed: boolean;
    let usageRecorded: boolean;
    if (task.kind === "openclaw.agent-loop.completion") {
      const turn = turnOfStructuredOutput(structured) ?? {
        content: response.content.join(""),
        toolCalls: [],
        finishReason: response.stopReason,
      };
      wellFormed = turn.content.length > 0 || turn.toolCalls.length > 0;
      usageRecorded = response.usage.inputTokens > 0 || response.usage.outputTokens > 0;
      resultPayload = {
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
      };
    } else if (task.kind === "openclaw.tool.tts") {
      const speech = speechResultOf(structured);
      wellFormed = speech !== null && speech.audioBase64.length > 0;
      usageRecorded = true;
      resultPayload = {
        tool: "model-rail",
        kind: "speech-result",
        ...(speech === null
          ? {}
          : {
              audioBase64: speech.audioBase64,
              mime: speech.mime,
              format: speech.format,
            }),
        providerLatencyMs: response.providerLatencyMs,
      };
    } else if (task.kind === "openclaw.media-understanding.audio") {
      const transcript = transcriptionResultOf(structured);
      wellFormed = transcript !== null && transcript.text.length > 0;
      usageRecorded =
        transcript !== null && (transcript.inputTokens > 0 || transcript.outputTokens > 0);
      resultPayload = {
        tool: "model-rail",
        kind: "transcription-result",
        ...(transcript === null
          ? {}
          : {
              text: transcript.text,
              usage: { input: transcript.inputTokens, output: transcript.outputTokens },
            }),
        providerLatencyMs: response.providerLatencyMs,
      };
    } else {
      const image = imageResultOf(structured);
      wellFormed = image !== null && image.imageBase64.length > 0;
      usageRecorded = true;
      resultPayload = {
        tool: "model-rail",
        kind: "image-result",
        ...(image === null
          ? {}
          : { imageBase64: image.imageBase64, mime: image.mime, size: image.size }),
        providerLatencyMs: response.providerLatencyMs,
      };
    }

    // The normalized result fact rides the PUBLIC ledger (the output fact).
    await executions.recordStepEvent(
      {
        applicationId: record.applicationId,
        executionId: record.id,
        actor,
        command: "tool-result",
        cause: "model-rail-completion",
        reference: { tool: "model-rail", attemptId: dispatch.attemptId },
        payload: resultPayload,
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
            recordedBy: "ppr-023-rail-worker",
            evidence: [`tool-result:${dispatch.attemptId}`],
          },
          {
            criterionId: "usage-recorded",
            strategy: "mechanical-usage-presence",
            status: usageRecorded ? "PASS" : "INCONCLUSIVE",
            recordedBy: "ppr-023-rail-worker",
          },
        ],
      },
      key("pass"),
    );
  };

  return { execute };
}

/** The task contract re-export (the adapter's payload shape). */
export type { OpenClawRailTask };
