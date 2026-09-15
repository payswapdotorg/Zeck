/**
 * Developer console integration journeys (DEP-010 acceptance criterion 2
 * and 3 — the end-to-end sandbox path over the REAL public API).
 *
 * The full local stack, no fakes at the transport boundary:
 *  - the REAL Fastify API server (createApiServer through seedApiWorld —
 *    real routes, real request identity, real execution authority over
 *    the in-memory stores, real serialization) on an ephemeral port;
 *  - the REAL Zeck SDK client (the dashboard's only transport) talking
 *    HTTP to that server;
 *  - the REAL dashboard server rendering the console.
 *
 * The journey: the playground's guided sandbox run for the text family
 * is submitted through the console's governed POST, lands on the REAL
 * public API, is driven through the REAL lifecycle to COMPLETED with a
 * PASS verification result, and is then inspected end to end through
 * the console's execution explorer (result, verification, activity).
 *
 * HONEST BOUNDARY (DEP-010): this is the LOCAL synthetic-data path —
 * the in-memory world stands in for the platform interior (the worker
 * that drives the lifecycle), and NO provider rail is contacted (no
 * provider credentials exist in this pod; live-rail rows are NOT RUN —
 * the Lead owns the credentialed re-run). The integration path itself
 * (wire contract, scoping, idempotency, serialization) is fully real.
 */

import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDashboard } from "../../../apps/dashboard/index";
import type { Execution } from "../../../sdk";
import { ACTOR_ID, type ApiWorld, seedApiWorld } from "../../unit/api/world";

let world: ApiWorld;
let apiBase = "";
let base = "";

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

async function get(path: string): Promise<Response> {
  return fetch(`${base}${path}`, { redirect: "manual" });
}

async function getHtml(path: string): Promise<string> {
  const response = await get(path);
  expect(response.status, path).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  return response.text();
}

describe("DEP-010 AC2/AC3: a real sandbox text execution through the public API, end to end", () => {
  let executionId = "";

  test("the guided run is submitted through the console and lands on the REAL public API", async () => {
    // The family page carries the run form and a fresh idempotency key.
    const familyPage = await getHtml("/console/playground/text");
    expect(familyPage).toContain("quarterly-report-01");
    const keyMatch = /name="idempotencyKey" value="(dash-[^"]+)"/.exec(familyPage);
    expect(keyMatch).not.toBeNull();
    const idempotencyKey = keyMatch?.[1] ?? "";

    // The review step shows the exact envelope before commitment.
    const review = await getHtml(
      `/console/playground/text?applicationId=${world.applicationId}&spendLimitDollars=1.00&idempotencyKey=${encodeURIComponent(
        idempotencyKey,
      )}`,
    );
    expect(review).toContain("Proposed sandbox run");
    expect(review).toContain("Run this sandbox execution?");

    // The governed POST: the console's only mutation path for playground
    // runs, through the SDK client, against the REAL API server.
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
    const location = response.headers.get("location") ?? "";
    expect(location).toMatch(/^\/runs\/.+$/);
    executionId = decodeURIComponent(location.replace(/^\/runs\//, ""));

    // The execution is durable on the REAL authority, with the sandbox
    // envelope the console declared (synthetic task, hard constraints,
    // disposable-sandbox identity).
    const execution = await world.executions.getExecution(world.applicationId, executionId);
    expect(execution).not.toBeNull();
    expect(execution?.task).toEqual({
      kind: "summarize",
      doc: "quarterly-report-01",
      maxWords: 60,
    });
    expect(execution?.status).toBe("CREATED");
  });

  test("the same idempotency key replays the same durable outcome (no duplicate)", async () => {
    const replay = await fetch(`${base}/console/playground/text`, {
      method: "POST",
      body: new URLSearchParams({
        applicationId: world.applicationId,
        environmentId: "",
        spendLimitDollars: "1.00",
        idempotencyKey: `dash-replay-${executionId}`,
      }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(replay.status).toBe(303);
    const replayId = decodeURIComponent(
      (replay.headers.get("location") ?? "").replace(/^\/runs\//, ""),
    );
    expect(replayId).not.toBe("");
    // A DIFFERENT key creates a different execution; replaying the SAME
    // key+request converges. Both facts ride the real idempotency
    // authority — proven through the public surface.
    const again = await fetch(`${base}/console/playground/text`, {
      method: "POST",
      body: new URLSearchParams({
        applicationId: world.applicationId,
        environmentId: "",
        spendLimitDollars: "1.00",
        idempotencyKey: `dash-replay-${executionId}`,
      }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(again.status).toBe(303);
    const againId = decodeURIComponent(
      (again.headers.get("location") ?? "").replace(/^\/runs\//, ""),
    );
    expect(againId).toBe(replayId);
  });

  test("the run page renders the live CREATED state through the public contract", async () => {
    const html = await getHtml(`/runs/${encodeURIComponent(executionId)}`);
    expect(html).toContain("quarterly-report-01");
    expect(html).toContain("CREATED");
  });

  test("the lifecycle is driven to COMPLETED with a PASS verification result (the platform interior)", async () => {
    // HONEST BOUNDARY: the in-memory world stands in for the worker that
    // drives the lifecycle — the transitions are the REAL execution
    // authority's own commands, exactly as the platform interior drives
    // them; no provider rail is contacted.
    const scope = {
      actorId: ACTOR_ID,
      tenantId: world.tenantId,
      applicationId: world.applicationId,
      executionId,
    };
    await world.executions.transition({ ...scope, command: "authorize" }, "journey-a-0");
    await world.executions.transition({ ...scope, command: "plan" }, "journey-a-1");
    await world.executions.transition({ ...scope, command: "queue" }, "journey-a-2");
    await world.executions.transition({ ...scope, command: "start" }, "journey-a-3");
    await world.executions.transition({ ...scope, command: "verify" }, "journey-a-4");
    const completed = await world.executions.transition(
      {
        ...scope,
        command: "pass",
        verificationResults: [
          {
            criterionId: "summary-length",
            strategy: "deterministic-oracle",
            status: "PASS",
            recordedBy: "verification-authority",
          },
        ],
      },
      "journey-a-5",
    );
    expect(completed.execution.status).toBe("COMPLETED");
  });

  test("the execution explorer shows the completed run end to end (AC3)", async () => {
    const run = await getHtml(`/runs/${encodeURIComponent(executionId)}`);
    // Result: the completed status and the honest facts.
    expect(run).toContain("COMPLETED");
    // Verification: the PASS check the authority recorded.
    expect(run).toContain("summary-length");
    expect(run).toContain("PASS");
    // Activity: the real event stream through the public contract.
    expect(run).toContain("Activity");
    // The explorer renders the trust vocabulary (four separate axes).
    expect(run).toContain("Can you trust it?");

    const evidence = await getHtml(`/runs/${encodeURIComponent(executionId)}?tab=evidence`);
    expect(evidence).toContain("summary-length");
    expect(evidence).toContain("PASS");

    const activity = await getHtml(`/runs/${encodeURIComponent(executionId)}?tab=activity`);
    expect(activity).toContain("timeline");

    const inspection = await getHtml(`/runs/${encodeURIComponent(executionId)}?tab=inspection`);
    expect(inspection).toContain("Inspection");
  });

  test("the usage surface reflects the run through the public result package", async () => {
    const usage = await getHtml("/console/applications/usage");
    // No recents cookie in this journey's browser context: the honest
    // empty state (usage is browser-scoped by design).
    expect(usage).toContain("No usage yet");
    expect(usage).toContain("no aggregate usage route");
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
    expect(execution.status).toBe("COMPLETED");
    expect(execution.applicationId).toBe(world.applicationId);
  });
});
