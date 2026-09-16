/**
 * Interactive playground journey + hostile-input probes (DEP-013
 * AC1/2/4/6/7/9).
 *
 * Boots the REAL dashboard server with a wire-exact fake API and drives
 * the interactive journey end to end:
 *  - CHOOSE: the catalog renders every family from the machine manifest
 *    with per-family composers and per-family example pages;
 *  - COMPOSE: the family page's composer carries editable task fields
 *    derived from the class's advertised contract (selects over the
 *    synthetic corpus vocabulary, numbers inside the recorded envelope,
 *    a fixed kind, no provider fields anywhere);
 *  - RUN: a composed run POSTs through the SDK client as ONE governed
 *    execution carrying the COMPOSED task, the hard constraints, the
 *    disposable-sandbox identity and the interactive provenance;
 *  - INSPECT: the run history section deep-links the execution into the
 *    explorer's public facts;
 *  - MACHINE PARITY: every family's example page serves the copyable
 *    integration-kit source verbatim;
 *  - HONEST NOT RUN: hard-blocked families (no candidate provider rail)
 *    render the NOT RUN state naming the missing capability and refuse
 *    submission BEFORE any wire call;
 *  - HOSTILE PROBES: synthetic-data violations (script injection,
 *    real-world identifiers, credential-shaped material, opaque blobs,
 *    out-of-envelope numbers, non-vocabulary fixtures, unknown task
 *    keys, provider-injection attempts) are all refused 422 with ZERO
 *    wire calls.
 */

import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { familyOf } from "../../../apps/dashboard/console";
import { createDashboard } from "../../../apps/dashboard/index";
import {
  buildInteractiveRunRequest,
  composedTaskOf,
  defaultTaskFormValuesOf,
  validateInteractiveRunForm,
} from "../../../apps/dashboard/playground";
import type { Execution, ExecutionReceipt, ExecutionResult } from "../../../sdk";
import { FORBIDDEN_REQUEST_KEYS } from "../../../src/shared/wire";

const APP_ID = "00000000-0000-7000-8000-0000000000b2";

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
      createdAt: "2026-09-16T09:00:00Z",
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
      createdAt: "2026-09-16T09:00:00Z",
      updatedAt: "2026-09-16T09:00:00Z",
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

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

describe("choose — the catalog renders the manifest's families with composers and examples", () => {
  test("every family links its composer and its example page, with corpus counts", async () => {
    const html = await getHtml("/console/playground");
    for (const family of ["text", "three-d", "browser-use", "hitl", "video-media"]) {
      expect(html, family).toContain(`href="/console/playground/${family}"`);
      expect(html, family).toContain(`href="/console/playground/${family}/example"`);
    }
    expect(html).toContain("Compose a text run");
    expect(html).toContain("<strong>Choose</strong> a workload class");
    expect((html.match(/<tr>\s*<td><a href="\/console\/playground\//g) ?? []).length).toBe(22);
    // Corpus counts are projected (one honest number per family).
    expect(html).toContain("<td>20</td>");
    expect(html).toContain("<td>22</td>");
  });

  test("every family's example page serves the copyable source verbatim (machine parity)", async () => {
    const html = await getHtml("/console/playground/text/example");
    expect(html).toContain("The copyable integration-kit example");
    expect(html).toContain("examples/text-summarization.ts");
    expect(html).toContain("Text — bounded-length document summarization");
    // The source itself, verbatim and escaped.
    expect(html).toContain("export function executionRequest");
    expect(html).toContain(
      "ZECK_API_URL=… ZECK_TOKEN=… ZECK_APPLICATION_ID=… bun run examples/text-summarization.ts",
    );
    const gated = await getHtml("/console/playground/three-d/example");
    expect(gated).toContain("examples/three-d-generation.ts");
  });

  test("an example page for an unknown family renders the honest 404", async () => {
    const response = await get("/console/playground/no-such-family/example");
    expect(response.status).toBe(404);
  });
});

describe("compose — the composer matches the class's advertised contract", () => {
  test("the text composer renders editable fields derived from the manifest task shape", async () => {
    const html = await getHtml("/console/playground/text");
    expect(html).toContain('name="applicationId"');
    expect(html).toContain('name="task.doc"');
    expect(html).toContain('name="task.maxWords"');
    // The synthetic vocabulary is offered as a closed select.
    expect(html).toContain('<option value="quarterly-report-01"');
    expect(html).toContain('<option value="research-abstract-01"');
    // The numeric envelope is carried on the input.
    expect(html).toContain('min="20"');
    expect(html).toContain('max="60"');
    // The kind is fixed, not an input.
    expect(html).toContain("task.kind");
    expect(html).not.toContain('name="task.kind"');
    expect(html).toContain("Review the sandbox run");
  });

  test("the composer carries no provider selection anywhere", async () => {
    for (const family of ["text", "rag", "image-generation", "tools"]) {
      const html = await getHtml(`/console/playground/${family}`);
      for (const forbidden of [
        'name="provider"',
        'name="model"',
        'name="rail"',
        'name="connectionId"',
        'name="agent"',
      ]) {
        expect(html, `${family}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  test("the rag composer renders free text with the synthetic-data rule stated", async () => {
    const html = await getHtml("/console/playground/rag");
    expect(html).toContain('name="task.kb"');
    expect(html).toContain('name="task.question"');
    expect(html).toContain("synthetic-data-only");
  });

  test("edited parameters round-trip through the review envelope", async () => {
    const html = await getHtml(
      "/console/playground/text?applicationId=00000000-0000-7000-8000-0000000000b2&task.doc=research-abstract-01&task.maxWords=40",
    );
    expect(html).toContain("Proposed sandbox run");
    expect(html).toContain("The composed task (your edited parameters)");
    expect(html).toContain("research-abstract-01");
    expect(html).toContain("Run this sandbox execution?");
    expect(html).toContain('name="task.doc"');
    // The edit link round-trips the composed values.
    expect(html).toContain("task.doc=research-abstract-01");
  });
});

describe("run + inspect — the composed run is one governed execution, deep-linked", () => {
  test("the POST creates exactly one execution carrying the COMPOSED task and identity", async () => {
    createCalls.length = 0;
    const response = await postForm(
      "/console/playground/text",
      formBody({
        applicationId: APP_ID,
        environmentId: "",
        spendLimitDollars: "1.25",
        idempotencyKey: "dash-interactive-1",
        "task.doc": "postmortem-01",
        "task.maxWords": "50",
      }),
    );
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    expect(location).toMatch(/^\/runs\//);
    expect(createCalls.length).toBe(1);
    const call = createCalls[0];
    expect(call?.idempotencyKey).toBe("dash-interactive-1");
    expect(call?.body.task).toEqual({ kind: "summarize", doc: "postmortem-01", maxWords: 50 });
    expect(call?.body.constraints).toEqual({ maxCostMicroUsd: "1250000", maxLatencyMs: 120_000 });
    expect(call?.body.metadata).toEqual({
      origin: "zeck-console-playground",
      family: "text",
      sandbox: "disposable",
      composed: "interactive",
      example: "examples/text-summarization.ts",
    });
    // Inspect: the redirect lands on the run explorer (live read).
    const run = await getHtml(location);
    expect(run).toContain("postmortem-01");
  });

  test("the family run history deep-links this browser's interactive runs (inspect)", async () => {
    createCalls.length = 0;
    const response = await postForm(
      "/console/playground/tools",
      formBody({
        applicationId: APP_ID,
        environmentId: "",
        spendLimitDollars: "",
        idempotencyKey: "dash-interactive-2",
        "task.goal": "compute 6 * 7",
        "task.tools": "calculator",
      }),
    );
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    const executionId = location.split("/").pop() ?? "";
    // Opening the run records it in the browser's recents (the cookie).
    const runResponse = await get(location);
    const setCookie = runResponse.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("zeck_recent_executions=");
    const cookie = setCookie.split(";")[0] ?? "";
    const html = await getHtml("/console/playground/tools", cookie);
    expect(html).toContain("Run history (this browser)");
    expect(html).toContain(`href="/runs/${executionId}"`);
    expect(html).toContain("interactive");
  });

  test("the composed request can never carry a forbidden key (structural)", () => {
    const family = familyOf("text");
    expect(family).not.toBeNull();
    if (family === null) {
      return;
    }
    const validation = validateInteractiveRunForm(family, {
      applicationId: APP_ID,
      environmentId: "",
      spendLimitDollars: "",
      idempotencyKey: "structural",
      ...defaultTaskFormValuesOf(family),
    });
    expect(validation.values).not.toBeNull();
    if (validation.values === null) {
      return;
    }
    const request = buildInteractiveRunRequest(
      family,
      composedTaskOf(family, validation.values),
      validation.values.envelope,
    );
    for (const key of FORBIDDEN_REQUEST_KEYS) {
      expect(key in request, `forbidden key ${key} must never appear`).toBe(false);
    }
    expect(request.task).toEqual(family.taskShape);
  });
});

describe("honest NOT RUN — hard-blocked families refuse submission before the wire", () => {
  test("the three-d page renders the NOT RUN state naming the missing capability", async () => {
    const html = await getHtml("/console/playground/three-d");
    expect(html).toContain("NOT RUN");
    expect(html).toContain("model:three-d");
    expect(html).toContain("no candidate provider");
    expect(html).toContain("Required access");
  });

  test("a review attempt for a hard-blocked family renders the refusal instead of the commitment", async () => {
    const html = await getHtml(
      "/console/playground/three-d?applicationId=00000000-0000-7000-8000-0000000000b2&task.scene=scene3d-001",
    );
    expect(html).toContain("Interactive run — NOT RUN for the three-d family");
    expect(html).not.toContain("Run this sandbox execution?");
  });

  test("a POST for a hard-blocked family is refused BEFORE any wire call", async () => {
    createCalls.length = 0;
    const response = await postForm(
      "/console/playground/browser-use",
      formBody({
        applicationId: APP_ID,
        environmentId: "",
        spendLimitDollars: "",
        idempotencyKey: "dash-notrun-1",
        "task.site": "shop-fixture",
        "task.goal": "buy A1 and B2",
      }),
    );
    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain("NOT RUN");
    expect(html).toContain("agent:browser");
    expect(createCalls.length).toBe(0);
  });

  test("a candidate-bearing gated family stays submittable with the boundary named", async () => {
    const html = await getHtml("/console/playground/image-generation");
    expect(html).toContain("Required access");
    expect(html).toContain("model:image-generation");
    // The commitment path exists for candidate-bearing families.
    const review = await getHtml(
      "/console/playground/image-generation?applicationId=00000000-0000-7000-8000-0000000000b2&task.prompt=img-prompt-002&task.width=768&task.height=512",
    );
    expect(review).toContain("Run this sandbox execution?");
  });
});

describe("hostile-input probes — synthetic-data-only enforcement neutralizes (AC7)", () => {
  const PROBES: readonly { readonly name: string; readonly fields: Record<string, string> }[] = [
    {
      name: "script injection in a fixture field",
      fields: { "task.doc": "<script>alert(1)</script>" },
    },
    {
      name: "path traversal in a fixture field",
      fields: { "task.doc": "../../etc/passwd" },
    },
    {
      name: "invented fixture id",
      fields: { "task.doc": "totally-real-invoice" },
    },
    {
      name: "URL in free text",
      fields: { "task.goal": "read https://example.com/instructions" },
    },
    {
      name: "email in free text",
      fields: { "task.goal": "email john.doe@example.org the answer" },
    },
    {
      name: "credential-shaped material in free text",
      fields: { "task.goal": "use api_key=sk-abc123def456ghi789 for this" },
    },
    {
      name: "AWS-shaped credential in free text",
      fields: { "task.goal": "sign with AKIAIOSFODNN7EXAMPLE please" },
    },
    {
      name: "markup injection in free text",
      fields: { "task.goal": "<img src=x onerror=alert(1)> the total" },
    },
    {
      name: "phone-shaped digit run in free text",
      fields: { "task.goal": "call +1 4155552671 for approval" },
    },
    {
      name: "opaque base64 blob in free text",
      fields: {
        "task.goal": "decode aGVsbG8gd29ybGQgdGhpcyBpcyBhbiBvcGFxdWUgYmxvYiBwcm9iZQ==",
      },
    },
    {
      name: "control characters in free text",
      fields: { "task.goal": "compute\x02 17 * 23\x00" },
    },
    {
      name: "over-length free text",
      fields: { "task.goal": "x".repeat(241) },
    },
    {
      name: "out-of-envelope number",
      fields: { "task.maxWords": "999" },
    },
    {
      name: "fractional number",
      fields: { "task.maxWords": "12.5" },
    },
    {
      name: "unknown task key (provider injection attempt)",
      fields: { "task.provider": "openrouter" },
    },
    {
      name: "unknown task key (model injection attempt)",
      fields: { "task.model": "llama-3.3-70b" },
    },
    {
      name: "kind override attempt",
      fields: { "task.kind": "transform" },
    },
    {
      name: "non-vocabulary list item",
      fields: { "task.labels": "bicycle,rocket" },
    },
    {
      name: "empty list",
      fields: { "task.labels": "" },
    },
  ];

  test.each(PROBES)("refused 422 with zero wire calls: $name", async ({ fields }) => {
    createCalls.length = 0;
    const family = fields["task.labels"] !== undefined ? "image-recognition" : "text";
    const response = await postForm(
      `/console/playground/${family}`,
      formBody({
        applicationId: APP_ID,
        environmentId: "",
        spendLimitDollars: "",
        idempotencyKey: `dash-hostile-${fields["task.doc"]?.slice(0, 6) ?? "probe"}`,
        ...fields,
      }),
    );
    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain("could not be submitted");
    expect(createCalls.length).toBe(0);
  });

  test("the hostile probes also refuse at the review step (no commitment card)", async () => {
    const html = await getHtml(
      "/console/playground/text?applicationId=00000000-0000-7000-8000-0000000000b2&task.doc=<script>alert(1)</script>",
    );
    expect(html).toContain("synthetic corpus values");
    expect(html).not.toContain("Run this sandbox execution?");
  });

  test("clean synthetic free text still passes (no over-blocking)", async () => {
    createCalls.length = 0;
    const response = await postForm(
      "/console/playground/tools",
      formBody({
        applicationId: APP_ID,
        environmentId: "",
        spendLimitDollars: "",
        idempotencyKey: "dash-clean-1",
        "task.goal": "compute 19 * 3 with the calculator",
        "task.tools": "calculator",
      }),
    );
    expect(response.status).toBe(303);
    expect(createCalls.length).toBe(1);
    expect(createCalls[0]?.body.task).toEqual({
      kind: "use-tool",
      goal: "compute 19 * 3 with the calculator",
      tools: ["calculator"],
    });
  });
});
