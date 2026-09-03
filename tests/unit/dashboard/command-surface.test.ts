/**
 * Command surface tests (WORK-035) — the global Cmd/Ctrl+K second front
 * door (UX-EXPERIENCE-ARCHITECTURE-V2 §7; UX-SCREEN-SPEC-V2 §2/§23).
 *
 * The contract under test (booted against the REAL dashboard server with
 * a fake API world):
 *  - the command dialog markup: a native `<dialog>` with accessible
 *    labelling, a GET form to /command (the EXISTING dispatch path), the
 *    mode-aware static suggestion list, and the no-match message;
 *  - every suggestion is a LINK (navigation + examples + proposed
 *    actions) — mutations open their confirmation flows, never a direct
 *    POST from the dialog (AC3 + the authorization-path boundary);
 *  - the header keeps the no-JS fallback: the plain GET form to
 *    /command with the command-input;
 *  - the suggestion set is mode-aware (simple shows the four
 *    destinations; expert includes the expert entries);
 *  - D5 (discrimination): the shared client script performs NO network
 *    calls (no fetch/XHR/WebSocket) — all transport stays server-side
 *    through the governed SDK client; and the command results page links
 *    proposals into confirmation flows rather than POSTing directly.
 */

import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CLIENT_SCRIPT } from "../../../apps/dashboard/client";
import { createDashboard } from "../../../apps/dashboard/index";
import { commandSuggestions } from "../../../apps/dashboard/shell";
import type { AgentSummary, Execution, ExecutionResult } from "../../../sdk";

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
  outputArtifacts: [],
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

const fetchImpl = (async (input: string | URL) => {
  const path = new URL(String(input)).pathname;
  if (path === `/executions/${EXECUTION_ID}`) return json(EXECUTION);
  if (path === `/executions/${EXECUTION_ID}/results`) return json(RESULT);
  if (path === `/executions/${EXECUTION_ID}/events`) return json([]);
  if (path === `/executions/${EXECUTION_ID}/verification`) return json([]);
  if (path === "/agents") return json(AGENTS);
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

async function getHtml(path: string, cookie?: string): Promise<string> {
  const response = await fetch(`${base}${path}`, {
    headers: cookie === undefined ? {} : { cookie },
    redirect: "manual",
  });
  expect(response.status).toBe(200);
  return response.text();
}

describe("the command dialog markup (the second front door)", () => {
  test("every page renders the dialog: a native dialog with a GET /command form and accessible labelling", async () => {
    const html = await getHtml("/");
    expect(html).toContain('<dialog class="command-dialog" id="command-dialog"');
    expect(html).toContain('aria-labelledby="command-dialog-title"');
    expect(html).toContain('id="command-dialog-title"');
    expect(html).toContain('method="get" action="/command"');
    expect(html).toContain('id="command-dialog-input"');
    expect(html).toContain("data-command-suggestions");
    expect(html).toContain("data-command-empty");
    expect(html).not.toContain('method="post" action="/command"');
  });

  test("the header keeps the no-JS fallback form (the plain search input)", async () => {
    const html = await getHtml("/");
    expect(html).toContain('action="/command"');
    expect(html).toContain('id="command-input"');
    expect(html).toContain('role="search"');
    expect(html).toContain("data-command-open");
  });

  test("every suggestion is a LINK with its kind — never a form, never a POST", async () => {
    const html = await getHtml("/");
    const dialog = html.slice(html.indexOf('id="command-dialog"'), html.indexOf("</dialog>"));
    expect(dialog).toContain("suggestion-kind");
    expect(dialog).toContain(">Navigation</span>");
    expect(dialog).toContain(">Example</span>");
    expect(dialog).toContain(">Proposed action</span>");
    expect(dialog).not.toContain('<form method="post"');
    // The proposal example points into the command dispatch, not a
    // mutation.
    expect(dialog).toContain('href="/command?q=cancel"');
  });

  test("the suggestion set is mode-aware", async () => {
    const simple = await getHtml("/", "zeck_mode=simple");
    const dialog = simple.slice(simple.indexOf('id="command-dialog"'), simple.indexOf("</dialog>"));
    expect(dialog).toContain(">Work<span");
    expect(dialog).toContain(">Approvals<span");
    expect(dialog).not.toContain("Work — New");
    const professional = commandSuggestions("professional");
    expect(professional.some((s) => s.label === "Work — New")).toBe(true);
    expect(professional.some((s) => s.label === "Trust — Lineage")).toBe(false);
    const expert = commandSuggestions("expert");
    expect(expert.some((s) => s.label === "Trust — Lineage")).toBe(true);
    expect(expert.some((s) => s.label === "Control — Audit")).toBe(true);
  });
});

describe("D5: the authorization path — no client-side transport, mutations only via governed flows", () => {
  test("the shared client script performs NO network calls of any kind", () => {
    expect(CLIENT_SCRIPT).not.toContain("fetch(");
    expect(CLIENT_SCRIPT).not.toContain("XMLHttpRequest");
    expect(CLIENT_SCRIPT).not.toContain("WebSocket");
    expect(CLIENT_SCRIPT).not.toContain(".send(");
    expect(CLIENT_SCRIPT).not.toContain("navigator.sendBeacon");
  });

  test("the client script wires Cmd/Ctrl+K, the dialog filter, roving and focus restore", () => {
    expect(CLIENT_SCRIPT).toContain('"k" || event.key === "K"');
    expect(CLIENT_SCRIPT).toContain("data-command-open");
    expect(CLIENT_SCRIPT).toContain('input.addEventListener("input", filter)');
    expect(CLIENT_SCRIPT).toContain("ArrowDown");
    expect(CLIENT_SCRIPT).toContain('addEventListener("close"');
  });

  test("a proposed action from the command results is a LINK into the confirmation flow (never a direct POST)", async () => {
    const html = await getHtml(`/command?q=cancel%20${EXECUTION_ID}`);
    // The proposed cancel links to the execution's cancel confirmation
    // view; the results list itself carries no POST form.
    expect(html).toContain(`href="/runs/${EXECUTION_ID}?action=cancel"`);
    expect(html).toContain("opens a confirmation flow");
    const results = html.slice(html.indexOf('class="command-results"'), html.indexOf("</ul>"));
    expect(results).not.toContain("<form");
    expect(results).not.toContain('method="post"');
  });

  test("the hostile query is escaped in the echo and the empty state", async () => {
    const hostile = encodeURIComponent('<script>alert("x")</script>');
    const html = await getHtml(`/command?q=${hostile}`);
    expect(html).not.toContain(`<script>alert`);
    expect(html).toContain("&lt;script&gt;");
  });
});
