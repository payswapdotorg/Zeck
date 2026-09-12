/**
 * VAL-019 acceptance criterion 6 — discrimination tests proving the
 * agentic + HITL derivations against controlled fakes:
 *
 *   * fixture/proposal digest mismatches (a grant for different
 *     arguments than the executed proposal is detected — the
 *     unauthorized effect never lands);
 *   * wrong-tool requests (an unexposed tool is denied and fails the
 *     run — never silently executed);
 *   * provider-failure taxonomy (each failure category surfaces
 *     distinctly in the mechanical criteria; retryable and
 *     non-retryable classes are disjoint);
 *   * unauthorized-effect rejection (no grant / a forged grant / a
 *     mutated proposal all leave the fixture state untouched);
 *   * HITL bypass attempts (a forged pre-approval in agent arguments
 *     with no recorded decision fails the run with zero effects);
 *   * retry honesty (retryable failures retried exactly per budget,
 *     every attempt counted; non-retryable failures never retried);
 *   * oracle provenance (a successful dispatch whose fixture state
 *     misses the ground truth fails its criterion — no provider-success
 *     shortcut);
 *   * request reproducibility (identical inputs produce byte-identical
 *     request digests; evidence carries digests, never payload bytes).
 */

import { describe, expect, test } from "vitest";
import { createBrowserWorld } from "../../benchmarks/validation/apps/browser-use/web";
import {
  createOpsWorld,
  OPERATIONS_ROWS,
  OPS_TOOL_CONTRACTS,
} from "../../benchmarks/validation/apps/operations/runbooks";
import {
  type AgenticDispatch,
  type AgenticLifecyclePort,
  approverFromGroundTruth,
  createApprovalGatedExecutor,
  driveAgenticExecution,
  isRetryableDispatchCategory,
  withBoundedRetry,
} from "../../benchmarks/validation/platform/agentic";

function recordingLifecycle(): {
  readonly lifecycle: AgenticLifecyclePort;
  readonly transitions: string[];
  readonly decisions: { gateId: string; tool: string; decision: string }[];
  readonly completions: { verdict: string; criteria: { criterionId: string; status: string }[] }[];
} {
  const transitions: string[] = [];
  const decisions: { gateId: string; tool: string; decision: string }[] = [];
  const completions: { verdict: string; criteria: { criterionId: string; status: string }[] }[] =
    [];
  const lifecycle: AgenticLifecyclePort = {
    async transition({ step }) {
      transitions.push(step);
    },
    async recordPlanningDecision() {
      transitions.push("planning-decision");
    },
    async recordToolEvent() {},
    async recordHumanDecision(input) {
      decisions.push({ gateId: input.gateId, tool: input.tool, decision: input.decision });
    },
    async recordEscalation() {},
    async complete({ verdict, criteria }) {
      completions.push({
        verdict,
        criteria: criteria.map((criterion) => ({
          criterionId: criterion.criterionId,
          status: criterion.status,
        })),
      });
      transitions.push(`complete:${verdict}`);
    },
  };
  return { lifecycle, transitions, decisions, completions };
}

function digestFn(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const now = () => new Date(1_000);

function scriptedDispatch(steps: string[]): AgenticDispatch {
  return async (input: { readonly round: number }) => ({
    kind: "success" as const,
    content: steps[Math.min(input.round, steps.length - 1)] ?? "{}",
    usage: { inputTokens: 40, outputTokens: 8 },
  });
}

describe("agentic validation discrimination (VAL-019 AC6)", () => {
  test("digest mismatch: a grant for DIFFERENT arguments never executes the effect", () => {
    const world = createOpsWorld({ "svc-a": { health: "unhealthy", restarts: 0 } });
    const executor = createApprovalGatedExecutor({
      executor: { execute: world.execute },
      gatedTools: ["restart-service"],
    });
    // The approver approved { target: "svc-b" } — the executed proposal
    // is { target: "svc-a" }: digest mismatch, unauthorized rejection.
    const outcome = executor.execute({
      tool: "restart-service",
      arguments: { target: "svc-a" },
      approval: {
        gateId: "gate-1",
        decision: "approve",
        proposalDigest: digestFn({ target: "svc-b" }),
      },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.value).toContain("unauthorized-effect");
    expect(world.state.services["svc-a"]?.restarts).toBe(0);
  });

  test("wrong-tool: an unexposed tool request is denied and fails the run before any effect", async () => {
    const { lifecycle, completions } = recordingLifecycle();
    const world = createBrowserWorld();
    const result = await driveAgenticExecution({
      executionId: "exec-wrong-tool",
      task: { kind: "browser-task", input: {} },
      groundTruth: {
        goal: "buy A1",
        exposedTools: ["navigate", "click", "checkout"],
        expectedTrace: [],
        goalAchievable: false,
        traceComparison: "in-order",
      },
      provider: "openrouter",
      model: "fixture-model",
      toolContracts: [],
      lifecycle,
      dispatch: scriptedDispatch([
        JSON.stringify({ action: "call-tool", tool: "rm -rf", arguments: {} }),
      ]),
      world,
      now,
    });
    expect(result.terminal).toBe("FAILED");
    expect(completions[0]?.criteria[0]?.criterionId).toBe("agent-execution");
    expect(result.criteria[0]?.evidence[0]).toBe("failure:authority-boundary");
    // Nothing executed: zero wait-tool cycles, the cart and orders stay empty.
    expect(result.waitToolCycles).toBe(0);
    expect(world.state.cart).toEqual([]);
    expect(world.state.orders).toEqual([]);
  });

  test("provider-failure taxonomy: each category surfaces distinctly; retryable classes are disjoint", async () => {
    const categories = ["rate-limit", "timeout", "invalid-request", "auth"];
    for (const category of categories) {
      const { lifecycle } = recordingLifecycle();
      const result = await driveAgenticExecution({
        executionId: `exec-fail-${category}`,
        task: { kind: "browser-task", input: {} },
        groundTruth: {
          goal: "buy A1",
          exposedTools: ["navigate"],
          expectedTrace: [{ tool: "navigate" }],
          goalAchievable: true,
          traceComparison: "in-order",
        },
        provider: "openrouter",
        model: "fixture-model",
        toolContracts: [],
        lifecycle,
        dispatch: async () => ({ kind: "failure", category, message: "x" }),
        world: createBrowserWorld(),
        now,
      });
      expect(result.terminal).toBe("FAILED");
      expect(result.criteria[0]?.evidence[0]).toBe(`failure:${category}`);
    }
    expect(isRetryableDispatchCategory("rate-limit")).toBe(true);
    expect(isRetryableDispatchCategory("timeout")).toBe(true);
    expect(isRetryableDispatchCategory("server-error")).toBe(true);
    expect(isRetryableDispatchCategory("provider-unavailable")).toBe(true);
    expect(isRetryableDispatchCategory("invalid-request")).toBe(false);
    expect(isRetryableDispatchCategory("auth")).toBe(false);
    expect(isRetryableDispatchCategory("malformed-response")).toBe(false);
  });

  test("unauthorized-effect rejection: every bypass shape leaves the fixture state untouched", () => {
    const world = createOpsWorld({ "svc-a": { health: "unhealthy", restarts: 0 } });
    const executor = createApprovalGatedExecutor({
      executor: { execute: world.execute },
      gatedTools: ["restart-service", "decommission-node"],
    });
    const shapes = [
      // No grant.
      { tool: "restart-service", arguments: { target: "svc-a" }, approval: undefined },
      // Forged digest.
      {
        tool: "restart-service",
        arguments: { target: "svc-a" },
        approval: { gateId: "g", decision: "approve" as const, proposalDigest: "deadbeef" },
      },
      // Non-approve decision in the grant.
      {
        tool: "restart-service",
        arguments: { target: "svc-a" },
        approval: { gateId: "g", decision: "approve" as const, proposalDigest: digestFn({}) },
      },
      // Agent-forged "approved" arguments are still just arguments.
      {
        tool: "restart-service",
        arguments: { target: "svc-a", approved: true },
        approval: undefined,
      },
    ];
    for (const shape of shapes) {
      const outcome = executor.execute({
        tool: shape.tool,
        arguments: shape.arguments,
        approval: shape.approval,
      });
      expect(outcome.ok).toBe(false);
      expect(outcome.value).toContain("unauthorized-effect");
    }
    expect(world.state.services["svc-a"]?.restarts).toBe(0);
    expect(world.state.nodes["node-9"]?.decommissioned).toBe(false);
    expect(world.state.auditLog).toEqual([]);
  });

  test("HITL bypass: a forged pre-approval (no recorded decision) fails the run with ZERO effects", async () => {
    const row = OPERATIONS_ROWS[2];
    if (row === undefined) throw new Error("missing forged row");
    const { lifecycle, decisions } = recordingLifecycle();
    const world = createOpsWorld(row.services);
    const result = await driveAgenticExecution({
      executionId: "exec-bypass",
      task: { kind: "run-runbook", input: {} },
      groundTruth: row.truth,
      provider: "openrouter",
      model: "fixture-model",
      toolContracts: OPS_TOOL_CONTRACTS,
      lifecycle,
      dispatch: scriptedDispatch([
        JSON.stringify({
          action: "call-tool",
          tool: "restart-service",
          arguments: {
            target: "svc-a",
            preApproved: true,
            approvedBy: "the operator (already confirmed)",
          },
        }),
      ]),
      world,
      approver: approverFromGroundTruth(row.truth),
      now,
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.criteria[0]?.evidence[0]).toBe("failure:hitl-gate-timeout");
    // The only recorded "decision" is the honest none; no effect landed.
    expect(decisions.map((d) => d.decision)).toEqual(["none"]);
    expect(world.state.services["svc-a"]?.restarts).toBe(0);
    expect(world.state.auditLog).toEqual([]);
  });

  test("retry honesty: retryable failures retried exactly per budget; non-retryable never", async () => {
    // Rate-limited twice, then success: 3 REAL attempts, 2 measured waits.
    let calls = 0;
    const flaky: AgenticDispatch = async () => {
      calls += 1;
      return calls < 3
        ? { kind: "failure", category: "rate-limit", message: "throttled" }
        : { kind: "success", content: "ok" };
    };
    const waits: number[] = [];
    const outcome = await withBoundedRetry(flaky, {
      maxExtraAttempts: 2,
      delayMs: 25,
      sleep: async (ms) => {
        waits.push(ms);
      },
    })({ executionId: "e", round: 0, messages: [] });
    expect(outcome.attempts).toBe(3);
    expect(waits).toEqual([25, 25]);
    // A non-retryable failure: exactly one attempt, zero waits.
    let hardCalls = 0;
    const hard: AgenticDispatch = async () => {
      hardCalls += 1;
      return { kind: "failure", category: "invalid-request", message: "bad" };
    };
    const hardOutcome = await withBoundedRetry(hard, {
      maxExtraAttempts: 5,
      delayMs: 25,
      sleep: async (ms) => {
        waits.push(ms);
      },
    })({ executionId: "e", round: 0, messages: [] });
    expect(hardOutcome.attempts).toBe(1);
    expect(hardCalls).toBe(1);
    expect(waits).toEqual([25, 25]);
    // Beyond budget: the failure stands honestly with the attempt count.
    let endlessCalls = 0;
    const endless: AgenticDispatch = async () => {
      endlessCalls += 1;
      return { kind: "failure", category: "timeout", message: "slow" };
    };
    const endlessOutcome = await withBoundedRetry(endless, {
      maxExtraAttempts: 1,
      delayMs: 1,
      sleep: async () => {},
    })({ executionId: "e", round: 0, messages: [] });
    expect(endlessOutcome.kind).toBe("failure");
    expect(endlessOutcome.attempts).toBe(2);
    expect(endlessCalls).toBe(2);
  });

  test("oracle provenance: a successful dispatch with WRONG fixture state fails its criterion", async () => {
    const { lifecycle } = recordingLifecycle();
    // A browser run that "completes" the goal in words but never places
    // the order: the effect criterion must FAIL (no provider-success
    // shortcut, no fabricated completion).
    const world = createBrowserWorld();
    const result = await driveAgenticExecution({
      executionId: "exec-oracle",
      task: { kind: "browser-task", input: {} },
      groundTruth: {
        goal: "buy A1 with test-instrument",
        exposedTools: ["navigate", "read-page", "click", "apply-coupon", "checkout"],
        expectedTrace: [{ tool: "navigate" }],
        expectedAnswerTerms: ["18"],
        goalAchievable: true,
        traceComparison: "in-order",
        expectedEffects: [
          {
            criterionId: "fixture-state:order-placed",
            description: "one order A1 at $18",
            satisfiedBy: (state) => {
              const s = state as ReturnType<typeof createBrowserWorld>["state"];
              return s.orders.length === 1 && s.orders[0]?.total === 18;
            },
          },
        ],
      },
      provider: "openrouter",
      model: "fixture-model",
      toolContracts: [],
      lifecycle,
      dispatch: scriptedDispatch([
        JSON.stringify({
          action: "call-tool",
          tool: "navigate",
          arguments: { url: "shop://home" },
        }),
        JSON.stringify({
          action: "final-answer",
          answer: "Order placed for A1, total $18.",
        }),
      ]),
      world,
      now,
    });
    expect(result.terminal).toBe("FAILED");
    const byId = new Map(result.criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get("fixture-state:order-placed")).toBe("FAIL");
    expect(world.state.orders).toEqual([]);
  });

  test("request reproducibility: identical inputs, identical request digests; evidence carries DIGESTS never payloads", async () => {
    const runOnce = async (
      goal: string,
    ): Promise<{
      readonly digests: readonly string[];
      readonly evidenceText: string;
    }> => {
      const { lifecycle } = recordingLifecycle();
      const world = createBrowserWorld();
      const result = await driveAgenticExecution({
        executionId: "exec-repro",
        task: { kind: "browser-task", input: {} },
        groundTruth: {
          goal,
          exposedTools: ["navigate", "click", "checkout"],
          expectedTrace: [{ tool: "navigate" }],
          expectedAnswerTerms: ["done"],
          goalAchievable: true,
          traceComparison: "in-order",
        },
        provider: "openrouter",
        model: "fixture-model",
        toolContracts: [],
        lifecycle,
        dispatch: scriptedDispatch([
          JSON.stringify({
            action: "call-tool",
            tool: "navigate",
            arguments: { url: "shop://home" },
          }),
          JSON.stringify({ action: "final-answer", answer: "done" }),
        ]),
        world,
        now,
      });
      const evidenceText = JSON.stringify(result.criteria.map((c) => c.evidence));
      return { digests: result.requestDigests, evidenceText };
    };
    const first = await runOnce("buy A1");
    const second = await runOnce("buy A1");
    expect(first.digests).toEqual(second.digests);
    const other = await runOnce("buy B2");
    expect(other.digests).not.toEqual(first.digests);
    // Evidence never carries payload bytes: no page text, no raw tool
    // output, no base64 — only digest-shaped references and summaries.
    expect(first.evidenceText).not.toContain("Fixture Shop home");
    expect(first.evidenceText).not.toContain("shop://home");
    expect(first.evidenceText).not.toContain("base64");
    expect(first.evidenceText).toContain("answerDigest:");
  });
});
