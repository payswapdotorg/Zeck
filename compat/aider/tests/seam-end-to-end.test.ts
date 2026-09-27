/**
 * PPR-018 seam end-to-end test: the full composed stack (real Zeck
 * public API + real model gateway + rail worker + adapter) over an
 * INJECTED supply transport (a hermetic stub for the unit suite — the
 * live GLM supply is exercised by the battery, not by tests).
 *
 * Exercises: OpenAI-shaped request → Zeck execution (idempotent create
 * over HTTP through the real SDK) → rail drive through the authority's
 * transitions → planning decision + step events + verification on the
 * ledger → completion read back through the PUBLIC events read →
 * idempotent replay of the same request → SDK-wire trace correlation.
 */

import { afterAll, describe, expect, test } from "vitest";
import { composeProofStack, type ProofStack } from "../harness/compose";
import { createAdapterServer, type AdapterServer } from "../adapter/server";
import { createSdkTraceSource, traceFactOf } from "../harness/trace";

const stacks: { adapter: AdapterServer; stack: ProofStack }[] = [];

async function composedStack(): Promise<{ adapter: AdapterServer; stack: ProofStack }> {
  const stack = await composeProofStack({
    // The hermetic unit-suite supply: a canned OpenAI-shaped response
    // behind the REAL gateway + rail + adapter path (test-only fixture —
    // the battery's live proof uses the real GLM supply).
    faultInjector: async () => ({
      status: 200,
      text: JSON.stringify({
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "STUB-COMPLETION" },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
    }),
  });
  const adapter = await createAdapterServer({
    apiBaseUrl: stack.apiBaseUrl,
    token: stack.world.bearerToken,
    applicationId: stack.world.applicationId,
  });
  stacks.push({ adapter, stack });
  return { adapter, stack };
}

afterAll(async () => {
  for (const { adapter, stack } of stacks) {
    adapter.close();
    await stack.close();
  }
});

describe("the adapter seam over the real Zeck public API", () => {
  test("an OpenAI-shaped request completes through a real Zeck execution", async () => {
    const { adapter } = await composedStack();
    const response = await fetch(`${adapter.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "zeck-coder",
        messages: [
          { role: "system", content: "You are a coding assistant." },
          { role: "user", content: "Reply with exactly: SEAM-OK" },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    expect(body.choices?.[0]?.message?.content?.length ?? 0).toBeGreaterThan(0);
    const log = adapter.requests()[0];
    expect(log?.edgeId).toBe("aider.main-completion");
    expect(log?.terminal).toBe("COMPLETED");
  });

  test("edge attribution flows into the Zeck execution metadata", async () => {
    const { adapter, stack } = await composedStack();
    const commitSystem = `You are an expert software engineer that generates concise, one-line Git commit messages based on the provided diffs.
Review the provided context and diffs.`;
    await fetch(`${adapter.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "zeck-weak",
        messages: [
          { role: "system", content: commitSystem },
          { role: "user", content: "diff --git a/x b/x" },
        ],
      }),
    });
    const log = adapter.requests()[0];
    expect(log?.edgeId).toBe("aider.commit-message");
    const execution = await stack.world.executions.getExecution(
      stack.world.applicationId,
      log?.executionId ?? "",
    );
    expect(execution?.metadata?.edge).toBe("aider.commit-message");
    expect(execution?.metadata?.aiderModel).toBe("zeck-weak");
  });

  test("the identical request replays the durable outcome (idempotency)", async () => {
    const { adapter } = await composedStack();
    const body = JSON.stringify({
      model: "zeck-coder",
      messages: [{ role: "user", content: "Reply with exactly: REPLAY-OK" }],
    });
    const first = await fetch(`${adapter.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const firstJson = (await first.json()) as { id?: string };
    const second = await fetch(`${adapter.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const secondJson = (await second.json()) as { id?: string };
    expect(second.status).toBe(200);
    expect(secondJson.id).toBe(firstJson.id);
    const logs = adapter.requests().filter((log) => log.replayed);
    expect(logs.length).toBe(1);
  });

  test("the SDK-wire trace source correlates the delegated execution", async () => {
    const { adapter, stack } = await composedStack();
    await fetch(`${adapter.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "zeck-coder",
        messages: [{ role: "user", content: "Reply with exactly: TRACE-OK" }],
      }),
    });
    const log = adapter.requests()[0];
    expect(log).toBeDefined();
    const trace = createSdkTraceSource({
      apiBaseUrl: stack.apiBaseUrl,
      token: stack.world.bearerToken,
      applicationId: stack.world.applicationId,
    });
    const fact = await traceFactOf(
      trace,
      stack.world.applicationId,
      "aider.main-completion",
      log?.executionId ?? "",
    );
    expect(fact.found).toBe(true);
    expect(fact.status).toBe("COMPLETED");
    expect(fact.terminal).toBe(true);
    expect(fact.eventCount).toBeGreaterThan(5);
    expect(fact.verificationCount).toBeGreaterThanOrEqual(2);
    expect(fact.passingVerificationCount).toBeGreaterThanOrEqual(1);
    expect(fact.correlated).toBe(true);
    expect(fact.route).toEqual({
      provider: "custom",
      model: "glm-4-plus",
      strategyClass: "model-rail",
    });
  });

  test("an unknown path is a 404 and a malformed body a 400", async () => {
    const { adapter } = await composedStack();
    const notFound = await fetch(`${adapter.url}/other`, { method: "POST" });
    expect(notFound.status).toBe(404);
    const bad = await fetch(`${adapter.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    expect(bad.status).toBe(400);
  });
});
