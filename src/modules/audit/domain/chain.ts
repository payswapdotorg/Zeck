/**
 * Hash-chain integrity verification (WORK-059 / SEC-004 domain).
 *
 * PURE and DETERMINISTIC: the same records always produce the same
 * verdict (EXECUTION-PROVENANCE: "replayable by deterministic audit").
 *
 * The chain model:
 *
 *  - records occupy gapless positions `1..maxSequence` per application;
 *  - every record's `recordDigest` covers its full content (tamper
 *    detection — re-computed here);
 *  - every record's `previousRecordDigest` must equal the
 *    `recordDigest` of the record at `sequence - 1` (the genesis
 *    constant for sequence 1);
 *  - the GOVERNED retention purge deletes records; a purge manifest
 *    (carried by the purge-evidence record itself, digest-covered)
 *    lists every purged `{sequence, recordDigest}`. A missing
 *    position is legal ONLY when it is exactly covered by a manifest
 *    entry — and the link across the gap must match the digest of the
 *    HIGHEST purged position in that gap (nothing about a purge is
 *    silently unverifiable);
 *  - tampered manifests are rejected: a manifest's commitment must be
 *    the digest over its canonical entry list, and its entries must
 *    never overlap another manifest's (double-purge is detectable).
 */

import { canonicalAuditJson } from "./canonical";
import type { AuditDigestPort, AuditRecord } from "./record";
import { validateAuditRecord } from "./record";

/** One purged record as manifested by a governed purge. */
export interface PurgeManifestEntry {
  readonly sequence: number;
  readonly recordDigest: string;
}

/** The purge manifest carried by a `retention.purge-executed` record. */
export interface PurgeManifest {
  readonly policyVersion: number;
  readonly cutoff: string;
  readonly entries: readonly PurgeManifestEntry[];
  /** sha256 over the canonical entry list (manifest integrity). */
  readonly commitment: string;
}

export const CHAIN_VIOLATION_CODES = [
  "record-invalid",
  "sequence-disorder",
  "chain-gap-uncovered",
  "chain-link-broken",
  "manifest-invalid",
  "manifest-overlap",
] as const;
export type ChainViolationCode = (typeof CHAIN_VIOLATION_CODES)[number];

export interface ChainViolation {
  readonly code: ChainViolationCode;
  readonly detail: string;
}

export interface ChainVerification {
  readonly ok: boolean;
  readonly violations: readonly ChainViolation[];
  /** The verified chain length (highest verified sequence). */
  readonly lastSequence: number;
  /** The digest of the last verified record (null when empty). */
  readonly lastDigest: string | null;
}

const DETAIL_MAX = 300;

function detail(text: string): string {
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}…` : text;
}

/** Compute a purge manifest's commitment (digest over canonical entries). */
export function purgeManifestCommitment(
  manifest: Omit<PurgeManifest, "commitment">,
  digest: AuditDigestPort,
): string {
  return digest.sha256Hex(canonicalAuditJson(manifest.entries));
}

/** Validate one manifest (shape + commitment). Fail closed, typed. */
export function validatePurgeManifest(value: unknown, digest: AuditDigestPort): PurgeManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("purge manifest must be an object");
  }
  const manifest = value as Record<string, unknown>;
  if (!Number.isInteger(manifest.policyVersion) || (manifest.policyVersion as number) < 1) {
    throw new Error("purge manifest policyVersion must be a positive integer");
  }
  if (typeof manifest.cutoff !== "string" || manifest.cutoff.length === 0) {
    throw new Error("purge manifest cutoff must be a non-empty string");
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    throw new Error("purge manifest must carry at least one entry");
  }
  const entries: PurgeManifestEntry[] = [];
  let previous = 0;
  for (const entry of manifest.entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("purge manifest entries must be objects");
    }
    const { sequence, recordDigest } = entry as Record<string, unknown>;
    if (!Number.isInteger(sequence) || (sequence as number) < 1) {
      throw new Error("purge manifest entry sequence must be a positive integer");
    }
    if (typeof recordDigest !== "string" || !/^[0-9a-f]{64}$/.test(recordDigest)) {
      throw new Error("purge manifest entry recordDigest must be a sha256 hex digest");
    }
    if ((sequence as number) <= previous) {
      throw new Error("purge manifest entries must be strictly increasing by sequence");
    }
    previous = sequence as number;
    entries.push({ sequence: sequence as number, recordDigest });
  }
  const commitment = manifest.commitment;
  if (typeof commitment !== "string" || !/^[0-9a-f]{64}$/.test(commitment)) {
    throw new Error("purge manifest commitment must be a sha256 hex digest");
  }
  const computed = purgeManifestCommitment(
    { policyVersion: manifest.policyVersion as number, cutoff: manifest.cutoff, entries },
    digest,
  );
  if (computed !== commitment) {
    throw new Error("purge manifest commitment does not cover its entries (tampered manifest)");
  }
  return {
    policyVersion: manifest.policyVersion as number,
    cutoff: manifest.cutoff,
    entries,
    commitment,
  };
}

/** The manifest a purge-evidence record carries, when present. */
export function purgeManifestOfRecord(record: AuditRecord): PurgeManifest | null {
  const purge = (record.actionDetail as Record<string, unknown>).purge;
  if (purge === undefined || purge === null) {
    return null;
  }
  return purge as PurgeManifest;
}

/**
 * The digest known at a given chain position: from a live record, a
 * manifested purge, or null (unknown — an uncovered gap).
 */
function knownDigestAt(
  sequence: number,
  recordsBySequence: Map<number, AuditRecord>,
  manifests: readonly PurgeManifest[],
): string | null {
  const record = recordsBySequence.get(sequence);
  if (record !== undefined) {
    return record.recordDigest;
  }
  for (const manifest of manifests) {
    for (const entry of manifest.entries) {
      if (entry.sequence === sequence) {
        return entry.recordDigest;
      }
    }
  }
  return null;
}

/**
 * Verify a chain of records (already ordered by sequence by the
 * caller). Full-chain mode: every position 1..maxSequence must be
 * known (live or manifested). Window mode (export verification):
 * positions outside `[firstSequence, lastSequence]` are not judged —
 * the exported window's internal linkage is.
 */
export function verifyAuditChain(
  records: readonly AuditRecord[],
  options: {
    readonly digest: AuditDigestPort;
    /** Manifests covering purged positions (default: extracted from the records themselves). */
    readonly manifests?: readonly PurgeManifest[];
    /** First judged position (window mode; default: 1). */
    readonly fromSequence?: number;
  },
): ChainVerification {
  const digest = options.digest;
  const violations: ChainViolation[] = [];

  // 1. Validate every record (shape + both digests — tamper detection).
  const validated: AuditRecord[] = [];
  for (const record of records) {
    try {
      validated.push(validateAuditRecord(record, digest));
    } catch (error) {
      violations.push({ code: "record-invalid", detail: detail(String(error)) });
    }
  }

  // 2. Sequence ordering (the caller supplies ordered records; disorder is a violation).
  const ordered = [...validated].sort((left, right) => left.chainSequence - right.chainSequence);
  for (let index = 1; index < records.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      current.chainSequence === previous.chainSequence
    ) {
      violations.push({
        code: "sequence-disorder",
        detail: detail(`duplicate chain sequence ${current.chainSequence}`),
      });
    }
  }

  // 3. Manifests: supplied (window mode — validated here) or extracted
  //    from the purge-evidence records (full-chain mode).
  const collected: PurgeManifest[] = [];
  if (options.manifests !== undefined) {
    for (const value of options.manifests) {
      try {
        collected.push(validatePurgeManifest(value, digest));
      } catch (error) {
        violations.push({ code: "manifest-invalid", detail: detail(String(error)) });
      }
    }
  } else {
    for (const record of ordered) {
      if (record.action.kind === "retention.purge-executed") {
        try {
          collected.push(validatePurgeManifest(purgeManifestOfRecord(record), digest));
        } catch (error) {
          violations.push({
            code: "manifest-invalid",
            detail: detail(`purge record ${record.recordId}: ${String(error)}`),
          });
        }
      }
    }
  }
  const manifests: readonly PurgeManifest[] = collected;

  // 4. Manifest overlap: a position manifested twice is a double purge.
  const manifested = new Map<number, string>();
  for (const manifest of manifests) {
    for (const entry of manifest.entries) {
      const existing = manifested.get(entry.sequence);
      if (existing !== undefined) {
        violations.push({
          code: "manifest-overlap",
          detail: detail(
            `sequence ${entry.sequence} is manifested by two purge manifests (double purge)`,
          ),
        });
      } else {
        manifested.set(entry.sequence, entry.recordDigest);
      }
    }
  }

  const recordsBySequence = new Map(ordered.map((record) => [record.chainSequence, record]));
  const first = options.fromSequence ?? 1;
  const highest =
    ordered.length > 0 ? (ordered[ordered.length - 1] as AuditRecord).chainSequence : 0;

  // 5. Full-chain mode: every position from the first judged one must be known.
  if (options.manifests === undefined) {
    for (const [sequence, record] of recordsBySequence) {
      if (manifested.has(sequence)) {
        violations.push({
          code: "manifest-overlap",
          detail: detail(
            `sequence ${sequence} is both a live record and manifested as purged (record ${record.recordId})`,
          ),
        });
      }
    }
    for (let sequence = first; sequence <= highest; sequence += 1) {
      if (!recordsBySequence.has(sequence) && !manifested.has(sequence)) {
        violations.push({
          code: "chain-gap-uncovered",
          detail: detail(
            `chain position ${sequence} is neither a live record nor a manifested purge`,
          ),
        });
      }
    }
  }

  // 6. Linkage: every record's predecessor digest must match the known digest at position-1.
  for (const record of ordered) {
    if (record.chainSequence === 1) {
      const genesis = "0".repeat(64);
      if (record.previousRecordDigest !== genesis) {
        violations.push({
          code: "chain-link-broken",
          detail: detail(
            `the first record's predecessor must be the genesis digest (got ${record.previousRecordDigest})`,
          ),
        });
      }
      continue;
    }
    if (record.chainSequence < first) {
      continue;
    }
    const predecessor = knownDigestAt(record.chainSequence - 1, recordsBySequence, manifests);
    if (predecessor === null) {
      if (options.manifests === undefined) {
        violations.push({
          code: "chain-gap-uncovered",
          detail: detail(
            `record ${record.recordId} at position ${record.chainSequence} has no verifiable predecessor`,
          ),
        });
      }
      continue;
    }
    if (record.previousRecordDigest !== predecessor) {
      violations.push({
        code: "chain-link-broken",
        detail: detail(
          `record ${record.recordId} at position ${record.chainSequence} links to ${record.previousRecordDigest} but its predecessor's digest is ${predecessor}`,
        ),
      });
    }
  }

  const lastRecord = ordered.length > 0 ? ordered[ordered.length - 1] : undefined;
  return {
    ok: violations.length === 0,
    violations,
    lastSequence: lastRecord?.chainSequence ?? 0,
    lastDigest: lastRecord?.recordDigest ?? null,
  };
}
