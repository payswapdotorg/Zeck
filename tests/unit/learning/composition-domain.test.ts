/**
 * Tool-composition domain tests (learning module domain; WORK-017).
 *
 * Required-test mapping (the Work Order's structural-safety acceptance
 * criterion 4 and §10/§11/§12):
 *  - tool facts: closed-shape validation, versioned identity,
 *    duplicate convergence/conflict fail-closed;
 *  - composition structural safety: unknown tool references (M8),
 *    unresolved versions (M8/M26), duplicate step ids, unknown edge
 *    endpoints, self-edges, cycles A→A / A→B→A / A→B→C→A and implicit
 *    cycles (M7 — deterministic DFS), input/output edge compatibility
 *    (M9);
 *  - the linear chain builder (the mining output shape).
 */

import { describe, expect, test } from "vitest";
import {
  checkToolComposition,
  edgeCompatible,
  linearCompositionOf,
  type ToolFact,
  validateToolFacts,
} from "../../../src/modules/learning/public";
import { PlatformError } from "../../../src/shared/errors";

function fact(toolId: string, version: string, overrides: Partial<ToolFact> = {}): ToolFact {
  return {
    toolId,
    version,
    capabilityIds: [`cap-${toolId}`],
    inputFields: [{ name: "input", type: "string", required: true }],
    outputFields: [{ name: "output", type: "string", required: true }],
    ...overrides,
  };
}

const CATALOG = validateToolFacts([
  fact("fetch", "1.0.0", {
    capabilityIds: ["web-retrieval"],
    inputFields: [{ name: "url", type: "string", required: true }],
    outputFields: [{ name: "document", type: "string", required: true }],
  }),
  fact("parse", "2.1.0", {
    capabilityIds: ["parsing"],
    inputFields: [
      { name: "document", type: "string", required: true },
      { name: "hint", type: "string", required: false },
    ],
    outputFields: [{ name: "records", type: "array", required: true }],
  }),
  fact("sort", "1.4.0", {
    capabilityIds: ["sorting"],
    inputFields: [{ name: "records", type: "array", required: true }],
    outputFields: [{ name: "sorted", type: "array", required: true }],
  }),
  fact("translate", "3.0.0", {
    capabilityIds: ["translation"],
    inputFields: [{ name: "text", type: "string", required: true }],
    outputFields: [{ name: "translated", type: "string", required: true }],
  }),
]);

describe("learning: tool facts (the neutral structural input)", () => {
  test("empty catalog fails closed", () => {
    expect(() => validateToolFacts([])).toThrow(PlatformError);
  });

  test("malformed facts fail closed (typed)", () => {
    expect(() => validateToolFacts([{ toolId: "UPPER", version: "1.0.0" }])).toThrow(PlatformError);
    expect(() => validateToolFacts([{ toolId: "ok-tool", version: "1.0" }])).toThrow(PlatformError);
    expect(() =>
      validateToolFacts([
        {
          toolId: "ok-tool",
          version: "1.0.0",
          inputFields: [{ name: "x", type: "weird", required: true }],
        },
      ]),
    ).toThrow(PlatformError);
  });

  test("identical duplicates converge; conflicting duplicates fail closed", () => {
    const first = fact("dup", "1.0.0");
    expect(() => validateToolFacts([first, { ...first }])).not.toThrow();
    expect(() =>
      validateToolFacts([first, fact("dup", "1.0.0", { capabilityIds: ["other"] })]),
    ).toThrow(PlatformError);
  });

  test("the catalog canonicalizes order and dedupes", () => {
    const a = fact("b-tool", "1.0.0");
    const b = fact("a-tool", "2.0.0");
    const catalog = validateToolFacts([a, b]);
    expect(catalog.facts.map((f) => f.toolId)).toEqual(["a-tool", "b-tool"]);
  });
});

describe("learning: composition structural safety", () => {
  test("a valid linear chain passes (M-baseline)", () => {
    const composition = linearCompositionOf([
      { toolId: "fetch", version: "1.0.0" },
      { toolId: "parse", version: "2.1.0" },
      { toolId: "sort", version: "1.4.0" },
    ]);
    const check = checkToolComposition(composition, CATALOG);
    expect(check.valid).toBe(true);
  });

  test("empty composition is rejected", () => {
    const check = checkToolComposition({ steps: [], edges: [] }, CATALOG);
    expect(check.valid).toBe(false);
    if (!check.valid) {
      expect(check.reason).toBe("empty-composition");
    }
  });

  test("unknown tool references are rejected (M8)", () => {
    const composition = linearCompositionOf([{ toolId: "ghost", version: "1.0.0" }]);
    const check = checkToolComposition(composition, CATALOG);
    expect(check.valid).toBe(false);
    if (!check.valid) {
      expect(check.reason).toBe("unknown-tool-reference");
    }
  });

  test("unresolved versions are rejected (M8/M26)", () => {
    const composition = linearCompositionOf([{ toolId: "fetch", version: "9.9.9" }]);
    const check = checkToolComposition(composition, CATALOG);
    expect(check.valid).toBe(false);
    if (!check.valid) {
      expect(check.reason).toBe("unresolved-tool-version");
    }
  });

  test("duplicate step ids are rejected (alias shadowing)", () => {
    const check = checkToolComposition(
      {
        steps: [
          { stepId: "s0", tool: { toolId: "fetch", version: "1.0.0" } },
          { stepId: "s0", tool: { toolId: "parse", version: "2.1.0" } },
        ],
        edges: [{ fromStepId: "s0", toStepId: "s0" }],
      },
      CATALOG,
    );
    expect(check.valid).toBe(false);
    if (!check.valid) {
      expect(check.reason).toBe("duplicate-step-id");
    }
  });

  test("self-edges are rejected (A → A, §11)", () => {
    const check = checkToolComposition(
      {
        steps: [{ stepId: "s0", tool: { toolId: "fetch", version: "1.0.0" } }],
        edges: [{ fromStepId: "s0", toStepId: "s0" }],
      },
      CATALOG,
    );
    expect(check.valid).toBe(false);
    if (!check.valid) {
      expect(check.reason).toBe("self-edge");
    }
  });

  test("two-step cycles are rejected (A → B → A, M7)", () => {
    const check = checkToolComposition(
      {
        steps: [
          { stepId: "s0", tool: { toolId: "fetch", version: "1.0.0" } },
          { stepId: "s1", tool: { toolId: "parse", version: "2.1.0" } },
        ],
        edges: [
          { fromStepId: "s0", toStepId: "s1" },
          { fromStepId: "s1", toStepId: "s0" },
        ],
      },
      CATALOG,
    );
    expect(check.valid).toBe(false);
    if (!check.valid) {
      expect(check.reason).toBe("cyclic-composition");
    }
  });

  test("three-step cycles are rejected (A → B → C → A, M7)", () => {
    const check = checkToolComposition(
      {
        steps: [
          { stepId: "s0", tool: { toolId: "fetch", version: "1.0.0" } },
          { stepId: "s1", tool: { toolId: "parse", version: "2.1.0" } },
          { stepId: "s2", tool: { toolId: "sort", version: "1.4.0" } },
        ],
        edges: [
          { fromStepId: "s0", toStepId: "s1" },
          { fromStepId: "s1", toStepId: "s2" },
          { fromStepId: "s2", toStepId: "s0" },
        ],
      },
      CATALOG,
    );
    expect(check.valid).toBe(false);
    if (!check.valid) {
      expect(check.reason).toBe("cyclic-composition");
    }
  });

  test("implicit cycles through repeated edges are rejected (determinism)", () => {
    // s0 → s1 → s2 plus a back edge from s2 to s1 (the implicit cycle).
    const check = checkToolComposition(
      {
        steps: [
          { stepId: "s0", tool: { toolId: "fetch", version: "1.0.0" } },
          { stepId: "s1", tool: { toolId: "parse", version: "2.1.0" } },
          { stepId: "s2", tool: { toolId: "sort", version: "1.4.0" } },
        ],
        edges: [
          { fromStepId: "s0", toStepId: "s1" },
          { fromStepId: "s1", toStepId: "s2" },
          { fromStepId: "s2", toStepId: "s1" },
        ],
      },
      CATALOG,
    );
    expect(check.valid).toBe(false);
    if (!check.valid) {
      expect(check.reason).toBe("cyclic-composition");
    }
  });

  test("edge endpoints must exist", () => {
    const check = checkToolComposition(
      {
        steps: [{ stepId: "s0", tool: { toolId: "fetch", version: "1.0.0" } }],
        edges: [{ fromStepId: "s0", toStepId: "ghost-step" }],
      },
      CATALOG,
    );
    expect(check.valid).toBe(false);
    if (!check.valid) {
      expect(check.reason).toBe("unknown-edge-endpoint");
    }
  });

  test("incompatible input/output edges are rejected (M9)", () => {
    // fetch outputs {document}; translate requires {text} — incompatible.
    const check = checkToolComposition(
      {
        steps: [
          { stepId: "s0", tool: { toolId: "fetch", version: "1.0.0" } },
          { stepId: "s1", tool: { toolId: "translate", version: "3.0.0" } },
        ],
        edges: [{ fromStepId: "s0", toStepId: "s1" }],
      },
      CATALOG,
    );
    expect(check.valid).toBe(false);
    if (!check.valid) {
      expect(check.reason).toBe("incompatible-input-output");
    }
  });

  test("type mismatches on matching names are incompatible (M9)", () => {
    const incompatible = edgeCompatible(
      fact("up", "1.0.0", { outputFields: [{ name: "value", type: "string", required: true }] }),
      fact("down", "1.0.0", { inputFields: [{ name: "value", type: "number", required: true }] }),
    );
    expect(incompatible.ok).toBe(false);
    const compatible = edgeCompatible(
      fact("up", "1.0.0", { outputFields: [{ name: "value", type: "string", required: true }] }),
      fact("down", "1.0.0", { inputFields: [{ name: "value", type: "string", required: true }] }),
    );
    expect(compatible.ok).toBe(true);
  });

  test("optional downstream inputs do not block compatibility", () => {
    const compatible = edgeCompatible(
      fact("up", "1.0.0", { outputFields: [] }),
      fact("down", "1.0.0", {
        inputFields: [{ name: "anything", type: "string", required: false }],
      }),
    );
    expect(compatible.ok).toBe(true);
  });
});
