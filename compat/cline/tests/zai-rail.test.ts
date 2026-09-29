/**
 * PPR-019 supply-rail tests — the GLM rail adapter over INJECTED
 * transports (hermetic; the live supply is exercised by the battery):
 * wire-body correctness (model/messages/tools/thinking), vision
 * routing, tool-call normalization into the structured turn, failure
 * classification (including the timeout path the battery discloses as
 * unit-pinned), and the secrets-last credential materialization.
 */

import { describe, expect, test } from "vitest";
import type { HttpTransport } from "../../../src/modules/models/ports/http-transport";
import { textResponse } from "../../../src/modules/models/ports/http-transport";
import type { ProviderDispatchContext } from "../../../src/modules/models/ports/model-provider";
import { createZaiRailAdapter } from "../harness/zai-rail";
import {
  buildRailEnvelope,
  encodeModelRequest,
  turnOfStructuredOutput,
  type ClineCompletionTask,
} from "../harness/rail-protocol";

const CONTEXT: ProviderDispatchContext = {
  endpointUrl: null,
  credential: JSON.stringify({ authorization: "Bearer test", "x-z-ai-from": "Z" }),
  timeoutMs: 5000,
};

function transportOf(
  handler: (request: { url: string; bodyJson?: unknown; timeoutMs?: number }) => Promise<{ status: number; text: string }>,
): HttpTransport {
  return {
    async send(request) {
      const result = await handler({
        url: request.url,
        ...(request.bodyJson === undefined ? {} : { bodyJson: request.bodyJson }),
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      });
      return textResponse(result.status, result.text, { "content-type": "application/json" });
    },
  };
}

function requestFor(task: ClineCompletionTask, model: string) {
  return encodeModelRequest(buildRailEnvelope(task), model);
}

const TEXT_TASK: ClineCompletionTask = {
  kind: "ide-agent.completion",
  edge: "cline.agent-loop.act",
  role: "main",
  model: "glm-4-plus",
  messages: [
    { role: "system", content: "You are Cline." },
    { role: "user", content: "read a.js" },
  ],
  tools: [
    { type: "function", function: { name: "read_files", description: "Read", parameters: { type: "object" } } },
  ],
  params: { maxTokens: 512, temperature: 0.1 },
};

describe("PPR-019 GLM supply rail", () => {
  test("a text envelope dispatches to the text endpoint with the tools axis and disabled thinking", async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const rail = createZaiRailAdapter({
      baseUrl: "https://supply.example/v1",
      transport: transportOf(async (request) => {
        seen.push({ url: request.url, body: request.bodyJson as Record<string, unknown> });
        return {
          status: 200,
          text: JSON.stringify({
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "done" } }],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          }),
        };
      }),
    });
    const outcome = await rail.complete(requestFor(TEXT_TASK, "glm-4-plus"), CONTEXT);
    expect(outcome.kind).toBe("provider-success");
    expect(seen[0]?.url).toBe("https://supply.example/v1/chat/completions");
    expect(seen[0]?.body.model).toBe("glm-4-plus");
    expect(seen[0]?.body.thinking).toEqual({ type: "disabled" });
    expect(Array.isArray(seen[0]?.body.tools)).toBe(true);
    expect(seen[0]?.body.tool_choice).toBe("auto");
    expect(seen[0]?.body.max_tokens).toBe(512);
    if (outcome.kind === "provider-success") {
      expect(outcome.response.content).toEqual(["done"]);
      expect(outcome.response.usage.inputTokens).toBe(10);
      expect(outcome.response.usage.outputTokens).toBe(2);
    }
  });

  test("a reasoning-effort envelope enables thinking on the supply request", async () => {
    let thinking: unknown = null;
    const rail = createZaiRailAdapter({
      baseUrl: "https://supply.example/v1",
      transport: transportOf(async (request) => {
        thinking = (request.bodyJson as Record<string, unknown>).thinking;
        return {
          status: 200,
          text: JSON.stringify({
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "154" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        };
      }),
    });
    const outcome = await rail.complete(
      requestFor({ ...TEXT_TASK, params: { reasoningEffort: "high" } }, "glm-4-plus"),
      CONTEXT,
    );
    expect(outcome.kind).toBe("provider-success");
    expect(thinking).toEqual({ type: "enabled" });
  });

  test("a vision envelope dispatches to the vision endpoint with the vision model and no tools axis", async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const rail = createZaiRailAdapter({
      baseUrl: "https://supply.example/v1",
      transport: transportOf(async (request) => {
        seen.push({ url: request.url, body: request.bodyJson as Record<string, unknown> });
        return {
          status: 200,
          text: JSON.stringify({
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Orange" } }],
            usage: { prompt_tokens: 30, completion_tokens: 1 },
          }),
        };
      }),
    });
    const visionTask: ClineCompletionTask = {
      ...TEXT_TASK,
      messages: [
        { role: "user", content: [
          { type: "text", text: "color?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
        ] },
      ],
    };
    const outcome = await rail.complete(requestFor(visionTask, "glm-4.5v"), CONTEXT);
    expect(outcome.kind).toBe("provider-success");
    expect(seen[0]?.url).toBe("https://supply.example/v1/chat/completions/vision");
    expect(seen[0]?.body.model).toBe("glm-4.5v");
    expect(seen[0]?.body.tools).toBeUndefined();
  });

  test("tool calls in the supply response normalize into the structured turn", async () => {
    const rail = createZaiRailAdapter({
      baseUrl: "https://supply.example/v1",
      transport: transportOf(async () => ({
        status: 200,
        text: JSON.stringify({
          choices: [{
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "I'll read it.",
              tool_calls: [{
                id: "call_42",
                type: "function",
                function: { name: "read_files", arguments: "{\"paths\":[\"a.js\"]}" },
              }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }),
      })),
    });
    const outcome = await rail.complete(requestFor(TEXT_TASK, "glm-4-plus"), CONTEXT);
    expect(outcome.kind).toBe("provider-success");
    if (outcome.kind !== "provider-success") return;
    expect(outcome.response.stopReason).toBe("tool-use");
    const turn = turnOfStructuredOutput(outcome.response.structuredOutput);
    expect(turn?.content).toBe("I'll read it.");
    expect(turn?.finishReason).toBe("tool_calls");
    expect(turn?.toolCalls[0]?.id).toBe("call_42");
    expect(turn?.toolCalls[0]?.function.name).toBe("read_files");
  });

  test("HTTP failures classify into normalized provider failures (429 retryable, 500 unavailable, malformed JSON)", async () => {
    const makeRail = (status: number, text: string) =>
      createZaiRailAdapter({ baseUrl: "https://supply.example/v1", transport: transportOf(async () => ({ status, text })) });
    const rateLimited = await makeRail(429, '{"error":"Too many requests"}').complete(requestFor(TEXT_TASK, "m"), CONTEXT);
    expect(rateLimited.kind).toBe("provider-failure");
    if (rateLimited.kind === "provider-failure") {
      expect(rateLimited.failure.category).toBe("rate-limit");
      expect(rateLimited.failure.retryable).toBe(true);
    }
    const unavailable = await makeRail(503, "nope").complete(requestFor(TEXT_TASK, "m"), CONTEXT);
    expect(unavailable.kind).toBe("provider-failure");
    if (unavailable.kind === "provider-failure") {
      expect(unavailable.failure.category).toBe("provider-unavailable");
    }
    const malformed = await makeRail(200, "not json").complete(requestFor(TEXT_TASK, "m"), CONTEXT);
    expect(malformed.kind).toBe("provider-failure");
    if (malformed.kind === "provider-failure") {
      expect(malformed.failure.category).toBe("malformed-response");
    }
  });

  test("a hanging supply transport surfaces as a timeout provider failure (the timeout path, unit-pinned)", async () => {
    const rail = createZaiRailAdapter({
      baseUrl: "https://supply.example/v1",
      transport: {
        async send(request) {
          // A transport that honors the injected timeout the way the real
          // fetch transport does (AbortSignal.timeout → a thrown error).
          await new Promise((resolve) => setTimeout(resolve, request.timeoutMs ?? 60_000));
          throw new Error("request timed out after 60s");
        },
      },
    });
    const outcome = await rail.complete(requestFor(TEXT_TASK, "m"), {
      endpointUrl: null,
      credential: null,
      timeoutMs: 50,
    });
    expect(outcome.kind).toBe("provider-failure");
    if (outcome.kind === "provider-failure") {
      expect(outcome.failure.category).toBe("timeout");
      expect(outcome.failure.retryable).toBe(true);
    }
  }, 20_000);

  test("a response with neither content nor tool calls is a malformed-response failure (never a guess)", async () => {
    const rail = createZaiRailAdapter({
      baseUrl: "https://supply.example/v1",
      transport: transportOf(async () => ({
        status: 200,
        text: JSON.stringify({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: null } }] }),
      })),
    });
    const outcome = await rail.complete(requestFor(TEXT_TASK, "m"), CONTEXT);
    expect(outcome.kind).toBe("provider-failure");
  });

  test("malformed rail credential material is an authentication failure (secrets-last, no guessing)", async () => {
    const rail = createZaiRailAdapter({
      baseUrl: "https://supply.example/v1",
      transport: transportOf(async () => ({ status: 200, text: "{}" })),
    });
    const outcome = await rail.complete(requestFor(TEXT_TASK, "m"), {
      endpointUrl: null,
      credential: "not-json",
      timeoutMs: 1000,
    });
    expect(outcome.kind).toBe("provider-failure");
    if (outcome.kind === "provider-failure") {
      expect(outcome.failure.category).toBe("authentication");
    }
  });

  test("an endpointUrl override from the connection wins (the gateway's routing seam)", async () => {
    let seenUrl = "";
    const rail = createZaiRailAdapter({
      baseUrl: "https://supply.example/v1",
      transport: transportOf(async (request) => {
        seenUrl = request.url;
        return {
          status: 200,
          text: JSON.stringify({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }] }),
        };
      }),
    });
    await rail.complete(requestFor(TEXT_TASK, "m"), { ...CONTEXT, endpointUrl: "https://override.example/chat/completions" });
    expect(seenUrl).toBe("https://override.example/chat/completions");
  });
});
