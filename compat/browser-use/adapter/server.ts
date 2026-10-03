/**
 * The PPR-024 adapter — a local TWO-SURFACE endpoint whose ONLY backend
 * is the Zeck public API (the ACR-007 Application Delegation Boundary;
 * the proven PPR-018/019/020/022/023 adapter discipline, extended to the
 * two planes this proof certifies):
 *
 *  MODEL PLANE — POST {base}/v1/chat/completions (+ bare /chat/completions)
 *   1. attributed to browseruse.agent-loop.main (edges.ts);
 *   2. becomes a REAL Zeck Execution through the REAL SDK over HTTP
 *      (idempotent create — the key is content-addressed over the full
 *      wire payload with a fresh salt only after a FAILED outcome, so
 *      identical requests that succeeded replay the durable outcome (the
 *      measured reuse axis) while a retry after a provider-axis failure
 *      is a NEW logical request);
 *   3. executed by the Zeck-side execution driver through the executions
 *      authority's own commands, dispatched through the REAL model
 *      gateway to the GLM supply rail;
 *   4. returns the normalized result fact read back from the execution's
 *      PUBLIC event ledger (the tool-result step event) — never a
 *      side-channel — rendered in the OpenAI wire format the pinned
 *      Browser Use runtime's ChatOpenAI expects (non-streaming JSON, or
 *      an honest single-shot SSE when stream=true).
 *
 *  SUBSTRATE PLANE — POST {base}/substrate/{session|state|action}
 *   The neutral tool/substrate execution contract's relay: every
 *   substrate operation the application's custom BrowserSession/Tools
 *   emit becomes a REAL Zeck execution (task kind
 *   browseruse.substrate.*) whose Zeck-side executor hosts the pinned
 *   runtime's own BrowserSession over the real Chromium; the result fact
 *   (session id / full state summary / action result + post-action url)
 *   is read back from the execution's PUBLIC event ledger and returned
 *   to the application runtime through this boundary.
 *
 * The adapter holds the Zeck transport credential (a Zeck bearer token —
 * never a provider key). Unknown request axes the pinned runtime emits
 * (reasoning_effort, response_format, stream_options, …) are tolerated
 * and carried as the task's bounded context — the adapter never rejects
 * a request shape the application sends. The adapter performs NO
 * provider selection, NO provider fallback, NO retry routing and NO
 * verification of its own (ACR-007 §3: the adapter is a translation
 * boundary, never a shadow gateway).
 */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ACTION_TASK_KIND,
  COMPLETION_TASK_KIND,
  SESSION_TASK_KIND,
  STATE_TASK_KIND,
  type OpenAiToolCall,
} from "../harness/rail-protocol";
import {
  ACTION_EDGE_ID,
  attributeEdge,
  MAIN_EDGE_ID,
  SESSION_EDGE_ID,
  STATE_EDGE_ID,
} from "./edges";
import { createZeckClient, TERMINAL_STATUSES, type ZeckClient } from "../../../sdk";
import type { ExecutionEvent } from "../../../sdk";

/** The ambient task context the corpus runner stamps per Browser Use run. */
export interface AdapterRunContext {
  readonly corpusTask: string;
  readonly runLabel: string;
}

export interface AdapterServerOptions {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly applicationId: string;
  readonly hostname?: string;
  readonly port?: number;
}

export interface AdapterServer {
  readonly port: number;
  readonly url: string;
  /** Every request served (the battery's per-edge execution log). */
  readonly requests: () => readonly AdapterRequestLog[];
  /** Stamp the ambient corpus-task context (the corpus runner's seam). */
  setRunContext(context: AdapterRunContext | null): void;
  close(): void;
}

/** One served request's durable log entry (edge + execution outcome). */
export interface AdapterRequestLog {
  readonly at: string;
  readonly surface: "chat" | "substrate-session" | "substrate-state" | "substrate-action" | "models";
  readonly edgeId: string;
  readonly model: string;
  readonly executionId: string;
  readonly replayed: boolean;
  readonly terminal: string;
  readonly contentChars: number;
  readonly toolCallCount: number;
  readonly finishReason: string;
  readonly corpusTask: string | null;
  /** The substrate operation (substrate surfaces only). */
  readonly operation: string | null;
}

interface OpenAiRequestBody {
  readonly model?: unknown;
  readonly messages?: unknown;
  readonly stream?: unknown;
  readonly temperature?: unknown;
  readonly frequency_penalty?: unknown;
  readonly top_p?: unknown;
  readonly seed?: unknown;
  readonly max_tokens?: unknown;
  readonly max_completion_tokens?: unknown;
  readonly response_format?: unknown;
  readonly reasoning_effort?: unknown;
}

/** The model-completion fact read back from the execution's ledger. */
export interface ModelCompletionFact {
  readonly content: string;
  readonly toolCalls: readonly OpenAiToolCall[];
  readonly finishReason: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** The substrate result fact read back from the execution's ledger. */
export interface SubstrateFact {
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** The payload of the LAST tool-result event of a given kind, or null. */
function lastToolResultOf(
  events: readonly ExecutionEvent[],
  kind: string,
): Readonly<Record<string, unknown>> | null {
  const results = events.filter(
    (event) =>
      event.type === "execution.tool-result" &&
      (event.payload as { readonly kind?: unknown } | undefined)?.kind === kind,
  );
  const last = results[results.length - 1];
  if (last === undefined) {
    return null;
  }
  return last.payload as Readonly<Record<string, unknown>>;
}

/** Extract the model-completion fact from the public event ledger. */
export function completionFactOf(events: readonly ExecutionEvent[]): ModelCompletionFact | null {
  const payload = lastToolResultOf(events, "model-completion");
  if (payload === null || typeof payload.content !== "string") {
    return null;
  }
  const toolCalls: OpenAiToolCall[] = Array.isArray(payload.toolCalls)
    ? payload.toolCalls.filter(
        (call): call is OpenAiToolCall =>
          typeof call === "object" &&
          call !== null &&
          typeof (call as OpenAiToolCall).id === "string",
      )
    : [];
  const usage = payload.usage as { readonly input?: unknown; readonly output?: unknown } | undefined;
  return {
    content: payload.content,
    toolCalls,
    finishReason: typeof payload.finishReason === "string" ? payload.finishReason : "stop",
    inputTokens: typeof usage?.input === "number" ? usage.input : 0,
    outputTokens: typeof usage?.output === "number" ? usage.output : 0,
  };
}

/** Extract the substrate result fact from the public event ledger. */
export function substrateFactOf(events: readonly ExecutionEvent[]): SubstrateFact | null {
  const payload = lastToolResultOf(events, "substrate-session") ??
    lastToolResultOf(events, "substrate-state") ??
    lastToolResultOf(events, "substrate-action") ??
    lastToolResultOf(events, "substrate-failure");
  if (payload === null) {
    return null;
  }
  const kind =
    typeof payload.kind === "string"
      ? payload.kind
      : "substrate-unknown";
  return { kind, payload };
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function awaitTerminal(
  client: ZeckClient,
  executionId: string,
  timeoutMs: number,
): Promise<{ readonly status: string }> {
  const startedAt = Date.now();
  for (;;) {
    const execution = await client.getExecution(executionId);
    if (TERMINAL_STATUSES.includes(execution.status)) {
      return { status: execution.status };
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`execution ${executionId} not terminal after ${timeoutMs}ms (status ${execution.status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** The adapter's served model catalog (attribution-neutral neutral strings). */
export const ADAPTER_MODEL_CATALOG = ["glm-4-plus", "glm-4.5v"] as const;

/** Create the adapter server (node:http on a loopback port). */
export async function createAdapterServer(options: AdapterServerOptions): Promise<AdapterServer> {
  const client: ZeckClient = createZeckClient({
    baseUrl: options.apiBaseUrl,
    token: options.token,
    applicationId: options.applicationId,
  });
  const logs: AdapterRequestLog[] = [];
  let runContext: AdapterRunContext | null = null;
  const keyState = new Map<string, { key: string; failed: boolean; attempts: number }>();
  const nextAttempt = (digest: string): string => {
    const state = keyState.get(digest);
    const attempts = (state?.attempts ?? 0) + 1;
    const key = `ppr-024-browser-use-${digest.slice(0, 32)}-${attempts}`;
    keyState.set(digest, { key, failed: false, attempts });
    return key;
  };
  const idempotencyKeyFor = (digest: string): string => {
    const known = keyState.get(digest);
    return known === undefined || known.failed ? nextAttempt(digest) : known.key;
  };
  const markFailed = (digest: string): void => {
    const state = keyState.get(digest);
    if (state !== undefined) {
      keyState.set(digest, { ...state, failed: true });
    }
  };

  const server: Server = createServer(
    (request: IncomingMessage, response: import("node:http").ServerResponse) => {
      void handle(request, response);
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.hostname ?? "127.0.0.1", () => resolve());
  });

  const handle = async (
    request: IncomingMessage,
    response: import("node:http").ServerResponse,
  ) => {
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      const payload = JSON.stringify(body);
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(payload);
    };
    const url = request.url ?? "";
    const method = request.method ?? "";

    // GET */models — the adapter's own catalog (the runtime's provider
    // client probes it; the certified config also pins the model ids so
    // nothing depends on it).
    if (method === "GET" && /\/models\/?$/.test(url)) {
      logs.push({
        at: new Date().toISOString(),
        surface: "models",
        edgeId: "(catalog-probe)",
        model: "",
        executionId: "",
        replayed: false,
        terminal: "N/A",
        contentChars: 0,
        toolCallCount: 0,
        finishReason: "N/A",
        corpusTask: runContext?.corpusTask ?? null,
        operation: null,
      });
      send(200, {
        object: "list",
        data: ADAPTER_MODEL_CATALOG.map((id) => ({ id, object: "model", owned_by: "zeck-adapter" })),
      });
      return;
    }

    if (method !== "POST") {
      send(404, { error: { message: "the adapter serves POST chat/substrate and GET models" } });
      return;
    }

    // ------------------------------------------------------------------
    // POST */(v1/)?chat/completions — the MODEL plane
    // ------------------------------------------------------------------
    if (/\/(v1\/)?chat\/completions\/?$/.test(url)) {
      let body: OpenAiRequestBody;
      const raw = await readBody(request);
      try {
        body = JSON.parse(raw.toString("utf8")) as OpenAiRequestBody;
      } catch {
        send(400, { error: { message: "unparseable request body" } });
        return;
      }
      const model = typeof body.model === "string" ? body.model : "";
      const rawMessages = Array.isArray(body.messages) ? body.messages : [];
      const messages = rawMessages.filter(
        (message): message is Record<string, unknown> =>
          typeof message === "object" &&
          message !== null &&
          typeof (message as { role?: unknown }).role === "string",
      );
      if (model.length === 0 || messages.length === 0) {
        send(400, { error: { message: "model and messages are required" } });
        return;
      }
      const stream = body.stream === true;
      const attribution = attributeEdge({
        messages: messages.map((message) => ({
          role: String(message.role),
          content: message.content,
        })),
        model,
      });

      const params: Record<string, unknown> = {};
      if (typeof body.temperature === "number") {
        params.temperature = body.temperature;
      }
      const maxTokens =
        typeof body.max_tokens === "number"
          ? body.max_tokens
          : typeof body.max_completion_tokens === "number"
            ? body.max_completion_tokens
            : undefined;
      if (maxTokens !== undefined) {
        params.maxTokens = maxTokens;
      }
      if (typeof body.frequency_penalty === "number") {
        params.frequencyPenalty = body.frequency_penalty;
      }
      if (typeof body.top_p === "number") {
        params.topP = body.top_p;
      }
      if (typeof body.seed === "number") {
        params.seed = body.seed;
      }
      if (body.response_format !== undefined && body.response_format !== null) {
        params.responseFormat = body.response_format;
      }
      if (typeof body.reasoning_effort === "string" && body.reasoning_effort.length > 0) {
        params.reasoningEffort = body.reasoning_effort;
      }
      if (stream) {
        params.stream = true;
      }

      const requestDigest = createHash("sha256")
        .update(JSON.stringify({ model, messages, params }))
        .digest("hex");
      const idempotencyKey = idempotencyKeyFor(requestDigest);

      let receipt;
      try {
        const created = await client.createExecution(
          {
            applicationId: options.applicationId,
            task: {
              kind: COMPLETION_TASK_KIND,
              edge: attribution.edgeId,
              role: attribution.role,
              model,
              messages,
              ...(Object.keys(params).length === 0 ? {} : { params }),
            },
            constraints: { maxCostMicroUsd: "10000", maxLatencyMs: 240_000 },
            metadata: {
              origin: "ppr-024-browser-use-adapter",
              edge: attribution.edgeId,
              attributionSignals: attribution.signals,
              browserUseModel: model,
              ...(runContext === null
                ? {}
                : { corpusTask: runContext.corpusTask, runLabel: runContext.runLabel }),
            },
          },
          idempotencyKey,
        );
        receipt = created.receipt;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        send(502, { error: { message: `Zeck execution create failed: ${message}` } });
        return;
      }

      let execution;
      try {
        execution = await awaitTerminal(client, receipt.executionId, 240_000);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        send(504, { error: { message: `Zeck execution did not reach a terminal state: ${message}` } });
        return;
      }
      if (execution.status !== "COMPLETED") {
        markFailed(requestDigest);
        logs.push({
          at: new Date().toISOString(),
          surface: "chat",
          edgeId: attribution.edgeId,
          model,
          executionId: receipt.executionId,
          replayed: receipt.replayed,
          terminal: execution.status,
          contentChars: 0,
          toolCallCount: 0,
          finishReason: "error",
          corpusTask: runContext?.corpusTask ?? null,
          operation: null,
        });
        send(500, {
          error: {
            message: `Zeck execution ${receipt.executionId} ended ${execution.status}`,
            executionId: receipt.executionId,
            status: execution.status,
          },
        });
        return;
      }

      const events = await client.listEvents(receipt.executionId);
      const fact = completionFactOf(events);
      if (fact === null) {
        send(502, { error: { message: "completed execution carried no model-completion fact" } });
        return;
      }

      logs.push({
        at: new Date().toISOString(),
        surface: "chat",
        edgeId: attribution.edgeId,
        model,
        executionId: receipt.executionId,
        replayed: receipt.replayed,
        terminal: execution.status,
        contentChars: fact.content.length,
        toolCallCount: fact.toolCalls.length,
        finishReason: fact.finishReason,
        corpusTask: runContext?.corpusTask ?? null,
        operation: null,
      });

      const completionId = `zeck-${receipt.executionId}`;
      const created = Math.floor(Date.now() / 1000);
      const finishReason = fact.toolCalls.length > 0 ? "tool_calls" : fact.finishReason;
      if (stream) {
        const chunks: string[] = [];
        const chunkOf = (delta: Record<string, unknown>, finish: string | null, usage?: unknown) =>
          `data: ${JSON.stringify({
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, finish_reason: finish, delta }],
            ...(usage === undefined ? {} : { usage }),
          })}\n\n`;
        chunks.push(chunkOf({ role: "assistant", content: "" }, null));
        if (fact.content.length > 0) {
          chunks.push(chunkOf({ content: fact.content }, null));
        }
        chunks.push(chunkOf({}, finishReason));
        chunks.push(
          `data: ${JSON.stringify({
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [],
            usage: {
              prompt_tokens: fact.inputTokens,
              completion_tokens: fact.outputTokens,
              total_tokens: fact.inputTokens + fact.outputTokens,
            },
          })}\n\n`,
        );
        chunks.push("data: [DONE]\n\n");
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        response.end(chunks.join(""));
        return;
      }
      send(200, {
        id: completionId,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: fact.content.length > 0 ? fact.content : null,
              ...(fact.toolCalls.length === 0
                ? {}
                : {
                    tool_calls: fact.toolCalls.map((call) => ({
                      id: call.id,
                      type: "function",
                      function: { name: call.function.name, arguments: call.function.arguments },
                    })),
                  }),
            },
            finish_reason: finishReason,
          },
        ],
        usage: {
          prompt_tokens: fact.inputTokens,
          completion_tokens: fact.outputTokens,
          total_tokens: fact.inputTokens + fact.outputTokens,
        },
      });
      return;
    }

    // ------------------------------------------------------------------
    // POST /substrate/session|state|action — the ACTUATION plane
    // ------------------------------------------------------------------
    const substrateMatch = /^\/substrate\/(session|state|action)\/?$/.exec(url);
    if (substrateMatch === null) {
      send(404, { error: { message: `the adapter serves no surface at ${url}` } });
      return;
    }
    const surface = substrateMatch[1] ?? "";
    const raw = await readBody(request);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    } catch {
      send(400, { error: { message: "unparseable request body" } });
      return;
    }

    let task: Record<string, unknown>;
    let edgeId: string;
    let operation: string;
    if (surface === "session") {
      const op = body.op === "close" ? "close" : "open";
      edgeId = SESSION_EDGE_ID;
      operation = op;
      task = {
        kind: SESSION_TASK_KIND,
        edge: edgeId,
        op,
        ...(typeof body.sessionId === "string" && body.sessionId.length > 0
          ? { sessionId: body.sessionId }
          : {}),
        ...(typeof body.profile === "object" && body.profile !== null
          ? { profile: body.profile }
          : {}),
      };
    } else if (surface === "state") {
      if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
        send(400, { error: { message: "sessionId is required" } });
        return;
      }
      edgeId = STATE_EDGE_ID;
      operation = "state";
      task = {
        kind: STATE_TASK_KIND,
        edge: edgeId,
        sessionId: body.sessionId,
        includeScreenshot: body.includeScreenshot === true,
        cached: body.cached === true,
        includeRecentEvents: body.includeRecentEvents === true,
        ...(Array.isArray(body.includeAttributes) ? { includeAttributes: body.includeAttributes } : {}),
      };
    } else {
      if (
        typeof body.sessionId !== "string" ||
        body.sessionId.length === 0 ||
        typeof body.action !== "object" ||
        body.action === null
      ) {
        send(400, { error: { message: "sessionId and action are required" } });
        return;
      }
      edgeId = ACTION_EDGE_ID;
      const actionKeys = Object.keys(body.action as Record<string, unknown>);
      operation = `action:${actionKeys[0] ?? "unknown"}`;
      task = {
        kind: ACTION_TASK_KIND,
        edge: edgeId,
        sessionId: body.sessionId,
        action: body.action,
      };
    }

    // SUBSTRATE-PLANE IDEMPOTENCY LAW (disclosed): substrate operations
    // observe/mutate the external browser state — every request is a NEW
    // logical request with a FRESH idempotency key (a content-addressed
    // replay would fabricate a stale observation as if it were this
    // request's execution). The model plane alone keeps the
    // content-addressed reuse axis (identical completions that succeeded
    // replay the durable outcome — the measured reuse axis, the exact
    // PPR-023 discipline).
    const requestDigest = createHash("sha256").update(raw.toString("utf8")).digest("hex");
    void requestDigest;
    const idempotencyKey = `ppr-024-substrate-${globalThis.crypto.randomUUID()}`;

    let receipt;
    try {
      const created = await client.createExecution(
        {
          applicationId: options.applicationId,
          task,
          constraints: { maxCostMicroUsd: "10000", maxLatencyMs: 240_000 },
          metadata: {
            origin: "ppr-024-browser-use-adapter",
            edge: edgeId,
            ...(runContext === null
              ? {}
              : { corpusTask: runContext.corpusTask, runLabel: runContext.runLabel }),
          },
        },
        idempotencyKey,
      );
      receipt = created.receipt;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send(502, { error: { message: `Zeck execution create failed: ${message}` } });
      return;
    }

    let execution;
    try {
      execution = await awaitTerminal(client, receipt.executionId, 240_000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send(504, { error: { message: `Zeck execution did not reach a terminal state: ${message}` } });
      return;
    }
    if (execution.status !== "COMPLETED") {
      markFailed(requestDigest);
      logs.push({
        at: new Date().toISOString(),
        surface:
          surface === "session"
            ? "substrate-session"
            : surface === "state"
              ? "substrate-state"
              : "substrate-action",
        edgeId,
        model: "",
        executionId: receipt.executionId,
        replayed: receipt.replayed,
        terminal: execution.status,
        contentChars: 0,
        toolCallCount: 0,
        finishReason: "error",
        corpusTask: runContext?.corpusTask ?? null,
        operation,
      });
      send(500, {
        error: {
          message: `Zeck execution ${receipt.executionId} ended ${execution.status}`,
          executionId: receipt.executionId,
          status: execution.status,
        },
      });
      return;
    }
    const events = await client.listEvents(receipt.executionId);
    const fact = substrateFactOf(events);
    if (fact === null) {
      send(502, { error: { message: "completed execution carried no substrate fact" } });
      return;
    }

    logs.push({
      at: new Date().toISOString(),
      surface:
        surface === "session"
          ? "substrate-session"
          : surface === "state"
            ? "substrate-state"
            : "substrate-action",
      edgeId,
      model: "",
      executionId: receipt.executionId,
      replayed: receipt.replayed,
      terminal: execution.status,
      contentChars: JSON.stringify(fact.payload).length,
      toolCallCount: 0,
      finishReason: fact.kind,
      corpusTask: runContext?.corpusTask ?? null,
      operation,
    });

    // The substrate fact's payload flows back through the public
    // boundary — the adapter renders it in the transport shape the
    // application-side substrate client expects.
    send(200, {
      executionId: receipt.executionId,
      replayed: receipt.replayed,
      kind: fact.kind,
      result: fact.payload,
    });
    return;
  };

  return {
    get port() {
      return (server.address() as AddressInfo).port;
    },
    get url() {
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    requests: () => [...logs],
    setRunContext(context) {
      runContext = context;
    },
    close() {
      server.close();
    },
  };
}

/** Re-export the edge constants the corpus runner correlates by. */
export { MAIN_EDGE_ID };
