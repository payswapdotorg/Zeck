/**
 * Playground compare-console tests (DEP-031 ACs).
 *
 * Boots the REAL dashboard server with a wire-exact fake API and drives
 * the compare surface end to end, plus pure-function proofs over the
 * composition:
 *  - AC1 SIDE BY SIDE: two runs of the same family compare on every
 *    public fact (status, terminal outcome, recorded cost/usage, route,
 *    verification outcomes, duration, warnings, artifacts, lineage) —
 *    every fact sourced from the four public records, none invented;
 *  - AC2 THE EXPLANATION PANEL: the platform's OWN recorded planning
 *    rationale renders VERBATIM from the event ledger (candidates with
 *    expected cost/quality/latency, selected strategy, selection
 *    rationale, substrate) — planningDecisionOf is the single reader,
 *    never re-derived console-side;
 *  - AC3 THE BASELINE LAUNCHER: the same frozen public create contract
 *    (the captured request carries only the frozen vocabulary — provider
 *    selection is structurally impossible), the recorded baseline
 *    lineage metadata, constraints capped at the playground limits, the
 *    honest unavailable state naming the missing baseline-planning
 *    contract, the concurrency gate, the platform-rejection surface;
 *  - AC4 MACHINE PARITY: /console/compare/facts.json serves the SAME
 *    composition — facts.a/facts.b EQUAL the per-run facts.json views
 *    (HTTP-verified verbatim equality), with the honest JSON 400/404s;
 *  - AC7 HONEST BOUNDARIES: different families compare on the generic
 *    axes only and SAY so; the universal boundaries (realized quality
 *    scores, statistical comparison, per-step cost, baseline planning
 *    semantics) each name their missing contract; the same-run state;
 *  - HOSTILE PROBES: markup-carrying ids, metadata, strategy fields and
 *    task values never render unescaped on any new interpolation path,
 *    and the machine view stays parseable JSON carrying them as data.
 */

import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BASELINE_MISSING_CONTRACT,
  buildBaselineRerunRequest,
  COMPARE_BASELINE_LINEAGE,
  compareDurationMsOf,
  compareSideOf,
  composeCompare,
} from "../../../apps/dashboard/compare";
import {
  PLAYGROUND_BUDGET_LIMIT_MICRO_USD,
  PLAYGROUND_LATENCY_LIMIT_MS,
} from "../../../apps/dashboard/console";
import type { ExplorerFacts } from "../../../apps/dashboard/explorer";
import { createDashboard } from "../../../apps/dashboard/index";
import { planningDecisionOf } from "../../../apps/dashboard/projection";
import {
  type Execution,
  type ExecutionEvent,
  type ExecutionReceipt,
  type ExecutionResult,
  FORBIDDEN_REQUEST_KEYS,
  type VerificationResult,
} from "../../../sdk";

const APP_ID = "00000000-0000-7000-8000-0000000000d5";
const RUN_A = "00000000-0000-7000-8000-0000000000ea";
const RUN_B = "00000000-0000-7000-8000-0000000000eb";
const RUN_C = "00000000-0000-7000-8000-0000000000ec"; // different family
const HOSTILE_ID = '00000000-0000-7000-8000-0000000"<script>a()</script>';
const CREATED_BASE_ID = "00000000-0000-7000-8000-0000000000ed";
const INFLIGHT_IDS = [
  "00000000-0000-7000-8000-0000000000f1",
  "00000000-0000-7000-8000-0000000000f2",
  "00000000-0000-7000-8000-0000000000f3",
];

function executionOf(id: string, overrides: Partial<Execution> = {}): Execution {
  return {
    id,
    applicationId: APP_ID,
    environmentId: null,
    status: "COMPLETED",
    task: { kind: "summarize", doc: "quarterly-report-01", maxWords: 60 },
    constraints: { maxCostMicroUsd: "1250000", maxLatencyMs: 60000 },
    metadata: { origin: "zeck-console-playground", family: "text", sandbox: "disposable" },
    createdAt: "2026-09-17T09:00:00Z",
    updatedAt: "2026-09-17T09:00:02Z",
    terminalAt: "2026-09-17T09:00:02Z",
    ...overrides,
  };
}

const executionA = executionOf(RUN_A);
const executionB = executionOf(RUN_B, {
  task: { kind: "summarize", doc: "quarterly-report-01", maxWords: 90 },
  constraints: { maxCostMicroUsd: "900000", maxLatencyMs: 45000 },
  createdAt: "2026-09-17T10:00:00Z",
  terminalAt: "2026-09-17T10:00:07Z",
  metadata: {
    origin: "zeck-console-playground",
    family: "text",
    sandbox: "disposable",
    composed: "1",
    baseline: "<script>baseline()</script>",
    baselineOf: "<img src=x onerror=alert(1)>",
  },
});
const executionC = executionOf(RUN_C, {
  task: { kind: "extract", fields: ["payer", "amount"] },
  metadata: { origin: "zeck-console-playground", family: "structured" },
  terminalAt: null,
});

/** In-flight (non-terminal) runs for the launcher's concurrency gate. */
const inFlightExecutions: Execution[] = INFLIGHT_IDS.map((id) =>
  executionOf(id, { status: "RUNNING", terminalAt: null }),
);

function resultOf(id: string, overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    executionId: id,
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
      { id: `art-${id.slice(-2)}`, digest: "sha256:abcdef0123456789", createdAt: "t" },
    ],
    verification: [
      {
        id: `ver-${id.slice(-2)}`,
        executionId: id,
        criterionId: "cites-sources",
        strategy: "rubric",
        status: "PASS",
        confidence: null,
        evaluator: { kind: "builtin", id: "quickstart-check", version: "1" },
        evidenceRefs: [],
        recordedAt: "2026-09-17T09:00:02Z",
      },
      {
        id: `ver2-${id.slice(-2)}`,
        executionId: id,
        criterionId: "no-hallucination",
        strategy: "rubric",
        status: "FAIL",
        confidence: null,
        evaluator: { kind: "builtin", id: "quickstart-check", version: "1" },
        evidenceRefs: [],
        recordedAt: "2026-09-17T09:00:02Z",
      },
    ],
    warnings: [],
    terminalAt: "2026-09-17T09:00:02Z",
    ...overrides,
  };
}

const resultA = resultOf(RUN_A);
const resultB = resultOf(RUN_B, {
  route: { provider: null, model: null, strategyClass: "deterministic-only", modelCalls: 0 },
  cost: { totalMicroUsd: "120", currency: "usd" },
  usage: { inputTokens: 0, outputTokens: 0 },
  outputArtifacts: [{ id: "art-b1", digest: null, createdAt: "t" }],
  verification: [],
});
const resultC = resultOf(RUN_C, {
  cost: null,
  usage: null,
  route: null,
  outputArtifacts: [],
  verification: [],
});

function planningEventOf(
  id: string,
  sequence: number,
  payload: Record<string, unknown>,
): ExecutionEvent {
  return {
    eventId: `evt-${id.slice(-2)}-${sequence}`,
    executionId: id,
    type: "planning.decision-recorded",
    sequence,
    occurredAt: "2026-09-17T09:00:01Z",
    payload,
  };
}

const decisionPayloadA = {
  decisionId: "decision-a-1",
  plannerVersion: "planner-1.2.0",
  taskProfile: {
    riskLevel: "low",
    qualityTarget: 0.8,
    maxCostMicroUsd: "1250000",
    maxLatencyMs: 60000,
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
    },
    {
      strategyId: "hybrid-openrouter",
      expectedCostMicroUsd: "41250",
      expectedQuality: 0.9,
      expectedLatencyMs: 800,
      verificationStrategy: "rubric",
      modelCalls: 1,
      admissible: true,
      routeRationale: { code: "hybrid-composition", detail: "mixed envelope" },
    },
    {
      strategyId: "single-model-premium",
      expectedCostMicroUsd: "400000",
      expectedQuality: 0.95,
      expectedLatencyMs: 300,
      verificationStrategy: "rubric",
      modelCalls: 1,
      admissible: false,
      inadmissibleReason: "cost ceiling exceeded",
    },
  ],
  selectedStrategyId: "hybrid-openrouter",
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
  recordDigest: "sha256:decision-a",
};

const decisionPayloadB = {
  ...decisionPayloadA,
  decisionId: "decision-b-1",
  selectedStrategyId: "deterministic-echo",
  selectionRationale: "deterministic-first sufficiency: the echo strategy satisfies the task",
  deterministicSufficiency: {
    outcome: "sufficient",
    semanticReasoningRequired: false,
    deterministicQualityEstimate: 0.9,
  },
  candidates: [
    {
      strategyId: 'deterministic-"<script>echo()</script>"',
      expectedCostMicroUsd: "120",
      expectedQuality: 0.9,
      expectedLatencyMs: 40,
      verificationStrategy: "schema",
      modelCalls: 0,
      admissible: true,
      routeRationale: {
        code: "deterministic-sufficient",
        detail: "<img src=x onerror=alert(1)>",
      },
    },
  ],
};

const eventsA: ExecutionEvent[] = [
  {
    eventId: "evt-a-1",
    executionId: RUN_A,
    type: "execution.created",
    sequence: 1,
    occurredAt: "2026-09-17T09:00:00Z",
    payload: { status: "CREATED" },
  },
  planningEventOf(RUN_A, 2, decisionPayloadA),
];
const eventsB: ExecutionEvent[] = [planningEventOf(RUN_B, 1, decisionPayloadB)];
// RUN_C's stream carries NO planning decision (the honest empty state).
const eventsC: ExecutionEvent[] = [
  {
    eventId: "evt-c-1",
    executionId: RUN_C,
    type: "execution.created",
    sequence: 1,
    occurredAt: "2026-09-17T11:00:00Z",
    payload: { status: "CREATED" },
  },
];

const verificationOf = (result: ExecutionResult): readonly VerificationResult[] =>
  result.verification;

const worlds: ReadonlyMap<
  string,
  { execution: Execution; result: ExecutionResult; events: readonly ExecutionEvent[] }
> = new Map([
  [RUN_A, { execution: executionA, result: resultA, events: eventsA }],
  [RUN_B, { execution: executionB, result: resultB, events: eventsB }],
  [RUN_C, { execution: executionC, result: resultC, events: eventsC }],
  ...inFlightExecutions.map(
    (execution) =>
      [
        execution.id,
        {
          execution,
          result: resultOf(execution.id),
          events: [] as readonly ExecutionEvent[],
        },
      ] as const,
  ),
]);

/** The captured creates (the frozen-contract probes ride these). */
const creates: {
  body: Record<string, unknown>;
  idempotencyKey: string | undefined;
}[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname;
  const method = init?.method ?? "GET";
  if (path === "/agents") {
    return json([]);
  }
  if (path === "/executions" && method === "POST") {
    creates.push({
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      idempotencyKey: (init?.headers as Record<string, string> | undefined)?.["idempotency-key"],
    });
    const receipt: ExecutionReceipt = {
      executionId: CREATED_BASE_ID,
      applicationId: APP_ID,
      status: "CREATED",
      createdAt: "2026-09-17T12:00:00Z",
      replayed: false,
      lastEventSequence: 1,
    };
    return json(receipt, 201);
  }
  if (path === "/executions" && method === "POST" && url.searchParams.has("reject")) {
    return json({ code: "POLICY_DENIED", message: "policy refused the create" }, 403);
  }
  const match = /^\/executions\/([^/]+)$/.exec(path);
  if (match !== null && method === "GET") {
    const id = decodeURIComponent(match[1] ?? "");
    const world = worlds.get(id);
    if (world === undefined) {
      return json({ code: "NOT_FOUND", message: "not found" }, 404);
    }
    return json(world.execution);
  }
  const sub = /^\/executions\/([^/]+)\/(results|events|verification)$/.exec(path);
  if (sub !== null && method === "GET") {
    const id = decodeURIComponent(sub[1] ?? "");
    const world = worlds.get(id);
    if (world === undefined) {
      return json({ code: "NOT_FOUND", message: "not found" }, 404);
    }
    if (sub[2] === "results") {
      return json(world.result);
    }
    if (sub[2] === "events") {
      return json(world.events);
    }
    return json(verificationOf(world.result));
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

const RECENTS = `zeck_recent_executions=${RUN_A},${RUN_B},${RUN_C}`;

async function get(path: string, cookie = RECENTS): Promise<Response> {
  return fetch(`${base}${path}`, {
    headers: cookie === "" ? {} : { cookie },
    redirect: "manual",
  });
}

async function postForm(path: string, body: string, cookie = RECENTS): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie === "" ? {} : { cookie }),
    },
    redirect: "manual",
  });
}

const factsA: ExplorerFacts = {
  execution: executionA,
  result: resultA,
  events: eventsA,
  verification: verificationOf(resultA),
};
const factsB: ExplorerFacts = {
  execution: executionB,
  result: resultB,
  events: eventsB,
  verification: verificationOf(resultB),
};
const factsC: ExplorerFacts = {
  execution: executionC,
  result: resultC,
  events: eventsC,
  verification: verificationOf(resultC),
};

// ---------------------------------------------------------------------------
// AC1 — the selection entry points and the side-by-side public facts
// ---------------------------------------------------------------------------

describe("the selection views (AC1)", () => {
  test("the explorer list carries the Compare column and the primary action", async () => {
    const res = await get("/console/executions");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<th scope="col">Compare</th>');
    expect(body).toContain(`href="/console/compare?a=${RUN_A}"`);
    expect(body).toContain('href="/console/compare">Compare runs</a>');
  });

  test("the picker lists the browser's recents and links the FIRST pick as ?a= only", async () => {
    const res = await get("/console/compare");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Select two runs of the same composed workload");
    expect(body).toContain("Compare with this run");
    // The first pick pins run a — the link is ?a=<id> ONLY (never a
    // self-compare a=b link).
    expect(body).toContain(`href="/console/compare?a=${RUN_A}"`);
    expect(body).not.toContain(`?a=${RUN_A}&amp;b=${RUN_A}`);
  });

  test("the picker names the honest listing boundary", async () => {
    const res = await get("/console/compare");
    const body = await res.text();
    expect(body).toContain("No application-scoped execution listing exists");
    expect(body).toContain("GET /executions (listing)");
  });

  test("the pinned picker marks the same-family rows and links ?a=&b=", async () => {
    const res = await get(`/console/compare?a=${RUN_A}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Run a is pinned");
    expect(body).toContain("(same family)");
    expect(body).toContain(`href="/console/compare?a=${RUN_A}&amp;b=${RUN_B}"`);
    expect(body).toContain("(different family — generic axes only)");
  });

  test("the pinned picker prunes a 404 recents row and resets the cookie", async () => {
    const res = await get("/console/compare", `zeck_recent_executions=${RUN_A},gone-id`);
    expect(res.status).toBe(200);
    const setCookie = res.headers.getSetCookie?.() ?? [];
    expect(setCookie.some((value) => value.includes(`zeck_recent_executions=${RUN_A}`))).toBe(true);
  });

  test("the same-run selection renders the honest state", async () => {
    const res = await get(`/console/compare?a=${RUN_A}&b=${RUN_A}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Both selections are the same run");
    expect(body).toContain("needs two DIFFERENT executions");
  });

  test("an unknown run renders the honest 404", async () => {
    const res = await get(`/console/compare?a=${RUN_A}&b=00000000-0000-7000-8000-00000000dead`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("This execution is not visible through the governed API");
  });
});

describe("the side-by-side view (AC1)", () => {
  test("renders every public fact axis, side by side", async () => {
    const res = await get(`/console/compare?a=${RUN_A}&b=${RUN_B}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    for (const axis of [
      "Axis",
      "status",
      "terminal outcome",
      "duration",
      "recorded cost",
      "recorded usage",
      "recorded route",
      "verification outcomes",
      "warnings",
      "output artifacts (references + digests)",
      "workload family",
    ]) {
      expect(body).toContain(axis);
    }
    // The recorded facts themselves (both sides).
    expect(body).toContain("$0.04"); // 41250 micro-USD formatted
    expect(body).toContain("41250"); // raw micro-USD
    expect(body).toContain("2100 in / 340 out tokens");
    expect(body).toContain("hybrid");
    expect(body).toContain("deterministic-only");
    expect(body).toContain("via openrouter");
    expect(body).toContain("1 pass / 1 fail / 0 inconclusive");
    expect(body).toContain("no checks recorded");
    // Duration derived from the recorded timestamps (RUN_B: 7s).
    expect(body).toContain("7s");
    expect(body).toContain("derived from the recorded timestamps");
    // Artifacts render as references + digests only.
    expect(body).toContain(`href="/assets/artifacts/art-${RUN_A.slice(-2)}?executionId=${RUN_A}"`);
    expect(body).toContain("sha256:abcdef0123456789");
    expect(body).toContain("art-b1");
    expect(body).toContain("(no digest recorded)");
  });

  test("renders the composed-task delta with the recorded values (same family)", async () => {
    const res = await get(`/console/compare?a=${RUN_A}&b=${RUN_B}`);
    const body = await res.text();
    expect(body).toContain("The composed task (the recorded values)");
    expect(body).toContain("maxWords");
    expect(body).toContain("same");
    expect(body).toContain("differs");
  });

  test("opening the compare adds both runs to the disclosed recents cookie", async () => {
    const res = await get(`/console/compare?a=${RUN_A}&b=${RUN_B}`, "");
    const setCookie = res.headers.getSetCookie?.() ?? [];
    const cookie = setCookie.find((value) => value.startsWith("zeck_recent_executions="));
    expect(cookie).toBeDefined();
    const value = (cookie ?? "").split(";")[0]?.split("=")[1] ?? "";
    const ids = decodeURIComponent(value).split(",");
    expect(ids).toContain(RUN_A);
    expect(ids).toContain(RUN_B);
  });
});

describe("the composition is a pure projection (AC1, AC7)", () => {
  test("compareSideOf sources every fact from the four public records", () => {
    const side = compareSideOf(factsA);
    expect(side.executionId).toBe(RUN_A);
    expect(side.applicationId).toBe(APP_ID);
    expect(side.family).toBe("text");
    expect(side.costMicroUsd).toBe("41250");
    expect(side.currency).toBe("usd");
    expect(side.inputTokens).toBe(2100);
    expect(side.outputTokens).toBe(340);
    expect(side.strategyClass).toBe("hybrid");
    expect(side.provider).toBe("openrouter");
    expect(side.modelCalls).toBe(1);
    expect(side.verification).toEqual({ pass: 1, fail: 1, inconclusive: 0, total: 2 });
    expect(side.warningsCount).toBe(0);
    expect(side.artifactCount).toBe(1);
    expect(side.lineage).toEqual({
      origin: "zeck-console-playground",
      composed: null,
      baseline: null,
      baselineOf: null,
    });
  });

  test("the planning decision is planningDecisionOf's own read — never re-derived", () => {
    const side = compareSideOf(factsA);
    expect(side.planningDecision).toEqual(planningDecisionOf(eventsA));
    expect(side.planningDecision?.selectedStrategyId).toBe("hybrid-openrouter");
    const bare = compareSideOf(factsC);
    expect(bare.planningDecision).toBeNull();
  });

  test("compareDurationMsOf derives from the recorded timestamps, or null", () => {
    expect(compareDurationMsOf("2026-09-17T09:00:00Z", "2026-09-17T09:00:07Z")).toBe(7000);
    expect(compareDurationMsOf("2026-09-17T09:00:00Z", null)).toBeNull();
    expect(compareDurationMsOf("not-a-date", "2026-09-17T09:00:07Z")).toBeNull();
    expect(compareDurationMsOf("2026-09-17T09:00:07Z", "2026-09-17T09:00:00Z")).toBeNull();
  });

  test("missing facts project as nulls, never guesses", () => {
    const side = compareSideOf(factsC);
    expect(side.costMicroUsd).toBeNull();
    expect(side.currency).toBeNull();
    expect(side.inputTokens).toBeNull();
    expect(side.outputTokens).toBeNull();
    expect(side.strategyClass).toBeNull();
    expect(side.provider).toBeNull();
    expect(side.modelCalls).toBeNull();
    expect(side.durationMs).toBeNull();
    expect(side.verification.total).toBe(0);
    expect(side.artifactCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC2 — the explanation panel renders the recorded rationale verbatim
// ---------------------------------------------------------------------------

describe("the explanation panel (AC2)", () => {
  test("renders each side's recorded planning decision, verbatim", async () => {
    const res = await get(`/console/compare?a=${RUN_A}&b=${RUN_B}`);
    const body = await res.text();
    expect(body).toContain("Why the platform planned each route — the recorded explanation");
    expect(body).toContain("planning.decision-recorded");
    // The candidates with their recorded trade-offs.
    expect(body).toContain("deterministic-echo");
    expect(body).toContain("hybrid-openrouter");
    expect(body).toContain("single-model-premium");
    expect(body).toContain("(selected)");
    expect(body).toContain("(cost ceiling exceeded)");
    expect(body).toContain("41250 micro-USD");
    expect(body).toContain("800 ms");
    // The selection rationale, VERBATIM from the event payload.
    expect(body).toContain(
      "cheap-first cascade selection among 2 admissible candidate(s) satisfying the quality target (INT-004)",
    );
    expect(body).toContain("deterministic-first sufficiency: the echo strategy satisfies the task");
    // The sufficiency outcome + substrate, verbatim.
    expect(body).toContain("insufficient");
    expect(body).toContain("sufficient");
    expect(body).toContain("std-sandbox");
    expect(body).toContain("default sandbox");
  });

  test("a run with no planning decision renders the honest empty state", async () => {
    const res = await get(`/console/compare?a=${RUN_A}&b=${RUN_C}`);
    const body = await res.text();
    expect(body).toContain("No planning decision recorded");
    expect(body).toContain("carries no planning.decision-recorded envelope");
  });
});

// ---------------------------------------------------------------------------
// AC3 — the baseline launcher (frozen create contract or honest unavailable)
// ---------------------------------------------------------------------------

describe("the baseline launcher (AC3)", () => {
  test("the compare view names the missing baseline-planning contract honestly", async () => {
    const res = await get(`/console/compare?a=${RUN_A}&b=${RUN_B}`);
    const body = await res.text();
    expect(body).toContain("True single-model baseline planning semantics");
    expect(body).toContain("metadata.baseline");
    expect(body).toContain("baselinePlanningSemantics");
    expect(body).toContain("(missing contract:");
  });

  test("the launcher re-submits through the frozen create contract with baseline lineage", async () => {
    creates.length = 0;
    const res = await postForm(
      "/console/compare/baseline",
      `executionId=${encodeURIComponent(RUN_A)}&idempotencyKey=dash-test-1`,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/runs/${CREATED_BASE_ID}`);
    expect(creates.length).toBe(1);
    const create = creates[0];
    expect(create?.idempotencyKey).toBe("dash-test-1");
    const body = create?.body ?? {};
    // The frozen create vocabulary ONLY — provider selection is
    // structurally impossible (the SDK's own guard would have thrown).
    for (const forbidden of FORBIDDEN_REQUEST_KEYS) {
      expect(Object.keys(body)).not.toContain(forbidden);
    }
    expect(Object.keys(body).sort()).toEqual(
      ["applicationId", "constraints", "metadata", "task"].sort(),
    );
    // The recorded task crosses back VERBATIM.
    expect(body.task).toEqual(executionA.task);
    // The application scope is the record's own.
    expect(body.applicationId).toBe(APP_ID);
    // The baseline lineage metadata the platform records.
    const metadata = (body.metadata ?? {}) as Record<string, unknown>;
    expect(metadata.baseline).toBe(COMPARE_BASELINE_LINEAGE);
    expect(metadata.baselineOf).toBe(RUN_A);
    // The constraints are the recorded ones, capped at the limits.
    expect(body.constraints).toEqual({ maxCostMicroUsd: "1250000", maxLatencyMs: 60000 });
  });

  test("the launcher caps a source run whose recorded ceilings exceed the sandbox limits", async () => {
    const expensive = executionOf(RUN_B, {
      constraints: { maxCostMicroUsd: "9000000000", maxLatencyMs: 600000 },
      metadata: { origin: "zeck-console-playground", family: "text" },
    });
    const request = buildBaselineRerunRequest({
      execution: expensive,
      result: resultB,
      events: eventsB,
      verification: verificationOf(resultB),
    });
    expect(request.constraints).toEqual({
      maxCostMicroUsd: PLAYGROUND_BUDGET_LIMIT_MICRO_USD,
      maxLatencyMs: PLAYGROUND_LATENCY_LIMIT_MS,
    });
    expect(BASELINE_MISSING_CONTRACT).toContain("baseline planning semantics");
  });

  test("the launcher refuses an incomplete form honestly (422)", async () => {
    const res = await postForm("/console/compare/baseline", "executionId=");
    expect(res.status).toBe(422);
    const body = await res.text();
    expect(body).toContain("The baseline re-run form was incomplete");
  });

  test("the launcher answers the honest 404 for an unknown source run", async () => {
    const res = await postForm(
      "/console/compare/baseline",
      `executionId=00000000-0000-7000-8000-00000000dead&idempotencyKey=k`,
    );
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("not visible through the governed API");
  });

  test("the sandbox concurrency gate refuses a third in-flight run (422)", async () => {
    const cookie = `zeck_recent_executions=${INFLIGHT_IDS.join(",")}`;
    const res = await postForm(
      "/console/compare/baseline",
      `executionId=${encodeURIComponent(RUN_A)}&idempotencyKey=k`,
      cookie,
    );
    expect(res.status).toBe(422);
    const body = await res.text();
    expect(body).toContain("Sandbox concurrency limit reached");
    expect(body).toContain("refuses to submit another");
  });
});

// ---------------------------------------------------------------------------
// AC4 — machine parity: the JSON twin serves the same composed records
// ---------------------------------------------------------------------------

describe("the machine compare view (AC4)", () => {
  test("facts.a and facts.b EQUAL the per-run facts.json compositions (verbatim)", async () => {
    const [compareRes, factsARes, factsBRes] = await Promise.all([
      get(`/console/compare/facts.json?a=${RUN_A}&b=${RUN_B}`),
      get(`/console/executions/${RUN_A}/facts.json`),
      get(`/console/executions/${RUN_B}/facts.json`),
    ]);
    expect(compareRes.status).toBe(200);
    const compare = (await compareRes.json()) as {
      selection: { a: string; b: string };
      sameFamily: boolean;
      facts: { a: unknown; b: unknown };
      compare: {
        runs: { a: { executionId: string }; b: { executionId: string } };
        taskDelta: { comparable: boolean };
      };
      boundaries: { field: string }[];
    };
    const viewA = await factsARes.json();
    const viewB = await factsBRes.json();
    expect(JSON.stringify(compare.facts.a)).toEqual(JSON.stringify(viewA));
    expect(JSON.stringify(compare.facts.b)).toEqual(JSON.stringify(viewB));
    expect(compare.selection).toEqual({ a: RUN_A, b: RUN_B });
    expect(compare.sameFamily).toBe(true);
    expect(compare.compare.runs.a.executionId).toBe(RUN_A);
    expect(compare.compare.runs.b.executionId).toBe(RUN_B);
    expect(compare.compare.taskDelta.comparable).toBe(true);
    expect(compare.boundaries.some((boundary) => boundary.field === "statisticalComparison")).toBe(
      true,
    );
  });

  test("the machine view states the projection doctrine (never a second comparator)", async () => {
    const res = await get(`/console/compare/facts.json?a=${RUN_A}&b=${RUN_B}`);
    const compare = (await res.json()) as { authority: { note: string } };
    expect(compare.authority.note).toContain("never a second comparator");
    expect(compare.authority.note).toContain("benchmarks/validation");
  });

  test("missing selections answer the honest JSON 400", async () => {
    const missing = await get("/console/compare/facts.json");
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toBe("BAD_REQUEST");
    const oneSide = await get(`/console/compare/facts.json?a=${RUN_A}`);
    expect(oneSide.status).toBe(400);
  });

  test("the same run twice answers the honest JSON 400", async () => {
    const res = await get(`/console/compare/facts.json?a=${RUN_A}&b=${RUN_A}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("BAD_REQUEST");
    expect(body.message).toContain("two DIFFERENT execution ids");
  });

  test("an unknown run answers the honest JSON 404", async () => {
    const res = await get(
      `/console/compare/facts.json?a=${RUN_A}&b=00000000-0000-7000-8000-00000000dead`,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("NOT_FOUND");
    expect(body.message).toContain("nothing to compare");
  });
});

// ---------------------------------------------------------------------------
// AC7 — honest boundaries (different families, universal doctrine)
// ---------------------------------------------------------------------------

describe("honest boundaries (AC7)", () => {
  test("different workload families compare on the generic axes only, and say so", async () => {
    const res = await get(`/console/compare?a=${RUN_A}&b=${RUN_C}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Different workload families — generic axes only");
    expect(body).toContain('family "text"');
    expect(body).toContain('family "structured"');
    expect(body).toContain("differentWorkloadFamilies");
    // The composed-task delta is NOT rendered side by side — the honest
    // note replaces the table.
    expect(body).toContain(
      "the composed task shapes are not comparable across families and are not rendered side by side",
    );
    expect(body).not.toContain('<th scope="col">Run b</th>\n    <td class="mono">{');
  });

  test("the machine twin carries the generic-axes-only flag", async () => {
    const res = await get(`/console/compare/facts.json?a=${RUN_A}&b=${RUN_C}`);
    const compare = (await res.json()) as {
      sameFamily: boolean;
      genericAxesOnly: boolean;
      compare: { taskDelta: { comparable: boolean; note: string } };
      boundaries: { field: string }[];
    };
    expect(compare.sameFamily).toBe(false);
    expect(compare.genericAxesOnly).toBe(true);
    expect(compare.compare.taskDelta.comparable).toBe(false);
    expect(compare.compare.taskDelta.note).toContain("generic axes");
    expect(compare.boundaries.some((b) => b.field === "differentWorkloadFamilies")).toBe(true);
  });

  test("the universal boundaries each name their missing contract", async () => {
    const composition = composeCompare(factsA, factsB);
    const fields = composition.boundaries.map((boundary) => boundary.field);
    expect(fields).toContain("realizedQualityScores");
    expect(fields).toContain("baselinePlanningSemantics");
    expect(fields).toContain("statisticalComparison");
    expect(fields).toContain("perStepCostBreakdown");
    const quality = composition.boundaries.find((b) => b.field === "realizedQualityScores");
    expect(quality?.missingContract).toBeDefined();
    const baseline = composition.boundaries.find((b) => b.field === "baselinePlanningSemantics");
    expect(baseline?.missingContract).toBe(BASELINE_MISSING_CONTRACT);
  });

  test("missing recorded facts render as honest unavailable cells, never guesses", async () => {
    const res = await get(`/console/compare?a=${RUN_A}&b=${RUN_C}`);
    const body = await res.text();
    expect(body).toContain("not settled yet");
    expect(body).toContain("not recorded");
    expect(body).toContain("none recorded");
    expect(body).toContain("not terminal yet");
    expect(body).toContain("no route recorded");
  });
});

// ---------------------------------------------------------------------------
// Hostile-value probes on every new interpolation path
// ---------------------------------------------------------------------------

describe("hostile-value probes", () => {
  test("a markup-carrying execution id never renders unescaped (404 view)", async () => {
    const hostile = encodeURIComponent(HOSTILE_ID);
    const res = await get(`/console/compare?a=${hostile}&b=${RUN_A}`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain("<script>a()</script>");
    expect(body).toContain("&lt;script&gt;a()&lt;/script&gt;");
  });

  test("hostile lineage metadata and strategy fields never render unescaped (200 view)", async () => {
    const res = await get(`/console/compare?a=${RUN_A}&b=${RUN_B}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("<script>baseline()</script>");
    expect(body).not.toContain("<img src=x onerror=alert(1)>");
    expect(body).not.toContain("<script>echo()</script>");
    // The hostile lineage renders ESCAPED; the launcher card names the
    // baseline lineage vocabulary it stamps.
    expect(body).toContain("baseline lineage &lt;script&gt;baseline()&lt;/script&gt;");
    expect(body).toContain("metadata.baseline = single-model-baseline-requested");
  });

  test("hostile task values render escaped in the delta; the machine view carries them as data", async () => {
    const hostileExecution = executionOf(RUN_B, {
      task: { kind: "summarize", doc: "<script>task()</script>", maxWords: 60 },
      metadata: { origin: "zeck-console-playground", family: "text" },
    });
    const composition = composeCompare(factsA, {
      execution: hostileExecution,
      result: resultB,
      events: eventsB,
      verification: verificationOf(resultB),
    });
    const htmlSide = composition.taskDelta.fields.find((field) => field.key === "doc");
    expect(htmlSide?.b).toBe(JSON.stringify("<script>task()</script>"));
    const machine = JSON.parse(
      JSON.stringify({
        facts: composition.facts.b,
        runs: composition.sides.b,
      }),
    ) as { facts: { execution: { task: Record<string, unknown> } } };
    expect(machine.facts.execution.task.doc).toBe("<script>task()</script>");
  });

  test("a hostile family value cannot inject: the catalog gate renders the honest unrecorded marker", () => {
    const hostileC = executionOf(RUN_C, {
      task: { kind: "extract" },
      metadata: { family: 'structured"<script>f()</script>' },
    });
    const composition = composeCompare(factsA, {
      execution: hostileC,
      result: resultC,
      events: eventsC,
      verification: verificationOf(resultC),
    });
    // explorerFamilyOf accepts only catalog families — a hostile metadata
    // value falls back to the honest "unrecorded" marker, never the
    // injected string (the boundary statement then renders that marker).
    expect(composition.families.b).toBe("unrecorded");
    expect(composition.sameFamily).toBe(false);
    expect(composition.genericAxesOnly).toBe(true);
  });
});
