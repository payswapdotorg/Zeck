/**
 * VAL-001 acceptance criterion 3 (worker submission/evidence structure)
 * and criterion 4 (stable run identity + reproduction metadata).
 * Discrimination: weakened submissions and incomplete run metadata are
 * rejected mechanically — they can never count as delivered evidence.
 */

import { describe, expect, test } from "vitest";
import {
  checkRunMetadata,
  deriveRunId,
  type RunMetadata,
  type SubmissionRecord,
  validateSubmission,
} from "../../../benchmarks/validation";

const FULL_BASE = "90ceeddd1c6e5553254eaaade3155be391670787";
const FULL_HEAD = "1111111111111111111111111111111111111111";

const completeSubmission: SubmissionRecord = {
  workOrder: "VAL-001",
  baseRevision: FULL_BASE,
  finalHead: FULL_HEAD,
  branch: "work/VAL-001-validation-lab-bootstrap",
  pullRequest: 42,
  changedFiles: ["benchmarks/validation/program.ts"],
  battery: [
    { command: "bun run typecheck", outcome: "pass", detail: "0 errors" },
    { command: "bun run test:unit", outcome: "pass", detail: "3390 passed" },
  ],
  issues: [
    {
      reproduction: "bun run test:unit tests/unit/validation",
      impact: "AC3 evidence shape",
      rootCause: ["test-harness"],
      viableSolutions: ["extend the contract validator"],
      recommendedSolution: "extend the contract validator (mechanical, no drift)",
      classification: "validation-defect",
      verificationEvidence: "unit suite green at the final head",
    },
  ],
  notRun: [{ surface: "real provider voice runs", reason: "no usable test access yet" }],
  evidenceRefs: ["benchmarks/validation/evidence/VAL-001.md"],
};

const completeMetadata: RunMetadata = {
  program: "zeck-validation",
  workOrder: "VAL-010",
  baseRevision: FULL_BASE,
  applicationRevision: "2222222222222222222222222222222222222222",
  corpusRevision: "3333333333333333333333333333333333333333",
  integrationSurface: "sdk",
  environment: {
    runtime: "bun 1.3.4",
    toolchain: "tsc 5.9",
    database: "postgresql 16.4",
    configuration: { ZECK_ENVIRONMENT: "local" },
  },
  observedAt: "2026-09-11T20:00:00.000Z",
};

describe("validation: submission contract (VAL-001 AC3)", () => {
  test("a complete submission passes", () => {
    expect(validateSubmission(completeSubmission)).toEqual([]);
  });

  test("a submission with no evidence references is rejected (discrimination)", () => {
    const weakened: SubmissionRecord = { ...completeSubmission, evidenceRefs: [] };
    expect(validateSubmission(weakened).some((v) => v.path === "evidenceRefs")).toBe(true);
  });

  test("a submission with a short (non-SHA) base revision is rejected (discrimination)", () => {
    const weakened: SubmissionRecord = { ...completeSubmission, baseRevision: "90ceedd" };
    expect(validateSubmission(weakened).some((v) => v.path === "baseRevision")).toBe(true);
  });

  test("an issue without the seven-part protocol is rejected (discrimination)", () => {
    const weakened: SubmissionRecord = {
      ...completeSubmission,
      issues: [
        {
          reproduction: "cmd",
          impact: "impact",
          rootCause: [],
          viableSolutions: [],
          recommendedSolution: "",
          classification: "implementation-defect",
          verificationEvidence: "evidence",
        },
      ],
    };
    const violations = validateSubmission(weakened);
    expect(violations.some((v) => v.path === "issues[0].rootCause")).toBe(true);
    expect(violations.some((v) => v.path === "issues[0].viableSolutions")).toBe(true);
    expect(violations.some((v) => v.path === "issues[0].recommendedSolution")).toBe(true);
  });

  test("a submission with an empty battery or inventory is rejected (discrimination)", () => {
    expect(
      validateSubmission({ ...completeSubmission, battery: [] }).some((v) => v.path === "battery"),
    ).toBe(true);
    expect(
      validateSubmission({ ...completeSubmission, changedFiles: [] }).some(
        (v) => v.path === "changedFiles",
      ),
    ).toBe(true);
  });

  test("a NOT RUN boundary without an exact reason is rejected (discrimination)", () => {
    const weakened: SubmissionRecord = {
      ...completeSubmission,
      notRun: [{ surface: "provider runs", reason: "" }],
    };
    expect(validateSubmission(weakened).some((v) => v.path === "notRun[0].reason")).toBe(true);
  });
});

describe("validation: run identity (VAL-001 AC4)", () => {
  test("complete run metadata is admissible", () => {
    expect(checkRunMetadata(completeMetadata)).toEqual([]);
  });

  test("the same configuration yields the same run id (determinism)", () => {
    expect(deriveRunId(completeMetadata)).toBe(deriveRunId(completeMetadata));
  });

  test("the observation timestamp never changes the run id", () => {
    const later: RunMetadata = {
      ...completeMetadata,
      observedAt: "2026-09-12T09:30:00.000Z",
    };
    expect(deriveRunId(later)).toBe(deriveRunId(completeMetadata));
  });

  test("any reproduction-relevant change changes the run id (discrimination)", () => {
    const differentBase: RunMetadata = {
      ...completeMetadata,
      baseRevision: "4444444444444444444444444444444444444444",
    };
    expect(deriveRunId(differentBase)).not.toBe(deriveRunId(completeMetadata));
    const differentEnvironment: RunMetadata = {
      ...completeMetadata,
      environment: { ...completeMetadata.environment, toolchain: "tsc 5.10" },
    };
    expect(deriveRunId(differentEnvironment)).not.toBe(deriveRunId(completeMetadata));
  });

  test("incomplete run metadata is rejected (discrimination)", () => {
    const incomplete: RunMetadata = {
      ...completeMetadata,
      corpusRevision: "",
      environment: { ...completeMetadata.environment, database: "" },
    };
    const violations = checkRunMetadata(incomplete);
    expect(violations.some((v) => v.path === "corpusRevision")).toBe(true);
    expect(violations.some((v) => v.path === "environment.database")).toBe(true);
  });
});
