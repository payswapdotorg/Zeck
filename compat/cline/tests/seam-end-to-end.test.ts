/**
 * PPR-019 seam end-to-end test: the full composed stack (real Zeck
 * public API + real model gateway + rail worker + adapter) over an
 * INJECTED supply transport (a hermetic stub for the unit suite — the
 * live GLM supply is exercised by the battery, not by tests).
 *
 * Exercises: OpenAI-shaped request (with the tools axis and tool-call
 * history) → Zeck execution (idempotent create over HTTP through the
 * real SDK) → rail drive through the authority's transitions →
 * planning decision + step events + verification on the ledger → the
 * normalized turn (text + tool calls) read back through the PUBLIC
 * events read → SSE rendering (text deltas + tool_call deltas +
 * finish_reason) → idempotent replay of the same request → SDK-wire
 * trace correlation → the fault-injected provider-failure path (the
 * honest FAILED terminal state).
 */

import { afterAll, describe, expect, test } from "vitest";
import { composeProofStack, type ProofStack } from "../harness/compose";
import { createAdapterServer, type AdapterServer } from "../adapter/server";
import { createSdkTraceSource } from "../harness/trace";

interface Composed {
  adapter: AdapterServer;
  stack: ProofStack;
}

const composed: Composed[] = [];

function stubSupply(options?: { toolCall?: boolean; failure?: { status: number } }) {
  return async () => {
    if (options?.failure) {
      return { status: options.failure.status, text: JSON.stringify({ error: "stub failure" }) };
    }
    if (options?.toolCall) {
      return {
        status: 200,
        text: JSON.stringify({
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: "I'll write it.",
                tool_calls: [
                  {
                    id: "call_stub_1",
                    type: "function",
                    function: { name: "write_file", arguments: "{\"path\":\"out.txt\",\"content\":\"hi\"}" },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        }),
      };
    }
    return {
      status: 200,
      text: JSON.stringify({
        choices: [
          { index: 0, finish_reason: "stop", message: { role: "assistant", content: "STUB-COMPLETION" } },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
    };
  };
}

async function compose(stub: () => Promise<{ status: number; text: string }>): Promise<Composed> {
  const stack = await composeProofStack({ faultInjector: stub, minDispatchIntervalMs: 0, retryCooldownMs: 0 });
  const adapter = await createAdapterServer({
    apiBaseUrl: stack.apiBaseUrl,
    token: stack.world.bearerToken,
    applicationId: stack.world.applicationId,
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

const PLAN_SYSTEM = "You are Cline.\n\n# Plan Mode\n\nYou are in Plan mode.";

describe("the PPR-019 adapter seam over the real Zeck public API", () => {
  test("an OpenAI-shaped request completes through a real Zeck execution (non-streaming)", async () => {
    const { adapter } = await compose(stubSupply());
    const response = await fetch(`${adapter.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "glm-4-plus",
        messages: [
          { role: "system", content: "You are a coding agent." },
          { role: "user", content: "Reply with exactly: SEAM-OK" },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      id?: string;
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    expect(body.choices?.[0]?.message?.content).toBe("STUB-COMPLETION");
    expect(body.choices?.[0]?.finish_reason).toBe("stop");
    expect(body.usage?.prompt_tokens).toBe(5);
    expect(body.id).toMatch(/^zeck-/);
    const log = adapter.requests()[0];
    expect(log?.edgeId).toBe("cline.agent-loop.act");
    expect(log?.terminal).toBe("COMPLETED");
    expect(log?.executionId.startsWith("00000000-")).toBe(true);
  });

  test("a plan-mode request attributes to the plan edge and carries it into the execution metadata", async () => {
    const { adapter, stack } = await compose(stubSupply());
    await fetch(`${adapter.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "glm-4-plus",
        messages: [
          { role: "system", content: PLAN_SYSTEM },
          { role: "user", content: "Plan the change." },
        ],
      }),
    });
    const log = adapter.requests()[0];
    expect(log?.edgeId).toBe("cline.agent-loop.plan");
    const client = await import("../../../sdk").then((sdk) =>
      sdk.createZeckClient({
        baseUrl: stack.apiBaseUrl,
        token: stack.world.bearerToken,
        applicationId: stack.world.applicationId,
      }),
    );
    const execution = await client.getExecution(log?.executionId ?? "");
    expect(execution.metadata).toMatchObject({ edge: "cline.agent-loop.plan", origin: "ppr-019-cline-adapter" });
  });

  test("a tool-carrying request renders streaming tool_call deltas in OpenAI SSE format", async () => {
    const { adapter } = await compose(stubSupply({ toolCall: true }));
    const response = await fetch(`${adapter.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "glm-4-plus",
        stream: true,
        messages: [
          { role: "system", content: "You are Cline." },
          { role: "user", content: "Write out.txt with hi." },
          {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "call_prev", type: "function", function: { name: "read_files", arguments: "{}" } }],
          },
          { role: "tool", tool_call_id: "call_prev", content: "ok" },
        ],
        tools: [
          { type: "function", function: { name: "write_file", description: "Write", parameters: { type: "object" } } },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const sse = await response.text();
    const chunks = sse
      .split("\n\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)) as {
        choices?: { delta?: { tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
        usage?: { prompt_tokens?: number };
      });
    const toolChunk = chunks.find((chunk) => (chunk.choices?.[0]?.delta?.tool_calls ?? []).length > 0);
    expect(toolChunk?.choices?.[0]?.delta?.tool_calls?.[0]?.id).toBe("call_stub_1");
    expect(toolChunk?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name).toBe("write_file");
    expect(toolChunk?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments).toContain("out.txt");
    const finishChunk = chunks.find((chunk) => chunk.choices?.[0]?.finish_reason === "tool_calls");
    expect(finishChunk).toBeDefined();
    const usageChunk = chunks.find((chunk) => chunk.usage !== undefined);
    expect(usageChunk?.usage?.prompt_tokens).toBe(11);
    expect(sse.trimEnd().endsWith("data: [DONE]")).toBe(true);
    const log = adapter.requests()[0];
    expect(log?.toolCallCount).toBe(1);
    expect(log?.finishReason).toBe("tool_calls");
  });

  test("the identical request replays the durable outcome (content-addressed idempotency)", async () => {
    const { adapter, stack } = await compose(stubSupply());
    const body = JSON.stringify({
      model: "glm-4-plus",
      messages: [
        { role: "system", content: "You are a coding agent." },
        { role: "user", content: "Reply with exactly: SEAM-OK" },
      ],
    });
    const first = await fetch(`${adapter.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(first.status).toBe(200);
    const second = await fetch(`${adapter.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(second.status).toBe(200);
    const logs = adapter.requests();
    expect(logs.length).toBe(2);
    expect(logs[1]?.executionId).toBe(logs[0]?.executionId);
    expect(logs[1]?.replayed).toBe(true);
    // Exactly ONE rail dispatch happened for two identical requests.
    const dispatches = stack.railFacts().filter((fact) => fact.executionId === logs[0]?.executionId);
    expect(dispatches.length).toBe(1);
  });

  test("SDK-wire trace correlation reads every execution back with durable evidence", async () => {
    const { adapter, stack } = await compose(stubSupply());
    await fetch(`${adapter.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "glm-4-plus",
        messages: [
          { role: "system", content: PLAN_SYSTEM },
          { role: "user", content: "Plan it." },
        ],
      }),
    });
    const traceSource = createSdkTraceSource({
      apiBaseUrl: stack.apiBaseUrl,
      token: stack.world.bearerToken,
      applicationId: stack.world.applicationId,
    });
    const log = adapter.requests()[0];
    const read = await traceSource.readExecutionTrace(stack.world.applicationId, log?.executionId ?? "");
    expect(read.execution?.status).toBe("COMPLETED");
    expect(read.execution?.terminal).toBe(true);
    expect(read.events.length).toBeGreaterThan(5);
    expect(read.verification.length).toBeGreaterThanOrEqual(1);
    expect(read.route?.provider).toBe("custom");
    expect(read.route?.model).toBe("glm-4-plus");
    expect(read.route?.strategyClass).toBe("model-rail");
  });

  test("a fault-injected supply lands the execution in the honest FAILED terminal state", async () => {
    const { adapter } = await compose(stubSupply({ failure: { status: 503 } }));
    const response = await fetch(`${adapter.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "glm-4-plus",
        messages: [
          { role: "system", content: "You are a coding agent." },
          { role: "user", content: "This dispatch will fail." },
        ],
      }),
    });
    expect(response.status).toBe(500);
    const errorBody = (await response.json()) as { error?: { message?: string } };
    expect(errorBody.error?.message).toContain("FAILED");
    const log = adapter.requests()[0];
    expect(log?.terminal).toBe("FAILED");
    expect(log?.contentChars).toBe(0);
  });
});
