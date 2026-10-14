/**
 * The evaluation's canonical serialization + digest port (PCL-003).
 *
 * THE DISCIPLINE (the PCR-003 canonical.ts precedent): the evaluation's
 * reproducibility digests run over a NEUTRAL canonical projection —
 * sorted-key JSON at every depth (code-unit ordering, never locale-
 * dependent), arrays in element order — with wall-clock values and run
 * identities EXCLUDED from every digest projection (the honesty-anchor
 * discipline). The digest itself is INJECTED through a one-method port
 * (never ambient): the standalone run uses the node-digest adapter
 * (sha256 over the utf-8 canonical form — byte-identical to the
 * platform's own `createNodeDigest`, pinned in-suite like the PCR-003
 * adapter), and the suites may inject their own.
 *
 * Pure and total: same values → same canonical bytes → same digest.
 */

import { createHash } from "node:crypto";

/** Code-unit ordering (deterministic across environments). */
function byCodeUnitOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The neutral canonical JSON of a digest-projection value: recursively
 * sorted keys at every object depth (key-omission for undefined
 * values — the absence spelling), arrays in element order. NEVER
 * includes wall-clock values or run identities (the callers' digest
 * projections exclude them by construction).
 */
export function evaluationCanonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort(byCodeUnitOrder)
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

/** The one-method digest port (injected, never ambient). */
export interface DigestPort {
  readonly sha256Hex: (canonical: string) => string;
}

/**
 * The node-digest adapter: sha256 over the utf-8 canonical form —
 * byte-identical to the platform's own node digest (pinned in-suite).
 */
export function createNodeDigestPort(): DigestPort {
  return {
    sha256Hex: (canonical: string) => createHash("sha256").update(canonical, "utf8").digest("hex"),
  };
}
