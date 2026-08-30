/**
 * Real-PostgreSQL: end-to-end model dispatch on both rails (WORK-003,
 * CON-003 + CON-004; traceability "OpenRouter adapter integration/contract
 * test" and "multi-adapter routing test").
 *
 * The FULL fabric over a real database — SQL identity/resolver, SQL
 * connections + encrypted vault, SQL journal — with only the HTTP wire
 * replaced by a fixture transport. Proves: BYOK material travels from the
 * encrypted vault row to the correct provider header (bearer vs x-api-key)
 * through the gateway's materialization step; both rails coexist behind one
 * gateway; denials journal without dispatch; provider failures land as
 * durable provider-axis outcomes.
 */

import { expect, test } from "vitest";
import { createSqlAuthModule } from "../../../src/modules/auth/adapters/sql-identity-store";
import { createScopeResolver } from "../../../src/modules/auth/application/scope-resolver";
import {
  SqlConnectionStore,
  SqlConnectionsIdempotency,
} from "../../../src/modules/connections/adapters/sql-connection-store";
import {
  createTxCredentialVault,
  SqlCredentialVault,
} from "../../../src/modules/connections/adapters/sql-credential-vault";
import { createConnectionService } from "../../../src/modules/connections/application/connection-service";
import type { ConnectionService } from "../../../src/modules/connections/public";
import { createAnthropicAdapter } from "../../../src/modules/models/adapters/anthropic";
import { createOpenRouterAdapter } from "../../../src/modules/models/adapters/openrouter";
import { createSqlDispatchJournal } from "../../../src/modules/models/adapters/sql-dispatch-journal";
import type { ModelGateway } from "../../../src/modules/models/application/model-gateway";
import { createModelGateway } from "../../../src/modules/models/application/model-gateway";
import { createRailRegistry } from "../../../src/modules/models/application/rail-registry";
import type {
  HttpRequestBody,
  HttpResponse,
  HttpTransport,
} from "../../../src/modules/models/ports/http-transport";
import { textResponse } from "../../../src/modules/models/ports/http-transport";
import {
  createEnvelopeCipher,
  generateMasterKey,
} from "../../../src/platform/crypto/envelope-cipher";
import type { DatabasePort, Transaction } from "../../../src/platform/db/port";
import { PlatformError } from "../../../src/shared/errors";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { definePgSuite, type PgContext } from "./harness";

const generateId = createUuidv7Generator();

const OPENROUTER_BODY = {
  id: "gen-1",
  choices: [
    { index: 0, message: { role: "assistant", content: "rail answer" }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, cost: 0.002 },
};
const ANTHROPIC_BODY = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "direct answer" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 5, output_tokens: 3 },
};

/** Fixture transport: replays per-URL wire bodies and records every request. */
class FixtureTransport implements HttpTransport {
  requests: HttpRequestBody[] = [];
  async send(request: HttpRequestBody): Promise<HttpResponse> {
    this.requests.push(request);
    if (request.url.includes("openrouter") || request.url.includes("gw.customer.example")) {
      return textResponse(200, JSON.stringify(OPENROUTER_BODY));
    }
    if (request.url.includes("anthropic")) {
      return textResponse(200, JSON.stringify(ANTHROPIC_BODY));
    }
    return textResponse(500, JSON.stringify({ error: { code: "500", message: "unmapped" } }));
  }
}

interface DispatchWorld {
  readonly db: DatabasePort;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly ownerId: string;
  readonly connections: ConnectionService;
  readonly gateway: ModelGateway;
  readonly transport: FixtureTransport;
  readonly vault: SqlCredentialVault;
}

async function seedDispatchWorld(db: DatabasePort, allow: boolean): Promise<DispatchWorld> {
  const tenantId = generateId();
  const applicationId = generateId();
  const ownerId = generateId();
  await db.execute({
    sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
    parameters: [tenantId, `t-${tenantId.slice(-6)}`, "t"],
  });
  await db.execute({
    sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    parameters: [applicationId, tenantId, `a-${applicationId.slice(-6)}`, "a"],
  });
  await db.execute({
    sql: "INSERT INTO identity.actors (id, external_subject, display_name) VALUES ($1, $2, $3)",
    parameters: [ownerId, `subj-${ownerId}`, "owner"],
  });
  await db.execute({
    sql: "INSERT INTO identity.memberships (id, actor_id, application_id, tenant_id, role) VALUES ($1, $2, $3, $4, 'owner')",
    parameters: [generateId(), ownerId, applicationId, tenantId],
  });

  const cipher = createEnvelopeCipher(generateMasterKey());
  const auth = createSqlAuthModule(db, generateId);
  const vault = new SqlCredentialVault(db, cipher, generateId);
  const connections = createConnectionService(
    new SqlConnectionStore(db),
    new SqlConnectionsIdempotency(
      db,
      (tx: Transaction) => createTxCredentialVault(tx, cipher, generateId),
      generateId,
    ),
    createScopeResolver(auth.store),
    auth.store,
    generateId,
  );

  const transport = new FixtureTransport();
  const registry = createRailRegistry([
    createOpenRouterAdapter({ transport }),
    createAnthropicAdapter({ transport }),
  ]);
  const gateway = createModelGateway({
    resolver: createScopeResolver(auth.store),
    catalog: connections,
    credentials: vault,
    admission: {
      async admit() {
        return allow ? { allowed: true } : { allowed: false, reason: "fixture denial" };
      },
    },
    rails: registry,
    journal: createSqlDispatchJournal(db),
    generateId,
    hashRequest: () => "hash",
  });

  return { db, tenantId, applicationId, ownerId, connections, gateway, transport, vault };
}

const PRINCIPAL = (ownerId: string) => ({
  actorId: ownerId,
  authenticatedAt: "2026-01-01T00:00:00Z",
});
const REQUEST = {
  model: "fixture/model",
  messages: [{ role: "user" as const, content: "hello" }],
};

definePgSuite("end-to-end model dispatch on both rails (real PostgreSQL)", (ctx: PgContext) => {
  test("BYOK dispatch through the aggregation rail: vault → gateway → bearer header → journal", async () => {
    const world = await seedDispatchWorld(ctx.port, true);
    const { connection } = await world.connections.registerConnection(
      {
        principal: PRINCIPAL(world.ownerId),
        applicationId: world.applicationId,
        rail: "openrouter",
        label: "e2e-openrouter",
        registerCredential: { material: "sk-or-v1-e2e-BYOK" },
      },
      "e2e-or",
    );

    const result = await world.gateway.complete(
      PRINCIPAL(world.ownerId),
      world.applicationId,
      connection.id,
      REQUEST,
    );
    expect(result.outcome.kind).toBe("provider-success");
    if (result.outcome.kind !== "provider-success") return;
    expect(result.outcome.response.content).toEqual(["rail answer"]);
    expect(result.outcome.response.usage.costUsd).toBe(0.002);

    // The wire saw the materialized BYOK credential as a bearer token.
    const wire = world.transport.requests[0];
    expect(wire?.headers.authorization).toBe("Bearer sk-or-v1-e2e-BYOK");
    expect(wire?.url).toBe("https://openrouter.ai/api/v1/chat/completions");

    // The journal carries the durable provider-axis success.
    const journalRow = await ctx.port.execute<{ status: string; outcome: unknown }>({
      sql: "SELECT status, outcome FROM models.dispatch_attempts WHERE id = $1",
      parameters: [result.attemptId],
    });
    expect(journalRow.rows[0]?.status).toBe("succeeded");
    const outcome = journalRow.rows[0]?.outcome as { outcomeClass: string } | undefined;
    expect(outcome?.outcomeClass).toBe("provider-success");
  });

  test("BYOK dispatch through the direct rail: same gateway, different wire discipline", async () => {
    const world = await seedDispatchWorld(ctx.port, true);
    const { connection } = await world.connections.registerConnection(
      {
        principal: PRINCIPAL(world.ownerId),
        applicationId: world.applicationId,
        rail: "anthropic",
        label: "e2e-anthropic",
        registerCredential: { material: "sk-ant-e2e-BYOK" },
      },
      "e2e-an",
    );

    const result = await world.gateway.complete(
      PRINCIPAL(world.ownerId),
      world.applicationId,
      connection.id,
      { ...REQUEST, model: "claude-3-5-sonnet" },
    );
    expect(result.outcome.kind).toBe("provider-success");
    if (result.outcome.kind !== "provider-success") return;
    expect(result.outcome.response.content).toEqual(["direct answer"]);
    expect(result.outcome.response.usage).toEqual({
      inputTokens: 5,
      outputTokens: 3,
      totalTokens: 8,
      costUsd: null,
    });

    // The SAME gateway served the direct rail with its own header discipline.
    const wire = world.transport.requests[0];
    expect(wire?.headers["x-api-key"]).toBe("sk-ant-e2e-BYOK");
    expect(wire?.headers.authorization).toBeUndefined();
    expect(wire?.url).toBe("https://api.anthropic.com/v1/messages");
  });

  test("admission denial journals evidence and throws POLICY_DENIED without transport", async () => {
    const world = await seedDispatchWorld(ctx.port, false);
    const { connection } = await world.connections.registerConnection(
      {
        principal: PRINCIPAL(world.ownerId),
        applicationId: world.applicationId,
        rail: "openrouter",
        label: "e2e-denied",
      },
      "e2e-denied",
    );
    const error = await world.gateway
      .complete(PRINCIPAL(world.ownerId), world.applicationId, connection.id, REQUEST)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(PlatformError);
    expect((error as PlatformError).code).toBe("POLICY_DENIED");
    expect(world.transport.requests).toHaveLength(0);

    const denied = await ctx.port.execute<{ status: string; admitted: boolean; outcome: unknown }>({
      sql: "SELECT status, admitted, outcome FROM models.dispatch_attempts WHERE connection_id = $1",
      parameters: [connection.id],
    });
    expect(denied.rows[0]?.status).toBe("denied");
    expect(denied.rows[0]?.admitted).toBe(false);
    expect(denied.rows[0]?.outcome).toEqual({ denied: true, reason: "fixture denial" });
  });

  test("provider failures become durable provider-axis outcomes (distinct from quality)", async () => {
    const db = ctx.port;
    // Build a world whose transport always fails on the rail.
    const world = await seedDispatchWorld(db, true);
    world.transport.send = async (_request: HttpRequestBody): Promise<HttpResponse> =>
      textResponse(429, JSON.stringify({ error: { code: "429", message: "rate limited" } }), {
        "content-type": "application/json",
      });
    const { connection } = await world.connections.registerConnection(
      {
        principal: PRINCIPAL(world.ownerId),
        applicationId: world.applicationId,
        rail: "openrouter",
        label: "e2e-failure",
        registerCredential: { material: "sk-or-v1-fail" },
      },
      "e2e-fail",
    );

    const result = await world.gateway.complete(
      PRINCIPAL(world.ownerId),
      world.applicationId,
      connection.id,
      REQUEST,
    );
    expect(result.outcome.kind).toBe("provider-failure");
    if (result.outcome.kind !== "provider-failure") return;
    expect(result.outcome.failure.category).toBe("rate-limit");
    expect(result.outcome.failure.retryable).toBe(true);

    const row = await db.execute<{ status: string; outcome: unknown }>({
      sql: "SELECT status, outcome FROM models.dispatch_attempts WHERE id = $1",
      parameters: [result.attemptId],
    });
    expect(row.rows[0]?.status).toBe("provider-failed");
    const outcome = row.rows[0]?.outcome as Record<string, string>;
    expect(outcome.outcomeClass).toBe("provider-failure");
    expect(outcome.category).toBe("rate-limit");
    // The durable record is free of credential material.
    expect(JSON.stringify(outcome)).not.toContain("sk-or-v1-fail");
  });

  test("endpoint overrides from the connection reach the wire (customer endpoints)", async () => {
    const world = await seedDispatchWorld(ctx.port, true);
    const { connection } = await world.connections.registerConnection(
      {
        principal: PRINCIPAL(world.ownerId),
        applicationId: world.applicationId,
        rail: "openrouter",
        label: "e2e-gateway",
        endpointUrl: "https://gw.customer.example/openai",
        registerCredential: { material: "sk-or-v1-gateway" },
      },
      "e2e-gw",
    );
    await world.gateway.complete(
      PRINCIPAL(world.ownerId),
      world.applicationId,
      connection.id,
      REQUEST,
    );
    expect(world.transport.requests[0]?.url).toBe(
      "https://gw.customer.example/openai/chat/completions",
    );
  });
});
