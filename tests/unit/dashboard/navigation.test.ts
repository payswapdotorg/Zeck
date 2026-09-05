/**
 * Dashboard navigation tests (WORK-033; updated to the WORK-035 v2
 * information architecture).
 *
 * Boots the REAL dashboard server (`createDashboard`) on an ephemeral
 * port with a fake `fetchImpl` implementing the public API wire surface
 * over an in-memory world, then drives it with real `fetch`:
 *  - every route in the v2 route map renders (200 HTML or 303);
 *  - the nav hierarchy matches UX-EXPERIENCE-ARCHITECTURE-V2 §5 exactly
 *    (Work/Build/Library/Trust/Control/Improve under Home);
 *  - the active nav item is marked with `aria-current`;
 *  - the legacy dashboard routes still work (303 preservation);
 *  - responsive markup evidence: viewport meta, the 1024px/640px media
 *    queries and the ≥44px touch-target rules in DASHBOARD_CSS;
 *  - appearance tokens (light/dark/system) and reduced-motion rules;
 *  - the WORK-035 foundation: the page-head/breadcrumb treatment, the
 *    command dialog, the mode selector and the attention surface.
 */

import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDashboard } from "../../../apps/dashboard/index";
import { NAV_GROUPS } from "../../../apps/dashboard/shell";
import { DASHBOARD_CSS } from "../../../apps/dashboard/tokens";
import type {
  AgentStatusView,
  AgentSummary,
  Execution,
  ExecutionReceipt,
  ExecutionResult,
  VerificationResult,
} from "../../../sdk";

const EXECUTION_ID = "00000000-0000-7000-8000-0000000000e1";

const EXECUTION: Execution = {
  id: EXECUTION_ID,
  applicationId: "00000000-0000-7000-8000-0000000000a1",
  environmentId: null,
  status: "COMPLETED",
  task: { kind: "outcome", description: "Contract risk analysis" },
  constraints: null,
  metadata: {},
  createdAt: "2026-09-15T12:00:00Z",
  updatedAt: "2026-09-15T12:03:42Z",
  terminalAt: "2026-09-15T12:03:42Z",
};

const RESULT: ExecutionResult = {
  executionId: EXECUTION_ID,
  status: "COMPLETED",
  route: { provider: "neutral-p", model: "neutral-m", strategyClass: "hybrid", modelCalls: 2 },
  cost: { totalMicroUsd: "4180000", currency: "usd" },
  usage: null,
  outputArtifacts: [
    {
      id: "00000000-0000-7000-8000-0000000000f1",
      digest: "digest",
      createdAt: "2026-09-15T12:03:40Z",
    },
  ],
  verification: [],
  warnings: [],
  terminalAt: "2026-09-15T12:03:42Z",
};

const AGENTS: AgentSummary[] = [
  {
    id: "00000000-0000-7000-8000-0000000000b1",
    slug: "support-triage",
    name: "Support Triage Agent",
    description: "Handles incoming tickets.",
    status: "active",
    activeVersionId: "v-1",
    activeVersion: "1.0.0",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-10T00:00:00Z",
  },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
  const path = new URL(String(input)).pathname;
  if (path === "/executions" && init?.method === "POST") {
    const receipt: ExecutionReceipt = {
      executionId: EXECUTION_ID,
      applicationId: EXECUTION.applicationId,
      status: "CREATED",
      createdAt: "2026-09-15T12:00:00Z",
      replayed: false,
      lastEventSequence: 1,
    };
    return json(receipt, 201);
  }
  if (path === `/executions/${EXECUTION_ID}`) return json(EXECUTION);
  if (path === `/executions/${EXECUTION_ID}/cancel`) {
    return json({ ...EXECUTION, status: "CANCELLED" });
  }
  if (path === `/executions/${EXECUTION_ID}/results`) return json(RESULT);
  if (path === `/executions/${EXECUTION_ID}/events`) return json([]);
  if (path === `/executions/${EXECUTION_ID}/verification`)
    return json(RESULT.verification satisfies readonly VerificationResult[]);
  if (path === "/agents") return json(AGENTS);
  if (path === "/agents/00000000-0000-7000-8000-0000000000b1/status") {
    const status: AgentStatusView = {
      agent: AGENTS[0] as AgentSummary,
      activeVersion: null,
      latestSelection: null,
      availableVersions: [],
    };
    return json(status);
  }
  return json({ code: "PROVIDER_ERROR", message: `unexpected path ${path}`, retryable: true }, 500);
}) as unknown as typeof fetch;

let base = "";

beforeAll(async () => {
  const { server } = createDashboard({
    apiUrl: "http://fake.local",
    token: "token",
    applicationId: "00000000-0000-7000-8000-0000000000a1",
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

async function getHtml(path: string): Promise<string> {
  const response = await get(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  return response.text();
}

async function getHtmlWithMode(path: string, mode: string): Promise<string> {
  const response = await fetch(`${base}${path}`, {
    headers: { cookie: `zeck_mode=${mode}` },
    redirect: "manual",
  });
  expect(response.status).toBe(200);
  return response.text();
}

describe("the v2 route map: every route renders", () => {
  const ROUTES: readonly [string, number][] = [
    ["/", 200],
    ["/home", 303],
    ["/build", 200],
    ["/build/execution", 200],
    ["/build/agent", 200],
    ["/build/workload", 200],
    ["/build/deployment", 200],
    ["/deployments", 200],
    ["/deployments/00000000-0000-7000-8000-0000000000e1", 200],
    ["/runs", 200],
    ["/runs/active", 200],
    ["/runs/history", 200],
    ["/runs/scheduled", 200],
    [`/runs/${EXECUTION_ID}`, 200],
    [`/runs/${EXECUTION_ID}?tab=evidence`, 200],
    [`/runs/${EXECUTION_ID}?tab=activity`, 200],
    [`/runs/${EXECUTION_ID}?tab=activity&view=events`, 200],
    [`/runs/${EXECUTION_ID}?tab=activity&view=raw`, 200],
    [`/runs/${EXECUTION_ID}?action=cancel`, 200],
    ["/agents", 200],
    ["/agents/00000000-0000-7000-8000-0000000000b1", 200],
    ["/assets/artifacts", 200],
    ["/assets/artifacts/some-artifact", 200],
    ["/assets/competences", 200],
    ["/assets/competences/some-competence", 200],
    ["/assets/connections", 200],
    ["/trust/evidence", 200],
    ["/trust/lineage", 200],
    ["/improve/evaluations", 200],
    ["/improve/insights", 200],
    ["/improve/learning", 200],
    ["/admin/policies", 200],
    ["/admin/budgets", 200],
    ["/admin/team", 200],
    ["/admin/environments", 200],
    ["/admin/audit", 200],
    ["/attention", 200],
    ["/command", 200],
    ["/command?q=agents", 200],
    ["/command?q=000000000000000000000000000000deadbeef", 200],
  ];

  test("every route renders with the correct status", async () => {
    for (const [path, expectedStatus] of ROUTES) {
      const response = await get(path);
      expect(response.status, path).toBe(expectedStatus);
      if (expectedStatus === 200) {
        expect(response.headers.get("content-type") ?? "", path).toContain("text/html");
      }
    }
  });

  test("the legacy routes are preserved (AC10)", async () => {
    const execution = await get(`/executions/${EXECUTION_ID}`);
    expect(execution.status).toBe(303);
    expect(execution.headers.get("location")).toBe(`/runs/${EXECUTION_ID}`);
    const lookup = await get(`/executions?id=${EXECUTION_ID}`);
    expect(lookup.status).toBe(303);
    expect(lookup.headers.get("location")).toBe(`/runs/${EXECUTION_ID}`);
    const cancel = await fetch(`${base}/executions/${EXECUTION_ID}/cancel`, {
      method: "POST",
      body: "idempotencyKey=key-1",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(cancel.status).toBe(303);
    expect(cancel.headers.get("location")).toBe(`/runs/${EXECUTION_ID}`);
  });

  test("unknown routes render the 404 page (with exactly one h1)", async () => {
    const response = await get("/definitely-not-a-route");
    expect(response.status).toBe(404);
    const html = await response.text();
    expect((html.match(/<h1[^>]*>/g) ?? []).length).toBe(1);
  });

  test("the client script is served as a JavaScript asset", async () => {
    const response = await get("/assets/client.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/javascript");
    const body = await response.text();
    expect(body).toContain("command-input");
  });

  test("an oversized form body is rejected with the 413 page (not a raw failure)", async () => {
    const response = await fetch(`${base}/build/execution`, {
      method: "POST",
      body: `outcome=${"x".repeat(70_000)}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(response.status).toBe(413);
    const html = await response.text();
    expect(html).toContain("<h1>Form too large</h1>");
    expect((html.match(/<h1[^>]*>/g) ?? []).length).toBe(1);
  });
});

describe("every page: the a11y frame (lang, title, one h1, landmarks, skip link)", () => {
  const PAGES: readonly string[] = [
    "/",
    "/build",
    "/build/execution",
    "/build/agent",
    "/build/workload",
    "/build/deployment",
    "/deployments",
    "/deployments/00000000-0000-7000-8000-0000000000e1",
    "/runs",
    "/runs/active",
    "/runs/history",
    "/runs/scheduled",
    `/runs/${EXECUTION_ID}`,
    `/runs/${EXECUTION_ID}?tab=evidence`,
    `/runs/${EXECUTION_ID}?tab=activity`,
    "/agents",
    "/agents/00000000-0000-7000-8000-0000000000b1",
    "/assets/artifacts",
    "/assets/competences",
    "/assets/connections",
    "/trust/evidence",
    "/trust/lineage",
    "/improve/evaluations",
    "/improve/insights",
    "/improve/learning",
    "/admin/policies",
    "/admin/budgets",
    "/admin/team",
    "/admin/environments",
    "/admin/audit",
    "/attention",
    "/command",
    "/command?q=agents",
  ];

  test("each page has the full frame", async () => {
    for (const page of PAGES) {
      const html = await getHtml(page);
      expect(html.startsWith("<!doctype html>"), page).toBe(true);
      expect(html, page).toContain('<html lang="en"');
      expect(html, page).toContain("<title>");
      expect((html.match(/<h1[^>]*>/g) ?? []).length, page).toBe(1);
      expect(html, page).toContain("<header");
      expect(html, page).toContain("<nav");
      expect(html, page).toContain('aria-label="Primary"');
      expect(html, page).toContain("<main");
      expect(html, page).toContain("<footer");
      expect(html, page).toContain('role="search"');
      expect(html, page).toContain('href="#main">Skip to main content');
      expect(html.indexOf('class="skip-link"'), page).toBeLessThan(html.indexOf("<header"));
      expect(html, page).toContain(
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
      );
      expect(html, page).toContain('action="/command"');
      expect(html, page).toContain('src="/assets/client.js"');
    }
  });
});

describe("the nav hierarchy matches UX-EXPERIENCE-ARCHITECTURE-V2 §5", () => {
  test("the IA tree is exactly Home + the six groups with their items", () => {
    expect(NAV_GROUPS.map((group) => group.label)).toEqual([
      "Work",
      "Build",
      "Library",
      "Trust",
      "Control",
      "Improve",
    ]);
    expect(NAV_GROUPS[0]?.items.map((item) => item.label)).toEqual([
      "New",
      "Active",
      "History",
      "Scheduled",
    ]);
    expect(NAV_GROUPS[1]?.items.map((item) => item.label)).toEqual([
      "Agents",
      "Deployments",
      "Workloads",
      "Competences",
    ]);
    expect(NAV_GROUPS[2]?.items.map((item) => item.label)).toEqual(["Artifacts", "Connections"]);
    expect(NAV_GROUPS[3]?.items.map((item) => item.label)).toEqual([
      "Evidence",
      "Evaluations",
      "Lineage",
    ]);
    expect(NAV_GROUPS[4]?.items.map((item) => item.label)).toEqual([
      "Policies",
      "Spend",
      "Team",
      "Environments",
      "Audit",
    ]);
    expect(NAV_GROUPS[5]?.items.map((item) => item.label)).toEqual(["Insights", "Learning"]);
  });

  test("the rendered nav carries the tree with real links (professional: full IA minus expert-only entries)", async () => {
    const html = await getHtml("/build");
    // Group labels are native summaries; item labels are real links.
    for (const group of ["Work", "Build", "Library", "Trust", "Control", "Improve"]) {
      expect(html).toContain(`<summary>${group}</summary>`);
    }
    for (const label of [
      "Home",
      "New",
      "Active",
      "History",
      "Scheduled",
      "Agents",
      "Deployments",
      "Workloads",
      "Competences",
      "Artifacts",
      "Connections",
      "Evidence",
      "Evaluations",
      "Policies",
      "Spend",
      "Team",
      "Environments",
      "Insights",
      "Learning",
    ]) {
      expect(html).toContain(`>${label}</a>`);
    }
    // Expert-only inspection entries are NOT visible in professional mode.
    expect(html).not.toContain(">Lineage</a>");
    expect(html).not.toContain(">Audit</a>");
  });

  test("expert mode reveals the expert-only entries without changing any route", async () => {
    const response = await fetch(`${base}/build`, {
      headers: { cookie: "zeck_mode=expert" },
      redirect: "manual",
    });
    const html = await response.text();
    expect(html).toContain(">Lineage</a>");
    expect(html).toContain(">Audit</a>");
    expect(html).toContain('data-mode="expert"');
    // The same routes exist in every mode (visibility, never semantics).
    for (const label of ["Home", "New", "Agents", "Policies", "Insights"]) {
      expect(html).toContain(`>${label}</a>`);
    }
  });

  test("nav groups are native details/summary (collapsed, CSS-driven, same DOM everywhere)", async () => {
    const html = await getHtml("/");
    expect(html).toContain('<details class="nav-group"');
    expect(html).toContain("<summary>Work</summary>");
    // Home carries no active group: every group stays collapsed.
    expect((html.match(/<details class="nav-group" open>/g) ?? []).length).toBe(0);
    // A page inside a group opens exactly that one group (progressive disclosure).
    const build = await getHtml("/build");
    expect((build.match(/<details class="nav-group" open>/g) ?? []).length).toBe(1);
    expect(build).toContain('<details class="nav-group" open>\n    <summary>Build</summary>');
    const history = await getHtml("/runs/history");
    expect((history.match(/<details class="nav-group" open>/g) ?? []).length).toBe(1);
  });

  test("the active nav item carries aria-current (marking per route)", async () => {
    const agents = await getHtml("/agents");
    expect(agents).toContain('href="/agents" aria-current="page"');
    const history = await getHtml("/runs/history");
    expect(history).toContain('href="/runs/history" aria-current="page"');
    const home = await getHtml("/");
    expect(home).toContain('href="/" aria-current="page"');
    const lineage = await getHtmlWithMode("/trust/lineage", "expert");
    expect(lineage).toContain('href="/trust/lineage" aria-current="page"');
  });

  test("the execution tab links carry aria-current for the active tab", async () => {
    const evidence = await getHtml(`/runs/${EXECUTION_ID}?tab=evidence`);
    expect(evidence).toContain(
      'href="/runs/00000000-0000-7000-8000-0000000000e1?tab=evidence" aria-current="page"',
    );
    const activity = await getHtml(`/runs/${EXECUTION_ID}?tab=activity`);
    expect(activity).toContain(
      'href="/runs/00000000-0000-7000-8000-0000000000e1?tab=activity" aria-current="page"',
    );
  });
});

describe("responsive and appearance evidence in the stylesheet", () => {
  test("the desktop sidebar, tablet and mobile breakpoints exist (1024px / 640px)", () => {
    expect(DASHBOARD_CSS).toContain("@media (min-width: 1025px)");
    expect(DASHBOARD_CSS).toContain("@media (max-width: 1024px)");
    expect(DASHBOARD_CSS).toContain("@media (max-width: 640px)");
    expect(DASHBOARD_CSS).toContain('grid-template-areas:\n      "nav header"');
    expect(DASHBOARD_CSS).toContain("grid-template-columns: var(--sidebar-width) 1fr");
  });

  test("mobile touch targets are at least 44px (--touch-target)", () => {
    const mobileBlock = DASHBOARD_CSS.slice(DASHBOARD_CSS.indexOf("@media (max-width: 640px)"));
    expect(mobileBlock).toContain("min-height: var(--touch-target)");
    // WORK-041 (responsive refinement): the touch-target minimum covers
    // the dialog family too — the command dialog's input/submit, the
    // sheet's close and action buttons (modal surfaces are primary
    // interactive surfaces on mobile).
    expect(mobileBlock).toContain("dialog button, dialog input, dialog select");
  });

  test("reduced motion is honored", () => {
    expect(DASHBOARD_CSS).toContain("@media (prefers-reduced-motion: reduce)");
    expect(DASHBOARD_CSS).toContain("transition-duration: 0.01ms !important");
  });

  test("light/dark/system appearance tokens exist", () => {
    expect(DASHBOARD_CSS).toContain('[data-theme="light"]');
    expect(DASHBOARD_CSS).toContain('[data-theme="dark"]');
    expect(DASHBOARD_CSS).toContain("@media (prefers-color-scheme: dark)");
    expect(DASHBOARD_CSS).toContain(":root:not([data-theme])");
  });

  test("focus-visible styling and rem-based typography exist", () => {
    expect(DASHBOARD_CSS).toContain(":focus-visible");
    expect(DASHBOARD_CSS).toContain("outline: 2px solid");
    expect(DASHBOARD_CSS).toContain("font-size: 1rem");
    expect(DASHBOARD_CSS).toContain("font-size: 1.5rem");
  });

  test("no gradients (calm, content-first visual direction)", () => {
    expect(DASHBOARD_CSS).not.toMatch(/gradient/);
  });

  test("the appearance route sets the presentation cookie and redirects back", async () => {
    const response = await get("/appearance?mode=dark&returnTo=/runs");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/runs");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("zeck_appearance=dark");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("SameSite=Lax");
  });

  test("an explicit dark preference renders the data-theme attribute", async () => {
    const response = await fetch(`${base}/`, {
      headers: { cookie: "zeck_appearance=dark" },
      redirect: "manual",
    });
    const html = await response.text();
    expect(html).toContain('<html lang="en" data-theme="dark"');
  });

  test("no explicit preference renders without data-theme (system follows the OS)", async () => {
    const html = await getHtml("/");
    expect(html).toContain('<html lang="en">');
  });
});
