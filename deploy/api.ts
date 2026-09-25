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
 * host with `bun` (a container, a VM) behind configuration only.
 * Repointing delivery at another host running the same entry never
 * changes the identity document or the domain authority mapping
 * (DEP-001 AC6).
 *
 * PPR-006 — THE SHARED COMPOSITION EXPORT: the bootstrap composition
 * above is exported as `buildBootstrapApp(options)` so every hosting
 * shape composes the IDENTICAL plane: the CLI host (`main()` below —
 * unchanged in behavior: same boot document, same SIGTERM/SIGINT drain,
 * same exit codes) and the Vercel hosting adapter (deploy/vercel.ts +
 * the root server.ts entry — the request-handler entry that builds the
 * same composition once per isolate). The adapter IMPORTS this builder;
 * it never re-implements it — route-table and identity parity with the
 * CLI host is by construction and pinned by
 * tests/unit/deployment/vercel-adapter.test.ts.
 *
 * PPR-008 — THE AUTHORITY MATERIALIZATION BINDING: when the environment
 * materializes the preview authority set (ZECK_DATABASE_URL on
 * preview/staging/production — ZECK_PG_ADMIN_URL on local, exactly the
 * value /health's relational-state probe consumes — plus ZECK_TRANSPORT_TOKEN
 * and ZECK_PREVIEW_APPLICATION_ID; see deploy/preview-authorities.ts), the
 * composition binds the REAL domain seams over the relational DatabasePort
 * (bearer authentication, SQL scope resolution, the credential lifecycle
 * service, the execution service with the deterministic sandbox substrate,
 * the agents inventory). ANY missing piece leaves EXACTLY today's unbound
 * shape below (local/dev behavior unchanged; both shapes are pinned by
 * tests). The boot document reports the truthful authorityMaterialization
 * composition fact (derived, never hardcoded).
 *
 * PPR-014 — THE GAP-006 SEAM BINDINGS (the SAME materialization gate, zero
 * new environment variables): when the authority set materializes, the
 * composition additionally binds the two remaining domain seams over the
 * SAME relational DatabasePort — the ECONOMICS authority (the real
 * economic-action service: SQL store + idempotency, the REAL policy and
 * capability admission adapters, the REAL budgets authority with the
 * seeded funded developer wallet, the executions ledger seam, and the
 * in-repo simulated payment rail — honestly disclosed, never an external
 * payment provider, no model behind the bounded authorization) and the
 * CODEBASE-ANALYSIS authority (the deterministic advisory opportunity
 * analyzer over the SQL opportunity store — no model behind it; the route
 * composes it with the already-bound executions authority, whose admission
 * the mandatory executionId flows through). Their routes serve the real
 * wire shapes instead of the honest 422s; unauthenticated probes still
 * answer the honest 401 (the boundary never moves — only the AUTHORIZED
 * shape changes). Unmaterialized, BOTH seams keep EXACTLY today's
 * `unboundCapability` shapes (both pinned by tests). The boot document's
 * composition facts are derived truthfully (see below).
 *
 * Usage:
 *   bun run deploy:api -- --environment local [--host 127.0.0.1] [--port 8787]
 *   bun run deploy:api -- --environment preview --branch work/DEP-001-x
 *
 * Environment variables (variables.json is the contract):
 *   ZECK_ENVIRONMENT, ZECK_DEPLOY_GIT_REVISION (optional override),
 *   ZECK_API_HOST, ZECK_API_PORT, and the environment's dependency
 *   variables (ZECK_PG_ADMIN_URL / ZECK_DATABASE_URL + reference
 *   bindings) for the /health readiness facts, plus the preview
 *   authority materialization set (ZECK_TRANSPORT_TOKEN +
 *   ZECK_PREVIEW_APPLICATION_ID) documented in deploy/PUBLIC-DEPLOYMENT.md.
 */

import { readFileSync, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import type { ApiServer, Authenticate } from "../src/api";
import { createApiServer } from "../src/api";
import type { EnvironmentContractEvaluation } from "../src/platform/deployment/env-contract";
import { evaluateEnvironmentContract } from "../src/platform/deployment/env-contract";
import { namingConventionsOf } from "../src/platform/deployment/identity";
import type { DeploymentManifest } from "../src/platform/deployment/manifest";
import type { EnvironmentId } from "../src/platform/deployment/naming";
import { previewBranchSlug, requiresPreviewSlug } from "../src/platform/deployment/naming";
import type { ProviderTiersLedger } from "../src/platform/deployment/provider-tiers";
import { parseProviderTiers } from "../src/platform/deployment/provider-tiers";
import {
  type DependencyProbeResult,
  evaluateReadiness,
  expectedProbeConcerns,
} from "../src/platform/deployment/readiness";
import type { RuntimeDeploymentIdentity } from "../src/platform/deployment/runtime-identity";
import { runtimeDeploymentIdentity } from "../src/platform/deployment/runtime-identity";
import { PlatformError } from "../src/shared/errors";
import {
  gitRevision,
  loadManifest,
  optionalBranch,
  REPOSITORY_ROOT,
  requireEnvironment,
} from "./lib";
import {
  buildPreviewAuthorities,
  createAnalysisAwareExecutions,
  type PreviewAuthorities,
  type PreviewAuthorityMaterialization,
  readPreviewAuthorityMaterialization,
  relationalUrlVariableOf,
} from "./preview-authorities";
import { createDeterministicSubstrateExecutions } from "./preview-substrate";

const DEFAULT_DATA_ROOT = join(
  process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? "/tmp", ".local", "share"),
  "zeck",
);

const GIT_REVISION_PATTERN = /^[0-9a-f]{40}$/;

/** The exact revision this host attests (manifest contract: ZECK_DEPLOY_GIT_REVISION overrides HEAD). */
export function exactRevision(): string {
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

// ---------------------------------------------------------------------------
// The shared bootstrap composition export (PPR-006)
// ---------------------------------------------------------------------------

/** The inputs of the bootstrap composition (environment + preview branch). */
export interface BootstrapAppOptions {
  readonly environment: EnvironmentId;
  /** The preview branch (the per-branch slug input; required for preview when the resource set is per-branch). */
  readonly branch?: string;
}

/** The composition facts the boot document reports (hosting-independent). */
export interface BootstrapCompositionFacts {
  readonly transport: string;
  readonly deploymentSeams: string;
  readonly domainCapabilities: string;
  /**
   * PPR-008: the truthful authority-materialization composition fact —
   * which authority set served (the honest unbound bootstrap vs the
   * materialized preview authorities), DERIVED from the environment never
   * hardcoded. Absent materialization variables are reported by NAME only.
   */
  readonly authorityMaterialization: string;
}

/**
 * The built bootstrap composition: the REAL transport (createApiServer
 * over the repository's public route table with the honest unbound
 * domain seams), the REAL deployment seams (the runtime identity this
 * plane attests + the dependency readiness evaluation), and the
 * environment-contract facts — everything every hosting shape needs.
 */
export interface BootstrapApp {
  /** The public API server (Fastify app + the introspected route table). */
  readonly server: ApiServer;
  readonly manifest: DeploymentManifest;
  readonly ledger: ProviderTiersLedger;
  readonly environment: EnvironmentId;
  readonly environmentClass: string;
  /** The exact revision this composition attests. */
  readonly revision: string;
  /** The preview branch slug (undefined outside per-branch preview). */
  readonly slug: string | undefined;
  /** The runtime deployment identity behind GET /identity. */
  readonly identity: RuntimeDeploymentIdentity;
  /** The composition description the boot document reports. */
  readonly composition: BootstrapCompositionFacts;
  /** The environment contract evaluation over the current process environment. */
  readonly environmentContract: EnvironmentContractEvaluation;
  /**
   * PPR-008: the materialized preview authorities (undefined in the honest
   * unbound bootstrap shape). Present when the environment materialized the
   * authority set — the CLI host drains the relational pool on shutdown;
   * hosted isolates are recycled instead (never drained).
   */
  readonly previewAuthorities?: PreviewAuthorities;
}

/**
 * Build the bootstrap composition (PPR-006's shared export): the SAME
 * composition the CLI host serves — real transport, real deployment
 * seams, honestly-unbound domain capabilities. Fail-closed inputs throw
 * (the exact-revision override contract; the preview-branch
 * requirement; the unknown-environment refusal) exactly as the CLI
 * host's own preflight does.
 */
export function buildBootstrapApp(options: BootstrapAppOptions): BootstrapApp {
  const environment = options.environment;
  const branch = options.branch;
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
    throw new Error(
      "environment preview requires a branch (the preview resource set is per-branch; pass the branch so the preview slug — and with it the identity — computes)",
    );
  }

  const revision = exactRevision();
  const identity = runtimeDeploymentIdentity(manifest, ledger, revision, environment, slug);

  // PPR-008 — THE MATERIALIZATION GATE: bind the REAL domain seams only
  // when the environment materializes the preview authority set; any
  // missing piece serves EXACTLY today's honest unbound composition.
  const materialization: PreviewAuthorityMaterialization = readPreviewAuthorityMaterialization(
    process.env,
    environment,
  );
  const authorities = materialization.materialized
    ? buildPreviewAuthorities({
        environment,
        databaseUrl: materialization.databaseUrl,
        transportToken: materialization.transportToken,
        applicationId: materialization.applicationId,
      })
    : undefined;

  const unboundAuthenticate: Authenticate = async () => {
    throw new PlatformError({
      code: "AUTHENTICATION_FAILED",
      message:
        "no transport credential is bound in the bootstrap deployment composition (the identity/console work orders own the credential binding; see deploy/PUBLIC-DEPLOYMENT.md)",
    });
  };

  const server = createApiServer({
    // PPR-014: the analysis-aware executions seam — TWO RUNTIMES, one seam.
    // Ordinary sandbox tasks are driven to terminal inline by the
    // deterministic substrate (PPR-008's pinned behavior, unchanged);
    // codebase-analysis tasks are created WITHOUT the inline drive because
    // their runtime is the analysis route's own lifecycle composition over
    // the SAME real single write path (the collision the substrate's
    // inline drive and the route's drive would otherwise produce on this
    // plane is documented in deploy/evidence/ppr-014.json).
    executions:
      authorities === undefined
        ? unboundCapability("executions")
        : createAnalysisAwareExecutions({
            sandbox: createDeterministicSubstrateExecutions({
              inner: authorities.executions,
              actor: authorities.substrateActor,
              generateId: authorities.generateId,
              now: authorities.now,
            }),
            analysis: authorities.executions,
          }),
    agents: authorities === undefined ? unboundCapability("agents") : authorities.agents,
    economics: authorities === undefined ? unboundCapability("economics") : authorities.economics,
    ...(authorities === undefined ? {} : { credentials: authorities.credentials }),
    scopeResolver:
      authorities === undefined ? unboundCapability("scopeResolver") : authorities.scopeResolver,
    authenticate: authorities === undefined ? unboundAuthenticate : authorities.authenticate,
    listAgentIdsOfApplication:
      authorities === undefined
        ? async () => {
            throw new PlatformError({
              code: "CAPABILITY_UNAVAILABLE",
              message:
                "the agents inventory capability is not bound in the bootstrap deployment composition",
            });
          }
        : authorities.listAgentIdsOfApplication,
    codebaseAnalyzer:
      authorities === undefined
        ? unboundCapability("codebaseAnalyzer")
        : authorities.codebaseAnalyzer,
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

  const contract = evaluateEnvironmentContract(manifest, environment, process.env);

  const composition: BootstrapCompositionFacts = {
    transport: "real (createApiServer — the repository public route table)",
    deploymentSeams: "real (runtime identity + dependency readiness)",
    domainCapabilities:
      authorities === undefined
        ? "unbound (honest CAPABILITY_UNAVAILABLE / AUTHENTICATION_FAILED)"
        : "materialized (the preview authority set over the relational DatabasePort: bearer authentication, SQL scope resolution, the credential lifecycle, the execution service with the deterministic sandbox substrate, the agents inventory, the economic-action service with the real policy/capability admissions over the seeded budgets authority and the in-repo simulated payment rail, and the deterministic codebase-analysis opportunity analyzer)",
    authorityMaterialization: materialization.materialized
      ? `materialized (${relationalUrlVariableOf(environment)} + ZECK_TRANSPORT_TOKEN + ZECK_PREVIEW_APPLICATION_ID present; the durable preview seed converges idempotently at cold start; the deterministic sandbox substrate drives the plane's sandbox executions to honest terminal receipts inline while codebase-analysis executions are driven by the analysis route's own lifecycle composition over the same single write path; the funded developer wallet converges create-if-absent on the real budgets ledger and the economic-action chain binds the real admissions with the in-repo simulated payment rail — honestly disclosed, no external payment provider; the codebase-analysis authority serves deterministic advisory analysis over the relational opportunity store — no model behind either)`
      : `unmaterialized (${materialization.missing.join(", ")} absent — exactly the honest unbound bootstrap shape; local/dev behavior unchanged)`,
  };

  return {
    server,
    manifest,
    ledger,
    environment,
    environmentClass: environmentRecord.environmentClass,
    revision,
    slug,
    identity,
    composition,
    environmentContract: contract,
    ...(authorities === undefined ? {} : { previewAuthorities: authorities }),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const environment = requireEnvironment(argv);
  const branch = optionalBranch(argv);

  // The CLI's fail-closed preview-branch pre-check (exit 2, before any
  // composition work — unchanged behavior; the shared builder below
  // enforces the same requirement for non-CLI hosts by throwing).
  if (environment === "preview" && branch === undefined) {
    const manifest = loadManifest();
    if (requiresPreviewSlug(manifest.resources[environment])) {
      console.error("error: --environment preview requires --branch <branch-name>");
      process.exit(2);
    }
  }

  // The shared bootstrap composition (PPR-006): identical to every
  // other hosting shape of this plane.
  const app = buildBootstrapApp({ environment, ...(branch === undefined ? {} : { branch }) });

  const host = optionalValue(argv, "--host") ?? process.env.ZECK_API_HOST ?? "127.0.0.1";
  const portArg = optionalValue(argv, "--port") ?? process.env.ZECK_API_PORT;
  const port = portArg !== undefined ? Number(portArg) : 8787;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid API port: ${portArg ?? port}`);
  }

  await app.server.app.listen({ host, port });

  const boot = {
    tool: "deploy/api",
    status: "listening",
    environment: app.environment,
    environmentClass: app.environmentClass,
    host,
    port,
    deploymentIdentity: {
      runtimeIdentityId: app.identity.runtimeIdentityId,
      identityId: app.identity.identity.identityId,
      gitRevision: app.identity.identity.gitRevision,
      manifestDigest: app.identity.identity.manifestDigest,
      topologyDigest: app.identity.topologyDigest,
    },
    composition: {
      transport: app.composition.transport,
      deploymentSeams: app.composition.deploymentSeams,
      domainCapabilities: app.composition.domainCapabilities,
      authorityMaterialization: app.composition.authorityMaterialization,
    },
    environmentContract: {
      satisfied: app.environmentContract.satisfied,
      problems: app.environmentContract.problems,
    },
    routes: app.server.routes.length,
  };
  console.log(JSON.stringify(boot, null, 2));

  const shutdown = async (signal: string): Promise<void> => {
    console.log(JSON.stringify({ tool: "deploy/api", status: "shutting-down", signal }));
    await app.server.app.close();
    // PPR-008: drain the materialized relational pool (a hosted isolate is
    // recycled by the platform instead; the CLI host drains honestly).
    if (app.previewAuthorities !== undefined) {
      await app.previewAuthorities.close();
    }
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
