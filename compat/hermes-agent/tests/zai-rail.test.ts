/**
 * PPR-022 zai-rail tests — the multi-surface GLM supply-rail adapter over
 * an injected HttpTransport (hermetic; the live supply is exercised by
 * the battery, not by tests): per-surface request shapes, response
 * normalization, failure categories, and the stream shape.
 */

import { describe, expect, test } from "vitest";
import type { HttpTransport } from "../../../src/modules/models/ports/http-transport";
import type { ProviderDispatchContext } from "../../../src/modules/models/ports/model-provider";
import {
  buildRailEnvelope,
  encodeModelRequest,
  parseHermesTask,
  type HermesRailTask,
} from "../harness/rail-protocol";
import { createZaiRailAdapter } from "../harness/zai-rail";

/** A hermetic transport: records the request, returns the canned response. */
function stubTransport(respond: (url: string, bodyJson: unknown) => { status: number; body: string | Buffer }): HttpTransport {
  return {
    async send(request) {
      const response = respond(request.url, request.bodyJson);
      async function* body(): AsyncIterable<Uint8Array> {
        yield typeof response.body === "string"
          ? new TextEncoder().encode(response.body)
          : new Uint8Array(response.body);
      }
      return {
        status: response.status,
        headers: { "content-type": "application/json" },
        body: body(),
      };
    },
  };
}

const CONTEXT: ProviderDispatchContext = {
  credential: JSON.stringify({ authorization: "Bearer x", "x-z-ai-from": "Z" }),
  endpointUrl: null,
  timeoutMs: 5000,
};

function requestFor(task: HermesRailTask, model: string) {
  return encodeModelRequest(buildRailEnvelope(task), model);
}

const CHAT_TASK = parseHermesTask({
  kind: "agent-loop.completion",
  edge: "hermes.agent-loop.main",
  role: "main",
  model: "glm-4-plus",
  messages: [{ role: "user", content: "Say ok." }],
})!;

describe("PPR-022 multi-surface supply rail", () => {
  test("a text completion dispatches to the chat endpoint and normalizes the turn", async () => {
    let seenUrl = "";
    let seenBody: unknown = null;
    const rail = createZaiRailAdapter({
      baseUrl: "https://supply.example",
      transport: stubTransport((url, bodyJson) => {
        seenUrl = url;
        seenBody = bodyJson;
        return {
          status: 200,
          body: JSON.stringify({
            choices: [
              { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
          }),
        };
      }),
    });
    const outcome = await rail.complete(requestFor(CHAT_TASK, "glm-4-plus"), CONTEXT);
    expect(outcome.kind).toBe("provider-success");
    expect(seenUrl).toBe("https://supply.example/chat/completions");
    const body = seenBody as { model: string; thinking: { type: string } };
    expect(body.model).toBe("glm-4-plus");
    expect(body.thinking.type).toBe("disabled");
    if (outcome.kind === "provider-success") {
      expect(outcome.response.content.join("")).toBe("ok");
      expect(outcome.response.usage.inputTokens).toBe(12);
    }
  });

  test("a vision-carrying completion dispatches to the vision endpoint with the vision model", async () => {
    let seenUrl = "";
    let seenBody: unknown = null;
    const rail = createZaiRailAdapter({
      baseUrl: "https://supply.example",
      transport: stubTransport((url, bodyJson) => {
        seenUrl = url;
        seenBody = bodyJson;
        return {
          status: 200,
          body: JSON.stringify({
            choices: [
              { message: { role: "assistant", content: "orange" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102 },
          }),
        };
      }),
    });
    const visionTask = parseHermesTask({
      kind: "agent-loop.completion",
      edge: "hermes.auxiliary.vision-analyze",
      role: "auxiliary",
      model: "glm-4.5v",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "color?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
          ],
        },
      ],
    })!;
    const outcome = await rail.complete(requestFor(visionTask, "glm-4.5v"), CONTEXT);
    expect(outcome.kind).toBe("provider-success");
    expect(seenUrl).toBe("https://supply.example/chat/completions/vision");
    expect((seenBody as { model: string }).model).toBe("glm-4.5v");
  });

  test("the tools array rides text requests only (a disclosed supply limitation)", async () => {
    const bodies: unknown[] = [];
    const rail = createZaiRailAdapter({
      baseUrl: "https://supply.example",
      transport: stubTransport(() => ({
        status: 200,
        body: JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "terminal", arguments: "{}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }),
      })),
    });
    const toolTask = parseHermesTask({
      kind: "agent-loop.completion",
      edge: "hermes.agent-loop.main",
      role: "main",
      model: "glm-4-plus",
      messages: [{ role: "user", content: "go" }],
      tools: [
        { type: "function", function: { name: "terminal", parameters: { type: "object" } } },
      ],
    })!;
    const outcome = await rail.complete(requestFor(toolTask, "glm-4-plus"), CONTEXT);
    expect(outcome.kind).toBe("provider-success");
    if (outcome.kind === "provider-success") {
      const turn = outcome.response.structuredOutput;
      const json = (turn?.json ?? {}) as { toolCalls?: { function: { name: string } }[] };
      expect(json.toolCalls?.[0]?.function.name).toBe("terminal");
    }
    expect(bodies).toEqual([]);
  });

  test("a speech dispatch posts {input, voice, response_format} to /audio/tts", async () => {
    let seenUrl = "";
    let seenBody: unknown = null;
    const wavBytes = Buffer.alloc(2048, 0x01);
    const rail = createZaiRailAdapter({
      baseUrl: "https://supply.example",
      transport: stubTransport((url, bodyJson) => {
        seenUrl = url;
        seenBody = bodyJson;
        return { status: 200, body: wavBytes };
      }),
    });
    const speechTask = parseHermesTask({
      kind: "voice.speech-generation",
      edge: "hermes.tool.tts-openai",
      model: "gpt-4o-mini-tts",
      input: "Proof.",
      voice: "alloy",
      responseFormat: "wav",
    })!;
    const outcome = await rail.complete(requestFor(speechTask, "glm-tts"), CONTEXT);
    expect(outcome.kind).toBe("provider-success");
    expect(seenUrl).toBe("https://supply.example/audio/tts");
    const body = seenBody as { input: string; voice: string; response_format: string };
    expect(body.input).toBe("Proof.");
    expect(body.voice).toBe("alloy");
    expect(body.response_format).toBe("wav");
    if (outcome.kind === "provider-success") {
      const json = outcome.response.structuredOutput?.json as { audioBase64?: string };
      expect(json.audioBase64).toBe(wavBytes.toString("base64"));
    }
  });

  test("a transcription dispatch posts {file_base64} to /audio/asr and normalizes the text", async () => {
    let seenUrl = "";
    let seenBody: unknown = null;
    const rail = createZaiRailAdapter({
      baseUrl: "https://supply.example",
      transport: stubTransport((url, bodyJson) => {
        seenUrl = url;
        seenBody = bodyJson;
        return {
          status: 200,
          body: JSON.stringify({
            text: "Proof of life, Hermes test one.",
            usage: { prompt_tokens: 94, completion_tokens: 11, total_tokens: 105 },
          }),
        };
      }),
    });
    const sttTask = parseHermesTask({
      kind: "voice.transcription",
      edge: "hermes.tool.stt-openai",
      model: "whisper-1",
      fileBase64: "QUJD",
    })!;
    const outcome = await rail.complete(requestFor(sttTask, "glm-asr"), CONTEXT);
    expect(outcome.kind).toBe("provider-success");
    expect(seenUrl).toBe("https://supply.example/audio/asr");
    expect((seenBody as { file_base64: string }).file_base64).toBe("QUJD");
    if (outcome.kind === "provider-success") {
      const json = outcome.response.structuredOutput?.json as { text?: string };
      expect(json.text).toBe("Proof of life, Hermes test one.");
    }
  });

  test("an image dispatch posts {prompt, size} to /images/generations and normalizes b64", async () => {
    let seenUrl = "";
    let seenBody: unknown = null;
    const rail = createZaiRailAdapter({
      baseUrl: "https://supply.example",
      transport: stubTransport((url, bodyJson) => {
        seenUrl = url;
        seenBody = bodyJson;
        return {
          status: 200,
          body: JSON.stringify({ data: [{ base64: "QUJDREVGRw==" }] }),
        };
      }),
    });
    const imageTask = parseHermesTask({
      kind: "media.image-generation",
      edge: "hermes.tool.image-generate-openai",
      model: "gpt-image-2",
      prompt: "teal circle",
      size: "1024x1536",
    })!;
    const outcome = await rail.complete(requestFor(imageTask, "glm-image"), CONTEXT);
    expect(outcome.kind).toBe("provider-success");
    expect(seenUrl).toBe("https://supply.example/images/generations");
    const body = seenBody as { prompt: string; size: string };
    expect(body.prompt).toBe("teal circle");
    expect(body.size).toBe("768x1344");
    if (outcome.kind === "provider-success") {
      const json = outcome.response.structuredOutput?.json as { imageBase64?: string };
      expect(json.imageBase64).toBe("QUJDREVGRw==");
    }
  });

  test("an HTTP 429 becomes a retryable rate-limit provider failure", async () => {
    const rail = createZaiRailAdapter({
      baseUrl: "https://supply.example",
      transport: stubTransport(() => ({
        status: 429,
        body: JSON.stringify({ error: "Too many requests" }),
      })),
    });
    const outcome = await rail.complete(requestFor(CHAT_TASK, "glm-4-plus"), CONTEXT);
    expect(outcome.kind).toBe("provider-failure");
    if (outcome.kind === "provider-failure") {
      expect(outcome.failure.category).toBe("rate-limit");
      expect(outcome.failure.retryable).toBe(true);
      expect(outcome.failure.httpStatus).toBe(429);
    }
  });

  test("an HTTP 503 becomes a provider-unavailable failure", async () => {
    const rail = createZaiRailAdapter({
      baseUrl: "https://supply.example",
      transport: stubTransport(() => ({
        status: 503,
        body: JSON.stringify({ error: "unavailable" }),
      })),
    });
    const outcome = await rail.complete(requestFor(CHAT_TASK, "glm-4-plus"), CONTEXT);
    expect(outcome.kind).toBe("provider-failure");
    if (outcome.kind === "provider-failure") {
      expect(outcome.failure.category).toBe("provider-unavailable");
    }
  });

  test("a malformed envelope is an honest invalid-request failure", async () => {
    const rail = createZaiRailAdapter({
      baseUrl: "https://supply.example",
      transport: stubTransport(() => ({ status: 200, body: "{}" })),
    });
    const outcome = await rail.complete(
      { model: "m", messages: [{ role: "user", content: "bare" }] },
      CONTEXT,
    );
    expect(outcome.kind).toBe("provider-failure");
    if (outcome.kind === "provider-failure") {
      expect(outcome.failure.category).toBe("invalid-request");
      expect(outcome.failure.providerMessage).toContain("rail protocol");
    }
  });

  test("the stream shape yields one terminal text sequence (an honest single-shot stream)", async () => {
    const rail = createZaiRailAdapter({
      baseUrl: "https://supply.example",
      transport: stubTransport(() => ({
        status: 200,
        body: JSON.stringify({
          choices: [
            { message: { role: "assistant", content: "chunk-free" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
      })),
    });
    const deltas: string[] = [];
    let done: { stopReason: string } | undefined;
    for await (const event of rail.stream(requestFor(CHAT_TASK, "glm-4-plus"), CONTEXT)) {
      if (event.type === "text-delta") {
        deltas.push(event.text);
      }
      if (event.type === "stream-done") {
        done = { stopReason: event.stopReason };
      }
    }
    expect(deltas.join("")).toBe("chunk-free");
    expect(done?.stopReason).toBe("stop");
  });
});
