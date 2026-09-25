/**
 * PPR-014 unit tests — the GAP-006 seam bindings: the economics +
 * codebase-analysis authorities over the preview materialization.
 *
 * WHAT IS PINNED HERE (the work order's verification battery, unit half):
 *  - THE UNMATERIALIZED SHAPE (today's honest unbound bootstrap, pinned for
 *    BOTH new seams): without the authority set the two seams keep EXACTLY
 *    today's boundary — a well-formed credentialed probe answers the honest
 *    401 AUTHENTICATION_FAILED (the unbound authenticate seam precedes every
 *    capability), and an unauthenticated probe answers the honest 401
 *    missing-credential boundary. The composition facts keep today's exact
 *    unbound strings (the PPR-008 pins hold; the economics/analyzer routes
 *    never gain a different unbound shape).
 *  - THE MATERIALIZED SHAPE (no database contact): with the authority set
 *    present the composition constructs the REAL economics + analyzer
 *    authorities over the same relational DatabasePort (the pg pool is
 *    lazy), the payment rail is the IN-REPO simulated rail under its honest
 *    id, the composition facts report BOTH new authorities truthfully
 *    (derived — the economics service, the simulated-rail disclosure, the
 *    deterministic analyzer), the route table stays the identical pinned
 *    surface, and every credentialed probe to the new seams FAILS CLOSED
 *    (502 PROVIDER_ERROR) while the cold-start seeding cannot complete —
 *    never a fabricated success.
 *  - THE SIMULATED-RAIL DISCLOSURE (pure — the honest label the module's
 *    own contract carries): a charge through the rail constructed with the
 *    preview's rail id settles with `evidence.simulated: true`, the
 *    rail-transaction reference names the rail (`sim:<railId>:<n>`), the
 *    constraint surface the economics service fail-closes on is fully
 *    declared, and rail-side idempotency converges same-key retries on the
 *    same durable observation.
 *  - THE SEED DESIGN (pure): the wallet idempotency keys are deterministic
 *    pure functions of the preview application id (every cold start
 *    replays, never re-credits) and the grant amount is the recorded
 *    constant.
 */

import { afterAll, describe, expect, test } from "vitest";
import { buildBootstrapApp } from "../../../deploy/api";
import {
  PREVIEW_PAYMENT_RAIL_ID,
  PREVIEW_WALLET_GRANT_MICRO_USD,
  previewWalletFundingKey,
  previewWalletGrantKey,
} from "../../../deploy/preview-authorities";
import { createSimulatedPaymentRail } from "../../../src/integrations/payment-rails/public";
import type { RailPaymentRequest } from "../../../src/modules/economics/public";

const APPLICATION_ID = "0d0e0f10-1112-1314-1516-1718191a1b1c";

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

/** A well-formed create body for POST /economic-actions (a real intent shape). */
function economicActionBody(executionId: string): string {
  return JSON.stringify({
    applicationId: APPLICATION_ID,
    executionId,
    purpose: "purchase",
    recipient: { kind: "merchant", id: "merchant-42" },
    amount: { kind: "range", minMicroUsd: "1000", maxMicroUsd: "2000" },
    currency: "usd",
    expiresAt: "2030-01-01T00:00:00.000Z",
    requiredCapabilities: [],
  });
}

/** A well-formed selected-subgraph body for POST /codebase-analysis. */
function codebaseAnalysisBody(): string {
  const repository = "github.com/example/customer-app";
  const revision = "commit-abc123";
  return JSON.stringify({
    applicationId: APPLICATION_ID,
    source: { repository, revision },
    subgraph: {
      nodes: [
        {
          nodeId: "llm-1",
          kind: "model-call",
          label: "classifyTicket",
          provenance: { repository, revision, file: "src/support/classify.ts" },
          observation: {
            executionCount: 40,
            errorRate: 0.02,
            inputVariability: "low",
            semanticComplexity: "low",
            distinctInputCount: 5,
            distinctOutputCount: 5,
            verificationPassCount: 38,
            verificationFailCount: 2,
            observedCostMicroUsd: "12000",
            observedLatencyMs: 900,
            evidenceRefs: ["execution:1:receipt"],
          },
        },
      ],
      edges: [],
    },
  });
}

// ---------------------------------------------------------------------------
// The unmaterialized shape: BOTH new seams keep exactly today's boundary
// ---------------------------------------------------------------------------

describe("PPR-014: the unmaterialized shape keeps today's honest unbound boundary (both new seams)", () => {
  const UNBOUND_ENV = {
    ZECK_PG_ADMIN_URL: undefined,
    ZECK_TRANSPORT_TOKEN: undefined,
    ZECK_PREVIEW_APPLICATION_ID: undefined,
  };

  test("a credentialed economic-action create answers the honest 401 of the unbound composition", async () => {
    await withLocalMaterialization(UNBOUND_ENV, async () => {
      const app = track(buildBootstrapApp({ environment: "local" }));
      expect(app.previewAuthorities).toBeUndefined();
      const response = await app.server.app.inject({
        method: "POST",
        url: "/economic-actions",
        headers: {
          authorization: "Bearer ppr-014-unbound-probe",
          "content-type": "application/json",
          "idempotency-key": "ppr-014-unbound-econ-1",
        },
        payload: economicActionBody("00000000-0000-0000-0000-000000000001"),
      });
      expect(response.statusCode).toBe(401);
      const body = response.json<{ code?: string; message?: string }>();
      expect(body.code).toBe("AUTHENTICATION_FAILED");
      expect(body.message).toContain("no transport credential is bound");
    });
  });

  test("unauthenticated economic-action reads answer the honest missing-credential 401", async () => {
    await withLocalMaterialization(UNBOUND_ENV, async () => {
      const app = track(buildBootstrapApp({ environment: "local" }));
      const response = await app.server.app.inject({
        method: "GET",
        url: "/economic-actions/00000000-0000-0000-0000-000000000001",
        headers: { "x-zeck-application": APPLICATION_ID },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json<{ code?: string }>().code).toBe("AUTHENTICATION_FAILED");
    });
  });

  test("a credentialed codebase-analysis create answers the honest 401 of the unbound composition", async () => {
    await withLocalMaterialization(UNBOUND_ENV, async () => {
      const app = track(buildBootstrapApp({ environment: "local" }));
      const response = await app.server.app.inject({
        method: "POST",
        url: "/codebase-analysis",
        headers: {
          authorization: "Bearer ppr-014-unbound-probe",
          "content-type": "application/json",
          "idempotency-key": "ppr-014-unbound-analysis-1",
        },
        payload: codebaseAnalysisBody(),
      });
      expect(response.statusCode).toBe(401);
      const body = response.json<{ code?: string; message?: string }>();
      expect(body.code).toBe("AUTHENTICATION_FAILED");
      expect(body.message).toContain("no transport credential is bound");
    });
  });

  test("the composition facts keep exactly today's unbound strings (nothing about the new seams leaks)", async () => {
    await withLocalMaterialization(UNBOUND_ENV, () => {
      const app = track(buildBootstrapApp({ environment: "local" }));
      expect(app.composition.domainCapabilities).toBe(
        "unbound (honest CAPABILITY_UNAVAILABLE / AUTHENTICATION_FAILED)",
      );
      expect(app.composition.authorityMaterialization).toBe(
        "unmaterialized (ZECK_PG_ADMIN_URL, ZECK_TRANSPORT_TOKEN, ZECK_PREVIEW_APPLICATION_ID absent — exactly the honest unbound bootstrap shape; local/dev behavior unchanged)",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// The materialized shape (no database contact): the new authorities bind
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

describe("PPR-014: the materialized shape binds the economics + codebase-analysis authorities", () => {
  // An unreachable relational endpoint: the pool is constructed lazily, the
  // cold-start seeding fails fast (connection refused), and every bound seam
  // fails CLOSED — never a fabricated success.
  const UNREACHABLE_URL = "postgres://zeck@127.0.0.1:9/postgres";
  const MATERIALIZED_ENV = {
    ZECK_PG_ADMIN_URL: UNREACHABLE_URL,
    ZECK_TRANSPORT_TOKEN: "ppr-014-materialized-probe-token",
    ZECK_PREVIEW_APPLICATION_ID: APPLICATION_ID,
  };

  test("the composition constructs the REAL economics authority + the simulated rail + the analyzer", async () => {
    await withLocalMaterialization(MATERIALIZED_ENV, () => {
      const app = track(buildBootstrapApp({ environment: "local" }));
      const authorities = app.previewAuthorities;
      expect(authorities).toBeDefined();
      // The economics authority: the REAL service over the SQL fabric.
      expect(authorities?.economics).toBeDefined();
      expect(typeof authorities?.economics.createEconomicAction).toBe("function");
      expect(typeof authorities?.economics.authorizeEconomicAction).toBe("function");
      expect(typeof authorities?.economics.chargeEconomicAction).toBe("function");
      // The payment rail: the IN-REPO simulated rail under its honest id.
      expect(authorities?.paymentRail.railId).toBe(PREVIEW_PAYMENT_RAIL_ID);
      expect(authorities?.paymentRail.capabilities).toEqual({
        pinsRecipient: true,
        enforcesAmountCeiling: true,
        pinsCurrency: true,
        enforcesExpiry: true,
      });
      // The analyzer: the deterministic advisory authority.
      expect(authorities?.codebaseAnalyzer).toBeDefined();
      expect(typeof authorities?.codebaseAnalyzer.analyzeSubgraph).toBe("function");
      // The route table is STILL the identical pinned public surface.
      const routes = app.server.routes.map((route) => `${route.method} ${route.url}`).sort();
      expect(routes).toEqual(PUBLIC_ROUTE_TABLE);
    });
  });

  test("the composition facts report both new authorities truthfully (derived, never hardcoded)", async () => {
    await withLocalMaterialization(MATERIALIZED_ENV, () => {
      const app = track(buildBootstrapApp({ environment: "local" }));
      expect(app.composition.domainCapabilities).toContain("materialized");
      expect(app.composition.domainCapabilities).toContain("economic-action service");
      expect(app.composition.domainCapabilities).toContain(
        "codebase-analysis opportunity analyzer",
      );
      expect(app.composition.authorityMaterialization).toContain("materialized");
      expect(app.composition.authorityMaterialization).toContain("ZECK_TRANSPORT_TOKEN");
      // The truthful new-authority facts: the funded wallet, the simulated
      // rail disclosure, the deterministic analyzer.
      expect(app.composition.authorityMaterialization).toContain("funded developer wallet");
      expect(app.composition.authorityMaterialization).toContain("simulated payment rail");
      expect(app.composition.authorityMaterialization).toContain("no external payment provider");
      expect(app.composition.authorityMaterialization).toContain("deterministic advisory analysis");
      expect(app.composition.authorityMaterialization).toContain("no model behind either");
    });
  });

  test("credentialed probes to the new seams fail closed while the seeding cannot complete", async () => {
    await withLocalMaterialization(MATERIALIZED_ENV, async () => {
      const app = track(buildBootstrapApp({ environment: "local" }));
      // The economic-action create: a credentialed probe reaches the seeding
      // gate through the authenticate seam and fails the honest closed way.
      const economic = await app.server.app.inject({
        method: "POST",
        url: "/economic-actions",
        headers: {
          authorization: "Bearer ppr-014-materialized-probe-token",
          "content-type": "application/json",
          "idempotency-key": "ppr-014-failclosed-econ-1",
        },
        payload: economicActionBody("00000000-0000-0000-0000-000000000001"),
      });
      expect(economic.statusCode).toBe(502);
      const econBody = economic.json<{ code?: string; message?: string }>();
      expect(econBody.code).toBe("PROVIDER_ERROR");
      expect(econBody.message).toContain("the preview authorities are unavailable");

      // The codebase-analysis create: the same honest fail-closed gate (the
      // subgraph pre-validation is pure and passes; the identity resolution
      // hits the gate).
      const analysis = await app.server.app.inject({
        method: "POST",
        url: "/codebase-analysis",
        headers: {
          authorization: "Bearer ppr-014-materialized-probe-token",
          "content-type": "application/json",
          "idempotency-key": "ppr-014-failclosed-analysis-1",
        },
        payload: codebaseAnalysisBody(),
      });
      expect(analysis.statusCode).toBe(502);
      expect(analysis.json<{ code?: string }>().code).toBe("PROVIDER_ERROR");
    });
  });
});

// ---------------------------------------------------------------------------
// The simulated-rail disclosure (pure — the module contract's own honesty)
// ---------------------------------------------------------------------------

describe("PPR-014: the simulated-rail disclosure (the honest label, no database)", () => {
  test("a charge settles with the simulated evidence + the rail-named transaction reference", async () => {
    const rail = createSimulatedPaymentRail({ railId: PREVIEW_PAYMENT_RAIL_ID });
    const request: RailPaymentRequest = {
      idempotencyKey: "ppr-014-rail-disclosure-1",
      economicActionId: "00000000-0000-0000-0000-0000000000e1",
      authorizationId: "00000000-0000-0000-0000-0000000000a1",
      correlationRef: "correlation-1",
      recipient: { kind: "merchant", id: "merchant-42" },
      purpose: "purchase",
      amountMicroUsd: "150000",
      currency: "usd",
      expiresAt: "2030-01-01T00:00:00.000Z",
    };
    const observation = await rail.charge(request);
    // THE DISCLOSURE: the rail's own contract carries the simulated fact.
    expect(observation.railId).toBe(PREVIEW_PAYMENT_RAIL_ID);
    expect(observation.status).toBe("succeeded");
    expect(observation.settledAmountMicroUsd).toBe("150000");
    expect(observation.railTransactionRef).toBe(`sim:${PREVIEW_PAYMENT_RAIL_ID}:1`);
    expect(observation.evidence).toMatchObject({ simulated: true });
    // Rail-side idempotency: a same-key retry converges on the SAME durable
    // observation with NO second charge.
    const retry = await rail.charge(request);
    expect(retry).toEqual(observation);
    expect(rail.charges).toHaveLength(1);
  });

  test("the rail's honest failure path settles FAILED with zero settled amount (the platform's failure exercisable)", async () => {
    const rail = createSimulatedPaymentRail({
      railId: PREVIEW_PAYMENT_RAIL_ID,
      failAllCharges: true,
    });
    const request: RailPaymentRequest = {
      idempotencyKey: "ppr-014-rail-failure-1",
      economicActionId: "00000000-0000-0000-0000-0000000000e2",
      authorizationId: "00000000-0000-0000-0000-0000000000a2",
      correlationRef: "correlation-2",
      recipient: { kind: "merchant", id: "merchant-42" },
      purpose: "purchase",
      amountMicroUsd: "150000",
      currency: "usd",
      expiresAt: "2030-01-01T00:00:00.000Z",
    };
    const observation = await rail.charge(request);
    expect(observation.status).toBe("failed");
    expect(observation.settledAmountMicroUsd).toBe("0");
    expect(observation.evidence).toMatchObject({ simulated: true });
  });
});

// ---------------------------------------------------------------------------
// The seed design (pure — deterministic, honestly recorded)
// ---------------------------------------------------------------------------

describe("PPR-014: the wallet seed design is deterministic and honestly recorded", () => {
  test("the wallet idempotency keys are pure functions of the preview application id", () => {
    expect(previewWalletFundingKey(APPLICATION_ID)).toBe(previewWalletFundingKey(APPLICATION_ID));
    expect(previewWalletGrantKey(APPLICATION_ID)).toBe(previewWalletGrantKey(APPLICATION_ID));
    expect(previewWalletFundingKey(APPLICATION_ID)).toBe(
      `preview-wallet-funding:${APPLICATION_ID}`,
    );
    expect(previewWalletGrantKey(APPLICATION_ID)).toBe(`preview-wallet-grant:${APPLICATION_ID}`);
    // A different application id yields different keys (no cross-application
    // arbitration collision).
    const other = "00000000-0000-4000-8000-000000000001";
    expect(previewWalletFundingKey(other)).not.toBe(previewWalletFundingKey(APPLICATION_ID));
    expect(previewWalletGrantKey(other)).not.toBe(previewWalletGrantKey(APPLICATION_ID));
    // The two operations of one seeding never share a key.
    expect(previewWalletFundingKey(APPLICATION_ID)).not.toBe(previewWalletGrantKey(APPLICATION_ID));
  });

  test("the grant amount is the recorded constant (micro-USD, $10)", () => {
    expect(PREVIEW_WALLET_GRANT_MICRO_USD).toBe("10000000");
    expect(/^\d+$/.test(PREVIEW_WALLET_GRANT_MICRO_USD)).toBe(true);
  });
});
