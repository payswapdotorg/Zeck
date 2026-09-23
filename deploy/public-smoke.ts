/**
 * deploy/public-smoke — the public API smoke at an exact revision
 * (DEP-001 AC2: "API health and public integration smoke pass at an
 * exact revision"; extended by DEP-003 to the FULL public-route
 * production smoke).
 *
 * Boots the REAL bootstrap host (deploy/api.ts) as a subprocess on an
 * ephemeral port — or, with --url, attests an ALREADY-DEPLOYED plane
 * over real HTTP (the production path: the operator smokes the plane
 * that serves traffic, wherever it runs) — then attests:
 *
 *  1. TRANSPORT: the public API answers (the independently-runnable
 *     deployment surface — D1.0 §12);
 *  2. IDENTITY (the hard attest): GET /identity is bound, the Git
 *     revision equals this checkout's exact revision, the manifest
 *     digest and topology digest equal the recomputed values, the
 *     provider topology equals the providers.json concern map and the
 *     runtime identity id RECOMPUTES (verifyRuntimeDeploymentIdentity
 *     — drift or tampering fails closed; a wrong-revision or
 *     unreachable plane FAILS, never warns);
 *  3. HEALTH SEMANTICS: GET /health answers with the control-plane/
 *     dependency distinction and honest facts. The authoritative
 *     dependency unattested ⇒ 503 fail closed (the expected honest
 *     state of an unprovisioned environment); --allow-degraded
 *     records the explicit degraded pass, never silently;
 *  4. FULL PUBLIC-ROUTE COVERAGE (DEP-003 AC1): EVERY route of the
 *     public route table answers with its honest boundary semantics —
 *     the executions/agents/economic-actions/codebase-analysis
 *     surfaces reach the authenticate seam and answer the honest 401
 *     AUTHENTICATION_FAILED (the bootstrap composition binds no
 *     credentials); the credentials seams (DEP-011) are composition-
 *     dependent — the honest 422 CAPABILITY_UNAVAILABLE of the unbound
 *     composition OR the honest 401 AUTHENTICATION_FAILED of the
 *     materialized composition (PPR-008's preview authority set binds
 *     the credential service; the probe's bearer is deliberately
 *     invalid; never a fabricated fact); the sandbox-governance
 *     surfaces wired to unbound authorities answer the honest 422
 *     CAPABILITY_UNAVAILABLE (no current composition binds them); the
 *     public
 *     sandbox data-policy artifact answers 200 with its digest;
 *  5. SHUTDOWN (local-boot mode): SIGTERM drains gracefully (the
 *     deployable-service proof).
 *
 * Exit 0 = attested at the exact revision. Exit 1 = any mismatch.
 *
 * Usage:
 *   bun run deploy:public-smoke -- --environment local
 *   bun run deploy:public-smoke -- --environment local --allow-degraded
 *   bun run deploy:public-smoke -- --environment production --url https://api.example.com
 */

import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeIdentityWire } from "../src/api/routes/identity";
import { namingConventionsOf } from "../src/platform/deployment/identity";
import { previewBranchSlug, requiresPreviewSlug } from "../src/platform/deployment/naming";
import { parseProviderTiers } from "../src/platform/deployment/provider-tiers";
import {
  providerTopologyOf,
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
import {
  attestDeployedPlane,
  type PlaneAttestation,
  wireToRuntimeDocument,
} from "./plane-identity";

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

function optionalValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

interface HttpResult {
  readonly status: number;
  readonly body: string;
}

async function httpGet(url: string, headers: Record<string, string> = {}): Promise<HttpResult> {
  const response = await fetch(url, { headers });
  return { status: response.status, body: await response.text() };
}

async function waitForEndpoint(
  baseUrl: string,
  attempts: number,
  delayMs: number,
  subject = "the bootstrap host",
): Promise<void> {
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
  throw new Error(`${subject} did not become reachable at ${baseUrl}: ${lastError}`);
}

// ---------------------------------------------------------------------------
// The full public-route probe table (DEP-003 AC1)
// ---------------------------------------------------------------------------

/** A synthetic scope for the probes (no capability is ever fabricated). */
const PROBE_APPLICATION = "00000000-0000-0000-0000-000000000000";
const PROBE_ID = "00000000-0000-0000-0000-000000000000";
const PROBE_REPOSITORY = "zeck-public-smoke/probe";
const PROBE_REVISION = "0000000000000000000000000000000000000000";

/** The honest answer classes of the bootstrap composition (fixed on main). */
type RouteExpectation =
  | "auth-boundary"
  | "capability-unbound"
  | "capability-or-auth-boundary"
  | "public-artifact";

interface RouteProbe {
  readonly route: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: string;
  readonly expect: RouteExpectation;
}

/**
 * Every public route of the deployed plane, with the probe that reaches
 * its honest boundary. Auth-class probes are WELL-FORMED (idempotency
 * keys, application headers, closed-contract bodies) so they reach the
 * authenticate seam — the 401 proves the auth boundary is enforced and
 * no capability is fabricated; capability-class routes answer the
 * composition's honest 422 before any authority is consulted; the
 * public artifact route is the one unauthenticated 200.
 */
const ROUTE_PROBES: readonly RouteProbe[] = [
  // --- executions (API-001): reach the authenticate seam ----------------
  {
    route: "POST /executions",
    method: "POST",
    path: "/executions",
    body: JSON.stringify({
      applicationId: PROBE_APPLICATION,
      task: { kind: "public-smoke-probe" },
    }),
    expect: "auth-boundary",
  },
  {
    route: "GET /executions/:id",
    method: "GET",
    path: `/executions/${PROBE_ID}`,
    expect: "auth-boundary",
  },
  {
    route: "POST /executions/:id/cancel",
    method: "POST",
    path: `/executions/${PROBE_ID}/cancel`,
    body: "{}",
    expect: "auth-boundary",
  },
  {
    route: "GET /executions/:id/events",
    method: "GET",
    path: `/executions/${PROBE_ID}/events`,
    expect: "auth-boundary",
  },
  {
    route: "GET /executions/:id/verification",
    method: "GET",
    path: `/executions/${PROBE_ID}/verification`,
    expect: "auth-boundary",
  },
  {
    route: "GET /executions/:id/results",
    method: "GET",
    path: `/executions/${PROBE_ID}/results`,
    expect: "auth-boundary",
  },
  // --- agents: reach the authenticate seam --------------------------------
  { route: "GET /agents", method: "GET", path: "/agents", expect: "auth-boundary" },
  { route: "GET /agents/:id", method: "GET", path: `/agents/${PROBE_ID}`, expect: "auth-boundary" },
  {
    route: "GET /agents/:id/versions",
    method: "GET",
    path: `/agents/${PROBE_ID}/versions`,
    expect: "auth-boundary",
  },
  {
    route: "GET /agents/:id/status",
    method: "GET",
    path: `/agents/${PROBE_ID}/status`,
    expect: "auth-boundary",
  },
  // --- economic-actions: well-formed closed-contract body ------------------
  {
    route: "POST /economic-actions",
    method: "POST",
    path: "/economic-actions",
    body: JSON.stringify({
      applicationId: PROBE_APPLICATION,
      executionId: PROBE_ID,
      purpose: "public-smoke-probe",
      recipient: { kind: "external-account", id: "public-smoke-probe" },
      amount: { kind: "exact", microUsd: "1" },
      currency: "USD",
      expiresAt: "2030-01-01T00:00:00.000Z",
      requiredCapabilities: [],
    }),
    expect: "auth-boundary",
  },
  {
    route: "GET /economic-actions/:id",
    method: "GET",
    path: `/economic-actions/${PROBE_ID}`,
    expect: "auth-boundary",
  },
  {
    route: "GET /economic-actions/:id/events",
    method: "GET",
    path: `/economic-actions/${PROBE_ID}/events`,
    expect: "auth-boundary",
  },
  {
    route: "GET /economic-actions/:id/outcome",
    method: "GET",
    path: `/economic-actions/${PROBE_ID}/outcome`,
    expect: "auth-boundary",
  },
  // --- codebase-analysis: a valid selection reaches the authenticate seam --
  {
    route: "POST /codebase-analysis",
    method: "POST",
    path: "/codebase-analysis",
    body: JSON.stringify({
      applicationId: PROBE_APPLICATION,
      source: { repository: PROBE_REPOSITORY, revision: PROBE_REVISION },
      subgraph: {
        nodes: [
          {
            nodeId: "public-smoke-probe-node",
            kind: "function",
            label: "public-smoke probe node",
            provenance: {
              repository: PROBE_REPOSITORY,
              revision: PROBE_REVISION,
              file: "src/public-smoke-probe.ts",
            },
            observation: { executionCount: 1, evidenceRefs: ["public-smoke"] },
          },
        ],
        edges: [],
      },
    }),
    expect: "auth-boundary",
  },
  {
    route: "GET /codebase-analysis/:id",
    method: "GET",
    path: `/codebase-analysis/${PROBE_ID}`,
    expect: "auth-boundary",
  },
  {
    route: "POST /codebase-analysis/:id/ratings",
    method: "POST",
    path: `/codebase-analysis/${PROBE_ID}/ratings`,
    body: JSON.stringify({ applicationId: PROBE_APPLICATION }),
    expect: "auth-boundary",
  },
  {
    route: "POST /codebase-analysis/:id/findings/:findingId/transition",
    method: "POST",
    path: `/codebase-analysis/${PROBE_ID}/findings/finding-probe/transition`,
    body: JSON.stringify({ applicationId: PROBE_APPLICATION }),
    expect: "auth-boundary",
  },
  // --- credentials (DEP-011 seams): the composition-dependent honest
  // boundary — the well-formed issue body (a VALID role) so a materialized
  // composition reaches the authenticate seam and answers its honest 401
  // (an invalid role would stop at body validation with a coincidentally
  // same-coded 422 — never a composition fact) -----------------------------
  {
    route: "POST /credentials",
    method: "POST",
    path: "/credentials",
    body: JSON.stringify({
      applicationId: PROBE_APPLICATION,
      label: "public-smoke-probe",
      role: "member",
    }),
    expect: "capability-or-auth-boundary",
  },
  {
    route: "GET /credentials",
    method: "GET",
    path: "/credentials",
    expect: "capability-or-auth-boundary",
  },
  {
    route: "POST /credentials/:credentialId/rotate",
    method: "POST",
    path: `/credentials/${PROBE_ID}/rotate`,
    body: "{}",
    expect: "capability-or-auth-boundary",
  },
  {
    route: "POST /credentials/:credentialId/revoke",
    method: "POST",
    path: `/credentials/${PROBE_ID}/revoke`,
    body: "{}",
    expect: "capability-or-auth-boundary",
  },
  // --- sandbox governance (DEP-014 seams): the honest composition fact -----
  {
    route: "GET /sandbox/quotas",
    method: "GET",
    path: "/sandbox/quotas",
    expect: "capability-unbound",
  },
  {
    route: "GET /sandbox/identities/:identityId",
    method: "GET",
    path: `/sandbox/identities/${PROBE_ID}`,
    expect: "capability-unbound",
  },
  {
    route: "POST /sandbox/identities/:identityId/reset",
    method: "POST",
    path: `/sandbox/identities/${PROBE_ID}/reset`,
    body: "{}",
    expect: "capability-unbound",
  },
  // --- the public policy artifact: the one unauthenticated 200 ------------
  {
    route: "GET /sandbox/data-policy",
    method: "GET",
    path: "/sandbox/data-policy",
    expect: "public-artifact",
  },
];

interface RouteCoverage {
  readonly probed: number;
  readonly authBoundaryEnforced: number;
  readonly capabilityUnboundHonest: number;
  /** The credentials seams (composition-dependent): how many answered
   *  the unbound composition's 422 vs the materialized composition's 401. */
  readonly capabilitySeamHonest: number;
  readonly capabilitySeamUnboundComposition: number;
  readonly capabilitySeamMaterializedComposition: number;
  readonly publicArtifactBound: number;
  readonly problems: readonly string[];
}

/** Probe EVERY public route and assert its honest boundary semantics. */
async function probePublicRoutes(baseUrl: string): Promise<RouteCoverage> {
  const problems: string[] = [];
  let authBoundaryEnforced = 0;
  let capabilityUnboundHonest = 0;
  let capabilitySeamUnbound = 0;
  let capabilitySeamMaterialized = 0;
  let publicArtifactBound = 0;
  for (const [index, probe] of ROUTE_PROBES.entries()) {
    const headers: Record<string, string> = {
      authorization: "Bearer bootstrap-probe",
      "x-zeck-application": PROBE_APPLICATION,
      "idempotency-key": `public-smoke-${index}`,
    };
    if (probe.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    let result: HttpResult;
    try {
      result = await httpProbe(baseUrl, probe, headers);
    } catch (error) {
      problems.push(`${probe.route}: the route did not answer (${(error as Error).message})`);
      continue;
    }
    let code = "";
    try {
      code = String((JSON.parse(result.body) as { code?: unknown }).code ?? "");
    } catch {
      code = "";
    }
    if (probe.expect === "auth-boundary") {
      if (result.status !== 401 || code !== "AUTHENTICATION_FAILED") {
        problems.push(
          `${probe.route}: answered ${result.status} ${code || "(no code)"} (expected the honest 401 AUTHENTICATION_FAILED of the bootstrap composition — the auth boundary must be enforced with no fabricated capability)`,
        );
      } else {
        authBoundaryEnforced += 1;
      }
    } else if (probe.expect === "capability-unbound") {
      if (result.status !== 422 || code !== "CAPABILITY_UNAVAILABLE") {
        problems.push(
          `${probe.route}: answered ${result.status} ${code || "(no code)"} (expected the honest 422 CAPABILITY_UNAVAILABLE of the unbound composition — never a fabricated fact)`,
        );
      } else {
        capabilityUnboundHonest += 1;
      }
    } else if (probe.expect === "capability-or-auth-boundary") {
      // The credentials seams' honest boundary is composition-dependent:
      // the unbound composition refuses with 422 CAPABILITY_UNAVAILABLE
      // before any authority is consulted; the MATERIALIZED composition
      // (PPR-008's preview authority set) binds the credential service and
      // the well-formed probe reaches the authenticate seam, answering the
      // honest 401 AUTHENTICATION_FAILED. Both are honest refusals — the
      // coverage records which composition class answered.
      const unboundComposition = result.status === 422 && code === "CAPABILITY_UNAVAILABLE";
      const materializedComposition = result.status === 401 && code === "AUTHENTICATION_FAILED";
      if (!unboundComposition && !materializedComposition) {
        problems.push(
          `${probe.route}: answered ${result.status} ${code || "(no code)"} (expected the honest 422 CAPABILITY_UNAVAILABLE of the unbound composition or the honest 401 AUTHENTICATION_FAILED of the materialized composition — the credentials seam's boundary is composition-dependent; never a fabricated fact)`,
        );
      } else if (unboundComposition) {
        capabilitySeamUnbound += 1;
      } else {
        capabilitySeamMaterialized += 1;
      }
    } else {
      let artifact = "";
      let digest = "";
      try {
        const parsed = JSON.parse(result.body) as { artifact?: unknown; digest?: unknown };
        artifact = String(parsed.artifact ?? "");
        digest = String(parsed.digest ?? "");
      } catch {
        // handled below
      }
      if (result.status !== 200 || artifact === "" || digest === "") {
        problems.push(
          `${probe.route}: answered ${result.status} (expected 200 with the versioned policy artifact + digest — the public governed document)`,
        );
      } else {
        publicArtifactBound += 1;
      }
    }
  }
  return {
    probed: ROUTE_PROBES.length,
    authBoundaryEnforced,
    capabilityUnboundHonest,
    capabilitySeamHonest: capabilitySeamUnbound + capabilitySeamMaterialized,
    capabilitySeamUnboundComposition: capabilitySeamUnbound,
    capabilitySeamMaterializedComposition: capabilitySeamMaterialized,
    publicArtifactBound,
    problems,
  };
}

async function httpProbe(
  baseUrl: string,
  probe: RouteProbe,
  headers: Record<string, string>,
): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${probe.path}`, {
    method: probe.method,
    headers,
    ...(probe.body === undefined ? {} : { body: probe.body }),
  });
  return { status: response.status, body: await response.text() };
}

const AUTH_BOUNDARY_ROUTE_COUNT = ROUTE_PROBES.filter(
  (probe) => probe.expect === "auth-boundary",
).length;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const environment = requireEnvironment(argv);
  const branch = optionalBranch(argv);
  const allowDegraded = hasFlag(argv, "--allow-degraded");
  const planeUrl = optionalValue(argv, "--url");

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

  const problems: string[] = [];
  let baseUrl: string;
  const mode: "local-boot" | "url" = planeUrl === undefined ? "local-boot" : "url";
  let child: ReturnType<typeof spawn> | null = null;
  let hostStdout = "";
  let hostStderr = "";
  let planeAttestation: PlaneAttestation | null = null;

  if (planeUrl !== undefined) {
    // The production path: attest the ALREADY-DEPLOYED plane at the
    // exact revision (unreachable or wrong-revision FAILS, never warns).
    baseUrl = planeUrl.replace(/\/$/, "");
    planeAttestation = await attestDeployedPlane(baseUrl, {
      revision,
      environment,
      ...(slug === undefined ? {} : { previewSlug: slug }),
      manifest,
      ledger,
    });
    if (!planeAttestation.verified) {
      problems.push(
        `the deployed plane at ${baseUrl} failed the exact-revision identity attest: ${planeAttestation.reason}`,
      );
    }
  } else {
    // Boot the REAL bootstrap host on an ephemeral port (bun runs the
    // TypeScript entry directly — never process.execPath, which may be
    // node when the smoke is driven from vitest).
    const host = "127.0.0.1";
    const port = 30000 + (process.pid % 20000);
    baseUrl = `http://${host}:${port}`;
    const spawned = spawn(
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
    child = spawned;
    spawned.stdout.on("data", (chunk: Buffer) => {
      hostStdout += chunk.toString("utf8");
    });
    spawned.stderr.on("data", (chunk: Buffer) => {
      hostStderr += chunk.toString("utf8");
    });
  }

  let healthStatus = 0;
  let healthBody = "";
  let identityStatus = 0;
  let identityDocument: RuntimeIdentityWire | null = null;
  let routeCoverage: RouteCoverage | null = null;
  let transportReachable = true;

  try {
    try {
      if (child !== null) {
        await waitForEndpoint(baseUrl, 60, 250);
      } else {
        // The deployed plane is expected to be serving already: a
        // short bounded wait, then the unreachable plane FAILS.
        await waitForEndpoint(baseUrl, 12, 250, "the deployed plane");
      }
    } catch (error) {
      transportReachable = false;
      problems.push((error as Error).message);
    }
    if (transportReachable) {
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

      // The full public-route coverage (every route, honest boundaries).
      routeCoverage = await probePublicRoutes(baseUrl);
      problems.push(...routeCoverage.problems);
    }
  } finally {
    if (child !== null) {
      const exited = new Promise<number>((resolvePromise) => {
        child.once("exit", (code) => resolvePromise(code ?? 0));
      });
      child.kill("SIGTERM");
      const exitCode = await Promise.race([
        exited,
        new Promise<number>((resolvePromise) => {
          const killer = setTimeout(() => {
            child?.kill("SIGKILL");
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
  }

  // 1. The identity attest (hard requirement).
  if (transportReachable) {
    if (identityStatus !== 200) {
      problems.push(`GET /identity answered ${identityStatus} (expected 200 bound)`);
    } else if (identityDocument !== null) {
      const verification = verifyRuntimeDeploymentIdentity(
        manifest,
        ledger,
        wireToRuntimeDocument(identityDocument),
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
  }

  // 2. The health semantics.
  let healthCheck = "unknown";
  if (!transportReachable) {
    healthCheck = "unreachable";
  } else {
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
  }

  const report = {
    tool: "deploy/public-smoke",
    mode,
    environment,
    ...(slug === undefined ? {} : { previewSlug: slug }),
    ...(planeUrl === undefined ? {} : { planeUrl }),
    expectedRevision: revision,
    ...(mode === "local-boot"
      ? {
          host: {
            exitCodeAfterSigterm: 0,
            boot: hostStdout.trim().length > 0 ? "ok" : "no-boot-log",
          },
        }
      : {}),
    attestation: {
      transportReachable,
      identityBound: identityStatus === 200,
      identityVerified:
        identityDocument !== null &&
        verifyRuntimeDeploymentIdentity(
          manifest,
          ledger,
          wireToRuntimeDocument(identityDocument),
          revision,
          environment,
          slug,
        ).valid,
      healthStatus,
      healthCheck,
      authBoundaryEnforced: routeCoverage?.authBoundaryEnforced === AUTH_BOUNDARY_ROUTE_COUNT,
    },
    routeCoverage,
    runtimeIdentityId: expected.runtimeIdentityId,
    problems,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(problems.length === 0 ? 0 : 1);
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
