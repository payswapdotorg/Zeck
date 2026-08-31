/**
 * Unit tests — tool-fact origin vocabulary (WORK-018's learning-surface
 * extension of WORK-017's neutral input vocabulary).
 *
 * Proves: the origin field is validated against the frozen vocabulary,
 * absent means platform (the pre-WORK-018 closed shape stays valid),
 * conflicting facts with different origins fail closed (population
 * bases must not silently mix), and synthesized-origin facts parse
 * and project.
 */

import { describe, expect, test } from "vitest";
import { TOOL_FACT_ORIGINS, validateToolFacts } from "../../../src/modules/learning/public";

const BASE_FACT = {
  toolId: "synth-doubler",
  version: "1.0.0",
  capabilityIds: ["arithmetic"],
  inputFields: [{ name: "value", type: "number", required: true }],
  outputFields: [{ name: "doubled", type: "number", required: true }],
};

describe("tool-fact origin vocabulary (WORK-018)", () => {
  test("the frozen vocabulary is exactly platform | synthesized", () => {
    expect([...TOOL_FACT_ORIGINS]).toEqual(["platform", "synthesized"]);
  });

  test("absent origin defaults to platform (backward compatible)", () => {
    const catalog = validateToolFacts([BASE_FACT]);
    expect(catalog.facts[0]?.origin).toBe("platform");
  });

  test("a synthesized-origin fact parses and preserves the origin", () => {
    const catalog = validateToolFacts([{ ...BASE_FACT, origin: "synthesized" }]);
    expect(catalog.facts[0]?.origin).toBe("synthesized");
  });

  test("an unknown origin fails closed", () => {
    expect(() => validateToolFacts([{ ...BASE_FACT, origin: "vendor" }])).toThrowError(
      /origin must be one of the frozen origin vocabulary/,
    );
  });

  test("identical facts with the same origin converge (dedupe)", () => {
    const catalog = validateToolFacts([
      { ...BASE_FACT, origin: "synthesized" },
      { ...BASE_FACT, origin: "synthesized" },
    ]);
    expect(catalog.facts).toHaveLength(1);
  });

  test("the same identity with a DIFFERENT origin fails closed (no silent population mixing)", () => {
    expect(() =>
      validateToolFacts([
        { ...BASE_FACT, origin: "platform" },
        { ...BASE_FACT, origin: "synthesized" },
      ]),
    ).toThrowError(/conflicting tool facts for the same \(toolId, version\)/);
  });
});
