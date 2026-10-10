/**
 * The PPR-026 corpus runner — drives the REAL pinned AnythingLLM runtime
 * (Mintplex-Labs/anything-llm at the exact upstream git revision
 * fa7ec877 (v1.17.0), run from the exact checkout in this sandbox as its
 * own real OS processes, booted EXACTLY the way the app's own
 * docker-entrypoint boots it: `prisma migrate deploy` → `node
 * collector/index.js` + `node server/index.js`, zero code changes)
 * through the Zeck adapter inside the proof environment (egress-deny
 * proxy + credential-scrubbed allowlist environment + the app's own
 * documented env-configuration surface pointed at the adapter), verifies
 * each task mechanically, and records the per-task facts (edge
 * executions, egress violations, rail usage).
 *
 * THE SCRUBBED RUNTIME (credential removal, ACR-007 §5): the subprocess
 * environments are BUILT FROM AN ALLOWLIST (the harness's
 * buildScrubbedRuntimeEnvironment) — no provider credential can leak in
 * by construction (the identical discipline PPR-018..025 established).
 * The only credential-shaped values present are the literal placeholder
 * `zeck-local-adapter` on the app's OWN generic-openai connection axes
 * that the certified configuration points at the local Zeck adapter
 * (GENERIC_OPEN_AI_API_KEY, GENERIC_OPEN_AI_EMBEDDING_API_KEY,
 * STT_OPEN_AI_COMPATIBLE_KEY, TTS_OPEN_AI_COMPATIBLE_KEY) — the value
 * authenticates nothing: the adapter ignores Authorization headers
 * entirely, and no provider host is reachable from the runtime whose
 * every non-loopback egress is denied by the proof proxy (the identical
 * disclosed placeholder pattern PPR-023's openclaw.json5 and PPR-025's
 * openwebui configuration established).
 *
 * THE CERTIFIED CONFIGURATION (the app's own surface, zero code
 * changes — every axis is a documented AnythingLLM environment variable,
 * read directly from process.env by the pinned revision's provider
 * factories):
 *  - LLM_PROVIDER=generic-openai + GENERIC_OPEN_AI_BASE_PATH/MODEL_PREF
 *    — the remote chat rail → the adapter's /v1 (chat completions);
 *  - OLLAMA_BASE_PATH — THE LOCAL-INFERENCE RAIL → the adapter's
 *    Ollama-native surface (GET /api/tags + POST /api/show probes +
 *    POST /api/chat), selected per-workspace through the app's own
 *    chatProvider/chatModel override;
 *  - EMBEDDING_ENGINE=generic-openai + EMBEDDING_BASE_PATH/MODEL_PREF
 *    — the RAG embedding engine → the adapter's /v1/embeddings (the
 *    delegated embeddings edge; the app's DEFAULT native transformers
 *    engine is never selected — a dormant seam);
 *  - STT_PROVIDER=generic-openai + STT_OPEN_AI_COMPATIBLE_ENDPOINT/MODEL
 *    — the transcription pipeline → the adapter's
 *    /v1/audio/transcriptions;
 *  - TTS_PROVIDER=generic-openai + TTS_OPEN_AI_COMPATIBLE_ENDPOINT/
 *    MODEL/VOICE_MODEL — the speech pipeline → the adapter's
 *    /v1/audio/speech;
 *  - VECTOR_DB=lancedb (the app's default vector store);
 *  - PROVIDER_DISABLE_NATIVE_TOOL_CALLING=generic-openai + per-workspace
 *    chatMode 'chat' (the deterministic plain-chat path — agent flows
 *    are a dormant seam, disclosed in the execution graph);
 *  - DISABLE_TELEMETRY=true, DISABLE_SWAGGER_DOCS=true,
 *    AGENT_SKILL_RERANKER_ENABLED=false (the app's own documented
 *    quiet axes);
 *  - NODE_USE_ENV_PROXY=1 + HTTP(S)_PROXY → the deny proxy (Node 24's
 *    built-in env-proxy support for the global fetch every provider
 *    connector uses), NO_PROXY=127.0.0.1,localhost,0.0.0.0 (the adapter
 *    and the server↔collector loopback are never proxied);
 *  - STORAGE_DIR stays at the checkout's server/storage (the app's OWN
 *    fixed layout: the sqlite DB path is schema-relative to
 *    server/storage, and the collector shares {STORAGE_DIR}/comkey +
 *    the checkout's collector/hotdir with the server — the app's own
 *    docker-compose topology, preserved verbatim). The PRESERVED-STATE
 *    LAW: the app's workspace/document/domain state lives OUTSIDE Zeck,
 *    in the app's own storage; the runner resets that storage per run
 *    (a fresh instance every boot — the same fresh-workspace discipline
 *    PPR-025's per-run DATA_DIR established, in-place because the app's
 *    own layout demands it).
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { EgressViolation } from "../../../src/integrations/compatibility/public";
import type { AdapterRequestLog, AdapterServer } from "../adapter/server";
import {
  CHAT_MARKER,
  CORPUS_API_KEY_PLACEHOLDER,
  CORPUS_LOCAL_MODEL,
  CORPUS_MAIN_MODEL,
  KNOWN_PHRASE_MARKER,
  LOCAL_RAIL_MARKER,
  RAG_KNOWLEDGE_DOCUMENT,
  RAG_KNOWLEDGE_TOKEN,
  RAG_QUESTION,
  type CorpusTask,
} from "../corpus/tasks";
import { readKnownPhraseWav } from "../corpus/tasks";
import type { EgressProxy } from "./egress-proxy";
import type { DeterministicExecutionFact, RailExecutionFact } from "./compose";
import {
  buildScrubbedRuntimeEnvironment,
} from "../../harness/credential-erasure";
import { DETERMINISTIC_EMBEDDINGS_MODEL, LOCAL_RAIL_MODEL, RAIL_MODEL } from "./zai-config";

/** Where the pinned AnythingLLM source lives (the exact checkout). */
export const ANYTHINGLLM_CHECKOUT_DIR = "/home/z/anythingllm-upstream" as const;

/**
 * The app's own fixed storage dir (the checkout's server/storage — the
 * app's docker-compose topology: the sqlite DB is schema-relative to it,
 * the comkey + collector hotdir are shared through it).
 */
export const ANYTHINGLLM_STORAGE_DIR = join(ANYTHINGLLM_CHECKOUT_DIR, "server", "storage") as string;

/**
 * Does the pinned AnythingLLM runtime exist in this environment (the
 * checkout + both processes' installed dependencies)?
 */
export function existsAnythingLlmRuntime(): boolean {
  return (
    existsSync(join(ANYTHINGLLM_CHECKOUT_DIR, "server", "index.js")) &&
    existsSync(join(ANYTHINGLLM_CHECKOUT_DIR, "collector", "index.js")) &&
    existsSync(join(ANYTHINGLLM_CHECKOUT_DIR, "server", "node_modules", "prisma", "build", "index.js")) &&
    existsSync(join(ANYTHINGLLM_CHECKOUT_DIR, "server", "node_modules", ".prisma", "client")) &&
    existsSync(join(ANYTHINGLLM_CHECKOUT_DIR, "collector", "node_modules", "express", "package.json"))
  );
}

/**
 * The provider-credential env-var NAMES the erasure audit records facts
 * for (the harness's reusable list extended with AnythingLLM's own
 * provider-credential names at the pinned revision — the alternative
 * provider connectors' keys the app would read; the four
 * placeholder-bearing generic-openai axes pointed at the local adapter
 * are disclosed separately, never audited as credentials: their value
 * is the non-authenticating placeholder, exactly the openclaw.json5 /
 * openwebui pattern PPR-023/025 established).
 */
export const PROVIDER_CREDENTIAL_ENV_NAMES: readonly string[] = [
  // The harness's reusable list:
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "TOGETHER_API_KEY",
  "COHERE_API_KEY",
  "XAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "GITHUB_COPILOT_TOKEN",
  "HF_TOKEN",
  "REPLICATE_API_TOKEN",
  // AnythingLLM's own provider-credential names (pinned revision):
  "OPEN_AI_KEY",
  "OPEN_AI_KEY_AZURE",
  "XAI_LLM_API_KEY",
  "LITE_LLM_API_KEY",
  "TOGETHER_AI_API_KEY",
  "TTS_OPEN_AI_KEY",
  "TTS_ELEVEN_LABS_KEY",
  "WHISPER_GENERIC_OPEN_AI_API_KEY",
  "WHISPER_LOCAL_API_KEY",
  "OLLAMA_AUTH_TOKEN",
  "LMSTUDIO_AUTH_TOKEN",
] as const;

/** The app's connection axes that carry the disclosed placeholder (names only). */
export const PLACEHOLDER_BEARING_AXES: readonly string[] = [
  "GENERIC_OPEN_AI_API_KEY",
  "GENERIC_OPEN_AI_EMBEDDING_API_KEY",
  "STT_OPEN_AI_COMPATIBLE_KEY",
  "TTS_OPEN_AI_COMPATIBLE_KEY",
] as const;

/** The app's own non-credential env-var names the allowlist admits (plus the overrides below). */
export const ANYTHINGLLM_APPLICATION_EXTRAS: readonly string[] = [
  "NODE_ENV",
  "NODE_USE_ENV_PROXY",
  "SERVER_PORT",
  "STORAGE_DIR",
  "COLLECTOR_PORT",
  "CHECKPOINT_DISABLE",
  "CI",
  "DISABLE_TELEMETRY",
  "DISABLE_SWAGGER_DOCS",
  "PROVIDER_DISABLE_NATIVE_TOOL_CALLING",
  "AGENT_SKILL_RERANKER_ENABLED",
  // The remote chat rail (generic-openai provider connector):
  "LLM_PROVIDER",
  "GENERIC_OPEN_AI_BASE_PATH",
  "GENERIC_OPEN_AI_MODEL_PREF",
  "GENERIC_OPEN_AI_MODEL_TOKEN_LIMIT",
  "GENERIC_OPEN_AI_MAX_TOKENS",
  "GENERIC_OPEN_AI_API_KEY",
  // THE LOCAL-INFERENCE RAIL (the Ollama provider connector):
  "OLLAMA_BASE_PATH",
  "OLLAMA_MODEL_PREF",
  "OLLAMA_MODEL_TOKEN_LIMIT",
  // The RAG embedding engine (generic-openai embedder):
  "EMBEDDING_ENGINE",
  "EMBEDDING_BASE_PATH",
  "EMBEDDING_MODEL_PREF",
  "GENERIC_OPEN_AI_EMBEDDING_API_KEY",
  "GENERIC_OPEN_AI_EMBEDDING_MAX_CONCURRENT_CHUNKS",
  // The STT provider (generic-openai transcription connector):
  "STT_PROVIDER",
  "STT_OPEN_AI_COMPATIBLE_ENDPOINT",
  "STT_OPEN_AI_COMPATIBLE_MODEL",
  "STT_OPEN_AI_COMPATIBLE_KEY",
  // The TTS provider (generic-openai speech connector):
  "TTS_PROVIDER",
  "TTS_OPEN_AI_COMPATIBLE_ENDPOINT",
  "TTS_OPEN_AI_COMPATIBLE_MODEL",
  "TTS_OPEN_AI_COMPATIBLE_VOICE_MODEL",
  "TTS_OPEN_AI_COMPATIBLE_KEY",
  // The vector store (the app's default):
  "VECTOR_DB",
] as const;

/** One corpus task's run outcome (the battery's runtime evidence). */
export interface CorpusTaskOutcome {
  readonly taskId: string;
  readonly title: string;
  readonly resolved: boolean;
  readonly checkOutput: string;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly timedOut: boolean;
  readonly edgeExecutions: readonly {
    readonly edgeId: string;
    readonly executionId: string;
    readonly replayed: boolean;
  }[];
  readonly egressViolations: readonly EgressViolation[];
  readonly railUsage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly dispatches: number;
    readonly failures: number;
  };
  readonly deterministicUsage: {
    readonly vectors: number;
    readonly executions: number;
  };
  /** The honest NOT-RUN cause when the task could not execute. */
  readonly unavailable: {
    readonly outcome: "NOT-RUN";
    readonly cause: string;
    readonly owner: string;
  } | null;
}

export interface CorpusRunnerOptions {
  readonly adapter: AdapterServer;
  readonly proxy: EgressProxy;
  /** The per-run workspace root (the runner's own run artifacts; the app's storage is reset in-place — see the file header). */
  readonly workspaceRoot: string;
  /** The app's loopback port (default 18095). */
  readonly appPort?: number;
  /** The collector's loopback port (default 18096). */
  readonly collectorPort?: number;
  /** Per-run wall-clock timeout (ms). Default 420_000 (documented; the per-task drivers carry their own bounded waits). */
  readonly runTimeoutMs?: number;
  /** Pause between tasks (supply pacing). */
  readonly interTaskDelayMs?: number;
  /** The rail facts accessor (the composed stack's telemetry). */
  readonly railFacts: () => readonly RailExecutionFact[];
  /** The deterministic facts accessor (the composed stack's telemetry). */
  readonly deterministicFacts: () => readonly DeterministicExecutionFact[];
  /** Optional pre-task guard: a throw aborts the run BEFORE the task. */
  readonly preTaskGuard?: () => Promise<void>;
  /** Optional per-task checkpoint hook (fires only after unambiguous completion). */
  readonly onTaskComplete?: (outcome: CorpusTaskOutcome) => void;
}

function tailOf(text: string, maxChars = 1200): string {
  return text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
}

/**
 * Build the scrubbed certified-runtime environment for one run. The
 * SAME environment shape serves the server process, the collector
 * process and the prisma migrate step (all three are the application
 * runtime — booted exactly the way the app's own docker-entrypoint
 * boots them).
 */
export function buildAnythingLlmRuntimeEnvironment(options: {
  readonly adapterUrl: string;
  readonly proxyUrl: string;
  readonly appPort: number;
  readonly collectorPort: number;
}): Readonly<Record<string, string>> {
  return buildScrubbedRuntimeEnvironment({
    applicationExtras: [...ANYTHINGLLM_APPLICATION_EXTRAS],
    source: process.env,
    overrides: {
      // The app's own runtime axes (never provider credentials):
      NODE_ENV: "production",
      NODE_USE_ENV_PROXY: "1",
      SERVER_PORT: String(options.appPort),
      STORAGE_DIR: ANYTHINGLLM_STORAGE_DIR,
      COLLECTOR_PORT: String(options.collectorPort),
      CHECKPOINT_DISABLE: "1",
      CI: "true",
      DISABLE_TELEMETRY: "true",
      DISABLE_SWAGGER_DOCS: "true",
      PROVIDER_DISABLE_NATIVE_TOOL_CALLING: "generic-openai",
      AGENT_SKILL_RERANKER_ENABLED: "false",
      // The remote chat rail (generic-openai) → the adapter:
      LLM_PROVIDER: "generic-openai",
      GENERIC_OPEN_AI_BASE_PATH: `${options.adapterUrl}/v1`,
      GENERIC_OPEN_AI_MODEL_PREF: RAIL_MODEL,
      GENERIC_OPEN_AI_MODEL_TOKEN_LIMIT: "8192",
      GENERIC_OPEN_AI_API_KEY: CORPUS_API_KEY_PLACEHOLDER,
      // THE LOCAL-INFERENCE RAIL (Ollama-native) → the adapter's surface:
      OLLAMA_BASE_PATH: options.adapterUrl,
      OLLAMA_MODEL_PREF: LOCAL_RAIL_MODEL,
      // The RAG embedding engine (generic-openai) → the adapter (the
      // delegated embeddings edge — the deterministic Zeck-side executor):
      EMBEDDING_ENGINE: "generic-openai",
      EMBEDDING_BASE_PATH: `${options.adapterUrl}/v1`,
      EMBEDDING_MODEL_PREF: DETERMINISTIC_EMBEDDINGS_MODEL,
      GENERIC_OPEN_AI_EMBEDDING_API_KEY: CORPUS_API_KEY_PLACEHOLDER,
      // The STT provider (generic-openai) → the adapter:
      STT_PROVIDER: "generic-openai",
      STT_OPEN_AI_COMPATIBLE_ENDPOINT: `${options.adapterUrl}/v1`,
      STT_OPEN_AI_COMPATIBLE_MODEL: "glm-asr",
      STT_OPEN_AI_COMPATIBLE_KEY: CORPUS_API_KEY_PLACEHOLDER,
      // The TTS provider (generic-openai) → the adapter:
      TTS_PROVIDER: "generic-openai",
      TTS_OPEN_AI_COMPATIBLE_ENDPOINT: `${options.adapterUrl}/v1`,
      TTS_OPEN_AI_COMPATIBLE_MODEL: "glm-tts",
      TTS_OPEN_AI_COMPATIBLE_VOICE_MODEL: "tongtong",
      TTS_OPEN_AI_COMPATIBLE_KEY: CORPUS_API_KEY_PLACEHOLDER,
      // The app's default vector store:
      VECTOR_DB: "lancedb",
      // The proof environment's egress control (Node 24's built-in
      // env-proxy support drives the global fetch every provider
      // connector uses; the server↔collector loopback at 0.0.0.0 and
      // the adapter at 127.0.0.1 are never proxied):
      HTTP_PROXY: options.proxyUrl,
      HTTPS_PROXY: options.proxyUrl,
      http_proxy: options.proxyUrl,
      https_proxy: options.proxyUrl,
      NO_PROXY: "127.0.0.1,localhost,0.0.0.0",
      no_proxy: "127.0.0.1,localhost,0.0.0.0",
    },
  });
}

// ---------------------------------------------------------------------------
// The boot (the app's own docker-entrypoint sequence, verbatim)
// ---------------------------------------------------------------------------

/**
 * Reset the app's own storage to a fresh instance (the PRESERVED-STATE
 * LAW: the app's state lives outside Zeck; every run boots a fresh
 * instance — the same fresh-workspace discipline PPR-025 established,
 * in-place because the app's own fixed layout demands it). Runtime
 * artifacts only — the checkout's source is never touched.
 */
function resetAnythingLlmStorage(): void {
  const serverDir = join(ANYTHINGLLM_CHECKOUT_DIR, "server");
  for (const artifact of [
    join(ANYTHINGLLM_STORAGE_DIR, "anythingllm.db"),
    join(ANYTHINGLLM_STORAGE_DIR, "anythingllm.db-journal"),
    join(ANYTHINGLLM_STORAGE_DIR, "lancedb"),
    join(ANYTHINGLLM_STORAGE_DIR, "documents"),
    join(ANYTHINGLLM_STORAGE_DIR, "vector-cache"),
    join(ANYTHINGLLM_STORAGE_DIR, "models"),
    join(ANYTHINGLLM_STORAGE_DIR, "comkey"),
    // The app's own first-boot .env materialization (EncryptionManager's
    // dumpENV side effect — regenerated each boot; our spawned env vars
    // always take precedence over dotenv loads).
    join(serverDir, ".env"),
  ]) {
    rmSync(artifact, { recursive: true, force: true });
  }
  mkdirSync(ANYTHINGLLM_STORAGE_DIR, { recursive: true });
  mkdirSync(join(ANYTHINGLLM_CHECKOUT_DIR, "collector", "hotdir"), { recursive: true });
}

/** The booted app pair (the collector + the server — stopped always together). */
export interface BootedApp {
  readonly appBaseUrl: string;
  readonly collectorBaseUrl: string;
  readonly stop: () => Promise<void>;
  readonly stdoutTail: () => string;
  readonly stderrTail: () => string;
}

const PRISMA_CLI = join("node_modules", "prisma", "build", "index.js");

/**
 * Boot the pinned AnythingLLM runtime with an explicit environment (the
 * certified scrubbed environment OR a baseline arm's environment): the
 * app's own docker-entrypoint sequence — storage reset (fresh instance),
 * `prisma migrate deploy`, then `node collector/index.js` (cwd collector)
 * + `node server/index.js` (cwd server).
 */
export async function bootAnythingLlmApp(options: {
  readonly env: Readonly<Record<string, string>>;
  readonly appPort: number;
  readonly collectorPort: number;
  /** Skip the per-boot storage reset (a baseline arm may reuse a prepared storage state). */
  readonly skipStorageReset?: boolean;
}): Promise<BootedApp> {
  if (options.skipStorageReset !== true) {
    resetAnythingLlmStorage();
  }
  const serverDir = join(ANYTHINGLLM_CHECKOUT_DIR, "server");
  const collectorDir = join(ANYTHINGLLM_CHECKOUT_DIR, "collector");
  const env = { ...options.env } as Record<string, string>;

  // 1. prisma migrate deploy (the app's own entrypoint step; a failed
  //    migration is a boot failure — the whole run is honestly NOT-RUN).
  const migrated = spawnSync("node", [PRISMA_CLI, "migrate", "deploy", "--schema=./prisma/schema.prisma"], {
    cwd: serverDir,
    env,
    encoding: "utf8",
    timeout: 180_000,
  });
  if (migrated.status !== 0) {
    throw new Error(
      `prisma migrate deploy failed (status ${String(migrated.status)}): ${tailOf(
        `${migrated.stdout ?? ""}\n${migrated.stderr ?? ""}`,
        600,
      )}`,
    );
  }

  // 2. The collector process (the app's document-processing plane).
  const stdout: string[] = [];
  const stderr: string[] = [];
  const capture = (chunks: string[], chunk: Buffer): void => {
    chunks.push(chunk.toString("utf8"));
    if (chunks.length > 400) {
      chunks.splice(0, chunks.length - 400);
    }
  };
  const collector: ChildProcess = spawn("node", ["index.js"], {
    cwd: collectorDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  collector.stdout?.on("data", (chunk: Buffer) => capture(stdout, chunk));
  collector.stderr?.on("data", (chunk: Buffer) => capture(stderr, chunk));

  // 3. The server process (the app's primary API plane).
  const server: ChildProcess = spawn("node", ["index.js"], {
    cwd: serverDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (chunk: Buffer) => capture(stdout, chunk));
  server.stderr?.on("data", (chunk: Buffer) => capture(stderr, chunk));

  const stopOne = async (process_: ChildProcess): Promise<void> => {
    if (process_.exitCode === null) {
      process_.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          process_.kill("SIGKILL");
          resolve();
        }, 10_000);
        process_.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };
  const stop = async (): Promise<void> => {
    await stopOne(server);
    await stopOne(collector);
  };
  return {
    appBaseUrl: `http://127.0.0.1:${options.appPort}`,
    collectorBaseUrl: `http://0.0.0.0:${options.collectorPort}`,
    stop,
    stdoutTail: () => tailOf(stdout.join("")),
    stderrTail: () => tailOf(stderr.join("")),
  };
}

// ---------------------------------------------------------------------------
// Readiness + auth bootstrap (the app's own first-boot surfaces)
// ---------------------------------------------------------------------------

/** Wait for the app's liveness route (GET /api/ping → {online: true}). */
export async function awaitAppPing(appBaseUrl: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    try {
      const response = await fetch(`${appBaseUrl}/api/ping`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // not ready yet
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`the pinned AnythingLLM server did not become healthy within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
}

/** Wait for the collector's open /accepts probe. */
export async function awaitCollectorReady(collectorBaseUrl: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    try {
      const response = await fetch(`${collectorBaseUrl}/accepts`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // not ready yet
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`the pinned AnythingLLM collector did not become healthy within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
}

/**
 * Generate the developer-API key (the app's own single-user
 * generate-api-key route — open in the certified credential-free
 * single-user mode: AUTH_TOKEN and JWT_SECRET are deliberately unset,
 * so `validatedRequest` passes through and no web session exists).
 */
export async function generateApiKey(
  appBaseUrl: string,
  timeoutMs: number,
): Promise<string> {
  const startedAt = Date.now();
  for (;;) {
    try {
      const response = await fetch(`${appBaseUrl}/api/system/generate-api-key`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "ppr026-corpus" }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) {
        const body = (await response.json()) as { readonly apiKey?: { readonly secret?: unknown } };
        const secret = body.apiKey?.secret;
        if (typeof secret === "string" && secret.length > 0) {
          return secret;
        }
      }
    } catch {
      // not ready yet
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`the developer API key could not be generated within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
}

export interface AppClient {
  readonly apiKey: string;
  fetchApp(path: string, init?: RequestInit): Promise<Response>;
}

export function appClientOf(appBaseUrl: string, apiKey: string): AppClient {
  return {
    apiKey,
    async fetchApp(path: string, init: RequestInit = {}): Promise<Response> {
      return fetch(`${appBaseUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...(init.body instanceof FormData ? {} : { "content-type": "application/json" }),
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(300_000),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// The per-task drivers (every task drives the app's OWN HTTP API)
// ---------------------------------------------------------------------------

interface WorkspaceSummary {
  readonly slug: string;
  readonly id: number;
}

/** Create a workspace through the developer API (the app's own surface). */
async function createWorkspace(
  app: AppClient,
  name: string,
  fields: Readonly<Record<string, unknown>> = {},
): Promise<WorkspaceSummary> {
  const response = await app.fetchApp("/api/v1/workspace/new", {
    method: "POST",
    body: JSON.stringify({ name, chatMode: "chat", ...fields }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`workspace create failed HTTP ${response.status}: ${tailOf(text, 300)}`);
  }
  const body = JSON.parse(text) as {
    readonly workspace?: { readonly slug?: unknown; readonly id?: unknown };
  };
  const slug = body.workspace?.slug;
  const id = body.workspace?.id;
  if (typeof slug !== "string" || slug.length === 0 || typeof id !== "number") {
    throw new Error(`workspace create returned no slug/id: ${tailOf(text, 300)}`);
  }
  return { slug, id };
}

/** One workspace chat turn through the developer API (mode 'chat'). */
async function workspaceChat(
  app: AppClient,
  slug: string,
  message: string,
): Promise<{ readonly textResponse: string; readonly chatId: number | null }> {
  const response = await app.fetchApp(`/api/v1/workspace/${slug}/chat`, {
    method: "POST",
    body: JSON.stringify({ message, mode: "chat" }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`workspace chat failed HTTP ${response.status}: ${tailOf(text, 400)}`);
  }
  const body = JSON.parse(text) as {
    readonly type?: unknown;
    readonly textResponse?: unknown;
    readonly chatId?: unknown;
    readonly error?: unknown;
  };
  const textResponse = typeof body.textResponse === "string" ? body.textResponse : "";
  if (body.type === "abort" || textResponse.length === 0) {
    throw new Error(`workspace chat aborted: ${tailOf(text, 400)}`);
  }
  return {
    textResponse,
    chatId: typeof body.chatId === "number" ? body.chatId : null,
  };
}

/** Upload a text document through the developer API (the app's document plane). */
async function uploadDocument(
  app: AppClient,
  filename: string,
  content: string,
): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([content], { type: "text/plain" }), filename);
  const response = await app.fetchApp("/api/v1/document/upload", { method: "POST", body: form });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`document upload failed HTTP ${response.status}: ${tailOf(text, 400)}`);
  }
  const body = JSON.parse(text) as {
    readonly success?: unknown;
    readonly documents?: readonly { readonly location?: unknown }[];
  };
  const location = body.documents?.[0]?.location;
  if (body.success !== true || typeof location !== "string" || location.length === 0) {
    throw new Error(`document upload returned no location: ${tailOf(text, 400)}`);
  }
  return location;
}

/** Embed a document into a workspace (the app's update-embeddings surface). */
async function embedDocument(app: AppClient, slug: string, location: string): Promise<void> {
  const response = await app.fetchApp(`/api/v1/workspace/${slug}/update-embeddings`, {
    method: "POST",
    body: JSON.stringify({ adds: [location] }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`update-embeddings failed HTTP ${response.status}: ${tailOf(text, 400)}`);
  }
}

/** Read the app's total vector count (its own vector-count API). */
async function totalVectorCount(app: AppClient): Promise<number> {
  const response = await app.fetchApp("/api/v1/system/vector-count");
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`vector-count failed HTTP ${response.status}: ${tailOf(text, 300)}`);
  }
  const body = JSON.parse(text) as { readonly vectorCount?: unknown };
  return typeof body.vectorCount === "number" ? body.vectorCount : -1;
}

async function runChatTask(
  app: AppClient,
  options: {
    readonly workspaceName: string;
    readonly marker: string;
    readonly chatProvider?: string;
    readonly chatModel?: string;
  },
): Promise<{ ok: boolean; checkOutput: string }> {
  const workspace = await createWorkspace(app, options.workspaceName, {
    ...(options.chatProvider === undefined ? {} : { chatProvider: options.chatProvider }),
    ...(options.chatModel === undefined ? {} : { chatModel: options.chatModel }),
  });
  const chat = await workspaceChat(
    app,
    workspace.slug,
    `Reply with exactly the word ${options.marker} and nothing else.`,
  );
  const ok = chat.textResponse.includes(options.marker);
  return {
    ok,
    checkOutput: ok
      ? `the workspace chat's textResponse contains ${options.marker} (${chat.textResponse.length} chars, workspace ${workspace.slug})`
      : `the textResponse did not contain ${options.marker}: ${tailOf(chat.textResponse, 300)}`,
  };
}

async function runEmbedDocumentTask(app: AppClient): Promise<{ ok: boolean; checkOutput: string }> {
  const workspace = await createWorkspace(app, "Embedding Journey");
  const before = await totalVectorCount(app);
  const location = await uploadDocument(
    app,
    "vector-journey-notes.txt",
    "Vector Journey Notes\n\nThese notes exist to exercise the document embedding pipeline. The meridian watch log records beacon checks, gate codes and mooring inspections. The beacon check at the meridian station happens every four hours. The gate code rotation is monthly.\n",
  );
  await embedDocument(app, workspace.slug, location);
  // The embedding is synchronous in the app's own pipeline (addDocuments
  // awaits the embedder); poll for the vector count to move (bounded).
  let after = -1;
  const startedAt = Date.now();
  for (;;) {
    after = await totalVectorCount(app);
    if (after > before) {
      break;
    }
    if (Date.now() - startedAt > 120_000) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  const delta = after - before;
  const ok = delta >= 1;
  return {
    ok,
    checkOutput: ok
      ? `the app's vector count grew from ${before} to ${after} (+${delta}) after embedding the document into workspace ${workspace.slug} (the app's own vector pipeline over the delegated embeddings edge — no chat turn)`
      : `the app's vector count did not grow (${before} → ${after}) after update-embeddings`,
  };
}

async function runRagTask(app: AppClient): Promise<{ ok: boolean; checkOutput: string }> {
  // A workspace with a permissive similarity threshold (the app's own
  // documented workspace axis) — the lexical-overlap retrieval signal.
  const workspace = await createWorkspace(app, "Knowledge Base", {
    similarityThreshold: 0.15,
    topN: 4,
  });
  const location = await uploadDocument(app, "lighthouse-operations-manual.txt", RAG_KNOWLEDGE_DOCUMENT);
  await embedDocument(app, workspace.slug, location);
  const chat = await workspaceChat(app, workspace.slug, RAG_QUESTION);
  const ok = chat.textResponse.includes(RAG_KNOWLEDGE_TOKEN);
  return {
    ok,
    checkOutput: ok
      ? `the grounded answer contains the document's distinctive gate code ${RAG_KNOWLEDGE_TOKEN} (the app's own RAG pipeline: upload → embed → query-embed → LanceDB retrieval → grounded chat)`
      : `the grounded answer did not contain ${RAG_KNOWLEDGE_TOKEN}: ${tailOf(chat.textResponse, 400)}`,
  };
}

async function runTranscriptionTask(app: AppClient): Promise<{ ok: boolean; checkOutput: string }> {
  const wav = readKnownPhraseWav();
  const form = new FormData();
  form.append("audio", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "known-phrase.wav");
  const response = await app.fetchApp("/api/system/transcribe-audio", { method: "POST", body: form });
  const text = await response.text();
  if (!response.ok) {
    return { ok: false, checkOutput: `transcription failed HTTP ${response.status}: ${tailOf(text, 400)}` };
  }
  const body = JSON.parse(text) as { readonly success?: unknown; readonly text?: unknown };
  const transcript = typeof body.text === "string" ? body.text : "";
  const ok = body.success === true && transcript.toLowerCase().includes(KNOWN_PHRASE_MARKER.toLowerCase());
  return {
    ok,
    checkOutput: ok
      ? `the transcript contains the known-phrase marker "${KNOWN_PHRASE_MARKER}" (transcript: ${tailOf(transcript, 200)})`
      : `the transcript did not contain the marker: ${tailOf(transcript, 300)}`,
  };
}

async function runSpeechTask(app: AppClient): Promise<{ ok: boolean; checkOutput: string }> {
  // 1. A chat turn whose response gets stored (the app's TTS route
  //    synthesizes the STORED chat response).
  const workspace = await createWorkspace(app, "Speech Journey");
  const chat = await workspaceChat(
    app,
    workspace.slug,
    "Reply with exactly the sentence: The lighthouse beam sweeps the harbor at midnight.",
  );
  if (chat.chatId === null) {
    return { ok: false, checkOutput: "the chat turn returned no chatId for the TTS route" };
  }
  // 2. The app's own chat-response speech route (UI surface; open in the
  //    certified single-user mode — the bearer header is tolerated).
  const response = await app.fetchApp(`/api/workspace/${workspace.slug}/tts/${chat.chatId}`);
  if (!response.ok) {
    const text = await response.text();
    return { ok: false, checkOutput: `speech failed HTTP ${response.status}: ${tailOf(text, 400)}` };
  }
  const contentType = response.headers.get("content-type") ?? "";
  const bytes = new Uint8Array(await response.arrayBuffer());
  const ok = bytes.length > 1000 && contentType.startsWith("audio/");
  return {
    ok,
    checkOutput: ok
      ? `the app's TTS route returned ${bytes.length} audio bytes (content-type ${contentType}) for the stored chat response`
      : `unexpected speech response: ${bytes.length} bytes, content-type ${contentType}`,
  };
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/** The telemetry seams the per-task driver records its facts through. */
export interface TaskTelemetry {
  readonly adapter: AdapterServer;
  readonly proxy: EgressProxy;
  readonly railFacts: () => readonly RailExecutionFact[];
  readonly deterministicFacts: () => readonly DeterministicExecutionFact[];
  readonly interTaskDelayMs?: number;
  readonly preTaskGuard?: () => Promise<void>;
  readonly onTaskComplete?: (outcome: CorpusTaskOutcome) => void;
}

/** Drive ONE task's app-level journey (the mechanical check). */
async function driveOneTask(
  appBaseUrl: string,
  client: AppClient,
  task: CorpusTask,
): Promise<{ ok: boolean; checkOutput: string }> {
  void appBaseUrl;
  switch (task.taskId) {
    case "anythingllm-chat-basic":
      return runChatTask(client, {
        workspaceName: "Main Chat",
        marker: CHAT_MARKER,
      });
    case "anythingllm-embed-document":
      return runEmbedDocumentTask(client);
    case "anythingllm-rag-grounded-qa":
      return runRagTask(client);
    case "anythingllm-audio-transcription":
      return runTranscriptionTask(client);
    case "anythingllm-audio-speech":
      return runSpeechTask(client);
    case "anythingllm-local-rail-chat":
      return runChatTask(client, {
        workspaceName: "Local Rail",
        marker: LOCAL_RAIL_MARKER,
        chatProvider: "ollama",
        chatModel: CORPUS_LOCAL_MODEL,
      });
    default:
      return {
        ok: false,
        checkOutput: `the corpus runner carries no driver for task ${task.taskId}`,
      };
  }
}

/**
 * Drive the corpus tasks against an ALREADY-BOOTED app (api-key client):
 * the per-task drivers, the mechanical checks and the per-task fact
 * recording (shared verbatim by the certified run and the non-Zeck
 * baseline arms — the same corpus, the same checks).
 */
export async function driveCorpusTasksAgainstClient(
  appBaseUrl: string,
  client: AppClient,
  tasks: readonly CorpusTask[],
  telemetry: TaskTelemetry,
): Promise<readonly CorpusTaskOutcome[]> {
  const { adapter, proxy } = telemetry;
  const outcomes: CorpusTaskOutcome[] = [];
  for (const task of tasks) {
    const startedAt = Date.now();
    adapter.setRunContext({ corpusTask: task.taskId, runLabel: `ppr-026-${task.taskId}` });
    const baselineLogs = adapter.requests().length;
    const baselineViolations = proxy.violations().length;
    const baselineRail = telemetry.railFacts();
    const baselineDeterministic = telemetry.deterministicFacts();

    let check: { ok: boolean; checkOutput: string };
    try {
      await telemetry.preTaskGuard?.();
      check = await driveOneTask(appBaseUrl, client, task);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      check = { ok: false, checkOutput: `task driver error: ${message.slice(0, 400)}` };
    }

    const logsAfter = adapter.requests().slice(baselineLogs);
    const executionsOfRun = logsAfter.filter((log) => log.corpusTask === task.taskId);
    const railAfter = telemetry.railFacts();
    const deterministicAfter = telemetry.deterministicFacts();
    const newRail = railAfter.slice(baselineRail.length);
    const newDeterministic = deterministicAfter.slice(baselineDeterministic.length);
    const executionIds = new Set(executionsOfRun.map((log) => log.executionId));
    const railUsage = {
      inputTokens: newRail
        .filter((fact) => executionIds.has(fact.executionId))
        .reduce((sum, fact) => sum + (fact.usage?.inputTokens ?? 0), 0),
      outputTokens: newRail
        .filter((fact) => executionIds.has(fact.executionId))
        .reduce((sum, fact) => sum + (fact.usage?.outputTokens ?? 0), 0),
      dispatches: newRail.filter((fact) => executionIds.has(fact.executionId)).length,
      failures: newRail.filter(
        (fact) => executionIds.has(fact.executionId) && fact.outcome === "provider-failure",
      ).length,
    };
    const deterministicUsage = {
      vectors: newDeterministic
        .filter((fact) => executionIds.has(fact.executionId))
        .reduce((sum, fact) => sum + fact.vectorCount, 0),
      executions: newDeterministic.filter((fact) => executionIds.has(fact.executionId)).length,
    };

    const outcome: CorpusTaskOutcome = {
      taskId: task.taskId,
      title: task.title,
      resolved: check.ok,
      checkOutput: check.checkOutput,
      durationMs: Date.now() - startedAt,
      exitCode: 0,
      stdoutTail: "",
      stderrTail: "",
      timedOut: false,
      edgeExecutions: executionsOfRun
        .filter((log: AdapterRequestLog) => log.executionId.length > 0)
        .map((log) => ({
          edgeId: log.edgeId,
          executionId: log.executionId,
          replayed: log.replayed,
        })),
      egressViolations: proxy.violations().slice(baselineViolations),
      railUsage,
      deterministicUsage,
      unavailable: null,
    };
    outcomes.push(outcome);
    telemetry.onTaskComplete?.(outcome);
    adapter.setRunContext(null);
    if (telemetry.interTaskDelayMs !== undefined && telemetry.interTaskDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, telemetry.interTaskDelayMs));
    }
  }
  return outcomes;
}

/**
 * Run the corpus against the booted pinned runtime. Boots the app pair
 * (fresh storage → migrate → collector + server), waits for health,
 * generates the developer API key, runs every task mechanically, and
 * records the per-task facts. Both app processes are ALWAYS stopped in
 * finally.
 */
export async function runCorpusTasks(
  options: CorpusRunnerOptions,
  tasks: readonly CorpusTask[],
): Promise<readonly CorpusTaskOutcome[]> {
  const appPort = options.appPort ?? 18095;
  const collectorPort = options.collectorPort ?? 18096;
  const env = buildAnythingLlmRuntimeEnvironment({
    adapterUrl: options.adapter.url,
    proxyUrl: options.proxy.url,
    appPort,
    collectorPort,
  });
  const booted = await bootAnythingLlmApp({ env, appPort, collectorPort });
  try {
    await awaitAppPing(booted.appBaseUrl, 120_000);
    await awaitCollectorReady(booted.collectorBaseUrl, 60_000);
    const apiKey = await generateApiKey(booted.appBaseUrl, 60_000);
    const client = appClientOf(booted.appBaseUrl, apiKey);
    const outcomes = await driveCorpusTasksAgainstClient(booted.appBaseUrl, client, tasks, {
      adapter: options.adapter,
      proxy: options.proxy,
      railFacts: options.railFacts,
      deterministicFacts: options.deterministicFacts,
      ...(options.interTaskDelayMs === undefined ? {} : { interTaskDelayMs: options.interTaskDelayMs }),
      ...(options.preTaskGuard === undefined ? {} : { preTaskGuard: options.preTaskGuard }),
      ...(options.onTaskComplete === undefined ? {} : { onTaskComplete: options.onTaskComplete }),
    });
    // Decorate the outcomes with the app processes' tails (the certified
    // run records the runtime's own log evidence).
    const stdoutTail = booted.stdoutTail();
    const stderrTail = booted.stderrTail();
    return outcomes.map((outcome) => ({ ...outcome, stdoutTail, stderrTail }));
  } finally {
    await booted.stop();
    options.adapter.setRunContext(null);
  }
}

/**
 * The honest NOT-RUN outcome for the whole runtime (used by the battery
 * when the app cannot boot — infrastructure unavailable, owner named).
 */
export function wholeRunUnavailableOutcome(
  task: CorpusTask,
  startedAt: number,
  cause: string,
  owner: string,
): CorpusTaskOutcome {
  return {
    taskId: task.taskId,
    title: task.title,
    resolved: false,
    checkOutput: cause,
    durationMs: Date.now() - startedAt,
    exitCode: -1,
    stdoutTail: "",
    stderrTail: tailOf(cause),
    timedOut: false,
    edgeExecutions: [],
    egressViolations: [],
    railUsage: { inputTokens: 0, outputTokens: 0, dispatches: 0, failures: 0 },
    deterministicUsage: { vectors: 0, executions: 0 },
    unavailable: { outcome: "NOT-RUN", cause, owner },
  };
}

/** Re-export the corpus model constants the baselines compose with. */
export { CORPUS_MAIN_MODEL, CORPUS_LOCAL_MODEL, CORPUS_API_KEY_PLACEHOLDER };
