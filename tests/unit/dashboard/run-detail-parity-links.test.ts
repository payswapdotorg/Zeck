/**
 * DEP-041 — C1 regression pin (fail-before/pass-after house style).
 *
 * FINDING C1 (surfaces on the DEP-041 fresh-developer trial, leg 5): the
 * run-detail surface the guided journeys land on (POST /console/playground/
 * :family → 303 → GET /runs/:executionId) rendered NO machine-parity or
 * reproducibility links — the export path the developer docs document
 * (docs/developer/SELF-HOSTING.md: "every execution's reproducibility
 * bundle (`/console/executions/<id>/export`)") was reachable ONLY through
 * the console nav's sibling explorer surface, so a fresh developer following
 * the guided journey could not reach the documented export/self-host
 * handoff from the page they were on.
 *
 * THE PIN: the /runs/:executionId detail must carry, for EVERY execution
 * (hostile ids included — percent-encoded, escaped), the same three links
 * its sibling explorer renders:
 *   - /console/executions/<id>/facts.json  (the machine-parity twin)
 *   - /console/executions/<id>/export      (the reproducibility bundle)
 *   - /console/executions/<id>             (the six-view explorer detail)
 * Fail-before: on the pre-fix base the page contains none of them (the
 * parity line did not exist).
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { matchRoute, parseCookies, sendResult } from "../../../apps/dashboard/http";
import { createDashboardRoutes } from "../../../apps/dashboard/pages";
import { createZeckClient, type ZeckClient } from "../../../sdk";

const APP_ID = "00000000-0000-7000-8000-0000000000b1";
const EXECUTION_ID = "00000000-0000-7000-8000-0000000000b2";
/** A markup-carrying hostile id that "exists" in the fake API world. */
const HOSTILE_EXECUTION_ID = `h-"><script>alert(1)</script>-id`;

function execution(id: string): Record<string, unknown> {
  return {
    id,
    applicationId: APP_ID,
    environmentId: null,
    status: "COMPLETED",
    task: { kind: "summarize", doc: "quarterly-report-01", maxWords: 60 },
    constraints: null,
    metadata: {},
    createdAt: "2026-09-18T12:00:00Z",
    updatedAt: "2026-09-18T12:00:42Z",
    terminalAt: "2026-09-18T12:00:42Z",
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchImpl = (async (input: string | URL) => {
  const path = new URL(String(input)).pathname;
  for (const id of [EXECUTION_ID, HOSTILE_EXECUTION_ID]) {
    if (path === `/executions/${encodeURIComponent(id)}`) {
      return json(execution(id));
    }
    if (path === `/executions/${encodeURIComponent(id)}/events`) {
      return json([
        {
          eventId: "ev-1",
          executionId: id,
          applicationId: APP_ID,
          sequence: 1,
          type: "execution.created",
          occurredAt: "2026-09-18T12:00:00Z",
          payload: { to: "CREATED" },
        },
      ]);
    }
    if (path === `/executions/${encodeURIComponent(id)}/results`) {
      return json({
        executionId: id,
        status: "COMPLETED",
        route: null,
        cost: { totalMicroUsd: "4125", currency: "usd" },
        usage: { inputTokens: 2100, outputTokens: 340 },
        outputArtifacts: [
          { id: "art-1", digest: "sha256:dep041", createdAt: "2026-09-18T12:00:42Z" },
        ],
        verification: [],
        warnings: [],
        terminalAt: "2026-09-18T12:00:42Z",
      });
    }
    if (path === `/executions/${encodeURIComponent(id)}/verification`) {
      return json([]);
    }
  }
  if (path === "/agents") return json([]);
  return json({ code: "PROVIDER_ERROR", message: `unexpected path ${path}`, retryable: true }, 500);
}) as unknown as typeof fetch;

let base = "";
let server: ReturnType<typeof createServer>;
let client: ZeckClient;
let routes: ReturnType<typeof createDashboardRoutes>;

beforeAll(async () => {
  client = createZeckClient({
    baseUrl: "http://fake.local",
    token: "token",
    applicationId: APP_ID,
    fetchImpl,
  });
  routes = createDashboardRoutes(client, { applicationId: APP_ID });
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://dashboard.local");
    const method = request.method === "POST" ? "POST" : "GET";
    const match = matchRoute(routes, method, url.pathname);
    if (match === null) {
      response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      response.end("not found");
      return;
    }
    void Promise.resolve(
      match.route.handler({
        method,
        path: url.pathname,
        params: match.params,
        query: url.searchParams,
        cookies: parseCookies(request.headers.cookie),
        form: {},
      }),
    )
      .then((result) => sendResult(response, result))
      .catch(() => {
        response.destroy();
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

async function runDetail(id: string): Promise<string> {
  const response = await fetch(`${base}/runs/${encodeURIComponent(id)}`);
  expect(response.status).toBe(200);
  return response.text();
}

describe("DEP-041 C1 — the run-detail surface carries the machine-parity + reproducibility links", () => {
  test("GET /runs/:id links the facts.json machine twin, the export bundle and the explorer detail", async () => {
    const html = await runDetail(EXECUTION_ID);
    const encoded = encodeURIComponent(EXECUTION_ID);
    expect(html).toContain(`href="/console/executions/${encoded}/facts.json"`);
    expect(html).toContain(`href="/console/executions/${encoded}/export"`);
    expect(html).toContain(`href="/console/executions/${encoded}"`);
  });

  test("the links ride every tab of the run detail (the surface, not one view)", async () => {
    for (const tab of ["result", "evidence", "activity"]) {
      const response = await fetch(`${base}/runs/${encodeURIComponent(EXECUTION_ID)}?tab=${tab}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(
        `href="/console/executions/${encodeURIComponent(EXECUTION_ID)}/export"`,
      );
    }
  });

  test("a hostile execution id renders the links percent-encoded with no markup reflection", async () => {
    const html = await runDetail(HOSTILE_EXECUTION_ID);
    const encoded = encodeURIComponent(HOSTILE_EXECUTION_ID);
    expect(html).toContain(`href="/console/executions/${encoded}/facts.json"`);
    expect(html).toContain(`href="/console/executions/${encoded}/export"`);
    expect(html).not.toContain(`<script>alert(1)</script>`);
  });

  test("the parity line introduces the links with the machine-parity vocabulary (the explorer's own phrasing)", async () => {
    const html = await runDetail(EXECUTION_ID);
    expect(html).toContain("Machine parity:");
    expect(html).toContain("export the bundle");
    expect(html).toContain("the reproduction recipe");
  });
});
