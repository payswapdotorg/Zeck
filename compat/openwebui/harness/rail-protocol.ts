/**
 * The PPR-025 rail protocol — the documented, validated wire protocol
 * between the Zeck-side execution worker and the multi-surface GLM
 * supply-rail adapter (the identical discipline PPR-018/019/020/022/023
 * established, composed for the surfaces the pinned Open WebUI runtime
 * emits: chat completions, speech generation, speech recognition and
 * image generation — the EMBEDDINGS surface is executed by the Zeck-side
 * DETERMINISTIC embeddings executor, never the supply: the authorized
 * supply exposes no embeddings endpoint, probed live at proof time
 * POST {base}/embeddings → HTTP 404, the identical boundary PPR-021
 * recorded for Continue).
 *
 * WHY IT EXISTS (disclosed design, not a hidden channel): the platform's
 * provider-neutral `ModelRequest` message shape (`role: system|user|
 * assistant`, string content) cannot express the request axes the pinned
 * Open WebUI runtime actually emits at its seams — multimodal content
 * parts, the OpenAI params the chat router forwards, TTS voice/speed/
 * format, image size, or the audio bytes of a transcription request. The
 * ACR-007 delegation contract carries those as the application-owned
 * bounded context of the edge (the task payload), and the rail protocol
 * is the execution-plane translation that lets the REAL model gateway
 * (identity → admission → capability → rail → durable intent →
 * credential materialization → adapter call) govern every dispatch while
 * the supply rail speaks each surface's wire format.
 *
 * The protocol has two sides:
 *
 *  1. REQUEST ENVELOPE — the execution worker wraps the task's wire
 *     payload into ONE `ModelMessage` (role "user", content
 *     `openwebui-rail/1\n{json}`). The rail adapter validates and
 *     unwraps it before building the supply request. The envelope's
 *     `kind` selects the surface:
 *       - "completion"    → chat completions (text or vision-routed)
 *       - "speech"        → speech generation (audio bytes back)
 *       - "transcription" → speech recognition (audio bytes in, text back)
 *       - "image"         → image generation (base64 image back)
 *
 *  2. RESPONSE FACTS — the rail adapter normalizes each surface's supply
 *     response into the platform's own `NormalizedStructuredOutput`
 *     concept (one named schema per kind): the provider-specific shapes
 *     are translated into neutral result facts BEFORE they re-enter
 *     platform code, exactly ACR-007 §5. The execution worker records
 *     the facts on the execution's PUBLIC event ledger; the adapter
 *     reads them back through the public API and renders the response
 *     the pinned Open WebUI runtime expects (OpenAI-shaped or
 *     Ollama-shaped, per the calling surface).
 *
 * Everything in this file is PURE (no I/O, no environment) so the tests
 * pin both sides of the translation.
 */

import type { ModelRequest } from "../../../src/modules/models/domain/request";
import type { ModelCallOutcome } from "../../../src/modules/models/domain/outcome";
import type { ProviderFailure } from "../../../src/modules/models/domain/provider-failure";
import type { NormalizedStructuredOutput } from "../../../src/modules/models/domain/response";

// ---------------------------------------------------------------------------
// The task payloads (what the adapter puts in the Zeck execution tasks)
// ---------------------------------------------------------------------------

/** The task kinds of the PPR-025 delegated executions (one per surface). */
export const COMPLETION_TASK_KIND = "openwebui.chat.completion" as const;
export const EMBEDDINGS_TASK_KIND = "openwebui.rag.embeddings" as const;
export const IMAGE_TASK_KIND = "openwebui.images.generate" as const;
export const TRANSCRIPTION_TASK_KIND = "openwebui.audio.transcribe" as const;
export const SPEECH_TASK_KIND = "openwebui.audio.speech" as const;

export type OpenWebUiTaskKind =
  | typeof COMPLETION_TASK_KIND
  | typeof EMBEDDINGS_TASK_KIND
  | typeof IMAGE_TASK_KIND
  | typeof TRANSCRIPTION_TASK_KIND
  | typeof SPEECH_TASK_KIND;

/** Every task kind the execution worker dispatches (the closed set). */
export const OPENWEBUI_TASK_KINDS: readonly OpenWebUiTaskKind[] = [
  COMPLETION_TASK_KIND,
  EMBEDDINGS_TASK_KIND,
  IMAGE_TASK_KIND,
  TRANSCRIPTION_TASK_KIND,
  SPEECH_TASK_KIND,
];

/** One normalized OpenAI-format tool call (tolerated, not expected). */
export interface OpenAiToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

/** One model turn, normalized (the neutral structured turn). */
export interface OpenWebUiTurn {
  /** The turn's text (may be empty when only tool calls were produced). */
  readonly content: string;
  /** The turn's tool calls (empty when the model produced none). */
  readonly toolCalls: readonly OpenAiToolCall[];
  /** Normalized OpenAI finish reason ("stop" | "tool_calls" | "length" | …). */
  readonly finishReason: string;
}

/**
 * The chat-completion task payload (both rails: the OpenAI-compatible
 * seam and the Ollama-native local-inference rail — the SAME execution
 * contract, the wire shape is the adapter's translation concern).
 */
export interface OpenWebUiCompletionTask {
  readonly kind: typeof COMPLETION_TASK_KIND;
  readonly edge: string;
  readonly role: "main" | "auxiliary";
  /** The rail the request arrived on (attribution signal + evidence fact). */
  readonly rail: "openai" | "ollama";
  /** The model id the Open WebUI runtime requested (opaque neutral string). */
  readonly model: string;
  /** The full OpenAI-format messages (content parts, tool_calls history). */
  readonly messages: readonly unknown[];
  /** The app's task label when the turn is an auxiliary task (title/tags/…). */
  readonly taskLabel?: string;
  readonly params?: {
    readonly temperature?: number;
    readonly maxTokens?: number;
    readonly stream?: boolean;
    readonly [key: string]: unknown;
  };
}

/** The embeddings task payload (the deterministic embeddings edge). */
export interface OpenWebUiEmbeddingsTask {
  readonly kind: typeof EMBEDDINGS_TASK_KIND;
  readonly edge: string;
  /** The input texts (one or many — batching is the app's concern). */
  readonly input: readonly string[];
  /** The model id the runtime requested (accepted; the executor is deterministic). */
  readonly model: string;
  /** The wire shape the runtime used (evidence fact). */
  readonly wire: "openai" | "ollama";
}

/** The image-generation task payload. */
export interface OpenWebUiImageTask {
  readonly kind: typeof IMAGE_TASK_KIND;
  readonly edge: string;
  readonly model: string;
  /** The image prompt. */
  readonly prompt: string;
  /** The requested size string (the app's picker surface value). */
  readonly size?: string;
  /** The requested image count (the rail serves one per execution). */
  readonly n?: number;
}

/** The speech-recognition task payload. */
export interface OpenWebUiTranscriptionTask {
  readonly kind: typeof TRANSCRIPTION_TASK_KIND;
  readonly edge: string;
  readonly model: string;
  /** The audio bytes to transcribe (base64). */
  readonly fileBase64: string;
  /** The audio filename/mime the runtime carried (opaque). */
  readonly filename?: string;
  /** The language hint, when the runtime sent one. */
  readonly language?: string;
}

/** The speech-generation task payload. */
export interface OpenWebUiSpeechTask {
  readonly kind: typeof SPEECH_TASK_KIND;
  readonly edge: string;
  readonly model: string;
  /** The text to synthesize. */
  readonly input: string;
  /** The requested voice (opaque neutral string; the supply owns voices). */
  readonly voice?: string;
  /** The requested speed multiplier. */
  readonly speed?: number;
  /** The requested audio format (wav | mp3 | pcm). */
  readonly responseFormat?: string;
}

export type OpenWebUiRailTask =
  | OpenWebUiCompletionTask
  | OpenWebUiEmbeddingsTask
  | OpenWebUiImageTask
  | OpenWebUiTranscriptionTask
  | OpenWebUiSpeechTask;

/** Parse and validate a task payload (fail closed on shape). */
export function parseOpenWebUiTask(
  task: Readonly<Record<string, unknown>>,
): OpenWebUiRailTask | null {
  if (task.kind === COMPLETION_TASK_KIND) {
    if (
      typeof task.edge !== "string" ||
      task.edge.length === 0 ||
      typeof task.model !== "string" ||
      task.model.length === 0 ||
      !Array.isArray(task.messages) ||
      task.messages.length === 0
    ) {
      return null;
    }
    const role = task.role === "auxiliary" ? "auxiliary" : "main";
    const rail = task.rail === "ollama" ? "ollama" : "openai";
    return {
      kind: COMPLETION_TASK_KIND,
      edge: task.edge,
      role,
      rail,
      model: task.model,
      messages: task.messages,
      ...(typeof task.taskLabel === "string" && task.taskLabel.length > 0
        ? { taskLabel: task.taskLabel }
        : {}),
      ...(typeof task.params === "object" && task.params !== null
        ? { params: task.params as OpenWebUiCompletionTask["params"] }
        : {}),
    };
  }
  if (task.kind === EMBEDDINGS_TASK_KIND) {
    if (
      typeof task.edge !== "string" ||
      task.edge.length === 0 ||
      !Array.isArray(task.input) ||
      task.input.length === 0 ||
      task.input.some((text) => typeof text !== "string" || text.length === 0)
    ) {
      return null;
    }
    return {
      kind: EMBEDDINGS_TASK_KIND,
      edge: task.edge,
      input: task.input as readonly string[],
      model: typeof task.model === "string" ? task.model : "",
      wire: task.wire === "ollama" ? "ollama" : "openai",
    };
  }
  if (task.kind === IMAGE_TASK_KIND) {
    if (
      typeof task.edge !== "string" ||
      task.edge.length === 0 ||
      typeof task.prompt !== "string" ||
      task.prompt.length === 0
    ) {
      return null;
    }
    return {
      kind: IMAGE_TASK_KIND,
      edge: task.edge,
      model: typeof task.model === "string" ? task.model : "",
      prompt: task.prompt,
      ...(typeof task.size === "string" ? { size: task.size } : {}),
      ...(typeof task.n === "number" ? { n: task.n } : {}),
    };
  }
  if (task.kind === TRANSCRIPTION_TASK_KIND) {
    if (
      typeof task.edge !== "string" ||
      task.edge.length === 0 ||
      typeof task.fileBase64 !== "string" ||
      task.fileBase64.length === 0
    ) {
      return null;
    }
    return {
      kind: TRANSCRIPTION_TASK_KIND,
      edge: task.edge,
      model: typeof task.model === "string" ? task.model : "",
      fileBase64: task.fileBase64,
      ...(typeof task.filename === "string" ? { filename: task.filename } : {}),
      ...(typeof task.language === "string" ? { language: task.language } : {}),
    };
  }
  if (task.kind === SPEECH_TASK_KIND) {
    if (
      typeof task.edge !== "string" ||
      task.edge.length === 0 ||
      typeof task.input !== "string" ||
      task.input.length === 0
    ) {
      return null;
    }
    return {
      kind: SPEECH_TASK_KIND,
      edge: task.edge,
      model: typeof task.model === "string" ? task.model : "",
      input: task.input,
      ...(typeof task.voice === "string" ? { voice: task.voice } : {}),
      ...(typeof task.speed === "number" ? { speed: task.speed } : {}),
      ...(typeof task.responseFormat === "string" ? { responseFormat: task.responseFormat } : {}),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// REQUEST ENVELOPE (execution worker → ModelRequest → rail adapter)
// ---------------------------------------------------------------------------

/** The envelope prefix (version-pinned; never parsed as a bare message). */
export const RAIL_ENVELOPE_PREFIX = "openwebui-rail/1\n";

/** The structured-output contract names of the normalized result facts. */
export const OPENWEBUI_TURN_NAME = "openwebui-chat-turn" as const;
export const OPENWEBUI_SPEECH_RESULT_NAME = "openwebui-speech-result" as const;
export const OPENWEBUI_TRANSCRIPTION_RESULT_NAME = "openwebui-transcription-result" as const;
export const OPENWEBUI_IMAGE_RESULT_NAME = "openwebui-image-result" as const;

/** The JSON schema of the normalized chat turn (the structuredOutput spec). */
export const OPENWEBUI_TURN_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  required: ["content", "toolCalls", "finishReason"],
  properties: {
    content: { type: "string" },
    toolCalls: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "type", "function"],
        properties: {
          id: { type: "string" },
          type: { const: "function" },
          function: {
            type: "object",
            required: ["name", "arguments"],
            properties: {
              name: { type: "string" },
              arguments: { type: "string" },
            },
          },
        },
      },
    },
    finishReason: { type: "string" },
  },
} as const;

/** The JSON schema of the normalized speech result. */
export const OPENWEBUI_SPEECH_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  required: ["audioBase64", "format"],
  properties: {
    audioBase64: { type: "string" },
    mime: { type: "string" },
    format: { type: "string" },
    audioBytes: { type: "number" },
  },
} as const;

/** The JSON schema of the normalized transcription result. */
export const OPENWEBUI_TRANSCRIPTION_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  required: ["text"],
  properties: {
    text: { type: "string" },
    inputTokens: { type: "number" },
    outputTokens: { type: "number" },
  },
} as const;

/** The JSON schema of the normalized image result. */
export const OPENWEBUI_IMAGE_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  required: ["imageBase64"],
  properties: {
    imageBase64: { type: "string" },
    mime: { type: "string" },
    size: { type: "string" },
    imageBytes: { type: "number" },
  },
} as const;

/** The envelope body the execution worker wraps and the rail adapter unwraps. */
export type RailEnvelope =
  | {
      readonly kind: "completion";
      readonly messages: readonly unknown[];
      readonly params?: OpenWebUiCompletionTask["params"];
      /** True when any message carries image content parts (vision routing). */
      readonly vision: boolean;
    }
  | {
      readonly kind: "speech";
      readonly input: string;
      readonly voice?: string;
      readonly speed?: number;
      readonly responseFormat?: string;
    }
  | {
      readonly kind: "transcription";
      readonly fileBase64: string;
      readonly filename?: string;
      readonly language?: string;
    }
  | {
      readonly kind: "image";
      readonly prompt: string;
      readonly size?: string;
      readonly n?: number;
    };

/** The rail-served task set (the embeddings task never rides the rail). */
export type RailServedTask = Exclude<OpenWebUiRailTask, OpenWebUiEmbeddingsTask>;

/** Wrap a task's wire payload into the envelope body. */
export function buildRailEnvelope(task: RailServedTask): RailEnvelope {
  if (task.kind === COMPLETION_TASK_KIND) {
    return {
      kind: "completion",
      messages: task.messages,
      ...(task.params === undefined ? {} : { params: task.params }),
      vision: task.messages.some((message) => hasImagePart(message)),
    };
  }
  if (task.kind === SPEECH_TASK_KIND) {
    return {
      kind: "speech",
      input: task.input,
      ...(task.voice === undefined ? {} : { voice: task.voice }),
      ...(task.speed === undefined ? {} : { speed: task.speed }),
      ...(task.responseFormat === undefined ? {} : { responseFormat: task.responseFormat }),
    };
  }
  if (task.kind === TRANSCRIPTION_TASK_KIND) {
    return {
      kind: "transcription",
      fileBase64: task.fileBase64,
      ...(task.filename === undefined ? {} : { filename: task.filename }),
      ...(task.language === undefined ? {} : { language: task.language }),
    };
  }
  // IMAGE_TASK_KIND (the only remaining kind — the closed set).
  return {
    kind: "image",
    prompt: task.prompt,
    ...(task.size === undefined ? {} : { size: task.size }),
    ...(task.n === undefined ? {} : { n: task.n }),
  };
}

/** Encode the envelope into a ModelRequest for the gateway. */
export function encodeModelRequest(envelope: RailEnvelope, routeModel: string): ModelRequest {
  const payload = JSON.stringify(envelope);
  return {
    model: routeModel,
    messages: [{ role: "user", content: `${RAIL_ENVELOPE_PREFIX}${payload}` }],
    structuredOutput: structuredOutputOf(envelope.kind),
  };
}

/** The structured-output contract for one envelope kind. */
export function structuredOutputOf(
  kind: RailEnvelope["kind"],
): ModelRequest["structuredOutput"] {
  switch (kind) {
    case "completion":
      return { name: OPENWEBUI_TURN_NAME, schema: OPENWEBUI_TURN_SCHEMA };
    case "speech":
      return { name: OPENWEBUI_SPEECH_RESULT_NAME, schema: OPENWEBUI_SPEECH_SCHEMA };
    case "transcription":
      return {
        name: OPENWEBUI_TRANSCRIPTION_RESULT_NAME,
        schema: OPENWEBUI_TRANSCRIPTION_SCHEMA,
      };
    case "image":
      return { name: OPENWEBUI_IMAGE_RESULT_NAME, schema: OPENWEBUI_IMAGE_SCHEMA };
  }
}

/** Decode a ModelRequest envelope (fail closed with a named error). */
export function decodeModelRequest(request: ModelRequest): RailEnvelope {
  const first = request.messages[0];
  if (
    request.messages.length !== 1 ||
    first === undefined ||
    first.role !== "user" ||
    typeof first.content !== "string" ||
    !first.content.startsWith(RAIL_ENVELOPE_PREFIX)
  ) {
    throw new Error("rail protocol violation: expected a single enveloped user message");
  }
  const parsed = JSON.parse(first.content.slice(RAIL_ENVELOPE_PREFIX.length)) as {
    readonly kind?: unknown;
    readonly messages?: unknown;
    readonly params?: unknown;
    readonly input?: unknown;
    readonly voice?: unknown;
    readonly speed?: unknown;
    readonly responseFormat?: unknown;
    readonly fileBase64?: unknown;
    readonly filename?: unknown;
    readonly language?: unknown;
    readonly prompt?: unknown;
    readonly size?: unknown;
    readonly n?: unknown;
  };
  if (parsed.kind === "completion") {
    if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) {
      throw new Error("rail protocol violation: completion envelope carries no messages");
    }
    return {
      kind: "completion",
      messages: parsed.messages,
      ...(typeof parsed.params === "object" && parsed.params !== null
        ? { params: parsed.params as OpenWebUiCompletionTask["params"] }
        : {}),
      vision: parsed.messages.some((message) => hasImagePart(message)),
    };
  }
  if (parsed.kind === "speech") {
    if (typeof parsed.input !== "string" || parsed.input.length === 0) {
      throw new Error("rail protocol violation: speech envelope carries no input text");
    }
    return {
      kind: "speech",
      input: parsed.input,
      ...(typeof parsed.voice === "string" ? { voice: parsed.voice } : {}),
      ...(typeof parsed.speed === "number" ? { speed: parsed.speed } : {}),
      ...(typeof parsed.responseFormat === "string"
        ? { responseFormat: parsed.responseFormat }
        : {}),
    };
  }
  if (parsed.kind === "transcription") {
    if (typeof parsed.fileBase64 !== "string" || parsed.fileBase64.length === 0) {
      throw new Error("rail protocol violation: transcription envelope carries no audio");
    }
    return {
      kind: "transcription",
      fileBase64: parsed.fileBase64,
      ...(typeof parsed.filename === "string" ? { filename: parsed.filename } : {}),
      ...(typeof parsed.language === "string" ? { language: parsed.language } : {}),
    };
  }
  if (parsed.kind === "image") {
    if (typeof parsed.prompt !== "string" || parsed.prompt.length === 0) {
      throw new Error("rail protocol violation: image envelope carries no prompt");
    }
    return {
      kind: "image",
      prompt: parsed.prompt,
      ...(typeof parsed.size === "string" ? { size: parsed.size } : {}),
      ...(typeof parsed.n === "number" ? { n: parsed.n } : {}),
    };
  }
  throw new Error(`rail protocol violation: unknown envelope kind ${String(parsed.kind)}`);
}

// ---------------------------------------------------------------------------
// RESPONSE FACTS (rail adapter → ModelCallOutcome → execution worker)
// ---------------------------------------------------------------------------

/** The normalized chat turn as a structured output (the platform's own concept). */
export function turnOfStructuredOutput(
  structured: NormalizedStructuredOutput | null,
): OpenWebUiTurn | null {
  if (structured === null || structured.name !== OPENWEBUI_TURN_NAME) {
    return null;
  }
  const json = structured.json as {
    readonly content?: unknown;
    readonly toolCalls?: unknown;
    readonly finishReason?: unknown;
  };
  if (typeof json.content !== "string" || typeof json.finishReason !== "string") {
    return null;
  }
  const toolCalls = Array.isArray(json.toolCalls)
    ? json.toolCalls.filter(
        (call): call is OpenAiToolCall =>
          typeof call === "object" &&
          call !== null &&
          typeof (call as OpenAiToolCall).id === "string" &&
          typeof (call as OpenAiToolCall).function?.name === "string" &&
          typeof (call as OpenAiToolCall).function?.arguments === "string",
      )
    : [];
  return { content: json.content, toolCalls, finishReason: json.finishReason };
}

/** The normalized speech result read back from a structured output. */
export function speechResultOf(
  structured: NormalizedStructuredOutput | null,
): { readonly audioBase64: string; readonly format: string; readonly mime: string } | null {
  if (structured === null || structured.name !== OPENWEBUI_SPEECH_RESULT_NAME) {
    return null;
  }
  const json = structured.json as {
    readonly audioBase64?: unknown;
    readonly format?: unknown;
    readonly mime?: unknown;
  };
  if (typeof json.audioBase64 !== "string" || json.audioBase64.length === 0) {
    return null;
  }
  return {
    audioBase64: json.audioBase64,
    format: typeof json.format === "string" ? json.format : "wav",
    mime: typeof json.mime === "string" ? json.mime : "audio/wav",
  };
}

/** The normalized transcription result read back from a structured output. */
export function transcriptionResultOf(
  structured: NormalizedStructuredOutput | null,
): { readonly text: string; readonly inputTokens: number; readonly outputTokens: number } | null {
  if (structured === null || structured.name !== OPENWEBUI_TRANSCRIPTION_RESULT_NAME) {
    return null;
  }
  const json = structured.json as {
    readonly text?: unknown;
    readonly inputTokens?: unknown;
    readonly outputTokens?: unknown;
  };
  if (typeof json.text !== "string") {
    return null;
  }
  return {
    text: json.text,
    inputTokens: typeof json.inputTokens === "number" ? json.inputTokens : 0,
    outputTokens: typeof json.outputTokens === "number" ? json.outputTokens : 0,
  };
}

/** The normalized image result read back from a structured output. */
export function imageResultOf(
  structured: NormalizedStructuredOutput | null,
): { readonly imageBase64: string; readonly mime: string; readonly size: string } | null {
  if (structured === null || structured.name !== OPENWEBUI_IMAGE_RESULT_NAME) {
    return null;
  }
  const json = structured.json as {
    readonly imageBase64?: unknown;
    readonly mime?: unknown;
    readonly size?: unknown;
  };
  if (typeof json.imageBase64 !== "string" || json.imageBase64.length === 0) {
    return null;
  }
  return {
    imageBase64: json.imageBase64,
    mime: typeof json.mime === "string" ? json.mime : "image/png",
    size: typeof json.size === "string" ? json.size : "1024x1024",
  };
}

/** The provider-success outcome class (the success builders' honest return). */
export type SuccessfulModelCallOutcome = Extract<ModelCallOutcome, { kind: "provider-success" }>;

/** Build the provider-success outcome carrying the normalized chat turn. */
export function successOutcomeOfTurn(input: {
  readonly turn: OpenWebUiTurn;
  readonly stopReason: string;
  readonly usage: { inputTokens: number; outputTokens: number; totalTokens: number | null };
  readonly providerLatencyMs: number;
}): SuccessfulModelCallOutcome {
  return {
    kind: "provider-success",
    response: {
      content: [input.turn.content],
      stopReason: normalizeStopReason(input.stopReason),
      structuredOutput: {
        name: OPENWEBUI_TURN_NAME,
        json: {
          content: input.turn.content,
          toolCalls: [...input.turn.toolCalls],
          finishReason: input.turn.finishReason,
        },
      },
      usage: { ...input.usage, costUsd: null },
      providerLatencyMs: input.providerLatencyMs,
    },
  };
}

/** Build the provider-success outcome carrying a media result fact. */
export function successOutcomeOfFact(
  name:
    | typeof OPENWEBUI_SPEECH_RESULT_NAME
    | typeof OPENWEBUI_TRANSCRIPTION_RESULT_NAME
    | typeof OPENWEBUI_IMAGE_RESULT_NAME,
  json: Readonly<Record<string, unknown>>,
  input: {
    readonly usage: { inputTokens: number; outputTokens: number };
    readonly providerLatencyMs: number;
  },
): SuccessfulModelCallOutcome {
  return {
    kind: "provider-success",
    response: {
      content: [JSON.stringify({ kind: name, ok: true })],
      stopReason: "stop",
      structuredOutput: { name, json: { ...json } },
      usage: { ...input.usage, totalTokens: null, costUsd: null },
      providerLatencyMs: input.providerLatencyMs,
    },
  };
}

/** Map the OpenAI finish reason onto the platform's stop-reason vocabulary. */
export function normalizeStopReason(reason: string): "stop" | "length" | "tool-use" | "other" {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
      return "tool-use";
    default:
      return "other";
  }
}

/** The rail's named provider failure (for malformed envelope / supply). */
export function railFailure(
  category: ProviderFailure["category"],
  message: string,
  httpStatus: number | null,
  durationMs: number,
  rail: string,
): { kind: "provider-failure"; failure: ProviderFailure } {
  return {
    kind: "provider-failure",
    failure: {
      category,
      retryable: category === "rate-limit" || category === "timeout" || category === "network",
      rail,
      providerCode: httpStatus === null ? null : String(httpStatus),
      providerMessage: message.slice(0, 300),
      httpStatus,
      durationMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Shared wire helpers
// ---------------------------------------------------------------------------

/** Does one OpenAI-format message carry image content parts? */
export function hasImagePart(message: unknown): boolean {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const content = (message as { readonly content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some(
    (part) =>
      typeof part === "object" &&
      part !== null &&
      (part as { readonly type?: unknown }).type === "image_url",
  );
}

/** Map the app's requested image size onto the supply's supported sizes. */
export function supplySizeOf(requested: string | undefined): string {
  switch (requested) {
    case "1536x1024":
    case "1792x1024":
      return "1344x768";
    case "1024x1536":
    case "1024x1792":
      return "768x1344";
    case "1344x768":
    case "768x1344":
    case "864x1152":
    case "1152x864":
    case "1440x720":
    case "720x1440":
      return requested;
    default:
      return "1024x1024";
  }
}

/**
 * Strip a deterministic markdown code fence the GLM supply's JSON bodies
 * can carry (the identical disclosed normalization PPR-020/022/023
 * applied — a wire-shape normalization, never a content edit).
 */
export function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced !== null ? (fenced[1] ?? trimmed) : trimmed;
}
