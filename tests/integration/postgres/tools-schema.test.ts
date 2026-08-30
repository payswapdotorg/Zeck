/**
 * Real-PostgreSQL: tools.tool_invocations physical invariants (WORK-010;
 * migration 0005; acceptance criterion 3 + the failure-model boundary).
 *
 * Proves the storage boundary itself rejects:
 *   * verification-vocabulary outcomes (PASS/FAIL/INCONCLUSIVE) and
 *     provider-axis classes — "classify a tool failure as verification
 *     success" is unrepresentable (CHECK);
 *   * unknown status/denial/failure vocabularies;
 *   * shape inconsistencies (denied without denial fields, terminal
 *     without outcome/timing, dispatching with outcome fields);
 *   * terminal-row mutation and row deletion (triggers);
 *   * cross-tenant and cross-application rows (composite FKs);
 *   * duplicate request keys (the idempotency anchor's unique index).
 */

import { expect, test } from "vitest";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { definePgSuite } from "./harness";
import { seedToolsWorld, type ToolsPgWorld } from "./tools-world";

const generateId = createUuidv7Generator();

definePgSuite("tools schema constraints (real PG)", (ctx) => {
  interface Seeded {
    readonly world: ToolsPgWorld;
    readonly executionId: string;
  }

  async function seed(): Promise<Seeded> {
    const world = await seedToolsWorld(ctx.port);
    const executionId = await world.seedExecution();
    return { world, executionId };
  }

  async function insertRow(seeded: Seeded, overrides: Record<string, unknown>): Promise<void> {
    const base = {
      id: generateId(),
      application_id: seeded.world.applicationId,
      tenant_id: seeded.world.tenantId,
      execution_id: seeded.executionId,
      invocation_key: `key-${generateId()}`,
      request_fingerprint: "fp-1",
      tool_id: "calculator",
      tool_version: "1.0.0",
      capability_id: "arithmetic",
      status: "dispatching",
      input_digest: "digest-1",
      input_artifacts: "[]" as const,
      output_artifacts: "[]" as const,
      requested_at: new Date(),
      ...overrides,
    };
    const columns = Object.keys(base).join(", ");
    const placeholders = Object.keys(base)
      .map((_, index) => `$${index + 1}`)
      .join(", ");
    await ctx.port.execute({
      sql: `INSERT INTO tools.tool_invocations (${columns}) VALUES (${placeholders})`,
      parameters: Object.values(base),
    });
  }

  /** The live CHECK definition of one constraint (catalog inspection). */
  async function constraintDefinitionOf(name: string): Promise<string> {
    const result = await ctx.port.execute<{ definition: string }>({
      sql: `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
WHERE conrelid = 'tools.tool_invocations'::regclass AND conname = $1`,
      parameters: [name],
    });
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`constraint ${name} not found on tools.tool_invocations`);
    }
    return row.definition;
  }

  test("migration 0005 applied and the tools schema exists", async () => {
    const result = await ctx.port.execute<{ version: number; name: string }>({
      sql: "SELECT version, name FROM platform.schema_migrations WHERE version = 5",
    });
    expect(result.rows).toEqual([{ version: 5, name: "tools" }]);
  });

  test("verification-vocabulary outcome classes are PHYSICALLY rejected", async () => {
    const seeded = await seed();
    // The vocabulary CHECK exists with exactly the tool axis (no
    // verification, no provider classes):
    const definition = await constraintDefinitionOf("tool_invocations_outcome_vocabulary");
    expect(definition).toContain("tool-success");
    expect(definition).toContain("tool-failure");
    expect(definition).not.toContain("PASS");
    expect(definition).not.toContain("provider");
    // And every verification/provider class is unrepresentable on insert
    // (whichever shape constraint fires, the row cannot exist):
    for (const outcomeClass of [
      "PASS",
      "FAIL",
      "INCONCLUSIVE",
      "provider-success",
      "provider-failure",
    ]) {
      await expect(insertRow(seeded, { outcome_class: outcomeClass })).rejects.toThrow(
        /tool_invocations_/,
      );
      await expect(
        insertRow(seeded, {
          status: "tool-failed",
          outcome_class: outcomeClass,
          failure_class: "tool-execution",
          dispatched_at: new Date(),
          completed_at: new Date(),
        }),
      ).rejects.toThrow(/tool_invocations_/);
    }
  });

  test("status/denial/failure vocabularies are CHECK-bound", async () => {
    const seeded = await seed();
    // The vocabulary CHECKs exist and pin the exact classes:
    expect(await constraintDefinitionOf("tool_invocations_status_vocabulary")).toContain(
      "dispatching",
    );
    expect(await constraintDefinitionOf("tool_invocations_denial_vocabulary")).toContain("policy");
    expect(await constraintDefinitionOf("tool_invocations_failure_vocabulary")).toContain(
      "output-contract",
    );
    // Unknown vocabulary values are unrepresentable:
    await expect(insertRow(seeded, { status: "RUNNING" })).rejects.toThrow(/tool_invocations_/);
    await expect(insertRow(seeded, { status: "SUCCEEDED" })).rejects.toThrow(/tool_invocations_/);
    await expect(insertRow(seeded, { denial_class: "tenant" })).rejects.toThrow(
      /tool_invocations_/,
    );
    await expect(
      insertRow(seeded, { status: "denied", denial_class: "weird", denial_code: "POLICY_DENIED" }),
    ).rejects.toThrow(/tool_invocations_/);
    await expect(
      insertRow(seeded, {
        status: "tool-failed",
        outcome_class: "tool-failure",
        failure_class: "nope",
        dispatched_at: new Date(),
        completed_at: new Date(),
      }),
    ).rejects.toThrow(/tool_invocations_/);
  });

  test("shape consistency: denied rows require denial fields and nothing else", async () => {
    const seeded = await seed();
    // denied without denial fields:
    await expect(insertRow(seeded, { status: "denied" })).rejects.toThrow(/tool_invocations_/);
    // denied with an outcome (denial/outcome disjointness):
    await expect(
      insertRow(seeded, {
        status: "denied",
        denial_class: "policy",
        denial_code: "POLICY_DENIED",
        outcome_class: "tool-failure",
      }),
    ).rejects.toThrow(/tool_invocations_/);
    // terminal without outcome/timing:
    await expect(insertRow(seeded, { status: "succeeded" })).rejects.toThrow(/tool_invocations_/);
    // succeeded must carry tool-success:
    await expect(
      insertRow(seeded, {
        status: "succeeded",
        outcome_class: "tool-failure",
        dispatched_at: new Date(),
        completed_at: new Date(),
      }),
    ).rejects.toThrow(/tool_invocations_/);
    // tool-failed must carry a failure class:
    await expect(
      insertRow(seeded, {
        status: "tool-failed",
        outcome_class: "tool-failure",
        dispatched_at: new Date(),
        completed_at: new Date(),
      }),
    ).rejects.toThrow(/tool_invocations_/);
    // dispatching rows carry neither outcome nor timing:
    await expect(insertRow(seeded, { dispatched_at: new Date() })).rejects.toThrow(
      /tool_invocations_/,
    );
  });

  test("usage/duration/identity shapes are enforced", async () => {
    const seeded = await seed();
    await expect(insertRow(seeded, { usage_micro_usd: "1.5" })).rejects.toThrow(/usage_shape/);
    await expect(insertRow(seeded, { usage_micro_usd: "-3" })).rejects.toThrow(/usage_shape/);
    await expect(insertRow(seeded, { duration_ms: -1 })).rejects.toThrow(/duration_shape/);
    await expect(insertRow(seeded, { ledger_requested_sequence: 0 })).rejects.toThrow(
      /ledger_sequences/,
    );
    await expect(insertRow(seeded, { input_digest: "" })).rejects.toThrow(/identities_nonempty/);
  });

  test("terminal rows are immutable; rows are never deleted; dispatching finalizes once", async () => {
    const seeded = await seed();
    const id = generateId();
    await insertRow(seeded, { id, invocation_key: `key-${id}` });
    // Bookkeeping bind on a dispatching row is legal:
    await ctx.port.execute({
      sql: "UPDATE tools.tool_invocations SET ledger_requested_sequence = 6 WHERE id = $1",
      parameters: [id],
    });
    // Finalization is legal exactly once:
    await ctx.port.execute({
      sql: `UPDATE tools.tool_invocations SET status = 'succeeded', outcome_class = 'tool-success',
output = '{"result": "1"}'::jsonb, dispatched_at = now(), completed_at = now(), duration_ms = 5
WHERE id = $1`,
      parameters: [id],
    });
    // Any further UPDATE of the terminal row is rejected:
    await expect(
      ctx.port.execute({
        sql: "UPDATE tools.tool_invocations SET duration_ms = 10 WHERE id = $1",
        parameters: [id],
      }),
    ).rejects.toThrow(/terminal-immutable/);
    // DELETE is rejected outright:
    await expect(
      ctx.port.execute({
        sql: "DELETE FROM tools.tool_invocations WHERE id = $1",
        parameters: [id],
      }),
    ).rejects.toThrow(/never deleted/);
  });

  test("cross-tenant and cross-application rows are unrepresentable (composite FKs)", async () => {
    const seeded = await seed();
    const otherTenant = generateId();
    await ctx.port.execute({
      sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
      parameters: [otherTenant, `t-${otherTenant.slice(-6)}`, "other tenant"],
    });
    // invocation row claiming a different tenant for the same application:
    await expect(insertRow(seeded, { tenant_id: otherTenant })).rejects.toThrow(/_fk|foreign key/i);
    // invocation row bound to a foreign application:
    const otherApp = generateId();
    await ctx.port.execute({
      sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
      parameters: [otherApp, otherTenant, `a-${otherApp.slice(-6)}`, "other app"],
    });
    await expect(insertRow(seeded, { application_id: otherApp })).rejects.toThrow(
      /_fk|foreign key/i,
    );
  });

  test("one durable row per (application, invocation_key) — the idempotency anchor", async () => {
    const seeded = await seed();
    const key = `dup-${generateId()}`;
    await insertRow(seeded, { invocation_key: key });
    await expect(insertRow(seeded, { invocation_key: key })).rejects.toThrow(
      /tool_invocations_request_key/,
    );
  });
});
