/**
 * Node sha256 adapter for the `PolicyHasher` port (policies module; WORK-007).
 *
 * The only file in this module importing `node:crypto` (the WORK-008
 * digest-adapter confinement precedent): content hashing is infrastructure;
 * the domain stays pure and injectable.
 */

import { createHash } from "node:crypto";
import type { PolicyHasher } from "../ports/policy-authority";

export const nodePolicyHasher: PolicyHasher = {
  sha256Hex(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
  },
};
