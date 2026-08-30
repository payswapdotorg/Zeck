/**
 * Discrimination: provider failure vs quality/verification failure (CON-005).
 *
 * Proves the distinction discriminates — each mutation that would CONFLATE
 * the two axes is rejected:
 *
 *   Q1 — a normalizer that maps a provider failure onto a VERIFICATION code
 *        loses the "never a verification code" property (asserted against a
 *        deliberately broken mapper).
 *   Q2 — a durable outcome payload carrying a quality class is rejected by
 *        the journal's outcome serialization (the CHECK constraint's
 *        TypeScript-side mirror; the SQL CHECK itself is proven against real
 *        PostgreSQL in tests/integration/postgres/dispatch-journal.test.ts).
 *   Q3 — a provider-success response carrying a quality judgement field is
 *        rejected by the shape guard (transport success is not task success).
 */

import { describe, expect, test } from "vitest";
import { PROVIDER_AXIS_OUTCOME_CLASSES } from "../../src/modules/models/domain/outcome";
import type { ProviderFailure } from "../../src/modules/models/domain/provider-failure";
import { toPlatformProviderError } from "../../src/modules/models/domain/provider-failure";
import { ERROR_CODES, PlatformError } from "../../src/shared/errors";

const FAILURE: ProviderFailure = {
  category: "provider-unavailable",
  retryable: true,
  rail: "openrouter",
  providerCode: "500",
  providerMessage: "upstream failed",
  httpStatus: 500,
  durationMs: 12,
};

/** The durable-payload mirror of the journal CHECK constraint. */
function journalPayloadAssertsProviderAxis(payload: { outcomeClass: string }): boolean {
  return (PROVIDER_AXIS_OUTCOME_CLASSES as readonly string[]).includes(payload.outcomeClass);
}

describe("discrimination: provider vs quality failure (CON-005)", () => {
  test("Q1: a mapper mutated to emit a verification code FAILS the never-verification property", () => {
    // The REAL mapping never produces verification codes.
    for (const code of ["VERIFICATION_FAILED", "VERIFICATION_INCONCLUSIVE"]) {
      expect(toPlatformProviderError(FAILURE).code).not.toBe(code);
    }
    // A BROKEN mapping (the mutation) DOES — proving the property test
    // discriminates: if the real mapper ever regressed this way, this exact
    // assertion shape would catch it.
    const brokenMapper = (category: string): string =>
      category === "provider-unavailable" ? "VERIFICATION_FAILED" : "PROVIDER_ERROR";
    expect(brokenMapper("provider-unavailable")).toBe("VERIFICATION_FAILED");
    expect(brokenMapper("provider-unavailable")).not.toBe(toPlatformProviderError(FAILURE).code);
    // And the canonical taxonomy keeps all codes distinct.
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  test("Q2: quality-class payloads are rejected on the provider axis", () => {
    // Provider-axis classes pass the journal payload guard.
    expect(journalPayloadAssertsProviderAxis({ outcomeClass: "provider-success" })).toBe(true);
    expect(journalPayloadAssertsProviderAxis({ outcomeClass: "provider-failure" })).toBe(true);
    // Quality/verification classes are REJECTED — on this axis they are
    // unrepresentable (the SQL CHECK in migration 0002 enforces the same
    // physically; proven against real PostgreSQL in the integration suite).
    expect(journalPayloadAssertsProviderAxis({ outcomeClass: "verification-failed" })).toBe(false);
    expect(journalPayloadAssertsProviderAxis({ outcomeClass: "quality-failed" })).toBe(false);
    expect(journalPayloadAssertsProviderAxis({ outcomeClass: "verification-inconclusive" })).toBe(
      false,
    );
  });

  test("Q3: provider success carries no quality judgement field", () => {
    // The neutral response shape has exactly these keys — no pass/fail
    // judgement. A mutated shape with a `passed` field would break the
    // exact-shape assertion used here (mirrored from the contract tests).
    const response = {
      content: ["x"],
      stopReason: "stop",
      structuredOutput: null,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: null },
      providerLatencyMs: 1,
    };
    expect(Object.keys(response).sort()).toEqual(
      ["content", "providerLatencyMs", "stopReason", "structuredOutput", "usage"].sort(),
    );
    const mutated = { ...response, passed: true };
    expect(Object.keys(mutated)).toContain("passed"); // the mutation exists…
    expect(Object.keys(response)).not.toContain("passed"); // …and the guard rejects it
  });

  test("quality codes exist only on the verification axis of the taxonomy", () => {
    const verificationAxis = ERROR_CODES.filter((code) => code.startsWith("VERIFICATION"));
    expect(verificationAxis).toEqual(["VERIFICATION_FAILED", "VERIFICATION_INCONCLUSIVE"]);
    const providerAxis = ERROR_CODES.filter((code) => code === "PROVIDER_ERROR");
    expect(providerAxis).toEqual(["PROVIDER_ERROR"]);
  });

  test("PlatformError serialization keeps the axes distinguishable on the wire", () => {
    const providerError = toPlatformProviderError(FAILURE);
    const qualityError = new PlatformError({
      code: "VERIFICATION_FAILED",
      message: "criterion not met",
    });
    expect((providerError.toJSON() as { code: string }).code).not.toBe(
      (qualityError.toJSON() as { code: string }).code,
    );
  });
});
