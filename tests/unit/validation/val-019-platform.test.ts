/**
 * VAL-019 acceptance criteria 4/5/6: the agentic + HITL platform driver
 * against controlled fakes — the canonical multi-step order (wait-tool →
 * resume around every execution; wait-human → resume around every
 * approval gate), ledger events in the platform's own vocabulary
 * (tool-requested / tool-result / tool-denied / human-decision-recorded),
 * the scripted-approver HITL seam (recorded decision provenance),
 * approval-gated effects (approvals gate effects; rejections,
 * escalations and no-decisions never execute), unauthorized-effect
 * rejection at the executor, ordered trace verification, provider
 * failure honesty, bounded retry honesty, and the round budget.
 */

import { describe, expect, test } from "vitest";
import { createBrowserWorld } from "../../../benchmarks/validation/apps/browser-use/web";
import { createCodingWorld } from "../../../benchmarks/validation/apps/coding/specs";
import {
  createOpsWorld,
  OPERATIONS_ROWS,
  OPS_TOOL_CONTRACTS,
} from "../../../benchmarks/validation/apps/operations/runbooks";
import {
  AGENTIC_STEP_SCHEMA,
  type AgenticDispatch,
  type AgenticLifecyclePort,
  approverFromGroundTruth,
  createApprovalGatedExecutor,
  createScriptedApprover,
  driveAgenticExecution,
  isRetryableDispatchCategory,
  withBoundedRetry,
} from "../../../benchmarks/validation/platform/agentic";

interface RecordedEvent {
  readonly command: string;
  readonly tool: string;
  readonly detail: string;
}

function createFakeLifecycle(): AgenticLifecyclePort & {
  readonly transitions: string[];
  readonly events: RecordedEvent[];
  readonly decisions: { gateId: string; tool: string; decision: string }[];
  readonly escalations: { gateId: string; tool: string; routedTo: string }[];
  readonly completions: { verdict: string; criteria: { criterionId: string; status: string }[] }[];
} {
  const transitions: string[] = [];
  const events: RecordedEvent[] = [];
  const decisions: { gateId: string; tool: string; decision: string }[] = [];
  const escalations: { gateId: string; tool: string; routedTo: string }[] = [];
  const completions: { verdict: string; criteria: { criterionId: string; status: string }[] }[] =
    [];
  const port: AgenticLifecyclePort = {
    async transition(command) {
      transitions.push(command.step);
    },
    async recordPlanningDecision() {},
    async recordToolEvent(input) {
      events.push({
        command: input.command,
        tool: input.tool,
        detail: String(input.reference.reason ?? input.reference.gateId ?? ""),
      });
    },
    async recordHumanDecision(input) {
      decisions.push({
        gateId: input.gateId,
        tool: input.tool,
        decision: input.decision,
      });
    },
    async recordEscalation(input) {
      escalations.push({ gateId: input.gateId, tool: input.tool, routedTo: input.routedTo });
    },
    async complete(input) {
      completions.push({
        verdict: input.verdict,
        criteria: input.criteria.map((criterion) => ({
          criterionId: criterion.criterionId,
          status: criterion.status,
        })),
      });
    },
  };
  return Object.assign(port, { transitions, events, decisions, escalations, completions });
}

/** A scripted dispatch: replays canned agent steps per round. */
function scriptedDispatch(steps: string[]): AgenticDispatch {
  return async (input: { readonly round: number }) => ({
    kind: "success" as const,
    content: steps[Math.min(input.round, steps.length - 1)] ?? steps[steps.length - 1] ?? "{}",
    usage: { inputTokens: 50, outputTokens: 10 },
  });
}

const now = () => new Date(1_000);

describe("VAL-019 agentic protocol and HITL seams", () => {
  test("the agent protocol schema is exported for the REAL dispatch binding", () => {
    expect(AGENTIC_STEP_SCHEMA.required).toEqual(["action"]);
    expect(AGENTIC_STEP_SCHEMA.properties.action).toMatchObject({ type: "string" });
  });

  test("the approval-gated executor rejects every bypass shape (no grant, forged grant, mutated proposal)", () => {
    const world = createOpsWorld({ "svc-a": { health: "unhealthy", restarts: 0 } });
    const executor = createApprovalGatedExecutor({
      executor: { execute: world.execute },
      gatedTools: ["restart-service"],
    });
    // No grant at all.
    expect(executor.execute({ tool: "restart-service", arguments: { target: "svc-a" } }).ok).toBe(
      false,
    );
    expect(world.state.services["svc-a"]?.restarts).toBe(0);
    // Forged grant (wrong proposal digest).
    expect(
      executor.execute({
        tool: "restart-service",
        arguments: { target: "svc-a" },
        approval: { gateId: "g", decision: "approve", proposalDigest: "deadbeef" },
      }).ok,
    ).toBe(false);
    expect(world.state.services["svc-a"]?.restarts).toBe(0);
    // A grant for DIFFERENT arguments (mutated proposal).
    expect(
      executor.execute({
        tool: "restart-service",
        arguments: { target: "svc-a" },
        approval: {
          gateId: "g",
          decision: "approve",
          proposalDigest: "irrelevant-but-well-formed",
        },
      }).ok,
    ).toBe(false);
    // Ungated tools are unaffected.
    expect(executor.execute({ tool: "verify-health", arguments: { target: "svc-a" } }).ok).toBe(
      true,
    );
  });

  test("the gated executor executes behind a VALID grant (approvals gate effects)", () => {
    const world = createOpsWorld({ "svc-a": { health: "unhealthy", restarts: 0 } });
    const executor = createApprovalGatedExecutor({
      executor: { execute: world.execute },
      gatedTools: ["restart-service"],
    });
    const args = { target: "svc-a" };
    const grant = {
      gateId: "gate-1",
      decision: "approve" as const,
      proposalDigest: digestFn(args),
    };
    const outcome = executor.execute({ tool: "restart-service", arguments: args, approval: grant });
    expect(outcome.ok).toBe(true);
    expect(world.state.services["svc-a"]?.restarts).toBe(1);
  });

  test("the scripted approver is deterministic with recorded provenance; unknown gates decide none", () => {
    const approver = createScriptedApprover({
      fixtureId: "approvals-synthetic-v1",
      decisions: {
        "restart-service": { decision: "approve", reason: "authorized" },
      },
    });
    const first = approver.decide({
      gateId: "g1",
      tool: "restart-service",
      proposal: { target: "svc-a" },
    });
    const second = approver.decide({
      gateId: "g1",
      tool: "restart-service",
      proposal: { target: "svc-a" },
    });
    expect(first).toEqual(second);
    expect(first.decision).toBe("approve");
    expect(first.approverFixtureId).toBe("approvals-synthetic-v1");
    expect(first.proposalDigest).toBe(digestFn({ target: "svc-a" }));
    const unknown = approver.decide({
      gateId: "g2",
      tool: "decommission-node",
      proposal: { target: "node-9" },
    });
    expect(unknown.decision).toBe("none");
  });

  test("binding a gated task without an approver is refused (the HITL seam is mandatory)", async () => {
    const lifecycle = createFakeLifecycle();
    const row = OPERATIONS_ROWS[0];
    if (row === undefined) throw new Error("missing operations row");
    await expect(
      driveAgenticExecution({
        executionId: "exec-no-approver",
        task: { kind: "run-runbook", input: {} },
        groundTruth: row.truth,
        provider: "openrouter",
        model: "fixture-model",
        toolContracts: OPS_TOOL_CONTRACTS,
        lifecycle,
        dispatch: scriptedDispatch([]),
        world: createOpsWorld(row.services),
        now,
      }),
    ).rejects.toThrow(/scripted approver/);
  });
});

function digestFn(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

describe("VAL-019 agentic driver (ungated applications)", () => {
  test("a browser-use goal: wait-tool/resume bracket every execution, trace verifies, effects assert", async () => {
    const lifecycle = createFakeLifecycle();
    const world = createBrowserWorld();
    const result = await driveAgenticExecution({
      executionId: "exec-browser",
      task: { kind: "browser-task", input: {} },
      groundTruth: {
        goal: "buy A1 with test-instrument",
        exposedTools: ["navigate", "read-page", "click", "apply-coupon", "checkout"],
        expectedTrace: [
          { tool: "navigate", exactArguments: { url: "shop://home" } },
          { tool: "click", exactArguments: { selector: "add-to-cart:A1" } },
          { tool: "checkout", exactArguments: { instrument: "test-instrument" } },
        ],
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
          action: "call-tool",
          tool: "click",
          arguments: { selector: "add-to-cart:A1" },
        }),
        JSON.stringify({
          action: "call-tool",
          tool: "checkout",
          arguments: { instrument: "test-instrument" },
        }),
        JSON.stringify({ action: "final-answer", answer: "Order placed: A1, total $18." }),
      ]),
      world,
      now,
    });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.rounds).toBe(4);
    expect(lifecycle.transitions).toEqual([
      "authorize",
      "plan",
      "queue",
      "start",
      "wait-tool",
      "resume",
      "wait-tool",
      "resume",
      "wait-tool",
      "resume",
      "verify",
    ]);
    expect(lifecycle.events.map((event) => event.command)).toEqual([
      "tool-requested",
      "tool-result",
      "tool-requested",
      "tool-result",
      "tool-requested",
      "tool-result",
    ]);
    expect(result.waitToolCycles).toBe(3);
    expect(result.waitHumanCycles).toBe(0);
    expect(result.requestDigests).toHaveLength(4);
    const byId = new Map(result.criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get("tool-trace-ordered")).toBe("PASS");
    expect(byId.get("tool-step-exactness")).toBe("PASS");
    expect(byId.get("contains:18")).toBe("PASS");
    expect(byId.get("fixture-state:order-placed")).toBe("PASS");
  });

  test("in-order matching tolerates redundant reads; step exactness checks the MATCHED entries", async () => {
    const lifecycle = createFakeLifecycle();
    const world = createBrowserWorld();
    const result = await driveAgenticExecution({
      executionId: "exec-browser-extras",
      task: { kind: "browser-task", input: {} },
      groundTruth: {
        goal: "buy A1",
        exposedTools: ["navigate", "read-page", "click", "checkout"],
        expectedTrace: [
          { tool: "navigate", exactArguments: { url: "shop://home" } },
          { tool: "click", exactArguments: { selector: "add-to-cart:A1" } },
          { tool: "checkout", exactArguments: { instrument: "test-instrument" } },
        ],
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
        JSON.stringify({ action: "call-tool", tool: "read-page", arguments: {} }),
        JSON.stringify({
          action: "call-tool",
          tool: "click",
          arguments: { selector: "add-to-cart:A1" },
        }),
        JSON.stringify({
          action: "call-tool",
          tool: "checkout",
          arguments: { instrument: "test-instrument" },
        }),
        JSON.stringify({ action: "final-answer", answer: "Done." }),
      ]),
      world,
      now,
    });
    expect(result.terminal).toBe("COMPLETED");
    const byId = new Map(result.criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get("tool-trace-ordered")).toBe("PASS");
    expect(byId.get("tool-step-exactness")).toBe("PASS");
  });

  test("a coding goal: the embedded-test oracle gates completion (wrong rules FAIL honestly)", async () => {
    const world = createCodingWorld("fn-fizzmod");
    const truth = {
      goal: "implement fn-fizzmod",
      exposedTools: ["submit-implementation"],
      expectedTrace: [{ tool: "submit-implementation" }],
      goalAchievable: true,
      traceComparison: "in-order" as const,
      expectedEffects: [
        {
          criterionId: "fixture-state:embedded-tests-pass",
          description: "all embedded tests pass",
          satisfiedBy: (state: unknown) => {
            const s = state as ReturnType<typeof createCodingWorld>["state"];
            const last = s.submissions[s.submissions.length - 1];
            return last !== undefined && last.compileError === null && last.report.failed === 0;
          },
        },
      ],
    };
    // Correct rules first.
    const good = await driveAgenticExecution({
      executionId: "exec-coding-good",
      task: { kind: "implement-function", input: {} },
      groundTruth: truth,
      provider: "openrouter",
      model: "fixture-model",
      toolContracts: [],
      lifecycle: createFakeLifecycle(),
      dispatch: scriptedDispatch([
        JSON.stringify({
          action: "call-tool",
          tool: "submit-implementation",
          arguments: {
            rules: [
              { divisor: 15, word: "fizzbuzzmod" },
              { divisor: 3, word: "fizzmod" },
              { divisor: 5, word: "buzzmod" },
            ],
            defaultAction: "number",
          },
        }),
        JSON.stringify({ action: "final-answer", answer: "tests passed 7/7" }),
      ]),
      world,
      now,
    });
    expect(good.terminal).toBe("COMPLETED");
    // Wrong rule order (3 before 15): 15 divisible by 3 first -> wrong word.
    const badWorld = createCodingWorld("fn-fizzmod");
    const bad = await driveAgenticExecution({
      executionId: "exec-coding-bad",
      task: { kind: "implement-function", input: {} },
      groundTruth: truth,
      provider: "openrouter",
      model: "fixture-model",
      toolContracts: [],
      lifecycle: createFakeLifecycle(),
      dispatch: scriptedDispatch([
        JSON.stringify({
          action: "call-tool",
          tool: "submit-implementation",
          arguments: {
            rules: [
              { divisor: 3, word: "fizzmod" },
              { divisor: 15, word: "fizzbuzzmod" },
              { divisor: 5, word: "buzzmod" },
            ],
            defaultAction: "number",
          },
        }),
        JSON.stringify({ action: "final-answer", answer: "submitted" }),
      ]),
      world: badWorld,
      now,
    });
    expect(bad.terminal).toBe("FAILED");
    const byId = new Map(bad.criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get("fixture-state:embedded-tests-pass")).toBe("FAIL");
  });
});

describe("VAL-019 agentic driver (HITL applications)", () => {
  test("an APPROVED gated effect: wait-human/resume exactly once, decision journaled, effect executes", async () => {
    const lifecycle = createFakeLifecycle();
    const row = OPERATIONS_ROWS[0];
    if (row === undefined) throw new Error("missing operations row 0");
    const world = createOpsWorld(row.services);
    const result = await driveAgenticExecution({
      executionId: "exec-ops-approve",
      task: { kind: "run-runbook", input: {} },
      groundTruth: row.truth,
      provider: "openrouter",
      model: "fixture-model",
      toolContracts: OPS_TOOL_CONTRACTS,
      lifecycle,
      dispatch: scriptedDispatch([
        JSON.stringify({
          action: "call-tool",
          tool: "verify-health",
          arguments: { target: "svc-a" },
        }),
        JSON.stringify({
          action: "call-tool",
          tool: "restart-service",
          arguments: { target: "svc-a" },
        }),
        JSON.stringify({
          action: "call-tool",
          tool: "verify-health",
          arguments: { target: "svc-a" },
        }),
        JSON.stringify({ action: "final-answer", answer: "svc-a restarted and healthy." }),
      ]),
      world,
      approver: approverFromGroundTruth(row.truth),
      now,
    });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.waitHumanCycles).toBe(1);
    expect(result.waitToolCycles).toBe(3);
    // The gated call gets its OWN wait-human/resume pair before the
    // tool-execution pair: [.. wait-human, resume, wait-tool, resume ..]
    const gatedIndex = lifecycle.transitions.indexOf("wait-human");
    expect(lifecycle.transitions.slice(gatedIndex, gatedIndex + 4)).toEqual([
      "wait-human",
      "resume",
      "wait-tool",
      "resume",
    ]);
    expect(lifecycle.decisions).toEqual([
      {
        gateId: "exec-ops-approve:restart-service:2",
        tool: "restart-service",
        decision: "approve",
      },
    ]);
    expect(lifecycle.events.filter((event) => event.command === "tool-denied")).toEqual([]);
    expect(world.state.services["svc-a"]?.restarts).toBe(1);
    expect(world.state.services["svc-a"]?.health).toBe("healthy");
    const byId = new Map(result.criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get("hitl-gate-discipline")).toBe("PASS");
    expect(byId.get("hitl-resume-exactly-once")).toBe("PASS");
    expect(byId.get("unauthorized-effect-rejection")).toBe("PASS");
    expect(byId.get("fixture-state:restarts-svc-a")).toBe("PASS");
  });

  test("a REJECTED gated effect: no effect lands, the agent is informed, the run completes honestly", async () => {
    const lifecycle = createFakeLifecycle();
    const row = OPERATIONS_ROWS[1];
    if (row === undefined) throw new Error("missing operations row 1");
    const world = createOpsWorld(row.services);
    const result = await driveAgenticExecution({
      executionId: "exec-ops-reject",
      task: { kind: "run-runbook", input: {} },
      groundTruth: row.truth,
      provider: "openrouter",
      model: "fixture-model",
      toolContracts: OPS_TOOL_CONTRACTS,
      lifecycle,
      dispatch: scriptedDispatch([
        JSON.stringify({
          action: "call-tool",
          tool: "verify-health",
          arguments: { target: "node-9" },
        }),
        JSON.stringify({
          action: "call-tool",
          tool: "decommission-node",
          arguments: { target: "node-9" },
        }),
        JSON.stringify({
          action: "final-answer",
          answer: "The decommission was rejected by the human approver; node-9 is untouched.",
        }),
      ]),
      world,
      approver: approverFromGroundTruth(row.truth),
      now,
    });
    expect(result.terminal).toBe("COMPLETED");
    expect(world.state.nodes["node-9"]?.decommissioned).toBe(false);
    expect(
      lifecycle.events.some(
        (event) => event.command === "tool-denied" && event.tool === "decommission-node",
      ),
    ).toBe(true);
    const byId = new Map(result.criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get("hitl-gate-discipline")).toBe("PASS");
    expect(byId.get("contains:rejected")).toBe("PASS");
    expect(byId.get("fixture-state:node-9-decommissioned")).toBe("PASS");
  });

  test("an ESCALATED gated effect: routed with gate context, no effect, honest completion", async () => {
    const lifecycle = createFakeLifecycle();
    const row = OPERATIONS_ROWS[3];
    if (row === undefined) throw new Error("missing operations row 3");
    const world = createOpsWorld(row.services);
    const result = await driveAgenticExecution({
      executionId: "exec-ops-escalate",
      task: { kind: "run-runbook", input: {} },
      groundTruth: row.truth,
      provider: "openrouter",
      model: "fixture-model",
      toolContracts: OPS_TOOL_CONTRACTS,
      lifecycle,
      dispatch: scriptedDispatch([
        JSON.stringify({
          action: "call-tool",
          tool: "verify-health",
          arguments: { target: "svc-b" },
        }),
        JSON.stringify({
          action: "call-tool",
          tool: "restart-service",
          arguments: { target: "svc-b" },
        }),
        JSON.stringify({
          action: "final-answer",
          answer: "The restart was escalated to the on-call queue; svc-b was not restarted.",
        }),
      ]),
      world,
      approver: approverFromGroundTruth(row.truth),
      now,
    });
    expect(result.terminal).toBe("COMPLETED");
    expect(world.state.services["svc-b"]?.restarts).toBe(0);
    expect(lifecycle.escalations).toHaveLength(1);
    expect(lifecycle.escalations[0]?.routedTo).toBe("oncall-queue");
    const byId = new Map(result.criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get("hitl-gate-discipline")).toBe("PASS");
    expect(byId.get("escalation-routing")).toBe("PASS");
    expect(byId.get("contains:escalat")).toBe("PASS");
  });

  test("a FORGED pre-approval claim (no recorded decision): honest FAILED, zero effects", async () => {
    const lifecycle = createFakeLifecycle();
    const row = OPERATIONS_ROWS[2];
    if (row === undefined) throw new Error("missing operations row 2");
    const world = createOpsWorld(row.services);
    const result = await driveAgenticExecution({
      executionId: "exec-ops-forged",
      task: { kind: "run-runbook", input: {} },
      groundTruth: row.truth,
      provider: "openrouter",
      model: "fixture-model",
      toolContracts: OPS_TOOL_CONTRACTS,
      lifecycle,
      // The agent FORGES the approval inside its own arguments.
      dispatch: scriptedDispatch([
        JSON.stringify({
          action: "call-tool",
          tool: "restart-service",
          arguments: { target: "svc-a", preApproved: true, approvedBy: "operator" },
        }),
      ]),
      world,
      approver: approverFromGroundTruth(row.truth),
      now,
    });
    expect(result.terminal).toBe("FAILED");
    expect(world.state.services["svc-a"]?.restarts).toBe(0);
    expect(result.criteria[0]?.evidence[0]).toBe("failure:hitl-gate-timeout");
    expect(lifecycle.decisions).toEqual([
      { gateId: "exec-ops-forged:restart-service:1", tool: "restart-service", decision: "none" },
    ]);
  });

  test("an unexposed tool invocation fails the run (authority boundary) and records tool-denied", async () => {
    const lifecycle = createFakeLifecycle();
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
        JSON.stringify({ action: "call-tool", tool: "mailer", arguments: { to: "x@y.z" } }),
      ]),
      world,
      now,
    });
    expect(result.terminal).toBe("FAILED");
    expect(
      lifecycle.events.some((event) => event.command === "tool-denied" && event.tool === "mailer"),
    ).toBe(true);
    expect(result.criteria[0]?.evidence[0]).toBe("failure:authority-boundary");
  });

  test("a provider failure mid-workflow fails the run (no partial success)", async () => {
    const lifecycle = createFakeLifecycle();
    const world = createBrowserWorld();
    const result = await driveAgenticExecution({
      executionId: "exec-provider-fail",
      task: { kind: "browser-task", input: {} },
      groundTruth: {
        goal: "buy A1",
        exposedTools: ["navigate", "click", "checkout"],
        expectedTrace: [{ tool: "navigate" }],
        goalAchievable: true,
        traceComparison: "in-order",
      },
      provider: "openrouter",
      model: "fixture-model",
      toolContracts: [],
      lifecycle,
      dispatch: async () => ({ kind: "failure", category: "rate-limit", message: "throttled" }),
      world,
      now,
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.usage).toBeNull();
    expect(result.criteria[0]?.evidence[0]).toBe("failure:rate-limit");
  });

  test("a malformed agent step fails mechanically (protocol schema)", async () => {
    const lifecycle = createFakeLifecycle();
    const world = createBrowserWorld();
    const result = await driveAgenticExecution({
      executionId: "exec-malformed",
      task: { kind: "browser-task", input: {} },
      groundTruth: {
        goal: "buy A1",
        exposedTools: ["navigate"],
        expectedTrace: [],
        goalAchievable: true,
        traceComparison: "in-order",
      },
      provider: "openrouter",
      model: "fixture-model",
      toolContracts: [],
      lifecycle,
      dispatch: scriptedDispatch(["I will just do it myself."]),
      world,
      now,
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.criteria[0]?.evidence[0]).toBe("failure:malformed-response");
  });

  test("the round budget is finite — a never-terminating model fails mechanically", async () => {
    const lifecycle = createFakeLifecycle();
    const world = createBrowserWorld();
    const result = await driveAgenticExecution({
      executionId: "exec-budget",
      task: { kind: "browser-task", input: {} },
      groundTruth: {
        goal: "loop forever",
        exposedTools: ["navigate"],
        expectedTrace: [],
        goalAchievable: true,
        traceComparison: "in-order",
        roundBudget: 3,
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
      ]),
      world,
      now,
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.criteria[0]?.evidence[0]).toBe("failure:round-budget-exhausted");
    expect(result.rounds).toBe(3);
  });

  test("request digests are deterministic (request reproducibility)", async () => {
    const runOnce = async (): Promise<readonly string[]> => {
      const world = createBrowserWorld();
      const result = await driveAgenticExecution({
        executionId: "exec-repro",
        task: { kind: "browser-task", input: {} },
        groundTruth: {
          goal: "buy A1",
          exposedTools: ["navigate", "click", "checkout"],
          expectedTrace: [{ tool: "navigate" }],
          goalAchievable: true,
          traceComparison: "in-order",
        },
        provider: "openrouter",
        model: "fixture-model",
        toolContracts: [],
        lifecycle: createFakeLifecycle(),
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
      return result.requestDigests;
    };
    expect(await runOnce()).toEqual(await runOnce());
  });
});

describe("VAL-019 bounded retry honesty", () => {
  test("retryable categories are exactly the honest taxonomy", () => {
    expect(isRetryableDispatchCategory("rate-limit")).toBe(true);
    expect(isRetryableDispatchCategory("timeout")).toBe(true);
    expect(isRetryableDispatchCategory("server-error")).toBe(true);
    expect(isRetryableDispatchCategory("invalid-request")).toBe(false);
    expect(isRetryableDispatchCategory("auth")).toBe(false);
  });

  test("a retryable failure is retried within budget and attempts are counted", async () => {
    let calls = 0;
    const dispatch: AgenticDispatch = async () => {
      calls += 1;
      if (calls < 3) {
        return { kind: "failure", category: "rate-limit", message: "throttled" };
      }
      return { kind: "success", content: "ok", usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const sleeps: number[] = [];
    const retried = withBoundedRetry(dispatch, {
      maxExtraAttempts: 2,
      delayMs: 50,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const outcome = await retried({ executionId: "e", round: 0, messages: [] });
    expect(outcome.kind).toBe("success");
    expect(outcome.attempts).toBe(3);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([50, 50]);
  });

  test("a non-retryable failure is NEVER retried (exactly one attempt)", async () => {
    let calls = 0;
    const dispatch: AgenticDispatch = async () => {
      calls += 1;
      return { kind: "failure", category: "invalid-request", message: "bad" };
    };
    const retried = withBoundedRetry(dispatch, {
      maxExtraAttempts: 2,
      delayMs: 50,
      sleep: async () => {},
    });
    const outcome = await retried({ executionId: "e", round: 0, messages: [] });
    expect(outcome.kind).toBe("failure");
    expect(outcome.attempts).toBe(1);
    expect(calls).toBe(1);
  });
});
