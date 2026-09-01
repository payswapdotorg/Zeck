/**
 * Unit — payment-rail adapter contract tests + rail neutrality/replacement
 * (WORK-032, ECO-004; the required "payment-rail adapter contract tests").
 *
 * Proves over the two SIMULATED reference rails (contract-tested only —
 * no network, no real money, no credentials anywhere; the honesty rule):
 *  - the rail adapter contract: neutral identity, honest capability
 *    declaration, rail-side idempotency convergence, constraint-faithful
 *    charge (amount/recipient/currency pinned, expiry honored);
 *  - a rail that CANNOT express the required safety constraints is
 *    REFUSED before any charge (fail closed — the constraint-blind rail
 *    is never reached);
 *  - RAIL REPLACEMENT changes nothing in the core authorities: swapping
 *    simulated-rail-a for simulated-rail-b (a pure composition change)
 *    produces IDENTICAL authority decisions (policy calls, capability
 *    calls, budget reserve/settle amounts, authorization constraints,
 *    action statuses) — only the neutral rail identity/ref differs.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  createConstraintBlindSimulatedRail,
  createSimulatedPaymentRail,
  type RailPaymentRequest,
  railCanExpressConstraints,
} from "../../../src/integrations/payment-rails/public";
import { authorizedAction, createEconomicsUnitWorld } from "./fakes";

const chargeRequest = (overrides: Partial<RailPaymentRequest> = {}): RailPaymentRequest => ({
  economicActionId: "11111111-1111-7000-8000-00000000000a",
  authorizationId: "11111111-1111-7000-8000-00000000000b",
  recipient: { kind: "merchant", id: "merchant-42" },
  amountMicroUsd: "125000",
  currency: "usd",
  purpose: "purchase",
  expiresAt: "2999-01-01T00:00:00.000Z",
  idempotencyKey: "rail-key-1",
  correlationRef: "11111111-1111-7000-8000-00000000000a",
  ...overrides,
});

describe("simulated rail adapter contract (ECO-004)", () => {
  test("the two reference rails are DISTINCT rails behind the SAME contract", () => {
    const railA = createSimulatedPaymentRail({ railId: "simulated-rail-a" });
    const railB = createSimulatedPaymentRail({ railId: "simulated-rail-b" });
    expect(railA.railId).not.toBe(railB.railId);
    expect(railA.capabilities).toEqual(railB.capabilities);
    expect(railCanExpressConstraints(railA.capabilities)).toBe(true);
    expect(railCanExpressConstraints(railB.capabilities)).toBe(true);
  });

  test("a faithful charge returns a neutral observation correlated to the action", async () => {
    const rail = createSimulatedPaymentRail({ railId: "simulated-rail-a" });
    const observation = await rail.charge(chargeRequest());
    expect(observation.railId).toBe("simulated-rail-a");
    expect(observation.railTransactionRef).toMatch(/^sim:simulated-rail-a:1$/);
    expect(observation.status).toBe("succeeded");
    expect(observation.settledAmountMicroUsd).toBe("125000"); // EXACTLY the bounded amount
    expect(observation.currency).toBe("usd");
    expect(observation.evidence).toMatchObject({
      simulated: true,
      economicActionId: "11111111-1111-7000-8000-00000000000a",
      correlationRef: "11111111-1111-7000-8000-00000000000a",
      recipientKind: "merchant",
      recipientId: "merchant-42",
    });
  });

  test("rail-side idempotency: the same key converges on the SAME durable observation", async () => {
    const rail = createSimulatedPaymentRail({ railId: "simulated-rail-a" });
    const first = await rail.charge(chargeRequest());
    const second = await rail.charge(chargeRequest());
    expect(second).toEqual(first);
    expect(rail.charges).toHaveLength(1); // one physical charge, one record
    // A DIFFERENT key is a different charge (ref 2).
    const third = await rail.charge(chargeRequest({ idempotencyKey: "rail-key-2" }));
    expect(third.railTransactionRef).toBe("sim:simulated-rail-a:2");
  });

  test("the rail enforces the constraint surface it declares: expiry is honored rail-side", async () => {
    const rail = createSimulatedPaymentRail({
      railId: "simulated-rail-a",
      now: () => new Date("2026-09-15T12:00:00.000Z"),
    });
    await expect(
      rail.charge(
        chargeRequest({ expiresAt: "2026-09-15T11:59:59.000Z" }), // already past
      ),
    ).rejects.toThrow(/expired/);
  });

  test("honest failure injection: failAllCharges settles as FAILED with zero amount", async () => {
    const rail = createSimulatedPaymentRail({
      railId: "simulated-rail-failing",
      failAllCharges: true,
    });
    const observation = await rail.charge(chargeRequest());
    expect(observation.status).toBe("failed");
    expect(observation.settledAmountMicroUsd).toBe("0");
  });

  test("the rail request contract has NO credential field (shape is pinned)", () => {
    const request = chargeRequest();
    expect(Object.keys(request).sort()).toEqual([
      "amountMicroUsd",
      "authorizationId",
      "correlationRef",
      "currency",
      "economicActionId",
      "expiresAt",
      "idempotencyKey",
      "purpose",
      "recipient",
    ]);
  });
});

describe("fail-closed: a constraint-blind rail is refused BEFORE any charge (ECO-004)", () => {
  test("railCanExpressConstraints fails closed when ANY required constraint is missing", () => {
    expect(
      railCanExpressConstraints({
        pinsRecipient: true,
        enforcesAmountCeiling: true,
        pinsCurrency: true,
        enforcesExpiry: false,
      }),
    ).toBe(false);
    expect(
      railCanExpressConstraints({
        pinsRecipient: false,
        enforcesAmountCeiling: true,
        pinsCurrency: true,
        enforcesExpiry: true,
      }),
    ).toBe(false);
  });

  test("the constraint-blind rail charges NOTHING — the service refuses it first", async () => {
    const world = await createEconomicsUnitWorld();
    const { actionId } = await authorizedAction(world);
    const blindRail = createConstraintBlindSimulatedRail("constraint-blind-rail");
    await expect(
      world.economics.chargeEconomicAction(
        {
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          actorId: world.actorId,
          economicActionId: actionId,
        },
        blindRail,
        "blind-charge",
      ),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      message: expect.stringContaining("cannot express the required safety constraints"),
    });
    // The blind rail's charge is unreachable (it would have thrown).
    expect(world.journal.some((entry) => entry.startsWith("rail.charge"))).toBe(false);
    // No durable state moved either.
    const action = await world.economics.getEconomicAction(world.applicationId, actionId);
    expect(action?.status).toBe("authorized");
    expect(world.budget.settleCalls).toHaveLength(0);
    expect(world.budget.releaseCalls).toHaveLength(0);
  });
});

describe("rail/provider replacement changes NOTHING in the core authorities (ECO-004)", () => {
  test("swapping rail-a for rail-b: identical authority decisions, only the rail identity differs", async () => {
    const outcomes: Array<Record<string, unknown>> = [];
    for (const railId of ["simulated-rail-a", "simulated-rail-b"]) {
      const world = await createEconomicsUnitWorld({ railId });
      const { actionId } = await authorizedAction(world, {
        amount: { kind: "exact", microUsd: "125000" },
      });
      const outcome = await world.economics.chargeEconomicAction(
        {
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          actorId: world.actorId,
          economicActionId: actionId,
        },
        world.journaledRail,
        "replacement-charge",
      );
      // Normalize the world-specific identities (each world has its own
      // application/tenant/execution/action ids) so ONLY the authority
      // decisions are compared across the rail swap.
      const normalize = (value: unknown): string =>
        JSON.stringify(value)
          .replaceAll(world.applicationId, "APP")
          .replaceAll(world.tenantId, "TENANT")
          .replaceAll(world.executionId, "EXEC")
          .replaceAll(actionId, "ACTION")
          .replaceAll(outcome.authorization.id, "AUTH");
      outcomes.push({
        railId,
        actionStatus: outcome.action.status,
        authorizationStatus: outcome.authorization.status,
        authorizationConstraints: normalize(outcome.authorization.constraints),
        settlementStatus: outcome.settlement.status,
        settlementAmount: outcome.settlement.settledAmountMicroUsd,
        policyCalls: world.policy.calls.length,
        capabilityCalls: world.capability.calls.length,
        reserveAmount: (world.budget.reserveCalls[0] as unknown as Record<string, unknown>)
          .amountMicroUsd,
        settleAmount: (world.budget.settleCalls[0] as unknown as Record<string, unknown>)
          .actualAmountMicroUsd,
        authorityJournal: normalize(
          world.journal.filter((entry) => !entry.startsWith("rail.charge:")),
        ),
        settlementRailId: outcome.settlement.railId,
        settlementRef: outcome.settlement.railTransactionRef,
      });
    }
    const [withA, withB] = outcomes as [Record<string, unknown>, Record<string, unknown>];
    // Authority decisions are IDENTICAL under rail replacement.
    for (const key of [
      "actionStatus",
      "authorizationStatus",
      "authorizationConstraints",
      "settlementStatus",
      "settlementAmount",
      "policyCalls",
      "capabilityCalls",
      "reserveAmount",
      "settleAmount",
      "authorityJournal",
    ]) {
      expect(withB[key]).toEqual(withA[key]);
    }
    // Only the neutral rail identity/ref changed (a composition change).
    expect(withB.settlementRailId).not.toBe(withA.settlementRailId);
    expect(withB.settlementRef).not.toBe(withA.settlementRef);
  });

  test("the charge-side fingerprint includes the rail identity (rail swap is a different request)", () => {
    // The service composes rail.railId into the charge fingerprint
    // (see chargeEconomicAction) — swapping rails under the SAME
    // idempotency key is a different fingerprint, not a silent replay.
    const source = readFileSync(
      `${process.cwd()}/src/modules/economics/application/economic-action-service.ts`,
      "utf8",
    );
    const chargeWindow = source.slice(
      source.indexOf("async chargeEconomicAction"),
      source.indexOf("const work = async (", source.indexOf("async chargeEconomicAction")),
    );
    expect(chargeWindow).toContain("rail.railId");
    expect(chargeWindow).toContain("railCanExpressConstraints(rail.capabilities)");
  });
});
