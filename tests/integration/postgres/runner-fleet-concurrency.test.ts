/**
 * Real-PostgreSQL — the runner fleet's CONCURRENCY / CRASH-SAFETY races
 * (WORK-019 §14, CRITICAL; checkpoint contracts IDENTITY-IDEMPOTENCY and
 * CONCURRENCY-CRASH-SAFETY — the executions-concurrency discipline,
 * restated for the fleet axis).
 *
 * Every race is run against the production composition (the real SQL
 * fabric over the provider-neutral DatabasePort) with Promise.allSettled
 * fan-outs; the arbiter is PostgreSQL's own uniqueness/transactional
 * arbitration:
 *
 *   * two executions → one runner (concurrent, different keys): exactly
 *     ONE assignment commits; the loser rejects NO_ELIGIBLE_ROUTE; at
 *     most one ACTIVE row exists per runner (no split-brain ownership);
 *   * N concurrent same-key assignment claims converge to ONE durable
 *     row, ONE `assigned` event and the SAME assignment id for every
 *     caller (the (application, key) unique index is the idempotency
 *     anchor);
 *   * same key + DIFFERENT request fingerprints: exactly one winner,
 *     every other caller gets the canonical IDEMPOTENCY_KEY_REUSED;
 *   * concurrent dispatch claims converge to ONE handoff (the same
 *     one-shot nonce is replayed to the loser — a retry never mints a
 *     second handoff);
 *   * concurrent result reports converge to ONE terminal outcome
 *     (first writer wins; the loser replays the committed row — never a
 *     second logical execution, never two terminal states);
 *   * assignment + revocation mid-flight: the report either lands before
 *     the revocation or is refused (AUTHORIZATION_DENIED); the active
 *     assignment is released exactly once; a revoked runner never holds
 *     an active slot;
 *   * release + reassignment race: the freed slot admits exactly ONE new
 *     assignment (the partial unique index arbitrates the release/claim
 *     race — no two ACTIVE rows are ever observable, M19);
 *   * the physical health guard (M20): the same-statement insert is
 *     refused when the heartbeat predates the cutoff — a dead runner is
 *     unassignable even under a race-shaped direct store call;
 *   * runner reconnect AFTER lease expiry: the runner re-attaches (token
 *     fingerprint proof) but the expired assignment stays terminal — no
 *     revival, no second assignment, and a late report fails closed;
 *   * concurrent reconnects + reports keep the append-only event trail
 *     gapless and duplicate-free (the per-assignment FOR UPDATE
 *     sequence computation serializes).
 *
 * True crash-recovery (process death mid-transaction) is PostgreSQL's
 * own guarantee and is exercised by the transactional arbitration above;
 * this suite proves the CONVERGENCE contracts the fleet relies on.
 */

import { expect, test } from "vitest";
import { PlatformError } from "../../../src/shared/errors";
import { definePgSuite } from "./harness";
import { generateId, type RunnerFleetPgWorld, seedRunnerFleetWorld } from "./runner-fleet-world";

const REQUIRED = ["customer-runner", "cpu", "memory"];

const SUCCESS_REPORT = {
  outcomeClass: "sandbox-success" as const,
  outputDigest: "digest:converged",
  output: null,
  usageMicroUsd: "0",
  failure: null,
};

const FAILURE_REPORT = {
  outcomeClass: "sandbox-failure" as const,
  outputDigest: null,
  output: null,
  usageMicroUsd: null,
  failure: {
    failureClass: "sandbox-execution" as const,
    message: "runner exited non-zero",
    retryable: false,
  },
};

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

definePgSuite("runner fleet concurrency and crash safety (real PG)", (ctx) => {
  let world: RunnerFleetPgWorld;

  async function assignedWorld(): Promise<{
    environmentId: string;
    runnerId: string;
    ids: { sandboxId: string; executionId: string };
  }> {
    const environmentId = await world.registerEnvironment();
    const runnerId = await world.registerRunner(environmentId);
    const ids = await world.seedSandbox(environmentId);
    return { environmentId, runnerId, ids };
  }

  async function activeCount(runnerId: string): Promise<number> {
    const rows = await ctx.port.execute<{ count: string }>({
      sql: "SELECT count(*)::text AS count FROM sandbox.runner_assignments WHERE application_id = $1 AND runner_id = $2 AND status IN ('assigned', 'dispatched')",
      parameters: [world.applicationId, runnerId],
    });
    return Number(rows.rows[0]?.count ?? "0");
  }

  test("two executions race for ONE runner: exactly one assignment commits, the loser rejects (no split-brain)", async () => {
    world = await seedRunnerFleetWorld(ctx.port);
    const { environmentId, runnerId, ids } = await assignedWorld();
    const secondIds = await world.seedSandbox(environmentId);
    for (let round = 1; round <= 3; round += 1) {
      const outcomes = await Promise.allSettled([
        world.fleet.assignRunner(
          {
            applicationId: world.applicationId,
            executionId: ids.executionId,
            sandboxId: ids.sandboxId,
            environmentId,
            runnerId,
            requiredCapabilities: REQUIRED,
          },
          `two-exec-a-${round}`,
          world.actor(),
        ),
        world.fleet.assignRunner(
          {
            applicationId: world.applicationId,
            executionId: secondIds.executionId,
            sandboxId: secondIds.sandboxId,
            environmentId,
            runnerId,
            requiredCapabilities: REQUIRED,
          },
          `two-exec-b-${round}`,
          world.actor(),
        ),
      ]);
      // The FIRST round creates the slot; later rounds must both reject
      // (the runner already holds its one active assignment).
      if (round === 1) {
        const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
        expect(fulfilled).toHaveLength(1);
        const rejected = outcomes.find((o) => o.status === "rejected");
        expect(rejected?.status).toBe("rejected");
        if (rejected?.status === "rejected") {
          expect(rejected.reason).toBeInstanceOf(PlatformError);
          expect((rejected.reason as PlatformError).code).toBe("NO_ELIGIBLE_ROUTE");
        }
      } else {
        for (const outcome of outcomes) {
          expect(outcome.status).toBe("rejected");
          if (outcome.status === "rejected") {
            expect((outcome.reason as PlatformError).code).toBe("NO_ELIGIBLE_ROUTE");
          }
        }
      }
      // Exactly ONE active row — never two, in ANY interleaving.
      expect(await activeCount(runnerId)).toBe(1);
    }
    // Cleanup for the next round: release the slot deterministically.
    const active = await world.runnerStore.findActiveAssignmentByRunner(
      world.applicationId,
      runnerId,
    );
    expect(active).not.toBeNull();
    if (active !== null) {
      await world.fleet.releaseAssignment(
        { applicationId: world.applicationId, assignmentId: active.id, reason: "race-cleanup" },
        world.actor(),
      );
    }
    expect(await activeCount(runnerId)).toBe(0);
  });

  test("N=8 concurrent same-key claims converge to ONE row, ONE event, the SAME assignment id", async () => {
    world = await seedRunnerFleetWorld(ctx.port);
    const { environmentId, runnerId, ids } = await assignedWorld();
    const CALLERS = 8;
    const key = `converge-${generateId()}`;
    const outcomes = await Promise.allSettled(
      Array.from({ length: CALLERS }, (_, i) =>
        world.fleet.assignRunner(
          {
            applicationId: world.applicationId,
            executionId: ids.executionId,
            sandboxId: ids.sandboxId,
            environmentId,
            runnerId,
            requiredCapabilities: [...REQUIRED, i === 0 ? "network" : "network"],
          },
          key,
          world.actor(),
        ),
      ),
    );
    // Every caller received the SAME durable assignment — none errored.
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejectedDetail = outcomes
      .filter((o) => o.status === "rejected")
      .map((o) => (o.status === "rejected" ? `${(o.reason as Error).message}` : ""))
      .join(" | ");
    expect(
      fulfilled.length,
      `every same-key claim must converge; rejected: ${rejectedDetail}`,
    ).toBe(CALLERS);
    const records = fulfilled.map(
      (o) =>
        (o as PromiseFulfilledResult<Awaited<ReturnType<typeof world.fleet.assignRunner>>>).value,
    );
    expect(new Set(records.map((r) => r.id)).size).toBe(1);
    // Exactly ONE durable row for the key.
    const rows = await ctx.port.execute<{ count: string }>({
      sql: "SELECT count(*)::text AS count FROM sandbox.runner_assignments WHERE application_id = $1 AND assignment_key = $2",
      parameters: [world.applicationId, key],
    });
    expect(rows.rows[0]?.count).toBe("1");
    // Exactly ONE `assigned` event (losers converged, never re-journaled).
    const events = await world.fleet.listAssignmentEvents(
      world.applicationId,
      records[0]?.id ?? "",
    );
    expect(events.filter((e) => e.event === "assigned")).toHaveLength(1);
    expect(await activeCount(runnerId)).toBe(1);
  });

  test("same key + different fingerprints: one winner, IDEMPOTENCY_KEY_REUSED for every other caller", async () => {
    world = await seedRunnerFleetWorld(ctx.port);
    const { environmentId, runnerId, ids } = await assignedWorld();
    const otherIds = await world.seedSandbox(environmentId);
    const key = `reuse-${generateId()}`;
    const outcomes = await Promise.allSettled([
      world.fleet.assignRunner(
        {
          applicationId: world.applicationId,
          executionId: ids.executionId,
          sandboxId: ids.sandboxId,
          environmentId,
          runnerId,
          requiredCapabilities: REQUIRED,
        },
        key,
        world.actor(),
      ),
      world.fleet.assignRunner(
        {
          applicationId: world.applicationId,
          // A DIFFERENT parent sandbox = a different request fingerprint
          // under the same key (all other gates pass identically).
          executionId: otherIds.executionId,
          sandboxId: otherIds.sandboxId,
          environmentId,
          runnerId,
          requiredCapabilities: REQUIRED,
        },
        key,
        world.actor(),
      ),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    for (const outcome of rejected) {
      if (outcome.status === "rejected") {
        expect((outcome.reason as PlatformError).code).toBe("IDEMPOTENCY_KEY_REUSED");
      }
    }
    const rows = await ctx.port.execute<{ count: string }>({
      sql: "SELECT count(*)::text AS count FROM sandbox.runner_assignments WHERE application_id = $1 AND assignment_key = $2",
      parameters: [world.applicationId, key],
    });
    expect(rows.rows[0]?.count).toBe("1");
  });

  test("concurrent dispatch claims converge to ONE handoff (the same nonce replays to the loser)", async () => {
    world = await seedRunnerFleetWorld(ctx.port);
    const { environmentId, runnerId, ids } = await assignedWorld();
    const assignment = await world.fleet.assignRunner(
      {
        applicationId: world.applicationId,
        executionId: ids.executionId,
        sandboxId: ids.sandboxId,
        environmentId,
        runnerId,
        requiredCapabilities: REQUIRED,
      },
      `dispatch-race-${generateId()}`,
      world.actor(),
    );
    const outcomes = await Promise.allSettled([
      world.fleet.dispatchAssignment(
        { applicationId: world.applicationId, assignmentId: assignment.id },
        world.actor(),
      ),
      world.fleet.dispatchAssignment(
        { applicationId: world.applicationId, assignmentId: assignment.id },
        world.actor(),
      ),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    expect(fulfilled).toHaveLength(2);
    const handoffs = fulfilled.map(
      (o) =>
        (o as PromiseFulfilledResult<Awaited<ReturnType<typeof world.fleet.dispatchAssignment>>>)
          .value,
    );
    // ONE handoff identity: the nonce is the one-shot dispatch intent.
    expect(new Set(handoffs.map((h) => h.handoffNonce)).size).toBe(1);
    expect(new Set(handoffs.map((h) => h.assignmentId)).size).toBe(1);
    // ONE durable dispatched row, ONE dispatched event.
    const events = await world.fleet.listAssignmentEvents(world.applicationId, assignment.id);
    expect(events.filter((e) => e.event === "dispatched")).toHaveLength(1);
    const stored = await world.fleet.getAssignment(world.applicationId, assignment.id);
    expect(stored?.status).toBe("dispatched");
    expect(stored?.handoffNonce).toBe(handoffs[0]?.handoffNonce);
  });

  test("concurrent result reports converge to ONE terminal outcome (first writer wins, loser replays)", async () => {
    world = await seedRunnerFleetWorld(ctx.port);
    const { environmentId, runnerId, ids } = await assignedWorld();
    const assignment = await world.fleet.assignRunner(
      {
        applicationId: world.applicationId,
        executionId: ids.executionId,
        sandboxId: ids.sandboxId,
        environmentId,
        runnerId,
        requiredCapabilities: REQUIRED,
      },
      `report-race-${generateId()}`,
      world.actor(),
    );
    await world.fleet.dispatchAssignment(
      { applicationId: world.applicationId, assignmentId: assignment.id },
      world.actor(),
    );
    const outcomes = await Promise.allSettled([
      world.fleet.reportResult(
        { applicationId: world.applicationId, assignmentId: assignment.id, report: SUCCESS_REPORT },
        world.actor(),
      ),
      world.fleet.reportResult(
        { applicationId: world.applicationId, assignmentId: assignment.id, report: FAILURE_REPORT },
        world.actor(),
      ),
    ]);
    // One of the two terminal outcomes committed; the OTHER caller
    // converged on the committed row (first writer wins — the store's
    // guarded UPDATE converges, never a second terminal state).
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    expect(fulfilled).toHaveLength(2);
    const records = fulfilled.map(
      (o) =>
        (o as PromiseFulfilledResult<Awaited<ReturnType<typeof world.fleet.reportResult>>>).value,
    );
    expect(new Set(records.map((r) => r.status)).size).toBe(1);
    expect(new Set(records.map((r) => r.outcomeClass)).size).toBe(1);
    // The durable row is ONE terminal row with ONE outcome.
    const stored = await world.fleet.getAssignment(world.applicationId, assignment.id);
    expect(stored?.status === "completed" || stored?.status === "failed").toBe(true);
    expect(stored?.status).toBe(records[0]?.status);
    // Exactly ONE report-family event (completed|failed), never both.
    const events = await world.fleet.listAssignmentEvents(world.applicationId, assignment.id);
    const terminalEvents = events.filter((e) => e.event === "completed" || e.event === "failed");
    expect(terminalEvents).toHaveLength(1);
    // No active slot remains.
    expect(await activeCount(runnerId)).toBe(0);
    // ONE logical execution identity across the whole race.
    const byExecution = await world.fleet.listAssignmentsByExecution(
      world.applicationId,
      ids.executionId,
    );
    expect(byExecution).toHaveLength(1);
  });

  test("revocation racing a mid-flight report: the outcome either lands or is refused — the slot is released exactly once", async () => {
    world = await seedRunnerFleetWorld(ctx.port);
    const { environmentId, runnerId, ids } = await assignedWorld();
    const assignment = await world.fleet.assignRunner(
      {
        applicationId: world.applicationId,
        executionId: ids.executionId,
        sandboxId: ids.sandboxId,
        environmentId,
        runnerId,
        requiredCapabilities: REQUIRED,
      },
      `revoke-race-${generateId()}`,
      world.actor(),
    );
    await world.fleet.dispatchAssignment(
      { applicationId: world.applicationId, assignmentId: assignment.id },
      world.actor(),
    );
    const outcomes = await Promise.allSettled([
      world.fleet.reportResult(
        { applicationId: world.applicationId, assignmentId: assignment.id, report: SUCCESS_REPORT },
        world.actor(),
      ),
      // The SERVICE-level revocation racing the report: it revokes the
      // runner AND sweeps the active assignment (fail-closed release) —
      // exactly the crash-safety shape the Work Order demands.
      world.fleet.revokeRunner(
        { applicationId: world.applicationId, runnerId, reason: "operator revocation race" },
        `revoke-race-${generateId()}`,
        world.actor(),
      ),
    ]);
    const [reportOutcome, revokeOutcome] = outcomes;
    expect(revokeOutcome.status).toBe("fulfilled");
    // The report either landed BEFORE the revocation committed (its own
    // transaction serialized first) or was refused with
    // AUTHORIZATION_DENIED — never a third state.
    if (reportOutcome.status === "fulfilled") {
      expect(reportOutcome.value.status).toBe("completed");
    } else {
      expect((reportOutcome.reason as PlatformError).code).toBe("AUTHORIZATION_DENIED");
    }
    // The runner is revoked; it holds NO active assignment (the sweep
    // released it exactly once), and a NEW assignment for it is refused.
    expect(await activeCount(runnerId)).toBe(0);
    const thirdIds = await world.seedSandbox(environmentId);
    const error = await expectCode(
      world.fleet.assignRunner(
        {
          applicationId: world.applicationId,
          executionId: thirdIds.executionId,
          sandboxId: thirdIds.sandboxId,
          environmentId,
          runnerId,
          requiredCapabilities: REQUIRED,
        },
        `after-revoke-${generateId()}`,
        world.actor(),
      ),
      "AUTHORIZATION_DENIED",
    );
    expect(error.message).toContain("never");
  });

  test("release + reassignment race: the freed slot admits exactly ONE new assignment (M19)", async () => {
    world = await seedRunnerFleetWorld(ctx.port);
    const { environmentId, runnerId, ids } = await assignedWorld();
    const first = await world.fleet.assignRunner(
      {
        applicationId: world.applicationId,
        executionId: ids.executionId,
        sandboxId: ids.sandboxId,
        environmentId,
        runnerId,
        requiredCapabilities: REQUIRED,
      },
      `release-race-1-${generateId()}`,
      world.actor(),
    );
    const secondIds = await world.seedSandbox(environmentId);
    // The release and a NEW assignment race for the runner's slot.
    const outcomes = await Promise.allSettled([
      world.fleet.releaseAssignment(
        { applicationId: world.applicationId, assignmentId: first.id, reason: "race-release" },
        world.actor(),
      ),
      world.fleet.assignRunner(
        {
          applicationId: world.applicationId,
          executionId: secondIds.executionId,
          sandboxId: secondIds.sandboxId,
          environmentId,
          runnerId,
          requiredCapabilities: REQUIRED,
        },
        `release-race-2-${generateId()}`,
        world.actor(),
      ),
    ]);
    // EITHER the release committed first (the new assignment lands in the
    // freed slot) OR the new assignment refused while the old slot was
    // still active — in EVERY interleaving at most ONE active row exists.
    expect(await activeCount(runnerId)).toBeLessThanOrEqual(1);
    const rejected = outcomes.filter((o) => o.status === "rejected");
    for (const outcome of rejected) {
      if (outcome.status === "rejected") {
        expect((outcome.reason as PlatformError).code).toBe("NO_ELIGIBLE_ROUTE");
      }
    }
    // The first row is terminal (released) exactly once — idempotent
    // release replays, never a second terminal transition.
    const reRelease = await world.fleet.releaseAssignment(
      { applicationId: world.applicationId, assignmentId: first.id, reason: "re-release" },
      world.actor(),
    );
    expect(reRelease.status).toBe("released");
    expect(await activeCount(runnerId)).toBeLessThanOrEqual(1);
  });

  test("the physical health guard: a heartbeat older than the cutoff refuses the SAME-STATEMENT insert (M20)", async () => {
    world = await seedRunnerFleetWorld(ctx.port);
    const environmentId = await world.registerEnvironment();
    const runnerId = await world.registerRunner(environmentId);
    const ids = await world.seedSandbox(environmentId);
    const runner = await world.fleet.getRunner(world.applicationId, runnerId);
    expect(runner).not.toBeNull();
    // The race shape: the guard is evaluated INSIDE the insert statement —
    // a heartbeat that predates the cutoff refuses the insert even though
    // the runner row exists, is authorized and (was) healthy.
    const staleCutoff = new Date(Date.now() + 60_000).toISOString();
    const refused = await world.runnerStore.insertRunnerAssignment({
      id: generateId(),
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      executionId: ids.executionId,
      sandboxId: ids.sandboxId,
      environmentId,
      runnerId,
      assignmentKey: `health-race-stale-${generateId()}`,
      requestFingerprint: `fp-${generateId()}`,
      requiredCapabilities: REQUIRED,
      lease: {
        leasedAt: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        leaseDurationMs: 60_000,
      },
      provenance: {
        executionId: ids.executionId,
        sandboxId: ids.sandboxId,
        environmentId,
        sandboxLedgerAdmittedSequence: null,
        runnerId,
        runnerVersion: runner?.runnerVersion ?? "1.2.3",
        actorId: world.actor().actorId,
        cause: "runner-assignment",
        assignedAt: new Date().toISOString(),
        requiredCapabilities: REQUIRED,
      },
      createdAt: new Date().toISOString(),
      heartbeatCutoff: staleCutoff,
    });
    expect(refused.claimed).toBe(false);
    expect(refused.record).toBeNull();
    // No row was written for the refused key.
    const rows = await ctx.port.execute<{ count: string }>({
      sql: "SELECT count(*)::text AS count FROM sandbox.runner_assignments WHERE application_id = $1 AND runner_id = $2",
      parameters: [world.applicationId, runnerId],
    });
    expect(rows.rows[0]?.count).toBe("0");
    // The fresh-heartbeat insert still succeeds (the guard is precise,
    // not blanket denial).
    const accepted = await world.runnerStore.insertRunnerAssignment({
      id: generateId(),
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      executionId: ids.executionId,
      sandboxId: ids.sandboxId,
      environmentId,
      runnerId,
      assignmentKey: `health-race-fresh-${generateId()}`,
      requestFingerprint: `fp-${generateId()}`,
      requiredCapabilities: REQUIRED,
      lease: {
        leasedAt: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        leaseDurationMs: 60_000,
      },
      provenance: {
        executionId: ids.executionId,
        sandboxId: ids.sandboxId,
        environmentId,
        sandboxLedgerAdmittedSequence: null,
        runnerId,
        runnerVersion: runner?.runnerVersion ?? "1.2.3",
        actorId: world.actor().actorId,
        cause: "runner-assignment",
        assignedAt: new Date().toISOString(),
        requiredCapabilities: REQUIRED,
      },
      createdAt: new Date().toISOString(),
      heartbeatCutoff: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(accepted.claimed).toBe(true);
    expect(accepted.record?.status).toBe("assigned");
  });

  test("reconnect AFTER lease expiry: the runner re-attaches but the expired assignment stays terminal (no revival, no second execution)", async () => {
    // A 2s lease (10x the flake-prone minimum) keeps the assign → dispatch
    // sequence safe under load; the sleep below waits for the ACTUAL
    // deadline, so expiry semantics stay deterministic.
    world = await seedRunnerFleetWorld(ctx.port, { leaseDurationMs: 2000 });
    const { environmentId, runnerId, ids } = await assignedWorld();
    const assignment = await world.fleet.assignRunner(
      {
        applicationId: world.applicationId,
        executionId: ids.executionId,
        sandboxId: ids.sandboxId,
        environmentId,
        runnerId,
        requiredCapabilities: REQUIRED,
      },
      `reconnect-timeout-${generateId()}`,
      world.actor(),
    );
    await world.fleet.dispatchAssignment(
      { applicationId: world.applicationId, assignmentId: assignment.id },
      world.actor(),
    );
    await sleepPastLease(assignment.lease.leaseExpiresAt);
    const expired = await world.fleet.expireAssignment(
      { applicationId: world.applicationId, assignmentId: assignment.id },
      world.actor(),
    );
    expect(expired.status).toBe("expired");
    // The runner reconnects AFTER the timeout: identity proof succeeds,
    // the runner is connected, but the terminal assignment is NOT
    // revived and NO new assignment is minted.
    const { runner, assignment: reattached } = await world.fleet.reconnectRunner(
      {
        applicationId: world.applicationId,
        runnerId,
        registrationToken: "runner-registration-token-0001",
      },
      world.actor(),
    );
    expect(runner.connectionStatus).toBe("connected");
    expect(reattached).toBeNull();
    // A late report fails closed — the outcome cannot be proven convergent.
    await expectCode(
      world.fleet.reportResult(
        { applicationId: world.applicationId, assignmentId: assignment.id, report: SUCCESS_REPORT },
        world.actor(),
      ),
      "EXPIRED",
    );
    // Exactly ONE assignment exists for the execution: identity survived
    // the disconnect/expiry/reconnect cycle without duplication (M9/M11).
    const byExecution = await world.fleet.listAssignmentsByExecution(
      world.applicationId,
      ids.executionId,
    );
    expect(byExecution).toHaveLength(1);
    expect(byExecution[0]?.status).toBe("expired");
    // The expired runner slot is free for NEW work (the expired row is
    // not an active assignment).
    expect(await activeCount(runnerId)).toBe(0);
  });

  test("concurrent reconnects + a racing report keep the event trail gapless and duplicate-free (M18)", async () => {
    world = await seedRunnerFleetWorld(ctx.port);
    const { environmentId, runnerId, ids } = await assignedWorld();
    const assignment = await world.fleet.assignRunner(
      {
        applicationId: world.applicationId,
        executionId: ids.executionId,
        sandboxId: ids.sandboxId,
        environmentId,
        runnerId,
        requiredCapabilities: REQUIRED,
      },
      `trail-race-${generateId()}`,
      world.actor(),
    );
    await world.fleet.dispatchAssignment(
      { applicationId: world.applicationId, assignmentId: assignment.id },
      world.actor(),
    );
    const outcomes = await Promise.allSettled([
      world.fleet.reconnectRunner(
        {
          applicationId: world.applicationId,
          runnerId,
          registrationToken: "runner-registration-token-0001",
        },
        world.actor(),
      ),
      world.fleet.reconnectRunner(
        {
          applicationId: world.applicationId,
          runnerId,
          registrationToken: "runner-registration-token-0001",
        },
        world.actor(),
      ),
      world.fleet.reportResult(
        { applicationId: world.applicationId, assignmentId: assignment.id, report: SUCCESS_REPORT },
        world.actor(),
      ),
    ]);
    // The report either lands (after/before the reconnects) or is refused
    // as the row converged — every caller gets a typed outcome.
    const reportOutcome = outcomes[2];
    expect(
      reportOutcome.status === "fulfilled" ||
        (reportOutcome.status === "rejected" &&
          (reportOutcome.reason as PlatformError).code === "INVALID_STATE_TRANSITION"),
    ).toBe(true);
    // The trail is strictly sequential: 1..N with no gaps/duplicates.
    const events = await world.fleet.listAssignmentEvents(world.applicationId, assignment.id);
    expect(events.length).toBeGreaterThan(2);
    expect(events.map((e) => e.sequence)).toEqual(
      Array.from({ length: events.length }, (_, i) => i + 1),
    );
    // The reconnect bookkeeping converged on the same assignment row.
    const byExecution = await world.fleet.listAssignmentsByExecution(
      world.applicationId,
      ids.executionId,
    );
    expect(byExecution).toHaveLength(1);
  });
});
