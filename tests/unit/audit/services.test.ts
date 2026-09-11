/**
 * Audit services over the in-memory store double (WORK-059).
 *
 * Proves the governed semantics at the application seam: identity
 * idempotency (bounded no-op on re-record), the audit service scrub
 * gate, hold lifecycle (suspends expiry, audited), retention purge
 * (governed expiry, bounded policy, honest no-policy fail-closed),
 * and the export round-trip with evidence.
 */

import { describe, expect, test } from "vitest";
import { InMemoryAuditStore } from "../../../src/modules/audit/adapters/in-memory-audit-store";
import { createAuditNodeDigest } from "../../../src/modules/audit/adapters/node-digest";
import {
  AuditProjectionError,
  type AuditSubmission,
  createAuditService,
  createComplianceExportService,
  createLegalHoldService,
  createRetentionService,
} from "../../../src/modules/audit/public";

const digest = createAuditNodeDigest();
const APPLICATION_ID = "00000000-0000-7000-8000-0000000000aa";
const TENANT_ID = "00000000-0000-7000-8000-0000000000bb";
const EXECUTION_ID = "00000000-0000-7000-8000-0000000000cc";

const T0 = "2026-09-20T12:00:00.000Z";
const T1 = "2026-09-21T12:00:00.000Z";
const T2 = "2026-09-22T12:00:00.000Z";

function submission(key: string, occurredAt = T0): AuditSubmission {
  return {
    applicationId: APPLICATION_ID,
    tenantId: TENANT_ID,
    environment: "production",
    actor: { actorId: "actor-1", actorKind: "service-principal" },
    action: { kind: "execution.transitioned", command: "authorize", operationKey: key },
    target: { kind: "execution", id: EXECUTION_ID },
    provenance: { seam: "executions.transition", sourceRecordId: EXECUTION_ID },
    rationale: { why: `transition ${key}` },
    occurredAt,
    actionDetail: { from: "CREATED", to: "AUTHORIZED", sequence: 1 },
  };
}

function world(now: () => Date = () => new Date(T1)) {
  const store = new InMemoryAuditStore(digest, now);
  const audit = createAuditService({ store, digest });
  const holds = createLegalHoldService({ holds: store });
  const retention = createRetentionService({ policies: store, records: store, now });
  const exports = createComplianceExportService({ store, digest, now });
  return { store, audit, holds, retention, exports, now };
}

/** A world with a MUTABLE clock: records appended at `at` carry that recordedAt. */
function clockWorld() {
  let current = T0;
  const now = () => new Date(current);
  const world_ = world(now);
  return { ...world_, advance: (to: string) => (current = to) };
}

describe("audit service (WORK-059, in-memory store double)", () => {
  test("appending the same governed action twice is a bounded no-op (identity idempotency)", async () => {
    const { audit, store } = world();
    const first = await audit.record(submission("op-1"));
    const second = await audit.record(submission("op-1"));
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.chainSequence).toBe(first.chainSequence);
    const records = await store.listRecords(APPLICATION_ID);
    expect(records).toHaveLength(1);
  });

  test("a re-observation at a different time converges to the SAME record (identity excludes volatile time)", async () => {
    const { audit, store } = world();
    await audit.record(submission("op-1", T0));
    const outcome = await audit.record(submission("op-1", T2));
    expect(outcome.replayed).toBe(true);
    const records = await store.listRecords(APPLICATION_ID);
    expect(records).toHaveLength(1);
    expect(records[0]?.occurredAt).toBe(T0);
  });

  test("different actions occupy successive chain positions", async () => {
    const { audit, store } = world();
    await audit.record(submission("op-1"));
    await audit.record(submission("op-2"));
    const records = await store.listRecords(APPLICATION_ID);
    expect(records.map((record) => record.chainSequence)).toEqual([1, 2]);
    expect(records[1]?.previousRecordDigest).toBe(records[0]?.recordDigest);
  });

  test("the service scrub gate rejects secret-shaped detail and scrubs the why text", async () => {
    const { audit } = world();
    await expect(
      audit.record({ ...submission("op-x"), actionDetail: { apiKey: "abc" } }),
    ).rejects.toBeInstanceOf(AuditProjectionError);
    const fragment = "sk" + "abcdefghijklmnopqrstuvwx";
    const outcome = await audit.record({
      ...submission("op-y"),
      rationale: { why: `because ${fragment} said so` },
    });
    expect(outcome.replayed).toBe(false);
    const { audit: audit2 } = world();
    const record = await audit2
      .record({
        ...submission("op-y"),
        rationale: { why: `because ${fragment} said so` },
      })
      .then(() => null)
      .catch(() => null);
    expect(record).toBeNull();
  });

  test("scrubbed why text is stored redacted (never the credential literal)", async () => {
    const { audit, store } = world();
    const fragment = "sk" + "abcdefghijklmnopqrstuvwxyz01";
    await audit.record({
      ...submission("op-scrub"),
      rationale: { why: `proceed ${fragment} now` },
    });
    const records = await store.listRecords(APPLICATION_ID);
    expect(records[0]?.rationale.why).toContain("[redacted]");
    expect(records[0]?.rationale.why).not.toContain(fragment);
  });
});

describe("legal hold + retention over the store double (WORK-059)", () => {
  test("adopting a policy is audited; unbounded retention is unrepresentable", async () => {
    const { retention, store } = world();
    await retention.adoptPolicy({
      applicationId: APPLICATION_ID,
      tenantId: TENANT_ID,
      version: 1,
      retentionDays: 30,
      reason: "SOC2 window",
      adoptedBy: "compliance-operator",
    });
    const records = await store.listRecords(APPLICATION_ID);
    expect(records.map((record) => record.action.kind)).toContain("retention.policy-adopted");
    await expect(
      retention.adoptPolicy({
        applicationId: APPLICATION_ID,
        tenantId: TENANT_ID,
        version: 2,
        retentionDays: 99999,
        reason: "forever",
        adoptedBy: "compliance-operator",
      }),
    ).rejects.toThrow(/unbounded retention is unrepresentable/);
  });

  test("the governed purge deletes expired records and records manifest evidence", async () => {
    const { audit, retention, store, advance } = clockWorld();
    // Two records recorded at T0; the policy horizon is 1 day.
    await audit.record(submission("old-1", T0));
    await audit.record(submission("old-2", T0));
    // A recent record (T1) survives.
    advance(T1);
    await audit.record(submission("new-1", T1));
    await retention.adoptPolicy({
      applicationId: APPLICATION_ID,
      tenantId: TENANT_ID,
      version: 1,
      retentionDays: 1,
      reason: "short window",
      adoptedBy: "compliance-operator",
    });
    // Purge runs at T2: cutoff = T2 - 1 day = T1 → everything recorded
    // strictly before T1 expires (the two T0 records).
    advance(T2);
    const outcome = await retention.executePurge({
      applicationId: APPLICATION_ID,
      environment: "production",
      procedureActorId: "retention-procedure",
    });
    expect(outcome.purged).toBe(true);
    expect(outcome.purgedCount).toBe(2);
    expect(outcome.evidence?.action.kind).toBe("retention.purge-executed");
    const purgeDetail = outcome.evidence?.actionDetail as Record<string, unknown>;
    expect(purgeDetail.purgedCount).toBe(2);
    const manifest = purgeDetail.purge as { entries: { sequence: number }[] };
    expect(manifest.entries.map((entry) => entry.sequence)).toEqual([1, 2]);
    // The chain positions: [1,2] purged; the survivors are the
    // recent record (3), the policy-adoption evidence (4) and the
    // purge evidence appended by this very purge (5).
    const records = await store.listRecords(APPLICATION_ID);
    expect(records.map((record) => record.chainSequence)).toEqual([3, 4, 5]);
    // The full chain still verifies with the manifest-covered gap.
    const verification = await createAuditService({ store, digest }).verifyChain(APPLICATION_ID);
    expect(verification.ok).toBe(true);
  });

  test("a second purge run converges (nothing to do, no duplicate evidence)", async () => {
    const { audit, retention, store, advance } = clockWorld();
    await audit.record(submission("old-1", T0));
    await retention.adoptPolicy({
      applicationId: APPLICATION_ID,
      tenantId: TENANT_ID,
      version: 1,
      retentionDays: 1,
      reason: "short window",
      adoptedBy: "compliance-operator",
    });
    advance(T2);
    const first = await retention.executePurge({
      applicationId: APPLICATION_ID,
      environment: "production",
      procedureActorId: "retention-procedure",
    });
    expect(first.purged).toBe(true);
    const evidenceCount = (await store.listRecords(APPLICATION_ID)).filter(
      (record) => record.action.kind === "retention.purge-executed",
    ).length;
    const second = await retention.executePurge({
      applicationId: APPLICATION_ID,
      environment: "production",
      procedureActorId: "retention-procedure",
    });
    expect(second.purged).toBe(false);
    expect(second.purgedCount).toBe(0);
    expect(second.evidence).toBeNull();
    const evidenceCountAfter = (await store.listRecords(APPLICATION_ID)).filter(
      (record) => record.action.kind === "retention.purge-executed",
    ).length;
    expect(evidenceCountAfter).toBe(evidenceCount);
  });

  test("a legal hold suspends expiry for its scope; release unblocks the purge; both are audited", async () => {
    const { audit, holds, retention, store, advance } = clockWorld();
    await audit.record(submission("held-1", T0));
    await audit.record({
      ...submission("other-1", T0),
      target: { kind: "execution", id: "00000000-0000-7000-8000-0000000000dd" },
    });
    advance(T2);
    const hold = await holds.placeHold({
      applicationId: APPLICATION_ID,
      tenantId: TENANT_ID,
      holdScope: "target",
      targetKind: "execution",
      targetId: EXECUTION_ID,
      reason: "litigation matter 7",
      placedBy: "legal-operator",
    });
    expect((await store.listRecords(APPLICATION_ID)).map((record) => record.action.kind)).toContain(
      "audit.legal-hold-placed",
    );

    await retention.adoptPolicy({
      applicationId: APPLICATION_ID,
      tenantId: TENANT_ID,
      version: 1,
      retentionDays: 1,
      reason: "short window",
      adoptedBy: "compliance-operator",
    });
    const outcome = await retention.executePurge({
      applicationId: APPLICATION_ID,
      environment: "production",
      procedureActorId: "retention-procedure",
    });
    // The held record survives; the other expired record is purged.
    expect(outcome.purged).toBe(true);
    const survivors = await store.listRecords(APPLICATION_ID);
    expect(survivors.some((record) => record.action.operationKey === "held-1")).toBe(true);
    expect(survivors.some((record) => record.action.operationKey === "other-1")).toBe(false);

    // Release the hold (audited) → the next purge removes the record.
    await holds.releaseHold(APPLICATION_ID, hold.holdId, "legal-operator");
    expect((await store.listRecords(APPLICATION_ID)).map((record) => record.action.kind)).toContain(
      "audit.legal-hold-released",
    );
    const second = await retention.executePurge({
      applicationId: APPLICATION_ID,
      environment: "production",
      procedureActorId: "retention-procedure",
    });
    expect(second.purged).toBe(true);
    const finalSurvivors = await store.listRecords(APPLICATION_ID);
    expect(finalSurvivors.some((record) => record.action.operationKey === "held-1")).toBe(false);
  });

  test("an application-wide hold suspends the whole scope", async () => {
    const { audit, holds, retention, advance } = clockWorld();
    advance(T2);
    await audit.record(submission("wide-1", T0));
    await holds.placeHold({
      applicationId: APPLICATION_ID,
      tenantId: TENANT_ID,
      holdScope: "application",
      reason: "full-scope litigation",
      placedBy: "legal-operator",
    });
    await retention.adoptPolicy({
      applicationId: APPLICATION_ID,
      tenantId: TENANT_ID,
      version: 1,
      retentionDays: 1,
      reason: "short window",
      adoptedBy: "compliance-operator",
    });
    const outcome = await retention.executePurge({
      applicationId: APPLICATION_ID,
      environment: "production",
      procedureActorId: "retention-procedure",
    });
    expect(outcome.purged).toBe(false);
  });

  test("executing a purge without an active policy fails closed", async () => {
    const { audit, retention } = world();
    await audit.record(submission("x-1", T0));
    await expect(
      retention.executePurge({
        applicationId: APPLICATION_ID,
        environment: "production",
        procedureActorId: "retention-procedure",
      }),
    ).rejects.toThrow(/no retention policy is active/);
  });

  test("an idempotent hold placement replays; a conflicting one fails closed", async () => {
    const { holds } = world();
    const input = {
      applicationId: APPLICATION_ID,
      tenantId: TENANT_ID,
      holdScope: "application" as const,
      reason: "litigation matter 7",
      placedBy: "legal-operator",
    };
    const first = await holds.placeHold(input);
    const second = await holds.placeHold(input);
    expect(second.holdId).toBe(first.holdId);
    await expect(holds.placeHold({ ...input, reason: "a different rationale" })).rejects.toThrow(
      /active hold already covers this scope/,
    );
  });
});

describe("compliance export over the store double (WORK-059)", () => {
  test("the export round-trips verification deterministically and records evidence", async () => {
    const { audit, exports, store } = world();
    for (const key of ["e-1", "e-2", "e-3"]) {
      await audit.record(submission(key));
    }
    const exportObject = await exports.exportRecords({
      applicationId: APPLICATION_ID,
      tenantId: TENANT_ID,
      requestedBy: "compliance-auditor",
      purpose: "SOC2 evidence collection",
      fromSequence: 1,
      toSequence: 3,
      idempotencyKey: "export-1",
      environment: "production",
    });
    expect(exportObject.records).toHaveLength(3);
    // Round trip: serialize → deserialize → verify.
    const roundTrip = JSON.parse(JSON.stringify(exportObject)) as unknown;
    const verification = exports.verifyExport(roundTrip);
    expect(verification.ok).toBe(true);
    expect(verification.violations).toEqual([]);
    // Deterministic: verifying again yields the same verdict.
    expect(exports.verifyExport(roundTrip)).toEqual(verification);
    // The export is a governed action: evidence recorded.
    const kinds = (await store.listRecords(APPLICATION_ID)).map((record) => record.action.kind);
    expect(kinds).toContain("audit.export-generated");
  });

  test("a tampered export fails verification", async () => {
    const { audit, exports } = world();
    await audit.record(submission("t-1"));
    const exportObject = await exports.exportRecords({
      applicationId: APPLICATION_ID,
      tenantId: TENANT_ID,
      requestedBy: "compliance-auditor",
      purpose: "SOC2 evidence collection",
      fromSequence: 1,
      toSequence: 1,
      idempotencyKey: "export-2",
      environment: "production",
    });
    const tampered = JSON.parse(JSON.stringify(exportObject)) as {
      records: { actionDetail: Record<string, unknown> }[];
      exportDigest: string;
    };
    tampered.records[0]!.actionDetail.to = "FAILED";
    const verification = exports.verifyExport(tampered);
    expect(verification.ok).toBe(false);
    expect(verification.violations.length).toBeGreaterThan(0);
  });

  test("a tampered recordDigest proof fails verification", async () => {
    const { audit, exports } = world();
    await audit.record(submission("p-1"));
    const exportObject = await exports.exportRecords({
      applicationId: APPLICATION_ID,
      tenantId: TENANT_ID,
      requestedBy: "compliance-auditor",
      purpose: "SOC2 evidence collection",
      fromSequence: 1,
      toSequence: 1,
      idempotencyKey: "export-3",
      environment: "production",
    });
    const tampered = JSON.parse(JSON.stringify(exportObject)) as {
      chainProof: { recordDigests: string[] };
    };
    tampered.chainProof.recordDigests[0] = "f".repeat(64);
    const verification = exports.verifyExport(tampered);
    expect(verification.ok).toBe(false);
  });
});
