/**
 * Memoization-hook consumer tests (WORK-052 AC 3): the compiler's
 * FIXED memoization-hook annotation contract round-trips —
 * annotation → consumer read → cache-planning input; the read is
 * read-only (the variant is never mutated) and fail-closed (a
 * mutated/foreign annotation is a typed rejection, never consumed).
 */

import { describe, expect, test } from "vitest";
import {
  readMemoizationHooks,
  validateCachePolicyFacts,
} from "../../../../src/platform/context-economics/memo";
import {
  buildVariant,
  validateExecutionIrVariant,
  variantFromIr,
} from "../../../../src/platform/execution-compiler/variant";
import { canonicalJson } from "../../../../src/platform/execution-ir/canonical";
import { compiledVariant, governedIr, nodeDigest } from "./helpers";

describe("memoization-hook consumer (the fixed annotation contract)", () => {
  test("HOOK ROUND-TRIP: the compiler's annotations are read verbatim", () => {
    const variant = compiledVariant();
    const read = readMemoizationHooks(variant);
    // The deterministic, non-verification steps carry hooks.
    expect(read.hooks.length).toBeGreaterThanOrEqual(1);
    for (const hook of read.hooks) {
      expect(hook.memoKey).toMatch(/^[0-9a-f]{64}$/);
      const step = variant.steps.find((candidate) => candidate.id === hook.stepId);
      expect(step).toBeDefined();
      expect(step?.computationType).toBe("deterministic");
      expect(step?.stepClass).not.toBe("verify");
      // The annotation value rides under the reserved key, verbatim.
      const annotation = (step?.config as Record<string, unknown>)?.[
        "execution-compiler"
      ] as Record<string, unknown>;
      expect((annotation["memoization-hooks"] as Record<string, unknown>)?.memoKey).toBe(
        hook.memoKey,
      );
    }
    // No rejections over the compiler-produced variant.
    expect(read.rejections).toEqual([]);
  });

  test("probabilistic, human and verification steps carry NO hooks", () => {
    const variant = compiledVariant();
    const read = readMemoizationHooks(variant);
    for (const hook of read.hooks) {
      const step = variant.steps.find((candidate) => candidate.id === hook.stepId);
      expect(step?.stepClass).not.toBe("verify");
      expect(step?.computationType).toBe("deterministic");
    }
    // The generative step and the verify step are absent from hooks.
    expect(read.hooks.find((hook) => hook.stepId === "gen")).toBeUndefined();
    expect(read.hooks.find((hook) => hook.stepId === "check")).toBeUndefined();
  });

  test("READ-ONLY: reading never mutates the variant", () => {
    const variant = compiledVariant();
    const before = canonicalJson(validateExecutionIrVariant(variant, nodeDigest));
    readMemoizationHooks(variant);
    const after = canonicalJson(validateExecutionIrVariant(variant, nodeDigest));
    expect(after).toBe(before);
  });

  test("IDEMPOTENT re-read: the identical hooks in the identical order", () => {
    const variant = compiledVariant();
    const first = readMemoizationHooks(variant);
    const second = readMemoizationHooks(variant);
    expect(first).toEqual(second);
  });

  test("FAIL-CLOSED: a mutated annotation on a non-deterministic step is rejected, never consumed", () => {
    const ir = governedIr();
    const variant = variantFromIr(ir, nodeDigest);
    // A mutation: forge the compiler annotation onto the GENERATIVE
    // (probabilistic) step. The consumer re-proves the contract.
    const gen = variant.steps.find((step) => step.id === "gen");
    expect(gen).toBeDefined();
    const mutated = buildVariant(
      {
        source: variant,
        steps: variant.steps.map((step) =>
          step.id === "gen"
            ? {
                ...step,
                config: {
                  ...step.config,
                  "execution-compiler": {
                    "memoization-hooks": { memoKey: "0".repeat(64) },
                  },
                },
              }
            : step,
        ),
        edges: variant.edges,
        provenance: variant.provenance,
      },
      nodeDigest,
    );
    const read = readMemoizationHooks(mutated);
    expect(read.hooks.find((hook) => hook.stepId === "gen")).toBeUndefined();
    expect(read.rejections.find((rejection) => rejection.stepId === "gen")).toBeDefined();
    expect(read.rejections.find((rejection) => rejection.stepId === "gen")?.code).toBe(
      "memo-step-not-deterministic",
    );
  });

  test("FAIL-CLOSED: a non-digest memoKey is rejected, never consumed", () => {
    const ir = governedIr();
    const variant = variantFromIr(ir, nodeDigest);
    const mutated = buildVariant(
      {
        source: variant,
        steps: variant.steps.map((step) =>
          step.id === "fetch"
            ? {
                ...step,
                config: {
                  ...step.config,
                  "execution-compiler": {
                    "memoization-hooks": { memoKey: "not-a-digest" },
                  },
                },
              }
            : step,
        ),
        edges: variant.edges,
        provenance: variant.provenance,
      },
      nodeDigest,
    );
    const read = readMemoizationHooks(mutated);
    expect(read.hooks.find((hook) => hook.stepId === "fetch")).toBeUndefined();
    expect(read.rejections.find((rejection) => rejection.stepId === "fetch")?.code).toBe(
      "memo-key-not-digest",
    );
  });

  test("FAIL-CLOSED: a memo hook forged onto a verification step is rejected", () => {
    const ir = governedIr();
    const variant = variantFromIr(ir, nodeDigest);
    const mutated = buildVariant(
      {
        source: variant,
        steps: variant.steps.map((step) =>
          step.id === "check"
            ? {
                ...step,
                config: {
                  ...step.config,
                  "execution-compiler": {
                    "memoization-hooks": { memoKey: "1".repeat(64) },
                  },
                },
              }
            : step,
        ),
        edges: variant.edges,
        provenance: variant.provenance,
      },
      nodeDigest,
    );
    const read = readMemoizationHooks(mutated);
    expect(read.hooks.find((hook) => hook.stepId === "check")).toBeUndefined();
    expect(read.rejections.find((rejection) => rejection.stepId === "check")?.code).toBe(
      "memo-verification-step",
    );
  });

  test("the policy facts validate fail-closed", () => {
    expect(() => validateCachePolicyFacts({ reuseAllowed: "yes" })).toThrow();
    expect(() => validateCachePolicyFacts({ ...permissivePolicyRaw, maxEntryAgeMs: -1 })).toThrow();
    expect(validateCachePolicyFacts(permissivePolicyRaw)).toEqual(permissivePolicyRaw);
  });
});

const permissivePolicyRaw = {
  reuseAllowed: true,
  prefixCacheAllowed: true,
  coalescingAllowed: true,
  maxEntryAgeMs: 60_000,
  maxPrefixAgeMs: 60_000,
  maxJoinAgeMs: 60_000,
};
