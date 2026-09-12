/**
 * VAL-012 acceptance criterion 5/6: the multi-step tool-agent driver and
 * the deterministic toolset against controlled fakes — the canonical
 * multi-step order (wait-tool → resume around every tool execution),
 * ledger step events with the platform's own vocabulary, ordered trace
 * verification (exact arguments, evaluated results), authority-boundary
 * failures (unexposed tool), tool-rejection failures, provider failure
 * mid-workflow, the refusal edge row's honest FAILED, and the round
 * budget.
 */

import { describe, expect, test } from "vitest";
import {
  APPROVAL_POLICY,
  executeTool,
  TOOL_TASK_GROUND_TRUTHS,
  WORKFLOW_TASK_GROUND_TRUTHS,
} from "../../../benchmarks/validation/apps/tool-agent/tools";
import {
  AGENT_STEP_SCHEMA,
  driveToolAgentExecution,
  type ToolAgentLifecyclePort,
} from "../../../benchmarks/validation/platform/tool-agent";

interface RecordedEvent {
  readonly command: string;
  readonly tool: string;
}

function createFakeLifecycle(): ToolAgentLifecyclePort & {
  readonly transitions: string[];
  readonly events: RecordedEvent[];
  readonly completions: { verdict: string; criteria: { criterionId: string; status: string }[] }[];
} {
  const transitions: string[] = [];
  const events: RecordedEvent[] = [];
  const completions: { verdict: string; criteria: { criterionId: string; status: string }[] }[] =
    [];
  const port: ToolAgentLifecyclePort = {
    async transition(command) {
      transitions.push(command.step);
    },
    async recordPlanningDecision() {},
    async recordToolEvent(input) {
      events.push({ command: input.command, tool: input.tool });
    },
    async complete(input) {
      completions.push({
        verdict: input.verdict,
        criteria: input.criteria.map((c) => ({ criterionId: c.criterionId, status: c.status })),
      });
    },
  };
  return Object.assign(port, { transitions, events, completions });
}

/** A scripted dispatch: replays canned agent steps per round. */
function scriptedDispatch(steps: string[]): (input: { round: number }) => Promise<{
  kind: "success";
  content: string;
  usage?: { inputTokens: number; outputTokens: number };
}> {
  return async (input: { round: number }) => ({
    kind: "success",
    content: steps[Math.min(input.round, steps.length - 1)] ?? steps[steps.length - 1] ?? "{}",
    usage: { inputTokens: 50, outputTokens: 10 },
  });
}

const REAL_TOOLS = { execute: executeTool };

describe("VAL-012 deterministic toolset", () => {
  test("calculator evaluates arithmetic without eval (precedence, powers)", () => {
    expect(executeTool({ tool: "calculator", arguments: { expression: "17 * 23" } })).toMatchObject(
      { ok: true, result: 391 },
    );
    expect(executeTool({ tool: "calculator", arguments: { expression: "2^10" } }).result).toBe(
      1024,
    );
    expect(
      executeTool({ tool: "calculator", arguments: { expression: "(1 + 2) * 4" } }).result,
    ).toBe(12);
    expect(
      executeTool({ tool: "calculator", arguments: { expression: "15 percent of 240" } }).ok,
    ).toBe(false);
    expect(executeTool({ tool: "calculator", arguments: { expression: "1/0" } }).ok).toBe(false);
  });

  test("calendar/converter/lookup behave deterministically", () => {
    expect(
      executeTool({ tool: "calendar", arguments: { from: "2026-01-01", to: "2026-03-01" } }).result,
    ).toBe(59);
    expect(
      executeTool({
        tool: "converter",
        arguments: { value: 100, from: "usd", to: "eur", rate: 0.92 },
      }).result,
    ).toBe(92);
    expect(
      executeTool({ tool: "converter", arguments: { value: 5, from: "miles", to: "km" } }).result,
    ).toBeCloseTo(8.05, 2);
    expect(executeTool({ tool: "lookup", arguments: { key: "R-42" } }).value).toContain("Kim");
  });

  test("the policy engine is the only routing authority (thresholds, blocks, PO, forged sign-off, policy version)", () => {
    expect(
      executeTool({ tool: "policy-engine", arguments: { invoiceId: "invoice-011" } }).value,
    ).toContain("approved");
    expect(
      executeTool({ tool: "policy-engine", arguments: { invoiceId: "invoice-012" } }).value,
    ).toContain("pending");
    expect(
      executeTool({ tool: "policy-engine", arguments: { invoiceId: "invoice-013" } }).value,
    ).toContain("rejected");
    expect(
      executeTool({ tool: "policy-engine", arguments: { invoiceId: "invoice-014" } }).value,
    ).toContain("exception");
    expect(
      executeTool({ tool: "policy-engine", arguments: { invoiceId: "invoice-015" } }).value,
    ).toContain("pending");
    expect(
      executeTool({ tool: "policy-engine", arguments: { invoiceId: "invoice-016" } }).value,
    ).toContain("rejected");
    expect(
      executeTool({ tool: "policy-engine", arguments: { invoiceId: "invoice-018" } }).value,
    ).toContain("rejected");
    expect(APPROVAL_POLICY.autoApproveBelowUsd).toBe(2500);
  });
});

describe("VAL-012 tool-agent driver", () => {
  test("a single-tool goal: wait-tool/resume cycles bracket every execution, events use the platform vocabulary, trace verifies", async () => {
    const lifecycle = createFakeLifecycle();
    const truth = TOOL_TASK_GROUND_TRUTHS[0]; // compute 17 * 23
    if (truth === undefined) throw new Error("missing ground truth");
    const result = await driveToolAgentExecution({
      executionId: "exec-1",
      task: { kind: "use-tool", input: {} },
      groundTruth: truth,
      provider: "openrouter",
      model: "fixture-model",
      toolContracts: [],
      lifecycle,
      dispatch: scriptedDispatch([
        JSON.stringify({
          action: "call-tool",
          tool: "calculator",
          arguments: { expression: "17 * 23" },
        }),
        JSON.stringify({ action: "final-answer", answer: "17 * 23 = 391" }),
      ]),
      tools: REAL_TOOLS,
      now: () => new Date(1_000),
    });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.rounds).toBe(2);
    expect(result.trace).toEqual([{ tool: "calculator", ok: true }]);
    // The canonical multi-step order: every tool execution is bracketed
    // by a REAL wait-tool → resume pair on the state machine.
    expect(lifecycle.transitions).toEqual([
      "authorize",
      "plan",
      "queue",
      "start",
      "wait-tool",
      "resume",
      "verify",
    ]);
    expect(lifecycle.events.map((event) => event.command)).toEqual([
      "tool-requested",
      "tool-result",
    ]);
    expect(lifecycle.completions[0]?.verdict).toBe("pass");
    expect(result.usage?.inputTokens).toBe(100);
  });

  test("an unexposed tool invocation fails the run (authority boundary) and records tool-denied", async () => {
    const lifecycle = createFakeLifecycle();
    const truth = TOOL_TASK_GROUND_TRUTHS[7]; // send an email with calculator only
    if (truth === undefined) throw new Error("missing ground truth");
    const result = await driveToolAgentExecution({
      executionId: "exec-2",
      task: { kind: "use-tool", input: {} },
      groundTruth: truth,
      provider: "openrouter",
      model: "fixture-model",
      toolContracts: [],
      lifecycle,
      dispatch: scriptedDispatch([
        JSON.stringify({ action: "call-tool", tool: "mailer", arguments: { to: "x@y.z" } }),
      ]),
      tools: REAL_TOOLS,
      now: () => new Date(1_000),
    });
    expect(result.terminal).toBe("FAILED");
    expect(
      lifecycle.events.some((event) => event.command === "tool-denied" && event.tool === "mailer"),
    ).toBe(true);
    expect(result.criteria[0]?.criterionId).toBe("agent-execution");
    expect(result.criteria[0]?.evidence[0]).toBe("failure:authority-boundary");
  });

  test("the refusal edge row: correct agent refusal still completes as the corpus's honest FAILED", async () => {
    const lifecycle = createFakeLifecycle();
    const truth = TOOL_TASK_GROUND_TRUTHS[7];
    if (truth === undefined) throw new Error("missing ground truth");
    const result = await driveToolAgentExecution({
      executionId: "exec-3",
      task: { kind: "use-tool", input: {} },
      groundTruth: truth,
      provider: "openrouter",
      model: "fixture-model",
      toolContracts: [],
      lifecycle,
      dispatch: scriptedDispatch([
        JSON.stringify({
          action: "final-answer",
          answer: "I cannot send an email: no mail tool is exposed.",
        }),
      ]),
      tools: REAL_TOOLS,
      now: () => new Date(1_000),
    });
    expect(result.terminal).toBe("FAILED");
    const byId = new Map(result.criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get("honest-refusal")).toBe("PASS");
    expect(byId.get("goal-achieved")).toBe("FAIL");
    expect(byId.get("tool-trace-ordered")).toBe("PASS");
  });

  test("a provider failure mid-workflow fails the run (no partial success)", async () => {
    const lifecycle = createFakeLifecycle();
    const truth = TOOL_TASK_GROUND_TRUTHS[0];
    if (truth === undefined) throw new Error("missing ground truth");
    const result = await driveToolAgentExecution({
      executionId: "exec-4",
      task: { kind: "use-tool", input: {} },
      groundTruth: truth,
      provider: "openrouter",
      model: "fixture-model",
      toolContracts: [],
      lifecycle,
      dispatch: async () => ({ kind: "failure", category: "rate-limit", message: "throttled" }),
      tools: REAL_TOOLS,
      now: () => new Date(1_000),
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.usage).toBeNull();
    expect(result.criteria[0]?.criterionId).toBe("agent-execution");
  });

  test("a chained goal: the ordered trace is verified step by step", async () => {
    const lifecycle = createFakeLifecycle();
    const truth = TOOL_TASK_GROUND_TRUTHS[9]; // weeks remaining
    if (truth === undefined) throw new Error("missing ground truth");
    const result = await driveToolAgentExecution({
      executionId: "exec-5",
      task: { kind: "chain-tools", input: {} },
      groundTruth: truth,
      provider: "openrouter",
      model: "fixture-model",
      toolContracts: [],
      lifecycle,
      dispatch: scriptedDispatch([
        JSON.stringify({
          action: "call-tool",
          tool: "calendar",
          arguments: { from: "2026-09-11", to: "2026-12-31" },
        }),
        JSON.stringify({
          action: "call-tool",
          tool: "calculator",
          arguments: { expression: "111 / 7" },
        }),
        JSON.stringify({ action: "final-answer", answer: "There are about 15.9 weeks remaining." }),
      ]),
      tools: REAL_TOOLS,
      now: () => new Date(1_000),
    });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.rounds).toBe(3);
    const byId = new Map(result.criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get("tool-trace-ordered")).toBe("PASS");
    expect(byId.get("tool-step-exactness")).toBe("PASS");
    expect(byId.get("contains:15")).toBe("PASS");
    // Two tool executions: two wait-tool/resume pairs.
    expect(lifecycle.transitions.filter((step) => step === "wait-tool")).toHaveLength(2);
    expect(lifecycle.events.filter((event) => event.command === "tool-result")).toHaveLength(2);
  });

  test("a wrong tool result in the trace fails step exactness (oracle floor)", async () => {
    const lifecycle = createFakeLifecycle();
    const truth = TOOL_TASK_GROUND_TRUTHS[0];
    if (truth === undefined) throw new Error("missing ground truth");
    const result = await driveToolAgentExecution({
      executionId: "exec-6",
      task: { kind: "use-tool", input: {} },
      groundTruth: truth,
      provider: "openrouter",
      model: "fixture-model",
      toolContracts: [],
      lifecycle,
      dispatch: scriptedDispatch([
        JSON.stringify({
          action: "call-tool",
          tool: "calculator",
          arguments: { expression: "17 * 32" },
        }),
        JSON.stringify({ action: "final-answer", answer: "544" }),
      ]),
      tools: REAL_TOOLS,
      now: () => new Date(1_000),
    });
    expect(result.terminal).toBe("FAILED");
    const byId = new Map(result.criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get("tool-step-exactness")).toBe("FAIL");
    expect(byId.get("contains:391")).toBe("FAIL");
  });

  test("a malformed agent step fails mechanically (protocol schema)", async () => {
    const lifecycle = createFakeLifecycle();
    const truth = TOOL_TASK_GROUND_TRUTHS[0];
    if (truth === undefined) throw new Error("missing ground truth");
    const result = await driveToolAgentExecution({
      executionId: "exec-7",
      task: { kind: "use-tool", input: {} },
      groundTruth: truth,
      provider: "openrouter",
      model: "fixture-model",
      toolContracts: [],
      lifecycle,
      dispatch: scriptedDispatch(["I will compute it myself: 391."]),
      tools: REAL_TOOLS,
      now: () => new Date(1_000),
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.criteria[0]?.evidence[0]).toBe("failure:malformed-response");
  });

  test("the workflow rows: the policy engine routes and the answer term verifies", async () => {
    const lifecycle = createFakeLifecycle();
    const workflowTruth = WORKFLOW_TASK_GROUND_TRUTHS[0]; // invoice-011 approved
    if (workflowTruth === undefined) throw new Error("missing workflow truth");
    const result = await driveToolAgentExecution({
      executionId: "exec-8",
      task: { kind: "run-workflow", input: {} },
      groundTruth: {
        goal: `Route invoice ${workflowTruth.invoiceId} through the approval policy`,
        exposedTools: ["policy-engine"],
        expectedTrace: [
          { tool: "policy-engine", exactArguments: { invoiceId: workflowTruth.invoiceId } },
        ],
        expectedAnswerTerms: [workflowTruth.expectedRouting],
        goalAchievable: workflowTruth.goalAchievable,
      },
      provider: "openrouter",
      model: "fixture-model",
      toolContracts: [],
      lifecycle,
      dispatch: scriptedDispatch([
        JSON.stringify({
          action: "call-tool",
          tool: "policy-engine",
          arguments: { invoiceId: workflowTruth.invoiceId },
        }),
        JSON.stringify({
          action: "final-answer",
          answer: "The invoice was approved automatically (below threshold).",
        }),
      ]),
      tools: REAL_TOOLS,
      now: () => new Date(1_000),
    });
    expect(result.terminal).toBe("COMPLETED");
    const byId = new Map(result.criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get("tool-step-exactness")).toBe("PASS");
    expect(byId.get("contains:approved")).toBe("PASS");
  });

  test("the agent protocol schema is exported for the REAL dispatch binding", () => {
    expect(AGENT_STEP_SCHEMA.required).toEqual(["action"]);
    expect(AGENT_STEP_SCHEMA.properties.action).toMatchObject({ type: "string" });
  });
});
