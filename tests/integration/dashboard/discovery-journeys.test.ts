/**
 * PPR-001 discovery-journey integration tests — the end-to-end
 * DISCOVERY path over the REAL public API.
 *
 * The full local stack, no fakes at the transport boundary (the same
 * discipline as console-journeys.test.ts):
 *  - the REAL Fastify API server (createApiServer through seedApiWorld —
 *    real routes, real request identity, real execution authority over
 *    the in-memory stores, real serialization) on an ephemeral port;
 *  - the REAL Zeck SDK client (the dashboard's only transport) talking
 *    HTTP to that server;
 *  - the REAL dashboard server rendering the discovery surfaces.
 *
 * The journey a newcomer actually takes after PPR-001:
 *  Home (what Zeck does / 22 families / availability / try safely)
 *  → the capability catalog (every family's honest state)
 *  → the guided safe sandbox start (safety envelope BEFORE the run)
 *  → the first text execution through the governed POST (the REAL API)
 *  → the result page with the promoted "How Zeck did it" hierarchy
 *  → the Validation Lab and the consolidated Trust & Limits entry.
 *
 * HONEST BOUNDARY: the in-memory world stands in for the platform
 * interior (the worker that drives the lifecycle); NO provider rail is
 * contacted (no provider credentials exist in this pod; live-rail rows
 * are NOT RUN — the Lead owns the credentialed re-run). The wire path
 * itself (contract, scoping, idempotency, serialization) is fully real.
 */

import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { consoleFamilies } from "../../../apps/dashboard/console";
import { availabilityStateOf } from "../../../apps/dashboard/discovery";
import { createDashboard } from "../../../apps/dashboard/index";
import type { Execution } from "../../../sdk";
import { type ApiWorld, seedApiWorld } from "../../unit/api/world";

let world: ApiWorld;
let base = "";
let apiBase = "";

beforeAll(async () => {
  world = await seedApiWorld();
  await world.server.app.listen({ port: 0, host: "127.0.0.1" });
  const address = world.server.app.server.address() as AddressInfo;
  apiBase = `http://127.0.0.1:${address.port}`;
  const { server } = createDashboard({
    apiUrl: apiBase,
    token: world.bearerToken,
    applicationId: world.applicationId,
    port: 0,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await world.server.app.close();
  });
});

async function getHtml(path: string): Promise<string> {
  const response = await fetch(`${base}${path}`, { redirect: "manual" });
  expect(response.status, path).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  return response.text();
}

describe("the PPR-001 discovery journey over the REAL public API", () => {
  test("Home answers the four first-screen questions in order, before any identifier", async () => {
    const html = await getHtml("/home");
    // 1. What Zeck does — the hero.
    expect(html.indexOf('id="discovery-hero-title"')).toBeGreaterThan(-1);
    // 2. What workloads exist — the 22-family grid.
    expect((html.match(/<li>\n {6}<a href="\/console\/playground\//g) ?? []).length).toBe(22);
    // 3. What is available right now — the honest state chips.
    expect(html).toContain("▶ Available");
    expect(html).toContain("∅ NOT RUN");
    // 4. How to try safely — the envelope summary + the dominant action
    //    (the hero CTA sits inside the hero, the first screen's action).
    expect(html.indexOf('id="discovery-safe-title"')).toBeGreaterThan(-1);
    expect(
      html.indexOf('class="button-link primary hero-cta" href="/console/start"'),
    ).toBeGreaterThan(html.indexOf('id="discovery-hero-title"'));
    // The first application identifier appears only after the discovery
    // answers, inside the "Your work" composer.
    expect(html.indexOf('name="applicationId"')).toBeGreaterThan(html.indexOf("Your work"));
  });

  test("the catalog carries every family with its honest state and links a guided run", async () => {
    const html = await getHtml("/console/catalog");
    for (const family of consoleFamilies()) {
      expect(html, family.family).toContain(
        `href="/console/playground/${encodeURIComponent(family.family)}"`,
      );
      expect(html, family.family).toContain(family.availability);
    }
    // The state model renders its distribution honestly.
    expect(html).toContain("11 families are available now");
    expect(html).toContain("3 record an honest NOT RUN boundary");
  });

  test("every family's guided-run location renders through the real server (route matrix legs)", async () => {
    for (const family of consoleFamilies()) {
      const page = await getHtml(`/console/playground/${encodeURIComponent(family.family)}`);
      // The family page carries the recorded availability verbatim and
      // the derived state's vocabulary is consistent with the catalog.
      expect(page, family.family).toContain("Availability");
      if (availabilityStateOf(family) === "not-run") {
        expect(page, family.family).toContain("NOT RUN");
      }
    }
  });

  let executionId = "";

  test("the guided start shows the safety envelope BEFORE the composer, then runs end to end", async () => {
    const start = await getHtml("/console/start");
    // Safety first: envelope, governance states and the synthetic task
    // all render BEFORE the composer form.
    const envelope = start.indexOf("Sandbox envelope");
    const task = start.indexOf("The task the first run carries");
    const composer = start.indexOf('name="applicationId"');
    expect(envelope).toBeGreaterThan(-1);
    expect(task).toBeGreaterThan(envelope);
    expect(composer).toBeGreaterThan(task);
    // The bound scope is prefilled (understood, not unexplained).
    expect(start).toContain(`value="${world.applicationId}"`);

    // The composer rides the EXISTING playground review flow.
    const keyMatch = /name="idempotencyKey" value="(dash-[^"]+)"/.exec(start);
    expect(keyMatch).not.toBeNull();
    const idempotencyKey = keyMatch?.[1] ?? "";
    const review = await getHtml(
      `/console/playground/text?applicationId=${world.applicationId}&spendLimitDollars=1.00&idempotencyKey=${encodeURIComponent(
        idempotencyKey,
      )}`,
    );
    expect(review).toContain("Proposed sandbox run");
    expect(review).toContain("Run this sandbox execution?");

    // The governed POST against the REAL public API.
    const response = await fetch(`${base}/console/playground/text`, {
      method: "POST",
      body: new URLSearchParams({
        applicationId: world.applicationId,
        environmentId: "",
        spendLimitDollars: "1.00",
        idempotencyKey,
      }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    executionId = decodeURIComponent(
      (response.headers.get("location") ?? "").replace(/^\/runs\//, ""),
    );
    expect(executionId).not.toBe("");

    // The execution is durable on the REAL authority with the sandbox
    // envelope the guided start declared.
    const execution = await world.executions.getExecution(world.applicationId, executionId);
    expect(execution).not.toBeNull();
    expect(execution?.task).toEqual({
      kind: "summarize",
      doc: "quarterly-report-01",
      maxWords: 60,
    });
  });

  test("the result lands with the promoted How-Zeck-did-it hierarchy open", async () => {
    const run = await getHtml(`/runs/${encodeURIComponent(executionId)}`);
    expect(run).toContain('<details class="why-panel" open>');
    expect(run).toContain("How Zeck did it");
    expect(run).toContain("quarterly-report-01");
  });

  test("the Validation Lab and the consolidated Trust & Limits entry are prominent destinations", async () => {
    const home = await getHtml("/home");
    expect(home).toContain('href="/console/validation"');
    expect(home).toContain('href="/trust/limits"');
    const lab = await getHtml("/console/validation");
    expect(lab).toContain("Validation Lab");
    expect(lab).toContain("The catalog");
    const trust = await getHtml("/trust/limits");
    expect(trust).toContain("Trust &amp; Limits");
    expect(trust).toContain('href="/admin/policies"');
  });

  test("the run is inspectable through the raw public API too (the console adds no second truth)", async () => {
    const response = await fetch(`${apiBase}/executions/${encodeURIComponent(executionId)}`, {
      headers: {
        authorization: `Bearer ${world.bearerToken}`,
        "x-zeck-application": world.applicationId,
      },
    });
    expect(response.status).toBe(200);
    const execution = (await response.json()) as Execution;
    expect(execution.id).toBe(executionId);
    expect(execution.applicationId).toBe(world.applicationId);
  });
});
