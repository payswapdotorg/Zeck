/**
 * PPR-018 harness unit tests: the in-memory ports, the egress proxy,
 * the corpus data integrity, the scrubbed environment, and the rail
 * worker's task parsing.
 */

import { connect as netConnect } from "node:net";
import { describe, expect, test } from "vitest";
import { createMemoryConnectionCatalog, createMemoryDispatchJournal } from "../harness/memory-ports";
import { createEgressProxy } from "../harness/egress-proxy";
import { parseCodingCompletionTask } from "../harness/rail-worker";
import { CODING_CORPUS } from "../corpus/tasks";
import { scrubbedAiderEnv, PROVIDER_CREDENTIAL_ENV_NAMES } from "../harness/corpus-runner";

describe("the in-memory connection catalog + vault", () => {
  const connection = {
    connectionId: "conn-1",
    tenantId: "tenant-1",
    applicationId: "app-1",
    material: JSON.stringify({ authorization: "Bearer x" }),
  };
  const catalog = createMemoryConnectionCatalog(connection);

  test("dispatch facts are tenant-guarded", async () => {
    const facts = await catalog.getConnectionForDispatch(
      { tenantId: "tenant-1", applicationId: "app-1" },
      "conn-1",
    );
    expect(facts.rail).toBe("custom");
    expect(facts.credentialKind).toBe("byok");
    await expect(
      catalog.getConnectionForDispatch({ tenantId: "other", applicationId: "app-1" }, "conn-1"),
    ).rejects.toThrow(/different application or tenant/);
    await expect(
      catalog.getConnectionForDispatch({ tenantId: "tenant-1", applicationId: "app-1" }, "nope"),
    ).rejects.toThrow(/not found/);
  });

  test("materialization returns the stored material only for the right reference", async () => {
    const materialized = await catalog.materialize("ppr-018-supply-conn-1", {
      attemptId: "a",
      connectionId: "conn-1",
    });
    expect(materialized.plaintext).toBe(connection.material);
    await expect(
      catalog.materialize("wrong-ref", { attemptId: "a", connectionId: "conn-1" }),
    ).rejects.toThrow(/unknown credential reference/);
  });
});

describe("the in-memory dispatch journal", () => {
  test("records intent, outcome, and denial in order", async () => {
    const journal = createMemoryDispatchJournal();
    await journal.recordIntent({
      id: "att-1",
      tenantId: "t",
      applicationId: "a",
      connectionId: "c",
      rail: "custom",
      model: "glm-4-plus",
      requestHash: "h",
    });
    await journal.recordOutcome("att-1", "succeeded", {
      kind: "provider-success",
      response: {
        content: ["x"],
        stopReason: "stop",
        structuredOutput: null,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: null },
        providerLatencyMs: 5,
      },
    });
    await journal.recordDenial(
      {
        id: "att-2",
        tenantId: "t",
        applicationId: "a",
        connectionId: "c",
        rail: "custom",
        model: "glm-4-plus",
        requestHash: "h",
      },
      "policy denied",
    );
    expect(journal.attempts).toHaveLength(2);
    const first = await journal.findAttempt("att-1");
    expect(first?.status).toBe("succeeded");
    const second = await journal.findAttempt("att-2");
    expect(second?.admitted).toBe(false);
  });
});

describe("the egress-deny proxy", () => {
  test("denies a CONNECT tunnel and records the violation", async () => {
    const proxy = await createEgressProxy();
    // The Python runtime's https path: a raw CONNECT through the proxy.
    const result = await connectThroughProxy(proxy.port, "api.openai.com:443");
    expect(result.status).toBe(403);
    expect(result.body).toContain("egress denied");
    const violations = proxy.violations();
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[violations.length - 1]?.host).toBe("api.openai.com");
    expect(violations[violations.length - 1]?.blocked).toBe(true);
    expect(proxy.observation().mode).toBe("deny");
    expect(proxy.observation().status).toBe("provably-blocked");
    proxy.close();
  });

  test("denies an absolute-URI plain HTTP request", async () => {
    const proxy = await createEgressProxy();
    const result = await absoluteUriThroughProxy(proxy.port, "http://aider.chat/docs/");
    expect(result.status).toBe(403);
    const violations = proxy.violations();
    expect(violations[violations.length - 1]?.host).toBe("aider.chat");
    proxy.close();
  });

  test("an idle proxy derives observed-clean", async () => {
    const proxy = await createEgressProxy();
    expect(proxy.observation()).toEqual({
      mode: "deny",
      status: "observed-clean",
      violations: [],
    });
    proxy.close();
  });
});

/** Raw CONNECT through the proxy (the Python runtime's https path). */
async function connectThroughProxy(
  port: number,
  target: string,
): Promise<{ status: number; body: string }> {
  const connection = netConnect({ host: "127.0.0.1", port });
  connection.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  const text = await new Promise<string>((resolve) => {
    let buffer = "";
    const timer = setTimeout(() => resolve(buffer), 2_000);
    void (async () => {
      for await (const chunk of connection) {
        buffer += new TextDecoder().decode(chunk as Uint8Array);
        if (buffer.includes("\r\n\r\n")) {
          clearTimeout(timer);
          resolve(buffer);
          break;
        }
      }
    })();
  });
  connection.end();
  const status = Number.parseInt(text.split(" ")[1] ?? "0", 10);
  return { status, body: text };
}

/** Absolute-URI plain HTTP request through the proxy. */
async function absoluteUriThroughProxy(
  port: number,
  url: string,
): Promise<{ status: number; body: string }> {
  const connection = netConnect({ host: "127.0.0.1", port });
  connection.write(`GET ${url} HTTP/1.1\r\nHost: ${new URL(url).host}\r\n\r\n`);
  const text = await new Promise<string>((resolve) => {
    let buffer = "";
    const timer = setTimeout(() => resolve(buffer), 2_000);
    void (async () => {
      for await (const chunk of connection) {
        buffer += new TextDecoder().decode(chunk as Uint8Array);
        if (buffer.includes("\r\n\r\n")) {
          clearTimeout(timer);
          resolve(buffer);
          break;
        }
      }
    })();
  });
  connection.end();
  const status = Number.parseInt(text.split(" ")[1] ?? "0", 10);
  return { status, body: text };
}

describe("the rail worker's task parsing", () => {
  test("accepts a well-formed coding completion task", () => {
    const task = parseCodingCompletionTask({
      kind: "coding-assistant.completion",
      role: "main",
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
      ],
      params: { temperature: 0 },
    });
    expect(task?.role).toBe("main");
    expect(task?.messages).toHaveLength(2);
  });

  test("rejects unknown kinds, empty and malformed messages", () => {
    expect(parseCodingCompletionTask({ kind: "other", messages: [] })).toBeNull();
    expect(
      parseCodingCompletionTask({ kind: "coding-assistant.completion", messages: [] }),
    ).toBeNull();
    expect(
      parseCodingCompletionTask({
        kind: "coding-assistant.completion",
        messages: [{ role: "user", content: 42 }],
      }),
    ).toBeNull();
  });
});

describe("the corpus data integrity", () => {
  test("declares five tasks with checks, files and prompts", () => {
    expect(CODING_CORPUS).toHaveLength(5);
    const ids = CODING_CORPUS.map((task) => task.id);
    expect(new Set(ids).size).toBe(5);
    for (const task of CODING_CORPUS) {
      expect(task.turns.length).toBeGreaterThan(0);
      expect(task.files["check.py"]).toContain("print(");
      expect(Object.keys(task.files).length).toBeGreaterThan(0);
      expect(task.chatFiles.every((file) => file in task.files)).toBe(true);
    }
  });

  test("the multi-turn task exists to drive the summarizer edge", () => {
    const multi = CODING_CORPUS.find((task) => task.id === "multi-turn");
    expect(multi?.turns.length).toBeGreaterThanOrEqual(4);
  });
});

describe("the scrubbed Aider runtime environment", () => {
  test("carries no provider credentials (the placeholder aside)", () => {
    const env = scrubbedAiderEnv({
      adapterUrl: "http://127.0.0.1:1/v1",
      proxyUrl: "http://127.0.0.1:2",
      home: "/tmp/x",
    });
    const present = PROVIDER_CREDENTIAL_ENV_NAMES.filter((name) => name in env);
    expect(present).toEqual(["OPENAI_API_KEY"]);
    expect(env.OPENAI_API_KEY).toBe("zeck-local-adapter");
    expect(env.OPENAI_API_BASE).toBe("http://127.0.0.1:1/v1");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:2");
    expect(env.NO_PROXY).toBe("127.0.0.1,localhost");
  });
});
