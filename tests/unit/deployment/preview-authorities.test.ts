/**
 * PPR-008 unit tests — the preview authority materialization gate and the
 * BOTH composition shapes of the bootstrap host.
 *
 * WHAT IS PINNED HERE (the work order's verification battery):
 *  - THE GATE READER: every missing-piece combination of the authority set
 *    (per environment — local reads ZECK_PG_ADMIN_URL exactly as /health's
 *    relational probe does, the other environments read ZECK_DATABASE_URL)
 *    reports the missing variable NAMES, never values; a malformed
 *    application identity fails closed as a missing piece;
 *  - THE UNMATERIALIZED SHAPE (today's honest unbound bootstrap, pinned):
 *    without the authority set the composition serves the identical route
 *    table, the honest 401 AUTHENTICATION_FAILED auth boundary, the honest
 *    422 CAPABILITY_UNAVAILABLE credential boundary, and the truthful
 *    unmaterialized composition fact (the missing names, derived);
 *  - THE MATERIALIZED SHAPE (no database contact): with the authority set
 *    present the composition constructs the materialized authorities (the
 *    pg pool is lazy), the composition facts report the materialized
 *    authority set, the credentials service's honest issuance gate is
 *    closed (issuanceEnabled false — the read-only environment
 *    materialization), and every bound seam FAILS CLOSED while the
 *    cold-start seeding cannot complete (an unreachable relational
 *    endpoint): PROVIDER_ERROR, never a fabricated success;
 *  - THE DETERMINISTIC SEED PLAN: the seeded identities are pure functions
 *    of the preview application id (same input → same plan → the same
 *    durable rows on every cold start; the real-rail idempotency proof —
 *    run twice, same rows — lives in the PostgreSQL integration suite).
 */

import { afterAll, describe, expect, test } from "vitest";
import { buildBootstrapApp } from "../../../deploy/api";
import {
  previewSeedPlanOf,
  previewTransportTokenReference,
  readPreviewAuthorityMaterialization,
  relationalUrlVariableOf,
} from "../../../deploy/preview-authorities";

const APPLICATION_ID = "0d0e0f10-1112-1314-1516-1718191a1b1c";

/** A clean environment view for the gate reader (no ambient leakage). */
const CLEAN_ENV: Readonly<Record<string, string | undefined>> = {
  ZECK_DATABASE_URL: undefined,
  ZECK_PG_ADMIN_URL: undefined,
  ZECK_TRANSPORT_TOKEN: undefined,
  ZECK_PREVIEW_APPLICATION_ID: undefined,
};

function envWith(
  overrides: Readonly<Record<string, string>>,
): Readonly<Record<string, string | undefined>> {
  return { ...CLEAN_ENV, ...overrides };
}

// ---------------------------------------------------------------------------
// The gate reader
// ---------------------------------------------------------------------------

describe("PPR-008: the preview authority materialization gate", () => {
  test("local reads ZECK_PG_ADMIN_URL (exactly /health's relational probe variable)", () => {
    expect(relationalUrlVariableOf("local")).toBe("ZECK_PG_ADMIN_URL");
    expect(relationalUrlVariableOf("preview")).toBe("ZECK_DATABASE_URL");
    expect(relationalUrlVariableOf("staging")).toBe("ZECK_DATABASE_URL");
    expect(relationalUrlVariableOf("production")).toBe("ZECK_DATABASE_URL");
  });

  test("nothing set reports every missing variable name (local vs preview)", () => {
    const local = readPreviewAuthorityMaterialization(CLEAN_ENV, "local");
    expect(local).toEqual({
      materialized: false,
      missing: ["ZECK_PG_ADMIN_URL", "ZECK_TRANSPORT_TOKEN", "ZECK_PREVIEW_APPLICATION_ID"],
    });
    const preview = readPreviewAuthorityMaterialization(CLEAN_ENV, "preview");
    expect(preview).toEqual({
      materialized: false,
      missing: ["ZECK_DATABASE_URL", "ZECK_TRANSPORT_TOKEN", "ZECK_PREVIEW_APPLICATION_ID"],
    });
  });

  test("each individually missing piece is reported by name (never a value)", () => {
    const base = envWith({
      ZECK_DATABASE_URL: "postgres://user:secret@example.invalid/db",
      ZECK_TRANSPORT_TOKEN: "secret-material",
      ZECK_PREVIEW_APPLICATION_ID: APPLICATION_ID,
    });
    for (const key of [
      "ZECK_DATABASE_URL",
      "ZECK_TRANSPORT_TOKEN",
      "ZECK_PREVIEW_APPLICATION_ID",
    ]) {
      const partial = readPreviewAuthorityMaterialization({ ...base, [key]: undefined }, "preview");
      expect(partial.materialized).toBe(false);
      if (!partial.materialized) {
        expect(partial.missing).toEqual([key]);
      }
    }
  });

  test("a fully materialized set materializes (values never echo into the report)", () => {
    const materialization = readPreviewAuthorityMaterialization(
      envWith({
        ZECK_DATABASE_URL: "postgres://user:secret@example.invalid/db",
        ZECK_TRANSPORT_TOKEN: "secret-material",
        ZECK_PREVIEW_APPLICATION_ID: APPLICATION_ID,
      }),
      "preview",
    );
    expect(materialization.materialized).toBe(true);
    // Whitespace-only values are absent values.
    const blank = readPreviewAuthorityMaterialization(
      envWith({
        ZECK_DATABASE_URL: "postgres://user:secret@example.invalid/db",
        ZECK_TRANSPORT_TOKEN: "   ",
        ZECK_PREVIEW_APPLICATION_ID: APPLICATION_ID,
      }),
      "preview",
    );
    expect(blank.materialized).toBe(false);
  });

  test("a malformed application identity fails closed as a missing piece", () => {
    const materialization = readPreviewAuthorityMaterialization(
      envWith({
        ZECK_DATABASE_URL: "postgres://user:secret@example.invalid/db",
        ZECK_TRANSPORT_TOKEN: "secret-material",
        ZECK_PREVIEW_APPLICATION_ID: "not-a-uuid",
      }),
      "preview",
    );
    expect(materialization).toEqual({
      materialized: false,
      missing: ["ZECK_PREVIEW_APPLICATION_ID (must be a UUID)"],
    });
  });

  test("the deterministic seed plan is a pure function of the application id", () => {
    const first = previewSeedPlanOf(APPLICATION_ID, "preview");
    const second = previewSeedPlanOf(APPLICATION_ID, "preview");
    expect(first).toEqual(second);
    expect(first.applicationId).toBe(APPLICATION_ID);
    expect(first.secretReference).toBe("zeck-secret://preview/transport-token");
    expect(previewTransportTokenReference("local")).toBe("zeck-secret://local/transport-token");
    // A different application id yields a different plan (no cross-binding).
    const other = previewSeedPlanOf("00000000-0000-4000-8000-000000000001", "preview");
    expect(other.tenantId).not.toBe(first.tenantId);
    expect(other.transportActorId).not.toBe(first.transportActorId);
    expect(other.transportCredentialId).not.toBe(first.transportCredentialId);
    // Every seeded identity is a well-formed UUID (durable columns accept it).
    expect(first.tenantId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(first.transportActorId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

// ---------------------------------------------------------------------------
// The composition shapes (buildBootstrapApp over a controlled environment)
// ---------------------------------------------------------------------------

/** The architecture-pinned public route table (the identical surface both ways). */
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

const MATERIALIZATION_VARIABLES: readonly string[] = [
  "ZECK_PG_ADMIN_URL",
  "ZECK_TRANSPORT_TOKEN",
  "ZECK_PREVIEW_APPLICATION_ID",
];

/** Run a body with the local materialization variables temporarily set (restored after). */
async function withLocalMaterialization(
  overrides: Readonly<Record<string, string | undefined>>,
  body: () => Promise<void> | void,
): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const key of MATERIALIZATION_VARIABLES) {
    previous[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    await body();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

const builtApps: ReturnType<typeof buildBootstrapApp>[] = [];

afterAll(async () => {
  for (const app of builtApps) {
    await app.previewAuthorities?.close();
    await app.server.app.close();
  }
});

function track(app: ReturnType<typeof buildBootstrapApp>): ReturnType<typeof buildBootstrapApp> {
  builtApps.push(app);
  return app;
}

describe("PPR-008: the unmaterialized composition shape (today's honest bootstrap, pinned)", () => {
  test("without the authority set the composition facts report the honest unbound state", async () => {
    await withLocalMaterialization(
      {
        ZECK_PG_ADMIN_URL: undefined,
        ZECK_TRANSPORT_TOKEN: undefined,
        ZECK_PREVIEW_APPLICATION_ID: undefined,
      },
      () => {
        const app = track(buildBootstrapApp({ environment: "local" }));
        expect(app.previewAuthorities).toBeUndefined();
        expect(app.composition.domainCapabilities).toBe(
          "unbound (honest CAPABILITY_UNAVAILABLE / AUTHENTICATION_FAILED)",
        );
        expect(app.composition.authorityMaterialization).toBe(
          "unmaterialized (ZECK_PG_ADMIN_URL, ZECK_TRANSPORT_TOKEN, ZECK_PREVIEW_APPLICATION_ID absent — exactly the honest unbound bootstrap shape; local/dev behavior unchanged)",
        );
      },
    );
  });

  test("the route table is the identical pinned public surface", async () => {
    await withLocalMaterialization(
      {
        ZECK_PG_ADMIN_URL: undefined,
        ZECK_TRANSPORT_TOKEN: undefined,
        ZECK_PREVIEW_APPLICATION_ID: undefined,
      },
      () => {
        const app = track(buildBootstrapApp({ environment: "local" }));
        const routes = app.server.routes.map((route) => `${route.method} ${route.url}`).sort();
        expect(routes).toEqual(PUBLIC_ROUTE_TABLE);
      },
    );
  });

  test("the honest boundaries answer exactly today's shapes (401 / 422)", async () => {
    await withLocalMaterialization(
      {
        ZECK_PG_ADMIN_URL: undefined,
        ZECK_TRANSPORT_TOKEN: undefined,
        ZECK_PREVIEW_APPLICATION_ID: undefined,
      },
      async () => {
        const app = track(buildBootstrapApp({ environment: "local" }));
        // The auth boundary: a well-formed credentialed probe reaches the
        // authenticate seam and answers the honest 401.
        const execution = await app.server.app.inject({
          method: "POST",
          url: "/executions",
          headers: {
            authorization: "Bearer ppr-008-unbound-probe",
            "content-type": "application/json",
            "idempotency-key": "ppr-008-unbound-probe-1",
          },
          payload: JSON.stringify({
            applicationId: "00000000-0000-0000-0000-000000000000",
            task: { kind: "summarize", doc: "probe" },
          }),
        });
        expect(execution.statusCode).toBe(401);
        expect(execution.json<{ code?: string }>().code).toBe("AUTHENTICATION_FAILED");

        // The credential boundary: the honest 422 of the unwired authority.
        const credentials = await app.server.app.inject({
          method: "GET",
          url: "/credentials",
          headers: { authorization: "Bearer ppr-008-unbound-probe" },
        });
        expect(credentials.statusCode).toBe(422);
        expect(credentials.json<{ code?: string }>().code).toBe("CAPABILITY_UNAVAILABLE");

        // The agents boundary: the honest 401 before the inventory seam.
        const agents = await app.server.app.inject({
          method: "GET",
          url: "/agents",
          headers: {
            authorization: "Bearer ppr-008-unbound-probe",
            "x-zeck-application": "00000000-0000-0000-0000-000000000000",
          },
        });
        expect(agents.statusCode).toBe(401);
        expect(agents.json<{ code?: string }>().code).toBe("AUTHENTICATION_FAILED");
      },
    );
  });
});

describe("PPR-008: the materialized composition shape (no database contact)", () => {
  // An unreachable relational endpoint: the pool is constructed lazily, the
  // cold-start seeding fails fast (connection refused), and every bound seam
  // fails CLOSED — never a fabricated success.
  const UNREACHABLE_URL = "postgres://zeck@127.0.0.1:9/postgres";

  test("the composition constructs the materialized authorities and reports the truthful fact", async () => {
    await withLocalMaterialization(
      {
        ZECK_PG_ADMIN_URL: UNREACHABLE_URL,
        ZECK_TRANSPORT_TOKEN: "ppr-008-materialized-probe-token",
        ZECK_PREVIEW_APPLICATION_ID: APPLICATION_ID,
      },
      () => {
        const app = track(buildBootstrapApp({ environment: "local" }));
        expect(app.previewAuthorities).toBeDefined();
        expect(app.previewAuthorities?.applicationId).toBe(APPLICATION_ID);
        expect(app.composition.domainCapabilities).toContain("materialized");
        expect(app.composition.authorityMaterialization).toContain("materialized");
        expect(app.composition.authorityMaterialization).toContain("ZECK_TRANSPORT_TOKEN");
        // The issuance gate is honestly closed (read-only environment materialization).
        expect(app.previewAuthorities?.credentials.issuanceEnabled()).toBe(false);
        // The route table is STILL the identical pinned public surface.
        const routes = app.server.routes.map((route) => `${route.method} ${route.url}`).sort();
        expect(routes).toEqual(PUBLIC_ROUTE_TABLE);
      },
    );
  });

  test("the bound seams fail closed while the seeding cannot complete (never a fabricated success)", async () => {
    await withLocalMaterialization(
      {
        ZECK_PG_ADMIN_URL: UNREACHABLE_URL,
        ZECK_TRANSPORT_TOKEN: "ppr-008-materialized-probe-token",
        ZECK_PREVIEW_APPLICATION_ID: APPLICATION_ID,
      },
      async () => {
        const app = track(buildBootstrapApp({ environment: "local" }));
        // A credentialed create reaches the seeding gate and fails closed.
        const execution = await app.server.app.inject({
          method: "POST",
          url: "/executions",
          headers: {
            authorization: "Bearer ppr-008-materialized-probe-token",
            "content-type": "application/json",
            "idempotency-key": "ppr-008-failclosed-1",
          },
          payload: JSON.stringify({
            applicationId: APPLICATION_ID,
            task: { kind: "summarize", doc: "probe" },
          }),
        });
        expect(execution.statusCode).toBe(502);
        const body = execution.json<{ code?: string; message?: string }>();
        expect(body.code).toBe("PROVIDER_ERROR");
        expect(body.message).toContain("the preview authorities are unavailable");
        // The credential list route is BOUND (no 422 unbound) and fails the
        // same honest closed way through the authenticate seam.
        const credentials = await app.server.app.inject({
          method: "GET",
          url: "/credentials",
          headers: {
            authorization: "Bearer ppr-008-materialized-probe-token",
            "x-zeck-application": APPLICATION_ID,
          },
        });
        expect(credentials.statusCode).toBe(502);
        expect(credentials.json<{ code?: string }>().code).toBe("PROVIDER_ERROR");
      },
    );
  });

  test("a malformed relational URL refuses at construction (the connection contract)", async () => {
    await withLocalMaterialization(
      {
        ZECK_PG_ADMIN_URL: "not-a-postgres-url",
        ZECK_TRANSPORT_TOKEN: "ppr-008-materialized-probe-token",
        ZECK_PREVIEW_APPLICATION_ID: APPLICATION_ID,
      },
      () => {
        expect(() => buildBootstrapApp({ environment: "local" })).toThrow(
          /must be a postgres:\/\/ or postgresql:\/\/ URL/,
        );
      },
    );
  });
});
