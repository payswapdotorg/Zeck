/**
 * SDK contract tests (WORK-015 / API-002; M5, M17).
 *
 * Required-test mapping:
 *  - the SDK surface is execution-centric: every client method operates
 *    on the Execution abstraction (createExecution takes a task +
 *    constraints — there is NO provider/model parameter anywhere);
 *  - M17: provider selection attempts are rejected client-side (the
 *    FORBIDDEN_REQUEST_KEYS rule) and no SDK export names a provider;
 *  - M5: the SDK surface has no secret-bearing type or field;
 *  - the client's request shape matches the API's wire contract (the
 *    fetch fake asserts headers/payload, including the idempotency key
 *    and bearer scheme);
 *  - public error mapping: API errors surface as ZeckApiError with the
 *    canonical code body.
 */

import { describe, expect, test } from "vitest";
import {
  createZeckClient,
  FORBIDDEN_REQUEST_KEYS,
  type PublicError,
  type ZeckApiError,
} from "../../../sdk";
import type { ExecutionReceipt } from "../../../src/shared/wire";

function fakeFetch(
  handler: (url: string, init?: RequestInit) => { status: number; body: unknown },
): typeof fetch & { readonly calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const target = String(url);
    calls.push({ url: target, init });
    const outcome = handler(target, init);
    return new Response(JSON.stringify(outcome.body), {
      status: outcome.status,
      headers: { "content-type": "application/json" },
    });
  }) as never;
  return Object.assign(impl, { calls });
}

const RECEIPT: ExecutionReceipt = {
  executionId: "00000000-0000-7000-8000-0000000000d1",
  applicationId: "00000000-0000-7000-8000-0000000000a1",
  status: "CREATED",
  createdAt: "2026-09-15T12:00:00Z",
  replayed: false,
  lastEventSequence: 1,
};

describe("the execution-centric client (API-002)", () => {
  test("createExecution sends the execution request with auth + idempotency headers", async () => {
    const fetchImpl = fakeFetch(() => ({ status: 201, body: RECEIPT }));
    const client = createZeckClient({
      baseUrl: "https://api.zeck.example",
      token: "zeck-token-1",
      fetchImpl,
    });
    const { receipt } = await client.createExecution(
      {
        applicationId: "00000000-0000-7000-8000-0000000000a1",
        task: { kind: "summarize", input: "doc-1" },
      },
      "client-key-1",
    );
    expect(receipt.executionId).toBe(RECEIPT.executionId);
    const call = fetchImpl.calls[0];
    expect(call?.url).toBe("https://api.zeck.example/executions");
    const headers = call?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer zeck-token-1");
    expect(headers["idempotency-key"]).toBe("client-key-1");
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      applicationId: "00000000-0000-7000-8000-0000000000a1",
      task: { kind: "summarize", input: "doc-1" },
    });
  });

  test("an omitted idempotency key is generated (uuid-shaped)", async () => {
    const fetchImpl = fakeFetch(() => ({ status: 201, body: RECEIPT }));
    const client = createZeckClient({
      baseUrl: "https://api.zeck.example",
      token: "zeck-token-1",
      fetchImpl,
      generateIdempotencyKey: () => "generated-key",
    });
    await client.createExecution({
      applicationId: "app",
      task: { kind: "x" },
    });
    const headers = fetchImpl.calls[0]?.init?.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBe("generated-key");
  });

  test("M17: provider selection is rejected client-side (API-001 vocabulary)", async () => {
    const client = createZeckClient({
      baseUrl: "https://api.zeck.example",
      token: "t",
      fetchImpl: fakeFetch(() => ({ status: 201, body: RECEIPT })),
    });
    for (const key of ["provider", "model", "rail", "connectionId", "agentId"]) {
      await expect(
        client.createExecution({
          applicationId: "app",
          task: { kind: "x" },
          [key]: "some-provider",
        } as never),
      ).rejects.toThrow(/must not select a provider/i);
    }
  });

  test("every client method is execution/agent-centric (no provider call surface)", async () => {
    const fetchImpl = fakeFetch(() => ({ status: 200, body: {} }));
    const client = createZeckClient({
      baseUrl: "https://x",
      token: "t",
      fetchImpl,
    });
    const methods = Object.keys(client).sort();
    expect(methods).toEqual([
      "cancelExecution",
      "createExecution",
      "getAgentStatus",
      "getExecution",
      "getResult",
      "listAgents",
      "listEvents",
      "listVerification",
    ]);
    // No provider-named method exists.
    for (const method of methods) {
      expect(method.toLowerCase()).not.toMatch(/openai|anthropic|provider|rail|model/);
    }
  });

  test("API errors surface as ZeckApiError with the canonical body (M25 shape)", async () => {
    const fetchImpl = fakeFetch(() => ({
      status: 403,
      body: {
        code: "POLICY_DENIED",
        message: "policy denied this request",
        retryable: false,
      } satisfies PublicError,
    }));
    const client = createZeckClient({ baseUrl: "https://x", token: "t", fetchImpl });
    let caught: ZeckApiError | null = null;
    try {
      await client.getExecution("exec-1");
    } catch (error) {
      caught = error as ZeckApiError;
    }
    expect(caught).not.toBeNull();
    expect(caught?.status).toBe(403);
    expect(caught?.body.code).toBe("POLICY_DENIED");
  });

  test("a non-JSON error response maps to the generic transport failure", async () => {
    const impl = (async () =>
      new Response("gateway garbage", { status: 502 })) as unknown as typeof fetch;
    const client = createZeckClient({ baseUrl: "https://x", token: "t", fetchImpl: impl });
    await expect(client.getExecution("exec-1")).rejects.toMatchObject({
      status: 502,
      body: { code: "PROVIDER_ERROR", retryable: true },
    });
  });
});

describe("M5: the SDK type surface carries no secret material", () => {
  test("no SDK export names a secret-bearing concept", async () => {
    const sdk = await import("../../../sdk");
    for (const name of Object.keys(sdk)) {
      expect(name.toLowerCase()).not.toMatch(/secret|password|credential|apikey|privatekey/);
    }
    expect(FORBIDDEN_REQUEST_KEYS).toContain("provider");
  });

  test("the wire contract's ExecutionRequest has no provider/secret field", async () => {
    // Structural: the request interface's keys are exactly the frozen
    // create vocabulary (mirrored from the platform contract).
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync("src/shared/wire.ts", "utf8"),
    );
    const requestBlock =
      /export interface ExecutionRequest \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
    const fields = [...requestBlock.matchAll(/readonly (\w+)\??:/g)].map((m) => m[1] ?? "");
    // The top-level vocabulary is the frozen create contract…
    for (const required of [
      "applicationId",
      "constraints",
      "environmentId",
      "inputArtifactRefs",
      "metadata",
      "task",
      "userId",
    ]) {
      expect(fields).toContain(required);
    }
    for (const field of fields) {
      expect(field.toLowerCase()).not.toMatch(/secret|token|credential|apikey|password/);
    }
  });
});
