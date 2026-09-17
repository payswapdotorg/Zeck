/**
 * Integration — the deployed-plane identity attestation + the health
 * degradation classifications + the production smoke --url mode, over
 * REAL spawned plane processes (DEP-003 AC1/AC2/AC4).
 *
 * Real-process probes only: each test boots deploy/api.ts as a real
 * subprocess on an ephemeral port (the same independently-runnable
 * entry an operator deploys — never a mock of the probe path) and
 * exercises the DEP-003 surfaces against it:
 *
 *  - attestDeployedPlane: a plane at the checkout's exact revision
 *    VERIFIES; the same real plane attested at a DIFFERENT expected
 *    revision fails closed (the wrong-revision negative); a port with
 *    no listener fails closed (the unreachable negative);
 *  - GET /health of the real plane: the control-plane/dependency
 *    distinction on the wire, the dependency set per the manifests'
 *    provider map, the classification vocabulary (ready/degraded/
 *    unavailable), the authority-role/degraded-mode vocabulary from
 *    providers.json, and the fail-closed coherence (authoritative
 *    dependency not ready ⇒ 503 down; otherwise 200);
 *  - the production smoke --url mode: the full public-route smoke
 *    against the already-booted plane passes with --allow-degraded
 *    (the honest degraded boundary of an unprovisioned environment),
 *    and FAILS closed against a wrong-revision plane and an
 *    unreachable plane (never a warning).
 *
 * Requires the checkout's .git directory (exact-revision identity);
 * skips cleanly without it. No PostgreSQL server required: the
 * fail-closed/allowed-degraded pair IS the honest boundary proof.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { attestDeployedPlane } from "../../../deploy/plane-identity";
import { loadDeploymentManifest } from "../../../src/platform/deployment/manifest";
import { parseProviderTiers } from "../../../src/platform/deployment/provider-tiers";
import { expectedProbeConcerns } from "../../../src/platform/deployment/readiness";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HAS_GIT = existsSync(join(REPO_ROOT, ".git"));

const manifest = loadDeploymentManifest((file) =>
  readFileSync(join(REPO_ROOT, "deploy", "manifests", file), "utf8"),
);
const ledger = parseProviderTiers(
  readFileSync(join(REPO_ROOT, "deploy", "manifests", "provider-tiers.json"), "utf8"),
  manifest,
);

const WRONG_REVISION = "b".repeat(40);

interface PlaneProcess {
  readonly baseUrl: string;
  readonly stop: () => Promise<void>;
}

const PLANE_STOPS: Array<() => Promise<void>> = [];

/** Boot the REAL bootstrap host as a subprocess on an ephemeral port. */
async function bootPlane(revisionOverride?: string): Promise<PlaneProcess> {
  const host = "127.0.0.1";
  const port = 39900 + (process.pid % 500) + Math.floor(Math.random() * 40);
  const baseUrl = `http://${host}:${port}`;
  const child = spawn(
    "bun",
    [join("deploy", "api.ts"), "--environment", "local", "--host", host, "--port", String(port)],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ZECK_ENVIRONMENT: "local",
        ...(revisionOverride === undefined ? {} : { ZECK_DEPLOY_GIT_REVISION: revisionOverride }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  // Wait for the transport to answer (the plane prints its boot log).
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      void response.body?.cancel();
      break;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    }
  }
  // Idempotent stop: every test's `finally` stops its own plane AND the
  // afterAll sweep re-invokes the registered stops — the second call
  // must be a no-op (the exit listener of a dead child never fires).
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    const exited = new Promise<number>((resolvePromise) => {
      child.once("exit", (code) => resolvePromise(code ?? 0));
    });
    child.kill("SIGTERM");
    const code = await Promise.race([
      exited,
      new Promise<number>((resolvePromise) => {
        const killer = setTimeout(() => {
          child.kill("SIGKILL");
          resolvePromise(-1);
        }, 10_000);
        exited.then((exitCode) => {
          clearTimeout(killer);
          resolvePromise(exitCode);
        });
      }),
    ]);
    expect(code).toBe(0);
  };
  PLANE_STOPS.push(stop);
  expect(stderr, "the plane must boot without errors").toBe("");
  return { baseUrl, stop };
}

afterAll(async () => {
  await Promise.all(PLANE_STOPS.map((stop) => stop()));
});

function currentRevision(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

interface ToolResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runPublicSmoke(args: readonly string[]): ToolResult {
  const result = spawnSync("bun", [join("deploy", "public-smoke.ts"), ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ZECK_ENVIRONMENT: "local" },
    timeout: 120_000,
  });
  return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function reportOf(result: ToolResult): Record<string, unknown> {
  const start = result.stdout.indexOf("{");
  expect(start).toBeGreaterThanOrEqual(0);
  return JSON.parse(result.stdout.slice(start)) as Record<string, unknown>;
}

describe.skipIf(!HAS_GIT)(
  "the deployed-plane identity attestation over a real plane process (DEP-003 AC4)",
  () => {
    test("a real plane at the checkout revision attests and verifies", async () => {
      const plane = await bootPlane();
      try {
        const attestation = await attestDeployedPlane(plane.baseUrl, {
          revision: currentRevision(),
          environment: "local",
          manifest,
          ledger,
        });
        expect(attestation.verified).toBe(true);
        expect(attestation.reason).toBeUndefined();
        expect(attestation.attested?.gitRevision).toBe(currentRevision());
        expect(attestation.attested?.runtimeIdentityId).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        await plane.stop();
      }
    }, 45_000);

    test("the same real plane attested at a DIFFERENT expected revision fails closed", async () => {
      const plane = await bootPlane();
      try {
        const attestation = await attestDeployedPlane(plane.baseUrl, {
          revision: WRONG_REVISION,
          environment: "local",
          manifest,
          ledger,
        });
        expect(attestation.verified).toBe(false);
        expect(attestation.reason).toBeDefined();
        expect(attestation.expectedRevision).toBe(WRONG_REVISION);
        // The attested document facts are still reported (the plane
        // ANSWERED — the failure is the revision mismatch, honest).
        expect(attestation.attested?.gitRevision).toBe(currentRevision());
      } finally {
        await plane.stop();
      }
    }, 45_000);

    test("an unreachable plane fails closed (no listener on the port)", async () => {
      // A port with no listener: bind once to reserve it, then close.
      const reserved = await new Promise<{ port: number }>((resolvePromise, reject) => {
        const net = require("node:net") as typeof import("node:net");
        const server = net.createServer();
        server.unref();
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (address === null || typeof address === "string") {
            reject(new Error("no port"));
            return;
          }
          const { port } = address;
          server.close(() => resolvePromise({ port }));
        });
      });
      const attestation = await attestDeployedPlane(`http://127.0.0.1:${reserved.port}`, {
        revision: currentRevision(),
        environment: "local",
        manifest,
        ledger,
        timeoutMs: 4000,
      });
      expect(attestation.verified).toBe(false);
      expect(attestation.reason).toContain("unreachable");
    }, 30_000);
  },
);

describe.skipIf(!HAS_GIT)(
  "the health degradation classifications of a real plane (DEP-003 AC2)",
  () => {
    test("GET /health reports the provider-map dependency set with the closed classification vocabulary", async () => {
      const plane = await bootPlane();
      try {
        const response = await fetch(`${plane.baseUrl}/health`);
        const body = (await response.json()) as {
          status: string;
          controlPlane: string;
          dependencies: {
            name: string;
            authority: string;
            status: string;
            degradedMode?: string;
            detail?: string | null;
          }[];
        };
        // The control-plane/dependency distinction on the wire.
        expect(body.controlPlane).toBe("ready");
        expect(["ready", "degraded", "down"]).toContain(body.status);

        // The dependency set is EXACTLY the manifests' provider map
        // projection for this environment (database/object-store/
        // coordination/compute for local).
        const expectedConcerns = expectedProbeConcerns(manifest, "local");
        expect(body.dependencies.map((dependency) => dependency.name).sort()).toEqual(
          [...expectedConcerns].sort(),
        );

        // The classification vocabulary + the provider-map authority
        // roles / degraded modes (never invented labels).
        const providerByConcern = new Map(manifest.providers.map((p) => [p.concern, p]));
        for (const dependency of body.dependencies) {
          expect(["ready", "degraded", "unavailable"]).toContain(dependency.status);
          const provider = providerByConcern.get(dependency.name);
          expect(provider, `concern ${dependency.name} is provider-map declared`).toBeDefined();
          const declaredAuthority =
            provider?.degradation.authority === "authoritative"
              ? "authoritative"
              : "non-authoritative";
          expect(dependency.authority).toBe(declaredAuthority);
          if (dependency.degradedMode !== undefined) {
            expect(dependency.degradedMode).toBe(provider?.degradation.mode);
          }
        }

        // Fail-closed coherence: an authoritative dependency not ready
        // makes the whole plane DOWN (503); otherwise the plane is up
        // (200, ready or explicitly degraded).
        const authoritativeDown = body.dependencies.some(
          (dependency) => dependency.authority === "authoritative" && dependency.status !== "ready",
        );
        expect(response.status).toBe(authoritativeDown ? 503 : 200);
        expect(body.status).toBe(authoritativeDown ? "down" : body.status);
        if (authoritativeDown) {
          const authority = body.dependencies.find(
            (dependency) => dependency.authority === "authoritative",
          );
          // The honest fail-closed detail, never fabricated ready.
          expect(authority?.status).toBe("unavailable");
          expect(authority?.detail).toContain("fail closed");
        }
      } finally {
        await plane.stop();
      }
    }, 45_000);
  },
);

describe.skipIf(!HAS_GIT)(
  "the production smoke --url mode against real planes (DEP-003 AC1 negatives)",
  () => {
    test("the full public-route smoke against an already-booted plane passes with the explicit degraded boundary", async () => {
      const plane = await bootPlane();
      try {
        const result = runPublicSmoke([
          "--environment",
          "local",
          "--url",
          plane.baseUrl,
          "--allow-degraded",
        ]);
        expect(result.stderr).toBe("");
        expect(result.code).toBe(0);
        const report = reportOf(result);
        expect(report.mode).toBe("url");
        expect(report.planeUrl).toBe(plane.baseUrl);
        const attestation = report.attestation as Record<string, unknown>;
        expect(attestation.transportReachable).toBe(true);
        expect(attestation.identityBound).toBe(true);
        expect(attestation.identityVerified).toBe(true);
        expect(attestation.authBoundaryEnforced).toBe(true);
        expect(String(attestation.healthCheck)).toMatch(/ready|allowed-degraded/);
        expect(report.problems).toEqual([]);
        const coverage = report.routeCoverage as Record<string, unknown>;
        expect(coverage.probed).toBeGreaterThan(20);
      } finally {
        await plane.stop();
      }
    }, 120_000);

    test("a wrong-revision plane FAILS the smoke (never a warning)", async () => {
      const plane = await bootPlane(WRONG_REVISION);
      try {
        const result = runPublicSmoke([
          "--environment",
          "local",
          "--url",
          plane.baseUrl,
          "--allow-degraded",
        ]);
        expect(result.code).toBe(1);
        const report = reportOf(result);
        const problems = report.problems as string[];
        expect(problems.some((problem) => problem.includes("exact-revision identity attest"))).toBe(
          true,
        );
        const attestation = report.attestation as Record<string, unknown>;
        expect(attestation.identityVerified).toBe(false);
      } finally {
        await plane.stop();
      }
    }, 120_000);

    test("an unreachable plane FAILS the smoke (never a warning)", async () => {
      const result = runPublicSmoke([
        "--environment",
        "local",
        "--url",
        "http://127.0.0.1:1",
        "--allow-degraded",
      ]);
      expect(result.code).toBe(1);
      const report = reportOf(result);
      const problems = report.problems as string[];
      expect(problems.some((problem) => problem.includes("unreachable"))).toBe(true);
      const attestation = report.attestation as Record<string, unknown>;
      expect(attestation.transportReachable).toBe(false);
      expect(attestation.identityVerified).toBe(false);
    }, 120_000);
  },
);
