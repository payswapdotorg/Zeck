/**
 * Protocol — the container-runner REST protocol over REAL HTTP
 * (WORK-046 / D-05; acceptance criterion 7 + the Required
 * Verification "provider-adapter HTTP/protocol tests over a real
 * in-process protocol server").
 *
 * This is NOT a real container runtime — it is a local, deterministic
 * stand-in that speaks the documented Zeck container-runner protocol
 * (deploy/README.md §D-05) and VERIFIES the Bearer authorization, so
 * the adapter's wire behavior is proven end-to-end without a deployed
 * runner. Real-runner evidence is separately gated
 * (compute/runner-live.test.ts) and never claimed from this server.
 *
 * Wire protocol:
 *  - POST {base}/v1/runs
 *    body {"runId", "config": <ContainerConfiguration>, "timeoutMs"}
 *    -> 202 {"runId", "accepted": true} | 409 (already held)
 *  - GET {base}/v1/runs/{runId}
 *    -> 200 {"status": "running"} | 200 terminal shape | 404
 *  - Bearer auth verified on every request (401 otherwise).
 */

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  ContainerRuntimeConfigError,
  ContainerRuntimeError,
  createContainerRuntimeClient,
  probeContainerRunner,
} from "../../../src/platform/compute/container-runtime";
import {
  type ContainerConfiguration,
  containerConfigurationViolations,
} from "../../../src/platform/sandbox/container-profile";

/** A safe container configuration (the escape validator accepts it). */
const SAFE_CONFIG: ContainerConfiguration = {
  image: "zeck-sandbox-base:1",
  command: "python3",
  args: ["analyze.py"],
  env: [{ name: "MODE", value: "batch" }],
  mounts: [],
  network: { mode: "none", allowedHosts: [] },
  resourceLimits: { cpuMilliCores: 500, memoryMiB: 128, executionTimeoutMs: 5_000 },
  readOnlyRootfs: true,
  runAsNonRoot: true,
  privileged: false,
  hostNetwork: false,
  hostPid: false,
  hostIpc: false,
  devices: [],
  addedCapabilities: [],
  droppedCapabilities: ["ALL"],
  seccompProfile: "default",
  noNewPrivileges: true,
};

interface StoredRun {
  readonly config: unknown;
  readonly timeoutMs: number;
  status: "running" | "succeeded" | "failed";
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

interface FakeRunnerOptions {
  readonly apiToken: string;
  /** Fail every request with 401 (credential-rejection path). */
  readonly rejectAuth?: boolean;
  /** Answer every request with 503 (transient outage path). */
  readonly outage?: boolean;
  /** Forget every run right after accepting it (retention loss). */
  readonly forgetRuns?: boolean;
}

interface FakeRunnerServer {
  readonly port: number;
  readonly baseUrl: string;
  /** Seed one run's observation state directly. */
  seed: (runId: string, run: StoredRun) => void;
  /** The ordered request record (method + path + auth presence). */
  requestLog: () => readonly {
    readonly method: string;
    readonly path: string;
    readonly authed: boolean;
  }[];
  close: () => Promise<void>;
}

async function startFakeRunner(options: FakeRunnerOptions): Promise<FakeRunnerServer> {
  const runs = new Map<string, StoredRun>();
  const requests: { method: string; path: string; authed: boolean }[] = [];
  const server: Server = createServer((request, response) => {
    const authed = request.headers.authorization === `Bearer ${options.apiToken}`;
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
            send(409, { runId: body.runId, accepted: true, note: "already held" });
            return;
          }
          runs.set(body.runId, {
            config: body.config,
            timeoutMs: body.timeoutMs ?? 5_000,
            status: "running",
            exitCode: null,
            timedOut: false,
            stdout: "",
            stderr: "",
            durationMs: 0,
          });
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
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** The deterministic run id the client derives for one configuration. */
const runIdOf = (config: ContainerConfiguration, timeoutMs: number): string =>
  `run-${createHash("sha256")
    .update(JSON.stringify([config, timeoutMs]))
    .digest("hex")
    .slice(0, 32)}`;

const succeedRun = (stdout: string): StoredRun => ({
  config: null,
  timeoutMs: 5_000,
  status: "succeeded",
  exitCode: 0,
  timedOut: false,
  stdout,
  stderr: "",
  durationMs: 42,
});

describe("container runner protocol (WORK-046 D-05)", () => {
  let runner: FakeRunnerServer;
  const token = "runner-test-token";

  beforeAll(async () => {
    runner = await startFakeRunner({ apiToken: token });
  });

  afterAll(async () => {
    await runner.close();
  });

  const client = () =>
    createContainerRuntimeClient({
      baseUrl: runner.baseUrl,
      apiToken: token,
      requestTimeoutMs: 2_000,
      pollIntervalMs: 50,
      maxOutputBytes: 256,
    });

  test("submission + observation: the documented happy path over real HTTP", async () => {
    const config = SAFE_CONFIG;
    const runId = runIdOf(config, 5_000);
    runner.seed(runId, succeedRun("hello world\n"));
    const result = await client().run(config, { timeoutMs: 5_000 });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("hello world\n");
    expect(result.stdoutDigest).toBe(
      createHash("sha256").update("hello world\n", "utf8").digest("hex"),
    );
    expect(result.durationMs).toBe(42);
  });

  test("the submission is authenticated (Bearer verified on the wire)", async () => {
    const config = { ...SAFE_CONFIG, args: ["auth-check"] };
    runner.seed(runIdOf(config, 5_000), succeedRun(""));
    await client().run(config, { timeoutMs: 5_000 });
    const posts = runner.requestLog().filter((entry) => entry.method === "POST");
    expect(posts.length).toBeGreaterThanOrEqual(1);
    expect(posts.every((entry) => entry.authed)).toBe(true);
  });

  test("409 (already held) is an idempotent re-submission, then poll", async () => {
    const config = { ...SAFE_CONFIG, args: ["idempotent"] };
    const runId = runIdOf(config, 5_000);
    runner.seed(runId, succeedRun("replayed"));
    const first = await client().run(config, { timeoutMs: 5_000 });
    const second = await client().run(config, { timeoutMs: 5_000 });
    expect(first.stdout).toBe("replayed");
    expect(second.stdout).toBe("replayed");
  });

  test("a rejected credential (401) is PERMANENT, fail closed", async () => {
    const failing = await startFakeRunner({ apiToken: token, rejectAuth: true });
    try {
      const badClient = createContainerRuntimeClient({
        baseUrl: failing.baseUrl,
        apiToken: "wrong-token",
        requestTimeoutMs: 2_000,
      });
      await expect(badClient.run(SAFE_CONFIG, { timeoutMs: 5_000 })).rejects.toThrow(
        ContainerRuntimeError,
      );
      try {
        await badClient.run(SAFE_CONFIG, { timeoutMs: 5_000 });
        expect.unreachable("the credential rejection must be permanent");
      } catch (error) {
        expect((error as ContainerRuntimeError).failureKind).toBe("permanent");
        expect((error as ContainerRuntimeError).status).toBe(401);
      }
    } finally {
      await failing.close();
    }
  });

  test("a transient outage (503) is TRANSIENT (bounded retry by the caller)", async () => {
    const down = await startFakeRunner({ apiToken: token, outage: true });
    try {
      const transientClient = createContainerRuntimeClient({
        baseUrl: down.baseUrl,
        apiToken: token,
        requestTimeoutMs: 2_000,
      });
      try {
        await transientClient.run(SAFE_CONFIG, { timeoutMs: 5_000 });
        expect.unreachable("the outage must fail");
      } catch (error) {
        expect((error as ContainerRuntimeError).failureKind).toBe("transient");
        expect((error as ContainerRuntimeError).status).toBe(503);
      }
    } finally {
      await down.close();
    }
  });

  test("404 (unknown run) is the honest unknown-outcome class: PERMANENT, fail closed", async () => {
    const forgetful = await startFakeRunner({ apiToken: token, forgetRuns: true });
    try {
      const forgetfulClient = createContainerRuntimeClient({
        baseUrl: forgetful.baseUrl,
        apiToken: token,
        requestTimeoutMs: 2_000,
        pollIntervalMs: 50,
        maxOutputBytes: 256,
      });
      // Submit is accepted (202), then the runner FORGETS the run
      // (retention loss) — the observation 404s and the client fails
      // closed PERMANENT: the honest unknown-outcome class, never
      // re-executed.
      try {
        await forgetfulClient.run(SAFE_CONFIG, { timeoutMs: 5_000 });
        expect.unreachable("the forgotten run must fail closed");
      } catch (error) {
        expect(error).toBeInstanceOf(ContainerRuntimeError);
        expect((error as ContainerRuntimeError).failureKind).toBe("permanent");
        expect((error as ContainerRuntimeError).status).toBe(404);
        expect((error as Error).message).toContain("unknown-outcome");
      }
    } finally {
      await forgetful.close();
    }
  });

  test("bounded output: stdout truncates deterministically on the byte boundary", async () => {
    const config = { ...SAFE_CONFIG, args: ["big-output"] };
    runner.seed(runIdOf(config, 5_000), succeedRun("x".repeat(10_000)));
    const result = await client().run(config, { timeoutMs: 5_000 });
    expect(result.stdout.length).toBe(256);
    expect(result.stdoutDigest).toBe(
      createHash("sha256").update("x".repeat(256), "utf8").digest("hex"),
    );
  });

  test("a malformed status envelope fails closed (permanent)", async () => {
    const malformed = createServer((request, response) => {
      if (request.method === "POST") {
        response.writeHead(202, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ runId: "r", accepted: true }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("not json at all");
    });
    await new Promise<void>((resolve) => {
      malformed.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const address = malformed.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const malformedClient = createContainerRuntimeClient({
        baseUrl: `http://127.0.0.1:${port}`,
        apiToken: token,
        requestTimeoutMs: 2_000,
        pollIntervalMs: 50,
      });
      await expect(malformedClient.run(SAFE_CONFIG, { timeoutMs: 5_000 })).rejects.toThrow(
        /malformed status envelope|fail closed/,
      );
    } finally {
      await new Promise<void>((resolve) => {
        malformed.close(() => resolve());
      });
    }
  });

  test("the configuration validator accepts only escape-free configurations (defense in depth)", () => {
    expect(containerConfigurationViolations(SAFE_CONFIG)).toHaveLength(0);
    const privileged: ContainerConfiguration = { ...SAFE_CONFIG, privileged: true };
    expect(containerConfigurationViolations(privileged).join(" ")).toContain(
      "privileged-container",
    );
  });

  test("configuration validation: fail closed with the exact variables", () => {
    expect(() => createContainerRuntimeClient({ baseUrl: "not-a-url", apiToken: token })).toThrow(
      ContainerRuntimeConfigError,
    );
    expect(() => createContainerRuntimeClient({ baseUrl: runner.baseUrl, apiToken: "" })).toThrow(
      /ZECK_CONTAINER_RUNNER_API_TOKEN/,
    );
    expect(() =>
      createContainerRuntimeClient({
        baseUrl: runner.baseUrl,
        apiToken: token,
        requestTimeoutMs: 1,
      }),
    ).toThrow(/requestTimeoutMs must be bounded/);
  });

  test("the probe: an authenticated synthetic run-id GET expects 404 (wire + credential, nothing executed)", async () => {
    const fresh = await startFakeRunner({ apiToken: token });
    try {
      const probe = await probeContainerRunner({
        baseUrl: fresh.baseUrl,
        apiToken: token,
        requestTimeoutMs: 2_000,
      });
      expect(probe.ok).toBe(true);
      expect(probe.detail).toContain("404");
      // The probe NEVER submitted a run (POST-free).
      const posts = fresh.requestLog().filter((entry) => entry.method === "POST");
      expect(posts.length).toBe(0);
    } finally {
      await fresh.close();
    }
  });

  test("the probe with a rejected credential fails closed honestly", async () => {
    const failing = await startFakeRunner({ apiToken: token, rejectAuth: true });
    try {
      const probe = await probeContainerRunner({
        baseUrl: failing.baseUrl,
        apiToken: "wrong",
        requestTimeoutMs: 2_000,
      });
      expect(probe.ok).toBe(false);
      expect(probe.detail).toContain("401");
    } finally {
      await failing.close();
    }
  });
});
