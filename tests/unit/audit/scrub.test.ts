/**
 * Audit seam scrubbing unit tests (WORK-059 / SEC-004).
 *
 * Discrimination: secret-shaped KEYS are rejected (fail closed),
 * credential-shaped VALUES are redacted in place (counted), shape
 * bounds (depth/keys/size) fail closed — the D-06 three-layer
 * discipline extended to structured audit detail.
 */

import { describe, expect, test } from "vitest";
import { scrubAuditDetail, scrubAuditText } from "../../../src/modules/audit/public";

describe("audit seam scrubbing (WORK-059)", () => {
  test("secret-shaped keys are rejected (the record fails closed)", () => {
    for (const key of [
      "token",
      "apiToken",
      "api-token",
      "API_KEY",
      "client_secret",
      "password",
      "authorization",
      "sessionKey",
    ]) {
      const result = scrubAuditDetail({ [key]: "value" });
      expect(result.admissible, `key "${key}" must be rejected`).toBe(false);
      expect(result.reason).toMatch(/secret-shaped/i);
    }
  });

  test("credential-shaped VALUES are redacted in place and counted", () => {
    const fragment = "sk" + "abcdefghijklmnopqrstuvwxyz012345";
    const result = scrubAuditDetail({
      note: `use key ${fragment} now`,
      endpoint: "https://user:supersecretpw@example.com/path",
      header: "bearer " + "a".repeat(30),
    });
    expect(result.admissible).toBe(true);
    expect(result.detail.note).toContain("[redacted]");
    expect(result.detail.note).not.toContain(fragment);
    expect(result.detail.endpoint).toContain("[redacted]@");
    expect(result.detail.endpoint).not.toContain("supersecretpw");
    expect(result.detail.header).toContain("[redacted]");
    expect(result.redactions).toBeGreaterThanOrEqual(3);
  });

  test("scrubbing is recursive over nested structures", () => {
    const fragment = "ghp_" + "abcdefghijklmnopqrstuvwx";
    const result = scrubAuditDetail({
      outer: { inner: { note: `token ${fragment} leaked` } },
      list: [`password=${"b".repeat(24)}`],
    });
    expect(result.admissible).toBe(true);
    expect(JSON.stringify(result.detail)).not.toContain(fragment);
    expect(JSON.stringify(result.detail)).toContain("[redacted]");
  });

  test("control characters are replaced with spaces", () => {
    const result = scrubAuditDetail({ note: "a\u0000b\u0007c" });
    expect(result.admissible).toBe(true);
    expect(result.detail.note).toBe("a b c");
  });

  test("shape bounds fail closed (depth, key count, total size, value types)", () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
    expect(scrubAuditDetail(deep).admissible).toBe(false);
    const wide: Record<string, number> = {};
    for (let index = 0; index < 33; index += 1) {
      wide[`k${index}`] = index;
    }
    expect(scrubAuditDetail(wide).admissible).toBe(false);
    // A single huge VALUE is capped in place (bounded evidence, not a
    // rejection); the TOTAL canonical size is the hard bound.
    const capped = scrubAuditDetail({ blob: "x".repeat(5000) });
    expect(capped.admissible).toBe(true);
    expect(String(capped.detail.blob).length).toBeLessThanOrEqual(513);
    const bulky: Record<string, string> = {};
    for (let index = 0; index < 10; index += 1) {
      bulky[`k${index}`] = "y".repeat(600);
    }
    expect(scrubAuditDetail(bulky).admissible).toBe(false);
    expect(scrubAuditDetail({ fn: () => undefined }).admissible).toBe(false);
    expect(scrubAuditDetail({ big: 10n }).admissible).toBe(false);
  });

  test("bounded audit text (why/reasons) scrubs credential-shaped values", () => {
    const fragment = "AKIA" + "IOSFODNN7EXAMPLE";
    const scrubbed = scrubAuditText(`access key ${fragment} on host`);
    expect(scrubbed).toContain("[redacted]");
    expect(scrubbed).not.toContain(fragment);
    const long = scrubAuditText("y".repeat(600));
    expect(long.length).toBeLessThanOrEqual(501);
  });
});
