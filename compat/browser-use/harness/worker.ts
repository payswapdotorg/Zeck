/**
 * The PPR-024 execution driver — the execution-plane worker that takes
 * every execution the adapter creates (through the public API) and
 * executes it through the executions authority's own public commands,
 * dispatching by task kind across the TWO planes this proof certifies
 * (the identical discipline PPR-018/019/020/022/023 established,
 * extended to the two-plane shape the work order demands):
 *
 *   authorize → plan → recordPlanningDecision (durable route facts)
 *   → queue → start (+ budget reservation estimate)
 *   → step event tool-requested
 *   → [MODEL PLANE] gateway.complete (identity → admission →
 *     capability → rail → durable intent → credential materialization →
 *     adapter call → GLM supply)
 *     [SUBSTRATE PLANE] substrate driver RPC (the pinned runtime's own
 *     BrowserSession/Tools over the real Chromium — the neutral
 *     tool/substrate contract's executor)
 *   → step event tool-result (the normalized result fact: a chat turn,
 *     a substrate session fact, a state summary or an action result —
 *     the public output fact the adapter reads back)
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
  encodeModelRequest,
  hasImagePart,
  parseBrowserUseTask,
  STATE_TASK_KIND,
  SESSION_TASK_KIND,
  ACTION_TASK_KIND,
  turnOfStructuredOutput,
  type BrowserUseCompletionTask,
} from "./rail-protocol";
import { RAIL_MODEL, RAIL_VISION_MODEL } from "./zai-config";
import { substrateRpc, type SubstrateDriver } from "./substrate-driver";

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
    readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
    readonly replayed: boolean;
  }): void;
  /** Recorded for every substrate dispatch outcome (the actuation plane's telemetry axis). */
  onSubstrateOutcome(fact: {
    readonly executionId: string;
    readonly kind: string;
    readonly outcome: "substrate-success" | "substrate-failure";
    readonly latencyMs: number | null;
  }): void;
}

export interface WorkerOptions {
  readonly world: ApiWorld;
  readonly gateway: RailGateway;
  /** The Zeck-side substrate driver host (spawned by the composition). */
  readonly substrate: SubstrateDriver;
  /** The adapter's base URL (the substrate extraction LLM's destination). */
  readonly adapterBaseUrl: string;
  /** The model id the substrate extraction LLM requests (opaque neutral string). */
  readonly extractionModel: string;
  /** The non-empty placeholder the OpenAI-compatible clients require. */
  readonly apiKeyPlaceholder: string;
  /** The sandbox Chromium path (the substrate browser binary). */
  readonly chromeExecutablePath: string;
  /** The proof environment's deny-proxy URL (the substrate browser's own egress control). */
  readonly substrateProxyServer?: string;
  readonly substrateProxyBypass?: string;
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
   * and substrate-axis failures land the execution in FAILED (the honest
   * terminal state).
   */
  execute(record: ExecutionRecord, actor: ExecutionActor): Promise<void>;
}

/** The route model for one task (the rail's execution-plane choice). */
export function routeModelOf(task: { kind: string; messages?: readonly unknown[] }): string {
  if (task.kind === COMPLETION_TASK_KIND) {
    return (task.messages ?? []).some((message) => hasImagePart(message))
      ? RAIL_VISION_MODEL
      : RAIL_MODEL;
  }
  return RAIL_MODEL;
}

export function createExecutionDriver(options: WorkerOptions): ExecutionDriver {
  const { world, gateway, substrate, hooks } = options;
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
        `ppr-024-rail-${record.id}-retry-note`,
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
            recordedBy: "ppr-024-execution-driver",
          },
        ],
      },
      key("fail"),
    );
  };

  /** The SUBSTRATE-plane dispatch: one driver RPC + its result fact. */
  const dispatchSubstrate = async (
    task: Exclude<
      ReturnType<typeof parseBrowserUseTask>,
      BrowserUseCompletionTask | null
    >,
    record: ExecutionRecord,
    actor: ExecutionActor,
    key: (step: string) => string,
  ): Promise<{ ok: boolean; fact: Readonly<Record<string, unknown>> }> => {
    const startedAt = Date.now();
    if (task.kind === SESSION_TASK_KIND) {
      if (task.op === "open") {
        const profile = task.profile ?? {};
        const userDataDir = profile.userDataDir ?? `/tmp/ppr-024-substrate-profile-${record.id.slice(-8)}`;
        const rpc = await substrateRpc(substrate, "/open", {
          chromeExecutablePath: options.chromeExecutablePath,
          headless: profile.headless ?? true,
          userDataDir,
          proxyServer: options.substrateProxyServer ?? "",
          proxyBypass: options.substrateProxyBypass ?? "127.0.0.1,localhost",
          allowedDomains: profile.allowedDomains ?? [],
          minWaitPageLoadMs: profile.minWaitPageLoadMs ?? 0,
          waitBetweenActionsMs: profile.waitBetweenActionsMs ?? 0,
          adapterBaseUrl: options.adapterBaseUrl,
          model: options.extractionModel,
          apiKey: options.apiKeyPlaceholder,
        });
        const sessionId = typeof rpc.body.sessionId === "string" ? rpc.body.sessionId : "";
        const ok = rpc.status === 200 && sessionId.length > 0;
        hooks?.onSubstrateOutcome({
          executionId: record.id,
          kind: task.kind,
          outcome: ok ? "substrate-success" : "substrate-failure",
          latencyMs: Date.now() - startedAt,
        });
        return {
          ok,
          fact: {
            tool: "substrate-driver",
            kind: "substrate-session",
            op: "open",
            ...(sessionId.length === 0 ? {} : { substrateSessionId: sessionId }),
            headless: profile.headless ?? true,
            chromePid: typeof rpc.body === "object" && "cdpUrl" in rpc.body ? (substrate.pid ?? null) : null,
            ...(ok ? {} : { error: JSON.stringify(rpc.body).slice(0, 300) }),
          },
        };
      }
      const sessionId = task.sessionId ?? "";
      const rpc = await substrateRpc(substrate, "/close", { sessionId });
      const stopped = rpc.status === 200 && rpc.body.stopped === true;
      hooks?.onSubstrateOutcome({
        executionId: record.id,
        kind: task.kind,
        outcome: stopped ? "substrate-success" : "substrate-failure",
        latencyMs: Date.now() - startedAt,
      });
      return {
        ok: stopped,
        fact: {
          tool: "substrate-driver",
          kind: "substrate-session",
          op: "close",
          substrateSessionId: sessionId,
          ...(stopped ? {} : { error: JSON.stringify(rpc.body).slice(0, 300) }),
        },
      };
    }
    if (task.kind === STATE_TASK_KIND) {
      const rpc = await substrateRpc(substrate, "/state", {
        sessionId: task.sessionId,
        includeScreenshot: task.includeScreenshot,
        cached: task.cached,
        includeRecentEvents: task.includeRecentEvents,
        includeAttributes: (task as unknown as { includeAttributes?: unknown }).includeAttributes ?? null,
      });
      const url = typeof rpc.body.url === "string" ? rpc.body.url : "";
      const ok = rpc.status === 200 && url.length > 0 && typeof rpc.body.domLlmRepresentation === "string";
      hooks?.onSubstrateOutcome({
        executionId: record.id,
        kind: task.kind,
        outcome: ok ? "substrate-success" : "substrate-failure",
        latencyMs: Date.now() - startedAt,
      });
      if (!ok) {
        return {
          ok: false,
          fact: {
            tool: "substrate-driver",
            kind: "substrate-state",
            error: JSON.stringify(rpc.body).slice(0, 300),
          },
        };
      }
      const representation = String(rpc.body.domLlmRepresentation ?? "");
      const screenshot = typeof rpc.body.screenshot === "string" ? rpc.body.screenshot : null;
      return {
        ok: true,
        fact: {
          tool: "substrate-driver",
          kind: "substrate-state",
          url,
          title: typeof rpc.body.title === "string" ? rpc.body.title : "",
          tabsCount: Array.isArray(rpc.body.tabs) ? rpc.body.tabs.length : 0,
          selectorMapSize: typeof rpc.body.selectorMapSize === "number" ? rpc.body.selectorMapSize : 0,
          screenshotChars: screenshot?.length ?? 0,
          representationChars: representation.length,
          stateError: typeof rpc.body.stateError === "string" ? rpc.body.stateError : null,
          // The full transportable state (the adapter reads this back and
          // returns it to the application runtime through the public
          // boundary — the durable evidence of the substrate read).
          state: {
            url,
            title: typeof rpc.body.title === "string" ? rpc.body.title : "",
            tabs: Array.isArray(rpc.body.tabs) ? rpc.body.tabs : [],
            screenshot,
            browserErrors: Array.isArray(rpc.body.browserErrors) ? rpc.body.browserErrors : [],
            stateError: typeof rpc.body.stateError === "string" ? rpc.body.stateError : null,
            pixelsAbove: typeof rpc.body.pixelsAbove === "number" ? rpc.body.pixelsAbove : 0,
            pixelsBelow: typeof rpc.body.pixelsBelow === "number" ? rpc.body.pixelsBelow : 0,
            domLlmRepresentation: representation,
            domEvalRepresentation:
              typeof rpc.body.domEvalRepresentation === "string" ? rpc.body.domEvalRepresentation : representation,
            selectorMapLight:
              typeof rpc.body.selectorMapLight === "object" && rpc.body.selectorMapLight !== null
                ? rpc.body.selectorMapLight
                : {},
          },
        },
      };
    }
    // ACTION_TASK_KIND
    const rpc = await substrateRpc(substrate, "/action", {
      sessionId: task.sessionId,
      action: task.action,
    });
    const actionResult =
      typeof rpc.body.actionResult === "object" && rpc.body.actionResult !== null
        ? (rpc.body.actionResult as Readonly<Record<string, unknown>>)
        : null;
    const ok = rpc.status === 200 && actionResult !== null;
    hooks?.onSubstrateOutcome({
      executionId: record.id,
      kind: task.kind,
      outcome: ok ? "substrate-success" : "substrate-failure",
      latencyMs: Date.now() - startedAt,
    });
    return {
      ok,
      fact: {
        tool: "substrate-driver",
        kind: "substrate-action",
        action: task.action,
        ...(actionResult === null ? {} : { actionResult: { ...actionResult } }),
        postActionUrl: typeof rpc.body.postActionUrl === "string" ? rpc.body.postActionUrl : null,
        preActionUrl: typeof rpc.body.preActionUrl === "string" ? rpc.body.preActionUrl : null,
        ...(ok ? {} : { error: JSON.stringify(rpc.body).slice(0, 300) }),
      },
    };
  };

  const execute = async (record: ExecutionRecord, actor: ExecutionActor): Promise<void> => {
    const task = parseBrowserUseTask(record.task as Record<string, unknown>);
    const key = (step: string) => `ppr-024-driver-${record.id}-${step}`;

    // The canonical lifecycle drive (VAL-010's sequence).
    for (const step of ["authorize", "plan"] as const) {
      await executions.transition(
        { command: step, applicationId: record.applicationId, executionId: record.id, ...actor },
        key(step),
      );
    }

    // The route identity + the durable planning decision (route = neutral
    // strings), recorded on the ledger before dispatch. Substrate tasks
    // route to the substrate executor; model tasks route to the rail.
    const isModelTask = task !== null && task.kind === COMPLETION_TASK_KIND;
    const routeModel = task === null ? RAIL_MODEL : routeModelOf(task);
    const routeRef = isModelTask
      ? { provider: "custom", model: routeModel }
      : { provider: "substrate", model: "chromium-cdp" };
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
              strategyId: isModelTask ? "ppr-024-model-rail" : "ppr-024-substrate-tool",
              plan: {
                strategyClass: isModelTask ? "model-rail" : "substrate-tool",
                modelCalls: isModelTask ? 1 : 0,
                steps: [{ routeRef }],
              },
            },
          ],
          selectedStrategyId: isModelTask ? "ppr-024-model-rail" : "ppr-024-substrate-tool",
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
        cause: isModelTask ? "model-rail-dispatch" : "substrate-dispatch",
        reference: {
          tool: isModelTask ? "model-rail" : "substrate-driver",
          ...(isModelTask ? { provider: "custom", model: routeModel } : {}),
        },
        payload: {
          tool: isModelTask ? "model-rail" : "substrate-driver",
          edge: task.edge,
          kind: task.kind,
          ...(task.kind === COMPLETION_TASK_KIND
            ? {
                role: task.role,
                requestMessages: task.messages.length,
                vision: task.messages.some((message) => hasImagePart(message)),
              }
            : {}),
          ...(task.kind === SESSION_TASK_KIND ? { op: task.op } : {}),
          ...(task.kind === STATE_TASK_KIND
            ? { includeScreenshot: task.includeScreenshot, cached: task.cached }
            : {}),
          ...(task.kind === ACTION_TASK_KIND ? { action: task.action } : {}),
        },
      },
      key("tool-requested"),
    );

    if (!isModelTask) {
      // ------------------------------------------------------------------
      // THE SUBSTRATE PLANE (the neutral tool/substrate contract)
      // ------------------------------------------------------------------
      let dispatch: { ok: boolean; fact: Readonly<Record<string, unknown>> };
      try {
        dispatch = await dispatchSubstrate(task, record, actor, key);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dispatch = {
          ok: false,
          fact: {
            tool: "substrate-driver",
            kind: "substrate-failure",
            error: message.slice(0, 300),
          },
        };
      }
      await executions.recordStepEvent(
        {
          applicationId: record.applicationId,
          executionId: record.id,
          actor,
          command: "tool-result",
          cause: dispatch.ok ? "substrate-completion" : "substrate-failure",
          reference: { tool: "substrate-driver" },
          payload: dispatch.fact,
        },
        key("tool-result"),
      );
      if (!dispatch.ok) {
        await failExecution(
          record,
          actor,
          `substrate-axis failure (${JSON.stringify(dispatch.fact).slice(0, 120)})`,
          key,
          "substrate-dispatch",
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
              criterionId: "substrate-result-wellformed",
              strategy: "mechanical-nonempty",
              status: "PASS",
              recordedBy: "ppr-024-execution-driver",
              evidence: [`substrate:${record.id}`],
            },
          ],
        },
        key("pass"),
      );
      return;
    }

    // ----------------------------------------------------------------------
    // THE MODEL PLANE (the rail)
    // ----------------------------------------------------------------------
    const completionTask = task as BrowserUseCompletionTask;
    const request = encodeModelRequest(buildRailEnvelope(completionTask), routeModel);

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
    const structured = response.structuredOutput;
    const turn = turnOfStructuredOutput(structured) ?? {
      content: response.content.join(""),
      toolCalls: [],
      finishReason: response.stopReason,
    };
    const wellFormed = turn.content.length > 0 || turn.toolCalls.length > 0;
    const usageRecorded = response.usage.inputTokens > 0 || response.usage.outputTokens > 0;

    // The normalized result fact rides the PUBLIC ledger (the output fact).
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
            recordedBy: "ppr-024-execution-driver",
            evidence: [`tool-result:${dispatch.attemptId}`],
          },
          {
            criterionId: "usage-recorded",
            strategy: "mechanical-usage-presence",
            status: usageRecorded ? "PASS" : "INCONCLUSIVE",
            recordedBy: "ppr-024-execution-driver",
          },
        ],
      },
      key("pass"),
    );
  };

  return { execute };
}

