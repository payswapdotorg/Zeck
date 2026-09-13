/**
 * The optimization inventory (VAL-042, acceptance criteria 1, 2 and 4).
 *
 * The STRONG OPTIMIZED NON-ZECK baseline's EXPLICIT, EXHAUSTIVE,
 * content-addressed declaration of every optimization it applies —
 * the best honest engineering a customer could do WITHOUT Zeck:
 *
 *   * explicit MODEL ROUTING BY TASK CLASS (the routing table: each
 *     task class rides its own provider rail, priced through the
 *     pinned VAL-040 manifest);
 *   * PROMPT COMPRESSION (the dispatched payload is a bounded
 *     compression of the raw payload — the ratio is bounded on BOTH
 *     sides: the compression is real, never a token-understatement
 *     masquerade);
 *   * SEMANTICALLY-SAFE RESPONSE CACHING (the cache keys on the
 *     (task class, content digest) identity; a task whose correctness
 *     demands freshness — a `fresh-only` task — is NEVER served from
 *     the cache, mechanically);
 *   * BATCHED THROUGHPUT (adjacent same-class rounds coalesce onto
 *     the batched rail);
 *   * PROVIDER-SIDE OPTIMIZATION FEATURES (the provider-side batched
 *     metering, priced through the manifest's own batched entries).
 *
 * The inventory is the exhaustiveness contract: the
 * inventory-conformance oracle FAILs any run where the baseline
 * applies an optimization the inventory does not name (something the
 * baseline DOES that its inventory does not declare — the
 * undeclared-optimization masquerade catch). The inventory is
 * CONTENT-ADDRESSED alongside the price manifests (the same
 * discipline): each revision's digest is the SHA-256 over the
 * canonical JSON of its entries + routing table, the registry is
 * APPEND-ONLY (a correction is a NEW revision — `supersedes` the old
 * one, which stays frozen and readable), and an in-place mutation
 * breaks digest agreement mechanically (the inventory-integrity
 * catch).
 *
 * Everything here is PURE (node:crypto digest over canonical JSON —
 * mirroring the price manifest's pinning discipline).
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// The optimization vocabulary
// ---------------------------------------------------------------------------

/** The optimization kinds the inventory may declare. */
export type OptimizationKind =
  | "model-routing"
  | "prompt-compression"
  | "response-cache"
  | "batched-throughput"
  | "provider-side-optimization";

/** One named, bounded optimization the optimized baseline may apply. */
export interface OptimizationEntry {
  /** The optimization's NAME (the conformance oracle's key). */
  readonly name: string;
  readonly kind: OptimizationKind;
  /** The bounded parameters (each optimization's declared bounds). */
  readonly bound: Readonly<Record<string, unknown>>;
  readonly description: string;
}

/** One explicit route of the model-routing table. */
export interface ModelRoute {
  /** The task class this route serves (or "fallback"). */
  readonly taskClass: string;
  /** The provider rail the class rides (priced in the pinned manifest). */
  readonly provider: string;
  readonly model: string;
}

/** One immutable, content-addressed inventory revision. */
export interface OptimizationInventoryRevision {
  readonly revision: string;
  readonly entries: readonly OptimizationEntry[];
  /** The model-routing table (the model-routing optimization's bound). */
  readonly routes: readonly ModelRoute[];
  /** The route for classes the table does not name (the conservative default). */
  readonly fallbackRoute: ModelRoute;
  /** The content digest: sha256 over the canonical entries + routes + fallback. */
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

/** Compute the content digest over entries + routes + fallbackRoute. */
export function computeInventoryDigest(input: {
  readonly entries: readonly OptimizationEntry[];
  readonly routes: readonly ModelRoute[];
  readonly fallbackRoute: ModelRoute;
}): string {
  return `sha256:${createHash("sha256")
    .update(
      canonicalJson({
        entries: input.entries,
        fallbackRoute: input.fallbackRoute,
        routes: input.routes,
      }),
    )
    .digest("hex")}`;
}

// ---------------------------------------------------------------------------
// The optimization names (the conformance oracle's key vocabulary)
// ---------------------------------------------------------------------------

/** The model-routing optimization's name. */
export const MODEL_ROUTING_NAME = "model-routing-by-task-class";

/** The prompt-compression optimization's name. */
export const PROMPT_COMPRESSION_NAME = "prompt-compression";

/** The semantically-safe response-cache optimization's name. */
export const RESPONSE_CACHE_NAME = "response-cache-semantically-safe";

/** The batched-throughput optimization's name. */
export const BATCHED_THROUGHPUT_NAME = "batched-throughput";

/** The provider-side optimization's name. */
export const PROVIDER_SIDE_NAME = "provider-side-batch-pricing";

// ---------------------------------------------------------------------------
// The pinned entries (the declared optimization set)
// ---------------------------------------------------------------------------

/**
 * The prompt-compression entry builder: the compression ratio is
 * bounded on BOTH sides — the dispatched payload must be a real
 * compression of the raw payload (never more than `max` of it, never
 * less than `min` — a token-understatement masquerade collapses the
 * ratio below the floor and FAILs the bound mechanically).
 */
function promptCompressionEntry(bound: {
  readonly minCompressedRatio: string;
  readonly maxCompressedRatio: string;
}): OptimizationEntry {
  return {
    name: PROMPT_COMPRESSION_NAME,
    kind: "prompt-compression",
    bound,
    description:
      "the dispatched payload is a bounded compression of the raw task payload: the dispatched input tokens stay within [minCompressedRatio, maxCompressedRatio] of the raw payload's tokens — the bound is verified mechanically per dispatched round",
  };
}

/** The model-routing entry (the routing table rides the revision). */
const MODEL_ROUTING_ENTRY: OptimizationEntry = {
  name: MODEL_ROUTING_NAME,
  kind: "model-routing",
  bound: {
    keying: "task-class",
    classes: ["summarize", "extract", "transform-batch"],
    fallback: "the fallback route serves every class the table does not name",
  },
  description:
    "each task class rides its own explicitly routed provider rail (priced through the pinned VAL-040 manifest revisions); the routing table is part of the content-addressed inventory revision",
};

/** The semantically-safe response-cache entry. */
const RESPONSE_CACHE_ENTRY: OptimizationEntry = {
  name: RESPONSE_CACHE_NAME,
  kind: "response-cache",
  bound: {
    key: "task-class+content-digest",
    safety:
      "a fresh-only task (correctness demands a fresh dispatch) is NEVER served from the cache",
    stores: "successful responses of cacheable tasks only (failures never populate the cache)",
  },
  description:
    "identical (task class, content digest) identities replay the cached response — never where correctness demands freshness; a cache hit contributes ZERO new measured cost (the honest attribution)",
};

/** The batched-throughput entry. */
const BATCHED_THROUGHPUT_ENTRY: OptimizationEntry = {
  name: BATCHED_THROUGHPUT_NAME,
  kind: "batched-throughput",
  bound: {
    appliesToClass: "transform-batch",
    minTasksPerBatch: 2,
  },
  description:
    "adjacent same-class rounds coalesce onto the batched rail so the per-batch increments carry real work",
};

/** The provider-side optimization entry. */
const PROVIDER_SIDE_ENTRY: OptimizationEntry = {
  name: PROVIDER_SIDE_NAME,
  kind: "provider-side-optimization",
  bound: {
    rail: "batch-relay",
    feature: "batched metering (ceil-to-batch increments)",
    pricedThrough: "the pinned manifest's own batched list-price entries",
  },
  description:
    "the provider-side batched metering feature rides the batched rail's own pricing shape (priced through the pinned manifest — never a negotiated rate)",
};

// ---------------------------------------------------------------------------
// The pinned routing table (every rail priced in the VAL-040 manifest)
// ---------------------------------------------------------------------------

/** The pinned routing table (rev-opt-001 and rev-opt-002 share it). */
const ROUTES: readonly ModelRoute[] = [
  { taskClass: "summarize", provider: "retry-relay", model: "retry-small-v1" },
  { taskClass: "extract", provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct" },
  { taskClass: "transform-batch", provider: "batch-relay", model: "batch-medium-v1" },
];

/** The fallback route (the arm grammar's declared rail). */
const FALLBACK_ROUTE: ModelRoute = {
  taskClass: "fallback",
  provider: "openrouter",
  model: "meta-llama/llama-3.3-70b-instruct",
};

// ---------------------------------------------------------------------------
// The inventory registry (append-only revisions)
// ---------------------------------------------------------------------------

/** The rev-opt-001 entries: the initial declared optimization set. */
const ENTRIES_OPT_001: readonly OptimizationEntry[] = [
  MODEL_ROUTING_ENTRY,
  promptCompressionEntry({ minCompressedRatio: "0.25", maxCompressedRatio: "0.75" }),
  RESPONSE_CACHE_ENTRY,
  BATCHED_THROUGHPUT_ENTRY,
  PROVIDER_SIDE_ENTRY,
];

/**
 * The rev-opt-002 entries: a BOUND CORRECTION of the prompt-compression
 * optimization (the maximum compressed ratio tightened from 0.75 to
 * 0.70 — a stricter honesty bound). A correction is a NEW revision —
 * opt-rev-001 stays frozen and readable (append-only).
 */
const ENTRIES_OPT_002: readonly OptimizationEntry[] = ENTRIES_OPT_001.map((entry) =>
  entry.name === PROMPT_COMPRESSION_NAME
    ? promptCompressionEntry({ minCompressedRatio: "0.25", maxCompressedRatio: "0.70" })
    : entry,
);

/** The pinned inventory registry (append-only, in revision order). */
export const OPTIMIZATION_INVENTORY: readonly OptimizationInventoryRevision[] = [
  {
    revision: "opt-rev-001",
    entries: ENTRIES_OPT_001,
    routes: ROUTES,
    fallbackRoute: FALLBACK_ROUTE,
    digest: computeInventoryDigest({
      entries: ENTRIES_OPT_001,
      routes: ROUTES,
      fallbackRoute: FALLBACK_ROUTE,
    }),
  },
  {
    revision: "opt-rev-002",
    entries: ENTRIES_OPT_002,
    routes: ROUTES,
    fallbackRoute: FALLBACK_ROUTE,
    digest: computeInventoryDigest({
      entries: ENTRIES_OPT_002,
      routes: ROUTES,
      fallbackRoute: FALLBACK_ROUTE,
    }),
    supersedes: "opt-rev-001",
  },
];

/** Look up one pinned inventory revision by identity. */
export function inventoryRevisionOf(revision: string): OptimizationInventoryRevision | null {
  return OPTIMIZATION_INVENTORY.find((candidate) => candidate.revision === revision) ?? null;
}

/**
 * The inventory for a declared revision (throws when the revision is
 * unknown — a run against an unpinned inventory revision has no
 * declared optimization set at all).
 */
export function inventoryFor(revision: string): OptimizationInventoryRevision {
  const inventory = inventoryRevisionOf(revision);
  if (inventory === null) {
    throw new Error(`the declared optimization inventory revision ${revision} is not pinned`);
  }
  return inventory;
}

// ---------------------------------------------------------------------------
// Inventory validation (structural) + integrity (digest agreement)
// ---------------------------------------------------------------------------

/** One inventory-validation violation. */
export interface InventoryViolation {
  readonly path: string;
  readonly reason: string;
}

/** Parse a non-negative decimal string into a number (ratio bounds). */
function parseRatio(value: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Validate one inventory revision's structure (PURE): non-empty
 * distinct names, a well-formed routing table (distinct task classes,
 * every route carries a provider/model), the prompt-compression bound
 * in (0,1] with min ≤ max, the response-cache entry carrying the
 * safety rule, and the fallback route distinct from the table's
 * classes.
 */
export function validateOptimizationInventory(
  inventory: OptimizationInventoryRevision,
): readonly InventoryViolation[] {
  const violations: InventoryViolation[] = [];
  const fail = (path: string, reason: string): void => {
    violations.push({ path, reason });
  };
  if (inventory.entries.length === 0) {
    fail("entries", "the inventory must declare at least one optimization (the set is explicit)");
  }
  const names = new Set(inventory.entries.map((entry) => entry.name));
  if (names.size !== inventory.entries.length) {
    fail(
      "entries.names",
      "optimization names must be distinct (the conformance oracle keys on them)",
    );
  }
  const classes = new Set<string>();
  for (const route of inventory.routes) {
    if (route.taskClass.length === 0 || route.provider.length === 0 || route.model.length === 0) {
      fail(`routes.${route.taskClass}`, "every route must carry a task class, provider and model");
    }
    if (classes.has(route.taskClass)) {
      fail(`routes.${route.taskClass}`, "duplicate task class in the routing table");
    }
    classes.add(route.taskClass);
  }
  if (classes.has(inventory.fallbackRoute.taskClass)) {
    fail("fallbackRoute", "the fallback route's class must not collide with the table's classes");
  }
  if (inventory.fallbackRoute.provider.length === 0 || inventory.fallbackRoute.model.length === 0) {
    fail("fallbackRoute", "the fallback route must carry a provider and model");
  }
  for (const entry of inventory.entries) {
    if (entry.kind === "prompt-compression") {
      const min = parseRatio(String(entry.bound.minCompressedRatio ?? ""));
      const max = parseRatio(String(entry.bound.maxCompressedRatio ?? ""));
      if (min === null || max === null || !(min > 0) || !(max <= 1) || min > max) {
        fail(
          `entries.${entry.name}`,
          "the prompt-compression bound must satisfy 0 < min ≤ max ≤ 1 (decimal strings)",
        );
      }
    }
    if (entry.kind === "response-cache") {
      const safety = String(entry.bound.safety ?? "");
      if (!safety.includes("NEVER served from the cache")) {
        fail(
          `entries.${entry.name}`,
          "the response-cache entry must carry the fresh-only safety rule in its bound",
        );
      }
    }
  }
  return violations;
}

/** The inventory-integrity verdict (the digest-agreement catch). */
export interface InventoryIntegrityVerdict {
  readonly declaredRevisionKnown: boolean;
  readonly digestAgrees: boolean;
  readonly structurallyValid: boolean;
  readonly agreed: boolean;
  readonly evidence: readonly string[];
}

/**
 * Derive the inventory integrity of one declared revision (PURE — the
 * AC4 inventory-integrity oracle): the declared revision must exist in
 * the pinned registry, the recomputed content digest over its entries
 * + routes + fallback must AGREE with the registry's recorded digest
 * (an in-place bound edit breaks agreement mechanically), and the
 * structure must validate. The optional `registry` probes
 * adversarially (the discrimination battery's mutated copy); the
 * optional `declaredDigest` (a pinned experiment's recorded digest of
 * the revision) must ALSO agree.
 */
export function deriveInventoryIntegrity(declared: {
  readonly revision: string;
  readonly registry?: readonly OptimizationInventoryRevision[];
  readonly declaredDigest?: string;
}): InventoryIntegrityVerdict {
  const registry = declared.registry ?? OPTIMIZATION_INVENTORY;
  const revision = registry.find((candidate) => candidate.revision === declared.revision) ?? null;
  if (revision === null) {
    return {
      declaredRevisionKnown: false,
      digestAgrees: false,
      structurallyValid: false,
      agreed: false,
      evidence: [
        `revision:${declared.revision}`,
        "known:NO (the declared inventory revision is not pinned in the registry)",
      ],
    };
  }
  const recomputed = computeInventoryDigest(revision);
  const digestAgrees =
    recomputed === revision.digest &&
    (declared.declaredDigest === undefined || declared.declaredDigest === revision.digest);
  const structural = validateOptimizationInventory(revision);
  return {
    declaredRevisionKnown: true,
    digestAgrees,
    structurallyValid: structural.length === 0,
    agreed: digestAgrees && structural.length === 0,
    evidence: [
      `revision:${revision.revision}`,
      `digest:${revision.digest}`,
      `recomputed:${recomputed}`,
      ...(declared.declaredDigest === undefined
        ? []
        : [`declaredDigest:${declared.declaredDigest}`]),
      digestAgrees
        ? "digest:AGREED (the declared optimization set is exactly the pinned revision's)"
        : "digest:DISAGREED (an inventory bound was mutated in place — a correction must be a NEW revision)",
      `entries:${revision.entries.map((entry) => entry.name).join("+")}`,
      `routes:${revision.routes.map((route) => route.taskClass).join("+")}`,
      `structuralViolations:${structural.length}`,
      `supersedes:${revision.supersedes ?? "none"}`,
    ],
  };
}

/**
 * Derive the inventory registry's append-only discipline (PURE): every
 * revision identity is unique and no revision's recorded digest
 * disagrees with its own content.
 */
export function deriveInventoryAppendOnly(): {
  readonly appendOnly: boolean;
  readonly revisions: readonly string[];
  readonly evidence: readonly string[];
} {
  const revisions = OPTIMIZATION_INVENTORY.map((revision) => revision.revision);
  const unique = new Set(revisions).size === revisions.length;
  const everyDigestAgrees = OPTIMIZATION_INVENTORY.every(
    (revision) =>
      computeInventoryDigest(revision) === revision.digest &&
      validateOptimizationInventory(revision).length === 0,
  );
  return {
    appendOnly: unique && everyDigestAgrees,
    revisions,
    evidence: [
      `revisions:${revisions.join(" -> ")}`,
      `uniqueIdentities:${String(unique)}`,
      `everyDigestAgrees:${String(everyDigestAgrees)}`,
      "correctionsAreNewRevisions (opt-rev-002 supersedes opt-rev-001; opt-rev-001 stays frozen and readable)",
    ],
  };
}

// ---------------------------------------------------------------------------
// The routing + compression derivations (the optimization semantics)
// ---------------------------------------------------------------------------

/**
 * Resolve the route for one task class (PURE): the routing table's
 * exact match, or the fallback route for a class the table does not
 * name.
 */
export function routeForClass(
  inventory: OptimizationInventoryRevision,
  taskClass: string,
): ModelRoute {
  return inventory.routes.find((route) => route.taskClass === taskClass) ?? inventory.fallbackRoute;
}

/** The prompt-compression bound of one inventory revision (PURE). */
export function compressionBoundOf(inventory: OptimizationInventoryRevision): {
  readonly minCompressedRatio: number;
  readonly maxCompressedRatio: number;
} | null {
  const entry = inventory.entries.find((candidate) => candidate.name === PROMPT_COMPRESSION_NAME);
  if (entry === undefined) {
    return null;
  }
  const min = parseRatio(String(entry.bound.minCompressedRatio ?? ""));
  const max = parseRatio(String(entry.bound.maxCompressedRatio ?? ""));
  if (min === null || max === null) {
    return null;
  }
  return { minCompressedRatio: min, maxCompressedRatio: max };
}

/**
 * Derive the compression-ratio conformance of one dispatched round
 * (PURE — the bound oracle): when the prompt-compression optimization
 * was applied, the dispatched input tokens must stay within the
 * declared [min, max] ratio of the raw payload's tokens — a ratio
 * below the floor is a token-understatement masquerade (fabricated
 * compression), a ratio above the ceiling is no compression at all.
 */
export function deriveCompressionConformance(input: {
  readonly inventory: OptimizationInventoryRevision;
  readonly appliedOptimizations: readonly string[];
  readonly dispatchedInputTokens: number;
  readonly rawInputTokens: number;
}): { readonly conformant: boolean; readonly ratio: number | null; readonly evidence: string[] } {
  const applied = input.appliedOptimizations.includes(PROMPT_COMPRESSION_NAME);
  if (!applied || input.rawInputTokens <= 0 || input.dispatchedInputTokens < 0) {
    return {
      conformant: true,
      ratio: null,
      evidence: [
        applied
          ? "compression:not-verifiable (no raw token count observed — the bound is skipped honestly)"
          : "compression:not-applied (the round dispatched without prompt-compression)",
      ],
    };
  }
  const bound = compressionBoundOf(input.inventory);
  if (bound === null) {
    return {
      conformant: true,
      ratio: null,
      evidence: ["compression:no-bound (the inventory declares no prompt-compression bound)"],
    };
  }
  const ratio = input.dispatchedInputTokens / input.rawInputTokens;
  const conformant = ratio >= bound.minCompressedRatio && ratio <= bound.maxCompressedRatio;
  return {
    conformant,
    ratio,
    evidence: [
      `dispatchedInputTokens:${input.dispatchedInputTokens}`,
      `rawInputTokens:${input.rawInputTokens}`,
      `ratio:${ratio.toFixed(4)}`,
      `bound:[${bound.minCompressedRatio}, ${bound.maxCompressedRatio}]`,
      conformant
        ? "conformant (the compression is within the declared bound)"
        : "NON-CONFORMANT (the dispatched tokens fall outside the declared compression bound — an understatement masquerade or no compression)",
    ],
  };
}

/**
 * Derive the inventory conformance of the optimizations one run
 * APPLIED (PURE — the exhaustiveness oracle, the verification core):
 * every applied name must be declared in the inventory revision the
 * row pinned. An applied optimization the inventory does not name is
 * an UNDECLARED optimization — something the baseline does that its
 * inventory does not declare — and FAILs mechanically.
 */
export function deriveInventoryConformance(input: {
  readonly inventory: OptimizationInventoryRevision;
  readonly appliedOptimizations: readonly string[];
}): {
  readonly conformant: boolean;
  readonly undeclared: readonly string[];
  readonly evidence: readonly string[];
} {
  const declared = new Set(input.inventory.entries.map((entry) => entry.name));
  const undeclared = [...new Set(input.appliedOptimizations)].filter((name) => !declared.has(name));
  return {
    conformant: undeclared.length === 0,
    undeclared,
    evidence: [
      `declared:${[...declared].join("+")}`,
      `applied:${[...new Set(input.appliedOptimizations)].join("+") || "none"}`,
      `undeclared:${undeclared.join("+") || "none"}`,
      undeclared.length === 0
        ? "conformant (every applied optimization is declared in the pinned inventory revision)"
        : "NON-CONFORMANT (an UNDECLARED optimization was applied — something the baseline does that its inventory does not name)",
    ],
  };
}
