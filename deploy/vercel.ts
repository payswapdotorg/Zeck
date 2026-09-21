/**
 * deploy/vercel — the Vercel hosting adapter (PPR-006, the
 * Experience-Delivery Enabler).
 *
 * THE REQUEST-HANDLER ENTRY'S COMPOSITION CORE: this adapter builds the
 * SAME bootstrap composition as the CLI host (deploy/api.ts) — through
 * the SHARED builder `buildBootstrapApp`, never a re-implementation —
 * so the deployed surface is the identical `createApiServer` public
 * route table with the identical exact-revision identity semantics:
 *
 *  - GET /identity attests the runtime deployment identity computed
 *    from the manifest set + the tier ledger at the exact revision
 *    (ZECK_DEPLOY_GIT_REVISION — the deployment materializes it; the
 *    deployed bundle carries NO git checkout, so the override is the
 *    only revision source: absent ⇒ the isolate fails closed at cold
 *    start, never fabricating an identity);
 *  - GET /health answers the honest control-plane/dependency facts
 *    (fail-closed authority) over the environment's materialized
 *    dependency variables;
 *  - every domain seam answers the honest 401 AUTHENTICATION_FAILED /
 *    422 CAPABILITY_UNAVAILABLE of the unbound bootstrap composition.
 *
 * THE HOSTING CONTRACT (verified against the current Vercel
 * documentation, 2026-09-21 — sources recorded in
 * deploy/evidence/ppr-006.json):
 *  - the function entry is the ROOT `server.ts` (the Fastify framework
 *    entrypoint detection: app/index/server.{js,...,ts} at the project
 *    root — https://vercel.com/docs/frameworks/backend/fastify), which
 *    imports fastify, builds the composition ONCE PER ISOLATE (the
 *    module-level singleton below: cold start builds, warm requests
 *    reuse) and calls `fastify.listen()` — the documented shape
 *    Vercel's runtime captures to route every request into Fastify's
 *    router with the ORIGINAL path;
 *  - `vercel.json` at the project root carries the functions
 *    configuration for the entry (`server.ts`: maxDuration +
 *    includeFiles for deploy/manifests/*.json — the composition reads
 *    the manifest set from disk at runtime; the bundler's import
 *    tracing does not see readFileSync targets);
 *  - runtime: Node.js (the Fastify framework detection's default).
 *    The sanctioned Bun runtime configuration was verified to be the
 *    top-level `bunVersion` property (NOT the `functions` `runtime`
 *    field, which current documentation reserves for runtimes that are
 *    not officially supported) — recorded with sources in the evidence;
 *    the Bun runtime (Beta, permissions-gated) has no documented
 *    Fastify entrypoint shape, so the Node.js runtime is used per the
 *    work order's allowance.
 *
 * THE ENVIRONMENT INPUTS (names only — values never transit this
 * repository; see deploy/PUBLIC-DEPLOYMENT.md §13 for the deployment
 * contract):
 *  - ZECK_ENVIRONMENT — the environment identity (required, fail
 *    closed);
 *  - ZECK_DEPLOY_GIT_REVISION — the exact deployed revision (required
 *    on Vercel: no git checkout exists in the bundle);
 *  - VERCEL_GIT_COMMIT_REF — the Vercel system variable carrying the
 *    deployed branch (the preview slug input; required when the
 *    environment is preview and the resource set is per-branch);
 *  - the environment's materialized dependency variables
 *    (ZECK_DATABASE_URL and the ZECK_SECRET_*_REF reference set) for
 *    the /health readiness facts.
 *
 * The adapter owns NO deployment: every live-Vercel step is the Lead's
 * credentialed run (see the notRun registry of
 * deploy/evidence/ppr-006.json).
 */

import type { FastifyInstance } from "fastify";
import type { EnvironmentId } from "../src/platform/deployment/naming";
import { requiresPreviewSlug } from "../src/platform/deployment/naming";
import { type BootstrapApp, buildBootstrapApp } from "./api";
import { loadManifest } from "./lib";

/** The environments the environment-identity variable may carry. */
const ENVIRONMENTS: readonly EnvironmentId[] = ["local", "preview", "staging", "production"];

/** Narrow a string to an environment identity. */
function isEnvironmentId(value: string): value is EnvironmentId {
  return (ENVIRONMENTS as readonly string[]).includes(value);
}

/**
 * Resolve the environment identity from ZECK_ENVIRONMENT (fail
 * closed). The CLI host parses --environment; the request-handler
 * entry has no argv — the deployment's environment variable IS the
 * contract (variables.json: ZECK_ENVIRONMENT, required).
 */
export function requireProcessEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): EnvironmentId {
  const value = env.ZECK_ENVIRONMENT?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(
      "ZECK_ENVIRONMENT is not set; the hosting entry cannot compose a plane without its environment identity (set it in the deployment's environment variables — see deploy/PUBLIC-DEPLOYMENT.md)",
    );
  }
  if (!isEnvironmentId(value)) {
    throw new Error(
      `ZECK_ENVIRONMENT is "${value}" but must be one of local|preview|staging|production`,
    );
  }
  return value;
}

/**
 * The deployed branch (the preview slug input): Vercel's system
 * variable VERCEL_GIT_COMMIT_REF — "the git branch of the commit the
 * deployment was triggered by", available at build and runtime
 * (https://vercel.com/docs/environment-variables/system-environment-variables).
 * The adapter consumes it ONLY as the branch input the CLI host
 * receives as --branch; the identity inputs stay the governed
 * ZECK_* contract variables.
 */
export function vercelBranchRef(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const value = env.VERCEL_GIT_COMMIT_REF?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

/** The hosting-entry inputs resolved from the deployment environment. */
export interface VercelPlaneInputs {
  readonly environment: EnvironmentId;
  readonly branch?: string;
}

/** Read the hosting-entry inputs (fail closed on every requirement). */
export function readVercelPlaneInputs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): VercelPlaneInputs {
  const environment = requireProcessEnvironment(env);
  const branch = vercelBranchRef(env);
  if (environment === "preview" && branch === undefined) {
    const manifest = loadManifest();
    if (requiresPreviewSlug(manifest.resources[environment])) {
      throw new Error(
        'ZECK_ENVIRONMENT is "preview" but the branch is not resolvable: the Vercel system variable VERCEL_GIT_COMMIT_REF is absent (git-connected deployments provide it; deploy from a branch or set it for the deployment — the preview resource set is per-branch, so the preview slug — and with it the identity — cannot compute)',
      );
    }
  }
  return { environment, ...(branch === undefined ? {} : { branch }) };
}

/** The built Vercel plane: the bootstrap composition + the Fastify app. */
export interface VercelPlane extends BootstrapApp {
  /** The Fastify instance the entry registers with the host (the listen call is the entry's, per the documented shape). */
  readonly app: FastifyInstance;
}

/**
 * Build the Vercel plane over the shared bootstrap composition. The
 * SAME builder, the SAME inputs, the SAME identity semantics as the
 * CLI host — pinned by tests/unit/deployment/vercel-adapter.test.ts.
 */
export function buildVercelPlane(inputs: VercelPlaneInputs): VercelPlane {
  const composition = buildBootstrapApp({
    environment: inputs.environment,
    ...(inputs.branch === undefined ? {} : { branch: inputs.branch }),
  });
  return { ...composition, app: composition.server.app };
}

let planeSingleton: VercelPlane | null = null;

/**
 * THE MODULE-LEVEL SINGLETON: the composition builds ONCE PER ISOLATE
 * (cold start builds; warm requests reuse the built app). The entry
 * (root server.ts) calls this at module scope; Vercel's runtime loads
 * the module once per isolate and routes every request into the
 * captured Fastify server.
 */
export function getVercelPlane(): VercelPlane {
  if (planeSingleton === null) {
    planeSingleton = buildVercelPlane(readVercelPlaneInputs());
    // The cold-start boot record (operational visibility — the runtime
    // logs carry it; the same honest vocabulary as the CLI host's boot
    // document, minus the host-owned listener facts).
    console.log(
      JSON.stringify({
        tool: "deploy/vercel",
        status: "booted",
        environment: planeSingleton.environment,
        environmentClass: planeSingleton.environmentClass,
        deploymentIdentity: {
          runtimeIdentityId: planeSingleton.identity.runtimeIdentityId,
          identityId: planeSingleton.identity.identity.identityId,
          gitRevision: planeSingleton.identity.identity.gitRevision,
          manifestDigest: planeSingleton.identity.identity.manifestDigest,
          topologyDigest: planeSingleton.identity.topologyDigest,
        },
        composition: planeSingleton.composition,
        environmentContract: {
          satisfied: planeSingleton.environmentContract.satisfied,
          problems: planeSingleton.environmentContract.problems,
        },
        routes: planeSingleton.server.routes.length,
      }),
    );
  }
  return planeSingleton;
}

/**
 * The graceful-drain discipline of the deployable-service proof (the
 * same SIGTERM/SIGINT contract as the CLI host): on a platform
 * recycle or a local stop, the plane closes its Fastify app and exits
 * 0 — never a dropped-connection kill.
 */
export function installVercelPlaneSignalDrain(plane: VercelPlane): void {
  const shutdown = async (signal: string): Promise<void> => {
    console.log(JSON.stringify({ tool: "deploy/vercel", status: "shutting-down", signal }));
    await plane.app.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
}
