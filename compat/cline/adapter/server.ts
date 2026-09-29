/**
 * The PPR-019 adapter — a local OpenAI-compatible chat-completions
 * endpoint whose ONLY backend is the Zeck public API (the ACR-007
 * Application Delegation Boundary; PPR-018's proven adapter discipline,
 * extended to the axes the pinned Cline runtime emits).
 *
 * The unmodified pinned Cline CLI's `openai-compatible` provider points
 * here (provider settings: baseUrl http://127.0.0.1:<port>/v1, apiKey
 * placeholder — the adapter ignores the inbound Authorization header
 * entirely). Every request:
 *
 *  1. is attributed to a declared execution-graph edge (edges.ts —
 *     content-derived: compaction / vision / reasoning / plan / act);
 *  2. becomes a REAL Zeck Execution through the REAL SDK over HTTP
 *     (idempotent create — the key is content-addressed over the full
 *     wire payload with a fresh salt only after a FAILED outcome, so
 *     identical requests that succeeded replay the durable outcome (the
 *     measured reuse axis) while a retry after a provider-axis failure
 *     is a NEW logical request);
 *  3. is executed by the Zeck-side rail worker (compose.ts) through the
 *     executions authority's own commands, dispatched through the REAL
 *     model gateway to the supply rail;
 *  4. returns the normalized model turn read back from the execution's
 *     PUBLIC event ledger (the tool-result step event) — never a
 *     side-channel — rendered in the OpenAI wire format the pinned Cline
 *     runtime expects: streaming SSE chunks (text deltas, tool_call
 *     deltas, finish_reason, usage) or the non-streaming JSON body.
 *
 * The adapter holds the Zeck transport credential (a Zeck bearer token —
 * never a provider key).
 */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { attributeEdge } from "./edges";
import { createZeckClient, TERMINAL_STATUSES, type ZeckClient } from "../../../sdk";
import type { ExecutionEvent } from "../../../sdk";
import { CLINE_TASK_KIND, type ClineAgentTurn, type OpenAiToolCall } from "../harness/rail-protocol";

/** The ambient task context the corpus runner stamps per Cline run. */
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
  readonly edgeId: string;
  readonly model: string;
  readonly executionId: string;
  readonly replayed: boolean;
  readonly terminal: string;
  readonly contentChars: number;
  readonly toolCallCount: number;
  readonly finishReason: string;
  readonly corpusTask: string | null;
}

interface OpenAiRequestBody {
  readonly model?: unknown;
  readonly messages?: unknown;
  readonly tools?: unknown;
  readonly tool_choice?: unknown;
  readonly stream?: unknown;
  readonly temperature?: unknown;
  readonly max_tokens?: unknown;
  readonly max_completion_tokens?: unknown;
  readonly reasoning_effort?: unknown;
}

/** The model-completion fact read back from the execution's ledger. */
export interface ModelCompletionFact extends ClineAgentTurn {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Extract the model-completion fact from the public event ledger. */
export function completionFactOf(events: readonly ExecutionEvent[]): ModelCompletionFact | null {
  const results = events.filter(
    (event) =>
      event.type === "execution.tool-result" &&
      (event.payload as { readonly kind?: unknown } | undefined)?.kind === "model-completion",
  );
  const last = results[results.length - 1];
  if (last === undefined) {
    return null;
  }
  const payload = last.payload as {
    readonly content?: unknown;
    readonly toolCalls?: unknown;
    readonly finishReason?: unknown;
    readonly usage?: { readonly input?: unknown; readonly output?: unknown };
  };
  if (typeof payload.content !== "string") {
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
  return {
    content: payload.content,
    toolCalls,
    finishReason: typeof payload.finishReason === "string" ? payload.finishReason : "stop",
    inputTokens: typeof payload.usage?.input === "number" ? payload.usage.input : 0,
    outputTokens: typeof payload.usage?.output === "number" ? payload.usage.output : 0,
  };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
    });
    request.on("end", () => resolve(data));
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
    const key = `ppr-019-cline-${digest.slice(0, 32)}-${attempts}`;
    keyState.set(digest, { key, failed: false, attempts });
    return key;
  };

  const server: Server = createServer(
    (request: IncomingMessage, response: import("node:http").ServerResponse) => {
      void handle(request, response);
    },
  );

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
    if (request.method !== "POST" || !url.endsWith("/chat/completions")) {
      send(404, { error: { message: "the adapter serves only POST /v1/chat/completions" } });
      return;
    }
    let body: OpenAiRequestBody;
    try {
      body = JSON.parse(await readBody(request)) as OpenAiRequestBody;
    } catch {
      send(400, { error: { message: "unparseable request body" } });
      return;
    }
    const model = typeof body.model === "string" ? body.model : "";
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    const messages = rawMessages.filter(
      (message): message is Record<string, unknown> =>
        typeof message === "object" && message !== null && typeof (message as { role?: unknown }).role === "string",
    );
    if (model.length === 0 || messages.length === 0) {
      send(400, { error: { message: "model and messages are required" } });
      return;
    }
    const stream = body.stream === true;
    const tools = Array.isArray(body.tools)
      ? body.tools.filter(
          (tool): tool is Record<string, unknown> =>
            typeof tool === "object" && tool !== null,
        )
      : undefined;
    const attribution = attributeEdge({
      messages: messages.map((message) => ({
        role: String(message.role),
        content: message.content,
      })),
      reasoningEffort: body.reasoning_effort,
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
    if (typeof body.reasoning_effort === "string" && body.reasoning_effort.length > 0) {
      params.reasoningEffort = body.reasoning_effort;
    }
    if (stream) {
      params.stream = true;
    }

    const requestDigest = createHash("sha256")
      .update(JSON.stringify({ model, messages, tools: tools ?? null, params }))
      .digest("hex");
    const known = keyState.get(requestDigest);
    const idempotencyKey = known === undefined || known.failed ? nextAttempt(requestDigest) : known.key;

    let receipt;
    try {
      const created = await client.createExecution(
        {
          applicationId: options.applicationId,
          task: {
            kind: CLINE_TASK_KIND,
            edge: attribution.edgeId,
            role: attribution.role,
            model,
            messages,
            ...(tools === undefined ? {} : { tools }),
            ...(Object.keys(params).length === 0 ? {} : { params }),
          },
          constraints: { maxCostMicroUsd: "10000", maxLatencyMs: 240_000 },
          metadata: {
            origin: "ppr-019-cline-adapter",
            edge: attribution.edgeId,
            attributionSignals: attribution.signals,
            clineModel: model,
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
      const state = keyState.get(requestDigest);
      if (state !== undefined) {
        keyState.set(requestDigest, { ...state, failed: true });
      }
      logs.push({
        at: new Date().toISOString(),
        edgeId: attribution.edgeId,
        model,
        executionId: receipt.executionId,
        replayed: receipt.replayed,
        terminal: execution.status,
        contentChars: 0,
        toolCallCount: 0,
        finishReason: "error",
        corpusTask: runContext?.corpusTask ?? null,
      });
      send(500, {
        error: { message: `Zeck execution ${receipt.executionId} ended ${execution.status}` },
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
      edgeId: attribution.edgeId,
      model,
      executionId: receipt.executionId,
      replayed: receipt.replayed,
      terminal: execution.status,
      contentChars: fact.content.length,
      toolCallCount: fact.toolCalls.length,
      finishReason: fact.finishReason,
      corpusTask: runContext?.corpusTask ?? null,
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
      fact.toolCalls.forEach((call, index) => {
        chunks.push(
          chunkOf(
            {
              tool_calls: [
                {
                  index,
                  id: call.id,
                  type: "function",
                  function: { name: call.function.name, arguments: call.function.arguments },
                },
              ],
            },
            null,
          ),
        );
      });
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
  };

  const hostname = options.hostname ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, hostname, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    url: `http://${hostname}:${port}/v1`,
    requests: () => [...logs],
    setRunContext(context) {
      runContext = context;
    },
    close() {
      server.close();
    },
  };
}
