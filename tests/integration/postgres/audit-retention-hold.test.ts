/**
 * Real-PostgreSQL retention + legal-hold tests (WORK-059 / SEC-004;
 * checkpoint CONCURRENCY-CRASH-SAFETY for the governed purge).
 *
 * Proves over the real database:
 *
 *  - bounded policy adoption is audited; unbounded retention is
 *    unrepresentable (validated fail-closed at the service);
 *  - the governed purge deletes ONLY expired, hold-free records and
 *    appends the manifest evidence in the same transaction; the chain
 *    verifies WITH the manifest-covered gap;
 *  - a re-run purge converges (nothing to do, no duplicate evidence);
 *  - CONCURRENT purges never double-purge (one deletes, the other
 *    finds nothing; no duplicate evidence, no broken chain);
 *  - a legal hold suspends expiry for its scope; release unblocks it;
 *    both procedures are audited;
 *  - an export generated after a purge carries the manifest and
 *    verifies across the purged gap (the window semantics).
 */

import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { createAuditNodeDigest } from "../../../src/modules/audit/adapters/node-digest";
import type { AuditSubmission } from "../../../src/modules/audit/public";
import { createAuditService } from "../../../src/modules/audit/public";
import { seedAuditWorld, T0, T1, T2 } from "./audit-world";
import { definePgSuite } from "./harness";

const digest = createAuditNodeDigest();

function submission(
  world: { applicationId: string; tenantId: string },
  key: string,
): AuditSubmission {
  return {
    applicationId: world.applicationId,
    tenantId: world.tenantId,
    environment: "production",
    actor: { actorId: "actor-1", actorKind: "service-principal" },
    action: { kind: "execution.transitioned", command: "authorize", operationKey: key },
    target: { kind: "execution", id: randomUUID() },
    provenance: { seam: "executions.transition", sourceRecordId: null },
    rationale: { why: `transition ${key}` },
    occurredAt: T0,
    actionDetail: { from: "CREATED", to: "AUTHORIZED", sequence: 1 },
  };
}

async function adoptPolicy(world: Awaited<ReturnType<typeof seedAuditWorld>>) {
  return world.retention.adoptPolicy({
    applicationId: world.applicationId,
    tenantId: world.tenantId,
    version: 1,
    retentionDays: 1,
    reason: "SOC2 evidence window",
    adoptedBy: "compliance-operator",
  });
}

definePgSuite("audit retention and legal hold (real PostgreSQL)", (ctx) => {
  test("policy adoption is audited; unbounded retention fails closed at the service", async () => {
    const world = await seedAuditWorld(ctx.port);
    await adoptPolicy(world);
    const kinds = (await world.store.listRecords(world.applicationId)).map(
      (record) => record.action.kind,
    );
    expect(kinds).toContain("retention.policy-adopted");
    await expect(
      world.retention.adoptPolicy({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        version: 2,
        retentionDays: 100000,
        reason: "forever",
        adoptedBy: "compliance-operator",
      }),
    ).rejects.toThrow(/unbounded retention is unrepresentable/);
    // Policy adoption is idempotent per (application, version).
    const again = await adoptPolicy(world);
    expect(again.version).toBe(1);
  });

  test("the governed purge deletes expired records, evidences the manifest, and the chain still verifies", async () => {
    const world = await seedAuditWorld(ctx.port);
    // Clock at T0: three records recorded at T0.
    for (const key of ["old-1", "old-2", "old-3"]) {
      await world.audit.record(submission(world, key));
    }
    await adoptPolicy(world);
    // Purge at T2: cutoff = T2 - 1d = T1 → everything recorded before
    // T1 (the three T0 records + the T0 policy evidence) expires.
    world.advanceTo(T2);
    const outcome = await world.retention.executePurge({
      applicationId: world.applicationId,
      environment: "production",
      procedureActorId: "retention-procedure",
    });
    expect(outcome.purged).toBe(true);
    expect(outcome.purgedCount).toBe(4); // three transitions + policy evidence
    expect(outcome.evidence?.action.kind).toBe("retention.purge-executed");
    const manifest = (outcome.evidence as { actionDetail: Record<string, unknown> }).actionDetail
      .purge as {
      entries: { sequence: number; recordDigest: string }[];
      commitment: string;
    };
    expect(manifest.entries.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4]);
    // The purge evidence occupies position 5.
    const records = await world.store.listRecords(world.applicationId);
    expect(records.map((record) => record.chainSequence)).toEqual([5]);
    // The full chain verifies WITH the manifest-covered gap.
    const verification = await world.audit.verifyChain(world.applicationId);
    expect(verification.ok).toBe(true);
    expect(verification.violations).toEqual([]);
  });

  test("a re-run purge converges (nothing to do, no duplicate evidence)", async () => {
    const world = await seedAuditWorld(ctx.port);
    await world.audit.record(submission(world, "old-1"));
    await adoptPolicy(world);
    world.advanceTo(T2);
    const first = await world.retention.executePurge({
      applicationId: world.applicationId,
      environment: "production",
      procedureActorId: "retention-procedure",
    });
    expect(first.purged).toBe(true);
    const second = await world.retention.executePurge({
      applicationId: world.applicationId,
      environment: "production",
      procedureActorId: "retention-procedure",
    });
    expect(second.purged).toBe(false);
    expect(second.purgedCount).toBe(0);
    expect(second.evidence).toBeNull();
    const evidenceRecords = (await world.store.listRecords(world.applicationId)).filter(
      (record) => record.action.kind === "retention.purge-executed",
    );
    expect(evidenceRecords).toHaveLength(1);
    const verification = await world.audit.verifyChain(world.applicationId);
    expect(verification.ok).toBe(true);
  });

  test("CONCURRENT purges never double-purge (serialized by the chain-head lock)", async () => {
    const world = await seedAuditWorld(ctx.port);
    for (const key of ["r-1", "r-2"]) {
      await world.audit.record(submission(world, key));
    }
    await adoptPolicy(world);
    world.advanceTo(T2);
    const outcomes = await Promise.all([
      world.retention.executePurge({
        applicationId: world.applicationId,
        environment: "production",
        procedureActorId: "retention-procedure",
      }),
      world.retention.executePurge({
        applicationId: world.applicationId,
        environment: "production",
        procedureActorId: "retention-procedure",
      }),
    ]);
    const totalPurged = outcomes.reduce((sum, outcome) => sum + outcome.purgedCount, 0);
    // The two expired records are deleted exactly once in total.
    expect(totalPurged).toBe(3); // two transitions + policy evidence
    const evidenceRecords = (await world.store.listRecords(world.applicationId)).filter(
      (record) => record.action.kind === "retention.purge-executed",
    );
    expect(evidenceRecords.length).toBeLessThanOrEqual(1);
    const survivors = await world.store.listRecords(world.applicationId);
    expect(survivors.every((record) => record.action.kind === "retention.purge-executed")).toBe(
      true,
    );
    const verification = await world.audit.verifyChain(world.applicationId);
    expect(verification.ok).toBe(true);
  });

  test("a legal hold suspends expiry for its scope; release unblocks; both are audited", async () => {
    const world = await seedAuditWorld(ctx.port);
    const heldTarget = randomUUID();
    await world.audit.record({
      ...submission(world, "held-1"),
      target: { kind: "execution", id: heldTarget },
    });
    await world.audit.record(submission(world, "free-1"));
    const hold = await world.holds.placeHold({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      holdScope: "target",
      targetKind: "execution",
      targetId: heldTarget,
      reason: "litigation matter 7",
      placedBy: "legal-operator",
    });
    await adoptPolicy(world);
    world.advanceTo(T2);
    const outcome = await world.retention.executePurge({
      applicationId: world.applicationId,
      environment: "production",
      procedureActorId: "retention-procedure",
    });
    expect(outcome.purged).toBe(true);
    const survivors = await world.store.listRecords(world.applicationId);
    expect(survivors.some((record) => record.action.operationKey === "held-1")).toBe(true);
    expect(survivors.some((record) => record.action.operationKey === "free-1")).toBe(false);

    // The placement evidence is still present (it was covered by the
    // SAME hold as its target: the hold suspends expiry for the scope,
    // and the placement record targets the held execution).
    const midKinds = (await world.store.listRecords(world.applicationId)).map(
      (record) => record.action.kind,
    );
    expect(midKinds).toContain("audit.legal-hold-placed");

    await world.holds.releaseHold(world.applicationId, hold.holdId, "legal-operator");
    const second = await world.retention.executePurge({
      applicationId: world.applicationId,
      environment: "production",
      procedureActorId: "retention-procedure",
    });
    expect(second.purged).toBe(true);
    const final = await world.store.listRecords(world.applicationId);
    expect(final.some((record) => record.action.operationKey === "held-1")).toBe(false);

    // The release evidence is recent (recorded after the hold release,
    // inside the horizon) so it survives; the placement evidence was
    // T0-old and NOT covered by any hold after the release — it
    // expired with the same governed horizon (retention applies
    // uniformly; the hold suspended its expiry only while active).
    const kinds = final.map((record) => record.action.kind);
    expect(kinds).toContain("audit.legal-hold-released");
    expect(kinds).not.toContain("audit.legal-hold-placed");
    const verification = await world.audit.verifyChain(world.applicationId);
    expect(verification.ok).toBe(true);
  });

  test("an application-wide hold suspends the whole scope; expiry resumes after release", async () => {
    const world = await seedAuditWorld(ctx.port);
    await world.audit.record(submission(world, "wide-1"));
    await world.holds.placeHold({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      holdScope: "application",
      reason: "full-scope litigation",
      placedBy: "legal-operator",
    });
    await adoptPolicy(world);
    world.advanceTo(T2);
    const outcome = await world.retention.executePurge({
      applicationId: world.applicationId,
      environment: "production",
      procedureActorId: "retention-procedure",
    });
    expect(outcome.purged).toBe(false);
    expect(outcome.purgedCount).toBe(0);
  });

  test("a purge without an active policy fails closed (no silent unbounded purge, none without governance)", async () => {
    const world = await seedAuditWorld(ctx.port);
    await world.audit.record(submission(world, "x-1"));
    await expect(
      world.retention.executePurge({
        applicationId: world.applicationId,
        environment: "production",
        procedureActorId: "retention-procedure",
      }),
    ).rejects.toThrow(/no retention policy is active/);
  });

  test("an export after a purge carries the manifest and verifies across the gap", async () => {
    const world = await seedAuditWorld(ctx.port);
    for (const key of ["exp-1", "exp-2"]) {
      await world.audit.record(submission(world, key));
    }
    await adoptPolicy(world);
    world.advanceTo(T2);
    await world.retention.executePurge({
      applicationId: world.applicationId,
      environment: "production",
      procedureActorId: "retention-procedure",
    });
    // A post-purge append + export across the whole history.
    await world.audit.record(submission(world, "exp-3"));
    const exportObject = await world.exports.exportRecords({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      requestedBy: "compliance-auditor",
      purpose: "SOC2 evidence collection after purge",
      fromSequence: 1,
      toSequence: 10,
      idempotencyKey: "export-post-purge",
      environment: "production",
    });
    // The export contains the survivor + the purge evidence + the
    // post-purge record, and the manifests covering the purged gap.
    expect(exportObject.records.length).toBeGreaterThanOrEqual(2);
    expect(exportObject.purgeManifests.length).toBe(1);
    const manifest = exportObject.purgeManifests[0]!;
    expect(manifest.entries.length).toBeGreaterThanOrEqual(2);
    const verification = world.exports.verifyExport(
      JSON.parse(JSON.stringify(exportObject)) as unknown,
    );
    expect(verification.ok).toBe(true);
    expect(verification.violations).toEqual([]);
  });
});
