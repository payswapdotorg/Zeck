/**
 * The PPR-018 rail worker — the execution-plane driver that takes every
 * execution the adapter creates (through the public API) and executes it
 * through the executions authority's own public commands, dispatching
 * the model call through the REAL model gateway.
 *
 * THE SEQUENCE (the platform's own dispatch discipline, VAL-010's
 * `driveExecutionToCompletion` pattern):
 *
 *   authorize → plan → recordPlanningDecision (durable route facts)
 *   → queue → start (+ budget reservation estimate)
 *   → step event tool-requested
 *   → gateway.complete (identity → admission → capability → rail →
 *     durable intent → credential materialization → adapter call)
 *   → step event tool-result (the model completion, usage, latency —
 *     the public output fact the adapter reads back)
 *   → verify → pass (mechanical verification criteria) | fail
 *
 * The response CONTENT rides the execution's public event ledger (the
 * `tool-result` step event's payload) — the same ledger the public API
 * exposes at GET /executions/:id/events. Nothing flows back to the
 * application except through the public boundary.
 */

import type { ApiWorld } from "../../../tests/unit/api/world";
import type { ExecutionActor, ExecutionRecord } from "../../../src/modules/executions/public";
import type { ModelRequest } from "../../../src/modules/models/domain/request";
import type { ModelDispatchResult, ModelGateway } from "../../../src/modules/models/application/model-gateway";

/** The task shape the adapter creates (the integration's task contract). */
export interface CodingCompletionTask {
  readonly kind: "coding-assistant.completion";
  readonly role: "main" | "weak" | "summarizer";
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly params?: Readonly<Record<string, unknown>>;
}

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
  readonly route: { readonly provider: string; readonly model: string };
  readonly hooks?: RailWorkerHooks;
  /**
   * Minimum interval between rail dispatches (supply pacing). The
   * sandbox's GLM supply throttles request bursts; serializing with a
   * floor interval keeps the proof's dispatch pattern gentle (each
   * dispatch still fully executes — this is pacing, never batching).
   */
  readonly minDispatchIntervalMs?: number;
}

export interface RailWorker {
  /**
   * Execute one CREATED execution through the authority's commands to a
   * terminal status. Throws only on infrastructure bugs; provider-axis
   * failures land the execution in FAILED (the honest terminal state).
   */
  execute(record: ExecutionRecord, actor: ExecutionActor): Promise<void>;
}

/** Parse and validate the task payload (fail closed on shape). */
export function parseCodingCompletionTask(
  task: Readonly<Record<string, unknown>>,
): CodingCompletionTask | null {
  if (task.kind !== "coding-assistant.completion") {
    return null;
  }
  const messages = task.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }
  const parsed: { role: string; content: string }[] = [];
  for (const message of messages) {
    if (typeof message !== "object" || message === null) {
      return null;
    }
    const role = (message as { role?: unknown }).role;
    const content = (message as { content?: unknown }).content;
    if (typeof role !== "string" || typeof content !== "string") {
      return null;
    }
    parsed.push({ role, content });
  }
  const role = task.role;
  return {
    kind: "coding-assistant.completion",
    role: role === "weak" || role === "summarizer" ? role : "main",
    messages: parsed,
    ...(typeof task.params === "object" && task.params !== null
      ? { params: task.params as Record<string, unknown> }
      : {}),
  };
}

export function createRailWorker(options: RailWorkerOptions): RailWorker {
  const { world, gateway, route, hooks } = options;
  const executions = world.executions;
  const minInterval = options.minDispatchIntervalMs ?? 0;
  let lastDispatchStartedAt = 0;
  const pace = async (): Promise<void> => {
    if (minInterval <= 0) {
      return;
    }
    const wait = lastDispatchStartedAt + minInterval - Date.now();
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  };

  const execute = async (record: ExecutionRecord, actor: ExecutionActor): Promise<void> => {
    const task = parseCodingCompletionTask(record.task as Record<string, unknown>);
    const key = (step: string) => `ppr-018-rail-${record.id}-${step}`;

    // The canonical lifecycle drive (VAL-010's sequence).
    for (const step of ["authorize", "plan"] as const) {
      await executions.transition(
        { command: step, applicationId: record.applicationId, executionId: record.id, ...actor },
        key(step),
      );
    }

    // The durable planning decision: the rail's route facts, recorded on
    // the ledger before dispatch (route = neutral strings).
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
              strategyId: "ppr-018-model-rail",
              plan: {
                strategyClass: "model-rail",
                modelCalls: 1,
                steps: [{ routeRef: { provider: route.provider, model: route.model } }],
              },
            },
          ],
          selectedStrategyId: "ppr-018-model-rail",
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
              recordedBy: "ppr-018-rail-worker",
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
        reference: { tool: "model-rail", provider: route.provider, model: route.model },
        payload: {
          tool: "model-rail",
          role: task.role,
          requestMessages: task.messages.length,
        },
      },
      key("tool-requested"),
    );

    const request: ModelRequest = {
      model: route.model,
      messages: task.messages.map((message) => ({
        role: message.role === "assistant" ? ("assistant" as const) : message.role === "system" ? ("system" as const) : ("user" as const),
        content: message.content,
      })),
      ...(typeof task.params?.temperature === "number"
        ? { temperature: task.params.temperature }
        : {}),
      ...(typeof task.params?.maxTokens === "number"
        ? { maxTokens: task.params.maxTokens }
        : {}),
    };

    let dispatch: ModelDispatchResult;
    try {
      await pace();
      lastDispatchStartedAt = Date.now();
      dispatch = await gateway.complete(request);
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
              recordedBy: "ppr-018-rail-worker",
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
              recordedBy: "ppr-018-rail-worker",
            },
          ],
        },
        key("fail"),
      );
      return;
    }

    const response = dispatch.outcome.response;
    const content = response.content.join("");
    const wellFormed = content.length > 0;
    const usageRecorded =
      response.usage.inputTokens > 0 || response.usage.outputTokens > 0;

    // The model completion rides the PUBLIC ledger (the output fact).
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
          content,
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
            criterionId: "response-wellformed",
            strategy: "mechanical-nonempty",
            status: wellFormed ? "PASS" : "FAIL",
            recordedBy: "ppr-018-rail-worker",
            evidence: [`tool-result:${dispatch.attemptId}`],
          },
          {
            criterionId: "usage-recorded",
            strategy: "mechanical-usage-presence",
            status: usageRecorded ? "PASS" : "INCONCLUSIVE",
            recordedBy: "ppr-018-rail-worker",
          },
        ],
      },
      key("pass"),
    );
  };

  return { execute };
}
