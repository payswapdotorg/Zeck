/**
 * PPR-007 unit tests — the dashboard's additive request-listener export
 * (createDashboardHandler): the composition a hosting entry reuses.
 *
 * WHAT IS PINNED HERE (the work order's verification battery):
 *  - THE EXPORT'S BEHAVIOR: the composed listener serves the SAME
 *    surface the direct-execution host serves — a representative
 *    console page (HTML + the availability disclosure), the 22-family
 *    playground disclosure route, and the machine JSON views —
 *    byte-parity with `createDashboard` over the same API plane;
 *  - THE HONEST UNBOUND MODE: with NO transport credential the pages
 *    STILL SERVE — the no-read pages render their designed 200 states
 *    (no fabricated data anywhere), and a reading page renders its
 *    designed permission-denied state over the API's honest 401 —
 *    never a crash, never a fabricated projection;
 *  - THE PARITY ANCHOR: `createDashboard` (the direct host's entry,
 *    whose behavior is unchanged) answers identically to the
 *    experience handler for the same request — the additive export
 *    composes the SAME composition, never a second one.
 *
 * Real HTTP only (a wire-exact stub API plane on an ephemeral port —
 * the same discipline as the dashboard's own console tests; no mock
 * transports).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDashboard, createDashboardHandler } from "../../../apps/dashboard/index";

const APP_ID = "00000000-0000-7000-8000-0000000000b1";
const OTHER_TOKEN = "sk-live-experience-projection-2d4e6f8a";

/** The wire-exact honest 401 every unauthenticated read receives. */
const UNAUTHENTICATED_BODY = JSON.stringify({
  code: "AUTHENTICATION_FAILED",
  message: "The transport credential is absent or not accepted.",
  retryable: false,
});

function stubApiPlane(): Promise<Server> {
  return new Promise((resolvePromise) => {
    const server = createServer((request, response) => {
      void request;
      response.writeHead(401, { "content-type": "application/json" });
      response.end(UNAUTHENTICATED_BODY);
    });
    server.listen(0, "127.0.0.1", () => {
      resolvePromise(server);
    });
  });
}

function urlOf(server: Server): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<Server> {
  return new Promise((resolvePromise) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolvePromise(server);
    });
  });
}

interface ServedSurface {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: string;
}

async function get(baseUrl: string, path: string): Promise<ServedSurface> {
  const response = await fetch(`${baseUrl}${path}`, { redirect: "manual" });
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.text(),
  };
}

/**
 * Normalize the per-request randomness the pages embed by design (the
 * CSRF-shaped idempotency keys every form carries: `dash-<uuid>`) so the
 * parity comparison sees the deterministic composition only.
 */
function normalized(body: string): string {
  return body.replace(
    /dash-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    "dash-<uuid>",
  );
}

let apiPlane: Server;
let apiPlaneUrl: string;

beforeAll(async () => {
  apiPlane = await stubApiPlane();
  apiPlaneUrl = urlOf(apiPlane);
});

afterAll(async () => {
  await new Promise<void>((resolvePromise) => apiPlane.close(() => resolvePromise()));
});

describe("PPR-007: the dashboard request-listener export (createDashboardHandler)", () => {
  test("serves the console home page through the composed listener (HTML + the full a11y frame)", async () => {
    const handler = createDashboardHandler({
      apiUrl: apiPlaneUrl,
      token: OTHER_TOKEN,
      applicationId: APP_ID,
    });
    const server = await listen(handler);
    try {
      const page = await get(urlOf(server), "/console");
      expect(page.status).toBe(200);
      expect(page.contentType).toContain("text/html");
      expect(page.body).toContain("Developer console");
      // the console's own application-scope disclosure
      expect(page.body).toContain(APP_ID);
      // the a11y frame the journey harness audits structurally
      expect(page.body).toMatch(/<meta\s+name="viewport"\s+content="width=device-width/i);
      expect(page.body).toMatch(/<main[\s>]/i);
      expect(page.body).toMatch(/aria-current="page"/);
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  test("serves a representative 22-family playground disclosure route (HTML + the availability disclosure)", async () => {
    const handler = createDashboardHandler({
      apiUrl: apiPlaneUrl,
      token: OTHER_TOKEN,
      applicationId: APP_ID,
    });
    const server = await listen(handler);
    try {
      const page = await get(urlOf(server), "/console/playground/text");
      expect(page.status).toBe(200);
      expect(page.contentType).toContain("text/html");
      // the availability disclosure vocabulary the journey harness audits
      const lowered = page.body.toLowerCase();
      expect(
        ["available", "runnable", "provider-gated", "requires access", "not run"].some((word) =>
          lowered.includes(word),
        ),
      ).toBe(true);
      // the family's form (the route serves the FAMILY page, not the index)
      expect(page.body).toContain("text");
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  test("serves the machine JSON views through the composed listener (the machine-parity pin)", async () => {
    const handler = createDashboardHandler({
      apiUrl: apiPlaneUrl,
      token: OTHER_TOKEN,
      applicationId: APP_ID,
    });
    const server = await listen(handler);
    try {
      // the executions explorer's machine twin: no recents cookie, so the
      // projection composes from zero reads — the honest empty facts list.
      const facts = await get(urlOf(server), "/console/executions/facts.json");
      expect(facts.status).toBe(200);
      expect(facts.contentType).toContain("application/json");
      expect((JSON.parse(facts.body) as { readonly runs: readonly unknown[] }).runs).toEqual([]);

      // the validation lab's machine catalog: served read-only from the
      // repository (no reads at all).
      const catalog = await get(urlOf(server), "/console/validation/api/catalog.json");
      expect(catalog.status).toBe(200);
      expect(catalog.contentType).toContain("application/json");
      const parsed = JSON.parse(catalog.body) as Record<string, unknown>;
      expect(Object.keys(parsed).length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  test("the honest unbound mode: with NO transport credential the pages still serve (nothing fabricates)", async () => {
    const handler = createDashboardHandler({
      apiUrl: apiPlaneUrl,
      token: "",
      applicationId: APP_ID,
    });
    const server = await listen(handler);
    try {
      // A no-read page serves its designed 200 state — no fabricated data.
      const consoleHome = await get(urlOf(server), "/console");
      expect(consoleHome.status).toBe(200);
      expect(consoleHome.body).toContain("Developer console");

      // A reading page renders its designed permission-denied state over the
      // API's honest 401 AUTHENTICATION_FAILED — the projection surface's
      // degradation, never a crash and never a fabricated inventory.
      const agents = await get(urlOf(server), "/agents");
      expect(agents.status).toBe(403);
      expect(agents.contentType).toContain("text/html");
      expect(agents.body).toContain("Not authorized");
      expect(agents.body).not.toContain("00000000-0000-7000-8000");
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  test("parity anchor: the direct host (createDashboard, unchanged behavior) answers identically", async () => {
    const handler = createDashboardHandler({
      apiUrl: apiPlaneUrl,
      token: OTHER_TOKEN,
      applicationId: APP_ID,
    });
    const experienceServer = await listen(handler);

    const direct = createDashboard({
      apiUrl: apiPlaneUrl,
      token: OTHER_TOKEN,
      applicationId: APP_ID,
    });
    await new Promise<void>((resolvePromise) => {
      direct.server.listen(0, "127.0.0.1", () => resolvePromise());
    });

    try {
      const paths = [
        "/",
        "/console",
        "/console/playground/text",
        "/console/validation",
        "/console/executions/facts.json",
        "/console/validation/api/catalog.json",
        "/trust/evidence",
        "/admin/policies",
        "/console/no-such-route",
      ];
      const directUrl = `http://127.0.0.1:${(direct.server.address() as AddressInfo).port}`;
      for (const path of paths) {
        const throughExport = await get(urlOf(experienceServer), path);
        const throughDirect = await get(directUrl, path);
        expect(throughExport.status, path).toBe(throughDirect.status);
        expect(throughExport.contentType, path).toBe(throughDirect.contentType);
        expect(normalized(throughExport.body), path).toBe(normalized(throughDirect.body));
      }
    } finally {
      await new Promise<void>((resolvePromise) => experienceServer.close(() => resolvePromise()));
      await new Promise<void>((resolvePromise) => {
        direct.server.close(() => resolvePromise());
      });
    }
  });
});
