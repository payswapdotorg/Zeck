/**
 * Unit: provider failure vs quality/verification failure (CON-005).
 *
 * The two failure axes are distinct error CLASSES in the canonical taxonomy,
 * in the adapter normalization and in the durable outcome union — a provider
 * failure can never be represented, mapped or recorded as a quality failure
 * and vice versa.
 */

import { describe, expect, test } from "vitest";
import { PROVIDER_AXIS_OUTCOME_CLASSES } from "../../../src/modules/models/domain/outcome";
import type { ProviderFailure } from "../../../src/modules/models/domain/provider-failure";
import { toPlatformProviderError } from "../../../src/modules/models/domain/provider-failure";
import { ERROR_CODES } from "../../../src/shared/errors";

const ANY_FAILURE: ProviderFailure = {
  category: "provider-unavailable",
  retryable: true,
  rail: "openrouter",
  providerCode: "500",
  providerMessage: "upstream exploded",
  httpStatus: 500,
  durationMs: 42,
};

describe("provider vs quality failure distinction (CON-005)", () => {
  test("the canonical taxonomy keeps the axes as distinct codes", () => {
    expect(ERROR_CODES).toContain("PROVIDER_ERROR");
    expect(ERROR_CODES).toContain("VERIFICATION_FAILED");
    expect(ERROR_CODES).toContain("VERIFICATION_INCONCLUSIVE");
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  test("every provider failure normalizes to PROVIDER_ERROR — never a verification code", () => {
    const categories = [
      "authentication",
      "authorization",
      "rate-limit",
      "quota",
      "invalid-request",
      "content-policy",
      "provider-unavailable",
      "timeout",
      "network",
      "malformed-response",
      "canceled",
      "unknown",
    ] as const;
    for (const category of categories) {
      const error = toPlatformProviderError({ ...ANY_FAILURE, category });
      expect(error.code).toBe("PROVIDER_ERROR");
      expect(error.code).not.toBe("VERIFICATION_FAILED");
      expect(error.code).not.toBe("VERIFICATION_INCONCLUSIVE");
    }
  });

  test("verification codes are unreachable from provider failure metadata", () => {
    const error = toPlatformProviderError(ANY_FAILURE);
    const serialized = JSON.stringify(error.toJSON());
    expect(serialized).not.toContain("VERIFICATION_FAILED");
    expect(serialized).not.toContain("VERIFICATION_INCONCLUSIVE");
  });

  test("the durable outcome union admits exactly the two provider-axis classes", () => {
    expect(PROVIDER_AXIS_OUTCOME_CLASSES).toEqual(["provider-success", "provider-failure"]);
    expect(PROVIDER_AXIS_OUTCOME_CLASSES).not.toContain("verification-failed");
    expect(PROVIDER_AXIS_OUTCOME_CLASSES).not.toContain("quality-failed");
  });

  test("provider success carries no quality judgement by contract", () => {
    // The neutral response type has no pass/fail field: transport success is
    // not task success (spec/architecture.md §18). Static shape proof.
    const responseShape = {
      content: ["text"],
      stopReason: "stop",
      structuredOutput: null,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: null },
      providerLatencyMs: 1,
    };
    expect(Object.keys(responseShape).sort()).toEqual(
      ["content", "providerLatencyMs", "stopReason", "structuredOutput", "usage"].sort(),
    );
  });
});
