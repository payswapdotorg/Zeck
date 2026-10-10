/**
 * PPR-027 hermetic tests — the synthetic supply transport: determinism,
 * arm-agnosticism, the declared fault model and the price schedule.
 * Pure-hash verification; no sleeping, no live network.
 */

import { describe, expect, it } from "vitest";
import {
  edgeOf,
  PRICE_SCHEDULE,
  requestCostNanoUsd,
  SUBJECTS,
  SUPPLY_PROFILES,
  type SubjectDefinition,
} from "../config";
import {
  createSyntheticSupply,
  drawnFault,
  drawnLatencyMs,
  outcomeOf,
  type SupplyDispatchRequest,
} from "../transport";

function browserUseSubject(): SubjectDefinition {
  const subject = SUBJECTS.find((s): s is SubjectDefinition => s.subjectId === "browser-use");
  if (subject === undefined) {
    throw new Error("browser-use must be configured");
  }
  return subject;
}

function dispatchOf(overrides: Partial<SupplyDispatchRequest>): SupplyDispatchRequest {
  const subject = browserUseSubject();
  const edge = edgeOf(subject, "browseruse.agent-loop.main");
  return {
    providerId: "supply-a",
    edge,
    request: { edgeId: edge.edgeId, inputTokens: 1000, outputTokens: 100 },
    streamKey: "test-cell:test-task:i0",
    attempt: 1,
    ...overrides,
  };
}

describe("the synthetic supply's determinism", () => {
  it("draws identical outcomes for identical dispatch identities", () => {
    const dispatch = dispatchOf({});
    expect(outcomeOf(dispatch)).toEqual(outcomeOf(dispatchOf({})));
    expect(drawnFault(dispatchOf({}))).toEqual(drawnFault(dispatchOf({})));
    expect(drawnLatencyMs(dispatchOf({}))).toBe(drawnLatencyMs(dispatchOf({})));
  });

  it("draws independently for distinct attempts (a retry sees fresh behavior)", () => {
    const first = outcomeOf(dispatchOf({ attempt: 1 }));
    const second = outcomeOf(dispatchOf({ attempt: 2 }));
    // Not asserting inequality of the whole outcome (a hash could collide
    // into the same class) — asserting the draw SPACE differs by identity:
    // the same stream key with a different attempt is a different draw.
    expect(drawnLatencyMs(dispatchOf({ attempt: 1 }))).not.toBe(
      drawnLatencyMs(dispatchOf({ attempt: 2 })),
    );
    void first;
    void second;
  });

  it("is arm-agnostic: the transport cannot know which arm is calling", async () => {
    const transport = createSyntheticSupply({ sleeper: async () => undefined });
    // Only request attributes are passed — no arm identifier exists in the
    // dispatch shape by construction.
    const dispatch = dispatchOf({});
    const outcome = await transport.dispatch(dispatch);
    expect(outcome).toEqual(outcomeOf(dispatch));
  });
});

describe("the declared fault model", () => {
  it("keeps every supply's fault draw rates within the declared per-myriad bands", () => {
    for (const profile of SUPPLY_PROFILES) {
      const samples = 4000;
      let faults = 0;
      for (let index = 0; index < samples; index += 1) {
        const dispatch = dispatchOf({
          providerId: profile.providerId,
          streamKey: `fault-sweep:${profile.providerId}:i${index}`,
        });
        if (drawnFault(dispatch) !== null) {
          faults += 1;
        }
      }
      const declared =
        (profile.rateLimitFaultPermyriad +
          profile.timeoutFaultPermyriad +
          profile.unavailableFaultPermyriad) /
        10_000;
      const observed = faults / samples;
      // A generous ±25% relative band (hash draws are uniform; 4000 samples
      // put the 99% binomial band well inside it).
      expect(observed).toBeGreaterThan(declared * 0.75);
      expect(observed).toBeLessThan(declared * 1.25);
    }
  });

  it("marks rate-limit and timeout retryable, provider-unavailable fatal", () => {
    const categories = new Set<string>();
    for (let index = 0; index < 2000 && categories.size < 3; index += 1) {
      const fault = drawnFault(dispatchOf({ streamKey: `category-sweep:i${index}` }));
      if (fault !== null) {
        categories.add(fault.category);
        if (fault.category === "provider-unavailable") {
          expect(fault.retryable).toBe(false);
        } else {
          expect(fault.retryable).toBe(true);
        }
      }
    }
    expect(categories.size).toBe(3);
  });

  it("charges input tokens on timeout faults and nothing on the other fault classes", () => {
    let sawTimeout = false;
    let sawOther = false;
    for (let index = 0; index < 4000 && !(sawTimeout && sawOther); index += 1) {
      const outcome = outcomeOf(dispatchOf({ streamKey: `cost-sweep:i${index}` }));
      if (!outcome.ok && outcome.category === "timeout") {
        sawTimeout = true;
        expect(outcome.costNanoUsd).toBe(
          Math.round(1000 * PRICE_SCHEDULE.perTokenNanoUsd.text.input),
        );
        expect(outcome.usage.inputTokens).toBe(1000);
      }
      if (!outcome.ok && outcome.category !== "timeout") {
        sawOther = true;
        expect(outcome.costNanoUsd).toBe(0);
        expect(outcome.usage.inputTokens).toBe(0);
      }
    }
    expect(sawTimeout).toBe(true);
    expect(sawOther).toBe(true);
  });
});

describe("the declared price schedule", () => {
  it("prices text per token and media surfaces per call", () => {
    const subject = browserUseSubject();
    const textEdge = edgeOf(subject, "browseruse.agent-loop.main");
    const substrateEdge = edgeOf(subject, "browseruse.substrate.session");
    expect(
      requestCostNanoUsd(
        { edgeId: textEdge.edgeId, inputTokens: 1000, outputTokens: 100 },
        textEdge,
      ),
    ).toBe(
      1000 * PRICE_SCHEDULE.perTokenNanoUsd.text.input +
        100 * PRICE_SCHEDULE.perTokenNanoUsd.text.output,
    );
    expect(
      requestCostNanoUsd(
        { edgeId: substrateEdge.edgeId, inputTokens: 0, outputTokens: 0 },
        substrateEdge,
      ),
    ).toBe(PRICE_SCHEDULE.perCallNanoUsd.substrate);
  });
});
