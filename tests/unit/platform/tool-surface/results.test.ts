/**
 * Compact structured results unit tests (WORK-051): typed per-operation
 * value shapes, bounded serialization, content-addressed digests, the
 * round-trip identity proof, and the plan's result-contract binding
 * (mechanical-family steps only).
 */

import { describe, expect, test } from "vitest";
import {
  bindResultToPlan,
  buildCompactResult,
  roundTripCompactResult,
  validateCompactResult,
  type ResultStepFacts,
} from "../../../../src/platform/tool-surface/results";
import { ProgrammaticError, validateProgrammaticSpec } from "../../../../src/platform/tool-surface/programmatic";
import { nodeDigest } from "./world";

function filterSpec() {
  return validateProgrammaticSpec({
    specId: "curate-filter",
    stepId: "curate",
    operation: "filter",
    params: { field: "status", equals: "ok" },
    bounds: { maxInputItems: 64, maxIterations: 512, maxOutputBytes: 8192, wallClockMs: 5000 },
  });
}

const STEPS: readonly ResultStepFacts[] = [
  { stepId: "curate", stepClass: "transform", computationType: "deterministic", sideEffectClass: "pure" },
  { stepId: "gen", stepClass: "call-model", computationType: "probabilistic", sideEffectClass: "model-inference" },
  { stepId: "fetch", stepClass: "call-tool", computationType: "deterministic", sideEffectClass: "external-effect" },
  { stepId: "check", stepClass: "verify", computationType: "deterministic", sideEffectClass: "verification" },
];

describe("compact structured results (WORK-051)", () => {
  test("builds a typed, digest-addressed result with exact provenance", () => {
    const spec = filterSpec();
    const result = buildCompactResult({
      spec,
      value: [{ status: "ok", n: 1 }],
      sandboxId: "sandbox-1",
      outputDigest: "a".repeat(64),
      surfaceId: "b".repeat(64),
      digest: nodeDigest,
    });
    expect(result.resultSchema).toBe(1);
    expect(result.stepId).toBe("curate");
    expect(result.operation).toBe("filter");
    expect(result.provenance).toEqual({
      specId: "curate-filter",
      sandboxId: "sandbox-1",
      outputDigest: "a".repeat(64),
      surfaceId: "b".repeat(64),
    });
    expect(result.resultDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("untyped values are rejected per operation", () => {
    const spec = filterSpec();
    // filter must produce an array.
    expect(() =>
      buildCompactResult({ spec, value: { count: 1 }, sandboxId: null, outputDigest: null, surfaceId: null, digest: nodeDigest }),
    ).toThrow(ProgrammaticError);
    // aggregate must be a single-metric record.
    const aggregateSpec = validateProgrammaticSpec({
      specId: "agg",
      stepId: "curate",
      operation: "aggregate",
      params: { metric: "count" },
      bounds: { maxInputItems: 64, maxIterations: 512, maxOutputBytes: 8192, wallClockMs: 5000 },
    });
    expect(() =>
      buildCompactResult({ spec: aggregateSpec, value: [1, 2], sandboxId: null, outputDigest: null, surfaceId: null, digest: nodeDigest }),
    ).toThrow(ProgrammaticError);
    expect(() =>
      buildCompactResult({ spec: aggregateSpec, value: { count: 1, extra: 2 }, sandboxId: null, outputDigest: null, surfaceId: null, digest: nodeDigest }),
    ).toThrow(ProgrammaticError);
    // fan-out units carry {index, item}.
    const fanOutSpec = validateProgrammaticSpec({
      specId: "fo",
      stepId: "curate",
      operation: "fan-out",
      params: {},
      bounds: { maxInputItems: 64, maxIterations: 512, maxOutputBytes: 8192, wallClockMs: 5000 },
    });
    expect(() =>
      buildCompactResult({ spec: fanOutSpec, value: [{ index: 0 }], sandboxId: null, outputDigest: null, surfaceId: null, digest: nodeDigest }),
    ).toThrow(ProgrammaticError);
  });

  test("oversized values are rejected against the spec's output bound", () => {
    const spec = validateProgrammaticSpec({
      specId: "curate-filter",
      stepId: "curate",
      operation: "filter",
      params: { field: "status", equals: "ok" },
      bounds: { maxInputItems: 64, maxIterations: 512, maxOutputBytes: 8, wallClockMs: 5000 },
    });
    expect(() =>
      buildCompactResult({
        spec,
        value: [{ status: "ok", n: 1 }, { status: "ok", n: 2 }],
        sandboxId: null,
        outputDigest: null,
        surfaceId: null,
        digest: nodeDigest,
      }),
    ).toThrow(ProgrammaticError);
  });

  test("validateCompactResult verifies identity (tampered digests are typed errors)", () => {
    const spec = filterSpec();
    const result = buildCompactResult({
      spec,
      value: [{ status: "ok" }],
      sandboxId: null,
      outputDigest: null,
      surfaceId: null,
      digest: nodeDigest,
    });
    const roundTripped = validateCompactResult(JSON.parse(JSON.stringify(result)), nodeDigest);
    expect(roundTripped.resultDigest).toBe(result.resultDigest);
    // Content tampering under the claimed digest fails.
    const tampered = JSON.parse(JSON.stringify(result));
    tampered.value = [{ status: "bad" }];
    expect(() => validateCompactResult(tampered, nodeDigest)).toThrow(ProgrammaticError);
    // Digest tampering fails.
    const fake = JSON.parse(JSON.stringify(result));
    fake.resultDigest = "0".repeat(64);
    expect(() => validateCompactResult(fake, nodeDigest)).toThrow(ProgrammaticError);
    // Provenance shape is validated.
    const noProvenance = JSON.parse(JSON.stringify(result));
    delete noProvenance.provenance;
    expect(() => validateCompactResult(noProvenance, nodeDigest)).toThrow(ProgrammaticError);
  });

  test("bindResultToPlan: mechanical-family steps only, existing steps only", () => {
    const spec = filterSpec();
    const result = buildCompactResult({
      spec,
      value: [],
      sandboxId: null,
      outputDigest: null,
      surfaceId: null,
      digest: nodeDigest,
    });
    expect(bindResultToPlan(result, STEPS)).toBe(result);
    // A result for a step that does not exist is rejected.
    const ghost = { ...result, stepId: "ghost" };
    expect(() => bindResultToPlan(ghost, STEPS)).toThrow(ProgrammaticError);
    // A result bound to a generative step is rejected.
    const gen = { ...result, stepId: "gen" };
    expect(() => bindResultToPlan(gen, STEPS)).toThrow(ProgrammaticError);
    // A result bound to a tool step is rejected.
    const tool = { ...result, stepId: "fetch" };
    expect(() => bindResultToPlan(tool, STEPS)).toThrow(ProgrammaticError);
  });

  test("the round-trip proof: serialize → parse → re-validate → identical digest", () => {
    const spec = filterSpec();
    const result = buildCompactResult({
      spec,
      value: [{ status: "ok", n: 1 }, { status: "ok", n: 2 }],
      sandboxId: "sandbox-9",
      outputDigest: "c".repeat(64),
      surfaceId: null,
      digest: nodeDigest,
    });
    const roundTripped = roundTripCompactResult(result, nodeDigest);
    expect(roundTripped.resultDigest).toBe(result.resultDigest);
    expect(roundTripped.provenance.sandboxId).toBe("sandbox-9");
  });
});
