/**
 * Protocol — the container-runner REST protocol over REAL HTTP
 * (WORK-046 / D-05; acceptance criterion 7 + the Required
 * Verification "provider-adapter HTTP/protocol tests over a real
 * in-process protocol server").
 *
 * This is NOT a real container runtime — it is a local, deterministic
 * stand-in (tests/integration/compute/fake-runner.ts) that speaks the
 * documented Zeck container-runner protocol (deploy/README.md §D-05)
 * and VERIFIES the Bearer authorization, so the adapter's wire
 * behavior is proven end-to-end without a deployed runner. Real-runner
 * evidence is separately gated (compute/runner-live.test.ts) and never
 * claimed from this server.
 *
 * RUN-IDENTITY REGRESSIONS (the Architect finding on PR #10 — the
 * pre-revision defect: the external run id was derived from the
 * configuration + timeout ALONE, so two DIFFERENT Zeck executions
 * doing identical work collapsed into ONE external runner run):
 *
 *  - DISTINCT-EXECUTION SEPARATION: identical configuration + identical
 *    timeout + DIFFERENT run identities (different executions) -> two
 *    DISTINCT external run ids, two 202 submissions, each execution
 *    observes its OWN run's outcome (no cross-contamination);
 *  - SAME-EXECUTION IDEMPOTENCY: identical configuration + identical
 *    timeout + the SAME run identity (a replay of the same logical
 *    run) -> the SAME external run id: exactly one run is ever held,
 *    the replay's submission is the idempotent 409, and both
 *    observations converge on the one run's outcome;
 *  - FAIL-CLOSED IDENTITY: a missing/empty/oversized identity (or a
 *    non-positive timeout) is rejected BEFORE any wire call — an
 *    unidentified run is never dispatched.
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
import { createServer } from "node:http";
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
import type { ContainerRunOptions } from "../../../src/platform/sandbox/runtime-client";
import { type FakeRunnerServer, type StoredRun, startFakeRunner } from "./fake-runner";

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

/**
 * The deterministic external run id the client derives — the
 * execution-scoped RUN IDENTITY first, then the configuration and the
 * admitted timeout (the pre-revision derivation omitted the identity:
 * the regression this suite pins).
 */
const runIdOf = (identity: string, config: ContainerConfiguration, timeoutMs: number): string =>
  `run-${createHash("sha256")
    .update(JSON.stringify([identity, config, timeoutMs]))
    .digest("hex")
    .slice(0, 32)}`;

/** A distinct execution-scoped identity per logical run under test. */
const identityOf = (executionId: string): string => `zeck-run:test-app:${executionId}:sandbox-1`;

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
    const identity = identityOf("execution-happy-path");
    const runId = runIdOf(identity, config, 5_000);
    runner.seed(runId, succeedRun("hello world\n"));
    const result = await client().run(config, { timeoutMs: 5_000, runIdentity: identity });
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
    const identity = identityOf("execution-auth-check");
    runner.seed(runIdOf(identity, config, 5_000), succeedRun(""));
    await client().run(config, { timeoutMs: 5_000, runIdentity: identity });
    const posts = runner.requestLog().filter((entry) => entry.method === "POST");
    expect(posts.length).toBeGreaterThanOrEqual(1);
    expect(posts.every((entry) => entry.authed)).toBe(true);
  });

  test("REGRESSION distinct-execution separation: identical work, different executions -> TWO external runs, never one", async () => {
    // Two DIFFERENT Zeck executions doing IDENTICAL work: the SAME
    // container configuration and the SAME admitted timeout. Before
    // the identity binding this pair derived ONE shared external run
    // id — the second execution received the first execution's run
    // (cross-execution collapse). With the run identity bound, they
    // must be two physically separate runner runs.
    const config = { ...SAFE_CONFIG, args: ["identical-work"] };
    const executionA = identityOf("execution-A-identical-work");
    const executionB = identityOf("execution-B-identical-work");
    expect(executionA).not.toBe(executionB);
    const fresh = await startFakeRunner({ apiToken: token, autoSucceed: true });
    try {
      const freshClient = createContainerRuntimeClient({
        baseUrl: fresh.baseUrl,
        apiToken: token,
        requestTimeoutMs: 2_000,
        pollIntervalMs: 50,
        maxOutputBytes: 256,
      });
      const first = await freshClient.run(config, { timeoutMs: 5_000, runIdentity: executionA });
      const second = await freshClient.run(config, { timeoutMs: 5_000, runIdentity: executionB });

      // TWO distinct external run ids — the runner holds both.
      const ids = fresh.runIds();
      expect(ids.length).toBe(2);
      expect(new Set(ids).size).toBe(2);
      const expectedA = runIdOf(executionA, config, 5_000);
      const expectedB = runIdOf(executionB, config, 5_000);
      expect(ids).toContain(expectedA);
      expect(ids).toContain(expectedB);
      expect(expectedA).not.toBe(expectedB);

      // Both submissions were ACCEPTED (202) — neither execution was
      // handed the other's run (the collapse would have answered 409).
      const submissions = fresh.submissions();
      expect(submissions.length).toBe(2);
      expect(submissions.every((entry) => entry.status === 202)).toBe(true);

      // Each execution observes ITS OWN run's outcome (the auto-succeed
      // stdout derives from the run id — distinct per run).
      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);
      expect(first.stdout).toBe(`done:${expectedA.slice(-16)}`);
      expect(second.stdout).toBe(`done:${expectedB.slice(-16)}`);
      expect(first.stdout).not.toBe(second.stdout);
    } finally {
      await fresh.close();
    }
  });

  test("REGRESSION same-execution idempotency: one logical run replayed -> ONE external run, the 409 convergence", async () => {
    // A REPLAY of the same logical run (same execution, same admitted
    // configuration): the SAME run identity re-derives the SAME
    // external run id. Exactly one run is ever held by the runner; the
    // replay's submission is the idempotent 409; both observations
    // converge on the one run's outcome.
    const config = { ...SAFE_CONFIG, args: ["replayed-logical-run"] };
    const identity = identityOf("execution-replay");
    const fresh = await startFakeRunner({ apiToken: token, autoSucceed: true });
    try {
      const freshClient = createContainerRuntimeClient({
        baseUrl: fresh.baseUrl,
        apiToken: token,
        requestTimeoutMs: 2_000,
        pollIntervalMs: 50,
        maxOutputBytes: 256,
      });
      const expectedRunId = runIdOf(identity, config, 5_000);
      const first = await freshClient.run(config, { timeoutMs: 5_000, runIdentity: identity });
      const replay = await freshClient.run(config, { timeoutMs: 5_000, runIdentity: identity });

      // Exactly ONE external run, submitted twice: 202 then the
      // idempotent 409.
      expect(fresh.runIds()).toStrictEqual([expectedRunId]);
      const submissions = fresh.submissionsFor(expectedRunId);
      expect(submissions.length).toBe(2);
      expect(submissions[0]?.status).toBe(202);
      expect(submissions[1]?.status).toBe(409);

      // Both observations converge on the one run's outcome.
      expect(first.exitCode).toBe(0);
      expect(replay.exitCode).toBe(0);
      expect(replay.stdout).toBe(first.stdout);
      expect(replay.stdout).toBe(`done:${expectedRunId.slice(-16)}`);
    } finally {
      await fresh.close();
    }
  });

  test("REGRESSION fail-closed identity: a missing, empty, oversized or malformed identity never reaches the wire", async () => {
    const config = SAFE_CONFIG;
    const requestsBefore = runner.requestLog().length;

    // Missing (the pre-contract shape) — rejected before any wire call.
    const missing = { timeoutMs: 5_000 } as ContainerRunOptions;
    await expect(client().run(config, missing)).rejects.toThrow(ContainerRuntimeConfigError);
    await expect(client().run(config, missing)).rejects.toThrow(/runIdentity/);

    // Empty.
    await expect(client().run(config, { timeoutMs: 5_000, runIdentity: "" })).rejects.toThrow(
      /runIdentity/,
    );

    // Oversized (beyond the 256-character bound).
    await expect(
      client().run(config, { timeoutMs: 5_000, runIdentity: "x".repeat(257) }),
    ).rejects.toThrow(/bounded/);

    // Non-string identity.
    const nonString = { timeoutMs: 5_000, runIdentity: 42 } as unknown as ContainerRunOptions;
    await expect(client().run(config, nonString)).rejects.toThrow(/runIdentity/);

    // Non-positive timeout (the admitted bound must be a positive
    // integer — an unbounded run is never dispatched).
    await expect(
      client().run(config, { timeoutMs: 0, runIdentity: identityOf("execution-bad-timeout") }),
    ).rejects.toThrow(/timeoutMs/);

    // ZERO wire traffic from any of the rejected attempts.
    expect(runner.requestLog().length).toBe(requestsBefore);
  });

  test("409 (already held) is an idempotent re-submission, then poll", async () => {
    const config = { ...SAFE_CONFIG, args: ["idempotent"] };
    const identity = identityOf("execution-idempotent-hold");
    const runId = runIdOf(identity, config, 5_000);
    runner.seed(runId, succeedRun("replayed"));
    const first = await client().run(config, { timeoutMs: 5_000, runIdentity: identity });
    const second = await client().run(config, { timeoutMs: 5_000, runIdentity: identity });
    expect(first.stdout).toBe("replayed");
    expect(second.stdout).toBe("replayed");
    // The held run was never re-created: both submissions answered 409.
    const submissions = runner.submissionsFor(runId);
    expect(submissions.length).toBe(2);
    expect(submissions.every((entry) => entry.status === 409)).toBe(true);
  });

  test("a rejected credential (401) is PERMANENT, fail closed", async () => {
    const failing = await startFakeRunner({ apiToken: token, rejectAuth: true });
    try {
      const badClient = createContainerRuntimeClient({
        baseUrl: failing.baseUrl,
        apiToken: "wrong-token",
        requestTimeoutMs: 2_000,
      });
      await expect(
        badClient.run(SAFE_CONFIG, {
          timeoutMs: 5_000,
          runIdentity: identityOf("execution-credential"),
        }),
      ).rejects.toThrow(ContainerRuntimeError);
      try {
        await badClient.run(SAFE_CONFIG, {
          timeoutMs: 5_000,
          runIdentity: identityOf("execution-credential"),
        });
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
        await transientClient.run(SAFE_CONFIG, {
          timeoutMs: 5_000,
          runIdentity: identityOf("execution-outage"),
        });
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
        await forgetfulClient.run(SAFE_CONFIG, {
          timeoutMs: 5_000,
          runIdentity: identityOf("execution-forgotten"),
        });
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
    const identity = identityOf("execution-big-output");
    runner.seed(runIdOf(identity, config, 5_000), succeedRun("x".repeat(10_000)));
    const result = await client().run(config, { timeoutMs: 5_000, runIdentity: identity });
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
      await expect(
        malformedClient.run(SAFE_CONFIG, {
          timeoutMs: 5_000,
          runIdentity: identityOf("execution-malformed"),
        }),
      ).rejects.toThrow(/malformed status envelope|fail closed/);
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
