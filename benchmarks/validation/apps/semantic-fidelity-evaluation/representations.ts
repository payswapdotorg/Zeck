/**
 * The two representations the quality fixtures compare (PCS-004 —
 * ACR-009 §6 "quality fixtures"; the measurable-distinction design).
 *
 * THE DETERMINISTIC SUBSTITUTE — THE REAL ARTICLE (never a strawman):
 * the PPR-025 Zeck-side deterministic embeddings executor
 * (`compat/openwebui/harness/embeddings.ts`, imported READ-ONLY — the
 * exact executor that executed the delegated `openwebui.rag.embeddings`
 * edge at the PPR-025 proof and is recorded on the era's evidence; the
 * PPR-026 anythingllm executor runs the identical arithmetic with its
 * own strategy identity). Lowercased unigram+bigram tokens are
 * feature-hashed (SHA-256 → 32-bit bucket, signed by a second hash
 * bit) into a fixed 512-dimension vector, weighted by sublinear term
 * frequency, then L2-normalized — the lexical-overlap retrieval
 * family. Every fixture-record the evaluation emits for this arm
 * carries the executor's own strategy identity in its typed basis.
 *
 * THE SYNTHETIC SEMANTIC SUPPLY — THE CURATED-KNOWLEDGE ORACLE
 * (honestly labeled, never a live model claim): concept normalization
 * through the committed curated dictionaries (fixtures.ts — the
 * synonym/translation/sense maps ARE the synthetic supply of the
 * semantic knowledge a model-backed embedding service would bring to
 * this corpus), followed by the SAME feature-hash arithmetic as the
 * substitute: same tokenizer, same 512 dimensions, same signed
 * bucketing, same sublinear TF, same L2 normalization. The ONLY
 * difference between the two representations is surface tokens vs
 * dictionary-canonicalized concepts — the comparison is fair by
 * construction, and the measured distinction is exactly the curated
 * semantic knowledge (ACR-009 §1's gap made mechanical).
 *
 * HONEST BOUNDARY (the truth discipline): the synthetic semantic arm
 * is NOT a live model-backed embedding — it is the declared upper
 * bound of model-backed semantic retrieval ON THIS CURATED CORPUS
 * (the fixtures' ground-truth relations, supplied synthetically).
 * Live credentialed semantic-quality validation remains the
 * operator-era obligation, never backfilled from this evaluation.
 *
 * Pure and total: both representations are deterministic functions of
 * their inputs — same input → same output, always (the suites pin the
 * byte-identity across recomputation).
 */

import { createHash } from "node:crypto";
import {
  cosineSimilarityOf,
  DETERMINISTIC_EMBEDDINGS_DIMENSIONS,
  deterministicEmbeddingOf,
  isWellFormedEmbedding,
  tokenize,
} from "../../../../compat/openwebui/harness/embeddings";
import type { SemanticFidelityFacts, SemanticRepresentationKind } from "./fidelity";
import { dictionaryIndex } from "./fixtures";

// ---------------------------------------------------------------------------
// The deterministic substitute arm (the REAL PPR-025 executor, read-only)
// ---------------------------------------------------------------------------

/** The deterministic substitute arm's identity (the real executor's own strategy identity). */
export const DETERMINISTIC_SUBSTITUTE_ARM = {
  armId: "deterministic-substitute",
  label:
    "the deterministic lexical/hash substitute — the REAL PPR-025 Zeck-side executor (compat/openwebui/harness/embeddings.ts, imported read-only): SHA-256-signed feature hashing of lowercased unigram+bigram surface tokens, sublinear TF, L2-normalized, 512 fixed dimensions (synthetic-supply labels: the era's recorded execution representation, never a model rail)",
} as const;

/** The substitute arm's embedding (the real executor — byte-identical to the era's). */
export function substituteEmbeddingOf(text: string): readonly number[] {
  return deterministicEmbeddingOf(text);
}

/** The mechanical well-formedness check (the real executor's own). */
export function substituteEmbeddingWellFormed(vector: readonly unknown[]): {
  readonly ok: boolean;
  readonly detail: string;
} {
  return isWellFormedEmbedding(vector);
}

// ---------------------------------------------------------------------------
// The synthetic semantic supply arm (the curated-knowledge oracle)
// ---------------------------------------------------------------------------

/** The synthetic semantic arm's identity (honestly labeled — never a live model claim). */
export const SYNTHETIC_SEMANTIC_ARM = {
  armId: "synthetic-semantic-supply",
  label:
    "the synthetic semantic supply — concept normalization through the committed curated dictionaries (the synthetic supply of the semantic knowledge a model-backed embedding service would bring to this corpus), followed by the SAME feature-hash arithmetic as the substitute (same tokenizer, same 512 dimensions, same signed bucketing, same sublinear TF, same L2 normalization); the declared upper bound of model-backed semantic retrieval on this curated corpus, NEVER a live model measurement (synthetic-semantic-supply; live credentialed validation is the operator-era obligation)",
} as const;

/** The dictionary index (committed content — deterministic). */
const INDEX = dictionaryIndex();

/** The deterministic feature bucket of one concept id (SHA-256 → signed 32-bit — the executor's own discipline). */
function bucketOf(concept: string): { readonly index: number; readonly sign: number } {
  const digest = createHash("sha256").update(concept, "utf8").digest();
  const index = digest.readUInt32BE(0) % DETERMINISTIC_EMBEDDINGS_DIMENSIONS;
  const signBit = digest[4] ?? 0;
  const sign = (signBit & 1) === 1 ? 1 : -1;
  return { index, sign };
}

/**
 * The synthetic semantic embedding of one text: every token (or
 * bigram) the curated dictionary knows contributes its weighted
 * concepts — sublinear-TF weighted over occurrences, exactly like the
 * substitute's arithmetic — and the concept weights are feature-hashed
 * into the same 512-dimension signed-bucket space, then
 * L2-normalized. Tokens the dictionary does not know contribute
 * NOTHING (the oracle is pure curated semantic knowledge — surface
 * identity is invisible to it, which is precisely the point).
 */
export function syntheticSemanticEmbeddingOf(text: string): readonly number[] {
  const vector = new Array<number>(DETERMINISTIC_EMBEDDINGS_DIMENSIONS).fill(0);
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  for (const [token, count] of counts) {
    const concepts = INDEX.get(token);
    if (concepts === undefined) {
      continue;
    }
    const weight = 1 + Math.log(count);
    for (const concept of concepts) {
      const { index, sign } = bucketOf(concept.concept);
      vector[index] = (vector[index] ?? 0) + sign * weight * concept.weight;
    }
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    return vector;
  }
  return vector.map((value) => value / norm);
}

// ---------------------------------------------------------------------------
// The retrieval ranking (both arms — the same cosine similarity)
// ---------------------------------------------------------------------------

/** One ranked candidate (the measured similarity — the raw evidence).
 *
 * STABILITY DISCIPLINE: the emitted similarity is rounded to 6 decimal
 * places — the ranking itself compares the raw floats (order is exact),
 * but the EMITTED value (which rides the records and the digest
 * projection) is rounded so the digest is byte-identical across JS
 * runtimes (V8 and JavaScriptCore disagree on the last ULP of
 * Math.log/Math.sqrt; 6 decimals sits far above that noise — the
 * deterministic replay discipline holds across runtimes, not just
 * within one). */
export interface RankedCandidate {
  readonly id: string;
  readonly similarity: number;
  readonly rank: number;
}

/** Round an emitted similarity to the stable cross-runtime precision. */
export function stableSimilarity(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Rank a fixture's candidates for one query under ONE embedding
 * function: cosine similarity (the real executor's own measure)
 * descending, ties broken by candidate id (the deterministic order —
 * the ranking is a pure function of the embeddings).
 */
export function rankCandidates(
  query: string,
  candidates: readonly { id: string; text: string }[],
  embed: (text: string) => readonly number[],
): readonly RankedCandidate[] {
  const queryVector = embed(query);
  const scored = candidates.map((candidate) => ({
    id: candidate.id,
    similarity: stableSimilarity(cosineSimilarityOf(queryVector, embed(candidate.text))),
  }));
  scored.sort((a, b) =>
    a.similarity !== b.similarity ? b.similarity - a.similarity : a.id < b.id ? -1 : 1,
  );
  return scored.map((entry, index) => ({ ...entry, rank: index + 1 }));
}

// ---------------------------------------------------------------------------
// The typed facts each arm's records carry (the ACR-009 §2 block)
// ---------------------------------------------------------------------------

/**
 * The typed semantic-fidelity facts of ONE emitted representation
 * record (the closed block — the discriminator's only input):
 * the substitute arm declares `hash-proximity` similarity semantics
 * and its substitute identity in the basis; the synthetic semantic arm
 * declares `cosine` similarity semantics and NO substitute identity
 * (the model-backed spelling — an honest declaration of the synthetic
 * supply's semantics, labeled synthetic in the record's provenance
 * fields, never a live-provider claim).
 */
export function factsOfRepresentation(input: {
  readonly kind: SemanticRepresentationKind;
  readonly executionId: string;
  readonly capabilityId: string;
  readonly substituteId?: string;
}): SemanticFidelityFacts {
  if (input.kind === "deterministic-substitute") {
    return {
      representationKind: "deterministic-substitute",
      modality: "text",
      dimensionality: DETERMINISTIC_EMBEDDINGS_DIMENSIONS,
      normalization: "l2",
      similaritySemantics: "hash-proximity",
      qualityContract: { kind: "absent" },
      compatibilityConstraints: ["dimensionality-match", "normalization-match"],
      basis: {
        executionId: input.executionId,
        capabilityId: input.capabilityId,
        substituteId: input.substituteId ?? "ppr-025-deterministic-embeddings",
      },
    };
  }
  return {
    representationKind: "semantic-model-backed",
    modality: "text",
    dimensionality: DETERMINISTIC_EMBEDDINGS_DIMENSIONS,
    normalization: "l2",
    similaritySemantics: "cosine",
    qualityContract: { kind: "absent" },
    compatibilityConstraints: ["dimensionality-match", "normalization-match"],
    basis: {
      executionId: input.executionId,
      capabilityId: input.capabilityId,
    },
  };
}
