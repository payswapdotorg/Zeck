/**
 * Audit record domain unit tests (WORK-059).
 *
 * Proves: content-addressed identity (idempotent re-observation),
 * chain linkage assignment, total validation (shape, vocabularies,
 * bounds, scrub gate) and both digest verifications (tamper
 * detection).
 */

import { describe, expect, test } from "vitest";
import { createAuditNodeDigest } from "../../../src/modules/audit/adapters/node-digest";
import {
  type AuditRecordForm,
  type AuditSubmission,
  chainLinkSubmission,
  computeAuditRecordDigest,
  computeAuditRecordId,
  validateAuditRecord,
  validateAuditSubmission,
} from "../../../src/modules/audit/public";

const digest = createAuditNodeDigest();

const APPLICATION_ID = "00000000-0000-7000-8000-0000000000aa";
const TENANT_ID = "00000000-0000-7000-8000-0000000000bb";
const EXECUTION_ID = "00000000-0000-7000-8000-0000000000cc";

function submission(overrides: Partial<AuditSubmission> = {}): AuditSubmission {
  return {
    applicationId: APPLICATION_ID,
    tenantId: TENANT_ID,
    environment: "production",
    actor: { actorId: "actor-1", actorKind: "service-principal" },
    action: { kind: "execution.transitioned", command: "authorize", operationKey: "op-1" },
    target: { kind: "execution", id: EXECUTION_ID },
    provenance: { seam: "executions.transition", sourceRecordId: EXECUTION_ID },
    rationale: { why: "execution transition authorize applied" },
    occurredAt: "2026-09-20T12:00:00.000Z",
    actionDetail: { from: "CREATED", to: "AUTHORIZED", sequence: 1 },
    ...overrides,
  };
}

function record(overrides: Partial<AuditSubmission> = {}, sequence = 1, previous = "0".repeat(64)) {
  return chainLinkSubmission(
    submission(overrides),
    {
      chainSequence: sequence,
      previousRecordDigest: previous,
      recordedAt: "2026-09-20T12:00:01.000Z",
    },
    digest,
  );
}

describe("audit record identity (WORK-059)", () => {
  test("the identity is content-addressed and deterministic", () => {
    const first = computeAuditRecordId(submission(), digest);
    const second = computeAuditRecordId(submission(), digest);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  test("volatile fields are EXCLUDED from identity (occurredAt moves, identity does not)", () => {
    const base = computeAuditRecordId(submission(), digest);
    const retried = computeAuditRecordId(
      submission({ occurredAt: "2026-09-20T12:05:00.000Z" }),
      digest,
    );
    expect(retried).toBe(base);
  });

  test("any identity-covered change produces a different identity", () => {
    const base = computeAuditRecordId(submission(), digest);
    expect(
      computeAuditRecordId(
        submission({
          action: { kind: "execution.transitioned", command: "plan", operationKey: "op-1" },
        }),
        digest,
      ),
    ).not.toBe(base);
    expect(
      computeAuditRecordId(
        submission({
          action: { kind: "execution.transitioned", command: "authorize", operationKey: "op-2" },
        }),
        digest,
      ),
    ).not.toBe(base);
    expect(
      computeAuditRecordId(
        submission({ target: { kind: "execution", id: "00000000-0000-7000-8000-0000000000dd" } }),
        digest,
      ),
    ).not.toBe(base);
    expect(
      computeAuditRecordId(
        submission({ actionDetail: { from: "CREATED", to: "PLANNING", sequence: 1 } }),
        digest,
      ),
    ).not.toBe(base);
  });

  test("chain linkage assigns gapless positions and the predecessor digest", () => {
    const first = record();
    expect(first.chainSequence).toBe(1);
    expect(first.previousRecordDigest).toBe("0".repeat(64));
    const second = chainLinkSubmission(
      submission({
        action: { kind: "execution.transitioned", command: "plan", operationKey: "op-2" },
      }),
      {
        chainSequence: 2,
        previousRecordDigest: first.recordDigest,
        recordedAt: "2026-09-20T12:00:02.000Z",
      },
      digest,
    );
    expect(second.previousRecordDigest).toBe(first.recordDigest);
    expect(second.recordDigest).not.toBe(first.recordDigest);
  });
});

describe("audit record validation (WORK-059, fail closed)", () => {
  test("a well-formed record round-trips validation with both digests verified", () => {
    const built = record();
    const validated = validateAuditRecord(JSON.parse(JSON.stringify(built)) as unknown, digest);
    expect(validated.recordId).toBe(built.recordId);
    expect(validated.recordDigest).toBe(built.recordDigest);
  });

  test("tampered content is rejected at read time (identity/integrity mismatch)", () => {
    const built = record();
    const tampered = { ...built, actionDetail: { from: "CREATED", to: "FAILED", sequence: 1 } };
    expect(() => validateAuditRecord(tampered, digest)).toThrow(/recordId/);
    const tamperedDigest = { ...built, recordDigest: "f".repeat(64) };
    expect(() => validateAuditRecord(tamperedDigest, digest)).toThrow(/recordDigest/);
  });

  test("vocabulary violations are rejected", () => {
    expect(() =>
      validateAuditSubmission(
        submission({
          action: { kind: "budget.reserved", command: "reserve", operationKey: "op" } as never,
        }),
      ),
    ).toThrow(/vocabulary/);
    expect(() =>
      validateAuditSubmission(submission({ actor: { actorId: "a", actorKind: "robot" } as never })),
    ).toThrow(/vocabulary/);
    expect(() =>
      validateAuditSubmission(submission({ target: { kind: "budget", id: "b1" } as never })),
    ).toThrow(/vocabulary/);
    expect(() =>
      validateAuditSubmission(
        submission({
          provenance: { seam: "budgets.reserve", sourceRecordId: null } as never,
        }),
      ),
    ).toThrow(/vocabulary/);
  });

  test("bounds violations are rejected (bounded evidence)", () => {
    expect(() => validateAuditSubmission(submission({ environment: "" }))).toThrow();
    expect(() =>
      validateAuditSubmission(submission({ rationale: { why: "x".repeat(501) } })),
    ).toThrow();
    expect(() => validateAuditSubmission(submission({ applicationId: "not-a-uuid" }))).toThrow();
    expect(() => validateAuditSubmission(submission({ occurredAt: "yesterday" }))).toThrow();
  });

  test("secret-shaped detail keys make the submission unrepresentable (scrub gate)", () => {
    expect(() =>
      validateAuditSubmission(submission({ actionDetail: { apiToken: "abc" } })),
    ).toThrow(/scrub gate|unrepresentable/);
  });

  test("the full-record digest covers the chain linkage (tamper of linkage detected)", () => {
    const first = record();
    const second = chainLinkSubmission(
      submission({
        action: { kind: "execution.transitioned", command: "plan", operationKey: "op-2" },
      }),
      {
        chainSequence: 2,
        previousRecordDigest: first.recordDigest,
        recordedAt: "2026-09-20T12:00:02.000Z",
      },
      digest,
    );
    // A forged linkage (claims the genesis, not the real predecessor):
    const forged: AuditRecordForm = { ...second, previousRecordDigest: "0".repeat(64) };
    const forgedDigest = computeAuditRecordDigest(forged, digest);
    expect(forgedDigest).not.toBe(second.recordDigest);
    expect(() =>
      validateAuditRecord({ ...second, previousRecordDigest: "0".repeat(64) }, digest),
    ).toThrow(/recordDigest/);
  });
});
