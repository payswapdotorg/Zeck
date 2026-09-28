/**
 * PPR-018A — the measurement schema tests (scope item 6: "a reusable
 * measurement schema covering ALL of …").
 *
 * Pins:
 *  - the thirteen dimensions are exactly the program's portfolio
 *    measures (outcome success; quality/verification; latency + tail;
 *    usage + cost; failure/retry; determinism/reuse; provider
 *    portability; customization coverage; engineering surface
 *    removed; capability-discovery avoidance; telemetry/explainability;
 *    diagnosis/recovery; reproducibility);
 *  - a measurement set MISSING any dimension is a NAMED defect (the
 *    coverage contract — never silently absent);
 *  - every entry carries an honest basis; a not-measured entry must
 *    SAY why (never imply a value);
 *  - the percentile/median helpers are deterministic (one definition).
 */

import { describe, expect, test } from "vitest";
import {
  MEASUREMENT_DIMENSIONS,
  type MeasurementSet,
  medianOf,
  notMeasuredDimensions,
  percentileOf,
  validateMeasurementEntry,
  validateMeasurementSet,
} from "../../../src/integrations/compatibility/public";

/** A well-formed entry for one dimension (statement tailored to the basis). */
function entryOf(
  dimension: (typeof MEASUREMENT_DIMENSIONS)[number],
  basis = "measured",
): {
  readonly dimension: (typeof MEASUREMENT_DIMENSIONS)[number];
  readonly basis: string;
  readonly statement: string;
  readonly [key: string]: unknown;
} {
  const statement =
    basis === "not-measured"
      ? "not measured — no samples were recorded in this run"
      : "a measured statement with units (ms, micro-USD, counts)";
  switch (dimension) {
    case "outcome-success":
      return { dimension, basis, statement, attempts: 1, successes: 1, failures: 0, notRun: 0 };
    case "quality-verification":
      return {
        dimension,
        basis,
        statement,
        taskChecksPassed: null,
        taskChecksTotal: null,
        zeckVerificationsPassed: null,
        zeckVerificationsTotal: null,
      };
    case "latency-tail":
      return {
        dimension,
        basis,
        statement,
        samplesMs: [],
        sampleCount: 0,
        medianMs: null,
        p95Ms: null,
        p99Ms: null,
        maxMs: null,
      };
    case "usage-cost":
      return {
        dimension,
        basis,
        statement,
        inputTokens: null,
        outputTokens: null,
        totalCostMicroUsd: null,
        costPerSuccessMicroUsd: null,
      };
    case "failure-retry":
      return {
        dimension,
        basis,
        statement,
        failureCount: null,
        retryCount: null,
        duplicateCount: null,
        timeoutCount: null,
      };
    case "determinism-reuse":
      return {
        dimension,
        basis,
        statement,
        deterministicExecutionCount: null,
        reuseCount: null,
        verifiedComputationSubstitutions: null,
      };
    case "provider-portability":
      return {
        dimension,
        basis,
        statement,
        providerSwitchTimeMs: null,
        changedApplicationFiles: null,
        regressionCount: null,
      };
    case "customization-coverage":
      return {
        dimension,
        basis,
        statement,
        customizationAxesRetained: null,
        customizationAxesTotal: null,
      };
    case "engineering-surface-removed":
      return { dimension, basis, statement, removedFiles: null, removedLines: null };
    case "capability-discovery-avoidance":
      return {
        dimension,
        basis,
        statement,
        capabilitiesAdoptedFromZeck: null,
        avoidedBespokeImplementations: null,
      };
    case "telemetry-explainability":
      return {
        dimension,
        basis,
        statement,
        reconstructibleExecutions: null,
        executionsTotal: null,
      };
    case "diagnosis-recovery":
      return {
        dimension,
        basis,
        statement,
        diagnosisTimeMs: null,
        recoveryTimeMs: null,
        incidentsExercised: null,
      };
    case "reproducibility":
      return { dimension, basis, statement, rerunsAttempted: null, rerunsAgreed: null };
  }
}

function fullSet() {
  return { entries: MEASUREMENT_DIMENSIONS.map((dimension) => entryOf(dimension)) };
}

describe("the thirteen-dimension measurement schema (coverage is the contract)", () => {
  test("the dimensions are exactly the program's portfolio measures (all thirteen, frozen order)", () => {
    expect(MEASUREMENT_DIMENSIONS).toEqual([
      "outcome-success",
      "quality-verification",
      "latency-tail",
      "usage-cost",
      "failure-retry",
      "determinism-reuse",
      "provider-portability",
      "customization-coverage",
      "engineering-surface-removed",
      "capability-discovery-avoidance",
      "telemetry-explainability",
      "diagnosis-recovery",
      "reproducibility",
    ]);
  });

  test("a complete set validates clean (every dimension exactly once)", () => {
    expect(validateMeasurementSet(fullSet())).toEqual([]);
  });

  test("EVERY missing dimension is a named defect (never silently absent)", () => {
    for (const dimension of MEASUREMENT_DIMENSIONS) {
      const incomplete = {
        entries: MEASUREMENT_DIMENSIONS.filter((candidate) => candidate !== dimension).map(
          (candidate) => entryOf(candidate),
        ),
      };
      const issues = validateMeasurementSet(incomplete);
      expect(
        issues.some((issue) => issue.dimension === dimension && issue.issue.includes("MISSING")),
        dimension,
      ).toBe(true);
    }
  });

  test("a duplicate dimension is a named defect", () => {
    const set = fullSet();
    const duplicated = { entries: [...set.entries, entryOf("latency-tail")] };
    expect(
      validateMeasurementSet(duplicated).some(
        (issue) => issue.dimension === "latency-tail" && issue.issue.includes("duplicate"),
      ),
    ).toBe(true);
  });

  test("an unknown dimension or basis is rejected (closed vocabularies)", () => {
    expect(
      validateMeasurementEntry({ dimension: "vibes", basis: "measured", statement: "x" }).length,
    ).toBeGreaterThan(0);
    expect(
      validateMeasurementEntry({ dimension: "latency-tail", basis: "guessed", statement: "x" })
        .length,
    ).toBeGreaterThan(0);
  });

  test("a not-measured entry must SAY why (never imply a value)", () => {
    expect(
      validateMeasurementEntry({
        dimension: "latency-tail",
        basis: "not-measured",
        statement: "latency was excellent and fast",
      }).length,
    ).toBeGreaterThan(0);
    expect(
      validateMeasurementEntry({
        dimension: "latency-tail",
        basis: "not-measured",
        statement: "not measured — no latency samples were recorded in this run",
      }),
    ).toEqual([]);
  });

  test("the honest-decline helper names every not-measured dimension", () => {
    // The raw shape passes validation (unknown input); the typed view
    // for the helper is the validated cast of the same object.
    const raw = {
      entries: MEASUREMENT_DIMENSIONS.map((dimension) =>
        entryOf(dimension, dimension === "reproducibility" ? "not-measured" : "measured"),
      ),
    };
    expect(validateMeasurementSet(raw)).toEqual([]);
    const set = raw as unknown as MeasurementSet;
    expect(notMeasuredDimensions(set)).toEqual(["reproducibility"]);
  });
});

describe("the deterministic percentile helpers (one definition, no drift)", () => {
  test("medianOf: odd/even counts and the empty case", () => {
    expect(medianOf([])).toBeNull();
    expect(medianOf([5])).toBe(5);
    expect(medianOf([1, 3, 5])).toBe(3);
    expect(medianOf([1, 2, 3, 4])).toBe(2.5);
    // Order independence (sorted internally).
    expect(medianOf([4, 1, 3, 2])).toBe(2.5);
  });

  test("percentileOf: nearest-rank, deterministic", () => {
    expect(percentileOf([], 95)).toBeNull();
    expect(percentileOf([10], 95)).toBe(10);
    expect(percentileOf([10], 0)).toBeNull();
    expect(percentileOf([10], 101)).toBeNull();
    const samples = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentileOf(samples, 95)).toBe(95);
    expect(percentileOf(samples, 99)).toBe(99);
    expect(percentileOf(samples, 100)).toBe(100);
    expect(percentileOf([1, 2, 3, 4, 5], 50)).toBe(3);
  });
});
