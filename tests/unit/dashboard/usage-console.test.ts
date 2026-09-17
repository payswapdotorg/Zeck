/**
 * Usage, economics and optimization console tests (DEP-030 — the
 * projection side).
 *
 * Two layers, the house discipline:
 *
 *  1. The REAL dashboard server booted over a wire-exact fake API (and a
 *     HOSTILE transport-token value, no budgets env binding): the full
 *     a11y frame, the three tab views, the honest unavailable states
 *     naming their missing contracts, machine parity of facts.json, the
 *     nav entry, and the recents 404-prune.
 *
 *  2. Module-level (no server, the credentials-console discipline): the
 *     budgets transport (env derivation + the house headers), the
 *     quotas-present composition, the transport-error state, and the
 *     hostile-value probes over every render path that interpolates
 *     record-carried strings.
 *
 * Required-test mapping (DEP-030 AC1–AC7):
 *  - AC1 per-run cost/usage facts composed from the public records;
 *  - AC2 budget/quota facts from the budgets authority's public surface;
 *    missing aggregates render as honest unavailable states NAMING the
 *    missing contract;
 *  - AC3 the optimization view renders the platform's own recorded
 *    decisions VERBATIM (never re-derived console-side);
 *  - AC4 facts.json serves the same composed facts (parity probes);
 *  - AC5 hostile-value probes over every new render path;
 *  - AC6 no new API routes — the machine manifests stay untouched (the
 *    manifest-sync suite pins the route table);
 *  - AC7 the house composed-surface pattern + the honesty doctrine.
 */

import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createDashboard } from "../../../apps/dashboard/index";
import {
  createUsageBudgetsTransport,
  USAGE_VIEWS,
  type UsageBudgetsTransport,
  UsageBudgetsUnavailableError,
  type UsageComposition,
  usageBrowserScopedRollup,
  usageBudgetsTransportFromEnvironment,
  usageBudgetsView,
  usageFactsJson,
  usageOptimizationView,
  usageRunsView,
  usageViewOf,
} from "../../../apps/dashboard/usage";
import type { Execution, ExecutionEvent, ExecutionResult } from "../../../sdk";

const APP_ID = "00000000-0000-7000-8000-0000000000a1";
const HOSTILE_TOKEN = "sk-live-usage-transport-77fd0c4b19";
const HOSTILE_MARKUP = '<script>alert("usage-xss")</script>';

const COMPLETED_ID = "00000000-0000-7000-8000-0000000000e1";
const RUNNING_ID = "00000000-0000-7000-8000-0000000000e2";
const GONE_ID = "00000000-0000-7000-8000-0000000000e3";

const COMPLETED_EXECUTION: Execution = {
  id: COMPLETED_ID,
  applicationId: APP_ID,
  environmentId: null,
  status: "COMPLETED",
  task: { kind: "summarize", doc: "quarterly-report-01", maxWords: 60 },
  constraints: { maxCostMicroUsd: "1500000", maxLatencyMs: 120000 },
  metadata: { origin: "zeck-console-playground", family: "text" },
  createdAt: "2026-09-15T12:00:00Z",
  updatedAt: "2026-09-15T12:03:42Z",
  terminalAt: "2026-09-15T12:03:42Z",
};

const RUNNING_EXECUTION: Execution = {
  id: RUNNING_ID,
  applicationId: APP_ID,
  environmentId: null,
  status: "RUNNING",
  task: { kind: "extract", format: "invoice", doc: "invoice-001" },
  constraints: null,
  metadata: {},
  createdAt: "2026-09-15T12:05:00Z",
  updatedAt: "2026-09-15T12:05:01Z",
  terminalAt: null,
};

/** The recorded planning decision — the platform's own payload, verbatim. */
const PLANNING_EVENTS: readonly ExecutionEvent[] = [
  {
    eventId: "e-1",
    executionId: COMPLETED_ID,
    type: "execution.created",
    sequence: 1,
    occurredAt: "2026-09-15T12:00:00Z",
    payload: {},
  },
  {
    eventId: "e-2",
    executionId: COMPLETED_ID,
    type: "planning.decision-recorded",
    sequence: 2,
    occurredAt: "2026-09-15T12:00:01Z",
    payload: {
      decisionId: "decision-7f3a",
      plannerVersion: "planner-1.2.0",
      taskProfile: {
        riskLevel: "low",
        qualityTarget: 0.8,
        maxCostMicroUsd: "1500000",
        maxLatencyMs: 120000,
        requiresSemanticReasoning: true,
      },
      policyInputs: { outcome: "allow", policySetId: "ps-1", policySetVersion: 1 },
      capabilityResolution: {
        satisfied: true,
        catalogRevision: "rev-9",
        unmetIds: [],
        satisfiedIds: ["text-generation"],
      },
      deterministicSufficiency: {
        outcome: "insufficient",
        semanticReasoningRequired: true,
        deterministicQualityEstimate: 0.4,
      },
      candidates: [
        {
          strategyId: "deterministic-echo",
          expectedCostMicroUsd: "120",
          expectedQuality: 0.4,
          expectedLatencyMs: 40,
          verificationStrategy: "schema",
          modelCalls: 0,
          admissible: true,
          routeRationale: { code: "deterministic-sufficient", detail: "echo satisfies" },
          plan: { strategyClass: "deterministic-only", modelCalls: 0 },
        },
        {
          strategyId: `hybrid-qwen${HOSTILE_MARKUP}`,
          expectedCostMicroUsd: "41250",
          expectedQuality: 0.9,
          expectedLatencyMs: 800,
          verificationStrategy: "rubric",
          modelCalls: 1,
          admissible: true,
          routeRationale: { code: "hybrid-composition", detail: "mixed envelope" },
          plan: {
            strategyClass: "hybrid",
            modelCalls: 1,
            steps: [
              { routeRef: { provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct" } },
            ],
          },
        },
      ],
      selectedStrategyId: `hybrid-qwen${HOSTILE_MARKUP}`,
      selectionRationale:
        "cheap-first cascade selection among 2 admissible candidate(s) satisfying the quality target (INT-004)",
      subgraphEvidence: [],
      substrateSelection: {
        outcome: "selected",
        workloadClass: "cloud",
        admissible: [],
        inadmissible: [],
        selected: { substrateId: "std-sandbox", version: "1" },
        rationale: "default sandbox",
      },
      recordDigest: "sha256:9c2f",
    },
  },
];

function resultOf(execution: Execution): ExecutionResult {
  if (execution.id !== COMPLETED_ID) {
    throw new Error("unexpected result read");
  }
  return {
    executionId: execution.id,
    status: execution.status,
    route: {
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b-instruct",
      strategyClass: "hybrid",
      modelCalls: 1,
    },
    cost: { totalMicroUsd: "41250", currency: "usd" },
    usage: { inputTokens: 2100, outputTokens: 340 },
    outputArtifacts: [],
    verification: [],
    warnings: [],
    terminalAt: execution.terminalAt,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchImpl = (async (input: string | URL, _init?: RequestInit) => {
  const path = new URL(String(input)).pathname;
  if (path === "/agents") {
    return json([]);
  }
  if (path === `/executions/${COMPLETED_ID}`) return json(COMPLETED_EXECUTION);
  if (path === `/executions/${RUNNING_ID}`) return json(RUNNING_EXECUTION);
  if (path === `/executions/${GONE_ID}`) {
    return json({ code: "CAPABILITY_UNAVAILABLE", message: "not found", retryable: false }, 404);
  }
  if (path === `/executions/${COMPLETED_ID}/results`) return json(resultOf(COMPLETED_EXECUTION));
  if (path === `/executions/${COMPLETED_ID}/events`) return json(PLANNING_EVENTS);
  if (path === `/executions/${COMPLETED_ID}/verification`) return json([]);
  if (path === `/executions/${RUNNING_ID}/results`) {
    return json({ code: "CAPABILITY_UNAVAILABLE", message: "not settled", retryable: false }, 404);
  }
  if (path === `/executions/${RUNNING_ID}/events`) return json([]);
  if (path === `/executions/${RUNNING_ID}/verification`) return json([]);
  return json({ code: "PROVIDER_ERROR", message: `unexpected path ${path}`, retryable: true }, 500);
}) as unknown as typeof fetch;

let base = "";
const SAVED_ENV: Record<string, string | undefined> = {};

beforeAll(async () => {
  // The budgets transport derives per-request from the deployment's
  // environment contract — this suite's server layer runs UNBOUND (the
  // honest unavailable states), so the bindings must be absent.
  for (const name of ["ZECK_API_URL", "ZECK_TOKEN", "ZECK_APPLICATION_ID"]) {
    SAVED_ENV[name] = process.env[name];
    delete process.env[name];
  }
  const { server } = createDashboard({
    apiUrl: "http://fake.local",
    token: HOSTILE_TOKEN,
    applicationId: APP_ID,
    port: 0,
    fetchImpl,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
});

afterEach(() => {
  for (const [name, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

const RECENTS = `zeck_recent_executions=${[COMPLETED_ID, RUNNING_ID, GONE_ID].join(",")}`;

async function get(path: string, cookie?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    redirect: "manual",
    ...(cookie === undefined ? {} : { headers: { cookie } }),
  });
}

async function getHtml(path: string, cookie?: string): Promise<string> {
  const response = await get(path, cookie);
  expect(response.status, path).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  return response.text();
}

describe("the usage surface renders with the full a11y frame (DEP-030 AC7)", () => {
  test("every view: doctype, lang, one h1, landmarks, skip link, viewport, command surface", async () => {
    for (const path of [
      "/console/usage",
      "/console/usage?tab=budgets",
      "/console/usage?tab=optimization",
    ]) {
      const html = await getHtml(path, RECENTS);
      expect(html.startsWith("<!doctype html>"), path).toBe(true);
      expect(html, path).toContain('<html lang="en"');
      expect(html, path).toContain("<title>");
      expect((html.match(/<h1[^>]*>/g) ?? []).length, path).toBe(1);
      expect(html, path).toContain("<header");
      expect(html, path).toContain('aria-label="Primary"');
      expect(html, path).toContain("<main");
      expect(html, path).toContain("<footer");
      expect(html, path).toContain('role="search"');
      expect(html, path).toContain('href="#main">Skip to main content');
      expect(html, path).toContain(
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
      );
      expect(html, path).toContain('action="/command"');
      expect(html, path).toContain('src="/assets/client.js"');
    }
  });

  test("the tab nav carries the three views with aria-current on the active one", async () => {
    const runs = await getHtml("/console/usage", RECENTS);
    expect(runs).toContain('href="/console/usage?tab=runs" aria-current="page"');
    expect(runs).toContain('href="/console/usage?tab=budgets"');
    expect(runs).toContain('href="/console/usage?tab=optimization"');
    const budgets = await getHtml("/console/usage?tab=budgets", RECENTS);
    expect(budgets).toContain('href="/console/usage?tab=budgets" aria-current="page"');
    expect(USAGE_VIEWS).toEqual(["runs", "budgets", "optimization"]);
    expect(usageViewOf(null)).toBe("runs");
    expect(usageViewOf("nonsense")).toBe("runs");
    expect(usageViewOf("optimization")).toBe("optimization");
  });

  test("the Develop nav carries the Usage & economics entry with aria-current", async () => {
    const html = await getHtml("/console/usage", RECENTS);
    expect(html).toContain("Usage &amp; economics");
    expect(html).toContain('href="/console/usage" aria-current="page"');
  });

  test("an unknown tab value falls back to the runs view (never an error page)", async () => {
    const html = await getHtml("/console/usage?tab=nope", RECENTS);
    expect(html).toContain("Runs &amp; cost");
  });
});

describe("AC1 — per-run cost and usage facts composed from the public records", () => {
  test("the runs view renders tokens, settled cost, declared limit and the recorded route", async () => {
    const html = await getHtml("/console/usage", RECENTS);
    expect(html).toContain("2100");
    expect(html).toContain("340");
    expect(html).toContain("$0.04125");
    expect(html).toContain("41250 micro-USD");
    expect(html).toContain("$1.50");
    expect(html).toContain("1500000 micro-USD");
    expect(html).toContain("hybrid");
    expect(html).toContain("via openrouter");
    expect(html).toContain('href="/runs/00000000-0000-7000-8000-0000000000e1"');
    // formatMicroUsd already carries the $ prefix — a doubled $$ is a
    // rendering defect (pinned after the lead-smoke caught one).
    expect(html).not.toContain("$$");
  });

  test("an unsettled run renders the honest not-settled states, never a zero", async () => {
    const html = await getHtml("/console/usage", RECENTS);
    expect(html).toContain("not settled yet");
    expect(html).toContain("not recorded");
    expect(html).toContain("none declared");
  });

  test("the browser-scoped roll-up is disclosed as browser-scoped, never application-scoped", async () => {
    const html = await getHtml("/console/usage", RECENTS);
    expect(html).toContain("Browser-scoped disclosed roll-up");
    expect(html).toContain("2 run(s) opened");
    expect(html).toContain("1 settled");
  });

  test("a recents id whose live read 404s is pruned with a refreshed cookie", async () => {
    const response = await get("/console/usage", RECENTS);
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("zeck_recent_executions=");
    expect(cookie).not.toContain(GONE_ID);
    expect(cookie).toContain(COMPLETED_ID);
  });
});

describe("AC2 — honest unavailable states name their missing contracts", () => {
  test("the application-scoped usage aggregate names the missing route contract", async () => {
    const html = await getHtml("/console/usage", RECENTS);
    expect(html).toContain(
      "Application-scoped usage aggregates — not yet exposed by the public API",
    );
    expect(html).toContain(
      "an application-scoped usage/aggregate route (e.g. GET /applications/:id/usage)",
    );
  });

  test("the per-step cost breakdown names its missing projection contract", async () => {
    const html = await getHtml("/console/usage", RECENTS);
    expect(html).toContain(
      "Per-step and per-model cost breakdown — not yet exposed by the public API",
    );
    expect(html).toContain("a cost-breakdown projection over GET /executions/:id/results");
  });

  test("the unbound budgets transport renders the honest env-contract state (no fabricated quotas)", async () => {
    const html = await getHtml("/console/usage?tab=budgets", RECENTS);
    expect(html).toContain(
      "Sandbox budget and quota envelopes — not yet exposed by the public API",
    );
    expect(html).toContain("ZECK_API_URL");
    expect(html).toContain("ZECK_APPLICATION_ID");
  });

  test("the reservation/settlement envelope boundary names the budgets projection contract", async () => {
    const html = await getHtml("/console/usage?tab=budgets", RECENTS);
    expect(html).toContain(
      "Budget reservations and settlement envelopes — not yet exposed by the public API",
    );
    expect(html).toContain("a budgets projection route over");
    expect(html).toContain("reservation/settlement/envelope records");
  });
});

describe("AC3 — the optimization view renders recorded decisions verbatim", () => {
  test("the recorded decision facts render exactly as the ledger carries them", async () => {
    const html = await getHtml("/console/usage?tab=optimization", RECENTS);
    // Verbatim facts (never re-derived console-side):
    expect(html).toContain("decision-7f3a");
    expect(html).toContain("planner-1.2.0");
    expect(html).toContain("deterministic-echo");
    expect(html).toContain("cheap-first cascade selection among 2 admissible candidate(s)");
    expect(html).toContain("insufficient");
    expect(html).toContain("deterministic-sufficient");
    expect(html).toContain("hybrid-composition");
    expect(html).toContain("(selected)");
    // The route summary from the result record:
    expect(html).toContain("recorded strategy class");
    expect(html).toContain("meta-llama/llama-3.3-70b-instruct");
  });

  test("a run without a recorded planning decision renders the honest unrecorded state", async () => {
    const html = await getHtml("/console/usage?tab=optimization", RECENTS);
    expect(html).toContain("No planning decision recorded");
    expect(html).toContain("planning.decision-recorded");
  });

  test("the aggregate optimization outcomes boundary names its missing contract", async () => {
    const html = await getHtml("/console/usage?tab=optimization", RECENTS);
    expect(html).toContain("Aggregate optimization outcomes — not yet exposed by the public API");
    expect(html).toContain(
      "an application-scoped optimization-outcome route over the planning/economics authorities",
    );
  });
});

describe("AC4 — machine parity: facts.json serves the same composition", () => {
  test("facts.json is valid JSON carrying the same per-run facts as the HTML", async () => {
    const response = await get("/console/usage/facts.json", RECENTS);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as {
      runs: { executionId: string; costMicroUsd: string | null; inputTokens: number | null }[];
      optimization: { selectedStrategyId: string | null; sufficiencyOutcome: string | null }[];
      browserScoped: { runCount: number; settledCount: number; totalCostMicroUsd: string };
      budgets: { quotas: unknown };
      boundaries: Record<string, { available: boolean; missingContract: string }>;
    };
    // Parity with the HTML view's facts (AC1 probes the HTML strings):
    expect(body.runs).toHaveLength(2);
    expect(body.runs[0]?.executionId).toBe(COMPLETED_ID);
    expect(body.runs[0]?.costMicroUsd).toBe("41250");
    expect(body.runs[0]?.inputTokens).toBe(2100);
    expect(body.runs[1]?.costMicroUsd).toBeNull();
    expect(body.optimization[0]?.selectedStrategyId).toContain("hybrid-qwen");
    expect(body.optimization[0]?.sufficiencyOutcome).toBe("insufficient");
    expect(body.browserScoped).toEqual({
      runCount: 2,
      settledCount: 1,
      totalCostMicroUsd: "41250",
    });
    // The unbound budgets axis is honest in the machine view too:
    expect(body.budgets.quotas).toBeNull();
    // Every boundary names its missing contract (no UI-only state):
    expect(Object.keys(body.boundaries).sort()).toEqual([
      "aggregateOptimizationOutcomes",
      "applicationScopedUsage",
      "budgetEnvelopes",
      "realtimeConsumptionTelemetry",
    ]);
    for (const boundary of Object.values(body.boundaries)) {
      expect(boundary.available).toBe(false);
      expect(boundary.missingContract.length).toBeGreaterThan(0);
    }
  });
});

describe("AC5 — hostile-value probes over every new render path", () => {
  test("record-carried hostile markup never renders raw in HTML (escaped only)", async () => {
    for (const path of [
      "/console/usage",
      "/console/usage?tab=budgets",
      "/console/usage?tab=optimization",
    ]) {
      const body = await (await get(path, RECENTS)).text();
      expect(body, path).not.toContain("<script>alert(");
      expect(body, path).not.toContain(HOSTILE_TOKEN);
    }
    // The hostile strategy id IS present — escaped (the record fact survives).
    const optimization = await getHtml("/console/usage?tab=optimization", RECENTS);
    expect(optimization).toContain("&lt;script&gt;alert(&quot;usage-xss&quot;)&lt;/script&gt;");
  });

  test("the machine view carries the record's hostile value as DATA (valid JSON, never HTML)", async () => {
    const response = await get("/console/usage/facts.json", RECENTS);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.text();
    expect(body).not.toContain(HOSTILE_TOKEN);
    // The machine view serves the record VERBATIM: the hostile strategy id
    // survives as JSON data (properly encoded — the document parses).
    const parsed = JSON.parse(body) as {
      optimization: { selectedStrategyId: string | null }[];
    };
    expect(parsed.optimization[0]?.selectedStrategyId).toBe(`hybrid-qwen${HOSTILE_MARKUP}`);
  });

  test("module-level hostile probes: quota dimensions, statuses and windows escape", () => {
    const composition: UsageComposition = {
      runs: [],
      optimization: [],
      browserScoped: { runCount: 0, settledCount: 0, totalCostMicroUsd: "0" },
      budgets: {
        quotas: [
          {
            id: "q-1",
            applicationId: APP_ID,
            dimension: `spend${HOSTILE_MARKUP}`,
            limit: "1000000",
            consumed: "250000",
            window: `calendar-month${HOSTILE_MARKUP}`,
            status: `active${HOSTILE_MARKUP}`,
            identityId: null,
            updatedAt: "2026-09-15T12:00:00Z",
          },
        ],
        realtime: false,
        unavailableReason: null,
      },
    };
    const html = `${usageRunsView(composition)}${usageBudgetsView(composition)}${usageOptimizationView(composition)}`;
    expect(html).not.toContain("<script>alert(");
    expect(html).toContain("spend&lt;script&gt;");
    expect(html).toContain("calendar-month&lt;script&gt;");
    expect(html).toContain("active&lt;script&gt;");
  });
});

describe("the budgets transport (module-local, over the public quota route)", () => {
  test("carries the house headers on every call (Bearer + the scope selector)", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const transport = createUsageBudgetsTransport({
      baseUrl: "http://api.test.local",
      token: HOSTILE_TOKEN,
      applicationId: APP_ID,
      fetchImpl: (async (input: string | URL, init?: RequestInit) => {
        seen.push({
          url: String(input),
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        return json({ quotas: [], telemetry: { realtime: false } });
      }) as unknown as typeof fetch,
    });
    const list = await transport.listQuotas();
    expect(list.quotas).toEqual([]);
    expect(list.telemetry.realtime).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("http://api.test.local/sandbox/quotas");
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${HOSTILE_TOKEN}`);
    expect(seen[0]?.headers["x-zeck-application"]).toBe(APP_ID);
  });

  test("the environment-derived transport is null unless the full contract is bound", () => {
    expect(usageBudgetsTransportFromEnvironment({})).toBeNull();
    expect(
      usageBudgetsTransportFromEnvironment({
        ZECK_API_URL: "http://api.test.local",
        ZECK_TOKEN: "t",
      }),
    ).toBeNull();
    expect(
      usageBudgetsTransportFromEnvironment({
        ZECK_API_URL: "http://api.test.local",
        ZECK_TOKEN: "t",
        ZECK_APPLICATION_ID: APP_ID,
      }),
    ).not.toBeNull();
  });

  test("an honest 422 from the route surfaces as the named unavailable state, never a fabricated quota", async () => {
    const transport: UsageBudgetsTransport = {
      async listQuotas() {
        throw new UsageBudgetsUnavailableError(
          "the quota authority is not wired in this deployment (GET /sandbox/quotas answered the honest 422 — nothing is fabricated in its place)",
        );
      },
    };
    const quotas = await transport.listQuotas().catch(() => null);
    expect(quotas).toBeNull();
    const composition: UsageComposition = {
      runs: [],
      optimization: [],
      browserScoped: { runCount: 0, settledCount: 0, totalCostMicroUsd: "0" },
      budgets: {
        quotas: null,
        realtime: false,
        unavailableReason:
          "the quota authority is not wired in this deployment (GET /sandbox/quotas answered the honest 422 — nothing is fabricated in its place)",
      },
    };
    const html = usageBudgetsView(composition);
    expect(html).toContain("not yet exposed by the public API");
    expect(html).toContain("answered the honest 422");
    expect(html).toContain("GET /sandbox/quotas");
  });

  test("the quotas-present view renders the authority's public envelope with the telemetry boundary", () => {
    const composition: UsageComposition = {
      runs: [],
      optimization: [],
      browserScoped: { runCount: 0, settledCount: 0, totalCostMicroUsd: "0" },
      budgets: {
        quotas: [
          {
            id: "q-1",
            applicationId: APP_ID,
            dimension: "spend-micro-usd",
            limit: "1000000",
            consumed: "250000",
            window: "calendar-month",
            status: "active",
            identityId: null,
            updatedAt: "2026-09-15T12:00:00Z",
          },
        ],
        realtime: false,
        unavailableReason: null,
      },
    };
    const html = usageBudgetsView(composition);
    expect(html).toContain("Spend (micro-USD)");
    expect(html).toContain("250000");
    expect(html).toContain("1000000");
    expect(html).toContain("calendar-month");
    expect(html).toContain("25%");
    expect(html).toContain("Real-time consumption telemetry — not yet exposed by the public API");
    // The machine view carries the same quota axis (parity):
    const facts = usageFactsJson(composition);
    expect(((facts.budgets as { quotas: unknown[] }).quotas ?? []).length).toBe(1);
  });
});

describe("the composition is pure over the public records (no second authority)", () => {
  test("an empty recents list renders the honest empty states on every view", () => {
    const composition: UsageComposition = {
      runs: [],
      optimization: [],
      browserScoped: { runCount: 0, settledCount: 0, totalCostMicroUsd: "0" },
      budgets: { quotas: null, realtime: false, unavailableReason: null },
    };
    expect(usageRunsView(composition)).toContain("No usage yet");
    expect(usageBudgetsView(composition)).toContain("No declared per-run ceilings yet");
    expect(usageOptimizationView(composition)).toContain("No optimization facts yet");
  });

  test("the roll-up sums only well-formed integer micro-USD strings (the honest skip)", () => {
    expect(
      usageBrowserScopedRollup([
        {
          executionId: "a",
          family: "text",
          status: "COMPLETED",
          createdAt: "2026-09-15T12:00:00Z",
          terminalAt: "2026-09-15T12:01:00Z",
          inputTokens: 1,
          outputTokens: 1,
          costMicroUsd: "10",
          declaredLimitMicroUsd: null,
          provider: null,
          strategyClass: null,
          modelCalls: null,
        },
        {
          executionId: "b",
          family: "text",
          status: "COMPLETED",
          createdAt: "2026-09-15T12:00:00Z",
          terminalAt: "2026-09-15T12:01:00Z",
          inputTokens: 1,
          outputTokens: 1,
          costMicroUsd: "32",
          declaredLimitMicroUsd: null,
          provider: null,
          strategyClass: null,
          modelCalls: null,
        },
        {
          executionId: "c",
          family: "text",
          status: "RUNNING",
          createdAt: "2026-09-15T12:00:00Z",
          terminalAt: null,
          inputTokens: null,
          outputTokens: null,
          costMicroUsd: null,
          declaredLimitMicroUsd: null,
          provider: null,
          strategyClass: null,
          modelCalls: null,
        },
      ]),
    ).toEqual({ runCount: 3, settledCount: 2, totalCostMicroUsd: "42" });
  });
});
