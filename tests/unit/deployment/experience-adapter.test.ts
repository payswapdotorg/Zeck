/**
 * PPR-007 unit tests — the experience-surface hosting adapter's
 * semantics (deploy/experience.ts) + the routing split's truth table
 * (vercel.json's rewrites).
 *
 * WHAT IS PINNED HERE (the work order's verification battery):
 *  - FAIL-CLOSED INPUTS: a missing API URL or application id refuses
 *    the entry at cold start (structural misconfiguration — the exact
 *    actionable messages); an UNBOUND TOKEN is a legitimate honest
 *    mode (the inputs read back with an empty credential — STILL
 *    SERVE);
 *  - THE ROUTING CARRY: the platform's documented capture-to-query
 *    rewrite conversion is reversed exactly — every carried experience
 *    path reconstructs (deep paths, the root, merged query parameters
 *    preserved), a request without the carry passes through unchanged
 *    (the local rail), and a `path` value that is not an absolute path
 *    is a client's own parameter (never a rewrite of the URL);
 *  - THE SINGLETON: the module-level holder builds the composition
 *    once per isolate and returns the same listener; a structurally
 *    misconfigured environment refuses it;
 *  - THE ROUTING SPLIT'S TRUTH TABLE (structural, over vercel.json):
 *    every experience path (/, /console/*, /trust/*, /admin/* and the
 *    composition's own /assets/client.js asset) routes to the
 *    experience function; EVERY public API route of the architecture
 *    table falls through to the existing API function (unchanged), and
 *    the dashboard's non-experience paths honestly fall through too
 *    (the work order's explicit split).
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  buildExperienceHandler,
  EXPERIENCE_PATH_QUERY,
  experienceRequestPath,
  getExperienceHandler,
  readExperienceInputs,
} from "../../../deploy/experience";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

interface VercelJson {
  readonly framework: string;
  readonly redirects: readonly {
    readonly source: string;
    readonly destination: string;
    readonly permanent: boolean;
  }[];
  readonly rewrites: readonly {
    readonly source: string;
    readonly destination: string;
  }[];
}

const VERCEL_JSON = JSON.parse(readFileSync(join(REPO_ROOT, "vercel.json"), "utf8")) as VercelJson;

/**
 * A 22-route probe superset of the architecture-pinned public API route
 * table (public-surface.test.ts M21): all 18 GET routes plus 4
 * POST-route pathnames (/codebase-analysis, /economic-actions,
 * /executions, /executions/:id/cancel) included for fall-through
 * coverage — each is probed as a bare pathname against the routing
 * split, not as a claim that it is a GET route.
 */
const PUBLIC_API_ROUTES: readonly string[] = [
  "GET /agents",
  "GET /agents/:id",
  "GET /agents/:id/status",
  "GET /agents/:id/versions",
  "GET /codebase-analysis",
  "GET /codebase-analysis/:id",
  "GET /credentials",
  "GET /economic-actions",
  "GET /economic-actions/:id",
  "GET /economic-actions/:id/events",
  "GET /economic-actions/:id/outcome",
  "GET /executions",
  "GET /executions/:id",
  "GET /executions/:id/cancel",
  "GET /executions/:id/events",
  "GET /executions/:id/results",
  "GET /executions/:id/verification",
  "GET /health",
  "GET /identity",
  "GET /sandbox/data-policy",
  "GET /sandbox/identities/:identityId",
  "GET /sandbox/quotas",
];

/**
 * The vercel.json source grammar this repository uses (the documented
 * path-to-regexp shapes): an exact source matches itself; a
 * `/:path*`-suffixed source matches the bare base and every deeper
 * path.
 */
function matchesSource(source: string, pathname: string): boolean {
  if (source.endsWith("/:path*")) {
    const base = source.slice(0, -":path*".length);
    return pathname === base.slice(0, -1) || pathname.startsWith(base);
  }
  return pathname === source;
}

/** True when vercel.json's rewrites route the pathname to the experience function (null/destination otherwise). */
function routesToExperience(pathname: string): boolean {
  for (const rewrite of VERCEL_JSON.rewrites) {
    if (matchesSource(rewrite.source, pathname)) {
      return true;
    }
  }
  return false;
}

/** The rewrite a pathname first matches (the truth-table evidence), or null. */
function matchingRewrite(pathname: string): VercelJson["rewrites"][number] | null {
  for (const rewrite of VERCEL_JSON.rewrites) {
    if (matchesSource(rewrite.source, pathname)) {
      return rewrite;
    }
  }
  return null;
}

/** A representative id-shaped path segment. */
const ID = "00000000-0000-7000-8000-0000000000e9";

describe("PPR-007: the experience adapter's inputs (fail closed structurally, still serve unbound)", () => {
  test("a missing API URL refuses the entry (structural misconfiguration)", () => {
    expect(() =>
      readExperienceInputs({
        ZECK_EXPERIENCE_APPLICATION_ID: "app-1",
        ZECK_EXPERIENCE_TOKEN: "materialized",
      }),
    ).toThrow(/ZECK_EXPERIENCE_API_URL/);
  });

  test("a missing application id refuses the entry (a scopeless dashboard cannot exist)", () => {
    expect(() =>
      readExperienceInputs({
        ZECK_EXPERIENCE_API_URL: "https://plane.example",
        ZECK_EXPERIENCE_TOKEN: "materialized",
      }),
    ).toThrow(/ZECK_EXPERIENCE_APPLICATION_ID/);
  });

  test("an UNBOUND token is a legitimate honest mode: the inputs read back with an empty credential", () => {
    const unbound = readExperienceInputs({
      ZECK_EXPERIENCE_API_URL: "https://plane.example/",
      ZECK_EXPERIENCE_APPLICATION_ID: "app-1",
    });
    expect(unbound).toEqual({
      apiUrl: "https://plane.example/",
      token: "",
      applicationId: "app-1",
    });
    const explicitlyEmpty = readExperienceInputs({
      ZECK_EXPERIENCE_API_URL: "https://plane.example/",
      ZECK_EXPERIENCE_APPLICATION_ID: "app-1",
      ZECK_EXPERIENCE_TOKEN: "",
    });
    expect(explicitlyEmpty.token).toBe("");
  });

  test("a fully-bound environment reads back its inputs", () => {
    const bound = readExperienceInputs({
      ZECK_EXPERIENCE_API_URL: "https://plane.example",
      ZECK_EXPERIENCE_APPLICATION_ID: "app-1",
      ZECK_EXPERIENCE_TOKEN: "materialized",
    });
    expect(bound).toEqual({
      apiUrl: "https://plane.example",
      token: "materialized",
      applicationId: "app-1",
    });
  });
});

describe("PPR-007: the routing carry (the documented capture-to-query conversion, reversed exactly)", () => {
  test("every carried experience path reconstructs", () => {
    expect(experienceRequestPath(`/api/experience?${EXPERIENCE_PATH_QUERY}=/console`)).toBe(
      "/console",
    );
    expect(
      experienceRequestPath(`/api/experience?${EXPERIENCE_PATH_QUERY}=/console/playground/text`),
    ).toBe("/console/playground/text");
    expect(
      experienceRequestPath(
        `/api/experience?${EXPERIENCE_PATH_QUERY}=/console/executions/${ID}/export/bundle.json`,
      ),
    ).toBe(`/console/executions/${ID}/export/bundle.json`);
    expect(experienceRequestPath(`/api/experience?${EXPERIENCE_PATH_QUERY}=/trust/evidence`)).toBe(
      "/trust/evidence",
    );
    expect(experienceRequestPath(`/api/experience?${EXPERIENCE_PATH_QUERY}=/admin/policies`)).toBe(
      "/admin/policies",
    );
    expect(experienceRequestPath(`/api/experience?${EXPERIENCE_PATH_QUERY}=/`)).toBe("/");
    expect(
      experienceRequestPath(`/api/experience?${EXPERIENCE_PATH_QUERY}=/assets/client.js`),
    ).toBe("/assets/client.js");
  });

  test("the request's own query parameters are preserved after the carry", () => {
    expect(
      experienceRequestPath(
        `/api/experience?applicationId=app-1&${EXPERIENCE_PATH_QUERY}=/console/playground/text`,
      ),
    ).toBe("/console/playground/text?applicationId=app-1");
    expect(
      experienceRequestPath(`/api/experience?${EXPERIENCE_PATH_QUERY}=/console&edit=1&x=2`),
    ).toBe("/console?edit=1&x=2");
  });

  test("a request without the carry passes through unchanged (the local rail)", () => {
    expect(experienceRequestPath("/console/playground/text")).toBe("/console/playground/text");
    expect(experienceRequestPath("/")).toBe("/");
    expect(experienceRequestPath(undefined)).toBe("/");
  });

  test("a direct hit on the function's own path answers it (no rewrite)", () => {
    expect(experienceRequestPath("/api/experience")).toBe("/api/experience");
    expect(experienceRequestPath("/api/experience?other=1")).toBe("/api/experience?other=1");
  });

  test("a `path` value that is not an absolute path is a client's own parameter (never a URL rewrite)", () => {
    expect(experienceRequestPath(`/api/experience?${EXPERIENCE_PATH_QUERY}=bogus`)).toBe(
      `/api/experience?${EXPERIENCE_PATH_QUERY}=bogus`,
    );
    expect(experienceRequestPath(`/api/experience?${EXPERIENCE_PATH_QUERY}=`)).toBe(
      `/api/experience?${EXPERIENCE_PATH_QUERY}=`,
    );
  });
});

describe("PPR-007: the singleton (once per isolate)", () => {
  test("a structurally sound environment builds the listener once and reuses it", () => {
    const before = process.env.ZECK_EXPERIENCE_API_URL;
    process.env.ZECK_EXPERIENCE_API_URL = "https://plane.example";
    process.env.ZECK_EXPERIENCE_APPLICATION_ID = "app-singleton";
    delete process.env.ZECK_EXPERIENCE_TOKEN;
    try {
      const first = getExperienceHandler();
      const second = getExperienceHandler();
      expect(typeof first).toBe("function");
      expect(second).toBe(first);
    } finally {
      if (before === undefined) {
        delete process.env.ZECK_EXPERIENCE_API_URL;
      } else {
        process.env.ZECK_EXPERIENCE_API_URL = before;
      }
      delete process.env.ZECK_EXPERIENCE_APPLICATION_ID;
    }
  });

  test("buildExperienceHandler composes the dashboard listener over the inputs", async () => {
    const handler = buildExperienceHandler({
      apiUrl: "https://plane.example",
      token: "",
      applicationId: "app-1",
    });
    expect(typeof handler).toBe("function");
    // the carry runs before every dispatch (the URL is rewritten when present)
    expect(handler.length).toBe(2);
  });
});

describe("PPR-007: the routing split's truth table (vercel.json rewrites)", () => {
  test("vercel.json still pins the Fastify framework detection (PPR-006's entry, unchanged)", () => {
    expect(VERCEL_JSON.framework).toBe("fastify");
  });

  test("every experience path routes to the experience function with its original path carried", () => {
    const experiencePaths = [
      "/console",
      "/console/playground",
      "/console/playground/text",
      "/console/playground/long-running/example",
      "/console/catalog",
      "/console/start",
      "/console/quickstart",
      "/console/applications",
      "/console/applications/keys",
      "/console/applications/environments",
      "/console/applications/usage",
      `/console/applications/${ID}`,
      "/console/executions",
      "/console/executions/facts.json",
      `/console/executions/${ID}`,
      `/console/executions/${ID}/facts.json`,
      `/console/executions/${ID}/export`,
      `/console/executions/${ID}/export/bundle.json`,
      "/console/compare",
      "/console/compare/facts.json",
      "/console/usage",
      "/console/usage/facts.json",
      "/console/validation",
      "/console/validation/api/catalog.json",
      "/console/validation/api/schema.json",
      `/console/validation/api/${ID}`,
      "/console/validation/evidence/deep-work",
      "/console/providers",
      "/console/docs",
      "/console/settings",
      "/trust/evidence",
      "/trust/limits",
      "/trust/lineage",
      "/admin/policies",
      "/admin/budgets",
      "/admin/team",
      "/admin/environments",
      "/admin/audit",
      "/assets/client.js",
    ];
    for (const path of experiencePaths) {
      const rewrite = matchingRewrite(path);
      expect(rewrite, path).not.toBeNull();
      expect(
        rewrite?.destination.startsWith(`/api/experience?${EXPERIENCE_PATH_QUERY}=/`),
        path,
      ).toBe(true);
    }
    // The exact-path rewrites carry the original path bit-for-bit (the
    // reconstruction the adapter reverses):
    expect(matchingRewrite("/console")?.destination).toBe(
      `/api/experience?${EXPERIENCE_PATH_QUERY}=/console`,
    );
    expect(matchingRewrite("/trust")?.destination).toBe(
      `/api/experience?${EXPERIENCE_PATH_QUERY}=/trust`,
    );
    expect(matchingRewrite("/admin")?.destination).toBe(
      `/api/experience?${EXPERIENCE_PATH_QUERY}=/admin`,
    );
    expect(matchingRewrite("/assets/client.js")?.destination).toBe(
      `/api/experience?${EXPERIENCE_PATH_QUERY}=/assets/client.js`,
    );
    // The wildcard rewrites carry the source prefix + the captured tail:
    expect(matchingRewrite("/console/playground/text")?.destination).toBe(
      `/api/experience?${EXPERIENCE_PATH_QUERY}=/console/:path*`,
    );
  });

  test("the root lands on the experience surface through the platform redirect (the live plane's finding: the framework's root function shadows any root rewrite)", () => {
    // THE FINDING (the §13.6 credentialed run, 2026-09-23): the root
    // `index.func` of the framework build is a FILESYSTEM match for "/",
    // and vercel.json rewrites run AFTER the filesystem phase — the
    // original `"source": "/"` rewrite was DEAD on the platform ("/"
    // answered the API plane's Fastify 404 JSON while /console served
    // the experience composition). Redirects run BEFORE the filesystem
    // phase, so the root now lands on /console — whose rewrite carries
    // the composition the landing was always meant to serve.
    expect(VERCEL_JSON.redirects).toHaveLength(1);
    const rootRedirect = VERCEL_JSON.redirects[0];
    expect(rootRedirect?.source).toBe("/");
    expect(rootRedirect?.destination).toBe("/console");
    expect(rootRedirect?.permanent).toBe(false);
    // No dead rewrite remains: every rewrite destination is the experience
    // function, and none of them sources the root.
    for (const rewrite of VERCEL_JSON.rewrites) {
      expect(rewrite.source).not.toBe("/");
    }
    // The redirect's target routes to the experience function (the
    // landing resolves to the composition over the real routing chain).
    expect(routesToExperience(rootRedirect?.destination ?? "")).toBe(true);
  });

  test("EVERY public API route falls through to the existing API function (unchanged)", () => {
    for (const route of PUBLIC_API_ROUTES) {
      const pathname = route.replace(/^GET |^POST /, "").replace(/:(\w+)/g, "concrete");
      expect(routesToExperience(pathname), route).toBe(false);
    }
  });

  test("the dashboard's non-experience paths honestly fall through to the API function (the work order's split)", () => {
    for (const path of [
      "/runs",
      "/runs/active",
      "/build",
      "/build/execution",
      "/agents",
      `/executions/${ID}`,
      "/deployments",
      "/improve/evaluations",
      "/assets/artifacts",
      "/home",
      "/mode",
      "/appearance",
      "/command",
      "/attention",
    ]) {
      expect(routesToExperience(path), path).toBe(false);
    }
  });

  test("every rewrite destination is the experience function carrying the path parameter", () => {
    expect(VERCEL_JSON.rewrites.length).toBeGreaterThan(0);
    for (const rewrite of VERCEL_JSON.rewrites) {
      expect(rewrite.destination.startsWith(`/api/experience?${EXPERIENCE_PATH_QUERY}=/`)).toBe(
        true,
      );
    }
  });
});
