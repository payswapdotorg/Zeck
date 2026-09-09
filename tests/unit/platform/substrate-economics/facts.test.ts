/**
 * Unit tests: the neutral substrate facts of the substrate-economics
 * plane (WORK-054) — the closed descriptor set, explicit-basis
 * validation, bounded numbers, canonical identity.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  AVAILABILITY_MODE_RANK,
  READINESS_STATE_RANK,
  SUBSTRATE_AVAILABILITY_MODES,
  SUBSTRATE_ECONOMICS_INVARIANT_CODES,
  SUBSTRATE_INSUFFICIENCY_CODES,
  SUBSTRATE_READINESS_STATES,
  SubstrateEconomicsError,
} from "../../../../src/platform/substrate-economics/catalog";
import {
  canonicalCandidateSetJson,
  canonicalSubstrateJson,
  offeredModes,
  type SubstrateDescriptor,
  startupFactOf,
  validateSubstrateCandidateSet,
  validateSubstrateDescriptor,
} from "../../../../src/platform/substrate-economics/facts";

const digest = {
  sha256Hex: (value: string) => createHash("sha256").update(value, "utf8").digest("hex"),
};

/** A well-formed explicit-basis descriptor (the test corpus fixture). */
function baseDescriptor(): SubstrateDescriptor {
  return {
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
  };
}

describe("substrate facts: closed vocabularies", () => {
  test("the availability-mode, readiness-state and insufficiency vocabularies are closed and frozen", () => {
    expect(SUBSTRATE_AVAILABILITY_MODES).toEqual(["cold", "warm", "snapshot"]);
    expect(SUBSTRATE_READINESS_STATES).toEqual(["created", "scheduled", "started", "ready"]);
    expect(SUBSTRATE_INSUFFICIENCY_CODES).toEqual([
      "quality-below-floor",
      "reliability-below-floor",
      "latency-above-ceiling",
      "isolation-below-floor",
      "cost-above-ceiling",
      "mode-not-offered",
    ]);
  });

  test("the readiness ladder distinguishes started from ready (the research-baseline discipline)", () => {
    expect(READINESS_STATE_RANK.started).toBeLessThan(READINESS_STATE_RANK.ready);
    expect(READINESS_STATE_RANK.created).toBeLessThan(READINESS_STATE_RANK.scheduled);
  });

  test("the availability-mode rank prefers the more prepared state at equal cost", () => {
    expect(AVAILABILITY_MODE_RANK.snapshot).toBeLessThan(AVAILABILITY_MODE_RANK.warm);
    expect(AVAILABILITY_MODE_RANK.warm).toBeLessThan(AVAILABILITY_MODE_RANK.cold);
  });

  test("every invariant code in the typed error vocabulary is distinct", () => {
    expect(new Set(SUBSTRATE_ECONOMICS_INVARIANT_CODES).size).toBe(
      SUBSTRATE_ECONOMICS_INVARIANT_CODES.length,
    );
  });
});

describe("substrate facts: descriptor validation", () => {
  test("a well-formed explicit-basis descriptor validates (cold + warm + snapshot offered)", () => {
    const descriptor = validateSubstrateDescriptor(baseDescriptor());
    expect(descriptor.substrateId).toBe("std-microvm-a");
    expect(descriptor.isolation).toBe("microvm");
    expect(offeredModes(descriptor)).toEqual(["cold", "warm", "snapshot"]);
    expect(startupFactOf(descriptor, "warm").readinessMs).toBe(400);
  });

  test("warm and snapshot modes are optional (a cold-only substrate is representable)", () => {
    const input = baseDescriptor();
    const coldOnly = {
      ...input,
      startup: { cold: input.startup.cold },
    };
    const descriptor = validateSubstrateDescriptor(coldOnly);
    expect(offeredModes(descriptor)).toEqual(["cold"]);
    expect(() => startupFactOf(descriptor, "warm")).toThrow(SubstrateEconomicsError);
  });

  test("an unattributed execution claim is rejected by the WORK-049 foundation validation", () => {
    const input = baseDescriptor();
    const unattributed = {
      ...input,
      execution: { ...input.execution, basis: undefined },
    };
    expect(() => validateSubstrateDescriptor(unattributed)).toThrowError(
      expect.objectContaining({ name: "CostModelError" }),
    );
  });

  test("an unattributed startup fact is a typed rejection", () => {
    const input = baseDescriptor();
    const unattributed = {
      ...input,
      startup: {
        ...input.startup,
        warm: { readinessMs: 400, startupCostMicroUsd: "15", basis: undefined },
      },
    };
    try {
      validateSubstrateDescriptor(unattributed);
      expect.unreachable("unattributed startup fact must be rejected");
    } catch (error) {
      const typed = error as SubstrateEconomicsError;
      expect(typed.name).toBe("SubstrateEconomicsError");
      expect(typed.invariant).toBe("substrate-fact-unattributed");
    }
  });

  test("unbounded startup numbers are typed rejections", () => {
    const input = baseDescriptor();
    for (const [field, value] of [
      ["readinessMs", Number.POSITIVE_INFINITY],
      ["readinessMs", -1],
      ["startupCostMicroUsd", "1000000000000000000"],
      ["startupCostMicroUsd", "12.5"],
    ] as const) {
      const mutated = {
        ...input,
        startup: {
          ...input.startup,
          cold: { ...input.startup.cold, [field]: value },
        },
      };
      try {
        validateSubstrateDescriptor(mutated);
        expect.unreachable(`unbounded ${String(field)}=${String(value)} must be rejected`);
      } catch (error) {
        const typed = error as SubstrateEconomicsError;
        expect(typed.invariant).toBe("substrate-fact-unbounded");
      }
    }
  });

  test("an isolation class off the frozen ladder is a typed vocabulary rejection", () => {
    const input = baseDescriptor();
    const mutated = { ...input, isolation: "kubernetes-pod" };
    try {
      validateSubstrateDescriptor(mutated);
      expect.unreachable("invented isolation class must be rejected");
    } catch (error) {
      const typed = error as SubstrateEconomicsError;
      expect(typed.invariant).toBe("substrate-descriptor-vocabulary");
    }
  });

  test("malformed identity, version and adapterRef shapes are typed rejections", () => {
    const input = baseDescriptor();
    for (const mutation of [
      { substrateId: "E2B!!" },
      { substrateId: "" },
      { version: "1.2" },
      { adapterRef: "vendor://e2b" },
      { adapterRef: "" },
    ]) {
      try {
        validateSubstrateDescriptor({ ...input, ...mutation });
        expect.unreachable(`malformed ${JSON.stringify(mutation)} must be rejected`);
      } catch (error) {
        const typed = error as SubstrateEconomicsError;
        expect(typed.invariant).toBe("substrate-descriptor-shape");
      }
    }
  });

  test("secret-shaped description text is rejected before anything exists", () => {
    const input = baseDescriptor();
    const mutated = { ...input, description: "token=sk-abcdefghijklmnopqrst" };
    expect(() => validateSubstrateDescriptor(mutated)).toThrow(SubstrateEconomicsError);
  });
});

describe("substrate facts: candidate-set discipline", () => {
  test("a duplicate substrate identity in one candidate set is rejected (ambiguous selection input)", () => {
    const a = baseDescriptor();
    const same = validateSubstrateDescriptor(baseDescriptor());
    try {
      validateSubstrateCandidateSet([a, same]);
      expect.unreachable("duplicate identity must be rejected");
    } catch (error) {
      const typed = error as SubstrateEconomicsError;
      expect(typed.invariant).toBe("selection-candidate-set");
    }
  });

  test("the ZERO-candidate set is legal (zero-provider operation is representable)", () => {
    expect(validateSubstrateCandidateSet([])).toEqual([]);
  });

  test("two descriptors differing only in version are distinct candidates", () => {
    const a = baseDescriptor();
    const b = validateSubstrateDescriptor({ ...baseDescriptor(), version: "1.3.0" });
    const set = validateSubstrateCandidateSet([a, b]);
    expect(set).toHaveLength(2);
  });
});

describe("substrate facts: canonical identity", () => {
  test("the canonical form is deterministic and key-sorted (digest stability)", () => {
    const first = validateSubstrateDescriptor(baseDescriptor());
    const second = validateSubstrateDescriptor(baseDescriptor());
    expect(canonicalSubstrateJson(first)).toBe(canonicalSubstrateJson(second));
    const json = canonicalSubstrateJson(first);
    const parsed = JSON.parse(json) as Record<string, string>;
    expect(Object.keys(parsed).slice().sort()).toEqual(Object.keys(parsed));
    expect(digest.sha256Hex(json)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("reordering the candidate set does not change the canonical set identity", () => {
    const a = validateSubstrateDescriptor(baseDescriptor());
    const b = validateSubstrateDescriptor({
      ...baseDescriptor(),
      substrateId: "alt-container-b",
      isolation: "container",
    });
    const c = validateSubstrateDescriptor({
      ...baseDescriptor(),
      substrateId: "cheap-process-c",
      isolation: "process",
    });
    expect(canonicalCandidateSetJson([a, b, c])).toBe(canonicalCandidateSetJson([c, b, a]));
  });

  test("a mutated fact changes the canonical identity (content addressing)", () => {
    const a = validateSubstrateDescriptor(baseDescriptor());
    const mutated = validateSubstrateDescriptor({
      ...baseDescriptor(),
      execution: { ...baseDescriptor().execution, expectedCostMicroUsd: "401" },
    });
    expect(canonicalSubstrateJson(a)).not.toBe(canonicalSubstrateJson(mutated));
  });
});
