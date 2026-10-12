/**
 * Supply-retry wiring unit suite (ACR-008 §6 / PCR-002): the traced
 * one-failover-retry posture as the typed decision core — the
 * default-off posture table, the plan-composition branch behind the
 * explicit plan mode (composed through the EXISTING composer, recorded
 * through the EXISTING WORK-049 seam), and the fail-closed
 * preconditions.
 */

import { describe, expect, test } from "vitest";
import { validateOptimizationDecision } from "../../../../src/platform/execution-ir/decision-record";
import { FailureRecoveryError } from "../../../../src/platform/failure-recovery/catalog";
import type { RecoveryFacts } from "../../../../src/platform/failure-recovery/strategy";
import {
  decideSupplyRetry,
  type SupplyPlanCompositionInput,
} from "../../../../src/platform/failure-recovery/supply-retry";
import {
  APPLICATION_ID,
  claim,
  constraints,
  digest,
  EXECUTION_ID,
  governedIr,
  infraAttribution,
  providerRerouteFacts,
  RECORDED_AT,
  TENANT_ID,
} from "./world";

const TRACED_POSTURE = {
  maxRetryAttempts: 1,
  escalationEvidenceBound: 8,
  continuationStepBound: 32,
};

const PLAN_CONFIGURATION = {
  maxRetryAttempts: 3,
  escalationEvidenceBound: 8,
  continuationStepBound: 32,
  maxPlanSteps: 4,
  planMode: "on" as const,
};

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

function planFacts(attemptsUsed: number): RecoveryFacts {
  return {
    retry: {
      nextAttempt: attemptsUsed + 1,
      claim: claim("400", 2000, 0.92, 0.95, "recovery:retry-path"),
    },
    reroute: {
      model: null,
      substrate: null,
      provider: providerRerouteFacts(constraints()),
    },
    escalation: null,
  };
}

function planInput(
  overrides: Partial<SupplyPlanCompositionInput> = {},
): SupplyPlanCompositionInput {
  return {
    frames: [
      {
        attribution: infraAttribution(),
        context: {
          executionId: EXECUTION_ID,
          stepId: "generate",
          attemptsUsed: 1,
          incumbentRoute: { provider: "rail-a", model: "model-x" },
        },
        facts: planFacts(1),
      },
    ],
    qualityFacts: { requiredQuality: 0.85 },
    constraints: constraints(),
    decision: {
      ir: governedIr(),
      scope: {
        applicationId: APPLICATION_ID,
        tenantId: TENANT_ID,
        executionId: EXECUTION_ID,
        recordedAt: RECORDED_AT,
      },
    },
    digest,
    ...overrides,
  };
}

describe("the traced supply retry/failover decision core (ACR-008 §6 — PCR-002)", () => {
  test("plan mode DEFAULT OFF (absent) is the traced posture: one retry, only on a retryable first-attempt provider failure", () => {
    const retryable = decideSupplyRetry({
      attemptsUsed: 1,
      lastOutcome: { kind: "provider-failure", retryable: true },
      configuration: TRACED_POSTURE,
    });
    expect(retryable).toEqual({ kind: "retry-once-next-supply" });
    const nonRetryable = decideSupplyRetry({
      attemptsUsed: 1,
      lastOutcome: { kind: "provider-failure", retryable: false },
      configuration: TRACED_POSTURE,
    });
    expect(nonRetryable).toEqual({ kind: "no-retry" });
    const success = decideSupplyRetry({
      attemptsUsed: 1,
      lastOutcome: { kind: "provider-success", retryable: false },
      configuration: TRACED_POSTURE,
    });
    expect(success).toEqual({ kind: "no-retry" });
    const secondAttempt = decideSupplyRetry({
      attemptsUsed: 2,
      lastOutcome: { kind: "provider-failure", retryable: true },
      configuration: TRACED_POSTURE,
    });
    expect(secondAttempt).toEqual({ kind: "no-retry" });
    // The explicit `off` is byte-identical to the absent default.
    const explicitOff = decideSupplyRetry({
      attemptsUsed: 1,
      lastOutcome: { kind: "provider-failure", retryable: true },
      configuration: { ...TRACED_POSTURE, planMode: "off" },
    });
    expect(JSON.stringify(explicitOff)).toBe(JSON.stringify(retryable));
  });

  test("plan mode ON with a RESOLVED dispatch composes nothing (no recovery exists for a success)", () => {
    const decision = decideSupplyRetry({
      attemptsUsed: 1,
      lastOutcome: { kind: "provider-success", retryable: false },
      configuration: PLAN_CONFIGURATION,
      // No plan input is required — a resolved dispatch has no
      // recovery to compose (plan mode governs failure recovery only).
    });
    expect(decision).toEqual({ kind: "no-retry" });
  });

  test("plan mode ON composes the bounded plan through the EXISTING composer", () => {
    const decision = decideSupplyRetry({
      attemptsUsed: 1,
      lastOutcome: { kind: "provider-failure", retryable: true },
      configuration: PLAN_CONFIGURATION,
      plan: planInput(),
    });
    expect(decision.kind).toBe("execute-plan");
    if (decision.kind !== "execute-plan") {
      throw new Error("unreachable");
    }
    // The plan is the PCR-001 artifact: bounded steps, every selection
    // recover, the typed terminal, the content address.
    expect(decision.plan.steps.length).toBeGreaterThan(0);
    expect(decision.plan.steps.length).toBeLessThanOrEqual(PLAN_CONFIGURATION.maxPlanSteps);
    expect(decision.plan.steps[0]?.selection.kind).toBe("recover");
    expect(decision.plan.configuration.maxPlanSteps).toBe(PLAN_CONFIGURATION.maxPlanSteps);
    expect(decision.plan.planId).toMatch(/^[0-9a-f]{64}$/);
    // The selected move is dispatch-representable at the supply seam
    // (retry or provider failover — the traced seam's own vocabulary).
    expect(["retry", "re-route"]).toContain(decision.plan.steps[0]?.move.kind);
  });

  test("every composed plan step's decision is recorded through the EXISTING WORK-049 seam (valid append-only values)", () => {
    const decision = decideSupplyRetry({
      attemptsUsed: 1,
      lastOutcome: { kind: "provider-failure", retryable: true },
      configuration: PLAN_CONFIGURATION,
      plan: planInput(),
    });
    if (decision.kind !== "execute-plan") {
      throw new Error("unreachable");
    }
    expect(decision.decisionRecords).toHaveLength(decision.plan.steps.length);
    for (const record of decision.decisionRecords) {
      // The foundation's OWN total validation accepts every record —
      // these are real WORK-049 values, never a parallel shape.
      const validated = validateOptimizationDecision(record, digest);
      expect(validated.applicationId).toBe(APPLICATION_ID);
      expect(validated.tenantId).toBe(TENANT_ID);
      expect(validated.transformationBasis.detail).toContain("failure-recovery");
    }
  });

  test("the decision records carry the measured provenance when the frames consumed measured facts", () => {
    const measured = {
      routes: [
        {
          route: { provider: "rail-b", model: "model-x" },
          measuredSuccessRate: 0.97,
          latencySummary: { p50Ms: 120, p95Ms: 400 },
          cooldown: { active: false as const },
          basis: {
            sourceObservationId: "recovery-observer-1",
            windowStart: "2026-10-01T00:00:00.000Z",
            windowEnd: "2026-10-08T00:00:00.000Z",
            sampleCount: 900,
          },
        },
      ],
    };
    const withMeasured = decideSupplyRetry({
      attemptsUsed: 1,
      lastOutcome: { kind: "provider-failure", retryable: true },
      configuration: PLAN_CONFIGURATION,
      plan: planInput({
        frames: [
          {
            attribution: infraAttribution(),
            context: {
              executionId: EXECUTION_ID,
              stepId: "generate",
              attemptsUsed: 1,
              incumbentRoute: { provider: "rail-a", model: "model-x" },
            },
            facts: planFacts(1),
            measured,
          },
        ],
      }),
    });
    if (withMeasured.kind !== "execute-plan") {
      throw new Error("unreachable");
    }
    // The per-step selection consumed the measured facts: the
    // provenance rides the selection AND every decision record.
    expect(withMeasured.plan.steps[0]?.selection.measuredProvenance).toBeDefined();
    for (const record of withMeasured.decisionRecords) {
      expect(record.transformationBasis.detail).toContain(";measured=measured;");
    }
    // And WITHOUT measured facts the records carry no measured
    // provenance (the declared-only record form).
    const declaredOnly = decideSupplyRetry({
      attemptsUsed: 1,
      lastOutcome: { kind: "provider-failure", retryable: true },
      configuration: PLAN_CONFIGURATION,
      plan: planInput(),
    });
    if (declaredOnly.kind !== "execute-plan") {
      throw new Error("unreachable");
    }
    for (const record of declaredOnly.decisionRecords) {
      expect(record.transformationBasis.detail).not.toContain(";measured=");
    }
  });

  test("determinism: the same plan inputs compose the byte-identical plan and records", () => {
    const first = decideSupplyRetry({
      attemptsUsed: 1,
      lastOutcome: { kind: "provider-failure", retryable: true },
      configuration: PLAN_CONFIGURATION,
      plan: planInput(),
    });
    const second = decideSupplyRetry({
      attemptsUsed: 1,
      lastOutcome: { kind: "provider-failure", retryable: true },
      configuration: PLAN_CONFIGURATION,
      plan: planInput(),
    });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  test("fail-closed: plan mode ON without its explicit inputs (never a silent default posture)", () => {
    expectReject("supply-retry-shape", () =>
      decideSupplyRetry({
        attemptsUsed: 1,
        lastOutcome: { kind: "provider-failure", retryable: true },
        configuration: PLAN_CONFIGURATION,
      }),
    );
    // Without the plan step bound the composition cannot run — the
    // bound is never ambient, never self-raised.
    expectReject("supply-retry-shape", () =>
      decideSupplyRetry({
        attemptsUsed: 1,
        lastOutcome: { kind: "provider-failure", retryable: true },
        configuration: {
          maxRetryAttempts: 3,
          escalationEvidenceBound: 8,
          continuationStepBound: 32,
          planMode: "on",
        },
        plan: planInput(),
      }),
    );
  });

  test("fail-closed: malformed outcome mirrors and attempt counts (typed rejections)", () => {
    expectReject("supply-retry-shape", () =>
      decideSupplyRetry({
        attemptsUsed: 0,
        lastOutcome: { kind: "provider-failure", retryable: true },
        configuration: TRACED_POSTURE,
      }),
    );
    expectReject("supply-retry-shape", () =>
      decideSupplyRetry({
        attemptsUsed: 11,
        lastOutcome: { kind: "provider-failure", retryable: true },
        configuration: TRACED_POSTURE,
      }),
    );
    expectReject("supply-retry-shape", () =>
      decideSupplyRetry({
        attemptsUsed: 1,
        lastOutcome: { kind: "provider-success", retryable: true },
        configuration: TRACED_POSTURE,
      }),
    );
    expectReject("supply-retry-shape", () =>
      decideSupplyRetry({
        attemptsUsed: 1,
        lastOutcome: { kind: "provider-failure" },
        configuration: TRACED_POSTURE,
      } as never),
    );
    expectReject("supply-retry-shape", () =>
      decideSupplyRetry({
        attemptsUsed: 1,
        lastOutcome: { kind: "edge-failure", retryable: false },
        configuration: TRACED_POSTURE,
      } as never),
    );
  });
});
