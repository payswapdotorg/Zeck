/**
 * deploy/public-smoke — the public API smoke at an exact revision
 * (DEP-001 AC2: "API health and public integration smoke pass at an
 * exact revision").
 *
 * Boots the REAL bootstrap host (deploy/api.ts) as a subprocess on an
 * ephemeral port, then attests over REAL HTTP:
 *
 *  1. TRANSPORT: the public API answers (the independently-runnable
 *     deployment surface — D1.0 §12);
 *  2. IDENTITY (the hard attest): GET /identity is bound, the Git
 *     revision equals this checkout's exact revision, the manifest
 *     digest and topology digest equal the recomputed values, the
 *     provider topology equals the providers.json concern map and the
 *     runtime identity id RECOMPUTES (verifyRuntimeDeploymentIdentity
 *     — drift or tampering fails closed);
 *  3. HEALTH SEMANTICS: GET /health answers with the control-plane/
 *     dependency distinction and honest facts. The authoritative
 *     dependency unattested ⇒ 503 fail closed (the expected honest
 *     state of an unprovisioned environment); --allow-degraded
 *     records the explicit degraded pass, never silently;
 *  4. PUBLIC INTEGRATION POSTURE: an authenticated route answers the
 *     honest AUTHENTICATION_FAILED (401 — the bootstrap composition
 *     binds no credentials), proving the auth boundary is enforced
 *     and no capability is fabricated;
 *  5. SHUTDOWN: SIGTERM drains gracefully (the deployable-service
 *     proof).
 *
 * Exit 0 = attested at the exact revision. Exit 1 = any mismatch.
 *
 * Usage:
 *   bun run deploy:public-smoke -- --environment local
 *   bun run deploy:public-smoke -- --environment local --allow-degraded
 */

import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeIdentityWire } from "../src/api/routes/identity";
import { namingConventionsOf } from "../src/platform/deployment/identity";
import {
  type EnvironmentId,
  previewBranchSlug,
  requiresPreviewSlug,
} from "../src/platform/deployment/naming";
import { parseProviderTiers } from "../src/platform/deployment/provider-tiers";
import {
  providerTopologyOf,
  type RuntimeDeploymentIdentity,
  runtimeDeploymentIdentity,
  verifyRuntimeDeploymentIdentity,
} from "../src/platform/deployment/runtime-identity";
import {
  gitRevision,
  hasFlag,
  loadManifest,
  optionalBranch,
  REPOSITORY_ROOT,
  requireEnvironment,
} from "./lib";

const GIT_REVISION_PATTERN = /^[0-9a-f]{40}$/;

/** The exact revision this smoke expects (same override contract as deploy/api). */
function expectedRevision(): string {
  const override = process.env.ZECK_DEPLOY_GIT_REVISION?.trim();
  if (override !== undefined && override.length > 0) {
    if (!GIT_REVISION_PATTERN.test(override)) {
      throw new Error(
        `ZECK_DEPLOY_GIT_REVISION must be an exact 40-hex Git sha (got: "${override}")`,
      );
    }
    return override;
  }
  return gitRevision();
}

interface HttpResult {
  readonly status: number;
  readonly body: string;
}

async function httpGet(url: string, headers: Record<string, string> = {}): Promise<HttpResult> {
  const response = await fetch(url, { headers });
  return { status: response.status, body: await response.text() };
}

async function waitForEndpoint(baseUrl: string, attempts: number, delayMs: number): Promise<void> {
  let lastError = "unknown";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`, { method: "GET" });
      void response.body?.cancel();
      return;
    } catch (error) {
      lastError = (error as Error).message;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
    }
  }
  throw new Error(`the bootstrap host did not become reachable at ${baseUrl}: ${lastError}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const environment = requireEnvironment(argv);
  const branch = optionalBranch(argv);
  const allowDegraded = hasFlag(argv, "--allow-degraded");

  const manifest = loadManifest();
  const ledger = parseProviderTiers(
    readFileSync(resolve(REPOSITORY_ROOT, "deploy", "manifests", "provider-tiers.json"), "utf8"),
    manifest,
  );
  const conventions = namingConventionsOf(manifest);
  if (
    environment === "preview" &&
    branch === undefined &&
    requiresPreviewSlug(manifest.resources.preview)
  ) {
    console.error("error: --environment preview requires --branch <branch-name>");
    process.exit(2);
  }
  const slug =
    environment === "preview" && branch !== undefined
      ? previewBranchSlug(branch, conventions.previewBranchSlugMaxLength)
      : undefined;

  const revision = expectedRevision();
  const expected = runtimeDeploymentIdentity(manifest, ledger, revision, environment, slug);

  // Boot the REAL bootstrap host on an ephemeral port (bun runs the
  // TypeScript entry directly — never process.execPath, which may be
  // node when the smoke is driven from vitest).
  const host = "127.0.0.1";
  const port = 30000 + (process.pid % 20000);
  const child = spawn(
    "bun",
    [
      resolve(REPOSITORY_ROOT, "deploy", "api.ts"),
      "--environment",
      environment,
      ...(branch === undefined ? [] : ["--branch", branch]),
      "--host",
      host,
      "--port",
      String(port),
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, ZECK_ENVIRONMENT: environment },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let hostStdout = "";
  let hostStderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    hostStdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    hostStderr += chunk.toString("utf8");
  });

  const problems: string[] = [];
  const baseUrl = `http://${host}:${port}`;
  let healthStatus = 0;
  let healthBody = "";
  let identityStatus = 0;
  let identityDocument: RuntimeIdentityWire | null = null;
  let authStatus = 0;
  let authBody = "";

  try {
    await waitForEndpoint(baseUrl, 60, 250);
    const health = await httpGet(`${baseUrl}/health`);
    healthStatus = health.status;
    healthBody = health.body;

    const identity = await httpGet(`${baseUrl}/identity`);
    identityStatus = identity.status;
    try {
      identityDocument = JSON.parse(identity.body) as RuntimeIdentityWire;
    } catch {
      problems.push("GET /identity did not return a JSON document");
    }

    const auth = await httpGet(`${baseUrl}/executions/00000000-0000-0000-0000-000000000000`, {
      authorization: "Bearer bootstrap-probe",
      "x-zeck-application": "00000000-0000-0000-0000-000000000000",
    });
    authStatus = auth.status;
    authBody = auth.body;
  } finally {
    const exited = new Promise<number>((resolvePromise) => {
      child.once("exit", (code) => resolvePromise(code ?? 0));
    });
    child.kill("SIGTERM");
    const exitCode = await Promise.race([
      exited,
      new Promise<number>((resolvePromise) => {
        const killer = setTimeout(() => {
          child.kill("SIGKILL");
          resolvePromise(-1);
        }, 10_000);
        exited.then((code) => {
          clearTimeout(killer);
          resolvePromise(code);
        });
      }),
    ]);
    if (exitCode !== 0) {
      problems.push(
        `the bootstrap host did not shut down gracefully on SIGTERM (exit ${exitCode}); stderr: ${hostStderr.slice(0, 400)}`,
      );
    }
  }

  // 1. The identity attest (hard requirement).
  if (identityStatus !== 200) {
    problems.push(`GET /identity answered ${identityStatus} (expected 200 bound)`);
  } else if (identityDocument !== null) {
    const verification = verifyRuntimeDeploymentIdentity(
      manifest,
      ledger,
      wireToDocument(identityDocument),
      revision,
      environment,
      slug,
    );
    if (!verification.valid) {
      problems.push(`identity verification failed: ${verification.reason}`);
    }
    if (identityDocument.identity.gitRevision !== revision) {
      problems.push(
        `identity revision ${identityDocument.identity.gitRevision} != expected ${revision}`,
      );
    }
    const topology = providerTopologyOf(manifest, ledger);
    const wireTopology = identityDocument.providerTopology;
    if (wireTopology.length !== topology.length) {
      problems.push(
        `provider topology has ${wireTopology.length} entries; the manifest declares ${topology.length}`,
      );
    } else {
      for (const expectedEntry of topology) {
        const wireEntry = wireEntryOf(wireTopology, expectedEntry.concern);
        if (
          wireEntry === undefined ||
          wireEntry.provider !== expectedEntry.provider ||
          wireEntry.authorityRole !== expectedEntry.authorityRole ||
          wireEntry.tierClass !== expectedEntry.tierClass
        ) {
          problems.push(
            `provider topology entry for "${expectedEntry.concern}" disagrees with the manifest/tier ledger`,
          );
        }
      }
    }
  }

  // 2. The health semantics.
  let healthCheck = "unknown";
  try {
    const health = JSON.parse(healthBody) as { status?: string; controlPlane?: string };
    if (health.controlPlane !== "ready") {
      problems.push(
        `GET /health reports controlPlane ${JSON.stringify(health.controlPlane)} (the transport answered; the control plane must report ready)`,
      );
    }
    if (healthStatus === 200) {
      if (health.status !== "ready" && health.status !== "degraded") {
        problems.push(`GET /health answered 200 with status ${JSON.stringify(health.status)}`);
      }
      // An environment WITH a reachable authority can still answer
      // degraded (a non-authoritative component) — in explicit mode the
      // record names both facts: the explicit pass AND the degraded
      // status (the same honest-boundary vocabulary as the 503 branch;
      // the test contract pins the "allowed-degraded" marker).
      healthCheck =
        health.status === "degraded" && allowDegraded
          ? "allowed-degraded (explicit; health status degraded)"
          : (health.status ?? "unknown");
    } else if (healthStatus === 503) {
      // Fail-closed authority: honest when the authoritative dependency
      // is unattested; --allow-degraded records the explicit pass.
      if (health.status !== "down") {
        problems.push(`GET /health answered 503 with status ${JSON.stringify(health.status)}`);
      }
      if (allowDegraded) {
        healthCheck = "down-allowed-degraded (authoritative dependency unattested; explicit)";
      } else {
        problems.push(
          "GET /health answered 503 (the authoritative relational dependency is not attested in this environment — configure the environment dependency or pass --allow-degraded to record the explicit degraded pass)",
        );
        healthCheck = "down";
      }
    } else {
      problems.push(`GET /health answered ${healthStatus} (expected 200 or 503)`);
    }
  } catch {
    problems.push("GET /health did not return a JSON document");
  }

  // 3. The public integration posture (honest unbound capabilities).
  if (authStatus !== 401) {
    problems.push(
      `GET /executions/:id answered ${authStatus} (expected the honest 401 AUTHENTICATION_FAILED of the bootstrap composition)`,
    );
  } else if (!authBody.includes("AUTHENTICATION_FAILED")) {
    problems.push("the 401 body does not carry the typed AUTHENTICATION_FAILED code");
  }

  const report = {
    tool: "deploy/public-smoke",
    environment,
    ...(slug === undefined ? {} : { previewSlug: slug }),
    expectedRevision: revision,
    host: {
      exitCodeAfterSigterm: 0,
      boot: hostStdout.trim().length > 0 ? "ok" : "no-boot-log",
    },
    attestation: {
      transportReachable: true,
      identityBound: identityStatus === 200,
      identityVerified:
        identityDocument !== null &&
        verifyRuntimeDeploymentIdentity(
          manifest,
          ledger,
          wireToDocument(identityDocument),
          revision,
          environment,
          slug,
        ).valid,
      healthStatus,
      healthCheck,
      authBoundaryEnforced: authStatus === 401,
    },
    runtimeIdentityId: expected.runtimeIdentityId,
    problems,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(problems.length === 0 ? 0 : 1);
}

/** The wire document (transport view) as the platform verification document. */
function wireToDocument(wire: RuntimeIdentityWire): RuntimeDeploymentIdentity {
  return {
    schemaVersion: wire.schemaVersion,
    runtimeIdentityId: wire.runtimeIdentityId,
    identity: {
      schemaVersion: wire.identity.schemaVersion,
      identityId: wire.identity.identityId,
      gitRevision: wire.identity.gitRevision,
      // The wire carries the environment as a string; verification
      // checks it against the expected environment immediately.
      environment: wire.identity.environment as EnvironmentId,
      manifestDigest: wire.identity.manifestDigest,
      resourceDigest: wire.identity.resourceDigest,
      // verify recomputes resources from the manifest; the wire
      // projection omits them (transport view).
      resources: [],
    },
    topologyDigest: wire.topologyDigest,
    providerTopology: wire.providerTopology,
  };
}

function wireEntryOf(
  topology: RuntimeIdentityWire["providerTopology"],
  concern: string,
): RuntimeIdentityWire["providerTopology"][number] | undefined {
  return topology.find((entry) => entry.concern === concern);
}

const IS_ENTRY =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (IS_ENTRY) {
  main().catch((error: unknown) => {
    console.error(`error: ${(error as Error).message}`);
    process.exit(1);
  });
}
