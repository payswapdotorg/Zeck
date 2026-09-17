/**
 * Sandbox governance service tests (DEP-014 AC2/3/4/5 — the fail-closed,
 * expiration, reset-idempotency and policy probes over the REAL
 * services with in-memory stores + a recording ledger fake).
 */

import { describe, expect, test } from "vitest";
import { createInMemoryQuotaStore, createQuotaService } from "../../src/modules/budgets/public";
import { SYNTHETIC_DATA_POLICY } from "../../src/modules/sandbox/domain/synthetic-data-policy";
import type { SandboxExecutionLedger } from "../../src/modules/sandbox/public";
import {
  createInMemorySandboxIdentityStore,
  createSandboxIdentityService,
} from "../../src/modules/sandbox/public";
import { PlatformError } from "../../src/shared/errors";

const NOW = "2026-09-17T12:00:00.000Z";

const fixedClock = (): (() => string) => () => NOW;

function idGen(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(4, "0")}`;
}

interface RecordedEvent {
  readonly cause?: string;
  readonly reference?: Readonly<Record<string, unknown>>;
}

function recordingLedger(): { ledger: SandboxExecutionLedger; events: RecordedEvent[] } {
  const events: RecordedEvent[] = [];
  return {
    events,
    ledger: {
      async recordStepEvent(event) {
        events.push({ cause: event.cause, reference: event.reference });
        return { sequence: events.length, type: event.command, replayed: false };
      },
      async getExecution() {
        return null;
      },
    },
  };
}

const SCOPE = { applicationId: "app-1", tenantId: "tenant-1" };
const ACTOR = { actorId: "actor-1", ...SCOPE };

describe("the quota service (DEP-014 AC1/2)", () => {
  test("configure + assess renders every dimension with limit, consumption, window, status", async () => {
    const service = createQuotaService({
      store: createInMemoryQuotaStore(fixedClock()),
      now: fixedClock(),
      newId: idGen("quota"),
    });
    for (const dimension of [
      "spend-micro-usd",
      "wall-clock-ms",
      "concurrent-runs",
      "artifact-count",
      "artifact-bytes",
    ] as const) {
      await service.configure({ ...SCOPE, dimension, limit: "1000", window: "calendar-month" });
    }
    const records = await service.assess(SCOPE);
    expect(records.map((r) => r.dimension)).toEqual([
      "spend-micro-usd",
      "wall-clock-ms",
      "concurrent-runs",
      "artifact-count",
      "artifact-bytes",
    ]);
    for (const record of records) {
      expect(record.limit).toBe("1000");
      expect(record.consumed).toBe("0");
      expect(record.window).toBe("calendar-month");
      expect(record.status).toBe("active");
    }
  });

  test("consume within limit succeeds; consumption accrues", async () => {
    const service = createQuotaService({
      store: createInMemoryQuotaStore(fixedClock()),
      now: fixedClock(),
      newId: idGen("quota"),
    });
    await service.configure({
      ...SCOPE,
      dimension: "artifact-count",
      limit: "10",
      window: "per-identity",
      identityId: "id-1",
    });
    const first = await service.consume({
      ...SCOPE,
      dimension: "artifact-count",
      amount: "4",
      identityId: "id-1",
    });
    expect(first.consumed).toBe("4");
    const second = await service.consume({
      ...SCOPE,
      dimension: "artifact-count",
      amount: "6",
      identityId: "id-1",
    });
    expect(second.consumed).toBe("10");
    expect(second.status).toBe("exhausted");
  });

  test("a consume that would exceed DENIES fail-closed with a recorded violation fact (AC2)", async () => {
    const service = createQuotaService({
      store: createInMemoryQuotaStore(fixedClock()),
      now: fixedClock(),
      newId: idGen("quota"),
    });
    await service.configure({
      ...SCOPE,
      dimension: "concurrent-runs",
      limit: "2",
      window: "calendar-month",
    });
    await service.consume({ ...SCOPE, dimension: "concurrent-runs", amount: "2" });
    await expect(
      service.consume({ ...SCOPE, dimension: "concurrent-runs", amount: "1" }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    const violations = await service.violations(SCOPE);
    expect(violations.length).toBe(1);
    expect(violations[0]?.dimension).toBe("concurrent-runs");
    expect(violations[0]?.decision).toBe("denied");
  });

  test("an UNENFORCEABLE dimension (missing row / malformed amount) denies, never default-allows (AC2)", async () => {
    const service = createQuotaService({
      store: createInMemoryQuotaStore(fixedClock()),
      now: fixedClock(),
      newId: idGen("quota"),
    });
    await expect(
      service.consume({ ...SCOPE, dimension: "wall-clock-ms", amount: "1" }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    await service.configure({
      ...SCOPE,
      dimension: "spend-micro-usd",
      limit: "100",
      window: "calendar-month",
    });
    await expect(
      service.consume({ ...SCOPE, dimension: "spend-micro-usd", amount: "not-a-number" }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  test("release floors at zero and returns the record", async () => {
    const service = createQuotaService({
      store: createInMemoryQuotaStore(fixedClock()),
      now: fixedClock(),
      newId: idGen("quota"),
    });
    await service.configure({
      ...SCOPE,
      dimension: "artifact-bytes",
      limit: "100",
      window: "calendar-month",
    });
    await service.consume({ ...SCOPE, dimension: "artifact-bytes", amount: "30" });
    const released = await service.release({ ...SCOPE, dimension: "artifact-bytes", amount: "99" });
    expect(released?.consumed).toBe("0");
  });
});

describe("the sandbox identity service (DEP-014 AC3/4/5)", () => {
  function build(ttlMs?: number) {
    const { ledger, events } = recordingLedger();
    const service = createSandboxIdentityService({
      store: createInMemorySandboxIdentityStore(fixedClock()),
      ledger,
      now: fixedClock(),
      newId: idGen("identity"),
    });
    return { service, events, ttlMs };
  }

  test("establish creates an active identity with TTL and records the ledger event (AC3)", async () => {
    const { service, events } = build();
    const record = await service.establish({
      ...ACTOR,
      executionId: "exec-1",
      declaredDataClasses: ["synthetic-text"],
      idempotencyKey: "key-1",
    });
    expect(record.status).toBe("active");
    expect(record.expiresAt).toBe("2026-09-17T14:00:00.000Z");
    expect(events.length).toBe(1);
    expect(events[0]?.cause).toBe("sandbox-identity-established");
  });

  test("a prohibited data class REFUSES establish fail-closed with a recorded fact (AC5)", async () => {
    const { service } = build();
    await expect(
      service.establish({
        ...ACTOR,
        executionId: "exec-1",
        declaredDataClasses: ["real-pii"],
        idempotencyKey: "key-1",
      }),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    const violations = await service.policyViolations(SCOPE.applicationId);
    expect(violations.length).toBe(1);
    expect(violations[0]?.prohibitedClass).toBe("real-pii");
    expect(violations[0]?.decision).toBe("denied");
    // facts only: the violation carries no payload field at all
    expect(Object.keys(violations[0] ?? {})).toEqual([
      "applicationId",
      "prohibitedClass",
      "decision",
      "occurredAt",
    ]);
  });

  test("post-expiry reads return the honest EXPIRED record, never a silent null (AC3)", async () => {
    let now = Date.parse(NOW);
    const { service } = {
      service: createSandboxIdentityService({
        store: createInMemorySandboxIdentityStore(() => new Date(now).toISOString()),
        ledger: recordingLedger().ledger,
        now: () => new Date(now).toISOString(),
        newId: idGen("identity"),
      }),
    };
    const record = await service.establish({
      ...ACTOR,
      executionId: "exec-1",
      idempotencyKey: "k",
    });
    now += 3 * 60 * 60 * 1000; // past the 2h TTL
    const read = await service.get(SCOPE.applicationId, record.id);
    expect(read?.status).toBe("expired");
    expect(read?.id).toBe(record.id);
  });

  test("expireOverdue transitions overdue identities and is idempotent (AC3)", async () => {
    let now = Date.parse(NOW);
    const service = createSandboxIdentityService({
      store: createInMemorySandboxIdentityStore(() => new Date(now).toISOString()),
      ledger: recordingLedger().ledger,
      now: () => new Date(now).toISOString(),
      newId: idGen("identity"),
    });
    const record = await service.establish({
      ...ACTOR,
      executionId: "exec-1",
      idempotencyKey: "k",
    });
    now += 3 * 60 * 60 * 1000;
    const first = await service.expireOverdue(SCOPE.applicationId);
    expect(first.length).toBe(1);
    expect(first[0]?.status).toBe("expired");
    const second = await service.expireOverdue(SCOPE.applicationId);
    expect(second.length).toBe(0);
  });

  test("reset establishes a fresh successor, carries NOTHING forward, and is idempotent (AC4)", async () => {
    const { service } = build();
    const predecessor = await service.establish({
      ...ACTOR,
      executionId: "exec-1",
      declaredDataClasses: ["synthetic-text"],
      idempotencyKey: "k1",
    });
    const successor = await service.reset({
      ...ACTOR,
      identityId: predecessor.id,
      executionId: "exec-2",
      idempotencyKey: "k2",
    });
    expect(successor.supersedes).toBe(predecessor.id);
    expect(successor.status).toBe("active");
    // NO state carry: a FRESH identity (only lineage recorded; the frozen
    // clock makes the TTL windows equal — the fresh-identity + lineage
    // facts are the carry-forward proof)
    expect(successor.id).not.toBe(predecessor.id);
    // the predecessor is reset and names its successor
    const after = await service.get(SCOPE.applicationId, predecessor.id);
    expect(after?.status).toBe("reset");
    expect(after?.supersededBy).toBe(successor.id);
    // RE-CONFIRMING the reset is a no-op success returning the SAME successor
    const again = await service.reset({
      ...ACTOR,
      identityId: predecessor.id,
      executionId: "exec-3",
      idempotencyKey: "k3",
    });
    expect(again.id).toBe(successor.id);
    // and no second successor exists
    const all = await service.list(SCOPE.applicationId);
    expect(all.filter((r) => r.supersedes === predecessor.id).length).toBe(1);
  });

  test("a cross-scope read returns null (the scope-checked boundary)", async () => {
    const { service } = build();
    const record = await service.establish({ ...ACTOR, executionId: "e", idempotencyKey: "k" });
    const other = await service.get("app-OTHER", record.id);
    expect(other).toBeNull();
  });

  test("the policy artifact is versioned, digest-carrying and frozen (AC5)", () => {
    expect(SYNTHETIC_DATA_POLICY.version).toBe("1");
    expect(SYNTHETIC_DATA_POLICY.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(SYNTHETIC_DATA_POLICY.permittedClasses).toContain("synthetic-text");
    expect(SYNTHETIC_DATA_POLICY.prohibitedClasses).toContain("real-pii");
    expect(Object.isFrozen(SYNTHETIC_DATA_POLICY)).toBe(true);
  });
});
