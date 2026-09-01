/**
 * Unit — the EconomicAction contract (WORK-032, ECO-001; the required
 * "EconomicAction contract tests" of the work order).
 *
 * Proves the provider-neutral intent contract is closed and total:
 * frozen vocabularies (purpose / currency / recipient kind / status /
 * lifecycle / terminal statuses), bounded amount ranges, expiry
 * discipline, idempotency identity (material constraints participate in
 * the request fingerprint), required-capability shape, and the
 * tenant/application/execution provenance identity — all through the
 * deterministic `validateEconomicActionDraft` (no LLM, no I/O).
 */

import { describe, expect, test } from "vitest";
import type { EconomicActionDraft } from "../../../src/modules/economics/public";
import {
  amountWithinBounds,
  canonicalEconomicFingerprint,
  compareEconomicMicroUsd,
  ECONOMIC_ACTION_STATUSES,
  ECONOMIC_ACTION_TERMINAL_STATUSES,
  ECONOMIC_ACTION_TRANSITIONS,
  ECONOMIC_CURRENCIES,
  ECONOMIC_PURPOSES,
  economicActionCanTransition,
  economicActionFingerprintParts,
  isEconomicActionStatus,
  isEconomicCurrency,
  isEconomicMicroUsd,
  isEconomicPurpose,
  isRecipientKind,
  MAX_ECONOMIC_MICRO_USD,
  RECIPIENT_KINDS,
  validateEconomicActionDraft,
} from "../../../src/modules/economics/public";

const NOW = new Date("2026-09-15T12:00:00.000Z");
const FUTURE = "2026-09-15T13:00:00.000Z";

const baseDraft: EconomicActionDraft = {
  applicationId: "11111111-1111-7000-8000-000000000001",
  tenantId: "11111111-1111-7000-8000-000000000002",
  executionId: "11111111-1111-7000-8000-000000000003",
  proposedBy: "actor-1",
  purpose: "purchase",
  recipient: { kind: "merchant", id: "merchant-42" },
  amount: { kind: "exact", microUsd: "125000" },
  currency: "usd",
  expiresAt: FUTURE,
  requiredCapabilities: [{ kind: "tool", name: "payment-processor" }],
};

const draftWith = (overrides: Record<string, unknown>): EconomicActionDraft => ({
  ...baseDraft,
  ...(overrides as Partial<EconomicActionDraft>),
});

describe("economic action contract — closed vocabularies (ECO-001)", () => {
  test("purpose vocabulary is closed and frozen", () => {
    expect(ECONOMIC_PURPOSES).toEqual([
      "purchase",
      "payment",
      "transfer",
      "refund",
      "charge",
      "machine-resource",
    ]);
    for (const purpose of ECONOMIC_PURPOSES) {
      expect(isEconomicPurpose(purpose)).toBe(true);
    }
    expect(isEconomicPurpose("subscription")).toBe(false);
    expect(isEconomicPurpose("Purchase")).toBe(false);
    expect(isEconomicPurpose("")).toBe(false);
  });

  test("currency vocabulary is closed, provider-neutral and frozen", () => {
    expect(ECONOMIC_CURRENCIES).toEqual(["usd", "eur", "gbp", "jpy", "cad", "aud", "chf"]);
    for (const currency of ECONOMIC_CURRENCIES) {
      expect(isEconomicCurrency(currency)).toBe(true);
    }
    expect(isEconomicCurrency("USDT")).toBe(false);
    expect(isEconomicCurrency("stripe-usd")).toBe(false);
  });

  test("recipient kinds are closed and opaque (never credentials)", () => {
    expect(RECIPIENT_KINDS).toEqual(["seller", "merchant", "provider", "wallet", "account"]);
    for (const kind of RECIPIENT_KINDS) {
      expect(isRecipientKind(kind)).toBe(true);
    }
    expect(isRecipientKind("card")).toBe(false);
    expect(isRecipientKind("bank-account-number")).toBe(false);
  });

  test("status vocabulary, frozen lifecycle and terminal immutability", () => {
    expect(ECONOMIC_ACTION_STATUSES).toEqual([
      "proposed",
      "denied",
      "authorized",
      "executing",
      "settled",
      "failed",
      "expired",
    ]);
    expect(ECONOMIC_ACTION_TERMINAL_STATUSES).toEqual(["denied", "settled", "failed", "expired"]);
    expect(ECONOMIC_ACTION_TRANSITIONS).toEqual({
      proposed: ["authorized", "denied", "expired"],
      denied: [],
      authorized: ["executing", "expired"],
      executing: ["settled", "failed"],
      settled: [],
      failed: [],
      expired: [],
    });
    for (const status of ECONOMIC_ACTION_STATUSES) {
      expect(isEconomicActionStatus(status)).toBe(true);
      // Terminal statuses accept NO transition (history mutation is dead).
      if (ECONOMIC_ACTION_TERMINAL_STATUSES.includes(status)) {
        for (const target of ECONOMIC_ACTION_STATUSES) {
          expect(economicActionCanTransition(status, target)).toBe(false);
        }
      }
    }
    // Legal forward-only edges.
    expect(economicActionCanTransition("proposed", "authorized")).toBe(true);
    expect(economicActionCanTransition("authorized", "executing")).toBe(true);
    expect(economicActionCanTransition("executing", "settled")).toBe(true);
    // Illegal reversals/lateral moves.
    expect(economicActionCanTransition("authorized", "proposed")).toBe(false);
    expect(economicActionCanTransition("settled", "executing")).toBe(false);
    expect(economicActionCanTransition("proposed", "settled")).toBe(false);
  });
});

describe("economic action contract — money representation (ECO-001)", () => {
  test("amounts are non-negative integer micro-USD decimal strings only", () => {
    expect(isEconomicMicroUsd("0")).toBe(true);
    expect(isEconomicMicroUsd("125000")).toBe(true);
    expect(isEconomicMicroUsd(MAX_ECONOMIC_MICRO_USD)).toBe(true); // int64 max parses
    for (const bad of [
      "",
      "-1",
      "1.5",
      "1e5",
      "0x10",
      " 12",
      "12 ",
      "012", // leading zero: non-canonical
      "10000000000000000000", // 20 digits: above the decimal-string window
      125000,
      null,
      undefined,
    ]) {
      expect(isEconomicMicroUsd(bad)).toBe(false);
    }
  });

  test("deterministic comparison and bound checks (bigint, never float)", () => {
    expect(compareEconomicMicroUsd("1", "2")).toBeLessThan(0);
    expect(compareEconomicMicroUsd("2", "1")).toBeGreaterThan(0);
    expect(compareEconomicMicroUsd("125000", "125000")).toBe(0);
    expect(compareEconomicMicroUsd("9007199254740993", "9007199254740992")).toBeGreaterThan(0);
    expect(amountWithinBounds("125000", "100000", "250000")).toBe(true);
    expect(amountWithinBounds("100000", "100000", "250000")).toBe(true);
    expect(amountWithinBounds("250000", "100000", "250000")).toBe(true);
    expect(amountWithinBounds("99999", "100000", "250000")).toBe(false);
    expect(amountWithinBounds("250001", "100000", "250000")).toBe(false);
  });
});

describe("economic action contract — deterministic draft validation (ECO-001)", () => {
  test("a well-formed draft validates with zero issues", () => {
    expect(validateEconomicActionDraft(baseDraft, NOW)).toEqual([]);
  });

  test("scope/provenance identities are required (tenant/application/execution/actor)", () => {
    const issues = validateEconomicActionDraft(
      draftWith({
        applicationId: "",
        tenantId: "",
        executionId: "",
        proposedBy: "",
      }),
      NOW,
    );
    const fields = issues.map((issue) => issue.field);
    expect(fields).toContain("applicationId");
    expect(fields).toContain("tenantId");
    expect(fields).toContain("executionId");
    expect(fields).toContain("proposedBy");
  });

  test("closed-vocabulary violations are typed failures", () => {
    const purpose = validateEconomicActionDraft(draftWith({ purpose: "gamble" }), NOW);
    expect(purpose.map((issue) => issue.field)).toContain("purpose");

    const currency = validateEconomicActionDraft(draftWith({ currency: "doge" }), NOW);
    expect(currency.map((issue) => issue.field)).toContain("currency");

    const recipientKind = validateEconomicActionDraft(
      draftWith({ recipient: { kind: "card", id: "4242..." } }),
      NOW,
    );
    expect(recipientKind.map((issue) => issue.field)).toContain("recipient.kind");

    const recipientId = validateEconomicActionDraft(
      draftWith({ recipient: { kind: "merchant", id: "" } }),
      NOW,
    );
    expect(recipientId.map((issue) => issue.field)).toContain("recipient.id");
  });

  test("amount bounds: malformed, unordered and oversized ranges are rejected", () => {
    const negative = validateEconomicActionDraft(
      draftWith({ amount: { kind: "exact", microUsd: "-5" } }),
      NOW,
    );
    expect(negative.map((issue) => issue.field)).toContain("amount.microUsd");

    const float = validateEconomicActionDraft(
      draftWith({ amount: { kind: "exact", microUsd: "1.25" } }),
      NOW,
    );
    expect(float.map((issue) => issue.field)).toContain("amount.microUsd");

    const malformedRange = validateEconomicActionDraft(
      draftWith({ amount: { kind: "range", minMicroUsd: "10", maxMicroUsd: "oops" } }),
      NOW,
    );
    expect(malformedRange.map((issue) => issue.field)).toContain("amount");

    const invertedRange = validateEconomicActionDraft(
      draftWith({ amount: { kind: "range", minMicroUsd: "500", maxMicroUsd: "100" } }),
      NOW,
    );
    expect(invertedRange.map((issue) => issue.field)).toContain("amount");
    expect(invertedRange[0]?.message).toContain("min must not exceed max");
  });

  test("expiry: malformed and non-future instants are rejected (bounded in time)", () => {
    const malformed = validateEconomicActionDraft(draftWith({ expiresAt: "soon" }), NOW);
    expect(malformed.map((issue) => issue.field)).toContain("expiresAt");
    expect(malformed[0]?.message).toContain("ISO-8601");

    const past = validateEconomicActionDraft(
      draftWith({ expiresAt: "2020-01-01T00:00:00.000Z" }),
      NOW,
    );
    expect(past.map((issue) => issue.field)).toContain("expiresAt");
    expect(past[0]?.message).toContain("future");

    const sameInstant = validateEconomicActionDraft(
      draftWith({ expiresAt: NOW.toISOString() }),
      NOW,
    );
    expect(sameInstant.map((issue) => issue.field)).toContain("expiresAt");
  });

  test("required-capability shape is validated (name and kind bounds)", () => {
    const emptyName = validateEconomicActionDraft(
      draftWith({ requiredCapabilities: [{ kind: "tool", name: "" }] }),
      NOW,
    );
    expect(emptyName.map((issue) => issue.field)).toContain("requiredCapabilities");

    const longKind = validateEconomicActionDraft(
      draftWith({
        requiredCapabilities: [{ kind: "x".repeat(65), name: "processor" }],
      }),
      NOW,
    );
    expect(longKind.map((issue) => issue.field)).toContain("requiredCapabilities");
  });
});

describe("economic action contract — idempotency identity (ECO-001)", () => {
  test("every material constraint participates in the request fingerprint", () => {
    const parts = economicActionFingerprintParts(baseDraft);
    // The fingerprint basis carries the full material surface: scope
    // identities, actor, purpose, recipient, amount bounds, currency,
    // expiry, capabilities and rail preference.
    const flat = JSON.stringify(parts);
    expect(flat).toContain("purchase");
    expect(flat).toContain("merchant-42");
    expect(flat).toContain("125000");
    expect(flat).toContain("usd");
    expect(flat).toContain(FUTURE);
    expect(flat).toContain("payment-processor");
  });

  test("a mutated material constraint is a DIFFERENT fingerprint (same key then fails)", () => {
    const baseline = canonicalEconomicFingerprint(economicActionFingerprintParts(baseDraft));

    const mutations: Array<[string, EconomicActionDraft]> = [
      ["recipient", draftWith({ recipient: { kind: "merchant", id: "merchant-43" } })],
      ["recipient kind", draftWith({ recipient: { kind: "seller", id: "merchant-42" } })],
      ["amount", draftWith({ amount: { kind: "exact", microUsd: "125001" } })],
      ["currency", draftWith({ currency: "eur" })],
      ["purpose", draftWith({ purpose: "refund" })],
      ["expiry", draftWith({ expiresAt: "2026-09-15T14:00:00.000Z" })],
      ["tenant", draftWith({ tenantId: "11111111-1111-7000-8000-000000000009" })],
      ["application", draftWith({ applicationId: "11111111-1111-7000-8000-000000000009" })],
      ["execution", draftWith({ executionId: "11111111-1111-7000-8000-000000000009" })],
      ["capabilities", draftWith({ requiredCapabilities: [{ kind: "tool", name: "other-tool" }] })],
      ["rail preference", draftWith({ railPreference: "simulated-rail-b" })],
    ];
    for (const [, mutated] of mutations) {
      expect(canonicalEconomicFingerprint(economicActionFingerprintParts(mutated))).not.toBe(
        baseline,
      );
    }
  });

  test("the fingerprint is canonical: key order and array order are deterministic", () => {
    const first = canonicalEconomicFingerprint(economicActionFingerprintParts(baseDraft));
    const reorderedCapabilities = draftWith({
      requiredCapabilities: [{ name: "payment-processor", kind: "tool" }],
    });
    expect(
      canonicalEconomicFingerprint(economicActionFingerprintParts(reorderedCapabilities)),
    ).toBe(first);
    // A semantically different extra capability is a different fingerprint.
    const extended = draftWith({
      requiredCapabilities: [
        { kind: "tool", name: "payment-processor" },
        { kind: "tool", name: "second-tool" },
      ],
    });
    expect(canonicalEconomicFingerprint(economicActionFingerprintParts(extended))).not.toBe(first);
  });
});
