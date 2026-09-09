/**
 * Durable artifact recovery and provider substitution (platform
 * recovery plane; WORK-048 / D-07, acceptance criteria 2 and 5).
 *
 * THE AUTHORITY SPLIT (D1.0 §8, unchanged):
 *
 *   PostgreSQL = artifact METADATA authority (the write-once adoption
 *   ledger `deployments.media_artifacts`: storage key, content digest,
 *   lineage parent digests, deployment/job/execution linkage);
 *
 *   S3-compatible object store = BYTES only, independent of compute
 *   and of the database (content-addressed by the authoritative
 *   digest).
 *
 * RECOVERY MODEL (restore, never reconstruct):
 *
 *   - Artifact-provider loss (bucket/region/account loss) is recovered
 *     by reading the authoritative INVENTORY from PostgreSQL, fetching
 *     the bytes from an INDEPENDENT retained artifact store (replica,
 *     alternate provider, operator-held copy), verifying the sha256
 *     content digest against the authority, and restoring the bytes
 *     into the operative store at the SAME content-addressed key.
 *   - Identity preservation is enforced END-TO-END: key preserved,
 *     digest verified at source AND at target (read-after-write),
 *     lineage remains bound because the authority row is the source of
 *     the inventory — a migration that cannot prove identity/lineage
 *     preservation FAILS CLOSED (typed error, bounded report), it is
 *     never reported as successful recovery.
 *   - Verification detects: missing bytes (loss), corrupted bytes
 *     (checksum drift), identity collisions (different bytes at the
 *     same content-addressed key) and inventory drift (authority row
 *     without backing bytes). Unverified recovery is never declared.
 *
 * PROVIDER SUBSTITUTION (the R2 → alternate S3-compatible exit proof):
 *   the engine is the SAME procedure with source = the exiting
 *   provider's endpoint and target = the alternate provider's
 *   endpoint — adapters/configuration only, zero domain semantics,
 *   zero provider vocabulary in this module.
 */

import type { DatabasePort } from "../db/port";
import type { ObjectStorePort } from "../object-store/port";

/** Fail-closed artifact recovery error (typed, never silent). */
export class ArtifactRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactRecoveryError";
  }
}

/** One authoritative artifact inventory entry (from PostgreSQL). */
export interface ArtifactInventoryEntry {
  readonly applicationId: string;
  readonly tenantId: string;
  /** The content-addressed storage key (the authority's binding). */
  readonly artifactKey: string;
  /** The authoritative sha256 content digest (64 lowercase hex). */
  readonly artifactDigest: string;
  /** The lineage parent digests (identity-bearing lineage). */
  readonly parentDigests: readonly string[];
  readonly deploymentId: string;
  readonly jobId: string;
  readonly executionId: string;
  readonly role: string;
}

/** The inventory scan report (bounded, auditable). */
export interface ArtifactInventoryScan {
  readonly entries: readonly ArtifactInventoryEntry[];
  /** Digests that violate the 64-hex shape (corruption evidence). */
  readonly malformedDigests: readonly string[];
}

const DIGEST_SHAPE = /^[0-9a-f]{64}$/;

/**
 * Scan the authoritative adoption ledger (read-only; the recovery
 * source of truth — provider dashboards are never consulted).
 */
export async function scanArtifactInventory(db: DatabasePort): Promise<ArtifactInventoryScan> {
  const result = await db.execute<{
    readonly application_id: string;
    readonly tenant_id: string;
    readonly artifact_key: string;
    readonly artifact_digest: string;
    readonly parent_digests: unknown;
    readonly deployment_id: string;
    readonly job_id: string;
    readonly execution_id: string;
    readonly role: string;
  }>({
    sql: `SELECT application_id, tenant_id, artifact_key, artifact_digest,
                 parent_digests, deployment_id, job_id, execution_id, role
          FROM deployments.media_artifacts
          ORDER BY application_id, artifact_key`,
    parameters: [],
  });
  const malformedDigests: string[] = [];
  const entries: ArtifactInventoryEntry[] = [];
  for (const row of result.rows) {
    const parents = Array.isArray(row.parent_digests)
      ? (row.parent_digests as unknown[]).filter(
          (parent): parent is string => typeof parent === "string",
        )
      : [];
    if (!DIGEST_SHAPE.test(row.artifact_digest)) {
      malformedDigests.push(row.artifact_key);
    }
    entries.push({
      applicationId: row.application_id,
      tenantId: row.tenant_id,
      artifactKey: row.artifact_key,
      artifactDigest: row.artifact_digest,
      parentDigests: Object.freeze([...parents]),
      deploymentId: row.deployment_id,
      jobId: row.job_id,
      executionId: row.execution_id,
      role: row.role,
    });
  }
  return { entries: Object.freeze(entries), malformedDigests: Object.freeze(malformedDigests) };
}

/** The digest function seam (sha256 hex over bytes). */
export type DigestFunction = (bytes: Uint8Array) => string;

/** The inventory verification report (fail-closed recovered flag). */
export interface InventoryVerificationReport {
  readonly entries: number;
  readonly verified: number;
  /** Keys whose bytes are absent from the store (loss). */
  readonly missing: readonly string[];
  /** Keys whose bytes do not match the authoritative digest (corruption). */
  readonly corrupt: readonly string[];
  /** Keys with malformed authoritative digests (authority drift). */
  readonly malformed: readonly string[];
  /** True iff EVERY entry verified (the only recovered declaration). */
  readonly recovered: boolean;
}

/**
 * Verify one artifact store against the authoritative inventory:
 * every entry's bytes must exist and hash to the authoritative
 * digest. Missing or corrupt bytes are REPORTED, never repaired or
 * silently ignored (no uncontrolled data loss presented as success).
 */
export async function verifyArtifactInventory(
  store: ObjectStorePort,
  inventory: readonly ArtifactInventoryEntry[],
  digest: DigestFunction,
): Promise<InventoryVerificationReport> {
  const missing: string[] = [];
  const corrupt: string[] = [];
  const malformed: string[] = [];
  let verified = 0;
  for (const entry of inventory) {
    if (!DIGEST_SHAPE.test(entry.artifactDigest)) {
      malformed.push(entry.artifactKey);
      continue;
    }
    const stored = await store.get(entry.artifactKey);
    if (stored === null) {
      missing.push(entry.artifactKey);
      continue;
    }
    if (digest(stored.body) !== entry.artifactDigest) {
      corrupt.push(entry.artifactKey);
      continue;
    }
    verified += 1;
  }
  return Object.freeze({
    entries: inventory.length,
    verified,
    missing: Object.freeze([...missing]),
    corrupt: Object.freeze([...corrupt]),
    malformed: Object.freeze([...malformed]),
    recovered:
      inventory.length > 0 &&
      missing.length === 0 &&
      corrupt.length === 0 &&
      malformed.length === 0,
  });
}

/** One bounded migration/recovery failure record. */
export interface ArtifactMigrationFailure {
  readonly key: string;
  readonly reason: string;
}

/** The artifact byte recovery / store migration report. */
export interface ArtifactRecoveryReport {
  /** Entries in the authoritative inventory (the recovery plan). */
  readonly planned: number;
  /** Bytes restored into the target and verified there. */
  readonly recovered: number;
  /** Entries whose target bytes already matched (idempotent re-run). */
  readonly alreadyIntact: number;
  /** Failures (missing at source, digest mismatch, collision). */
  readonly failures: readonly ArtifactMigrationFailure[];
  /**
   * True iff every planned entry is recovered-and-verified at the
   * target — the ONLY successful-migration declaration.
   */
  readonly completed: boolean;
}

/**
 * Recover artifact bytes into a target store from an independent
 * source store, driven ENTIRELY by the authoritative inventory.
 *
 * Provider substitution (R2 → alternate S3-compatible) is this exact
 * procedure with source/target as the two providers' endpoints.
 *
 * Fails closed on: missing source bytes (loss), source digest drift
 * (corruption), target identity collision (different bytes at the
 * same key — never overwritten).
 */
export async function recoverArtifactBytes(
  source: ObjectStorePort,
  target: ObjectStorePort,
  inventory: readonly ArtifactInventoryEntry[],
  digest: DigestFunction,
): Promise<ArtifactRecoveryReport> {
  const failures: ArtifactMigrationFailure[] = [];
  let recovered = 0;
  let alreadyIntact = 0;

  for (const entry of inventory) {
    if (!DIGEST_SHAPE.test(entry.artifactDigest)) {
      failures.push({
        key: entry.artifactKey,
        reason: "authoritative digest is malformed (authority drift; refusing to migrate)",
      });
      continue;
    }
    // 1. The target may already hold the correct content (idempotent
    //    re-run). A DIFFERENT digest at the same key is an identity
    //    collision — fail closed, never overwrite.
    const atTarget = await target.get(entry.artifactKey);
    if (atTarget !== null) {
      const targetDigest = digest(atTarget.body);
      if (targetDigest === entry.artifactDigest) {
        alreadyIntact += 1;
        continue;
      }
      failures.push({
        key: entry.artifactKey,
        reason: `target identity collision: authoritative digest ${entry.artifactDigest} but target holds ${targetDigest}`,
      });
      continue;
    }
    // 2. Fetch from the independent source (fail closed on loss).
    const atSource = await source.get(entry.artifactKey);
    if (atSource === null) {
      failures.push({
        key: entry.artifactKey,
        reason: "bytes missing at the independent source store (unrecoverable loss)",
      });
      continue;
    }
    // 3. Verify content identity against the AUTHORITY (never trust
    //    provider checksums; the PostgreSQL digest is the truth).
    const sourceDigest = digest(atSource.body);
    if (sourceDigest !== entry.artifactDigest) {
      failures.push({
        key: entry.artifactKey,
        reason: `source content drift: authoritative digest ${entry.artifactDigest} but source holds ${sourceDigest}`,
      });
      continue;
    }
    // 4. Restore at the SAME content-addressed key (identity
    //    preservation) and verify read-after-write.
    await target.put(entry.artifactKey, atSource.body, {
      contentType: atSource.contentType,
    });
    const readBack = await target.get(entry.artifactKey);
    if (readBack === null || digest(readBack.body) !== entry.artifactDigest) {
      failures.push({
        key: entry.artifactKey,
        reason: "target read-after-write verification failed (incomplete restore)",
      });
      continue;
    }
    recovered += 1;
  }

  return Object.freeze({
    planned: inventory.length,
    recovered,
    alreadyIntact,
    failures: Object.freeze([...failures]),
    completed: inventory.length > 0 && failures.length === 0,
  });
}

/**
 * The lineage-preservation proof for a recovered/substituted store:
 * every inventory entry's lineage must remain RESOLVABLE against the
 * authority — the artifact digest still bound to its parents and its
 * deployment chain in the (restored) PostgreSQL ledger. A migration
 * that dropped lineage fails here even when the bytes are intact.
 */
export async function verifyLineagePreservation(
  db: DatabasePort,
  inventory: readonly ArtifactInventoryEntry[],
): Promise<{
  readonly entries: number;
  readonly preserved: number;
  readonly broken: readonly string[];
  readonly preservedAll: boolean;
}> {
  const broken: string[] = [];
  for (const entry of inventory) {
    const result = await db.execute<{ readonly count: string }>({
      sql: `SELECT count(*) AS count
            FROM deployments.media_artifacts
            WHERE artifact_key = $1
              AND application_id = $2
              AND artifact_digest = $3
              AND deployment_id = $4
              AND job_id = $5
              AND execution_id = $6
              AND parent_digests = $7::jsonb`,
      parameters: [
        entry.artifactKey,
        entry.applicationId,
        entry.artifactDigest,
        entry.deploymentId,
        entry.jobId,
        entry.executionId,
        JSON.stringify(entry.parentDigests),
      ],
    });
    if (Number(result.rows[0]?.count ?? 0) !== 1) {
      broken.push(entry.artifactKey);
    }
  }
  return Object.freeze({
    entries: inventory.length,
    preserved: inventory.length - broken.length,
    broken: Object.freeze([...broken]),
    preservedAll: inventory.length > 0 && broken.length === 0,
  });
}
