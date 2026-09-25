/**
 * PPR-015 — the local TWO-FUNCTION composition regression battery.
 *
 * WHAT IS PINNED HERE (the work order's "Required regression
 * protection" items 4-6 at the composition level, plus the routing
 * boundary itself): deploy/local-experience-gateway.ts composes the
 * REAL API plane (the shared bootstrap builder) and the REAL
 * experience plane (deploy/experience.ts's buildExperienceHandler —
 * the exact composition the Vercel experience function serves) behind
 * vercel.json's routing grammar, and this battery drives the composite
 * over real HTTP:
 *
 *  - the ROOT BRIDGE: the bare / answers the platform redirect to the
 *    canonical Home experience route (never the console masquerade);
 *  - the HOME EXPERIENCE: the outcome explanation, the 22-family
 *    capability grid with its four honest states, the discovery
 *    affordances and the guided safe start are all served on the
 *    landing path;
 *  - EVERY VISIBLE NAVIGATION DESTINATION (derived from the nav
 *    grammar — NAV_GROUPS + SIMPLE_NAV_ITEMS + MOBILE_NAV_ITEMS, the
 *    IA authority, never a hand-duplicated URL list) answers on the
 *    EXPERIENCE plane (HTML, or the designed honest HTML state —
 *    never the API plane's raw JSON: the fall-through defect class);
 *  - the API-ONLY boundary: the machine routes (/health, /identity,
 *    POST /executions, GET /agents, ...) keep answering the API
 *    plane's honest JSON vocabulary through the SAME origin.
 *
 * The browser-level journey over this same composition is
 * tests/browser/public-experience-browser-smoke.ts (the real-browser
 * layer of this battery).
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MOBILE_NAV_ITEMS } from "../../../apps/dashboard/discovery";
import { NAV_GROUPS, SIMPLE_NAV_ITEMS } from "../../../apps/dashboard/shell";
import {
  bootLocalExperienceComposition,
  type LocalExperienceComposition,
} from "../../../deploy/local-experience-gateway";

let composition: LocalExperienceComposition;

beforeAll(async () => {
  composition = await bootLocalExperienceComposition();
  afterAll(async () => {
    await composition.stop();
  });
});

const ID = "00000000-0000-0000-0000-0000000000e9";

async function get(path: string): Promise<Response> {
  return fetch(`${composition.gatewayUrl}${path}`, { redirect: "manual" });
}

async function getToHtml(path: string): Promise<string> {
  const response = await get(path);
  expect(response.status, path).toBe(200);
  expect(response.headers.get("content-type") ?? "", path).toContain("text/html");
  return response.text();
}

describe("PPR-015: the root bridge lands on the Home experience (the Home masquerade defect)", () => {
  test("the bare / answers the platform redirect to the canonical Home route", async () => {
    const response = await get("/");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/home");
  });

  test("the canonical Home route serves the discovery-first Home experience", async () => {
    const html = await getToHtml("/home");
    expect(html).toContain("<title>Zeck — Home</title>");
    // THE OUTCOME EXPLANATION — prominent, on the landing path.
    expect(html).toContain(
      "Describe an outcome. Zeck plans it, executes it under policy, and returns it with evidence.",
    );
    // THE CAPABILITY DISCOVERY AFFORDANCE — the families grid + the catalog.
    expect(html).toContain("The workload families");
    expect(html).toContain('href="/console/catalog"');
    // THE SAFE START — the guided sandbox CTA.
    expect(html).toContain('href="/console/start"');
    // The nav Home control addresses the canonical route.
    expect(html).toContain('href="/home"');
  });

  test("the visible Home control no longer masquerades as the Developer Console", async () => {
    const home = await getToHtml("/home");
    expect(home).not.toContain("<title>Zeck — Developer console</title>");
    const consolePage = await getToHtml("/console");
    // /console remains the Developer Console — its own surface.
    expect(consolePage).toContain("<title>Zeck — Developer console</title>");
  });
});

describe("PPR-015: the capability discovery surface (all 22 families, honest states)", () => {
  test("the catalog serves every family through the machine-manifest projection", async () => {
    const html = await getToHtml("/console/catalog");
    expect(html).toContain("The 22 workload families");
    for (const state of ["Available", "Requires access", "Provider-gated", "NOT RUN"]) {
      expect(html).toContain(state);
    }
    // 22 catalog rows.
    expect((html.match(/<tr>/g) ?? []).length).toBeGreaterThanOrEqual(22);
  });

  test("a representative family per availability state serves its honest disclosure", async () => {
    const available = await getToHtml("/console/playground/text");
    expect(available).toContain("Playground — text");
    const gated = await getToHtml("/console/playground/browser-use");
    expect(gated).toContain("provider-gated");
    const notRun = await getToHtml("/console/playground/realtime-voice");
    expect(notRun).toContain("NOT RUN");
  });
});

describe("PPR-015: every visible navigation destination reaches the experience plane", () => {
  test("the nav grammar's every destination answers HTML (never the API plane's raw JSON)", async () => {
    const destinations = new Set<string>();
    for (const item of MOBILE_NAV_ITEMS) {
      destinations.add(item.path);
    }
    for (const item of SIMPLE_NAV_ITEMS) {
      destinations.add(item.path);
    }
    for (const group of NAV_GROUPS) {
      destinations.add(group.path);
      for (const item of group.items) {
        destinations.add(item.path);
      }
    }
    expect(destinations.size).toBeGreaterThan(30);
    for (const path of destinations) {
      const response = await get(path);
      expect(response.status, path).not.toBe(404);
      const contentType = response.headers.get("content-type") ?? "";
      expect(contentType, path).toContain("text/html");
    }
  });

  test("the breadcrumb group parents (the IA's visible links) are real experience routes", async () => {
    for (const path of ["/build", "/assets", "/runs", "/improve/insights"]) {
      const html = await getToHtml(path);
      expect(html.startsWith("<!doctype html>"), path).toBe(true);
    }
  });

  test("the shell's utility routes serve on the experience plane", async () => {
    for (const path of ["/command", "/command?q=agents", "/attention", "/mode", "/appearance"]) {
      const response = await get(path);
      expect(response.status, path).not.toBe(404);
      // The experience plane answers HTML — or its own 303 redirect
      // (the mode/appearance preference flows) — never the API plane's
      // raw JSON (the fall-through signature).
      const contentType = response.headers.get("content-type");
      if (response.status !== 303) {
        expect(contentType ?? "", path).toContain("text/html");
      } else {
        expect(contentType ?? "text/html", path).not.toContain("application/json");
      }
    }
  });

  test("the execution lookup form's seam lands on the run detail (never the API plane)", async () => {
    const lookup = await get(`/runs?id=${ID}`);
    expect(lookup.status).toBe(303);
    expect(lookup.headers.get("location")).toBe(`/runs/${ID}`);
    const form = await getToHtml("/home");
    expect(form).toContain('action="/runs"');
  });

  test("the agents UI surface lives at /build/agents (its designed honest state, never raw JSON)", async () => {
    const response = await get("/build/agents");
    // The unbound local composition answers the designed permission
    // boundary (HTML) — on a credentialed plane this renders the
    // inventory. Either way: the EXPERIENCE plane, never raw JSON.
    expect(response.status, "/build/agents").not.toBe(404);
    expect(response.headers.get("content-type") ?? "").toContain("text/html");
  });

  test("the composition's own static asset serves from the experience plane", async () => {
    const response = await get("/assets/client.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("application/javascript");
  });
});

describe("PPR-015: the API-only boundary stays on the API plane (the negative check, same origin)", () => {
  test("the machine endpoints answer the API plane's honest JSON vocabulary", async () => {
    const identity = await get("/identity");
    expect(identity.status).toBe(200);
    expect(identity.headers.get("content-type") ?? "").toContain("application/json");
    const health = await get("/health");
    expect(health.headers.get("content-type") ?? "").toContain("application/json");

    const create = await fetch(`${composition.gatewayUrl}/executions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        applicationId: "00000000-0000-0000-0000-000000000000",
        task: { kind: "gateway-probe" },
      }),
      redirect: "manual",
    });
    expect(create.headers.get("content-type") ?? "").toContain("application/json");

    const agents = await get("/agents");
    expect(agents.headers.get("content-type") ?? "").toContain("application/json");

    const executionRead = await get(`/executions/${ID}`);
    expect(executionRead.headers.get("content-type") ?? "").toContain("application/json");
  });

  test("the public governed artifact serves from the API plane", async () => {
    const policy = await get("/sandbox/data-policy");
    expect(policy.status).toBe(200);
    expect(policy.headers.get("content-type") ?? "").toContain("application/json");
  });
});
