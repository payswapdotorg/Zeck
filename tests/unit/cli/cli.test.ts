/**
 * CLI tests (WORK-015; acceptance criterion 3, M6, M17/M18; WORK-034).
 *
 * Required-test mapping:
 *  - submit/inspect/result/events/cost/verify/cancel/agents/agent
 *    commands operate through the SDK (execution-centric);
 *  - M6: the CLI never prints secret material (error paths included);
 *    credentials come from the environment (never flags);
 *  - M17/M18: there is no provider-flavored command;
 *  - the usage text documents the environment contract;
 *  - WORK-034: every scoped command sends the application argument as
 *    the X-Zeck-Application client scope (creation keeps its body scope).
 */

import { describe, expect, test } from "vitest";
import { runCli } from "../../../cli";
import type { Execution, ExecutionResult } from "../../../src/shared/wire";

let printed: string[] = [];
let errored: string[] = [];
let exited: number | null = null;
void exited;

const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;

beforeEach(() => {
  printed = [];
  errored = [];
  exited = null;
  console.log = ((line: unknown) => printed.push(String(line))) as never;
  console.error = ((line: unknown) => errored.push(String(line))) as never;
  process.exit = ((code?: number) => {
    exited = code ?? 0;
    throw new Error(`exit:${code}`);
  }) as never;
  process.env.ZECK_TOKEN = "zeck-token-test";
  process.env.ZECK_API_URL = "https://api.zeck.example";
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;
});

import { afterEach, beforeEach } from "vitest";

/** Route the CLI's SDK fetch to a scripted transport. */
function withTransport(
  handler: (url: string, init?: RequestInit) => { status: number; body: unknown },
): () => { readonly calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const target = String(url);
    calls.push({ url: target, init });
    const outcome = handler(target, init);
    return new Response(JSON.stringify(outcome.body), { status: outcome.status });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
    return { calls };
  };
}

const EXECUTION: Execution = {
  id: "00000000-0000-7000-8000-0000000000d1",
  applicationId: "00000000-0000-7000-8000-0000000000a1",
  environmentId: null,
  status: "COMPLETED",
  task: { kind: "summarize", input: "doc" },
  constraints: null,
  metadata: {},
  createdAt: "2026-09-15T12:00:00Z",
  updatedAt: "2026-09-15T12:01:00Z",
  terminalAt: "2026-09-15T12:01:00Z",
};

const RESULT: ExecutionResult = {
  executionId: EXECUTION.id,
  status: "COMPLETED",
  route: { provider: "rail-a", model: "model-x", strategyClass: "hybrid", modelCalls: 1 },
  cost: { totalMicroUsd: "1250", currency: "usd" },
  usage: { inputTokens: 100, outputTokens: 20 },
  outputArtifacts: [],
  verification: [],
  warnings: [],
  terminalAt: EXECUTION.terminalAt,
};

describe("zeck CLI (execution-centric primitives)", () => {
  test("submit sends the execution request and prints the receipt", async () => {
    const restore = withTransport(() => ({
      status: 201,
      body: {
        executionId: EXECUTION.id,
        applicationId: EXECUTION.applicationId,
        status: "CREATED",
        createdAt: "2026-09-15T12:00:00Z",
        replayed: false,
        lastEventSequence: 1,
      },
    }));
    try {
      const code = await runCli([
        "submit",
        "00000000-0000-7000-8000-0000000000a1",
        '{"kind":"summarize","input":"doc"}',
        "--key",
        "cli-key-1",
      ]);
      expect(code).toBe(0);
      expect(printed.join("\n")).toContain(EXECUTION.id);
      expect(printed.join("\n")).toContain("CREATED");
    } finally {
      restore();
    }
  });

  test("inspect prints the execution status without secrets", async () => {
    const restore = withTransport(() => ({ status: 200, body: EXECUTION }));
    try {
      const code = await runCli(["inspect", "app-1", EXECUTION.id]);
      expect(code).toBe(0);
      const out = printed.join("\n");
      expect(out).toContain("COMPLETED");
      expect(out).not.toMatch(/secret|token|credential|apiKey/i);
    } finally {
      restore();
    }
  });

  test("result prints route, cost and warnings", async () => {
    const restore = withTransport(() => ({ status: 200, body: RESULT }));
    try {
      const code = await runCli(["result", "app-1", EXECUTION.id]);
      expect(code).toBe(0);
      const out = printed.join("\n");
      expect(out).toContain("rail-a/model-x");
      expect(out).toContain("1250 micro-USD");
    } finally {
      restore();
    }
  });

  test("cost reports unsettled facts honestly", async () => {
    const restore = withTransport(() => ({
      status: 200,
      body: { ...RESULT, cost: null },
    }));
    try {
      const code = await runCli(["cost", "app-1", EXECUTION.id]);
      expect(code).toBe(0);
      expect(printed.join("\n")).toContain("no settled cost facts");
    } finally {
      restore();
    }
  });

  test("verify prints the verification evidence", async () => {
    const restore = withTransport(() => ({
      status: 200,
      body: [
        {
          id: "ver-1",
          executionId: EXECUTION.id,
          criterionId: "cites-sources",
          strategy: "rubric",
          status: "PASS",
          confidence: null,
          evaluator: { kind: "recorded-by", id: "verifier-1", version: "1" },
          evidenceRefs: ["ev-1"],
          recordedAt: "2026-09-15T12:00:30Z",
        },
      ],
    }));
    try {
      const code = await runCli(["verify", "app-1", EXECUTION.id]);
      expect(code).toBe(0);
      expect(printed.join("\n")).toContain("cites-sources");
      expect(printed.join("\n")).toContain("PASS");
    } finally {
      restore();
    }
  });

  test("cancel drives the governed command and prints the outcome", async () => {
    const restore = withTransport(() => ({
      status: 200,
      body: {
        executionId: EXECUTION.id,
        applicationId: EXECUTION.applicationId,
        status: "CANCELLED",
        createdAt: EXECUTION.createdAt,
        replayed: false,
        lastEventSequence: 5,
      },
    }));
    try {
      const code = await runCli(["cancel", "app-1", EXECUTION.id]);
      expect(code).toBe(0);
      expect(printed.join("\n")).toContain("CANCELLED");
    } finally {
      restore();
    }
  });

  test("agents prints the governed inventory", async () => {
    const restore = withTransport(() => ({
      status: 200,
      body: [
        {
          id: "00000000-0000-7000-a000-000000000001",
          slug: "support-bot",
          name: "Support Bot",
          description: null,
          status: "active",
          activeVersionId: "v1",
          activeVersion: "1.0.0",
          createdAt: "2026-09-15T12:00:00Z",
          updatedAt: "2026-09-15T12:00:00Z",
        },
      ],
    }));
    try {
      const code = await runCli(["agents", "app-1"]);
      expect(code).toBe(0);
      expect(printed.join("\n")).toContain("support-bot");
    } finally {
      restore();
    }
  });

  test("WORK-034: every scoped command sends the application argument as the X-Zeck-Application scope", async () => {
    const restore = withTransport((url) => {
      if (url.endsWith("/events") || url.endsWith("/verification") || url.endsWith("/agents")) {
        return { status: 200, body: [] };
      }
      if (url.endsWith("/cancel")) {
        return {
          status: 200,
          body: {
            executionId: EXECUTION.id,
            applicationId: EXECUTION.applicationId,
            status: "CANCELLED",
            createdAt: EXECUTION.createdAt,
            replayed: false,
            lastEventSequence: 5,
          },
        };
      }
      if (url.endsWith("/status")) {
        return {
          status: 200,
          body: {
            agent: {
              id: "00000000-0000-7000-a000-000000000001",
              slug: "support-bot",
              status: "active",
            },
            latestSelection: null,
            availableVersions: [],
          },
        };
      }
      if (url.endsWith("/results")) {
        return { status: 200, body: RESULT };
      }
      return { status: 200, body: EXECUTION };
    });
    try {
      for (const argv of [
        ["inspect", "app-1", EXECUTION.id],
        ["result", "app-1", EXECUTION.id],
        ["events", "app-1", EXECUTION.id],
        ["cost", "app-1", EXECUTION.id],
        ["verify", "app-1", EXECUTION.id],
        ["cancel", "app-1", EXECUTION.id],
        ["agents", "app-1"],
        ["agent", "app-1", "00000000-0000-7000-a000-000000000001"],
      ]) {
        const code = await runCli(argv);
        expect(code, `zeck ${argv[0]}`).toBe(0);
      }
    } finally {
      restore();
    }
    const { calls } = restore();
    expect(calls).toHaveLength(8);
    for (const call of calls) {
      const headers = call.init?.headers as Record<string, string>;
      expect(headers["x-zeck-application"]).toBe("app-1");
    }
  });

  test("WORK-034: submit keeps its scope in the request body (no application header on creation)", async () => {
    const restore = withTransport(() => ({
      status: 201,
      body: {
        executionId: EXECUTION.id,
        applicationId: EXECUTION.applicationId,
        status: "CREATED",
        createdAt: EXECUTION.createdAt,
        replayed: false,
        lastEventSequence: 1,
      },
    }));
    try {
      const code = await runCli(["submit", "app-1", '{"kind":"summarize","input":"doc"}']);
      expect(code).toBe(0);
    } finally {
      restore();
    }
    const { calls } = restore();
    expect(calls).toHaveLength(1);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["x-zeck-application"]).toBeUndefined();
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      applicationId: "app-1",
      task: { kind: "summarize", input: "doc" },
    });
  });

  test("M6: an API error prints the public code only (never secret material)", async () => {
    const restore = withTransport(() => ({
      status: 403,
      body: {
        code: "AUTHORIZATION_DENIED",
        message: "actor holds no membership for this application",
        retryable: false,
      },
    }));
    try {
      const code = await runCli(["inspect", "app-1", EXECUTION.id]);
      expect(code).toBe(1);
      const out = errored.join("\n");
      expect(out).toContain("AUTHORIZATION_DENIED");
      expect(out).not.toMatch(/zeck-token-test/);
    } finally {
      restore();
    }
  });

  test("M6: a missing ZECK_TOKEN fails closed without printing anything sensitive", async () => {
    delete process.env.ZECK_TOKEN;
    const restore = withTransport(() => ({ status: 200, body: EXECUTION }));
    try {
      await runCli(["inspect", "app-1", EXECUTION.id]);
      expect(errored.join("\n")).toContain("ZECK_TOKEN is not set");
    } finally {
      restore();
      process.env.ZECK_TOKEN = "zeck-token-test";
    }
  });

  test("M17/M18: there is no provider/model/rail command", async () => {
    for (const command of ["call-model", "invoke-provider", "rail", "connection"]) {
      const code = await runCli([command, "x"]);
      expect(code).toBe(2);
      // Unknown commands print usage — which documents ONLY the
      // execution/agent vocabulary.
      expect(errored.join("\n")).not.toMatch(new RegExp(`zeck ${command}`, "i"));
    }
  });

  test("the usage text documents the env contract (no flags for credentials)", async () => {
    const code = await runCli(["help"]);
    expect(code).toBe(0);
    const out = printed.join("\n");
    expect(out).toContain("ZECK_TOKEN");
    expect(out).toContain("ZECK_API_URL");
    expect(out).toContain("NEVER a provider API key");
    // No credential flag exists.
    expect(out).not.toContain("--token");
    expect(out).not.toContain("--api-key");
  });
});
