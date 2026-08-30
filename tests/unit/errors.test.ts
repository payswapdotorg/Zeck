/**
 * Unit tests — canonical error taxonomy (`src/shared/errors.ts`).
 *
 * The taxonomy is frozen in `spec/contracts.md` ("Error taxonomy"). The
 * spec-sync test parses the governing document and requires the code's
 * `ERROR_CODES` to match it exactly — code and frozen contract can never
 * drift apart silently.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ERROR_CODES, PlatformError } from "../../src/shared/errors";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function errorCodesFromSpec(): string[] {
  const contracts = readFileSync(resolve(REPO_ROOT, "spec/contracts.md"), "utf8");
  const taxonomySection = contracts.split("## Error taxonomy", 2)[1]?.split("##", 1)[0] ?? "";
  return [...taxonomySection.matchAll(/^- `([A-Z_]+)`$/gm)]
    .map((match) => match[1])
    .filter((code): code is string => code !== undefined);
}

describe("error taxonomy stays in sync with spec/contracts.md", () => {
  test("ERROR_CODES matches the frozen taxonomy exactly (order included)", () => {
    expect([...ERROR_CODES]).toEqual(errorCodesFromSpec());
  });

  test("the frozen taxonomy carries the seventeen canonical codes", () => {
    expect(errorCodesFromSpec()).toHaveLength(17);
    expect(new Set(errorCodesFromSpec()).size).toBe(17);
  });
});

describe("PlatformError", () => {
  test("carries code, message and defaults", () => {
    const error = new PlatformError({ code: "POLICY_DENIED", message: "tool not allowed" });
    expect(error.name).toBe("PlatformError");
    expect(error.code).toBe("POLICY_DENIED");
    expect(error.message).toBe("tool not allowed");
    expect(error.retryable).toBe(false);
    expect(error.details).toBeUndefined();
  });

  test("exposes a machine-readable body at transport boundaries", () => {
    const error = new PlatformError({
      code: "IDEMPOTENCY_KEY_REUSED",
      message: "key already used with a different fingerprint",
      retryable: false,
      details: { operation: "createExecution" },
    });
    expect(error.toJSON()).toEqual({
      code: "IDEMPOTENCY_KEY_REUSED",
      message: "key already used with a different fingerprint",
      retryable: false,
      details: { operation: "createExecution" },
    });
  });

  test("preserves the cause chain", () => {
    const cause = new Error("adapter timeout");
    const error = new PlatformError({
      code: "PROVIDER_ERROR",
      message: "provider call failed",
      cause,
    });
    expect(error.cause).toBe(cause);
    expect(error.retryable).toBe(false);
  });

  test("accepts every frozen code", () => {
    for (const code of ERROR_CODES) {
      const error = new PlatformError({ code, message: "x" });
      expect(error.code).toBe(code);
    }
  });
});
