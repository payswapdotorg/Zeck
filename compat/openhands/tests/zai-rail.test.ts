/**
 * PPR-020 supply-rail tests — the GLM rail adapter over an injected
 * (hermetic) transport: envelope unwrapping, tool-call normalization,
 * vision routing, usage extraction, and the failure-category mapping
 * (the live supply endpoint is exercised by the battery, not by tests).
 */

import { describe, expect, test } from "vitest";
import type { HttpTransport } from "../../../src/modules/models/ports/http-transport";
import { RAIL_ENVELOPE_PREFIX, encodeModelRequest, buildRailEnvelope, parseOpenHandsCompletionTask, OPENHANDS_TASK_KIND } from "../harness/rail-protocol";
import { createZaiRailAdapter, RAIL_ROUTES } from "../harness/zai-rail";
import { RAIL_MODEL, RAIL_VISION_MODEL } from "../harness/zai-config";

const OPENHANDS_TASK_KIND_VALUE = OPENHANDS_TASK_KIND;

function stubTransport(
  handler: (url: string, body: Record<string, unknown>) => { status: number; text: string },
): HttpTransport & { requests: { url: string; body: Record<string, unknown> }[] } {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  return {
    get requests() {
      return requests;
    },
    async send(request) {
      const body = (request.bodyJson ?? {}) as Record<string, unknown>;
      requests.push({ url: request.url, body });
      const response = handler(request.url, body);
      async function* body_(): AsyncIterable<Uint8Array> {
        yield new TextEncoder().encode(response.text);
      }
      return { status: response.status, headers: { "content-type": "application/json" }, body: body_() };
    },
  } as HttpTransport & { requests: { url: string; body: Record<string, unknown> }[] };
}

function supplyResponse(over: {
  content?: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
  finishReason?: string;
}): string {
  return JSON.stringify({
    id: "cc-1",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: over.content ?? "",
          ...(over.toolCalls === undefined
            ? {}
            : {
                tool_calls: over.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: call.arguments },
                })),
              }),
        },
        finish_reason: over.finishReason ?? "stop",
      },
    ],
    usage: { prompt_tokens: 111, completion_tokens: 22, total_tokens: 133 },
  });
}

const TASK_PAYLOAD: Record<string, unknown> = {
  kind: OPENHANDS_TASK_KIND_VALUE,
  edge: "openhands.agent-loop.main",
  role: "main",
  model: "glm-4-plus",
  messages: [
    { role: "system", content: "You are OpenHands agent." },
    { role: "user", content: "Run the command." },
  ],
};

const VISION_TASK_PAYLOAD: Record<string, unknown> = {
  kind: OPENHANDS_TASK_KIND_VALUE,
  edge: "openhands.agent-loop.vision",
  role: "main",
  model: "glm-4-plus",
  messages: [
    { role: "system", content: "You are OpenHands agent." },
    {
      role: "user",
      content: [
        { type: "text", text: "color?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    },
  ],
};

function requestFor(taskPayload: Record<string, unknown>) {
  const task = parseOpenHandsCompletionTask(taskPayload)!;
  return encodeModelRequest(buildRailEnvelope(task), RAIL_MODEL);
}

describe("PPR-020 GLM supply rail", () => {
  test("a text dispatch reaches the text endpoint with the unwrapped messages and tools", async () => {
    const transport = stubTransport(() => ({ status: 200, text: supplyResponse({ content: "done." }) }));
    const rail = createZaiRailAdapter({ baseUrl: "https://supply.test/api", transport });
    const task = parseOpenHandsCompletionTask({
      ...TASK_PAYLOAD,
      tools: [{ type: "function", function: { name: "terminal", parameters: { type: "object" } } }],
    })!;
    const outcome = await rail.complete(encodeModelRequest(buildRailEnvelope(task), RAIL_MODEL), {
      credential: JSON.stringify({ authorization: "Bearer supply-key" }),
      endpointUrl: null,
      timeoutMs: 30_000,
    });
    expect(outcome.kind).toBe("provider-success");
    const request = transport.requests[0]!;
    expect(request.url).toBe("https://supply.test/api/chat/completions");
    const body = request.body as { model: string; messages: unknown[]; tools?: unknown[] };
    expect(body.model).toBe(RAIL_MODEL);
    expect(body.messages).toHaveLength(2);
    expect(body.tools).toHaveLength(1);
  });

  test("a vision dispatch routes to the vision endpoint and the vision model", async () => {
    const transport = stubTransport(() => ({ status: 200, text: supplyResponse({ content: "orange." }) }));
    const rail = createZaiRailAdapter({ baseUrl: "https://supply.test/api", transport });
    const outcome = await rail.complete(requestFor(VISION_TASK_PAYLOAD), {
      credential: null,
      endpointUrl: null,
      timeoutMs: 30_000,
    });
    expect(outcome.kind).toBe("provider-success");
    const request = transport.requests[0]!;
    expect(request.url).toBe("https://supply.test/api/chat/completions/vision");
    expect((request.body as { model: string }).model).toBe(RAIL_VISION_MODEL);
  });

  test("the response's tool calls normalize into the structured turn", async () => {
    const transport = stubTransport(
      () =>
        ({
          status: 200,
          text: supplyResponse({
            content: "",
            toolCalls: [{ id: "call_9", name: "terminal", arguments: "{\"command\":\"ls\"}" }],
            finishReason: "tool_calls",
          }),
        }) as { status: number; text: string },
    );
    const rail = createZaiRailAdapter({ baseUrl: "https://supply.test/api", transport });
    const outcome = await rail.complete(requestFor(TASK_PAYLOAD), {
      credential: null,
      endpointUrl: null,
      timeoutMs: 30_000,
    });
    expect(outcome.kind).toBe("provider-success");
    if (outcome.kind !== "provider-success") {
      throw new Error("unreachable");
    }
    const structured = outcome.response.structuredOutput;
    expect(structured).not.toBeNull();
    const turn = (structured?.json ?? {}) as {
      toolCalls: { id: string; function: { name: string } }[];
    };
    expect(turn.toolCalls[0]?.id).toBe("call_9");
    expect(turn.toolCalls[0]?.function.name).toBe("terminal");
    expect(outcome.response.stopReason).toBe("tool-use");
    expect(outcome.response.usage.inputTokens).toBe(111);
    expect(outcome.response.usage.outputTokens).toBe(22);
  });

  test("an HTTP 429 maps onto the retryable rate-limit failure category", async () => {
    const transport = stubTransport(() => ({ status: 429, text: JSON.stringify({ error: "rate limited" }) }));
    const rail = createZaiRailAdapter({ baseUrl: "https://supply.test/api", transport });
    const outcome = await rail.complete(requestFor(TASK_PAYLOAD), {
      credential: null,
      endpointUrl: null,
      timeoutMs: 30_000,
    });
    expect(outcome.kind).toBe("provider-failure");
    if (outcome.kind !== "provider-failure") {
      throw new Error("unreachable");
    }
    expect(outcome.failure.category).toBe("rate-limit");
    expect(outcome.failure.retryable).toBe(true);
    expect(outcome.failure.httpStatus).toBe(429);
  });

  test("an HTTP 503 maps onto provider-unavailable; a non-JSON body is malformed-response", async () => {
    const unavailable = createZaiRailAdapter({
      baseUrl: "https://supply.test/api",
      transport: stubTransport(() => ({ status: 503, text: "unavailable" })),
    });
    const outcome503 = await unavailable.complete(requestFor(TASK_PAYLOAD), {
      credential: null,
      endpointUrl: null,
      timeoutMs: 30_000,
    });
    expect(outcome503.kind).toBe("provider-failure");
    if (outcome503.kind === "provider-failure") {
      expect(outcome503.failure.category).toBe("provider-unavailable");
    }

    const malformed = createZaiRailAdapter({
      baseUrl: "https://supply.test/api",
      transport: stubTransport(() => ({ status: 200, text: "not json" })),
    });
    const outcomeBad = await malformed.complete(requestFor(TASK_PAYLOAD), {
      credential: null,
      endpointUrl: null,
      timeoutMs: 30_000,
    });
    expect(outcomeBad.kind).toBe("provider-failure");
    if (outcomeBad.kind === "provider-failure") {
      expect(outcomeBad.failure.category).toBe("malformed-response");
    }
  });

  test("a non-enveloped request is rejected as an invalid-request (fail closed)", async () => {
    const transport = stubTransport(() => ({ status: 200, text: supplyResponse({ content: "x" }) }));
    const rail = createZaiRailAdapter({ baseUrl: "https://supply.test/api", transport });
    const outcome = await rail.complete(
      {
        model: RAIL_MODEL,
        messages: [{ role: "user", content: `${RAIL_ENVELOPE_PREFIX}not-json` }],
      },
      { credential: null, endpointUrl: null, timeoutMs: 30_000 },
    );
    expect(outcome.kind).toBe("provider-failure");
    if (outcome.kind === "provider-failure") {
      expect(outcome.failure.category).toBe("invalid-request");
    }
    expect(transport.requests).toHaveLength(0);
  });

  test("the rail's route identities are neutral strings", () => {
    expect(RAIL_ROUTES.text.model).toBe(RAIL_MODEL);
    expect(RAIL_ROUTES.vision.model).toBe(RAIL_VISION_MODEL);
  });
});
