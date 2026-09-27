/**
 * PPR-018 rail adapter tests: the GLM supply rail over an injectable
 * transport — success normalization, failure categories, retryability,
 * and the malformed-response guard (never a thrown provider error).
 */

import { describe, expect, test } from "vitest";
import { createZaiRailAdapter } from "../harness/zai-rail";
import type { HttpTransport } from "../../../src/modules/models/ports/http-transport";
import { textResponse } from "../../../src/modules/models/ports/http-transport";

function transportOf(
  handler: () => Promise<{ status: number; text: string }>,
): HttpTransport {
  return {
    async send() {
      const result = await handler();
      return textResponse(result.status, result.text);
    },
  };
}

const CONTEXT = {
  endpointUrl: null,
  credential: JSON.stringify({ authorization: "Bearer x", "x-token": "t" }),
  timeoutMs: 5_000,
};

const SUPPLY_OK = JSON.stringify({
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "HELLO" } }],
  usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
});

describe("the GLM supply rail adapter", () => {
  test("a successful supply response normalizes to provider-success with usage", async () => {
    const rail = createZaiRailAdapter({
      baseUrl: "https://supply.example/v1",
      transport: transportOf(async () => ({ status: 200, text: SUPPLY_OK })),
    });
    const outcome = await rail.complete(
      { model: "glm-4-plus", messages: [{ role: "user", content: "hi" }] },
      CONTEXT,
    );
    expect(outcome.kind).toBe("provider-success");
    if (outcome.kind !== "provider-success") {
      return;
    }
    expect(outcome.response.content).toEqual(["HELLO"]);
    expect(outcome.response.stopReason).toBe("stop");
    expect(outcome.response.usage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
      costUsd: null,
    });
    expect(outcome.response.providerLatencyMs).not.toBeNull();
  });

  test("a 500 supply response is a retryable provider-unavailable failure", async () => {
    const rail = createZaiRailAdapter({
      baseUrl: "https://supply.example/v1",
      transport: transportOf(async () => ({ status: 503, text: "unavailable" })),
    });
    const outcome = await rail.complete(
      { model: "glm-4-plus", messages: [{ role: "user", content: "hi" }] },
      CONTEXT,
    );
    expect(outcome.kind).toBe("provider-failure");
    if (outcome.kind !== "provider-failure") {
      return;
    }
    expect(outcome.failure.category).toBe("provider-unavailable");
    expect(outcome.failure.retryable).toBe(true);
    expect(outcome.failure.httpStatus).toBe(503);
  });

  test("a 401 supply response is a non-retryable authentication failure", async () => {
    const rail = createZaiRailAdapter({
      baseUrl: "https://supply.example/v1",
      transport: transportOf(async () => ({ status: 401, text: "bad token" })),
    });
    const outcome = await rail.complete(
      { model: "glm-4-plus", messages: [{ role: "user", content: "hi" }] },
      CONTEXT,
    );
    expect(outcome.kind).toBe("provider-failure");
    if (outcome.kind !== "provider-failure") {
      return;
    }
    expect(outcome.failure.category).toBe("authentication");
    expect(outcome.failure.retryable).toBe(false);
  });

  test("a non-JSON body is a malformed-response failure (never a throw)", async () => {
    const rail = createZaiRailAdapter({
      baseUrl: "https://supply.example/v1",
      transport: transportOf(async () => ({ status: 200, text: "<html>proxy error</html>" })),
    });
    const outcome = await rail.complete(
      { model: "glm-4-plus", messages: [{ role: "user", content: "hi" }] },
      CONTEXT,
    );
    expect(outcome.kind).toBe("provider-failure");
    if (outcome.kind !== "provider-failure") {
      return;
    }
    expect(outcome.failure.category).toBe("malformed-response");
  });

  test("a transport crash normalizes to a network failure (never a throw)", async () => {
    const rail = createZaiRailAdapter({
      baseUrl: "https://supply.example/v1",
      transport: {
        async send() {
          throw new Error("connect ECONNREFUSED");
        },
      },
    });
    const outcome = await rail.complete(
      { model: "glm-4-plus", messages: [{ role: "user", content: "hi" }] },
      CONTEXT,
    );
    expect(outcome.kind).toBe("provider-failure");
    if (outcome.kind !== "provider-failure") {
      return;
    }
    expect(outcome.failure.category).toBe("network");
    expect(outcome.failure.retryable).toBe(true);
  });

  test("a malformed credential material is an authentication failure (never a guess)", async () => {
    const rail = createZaiRailAdapter({
      baseUrl: "https://supply.example/v1",
      transport: transportOf(async () => ({ status: 200, text: SUPPLY_OK })),
    });
    const outcome = await rail.complete(
      { model: "glm-4-plus", messages: [{ role: "user", content: "hi" }] },
      { endpointUrl: null, credential: "{not-json", timeoutMs: 5_000 },
    );
    expect(outcome.kind).toBe("provider-failure");
    if (outcome.kind !== "provider-failure") {
      return;
    }
    expect(outcome.failure.category).toBe("authentication");
  });

  test("the stream path emits a terminal sequence for the non-streaming backend", async () => {
    const rail = createZaiRailAdapter({
      baseUrl: "https://supply.example/v1",
      transport: transportOf(async () => ({ status: 200, text: SUPPLY_OK })),
    });
    const events = [];
    for await (const event of rail.stream(
      { model: "glm-4-plus", messages: [{ role: "user", content: "hi" }] },
      CONTEXT,
    )) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual(["text-delta", "stream-done"]);
  });
});
