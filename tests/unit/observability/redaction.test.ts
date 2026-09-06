/**
 * Unit — telemetry redaction (WORK-047 / D-06; invariant 4: telemetry
 * never transports secrets).
 */

import { describe, expect, test } from "vitest";
import { TELEMETRY_BOUNDS } from "../../../src/platform/observability/port";
import {
  redactTelemetryAttributes,
  redactTelemetryMessage,
} from "../../../src/platform/observability/redaction";

describe("telemetry redaction (WORK-047 D-06)", () => {
  test("secret-shaped KEYS are rejected outright (the record is inadmissible)", () => {
    for (const key of [
      "token",
      "apiToken",
      "api_token",
      "secret",
      "clientSecret",
      "password",
      "authorization",
      "auth",
      "apiKey",
      "api-key",
      "session-key",
      "private-key",
    ]) {
      const result = redactTelemetryAttributes({ [key]: "x" });
      expect(result.admissible, `key "${key}" must be rejected`).toBe(false);
      expect(result.reason).toContain("secret-shaped attribute key");
    }
  });

  test("non-secret keys are admissible", () => {
    const result = redactTelemetryAttributes({
      executionId: "exec-1",
      disposition: "settled",
      claimEpoch: "3",
      route: "/health",
    });
    expect(result.admissible).toBe(true);
    expect(result.attributes.executionId).toBe("exec-1");
  });

  test("credential-shaped VALUES are redacted in place and counted", () => {
    const result = redactTelemetryAttributes({
      detail: "connected via postgres://user:supersecret@db.host:5432/zeck",
      note: "token sk-abcdefgh1234567890 rejected",
      header: "authorization Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpX",
    });
    expect(result.admissible).toBe(true);
    expect(result.attributes.detail).not.toContain("supersecret");
    expect(result.attributes.detail).toContain("[redacted]@");
    expect(result.attributes.note).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    expect(result.attributes.header).toContain("[redacted]");
    expect(result.redactions).toBeGreaterThanOrEqual(3);
  });

  test("control characters are stripped from values", () => {
    const result = redactTelemetryAttributes({ detail: "bad\u0000\u0007value" });
    expect(result.admissible).toBe(true);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting the stripping is the point.
    expect(result.attributes.detail).not.toMatch(/[\u0000-\u001f]/);
  });

  test("attribute count over the bound is rejected (unbounded telemetry is unrepresentable)", () => {
    const attributes: Record<string, string> = {};
    for (let index = 0; index < TELEMETRY_BOUNDS.maxAttributes + 1; index += 1) {
      attributes[`k${index}`] = "v";
    }
    const result = redactTelemetryAttributes(attributes);
    expect(result.admissible).toBe(false);
    expect(result.reason).toContain("attribute count");
  });

  test("oversized values are truncated to the bound", () => {
    const result = redactTelemetryAttributes({
      detail: "x".repeat(TELEMETRY_BOUNDS.maxAttributeLength + 50),
    });
    expect(result.admissible).toBe(true);
    expect(result.attributes.detail?.length).toBeLessThanOrEqual(
      TELEMETRY_BOUNDS.maxAttributeLength + 1,
    );
  });

  test("non-string, non-number, non-boolean values are rejected (reference-only telemetry)", () => {
    expect(redactTelemetryAttributes({ payload: { nested: "object" } }).admissible).toBe(false);
    expect(redactTelemetryAttributes({ list: ["a", "b"] }).admissible).toBe(false);
    expect(redactTelemetryAttributes({ nothing: null }).admissible).toBe(false);
    expect(redactTelemetryAttributes({ count: 7 }).admissible).toBe(true);
    expect(redactTelemetryAttributes({ ok: true }).admissible).toBe(true);
  });

  test("message redaction: bounded and credential-free", () => {
    const message = redactTelemetryMessage(
      "postgres://user:secretpw@host/db unreachable plus ghp_abcdefghij123456789012 in text",
    );
    expect(message).not.toContain("secretpw");
    expect(message).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
    const oversized = redactTelemetryMessage("x".repeat(TELEMETRY_BOUNDS.maxMessageLength + 100));
    expect(oversized.length).toBeLessThanOrEqual(TELEMETRY_BOUNDS.maxMessageLength);
  });
});
