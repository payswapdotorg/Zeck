/**
 * The PPR-026 baseline arms — the two mandated NON-ZECK comparison stacks
 * (the direct baseline and the strong-optimized baseline) captured over
 * the SAME corpus with the SAME mechanical checks (the harness's
 * captureBaseline + the labeling law: baseline records are structurally
 * NOT Zeck evidence; the only bridge is the labeled ComparisonFact).
 *
 * THE BASELINE STACKS (the sandbox's honest provider boundary — the
 * identical boundary class PPR-022/023/024/025 recorded):
 *
 *  - DIRECT arm: the pinned AnythingLLM runtime configured DIRECTLY at
 *    the sandbox's single authorized provider endpoint (the GLM supply),
 *    the app's own documented generic-openai connection axes, stock
 *    settings, NO Zeck adapter in the path. The baseline app processes
 *    carry the supply credential as their provider key (the non-Zeck
 *    stack by definition — the certified path never does; disclosed in
 *    the baseline record).
 *
 *  - OPTIMIZED arm: the strong-optimized non-Zeck configuration — every
 *    app-OWNED optimization axis tuned (the generic-openai connector's
 *    documented custom-headers axis carrying the supply's required
 *    platform-session headers, the supply's native model id, the tuned
 *    token limits), still NO Zeck and NO new infrastructure (the
 *    operator has only this supply and the app's own configuration
 *    surface — no glue proxies, no code changes).
 *
 * THE HONEST EXPECTATION (recorded, never softened): the supply serves
 * chat completions on the app's wire shape (with the required
 * platform-session headers — a plain Bearer-only generic-openai client
 * receives 401/403, the identical machine-level boundary PPR-025
 * recorded live), but exposes NO embeddings endpoint (404 — probed
 * live), NO /audio/transcriptions or /audio/speech paths (its audio
 * surfaces are /audio/asr and /audio/tts on different wire shapes), and
 * speaks NO Ollama-native protocol — so the embeddings/RAG, STT, TTS and
 * local-rail corpus tasks FAIL HONESTLY on both non-Zeck arms (and the
 * chat tasks fail on the direct arm for want of the session headers).
 * That is the exact multi-surface provider fragmentation the target
 * matrix names for AnythingLLM, measured as baseline facts (never as
 * Zeck evidence).
 */

import { readFileSync } from "node:fs";
import {
  appClientOf,
  awaitAppPing,
  awaitCollectorReady,
  bootAnythingLlmApp,
  driveCorpusTasksAgainstClient,
  generateApiKey,
  ANYTHINGLLM_STORAGE_DIR,
  type TaskTelemetry,
} from "./corpus-runner";
import { CORPUS_TASKS, type CorpusTask } from "../corpus/tasks";
import { buildScrubbedRuntimeEnvironment } from "../../harness/credential-erasure";

/** The authorized supply's connection material (read at run time, never committed). */
interface SupplyEndpoint {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** The supply's platform-session headers (recorded live: a plain Bearer-only OpenAI client receives 401/403 — the machine-level endpoint requires them). */
  readonly sessionHeaders: Readonly<Record<string, string>>;
}

function loadSupplyEndpoint(): SupplyEndpoint {
  const parsed = JSON.parse(readFileSync("/etc/.z-ai-config", "utf8")) as {
    readonly baseUrl?: unknown;
    readonly apiKey?: unknown;
    readonly chatId?: unknown;
    readonly userId?: unknown;
    readonly token?: unknown;
  };
  if (typeof parsed.baseUrl !== "string" || parsed.baseUrl.length === 0) {
    throw new Error("no authorized supply endpoint found for the baseline arms (expected /etc/.z-ai-config)");
  }
  const sessionHeaders: Record<string, string> = { "x-z-ai-from": "Z" };
  if (typeof parsed.chatId === "string" && parsed.chatId.length > 0) {
    sessionHeaders["x-chat-id"] = parsed.chatId;
  }
  if (typeof parsed.userId === "string" && parsed.userId.length > 0) {
    sessionHeaders["x-user-id"] = parsed.userId;
  }
  if (typeof parsed.token === "string" && parsed.token.length > 0) {
    sessionHeaders["x-token"] = parsed.token;
  }
  return {
    baseUrl: parsed.baseUrl.replace(/\/+$/, ""),
    apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
    sessionHeaders,
  };
}

/** The baseline arms' env extras (the app's own axes; the supply key rides the app's connection axes — the non-Zeck stack by definition). */
const BASELINE_EXTRAS: readonly string[] = [
  "NODE_ENV",
  "SERVER_PORT",
  "STORAGE_DIR",
  "COLLECTOR_PORT",
  "CHECKPOINT_DISABLE",
  "CI",
  "DISABLE_TELEMETRY",
  "DISABLE_SWAGGER_DOCS",
  "PROVIDER_DISABLE_NATIVE_TOOL_CALLING",
  "AGENT_SKILL_RERANKER_ENABLED",
  "LLM_PROVIDER",
  "GENERIC_OPEN_AI_BASE_PATH",
  "GENERIC_OPEN_AI_MODEL_PREF",
  "GENERIC_OPEN_AI_MODEL_TOKEN_LIMIT",
  "GENERIC_OPEN_AI_MAX_TOKENS",
  "GENERIC_OPEN_AI_API_KEY",
  "GENERIC_OPEN_AI_CUSTOM_HEADERS",
  "OLLAMA_BASE_PATH",
  "OLLAMA_MODEL_PREF",
  "EMBEDDING_ENGINE",
  "EMBEDDING_BASE_PATH",
  "EMBEDDING_MODEL_PREF",
  "GENERIC_OPEN_AI_EMBEDDING_API_KEY",
  "STT_PROVIDER",
  "STT_OPEN_AI_COMPATIBLE_ENDPOINT",
  "STT_OPEN_AI_COMPATIBLE_MODEL",
  "STT_OPEN_AI_COMPATIBLE_KEY",
  "TTS_PROVIDER",
  "TTS_OPEN_AI_COMPATIBLE_ENDPOINT",
  "TTS_OPEN_AI_COMPATIBLE_MODEL",
  "TTS_OPEN_AI_COMPATIBLE_VOICE_MODEL",
  "TTS_OPEN_AI_COMPATIBLE_KEY",
  "VECTOR_DB",
] as const;

/** Build one baseline arm's environment (direct egress — no proof proxy; the non-Zeck stack). */
export function buildBaselineEnvironment(options: {
  readonly kind: "direct" | "optimized";
  readonly supply: SupplyEndpoint;
  readonly appPort: number;
  readonly collectorPort: number;
}): Readonly<Record<string, string>> {
  const supplyV1 = `${options.supply.baseUrl}`;
  const optimized = options.kind === "optimized";
  // The strong-optimized arm's custom-headers axis — the app's OWN
  // documented generic-openai connector axis (GENERIC_OPEN_AI_CUSTOM
  // _HEADERS, CSV "Key:Value" pairs) an operator uses when the provider
  // requires platform-session headers beyond the Bearer key (recorded
  // live: a plain Bearer-only client receives 401/403 — the machine-level
  // endpoint requires x-z-ai-from/x-chat-id/x-user-id/x-token). That is
  // the honest stock boundary the optimized arm works around with the
  // app's own configuration surface — still no Zeck and no new
  // infrastructure.
  const sessionHeaderCsv = Object.entries(options.supply.sessionHeaders)
    .map(([key, value]) => `${key}:${value}`)
    .join(",");
  return buildScrubbedRuntimeEnvironment({
    applicationExtras: [...BASELINE_EXTRAS],
    source: process.env,
    overrides: {
      NODE_ENV: "production",
      SERVER_PORT: String(options.appPort),
      STORAGE_DIR: ANYTHINGLLM_STORAGE_DIR,
      COLLECTOR_PORT: String(options.collectorPort),
      CHECKPOINT_DISABLE: "1",
      CI: "true",
      DISABLE_TELEMETRY: "true",
      DISABLE_SWAGGER_DOCS: "true",
      PROVIDER_DISABLE_NATIVE_TOOL_CALLING: "generic-openai",
      AGENT_SKILL_RERANKER_ENABLED: "false",
      // The remote chat rail (generic-openai) → the supply DIRECTLY (no Zeck):
      LLM_PROVIDER: "generic-openai",
      GENERIC_OPEN_AI_BASE_PATH: supplyV1,
      GENERIC_OPEN_AI_MODEL_PREF: "glm-4-plus",
      GENERIC_OPEN_AI_MODEL_TOKEN_LIMIT: optimized ? "8192" : "4096",
      GENERIC_OPEN_AI_API_KEY: options.supply.apiKey,
      ...(optimized ? { GENERIC_OPEN_AI_CUSTOM_HEADERS: sessionHeaderCsv } : {}),
      // The local-inference rail → the supply (which speaks no Ollama
      // protocol — the honest baseline failure):
      OLLAMA_BASE_PATH: options.supply.baseUrl,
      OLLAMA_MODEL_PREF: "glm-4-plus",
      // The RAG embedding engine → the supply (which serves no
      // embeddings endpoint — the honest baseline failure):
      EMBEDDING_ENGINE: "generic-openai",
      EMBEDDING_BASE_PATH: supplyV1,
      EMBEDDING_MODEL_PREF: "text-embedding-small",
      GENERIC_OPEN_AI_EMBEDDING_API_KEY: options.supply.apiKey,
      // The STT/TTS providers → the supply's OpenAI-shaped paths (which
      // do not exist there — the honest baseline failures):
      STT_PROVIDER: "generic-openai",
      STT_OPEN_AI_COMPATIBLE_ENDPOINT: supplyV1,
      STT_OPEN_AI_COMPATIBLE_MODEL: "whisper-1",
      STT_OPEN_AI_COMPATIBLE_KEY: options.supply.apiKey,
      TTS_PROVIDER: "generic-openai",
      TTS_OPEN_AI_COMPATIBLE_ENDPOINT: supplyV1,
      TTS_OPEN_AI_COMPATIBLE_MODEL: "tts-1",
      TTS_OPEN_AI_COMPATIBLE_VOICE_MODEL: "alloy",
      TTS_OPEN_AI_COMPATIBLE_KEY: options.supply.apiKey,
      // The app's default vector store:
      VECTOR_DB: "lancedb",
    },
  });
}

export interface BaselineRunFacts {
  readonly kind: "direct-baseline" | "optimized-baseline";
  readonly stack: string;
  readonly methodology: string;
  readonly taskRuns: readonly {
    readonly taskId: string;
    readonly succeeded: boolean | null;
    readonly detail: string;
    readonly durationMs: number;
    readonly costMicroUsd: string | null;
    readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
  }[];
  readonly recordedAt: string;
}

/**
 * Run ONE baseline arm: boot the pinned runtime pair with the arm's
 * environment (direct provider egress, no Zeck, no proof proxy), drive
 * the SAME corpus with the SAME mechanical checks, and record the honest
 * per-task results. The app processes are ALWAYS stopped in finally.
 */
export async function runBaselineArm(options: {
  readonly kind: "direct" | "optimized";
  readonly workspaceRoot: string;
  readonly appPort: number;
  readonly collectorPort: number;
  readonly telemetry: TaskTelemetry;
  readonly tasks?: readonly CorpusTask[];
  readonly now: () => string;
}): Promise<BaselineRunFacts> {
  const supply = loadSupplyEndpoint();
  // A fresh app instance per arm invocation: the boot resets the app's
  // own storage (fresh DB + vector store — the same fresh-instance
  // discipline the certified run uses; reusing storage would silently
  // run the arm on stale workspaces/documents).
  const env = buildBaselineEnvironment({
    kind: options.kind,
    supply,
    appPort: options.appPort,
    collectorPort: options.collectorPort,
  });
  const booted = await bootAnythingLlmApp({
    env,
    appPort: options.appPort,
    collectorPort: options.collectorPort,
  });
  try {
    await awaitAppPing(booted.appBaseUrl, 120_000);
    await awaitCollectorReady(booted.collectorBaseUrl, 60_000);
    const apiKey = await generateApiKey(booted.appBaseUrl, 60_000);
    const client = appClientOf(booted.appBaseUrl, apiKey);
    const outcomes = await driveCorpusTasksAgainstClient(
      booted.appBaseUrl,
      client,
      options.tasks ?? CORPUS_TASKS,
      options.telemetry,
    );
    return {
      kind: options.kind === "direct" ? "direct-baseline" : "optimized-baseline",
      stack:
        options.kind === "direct"
          ? "AnythingLLM v1.17.0 (pinned fa7ec877) stock configuration pointed DIRECTLY at the sandbox's authorized GLM supply endpoint (no Zeck; the app's own generic-openai connection axes; stock settings — a plain Bearer-only client receives 401/403 from the machine-level endpoint, the identical boundary PPR-025 recorded live)"
          : "AnythingLLM v1.17.0 (pinned fa7ec877) strong-optimized non-Zeck arm (the app's own optimization axes fully tuned: the generic-openai connector's documented custom-headers axis carrying the supply's required platform-session headers, the supply's native model id, tuned token limits — still no Zeck and no new infrastructure)",
      methodology:
        "the same six corpus tasks, the same mechanical verification, the same pinned runtime; the provider calls go directly from the application processes to the authorized supply endpoint (the non-Zeck stack); the arm differs from the certified path ONLY in the delegation (Zeck absent) — baseline facts, never Zeck evidence",
      taskRuns: outcomes.map((outcome) => ({
        taskId: outcome.taskId,
        succeeded: outcome.resolved,
        detail: outcome.checkOutput,
        durationMs: outcome.durationMs,
        // No provider prices are published for the supply — cost stays
        // honestly null (the same boundary PPR-021/022/025 recorded).
        costMicroUsd: null,
        usage:
          outcome.railUsage.inputTokens > 0 || outcome.railUsage.outputTokens > 0
            ? {
                inputTokens: outcome.railUsage.inputTokens,
                outputTokens: outcome.railUsage.outputTokens,
              }
            : null,
      })),
      recordedAt: options.now(),
    };
  } finally {
    await booted.stop();
  }
}
