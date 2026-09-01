/**
 * Real-PostgreSQL — the runner fleet (WORK-019, ENV-003; migration
 * 0015_runner_fleet.sql).
 *
 * Proves at the STORAGE and SERVICE boundaries over a fresh database with
 * the COMPLETE shipped migration inventory:
 *   - schema/physical invariants: the runner identity core is write-once,
 *     rows are never deleted, revoked is terminal-immutable, the
 *     authorization vocabulary is CHECK-bound and defaults UNTRUSTED, the
 *     assignment identity/lease/dispatch intent is immutable, terminal
 *     assignment rows are physically immutable, the append-only event
 *     trail rejects UPDATE/DELETE, the split-brain partial unique index
 *     refuses a second ACTIVE assignment per runner (M19), the
 *     (application, assignment_key) uniqueness refuses duplicates (M10),
 *     and the composite FKs make cross-tenant/cross-application/
 *     cross-execution/cross-environment rows unrepresentable (M1/M2/M9);
 *   - the governed lifecycle: registration → explicit authorization →
 *     heartbeat → assignment → dispatch handoff → report → terminal
 *     states, with the full event trail and provenance (M18);
 *   - idempotency: same key + same fingerprint replays; same key +
 *     different fingerprint is IDEMPOTENCY_KEY_REUSED;
 *   - tenant isolation and scope rejections BEFORE assignment: tenant
 *     mismatch, application mismatch (store scope), environment mismatch,
 *     unauthorized runner, capability mismatch, busy runner, stale
 *     heartbeat (M1/M2/M5/M12/M16/M20);
 *   - reconnect: token-fingerprint identity proof, re-binding the SAME
 *     assignment (never a second logical execution — M11), provenance
 *     survival;
 *   - the full governed dispatch through the CustomerRunnerSandboxProvider
 *     (sandbox service → fleet → channel → external endpoint) against the
 *     real SQL fabric.
 *
 * True concurrency races live in runner-fleet-concurrency.test.ts.
 */

import { expect, test } from "vitest";
import {
  CustomerRunnerChannel,
  InMemoryCustomerRunnerEndpoint,
} from "../../../src/integrations/runners/public";
import { CustomerRunnerSandboxProvider } from "../../../src/modules/sandbox/adapters/customer-runner-provider";
import type { RunnerHandoff } from "../../../src/modules/sandbox/public";
import { PlatformError } from "../../../src/shared/errors";
import { definePgSuite } from "./harness";
import {
  generateId,
  REGISTRATION_TOKEN,
  type RunnerFleetPgWorld,
  seedRunnerFleetWorld,
} from "./runner-fleet-world";

const REQUIRED = ["customer-runner", "cpu", "memory"];

/**
 * Sleep until the assignment's lease deadline has definitely passed (plus a
 * margin). Deadline-aware instead of a fixed sleep so the expiry proofs
 * stay deterministic under parallel-suite load stalls.
 */
async function sleepPastLease(leaseExpiresAt: string, marginMs = 250): Promise<void> {
  const remaining = Date.parse(leaseExpiresAt) + marginMs - Date.now();
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

function expectCode(promise: Promise<unknown>, code: string): Promise<PlatformError> {
  return promise.then(
    () => {
      throw new Error(`expected a PlatformError with code ${code}, got a resolution`);
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(PlatformError);
      expect((error as PlatformError).code).toBe(code);
      return error as PlatformError;
    },
  );
}

definePgSuite("runner fleet schema and lifecycle (real PG)", (ctx) => {
  // -------------------------------------------------------------------------
  // Physical schema invariants (direct SQL probes)
  // -------------------------------------------------------------------------

  async function seedScope() {
    const tenantId = generateId();
    const applicationId = generateId();
    await ctx.port.execute({
      sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
      parameters: [tenantId, `t-${tenantId.slice(-6)}`, "runner schema tenant"],
    });
    await ctx.port.execute({
      sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
      parameters: [applicationId, tenantId, `a-${applicationId.slice(-6)}`, "runner schema app"],
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

  async function seedEnvironment(applicationId: string, tenantId: string, slug = "runner-env-1") {
    const id = generateId();
    await ctx.port.execute({
      sql: `INSERT INTO sandbox.compute_environments (id, application_id, tenant_id, slug, name, kind, spec, spec_digest, status, created_at, updated_at)
VALUES ($1, $2, $3, $4, 'Runner env', 'customer-runner', $5::jsonb, $6, 'available', now(), now())`,
      parameters: [
        id,
        applicationId,
        tenantId,
        slug,
        JSON.stringify({
          kind: "customer-runner",
          limits: { cpuMilliCores: 1000, memoryMiB: 512, executionTimeoutMs: 60000 },
          network: { egress: "allowlist", allowedHosts: ["api.example.com"] },
          filesystem: { workspace: "ephemeral-writable", readOnlyArtifactRefs: [] },
          secrets: { secretRefs: [] },
          runtime: { capabilityId: "customer-runner-runtime" },
          cost: { estimatedCostMicroUsd: "0" },
        }),
        `digest-${id}`,
      ],
    });
    return id;
  }

  async function insertRunner(
    applicationId: string,
    tenantId: string,
    environmentId: string,
    slug = `runner-${generateId().slice(-6)}`,
  ) {
    const id = generateId();
    await ctx.port.execute({
      sql: `INSERT INTO sandbox.runners (id, application_id, tenant_id, environment_id, slug, name, runner_version, declared_capabilities, token_fingerprint, provenance, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, 'Runner', '1.2.3', '["customer-runner","cpu","memory"]'::jsonb, $6, $7::jsonb, now(), now())`,
      parameters: [
        id,
        applicationId,
        tenantId,
        environmentId,
        slug,
        `fingerprint-${id}`,
        JSON.stringify({
          actorId: "actor-1",
          cause: "runner-registration",
          channel: "runner-fleet",
          registeredAt: new Date().toISOString(),
        }),
      ],
    });
    return id;
  }

  async function insertSandboxRow(
    applicationId: string,
    tenantId: string,
    executionId: string,
    environmentId: string,
  ) {
    const id = generateId();
    await ctx.port.execute({
      sql: `INSERT INTO sandbox.sandbox_executions (id, application_id, tenant_id, execution_id, sandbox_key, request_fingerprint, environment_id, kind, status, runtime_metadata, denial_class, denial_code, denial_reason, dispatched_at, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, 'customer-runner', 'dispatching', $8::jsonb, NULL, NULL, NULL, now(), now())`,
      parameters: [
        id,
        applicationId,
        tenantId,
        executionId,
        `key-${id}`,
        `fp-${id}`,
        environmentId,
        JSON.stringify({
          kind: "customer-runner",
          environmentId,
          task: { command: "python3", args: [], publicEnv: {} },
        }),
      ],
    });
    return id;
  }

  async function insertAssignment(input: {
    applicationId: string;
    tenantId: string;
    executionId: string;
    sandboxId?: string;
    environmentId: string;
    runnerId: string;
    assignmentKey: string;
    status?: string;
  }) {
    const id = generateId();
    const sandboxId =
      input.sandboxId ??
      (await insertSandboxRow(
        input.applicationId,
        input.tenantId,
        input.executionId,
        input.environmentId,
      ));
    const status = input.status ?? "assigned";
    const terminalOutcome =
      status === "completed"
        ? { outcomeClass: "sandbox-success", failureClass: null }
        : status === "failed"
          ? { outcomeClass: "sandbox-failure", failureClass: "sandbox-execution" }
          : { outcomeClass: null, failureClass: null };
    await ctx.port.execute({
      sql: `INSERT INTO sandbox.runner_assignments (id, application_id, tenant_id, execution_id, sandbox_id, environment_id, runner_id, assignment_key, request_fingerprint, status, required_capabilities, lease_leased_at, lease_expires_at, lease_duration_ms, dispatched_at, reported_at, outcome_class, failure_class, provenance, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '["customer-runner","cpu","memory"]'::jsonb, now(), now() + interval '60 seconds', 60000, $12, $12, $13, $14, $11::jsonb, now(), now())`,
      parameters: [
        id,
        input.applicationId,
        input.tenantId,
        input.executionId,
        sandboxId,
        input.environmentId,
        input.runnerId,
        input.assignmentKey,
        `fp-${id}`,
        status,
        JSON.stringify({
          executionId: input.executionId,
          sandboxId,
          environmentId: input.environmentId,
          sandboxLedgerAdmittedSequence: null,
          runnerId: input.runnerId,
          runnerVersion: "1.2.3",
          actorId: "actor-1",
          cause: "runner-assignment",
          assignedAt: new Date().toISOString(),
          requiredCapabilities: ["customer-runner", "cpu", "memory"],
        }),
        status === "assigned" || status === "dispatched" || input.status === undefined
          ? null
          : new Date().toISOString(),
        terminalOutcome.outcomeClass,
        terminalOutcome.failureClass,
      ],
    });
    return id;
  }

  test("runner rows are never deleted; the identity core is write-once", async () => {
    const { tenantId, applicationId } = await seedScope();
    const environmentId = await seedEnvironment(applicationId, tenantId);
    const runnerId = await insertRunner(applicationId, tenantId, environmentId);
    await expect(
      ctx.port.execute({
        sql: "DELETE FROM sandbox.runners WHERE id = $1",
        parameters: [runnerId],
      }),
    ).rejects.toThrow(/never deleted/i);
    await expect(
      ctx.port.execute({
        sql: "UPDATE sandbox.runners SET runner_version = '2.0.0' WHERE id = $1",
        parameters: [runnerId],
      }),
    ).rejects.toThrow(/identity core is immutable/i);
    await expect(
      ctx.port.execute({
        sql: "UPDATE sandbox.runners SET token_fingerprint = 'other' WHERE id = $1",
        parameters: [runnerId],
      }),
    ).rejects.toThrow(/identity core is immutable/i);
    await expect(
      ctx.port.execute({
        sql: "UPDATE sandbox.runners SET declared_capabilities = '[\"cpu\"]'::jsonb WHERE id = $1",
        parameters: [runnerId],
      }),
    ).rejects.toThrow(/identity core is immutable/i);
    // The LEGAL mutations: authorization transitions + observations.
    await ctx.port.execute({
      sql: "UPDATE sandbox.runners SET authorization_status = 'authorized', authorized_at = now(), authorized_by_actor_id = 'actor-1', updated_at = now() WHERE id = $1",
      parameters: [runnerId],
    });
    await ctx.port.execute({
      sql: "UPDATE sandbox.runners SET health_status = 'healthy', last_heartbeat_at = now(), updated_at = now() WHERE id = $1",
      parameters: [runnerId],
    });
  });

  test("registration defaults UNTRUSTED; the vocabulary is CHECK-bound; revoked is terminal-immutable (M16)", async () => {
    const { tenantId, applicationId } = await seedScope();
    const environmentId = await seedEnvironment(applicationId, tenantId);
    const runnerId = await insertRunner(applicationId, tenantId, environmentId);
    const row = await ctx.port.execute<{ authorization_status: string }>({
      sql: "SELECT authorization_status FROM sandbox.runners WHERE id = $1",
      parameters: [runnerId],
    });
    expect(row.rows[0]?.authorization_status).toBe("untrusted");
    await expect(
      ctx.port.execute({
        sql: "UPDATE sandbox.runners SET authorization_status = 'trusted' WHERE id = $1",
        parameters: [runnerId],
      }),
    ).rejects.toThrow(/runners_authorization_vocabulary|cannot move authorization/i);
    // Authorize, then revoke; revoked rows refuse EVERY further mutation.
    await ctx.port.execute({
      sql: "UPDATE sandbox.runners SET authorization_status = 'authorized', authorized_at = now(), authorized_by_actor_id = 'actor-1', updated_at = now() WHERE id = $1",
      parameters: [runnerId],
    });
    await ctx.port.execute({
      sql: "UPDATE sandbox.runners SET authorization_status = 'revoked', authorized_at = NULL, authorized_by_actor_id = NULL, revoked_at = now(), revocation_reason = 'test', updated_at = now() WHERE id = $1",
      parameters: [runnerId],
    });
    await expect(
      ctx.port.execute({
        sql: "UPDATE sandbox.runners SET authorization_status = 'authorized', authorized_at = now(), authorized_by_actor_id = 'actor-1', updated_at = now() WHERE id = $1",
        parameters: [runnerId],
      }),
    ).rejects.toThrow(/terminal-immutable|cannot move authorization/i);
    await expect(
      ctx.port.execute({
        sql: "UPDATE sandbox.runners SET health_status = 'healthy', updated_at = now() WHERE id = $1",
        parameters: [runnerId],
      }),
    ).rejects.toThrow(/terminal-immutable/i);
  });

  test("the split-brain guard: a second ACTIVE assignment per runner is unrepresentable (M19)", async () => {
    const { tenantId, applicationId } = await seedScope();
    const environmentId = await seedEnvironment(applicationId, tenantId);
    const runnerId = await insertRunner(applicationId, tenantId, environmentId);
    const executionId = await seedExecution(applicationId, tenantId);
    await insertAssignment({
      applicationId,
      tenantId,
      executionId,
      environmentId,
      runnerId,
      assignmentKey: "active-1",
    });
    // A second ACTIVE row for the same runner is refused by the partial
    // unique index — no matter the key.
    await expect(
      insertAssignment({
        applicationId,
        tenantId,
        executionId,
        environmentId,
        runnerId,
        assignmentKey: "active-2",
      }),
    ).rejects.toThrow(/runner_assignments_active_slot/i);
    // A TERMINAL row for the same runner is fine (history accumulates).
    const terminalId = await insertAssignment({
      applicationId,
      tenantId,
      executionId,
      environmentId,
      runnerId,
      assignmentKey: "terminal-1",
      status: "completed",
    });
    await expect(
      ctx.port.execute({
        sql: "UPDATE sandbox.runner_assignments SET updated_at = now() WHERE id = $1",
        parameters: [terminalId],
      }),
    ).rejects.toThrow(/terminal-immutable/i);
  });

  test("assignment rows are never deleted; identity, lease and dispatch intent are immutable", async () => {
    const { tenantId, applicationId } = await seedScope();
    const environmentId = await seedEnvironment(applicationId, tenantId);
    const runnerId = await insertRunner(applicationId, tenantId, environmentId);
    const executionId = await seedExecution(applicationId, tenantId);
    const assignmentId = await insertAssignment({
      applicationId,
      tenantId,
      executionId,
      environmentId,
      runnerId,
      assignmentKey: "immutable-1",
    });
    await expect(
      ctx.port.execute({
        sql: "DELETE FROM sandbox.runner_assignments WHERE id = $1",
        parameters: [assignmentId],
      }),
    ).rejects.toThrow(/never deleted/i);
    await expect(
      ctx.port.execute({
        sql: "UPDATE sandbox.runner_assignments SET runner_id = $2 WHERE id = $1",
        parameters: [assignmentId, generateId()],
      }),
    ).rejects.toThrow(/identity, lease and dispatch intent are immutable/i);
    await expect(
      ctx.port.execute({
        sql: "UPDATE sandbox.runner_assignments SET lease_expires_at = now() + interval '999 seconds' WHERE id = $1",
        parameters: [assignmentId],
      }),
    ).rejects.toThrow(/identity, lease and dispatch intent are immutable/i);
    await expect(
      ctx.port.execute({
        sql: "UPDATE sandbox.runner_assignments SET request_fingerprint = 'other' WHERE id = $1",
        parameters: [assignmentId],
      }),
    ).rejects.toThrow(/identity, lease and dispatch intent are immutable/i);
  });

  test("the (application, assignment_key) uniqueness refuses duplicate logical assignments (M10)", async () => {
    const { tenantId, applicationId } = await seedScope();
    const environmentId = await seedEnvironment(applicationId, tenantId);
    const runnerA = await insertRunner(applicationId, tenantId, environmentId, "runner-a");
    const runnerB = await insertRunner(applicationId, tenantId, environmentId, "runner-b");
    const executionId = await seedExecution(applicationId, tenantId);
    await insertAssignment({
      applicationId,
      tenantId,
      executionId,
      environmentId,
      runnerId: runnerA,
      assignmentKey: "dup-key",
    });
    await expect(
      insertAssignment({
        applicationId,
        tenantId,
        executionId,
        environmentId,
        runnerId: runnerB,
        assignmentKey: "dup-key",
      }),
    ).rejects.toThrow(/runner_assignments_request_key/i);
  });

  test("composite FKs make cross-scope assignment rows unrepresentable (M1/M2/M9)", async () => {
    const scopeA = await seedScope();
    const scopeB = await seedScope();
    const environmentA = await seedEnvironment(scopeA.applicationId, scopeA.tenantId);
    const runnerA = await insertRunner(scopeA.applicationId, scopeA.tenantId, environmentA);
    const executionA = await seedExecution(scopeA.applicationId, scopeA.tenantId);
    // A valid parent sandbox row in scope A: the probes below keep every
    // parent reference VALID so the violation provably fires on the
    // RUNNER-ASSIGNMENT's own scope FK, not on an upstream insert.
    const sandboxA = await insertSandboxRow(
      scopeA.applicationId,
      scopeA.tenantId,
      executionA,
      environmentA,
    );
    // Cross-tenant runner assignment: the (application, tenant) FK refuses.
    await expect(
      insertAssignment({
        applicationId: scopeA.applicationId,
        tenantId: scopeB.tenantId,
        executionId: executionA,
        sandboxId: sandboxA,
        environmentId: environmentA,
        runnerId: runnerA,
        assignmentKey: "cross-tenant",
      }),
    ).rejects.toThrow(/runner_assignments_tenant_fk/i);
    // Cross-execution: a fabricated execution identity is refused.
    await expect(
      insertAssignment({
        applicationId: scopeA.applicationId,
        tenantId: scopeA.tenantId,
        executionId: generateId(),
        sandboxId: sandboxA,
        environmentId: environmentA,
        runnerId: runnerA,
        assignmentKey: "cross-execution",
      }),
    ).rejects.toThrow(/runner_assignments_execution_fk/i);
    // Cross-application runner: every OTHER reference is valid in scope B;
    // only the runner belongs to application A — the (runner, application)
    // composite FK refuses the cross-application assignment row.
    const environmentB = await seedEnvironment(scopeB.applicationId, scopeB.tenantId);
    const executionB = await seedExecution(scopeB.applicationId, scopeB.tenantId);
    const sandboxB = await insertSandboxRow(
      scopeB.applicationId,
      scopeB.tenantId,
      executionB,
      environmentB,
    );
    await expect(
      insertAssignment({
        applicationId: scopeB.applicationId,
        tenantId: scopeB.tenantId,
        executionId: executionB,
        sandboxId: sandboxB,
        environmentId: environmentB,
        runnerId: runnerA,
        assignmentKey: "cross-application",
      }),
    ).rejects.toThrow(/runner_assignments_runner_fk/i);
  });

  test("the assignment event trail is append-only with gapless per-assignment sequences (M18)", async () => {
    const { tenantId, applicationId } = await seedScope();
    const environmentId = await seedEnvironment(applicationId, tenantId);
    const runnerId = await insertRunner(applicationId, tenantId, environmentId);
    const executionId = await seedExecution(applicationId, tenantId);
    const assignmentId = await insertAssignment({
      applicationId,
      tenantId,
      executionId,
      environmentId,
      runnerId,
      assignmentKey: "events-1",
    });
    const appendEvent = async (sequence: number, event: string) => {
      await ctx.port.execute({
        sql: `INSERT INTO sandbox.runner_assignment_events (id, application_id, assignment_id, runner_id, execution_id, sequence, event, actor_id, cause, detail, occurred_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, 'actor-1', 'runner-assignment', '{}'::jsonb, now())`,
        parameters: [
          generateId(),
          applicationId,
          assignmentId,
          runnerId,
          executionId,
          sequence,
          event,
        ],
      });
    };
    await appendEvent(1, "assigned");
    await appendEvent(2, "dispatched");
    // Duplicate sequence refused.
    await expect(appendEvent(2, "dispatched")).rejects.toThrow(
      /runner_assignment_events_sequence_key/i,
    );
    // UPDATE and DELETE are refused by the triggers.
    await expect(
      ctx.port.execute({
        sql: "UPDATE sandbox.runner_assignment_events SET event = 'completed' WHERE assignment_id = $1",
        parameters: [assignmentId],
      }),
    ).rejects.toThrow(/append-only/i);
    await expect(
      ctx.port.execute({
        sql: "DELETE FROM sandbox.runner_assignment_events WHERE assignment_id = $1",
        parameters: [assignmentId],
      }),
    ).rejects.toThrow(/append-only/i);
  });

  // -------------------------------------------------------------------------
  // The governed service lifecycle over the real SQL fabric
  // -------------------------------------------------------------------------

  let world: RunnerFleetPgWorld;

  test("the full lifecycle: register → authorize → heartbeat → assign → dispatch → report, with the trail", async () => {
    world = await seedRunnerFleetWorld(ctx.port);
    const environmentId = await world.registerEnvironment();
    const runnerId = await world.registerRunner(environmentId);
    const runner = await world.fleet.getRunner(world.applicationId, runnerId);
    expect(runner?.authorizationStatus).toBe("authorized");
    expect(runner?.healthStatus).toBe("healthy");
    expect(runner?.tokenFingerprint).toMatch(/^[0-9a-f]{64}$/);
    // The token itself is never stored.
    const raw = await ctx.port.execute<{ count: string }>({
      sql: "SELECT count(*)::text AS count FROM sandbox.runners WHERE token_fingerprint LIKE '%' || $1 || '%' OR name LIKE '%' || $1 || '%'",
      parameters: [REGISTRATION_TOKEN],
    });
    expect(raw.rows[0]?.count).toBe("0");

    const ids = await world.seedSandbox(environmentId);
    const assignment = await world.fleet.assignRunner(
      {
        applicationId: world.applicationId,
        executionId: ids.executionId,
        sandboxId: ids.sandboxId,
        environmentId,
        runnerId,
        requiredCapabilities: REQUIRED,
      },
      "lifecycle-key",
      world.actor(),
    );
    expect(assignment.status).toBe("assigned");
    expect(assignment.provenance.executionId).toBe(ids.executionId);
    expect(assignment.provenance.sandboxId).toBe(ids.sandboxId);
    expect(assignment.provenance.runnerVersion).toBe("1.2.3");

    const handoff = await world.fleet.dispatchAssignment(
      { applicationId: world.applicationId, assignmentId: assignment.id },
      world.actor(),
    );
    expect(handoff.task.command).toBe("python3");
    expect(handoff.secretRefs).toEqual([]);

    const finalized = await world.fleet.reportResult(
      {
        applicationId: world.applicationId,
        assignmentId: assignment.id,
        report: {
          outcomeClass: "sandbox-success",
          outputDigest: "digest:pg-ok",
          output: { exitCode: 0 },
          usageMicroUsd: "3",
          failure: null,
        },
      },
      world.actor(),
    );
    expect(finalized.status).toBe("completed");

    const events = await world.fleet.listAssignmentEvents(world.applicationId, assignment.id);
    expect(events.map((e) => e.event)).toEqual(["assigned", "dispatched", "completed"]);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    // Provenance is preserved on the durable row.
    const stored = await world.fleet.getAssignment(world.applicationId, assignment.id);
    expect(stored?.provenance.executionId).toBe(ids.executionId);
  });

  test("duplicate registration converges on the same identity core; a different core conflicts", async () => {
    world = await seedRunnerFleetWorld(ctx.port);
    const environmentId = await world.registerEnvironment();
    const registration = {
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      environmentId,
      slug: "runner-alpha",
      name: "Alpha",
      runnerVersion: "1.2.3",
      declaredCapabilities: ["customer-runner", "cpu", "memory"] as const,
      registrationToken: REGISTRATION_TOKEN,
    };
    const first = await world.fleet.registerRunner(registration, "reg-1", world.actor());
    const replay = await world.fleet.registerRunner(registration, "reg-2", world.actor());
    expect(replay.id).toBe(first.id);
    await expectCode(
      world.fleet.registerRunner(
        { ...registration, runnerVersion: "1.3.0" },
        "reg-3",
        world.actor(),
      ),
      "SANDBOX_ERROR",
    );
    const count = await ctx.port.execute<{ count: string }>({
      sql: "SELECT count(*)::text AS count FROM sandbox.runners WHERE application_id = $1 AND slug = 'runner-alpha'",
      parameters: [world.applicationId],
    });
    expect(count.rows[0]?.count).toBe("1");
  });

  test("revocation is terminal and releases the active assignment; re-authorization is refused", async () => {
    world = await seedRunnerFleetWorld(ctx.port);
    const environmentId = await world.registerEnvironment();
    const runnerId = await world.registerRunner(environmentId);
    const ids = await world.seedSandbox(environmentId);
    const assignment = await world.fleet.assignRunner(
      {
        applicationId: world.applicationId,
        executionId: ids.executionId,
        sandboxId: ids.sandboxId,
        environmentId,
        runnerId,
        requiredCapabilities: REQUIRED,
      },
      "revoke-key",
      world.actor(),
    );
    await world.fleet.revokeRunner(
      { applicationId: world.applicationId, runnerId, reason: "offboarded" },
      "revoke-1",
      world.actor(),
    );
    const runner = await world.fleet.getRunner(world.applicationId, runnerId);
    expect(runner?.authorizationStatus).toBe("revoked");
    expect(runner?.revocationReason).toBe("offboarded");
    const after = await world.fleet.getAssignment(world.applicationId, assignment.id);
    expect(after?.status).toBe("released");
    expect(after?.releasedReason).toContain("offboarded");
    await expectCode(
      world.fleet.authorizeRunner(
        { applicationId: world.applicationId, runnerId },
        "authorize-late",
        world.actor(),
      ),
      "INVALID_STATE_TRANSITION",
    );
    // The released slot may be re-claimed by a NEW assignment.
    const freshIds = await world.seedSandbox(environmentId);
    const freshRunnerId = await world.registerRunner(environmentId);
    const fresh = await world.fleet.assignRunner(
      {
        applicationId: world.applicationId,
        executionId: freshIds.executionId,
        sandboxId: freshIds.sandboxId,
        environmentId,
        runnerId: freshRunnerId,
        requiredCapabilities: REQUIRED,
      },
      "revoke-key-2",
      world.actor(),
    );
    expect(fresh.status).toBe("assigned");
  });

  test("idempotency: same key + same request replays; a different fingerprint is the canonical error", async () => {
    world = await seedRunnerFleetWorld(ctx.port);
    const environmentId = await world.registerEnvironment();
    const runnerId = await world.registerRunner(environmentId);
    const ids = await world.seedSandbox(environmentId);
    const first = await world.fleet.assignRunner(
      {
        applicationId: world.applicationId,
        executionId: ids.executionId,
        sandboxId: ids.sandboxId,
        environmentId,
        runnerId,
        requiredCapabilities: REQUIRED,
      },
      "idem-key",
      world.actor(),
    );
    const replay = await world.fleet.assignRunner(
      {
        applicationId: world.applicationId,
        executionId: ids.executionId,
        sandboxId: ids.sandboxId,
        environmentId,
        runnerId,
        requiredCapabilities: [...REQUIRED].reverse(),
      },
      "idem-key",
      world.actor(),
    );
    expect(replay.id).toBe(first.id);
    const count = await ctx.port.execute<{ count: string }>({
      sql: "SELECT count(*)::text AS count FROM sandbox.runner_assignments WHERE application_id = $1 AND assignment_key = 'idem-key'",
      parameters: [world.applicationId],
    });
    expect(count.rows[0]?.count).toBe("1");
    await expectCode(
      world.fleet.assignRunner(
        {
          applicationId: world.applicationId,
          executionId: ids.executionId,
          sandboxId: ids.sandboxId,
          environmentId,
          runnerId,
          requiredCapabilities: ["customer-runner", "cpu", "memory", "filesystem"],
        },
        "idem-key",
        world.actor(),
      ),
      "IDEMPOTENCY_KEY_REUSED",
    );
  });

  test("scope rejections BEFORE assignment: tenant, application, environment, authorization, capability, busy, stale", async () => {
    world = await seedRunnerFleetWorld(ctx.port);
    const environmentId = await world.registerEnvironment();
    const runnerId = await world.registerRunner(environmentId);
    const ids = await world.seedSandbox(environmentId);
    const assign = (input: {
      actor?: { actorId: string; applicationId: string; tenantId: string };
      runnerId?: string;
      environmentId?: string;
      requiredCapabilities?: readonly string[];
      key?: string;
    }) =>
      world.fleet.assignRunner(
        {
          applicationId: world.applicationId,
          executionId: ids.executionId,
          sandboxId: ids.sandboxId,
          environmentId: input.environmentId ?? environmentId,
          runnerId: input.runnerId ?? runnerId,
          requiredCapabilities: input.requiredCapabilities ?? REQUIRED,
        },
        input.key ?? `scope-${generateId().slice(-6)}`,
        input.actor ?? world.actor(),
      );

    // Cross-tenant actor.
    await expectCode(
      assign({
        actor: {
          actorId: "00000000-0000-7000-8000-0000000000d2",
          applicationId: world.applicationId,
          tenantId: generateId(),
        },
      }),
      "TENANT_SCOPE_VIOLATION",
    );
    // Unregistered (or cross-application) runner id.
    await expectCode(assign({ runnerId: generateId() }), "TENANT_SCOPE_VIOLATION");
    // Unauthorized (freshly registered, never authorized) runner.
    const untrustedId = await world.registerRunner(environmentId, { authorize: false });
    await expectCode(
      assign({ runnerId: untrustedId, key: "scope-untrusted" }),
      "AUTHORIZATION_DENIED",
    );
    // Capability mismatch.
    await expectCode(
      assign({ requiredCapabilities: ["customer-runner", "gpu"], key: "scope-gpu" }),
      "CAPABILITY_UNAVAILABLE",
    );
    // Environment mismatch.
    const otherEnvironmentId = await world.registerEnvironment("runner-env-2");
    await expectCode(
      assign({ environmentId: otherEnvironmentId, key: "scope-env" }),
      "SANDBOX_ERROR",
    );
    // Stale heartbeat (world window is 30s; assignment far in the future).
    const staleRunnerId = await world.registerRunner(environmentId, {
      registrationToken: "runner-registration-token-stale",
    });
    await ctx.port.execute({
      sql: "UPDATE sandbox.runners SET last_heartbeat_at = now() - interval '120 seconds' WHERE id = $1",
      parameters: [staleRunnerId],
    });
    await expectCode(assign({ runnerId: staleRunnerId, key: "scope-stale" }), "NO_ELIGIBLE_ROUTE");
    // Busy runner.
    await assign({ key: "scope-busy-hold" });
    await expectCode(assign({ key: "scope-busy" }), "NO_ELIGIBLE_ROUTE");
    // Cross-application reads return NULL (the store is application-scoped).
    const otherApp = generateId();
    expect(await world.runnerStore.findRunner(otherApp, runnerId)).toBeNull();
    expect(await world.runnerStore.findRunnerAssignment(otherApp, generateId())).toBeNull();
  });

  test("lease expiry: late reports fail closed and expiry is terminal (fail-closed reconciliation)", async () => {
    // A 2s lease (10x the flake-prone minimum) keeps the assign → dispatch
    // sequence safe under load; the sleep below waits for the ACTUAL
    // deadline, so expiry semantics stay deterministic.
    world = await seedRunnerFleetWorld(ctx.port, { leaseDurationMs: 2000 });
    const environmentId = await world.registerEnvironment();
    const runnerId = await world.registerRunner(environmentId);
    const ids = await world.seedSandbox(environmentId);
    const assignment = await world.fleet.assignRunner(
      {
        applicationId: world.applicationId,
        executionId: ids.executionId,
        sandboxId: ids.sandboxId,
        environmentId,
        runnerId,
        requiredCapabilities: REQUIRED,
      },
      "lease-key",
      world.actor(),
    );
    await world.fleet.dispatchAssignment(
      { applicationId: world.applicationId, assignmentId: assignment.id },
      world.actor(),
    );
    await sleepPastLease(assignment.lease.leaseExpiresAt);
    await expectCode(
      world.fleet.reportResult(
        {
          applicationId: world.applicationId,
          assignmentId: assignment.id,
          report: {
            outcomeClass: "sandbox-success",
            outputDigest: null,
            output: null,
            usageMicroUsd: null,
            failure: null,
          },
        },
        world.actor(),
      ),
      "EXPIRED",
    );
    const expired = await world.fleet.expireAssignment(
      { applicationId: world.applicationId, assignmentId: assignment.id },
      world.actor(),
    );
    expect(expired.status).toBe("expired");
    // Terminal: further lifecycle calls are inert or refused.
    await expectCode(
      world.fleet.reportResult(
        {
          applicationId: world.applicationId,
          assignmentId: assignment.id,
          report: {
            outcomeClass: "sandbox-success",
            outputDigest: null,
            output: null,
            usageMicroUsd: null,
            failure: null,
          },
        },
        world.actor(),
      ),
      "EXPIRED",
    );
  });

  test("reconnect: token-fingerprint proof re-binds the SAME assignment; provenance survives (M11/M18)", async () => {
    world = await seedRunnerFleetWorld(ctx.port);
    const environmentId = await world.registerEnvironment();
    const runnerId = await world.registerRunner(environmentId);
    const ids = await world.seedSandbox(environmentId);
    const assignment = await world.fleet.assignRunner(
      {
        applicationId: world.applicationId,
        executionId: ids.executionId,
        sandboxId: ids.sandboxId,
        environmentId,
        runnerId,
        requiredCapabilities: REQUIRED,
      },
      "reconnect-key",
      world.actor(),
    );
    await world.fleet.dispatchAssignment(
      { applicationId: world.applicationId, assignmentId: assignment.id },
      world.actor(),
    );
    await world.fleet.markDisconnected(
      { applicationId: world.applicationId, runnerId },
      world.actor(),
    );
    const { runner, assignment: rebound } = await world.fleet.reconnectRunner(
      {
        applicationId: world.applicationId,
        runnerId,
        registrationToken: REGISTRATION_TOKEN,
      },
      world.actor(),
    );
    expect(runner.connectionStatus).toBe("connected");
    expect(rebound?.id).toBe(assignment.id);
    expect(rebound?.reconnectCount).toBe(1);
    // The wrong token is refused (external identifiers are not authorization).
    await expectCode(
      world.fleet.reconnectRunner(
        {
          applicationId: world.applicationId,
          runnerId,
          registrationToken: "runner-registration-token-wrong",
        },
        world.actor(),
      ),
      "AUTHORIZATION_DENIED",
    );
    // A second reconnect re-binds the SAME row — never a new assignment.
    const second = await world.fleet.reconnectRunner(
      {
        applicationId: world.applicationId,
        runnerId,
        registrationToken: REGISTRATION_TOKEN,
      },
      world.actor(),
    );
    expect(second.assignment?.id).toBe(assignment.id);
    expect(second.assignment?.reconnectCount).toBe(2);
    const count = await ctx.port.execute<{ count: string }>({
      sql: "SELECT count(*)::text AS count FROM sandbox.runner_assignments WHERE application_id = $1 AND execution_id = $2",
      parameters: [world.applicationId, ids.executionId],
    });
    expect(count.rows[0]?.count).toBe("1");
    const events = await world.fleet.listAssignmentEvents(world.applicationId, assignment.id);
    expect(events.map((e) => e.event)).toEqual([
      "assigned",
      "dispatched",
      "reconnected",
      "reconnected",
    ]);
  });

  test("the FULL governed dispatch: sandbox service → fleet → channel → external endpoint (real SQL)", async () => {
    world = await seedRunnerFleetWorld(ctx.port);
    const environmentId = await world.registerEnvironment();
    const runnerId = await world.registerRunner(environmentId);
    const endpoint = new InMemoryCustomerRunnerEndpoint({
      endpointRef: `endpoint-${runnerId.slice(-6)}`,
      observation: {
        outcomeClass: "sandbox-success",
        outputDigest: "digest:remote-pg-ok",
        output: { exitCode: 0, stdout: "remote ok" },
        usageMicroUsd: "11",
        failure: null,
      },
    });
    const channel = new CustomerRunnerChannel();
    channel.attachEndpoint(runnerId, endpoint);
    const service = world.buildSandboxService([
      new CustomerRunnerSandboxProvider({
        fleet: world.fleet,
        channel,
        sandboxStore: world.sandboxStore,
      }),
    ]);
    const executionId = await world.seedExecution();
    const created = await service.createSandboxExecution(
      {
        executionId,
        environmentId,
        task: { command: "python3", args: ["analyze.py"], publicEnv: { MODE: "batch" } },
      },
      `sandbox-${generateId()}`,
      world.actor(),
    );
    expect(created.status).toBe("admitted");
    const dispatched = await service.dispatchSandboxExecution(
      { applicationId: world.applicationId, sandboxId: created.id },
      world.actor(),
    );
    expect(dispatched.status).toBe("completed");
    expect(dispatched.outcomeClass).toBe("sandbox-success");
    expect(dispatched.outputDigest).toBe("digest:remote-pg-ok");
    // The external runner received exactly ONE sanitized handoff.
    expect(endpoint.handoffs).toHaveLength(1);
    const handoff = endpoint.handoffs[0] as RunnerHandoff;
    expect(handoff.executionId).toBe(executionId);
    expect(handoff.sandboxId).toBe(created.id);
    expect(handoff.secretRefs).toEqual([]);
    expect(JSON.stringify(handoff)).not.toContain(REGISTRATION_TOKEN);
    // Exactly ONE durable assignment, terminalized completed.
    const assignments = await world.fleet.listAssignmentsBySandbox(world.applicationId, created.id);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.status).toBe("completed");
    expect(assignments[0]?.executionId).toBe(executionId);
    // A retry of the completed sandbox replays — the runner is NOT re-run.
    const replay = await service.dispatchSandboxExecution(
      { applicationId: world.applicationId, sandboxId: created.id },
      world.actor(),
    );
    expect(replay.status).toBe("completed");
    expect(endpoint.handoffs).toHaveLength(1);
  });
});
