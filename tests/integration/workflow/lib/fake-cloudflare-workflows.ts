/**
 * A minimal in-process Cloudflare-Workflows-REST-compatible server
 * for the D-04 orchestration integration tests (WORK-045).
 *
 * This is NOT Cloudflare — it is a local, deterministic stand-in
 * that speaks the documented Workflows REST surface the adapter
 * uses (create instance / instance details / send event / change
 * status) and VERIFIES the Bearer authorization, so the adapter's
 * wire behavior is proven end-to-end over real HTTP without
 * provider credentials. Real-Cloudflare evidence is separately
 * gated (workflow-live.test.ts) and never claimed from this server.
 *
 * The server hosts the ORCHESTRATION workflow
 * (options.workflowName) and, optionally, a second DEDICATED PROBE
 * WORKFLOW on the same account (options.probeWorkflowName) — the
 * probe-isolation tests seed application-shaped instances on the
 * orchestration workflow and prove the probe never touches it.
 * Requests to any other workflow name answer 404 (the adapter
 * cannot wander).
 *
 * Wire protocol (developers.cloudflare.com/api/resources/workflows):
 *  - POST /accounts/{account}/workflows/{name}/instances
 *    body {"instance_id": <optional>, "params": <JSON string>}
 *    → {"success":true,"result":{"id","status","version_id",
 *      "workflow_id","trigger_source"}}
 *  - GET .../instances/{instance_id} (query simple=true)
 *    → {"success":true,"result":{"status","start","end","error",
 *      "output","params","queued","step_count","steps":[]}}
 *  - POST .../instances/{instance_id}/events/{event_type}
 *    body {"body": <value>}
 *    → {"success":true,"result":{"instanceId","timestamp"}}
 *  - PATCH .../instances/{instance_id}/status
 *    body {"status":"terminate"}
 *    → {"success":true,"result":{"status","timestamp"}}
 * Errors answer the Cloudflare v4 envelope:
 *  {"success":false,"errors":[{"code","message"}]}.
 */

import { createServer } from "node:http";

export interface FakeWorkflowOptions {
  readonly accountId: string;
  /** The ORCHESTRATION workflow name (the adapter's configured workflow). */
  readonly workflowName: string;
  readonly apiToken: string;
  /**
   * An additional workflow hosted on the same account: the DEDICATED
   * probe workflow. Requests routed here belong to probe traffic only.
   */
  readonly probeWorkflowName?: string;
  /**
   * Application-shaped instances pre-seeded on the ORCHESTRATION
   * workflow before any request (the probe-isolation workload).
   */
  readonly seededInstances?: readonly { readonly params: unknown; readonly status?: string }[];
  /** Fail every request with 401 (credential-rejection path). */
  readonly rejectAuth?: boolean;
  /** Answer every request with 503 (transient outage path). */
  readonly outage?: boolean;
  /** Answer the next N instance-create calls with 429 (rate-limit path). */
  readonly rateLimitCreates?: number;
}

interface StoredInstance {
  readonly id: string;
  readonly workflow: string;
  readonly params: unknown;
  status: string;
  readonly events: { readonly eventType: string; readonly body: unknown }[];
  terminated: boolean;
  readonly createdAt: string;
}

export interface FakeWorkflowRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string;
  readonly body: unknown;
}

/** Which of the hosted workflows a request addresses. */
export type FakeWorkflowRole = "orchestration" | "probe" | "other";

export interface FakeWorkflowServer {
  readonly port: number;
  readonly baseUrl: string;
  close(): Promise<void>;
  readonly requests: readonly FakeWorkflowRequest[];
  /** The live instances of one workflow (by role). */
  instances(role: FakeWorkflowRole): readonly StoredInstance[];
  /** The events delivered to one instance id. */
  eventsOf(instanceId: string): readonly { readonly eventType: string; readonly body: unknown }[];
  /** True iff the instance id was terminated through the status endpoint. */
  wasTerminated(instanceId: string): boolean;
  /** The count of instance-create requests answered 429. */
  readonly rateLimited: number;
}

export async function startFakeCloudflareWorkflows(
  options: FakeWorkflowOptions,
): Promise<FakeWorkflowServer> {
  const requests: FakeWorkflowRequest[] = [];
  const instances = new Map<string, StoredInstance>();
  let instanceCounter = 0;
  let rateLimitBudget = options.rateLimitCreates ?? 0;
  let rateLimited = 0;

  const hosted = (name: string): FakeWorkflowRole => {
    if (name === options.workflowName) {
      return "orchestration";
    }
    if (options.probeWorkflowName !== undefined && name === options.probeWorkflowName) {
      return "probe";
    }
    return "other";
  };

  for (const seeded of options.seededInstances ?? []) {
    const id = `cf-seeded-${++instanceCounter}`;
    instances.set(id, {
      id,
      workflow: options.workflowName,
      params: seeded.params,
      status: seeded.status ?? "running",
      events: [],
      terminated: false,
      createdAt: new Date(Date.UTC(2023, 6, 17, 0, 0, 0)).toISOString(),
    });
  }

  const json = (response: ServerResponseLike, status: number, payload: unknown): void => {
    const body = JSON.stringify(payload);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(body);
  };

  const errorEnvelope = (code: number, message: string) => ({
    success: false,
    errors: [{ code, message }],
  });

  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const text = Buffer.concat(chunks).toString("utf8");
      const body = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
      requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        authorization: req.headers.authorization ?? "",
        body,
      });
      if (options.rejectAuth === true) {
        json(res, 401, errorEnvelope(10000, "Authentication error"));
        return;
      }
      if (options.outage === true) {
        json(res, 503, errorEnvelope(11000, "Service unavailable"));
        return;
      }
      const match = /^\/accounts\/([^/]+)\/workflows\/([^/]+)(\/.*)?$/.exec(req.url ?? "");
      if (
        match === null ||
        match[1] === undefined ||
        match[1] !== options.accountId ||
        match[2] === undefined
      ) {
        json(res, 404, errorEnvelope(7000, "No route for that URI"));
        return;
      }
      const workflowName: string = match[2];
      const rest = match[3] ?? "";
      const role = hosted(workflowName);
      if (role === "other") {
        json(res, 404, errorEnvelope(7001, "No such workflow"));
        return;
      }

      // POST /instances — create one instance.
      if (req.method === "POST" && rest === "/instances") {
        if (rateLimitBudget > 0) {
          rateLimitBudget -= 1;
          rateLimited += 1;
          json(res, 429, errorEnvelope(9715, "You are being rate limited"));
          return;
        }
        const record = (body ?? {}) as Record<string, unknown>;
        const requestedId =
          typeof record.instance_id === "string" && record.instance_id.length > 0
            ? record.instance_id
            : undefined;
        const id = requestedId ?? `cf-inst-${++instanceCounter}`;
        if (instances.has(id)) {
          json(res, 409, errorEnvelope(10003, "Instance id already exists"));
          return;
        }
        instances.set(id, {
          id,
          workflow: workflowName,
          params: typeof record.params === "string" ? JSON.parse(record.params) : record.params,
          status: "queued",
          events: [],
          terminated: false,
          createdAt: new Date().toISOString(),
        });
        json(res, 200, {
          success: true,
          result: {
            id,
            status: "queued",
            version_id: "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e",
            workflow_id: "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26f",
            trigger_source: "api",
          },
        });
        return;
      }

      // Sub-resource routing: /instances/{id}[/events/{type}|/status].
      const sub = /^\/instances\/([^/?]+)(?:\/([^/?]+)(?:\/([^/?]+))?)?/.exec(rest);
      if (sub === null || sub[1] === undefined) {
        json(res, 404, errorEnvelope(7000, "No route for that URI"));
        return;
      }
      const instanceId = sub[1];
      const instance = instances.get(instanceId);
      if (instance === undefined || instance.workflow !== workflowName) {
        json(res, 404, errorEnvelope(7002, "No such instance"));
        return;
      }

      // GET /instances/{id} — instance details.
      if (req.method === "GET" && (sub[2] === undefined || sub[2] === "")) {
        json(res, 200, {
          success: true,
          result: {
            status: instance.status,
            start: instance.createdAt,
            end: instance.terminated ? new Date().toISOString() : null,
            error: null,
            output: null,
            params: instance.params,
            queued: instance.createdAt,
            step_count: 1,
            steps: [],
          },
        });
        return;
      }

      // POST /instances/{id}/events/{type} — send one event.
      if (req.method === "POST" && sub[2] === "events" && sub[3] !== undefined) {
        instance.events.push({
          eventType: sub[3],
          body: ((body ?? {}) as Record<string, unknown>).body,
        });
        json(res, 200, {
          success: true,
          result: { instanceId, timestamp: new Date().toISOString() },
        });
        return;
      }

      // PATCH /instances/{id}/status — change status (terminate).
      if (req.method === "PATCH" && sub[2] === "status") {
        const record = (body ?? {}) as Record<string, unknown>;
        const status = typeof record.status === "string" ? record.status : "";
        if (status === "terminate") {
          instance.terminated = true;
          instance.status = "terminated";
        } else if (status === "pause") {
          instance.status = "paused";
        } else if (status === "resume") {
          instance.status = "running";
        } else {
          json(res, 400, errorEnvelope(7003, "Unsupported status change"));
          return;
        }
        json(res, 200, {
          success: true,
          result: { status: instance.status, timestamp: new Date().toISOString() },
        });
        return;
      }

      json(res, 404, errorEnvelope(7000, "No route for that URI"));
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
    requests,
    instances: (role) =>
      [...instances.values()].filter((instance) => hosted(instance.workflow) === role),
    eventsOf: (instanceId) => instances.get(instanceId)?.events ?? [],
    wasTerminated: (instanceId) => instances.get(instanceId)?.terminated === true,
    rateLimited,
  };
}

interface ServerResponseLike {
  writeHead(status: number, headers: Record<string, string>): unknown;
  end(body: string): unknown;
}
