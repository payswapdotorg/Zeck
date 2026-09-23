/**
 * PPR-006 integration — the Vercel hosting entry's local-rail proof.
 *
 * THE PROOF: the root server.ts entry (the Fastify entrypoint Vercel's
 * framework detection captures) boots the REAL bootstrap composition
 * (the shared buildBootstrapApp — once per process, the module-level
 * singleton) as a REAL listener, and the repository's own
 * deploy:public-smoke --url path — the EXACT verification the
 * credentialed deployment run executes against the live plane —
 * attests it end to end:
 *
 *  - TRANSPORT: the entry answers;
 *  - IDENTITY (the hard attest): GET /identity recomputes at the
 *    checkout's exact revision (verifyRuntimeDeploymentIdentity);
 *  - HEALTH SEMANTICS: the honest control-plane/dependency facts
 *    (the no-PG degradation is the pre-authorized sandbox fallback:
 *    --allow-degraded records the explicit degraded pass, never
 *    silently — a reachable PostgreSQL authority would pass strict);
 *  - FULL PUBLIC-ROUTE COVERAGE: every route of the public table
 *    answers its honest boundary semantics (the 26 probes);
 *  - SHUTDOWN: SIGTERM drains gracefully (exit 0).
 *
 * THE HOSTILE NEGATIVE: an entry attesting a WRONG revision (the
 * ZECK_DEPLOY_GIT_REVISION override) is REFUSED by the same smoke
 * (exit 1, the exact-revision mismatch) — the deployed-plane identity
 * verification catches a wrong-revision plane, never warns.
 *
 * This file needs no database and no credentials: it exercises the
 * hosting entry over the local rail (bun runs the TypeScript entry
 * directly). It skips cleanly when no git checkout exists (the
 * default revision source is the checkout's HEAD).
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HAS_GIT = existsSync(join(REPO_ROOT, ".git"));

/** Reserve an ephemeral port then close the listener (a real free port). */
async function reservePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      server.close(() => resolvePromise(port));
    });
  });
}

/**
 * The child environment: the process environment with the
 * revision-override variable REMOVED (deterministic: the default
 * revision source is the checkout's HEAD on both sides of the attest)
 * and the given overrides applied.
 */
function childEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  delete env.ZECK_DEPLOY_GIT_REVISION;
  return { ...env, ...overrides };
}

interface EntryHandle {
  readonly baseUrl: string;
  readonly readStdout: () => string;
  readonly stop: () => Promise<number>;
}

/** Boot the REAL entry (bun server.ts) and wait for its listener. */
async function bootEntry(options: {
  readonly revisionOverride?: string;
  readonly attempts?: number;
}): Promise<EntryHandle> {
  let lastError = "unknown";
  for (let attempt = 0; attempt < (options.attempts ?? 3); attempt += 1) {
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const child = spawn("bun", ["server.ts"], {
      cwd: REPO_ROOT,
      env: childEnv({
        ZECK_ENVIRONMENT: "local",
        PORT: String(port),
        ...(options.revisionOverride === undefined
          ? {}
          : { ZECK_DEPLOY_GIT_REVISION: options.revisionOverride }),
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    // Wait for the listener (bounded 30s), never a bare process spawn.
    let transportOk = false;
    for (let probe = 0; probe < 120; probe += 1) {
      if (child.exitCode !== null) {
        break;
      }
      try {
        const response = await fetch(`${baseUrl}/health`);
        void response.body?.cancel();
        transportOk = true;
        break;
      } catch {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      }
    }
    if (!transportOk) {
      lastError = `the entry did not become reachable (exit ${child.exitCode}; stderr: ${stderr.slice(0, 200)})`;
      child.kill("SIGKILL");
      continue;
    }
    let stopped = false;
    const stop = async (): Promise<number> => {
      if (stopped) {
        return 0;
      }
      stopped = true;
      return await stopChild(child);
    };
    return { baseUrl, readStdout: () => stdout, stop };
  }
  throw new Error(`could not boot the Vercel hosting entry: ${lastError}`);
}

/** SIGTERM a child and await its exit (SIGKILL after a 10s bound). */
function stopChild(child: ChildProcess): Promise<number> {
  const exited = new Promise<number>((resolvePromise) => {
    child.once("exit", (code) => resolvePromise(code ?? 0));
  });
  child.kill("SIGTERM");
  return Promise.race([
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
}

/**
 * Run the repository's public smoke against a plane URL (the --url
 * production path the credentialed deployment run executes).
 */
function runPublicSmoke(baseUrl: string): {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
} {
  const result = spawnSync(
    "bun",
    [
      join("deploy", "public-smoke.ts"),
      "--environment",
      "local",
      "--url",
      baseUrl,
      "--allow-degraded",
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: childEnv({ ZECK_ENVIRONMENT: "local" }),
      timeout: 120_000,
    },
  );
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function jsonOf(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf("{");
  expect(start, "the tool printed its JSON report").toBeGreaterThanOrEqual(0);
  return JSON.parse(stdout.slice(start)) as Record<string, unknown>;
}

const liveEntries: EntryHandle[] = [];

afterAll(async () => {
  for (const entry of liveEntries) {
    await entry.stop().catch(() => undefined);
  }
});

describe.skipIf(!HAS_GIT)("PPR-006: the Vercel hosting entry on the local rail", () => {
  test("the entry boots the shared composition and the public smoke attests it at the exact revision", {
    timeout: 180_000,
  }, async () => {
    const entry = await bootEntry({});
    liveEntries.push(entry);

    // THE SMOKE (the --url production path the credentialed run executes).
    const smoke = runPublicSmoke(entry.baseUrl);
    expect(smoke.stderr).not.toContain("error:");
    expect(smoke.code).toBe(0);
    const report = jsonOf(smoke.stdout);
    expect(report.mode).toBe("url");
    expect(report.problems).toEqual([]);
    const attestation = report.attestation as Record<string, unknown>;
    expect(attestation.transportReachable).toBe(true);
    expect(attestation.identityBound).toBe(true);
    expect(attestation.identityVerified).toBe(true);
    const coverage = report.routeCoverage as Record<string, unknown>;
    expect(coverage.probed).toBe(26);
    expect(coverage.authBoundaryEnforced).toBe(18);
    // The credentials seams are composition-dependent (PPR-008): this
    // unbound entry-plane answers the unbound composition's 422 (3
    // strictly-unbound sandbox seams + 4 credentials seams); the
    // materialized composition's 401 is the same honest class.
    expect(coverage.capabilityUnboundHonest).toBe(3);
    expect(coverage.capabilitySeamHonest).toBe(4);
    expect(coverage.capabilitySeamUnboundComposition).toBe(4);
    expect(coverage.capabilitySeamMaterializedComposition).toBe(0);
    expect(coverage.publicArtifactBound).toBe(1);

    // The cold-start boot record (operational visibility of the singleton build).
    const stdout = entry.readStdout();
    const bootStart = stdout.indexOf("{");
    expect(bootStart).toBeGreaterThanOrEqual(0);
    const boot = JSON.parse(stdout.slice(bootStart)) as Record<string, unknown>;
    expect(boot.tool).toBe("deploy/vercel");
    expect(boot.status).toBe("booted");
    expect(boot.environment).toBe("local");
    expect(boot.routes).toBe(28);
    const identity = boot.deploymentIdentity as Record<string, unknown>;
    expect(identity.gitRevision).toBe(report.expectedRevision);

    // SHUTDOWN: SIGTERM drains gracefully (the deployable-service proof).
    const exitCode = await entry.stop();
    expect(exitCode).toBe(0);
  });

  test("a wrong-revision entry is REFUSED by the same smoke (the exact-revision negative)", {
    timeout: 180_000,
  }, async () => {
    const wrongRevision = "f".repeat(40);
    const entry = await bootEntry({ revisionOverride: wrongRevision });
    liveEntries.push(entry);

    // The smoke expects the CHECKOUT's revision; the plane attests the
    // wrong override — the deployed-plane identity attest REFUSES.
    const smoke = runPublicSmoke(entry.baseUrl);
    expect(smoke.code).toBe(1);
    const report = jsonOf(smoke.stdout);
    const attestation = report.attestation as Record<string, unknown>;
    expect(attestation.identityVerified).toBe(false);
    expect(report.problems).not.toEqual([]);
    const exitCode = await entry.stop();
    expect(exitCode).toBe(0);
  });
});
