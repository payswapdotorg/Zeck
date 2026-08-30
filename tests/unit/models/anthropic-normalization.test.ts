/**
 * Unit: Anthropic adapter normalization (WORK-003, CON-004).
 *
 * A DIRECT provider rail behind the same neutral contract — the wire format
 * differs fundamentally from the aggregation rail (x-api-key auth, tool-based
 * structured output, split streaming usage), proving the contract really is
 * provider-neutral.
 */

import { describe, expect, test } from "vitest";
import { createAnthropicAdapter } from "../../../src/modules/models/adapters/anthropic";
import type {
  HttpRequestBody,
  HttpResponse,
  HttpTransport,
} from "../../../src/modules/models/ports/http-transport";
import { textResponse } from "../../../src/modules/models/ports/http-transport";
import type { ProviderDispatchContext } from "../../../src/modules/models/ports/model-provider";

class FakeTransport implements HttpTransport {
  requests: HttpRequestBody[] = [];
  constructor(private readonly respond: (request: HttpRequestBody) => HttpResponse) {}
  async send(request: HttpRequestBody): Promise<HttpResponse> {
    this.requests.push(request);
    return this.respond(request);
  }
}

const CONTEXT: ProviderDispatchContext = {
  endpointUrl: null,
  credential: "sk-ant-api03-test",
  timeoutMs: 5000,
};

const MESSAGES_BODY = {
  id: "msg_01",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "Direct answer" }],
  model: "claude-3-5-sonnet",
  stop_reason: "end_turn",
  usage: { input_tokens: 9, output_tokens: 4 },
};

describe("anthropic adapter — completion normalization", () => {
  test("maps a well-formed Messages response onto the neutral contract", async () => {
    const transport = new FakeTransport(() => textResponse(200, JSON.stringify(MESSAGES_BODY)));
    const adapter = createAnthropicAdapter({ transport });
    const outcome = await adapter.complete(
      { model: "claude-3-5-sonnet", messages: [{ role: "user", content: "hi" }] },
      CONTEXT,
    );
    expect(outcome.kind).toBe("provider-success");
    if (outcome.kind !== "provider-success") return;
    expect(outcome.response.content).toEqual(["Direct answer"]);
    expect(outcome.response.stopReason).toBe("stop");
    expect(outcome.response.usage).toEqual({
      inputTokens: 9,
      outputTokens: 4,
      totalTokens: 13,
      costUsd: null, // this rail reports no USD cost — null, never invented
    });
  });

  test("sends x-api-key + anthropic-version headers and lifts system messages", async () => {
    const transport = new FakeTransport(() => textResponse(200, JSON.stringify(MESSAGES_BODY)));
    const adapter = createAnthropicAdapter({ transport });
    await adapter.complete(
      {
        model: "claude-3-5-sonnet",
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "hi" },
        ],
      },
      CONTEXT,
    );
    const request = transport.requests[0];
    expect(request?.headers["x-api-key"]).toBe("sk-ant-api03-test");
    expect(request?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(request?.url).toBe("https://api.anthropic.com/v1/messages");
    const body = request?.bodyJson as Record<string, unknown>;
    expect(body.system).toBe("be terse");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("structured output rides a forced single tool and extracts tool input", async () => {
    const body = {
      ...MESSAGES_BODY,
      content: [{ type: "tool_use", id: "tu_1", name: "result", input: { answer: 42 } }],
      stop_reason: "tool_use",
    };
    const transport = new FakeTransport(() => textResponse(200, JSON.stringify(body)));
    const adapter = createAnthropicAdapter({ transport });
    const outcome = await adapter.complete(
      {
        model: "claude-3-5-sonnet",
        messages: [{ role: "user", content: "extract" }],
        structuredOutput: { name: "result", schema: { type: "object" } },
      },
      CONTEXT,
    );
    // The forced-tool request shape is this rail's native structured output.
    const wire = transport.requests[0]?.bodyJson as Record<string, unknown>;
    expect(wire.tool_choice).toEqual({ type: "tool", name: "result" });
    expect(wire.tools).toEqual([{ name: "result", input_schema: { type: "object" } }]);

    expect(outcome.kind).toBe("provider-success");
    if (outcome.kind !== "provider-success") return;
    expect(outcome.response.structuredOutput).toEqual({ name: "result", json: { answer: 42 } });
    expect(outcome.response.stopReason).toBe("tool-use");
  });
});

describe("anthropic adapter — provider error categories", () => {
  const cases: ReadonlyArray<[number, string, string, boolean]> = [
    [401, "authentication_error", "authentication", false],
    [403, "permission_error", "authorization", false],
    [400, "invalid_request_error", "invalid-request", false],
    [429, "rate_limit_error", "rate-limit", true],
    [500, "api_error", "provider-unavailable", true],
    [529, "overloaded_error", "provider-unavailable", true],
  ];

  for (const [status, type, category, retryable] of cases) {
    test(`error.type ${type} → ${category} (retryable=${retryable})`, async () => {
      const transport = new FakeTransport(() =>
        textResponse(status, JSON.stringify({ type: "error", error: { type, message: "m" } })),
      );
      const adapter = createAnthropicAdapter({ transport });
      const outcome = await adapter.complete(
        { model: "claude-3-5-sonnet", messages: [{ role: "user", content: "u" }] },
        CONTEXT,
      );
      expect(outcome.kind).toBe("provider-failure");
      if (outcome.kind !== "provider-failure") return;
      expect(outcome.failure.category).toBe(category);
      expect(outcome.failure.retryable).toBe(retryable);
      expect(outcome.failure.providerCode).toBe(type);
    });
  }

  test("a 2xx without the message envelope is a malformed-response PROVIDER failure", async () => {
    const transport = new FakeTransport(() => textResponse(200, JSON.stringify({ hello: 1 })));
    const adapter = createAnthropicAdapter({ transport });
    const outcome = await adapter.complete(
      { model: "m", messages: [{ role: "user", content: "u" }] },
      CONTEXT,
    );
    expect(outcome.kind).toBe("provider-failure");
    if (outcome.kind !== "provider-failure") return;
    expect(outcome.failure.category).toBe("malformed-response");
  });
});

describe("anthropic adapter — streaming normalization", () => {
  const SSE = [
    "event: message_start",
    'data: {"type":"message_start","message":{"usage":{"input_tokens":8}}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Dire"}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ct"}}',
    "",
    "event: message_delta",
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
    "",
    "event: message_stop",
    'data: {"type":"message_stop"}',
    "",
  ].join("\n");

  test("normalizes split usage across message_start/message_delta into neutral events", async () => {
    const transport = new FakeTransport(() =>
      textResponse(200, SSE, { "content-type": "text/event-stream" }),
    );
    const adapter = createAnthropicAdapter({ transport });
    const events = [];
    for await (const event of adapter.stream(
      { model: "claude-3-5-sonnet", messages: [{ role: "user", content: "u" }] },
      CONTEXT,
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "text-delta", text: "Dire" },
      { type: "text-delta", text: "ct" },
      { type: "usage", usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11, costUsd: null } },
      {
        type: "stream-done",
        stopReason: "stop",
        usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11, costUsd: null },
      },
    ]);
  });

  test("mid-stream error events surface as a normalized stream-error", async () => {
    const sse = [
      "event: error",
      'data: {"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}',
      "",
    ].join("\n");
    const transport = new FakeTransport(() =>
      textResponse(200, sse, { "content-type": "text/event-stream" }),
    );
    const adapter = createAnthropicAdapter({ transport });
    const events = [];
    for await (const event of adapter.stream(
      { model: "m", messages: [{ role: "user", content: "u" }] },
      CONTEXT,
    )) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    if (events[0]?.type !== "stream-error") throw new Error("expected stream-error");
    expect(events[0].failure.category).toBe("provider-unavailable");
    expect(events[0].failure.retryable).toBe(true);
  });
});
