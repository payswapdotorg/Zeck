/**
 * Recovery-plan unit suite (ACR-008 §2 / PCR-001): the bounded,
 * typed, content-addressed plan artifact — the configuration's
 * mandatory step bound, the composition through the EXISTING
 * selection seam, the honest typed terminals (fail-closed /
 * bound-reached / frames-exhausted), determinism and prefix
 * stability, and the total read-time validation (tamper detection,
 * unknown-move fail-closed, step contiguity, bound enforcement).
 */

import { describe, expect, test } from "vitest";
import { FailureRecoveryError } from "../../../../src/platform/failure-recovery/catalog";
import {
  composeRecoveryPlan,
  type RecoveryPlanConfiguration,
  type RecoveryPlanStepFrame,
  recoveryMoveOf,
  validateRecoveryPlan,
} from "../../../../src/platform/failure-recovery/plan";
import type { RecoveryFacts } from "../../../../src/platform/failure-recovery/strategy";
import {
  claim,
  constraints,
  digest,
  infraAttribution,
  intelligenceAttribution,
  modelRerouteFacts,
  substrateRerouteFacts,
} from "./world";

const PLAN_CONFIGURATION: RecoveryPlanConfiguration = {
  maxRetryAttempts: 3,
  escalationEvidenceBound: 8,
  continuationStepBound: 32,
  maxPlanSteps: 4,
};

function retryFacts(): RecoveryFacts {
  return {
    retry: { nextAttempt: 1, claim: claim("400", 2000, 0.92, 0.95, "recovery:retry-path") },
    reroute: { model: null, substrate: null },
    escalation: null,
  };
}

function emptyFacts(): RecoveryFacts {
  return { retry: null, reroute: { model: null, substrate: null }, escalation: null };
}

function fullFacts(): RecoveryFacts {
  return {
    retry: { nextAttempt: 1, claim: claim("400", 2000, 0.92, 0.95, "recovery:retry-path") },
    reroute: {
      model: modelRerouteFacts(constraints()),
      substrate: { selection: substrateRerouteFacts(constraints()) },
    },
    escalation: null,
  };
}

function frame(
  attribution: Parameters<typeof composeRecoveryPlan>[0]["frames"][number]["attribution"],
  facts: RecoveryFacts,
  attemptsUsed = 0,
): RecoveryPlanStepFrame {
  return {
    attribution,
    context: {
      executionId: "00000000-0000-7000-8000-0000000000cc",
      stepId: "generate",
      attemptsUsed,
      incumbentRoute: { provider: "rail-a", model: "model-x" },
    },
    facts,
  };
}

function compose(frames: readonly RecoveryPlanStepFrame[], configuration = PLAN_CONFIGURATION) {
  return composeRecoveryPlan({
    frames,
    qualityFacts: { requiredQuality: 0.85 },
    constraints: constraints(),
    configuration,
    digest,
  });
}

function expectReject(invariant: string, fn: () => unknown): FailureRecoveryError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(FailureRecoveryError);
    const typed = error as FailureRecoveryError;
    expect(typed.invariant).toBe(invariant);
    return typed;
  }
  throw new Error("expected a typed rejection");
}

describe("recovery plans (ACR-008 / PCR-001)", () => {
  // --- The configuration: the bound rides the configuration ----------
  test("the plan bound is MANDATORY (never ambient, never defaulted)", () => {
    expectReject("plan-shape", () =>
      compose([frame(infraAttribution(), retryFacts())], {
        maxRetryAttempts: 3,
        escalationEvidenceBound: 8,
        continuationStepBound: 32,
      } as never),
    );
  });

  test("the plan bound is validated against its hard ceiling [1, 16]", () => {
    for (const maxPlanSteps of [0, -1, 17, 1.5, Number.NaN]) {
      expectReject("plan-shape", () =>
        compose([frame(infraAttribution(), retryFacts())], {
          ...PLAN_CONFIGURATION,
          maxPlanSteps,
        }),
      );
    }
  });

  // --- The composition: bounded sequencing through the existing seam --
  test("a plan requires at least one frame (absent per-step inputs fail closed)", () => {
    expectReject("plan-shape", () => compose([]));
    expectReject("plan-shape", () => compose([null as never]));
    expectReject("plan-shape", () =>
      compose([{ ...frame(infraAttribution(), retryFacts()), facts: undefined } as never]),
    );
  });

  test("a frame set over the configured bound is a typed rejection (bound enforcement)", () => {
    const error = expectReject("plan-shape", () =>
      compose([
        frame(infraAttribution(), retryFacts()),
        frame(infraAttribution(), retryFacts()),
        frame(infraAttribution(), retryFacts()),
        frame(infraAttribution(), retryFacts()),
        frame(infraAttribution(), retryFacts()),
      ]),
    );
    expect(error.details.frames).toBe(5);
    expect(error.details.maxPlanSteps).toBe(4);
    // Exactly at the bound is admissible.
    expect(() =>
      compose([
        frame(infraAttribution(), retryFacts()),
        frame(infraAttribution(), retryFacts()),
        frame(infraAttribution(), retryFacts()),
        frame(infraAttribution(), retryFacts()),
      ]),
    ).not.toThrow();
  });

  test("a single recover frame composes one step with its derived move (frames-exhausted)", () => {
    const plan = compose([frame(infraAttribution(), retryFacts())]);
    expect(plan.planId).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.stepIndex).toBe(0);
    expect(plan.steps[0]?.move).toEqual({ kind: "retry" });
    expect(plan.steps[0]?.selection.kind).toBe("recover");
    expect(plan.steps[0]?.selection.selected?.candidateId).toBe("retry-attempt-1");
    expect(plan.steps[0]?.selection.selectionBasis).toContain("fail-closed-when-none-admissible");
    expect(plan.terminal).toEqual({ kind: "frames-exhausted" });
    // The plan carries its root failure and its governing frame.
    expect(plan.failure.attributionId).toBe(plan.steps[0]?.attribution.attributionId);
    expect(plan.planBasis).toContain("per-step-selection-through-existing-strategy-seam");
  });

  test("every step's selection IS the existing seam's result (the composer never selects)", () => {
    const plan = compose([frame(infraAttribution(), fullFacts())]);
    expect(plan.steps[0]?.selection.selected?.strategy).toBe("re-route");
    expect(plan.steps[0]?.selection.selected?.rerouteDimension).toBe("substrate");
    expect(plan.steps[0]?.move).toEqual({ kind: "re-route", dimension: "substrate" });
    // The step carries its selection inputs (attribution, context, facts).
    expect(plan.steps[0]?.attribution.attributionId).toBe(
      plan.steps[0]?.selection.selected?.attributionId,
    );
    expect(plan.steps[0]?.context.attemptsUsed).toBe(0);
    expect(plan.steps[0]?.facts.retry?.nextAttempt).toBe(1);
  });

  test("the fail-closed frame terminates the plan with the selection's typed reason", () => {
    const plan = compose([
      frame(infraAttribution(), retryFacts()),
      frame(intelligenceAttribution(), retryFacts()),
      frame(infraAttribution(), retryFacts()),
    ]);
    // Frame 1 is an intelligence failure with only a retry fact: no
    // admissible move remains → the honest terminal failure.
    expect(plan.steps).toHaveLength(1);
    expect(plan.terminal.kind).toBe("fail-closed");
    if (plan.terminal.kind === "fail-closed") {
      expect(plan.terminal.failClosedCode).toBe("no-admissible-strategy");
      expect(plan.terminal.stepIndex).toBe(1);
      expect(plan.terminal.remainingFrames).toBe(1);
      expect(plan.terminal.selection.kind).toBe("fail-closed");
      expect(plan.terminal.attributionId).toBe(intelligenceAttribution().attributionId);
    }
  });

  test("the bound-reached terminal: all frames recover and the last consumes the bound", () => {
    const plan = compose(
      [frame(infraAttribution(), retryFacts()), frame(infraAttribution(), retryFacts())],
      { ...PLAN_CONFIGURATION, maxPlanSteps: 2 },
    );
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps.map((step) => step.stepIndex)).toEqual([0, 1]);
    expect(plan.terminal).toEqual({ kind: "bound-reached" });
  });

  test("the zero-move frame set fails the whole plan closed (no admissible move anywhere)", () => {
    const plan = compose([frame(intelligenceAttribution(), emptyFacts())]);
    expect(plan.steps).toHaveLength(0);
    expect(plan.terminal.kind).toBe("fail-closed");
    if (plan.terminal.kind === "fail-closed") {
      expect(plan.terminal.failClosedCode).toBe("no-admissible-strategy");
      expect(plan.terminal.stepIndex).toBe(0);
      expect(plan.terminal.remainingFrames).toBe(0);
    }
  });

  // --- Determinism, content addressing, idempotent re-run -------------
  test("identical frames compose byte-identical plans (idempotent re-run)", () => {
    const first = compose([
      frame(infraAttribution(), fullFacts()),
      frame(infraAttribution(), retryFacts()),
    ]);
    const second = compose([
      frame(infraAttribution(), fullFacts()),
      frame(infraAttribution(), retryFacts()),
    ]);
    expect(first.planId).toBe(second.planId);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test("a mutated frame yields a different content address (drift-visible, never silent)", () => {
    const base = compose([frame(infraAttribution(), retryFacts())]);
    const mutated = compose([
      frame(infraAttribution(), {
        ...retryFacts(),
        retry: { nextAttempt: 1, claim: claim("500", 2000, 0.92, 0.95, "recovery:retry-path") },
      }),
    ]);
    expect(mutated.planId).not.toBe(base.planId);
  });

  test("prefix stability: extending the frame set extends the plan, never rewrites it", () => {
    const short = compose([frame(infraAttribution(), retryFacts())]);
    const extended = compose([
      frame(infraAttribution(), retryFacts()),
      frame(infraAttribution(), fullFacts()),
    ]);
    expect(extended.steps).toHaveLength(2);
    expect(JSON.stringify(extended.steps[0])).toBe(JSON.stringify(short.steps[0]));
    expect(extended.planId).not.toBe(short.planId);
    // Re-running the short composition is byte-stable (idempotence).
    expect(JSON.stringify(compose([frame(infraAttribution(), retryFacts())]))).toBe(
      JSON.stringify(short),
    );
  });

  test("a changed bound is drift-visible (the configuration rides the content address)", () => {
    const first = compose([frame(infraAttribution(), retryFacts())], {
      ...PLAN_CONFIGURATION,
      maxPlanSteps: 2,
    });
    const second = compose([frame(infraAttribution(), retryFacts())], {
      ...PLAN_CONFIGURATION,
      maxPlanSteps: 3,
    });
    expect(first.terminal).toEqual({ kind: "frames-exhausted" });
    expect(second.terminal).toEqual({ kind: "frames-exhausted" });
    expect(first.planId).not.toBe(second.planId);
  });

  // --- The move derivation (closed vocabulary, fail-closed) -----------
  test("recoveryMoveOf maps every closed strategy and fails closed on the unknown", () => {
    const verdictOf = (strategy: string, dimension?: string) =>
      ({ strategy, ...(dimension === undefined ? {} : { rerouteDimension: dimension }) }) as never;
    expect(recoveryMoveOf(verdictOf("retry"))).toEqual({ kind: "retry" });
    expect(recoveryMoveOf(verdictOf("re-route", "model"))).toEqual({
      kind: "re-route",
      dimension: "model",
    });
    expect(recoveryMoveOf(verdictOf("re-route", "provider"))).toEqual({
      kind: "re-route",
      dimension: "provider",
    });
    expect(recoveryMoveOf(verdictOf("escalate-fresh"))).toEqual({ kind: "escalate-fresh" });
    expect(recoveryMoveOf(verdictOf("context-repair"))).toEqual({ kind: "context-repair" });
    expect(recoveryMoveOf(verdictOf("verifier-escalation"))).toEqual({
      kind: "verifier-escalation",
    });
    expect(recoveryMoveOf(verdictOf("fail"))).toEqual({ kind: "fail" });
    // Unknown move kinds fail closed — never a guess.
    expectReject("plan-shape", () => recoveryMoveOf(verdictOf("quantum-tunnel")));
    // A re-route verdict without its dimension fails closed.
    expectReject("plan-shape", () => recoveryMoveOf(verdictOf("re-route")));
    expectReject("plan-shape", () => recoveryMoveOf(verdictOf("re-route", "spacetime")));
  });

  // --- Read-time total validation (tamper detection) -------------------
  test("a composed plan round-trips through read-time validation", () => {
    const plan = compose([
      frame(infraAttribution(), fullFacts()),
      frame(intelligenceAttribution(), retryFacts()),
    ]);
    const roundTripped = validateRecoveryPlan(JSON.parse(JSON.stringify(plan)), digest);
    expect(roundTripped.planId).toBe(plan.planId);
    expect(JSON.stringify(roundTripped)).toBe(JSON.stringify(plan));
  });

  test("tampered identities are rejected at read time (never served)", () => {
    const plan = compose([frame(infraAttribution(), retryFacts())]);
    const forgedId = JSON.parse(JSON.stringify(plan));
    forgedId.planId = digest.sha256Hex("forged-plan");
    expectReject("plan-shape", () => validateRecoveryPlan(forgedId, digest));
    const mutatedStep = JSON.parse(JSON.stringify(plan));
    mutatedStep.steps[0].facts.retry.claim.expectedCostMicroUsd = "1";
    expectReject("plan-shape", () => validateRecoveryPlan(mutatedStep, digest));
    const foreignBasis = JSON.parse(JSON.stringify(plan));
    foreignBasis.planBasis = "not-the-frozen-basis";
    expectReject("plan-shape", () => validateRecoveryPlan(foreignBasis, digest));
  });

  test("an unknown move kind on a plan step is rejected at read time", () => {
    const plan = compose([frame(infraAttribution(), retryFacts())]);
    const unknown = JSON.parse(JSON.stringify(plan));
    unknown.steps[0].move = { kind: "warp" };
    expectReject("plan-shape", () => validateRecoveryPlan(unknown, digest));
    const dimensionless = JSON.parse(JSON.stringify(plan));
    dimensionless.steps[0].move = { kind: "re-route" };
    expectReject("plan-shape", () => validateRecoveryPlan(dimensionless, digest));
    const mismatched = JSON.parse(JSON.stringify(plan));
    mismatched.steps[0].move = { kind: "escalate-fresh" };
    expectReject("plan-shape", () => validateRecoveryPlan(mismatched, digest));
  });

  test("non-contiguous step indices are rejected at read time", () => {
    const plan = compose([
      frame(infraAttribution(), retryFacts()),
      frame(infraAttribution(), retryFacts()),
    ]);
    const gapped = JSON.parse(JSON.stringify(plan));
    gapped.steps[1].stepIndex = 7;
    expectReject("plan-shape", () => validateRecoveryPlan(gapped, digest));
  });

  test("steps over the configured bound are rejected at read time (before the digest)", () => {
    const plan = compose(
      [frame(infraAttribution(), retryFacts()), frame(infraAttribution(), retryFacts())],
      { ...PLAN_CONFIGURATION, maxPlanSteps: 2 },
    );
    const overBound = JSON.parse(JSON.stringify(plan));
    overBound.steps.push(JSON.parse(JSON.stringify(overBound.steps[1])));
    overBound.steps[2].stepIndex = 2;
    expectReject("plan-shape", () => validateRecoveryPlan(overBound, digest));
  });

  test("incoherent steps and terminals are rejected at read time", () => {
    const plan = compose([
      frame(infraAttribution(), retryFacts()),
      frame(intelligenceAttribution(), retryFacts()),
      frame(infraAttribution(), retryFacts()),
    ]);
    // A step whose selection was decided under a different attribution.
    const foreignSelection = JSON.parse(JSON.stringify(plan));
    foreignSelection.steps[0].selection.selected.attributionId = digest.sha256Hex("foreign");
    expectReject("plan-shape", () => validateRecoveryPlan(foreignSelection, digest));
    // A recover selection on a composed step is mandatory.
    const flippedStep = JSON.parse(JSON.stringify(plan));
    flippedStep.steps[0].selection.kind = "fail-closed";
    expectReject("plan-shape", () => validateRecoveryPlan(flippedStep, digest));
    // The terminal's code must be the failing selection's typed reason.
    const flippedTerminal = JSON.parse(JSON.stringify(plan));
    flippedTerminal.terminal.failClosedCode = "no-economic-justification";
    expectReject("plan-shape", () => validateRecoveryPlan(flippedTerminal, digest));
    // A terminal kind outside the closed vocabulary.
    const alienTerminal = JSON.parse(JSON.stringify(plan));
    alienTerminal.terminal.kind = "mysteriously-recovered";
    expectReject("plan-shape", () => validateRecoveryPlan(alienTerminal, digest));
  });

  test("terminal/bound coherence is enforced at read time", () => {
    // A bound-reached plan mutated to frames-exhausted is under-bound
    // incoherent (steps == maxPlanSteps but terminal says under).
    const boundPlan = compose(
      [frame(infraAttribution(), retryFacts()), frame(infraAttribution(), retryFacts())],
      { ...PLAN_CONFIGURATION, maxPlanSteps: 2 },
    );
    const mutated = JSON.parse(JSON.stringify(boundPlan));
    mutated.terminal = { kind: "frames-exhausted" };
    expectReject("plan-shape", () => validateRecoveryPlan(mutated, digest));
    // A frames-exhausted plan mutated to bound-reached must have
    // exactly maxPlanSteps steps.
    const shortPlan = compose([frame(infraAttribution(), retryFacts())]);
    const mutatedTwo = JSON.parse(JSON.stringify(shortPlan));
    mutatedTwo.terminal = { kind: "bound-reached" };
    expectReject("plan-shape", () => validateRecoveryPlan(mutatedTwo, digest));
  });

  test("non-canonicalizable plan inputs fail closed (closed JSON universe)", () => {
    const frameWithUndefinedKey = {
      ...frame(infraAttribution(), retryFacts()),
      facts: { ...retryFacts(), escalation: undefined },
    } as never;
    expectReject("plan-shape", () => compose([frameWithUndefinedKey]));
  });
});
