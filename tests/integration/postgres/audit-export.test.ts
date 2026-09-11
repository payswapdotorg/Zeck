/**
 * Real-PostgreSQL compliance export tests (WORK-059 / SEC-004).
 *
 * Proves over the real database:
 *
 *  - the governed export: bounded window read, chain proof, purge
 *    manifests, evidence record appended (the export is itself a
 *    governed action);
 *  - round-trip verification is deterministic (serialize →
 *    deserialize → verify; repeated verification, same verdict);
 *  - a TAMPERED export (mutated record content, forged proof digests,
 *    forged export digest) fails verification (mutation test);
 *  - an export window beyond the bounded export size fails closed;
 *  - an idempotent export retry (same key/purpose/window) converges
 *    to the bounded no-op on the evidence record.
 */

import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { createAuditNodeDigest } from "../../../src/modules/audit/adapters/node-digest";
import type { AuditSubmission } from "../../../src/modules/audit/public";
import { createComplianceExportService } from "../../../src/modules/audit/public";
import { seedAuditWorld } from "./audit-world";
import { definePgSuite } from "./harness";

/** An export service over a substitute store port (fault injection). */
function createComplianceExportServiceOver(
  store: Parameters<typeof createComplianceExportService>[0]["store"],
  world: Awaited<ReturnType<typeof seedAuditWorld>>,
) {
  return createComplianceExportService({
    store,
    digest: createAuditNodeDigest(),
    now: world.now,
  });
}

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
    occurredAt: "2026-09-20T12:00:00.000Z",
    actionDetail: { from: "CREATED", to: "AUTHORIZED", sequence: 1 },
  };
}

definePgSuite("compliance export (real PostgreSQL)", (ctx) => {
  test("the governed export round-trips deterministic verification and records evidence", async () => {
    const world = await seedAuditWorld(ctx.port);
    for (let index = 1; index <= 4; index += 1) {
      await world.audit.record(submission(world, `exp-${index}`));
    }
    const exportObject = await world.exports.exportRecords({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      requestedBy: "compliance-auditor",
      purpose: "SOC2 quarterly evidence collection",
      fromSequence: 1,
      toSequence: 4,
      idempotencyKey: "export-op-1",
      environment: "production",
    });
    expect(exportObject.records).toHaveLength(4);
    expect(exportObject.chainProof.recordDigests).toHaveLength(4);
    // The head is attested at snapshot time (before the evidence
    // append extends the chain).
    expect(exportObject.chainProof.headSequenceAtGeneration).toBe(4);
    expect(exportObject.chainProof.headDigestAtGeneration).not.toBeNull();
    expect(exportObject.chainProof.headDigestAtGeneration).toBe(
      exportObject.records[3]?.recordDigest,
    );

    const roundTrip = JSON.parse(JSON.stringify(exportObject)) as unknown;
    const verification = world.exports.verifyExport(roundTrip);
    expect(verification.ok).toBe(true);
    expect(verification.violations).toEqual([]);
    // Deterministic verification.
    expect(world.exports.verifyExport(roundTrip)).toEqual(verification);

    // The export evidence: the 5th chain record.
    const records = await world.store.listRecords(world.applicationId);
    expect(records.map((record) => record.action.kind)).toContain("audit.export-generated");
    const evidence = records[4]!;
    expect(evidence.action.command).toBe("compliance-export");
    expect(evidence.rationale.why).toBe("SOC2 quarterly evidence collection");
    expect(evidence.actionDetail).toEqual({
      fromSequence: 1,
      toSequence: 4,
      exportId: exportObject.exportId,
    });
  });

  test("a failed evidence append fails closed; the retry converges to ONE evidence record", async () => {
    const world = await seedAuditWorld(ctx.port);
    await world.audit.record(submission(world, "retry-1"));
    const request = {
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      requestedBy: "compliance-auditor",
      purpose: "annual audit",
      fromSequence: 1,
      toSequence: 1,
      idempotencyKey: "export-retry-1",
      environment: "production",
    };
    // Inject a one-shot failure on the evidence append (the export
    // object was built; the evidence write fails → fail closed).
    let failures = 0;
    const failingStore = {
      appendRecord: (submission: { action: { kind: string } }) => {
        if (failures === 0 && submission.action.kind === "audit.export-generated") {
          failures += 1;
          return Promise.reject(new Error("evidence write failed"));
        }
        return world.store.appendRecord(submission as never);
      },
      getRecord: (applicationId: string, recordId: string) =>
        world.store.getRecord(applicationId, recordId),
      listRecords: (applicationId: string, options?: { fromSequence?: number }) =>
        world.store.listRecords(applicationId, options),
      chainHead: (applicationId: string) => world.store.chainHead(applicationId),
      purgeExpiredRecords: (input: unknown) => world.store.purgeExpiredRecords(input as never),
      listPurgeManifests: (
        applicationId: string,
        window: { fromSequence: number; toSequence: number },
      ) => world.store.listPurgeManifests(applicationId, window),
    };
    const failingExports = createComplianceExportServiceOver(failingStore, world);
    await expect(failingExports.exportRecords(request)).rejects.toThrow(
      /failed to record the export evidence/,
    );
    // The retry through the healthy fabric converges: exactly ONE
    // evidence record; the export verifies.
    const exportObject = await world.exports.exportRecords(request);
    const evidence = (await world.store.listRecords(world.applicationId)).filter(
      (record) => record.action.kind === "audit.export-generated",
    );
    expect(evidence).toHaveLength(1);
    expect(world.exports.verifyExport(exportObject).ok).toBe(true);
  });

  test("a RE-EXECUTION after a successful export records new evidence (the export content legitimately differs)", async () => {
    const world = await seedAuditWorld(ctx.port);
    await world.audit.record(submission(world, "reexec-1"));
    const request = {
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      requestedBy: "compliance-auditor",
      purpose: "annual audit",
      fromSequence: 1,
      toSequence: 1,
      idempotencyKey: "export-reexec-1",
      environment: "production",
    };
    const first = await world.exports.exportRecords(request);
    // A record appended between the executions moves the chain: the
    // second export attests a different head — HONEST re-execution
    // evidence (a different governed snapshot), not a duplicate of
    // the same content.
    await world.audit.record(submission(world, "reexec-2"));
    const second = await world.exports.exportRecords(request);
    const evidence = (await world.store.listRecords(world.applicationId)).filter(
      (record) => record.action.kind === "audit.export-generated",
    );
    expect(evidence).toHaveLength(2);
    expect(first.exportId).not.toBe(second.exportId);
    expect(world.exports.verifyExport(first).ok).toBe(true);
    expect(world.exports.verifyExport(second).ok).toBe(true);
  });

  test("a window larger than the bounded export size fails closed", async () => {
    const world = await seedAuditWorld(ctx.port);
    await expect(
      world.exports.exportRecords({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        requestedBy: "compliance-auditor",
        purpose: "oversize",
        fromSequence: 1,
        toSequence: 250,
        idempotencyKey: "export-oversize",
        environment: "production",
      }),
    ).rejects.toThrow(/exceeds the bounded export size/);
  });

  test("a malformed request fails closed (bounds and shape)", async () => {
    const world = await seedAuditWorld(ctx.port);
    await expect(
      world.exports.exportRecords({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        requestedBy: "compliance-auditor",
        purpose: "",
        fromSequence: 1,
        toSequence: 1,
        idempotencyKey: "export-bad-1",
        environment: "production",
      }),
    ).rejects.toThrow(/purpose must be bounded/);
    await expect(
      world.exports.exportRecords({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        requestedBy: "compliance-auditor",
        purpose: "valid",
        fromSequence: 5,
        toSequence: 1,
        idempotencyKey: "export-bad-2",
        environment: "production",
      }),
    ).rejects.toThrow(/window/);
  });

  test("TAMPERED exports fail verification (record content, proof, digest)", async () => {
    const world = await seedAuditWorld(ctx.port);
    for (let index = 1; index <= 2; index += 1) {
      await world.audit.record(submission(world, `tamper-${index}`));
    }
    const exportObject = await world.exports.exportRecords({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      requestedBy: "compliance-auditor",
      purpose: "tamper probe",
      fromSequence: 1,
      toSequence: 2,
      idempotencyKey: "export-tamper",
      environment: "production",
    });

    // 1. Mutated record content (the record's own digests break).
    const mutatedRecord = JSON.parse(JSON.stringify(exportObject)) as {
      records: { actionDetail: Record<string, unknown> }[];
    };
    mutatedRecord.records[0]!.actionDetail.to = "FAILED";
    expect(world.exports.verifyExport(mutatedRecord).ok).toBe(false);

    // 2. Forged chain-proof digests.
    const forgedProof = JSON.parse(JSON.stringify(exportObject)) as {
      chainProof: { recordDigests: string[] };
    };
    forgedProof.chainProof.recordDigests[0] = "f".repeat(64);
    expect(world.exports.verifyExport(forgedProof).ok).toBe(false);

    // 3. Forged export digest (content/digest mismatch).
    const forgedDigest = JSON.parse(JSON.stringify(exportObject)) as { exportDigest: string };
    forgedDigest.exportDigest = "e".repeat(64);
    const mismatch = world.exports.verifyExport(forgedDigest);
    expect(mismatch.ok).toBe(false);
    expect(
      mismatch.violations.some((violation) => violation.code === "export-identity-mismatch"),
    ).toBe(true);

    // 4. Swapped purpose (content changed under the claimed identity).
    const rewritten = JSON.parse(JSON.stringify(exportObject)) as { purpose: string };
    rewritten.purpose = "a different purpose";
    expect(world.exports.verifyExport(rewritten).ok).toBe(false);
  });

  test("a purged window exports with the manifest and verifies (compliance retention of evidence)", async () => {
    const world = await seedAuditWorld(ctx.port);
    for (let index = 1; index <= 3; index += 1) {
      await world.audit.record(submission(world, `purged-${index}`));
    }
    await world.retention.adoptPolicy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      version: 1,
      retentionDays: 1,
      reason: "short window",
      adoptedBy: "compliance-operator",
    });
    world.advanceTo("2026-09-22T12:00:00.000Z");
    await world.retention.executePurge({
      applicationId: world.applicationId,
      environment: "production",
      procedureActorId: "retention-procedure",
    });
    // The records are purged from the AUTHORITY, but an export was
    // never taken of them: the honest boundary is that the export
    // covers what remains + the manifest of what was purged.
    const exportObject = await world.exports.exportRecords({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      requestedBy: "compliance-auditor",
      purpose: "post-purge evidence",
      fromSequence: 1,
      toSequence: 10,
      idempotencyKey: "export-post-purge",
      environment: "production",
    });
    expect(exportObject.purgeManifests).toHaveLength(1);
    const manifest = exportObject.purgeManifests[0]!;
    expect(manifest.entries.length).toBe(4); // three records + policy evidence
    const verification = world.exports.verifyExport(
      JSON.parse(JSON.stringify(exportObject)) as unknown,
    );
    expect(verification.ok).toBe(true);
    expect(verification.violations).toEqual([]);
  });
});
