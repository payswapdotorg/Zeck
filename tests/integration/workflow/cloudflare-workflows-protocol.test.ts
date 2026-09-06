/**
 * Integration — the Cloudflare Workflows REST adapter over REAL HTTP
 * against an in-process protocol server (WORK-045 / D-04, acceptance
 * criterion 2 — provider isolation).
 *
 * This proves the ADAPTER's wire behavior against the documented
 * Cloudflare Workflows REST protocol: request paths, Bearer
 * authorization, create-instance body shape (instance_id + JSON-
 * encoded params string), instance-details envelope parsing (the
 * neutral status mapping), send-event body shape ({"body": value}),
 * terminate status body ({"status":"terminate"}), and the typed
 * fail-closed error classification (401/403/404 permanent;
 * 429/5xx/network transient). It is explicitly NOT Cloudflare
 * evidence — the live provider suite is env-gated
 * (`workflow-live.test.ts`).
 *
 * PROBE ISOLATION (the PR #6 discipline applied to orchestration):
 * the orchestration probe must never touch application orchestration.
 * The dedicated describe block below proves over real HTTP, with
 * application-shaped instances seeded on the orchestration workflow,
 * that (a) the probe creates, observes and terminates EXACTLY its
 * own instance on the DEDICATED probe workflow — seeded application
 * instances are never signaled, paused or terminated; (b) the probe
 * issues ZERO requests against the orchestration workflow; and
 * (c) the weakened configurations (no probe workflow / probe
 * workflow == orchestration workflow) are rejected fail-closed
 * before any wire call.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createCloudflareWorkflowsTransport,
  loadCloudflareWorkflowsRuntimeConfig,
} from "../../../src/platform/workflow/cloudflare-workflows";
import { WorkflowConfigError, WorkflowTransportError } from "../../../src/platform/workflow/port";
import {
  type FakeWorkflowServer,
  startFakeCloudflareWorkflows,
} from "./lib/fake-cloudflare-workflows";

const ACCOUNT_ID = "a".repeat(32);
const WORKFLOW_NAME = "zeck-production-orchestration";
const PROBE_WORKFLOW_NAME = "zeck-production-probe";
const API_TOKEN = "cf-workflow-test-token-material";

describe("the Cloudflare Workflows REST adapter over real HTTP (WORK-045 D-04)", () => {
  let server: FakeWorkflowServer;

  beforeAll(async () => {
    server = await startFakeCloudflareWorkflows({
      accountId: ACCOUNT_ID,
      workflowName: WORKFLOW_NAME,
      apiToken: API_TOKEN,
      probeWorkflowName: PROBE_WORKFLOW_NAME,
    });
  });

  afterAll(async () => {
    await server.close();
  });

  const transport = () =>
    createCloudflareWorkflowsTransport({
      apiBaseUrl: server.baseUrl,
      accountId: ACCOUNT_ID,
      workflowName: WORKFLOW_NAME,
      apiToken: API_TOKEN,
      requestTimeoutMs: 3000,
    });

  test("startInstance sends the documented body with Bearer authorization", async () => {
    const receipt = await transport().startInstance({
      instanceHint: "zeck-w-0123456789abcdef01234567-a1",
      params: { waitKey: "wait:<uuid>:callback:0", v: 1 },
    });
    expect(receipt.instanceId).toBe("zeck-w-0123456789abcdef01234567-a1");
    const create = server.requests.find(
      (r) => r.method === "POST" && r.path.endsWith("/instances"),
    );
    expect(create).toBeDefined();
    expect(create?.authorization).toBe(`Bearer ${API_TOKEN}`);
    expect(create?.body).toEqual({
      instance_id: "zeck-w-0123456789abcdef01234567-a1",
      params: JSON.stringify({ waitKey: "wait:<uuid>:callback:0", v: 1 }),
    });
  });

  test("describeInstance maps the provider status vocabulary onto the neutral one", async () => {
    const t = transport();
    const receipt = await t.startInstance({
      instanceHint: "zeck-w-map-a1",
      params: { probe: 1 },
    });
    const observation = await t.describeInstance(receipt.instanceId);
    // A fresh instance is "queued" on the provider -> neutral "active".
    expect(observation.status).toBe("active");
    const describe = server.requests.find(
      (r) => r.method === "GET" && r.path.includes("zeck-w-map-a1"),
    );
    expect(describe).toBeDefined();
    expect(describe?.path).toContain("?simple=true");
  });

  test("signalInstance sends the documented event body", async () => {
    const t = transport();
    const receipt = await t.startInstance({ instanceHint: "zeck-w-sig-a1", params: {} });
    await t.signalInstance({
      instanceId: receipt.instanceId,
      eventType: "zeck.callback",
      body: { waitKey: "wait:<uuid>:callback:0", resolution: "callback" },
    });
    const signal = server.requests.find(
      (r) => r.method === "POST" && r.path.endsWith("/events/zeck.callback"),
    );
    expect(signal).toBeDefined();
    expect(signal?.body).toEqual({
      body: { waitKey: "wait:<uuid>:callback:0", resolution: "callback" },
    });
    expect(server.eventsOf(receipt.instanceId).map((e) => e.eventType)).toEqual(["zeck.callback"]);
  });

  test("terminateInstance sends the documented status body", async () => {
    const t = transport();
    const receipt = await t.startInstance({ instanceHint: "zeck-w-term-a1", params: {} });
    await t.terminateInstance({ instanceId: receipt.instanceId, reason: "compaction" });
    const terminate = server.requests.find(
      (r) => r.method === "PATCH" && r.path.endsWith("/status"),
    );
    expect(terminate).toBeDefined();
    expect(terminate?.body).toEqual({ status: "terminate" });
    expect(server.wasTerminated(receipt.instanceId)).toBe(true);
  });

  test("describeLimits exposes the documented provider limits explicitly", () => {
    const limits = transport().describeLimits();
    expect(limits.maxPayloadBytes).toBe(1_048_576);
    expect(limits.supportsTermination).toBe(true);
    expect(limits.documented.maximumEventPayloadSize).toContain("1MiB");
    expect(limits.documented.maximumStatePerInstance).toContain("1GB");
    expect(limits.documented.completedInstanceStateRetention).toContain("30 days");
  });

  test("401 answers fail closed permanent with the provider code", async () => {
    const authFailed = await startFakeCloudflareWorkflows({
      accountId: ACCOUNT_ID,
      workflowName: WORKFLOW_NAME,
      apiToken: API_TOKEN,
      rejectAuth: true,
    });
    try {
      const t = createCloudflareWorkflowsTransport({
        apiBaseUrl: authFailed.baseUrl,
        accountId: ACCOUNT_ID,
        workflowName: WORKFLOW_NAME,
        apiToken: "wrong-token",
      });
      await expect(t.startInstance({ instanceHint: "zeck-w-auth-a1", params: {} })).rejects.toThrow(
        WorkflowTransportError,
      );
      try {
        await t.startInstance({ instanceHint: "zeck-w-auth-a2", params: {} });
      } catch (error) {
        expect((error as WorkflowTransportError).failureKind).toBe("permanent");
        expect((error as WorkflowTransportError).providerCode).toBe("10000");
        expect((error as Error).message).toContain("http 401");
        expect((error as Error).message).not.toContain("wrong-token");
      }
    } finally {
      await authFailed.close();
    }
  });

  test("503 outage and 429 rate limit answer transient (bounded retry material)", async () => {
    const outage = await startFakeCloudflareWorkflows({
      accountId: ACCOUNT_ID,
      workflowName: WORKFLOW_NAME,
      apiToken: API_TOKEN,
      outage: true,
    });
    try {
      const t = createCloudflareWorkflowsTransport({
        apiBaseUrl: outage.baseUrl,
        accountId: ACCOUNT_ID,
        workflowName: WORKFLOW_NAME,
        apiToken: API_TOKEN,
      });
      await expect(t.describeInstance("any-instance")).rejects.toThrow(WorkflowTransportError);
      try {
        await t.describeInstance("any-instance");
      } catch (error) {
        expect((error as WorkflowTransportError).failureKind).toBe("transient");
      }
    } finally {
      await outage.close();
    }
    const rateLimited = await startFakeCloudflareWorkflows({
      accountId: ACCOUNT_ID,
      workflowName: WORKFLOW_NAME,
      apiToken: API_TOKEN,
      rateLimitCreates: 1,
    });
    try {
      const t = createCloudflareWorkflowsTransport({
        apiBaseUrl: rateLimited.baseUrl,
        accountId: ACCOUNT_ID,
        workflowName: WORKFLOW_NAME,
        apiToken: API_TOKEN,
      });
      try {
        await t.startInstance({ instanceHint: "zeck-w-rate-a1", params: {} });
        expect.unreachable("expected the rate-limited create to fail");
      } catch (error) {
        expect((error as WorkflowTransportError).failureKind).toBe("transient");
        expect((error as WorkflowTransportError).providerCode).toBe("9715");
      }
      // The budget is consumed: the next create succeeds.
      const receipt = await t.startInstance({ instanceHint: "zeck-w-rate-a2", params: {} });
      expect(receipt.instanceId).toBe("zeck-w-rate-a2");
    } finally {
      await rateLimited.close();
    }
  });

  test("unknown instance and unknown workflow answer 404 permanent", async () => {
    const t = transport();
    await expect(t.describeInstance("cf-never-created")).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof WorkflowTransportError &&
        error.failureKind === "permanent" &&
        error.status === 404,
    );
    const wanderer = createCloudflareWorkflowsTransport({
      apiBaseUrl: server.baseUrl,
      accountId: ACCOUNT_ID,
      workflowName: "some-other-workflow",
      apiToken: API_TOKEN,
    });
    await expect(
      wanderer.startInstance({ instanceHint: "zeck-w-x-a1", params: {} }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof WorkflowTransportError && error.failureKind === "permanent",
    );
  });

  test("malformed envelopes fail closed transient (never a silent success)", async () => {
    const broken = await startHttpServer((req, res) => {
      void req;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("not-json");
    });
    try {
      const t = createCloudflareWorkflowsTransport({
        apiBaseUrl: broken.baseUrl,
        accountId: ACCOUNT_ID,
        workflowName: WORKFLOW_NAME,
        apiToken: API_TOKEN,
      });
      await expect(t.describeInstance("any-instance")).rejects.toSatisfy(
        (error: unknown) => error instanceof WorkflowTransportError,
      );
    } finally {
      await broken.close();
    }
  });

  test("payload and shape guards fail closed before any wire call", async () => {
    const t = transport();
    // Reserved provider id form.
    await expect(
      t.startInstance({
        instanceHint: `cf_${"a".repeat(64)}`,
        params: {},
      }),
    ).rejects.toThrow(WorkflowConfigError);
    // Invalid event type.
    await expect(
      t.signalInstance({
        instanceId: "zeck-w-guard-a1",
        eventType: "not a valid event type!",
        body: {},
      }),
    ).rejects.toThrow(WorkflowConfigError);
    // Reference payloads beyond the documented provider bound.
    const huge: Record<string, unknown> = {};
    huge.padding = "x".repeat(1_048_577);
    await expect(t.startInstance({ instanceHint: "zeck-w-huge-a1", params: huge })).rejects.toThrow(
      WorkflowConfigError,
    );
    expect(
      server.requests.filter((r) => r.path.includes("zeck-w-huge")).length,
      "no wire call may happen for a rejected payload",
    ).toBe(0);
  });

  test("the runtime configuration loader fails closed with the exact variable names", () => {
    expect(() => loadCloudflareWorkflowsRuntimeConfig({})).toThrow(
      /ZECK_CLOUDFLARE_ACCOUNT_ID is not set.*ZECK_WORKFLOW_NAME is not set.*ZECK_WORKFLOW_API_TOKEN is not set/s,
    );
    const loaded = loadCloudflareWorkflowsRuntimeConfig({
      ZECK_CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      ZECK_WORKFLOW_NAME: WORKFLOW_NAME,
      ZECK_WORKFLOW_API_TOKEN: API_TOKEN,
      ZECK_WORKFLOW_PROBE_NAME: PROBE_WORKFLOW_NAME,
    });
    expect(loaded.probeWorkflowName).toBe(PROBE_WORKFLOW_NAME);
    // A malformed probe workflow name fails closed at loading; the
    // probe==orchestration equality is enforced at construction-time
    // validation (the discrimination block proves it fail-closed).
    expect(() =>
      loadCloudflareWorkflowsRuntimeConfig({
        ZECK_CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
        ZECK_WORKFLOW_NAME: WORKFLOW_NAME,
        ZECK_WORKFLOW_API_TOKEN: API_TOKEN,
        ZECK_WORKFLOW_PROBE_NAME: "not a workflow name!",
      }),
    ).toThrow(/ZECK_WORKFLOW_PROBE_NAME/);
  });

  // -------------------------------------------------------------------------
  // PROBE ISOLATION (the PR #6 discipline, applied to orchestration)
  // -------------------------------------------------------------------------

  describe("the orchestration probe isolation (dedicated probe workflow)", () => {
    let isolated: FakeWorkflowServer;
    const SEEDED_INSTANCE_IDS: string[] = [];

    beforeAll(async () => {
      isolated = await startFakeCloudflareWorkflows({
        accountId: ACCOUNT_ID,
        workflowName: WORKFLOW_NAME,
        apiToken: API_TOKEN,
        probeWorkflowName: PROBE_WORKFLOW_NAME,
        // Application-shaped workload seeded on the ORCHESTRATION
        // workflow: two live orchestration instances the probe must
        // never touch in any direction.
        seededInstances: [
          { params: { waitKey: "wait:<uuid1>:callback:0", v: 1 }, status: "running" },
          { params: { waitKey: "wait:<uuid2>:approval:0", v: 1 }, status: "waiting" },
        ],
      });
      SEEDED_INSTANCE_IDS.push(...isolated.instances("orchestration").map((i) => i.id));
    });

    afterAll(async () => {
      await isolated.close();
    });

    const probeTransport = () =>
      createCloudflareWorkflowsTransport({
        apiBaseUrl: isolated.baseUrl,
        accountId: ACCOUNT_ID,
        workflowName: WORKFLOW_NAME,
        apiToken: API_TOKEN,
        probeWorkflowName: PROBE_WORKFLOW_NAME,
      });

    test("REGRESSION: the probe touches only its own instance, never application orchestration", async () => {
      const orchestrationBefore = isolated.instances("orchestration").map((i) => ({
        id: i.id,
        status: i.status,
        events: i.events.slice(),
        terminated: i.terminated,
      }));
      const probe = await probeTransport().probe();
      expect(probe.ok).toBe(true);
      // The probe created and terminated EXACTLY one instance on the
      // probe workflow.
      const probeInstances = isolated.instances("probe");
      expect(probeInstances.length).toBe(1);
      expect(probeInstances[0]?.terminated).toBe(true);
      // Every seeded application instance is untouched: same status,
      // zero events, never terminated.
      const orchestrationAfter = isolated.instances("orchestration").map((i) => ({
        id: i.id,
        status: i.status,
        events: i.events.slice(),
        terminated: i.terminated,
      }));
      expect(orchestrationAfter).toEqual(orchestrationBefore);
      expect(SEEDED_INSTANCE_IDS.length).toBe(2);
      for (const id of SEEDED_INSTANCE_IDS) {
        expect(isolated.eventsOf(id)).toEqual([]);
        expect(isolated.wasTerminated(id)).toBe(false);
      }
    });

    test("BOUNDARY: the probe issues ZERO requests against the orchestration workflow", async () => {
      const before = isolated.requests.length;
      await probeTransport().probe();
      const newRequests = isolated.requests.slice(before);
      expect(
        newRequests.filter((r) => r.path.includes(`/workflows/${WORKFLOW_NAME}`)).length,
        "the probe must never address the orchestration workflow",
      ).toBe(0);
      expect(
        newRequests.filter((r) => r.path.includes(`/workflows/${PROBE_WORKFLOW_NAME}`)).length,
      ).toBe(3); // create + describe + terminate, all on the probe workflow
    });

    test("DISCRIMINATION: the weakened probe configurations are rejected fail-closed", async () => {
      // No probe workflow configured.
      const noProbe = createCloudflareWorkflowsTransport({
        apiBaseUrl: isolated.baseUrl,
        accountId: ACCOUNT_ID,
        workflowName: WORKFLOW_NAME,
        apiToken: API_TOKEN,
      });
      await expect(noProbe.probe()).rejects.toThrow(
        /ZECK_WORKFLOW_PROBE_NAME is not set; the probe never targets the orchestration workflow/,
      );
      // Probe workflow == orchestration workflow: rejected at
      // construction (configuration validation).
      expect(() =>
        createCloudflareWorkflowsTransport({
          apiBaseUrl: isolated.baseUrl,
          accountId: ACCOUNT_ID,
          workflowName: WORKFLOW_NAME,
          apiToken: API_TOKEN,
          probeWorkflowName: WORKFLOW_NAME,
        }),
      ).toThrow(/must differ from workflowName/);
      // And no probe wire call happened for the refused probe.
      const before = isolated.requests.length;
      await expect(noProbe.probe()).rejects.toThrow(WorkflowConfigError);
      expect(isolated.requests.length).toBe(before);
    });
  });
});

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

async function startHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server: Server = createHttpServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  };
}
