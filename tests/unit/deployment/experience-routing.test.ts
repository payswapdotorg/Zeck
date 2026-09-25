/**
 * PPR-015 — the derived public experience routing projection (the
 * regression surface for the route fall-through defect class).
 *
 * WHAT IS PINNED HERE (the work order's "Required regression
 * protection" items 1-3):
 *  1. the AUTHORITATIVE projection of public experience routes is
 *     DERIVED from the two real route tables — the dashboard's
 *     createDashboardRoutes (the experience route authority) and the
 *     bootstrap API route table (the machine contract authority, the
 *     shared builder the CLI host and the Vercel adapter compose) —
 *     never a hand-duplicated list;
 *  2. every user-visible experience route (every dashboard route whose
 *     path does not collide with a public API route path) is mapped to
 *     the experience function by vercel.json's rewrites;
 *  3. every API-only route (the full API route table) stays on the API
 *     plane — no rewrite may shadow the frozen public API contract.
 *
 * THE CLASS PROTECTION: adding a dashboard route under a new path
 * prefix without exposing it in vercel.json FAILS here (the derived
 * prefix set no longer matches the static artifact); adding an API
 * route that collides with a dashboard experience prefix FAILS here
 * (the mixed-prefix refusal); regressing the root redirect (the Home
 * masquerade defect) FAILS here. The test fails on the CLASS of bug
 * PPR-015 corrected — visible experience routes falling through to the
 * API plane — not only on the exact current URLs.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
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

/** The dashboard's experience route authority (the real route table). */
const DASHBOARD_ROUTES: readonly RoutePatternEntry[] = createDashboardRoutes(STUB_CLIENT, {}).map(
  (route) => ({ method: route.method, pattern: route.pattern }),
);

/** The machine contract authority: the shared bootstrap composition's introspected route table. */
const API_ROUTES: readonly RoutePatternEntry[] = buildBootstrapApp({
  environment: "local",
}).server.routes.map((route) => ({ method: route.method, pattern: route.url }));

const PROJECTION = deriveRoutingProjection(DASHBOARD_ROUTES, API_ROUTES);

/** The first-segment rewrite prefixes vercel.json actually exposes to the experience function. */
function vercelRewritePrefixes(): ReadonlySet<string> {
  const prefixes = new Set<string>();
  for (const rewrite of VERCEL_ROUTING.rewrites) {
    const source = rewrite.source;
    const prefix = source.endsWith("/:path*") ? source.slice(0, -":path*".length - 1) : source;
    prefixes.add(prefix);
  }
  return prefixes;
}

/** True when a pathname routes to the experience function through vercel.json's rewrites. */
function routesToExperience(pathname: string): boolean {
  return VERCEL_ROUTING.rewrites.some((rewrite) => matchesSource(rewrite.source, pathname));
}

describe("PPR-015: the derived projection's integrity", () => {
  test("the two route tables are non-empty and real", () => {
    expect(DASHBOARD_ROUTES.length).toBeGreaterThan(50);
    expect(API_ROUTES.length).toBe(28);
    // The architecture-pinned API route table (public-surface parity).
    expect(API_ROUTES.map((route) => `${route.method} ${route.pattern}`).sort()).toContain(
      "GET /agents",
    );
    expect(API_ROUTES.map((route) => `${route.method} ${route.pattern}`).sort()).toContain(
      "POST /executions",
    );
  });

  test("no prefix is structurally ambiguous (mixed prefixes are a projection failure)", () => {
    expect(PROJECTION.mixedPrefixes).toEqual([]);
  });

  test("the api-owned dashboard routes are exactly the API-plane collisions", () => {
    // The dashboard's legacy /agents + /executions routes collide with the
    // frozen public API contract (GET /agents, GET/POST /executions/...) —
    // the platform's rewrites are method-agnostic, so those PATHS are
    // API-owned on the public origin and must never be rewritten.
    expect(PROJECTION.apiOwnedPrefixes).toEqual(["/agents", "/executions"]);
  });
});

describe("PPR-015: every user-visible experience route is mapped to the experience function", () => {
  test("vercel.json's rewrite prefixes equal the derived experience prefixes (no drift in either direction)", () => {
    const exposed = [...vercelRewritePrefixes()].sort();
    const derived = [...PROJECTION.experiencePrefixes].sort();
    expect(exposed).toEqual(derived);
  });

  test("every experience dashboard route's concrete path resolves to the experience function (the fall-through defect class)", () => {
    const ID = "00000000-0000-7000-8000-0000000000e9";
    for (const route of DASHBOARD_ROUTES) {
      const apiOwned = PROJECTION.apiOwnedPrefixes.some(
        (prefix) => route.pattern === prefix || route.pattern.startsWith(`${prefix}/`),
      );
      if (apiOwned) {
        continue;
      }
      if (route.pattern === "/") {
        continue; // The root bridge — the redirect below pins it.
      }
      const concrete = route.pattern.replace(/:(\w+)/g, ID);
      const rewritten = routesToExperience(concrete);
      expect(rewritten, `${route.method} ${concrete}`).toBe(true);
    }
  });

  test("the experience rewrites carry the original path to the function (the carry contract)", () => {
    const ID = "00000000-0000-7000-8000-0000000000e9";
    expect(routesToExperience("/home")).toBe(true);
    expect(routesToExperience("/build/agents")).toBe(true);
    expect(routesToExperience("/runs/active")).toBe(true);
    expect(routesToExperience(`/runs/${ID}/cancel`)).toBe(true);
    expect(routesToExperience("/assets/client.js")).toBe(true);
    expect(routesToExperience("/console/playground/text")).toBe(true);
    expect(routesToExperience("/command")).toBe(true);
    for (const rewrite of VERCEL_ROUTING.rewrites) {
      expect(rewrite.destination.startsWith("/api/experience?path=/")).toBe(true);
    }
  });
});

describe("PPR-015: API-only routes stay on the API plane (the negative check)", () => {
  test("every route of the FULL API route table falls through to the API function", () => {
    const ID = "00000000-0000-0000-0000-000000000000";
    for (const route of API_ROUTES) {
      const concrete = route.pattern.replace(/:(\w+)/g, ID);
      expect(routesToExperience(concrete), `${route.method} ${concrete}`).toBe(false);
    }
  });

  test("the API-owned dashboard prefixes stay unrewritten (the frozen contract never shadows)", () => {
    for (const prefix of PROJECTION.apiOwnedPrefixes) {
      expect(routesToExperience(prefix), prefix).toBe(false);
      expect(routesToExperience(`${prefix}/${"00000000-0000-0000-0000-000000000000"}`)).toBe(false);
    }
  });
});

describe("PPR-015: the root bridge (the Home masquerade defect class)", () => {
  test("the bare / redirects to the canonical Home experience route (never a renderer, never the console)", () => {
    expect(VERCEL_ROUTING.redirects).toHaveLength(1);
    const rootRedirect = VERCEL_ROUTING.redirects[0];
    expect(rootRedirect?.source).toBe("/");
    expect(rootRedirect?.destination).toBe("/home");
    expect(rootRedirect?.permanent).toBe(false);
    // No dead root rewrite remains (correction #8's platform fact).
    for (const rewrite of VERCEL_ROUTING.rewrites) {
      expect(rewrite.source).not.toBe("/");
    }
    // The redirect's target IS an experience route.
    expect(routesToExperience(rootRedirect?.destination ?? "")).toBe(true);
  });

  test("the dashboard route table's own root is the SAME bridge (local-rail parity with the public rail)", () => {
    const rootRoute = DASHBOARD_ROUTES.find((route) => route.pattern === "/");
    expect(rootRoute?.method).toBe("GET");
    // The handler is a redirect to /home (asserted behaviorally by the
    // gateway integration battery; here the route EXISTS and the /home
    // twin renders the discovery-first Home).
    const homeRoute = DASHBOARD_ROUTES.find((route) => route.pattern === "/home");
    expect(homeRoute?.method).toBe("GET");
    expect(PROJECTION.apiOwnedPrefixes).not.toContain("/home");
  });
});
