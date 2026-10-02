/**
 * The sandbox's authorized model-supply configuration for PPR-022
 * (Hermes-Agent) — platform-side BYOK material, the identical discipline
 * PPR-018/019/020 established: read at composition time from the
 * machine-level config file the sandbox's z-ai-web-dev-sdk reads;
 * materialized into the model rail's dispatch context immediately before
 * the adapter call; NEVER entering the Hermes runtime, the adapter's
 * process env, the repository, or any evidence artifact — values are read,
 * never logged, never recorded.
 *
 * The supply serves every surface this proof's multi-surface corpus
 * delegates: OpenAI-compatible chat completions (text), its vision
 * endpoint (image-understanding turns), /audio/tts (speech generation),
 * /audio/asr (speech recognition) and /images/generations (image
 * generation) — all live-verified at battery-composition time.
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
/** The supply's speech model identity (opaque neutral string). */
export const RAIL_SPEECH_MODEL = "glm-tts" as const;
/** The supply's transcription model identity (opaque neutral string). */
export const RAIL_TRANSCRIPTION_MODEL = "glm-asr" as const;
/** The supply's image model identity (opaque neutral string). */
export const RAIL_IMAGE_MODEL = "glm-image" as const;
