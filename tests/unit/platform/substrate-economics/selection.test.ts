/**
 * Unit tests: the least-expense-sufficient substrate selection
 * (WORK-054) — sufficiency floors, deterministic comparison and
 * tie-breaking, zero-provider operation, constraint derivation from
 * the WORK-049 foundation, content-addressed identity and replay.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { SubstrateEconomicsError } from "../../../../src/platform/substrate-economics/catalog";
import {
  type SubstrateDescriptor,
  validateSubstrateDescriptor,
} from "../../../../src/platform/substrate-economics/facts";
import { validateReadinessObservation } from "../../../../src/platform/substrate-economics/lifecycle";
import {
  deriveSelectionConstraints,
  type SubstrateSelectionConstraints,
  type SubstrateSelectionInput,
  selectSubstrate,
  validateSubstrateSelectionRecord,
} from "../../../../src/platform/substrate-economics/selection";

const digest = {
  sha256Hex: (value: string) => createHash("sha256").update(value, "utf8").digest("hex"),
};

const NOW = 1_800_000_000_000;
const RECORDED_AT = "2026-09-24T12:00:00Z";

function descriptor(overrides: Record<string, unknown>): SubstrateDescriptor {
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
    },
    description: null,
    ...overrides,
  });
}

/** The representative corpus: a cheap-quality-low substrate, a mid substrate, an expensive-reliable one. */
function corpus(): readonly SubstrateDescriptor[] {
  return [
    descriptor({
      substrateId: "cheap-process-c",
      isolation: "process",
      execution: {
        expectedCostMicroUsd: "50",
        expectedLatencyMs: 1000,
        expectedQuality: 0.6,
        expectedReliability: 0.8,
        basis: { basis: "estimated", source: "substrate-observer:process-class" },
      },
      startup: {
        cold: {
          readinessMs: 100,
          startupCostMicroUsd: "1",
          basis: { basis: "defaulted", source: "substrate-facts:process-default" },
        },
      },
    }),
    descriptor({
      substrateId: "mid-container-b",
      isolation: "container",
      execution: {
        expectedCostMicroUsd: "200",
        expectedLatencyMs: 2000,
        expectedQuality: 0.88,
        expectedReliability: 0.93,
        basis: { basis: "observed", source: "substrate-observer:container-fleet" },
      },
      startup: {
        cold: {
          readinessMs: 4000,
          startupCostMicroUsd: "60",
          basis: { basis: "estimated", source: "substrate-facts:container-cold" },
        },
        snapshot: {
          readinessMs: 1200,
          startupCostMicroUsd: "25",
          basis: { basis: "observed", source: "substrate-observer:snapshot" },
        },
      },
    }),
    descriptor({}), // std-microvm-a
  ];
}

function selectionInput(
  candidates: readonly SubstrateDescriptor[],
  constraints: Record<string, unknown> | SubstrateSelectionConstraints,
  overrides: Record<string, unknown> = {},
): SubstrateSelectionInput {
  return {
    candidates,
    constraints,
    recordedAt: RECORDED_AT,
    ...overrides,
  };
}

describe("selection: the least-expense-sufficient choice", () => {
  test("quality is a HARD FLOOR — the cheapest substrate below the floor is insufficient, never selected", () => {
    const result = selectSubstrate(selectionInput(corpus(), { minQuality: 0.85 }), digest);
    // cheap-process-c: quality 0.6 < 0.85 → insufficient (all modes).
    // mid-container-b: quality 0.88 ≥ 0.85 → sufficient.
    // std-microvm-a: quality 0.9 ≥ 0.85 → sufficient.
    const selected = result.selected;
    expect(selected).not.toBeNull();
    expect(selected?.substrateId).not.toBe("cheap-process-c");
    const cheap = result.verdicts.filter((v) => v.substrateId === "cheap-process-c");
    expect(cheap.length).toBeGreaterThan(0);
    for (const verdict of cheap) {
      expect(verdict.sufficient).toBe(false);
      expect(verdict.insufficiencyCode).toBe("quality-below-floor");
    }
  });

  test("among sufficient candidates the LEAST expected successful-resolution cost wins", () => {
    const result = selectSubstrate(selectionInput(corpus(), { minQuality: 0.8 }), digest);
    expect(result.outcome).toBe("selected");
    // mid-container-b snapshot: startup 25 + exec 200 = 225; ceil(225/0.93) = 242
    // mid-container-b cold: 60 + 200 = 260; ceil(260/0.93) = 280
    // std-microvm-a warm: 15 + 400 = 415; ceil(415/0.95) = 437
    // std-microvm-a cold: 120 + 400 = 520; ceil(520/0.95) = 548
    // cheap-process-c is quality-below-floor at 0.8.
    expect(result.selected?.substrateId).toBe("mid-container-b");
    expect(result.selected?.mode).toBe("snapshot");
    expect(result.selected?.economics.expectedSuccessfulResolutionCostMicroUsd).toBe("242");
  });

  test("every insufficient verdict carries EXACTLY ONE closed reason code (never silent)", () => {
    const result = selectSubstrate(
      selectionInput(corpus(), { minQuality: 0.8, minReliability: 0.94, maxTotalLatencyMs: 2500 }),
      digest,
    );
    for (const verdict of result.verdicts) {
      if (!verdict.sufficient) {
        expect(verdict.insufficiencyCode).toBeDefined();
        expect(typeof verdict.insufficiencyDetail).toBe("string");
      } else {
        expect(verdict.insufficiencyCode).toBeUndefined();
      }
    }
    // mid-container-b quality 0.88 passes 0.8 but reliability 0.93 < 0.94 → insufficient.
    const mid = result.verdicts.filter((v) => v.substrateId === "mid-container-b");
    for (const verdict of mid) {
      expect(verdict.sufficient).toBe(false);
      expect(verdict.insufficiencyCode).toBe("reliability-below-floor");
    }
    // std-microvm-a warm: latency 400 + 3000 = 3400 > 2500 → latency-above-ceiling.
    const stdWarm = result.verdicts.find(
      (v) => v.substrateId === "std-microvm-a" && v.mode === "warm",
    );
    expect(stdWarm?.insufficiencyCode).toBe("latency-above-ceiling");
  });

  test("an isolation floor excludes weaker substrates with the ladder reason code", () => {
    const result = selectSubstrate(
      selectionInput(corpus(), { minQuality: 0.5, requiredIsolation: "microvm" }),
      digest,
    );
    // Only std-microvm-a has isolation microvm at the floor.
    expect(result.selected?.substrateId).toBe("std-microvm-a");
    const container = result.verdicts.filter((v) => v.substrateId === "mid-container-b");
    for (const verdict of container) {
      expect(verdict.insufficiencyCode).toBe("isolation-below-floor");
    }
  });

  test("a cost ceiling excludes expensive candidates (budget discipline)", () => {
    const result = selectSubstrate(
      selectionInput(corpus(), { minQuality: 0.8, maxExpectedCostMicroUsd: "242" }),
      digest,
    );
    expect(result.selected?.substrateId).toBe("mid-container-b");
    expect(result.selected?.mode).toBe("snapshot");
    // cold (280) exceeds 242 → cost-above-ceiling; microvm (437/548) too.
    const cold = result.verdicts.find(
      (v) => v.substrateId === "mid-container-b" && v.mode === "cold",
    );
    expect(cold?.insufficiencyCode).toBe("cost-above-ceiling");
  });

  test("no sufficient candidate is a typed fail-closed outcome (never a below-floor selection)", () => {
    const result = selectSubstrate(selectionInput(corpus(), { minQuality: 0.95 }), digest);
    expect(result.outcome).toBe("no-sufficient-substrate");
    expect(result.selected).toBeNull();
    expect(result.record.outcome).toBe("no-sufficient-substrate");
    for (const verdict of result.verdicts) {
      expect(verdict.sufficient).toBe(false);
    }
  });

  test("ZERO candidates is the zero-provider outcome (no fallback substrate is invented)", () => {
    const result = selectSubstrate(selectionInput([], { minQuality: 0.8 }), digest);
    expect(result.outcome).toBe("no-candidates");
    expect(result.selected).toBeNull();
    expect(result.record.candidates).toEqual([]);
    expect(result.record.outcome).toBe("no-candidates");
  });
});

describe("selection: warm/snapshot-aware decision input", () => {
  test("a fresh ready observation makes the WARM mode win when economics justify it", () => {
    const candidates = corpus();
    // Without observations: warm of std-microvm-a = 437 expected — loses to mid-container-b snapshot (242).
    const baseline = selectSubstrate(selectionInput(candidates, { minQuality: 0.8 }), digest);
    expect(baseline.selected?.substrateId).toBe("mid-container-b");

    // With a fresh ready observation for std-microvm-a: warm collapses to bare
    // execution ceil(400/0.95) = 422... still > 242. Tighten the latency
    // ceiling so only the collapsed warm mode fits: mid-container-b snapshot
    // total latency 1200+2000=3200; std warm-collapsed = 0+3000=3000.
    const ready = validateReadinessObservation({
      substrateId: "std-microvm-a",
      state: "ready",
      observedAtEpochMs: NOW - 500,
      source: "probe:adapter-01",
    });
    const result = selectSubstrate(
      selectionInput(
        candidates,
        { minQuality: 0.8, maxTotalLatencyMs: 3000 },
        {
          readiness: { observations: [ready], nowEpochMs: NOW, freshnessWindowMs: 30_000 },
        },
      ),
      digest,
    );
    expect(result.outcome).toBe("selected");
    expect(result.selected?.substrateId).toBe("std-microvm-a");
    expect(result.selected?.mode).toBe("warm");
    expect(result.selected?.economics.startup.warmCollapse).toBe(true);
    // mid-container-b's snapshot (3200ms) is now latency-above-ceiling.
    const snapshot = result.verdicts.find(
      (v) => v.substrateId === "mid-container-b" && v.mode === "snapshot",
    );
    expect(snapshot?.insufficiencyCode).toBe("latency-above-ceiling");
  });

  test("a STALE ready observation never upgrades anything (fail-closed readiness)", () => {
    const stale = validateReadinessObservation({
      substrateId: "std-microvm-a",
      state: "ready",
      observedAtEpochMs: NOW - 120_000,
      source: "probe:adapter-01",
    });
    const result = selectSubstrate(
      selectionInput(
        corpus(),
        { minQuality: 0.8, maxTotalLatencyMs: 3000 },
        {
          readiness: { observations: [stale], nowEpochMs: NOW, freshnessWindowMs: 30_000 },
        },
      ),
      digest,
    );
    // No candidate fits 3000ms without the warm collapse → no-sufficient-substrate.
    expect(result.outcome).toBe("no-sufficient-substrate");
  });
});

describe("selection: determinism and identity", () => {
  test("identical inputs produce the IDENTICAL selection record (byte-identical + selectionId)", () => {
    const first = selectSubstrate(selectionInput(corpus(), { minQuality: 0.8 }), digest);
    const second = selectSubstrate(selectionInput(corpus(), { minQuality: 0.8 }), digest);
    expect(JSON.stringify(first.record)).toBe(JSON.stringify(second.record));
    expect(first.record.selectionId).toBe(second.record.selectionId);
  });

  test("input ORDER never changes the selection or the record identity", () => {
    const a = selectSubstrate(selectionInput(corpus(), { minQuality: 0.8 }), digest);
    const reordered = [...corpus()].reverse();
    const b = selectSubstrate(selectionInput(reordered, { minQuality: 0.8 }), digest);
    expect(b.record.selectionId).toBe(a.record.selectionId);
    expect(b.selected).toEqual(a.selected);
  });

  test("a drifted input produces a different selectionId (content addressing)", () => {
    const a = selectSubstrate(selectionInput(corpus(), { minQuality: 0.8 }), digest);
    const driftedCorpus = corpus().map((candidate) =>
      candidate.substrateId === "mid-container-b"
        ? descriptor({
            substrateId: "mid-container-b",
            isolation: "container",
            execution: {
              expectedCostMicroUsd: "201",
              expectedLatencyMs: 2000,
              expectedQuality: 0.88,
              expectedReliability: 0.93,
              basis: { basis: "observed", source: "substrate-observer:container-fleet" },
            },
            startup: candidate.startup,
          })
        : candidate,
    );
    const b = selectSubstrate(selectionInput(driftedCorpus, { minQuality: 0.8 }), digest);
    expect(b.record.selectionId).not.toBe(a.record.selectionId);
  });

  test("recordedAt is volatile identity (excluded from the digest) but carried", () => {
    const a = selectSubstrate(
      selectionInput(corpus(), { minQuality: 0.8 }, { recordedAt: "2026-09-24T12:00:00Z" }),
      digest,
    );
    const b = selectSubstrate(
      selectionInput(corpus(), { minQuality: 0.8 }, { recordedAt: "2026-09-25T09:00:00Z" }),
      digest,
    );
    expect(a.record.selectionId).toBe(b.record.selectionId);
    expect(a.record.recordedAt).not.toBe(b.record.recordedAt);
  });

  test("the record round-trips through validation (identity re-verified)", () => {
    const result = selectSubstrate(selectionInput(corpus(), { minQuality: 0.8 }), digest);
    const roundTrip = validateSubstrateSelectionRecord(
      JSON.parse(JSON.stringify(result.record)),
      digest,
    );
    expect(roundTrip.selectionId).toBe(result.record.selectionId);
    expect(JSON.stringify(roundTrip)).toBe(JSON.stringify(result.record));
  });

  test("a TAMPERED record is rejected at read time (deterministic audit)", () => {
    const result = selectSubstrate(selectionInput(corpus(), { minQuality: 0.8 }), digest);
    const tampered = JSON.parse(JSON.stringify(result.record)) as {
      selected: { substrateId: string } | null;
    };
    if (tampered.selected) {
      tampered.selected.substrateId = "cheap-process-c";
    }
    expect(() => validateSubstrateSelectionRecord(tampered, digest)).toThrow(
      SubstrateEconomicsError,
    );
  });
});

describe("selection: constraint derivation from the WORK-049 foundation", () => {
  function qualityConstraint(minQuality: number, minReliability?: number, id = "quality-floor") {
    return {
      constraintId: id,
      kind: "quality" as const,
      enforcement: "hard" as const,
      source: { authority: "planning" as const },
      payload: { ...(minReliability === undefined ? {} : { minReliability }), minQuality },
    };
  }

  test("the derivation carries the foundation's floors/ceilings read-only", () => {
    const derived = deriveSelectionConstraints([
      qualityConstraint(0.8, 0.9),
      {
        constraintId: "latency-cap",
        kind: "latency" as const,
        enforcement: "hard" as const,
        source: { authority: "planning" as const },
        payload: { maxLatencyMs: 5000 },
      },
      {
        constraintId: "isolation-floor",
        kind: "side-effect" as const,
        enforcement: "hard" as const,
        source: { authority: "policy" as const },
        payload: { isolation: { minIsolation: "container" as const } },
      },
      {
        constraintId: "budget-cap",
        kind: "budget" as const,
        enforcement: "hard" as const,
        source: {
          authority: "budget" as const,
          budgetId: "budget-1",
          scopeKind: "per-execution" as const,
        },
        payload: { maxCostMicroUsd: "5000" },
      },
    ]);
    expect(derived.constraints.minQuality).toBe(0.8);
    expect(derived.constraints.minReliability).toBe(0.9);
    expect(derived.constraints.maxTotalLatencyMs).toBe(5000);
    expect(derived.constraints.requiredIsolation).toBe("container");
    expect(derived.constraints.maxExpectedCostMicroUsd).toBe("5000");
    expect(derived.sourceConstraintIds).toEqual([
      "quality-floor",
      "latency-cap",
      "isolation-floor",
      "budget-cap",
    ]);
  });

  test("multiple hard floors compose to the STRICTEST value (derivation never widens)", () => {
    const derived = deriveSelectionConstraints([
      qualityConstraint(0.8),
      qualityConstraint(0.9, undefined, "quality-floor-2"),
      {
        constraintId: "latency-a",
        kind: "latency" as const,
        enforcement: "hard" as const,
        source: { authority: "planning" as const },
        payload: { maxLatencyMs: 6000 },
      },
      {
        constraintId: "latency-b",
        kind: "latency" as const,
        enforcement: "hard" as const,
        source: { authority: "planning" as const },
        payload: { maxLatencyMs: 4000 },
      },
    ]);
    expect(derived.constraints.minQuality).toBe(0.9);
    expect(derived.constraints.maxTotalLatencyMs).toBe(4000);
  });

  test("SOFT constraints are recorded, never floors (the foundation discipline)", () => {
    const derived = deriveSelectionConstraints([
      qualityConstraint(0.8),
      {
        constraintId: "soft-latency",
        kind: "latency" as const,
        enforcement: "soft" as const,
        source: { authority: "planning" as const },
        payload: { maxLatencyMs: 100 },
      },
    ]);
    expect(derived.constraints.maxTotalLatencyMs).toBeUndefined();
    expect(derived.sourceConstraintIds).toEqual(["quality-floor"]);
  });

  test("NO hard quality floor is a typed rejection (unprovenanced selection)", () => {
    expect(() =>
      deriveSelectionConstraints([
        {
          constraintId: "latency-only",
          kind: "latency" as const,
          enforcement: "hard" as const,
          source: { authority: "planning" as const },
          payload: { maxLatencyMs: 5000 },
        },
      ]),
    ).toThrow(SubstrateEconomicsError);
  });

  test("the derived constraints drive the selection (the seam ride)", () => {
    const derived = deriveSelectionConstraints([qualityConstraint(0.85)]);
    const result = selectSubstrate(
      selectionInput(corpus(), derived.constraints, {
        sourceConstraintIds: derived.sourceConstraintIds,
      }),
      digest,
    );
    expect(result.selected?.substrateId).toBe("mid-container-b");
    expect(result.record.sourceConstraintIds).toEqual(["quality-floor"]);
  });
});

describe("selection: input validation", () => {
  test("malformed constraints are typed rejections", () => {
    for (const constraints of [
      { minQuality: 1.5 },
      { minQuality: -0.1 },
      { minQuality: "high" },
      { minQuality: 0.8, minReliability: 0 },
      { minQuality: 0.8, maxTotalLatencyMs: -5 },
      { minQuality: 0.8, requiredIsolation: "kube-pod" },
      { minQuality: 0.8, maxExpectedCostMicroUsd: "10.5" },
    ]) {
      expect(() =>
        selectSubstrate({ candidates: [], constraints, recordedAt: RECORDED_AT }, digest),
      ).toThrow(SubstrateEconomicsError);
    }
  });

  test("a missing recordedAt is rejected (no ambient clock)", () => {
    expect(() =>
      selectSubstrate({ candidates: [], constraints: { minQuality: 0.8 }, recordedAt: "" }, digest),
    ).toThrow(SubstrateEconomicsError);
  });

  test("candidate identity collisions are rejected", () => {
    const a = descriptor({});
    const b = descriptor({});
    expect(() =>
      selectSubstrate(
        { candidates: [a, b], constraints: { minQuality: 0.8 }, recordedAt: RECORDED_AT },
        digest,
      ),
    ).toThrow(SubstrateEconomicsError);
  });
});
