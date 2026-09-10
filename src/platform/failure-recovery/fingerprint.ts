/**
 * Environment fingerprinting (platform failure-recovery plane; WORK-055 /
 * E1.1 — "environment fingerprinting to detect drift between the
 * original and resumed environments").
 *
 * THE TYPED IDENTITY of an execution environment: the closed set of
 * entries naming WHAT the work ran on and under — the model routes,
 * the compute substrates, the tools and the configuration digests.
 * The fingerprint is CONTENT-ADDRESSED (`fingerprintId` = sha256 over
 * the canonical entry form), built in a DETERMINISTIC canonical entry
 * order (kind, then the entry's identity key), and totally validated
 * at read time (vocabulary, bounds, identity).
 *
 * DRIFT DETECTION IS FAIL-CLOSED (architecture invariant 4: an
 * environment fingerprint is honest): comparing the original and the
 * resumed environment produces either an exact `match` or a TYPED
 * drift report naming every drifted entry — never a silent
 * application of a continuation built for a different environment
 * (the `continuation.ts` apply path rejects on drift).
 *
 * Pure and deterministic: no clock, no randomness, no ambient state.
 * Entries are neutral vocabulary (opaque route/substrate/tool
 * identifiers — no vendor semantics cross this seam).
 */

import { canonicalJson, isCanonicalizable } from "../execution-ir/canonical";
import type { IrDigestPort } from "../execution-ir/ir";
import { boundedDetail, MAX_FINGERPRINT_ENTRIES, reject, SHA256_HEX_PATTERN } from "./catalog";

// ---------------------------------------------------------------------------
// The closed entry vocabulary
// ---------------------------------------------------------------------------

/** The closed fingerprint-entry kinds (the environment's dimensions). */
export const FINGERPRINT_ENTRY_KINDS = [
  "model-route",
  "substrate",
  "tool",
  "configuration",
] as const;
export type FingerprintEntryKind = (typeof FINGERPRINT_ENTRY_KINDS)[number];

const ROUTE_PART_PATTERN = /^[a-z0-9][a-z0-9._-]{0,199}$/;
const NEUTRAL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const CONFIG_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/** One typed environment entry (tagged union — closed vocabulary). */
export type FingerprintEntry =
  | { readonly kind: "model-route"; readonly provider: string; readonly model: string }
  | { readonly kind: "substrate"; readonly substrateId: string; readonly version: string }
  | { readonly kind: "tool"; readonly toolId: string; readonly version: string }
  | { readonly kind: "configuration"; readonly name: string; readonly digest: string };

/** The environment fingerprint — the typed, content-addressed identity. */
export interface EnvironmentFingerprint {
  /** Content-derived identity: sha256 over the canonical entry form. */
  readonly fingerprintId: string;
  /** The closed, canonically ordered, deduplicated entry set. */
  readonly entries: readonly FingerprintEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The canonical sort key of one entry (kind, then identity). */
function entryKey(entry: FingerprintEntry): string {
  switch (entry.kind) {
    case "model-route":
      return `model-route:${entry.provider}/${entry.model}`;
    case "substrate":
      return `substrate:${entry.substrateId}@${entry.version}`;
    case "tool":
      return `tool:${entry.toolId}@${entry.version}`;
    case "configuration":
      return `configuration:${entry.name}#${entry.digest}`;
  }
}

/** Total, deterministic validation of one entry. */
function validateEntry(value: unknown): FingerprintEntry {
  if (!isRecord(value)) {
    reject("fingerprint-shape", "fingerprint entry must be an object");
  }
  const entry = value;
  switch (entry.kind) {
    case "model-route": {
      if (
        typeof entry.provider !== "string" ||
        !ROUTE_PART_PATTERN.test(entry.provider) ||
        typeof entry.model !== "string" ||
        !ROUTE_PART_PATTERN.test(entry.model)
      ) {
        reject("fingerprint-shape", "model-route entry must carry bounded neutral slugs", {
          got: boundedDetail(JSON.stringify(entry)),
        });
      }
      return { kind: "model-route", provider: entry.provider, model: entry.model };
    }
    case "substrate": {
      if (
        typeof entry.substrateId !== "string" ||
        !NEUTRAL_ID_PATTERN.test(entry.substrateId) ||
        typeof entry.version !== "string" ||
        !NEUTRAL_ID_PATTERN.test(entry.version)
      ) {
        reject("fingerprint-shape", "substrate entry must carry bounded neutral ids", {
          got: boundedDetail(JSON.stringify(entry)),
        });
      }
      return { kind: "substrate", substrateId: entry.substrateId, version: entry.version };
    }
    case "tool": {
      if (
        typeof entry.toolId !== "string" ||
        !NEUTRAL_ID_PATTERN.test(entry.toolId) ||
        typeof entry.version !== "string" ||
        !NEUTRAL_ID_PATTERN.test(entry.version)
      ) {
        reject("fingerprint-shape", "tool entry must carry bounded neutral ids", {
          got: boundedDetail(JSON.stringify(entry)),
        });
      }
      return { kind: "tool", toolId: entry.toolId, version: entry.version };
    }
    case "configuration": {
      if (
        typeof entry.name !== "string" ||
        !CONFIG_NAME_PATTERN.test(entry.name) ||
        typeof entry.digest !== "string" ||
        !SHA256_HEX_PATTERN.test(entry.digest)
      ) {
        reject(
          "fingerprint-shape",
          "configuration entry must carry a bounded name and a sha256 digest",
          {
            got: boundedDetail(JSON.stringify(entry)),
          },
        );
      }
      return { kind: "configuration", name: entry.name, digest: entry.digest };
    }
    default:
      reject("fingerprint-shape", "fingerprint entry kind is outside the closed vocabulary", {
        got: boundedDetail(String(entry.kind)),
      });
  }
}

// ---------------------------------------------------------------------------
// Construction (content-addressed, canonical)
// ---------------------------------------------------------------------------

/**
 * Build the environment fingerprint: validate every entry, deduplicate
 * by canonical key, order canonically (kind, then identity), and derive
 * the content-addressed `fingerprintId`. The same entry set always
 * produces the byte-identical fingerprint (deterministic identity);
 * a set above the hard bound is rejected.
 */
export function fingerprintOf(
  entries: readonly unknown[],
  digest: IrDigestPort,
): EnvironmentFingerprint {
  if (!Array.isArray(entries)) {
    reject("fingerprint-shape", "fingerprint entries must be an array");
  }
  if (entries.length > MAX_FINGERPRINT_ENTRIES) {
    reject(
      "fingerprint-shape",
      `fingerprint exceeds the bound of ${MAX_FINGERPRINT_ENTRIES} entries`,
      {
        got: entries.length,
      },
    );
  }
  const validated = entries.map((entry) => validateEntry(entry));
  const byKey = new Map<string, FingerprintEntry>();
  for (const entry of validated) {
    byKey.set(entryKey(entry), entry);
  }
  const canonicalEntries = [...byKey.keys()]
    .sort()
    .map((key) => byKey.get(key) as FingerprintEntry);
  const form = { entries: canonicalEntries };
  if (!isCanonicalizable(form)) {
    reject("fingerprint-shape", "fingerprint form is not canonicalizable");
  }
  return {
    fingerprintId: digest.sha256Hex(canonicalJson(form)),
    entries: canonicalEntries,
  };
}

// ---------------------------------------------------------------------------
// Total validation of a (deserialized) fingerprint
// ---------------------------------------------------------------------------

/**
 * Total, deterministic validation of an environment-fingerprint value
 * (e.g. after a durable round-trip): every entry re-validated, the
 * canonical order re-derived, and the identity re-computed — a
 * tampered or foreign value is rejected at read time, never served.
 */
export function validateEnvironmentFingerprint(
  value: unknown,
  digest: IrDigestPort,
): EnvironmentFingerprint {
  if (!isRecord(value)) {
    reject("fingerprint-shape", "environment fingerprint must be an object");
  }
  const record = value;
  if (typeof record.fingerprintId !== "string" || !SHA256_HEX_PATTERN.test(record.fingerprintId)) {
    reject("fingerprint-shape", "fingerprintId must be a sha256 hex digest", {
      got: boundedDetail(String(record.fingerprintId)),
    });
  }
  if (!Array.isArray(record.entries) || record.entries.length === 0) {
    reject("fingerprint-shape", "fingerprint entries must be a non-empty array");
  }
  if (record.entries.length > MAX_FINGERPRINT_ENTRIES) {
    reject(
      "fingerprint-shape",
      `fingerprint exceeds the bound of ${MAX_FINGERPRINT_ENTRIES} entries`,
    );
  }
  const rebuilt = fingerprintOf(record.entries, digest);
  if (rebuilt.fingerprintId !== record.fingerprintId) {
    reject("fingerprint-shape", "fingerprint content does not digest to the claimed identity", {
      claimed: record.fingerprintId,
      computed: rebuilt.fingerprintId,
    });
  }
  if (JSON.stringify(rebuilt.entries) !== JSON.stringify(record.entries)) {
    reject("fingerprint-shape", "fingerprint entries are not in the canonical order/shape");
  }
  return rebuilt;
}

// ---------------------------------------------------------------------------
// Drift detection (typed, fail-closed)
// ---------------------------------------------------------------------------

/** One typed drift entry: what changed between two fingerprints. */
export interface FingerprintDrift {
  /** The canonical entry key that drifted. */
  readonly entryKey: string;
  /** The drift shape: changed, only-original, or only-resumed. */
  readonly kind: "changed" | "only-original" | "only-resumed";
  /** The original environment's entry (when present). */
  readonly original?: FingerprintEntry;
  /** The resumed environment's entry (when present). */
  readonly resumed?: FingerprintEntry;
}

/** The typed comparison outcome: exact match or the drift report. */
export type FingerprintComparison =
  | { readonly status: "match" }
  | { readonly status: "drift"; readonly drifted: readonly FingerprintDrift[] };

/**
 * Compare the original and the resumed environments: an exact entry-set
 * match (byte-identical canonical forms) is `match`; ANY difference is
 * a typed drift report naming every drifted entry. The comparison is
 * total and deterministic — and the CONTINUATION apply path is
 * fail-closed on any non-match (a changed environment invalidates a
 * continuation rather than silently applying it).
 */
export function compareFingerprints(
  original: EnvironmentFingerprint,
  resumed: EnvironmentFingerprint,
): FingerprintComparison {
  const originalByKey = new Map(original.entries.map((entry) => [entryKey(entry), entry]));
  const resumedByKey = new Map(resumed.entries.map((entry) => [entryKey(entry), entry]));
  // Same identity → exact match by construction (content addressing).
  if (original.fingerprintId === resumed.fingerprintId) {
    return { status: "match" };
  }
  const drifted: FingerprintDrift[] = [];
  for (const [key, entry] of originalByKey) {
    const other = resumedByKey.get(key);
    if (other === undefined) {
      drifted.push({ entryKey: key, kind: "only-original", original: entry });
    } else if (JSON.stringify(entry) !== JSON.stringify(other)) {
      // Unreachable for well-formed entries (the key covers the full
      // entry content) — kept total for foreign values.
      drifted.push({ entryKey: key, kind: "changed", original: entry, resumed: other });
    }
  }
  for (const [key, entry] of resumedByKey) {
    if (!originalByKey.has(key)) {
      drifted.push({ entryKey: key, kind: "only-resumed", resumed: entry });
    }
  }
  drifted.sort((a, b) => (a.entryKey < b.entryKey ? -1 : a.entryKey > b.entryKey ? 1 : 0));
  if (drifted.length === 0) {
    // Two different identities over identical entries are impossible
    // for validated fingerprints — fail closed rather than guess.
    reject("fingerprint-shape", "distinct fingerprints carry identical entries (identity tamper)");
  }
  return { status: "drift", drifted };
}
