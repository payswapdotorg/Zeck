/**
 * VAL-001 acceptance criterion 2: the governed validation state records
 * dependencies, frontier, in-flight work and the three-worker ceiling,
 * and is mechanically consistent — checked against the REAL state files
 * in this repository (CI parity with scripts/validation-check.py).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  checkValidationStateConsistency,
  type ValidationStateSnapshot,
} from "../../../benchmarks/validation";

const REPO_ROOT = join(process.cwd());

function readJson(relative: string): unknown {
  return JSON.parse(readFileSync(join(REPO_ROOT, relative), "utf8"));
}

const state = {
  program: readJson("spec/validation-state/program-state.json"),
  frontier: readJson("spec/validation-state/frontier-state.json"),
  dependencies: readJson("spec/validation-state/dependency-state.json"),
} as ValidationStateSnapshot;

describe("validation: governed state consistency (VAL-001 AC2)", () => {
  test("the real validation state is mechanically consistent", () => {
    expect(checkValidationStateConsistency(state)).toEqual([]);
  });

  test("the state records the three-worker concurrency ceiling", () => {
    expect(state.frontier.maxConcurrentWorkers).toBe(3);
    expect(state.program.maxConcurrentWorkers).toBe(3);
  });

  test("every declared dependency is complete before a work order is eligible or in flight", () => {
    const violations = checkValidationStateConsistency(state);
    expect(violations.filter((v) => v.kind === "dependency-not-complete")).toEqual([]);
  });

  test("a corrupted snapshot is rejected (discrimination)", () => {
    const corrupted: ValidationStateSnapshot = {
      program: { ...state.program, maxConcurrentWorkers: 2 },
      frontier: { ...state.frontier, maxConcurrentWorkers: 2 },
      dependencies: state.dependencies,
    };
    const violations = checkValidationStateConsistency(corrupted);
    expect(violations.some((v) => v.kind === "concurrency-exceeded")).toBe(true);
  });

  test("an in-flight work order with an incomplete dependency is rejected (discrimination)", () => {
    const corrupted: ValidationStateSnapshot = {
      program: state.program,
      frontier: {
        ...state.frontier,
        eligible: [],
        inFlight: ["VAL-001", "VAL-002"],
      },
      dependencies: state.dependencies,
    };
    const violations = checkValidationStateConsistency(corrupted);
    expect(
      violations.some((v) => v.kind === "dependency-not-complete" && v.detail.includes("VAL-002")),
    ).toBe(true);
  });

  test("a dependency cycle is rejected (discrimination)", () => {
    const corrupted: ValidationStateSnapshot = {
      program: state.program,
      frontier: state.frontier,
      dependencies: {
        ...state.dependencies,
        dependencies: { ...state.dependencies.dependencies, "VAL-001": ["VAL-002"] },
      },
    };
    const violations = checkValidationStateConsistency(corrupted);
    expect(violations.some((v) => v.kind === "dependency-cycle")).toBe(true);
  });
});
