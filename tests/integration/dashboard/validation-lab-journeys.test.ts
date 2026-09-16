/**
 * Validation Lab integration journeys (DEP-025 acceptance criteria 2, 3
 * and 5 — the end-to-end rerun path over the REAL public API).
 *
 * The full local stack, no fakes at the transport boundary (the DEP-010
 * console-journeys pattern):
 *  - the REAL Fastify API server (createApiServer through seedApiWorld)
 *    on an ephemeral port;
 *  - the REAL Zeck SDK client (the dashboard's only transport) talking
 *    HTTP to that server;
 *  - the REAL dashboard server rendering the Validation Lab.
 *
 * The journey: a VAL-010 replay-exact rerun is submitted through the
 * lab's governed POST, lands on the REAL public API carrying the corpus
 * task verbatim plus the lineage metadata, is driven through the REAL
 * lifecycle to COMPLETED with a PASS verification result, and is then
 * read back through the lab's agent/machine run-record route and the
 * compare surface (against the corpus's recorded expectation).
 *
 * HONEST BOUNDARY (DEP-025): this is the LOCAL synthetic-data path —
 * the in-memory world stands in for the platform interior, and NO
 * provider rail is contacted (no provider credentials exist in this
 * pod; live-rail rows are NOT RUN — the Lead owns the credentialed
 * re-run). The integration path itself (wire contract, scoping,
 * idempotency, serialization, lineage) is fully real.
 */

import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDashboard } from "../../../apps/dashboard/index";
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

async function postForm(path: string, body: Record<string, string>): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    body: new URLSearchParams(body).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
  });
}

describe("DEP-025 AC2/AC3/AC5: a real validation rerun through the public API, end to end", () => {
  let executionId = "";

  test("the experiment page offers the governed rerun with the pinned corpus task", async () => {
    const page = await getHtml("/console/validation/VAL-010");
    expect(page).toContain("What it proves");
    expect(page).toContain("text.summarize-doc.v1#000");
    expect(page).toContain("Required access");
    const review = await getHtml(
      `/console/validation/VAL-010?applicationId=${world.applicationId}&mode=replay-exact&taskId=${encodeURIComponent(
        "text.summarize-doc.v1#000",
      )}&idempotencyKey=val-journey-1`,
    );
    expect(review).toContain("Proposed validation rerun");
    expect(review).toContain("Run this validation rerun?");
  });

  test("the governed POST lands on the REAL public API with the corpus task and lineage", async () => {
    const response = await postForm("/console/validation/VAL-010/run", {
      applicationId: world.applicationId,
      environmentId: "",
      spendLimitDollars: "1.00",
      mode: "replay-exact",
      taskId: "text.summarize-doc.v1#000",
      idempotencyKey: "val-journey-1",
    });
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    expect(location).toMatch(/^\/runs\/.+$/);
    executionId = decodeURIComponent(location.replace(/^\/runs\//, ""));

    const execution = await world.executions.getExecution(world.applicationId, executionId);
    expect(execution).not.toBeNull();
    expect(execution?.task).toEqual({
      kind: "summarize",
      doc: "quarterly-report-01",
      maxWords: 60,
    });
    expect(execution?.metadata).toMatchObject({
      origin: "zeck-console-validation-lab",
      workOrder: "VAL-010",
      mode: "replay-exact",
      corpusTask: "text.summarize-doc.v1#000",
      corpusVersion: "val-corpus.1.0.0",
      sandbox: "disposable",
    });
    expect(execution?.constraints).toMatchObject({
      maxCostMicroUsd: "1000000",
      maxLatencyMs: 20000,
    });
  });

  test("the format=json agent path starts a rerun and answers the machine receipt", async () => {
    const response = await postForm("/console/validation/VAL-010/run", {
      applicationId: world.applicationId,
      environmentId: "",
      spendLimitDollars: "",
      mode: "rerun-current",
      taskId: "text.summarize-doc.v1#000",
      idempotencyKey: "val-journey-json-1",
      format: "json",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const receipt = (await response.json()) as {
      executionId: string;
      workOrder: string;
      mode: string;
      runRecord: string;
    };
    expect(receipt.workOrder).toBe("VAL-010");
    expect(receipt.mode).toBe("rerun-current");
    expect(receipt.runRecord).toBe(
      `/console/validation/api/runs/${encodeURIComponent(receipt.executionId)}.json`,
    );
    // The machine record reads the live execution through the public API.
    const recordResponse = await get(receipt.runRecord);
    expect(recordResponse.status).toBe(200);
    const record = (await recordResponse.json()) as {
      status: string;
      lineage: { mode: string; workOrder: string } | null;
    };
    expect(record.status).toBe("CREATED");
    expect(record.lineage?.workOrder).toBe("VAL-010");
    expect(record.lineage?.mode).toBe("rerun-current");
  });

  test("the lifecycle is driven to COMPLETED with a PASS verification result", async () => {
    // HONEST BOUNDARY: the in-memory world stands in for the worker that
    // drives the lifecycle — the REAL execution authority's own commands,
    // exactly as the platform interior drives them; no provider rail is
    // contacted (the live-rail rerun is the Lead's credentialed path).
    const scope = {
      actorId: ACTOR_ID,
      tenantId: world.tenantId,
      applicationId: world.applicationId,
      executionId,
    };
    await world.executions.transition({ ...scope, command: "authorize" }, "val-j-a-0");
    await world.executions.transition({ ...scope, command: "plan" }, "val-j-a-1");
    await world.executions.transition({ ...scope, command: "queue" }, "val-j-a-2");
    await world.executions.transition({ ...scope, command: "start" }, "val-j-a-3");
    await world.executions.transition({ ...scope, command: "verify" }, "val-j-a-4");
    const completed = await world.executions.transition(
      {
        ...scope,
        command: "pass",
        verificationResults: [
          {
            criterionId: "contains-revenue",
            strategy: "deterministic-oracle",
            status: "PASS",
            recordedBy: "verification-authority",
          },
        ],
      },
      "val-j-a-5",
    );
    expect(completed.execution.status).toBe("COMPLETED");
  });

  test("the agent run record carries outcome, comparison and evidence (AC5)", async () => {
    const response = await get(
      `/console/validation/api/runs/${encodeURIComponent(executionId)}.json`,
    );
    expect(response.status).toBe(200);
    const record = (await response.json()) as {
      status: string;
      terminal: boolean;
      outcome: { verificationStatuses: string[] };
      comparisonToExpectation: {
        expectedTerminalStatus: string;
        matchesTerminalStatus: boolean;
        expectedVerification: string;
        matchesVerification: boolean;
      };
      trajectory: { type: string }[];
      evidence: { consoleRunUrl: string };
    };
    expect(record.status).toBe("COMPLETED");
    expect(record.terminal).toBe(true);
    expect(record.outcome.verificationStatuses).toEqual(["PASS"]);
    // The corpus row's RECORDED expectation is the baseline (AC5): the
    // completed run with a PASS verification matches it.
    expect(record.comparisonToExpectation.expectedTerminalStatus).toBe("COMPLETED");
    expect(record.comparisonToExpectation.matchesTerminalStatus).toBe(true);
    expect(record.comparisonToExpectation.expectedVerification).toBe("PASS");
    expect(record.comparisonToExpectation.matchesVerification).toBe(true);
    expect(record.trajectory.length).toBeGreaterThan(0);
    expect(record.evidence.consoleRunUrl).toBe(`/runs/${encodeURIComponent(executionId)}`);
  });

  test("the compare surface states the match against the recorded expectation", async () => {
    const html = await getHtml(
      `/console/validation/compare?runs=${encodeURIComponent(executionId)}&workOrder=VAL-010`,
    );
    expect(html).toContain("Expected terminal");
    expect(html).toContain("COMPLETED");
    expect(html).toContain("✓ matches");
    expect(html).toContain("VAL-010");
  });

  test("the catalog, definition and bundle serve the same projection over the REAL stack", async () => {
    const catalogResponse = await get("/console/validation/api/catalog.json");
    expect(catalogResponse.status).toBe(200);
    const catalog = (await catalogResponse.json()) as {
      experiments: { id: string }[];
    };
    expect(catalog.experiments.length).toBe(46);

    const definitionResponse = await get("/console/validation/api/VAL-010.json");
    expect(definitionResponse.status).toBe(200);
    const definition = (await definitionResponse.json()) as {
      defaultTaskId: string;
      runInstructions: { action: string };
    };
    expect(definition.defaultTaskId).toBe("text.summarize-doc.v1#000");
    expect(definition.runInstructions.action).toBe("/console/validation/VAL-010/run");

    const bundleResponse = await get("/console/validation/api/VAL-010/bundle.json");
    expect(bundleResponse.status).toBe(200);
    const bundle = (await bundleResponse.json()) as {
      evidence: { path: string; content: string };
    };
    expect(bundle.evidence.path).toBe("docs/work-items/VAL-010.md");
    expect(bundle.evidence.content).toContain("# VAL-010");
  });

  test("the run is inspectable through the raw public API too (no second truth)", async () => {
    const response = await fetch(`${apiBase}/executions/${encodeURIComponent(executionId)}`, {
      headers: {
        authorization: `Bearer ${world.bearerToken}`,
        "x-zeck-application": world.applicationId,
      },
    });
    expect(response.status).toBe(200);
    const execution = (await response.json()) as {
      id: string;
      status: string;
      metadata: Record<string, unknown>;
    };
    expect(execution.id).toBe(executionId);
    expect(execution.status).toBe("COMPLETED");
    expect(execution.metadata).toMatchObject({ workOrder: "VAL-010" });
  });
});
