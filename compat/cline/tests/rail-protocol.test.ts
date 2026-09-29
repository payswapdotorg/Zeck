/**
 * PPR-019 rail-protocol tests — both sides of the documented wire
 * protocol between the rail worker and the supply rail (envelope
 * encode/decode roundtrip, fail-closed decoding, task parsing, the
 * normalized structured turn, stop-reason mapping).
 */

import { describe, expect, test } from "vitest";
import {
  buildRailEnvelope,
  CLINE_TASK_KIND,
  decodeModelRequest,
  encodeModelRequest,
  hasImagePart,
  parseClineCompletionTask,
  RAIL_ENVELOPE_PREFIX,
  reasoningEffortOf,
  turnOfStructuredOutput,
  type ClineCompletionTask,
} from "../harness/rail-protocol";

const TASK: ClineCompletionTask = {
  kind: CLINE_TASK_KIND,
  edge: "cline.agent-loop.act",
  role: "main",
  model: "glm-4-plus",
  messages: [
    { role: "system", content: "You are Cline." },
    { role: "user", content: "Add a function." },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "read_files", arguments: "{\"paths\":[\"a.js\"]}" } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "file body" },
  ],
  tools: [
    {
      type: "function",
      function: { name: "read_files", description: "Read files", parameters: { type: "object" } },
    },
  ],
  params: { temperature: 0.2, maxTokens: 4096, reasoningEffort: "high", stream: true },
};

describe("PPR-019 task payload parsing", () => {
  test("a well-formed task parses with full fidelity", () => {
    const parsed = parseClineCompletionTask(TASK as unknown as Record<string, unknown>);
    expect(parsed).not.toBeNull();
    expect(parsed?.edge).toBe("cline.agent-loop.act");
    expect(parsed?.tools?.length).toBe(1);
    expect(parsed?.messages.length).toBe(4);
    expect(parsed?.params?.reasoningEffort).toBe("high");
  });

  test("wrong kind / empty messages / missing model fail closed", () => {
    expect(parseClineCompletionTask({ ...TASK, kind: "other" } as unknown as Record<string, unknown>)).toBeNull();
    expect(parseClineCompletionTask({ ...TASK, messages: [] } as unknown as Record<string, unknown>)).toBeNull();
    expect(parseClineCompletionTask({ ...TASK, model: "" } as unknown as Record<string, unknown>)).toBeNull();
  });
});

describe("PPR-019 rail envelope", () => {
  test("encode → decode roundtrips the full wire payload", () => {
    const envelope = buildRailEnvelope(TASK);
    expect(envelope.vision).toBe(false);
    const request = encodeModelRequest(envelope, "glm-4-plus");
    expect(request.messages.length).toBe(1);
    expect(request.messages[0]?.role).toBe("user");
    expect(request.messages[0]?.content.startsWith(RAIL_ENVELOPE_PREFIX)).toBe(true);
    const decoded = decodeModelRequest(request);
    expect(decoded.messages).toEqual(TASK.messages);
    expect(decoded.tools).toEqual(TASK.tools);
    expect(decoded.params).toEqual(TASK.params);
    expect(decoded.vision).toBe(false);
  });

  test("an envelope carrying image parts flags vision", () => {
    const visionTask: ClineCompletionTask = {
      ...TASK,
      messages: [
        { role: "user", content: [{ type: "text", text: "color?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] },
      ],
    };
    const envelope = buildRailEnvelope(visionTask);
    expect(envelope.vision).toBe(true);
    expect(decodeModelRequest(encodeModelRequest(envelope, "glm-4.5v")).vision).toBe(true);
  });

  test("decoding fails closed on a non-enveloped request", () => {
    expect(() =>
      decodeModelRequest({
        model: "m",
        messages: [{ role: "user", content: "bare text" }],
      }),
    ).toThrow(/rail protocol violation/);
    expect(() =>
      decodeModelRequest({
        model: "m",
        messages: [
          { role: "user", content: `${RAIL_ENVELOPE_PREFIX}{"messages":[]}` },
        ],
      }),
    ).toThrow(/no messages/);
  });

  test("the reasoning effort extraction", () => {
    expect(reasoningEffortOf(buildRailEnvelope(TASK))).toBe("high");
    expect(reasoningEffortOf(buildRailEnvelope({ ...TASK, params: {} }))).toBeNull();
  });

  test("image-part detection is shape-precise", () => {
    expect(hasImagePart({ role: "user", content: "text only" })).toBe(false);
    expect(hasImagePart({ role: "user", content: [{ type: "text", text: "t" }] })).toBe(false);
    expect(
      hasImagePart({ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }),
    ).toBe(true);
    expect(hasImagePart("not a message")).toBe(false);
  });
});

describe("PPR-019 normalized structured turn", () => {
  test("the turn projection recovers content, tool calls and finish reason", () => {
    const turn = turnOfStructuredOutput({
      name: "cline-agent-turn",
      json: {
        content: "I'll read the file.",
        toolCalls: [{ id: "call_9", type: "function", function: { name: "read_files", arguments: "{}" } }],
        finishReason: "tool_calls",
      },
    });
    expect(turn).not.toBeNull();
    expect(turn?.content).toBe("I'll read the file.");
    expect(turn?.toolCalls.length).toBe(1);
    expect(turn?.finishReason).toBe("tool_calls");
  });

  test("a foreign or malformed structured output projects to null (never a guess)", () => {
    expect(turnOfStructuredOutput(null)).toBeNull();
    expect(turnOfStructuredOutput({ name: "other", json: {} })).toBeNull();
    expect(
      turnOfStructuredOutput({ name: "cline-agent-turn", json: { content: 5, finishReason: "stop" } }),
    ).toBeNull();
    // toolCalls filtering: malformed entries drop, valid ones stay
    const turn = turnOfStructuredOutput({
      name: "cline-agent-turn",
      json: { content: "x", finishReason: "stop", toolCalls: [{ id: "a" }, { bad: true }] },
    });
    expect(turn?.toolCalls).toEqual([]);
  });
});
