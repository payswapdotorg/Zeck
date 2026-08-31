/**
 * Real-PostgreSQL — the sandbox schema's physical invariants (WORK-012;
 * migration 0007_sandbox.sql).
 *
 * Proves at the STORAGE boundary (violations unrepresentable, not merely
 * discouraged):
 *   - environment specifications are WRITE-ONCE: UPDATEs that change the
 *     spec/kind/digest are physically rejected; rows are never deleted;
 *   - the environment lifecycle vocabulary + retired immutability;
 *   - sandbox runtime metadata is immutable on EVERY update path (M13);
 *   - terminal sandbox rows (denied/completed/failed) are physically
 *     immutable; denied is insert-only (M15-adjacent);
 *   - the outcome vocabulary is the SANDBOX AXIS ONLY (verification
 *     PASS/FAIL and provider classes are unrepresentable);
 *   - composite tenant/application/execution/environment FKs make
 *     cross-scope rows unrepresentable (M9/M10/M12).
 */

import { expect, test } from "vitest";
import { definePgSuite } from "./harness";
import { generateId } from "./sandbox-world";

definePgSuite("sandbox schema (real PG)", (ctx) => {
  async function seedScope() {
    const tenantId = generateId();
    const applicationId = generateId();
    await ctx.port.execute({
      sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
      parameters: [tenantId, `t-${tenantId.slice(-6)}`, "schema tenant"],
    });
    await ctx.port.execute({
      sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
      parameters: [applicationId, tenantId, `a-${applicationId.slice(-6)}`, "schema app"],
    });
    return { tenantId, applicationId };
  }

  async function seedExecution(applicationId: string, tenantId: string): Promise<string> {
    const executionId = generateId();
    await ctx.port.execute({
      sql: `INSERT INTO executions.executions (id, application_id, tenant_id, environment_id, user_id, task, input_artifacts, execution_constraints, user_metadata, request_fingerprint, status, last_event_sequence, created_at)
VALUES ($1, $2, $3, NULL, '', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $4, 'RUNNING', 1, now())`,
      parameters: [executionId, applicationId, tenantId, `fp-${executionId}`],
    });
    return executionId;
  }

  async function insertEnvironment(applicationId: string, tenantId: string, slug = "env-1") {
    const id = generateId();
    await ctx.port.execute({
      sql: `INSERT INTO sandbox.compute_environments (id, application_id, tenant_id, slug, name, kind, spec, spec_digest, status, created_at, updated_at)
VALUES ($1, $2, $3, $4, 'Env', 'process', $5::jsonb, $6, 'available', now(), now())`,
      parameters: [
        id,
        applicationId,
        tenantId,
        slug,
        JSON.stringify({
          kind: "process",
          limits: { cpuMilliCores: 500, memoryMiB: 128, executionTimeoutMs: 30000 },
          network: { egress: "none", allowedHosts: [] },
          filesystem: { workspace: "ephemeral-writable", readOnlyArtifactRefs: [] },
          secrets: { secretRefs: [] },
          runtime: { capabilityId: "process-sandbox" },
          cost: { estimatedCostMicroUsd: "0" },
        }),
        `digest-${id}`,
      ],
    });
    return id;
  }

  async function insertSandbox(
    applicationId: string,
    tenantId: string,
    executionId: string,
    environmentId: string,
    status: string,
  ) {
    const id = generateId();
    const denial =
      status === "denied"
        ? { denialClass: "policy", denialCode: "POLICY_DENIED", denialReason: "no" }
        : { denialClass: null, denialCode: null, denialReason: null };
    await ctx.port.execute({
      sql: `INSERT INTO sandbox.sandbox_executions (id, application_id, tenant_id, execution_id, sandbox_key, request_fingerprint, environment_id, kind, status, runtime_metadata, denial_class, denial_code, denial_reason, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, 'process', $8, $9::jsonb, $10, $11, $12, now())`,
      parameters: [
        id,
        applicationId,
        tenantId,
        executionId,
        `key-${id}`,
        `fp-${id}`,
        environmentId,
        status,
        JSON.stringify({
          kind: "process",
          environmentId,
          task: { command: "x", args: [], publicEnv: {} },
        }),
        denial.denialClass,
        denial.denialCode,
        denial.denialReason,
      ],
    });
    return id;
  }

  test("environment specifications are write-once: spec/kind/digest updates are physically rejected", async () => {
    const { applicationId, tenantId } = await seedScope();
    const envId = await insertEnvironment(applicationId, tenantId);
    await expect(
      ctx.port.execute({
        sql: 'UPDATE sandbox.compute_environments SET spec = \'{"kind":"container"}\'::jsonb WHERE id = $1',
        parameters: [envId],
      }),
    ).rejects.toThrow(/specification is immutable/i);
    await expect(
      ctx.port.execute({
        sql: "UPDATE sandbox.compute_environments SET kind = 'container' WHERE id = $1",
        parameters: [envId],
      }),
    ).rejects.toThrow(/specification is immutable/i);
    await expect(
      ctx.port.execute({
        sql: "UPDATE sandbox.compute_environments SET spec_digest = 'other' WHERE id = $1",
        parameters: [envId],
      }),
    ).rejects.toThrow(/specification is immutable/i);
    // the ONLY legal mutation: the guarded lifecycle status
    await ctx.port.execute({
      sql: "UPDATE sandbox.compute_environments SET status = 'suspended', updated_at = now() WHERE id = $1",
      parameters: [envId],
    });
  });

  test("environment rows are never deleted; retired is terminal-immutable", async () => {
    const { applicationId, tenantId } = await seedScope();
    const envId = await insertEnvironment(applicationId, tenantId);
    await expect(
      ctx.port.execute({
        sql: "DELETE FROM sandbox.compute_environments WHERE id = $1",
        parameters: [envId],
      }),
    ).rejects.toThrow(/never deleted/i);
    await ctx.port.execute({
      sql: "UPDATE sandbox.compute_environments SET status = 'retired', updated_at = now() WHERE id = $1",
      parameters: [envId],
    });
    await expect(
      ctx.port.execute({
        sql: "UPDATE sandbox.compute_environments SET status = 'available', updated_at = now() WHERE id = $1",
        parameters: [envId],
      }),
    ).rejects.toThrow(/terminal-immutable/i);
  });

  test("sandbox rows are never deleted; runtime metadata is immutable on every update path (M13)", async () => {
    const { applicationId, tenantId } = await seedScope();
    const executionId = await seedExecution(applicationId, tenantId);
    const envId = await insertEnvironment(applicationId, tenantId);
    const sandboxId = await insertSandbox(applicationId, tenantId, executionId, envId, "admitted");
    await expect(
      ctx.port.execute({
        sql: "DELETE FROM sandbox.sandbox_executions WHERE id = $1",
        parameters: [sandboxId],
      }),
    ).rejects.toThrow(/never deleted/i);
    await expect(
      ctx.port.execute({
        sql: 'UPDATE sandbox.sandbox_executions SET runtime_metadata = \'{"kind":"container"}\'::jsonb WHERE id = $1',
        parameters: [sandboxId],
      }),
    ).rejects.toThrow(/runtime metadata and identity are immutable/i);
    // the LEGAL bookkeeping update (ledger sequence on an admitted row):
    await ctx.port.execute({
      sql: "UPDATE sandbox.sandbox_executions SET ledger_admitted_sequence = 2 WHERE id = $1",
      parameters: [sandboxId],
    });
  });

  test("terminal sandbox rows are physically immutable; denied is insert-only (M15-class)", async () => {
    const { applicationId, tenantId } = await seedScope();
    const executionId = await seedExecution(applicationId, tenantId);
    const envId = await insertEnvironment(applicationId, tenantId);
    const deniedId = await insertSandbox(applicationId, tenantId, executionId, envId, "denied");
    await expect(
      ctx.port.execute({
        sql: "UPDATE sandbox.sandbox_executions SET ledger_admitted_sequence = 2 WHERE id = $1",
        parameters: [deniedId],
      }),
    ).rejects.toThrow(/terminal-immutable|cannot move/i);
    await expect(
      ctx.port.execute({
        sql: "UPDATE sandbox.sandbox_executions SET status = 'admitted' WHERE id = $1",
        parameters: [deniedId],
      }),
    ).rejects.toThrow(/terminal-immutable|cannot move/i);
  });

  test("the outcome vocabulary is the sandbox axis only (verification/provider classes unrepresentable)", async () => {
    const { applicationId, tenantId } = await seedScope();
    const executionId = await seedExecution(applicationId, tenantId);
    const envId = await insertEnvironment(applicationId, tenantId);
    const sandboxId = await insertSandbox(applicationId, tenantId, executionId, envId, "admitted");
    await ctx.port.execute({
      sql: "UPDATE sandbox.sandbox_executions SET status = 'dispatching', dispatched_at = now() WHERE id = $1",
      parameters: [sandboxId],
    });
    for (const badOutcome of ["PASS", "FAIL", "INCONCLUSIVE", "provider-success", "tool-success"]) {
      await expect(
        ctx.port.execute({
          sql: `UPDATE sandbox.sandbox_executions SET status = 'completed', outcome_class = $1, completed_at = now(), duration_ms = 5 WHERE id = $2`,
          parameters: [badOutcome, sandboxId],
        }),
      ).rejects.toThrow(/outcome_vocabulary|failed_shape|completed_shape/i);
    }
    // the SANDBOX axis vocabulary is representable:
    await ctx.port.execute({
      sql: `UPDATE sandbox.sandbox_executions SET status = 'completed', outcome_class = 'sandbox-success', completed_at = now(), duration_ms = 5 WHERE id = $1`,
      parameters: [sandboxId],
    });
  });

  test("composite FKs: cross-tenant/cross-application/cross-execution rows are unrepresentable (M9/M10/M12)", async () => {
    const scopeA = await seedScope();
    const scopeB = await seedScope();
    const executionA = await seedExecution(scopeA.applicationId, scopeA.tenantId);
    const envA = await insertEnvironment(scopeA.applicationId, scopeA.tenantId);
    const envB = await insertEnvironment(scopeB.applicationId, scopeB.tenantId, "env-b");

    // cross-tenant sandbox (tenant of B on application A's execution):
    await expect(
      insertSandbox(scopeA.applicationId, scopeB.tenantId, executionA, envA, "admitted"),
    ).rejects.toThrow();
    // cross-application environment reference:
    await expect(
      insertSandbox(scopeA.applicationId, scopeA.tenantId, executionA, envB, "admitted"),
    ).rejects.toThrow();
    // unknown execution:
    await expect(
      insertSandbox(scopeA.applicationId, scopeA.tenantId, generateId(), envA, "admitted"),
    ).rejects.toThrow();
  });

  test("status/outcome shape consistency is pinned per status", async () => {
    const { applicationId, tenantId } = await seedScope();
    const executionId = await seedExecution(applicationId, tenantId);
    const envId = await insertEnvironment(applicationId, tenantId);
    // an ADMITTED row cannot carry an outcome:
    const sandboxId = await insertSandbox(applicationId, tenantId, executionId, envId, "admitted");
    await expect(
      ctx.port.execute({
        sql: `UPDATE sandbox.sandbox_executions SET status = 'completed', outcome_class = 'sandbox-success', completed_at = now(), dispatched_at = now(), duration_ms = 1 WHERE id = $1`,
        parameters: [sandboxId],
      }),
    ).rejects.toThrow(/cannot move/i);
    // a denied row must carry its denial fields (insert-only shape):
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO sandbox.sandbox_executions (id, application_id, tenant_id, execution_id, sandbox_key, request_fingerprint, environment_id, kind, status, runtime_metadata, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, 'process', 'denied', '{}'::jsonb, now())`,
        parameters: [
          generateId(),
          applicationId,
          tenantId,
          executionId,
          `key-${generateId()}`,
          "fp",
          envId,
        ],
      }),
    ).rejects.toThrow(/denied_shape/i);
  });
});
