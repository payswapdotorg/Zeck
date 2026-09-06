/**
 * The shared in-process container-runner protocol server (WORK-046 /
 * D-05; the documented Zeck container-runner REST protocol —
 * deploy/README.md §D-05).
 *
 * A local, deterministic stand-in that speaks the documented wire
 * protocol and VERIFIES the Bearer authorization, so the adapter's
 * wire behavior — and the run-identity derivation — are proven over
 * REAL HTTP without a deployed runner. Real-runner evidence is
 * separately gated (compute/runner-live.test.ts) and never claimed
 * from this server.
 *
 * Wire protocol:
 *  - POST {base}/v1/runs
 *    body {"runId", "config": <ContainerConfiguration>, "timeoutMs"}
 *    -> 202 {"runId", "accepted": true} | 409 (already held)
 *  - GET {base}/v1/runs/{runId}
 *    -> 200 {"status": "running"} | 200 terminal shape | 404
 *  - Bearer auth verified on every request (401 otherwise).
 *
 * Observability (the regression evidence surface):
 *  - `submissions()` — the ordered POST record (runId + answered status);
 *  - `runIds()` — the run ids the runner currently holds;
 *  - `submissionsFor(runId)` — every submission attempt of one run id.
 */

import { createServer, type Server } from "node:http";

export interface StoredRun {
  readonly config: unknown;
  readonly timeoutMs: number;
  status: "running" | "succeeded" | "failed";
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface SubmissionRecord {
  readonly runId: string;
  readonly status: number;
}

export interface RequestRecord {
  readonly method: string;
  readonly path: string;
  readonly authed: boolean;
}

export interface FakeRunnerOptions {
  readonly apiToken: string;
  /** Fail every request with 401 (credential-rejection path). */
  readonly rejectAuth?: boolean;
  /** Answer every request with 503 (transient outage path). */
  readonly outage?: boolean;
  /** Forget every run right after accepting it (retention loss). */
  readonly forgetRuns?: boolean;
  /**
   * Complete every accepted run immediately (terminal on arrival;
   * deterministic stdout derived from the run id) — models a runner
   * whose runs are done by the time the client polls, and makes the
   * same-execution replay convergence observable without pre-seeding.
   */
  readonly autoSucceed?: boolean;
  /**
   * Complete every accepted run after this delay (ms) — models real
   * execution time (the run stays `running` until the timer flips it
   * terminal); used to race the run against lease expiry.
   */
  readonly completeAfterMs?: number;
}

export interface FakeRunnerServer {
  readonly port: number;
  readonly baseUrl: string;
  /** Seed one run's observation state directly. */
  seed: (runId: string, run: StoredRun) => void;
  /** The ordered request record (method + path + auth presence). */
  requestLog: () => readonly RequestRecord[];
  /** The ordered POST submission record (runId + answered status). */
  submissions: () => readonly SubmissionRecord[];
  /** The run ids the runner currently holds. */
  runIds: () => readonly string[];
  /** Every submission attempt of one run id. */
  submissionsFor: (runId: string) => readonly SubmissionRecord[];
  close: () => Promise<void>;
}

export async function startFakeRunner(options: FakeRunnerOptions): Promise<FakeRunnerServer> {
  const runs = new Map<string, StoredRun>();
  const requests: RequestRecord[] = [];
  const submissions: SubmissionRecord[] = [];
  const server: Server = createServer((request, response) => {
    const authed =
      options.rejectAuth !== true && request.headers.authorization === `Bearer ${options.apiToken}`;
    requests.push({
      method: request.method ?? "",
      path: request.url ?? "",
      authed,
    });
    const send = (status: number, body: unknown): void => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (!authed) {
      send(401, { error: "unauthorized" });
      return;
    }
    if (options.outage === true) {
      send(503, { error: "unavailable" });
      return;
    }
    if (request.method === "POST" && request.url === "/v1/runs") {
      let raw = "";
      request.on("data", (chunk) => {
        raw += String(chunk);
      });
      request.on("end", () => {
        try {
          const body = JSON.parse(raw) as { runId?: string; config?: unknown; timeoutMs?: number };
          if (typeof body.runId !== "string" || body.config === undefined) {
            send(400, { error: "malformed submission" });
            return;
          }
          if (runs.has(body.runId)) {
            submissions.push({ runId: body.runId, status: 409 });
            send(409, { runId: body.runId, accepted: true, note: "already held" });
            return;
          }
          submissions.push({ runId: body.runId, status: 202 });
          const autoSucceeded: StoredRun = {
            config: body.config,
            timeoutMs: body.timeoutMs ?? 5_000,
            status: "succeeded",
            exitCode: 0,
            timedOut: false,
            stdout: `done:${body.runId.slice(-16)}`,
            stderr: "",
            durationMs: 7,
          };
          const created: StoredRun =
            options.autoSucceed === true
              ? autoSucceeded
              : {
                  config: body.config,
                  timeoutMs: body.timeoutMs ?? 5_000,
                  status: "running",
                  exitCode: null,
                  timedOut: false,
                  stdout: "",
                  stderr: "",
                  durationMs: 0,
                };
          runs.set(body.runId, created);
          if (options.completeAfterMs !== undefined && options.autoSucceed !== true) {
            const completing = created;
            setTimeout(() => {
              completing.status = "succeeded";
              completing.exitCode = 0;
              completing.timedOut = false;
              completing.stdout = `done:${body.runId?.slice(-16) ?? ""}`;
              completing.stderr = "";
              completing.durationMs = 9;
            }, options.completeAfterMs);
          }
          send(202, { runId: body.runId, accepted: true });
          if (options.forgetRuns === true) {
            setImmediate(() => {
              runs.delete(body.runId as string);
            });
          }
        } catch {
          send(400, { error: "malformed submission" });
        }
      });
      return;
    }
    const observationMatch = /^\/v1\/runs\/([^/]+)$/.exec(request.url ?? "");
    if (request.method === "GET" && observationMatch !== null) {
      const runId = decodeURIComponent(observationMatch[1] ?? "");
      const run = runs.get(runId);
      if (run === undefined) {
        send(404, { error: "unknown run" });
        return;
      }
      if (run.status === "running") {
        send(200, { status: "running" });
        return;
      }
      send(200, {
        status: run.status,
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        stdout: run.stdout,
        stderr: run.stderr,
        durationMs: run.durationMs,
      });
      return;
    }
    send(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    seed: (runId, run) => {
      runs.set(runId, run);
    },
    requestLog: () => [...requests],
    submissions: () => [...submissions],
    runIds: () => [...runs.keys()],
    submissionsFor: (runId) => submissions.filter((entry) => entry.runId === runId),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
