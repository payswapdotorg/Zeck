/**
 * Discrimination tests — the D-07 resilience/recovery protections
 * (WORK-048, HIGH_ASSURANCE; the worker-runbook rule: "For
 * HIGH_ASSURANCE and CRITICAL, add an explicit discrimination test
 * that proves a weakened protection is rejected").
 *
 * Every fail-closed protection introduced by WORK-048 is
 * mutation-proven — the WEAKENED form is rejected by the gate that
 * owns it (the executed integration drills prove the SAME gates over
 * real PostgreSQL and real S3-compatible endpoints; these proofs pin
 * the protections at the unit seam with in-memory doubles):
 *
 *  - the storage-key derivation: a malformed authoritative digest or
 *    an out-of-namespace tenant id refuses to derive a key (the
 *    "any string is a key" weakening is unrepresentable);
 *  - the artifact byte migration: source LOSS, source DRIFT, target
 *    IDENTITY COLLISION and read-after-write failure each fail
 *    closed — "successful recovery" is only every-entry-verified;
 *  - the inventory verification: missing/corrupt/malformed entries
 *    each refuse the recovered declaration (the "trust the store"
 *    weakening — including a lying store that returns the wrong
 *    bytes — is rejected);
 *  - the transport recovery plan: every envelope state maps to its
 *    recovery class from the CLOSED vocabulary; a state outside it
 *    is corruption (an error), never a guess; a bounded limit is
 *    enforced;
 *  - the outage wrappers: while active, every operation through the
 *    wrapped port fails with the OWNING adapter's typed error class
 *    (queue: transient transport error; object store: 5xx store
 *    error; database: authority-unavailable) — never a silent null,
 *    never a silent success;
 *  - the evacuation config: empty and over-long region labels are
 *    rejected before any state is touched.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { DatabaseUnavailableError } from "../../src/platform/db/errors";
import type { DatabasePort, Query, QueryResult } from "../../src/platform/db/port";
import type { ObjectStorePort, StoredObject } from "../../src/platform/object-store/port";
import { S3ObjectStoreError } from "../../src/platform/object-store/s3-object-store";
import type { QueueTransportPort } from "../../src/platform/queue/port";
import { QueueTransportError } from "../../src/platform/queue/port";
import {
  type ArtifactInventoryEntry,
  ArtifactRecoveryError,
  recoverArtifactBytes,
  storageKeyOf,
  verifyArtifactInventory,
} from "../../src/platform/recovery/artifact-recovery";
import {
  EvacuationConfigError,
  RegionalWorkerEvacuator,
} from "../../src/platform/recovery/evacuation";
import {
  OutageSimulatedDatabase,
  OutageSimulatedObjectStore,
  OutageSimulatedQueueTransport,
} from "../../src/platform/recovery/outage";
import {
  planTransportRecovery,
  TransportRecoveryError,
} from "../../src/platform/recovery/transport-recovery";

const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const sha256Of = (text: string): string => digestOf(Buffer.from(text, "utf8"));

/** An in-memory object-store double (configurable per-key behavior). */
class MemoryObjectStore implements ObjectStorePort {
  private readonly map = new Map<string, StoredObject>();

  constructor(entries: readonly [string, Uint8Array][] = []) {
    for (const [key, body] of entries) {
      this.map.set(key, { key, body, contentType: "application/octet-stream" });
    }
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    this.map.set(key, { key, body, contentType: "application/octet-stream" });
  }

  async get(key: string): Promise<StoredObject | null> {
    return this.map.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

/** An in-memory DatabasePort double for the plan-only queries. */
class StubDatabasePort implements DatabasePort {
  constructor(private readonly rows: Record<string, unknown>[]) {}

  async execute<T = Record<string, unknown>>(query: Query): Promise<QueryResult<T>> {
    void query;
    return { rows: this.rows as T[], rowCount: this.rows.length };
  }

  async transaction<T>(work: (tx: DatabasePort) => Promise<T>): Promise<T> {
    return work(this);
  }
}

const entryOf = (overrides: Partial<ArtifactInventoryEntry> = {}): ArtifactInventoryEntry => {
  const digest = overrides.artifactDigest ?? sha256Of("fixture-artifact-bytes");
  const tenantId = overrides.tenantId ?? "0123abcd-0123-7abc-8def-0123456789ab";
  const digestShape = /^[0-9a-f]{64}$/;
  return {
    applicationId: "app",
    tenantId,
    artifactKey: "out:fixture-job",
    storageKey: digestShape.test(digest)
      ? storageKeyOf({ tenantId, artifactDigest: digest })
      : "malformed:out:fixture-job",
    artifactDigest: digest,
    parentDigests: [],
    deploymentId: "dep",
    jobId: "job",
    executionId: "exec",
    role: "generated-output",
    ...overrides,
  };
};

describe("D-07 discrimination — the storage-key derivation guards", () => {
  test("a malformed authoritative digest refuses to derive a key (authority drift, never a guess)", () => {
    expect(() => storageKeyOf({ tenantId: "t", artifactDigest: "not-a-digest" })).toThrow(
      ArtifactRecoveryError,
    );
  });

  test("an out-of-namespace tenant id refuses to derive a key", () => {
    expect(() =>
      storageKeyOf({ tenantId: "UPPER_CASE_TENANT!", artifactDigest: sha256Of("x") }),
    ).toThrow(/outside the artifact namespace shape/);
  });

  test("a well-formed entry derives the content-addressed D-02 key shape", () => {
    const entry = entryOf();
    expect(entry.storageKey).toMatch(
      /^zeck\/artifacts\/[a-z0-9-]{1,64}\/[0-9a-f]{2}\/[0-9a-f]{64}$/,
    );
    expect(entry.storageKey.endsWith(entry.artifactDigest)).toBe(true);
  });
});

describe("D-07 discrimination — the artifact byte migration protections", () => {
  const bytes = Buffer.from("fixture-artifact-bytes", "utf8");
  const entry = entryOf();

  test("the happy path migrates and verifies (the protection baseline)", async () => {
    const source = new MemoryObjectStore([[entry.storageKey, bytes]]);
    const target = new MemoryObjectStore();
    const report = await recoverArtifactBytes(source, target, [entry], digestOf);
    expect(report.completed).toBe(true);
    expect(report.recovered).toBe(1);
    const verification = await verifyArtifactInventory(target, [entry], digestOf);
    expect(verification.recovered).toBe(true);
  });

  test("source LOSS: missing source bytes are unrecoverable loss — never success", async () => {
    const emptySource = new MemoryObjectStore();
    const target = new MemoryObjectStore();
    const report = await recoverArtifactBytes(emptySource, target, [entry], digestOf);
    expect(report.completed).toBe(false);
    expect(report.failures[0]?.reason).toContain("unrecoverable loss");
  });

  test("source DRIFT: bytes that do not hash to the authoritative digest fail closed", async () => {
    const drifted = new MemoryObjectStore([[entry.storageKey, Buffer.from("drifted", "utf8")]]);
    const target = new MemoryObjectStore();
    const report = await recoverArtifactBytes(drifted, target, [entry], digestOf);
    expect(report.completed).toBe(false);
    expect(report.failures[0]?.reason).toContain("source content drift");
    // Nothing landed at the target.
    expect(await target.get(entry.storageKey)).toBeNull();
  });

  test("target IDENTITY COLLISION: different bytes at the key are never overwritten", async () => {
    const source = new MemoryObjectStore([[entry.storageKey, bytes]]);
    const target = new MemoryObjectStore([[entry.storageKey, Buffer.from("foreign", "utf8")]]);
    const report = await recoverArtifactBytes(source, target, [entry], digestOf);
    expect(report.completed).toBe(false);
    expect(report.failures[0]?.reason).toContain("target identity collision");
    expect(
      Buffer.from(((await target.get(entry.storageKey)) as StoredObject).body).toString(),
    ).toBe("foreign");
  });

  test("a LYING store (wrong bytes returned after put) fails read-after-write", async () => {
    const source = new MemoryObjectStore([[entry.storageKey, bytes]]);
    // The lying target: the pre-put get misses (nothing at the key),
    // the put "succeeds", and the read-back returns DIFFERENT bytes —
    // the read-after-write verification must catch it.
    let putCount = 0;
    const lyingTarget: ObjectStorePort = {
      put: async () => {
        putCount += 1;
      },
      get: async (key) =>
        putCount === 0 ? null : { key, body: Buffer.from("lies", "utf8"), contentType: undefined },
      delete: async () => undefined,
    };
    const report = await recoverArtifactBytes(source, lyingTarget, [entry], digestOf);
    expect(putCount).toBe(1);
    expect(report.completed).toBe(false);
    expect(report.failures[0]?.reason).toContain("read-after-write verification failed");
  });

  test("inventory verification: missing, corrupt and malformed each refuse recovered", async () => {
    const missing = await verifyArtifactInventory(new MemoryObjectStore(), [entry], digestOf);
    expect(missing.recovered).toBe(false);
    expect(missing.missing).toEqual([entry.artifactKey]);

    const corruptStore = new MemoryObjectStore([[entry.storageKey, Buffer.from("bad", "utf8")]]);
    const corrupt = await verifyArtifactInventory(corruptStore, [entry], digestOf);
    expect(corrupt.recovered).toBe(false);
    expect(corrupt.corrupt).toEqual([entry.artifactKey]);

    const malformedEntry = entryOf({ artifactDigest: "not-a-digest" });
    const malformed = await verifyArtifactInventory(
      new MemoryObjectStore(),
      [malformedEntry],
      digestOf,
    );
    expect(malformed.recovered).toBe(false);
    expect(malformed.malformed).toEqual([malformedEntry.artifactKey]);
  });

  test("an EMPTY inventory is never 'recovered' (vacuous success is unrepresentable)", async () => {
    const verification = await verifyArtifactInventory(new MemoryObjectStore(), [], digestOf);
    expect(verification.recovered).toBe(false);
    const report = await recoverArtifactBytes(
      new MemoryObjectStore(),
      new MemoryObjectStore(),
      [],
      digestOf,
    );
    expect(report.completed).toBe(false);
  });
});

describe("D-07 discrimination — the transport recovery plan", () => {
  const envelope = (state: string, appliedAt: string | null = null): StubDatabasePort =>
    new StubDatabasePort([
      {
        id: "env-1",
        correlation_key: "execution-dispatch:exec",
        execution_id: "exec",
        state,
        applied_at: appliedAt,
      },
    ]);

  test("every closed-vocabulary state maps to its recovery class", async () => {
    const cases: readonly [string, string][] = [
      ["recorded", "republish"],
      ["backlogged", "republish"],
      ["published", "re-drive"],
      ["consumed", "converged"],
      ["dead-lettered", "dead-lettered"],
    ];
    for (const [state, recoveryClass] of cases) {
      const plan = await planTransportRecovery(envelope(state));
      expect(plan.items[0]?.recoveryClass, state).toBe(recoveryClass);
    }
    // published + applied → converged (the effect landed).
    const applied = await planTransportRecovery(envelope("published", "2026-09-09T00:00:00Z"));
    expect(applied.items[0]?.recoveryClass).toBe("converged");
  });

  test("a state OUTSIDE the vocabulary is corruption — an error, never a guess", async () => {
    await expect(planTransportRecovery(envelope("spoofed"))).rejects.toThrow(
      TransportRecoveryError,
    );
    await expect(planTransportRecovery(envelope("Published"))).rejects.toThrow(
      /unknown state "Published"/,
    );
  });

  test("the bounded limit is enforced (unbounded scans are unrepresentable)", async () => {
    await expect(planTransportRecovery(new StubDatabasePort([]), 0)).rejects.toThrow(
      /limit must be an integer/,
    );
    await expect(planTransportRecovery(new StubDatabasePort([]), 10_001)).rejects.toThrow(
      /limit must be an integer/,
    );
  });
});

describe("D-07 discrimination — the outage wrappers (typed fail-closed)", () => {
  test("a queue outage fails with the transport error class and counts evidence", async () => {
    const inner: QueueTransportPort = {
      publish: async () => ({ accepted: true }),
      pull: async () => ({ messages: [], backlogEstimate: null }),
      settle: async () => undefined,
    };
    const outage = new OutageSimulatedQueueTransport(inner);
    outage.begin();
    await expect(outage.publish({ body: "x", contentType: "text/plain" })).rejects.toThrow(
      QueueTransportError,
    );
    await expect(outage.pull()).rejects.toThrow(/simulated provider outage/);
    await expect(outage.settle({ ackLeaseIds: ["m"], retryLeaseIds: [] })).rejects.toThrow(
      QueueTransportError,
    );
    expect(outage.failedOperations).toBe(3);
    outage.end();
    await expect(outage.pull()).resolves.toEqual({ messages: [], backlogEstimate: null });
  });

  test("an object-store outage fails with the 5xx store error — never null", async () => {
    const inner = new MemoryObjectStore([["k", Buffer.from("v")]]);
    const outage = new OutageSimulatedObjectStore(inner);
    outage.begin();
    await expect(outage.get("k")).rejects.toThrow(S3ObjectStoreError);
    await expect(outage.put("k", Buffer.from("v"))).rejects.toThrow(S3ObjectStoreError);
    await expect(outage.delete("k")).rejects.toThrow(S3ObjectStoreError);
    expect(outage.failedOperations).toBe(3);
    outage.end();
    expect(await outage.get("k")).not.toBeNull();
  });

  test("a database outage fails with the authority-unavailable class (queries AND transactions)", async () => {
    const inner = new StubDatabasePort([]);
    const outage = new OutageSimulatedDatabase(inner);
    outage.begin();
    await expect(outage.execute({ sql: "SELECT 1", parameters: [] })).rejects.toThrow(
      DatabaseUnavailableError,
    );
    await expect(
      outage.transaction(async (tx) => tx.execute({ sql: "SELECT 1", parameters: [] })),
    ).rejects.toThrow(DatabaseUnavailableError);
    expect(outage.failedOperations).toBe(2);
    outage.end();
    await expect(outage.execute({ sql: "SELECT 1", parameters: [] })).resolves.toEqual({
      rows: [],
      rowCount: 0,
    });
  });
});

describe("D-07 discrimination — the evacuation configuration guards", () => {
  const evacuator = (store: {
    listWorkers: () => Promise<readonly unknown[]>;
  }): RegionalWorkerEvacuator =>
    new RegionalWorkerEvacuator({
      store: store as never,
      lease: { forceRelease: async () => ({ released: false }) },
      now: () => new Date(),
    });

  test("empty and over-long region labels are rejected before any state is touched", async () => {
    const store = { listWorkers: async () => [] };
    await expect(evacuator(store).evacuate({ region: "", mode: "fence" })).rejects.toThrow(
      EvacuationConfigError,
    );
    await expect(
      evacuator(store).evacuate({ region: "x".repeat(101), mode: "fence" }),
    ).rejects.toThrow(/1\.\.100 characters/);
  });

  test("an unknown region fails closed (ambiguous input, never a silent no-op)", async () => {
    const store = { listWorkers: async () => [] };
    await expect(evacuator(store).evacuate({ region: "nowhere", mode: "fence" })).rejects.toThrow(
      /no workers are registered for region "nowhere"/,
    );
  });
});
