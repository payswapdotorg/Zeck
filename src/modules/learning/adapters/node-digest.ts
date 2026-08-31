/**
 * Node digest adapter (learning module adapter; WORK-014).
 *
 * node:crypto is confined to THIS file (the WORK-008/WORK-009
 * node-digest precedent — architecture gate: node:crypto never appears
 * in domain, application or ports).
 */

import { createHash } from "node:crypto";
import type { DigestPort } from "../ports/digest";

export function createNodeDigest(): DigestPort {
  return {
    sha256Hex(value: string): string {
      return createHash("sha256").update(value, "utf8").digest("hex");
    },
  };
}
