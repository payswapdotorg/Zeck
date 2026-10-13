/**
 * Discrimination: semantic-fidelity typed facts (capabilities module,
 * ACR-009 §2; work order PCS-002).
 *
 *   S1 — ABSENCE-EQUIVALENCE vs the PRE-CHANGE BASELINE (the honesty
 *        anchor): the baseline corpus — the seed catalog plus the
 *        representative valid/invalid published facts, arbitrated
 *        through the registry exactly as the pre-change suites did —
 *        was captured at the BASE commit (675ef6fa, byte-file
 *        sha256 0ad00ed404abcd7944dd27b3a0ac2482ab882b3091f52cee80cd
 *        66f5b4f12f8f, 36 lines / 6189 bytes) BEFORE any PCS-002
 *        change, and re-run at HEAD byte-identically. This test pins
 *        the captured bytes durably: verdicts, rejection reasons,
 *        arbitration outcomes, the arbitrated catalog and the profile
 *        resolution are the EXACT pre-change bytes, and the absence
 *        spellings (`undefined` | `null`) reproduce them identically.
 *   S2 — UNKNOWN-VALUE FAIL-CLOSED: every closed field's unknown
 *        spelling is rejected by pure validation AND by the registry
 *        (never enters the catalog, never resolvable); the mutation
 *        record proves the protection lives in validation (a registry
 *        mutated to accept-anything admits the invalid block).
 *   S3 — BOUNDARY MISMATCH TYPING: every mismatch at the delegation
 *        boundary is a typed failure naming both sides; absence of
 *        either side skips the check exactly as today; the verdict is
 *        byte-identical on re-run.
 *   S4 — NO SILENT SUBSTITUTION: the arbitrated record distinguishes
 *        `deterministic-substitute` from `semantic-model-backed`
 *        mechanically (typed facts only, no prose).
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  checkSemanticFidelityBoundary,
  createCapabilityRegistry,
  createInMemoryCatalogStore,
  type PublishedCapabilityFact,
  SEED_CAPABILITY_FACTS,
  type SemanticFidelityFacts,
  validatePublishedFact,
} from "../../src/modules/capabilities/public";

const PUBLISHED_AT = "2026-08-30T00:00:00Z";
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

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

const substituteFacts: SemanticFidelityFacts = {
  representationKind: "deterministic-substitute",
  modality: "text",
  dimensionality: 512,
  normalization: "none",
  similaritySemantics: "hash-proximity",
  qualityContract: {
    kind: "declared",
    requirement: "requires-semantic-retrieval-quality",
    acceptanceBasis: "task-authored acceptance basis",
  },
  compatibilityConstraints: ["dimensionality-match", "normalization-match"],
  basis: {
    executionId: "exec-000456",
    capabilityId: "rag-embeddings",
    substituteId: "lexical-hash-vectorizer",
  },
};

// The EXACT pre-change baseline corpus (captured at the base commit
// before any PCS-002 change; the spellings carry NO semantic-fidelity
// block — the only spelling that existed at base).
const baselineFact = (
  id: string,
  kind: "model" | "tool" | "algorithm" | "data" | "runtime" | "human",
  version: string,
  attributes?: Record<string, string | number | boolean | null>,
): PublishedCapabilityFact => ({
  claim: { id, kind, version, ...(attributes === undefined ? {} : { attributes }) },
  provenance: { publisher: "pcs-002:baseline-probe", publishedAt: PUBLISHED_AT },
  evidence: { kind: "adapter-declared", reference: `pcs-002:baseline:${id}:${version}` },
});

const BASELINE_CORPUS: readonly PublishedCapabilityFact[] = [
  ...SEED_CAPABILITY_FACTS,
  baselineFact("probe-streaming", "model", "1.0.0", { streaming: true }),
  baselineFact("probe-streaming", "model", "1.1.0", { streaming: true }),
  baselineFact("probe-streaming", "model", "0.9.0", { streaming: false }),
  baselineFact("structured-output", "model", "2.3.1", { structured: true }),
  baselineFact("document-retrieval", "tool", "1.0.0", { deterministic: true }),
  baselineFact("process-sandbox", "runtime", "3.0.0"),
];

const BASELINE_INVALID: readonly PublishedCapabilityFact[] = [
  {
    claim: { id: "evidence-free-claim", kind: "model", version: "1.0.0" },
    provenance: { publisher: "pcs-002:baseline-probe", publishedAt: PUBLISHED_AT },
    evidence: { kind: "adapter-declared", reference: "" },
  },
  {
    claim: { id: "bad-kind", kind: "vibes" as never, version: "1.0.0" },
    provenance: { publisher: "pcs-002:baseline-probe", publishedAt: PUBLISHED_AT },
    evidence: { kind: "adapter-declared", reference: "pcs-002:bad-kind" },
  },
  {
    claim: { id: "bad-version", kind: "model", version: "1.x" },
    provenance: { publisher: "pcs-002:baseline-probe", publishedAt: PUBLISHED_AT },
    evidence: { kind: "adapter-declared", reference: "pcs-002:bad-version" },
  },
  {
    claim: { id: "Bad Id", kind: "model", version: "1.0.0" },
    provenance: { publisher: "pcs-002:baseline-probe", publishedAt: PUBLISHED_AT },
    evidence: { kind: "adapter-declared", reference: "pcs-002:bad-id" },
  },
  {
    claim: { id: "no-publisher", kind: "model", version: "1.0.0" },
    provenance: { publisher: "", publishedAt: PUBLISHED_AT },
    evidence: { kind: "adapter-declared", reference: "pcs-002:no-publisher" },
  },
];

/** Replay the baseline corpus exactly as the pre-change capture did. */
async function replayBaselineCorpus(): Promise<string[]> {
  const lines: string[] = [];
  for (const fact of BASELINE_CORPUS) {
    lines.push(
      `valid\t${fact.claim.id}@${fact.claim.version}\t${JSON.stringify(validatePublishedFact(fact))}`,
    );
  }
  for (const fact of BASELINE_INVALID) {
    lines.push(`invalid\t${fact.claim.id}\t${JSON.stringify(validatePublishedFact(fact))}`);
  }
  const registry = await createCapabilityRegistry({ store: createInMemoryCatalogStore() });
  for (const fact of BASELINE_CORPUS) {
    const outcome = await registry.publish(fact);
    lines.push(`publish\t${fact.claim.id}@${fact.claim.version}\t${JSON.stringify(outcome)}`);
  }
  lines.push(
    `republish-identical\t${JSON.stringify(await registry.publish(SEED_CAPABILITY_FACTS[0] as PublishedCapabilityFact))}`,
  );
  lines.push(
    `republish-conflict\t${JSON.stringify(
      await registry.publish(
        baselineFact("probe-streaming", "model", "1.0.0", { streaming: false }),
      ),
    )}`,
  );
  lines.push(
    `republish-kind-conflict\t${JSON.stringify(
      await registry.publish(baselineFact("probe-streaming", "tool", "1.0.0")),
    )}`,
  );
  lines.push(
    `publish-invalid\t${JSON.stringify(await registry.publish(BASELINE_INVALID[0] as PublishedCapabilityFact))}`,
  );
  const claims = await registry.listClaims();
  lines.push(`catalog\t${JSON.stringify(claims)}`);
  const resolution = await registry.resolve({
    requirements: [
      { id: "text-generation", kind: "model" },
      { id: "document-retrieval", kind: "tool" },
      { id: "probe-streaming", kind: "model", minVersion: "1.0.0" },
      { id: "quantum-orchestration", kind: "algorithm" },
      { id: "human-review", kind: "human" },
    ],
  });
  lines.push(`resolve\t${JSON.stringify(resolution)}`);
  lines.push(`catalogRevision\t${registry.catalogRevision}`);
  return lines;
}

describe("discrimination: semantic-fidelity typed facts (PCS-002 — the pure plane)", () => {
  test("S1a ABSENCE-EQUIVALENCE: the pre-change baseline corpus replays byte-identically (the pinned capture)", async () => {
    const lines = await replayBaselineCorpus();
    expect(lines).toHaveLength(36);
    // The pinned pre-change capture: sha256 over the exact 36-line
    // replay, captured at the base commit BEFORE any PCS-002 change
    // (0ad00ed404abcd7944dd27b3a0ac2482ab882b3091f52cee80cd66f5b4f12f8f)
    // — re-derived here at HEAD and compared byte-for-byte.
    expect(sha256(`${lines.join("\n")}\n`)).toBe(
      "0ad00ed404abcd7944dd27b3a0ac2482ab882b3091f52cee80cd66f5b4f12f8f",
    );
  });

  test("S1b the pre-change verdict and rejection bytes are pinned exactly (the discriminating artifacts)", async () => {
    const lines = await replayBaselineCorpus();
    const line = (prefix: string, index: number): string =>
      lines.filter((entry) => entry.startsWith(prefix))[index] ?? "";
    // Validation verdicts: the pre-change bytes.
    expect(line("valid", 0)).toBe('valid\ttext-generation@1.0.0\t{"valid":true}');
    expect(line("valid", 11)).toBe('valid\tprocess-sandbox@3.0.0\t{"valid":true}');
    // Rejection reasons: the pre-change bytes, fail-closed identically.
    expect(line("invalid", 0)).toBe(
      'invalid\tevidence-free-claim\t{"valid":false,"reason":"evidence.reference is mandatory for every capability claim"}',
    );
    expect(line("invalid", 1)).toBe(
      'invalid\tbad-kind\t{"valid":false,"reason":"claim.kind must be one of model|tool|algorithm|data|runtime|human"}',
    );
    expect(line("invalid", 2)).toBe(
      'invalid\tbad-version\t{"valid":false,"reason":"claim.version must match major[.minor[.patch]] numerically: 1.x"}',
    );
    expect(line("invalid", 3)).toBe(
      'invalid\tBad Id\t{"valid":false,"reason":"claim.id must be a neutral vocabulary slug (lowercase, <=64 chars): Bad Id"}',
    );
    expect(line("invalid", 4)).toBe(
      'invalid\tno-publisher\t{"valid":false,"reason":"provenance.publisher must be a non-empty string (<=128)"}',
    );
    // Arbitration outcomes: the pre-change bytes.
    expect(line("publish", 0)).toBe(
      'publish\ttext-generation@1.0.0\t{"status":"accepted","catalogRevision":"rev-1"}',
    );
    expect(line("republish-identical", 0)).toBe(
      'republish-identical\t{"status":"converged","catalogRevision":"rev-11"}',
    );
    expect(line("republish-conflict", 0)).toBe(
      'republish-conflict\t{"status":"rejected","reason":"claim probe-streaming@1.0.0 is already arbitrated with different attributes"}',
    );
    expect(line("republish-kind-conflict", 0)).toBe(
      'republish-kind-conflict\t{"status":"rejected","reason":"capability id probe-streaming is already bound to kind model"}',
    );
    // The resolution: the pre-change bytes.
    expect(line("resolve", 0)).toBe(
      'resolve\t{"satisfied":false,"catalogRevision":"rev-11","unmet":[{"requirementId":"quantum-orchestration","kind":"algorithm","reason":"unknown-capability","minVersion":null}]}',
    );
    expect(line("catalogRevision", 0)).toBe("catalogRevision\trev-11");
    // The arbitrated catalog: the pre-change record bytes carry NO
    // semantic-fidelity key anywhere (absence = byte-identical-today).
    const catalog = lines.find((entry) => entry.startsWith("catalog\t"));
    expect(catalog).toBeDefined();
    expect(catalog).not.toContain("semanticFidelity");
    expect(catalog).not.toContain("representationKind");
  });

  test("S1c the ABSENCE SPELLINGS (explicit undefined and null) reproduce the pre-change bytes identically", async () => {
    const withoutKey = baselineFact("probe-streaming", "model", "1.0.0", { streaming: true });
    const withUndefined = {
      ...baselineFact("probe-streaming", "model", "1.0.0", { streaming: true }),
      semanticFidelity: undefined,
    };
    const withNull = {
      ...baselineFact("probe-streaming", "model", "1.0.0", { streaming: true }),
      semanticFidelity: null,
    };
    // Pure validation: all three absence spellings produce the identical verdict.
    expect(JSON.stringify(validatePublishedFact(withoutKey))).toBe(
      JSON.stringify(validatePublishedFact(withUndefined)),
    );
    expect(JSON.stringify(validatePublishedFact(withoutKey))).toBe(
      JSON.stringify(validatePublishedFact(withNull)),
    );
    // Registry arbitration: all three spellings produce the identical
    // accepted outcome and the identical record BYTES (no
    // semanticFidelity key — the D8a absence-spelling discipline).
    const fresh: string[] = [];
    for (const fact of [withoutKey, withUndefined, withNull]) {
      const registry = await createCapabilityRegistry({ store: createInMemoryCatalogStore() });
      const outcome = await registry.publish(fact);
      expect(outcome).toEqual({ status: "accepted", catalogRevision: "rev-1" });
      fresh.push(JSON.stringify((await registry.listClaims())[0]));
    }
    expect(new Set(fresh).size).toBe(1);
    expect(fresh[0]).not.toContain("semanticFidelity");
    expect(fresh[0]).toBe(
      '{"claim":{"id":"probe-streaming","kind":"model","version":"1.0.0","attributes":{"streaming":true}},"provenance":{"publisher":"pcs-002:baseline-probe","publishedAt":"2026-08-30T00:00:00Z"},"evidence":{"kind":"adapter-declared","reference":"pcs-002:baseline:probe-streaming:1.0.0"},"acceptedAtRevision":"rev-1"}',
    );
  });

  test("S2a UNKNOWN-VALUE FAIL-CLOSED: every closed field's unknown spelling is rejected by pure validation AND by the registry", async () => {
    const mutations: readonly [string, Record<string, unknown>][] = [
      ["representationKind", { representationKind: "kinda-semantic" }],
      ["modality", { modality: "scent" }],
      ["dimensionality", { dimensionality: 0 }],
      ["normalization", { normalization: "whitened" }],
      ["similaritySemantics", { similaritySemantics: "jaccard" }],
      [
        "qualityContract.requirement",
        {
          qualityContract: {
            kind: "declared",
            requirement: "requires-good-vibes",
            acceptanceBasis: "x",
          },
        },
      ],
      ["compatibilityConstraints", { compatibilityConstraints: ["provider-match"] }],
      ["basis.executionId", { basis: { capabilityId: "semantic-embeddings" } }],
    ];
    for (const [field, mutation] of mutations) {
      // The invalid spelling rides a typed slot via `as never` (the
      // suite's established discipline for fail-closed probes).
      const invalid = {
        ...modelBackedFacts,
        ...mutation,
      } as never;
      // Pure validation rejects, naming the field and the value.
      const verdict = validatePublishedFact(factWith(invalid));
      expect(verdict.valid, `field ${field}`).toBe(false);
      // The registry rejects the whole fact: the block NEVER enters the
      // catalog and never satisfies a profile.
      const registry = await createCapabilityRegistry({ store: createInMemoryCatalogStore() });
      const outcome = await registry.publish(factWith(invalid));
      expect(outcome.status, `field ${field}`).toBe("rejected");
      expect(await registry.listClaims()).toHaveLength(0);
      const resolution = await registry.resolve({
        requirements: [{ id: "probe-claim", kind: "model" }],
      });
      expect(resolution.satisfied).toBe(false);
    }
  });

  test("S2b mutation record: a registry mutated to accept-anything admits the invalid block (the protection lives in validation)", async () => {
    const invalid = { ...modelBackedFacts, similaritySemantics: "jaccard" } as never;
    const mutant = await createCapabilityRegistry({
      store: createInMemoryCatalogStore(),
      validateFact: () => ({ valid: true }),
    });
    const outcome = await mutant.publish(factWith(invalid));
    // The mutant ACCEPTS what the real registry rejects — proving S2a
    // fails if the default validator is mutated to accept-anything.
    expect(outcome.status).toBe("accepted");
  });

  test("S3 BOUNDARY MISMATCH TYPING: every mismatch is a typed failure naming both sides; absence skips exactly as today", () => {
    // A deterministic-substitute producer against a model-backed
    // consumer with all three constraints declared — the ACR-009
    // motivating shape: EVERY constrained field mismatches.
    const verdict = checkSemanticFidelityBoundary({
      consumer: modelBackedFacts,
      producer: substituteFacts,
    });
    expect(verdict.kind).toBe("incompatible");
    if (verdict.kind === "incompatible") {
      expect(verdict.mismatches.map((mismatch) => mismatch.constraint)).toEqual([
        "dimensionality-match",
        "normalization-match",
        "similarity-semantics-match",
      ]);
      // Both sides are NAMED: the consumer's basis and the producer's
      // basis (including the substitute identity) ride every mismatch.
      for (const mismatch of verdict.mismatches) {
        expect(mismatch.consumerBasis.executionId).toBe("exec-000123");
        expect(mismatch.consumerBasis.capabilityId).toBe("semantic-embeddings");
        expect(mismatch.producerBasis.executionId).toBe("exec-000456");
        expect(mismatch.producerBasis.capabilityId).toBe("rag-embeddings");
        expect(mismatch.producerBasis.substituteId).toBe("lexical-hash-vectorizer");
      }
      expect(verdict.mismatches[0]?.consumerValue).toBe("768");
      expect(verdict.mismatches[0]?.producerValue).toBe("512");
      expect(verdict.mismatches[1]?.consumerValue).toBe("l2");
      expect(verdict.mismatches[1]?.producerValue).toBe("none");
    }
    // Determinism: byte-identical verdict on re-run (invariant 5).
    expect(
      JSON.stringify(
        checkSemanticFidelityBoundary({ consumer: modelBackedFacts, producer: substituteFacts }),
      ),
    ).toBe(JSON.stringify(verdict));
    // Absence of either side's facts skips the check exactly as today.
    expect(
      checkSemanticFidelityBoundary({ consumer: modelBackedFacts, producer: undefined }),
    ).toEqual({
      kind: "skipped",
      reason: "producer-facts-absent",
    });
    expect(
      checkSemanticFidelityBoundary({ consumer: undefined, producer: substituteFacts }),
    ).toEqual({
      kind: "skipped",
      reason: "consumer-facts-absent",
    });
    // A fully-constraint-matched pair is compatible.
    expect(
      checkSemanticFidelityBoundary({ consumer: modelBackedFacts, producer: modelBackedFacts }),
    ).toEqual({ kind: "compatible" });
  });

  test("S4 NO SILENT SUBSTITUTION: the arbitrated record distinguishes the kinds mechanically (typed facts, no prose)", async () => {
    const registry = await createCapabilityRegistry({ store: createInMemoryCatalogStore() });
    await registry.publish(factWith(substituteFacts, "substitute-claim"));
    await registry.publish(factWith(modelBackedFacts, "model-backed-claim"));
    const claims = await registry.listClaims();
    const substitute = claims.find((record) => record.claim.id === "substitute-claim");
    const modelBacked = claims.find((record) => record.claim.id === "model-backed-claim");
    // A consumer reading ONLY the typed record — no prose — separates
    // the two representation kinds (ACR-009 §2's evidence law).
    expect(substitute?.semanticFidelity?.representationKind).toBe("deterministic-substitute");
    expect(modelBacked?.semanticFidelity?.representationKind).toBe("semantic-model-backed");
    // The substitute record carries its full provenance mechanically.
    expect(substitute?.semanticFidelity?.basis.substituteId).toBe("lexical-hash-vectorizer");
    expect(substitute?.semanticFidelity?.basis.executionId).toBe("exec-000456");
    expect(substitute?.semanticFidelity?.basis.capabilityId).toBe("rag-embeddings");
  });
});

function factWith(
  semanticFidelity: PublishedCapabilityFact["semanticFidelity"],
  id = "probe-claim",
): PublishedCapabilityFact {
  return {
    claim: { id, kind: "model", version: "1.0.0", attributes: { streaming: true } },
    provenance: { publisher: "probe", publishedAt: PUBLISHED_AT },
    evidence: { kind: "adapter-declared", reference: `probe:ref:${id}` },
    ...(semanticFidelity === undefined ? {} : { semanticFidelity }),
  };
}
