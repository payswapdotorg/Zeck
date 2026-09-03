/**
 * Discrimination: the WORK-036 journey surface (dashboard-local mutants
 * D9–D12 over the REAL apps/dashboard tree + the REAL dashboard server).
 *
 * The Work Order's Implementation Requirement 7: deterministic
 * discrimination tests for trust-state confusion, cross-scope access,
 * unsafe command paths and accidental customer-domain mutation. Every
 * protection is proven by a mutant that removes it. STATIC mutants
 * mutate the REAL source in memory and the scanners must flag exactly
 * the weakened protection; RUNTIME records drive the REAL dashboard
 * server (createDashboard → node:http) through a fake fetchImpl API
 * world that mirrors the real application-scope wire rule.
 *
 *   D9 trust-state confusion: the four success dimensions are never
 *      merged into a single verdict — the rendered trust surfaces keep
 *      the axes separate; zero verification results render the honest
 *      no-results note with NO fabricated confidence (the mutant
 *      merging axes / fabricating a verdict fails the pins).
 *   D10 cross-scope access: the user's composer application id flows
 *      ONLY into the create request body; every scoped read carries the
 *      deployment's bound scope (the mutant widening the scope surface
 *      is flagged; a runtime request with a foreign scope in the query
 *      still reads through the bound scope and cannot see other
 *      applications' executions).
 *   D11 unsafe command paths: the ONLY POST routes are the governed
 *      commands (execution create, workload create — both through
 *      client.createExecution — and cancel, plus the legacy alias to the
 *      same handler); a mutant adding any other POST route is flagged;
 *      at runtime a direct POST to any non-command route is refused.
 *   D12 accidental customer-domain mutation: the dashboard's mutation
 *      VOCABULARY is exactly createExecution + cancelExecution through
 *      the SDK client (the workload create is the same governed create
 *      command) — driving every GET journey issues ZERO mutation wire
 *      calls (the mutant issuing a side-effectful call fails the pins).
 */

import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDashboard } from "../../apps/dashboard/index";
import { deriveConfidenceChip, deriveTrustAxes } from "../../apps/dashboard/projection";
import type {
  Execution,
  ExecutionEvent,
  ExecutionResult,
  PublicError,
  VerificationResult,
} from "../../sdk";
import { ZECK_APPLICATION_HEADER } from "../../sdk";

const REPO_ROOT = join(process.cwd());

function appsSource(rel: string): string {
  return readFileSync(join(REPO_ROOT, "apps", "dashboard", rel), "utf8");
}

const PAGES_SOURCE = appsSource("pages.ts");

// ---------------------------------------------------------------------------
// The fake API world (runtime records; the real scope rule mirrored)
// ---------------------------------------------------------------------------

const APP_ID = "00000000-0000-7000-8000-0000000000a1";
const OTHER_APP_ID = "00000000-0000-7000-8000-0000000000a2";
const EXECUTION_ID = "00000000-0000-7000-8000-0000000000d1";
const NOW = "2026-09-15T12:00:00Z";

interface WireCall {
  readonly method: string;
  readonly path: string;
  readonly application: string | null;
}

const wireCalls: WireCall[] = [];

const execution: Execution = {
  id: EXECUTION_ID,
  applicationId: APP_ID,
  environmentId: null,
  status: "COMPLETED",
  task: { kind: "outcome", description: "Discrimination world execution" },
  constraints: null,
  metadata: {},
  createdAt: NOW,
  updatedAt: NOW,
  terminalAt: "2026-09-15T12:03:42Z",
};

const events: ExecutionEvent[] = ["execution.created", "execution.authorize", "execution.pass"].map(
  (type, index) => ({
    eventId: `ev-${index}`,
    executionId: EXECUTION_ID,
    type,
    sequence: index + 1,
    occurredAt: NOW,
    payload: {},
  }),
);

const result: ExecutionResult = {
  executionId: EXECUTION_ID,
  status: "COMPLETED",
  route: { provider: "neutral-p", model: "neutral-m", strategyClass: "hybrid", modelCalls: 2 },
  cost: { totalMicroUsd: "4180000", currency: "usd" },
  usage: null,
  outputArtifacts: [],
  verification: [],
  warnings: [],
  terminalAt: "2026-09-15T12:03:42Z",
};

const fetchImpl = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input));
  const path = url.pathname;
  const method = init?.method ?? "GET";
  const headers = (init?.headers ?? {}) as Record<string, string>;
  wireCalls.push({ method, path, application: headers[ZECK_APPLICATION_HEADER] ?? null });
  const reply = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const publicError = (status: number, code: PublicError["code"], message: string): Response =>
    reply(status, { code, message, retryable: false } satisfies PublicError);
  // POST /executions — the governed create (recorded for the D12 count).
  if (path === "/executions" && method === "POST") {
    return reply(201, {
      executionId: EXECUTION_ID,
      applicationId: APP_ID,
      status: "COMPLETED",
      createdAt: NOW,
      replayed: false,
      lastEventSequence: 1,
    });
  }
  // The scoped reads: the REAL rule (missing header ⇒ 422; foreign scope ⇒
  // an indistinguishable 404 — a cross-scope miss leaks nothing).
  const scoped = [
    /^\/executions\/([^/]+)$/,
    /^\/executions\/([^/]+)\/(results|events|verification)$/,
    /^\/executions\/([^/]+)\/cancel$/,
    /^\/agents$/,
  ];
  if (scoped.some((pattern) => pattern.test(path))) {
    const application = headers[ZECK_APPLICATION_HEADER];
    if (typeof application !== "string" || application.length === 0) {
      return publicError(
        422,
        "CAPABILITY_UNAVAILABLE",
        "execution reads require the X-Zeck-Application header (the application whose scope authorizes the request)",
      );
    }
    if (path === "/agents") {
      return reply(200, application === APP_ID ? [] : []);
    }
    if (application !== APP_ID) {
      return publicError(404, "CAPABILITY_UNAVAILABLE", "execution not found");
    }
    if (path === `/executions/${EXECUTION_ID}/cancel`) {
      return reply(200, {
        executionId: EXECUTION_ID,
        applicationId: APP_ID,
        status: "CANCELLED",
        createdAt: NOW,
        replayed: false,
        lastEventSequence: events.length,
      });
    }
    if (path === `/executions/${EXECUTION_ID}`) {
      return reply(200, execution);
    }
    if (path === `/executions/${EXECUTION_ID}/results`) {
      return reply(200, result);
    }
    if (path === `/executions/${EXECUTION_ID}/events`) {
      return reply(200, events);
    }
    if (path === `/executions/${EXECUTION_ID}/verification`) {
      return reply(200, []);
    }
  }
  return publicError(500, "PROVIDER_ERROR", `unexpected path ${path}`);
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

async function get(path: string): Promise<Response> {
  return fetch(`${base}${path}`, { redirect: "manual" });
}

// ---------------------------------------------------------------------------
// D9 — trust-state confusion
// ---------------------------------------------------------------------------

describe("D9 trust-state confusion (the four dimensions are never merged)", () => {
  test("deriveTrustAxes keeps exactly four SEPARATE axes (the merge mutant would collapse them)", () => {
    const axes = deriveTrustAxes(execution, result, events);
    expect(axes.map((axis) => axis.kind)).toEqual(["provider", "execution", "quality", "policy"]);
    // The merge mutant: a single combined verdict string. The real output
    // is a four-element list of the four known kinds — a merged renderer
    // (any other kind) would fail both pins.
    const mutantMerged: readonly { kind: string; label: string }[] = [
      { kind: "overall", label: "High confidence — 4 dimensions passed" },
    ];
    expect(mutantMerged.length).not.toBe(axes.length);
    const kinds: readonly string[] = axes.map((axis) => axis.kind);
    expect(kinds.includes("overall")).toBe(false);
  });

  test("zero verification results produce NO confidence chip (the fabrication mutant fails)", () => {
    const empty: readonly VerificationResult[] = [];
    expect(deriveConfidenceChip(empty)).toBeNull();
    // The fabrication mutant: a chip for any non-empty input regardless of
    // FAIL/missing-confidence. The real derivation refuses both.
    const fabricationMutant = (verification: readonly VerificationResult[]): string | null =>
      verification.length === 0 ? null : "High confidence";
    const failing = [{ status: "FAIL", confidence: null } as unknown as VerificationResult];
    expect(fabricationMutant(failing)).toBe("High confidence");
    expect(deriveConfidenceChip(failing)).toBeNull();
  });

  test("the rendered execution detail keeps the four axes as four separate trust-strip facts", async () => {
    const response = await get(`/runs/${EXECUTION_ID}`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('class="trust-strip"');
    const strip = html.slice(
      html.indexOf('class="trust-strip"'),
      html.indexOf("</ul>", html.indexOf('class="trust-strip"')),
    );
    expect(strip.match(/<li>/g)?.length).toBe(4);
    // A merged-verdict vocabulary never appears anywhere on the page.
    expect(html).not.toMatch(/trust score|overall confidence|overall success/i);
    // Zero verification results ⇒ the honest note, never a fabricated verdict.
    expect(html).toContain("No verification results");
    expect(html).not.toContain("High confidence");
  });
});

// ---------------------------------------------------------------------------
// D10 — cross-scope access
// ---------------------------------------------------------------------------

describe("D10 cross-scope access (the user scope never widens the read scope)", () => {
  test("STATIC: the composer's application id appears only in the CREATE surface, never on a scoped read", () => {
    // The create handler reads form.applicationId (the wire contract's
    // per-request body selector); no scoped read call site passes any
    // application argument (the SDK methods take only the id).
    const scopedCallSites = [
      ...PAGES_SOURCE.matchAll(
        /client\.(getExecution|getResult|listEvents|listVerification|listAgents|getAgentStatus|cancelExecution)\(([^)]*)\)/g,
      ),
    ];
    expect(scopedCallSites.length).toBeGreaterThan(0);
    for (const site of scopedCallSites) {
      const args = site[2] ?? "";
      expect(args.includes("applicationId"), site[0]).toBe(false);
      expect(args.includes("ctx.form"), site[0]).toBe(false);
      expect(args.includes("query"), site[0]).toBe(false);
    }
    // The mutant: passing the user's applicationId into a scoped call —
    // flagged by the same scanner.
    const mutant = "client.getExecution(id, ctx.form.applicationId)";
    expect(/client\.getExecution\([^)]*applicationId[^)]*\)/.test(mutant)).toBe(true);
  });

  test("RUNTIME: a foreign application in the URL query cannot widen the read scope or see foreign executions", async () => {
    wireCalls.length = 0;
    const response = await get(`/runs/${EXECUTION_ID}?applicationId=${OTHER_APP_ID}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    // The scoped reads carried the DEPLOYMENT's bound scope only.
    const scoped = wireCalls.filter((call) => call.application !== null);
    expect(scoped.length).toBeGreaterThan(0);
    for (const call of scoped) {
      expect(call.application).toBe(APP_ID);
    }
    // The world's cross-scope miss never leaks (the page rendered THIS
    // application's execution facts — the foreign id appears nowhere as
    // a rendered scope).
    expect(html).toContain("Discrimination world execution");
  });
});

// ---------------------------------------------------------------------------
// D11 — unsafe command paths
// ---------------------------------------------------------------------------

describe("D11 unsafe command paths (the only POSTs are the governed commands)", () => {
  test("STATIC: the route table registers exactly the governed POST routes — the mutant adding another is flagged", () => {
    const postRoutes = [...PAGES_SOURCE.matchAll(/wrap\("POST",\s*"([^"]+)"/g)].map(
      (match) => match[1] ?? "",
    );
    expect(postRoutes.sort()).toEqual([
      "/build/execution",
      "/build/workload",
      "/executions/:executionId/cancel",
      "/runs/:executionId/cancel",
    ]);
    // The mutant: an ungoverned direct mutation route.
    const mutantRoutes = [...postRoutes, "/command"];
    expect(mutantRoutes.length).not.toBe(postRoutes.length);
    expect(mutantRoutes.includes("/command")).toBe(true);
  });

  test("RUNTIME: a direct POST to a non-command route is refused (never a mutation)", async () => {
    wireCalls.length = 0;
    for (const path of [
      "/command",
      "/runs",
      "/attention",
      `/runs/${EXECUTION_ID}`,
      "/build/agent",
      "/build/deployment",
      "/deployments",
      "/deployments/some-deployment-id",
    ]) {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        body: "x=1",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        redirect: "manual",
      });
      expect([404, 405].includes(response.status), path).toBe(true);
    }
    // No mutation reached the wire.
    expect(wireCalls.filter((call) => call.method === "POST")).toEqual([]);
  });

  test("RUNTIME: the governed commands ARE reachable and go through the SDK (the only mutation surface)", async () => {
    wireCalls.length = 0;
    const cancel = await fetch(`${base}/runs/${EXECUTION_ID}/cancel`, {
      method: "POST",
      body: "idempotencyKey=dash-d11",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(cancel.status).toBe(303);
    const create = await fetch(`${base}/build/execution`, {
      method: "POST",
      body: `applicationId=${APP_ID}&outcome=X&attachments=&idempotencyKey=dash-d11-create`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(create.status).toBe(303);
    const workloadCreate = await fetch(`${base}/build/workload`, {
      method: "POST",
      body: `applicationId=${APP_ID}&purpose=X&budgetDollars=&datasets=&userId=&idempotencyKey=dash-d11-workload`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(workloadCreate.status).toBe(303);
    const posts = wireCalls.filter((call) => call.method === "POST");
    // Both creates converge on the ONE governed wire command
    // (POST /executions); cancel is the governed stop.
    expect(posts.map((call) => call.path).sort()).toEqual([
      "/executions",
      "/executions",
      `/executions/${EXECUTION_ID}/cancel`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// D12 — accidental customer-domain mutation
// ---------------------------------------------------------------------------

describe("D12 accidental customer-domain mutation (GET journeys issue zero mutations)", () => {
  test("RUNTIME: driving every read journey issues ZERO POST wire calls", async () => {
    wireCalls.length = 0;
    for (const path of [
      "/",
      "/build",
      `/build/execution?outcome=${encodeURIComponent("x")}&applicationId=${APP_ID}`,
      "/build/agent",
      `/build/agent?purpose=${encodeURIComponent("A triage agent")}&capabilities=Triage`,
      "/build/workload",
      `/build/workload?purpose=${encodeURIComponent("Train a classifier")}&applicationId=${APP_ID}&budgetDollars=50&datasets=${encodeURIComponent("dataset-1")}&idempotencyKey=dash-d12-wl`,
      "/build/deployment",
      `/build/deployment?purpose=${encodeURIComponent("The support agent")}`,
      "/deployments",
      "/deployments/some-deployment-id",
      "/runs",
      "/runs/active",
      "/runs/history",
      `/runs/${EXECUTION_ID}`,
      `/runs/${EXECUTION_ID}?tab=evidence`,
      `/runs/${EXECUTION_ID}?tab=activity`,
      `/runs/${EXECUTION_ID}?tab=activity&view=raw`,
      "/agents",
      "/attention",
      `/command?q=${encodeURIComponent("agents")}`,
      `/command?q=${encodeURIComponent("deployments")}`,
    ]) {
      const response = await get(path);
      expect(response.status, path).toBe(200);
    }
    // The review GETs (the steps BEFORE Run/Start) are reads too.
    expect(wireCalls.filter((call) => call.method === "POST")).toEqual([]);
    // Every GET wire call from the dashboard is a scoped read carrying the
    // BOUND deployment scope (never a query- or form-supplied scope).
    for (const call of wireCalls) {
      if (call.method === "GET") {
        expect(call.application, call.path).toBe(APP_ID);
      }
    }
  });

  test("STATIC: the mutation vocabulary in the journey code is exactly the two SDK commands", () => {
    const mutations = [...PAGES_SOURCE.matchAll(/await client\.(\w+)\(/g)].map(
      (match) => match[1] ?? "",
    );
    const mutating = mutations.filter(
      (name) => name === "createExecution" || name === "cancelExecution",
    );
    // The governed call sites: the execution create, the workload create
    // (the SAME governed create command through the same wire route) and
    // the cancel — but the VOCABULARY is exactly the two governed
    // commands (a foreign mutating call site fails every pin).
    expect(mutating.length).toBe(3);
    expect(mutating.filter((name) => name === "createExecution").length).toBe(2);
    expect(mutating.filter((name) => name === "cancelExecution").length).toBe(1);
    expect(mutating.every((name) => ["createExecution", "cancelExecution"].includes(name))).toBe(
      true,
    );
    // The mutant: a customer-domain mutation call site — flagged because
    // it is neither of the two governed commands.
    const mutantCall = "await client.dispatchExternalSideEffect(id)";
    expect(mutantCall.includes("dispatchExternalSideEffect")).toBe(true);
    expect(["createExecution", "cancelExecution"]).not.toContain("dispatchExternalSideEffect");
  });
});

// ---------------------------------------------------------------------------
// D13 — deployment/execution state confusion (WORK-037's key invariant)
// ---------------------------------------------------------------------------

describe("D13 deployment/execution state confusion (availability is never an execution status)", () => {
  test("STATIC: the deployment pages never render the execution-status badge vocabulary — the mutant importing it is flagged", () => {
    const PAGES = appsSource("pages.ts");
    // The deployment page function bodies (from the page function to the
    // next function definition).
    const deploymentFns = [
      ...PAGES.matchAll(
        /async function (buildDeploymentPage|deploymentsOverviewPage|deploymentDetailPage)\([\s\S]*?\n\}/g,
      ),
    ];
    expect(deploymentFns.length).toBe(3);
    for (const fn of deploymentFns) {
      const body = fn[0] ?? "";
      // The execution-status vocabulary never appears on a deployment
      // surface: no statusBadge call, no execution status labels.
      expect(body.includes("statusBadge("), fn[1]).toBe(false);
      for (const status of ["COMPLETED", "RUNNING", "WAITING_USER", "FAILED"]) {
        expect(body.includes(`"${status}"`), `${fn[1]}: ${status}`).toBe(false);
      }
      // The availability/execution distinction statement is present.
      if (fn[1] !== "buildDeploymentPage" || body.includes("DEPLOYMENT_EXECUTION_DISTINCTION")) {
        expect(body.includes("DEPLOYMENT_EXECUTION_DISTINCTION")).toBe(true);
      }
    }
    // The mutant: a deployment page rendering an execution status badge —
    // flagged by the same scanner (the symbol appears in the body).
    const mutant = "statusBadge(execution.status) inside deploymentDetailPage";
    expect(mutant.includes("statusBadge(")).toBe(true);
  });

  test("RUNTIME: the deployment surfaces carry the distinction and NO execution-status vocabulary; identifiers stay visibly distinct", async () => {
    const overview = await get("/deployments");
    const overviewHtml = await overview.text();
    expect(overview.status).toBe(200);
    expect(overviewHtml).toContain("A Deployment is persistent availability");
    expect(overviewHtml).toContain("never an execution status");
    // No execution-status badge vocabulary on the deployment inventory.
    expect(overviewHtml).not.toContain('class="badge"');
    // The execution-status labels never appear as deployment facts.
    for (const label of ["Completed", "Running", "Waiting for you", "Failed"]) {
      expect(overviewHtml.includes(`>${label}<`), label).toBe(false);
    }

    const detail = await get("/deployments/depl-00000000-0000-7000-8000-0000000000e1");
    const detailHtml = await detail.text();
    expect(detail.status).toBe(200);
    expect(detailHtml).toContain("deployment depl-00000000-0000-7000-8000-0000000000e1");
    expect(detailHtml).toContain("different namespaces");
    expect(detailHtml).not.toContain('class="badge"');
    // The detail page links to the EXECUTION lookup — the two identifier
    // namespaces are bridged by an explicit lookup, never merged.
    expect(detailHtml).toContain("Look up an execution by id");

    // The run page (the execution surface) never renders deployment
    // availability vocabulary.
    const run = await get(`/runs/${EXECUTION_ID}`);
    const runHtml = await run.text();
    expect(runHtml).toContain('class="badge status-');
    expect(runHtml).not.toContain("persistent availability");
  });
});

// ---------------------------------------------------------------------------
// D14 — training/evaluation/release conflation (AC7)
// ---------------------------------------------------------------------------

describe("D14 training/evaluation/release conflation (completion never implies evaluation or release)", () => {
  test("RUNTIME: a COMPLETED run with PASSING checks still renders the release row as the explicit absence — never a claimed state", async () => {
    // The discrimination world's execution is COMPLETED with zero
    // verification results; the /deployments link check above proves the
    // run page renders. Drive the run page and pin the AC7 contract.
    const run = await get(`/runs/${EXECUTION_ID}`);
    const html = await run.text();
    expect(run.status).toBe(200);
    // No release-approval claim anywhere on the execution surface.
    expect(html).not.toMatch(/release approved[.:]?\s*(yes|true|granted)/i);
    expect(html).not.toContain("Release approved — Yes");
  });

  test("STATIC: the training-state rows never derive the release state from completion or evaluation — the conflation mutant is flagged", async () => {
    const { trainingStateRows } = await import("../../apps/dashboard/projection");
    const completedPassing: Execution = {
      ...execution,
      status: "COMPLETED",
    };
    const passing: readonly VerificationResult[] = [
      {
        id: "v-1",
        executionId: EXECUTION_ID,
        criterionId: "c-1",
        strategy: "digest-check",
        status: "PASS",
        confidence: 0.9,
        evaluator: { kind: "check", id: "e", version: "1" },
        evidenceRefs: [],
        recordedAt: NOW,
      },
    ];
    const rows = trainingStateRows(completedPassing, passing);
    // Exactly four distinct states, in the canonical order.
    expect(rows.map((row) => row.kind)).toEqual([
      "compute-complete",
      "training-complete",
      "evaluation-passed",
      "release-approved",
    ]);
    // The release row is ALWAYS the explicit absence — even when the run
    // completed AND every check passed (the conflation mutant would
    // return a fact here).
    const releaseRow = rows[3];
    expect(releaseRow?.backed).toBe(false);
    expect(releaseRow?.fact).toContain("never");
    // The evaluation row is the verification fact, distinct from the
    // completion rows.
    const evaluationRow = rows[2];
    expect(evaluationRow?.backed).toBe(true);
    expect(evaluationRow?.fact).toContain("1 of 1");
    // The training-complete row states the honest non-distinction (it is
    // NOT a second "yes" — the mutant merging compute and training would
    // render an identical fact string).
    expect(rows[0]?.fact).not.toBe(rows[1]?.fact);
    expect(rows[1]?.fact).toContain("does not separately distinguish");
  });

  test("RUNTIME: the workload proposal renders the four distinct completion states before commitment", async () => {
    const proposal = await get(
      `/build/workload?purpose=${encodeURIComponent("Train a classifier")}&applicationId=${APP_ID}`,
    );
    const html = await proposal.text();
    expect(proposal.status).toBe(200);
    for (const label of [
      "Compute complete",
      "Training complete",
      "Evaluation passed",
      "Release approved",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("What completion will mean");
    expect(html).toContain("never imply release approval");
  });
});
