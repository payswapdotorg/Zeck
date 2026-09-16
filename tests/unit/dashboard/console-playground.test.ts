/**
 * Developer console playground tests (DEP-010 — the sandbox playground
 * over the public API).
 *
 * Boots the REAL dashboard server with a wire-exact fake API and drives
 * the guided sandbox-run journey end to end:
 *  - the catalog projects every workload family with its honest
 *    classification;
 *  - the family page states availability, shows the synthetic task and
 *    the run form (no provider selection anywhere);
 *  - the two-step run (review → governed POST) creates exactly ONE
 *    execution through the SDK client with the hard constraints and the
 *    disposable-sandbox identity;
 *  - THE NEGATIVE PROOFS (the limits bite): an over-ceiling spend is
 *    refused BEFORE any wire call; the concurrency gate refuses a fourth
 *    in-flight run; an unknown family renders the honest 404.
 */

import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  PLAYGROUND_BUDGET_LIMIT_MICRO_USD,
  PLAYGROUND_LATENCY_LIMIT_MS,
  PLAYGROUND_ORIGIN,
} from "../../../apps/dashboard/console";
import { createDashboard } from "../../../apps/dashboard/index";
import type { Execution, ExecutionReceipt, ExecutionResult } from "../../../sdk";

const APP_ID = "00000000-0000-7000-8000-0000000000a1";
const TEXT_TASK = { kind: "summarize", doc: "quarterly-report-01", maxWords: 60 };

const executions = new Map<string, Execution>();
const createCalls: { body: Record<string, unknown>; idempotencyKey: string }[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function resultOf(execution: Execution): ExecutionResult {
  return {
    executionId: execution.id,
    status: execution.status,
    route: null,
    cost: null,
    usage: null,
    outputArtifacts: [],
    verification: [],
    warnings: [],
    terminalAt: execution.terminalAt,
  };
}

const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
  const path = new URL(String(input)).pathname;
  const method = init?.method ?? "GET";
  if (path === "/executions" && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    createCalls.push({ body, idempotencyKey: headers["idempotency-key"] ?? "" });
    const executionId = `00000000-0000-7000-8000-${String(createCalls.length).padStart(12, "0")}`;
    const receipt: ExecutionReceipt = {
      executionId,
      applicationId: String(body.applicationId ?? APP_ID),
      status: "CREATED",
      createdAt: "2026-09-15T12:00:00Z",
      replayed: false,
      lastEventSequence: 1,
    };
    executions.set(executionId, {
      id: executionId,
      applicationId: receipt.applicationId,
      environmentId: typeof body.environmentId === "string" ? (body.environmentId as string) : null,
      status: "CREATED",
      task: (body.task ?? {}) as Record<string, unknown>,
      constraints: (body.constraints ?? null) as Record<string, unknown> | null,
      metadata: (body.metadata ?? {}) as Record<string, unknown>,
      createdAt: "2026-09-15T12:00:00Z",
      updatedAt: "2026-09-15T12:00:00Z",
      terminalAt: null,
    });
    return json(receipt, 201);
  }
  const match = /^\/executions\/([^/]+)$/.exec(path);
  if (match !== null) {
    const execution = executions.get(match[1] ?? "");
    if (execution === undefined) {
      return json({ code: "PROVIDER_ERROR", message: "not found", retryable: false }, 404);
    }
    return json(execution);
  }
  const submatch = /^\/executions\/([^/]+)\/(results|events|verification)$/.exec(path);
  if (submatch !== null) {
    const execution = executions.get(submatch[1] ?? "");
    if (execution === undefined) {
      return json({ code: "PROVIDER_ERROR", message: "not found", retryable: false }, 404);
    }
    if (submatch[2] === "results") {
      return json(resultOf(execution));
    }
    if (submatch[2] === "events") {
      return json([]);
    }
    return json([]);
  }
  if (path === "/agents") {
    return json([]);
  }
  return json({ code: "PROVIDER_ERROR", message: `unexpected path ${path}`, retryable: true }, 500);
}) as unknown as typeof fetch;

let base = "";

beforeAll(async () => {
  const { server } = createDashboard({
    apiUrl: "http://fake.local",
    token: "token",
    applicationId: APP_ID,
    port: 0,
    fetchImpl,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
});

async function get(path: string, cookie?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    redirect: "manual",
    ...(cookie === undefined ? {} : { headers: { cookie } }),
  });
}

async function getHtml(path: string, cookie?: string): Promise<string> {
  const response = await get(path, cookie);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  return response.text();
}

async function postForm(path: string, body: string, cookie?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie === undefined ? {} : { cookie }),
    },
    redirect: "manual",
  });
}

function seedRunning(id: string): void {
  executions.set(id, {
    id,
    applicationId: APP_ID,
    environmentId: null,
    status: "RUNNING",
    task: TEXT_TASK,
    constraints: null,
    metadata: {},
    createdAt: "2026-09-15T12:00:00Z",
    updatedAt: "2026-09-15T12:00:00Z",
    terminalAt: null,
  });
}

describe("the playground catalog (every workload family, honest availability)", () => {
  test("the catalog lists all 22 families with classifications and examples", async () => {
    const html = await getHtml("/console/playground");
    for (const family of [
      "text",
      "structured",
      "rag",
      "tools",
      "workflow",
      "long-running",
      "voice",
      "realtime-voice",
      "image-generation",
      "video-media",
      "image-recognition",
      "vlm",
      "audio-understanding",
      "multimodal",
      "three-d",
      "browser-use",
      "computer-use",
      "hitl",
    ]) {
      expect(html, family).toContain(`href="/console/playground/${family}"`);
    }
    expect((html.match(/<tr>\s*<td><a href="\/console\/playground\//g) ?? []).length).toBe(22);
    expect(html).toContain("▶ runnable");
    expect(html).toContain("⊘ provider-gated");
    expect(html).toContain("11 families classify runnable");
    expect(html).toContain("11 classify provider-gated");
    expect(html).toContain("Sandbox envelope");
  });

  test("a runnable family page shows availability, the synthetic task and the run form", async () => {
    const html = await getHtml("/console/playground/text");
    expect(html).toContain("Availability");
    expect(html).toContain("quarterly-report-01");
    expect(html).toContain('name="applicationId"');
    expect(html).toContain('value="00000000-0000-7000-8000-0000000000a1"');
    expect(html).toContain("Review the sandbox run");
  });

  test("a provider-gated family page states the recorded boundary honestly", async () => {
    const html = await getHtml("/console/playground/three-d");
    expect(html).toContain("⊘ provider-gated");
    expect(html).toContain("NOT RUN");
    expect(html).toContain("examples/three-d-generation.ts");
  });

  test("the family page carries no provider selection anywhere", async () => {
    const html = await getHtml("/console/playground/text");
    for (const forbidden of [
      'name="provider"',
      'name="model"',
      'name="rail"',
      'name="connectionId"',
      'name="agent"',
    ]) {
      expect(html, forbidden).not.toContain(forbidden);
    }
  });

  test("an unknown family renders the honest 404 (the console invents nothing)", async () => {
    const response = await get("/console/playground/no-such-family");
    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain("No such workload family");
    expect(html).toContain("capability manifest");
    expect((html.match(/<h1[^>]*>/g) ?? []).length).toBe(1);
  });
});

describe("the guided sandbox run (two-step, governed POST)", () => {
  test("the review step shows the exact envelope and the commitment card", async () => {
    const html = await getHtml(
      "/console/playground/text?applicationId=00000000-0000-7000-8000-0000000000a1&spendLimitDollars=1.50",
    );
    expect(html).toContain("Proposed sandbox run");
    expect(html).toContain("$1.50");
    expect(html).toContain("120 seconds");
    expect(html).toContain(PLAYGROUND_ORIGIN);
    expect(html).toContain("Run this sandbox execution?");
    expect(html).toContain('action="/console/playground/text"');
    expect(html).toContain('name="idempotencyKey"');
  });

  test("the POST creates exactly one execution with the hard constraints and sandbox identity", async () => {
    createCalls.length = 0;
    const response = await postForm(
      "/console/playground/text",
      new URLSearchParams({
        applicationId: APP_ID,
        environmentId: "",
        spendLimitDollars: "1.50",
        idempotencyKey: "dash-playground-1",
      }).toString(),
    );
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    expect(location).toMatch(/^\/runs\//);
    expect(createCalls.length).toBe(1);
    const call = createCalls[0];
    expect(call?.idempotencyKey).toBe("dash-playground-1");
    expect(call?.body.task).toEqual(TEXT_TASK);
    expect(call?.body.constraints).toEqual({
      maxCostMicroUsd: "1500000",
      maxLatencyMs: PLAYGROUND_LATENCY_LIMIT_MS,
    });
    expect(call?.body.metadata).toEqual({
      origin: PLAYGROUND_ORIGIN,
      family: "text",
      sandbox: "disposable",
      composed: "interactive",
      example: "examples/text-summarization.ts",
    });
    expect(call?.body.applicationId).toBe(APP_ID);
    // The redirect lands on the run explorer (live read of the same world).
    const run = await getHtml(location);
    expect(run).toContain("quarterly-report-01");
  });

  test("an environment id rides the request when provided", async () => {
    createCalls.length = 0;
    const response = await postForm(
      "/console/playground/structured",
      new URLSearchParams({
        applicationId: APP_ID,
        environmentId: "env-sandbox-42",
        spendLimitDollars: "",
        idempotencyKey: "dash-playground-2",
      }).toString(),
    );
    expect(response.status).toBe(303);
    expect(createCalls[0]?.body.environmentId).toBe("env-sandbox-42");
    expect(createCalls[0]?.body.constraints).toEqual({
      maxCostMicroUsd: PLAYGROUND_BUDGET_LIMIT_MICRO_USD,
      maxLatencyMs: PLAYGROUND_LATENCY_LIMIT_MS,
    });
  });
});

describe("the negative proofs — the sandbox limits bite", () => {
  test("an over-ceiling spend is refused at the review step (no commitment card)", async () => {
    const html = await getHtml(
      "/console/playground/text?applicationId=00000000-0000-7000-8000-0000000000a1&spendLimitDollars=5",
    );
    expect(html).toContain("capped at $2.00");
    expect(html).not.toContain("Run this sandbox execution?");
  });

  test("an over-ceiling spend POST is refused BEFORE any wire call", async () => {
    createCalls.length = 0;
    const response = await postForm(
      "/console/playground/text",
      new URLSearchParams({
        applicationId: APP_ID,
        environmentId: "",
        spendLimitDollars: "2.01",
        idempotencyKey: "dash-playground-over",
      }).toString(),
    );
    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain("could not be submitted");
    expect(html).toContain("capped at $2.00");
    expect(createCalls.length).toBe(0);
  });

  test("the concurrency gate refuses a fourth in-flight run (derived live, no server state)", async () => {
    seedRunning("gate-run-0000000000000000000000001");
    seedRunning("gate-run-0000000000000000000000002");
    seedRunning("gate-run-0000000000000000000000003");
    const cookie = `zeck_recent_executions=${[
      "gate-run-0000000000000000000000001",
      "gate-run-0000000000000000000000002",
      "gate-run-0000000000000000000000003",
    ].join(",")}`;
    createCalls.length = 0;
    const response = await postForm(
      "/console/playground/text",
      new URLSearchParams({
        applicationId: APP_ID,
        environmentId: "",
        spendLimitDollars: "",
        idempotencyKey: "dash-playground-gate",
      }).toString(),
      cookie,
    );
    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain("Sandbox concurrency limit reached");
    expect(html).toContain("Active runs");
    expect(createCalls.length).toBe(0);
    // The GET family page renders the same gate instead of the form.
    const gated = await getHtml("/console/playground/text", cookie);
    expect(gated).toContain("Sandbox concurrency limit reached");
    expect(gated).not.toContain('name="spendLimitDollars"');
    // Once a run terminates, the gate opens again (derived live).
    const running = executions.get("gate-run-0000000000000000000000001");
    if (running !== undefined) {
      executions.set(running.id, {
        ...running,
        status: "COMPLETED",
        terminalAt: "2026-09-15T12:01:00Z",
      });
    }
    const reopened = await getHtml("/console/playground/text", cookie);
    expect(reopened).toContain('name="spendLimitDollars"');
  });

  test("a POST for an unknown family never reaches the wire", async () => {
    createCalls.length = 0;
    const response = await postForm(
      "/console/playground/no-such-family",
      new URLSearchParams({
        applicationId: APP_ID,
        environmentId: "",
        spendLimitDollars: "",
        idempotencyKey: "dash-playground-404",
      }).toString(),
    );
    expect(response.status).toBe(404);
    expect(createCalls.length).toBe(0);
  });

  test("a missing idempotency key is refused (form state lost)", async () => {
    createCalls.length = 0;
    const response = await postForm(
      "/console/playground/text",
      new URLSearchParams({
        applicationId: APP_ID,
        environmentId: "",
        spendLimitDollars: "",
      }).toString(),
    );
    expect(response.status).toBe(422);
    expect(createCalls.length).toBe(0);
  });
});
