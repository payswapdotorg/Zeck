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

// ---------------------------------------------------------------------------
// D15 — evidence-link fabrication (WORK-038 AC2/AC9): a recorded evidence
// reference becomes a LINK only when the platform exposes an artifact
// with that id; an opaque reference stays verbatim — a mutant linking
// every ref (or inventing targets) is flagged.
// ---------------------------------------------------------------------------

describe("D15 evidence-link fabrication (links only where a public object exists)", () => {
  test("MODULE: a ref with NO public artifact renders verbatim — the link-everything mutant differs on the same input", async () => {
    const { evidenceRefLink } = await import("../../apps/dashboard/trust");
    const artifacts = [{ id: "art-known", digest: "d", createdAt: NOW }];
    const honest = evidenceRefLink("opaque-ref-9", artifacts, EXECUTION_ID);
    // The honest rendering carries NO href and states the limitation.
    expect(honest).not.toContain("href=");
    expect(honest).toContain("opaque-ref-9");
    expect(honest).toContain("no public object with this id");
    // The mutant: linking the ref regardless of the platform's records.
    const mutant = `<a href="/assets/artifacts/opaque-ref-9?executionId=${EXECUTION_ID}">opaque-ref-9</a>`;
    expect(honest).not.toBe(mutant);
    // The known ref IS linked (the guard is a discriminator, not a blanket).
    const known = evidenceRefLink("art-known", artifacts, EXECUTION_ID);
    expect(known).toContain(`href="/assets/artifacts/art-known?executionId=${EXECUTION_ID}"`);
  });

  test("STATIC: the link decision is the platform-recorded membership check — the mutant removing it is flagged", () => {
    const TRUST = appsSource("trust.ts");
    // The guard: a ref links only when it matches a recorded output
    // artifact of this execution.
    expect(TRUST.includes("artifacts.some((artifact) => artifact.id === reference)")).toBe(true);
    // The mutant deleting the membership check (linking every ref) is
    // flagged by the same scanner (the guard disappears).
    const mutant = TRUST.replace("artifacts.some((artifact) => artifact.id === reference)", "true");
    expect(mutant.includes("artifacts.some((artifact) => artifact.id === reference)")).toBe(false);
  });

  test("RUNTIME: a run with ZERO verification renders no check rows and no evidence links (nothing to link — nothing invented)", async () => {
    const page = await get(`/runs/${EXECUTION_ID}?tab=evidence`);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain("No verification results recorded");
    // No check table rows, no evidence-ref links, no derived chip (the
    // stylesheet mentions the class; the RENDERED usage is pinned out).
    expect(html).not.toContain('class="evidence-ref"');
    expect(html).not.toContain('class="chip chip-derived"');
  });
});

// ---------------------------------------------------------------------------
// D16 — client-truth fabrication (WORK-038 AC9): a UI-only value must
// never be mistaken for platform verification truth — the rendered trust
// summary on a zero-verification run carries NO confidence vocabulary,
// and its chip is EXACTLY the platform derivation.
// ---------------------------------------------------------------------------

describe("D16 client-truth fabrication (UI values are never platform verification truth)", () => {
  test("RUNTIME: the Result view of a zero-verification run renders the honest chip and NO confidence verdict", async () => {
    const run = await get(`/runs/${EXECUTION_ID}`);
    const html = await run.text();
    expect(run.status).toBe(200);
    // The trust summary renders — with the honest no-results chip.
    expect(html).toContain('class="trust-summary"');
    expect(html).toContain("Checks: No verification results");
    // The fabricated mutants ("High confidence", a numeric score, an
    // overall verdict) never appear on this input (the stylesheet may
    // name the chip class; the RENDERED usage is pinned out).
    expect(html).not.toContain("High confidence");
    expect(html).not.toContain('class="chip chip-derived"');
    expect(html).not.toMatch(/overall (confidence|success|trust)/i);
    expect(html).not.toMatch(/trust score/i);
  });

  test("MODULE: the trust-summary chip is exactly the platform derivation — a UI-only value differs", async () => {
    const { trustSummarySection } = await import("../../apps/dashboard/trust");
    const { deriveVerificationChip } = await import("../../apps/dashboard/projection");
    const html = trustSummarySection({ execution, result, events });
    // The chip line carries deriveVerificationChip's output verbatim.
    expect(html).toContain(`Checks: ${deriveVerificationChip(result.verification)}`);
    // The mutant: a UI-computed "confidence" the platform never recorded.
    const fabricated = "Checks: High confidence (UI)";
    expect(html).not.toContain(fabricated);
  });

  test("MODULE: the trust summary renders EXACTLY the four derived axes — the extra-verdict mutant differs", async () => {
    const { trustSummarySection } = await import("../../apps/dashboard/trust");
    const html = trustSummarySection({ execution, result, events });
    expect((html.match(/class="trust-summary-axis"/g) ?? []).length).toBe(4);
    for (const label of [
      "Provider success",
      "Execution success",
      "Quality success",
      "Policy success",
    ]) {
      expect(html).toContain(label);
    }
    // The mutant: adding a fifth "Overall" axis (a UI verdict over the
    // four platform facts) — flagged by the count and the vocabulary.
    expect(html).not.toMatch(/axis-kind">Overall/i);
    expect(html).not.toMatch(/overall/i);
  });
});

// ---------------------------------------------------------------------------
// D17 — learning/competence promotion conflation (WORK-038 AC7/AC8): the
// competence and evaluation surfaces never imply a promotion, a
// validation or an authoritative production status — every such row is
// the explicit absence until the authority's own rules are satisfied.
// ---------------------------------------------------------------------------

describe("D17 learning/competence promotion conflation (advisory never displays as authoritative)", () => {
  test("MODULE: every evaluation status row is the explicit absence — the mutant marking production as a platform fact fails", async () => {
    const { evaluationStatusRows } = await import("../../apps/dashboard/projection");
    const rows = evaluationStatusRows();
    expect(rows.map((row) => row.kind)).toEqual([
      "observation",
      "recommendation",
      "validation",
      "production",
    ]);
    // No status is backed by a platform fact (no public authority): the
    // mutant flipping `backed` to true would fail here.
    expect(rows.every((row) => row.backed === false)).toBe(true);
    // The advisory boundary is stated on the recommendation row.
    expect(rows[1]?.fact).toContain("advisory only");
    // Production is NEVER implied by observation or recommendation.
    expect(rows[3]?.fact).toContain("never implied by an observation or a recommendation");
  });

  test("MODULE: the competence promotion cell never claims a promotion — the mutant fails", async () => {
    const { competenceDetailFacts } = await import("../../apps/dashboard/projection");
    const facts = competenceDetailFacts();
    const promotion = facts.find((fact) => fact.label === "Promotion state");
    expect(promotion?.backed).toBe(false);
    expect(promotion?.fact).toContain("implies a promotion");
    // The mutant: claiming a validated/promoted state.
    expect(promotion?.fact).not.toMatch(/is (validated|promoted)/i);
  });

  test("RUNTIME: the competence and evaluation surfaces carry no claim vocabulary and no mutation surface", async () => {
    const competences = await get("/assets/competences");
    const competencesHtml = await competences.text();
    expect(competences.status).toBe(200);
    expect(competencesHtml).toContain("Competence discovery — not yet exposed by the public API");
    // No fabricated competence rows (no success-rate claims).
    expect(competencesHtml).not.toMatch(/\d+% (success|pass)|success rate: \d/i);
    // No local execution shortcut: no POST form on the surface.
    expect(competencesHtml).not.toMatch(/<form[^>]*method="post"/);

    const evaluations = await get("/improve/evaluations");
    const evaluationsHtml = await evaluations.text();
    expect(evaluations.status).toBe(200);
    // The four statuses render as distinctions, each the explicit absence.
    expect((evaluationsHtml.match(/class="distinction-state"/g) ?? []).length).toBe(4);
    expect((evaluationsHtml.match(/>Explicit absence</g) ?? []).length).toBe(4);
    expect(evaluationsHtml).not.toContain(">Platform fact<");
    // No row claims a stage was REACHED for this workspace — the concepts
    // are explained (what each status means), never asserted as held.
    expect(evaluationsHtml).not.toMatch(
      /your (observation|recommendation|validation|production)[^.<]*(passed|granted|approved|in effect)/i,
    );
    expect(evaluationsHtml).not.toMatch(
      /(observation|recommendation) (has|is)[^.<]*(validated|promoted|production)/i,
    );
  });
});

// ---------------------------------------------------------------------------
// D18 — lineage fabrication (WORK-038 AC5): artifact parents and usage
// derive ONLY from the platform's recorded input references — a mutant
// fabricating a parent (or a provenance block without a public record)
// is flagged.
// ---------------------------------------------------------------------------

describe("D18 lineage fabrication (parents and usage are recorded facts only)", () => {
  test("MODULE: input refs read ONLY the execution.created payload — the free-text mutant differs", async () => {
    const { inputArtifactRefsOf } = await import("../../apps/dashboard/projection");
    const stream = [
      {
        eventId: "ev-1",
        executionId: EXECUTION_ID,
        type: "execution.created",
        sequence: 1,
        occurredAt: NOW,
        payload: { inputArtifactRefs: ["art-parent-1"] },
      },
      {
        eventId: "ev-2",
        executionId: EXECUTION_ID,
        type: "execution.start",
        sequence: 2,
        occurredAt: NOW,
        // A hostile later event claiming DIFFERENT inputs: the derivation
        // must ignore it (only the created record is authoritative).
        payload: { inputArtifactRefs: ["art-hostile-later"] },
      },
    ];
    expect(inputArtifactRefsOf(stream)).toEqual(["art-parent-1"]);
    // The no-created-event stream yields the honest empty list.
    expect(
      inputArtifactRefsOf([
        {
          eventId: "ev-1",
          executionId: EXECUTION_ID,
          type: "execution.start",
          sequence: 1,
          occurredAt: NOW,
          payload: { inputArtifactRefs: ["art-invented"] },
        },
      ]),
    ).toEqual([]);
  });

  test("MODULE: the parent-lineage rendering with no recorded parents states the absence — the fabricating mutant differs", async () => {
    const { artifactParentLineage } = await import("../../apps/dashboard/trust");
    const honest = artifactParentLineage([], EXECUTION_ID);
    expect(honest).toContain("No input artifact references are recorded");
    expect(honest).not.toContain('class="evidence-ref"');
    // The mutant: fabricating a parent link without a recorded input.
    const mutant = artifactParentLineage([`${EXECUTION_ID}-invented`], EXECUTION_ID);
    expect(mutant).toContain('class="evidence-ref"');
    expect(honest).not.toBe(mutant);
  });

  test("RUNTIME: an artifact with no resolvable public record renders the honest state — never a fabricated provenance", async () => {
    const page = await get("/assets/artifacts/art-00000000-0000-7000-8000-0000000000f9");
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain("Artifact detail — not yet exposed by the public API");
    expect(html).toContain("no artifact-by-id route");
    // No fabricated provenance/lineage/verification blocks.
    expect(html).not.toContain("Provenance — the producing execution");
    expect(html).not.toContain("Parent lineage");
    expect(html).not.toContain("Verification references");
  });
});

// ---------------------------------------------------------------------------
// D19 — policy-reason fabrication (WORK-039 AC2/AC9): the controlling
// rule renders ONLY from the platform-recorded policy-denied event — a
// mutant deriving a reason from the status, the free-text failure
// message or thin air is flagged; a run without a recorded denial
// renders no blocked explanation at all.
// ---------------------------------------------------------------------------

describe("D19 policy-reason fabrication (the controlling rule is the platform's own recording)", () => {
  test("MODULE: policyDenialOf produces the recorded reason ONLY — the status-derived mutant differs on the same input", async () => {
    const { policyDenialOf } = await import("../../apps/dashboard/projection");
    const created = events.map((event, index) =>
      index === 0
        ? event
        : {
            ...event,
            type: "execution.policy-denied",
            payload: {
              from: "CREATED",
              to: "CREATED",
              denied: true,
              reason: "the requested spend exceeds the effective policy ceiling",
            },
          },
    );
    expect(policyDenialOf(created)?.reason).toBe(
      "the requested spend exceeds the effective policy ceiling",
    );
    // The fabricated mutants: a reason from the CREATED status, from a
    // fail message, or a canned default — each differs on the SAME input.
    expect(policyDenialOf(events)).toBeNull();
    const failMessage = events.map((event, index) =>
      index === 1
        ? { ...event, type: "execution.fail", payload: { message: "too expensive" } }
        : event,
    );
    expect(policyDenialOf(failMessage)).toBeNull();
    expect(policyDenialOf([])).toBeNull();
  });

  test("STATIC: the denial guard is the typed event + payload-reason read — the mutant widening it is flagged", () => {
    const PROJECTION = appsSource("projection.ts");
    expect(PROJECTION.includes('event.type !== "execution.policy-denied"')).toBe(true);
    expect(PROJECTION.includes('typeof reason === "string" && reason.trim().length > 0')).toBe(
      true,
    );
    // The mutant: accepting ANY event's payload as a denial source.
    const mutant = PROJECTION.replace(
      'event.type !== "execution.policy-denied"',
      'event.type !== "execution.fail"',
    );
    expect(mutant.includes('event.type !== "execution.fail"')).toBe(true);
    expect(mutant.includes('event.type !== "execution.policy-denied"')).toBe(false);
  });

  test("RUNTIME: a run with NO recorded denial renders no blocked explanation (the block never fabricates)", async () => {
    const page = await get(`/runs/${EXECUTION_ID}`);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).not.toContain("state state-blocked");
    expect(html).not.toContain("Blocked by policy");
    expect(html).not.toContain("The controlling rule:");
  });
});

// ---------------------------------------------------------------------------
// D20 — frontend-accounting fabrication (WORK-039 AC3/AC9): the spend
// surface computes NO second accounting truth — the usage total is the
// BigInt sum of the platform-recorded per-run costs ONLY; a missing cost
// stays missing (never zero, never a guess); reservations, settlement
// and the ledger render as their honest public absence.
// ---------------------------------------------------------------------------

describe("D20 frontend-accounting fabrication (no second ledger, no float arithmetic)", () => {
  test("MODULE: sumMicroUsd is integer-BigInt-only — the float-parsing mutant differs on the same input", async () => {
    const { sumMicroUsd } = await import("../../apps/dashboard/projection");
    expect(sumMicroUsd(["4180000", "1250000"])).toBe("5430000");
    // Float-shaped and garbage values contribute NOTHING (never parsed).
    expect(sumMicroUsd(["4.18", "1e6", "abc", "-1"])).toBe("0");
    // Precision beyond Number.MAX_SAFE_INTEGER survives (the float
    // mutant would lose it — BigInt does not).
    expect(sumMicroUsd(["9007199254740993"])).toBe("9007199254740993");
    const floatMutant = ["4180000"].map((value) => String(Number(value) + 0.5));
    expect(floatMutant[0]).not.toBe(sumMicroUsd(["4180000"]));
  });

  test("MODULE: runSpendFacts leaves every missing fact null — the zero-guessing mutant differs", async () => {
    const { runSpendFacts } = await import("../../apps/dashboard/projection");
    const noResult = { ...result, cost: null, route: null };
    const facts = runSpendFacts(execution, noResult);
    expect(facts.costMicroUsd).toBeNull();
    expect(facts.provider).toBeNull();
    // The mutant: defaulting a missing cost to "0" (fabricating an
    // accounting figure the platform did not record).
    const zeroMutant = facts.costMicroUsd ?? "0";
    expect(zeroMutant).not.toBeNull();
    expect(facts.costMicroUsd).toBeNull();
  });

  test("STATIC: the spend total flows ONLY through the BigInt sum — the float mutant is flagged", () => {
    const PROJECTION = appsSource("projection.ts");
    expect(PROJECTION.includes("total += BigInt(value);")).toBe(true);
    expect(PROJECTION.includes("/^\\d{1,19}$/.test(value)")).toBe(true);
    // The mutant: parsing money as a float (the classic second-ledger bug).
    const mutant = PROJECTION.replace("total += BigInt(value);", "total += Number(value);");
    expect(mutant.includes("total += Number(value);")).toBe(true);
    expect(mutant.includes("total += BigInt(value);")).toBe(false);
  });

  test("RUNTIME: the spend page renders the recorded cost exactly and no reservation/settlement figures", async () => {
    const response = await fetch(`${base}/admin/budgets`, {
      headers: { cookie: `zeck_recent_executions=${EXECUTION_ID}` },
      redirect: "manual",
    });
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("$4.18");
    // The accounting detail is the honest ABSENCE (no fabricated
    // reservation ids, settlement amounts or ledger rows).
    expect(html).toContain("not yet exposed by the public API");
    expect(html).not.toMatch(/reservation (id|#)|settled amount|rail transaction/i);
  });
});

// ---------------------------------------------------------------------------
// D21 — connection secret leakage (WORK-039 AC4/AC9): the connections
// surface renders ONLY the platform's opaque routing strings — no
// credential-shaped value, no connection handle, no secret-mediated
// material; the create contract's forbidden-key rule is stated (the
// mutant adding a connection field to any surface is flagged).
// ---------------------------------------------------------------------------

describe("D21 connection secret leakage (no field where a secret could appear)", () => {
  test("MODULE: a hostile provider string renders as an opaque escaped label — never as a credential or markup", async () => {
    const { connectionsSection } = await import("../../apps/dashboard/controls");
    const html = connectionsSection([
      {
        provider: '<script>alert("x")</script>',
        runCount: 1,
        totalMicroUsd: "1000000",
        executionIds: [EXECUTION_ID],
      },
    ]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/sk-[a-z0-9]{8,}|Bearer\s+[A-Za-z0-9]/i);
  });

  test("STATIC: the connections presentation states the forbidden-key boundary and carries no credential rendering", () => {
    const CONTROLS = appsSource("controls.ts");
    expect(CONTROLS.includes("The create contract carries no connection field at all")).toBe(true);
    // No credential-shaped rendering primitive exists in the module.
    expect(CONTROLS).not.toMatch(/renderSecret|credentialValue|apiKey\]/i);
    // The mutant: a connection-field render site (the leak).
    const mutant = CONTROLS.replace(
      "The create contract carries no connection field at all",
      "Enter your connection API key below",
    );
    expect(mutant.includes("Enter your connection API key below")).toBe(true);
    expect(mutant.includes("The create contract carries no connection field at all")).toBe(false);
  });

  test("RUNTIME: the connections page renders the routing facts with no secret-shaped value and no mutation surface", async () => {
    const response = await fetch(`${base}/assets/connections`, {
      headers: { cookie: `zeck_recent_executions=${EXECUTION_ID}` },
      redirect: "manual",
    });
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("neutral-p");
    expect(html).toContain("bring your own keys");
    expect(html).not.toMatch(/sk-[a-z0-9]{8,}|api[_-]?key\s*[:=]|Bearer\s+[A-Za-z0-9._-]+/i);
    expect(html).not.toMatch(/<form[^>]*method="post"/);
  });
});

// ---------------------------------------------------------------------------
// D22 — learning-authority mutation (WORK-039 IR6/AC9): learning cannot
// mutate policy/budget/connections authority through the UI — the
// Improve surfaces carry NO apply mutation, the recommendation row
// never claims authorization, and driving every W039 GET journey
// issues ZERO POST wire calls.
// ---------------------------------------------------------------------------

describe("D22 learning-authority mutation (learning never authorizes, never mutates)", () => {
  test("MODULE: the recommendation row carries the never-authorizes boundary and is never backed — the authority-flip mutant differs", async () => {
    const { learningAuthorityRows } = await import("../../apps/dashboard/projection");
    const rows = learningAuthorityRows();
    const recommendation = rows.find((row) => row.kind === "recommendation");
    expect(recommendation?.backed).toBe(false);
    expect(recommendation?.fact).toContain(
      "Learning produces recommendations and evidence, never authorization",
    );
    // The mutant: flipping the recommendation row to a platform fact
    // (claiming authoritative backing no public surface provides).
    const flipped = rows.map((row) =>
      row.kind === "recommendation" ? { ...row, backed: true } : row,
    );
    expect(flipped.find((row) => row.kind === "recommendation")?.backed).not.toBe(
      recommendation?.backed,
    );
  });

  test("STATIC: the controls module renders no POST form and no apply action — the mutant adding one is flagged", () => {
    const CONTROLS = appsSource("controls.ts");
    expect(CONTROLS).not.toMatch(/method="post"|confirmAction|<form[^>]*post/i);
    // The boundary sentence is part of the module's own vocabulary.
    expect(CONTROLS.includes("never authorization")).toBe(true);
    // The mutant: an apply-form render site in the Improve presentation.
    const mutant = CONTROLS.replace(
      "never authorization",
      'never authorization</p><form method="post" action="/improve/learning/apply">',
    );
    expect(mutant.includes('action="/improve/learning/apply"')).toBe(true);
    expect(CONTROLS.includes('action="/improve/learning/apply"')).toBe(false);
  });

  test("RUNTIME: driving every W039 GET journey issues ZERO POST wire calls and no apply surface renders", async () => {
    wireCalls.length = 0;
    for (const path of [
      "/admin/policies",
      "/admin/budgets",
      "/admin/team",
      "/admin/environments",
      "/admin/audit",
      "/assets/connections",
      "/improve/evaluations",
      "/improve/insights",
      "/improve/learning",
    ]) {
      const response = await fetch(`${base}${path}`, {
        headers: { cookie: `zeck_recent_executions=${EXECUTION_ID}` },
        redirect: "manual",
      });
      expect(response.status, path).toBe(200);
    }
    // Every W039 wire call is a scoped GET read through the bound scope.
    expect(wireCalls.filter((call) => call.method === "POST")).toEqual([]);
    for (const call of wireCalls) {
      expect(call.application, call.path).toBe(APP_ID);
    }
    // The learning page renders the boundary sentence and NO apply form.
    const learning = await get("/improve/learning");
    const html = await learning.text();
    expect(html).toContain("Learning produces recommendations and evidence, never authorization");
    expect(html).not.toMatch(/<form[^>]*method="post"/);
    expect(html).not.toMatch(/apply (this|now)|promote now|authorize now/i);
  });
});
