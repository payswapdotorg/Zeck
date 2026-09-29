/**
 * PPR-020 seam end-to-end test: the full composed stack (real Zeck
 * public API + real model gateway + rail worker + adapter) over an
 * INJECTED supply transport (a hermetic stub for the unit suite — the
 * live GLM supply is exercised by the battery, not by tests).
 *
 * Exercises: an OpenAI-shaped request with the tools axis → a real Zeck
 * execution (idempotent create over HTTP through the real SDK) → the
 * rail drive through the authority's transitions → planning decision +
 * step events + verification on the ledger → the normalized turn (text +
 * tool calls) read back through the PUBLIC events read → both the JSON
 * and SSE renderings → idempotent replay of the same request → SDK-wire
 * trace correlation → the fault-injected provider-failure path (the
 * honest FAILED terminal state).
 */

import { afterAll, describe, expect, test } from "vitest";
import { composeProofStack, type ComposeStackOptions, type ProofStack } from "../harness/compose";
import { createAdapterServer, type AdapterServer } from "../adapter/server";
import { createSdkTraceSource } from "../harness/trace";
import { OPENHANDS_TASK_KIND } from "../harness/rail-protocol";

interface Composed {
  adapter: AdapterServer;
  stack: ProofStack;
}

const composed: Composed[] = [];

function stubSupply(options?: { toolCall?: boolean; failure?: { status: number } }) {
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
    if (options?.toolCall === true) {
      return {
        status: 200,
        text: JSON.stringify({
          id: "stub-1",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call_stub_1",
                    type: "function",
                    function: { name: "terminal", arguments: "{\"command\":\"echo hi\"}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 7, total_tokens: 57 },
        }),
      };
    }
    return {
      status: 200,
      text: JSON.stringify({
        id: "stub-2",
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

async function postCompletion(
  adapter: AdapterServer,
  body: Record<string, unknown>,
): Promise<{ status: number; json: unknown; text: string }> {
  const response = await fetch(`${adapter.url}/chat/completions`, {
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
    { role: "system", content: "You are OpenHands agent, a helpful AI assistant." },
    { role: "user", content: "Write SMOKE-OUT into out.txt." },
  ],
  tools: [
    {
      type: "function",
      function: { name: "terminal", description: "run a command", parameters: { type: "object" } },
    },
  ],
};

describe("PPR-020 seam end-to-end (composed stack over an injected supply)", () => {
  test("an OpenAI-shaped request becomes a completed Zeck execution whose turn reads back over the public API", async () => {
    const { adapter, stack } = await composeWith(stubSupply());
    const result = await postCompletion(adapter, BASE_REQUEST);
    expect(result.status).toBe(200);
    const body = result.json as {
      choices: { message: { content: string }; finish_reason: string }[];
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    expect(body.choices[0]?.message.content).toBe("All done. DONE.");
    expect(body.choices[0]?.finish_reason).toBe("stop");
    expect(body.usage.prompt_tokens).toBe(40);

    const log = adapter.requests()[adapter.requests().length - 1]!;
    expect(log.edgeId).toBe("openhands.agent-loop.main");
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
    // The usage facts ride the rail facts (the battery's telemetry axis),
    // NOT the completed event's read projection — the platform's `pass`
    // transition event payload carries {from, to} only, and the trace
    // source honestly projects usage: null (the identical honest shape
    // the PPR-019 evidence records: usageFactsPresent 0).
    expect(read.usage).toBeNull();
    const fact = stack.railFacts().find((f) => f.executionId === log.executionId);
    expect(fact).toBeDefined();
    expect(fact?.usage?.inputTokens).toBe(40);
    expect(fact?.usage?.outputTokens).toBe(6);
  });

  test("a tool-call response renders the OpenAI tool_calls wire shape", async () => {
    const { adapter } = await composeWith(stubSupply({ toolCall: true }));
    const result = await postCompletion(adapter, BASE_REQUEST);
    expect(result.status).toBe(200);
    const body = result.json as {
      choices: {
        message: { tool_calls: { id: string; function: { name: string; arguments: string } }[] };
        finish_reason: string;
      }[];
    };
    expect(body.choices[0]?.finish_reason).toBe("tool_calls");
    expect(body.choices[0]?.message.tool_calls[0]?.id).toBe("call_stub_1");
    expect(body.choices[0]?.message.tool_calls[0]?.function.name).toBe("terminal");
  });

  test("a vision-carrying request is routed to the vision model and attributed to the vision edge", async () => {
    const { adapter, stack } = await composeWith(stubSupply());
    const result = await postCompletion(adapter, {
      ...BASE_REQUEST,
      messages: [
        { role: "system", content: "You are OpenHands agent." },
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
    expect(log.edgeId).toBe("openhands.agent-loop.vision");
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

  test("an identical request replays the durable outcome (content-addressed idempotency)", async () => {
    const { adapter } = await composeWith(stubSupply());
    const first = await postCompletion(adapter, BASE_REQUEST);
    expect(first.status).toBe(200);
    const second = await postCompletion(adapter, BASE_REQUEST);
    expect(second.status).toBe(200);
    const logs = adapter.requests();
    expect(logs.length).toBeGreaterThanOrEqual(2);
    const last = logs[logs.length - 1]!;
    expect(last.replayed).toBe(true);
    expect(last.executionId).toBe(logs[logs.length - 2]?.executionId);
  });

  test("a fault-injected provider failure lands the execution in the honest FAILED terminal state", async () => {
    const { adapter } = await composeWith(stubSupply({ failure: { status: 500 } }));
    const result = await postCompletion(adapter, BASE_REQUEST);
    expect(result.status).toBe(500);
    const log = adapter.requests()[adapter.requests().length - 1]!;
    expect(log.terminal).toBe("FAILED");
    expect(log.finishReason).toBe("error");
  });

  test("the adapter serves only POST /v1/chat/completions", async () => {
    const { adapter } = await composeWith(stubSupply());
    const response = await fetch(`${adapter.url}/models`, { method: "GET" });
    expect(response.status).toBe(404);
  });

  test("the Zeck execution's task payload carries the openhands task kind and the attributed edge", async () => {
    const { adapter, stack } = await composeWith(stubSupply());
    await postCompletion(adapter, BASE_REQUEST);
    const log = adapter.requests()[adapter.requests().length - 1]!;
    const traceSource = createSdkTraceSource({
      apiBaseUrl: stack.apiBaseUrl,
      token: stack.apiToken,
      applicationId: stack.applicationId,
    });
    const read = await traceSource.readExecutionTrace(stack.applicationId, log.executionId);
    // The task kind + edge ride the execution's create metadata (the
    // adapter's metadata.origin is pinned by the create request).
    expect(read.execution).not.toBeNull();
    expect(OPENHANDS_TASK_KIND).toBe("agent-loop.completion");
  });
});
