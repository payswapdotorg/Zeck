/**
 * Unit: OpenRouter adapter normalization (WORK-003, CON-003).
 *
 * Wire fixtures mirror the rail's OpenAI-compatible contract; a fake
 * transport replays them. Assertions target the NEUTRAL contracts — usage
 * (incl. rail-reported USD cost), structured output, streaming and provider
 * error categories.
 */

import { describe, expect, test } from "vitest";
import { createOpenRouterAdapter } from "../../../src/modules/models/adapters/openrouter";
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
  credential: "sk-or-v1-test-credential",
  timeoutMs: 5000,
};

const SIMPLE_BODY = {
  id: "gen-01",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hello from the rail" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, cost: 0.000123 },
};

describe("openrouter adapter — completion normalization", () => {
  test("maps a well-formed response onto the neutral contract", async () => {
    const transport = new FakeTransport(() => textResponse(200, JSON.stringify(SIMPLE_BODY)));
    const adapter = createOpenRouterAdapter({ transport });
    const outcome = await adapter.complete(
      { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
      CONTEXT,
    );
    expect(outcome.kind).toBe("provider-success");
    if (outcome.kind !== "provider-success") return;
    expect(outcome.response.content).toEqual(["Hello from the rail"]);
    expect(outcome.response.stopReason).toBe("stop");
    expect(outcome.response.usage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
      costUsd: 0.000123,
    });
    expect(outcome.response.providerLatencyMs).toBeGreaterThanOrEqual(0);
  });

  test("sends bearer credentials and the json_schema response format", async () => {
    const transport = new FakeTransport(() => textResponse(200, JSON.stringify(SIMPLE_BODY)));
    const adapter = createOpenRouterAdapter({ transport });
    await adapter.complete(
      {
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "extract" }],
        structuredOutput: { name: "result", schema: { type: "object" } },
      },
      CONTEXT,
    );
    const request = transport.requests[0];
    expect(request?.headers.authorization).toBe("Bearer sk-or-v1-test-credential");
    expect(request?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = request?.bodyJson as Record<string, unknown>;
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "result", schema: { type: "object" }, strict: true },
    });
  });

  test("parses schema-conforming JSON content into normalized structured output", async () => {
    const body = {
      ...SIMPLE_BODY,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: '{"answer": 42}' },
          finish_reason: "stop",
        },
      ],
    };
    const transport = new FakeTransport(() => textResponse(200, JSON.stringify(body)));
    const adapter = createOpenRouterAdapter({ transport });
    const outcome = await adapter.complete(
      {
        model: "m",
        messages: [{ role: "user", content: "u" }],
        structuredOutput: { name: "answer-schema", schema: { type: "object" } },
      },
      CONTEXT,
    );
    expect(outcome.kind).toBe("provider-success");
    if (outcome.kind !== "provider-success") return;
    expect(outcome.response.structuredOutput).toEqual({
      name: "answer-schema",
      json: { answer: 42 },
    });
  });

  test("honors connection endpoint overrides (customer gateway fronts)", async () => {
    const transport = new FakeTransport(() => textResponse(200, JSON.stringify(SIMPLE_BODY)));
    const adapter = createOpenRouterAdapter({ transport });
    await adapter.complete(
      { model: "m", messages: [{ role: "user", content: "u" }] },
      { ...CONTEXT, endpointUrl: "https://gateway.customer.example/v1/" },
    );
    expect(transport.requests[0]?.url).toBe("https://gateway.customer.example/v1/chat/completions");
  });

  test("missing credential is an authentication provider failure (not a throw)", async () => {
    const transport = new FakeTransport(() => textResponse(200, "{}"));
    const adapter = createOpenRouterAdapter({ transport, platformCredential: null });
    const outcome = await adapter.complete(
      { model: "m", messages: [{ role: "user", content: "u" }] },
      { ...CONTEXT, credential: null },
    );
    expect(outcome).toEqual({
      kind: "provider-failure",
      failure: expect.objectContaining({
        category: "authentication",
        retryable: false,
        rail: "openrouter",
      }),
    });
  });
});

describe("openrouter adapter — provider error categories", () => {
  const cases: ReadonlyArray<[number, unknown, string, boolean]> = [
    [401, { error: { code: "401", message: "Invalid credentials" } }, "authentication", false],
    [402, { error: { code: "402", message: "Insufficient credits" } }, "quota", false],
    [403, { error: { code: "403", message: "denied" } }, "authorization", false],
    [429, { error: { code: "429", message: "rate limited" } }, "rate-limit", true],
    [400, { error: { code: "400", message: "bad param" } }, "invalid-request", false],
    [500, { error: { code: "500", message: "upstream" } }, "provider-unavailable", true],
    [503, { error: { message: "overloaded" } }, "provider-unavailable", true],
  ];

  for (const [status, body, category, retryable] of cases) {
    test(`HTTP ${status} → ${category} (retryable=${retryable})`, async () => {
      const transport = new FakeTransport(() => textResponse(status, JSON.stringify(body)));
      const adapter = createOpenRouterAdapter({ transport });
      const outcome = await adapter.complete(
        { model: "m", messages: [{ role: "user", content: "u" }] },
        CONTEXT,
      );
      expect(outcome.kind).toBe("provider-failure");
      if (outcome.kind !== "provider-failure") return;
      expect(outcome.failure.category).toBe(category);
      expect(outcome.failure.retryable).toBe(retryable);
      expect(outcome.failure.httpStatus).toBe(status);
    });
  }

  test("a 2xx without the required envelope is a malformed-response PROVIDER failure", async () => {
    const transport = new FakeTransport(() =>
      textResponse(200, JSON.stringify({ unexpected: true })),
    );
    const adapter = createOpenRouterAdapter({ transport });
    const outcome = await adapter.complete(
      { model: "m", messages: [{ role: "user", content: "u" }] },
      CONTEXT,
    );
    expect(outcome.kind).toBe("provider-failure");
    if (outcome.kind !== "provider-failure") return;
    expect(outcome.failure.category).toBe("malformed-response");
  });

  test("long provider messages are sanitized and truncated", async () => {
    const long = "x".repeat(500);
    const transport = new FakeTransport(() =>
      textResponse(400, JSON.stringify({ error: { message: long } })),
    );
    const adapter = createOpenRouterAdapter({ transport });
    const outcome = await adapter.complete(
      { model: "m", messages: [{ role: "user", content: "u" }] },
      CONTEXT,
    );
    if (outcome.kind !== "provider-failure") throw new Error("unreachable");
    expect(outcome.failure.providerMessage?.length ?? 0).toBeLessThanOrEqual(302);
  });
});

describe("openrouter adapter — streaming normalization", () => {
  const SSE = [
    'data: {"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}',
    "",
    'data: {"choices":[{"delta":{"content":"lo"}}]}',
    "",
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    "",
    'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5,"cost":0.001}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  test("normalizes SSE chunks into neutral stream events with terminal usage", async () => {
    const transport = new FakeTransport(() =>
      textResponse(200, SSE, { "content-type": "text/event-stream" }),
    );
    const adapter = createOpenRouterAdapter({ transport });
    const events = [];
    for await (const event of adapter.stream(
      { model: "m", messages: [{ role: "user", content: "u" }] },
      CONTEXT,
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "text-delta", text: "Hel" },
      { type: "text-delta", text: "lo" },
      { type: "usage", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, costUsd: 0.001 } },
      {
        type: "stream-done",
        stopReason: "stop",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, costUsd: 0.001 },
      },
    ]);
  });

  test("streaming HTTP errors surface as stream-error with the normalized failure", async () => {
    const transport = new FakeTransport(() =>
      textResponse(429, JSON.stringify({ error: { code: "429", message: "slow down" } })),
    );
    const adapter = createOpenRouterAdapter({ transport });
    const events = [];
    for await (const event of adapter.stream(
      { model: "m", messages: [{ role: "user", content: "u" }] },
      CONTEXT,
    )) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("stream-error");
    if (events[0]?.type !== "stream-error") return;
    expect(events[0].failure.category).toBe("rate-limit");
    expect(events[0].failure.retryable).toBe(true);
  });
});

describe("openrouter adapter — transport-failure normalization (architect remediation)", () => {
  class RejectingTransport implements HttpTransport {
    constructor(private readonly rejection: Error) {}
    async send(): Promise<HttpResponse> {
      throw this.rejection;
    }
  }

  function timeoutRejection(): Error {
    const error = new Error("the operation was aborted due to timeout");
    error.name = "TimeoutError";
    return error;
  }

  const NETWORK_REJECTION = new Error("connect ECONNREFUSED 1.2.3.4:443");

  class MidBodyRejectingTransport implements HttpTransport {
    async send(): Promise<HttpResponse> {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: (async function* () {
          yield new TextEncoder().encode('{"choices":');
          throw new Error("read ECONNRESET");
        })(),
      };
    }
  }

  test("one-shot: a network send rejection returns a provider-failure outcome (never a throw)", async () => {
    const adapter = createOpenRouterAdapter({
      transport: new RejectingTransport(NETWORK_REJECTION),
    });
    const outcome = await adapter.complete(
      { model: "m", messages: [{ role: "user", content: "u" }] },
      CONTEXT,
    );
    expect(outcome).toEqual({
      kind: "provider-failure",
      failure: expect.objectContaining({
        category: "network",
        retryable: true,
        rail: "openrouter",
        httpStatus: null,
      }),
    });
  });

  test("one-shot: a timeout rejection normalizes to the timeout category", async () => {
    const adapter = createOpenRouterAdapter({
      transport: new RejectingTransport(timeoutRejection()),
    });
    const outcome = await adapter.complete(
      { model: "m", messages: [{ role: "user", content: "u" }] },
      CONTEXT,
    );
    expect(outcome.kind).toBe("provider-failure");
    if (outcome.kind !== "provider-failure") return;
    expect(outcome.failure.category).toBe("timeout");
    expect(outcome.failure.retryable).toBe(true);
    expect(outcome.failure.rail).toBe("openrouter");
  });

  test("one-shot: a mid-body network failure also returns a provider-failure outcome", async () => {
    const adapter = createOpenRouterAdapter({ transport: new MidBodyRejectingTransport() });
    const outcome = await adapter.complete(
      { model: "m", messages: [{ role: "user", content: "u" }] },
      CONTEXT,
    );
    expect(outcome.kind).toBe("provider-failure");
    if (outcome.kind !== "provider-failure") return;
    expect(outcome.failure.category).toBe("network");
    expect(outcome.failure.rail).toBe("openrouter");
  });

  test("streaming: a handshake rejection becomes a terminal stream-error (no escape)", async () => {
    const adapter = createOpenRouterAdapter({
      transport: new RejectingTransport(NETWORK_REJECTION),
    });
    const events = [];
    for await (const event of adapter.stream(
      { model: "m", messages: [{ role: "user", content: "u" }] },
      CONTEXT,
    )) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("stream-error");
    if (events[0]?.type !== "stream-error") return;
    expect(events[0].failure.category).toBe("network");
    expect(events[0].failure.retryable).toBe(true);
    expect(events[0].failure.rail).toBe("openrouter");
  });

  test("streaming: a mid-body rejection after deltas becomes a terminal stream-error", async () => {
    const transport = {
      async send(): Promise<HttpResponse> {
        return {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: (async function* () {
            yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"par"}}]}\n\n');
            throw new Error("read ECONNRESET mid-stream");
          })(),
        };
      },
    };
    const adapter = createOpenRouterAdapter({ transport });
    const events = [];
    for await (const event of adapter.stream(
      { model: "m", messages: [{ role: "user", content: "u" }] },
      CONTEXT,
    )) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual(["text-delta", "stream-error"]);
    const terminal = events[1];
    if (terminal?.type !== "stream-error") throw new Error("expected terminal stream-error");
    expect(terminal.failure.category).toBe("network");
    expect(terminal.failure.rail).toBe("openrouter");
    // The stream TERMINATED (iteration completed) — the rejection did not escape.
  });
});
