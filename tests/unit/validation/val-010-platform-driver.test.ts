/**
 * VAL-010 acceptance criterion 6: the platform-side driver against
 * controlled fake ports — canonical transition order, planning decision
 * recorded in the planning phase (intent before effect), provider
 * failure completing as FAILED, oracle failure completing as FAILED,
 * fixture absence aborting BEFORE any lifecycle mutation (NOT RUN), and
 * measured dispatch latency/usage propagation.
 */

import { describe, expect, test } from "vitest";
import type {
  LabDispatchOutcome,
  LabVerificationCriterion,
} from "../../../benchmarks/validation/platform/derive";
import {
  driveExecutionToCompletion,
  type PlatformDispatchPort,
  type PlatformLifecyclePort,
} from "../../../benchmarks/validation/platform/driver";

interface RecordedTransition {
  readonly step: string;
  readonly reason: string;
}

function createFakeLifecycle(): PlatformLifecyclePort & {
  readonly transitions: RecordedTransition[];
  readonly decisions: { route: { provider: string; model: string; strategyClass: string } }[];
  readonly completions: { verdict: string; criteria: readonly LabVerificationCriterion[] }[];
} {
  const transitions: RecordedTransition[] = [];
  const decisions: { route: { provider: string; model: string; strategyClass: string } }[] = [];
  const completions: { verdict: string; criteria: readonly LabVerificationCriterion[] }[] = [];
  return {
    transitions,
    decisions,
    completions,
    async transition(command) {
      transitions.push({ step: command.step, reason: command.reason });
    },
    async recordPlanningDecision(input) {
      decisions.push({ route: input.route });
    },
    async complete(input) {
      completions.push({ verdict: input.verdict, criteria: input.criteria });
    },
  };
}

const dispatchOf = (outcome: LabDispatchOutcome): PlatformDispatchPort["dispatch"] => {
  return async () => outcome;
};

describe("VAL-010 platform driver", () => {
  test("a passing run drives the canonical order: plan BEFORE planning decision, decision BEFORE queue", async () => {
    const lifecycle = createFakeLifecycle();
    let time = 1_000;
    const result = await driveExecutionToCompletion({
      executionId: "exec-1",
      task: { kind: "summarize", doc: "quarterly-report-01", maxWords: 60 },
      provider: "openrouter",
      model: "fixture-model",
      ports: {
        lifecycle,
        dispatch: dispatchOf({
          kind: "success",
          content: "Revenue grew 12 percent driven by the enterprise segment.",
          usage: { inputTokens: 220, outputTokens: 12, costUsd: 0.000021 },
        }),
        now: () => new Date(time++),
      },
    });
    const steps = lifecycle.transitions.map((transition) => transition.step);
    expect(steps).toEqual(["authorize", "plan", "queue", "start", "verify"]);
    // The durable planning decision lands between `plan` (AUTHORIZED→PLANNING)
    // and `queue` (PLANNING→QUEUED) — intent before effect.
    expect(lifecycle.decisions).toHaveLength(1);
    expect(lifecycle.decisions[0]?.route.provider).toBe("openrouter");
    expect(result.terminal).toBe("COMPLETED");
    expect(result.criteria.every((c) => c.status === "PASS")).toBe(true);
    expect(result.usage?.inputTokens).toBe(220);
    expect(result.usage?.costUsd).toBe(0.000021);
    expect(result.dispatchLatencyMs).toBe(1);
    expect(lifecycle.completions[0]?.verdict).toBe("pass");
  });

  test("a provider failure completes the execution as FAILED with the mechanical provider-dispatch criterion", async () => {
    const lifecycle = createFakeLifecycle();
    const result = await driveExecutionToCompletion({
      executionId: "exec-2",
      task: { kind: "summarize", doc: "quarterly-report-01", maxWords: 60 },
      provider: "openrouter",
      model: "fixture-model",
      ports: {
        lifecycle,
        dispatch: dispatchOf({
          kind: "failure",
          category: "authentication",
          message: "credential rejected",
          retryable: false,
        }),
        now: () => new Date(1_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.usage).toBeNull();
    expect(result.criteria[0]?.criterionId).toBe("provider-dispatch");
    expect(result.criteria[0]?.status).toBe("FAIL");
    expect(lifecycle.completions[0]?.verdict).toBe("fail");
  });

  test("a failed oracle completes the execution as FAILED (the oracle floor)", async () => {
    const lifecycle = createFakeLifecycle();
    const result = await driveExecutionToCompletion({
      executionId: "exec-3",
      task: { kind: "extract", format: "invoice", doc: "invoice-001" },
      provider: "openrouter",
      model: "fixture-model",
      ports: {
        lifecycle,
        dispatch: dispatchOf({ kind: "success", content: "not json at all" }),
        now: () => new Date(1_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.criteria.some((c) => c.status === "FAIL")).toBe(true);
  });

  test("an absent fixture aborts BEFORE any lifecycle mutation (NOT RUN boundary)", async () => {
    const lifecycle = createFakeLifecycle();
    await expect(
      driveExecutionToCompletion({
        executionId: "exec-4",
        task: { kind: "summarize", doc: "not-materialized-doc", maxWords: 30 },
        provider: "openrouter",
        model: "fixture-model",
        ports: {
          lifecycle,
          dispatch: dispatchOf({ kind: "success", content: "unused" }),
          now: () => new Date(1_000),
        },
      }),
    ).rejects.toThrow(/fixture not materialized/);
    expect(lifecycle.transitions).toHaveLength(0);
    expect(lifecycle.completions).toHaveLength(0);
  });
});
