/**
 * Real-PostgreSQL: provider dispatch journal constraints (WORK-003, CON-005
 * durable proof; checkpoints CONCURRENCY-CRASH-SAFETY).
 *
 * Proves the PHYSICAL distinction on the provider axis:
 *   * quality/verification outcome classes are UNREPRESENTABLE in the
 *     journal (CHECK constraint rejects them);
 *   * status and outcome class must agree (a `succeeded` row cannot carry
 *     `provider-failure`, and vice versa);
 *   * intent rows exist before outcomes (durable-then-observe) and resolve
 *     exactly once;
 *   * denial rows record admission evidence without any dispatch.
 */

import { expect, test } from "vitest";
import { createSqlDispatchJournal } from "../../../src/modules/models/adapters/sql-dispatch-journal";
import type { DatabasePort } from "../../../src/platform/db/port";
import { PlatformError } from "../../../src/shared/errors";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { definePgSuite, type PgContext } from "./harness";

const generateId = createUuidv7Generator();

const USAGE = { inputTokens: 3, outputTokens: 2, totalTokens: 5, costUsd: 0.001 };

const SUCCESS_OUTCOME = {
  kind: "provider-success" as const,
  response: {
    content: ["ok"],
    stopReason: "stop" as const,
    structuredOutput: null,
    usage: USAGE,
    providerLatencyMs: 12,
  },
};
const FAILURE_OUTCOME = {
  kind: "provider-failure" as const,
  failure: {
    category: "rate-limit" as const,
    retryable: true,
    rail: "openrouter",
    providerCode: "429",
    providerMessage: "slow down",
    httpStatus: 429,
    durationMs: 3,
  },
};

async function seedIntent(db: DatabasePort) {
  const id = generateId();
  const tenantId = generateId();
  const applicationId = generateId();
  await db.execute({
    sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
    parameters: [tenantId, `t-${tenantId.slice(-6)}`, "t"],
  });
  await db.execute({
    sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    parameters: [applicationId, tenantId, `a-${applicationId.slice(-6)}`, "a"],
  });
  const connectionId = generateId();
  await db.execute({
    sql: `INSERT INTO connections.connections (id, application_id, tenant_id, rail, label, credential_kind)
VALUES ($1, $2, $3, 'openrouter', 'journal-probe', 'platform')`,
    parameters: [connectionId, applicationId, tenantId],
  });
  return { id, tenantId, applicationId, connectionId };
}

definePgSuite("provider dispatch journal (real PostgreSQL)", (ctx: PgContext) => {
  test("intent rows commit before outcomes and resolve exactly once", async () => {
    const journal = createSqlDispatchJournal(ctx.port);
    const seed = await seedIntent(ctx.port);
    await journal.recordIntent({
      id: seed.id,
      tenantId: seed.tenantId,
      applicationId: seed.applicationId,
      connectionId: seed.connectionId,
      rail: "openrouter",
      model: "m",
      requestHash: "hash",
    });
    let attempt = await journal.findAttempt(seed.id);
    expect(attempt?.status).toBe("dispatching");
    expect(attempt?.admitted).toBe(true);
    expect(attempt?.outcome).toBeNull();

    await journal.recordOutcome(seed.id, "succeeded", SUCCESS_OUTCOME);
    attempt = await journal.findAttempt(seed.id);
    expect(attempt?.status).toBe("succeeded");
    expect(attempt?.resolvedAt).not.toBeNull();
    const outcome = attempt?.outcome as { outcomeClass: string; usage: unknown };
    expect(outcome.outcomeClass).toBe("provider-success");
    expect(outcome.usage).toEqual(USAGE);

    // Exactly-once resolution: a second recordOutcome fails closed.
    await expect(
      journal.recordOutcome(seed.id, "provider-failed", FAILURE_OUTCOME),
    ).rejects.toThrow(PlatformError);
  });

  test("provider failures land on the provider axis with normalized detail", async () => {
    const journal = createSqlDispatchJournal(ctx.port);
    const seed = await seedIntent(ctx.port);
    await journal.recordIntent({
      id: seed.id,
      tenantId: seed.tenantId,
      applicationId: seed.applicationId,
      connectionId: seed.connectionId,
      rail: "openrouter",
      model: "m",
      requestHash: "hash",
    });
    await journal.recordOutcome(seed.id, "provider-failed", FAILURE_OUTCOME);
    const attempt = await journal.findAttempt(seed.id);
    expect(attempt?.status).toBe("provider-failed");
    const outcome = attempt?.outcome as Record<string, unknown>;
    expect(outcome.outcomeClass).toBe("provider-failure");
    expect(outcome.category).toBe("rate-limit");
    expect(outcome.retryable).toBe(true);
  });

  test("CON-005 physical proof: quality/verification classes are unrepresentable", async () => {
    // Direct SQL with a quality outcome class must violate the CHECK.
    const seed = await seedIntent(ctx.port);
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO models.dispatch_attempts
  (id, tenant_id, application_id, connection_id, rail, model, request_hash, admitted, status, outcome, resolved_at)
VALUES ($1, $2, $3, $4, 'openrouter', 'm', 'h', TRUE, 'succeeded', $5::jsonb, now())`,
        parameters: [
          generateId(),
          seed.tenantId,
          seed.applicationId,
          seed.connectionId,
          JSON.stringify({ outcomeClass: "verification-failed" }),
        ],
      }),
    ).rejects.toThrow(/violates check constraint/);

    await expect(
      ctx.port.execute({
        sql: `INSERT INTO models.dispatch_attempts
  (id, tenant_id, application_id, connection_id, rail, model, request_hash, admitted, status, outcome, resolved_at)
VALUES ($1, $2, $3, $4, 'openrouter', 'm', 'h', TRUE, 'provider-failed', $5::jsonb, now())`,
        parameters: [
          generateId(),
          seed.tenantId,
          seed.applicationId,
          seed.connectionId,
          JSON.stringify({ outcomeClass: "verification-inconclusive" }),
        ],
      }),
    ).rejects.toThrow(/violates check constraint/);
  });

  test("status and outcome class must agree (succeeded cannot carry provider-failure)", async () => {
    const seed = await seedIntent(ctx.port);
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO models.dispatch_attempts
  (id, tenant_id, application_id, connection_id, rail, model, request_hash, admitted, status, outcome, resolved_at)
VALUES ($1, $2, $3, $4, 'openrouter', 'm', 'h', TRUE, 'succeeded', $5::jsonb, now())`,
        parameters: [
          generateId(),
          seed.tenantId,
          seed.applicationId,
          seed.connectionId,
          JSON.stringify({ outcomeClass: "provider-failure" }),
        ],
      }),
    ).rejects.toThrow(/violates check constraint/);
  });

  test("denial rows record admission evidence without dispatch", async () => {
    const journal = createSqlDispatchJournal(ctx.port);
    const seed = await seedIntent(ctx.port);
    await journal.recordDenial(
      {
        id: seed.id,
        tenantId: seed.tenantId,
        applicationId: seed.applicationId,
        connectionId: seed.connectionId,
        rail: "openrouter",
        model: "m",
        requestHash: "hash",
      },
      "cost ceiling exceeded",
    );
    const attempt = await journal.findAttempt(seed.id);
    expect(attempt?.status).toBe("denied");
    expect(attempt?.admitted).toBe(false);
    expect(attempt?.outcome).toEqual({ denied: true, reason: "cost ceiling exceeded" });
    expect(attempt?.resolvedAt).not.toBeNull();
  });

  test("dispatching rows without resolved outcomes are honest crash evidence", async () => {
    // Simulate a crash between durable intent and resolution: the row stays
    // `dispatching` with no outcome — unknown external outcome, durable.
    const seed = await seedIntent(ctx.port);
    await ctx.port.execute({
      sql: `INSERT INTO models.dispatch_attempts
  (id, tenant_id, application_id, connection_id, rail, model, request_hash, admitted, status)
VALUES ($1, $2, $3, $4, 'openrouter', 'm', 'h', TRUE, 'dispatching')`,
      parameters: [seed.id, seed.tenantId, seed.applicationId, seed.connectionId],
    });
    const journal = createSqlDispatchJournal(ctx.port);
    const attempt = await journal.findAttempt(seed.id);
    expect(attempt?.status).toBe("dispatching");
    expect(attempt?.resolvedAt).toBeNull();
    // A late resolution still lands (retry-after-crash convergence).
    await journal.recordOutcome(seed.id, "provider-failed", FAILURE_OUTCOME);
    expect((await journal.findAttempt(seed.id))?.status).toBe("provider-failed");
  });
});
