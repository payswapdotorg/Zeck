/**
 * PPR-006 unit tests — the Vercel hosting adapter's identity semantics.
 *
 * WHAT IS PINNED HERE (the work order's verification battery):
 *  - ROUTE-TABLE IDENTITY: the adapter's plane serves the IDENTICAL
 *    public route table as the CLI host's composition (both through
 *    the shared buildBootstrapApp — drift is unrepresentable) and the
 *    table is exactly the architecture-pinned public surface;
 *  - IDENTITY PARITY: the adapter's runtime deployment identity equals
 *    the CLI host's for the same inputs, and GET /identity (Fastify
 *    inject) answers the verified document — the exact-revision
 *    attest path the deployed-plane smoke executes;
 *  - REVISION ATTESTATION: a ZECK_DEPLOY_GIT_REVISION override changes
 *    the attested revision of BOTH hosts identically; an invalid
 *    override refuses with the exact contract message;
 *  - SINGLETON REUSE: the module-level entry holder builds the
 *    composition once per isolate and returns the same instance;
 *  - FAIL-CLOSED INPUTS: the environment identity and the preview
 *    branch requirements refuse with actionable messages;
 *  - HONEST BOUNDARIES: the auth-boundary 401, the capability-unbound
 *    422, the public policy artifact 200 and the fail-closed health
 *    semantics answer exactly as the CLI host answers them;
 *  - THE HOSTING CONTRACT FILES: vercel.json carries the functions
 *    configuration for the entry (maxDuration within the documented
 *    Hobby maximum, includeFiles covering the runtime-read manifest
 *    set) and server.ts satisfies Vercel's Fastify entrypoint
 *    detection (the fastify import) and the documented listen shape.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { buildBootstrapApp } from "../../../deploy/api";
import { gitRevision, loadManifest, REPOSITORY_ROOT } from "../../../deploy/lib";
import { wireToRuntimeDocument } from "../../../deploy/plane-identity";
import {
  buildVercelPlane,
  getVercelPlane,
  readVercelPlaneInputs,
  requireProcessEnvironment,
} from "../../../deploy/vercel";
import type { RuntimeIdentityWire } from "../../../src/api/routes/identity";
import { parseProviderTiers } from "../../../src/platform/deployment/provider-tiers";
import { verifyRuntimeDeploymentIdentity } from "../../../src/platform/deployment/runtime-identity";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The architecture-pinned public route table (tests/architecture/public-surface.test.ts M21). */
const PUBLIC_ROUTE_TABLE: readonly string[] = [
  "GET /agents",
  "GET /agents/:id",
  "GET /agents/:id/status",
  "GET /agents/:id/versions",
  "GET /codebase-analysis/:id",
  "GET /credentials",
  "GET /economic-actions/:id",
  "GET /economic-actions/:id/events",
  "GET /economic-actions/:id/outcome",
  "GET /executions/:id",
  "GET /executions/:id/events",
  "GET /executions/:id/results",
  "GET /executions/:id/verification",
  "GET /health",
  "GET /identity",
  "GET /sandbox/data-policy",
  "GET /sandbox/identities/:identityId",
  "GET /sandbox/quotas",
  "POST /codebase-analysis",
  "POST /codebase-analysis/:id/findings/:findingId/transition",
  "POST /codebase-analysis/:id/ratings",
  "POST /credentials",
  "POST /credentials/:credentialId/revoke",
  "POST /credentials/:credentialId/rotate",
  "POST /economic-actions",
  "POST /executions",
  "POST /executions/:id/cancel",
  "POST /sandbox/identities/:identityId/reset",
].sort();

/** The @vercel/fastify entrypoint detector's content regex (the hosting contract). */
const FASTIFY_ENTRYPOINT_REGEX = /(?:from|require|import)\s*(?:\(\s*)?["']fastify["']/;

const builtPlanes: ReturnType<typeof buildVercelPlane>[] = [];

afterAll(async () => {
  for (const plane of builtPlanes) {
    await plane.app.close();
  }
});

function track<T extends ReturnType<typeof buildVercelPlane>>(plane: T): T {
  builtPlanes.push(plane);
  return plane;
}

/** Run a body with ZECK_DEPLOY_GIT_REVISION temporarily set (restored after). */
async function withRevisionOverride(
  revision: string,
  body: () => Promise<void> | void,
): Promise<void> {
  const previous = process.env.ZECK_DEPLOY_GIT_REVISION;
  process.env.ZECK_DEPLOY_GIT_REVISION = revision;
  try {
    await body();
  } finally {
    if (previous === undefined) {
      delete process.env.ZECK_DEPLOY_GIT_REVISION;
    } else {
      process.env.ZECK_DEPLOY_GIT_REVISION = previous;
    }
  }
}

describe("PPR-006: the Vercel hosting adapter composes the CLI host's plane", () => {
  test("the adapter serves the identical route table (the shared composition)", () => {
    const adapterPlane = track(buildVercelPlane({ environment: "local" }));
    const cliComposition = buildBootstrapApp({ environment: "local" });
    const adapterRoutes = adapterPlane.server.routes
      .map((route) => `${route.method} ${route.url}`)
      .sort();
    const cliRoutes = cliComposition.server.routes
      .map((route) => `${route.method} ${route.url}`)
      .sort();
    expect(adapterRoutes).toEqual(PUBLIC_ROUTE_TABLE);
    expect(adapterRoutes).toEqual(cliRoutes);
  });

  test("the adapter's identity document equals the CLI host's for the same inputs", () => {
    const adapterPlane = track(buildVercelPlane({ environment: "local" }));
    const cliComposition = buildBootstrapApp({ environment: "local" });
    expect(adapterPlane.identity).toEqual(cliComposition.identity);
    expect(adapterPlane.identity.identity.gitRevision).toBe(cliComposition.revision);
    expect(adapterPlane.environmentClass).toBe(cliComposition.environmentClass);
    expect(adapterPlane.composition).toEqual(cliComposition.composition);
  });

  test("the preview branch flows to the same slug and identity in both hosts", () => {
    const branch = "work/PPR-006-vercel-hosting-adapter";
    const adapterPlane = track(buildVercelPlane({ environment: "preview", branch }));
    const cliComposition = buildBootstrapApp({ environment: "preview", branch });
    expect(adapterPlane.slug).toBe(cliComposition.slug);
    expect(adapterPlane.slug).toMatch(/^[a-z0-9-]+$/);
    expect(adapterPlane.identity).toEqual(cliComposition.identity);
    expect(adapterPlane.identity.identity.environment).toBe("preview");
  });

  test("GET /identity answers the verified exact-revision document (inject)", async () => {
    const plane = track(buildVercelPlane({ environment: "local" }));
    const response = await plane.app.inject({ method: "GET", url: "/identity" });
    expect(response.statusCode).toBe(200);
    const wire = response.json<RuntimeIdentityWire>();
    const manifest = loadManifest();
    const ledger = parseProviderTiers(
      readFileSync(join(REPOSITORY_ROOT, "deploy", "manifests", "provider-tiers.json"), "utf8"),
      manifest,
    );
    // The deployed-plane smoke's exact verification path: the document
    // recomputes at the expected revision (drift or tampering refuses).
    const verification = verifyRuntimeDeploymentIdentity(
      manifest,
      ledger,
      wireToRuntimeDocument(wire),
      plane.revision,
      "local",
      undefined,
    );
    expect(verification.valid).toBe(true);
    expect(wire.identity.gitRevision).toBe(plane.revision);
  });

  test("a ZECK_DEPLOY_GIT_REVISION override changes the attested revision of both hosts identically", async () => {
    const override = "f".repeat(40);
    await withRevisionOverride(override, async () => {
      const adapterPlane = track(buildVercelPlane({ environment: "local" }));
      const cliComposition = buildBootstrapApp({ environment: "local" });
      expect(adapterPlane.revision).toBe(override);
      expect(cliComposition.revision).toBe(override);
      expect(adapterPlane.identity.identity.gitRevision).toBe(override);
      expect(adapterPlane.identity).toEqual(cliComposition.identity);
      const response = await adapterPlane.app.inject({ method: "GET", url: "/identity" });
      expect(response.statusCode).toBe(200);
      expect(response.json<RuntimeIdentityWire>().identity.gitRevision).toBe(override);
    });
    // Without the override both hosts attest the checkout's exact revision.
    const adapterPlane = track(buildVercelPlane({ environment: "local" }));
    expect(adapterPlane.revision).toBe(gitRevision());
  });

  test("an invalid ZECK_DEPLOY_GIT_REVISION refuses with the contract message (both hosts)", async () => {
    await withRevisionOverride("not-a-sha", async () => {
      expect(() => buildVercelPlane({ environment: "local" })).toThrow(
        'ZECK_DEPLOY_GIT_REVISION must be an exact 40-hex Git sha (got: "not-a-sha")',
      );
      expect(() => buildBootstrapApp({ environment: "local" })).toThrow(
        'ZECK_DEPLOY_GIT_REVISION must be an exact 40-hex Git sha (got: "not-a-sha")',
      );
    });
  });

  test("the honest boundaries answer exactly as the CLI host answers them (inject)", async () => {
    const plane = track(buildVercelPlane({ environment: "local" }));

    // The auth boundary: a well-formed probe reaches the authenticate
    // seam and answers the honest 401 (no fabricated capability).
    const execution = await plane.app.inject({
      method: "POST",
      url: "/executions",
      headers: {
        authorization: "Bearer vercel-adapter-probe",
        "content-type": "application/json",
        "idempotency-key": "vercel-adapter-probe-1",
      },
      payload: JSON.stringify({
        applicationId: "00000000-0000-0000-0000-000000000000",
        task: { kind: "vercel-adapter-probe" },
      }),
    });
    expect(execution.statusCode).toBe(401);
    expect(execution.json<{ code?: string }>().code).toBe("AUTHENTICATION_FAILED");

    // The capability-unbound boundary: the honest 422, never a fabricated fact.
    const credentials = await plane.app.inject({ method: "GET", url: "/credentials" });
    expect(credentials.statusCode).toBe(422);
    expect(credentials.json<{ code?: string }>().code).toBe("CAPABILITY_UNAVAILABLE");

    // The public policy artifact: the one unauthenticated 200.
    const policy = await plane.app.inject({ method: "GET", url: "/sandbox/data-policy" });
    expect(policy.statusCode).toBe(200);
    const artifact = policy.json<{ artifact?: string; digest?: string }>();
    expect(artifact.artifact).toBeTruthy();
    expect(artifact.digest).toBeTruthy();
  });

  test("GET /health answers the honest fail-closed semantics without a PostgreSQL authority (inject)", async () => {
    const plane = track(buildVercelPlane({ environment: "local" }));
    const previous = process.env.ZECK_PG_ADMIN_URL;
    delete process.env.ZECK_PG_ADMIN_URL;
    try {
      const response = await plane.app.inject({ method: "GET", url: "/health" });
      const body = response.json<{ status?: string; controlPlane?: string }>();
      expect(response.statusCode).toBe(503);
      expect(body.controlPlane).toBe("ready");
      expect(body.status).toBe("down");
    } finally {
      if (previous !== undefined) {
        process.env.ZECK_PG_ADMIN_URL = previous;
      }
    }
  });
});

describe("PPR-006: the hosting entry's fail-closed inputs", () => {
  test("the environment identity resolves from ZECK_ENVIRONMENT (fail closed)", () => {
    expect(() => requireProcessEnvironment({})).toThrow(/ZECK_ENVIRONMENT is not set/);
    expect(() => requireProcessEnvironment({ ZECK_ENVIRONMENT: "prod" })).toThrow(
      /must be one of local\|preview\|staging\|production/,
    );
    expect(requireProcessEnvironment({ ZECK_ENVIRONMENT: "local" })).toBe("local");
    expect(requireProcessEnvironment({ ZECK_ENVIRONMENT: "preview" })).toBe("preview");
    expect(requireProcessEnvironment({ ZECK_ENVIRONMENT: "staging" })).toBe("staging");
    expect(requireProcessEnvironment({ ZECK_ENVIRONMENT: "production" })).toBe("production");
  });

  test("the preview branch resolves from VERCEL_GIT_COMMIT_REF (fail closed when required)", () => {
    const inputs = readVercelPlaneInputs({
      ZECK_ENVIRONMENT: "preview",
      VERCEL_GIT_COMMIT_REF: "main",
    });
    expect(inputs.environment).toBe("preview");
    expect(inputs.branch).toBe("main");
    expect(() =>
      readVercelPlaneInputs({ ZECK_ENVIRONMENT: "preview", VERCEL_GIT_COMMIT_REF: " " }),
    ).toThrow(/VERCEL_GIT_COMMIT_REF is absent/);
    // Non-preview environments need no branch.
    expect(readVercelPlaneInputs({ ZECK_ENVIRONMENT: "local" })).toEqual({ environment: "local" });
  });
});

describe("PPR-006: the module-level singleton (once per isolate)", () => {
  test("getVercelPlane builds once and returns the same instance on every call", () => {
    const previous = process.env.ZECK_ENVIRONMENT;
    process.env.ZECK_ENVIRONMENT = "local";
    try {
      const first = track(getVercelPlane());
      const second = getVercelPlane();
      expect(second).toBe(first);
      expect(second.app).toBe(first.app);
      expect(second.server.routes.length).toBe(PUBLIC_ROUTE_TABLE.length);
    } finally {
      if (previous === undefined) {
        delete process.env.ZECK_ENVIRONMENT;
      } else {
        process.env.ZECK_ENVIRONMENT = previous;
      }
    }
  });
});

describe("PPR-006: the hosting contract files", () => {
  test("vercel.json pins the framework detection and carries no functions-key entry pattern", () => {
    const config = JSON.parse(readFileSync(join(REPO_ROOT, "vercel.json"), "utf8")) as {
      framework?: string;
      functions?: Record<string, unknown>;
    };
    // The zero-config Fastify entrypoint detection, pinned explicitly so
    // a future framework reshuffle cannot silently change the hosting
    // shape (the entry stays the root server.ts + fastify.listen form).
    expect(config.framework).toBe("fastify");
    // The live deployment run (Lead, 2026-09-21) proved the platform's
    // build REJECTS a `functions` pattern for a root entry — patterns
    // only match Serverless Functions inside the `api` directory
    // ("The pattern \"server.ts\" defined in `functions` doesn't match
    // any Serverless Functions inside the `api` directory."). The
    // detected entry needs no functions-key configuration: the build's
    // default file tracing ships deploy/manifests/*.json into the
    // function bundle (verified in the built .vercel/output/functions
    // bundle of the same run), so no includeFiles glob is required.
    expect(config.functions).toBeUndefined();
  });

  test("server.ts satisfies Vercel's Fastify entrypoint detection and the documented listen shape", () => {
    const source = readFileSync(join(REPO_ROOT, "server.ts"), "utf8");
    // The @vercel/fastify entrypoint detector matches an entry file
    // whose content imports fastify.
    expect(FASTIFY_ENTRYPOINT_REGEX.test(source)).toBe(true);
    // The documented hosting shape: the entry calls fastify.listen().
    expect(source).toMatch(/\.listen\(/);
    // The entry composes through the shared adapter, never a re-implementation.
    expect(source).toContain("./deploy/vercel");
  });
});
