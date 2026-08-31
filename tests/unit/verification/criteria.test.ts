/**
 * Unit: verification criteria declaration (WORK-013).
 *
 * Criteria are the load-bearing identity of every verification
 * statement (M21: criteria omitted / undeclared can never gate
 * anything). These tests pin the declaration contract: kind vocabulary,
 * kind-specific definition validation, and redeclare convergence.
 */

import { describe, expect, test } from "vitest";
import {
  CRITERION_KINDS,
  DETERMINISTIC_CRITERION_KINDS,
  isCriterionKind,
  isDeterministicCriterionKind,
  validateCriteriaDeclaration,
} from "../../../src/modules/verification/domain/criteria";

const base = {
  criterionId: "output-schema",
  version: 1,
  kind: "schema",
  required: true,
  description: "the output satisfies the declared schema",
  definition: { fields: [{ name: "answer", type: "number", required: true }] },
};

describe("criteria declaration validation", () => {
  test("accepts a well-formed schema criterion", () => {
    expect(validateCriteriaDeclaration(base).ok).toBe(true);
  });

  test("rejects unknown kinds (the kind vocabulary is closed)", () => {
    const issues = validateCriteriaDeclaration({ ...base, kind: "vibe" });
    expect(issues.ok).toBe(false);
    expect(issues.issues.join(" ")).toContain("kind must be one of");
  });

  test("rejects a non-positive/non-integer version", () => {
    expect(validateCriteriaDeclaration({ ...base, version: 0 }).ok).toBe(false);
    expect(validateCriteriaDeclaration({ ...base, version: 1.5 }).ok).toBe(false);
  });

  test("rejects an empty criterionId or description", () => {
    expect(validateCriteriaDeclaration({ ...base, criterionId: "" }).ok).toBe(false);
    expect(validateCriteriaDeclaration({ ...base, description: "" }).ok).toBe(false);
  });

  test.each([
    ["schema", { fields: [] }],
    ["schema", {}],
    ["invariant", { assertions: [] }],
    [
      "invariant",
      {
        assertions: [
          { path: "a", op: "eq", value: 1 },
          { path: "", op: "eq", value: 1 },
        ],
      },
    ],
    ["invariant", { assertions: [{ path: "a", op: "bogus" }] }],
    ["digest", { algorithm: "md5", expected: "abc" }],
    ["digest", {}],
    ["exact-match", {}],
    ["reference", { requiredRefs: [] }],
    ["reference", { requiredRefs: [1, 2] }],
    ["model-judged", {}],
    ["human-judged", {}],
  ] as const)("rejects malformed %s definition %j", (kind, definition) => {
    const issues = validateCriteriaDeclaration({ ...base, kind, definition });
    expect(issues.ok).toBe(false);
  });

  test.each([
    ["digest", { algorithm: "sha256", expected: "abc123" }],
    ["exact-match", { expected: { a: 1 } }],
    ["reference", { requiredRefs: ["artifact:1"] }],
    ["model-judged", { rubric: "the answer cites its sources" }],
    ["human-judged", { question: "Is the translation acceptable?" }],
  ] as const)("accepts well-formed %s definition %j", (kind, definition) => {
    expect(validateCriteriaDeclaration({ ...base, kind, definition }).ok).toBe(true);
  });

  test("the kind vocabulary splits deterministic from judged", () => {
    expect(DETERMINISTIC_CRITERION_KINDS).toEqual([
      "schema",
      "invariant",
      "digest",
      "exact-match",
      "reference",
    ]);
    expect(isDeterministicCriterionKind("model-judged")).toBe(false);
    expect(isDeterministicCriterionKind("human-judged")).toBe(false);
    expect(isDeterministicCriterionKind("schema")).toBe(true);
    expect(CRITERION_KINDS).toHaveLength(7);
    expect(isCriterionKind("schema")).toBe(true);
    expect(isCriterionKind("nope")).toBe(false);
  });
});
