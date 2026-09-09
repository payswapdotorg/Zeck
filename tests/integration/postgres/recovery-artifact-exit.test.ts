/**
 * Integration — THE ARTIFACT-RECOVERY / PROVIDER-EXIT DRILL (WORK-048 /
 * D-07, acceptance criteria 2 and 5: "Durable artifacts can be
 * recovered after compute/artifact-provider loss with preserved
 * identity and lineage" + "at least one alternate implementation is
 * demonstrated for ... artifact storage").
 *
 * THE PROTOCOL-LEVEL SUBSTITUTION PROOF (the WORK-047 evidence
 * pattern — live R2 is NOT RUN, never claimed):
 *
 *   * TWO REAL S3-COMPATIBLE ENDPOINTS (the in-process fake-s3
 *     server that VERIFIES every request's SigV4 signature — the
 *     primary stands in for the exiting R2-class provider, the
 *     alternate for the substitution target; both driven through the
 *     REAL `createS3ObjectStore` adapter — provider substitution is
 *     endpoints + credentials, zero code);
 *   * the artifact INVENTORY is the REAL PostgreSQL adoption ledger
 *     (a REAL media job adopted through the REAL module services —
 *     the authority is never the object store);
 *   * the artifact BYTES are the adopted artifact's exact
 *     canonical-identity bytes (the bytes the authoritative digest
 *     covers) — recovered content-addressed from primary → alternate
 *     with digest verification at BOTH ends and read-after-write.
 *
 * THE DRILL (each row is one durable recovery story):
 *
 *   A1 SUBSTITUTION: scan the authority → migrate every inventory
 *      entry primary → alternate (content-addressed, digest-verified)
 *      → verify the alternate against the authority → verify lineage
 *      preservation → the drill completes; re-running is IDEMPOTENT
 *      (already-intact).
 *   A2 OUTAGE FAIL-CLOSED: with the primary in a simulated outage,
 *      every byte operation through the outage wrapper fails with the
 *      adapter's TYPED 5xx error — never a silent null (a missing
 *      object must not masquerade as an outage), never a silent
 *      success.
 *
 * DISCRIMINATION (the Work Order's mutation requirements):
 *
 *   A3 LOSS: bytes missing at the independent source → typed
 *      failure ("unrecoverable loss"), completed:false — data loss
 *      is never presented as successful recovery.
 *   A4 CORRUPTION: source bytes that drifted from the authoritative
 *      digest → typed failure ("source content drift") — provider
 *      checksums are never trusted.
 *   A5 IDENTITY COLLISION: different bytes already at the target key
 *      → typed failure, the target is NEVER overwritten.
 *   A6 INCOMPLETE RESTORE: bytes deleted from the "recovered" target
 *      → inventory verification reports missing, recovered:false.
 *   A7 LINEAGE: the lineage-preservation proof fails closed when an
 *      adoption row's chain drifts in the authority.
 *   A8 AUTHORITY-DRIVEN (no provider state): the recovery plan is
 *      EXACTLY the adoption ledger — an object store holding extra
 *      foreign bytes changes nothing (recovery from provider-local
 *      state instead of PostgreSQL is unrepresentable).
 */
import { createHash } from "node:crypto";
import { Client } from "pg";
import { beforeAll, expect, test } from "vitest";
import { isArtifactDigest } from "../../../src/modules/artifacts/public";
import type { DatabasePort } from "../../../src/platform/db/port";
import {
  createS3ObjectStore,
  S3ObjectStoreError,
} from "../../../src/platform/object-store/s3-object-store";
import {
  type ArtifactInventoryEntry,
  recoverArtifactBytes,
  scanArtifactInventory,
  verifyArtifactInventory,
  verifyLineagePreservation,
} from "../../../src/platform/recovery/artifact-recovery";
import { OutageSimulatedObjectStore } from "../../../src/platform/recovery/outage";
import { type FakeS3Server, startFakeS3Server } from "../object-store/lib/fake-s3-server";
import { definePgSuite } from "./harness";
import { pollToCompletion, seedMediaWorld, submitMediaJob } from "./media-world";

const PRIMARY_BUCKET = "zeck-primary-exiting";
const ALTERNATE_BUCKET = "zeck-alternate-target";
const ACCESS_KEY_ID = "AKIATESTLOCALEXITKEY";
const SECRET_ACCESS_KEY = "localTestExitSecretAccessKeyValue";

const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** One disposable S3-compatible endpoint (a real HTTP server). */
interface Endpoint {
  readonly server: FakeS3Server;
  readonly store: ReturnType<typeof createS3ObjectStore>;
}

const startEndpoint = async (bucket: string): Promise<Endpoint> => {
  const server = await startFakeS3Server({
    bucket,
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
    region: "auto",
  });
  return {
    server,
    store: createS3ObjectStore({
      endpoint: server.url,
      bucket,
      region: "auto",
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
    }),
  };
};

/**
 * The authority-drift simulation session: the adoption ledger is
 * write-once by TRIGGER; a genuinely corrupted restored authority
 * (the corruption a foreign/legacy restore leaves behind) bypasses
 * the guards by construction (the restore itself runs in
 * replication-role mode), so the simulation uses the same mode.
 */
async function driftSession(
  databaseUrl: string,
  work: (client: Client) => Promise<void>,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("SET session_replication_role = replica");
    await work(client);
  } finally {
    await client.end();
  }
}

definePgSuite("the artifact-recovery / provider-exit drill (WORK-048 D-07 AC2+AC5)", (ctx) => {
  let primary: Endpoint;
  let alternate: Endpoint;
  let inventory: readonly ArtifactInventoryEntry[];
  let artifactBytes: Uint8Array;
  let db: DatabasePort;

  beforeAll(async () => {
    db = ctx.port;
    primary = await startEndpoint(PRIMARY_BUCKET);
    alternate = await startEndpoint(ALTERNATE_BUCKET);

    // The authoritative adoption ledger, through the REAL module
    // services (media world): a completed media job ADOPTS one
    // artifact with content digest + lineage + deployment chain.
    const world = await seedMediaWorld(db);
    const submitted = await submitMediaJob(world, "d07-artifact-exit");
    const completed = await pollToCompletion(world.service, submitted.jobId, world.actor());
    if (completed === null || completed.status !== "completed") {
      throw new Error(`the drill seed job did not complete (${completed?.status ?? "null"})`);
    }

    // The artifact's canonical-identity bytes (the exact bytes the
    // authoritative digest covers) — the retained durable copy the
    // operative store holds.
    const adoption = await db.execute<{
      readonly artifact_key: string;
      readonly artifact_digest: string;
    }>({
      sql: "SELECT artifact_key, artifact_digest FROM deployments.media_artifacts WHERE job_id = $1",
      parameters: [submitted.jobId],
    });
    if (adoption.rows.length !== 1) {
      throw new Error("the adoption ledger row is missing (seed defect)");
    }
    const ledgerDigest = adoption.rows[0]?.artifact_digest as string;
    if (!isArtifactDigest(ledgerDigest)) {
      throw new Error("the adoption digest is malformed (seed defect)");
    }
    const record = await world.artifacts.getArtifact({ tenantId: world.tenantId }, ledgerDigest);
    artifactBytes = Buffer.from(record.canonicalContent, "utf8");
    if (digestOf(artifactBytes) !== adoption.rows[0]?.artifact_digest) {
      throw new Error(
        "the artifact bytes do not hash to the authoritative digest (fixture defect)",
      );
    }

    // The authoritative inventory FIRST (the plan is the ledger).
    const scan = await scanArtifactInventory(db);
    inventory = scan.entries;
    if (inventory.length < 1 || scan.malformedDigests.length > 0) {
      throw new Error("the inventory scan is empty or malformed (seed defect)");
    }
    const adopted = inventory.find(
      (entry) => entry.artifactDigest === adoption.rows[0]?.artifact_digest,
    );
    if (adopted === undefined) {
      throw new Error("the scanned inventory misses the adopted artifact (seed defect)");
    }

    // The operative (exiting) provider holds the retained bytes at
    // the CONTENT-ADDRESSED storage key (derived from the
    // authoritative digest — the D-02 namespace discipline).
    await primary.store.put(adopted.storageKey, artifactBytes, {
      contentType: "application/json",
    });
  });

  test("A1 substitution: authority-driven migration primary → alternate preserves identity + lineage, and is idempotent", async () => {
    // The recovery plan is EXACTLY the adoption ledger.
    const migration = await recoverArtifactBytes(
      primary.store,
      alternate.store,
      inventory,
      digestOf,
    );
    expect(migration.planned).toBe(inventory.length);
    expect(migration.recovered).toBe(inventory.length);
    expect(migration.alreadyIntact).toBe(0);
    expect(migration.failures).toEqual([]);
    expect(migration.completed).toBe(true);

    // The alternate verifies against the AUTHORITY (content identity).
    const verification = await verifyArtifactInventory(alternate.store, inventory, digestOf);
    expect(verification.entries).toBe(inventory.length);
    expect(verification.verified).toBe(inventory.length);
    expect(verification.missing).toEqual([]);
    expect(verification.corrupt).toEqual([]);
    expect(verification.malformed).toEqual([]);
    expect(verification.recovered).toBe(true);

    // Lineage stays bound (the authority row is the inventory source).
    const lineage = await verifyLineagePreservation(db, inventory);
    expect(lineage.preservedAll).toBe(true);
    expect(lineage.broken).toEqual([]);

    // Re-running the migration is idempotent (already-intact; the
    // substitution is repeatable for a self-hosted operator).
    const rerun = await recoverArtifactBytes(primary.store, alternate.store, inventory, digestOf);
    expect(rerun.alreadyIntact).toBe(inventory.length);
    expect(rerun.recovered).toBe(0);
    expect(rerun.completed).toBe(true);
  });

  test("A2 outage fail-closed: an object-store outage surfaces the typed 5xx error — never null, never silent success", async () => {
    const outage = new OutageSimulatedObjectStore(primary.store);
    outage.begin();
    const key = inventory[0]?.storageKey as string;

    // get during the outage FAILS CLOSED with the adapter's typed
    // error class (a "null" would masquerade as a missing object).
    await expect(outage.get(key)).rejects.toThrow(S3ObjectStoreError);
    await expect(outage.put(key, artifactBytes)).rejects.toThrow(S3ObjectStoreError);
    expect(outage.failedOperations).toBe(2);

    // The inventory verification propagates the typed failure — it
    // never reports the entry "missing" on an outage.
    await expect(verifyArtifactInventory(outage, inventory, digestOf)).rejects.toThrow(
      S3ObjectStoreError,
    );

    // Recovery after the outage: end() restores the pass-through.
    outage.end();
    const after = await outage.get(key);
    expect(after).not.toBeNull();
    expect(digestOf((after as { body: Uint8Array }).body)).toBe(inventory[0]?.artifactDigest);
  });

  test("A3 loss discrimination: bytes missing at the independent source is unrecoverable loss — never success", async () => {
    const emptySource = await startEndpoint("zeck-empty-source");
    const freshTarget = await startEndpoint("zeck-fresh-target-a3");
    try {
      const report = await recoverArtifactBytes(
        emptySource.store,
        freshTarget.store,
        inventory,
        digestOf,
      );
      expect(report.completed).toBe(false);
      expect(report.recovered).toBe(0);
      expect(report.failures).toHaveLength(inventory.length);
      expect(
        report.failures.every((failure) => failure.reason.includes("unrecoverable loss")),
      ).toBe(true);
      // Nothing landed at the target.
      const target = await freshTarget.store.get(inventory[0]?.storageKey as string);
      expect(target).toBeNull();
    } finally {
      await emptySource.server.close();
      await freshTarget.server.close();
    }
  });

  test("A4 corruption discrimination: source content drift from the authoritative digest fails closed", async () => {
    const driftedSource = await startEndpoint("zeck-drifted-source");
    const freshTarget = await startEndpoint("zeck-fresh-target-a4");
    try {
      // The source holds DIFFERENT bytes at the content-addressed key
      // (provider-side corruption; its own checksums would agree).
      for (const entry of inventory) {
        await driftedSource.store.put(
          entry.storageKey,
          Buffer.from(`${entry.artifactKey}:corrupted-bytes`, "utf8"),
        );
      }
      const report = await recoverArtifactBytes(
        driftedSource.store,
        freshTarget.store,
        inventory,
        digestOf,
      );
      expect(report.completed).toBe(false);
      expect(report.recovered).toBe(0);
      expect(
        report.failures.every((failure) => failure.reason.includes("source content drift")),
      ).toBe(true);
    } finally {
      await driftedSource.server.close();
      await freshTarget.server.close();
    }
  });

  test("A5 identity-collision discrimination: different bytes at the target key are never overwritten", async () => {
    const collidingTarget = await startEndpoint("zeck-colliding-target");
    try {
      // The target already holds DIFFERENT bytes at the same
      // content-addressed key (an identity collision).
      const key = inventory[0]?.storageKey as string;
      await collidingTarget.store.put(key, Buffer.from("foreign-bytes-at-the-key", "utf8"));
      const report = await recoverArtifactBytes(
        primary.store,
        collidingTarget.store,
        inventory,
        digestOf,
      );
      expect(report.completed).toBe(false);
      expect(report.failures[0]?.reason).toContain("target identity collision");
      // The foreign bytes were NOT overwritten (never destroy to
      // "recover").
      const held = await collidingTarget.store.get(key);
      expect(held).not.toBeNull();
      expect(Buffer.from((held as { body: Uint8Array }).body).toString("utf8")).toBe(
        "foreign-bytes-at-the-key",
      );
    } finally {
      await collidingTarget.server.close();
    }
  });

  test("A6 incomplete-restore discrimination: missing bytes at the recovered target refuse the recovered declaration", async () => {
    // Simulate an incomplete restore: delete ONE artifact's bytes
    // from the (already recovered) alternate store.
    const key = inventory[0]?.storageKey as string;
    await alternate.store.delete(key);
    const verification = await verifyArtifactInventory(alternate.store, inventory, digestOf);
    expect(verification.recovered).toBe(false);
    expect(verification.missing).toEqual([inventory[0]?.artifactKey]);
    expect(verification.verified).toBe(inventory.length - 1);
    // Restore the bytes for the following tests (fixture hygiene).
    await alternate.store.put(key, artifactBytes, { contentType: "application/json" });
  });

  test("A7 lineage discrimination: an adoption row whose chain drifted in the authority fails lineage preservation", async () => {
    const victim = inventory[0] as ArtifactInventoryEntry;
    const databaseUrl = `${ctx.adminUrl.replace(/\/[^/]*$/, "")}/${ctx.databaseName}`;
    // Simulate authority drift after the inventory snapshot: the
    // parent lineage of the victim row changes (the snapshot no
    // longer resolves). Drift is written with the write-once
    // guards suspended — the corruption a foreign/legacy restore
    // leaves behind.
    await driftSession(databaseUrl, async (client) => {
      await client.query(
        `UPDATE deployments.media_artifacts SET parent_digests = '["${"0".repeat(64)}"]'::jsonb WHERE artifact_key = $1`,
        [victim.artifactKey],
      );
    });
    try {
      const lineage = await verifyLineagePreservation(db, inventory);
      expect(lineage.preservedAll).toBe(false);
      expect(lineage.broken).toContain(victim.artifactKey);
    } finally {
      // Restore the authoritative lineage (fixture hygiene).
      await driftSession(databaseUrl, async (client) => {
        await client.query(
          "UPDATE deployments.media_artifacts SET parent_digests = $2::jsonb WHERE artifact_key = $1",
          [victim.artifactKey, JSON.stringify(victim.parentDigests)],
        );
      });
    }
    const healed = await verifyLineagePreservation(db, inventory);
    expect(healed.preservedAll).toBe(true);
  });

  test("A8 authority-driven discrimination: foreign bytes in a store are invisible — the plan is EXACTLY the adoption ledger", async () => {
    // A store holding EXTRA foreign bytes (provider-local state) is
    // not a recovery source: the inventory (PostgreSQL) decides what
    // must exist. Extra bytes change nothing about verification.
    await primary.store.put("zeck/foreign/orphan-bytes", Buffer.from("orphan", "utf8"));
    const scan = await scanArtifactInventory(db);
    expect(scan.entries).toHaveLength(inventory.length);
    const verification = await verifyArtifactInventory(alternate.store, scan.entries, digestOf);
    expect(verification.recovered).toBe(true);
    // And the orphan is NOT migrated (it is not in the plan).
    const migration = await recoverArtifactBytes(
      primary.store,
      alternate.store,
      scan.entries,
      digestOf,
    );
    expect(migration.alreadyIntact).toBe(inventory.length);
    expect(migration.recovered).toBe(0);
    expect(migration.completed).toBe(true);
    const orphan = await alternate.store.get("zeck/foreign/orphan-bytes");
    expect(orphan).toBeNull();
  });
});
