/**
 * Task profile derivation tests (planning module; WORK-009 / INT-001).
 *
 * The profile is the planner's first artifact: structured, deterministic,
 * fail-closed. These tests prove AC-1 (structured TaskProfile from task
 * input, constraints, output characteristics, risk and quality targets)
 * and the derivation's determinism discipline.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { deriveTaskProfile, TASK_KINDS } from "../../../src/modules/planning/public";
import { PlatformError } from "../../../src/shared/errors";

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

const ARITHMETIC_TASK = {
  kind: "arithmetic",
  input: { expression: "2+2" },
  outputCharacteristics: { type: "number", structured: true },
  riskLevel: "low",
};

describe("task profile derivation (INT-001)", () => {
  test("derives a structured profile from a deterministic task kind", () => {
    const profile = deriveTaskProfile({ task: ARITHMETIC_TASK }, digest);
    expect(profile.kind).toBe("arithmetic");
    expect(profile.requiresSemanticReasoning).toBe(false);
    expect(profile.capabilityRequirements).toEqual([
      { id: "numeric-computation", kind: "algorithm", minVersion: "1.0.0" },
    ]);
    expect(profile.outputCharacteristics).toEqual({ type: "number", structured: true });
    expect(profile.riskLevel).toBe("low");
    expect(profile.qualityTarget).toBe(0.8);
    expect(profile.profileDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("constraints override task-declared quality/cost/latency targets", () => {
    const profile = deriveTaskProfile(
      {
        task: { ...ARITHMETIC_TASK, qualityTarget: 0.5, maxLatencyMs: 100 },
        constraints: { minQuality: 0.95, maxCostMicroUsd: "500", maxLatencyMs: 250 },
      },
      digest,
    );
    expect(profile.qualityTarget).toBe(0.95);
    expect(profile.maxCostMicroUsd).toBe("500");
    expect(profile.maxLatencyMs).toBe(250);
  });

  test("semantic kinds derive semantic-reasoning requirements and model capabilities", () => {
    const profile = deriveTaskProfile(
      { task: { kind: "interpretation", input: { text: "..." } } },
      digest,
    );
    expect(profile.requiresSemanticReasoning).toBe(true);
    expect(profile.capabilityRequirements).toEqual([
      { id: "text-generation", kind: "model", minVersion: "1.0.0" },
    ]);
  });

  test("analysis derives the hybrid capability set (tool + model)", () => {
    const profile = deriveTaskProfile(
      { task: { kind: "analysis", input: { documents: ["a"] } } },
      digest,
    );
    expect(profile.requiresSemanticReasoning).toBe(true);
    expect(profile.capabilityRequirements).toEqual([
      { id: "document-retrieval", kind: "tool", minVersion: "1.0.0" },
      { id: "text-generation", kind: "model", minVersion: "1.0.0" },
    ]);
  });

  test("an explicit semanticReasoning=false declaration narrows analysis downward", () => {
    const profile = deriveTaskProfile(
      { task: { kind: "analysis", input: {}, semanticReasoning: false } },
      digest,
    );
    expect(profile.requiresSemanticReasoning).toBe(false);
  });

  test("an inconsistent upward declaration (semantic=true on a deterministic kind) is rejected", () => {
    expect(() =>
      deriveTaskProfile(
        { task: { kind: "arithmetic", input: {}, semanticReasoning: true } },
        digest,
      ),
    ).toThrowError(PlatformError);
  });

  test("mixed tasks fail closed without explicit capability declarations", () => {
    expect(() => deriveTaskProfile({ task: { kind: "mixed", input: {} } }, digest)).toThrowError(
      /mixed requires/,
    );
  });

  test("mixed tasks with explicit declarations derive the declared requirements", () => {
    const profile = deriveTaskProfile(
      {
        task: {
          kind: "mixed",
          input: {},
          requiredCapabilities: [
            { id: "schema-validation", kind: "algorithm" },
            { id: "text-generation", kind: "model" },
          ],
        },
      },
      digest,
    );
    expect(profile.capabilityRequirements).toHaveLength(2);
    expect(profile.requiresSemanticReasoning).toBe(true);
  });

  test("a deterministic kind declaring model requirements is rejected (fail closed)", () => {
    expect(() =>
      deriveTaskProfile(
        {
          task: {
            kind: "arithmetic",
            input: {},
            requiredCapabilities: [{ id: "text-generation", kind: "model" }],
          },
        },
        digest,
      ),
    ).toThrowError(/deterministic task kind must not declare model/);
  });

  test("invalid kinds, inputs and targets fail with typed POLICY_DENIED", () => {
    expect(() => deriveTaskProfile({ task: { kind: "magic", input: {} } }, digest)).toThrowError(
      PlatformError,
    );
    expect(() => deriveTaskProfile({ task: { kind: "arithmetic" } }, digest)).toThrowError(
      /task\.input/,
    );
    expect(() =>
      deriveTaskProfile({ task: { ...ARITHMETIC_TASK, qualityTarget: 1.5 } }, digest),
    ).toThrowError(/0\.\.1/);
    expect(() =>
      deriveTaskProfile(
        { task: { ...ARITHMETIC_TASK }, constraints: { maxCostMicroUsd: "1.5" } },
        digest,
      ),
    ).toThrowError(/micro-USD/);
  });

  test("derivation is deterministic: identical inputs produce identical digests", () => {
    const a = deriveTaskProfile({ task: ARITHMETIC_TASK }, digest);
    const b = deriveTaskProfile({ task: structuredClone(ARITHMETIC_TASK) }, digest);
    expect(a.profileDigest).toBe(b.profileDigest);
  });

  test("the task-kind vocabulary is frozen to the eight kinds", () => {
    expect([...TASK_KINDS]).toEqual([
      "arithmetic",
      "data-retrieval",
      "transformation",
      "validation",
      "generation",
      "interpretation",
      "analysis",
      "mixed",
    ]);
  });
});
