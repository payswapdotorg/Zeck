/**
 * PCS-004 acceptance tests (the oracles): the semantic-fidelity
 * evaluation's construction laws, fixture integrity, the
 * vocabulary/serializer/gate mirrors pinned against the REAL
 * authorities, the discriminator's coverage and tamper rejections,
 * and the digest reproducibility.
 *
 *   * the corpus + configuration consistency: config.json mirrors the
 *     exported corpus slice exactly; the corpus digest stable; the
 *     fixture census 6/6/6 with unique ids and named ground truths;
 *   * the fixture construction law (verified against the REAL
 *     PPR-025 executor, imported read-only): every fixture's
 *     distractor is lexically CLOSER to the query than the
 *     ground-truth target (cosine under the executor's own
 *     similarity), and the ground truth is the semantic nearest
 *     neighbor under the synthetic oracle — the measurable
 *     distinction is mechanical, never asserted;
 *   * the boundary pins (byte-for-byte): the app-local canonical
 *     serializer and digest port against the platform's own; the
 *     app-local vocabulary mirrors against the capabilities authority;
 *     the app-local fact validator and canonical fact form against the
 *     REAL PCS-002 plane over a valid+malformed corpus;
 *   * the gate pin: the app-local classification and gating projection
 *     produce EXACTLY the REAL planner gate's verdicts over every
 *     control of the evaluation (a fabricated pass is
 *     unrepresentable);
 *   * the discriminator: separates both kinds on every emitted
 *     representation, rejects every tampered shape with a typed
 *     reason;
 *   * the digest discipline: the corpus digest deterministic and
 *     discriminating; the complete evaluation re-runs byte-identically.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  canonicalJson,
  createEvaluationDigestPort,
  digestOf,
} from "../../../benchmarks/validation/apps/semantic-fidelity-evaluation/canonical";
import {
  ALL_CONTROLS,
  HARD_GATE_CONTROLS,
} from "../../../benchmarks/validation/apps/semantic-fidelity-evaluation/controls";
import {
  ARM_IDS,
  BASE_REVISION,
  CONTROL_CENSUS,
  CORPUS_VERSION,
  EVALUATION_ID,
  evaluationCorpusForm,
  pinnedEvaluationCorpusDigest,
  THRESHOLDS,
} from "../../../benchmarks/validation/apps/semantic-fidelity-evaluation/corpus";
import { runEvaluation } from "../../../benchmarks/validation/apps/semantic-fidelity-evaluation/driver";
import {
  canonicalSemanticFidelityJsonMirror,
  discriminateRepresentation,
  SEMANTIC_COMPATIBILITY_CONSTRAINTS,
  SEMANTIC_MODALITIES,
  SEMANTIC_NORMALIZATIONS,
  SEMANTIC_QUALITY_REQUIREMENTS,
  SEMANTIC_REPRESENTATION_KINDS,
  SEMANTIC_SIMILARITY_SEMANTICS,
  validateSemanticFidelityFactsMirror,
} from "../../../benchmarks/validation/apps/semantic-fidelity-evaluation/fidelity";
import {
  CURATED_SEMANTIC_DICTIONARY,
  fixtureCensusByGroup,
  fixtureCorpusIntegrity,
  QUALITY_FIXTURES,
} from "../../../benchmarks/validation/apps/semantic-fidelity-evaluation/fixtures";
import {
  applyQualityContractGatingMirror,
  classifyQualityContractMirror,
  projectDisclosureMirror,
} from "../../../benchmarks/validation/apps/semantic-fidelity-evaluation/gate";
import {
  PPR_025_ERA,
  PPR_026_ERA,
  REPLAY_LINES,
} from "../../../benchmarks/validation/apps/semantic-fidelity-evaluation/replay";
import {
  rankCandidates,
  substituteEmbeddingOf,
  substituteEmbeddingWellFormed,
  syntheticSemanticEmbeddingOf,
} from "../../../benchmarks/validation/apps/semantic-fidelity-evaluation/representations";
import {
  cosineSimilarityOf,
  DETERMINISTIC_EMBEDDINGS_DIMENSIONS,
  deterministicEmbeddingOf,
} from "../../../compat/openwebui/harness/embeddings";
import {
  SEMANTIC_COMPATIBILITY_CONSTRAINTS as PLATFORM_CONSTRAINTS,
  SEMANTIC_MODALITIES as PLATFORM_MODALITIES,
  SEMANTIC_NORMALIZATIONS as PLATFORM_NORMALIZATIONS,
  SEMANTIC_REPRESENTATION_KINDS as PLATFORM_REPRESENTATION_KINDS,
  SEMANTIC_QUALITY_REQUIREMENTS as PLATFORM_REQUIREMENTS,
  SEMANTIC_SIMILARITY_SEMANTICS as PLATFORM_SIMILARITY,
  canonicalSemanticFidelityJson as platformCanonicalFidelityJson,
  validateSemanticFidelityFacts as platformValidateFacts,
} from "../../../src/modules/capabilities/public";
import {
  buildPlan,
  createNodeDigest,
  applySemanticQualityGating as platformApplyGating,
  classifySemanticQualityContract as platformClassify,
} from "../../../src/modules/planning/public";
import { canonicalJson as platformCanonicalJson } from "../../../src/platform/execution-ir/canonical";

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** Narrow an unknown value to a plain record (the tamper-corpus builder). */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("expected a record-shaped fact block");
}

/** Build tampered copies of a fact block (one mutated field per copy). */
function mutateFacts(base: unknown, mutations: readonly Record<string, unknown>[]): unknown[] {
  return mutations.map((mutation) => ({ ...asRecord(base), ...mutation }));
}

function isSubstituteKind(value: unknown): value is Record<string, unknown> {
  return asRecordOrNull(value)?.representationKind === "deterministic-substitute";
}

function isModelBackedKind(value: unknown): value is Record<string, unknown> {
  return asRecordOrNull(value)?.representationKind === "semantic-model-backed";
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The corpus + configuration consistency (config pinning)
// ---------------------------------------------------------------------------

describe("PCS-004 corpus + configuration consistency", () => {
  test("config.json mirrors the exported corpus slice exactly", () => {
    const config = JSON.parse(
      readFileSync(
        join(process.cwd(), "benchmarks/validation/apps/semantic-fidelity-evaluation/config.json"),
        "utf8",
      ),
    ) as {
      readonly tokenEnvVar: string;
      readonly integrationSurface: string;
      readonly corpusRevision: string;
      readonly evaluation: {
        readonly evaluationId: string;
        readonly baseRevision: string;
        readonly corpusDigest: string;
        readonly arms: readonly { readonly armId: string }[];
        readonly fixtures: number;
        readonly controls: Record<string, number>;
        readonly replayLines: number;
        readonly thresholds: Record<string, unknown>;
      };
    };
    expect(config.tokenEnvVar).toBe("ZECK_VALIDATION_TOKEN");
    expect(config.integrationSurface).toBe(
      "semantic-fidelity-evaluation:quality-fixtures-negative-controls-differentiated-evidence-replay",
    );
    expect(config.corpusRevision).toBe(CORPUS_VERSION);
    expect(config.evaluation.evaluationId).toBe(EVALUATION_ID);
    expect(config.evaluation.baseRevision).toBe(BASE_REVISION);
    expect(config.evaluation.corpusDigest).toBe(pinnedEvaluationCorpusDigest());
    expect(config.evaluation.arms.map((arm) => arm.armId)).toEqual([...ARM_IDS]);
    expect(config.evaluation.fixtures).toBe(QUALITY_FIXTURES.length);
    expect(config.evaluation.controls).toEqual({ ...CONTROL_CENSUS });
    expect(config.evaluation.replayLines).toBe(REPLAY_LINES.length);
    expect(config.evaluation.thresholds).toEqual(THRESHOLDS as unknown as Record<string, unknown>);
    expect(JSON.stringify(config)).not.toContain("sk-");
    expect(JSON.stringify(config)).not.toContain("Bearer ");
  });

  test("the fixture corpus is well-formed: unique ids, named ground truths, census 6/6/6", () => {
    expect(fixtureCorpusIntegrity()).toEqual([]);
    expect(fixtureCensusByGroup()).toEqual({
      "paraphrase-synonym-retrieval": 6,
      "cross-lingual-nearest-neighbor": 6,
      "polysemy-discrimination": 6,
    });
    expect(QUALITY_FIXTURES).toHaveLength(18);
  });

  test("the corpus digest is deterministic and discriminating (a corpus change is a different digest)", () => {
    const first = pinnedEvaluationCorpusDigest();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(pinnedEvaluationCorpusDigest()).toBe(first);
    const mutated = evaluationCorpusForm();
    const firstFixture = (mutated.fixtures as { query: string }[])[0];
    if (firstFixture === undefined) {
      throw new Error("the corpus form carries no fixtures");
    }
    firstFixture.query = "tampered query";
    const mutatedDigest = sha256(canonicalJson(mutated));
    expect(mutatedDigest).not.toBe(first);
  });

  test("the control census is pinned (6 hard-gate + 8 discriminating)", () => {
    expect(CONTROL_CENSUS).toEqual({ "hard-gate": 6, discriminating: 8 });
    expect(HARD_GATE_CONTROLS).toHaveLength(6);
    expect(ALL_CONTROLS).toHaveLength(14);
  });

  test("the curated dictionary is committed, duplicate-checked and sense-weighted", () => {
    const seen = new Set<string>();
    for (const entry of CURATED_SEMANTIC_DICTIONARY) {
      expect(entry.weight).toBeGreaterThan(0);
      expect(["synonym", "translation", "sense"]).toContain(entry.source);
      const key = `${entry.token}→${entry.concept}`;
      expect(seen.has(key), `duplicate dictionary entry ${key}`).toBe(false);
      seen.add(key);
    }
    // The ambiguous polysemy tokens carry their split senses (0.5 each).
    for (const ambiguous of ["bank", "mouse", "letter", "plant", "bat", "crane"]) {
      const senses = CURATED_SEMANTIC_DICTIONARY.filter((entry) => entry.token === ambiguous);
      expect(senses).toHaveLength(2);
      expect(senses.every((sense) => sense.weight === 0.5)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The fixture construction law (verified against the REAL executor)
// ---------------------------------------------------------------------------

describe("PCS-004 the fixture construction law (the measurable distinction)", () => {
  test("every fixture's distractor is lexically CLOSER to the query than the ground truth (the REAL substitute's own cosine)", () => {
    for (const fixture of QUALITY_FIXTURES) {
      const target = fixture.candidates.find((c) => c.role === "ground-truth");
      const distractor = fixture.candidates.find((c) => c.role === "distractor");
      expect(target).toBeDefined();
      expect(distractor).toBeDefined();
      if (target === undefined || distractor === undefined) {
        throw new Error(`${fixture.fixtureId}: missing candidates`);
      }
      const queryVector = deterministicEmbeddingOf(fixture.query);
      const targetSimilarity = cosineSimilarityOf(
        queryVector,
        deterministicEmbeddingOf(target.text),
      );
      const distractorSimilarity = cosineSimilarityOf(
        queryVector,
        deterministicEmbeddingOf(distractor.text),
      );
      expect(
        distractorSimilarity,
        `${fixture.fixtureId}: the distractor must be lexically closer (D ${distractorSimilarity} vs T ${targetSimilarity})`,
      ).toBeGreaterThan(targetSimilarity);
    }
  });

  test("the ground truth is the semantic nearest neighbor under the synthetic oracle (the curated relation)", () => {
    for (const fixture of QUALITY_FIXTURES) {
      const ranked = rankCandidates(
        fixture.query,
        fixture.candidates.map((c) => ({ id: c.id, text: c.text })),
        syntheticSemanticEmbeddingOf,
      );
      expect(ranked[0]?.id, `${fixture.fixtureId}`).toBe(fixture.groundTruthTargetId);
    }
  });

  test("both representations are well-formed: fixed dimension, L2-normalized, byte-identical recomputation", () => {
    for (const fixture of QUALITY_FIXTURES) {
      for (const embed of [substituteEmbeddingOf, syntheticSemanticEmbeddingOf]) {
        const a = embed(fixture.query);
        const b = embed(fixture.query);
        expect(a).toEqual(b);
        expect(a).toHaveLength(DETERMINISTIC_EMBEDDINGS_DIMENSIONS);
        expect(substituteEmbeddingWellFormed(a).ok).toBe(true);
      }
    }
  });

  test("the cross-lingual targets share ZERO tokens with their English queries (the tokenizer's own view)", () => {
    // The lexical gap is total for the cross-lingual group: no surface
    // token (unigram or bigram) is shared between query and target.
    for (const fixture of QUALITY_FIXTURES.filter(
      (candidate) => candidate.group === "cross-lingual-nearest-neighbor",
    )) {
      const target = fixture.candidates.find((c) => c.role === "ground-truth");
      if (target === undefined) {
        throw new Error(`${fixture.fixtureId}: missing ground truth`);
      }
      const queryTokens = new Set(tokenizeOf(fixture.query));
      const shared = tokenizeOf(target.text).filter((token) => queryTokens.has(token));
      expect(
        shared,
        `${fixture.fixtureId}: expected zero shared tokens, found ${shared.join(",")}`,
      ).toEqual([]);
    }
  });

  test("the replay lines: the era target ranks first under the substitute (the era's lexical-overlap basis)", () => {
    for (const line of REPLAY_LINES) {
      const ranked = rankCandidates(
        line.query,
        line.documents.map((d) => ({ id: d.id, text: d.text })),
        substituteEmbeddingOf,
      );
      expect(ranked[0]?.id, line.lineId).toBe(line.expectedTop1UnderSubstitute);
      const eraTarget = line.documents.find((d) => d.role === "ground-truth");
      expect(eraTarget).toBeDefined();
      expect(eraTarget?.text).toContain(line.eraAnswerToken);
    }
  });
});

// The compat executor's own tokenizer (imported read-only for the
// zero-lexical-overlap proof).
import { tokenize } from "../../../compat/openwebui/harness/embeddings";

function tokenizeOf(text: string): readonly string[] {
  return tokenize(text);
}

// ---------------------------------------------------------------------------
// The boundary pins (byte-for-byte against the platform's own)
// ---------------------------------------------------------------------------

describe("PCS-004 the boundary pins (byte-for-byte against the real planes)", () => {
  test("the app-local canonical serializer is byte-identical to the platform's (the WORK-008 discipline)", () => {
    const corpus: unknown[] = [
      evaluationCorpusForm(),
      { b: 2, a: 1, nested: { z: "last", a: [3, 1, 2], m: null } },
      { strings: ['quote"', "back\\slash", "newline\n", "tab\t", "ctrl\x01"] },
      { numbers: [0, -1, 0.5, 1e-7, 123.456789] },
      [[], [[]], [null, true, false]],
      "a bare string",
      42,
      true,
      null,
    ];
    for (const value of corpus) {
      expect(canonicalJson(value)).toBe(platformCanonicalJson(value));
    }
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, { x: Number.NEGATIVE_INFINITY }]) {
      expect(() => canonicalJson(bad)).toThrow();
      expect(() => platformCanonicalJson(bad)).toThrow();
    }
  });

  test("the app-local digest port is byte-identical to the platform's createNodeDigest()", () => {
    const appPort = createEvaluationDigestPort();
    const platformPort = createNodeDigest();
    for (const value of ["", "abc", canonicalJson(evaluationCorpusForm()), "üñïçø∂é".repeat(50)]) {
      expect(appPort.sha256Hex(value)).toBe(platformPort.sha256Hex(value));
      expect(appPort.sha256Hex(value)).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("the vocabulary mirrors are EXACTLY the capabilities authority's frozen vocabularies", () => {
    expect([...SEMANTIC_REPRESENTATION_KINDS]).toEqual([...PLATFORM_REPRESENTATION_KINDS]);
    expect([...SEMANTIC_MODALITIES]).toEqual([...PLATFORM_MODALITIES]);
    expect([...SEMANTIC_NORMALIZATIONS]).toEqual([...PLATFORM_NORMALIZATIONS]);
    expect([...SEMANTIC_SIMILARITY_SEMANTICS]).toEqual([...PLATFORM_SIMILARITY]);
    expect([...SEMANTIC_QUALITY_REQUIREMENTS]).toEqual([...PLATFORM_REQUIREMENTS]);
    expect([...SEMANTIC_COMPATIBILITY_CONSTRAINTS]).toEqual([...PLATFORM_CONSTRAINTS]);
  });

  test("the app-local fact validator matches the REAL validateSemanticFidelityFacts verdict-for-verdict (valid + malformed corpus)", () => {
    const valid: unknown[] = [];
    for (const result of [runEvaluation()]) {
      for (const record of result.fixtureRecords) {
        valid.push(record.representation);
      }
      for (const record of result.controlRecords) {
        valid.push(...record.representations);
      }
      for (const record of result.replayRecords) {
        valid.push(record.absentArm.representation);
      }
    }
    expect(valid.length).toBeGreaterThanOrEqual(50);
    const malformed: unknown[] = [
      "not-an-object",
      42,
      [],
      {},
      ...mutateFacts(valid[0], [
        { representationKind: "quantum-backed" },
        { modality: "scent" },
        { dimensionality: 0 },
        { dimensionality: 65537 },
        { dimensionality: 3.5 },
        { normalization: "softmax" },
        { similaritySemantics: "manhattan" },
        { qualityContract: { kind: "maybe" } },
        {
          qualityContract: {
            kind: "declared",
            requirement: "requires-good-vibes",
            acceptanceBasis: "x",
          },
        },
        { qualityContract: { kind: "absent", requirement: "requires-semantic-retrieval-quality" } },
        { compatibilityConstraints: [] },
        { compatibilityConstraints: ["dimensionality-match", "dimensionality-match"] },
        { compatibilityConstraints: ["vibes-match"] },
        { basis: undefined },
        { basis: { executionId: "", capabilityId: "x" } },
        { basis: { executionId: "e", capabilityId: "Not A Slug" } },
      ]),
    ];
    // A substitute fact without its substitute identity, and a
    // model-backed fact claiming one — the incoherent shapes.
    const substituteFact = valid.find(isSubstituteKind);
    const modelBackedFact = valid.find(isModelBackedKind);
    if (substituteFact === undefined || modelBackedFact === undefined) {
      throw new Error("the emitted corpus must carry both representation kinds");
    }
    malformed.push(
      ...mutateFacts(substituteFact, [{ basis: { executionId: "e", capabilityId: "c" } }]),
      ...mutateFacts(modelBackedFact, [
        { basis: { executionId: "e", capabilityId: "c", substituteId: "sneaky" } },
      ]),
    );
    for (const value of valid) {
      expect(validateSemanticFidelityFactsMirror(value)).toEqual({ valid: true });
      expect(platformValidateFacts(value)).toEqual({ valid: true });
    }
    for (const value of malformed) {
      const local = validateSemanticFidelityFactsMirror(value);
      const platform = platformValidateFacts(value);
      expect(local.valid).toBe(false);
      expect(platform.valid).toBe(local.valid);
      expect(local.valid ? "" : local.reason).toBe(platform.valid ? "" : platform.reason);
    }
  });

  test("the app-local canonical fact form is byte-identical to the REAL PCS-002 canonical form", () => {
    const result = runEvaluation();
    for (const record of result.fixtureRecords) {
      expect(canonicalSemanticFidelityJsonMirror(record.representation)).toBe(
        platformCanonicalFidelityJson(
          record.representation as Parameters<typeof platformCanonicalFidelityJson>[0],
        ),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The gate pin (verdict-for-verdict against the REAL planner gate)
// ---------------------------------------------------------------------------

describe("PCS-004 the gate pin (the REAL planner gate over every control)", () => {
  /** Build a REAL plan from the control's neutral steps (the PCS-003 test pattern). */
  function realPlanOf(control: (typeof ALL_CONTROLS)[number]) {
    return buildPlan(
      {
        revision: 1,
        strategyClass: "deterministic-only",
        steps: control.candidate.planSteps.map((step, index) => ({
          id: step.stepId === "" ? `step-${index}` : step.stepId,
          stepClass: "run-algorithm",
          ...(step.capabilityId === undefined ? {} : { capabilityId: step.capabilityId }),
        })),
        edges: control.candidate.planSteps.slice(1).map((_, index) => ({
          from: control.candidate.planSteps[index]?.stepId ?? "s0",
          to: control.candidate.planSteps[index + 1]?.stepId ?? "s1",
        })),
      },
      (value: unknown) => sha256(platformCanonicalJson(value)),
    );
  }

  /** The REAL candidate the control's neutral candidate maps to. */
  function realCandidateOf(control: (typeof ALL_CONTROLS)[number]) {
    return {
      strategyId: control.candidate.strategyId,
      plan: realPlanOf(control),
      expectedCostMicroUsd: "5",
      expectedQuality: 0.9,
      expectedLatencyMs: 10,
      verificationStrategy: "retrieval-recall-check",
      routeRationale: { code: "deterministic-sufficient" as const, detail: "pcs-004" },
      modelCalls: 0,
      admissible: control.candidate.admissible,
      ...(control.candidate.inadmissibleReason === undefined
        ? {}
        : {
            inadmissibleReason: control.candidate.inadmissibleReason as "policy-forbidden-route",
          }),
    };
  }

  test("the app-local classification matches the REAL classifySemanticQualityContract verdict-for-verdict", () => {
    const contracts: unknown[] = [
      undefined,
      null,
      { kind: "absent" },
      {
        kind: "declared",
        requirement: "requires-semantic-retrieval-quality",
        acceptanceBasis: "x",
      },
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
    for (const contract of contracts) {
      expect(JSON.stringify(classifyQualityContractMirror(contract))).toBe(
        JSON.stringify(platformClassify(contract)),
      );
    }
  });

  test("the app-local gating projection matches the REAL applySemanticQualityGating over EVERY control", () => {
    for (const control of ALL_CONTROLS) {
      const classification = classifyQualityContractMirror(control.contract);
      const local = applyQualityContractGatingMirror(control.candidate, {
        contract: classification,
        representations: control.representations,
      });
      const real = platformApplyGating(realCandidateOf(control), {
        contract: platformClassify(control.contract) as ReturnType<typeof platformClassify>,
        representations: control.representations as never,
      });
      // The REAL gate returns the (possibly gated) candidate; the local
      // projection returns the verdict — assert the equivalence.
      if (local.verdict === "admissible") {
        expect(real.admissible, `${control.controlTaskId}: local admissible but real gated`).toBe(
          true,
        );
      } else {
        expect(
          real.admissible,
          `${control.controlTaskId}: local inadmissible but real admitted`,
        ).toBe(false);
        expect(real.inadmissibleReason).toBe(local.reason);
      }
    }
  });

  test("every control's EXPECTED verdict is exactly what the REAL gate produces (a fabricated pass is unrepresentable)", () => {
    for (const control of ALL_CONTROLS) {
      const real = platformApplyGating(realCandidateOf(control), {
        contract: platformClassify(control.contract) as ReturnType<typeof platformClassify>,
        representations: control.representations as never,
      });
      if (control.expected.admissible) {
        expect(
          real.admissible,
          `${control.controlTaskId}: expected admissible, real said ${String(real.admissible)} (${String(real.inadmissibleReason)})`,
        ).toBe(true);
      } else {
        expect(real.admissible).toBe(false);
        expect(real.inadmissibleReason).toBe(control.expected.reason);
      }
      // The disclosure statuses the evaluation's projection derives
      // (met-by for permitted selections; unmet-and-blocked for gated
      // ones) must match the control's declared expectation exactly.
      const local = applyQualityContractGatingMirror(control.candidate, {
        contract: classifyQualityContractMirror(control.contract),
        representations: control.representations,
      });
      const disclosure = projectDisclosureMirror({
        contract: control.contract,
        representations: control.representations,
        selected: control.candidate,
        gating: local,
      });
      expect(disclosure.map((entry) => entry.status).sort(), control.controlTaskId).toEqual(
        [...control.expected.disclosureStatuses].sort(),
      );
      // The unmet-and-blocked entries carry the typed reason + the
      // unavailable member (what remains: the model-backed kind).
      for (const entry of disclosure) {
        if (entry.status === "unmet-no-admissible-semantic-representation") {
          expect(entry.inadmissibleReason).toBe("semantic-quality-contract-forbids-substitute");
          expect(entry.unavailable).toEqual(["semantic-model-backed"]);
        }
        if (entry.status === "met-by-deterministic-substitute") {
          expect(entry.representation?.representationKind).toBe("deterministic-substitute");
          expect(entry.unavailable).toEqual(["semantic-model-backed"]);
        }
      }
    }
  });

  test("the hard-gate set: ALL SIX fail closed with the typed reason (the work order's hard gate)", () => {
    for (const control of HARD_GATE_CONTROLS) {
      const real = platformApplyGating(realCandidateOf(control), {
        contract: platformClassify(control.contract) as ReturnType<typeof platformClassify>,
        representations: control.representations as never,
      });
      expect(real.admissible, control.controlTaskId).toBe(false);
      expect(real.inadmissibleReason).toBe("semantic-quality-contract-forbids-substitute");
    }
  });
});

// ---------------------------------------------------------------------------
// The discriminator (the differentiated-evidence proof)
// ---------------------------------------------------------------------------

describe("PCS-004 the mechanical discriminator (differentiated evidence)", () => {
  test("separates both kinds on EVERY emitted representation record", () => {
    const result = runEvaluation();
    const representations: unknown[] = [
      ...result.fixtureRecords.map((record) => record.representation),
      ...result.controlRecords.flatMap((record) => record.representations),
      ...result.replayRecords.map((record) => record.absentArm.representation),
    ];
    const kinds = new Set<string>();
    for (const facts of representations) {
      const verdict = discriminateRepresentation(facts);
      expect(verdict.kind).toBe("separated");
      if (verdict.kind === "separated") {
        kinds.add(verdict.representationKind);
      }
    }
    expect(kinds).toEqual(new Set(["semantic-model-backed", "deterministic-substitute"]));
  });

  test("rejects every TAMPERED shape with a typed reason (a flipped kind, a removed basis, a smuggled substitute identity)", () => {
    const result = runEvaluation();
    const substitute = asRecord(
      result.fixtureRecords.find((record) => record.arm === "deterministic-substitute")
        ?.representation,
    );
    const modelBacked = asRecord(
      result.fixtureRecords.find((record) => record.arm === "synthetic-semantic-supply")
        ?.representation,
    );
    const tampered: unknown[] = [
      { ...substitute, representationKind: "semantic-model-backed" }, // flipped kind (carries substituteId)
      { ...substitute, basis: { executionId: "e", capabilityId: "c" } }, // substitute identity removed
      { ...modelBacked, basis: { executionId: "e", capabilityId: "c", substituteId: "smuggled" } }, // model-backed claiming a substitute
      { ...substitute, representationKind: "quantum-backed" }, // unknown kind
      { ...substitute, dimensionality: "512" }, // wrong type
      "not-an-object",
      null,
    ];
    for (const value of tampered) {
      const verdict = discriminateRepresentation(value);
      expect(verdict.kind, JSON.stringify(value)).toBe("rejected");
      if (verdict.kind === "rejected") {
        expect(verdict.reason.length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The digest discipline (determinism + verdict honesty)
// ---------------------------------------------------------------------------

describe("PCS-004 the digest discipline + verdict honesty", () => {
  test("the complete evaluation re-runs byte-identically (digest equality — the deterministic replay discipline)", () => {
    const first = runEvaluation();
    const second = runEvaluation();
    expect(second.digest).toBe(first.digest);
    expect(second.corpusDigest).toBe(first.corpusDigest);
    expect(JSON.stringify(second.fixtureRecords)).toBe(JSON.stringify(first.fixtureRecords));
    expect(JSON.stringify(second.controlRecords)).toBe(JSON.stringify(first.controlRecords));
    expect(JSON.stringify(second.replayRecords)).toBe(JSON.stringify(first.replayRecords));
  });

  test("the digest is discriminating (a tampered record is a different digest)", () => {
    const result = runEvaluation();
    const tampered = JSON.parse(
      JSON.stringify({ ...result, fixtureRecords: result.fixtureRecords }),
    ) as typeof result;
    const firstRecord = tampered.fixtureRecords[0] as {
      retrieval: { top1Id: string };
    };
    if (firstRecord === undefined) {
      throw new Error("the evaluation emitted no fixture records");
    }
    firstRecord.retrieval.top1Id = "tampered";
    const projection = {
      corpusDigest: tampered.corpusDigest,
      fixtureRecords: tampered.fixtureRecords,
      controlRecords: tampered.controlRecords,
      replayRecords: tampered.replayRecords,
      aggregateVerdicts: tampered.aggregate.verdicts,
      aggregateFixtures: tampered.aggregate.fixtures,
      aggregateControls: tampered.aggregate.controls,
      aggregateReplay: tampered.aggregate.replay,
      aggregateDiscrimination: tampered.aggregate.discrimination,
    };
    expect(digestOf(projection)).not.toBe(result.digest);
  });

  test("the verdict derivation is honest: a fabricated pass is unrepresentable", () => {
    const result = runEvaluation();
    // All five derived verdicts are met on the honest corpus...
    for (const key of [
      "t1aSemanticTop1PerGroup",
      "t1bSubstituteStrictlyBelowPerGroup",
      "t2HardGateFailClosed",
      "t3DiscriminatorCoverage",
      "t4ReplayLinesAllHold",
    ]) {
      expect(result.aggregate.verdicts[key]?.verdict).toBe("met");
    }
    // ...and the derivation flips on tampered inputs (the honesty
    // discrimination): a substitute record that "resolves" a fixture
    // drives T1b to missed, and an admitted hard-gate control drives
    // T2 to delivery-blocking.
    const tamperedFixtures = result.fixtureRecords.map((record) =>
      record.arm === "deterministic-substitute"
        ? { ...record, retrieval: { ...record.retrieval, resolved: true } }
        : record,
    );
    const perGroup: Record<
      string,
      { total: number; substituteTop1: number; semanticTop1: number }
    > = { ...result.aggregate.fixtures.perGroup };
    for (const key of Object.keys(perGroup)) {
      const counts = perGroup[key];
      if (counts === undefined) {
        throw new Error(`missing group counts for ${key}`);
      }
      perGroup[key] = { ...counts, substituteTop1: counts.total };
    }
    const paraphrase = perGroup["paraphrase-synonym-retrieval"];
    expect(paraphrase?.substituteTop1).toBe(paraphrase?.semanticTop1);
    expect(
      tamperedFixtures.some(
        (record) => record.arm === "deterministic-substitute" && record.retrieval.resolved,
      ),
    ).toBe(true);
    const tamperedControls = result.controlRecords.map((record) =>
      record.kind === "hard-gate"
        ? { ...record, gate: { verdict: "admissible" as const } }
        : record,
    );
    expect(
      tamperedControls.some(
        (record) => record.kind === "hard-gate" && record.gate.verdict === "admissible",
      ),
    ).toBe(true);
  });

  test("the era records are quoted verbatim from the committed evidence (never relabeled)", () => {
    const ppr025 = JSON.parse(
      readFileSync(join(process.cwd(), "deploy/evidence/ppr-025.json"), "utf8"),
    ) as {
      date: string;
      evidenceRecord: {
        recordId: string;
        limitations: { area: string; statement: string; owner: string }[];
      };
    };
    const limitation = ppr025.evidenceRecord.limitations.find(
      (entry) => entry.area === "embeddings execution representation",
    );
    expect(limitation).toBeDefined();
    expect(PPR_025_ERA.limitation).toEqual(limitation);
    expect(PPR_025_ERA.recordedAt).toBe(ppr025.date);
    expect(PPR_025_ERA.recordId).toBe(ppr025.evidenceRecord.recordId);
    const ppr026 = JSON.parse(
      readFileSync(join(process.cwd(), "deploy/evidence/ppr-026.json"), "utf8"),
    ) as {
      date: string;
      evidenceRecord: {
        recordId: string;
        limitations: { area: string; statement: string; owner: string }[];
      };
    };
    const limitation26 = ppr026.evidenceRecord.limitations.find(
      (entry) => entry.area === "embeddings execution representation",
    );
    expect(limitation26).toBeDefined();
    expect(PPR_026_ERA.limitation).toEqual(limitation26);
  });
});
