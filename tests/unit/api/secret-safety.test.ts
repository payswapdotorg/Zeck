/**
 * Secret-safety serialization tests (WORK-015; acceptance criterion 6,
 * M4–M8) — the serialization boundary as the LAST line of defense.
 *
 * Required-test mapping:
 *  - allowlist construction: every public serializer produces EXACTLY
 *    the wire fields (a domain record with extra fields cannot leak —
 *    the serializer never spreads);
 *  - the scrub guard redacts secret-shaped keys deeply (defense in
 *    depth for caller-provided metadata/task payloads);
 *  - no serializer output contains secret material under any key;
 *  - unknown error objects serialize to the disclosure-free public
 *    error shape (M25).
 */

import { describe, expect, test } from "vitest";
import { scrubSecretShapedKeys, toWireExecution, toWireReceipt } from "../../../src/api";
import { mapErrorToResponse } from "../../../src/api/error-mapper";
import type { ExecutionReceipt, ExecutionRecord } from "../../../src/modules/executions/public";
import { PlatformError } from "../../../src/shared/errors";
import { fakeReply } from "./helpers";

function executionRecord(over: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: "exec-1",
    applicationId: "app-1",
    tenantId: "tenant-1",
    environmentId: null,
    userId: "",
    status: "RUNNING",
    task: { kind: "summarize", input: "doc" },
    inputArtifactRefs: [],
    constraints: null,
    metadata: {},
    requestFingerprint: "fp",
    lastEventSequence: 3,
    verificationRefs: [],
    createdAt: "2026-09-15T12:00:00Z",
    updatedAt: "2026-09-15T12:00:01Z",
    terminalAt: null,
    ...over,
  };
}

describe("allowlist construction (M4/M5 — no spread, no accidental fields)", () => {
  test("the execution wire shape carries EXACTLY the public fields", () => {
    const record = executionRecord();
    const wire = toWireExecution(record);
    expect(Object.keys(wire).sort()).toEqual(
      [
        "applicationId",
        "constraints",
        "createdAt",
        "environmentId",
        "id",
        "metadata",
        "status",
        "task",
        "terminalAt",
        "updatedAt",
      ].sort(),
    );
    // Domain-internal fields never cross.
    expect(Object.keys(wire)).not.toContain("requestFingerprint");
    expect(Object.keys(wire)).not.toContain("tenantId");
    expect(Object.keys(wire)).not.toContain("verificationRefs");
    expect(Object.keys(wire)).not.toContain("userId");
  });

  test("a mutated serializer input with an added secret field cannot leak (no spread)", () => {
    // Even if a domain record gained a secret-shaped field, the
    // field-by-field construction drops it.
    const poisoned = executionRecord({
      metadata: { ok: "value" },
    });
    (poisoned as unknown as Record<string, unknown>).credentialRef = "vault://secret-123";
    const wire = toWireExecution(poisoned);
    expect(JSON.stringify(wire)).not.toContain("vault://secret-123");
    expect(JSON.stringify(wire)).not.toContain("credentialRef");
  });

  test("the receipt wire shape carries EXACTLY the receipt fields", () => {
    const receipt: ExecutionReceipt = {
      executionId: "exec-1",
      applicationId: "app-1",
      tenantId: "tenant-1",
      environmentId: null,
      status: "CREATED",
      lastEventSequence: 1,
      verificationRefs: [],
      createdAt: "2026-09-15T12:00:00Z",
      terminalAt: null,
      replayed: false,
    };
    const wire = toWireReceipt(receipt);
    expect(Object.keys(wire).sort()).toEqual(
      [
        "applicationId",
        "createdAt",
        "executionId",
        "lastEventSequence",
        "replayed",
        "status",
      ].sort(),
    );
  });
});

describe("the scrub guard (defense in depth, M4–M8)", () => {
  test("secret-shaped keys are redacted at every depth", () => {
    const scrubbed = scrubSecretShapedKeys({
      apiKey: "sk-live-123",
      nested: {
        password: "hunter2",
        safe: "ok",
        deeper: [{ secretToken: "abc", keep: 1 }],
      },
    }) as Record<string, unknown>;
    expect(scrubbed.apiKey).toBe("[redacted]");
    const nested = scrubbed.nested as Record<string, unknown>;
    expect(nested.password).toBe("[redacted]");
    expect(nested.safe).toBe("ok");
    const deeper = (nested.deeper as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(deeper.secretToken).toBe("[redacted]");
    expect(deeper.keep).toBe(1);
  });

  test("caller metadata with secret-shaped keys is scrubbed in execution reads", () => {
    const record = executionRecord({
      metadata: { apiToken: "customer-accidentally-put-a-token", note: "hello" },
    });
    const wire = toWireExecution(record);
    expect(wire.metadata).toEqual({ apiToken: "[redacted]", note: "hello" });
  });
});

describe("M25: the unknown-error boundary discloses nothing internal", () => {
  test("a raw Error with SQL/internals maps to the generic public body", () => {
    const reply = fakeReply();
    const error = new Error(
      'SQL error: UPDATE executions.executions ... relation "users" does not exist at /home/zeck/src/db.ts:42',
    );
    mapErrorToResponse(reply as never, error);
    const body = reply.sentBody as Record<string, unknown>;
    expect(body.code).toBe("PROVIDER_ERROR");
    expect(body.retryable).toBe(true);
    expect(body.message).not.toContain("SQL");
    expect(body.message).not.toContain("/home");
    expect(body.message).not.toContain("executions.executions");
    expect(JSON.stringify(body)).not.toContain("stack");
  });

  test("a PlatformError maps to its canonical code and scrubbed details", () => {
    const reply = fakeReply();
    const error = new PlatformError({
      code: "POLICY_DENIED",
      message: "policy denied this request",
      details: { secretRef: "should-be-redacted", allowed: true },
    });
    mapErrorToResponse(reply as never, error);
    const body = reply.sentBody as Record<string, unknown>;
    expect(body.code).toBe("POLICY_DENIED");
    const details = body.details as Record<string, unknown>;
    expect(details.secretRef).toBe("[redacted]");
    expect(details.allowed).toBe(true);
  });

  test("a rejected non-error value fails closed to the generic body", () => {
    const reply = fakeReply();
    mapErrorToResponse(reply as never, "just a string with PII someone@somewhere");
    const body = reply.sentBody as Record<string, unknown>;
    expect(body.code).toBe("PROVIDER_ERROR");
    expect(body.message).not.toContain("PII");
  });
});
