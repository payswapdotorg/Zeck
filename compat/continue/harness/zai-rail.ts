/**
 * The GLM supply-rail adapter for PPR-021 (Continue) — a `custom`-rail
 * `ModelProvider` over the sandbox's authorized GLM endpoint, following
 * the platform's own adapter discipline (see
 * src/modules/models/adapters/openrouter.ts and the PPR-018/PPR-019/
 * PPR-020 precedents): "No SDK: the rail speaks OpenAI-compatible JSON
 * over HTTP, driven through the neutral `HttpTransport` port; provider
 * specifics live ONLY in this file."
 *
 * WHAT THIS RAIL TRANSLATES (the four Continue model-role surfaces at
 * the pinned revision — the rail protocol's task kinds):
 *
 *  - continue-role.chat-completions: the rail protocol envelope's full
 *    OpenAI-format messages (multimodal parts, tool_calls history,
 *    tool role) + the tools schema array. VISION ROUTING: an envelope
 *    carrying image parts dispatches to the supply's vision surface
 *    ({base}/chat/completions/vision); text-only envelopes dispatch to
 *    {base}/chat/completions. NATIVE TOOL CALLS: the tools array rides
 *    the request when present; the response's tool_calls are normalized
 *    into the structured turn. RESPONSE NORMALIZATION: the OpenAI-format
 *    response becomes the neutral structured turn BEFORE re-entering
 *    platform code (ACR-007 §5).
 *
 *  - continue-role.completions: the autocomplete role's legacy
 *    text-completions shape. Continue's autocomplete engine renders the
 *    full FIM prompt itself (prefix/suffix templating — application
 *    context), so the rail dispatches the rendered prompt as a plain
 *    chat turn and normalizes the response text.
 *
 *  - continue-role.embeddings: THE HONEST SUPPLY BOUNDARY. The
 *    sandbox's authorized supply endpoint exposes NO embeddings
 *    execution surface (probed live at proof time: {base}/embeddings →
 *    404 page not found). The rail therefore returns a NON-RETRYABLE
 *    provider-unavailable failure — the delegated embeddings execution
 *    lands in FAILED honestly, and no mock, deterministic stand-in or
 *    chat-model "vector" is ever fabricated (rule 5). The boundary is
 *    disclosed in the evidence record (operator boundary, owner: Lead).
 *
 *  - continue-role.rerank: THE DISCLOSED LLM-SCORING REALIZATION. The
 *    supply exposes no dedicated cross-encoder rerank endpoint either,
 *    so the rail realizes the delegated rerank execution as LLM-based
 *    relevance scoring over the chat rail — a real AI execution in
 *    which the supply model genuinely scores each document against the
 *    query (the same technique Continue's own "llm" reranker uses at
 *    this revision). The scores are real model output, mechanically
 *    validated (one score per document, ordered, 0..1); the realization
 *    is disclosed in the evidence record as a supply-capability
 *    realization, never presented as a dedicated cross-encoder.
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
  CONTINUE_EMBEDDINGS_NAME,
  CONTINUE_RERANK_NAME,
  CONTINUE_TURN_NAME,
  decodeModelRequest,
  railFailure,
  successOutcomeOfText,
  successOutcomeOfTurn,
  type OpenAiTool,
  type OpenAiToolCall,
} from "./rail-protocol";
import { RAIL_MODEL, RAIL_PROVIDER, RAIL_VISION_MODEL } from "./zai-config";

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

/** The supply endpoint's OpenAI-compatible response shape. */
interface SupplyResponse {
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

/** One supply response choice's message shape. */
type SupplyMessage = NonNullable<NonNullable<SupplyResponse["choices"]>[number]["message"]>;

export interface ZaiRailOptions {
  /** The supply endpoint base URL (from the platform-side supply config). */
  readonly baseUrl: string;
  /** The HTTP transport (injectable — the fault-injection seam of the battery). */
  readonly transport: HttpTransport;
}

/** Normalize the supply response's tool calls (absent → empty). */
function toolCallsOf(message: SupplyMessage | undefined): readonly OpenAiToolCall[] {
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

/** Parse the first JSON number array from a scoring response (or null). */
export function parseScoreArray(text: string, expectedCount: number): readonly number[] | null {
  const match = /\[[\s\S]*\]/.exec(text);
  if (match === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== expectedCount ||
    !parsed.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1)
  ) {
    return null;
  }
  return parsed as number[];
}

/** Build the LLM-scoring prompt for one rerank realization (disclosed design). */
export function rerankScoringPrompt(query: string, documents: readonly string[]): string {
  const numbered = documents
    .map(
      (document, index) =>
        `[${index + 1}] ${document.replace(/\s+/g, " ").trim().slice(0, 400)}`,
    )
    .join("\n");
  return (
    "You are a relevance judge. Score how relevant each document is to the query, " +
    "as a number between 0.0 (irrelevant) and 1.0 (highly relevant).\n\n" +
    `QUERY: ${query.replace(/\s+/g, " ").trim().slice(0, 400)}\n\n` +
    `DOCUMENTS:\n${numbered}\n\n` +
    `Reply with ONLY a JSON array of exactly ${documents.length} numbers between 0 and 1, ` +
    "in document order, no other text. Example for 3 documents: [0.9, 0.1, 0.5]"
  );
}

/** Create the GLM supply rail adapter for Continue (rail slug `custom`). */
export function createZaiRailAdapter(options: ZaiRailOptions): ModelProvider {
  const { baseUrl, transport } = options;
  const textEndpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const visionEndpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions/vision`;

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
    const task = envelope.task;

    // ------------------------------------------------------------------
    // The embeddings surface: the HONEST supply boundary (no /embeddings
    // on the authorized supply — probed live). Never a fabricated vector.
    // ------------------------------------------------------------------
    if (task.kind === "continue-role.embeddings") {
      return railFailure(
        "provider-unavailable",
        "the authorized supply endpoint exposes no embeddings execution surface " +
          "(probed live at proof time: /embeddings → 404) — the delegated embeddings " +
          "edge cannot be executed in this sandbox; no mock or deterministic stand-in is offered",
        null,
        Date.now() - startedAt,
        RAIL_PROVIDER,
        false,
      );
    }

    // ------------------------------------------------------------------
    // The rerank surface: the DISCLOSED LLM-scoring realization (a real
    // AI execution over the chat rail — never presented as a dedicated
    // cross-encoder).
    // ------------------------------------------------------------------
    if (task.kind === "continue-role.rerank") {
      const documents = task.documents ?? [];
      const body: Record<string, unknown> = {
        model: RAIL_MODEL,
        messages: [
          {
            role: "user",
            content: rerankScoringPrompt(task.query ?? "", documents),
          },
        ],
        thinking: { type: "disabled" },
      };
      const outcome = await dispatchJson(
        textEndpoint,
        authHeaders,
        body,
        context,
        startedAt,
        transport,
      );
      if (outcome.kind === "provider-failure") {
        return outcome;
      }
      const text = outcome.response.content.join("");
      const scores = parseScoreArray(text, documents.length);
      if (scores === null) {
        // A malformed scoring response is retryable: the Zeck-owned
        // bounded policy retry (ACR-007 §1) re-dispatches once.
        return railFailure(
          "malformed-response",
          `the rerank scoring realization returned no valid ${documents.length}-score array: ${text.slice(0, 160)}`,
          null,
          Date.now() - startedAt,
          RAIL_PROVIDER,
          true,
        );
      }
      return {
        kind: "provider-success",
        response: {
          content: [JSON.stringify(scores)],
          stopReason: "stop",
          structuredOutput: {
            name: CONTINUE_RERANK_NAME,
            json: { scores: [...scores] },
          },
          usage: { ...outcome.response.usage, costUsd: null },
          providerLatencyMs: outcome.response.providerLatencyMs,
        },
      };
    }

    // ------------------------------------------------------------------
    // The completions surface: Continue's autocomplete engine rendered
    // the full FIM prompt (application context); dispatch it as a chat
    // turn and normalize the response text.
    // ------------------------------------------------------------------
    if (task.kind === "continue-role.completions") {
      const body: Record<string, unknown> = {
        model: RAIL_MODEL,
        messages: [{ role: "user", content: task.prompt ?? "" }],
        thinking: { type: "disabled" },
      };
      if (task.params?.maxTokens !== undefined) {
        body.max_tokens = task.params.maxTokens;
      }
      if (task.params?.temperature !== undefined) {
        body.temperature = task.params.temperature;
      }
      const outcome = await dispatchJson(
        textEndpoint,
        authHeaders,
        body,
        context,
        startedAt,
        transport,
      );
      if (outcome.kind === "provider-failure") {
        return outcome;
      }
      return successOutcomeOfText({
        text: outcome.response.content.join(""),
        usage: outcome.response.usage,
        providerLatencyMs: outcome.response.providerLatencyMs,
      });
    }

    // ------------------------------------------------------------------
    // The chat-completions surface (chat, subagent, edit, apply roles).
    // ------------------------------------------------------------------
    const body: Record<string, unknown> = {
      model: envelope.vision ? RAIL_VISION_MODEL : RAIL_MODEL,
      messages: task.messages ?? [],
      thinking: { type: "disabled" },
    };
    // The tools schema rides text-endpoint requests (the vision surface
    // ignores the tools axis — a disclosed supply limitation).
    const tools = task.tools;
    if (tools !== undefined && tools.length > 0 && !envelope.vision) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    if (task.params?.maxTokens !== undefined) {
      body.max_tokens = task.params.maxTokens;
    }
    if (task.params?.temperature !== undefined) {
      body.temperature = task.params.temperature;
    }

    const outcome = await dispatchJson(
      envelope.vision ? visionEndpoint : textEndpoint,
      authHeaders,
      body,
      context,
      startedAt,
      transport,
    );
    if (outcome.kind === "provider-failure") {
      return outcome;
    }
    // Re-normalize the generic success into the structured turn contract.
    const first = (outcome.response.structuredOutput?.json ?? {}) as {
      readonly content?: unknown;
      readonly toolCalls?: unknown;
      readonly finishReason?: unknown;
    };
    if (typeof first.content !== "string" || typeof first.finishReason !== "string") {
      return railFailure(
        "malformed-response",
        "the supply response did not normalize into a structured turn",
        null,
        Date.now() - startedAt,
        RAIL_PROVIDER,
      );
    }
    return successOutcomeOfTurn({
      turn: {
        content: first.content,
        toolCalls: Array.isArray(first.toolCalls)
          ? (first.toolCalls as OpenAiToolCall[])
          : [],
        finishReason: first.finishReason,
      },
      stopReason: first.finishReason,
      usage: outcome.response.usage,
      providerLatencyMs: outcome.response.providerLatencyMs,
    });
  };

  return {
    rail: RAIL_PROVIDER,
    async complete(request, context) {
      return dispatch(request, context);
    },
    // The pinned Continue runtime consumes SSE for chat completions but
    // the rail backend is non-streaming; stream() emits the complete
    // normalized response as one terminal sequence (an honest single-shot
    // stream, never a fake SSE) — the adapter renders the SSE chunks
    // itself from the normalized turn.
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

/** One JSON dispatch through the transport + response normalization. */
async function dispatchJson(
  endpoint: string,
  authHeaders: Record<string, string>,
  body: Record<string, unknown>,
  context: ProviderDispatchContext,
  startedAt: number,
  transport: HttpTransport,
): Promise<ModelCallOutcome> {
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
    return railFailure(category, message, null, Date.now() - startedAt, RAIL_PROVIDER, true);
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
  let parsed: SupplyResponse;
  try {
    parsed = JSON.parse(response.text) as SupplyResponse;
  } catch {
    return railFailure("malformed-response", "non-JSON response body", response.status, durationMs, RAIL_PROVIDER, true);
  }
  const first = parsed.choices?.[0];
  if (first === undefined || first.message === undefined) {
    return railFailure("malformed-response", "response carried no message choice", response.status, durationMs, RAIL_PROVIDER, true);
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
      true,
    );
  }
  return successOutcomeOfTurn({
    turn: { content, toolCalls, finishReason },
    stopReason: finishReason,
    usage: { inputTokens, outputTokens, totalTokens },
    providerLatencyMs: durationMs,
  });
}

/** The route identities the rail's planning decisions record (neutral strings). */
export const RAIL_ROUTES = {
  text: { provider: RAIL_PROVIDER, model: RAIL_MODEL },
  vision: { provider: RAIL_PROVIDER, model: RAIL_VISION_MODEL },
} as const;

/** The structured-output names (re-exported for the tests). */
export const RAIL_STRUCTURED_NAMES = {
  turn: CONTINUE_TURN_NAME,
  embeddings: CONTINUE_EMBEDDINGS_NAME,
  rerank: CONTINUE_RERANK_NAME,
} as const;
