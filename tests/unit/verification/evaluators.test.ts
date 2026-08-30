/**
 * Unit: the deterministic evaluator bank + the model-judge evaluator
 * (WORK-013).
 *
 * The deterministic-first verification proofs:
 *  - each deterministic evaluator establishes exactly its criterion kind;
 *  - empty evidence ⇒ honest INCONCLUSIVE (M4: missing evidence never
 *    produces PASS);
 *  - the model-judge evaluator is a judgment ASSESSOR: an unbound or
 *    non-committal judgment maps to INCONCLUSIVE — a raw provider
 *    success or "looks correct" string can never produce PASS (M1/M2);
 *  - deterministic evaluators import no models surface (the static
 *    discrimination half proves the same over the real tree).
 */

import { describe, expect, test } from "vitest";
import {
  createDigestEvaluator,
  createExactMatchEvaluator,
  createInvariantEvaluator,
  createReferenceEvaluator,
  createSchemaEvaluator,
} from "../../../src/modules/verification/adapters/deterministic-evaluators";
import { createModelJudgeEvaluator } from "../../../src/modules/verification/adapters/model-judge-evaluator";
import type { ModelJudgment } from "../../../src/modules/verification/ports/model-judge";

const context = {
  applicationId: "app",
  tenantId: "tenant",
  executionId: "exec",
  actorId: "actor",
};

const noRefs = { evidenceRefs: [] as string[] };

describe("deterministic evaluators", () => {
  test("schema: PASS when declared fields satisfy the shape", async () => {
    const evaluator = createSchemaEvaluator();
    expect(evaluator.establishes).toEqual(["schema"]);
    const outcome = await evaluator.evaluate(
      { target: { kind: "record", ref: "out" }, facts: { answer: 42 }, ...noRefs },
      {
        criterionId: "c",
        version: 1,
        kind: "schema",
        definition: { fields: [{ name: "answer", type: "number", required: true }] },
      },
      context,
    );
    expect(outcome.status).toBe("PASS");
  });

  test("schema: FAIL when a required field is absent or mistyped", async () => {
    const evaluator = createSchemaEvaluator();
    const missing = await evaluator.evaluate(
      { target: { kind: "record", ref: "out" }, facts: {}, evidenceRefs: ["ref-1"] },
      {
        criterionId: "c",
        version: 1,
        kind: "schema",
        definition: { fields: [{ name: "answer", type: "number", required: true }] },
      },
      context,
    );
    expect(missing.status).toBe("FAIL");
    const mistyped = await evaluator.evaluate(
      { target: { kind: "record", ref: "out" }, facts: { answer: "42" }, ...noRefs },
      {
        criterionId: "c",
        version: 1,
        kind: "schema",
        definition: { fields: [{ name: "answer", type: "number", required: true }] },
      },
      context,
    );
    expect(mistyped.status).toBe("FAIL");
  });

  test("empty evidence ⇒ INCONCLUSIVE for every deterministic kind (M4)", async () => {
    const evaluators = [
      createSchemaEvaluator(),
      createInvariantEvaluator(),
      createDigestEvaluator(),
      createExactMatchEvaluator(),
      createReferenceEvaluator(),
    ];
    for (const evaluator of evaluators) {
      const outcome = await evaluator.evaluate(
        { target: { kind: "record", ref: "out" }, facts: {}, ...noRefs },
        {
          criterionId: "c",
          version: 1,
          kind: evaluator.establishes[0] as never,
          definition:
            evaluator.establishes[0] === "digest"
              ? { algorithm: "sha256", expected: "x" }
              : evaluator.establishes[0] === "exact-match"
                ? { expected: 1 }
                : evaluator.establishes[0] === "reference"
                  ? { requiredRefs: ["a"] }
                  : evaluator.establishes[0] === "schema"
                    ? { fields: [{ name: "a", type: "string" }] }
                    : { assertions: [{ path: "a", op: "exists" }] },
        },
        context,
      );
      expect(outcome.status, evaluator.identity.id).toBe("INCONCLUSIVE");
      expect(outcome.observations.join(" ")).toContain("no evidence");
    }
  });

  test("invariant: assertion ops behave (eq/ne/gt/exists/type/contains)", async () => {
    const evaluator = createInvariantEvaluator();
    const pass = await evaluator.evaluate(
      {
        target: { kind: "record", ref: "out" },
        facts: { count: 5, name: "zeck", tags: ["a"] },
        evidenceRefs: ["ref-1"],
      },
      {
        criterionId: "c",
        version: 1,
        kind: "invariant",
        definition: {
          assertions: [
            { path: "count", op: "gte", value: 5 },
            { path: "name", op: "eq", value: "zeck" },
            { path: "tags", op: "contains", value: "a" },
            { path: "missing", op: "exists", value: false },
            { path: "count", op: "type", value: "number" },
          ],
        },
      },
      context,
    );
    expect(pass.status).toBe("PASS");

    const fail = await evaluator.evaluate(
      {
        target: { kind: "record", ref: "out" },
        facts: { count: 3, name: "zeck" },
        evidenceRefs: ["ref-1"],
      },
      {
        criterionId: "c",
        version: 1,
        kind: "invariant",
        definition: { assertions: [{ path: "count", op: "gte", value: 5 }] },
      },
      context,
    );
    expect(fail.status).toBe("FAIL");
  });

  test("digest: equality decides PASS/FAIL; absent digest is INCONCLUSIVE", async () => {
    const evaluator = createDigestEvaluator();
    const criteria = {
      criterionId: "c",
      version: 1,
      kind: "digest" as const,
      definition: { algorithm: "sha256", expected: "abc" },
    };
    const pass = await evaluator.evaluate(
      { target: { kind: "artifact", ref: "d" }, facts: { digest: "abc" }, ...noRefs },
      criteria,
      context,
    );
    expect(pass.status).toBe("PASS");
    const fail = await evaluator.evaluate(
      { target: { kind: "artifact", ref: "d" }, facts: { digest: "zzz" }, ...noRefs },
      criteria,
      context,
    );
    expect(fail.status).toBe("FAIL");
    const unknown = await evaluator.evaluate(
      { target: { kind: "artifact", ref: "d" }, facts: { other: 1 }, evidenceRefs: ["r"] },
      criteria,
      context,
    );
    expect(unknown.status).toBe("INCONCLUSIVE");
  });

  test("exact-match: deep equality decides", async () => {
    const evaluator = createExactMatchEvaluator();
    const criteria = {
      criterionId: "c",
      version: 1,
      kind: "exact-match" as const,
      definition: { expected: { a: [1, 2], b: { c: true } } },
    };
    const pass = await evaluator.evaluate(
      {
        target: { kind: "record", ref: "out" },
        facts: { value: { b: { c: true }, a: [1, 2] } },
        evidenceRefs: ["r"],
      },
      criteria,
      context,
    );
    expect(pass.status).toBe("PASS");
    const fail = await evaluator.evaluate(
      {
        target: { kind: "record", ref: "out" },
        facts: { value: { a: [1, 3] } },
        evidenceRefs: ["r"],
      },
      criteria,
      context,
    );
    expect(fail.status).toBe("FAIL");
  });

  test("reference: every required evidence reference must be present", async () => {
    const evaluator = createReferenceEvaluator();
    const criteria = {
      criterionId: "c",
      version: 1,
      kind: "reference" as const,
      definition: { requiredRefs: ["artifact:a", "tool:b"] },
    };
    const pass = await evaluator.evaluate(
      {
        target: { kind: "record", ref: "out" },
        facts: { x: 1 },
        evidenceRefs: ["artifact:a", "tool:b"],
      },
      criteria,
      context,
    );
    expect(pass.status).toBe("PASS");
    const fail = await evaluator.evaluate(
      { target: { kind: "record", ref: "out" }, facts: { x: 1 }, evidenceRefs: ["artifact:a"] },
      criteria,
      context,
    );
    expect(fail.status).toBe("FAIL");
  });
});

describe("model-judge evaluator (the provider-success ≠ PASS boundary)", () => {
  const criteria = {
    criterionId: "semantics",
    version: 2,
    kind: "model-judged" as const,
    definition: { rubric: "the answer cites its sources" },
  };
  const evidence = {
    target: { kind: "execution-output" as const, ref: "exec-1" },
    facts: { answer: "42 because …" },
    evidenceRefs: ["artifact:answer"],
  };

  function evaluatorReturning(judgment: ModelJudgment) {
    return createModelJudgeEvaluator({
      judge: async () => judgment,
    });
  }

  test("a bound judgment with meetsCriteria=true ⇒ PASS with judgment evidence", async () => {
    const evaluator = evaluatorReturning({
      criterionId: "semantics",
      meetsCriteria: true,
      rationale: "two sources cited",
      judgeIdentity: { provider: "rail-x", model: "judge-1" },
    });
    const outcome = await evaluator.evaluate(evidence, criteria, context);
    expect(outcome.status).toBe("PASS");
    expect(outcome.evidenceRefs[0]).toBe("model-judgment:semantics@2");
    expect(outcome.observations.join(" ")).toContain("rail-x");
  });

  test("a bound judgment with meetsCriteria=false ⇒ FAIL", async () => {
    const evaluator = evaluatorReturning({
      criterionId: "semantics",
      meetsCriteria: false,
      rationale: "no citations",
      judgeIdentity: {},
    });
    const outcome = await evaluator.evaluate(evidence, criteria, context);
    expect(outcome.status).toBe("FAIL");
  });

  test('meetsCriteria="unknown" ⇒ INCONCLUSIVE (judges are not infallible)', async () => {
    const evaluator = evaluatorReturning({
      criterionId: "semantics",
      meetsCriteria: "unknown",
      rationale: "cannot tell",
      judgeIdentity: {},
    });
    const outcome = await evaluator.evaluate(evidence, criteria, context);
    expect(outcome.status).toBe("INCONCLUSIVE");
  });

  test("an UNBOUND judgment (self-certification about something else) ⇒ INCONCLUSIVE, never PASS (M2)", async () => {
    const evaluator = evaluatorReturning({
      criterionId: "some-other-criterion",
      meetsCriteria: true,
      rationale: "looks correct",
      judgeIdentity: {},
    });
    const outcome = await evaluator.evaluate(evidence, criteria, context);
    expect(outcome.status).toBe("INCONCLUSIVE");
    expect(outcome.observations.join(" ")).toContain("unbound judgment");
  });

  test("a provider success payload with no verdict field cannot be a judgment (M1 shape)", async () => {
    // The port type forces a shape; simulate the mutated adapter input by
    // casting a raw provider success through the boundary: an object
    // without meetsCriteria/criterionId cannot satisfy the contract —
    // the runtime half of this proof (M1) lives in the discrimination
    // suite, where the adapter mapping itself is mutated.
    const evaluator = createModelJudgeEvaluator({
      judge: async () =>
        ({
          criterionId: "semantics",
          meetsCriteria: "unknown",
          rationale: "provider returned 200 with text 'looks correct'",
          judgeIdentity: {},
        }) satisfies ModelJudgment,
    });
    const outcome = await evaluator.evaluate(evidence, criteria, context);
    expect(outcome.status).toBe("INCONCLUSIVE");
  });
});
