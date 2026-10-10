/**
 * The multi-surface GLM supply-rail adapter for PPR-026 (AnythingLLM) — a
 * `custom`-rail `ModelProvider` over the sandbox's authorized GLM
 * endpoint, following the platform's own adapter discipline (the
 * identical composition PPR-018/019/020/022/023/025 established): "No
 * SDK: the rail speaks OpenAI-compatible JSON over HTTP, driven through
 * the neutral `HttpTransport` port; provider specifics live ONLY in this
 * file."
 *
 * WHAT THIS RAIL TRANSLATES (the AnythingLLM delegated axes):
 *  - "completion"    → {base}/chat/completions (text) or
 *                      {base}/chat/completions/vision (image parts — the
 *                      same vision surface PPR-024 exercised; the pinned
 *                      runtime's `attachmentToContentBlock` emits
 *                      image_url content parts for image attachments).
 *                      The request's temperature / max_tokens axes are
 *                      carried to the supply verbatim (the app-owned
 *                      bounded context of the edge, ACR-007 §1); the
 *                      response's tool_calls are normalized into the
 *                      structured turn (tolerated, not expected).
 *  - "speech"        → {base}/audio/tts {input, voice, speed,
 *                      response_format} → audio bytes (live-verified
 *                      voice "tongtong", format "wav").
 *  - "transcription" → {base}/audio/asr {file_base64} → {text, usage} →
 *                      the normalized transcript fact (live
 *                      round-trip-verified against the committed corpus
 *                      asset at proof time).
 *
 * NOT SERVED BY THE SUPPLY (the recorded boundary): embeddings —
 * POST {base}/embeddings → HTTP 404 probed live at proof time (the
 * identical boundary PPR-021/025 recorded). The embeddings edge is
 * executed by the Zeck-side DETERMINISTIC embeddings executor
 * (embeddings.ts), never this rail.
 *
 * Image generation (AnythingLLM's agent-skill image generator) is a
 * DORMANT SEAM of this proof — disclosed in the execution graph — so no
 * image surface rides this rail either.
 *
 * RESPONSE NORMALIZATION: every supply-specific shape becomes a neutral
 * structured fact BEFORE re-entering platform code (ACR-007 §5) —
 * including the deterministic markdown-fence strip the GLM supply's JSON
 * bodies can require (stripJsonFence, disclosed in the rail protocol).
 *
 * SECRETS-LAST: the credential material is materialized by the gateway
 * into `ProviderDispatchContext.credential` immediately before this
 * adapter call — this adapter holds no credential of its own.
 *
 * Fault injection: the battery's failure-path validation composes this
 * adapter over a failing `HttpTransport` — an honest, disclosed
 * fault-injection at the transport boundary (never counted as a live
 * success).
 */

import type { ModelCallOutcome } from "../../../src/modules/models/domain/outcome";
import type { ModelProvider, ProviderDispatchContext } from "../../../src/modules/models/ports/model-provider";
import type { ModelRequest } from "../../../src/modules/models/domain/request";
import { collectBodyText, type HttpTransport } from "../../../src/modules/models/ports/http-transport";
import {
  decodeModelRequest,
  railFailure,
  stripJsonFence,
  successOutcomeOfFact,
  successOutcomeOfTurn,
  type OpenAiToolCall,
} from "./rail-protocol";
import {
  ANYTHINGLLM_SPEECH_RESULT_NAME,
  ANYTHINGLLM_TRANSCRIPTION_RESULT_NAME,
} from "./rail-protocol";
import {
  RAIL_MODEL,
  RAIL_PROVIDER,
  RAIL_SPEECH_MODEL,
  RAIL_TRANSCRIPTION_MODEL,
  RAIL_VISION_MODEL,
} from "./zai-config";

const STATUS_CATEGORIES: Readonly<
  Record<number, "invalid-request" | "authentication" | "quota" | "authorization" | "timeout" | "rate-limit">
> = {
  400: "invalid-request",
  401: "authentication",
  402: "quota",
  403: "authorization",
  404: "invalid-request",
  408: "timeout",
  413: "invalid-request",
  422: "invalid-request",
  429: "rate-limit",
};

function categoryForStatus(
  status: number,
):
  | "invalid-request"
  | "authentication"
  | "quota"
  | "authorization"
  | "timeout"
  | "rate-limit"
  | "provider-unavailable"
  | "unknown" {
  if (status in STATUS_CATEGORIES) {
    return STATUS_CATEGORIES[status] ?? "unknown";
  }
  if (status >= 500) {
    return "provider-unavailable";
  }
  return "unknown";
}

/** The supply endpoint's OpenAI-compatible chat response shape. */
interface SupplyChatResponse {
  readonly choices?: readonly {
    readonly message?: {
      readonly content?: unknown;
      readonly tool_calls?: readonly {
        readonly id?: unknown;
        readonly type?: unknown;
        readonly function?: { readonly name?: unknown; readonly arguments?: unknown };
      }[];
    };
    readonly finish_reason?: unknown;
  }[];
  readonly usage?: {
    readonly prompt_tokens?: unknown;
    readonly completion_tokens?: unknown;
    readonly total_tokens?: unknown;
  };
}

/** The supply endpoint's ASR response shape (live-verified). */
interface SupplyAsrResponse {
  readonly text?: unknown;
  readonly usage?: {
    readonly prompt_tokens?: unknown;
    readonly completion_tokens?: unknown;
  };
}

export interface ZaiRailOptions {
  /** The supply endpoint base URL (from the platform-side supply config). */
  readonly baseUrl: string;
  /** The HTTP transport (injectable — the fault-injection seam of the battery). */
  readonly transport: HttpTransport;
}

/** Normalize the supply response's tool calls (absent → empty). */
function toolCallsOf(
  message: NonNullable<SupplyChatResponse["choices"]>[number]["message"],
): readonly OpenAiToolCall[] {
  const raw = message?.tool_calls;
  if (!Array.isArray(raw)) {
    return [];
  }
  const calls: OpenAiToolCall[] = [];
  for (const call of raw) {
    if (
      typeof call === "object" &&
      call !== null &&
      typeof call.id === "string" &&
      typeof call.function?.name === "string"
    ) {
      calls.push({
        id: call.id,
        type: "function",
        function: {
          name: call.function.name,
          arguments: typeof call.function.arguments === "string" ? call.function.arguments : "{}",
        },
      });
    }
  }
  return calls;
}

/** Create the multi-surface GLM supply rail adapter (rail slug `custom`). */
export function createZaiRailAdapter(options: ZaiRailOptions): ModelProvider {
  const { baseUrl, transport } = options;
  const base = baseUrl.replace(/\/+$/, "");
  const textEndpoint = `${base}/chat/completions`;
  const visionEndpoint = `${base}/chat/completions/vision`;
  const ttsEndpoint = `${base}/audio/tts`;
  const asrEndpoint = `${base}/audio/asr`;

  const dispatch = async (
    request: ModelRequest,
    context: ProviderDispatchContext,
  ): Promise<ModelCallOutcome> => {
    const startedAt = Date.now();
    // SECRETS-LAST: the credential was materialized by the gateway into
    // the dispatch context; it exists only inside this invocation scope.
    let authHeaders: Record<string, string> = {};
    if (context.credential !== null && context.credential.length > 0) {
      try {
        const parsed = JSON.parse(context.credential) as Record<string, unknown>;
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "string") {
            authHeaders[key.toLowerCase()] = value;
          }
        }
      } catch {
        return railFailure("authentication", "malformed rail credential material", null, 0, RAIL_PROVIDER);
      }
    }

    // Rail protocol: unwrap the enveloped wire payload (fail closed).
    let envelope;
    try {
      envelope = decodeModelRequest(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return railFailure("invalid-request", `rail protocol: ${message}`, null, Date.now() - startedAt, RAIL_PROVIDER);
    }

    if (envelope.kind === "completion") {
      const body: Record<string, unknown> = {
        model: envelope.vision ? RAIL_VISION_MODEL : RAIL_MODEL,
        messages: envelope.messages,
        thinking: { type: "disabled" },
      };
      if (envelope.params?.maxTokens !== undefined) {
        body.max_tokens = envelope.params.maxTokens;
      }
      if (envelope.params?.temperature !== undefined) {
        body.temperature = envelope.params.temperature;
      }
      const endpoint = envelope.vision ? visionEndpoint : textEndpoint;
      let response: { readonly status: number; readonly text: string };
      try {
        const raw = await transport.send({
          method: "POST",
          url: context.endpointUrl ?? endpoint,
          headers: { ...authHeaders },
          bodyJson: body,
          timeoutMs: context.timeoutMs,
        });
        response = { status: raw.status, text: await collectBodyText(raw.body) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const category = /timeout|timed[ -]?out|abort/i.test(message) ? "timeout" : "network";
        return railFailure(category, message, null, Date.now() - startedAt, RAIL_PROVIDER);
      }
      const durationMs = Date.now() - startedAt;
      if (response.status < 200 || response.status >= 300) {
        return railFailure(
          categoryForStatus(response.status),
          `supply endpoint returned HTTP ${response.status}: ${stripJsonFence(response.text).slice(0, 200)}`,
          response.status,
          durationMs,
          RAIL_PROVIDER,
        );
      }
      let parsed: SupplyChatResponse;
      try {
        parsed = JSON.parse(stripJsonFence(response.text)) as SupplyChatResponse;
      } catch {
        return railFailure("malformed-response", "non-JSON response body", response.status, durationMs, RAIL_PROVIDER);
      }
      const first = parsed.choices?.[0];
      if (first === undefined || first.message === undefined) {
        return railFailure(
          "malformed-response",
          "response carried no message choice",
          response.status,
          durationMs,
          RAIL_PROVIDER,
        );
      }
      const content = typeof first.message.content === "string" ? first.message.content : "";
      const toolCalls = toolCallsOf(first.message);
      const finishReason = typeof first.finish_reason === "string" ? first.finish_reason : "stop";
      const usage = parsed.usage;
      const inputTokens = typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : 0;
      const outputTokens = typeof usage?.completion_tokens === "number" ? usage.completion_tokens : 0;
      const totalTokens = typeof usage?.total_tokens === "number" ? usage.total_tokens : null;
      if (content.length === 0 && toolCalls.length === 0) {
        return railFailure(
          "malformed-response",
          "response carried neither content nor tool calls",
          response.status,
          durationMs,
          RAIL_PROVIDER,
        );
      }
      return successOutcomeOfTurn({
        turn: { content, toolCalls, finishReason },
        stopReason: finishReason,
        usage: { inputTokens, outputTokens, totalTokens },
        providerLatencyMs: durationMs,
      });
    }

    if (envelope.kind === "speech") {
      const body: Record<string, unknown> = {
        model: RAIL_SPEECH_MODEL,
        input: envelope.input,
        voice: envelope.voice ?? "tongtong",
        response_format: envelope.responseFormat ?? "wav",
      };
      if (envelope.speed !== undefined) {
        body.speed = envelope.speed;
      }
      let raw;
      try {
        raw = await transport.send({
          method: "POST",
          url: context.endpointUrl ?? ttsEndpoint,
          headers: { ...authHeaders },
          bodyJson: body,
          timeoutMs: context.timeoutMs,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const category = /timeout|timed[ -]?out|abort/i.test(message) ? "timeout" : "network";
        return railFailure(category, message, null, Date.now() - startedAt, RAIL_PROVIDER);
      }
      const durationMs = Date.now() - startedAt;
      const chunks: Buffer[] = [];
      for await (const chunk of raw.body) {
        chunks.push(Buffer.from(chunk));
      }
      const audio = Buffer.concat(chunks);
      if (raw.status < 200 || raw.status >= 300) {
        return railFailure(
          categoryForStatus(raw.status),
          `supply speech endpoint returned HTTP ${raw.status}: ${audio.toString("utf8").slice(0, 200)}`,
          raw.status,
          durationMs,
          RAIL_PROVIDER,
        );
      }
      if (audio.length === 0) {
        return railFailure("malformed-response", "speech endpoint returned no audio bytes", raw.status, durationMs, RAIL_PROVIDER);
      }
      const format = envelope.responseFormat ?? "wav";
      const mime =
        format === "mp3"
          ? "audio/mpeg"
          : format === "pcm"
            ? "audio/pcm"
            : format === "opus"
              ? "audio/ogg"
              : format === "aac"
                ? "audio/aac"
                : "audio/wav";
      return successOutcomeOfFact(
        ANYTHINGLLM_SPEECH_RESULT_NAME,
        {
          audioBase64: audio.toString("base64"),
          mime,
          format,
          audioBytes: audio.length,
        },
        { usage: { inputTokens: 0, outputTokens: 0 }, providerLatencyMs: durationMs },
      );
    }

    // envelope.kind === "transcription"
    let raw;
    try {
      raw = await transport.send({
        method: "POST",
        url: context.endpointUrl ?? asrEndpoint,
        headers: { ...authHeaders },
        bodyJson: { file_base64: envelope.fileBase64 },
        timeoutMs: context.timeoutMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const category = /timeout|timed[ -]?out|abort/i.test(message) ? "timeout" : "network";
      return railFailure(category, message, null, Date.now() - startedAt, RAIL_PROVIDER);
    }
    const durationMs = Date.now() - startedAt;
    const text = await collectBodyText(raw.body);
    if (raw.status < 200 || raw.status >= 300) {
      return railFailure(
        categoryForStatus(raw.status),
        `supply asr endpoint returned HTTP ${raw.status}: ${text.slice(0, 200)}`,
        raw.status,
        durationMs,
        RAIL_PROVIDER,
      );
    }
    let parsed: SupplyAsrResponse;
    try {
      parsed = JSON.parse(stripJsonFence(text)) as SupplyAsrResponse;
    } catch {
      return railFailure("malformed-response", "non-JSON asr response body", raw.status, durationMs, RAIL_PROVIDER);
    }
    if (typeof parsed.text !== "string" || parsed.text.length === 0) {
      return railFailure("malformed-response", "asr response carried no transcript", raw.status, durationMs, RAIL_PROVIDER);
    }
    const inputTokens = typeof parsed.usage?.prompt_tokens === "number" ? parsed.usage.prompt_tokens : 0;
    const outputTokens = typeof parsed.usage?.completion_tokens === "number" ? parsed.usage.completion_tokens : 0;
    return successOutcomeOfFact(
      ANYTHINGLLM_TRANSCRIPTION_RESULT_NAME,
      {
        text: parsed.text,
        inputTokens,
        outputTokens,
      },
      {
        usage: { inputTokens, outputTokens },
        providerLatencyMs: durationMs,
      },
    );
  };

  return {
    rail: RAIL_PROVIDER,
    async complete(request, context) {
      return dispatch(request, context);
    },
    // The AnythingLLM chat path is request/response at the provider
    // connector (the app's own SSE facade streams the completed turn to
    // the BROWSER, not the provider); the rail backend is non-streaming,
    // so stream() emits the complete normalized response as one terminal
    // sequence (an honest single-shot stream, never a fake SSE — the
    // identical disclosure PPR-020/022/023/025 recorded).
    async *stream(request, context) {
      const outcome = await dispatch(request, context);
      if (outcome.kind === "provider-failure") {
        yield { type: "stream-error", failure: outcome.failure };
        return;
      }
      for (const text of outcome.response.content) {
        yield { type: "text-delta", text };
      }
      yield {
        type: "stream-done",
        stopReason: outcome.response.stopReason,
        usage: outcome.response.usage,
      };
    },
  };
}

/** The route identities the rail's planning decisions record (neutral strings). */
export const RAIL_ROUTES = {
  text: { provider: RAIL_PROVIDER, model: RAIL_MODEL },
  vision: { provider: RAIL_PROVIDER, model: RAIL_VISION_MODEL },
  speech: { provider: RAIL_PROVIDER, model: RAIL_SPEECH_MODEL },
  transcription: { provider: RAIL_PROVIDER, model: RAIL_TRANSCRIPTION_MODEL },
} as const;

/** Exposed for the tests' envelope-fixture building. */
export const RAIL_PROTOCOL_PREFIX = "anythingllm-rail/1\n";
