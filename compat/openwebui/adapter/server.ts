/**
 * The PPR-025 adapter — a local MULTI-PROTOCOL endpoint whose ONLY
 * backend is the Zeck public API (the ACR-007 Application Delegation
 * Boundary; the proven PPR-018..024 adapter discipline, composed for the
 * two wire protocols the pinned Open WebUI runtime speaks):
 *
 *  OPENAI-COMPATIBLE SURFACE — POST {base}/v1/… (+ bare /…)
 *   1. attributed to its declared execution-graph edge (edges.ts);
 *   2. becomes a REAL Zeck Execution through the REAL SDK over HTTP
 *      (idempotent create — the key is content-addressed over the full
 *      wire payload with a fresh salt only after a FAILED outcome, so
 *      identical requests that succeeded replay the durable outcome (the
 *      measured reuse axis) while a retry after a provider-axis failure
 *      is a NEW logical request); generative media surfaces
 *      (image/asr/tts) use a FRESH key per request — a content-addressed
 *      replay would fabricate a stale generation as if it were this
 *      request's execution (the substrate idempotency law PPR-024
 *      established; embeddings are deterministic and DO keep the
 *      content-addressed reuse axis);
 *   3. executed by the Zeck-side execution driver through the executions
 *      authority's own commands, dispatched through the REAL model
 *      gateway to the GLM supply rail (chat text/vision, image, asr,
 *      tts) or the Zeck-side DETERMINISTIC embeddings executor (the
 *      recorded /embeddings 404 boundary);
 *   4. returns the normalized result fact read back from the execution's
 *      PUBLIC event ledger (the tool-result step event) — never a
 *      side-channel — rendered in the wire format the pinned Open WebUI
 *      runtime expects (OpenAI-shaped JSON or an honest single-shot SSE
 *      when stream=true).
 *
 *  OLLAMA-NATIVE SURFACE — THE LOCAL-INFERENCE RAIL (the work order's
 *  binding law: customer/local inference is a Zeck EXECUTION RAIL when
 *  delegated, never an automatic bypass category):
 *   - GET  {base}/api/tags — the local-rail model catalog (a
 *     deterministic inventory read, no execution);
 *   - POST {base}/api/chat — the local rail's chat surface: translated
 *     to the SAME Zeck execution contract as the OpenAI-shaped chat
 *     seam (identical task kind, lifecycle, evidence), rendered back in
 *     Ollama-native JSON ({message: {content}, done: true} — or an
 *     honest single-shot ndjson line when stream=true);
 *   - POST {base}/api/embed — the local rail's embedding surface (the
 *     Ollama wire shape over the same delegated embeddings edge).
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
  COMPLETION_TASK_KIND,
  EMBEDDINGS_TASK_KIND,
  IMAGE_TASK_KIND,
  SPEECH_TASK_KIND,
  TRANSCRIPTION_TASK_KIND,
  type OpenAiToolCall,
} from "../harness/rail-protocol";
import {
  OPENWEBUI_IMAGE_RESULT_NAME,
  OPENWEBUI_SPEECH_RESULT_NAME,
  OPENWEBUI_TRANSCRIPTION_RESULT_NAME,
} from "../harness/rail-protocol";
import {
  attributeEdge,
  EMBEDDINGS_EDGE_ID,
  IMAGE_EDGE_ID,
  LOCAL_RAIL_EDGE_ID,
  STT_EDGE_ID,
  TTS_EDGE_ID,
} from "./edges";
import { createZeckClient, TERMINAL_STATUSES, type ZeckClient } from "../../../sdk";
import type { ExecutionEvent } from "../../../sdk";
import { ADAPTER_MODEL_CATALOG, LOCAL_RAIL_MODEL } from "../harness/zai-config";

/** The ambient task context the corpus runner stamps per Open WebUI run. */
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
  readonly surface:
    | "chat"
    | "local-chat"
    | "embeddings"
    | "local-embeddings"
    | "image"
    | "transcriptions"
    | "speech"
    | "models"
    | "tags";
  readonly edgeId: string;
  readonly model: string;
  readonly executionId: string;
  readonly replayed: boolean;
  readonly terminal: string;
  readonly contentChars: number;
  readonly finishReason: string;
  readonly corpusTask: string | null;
}

interface OpenAiRequestBody {
  readonly model?: unknown;
  readonly messages?: unknown;
  readonly stream?: unknown;
  readonly temperature?: unknown;
  readonly top_p?: unknown;
  readonly max_tokens?: unknown;
  readonly max_completion_tokens?: unknown;
  readonly n?: unknown;
  readonly size?: unknown;
  readonly response_format?: unknown;
  readonly input?: unknown;
  readonly voice?: unknown;
  readonly speed?: unknown;
}

/** The model-completion fact read back from the execution's ledger. */
export interface ModelCompletionFact {
  readonly content: string;
  readonly toolCalls: readonly OpenAiToolCall[];
  readonly finishReason: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
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

/** Extract the embeddings fact from the public event ledger. */
export function embeddingsFactOf(
  events: readonly ExecutionEvent[],
): { readonly embeddings: readonly (readonly number[])[]; readonly dimensions: number } | null {
  const payload = lastToolResultOf(events, "embeddings-result");
  if (payload === null || !Array.isArray(payload.embeddings)) {
    return null;
  }
  const vectors: (readonly number[])[] = [];
  for (const vector of payload.embeddings) {
    if (
      Array.isArray(vector) &&
      vector.every((value) => typeof value === "number" && Number.isFinite(value))
    ) {
      vectors.push(vector as readonly number[]);
    }
  }
  if (vectors.length === 0) {
    return null;
  }
  return {
    embeddings: vectors,
    dimensions: typeof payload.dimensions === "number" ? payload.dimensions : vectors[0]?.length ?? 0,
  };
}

/** Extract a media fact (image / transcript / audio) from the ledger. */
export function mediaFactOf(
  events: readonly ExecutionEvent[],
  name: string,
): Readonly<Record<string, unknown>> | null {
  const payload = lastToolResultOf(events, name);
  if (payload === null) {
    return null;
  }
  return payload;
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

/**
 * A minimal multipart/form-data parser for the OpenAI transcriptions
 * surface (the app sends {file, model, language?} fields — the pinned
 * runtime's multipart request format per audio.stt.openai.api_request_format).
 */
function parseMultipart(
  body: Buffer,
  contentType: string,
): { readonly fields: Record<string, string>; readonly files: { readonly name: string; readonly data: Buffer }[] } {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  const fields: Record<string, string> = {};
  const files: { name: string; data: Buffer }[] = [];
  if (boundary === undefined || boundary.length === 0) {
    return { fields, files };
  }
  const delimiter = Buffer.from(`--${boundary}`);
  let position = body.indexOf(delimiter);
  while (position !== -1) {
    const next = body.indexOf(delimiter, position + delimiter.length);
    if (next === -1) {
      break;
    }
    // part = headers \r\n\r\n content \r\n
    const part = body.subarray(position + delimiter.length + 2, next - 2);
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd !== -1) {
      const headerText = part.subarray(0, headerEnd).toString("utf8");
      const content = part.subarray(headerEnd + 4);
      const nameMatch = /name="([^"]*)"/i.exec(headerText);
      const fileMatch = /filename="([^"]*)"/i.exec(headerText);
      const name = nameMatch?.[1] ?? "";
      if (fileMatch !== null) {
        files.push({ name: fileMatch[1] ?? "file", data: content });
      } else if (name.length > 0) {
        fields[name] = content.toString("utf8");
      }
    }
    position = next;
  }
  return { fields, files };
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
  // The content-addressed idempotency state (chat + embeddings — the
  // deterministic/reuse axes; generative media uses fresh keys).
  const keyState = new Map<string, { key: string; failed: boolean; attempts: number }>();
  const nextAttempt = (digest: string, prefix: string): string => {
    const state = keyState.get(digest);
    const attempts = (state?.attempts ?? 0) + 1;
    const key = `ppr-025-openwebui-${prefix}-${digest.slice(0, 32)}-${attempts}`;
    keyState.set(digest, { key, failed: false, attempts });
    return key;
  };
  const idempotencyKeyFor = (digest: string, prefix: string): string => {
    const known = keyState.get(digest);
    return known === undefined || known.failed ? nextAttempt(digest, prefix) : known.key;
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
      const payload = typeof body === "string" ? body : JSON.stringify(body);
      response.writeHead(status, {
        ...(typeof body === "string" ? {} : { "content-type": "application/json" }),
        ...headers,
      });
      response.end(payload);
    };
    const sendBuffer = (status: number, body: Buffer, headers: Record<string, string>) => {
      response.writeHead(status, headers);
      response.end(body);
    };
    const url = request.url ?? "";
    const method = request.method ?? "";

    // ------------------------------------------------------------------
    // GET */models — the adapter's own OpenAI-shaped catalog (the app's
    // openai router probes it at boot/config time; deterministic read).
    // ------------------------------------------------------------------
    if (method === "GET" && /\/(v1\/)?models\/?$/.test(url)) {
      logs.push({
        at: new Date().toISOString(),
        surface: "models",
        edgeId: "(catalog-probe)",
        model: "",
        executionId: "",
        replayed: false,
        terminal: "N/A",
        contentChars: 0,
        finishReason: "N/A",
        corpusTask: runContext?.corpusTask ?? null,
      });
      send(200, {
        object: "list",
        data: ADAPTER_MODEL_CATALOG.map((id) => ({ id, object: "model", owned_by: "zeck-adapter" })),
      });
      return;
    }

    // ------------------------------------------------------------------
    // GET /api/tags — the LOCAL-RAIL model catalog (Ollama-native shape;
    // the app's ollama router probes it — deterministic read, no execution).
    // ------------------------------------------------------------------
    if (method === "GET" && /^\/api\/tags\/?$/.test(url)) {
      logs.push({
        at: new Date().toISOString(),
        surface: "tags",
        edgeId: "(local-rail-catalog-probe)",
        model: "",
        executionId: "",
        replayed: false,
        terminal: "N/A",
        contentChars: 0,
        finishReason: "N/A",
        corpusTask: runContext?.corpusTask ?? null,
      });
      send(200, {
        models: [
          {
            name: LOCAL_RAIL_MODEL,
            model: LOCAL_RAIL_MODEL,
            modified_at: "2026-10-10T00:00:00Z",
            size: 4_700_000_000,
            digest: "sha256:ppr025localrail",
            details: {
              parent_model: "",
              format: "gguf",
              family: "zeck",
              families: ["zeck"],
              parameter_size: "8.0B",
              quantization_level: "Q4_K_M",
            },
          },
        ],
      });
      return;
    }

    if (method !== "POST") {
      send(404, { error: { message: `the adapter serves no surface at ${method} ${url}` } });
      return;
    }

    // ------------------------------------------------------------------
    // POST */(v1/)?chat/completions — the OpenAI-shaped chat seam
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
      const taskLabelSignal = attribution.signals.find((signal) =>
        signal.startsWith("auxiliary-task:"),
      );
      const taskLabel = taskLabelSignal?.slice("auxiliary-task:".length);

      const params: Record<string, unknown> = {};
      if (typeof body.temperature === "number") {
        params.temperature = body.temperature;
      }
      if (typeof body.top_p === "number") {
        params.topP = body.top_p;
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
      if (stream) {
        params.stream = true;
      }

      const requestDigest = createHash("sha256")
        .update(JSON.stringify({ model, messages, params }))
        .digest("hex");
      const idempotencyKey = idempotencyKeyFor(requestDigest, "chat");

      let receipt;
      try {
        const created = await client.createExecution(
          {
            applicationId: options.applicationId,
            task: {
              kind: COMPLETION_TASK_KIND,
              edge: attribution.edgeId,
              role: attribution.role,
              rail: "openai",
              model,
              messages,
              ...(taskLabel === undefined ? {} : { taskLabel }),
              ...(Object.keys(params).length === 0 ? {} : { params }),
            },
            constraints: { maxCostMicroUsd: "10000", maxLatencyMs: 300_000 },
            metadata: {
              origin: "ppr-025-openwebui-adapter",
              edge: attribution.edgeId,
              attributionSignals: attribution.signals,
              openWebUiModel: model,
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
        execution = await awaitTerminal(client, receipt.executionId, 300_000);
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
          finishReason: "error",
          corpusTask: runContext?.corpusTask ?? null,
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
        send(200, chunks.join(""), {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
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
    // POST /api/chat — the LOCAL-INFERENCE RAIL (Ollama-native chat)
    // ------------------------------------------------------------------
    if (/^\/api\/chat\/?$/.test(url)) {
      const raw = await readBody(request);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      } catch {
        send(400, { error: "unparseable request body" });
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
        send(400, { error: "model and messages are required" });
        return;
      }
      const stream = body.stream === true;
      const requestDigest = createHash("sha256")
        .update(JSON.stringify({ model, messages }))
        .digest("hex");
      const idempotencyKey = idempotencyKeyFor(requestDigest, "local-chat");

      let receipt;
      try {
        const created = await client.createExecution(
          {
            applicationId: options.applicationId,
            task: {
              kind: COMPLETION_TASK_KIND,
              edge: LOCAL_RAIL_EDGE_ID,
              role: "main",
              rail: "ollama",
              model,
              messages,
              ...(stream ? { params: { stream: true } } : {}),
            },
            constraints: { maxCostMicroUsd: "10000", maxLatencyMs: 300_000 },
            metadata: {
              origin: "ppr-025-openwebui-adapter",
              edge: LOCAL_RAIL_EDGE_ID,
              localRail: true,
              openWebUiModel: model,
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
        send(502, { error: `Zeck execution create failed: ${message}` });
        return;
      }
      let execution;
      try {
        execution = await awaitTerminal(client, receipt.executionId, 300_000);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        send(504, { error: `Zeck execution did not reach a terminal state: ${message}` });
        return;
      }
      if (execution.status !== "COMPLETED") {
        markFailed(requestDigest);
        logs.push({
          at: new Date().toISOString(),
          surface: "local-chat",
          edgeId: LOCAL_RAIL_EDGE_ID,
          model,
          executionId: receipt.executionId,
          replayed: receipt.replayed,
          terminal: execution.status,
          contentChars: 0,
          finishReason: "error",
          corpusTask: runContext?.corpusTask ?? null,
        });
        send(500, { error: `Zeck execution ${receipt.executionId} ended ${execution.status}` });
        return;
      }
      const events = await client.listEvents(receipt.executionId);
      const fact = completionFactOf(events);
      if (fact === null) {
        send(502, { error: "completed execution carried no model-completion fact" });
        return;
      }
      logs.push({
        at: new Date().toISOString(),
        surface: "local-chat",
        edgeId: LOCAL_RAIL_EDGE_ID,
        model,
        executionId: receipt.executionId,
        replayed: receipt.replayed,
        terminal: execution.status,
        contentChars: fact.content.length,
        finishReason: fact.finishReason,
        corpusTask: runContext?.corpusTask ?? null,
      });
      const ollamaDone = {
        model,
        created_at: new Date().toISOString(),
        message: { role: "assistant", content: fact.content },
        done: true,
        done_reason: "stop",
      };
      if (stream) {
        // An honest single-shot ndjson (one terminal line — the same
        // disclosure class the SSE path records).
        send(200, `${JSON.stringify(ollamaDone)}\n`, { "content-type": "application/x-ndjson" });
        return;
      }
      send(200, ollamaDone);
      return;
    }

    // ------------------------------------------------------------------
    // POST */(v1/)?embeddings + /api/embed — the embeddings seam (BOTH
    // wire shapes; deterministic strategy keeps content-addressed reuse)
    // ------------------------------------------------------------------
    const embeddingsMatch = /\/(v1\/)?embeddings\/?$/.exec(url);
    const localEmbedMatch = /^\/api\/embed\/?$/.exec(url);
    if (embeddingsMatch !== null || localEmbedMatch !== null) {
      const localWire = localEmbedMatch !== null;
      const raw = await readBody(request);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      } catch {
        send(400, { error: { message: "unparseable request body" } });
        return;
      }
      const model = typeof body.model === "string" ? body.model : "";
      const rawInput = body.input;
      const input: string[] =
        typeof rawInput === "string"
          ? [rawInput]
          : Array.isArray(rawInput)
            ? rawInput.filter((text): text is string => typeof text === "string" && text.length > 0)
            : [];
      if (input.length === 0) {
        send(400, { error: { message: "input is required" } });
        return;
      }
      const requestDigest = createHash("sha256")
        .update(JSON.stringify({ model, input }))
        .digest("hex");
      const idempotencyKey = idempotencyKeyFor(requestDigest, "embeddings");

      let receipt;
      try {
        const created = await client.createExecution(
          {
            applicationId: options.applicationId,
            task: {
              kind: EMBEDDINGS_TASK_KIND,
              edge: EMBEDDINGS_EDGE_ID,
              input,
              model,
              wire: localWire ? "ollama" : "openai",
            },
            constraints: { maxCostMicroUsd: "5000", maxLatencyMs: 120_000 },
            metadata: {
              origin: "ppr-025-openwebui-adapter",
              edge: EMBEDDINGS_EDGE_ID,
              inputCount: input.length,
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
        execution = await awaitTerminal(client, receipt.executionId, 120_000);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        send(504, { error: { message: `Zeck execution did not reach a terminal state: ${message}` } });
        return;
      }
      if (execution.status !== "COMPLETED") {
        markFailed(requestDigest);
        logs.push({
          at: new Date().toISOString(),
          surface: localWire ? "local-embeddings" : "embeddings",
          edgeId: EMBEDDINGS_EDGE_ID,
          model,
          executionId: receipt.executionId,
          replayed: receipt.replayed,
          terminal: execution.status,
          contentChars: 0,
          finishReason: "error",
          corpusTask: runContext?.corpusTask ?? null,
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
      const fact = embeddingsFactOf(events);
      if (fact === null) {
        send(502, { error: { message: "completed execution carried no embeddings fact" } });
        return;
      }
      logs.push({
        at: new Date().toISOString(),
        surface: localWire ? "local-embeddings" : "embeddings",
        edgeId: EMBEDDINGS_EDGE_ID,
        model,
        executionId: receipt.executionId,
        replayed: receipt.replayed,
        terminal: execution.status,
        contentChars: fact.embeddings.reduce((sum, vector) => sum + vector.length, 0),
        finishReason: "embeddings",
        corpusTask: runContext?.corpusTask ?? null,
      });
      if (localWire) {
        // Ollama-native /api/embed shape.
        send(200, {
          model,
          embeddings: fact.embeddings.map((vector) => [...vector]),
        });
        return;
      }
      // OpenAI embeddings shape.
      send(200, {
        object: "list",
        model,
        data: fact.embeddings.map((vector, index) => ({
          object: "embedding",
          index,
          embedding: [...vector],
        })),
        usage: { prompt_tokens: input.join(" ").length, total_tokens: input.join(" ").length },
      });
      return;
    }

    // ------------------------------------------------------------------
    // POST */(v1/)?images/generations — the image seam (fresh key — a
    // generative surface; the substrate idempotency law)
    // ------------------------------------------------------------------
    if (/\/(v1\/)?images\/generations\/?$/.test(url)) {
      const raw = await readBody(request);
      let body: OpenAiRequestBody;
      try {
        body = JSON.parse(raw.toString("utf8")) as OpenAiRequestBody;
      } catch {
        send(400, { error: { message: "unparseable request body" } });
        return;
      }
      const model = typeof body.model === "string" ? body.model : "";
      const prompt = typeof (body as { readonly prompt?: unknown }).prompt === "string"
        ? ((body as { readonly prompt: string }).prompt)
        : "";
      if (model.length === 0 || prompt.length === 0) {
        send(400, { error: { message: "model and prompt are required" } });
        return;
      }
      const size = typeof body.size === "string" ? body.size : undefined;
      const n = typeof body.n === "number" ? body.n : 1;
      const idempotencyKey = `ppr-025-openwebui-image-${globalThis.crypto.randomUUID()}`;
      let receipt;
      try {
        const created = await client.createExecution(
          {
            applicationId: options.applicationId,
            task: {
              kind: IMAGE_TASK_KIND,
              edge: IMAGE_EDGE_ID,
              model,
              prompt,
              ...(size === undefined ? {} : { size }),
              ...(n === undefined ? {} : { n }),
            },
            constraints: { maxCostMicroUsd: "50000", maxLatencyMs: 300_000 },
            metadata: {
              origin: "ppr-025-openwebui-adapter",
              edge: IMAGE_EDGE_ID,
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
        execution = await awaitTerminal(client, receipt.executionId, 300_000);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        send(504, { error: { message: `Zeck execution did not reach a terminal state: ${message}` } });
        return;
      }
      if (execution.status !== "COMPLETED") {
        logs.push({
          at: new Date().toISOString(),
          surface: "image",
          edgeId: IMAGE_EDGE_ID,
          model,
          executionId: receipt.executionId,
          replayed: receipt.replayed,
          terminal: execution.status,
          contentChars: 0,
          finishReason: "error",
          corpusTask: runContext?.corpusTask ?? null,
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
      const fact = mediaFactOf(events, OPENWEBUI_IMAGE_RESULT_NAME);
      const imageBase64 =
        typeof fact?.imageBase64 === "string" && fact.imageBase64.length > 0 ? fact.imageBase64 : null;
      if (fact === null || imageBase64 === null) {
        send(502, { error: { message: "completed execution carried no image fact" } });
        return;
      }
      logs.push({
        at: new Date().toISOString(),
        surface: "image",
        edgeId: IMAGE_EDGE_ID,
        model,
        executionId: receipt.executionId,
        replayed: receipt.replayed,
        terminal: execution.status,
        contentChars: imageBase64.length,
        finishReason: "image",
        corpusTask: runContext?.corpusTask ?? null,
      });
      // base64 ONLY — the runtime never receives a hosted URL to fetch
      // (the rail materialized the supply's artifact reference
      // platform-side; the disclosed normalization).
      send(200, {
        created: Math.floor(Date.now() / 1000),
        data: [{ b64_json: imageBase64, revised_prompt: prompt }],
      });
      return;
    }

    // ------------------------------------------------------------------
    // POST */(v1/)?audio/transcriptions — the STT seam (multipart or
    // JSON; fresh key — a generative surface)
    // ------------------------------------------------------------------
    if (/\/(v1\/)?audio\/transcriptions\/?$/.test(url)) {
      const contentType = request.headers["content-type"] ?? "";
      let fileBase64 = "";
      let model = "";
      let language: string | undefined;
      let filename = "audio.wav";
      if (contentType.includes("multipart/form-data")) {
        const raw = await readBody(request);
        const parts = parseMultipart(raw, contentType);
        model = parts.fields.model ?? "";
        language = parts.fields.language;
        const file = parts.files[0];
        if (file !== undefined) {
          fileBase64 = file.data.toString("base64");
          filename = file.name;
        }
      } else {
        const raw = await readBody(request);
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        } catch {
          send(400, { error: { message: "unparseable request body" } });
          return;
        }
        model = typeof body.model === "string" ? body.model : "";
        language = typeof body.language === "string" ? body.language : undefined;
        const inputAudio = body.input_audio as
          | { readonly data?: unknown; readonly format?: unknown }
          | undefined;
        if (typeof inputAudio?.data === "string") {
          fileBase64 = inputAudio.data;
          filename = `audio.${typeof inputAudio.format === "string" ? inputAudio.format : "wav"}`;
        }
      }
      if (model.length === 0 || fileBase64.length === 0) {
        send(400, { error: { message: "model and file are required" } });
        return;
      }
      const idempotencyKey = `ppr-025-openwebui-asr-${globalThis.crypto.randomUUID()}`;
      let receipt;
      try {
        const created = await client.createExecution(
          {
            applicationId: options.applicationId,
            task: {
              kind: TRANSCRIPTION_TASK_KIND,
              edge: STT_EDGE_ID,
              model,
              fileBase64,
              filename,
              ...(language === undefined ? {} : { language }),
            },
            constraints: { maxCostMicroUsd: "10000", maxLatencyMs: 240_000 },
            metadata: {
              origin: "ppr-025-openwebui-adapter",
              edge: STT_EDGE_ID,
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
        logs.push({
          at: new Date().toISOString(),
          surface: "transcriptions",
          edgeId: STT_EDGE_ID,
          model,
          executionId: receipt.executionId,
          replayed: receipt.replayed,
          terminal: execution.status,
          contentChars: 0,
          finishReason: "error",
          corpusTask: runContext?.corpusTask ?? null,
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
      const fact = mediaFactOf(events, OPENWEBUI_TRANSCRIPTION_RESULT_NAME);
      const text = typeof fact?.text === "string" ? fact.text : null;
      if (fact === null || text === null) {
        send(502, { error: { message: "completed execution carried no transcript fact" } });
        return;
      }
      logs.push({
        at: new Date().toISOString(),
        surface: "transcriptions",
        edgeId: STT_EDGE_ID,
        model,
        executionId: receipt.executionId,
        replayed: receipt.replayed,
        terminal: execution.status,
        contentChars: text.length,
        finishReason: "transcript",
        corpusTask: runContext?.corpusTask ?? null,
      });
      send(200, { text });
      return;
    }

    // ------------------------------------------------------------------
    // POST */(v1/)?audio/speech — the TTS seam (fresh key — a generative
    // surface; audio bytes back)
    // ------------------------------------------------------------------
    if (/\/(v1\/)?audio\/speech\/?$/.test(url)) {
      const raw = await readBody(request);
      let body: OpenAiRequestBody;
      try {
        body = JSON.parse(raw.toString("utf8")) as OpenAiRequestBody;
      } catch {
        send(400, { error: { message: "unparseable request body" } });
        return;
      }
      const model = typeof body.model === "string" ? body.model : "";
      const input = typeof body.input === "string" ? body.input : "";
      if (model.length === 0 || input.length === 0) {
        send(400, { error: { message: "model and input are required" } });
        return;
      }
      const voice = typeof body.voice === "string" ? body.voice : undefined;
      const speed = typeof body.speed === "number" ? body.speed : undefined;
      const responseFormat =
        typeof (body as { readonly response_format?: unknown }).response_format === "string"
          ? ((body as { readonly response_format: string }).response_format)
          : undefined;
      const idempotencyKey = `ppr-025-openwebui-tts-${globalThis.crypto.randomUUID()}`;
      let receipt;
      try {
        const created = await client.createExecution(
          {
            applicationId: options.applicationId,
            task: {
              kind: SPEECH_TASK_KIND,
              edge: TTS_EDGE_ID,
              model,
              input,
              ...(voice === undefined ? {} : { voice }),
              ...(speed === undefined ? {} : { speed }),
              ...(responseFormat === undefined ? {} : { responseFormat }),
            },
            constraints: { maxCostMicroUsd: "10000", maxLatencyMs: 240_000 },
            metadata: {
              origin: "ppr-025-openwebui-adapter",
              edge: TTS_EDGE_ID,
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
        logs.push({
          at: new Date().toISOString(),
          surface: "speech",
          edgeId: TTS_EDGE_ID,
          model,
          executionId: receipt.executionId,
          replayed: receipt.replayed,
          terminal: execution.status,
          contentChars: 0,
          finishReason: "error",
          corpusTask: runContext?.corpusTask ?? null,
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
      const fact = mediaFactOf(events, OPENWEBUI_SPEECH_RESULT_NAME);
      const audioBase64 =
        typeof fact?.audioBase64 === "string" && fact.audioBase64.length > 0 ? fact.audioBase64 : null;
      if (fact === null || audioBase64 === null) {
        send(502, { error: { message: "completed execution carried no audio fact" } });
        return;
      }
      logs.push({
        at: new Date().toISOString(),
        surface: "speech",
        edgeId: TTS_EDGE_ID,
        model,
        executionId: receipt.executionId,
        replayed: receipt.replayed,
        terminal: execution.status,
        contentChars: audioBase64.length,
        finishReason: "audio",
        corpusTask: runContext?.corpusTask ?? null,
      });
      const mime = typeof fact.mime === "string" ? fact.mime : "audio/wav";
      sendBuffer(200, Buffer.from(audioBase64, "base64"), { "content-type": mime });
      return;
    }

    send(404, { error: { message: `the adapter serves no surface at ${url}` } });
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
export { MAIN_EDGE_ID } from "./edges";
