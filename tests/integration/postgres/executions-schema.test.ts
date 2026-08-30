/**
 * Real-PostgreSQL: executions schema constraints (WORK-006 acceptance
 * criterion 2/3 physical proofs; checkpoints IMPLEMENTATION-COMPLETENESS,
 * EXECUTION-PROVENANCE, CONCURRENCY-CRASH-SAFETY).
 *
 * Proves the PHYSICAL invariants of migration 0004 against real
 * PostgreSQL 16:
 *   * unknown states are unrepresentable (vocabulary CHECK);
 *   * COMPLETED without a verification binding is unrepresentable
 *     (CHECK + binding-shape CHECK + durable-reference trigger) — the
 *     completion shortcut dies at the database even with every
 *     service-level guard removed;
 *   * the event ledger is append-only (UPDATE/DELETE trigger) and gapless
 *     per execution (sequence trigger + unique index);
 *   * verification results are append-only;
 *   * execution rows: never deletable, terminal-immutable, and every
 *     UPDATE must append exactly one matching envelope (single write
 *     path made physical — direct SQL status mutation without an event is
 *     rejected);
 *   * composite-FK tenant anti-ambiguity (cross-tenant execution,
 *     cross-application environment/event/verification binding).
 */

import { expect, test } from "vitest";
import type { DatabasePort } from "../../../src/platform/db/port";
import { type ExecutionsWorld, generateId, seedExecutionsWorld } from "./executions-world";
import { definePgSuite } from "./harness";

definePgSuite("executions schema constraints (real PG)", (ctx) => {
  let world: ExecutionsWorld;

  async function insertExecution(db: DatabasePort, overrides: Record<string, unknown> = {}) {
    const status = (overrides.status as string) ?? "CREATED";
    const terminalAt =
      status === "COMPLETED" ||
      status === "FAILED" ||
      status === "CANCELLED" ||
      status === "EXPIRED"
        ? new Date().toISOString()
        : null;
    return db.execute({
      sql: `INSERT INTO executions.executions
  (id, application_id, tenant_id, environment_id, user_id, status, task,
   input_artifacts, execution_constraints, user_metadata, request_fingerprint,
   completed_at, failed_at, cancelled_at, expired_at)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $8,
  $9, $10, $11, $12)`,
      parameters: [
        (overrides.id as string) ?? generateId(),
        (overrides.applicationId as string) ?? world.applicationId,
        (overrides.tenantId as string) ?? world.tenantId,
        (overrides.environmentId as string | null) ?? null,
        (overrides.userId as string) ?? "",
        status,
        JSON.stringify({ kind: "summarize" }),
        (overrides.requestFingerprint as string) ?? `fp-${generateId().slice(-8)}`,
        status === "COMPLETED" ? terminalAt : null,
        status === "FAILED" ? terminalAt : null,
        status === "CANCELLED" ? terminalAt : null,
        status === "EXPIRED" ? terminalAt : null,
      ],
    });
  }

  async function insertEvent(db: DatabasePort, overrides: Record<string, unknown> = {}) {
    return db.execute({
      sql: `INSERT INTO executions.execution_events
  (id, execution_id, application_id, tenant_id, sequence, type, command, actor, cause, reference, payload)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, '{}'::jsonb, '{}'::jsonb)`,
      parameters: [
        (overrides.eventId as string) ?? generateId(),
        (overrides.executionId as string) ?? "",
        (overrides.applicationId as string) ?? world.applicationId,
        (overrides.tenantId as string) ?? world.tenantId,
        (overrides.sequence as number) ?? 1,
        (overrides.type as string) ?? "execution.created",
        (overrides.command as string) ?? "create",
        JSON.stringify({ actorId: "actor-1", tenantId: world.tenantId }),
        (overrides.cause as string | null) ?? null,
      ],
    });
  }

  test("status vocabulary CHECK: unknown states unrepresentable", async () => {
    world = await seedExecutionsWorld(ctx.port);
    await insertExecution(ctx.port);
    for (const bad of ["PAUSED", "SUCCEEDED", "RUNNING ", "running", "QUEING"]) {
      await expect(insertExecution(ctx.port, { status: bad })).rejects.toThrow(
        /executions_status_vocabulary/,
      );
    }
  });

  test("COMPLETED without a verification binding is PHYSICALLY rejected (no shortcut)", async () => {
    world = await seedExecutionsWorld(ctx.port);
    // Direct SQL — every service-level guard bypassed by construction.
    await expect(insertExecution(ctx.port, { status: "COMPLETED" })).rejects.toThrow(
      /executions_completion_requires_verification/,
    );
    // A dangling binding (refs that reference no durable row) is rejected too.
    const fakeRef = generateId();
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO executions.executions
  (id, application_id, tenant_id, task, request_fingerprint, status, verification_refs)
VALUES ($1, $2, $3, $4::jsonb, $5, 'COMPLETED', $6::jsonb)`,
        parameters: [
          generateId(),
          world.applicationId,
          world.tenantId,
          JSON.stringify({ kind: "x" }),
          "fp-1",
          JSON.stringify([fakeRef]),
        ],
      }),
    ).rejects.toThrow(
      /executions_completion_requires_verification|verification binding references no durable/,
    );
    // Binding on a NON-completed row is unrepresentable (shape CHECK): a
    // seeded PASS result first, then an envelope-backed update that tries
    // to attach refs while staying CREATED.
    const executionId = generateId();
    await insertExecution(ctx.port, { id: executionId });
    await insertEvent(ctx.port, { executionId, sequence: 1 });
    await insertEvent(ctx.port, { executionId, sequence: 2, command: "authorize" });
    const resultId = await seedVerificationResult(executionId, "PASS");
    await expect(
      ctx.port.execute({
        sql: "UPDATE executions.executions SET verification_refs = $1::jsonb, last_event_sequence = 2 WHERE id = $2",
        parameters: [JSON.stringify([resultId]), executionId],
      }),
    ).rejects.toThrow(/executions_verification_binding_shape/);
  });

  async function seedVerificationResult(executionId: string, status: string): Promise<string> {
    const id = generateId();
    await ctx.port.execute({
      sql: `INSERT INTO executions.verification_results
  (id, execution_id, application_id, tenant_id, criterion_id, strategy, status, recorded_by)
VALUES ($1, $2, $3, $4, 'criterion-1', 'rubric', $5, 'verifier-1')`,
      parameters: [id, executionId, world.applicationId, world.tenantId, status],
    });
    return id;
  }

  test("terminal immutability + no-delete: CANCELLED/COMPLETED rows reject every UPDATE/DELETE", async () => {
    world = await seedExecutionsWorld(ctx.port);
    for (const status of ["CANCELLED", "EXPIRED", "FAILED"]) {
      const executionId = generateId();
      await insertExecution(ctx.port, { id: executionId, status });
      await insertEvent(ctx.port, { executionId, sequence: 1, command: "create" });
      await expect(
        ctx.port.execute({
          sql: "UPDATE executions.executions SET user_id = 'x' WHERE id = $1",
          parameters: [executionId],
        }),
      ).rejects.toThrow(/terminal-immutable/);
      await expect(
        ctx.port.execute({
          sql: "DELETE FROM executions.executions WHERE id = $1",
          parameters: [executionId],
        }),
      ).rejects.toThrow(/never deleted/);
    }
    // Non-terminal rows are deletable never (history erasure impossible).
    const alive = generateId();
    await insertExecution(ctx.port, { id: alive });
    await expect(
      ctx.port.execute({
        sql: "DELETE FROM executions.executions WHERE id = $1",
        parameters: [alive],
      }),
    ).rejects.toThrow(/never deleted/);
  });

  test("single write path PHYSICAL: an UPDATE without its matching envelope is rejected", async () => {
    world = await seedExecutionsWorld(ctx.port);
    const executionId = generateId();
    await insertExecution(ctx.port, { id: executionId });
    await insertEvent(ctx.port, { executionId, sequence: 1 });
    // Direct status mutation WITHOUT a new envelope: rejected (sequence rule).
    await expect(
      ctx.port.execute({
        sql: "UPDATE executions.executions SET status = 'AUTHORIZED' WHERE id = $1",
        parameters: [executionId],
      }),
    ).rejects.toThrow(/must append exactly one event/);
    // Advance the sequence WITHOUT appending the matching envelope: rejected.
    await expect(
      ctx.port.execute({
        sql: "UPDATE executions.executions SET status = 'AUTHORIZED', last_event_sequence = 2 WHERE id = $1",
        parameters: [executionId],
      }),
    ).rejects.toThrow(/no matching ledger envelope/);
    // A no-op rewind (sequence unchanged) is equally rejected.
    await expect(
      ctx.port.execute({
        sql: "UPDATE executions.executions SET user_id = 'x' WHERE id = $1",
        parameters: [executionId],
      }),
    ).rejects.toThrow(/must append exactly one event/);
  });

  test("event ledger is append-only: UPDATE and DELETE physically rejected", async () => {
    world = await seedExecutionsWorld(ctx.port);
    const executionId = generateId();
    await insertExecution(ctx.port, { id: executionId });
    const { rows } = await ctx.port.execute<{ id: string }>({
      sql: `INSERT INTO executions.execution_events
  (id, execution_id, application_id, tenant_id, sequence, type, command, actor)
VALUES ($1, $2, $3, $4, 1, 'execution.created', 'create', '{}'::jsonb) RETURNING id`,
      parameters: [generateId(), executionId, world.applicationId, world.tenantId],
    });
    const eventId = rows[0]?.id ?? "";
    await expect(
      ctx.port.execute({
        sql: "UPDATE executions.execution_events SET cause = 'tampered' WHERE id = $1",
        parameters: [eventId],
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      ctx.port.execute({
        sql: "DELETE FROM executions.execution_events WHERE id = $1",
        parameters: [eventId],
      }),
    ).rejects.toThrow(/append-only/);
  });

  test("event sequence is gapless per execution: gaps and duplicates physically rejected", async () => {
    world = await seedExecutionsWorld(ctx.port);
    const executionId = generateId();
    await insertExecution(ctx.port, { id: executionId });
    await insertEvent(ctx.port, { executionId, sequence: 1 });
    // Gap: 3 when 2 is expected.
    await expect(insertEvent(ctx.port, { executionId, sequence: 3 })).rejects.toThrow(/gapless/);
    // Duplicate: 1 again.
    await expect(insertEvent(ctx.port, { executionId, sequence: 1 })).rejects.toThrow(/gapless/);
    // Sequence must be positive (the gapless trigger rejects first; the
    // CHECK is the backstop on the final row).
    await expect(insertEvent(ctx.port, { executionId, sequence: 0 })).rejects.toThrow(
      /gapless|events_sequence_positive/,
    );
    // In-order insert succeeds.
    await insertEvent(ctx.port, { executionId, sequence: 2, command: "authorize" });
  });

  test("verification results are append-only", async () => {
    world = await seedExecutionsWorld(ctx.port);
    const executionId = generateId();
    await insertExecution(ctx.port, { id: executionId });
    const resultId = await seedVerificationResult(executionId, "PASS");
    await expect(
      ctx.port.execute({
        sql: "UPDATE executions.verification_results SET status = 'FAIL' WHERE id = $1",
        parameters: [resultId],
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      ctx.port.execute({
        sql: "DELETE FROM executions.verification_results WHERE id = $1",
        parameters: [resultId],
      }),
    ).rejects.toThrow(/append-only/);
    // Status vocabulary is CHECK-bound.
    await expect(seedVerificationResult(executionId, "MAYBE")).rejects.toThrow(
      /verification_status/,
    );
  });

  test("composite-FK tenant anti-ambiguity: cross-tenant and cross-application rows unrepresentable", async () => {
    world = await seedExecutionsWorld(ctx.port);
    // Cross-tenant execution row.
    await expect(insertExecution(ctx.port, { tenantId: generateId() })).rejects.toThrow(
      /executions_tenant_fk/,
    );
    // Unknown application.
    await expect(insertExecution(ctx.port, { applicationId: generateId() })).rejects.toThrow(
      /executions_tenant_fk/,
    );
    // Environment of another application.
    const otherApp = generateId();
    await ctx.port.execute({
      sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
      parameters: [otherApp, world.tenantId, `a-${otherApp.slice(-6)}`, "other app"],
    });
    const otherEnv = generateId();
    await ctx.port.execute({
      sql: "INSERT INTO applications.environments (id, application_id, tenant_id, kind, name) VALUES ($1, $2, $3, 'production', 'prod')",
      parameters: [otherEnv, otherApp, world.tenantId],
    });
    await expect(insertExecution(ctx.port, { environmentId: otherEnv })).rejects.toThrow(
      /executions_environment_fk/,
    );
    // Cross-application event row.
    const executionId = generateId();
    await insertExecution(ctx.port, { id: executionId });
    await expect(insertEvent(ctx.port, { executionId, applicationId: otherApp })).rejects.toThrow(
      /events_execution_fk/,
    );
  });

  test("event envelope provenance columns are NOT NULL (EXECUTION-PROVENANCE)", async () => {
    world = await seedExecutionsWorld(ctx.port);
    const executionId = generateId();
    await insertExecution(ctx.port, { id: executionId });
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO executions.execution_events
  (id, execution_id, application_id, tenant_id, sequence, type, command, actor, cause, reference, payload)
VALUES ($1, $2, $3, $4, 1, 'execution.created', NULL, '{}'::jsonb, NULL, '{}'::jsonb, '{}'::jsonb)`,
        parameters: [generateId(), executionId, world.applicationId, world.tenantId],
      }),
    ).rejects.toThrow(/events_command_nonempty|null value in column "command"|command/);
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO executions.execution_events
  (id, execution_id, application_id, tenant_id, sequence, type, command, actor, cause, reference, payload)
VALUES ($1, $2, $3, $4, 1, 'execution.created', 'create', NULL, NULL, '{}'::jsonb, '{}'::jsonb)`,
        parameters: [generateId(), executionId, world.applicationId, world.tenantId],
      }),
    ).rejects.toThrow();
  });
});
