/**
 * Service-class selection hook unit tests (WORK-053): hooks only —
 * the typed `unsupported` outcome when the substrate declares no
 * classes, the least-expensive-sufficient economics over the declared
 * corpus, the cheaper-class tie-break, and determinism.
 */

import { describe, expect, test } from "vitest";
import {
  SERVICE_CLASS_SELECTION_BASIS,
  selectServiceClass,
} from "../../../../src/platform/model-economics/service-class";
import type { ServiceClassCandidate } from "../../../../src/platform/model-economics/vocabulary";
import { claim, constraints, governedIr } from "./world";

function tier(
  candidateId: string,
  serviceClass: ServiceClassCandidate["serviceClass"],
  input: {
    readonly cost: string;
    readonly latency: number;
    readonly quality: number;
    readonly reliability: number;
  },
): ServiceClassCandidate {
  return {
    candidateId,
    serviceClass,
    representationClass: "sufficient-model",
    claim: claim(input),
  };
}

const CORPUS = [
  tier("tier-economy", "economy", { cost: "100", latency: 3000, quality: 0.92, reliability: 1 }),
  tier("tier-standard", "standard", { cost: "400", latency: 2000, quality: 0.95, reliability: 1 }),
  tier("tier-priority", "priority", { cost: "900", latency: 500, quality: 0.97, reliability: 1 }),
];

describe("the service-class selection hook (hooks only)", () => {
  test("a substrate with no declared classes is the TYPED unsupported outcome (never a default)", () => {
    const selection = selectServiceClass({
      declaredClasses: [],
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
    });
    expect(selection.kind).toBe("unsupported");
    expect(selection.selected).toBeNull();
    expect(selection.facts).toBeNull();
    expect(selection.verdicts).toEqual([]);
    expect(selection.selectionBasis).toBe(SERVICE_CLASS_SELECTION_BASIS);
  });

  test("selects the least expensive SUFFICIENT declared class", () => {
    const selection = selectServiceClass({
      declaredClasses: CORPUS,
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
    });
    expect(selection.kind).toBe("selected");
    expect(selection.selected?.candidateId).toBe("tier-economy");
    expect(selection.selected?.serviceClass).toBe("economy");
    expect(selection.facts?.qualityFloor).toBe(0.9);
  });

  test("the assurance floor is inviolable: a cheap below-floor tier is inadmissible", () => {
    const selection = selectServiceClass({
      declaredClasses: [
        tier("tier-economy-bad", "economy", {
          cost: "50",
          latency: 3000,
          quality: 0.87,
          reliability: 1,
        }),
        ...CORPUS.slice(1),
      ],
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
    });
    expect(selection.selected?.candidateId).toBe("tier-standard");
    expect(
      selection.verdicts.find((verdict) => verdict.candidateId === "tier-economy-bad")
        ?.inadmissibleCode,
    ).toBe("quality-below-assurance");
  });

  test("cost ties break toward the CHEAPER service class (economy < standard < priority)", () => {
    const selection = selectServiceClass({
      declaredClasses: [
        tier("tier-priority-tie", "priority", {
          cost: "400",
          latency: 2000,
          quality: 0.95,
          reliability: 1,
        }),
        tier("tier-standard-tie", "standard", {
          cost: "400",
          latency: 2000,
          quality: 0.95,
          reliability: 1,
        }),
      ],
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
    });
    expect(selection.selected?.serviceClass).toBe("standard");
    expect(selection.verdicts.map((verdict) => verdict.serviceClass)).toEqual([
      "standard",
      "priority",
    ]);
  });

  test("no admissible class is the typed outcome", () => {
    const selection = selectServiceClass({
      declaredClasses: [
        tier("tier-economy", "economy", {
          cost: "100",
          latency: 3000,
          quality: 0.8,
          reliability: 1,
        }),
      ],
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
    });
    expect(selection.kind).toBe("no-admissible-candidate");
    expect(selection.selected).toBeNull();
  });

  test("determinism: identical inputs produce the identical hook decision", () => {
    const input = {
      declaredClasses: CORPUS,
      qualityFacts: { requiredQuality: 0.9 },
      constraints: constraints(),
    };
    expect(selectServiceClass(input)).toEqual(selectServiceClass(input));
    // The hook decision is independent of the governed IR identity
    // (a substrate-level selection; the IR is the record's
    // provenance, not a selection fact).
    expect(input.declaredClasses).toHaveLength(3);
    expect(governedIr().steps).toHaveLength(3);
  });
});
