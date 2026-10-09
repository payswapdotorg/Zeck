/**
 * The PPR-025 representative corpus — eight tasks exercising EVERY
 * declared material AI edge of the pinned Open WebUI runtime through
 * the app's OWN HTTP API (the exact journeys a user drives):
 *
 *  1. openwebui-chat-basic          — the main chat turn (openai rail)
 *  2. openwebui-chat-auxiliary      — the app's own title-generation
 *                                      task turn (the auxiliary chat
 *                                      role on the SAME openai seam)
 *  3. openwebui-rag-grounded-qa     — the RAG journey: upload a
 *                                      knowledge file, ask a grounded
 *                                      question, the answer quotes the
 *                                      document's distinctive token
 *                                      (embeddings + retrieval + chat)
 *  4. openwebui-memories-embeddings — the PURE embedding journey: add
 *                                      two memories, query, the right
 *                                      memory ranks first (embeddings
 *                                      only — no chat turn)
 *  5. openwebui-image-generation    — the image generation pipeline
 *                                      (the app's image API → the
 *                                      delegated image edge)
 *  6. openwebui-audio-transcription — the STT journey over the
 *                                      committed known-phrase asset
 *                                      (the app's transcription API)
 *  7. openwebui-audio-speech        — the TTS journey (the app's
 *                                      speech API → audio bytes)
 *  8. openwebui-local-rail-chat     — THE LOCAL-INFERENCE RAIL: a chat
 *                                      turn with the ollama/* model
 *                                      from the local-rail catalog —
 *                                      Open WebUI believes it talks to
 *                                      a customer-local Ollama server;
 *                                      Zeck owns the execution (the
 *                                      work order's binding law)
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

/** The committed STT asset (generated + ASR-round-trip-verified at proof time by scripts/ppr025-build-audio-asset.ts). */
export const KNOWN_PHRASE_WAV = join(CORPUS_ROOT, "assets", "known-phrase.wav");
/** The pinned corpus phrase (the STT task's known transcript). */
export const KNOWN_PHRASE = "The passphrase is golden harbor seven two nine.";
/** The distinctive token pair the STT mechanical check requires. */
export const KNOWN_PHRASE_MARKER = "golden harbor";

/** The RAG knowledge document's distinctive token (the grounded-answer check). */
export const RAG_KNOWLEDGE_TOKEN = "AURORA-7741";

/** The RAG knowledge document (uploaded through the app's files API). */
export const RAG_KNOWLEDGE_DOCUMENT = `Harbor Operations Manual — North Station

Access codes and operating procedures for the north harbor station.

The primary gate access code is ${RAG_KNOWLEDGE_TOKEN}. This code opens
the northern gate between 06:00 and 22:00. Never share the gate code
over radio channels.

The secondary lighthouse frequency is 412 kilohertz and is monitored
continuously by the watch officer. The mooring checklist must be
completed before any vessel departure.

Reminder: the winter schedule reduces gate hours to 08:00 through 18:00.
` as const;

/** The RAG question (lexically overlapping the knowledge document). */
export const RAG_QUESTION = "What is the primary gate access code of the north harbor station? Answer with the code.";

/** The memories-journey tokens. */
export const MEMORY_A = "The harbor gate code is MOONRISE-4413.";
export const MEMORY_B = "The lighthouse frequency is 412 kilohertz.";
export const MEMORY_QUERY = "What is the harbor gate code?";
export const MEMORY_MARKER = "MOONRISE-4413";

/** The chat task's deterministic echo marker. */
export const CHAT_MARKER = "NORTHWIND";

/** The local-rail task's deterministic echo marker. */
export const LOCAL_RAIL_MARKER = "SIGNAL-LANTERN";

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
    taskId: "openwebui-chat-basic",
    title: "Chat completion over the OpenAI-compatible connection",
    instruction:
      "Sign in as the proof admin, call the app's chat API (POST /api/chat/completions) with the glm-4-plus model and the user message 'Reply with exactly the word NORTHWIND and nothing else.' — the assistant content must contain NORTHWIND.",
    edges: ["openwebui.chat.openai-rail"],
  },
  {
    taskId: "openwebui-chat-auxiliary",
    title: "The app's own title-generation task turn",
    instruction:
      "Create a chat with a first message about harbor operations, then request the app's title generation (POST /api/v1/tasks/title) — the app's own task pipeline must produce a non-empty title (an auxiliary model turn on the same delegated chat seam).",
    edges: ["openwebui.chat.openai-rail"],
  },
  {
    taskId: "openwebui-rag-grounded-qa",
    title: "RAG: upload a knowledge file and answer a grounded question",
    instruction:
      `Upload the Harbor Operations Manual as a file, then ask through the chat API with the file attached: "${RAG_QUESTION}" — the assistant content must contain the document's distinctive gate code ${RAG_KNOWLEDGE_TOKEN} (the app embeds the document, embeds the query, retrieves through its own vector pipeline and answers grounded).`,
    edges: ["openwebui.chat.openai-rail", "openwebui.rag.embeddings"],
  },
  {
    taskId: "openwebui-memories-embeddings",
    title: "Memories: the pure embedding journey",
    instruction:
      `Add two memories ("${MEMORY_A}" and "${MEMORY_B}") through the app's memories API (each stored with its embedding), then query "${MEMORY_QUERY}" — the top-ranked memory document must be the one carrying ${MEMORY_MARKER} (a pure embedding-dependent journey: no chat turn).`,
    edges: ["openwebui.rag.embeddings"],
  },
  {
    taskId: "openwebui-image-generation",
    title: "Image generation through the app's image API",
    instruction:
      "Call the app's image generation API (POST /api/v1/images/generations) with prompt 'a red lighthouse on a rocky cliff at dawn, calm sea' and size 512x512 — the app must return a generated image (data URL or file reference with non-trivial image bytes).",
    edges: ["openwebui.images.openai-generate"],
  },
  {
    taskId: "openwebui-audio-transcription",
    title: "Speech-to-text over the committed known-phrase asset",
    instruction:
      `POST the committed known-phrase.wav to the app's audio transcription API (multipart /api/v1/audio/transcriptions) — the transcript must contain the marker "${KNOWN_PHRASE_MARKER}".`,
    edges: ["openwebui.audio.stt-openai"],
  },
  {
    taskId: "openwebui-audio-speech",
    title: "Text-to-speech through the app's speech API",
    instruction:
      "Call the app's speech API (POST /api/v1/audio/speech) with the input 'The harbor gate opens at six.' — the response must be non-empty audio bytes with an audio content type.",
    edges: ["openwebui.audio.tts-openai"],
  },
  {
    taskId: "openwebui-local-rail-chat",
    title: "THE LOCAL-INFERENCE RAIL: chat with the ollama/* model",
    instruction:
      `Call the app's chat API with the ollama model ${CORPUS_LOCAL_MODEL} (from the local-rail /api/tags catalog) and the user message 'Reply with exactly the word SIGNAL-LANTERN and nothing else.' — the assistant content must contain SIGNAL-LANTERN (Open WebUI's local-inference path, delegated through the same boundary).`,
    edges: ["openwebui.chat.local-rail"],
  },
] as const;

/** The task the Demo Mirror runs by default (the binding's representative). */
export const REPRESENTATIVE_TASK_ID = "openwebui-rag-grounded-qa" as const;

/** Read the committed STT asset's bytes (the corpus input, provenance-recorded). */
export function readKnownPhraseWav(): Buffer {
  return readFileSync(KNOWN_PHRASE_WAV);
}

/** Every edge the corpus exercises (the actually-active set). */
export const CORPUS_EXERCISED_EDGE_IDS: readonly string[] = [
  ...new Set(CORPUS_TASKS.flatMap((task) => [...task.edges])),
];
