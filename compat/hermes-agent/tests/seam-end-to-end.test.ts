/**
 * PPR-022 seam end-to-end test: the full composed stack (real Zeck
 * public API + real model gateway + rail worker + multi-surface adapter)
 * over an INJECTED supply transport (a hermetic stub for the unit suite —
 * the live GLM supply is exercised by the battery, not by tests).
 *
 * Exercises every surface: OpenAI-shaped chat requests (text + vision +
 * the aux marker classes) → real Zeck executions (idempotent create over
 * HTTP through the real SDK) → the rail drive through the authority's
 * transitions → the normalized facts read back through the PUBLIC events
 * read → the JSON + SSE renderings → the speech (audio bytes),
 * transcription (multipart) and images (b64) renderings → idempotent
 * replay → the fault-injected provider-failure path (the honest FAILED
 * terminal state).
 */

import { afterAll, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composeProofStack, type ComposeStackOptions, type ProofStack } from "../harness/compose";
import { createAdapterServer, parseMultipart, type AdapterServer } from "../adapter/server";
import { createSdkTraceSource } from "../harness/trace";
import {
  HERMES_TURN_NAME,
} from "../harness/rail-protocol";

interface Composed {
  adapter: AdapterServer;
  stack: ProofStack;
}

const composed: Composed[] = [];

/**
 * The hermetic supply stub: routes by URL to the surface-appropriate
 * canned response (chat JSON, audio bytes, ASR JSON, image JSON).
 */
function stubSupply(options?: { failure?: { status: number } }) {
  return async (
    _request: { readonly url: string; readonly bodyJson?: unknown },
    next: () => Promise<{ readonly status: number; readonly text: string }>,
  ): Promise<{ readonly status: number; readonly text: string }> => {
    void next;
    if (options?.failure !== undefined) {
      return {
        status: options.failure.status,
        text: JSON.stringify({ error: { message: "stub-injected failure" } }),
      };
    }
    const url = _request.url;
    if (url.includes("/chat/completions")) {
      return {
        status: 200,
        text: JSON.stringify({
          id: "stub-chat",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "All done. DONE." },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46 },
        }),
      };
    }
    if (url.includes("/audio/tts")) {
      // Audio bytes re-encoded through the fault-injection text path —
      // the rail's speech surface collectBodyBuffer re-decodes them.
      const wav = Buffer.alloc(4096, 0x11);
      return { status: 200, text: wav.toString("utf8") };
    }
    if (url.includes("/audio/asr")) {
      return {
        status: 200,
        text: JSON.stringify({
          text: "Proof of life, Hermes test one.",
          usage: { prompt_tokens: 94, completion_tokens: 11, total_tokens: 105 },
        }),
      };
    }
    if (url.includes("/images/generations")) {
      return {
        status: 200,
        text: JSON.stringify({ data: [{ base64: "c3R1Yi1pbWFnZS1iNjQ=" }] }),
      };
    }
    return { status: 404, text: JSON.stringify({ error: "no such surface" }) };
  };
}

async function composeWith(faultInjector?: ComposeStackOptions["faultInjector"]) {
  const stack = await composeProofStack({ faultInjector, minDispatchIntervalMs: 0, retryCooldownMs: 10 });
  const adapter = await createAdapterServer({
    apiBaseUrl: stack.apiBaseUrl,
    token: stack.apiToken,
    applicationId: stack.applicationId,
  });
  composed.push({ adapter, stack });
  return { adapter, stack };
}

afterAll(async () => {
  for (const { adapter, stack } of composed) {
    adapter.close();
    await stack.close();
  }
});

async function postJson(
  adapter: AdapterServer,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: unknown; text: string }> {
  const response = await fetch(`${adapter.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

const BASE_REQUEST = {
  model: "glm-4-plus",
  messages: [
    { role: "system", content: "You are Hermes Agent, a helpful AI assistant." },
    { role: "user", content: "Write SMOKE-OUT into out.txt." },
  ],
};

describe("PPR-022 seam end-to-end (composed stack over an injected supply)", () => {
  test("a chat request becomes a completed Zeck execution whose turn reads back over the public API", async () => {
    const { adapter, stack } = await composeWith(stubSupply());
    const result = await postJson(adapter, "/chat/completions", BASE_REQUEST);
    expect(result.status).toBe(200);
    const body = result.json as {
      choices: { message: { content: string }; finish_reason: string }[];
      usage: { prompt_tokens: number };
    };
    expect(body.choices[0]?.message.content).toBe("All done. DONE.");
    expect(body.usage.prompt_tokens).toBe(40);

    const log = adapter.requests()[adapter.requests().length - 1]!;
    expect(log.edgeId).toBe("hermes.agent-loop.main");
    expect(log.terminal).toBe("COMPLETED");
    expect(log.replayed).toBe(false);

    // The execution is durably correlated through the SDK wire reads.
    const traceSource = createSdkTraceSource({
      apiBaseUrl: stack.apiBaseUrl,
      token: stack.apiToken,
      applicationId: stack.applicationId,
    });
    const read = await traceSource.readExecutionTrace(stack.applicationId, log.executionId);
    expect(read.execution?.status).toBe("COMPLETED");
    expect(read.events.length).toBeGreaterThan(0);
    expect(read.verification.length).toBeGreaterThan(0);
    expect(read.route?.model).toBe("glm-4-plus");
    const fact = stack.railFacts().find((f) => f.executionId === log.executionId);
    expect(fact?.usage?.inputTokens).toBe(40);
  });

  test("the automatic title marker attributes to the title-generation aux edge", async () => {
    const { adapter } = await composeWith(stubSupply());
    const result = await postJson(adapter, "/chat/completions", {
      ...BASE_REQUEST,
      messages: [
        {
          role: "system",
          content:
            "You name chat sessions. Given the user's opening message, write a title. Reply with JSON only.",
        },
        { role: "user", content: "Reply with exactly: PROBE-OK" },
      ],
      response_format: { type: "json_schema" },
    });
    expect(result.status).toBe(200);
    const log = adapter.requests()[adapter.requests().length - 1]!;
    expect(log.edgeId).toBe("hermes.auxiliary.title-generation");
  });

  test("the compression marker attributes to the compression aux edge", async () => {
    const { adapter } = await composeWith(stubSupply());
    const result = await postJson(adapter, "/chat/completions", {
      ...BASE_REQUEST,
      messages: [
        {
          role: "user",
          content:
            "You are a summarization agent creating a context checkpoint. TURNS TO SUMMARIZE: ...",
        },
      ],
    });
    expect(result.status).toBe(200);
    const log = adapter.requests()[adapter.requests().length - 1]!;
    expect(log.edgeId).toBe("hermes.auxiliary.compression");
  });

  test("a vision-carrying request routes to the vision model and the vision edge", async () => {
    const { adapter, stack } = await composeWith(stubSupply());
    const result = await postJson(adapter, "/chat/completions", {
      ...BASE_REQUEST,
      messages: [
        { role: "system", content: "You are Hermes Agent." },
        {
          role: "user",
          content: [
            { type: "text", text: "What color is this?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ],
    });
    expect(result.status).toBe(200);
    const log = adapter.requests()[adapter.requests().length - 1]!;
    expect(log.edgeId).toBe("hermes.auxiliary.vision-analyze");
    const traceSource = createSdkTraceSource({
      apiBaseUrl: stack.apiBaseUrl,
      token: stack.apiToken,
      applicationId: stack.applicationId,
    });
    const read = await traceSource.readExecutionTrace(stack.applicationId, log.executionId);
    expect(read.route?.model).toBe("glm-4.5v");
  });

  test("the SSE rendering emits the terminal chunk sequence", async () => {
    const { adapter } = await composeWith(stubSupply());
    const response = await fetch(`${adapter.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...BASE_REQUEST, stream: true }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const text = await response.text();
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain("All done. DONE.");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  test("the speech surface returns audio bytes from the delegated execution", async () => {
    const { adapter } = await composeWith(stubSupply());
    const response = await fetch(`${adapter.url}/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        input: "Proof of the speech surface.",
        voice: "alloy",
        response_format: "wav",
      }),
    });
    expect(response.status).toBe(200);
    const audio = Buffer.from(await response.arrayBuffer());
    expect(audio.length).toBe(4096);
    const log = adapter.requests()[adapter.requests().length - 1]!;
    expect(log.edgeId).toBe("hermes.tool.tts-openai");
    expect(log.terminal).toBe("COMPLETED");
  });

  test("the transcription surface accepts multipart and returns the transcript text", async () => {
    const { adapter } = await composeWith(stubSupply());
    const wav = readFileSync(join(process.cwd(), "compat/hermes-agent/corpus/assets/known-phrase.wav"));
    const boundary = "----vitestboundary";
    const parts: Buffer[] = [];
    parts.push(Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="memo.wav"\r\ncontent-type: audio/wav\r\n\r\n`));
    parts.push(wav);
    parts.push(Buffer.from(`\r\n--${boundary}\r\ncontent-disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}--\r\n`));
    const response = await fetch(`${adapter.url}/audio/transcriptions`, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: Buffer.concat(parts),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { text: string };
    expect(body.text).toBe("Proof of life, Hermes test one.");
    const log = adapter.requests()[adapter.requests().length - 1]!;
    expect(log.edgeId).toBe("hermes.tool.stt-openai");
    expect(log.terminal).toBe("COMPLETED");
  });

  test("the multipart parser extracts file and field parts", () => {
    const boundary = "----parsecheck";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="a.wav"\r\n\r\n`),
      Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00]),
      Buffer.from(`\r\n--${boundary}\r\ncontent-disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}--\r\n`),
    ]);
    const parts = parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
    expect(parts).toHaveLength(2);
    expect(parts[0]?.name).toBe("file");
    expect(parts[0]?.filename).toBe("a.wav");
    expect([...(parts[0]?.data ?? [])]).toEqual([0x52, 0x49, 0x46, 0x46, 0x00]);
    expect(parts[1]?.name).toBe("model");
    expect(parts[1]?.data.toString("utf8")).toBe("whisper-1");
  });

  test("the images surface returns the b64 artifact from the delegated execution", async () => {
    const { adapter } = await composeWith(stubSupply());
    const result = await postJson(adapter, "/images/generations", {
      model: "gpt-image-2",
      prompt: "a teal circle icon",
      size: "1024x1024",
      n: 1,
    });
    expect(result.status).toBe(200);
    const body = result.json as { data: { b64_json: string }[] };
    expect(body.data[0]?.b64_json).toBe("c3R1Yi1pbWFnZS1iNjQ=");
    const log = adapter.requests()[adapter.requests().length - 1]!;
    expect(log.edgeId).toBe("hermes.tool.image-generate-openai");
    expect(log.terminal).toBe("COMPLETED");
  });

  test("an identical chat request replays the durable outcome (content-addressed idempotency)", async () => {
    const { adapter } = await composeWith(stubSupply());
    const first = await postJson(adapter, "/chat/completions", BASE_REQUEST);
    expect(first.status).toBe(200);
    const second = await postJson(adapter, "/chat/completions", BASE_REQUEST);
    expect(second.status).toBe(200);
    const logs = adapter.requests();
    const last = logs[logs.length - 1]!;
    expect(last.replayed).toBe(true);
    expect(last.executionId).toBe(logs[logs.length - 2]?.executionId);
  });

  test("a fault-injected provider failure lands the execution in the honest FAILED terminal state", async () => {
    const { adapter } = await composeWith(stubSupply({ failure: { status: 503 } }));
    const result = await postJson(adapter, "/chat/completions", BASE_REQUEST);
    expect(result.status).toBe(500);
    const log = adapter.requests()[adapter.requests().length - 1]!;
    expect(log.terminal).toBe("FAILED");
    expect(log.finishReason).toBe("error");
  });

  test("the adapter serves the model catalog Hermes probes (GET /models)", async () => {
    const { adapter } = await composeWith(stubSupply());
    const response = await fetch(`${adapter.url}/models`, { method: "GET" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { id: string }[] };
    expect(body.data.map((model) => model.id)).toContain("glm-4-plus");
  });

  test("unknown surfaces 404 (the adapter serves only the declared surfaces)", async () => {
    const { adapter } = await composeWith(stubSupply());
    const response = await fetch(`${adapter.url}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "x" }),
    });
    expect(response.status).toBe(404);
  });

  test("the structured-output contract name of the chat turn is pinned", () => {
    expect(HERMES_TURN_NAME).toBe("hermes-agent-turn");
  });
});
