/**
 * Node crypto digest adapter (artifacts module; WORK-008).
 *
 * The single place in this module where `node:crypto` is touched; every
 * other layer depends on the `DigestPort` contract. sha256, lowercase hex.
 */

import { createHash } from "node:crypto";
import type { ArtifactDigest } from "../domain/artifact";
import type { DigestPort } from "../ports/digest";

export function createNodeDigestPort(): DigestPort {
  return {
    sha256Hex(canonicalBytes: string): ArtifactDigest {
      return createHash("sha256").update(canonicalBytes, "utf8").digest("hex") as ArtifactDigest;
    },
  };
}
