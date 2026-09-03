/**
 * Dashboard trust-state tests (WORK-033 trust checkpoint; UX §26).
 *
 * The FOUR trust axes are derived separately from platform facts and
 * are never conflated: provider success, execution success, quality
 * success and policy success. This suite pins the honest derivation
 * table — including mutant-style assertions: a FABRICATED confidence
 * derivation would fail these pins (the mapping can only produce a
 * confidence verdict from real verification results).
 */

import { describe, expect, test } from "vitest";
import {
  deriveConfidenceChip,
  deriveExecutionAxis,
  derivePolicyAxis,
  deriveProviderAxis,
  deriveQualityAxis,
  deriveTrustAxes,
  deriveVerificationChip,
  statusRank,
} from "../../../apps/dashboard/projection";
import type { Execution, ExecutionEvent, ExecutionResult, VerificationResult } from "../../../sdk";

function executionOf(status: string): Execution {
  return {
    id: "00000000-0000-7000-8000-0000000000e1",
    applicationId: "00000000-0000-7000-8000-0000000000a1",
    environmentId: null,
    status: status as Execution["status"],
    task: { description: "Contract risk analysis" },
    constraints: null,
    metadata: {},
    createdAt: "2026-09-15T12:00:00Z",
    updatedAt: "2026-09-15T12:03:42Z",
    terminalAt: null,
  };
}

function resultOf(
  route: ExecutionResult["route"],
  verification: VerificationResult[],
): ExecutionResult {
  return {
    executionId: "00000000-0000-7000-8000-0000000000e1",
    status: "RUNNING",
    route,
    cost: null,
    usage: null,
    outputArtifacts: [],
    verification,
    warnings: [],
    terminalAt: null,
  };
}

function eventOf(type: string, sequence = 1): ExecutionEvent {
  return {
    eventId: `ev-${sequence}`,
    executionId: "00000000-0000-7000-8000-0000000000e1",
    type,
    sequence,
    occurredAt: "2026-09-15T12:00:00Z",
    payload: {},
  };
}

function checkOf(status: string, confidence: number | null): VerificationResult {
  return {
    id: `v-${status}-${confidence}`,
    executionId: "00000000-0000-7000-8000-0000000000e1",
    criterionId: "criterion-1",
    strategy: "digest",
    status: status as VerificationResult["status"],
    confidence,
    evaluator: { kind: "check", id: "e", version: "1" },
    evidenceRefs: [],
    recordedAt: "2026-09-15T12:03:41Z",
  };
}

describe("provider success axis (never claims more than the route records)", () => {
  test("a null route renders 'No route recorded yet'", () => {
    expect(deriveProviderAxis(resultOf(null, [])).label).toBe("No route recorded yet");
  });

  test("a route with zero model calls renders the honest zero-call label", () => {
    const axis = deriveProviderAxis(
      resultOf({ provider: "p", model: "m", strategyClass: "s", modelCalls: 0 }, []),
    );
    expect(axis.label).toBe("No provider calls recorded yet");
  });

  test("a route with completed calls renders the recorded count", () => {
    const axis = deriveProviderAxis(
      resultOf({ provider: "p", model: "m", strategyClass: "s", modelCalls: 4 }, []),
    );
    expect(axis.label).toBe("Provider calls completed (4)");
    expect(axis.source).toContain("route");
  });
});

describe("execution success axis (the honest lifecycle status)", () => {
  test("COMPLETED", () => {
    expect(deriveExecutionAxis(executionOf("COMPLETED")).label).toBe("Execution completed");
  });
  test("FAILED", () => {
    expect(deriveExecutionAxis(executionOf("FAILED")).label).toBe("Execution failed");
  });
  test("CANCELLED and EXPIRED use the honest terminal labels", () => {
    expect(deriveExecutionAxis(executionOf("CANCELLED")).label).toBe("Execution cancelled");
    expect(deriveExecutionAxis(executionOf("EXPIRED")).label).toBe("Execution expired");
  });
  test("in-progress statuses keep the live status visible", () => {
    const axis = deriveExecutionAxis(executionOf("VERIFYING"));
    expect(axis.label).toBe("In progress (VERIFYING)");
  });
});

describe("quality success axis (verification facts ONLY)", () => {
  test("zero results render the honest no-verification label", () => {
    const axis = deriveQualityAxis([]);
    expect(axis.label).toBe("No verification results recorded");
  });

  test("mixed results render 'M of N checks passed'", () => {
    const axis = deriveQualityAxis([
      checkOf("PASS", 0.9),
      checkOf("FAIL", null),
      checkOf("PASS", 0.5),
    ]);
    expect(axis.label).toBe("2 of 3 checks passed");
  });

  test("INCONCLUSIVE results are not counted as passed", () => {
    const axis = deriveQualityAxis([checkOf("INCONCLUSIVE", 0.5)]);
    expect(axis.label).toBe("0 of 1 checks passed");
  });

  test("the mutant pin: a fabricated confidence mapping would fail (only real facts may speak)", () => {
    // What a dishonest derivation would emit with zero verification facts:
    const fabricated = "High confidence";
    const honest = deriveQualityAxis([]).label;
    // The honest mapping CANNOT produce a confidence verdict without facts…
    expect(honest).not.toBe(fabricated);
    expect(honest).not.toMatch(/confidence/i);
    // …and the chip derivation stays null without all-pass-with-confidence facts.
    expect(deriveConfidenceChip([])).toBeNull();
    expect(deriveConfidenceChip([checkOf("PASS", null)])).toBeNull();
    expect(deriveConfidenceChip([checkOf("PASS", 0.9), checkOf("FAIL", 0.9)])).toBeNull();
    // Only the all-PASS + all-confident case derives the chip, WITH its derivation.
    expect(deriveConfidenceChip([checkOf("PASS", 0.9), checkOf("PASS", 0.91)])).toBe(
      "High confidence — 2/2 checks passed",
    );
  });

  test("the header chip is a pass count, never a bare confidence verdict", () => {
    expect(deriveVerificationChip([])).toBe("No verification results");
    expect(deriveVerificationChip([checkOf("PASS", 0.9)])).toBe("1/1 checks passed");
  });
});

describe("policy success axis (admission evidence only)", () => {
  test("a policy-denied event surfaces the denial honestly", () => {
    const axis = derivePolicyAxis(executionOf("CREATED"), [eventOf("execution.policy-denied")]);
    expect(axis.label).toBe("Policy denied admission");
  });

  test("an authorize event proves admission", () => {
    const axis = derivePolicyAxis(executionOf("AUTHORIZED"), [
      eventOf("execution.created"),
      eventOf("execution.authorize", 2),
    ]);
    expect(axis.label).toBe("Admitted by policy");
  });

  test("a status past CREATED proves admission even without events", () => {
    const axis = derivePolicyAxis(executionOf("RUNNING"), [eventOf("execution.created")]);
    expect(axis.label).toBe("Admitted by policy");
  });

  test("a freshly created execution with only the created event is 'Not yet admitted'", () => {
    const axis = derivePolicyAxis(executionOf("CREATED"), [eventOf("execution.created")]);
    expect(axis.label).toBe("Not yet admitted");
  });
});

describe("the four axes stay separate (never one score)", () => {
  test("deriveTrustAxes returns exactly the four axes in the canonical order", () => {
    const axes = deriveTrustAxes(
      executionOf("COMPLETED"),
      resultOf({ provider: "p", model: "m", strategyClass: "s", modelCalls: 2 }, [
        checkOf("PASS", 0.9),
      ]),
      [eventOf("execution.created"), eventOf("execution.authorize", 2)],
    );
    expect(axes.map((axis) => axis.kind)).toEqual(["provider", "execution", "quality", "policy"]);
    expect(axes.every((axis) => axis.source.length > 0 && axis.detail.length > 0)).toBe(true);
    const labels = axes.map((axis) => axis.label).join(" ");
    expect(labels).not.toMatch(/overall|score|rating/i);
  });

  test("a denied execution keeps the axes distinguishable (denial ≠ failure)", () => {
    const axes = deriveTrustAxes(executionOf("CREATED"), resultOf(null, []), [
      eventOf("execution.policy-denied"),
    ]);
    const policy = axes.find((axis) => axis.kind === "policy");
    const executionAxis = axes.find((axis) => axis.kind === "execution");
    expect(policy?.label).toBe("Policy denied admission");
    expect(executionAxis?.label).toBe("In progress (CREATED)");
  });

  test("statusRank orders the public status vocabulary", () => {
    expect(statusRank("CREATED")).toBeLessThan(statusRank("AUTHORIZED"));
    expect(statusRank("AUTHORIZED")).toBeLessThan(statusRank("RUNNING"));
    expect(statusRank("COMPLETED")).toBeGreaterThan(statusRank("VERIFYING"));
    expect(statusRank("unknown-status")).toBe(0);
  });
});
