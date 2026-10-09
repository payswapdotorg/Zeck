/**
 * The PPR-025 corpus runner — drives the REAL pinned Open WebUI runtime
 * (open-webui at the exact upstream git revision 8bd8b4f, run from the
 * exact checkout in this sandbox: PYTHONPATH pinned to the checkout's
 * backend/, the pinned venv's uvicorn serving the app's FastAPI
 * `open_webui.main:app` in its own API-only mode) through the Zeck
 * adapter inside the proof environment (egress-deny proxy +
 * credential-scrubbed allowlist environment + the app's own documented
 * env-configuration surface pointed at the adapter), verifies each task
 * mechanically, and records the per-task facts (edge executions, egress
 * violations, rail usage).
 *
 * THE SCRUBBED RUNTIME (credential removal, ACR-007 §5): the subprocess
 * environment is BUILT FROM AN ALLOWLIST (the harness's
 * buildScrubbedRuntimeEnvironment) — no provider credential can leak in
 * by construction (the identical discipline PPR-018..024 established).
 * The only credential-shaped values present are the literal placeholder
 * `zeck-local-adapter` on the app's OWN connection axes that the
 * certified configuration points at the local Zeck adapter
 * (OPENAI_API_KEYS, RAG_OPENAI_API_KEY, IMAGES_OPENAI_API_KEY,
 * AUDIO_STT_OPENAI_API_KEY, AUDIO_TTS_OPENAI_API_KEY) — the value
 * authenticates nothing: the adapter ignores Authorization headers
 * entirely, and no provider host is reachable from the runtime whose
 * every non-loopback egress is denied by the proof proxy (the identical
 * disclosed placeholder pattern PPR-023's openclaw.json5 established).
 *
 * THE CERTIFIED CONFIGURATION (the app's own surface, zero code
 * changes — every axis is a documented Open WebUI environment variable):
 *  - OPENAI_API_BASE_URLS / OPENAI_API_KEYS       — the OpenAI-compatible
 *    connections → the adapter's /v1 (chat + the model catalog);
 *  - OLLAMA_BASE_URLS                             — the LOCAL-INFERENCE
 *    RAIL → the adapter's Ollama-native surface (/api/tags + /api/chat);
 *  - RAG_EMBEDDING_ENGINE=openai + RAG_OPENAI_API_BASE_URL + RAG_EMBEDDING_MODEL
 *    — the RAG embeddings engine → the adapter's /v1/embeddings (the
 *    delegated embeddings edge; the local SentenceTransformers engine is
 *    never selected);
 *  - IMAGE_GENERATION_ENGINE=openai + IMAGES_OPENAI_API_BASE_URL + IMAGE_GENERATION_MODEL
 *    — the image pipeline → the adapter's /v1/images/generations;
 *  - AUDIO_STT_ENGINE=openai + AUDIO_STT_OPENAI_API_BASE_URL — the
 *    transcription pipeline → the adapter's /v1/audio/transcriptions;
 *  - AUDIO_TTS_ENGINE=openai + AUDIO_TTS_OPENAI_API_BASE_URL — the
 *    speech pipeline → the adapter's /v1/audio/speech;
 *  - ENABLE_IMAGE_GENERATION=true; ENABLE_VERSION_UPDATE_CHECK=false
 *    (the version probe is disabled — non-AI, disclosed);
 *  - DATA_DIR/DATABASE_URL — the app's OWN domain state (sqlite in the
 *    per-run workspace), outside Zeck by design.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
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
  MEMORY_A,
  MEMORY_B,
  MEMORY_MARKER,
  MEMORY_QUERY,
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

/** Where the pinned Open WebUI source lives (the exact checkout). */
export const OPENWEBUI_CHECKOUT_DIR = "/home/z/openwebui-upstream" as const;

/** The pinned venv's python (the runtime's interpreter). */
export const OPENWEBUI_PYTHON = "/home/z/ppr-025-venv/bin/python" as const;

/** The proof secret for the app's own JWT surface (never a provider credential). */
export const PROOF_WEBUI_SECRET_KEY = "ppr025-proof-secret-key-3f8c1d9a" as const;

/** Does the pinned Open WebUI runtime exist in this environment (the checkout + the pinned venv)? */
export function existsOpenWebUiRuntime(): boolean {
  return (
    existsSync(OPENWEBUI_PYTHON) &&
    existsSync(join(OPENWEBUI_CHECKOUT_DIR, "backend", "open_webui", "main.py"))
  );
}

/**
 * The provider-credential env-var NAMES the erasure audit records facts
 * for (the harness's reusable list extended with Open WebUI's own
 * provider-credential names at the pinned revision — the alternative
 * audio/image/search provider keys the app would read; the five
 * placeholder-bearing connection axes pointed at the local adapter are
 * disclosed separately, never audited as credentials: their value is
 * the non-authenticating placeholder, exactly the openclaw.json5
 * apiKey pattern PPR-023 established).
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
  // Open WebUI's own provider-credential names (pinned revision):
  "ELEVENLABS_API_KEY",
  "DEEPGRAM_API_KEY",
  "AZURE_API_KEY",
  "AZURE_SPEECH_KEY",
  "AZURE_DOCUMENT_INTELLIGENCE_KEY",
  "COMFYUI_API_KEY",
  "IMAGES_GEMINI_API_KEY",
  "OPENAI_API_KEY_AZURE",
  "TAVILY_API_KEY",
  "BRAVE_SEARCH_API_KEY",
  "SERPER_API_KEY",
  "SERPAPI_API_KEY",
  "SEARCHAPI_API_KEY",
  "EXA_API_KEY",
  "FIRECRAWL_API_KEY",
  "JINA_API_KEY",
  "PERPLEXITY_API_KEY",
  "SEARXNG_QUERY_URL",
  "YOUTUBE_API_KEY",
] as const;

/** The app's connection axes that carry the disclosed placeholder (names only). */
export const PLACEHOLDER_BEARING_AXES: readonly string[] = [
  "OPENAI_API_KEYS",
  "RAG_OPENAI_API_KEY",
  "IMAGES_OPENAI_API_KEY",
  "AUDIO_STT_OPENAI_API_KEY",
  "AUDIO_TTS_OPENAI_API_KEY",
] as const;

/** The app's own non-credential env-var names the allowlist admits (plus the overrides below). */
export const OPENWEBUI_APPLICATION_EXTRAS: readonly string[] = [
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
  readonly workspaceRoot: string;
  /** The app's loopback port (default 18085). */
  readonly appPort?: number;
  /** Per-run wall-clock timeout (ms). Default 420_000. */
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

/** Build the scrubbed certified-runtime environment for one run. */
export function buildOpenWebUiRuntimeEnvironment(options: {
  readonly adapterUrl: string;
  readonly proxyUrl: string;
  readonly workspaceRoot: string;
}): Readonly<Record<string, string>> {
  return buildScrubbedRuntimeEnvironment({
    applicationExtras: [...OPENWEBUI_APPLICATION_EXTRAS],
    source: process.env,
    overrides: {
      // The app's own runtime axes (never provider credentials):
      WEBUI_SECRET_KEY: PROOF_WEBUI_SECRET_KEY,
      DATA_DIR: join(options.workspaceRoot, "data"),
      DATABASE_URL: `sqlite:///${join(options.workspaceRoot, "data", "webui.db")}`,
      PYTHONPATH: `${OPENWEBUI_CHECKOUT_DIR}/backend`,
      PYTHONUNBUFFERED: "1",
      HOST: "127.0.0.1",
      WEBUI_AUTH: "true",
      ENABLE_OLLAMA_API: "true",
      ENABLE_OPENAI_API: "true",
      ENABLE_IMAGE_GENERATION: "true",
      ENABLE_VERSION_UPDATE_CHECK: "false",
      // The OpenAI-compatible connections → the adapter:
      OPENAI_API_BASE_URLS: `${options.adapterUrl}/v1`,
      OPENAI_API_KEYS: CORPUS_API_KEY_PLACEHOLDER,
      // THE LOCAL-INFERENCE RAIL → the adapter's Ollama-native surface:
      OLLAMA_BASE_URLS: options.adapterUrl,
      // The RAG embeddings engine → the adapter (the delegated edge):
      RAG_EMBEDDING_ENGINE: "openai",
      RAG_OPENAI_API_BASE_URL: `${options.adapterUrl}/v1`,
      RAG_OPENAI_API_KEY: CORPUS_API_KEY_PLACEHOLDER,
      RAG_EMBEDDING_MODEL: "zeck-deterministic-embeddings-v1",
      // The image pipeline → the adapter:
      IMAGE_GENERATION_ENGINE: "openai",
      IMAGES_OPENAI_API_BASE_URL: `${options.adapterUrl}/v1`,
      IMAGES_OPENAI_API_KEY: CORPUS_API_KEY_PLACEHOLDER,
      IMAGE_GENERATION_MODEL: "glm-image",
      // The audio pipelines → the adapter:
      AUDIO_STT_ENGINE: "openai",
      AUDIO_STT_OPENAI_API_BASE_URL: `${options.adapterUrl}/v1`,
      AUDIO_STT_OPENAI_API_KEY: CORPUS_API_KEY_PLACEHOLDER,
      AUDIO_STT_MODEL: "glm-asr",
      AUDIO_TTS_ENGINE: "openai",
      AUDIO_TTS_OPENAI_API_BASE_URL: `${options.adapterUrl}/v1`,
      AUDIO_TTS_OPENAI_API_KEY: CORPUS_API_KEY_PLACEHOLDER,
      AUDIO_TTS_MODEL: "glm-tts",
      AUDIO_TTS_VOICE: "tongtong",
      AIOHTTP_CLIENT_TIMEOUT: "300",
      // The app's own documented audio-preprocessing bypass (the exact
      // default its slim profile sets — BYPASS_PYDUB_PREPROCESSING =
      // USE_SLIM or env): the pydub/ffmpeg re-encode the non-slim path
      // applies produces audio the authorized supply's ASR surface
      // rejects (recorded live: invalid-request on the re-encoded chunk,
      // PASS on the original) — the certified configuration passes the
      // app's own committed corpus asset through untouched, exactly the
      // slim profile's behavior. App-owned domain logic either way.
      BYPASS_PYDUB_PREPROCESSING: "true",
      // The proof environment's egress control (the app's aiohttp
      // transports honor trust_env):
      HTTP_PROXY: options.proxyUrl,
      HTTPS_PROXY: options.proxyUrl,
      http_proxy: options.proxyUrl,
      https_proxy: options.proxyUrl,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    },
  });
}

/** The admin signup journey (the app's own first-boot surface). */
export async function signUpAdmin(
  appBaseUrl: string,
  timeoutMs: number,
): Promise<{ readonly token: string; readonly email: string }> {
  const email = "ppr025-proof-admin@zeck.proof";
  const password = "ppr025-proof-admin-password-7f2a";
  const startedAt = Date.now();
  for (;;) {
    let healthy = false;
    try {
      const response = await fetch(`${appBaseUrl}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      healthy = response.ok;
    } catch {
      healthy = false;
    }
    if (healthy) {
      const response = await fetch(`${appBaseUrl}/api/v1/auths/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Proof Admin", email, password }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) {
        const body = (await response.json()) as { readonly token?: unknown };
        if (typeof body.token === "string" && body.token.length > 0) {
          return { token: body.token, email };
        }
      }
      // The signup is idempotent for the first (admin) account; a 400 on
      // a re-run means the account exists — sign in instead.
      const signin = await fetch(`${appBaseUrl}/api/v1/auths/signin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(30_000),
      });
      if (signin.ok) {
        const body = (await signin.json()) as { readonly token?: unknown };
        if (typeof body.token === "string" && body.token.length > 0) {
          return { token: body.token, email };
        }
      }
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`the pinned Open WebUI runtime did not become healthy within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
}

export interface AppClient {
  readonly token: string;
  fetchApp(path: string, init?: RequestInit): Promise<Response>;
}

export function appClientOf(appBaseUrl: string, token: string): AppClient {
  return {
    token,
    async fetchApp(path: string, init: RequestInit = {}): Promise<Response> {
      return fetch(`${appBaseUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body instanceof FormData ? {} : { "content-type": "application/json" }),
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(300_000),
      });
    },
  };
}

/** Wait for the app's model list to include both rails' catalogs (the boot probe). */
async function awaitModelsReady(app: AppClient, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    try {
      const response = await app.fetchApp("/api/v1/models");
      if (response.ok) {
        // The app's compatibility endpoint returns {data: [...]} (the
        // merged OpenAI-shaped + Ollama catalogs — the ollama model ids
        // carry no prefix at the pinned revision).
        const body = (await response.json()) as unknown;
        const list: readonly { readonly id?: unknown }[] = Array.isArray(body)
          ? (body as readonly { readonly id?: unknown }[])
          : ((body as { readonly data?: readonly { readonly id?: unknown }[] }).data ?? []);
        const ids = new Set(list.map((model) => (typeof model.id === "string" ? model.id : "")));
        if (ids.has(CORPUS_MAIN_MODEL) && ids.has(CORPUS_LOCAL_MODEL)) {
          return;
        }
      }
    } catch {
      // not ready yet
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `the app's model catalog did not include both rails' models within ${timeoutMs}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
}

// ---------------------------------------------------------------------------
// The per-task drivers (every task drives the app's OWN HTTP API)
// ---------------------------------------------------------------------------

async function runChatTask(
  app: AppClient,
  model: string,
  marker: string,
): Promise<{ ok: boolean; checkOutput: string }> {
  const response = await app.fetchApp("/api/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: `Reply with exactly the word ${marker} and nothing else.`,
        },
      ],
      stream: false,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    return { ok: false, checkOutput: `HTTP ${response.status}: ${tailOf(text, 400)}` };
  }
  const body = JSON.parse(text) as {
    readonly choices?: readonly { readonly message?: { readonly content?: unknown } }[];
  };
  const content = body.choices?.[0]?.message?.content;
  const assistantText = typeof content === "string" ? content : "";
  const ok = assistantText.includes(marker);
  return {
    ok,
    checkOutput: ok
      ? `assistant content contains ${marker} (${assistantText.length} chars)`
      : `assistant content did not contain ${marker}: ${tailOf(assistantText, 300)}`,
  };
}

async function runTitleTask(app: AppClient): Promise<{ ok: boolean; checkOutput: string }> {
  const response = await app.fetchApp("/api/v1/tasks/title/completions", {
    method: "POST",
    body: JSON.stringify({
      model: CORPUS_MAIN_MODEL,
      messages: [
        {
          role: "user",
          content:
            "What is the primary gate access code of the north harbor station? The manual says the code is AURORA-7741.",
        },
      ],
      chat_id: "ppr-025-title-probe",
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    return { ok: false, checkOutput: `HTTP ${response.status}: ${tailOf(text, 400)}` };
  }
  const body = JSON.parse(text) as {
    readonly choices?: readonly { readonly message?: { readonly content?: unknown } }[];
  };
  const content = body.choices?.[0]?.message?.content;
  const taskText = typeof content === "string" ? content : "";
  const ok = taskText.trim().length > 0;
  return {
    ok,
    checkOutput: ok
      ? `the app's title task produced a non-empty title turn (${taskText.length} chars — the auxiliary model turn on the delegated chat seam)`
      : `the app's title task produced an empty turn: ${tailOf(text, 300)}`,
  };
}

async function runRagTask(app: AppClient): Promise<{ ok: boolean; checkOutput: string }> {
  // 1. Upload the knowledge document through the app's files API.
  const upload = new FormData();
  upload.append(
    "file",
    new Blob([RAG_KNOWLEDGE_DOCUMENT], { type: "text/markdown" }),
    "harbor-operations-manual.md",
  );
  const uploadResponse = await app.fetchApp("/api/v1/files/", { method: "POST", body: upload });
  const uploadText = await uploadResponse.text();
  if (!uploadResponse.ok) {
    return { ok: false, checkOutput: `file upload failed HTTP ${uploadResponse.status}: ${tailOf(uploadText, 300)}` };
  }
  const uploaded = JSON.parse(uploadText) as { readonly id?: unknown };
  const fileId = typeof uploaded.id === "string" ? uploaded.id : "";
  if (fileId.length === 0) {
    return { ok: false, checkOutput: `file upload returned no id: ${tailOf(uploadText, 300)}` };
  }
  // 2. Ask the grounded question with the file attached (the app embeds
  //    the document at upload, embeds the query, retrieves through its
  //    own vector pipeline and answers grounded).
  const chatResponse = await app.fetchApp("/api/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: CORPUS_MAIN_MODEL,
      messages: [{ role: "user", content: RAG_QUESTION }],
      files: [{ type: "file", id: fileId, name: "harbor-operations-manual.md" }],
      stream: false,
    }),
  });
  const chatText = await chatResponse.text();
  if (!chatResponse.ok) {
    return { ok: false, checkOutput: `grounded chat failed HTTP ${chatResponse.status}: ${tailOf(chatText, 400)}` };
  }
  const body = JSON.parse(chatText) as {
    readonly choices?: readonly { readonly message?: { readonly content?: unknown } }[];
  };
  const content = body.choices?.[0]?.message?.content;
  const assistantText = typeof content === "string" ? content : "";
  const ok = assistantText.includes(RAG_KNOWLEDGE_TOKEN);
  return {
    ok,
    checkOutput: ok
      ? `the grounded answer contains the document's distinctive gate code ${RAG_KNOWLEDGE_TOKEN} (the app's own RAG pipeline: upload-embed → query-embed → vector retrieval → grounded chat)`
      : `the grounded answer did not contain ${RAG_KNOWLEDGE_TOKEN}: ${tailOf(assistantText, 400)}`,
  };
}

async function runMemoriesTask(app: AppClient): Promise<{ ok: boolean; checkOutput: string }> {
  for (const content of [MEMORY_A, MEMORY_B]) {
    const add = await app.fetchApp("/api/v1/memories/add", {
      method: "POST",
      body: JSON.stringify({ content }),
    });
    if (!add.ok) {
      return { ok: false, checkOutput: `memory add failed HTTP ${add.status}: ${tailOf(await add.text(), 300)}` };
    }
  }
  const query = await app.fetchApp("/api/v1/memories/query", {
    method: "POST",
    body: JSON.stringify({ content: MEMORY_QUERY, k: 2 }),
  });
  const queryText = await query.text();
  if (!query.ok) {
    return { ok: false, checkOutput: `memory query failed HTTP ${query.status}: ${tailOf(queryText, 300)}` };
  }
  const body = JSON.parse(queryText) as {
    readonly documents?: readonly (readonly (string | undefined)[])[];
    readonly ids?: readonly (readonly (string | undefined)[])[];
  };
  const topDoc = body.documents?.[0]?.[0] ?? null;
  const ok = typeof topDoc === "string" && topDoc.includes(MEMORY_MARKER);
  return {
    ok,
    checkOutput: ok
      ? `the memory query's top-ranked document carries ${MEMORY_MARKER} (the pure embedding journey: add-embed → query-embed → vector search, no chat turn)`
      : `the top-ranked memory document did not carry ${MEMORY_MARKER}: ${tailOf(String(topDoc), 300)}`,
  };
}

async function runImageTask(app: AppClient): Promise<{ ok: boolean; checkOutput: string }> {
  const response = await app.fetchApp("/api/v1/images/generations", {
    method: "POST",
    body: JSON.stringify({
      model: "glm-image",
      prompt: "a red lighthouse on a rocky cliff at dawn, calm sea",
      n: 1,
      size: "512x512",
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    return { ok: false, checkOutput: `image generation failed HTTP ${response.status}: ${tailOf(text, 400)}` };
  }
  const body = JSON.parse(text) as readonly { readonly url?: unknown }[];
  const first = body[0];
  const url = typeof first?.url === "string" ? first.url : "";
  const ok = url.length > 0;
  return {
    ok,
    checkOutput: ok
      ? `the app returned a generated image file reference (${url.length}-char url; the app stored the delegated image bytes in its own file store)`
      : `no image reference in the response: ${tailOf(text, 300)}`,
  };
}

async function runTranscriptionTask(app: AppClient): Promise<{ ok: boolean; checkOutput: string }> {
  const wav = readKnownPhraseWav();
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "known-phrase.wav");
  const response = await app.fetchApp("/api/v1/audio/transcriptions", { method: "POST", body: form });
  const text = await response.text();
  if (!response.ok) {
    return { ok: false, checkOutput: `transcription failed HTTP ${response.status}: ${tailOf(text, 400)}` };
  }
  const body = JSON.parse(text) as { readonly text?: unknown };
  const transcript = typeof body.text === "string" ? body.text : "";
  const ok = transcript.toLowerCase().includes(KNOWN_PHRASE_MARKER.toLowerCase());
  return {
    ok,
    checkOutput: ok
      ? `the transcript contains the known-phrase marker "${KNOWN_PHRASE_MARKER}" (transcript: ${tailOf(transcript, 200)})`
      : `the transcript did not contain the marker: ${tailOf(transcript, 300)}`,
  };
}

async function runSpeechTask(app: AppClient): Promise<{ ok: boolean; checkOutput: string }> {
  const response = await app.fetchApp("/api/v1/audio/speech", {
    method: "POST",
    body: JSON.stringify({
      model: "glm-tts",
      input: "The harbor gate opens at six.",
      voice: "tongtong",
    }),
  });
  if (!response.ok) {
    return { ok: false, checkOutput: `speech failed HTTP ${response.status}: ${tailOf(await response.text(), 400)}` };
  }
  const contentType = response.headers.get("content-type") ?? "";
  const bytes = new Uint8Array(await response.arrayBuffer());
  const ok = bytes.length > 1000 && contentType.startsWith("audio/");
  return {
    ok,
    checkOutput: ok
      ? `the speech API returned ${bytes.length} audio bytes (content-type ${contentType})`
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

/**
 * Drive the corpus tasks against an ALREADY-BOOTED app (signed-in
 * client): the per-task drivers, the mechanical checks and the
 * per-task fact recording (shared verbatim by the certified run and
 * the non-Zeck baseline arms — the same corpus, the same checks).
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
    adapter.setRunContext({ corpusTask: task.taskId, runLabel: `ppr-025-${task.taskId}` });
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

/** Drive ONE task's app-level journey (the mechanical check). */
async function driveOneTask(
  appBaseUrl: string,
  client: AppClient,
  task: CorpusTask,
): Promise<{ ok: boolean; checkOutput: string }> {
  switch (task.taskId) {
    case "openwebui-chat-basic":
      return runChatTask(client, CORPUS_MAIN_MODEL, CHAT_MARKER);
    case "openwebui-chat-auxiliary":
      return runTitleTask(client);
    case "openwebui-rag-grounded-qa":
      return runRagTask(client);
    case "openwebui-memories-embeddings":
      return runMemoriesTask(client);
    case "openwebui-image-generation":
      return runImageTask(client);
    case "openwebui-audio-transcription":
      return runTranscriptionTask(client);
    case "openwebui-audio-speech":
      return runSpeechTask(client);
    case "openwebui-local-rail-chat":
      // The app's merged catalog carries the ollama model ids WITHOUT a
      // prefix at the pinned revision (utils/models.py
      // fetch_ollama_models: id = model['model']).
      return runChatTask(client, CORPUS_LOCAL_MODEL, LOCAL_RAIL_MARKER);
    default:
      return {
        ok: false,
        checkOutput: `the corpus runner carries no driver for task ${task.taskId}`,
      };
  }
}

/**
 * Boot the pinned Open WebUI runtime with an explicit environment (the
 * certified scrubbed environment OR a baseline arm's environment).
 */
export interface BootedApp {
  readonly appBaseUrl: string;
  readonly stop: () => Promise<void>;
  readonly stdoutTail: () => string;
  readonly stderrTail: () => string;
}

export async function bootOpenWebUiApp(options: {
  readonly env: Readonly<Record<string, string>>;
  readonly appPort: number;
  readonly workspaceRoot: string;
}): Promise<BootedApp> {
  mkdirSync(join(options.workspaceRoot, "data"), { recursive: true });
  const appPort = options.appPort;
  const appBaseUrl = `http://127.0.0.1:${appPort}`;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const app: ChildProcess = spawn(
    OPENWEBUI_PYTHON,
    [
      "-m",
      "uvicorn",
      "open_webui.main:app",
      "--host",
      "127.0.0.1",
      "--port",
      String(appPort),
      "--ws-per-message-deflate",
      "false",
    ],
    { env: { ...options.env } as Record<string, string>, cwd: OPENWEBUI_CHECKOUT_DIR, stdio: ["ignore", "pipe", "pipe"] },
  );
  app.stdout?.on("data", (chunk: Buffer) => {
    stdout.push(chunk.toString("utf8"));
    if (stdout.length > 400) {
      stdout.splice(0, stdout.length - 400);
    }
  });
  app.stderr?.on("data", (chunk: Buffer) => {
    stderr.push(chunk.toString("utf8"));
    if (stderr.length > 400) {
      stderr.splice(0, stderr.length - 400);
    }
  });

  const stop = async (): Promise<void> => {
    if (app.exitCode === null) {
      app.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          app.kill("SIGKILL");
          resolve();
        }, 10_000);
        app.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };
  return {
    appBaseUrl,
    stop,
    stdoutTail: () => tailOf(stdout.join("")),
    stderrTail: () => tailOf(stderr.join("")),
  };
}

/**
 * Run the corpus against the booted pinned runtime. Boots the app, signs
 * up the proof admin, runs every task mechanically, and records the
 * per-task facts. The app process is ALWAYS stopped in finally.
 */
export async function runCorpusTasks(
  options: CorpusRunnerOptions,
  tasks: readonly CorpusTask[],
): Promise<readonly CorpusTaskOutcome[]> {
  const appPort = options.appPort ?? 18085;
  const env = buildOpenWebUiRuntimeEnvironment({
    adapterUrl: options.adapter.url,
    proxyUrl: options.proxy.url,
    workspaceRoot: options.workspaceRoot,
  });
  const booted = await bootOpenWebUiApp({ env, appPort, workspaceRoot: options.workspaceRoot });
  try {
    const admin = await signUpAdmin(booted.appBaseUrl, 120_000);
    const client = appClientOf(booted.appBaseUrl, admin.token);
    await awaitModelsReady(client, 120_000);
    const outcomes = await driveCorpusTasksAgainstClient(booted.appBaseUrl, client, tasks, {
      adapter: options.adapter,
      proxy: options.proxy,
      railFacts: options.railFacts,
      deterministicFacts: options.deterministicFacts,
      ...(options.interTaskDelayMs === undefined ? {} : { interTaskDelayMs: options.interTaskDelayMs }),
      ...(options.preTaskGuard === undefined ? {} : { preTaskGuard: options.preTaskGuard }),
      ...(options.onTaskComplete === undefined ? {} : { onTaskComplete: options.onTaskComplete }),
    });
    // Decorate the outcomes with the app's process tails (the certified
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
