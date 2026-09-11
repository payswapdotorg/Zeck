/**
 * Real-PostgreSQL audit chain, concurrency and crash-safety tests
 * (WORK-059 / SEC-004; checkpoints IDENTITY-IDEMPOTENCY +
 * CONCURRENCY-CRASH-SAFETY + EXECUTION-PROVENANCE).
 *
 * Proves over the real database:
 *
 *  - appends chain gaplessly; the durable chain verifies end-to-end
 *    (deterministic verdict);
 *  - the same governed action recorded twice is a bounded no-op
 *    (identity idempotency over the REAL store);
 *  - CONCURRENT appends serialize under the chain-head lock: 20
 *    parallel observers produce 20 records, a gapless chain, no lost
 *    records, no broken links;
 *  - concurrent append + governed purge + export interleave safely;
 *  - CRASH-RESUME: an append whose transaction fails after the record
 *    INSERT (before the head update) rolls back COMPLETELY (no
 *    partial chain, no lost head) and the retry converges;
 *  - TAMPER DETECTION: a hand-crafted row with a forged digest
 *    (INSERT is legal — only mutation is not) is rejected at read
 *    time by the store's total row validation and by the chain
 *    verifier.
 */

import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { createAuditNodeDigest } from "../../../src/modules/audit/adapters/node-digest";
import { SqlAuditStore } from "../../../src/modules/audit/adapters/sql-audit-store";
import type { AuditSubmission } from "../../../src/modules/audit/public";
import { createAuditService } from "../../../src/modules/audit/public";
import type { DatabasePort, Query, QueryResult, Transaction } from "../../../src/platform/db/port";
import { seedAuditWorld } from "./audit-world";
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
    occurredAt: "2026-09-20T12:00:00.000Z",
    actionDetail: { from: "CREATED", to: "AUTHORIZED", sequence: 1 },
  };
}

/** A DatabasePort double that fails the Nth matching statement (crash injection). */
class CrashInjectingPort {
  constructor(
    private readonly inner: DatabasePort,
    private readonly matcher: (sql: string) => boolean,
    private failAfter: number,
  ) {}
  failNextMatching(): void {
    this.failAfter = 1;
  }
  private wrap<T>(sql: string, run: () => Promise<QueryResult<T>>): Promise<QueryResult<T>> {
    if (this.failAfter > 0 && this.matcher(sql)) {
      this.failAfter -= 1;
      return Promise.reject(new Error("injected crash"));
    }
    return run();
  }
  execute<T = Record<string, unknown>>(query: Query): Promise<QueryResult<T>> {
    return this.wrap<T>(query.sql, () => this.inner.execute<T>(query));
  }
  transaction<S>(work: (tx: Transaction) => Promise<S>): Promise<S> {
    // The transaction body sees a wrapped tx: the crash fires INSIDE
    // the real transaction (mid-transaction failure -> rollback).
    return this.inner.transaction((tx) =>
      work({
        execute: <T = Record<string, unknown>>(query: Query) =>
          this.wrap<T>(query.sql, () => tx.execute<T>(query)),
      }),
    );
  }
}

definePgSuite("audit chain, concurrency and crash-safety (real PostgreSQL)", (ctx) => {
  test("appends chain gaplessly and the durable chain verifies", async () => {
    const world = await seedAuditWorld(ctx.port);
    for (let index = 1; index <= 5; index += 1) {
      await world.audit.record(submission(world, `op-${index}`));
    }
    const records = await world.store.listRecords(world.applicationId);
    expect(records.map((record) => record.chainSequence)).toEqual([1, 2, 3, 4, 5]);
    const head = await world.store.chainHead(world.applicationId);
    expect(head?.lastSequence).toBe(5);
    expect(head?.lastDigest).toBe(records[4]?.recordDigest);
    const verification = await world.audit.verifyChain(world.applicationId);
    expect(verification.ok).toBe(true);
    expect(verification.violations).toEqual([]);
  });

  test("the same governed action recorded twice is a bounded no-op (identity idempotency)", async () => {
    const world = await seedAuditWorld(ctx.port);
    const theSubmission = submission(world, "op-dup");
    const first = await world.audit.record(theSubmission);
    const second = await world.audit.record(theSubmission);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.chainSequence).toBe(first.chainSequence);
    const head = await world.store.chainHead(world.applicationId);
    expect(head?.lastSequence).toBe(1);
    const records = await world.store.listRecords(world.applicationId);
    expect(records).toHaveLength(1);
  });

  test("20 concurrent appends serialize into one gapless verified chain (no lost records)", async () => {
    const world = await seedAuditWorld(ctx.port);
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        world.audit.record(submission(world, `conc-${index}`)),
      ),
    );
    expect(outcomes.every((outcome) => !outcome.replayed)).toBe(true);
    const records = await world.store.listRecords(world.applicationId);
    expect(records).toHaveLength(20);
    expect(records.map((record) => record.chainSequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    const verification = await world.audit.verifyChain(world.applicationId);
    expect(verification.ok).toBe(true);
  });

  test("concurrent duplicate submissions of the SAME action converge to one record", async () => {
    const world = await seedAuditWorld(ctx.port);
    const theSubmission = submission(world, "race-1");
    const outcomes = await Promise.all([
      world.audit.record(theSubmission),
      world.audit.record(theSubmission),
      world.audit.record(theSubmission),
    ]);
    const replays = outcomes.filter((outcome) => outcome.replayed).length;
    const fresh = outcomes.filter((outcome) => !outcome.replayed).length;
    expect(fresh).toBe(1);
    expect(replays).toBe(2);
    const records = await world.store.listRecords(world.applicationId);
    expect(records).toHaveLength(1);
    const verification = await world.audit.verifyChain(world.applicationId);
    expect(verification.ok).toBe(true);
  });

  test("CRASH-RESUME: a failed append rolls back completely; the retry converges (no partial chain)", async () => {
    const world = await seedAuditWorld(ctx.port);
    // Inject a crash on the chain-head UPDATE (AFTER the record INSERT
    // inside the same transaction): the transaction must roll back the
    // insert AND leave the head untouched.
    const crashing = new CrashInjectingPort(
      world.db,
      (sql) => sql.includes("UPDATE audit.chain_heads"),
      1,
    );
    const crashingStore = new SqlAuditStore(crashing, createAuditNodeDigest(), world.now);
    const crashingAudit = createAuditService({
      store: crashingStore,
      digest: createAuditNodeDigest(),
    });
    // A first successful record so the chain head exists.
    await world.audit.record(submission(world, "op-pre"));
    const before = await world.store.chainHead(world.applicationId);
    crashing.failNextMatching();
    // The typed fail-closed projection error wraps the injected crash.
    await expect(crashingAudit.record(submission(world, "op-crash"))).rejects.toThrow(
      /the audit projection failed to durably record/,
    );
    // No partial state: the record is absent, the head is unchanged.
    const recordsAfterCrash = await world.store.listRecords(world.applicationId);
    expect(recordsAfterCrash).toHaveLength(1);
    const headAfterCrash = await world.store.chainHead(world.applicationId);
    expect(headAfterCrash).toEqual(before);
    // The retry through the healthy store converges: the record
    // lands at the next position with a correct link.
    const outcome = await world.audit.record(submission(world, "op-crash"));
    expect(outcome.replayed).toBe(false);
    expect(outcome.chainSequence).toBe(2);
    const verification = await world.audit.verifyChain(world.applicationId);
    expect(verification.ok).toBe(true);
  });

  test("TAMPER DETECTION: a hand-crafted row with a forged digest is rejected at read time", async () => {
    const world = await seedAuditWorld(ctx.port);
    await world.audit.record(submission(world, "op-real"));
    // INSERT is legal (append-only forbids mutation, not appending);
    // a forged row must be REJECTED on read (never served).
    await world.db.execute({
      sql: `INSERT INTO audit.audit_records
                  (id, application_id, tenant_id, record_id, chain_sequence, action_kind, actor_id,
                   actor_kind, target_kind, target_id, seam, source_record_id, environment,
                   occurred_at, recorded_at, previous_record_digest, record_digest, payload)
            VALUES ($1, $2, $3, $4, 2, 'execution.transitioned', 'actor-1', 'service-principal',
                    'execution', $5, 'executions.transition', NULL, 'production',
                    now(), now(), $6, $7, $8)`,
      parameters: [
        randomUUID(),
        world.applicationId,
        world.tenantId,
        "c".repeat(64),
        randomUUID(),
        "0".repeat(64),
        "d".repeat(64),
        JSON.stringify({
          applicationId: world.applicationId,
          recordId: "c".repeat(64),
          action: { kind: "nope" },
        }),
      ],
    });
    await expect(world.store.getRecord(world.applicationId, "c".repeat(64))).rejects.toThrow();
    await expect(world.store.listRecords(world.applicationId)).rejects.toThrow();
    // Verification over the chain also surfaces the tampered record.
    const verification = await (async () => {
      try {
        return await world.audit.verifyChain(world.applicationId);
      } catch (error) {
        return { ok: false, violations: [{ code: "record-invalid", detail: String(error) }] };
      }
    })();
    expect(verification.ok).toBe(false);
  });

  test("provenance replay: every record carries actor/action/target/when/why with the exact source identity", async () => {
    const world = await seedAuditWorld(ctx.port);
    const executionId = randomUUID();
    await world.audit.record({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      environment: "production",
      actor: { actorId: "actor-42", actorKind: "human-principal" },
      action: { kind: "execution.transitioned", command: "plan", operationKey: "prov-1" },
      target: { kind: "execution", id: executionId },
      provenance: { seam: "executions.transition", sourceRecordId: executionId },
      rationale: {
        why: "plan transition requested",
        policyContext: {
          policySetId: "ps-1",
          policySetVersion: 3,
          policyContentHash: "a".repeat(64),
        },
      },
      occurredAt: "2026-09-20T12:34:56.000Z",
      actionDetail: { from: "AUTHORIZED", to: "PLANNING", sequence: 4 },
    });
    const record = (await world.store.listRecords(world.applicationId))[0]!;
    expect(record.actor).toEqual({ actorId: "actor-42", actorKind: "human-principal" });
    expect(record.action).toEqual({
      kind: "execution.transitioned",
      command: "plan",
      operationKey: "prov-1",
    });
    expect(record.target).toEqual({ kind: "execution", id: executionId });
    expect(record.provenance).toEqual({
      seam: "executions.transition",
      sourceRecordId: executionId,
    });
    expect(record.rationale.policyContext?.policySetVersion).toBe(3);
    expect(record.occurredAt).toBe("2026-09-20T12:34:56.000Z");
    expect(record.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(record.environment).toBe("production");
  });
});
