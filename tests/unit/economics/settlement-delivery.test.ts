/**
 * Unit — settlement correlation and payment-success-vs-delivery (WORK-032,
 * ECO-006; the required "settlement correlation tests" +
 * "payment-success-vs-delivery verification tests").
 *
 * Proves:
 *  - every settlement observation is CORRELATED to its originating
 *    economic action (+ the authorization that caused the charge);
 *  - duplicate rail transaction refs CONVERGE on one durable observation;
 *  - settlement records are CORRELATED EVIDENCE, never truth: an
 *    out-of-band external settlement never settles a budget, consumes an
 *    authorization or transitions the action;
 *  - payment success != delivery: the delivery-evidence bundle reports
 *    settlement and delivery as SEPARATE axes; the verification module
 *    (the delivery authority) decides delivery over the projected facts
 *    — a settled action with zero deliveries cannot pass a
 *    deliveryCount >= 1 criterion.
 */

import { describe, expect, test } from "vitest";
import type {
  DeliveryObservationKind,
  RecordExternalSettlementCommand,
} from "../../../src/modules/economics/public";
import {
  createEconomicDeliveryResolver,
  economicDeliveryFacts,
} from "../../../src/modules/verification/public";
import { authorizedAction, createEconomicsUnitWorld } from "./fakes";

describe("settlement correlation (ECO-006)", () => {
  test("the charge-path settlement is correlated to the action AND its authorization", async () => {
    const world = await createEconomicsUnitWorld();
    const { actionId, authorizationId } = await authorizedAction(world);
    const outcome = await world.economics.chargeEconomicAction(
      {
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        actorId: world.actorId,
        economicActionId: actionId,
      },
      world.journaledRail,
      "correlate-charge",
    );
    expect(outcome.settlement.economicActionId).toBe(actionId);
    expect(outcome.settlement.authorizationId).toBe(authorizationId);
    expect(outcome.settlement.railId).toBe("simulated-rail-a");
    expect(outcome.settlement.status).toBe("confirmed");
    expect(outcome.settlement.settledAmountMicroUsd).toBe("125000");
    // The correlation is journaled on the action's own event ledger.
    const events = await world.economics.listEconomicActionEvents(world.applicationId, actionId);
    const correlated = events.filter((event) => event.type === "settlement.correlated");
    expect(correlated.length).toBeGreaterThan(0);
    for (const event of correlated) {
      expect(event.reference).toMatchObject({ settlementId: outcome.settlement.id });
    }
  });

  test("duplicate rail refs CONVERGE on one durable observation (retries + out-of-band)", async () => {
    const world = await createEconomicsUnitWorld();
    const created = await world.economics.createEconomicAction(
      (await import("./fakes")).createCommand(world) as never,
      "converge-create",
    );
    const command: RecordExternalSettlementCommand = {
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      actorId: world.actorId,
      economicActionId: created.action.id,
      railId: "simulated-rail-a",
      railTransactionRef: "sim:simulated-rail-a:7",
      status: "confirmed",
      settledAmountMicroUsd: "125000",
      currency: "usd",
      observedAt: world.clock.now().toISOString(),
      evidenceDigest: "fnv1a32:deadbeef",
    };
    // SAME caller key: the idempotency ledger replays the durable row.
    const replay = await world.economics.recordExternalSettlement(command, "converge-1");
    const replayed = await world.economics.recordExternalSettlement(command, "converge-1");
    expect(replayed.settlement.id).toBe(replay.settlement.id);
    expect(replayed.replayed).toBe(true);

    // A DIFFERENT caller key observing the SAME external rail transaction
    // still converges on the ONE durable row (physical convergence on
    // (application, rail, rail-transaction-ref); the key-scoped replay
    // flag stays honest to the ledger — the ROW is what converges).
    const differentKey = await world.economics.recordExternalSettlement(command, "converge-2");
    expect(differentKey.settlement.id).toBe(replay.settlement.id);
    expect(differentKey.settlement.railTransactionRef).toBe("sim:simulated-rail-a:7");
    // One durable row for one external transaction.
    const settlements = await world.store.listSettlementsOfApplication(world.applicationId);
    expect(
      settlements.filter((row) => row.railTransactionRef === "sim:simulated-rail-a:7"),
    ).toHaveLength(1);
  });

  test("an external settlement is EVIDENCE ONLY: no budget settle, no consumption, no transition", async () => {
    const world = await createEconomicsUnitWorld();
    const { actionId } = await authorizedAction(world);
    world.budget.settleCalls.length = 0;
    const before = await world.economics.getEconomicAction(world.applicationId, actionId);

    await world.economics.recordExternalSettlement(
      {
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        actorId: world.actorId,
        economicActionId: actionId,
        railId: "simulated-rail-a",
        railTransactionRef: "sim:external:webhook-1",
        status: "confirmed",
        settledAmountMicroUsd: "125000",
        currency: "usd",
        observedAt: world.clock.now().toISOString(),
        evidenceDigest: "fnv1a32:cafe",
      },
      "external-1",
    );

    // The action state, the authorization state and the budget are ALL
    // untouched: an external record is correlated evidence, not a Zeck
    // truth source (money truth lives in budgets; delivery in verification).
    const after = await world.economics.getEconomicAction(world.applicationId, actionId);
    expect(after?.status).toBe(before?.status); // still "authorized"
    expect(world.budget.settleCalls).toHaveLength(0);
    expect(world.budget.releaseCalls).toHaveLength(0);
    const authorization = await world.store.getAuthorizationForAction(
      world.applicationId,
      actionId,
    );
    expect(authorization?.status).toBe("active");
    // ...and the event is journaled with the "external" cause class.
    const events = await world.economics.listEconomicActionEvents(world.applicationId, actionId);
    expect(events.find((event) => event.type === "settlement.externally-recorded")?.cause).toBe(
      "external",
    );
  });
});

describe("payment-success vs delivery (ECO-006)", () => {
  test("a SETTLED action with ZERO deliveries: the bundle reports the axes separately", async () => {
    const world = await createEconomicsUnitWorld();
    const { actionId } = await authorizedAction(world);
    await world.economics.chargeEconomicAction(
      {
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        actorId: world.actorId,
        economicActionId: actionId,
      },
      world.journaledRail,
      "settled-no-delivery",
    );
    const bundle = await world.economics.deliveryEvidence(world.applicationId, actionId);
    expect(bundle).not.toBeNull();
    // Payment succeeded (settlement confirmed) but NOTHING was delivered.
    expect(bundle?.settlement?.status).toBe("confirmed");
    expect(bundle?.deliveries).toEqual([]);
    expect(bundle?.status).toBe("settled");
  });

  test("the verification facts projection keeps the axes SEPARATE (settlement is not delivery)", async () => {
    const world = await createEconomicsUnitWorld();
    const { actionId } = await authorizedAction(world);
    await world.economics.chargeEconomicAction(
      {
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        actorId: world.actorId,
        economicActionId: actionId,
      },
      world.journaledRail,
      "facts-settled",
    );

    const settled = await world.economics.deliveryEvidence(world.applicationId, actionId);
    if (settled === null) {
      throw new Error("delivery evidence bundle must exist for a charged action");
    }
    const settledFacts = economicDeliveryFacts(settled);
    // A CONFIRMED settlement with ZERO delivery observations.
    expect(settledFacts).toMatchObject({
      economicActionStatus: "settled",
      settlementStatus: "confirmed",
      settledAmountMicroUsd: "125000",
      deliveryCount: 0,
      deliveryKinds: [],
    });
    // The exact discrimination: payment-success-as-verification is
    // unrepresentable — deliveryCount 0 fails any deliveryCount >= 1
    // criterion even though the payment fully settled.
    expect(Number(settledFacts.deliveryCount)).toBeLessThan(1);

    // Now deliver evidence through the independent seam: delivery appears
    // WITHOUT any settlement change (the axes are disjoint).
    await world.economics.recordDeliveryObservation(
      {
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        actorId: world.actorId,
        economicActionId: actionId,
        kind: "resource-receipt",
        digest: "sha256:abc",
        contentRef: "artifact://report-42",
        observedAt: world.clock.now().toISOString(),
      },
      "delivery-1",
    );
    const delivered = await world.economics.deliveryEvidence(world.applicationId, actionId);
    if (delivered === null) {
      throw new Error("delivery evidence bundle must exist for a charged action");
    }
    const deliveredFacts = economicDeliveryFacts(delivered);
    expect(deliveredFacts).toMatchObject({
      settlementStatus: "confirmed", // unchanged
      deliveryCount: 1,
      deliveryKinds: ["resource-receipt"],
      deliveryDigests: ["sha256:abc"],
    });
  });

  test("delivery observations are append-only evidence (multiple kinds accumulate)", async () => {
    const world = await createEconomicsUnitWorld();
    const { actionId } = await authorizedAction(world);
    const deliveryKinds: DeliveryObservationKind[] = [
      "resource-receipt",
      "http-delivery",
      "service-result",
    ];
    for (const [index, kind] of deliveryKinds.entries()) {
      await world.economics.recordDeliveryObservation(
        {
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          actorId: world.actorId,
          economicActionId: actionId,
          kind,
          digest: `sha256:d${index}`,
          contentRef: `ref://${index}`,
          observedAt: world.clock.now().toISOString(),
        },
        `delivery-${index}`,
      );
    }
    const bundle = await world.economics.deliveryEvidence(world.applicationId, actionId);
    expect(bundle?.deliveries.map((delivery) => delivery.kind)).toEqual([
      "resource-receipt",
      "http-delivery",
      "service-result",
    ]);
    // Each delivery is journaled (cause class "delivery-evidence").
    const events = await world.economics.listEconomicActionEvents(world.applicationId, actionId);
    const deliveryEvents = events.filter((event) => event.type === "delivery.recorded");
    expect(deliveryEvents).toHaveLength(3);
    for (const event of deliveryEvents) {
      expect(event.cause).toBe("delivery-evidence");
    }
  });

  test("the verification target resolver binds delivery to the action's execution (scope fail-closed)", async () => {
    const world = await createEconomicsUnitWorld();
    const { actionId } = await authorizedAction(world);
    const resolver = createEconomicDeliveryResolver(world.economics);

    const correctExecution = await resolver.resolveTarget({
      applicationId: world.applicationId,
      executionId: world.executionId,
      target: { ref: actionId },
    } as never);
    expect(correctExecution).toMatchObject({ resolved: true });

    const wrongExecution = await resolver.resolveTarget({
      applicationId: world.applicationId,
      executionId: "11111111-1111-7000-8000-0000000000ff",
      target: { ref: actionId },
    } as never);
    expect(wrongExecution.resolved).toBe(false);

    const wrongApplication = await resolver.resolveTarget({
      applicationId: "11111111-1111-7000-8000-0000000000ee",
      executionId: world.executionId,
      target: { ref: actionId },
    } as never);
    expect(wrongApplication.resolved).toBe(false);
  });
});
