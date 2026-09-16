/**
 * Execution explorer journey + hostile probes (DEP-012 ACs).
 *
 * Boots the REAL dashboard server with a wire-exact fake API and drives
 * the explorer end to end:
 *  - LIST: the executions page renders the browser's disclosed recents
 *    with status / workload family / timing / cost columns, the honest
 *    no-listing-route boundary, and the lookup form;
 *  - SIX VIEWS: the detail page renders Result, Verification, Activity,
 *    Route & substrate, Costs and Provenance from the public records,
 *    each missing fact naming its missing public contract;
 *  - MACHINE PARITY: /console/executions/:id/facts.json serves the
 *    composed public records verbatim (execution, result, events,
 *    verification) plus ONLY derived family/planning facts — an agent
 *    follows an execution without scraping HTML;
 *  - HONEST 404: an unknown/invisible id renders the honest not-found
 *    state (HTML) and the honest JSON error (machine route);
 *  - HOSTILE PROBES: unknown tab params fall back to the Result view,
 *    injected ids never render unescaped, junk recents-cookie ids are
 *    pruned live, and the nav carries the first-class Executions entry.
 */

import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  EXPLORER_VIEWS,
  explorerFactsOf,
  explorerFamilyOf,
  explorerRunsOf,
  explorerViewOf,
} from "../../../apps/dashboard/explorer";
import { createDashboard } from "../../../apps/dashboard/index";
import { NAV_GROUPS } from "../../../apps/dashboard/shell";
import type { Execution, ExecutionEvent, ExecutionResult, VerificationResult } from "../../../sdk";

const APP_ID = "00000000-0000-7000-8000-0000000000c3";
const RUN_ID = "00000000-0000-7000-8000-0000000000e7";
const OTHER_ID = "00000000-0000-7000-8000-0000000000e8";

const execution: Execution = {
  id: RUN_ID,
  applicationId: APP_ID,
  environmentId: null,
  status: "COMPLETED",
  task: { kind: "summarize", doc: "postmortem-01", maxWords: 45 },
  constraints: { maxCostMicroUsd: "1250000", maxLatencyMs: 120000 },
  metadata: { origin: "zeck-console-playground", family: "text", sandbox: "disposable" },
  createdAt: "2026-09-16T09:00:00Z",
  updatedAt: "2026-09-16T09:00:02Z",
  terminalAt: "2026-09-16T09:00:02Z",
};

const result: ExecutionResult = {
  executionId: RUN_ID,
  status: "COMPLETED",
  route: {
    provider: "openrouter",
    model: "qwen/qwen3-14b",
    strategyClass: "hybrid",
    modelCalls: 1,
  },
  cost: { totalMicroUsd: "41250", currency: "usd" },
  usage: { inputTokens: 2100, outputTokens: 340 },
  outputArtifacts: [
    { id: "art-0001", digest: "sha256:abcdef0123456789", createdAt: "2026-09-16T09:00:02Z" },
  ],
  verification: [
    {
      id: "ver-0001",
      executionId: RUN_ID,
      criterionId: "quickstart-criterion",
      strategy: "deterministic-oracle",
      status: "PASS",
      confidence: null,
      evaluator: { kind: "builtin", id: "quickstart-check", version: "1" },
      evidenceRefs: ["art-0001"],
      recordedAt: "2026-09-16T09:00:02Z",
    },
  ],
  warnings: [],
  terminalAt: "2026-09-16T09:00:02Z",
};

const events: ExecutionEvent[] = [
  {
    eventId: "evt-0001",
    executionId: RUN_ID,
    type: "execution.created",
    sequence: 1,
    occurredAt: "2026-09-16T09:00:00Z",
    payload: { status: "CREATED" },
  },
  {
    eventId: "evt-0002",
    executionId: RUN_ID,
    type: "execution.completed",
    sequence: 2,
    occurredAt: "2026-09-16T09:00:02Z",
    payload: { status: "COMPLETED" },
  },
];

const verification: readonly VerificationResult[] = result.verification;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const seenPaths: string[] = [];

const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname;
  const method = init?.method ?? "GET";
  seenPaths.push(`${method} ${path}`);
  if (path === "/agents") {
    return json([]);
  }
  const match = /^\/executions\/([^/]+)$/.exec(path);
  if (match !== null && method === "GET") {
    const id = decodeURIComponent(match[1] ?? "");
    if (id === RUN_ID) {
      return json(execution);
    }
    if (id === OTHER_ID) {
      return json({ ...execution, id: OTHER_ID, metadata: { origin: "validation-lab" } });
    }
    return json({ code: "PROVIDER_ERROR", message: "not found" }, 404);
  }
  const sub = /^\/executions\/([^/]+)\/(results|events|verification)$/.exec(path);
  if (sub !== null && method === "GET") {
    const id = decodeURIComponent(sub[1] ?? "");
    if (id !== RUN_ID && id !== OTHER_ID) {
      return json({ code: "PROVIDER_ERROR", message: "not found" }, 404);
    }
    if (sub[2] === "results") {
      return id === RUN_ID ? json(result) : json({ ...result, executionId: OTHER_ID, cost: null });
    }
    if (sub[2] === "events") {
      return json(events);
    }
    return json(verification);
  }
  return json({ code: "PROVIDER_ERROR", message: `unexpected ${path}` }, 500);
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

const RECENTS = `zeck_recent_executions=${[RUN_ID, OTHER_ID, "not-a-real-id"].join(",")}`;

async function get(path: string, cookie = RECENTS): Promise<Response> {
  return fetch(`${base}${path}`, {
    headers: cookie === "" ? {} : { cookie },
    redirect: "manual",
  });
}

describe("the executions list (DEP-012 AC1)", () => {
  test("renders the recents with status, family, timing and cost columns", async () => {
    const res = await get("/console/executions");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Workload family");
    expect(body).toContain("Recorded cost");
    expect(body).toContain("text");
    expect(body).toContain(RUN_ID);
    expect(body).toContain("COMPLETED");
    expect(body).toContain("$0.04");
  });

  test("names the honest no-listing-route boundary", async () => {
    const res = await get("/console/executions");
    const body = await res.text();
    expect(body).toContain("No application-scoped execution listing exists");
    expect(body).toContain("GET /executions (listing)");
  });

  test("prunes junk recents ids live and re-sets the cookie", async () => {
    const res = await get("/console/executions");
    const setCookie = res.headers
      .getSetCookie()
      .find((c) => c.startsWith("zeck_recent_executions="));
    expect(setCookie).toBeDefined();
    expect(setCookie).not.toContain("not-a-real-id");
    expect(setCookie).toContain(RUN_ID);
  });

  test("renders the honest empty state for a fresh browser", async () => {
    const res = await get("/console/executions", "");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("No executions opened in this browser yet");
  });

  test("carries the first-class Executions nav entry", () => {
    const item = NAV_GROUPS.flatMap((group) => group.items).find(
      (entry) => entry.path === "/console/executions",
    );
    expect(item).toBeDefined();
    expect(item?.label).toBe("Executions");
  });
});

describe("the six explorer views (DEP-012 AC2-6)", () => {
  test("the tab nav carries exactly the six linkable views", async () => {
    const res = await get(`/console/executions/${RUN_ID}`);
    const body = await res.text();
    for (const view of EXPLORER_VIEWS) {
      expect(body).toContain(`?tab=${view}`);
    }
  });

  test("Result view renders terminal status, artifacts with digests and usage", async () => {
    const res = await get(`/console/executions/${RUN_ID}?tab=result`);
    const body = await res.text();
    expect(body).toContain("COMPLETED");
    expect(body).toContain("art-0001");
    expect(body).toContain("sha256:abcdef0123456789");
    expect(body).toContain("2100 in / 340 out tokens");
    expect(body).toContain("references and content digests, never content");
  });

  test("Verification view renders every recorded check with outcome and evidence ref", async () => {
    const res = await get(`/console/executions/${RUN_ID}?tab=verification`);
    const body = await res.text();
    expect(body).toContain("quickstart-criterion");
    expect(body).toContain("PASS");
    expect(body).toContain("deterministic-oracle");
    expect(body).toContain("art-0001");
    expect(body).toContain("console NEVER re-verifies");
  });

  test("Activity view renders the event ledger in causal order", async () => {
    const res = await get(`/console/executions/${RUN_ID}?tab=activity`);
    const body = await res.text();
    const created = body.indexOf("execution.created");
    const completed = body.indexOf("execution.completed");
    expect(created).toBeGreaterThan(-1);
    expect(completed).toBeGreaterThan(created);
    expect(body).toContain("evt-0001");
  });

  test("Route & substrate view renders the recorded route and honest agent/tool boundary", async () => {
    const res = await get(`/console/executions/${RUN_ID}?tab=route`);
    const body = await res.text();
    expect(body).toContain("openrouter");
    expect(body).toContain("qwen/qwen3-14b");
    expect(body).toContain("No agent/tool participation recorded");
  });

  test("Costs view renders the settled cost, constraints and the honest breakdown boundary", async () => {
    const res = await get(`/console/executions/${RUN_ID}?tab=costs`);
    const body = await res.text();
    expect(body).toContain("41250");
    expect(body).toContain("$0.04");
    expect(body).toContain("$1.25");
    expect(body).toContain("120000 ms");
    expect(body).toContain("Per-step and per-model cost breakdown");
    expect(body).toContain("GET /executions/:id/results");
  });

  test("Provenance view renders scope, metadata lineage and the honest request-identity boundary", async () => {
    const res = await get(`/console/executions/${RUN_ID}?tab=provenance`);
    const body = await res.text();
    expect(body).toContain(APP_ID);
    expect(body).toContain("zeck-console-playground");
    expect(body).toContain("disposable");
    expect(body).toContain("Request identity and idempotency key");
    expect(body).toContain("GET /executions/:id");
  });

  test("a run without metadata.family falls back to the task kind, else unrecorded", async () => {
    const res = await get(`/console/executions/${OTHER_ID}`);
    const body = await res.text();
    expect(body).toContain("text");
  });

  test("an unknown id renders the honest 404 with the recovery form", async () => {
    const res = await get("/console/executions/00000000-0000-7000-8000-0000000000ff");
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("not visible through the governed API");
    expect(body).toContain("Look up an execution by id");
  });
});

describe("machine parity (DEP-012 AC8)", () => {
  test("facts.json serves the composed public records verbatim plus derived-only facts", async () => {
    const res = await get(`/console/executions/${RUN_ID}/facts.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.execution).toEqual(execution);
    expect(body.result).toEqual(result);
    expect(body.events).toEqual(events);
    expect(body.verification).toEqual(verification);
    const derived = body.derived as { family: string };
    expect(derived.family).toBe("text");
    expect(body.source).toBeDefined();
  });

  test("facts.json renders the honest JSON 404 for an unknown id", async () => {
    const res = await get("/console/executions/00000000-0000-7000-8000-0000000000ff/facts.json");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("NOT_FOUND");
  });

  test("the list machine route serves the recents rows with the honest listing note", async () => {
    const res = await get("/console/executions/facts.json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { note: string; runs: { id: string; family: string }[] };
    expect(body.note).toContain("no application-scoped execution listing route");
    const ids = body.runs.map((run) => run.id);
    expect(ids).toContain(RUN_ID);
    expect(ids).toContain(OTHER_ID);
    expect(ids).not.toContain("not-a-real-id");
    expect(body.runs.find((run) => run.id === RUN_ID)?.family).toBe("text");
  });

  test("the HTML views and the machine view cannot drift (one composition)", () => {
    const facts = { execution, result, events, verification };
    const machine = explorerFactsOf(facts);
    expect(machine.execution).toBe(execution);
    expect(machine.result).toBe(result);
    expect(explorerViewOf("bogus")).toBe("result");
    expect(explorerViewOf("costs")).toBe("costs");
  });
});

describe("hostile probes (DEP-012 AC9)", () => {
  test("an unknown tab param falls back to the Result view, never an error", async () => {
    const res = await get(`/console/executions/${RUN_ID}?tab=${encodeURIComponent("<script>")}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<h2>Result</h2>");
    expect(body).not.toContain("<script>");
  });

  test("an id carrying markup never renders unescaped", async () => {
    const res = await get(
      `/console/executions/${encodeURIComponent("<img src=x onerror=alert(1)>")}`,
    );
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain("<img src=x");
    expect(body).toContain("&lt;img src=x");
  });

  test("the junk recents id is probed once per list load and never expanded or rendered", async () => {
    const before = seenPaths.filter((p) => p === "GET /executions/not-a-real-id").length;
    const res = await get("/console/executions");
    const body = await res.text();
    // The live re-read IS the prune mechanism: exactly one getExecution
    // probe per list load, never the results/events/verification
    // sub-reads, and the id never renders in the table.
    const probes = seenPaths.filter((p) => p === "GET /executions/not-a-real-id").length;
    expect(probes).toBe(before + 1);
    expect(seenPaths).not.toContain("GET /executions/not-a-real-id/results");
    expect(seenPaths).not.toContain("GET /executions/not-a-real-id/events");
    expect(seenPaths).not.toContain("GET /executions/not-a-real-id/verification");
    expect(body).not.toContain(">not-a-real-id<");
  });

  test("explorerFamilyOf never invents a family outside the catalog", () => {
    const unrecorded = explorerFamilyOf({
      ...execution,
      id: "x",
      metadata: { family: "not-a-family" },
      task: { kind: "not-a-kind" },
    });
    expect(unrecorded).toBe("unrecorded");
  });

  test("explorerRunsOf renders a missing result as an honest null cost", () => {
    const runs = explorerRunsOf([execution], new Map());
    expect(runs[0]?.costMicroUsd).toBeNull();
    expect(runs[0]?.family).toBe("text");
    expect(runs[0]?.origin).toBe("zeck-console-playground");
  });
});
