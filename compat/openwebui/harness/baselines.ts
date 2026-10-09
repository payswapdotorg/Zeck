/**
 * The PPR-025 baseline arms — the two mandated NON-ZECK comparison stacks
 * (the direct baseline and the strong-optimized baseline) captured over
 * the SAME corpus with the SAME mechanical checks (the harness's
 * captureBaseline + the labeling law: baseline records are structurally
 * NOT Zeck evidence; the only bridge is the labeled ComparisonFact).
 *
 * THE BASELINE STACKS (the sandbox's honest provider boundary — the
 * identical boundary class PPR-022/023/024 recorded):
 *
 *  - DIRECT arm: the pinned Open WebUI runtime configured DIRECTLY at the
 *    sandbox's single authorized provider endpoint (the GLM supply), the
 *    app's own documented connection axes, stock settings, NO Zeck
 *    adapter in the path. The baseline app process carries the supply
 *    credential as its provider key (the non-Zeck stack by definition —
 *    the certified path never does; disclosed in the baseline record).
 *
 *  - OPTIMIZED arm: the strong-optimized non-Zeck configuration — every
 *    app-OWNED optimization axis tuned (the curated per-connection
 *    model list, the supply's native model ids, the tuned image size and
 *    client timeout, per-surface engine selection), still NO Zeck and NO
 *    new infrastructure (the operator has only this supply and the app's
 *    own configuration surface — no glue proxies, no code changes).
 *
 * THE HONEST EXPECTATION (recorded, never softened): the supply serves
 * chat completions and image generations on the app's wire shapes, but
 * exposes NO embeddings endpoint (404 — probed live), NO
 * /audio/transcriptions or /audio/speech paths (its audio surfaces are
 * /audio/asr and /audio/tts on different wire shapes), and speaks NO
 * Ollama-native protocol — so the RAG/memories (embeddings), STT, TTS and
 * local-rail corpus tasks FAIL HONESTLY on both non-Zeck arms. That is
 * the exact multi-surface provider fragmentation the target matrix names
 * for Open WebUI, measured as baseline facts (never as Zeck evidence).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  appClientOf,
  bootOpenWebUiApp,
  buildOpenWebUiRuntimeEnvironment,
  driveCorpusTasksAgainstClient,
  signUpAdmin,
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

/** The baseline arms' non-credential env extras (same allowlist shape as the certified runtime). */
const BASELINE_EXTRAS: readonly string[] = [
  "WEBUI_SECRET_KEY",
  "DATA_DIR",
  "DATABASE_URL",
  "PYTHONPATH",
  "PYTHONUNBUFFERED",
  "HOST",
  "PORT",
  "WEBUI_AUTH",
  "ENABLE_OLLAMA_API",
  "ENABLE_IMAGE_GENERATION",
  "ENABLE_VERSION_UPDATE_CHECK",
  "ENABLE_OPENAI_API",
  "OPENAI_API_BASE_URLS",
  "OPENAI_API_KEYS",
  "OLLAMA_BASE_URLS",
  "RAG_EMBEDDING_ENGINE",
  "RAG_OPENAI_API_BASE_URL",
  "RAG_OPENAI_API_KEY",
  "RAG_EMBEDDING_MODEL",
  "IMAGE_GENERATION_ENGINE",
  "IMAGES_OPENAI_API_BASE_URL",
  "IMAGES_OPENAI_API_KEY",
  "IMAGE_GENERATION_MODEL",
  "IMAGE_SIZE",
  "AUDIO_STT_ENGINE",
  "AUDIO_STT_OPENAI_API_BASE_URL",
  "AUDIO_STT_OPENAI_API_KEY",
  "AUDIO_STT_MODEL",
  "AUDIO_TTS_ENGINE",
  "AUDIO_TTS_OPENAI_API_BASE_URL",
  "AUDIO_TTS_OPENAI_API_KEY",
  "AUDIO_TTS_MODEL",
  "AUDIO_TTS_VOICE",
  "AIOHTTP_CLIENT_TIMEOUT",
  "BYPASS_PYDUB_PREPROCESSING",
  "OPENAI_API_CONFIGS",
] as const;

/** Build one baseline arm's environment (direct egress — no proof proxy; the non-Zeck stack). */
export function buildBaselineEnvironment(options: {
  readonly kind: "direct" | "optimized";
  readonly supply: SupplyEndpoint;
  readonly workspaceRoot: string;
}): Readonly<Record<string, string>> {
  const supplyV1 = `${options.supply.baseUrl}`;
  const optimized = options.kind === "optimized";
  // The strong-optimized arm's manual model list + session headers — the
  // app's OWN documented connection axes (openai.api_configs[].model_ids
  // + .headers) an operator uses when (a) the provider exposes no
  // model-listing endpoint (recorded live: the authorized supply serves
  // /models → 404 and /v1/models → 404 — the stock direct arm cannot
  // enumerate models and fails every task with "Model not found") and
  // (b) the provider requires platform-session headers beyond the Bearer
  // key (recorded live: a plain Bearer-only client receives 401/403 —
  // the machine-level endpoint requires x-z-ai-from/x-chat-id/x-user-id/
  // x-token). Both are the honest stock boundaries the optimized arm
  // works around with the app's own configuration surface — still no
  // Zeck and no new infrastructure.
  const optimizedModelList = JSON.stringify({
    [supplyV1]: {
      enable: true,
      model_ids: ["glm-4-plus", "glm-4.5v"],
      headers: { ...options.supply.sessionHeaders },
    },
  });
  return buildScrubbedRuntimeEnvironment({
    applicationExtras: [...BASELINE_EXTRAS],
    source: process.env,
    overrides: {
      WEBUI_SECRET_KEY: "ppr025-baseline-secret-key-b1c2",
      DATA_DIR: join(options.workspaceRoot, "data"),
      DATABASE_URL: `sqlite:///${join(options.workspaceRoot, "data", "webui.db")}`,
      PYTHONPATH: "/home/z/openwebui-upstream/backend",
      PYTHONUNBUFFERED: "1",
      HOST: "127.0.0.1",
      WEBUI_AUTH: "true",
      ENABLE_OLLAMA_API: "true",
      ENABLE_OPENAI_API: "true",
      ENABLE_IMAGE_GENERATION: "true",
      ENABLE_VERSION_UPDATE_CHECK: "false",
      // The OpenAI-compatible connections → the supply DIRECTLY (no Zeck):
      OPENAI_API_BASE_URLS: supplyV1,
      OPENAI_API_KEYS: options.supply.apiKey,
      // The local-inference rail → the supply (which speaks no Ollama
      // protocol — the honest baseline failure):
      OLLAMA_BASE_URLS: options.supply.baseUrl,
      // The RAG embeddings engine → the supply (which serves no
      // embeddings endpoint — the honest baseline failure):
      RAG_EMBEDDING_ENGINE: "openai",
      RAG_OPENAI_API_BASE_URL: supplyV1,
      RAG_OPENAI_API_KEY: options.supply.apiKey,
      RAG_EMBEDDING_MODEL: optimized ? "embedding-3" : "text-embedding-small",
      // The image pipeline → the supply's native image path (live):
      IMAGE_GENERATION_ENGINE: "openai",
      IMAGES_OPENAI_API_BASE_URL: supplyV1,
      IMAGES_OPENAI_API_KEY: options.supply.apiKey,
      IMAGE_GENERATION_MODEL: "glm-image",
      IMAGE_SIZE: optimized ? "1024x1024" : "512x512",
      // The audio pipelines → the supply's OpenAI-shaped paths (which do
      // not exist there — the honest baseline failures):
      AUDIO_STT_ENGINE: "openai",
      AUDIO_STT_OPENAI_API_BASE_URL: supplyV1,
      AUDIO_STT_OPENAI_API_KEY: options.supply.apiKey,
      AUDIO_STT_MODEL: "whisper-1",
      AUDIO_TTS_ENGINE: "openai",
      AUDIO_TTS_OPENAI_API_BASE_URL: supplyV1,
      AUDIO_TTS_OPENAI_API_KEY: options.supply.apiKey,
      AUDIO_TTS_MODEL: "tts-1",
      AUDIO_TTS_VOICE: "tongtong",
      AIOHTTP_CLIENT_TIMEOUT: optimized ? "300" : "30",
      BYPASS_PYDUB_PREPROCESSING: "true",
      ...(optimized ? { OPENAI_API_CONFIGS: optimizedModelList } : {}),
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
 * Run ONE baseline arm: boot the pinned runtime with the arm's
 * environment (direct provider egress, no Zeck, no proof proxy), drive
 * the SAME corpus with the SAME mechanical checks, and record the honest
 * per-task results. The app process is ALWAYS stopped in finally.
 */
export async function runBaselineArm(options: {
  readonly kind: "direct" | "optimized";
  readonly workspaceRoot: string;
  readonly appPort: number;
  readonly telemetry: TaskTelemetry;
  readonly tasks?: readonly CorpusTask[];
  readonly now: () => string;
}): Promise<BaselineRunFacts> {
  const supply = loadSupplyEndpoint();
  // A fresh run-stamped workspace per arm invocation: the app's
  // PersistentConfig seeds its config DB from the environment ONLY on
  // first boot — reusing a workspace would silently run the arm on a
  // stale configuration (a real hazard the battery hit and recorded).
  const runRoot = join(
    options.workspaceRoot,
    `arm-${options.kind}-${Date.now()}`,
  );
  const env = buildBaselineEnvironment({
    kind: options.kind,
    supply,
    workspaceRoot: runRoot,
  });
  const booted = await bootOpenWebUiApp({
    env,
    appPort: options.appPort,
    workspaceRoot: runRoot,
  });
  try {
    const admin = await signUpAdmin(booted.appBaseUrl, 120_000);
    const client = appClientOf(booted.appBaseUrl, admin.token);
    // NOTE: no awaitModelsReady for the baselines — the model catalog is
    // whatever the DIRECT stack can reach (the app may fail to list the
    // supply's models on its OpenAI-shaped probe; the chat driver then
    // records the honest failure).
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
          ? `Open WebUI 0.11.4 (pinned ${"8bd8b4f"}) stock configuration pointed DIRECTLY at the sandbox's authorized GLM supply endpoint (no Zeck; the app's own connection axes; stock defaults — the supply serves no model-listing endpoint, so the stock arm cannot enumerate models)`
          : `Open WebUI 0.11.4 (pinned ${"8bd8b4f"}) strong-optimized non-Zeck arm (the app's own optimization axes fully tuned: the manual model_ids connection list over the supply's native model ids — the documented operator workaround for providers without model listing — plus per-surface engine selection, tuned image size and client timeout — still no Zeck and no new infrastructure)`,
      methodology:
        "the same eight corpus tasks, the same mechanical verification, the same pinned runtime; the provider calls go directly from the application process to the authorized supply endpoint (the non-Zeck stack); the arm differs from the certified path ONLY in the delegation (Zeck absent) — baseline facts, never Zeck evidence",
      taskRuns: outcomes.map((outcome) => ({
        taskId: outcome.taskId,
        succeeded: outcome.resolved,
        detail: outcome.checkOutput,
        durationMs: outcome.durationMs,
        // No provider prices are published for the supply — cost stays
        // honestly null (the same boundary PPR-021/022 recorded).
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
