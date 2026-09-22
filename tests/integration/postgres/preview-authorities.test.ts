/**
 * Real-PG: PPR-008 — the preview authority materialization + the
 * deterministic sandbox substrate over the REAL relational rail.
 *
 * THE ORDER'S CORE PROOF (the work order's verification battery):
 *  - the SEEDING's runtime idempotency: run twice → the SAME rows (the
 *    deterministic identities converge), and CONCURRENT seedings (the
 *    concurrent-isolate cold-start shape) converge on one row set through
 *    the schema's guarded-insert arbitration;
 *  - the DEPLOYED materialized composition end-to-end: the transport token
 *    authenticates (wrong tokens fail 401), a credentialed create is driven
 *    by the deterministic substrate to an honest TERMINAL receipt through
 *    the execution service's own state machine, an idempotent REPLAY
 *    returns the same execution without duplicating a single ledger
 *    envelope, and every inspection surface (execution / events /
 *    verification / results — the API plane's machine-view export) answers
 *    the real wire shapes with the honest substrate labels;
 *  - the credential lifecycle over the materialized authority: the list is
 *    live over SQL, the issuance gate is honestly closed (the read-only
 *    environment materialization) and says so through the honest 422, and
 *    REVOCATION of the transport credential genuinely disables the token
 *    (the durable row governs authentication);
 *  - the ISSUANCE-CAPABLE composition (the credentials-world pattern: the
 *    same SQL authorities with an issuance-capable secret store): issue →
 *    authenticate with the ISSUED secret → create → the substrate drives it
 *    to terminal → the inspection surfaces answer; rotation retires the
 *    predecessor (the old secret stops authenticating) and the successor
 *    secret works.
 *
 * Skips with an explicit reason when ZECK_PG_TEST_URL is unset (the
 * credentialed re-run is the Lead's — recorded honestly).
 */

import { afterAll, expect, test } from "vitest";
import { buildBootstrapApp } from "../../../deploy/api";
import {
  buildPreviewAuthorities,
  previewSeedPlanOf,
  seedPreviewAuthorities,
} from "../../../deploy/preview-authorities";
import {
  createDeterministicSubstrateExecutions,
  SUBSTRATE_METADATA_KEY,
  SUBSTRATE_ORIGIN,
} from "../../../deploy/preview-substrate";
import { createApiServer, createBearerTokenAuthenticator } from "../../../src/api";
import { InMemoryCredentialSecretStore } from "../../../src/modules/auth/public";
import { PlatformError } from "../../../src/shared/errors";
import { uuidv7 } from "../../../src/shared/ids";
import type { PgContext } from "./harness";
import { definePgSuite } from "./harness";

const APPLICATION_ID = uuidv7();
const TRANSPORT_TOKEN = `zeck-ppr008-transport-${uuidv7()}`;

/** The composition's materialization variables (set/restored around builds). */
const MATERIALIZATION_VARIABLES: readonly string[] = [
  "ZECK_PG_ADMIN_URL",
  "ZECK_TRANSPORT_TOKEN",
  "ZECK_PREVIEW_APPLICATION_ID",
];

/** The test database's URL (the harness's own pool target). */
function testDatabaseUrl(ctx: PgContext): string {
  return `${ctx.adminUrl.replace(/\/[^/]*$/, "")}/${ctx.databaseName}`;
}

async function withMaterialization(
  ctx: PgContext,
  overrides: Readonly<Record<string, string | undefined>>,
  body: () => Promise<void> | void,
): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const key of MATERIALIZATION_VARIABLES) {
    previous[key] = process.env[key];
  }
  process.env.ZECK_PG_ADMIN_URL = testDatabaseUrl(ctx);
  process.env.ZECK_TRANSPORT_TOKEN = TRANSPORT_TOKEN;
  process.env.ZECK_PREVIEW_APPLICATION_ID = APPLICATION_ID;
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

const closers: {
  readonly server?: { readonly app: { close(): Promise<void> } };
  readonly close?: () => Promise<void>;
}[] = [];

afterAll(async () => {
  for (const entry of closers) {
    await entry.close?.();
    await entry.server?.app.close();
  }
});

definePgSuite("the preview authority materialization over real PostgreSQL", (ctx) => {
  test("the seeding is runtime-idempotent: run twice → the same rows; concurrent seedings converge", async () => {
    const db = ctx.port;
    const plan = previewSeedPlanOf(APPLICATION_ID, "local");
    await seedPreviewAuthorities(db, plan);
    await seedPreviewAuthorities(db, plan);
    // The concurrent-isolate cold-start shape: four simultaneous seedings.
    await Promise.all([
      seedPreviewAuthorities(db, plan),
      seedPreviewAuthorities(db, plan),
      seedPreviewAuthorities(db, plan),
      seedPreviewAuthorities(db, plan),
    ]);

    const tenants = await db.execute<{ n: string }>({
      sql: "SELECT count(*)::text AS n FROM applications.tenants WHERE id = $1",
      parameters: [plan.tenantId],
    });
    expect(tenants.rows[0]?.n).toBe("1");
    const applications = await db.execute<{ tenant_id: string }>({
      sql: "SELECT tenant_id FROM applications.applications WHERE id = $1",
      parameters: [plan.applicationId],
    });
    expect(applications.rows[0]?.tenant_id).toBe(plan.tenantId);
    const actors = await db.execute<{ n: string }>({
      sql: "SELECT count(*)::text AS n FROM identity.actors WHERE id IN ($1, $2)",
      parameters: [plan.transportActorId, plan.substrateActorId],
    });
    expect(actors.rows[0]?.n).toBe("2");
    const memberships = await db.execute<{ n: string }>({
      sql: `SELECT count(*)::text AS n FROM identity.memberships
            WHERE application_id = $1 AND actor_id IN ($2, $3)`,
      parameters: [plan.applicationId, plan.transportActorId, plan.substrateActorId],
    });
    expect(memberships.rows[0]?.n).toBe("2");
    const credentials = await db.execute<{
      credential_id: string;
      status: string;
      secret_reference: string;
      label: string;
    }>({
      sql: `SELECT credential_id::text AS credential_id, status, secret_reference, label
            FROM identity.application_credentials WHERE credential_id = $1`,
      parameters: [plan.transportCredentialId],
    });
    expect(credentials.rows).toHaveLength(1);
    const row = credentials.rows[0];
    expect(row?.credential_id).toBe(plan.transportCredentialId);
    expect(row?.status).toBe("active");
    expect(row?.secret_reference).toBe("zeck-secret://local/transport-token");
    expect(row?.label).toBe("Preview transport credential");
  });

  test("the materialized composition: the transport token authenticates and the substrate drives a credentialed create to an honest terminal receipt", async () => {
    await withMaterialization(ctx, {}, async () => {
      const app = buildBootstrapApp({ environment: "local" });
      closers.push({
        server: app.server,
        close: async () => {
          await app.previewAuthorities?.close();
        },
      });
      const ready = await app.previewAuthorities?.ready;
      expect(ready?.ok).toBe(true);
      expect(app.composition.authorityMaterialization).toContain("materialized");

      // A wrong token fails the honest 401 (the bearer boundary).
      const wrongToken = await app.server.app.inject({
        method: "POST",
        url: "/executions",
        headers: {
          authorization: "Bearer not-the-materialized-token",
          "content-type": "application/json",
          "idempotency-key": "ppr008-wrong-token-1",
        },
        payload: JSON.stringify({
          applicationId: APPLICATION_ID,
          task: { kind: "summarize", doc: "quarterly-report-01", maxWords: 60 },
        }),
      });
      expect(wrongToken.statusCode).toBe(401);
      expect(wrongToken.json<{ code?: string }>().code).toBe("AUTHENTICATION_FAILED");

      // The credentialed create: the substrate drives it to terminal THROUGH
      // the service's own state machine — the create response IS the receipt.
      const created = await app.server.app.inject({
        method: "POST",
        url: "/executions",
        headers: {
          authorization: `Bearer ${TRANSPORT_TOKEN}`,
          "content-type": "application/json",
          "idempotency-key": "ppr008-create-1",
        },
        payload: JSON.stringify({
          applicationId: APPLICATION_ID,
          task: { kind: "summarize", doc: "quarterly-report-01", maxWords: 60 },
          metadata: { origin: "ppr-008-integration-proof", family: "text", sandbox: "disposable" },
        }),
      });
      expect(created.statusCode).toBe(201);
      const receipt = created.json<{
        executionId: string;
        status: string;
        replayed: boolean;
        lastEventSequence: number;
      }>();
      expect(receipt.status).toBe("COMPLETED");
      expect(receipt.replayed).toBe(false);
      expect(receipt.lastEventSequence).toBe(10);
      const executionId = receipt.executionId;

      // The idempotent replay: the same execution, no duplicated envelope.
      const replay = await app.server.app.inject({
        method: "POST",
        url: "/executions",
        headers: {
          authorization: `Bearer ${TRANSPORT_TOKEN}`,
          "content-type": "application/json",
          "idempotency-key": "ppr008-create-1",
        },
        payload: JSON.stringify({
          applicationId: APPLICATION_ID,
          task: { kind: "summarize", doc: "quarterly-report-01", maxWords: 60 },
          metadata: { origin: "ppr-008-integration-proof", family: "text", sandbox: "disposable" },
        }),
      });
      expect(replay.statusCode).toBe(201);
      const replayReceipt = replay.json<{
        executionId: string;
        status: string;
        replayed: boolean;
      }>();
      expect(replayReceipt.executionId).toBe(executionId);
      expect(replayReceipt.status).toBe("COMPLETED");
      expect(replayReceipt.replayed).toBe(true);

      // The inspection surfaces (the API plane's machine-view export: the
      // ordered ledger + verification + the result package).
      const headers = {
        authorization: `Bearer ${TRANSPORT_TOKEN}`,
        "x-zeck-application": APPLICATION_ID,
      };
      const execution = await app.server.app.inject({
        method: "GET",
        url: `/executions/${executionId}`,
        headers,
      });
      expect(execution.statusCode).toBe(200);
      const executionBody = execution.json<{
        status: string;
        terminalAt: string | null;
        metadata: Record<string, string>;
      }>();
      expect(executionBody.status).toBe("COMPLETED");
      expect(executionBody.terminalAt).not.toBeNull();
      expect(executionBody.metadata[SUBSTRATE_METADATA_KEY]).toBe(SUBSTRATE_ORIGIN);
      expect(executionBody.metadata.origin).toBe("ppr-008-integration-proof");

      const events = await app.server.app.inject({
        method: "GET",
        url: `/executions/${executionId}/events`,
        headers,
      });
      expect(events.statusCode).toBe(200);
      const eventList = events.json<{ sequence: number; type: string; cause: string | null }[]>();
      expect(eventList.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(eventList.map((event) => event.type)).toEqual([
        "execution.created",
        "execution.authorize",
        "execution.plan",
        "planning.decision-recorded",
        "execution.queue",
        "execution.start",
        "execution.sandbox-admitted",
        "execution.sandbox-completed",
        "execution.verify",
        "execution.pass",
      ]);
      // The provenance (cause + actor) lives on the DOMAIN ledger — the
      // wire event projection carries the payload facts; both asserted.
      const ledger =
        (await app.previewAuthorities?.executions.listEvents(APPLICATION_ID, executionId)) ?? [];
      for (const envelope of ledger.slice(1)) {
        if (envelope.type !== "planning.decision-recorded") {
          expect(envelope.cause).toBe(SUBSTRATE_ORIGIN);
        }
        expect(envelope.actor).toEqual({
          actorId: app.previewAuthorities?.seed.substrateActorId,
          tenantId: app.previewAuthorities?.tenantId,
        });
      }
      expect(ledger[0]?.cause).toBeNull();
      // The domain ledger keeps the TRUE usage facts (zero tokens).
      const ledgerCompleted = ledger.find(
        (envelope) => envelope.type === "execution.sandbox-completed",
      );
      expect(ledgerCompleted?.payload).toMatchObject({
        origin: SUBSTRATE_ORIGIN,
        costMicroUsd: "0",
        usage: { inputTokens: 0, outputTokens: 0 },
        modelBacked: false,
      });
      const sandboxCompleted = events
        .json<{ type: string; payload: Record<string, unknown> }[]>()
        .find((event) => event.type === "execution.sandbox-completed");
      expect(sandboxCompleted?.payload).toMatchObject({
        origin: SUBSTRATE_ORIGIN,
        costMicroUsd: "0",
        modelBacked: false,
        // The scrub guard's defense-in-depth breadth: token-shaped KEYS are
        // redacted on the WIRE projection (inputTokens/outputTokens match
        // the guard's /token/i pattern); the durable ledger keeps the true
        // zero values (asserted above) — never a fabricated number.
        usage: { inputTokens: "[redacted]", outputTokens: "[redacted]" },
      });

      const verification = await app.server.app.inject({
        method: "GET",
        url: `/executions/${executionId}/verification`,
        headers,
      });
      expect(verification.statusCode).toBe(200);
      const results =
        verification.json<
          {
            status: string;
            strategy: string;
            evaluator: { kind: string; id: string; version: string };
          }[]
        >();
      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe("PASS");
      expect(results[0]?.strategy).toBe(SUBSTRATE_ORIGIN);
      // The wire projection carries the recorder as the evaluator identity.
      expect(results[0]?.evaluator).toEqual({
        kind: "recorded-by",
        id: SUBSTRATE_ORIGIN,
        version: "1",
      });

      const result = await app.server.app.inject({
        method: "GET",
        url: `/executions/${executionId}/results`,
        headers,
      });
      expect(result.statusCode).toBe(200);
      const resultBody = result.json<{
        status: string;
        route: {
          provider: string | null;
          model: string | null;
          strategyClass: string | null;
          modelCalls: number;
        };
        verification: unknown[];
        warnings: string[];
        cost: unknown;
        terminalAt: string | null;
      }>();
      expect(resultBody.status).toBe("COMPLETED");
      expect(resultBody.route).toEqual({
        provider: null,
        model: null,
        strategyClass: "deterministic-only",
        modelCalls: 0,
      });
      expect(resultBody.verification).toHaveLength(1);
      expect(resultBody.warnings).toEqual([]);
      // The honest no-settled-facts projection: cost stays null (never a
      // fabricated number) — the substrate's zero-cost facts live on the
      // ledger's sandbox-completed envelope (asserted above).
      expect(resultBody.cost).toBeNull();

      // Terminal finality through the honest 409.
      const cancel = await app.server.app.inject({
        method: "POST",
        url: `/executions/${executionId}/cancel`,
        headers: { ...headers, "idempotency-key": "ppr008-cancel-1" },
        payload: {},
      });
      expect(cancel.statusCode).toBe(409);
      expect(cancel.json<{ code?: string }>().code).toBe("INVALID_STATE_TRANSITION");
    });
  });

  test("the credential lifecycle over the materialized authority: list live, issuance gate honestly closed, revocation disables the token", async () => {
    const applicationId = uuidv7();
    const transportToken = `zeck-ppr008-transport-${uuidv7()}`;
    await withMaterialization(
      ctx,
      {
        ZECK_TRANSPORT_TOKEN: transportToken,
        ZECK_PREVIEW_APPLICATION_ID: applicationId,
      },
      async () => {
        const app = buildBootstrapApp({ environment: "local" });
        closers.push({
          server: app.server,
          close: async () => {
            await app.previewAuthorities?.close();
          },
        });
        const ready = await app.previewAuthorities?.ready;
        expect(ready?.ok).toBe(true);
        const plan = app.previewAuthorities?.seed;
        expect(plan).toBeDefined();
        const headers = {
          authorization: `Bearer ${transportToken}`,
          "x-zeck-application": applicationId,
        };

        // The list is live over SQL: the seeded transport credential row.
        const list = await app.server.app.inject({
          method: "GET",
          url: "/credentials",
          headers,
        });
        expect(list.statusCode).toBe(200);
        const listBody = list.json<{
          credentials: { id: string; status: string; label: string; credentialId: string }[];
          issuance: { enabled: boolean };
        }>();
        expect(listBody.credentials).toHaveLength(1);
        expect(listBody.credentials[0]?.credentialId).toBe(plan?.transportCredentialId);
        expect(listBody.credentials[0]?.status).toBe("active");
        expect(listBody.credentials[0]?.label).toBe("Preview transport credential");
        expect(listBody.issuance.enabled).toBe(false);

        // The issuance gate: the honest 422 (the read-only environment
        // materialization can never hold issued material).
        const issue = await app.server.app.inject({
          method: "POST",
          url: "/credentials",
          headers: {
            ...headers,
            "idempotency-key": "ppr008-issue-1",
            "content-type": "application/json",
          },
          payload: JSON.stringify({ applicationId, label: "gate probe", role: "member" }),
        });
        expect(issue.statusCode).toBe(422);
        const issueBody = issue.json<{ code?: string; message?: string }>();
        expect(issueBody.code).toBe("CAPABILITY_UNAVAILABLE");
        expect(issueBody.message).toContain("issuance is not enabled");

        // REVOCATION genuinely disables the token: the durable row governs.
        const revoke = await app.server.app.inject({
          method: "POST",
          url: `/credentials/${plan?.transportCredentialId}/revoke`,
          headers: { ...headers, "idempotency-key": "ppr008-revoke-1" },
          payload: {},
        });
        expect(revoke.statusCode).toBe(200);
        expect(revoke.json<{ credential: { status: string } }>().credential.status).toBe("revoked");

        const afterRevoke = await app.server.app.inject({
          method: "POST",
          url: "/executions",
          headers: {
            authorization: `Bearer ${transportToken}`,
            "content-type": "application/json",
            "idempotency-key": "ppr008-after-revoke-1",
          },
          payload: JSON.stringify({
            applicationId,
            task: { kind: "summarize", doc: "probe" },
          }),
        });
        expect(afterRevoke.statusCode).toBe(401);
        expect(afterRevoke.json<{ code?: string }>().code).toBe("AUTHENTICATION_FAILED");
      },
    );
  });

  test("the issuance-capable composition: issue → authenticate with the issued secret → create → substrate to terminal → surfaces; rotation works", async () => {
    const secretStore = new InMemoryCredentialSecretStore();
    const applicationId = uuidv7();
    const transportToken = `zeck-ppr008-transport-${uuidv7()}`;
    await withMaterialization(
      ctx,
      {
        ZECK_TRANSPORT_TOKEN: transportToken,
        ZECK_PREVIEW_APPLICATION_ID: applicationId,
      },
      async () => {
        // The SAME authorities construction with the issuance-capable secret
        // store (the credentials-world pattern — the one composition
        // difference: a secret store that can hold issued material).
        const authorities = buildPreviewAuthorities({
          environment: "local",
          databaseUrl: testDatabaseUrl(ctx),
          transportToken,
          applicationId,
          credentialSecretStore: secretStore,
          issuanceEnabled: true,
        });
        closers.push({ close: () => authorities.close() });
        const ready = await authorities.ready;
        expect(ready.ok).toBe(true);
        expect(authorities.credentials.issuanceEnabled()).toBe(true);

        // The test-local authenticator for ISSUED credentials: a presented
        // token resolves to the preview principal iff the credential row
        // holding its material is ACTIVE (rotation/revocation effects ride
        // the durable row; the material introspection is the in-memory
        // store's sanctioned test surface).
        const resolveIssuedPrincipal = async (
          token: string,
        ): Promise<{ actorId: string } | null> => {
          for (const reference of secretStore.references()) {
            if (secretStore.materialOf(reference) === token) {
              const found = await ctx.port.execute<{ status: string }>({
                sql: `SELECT status FROM identity.application_credentials
                      WHERE secret_reference = $1 ORDER BY (status = 'active') DESC, created_at DESC
                      LIMIT 1`,
                parameters: [reference],
              });
              const row = found.rows[0];
              return row?.status === "active"
                ? { actorId: authorities.seed.transportActorId }
                : null;
            }
          }
          return null;
        };
        const authenticate = createBearerTokenAuthenticator(async (token) => {
          if (token === transportToken) {
            return { actorId: authorities.seed.transportActorId };
          }
          return resolveIssuedPrincipal(token);
        });

        const unbound = <T>(name: string): T =>
          new Proxy(
            {},
            {
              get() {
                throw new PlatformError({
                  code: "CAPABILITY_UNAVAILABLE",
                  message: `the ${name} capability is not bound in this test composition`,
                });
              },
            },
          ) as T;
        const server = createApiServer({
          executions: createDeterministicSubstrateExecutions({
            inner: authorities.executions,
            actor: authorities.substrateActor,
            generateId: authorities.generateId,
            now: authorities.now,
          }),
          agents: authorities.agents,
          economics: unbound("economics"),
          credentials: authorities.credentials,
          scopeResolver: authorities.scopeResolver,
          authenticate,
          listAgentIdsOfApplication: authorities.listAgentIdsOfApplication,
          codebaseAnalyzer: unbound("codebaseAnalyzer"),
          dependencyReadiness: async () => [],
        });
        closers.push({ server, close: () => authorities.close() });

        // ISSUE with the transport credential (the real lifecycle over SQL).
        const issue = await server.app.inject({
          method: "POST",
          url: "/credentials",
          headers: {
            authorization: `Bearer ${transportToken}`,
            "x-zeck-application": applicationId,
            "idempotency-key": "ppr008-issue-capable-1",
            "content-type": "application/json",
          },
          payload: JSON.stringify({ applicationId, label: "issued by the proof", role: "member" }),
        });
        expect(issue.statusCode).toBe(201);
        const issued = issue.json<{
          credential: { credentialId: string; status: string };
          secret: string | null;
          replayed: boolean;
        }>();
        expect(issued.secret).toMatch(/^zeck-/);
        expect(issued.replayed).toBe(false);
        expect(issued.credential.status).toBe("active");
        const issuedSecret = issued.secret as string;

        // AUTHENTICATE with the issued secret → create → the substrate
        // drives it to terminal → the surfaces answer.
        const created = await server.app.inject({
          method: "POST",
          url: "/executions",
          headers: {
            authorization: `Bearer ${issuedSecret}`,
            "content-type": "application/json",
            "idempotency-key": "ppr008-issued-create-1",
          },
          payload: JSON.stringify({
            applicationId,
            task: { kind: "summarize", doc: "issued-credential-probe" },
          }),
        });
        expect(created.statusCode).toBe(201);
        const receipt = created.json<{ executionId: string; status: string }>();
        expect(receipt.status).toBe("COMPLETED");
        const headers = {
          authorization: `Bearer ${issuedSecret}`,
          "x-zeck-application": applicationId,
        };
        const events = await server.app.inject({
          method: "GET",
          url: `/executions/${receipt.executionId}/events`,
          headers,
        });
        expect(events.statusCode).toBe(200);
        expect(events.json<{ type: string }[]>().map((event) => event.type)).toContain(
          "execution.sandbox-completed",
        );
        const verification = await server.app.inject({
          method: "GET",
          url: `/executions/${receipt.executionId}/verification`,
          headers,
        });
        expect(verification.statusCode).toBe(200);
        expect(verification.json<{ status: string }[]>()[0]?.status).toBe("PASS");

        // ROTATION: the predecessor is retired (its secret stops
        // authenticating); the successor secret works end-to-end.
        const rotate = await server.app.inject({
          method: "POST",
          url: `/credentials/${issued.credential.credentialId}/rotate`,
          headers: { ...headers, "idempotency-key": "ppr008-rotate-1" },
          payload: {},
        });
        expect(rotate.statusCode).toBe(200);
        const rotated = rotate.json<{
          credential: { status: string };
          secret: string | null;
          replayed: boolean;
        }>();
        expect(rotated.secret).toMatch(/^zeck-/);
        expect(rotated.credential.status).toBe("active");
        const successorSecret = rotated.secret as string;

        const oldSecretCreate = await server.app.inject({
          method: "POST",
          url: "/executions",
          headers: {
            authorization: `Bearer ${issuedSecret}`,
            "content-type": "application/json",
            "idempotency-key": "ppr008-old-secret-1",
          },
          payload: JSON.stringify({
            applicationId,
            task: { kind: "summarize", doc: "predecessor-probe" },
          }),
        });
        expect(oldSecretCreate.statusCode).toBe(401);

        const successorCreate = await server.app.inject({
          method: "POST",
          url: "/executions",
          headers: {
            authorization: `Bearer ${successorSecret}`,
            "content-type": "application/json",
            "idempotency-key": "ppr008-successor-1",
          },
          payload: JSON.stringify({
            applicationId,
            task: { kind: "summarize", doc: "successor-probe" },
          }),
        });
        expect(successorCreate.statusCode).toBe(201);
        expect(successorCreate.json<{ status: string }>().status).toBe("COMPLETED");
      },
    );
  });
});
