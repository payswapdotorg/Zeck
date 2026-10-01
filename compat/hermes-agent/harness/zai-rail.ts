/**
 * The multi-surface GLM supply-rail adapter for PPR-022 (Hermes-Agent) —
 * a `custom`-rail `ModelProvider` over the sandbox's authorized GLM
 * endpoint, following the platform's own adapter discipline (see
 * src/modules/models/adapters/openrouter.ts and the PPR-018/019/020
 * precedents): "No SDK: the rail speaks OpenAI-compatible JSON over HTTP,
 * driven through the neutral `HttpTransport` port; provider specifics
 * live ONLY in this file."
 *
 * WHAT THIS RAIL TRANSLATES (the Hermes-specific axes; one dispatch per
 * envelope kind — rail-protocol.ts):
 *  - "completion"    → {base}/chat/completions (text) or
 *                      {base}/chat/completions/vision (image parts — the
 *                      same vision surface the sandbox's z-ai-web-dev-sdk
 *                      createVision uses); the tools array rides text
 *                      requests; the response's tool_calls are normalized
 *                      into the structured turn;
 *  - "speech"        → {base}/audio/tts {input, voice, speed,
 *                      response_format} → raw audio bytes → base64 in the
 *                      normalized speech-result fact;
 *  - "transcription" → {base}/audio/asr {file_base64} → {text, usage} →
 *                      the normalized transcription-result fact;
 *  - "image"         → {base}/images/generations {prompt, size} →
 *                      {data:[{base64}]} → the normalized image-result
 *                      fact (the app's requested size maps onto the
 *                      supply's supported size set — supplySizeOf).
 *
 * RESPONSE NORMALIZATION: every supply-specific shape becomes a neutral
 * structured fact BEFORE re-entering platform code (ACR-007 §5).
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
  successOutcomeOfFact,
  successOutcomeOfTurn,
  supplySizeOf,
  type OpenAiToolCall,
} from "./rail-protocol";
import {
  RAIL_IMAGE_MODEL,
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

/** The supply endpoint's image response shape (live-verified). */
interface SupplyImageResponse {
  readonly data?: readonly { readonly base64?: unknown; readonly url?: unknown }[];
}

export interface ZaiRailOptions {
  /** The supply endpoint base URL (from the platform-side supply config). */
  readonly baseUrl: string;
  /** The HTTP transport (injectable — the fault-injection seam of the battery). */
  readonly transport: HttpTransport;
}

/** Collect a transport body as one Buffer (binary-safe). */
async function collectBodyBuffer(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Normalize the supply response's tool calls (absent → empty). */
function toolCallsOf(message: NonNullable<SupplyChatResponse["choices"]>[number]["message"]): readonly OpenAiToolCall[] {
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
  const imageEndpoint = `${base}/images/generations`;

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
      // The tools schema rides text-endpoint requests (the vision surface
      // ignores the tools axis — a disclosed supply limitation, the same
      // one PPR-020 recorded).
      if (envelope.tools !== undefined && envelope.tools.length > 0 && !envelope.vision) {
        body.tools = envelope.tools;
        body.tool_choice = "auto";
      }
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
          `supply endpoint returned HTTP ${response.status}: ${response.text.slice(0, 200)}`,
          response.status,
          durationMs,
          RAIL_PROVIDER,
        );
      }
      let parsed: SupplyChatResponse;
      try {
        parsed = JSON.parse(response.text) as SupplyChatResponse;
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
      const audio = await collectBodyBuffer(raw.body);
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
      const mime = format === "mp3" ? "audio/mpeg" : format === "pcm" ? "audio/pcm" : "audio/wav";
      return successOutcomeOfFact(
        "hermes-speech-result",
        {
          audioBase64: audio.toString("base64"),
          mime,
          format,
          audioBytes: audio.length,
        },
        { usage: { inputTokens: 0, outputTokens: 0 }, providerLatencyMs: durationMs },
      );
    }

    if (envelope.kind === "transcription") {
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
        parsed = JSON.parse(text) as SupplyAsrResponse;
      } catch {
        return railFailure("malformed-response", "non-JSON asr response body", raw.status, durationMs, RAIL_PROVIDER);
      }
      if (typeof parsed.text !== "string" || parsed.text.length === 0) {
        return railFailure("malformed-response", "asr response carried no transcript", raw.status, durationMs, RAIL_PROVIDER);
      }
      return successOutcomeOfFact(
        "hermes-transcription-result",
        {
          text: parsed.text,
          inputTokens: typeof parsed.usage?.prompt_tokens === "number" ? parsed.usage.prompt_tokens : 0,
          outputTokens: typeof parsed.usage?.completion_tokens === "number" ? parsed.usage.completion_tokens : 0,
        },
        {
          usage: {
            inputTokens: typeof parsed.usage?.prompt_tokens === "number" ? parsed.usage.prompt_tokens : 0,
            outputTokens: typeof parsed.usage?.completion_tokens === "number" ? parsed.usage.completion_tokens : 0,
          },
          providerLatencyMs: durationMs,
        },
      );
    }

    // envelope.kind === "image"
    const body: Record<string, unknown> = {
      prompt: envelope.prompt,
      size: supplySizeOf(envelope.size),
    };
    let raw;
    try {
      raw = await transport.send({
        method: "POST",
        url: context.endpointUrl ?? imageEndpoint,
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
    const text = await collectBodyText(raw.body);
    if (raw.status < 200 || raw.status >= 300) {
      return railFailure(
        categoryForStatus(raw.status),
        `supply image endpoint returned HTTP ${raw.status}: ${text.slice(0, 200)}`,
        raw.status,
        durationMs,
        RAIL_PROVIDER,
      );
    }
    let parsed: SupplyImageResponse;
    try {
      parsed = JSON.parse(text) as SupplyImageResponse;
    } catch {
      return railFailure("malformed-response", "non-JSON image response body", raw.status, durationMs, RAIL_PROVIDER);
    }
    let imageBase64 = parsed.data?.[0]?.base64;
    if ((typeof imageBase64 !== "string" || imageBase64.length === 0) && typeof parsed.data?.[0]?.url === "string") {
      // The supply serves image artifacts via its own hosted-URL references
      // (live-verified: /images/generations returns {data:[{url}]} and ignores
      // b64-oriented parameters). Following the SUPPLY'S OWN artifact
      // reference to materialize the bytes it generated is part of the
      // mediated path — the identical bytes the supply would have inlined;
      // the runtime never sees the URL (the adapter returns base64 only).
      try {
        const artifact = await fetch(parsed.data[0].url, {
          signal: AbortSignal.timeout(context.timeoutMs ?? 120_000),
        });
        const bytes = new Uint8Array(await artifact.arrayBuffer());
        if (artifact.ok && bytes.length > 0) {
          imageBase64 = Buffer.from(bytes).toString("base64");
        }
      } catch {
        // falls through to the no-image-data failure below (honest boundary)
      }
    }
    if (typeof imageBase64 !== "string" || imageBase64.length === 0) {
      return railFailure("malformed-response", "image response carried no image data", raw.status, durationMs, RAIL_PROVIDER);
    }
    return successOutcomeOfFact(
      "hermes-image-result",
      {
        imageBase64,
        mime: "image/png",
        size: supplySizeOf(envelope.size),
        imageBytes: Math.floor((imageBase64.length * 3) / 4),
      },
      { usage: { inputTokens: 0, outputTokens: 0 }, providerLatencyMs: durationMs },
    );
  };

  return {
    rail: RAIL_PROVIDER,
    async complete(request, context) {
      return dispatch(request, context);
    },
    // The Hermes runtime PREFERS streaming on every turn (its liveness
    // health-checking depends on it); the rail backend is non-streaming,
    // so stream() emits the complete normalized response as one terminal
    // sequence (an honest single-shot stream, never a fake SSE — the
    // identical disclosure PPR-020 recorded).
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
  image: { provider: RAIL_PROVIDER, model: RAIL_IMAGE_MODEL },
} as const;

/** Exposed for the tests' envelope-fixture building. */
export const RAIL_PROTOCOL_PREFIX = "hermes-rail/1\n";
