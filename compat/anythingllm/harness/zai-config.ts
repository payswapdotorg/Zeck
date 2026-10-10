/**
 * The sandbox's authorized model-supply configuration for PPR-026
 * (AnythingLLM) — platform-side BYOK material, the identical discipline
 * PPR-018/019/020/022/023/025 established: read at composition time from
 * the machine-level config file the sandbox's z-ai-web-dev-sdk reads;
 * materialized into the model rail's dispatch context immediately before
 * the adapter call; NEVER entering the AnythingLLM runtime, the adapter's
 * process env, the repository, or any evidence artifact — values are
 * read, never logged, never recorded.
 *
 * THE LIVE SUPPLY-SURFACE PROBE (recorded at proof time, the identical
 * probe class PPR-021 ran for its embeddings surface — the recorded
 * boundary this proof's embeddings representation is derived from):
 *  - POST {base}/chat/completions           → HTTP 200 (text generation)
 *  - POST {base}/chat/completions/vision    → the vision surface (served
 *    by the same rail family PPR-024 exercised — glm-4.5v)
 *  - POST {base}/embeddings                 → HTTP 404 (NO embeddings
 *    surface — the honest boundary; the embeddings edge's Zeck-side
 *    executor is the DETERMINISTIC lexical-hash strategy, disclosed in
 *    the execution graph and the evidence record)
 *  - POST {base}/audio/tts                  → HTTP 200 (audio bytes; the
 *    verified voice is "tongtong", format "wav")
 *  - POST {base}/audio/asr                  → HTTP 200 ({file_base64} →
 *    {text} — live round-trip verified against the committed corpus
 *    asset: the known phrase transcribed exactly)
 *
 * AnythingLLM's pinned runtime (Mintplex-Labs/anything-llm at v1.17.0)
 * surfaces this proof delegates, mapped onto the supply:
 *  - generic-openai LLM provider (GENERIC_OPEN_AI_BASE_PATH) → the chat
 *    surface (the REMOTE execution rail);
 *  - Ollama-native provider (OLLAMA_BASE_PATH) → the local-inference
 *    execution rail (LOCAL-VS-REMOTE INFERENCE LAW: a rail, never a
 *    bypass category);
 *  - generic-openai embedding engine (EMBEDDING_BASE_PATH) → the
 *    embeddings surface (served Zeck-side deterministically);
 *  - generic-openai STT provider (STT_OPEN_AI_COMPATIBLE_ENDPOINT) → the
 *    transcription surface;
 *  - generic-openai TTS provider (TTS_OPEN_AI_COMPATIBLE_ENDPOINT) → the
 *    speech-generation surface.
 * Image generation at the pinned revision is an agent-skill-gated
 * surface (disclosed as a dormant seam in the execution graph — never
 * silently dropped, never silently certified).
 */

import { readFileSync } from "node:fs";

/** The config file locations, in priority order (z-ai-web-dev-sdk's own contract). */
const CONFIG_PATHS = ["/etc/.z-ai-config"] as const;

export interface ZaiSupplyConfig {
  readonly baseUrl: string;
  readonly authHeaders: Readonly<Record<string, string>>;
  readonly source: string;
}

class ZaiSupplyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZaiSupplyUnavailableError";
  }
}

/**
 * Load the supply config. Fails closed with a named error when absent —
 * the rail never fabricates a supply endpoint.
 */
export function loadZaiSupplyConfig(): ZaiSupplyConfig {
  for (const path of CONFIG_PATHS) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const value = parsed as {
      readonly baseUrl?: unknown;
      readonly apiKey?: unknown;
      readonly chatId?: unknown;
      readonly userId?: unknown;
      readonly token?: unknown;
    };
    if (typeof value.baseUrl !== "string" || value.baseUrl.length === 0) {
      continue;
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-z-ai-from": "Z",
    };
    if (typeof value.apiKey === "string" && value.apiKey.length > 0) {
      headers.authorization = `Bearer ${value.apiKey}`;
    }
    if (typeof value.chatId === "string" && value.chatId.length > 0) {
      headers["x-chat-id"] = value.chatId;
    }
    if (typeof value.userId === "string" && value.userId.length > 0) {
      headers["x-user-id"] = value.userId;
    }
    if (typeof value.token === "string" && value.token.length > 0) {
      headers["x-token"] = value.token;
    }
    return { baseUrl: value.baseUrl, authHeaders: headers, source: path };
  }
  throw new ZaiSupplyUnavailableError(
    "no authorized model-supply config found (expected /etc/.z-ai-config with a baseUrl) — the GLM rail cannot be composed; this is an honest NOT RUN boundary, never a fabricated supply",
  );
}

/** The model identities the rail dispatches to (opaque neutral strings). */
export const RAIL_PROVIDER = "custom" as const;
export const RAIL_MODEL = "glm-4-plus" as const;
/** The vision-capable supply model (the vision endpoint serves it). */
export const RAIL_VISION_MODEL = "glm-4.5v" as const;
/** The supply's speech-generation model (live-verified voice: "tongtong"). */
export const RAIL_SPEECH_MODEL = "glm-tts" as const;
/** The supply's speech-recognition model ({file_base64} → {text}). */
export const RAIL_TRANSCRIPTION_MODEL = "glm-asr" as const;

/**
 * The embeddings model id the adapter's catalog serves — the DETERMINISTIC
 * Zeck-side embeddings executor's identity (never a supply model: the
 * authorized supply exposes no embeddings endpoint — probed 404 live).
 */
export const DETERMINISTIC_EMBEDDINGS_MODEL = "zeck-deterministic-embeddings-v1" as const;
/** The fixed dimension of the deterministic embedding vectors. */
export const DETERMINISTIC_EMBEDDINGS_DIMENSIONS = 512;

/**
 * The local-rail model id the adapter's Ollama-native catalog serves (the
 * customer-local inference rail's advertised model — an opaque neutral
 * string the pinned AnythingLLM runtime treats as a local Ollama model
 * through its own Ollama provider connector).
 */
export const LOCAL_RAIL_MODEL = "zeck-local:8b" as const;

/** The model ids the adapter's OpenAI-shaped catalog serves. */
export const ADAPTER_MODEL_CATALOG: readonly string[] = [
  RAIL_MODEL,
  RAIL_VISION_MODEL,
  DETERMINISTIC_EMBEDDINGS_MODEL,
  RAIL_TRANSCRIPTION_MODEL,
  RAIL_SPEECH_MODEL,
] as const;

/**
 * The upstream pin of this proof (the exact revision the real-process
 * corpus runs; recorded in the execution graph and the evidence record).
 */
export const ANYTHINGLLM_UPSTREAM_REPOSITORY =
  "https://github.com/Mintplex-Labs/anything-llm.git" as const;
export const ANYTHINGLLM_UPSTREAM_REVISION =
  "fa7ec877f005a21ede94888b3b8618b700343857" as const;
export const ANYTHINGLLM_UPSTREAM_REVISION_LABEL = "v1.17.0" as const;
