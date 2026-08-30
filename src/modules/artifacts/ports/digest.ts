/**
 * Digest port (artifacts module; WORK-008).
 *
 * A stable hash function over canonical bytes. The domain never touches
 * node:crypto directly — hashing is a port, satisfied by the node adapter
 * (`adapters/node-digest.ts`). Determinism requirements: fixed algorithm
 * (sha256), lowercase hex, no floating point involved.
 */

import type { ArtifactDigest } from "../domain/artifact";

export interface DigestPort {
  /** SHA-256 of the UTF-8 encoding of `canonicalBytes`, lowercase hex. */
  sha256Hex(canonicalBytes: string): ArtifactDigest;
}
