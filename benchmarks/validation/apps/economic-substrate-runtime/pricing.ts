/**
 * The pinned SUBSTRATE price manifest (VAL-046, acceptance criterion 2).
 *
 * The substrate-economics lab's content-addressed, APPEND-ONLY registry
 * of pinned compute-substrate list-price tables — the substrate-side
 * twin of the VAL-040 model-price manifest, with exactly the same
 * discipline:
 *
 *   * every entry is a PUBLIC LIST PRICE snapshot (negotiated, bulk
 *     and undocumented pricing is FORBIDDEN — the validator rejects
 *     any other source mechanically);
 *   * the manifest is CONTENT-ADDRESSED: each revision's digest is the
 *     SHA-256 over the canonical JSON of its price tables, so any
 *     mutation of a pinned substrate price (a "price correction"
 *     applied in place) breaks digest agreement with the declared
 *     revision — the manifest-integrity catch;
 *   * the manifest is APPEND-ONLY: a price correction is a NEW
 *     revision (`supersedes` the old one, which stays readable for
 *     historical reproducibility) — never an edit of a past revision;
 *   * prices are NEVER copied inline into rows or window declarations —
 *     windows declare WHICH revision priced their lifecycle
 *     (`priceRevision`), and the substrate pricing oracle resolves
 *     prices through the registry only;
 *   * CURRENCY CONVERSION rides the VAL-040 pinned FX table (the
 *     manifest declares its `fxBasis` — a VAL-040 revision identity
 *     whose own manifest integrity is verified through the IMPORTED
 *     VAL-040 derivation; a currency outside that pinned table FAILS
 *     to normalize — never an ad-hoc spot rate).
 *
 * The metering discipline (the reserved/measured separation's pricing
 * basis): every fleet prices USAGE per compute-second (measured — the
 * seconds the substrate actually executed work), and a fleet MAY also
 * price a STANDING RESERVATION per reserved interval (billed by the
 * ceil-to-interval count regardless of use — the warm-pool/standing
 * capacity a window holds while it stays alive). The two price DIFFERENT
 * things (usage vs standing capacity); conflating them is the
 * reserved/measured conflation the separation oracle catches.
 *
 * Everything here is PURE (node:crypto digest over canonical JSON,
 * mirroring the VAL-040 pinning discipline).
 */

import { createHash } from "node:crypto";
import {
  deriveManifestIntegrity,
  type FxRateEntry,
  manifestRevisionOf,
  type PriceCurrency,
  type PriceManifestRevision,
  parseDecimal,
} from "../economic-baseline/pricing";

// ---------------------------------------------------------------------------
// The substrate price vocabulary
// ---------------------------------------------------------------------------

/** The priced dimension of one substrate price entry. */
export type SubstratePriceTier = "usage" | "reservation";

/** How the priced dimension is metered. */
export type SubstrateMetering = "measured-per-second" | "reserved-per-interval";

/** The unit a substrate list price is denominated in. */
export type SubstrateUnit = "per-compute-second" | "per-reserved-interval";

/** One pinned public list-price entry for a compute-substrate fleet. */
export interface SubstratePriceEntry {
  /** The substrate fleet the price applies to (e.g. "warm-fleet-a"). */
  readonly fleet: string;
  /** The priced dimension: usage (per compute-second) or reservation (per interval). */
  readonly tier: SubstratePriceTier;
  /** The currency the list price is denominated in. */
  readonly currency: PriceCurrency;
  /** The unit the list price is denominated in. */
  readonly unit: SubstrateUnit;
  /**
   * The public list price as a decimal string (e.g. "0.000061" for
   * $0.000061 per compute-second). Decimal strings, never floats — the
   * pricing computes exact integer micro-USD.
   */
  readonly price: string;
  /** How the dimension is metered. */
  readonly metering: SubstrateMetering;
  /** The reservation interval in seconds (required iff the tier is reservation). */
  readonly reservationIntervalSeconds?: number;
  /** The pricing source — PUBLIC LIST PRICES ONLY. */
  readonly source: "public-list";
  /** The pinned source reference (the fleet's public pricing page snapshot). */
  readonly sourceRef: string;
}

/** One immutable, content-addressed substrate manifest revision. */
export interface SubstratePriceManifestRevision {
  /** The revision identity (append-only, e.g. "sub-rev-001"). */
  readonly revision: string;
  /** The pinned public list-price tables. */
  readonly tables: readonly SubstratePriceEntry[];
  /**
   * The VAL-040 manifest revision whose pinned FX table converts the
   * entries' currencies (the pinned conversion basis — never ad-hoc).
   */
  readonly fxBasis: string;
  /** The content digest: sha256 over the canonical tables. */
  readonly digest: string;
  /** The revision this one corrects (absent on the first revision). */
  readonly supersedes?: string;
}

// ---------------------------------------------------------------------------
// Content addressing (canonical JSON, sorted keys, no whitespace)
// ---------------------------------------------------------------------------

/** Canonical JSON: sorted keys, no insignificant whitespace. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/** Compute the content digest over the price tables (in declared order). */
export function computeSubstrateManifestDigest(tables: readonly SubstratePriceEntry[]): string {
  return `sha256:${createHash("sha256").update(canonicalJson({ tables })).digest("hex")}`;
}

// ---------------------------------------------------------------------------
// The pinned tables (the lab's declared substrate pricing snapshots)
// ---------------------------------------------------------------------------

/**
 * The sub-rev-001 pinned public list-price tables: the substrate
 * fleets' pricing personas —
 *   * warm-fleet-a (USD, measured per compute-second): the warm
 *     sandbox fleet — fast warm-up, per-second usage pricing;
 *   * cold-fleet-b (USD, measured per compute-second): the spot cold
 *     fleet — cheaper per second, materially slower warm-up (the
 *     startup-cost contrast the readiness families expose);
 *   * reserved-fleet-c (USD, measured usage + a per-interval STANDING
 *     RESERVATION @60s): the reserved-capacity fleet — the
 *     reserved/measured separation's pricing surface;
 *   * eu-warm-fleet-d (EUR, measured per compute-second): the
 *     mixed-currency fleet — converts through the VAL-040 pinned FX
 *     table, never an ad-hoc rate.
 */
const SUBSTRATE_TABLES_REV_001: readonly SubstratePriceEntry[] = [
  {
    fleet: "warm-fleet-a",
    tier: "usage",
    currency: "USD",
    unit: "per-compute-second",
    price: "0.000061",
    metering: "measured-per-second",
    source: "public-list",
    sourceRef: "pinned public warm-sandbox-fleet list-price snapshot (economics-lab persona)",
  },
  {
    fleet: "cold-fleet-b",
    tier: "usage",
    currency: "USD",
    unit: "per-compute-second",
    price: "0.000021",
    metering: "measured-per-second",
    source: "public-list",
    sourceRef: "pinned public spot cold-capacity list-price snapshot (economics-lab persona)",
  },
  {
    fleet: "reserved-fleet-c",
    tier: "usage",
    currency: "USD",
    unit: "per-compute-second",
    price: "0.000038",
    metering: "measured-per-second",
    source: "public-list",
    sourceRef: "pinned public reserved-fleet usage list-price snapshot (economics-lab persona)",
  },
  {
    fleet: "reserved-fleet-c",
    tier: "reservation",
    currency: "USD",
    unit: "per-reserved-interval",
    price: "0.0019",
    metering: "reserved-per-interval",
    reservationIntervalSeconds: 60,
    source: "public-list",
    sourceRef:
      "pinned public reserved-fleet standing-capacity list-price snapshot (economics-lab persona)",
  },
  {
    fleet: "eu-warm-fleet-d",
    tier: "usage",
    currency: "EUR",
    unit: "per-compute-second",
    price: "0.000055",
    metering: "measured-per-second",
    source: "public-list",
    sourceRef: "pinned public EU warm-fleet list-price snapshot (economics-lab persona)",
  },
];

/**
 * The sub-rev-002 tables: a PRICE CORRECTION of the warm-fleet-a usage
 * price (the pinned snapshot was corrected by the fleet's public
 * pricing page). A correction is a NEW revision — sub-rev-001 stays
 * readable and its digest stays frozen (append-only).
 */
const SUBSTRATE_TABLES_REV_002: readonly SubstratePriceEntry[] = SUBSTRATE_TABLES_REV_001.map(
  (entry) =>
    entry.fleet === "warm-fleet-a" && entry.tier === "usage"
      ? { ...entry, price: "0.000058" }
      : entry,
);

/** The pinned substrate manifest registry (append-only, in revision order). */
export const SUBSTRATE_PRICE_MANIFEST: readonly SubstratePriceManifestRevision[] = [
  {
    revision: "sub-rev-001",
    tables: SUBSTRATE_TABLES_REV_001,
    fxBasis: "rev-001",
    digest: computeSubstrateManifestDigest(SUBSTRATE_TABLES_REV_001),
  },
  {
    revision: "sub-rev-002",
    tables: SUBSTRATE_TABLES_REV_002,
    fxBasis: "rev-001",
    digest: computeSubstrateManifestDigest(SUBSTRATE_TABLES_REV_002),
    supersedes: "sub-rev-001",
  },
];

/** Look up one pinned substrate manifest revision by identity. */
export function substrateManifestRevisionOf(
  revision: string,
): SubstratePriceManifestRevision | null {
  return SUBSTRATE_PRICE_MANIFEST.find((candidate) => candidate.revision === revision) ?? null;
}

// ---------------------------------------------------------------------------
// Price-table validation (public list prices ONLY)
// ---------------------------------------------------------------------------

/** One substrate price-table violation. */
export interface SubstratePriceViolation {
  readonly path: string;
  readonly reason: string;
}

/** Validate one pinned substrate price entry (PURE). */
export function validateSubstratePriceEntry(
  entry: SubstratePriceEntry,
): readonly SubstratePriceViolation[] {
  const violations: SubstratePriceViolation[] = [];
  const path = `${entry.fleet}/${entry.tier}`;
  if (entry.source !== "public-list") {
    violations.push({
      path: `${path}.source`,
      reason: `negotiated/bulk/undocumented pricing is FORBIDDEN (observed "${entry.source}")`,
    });
  }
  if (typeof entry.sourceRef !== "string" || entry.sourceRef.length === 0) {
    violations.push({
      path: `${path}.sourceRef`,
      reason: "the pricing source reference is required",
    });
  }
  const parsed = parseDecimal(entry.price);
  if (parsed === null || parsed.digits <= 0n) {
    violations.push({
      path: `${path}.price`,
      reason: `the list price must be a positive decimal string (observed "${entry.price}")`,
    });
  }
  if (entry.tier === "usage") {
    if (entry.unit !== "per-compute-second" || entry.metering !== "measured-per-second") {
      violations.push({
        path: `${path}.metering`,
        reason: "the usage tier must be metered per compute-second (measured)",
      });
    }
    if (entry.reservationIntervalSeconds !== undefined) {
      violations.push({
        path: `${path}.reservationIntervalSeconds`,
        reason: "measured usage pricing must not declare a reservation interval",
      });
    }
  } else {
    if (entry.unit !== "per-reserved-interval" || entry.metering !== "reserved-per-interval") {
      violations.push({
        path: `${path}.metering`,
        reason: "the reservation tier must be metered per reserved interval",
      });
    }
    if (
      !Number.isInteger(entry.reservationIntervalSeconds) ||
      (entry.reservationIntervalSeconds ?? 0) <= 0
    ) {
      violations.push({
        path: `${path}.reservationIntervalSeconds`,
        reason: "reserved-per-interval pricing requires a positive integer interval (seconds)",
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Manifest integrity (the declared-revision ↔ table digest agreement)
// ---------------------------------------------------------------------------

/** The substrate manifest-integrity verdict. */
export interface SubstrateManifestIntegrityVerdict {
  /** The declared revision exists in the substrate registry. */
  readonly declaredRevisionKnown: boolean;
  /** The recomputed digest over the pinned tables agrees with the registry's. */
  readonly digestAgrees: boolean;
  /** Every pinned table entry is a valid public list price. */
  readonly tablesValid: boolean;
  /** The FX basis is a VAL-040 revision with manifest integrity + every currency pinned in it. */
  readonly fxValid: boolean;
  readonly agreed: boolean;
  readonly evidence: readonly string[];
}

/**
 * Derive the substrate manifest integrity of one declared revision
 * (PURE — the substrate-side manifest-integrity oracle): the declared
 * revision must exist in the pinned registry, the recomputed content
 * digest over its tables must AGREE with the registry's recorded
 * digest (an in-place price mutation breaks agreement — mechanically),
 * every table entry must be a valid public list price, and the FX
 * basis must be a VAL-040 revision that passes the IMPORTED VAL-040
 * manifest-integrity derivation with every entry currency resolvable
 * through its pinned FX table.
 */
export function deriveSubstrateManifestIntegrity(declared: {
  readonly revision: string;
  /** A digest declared elsewhere (a pinned window's recorded digest of the revision) — must agree too. */
  readonly declaredDigest?: string;
}): SubstrateManifestIntegrityVerdict {
  const revision = substrateManifestRevisionOf(declared.revision);
  if (revision === null) {
    return {
      declaredRevisionKnown: false,
      digestAgrees: false,
      tablesValid: false,
      fxValid: false,
      agreed: false,
      evidence: [
        `revision:${declared.revision}`,
        "known:NO (the declared substrate price revision is not pinned in the manifest registry)",
      ],
    };
  }
  const recomputed = computeSubstrateManifestDigest(revision.tables);
  const digestAgrees =
    recomputed === revision.digest &&
    (declared.declaredDigest === undefined || declared.declaredDigest === revision.digest);
  const tableViolations = revision.tables.flatMap((entry) => validateSubstratePriceEntry(entry));
  const fxBasis = manifestRevisionOf(revision.fxBasis);
  const fxBasisAgreed =
    fxBasis === null ? false : deriveManifestIntegrity({ revision: revision.fxBasis }).agreed;
  const currencies = new Set(revision.tables.map((entry) => entry.currency));
  const everyCurrencyPinned =
    fxBasis !== null &&
    [...currencies].every((currency) => fxBasis.fx.some((rate) => rate.currency === currency));
  const fxValid = fxBasisAgreed && everyCurrencyPinned;
  return {
    declaredRevisionKnown: true,
    digestAgrees,
    tablesValid: tableViolations.length === 0,
    fxValid,
    agreed: digestAgrees && tableViolations.length === 0 && fxValid,
    evidence: [
      `revision:${revision.revision}`,
      `digest:${revision.digest}`,
      `recomputed:${recomputed}`,
      ...(declared.declaredDigest === undefined
        ? []
        : [`declaredDigest:${declared.declaredDigest}`]),
      digestAgrees
        ? "digest:AGREED (the pinned substrate tables are exactly the declared revision's)"
        : "digest:DISAGREED (a pinned substrate price was mutated in place — a correction must be a NEW revision)",
      `tableViolations:${tableViolations.length}`,
      `fxBasis:${revision.fxBasis} (${fxBasisAgreed ? "VAL-040 integrity-agreed" : "VAL-040 integrity-FAILED"})`,
      `currencies:${[...currencies].join("+")} (${everyCurrencyPinned ? "all pinned in the FX table" : "OUTSIDE the pinned FX table"})`,
      `supersedes:${revision.supersedes ?? "none"}`,
    ],
  };
}

/**
 * Derive the substrate manifest's append-only discipline (PURE): every
 * revision identity is unique, and no revision's recorded digest
 * disagrees with its own tables.
 */
export function deriveSubstrateManifestAppendOnly(): {
  readonly appendOnly: boolean;
  readonly revisions: readonly string[];
  readonly evidence: readonly string[];
} {
  const revisions = SUBSTRATE_PRICE_MANIFEST.map((revision) => revision.revision);
  const unique = new Set(revisions).size === revisions.length;
  const everyDigestAgrees = SUBSTRATE_PRICE_MANIFEST.every(
    (revision) => computeSubstrateManifestDigest(revision.tables) === revision.digest,
  );
  return {
    appendOnly: unique && everyDigestAgrees,
    revisions,
    evidence: [
      `revisions:${revisions.join(" -> ")}`,
      `uniqueIdentities:${String(unique)}`,
      `everyDigestAgrees:${String(everyDigestAgrees)}`,
      "correctionsAreNewRevisions (sub-rev-002 supersedes sub-rev-001; sub-rev-001 stays frozen and readable)",
    ],
  };
}

// ---------------------------------------------------------------------------
// Price resolution + exact micro-USD pricing (BigInt rationals)
// ---------------------------------------------------------------------------

/** Resolve the pinned price entry for one fleet/tier within a revision. */
export function resolveSubstratePrice(
  manifest: SubstratePriceManifestRevision,
  fleet: string,
  tier: SubstratePriceTier,
): SubstratePriceEntry | null {
  return manifest.tables.find((entry) => entry.fleet === fleet && entry.tier === tier) ?? null;
}

/**
 * Resolve the pinned FX rate for one currency through the manifest's
 * FX BASIS (the VAL-040 pinned table — never an ad-hoc rate; a
 * currency outside the pinned table returns null and FAILS to
 * normalize).
 */
export function fxRateForSubstrate(
  manifest: SubstratePriceManifestRevision,
  currency: PriceCurrency,
): FxRateEntry | null {
  const basis = manifestRevisionOf(manifest.fxBasis);
  if (basis === null) {
    return null;
  }
  return basis.fx.find((rate) => rate.currency === currency) ?? null;
}

/** Divide a BigInt rational, rounding half-up (deterministic). */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error("substrate pricing denominator must be positive");
  }
  if (numerator >= 0n) {
    return (numerator * 2n + denominator) / (denominator * 2n);
  }
  return -((-numerator * 2n + denominator) / (denominator * 2n));
}

/**
 * Price a measured duration onto the canonical micro-USD basis (PURE):
 * microUsd = (ms / 1000) × price × fxRate — exact BigInt rational, one
 * deterministic half-up rounding.
 */
export function priceMeasuredMs(input: {
  readonly milliseconds: number;
  /** The pinned usage-price entry (its currency + decimal price). */
  readonly entry: SubstratePriceEntry;
  readonly fx: FxRateEntry;
}): bigint {
  const price = parseDecimal(input.entry.price);
  const rate = parseDecimal(input.fx.microUsdPerUnit);
  if (price === null || rate === null) {
    throw new Error("the pinned substrate price or FX rate failed to parse as a decimal");
  }
  if (!Number.isInteger(input.milliseconds) || input.milliseconds < 0) {
    throw new Error(
      `the measured duration must be a non-negative integer of ms (observed ${input.milliseconds})`,
    );
  }
  return divRoundHalfUp(
    BigInt(input.milliseconds) * price.digits * rate.digits,
    1000n * 10n ** BigInt(price.scale) * 10n ** BigInt(rate.scale),
  );
}

/**
 * Price a standing reservation onto the canonical micro-USD basis
 * (PURE): the held milliseconds round UP to whole reserved intervals
 * (ceil-to-interval — the reserved metering semantics), then each
 * interval bills at the pinned per-interval list price (exact BigInt
 * rational, one deterministic half-up rounding per interval).
 */
export function priceReservedMs(input: {
  readonly milliseconds: number;
  /** The pinned reservation-price entry (its currency + interval + decimal price). */
  readonly entry: SubstratePriceEntry;
  readonly fx: FxRateEntry;
}): bigint {
  const price = parseDecimal(input.entry.price);
  const rate = parseDecimal(input.fx.microUsdPerUnit);
  if (price === null || rate === null) {
    throw new Error("the pinned substrate price or FX rate failed to parse as a decimal");
  }
  const intervalSeconds = input.entry.reservationIntervalSeconds;
  if (
    typeof intervalSeconds !== "number" ||
    !Number.isInteger(intervalSeconds) ||
    intervalSeconds <= 0
  ) {
    throw new Error("the reservation price entry must declare a positive interval");
  }
  if (!Number.isInteger(input.milliseconds) || input.milliseconds < 0) {
    throw new Error(
      `the standing reservation must be a non-negative integer of ms (observed ${input.milliseconds})`,
    );
  }
  const intervalMs = BigInt(intervalSeconds) * 1000n;
  const intervals = (BigInt(input.milliseconds) + intervalMs - 1n) / intervalMs;
  const perInterval = divRoundHalfUp(
    price.digits * rate.digits,
    10n ** BigInt(price.scale) * 10n ** BigInt(rate.scale),
  );
  return perInterval * intervals;
}

/**
 * The manifest of a declared substrate revision (the pricing oracle's
 * resolution — throws when the revision is unknown, since a run
 * against an unpinned revision has no basis at all).
 */
export function substrateManifestFor(revision: string): SubstratePriceManifestRevision {
  const manifest = substrateManifestRevisionOf(revision);
  if (manifest === null) {
    throw new Error(
      `the declared substrate price revision ${revision} is not pinned in the manifest`,
    );
  }
  return manifest;
}

/** Re-export the VAL-040 manifest revision type (the FX basis resolution). */
export type { PriceManifestRevision };
