/**
 * PPR-017 — the Demo Mirror website route regression tests (the work
 * order: "website route regression tests for the demo surface (the
 * PPR-015 experience-routing pattern: derive the route projection and
 * assert it)").
 *
 * THE PPR-015 PATTERN, applied to the demo surface:
 *  1. the AUTHORITATIVE projection is DERIVED from the two real route
 *     tables — the dashboard's createDashboardRoutes (the experience
 *     route authority) and the bootstrap API route table (the machine
 *     contract authority) — plus vercel.json's grammar, never a
 *     hand-duplicated list;
 *  2. every /console/demos route is an EXPERIENCE route (rewritten to
 *     the experience function through the ALREADY-EXPOSED /console
 *     prefix — no vercel.json change was needed or made);
 *  3. no demo route collides with a public API route path (the frozen
 *     API contract is never shadowed) and no mixed prefix appears;
 *  4. the live server renders every demo route with the honest derived
 *     status content (the derived statuses surface in the HTML and the
 *     machine twins — PARTIAL stays PARTIAL on the wire);
 *  5. the run initiation honestly REFUSES uncertified demos (303 PRG
 *     with the derived reason — never a fabricated run).
 */

import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDashboard } from "../../../apps/dashboard/index";
import { createDashboardRoutes } from "../../../apps/dashboard/pages";
import { buildBootstrapApp } from "../../../deploy/api";
import {
  deriveRoutingProjection,
  matchesSource,
  type RoutePatternEntry,
  type VercelRouting,
} from "../../../deploy/experience-routing";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const VERCEL_ROUTING = JSON.parse(
  readFileSync(join(REPO_ROOT, "vercel.json"), "utf8"),
) as VercelRouting;

/** A stub SDK client: the route table closes over it but never calls it at construction. */
const STUB_CLIENT = {} as Parameters<typeof createDashboardRoutes>[0];

const DASHBOARD_ROUTES: readonly RoutePatternEntry[] = createDashboardRoutes(STUB_CLIENT, {}).map(
  (route) => ({ method: route.method, pattern: route.pattern }),
);

const API_ROUTES: readonly RoutePatternEntry[] = buildBootstrapApp({
  environment: "local",
}).server.routes.map((route) => ({ method: route.method, pattern: route.url }));

const PROJECTION = deriveRoutingProjection(DASHBOARD_ROUTES, API_ROUTES);

/** The demo surface's routes, derived from the real route table. */
const DEMO_ROUTES = DASHBOARD_ROUTES.filter((route) => route.pattern.startsWith("/console/demos"));

/** True when a pathname routes to the experience function through vercel.json's rewrites. */
function routesToExperience(pathname: string): boolean {
  return VERCEL_ROUTING.rewrites.some((rewrite) => matchesSource(rewrite.source, pathname));
}

// ---------------------------------------------------------------------------
// Part 1: the derived routing projection (the PPR-015 pattern)
// ---------------------------------------------------------------------------

describe("the demo surface's derived route projection", () => {
  test("the demo routes exist in the real dashboard route table (5 routes, methods included)", () => {
    expect(DEMO_ROUTES.map((route) => `${route.method} ${route.pattern}`).sort()).toEqual([
      "GET /console/demos",
      "GET /console/demos/:demoId",
      "GET /console/demos/:demoId/facts.json",
      "GET /console/demos/facts.json",
      "POST /console/demos/:demoId/run",
    ]);
  });

  test("every demo route is an EXPERIENCE route via the ALREADY-EXPOSED /console prefix (no vercel.json delta)", () => {
    // The demo routes introduce NO new first-segment prefix: /console
    // was already experience-rewritten before PPR-017 — vercel.json is
    // untouched (the derived prefix set equals the static artifact's).
    const exposed = new Set(
      VERCEL_ROUTING.rewrites.map((rewrite) =>
        rewrite.source.endsWith("/:path*")
          ? rewrite.source.slice(0, -":path*".length - 1)
          : rewrite.source,
      ),
    );
    expect(exposed.has("/console")).toBe(true);
    expect(PROJECTION.experiencePrefixes).toContain("/console");
    const ID = "example-coding-assistant";
    for (const route of DEMO_ROUTES) {
      const concrete = route.pattern.replace(/:(\w+)/g, ID);
      expect(routesToExperience(concrete), `${route.method} ${concrete}`).toBe(true);
    }
  });

  test("no demo route collides with a public API route path (the frozen contract is never shadowed)", () => {
    const apiPatterns = API_ROUTES.map((route) => route.pattern);
    for (const route of DEMO_ROUTES) {
      const collision = apiPatterns.some((apiPattern) =>
        // Same collision rule the projection engine applies.
        patternsCollide(route.pattern, apiPattern),
      );
      expect(collision, `${route.method} ${route.pattern}`).toBe(false);
    }
    // And the projection stays unambiguous.
    expect(PROJECTION.mixedPrefixes).toEqual([]);
    expect(PROJECTION.apiOwnedPrefixes).toEqual(["/agents", "/executions"]);
  });

  test("the static facts.json route precedes the parameterized :demoId route (first-match wins)", () => {
    const routes = DASHBOARD_ROUTES.filter(
      (route) => route.method === "GET" && route.pattern.startsWith("/console/demos/"),
    );
    const factsIndex = routes.findIndex((route) => route.pattern === "/console/demos/facts.json");
    const paramIndex = routes.findIndex((route) => route.pattern === "/console/demos/:demoId");
    expect(factsIndex).toBeGreaterThanOrEqual(0);
    expect(paramIndex).toBeGreaterThan(factsIndex);
  });
});

/** The projection engine's own collision rule, restated for local use. */
function patternsCollide(a: string, b: string): boolean {
  const left = a.split("/").filter((s) => s.length > 0);
  const right = b.split("/").filter((s) => s.length > 0);
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index] ?? "";
    const r = right[index] ?? "";
    if (l === r) {
      continue;
    }
    if (l.startsWith(":") || r.startsWith(":")) {
      continue;
    }
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Part 2: the live server (the real routes, the honest content)
// ---------------------------------------------------------------------------

const fetchImpl = (async (input: string | URL | Request, _init?: RequestInit) => {
  const path = new URL(String(input)).pathname;
  return new Response(
    JSON.stringify({
      code: "PROVIDER_ERROR",
      message: `unexpected path ${path}`,
      retryable: true,
    }),
    { status: 500, headers: { "content-type": "application/json" } },
  );
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

describe("the demo surface on the live server", () => {
  test("the index renders with the honest derived statuses (UNASSESSED + PARTIAL, visually distinct)", async () => {
    const response = await get("/console/demos");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Demo Mirror");
    expect(html).toContain("compat-UNASSESSED");
    expect(html).toContain("compat-PARTIAL");
    // No COMPLETE chip or banner INSTANCE renders (the CSS class
    // definitions exist in the stylesheet; no element carries them).
    expect(html).not.toContain('data-compat-status="AI_EXECUTION_COMPLETE"');
    // The fixture disclosure is visible on the index.
    expect(html).toContain("FIXTURE");
  });

  test("an UNASSESSED demo renders its honest status and the refused run control", async () => {
    const response = await get("/console/demos/example-coding-assistant");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("compat-UNASSESSED");
    expect(html).toContain("No certified run exists");
    expect(html).toContain("No Zeck executions correlated");
  });

  test("a PARTIAL demo renders its honest status, its findings and the provider-blocked edge", async () => {
    const response = await get("/console/demos/example-rag-knowledge-app");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("compat-PARTIAL");
    // The fixture-basis disclosure (rule 5's honest naming — the
    // record's own limitation statement renders verbatim).
    expect(html).toContain("never counts as an external PASS");
    // The provider-blocked reranking edge is named with its owner.
    expect(html).toContain("retrieval-reranking");
    expect(html).toContain("provider");
    // The correlated fixture traces render in the timeline.
    expect(html).toContain("Zeck execution timeline");
  });

  test("the five admission rules render with their per-rule results (auditable honesty)", async () => {
    const response = await get("/console/demos/example-rag-knowledge-app");
    const html = await response.text();
    for (const rule of [
      "EVERY_DECLARED_EDGE_DELEGATED",
      "DIRECT_EGRESS_ABSENT_OR_BLOCKED",
      "CORPUS_FUNCTIONALLY_USABLE",
      "ZECK_EVIDENCE_FOR_EVERY_DELEGATED_EDGE",
      "NO_FIXTURE_COUNTED_AS_EXTERNAL_PASS",
    ]) {
      expect(html).toContain(rule);
    }
  });

  test("the machine twins carry the SAME derived statuses as the HTML (no drift between the two projections)", async () => {
    const index = (await (await get("/console/demos/facts.json")).json()) as {
      demos: { status: string }[];
    };
    expect(index.demos.map((demo) => demo.status).sort()).toEqual(["PARTIAL", "UNASSESSED"]);

    const partial = (await (
      await get("/console/demos/example-rag-knowledge-app/facts.json")
    ).json()) as {
      projection: { status: string; runAvailability: { available: boolean } };
      zeckTraces: { correlated: boolean }[];
    };
    expect(partial.projection.status).toBe("PARTIAL");
    expect(partial.projection.runAvailability.available).toBe(false);
    expect(partial.zeckTraces.every((trace) => trace.correlated)).toBe(true);
  });

  test("the run initiation REFUSES an uncertified demo (303 PRG with the derived reason, never a fabricated run)", async () => {
    const response = await fetch(`${base}/console/demos/example-coding-assistant/run`, {
      method: "POST",
      body: "",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith("/console/demos/example-coding-assistant?run=")).toBe(true);
    const reason = decodeURIComponent(location.split("run=")[1] ?? "");
    expect(reason).toContain("never");
    // The refusal notice renders on the redirected detail page.
    const detail = await get(
      `/console/demos/example-coding-assistant?run=${location.split("run=")[1] ?? ""}`,
    );
    const html = await detail.text();
    expect(html).toContain("Run refused");
  });

  test("an unknown demo id renders the honest error page (never a guessed projection)", async () => {
    const response = await get("/console/demos/no-such-demo");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("This demo does not exist");
  });

  test("the demo routes appear once each in the full route table (no accidental shadowing)", () => {
    const demoPatterns = DASHBOARD_ROUTES.filter((route) =>
      route.pattern.startsWith("/console/demos"),
    ).map((route) => route.pattern);
    expect(new Set(demoPatterns).size).toBe(demoPatterns.length);
  });
});
