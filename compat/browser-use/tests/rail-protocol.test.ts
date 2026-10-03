/**
 * PPR-024 rail-protocol test — the two-plane task payloads parse
 * fail-closed, the model-plane envelope encodes/decodes round-trip, the
 * json-fence normalization is pure and non-destructive, and the vision
 * routing detection holds.
 */

import { describe, expect, test } from "vitest";
import {
  ACTION_TASK_KIND,
  BROWSER_USE_TURN_SCHEMA,
  buildRailEnvelope,
  COMPLETION_TASK_KIND,
  decodeModelRequest,
  encodeModelRequest,
  hasImagePart,
  normalizeStopReason,
  parseBrowserUseTask,
  SESSION_TASK_KIND,
  STATE_TASK_KIND,
  stripJsonFence,
  turnOfStructuredOutput,
  type BrowserUseCompletionTask,
} from "../harness/rail-protocol";
import type { ModelRequest } from "../../../src/modules/models/domain/request";

const completionTask = (messages: unknown[]): BrowserUseCompletionTask => ({
  kind: COMPLETION_TASK_KIND,
  edge: "browseruse.agent-loop.main",
  role: "main",
  model: "glm-4-plus",
  messages,
});

describe("PPR-024 task payload parsing (fail-closed)", () => {
  test("a well-formed completion task parses", () => {
    const task = parseBrowserUseTask({
      kind: COMPLETION_TASK_KIND,
      edge: "browseruse.agent-loop.main",
      role: "main",
      model: "glm-4-plus",
      messages: [{ role: "user", content: "hi" }],
      params: { temperature: 0.2, responseFormat: { type: "json_schema" } },
    });
    expect(task?.kind).toBe(COMPLETION_TASK_KIND);
    expect((task as BrowserUseCompletionTask).role).toBe("main");
    expect((task as BrowserUseCompletionTask).params?.temperature).toBe(0.2);
  });

  test("a completion task without messages is rejected", () => {
    expect(
      parseBrowserUseTask({
        kind: COMPLETION_TASK_KIND,
        edge: "browseruse.agent-loop.main",
        model: "glm-4-plus",
        messages: [],
      }),
    ).toBeNull();
  });

  test("session open/close tasks parse (both ops)", () => {
    const open = parseBrowserUseTask({
      kind: SESSION_TASK_KIND,
      edge: "browseruse.substrate.session",
      op: "open",
      profile: { headless: true, chromeExecutablePath: "/chromium" },
    });
    expect(open?.kind).toBe(SESSION_TASK_KIND);
    expect((open as { op: string }).op).toBe("open");
    const close = parseBrowserUseTask({
      kind: SESSION_TASK_KIND,
      edge: "browseruse.substrate.session",
      op: "close",
      sessionId: "substrate-abc",
    });
    expect((close as { op: string }).op).toBe("close");
  });

  test("an unknown session op is rejected", () => {
    expect(
      parseBrowserUseTask({ kind: SESSION_TASK_KIND, edge: "e", op: "restart" }),
    ).toBeNull();
  });

  test("state and action tasks parse with their session scoping", () => {
    const state = parseBrowserUseTask({
      kind: STATE_TASK_KIND,
      edge: "browseruse.substrate.state-extraction",
      sessionId: "substrate-abc",
      includeScreenshot: true,
      cached: false,
      includeRecentEvents: false,
    });
    expect(state?.kind).toBe(STATE_TASK_KIND);
    const action = parseBrowserUseTask({
      kind: ACTION_TASK_KIND,
      edge: "browseruse.substrate.action",
      sessionId: "substrate-abc",
      action: { click: { index: 4 } },
    });
    expect(action?.kind).toBe(ACTION_TASK_KIND);
    expect((action as { action: Record<string, unknown> }).action).toEqual({
      click: { index: 4 },
    });
  });

  test("substrate tasks without a session id are rejected", () => {
    expect(
      parseBrowserUseTask({ kind: STATE_TASK_KIND, edge: "e", includeScreenshot: true }),
    ).toBeNull();
    expect(parseBrowserUseTask({ kind: ACTION_TASK_KIND, edge: "e", action: {} })).toBeNull();
  });

  test("unknown kinds are rejected", () => {
    expect(parseBrowserUseTask({ kind: "browseruse.unknown", edge: "e" })).toBeNull();
  });
});

describe("PPR-024 model-plane envelope", () => {
  test("encodes and decodes round-trip (prefix-pinned, never a bare message)", () => {
    const task = completionTask([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
    const envelope = buildRailEnvelope(task);
    const request: ModelRequest = encodeModelRequest(envelope, "glm-4-plus");
    const decoded = decodeModelRequest(request);
    expect(decoded.kind).toBe("completion");
    expect(decoded.messages).toEqual(task.messages);
    expect(decoded.vision).toBe(false);
    expect(request.structuredOutput?.name).toBe("browseruse-agent-turn");
  });

  test("an unenveloped request is rejected (fail-closed)", () => {
    expect(() =>
      decodeModelRequest({
        model: "glm-4-plus",
        messages: [{ role: "user", content: "bare" }],
      }),
    ).toThrow(/rail protocol violation/);
  });

  test("vision routing detection: image content parts set the vision flag", () => {
    const task = completionTask([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        ],
      },
    ]);
    expect(buildRailEnvelope(task).vision).toBe(true);
    expect(hasImagePart(task.messages[0])).toBe(true);
    expect(hasImagePart({ role: "user", content: "plain" })).toBe(false);
  });

  test("the turn schema requires content, toolCalls and finishReason", () => {
    const required = BROWSER_USE_TURN_SCHEMA.required as readonly string[];
    expect([...required].sort()).toEqual(["content", "finishReason", "toolCalls"]);
  });

  test("a normalized turn reads back from the structured output", () => {
    const turn = turnOfStructuredOutput({
      name: "browseruse-agent-turn",
      json: { content: '{"ok":true}', toolCalls: [], finishReason: "stop" },
    });
    expect(turn?.content).toBe('{"ok":true}');
    expect(turnOfStructuredOutput({ name: "other", json: {} })).toBeNull();
    expect(turnOfStructuredOutput(null)).toBeNull();
  });
});

describe("PPR-024 provider-shape normalization (the fence strip)", () => {
  test("strips a markdown-fenced JSON body", () => {
    expect(stripJsonFence('```json\n{"ok": true}\n```')).toBe('{"ok": true}');
    expect(stripJsonFence('```\n{"ok": 1}\n```')).toBe('{"ok": 1}');
  });

  test("passes non-fenced content through verbatim (non-destructive)", () => {
    expect(stripJsonFence('{"ok": true}')).toBe('{"ok": true}');
    expect(stripJsonFence("plain text")).toBe("plain text");
  });

  test("never strips a fence whose body is not JSON (honest passthrough)", () => {
    const notJson = "```python\nprint('hi')\n```";
    expect(stripJsonFence(notJson)).toBe(notJson);
  });
});

describe("PPR-024 stop-reason mapping", () => {
  test("maps the OpenAI finish reasons onto the platform vocabulary", () => {
    expect(normalizeStopReason("stop")).toBe("stop");
    expect(normalizeStopReason("length")).toBe("length");
    expect(normalizeStopReason("tool_calls")).toBe("tool-use");
    expect(normalizeStopReason("content_filter")).toBe("other");
  });
});
