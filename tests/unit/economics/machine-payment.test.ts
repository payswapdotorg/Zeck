/**
 * Unit — machine-payment / HTTP 402 interoperability (WORK-032, ECO-005;
 * the required "HTTP 402 parsing/decision tests").
 *
 * A 402 payment-required response is an INPUT to economic planning —
 * NEVER an authorization. Proves:
 *  - only a well-formed 402 with neutral machine-readable terms parses;
 *    everything else fails closed with a typed code;
 *  - the parsed signal is ADVISORY data (`advisory: true` by
 *    construction) and carries Zeck's own closed vocabulary — no
 *    provider protocol identifier, no credentials;
 *  - the planner-facing draft seeding is UNVALIDATED and must pass the
 *    FULL chain (policy -> capability -> budget -> authorization) before
 *    any charge: a 402 signal authorizes NOTHING.
 */

import { describe, expect, test } from "vitest";
import * as machinePayment from "../../../src/modules/economics/domain/machine-payment";
import { validateDraftForPlanning } from "../../../src/modules/economics/domain/machine-payment";
import {
  economicActionDraftFromSignal,
  HTTP_PAYMENT_REQUIRED,
  PAYMENT_REQUIRED_SIGNAL_SCHEMA_VERSION,
  parsePaymentRequiredSignal,
} from "../../../src/modules/economics/public";
import { createEconomicsUnitWorld } from "./fakes";

const validBody = {
  terms: {
    payeeKind: "merchant",
    payeeId: "merchant-42",
    amountMicroUsd: "125000",
    currency: "usd",
    resource: "report-generation-42",
    accepts: ["simulated-rail-a", "simulated-rail-b"],
  },
};

describe("HTTP 402 parsing (ECO-005)", () => {
  test("a well-formed 402 body parses into an ADVISORY neutral signal", () => {
    const result = parsePaymentRequiredSignal({
      statusCode: 402,
      url: "https://seller.example/resource",
      body: validBody,
    });
    expect(result.parsed).toBe(true);
    if (result.parsed) {
      expect(result.signal.schemaVersion).toBe(PAYMENT_REQUIRED_SIGNAL_SCHEMA_VERSION);
      expect(result.signal.statusCode).toBe(HTTP_PAYMENT_REQUIRED);
      expect(result.signal.advisory).toBe(true);
      expect(result.signal.terms.payee).toEqual({ kind: "merchant", id: "merchant-42" });
      expect(result.signal.terms.amountMicroUsd).toBe("125000");
      expect(result.signal.terms.currency).toBe("usd");
      expect(result.signal.terms.resource).toBe("report-generation-42");
      expect(result.signal.terms.accepts).toEqual(["simulated-rail-a", "simulated-rail-b"]);
      expect(result.signal.observedAtUrl).toBe("https://seller.example/resource");
    }
  });

  test("non-402 status codes never parse (a 200 with terms is NOT payment-required)", () => {
    for (const statusCode of [200, 201, 404, 500, 402 - 1]) {
      const result = parsePaymentRequiredSignal({ statusCode, body: validBody });
      expect(result).toMatchObject({ parsed: false, code: "not-payment-required" });
    }
  });

  test("malformed bodies fail closed with typed codes", () => {
    const notObject = parsePaymentRequiredSignal({ statusCode: 402, body: "payment required" });
    expect(notObject).toMatchObject({ parsed: false, code: "body-not-object" });

    const array = parsePaymentRequiredSignal({ statusCode: 402, body: [validBody] });
    expect(array).toMatchObject({ parsed: false, code: "body-not-object" });

    const nullBody = parsePaymentRequiredSignal({ statusCode: 402, body: null });
    expect(nullBody).toMatchObject({ parsed: false, code: "body-not-object" });

    const missingTerms = parsePaymentRequiredSignal({ statusCode: 402, body: { price: 5 } });
    expect(missingTerms).toMatchObject({ parsed: false, code: "missing-terms" });
  });

  test("invalid terms fail closed (payee, amount, currency, resource, accepts shapes)", () => {
    const badPayeeKind = parsePaymentRequiredSignal({
      statusCode: 402,
      body: { terms: { ...validBody.terms, payeeKind: "card-network" } },
    });
    expect(badPayeeKind).toMatchObject({ parsed: false, code: "invalid-terms" });

    const emptyPayeeId = parsePaymentRequiredSignal({
      statusCode: 402,
      body: { terms: { ...validBody.terms, payeeId: "" } },
    });
    expect(emptyPayeeId).toMatchObject({ parsed: false, code: "invalid-terms" });

    const floatAmount = parsePaymentRequiredSignal({
      statusCode: 402,
      body: { terms: { ...validBody.terms, amountMicroUsd: "12.50" } },
    });
    expect(floatAmount).toMatchObject({ parsed: false, code: "invalid-terms" });

    const negativeAmount = parsePaymentRequiredSignal({
      statusCode: 402,
      body: { terms: { ...validBody.terms, amountMicroUsd: "-1" } },
    });
    expect(negativeAmount).toMatchObject({ parsed: false, code: "invalid-terms" });

    const unknownCurrency = parsePaymentRequiredSignal({
      statusCode: 402,
      body: { terms: { ...validBody.terms, currency: "credits" } },
    });
    expect(unknownCurrency).toMatchObject({ parsed: false, code: "invalid-terms" });

    const emptyResource = parsePaymentRequiredSignal({
      statusCode: 402,
      body: { terms: { ...validBody.terms, resource: "" } },
    });
    expect(emptyResource).toMatchObject({ parsed: false, code: "invalid-terms" });

    const badAccepts = parsePaymentRequiredSignal({
      statusCode: 402,
      body: { terms: { ...validBody.terms, accepts: ["rail-a", 42] } },
    });
    expect(badAccepts).toMatchObject({ parsed: false, code: "invalid-terms" });
  });

  test("a 402 signal carries no credential-shaped or provider-protocol field anywhere", () => {
    const result = parsePaymentRequiredSignal({ statusCode: 402, body: validBody });
    expect(result.parsed).toBe(true);
    if (result.parsed) {
      const keys = JSON.stringify(result.signal).toLowerCase();
      for (const forbidden of ["card", "secret", "apikey", "api_key", "password", "credential"]) {
        expect(keys).not.toContain(forbidden);
      }
    }
  });
});

describe("HTTP 402 as planning INPUT — never an authorization (ECO-005)", () => {
  test("the machine-payment module exposes NO authorization-minting surface", () => {
    const exports = Object.keys(machinePayment).filter((name) => name !== "default");
    expect(exports.sort()).toEqual(
      [
        "economicActionDraftFromSignal",
        "HTTP_PAYMENT_REQUIRED",
        "parsePaymentRequiredSignal",
        "PAYMENT_REQUIRED_SIGNAL_SCHEMA_VERSION",
        "validateDraftForPlanning",
      ].sort(),
    );
    for (const name of exports) {
      expect(name.toLowerCase()).not.toMatch(/authoriz|mint|approve|permit|credential/);
    }
  });

  test("the seeded draft is UNVALIDATED here and must pass the full validation + chain", async () => {
    const parsed = parsePaymentRequiredSignal({ statusCode: 402, body: validBody });
    expect(parsed.parsed).toBe(true);
    if (!parsed.parsed) {
      throw new Error("fixture must parse");
    }
    const draft = economicActionDraftFromSignal(
      parsed.signal,
      {
        applicationId: "11111111-1111-7000-8000-000000000001",
        tenantId: "11111111-1111-7000-8000-000000000002",
        executionId: "11111111-1111-7000-8000-000000000003",
        proposedBy: "actor-1",
      },
      { expiresAt: "2026-09-15T13:00:00.000Z" },
    );
    // Planning shapes: machine-resource purpose, exact amount from the terms.
    expect(draft.purpose).toBe("machine-resource");
    expect(draft.amount).toEqual({ kind: "exact", microUsd: "125000" });
    expect(draft.recipient).toEqual({ kind: "merchant", id: "merchant-42" });
    expect(draft.metadata).toMatchObject({ origin: "http-402", resource: "report-generation-42" });
    // The draft still requires the deterministic validation...
    expect(validateDraftForPlanning(draft, new Date("2026-09-15T12:00:00.000Z"))).toEqual([]);
    // ...and a PAST expiry fails it (the signal's terms are not a license).
    expect(
      validateDraftForPlanning(draft, new Date("2026-09-15T14:00:00.000Z")).map(
        (issue) => issue.field,
      ),
    ).toContain("expiresAt");
  });

  test("a draft born from a 402 signal still needs the FULL chain before any charge", async () => {
    const world = await createEconomicsUnitWorld();
    const parsed = parsePaymentRequiredSignal({ statusCode: 402, body: validBody });
    if (!parsed.parsed) {
      throw new Error("fixture must parse");
    }
    const draft = economicActionDraftFromSignal(
      parsed.signal,
      {
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        executionId: world.executionId,
        proposedBy: world.actorId,
      },
      { expiresAt: world.expiresAt },
    );
    // Create through the governed boundary: intent ONLY.
    const created = await world.economics.createEconomicAction(
      {
        applicationId: draft.applicationId,
        tenantId: draft.tenantId,
        actorId: draft.proposedBy,
        executionId: draft.executionId,
        purpose: draft.purpose,
        recipient: draft.recipient,
        amount: draft.amount,
        currency: draft.currency,
        expiresAt: draft.expiresAt,
        requiredCapabilities: draft.requiredCapabilities,
      },
      "402-create",
    );
    expect(created.action.status).toBe("proposed");
    // The 402 signal did NOT authorize anything: no authorization row,
    // no budget hold, no rail charge until authorizeEconomicAction runs.
    expect(world.budget.reserveCalls).toHaveLength(0);
    expect(world.journal.some((entry) => entry.startsWith("rail.charge"))).toBe(false);
    const authorization = await world.store.getAuthorizationForAction(
      world.applicationId,
      created.action.id,
    );
    expect(authorization).toBeNull();

    // The full chain still gates the charge (policy consulted first).
    await world.economics.authorizeEconomicAction(
      {
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        actorId: world.actorId,
        economicActionId: created.action.id,
      },
      "402-authorize",
    );
    expect(world.policy.calls).toHaveLength(1);
    expect(world.budget.reserveCalls).toHaveLength(1);
  });

  test("a 402-born action denied by policy stays denied (the signal is not a bypass)", async () => {
    const world = await createEconomicsUnitWorld();
    world.policy.decision = { allowed: false, reason: "402 terms rejected by policy" };
    const created = await world.economics.createEconomicAction(
      (await import("./fakes")).createCommand(world, {
        purpose: "machine-resource",
        metadata: { origin: "http-402" },
      }) as never,
      "402-deny-create",
    );
    await expect(
      world.economics.authorizeEconomicAction(
        {
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          actorId: world.actorId,
          economicActionId: created.action.id,
        },
        "402-deny-authorize",
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    const action = await world.economics.getEconomicAction(world.applicationId, created.action.id);
    expect(action?.status).toBe("denied");
    expect(world.journal.some((entry) => entry.startsWith("rail.charge"))).toBe(false);
    expect(world.budget.settleCalls).toHaveLength(0);
  });
});
