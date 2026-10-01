/**
 * The PPR-021 adapter — a local OpenAI-compatible endpoint whose ONLY
 * backend is the Zeck public API (the ACR-007 Application Delegation
 * Boundary; the proven adapter discipline the PPR-018/PPR-019/PPR-020
 * precedents established, extended to the FOUR Continue wire surfaces).
 *
 * The unmodified pinned Continue runtime points its `openai`-provider
 * models (the config.yaml role models) at this endpoint. Every request:
 *
 *  1. is attributed to a declared execution-graph edge by its
 *     (endpoint, model id) — the deterministic structural mapping in
 *     edges.ts (the model id IS the role selector of Continue's own
 *     role-based configuration);
 *  2. becomes a REAL Zeck Execution through the REAL SDK over HTTP
 *     (idempotent create — the key is content-addressed over the full
 *     wire payload with a fresh salt only after a FAILED outcome, so
 *     identical requests that succeeded replay the durable outcome (the
 *     measured reuse axis) while a retry after a provider-axis failure
 *     is a NEW logical request);
 *  3. is executed by the Zeck-side rail worker (compose.ts) through the
 *     executions authority's own commands, dispatched through the REAL
 *     model gateway to the supply rail;
 *  4. returns the normalized result read back from the execution's
 *     PUBLIC event ledger (the tool-result step event) — never a
 *     side-channel — rendered in the OpenAI wire format the pinned
 *     Continue runtime expects on that surface:
 *
 *     - POST /chat/completions: SSE chunks (text deltas, tool_call
 *       deltas, finish_reason, usage) or the non-streaming JSON body;
 *     - POST /completions (the autocomplete role's legacy endpoint):
 *       SSE text chunks / the non-streaming {choices:[{text}]} body;
 *     - POST /embeddings: the OpenAI embeddings body (a Zeck-side
 *       provider failure maps to an honest 5xx — never fake vectors);
 *     - POST /rerank: the OpenAI rerank body ({data:[{index,
 *       relevance_score}]}) built from the rail's normalized scores.
 *
 * The adapter holds the Zeck transport credential (a Zeck bearer token —
 * never a provider key). Unknown request axes the pinned runtime emits
 * are tolerated and ignored where harmless — the adapter never rejects
 * a request shape the application sends, except an unattributable
 * (surface, model) pair, which is a named honest 400.
 */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { attributeEdge, SURFACE_TASK_KINDS, type AttributionInput } from "./edges";
import { createZeckClient, TERMINAL_STATUSES, type ZeckClient } from "../../../sdk";
import type { ExecutionEvent } from "../../../sdk";
import {
  type ContinueTaskKind,
  type OpenAiToolCall,
} from "../harness/rail-protocol";

/** The ambient task context the corpus runner stamps per Continue run. */
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
  readonly surface: AttributionInput["surface"];
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
  readonly stream?: unknown;
  readonly temperature?: unknown;
  readonly max_tokens?: unknown;
  readonly max_completion_tokens?: unknown;
  readonly reasoning_effort?: unknown;
  readonly input?: unknown;
  readonly query?: unknown;
  readonly documents?: unknown;
  readonly prompt?: unknown;
  readonly suffix?: unknown;
}

/** The model-completion fact read back from the execution's ledger. */
export interface ModelCompletionFact {
  readonly kind: "model-completion";
  readonly content: string;
  readonly toolCalls: readonly OpenAiToolCall[];
  readonly finishReason: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** The rerank fact read back from the execution's ledger. */
export interface RerankScoresFact {
  readonly kind: "rerank-scores";
  readonly scores: readonly number[];
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
    kind: "model-completion",
    content: payload.content,
    toolCalls,
    finishReason: typeof payload.finishReason === "string" ? payload.finishReason : "stop",
    inputTokens: typeof payload.usage?.input === "number" ? payload.usage.input : 0,
    outputTokens: typeof payload.usage?.output === "number" ? payload.usage.output : 0,
  };
}

/** Extract the rerank-scores fact from the public event ledger. */
export function rerankFactOf(events: readonly ExecutionEvent[]): RerankScoresFact | null {
  const results = events.filter(
    (event) =>
      event.type === "execution.tool-result" &&
      (event.payload as { readonly kind?: unknown } | undefined)?.kind === "rerank-scores",
  );
  const last = results[results.length - 1];
  if (last === undefined) {
    return null;
  }
  const scores = (last.payload as { readonly scores?: unknown }).scores;
  if (
    !Array.isArray(scores) ||
    !scores.every((score): score is number => typeof score === "number")
  ) {
    return null;
  }
  return { kind: "rerank-scores", scores };
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

/** Which wire surface does a request URL name? */
function surfaceOf(url: string): AttributionInput["surface"] | null {
  if (/\/chat\/completions\/?$/.test(url)) {
    return "chat/completions";
  }
  if (/\/completions\/?$/.test(url) && !/\/chat\//.test(url) && !/\/fim\//.test(url)) {
    return "completions";
  }
  if (/\/embeddings\/?$/.test(url)) {
    return "embeddings";
  }
  if (/\/rerank\/?$/.test(url)) {
    return "rerank";
  }
  return null;
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
    const key = `ppr-021-continue-${digest.slice(0, 32)}-${attempts}`;
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
    if (request.method !== "POST") {
      send(404, { error: { message: "the adapter serves only the OpenAI-compatible POST endpoints" } });
      return;
    }
    const surface = surfaceOf(url);
    if (surface === null) {
      send(404, { error: { message: `the adapter does not serve ${url}` } });
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
    if (model.length === 0) {
      send(400, { error: { message: "model is required" } });
      return;
    }
    const attribution = attributeEdge({ surface, model });
    if (attribution === null) {
      send(400, {
        error: {
          message: `no declared execution-graph edge for surface ${surface} with model ${model} — the adapter attributes by (surface, role model id) and never guesses an edge`,
        },
      });
      return;
    }

    // ---- Per-surface payload validation + task payload construction ----
    const taskKind: ContinueTaskKind = SURFACE_TASK_KINDS[surface];
    const stream = body.stream === true;
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

    let taskPayload: Record<string, unknown>;
    let requestCore: unknown;
    if (surface === "chat/completions") {
      const rawMessages = Array.isArray(body.messages) ? body.messages : [];
      const messages = rawMessages.filter(
        (message): message is Record<string, unknown> =>
          typeof message === "object" &&
          message !== null &&
          typeof (message as { role?: unknown }).role === "string",
      );
      if (messages.length === 0) {
        send(400, { error: { message: "messages are required" } });
        return;
      }
      const tools = Array.isArray(body.tools)
        ? body.tools.filter(
            (tool): tool is Record<string, unknown> => typeof tool === "object" && tool !== null,
          )
        : undefined;
      taskPayload = {
        kind: taskKind,
        edge: attribution.edgeId,
        role: attribution.role,
        model,
        messages,
        ...(tools === undefined ? {} : { tools }),
        ...(Object.keys(params).length === 0 ? {} : { params }),
      };
      requestCore = { model, messages, tools: tools ?? null, params };
    } else if (surface === "completions") {
      const prompt = typeof body.prompt === "string" ? body.prompt : "";
      if (prompt.length === 0) {
        send(400, { error: { message: "prompt is required on the completions endpoint" } });
        return;
      }
      taskPayload = {
        kind: taskKind,
        edge: attribution.edgeId,
        role: attribution.role,
        model,
        prompt,
        ...(typeof body.suffix === "string" ? { suffix: body.suffix } : {}),
        ...(Object.keys(params).length === 0 ? {} : { params }),
      };
      requestCore = { model, prompt, suffix: body.suffix ?? null, params };
    } else if (surface === "embeddings") {
      const rawInput = Array.isArray(body.input) ? body.input : [];
      const input = rawInput.filter((item): item is string => typeof item === "string");
      if (input.length === 0) {
        send(400, { error: { message: "a non-empty string input array is required" } });
        return;
      }
      taskPayload = {
        kind: taskKind,
        edge: attribution.edgeId,
        role: attribution.role,
        model,
        input,
      };
      requestCore = { model, input };
    } else {
      // rerank
      const query = typeof body.query === "string" ? body.query : "";
      const documents = Array.isArray(body.documents)
        ? body.documents.filter((item): item is string => typeof item === "string")
        : [];
      if (query.length === 0 || documents.length === 0) {
        send(400, { error: { message: "query and documents are required" } });
        return;
      }
      taskPayload = {
        kind: taskKind,
        edge: attribution.edgeId,
        role: attribution.role,
        model,
        query,
        documents,
      };
      requestCore = { model, query, documents };
    }

    const requestDigest = createHash("sha256")
      .update(JSON.stringify({ surface, core: requestCore }))
      .digest("hex");
    const known = keyState.get(requestDigest);
    const idempotencyKey = known === undefined || known.failed ? nextAttempt(requestDigest) : known.key;

    let receipt;
    try {
      const created = await client.createExecution(
        {
          applicationId: options.applicationId,
          task: taskPayload,
          constraints: { maxCostMicroUsd: "10000", maxLatencyMs: 240_000 },
          metadata: {
            origin: "ppr-021-continue-adapter",
            edge: attribution.edgeId,
            surface,
            attributionSignals: attribution.signals,
            continueModel: model,
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
        surface,
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
        error: {
          message: `Zeck execution ${receipt.executionId} ended ${execution.status} (the honest delegated terminal state — never a fabricated response)`,
          executionId: receipt.executionId,
        },
      });
      return;
    }

    const events = await client.listEvents(receipt.executionId);
    const completion = completionFactOf(events);
    const rerank = rerankFactOf(events);
    if (completion === null && rerank === null) {
      send(502, { error: { message: "completed execution carried no model-result fact" } });
      return;
    }

    const fact =
      completion !== null
        ? { contentChars: completion.content.length, toolCallCount: completion.toolCalls.length, finishReason: completion.finishReason }
        : { contentChars: 0, toolCallCount: 0, finishReason: "stop" };
    logs.push({
      at: new Date().toISOString(),
      surface,
      edgeId: attribution.edgeId,
      model,
      executionId: receipt.executionId,
      replayed: receipt.replayed,
      terminal: execution.status,
      contentChars: fact.contentChars,
      toolCallCount: fact.toolCallCount,
      finishReason: fact.finishReason,
      corpusTask: runContext?.corpusTask ?? null,
    });

    const completionId = `zeck-${receipt.executionId}`;
    const created = Math.floor(Date.now() / 1000);

    // ---- Per-surface response rendering (the OpenAI wire formats) ----
    if (surface === "embeddings") {
      // Unreachable in this sandbox (the rail fails embeddings dispatch
      // honestly before any completion); kept for shape completeness —
      // a live embeddings completion would carry its vectors.
      const embeddingsFact = events.find(
        (event) =>
          event.type === "execution.tool-result" &&
          (event.payload as { readonly kind?: unknown } | undefined)?.kind === "embeddings-result",
      );
      const vectors = (embeddingsFact?.payload as { readonly vectors?: unknown } | undefined)
        ?.vectors;
      if (!Array.isArray(vectors)) {
        send(502, { error: { message: "completed embeddings execution carried no vectors" } });
        return;
      }
      send(200, {
        object: "list",
        data: (vectors as number[][]).map((vector, index) => ({
          object: "embedding",
          index,
          embedding: vector,
        })),
        model,
      });
      return;
    }

    if (surface === "rerank" && rerank !== null) {
      send(200, {
        object: "list",
        model,
        data: rerank.scores.map((score, index) => ({
          object: "rerank.result",
          index,
          relevance_score: score,
        })),
        usage: { total_tokens: 0 },
      });
      return;
    }

    if (surface === "completions" && completion !== null) {
      if (stream) {
        const chunks: string[] = [];
        const chunkOf = (text: string | null, finish: string | null) =>
          `data: ${JSON.stringify({
            id: completionId,
            object: "text_completion",
            created,
            model,
            choices: [{ text: text ?? "", index: 0, finish_reason: finish }],
          })}\n\n`;
        if (completion.content.length > 0) {
          chunks.push(chunkOf(completion.content, null));
        }
        chunks.push(chunkOf(null, "stop"));
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
        object: "text_completion",
        created,
        model,
        choices: [
          { text: completion.content, index: 0, finish_reason: completion.finishReason },
        ],
        usage: {
          prompt_tokens: completion.inputTokens,
          completion_tokens: completion.outputTokens,
          total_tokens: completion.inputTokens + completion.outputTokens,
        },
      });
      return;
    }

    // chat/completions
    if (completion === null) {
      send(502, { error: { message: "completed execution carried no model-completion fact" } });
      return;
    }
    const finishReason = completion.toolCalls.length > 0 ? "tool_calls" : completion.finishReason;
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
      if (completion.content.length > 0) {
        chunks.push(chunkOf({ content: completion.content }, null));
      }
      completion.toolCalls.forEach((call, index) => {
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
            prompt_tokens: completion.inputTokens,
            completion_tokens: completion.outputTokens,
            total_tokens: completion.inputTokens + completion.outputTokens,
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
            content: completion.content.length > 0 ? completion.content : null,
            ...(completion.toolCalls.length === 0
              ? {}
              : {
                  tool_calls: completion.toolCalls.map((call) => ({
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
        prompt_tokens: completion.inputTokens,
        completion_tokens: completion.outputTokens,
        total_tokens: completion.inputTokens + completion.outputTokens,
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
