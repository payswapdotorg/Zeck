/**
 * The closed vocabularies and typed errors of the context-economics
 * plane (platform context-economics; WORK-052 / E1.1 charter wave
 * member 2 — ADR-0019, ADR-0020).
 *
 * This plane is the CONTEXT/CACHE/REUSE/DUPLICATE-WORK ECONOMICS
 * surface: context-cost measurement, prompt/prefix cache planning,
 * reusable result identification, memoization decision hooks,
 * equivalent in-flight work coalescing, tenant-safe cache keys and
 * duplication accounting. It is a CONSUMER of the WORK-049/050
 * foundation (Execution IR, decision records, the compiler's
 * memoization-hook annotations) — it is NEVER a second authority:
 *
 *  - the cache is NEVER an authority: no authorization path consults
 *    cache state; the cache plan is evidence and mechanism only
 *    (invariant 3, mechanically proven by the architecture tests);
 *  - reuse/coalescing is permitted ONLY when semantics, freshness,
 *    policy and identity ALL permit it — each check explicit, each
 *    failure fail-closed (invariant 1);
 *  - cache keys are tenant-safe by CONSTRUCTION: tenant identity is
 *    a structural key component, not a filter (invariant 2 —
 *    cross-tenant reuse is unrepresentable, mutation-proven);
 *  - freshness violations fail closed: stale entries are never
 *    served silently;
 *  - context-cost claims carry explicit bases and bounds (the
 *    estimation-basis contract — unattributed claims are rejected);
 *  - duplication accounting is EVIDENCE (decision records through
 *    the existing WORK-049 store at the caller's seam), never a
 *    ledger of authority;
 *  - coalescing rides the existing executions seam read-only at the
 *    decision level — no second execution lifecycle or state machine.
 *
 * Everything in this plane is deterministic: the same inputs (plan
 * IR, annotations, cache facts, policy) produce the same cache plan
 * and the same coalescing decisions (invariant 6).
 */

// ---------------------------------------------------------------------------
// Typed errors (closed invariant vocabulary)
// ---------------------------------------------------------------------------

/**
 * The closed invariant-code vocabulary of the plane. Every rejection
 * is a typed `ContextEconomicsError` naming exactly one of these
 * codes — never an untyped throw, never an open extension.
 */
export const CONTEXT_ECONOMICS_INVARIANT_CODES = [
  "context-cost-shape",
  "context-cost-basis",
  "context-cost-bound",
  "cache-key-shape",
  "cache-key-tenant",
  "cache-fact-shape",
  "cache-plan-shape",
  "cache-plan-identity",
  "memo-annotation-shape",
  "coalesce-shape",
  "coalesce-bound",
  "accounting-shape",
] as const;
export type ContextEconomicsInvariantCode = (typeof CONTEXT_ECONOMICS_INVARIANT_CODES)[number];

/** The typed, bounded context-economics validation error. */
export class ContextEconomicsError extends Error {
  readonly invariant: ContextEconomicsInvariantCode;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    invariant: ContextEconomicsInvariantCode,
    message: string,
    details?: Readonly<Record<string, string | number | boolean | null>>,
  ) {
    super(message);
    this.name = "ContextEconomicsError";
    this.invariant = invariant;
    this.details = Object.freeze({ ...details });
  }
}

const DETAIL_LIMIT = 200;

function boundedText(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text;
}

export function reject(
  invariant: ContextEconomicsInvariantCode,
  message: string,
  details?: Record<string, string | number | boolean | null>,
): never {
  const boundedDetails: Record<string, string | number | boolean | null> = {};
  if (details !== undefined) {
    for (const [key, value] of Object.entries(details)) {
      boundedDetails[key] = typeof value === "string" ? boundedText(value) : value;
    }
  }
  throw new ContextEconomicsError(invariant, message, boundedDetails);
}

// ---------------------------------------------------------------------------
// Context composition vocabulary (context-cost measurement)
// ---------------------------------------------------------------------------

/**
 * The closed context-segment kinds. A context composition is a
 * bounded, ordered list of typed segments; the kind vocabulary is
 * neutral (provider-free) and closed. `system-prompt`,
 * `instruction` and `tool-surface` are the STABLE prefix kinds
 * (candidates for prompt/prefix cache planning); the remainder are
 * volatile tail kinds.
 */
export const CONTEXT_SEGMENT_KINDS = [
  "system-prompt",
  "instruction",
  "tool-surface",
  "retrieved-context",
  "conversation-history",
  "user-input",
] as const;
export type ContextSegmentKind = (typeof CONTEXT_SEGMENT_KINDS)[number];

/** The stable prefix kinds (the maximal cacheable-prefix candidates). */
export const PREFIX_STABLE_KINDS: readonly ContextSegmentKind[] = [
  "system-prompt",
  "instruction",
  "tool-surface",
];

// ---------------------------------------------------------------------------
// Cache key vocabulary (tenant-safe derivation)
// ---------------------------------------------------------------------------

/**
 * The closed cache-key classes. Every derived key names its class —
 * a memo entry, a prompt-prefix cache entry, an in-flight coalesce
 * group or a reusable artifact/result — so a key of one class can
 * never collide with a key of another class even over identical
 * semantic content.
 */
export const CACHE_KEY_CLASSES = [
  "memo-entry",
  "prefix-cache",
  "coalesce-group",
  "artifact-result",
] as const;
export type CacheKeyClass = (typeof CACHE_KEY_CLASSES)[number];

// ---------------------------------------------------------------------------
// Cache decision vocabulary (the plan-level decision set)
// ---------------------------------------------------------------------------

/**
 * The closed per-site decision outcomes of cache planning. A site is
 * either `reuse` (every precondition — semantics, freshness, policy,
 * identity — permits reuse) or `compute` (fail-closed recompute; the
 * recorded reason code names exactly which precondition failed).
 */
export const CACHE_SITE_DECISIONS = ["reuse", "compute"] as const;
export type CacheSiteDecision = (typeof CACHE_SITE_DECISIONS)[number];

/**
 * The closed reason codes for a `compute` decision. One code per
 * precondition failure — explicit, auditable, never silent:
 *
 *  - `semantics-no-hook` — the site carries no memoization hook;
 *  - `semantics-hook-invalid` — the hook exists but violates the
 *    compiler's fixed annotation contract (fail-closed re-read);
 *  - `freshness-no-fact` — no cache fact exists for the key;
 *  - `freshness-expired` — the fact exists but is older than the
 *    policy freshness bound (STALE — never served);
 *  - `freshness-content-mismatch` — the fact's semantics digest does
 *    not match the current derivation (content drift);
 *  - `policy-reuse-denied` — the governing policy facts deny reuse;
 *  - `identity-fact-foreign` — the fact is not this tenant's (the
 *    tenant-safe key mismatch — cross-tenant reuse is rejected).
 */
export const CACHE_COMPUTE_REASONS = [
  "semantics-no-hook",
  "semantics-hook-invalid",
  "freshness-no-fact",
  "freshness-expired",
  "freshness-content-mismatch",
  "policy-reuse-denied",
  "identity-fact-foreign",
] as const;
export type CacheComputeReason = (typeof CACHE_COMPUTE_REASONS)[number];

/**
 * The closed prefix-cache decision outcomes: `cacheable-prefix` (the
 * maximal stable prefix is fresh and permitted) or `full-recompute`
 * (fail-closed: volatile, stale, content-drifted or policy-denied).
 */
export const PREFIX_CACHE_DECISIONS = ["cacheable-prefix", "full-recompute"] as const;
export type PrefixCacheDecision = (typeof PREFIX_CACHE_DECISIONS)[number];

/**
 * The closed reason codes for a `full-recompute` prefix decision:
 *  - `prefix-volatile` — the leading segments are not stable kinds;
 *  - `prefix-empty` — no stable prefix exists at all;
 *  - `freshness-no-fact` — no prefix fact for the tenant-scoped key;
 *  - `freshness-expired` — the prefix fact is older than the policy
 *    prefix freshness bound;
 *  - `freshness-content-mismatch` — the prefix content digest
 *    drifted from the recorded fact;
 *  - `policy-prefix-denied` — the policy facts deny prefix caching.
 */
export const PREFIX_RECOMPUTE_REASONS = [
  "prefix-volatile",
  "prefix-empty",
  "freshness-no-fact",
  "freshness-expired",
  "freshness-content-mismatch",
  "policy-prefix-denied",
] as const;
export type PrefixRecomputeReason = (typeof PREFIX_RECOMPUTE_REASONS)[number];

// ---------------------------------------------------------------------------
// Coalescing vocabulary
// ---------------------------------------------------------------------------

/**
 * The closed coalescing decision kinds:
 *  - `lead` — no equivalent in-flight work exists (or all of it is
 *    too old to join); this execution becomes the leader;
 *  - `join` — equivalent in-flight work exists and is fresh enough;
 *    this execution joins onto the oldest leader (deterministic);
 *  - `independent` — coalescing is denied by policy (fail-closed
 *    recompute; the reason code names the denial).
 */
export const COALESCE_DECISION_KINDS = ["lead", "join", "independent"] as const;
export type CoalesceDecisionKind = (typeof COALESCE_DECISION_KINDS)[number];

/**
 * The closed reason codes for an `independent` coalescing decision:
 *  - `policy-coalesce-denied` — the governing policy denies joining;
 *  - `equivalence-key-invalid` — the caller's equivalence key is not
 *    a tenant-scoped coalesce-group key (identity precondition).
 */
export const COALESCE_INDEPENDENT_REASONS = [
  "policy-coalesce-denied",
  "equivalence-key-invalid",
] as const;
export type CoalesceIndependentReason = (typeof COALESCE_INDEPENDENT_REASONS)[number];

// ---------------------------------------------------------------------------
// Duplication-accounting vocabulary
// ---------------------------------------------------------------------------

/**
 * The closed duplication-accounting outcome kinds — what the evidence
 * record says was avoided:
 *  - `cache-reuse` — a memo entry was reused instead of recomputed;
 *  - `prefix-reuse` — a prompt/prefix cache entry was reused;
 *  - `coalesced-join` — this execution joined an equivalent
 *    in-flight leader (the leader's outcome was observed verbatim);
 *  - `coalesce-led` — this execution led a coalesced group (the
 *    duplicate joiners observed its outcome).
 */
export const DUPLICATION_OUTCOME_KINDS = [
  "cache-reuse",
  "prefix-reuse",
  "coalesced-join",
  "coalesce-led",
] as const;
export type DuplicationOutcomeKind = (typeof DUPLICATION_OUTCOME_KINDS)[number];

// ---------------------------------------------------------------------------
// Shared bounds (the plane's explicit limits)
// ---------------------------------------------------------------------------

/** Maximum segments in one context composition. */
export const MAX_CONTEXT_SEGMENTS = 64;
/** Maximum tokens per segment (bounded measurement universe). */
export const MAX_SEGMENT_TOKENS = 1_000_000_000;
/** Maximum total tokens in one composition. */
export const MAX_TOTAL_TOKENS = 10_000_000_000;
/** Maximum concurrent coalesce groups in one coordinator. */
export const MAX_COALESCE_GROUPS = 1024;
/** Maximum in-flight candidates considered by one coalescing decision. */
export const MAX_IN_FLIGHT_CANDIDATES = 1024;
/** Maximum cache facts considered by one cache plan. */
export const MAX_CACHE_FACTS = 4096;
/** Maximum attribution source length (mirrors the foundation contract). */
export const ATTRIBUTION_SOURCE_MAX = 200;
