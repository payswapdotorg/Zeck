/**
 * Unit — idempotency, retry and concurrency safety of the governed
 * economic-action boundary (WORK-032, ECO-007).
 *
 * Same key + same fingerprint replays the durable outcome; same key +
 * different (mutated-constraint) fingerprint fails IDEMPOTENCY_KEY_REUSED
 * (material constraints participate in the fingerprint — a mutated
 * recipient/amount/currency/purpose is a DIFFERENT logical operation);
 * concurrent duplicates converge on a single durable result; every
 * operation carries its caller key end to end.
 */

import { describe, expect, test } from "vitest";
import type { RecordDeliveryObservationCommand } from "../../../src/modules/economics/public";
import { authorizedAction, createCommand, createEconomicsUnitWorld } from "./fakes";

describe("idempotent replay: same key + same fingerprint (ECO-007)", () => {
  test("create: duplicate request replays the SAME action (replayed: true)", async () => {
    const world = await createEconomicsUnitWorld();
    const command = createCommand(world) as never;
    const first = await world.economics.createEconomicAction(command, "same-create");
    const second = await world.economics.createEconomicAction(command, "same-create");
    expect(second.action.id).toBe(first.action.id);
    expect(second.replayed).toBe(true);
    expect(first.replayed).toBe(false);
    // Exactly one durable action exists.
    const actions = await world.store.listActionsOfApplication(world.applicationId);
    expect(actions).toHaveLength(1);
  });

  test("authorize: replay does not re-run the admission chain", async () => {
    const world = await createEconomicsUnitWorld();
    const created = await world.economics.createEconomicAction(
      createCommand(world) as never,
      "auth-replay-create",
    );
    const scope = {
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      actorId: world.actorId,
      economicActionId: created.action.id,
    };
    await world.economics.authorizeEconomicAction(scope, "auth-replay");
    const policyCallsAfterFirst = world.policy.calls.length;
    const budgetReservesAfterFirst = world.budget.reserveCalls.length;
    const replay = await world.economics.authorizeEconomicAction(scope, "auth-replay");
    expect(replay.replayed).toBe(true);
    expect(world.policy.calls).toHaveLength(policyCallsAfterFirst);
    expect(world.budget.reserveCalls).toHaveLength(budgetReservesAfterFirst);
  });

  test("charge: replay does not re-charge the rail or re-settle the budget", async () => {
    const world = await createEconomicsUnitWorld();
    const { actionId } = await authorizedAction(world);
    const scope = {
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      actorId: world.actorId,
      economicActionId: actionId,
    };
    const first = await world.economics.chargeEconomicAction(
      scope,
      world.journaledRail,
      "charge-replay",
    );
    const railCharges = world.journal.filter((entry) => entry.startsWith("rail.charge")).length;
    const settles = world.budget.settleCalls.length;
    const second = await world.economics.chargeEconomicAction(
      scope,
      world.journaledRail,
      "charge-replay",
    );
    expect(second.replayed).toBe(true);
    expect(second.settlement.id).toBe(first.settlement.id);
    expect(world.journal.filter((entry) => entry.startsWith("rail.charge"))).toHaveLength(
      railCharges,
    );
    expect(world.budget.settleCalls).toHaveLength(settles);
  });

  test("delivery: same key replays the same delivery row", async () => {
    const world = await createEconomicsUnitWorld();
    const { actionId } = await authorizedAction(world);
    const command: RecordDeliveryObservationCommand = {
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      actorId: world.actorId,
      economicActionId: actionId,
      kind: "resource-receipt",
      digest: "sha256:abc",
      contentRef: "ref://1",
      observedAt: world.clock.now().toISOString(),
    };
    const first = await world.economics.recordDeliveryObservation(command, "delivery-replay");
    const second = await world.economics.recordDeliveryObservation(command, "delivery-replay");
    expect(second.delivery.id).toBe(first.delivery.id);
    expect(second.replayed).toBe(true);
    const bundle = await world.economics.deliveryEvidence(world.applicationId, actionId);
    expect(bundle?.deliveries).toHaveLength(1);
  });
});

describe("key reuse with a MUTATED constraint: canonical typed failure (ECO-007)", () => {
  test("same key + different amount -> IDEMPOTENCY_KEY_REUSED (amount substitution is not a replay)", async () => {
    const world = await createEconomicsUnitWorld();
    await world.economics.createEconomicAction(createCommand(world) as never, "reuse-key");
    await expect(
      world.economics.createEconomicAction(
        createCommand(world, { amount: { kind: "exact", microUsd: "999999" } }) as never,
        "reuse-key",
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    // The original action is untouched.
    const actions = await world.store.listActionsOfApplication(world.applicationId);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.amount).toEqual({ kind: "exact", microUsd: "125000" });
  });

  test("every material-constraint mutation fails key reuse (recipient/currency/purpose/expiry/scope)", async () => {
    const world = await createEconomicsUnitWorld();
    await world.economics.createEconomicAction(createCommand(world) as never, "multi-reuse");
    const mutations: Array<Record<string, unknown>> = [
      { recipient: { kind: "merchant", id: "merchant-999" } },
      { currency: "eur" },
      { purpose: "refund" },
      { expiresAt: new Date(world.clock.now().getTime() + 2 * 60 * 60 * 1000).toISOString() },
      { executionId: "11111111-1111-7000-8000-0000000000f1" },
      { actorId: "00000000-0000-7000-8000-0000000000f2" }, // actor participates in the fingerprint
    ];
    for (const mutation of mutations) {
      await expect(
        world.economics.createEconomicAction(
          createCommand(world, mutation) as never,
          "multi-reuse",
        ),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    }
  });
});

describe("concurrent duplicates converge on a single durable result (ECO-007)", () => {
  test("two concurrent creates with the same key: one action, both calls agree", async () => {
    const world = await createEconomicsUnitWorld();
    const command = createCommand(world) as never;
    const [first, second] = await Promise.all([
      world.economics.createEconomicAction(command, "concurrent-create"),
      world.economics.createEconomicAction(command, "concurrent-create"),
    ]);
    expect(first.action.id).toBe(second.action.id);
    const replayed = [first.replayed, second.replayed];
    expect(replayed.filter((value) => value === true)).toHaveLength(1);
    const actions = await world.store.listActionsOfApplication(world.applicationId);
    expect(actions).toHaveLength(1);
  });

  test("concurrent charge duplicates: one rail charge, one settlement, one budget settle", async () => {
    const world = await createEconomicsUnitWorld();
    const { actionId } = await authorizedAction(world);
    const scope = {
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      actorId: world.actorId,
      economicActionId: actionId,
    };
    const [first, second] = await Promise.all([
      world.economics.chargeEconomicAction(scope, world.journaledRail, "concurrent-charge"),
      world.economics.chargeEconomicAction(scope, world.journaledRail, "concurrent-charge"),
    ]);
    expect(first.settlement.id).toBe(second.settlement.id);
    expect([first.replayed, second.replayed].filter((value) => value === true)).toHaveLength(1);
    expect(world.journal.filter((entry) => entry.startsWith("rail.charge"))).toHaveLength(1);
    expect(world.budget.settleCalls).toHaveLength(1);
  });
});
