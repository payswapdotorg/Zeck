/**
 * Real-PostgreSQL: executions concurrent duplicate-create convergence and
 * sequence integrity (WORK-006 acceptance criterion 4; checkpoints
 * IDENTITY-IDEMPOTENCY and CONCURRENCY-CRASH-SAFETY — multi-round stress
 * mirroring the WORK-002/004 owner-retention/overspend suites).
 *
 *   * N concurrent createExecution calls with the SAME idempotency key
 *     converge to EXACTLY one execution identity and one creation
 *     envelope; every caller receives the same logical outcome (the first
 *     writer's result; losers replay — never errors), proven across
 *     multiple rounds with fresh keys (and different caller actor ids:
 *     application-scoped arbitration is actor-independent per contract);
 *   * N concurrent SAME-KEY transition retries converge to one committed
 *     transition + one envelope;
 *   * concurrent DIFFERENT-KEY transitions racing on the same execution:
 *     exactly one commits per legal edge (row-lock re-derivation), the
 *     loser rejects INVALID_STATE_TRANSITION, sequences stay gapless and
 *     duplicate-free;
 *   * the convergence guard is PostgreSQL uniqueness/transactional
 *     arbitration itself — the discrimination suite proves the scenarios
 *     detect the guard-removed mutant (red record R1).
 */

import { expect, test } from "vitest";
import {
  actorOf,
  baseCreateInput,
  type ExecutionsWorld,
  seedExecutionsWorld,
  transitionScope,
} from "./executions-world";
import { definePgSuite } from "./harness";

definePgSuite("executions concurrent create convergence (real PG)", (ctx) => {
  let world: ExecutionsWorld;

  const CALLERS = 8;

  test("multi-round: N=8 concurrent same-key creates converge to ONE identity + ONE creation event; losers replay", async () => {
    world = await seedExecutionsWorld(ctx.port);
    for (let round = 1; round <= 6; round += 1) {
      const key = `converge-key-${round}`;
      // Distinct actor ids per caller: arbitration scope is the
      // application, not the actor (spec/contracts.md).
      const callers = Array.from({ length: CALLERS }, (_, i) => ({
        ...actorOf(world),
        actorId: `00000000-0000-7000-8000-${String(i + 1).padStart(12, "0")}`,
      }));
      const results = await Promise.allSettled(
        callers.map((actor) =>
          world.service.createExecution(baseCreateInput(world.applicationId), key, actor),
        ),
      );
      // All callers received the SAME logical outcome — none errored.
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      expect(fulfilled).toHaveLength(CALLERS);
      const receipts = fulfilled.map(
        (r) =>
          (r as PromiseFulfilledResult<Awaited<ReturnType<typeof world.service.createExecution>>>)
            .value,
      );
      const identities = new Set(receipts.map((r) => r.executionId));
      expect(identities.size).toBe(1);
      const executionId = receipts[0]?.executionId ?? "";
      // Exactly one first-winner; every other caller replayed the outcome.
      expect(receipts.filter((r) => !r.replayed)).toHaveLength(1);
      expect(receipts.filter((r) => r.replayed)).toHaveLength(CALLERS - 1);
      // Exactly ONE execution row and ONE creation envelope for this key.
      const rows = await ctx.port.execute<{ count: string }>({
        sql: "SELECT count(*)::text AS count FROM executions.executions WHERE application_id = $1 AND request_fingerprint IS NOT NULL AND id = $2",
        parameters: [world.applicationId, executionId],
      });
      expect(rows.rows[0]?.count).toBe("1");
      const events = await world.service.listEvents(world.applicationId, executionId);
      expect(events).toHaveLength(1);
      expect(events[0]?.command).toBe("create");
      expect(events[0]?.sequence).toBe(1);
    }
    // Six rounds: exactly six executions exist for this application.
    const total = await ctx.port.execute<{ count: string }>({
      sql: "SELECT count(*)::text AS count FROM executions.executions WHERE application_id = $1",
      parameters: [world.applicationId],
    });
    expect(total.rows[0]?.count).toBe("6");
  });

  test("N=16 wider fan-out converges identically (one identity, one event)", async () => {
    world = await seedExecutionsWorld(ctx.port);
    const callers = Array.from({ length: 16 }, (_, i) => ({
      ...actorOf(world),
      actorId: `00000000-0000-7000-8000-${String(i + 1).padStart(12, "0")}`,
    }));
    const results = await Promise.all(
      callers.map((actor) =>
        world.service.createExecution(baseCreateInput(world.applicationId), "wide-key", actor),
      ),
    );
    expect(new Set(results.map((r) => r.executionId)).size).toBe(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(15);
    const events = await world.service.listEvents(
      world.applicationId,
      results[0]?.executionId ?? "",
    );
    expect(events).toHaveLength(1);
  });

  test("concurrent same-key authorize retries converge to ONE transition + ONE envelope", async () => {
    world = await seedExecutionsWorld(ctx.port);
    const created = await world.service.createExecution(
      baseCreateInput(world.applicationId),
      "t-key",
      actorOf(world),
    );
    const outcomes = await Promise.allSettled(
      Array.from({ length: CALLERS }, () =>
        world.service.transition(
          { ...transitionScope(world, created.executionId), command: "authorize" },
          "auth-key",
        ),
      ),
    );
    const fulfilled = outcomes.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(CALLERS);
    const values = fulfilled.map(
      (r) =>
        (r as PromiseFulfilledResult<Awaited<ReturnType<typeof world.service.transition>>>).value,
    );
    expect(values.every((o) => o.execution.status === "AUTHORIZED")).toBe(true);
    expect(values.filter((o) => !o.replayed)).toHaveLength(1);
    const events = await world.service.listEvents(world.applicationId, created.executionId);
    expect(events).toHaveLength(2);
    expect(events[1]?.command).toBe("authorize");
  });

  test("concurrent DIFFERENT-KEY legal transitions: one commits, loser re-derives under the lock and rejects", async () => {
    world = await seedExecutionsWorld(ctx.port);
    for (let round = 1; round <= 5; round += 1) {
      const created = await world.service.createExecution(
        baseCreateInput(world.applicationId),
        `race-${round}`,
        actorOf(world),
      );
      const outcomes = await Promise.allSettled([
        world.service.transition(
          { ...transitionScope(world, created.executionId), command: "authorize" },
          `race-${round}-auth`,
        ),
        world.service.transition(
          { ...transitionScope(world, created.executionId), command: "cancel" },
          `race-${round}-cancel`,
        ),
      ]);
      const committed = outcomes.filter((r) => r.status === "fulfilled");
      const rejected = outcomes.filter((r) => r.status === "rejected");
      // From CREATED BOTH commands are legal, and `cancel` stays legal
      // after `authorize` — the row lock SERIALIZES the two writers into a
      // legal chain: either authorize-then-cancel (both commit) or cancel
      // first (authorize then rejects on the terminal row). Every rejected
      // writer failed-closed with INVALID_STATE_TRANSITION — never a
      // duplicate event, never an illegal jump.
      expect(committed.length + rejected.length).toBe(2);
      for (const rejection of rejected) {
        expect((rejection as PromiseRejectedResult).reason?.code).toBe("INVALID_STATE_TRANSITION");
      }
      const finalRow = await world.service.getExecution(world.applicationId, created.executionId);
      expect(finalRow?.status).toBe("CANCELLED");
      // Sequence integrity: create + the committed chain (1-2 legal
      // wins), gapless, row agrees with the ledger tail.
      const events = await world.service.listEvents(world.applicationId, created.executionId);
      expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => i + 1));
      expect(events.length).toBe(1 + committed.length);
      const row = await world.service.getExecution(world.applicationId, created.executionId);
      expect(row?.lastEventSequence).toBe(events.length);
    }
  });

  test("sequence integrity under sustained concurrent transitions: gapless, duplicate-free, row agrees", async () => {
    world = await seedExecutionsWorld(ctx.port);
    const created = await world.service.createExecution(
      baseCreateInput(world.applicationId),
      "seq-key",
      actorOf(world),
    );
    // Progress to RUNNING, then race legal transitions from RUNNING:
    // wait-tool / wait-user / verify / fail are ALL legal from RUNNING.
    for (const [command, key] of [
      ["authorize", "s1"],
      ["plan", "s2"],
      ["queue", "s3"],
      ["start", "s4"],
    ] as const) {
      await world.service.transition(
        { ...transitionScope(world, created.executionId), command } as never,
        `${created.executionId}-${key}`,
      );
    }
    const races = await Promise.allSettled([
      world.service.transition(
        { ...transitionScope(world, created.executionId), command: "wait-tool" },
        "w1",
      ),
      world.service.transition(
        { ...transitionScope(world, created.executionId), command: "wait-user" },
        "w2",
      ),
      world.service.transition(
        { ...transitionScope(world, created.executionId), command: "verify" },
        "w3",
      ),
      world.service.transition(
        { ...transitionScope(world, created.executionId), command: "fail" },
        "w4",
      ),
    ]);
    const committed = races.filter((r) => r.status === "fulfilled");
    const rejected = races.filter((r) => r.status === "rejected");
    // From RUNNING all four commands start legal; the row lock serializes
    // them into a LEGAL CHAIN (e.g. verify then fail both commit; wait-tool
    // then the rest reject). Invariants under ANY interleaving: no
    // unexpected error class, gapless duplicate-free sequences, and the
    // row agrees with the ledger's last envelope.
    expect(committed.length + rejected.length).toBe(4);
    expect(committed.length).toBeGreaterThanOrEqual(1);
    for (const rejection of rejected) {
      expect((rejection as PromiseRejectedResult).reason?.code).toBe("INVALID_STATE_TRANSITION");
    }
    const events = await world.service.listEvents(world.applicationId, created.executionId);
    // create + 4 progressions + committed chain (1 or 2 legal wins).
    expect(events.length).toBe(5 + committed.length);
    expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => i + 1));
    const uniqueSequences = new Set(events.map((e) => e.sequence));
    expect(uniqueSequences.size).toBe(events.length);
    const row = await world.service.getExecution(world.applicationId, created.executionId);
    expect(row?.lastEventSequence).toBe(events.length);
    expect(events[events.length - 1]?.payload.to ?? events[events.length - 1]?.payload).toContain(
      row?.status ?? "",
    );
    // Physical gapless proof: the ledger itself reports max = count.
    const stats = await ctx.port.execute<{ max: string; count: string }>({
      sql: "SELECT max(sequence)::text AS max, count(*)::text AS count FROM executions.execution_events WHERE execution_id = $1",
      parameters: [created.executionId],
    });
    expect(stats.rows[0]?.max).toBe(stats.rows[0]?.count);
  });
});
