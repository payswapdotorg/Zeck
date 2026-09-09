/**
 * Programmatic-execution unit tests (WORK-051): the closed mechanical
 * operation vocabulary, total spec validation (bounds explicit and
 * fail-closed), the bounded evaluator kernel's semantics for all four
 * operations, and the typed bound violations.
 */

import { describe, expect, test } from "vitest";
import {
  PROGRAMMATIC_BOUND_CAPS,
  PROGRAMMATIC_OPERATIONS,
  ProgrammaticError,
  chunkPayload,
  evaluateProgrammaticSpec,
  validateProgrammaticInput,
  validateProgrammaticSpec,
  type ProgrammaticSpec,
} from "../../../../src/platform/tool-surface/programmatic";
import { validateToolSurfaceConfig, ToolSurfaceError, TOOL_REPRESENTATIONS, SELECTION_ORDER } from "../../../../src/platform/tool-surface/catalog";
import { capabilityFactsFromConstraints, policyToolFactsFromConstraints, toolAllowedByPolicyFacts } from "../../../../src/platform/tool-surface/catalog";

const BOUNDS = {
  maxInputItems: 64,
  maxIterations: 512,
  maxOutputBytes: 8192,
  wallClockMs: 5000,
};

function specOf(operation: string, params: Record<string, unknown>): ProgrammaticSpec {
  return validateProgrammaticSpec({
    specId: "spec-1",
    stepId: "curate",
    operation,
    params,
    bounds: BOUNDS,
  });
}

describe("programmatic execution (WORK-051)", () => {
  test("the operation vocabulary is closed and typed", () => {
    expect([...PROGRAMMATIC_OPERATIONS]).toEqual(["fan-out", "filter", "aggregate", "projection"]);
    expect(() => specOf("explode", {})).toThrow(ProgrammaticError);
    try {
      specOf("explode", {});
      expect.unreachable();
    } catch (error) {
      expect((error as ProgrammaticError).code).toBe("operation-vocabulary");
    }
  });

  test("bounds are explicit and fail closed (missing, non-positive, over-cap)", () => {
    for (const bad of [undefined, 0, -1, 1.5]) {
      let caught: unknown;
      try {
        validateProgrammaticSpec({
          specId: "spec-1",
          stepId: "curate",
          operation: "filter",
          params: { field: "status", equals: "ok" },
          bounds: { ...BOUNDS, maxIterations: bad },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ProgrammaticError);
      expect((caught as ProgrammaticError).code).toBe("bound-violation");
    }
    let caughtMissing: unknown;
    try {
      validateProgrammaticSpec({
        specId: "spec-1",
        stepId: "curate",
        operation: "filter",
        params: { field: "status", equals: "ok" },
        bounds: { maxInputItems: 2, maxIterations: 2, maxOutputBytes: 2 },
      });
    } catch (error) {
      caughtMissing = error;
    }
    expect((caughtMissing as ProgrammaticError).code).toBe("bound-violation");
    let caughtCap: unknown;
    try {
      validateProgrammaticSpec({
        specId: "spec-1",
        stepId: "curate",
        operation: "filter",
        params: { field: "status", equals: "ok" },
        bounds: { ...BOUNDS, maxInputItems: PROGRAMMATIC_BOUND_CAPS.maxInputItems + 1 },
      });
    } catch (error) {
      caughtCap = error;
    }
    expect(caughtCap).toBeInstanceOf(ProgrammaticError);
    expect((caughtCap as ProgrammaticError).code).toBe("bound-violation");
    expect((caughtCap as ProgrammaticError).details.cap).toBe(
      PROGRAMMATIC_BOUND_CAPS.maxInputItems,
    );
  });

  test("per-operation parameter shapes are validated", () => {
    expect(() => specOf("filter", { field: "status" })).toThrow(ProgrammaticError);
    expect(() => specOf("filter", { field: "UPPER", equals: "ok" })).toThrow(ProgrammaticError);
    expect(() => specOf("aggregate", { metric: "median" })).toThrow(ProgrammaticError);
    expect(() => specOf("aggregate", { metric: "sum" })).toThrow(ProgrammaticError); // sum needs field
    expect(() => specOf("projection", { fields: [] })).toThrow(ProgrammaticError);
    expect(() => specOf("projection", { fields: ["a", "b", "UPPER"] })).toThrow(ProgrammaticError);
    expect(() =>
      validateProgrammaticSpec({ specId: "Spec 1", stepId: "curate", operation: "filter", params: { field: "a", equals: 1 }, bounds: BOUNDS }),
    ).toThrow(ProgrammaticError);
  });

  test("the evaluator kernel: fan-out semantics with iteration evidence", () => {
    const spec = specOf("fan-out", {});
    const outcome = evaluateProgrammaticSpec(spec, {
      items: ["a", { b: 1 }, null],
    });
    expect(outcome.iterations).toBe(3);
    expect(outcome.value).toEqual([
      { index: 0, item: "a" },
      { index: 1, item: { b: 1 } },
      { index: 2, item: null },
    ]);
  });

  test("the evaluator kernel: filter semantics (records only, closed predicate)", () => {
    const spec = specOf("filter", { field: "status", equals: "ok" });
    const outcome = evaluateProgrammaticSpec(spec, {
      items: [
        { status: "ok", n: 1 },
        { status: "bad", n: 2 },
        "not-a-record",
        { status: "ok", n: 3 },
        null,
      ],
    });
    expect(outcome.value).toEqual([
      { status: "ok", n: 1 },
      { status: "ok", n: 3 },
    ]);
    expect(outcome.iterations).toBe(5);
    // Filter over missing field: no matches, still bounded.
    const empty = evaluateProgrammaticSpec(spec, { items: [{ other: 1 }] });
    expect(empty.value).toEqual([]);
  });

  test("the evaluator kernel: aggregate count and sum", () => {
    const count = evaluateProgrammaticSpec(specOf("aggregate", { metric: "count" }), {
      items: [1, 2, 3],
    });
    expect(count.value).toEqual({ count: 3 });
    const sum = evaluateProgrammaticSpec(
      specOf("aggregate", { metric: "sum", field: "n" }),
      { items: [{ n: 1.5 }, { n: 2 }, { n: 0.5 }] },
    );
    expect(sum.value).toEqual({ sum: 4 });
    // Non-numeric fields fail closed typed.
    try {
      evaluateProgrammaticSpec(specOf("aggregate", { metric: "sum", field: "n" }), {
        items: [{ n: "one" }],
      });
      expect.unreachable();
    } catch (error) {
      expect((error as ProgrammaticError).code).toBe("output-untyped");
    }
  });

  test("the evaluator kernel: projection semantics", () => {
    const outcome = evaluateProgrammaticSpec(specOf("projection", { fields: ["a", "c"] }), {
      items: [{ a: 1, b: 2, c: 3 }, { a: 4, c: 5 }],
    });
    expect(outcome.value).toEqual([{ a: 1, c: 3 }, { a: 4, c: 5 }]);
    try {
      evaluateProgrammaticSpec(specOf("projection", { fields: ["a"] }), { items: ["nope"] });
      expect.unreachable();
    } catch (error) {
      expect((error as ProgrammaticError).code).toBe("output-untyped");
    }
  });

  test("the evaluator kernel enforces the iteration bound fail-closed", () => {
    const tight = validateProgrammaticSpec({
      specId: "spec-1",
      stepId: "curate",
      operation: "fan-out",
      params: {},
      bounds: { ...BOUNDS, maxIterations: 2 },
    });
    try {
      evaluateProgrammaticSpec(tight, { items: [1, 2, 3] });
      expect.unreachable("must fail closed");
    } catch (error) {
      expect((error as ProgrammaticError).code).toBe("iteration-exceeded");
    }
  });

  test("the evaluator kernel enforces the output bound fail-closed", () => {
    const tight = validateProgrammaticSpec({
      specId: "spec-1",
      stepId: "curate",
      operation: "projection",
      params: { fields: ["a"] },
      bounds: { ...BOUNDS, maxOutputBytes: 4 },
    });
    try {
      evaluateProgrammaticSpec(tight, { items: [{ a: 123456 }] });
      expect.unreachable("must fail closed");
    } catch (error) {
      expect((error as ProgrammaticError).code).toBe("output-unbounded");
    }
  });

  test("input validation: shape, item bound, serialized crossing bound", () => {
    expect(() => validateProgrammaticInput({ notItems: [] }, BOUNDS)).toThrow(ProgrammaticError);
    try {
      validateProgrammaticInput({ items: new Array(65).fill(0) }, BOUNDS);
      expect.unreachable();
    } catch (error) {
      expect((error as ProgrammaticError).code).toBe("input-unbounded");
    }
    // Deterministic chunking of the serialized payload.
    expect(chunkPayload("abcdefghij")).toEqual(["abcdefghij"]);
    expect(chunkPayload("x".repeat(8192))).toEqual([
      "x".repeat(4096),
      "x".repeat(4096),
    ]);
    expect(chunkPayload("")).toEqual([""]);
  });
});

describe("tool-surface catalog (WORK-051)", () => {
  test("the representation catalog config validation is total", () => {
    expect(() => validateToolSurfaceConfig({ configSchema: 2 } as never)).toThrow(ToolSurfaceError);
    expect(() =>
      validateToolSurfaceConfig({
        configSchema: 1,
        mcpEnabled: "yes",
        programmaticEnabled: true,
        bindings: [],
      }),
    ).toThrow(ToolSurfaceError);
    expect(() =>
      validateToolSurfaceConfig({
        configSchema: 1,
        mcpEnabled: true,
        programmaticEnabled: true,
        bindings: [{ toolId: "t", representations: {} }],
      }),
    ).toThrow(ToolSurfaceError);
    expect(() =>
      validateToolSurfaceConfig({
        configSchema: 1,
        mcpEnabled: true,
        programmaticEnabled: true,
        bindings: [
          { toolId: "t", representations: { direct: { typed: true } } },
          { toolId: "t", representations: { direct: { typed: true } } },
        ],
      }),
    ).toThrow(ToolSurfaceError);
    expect(() =>
      validateToolSurfaceConfig({
        configSchema: 1,
        mcpEnabled: true,
        programmaticEnabled: true,
        bindings: [
          { toolId: "t", representations: { invented: { x: 1 } } },
        ],
      }),
    ).toThrow(ToolSurfaceError);
    expect(() =>
      validateToolSurfaceConfig({
        configSchema: 1,
        mcpEnabled: true,
        programmaticEnabled: true,
        bindings: [
          { toolId: "t", representations: { cli: { command: "x".repeat(300) } } },
        ],
      }),
    ).toThrow(ToolSurfaceError);
    // The canonical order is a permutation of the closed set and starts
    // with the lowest-rank representation.
    expect(new Set(SELECTION_ORDER)).toEqual(new Set(TOOL_REPRESENTATIONS));
    expect(SELECTION_ORDER[0]).toBe("direct");
  });

  test("read-only conditioning helpers mirror the constraint facts", () => {
    const capability = capabilityFactsFromConstraints([
      {
        constraintId: "c",
        kind: "capability",
        enforcement: "hard",
        source: { authority: "capability", catalogRevision: "r" },
        payload: { satisfiedIds: ["a", "b"], unmetIds: ["c"] },
      },
    ]);
    expect(capability.present).toBe(true);
    expect(capability.satisfiedIds.has("a")).toBe(true);
    expect(capability.unmetIds.has("c")).toBe(true);
    const policy = policyToolFactsFromConstraints([
      {
        constraintId: "p",
        kind: "policy",
        enforcement: "hard",
        source: { authority: "policy" },
        payload: { tool: { allowedTools: ["a"], deniedTools: ["d"] } },
      },
    ]);
    expect(toolAllowedByPolicyFacts("a", policy)).toEqual({ allowed: true });
    expect(toolAllowedByPolicyFacts("d", policy).allowed).toBe(false);
    expect(toolAllowedByPolicyFacts("x", policy).allowed).toBe(false); // allowlist excludes
    const empty = policyToolFactsFromConstraints([]);
    expect(toolAllowedByPolicyFacts("anything", empty)).toEqual({ allowed: true });
  });
});
