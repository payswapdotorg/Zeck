/**
 * Artifact content-integrity verification (WORK-043 / D-02,
 * acceptance criterion 6).
 *
 * The AUTHORITATIVE digest of an artifact lives in Zeck PostgreSQL
 * (the adoption ledger / artifact metadata) — never in object
 * storage. This wrapper enforces that invariant at the platform
 * boundary: bytes cross the `ObjectStorePort` only together with the
 * authoritative expected digest, and any mismatch FAILS CLOSED as
 * `ArtifactIntegrityError` WITHOUT deleting or mutating anything
 * (no "repair", no overwrite: the authority must reconcile, not the
 * storage path).
 *
 * Works over ANY `ObjectStorePort` implementation (provider-neutral
 * by construction); the R2 adapter gains integrity semantics
 * without R2 concepts leaking anywhere.
 */
import { createHash } from "node:crypto";
import type { ObjectStorePort, StoredObject } from "./port";

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export class ArtifactIntegrityError extends Error {
  readonly key: string;
  constructor(message: string, key: string) {
    super(message);
    this.name = "ArtifactIntegrityError";
    this.key = key;
  }
}

/** Compute the sha256 hex digest of byte content. */
export function contentDigestOf(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

export interface VerifyingObjectStore {
  /**
   * Put bytes whose digest is CHECKED against the authoritative
   * expected digest BEFORE transport (the caller's digest is the
   * authority; mismatch fails closed before anything is written).
   */
  putVerified(key: string, body: Uint8Array, expectedDigest: string): Promise<void>;
  /**
   * Get bytes and verify the returned content against the
   * authoritative expected digest. Mismatch fails closed; nothing is
   * deleted or modified (integrity violations are reported, never
   * self-healed).
   */
  getVerified(key: string, expectedDigest: string): Promise<StoredObject | null>;
}

export function createVerifyingObjectStore(store: ObjectStorePort): VerifyingObjectStore {
  return {
    async putVerified(key: string, body: Uint8Array, expectedDigest: string): Promise<void> {
      assertDigestShape(expectedDigest, key);
      const actual = contentDigestOf(body);
      if (actual !== expectedDigest) {
        throw new ArtifactIntegrityError(
          `refusing to store ${key}: content digest ${actual} does not match the authoritative digest (integrity mismatch fails closed; nothing was written)`,
          key,
        );
      }
      await store.put(key, body);
    },
    async getVerified(key: string, expectedDigest: string): Promise<StoredObject | null> {
      assertDigestShape(expectedDigest, key);
      const stored = await store.get(key);
      if (stored === null) {
        return null;
      }
      const actual = contentDigestOf(stored.body);
      if (actual !== expectedDigest) {
        throw new ArtifactIntegrityError(
          `integrity violation on ${key}: stored content digest ${actual} does not match the authoritative digest (authoritative metadata is untouched; the mismatch is reported, never repaired)`,
          key,
        );
      }
      return stored;
    },
  };
}

function assertDigestShape(digest: string, key: string): void {
  if (!SHA256_HEX_PATTERN.test(digest)) {
    throw new ArtifactIntegrityError(
      `the expected digest for ${key} must be 64 lowercase hex characters (sha256)`,
      key,
    );
  }
}
