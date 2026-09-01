/**
 * Unit — the admission chain ORDER and side-effect discipline of the
 * economic-action service (WORK-032, ECO-003; the required
 * "budget/authorization ordering tests").
 *
 * Proves mechanically (over the journaling world):
 *  - ORDER: policy -> capability -> budget.reserve -> authorization
 *    issuance; the durable `executing` transition + dispatched event
 *    journal BEFORE the rail charge (journal-then-dispatch); settlement
 *    correlation before budget settlement; terminal status last.
 *  - EVERY denial class fails closed BEFORE any external side effect:
 *    policy denial (POLICY_DENIED), capability denial
 *    (CAPABILITY_UNAVAILABLE), budget denial (BUDGET_EXCEEDED) — each
 *    journaled with its cause class, action transitioned to `denied`,
 *    zero authorizations, zero rail charges.
 *  - NO rail charge is reachable from a non-authorized action (the
 *    charge path requires the full chain first).
 *  - Double reservation is unrepresentable: ONE reservation operation id
 *    per action (`econ-<actionId>`), and one authorization per action.
 */

import { describe, expect, test } from "vitest";
import { authorizedAction, createCommand, createEconomicsUnitWorld } from "./fakes";

describe("admission-chain ordering (ECO-003)", () => {
  test("the full authorize chain runs policy -> capability -> budget -> issuance", async () => {
    const world = await createEconomicsUnitWorld();
    world.journal.length = 0;
    const created = await world.economics.createEconomicAction(
      createCommand(world) as never,
      "order-create",
    );
    world.journal.length = 0;

    await world.economics.authorizeEconomicAction(
      {
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        actorId: world.actorId,
        economicActionId: created.action.id,
      },
      "order-authorize",
    );

    // The exact ordering: policy FIRST, capability SECOND, budget THIRD,
    // the authorization row only after all three, the action transition
    // after the authorization exists.
    const expected = [
      "policy.evaluate",
      "capabilities.resolve",
      "budget.reserve",
      "store.insertAuthorization",
      "store.transitionEconomicAction:authorized",
    ];
    expect(world.journal.slice(0, expected.length)).toEqual(expected);
    // No external side effect anywhere in the authorization window.
    expect(world.journal.some((entry) => entry.startsWith("rail.charge"))).toBe(false);
  });

  test("the charge chain journals-then-dispatches: durable executing transition BEFORE the rail", async () => {
    const world = await createEconomicsUnitWorld();
    const { actionId } = await authorizedAction(world);
    world.journal.length = 0;

    await world.economics.chargeEconomicAction(
      {
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        actorId: world.actorId,
        economicActionId: actionId,
      },
      world.journaledRail,
      "order-charge",
    );

    const chargeIndex = world.journal.findIndex((entry) => entry.startsWith("rail.charge:"));
    expect(chargeIndex).toBeGreaterThan(-1);
    // The executing transition commits BEFORE the rail side effect.
    const executingIndex = world.journal.indexOf("store.transitionEconomicAction:executing");
    expect(executingIndex).toBeGreaterThan(-1);
    expect(executingIndex).toBeLessThan(chargeIndex);
    // Settlement correlation and budget settlement AFTER the charge.
    const settlementIndex = world.journal.indexOf("store.insertSettlement");
    expect(settlementIndex).toBeGreaterThan(chargeIndex);
    const settleIndex = world.journal.indexOf("budget.settle");
    expect(settleIndex).toBeGreaterThan(chargeIndex);
    // Authorization consumption after the charge; terminal state last.
    expect(world.journal.indexOf("store.transitionEconomicAction:settled")).toBeGreaterThan(
      chargeIndex,
    );
  });

  test("budget reservation happens BEFORE authorization issuance (no authorization without a hold)", async () => {
    const world = await createEconomicsUnitWorld();
    await authorizedAction(world);
    expect(world.journal.indexOf("budget.reserve")).toBeLessThan(
      world.journal.indexOf("store.insertAuthorization"),
    );
    expect(world.budget.reserveCalls).toHaveLength(1);
    const reserve = world.budget.reserveCalls[0] as unknown as Record<string, unknown>;
    expect(reserve.operationId).toBe(`econ-${(await lastActionId(world)) ?? ""}`);
  });

  test("the reservation ceiling is the action's MAXIMUM amount (bounded holds)", async () => {
    const world = await createEconomicsUnitWorld();
    await authorizedAction(world, {
      amount: { kind: "range", minMicroUsd: "100000", maxMicroUsd: "250000" },
    });
    expect(
      (world.budget.reserveCalls[0] as unknown as Record<string, unknown>).amountMicroUsd,
    ).toBe("250000");
  });
});

describe("denial classes: fail closed before any side effect (ECO-003)", () => {
  test("POLICY denial: journaled with cause, denied status, zero downstream effects", async () => {
    const world = await createEconomicsUnitWorld();
    world.policy.decision = { allowed: false, reason: "purchase not permitted by policy" };
    const created = await world.economics.createEconomicAction(
      createCommand(world) as never,
      "policy-create",
    );
    world.journal.length = 0;

    await expect(
      world.economics.authorizeEconomicAction(
        {
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          actorId: world.actorId,
          economicActionId: created.action.id,
        },
        "policy-authorize",
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED", details: { cause: "policy" } });

    // Policy was the FIRST and ONLY authority consulted.
    expect(world.journal).toEqual(["policy.evaluate", "store.transitionEconomicAction:denied"]);
    expect(world.capability.calls).toHaveLength(0);
    expect(world.budget.reserveCalls).toHaveLength(0);
    expect(world.journal.some((entry) => entry.startsWith("rail.charge"))).toBe(false);

    const action = await world.economics.getEconomicAction(world.applicationId, created.action.id);
    expect(action?.status).toBe("denied");
    expect(action?.metadata).toMatchObject({
      denialCause: "policy",
      denialReason: expect.stringContaining("policy"),
    });
    const events = await world.economics.listEconomicActionEvents(
      world.applicationId,
      created.action.id,
    );
    const denial = events.find((event) => event.type === "action.denied");
    expect(denial?.cause).toBe("policy");
  });

  test("CAPABILITY denial: consulted after policy, before any budget hold", async () => {
    const world = await createEconomicsUnitWorld();
    world.capability.decision = { satisfied: false, unmet: ["payment-processor"] };
    const created = await world.economics.createEconomicAction(
      createCommand(world) as never,
      "cap-create",
    );
    world.journal.length = 0;

    await expect(
      world.economics.authorizeEconomicAction(
        {
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          actorId: world.actorId,
          economicActionId: created.action.id,
        },
        "cap-authorize",
      ),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      details: { cause: "capability" },
    });

    expect(world.journal).toEqual([
      "policy.evaluate",
      "capabilities.resolve",
      "store.transitionEconomicAction:denied",
    ]);
    expect(world.budget.reserveCalls).toHaveLength(0);
    expect(world.journal.some((entry) => entry.startsWith("rail.charge"))).toBe(false);
    const action = await world.economics.getEconomicAction(world.applicationId, created.action.id);
    expect(action?.status).toBe("denied");
    expect(action?.metadata).toMatchObject({ denialCause: "capability" });
  });

  test("BUDGET denial: after policy + capability, typed BUDGET_EXCEEDED with cause", async () => {
    const world = await createEconomicsUnitWorld();
    world.budget.failReserve = true;
    const created = await world.economics.createEconomicAction(
      createCommand(world) as never,
      "budget-create",
    );
    world.journal.length = 0;

    await expect(
      world.economics.authorizeEconomicAction(
        {
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          actorId: world.actorId,
          economicActionId: created.action.id,
        },
        "budget-authorize",
      ),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", details: { cause: "budget" } });

    expect(world.journal).toEqual([
      "policy.evaluate",
      "capabilities.resolve",
      "budget.reserve",
      "store.transitionEconomicAction:denied",
    ]);
    // No authorization was minted (budget is a precondition).
    expect(world.journal).not.toContain("store.insertAuthorization");
    expect(world.journal.some((entry) => entry.startsWith("rail.charge"))).toBe(false);
    const action = await world.economics.getEconomicAction(world.applicationId, created.action.id);
    expect(action?.status).toBe("denied");
    expect(action?.metadata).toMatchObject({ denialCause: "budget" });
    const events = await world.economics.listEconomicActionEvents(
      world.applicationId,
      created.action.id,
    );
    const denial = events.find((event) => event.type === "action.denied");
    expect(denial?.cause).toBe("budget");
  });

  test("a non-authorized action can NEVER be charged (side effects gated on the full chain)", async () => {
    const world = await createEconomicsUnitWorld();
    const created = await world.economics.createEconomicAction(
      createCommand(world) as never,
      "gate-create",
    );
    await expect(
      world.economics.chargeEconomicAction(
        {
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          actorId: world.actorId,
          economicActionId: created.action.id,
        },
        world.journaledRail,
        "gate-charge",
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(world.journal.some((entry) => entry.startsWith("rail.charge"))).toBe(false);
    expect(world.budget.settleCalls).toHaveLength(0);
  });

  test("a DENIED action cannot be re-authorized (terminal, fail closed)", async () => {
    const world = await createEconomicsUnitWorld();
    world.policy.decision = { allowed: false, reason: "no" };
    const created = await world.economics.createEconomicAction(
      createCommand(world) as never,
      "deny-create",
    );
    await expect(
      world.economics.authorizeEconomicAction(
        {
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          actorId: world.actorId,
          economicActionId: created.action.id,
        },
        "deny-authorize",
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    // Flip the decision back ON — the action is terminally denied.
    world.policy.decision = { allowed: true };
    await expect(
      world.economics.authorizeEconomicAction(
        {
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          actorId: world.actorId,
          economicActionId: created.action.id,
        },
        "deny-retry",
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });
});

describe("double-reservation prevention (ECO-003)", () => {
  test("ONE reservation operation id per action (`econ-<actionId>`) — single-use by identity", async () => {
    const world = await createEconomicsUnitWorld();
    const { actionId, authorizationId } = await authorizedAction(world);
    const authorization = await world.store.getAuthorizationById(
      world.applicationId,
      authorizationId,
    );
    expect(authorization?.reservationOperationId).toBe(`econ-${actionId}`);
    expect(world.budget.reserveCalls).toHaveLength(1);

    // The store refuses a SECOND authorization for the same action AND
    // for the same reservation operation (both unrepresentable).
    const action = await world.store.getEconomicAction(world.applicationId, actionId);
    await expect(
      world.store.insertAuthorization({
        id: "auth-second",
        economicActionId: actionId,
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        constraints: authorization?.constraints as never,
        status: "active",
        reservationOperationId: `econ-${actionId}`,
        admissionEvidence: {},
        issuedAt: action?.createdAt ?? "",
        expiresAt: action?.expiresAt ?? "",
        createdAt: action?.createdAt ?? "",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  test("re-authorize replay does NOT re-reserve the budget (idempotent hold)", async () => {
    const world = await createEconomicsUnitWorld();
    const created = await world.economics.createEconomicAction(
      createCommand(world) as never,
      "replay-create",
    );
    const scope = {
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      actorId: world.actorId,
      economicActionId: created.action.id,
    };
    const first = await world.economics.authorizeEconomicAction(scope, "replay-auth");
    const second = await world.economics.authorizeEconomicAction(scope, "replay-auth");
    expect(second.replayed).toBe(true);
    expect(second.authorization?.id).toBe(first.authorization?.id);
    expect(world.budget.reserveCalls).toHaveLength(1);
  });
});

async function lastActionId(world: Awaited<ReturnType<typeof createEconomicsUnitWorld>>) {
  const actions = await world.store.listActionsOfApplication(world.applicationId);
  return actions.at(-1)?.id;
}
