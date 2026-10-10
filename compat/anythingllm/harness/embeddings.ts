/**
 * The Zeck-side DETERMINISTIC embeddings executor for PPR-026 — the
 * honest execution representation of the delegated
 * `anythingllm.rag.embeddings` edge at this sandbox's authorized supply.
 *
 * THE BOUNDARY (recorded, never weakened): the authorized GLM supply
 * endpoint exposes NO embeddings execution surface — probed live at
 * proof time: POST {base}/embeddings → HTTP 404 (the identical boundary
 * PPR-021 recorded for Continue's embeddings edge and PPR-025 recorded
 * for Open WebUI's). Under ACR-007 §10 ("Zeck is the authority for how a
 * delegated AI execution is realized, including provider/model/tool/
 * agent execution strategy"), the Zeck-side executor for the embeddings
 * edge runs the DETERMINISTIC lexical-hash embedding strategy:
 *
 *  - a REAL, deterministic, reproducible computation (no model call, no
 *    network, no simulation): lowercased token unigrams + bigrams are
 *    feature-hashed (SHA-256 → 32-bit bucket, signed by a second hash
 *    bit) into a fixed 512-dimension vector, weighted by sublinear term
 *    frequency, then L2-normalized — the same lexical-overlap retrieval
 *    family the pinned AnythingLLM runtime itself relies on for its
 *    default LanceDB vector similarity search (cosine distance over
 *    embedded chunks) and the platform's own deterministic
 *    document-retrieval capability (the rag workload family the
 *    validation program runs as `runnable`);
 *  - honestly routed: the planning decision records strategyClass
 *    "deterministic-embeddings" with modelCalls 0 — never a model-rail
 *    identity; the execution verification is mechanical (fixed
 *    dimension, unit norm, byte-identical across replays);
 *  - the corpus's RAG journey genuinely retrieves the knowledge document
 *    through AnythingLLM's own pipeline over these real vectors (the
 *    query embed rides the same edge; lexical overlap between the corpus
 *    question and the knowledge document's distinctive tokens is the
 *    retrieval signal — the same signal class BM25 uses, disclosed here
 *    as the strategy's basis).
 *
 * A model-backed embeddings rail remains a named operator-provider
 * boundary (owner: Lead): an authorized embeddings-capable supply would
 * switch this edge's representation without touching the delegation
 * boundary, the adapter or the application.
 *
 * Pure and total: same input → same output, always (the tests pin it).
 */

import { createHash } from "node:crypto";
import { DETERMINISTIC_EMBEDDINGS_DIMENSIONS } from "./zai-config";

// Re-exported for the tests' property pinning (the single source stays zai-config).
export { DETERMINISTIC_EMBEDDINGS_DIMENSIONS };

/** The strategy identity the planning decisions + evidence record. */
export const DETERMINISTIC_EMBEDDINGS_STRATEGY = {
  strategyId: "ppr-026-deterministic-embeddings",
  strategyClass: "deterministic-embeddings",
} as const;

/** Tokenize one text into lowercased lexical tokens (words + bigrams). */
export function tokenize(text: string): readonly string[] {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
  const tokens = [...words];
  for (let index = 0; index + 1 < words.length; index += 1) {
    tokens.push(`${words[index]}_${words[index + 1]}`);
  }
  return tokens;
}

/** The deterministic feature bucket of one token (SHA-256 → signed 32-bit). */
function bucketOf(token: string): { readonly index: number; readonly sign: number } {
  const digest = createHash("sha256").update(token, "utf8").digest();
  const index = digest.readUInt32BE(0) % DETERMINISTIC_EMBEDDINGS_DIMENSIONS;
  const signBit = digest[4] ?? 0;
  const sign = (signBit & 1) === 1 ? 1 : -1;
  return { index, sign };
}

/**
 * The deterministic embedding of one text: sublinear-TF weighted signed
 * feature hashing over lexical tokens, L2-normalized, fixed dimension.
 */
export function deterministicEmbeddingOf(text: string): readonly number[] {
  const vector = new Array<number>(DETERMINISTIC_EMBEDDINGS_DIMENSIONS).fill(0);
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  for (const [token, count] of counts) {
    const weight = 1 + Math.log(count);
    const { index, sign } = bucketOf(token);
    vector[index] = (vector[index] ?? 0) + sign * weight;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    return vector;
  }
  return vector.map((value) => value / norm);
}

/** The mechanical verification of one embedding vector (well-formedness). */
export function isWellFormedEmbedding(
  vector: readonly unknown[],
): { readonly ok: boolean; readonly detail: string } {
  if (!Array.isArray(vector) || vector.length !== DETERMINISTIC_EMBEDDINGS_DIMENSIONS) {
    return {
      ok: false,
      detail: `expected a ${DETERMINISTIC_EMBEDDINGS_DIMENSIONS}-dimension vector, received ${
        Array.isArray(vector) ? vector.length : "a non-array"
      }`,
    };
  }
  for (const value of vector) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { ok: false, detail: "vector carries a non-finite value" };
    }
  }
  const norm = Math.sqrt(
    vector.reduce((sum, value) => sum + (value as number) ** 2, 0),
  );
  if (Math.abs(norm - 1) > 1e-6) {
    return { ok: false, detail: `vector is not L2-normalized (norm ${norm})` };
  }
  return { ok: true, detail: "fixed-dimension L2-normalized deterministic vector" };
}

/** The cosine similarity of two equal-dimension vectors (pure). */
export function cosineSimilarityOf(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    dot += (a[index] ?? 0) * (b[index] ?? 0);
    normA += (a[index] ?? 0) ** 2;
    normB += (b[index] ?? 0) ** 2;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

/** The result fact the executor records on the execution's public ledger. */
export interface DeterministicEmbeddingsResult {
  readonly embeddings: readonly (readonly number[])[];
  readonly dimensions: number;
  readonly modelCalls: 0;
  readonly deterministic: true;
  readonly strategy: string;
}
