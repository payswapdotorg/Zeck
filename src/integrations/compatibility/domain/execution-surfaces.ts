/**
 * The ACR-006 execution-surface taxonomy (§1) — the ADDITIVE compatibility
 * vocabulary every external application is audited against.
 *
 * WHAT THIS IS: the machine-readable inventory of execution surfaces a
 * pinned external application's material AI-execution edges can occupy
 * (application component → execution surface → transport/adapter →
 * external AI execution). A surface names WHAT KIND of AI execution the
 * edge terminates in — never which provider, never which model, never
 * which rail: provider/model identifiers stay opaque neutral strings
 * elsewhere in the record (M17 discipline, imported from the platform's
 * public wire contract).
 *
 * WHAT THIS IS NOT (the additive rule): this vocabulary does NOT replace,
 * weaken, re-interpret or extend the existing 22-family workload-family
 * manifest (`docs/developer/machine/capability-manifest.json` — the
 * capability/availability authority). The manifest answers "which workload
 * families can the PLATFORM execute and what is honestly available"; the
 * surface taxonomy answers "which kinds of AI execution edges does an
 * EXTERNAL APPLICATION contain". The two vocabularies coexist by design:
 * classifying an application edge as, say, `embeddings` asserts nothing
 * about platform capability availability, and a platform family's
 * recorded availability gap is never converted into an application-side
 * pass (or fail) by this vocabulary. No mapping table between the two
 * vocabularies is asserted here — a mapping would be a compatibility
 * claim, which only a full evidence record can make.
 *
 * The 20 surfaces below are verbatim ACR-006 §1 (order preserved).
 */

/**
 * The execution-surface vocabulary (ACR-006 §1, all 20 surfaces).
 * Machine-readable, frozen by the approved ACR — additive only.
 */
export const EXECUTION_SURFACES = [
  "text-generation",
  "structured-generation",
  "vision-image-understanding",
  "embeddings",
  "reranking",
  "retrieval-context-computation",
  "speech-recognition",
  "speech-generation",
  "image-generation",
  "video-generation",
  "three-d-generation",
  "realtime-multimodal-session",
  "search-ai-search",
  "extraction-document-intelligence",
  "browser-use-intelligence",
  "computer-use-intelligence",
  "agent-delegation",
  "deterministic-computation",
  "sandbox-program-execution",
  "human-escalation",
] as const;

/** One execution surface of the ACR-006 vocabulary. */
export type ExecutionSurface = (typeof EXECUTION_SURFACES)[number];

/** Total type guard for the frozen vocabulary. */
export function isExecutionSurface(value: unknown): value is ExecutionSurface {
  return typeof value === "string" && (EXECUTION_SURFACES as readonly string[]).includes(value);
}

/** The human-readable label for one surface (presentation only). */
export const EXECUTION_SURFACE_LABELS: Readonly<Record<ExecutionSurface, string>> = {
  "text-generation": "Text generation",
  "structured-generation": "Structured generation",
  "vision-image-understanding": "Vision / image understanding",
  embeddings: "Embeddings",
  reranking: "Reranking",
  "retrieval-context-computation": "Retrieval / context computation",
  "speech-recognition": "Speech recognition",
  "speech-generation": "Speech generation",
  "image-generation": "Image generation",
  "video-generation": "Video generation",
  "three-d-generation": "3D generation",
  "realtime-multimodal-session": "Realtime multimodal session",
  "search-ai-search": "Search / AI search",
  "extraction-document-intelligence": "Extraction / document intelligence",
  "browser-use-intelligence": "Browser-use intelligence",
  "computer-use-intelligence": "Computer-use intelligence",
  "agent-delegation": "Agent delegation",
  "deterministic-computation": "Deterministic computation",
  "sandbox-program-execution": "Sandbox / program execution",
  "human-escalation": "Human escalation",
};

/**
 * The vocabulary's own provenance statement (rendered verbatim wherever
 * the taxonomy is presented — the additive-to-the-manifest rule stays
 * visible in every projection).
 */
export const EXECUTION_SURFACE_TAXONOMY_NOTE =
  "Additive ACR-006 execution-surface vocabulary for auditing external applications. It does not replace or reinterpret the platform's 22-family workload capability manifest; a surface classification asserts nothing about platform availability.";
