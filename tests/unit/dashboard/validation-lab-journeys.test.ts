/**
 * Validation Lab journey tests (DEP-025 — the browser/API flow over the
 * REAL dashboard server).
 *
 * Boots the REAL dashboard with a wire-exact fake API and drives the
 * validation-library journey end to end:
 *  - the catalog and every IA section render (all experiments, by
 *    capability, by workload, by stage, starting points, agent guide);
 *  - an experiment page states what it proves, links its immutable
 *    evidence and offers the governed rerun form (no provider selection
 *    anywhere);
 *  - the two-step rerun (review → governed POST) creates exactly ONE
 *    execution with the hard constraints, the disposable-sandbox
 *    identity and the lineage metadata (AC4); distinct modes produce
 *    distinct lineage records;
 *  - THE NEGATIVE PROOFS (the limits bite): an over-ceiling spend is
 *    refused BEFORE any wire call; the concurrency gate refuses a
 *    fourth in-flight run; a hard provider gap (3D) is NOT RUN —
 *    refused before the wire, never a pass (AC6); a suite-reproduction
 *    experiment is refused honestly; unknown ids render honest 404s;
 *  - the agent/machine interface: catalog.json, schema.json, the
 *    definition, the run record (live reads), the evidence document and
 *    the reproducibility bundle all serve the SAME projection (AC3);
 *  - secret safety: credential NAMES may cross, credential VALUES never
 *    (AC9) — a hostile env value set on a candidate name never appears
 *    in any response.
 */

import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDashboard } from "../../../apps/dashboard/index";
import type { Execution, ExecutionReceipt, ExecutionResult } from "../../../sdk";

const APP_ID = "00000000-0000-7000-8000-0000000000a1";
const TEXT_TASK = { kind: "summarize", doc: "quarterly-report-01", maxWords: 60 };

// A hostile credential VALUE planted on a candidate name — it must NEVER
// cross into any response (secret-flow proof, AC9).
const HOSTILE_ENV: Record<string, string | undefined> = {
  OPENROUTER_API_KEY: "sk-hostile-value-never-render",
};

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
    cost: { totalMicroUsd: "86", currency: "usd" },
    usage: { inputTokens: 384, outputTokens: 20 },
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
      status: "COMPLETED",
      task: (body.task ?? {}) as Record<string, unknown>,
      constraints: (body.constraints ?? null) as Record<string, unknown> | null,
      metadata: (body.metadata ?? {}) as Record<string, unknown>,
      createdAt: "2026-09-15T12:00:00Z",
      updatedAt: "2026-09-15T12:01:00Z",
      terminalAt: "2026-09-15T12:01:00Z",
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
      return json([
        {
          eventId: "ev-1",
          executionId: execution.id,
          type: "execution.completed",
          sequence: 1,
          occurredAt: "2026-09-15T12:01:00Z",
          payload: {},
        },
      ]);
    }
    return json([
      {
        id: "v-1",
        executionId: execution.id,
        criterionId: "c-1",
        strategy: "contains",
        status: "PASS",
        confidence: 1,
        evaluator: { kind: "mechanical", id: "contains", version: "1" },
        evidenceRefs: [],
        recordedAt: "2026-09-15T12:01:00Z",
      },
    ]);
  }
  if (path === "/agents") {
    return json([]);
  }
  return json({ code: "PROVIDER_ERROR", message: `unexpected path ${path}`, retryable: true }, 500);
}) as unknown as typeof fetch;

let base = "";

beforeAll(async () => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = HOSTILE_ENV.OPENROUTER_API_KEY;
  const { server } = createDashboard({
    apiUrl: "http://fake.local",
    token: "token",
    applicationId: APP_ID,
    port: 0,
    fetchImpl,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  afterAll(() => {
    if (previousKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = previousKey;
    }
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
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

function seedExecution(
  id: string,
  status: Execution["status"],
  metadata: Record<string, unknown>,
): void {
  executions.set(id, {
    id,
    applicationId: APP_ID,
    environmentId: null,
    status,
    task: TEXT_TASK,
    constraints: null,
    metadata,
    createdAt: "2026-09-15T12:00:00Z",
    updatedAt: "2026-09-15T12:00:00Z",
    terminalAt: status === "COMPLETED" ? "2026-09-15T12:01:00Z" : null,
  });
}

const RECENTS_COOKIE = "zeck_recent_executions";

describe("the Validation Lab catalog and IA sections (AC1)", () => {
  test("the lab home lists every experiment with honest rerun chips", async () => {
    const html = await getHtml("/console/validation");
    for (const id of [
      "VAL-001",
      "VAL-009",
      "VAL-010",
      "VAL-019",
      "VAL-025",
      "VAL-040",
      "VAL-052",
    ]) {
      expect(html, id).toContain(`href="/console/validation/${id}"`);
    }
    expect(html).toContain("VAL-027");
    expect(html).toContain("never dispatched");
    expect(html).toContain("▶ rerunnable");
    expect(html).toContain("⊘ suite reproduction");
    expect(html).toContain("NOT RUN boundaries");
    expect(html).toContain("catalog.json");
  });

  test("every IA section renders with its tab nav", async () => {
    for (const [path, marker] of [
      ["/console/validation/capability", "model:text"],
      ["/console/validation/workload", "Workload family"],
      ["/console/validation/stage", "Validation laboratory foundations"],
      ["/console/validation/start", "recommended"],
      ["/console/validation/agent", "agent journey"],
    ] as const) {
      const html = await getHtml(path);
      expect(html, path).toContain("Validation Lab views");
      expect(html, path).toContain(marker);
      expect(html, path).toContain('aria-current="page"');
    }
  });

  test("the nav carries the Validation Lab entry (Develop group)", async () => {
    const html = await getHtml("/home");
    expect(html).toContain('href="/console/validation"');
    expect(html).toContain("Validation Lab");
  });

  test("an unknown experiment renders the honest 404", async () => {
    const response = await get("/console/validation/VAL-999");
    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain("No such validation experiment");
    expect(html).toContain("invents nothing");
  });
});

describe("the experiment detail surface (AC2)", () => {
  test("a rerunnable experiment states what it proves, its evidence and the run form", async () => {
    const html = await getHtml("/console/validation/VAL-010");
    expect(html).toContain("What it proves");
    expect(html).toContain("Deliver the first customer-style application portfolio slice");
    expect(html).toContain('href="/console/validation/evidence/VAL-010"');
    expect(html).toContain("Definition revision");
    expect(html).toContain("35b0e38");
    expect(html).toContain("Required access");
    expect(html).toContain('name="applicationId"');
    expect(html).toContain('name="mode"');
    expect(html).toContain('name="taskId"');
    expect(html).toContain("text.summarize-doc.v1#000");
    expect(html).toContain("Recorded coverage");
    expect(html).toContain("copyable SDK example");
    expect(html).toContain("createZeckClient");
    // No provider selection anywhere on the form.
    expect(html).not.toContain('name="provider"');
    expect(html).not.toContain('name="model"');
  });

  test("a hard provider gap (3D) is NOT RUN — surfaced before execution, never a pass", async () => {
    const html = await getHtml("/console/validation/VAL-018");
    expect(html).toContain("NOT RUN");
    expect(html).toContain("model:three-d");
    expect(html).toContain("no provider in the authorized set");
    expect(html).not.toContain("Run validation rerun");
  });

  test("a suite-reproduction experiment states the honest boundary", async () => {
    const html = await getHtml("/console/validation/VAL-040");
    expect(html).toContain("NOT RUN for this experiment");
    expect(html).toContain("governed suites");
    expect(html).toContain("bundle.json");
  });

  test("the evidence page serves the immutable document verbatim", async () => {
    const html = await getHtml("/console/validation/evidence/VAL-010");
    expect(html).toContain("docs/work-items/VAL-010.md");
    expect(html).toContain("read-only forever");
    expect(html).toContain("VAL-010 — Text Generation, Structured Extraction and Transformation");
    const response = await get("/console/validation/evidence/VAL-999");
    expect(response.status).toBe(404);
  });
});

describe("the governed rerun (two-step POST, AC4/AC7)", () => {
  test("the review step shows the exact envelope and the commitment card", async () => {
    const html = await getHtml(
      "/console/validation/VAL-010?applicationId=00000000-0000-7000-8000-0000000000a1&mode=replay-exact&taskId=text.summarize-doc.v1%23000&idempotencyKey=dash-vt-1",
    );
    expect(html).toContain("Proposed validation rerun");
    expect(html).toContain("Lineage metadata");
    expect(html).toContain("workOrder");
    expect(html).toContain("Run this validation rerun?");
    expect(html).toContain('action="/console/validation/VAL-010/run"');
    const keyMatch = /name="idempotencyKey" value="(dash-[^"]+)"/.exec(html);
    expect(keyMatch?.[1]).toBe("dash-vt-1");
  });

  test("the POST creates exactly one execution with the lineage metadata", async () => {
    const before = createCalls.length;
    const response = await postForm(
      "/console/validation/VAL-010/run",
      "applicationId=00000000-0000-7000-8000-0000000000a1&mode=replay-exact&taskId=text.summarize-doc.v1%23000&idempotencyKey=dash-vt-2",
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toMatch(/^\/runs\//);
    expect(createCalls.length).toBe(before + 1);
    const call = createCalls.at(-1);
    expect(call?.idempotencyKey).toBe("dash-vt-2");
    expect(call?.body.constraints).toEqual({
      maxCostMicroUsd: "2000000",
      maxLatencyMs: 20000,
    });
    expect(call?.body.task).toEqual(TEXT_TASK);
    expect(call?.body.metadata).toEqual({
      origin: "zeck-console-validation-lab",
      workOrder: "VAL-010",
      mode: "replay-exact",
      corpusTask: "text.summarize-doc.v1#000",
      corpusVersion: "val-corpus.1.0.0",
      definitionRevision: "35b0e38",
      sandbox: "disposable",
    });
  });

  test("distinct modes create distinct lineage records on distinct executions (AC4)", async () => {
    const first = await postForm(
      "/console/validation/VAL-010/run",
      "applicationId=00000000-0000-7000-8000-0000000000a1&mode=rerun-current&taskId=text.summarize-doc.v1%23000&idempotencyKey=dash-vt-3",
    );
    const second = await postForm(
      "/console/validation/VAL-010/run",
      "applicationId=00000000-0000-7000-8000-0000000000a1&mode=modified&taskId=structured.extract-invoice.v1%23000&spendLimitDollars=0.25&idempotencyKey=dash-vt-4",
    );
    expect(first.status).toBe(303);
    expect(second.status).toBe(303);
    expect(first.headers.get("location")).not.toBe(second.headers.get("location"));
    const currentCall = createCalls.at(-2)?.body;
    const modifiedCall = createCalls.at(-1)?.body;
    expect(currentCall?.metadata).toMatchObject({ mode: "rerun-current" });
    expect(modifiedCall?.metadata).toMatchObject({
      mode: "modified",
      corpusTask: "structured.extract-invoice.v1#000",
      modifiedFrom: "text.summarize-doc.v1#000",
    });
    expect(modifiedCall?.constraints).toMatchObject({ maxCostMicroUsd: "250000" });
  });

  test("the run history derives from this browser's recents", async () => {
    seedExecution("00000000-0000-7000-8000-0000000000aa", "COMPLETED", {
      origin: "zeck-console-validation-lab",
      workOrder: "VAL-010",
      mode: "replay-exact",
      corpusTask: "text.summarize-doc.v1#000",
    });
    const html = await getHtml(
      "/console/validation/VAL-010",
      `${RECENTS_COOKIE}=00000000-0000-7000-8000-0000000000aa`,
    );
    expect(html).toContain("Run history");
    expect(html).toContain("00000000-0000-7000-8000-0000000000aa");
    expect(html).toContain("Compare these runs");
  });

  test("the compare surface reads runs live and states the corpus expectation", async () => {
    const html = await getHtml(
      "/console/validation/compare?runs=00000000-0000-7000-8000-0000000000aa&workOrder=VAL-010",
    );
    expect(html).toContain("Expected terminal");
    expect(html).toContain("COMPLETED");
    expect(html).toContain("✓ matches");
    const missing = await getHtml(
      "/console/validation/compare?runs=00000000-0000-7000-8000-0000000000ff",
    );
    expect(missing).toContain("Run not readable");
  });
});

describe("the negative proofs — the sandbox limits bite (AC6/AC7)", () => {
  test("an over-ceiling spend POST is refused BEFORE any wire call", async () => {
    const before = createCalls.length;
    const response = await postForm(
      "/console/validation/VAL-010/run",
      "applicationId=00000000-0000-7000-8000-0000000000a1&mode=replay-exact&taskId=text.summarize-doc.v1%23000&spendLimitDollars=5&idempotencyKey=dash-vt-5",
    );
    expect(response.status).toBe(422);
    expect(createCalls.length).toBe(before);
    const html = await response.text();
    expect(html).toContain("could not be submitted");
  });

  test("the concurrency gate refuses a fourth in-flight run (derived live, no server state)", async () => {
    for (const id of [
      "00000000-0000-7000-8000-0000000000b1",
      "00000000-0000-7000-8000-0000000000b2",
      "00000000-0000-7000-8000-0000000000b3",
    ]) {
      seedExecution(id, "RUNNING", {});
    }
    const before = createCalls.length;
    const response = await postForm(
      "/console/validation/VAL-010/run",
      "applicationId=00000000-0000-7000-8000-0000000000a1&mode=replay-exact&taskId=text.summarize-doc.v1%23000&idempotencyKey=dash-vt-6",
      `${RECENTS_COOKIE}=00000000-0000-7000-8000-0000000000b1,00000000-0000-7000-8000-0000000000b2,00000000-0000-7000-8000-0000000000b3`,
    );
    expect(response.status).toBe(422);
    expect(createCalls.length).toBe(before);
    expect(await response.text()).toContain("concurrency limit");
  });

  test("a hard provider gap POST is refused before the wire and never a pass", async () => {
    const before = createCalls.length;
    const response = await postForm(
      "/console/validation/VAL-018/run",
      "applicationId=00000000-0000-7000-8000-0000000000a1&mode=replay-exact&taskId=three-d.render-scene.v1%23000&idempotencyKey=dash-vt-7",
    );
    expect(response.status).toBe(409);
    expect(createCalls.length).toBe(before);
    expect(await response.text()).toContain("NOT RUN");
  });

  test("a suite-reproduction experiment POST is refused honestly", async () => {
    const before = createCalls.length;
    const response = await postForm(
      "/console/validation/VAL-040/run",
      "applicationId=app&mode=replay-exact&taskId=anything&idempotencyKey=dash-vt-8",
    );
    expect(response.status).toBe(409);
    expect(createCalls.length).toBe(before);
  });

  test("a missing idempotency key is refused (form state lost)", async () => {
    const before = createCalls.length;
    const response = await postForm(
      "/console/validation/VAL-010/run",
      "applicationId=00000000-0000-7000-8000-0000000000a1&mode=replay-exact&taskId=text.summarize-doc.v1%23000",
    );
    expect(response.status).toBe(422);
    expect(createCalls.length).toBe(before);
  });
});

describe("the agent/machine interface (AC3)", () => {
  test("catalog.json serves the full projection", async () => {
    const response = await get("/console/validation/api/catalog.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const catalog = (await response.json()) as {
      experiments: { id: string; rerunnable: boolean }[];
      unissuedIds: string[];
    };
    expect(catalog.experiments.length).toBe(46);
    expect(catalog.experiments.some((entry) => entry.id === "VAL-010" && entry.rerunnable)).toBe(
      true,
    );
    expect(catalog.unissuedIds).toContain("VAL-027");
  });

  test("schema.json documents the agent journey and the envelope", async () => {
    const response = await get("/console/validation/api/schema.json");
    expect(response.status).toBe(200);
    const schema = (await response.json()) as {
      rerunModes: string[];
      sandboxEnvelope: { budgetCeilingMicroUsd: string };
      steps: Record<string, { url?: string }>;
    };
    expect(schema.rerunModes).toEqual(["replay-exact", "rerun-current", "modified"]);
    expect(schema.sandboxEnvelope.budgetCeilingMicroUsd).toBe("2000000");
    expect(schema.steps.list?.url).toBe("/console/validation/api/catalog.json");
  });

  test("the definition serves tasks, access, cost and run instructions", async () => {
    const response = await get("/console/validation/api/VAL-010.json");
    expect(response.status).toBe(200);
    const definition = (await response.json()) as {
      id: string;
      tasks: unknown[];
      availability: { missingEnvVars: string[]; presentEnvVars: string[] };
      runInstructions: { method: string; fields: { name: string }[] };
    };
    expect(definition.id).toBe("VAL-010");
    expect(definition.tasks.length).toBe(40);
    expect(definition.availability.presentEnvVars).toContain("OPENROUTER_API_KEY");
    expect(definition.runInstructions.method).toBe("POST");
    expect(definition.runInstructions.fields.map((field) => field.name)).toEqual([
      "applicationId",
      "environmentId",
      "spendLimitDollars",
      "mode",
      "taskId",
      "idempotencyKey",
      "format",
    ]);
    const missing = await get("/console/validation/api/VAL-999.json");
    expect(missing.status).toBe(404);
  });

  test("format=json starts a run and returns the machine receipt", async () => {
    const response = await postForm(
      "/console/validation/VAL-010/run",
      "applicationId=00000000-0000-7000-8000-0000000000a1&mode=replay-exact&taskId=text.summarize-doc.v1%23000&idempotencyKey=dash-vt-9&format=json",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const receipt = (await response.json()) as {
      executionId: string;
      workOrder: string;
      runRecord: string;
    };
    expect(receipt.workOrder).toBe("VAL-010");
    expect(receipt.runRecord).toBe(
      `/console/validation/api/runs/${encodeURIComponent(receipt.executionId)}.json`,
    );
  });

  test("the run record serves live reads with the comparison fact", async () => {
    const executionId = createCalls.map((call, index) => ({ call, index })).at(-1);
    expect(executionId).toBeDefined();
    const response = await get(
      `/console/validation/api/runs/${encodeURIComponent(executionId?.call.body.applicationId === APP_ID ? `00000000-0000-7000-8000-${String(executionId.index + 1).padStart(12, "0")}` : "unknown")}.json`,
    );
    expect(response.status).toBe(200);
    const record = (await response.json()) as {
      status: string;
      lineage: { workOrder: string; mode: string } | null;
      comparisonToExpectation: { matchesTerminalStatus: boolean } | null;
      trajectory: { type: string }[];
    };
    expect(record.status).toBe("COMPLETED");
    expect(record.lineage?.workOrder).toBe("VAL-010");
    expect(record.comparisonToExpectation?.matchesTerminalStatus).toBe(true);
    expect(record.trajectory[0]?.type).toBe("execution.completed");
    const missing = await get(
      "/console/validation/api/runs/00000000-0000-7000-8000-0000000000ff.json",
    );
    expect(missing.status).toBe(404);
  });

  test("the evidence document and the reproducibility bundle serve verbatim", async () => {
    const evidence = await get("/console/validation/api/evidence/VAL-010");
    expect(evidence.status).toBe(200);
    expect(evidence.headers.get("content-type")).toContain("text/markdown");
    expect(await evidence.text()).toContain("# VAL-010");
    const bundleResponse = await get("/console/validation/api/VAL-010/bundle.json");
    expect(bundleResponse.status).toBe(200);
    const bundle = (await bundleResponse.json()) as {
      definition: { id: string };
      evidence: { path: string; content: string };
      reproduction: { suites: string[]; governedBattery: string[] };
    };
    expect(bundle.definition.id).toBe("VAL-010");
    expect(bundle.evidence.path).toBe("docs/work-items/VAL-010.md");
    expect(bundle.reproduction.suites[0]).toBe(
      "tests/integration/validation/val-010-real-model.test.ts",
    );
    expect(bundle.reproduction.governedBattery).toContain("bun run test:unit");
  });
});

describe("secret safety (AC9 — names may cross, values never)", () => {
  test("the hostile credential value never appears in any validation surface", async () => {
    for (const path of [
      "/console/validation",
      "/console/validation/VAL-010",
      "/console/validation/agent",
      "/console/validation/api/catalog.json",
      "/console/validation/api/VAL-010.json",
      "/console/validation/api/VAL-010/bundle.json",
    ]) {
      const response = await get(path);
      const body = await response.text();
      expect(body, path).not.toContain("sk-hostile-value-never-render");
      expect(body, path).not.toContain(HOSTILE_ENV.OPENROUTER_API_KEY);
    }
  });

  test("the credential NAME appears (the exact dependency, AC6), the value does not", async () => {
    const html = await getHtml("/console/validation/VAL-010");
    expect(html).toContain("OPENROUTER_API_KEY");
    expect(html).not.toContain("sk-hostile");
  });
});
