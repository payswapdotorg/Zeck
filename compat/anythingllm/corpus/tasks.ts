/**
 * The PPR-026 representative corpus — six tasks exercising EVERY
 * declared material AI edge of the pinned AnythingLLM runtime (v1.17.0,
 * fa7ec877) through the app's OWN HTTP API (the exact journeys a user
 * drives):
 *
 *  1. anythingllm-chat-basic          — the main chat turn over the
 *                                       developer API (the generic-openai
 *                                       REMOTE rail)
 *  2. anythingllm-embed-document      — the PURE embedding journey:
 *                                       upload a text document, embed it
 *                                       into a workspace, the app's own
 *                                       vector-count API must report the
 *                                       new vectors (embeddings only —
 *                                       no chat turn)
 *  3. anythingllm-rag-grounded-qa     — the RAG journey: upload a
 *                                       knowledge document, embed it,
 *                                       ask a grounded question, the
 *                                       answer quotes the document's
 *                                       distinctive token (embeddings +
 *                                       retrieval + chat)
 *  4. anythingllm-audio-transcription — the STT journey over the
 *                                       committed known-phrase asset
 *                                       (the app's transcription route)
 *  5. anythingllm-audio-speech        — the TTS journey: a chat turn,
 *                                       then the app's own
 *                                       chat-response speech route →
 *                                       audio bytes
 *  6. anythingllm-local-rail-chat     — THE LOCAL-INFERENCE RAIL: a chat
 *                                       turn on a workspace whose
 *                                       per-workspace provider override
 *                                       selects the Ollama connector and
 *                                       the adapter-served zeck-local
 *                                       model — AnythingLLM believes it
 *                                       talks to a customer-local Ollama
 *                                       server; Zeck owns the execution
 *                                       (the work order's binding law)
 *
 * Every task's success check is MECHANICAL (a declared token/shape the
 * app's own API returns) — the corpus's own success definition, never a
 * Zeck verification authority.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The corpus root (this file's directory). */
const CORPUS_ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * The committed STT asset — the IDENTICAL bytes of PPR-025's committed
 * known-phrase.wav (the same authorized supply's ASR surface,
 * live-round-trip-verified at PPR-025 proof time; re-verified live at
 * PPR-026 proof time by the corpus run itself — the transcript check
 * below). Provenance: generated from the supply's own TTS surface
 * (scripts/ppr025-build-audio-asset.ts) and committed once.
 */
export const KNOWN_PHRASE_WAV = join(CORPUS_ROOT, "assets", "known-phrase.wav");
/** The pinned corpus phrase (the STT task's known transcript). */
export const KNOWN_PHRASE = "The passphrase is golden harbor seven two nine.";
/** The distinctive token pair the STT mechanical check requires. */
export const KNOWN_PHRASE_MARKER = "golden harbor";

/** The RAG knowledge document's distinctive token (the grounded-answer check). */
export const RAG_KNOWLEDGE_TOKEN = "MERIDIAN-3391";

/** The RAG knowledge document (uploaded through the app's document API). */
export const RAG_KNOWLEDGE_DOCUMENT = `Lighthouse Operations Manual — Meridian Station

Gate access codes and watch procedures for the meridian lighthouse station.

The primary gate access code is ${RAG_KNOWLEDGE_TOKEN}. The gate code
${RAG_KNOWLEDGE_TOKEN} opens the station gate between 05:00 and 23:00.
Never share the gate code over radio channels. The gate code is required
for every watch change at the station gate.

The secondary beacon frequency is 412 kilohertz and is monitored
continuously by the watch officer. The mooring checklist must be
completed before any vessel departure from the station.
` as const;

/** The RAG question (lexically overlapping the knowledge document). */
export const RAG_QUESTION =
  "What is the primary gate access code of the meridian lighthouse station? Answer with the code.";

/** The chat task's deterministic echo marker. */
export const CHAT_MARKER = "EASTGALE";

/** The local-rail task's deterministic echo marker. */
export const LOCAL_RAIL_MARKER = "MOONGLASS";

/** The model ids the certified configuration exposes (the adapter's catalogs). */
export const CORPUS_MAIN_MODEL = "glm-4-plus" as const;
export const CORPUS_LOCAL_MODEL = "zeck-local:8b" as const;
/** The non-empty placeholder the OpenAI-compatible clients require (authenticates nothing). */
export const CORPUS_API_KEY_PLACEHOLDER = "zeck-local-adapter" as const;

/** One representative corpus task (the harness's PinnedRuntimeTask). */
export interface CorpusTask {
  readonly taskId: string;
  readonly title: string;
  readonly instruction: string;
  /** The declared edges this task exercises (coverage declaration). */
  readonly edges: readonly string[];
}

/** The representative corpus (stable order). */
export const CORPUS_TASKS: readonly CorpusTask[] = [
  {
    taskId: "anythingllm-chat-basic",
    title: "Chat completion over the generic-openai connection",
    instruction:
      "Create a workspace through the developer API, then ask through the workspace chat API (POST /api/v1/workspace/:slug/chat, mode 'chat') 'Reply with exactly the word EASTGALE and nothing else.' — the textResponse must contain EASTGALE.",
    edges: ["anythingllm.chat.openai-rail"],
  },
  {
    taskId: "anythingllm-embed-document",
    title: "Document embedding: the pure embedding journey",
    instruction:
      "Create a fresh workspace, read the app's total vector count (GET /api/v1/system/vector-count), upload a text document (POST /api/v1/document/upload), embed it into the workspace (POST /api/v1/workspace/:slug/update-embeddings), then re-read the vector count — it must have grown by at least one vector (the app's own vector pipeline over the delegated embeddings edge; no chat turn).",
    edges: ["anythingllm.rag.embeddings"],
  },
  {
    taskId: "anythingllm-rag-grounded-qa",
    title: "RAG: embed a knowledge file and answer a grounded question",
    instruction:
      `Create a workspace, upload the Lighthouse Operations Manual as a document, embed it into the workspace, then ask through the workspace chat API: "${RAG_QUESTION}" — the textResponse must contain the document's distinctive gate code ${RAG_KNOWLEDGE_TOKEN} (the app embeds the document, embeds the query, retrieves through its own LanceDB vector pipeline and answers grounded).`,
    edges: ["anythingllm.chat.openai-rail", "anythingllm.rag.embeddings"],
  },
  {
    taskId: "anythingllm-audio-transcription",
    title: "Speech-to-text over the committed known-phrase asset",
    instruction:
      `POST the committed known-phrase.wav to the app's transcription route (multipart POST /api/system/transcribe-audio, field 'audio') — the transcript must contain the marker "${KNOWN_PHRASE_MARKER}".`,
    edges: ["anythingllm.audio.stt-generic"],
  },
  {
    taskId: "anythingllm-audio-speech",
    title: "Text-to-speech of a stored chat response",
    instruction:
      "Create a workspace, send a chat turn (the stored response is what the app synthesizes), then call the app's own chat-response speech route (GET /api/workspace/:slug/tts/:chatId) — the response must be non-empty audio bytes with an audio content type.",
    edges: ["anythingllm.audio.tts-generic", "anythingllm.chat.openai-rail"],
  },
  {
    taskId: "anythingllm-local-rail-chat",
    title: "THE LOCAL-INFERENCE RAIL: chat through the Ollama connector",
    instruction:
      `Create a workspace whose per-workspace provider override selects the Ollama connector with the model ${CORPUS_LOCAL_MODEL} (chatProvider 'ollama', chatModel '${CORPUS_LOCAL_MODEL}', chatMode 'chat'), then ask 'Reply with exactly the word MOONGLASS and nothing else.' — the textResponse must contain MOONGLASS (AnythingLLM's local-inference path, delegated through the same boundary).`,
    edges: ["anythingllm.chat.local-rail"],
  },
] as const;

/** The task the Demo Mirror runs by default (the binding's representative). */
export const REPRESENTATIVE_TASK_ID = "anythingllm-rag-grounded-qa" as const;

/** Read the committed STT asset's bytes (the corpus input, provenance-recorded). */
export function readKnownPhraseWav(): Buffer {
  return readFileSync(KNOWN_PHRASE_WAV);
}

/** Every edge the corpus exercises (the actually-active set). */
export const CORPUS_EXERCISED_EDGE_IDS: readonly string[] = [
  ...new Set(CORPUS_TASKS.flatMap((task) => [...task.edges])),
];
