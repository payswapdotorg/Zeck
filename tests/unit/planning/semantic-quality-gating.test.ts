/**
 * Unit: planner quality-contract gating + substitute disclosure (planning
 * module domain; ACR-009 §3–§5; work order PCS-003).
 *
 * Covers every new pure path of `semantic-quality-gating.ts` and the
 * additive extensions it wires through:
 *  - the quality-contract classification matrix (undeclared | absent |
 *    declared | malformed — fail-closed, total);
 *  - the representation projection from capability resolutions (the
 *    satisfaction pass-through, absence-equivalent);
 *  - the gating semantics (composed after policy; typed reason; the
 *    invariant-13 boundary; byte-identity when nothing is declared);
 *  - the substitution capture (permitted selection; absent facts);
 *  - the disclosure projection (met / unmet / null);
 *  - the closed-shape capture validator (every malformed capture shape);
 *  - the task-profile contract derivation (valid/absent/malformed; the
 *    digest's absence-equivalence);
 *  - the vocabulary mirror pin against the capabilities authority.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  createCapabilityRegistry,
  createInMemoryCatalogStore,
  type PublishedCapabilityFact,
  SEED_CAPABILITY_FACTS,
  SEMANTIC_QUALITY_REQUIREMENTS,
  type SemanticFidelityFacts,
} from "../../../src/modules/capabilities/public";
import { canonicalJson } from "../../../src/modules/planning/domain";
import {
  applySemanticQualityGating,
  buildPlan,
  buildSemanticSubstitutionCapture,
  classifySemanticQualityContract,
  deriveTaskProfile,
  projectSemanticDisclosure,
  SEMANTIC_QUALITY_REQUIREMENT_VOCABULARY,
  semanticRepresentationsOf,
  validateSemanticSubstitutionCapture,
} from "../../../src/modules/planning/public";
import { PlatformError } from "../../../src/shared/errors";

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
// The planning identity discipline: digests run over the CANONICAL form.
const digest = (value: unknown): string => sha256(canonicalJson(value));

const SUBSTITUTE_FACTS: SemanticFidelityFacts = {
  representationKind: "deterministic-substitute",
  modality: "text",
  dimensionality: 512,
  normalization: "none",
  similaritySemantics: "hash-proximity",
  qualityContract: { kind: "absent" },
  compatibilityConstraints: ["dimensionality-match", "normalization-match"],
  basis: {
    executionId: "exec-000456",
    capabilityId: "rag-embeddings",
    substituteId: "lexical-hash-vectorizer",
  },
};

const MODEL_BACKED_FACTS: SemanticFidelityFacts = {
  representationKind: "semantic-model-backed",
  modality: "text",
  dimensionality: 768,
  normalization: "l2",
  similaritySemantics: "cosine",
  qualityContract: { kind: "absent" },
  compatibilityConstraints: ["dimensionality-match"],
  basis: { executionId: "exec-000123", capabilityId: "semantic-embeddings" },
};

const substitutePlan = buildPlan(
  {
    revision: 1,
    strategyClass: "deterministic-only",
    steps: [
      { id: "det-0", stepClass: "run-algorithm", capabilityId: "rag-embeddings" },
      { id: "verify", stepClass: "verify" },
    ],
    edges: [{ from: "det-0", to: "verify" }],
  },
  digest,
);

const substituteCandidate = {
  strategyId: "deterministic-only",
  plan: substitutePlan,
  expectedCostMicroUsd: "5",
  expectedQuality: 0.9,
  expectedLatencyMs: 10,
  verificationStrategy: "retrieval-recall-check",
  routeRationale: { code: "deterministic-sufficient" as const, detail: "unit" },
  modelCalls: 0,
  admissible: true,
};

const substituteRepresentations = [
  {
    requirementId: "rag-embeddings",
    representationKind: "deterministic-substitute" as const,
    claimId: "rag-embeddings",
    claimVersion: "1.0.0",
    publisher: "unit:probe",
    basis: {
      executionId: "exec-000456",
      capabilityId: "rag-embeddings",
      substituteId: "lexical-hash-vectorizer",
    },
  },
];

const modelBackedRepresentations = [
  {
    requirementId: "semantic-embeddings",
    representationKind: "semantic-model-backed" as const,
    claimId: "semantic-embeddings",
    claimVersion: "1.0.0",
    publisher: "unit:probe",
    basis: { executionId: "exec-000123", capabilityId: "semantic-embeddings" },
  },
];

const DECLARED = {
  kind: "declared",
  requirement: "requires-semantic-retrieval-quality",
  acceptanceBasis: "paraphrase retrieval must be semantically faithful",
} as const;

describe("unit: semantic quality-contract classification (PCS-003)", () => {
  test("the vocabulary mirror is pinned against the capabilities authority (the workload-class precedent)", () => {
    expect([...SEMANTIC_QUALITY_REQUIREMENT_VOCABULARY]).toEqual([
      ...SEMANTIC_QUALITY_REQUIREMENTS,
    ]);
    expect([...SEMANTIC_QUALITY_REQUIREMENT_VOCABULARY]).toEqual([
      "requires-semantic-retrieval-quality",
    ]);
  });

  test("classification matrix: undeclared, absent, declared and every malformed shape", () => {
    expect(classifySemanticQualityContract(undefined)).toEqual({ kind: "undeclared" });
    expect(classifySemanticQualityContract(null)).toEqual({ kind: "undeclared" });
    expect(classifySemanticQualityContract({ kind: "absent" })).toEqual({ kind: "absent" });
    expect(classifySemanticQualityContract(DECLARED)).toEqual({
      kind: "declared",
      requirement: "requires-semantic-retrieval-quality",
      acceptanceBasis: "paraphrase retrieval must be semantically faithful",
    });
    const malformed: unknown[] = [
      "declared",
      42,
      [],
      {},
      { kind: "maybe" },
      { kind: "absent", requirement: "requires-semantic-retrieval-quality" },
      { kind: "absent", acceptanceBasis: "x" },
      { kind: "declared" },
      { kind: "declared", requirement: "requires-good-vibes", acceptanceBasis: "x" },
      { kind: "declared", requirement: 7, acceptanceBasis: "x" },
      { kind: "declared", requirement: "requires-semantic-retrieval-quality" },
      { kind: "declared", requirement: "requires-semantic-retrieval-quality", acceptanceBasis: "" },
      {
        kind: "declared",
        requirement: "requires-semantic-retrieval-quality",
        acceptanceBasis: "x".repeat(201),
      },
    ];
    for (const value of malformed) {
      const verdict = classifySemanticQualityContract(value);
      expect(verdict.kind, JSON.stringify(value)).toBe("malformed");
      expect((verdict as { reason: string }).reason.length).toBeGreaterThan(0);
    }
    // Determinism: byte-identical verdicts on re-run (invariant 5).
    expect(JSON.stringify(classifySemanticQualityContract(DECLARED))).toBe(
      JSON.stringify(classifySemanticQualityContract({ ...DECLARED })),
    );
  });
});

describe("unit: representation projection from capability resolutions (PCS-003)", () => {
  const factWith = (
    semanticFidelity: PublishedCapabilityFact["semanticFidelity"],
    id = "probe-claim",
  ): PublishedCapabilityFact => ({
    claim: { id, kind: "algorithm", version: "1.0.0", attributes: { deterministic: true } },
    provenance: { publisher: "unit:probe", publishedAt: "2026-10-13T00:00:00Z" },
    evidence: { kind: "adapter-declared", reference: `unit:${id}` },
    ...(semanticFidelity === undefined ? {} : { semanticFidelity }),
  });

  test("a resolution over claims WITHOUT facts projects the empty array (absence-equivalent)", async () => {
    const registry = await createCapabilityRegistry({
      store: createInMemoryCatalogStore(),
      seed: SEED_CAPABILITY_FACTS,
    });
    const resolution = await registry.resolve({
      requirements: [
        { id: "text-generation", kind: "model" },
        { id: "document-retrieval", kind: "tool" },
      ],
    });
    expect(resolution.satisfied).toBe(true);
    expect(semanticRepresentationsOf(resolution)).toEqual([]);
  });

  test("a resolution over a substitute-declaring claim carries the typed representation summary", async () => {
    const registry = await createCapabilityRegistry({
      store: createInMemoryCatalogStore(),
      seed: [...SEED_CAPABILITY_FACTS, factWith(SUBSTITUTE_FACTS, "rag-embeddings")],
    });
    const resolution = await registry.resolve({
      requirements: [{ id: "rag-embeddings", kind: "algorithm" }],
    });
    expect(semanticRepresentationsOf(resolution)).toEqual(substituteRepresentations);
  });

  test("a resolution over a model-backed-declaring claim carries the model-backed representation summary", async () => {
    const registry = await createCapabilityRegistry({
      store: createInMemoryCatalogStore(),
      seed: [...SEED_CAPABILITY_FACTS, factWith(MODEL_BACKED_FACTS, "semantic-embeddings")],
    });
    const resolution = await registry.resolve({
      requirements: [{ id: "semantic-embeddings", kind: "algorithm" }],
    });
    expect(semanticRepresentationsOf(resolution)).toEqual(modelBackedRepresentations);
  });

  test("an UNSATISFIED resolution projects the empty array (no facts to consume)", () => {
    expect(
      semanticRepresentationsOf({
        satisfied: false,
        catalogRevision: "rev-0",
        unmet: [
          { requirementId: "x", kind: "algorithm", reason: "unknown-capability", minVersion: null },
        ],
      }),
    ).toEqual([]);
  });

  test("the satisfaction pass-through is absence-equivalent: no facts → no key (byte-identical resolution)", async () => {
    const registry = await createCapabilityRegistry({
      store: createInMemoryCatalogStore(),
      seed: SEED_CAPABILITY_FACTS,
    });
    const resolution = await registry.resolve({
      requirements: [{ id: "json-schema-validation", kind: "algorithm" }],
    });
    expect(JSON.stringify(resolution)).not.toContain("semanticFidelity");
    expect(JSON.stringify(resolution)).toBe(
      '{"satisfied":true,"catalogRevision":"rev-6","satisfactions":[{"requirementId":"json-schema-validation","claimId":"json-schema-validation","claimKind":"algorithm","claimVersion":"1.0.0","evidenceKind":"catalog-seeded","evidenceReference":"zeck-capability-catalog:v1:json-schema-validation","publisher":"capabilities:seed-catalog"}]}',
    );
  });
});

describe("unit: the typed quality-contract gating (PCS-003)", () => {
  test("undeclared and absent contracts return the candidate UNCHANGED (byte-identical)", () => {
    for (const contract of [undefined, { kind: "absent" } as const]) {
      const gated = applySemanticQualityGating(substituteCandidate, {
        contract: classifySemanticQualityContract(contract),
        representations: substituteRepresentations,
      });
      expect(gated).toBe(substituteCandidate);
      expect(JSON.stringify(gated)).toBe(JSON.stringify(substituteCandidate));
    }
  });

  test("a declared contract makes the substitute-carrying candidate inadmissible with the typed family reason", () => {
    const gated = applySemanticQualityGating(substituteCandidate, {
      contract: classifySemanticQualityContract(DECLARED),
      representations: substituteRepresentations,
    });
    expect(gated.admissible).toBe(false);
    expect(gated.inadmissibleReason).toBe("semantic-quality-contract-forbids-substitute");
    // The composed shape matches the existing family exactly (key order
    // and spelling: {...candidate, admissible, inadmissibleReason}).
    expect(JSON.stringify(gated)).toBe(
      JSON.stringify({
        ...substituteCandidate,
        admissible: false,
        inadmissibleReason: "semantic-quality-contract-forbids-substitute",
      }),
    );
  });

  test("a model-backed representation NEVER gates (the negative control)", () => {
    const modelBackedPlan = buildPlan(
      {
        revision: 1,
        strategyClass: "deterministic-only",
        steps: [
          { id: "det-0", stepClass: "run-algorithm", capabilityId: "semantic-embeddings" },
          { id: "verify", stepClass: "verify" },
        ],
        edges: [{ from: "det-0", to: "verify" }],
      },
      digest,
    );
    const candidate = { ...substituteCandidate, plan: modelBackedPlan };
    const gated = applySemanticQualityGating(candidate, {
      contract: classifySemanticQualityContract(DECLARED),
      representations: modelBackedRepresentations,
    });
    expect(gated).toBe(candidate);
    expect(gated.admissible).toBe(true);
  });

  test("a candidate without substituted steps is never gated (steps without capabilityId are skipped)", () => {
    const cleanPlan = buildPlan(
      {
        revision: 1,
        strategyClass: "deterministic-only",
        steps: [
          { id: "det-0", stepClass: "run-algorithm", capabilityId: "numeric-computation" },
          { id: "verify", stepClass: "verify" },
        ],
        edges: [{ from: "det-0", to: "verify" }],
      },
      digest,
    );
    const candidate = { ...substituteCandidate, plan: cleanPlan };
    const gated = applySemanticQualityGating(candidate, {
      contract: classifySemanticQualityContract(DECLARED),
      representations: substituteRepresentations,
    });
    expect(gated).toBe(candidate);
  });

  test("an already-inadmissible candidate is returned UNCHANGED (invariant 13: policy verdicts are never revised)", () => {
    const policyInadmissible = {
      ...substituteCandidate,
      admissible: false,
      inadmissibleReason: "policy-quality-floor" as const,
    };
    expect(
      applySemanticQualityGating(policyInadmissible, {
        contract: classifySemanticQualityContract(DECLARED),
        representations: substituteRepresentations,
      }),
    ).toBe(policyInadmissible);
  });

  test("no representations → nothing ever gates, whatever the contract", () => {
    const gated = applySemanticQualityGating(substituteCandidate, {
      contract: classifySemanticQualityContract(DECLARED),
      representations: [],
    });
    expect(gated).toBe(substituteCandidate);
  });
});

describe("unit: the substitution capture (PCS-003)", () => {
  test("a permitted selected substitute builds the typed capture with full provenance", () => {
    const capture = buildSemanticSubstitutionCapture({
      contract: undefined,
      representations: substituteRepresentations,
      selected: substituteCandidate,
    });
    expect(capture).toEqual({
      qualityContract: { kind: "absent" },
      representations: substituteRepresentations,
      substitutions: [
        {
          requirementId: "rag-embeddings",
          representationKind: "deterministic-substitute",
          claimId: "rag-embeddings",
          claimVersion: "1.0.0",
          publisher: "unit:probe",
          basis: {
            executionId: "exec-000456",
            capabilityId: "rag-embeddings",
            substituteId: "lexical-hash-vectorizer",
          },
        },
      ],
    });
  });

  test("a declared governing contract rides the capture verbatim", () => {
    const capture = buildSemanticSubstitutionCapture({
      contract: DECLARED,
      representations: substituteRepresentations,
      selected: substituteCandidate,
    });
    expect(capture?.qualityContract).toEqual(DECLARED);
  });

  test("no representation facts → no capture (absence-equivalent)", () => {
    expect(
      buildSemanticSubstitutionCapture({
        contract: DECLARED,
        representations: [],
        selected: substituteCandidate,
      }),
    ).toBeUndefined();
  });

  test("a selected plan that carries no substituted step → capture with empty substitutions", () => {
    const cleanPlan = buildPlan(
      {
        revision: 1,
        strategyClass: "deterministic-only",
        steps: [
          { id: "det-0", stepClass: "run-algorithm", capabilityId: "numeric-computation" },
          { id: "verify", stepClass: "verify" },
        ],
        edges: [{ from: "det-0", to: "verify" }],
      },
      digest,
    );
    const capture = buildSemanticSubstitutionCapture({
      contract: undefined,
      representations: substituteRepresentations,
      selected: { ...substituteCandidate, plan: cleanPlan },
    });
    expect(capture).toBeDefined();
    expect(capture?.substitutions).toEqual([]);
  });
});

describe("unit: the disclosure projection (PCS-003)", () => {
  const baseRecord = {
    taskProfile: {},
    candidates: [],
  };

  test("no facts → null (the absence-equivalent projection)", () => {
    expect(projectSemanticDisclosure(baseRecord)).toBeNull();
  });

  test("met-by-substitute entry carries kind + provenance and the unavailable member", () => {
    const capture = buildSemanticSubstitutionCapture({
      contract: undefined,
      representations: substituteRepresentations,
      selected: substituteCandidate,
    });
    const disclosure = projectSemanticDisclosure({
      ...baseRecord,
      semanticSubstitution: capture ?? undefined,
    });
    expect(disclosure).toEqual({
      qualityContract: { kind: "absent" },
      entries: [
        {
          requirementId: "rag-embeddings",
          status: "met-by-deterministic-substitute",
          representation: capture?.substitutions[0],
          unavailable: ["semantic-model-backed"],
        },
      ],
    });
  });

  test("unmet-and-blocked entry derives from a declared contract + a gated candidate + an unsatisfied substitute", () => {
    const gatedCandidate = applySemanticQualityGating(substituteCandidate, {
      contract: classifySemanticQualityContract(DECLARED),
      representations: substituteRepresentations,
    });
    const disclosure = projectSemanticDisclosure({
      taskProfile: { semanticQualityContract: DECLARED },
      candidates: [gatedCandidate],
      semanticSubstitution: {
        qualityContract: { kind: "absent" },
        representations: substituteRepresentations,
        substitutions: [],
      },
    });
    expect(disclosure).toEqual({
      qualityContract: DECLARED,
      entries: [
        {
          requirementId: "rag-embeddings",
          status: "unmet-no-admissible-semantic-representation",
          declaredRequirement: "requires-semantic-retrieval-quality",
          unavailable: ["semantic-model-backed"],
          inadmissibleReason: "semantic-quality-contract-forbids-substitute",
        },
      ],
    });
  });

  test("a declared contract without capability facts projects the honest EMPTY disclosure (nothing substituted, nothing blocked)", () => {
    expect(
      projectSemanticDisclosure({
        ...baseRecord,
        taskProfile: { semanticQualityContract: DECLARED },
      }),
    ).toEqual({ qualityContract: DECLARED, entries: [] });
    // With NO semantic facts at all the projection is null
    // (absence-equivalent: no facts, no disclosure).
    expect(projectSemanticDisclosure(baseRecord)).toBeNull();
  });
});

describe("unit: the capture closed-shape validator (PCS-003)", () => {
  const validCapture = {
    qualityContract: { kind: "absent" },
    representations: substituteRepresentations,
    substitutions: [
      {
        requirementId: "rag-embeddings",
        representationKind: "deterministic-substitute",
        claimId: "rag-embeddings",
        claimVersion: "1.0.0",
        publisher: "unit:probe",
        basis: {
          executionId: "exec-000456",
          capabilityId: "rag-embeddings",
          substituteId: "lexical-hash-vectorizer",
        },
      },
    ],
  };

  test("the valid capture passes; validatePlanningDecision accepts a record carrying it", () => {
    expect(() => validateSemanticSubstitutionCapture(validCapture)).not.toThrow();
  });

  test("every malformed capture shape fails closed typed", () => {
    const malformed: unknown[] = [
      null,
      "capture",
      { ...validCapture, qualityContract: undefined },
      {
        ...validCapture,
        qualityContract: {
          kind: "declared",
          requirement: "requires-good-vibes",
          acceptanceBasis: "x",
        },
      },
      { ...validCapture, representations: [] },
      { ...validCapture, representations: "nope" },
      {
        ...validCapture,
        representations: [{ ...substituteRepresentations[0], representationKind: "vibes" }],
      },
      {
        ...validCapture,
        representations: [
          {
            requirementId: "rag-embeddings",
            representationKind: "semantic-model-backed",
            claimId: "rag-embeddings",
            claimVersion: "1.0.0",
            publisher: "unit:probe",
            basis: {
              executionId: "exec-000456",
              capabilityId: "rag-embeddings",
              substituteId: "lexical-hash-vectorizer",
            },
          },
        ],
      },
      { ...validCapture, substitutions: "nope" },
      {
        ...validCapture,
        substitutions: [
          {
            requirementId: "rag-embeddings",
            representationKind: "semantic-model-backed",
            claimId: "rag-embeddings",
            claimVersion: "1.0.0",
            publisher: "unit:probe",
            basis: {
              executionId: "exec-000456",
              capabilityId: "rag-embeddings",
              substituteId: "x",
            },
          },
        ],
      },
      {
        ...validCapture,
        substitutions: [
          {
            requirementId: "rag-embeddings",
            representationKind: "deterministic-substitute",
            claimId: "rag-embeddings",
            claimVersion: "1.0.0",
            publisher: "unit:probe",
            basis: { executionId: "exec-000456", capabilityId: "rag-embeddings" },
          },
        ],
      },
    ];
    for (const value of malformed) {
      expect(() => validateSemanticSubstitutionCapture(value), JSON.stringify(value)).toThrowError(
        PlatformError,
      );
    }
  });
});

describe("unit: the task-profile contract derivation (PCS-003)", () => {
  const baseTask = {
    kind: "mixed",
    semanticReasoning: false,
    requiredCapabilities: [{ id: "numeric-computation", kind: "algorithm" }],
    input: { expression: "2+2" },
  };

  test("an undeclared contract adds NO key and leaves the profile digest byte-identical to the pre-change spelling", () => {
    const without = deriveTaskProfile({ task: { ...baseTask } }, digest);
    expect("semanticQualityContract" in without).toBe(false);
    expect(JSON.stringify(without)).not.toContain("semanticQualityContract");
    // The digest input has exactly the pre-change keys.
    expect(without.profileDigest).toBe(
      digest({
        profileSchema: 1,
        kind: "mixed",
        input: { expression: "2+2" },
        outputCharacteristics: { type: "unknown" },
        riskLevel: "medium",
        qualityTarget: 0.8,
        maxCostMicroUsd: null,
        maxLatencyMs: null,
        requiresSemanticReasoning: false,
        capabilityRequirements: [{ id: "numeric-computation", kind: "algorithm" }],
      }),
    );
  });

  test("a declared contract rides the profile and its digest input", () => {
    const withContract = deriveTaskProfile(
      { task: { ...baseTask, semanticQualityContract: DECLARED } },
      digest,
    );
    expect(withContract.semanticQualityContract).toEqual(DECLARED);
    expect(withContract.profileDigest).toBe(
      digest({
        profileSchema: 1,
        kind: "mixed",
        input: { expression: "2+2" },
        outputCharacteristics: { type: "unknown" },
        riskLevel: "medium",
        qualityTarget: 0.8,
        maxCostMicroUsd: null,
        maxLatencyMs: null,
        requiresSemanticReasoning: false,
        capabilityRequirements: [{ id: "numeric-computation", kind: "algorithm" }],
        semanticQualityContract: DECLARED,
      }),
    );
  });

  test('the explicit absence spelling rides the profile ({kind: "absent"})', () => {
    const explicit = deriveTaskProfile(
      { task: { ...baseTask, semanticQualityContract: { kind: "absent" } } },
      digest,
    );
    expect(explicit.semanticQualityContract).toEqual({ kind: "absent" });
  });

  test("malformed contracts reject the profile typed (fail closed at the authoring boundary)", () => {
    const malformed: unknown[] = [
      { kind: "declared", requirement: "requires-good-vibes", acceptanceBasis: "x" },
      { kind: "maybe" },
      { kind: "absent", requirement: "requires-semantic-retrieval-quality" },
      { kind: "declared", requirement: "requires-semantic-retrieval-quality", acceptanceBasis: "" },
      "declared",
      42,
    ];
    for (const contract of malformed) {
      expect(
        () =>
          deriveTaskProfile({ task: { ...baseTask, semanticQualityContract: contract } }, digest),
        JSON.stringify(contract),
      ).toThrowError(/semanticQualityContract is malformed/);
    }
  });
});
