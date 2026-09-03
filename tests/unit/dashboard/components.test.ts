/**
 * Dashboard component contract tests (WORK-033).
 *
 * Every component of the HTML-first component system: ExecutionHeader
 * facts; VerificationSummary honesty (zero results ⇒ NO invented
 * confidence; mixed checks; all-PASS + confidences ⇒ the DERIVED chip
 * with its derivation visible); ProgressTimeline chronology + unknown
 * types verbatim; WhyPanel platform-facts-only (provider/model render
 * ONLY inside the advanced disclosure); AttentionCard variants;
 * ResultSurface next actions per status family; AdvancedDisclosure
 * default-collapsed semantics; StatusBadge symbol+text; money and
 * duration formatting (integer/BigInt arithmetic only).
 */

import { describe, expect, test } from "vitest";
import {
  advancedDisclosure,
  attentionCard,
  emptyState,
  esc,
  executionHeader,
  formatDuration,
  formatMicroUsd,
  keyValueTable,
  progressTimeline,
  resultSurface,
  statusBadge,
  unavailableState,
  verificationSummary,
  whyPanel,
} from "../../../apps/dashboard/components";
import type { Execution, ExecutionEvent, ExecutionResult, VerificationResult } from "../../../sdk";

function execution(status: string, task: Record<string, unknown> = {}): Execution {
  return {
    id: "00000000-0000-7000-8000-0000000000e1",
    applicationId: "00000000-0000-7000-8000-0000000000a1",
    environmentId: "env-42",
    status: status as Execution["status"],
    task:
      task.description === undefined ? { description: "Contract risk analysis", ...task } : task,
    constraints: null,
    metadata: {},
    createdAt: "2026-09-15T12:00:00Z",
    updatedAt: "2026-09-15T12:03:42Z",
    terminalAt: status === "COMPLETED" ? "2026-09-15T12:03:42Z" : null,
  };
}

function check(status: string, confidence: number | null): VerificationResult {
  return {
    id: `v-${status}`,
    executionId: "00000000-0000-7000-8000-0000000000e1",
    criterionId: `criterion-${status}`,
    strategy: "digest-check",
    status: status as VerificationResult["status"],
    confidence,
    evaluator: { kind: "check", id: "eval-1", version: "3" },
    evidenceRefs: ["ref-1", "ref-2"],
    recordedAt: "2026-09-15T12:03:41Z",
  };
}

function baseResult(verification: VerificationResult[]): ExecutionResult {
  return {
    executionId: "00000000-0000-7000-8000-0000000000e1",
    status: "COMPLETED",
    route: {
      provider: "neutral-provider",
      model: "neutral-model",
      strategyClass: "hybrid",
      modelCalls: 3,
    },
    cost: { totalMicroUsd: "4180000", currency: "usd" },
    usage: null,
    outputArtifacts: [{ id: "art-1", digest: "digest-1", createdAt: "2026-09-15T12:03:40Z" }],
    verification,
    warnings: ["a recorded warning"],
    terminalAt: "2026-09-15T12:03:42Z",
  };
}

function events(...types: string[]): ExecutionEvent[] {
  return types.map((type, index) => ({
    eventId: `ev-${index}`,
    executionId: "00000000-0000-7000-8000-0000000000e1",
    type,
    sequence: index + 1,
    occurredAt: `2026-09-15T12:00:${String(index).padStart(2, "0")}Z`,
    payload: {},
  }));
}

describe("ExecutionHeader (UX §6.1)", () => {
  test("renders identity, status badge, duration, cost and the verification chip", () => {
    const html = executionHeader({
      execution: execution("COMPLETED"),
      durationMs: 222_000,
      costMicroUsd: "4180000",
      verificationChip: "4/4 checks passed",
    });
    expect(html).toContain("Contract risk analysis");
    expect(html).toContain("status-COMPLETED");
    expect(html).toContain("✓");
    expect(html).toContain("Completed");
    expect(html).toContain("3m 42s");
    expect(html).toContain("$4.18");
    expect(html).toContain("4/4 checks passed");
    expect(html).toContain("00000000-0000-7000-8000-0000000000e1");
  });

  test("falls back to the honest id when the task carries no summary field", () => {
    const html = executionHeader({
      execution: execution("RUNNING", { kind: "opaque" }),
      durationMs: 1000,
      costMicroUsd: null,
      verificationChip: "No verification results",
    });
    expect(html).toContain("00000000-0000-7000-8000-0000000000e1");
    expect(html).not.toContain("$");
  });
});

describe("VerificationSummary (never invents confidence)", () => {
  test("zero results render the honest no-verification state and no confidence verdict", () => {
    const html = verificationSummary([]);
    expect(html).toContain("No verification results recorded");
    expect(html).not.toContain("chip-derived");
    expect(html).not.toContain("High confidence");
    expect(html).not.toMatch(/\d+\s*\/\s*\d+\s+checks/);
  });

  test("mixed PASS/FAIL render the pass-count strip without a high-confidence chip", () => {
    const html = verificationSummary([check("PASS", 0.9), check("FAIL", 0.4)]);
    expect(html).toContain("1 of 2 checks passed");
    expect(html).not.toContain("High confidence");
  });

  test("all-PASS with confidences renders the derived chip WITH its derivation visible", () => {
    const html = verificationSummary([check("PASS", 0.91), check("PASS", 0.88)]);
    expect(html).toContain("High confidence");
    expect(html).toContain("2/2 checks passed");
    expect(html).toContain("chip-derived");
  });

  test("all-PASS with a missing confidence renders NO derived chip (honesty)", () => {
    const html = verificationSummary([check("PASS", 0.9), check("PASS", null)]);
    expect(html).toContain("2 of 2 checks passed");
    expect(html).not.toContain("High confidence");
  });

  test("the full table carries column headers and the confidence value or —", () => {
    const html = verificationSummary([check("PASS", 0.9), check("INCONCLUSIVE", null)]);
    expect(html).toContain('<th scope="col">Confidence</th>');
    expect(html).toContain("0.9");
    expect(html).toContain("—");
    expect(html).toContain("eval-1");
  });

  test("the compact strip links to the evidence tab", () => {
    const html = verificationSummary([check("PASS", 0.9)], {
      compact: true,
      executionId: "exec-9",
    });
    expect(html).toContain('href="/runs/exec-9?tab=evidence"');
    expect(html).toContain("View evidence");
  });
});

describe("ProgressTimeline (UX §7 — chronological, never a graph)", () => {
  test("orders events chronologically by sequence regardless of input order", () => {
    const ordered = events("execution.created", "execution.start", "execution.pass");
    const shuffled = [ordered[2], ordered[0], ordered[1]].filter(
      (event): event is ExecutionEvent => event !== undefined,
    );
    const html = progressTimeline(shuffled);
    const created = html.indexOf("Created");
    const started = html.indexOf("Started");
    const passed = html.indexOf("Completed");
    expect(created).toBeGreaterThan(-1);
    expect(started).toBeGreaterThan(created);
    expect(passed).toBeGreaterThan(started);
    expect(html).toContain("<ol");
  });

  test("renders unknown event types verbatim with the honest marker", () => {
    const html = progressTimeline(events("execution.created", "weird.custom.event"));
    expect(html).toContain("weird.custom.event");
    expect(html).toContain("unknown event type");
  });

  test("renders a percentage ONLY when the platform payload carries one", () => {
    const withProgress: ExecutionEvent[] = [
      {
        eventId: "ev-9",
        executionId: "x",
        type: "execution.start",
        sequence: 1,
        occurredAt: "2026-09-15T12:00:00Z",
        payload: { progress: 68 },
      },
    ];
    const withoutProgress = events("execution.start");
    expect(progressTimeline(withProgress)).toContain("68%");
    expect(progressTimeline(withoutProgress)).not.toMatch(/\d+%/);
  });
});

describe("WhyPanel (UX §6.4 — platform facts only, route is secondary)", () => {
  test("contains the absent-capability honesty marker", () => {
    const html = whyPanel({
      execution: execution("COMPLETED"),
      result: baseResult([]),
      events: events("execution.created", "execution.plan"),
    });
    expect(html).toContain("capability detail is not exposed by this projection");
  });

  test("renders provider/model ONLY inside the advanced disclosure", () => {
    const html = whyPanel({
      execution: execution("COMPLETED"),
      result: baseResult([]),
      events: events("execution.created"),
    });
    const advancedStart = html.indexOf('class="advanced"');
    expect(advancedStart).toBeGreaterThan(-1);
    const beforeAdvanced = html.slice(0, advancedStart);
    const afterAdvanced = html.slice(advancedStart);
    expect(beforeAdvanced).not.toContain("neutral-provider");
    expect(beforeAdvanced).not.toContain("neutral-model");
    expect(afterAdvanced).toContain("neutral-provider");
    expect(afterAdvanced).toContain("neutral-model");
  });

  test("states the honest plan-graph absence when no planning events exist", () => {
    const html = whyPanel({
      execution: execution("COMPLETED"),
      result: baseResult([]),
      events: events("execution.created"),
    });
    expect(html).toContain("the full plan graph is not carried by this projection");
  });

  test("explains the route honestly from the request constraints (or their absence)", () => {
    const noConstraints = whyPanel({
      execution: execution("COMPLETED"),
      result: baseResult([]),
      events: events("execution.created"),
    });
    expect(noConstraints).toContain("the request carried no explicit constraints");
    const constrained: Execution = {
      ...execution("COMPLETED"),
      constraints: { maxCostMicroUsd: "10500000", minQuality: 0.8 },
    };
    const withConstraints = whyPanel({
      execution: constrained,
      result: baseResult([]),
      events: events("execution.created"),
    });
    expect(withConstraints).toContain("maxCostMicroUsd");
    expect(withConstraints).toContain("minQuality");
  });

  test("renders cost from the integer micro-USD string", () => {
    const html = whyPanel({
      execution: execution("COMPLETED"),
      result: baseResult([]),
      events: events("execution.created"),
    });
    expect(html).toContain("$4.18");
    expect(html).toContain("4180000 micro-USD");
  });
});

describe("AttentionCard (UX §4/§8)", () => {
  test("the decision variant renders the governed-state copy and its action links", () => {
    const html = attentionCard({
      kind: "decision",
      title: "Decision needed",
      body: "The execution is waiting for your decision. This is a normal governed state.",
      links: [{ label: "Open the execution", href: "/runs/e1" }],
    });
    expect(html).toContain("attention-decision");
    expect(html).toContain('href="/runs/e1"');
    expect(html).toContain("normal governed state");
  });

  test("the failed variant renders the recovery links", () => {
    const html = attentionCard({
      kind: "failed",
      title: "Zeck could not complete an execution",
      body: "The execution failed.",
      links: [
        { label: "Open the execution", href: "/runs/e1" },
        { label: "Start a new attempt", href: "/build/execution?outcome=x" },
      ],
    });
    expect(html).toContain("attention-failed");
    expect(html).toContain("Start a new attempt");
  });
});

describe("ResultSurface next actions per status family (UX §6.3/§8)", () => {
  test("a completed execution offers evidence and artifact links", () => {
    const html = resultSurface({
      execution: execution("COMPLETED"),
      result: baseResult([]),
      events: events("execution.created", "execution.pass"),
    });
    expect(html).toContain("?tab=evidence");
    expect(html).toContain("/assets/artifacts/art-1?executionId=");
    expect(html).not.toContain("action=cancel");
  });

  test("a failed execution renders the recoverable-failure surface with remediation", () => {
    const failedExecution: Execution = {
      ...execution("FAILED", { description: "Contract risk analysis" }),
      terminalAt: "2026-09-15T12:02:00Z",
    };
    const failedResult: ExecutionResult = {
      ...baseResult([]),
      status: "FAILED",
      outputArtifacts: [],
    };
    const failureEvents: ExecutionEvent[] = [
      {
        eventId: "ev-f",
        executionId: "00000000-0000-7000-8000-0000000000e1",
        type: "execution.fail",
        sequence: 2,
        occurredAt: "2026-09-15T12:02:00Z",
        payload: { message: "the connection rejected the request" },
      },
    ];
    const html = resultSurface({
      execution: failedExecution,
      result: failedResult,
      events: failureEvents,
    });
    expect(html).toContain("Zeck could not complete this execution");
    expect(html).toContain("the connection rejected the request");
    expect(html).toContain("?tab=activity");
    expect(html).toContain("Start a new attempt");
    expect(html).not.toContain("action=cancel");
  });

  test("a waiting execution renders the decision surface (normal state) with the honest no-resolve note", () => {
    const waitingExecution = execution("WAITING_USER");
    const html = resultSurface({
      execution: waitingExecution,
      result: { ...baseResult([]), status: "WAITING_USER", outputArtifacts: [] },
      events: events("execution.created", "execution.wait-user"),
    });
    expect(html).toContain("Decision needed");
    expect(html).toContain("normal governed execution state, not an error");
    expect(html).toContain("does not expose a resolve command");
    expect(html).toContain("action=cancel");
  });

  test("a running execution offers the confirmation-gated cancel action", () => {
    const html = resultSurface({
      execution: execution("RUNNING"),
      result: { ...baseResult([]), status: "RUNNING", outputArtifacts: [] },
      events: events("execution.created", "execution.start"),
    });
    expect(html).toContain("?action=cancel");
    expect(html).not.toContain("<form");
  });

  test("a cancelled execution offers a fresh attempt, not a cancel action", () => {
    const cancelledExecution: Execution = {
      ...execution("CANCELLED"),
      terminalAt: "2026-09-15T12:02:00Z",
    };
    const html = resultSurface({
      execution: cancelledExecution,
      result: { ...baseResult([]), status: "CANCELLED", outputArtifacts: [] },
      events: events("execution.created", "execution.cancel"),
    });
    expect(html).toContain("Start a new attempt");
    expect(html).not.toContain("action=cancel");
  });
});

describe("AdvancedDisclosure (progressive disclosure)", () => {
  test("is collapsed by default (no open attribute) and keyboard-operable natively", () => {
    const html = advancedDisclosure("Expert detail", "<p>inner</p>");
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(html).toContain("<summary>Expert detail</summary>");
  });
});

describe("StatusBadge (non-color communication)", () => {
  test("every known status renders a symbol AND a text label", () => {
    for (const status of [
      "CREATED",
      "AUTHORIZED",
      "PLANNING",
      "QUEUED",
      "RUNNING",
      "WAITING_TOOL",
      "WAITING_USER",
      "WAITING_HUMAN",
      "VERIFYING",
      "REPLANNING",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
      "EXPIRED",
    ]) {
      const html = statusBadge(status);
      expect(html).toContain("aria-hidden");
      expect(html).toContain(`status-${status}`);
      expect(html.replace(/<[^>]+>/g, "").trim().length).toBeGreaterThan(status.length);
    }
  });
});

describe("Money and duration formatting (integer arithmetic only)", () => {
  test("integer micro-USD strings render as dollars", () => {
    expect(formatMicroUsd("4180000")).toBe("$4.18");
    expect(formatMicroUsd("0")).toBe("$0.00");
    expect(formatMicroUsd("1000000")).toBe("$1.00");
    expect(formatMicroUsd("42")).toBe("$0.000042");
    expect(formatMicroUsd("4185000")).toBe("$4.185");
  });

  test("large values stay exact through BigInt (no float rounding)", () => {
    expect(formatMicroUsd("123456789012")).toBe("$123456.789012");
    expect(formatMicroUsd("999999999999999")).toBe("$999999999.999999");
  });

  test("a non-numeric platform value renders verbatim (never a fabricated number)", () => {
    expect(formatMicroUsd("not-a-number")).toBe("not-a-number");
  });

  test("durations render in human units", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(222_000)).toBe("3m 42s");
    expect(formatDuration(7_380_000)).toBe("2h 3m");
  });
});

describe("state primitives (loading/empty/error/permission-denied family)", () => {
  test("the unavailable state names the concept, explains it, and points at the future source", () => {
    const html = unavailableState(
      "Competences",
      "A competence is a reusable way of describing work.",
      "the competence authority through the public API",
    );
    expect(html).toContain("not yet exposed by the public API");
    expect(html).toContain("Competences");
    expect(html).toContain("the competence authority through the public API");
    expect(html).not.toContain("TODO");
  });

  test("the empty state never fabricates data", () => {
    const html = emptyState("Nothing here yet", "No executions opened in this browser.");
    expect(html).toContain("state-empty");
    expect(html).not.toMatch(/\d+\/\d+|%/);
  });

  test("key/value tables use th scope=row; empty tables stay honest", () => {
    expect(keyValueTable([["a", "b"]])).toContain('th scope="row"');
    expect(keyValueTable([])).toContain("No fields recorded.");
  });

  test("esc escapes the full hostile set", () => {
    expect(esc(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });
});
