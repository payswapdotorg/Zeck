/**
 * Unit: semantic-fidelity typed facts (capabilities module domain,
 * ACR-009 §2; work order PCS-002 — the pure plane).
 *
 * Covers every field's closed vocabulary, every fail-closed path (each
 * rejection reason names the field and the offending value), the
 * explicit-basis provenance discipline, the canonical serialization +
 * content-addressable identity (determinism), the delegation-boundary
 * compatibility check and the OPTIONAL riding on the capability fact
 * (absence spellings, registry arbitration, convergence retention).
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  CAPABILITY_KINDS,
  canonicalSemanticFidelityJson,
  checkSemanticFidelityBoundary,
  createCapabilityRegistry,
  createInMemoryCatalogStore,
  MAX_SEMANTIC_DIMENSIONALITY,
  type PublishedCapabilityFact,
  SEED_CAPABILITY_FACTS,
  SEMANTIC_COMPATIBILITY_CONSTRAINTS,
  SEMANTIC_MODALITIES,
  SEMANTIC_NORMALIZATIONS,
  SEMANTIC_QUALITY_REQUIREMENTS,
  SEMANTIC_REPRESENTATION_KINDS,
  SEMANTIC_SIMILARITY_SEMANTICS,
  type SemanticFidelityFacts,
  semanticFidelityIdentity,
  validatePublishedFact,
  validateSemanticFidelityFacts,
} from "../../../src/modules/capabilities/public";

const PUBLISHED_AT = "2026-08-30T00:00:00Z";
const sha256 = (canonical: string): string =>
  createHash("sha256").update(canonical, "utf8").digest("hex");

/** A fully-valid model-backed fact block. */
const modelBackedFacts: SemanticFidelityFacts = {
  representationKind: "semantic-model-backed",
  modality: "text",
  dimensionality: 768,
  normalization: "l2",
  similaritySemantics: "cosine",
  qualityContract: { kind: "absent" },
  compatibilityConstraints: [
    "dimensionality-match",
    "normalization-match",
    "similarity-semantics-match",
  ],
  basis: { executionId: "exec-000123", capabilityId: "semantic-embeddings" },
};

/** A fully-valid deterministic-substitute fact block (the ACR-009 §1 case). */
const substituteFacts: SemanticFidelityFacts = {
  representationKind: "deterministic-substitute",
  modality: "text",
  dimensionality: 512,
  normalization: "none",
  similaritySemantics: "hash-proximity",
  qualityContract: {
    kind: "declared",
    requirement: "requires-semantic-retrieval-quality",
    acceptanceBasis:
      "task-authored: paraphrase retrieval must not degrade below the recorded baseline",
  },
  compatibilityConstraints: ["dimensionality-match", "normalization-match"],
  basis: {
    executionId: "exec-000456",
    capabilityId: "rag-embeddings",
    substituteId: "lexical-hash-vectorizer",
  },
};

const fact = (mutation: Partial<PublishedCapabilityFact> = {}): PublishedCapabilityFact => ({
  claim: { id: "probe-claim", kind: "model", version: "1.0.0", attributes: { streaming: true } },
  provenance: { publisher: "probe", publishedAt: PUBLISHED_AT },
  evidence: { kind: "adapter-declared", reference: "probe:ref" },
  ...mutation,
});

// ---------------------------------------------------------------------------
// The closed vocabularies (pinned — widening is a reviewed change)
// ---------------------------------------------------------------------------

describe("semantic fidelity — the closed vocabularies", () => {
  test("the representation kinds are exactly the closed two-kind distinction", () => {
    expect([...SEMANTIC_REPRESENTATION_KINDS]).toEqual([
      "semantic-model-backed",
      "deterministic-substitute",
    ]);
  });

  test("the modalities are exactly ACR-009 §2's closed list", () => {
    expect([...SEMANTIC_MODALITIES]).toEqual(["text", "image", "audio", "multimodal"]);
  });

  test("the normalizations are exactly the closed list", () => {
    expect([...SEMANTIC_NORMALIZATIONS]).toEqual(["none", "l2", "scale-bounded"]);
  });

  test("the similarity semantics are exactly the closed list", () => {
    expect([...SEMANTIC_SIMILARITY_SEMANTICS]).toEqual([
      "cosine",
      "dot",
      "exact-match-lexical",
      "hash-proximity",
    ]);
  });

  test("the quality-requirement vocabulary is exactly the ACR-named member", () => {
    expect([...SEMANTIC_QUALITY_REQUIREMENTS]).toEqual(["requires-semantic-retrieval-quality"]);
  });

  test("the compatibility constraints are exactly the closed list, in the frozen order", () => {
    expect([...SEMANTIC_COMPATIBILITY_CONSTRAINTS]).toEqual([
      "dimensionality-match",
      "normalization-match",
      "similarity-semantics-match",
    ]);
  });

  test("the dimensionality bound is the typed positive-integer ceiling", () => {
    expect(MAX_SEMANTIC_DIMENSIONALITY).toBe(65536);
  });

  test("the module declares NO capability identity vocabulary (no family widening)", () => {
    // The frozen capability kinds remain the one truth; the semantic
    // vocabularies never intersect them (a substitute is NOT a new kind).
    expect([...CAPABILITY_KINDS]).toEqual([
      "model",
      "tool",
      "algorithm",
      "data",
      "runtime",
      "human",
    ]);
    const semanticVocabulary = new Set<string>([
      ...SEMANTIC_REPRESENTATION_KINDS,
      ...SEMANTIC_MODALITIES,
      ...SEMANTIC_NORMALIZATIONS,
      ...SEMANTIC_SIMILARITY_SEMANTICS,
      ...SEMANTIC_QUALITY_REQUIREMENTS,
      ...SEMANTIC_COMPATIBILITY_CONSTRAINTS,
    ]);
    for (const kind of CAPABILITY_KINDS) {
      expect(semanticVocabulary.has(kind)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Closed-vocabulary validation (every fail-closed path names field + value)
// ---------------------------------------------------------------------------

describe("semantic fidelity — fail-closed validation of the closed block", () => {
  test("a fully-valid model-backed block passes", () => {
    expect(validateSemanticFidelityFacts(modelBackedFacts)).toEqual({ valid: true });
  });

  test("a fully-valid deterministic-substitute block passes (the declared-quality spelling)", () => {
    expect(validateSemanticFidelityFacts(substituteFacts)).toEqual({ valid: true });
  });

  test("every vocabulary member is accepted (the vocabulary is exactly the acceptance set)", () => {
    for (const kind of SEMANTIC_REPRESENTATION_KINDS) {
      for (const modality of SEMANTIC_MODALITIES) {
        for (const normalization of SEMANTIC_NORMALIZATIONS) {
          for (const semantics of SEMANTIC_SIMILARITY_SEMANTICS) {
            const verdict = validateSemanticFidelityFacts({
              ...modelBackedFacts,
              representationKind: kind,
              modality,
              normalization,
              similaritySemantics: semantics,
              ...(kind === "deterministic-substitute"
                ? { basis: { ...modelBackedFacts.basis, substituteId: "probe-substitute" } }
                : {}),
            });
            expect(verdict, `${kind}/${modality}/${normalization}/${semantics}`).toEqual({
              valid: true,
            });
          }
        }
      }
    }
  });

  test("an unknown representation kind fails closed naming the field and the value", () => {
    const verdict = validateSemanticFidelityFacts({
      ...modelBackedFacts,
      representationKind: "model-backed-ish",
    });
    expect(verdict).toEqual({
      valid: false,
      reason:
        "semanticFidelity.representationKind must be one of semantic-model-backed|deterministic-substitute: model-backed-ish",
    });
  });

  test("an unknown modality fails closed naming the field and the value", () => {
    const verdict = validateSemanticFidelityFacts({ ...modelBackedFacts, modality: "video" });
    expect(verdict).toEqual({
      valid: false,
      reason: "semanticFidelity.modality must be one of text|image|audio|multimodal: video",
    });
  });

  test("an unknown normalization fails closed naming the field and the value", () => {
    const verdict = validateSemanticFidelityFacts({
      ...modelBackedFacts,
      normalization: "z-score",
    });
    expect(verdict).toEqual({
      valid: false,
      reason: "semanticFidelity.normalization must be one of none|l2|scale-bounded: z-score",
    });
  });

  test("an unknown similarity semantics fails closed naming the field and the value", () => {
    const verdict = validateSemanticFidelityFacts({
      ...modelBackedFacts,
      similaritySemantics: "euclidean",
    });
    expect(verdict).toEqual({
      valid: false,
      reason:
        "semanticFidelity.similaritySemantics must be one of cosine|dot|exact-match-lexical|hash-proximity: euclidean",
    });
  });

  test("non-string vocabulary spellings fail closed with the rendered offending value", () => {
    expect(validateSemanticFidelityFacts({ ...modelBackedFacts, modality: 7 })).toEqual({
      valid: false,
      reason: "semanticFidelity.modality must be one of text|image|audio|multimodal: 7",
    });
    expect(validateSemanticFidelityFacts({ ...modelBackedFacts, normalization: null })).toEqual({
      valid: false,
      reason: "semanticFidelity.normalization must be one of none|l2|scale-bounded: null",
    });
  });

  test("dimensionality is a typed positive integer in [1, 65536] — every out-of-bound spelling fails closed", () => {
    for (const dimensionality of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      65537,
      "768",
      null,
    ]) {
      const verdict = validateSemanticFidelityFacts({ ...modelBackedFacts, dimensionality });
      expect(verdict.valid, `dimensionality ${String(dimensionality)}`).toBe(false);
      expect(verdict.valid === false && verdict.reason).toContain(
        "semanticFidelity.dimensionality",
      );
      expect(verdict.valid === false && verdict.reason).toContain(String(dimensionality));
    }
    expect(validateSemanticFidelityFacts({ ...modelBackedFacts, dimensionality: 1 })).toEqual({
      valid: true,
    });
    expect(validateSemanticFidelityFacts({ ...modelBackedFacts, dimensionality: 65536 })).toEqual({
      valid: true,
    });
  });

  test("the dimensionality rejection names the bound and the offending value", () => {
    expect(validateSemanticFidelityFacts({ ...modelBackedFacts, dimensionality: 0 })).toEqual({
      valid: false,
      reason: "semanticFidelity.dimensionality must be an integer in [1, 65536]: 0",
    });
  });

  test("a non-object block fails closed", () => {
    for (const value of [null, undefined, "facts", 7, []]) {
      expect(validateSemanticFidelityFacts(value)).toEqual({
        valid: false,
        reason: "semanticFidelity must be an object (the closed fact block)",
      });
    }
  });
});

// ---------------------------------------------------------------------------
// The quality contract (typed, closed — task-authored or explicitly absent)
// ---------------------------------------------------------------------------

describe("semantic fidelity — the typed quality contract", () => {
  test("a declared requirement with its acceptance basis passes", () => {
    expect(
      validateSemanticFidelityFacts({
        ...modelBackedFacts,
        qualityContract: {
          kind: "declared",
          requirement: "requires-semantic-retrieval-quality",
          acceptanceBasis: "the task's own paraphrase-retrieval acceptance set",
        },
      }),
    ).toEqual({ valid: true });
  });

  test("an explicit absence passes", () => {
    expect(
      validateSemanticFidelityFacts({ ...modelBackedFacts, qualityContract: { kind: "absent" } }),
    ).toEqual({ valid: true });
  });

  test("an unknown contract kind fails closed naming the field and the value", () => {
    expect(
      validateSemanticFidelityFacts({
        ...modelBackedFacts,
        qualityContract: { kind: "maybe" },
      }),
    ).toEqual({
      valid: false,
      reason: "semanticFidelity.qualityContract.kind must be declared|absent: maybe",
    });
  });

  test("an unknown requirement fails closed naming the vocabulary and the value", () => {
    expect(
      validateSemanticFidelityFacts({
        ...modelBackedFacts,
        qualityContract: { kind: "declared", requirement: "requires-vibes", acceptanceBasis: "x" },
      }),
    ).toEqual({
      valid: false,
      reason:
        "semanticFidelity.qualityContract.requirement must be one of requires-semantic-retrieval-quality: requires-vibes",
    });
  });

  test("a declared requirement without its acceptance basis fails closed", () => {
    const verdict = validateSemanticFidelityFacts({
      ...modelBackedFacts,
      qualityContract: { kind: "declared", requirement: "requires-semantic-retrieval-quality" },
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.valid === false && verdict.reason).toContain(
      "semanticFidelity.qualityContract.acceptanceBasis",
    );
  });

  test("an unbounded acceptance basis fails closed (the CostClaim attribution bound)", () => {
    const verdict = validateSemanticFidelityFacts({
      ...modelBackedFacts,
      qualityContract: {
        kind: "declared",
        requirement: "requires-semantic-retrieval-quality",
        acceptanceBasis: "x".repeat(201),
      },
    });
    expect(verdict).toEqual({
      valid: false,
      reason:
        "semanticFidelity.qualityContract.acceptanceBasis must be a bounded non-empty string (<=200): " +
        "x".repeat(200) +
        "…",
    });
  });

  test("a secret-looking acceptance basis fails closed (the module's free-text discipline)", () => {
    const verdict = validateSemanticFidelityFacts({
      ...modelBackedFacts,
      qualityContract: {
        kind: "declared",
        requirement: "requires-semantic-retrieval-quality",
        acceptanceBasis: "sk-abcdefghijklmnopqrstuvwxyz012345",
      },
    });
    expect(verdict).toEqual({
      valid: false,
      reason:
        "semanticFidelity.qualityContract.acceptanceBasis looks like it embeds a raw secret value",
    });
  });

  test("an explicit absence carrying a requirement is the incoherent shape — rejected", () => {
    const verdict = validateSemanticFidelityFacts({
      ...modelBackedFacts,
      qualityContract: { kind: "absent", requirement: "requires-semantic-retrieval-quality" },
    });
    expect(verdict).toEqual({
      valid: false,
      reason:
        "semanticFidelity.qualityContract absent cannot carry a requirement or acceptanceBasis (the incoherent shape is rejected)",
    });
  });
});

// ---------------------------------------------------------------------------
// The compatibility constraints (closed list, duplicate-free, >= 1)
// ---------------------------------------------------------------------------

describe("semantic fidelity — the closed compatibility constraints", () => {
  test("an empty constraint list fails closed", () => {
    expect(
      validateSemanticFidelityFacts({ ...modelBackedFacts, compatibilityConstraints: [] }),
    ).toEqual({
      valid: false,
      reason: "semanticFidelity.compatibilityConstraints must declare at least one constraint",
    });
  });

  test("a duplicate constraint fails closed", () => {
    expect(
      validateSemanticFidelityFacts({
        ...modelBackedFacts,
        compatibilityConstraints: ["dimensionality-match", "dimensionality-match"],
      }),
    ).toEqual({
      valid: false,
      reason: "semanticFidelity.compatibilityConstraints must not contain duplicates",
    });
  });

  test("an unknown constraint fails closed naming the vocabulary and the value", () => {
    expect(
      validateSemanticFidelityFacts({
        ...modelBackedFacts,
        compatibilityConstraints: ["provider-match"],
      }),
    ).toEqual({
      valid: false,
      reason:
        "semanticFidelity.compatibilityConstraints entry must be one of dimensionality-match|normalization-match|similarity-semantics-match: provider-match",
    });
  });

  test("a non-array constraint list fails closed", () => {
    expect(
      validateSemanticFidelityFacts({ ...modelBackedFacts, compatibilityConstraints: "all" }),
    ).toEqual({
      valid: false,
      reason: "semanticFidelity.compatibilityConstraints must be an array of closed constraints",
    });
  });

  test("any closed subset passes, in any order (order is never identity)", () => {
    for (const constraints of [
      ["dimensionality-match"],
      ["normalization-match"],
      ["similarity-semantics-match"],
      ["similarity-semantics-match", "dimensionality-match"],
      [...SEMANTIC_COMPATIBILITY_CONSTRAINTS].reverse(),
    ]) {
      expect(
        validateSemanticFidelityFacts({
          ...modelBackedFacts,
          compatibilityConstraints: constraints,
        }),
      ).toEqual({ valid: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The explicit basis (the CostClaim discipline applied to semantic facts)
// ---------------------------------------------------------------------------

describe("semantic fidelity — the explicit-basis provenance discipline", () => {
  test("a missing basis is unrepresentable — rejected typed", () => {
    expect(validateSemanticFidelityFacts({ ...modelBackedFacts, basis: undefined })).toEqual({
      valid: false,
      reason:
        "semanticFidelity.basis is required on every semantic fact (the explicit-basis CostClaim discipline — an unattributed semantic fact is unrepresentable)",
    });
  });

  test("a missing execution identity fails closed naming the field and the value", () => {
    expect(
      validateSemanticFidelityFacts({
        ...modelBackedFacts,
        basis: { capabilityId: "semantic-embeddings" },
      }),
    ).toEqual({
      valid: false,
      reason:
        "semanticFidelity.basis.executionId must be a bounded non-empty identity (<=128): undefined",
    });
  });

  test("a non-slug declared capability fails closed naming the field and the value", () => {
    expect(
      validateSemanticFidelityFacts({
        ...modelBackedFacts,
        basis: { executionId: "exec-1", capabilityId: "Not A Slug" },
      }),
    ).toEqual({
      valid: false,
      reason: "semanticFidelity.basis.capabilityId must be a neutral vocabulary slug: Not A Slug",
    });
  });

  test("a deterministic substitute WITHOUT its substitute identity is unattributable — rejected", () => {
    expect(
      validateSemanticFidelityFacts({
        ...substituteFacts,
        basis: { executionId: "exec-000456", capabilityId: "rag-embeddings" },
      }),
    ).toEqual({
      valid: false,
      reason:
        "semanticFidelity.basis.substituteId is required when representationKind is deterministic-substitute (which substitute function produced the fact): undefined",
    });
  });

  test("a model-backed representation claiming a substitute identity is the incoherent shape — rejected", () => {
    expect(
      validateSemanticFidelityFacts({
        ...modelBackedFacts,
        basis: {
          executionId: "exec-1",
          capabilityId: "semantic-embeddings",
          substituteId: "lexical-hash",
        },
      }),
    ).toEqual({
      valid: false,
      reason:
        "semanticFidelity.basis.substituteId cannot ride a semantic-model-backed representation (the incoherent shape is rejected)",
    });
  });

  test("a valid substitute basis carries all three provenance elements", () => {
    expect(validateSemanticFidelityFacts(substituteFacts)).toEqual({ valid: true });
    expect(substituteFacts.basis.substituteId).toBe("lexical-hash-vectorizer");
  });
});

// ---------------------------------------------------------------------------
// Determinism + content addressing (invariant 5)
// ---------------------------------------------------------------------------

describe("semantic fidelity — determinism and content-addressable identity", () => {
  test("the same facts always produce the byte-identical validation verdict", () => {
    const first = validateSemanticFidelityFacts(modelBackedFacts);
    for (let index = 0; index < 5; index += 1) {
      expect(JSON.stringify(validateSemanticFidelityFacts(modelBackedFacts))).toBe(
        JSON.stringify(first),
      );
    }
    const rejection = validateSemanticFidelityFacts({ ...modelBackedFacts, modality: "video" });
    for (let index = 0; index < 5; index += 1) {
      expect(
        JSON.stringify(validateSemanticFidelityFacts({ ...modelBackedFacts, modality: "video" })),
      ).toBe(JSON.stringify(rejection));
    }
  });

  test("input key order never changes the verdict (fields are addressed by name)", () => {
    const permuted = {
      basis: modelBackedFacts.basis,
      compatibilityConstraints: modelBackedFacts.compatibilityConstraints,
      qualityContract: modelBackedFacts.qualityContract,
      similaritySemantics: modelBackedFacts.similaritySemantics,
      normalization: modelBackedFacts.normalization,
      dimensionality: modelBackedFacts.dimensionality,
      modality: modelBackedFacts.modality,
      representationKind: modelBackedFacts.representationKind,
    };
    expect(JSON.stringify(validateSemanticFidelityFacts(permuted))).toBe(
      JSON.stringify(validateSemanticFidelityFacts(modelBackedFacts)),
    );
  });

  test("the canonical form is deterministic and pinned", () => {
    expect(canonicalSemanticFidelityJson(modelBackedFacts)).toBe(
      '["capabilities.semantic-fidelity","semantic-model-backed","text",768,"l2","cosine",[["kind","absent"]],["dimensionality-match","normalization-match","similarity-semantics-match"],[["capabilityId","semantic-embeddings"],["executionId","exec-000123"]]]',
    );
  });

  test("constraint-list order is never identity (the canonical form sorts the vocabulary)", () => {
    const reordered: SemanticFidelityFacts = {
      ...modelBackedFacts,
      compatibilityConstraints: [...modelBackedFacts.compatibilityConstraints].reverse(),
    };
    expect(canonicalSemanticFidelityJson(reordered)).toBe(
      canonicalSemanticFidelityJson(modelBackedFacts),
    );
  });

  test("every semantic field participates in the content address (distinct facts → distinct identities)", () => {
    const base = semanticFidelityIdentity(modelBackedFacts, sha256);
    const variants: readonly SemanticFidelityFacts[] = [
      {
        ...modelBackedFacts,
        representationKind: "deterministic-substitute",
        basis: { ...modelBackedFacts.basis, substituteId: "s" },
      },
      { ...modelBackedFacts, modality: "multimodal" },
      { ...modelBackedFacts, dimensionality: 769 },
      { ...modelBackedFacts, normalization: "none" },
      { ...modelBackedFacts, similaritySemantics: "dot" },
      {
        ...modelBackedFacts,
        qualityContract: {
          kind: "declared",
          requirement: "requires-semantic-retrieval-quality",
          acceptanceBasis: "basis",
        },
      },
      { ...modelBackedFacts, compatibilityConstraints: ["dimensionality-match"] },
      {
        ...modelBackedFacts,
        basis: { executionId: "exec-999", capabilityId: "semantic-embeddings" },
      },
    ];
    const identities = new Set([base]);
    for (const variant of variants) {
      const identity = semanticFidelityIdentity(variant, sha256);
      expect(identity).not.toBe(base);
      identities.add(identity);
    }
    expect(identities.size).toBe(variants.length + 1);
  });

  test("the identity is the sha256 over the canonical form (deterministic, hex)", () => {
    const identity = semanticFidelityIdentity(modelBackedFacts, sha256);
    expect(identity).toBe(sha256(canonicalSemanticFidelityJson(modelBackedFacts)));
    expect(identity).toMatch(/^[0-9a-f]{64}$/);
    expect(semanticFidelityIdentity(modelBackedFacts, sha256)).toBe(identity);
  });

  test("the digest is injected, never ambient (any digest function is legal input)", () => {
    expect(semanticFidelityIdentity(modelBackedFacts, () => "digest-of")).toBe("digest-of");
  });
});

// ---------------------------------------------------------------------------
// The delegation-boundary compatibility check (pure, no wiring)
// ---------------------------------------------------------------------------

describe("semantic fidelity — the delegation-boundary check", () => {
  test("absence of either side's facts skips the check (absence-equivalent)", () => {
    expect(checkSemanticFidelityBoundary({ consumer: undefined, producer: undefined })).toEqual({
      kind: "skipped",
      reason: "both-sides-absent",
    });
    expect(checkSemanticFidelityBoundary({ consumer: null, producer: null })).toEqual({
      kind: "skipped",
      reason: "both-sides-absent",
    });
    expect(
      checkSemanticFidelityBoundary({ consumer: modelBackedFacts, producer: undefined }),
    ).toEqual({
      kind: "skipped",
      reason: "producer-facts-absent",
    });
    expect(
      checkSemanticFidelityBoundary({ consumer: undefined, producer: modelBackedFacts }),
    ).toEqual({
      kind: "skipped",
      reason: "consumer-facts-absent",
    });
    expect(checkSemanticFidelityBoundary({ consumer: modelBackedFacts, producer: null })).toEqual({
      kind: "skipped",
      reason: "producer-facts-absent",
    });
  });

  test("a fully-matching pair is compatible", () => {
    expect(
      checkSemanticFidelityBoundary({ consumer: modelBackedFacts, producer: modelBackedFacts }),
    ).toEqual({
      kind: "compatible",
    });
  });

  test("a dimensionality mismatch is a typed failure naming both sides and both values", () => {
    const producer: SemanticFidelityFacts = { ...modelBackedFacts, dimensionality: 1024 };
    const verdict = checkSemanticFidelityBoundary({ consumer: modelBackedFacts, producer });
    expect(verdict.kind).toBe("incompatible");
    if (verdict.kind === "incompatible") {
      expect(verdict.mismatches).toHaveLength(1);
      const mismatch = verdict.mismatches[0];
      expect(mismatch?.constraint).toBe("dimensionality-match");
      expect(mismatch?.consumerBasis).toEqual(modelBackedFacts.basis);
      expect(mismatch?.producerBasis).toEqual(producer.basis);
      expect(mismatch?.consumerValue).toBe("768");
      expect(mismatch?.producerValue).toBe("1024");
    }
  });

  test("a normalization mismatch is a typed failure naming both sides", () => {
    const producer: SemanticFidelityFacts = { ...modelBackedFacts, normalization: "none" };
    const verdict = checkSemanticFidelityBoundary({ consumer: modelBackedFacts, producer });
    expect(verdict.kind).toBe("incompatible");
    if (verdict.kind === "incompatible") {
      expect(verdict.mismatches[0]?.constraint).toBe("normalization-match");
      expect(verdict.mismatches[0]?.consumerValue).toBe("l2");
      expect(verdict.mismatches[0]?.producerValue).toBe("none");
    }
  });

  test("a similarity-semantics mismatch is a typed failure naming both sides", () => {
    const producer: SemanticFidelityFacts = {
      ...modelBackedFacts,
      similaritySemantics: "hash-proximity",
    };
    const verdict = checkSemanticFidelityBoundary({ consumer: modelBackedFacts, producer });
    expect(verdict.kind).toBe("incompatible");
    if (verdict.kind === "incompatible") {
      expect(verdict.mismatches[0]?.constraint).toBe("similarity-semantics-match");
      expect(verdict.mismatches[0]?.consumerValue).toBe("cosine");
      expect(verdict.mismatches[0]?.producerValue).toBe("hash-proximity");
    }
  });

  test("every mismatched constraint accumulates, in the frozen vocabulary order", () => {
    const producer: SemanticFidelityFacts = {
      ...modelBackedFacts,
      dimensionality: 1024,
      normalization: "none",
      similaritySemantics: "dot",
    };
    const verdict = checkSemanticFidelityBoundary({ consumer: modelBackedFacts, producer });
    expect(verdict.kind).toBe("incompatible");
    if (verdict.kind === "incompatible") {
      expect(verdict.mismatches.map((mismatch) => mismatch.constraint)).toEqual([
        "dimensionality-match",
        "normalization-match",
        "similarity-semantics-match",
      ]);
    }
  });

  test("only the CONSUMER's declared constraints bind (the closed-list semantics)", () => {
    const consumer: SemanticFidelityFacts = {
      ...modelBackedFacts,
      compatibilityConstraints: ["normalization-match"],
    };
    const producer: SemanticFidelityFacts = {
      ...modelBackedFacts,
      dimensionality: 9999,
      similaritySemantics: "dot",
    };
    // The consumer did not declare dimensionality/similarity constraints:
    // the differing fields are NOT mismatches; the matching normalization
    // leaves the pair compatible.
    expect(checkSemanticFidelityBoundary({ consumer, producer })).toEqual({ kind: "compatible" });
    const producerNormalization: SemanticFidelityFacts = {
      ...producer,
      normalization: "scale-bounded",
    };
    const verdict = checkSemanticFidelityBoundary({ consumer, producer: producerNormalization });
    expect(verdict.kind).toBe("incompatible");
    if (verdict.kind === "incompatible") {
      expect(verdict.mismatches.map((mismatch) => mismatch.constraint)).toEqual([
        "normalization-match",
      ]);
    }
  });

  test("a malformed fact on either side is a typed invalid verdict naming the side (fail closed)", () => {
    const consumerVerdict = checkSemanticFidelityBoundary({
      consumer: { ...modelBackedFacts, modality: "video" } as never,
      producer: modelBackedFacts,
    });
    expect(consumerVerdict).toEqual({
      kind: "invalid",
      side: "consumer",
      reason: "semanticFidelity.modality must be one of text|image|audio|multimodal: video",
    });
    const producerVerdict = checkSemanticFidelityBoundary({
      consumer: modelBackedFacts,
      producer: { ...modelBackedFacts, dimensionality: 0 } as never,
    });
    expect(producerVerdict).toEqual({
      kind: "invalid",
      side: "producer",
      reason: "semanticFidelity.dimensionality must be an integer in [1, 65536]: 0",
    });
  });

  test("the same inputs always produce the byte-identical boundary verdict", () => {
    const producer: SemanticFidelityFacts = {
      ...modelBackedFacts,
      dimensionality: 1024,
      normalization: "none",
    };
    const first = JSON.stringify(
      checkSemanticFidelityBoundary({ consumer: modelBackedFacts, producer }),
    );
    for (let index = 0; index < 5; index += 1) {
      expect(
        JSON.stringify(checkSemanticFidelityBoundary({ consumer: modelBackedFacts, producer })),
      ).toBe(first);
    }
  });
});

// ---------------------------------------------------------------------------
// The OPTIONAL riding on the capability fact (registry arbitration)
// ---------------------------------------------------------------------------

describe("semantic fidelity — the optional riding on published facts", () => {
  test("a fact with a valid block passes published-fact validation", () => {
    expect(validatePublishedFact(fact({ semanticFidelity: modelBackedFacts }))).toEqual({
      valid: true,
    });
  });

  test("a fact with an INVALID block fails published-fact validation with the block's reason", () => {
    const verdict = validatePublishedFact(
      fact({
        semanticFidelity: {
          ...modelBackedFacts,
          representationKind: "quantum-entangled",
        } as never,
      }),
    );
    expect(verdict).toEqual({
      valid: false,
      reason:
        "semanticFidelity.representationKind must be one of semantic-model-backed|deterministic-substitute: quantum-entangled",
    });
  });

  test("absence spellings (undefined and null) validate exactly as before", () => {
    expect(validatePublishedFact(fact())).toEqual({ valid: true });
    expect(validatePublishedFact(fact({ semanticFidelity: undefined }))).toEqual({ valid: true });
    expect(validatePublishedFact({ ...fact(), semanticFidelity: null })).toEqual({ valid: true });
  });

  test("an accepted publish carries the block onto the arbitrated record byte-identically", async () => {
    const registry = await createCapabilityRegistry({ store: createInMemoryCatalogStore() });
    const outcome = await registry.publish(fact({ semanticFidelity: substituteFacts }));
    expect(outcome.status).toBe("accepted");
    const claims = await registry.listClaims();
    expect(claims).toHaveLength(1);
    expect(claims[0]?.semanticFidelity).toEqual(substituteFacts);
    // The no-silent-substitution law: a consumer of the record
    // distinguishes the kinds mechanically.
    expect(claims[0]?.semanticFidelity?.representationKind).toBe("deterministic-substitute");
  });

  test("an invalid block is rejected by the registry and never enters the catalog", async () => {
    const registry = await createCapabilityRegistry({ store: createInMemoryCatalogStore() });
    const outcome = await registry.publish(
      fact({ semanticFidelity: { ...modelBackedFacts, similaritySemantics: "jaccard" } as never }),
    );
    expect(outcome.status).toBe("rejected");
    expect(await registry.listClaims()).toHaveLength(0);
    const resolution = await registry.resolve({
      requirements: [{ id: "probe-claim", kind: "model" }],
    });
    expect(resolution.satisfied).toBe(false);
  });

  test("absence constructs the record with NO semanticFidelity key (the byte-identical-today shape)", async () => {
    const registry = await createCapabilityRegistry({ store: createInMemoryCatalogStore() });
    await registry.publish(fact());
    const record = (await registry.listClaims())[0];
    expect(record).toBeDefined();
    expect(Object.keys(record ?? {})).not.toContain("semanticFidelity");
    expect(JSON.stringify(record)).not.toContain("semanticFidelity");
    expect(JSON.stringify(record)).toBe(
      '{"claim":{"id":"probe-claim","kind":"model","version":"1.0.0","attributes":{"streaming":true}},"provenance":{"publisher":"probe","publishedAt":"2026-08-30T00:00:00Z"},"evidence":{"kind":"adapter-declared","reference":"probe:ref"},"acceptedAtRevision":"rev-1"}',
    );
  });

  test("the null absence spelling constructs the same no-key record", async () => {
    const registry = await createCapabilityRegistry({ store: createInMemoryCatalogStore() });
    await registry.publish({ ...fact(), semanticFidelity: null });
    const record = (await registry.listClaims())[0];
    expect(Object.keys(record ?? {})).not.toContain("semanticFidelity");
  });

  test("convergence retains the ORIGINAL record's block (version immutability, unchanged)", async () => {
    const registry = await createCapabilityRegistry({ store: createInMemoryCatalogStore() });
    await registry.publish(fact({ semanticFidelity: modelBackedFacts }));
    // Same claim identity, same attributes, a DIFFERENT block: the
    // republish converges and the ORIGINAL record (with its original
    // block) is retained — corrections are new versions.
    const outcome = await registry.publish(
      fact({ semanticFidelity: { ...substituteFacts, dimensionality: 768 } }),
    );
    expect(outcome.status).toBe("converged");
    const claims = await registry.listClaims();
    expect(claims).toHaveLength(1);
    expect(claims[0]?.semanticFidelity?.representationKind).toBe("semantic-model-backed");
  });

  test("the satisfaction carries the claim's block exactly when present (PCS-003's read path); absence adds no key", async () => {
    // [PCS-003 evolution of the PCS-002 pin: the planner's
    // quality-contract gating consumes the arbitrated facts READ-ONLY
    // through the resolution satisfactions — the one sanctioned read
    // path (no second registry, no direct catalog access). A claim's
    // block rides its satisfaction EXACTLY when the claim declares
    // one; a claim without a block leaves the satisfaction bytes
    // IDENTICAL to the pre-PCS-002 spelling (absence-equivalence).]
    const registry = await createCapabilityRegistry({ store: createInMemoryCatalogStore() });
    await registry.publish(fact({ semanticFidelity: modelBackedFacts }));
    const resolution = await registry.resolve({
      requirements: [{ id: "probe-claim", kind: "model" }],
    });
    expect(resolution.satisfied).toBe(true);
    if (resolution.satisfied) {
      expect(JSON.stringify(resolution.satisfactions[0])).toBe(
        '{"requirementId":"probe-claim","claimId":"probe-claim","claimKind":"model","claimVersion":"1.0.0","evidenceKind":"adapter-declared","evidenceReference":"probe:ref","publisher":"probe","semanticFidelity":{"representationKind":"semantic-model-backed","modality":"text","dimensionality":768,"normalization":"l2","similaritySemantics":"cosine","qualityContract":{"kind":"absent"},"compatibilityConstraints":["dimensionality-match","normalization-match","similarity-semantics-match"],"basis":{"executionId":"exec-000123","capabilityId":"semantic-embeddings"}}}',
      );
    }
    // Absence: a claim WITHOUT a block resolves to the EXACT pre-change
    // satisfaction bytes (no semanticFidelity key anywhere).
    const bare = await createCapabilityRegistry({ store: createInMemoryCatalogStore() });
    await bare.publish(fact());
    const bareResolution = await bare.resolve({
      requirements: [{ id: "probe-claim", kind: "model" }],
    });
    expect(bareResolution.satisfied).toBe(true);
    if (bareResolution.satisfied) {
      expect(JSON.stringify(bareResolution.satisfactions[0])).toBe(
        '{"requirementId":"probe-claim","claimId":"probe-claim","claimKind":"model","claimVersion":"1.0.0","evidenceKind":"adapter-declared","evidenceReference":"probe:ref","publisher":"probe"}',
      );
    }
  });

  test("the seed catalog facts carry no block (the platform's own seeds are absence-pure)", () => {
    for (const seed of SEED_CAPABILITY_FACTS) {
      expect(seed.semanticFidelity).toBeUndefined();
    }
  });
});
