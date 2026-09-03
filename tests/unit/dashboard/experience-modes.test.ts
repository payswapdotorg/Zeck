/**
 * Experience-mode tests (WORK-035) — the Simple/Professional/Expert
 * visibility model (UX-EXPERIENCE-ARCHITECTURE-V2 §25).
 *
 * The contract under test:
 *  - the vocabulary is exactly the three modes; unknown cookie values
 *    fall back to Professional (the default);
 *  - `visibleInMode` is the ONE predicate: entries list their modes;
 *  - modes change VISIBILITY ONLY: the filtered nav sets differ, but the
 *    UNION of routes is identical across modes and no route exists in
 *    one mode but not another (no duplicated route trees — IR4);
 *  - the mode cookie round-trips through GET /mode (redirect + cookie);
 *  - simple mode renders the four §25 primary destinations as the flat
 *    nav (Home/Work/Results/Approvals).
 *
 * D2 (discrimination): the mode drop-mutant — a shell that ignores the
 * mode cookie (renders the professional tree in simple mode, or shows
 * expert-only entries in professional mode) FAILS these tests.
 */

import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDashboard } from "../../../apps/dashboard/index";
import {
  DEFAULT_MODE,
  EXPERIENCE_MODES,
  filterByMode,
  MODE_COOKIE,
  MODE_LABELS,
  modeCookieHeader,
  modeOf,
  visibleInMode,
} from "../../../apps/dashboard/modes";
import { SIMPLE_NAV_ITEMS, visibleNavGroups } from "../../../apps/dashboard/shell";
import type { AgentSummary, Execution, ExecutionReceipt, ExecutionResult } from "../../../sdk";

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

describe("the mode model (v2 §25)", () => {
  test("the vocabulary is exactly Simple / Professional / Expert with labels", () => {
    expect([...EXPERIENCE_MODES]).toEqual(["simple", "professional", "expert"]);
    expect(MODE_LABELS.simple).toBe("Simple");
    expect(MODE_LABELS.professional).toBe("Professional");
    expect(MODE_LABELS.expert).toBe("Expert");
  });

  test("the cookie parses the three modes; anything else falls back to the default", () => {
    expect(modeOf({ [MODE_COOKIE]: "simple" })).toBe("simple");
    expect(modeOf({ [MODE_COOKIE]: "professional" })).toBe("professional");
    expect(modeOf({ [MODE_COOKIE]: "expert" })).toBe("expert");
    expect(modeOf({})).toBe(DEFAULT_MODE);
    expect(modeOf({ [MODE_COOKIE]: "yolo" })).toBe(DEFAULT_MODE);
    expect(modeOf({ [MODE_COOKIE]: "" })).toBe(DEFAULT_MODE);
  });

  test("the cookie header is a presentation cookie (path, max-age, SameSite)", () => {
    const header = modeCookieHeader("expert");
    expect(header).toContain(`${MODE_COOKIE}=expert`);
    expect(header).toContain("Path=/");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Max-Age=31536000");
  });

  test("visibleInMode is the single predicate over entry mode lists", () => {
    expect(visibleInMode({ modes: ["simple"] }, "simple")).toBe(true);
    expect(visibleInMode({ modes: ["simple"] }, "professional")).toBe(false);
    expect(visibleInMode({ modes: ["professional", "expert"] }, "expert")).toBe(true);
    expect(visibleInMode({ modes: ["expert"] }, "professional")).toBe(false);
    expect(
      filterByMode([{ modes: ["expert"] }, { modes: ["professional"] }], "professional"),
    ).toHaveLength(1);
  });
});

describe("modes change visibility ONLY — never semantics (IR4, D2)", () => {
  test("professional sees the professional entries; expert adds the expert-only ones; simple is the flat four", () => {
    const professional = visibleNavGroups("professional");
    expect(professional.map((group) => group.label)).toEqual([
      "Work",
      "Build",
      "Library",
      "Trust",
      "Control",
      "Improve",
    ]);
    // Expert-only entries are absent in professional.
    expect(professional.flatMap((group) => group.items.map((item) => item.label))).not.toContain(
      "Lineage",
    );
    const expert = visibleNavGroups("expert");
    expect(expert.flatMap((group) => group.items.map((item) => item.label))).toContain("Lineage");
    expect(expert.flatMap((group) => group.items.map((item) => item.label))).toContain("Audit");
    // Simple: the four §25 destinations.
    expect(SIMPLE_NAV_ITEMS.map((item) => item.label)).toEqual(["Work", "Results", "Approvals"]);
  });

  test("expert nav visibility is a SUPERSET of professional (monotone disclosure, never a second route tree)", () => {
    const routesOf = (mode: "professional" | "expert"): Set<string> =>
      new Set(
        visibleNavGroups(mode).flatMap((group) => [
          group.path,
          ...group.items.map((item) => item.path.split("#")[0] ?? item.path),
        ]),
      );
    const professional = routesOf("professional");
    const expert = routesOf("expert");
    // Everything professional exposes, expert still exposes.
    for (const route of professional) {
      expect(expert.has(route), `route ${route} missing in expert`).toBe(true);
    }
    // The expert-only extras are exactly the inspection entries.
    for (const route of expert) {
      if (!professional.has(route)) {
        expect(["/trust/lineage", "/admin/audit"]).toContain(route);
      }
    }
    expect(expert.size).toBeGreaterThan(professional.size);
  });

  test("the simple-mode flat nav addresses the SAME routes as the grouped tree", () => {
    // Work → /runs (the WORK group path); Results → /runs/history (the
    // History item); Approvals → /attention (the attention surface).
    const grouped = new Set(
      visibleNavGroups("professional").flatMap((group) => [
        group.path,
        ...group.items.map((item) => item.path.split("#")[0] ?? item.path),
      ]),
    );
    for (const item of SIMPLE_NAV_ITEMS) {
      expect(grouped.has(item.path) || item.path === "/attention", `${item.path}`).toBe(true);
    }
  });
});

describe("the mode applies end-to-end through the shell (cookie → nav + selector)", () => {
  async function pageWithMode(mode: string | undefined): Promise<string> {
    const response = await fetch(`${base}/build`, {
      headers: mode === undefined ? {} : { cookie: `${MODE_COOKIE}=${mode}` },
      redirect: "manual",
    });
    return response.text();
  }

  test("simple mode renders the flat four and not the grouped tree (D2: a mode-ignoring shell fails)", async () => {
    const html = await pageWithMode("simple");
    expect(html).toContain('data-mode="simple"');
    expect(html).toContain(">Work</a>");
    expect(html).toContain(">Results</a>");
    expect(html).toContain(">Approvals</a>");
    // The grouped tree is not rendered in simple mode.
    expect(html).not.toContain("<summary>Build</summary>");
    expect(html).not.toContain("<summary>Control</summary>");
  });

  test("professional (default) renders the grouped tree without the expert-only entries", async () => {
    const html = await pageWithMode(undefined);
    expect(html).not.toContain("data-mode=");
    expect(html).toContain("<summary>Build</summary>");
    expect(html).not.toContain(">Lineage</a>");
  });

  test("expert mode renders the expert-only entries", async () => {
    const html = await pageWithMode("expert");
    expect(html).toContain(">Lineage</a>");
    expect(html).toContain(">Audit</a>");
  });

  test("the mode selector form submits through GET /mode with the return path", async () => {
    const html = await pageWithMode(undefined);
    expect(html).toContain('action="/mode"');
    expect(html).toContain('name="level"');
    expect(html).toContain('name="returnTo"');
  });

  test("GET /mode sets the cookie and redirects back (no-JS path)", async () => {
    const response = await fetch(`${base}/mode?level=simple&returnTo=/runs`, {
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/runs");
    expect(response.headers.get("set-cookie") ?? "").toContain("zeck_mode=simple");
  });

  test("an invalid level falls back to professional (never a 500 or a fabricated mode)", async () => {
    const response = await fetch(`${base}/mode?level=whatever&returnTo=/`, {
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie") ?? "").toContain("zeck_mode=professional");
  });

  test("a hostile returnTo is rejected (open-redirect guard)", async () => {
    const response = await fetch(`${base}/mode?level=expert&returnTo=//evil.example`, {
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
  });
});
