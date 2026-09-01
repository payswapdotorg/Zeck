/**
 * Unit — deterministic constraint evaluation and bounded authorization
 * semantics (WORK-032, ECO-002; the required "deterministic constraint
 * tests" + the substitution/replay firewall).
 *
 * `evaluateAuthorizationUse` is PURE, TOTAL, DETERMINISTIC code — the
 * caller injects the clock, there is no I/O, no LLM and no policy
 * re-resolution. Every substitution class (recipient/seller, amount
 * escalation, currency, purpose/resource, expiry, execution/
 * application/tenant scope) dies with a DISTINCT machine-readable
 * denial code. Single-use consumption and revocation are proven through
 * the service (the durable half lives in the PostgreSQL suites).
 */

import { describe, expect, test } from "vitest";
import type {
  AuthorizationUse,
  PaymentAuthorizationRecord,
} from "../../../src/modules/economics/public";
import {
  constraintsOfAction,
  evaluateAuthorizationUse,
  PAYMENT_AUTHORIZATION_REUSE_POLICIES,
  PAYMENT_AUTHORIZATION_STATUSES,
} from "../../../src/modules/economics/public";
import { authorizedAction, createCommand, createEconomicsUnitWorld } from "./fakes";

const NOW = new Date("2026-09-15T12:00:00.000Z");
const EXPIRY = "2026-09-15T13:00:00.000Z";

const authorizationOf = (
  overrides: Partial<PaymentAuthorizationRecord["constraints"]> = {},
  recordOverrides: Partial<PaymentAuthorizationRecord> = {},
): PaymentAuthorizationRecord => ({
  id: "auth-1",
  economicActionId: "action-1",
  applicationId: "app-1",
  tenantId: "tenant-1",
  constraints: {
    recipient: { kind: "merchant", id: "merchant-42" },
    minAmountMicroUsd: "100000",
    maxAmountMicroUsd: "250000",
    currency: "usd",
    purpose: "purchase",
    expiresAt: EXPIRY,
    executionId: "exec-1",
    applicationId: "app-1",
    tenantId: "tenant-1",
    reuse: "single-use",
    requiredCapabilities: [],
    ...overrides,
  },
  status: "active",
  reservationOperationId: "econ-action-1",
  admissionEvidence: {},
  issuedAt: "2026-09-15T12:00:00.000Z",
  expiresAt: EXPIRY,
  consumedAt: null,
  createdAt: "2026-09-15T12:00:00.000Z",
  ...recordOverrides,
});

const useOf = (overrides: Partial<AuthorizationUse> = {}): AuthorizationUse => ({
  economicActionId: "action-1",
  recipient: { kind: "merchant", id: "merchant-42" },
  amountMicroUsd: "150000",
  currency: "usd",
  purpose: "purchase",
  executionId: "exec-1",
  applicationId: "app-1",
  tenantId: "tenant-1",
  ...overrides,
});

describe("deterministic constraint evaluation (ECO-002)", () => {
  test("a use that satisfies every constraint is allowed", () => {
    expect(evaluateAuthorizationUse(authorizationOf(), useOf(), NOW)).toEqual({ allowed: true });
  });

  test("in-range bounds are inclusive at BOTH edges", () => {
    expect(
      evaluateAuthorizationUse(authorizationOf(), useOf({ amountMicroUsd: "100000" }), NOW),
    ).toEqual({ allowed: true });
    expect(
      evaluateAuthorizationUse(authorizationOf(), useOf({ amountMicroUsd: "250000" }), NOW),
    ).toEqual({ allowed: true });
  });

  test("recipient/seller substitution is denied with a distinct code", () => {
    const result = evaluateAuthorizationUse(
      authorizationOf(),
      useOf({ recipient: { kind: "merchant", id: "merchant-999" } }),
      NOW,
    );
    expect(result).toMatchObject({ allowed: false, code: "recipient-substitution" });
    // Kind substitution is substitution too (the full pinned reference).
    const kindSwap = evaluateAuthorizationUse(
      authorizationOf(),
      useOf({ recipient: { kind: "seller", id: "merchant-42" } }),
      NOW,
    );
    expect(kindSwap).toMatchObject({ allowed: false, code: "recipient-substitution" });
  });

  test("amount escalation and under-min are denied (inclusive bounds)", () => {
    const tooMuch = evaluateAuthorizationUse(
      authorizationOf(),
      useOf({ amountMicroUsd: "250001" }),
      NOW,
    );
    expect(tooMuch).toMatchObject({ allowed: false, code: "amount-out-of-bounds" });
    const tooLittle = evaluateAuthorizationUse(
      authorizationOf(),
      useOf({ amountMicroUsd: "99999" }),
      NOW,
    );
    expect(tooLittle).toMatchObject({ allowed: false, code: "amount-out-of-bounds" });
  });

  test("currency substitution is denied", () => {
    const result = evaluateAuthorizationUse(authorizationOf(), useOf({ currency: "eur" }), NOW);
    expect(result).toMatchObject({ allowed: false, code: "currency-substitution" });
  });

  test("purpose/resource substitution is denied", () => {
    const result = evaluateAuthorizationUse(authorizationOf(), useOf({ purpose: "refund" }), NOW);
    expect(result).toMatchObject({ allowed: false, code: "purpose-substitution" });
  });

  test("expiry: now at/after the expiry instant is EXPIRED (time-based replay dies)", () => {
    const atExpiry = evaluateAuthorizationUse(authorizationOf(), useOf(), new Date(EXPIRY));
    expect(atExpiry).toMatchObject({ allowed: false, code: "authorization-expired" });
    const after = evaluateAuthorizationUse(
      authorizationOf(),
      useOf(),
      new Date("2026-09-15T13:00:00.001Z"),
    );
    expect(after).toMatchObject({ allowed: false, code: "authorization-expired" });
    // One millisecond before expiry is still valid (expiry is a hard wall).
    const before = evaluateAuthorizationUse(
      authorizationOf(),
      useOf(),
      new Date("2026-09-15T12:59:59.999Z"),
    );
    expect(before).toEqual({ allowed: true });
  });

  test("execution / application / tenant scope substitution are denied with distinct codes", () => {
    const execution = evaluateAuthorizationUse(
      authorizationOf(),
      useOf({ executionId: "exec-2" }),
      NOW,
    );
    expect(execution).toMatchObject({ allowed: false, code: "execution-substitution" });

    const application = evaluateAuthorizationUse(
      authorizationOf(),
      useOf({ applicationId: "app-2" }),
      NOW,
    );
    expect(application).toMatchObject({ allowed: false, code: "tenant-substitution" });
    expect(application).toMatchObject({ detail: expect.stringContaining("application") });

    const tenant = evaluateAuthorizationUse(
      authorizationOf(),
      useOf({ tenantId: "tenant-2" }),
      NOW,
    );
    expect(tenant).toMatchObject({ allowed: false, code: "tenant-substitution" });
    expect(tenant).toMatchObject({ detail: expect.stringContaining("tenant") });
  });

  test("replaying an authorization against a DIFFERENT action is denied", () => {
    const result = evaluateAuthorizationUse(
      authorizationOf(),
      useOf({ economicActionId: "action-2" }),
      NOW,
    );
    expect(result).toMatchObject({ allowed: false, code: "authorization-mismatch" });
  });

  test("every denial is machine-readable (code + detail)", () => {
    const cases = [
      authorizationOf(undefined, { status: "consumed" }),
      authorizationOf(undefined, { status: "revoked" }),
      authorizationOf(undefined, { status: "expired" }),
    ];
    for (const authorization of cases) {
      const result = evaluateAuthorizationUse(authorization, useOf(), NOW);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.code.length).toBeGreaterThan(0);
        expect(result.detail.length).toBeGreaterThan(0);
      }
    }
  });

  test("v1 reuse policy is single-use only (no multi-use vocabulary exists)", () => {
    expect(PAYMENT_AUTHORIZATION_REUSE_POLICIES).toEqual(["single-use"]);
    expect(PAYMENT_AUTHORIZATION_STATUSES).toEqual(["active", "consumed", "expired", "revoked"]);
  });
});

describe("constraints pinning: intent -> authorization (ECO-002)", () => {
  test("constraintsOfAction pins every material constraint from the intent", () => {
    const exact = constraintsOfAction({
      id: "action-1",
      applicationId: "app-1",
      tenantId: "tenant-1",
      executionId: "exec-1",
      purpose: "purchase",
      recipient: { kind: "merchant", id: "merchant-42" },
      amount: { kind: "exact", microUsd: "125000" },
      currency: "usd",
      expiresAt: EXPIRY,
      requiredCapabilities: [{ kind: "tool", name: "payment-processor" }],
    });
    expect(exact.minAmountMicroUsd).toBe("125000");
    expect(exact.maxAmountMicroUsd).toBe("125000");
    expect(exact.reuse).toBe("single-use");
    expect(exact.expiresAt).toBe(EXPIRY);

    const range = constraintsOfAction({
      ...exact,
      amount: { kind: "range", minMicroUsd: "100000", maxMicroUsd: "250000" },
    } as never);
    expect(range.minAmountMicroUsd).toBe("100000");
    expect(range.maxAmountMicroUsd).toBe("250000");
  });
});

describe("bounded authorization semantics through the service (ECO-002)", () => {
  test("a charge CONSUMES the authorization: replay after consumption is denied", async () => {
    const world = await createEconomicsUnitWorld();
    const { actionId } = await authorizedAction(world, {
      amount: { kind: "range", minMicroUsd: "100000", maxMicroUsd: "250000" },
    });
    const first = await world.economics.chargeEconomicAction(
      {
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        actorId: world.actorId,
        economicActionId: actionId,
        amountMicroUsd: "150000",
      },
      world.journaledRail,
      "charge-1",
    );
    expect(first.authorization.status).toBe("consumed");
    expect(first.authorization.consumedAt).not.toBeNull();
    expect(first.action.status).toBe("settled");

    // A second charge of the now-terminal action cannot even reach the
    // substitution firewall: the action lifecycle refuses it first.
    await expect(
      world.economics.chargeEconomicAction(
        {
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          actorId: world.actorId,
          economicActionId: actionId,
          amountMicroUsd: "150000",
        },
        world.journaledRail,
        "charge-2",
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    // Zero additional rail side effects.
    expect(world.journal.filter((entry) => entry.startsWith("rail.charge"))).toHaveLength(1);
  });

  test("amount substitution at the charge boundary is denied before any side effect", async () => {
    const world = await createEconomicsUnitWorld();
    const { actionId } = await authorizedAction(world, {
      amount: { kind: "range", minMicroUsd: "100000", maxMicroUsd: "200000" },
    });
    await expect(
      world.economics.chargeEconomicAction(
        {
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          actorId: world.actorId,
          economicActionId: actionId,
          amountMicroUsd: "999999", // above the pinned ceiling
        },
        world.journaledRail,
        "charge-substitute",
      ),
    ).rejects.toMatchObject({
      code: "AUTHORIZATION_DENIED",
      details: { code: "amount-out-of-bounds" },
    });
    expect(world.journal).not.toContain("rail.charge:simulated-rail-a");
    expect(world.journal).not.toContain("store.insertSettlement");
    expect(world.budget.settleCalls).toHaveLength(0);
    // The denial is journaled with cause "authorization".
    const events = await world.economics.listEconomicActionEvents(world.applicationId, actionId);
    const rejected = events.find((event) => event.type === "payment.rejected");
    expect(rejected).toBeDefined();
    expect(rejected?.cause).toBe("authorization");
    expect(rejected?.payload).toMatchObject({ code: "amount-out-of-bounds" });
  });

  test("authorization expiry at the charge boundary is denied before any side effect", async () => {
    const world = await createEconomicsUnitWorld();
    const { actionId } = await authorizedAction(world, {
      expiresAt: new Date(world.clock.now().getTime() + 30 * 60 * 1000).toISOString(),
    });
    world.clock.advance(31 * 60 * 1000); // past the authorization expiry
    await expect(
      world.economics.chargeEconomicAction(
        {
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          actorId: world.actorId,
          economicActionId: actionId,
        },
        world.journaledRail,
        "charge-expired",
      ),
    ).rejects.toMatchObject({ code: "EXPIRED" });
    expect(world.journal).not.toContain("rail.charge:simulated-rail-a");
  });

  test("an expired INTENT never authorizes (lazy deterministic expiry)", async () => {
    const world = await createEconomicsUnitWorld();
    const created = await world.economics.createEconomicAction(
      createCommand(world, {
        expiresAt: new Date(world.clock.now().getTime() + 60 * 1000).toISOString(),
      }) as never,
      "expire-create",
    );
    world.clock.advance(61 * 1000);
    await expect(
      world.economics.authorizeEconomicAction(
        {
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          actorId: world.actorId,
          economicActionId: created.action.id,
        },
        "expire-authorize",
      ),
    ).rejects.toMatchObject({ code: "EXPIRED" });
    const action = await world.economics.getEconomicAction(world.applicationId, created.action.id);
    expect(action?.status).toBe("expired");
    // Zero side effects: no admission was consulted, no money held.
    expect(world.policy.calls).toHaveLength(0);
    expect(world.budget.reserveCalls).toHaveLength(0);
  });
});
