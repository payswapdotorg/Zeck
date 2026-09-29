/**
 * PPR-020 rail-protocol tests — the version-pinned request envelope and
 * the normalized structured turn, pinned on both sides of the
 * rail-worker ↔ supply-rail translation.
 */

import { describe, expect, test } from "vitest";
import {
  buildRailEnvelope,
  decodeModelRequest,
  encodeModelRequest,
  hasImagePart,
  normalizeStopReason,
  OPENHANDS_TASK_KIND,
  OPENHANDS_TURN_NAME,
  OPENHANDS_TURN_SCHEMA,
  parseOpenHandsCompletionTask,
  RAIL_ENVELOPE_PREFIX,
  railFailure,
  reasoningEffortOf,
  successOutcomeOfTurn,
  turnOfStructuredOutput,
} from "../harness/rail-protocol";

const TASK = {
  kind: OPENHANDS_TASK_KIND,
  edge: "openhands.agent-loop.main",
  role: "main",
  model: "glm-4-plus",
  messages: [
    { role: "system", content: "You are OpenHands agent." },
    { role: "user", content: "Run the command." },
  ],
  tools: [
    {
      type: "function",
      function: { name: "terminal", description: "run a command", parameters: { type: "object" } },
    },
  ],
  params: { temperature: 0.2, maxTokens: 1024, reasoningEffort: "medium" },
} as const;

describe("PPR-020 rail protocol — task payload", () => {
  test("a well-formed task parses", () => {
    const parsed = parseOpenHandsCompletionTask(TASK as unknown as Record<string, unknown>);
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe(OPENHANDS_TASK_KIND);
    expect(parsed?.tools).toHaveLength(1);
    expect(parsed?.role).toBe("main");
  });

  test("an alien task kind is rejected (fail closed)", () => {
    expect(parseOpenHandsCompletionTask({ kind: "ide-agent.completion", edge: "x", model: "m", messages: [{ role: "user", content: "hi" }] })).toBeNull();
  });

  test("a task without messages is rejected", () => {
    expect(
      parseOpenHandsCompletionTask({
        kind: OPENHANDS_TASK_KIND,
        edge: "openhands.agent-loop.main",
        model: "m",
        messages: [],
      }),
    ).toBeNull();
  });
});

describe("PPR-020 rail protocol — request envelope", () => {
  test("the envelope round-trips through a single user message", () => {
    const envelope = buildRailEnvelope(
      parseOpenHandsCompletionTask(TASK as unknown as Record<string, unknown>)!,
    );
    expect(envelope.vision).toBe(false);
    const request = encodeModelRequest(envelope, "glm-4-plus");
    expect(request.model).toBe("glm-4-plus");
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]?.role).toBe("user");
    expect(request.messages[0]?.content.startsWith(RAIL_ENVELOPE_PREFIX)).toBe(true);
    const decoded = decodeModelRequest(request);
    expect(decoded.messages).toHaveLength(2);
    expect(decoded.tools).toHaveLength(1);
    expect(decoded.params?.maxTokens).toBe(1024);
    expect(decoded.vision).toBe(false);
  });

  test("a vision-carrying task marks the envelope for vision routing", () => {
    const task = {
      ...TASK,
      messages: [
        { role: "system", content: "sys" },
        {
          role: "user",
          content: [
            { type: "text", text: "color?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ],
    };
    const envelope = buildRailEnvelope(
      parseOpenHandsCompletionTask(task as unknown as Record<string, unknown>)!,
    );
    expect(envelope.vision).toBe(true);
    expect(hasImagePart(task.messages[1])).toBe(true);
  });

  test("a malformed envelope is rejected with a named error", () => {
    expect(() =>
      decodeModelRequest({
        model: "m",
        messages: [{ role: "user", content: "not-an-envelope" }],
      }),
    ).toThrow(/rail protocol violation/);
  });

  test("the reasoning effort is extracted from the envelope params", () => {
    const envelope = buildRailEnvelope(
      parseOpenHandsCompletionTask(TASK as unknown as Record<string, unknown>)!,
    );
    expect(reasoningEffortOf(envelope)).toBe("medium");
  });
});

describe("PPR-020 rail protocol — response turn", () => {
  test("a normalized turn round-trips through the structured output", () => {
    const outcome = successOutcomeOfTurn({
      turn: {
        content: "I will run the command.",
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "terminal", arguments: "{\"command\":\"ls\"}" },
          },
        ],
        finishReason: "tool_calls",
      },
      stopReason: "tool_calls",
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      providerLatencyMs: 42,
    });
    expect(outcome.kind).toBe("provider-success");
    if (outcome.kind !== "provider-success") {
      throw new Error("expected provider-success");
    }
    const turn = turnOfStructuredOutput(outcome.response.structuredOutput);
    expect(turn).not.toBeNull();
    expect(turn?.content).toBe("I will run the command.");
    expect(turn?.toolCalls).toHaveLength(1);
    expect(turn?.finishReason).toBe("tool_calls");
    expect(outcome.response.stopReason).toBe("tool-use");
    expect(outcome.response.usage.inputTokens).toBe(100);
  });

  test("an alien structured-output name is ignored", () => {
    expect(
      turnOfStructuredOutput({ name: "something-else", json: { content: "x", toolCalls: [], finishReason: "stop" } }),
    ).toBeNull();
  });

  test("the stop-reason vocabulary maps OpenAI finish reasons", () => {
    expect(normalizeStopReason("stop")).toBe("stop");
    expect(normalizeStopReason("length")).toBe("length");
    expect(normalizeStopReason("tool_calls")).toBe("tool-use");
    expect(normalizeStopReason("content_filter")).toBe("other");
  });

  test("the turn schema requires content, toolCalls and finishReason", () => {
    const schema = OPENHANDS_TURN_SCHEMA as { required: string[] };
    expect(schema.required).toEqual(["content", "toolCalls", "finishReason"]);
    expect(OPENHANDS_TURN_NAME).toBe("openhands-agent-turn");
  });

  test("the rail failure carries the retryability policy", () => {
    const retryable = railFailure("rate-limit", "boom", 429, 10, "custom");
    expect(retryable.failure.retryable).toBe(true);
    const fatal = railFailure("invalid-request", "bad", 400, 5, "custom");
    expect(fatal.failure.retryable).toBe(false);
    expect(fatal.failure.providerCode).toBe("400");
  });
});