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
    // Fully synthetic state: stable across program evolution (never
    // coupled to the live completion status of any real work order).
    const synthetic: ValidationStateSnapshot = {
      program: {
        schemaVersion: 1,
        program: "zeck-validation",
        status: "active",
        maxConcurrentWorkers: 3,
        workOrders: {
          "VAL-X01": { status: "complete", title: "x1" },
          "VAL-X02": { status: "eligible", title: "x2" },
          "VAL-X03": { status: "eligible", title: "x3" },
        },
      },
      frontier: {
        schemaVersion: 1,
        program: "zeck-validation",
        status: "active",
        eligible: [],
        inFlight: ["VAL-X03"],
        blocked: [],
        maxConcurrentWorkers: 3,
      },
      dependencies: {
        schemaVersion: 1,
        program: "zeck-validation",
        dependencies: {
          "VAL-X01": [],
          "VAL-X02": ["VAL-X01"],
          "VAL-X03": ["VAL-X02"],
        },
      },
    };
    const violations = checkValidationStateConsistency(synthetic);
    expect(
      violations.some(
        (v) =>
          v.kind === "dependency-not-complete" &&
          v.detail.includes("VAL-X03") &&
          v.detail.includes("VAL-X02"),
      ),
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
