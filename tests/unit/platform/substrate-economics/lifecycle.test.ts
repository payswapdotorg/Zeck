/**
 * Unit tests: the readiness/startup lifecycle measurement of the
 * substrate-economics plane (WORK-054) — observations, fail-closed
 * readiness classification, the warm collapse, bounded composite
 * economics with the WORK-049 ceil formula.
 */
import { describe, expect, test } from "vitest";
import {
  classifyReadiness,
  computeStartupExpectation,
  expectedExecutionEconomics,
  validateReadinessObservation,
  validateReadinessObservations,
  type ReadinessObservation,
} from "../../../../src/platform/substrate-economics/lifecycle";
import { SubstrateEconomicsError } from "../../../../src/platform/substrate-economics/catalog";
import {
  validateSubstrateDescriptor,
  type SubstrateDescriptor,
} from "../../../../src/platform/substrate-economics/facts";

const NOW = 1_800_000_000_000;
const FRESHNESS_MS = 30_000;

function baseDescriptor(): SubstrateDescriptor {
  return validateSubstrateDescriptor({
    substrateId: "std-microvm-a",
    version: "1.2.0",
    adapterRef: "substrate-adapter-01",
    isolation: "microvm",
    execution: {
      expectedCostMicroUsd: "400",
      expectedLatencyMs: 3000,
      expectedQuality: 0.9,
      expectedReliability: 0.95,
      basis: { basis: "observed", source: "substrate-observer:fleet-telemetry" },
    },
    startup: {
      cold: {
        readinessMs: 9000,
        startupCostMicroUsd: "120",
        basis: { basis: "estimated", source: "substrate-facts:measured-corpus" },
      },
      warm: {
        readinessMs: 400,
        startupCostMicroUsd: "15",
        basis: { basis: "observed", source: "substrate-observer:warm-pool" },
      },
      snapshot: {
        readinessMs: 1500,
        startupCostMicroUsd: "40",
        basis: { basis: "observed", source: "substrate-observer:snapshot-restore" },
      },
    },
    description: null,
  });
}

function observation(state: ReadinessObservation["state"], ageMs: number): ReadinessObservation {
  return validateReadinessObservation({
    substrateId: "std-microvm-a",
    state,
    observedAtEpochMs: NOW - ageMs,
    source: "probe:adapter-01",
  });
}

describe("readiness observations: validation", () => {
  test("a well-formed observation validates", () => {
    const result = validateReadinessObservation({
      substrateId: "std-microvm-a",
      state: "ready",
      observedAtEpochMs: NOW,
      source: "probe:adapter-01",
    });
    expect(result.state).toBe("ready");
  });

  test("malformed observations are typed rejections", () => {
    for (const mutation of [
      { substrateId: "Not A Slug" },
      { state: "in-use" },
      { state: "booted" },
      { observedAtEpochMs: -1 },
      { observedAtEpochMs: 1.5 },
      { source: "" },
      { source: "x".repeat(201) },
    ]) {
      try {
        validateReadinessObservation({
          substrateId: "std-microvm-a",
          state: "ready",
          observedAtEpochMs: NOW,
          source: "probe:adapter-01",
          ...mutation,
        });
        expect.unreachable(`malformed observation ${JSON.stringify(mutation)} must be rejected`);
      } catch (error) {
        expect((error as SubstrateEconomicsError).name).toBe("SubstrateEconomicsError");
        expect((error as SubstrateEconomicsError).invariant).toBe("readiness-observation-shape");
      }
    }
  });

  test("the observation set is bounded", () => {
    const many = Array.from({ length: 129 }, () => observation("ready", 0));
    expect(() => validateReadinessObservations(many)).toThrow(SubstrateEconomicsError);
  });
});

describe("readiness classification: fail closed, never silently warm", () => {
  test("a fresh ready observation is the believed state", () => {
    const classification = classifyReadiness([observation("ready", 1000)], "std-microvm-a", NOW, FRESHNESS_MS);
    expect(classification.kind).toBe("observed");
    if (classification.kind === "observed") {
      expect(classification.state).toBe("ready");
    }
  });

  test("the LATEST fresh observation wins (started observed after created)", () => {
    const classification = classifyReadiness(
      [observation("created", 5000), observation("started", 1000)],
      "std-microvm-a",
      NOW,
      FRESHNESS_MS,
    );
    expect(classification.kind).toBe("observed");
    if (classification.kind === "observed") {
      expect(classification.state).toBe("started");
    }
  });

  test("a stale observation is unknown — readiness is NEVER assumed", () => {
    const classification = classifyReadiness([observation("ready", 120_000)], "std-microvm-a", NOW, FRESHNESS_MS);
    expect(classification).toEqual({ kind: "unknown" });
  });

  test("no observation at all is unknown", () => {
    expect(classifyReadiness([], "std-microvm-a", NOW, FRESHNESS_MS)).toEqual({ kind: "unknown" });
  });

  test("a future-dated observation is not credible evidence", () => {
    const future = validateReadinessObservation({
      substrateId: "std-microvm-a",
      state: "ready",
      observedAtEpochMs: NOW + 5000,
      source: "probe:adapter-01",
    });
    expect(classifyReadiness([future], "std-microvm-a", NOW, FRESHNESS_MS)).toEqual({
      kind: "unknown",
    });
  });

  test("observations for a different substrate are ignored (scope discipline)", () => {
    const foreign = validateReadinessObservation({
      substrateId: "alt-container-b",
      state: "ready",
      observedAtEpochMs: NOW,
      source: "probe:adapter-02",
    });
    expect(classifyReadiness([foreign], "std-microvm-a", NOW, FRESHNESS_MS)).toEqual({
      kind: "unknown",
    });
  });

  test("the exact freshness boundary is inclusive (age == window counts as fresh)", () => {
    const classification = classifyReadiness(
      [observation("ready", FRESHNESS_MS)],
      "std-microvm-a",
      NOW,
      FRESHNESS_MS,
    );
    expect(classification.kind).toBe("observed");
  });

  test("classification rejects unbounded windows and negative nows", () => {
    for (const [now, window] of [
      [NOW, 0],
      [NOW, 3_600_001],
      [-1, FRESHNESS_MS],
    ] as const) {
      expect(() =>
        classifyReadiness([], "std-microvm-a", now, window),
      ).toThrow(SubstrateEconomicsError);
    }
  });
});

describe("startup expectation: the bounded created→ready computation", () => {
  test("cold mode uses the declared cold fact (the full path, never boot time alone)", () => {
    const descriptor = baseDescriptor();
    const startup = computeStartupExpectation(descriptor, "cold");
    expect(startup.readinessMs).toBe(9000);
    expect(startup.startupCostMicroUsd).toBe("120");
    expect(startup.warmCollapse).toBe(false);
    expect(startup.basis.basis).toBe("estimated");
  });

  test("a fresh ready observation collapses ONLY the warm mode", () => {
    const descriptor = baseDescriptor();
    const ready = classifyReadiness([observation("ready", 500)], "std-microvm-a", NOW, FRESHNESS_MS);
    const warm = computeStartupExpectation(descriptor, "warm", ready);
    expect(warm.readinessMs).toBe(0);
    expect(warm.startupCostMicroUsd).toBe("0");
    expect(warm.warmCollapse).toBe(true);
    expect(warm.basis.basis).toBe("observed");
    expect(warm.basis.source).toContain("substrate-readiness-observation");
    // Cold and snapshot are provisioning paths — the observation cannot
    // collapse them.
    const cold = computeStartupExpectation(descriptor, "cold", ready);
    expect(cold.readinessMs).toBe(9000);
    const snapshot = computeStartupExpectation(descriptor, "snapshot", ready);
    expect(snapshot.readinessMs).toBe(1500);
  });

  test("a started (not ready) observation collapses nothing — started ≠ ready", () => {
    const descriptor = baseDescriptor();
    const started = classifyReadiness([observation("started", 500)], "std-microvm-a", NOW, FRESHNESS_MS);
    const warm = computeStartupExpectation(descriptor, "warm", started);
    expect(warm.readinessMs).toBe(400);
    expect(warm.warmCollapse).toBe(false);
  });

  test("unknown readiness uses the declared facts unchanged", () => {
    const descriptor = baseDescriptor();
    const warm = computeStartupExpectation(descriptor, "warm", { kind: "unknown" });
    expect(warm.readinessMs).toBe(400);
    expect(warm.warmCollapse).toBe(false);
  });

  test("an unoffered mode is a typed rejection (no silent cold fallback)", () => {
    const coldOnly = validateSubstrateDescriptor({
      ...baseDescriptor(),
      startup: { cold: baseDescriptor().startup.cold },
    });
    expect(() => computeStartupExpectation(coldOnly, "warm")).toThrow(SubstrateEconomicsError);
    expect(() => computeStartupExpectation(coldOnly, "snapshot")).toThrow(SubstrateEconomicsError);
  });
});

describe("composite economics: bounded, BigInt-exact, WORK-049 formula", () => {
  test("totals compose startup + execution exactly", () => {
    const descriptor = baseDescriptor();
    const economics = expectedExecutionEconomics(descriptor, "cold");
    expect(economics.totalLatencyMs).toBe(9000 + 3000);
    expect(economics.totalCostMicroUsd).toBe("520"); // 120 + 400
    // ceil(520 / 0.95) = ceil(547.36…) = 548 — the WORK-049 formula.
    expect(economics.expectedSuccessfulResolutionCostMicroUsd).toBe("548");
  });

  test("the warm collapse reduces the composite to the bare execution claim", () => {
    const descriptor = baseDescriptor();
    const ready = classifyReadiness([observation("ready", 500)], "std-microvm-a", NOW, FRESHNESS_MS);
    const economics = expectedExecutionEconomics(descriptor, "warm", ready);
    expect(economics.totalLatencyMs).toBe(3000);
    expect(economics.totalCostMicroUsd).toBe("400");
    expect(economics.expectedSuccessfulResolutionCostMicroUsd).toBe("422"); // ceil(400/0.95)
  });

  test("reliability 1.0 divides exactly (no phantom ceiling)", () => {
    const descriptor = validateSubstrateDescriptor({
      ...baseDescriptor(),
      execution: {
        ...baseDescriptor().execution,
        expectedReliability: 1,
      },
    });
    const economics = expectedExecutionEconomics(descriptor, "warm");
    expect(economics.expectedSuccessfulResolutionCostMicroUsd).toBe("415"); // 15 + 400 exactly
  });

  test("determinism: identical inputs produce identical economics", () => {
    const descriptor = baseDescriptor();
    const first = expectedExecutionEconomics(descriptor, "snapshot");
    const second = expectedExecutionEconomics(descriptor, "snapshot");
    expect(first).toEqual(second);
  });
});
