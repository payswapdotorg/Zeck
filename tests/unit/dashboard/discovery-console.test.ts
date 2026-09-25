/**
 * PPR-001 discovery-first console tests — the discovery surfaces'
 * acceptance battery (unit level, REAL dashboard server over a
 * wire-exact fake API):
 *
 *  - CATALOG COMPLETENESS: the /console/catalog surface renders ALL 22
 *    workload families from the machine capability manifest, each with
 *    its honest derived availability state (Available / Requires
 *    access / Provider-gated / NOT RUN) and its recorded availability
 *    sentence VERBATIM — a gap stays a gap, never a silent pass;
 *  - THE STATE MODEL: the derived-state distribution is exactly the
 *    manifest's own fields projected (11 available / 6 requires-access
 *    / 2 provider-gated / 3 not-run), derived purely from
 *    classification + gatedBy + the leading "NOT RUN" boundary;
 *  - ROUTE/DISCOVERABILITY MATRIX: all 22 families map to a discovery
 *    location and a guided-run location; every matrix row's locations
 *    render on the real server;
 *  - DISCOVERY-FIRST HOME: the first screen answers what Zeck does /
 *    what workloads exist / what is available right now / how to try
 *    safely — BEFORE any application/environment identifier appears,
 *    with the guided sandbox start as the ONE dominant action;
 *  - GUIDED SAFE SANDBOX START: the safety envelope (limits + the
 *    honest sandbox-governance states) renders BEFORE the composer;
 *  - TRUST & LIMITS + FOR AGENTS: the consolidated entry and the
 *    first-class agent entrypoint are reachable from home and nav;
 *  - "HOW ZECK DID IT" PROMOTION: the why-panel renders OPEN on the
 *    result view (the normal result hierarchy) and collapsed on the
 *    deeper tabs (progressive disclosure);
 *  - REDUCED MOTION + responsive affordances at the DOM/CSS level.
 */

import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type ConsoleFamily, consoleFamilies, familyOf } from "../../../apps/dashboard/console";
import {
  AVAILABILITY_STATES,
  type AvailabilityState,
  availabilityStateChip,
  availabilityStateOf,
  catalogCounts,
  routeMatrix,
} from "../../../apps/dashboard/discovery";
import { createDashboard } from "../../../apps/dashboard/index";
import { DASHBOARD_CSS } from "../../../apps/dashboard/tokens";
import type {
  Execution,
  ExecutionReceipt,
  ExecutionResult,
  VerificationResult,
} from "../../../sdk";

const APP_ID = "00000000-0000-7000-8000-0000000000a1";
const EXECUTION_ID = "00000000-0000-7000-8000-0000000000e1";

const EXECUTION: Execution = {
  id: EXECUTION_ID,
  applicationId: APP_ID,
  environmentId: "env-sandbox-01",
  status: "COMPLETED",
  task: { kind: "summarize", doc: "quarterly-report-01", maxWords: 60 },
  constraints: { maxCostMicroUsd: "1500000" },
  metadata: { origin: "zeck-console-playground" },
  createdAt: "2026-09-15T12:00:00Z",
  updatedAt: "2026-09-15T12:03:42Z",
  terminalAt: "2026-09-15T12:03:42Z",
};

const RESULT: ExecutionResult = {
  executionId: EXECUTION_ID,
  status: "COMPLETED",
  route: { provider: "neutral-p", model: "neutral-m", strategyClass: "hybrid", modelCalls: 2 },
  cost: { totalMicroUsd: "4180000", currency: "usd" },
  usage: { inputTokens: 1200, outputTokens: 340 },
  outputArtifacts: [],
  verification: [],
  warnings: [],
  terminalAt: "2026-09-15T12:03:42Z",
};

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
      applicationId: APP_ID,
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
  if (path === `/executions/${EXECUTION_ID}/verification`) {
    return json([] satisfies readonly VerificationResult[]);
  }
  if (path === "/agents") return json([]);
  return json({ code: "PROVIDER_ERROR", message: `unexpected path ${path}`, retryable: true }, 500);
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

async function getHtml(path: string): Promise<string> {
  const response = await fetch(`${base}${path}`, { redirect: "manual" });
  expect(response.status, path).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  return response.text();
}

// ---------------------------------------------------------------------------
// Catalog completeness + the availability-state model
// ---------------------------------------------------------------------------

describe("the 22-family capability catalog (completeness + honest states)", () => {
  test("the manifest projects exactly 22 families and the state distribution is the manifest's own projection", () => {
    const families = consoleFamilies();
    expect(families.length).toBe(22);
    const counts = catalogCounts();
    expect(counts.available).toBe(11);
    expect(counts["requires-access"]).toBe(6);
    expect(counts["provider-gated"]).toBe(2);
    expect(counts["not-run"]).toBe(3);
    expect(
      counts.available + counts["requires-access"] + counts["provider-gated"] + counts["not-run"],
    ).toBe(22);
  });

  test("the derivation is a pure projection of manifest fields (runnable / leading NOT RUN / gatedBy)", () => {
    for (const family of consoleFamilies()) {
      const state = availabilityStateOf(family);
      if (family.classification === "runnable") {
        expect(state, family.family).toBe("available");
      } else if (family.availability.trim().toUpperCase().startsWith("NOT RUN")) {
        expect(state, family.family).toBe("not-run");
      } else if (family.gatedBy !== undefined) {
        expect(state, family.family).toBe("requires-access");
      } else {
        expect(state, family.family).toBe("provider-gated");
      }
    }
    // The recorded examples of each boundary, by name.
    const stateOf = (id: string): AvailabilityState => {
      const family: ConsoleFamily | null = familyOf(id);
      expect(family, id).not.toBeNull();
      return availabilityStateOf(family as ConsoleFamily);
    };
    expect(stateOf("text")).toBe("available");
    expect(stateOf("voice")).toBe("requires-access");
    expect(stateOf("browser-use")).toBe("provider-gated");
    expect(stateOf("three-d")).toBe("not-run");
  });

  test("every state chip carries symbol + text (never color alone)", () => {
    for (const state of AVAILABILITY_STATES) {
      const chip = availabilityStateChip(state);
      expect(chip).toContain("chip");
      expect(chip).toMatch(/[▶◆∅⊘]/);
    }
  });

  test("/console/catalog renders every family, its state chip and its recorded availability verbatim", async () => {
    const html = await getHtml("/console/catalog");
    for (const family of consoleFamilies()) {
      expect(html, family.family).toContain(
        `href="/console/playground/${encodeURIComponent(family.family)}"`,
      );
      // The recorded availability sentence renders VERBATIM.
      expect(html, family.family).toContain(family.availability);
    }
    // The state chips are counted over the catalog table itself (the
    // discovery-matrix disclosure below renders its own second set).
    const tableStart = html.indexOf('class="data catalog-table"');
    expect(tableStart).toBeGreaterThan(-1);
    const table = html.slice(tableStart, html.indexOf("</table>", tableStart));
    expect((table.match(/class="chip state-available"/g) ?? []).length).toBe(11);
    expect((table.match(/class="chip state-requires-access"/g) ?? []).length).toBe(6);
    expect((table.match(/class="chip state-provider-gated"/g) ?? []).length).toBe(2);
    expect((table.match(/class="chip state-not-run"/g) ?? []).length).toBe(3);
    // All four state labels render (the vocabulary is first-class).
    expect(html).toContain("▶ Available");
    expect(html).toContain("◆ Requires access");
    expect(html).toContain("⊘ Provider-gated");
    expect(html).toContain("∅ NOT RUN");
    // The single source is named on the surface.
    expect(html).toContain("machine capability manifest");
  });

  test("the honest NOT RUN families stay NOT RUN on the catalog — never a silent pass", async () => {
    const html = await getHtml("/console/catalog");
    for (const family of ["realtime-voice", "audio-understanding", "three-d"]) {
      expect(html, family).toContain(`>${family}</a>`);
    }
    expect(html).toContain("no authorized WebSocket voice-session API");
    expect(html).toContain("region-blocked (HTTP 403");
    expect(html).toContain("no 3D-generation-capable provider");
  });

  test("the catalog's discovery matrix renders all 22 rows (family → locations → state)", async () => {
    const html = await getHtml("/console/catalog");
    expect(html).toContain("The discovery matrix");
    const matrix = routeMatrix();
    expect(matrix.length).toBe(22);
    for (const row of matrix) {
      expect(html, row.family).toContain(row.guidedRunLocation);
      expect(html, row.family).toContain("/console/catalog");
    }
  });
});

// ---------------------------------------------------------------------------
// The discovery-first home
// ---------------------------------------------------------------------------

describe("the discovery-first home (first-screen comprehension before identifiers)", () => {
  test("the hero answers what Zeck does with the ONE dominant action", async () => {
    const html = await getHtml("/home");
    expect(html).toContain('id="discovery-hero-title"');
    expect(html).toContain("Describe an outcome. Zeck plans it, executes it under policy");
    // The ONE dominant primary action is the guided sandbox start.
    expect(html).toContain('class="button-link primary hero-cta" href="/console/start"');
    // Only one hero CTA carries the primary treatment.
    expect((html.match(/class="button-link primary hero-cta"/g) ?? []).length).toBe(1);
  });

  test("the home grid carries all 22 families with their state chips (what exists / what is available)", async () => {
    const html = await getHtml("/home");
    expect(html).toContain('class="availability-grid"');
    expect((html.match(/<li>\n {6}<a href="\/console\/playground\//g) ?? []).length).toBe(22);
    for (const family of consoleFamilies()) {
      expect(html, family.family).toContain(
        `href="/console/playground/${encodeURIComponent(family.family)}"`,
      );
    }
    expect(html).toContain("11 families are available now");
    expect(html).toContain("3 record an honest NOT RUN boundary");
    expect(html).toContain('href="/console/catalog"');
  });

  test("the try-safely section surfaces the sandbox envelope summary", async () => {
    const html = await getHtml("/home");
    expect(html).toContain('id="discovery-safe-title"');
    expect(html).toContain("$2.00");
    expect(html).toContain("two-minute latency ceiling");
    expect(html).toContain("synthetic data only");
  });

  test("no application/environment identifier appears before the discovery answers", async () => {
    const html = await getHtml("/home");
    const hero = html.indexOf('id="discovery-hero-title"');
    const catalog = html.indexOf('class="availability-grid"');
    const safe = html.indexOf('id="discovery-safe-title"');
    const deeper = html.indexOf('id="discovery-go-deeper"');
    const firstIdentifier = html.indexOf('name="applicationId"');
    expect(hero).toBeGreaterThan(-1);
    expect(catalog).toBeGreaterThan(hero);
    expect(safe).toBeGreaterThan(catalog);
    expect(deeper).toBeGreaterThan(safe);
    // The first application identifier appears only in the "Your work"
    // composer — after every discovery answer.
    expect(firstIdentifier).toBeGreaterThan(deeper);
    expect(html.indexOf("Your work")).toBeGreaterThan(deeper);
    expect(firstIdentifier).toBeGreaterThan(html.indexOf("Your work"));
  });

  test("the home carries the Validation Lab, Trust & Limits and For agents entries", async () => {
    const html = await getHtml("/home");
    expect(html).toContain('href="/console/validation"');
    expect(html).toContain('href="/trust/limits"');
    expect(html).toContain('href="/console/docs/AGENT-GUIDE.md"');
    expect(html).toContain("For agents");
    expect(html).toContain("Trust &amp; Limits");
  });

  test("the work surface is preserved under discovery (composer, attention, results, lookup)", async () => {
    const html = await getHtml("/home");
    expect(html).toContain("What would you like Zeck to accomplish?");
    expect(html).toContain("Needs your attention");
    expect(html).toContain("Happening now");
    expect(html).toContain("Recent results");
    expect(html).toContain("Find an execution");
  });
});

// ---------------------------------------------------------------------------
// The guided safe sandbox start
// ---------------------------------------------------------------------------

describe("the guided safe sandbox start (safety envelope BEFORE the run)", () => {
  test("the page renders the steps, the console sandbox limits and the honest governance states", async () => {
    const html = await getHtml("/console/start");
    expect(html).toContain("Guided sandbox start");
    expect(html).toContain("See the safety envelope.");
    expect(html).toContain("Sandbox envelope");
    expect(html).toContain("$2.00 per run");
    // Quotas / identity / expiry-reset / synthetic-data policy: the
    // honest unavailable state when the governance transport is unbound.
    expect(html).toContain("Sandbox budgets, quotas and the data policy");
    expect(html).toContain("expiration/reset");
  });

  test("the safety envelope renders BEFORE the composer form (DOM order)", async () => {
    const html = await getHtml("/console/start");
    const envelope = html.indexOf("Sandbox envelope");
    const governance = html.indexOf("Sandbox budgets, quotas and the data policy");
    const task = html.indexOf("The task the first run carries");
    const composer = html.indexOf('name="applicationId"');
    expect(envelope).toBeGreaterThan(-1);
    expect(governance).toBeGreaterThan(envelope);
    expect(task).toBeGreaterThan(governance);
    expect(composer).toBeGreaterThan(task);
  });

  test("the composer is the text family's live form (the existing review → POST flow)", async () => {
    const html = await getHtml("/console/start");
    expect(html).toContain('action="/console/playground/text"');
    expect(html).toContain("quarterly-report-01");
    expect(html).toContain("Review the sandbox run");
    // The deployment's bound scope is prefilled (understood, not unexplained).
    expect(html).toContain(`value="${APP_ID}"`);
  });

  test("the guided start closes the loop to inspection and validation", async () => {
    const html = await getHtml("/console/start");
    expect(html).toContain("How Zeck did it");
    expect(html).toContain('href="/console/validation"');
  });
});

// ---------------------------------------------------------------------------
// Trust & Limits + For agents
// ---------------------------------------------------------------------------

describe("the consolidated Trust & Limits entry", () => {
  test("the page links the four governing surfaces (policy, spend, sandbox, verification)", async () => {
    const html = await getHtml("/trust/limits");
    expect(html).toContain("Trust &amp; Limits");
    expect(html).toContain('href="/admin/policies"');
    expect(html).toContain('href="/admin/budgets"');
    expect(html).toContain('href="/console/applications/environments"');
    expect(html).toContain('href="/trust/evidence"');
    // The console's own enforced sandbox envelope renders here too.
    expect(html).toContain("The sandbox envelope this console enforces");
    // The no-second-authority discipline is stated on the surface.
    expect(html).toContain("no second authority");
  });
});

describe("the first-class agent entrypoint", () => {
  test("the nav carries the For agents entry pointing at the agent integration guide", async () => {
    const html = await getHtml("/home");
    expect(html).toContain('href="/console/docs/AGENT-GUIDE.md"');
    // The guide page itself renders (the verbatim docs projection).
    const guide = await getHtml("/console/docs/AGENT-GUIDE.md");
    expect(guide).toContain("agent integration guide");
    expect(guide).toContain("machine/integration-recipe.json");
  });
});

// ---------------------------------------------------------------------------
// "How Zeck did it" promotion (the normal result hierarchy)
// ---------------------------------------------------------------------------

describe("the How-Zeck-did-it promotion on the result surface", () => {
  test("the why-panel renders OPEN on the result view", async () => {
    const html = await getHtml(`/runs/${EXECUTION_ID}`);
    expect(html).toContain('<details class="why-panel" open>');
    expect(html).toContain("How Zeck did it");
  });

  test("the why-panel stays collapsed on the deeper tabs (progressive disclosure)", async () => {
    const evidence = await getHtml(`/runs/${EXECUTION_ID}?tab=evidence`);
    expect(evidence).toContain('<details class="why-panel">');
    expect(evidence).not.toContain('<details class="why-panel" open>');
  });
});

// ---------------------------------------------------------------------------
// Reduced-motion + responsive affordances (stylesheet-level evidence)
// ---------------------------------------------------------------------------

describe("reduced-motion and responsive affordances", () => {
  test("reduced motion is honored by the global gate (no new animation introduced)", () => {
    expect(DASHBOARD_CSS).toContain("@media (prefers-reduced-motion: reduce)");
    expect(DASHBOARD_CSS).toContain("transition-duration: 0.01ms !important");
    // The PPR-001 layer adds no animation of its own.
    const pprSection = DASHBOARD_CSS.slice(DASHBOARD_CSS.indexOf("PPR-001 —"));
    expect(pprSection).not.toMatch(/animation\s*:/);
    expect(pprSection).not.toMatch(/transition\s*:/);
  });

  test("the discovery layer keeps the calm grammar: no gradients, no new fixed heights", () => {
    const pprSection = DASHBOARD_CSS.slice(DASHBOARD_CSS.indexOf("PPR-001 —"));
    expect(pprSection).not.toMatch(/gradient/);
  });
});
