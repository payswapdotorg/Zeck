/**
 * deploy/api — the independently-runnable public API bootstrap host
 * (DEP-001 AC1/AC2; D1.0 §12: "The API must remain deployable as an
 * independently runnable service").
 *
 * THE DEPLOYMENT-PLANE COMPOSITION (the honest bootstrap boundary):
 *  - REAL transport: the repository's createApiServer — the identical
 *    public route table served anywhere Zeck deploys;
 *  - REAL deployment seams: the runtime deployment identity (exact Git
 *    revision + manifest digest + provider topology — GET /identity)
 *    and the dependency readiness probe (GET /health) over the real
 *    environment contract;
 *  - UNBOUND domain capabilities: the console application composition
 *    (DEP-010: shell/auth/lifecycle, DEP-011: credentials UX, ...) owns
 *    binding the domain authorities. Until then every domain seam
 *    answers with the platform's honest CAPABILITY_UNAVAILABLE /
 *    AUTHENTICATION_FAILED — never a fabricated success, never a stub
 *    that lies. The route table stays identical across compositions.
 *
 * This host is the provider-neutral hosting exit proof: it runs on any
 * host with `bun` (Vercel's Bun runtime, a container, a VM) behind
 * configuration only. Repointing delivery at another host running the
 * same entry never changes the identity document or the domain
 * authority mapping (DEP-001 AC6).
 *
 * Usage:
 *   bun run deploy:api -- --environment local [--host 127.0.0.1] [--port 8787]
 *   bun run deploy:api -- --environment preview --branch work/DEP-001-x
 *
 * Environment variables (variables.json is the contract):
 *   ZECK_ENVIRONMENT, ZECK_DEPLOY_GIT_REVISION (optional override),
 *   ZECK_API_HOST, ZECK_API_PORT, and the environment's dependency
 *   variables (ZECK_PG_ADMIN_URL / ZECK_DATABASE_URL + reference
 *   bindings) for the /health readiness facts.
 */

import { readFileSync, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import type { Authenticate } from "../src/api";
import { createApiServer } from "../src/api";
import { evaluateEnvironmentContract } from "../src/platform/deployment/env-contract";
import { namingConventionsOf } from "../src/platform/deployment/identity";
import type { EnvironmentId } from "../src/platform/deployment/naming";
import { previewBranchSlug, requiresPreviewSlug } from "../src/platform/deployment/naming";
import { parseProviderTiers } from "../src/platform/deployment/provider-tiers";
import {
  type DependencyProbeResult,
  evaluateReadiness,
  expectedProbeConcerns,
} from "../src/platform/deployment/readiness";
import { runtimeDeploymentIdentity } from "../src/platform/deployment/runtime-identity";
import { PlatformError } from "../src/shared/errors";
import {
  gitRevision,
  loadManifest,
  optionalBranch,
  REPOSITORY_ROOT,
  requireEnvironment,
} from "./lib";

const DEFAULT_DATA_ROOT = join(
  process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? "/tmp", ".local", "share"),
  "zeck",
);

const GIT_REVISION_PATTERN = /^[0-9a-f]{40}$/;

/** The exact revision this host attests (manifest contract: ZECK_DEPLOY_GIT_REVISION overrides HEAD). */
function exactRevision(): string {
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

/** TCP reachability probe (host:port) with a hard timeout. */
function reachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host, port });
    const finish = (ok: boolean): void => {
      socket.destroy();
      resolvePromise(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function pgEndpoint(url: string): { host: string; port: number } {
  try {
    const parsed = new URL(url);
    return { host: parsed.hostname, port: Number(parsed.port || 5432) };
  } catch {
    return { host: "127.0.0.1", port: 5432 };
  }
}

/**
 * The honest dependency probe set of the bootstrap host. The
 * authoritative relational dependency is probed for real when its
 * connection configuration is present; absent configuration reports
 * the honest unattested state (never fabricated ready). Non-binding
 * concerns report the environment's materialization facts.
 */
async function bootstrapDependencyProbes(
  manifest: ReturnType<typeof loadManifest>,
  environment: EnvironmentId,
): Promise<readonly DependencyProbeResult[]> {
  const probes: DependencyProbeResult[] = [];
  for (const concern of expectedProbeConcerns(manifest, environment)) {
    if (concern === "relational-state") {
      const url =
        environment === "local" ? process.env.ZECK_PG_ADMIN_URL : process.env.ZECK_DATABASE_URL;
      if (url === undefined || url.length === 0) {
        probes.push({
          concern,
          status: "unavailable",
          detail:
            environment === "local"
              ? "ZECK_PG_ADMIN_URL is not set; the PostgreSQL authority cannot be probed (fail closed)"
              : "ZECK_DATABASE_URL is not materialized; the PostgreSQL authority cannot be probed (fail closed)",
        });
        continue;
      }
      const { host, port } = pgEndpoint(url);
      const tcpOk = await reachable(host, port, 3000);
      if (!tcpOk) {
        probes.push({
          concern,
          status: "unavailable",
          detail: `postgres endpoint ${host}:${port} unreachable (fail closed)`,
        });
        continue;
      }
      // Endpoint reachable: attest availability with a real round trip.
      try {
        const client = new Client({ connectionString: url, connectionTimeoutMillis: 4000 });
        await client.connect();
        try {
          await client.query("SELECT 1");
        } finally {
          await client.end();
        }
        probes.push({
          concern,
          status: "ready",
          detail: `postgres endpoint ${host}:${port} reachable (connect + select 1; schema convergence is deploy:smoke's attest)`,
        });
      } catch (error) {
        probes.push({
          concern,
          status: "unavailable",
          detail: `postgres endpoint reachable by TCP but the session probe failed: ${(error as Error).message.slice(0, 120)}`,
        });
      }
      continue;
    }
    if (concern === "artifact-bytes" && environment === "local") {
      const dataRoot = process.env.ZECK_LOCAL_DATA_ROOT ?? DEFAULT_DATA_ROOT;
      probes.push({
        concern,
        status: "degraded",
        detail: `bootstrap host: the local artifact root ${join(dataRoot, "…")} is not probed here (deploy:smoke owns the full probe set); the non-authoritative dependency degrades explicitly`,
      });
      continue;
    }
    // Non-authoritative concerns: the honest materialization facts.
    probes.push({
      concern,
      status: "degraded",
      detail:
        "bootstrap host: non-authoritative dependency not probed here (deploy:smoke owns the provider probe set); the declared degraded mode applies",
    });
  }
  return probes;
}

/**
 * The unbound-capability adapter: every method access answers the
 * platform's honest CAPABILITY_UNAVAILABLE naming the bootstrap
 * boundary. The domain authorities bind at this same seam with the
 * console application composition (DEP-010+); until then the public
 * surface refuses rather than fabricating.
 */
function unboundCapability<T>(name: string): T {
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new PlatformError({
          code: "CAPABILITY_UNAVAILABLE",
          message: `the ${name}.${String(property)} capability is not bound in the bootstrap deployment composition (the console application work orders own the domain binding; see deploy/PUBLIC-DEPLOYMENT.md)`,
        });
      },
    },
  ) as T;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const environment = requireEnvironment(argv);
  const branch = optionalBranch(argv);
  const manifest = loadManifest();
  const ledger = parseProviderTiers(
    readFileSync(resolve(REPOSITORY_ROOT, "deploy", "manifests", "provider-tiers.json"), "utf8"),
    manifest,
  );

  const environmentRecord = manifest.environments.find((entry) => entry.id === environment);
  if (environmentRecord === undefined) {
    throw new Error(`unknown environment: ${environment}`);
  }
  const conventions = namingConventionsOf(manifest);
  const previewResources = manifest.resources[environment];
  const slug =
    environment === "preview" && branch !== undefined
      ? previewBranchSlug(branch, conventions.previewBranchSlugMaxLength)
      : undefined;
  if (environment === "preview" && branch === undefined && requiresPreviewSlug(previewResources)) {
    console.error("error: --environment preview requires --branch <branch-name>");
    process.exit(2);
  }

  const revision = exactRevision();
  const identity = runtimeDeploymentIdentity(manifest, ledger, revision, environment, slug);

  const host = optionalValue(argv, "--host") ?? process.env.ZECK_API_HOST ?? "127.0.0.1";
  const portArg = optionalValue(argv, "--port") ?? process.env.ZECK_API_PORT;
  const port = portArg !== undefined ? Number(portArg) : 8787;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid API port: ${portArg ?? port}`);
  }

  // The bootstrap composition: real transport + real deployment seams,
  // unbound (honestly refusing) domain capabilities.
  const authenticate: Authenticate = async () => {
    throw new PlatformError({
      code: "AUTHENTICATION_FAILED",
      message:
        "no transport credential is bound in the bootstrap deployment composition (the identity/console work orders own the credential binding; see deploy/PUBLIC-DEPLOYMENT.md)",
    });
  };

  const server = createApiServer({
    executions: unboundCapability("executions"),
    agents: unboundCapability("agents"),
    economics: unboundCapability("economics"),
    scopeResolver: unboundCapability("scopeResolver"),
    authenticate,
    listAgentIdsOfApplication: async () => {
      throw new PlatformError({
        code: "CAPABILITY_UNAVAILABLE",
        message:
          "the agents inventory capability is not bound in the bootstrap deployment composition",
      });
    },
    codebaseAnalyzer: unboundCapability("codebaseAnalyzer"),
    dependencyReadiness: async () => {
      const probes = await bootstrapDependencyProbes(manifest, environment);
      const report = evaluateReadiness(manifest, {
        controlPlaneAvailable: true,
        probes,
      });
      return report.dependencies.map((dependency) => ({
        name: dependency.concern,
        authority: dependency.authority,
        status: dependency.status,
        ...(dependency.degradedMode === null ? {} : { degradedMode: dependency.degradedMode }),
        ...(dependency.detail === null ? {} : { detail: dependency.detail }),
      }));
    },
    deploymentIdentity: async () => ({
      schemaVersion: identity.schemaVersion,
      runtimeIdentityId: identity.runtimeIdentityId,
      identity: {
        schemaVersion: identity.identity.schemaVersion,
        identityId: identity.identity.identityId,
        gitRevision: identity.identity.gitRevision,
        environment: identity.identity.environment,
        manifestDigest: identity.identity.manifestDigest,
        resourceDigest: identity.identity.resourceDigest,
      },
      topologyDigest: identity.topologyDigest,
      providerTopology: identity.providerTopology,
    }),
  });

  await server.app.listen({ host, port });

  const contract = evaluateEnvironmentContract(manifest, environment, process.env);
  const boot = {
    tool: "deploy/api",
    status: "listening",
    environment,
    environmentClass: environmentRecord.environmentClass,
    host,
    port,
    deploymentIdentity: {
      runtimeIdentityId: identity.runtimeIdentityId,
      identityId: identity.identity.identityId,
      gitRevision: identity.identity.gitRevision,
      manifestDigest: identity.identity.manifestDigest,
      topologyDigest: identity.topologyDigest,
    },
    composition: {
      transport: "real (createApiServer — the repository public route table)",
      deploymentSeams: "real (runtime identity + dependency readiness)",
      domainCapabilities: "unbound (honest CAPABILITY_UNAVAILABLE / AUTHENTICATION_FAILED)",
    },
    environmentContract: { satisfied: contract.satisfied, problems: contract.problems },
    routes: server.routes.length,
  };
  console.log(JSON.stringify(boot, null, 2));

  const shutdown = async (signal: string): Promise<void> => {
    console.log(JSON.stringify({ tool: "deploy/api", status: "shutting-down", signal }));
    await server.app.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
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
