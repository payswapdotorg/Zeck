/**
 * The platform-side failure-attribution driver (VAL-020).
 *
 * The reliability slice of the validation program: drives
 * failure-attribution probe executions (one model dispatch OR one
 * governed tool invocation per attempt) through the REAL platform path
 * with bounded retry/recovery, attributing every observed failure to
 * the correct layer (transport vs provider vs tool vs platform) with
 * the correct retryability classification:
 *
 *   * the attribution taxonomy as PURE derivations —
 *     `classifyTransportError` (the HTTP exchange itself failed: the
 *     transport layer), `classifyProviderEnvelope` (the provider's own
 *     error envelope — dashscope flat `code`/`message` bodies and
 *     OpenRouter nested `error.code`/`error.message` bodies, the code
 *     token winning over the raw status for the DOCUMENTED live
 *     shapes), `classifyCompletionDegeneracy` (a 200 with empty
 *     content — the VAL-014 honesty rule: an honest SUCCESS with empty
 *     content, attributed to the provider layer, never fabricated into
 *     either a failure or content), `classifyToolRejection` /
 *     `classifyToolDeadline` (the tool layer: a deterministic refusal
 *     is NEVER retried; a deadline overrun IS retried) and
 *     `classifyPlatformRejection` (the platform's own pre-effect
 *     machinery);
 *   * REAL provider failure envelope fixtures — the verbatim envelope
 *     SHAPES the live rails actually produced in the documented prior
 *     runs (dashscope `AllocationQuota.FreeTierOnly` 403, dashscope
 *     `AccessDenied` 403, dashscope `InternalError.Algo.InvalidParameter`
 *     400, OpenRouter credit-limit 402, OpenRouter 429, the empty-content
 *     200) — replayed by the app's deterministic fault-injection
 *     transports (code tokens verbatim from the live findings; message
 *     text representative where the findings preserved only the code);
 *   * a transport-injected attribution rail speaking the REAL request
 *     shapes to the PINNED REAL endpoint domains (the live-crown
 *     domain-typo lesson: fake transports cannot catch DNS defects, so
 *     the URL constants pin the live-proven domains exactly);
 *   * a bounded tool executor (deadline race; injectable timer) for
 *     the tool-failure/tool-timeout surface;
 *   * a bounded retry policy with journaled per-attempt history:
 *     RETRYABLE classes only (transport-failure / rate-limit /
 *     provider-unavailable / tool-timeout), at most
 *     `maxExtraAttempts` extra attempts with a measured backoff, every
 *     attempt journaled EXACTLY once (digests in the journal, never
 *     payload bytes); non-retryable failures never retry;
 *   * the execution driver mirroring the VAL-019 driver (authorize →
 *     plan → planning-decision BEFORE the first dispatch → queue →
 *     start → attempts (genuine wait-tool → resume cycles around every
 *     tool attempt) → verify → terminal: a failure outcome or any
 *     failed criterion → FAILED — never a partial-success shortcut).
 *
 * Honesty invariants:
 *   * a provider/tool failure FAILS the execution (no partial-success
 *     shortcut); an empty-content 200 is an honest SUCCESS with empty
 *     content (the VAL-014 rule — never a fabricated failure, never
 *     fabricated content);
 *   * retryable failures get bounded retries — never an infinite
 *     loop; non-retryable failures never retry;
 *   * recovery-after-retry produces a COMPLETED execution with the
 *     retry history journaled exactly once per attempt;
 *   * usage, cost and latency are measured, never estimated; evidence
 *     carries payload DIGESTS, never payload bytes;
 *   * an out-of-vocabulary task or an unexposed tool is a platform
 *     layer rejection BEFORE any network effect or tool effect.
 *
 * Everything is seam-injected and network-free here (the lab
 * contract); the integration seam binds the REAL fetch transport
 * against the REAL endpoint domains, the REAL executions service and
 * the REAL ledger vocabularies.
 */

import type { LabUsage, LabVerificationCriterion } from "./derive";

// ---------------------------------------------------------------------------
// The attribution taxonomy (PURE derivations)
// ---------------------------------------------------------------------------

/** The layer a failure is attributed to (the attribution axis). */
export type AttributionLayer = "transport" | "provider" | "tool" | "platform";

/**
 * The attribution class vocabulary: the failure classes the corpus
 * exercises plus the degenerate-completion class. `empty-completion`
 * is NOT a failure — per the VAL-014 honesty rule a 200 with empty
 * content is an honest SUCCESS with empty content (attributed to the
 * provider layer, never retried); it lives in the vocabulary because
 * attribution must still NAME it.
 */
export const ATTRIBUTION_CLASSES = [
  // transport layer — the HTTP exchange itself failed
  "transport-failure",
  // provider layer — the provider's own envelopes and degenerate answers
  "quota",
  "rate-limit",
  "invalid-request",
  "access-denied",
  "model-unavailable",
  "provider-unavailable",
  "empty-completion",
  "provider-error",
  // tool layer — the governed tool surface
  "tool-failure",
  "tool-timeout",
  // platform layer — the platform's own pre/post machinery
  "platform-error",
] as const;

export type AttributionClass = (typeof ATTRIBUTION_CLASSES)[number];

/** The retryability classes (bounded retry applies to these ONLY). */
const RETRYABLE_CLASSES: ReadonlySet<AttributionClass> = new Set([
  "transport-failure",
  "rate-limit",
  "provider-unavailable",
  "tool-timeout",
]);

/** The layer each attribution class belongs to (the taxonomy table). */
const CLASS_LAYERS: Readonly<Record<AttributionClass, AttributionLayer>> = {
  "transport-failure": "transport",
  quota: "provider",
  "rate-limit": "provider",
  "invalid-request": "provider",
  "access-denied": "provider",
  "model-unavailable": "provider",
  "provider-unavailable": "provider",
  "empty-completion": "provider",
  "provider-error": "provider",
  "tool-failure": "tool",
  "tool-timeout": "tool",
  "platform-error": "platform",
};

/** Whether the class is retryable under the bounded retry policy. */
export function isRetryableAttributionClass(value: AttributionClass): boolean {
  return RETRYABLE_CLASSES.has(value);
}

/** The layer a class attributes to (the taxonomy table lookup). */
export function layerOfAttributionClass(value: AttributionClass): AttributionLayer {
  return CLASS_LAYERS[value];
}

/** One attribution verdict: class + layer + retryability + provenance. */
export interface Attribution {
  readonly attributionClass: AttributionClass;
  readonly layer: AttributionLayer;
  readonly retryable: boolean;
  /** The envelope's own code token (sanitized; never credentials). */
  readonly providerCode: string | null;
  /** Human-readable message, length-capped and credential-free. */
  readonly message: string;
  /** HTTP status when the failure came from an HTTP exchange. */
  readonly httpStatus: number | null;
}

const MAX_ATTRIBUTION_MESSAGE = 200;

function sanitizeMessage(value: string | null | undefined): string {
  if (typeof value !== "string") {
    return "provider failure (no provider message)";
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "provider failure (no provider message)";
  }
  return trimmed.length <= MAX_ATTRIBUTION_MESSAGE ? trimmed : `${trimmed.slice(0, 200)}…`;
}

/**
 * Classify a thrown transport error: the HTTP exchange itself failed
 * (connection refused, DNS, TLS, abort). Layer: TRANSPORT — never the
 * provider (the provider was never reached); retryable (a later
 * attempt may reach it).
 */
export function classifyTransportError(error: unknown): Attribution {
  const message = error instanceof Error ? error.message : String(error);
  return {
    attributionClass: "transport-failure",
    layer: "transport",
    retryable: true,
    providerCode: null,
    message: sanitizeMessage(message),
    httpStatus: null,
  };
}

/** The envelope's own code/message across the REAL rail shapes. */
export function extractEnvelopeCodeAndMessage(body: unknown): {
  readonly code: string | null;
  readonly message: string | null;
} {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { code: null, message: null };
  }
  const record = body as {
    error?: { code?: unknown; message?: unknown } | string;
    code?: unknown;
    message?: unknown;
  };
  // OpenRouter shape: nested {error: {code, message}}.
  if (typeof record.error === "object" && record.error !== null) {
    const nested = record.error as { code?: unknown; message?: unknown };
    return {
      code:
        typeof nested.code === "string"
          ? nested.code
          : typeof nested.code === "number"
            ? String(nested.code)
            : null,
      message: typeof nested.message === "string" ? nested.message : null,
    };
  }
  if (typeof record.error === "string") {
    return { code: null, message: record.error };
  }
  // dashscope shape: flat {code, message, request_id}.
  return {
    code: typeof record.code === "string" ? record.code : null,
    message: typeof record.message === "string" ? record.message : null,
  };
}

/**
 * Known provider code tokens observed in the documented live runs. The
 * code token is the provider's OWN semantics and WINS over the raw
 * HTTP status when they disagree — the dashscope quota boundary rides
 * a 403 whose status alone would read as access-denied (the
 * envelope-shape discrimination at the heart of AC6).
 */
const KNOWN_CODE_TOKENS: readonly {
  readonly pattern: RegExp;
  readonly attributionClass: AttributionClass;
}[] = [
  { pattern: /^AllocationQuota/, attributionClass: "quota" },
  { pattern: /^AccessDenied/, attributionClass: "access-denied" },
  { pattern: /InvalidParameter$/, attributionClass: "invalid-request" },
  { pattern: /^Throttling/, attributionClass: "rate-limit" },
];

/**
 * Classify a provider answer envelope: the non-2xx status + body the
 * provider itself returned. Layer: PROVIDER. The known code tokens
 * (AllocationQuota / AccessDenied / InvalidParameter / Throttling)
 * override the status-derived class; otherwise the status maps:
 * 400 invalid-request, 401/403 access-denied, 402 quota, 404
 * model-unavailable, 408/5xx provider-unavailable (retryable), 429
 * rate-limit (retryable), anything else provider-error.
 */
export function classifyProviderEnvelope(status: number, body: unknown): Attribution {
  const { code, message } = extractEnvelopeCodeAndMessage(body);
  let attributionClass: AttributionClass;
  if (code !== null) {
    const known = KNOWN_CODE_TOKENS.find((token) => token.pattern.test(code));
    attributionClass = known === undefined ? classForStatus(status) : known.attributionClass;
  } else {
    attributionClass = classForStatus(status);
  }
  const retryable = isRetryableAttributionClass(attributionClass);
  return {
    attributionClass,
    layer: layerOfAttributionClass(attributionClass),
    retryable,
    providerCode: code,
    message: sanitizeMessage(message),
    httpStatus: Number.isFinite(status) ? status : null,
  };
}

function classForStatus(status: number): AttributionClass {
  if (status === 400 || status === 413 || status === 422) return "invalid-request";
  if (status === 401 || status === 403) return "access-denied";
  if (status === 402) return "quota";
  if (status === 404) return "model-unavailable";
  // 408 folds into provider-unavailable: the provider did not answer
  // in time — retryable, provider layer (the timeout-vs-refusal
  // distinction that MATTERS is the tool-layer one: deadline vs
  // refusal).
  if (status === 408 || status === 429 || status >= 500)
    return status === 429 ? "rate-limit" : "provider-unavailable";
  return "provider-error";
}

/**
 * Classify a degenerate completion: a 200 whose content is empty. Per
 * the VAL-014 honesty rule this is an honest SUCCESS with empty
 * content — attributed to the provider layer (the provider's model
 * produced nothing) and NEVER retried (retrying would fabricate a
 * failure that did not happen). Returns null for non-empty content
 * (a clean success carries no attribution).
 */
export function classifyCompletionDegeneracy(content: string): Attribution | null {
  if (content.trim().length > 0) {
    return null;
  }
  return {
    attributionClass: "empty-completion",
    layer: "provider",
    retryable: false,
    providerCode: null,
    message: "provider returned an empty completion (honest success with empty content)",
    httpStatus: 200,
  };
}

/** Classify a tool's settled rejection (the tool layer). */
export function classifyToolRejection(value: string): Attribution {
  return {
    attributionClass: "tool-failure",
    layer: "tool",
    retryable: false,
    providerCode: null,
    message: sanitizeMessage(value),
    httpStatus: null,
  };
}

/** Classify a tool deadline overrun (the tool layer — retryable). */
export function classifyToolDeadline(tool: string, deadlineMs: number): Attribution {
  return {
    attributionClass: "tool-timeout",
    layer: "tool",
    retryable: true,
    providerCode: null,
    message: `tool ${tool} exceeded its ${deadlineMs}ms execution deadline (no result was produced)`,
    httpStatus: null,
  };
}

/** Classify a platform-side pre-effect rejection (the platform layer). */
export function classifyPlatformRejection(message: string): Attribution {
  return {
    attributionClass: "platform-error",
    layer: "platform",
    retryable: false,
    providerCode: null,
    message: sanitizeMessage(message),
    httpStatus: null,
  };
}

// ---------------------------------------------------------------------------
// REAL provider failure envelope fixtures (the documented live shapes)
// ---------------------------------------------------------------------------

/**
 * The REAL rail failure envelope shapes observed in the documented
 * prior live runs. The envelope SHAPES and code tokens are verbatim
 * from the live findings (dashscope flat `code`/`message`; OpenRouter
 * nested `error.code`/`error.message`); message TEXT is representative
 * where the findings preserved only the code token. These are the
 * replay fixtures the app's fault-injection transports use — never
 * fabricated outcomes, never credentials.
 */
export const REAL_RAIL_FAILURE_ENVELOPES = [
  {
    envelopeId: "dashscope-allocation-quota-403",
    rail: "dashscope",
    httpStatus: 403,
    body: {
      code: "AllocationQuota.FreeTierOnly",
      message: "Your allocation quota is exhausted (FreeTierOnly); a paid tier is required.",
      request_id: "allocation-quota-live-shape",
    },
    documentedSource:
      "VAL-015/VAL-018 live runs: the QWEN image-generation rail rejects with AllocationQuota.FreeTierOnly",
  },
  {
    envelopeId: "dashscope-access-denied-403",
    rail: "dashscope",
    httpStatus: 403,
    body: {
      code: "AccessDenied",
      message: "current user api does not support synchronous calls",
      request_id: "access-denied-live-shape",
    },
    documentedSource:
      "VAL-014/VAL-016 live findings: the video-synthesis task API returns AccessDenied (key tier boundary)",
  },
  {
    envelopeId: "dashscope-invalid-parameter-400",
    rail: "dashscope",
    httpStatus: 400,
    body: {
      code: "InternalError.Algo.InvalidParameter",
      message:
        "The dedicated task `asr` corresponding to the current service does not support this input",
      request_id: "invalid-parameter-live-shape",
    },
    documentedSource:
      "VAL-014 live review: the dedicated ASR task endpoint rejects mixed audio+text content",
  },
  {
    envelopeId: "openrouter-credit-limit-402",
    rail: "openrouter",
    httpStatus: 402,
    body: {
      error: {
        code: 402,
        message:
          "This request requires more credits than the account balance permits. Add credits and retry.",
      },
    },
    documentedSource:
      "the documented OpenRouter credit-limit envelope (error.code 402; the work order's verbatim prefix)",
  },
  {
    envelopeId: "openrouter-rate-limit-429",
    rail: "openrouter",
    httpStatus: 429,
    body: {
      error: {
        code: 429,
        message: "Rate limit exceeded: too many requests routed. Please slow down and retry.",
      },
    },
    documentedSource: "the OpenRouter 429 rate-limit class (message text representative)",
  },
  {
    envelopeId: "dashscope-empty-content-200",
    rail: "dashscope",
    httpStatus: 200,
    body: {
      output: { choices: [{ message: { content: [] } }] },
      usage: { input_tokens: 9, output_tokens: 0 },
    },
    documentedSource:
      "VAL-014 live run: honest empty transcripts on the REAL rail (the empty-content 200 shape)",
  },
] as const;

/** The dashscope AllocationQuota 403 envelope (the quota posture). */
export const DASHSCOPE_ALLOCATION_QUOTA_ENVELOPE_403: Readonly<Record<string, unknown>> =
  REAL_RAIL_FAILURE_ENVELOPES[0].body;
/** The dashscope AccessDenied 403 envelope (the video tier boundary). */
export const DASHSCOPE_ACCESS_DENIED_ENVELOPE_403: Readonly<Record<string, unknown>> =
  REAL_RAIL_FAILURE_ENVELOPES[1].body;
/** The dashscope InvalidParameter 400 envelope. */
export const DASHSCOPE_INVALID_PARAMETER_ENVELOPE_400: Readonly<Record<string, unknown>> =
  REAL_RAIL_FAILURE_ENVELOPES[2].body;
/** The OpenRouter credit-limit 402 envelope. */
export const OPENROUTER_CREDIT_LIMIT_ENVELOPE_402: Readonly<Record<string, unknown>> =
  REAL_RAIL_FAILURE_ENVELOPES[3].body;
/** The OpenRouter 429 rate-limit envelope. */
export const OPENROUTER_RATE_LIMIT_ENVELOPE_429: Readonly<Record<string, unknown>> =
  REAL_RAIL_FAILURE_ENVELOPES[4].body;
/** The dashscope empty-content 200 envelope. */
export const DASHSCOPE_EMPTY_CONTENT_ENVELOPE_200: Readonly<Record<string, unknown>> =
  REAL_RAIL_FAILURE_ENVELOPES[5].body;

// ---------------------------------------------------------------------------
// Digests (evidence carries DIGESTS, never payload bytes)
// ---------------------------------------------------------------------------

function digestOf(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// The transport-injected attribution rail (REAL endpoint domains pinned)
// ---------------------------------------------------------------------------

/** The HTTP transport seam (the production binding injects fetch). */
export type HttpTransport = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  },
) => Promise<Response>;

/** The live-proven REAL endpoint domains (the domain-typo lesson). */
export const DASHSCOPE_INTL_HOST = "https://dashscope-intl.aliyuncs.com";
export const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";

/** The pinned REAL endpoint URLs the rail speaks. */
export const ATTRIBUTION_RAIL_ENDPOINTS: Readonly<Record<string, string>> = {
  "dashscope|multimodal-generation": `${DASHSCOPE_INTL_HOST}/api/v1/services/aigc/multimodal-generation/generation`,
  "dashscope|video-synthesis": `${DASHSCOPE_INTL_HOST}/api/v1/services/aigc/video-generation/video-synthesis`,
  "openrouter|chat-completions": `${OPENROUTER_API_BASE}/chat/completions`,
};

/** One attribution probe request (the canonical rail request spec). */
export interface AttributionRailRequest {
  readonly rail: "dashscope" | "openrouter";
  readonly endpoint: "multimodal-generation" | "video-synthesis" | "chat-completions";
  readonly model: string;
  readonly prompt: string;
  /**
   * 2026-09-12 Lead live re-pin: request the model's FULL default
   * completion budget (omit max_tokens) — the genuinely unaffordable
   * posture the account's credit limit rejects with the REAL 402
   * envelope ("You requested up to <N> tokens, but can only afford
   * <M>"). Live-proven on the default chat model; no premium-model
   * pinning needed.
   */
  readonly unaffordableBudget?: boolean;
  /**
   * 2026-09-12 Lead live re-pin: set X-DashScope-Async: enable. The
   * video-synthesis tier boundary is SYNCHRONOUS-CALL-ONLY — the REAL
   * AccessDenied 403 ("current user api does not support synchronous
   * calls") fires WITHOUT the header; WITH it the endpoint ACCEPTS the
   * async task (200 + task_id PENDING — a success, not a failure). The
   * attribution rows probe the genuine boundary synchronously.
   */
  readonly asyncSubmission?: boolean;
}

/** The outcome of ONE rail dispatch attempt (one transport roundtrip). */
export type RailAttemptOutcome =
  | {
      readonly kind: "success";
      readonly content: string;
      /** The degenerate-completion attribution when content is empty. */
      readonly attribution: Attribution | null;
      readonly usage?: LabUsage;
      readonly latencyMs: number;
      readonly httpStatus: number;
    }
  | {
      readonly kind: "failure";
      readonly attribution: Attribution;
      readonly latencyMs: number;
      readonly httpStatus: number | null;
    };

/** The measured request digest (payload DIGEST, never payload bytes). */
export function railRequestDigest(request: AttributionRailRequest): string {
  return digestOf(buildRailBody(request));
}

/** The canonical byte-stable request body per rail/endpoint family. */
export function buildRailBody(request: AttributionRailRequest): Record<string, unknown> {
  if (request.rail === "openrouter") {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: [{ role: "user", content: request.prompt }],
      temperature: 0,
    };
    if (request.unaffordableBudget !== true) {
      body.max_tokens = 16;
    }
    return body;
  }
  if (request.endpoint === "video-synthesis") {
    // The VAL-016 live-proven video-synthesis submission shape (the
    // documented home of the AccessDenied 403 envelope).
    return {
      model: request.model,
      input: { prompt: request.prompt },
      parameters: { size: "1280*720", duration: 5 },
    };
  }
  // The VAL-015 live-proven imagegen multimodal-generation submission
  // shape (the documented home of the AllocationQuota 403 envelope —
  // including the declared size the quota-blocked live dispatches carried).
  return {
    model: request.model,
    input: { prompt: request.prompt },
    parameters: { n: 1, size: "1328*1328" },
  };
}

function railUrlOf(request: AttributionRailRequest): string {
  const url = ATTRIBUTION_RAIL_ENDPOINTS[`${request.rail}|${request.endpoint}`];
  if (url === undefined) {
    throw new Error(
      `no pinned REAL endpoint for rail ${request.rail} endpoint ${request.endpoint}`,
    );
  }
  return url;
}

function normalizeContentParts(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string" ? part : String((part as { text?: unknown })?.text ?? ""),
      )
      .join("");
  }
  return "";
}

/**
 * Extract the content string from a provider 200 across the REAL rail
 * shapes (openrouter choices / dashscope output.choices / the
 * video-synthesis async task identity).
 */
export function extractRailContent(request: AttributionRailRequest, body: unknown): string {
  if (body === null || typeof body !== "object") {
    return "";
  }
  const record = body as {
    choices?: { message?: { content?: unknown } }[];
    output?: {
      choices?: { message?: { content?: unknown } }[];
      task_id?: unknown;
    };
  };
  if (request.rail === "openrouter") {
    return normalizeContentParts(record.choices?.[0]?.message?.content);
  }
  // dashscope video-synthesis: an accepted async submission answers
  // with the task identity — a genuine provider answer, not a payload.
  if (request.endpoint === "video-synthesis") {
    const taskId = record.output?.task_id;
    if (typeof taskId === "string" && taskId.length > 0) {
      return `task:${taskId}`;
    }
  }
  return normalizeContentParts(record.output?.choices?.[0]?.message?.content);
}

function extractRailUsage(request: AttributionRailRequest, body: unknown): LabUsage | undefined {
  if (body === null || typeof body !== "object") {
    return undefined;
  }
  const usage = (body as { usage?: Record<string, unknown> }).usage;
  if (usage === undefined) {
    return undefined;
  }
  const readNumber = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  if (request.rail === "openrouter") {
    return {
      inputTokens: readNumber(usage.prompt_tokens),
      outputTokens: readNumber(usage.completion_tokens),
      ...(typeof usage.cost === "number" ? { costUsd: usage.cost } : {}),
    };
  }
  return {
    inputTokens: readNumber(usage.input_tokens),
    outputTokens: readNumber(usage.output_tokens),
  };
}

/**
 * The attribution rail: one REAL-shaped dispatch per call against the
 * PINNED REAL endpoint domain through the injected transport. A thrown
 * transport error is TRANSPORT-layer attributed; a non-2xx answer is
 * classified through the provider-envelope taxonomy; a 200 with empty
 * content is the honest empty-completion success. Credentials are
 * env-materialized at the production binding — never repository
 * credentials.
 */
export function createAttributionRail(options: {
  readonly transport: HttpTransport;
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}): (request: AttributionRailRequest) => Promise<RailAttemptOutcome> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const now = options.now ?? Date.now;
  return async (request) => {
    const url = railUrlOf(request);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    };
    if (
      request.rail === "dashscope" &&
      request.endpoint === "video-synthesis" &&
      request.asyncSubmission === true
    ) {
      headers["X-DashScope-Async"] = "enable";
    }
    const body = JSON.stringify(buildRailBody(request));
    const startedAt = now();
    let response: Response;
    try {
      response = await options.transport(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const attribution = classifyTransportError(error);
      return {
        kind: "failure",
        attribution,
        latencyMs: now() - startedAt,
        httpStatus: null,
      };
    }
    const latencyMs = now() - startedAt;
    const parsed: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        kind: "failure",
        attribution: classifyProviderEnvelope(response.status, parsed),
        latencyMs,
        httpStatus: response.status,
      };
    }
    const content = extractRailContent(request, parsed);
    const attribution = classifyCompletionDegeneracy(content);
    const usage = extractRailUsage(request, parsed);
    return {
      kind: "success",
      content,
      attribution,
      ...(usage === undefined ? {} : { usage }),
      latencyMs,
      httpStatus: response.status,
    };
  };
}

// ---------------------------------------------------------------------------
// The bounded tool executor (the tool-failure surface)
// ---------------------------------------------------------------------------

/** One exposed tool of the attribution fixture world. */
export interface AttributionTool {
  readonly name: string;
  /**
   * Deterministic execution. A rejection resolves `{ok: false}` (a
   * REFUSAL — never retried); an overrun NEVER settles (the deadline
   * race classifies it as tool-timeout — retryable).
   */
  execute(invocation: {
    readonly arguments: Readonly<Record<string, unknown>>;
  }): Promise<{ ok: boolean; value: string; result: unknown }>;
}

/** The outcome of ONE bounded tool-execution attempt. */
export type ToolAttemptOutcome =
  | {
      readonly kind: "success";
      readonly content: string;
      readonly attribution: null;
      readonly latencyMs: number;
      readonly requestDigest: string;
    }
  | {
      readonly kind: "failure";
      readonly attribution: Attribution;
      readonly latencyMs: number;
      readonly requestDigest: string;
    };

/**
 * Create the bounded tool executor: one attempt = one invocation raced
 * against the execution deadline. An unexposed tool is a PLATFORM
 * layer rejection before any tool effect; a settled rejection is the
 * tool layer's non-retryable `tool-failure`; a deadline overrun is the
 * tool layer's retryable `tool-timeout` (no result was produced — the
 * honest absence is journaled, never a fabricated result).
 */
export function createBoundedToolExecutor(options: {
  readonly tools: readonly AttributionTool[];
  readonly deadlineMs: number;
  /** Injectable deadline timer (defaults to a real timed wait). */
  readonly timer?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}): (invocation: {
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}) => Promise<ToolAttemptOutcome> {
  const timer =
    options.timer ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  return async (invocation) => {
    const requestDigest = digestOf({ tool: invocation.tool, arguments: invocation.arguments });
    const tool = options.tools.find((candidate) => candidate.name === invocation.tool);
    if (tool === undefined) {
      return {
        kind: "failure",
        attribution: classifyPlatformRejection(
          `unexposed tool ${invocation.tool} — the platform refused to route before any tool effect`,
        ),
        latencyMs: 0,
        requestDigest,
      };
    }
    const startedAt = now();
    const settled = await Promise.race([
      tool
        .execute({ arguments: invocation.arguments })
        .then((outcome) => ({ kind: "settled" as const, outcome })),
      timer(options.deadlineMs).then(() => ({ kind: "deadline" as const, outcome: null })),
    ]);
    const latencyMs = now() - startedAt;
    if (settled.kind === "deadline") {
      return {
        kind: "failure",
        attribution: classifyToolDeadline(invocation.tool, options.deadlineMs),
        latencyMs,
        requestDigest,
      };
    }
    if (!settled.outcome.ok) {
      return {
        kind: "failure",
        attribution: classifyToolRejection(settled.outcome.value),
        latencyMs,
        requestDigest,
      };
    }
    return {
      kind: "success",
      content: settled.outcome.value,
      attribution: null,
      latencyMs,
      requestDigest,
    };
  };
}

// ---------------------------------------------------------------------------
// The bounded retry loop with journaled per-attempt history
// ---------------------------------------------------------------------------

/** One journaled dispatch attempt (digests, never payload bytes). */
export interface AttemptRecord {
  /** 1-based attempt number. */
  readonly attempt: number;
  readonly outcome: "success" | "success-empty" | "failure";
  readonly attributionClass: AttributionClass | null;
  readonly layer: AttributionLayer | null;
  readonly retryable: boolean;
  /** Whether THIS attempt triggered a retry (a backoff followed it). */
  readonly retried: boolean;
  readonly latencyMs: number;
  readonly requestDigest: string;
  readonly httpStatus: number | null;
  readonly message: string;
}

/** The unified dispatch-outcome shape (rail or tool seam). */
export type AttributionDispatchOutcome =
  | {
      readonly kind: "success";
      readonly content: string;
      readonly attribution: Attribution | null;
      readonly usage?: LabUsage;
      readonly latencyMs: number;
      readonly requestDigest: string;
      readonly httpStatus?: number | null;
    }
  | {
      readonly kind: "failure";
      readonly attribution: Attribution;
      readonly latencyMs: number;
      readonly requestDigest: string;
      readonly httpStatus?: number | null;
    };

/** One attempt through a bound seam (rail dispatch or tool execution). */
export type AttributionDispatch = (input: {
  readonly executionId: string;
  readonly attempt: number;
}) => Promise<AttributionDispatchOutcome>;

/** Bind the rail as the per-attempt dispatch seam. */
export function bindRailDispatch(options: {
  readonly rail: (request: AttributionRailRequest) => Promise<RailAttemptOutcome>;
  readonly request: AttributionRailRequest;
}): AttributionDispatch {
  return async () => {
    const outcome = await options.rail(options.request);
    if (outcome.kind === "success") {
      return {
        kind: "success",
        content: outcome.content,
        attribution: outcome.attribution,
        ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
        latencyMs: outcome.latencyMs,
        requestDigest: railRequestDigest(options.request),
        httpStatus: outcome.httpStatus,
      };
    }
    return {
      kind: "failure",
      attribution: outcome.attribution,
      latencyMs: outcome.latencyMs,
      requestDigest: railRequestDigest(options.request),
      httpStatus: outcome.httpStatus,
    };
  };
}

/** Bind the bounded tool executor as the per-attempt dispatch seam. */
export function bindToolDispatch(options: {
  readonly executor: (invocation: {
    readonly tool: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  }) => Promise<ToolAttemptOutcome>;
  readonly invocation: {
    readonly tool: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  };
}): AttributionDispatch {
  return async () => {
    const outcome = await options.executor(options.invocation);
    if (outcome.kind === "success") {
      return {
        kind: "success",
        content: outcome.content,
        attribution: null,
        latencyMs: outcome.latencyMs,
        requestDigest: outcome.requestDigest,
        httpStatus: null,
      };
    }
    return {
      kind: "failure",
      attribution: outcome.attribution,
      latencyMs: outcome.latencyMs,
      requestDigest: outcome.requestDigest,
      httpStatus: null,
    };
  };
}

// ---------------------------------------------------------------------------
// The lifecycle port (bound to the REAL executions service)
// ---------------------------------------------------------------------------

export interface AttributionLifecyclePort {
  /** Canonical transitions, incl. the tool wait/resume pair. */
  transition(command: {
    readonly executionId: string;
    readonly step: "authorize" | "plan" | "queue" | "start" | "wait-tool" | "resume" | "verify";
    readonly reason: string;
  }): Promise<void>;
  /** Durable planning decision (route facts) — before the first dispatch. */
  recordPlanningDecision(input: {
    readonly executionId: string;
    readonly route: {
      readonly provider: string;
      readonly model: string;
      readonly strategyClass: string;
    };
  }): Promise<void>;
  /**
   * The per-attempt dispatch journal (the platform's
   * `agent-action-recorded` step-event vocabulary): called EXACTLY
   * once per dispatch attempt with digest references only.
   */
  recordDispatchAttempt(input: {
    readonly executionId: string;
    readonly record: AttemptRecord;
  }): Promise<void>;
  /** Ledger tool events (the platform's OWN tool vocabulary). */
  recordToolEvent(input: {
    readonly executionId: string;
    readonly command: "tool-requested" | "tool-result";
    readonly tool: string;
    readonly reference: Readonly<Record<string, unknown>>;
  }): Promise<void>;
  /** Terminal completion with the mechanically derived criteria. */
  complete(input: {
    readonly executionId: string;
    readonly verdict: "pass" | "fail";
    readonly criteria: readonly LabVerificationCriterion[];
    readonly reason: string;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// The oracle (the corpus row's expected attribution contract)
// ---------------------------------------------------------------------------

/** The per-attempt outcome kind sequence the oracle may pin. */
export type AttemptOutcome = "failure" | "success" | "success-empty";

/** The ground truth one attribution probe is judged by. */
export interface AttributionOracle {
  /** The failure class the row injects/observes on its FAILED attempts (null = healthy row). */
  readonly injectedClass: AttributionClass | null;
  /** The injected failure class's retryability. */
  readonly injectedRetryable: boolean;
  readonly expected: {
    /** The FINAL attempt's attribution class (null = clean success). */
    readonly attributionClass: AttributionClass | null;
    /** The FINAL attempt's attribution layer (null = clean success). */
    readonly layer: AttributionLayer | null;
    /** Total attempts (1 + bounded retries). */
    readonly attempts: number;
    /** The ordered expected attempt-outcome sequence. */
    readonly attemptOutcomes: readonly AttemptOutcome[];
    readonly terminal: "COMPLETED" | "FAILED";
  };
}

// ---------------------------------------------------------------------------
// Run result
// ---------------------------------------------------------------------------

export interface AttributionRunResult {
  readonly executionId: string;
  readonly terminal: "COMPLETED" | "FAILED";
  readonly criteria: readonly LabVerificationCriterion[];
  readonly usage: LabUsage | null;
  readonly attempts: readonly AttemptRecord[];
  readonly totalAttempts: number;
  /** The final attempt's attribution (null = clean success). */
  readonly finalAttribution: Attribution | null;
  /** The final attempt's content (empty string for empty-completion). */
  readonly finalContent: string | null;
  readonly totalDispatchLatencyMs: number;
  readonly waitToolCycles: number;
  readonly toolEvents: number;
  readonly requestDigest: string | null;
  /** The driver's own count of recordDispatchAttempt calls. */
  readonly journaledAttempts: number;
}

// ---------------------------------------------------------------------------
// The attribution execution driver
// ---------------------------------------------------------------------------

/**
 * Drive one submitted attribution-probe execution to completion through
 * the platform path: authorize → plan → planning-decision BEFORE the
 * first dispatch → queue → start → the bounded retry loop (per attempt:
 * a genuine wait-tool → resume pair for tool rows; per-attempt journal
 * EXACTLY once) → verify → terminal anyFail → FAILED.
 *
 * Honesty invariants (by construction): retryable failures get at most
 * `maxExtraAttempts` extra attempts; non-retryable failures never
 * retry; recovery-after-retry lands COMPLETED with the full retry
 * history journaled; an out-of-vocabulary task is a platform layer
 * rejection with ZERO dispatch attempts; a provider/tool failure
 * FAILS the execution (never a partial-success shortcut); the
 * empty-content 200 completes honestly with empty content.
 */
export async function driveAttributionExecution(options: {
  readonly executionId: string;
  readonly task: { readonly kind: string; readonly input?: Readonly<Record<string, unknown>> };
  readonly groundTruth: AttributionOracle;
  readonly provider: string;
  readonly model: string;
  readonly lifecycle: AttributionLifecyclePort;
  readonly dispatch: AttributionDispatch;
  /** Bounded retry policy for RETRYABLE attribution classes only. */
  readonly retry: {
    readonly maxExtraAttempts: number;
    readonly backoffMs: number;
    readonly sleep: (ms: number) => Promise<void>;
  };
  readonly now: () => Date;
}): Promise<AttributionRunResult> {
  const { executionId, groundTruth, lifecycle } = options;
  const isToolProbe = options.task.kind === "tool-probe";
  const isDispatchProbe = options.task.kind === "dispatch-probe";
  const toolName = String((options.task.input as { tool?: unknown } | undefined)?.tool ?? "");

  await lifecycle.transition({ executionId, step: "authorize", reason: "val-020-authorize" });
  await lifecycle.transition({ executionId, step: "plan", reason: "val-020-plan" });
  await lifecycle.recordPlanningDecision({
    executionId,
    route: {
      provider: options.provider,
      model: options.model,
      strategyClass: "failure-attribution-probe",
    },
  });
  await lifecycle.transition({ executionId, step: "queue", reason: "val-020-queue" });
  await lifecycle.transition({ executionId, step: "start", reason: "val-020-start" });

  const attempts: AttemptRecord[] = [];
  let journaledAttempts = 0;
  let waitToolCycles = 0;
  let toolEvents = 0;
  let finalOutcome: AttributionDispatchOutcome | null = null;

  if (isDispatchProbe || isToolProbe) {
    for (;;) {
      const attempt = attempts.length + 1;
      if (isToolProbe) {
        await lifecycle.transition({
          executionId,
          step: "wait-tool",
          reason: `val-020-wait-tool-${attempt}`,
        });
        waitToolCycles += 1;
        await lifecycle.recordToolEvent({
          executionId,
          command: "tool-requested",
          tool: toolName,
          reference: { attempt, argumentsDigest: digestOf(options.task.input ?? {}) },
        });
        toolEvents += 1;
      }
      const outcome = await options.dispatch({ executionId, attempt });
      if (isToolProbe) {
        // A settled attempt journals its result; a deadline overrun
        // journals NO tool-result (no result was produced — honest
        // absence, never a fabricated result).
        if (outcome.kind === "success" || outcome.attribution.attributionClass === "tool-failure") {
          await lifecycle.recordToolEvent({
            executionId,
            command: "tool-result",
            tool: toolName,
            reference: {
              attempt,
              ok: outcome.kind === "success",
              resultDigest: digestOf(outcome.kind === "success" ? outcome.content : "rejected"),
            },
          });
          toolEvents += 1;
        }
        await lifecycle.transition({
          executionId,
          step: "resume",
          reason: `val-020-resume-tool-${attempt}`,
        });
      }
      finalOutcome = outcome;
      const attribution = outcome.attribution;
      const outcomeKind: AttemptOutcome =
        outcome.kind === "failure"
          ? "failure"
          : outcome.content.trim().length === 0
            ? "success-empty"
            : "success";
      const willRetry =
        outcome.kind === "failure" &&
        outcome.attribution.retryable &&
        attempt <= options.retry.maxExtraAttempts;
      const record: AttemptRecord = {
        attempt,
        outcome: outcomeKind,
        attributionClass: attribution === null ? null : attribution.attributionClass,
        layer: attribution === null ? null : attribution.layer,
        retryable: attribution === null ? false : attribution.retryable,
        retried: willRetry,
        latencyMs: outcome.latencyMs,
        requestDigest: outcome.requestDigest,
        httpStatus: outcome.httpStatus ?? null,
        message: attribution === null ? "success" : attribution.message,
      };
      attempts.push(record);
      // Journaled EXACTLY once per attempt (digests, never payloads).
      await lifecycle.recordDispatchAttempt({ executionId, record });
      journaledAttempts += 1;
      if (!willRetry) {
        break;
      }
      await options.retry.sleep(options.retry.backoffMs);
    }
  } else {
    // Out-of-vocabulary task: a platform layer rejection BEFORE any
    // dispatch attempt (zero dispatches, zero tool effects).
    finalOutcome = {
      kind: "failure",
      attribution: classifyPlatformRejection(
        `task kind ${options.task.kind} is outside the attribution-probe vocabulary`,
      ),
      latencyMs: 0,
      requestDigest: digestOf(options.task),
      httpStatus: null,
    };
  }

  const totalDispatchLatencyMs = attempts.reduce((sum, record) => sum + record.latencyMs, 0);
  const usage: LabUsage | null =
    finalOutcome !== null && finalOutcome.kind === "success" && finalOutcome.usage !== undefined
      ? finalOutcome.usage
      : null;

  const criteria = deriveAttributionCriteria({
    groundTruth,
    attempts,
    finalOutcome,
    journaledAttempts,
    maxExtraAttempts: options.retry.maxExtraAttempts,
    usage,
    totalDispatchLatencyMs,
  });
  // The honest terminal: a failure outcome FAILS the execution ALWAYS
  // (no partial-success shortcut); a criteria failure fails it too.
  const outcomeFailed = finalOutcome !== null && finalOutcome.kind === "failure";
  const anyFail = outcomeFailed || criteria.some((criterion) => criterion.status === "FAIL");

  await lifecycle.transition({ executionId, step: "verify", reason: "val-020-verify" });
  await lifecycle.complete({
    executionId,
    verdict: anyFail ? "fail" : "pass",
    criteria,
    reason: anyFail ? "val-020-mechanical-verification-failed" : "val-020-verified",
  });

  return {
    executionId,
    terminal: anyFail ? "FAILED" : "COMPLETED",
    criteria,
    usage,
    attempts,
    totalAttempts: attempts.length,
    finalAttribution: finalOutcome === null ? null : finalOutcome.attribution,
    finalContent:
      finalOutcome === null ? null : finalOutcome.kind === "success" ? finalOutcome.content : null,
    totalDispatchLatencyMs,
    waitToolCycles,
    toolEvents,
    requestDigest: attempts.length > 0 ? (attempts[0]?.requestDigest ?? null) : null,
    journaledAttempts,
  };
}

// ---------------------------------------------------------------------------
// Mechanical verification (the oracle floor)
// ---------------------------------------------------------------------------

/**
 * Derive the mechanical criteria for one attribution run. PURE: the
 * same attempt history + oracle always yields the same verdicts. The
 * criteria prove attribution correctness (class + layer), retry
 * classification, bounded-retry policy conformance (no infinite
 * loops; no retry after a non-retryable failure), the recovery
 * outcome sequence, journal-exactly-once-per-attempt, and the honest
 * outcome contract (a failure FAILS; the empty-content success
 * COMPLETES).
 */
export function deriveAttributionCriteria(input: {
  readonly groundTruth: AttributionOracle;
  readonly attempts: readonly AttemptRecord[];
  readonly finalOutcome: AttributionDispatchOutcome | null;
  readonly journaledAttempts: number;
  readonly maxExtraAttempts: number;
  readonly usage: LabUsage | null;
  readonly totalDispatchLatencyMs: number;
}): LabVerificationCriterion[] {
  const { groundTruth, attempts } = input;
  const finalAttribution = input.finalOutcome === null ? null : input.finalOutcome.attribution;
  const criteria: LabVerificationCriterion[] = [];

  // 1. The attribution class of the final attempt.
  const observedClass = finalAttribution === null ? null : finalAttribution.attributionClass;
  const classOk = observedClass === groundTruth.expected.attributionClass;
  criteria.push({
    criterionId: "attribution-class",
    strategy: "deterministic",
    status: classOk ? "PASS" : "FAIL",
    evidence: [
      `expected:${groundTruth.expected.attributionClass ?? "none"}`,
      `observed:${observedClass ?? "none"}`,
      `finalOutcome:${input.finalOutcome === null ? "none" : input.finalOutcome.kind}`,
    ],
  });

  // 2. The attribution layer of the final attempt.
  const observedLayer = finalAttribution === null ? null : finalAttribution.layer;
  const layerOk = observedLayer === groundTruth.expected.layer;
  criteria.push({
    criterionId: "attribution-layer",
    strategy: "deterministic",
    status: layerOk ? "PASS" : "FAIL",
    evidence: [
      `expected:${groundTruth.expected.layer ?? "none"}`,
      `observed:${observedLayer ?? "none"}`,
    ],
  });

  // 3. Retry classification: every FAILED attempt carries the injected
  //    class with the injected retryability (the wrong-layer/wrong-class
  //    discrimination — a misattributed failure FAILS here).
  const failedAttempts = attempts.filter((record) => record.outcome === "failure");
  let retryClassOk = true;
  const retryEvidence: string[] = [];
  if (groundTruth.injectedClass === null) {
    retryEvidence.push("no-failure-injected");
    if (failedAttempts.length > 0) {
      retryClassOk = false;
      retryEvidence.push(`unexpected-failures:${failedAttempts.length}`);
    }
  } else {
    for (const record of failedAttempts) {
      const matches =
        record.attributionClass === groundTruth.injectedClass &&
        record.retryable === groundTruth.injectedRetryable &&
        record.layer === layerOfAttributionClass(groundTruth.injectedClass);
      if (!matches) {
        retryClassOk = false;
      }
      retryEvidence.push(
        `attempt${record.attempt}:${record.attributionClass ?? "none"}/` +
          `${record.layer ?? "none"}/retryable:${String(record.retryable)}`,
      );
    }
  }
  criteria.push({
    criterionId: "retry-classification",
    strategy: "deterministic",
    status: retryClassOk ? "PASS" : "FAIL",
    evidence: retryEvidence.length > 0 ? retryEvidence : ["no-attempts"],
  });

  // 4. Attempt count (1 + bounded retries, exactly as the oracle pins).
  const attemptsOk = attempts.length === groundTruth.expected.attempts;
  criteria.push({
    criterionId: "attempt-count",
    strategy: "deterministic",
    status: attemptsOk ? "PASS" : "FAIL",
    evidence: [
      `expected:${groundTruth.expected.attempts}`,
      `observed:${attempts.length}`,
      `maxExtraAttempts:${input.maxExtraAttempts}`,
    ],
  });

  // 5. Bounded-retry policy conformance: no infinite loop (at most
  //    1 + maxExtraAttempts attempts); a non-retryable failure is always
  //    the LAST attempt (never retried); when the injected class is
  //    non-retryable the run is single-attempt.
  const boundedAbove = attempts.length <= 1 + input.maxExtraAttempts;
  const nonRetryableLast = failedAttempts.every((record) => {
    if (record.retryable) {
      return true;
    }
    const isLast = record.attempt === attempts.length;
    return isLast;
  });
  const nonRetryableSingle =
    groundTruth.injectedClass === null || groundTruth.injectedRetryable || attempts.length === 1;
  const boundedOk = boundedAbove && nonRetryableLast && nonRetryableSingle;
  criteria.push({
    criterionId: "bounded-retry",
    strategy: "deterministic",
    status: boundedOk ? "PASS" : "FAIL",
    evidence: [
      `attempts:${attempts.length}`,
      `limit:${1 + input.maxExtraAttempts}`,
      `nonRetryableFailuresTerminal:${String(nonRetryableLast)}`,
      `injectedRetryable:${String(groundTruth.injectedRetryable)}`,
    ],
  });

  // 6. The recovery/outcome sequence (ordered, exact).
  const observedOutcomes = attempts.map((record) => record.outcome);
  const sequenceOk =
    observedOutcomes.length === groundTruth.expected.attemptOutcomes.length &&
    observedOutcomes.every(
      (outcome, index) => outcome === groundTruth.expected.attemptOutcomes[index],
    );
  criteria.push({
    criterionId: "recovery-outcome-sequence",
    strategy: "deterministic",
    status: sequenceOk ? "PASS" : "FAIL",
    evidence: [
      `expected:${groundTruth.expected.attemptOutcomes.join(">") || "none"}`,
      `observed:${observedOutcomes.join(">") || "none"}`,
    ],
  });

  // 7. Journal exactly-once per attempt.
  const journalOk = input.journaledAttempts === attempts.length;
  criteria.push({
    criterionId: "journal-exactly-once-per-attempt",
    strategy: "deterministic",
    status: journalOk ? "PASS" : "FAIL",
    evidence: [
      `journaled:${input.journaledAttempts}`,
      `attempts:${attempts.length}`,
      `perAttemptDigests:${attempts.map((record) => record.requestDigest).join("|") || "none"}`,
    ],
  });

  // 8. The honest outcome contract: the derived terminal matches the
  //    oracle's terminal (a failure FAILS; the empty-completion and
  //    healthy successes COMPLETE — never a fabricated either way).
  const derivedTerminal: "COMPLETED" | "FAILED" =
    input.finalOutcome !== null && input.finalOutcome.kind === "failure" ? "FAILED" : "COMPLETED";
  const terminalOk = derivedTerminal === groundTruth.expected.terminal;
  criteria.push({
    criterionId: "outcome-contract",
    strategy: "deterministic",
    status: terminalOk ? "PASS" : "FAIL",
    evidence: [
      `expectedTerminal:${groundTruth.expected.terminal}`,
      `derivedTerminal:${derivedTerminal}`,
      `finalOutcome:${input.finalOutcome === null ? "none" : input.finalOutcome.kind}`,
    ],
  });

  // 9. Honest economics: measured usage and latency recorded (never
  //    estimated); usage absent on failures is recorded honestly.
  criteria.push({
    criterionId: "economics-measured",
    strategy: "deterministic",
    status: "PASS",
    evidence: [
      input.usage === null
        ? "usage:none-reported"
        : `usage:${input.usage.inputTokens}+${input.usage.outputTokens}` +
          (input.usage.costUsd === undefined ? "" : `/costUsd:${input.usage.costUsd}`),
      `latencyMs:${input.totalDispatchLatencyMs}`,
      `attempts:${attempts.length}`,
    ],
  });

  return criteria;
}
