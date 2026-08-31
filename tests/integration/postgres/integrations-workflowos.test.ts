/**
 * Real-PostgreSQL proofs: the WorkflowOS integration adapter (WORK-016 /
 * WOS-001..004 — the durable halves of the integration boundary).
 *
 * Required-test mapping:
 *  - external submission identity: the submission lands as a durable
 *    execution row (real SQL) with the provenance metadata bound;
 *  - idempotency (§15): same key + same fingerprint replays the SAME
 *    durable execution; same key + different fingerprint → the canonical
 *    IDEMPOTENCY_KEY_REUSED; concurrent duplicate submissions converge
 *    on ONE durable identity (real unique arbitration);
 *  - tenant/application binding: the scope comes from the actor (the
 *    durable application row binds the tenant); cross-tenant reads fail
 *    closed;
 *  - the WorkflowOS round-trip (§22): request → execution → lifecycle →
 *    verification → evidence receipt (public reads only);
 *  - public reads reflect AUTHORITATIVE data: the receipt's evidence
 *    equals the executions authority's own rows;
 *  - no public mutation bypass: the receipt read leaves the ledger
 *    byte-stable (reads are pure).
 */

import { expect, test } from "vitest";
import { definePgSuite } from "./harness";
import { seedIntegrationPgWorld } from "./integrations-world";

definePgSuite("WorkflowOS integration over real PostgreSQL (WOS-001..004)", (ctx) => {
  test("a submission lands as a durable execution with provenance bound (WOS-001)", async () => {
    const world = await seedIntegrationPgWorld(ctx.port);
    const receipt = await world.workflowos.submitWork(
      { workRef: "pg-work-1", sessionRef: "pg-sess-1", task: { kind: "review", repo: "acme/api" } },
      "pg-wos-1",
      world.actor,
    );
    expect(receipt.status).toBe("CREATED");
    expect(receipt.workRef).toBe("pg-work-1");
    // The DURABLE row (real SQL) carries the tenant/application binding
    // and the WorkflowOS provenance.
    const row = await ctx.port.execute<{
      tenant_id: string;
      application_id: string;
      metadata: Record<string, unknown>;
    }>({
      sql: `SELECT tenant_id, application_id, user_metadata AS metadata FROM executions.executions WHERE id = $1`,
      parameters: [receipt.executionId],
    });
    expect(row.rows[0]?.tenant_id).toBe(world.tenantId);
    expect(row.rows[0]?.application_id).toBe(world.applicationId);
    expect(row.rows[0]?.metadata.workflowos).toEqual({
      source: "workflowos",
      workRef: "pg-work-1",
      sessionRef: "pg-sess-1",
    });
  });

  test("idempotency: same key + same request replays the same durable execution", async () => {
    const world = await seedIntegrationPgWorld(ctx.port);
    const request = {
      workRef: "pg-work-2",
      task: { kind: "summarize", doc: "d1" },
    };
    const first = await world.workflowos.submitWork(request, "pg-wos-2", world.actor);
    const second = await world.workflowos.submitWork(request, "pg-wos-2", world.actor);
    expect(second.executionId).toBe(first.executionId);
    expect(second.replayed).toBe(true);
    const count = await ctx.port.execute<{ count: string }>({
      sql: `SELECT count(*)::text AS count FROM executions.executions WHERE id = $1`,
      parameters: [first.executionId],
    });
    expect(count.rows[0]?.count).toBe("1");
  });

  test("idempotency: same key + different fingerprint fails canonically", async () => {
    const world = await seedIntegrationPgWorld(ctx.port);
    await world.workflowos.submitWork(
      { workRef: "pg-work-3", task: { kind: "review" } },
      "pg-wos-3",
      world.actor,
    );
    await expect(
      world.workflowos.submitWork(
        { workRef: "pg-work-4", task: { kind: "review" } },
        "pg-wos-3",
        world.actor,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  test("concurrent duplicate submissions converge on ONE durable execution (§15)", async () => {
    const world = await seedIntegrationPgWorld(ctx.port);
    const request = { workRef: "pg-work-5", task: { kind: "review", repo: "r" } };
    const [first, second] = await Promise.all([
      world.workflowos.submitWork(request, "pg-wos-5", world.actor),
      world.workflowos.submitWork(request, "pg-wos-5", world.actor),
    ]);
    const ids = new Set([first.executionId, second.executionId]);
    expect(ids.size).toBe(1);
    const count = await ctx.port.execute<{ count: string }>({
      sql: `SELECT count(*)::text AS count FROM executions.executions WHERE id = $1`,
      parameters: [first.executionId],
    });
    expect(count.rows[0]?.count).toBe("1");
    // Exactly ONE execution.created envelope (the single write path).
    const events = await ctx.port.execute<{ count: string }>({
      sql: `SELECT count(*)::text AS count FROM executions.execution_events WHERE execution_id = $1 AND type = 'execution.created'`,
      parameters: [first.executionId],
    });
    expect(events.rows[0]?.count).toBe("1");
  });

  test("the full WorkflowOS round-trip: request → execution → verification → evidence receipt (§22)", async () => {
    const world = await seedIntegrationPgWorld(ctx.port);
    const submission = await world.workflowos.submitWork(
      { workRef: "pg-work-6", task: { kind: "verify-me" } },
      "pg-wos-6",
      world.actor,
    );
    await world.completeExecution(submission.executionId, "pg-wos-6");

    const receipt = await world.workflowos.executionReceipt(world.actor, submission.executionId);
    expect(receipt.status).toBe("COMPLETED");
    expect(receipt.workRef).toBe("pg-work-6");
    expect(receipt.verification).toHaveLength(1);
    expect(receipt.verification[0]?.status).toBe("PASS");
    expect(receipt.verification[0]?.recordedBy).toBe("pg-verifier-1");
    // The receipt's evidence EQUALS the authority's durable rows (public
    // reads reflect authoritative data — the projection is faithful).
    const authorityVerification = await world.executions.listVerificationResults(
      world.applicationId,
      submission.executionId,
    );
    expect(receipt.verification.map((result) => result.criterionId)).toEqual(
      authorityVerification.map((result) => result.criterionId),
    );
    const authorityEvents = await world.executions.listEvents(
      world.applicationId,
      submission.executionId,
    );
    expect(receipt.events).toEqual(
      authorityEvents.map((event) => ({ sequence: event.sequence, type: event.type })),
    );
  });

  test("tenant isolation: cross-tenant reads fail closed over real rows (M8)", async () => {
    const world = await seedIntegrationPgWorld(ctx.port);
    const submission = await world.workflowos.submitWork(
      { workRef: "pg-work-7", task: { kind: "review" } },
      "pg-wos-7",
      world.actor,
    );
    await expect(
      world.workflowos.executionReceipt(world.otherTenantActor, submission.executionId),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    // The durable row is untouched by the denied read (no mutation path).
    const row = await ctx.port.execute<{ status: string }>({
      sql: `SELECT status FROM executions.executions WHERE id = $1`,
      parameters: [submission.executionId],
    });
    expect(row.rows[0]?.status).toBe("CREATED");
  });

  test("receipt reads are pure: the ledger stays byte-stable across reads", async () => {
    const world = await seedIntegrationPgWorld(ctx.port);
    const submission = await world.workflowos.submitWork(
      { workRef: "pg-work-8", task: { kind: "review" } },
      "pg-wos-8",
      world.actor,
    );
    await world.completeExecution(submission.executionId, "pg-wos-8");
    const before = await ctx.port.execute<{ sequence: number; type: string }>({
      sql: `SELECT sequence, type FROM executions.execution_events WHERE execution_id = $1 ORDER BY sequence`,
      parameters: [submission.executionId],
    });
    await world.workflowos.executionReceipt(world.actor, submission.executionId);
    await world.workflowos.executionReceipt(world.actor, submission.executionId);
    const after = await ctx.port.execute<{ sequence: number; type: string }>({
      sql: `SELECT sequence, type FROM executions.execution_events WHERE execution_id = $1 ORDER BY sequence`,
      parameters: [submission.executionId],
    });
    expect(after.rows).toEqual(before.rows);
  });
});
