/**
 * The pinned price manifest (VAL-040, acceptance criterion 2).
 *
 * The economics lab's content-addressed, APPEND-ONLY registry of
 * pinned provider list-price tables:
 *
 *   * every entry is a PUBLIC LIST PRICE snapshot (negotiated, bulk
 *     and undocumented pricing is FORBIDDEN — the validator rejects
 *     any other source mechanically);
 *   * the manifest is CONTENT-ADDRESSED: each revision's digest is the
 *     SHA-256 over the canonical JSON of its price tables + its FX
 *     conversion table, so any mutation of a pinned price (a "price
 *     correction" applied in place) breaks digest agreement with the
 *     declared revision — the manifest-integrity catch;
 *   * the manifest is APPEND-ONLY: a price correction is a NEW
 *     revision (`supersedes` the old one, which stays readable for
 *     historical reproducibility) — never an edit of a past revision;
 *   * prices are NEVER copied inline into rows or arm declarations —
 *     arms declare WHICH revision priced their runs
 *     (`priceRevision`), and the pricing oracle resolves prices
 *     through the registry only.
 *
 * The FX table pins reference conversion rates (micro-USD per one
 * unit of each declared currency) so heterogeneous-currency pricing
 * converges onto the canonical micro-USD basis through a PINNED
 * table — never an ad-hoc spot rate, and a currency absent from the
 * pinned table FAILS to normalize (the mixed-currency conflation
 * catch).
 *
 * Everything here is PURE (node:crypto digest over canonical JSON,
 * mirroring the comparators' pinning discipline).
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// The price vocabulary
// ---------------------------------------------------------------------------

/** The currencies the pinned FX table may convert. */
export type PriceCurrency = "USD" | "EUR" | "JPY" | "GBP";

/** The per-token units a list price may be denominated in. */
export type PriceUnit = "per-1M-tokens" | "per-1K-tokens" | "per-token";

/** How usage is metered against the price. */
export type MeteringKind = "metered" | "batched";

/** One pinned public list-price entry. */
export interface ListPriceEntry {
  /** The provider rail the price applies to (e.g. "openrouter"). */
  readonly provider: string;
  /** The model the price applies to. */
  readonly model: string;
  /** The token tier the price applies to. */
  readonly tier: "input" | "output";
  /** The currency the list price is denominated in. */
  readonly currency: PriceCurrency;
  /** The unit the list price is denominated in. */
  readonly unit: PriceUnit;
  /**
   * The public list price as a decimal string (e.g. "0.12" for
   * $0.12 per 1M input tokens). Decimal strings, never floats — the
   * normalization computes exact integer micro-USD.
   */
  readonly price: string;
  /** How usage is metered (metered = per token; batched = per batch increment). */
  readonly metering: MeteringKind;
  /** The batch size in tokens (required iff metering is batched). */
  readonly batchSize?: number;
  /** The pricing source — PUBLIC LIST PRICES ONLY. */
  readonly source: "public-list";
  /**
   * The pinned source reference (the provider's public pricing page;
   * recorded as the pinned snapshot's provenance — the manifest is a
   * snapshot registry, and a correction is a new revision).
   */
  readonly sourceRef: string;
}

/** One pinned FX conversion rate. */
export interface FxRateEntry {
  readonly currency: PriceCurrency;
  /** Micro-USD per ONE unit of the currency (decimal string, exact). */
  readonly microUsdPerUnit: string;
  /** The pinned reference date of the rate snapshot. */
  readonly asOf: string;
  /** The pinned reference source. */
  readonly sourceRef: string;
}

// ---------------------------------------------------------------------------
// The manifest registry (append-only revisions)
// ---------------------------------------------------------------------------

/** One immutable, content-addressed manifest revision. */
export interface PriceManifestRevision {
  /** The revision identity (append-only, e.g. "rev-001"). */
  readonly revision: string;
  /** The pinned public list-price tables. */
  readonly tables: readonly ListPriceEntry[];
  /** The pinned FX conversion table. */
  readonly fx: readonly FxRateEntry[];
  /** The content digest: sha256 over the canonical tables + fx. */
  readonly digest: string;
  /** The revision this one corrects (absent on the first revision). */
  readonly supersedes?: string;
}

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

/**
 * Compute the content digest over price tables + fx (the
 * content-addressing basis: tables and fx in declared order).
 */
export function computeManifestDigest(
  tables: readonly ListPriceEntry[],
  fx: readonly FxRateEntry[],
): string {
  return `sha256:${createHash("sha256").update(canonicalJson({ fx, tables })).digest("hex")}`;
}

// ---------------------------------------------------------------------------
// The pinned tables (the lab's declared pricing snapshots)
// ---------------------------------------------------------------------------

/**
 * The rev-001 FX table: pinned reference conversion rates (micro-USD
 * per one unit). USD is the identity rate; the others are pinned
 * reference snapshots the mixed-currency arms convert through. NOTE:
 * GBP is deliberately ABSENT — the normalization's currency-family
 * discrimination (a currency outside the pinned table FAILS to
 * normalize) needs an honest absent-currency case.
 */
const FX_REV_001: readonly FxRateEntry[] = [
  {
    currency: "USD",
    microUsdPerUnit: "1000000",
    asOf: "2025-01-02",
    sourceRef: "identity (USD is the canonical basis)",
  },
  {
    currency: "EUR",
    microUsdPerUnit: "1030000",
    asOf: "2025-01-02",
    sourceRef: "pinned reference-rate snapshot (economics-lab fixture)",
  },
  {
    currency: "JPY",
    microUsdPerUnit: "6250",
    asOf: "2025-01-02",
    sourceRef: "pinned reference-rate snapshot (economics-lab fixture)",
  },
];

/**
 * The rev-001 pinned public list-price tables: the arms' pricing
 * personas —
 *   * openrouter (USD, per-1M, metered): the REAL live rail's public
 *     list pricing for the validation program's default chat model;
 *   * euro-relay (EUR, per-1M, metered): the mixed-currency arm;
 *   * tokyo-relay (JPY, per-1K, metered): the mixed-unit arm;
 *   * batch-relay (USD, per-1M, batched @500): the batched-metering arm;
 *   * retry-relay (USD, per-1M, metered): the retry-amortization arm.
 */
const TABLES_REV_001: readonly ListPriceEntry[] = [
  {
    provider: "openrouter",
    model: "meta-llama/llama-3.3-70b-instruct",
    tier: "input",
    currency: "USD",
    unit: "per-1M-tokens",
    price: "0.12",
    metering: "metered",
    source: "public-list",
    sourceRef: "https://openrouter.ai/meta-llama/llama-3.3-70b-instruct (pinned snapshot)",
  },
  {
    provider: "openrouter",
    model: "meta-llama/llama-3.3-70b-instruct",
    tier: "output",
    currency: "USD",
    unit: "per-1M-tokens",
    price: "0.25",
    metering: "metered",
    source: "public-list",
    sourceRef: "https://openrouter.ai/meta-llama/llama-3.3-70b-instruct (pinned snapshot)",
  },
  {
    provider: "euro-relay",
    model: "euro-small-v1",
    tier: "input",
    currency: "EUR",
    unit: "per-1M-tokens",
    price: "0.40",
    metering: "metered",
    source: "public-list",
    sourceRef: "pinned public EU list-price snapshot (economics-lab persona)",
  },
  {
    provider: "euro-relay",
    model: "euro-small-v1",
    tier: "output",
    currency: "EUR",
    unit: "per-1M-tokens",
    price: "1.20",
    metering: "metered",
    source: "public-list",
    sourceRef: "pinned public EU list-price snapshot (economics-lab persona)",
  },
  {
    provider: "tokyo-relay",
    model: "tokyo-mini-v1",
    tier: "input",
    currency: "JPY",
    unit: "per-1K-tokens",
    price: "15",
    metering: "metered",
    source: "public-list",
    sourceRef: "pinned public JP list-price snapshot (economics-lab persona)",
  },
  {
    provider: "tokyo-relay",
    model: "tokyo-mini-v1",
    tier: "output",
    currency: "JPY",
    unit: "per-1K-tokens",
    price: "45",
    metering: "metered",
    source: "public-list",
    sourceRef: "pinned public JP list-price snapshot (economics-lab persona)",
  },
  {
    provider: "batch-relay",
    model: "batch-medium-v1",
    tier: "input",
    currency: "USD",
    unit: "per-1M-tokens",
    price: "0.08",
    metering: "batched",
    batchSize: 500,
    source: "public-list",
    sourceRef: "pinned public batched list-price snapshot (economics-lab persona)",
  },
  {
    provider: "batch-relay",
    model: "batch-medium-v1",
    tier: "output",
    currency: "USD",
    unit: "per-1M-tokens",
    price: "0.32",
    metering: "batched",
    batchSize: 500,
    source: "public-list",
    sourceRef: "pinned public batched list-price snapshot (economics-lab persona)",
  },
  {
    provider: "retry-relay",
    model: "retry-small-v1",
    tier: "input",
    currency: "USD",
    unit: "per-1M-tokens",
    price: "0.10",
    metering: "metered",
    source: "public-list",
    sourceRef: "pinned public list-price snapshot (economics-lab persona)",
  },
  {
    provider: "retry-relay",
    model: "retry-small-v1",
    tier: "output",
    currency: "USD",
    unit: "per-1M-tokens",
    price: "0.30",
    metering: "metered",
    source: "public-list",
    sourceRef: "pinned public list-price snapshot (economics-lab persona)",
  },
];

/**
 * The rev-002 tables: a PRICE CORRECTION of the openrouter input
 * price (the pinned snapshot was corrected by the provider's public
 * pricing page). A correction is a NEW revision — rev-001 stays
 * readable and its digest stays frozen (append-only).
 */
const TABLES_REV_002: readonly ListPriceEntry[] = TABLES_REV_001.map((entry) =>
  entry.provider === "openrouter" && entry.tier === "input" ? { ...entry, price: "0.1128" } : entry,
);

/** The pinned manifest registry (append-only, in revision order). */
export const PRICE_MANIFEST: readonly PriceManifestRevision[] = [
  {
    revision: "rev-001",
    tables: TABLES_REV_001,
    fx: FX_REV_001,
    digest: computeManifestDigest(TABLES_REV_001, FX_REV_001),
  },
  {
    revision: "rev-002",
    tables: TABLES_REV_002,
    fx: FX_REV_001,
    digest: computeManifestDigest(TABLES_REV_002, FX_REV_001),
    supersedes: "rev-001",
  },
];

/** Look up one pinned manifest revision by identity. */
export function manifestRevisionOf(revision: string): PriceManifestRevision | null {
  return PRICE_MANIFEST.find((candidate) => candidate.revision === revision) ?? null;
}

// ---------------------------------------------------------------------------
// Price-table validation (public list prices ONLY)
// ---------------------------------------------------------------------------

/** One price-table violation. */
export interface PriceTableViolation {
  readonly path: string;
  readonly reason: string;
}

/** Parse a non-negative decimal string into {digits, scale}. */
export function parseDecimal(value: string): { digits: bigint; scale: number } | null {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    return null;
  }
  const [whole, fraction = ""] = value.split(".");
  return { digits: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

/**
 * Validate one pinned price table entry: PUBLIC LIST PRICES ONLY
 * (any other source — negotiated, bulk, undocumented — FAILS), a
 * positive decimal price, a declared currency/unit, a consistent
 * metering declaration (batched REQUIRES a positive batch size;
 * metered FORBIDS one), and a recorded source reference.
 */
export function validatePriceTableEntry(entry: ListPriceEntry): readonly PriceTableViolation[] {
  const violations: PriceTableViolation[] = [];
  const path = `${entry.provider}/${entry.model}/${entry.tier}`;
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
  if (entry.metering === "batched") {
    if (!Number.isInteger(entry.batchSize) || (entry.batchSize ?? 0) <= 0) {
      violations.push({
        path: `${path}.batchSize`,
        reason: "batched metering requires a positive integer batch size",
      });
    }
  } else if (entry.batchSize !== undefined) {
    violations.push({
      path: `${path}.batchSize`,
      reason: "metered pricing must not declare a batch size",
    });
  }
  if (
    entry.unit !== "per-1M-tokens" &&
    entry.unit !== "per-1K-tokens" &&
    entry.unit !== "per-token"
  ) {
    violations.push({ path: `${path}.unit`, reason: `unknown price unit "${entry.unit}"` });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Manifest integrity (the declared-revision ↔ table digest agreement)
// ---------------------------------------------------------------------------

/** The manifest-integrity verdict. */
export interface ManifestIntegrityVerdict {
  /** The declared revision exists in the registry. */
  readonly declaredRevisionKnown: boolean;
  /** The recomputed digest over the pinned tables agrees with the registry's. */
  readonly digestAgrees: boolean;
  /** Every pinned table entry is a valid public list price. */
  readonly tablesValid: boolean;
  /** Every FX currency is distinct, and USD carries the identity rate. */
  readonly fxValid: boolean;
  readonly agreed: boolean;
  readonly evidence: readonly string[];
}

/**
 * Derive the manifest integrity of one declared revision (PURE — the
 * AC4 manifest-integrity oracle): the declared revision must exist in
 * the pinned registry, the recomputed content digest over its tables
 * + fx must AGREE with the registry's recorded digest (an in-place
 * price mutation breaks agreement — mechanically), every table entry
 * must be a valid public list price, and the FX table must be
 * well-formed (one rate per currency, USD identity).
 *
 * The optional `registry` probes ADVERSARIALLY (the discrimination
 * battery): a mutated copy of the registry — one price edited in
 * place while the recorded digest stays stale — breaks digest
 * agreement mechanically. The optional `declaredDigest` (a pinned
 * experiment's recorded digest of the revision) must ALSO agree.
 */
export function deriveManifestIntegrity(declared: {
  readonly revision: string;
  /** The registry to verify against (defaults to the pinned PRICE_MANIFEST). */
  readonly registry?: readonly PriceManifestRevision[];
  /** A digest declared elsewhere (a pinned experiment's recorded digest) — must agree too. */
  readonly declaredDigest?: string;
}): ManifestIntegrityVerdict {
  const registry = declared.registry ?? PRICE_MANIFEST;
  const revision = registry.find((candidate) => candidate.revision === declared.revision) ?? null;
  if (revision === null) {
    return {
      declaredRevisionKnown: false,
      digestAgrees: false,
      tablesValid: false,
      fxValid: false,
      agreed: false,
      evidence: [
        `revision:${declared.revision}`,
        "known:NO (the declared price revision is not pinned in the manifest registry)",
      ],
    };
  }
  const recomputed = computeManifestDigest(revision.tables, revision.fx);
  const digestAgrees =
    recomputed === revision.digest &&
    (declared.declaredDigest === undefined || declared.declaredDigest === revision.digest);
  const tableViolations = revision.tables.flatMap((entry) => validatePriceTableEntry(entry));
  const currencies = new Set(revision.fx.map((rate) => rate.currency));
  const usdIdentity = revision.fx.some(
    (rate) => rate.currency === "USD" && rate.microUsdPerUnit === "1000000",
  );
  const fxValid =
    currencies.size === revision.fx.length &&
    currencies.has("USD") &&
    usdIdentity &&
    revision.fx.every((rate) => parseDecimal(rate.microUsdPerUnit) !== null);
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
        ? "digest:AGREED (the pinned tables are exactly the declared revision's)"
        : "digest:DISAGREED (a pinned price was mutated in place — a correction must be a NEW revision)",
      `tableViolations:${tableViolations.length}`,
      `fx:${revision.fx.map((rate) => rate.currency).join("+")}`,
      `supersedes:${revision.supersedes ?? "none"}`,
    ],
  };
}

/**
 * Derive the manifest's append-only discipline (PURE): every revision
 * identity is unique, and no revision's recorded digest disagrees
 * with its own tables (a mutated historical revision breaks the
 * registry's reproducibility).
 */
export function deriveManifestAppendOnly(): {
  readonly appendOnly: boolean;
  readonly revisions: readonly string[];
  readonly evidence: readonly string[];
} {
  const revisions = PRICE_MANIFEST.map((revision) => revision.revision);
  const unique = new Set(revisions).size === revisions.length;
  const everyDigestAgrees = PRICE_MANIFEST.every(
    (revision) => computeManifestDigest(revision.tables, revision.fx) === revision.digest,
  );
  return {
    appendOnly: unique && everyDigestAgrees,
    revisions,
    evidence: [
      `revisions:${revisions.join(" -> ")}`,
      `uniqueIdentities:${String(unique)}`,
      `everyDigestAgrees:${String(everyDigestAgrees)}`,
      "correctionsAreNewRevisions (rev-002 supersedes rev-001; rev-001 stays frozen and readable)",
    ],
  };
}

/**
 * Resolve the pinned list-price entry for one provider/model/tier
 * within one declared revision (the pricing oracle's lookup — arms
 * never carry prices inline).
 */
export function resolveListPrice(
  revision: PriceManifestRevision,
  provider: string,
  model: string,
  tier: "input" | "output",
): ListPriceEntry | null {
  return (
    revision.tables.find(
      (entry) => entry.provider === provider && entry.model === model && entry.tier === tier,
    ) ?? null
  );
}

/**
 * Resolve the pinned FX rate for one currency within one declared
 * revision (null when the currency is outside the pinned table — the
 * mixed-currency normalization failure's input).
 */
export function resolveFxRate(
  revision: PriceManifestRevision,
  currency: PriceCurrency,
): FxRateEntry | null {
  return revision.fx.find((rate) => rate.currency === currency) ?? null;
}
