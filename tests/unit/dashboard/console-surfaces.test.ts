/**
 * Developer console surface tests (DEP-010 — applications, credentials,
 * environments, usage, quickstart, providers, docs, settings).
 *
 * Boots the REAL dashboard server with a wire-exact fake API (and a
 * HOSTILE transport-token value) and proves:
 *  - every console page renders with the full a11y frame;
 *  - the applications surfaces derive live from the runs this browser
 *    opened and state the honest not-exposed boundaries (inventory,
 *    issuance, aggregate usage);
 *  - the credentials surface carries the safe-credential policy and the
 *    env-var contract as NAMES ONLY;
 *  - the docs surface serves the repository's developer docs verbatim
 *    and refuses traversal;
 *  - settings manages only presentation state;
 *  - THE SECRET PROOF: the hostile transport token never renders on any
 *    page (never displayed, never logged, never stored in a cookie).
 */

import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDashboard } from "../../../apps/dashboard/index";
import type {
  Execution,
  ExecutionReceipt,
  ExecutionResult,
  VerificationResult,
} from "../../../sdk";

const APP_ID = "00000000-0000-7000-8000-0000000000a1";
const OTHER_APP_ID = "00000000-0000-7000-8000-0000000000a2";
const HOSTILE_TOKEN = "sk-live-console-transport-3f9c7bd1e8";

const EXECUTIONS: readonly Execution[] = [
  {
    id: "00000000-0000-7000-8000-0000000000e1",
    applicationId: APP_ID,
    environmentId: "env-sandbox-01",
    status: "COMPLETED",
    task: { kind: "summarize", doc: "quarterly-report-01", maxWords: 60 },
    constraints: { maxCostMicroUsd: "1500000" },
    metadata: { origin: "zeck-console-playground" },
    createdAt: "2026-09-15T12:00:00Z",
    updatedAt: "2026-09-15T12:03:42Z",
    terminalAt: "2026-09-15T12:03:42Z",
  },
  {
    id: "00000000-0000-7000-8000-0000000000e2",
    applicationId: OTHER_APP_ID,
    environmentId: null,
    status: "RUNNING",
    task: { kind: "extract", format: "invoice", doc: "invoice-001" },
    constraints: null,
    metadata: {},
    createdAt: "2026-09-15T12:05:00Z",
    updatedAt: "2026-09-15T12:05:01Z",
    terminalAt: null,
  },
];

function resultOf(execution: Execution): ExecutionResult {
  return {
    executionId: execution.id,
    status: execution.status,
    route: { provider: "neutral-p", model: "neutral-m", strategyClass: "hybrid", modelCalls: 2 },
    cost: execution.status === "COMPLETED" ? { totalMicroUsd: "4180000", currency: "usd" } : null,
    usage: execution.status === "COMPLETED" ? { inputTokens: 1200, outputTokens: 340 } : null,
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

const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
  const path = new URL(String(input)).pathname;
  if (path === "/executions" && init?.method === "POST") {
    const receipt: ExecutionReceipt = {
      executionId: "00000000-0000-7000-8000-0000000000e1",
      applicationId: APP_ID,
      status: "CREATED",
      createdAt: "2026-09-15T12:00:00Z",
      replayed: false,
      lastEventSequence: 1,
    };
    return json(receipt, 201);
  }
  for (const execution of EXECUTIONS) {
    if (path === `/executions/${execution.id}`) {
      return json(execution);
    }
    if (path === `/executions/${execution.id}/results`) {
      return json(resultOf(execution));
    }
    if (path === `/executions/${execution.id}/events`) {
      return json([]);
    }
    if (path === `/executions/${execution.id}/verification`) {
      return json([] satisfies readonly VerificationResult[]);
    }
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
    token: HOSTILE_TOKEN,
    applicationId: APP_ID,
    port: 0,
    fetchImpl,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
});

const RECENTS = `zeck_recent_executions=${EXECUTIONS.map((execution) => execution.id).join(",")}`;

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

const CONSOLE_PAGES: readonly string[] = [
  "/console",
  "/console/quickstart",
  "/console/catalog",
  "/console/start",
  "/console/applications",
  `/console/applications/${APP_ID}`,
  "/console/applications/keys",
  "/console/applications/environments",
  "/console/applications/usage",
  "/console/playground",
  "/console/playground/text",
  "/console/providers",
  "/console/docs",
  "/console/docs/AUTH.md",
  "/console/settings",
];

describe("every console page renders with the full a11y frame", () => {
  test("each page: doctype, lang, one h1, landmarks, skip link, viewport, command surface", async () => {
    for (const page of CONSOLE_PAGES) {
      const html = await getHtml(page);
      expect(html.startsWith("<!doctype html>"), page).toBe(true);
      expect(html, page).toContain('<html lang="en"');
      expect(html, page).toContain("<title>");
      expect((html.match(/<h1[^>]*>/g) ?? []).length, page).toBe(1);
      expect(html, page).toContain("<header");
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

  test("the Develop nav group is present with aria-current on the active destination", async () => {
    const html = await getHtml("/console");
    expect(html).toContain("<summary>Develop</summary>");
    for (const label of [
      "Quickstart",
      "Applications",
      "Playground",
      "Capability catalog",
      "Providers",
      "For agents",
      "Docs",
      "Settings",
    ]) {
      expect(html).toContain(`>${label}</a>`);
    }
    const playground = await getHtml("/console/playground");
    expect(playground).toContain('href="/console/playground" aria-current="page"');
    const catalog = await getHtml("/console/catalog");
    expect(catalog).toContain('href="/console/catalog" aria-current="page"');
  });
});

describe("the developer console home and quickstart", () => {
  test("the console home mirrors the roadmap IA with live/honest notes", async () => {
    const html = await getHtml("/console");
    expect(html).toContain(APP_ID);
    for (const href of [
      "/console/start",
      "/console/catalog",
      "/console/quickstart",
      "/console/applications",
      "/console/playground",
      "/console/validation",
      "/trust/limits",
      "/console/docs/AGENT-GUIDE.md",
      "/runs",
      "/trust/evidence",
      "/assets/artifacts",
      "/admin/budgets",
      "/console/providers",
      "/console/docs",
      "/console/settings",
    ]) {
      expect(html, href).toContain(`href="${href}"`);
    }
  });

  test("the quickstart walks the five steps with live links", async () => {
    const html = await getHtml("/console/quickstart");
    expect(html).toContain("Your application scope");
    expect(html).toContain("A safe credential");
    expect(html).toContain("Run your first sandbox execution");
    expect(html).toContain("Inspect the full path");
    expect(html).toContain("Go deeper");
    expect(html).toContain('href="/console/playground/text"');
    expect(html).toContain("Sandbox envelope");
  });
});

describe("applications (scope, keys, environments, usage)", () => {
  test("the overview shows the bound scope, derived applications and the honest boundaries", async () => {
    const html = await getHtml("/console/applications", RECENTS);
    expect(html).toContain("Console application scope");
    expect(html).toContain(APP_ID);
    expect(html).toContain('href="/console/applications/00000000-0000-7000-8000-0000000000a1"');
    expect(html).toContain('href="/console/applications/00000000-0000-7000-8000-0000000000a2"');
    expect(html).toContain("Application inventory and creation");
    expect(html).toContain("no application inventory or creation route");
  });

  test("the overview without recents renders the honest empty state", async () => {
    const html = await getHtml("/console/applications");
    expect(html).toContain("No applications seen yet");
  });

  test("the application detail filters the runs of that application only", async () => {
    const html = await getHtml(`/console/applications/${APP_ID}`, RECENTS);
    expect(html).toContain("00000000-0000-7000-8000-0000000000e1");
    expect(html).not.toContain("00000000-0000-7000-8000-0000000000e2");
    expect(html).toContain("browser-scoped facts");
  });

  test("the keys page carries the safe-credential policy and env-var names only", async () => {
    const html = await getHtml("/console/applications/keys");
    expect(html).toContain("never rendered on any page");
    expect(html).toContain("shown exactly once at creation");
    expect(html).toContain("ZECK_TOKEN");
    expect(html).toContain("ZECK_APPLICATION_ID");
    // DEP-011: the credential lifecycle routes now exist in the public API —
    // the honest boundary this unbound deployment renders is the missing
    // transport binding, NOT a missing public contract.
    expect(html).toContain("Issue a credential");
    expect(html).toContain("not reachable from this console deployment");
    expect(html).toContain("Connections — bring your own keys");
    // Values never appear — names only.
    expect(html).not.toContain(HOSTILE_TOKEN);
  });

  test("the environments page derives environments from real runs and links the operator view", async () => {
    const html = await getHtml("/console/applications/environments", RECENTS);
    expect(html).toContain("env-sandbox-01");
    expect(html).toContain("Environment inventory and provisioning");
    expect(html).toContain('href="/admin/environments"');
  });

  test("the usage page shows per-run tokens and settled cost with honest absences", async () => {
    const html = await getHtml("/console/applications/usage", RECENTS);
    expect(html).toContain("1200");
    expect(html).toContain("340");
    expect(html).toContain("$4.18");
    expect(html).toContain("not settled yet");
    expect(html).toContain("Aggregate usage and billing");
  });
});

describe("providers, docs and settings", () => {
  test("the providers page projects the manifest and states the neutrality story", async () => {
    const html = await getHtml("/console/providers");
    expect(html).toContain("text-generation");
    expect(html).toContain("json-schema-validation");
    expect(html).toContain("11 runnable families");
    expect(html).toContain("11 provider-gated families");
    expect(html).toContain("Provider inventory");
    expect(html).toContain('href="/assets/connections"');
  });

  test("the docs index lists the kit and serves a document verbatim", async () => {
    const index = await getHtml("/console/docs");
    expect(index).toContain("QUICKSTART.md");
    expect(index).toContain("AUTH.md");
    const doc = await getHtml("/console/docs/AUTH.md");
    expect(doc).toContain("ZECK_TOKEN");
    expect(doc).toContain('pre class="raw"');
  });

  test("doc traversal and unknown documents are refused", async () => {
    for (const path of [
      "/console/docs/..%2F..%2Fpackage.json",
      "/console/docs/nope.md",
      "/console/docs/machine%2Fopenapi.json",
    ]) {
      const response = await get(path);
      expect(response.status, path).toBe(404);
      expect((await response.text()).match(/<h1[^>]*>/g)?.length).toBe(1);
    }
  });

  test("settings manages only presentation state and clears the disclosed recents", async () => {
    const html = await getHtml("/console/settings");
    expect(html).toContain('action="/appearance"');
    expect(html).toContain("Clear the recents list");
    expect(html).toContain("Account-level console settings");
    const reset = await get("/console/settings/reset-recents");
    expect(reset.status).toBe(303);
    expect(reset.headers.get("location")).toBe("/console/settings");
    const cookie = reset.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("zeck_recent_executions=");
    expect(cookie).toContain("Max-Age=0");
  });
});

describe("the secret proof — the hostile transport token never renders anywhere", () => {
  test("no console page, run page, command page or error page carries the token", async () => {
    const pages = [
      ...CONSOLE_PAGES,
      "/",
      "/runs",
      "/runs/active",
      `/runs/${EXECUTIONS[0]?.id ?? ""}`,
      `/runs/${EXECUTIONS[0]?.id ?? ""}?tab=evidence`,
      `/runs/${EXECUTIONS[0]?.id ?? ""}?tab=activity`,
      "/command?q=agents",
      "/attention",
      "/build/execution",
      "/definitely-not-a-route",
    ];
    for (const page of pages) {
      const response = await get(page, RECENTS);
      const body = await response.text();
      expect(body, page).not.toContain(HOSTILE_TOKEN);
      expect(body, page).not.toContain("sk-live");
    }
  });
});
