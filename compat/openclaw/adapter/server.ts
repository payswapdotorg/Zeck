/**
 * The PPR-023 adapter — a local MULTI-SURFACE OpenAI-compatible endpoint
 * whose ONLY backend is the Zeck public API (the ACR-007 Application
 * Delegation Boundary; the proven PPR-018/019/020/022 adapter discipline,
 * extended to the four surfaces the pinned OpenClaw runtime emits).
 *
 * The unmodified pinned OpenClaw runtime points here (models.providers.zeck
 * {api: openai-completions, baseUrl: the adapter} + models.providers.openai
 * (the OpenAI-compatible override the media surfaces resolve through) +
 * tts.providers.openai.baseUrl + browser tasks' vision turns — the app's
 * own configuration surface, zero code changes). Every request:
 *
 *  1. is attributed to a declared execution-graph edge (edges.ts —
 *     content-derived for chat, path-derived for the media endpoints);
 *  2. becomes a REAL Zeck Execution through the REAL SDK over HTTP
 *     (idempotent create — the key is content-addressed over the full
 *     wire payload with a fresh salt only after a FAILED outcome, so
 *     identical requests that succeeded replay the durable outcome (the
 *     measured reuse axis) while a retry after a provider-axis failure
 *     is a NEW logical request);
 *  3. is executed by the Zeck-side rail worker (compose.ts) through the
 *     executions authority's own commands, dispatched through the REAL
 *     model gateway to the multi-surface supply rail;
 *  4. returns the normalized result fact read back from the execution's
 *     PUBLIC event ledger (the tool-result step event) — never a
 *     side-channel — rendered in the wire format the pinned OpenClaw
 *     runtime expects:
 *       - POST /v1/chat/completions  → streaming SSE chunks or the
 *         non-streaming JSON body;
 *       - POST /v1/audio/speech      → the raw audio bytes;
 *       - POST /v1/audio/transcriptions (multipart) → {text};
 *       - POST /v1/images/generations → {data:[{b64_json}]};
 *       - GET  (any path ending in /models) → the adapter's model catalog.
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
import { attributeEdge, IMAGE_EDGE_ID, STT_EDGE_ID, TTS_EDGE_ID } from "./edges";
import { createZeckClient, TERMINAL_STATUSES, type ZeckClient } from "../../../sdk";
import type { ExecutionEvent } from "../../../sdk";
import {
  COMPLETION_TASK_KIND,
  IMAGE_TASK_KIND,
  SPEECH_TASK_KIND,
  TRANSCRIPTION_TASK_KIND,
  type OpenAiToolCall,
} from "../harness/rail-protocol";

/** The ambient task context the corpus runner stamps per OpenClaw run. */
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
  readonly surface: "chat" | "speech" | "transcription" | "image" | "models";
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

interface OpenAiSpeechBody {
  readonly model?: unknown;
  readonly input?: unknown;
  readonly voice?: unknown;
  readonly speed?: unknown;
  readonly response_format?: unknown;
}

interface OpenAiImageBody {
  readonly model?: unknown;
  readonly prompt?: unknown;
  readonly size?: unknown;
  readonly n?: unknown;
  readonly quality?: unknown;
}

/** The model-completion fact read back from the execution's ledger. */
export interface ModelCompletionFact {
  readonly content: string;
  readonly toolCalls: readonly OpenAiToolCall[];
  readonly finishReason: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** The media result facts read back from the execution's ledger. */
export interface SpeechFact {
  readonly audioBase64: string;
  readonly mime: string;
  readonly format: string;
}

export interface TranscriptionFact {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ImageFact {
  readonly imageBase64: string;
  readonly mime: string;
  readonly size: string;
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

/** Extract the speech result fact from the public event ledger. */
export function speechFactOf(events: readonly ExecutionEvent[]): SpeechFact | null {
  const payload = lastToolResultOf(events, "speech-result");
  if (payload === null || typeof payload.audioBase64 !== "string") {
    return null;
  }
  return {
    audioBase64: payload.audioBase64,
    mime: typeof payload.mime === "string" ? payload.mime : "audio/wav",
    format: typeof payload.format === "string" ? payload.format : "wav",
  };
}

/** Extract the transcription result fact from the public event ledger. */
export function transcriptionFactOf(events: readonly ExecutionEvent[]): TranscriptionFact | null {
  const payload = lastToolResultOf(events, "transcription-result");
  if (payload === null || typeof payload.text !== "string") {
    return null;
  }
  const usage = payload.usage as { readonly input?: unknown; readonly output?: unknown } | undefined;
  return {
    text: payload.text,
    inputTokens: typeof usage?.input === "number" ? usage.input : 0,
    outputTokens: typeof usage?.output === "number" ? usage.output : 0,
  };
}

/** Extract the image result fact from the public event ledger. */
export function imageFactOf(events: readonly ExecutionEvent[]): ImageFact | null {
  const payload = lastToolResultOf(events, "image-result");
  if (payload === null || typeof payload.imageBase64 !== "string") {
    return null;
  }
  return {
    imageBase64: payload.imageBase64,
    mime: typeof payload.mime === "string" ? payload.mime : "image/png",
    size: typeof payload.size === "string" ? payload.size : "1024x1024",
  };
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

/** One parsed multipart/form-data part. */
interface MultipartPart {
  readonly name: string;
  readonly filename: string | null;
  readonly data: Buffer;
}

/** Parse a multipart/form-data body (the OpenAI SDK's transcription shape). */
export function parseMultipart(body: Buffer, contentType: string): readonly MultipartPart[] {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (match === null) {
    return [];
  }
  const boundary = `--${match[1] ?? match[2] ?? ""}`;
  const boundaryBuffer = Buffer.from(boundary);
  const parts: MultipartPart[] = [];
  let cursor = body.indexOf(boundaryBuffer);
  while (cursor >= 0) {
    const next = body.indexOf(boundaryBuffer, cursor + boundaryBuffer.length);
    if (next < 0) {
      break;
    }
    const segment = body.subarray(cursor + boundaryBuffer.length, next);
    // Each segment starts with \r\n, then headers, then \r\n\r\n, then data.
    const headerEnd = segment.indexOf("\r\n\r\n");
    if (headerEnd >= 0) {
      const headerText = segment.subarray(0, headerEnd).toString("utf8");
      const nameMatch = /name="([^"]*)"/i.exec(headerText);
      const fileMatch = /filename="([^"]*)"/i.exec(headerText);
      const data = segment.subarray(headerEnd + 4);
      // Strip the trailing \r\n before the boundary.
      const trimmed =
        data.length >= 2 && data[data.length - 2] === 13 && data[data.length - 1] === 10
          ? data.subarray(0, data.length - 2)
          : data;
      parts.push({
        name: nameMatch?.[1] ?? "",
        filename: fileMatch?.[1] ?? null,
        data: trimmed,
      });
    }
    cursor = next;
  }
  return parts;
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
    const key = `ppr-023-openclaw-${digest.slice(0, 32)}-${attempts}`;
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
      });
      send(200, {
        object: "list",
        data: ADAPTER_MODEL_CATALOG.map((id) => ({ id, object: "model", owned_by: "zeck-adapter" })),
      });
      return;
    }

    if (method !== "POST") {
      send(404, { error: { message: "the adapter serves POST chat/speech/transcriptions/images and GET models" } });
      return;
    }

    // ------------------------------------------------------------------
    // POST */chat/completions — the chat surface (main loop + media turns)
    // ------------------------------------------------------------------
    if (/\/chat\/completions\/?$/.test(url)) {
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
      const tools = Array.isArray(body.tools)
        ? body.tools.filter(
            (tool): tool is Record<string, unknown> => typeof tool === "object" && tool !== null,
          )
        : undefined;
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
              kind: COMPLETION_TASK_KIND,
              edge: attribution.edgeId,
              role: attribution.role,
              model,
              messages,
              ...(tools === undefined ? {} : { tools }),
              ...(Object.keys(params).length === 0 ? {} : { params }),
            },
            constraints: { maxCostMicroUsd: "10000", maxLatencyMs: 240_000 },
            metadata: {
              origin: "ppr-023-openclaw-adapter",
              edge: attribution.edgeId,
              attributionSignals: attribution.signals,
              openclawModel: model,
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
      return;
    }

    // ------------------------------------------------------------------
    // POST */audio/speech — the tts tool surface
    // ------------------------------------------------------------------
    if (/\/audio\/speech\/?$/.test(url)) {
      let body: OpenAiSpeechBody;
      const raw = await readBody(request);
      try {
        body = JSON.parse(raw.toString("utf8")) as OpenAiSpeechBody;
      } catch {
        send(400, { error: { message: "unparseable request body" } });
        return;
      }
      const model = typeof body.model === "string" ? body.model : "";
      const input = typeof body.input === "string" ? body.input : "";
      if (input.length === 0) {
        send(400, { error: { message: "input is required" } });
        return;
      }
      const edgeId = TTS_EDGE_ID;
      const requestDigest = createHash("sha256")
        .update(JSON.stringify({ kind: SPEECH_TASK_KIND, model, input, voice: body.voice ?? null, speed: body.speed ?? null, format: body.response_format ?? null }))
        .digest("hex");
      const known = keyState.get(requestDigest);
      const idempotencyKey = known === undefined || known.failed ? nextAttempt(requestDigest) : known.key;
      let receipt;
      try {
        const created = await client.createExecution(
          {
            applicationId: options.applicationId,
            task: {
              kind: SPEECH_TASK_KIND,
              edge: edgeId,
              model,
              input,
              ...(typeof body.voice === "string" ? { voice: body.voice } : {}),
              ...(typeof body.speed === "number" ? { speed: body.speed } : {}),
              ...(typeof body.response_format === "string"
                ? { responseFormat: body.response_format }
                : {}),
            },
            constraints: { maxCostMicroUsd: "10000", maxLatencyMs: 240_000 },
            metadata: {
              origin: "ppr-023-openclaw-adapter",
              edge: edgeId,
              openclawModel: model,
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
          surface: "speech",
          edgeId,
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
      const fact = speechFactOf(events);
      if (fact === null) {
        send(502, { error: { message: "completed execution carried no speech-result fact" } });
        return;
      }
      logs.push({
        at: new Date().toISOString(),
        surface: "speech",
        edgeId,
        model,
        executionId: receipt.executionId,
        replayed: receipt.replayed,
        terminal: execution.status,
        contentChars: fact.audioBase64.length,
        toolCallCount: 0,
        finishReason: "audio",
        corpusTask: runContext?.corpusTask ?? null,
      });
      const audio = Buffer.from(fact.audioBase64, "base64");
      response.writeHead(200, {
        "content-type": fact.mime,
        "content-length": String(audio.length),
      });
      response.end(audio);
      return;
    }

    // ------------------------------------------------------------------
    // POST */audio/transcriptions — the voice-memo STT surface (multipart)
    // ------------------------------------------------------------------
    if (/\/audio\/transcriptions\/?$/.test(url)) {
      const raw = await readBody(request);
      const contentType = request.headers["content-type"] ?? "";
      let fileBase64 = "";
      let filename: string | undefined;
      let model = "";
      let language: string | undefined;
      let responseFormat: string | undefined;
      if (contentType.includes("multipart/form-data")) {
        for (const part of parseMultipart(raw, contentType)) {
          if (part.filename !== null || part.name === "file") {
            fileBase64 = part.data.toString("base64");
            filename = part.filename ?? part.name;
          } else if (part.name === "model") {
            model = part.data.toString("utf8");
          } else if (part.name === "language") {
            language = part.data.toString("utf8");
          } else if (part.name === "response_format") {
            responseFormat = part.data.toString("utf8");
          }
        }
      } else {
        try {
          const parsed = JSON.parse(raw.toString("utf8")) as { file_base64?: unknown; model?: unknown };
          if (typeof parsed.file_base64 === "string") {
            fileBase64 = parsed.file_base64;
            model = typeof parsed.model === "string" ? parsed.model : "";
          }
        } catch {
          // fall through to the validation below
        }
      }
      if (fileBase64.length === 0) {
        send(400, { error: { message: "file is required" } });
        return;
      }
      const edgeId = STT_EDGE_ID;
      const requestDigest = createHash("sha256")
        .update(JSON.stringify({ kind: TRANSCRIPTION_TASK_KIND, model, fileDigest: createHash("sha256").update(fileBase64).digest("hex") }))
        .digest("hex");
      const known = keyState.get(requestDigest);
      const idempotencyKey = known === undefined || known.failed ? nextAttempt(requestDigest) : known.key;
      let receipt;
      try {
        const created = await client.createExecution(
          {
            applicationId: options.applicationId,
            task: {
              kind: TRANSCRIPTION_TASK_KIND,
              edge: edgeId,
              model,
              fileBase64,
              ...(filename === undefined ? {} : { filename }),
              ...(language === undefined ? {} : { language }),
            },
            constraints: { maxCostMicroUsd: "10000", maxLatencyMs: 240_000 },
            metadata: {
              origin: "ppr-023-openclaw-adapter",
              edge: edgeId,
              openclawModel: model,
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
          surface: "transcription",
          edgeId,
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
      const fact = transcriptionFactOf(events);
      if (fact === null) {
        send(502, { error: { message: "completed execution carried no transcription-result fact" } });
        return;
      }
      logs.push({
        at: new Date().toISOString(),
        surface: "transcription",
        edgeId,
        model,
        executionId: receipt.executionId,
        replayed: receipt.replayed,
        terminal: execution.status,
        contentChars: fact.text.length,
        toolCallCount: 0,
        finishReason: "text",
        corpusTask: runContext?.corpusTask ?? null,
      });
      // The OpenAI SDK's whisper-1 default requests response_format "text"
      // (a PLAIN-TEXT body); newer models request "json" ({text}). Serving
      // JSON to a text-format request made the runtime treat the whole JSON
      // body as the transcript — honor the requested format.
      if (responseFormat === "text" || responseFormat === "vtt" || responseFormat === "srt") {
        const raw = Buffer.from(fact.text, "utf8");
        response.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "content-length": String(raw.length),
        });
        response.end(raw);
      } else {
        send(200, { text: fact.text });
      }
      return;
    }

    // ------------------------------------------------------------------
    // POST */images/generations — the image_generate tool surface
    // ------------------------------------------------------------------
    if (/\/images\/generations\/?$/.test(url)) {
      let body: OpenAiImageBody;
      const raw = await readBody(request);
      try {
        body = JSON.parse(raw.toString("utf8")) as OpenAiImageBody;
      } catch {
        send(400, { error: { message: "unparseable request body" } });
        return;
      }
      const model = typeof body.model === "string" ? body.model : "";
      const prompt = typeof body.prompt === "string" ? body.prompt : "";
      if (prompt.length === 0) {
        send(400, { error: { message: "prompt is required" } });
        return;
      }
      const edgeId = IMAGE_EDGE_ID;
      const requestDigest = createHash("sha256")
        .update(JSON.stringify({ kind: IMAGE_TASK_KIND, model, prompt, size: body.size ?? null }))
        .digest("hex");
      const known = keyState.get(requestDigest);
      const idempotencyKey = known === undefined || known.failed ? nextAttempt(requestDigest) : known.key;
      let receipt;
      try {
        const created = await client.createExecution(
          {
            applicationId: options.applicationId,
            task: {
              kind: IMAGE_TASK_KIND,
              edge: edgeId,
              model,
              prompt,
              ...(typeof body.size === "string" ? { size: body.size } : {}),
              ...(typeof body.n === "number" ? { n: body.n } : {}),
            },
            constraints: { maxCostMicroUsd: "10000", maxLatencyMs: 240_000 },
            metadata: {
              origin: "ppr-023-openclaw-adapter",
              edge: edgeId,
              openclawModel: model,
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
          surface: "image",
          edgeId,
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
      const fact = imageFactOf(events);
      if (fact === null) {
        send(502, { error: { message: "completed execution carried no image-result fact" } });
        return;
      }
      logs.push({
        at: new Date().toISOString(),
        surface: "image",
        edgeId,
        model,
        executionId: receipt.executionId,
        replayed: receipt.replayed,
        terminal: execution.status,
        contentChars: fact.imageBase64.length,
        toolCallCount: 0,
        finishReason: "image",
        corpusTask: runContext?.corpusTask ?? null,
      });
      send(200, {
        created: Math.floor(Date.now() / 1000),
        data: [{ b64_json: fact.imageBase64 }],
      });
      return;
    }

    send(404, { error: { message: `the adapter serves no surface at ${url}` } });
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
