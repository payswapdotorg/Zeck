/**
 * Node digest adapter (audit module adapter; WORK-059).
 *
 * node:crypto is confined to THIS file (the WORK-008/009
 * node-digest precedent — the architecture gate keeps node:crypto out
 * of domain, application and ports layers). The domain depends on the
 * provider-neutral `AuditDigestPort`.
 */

import { createHash } from "node:crypto";
import type { AuditDigestPort } from "../domain";

export function createAuditNodeDigest(): AuditDigestPort {
  return {
    sha256Hex(value: string): string {
      return createHash("sha256").update(value, "utf8").digest("hex");
    },
  };
}
