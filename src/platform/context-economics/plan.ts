/**
 * Prompt/prefix and memoization cache planning (platform
 * context-economics plane; WORK-052 / E1.1).
 *
 * The cache planner is a PURE function of (plan IR variant,
 * memoization-hook annotations, cache facts, policy facts, tenant
 * scope, explicit now): it emits a plan-level cache DECISION SET —
 * per-site memoization reuse decisions and one prompt/prefix cache
 * decision — honoring ALL FOUR preconditions of architecture
 * invariant 1, each check explicit and each failure fail-closed:
 *
 *  1. SEMANTICS — the site must carry a VALID memoization hook
 *     (the compiler's fixed annotation contract, re-proven by the
 *     consumer in `memo.ts`); invalid or absent hooks never reuse;
 *  2. IDENTITY — the cache key is derived tenant-safely (structural
 *     tenant component); a cache fact whose key does not re-derive
 *     under this plan's scope is foreign — rejected, never served;
 *  3. POLICY — the governing policy facts must permit reuse (or
 *     prefix caching, or coalescing — a denial is a recorded
 *     compute/independent decision, never an error the caller might
 *     misread as permission);
 *  4. FRESHNESS — a matching fact must exist, its semantics digest
 *     must match the current derivation, and its age must be within
 *     the policy freshness bound. A stale or drifted fact is NEVER
 *     served (silent staleness is forbidden — freshness violations
 *     fail closed).
 *
 * Determinism (invariant 6): the same inputs always produce the
 * byte-identical plan (the `planDigest` is content-addressed over
 * the canonical decision form; `nowEpochMs` is an explicit input,
 * never ambient). Idempotence: re-planning is a bounded no-op —
 * the identical plan value, digest included.
 *
 * The plan is EVIDENCE AND MECHANISM, never an authorization input:
 * no authorization path consults cache state (mechanically proven
 * by the architecture boundary tests).
 */

import type { ExecutionIrVariant } from "../execution-compiler/variant";
import { canonicalJson } from "../execution-ir/canonical";
import type { IrDigestPort } from "../execution-ir/ir";
import {
  type CacheComputeReason,
  type CacheSiteDecision,
  ContextEconomicsError,
  MAX_CACHE_FACTS,
  PREFIX_STABLE_KINDS,
  type PrefixCacheDecision,
  type PrefixRecomputeReason,
  reject,
} from "./catalog";
import type { ContextComposition } from "./cost";
import { validateContextComposition } from "./cost";
import {
  deriveTenantScopedCacheKey,
  sameTenantCacheKey,
  type TenantCacheScope,
  type TenantScopedCacheKey,
  validateTenantCacheScope,
  validateTenantScopedCacheKey,
} from "./keys";
import type { CacheFact, CachePolicyFacts, MemoizationHook } from "./memo";
import { readMemoizationHooks, validateCachePolicyFacts } from "./memo";

// ---------------------------------------------------------------------------
// The cache plan
// ---------------------------------------------------------------------------

/** One per-site decision over a memoization hook. */
export interface CacheSitePlanDecision {
  readonly stepId: string;
  readonly memoKey: string;
  /** The tenant-safe cache key of the site (derived, structural). */
  readonly cacheKey: TenantScopedCacheKey;
  readonly decision: CacheSiteDecision;
  /**
   * The reason code: exactly one closed-vocabulary code. `null` on a
   * reuse decision (every precondition permitted); one of the closed
   * `CACHE_COMPUTE_REASONS` codes on a compute decision.
   */
  readonly reason: CacheComputeReason | null;
  /** The fact supporting a reuse decision (null otherwise). */
  readonly fact: CacheFact | null;
}

/** The prompt/prefix cache decision of the plan. */
export interface PrefixPlanDecision {
  readonly decision: PrefixCacheDecision;
  readonly reason: PrefixRecomputeReason | null;
  /** The tenant-safe prefix key (derived over the prefix content). */
  readonly prefixKey: TenantScopedCacheKey | null;
  /** The number of leading stable-prefix segments covered. */
  readonly prefixSegments: number;
  /** The tokens inside the covered prefix. */
  readonly prefixTokens: number;
  /** The fact supporting a cacheable-prefix decision (null otherwise). */
  readonly fact: CacheFact | null;
}

/** The plan-level cache decision set over a compiled variant. */
export interface CachePlan {
  /** Content-addressed identity: sha256 over the canonical plan form. */
  readonly planDigest: string;
  /** The compiled variant the plan was derived over. */
  readonly variantIrId: string;
  /** The governed plan identity (the preserved provenance chain). */
  readonly planId: string;
  /** Per-site decisions in VARIANT STEP ORDER (deterministic). */
  readonly siteDecisions: readonly CacheSitePlanDecision[];
  /** The explicit planning instant (an input — determinism). */
  readonly nowEpochMs: number;
  /** How many sites will be reused vs recomputed (derived evidence). */
  readonly reuseCount: number;
  readonly computeCount: number;
}

// ---------------------------------------------------------------------------
// Cache fact validation (identity-checked on every plan)
// ---------------------------------------------------------------------------

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Validate the cache facts input: bounded count, digest shapes,
 * recorded-at bounds — and every fact's key is re-validated through
 * the structural tenant-scope re-derivation (a foreign or tampered
 * key is a typed rejection, never a filtered accident).
 */
export function validateCacheFacts(value: unknown, digest: IrDigestPort): readonly CacheFact[] {
  if (!Array.isArray(value)) {
    reject("cache-fact-shape", "cache facts must be an array");
  }
  if (value.length > MAX_CACHE_FACTS) {
    reject("cache-fact-shape", "cache facts exceed the bounded input size", {
      got: value.length,
      max: MAX_CACHE_FACTS,
    });
  }
  const facts: CacheFact[] = [];
  for (const [index, fact] of value.entries()) {
    if (typeof fact !== "object" || fact === null || Array.isArray(fact)) {
      reject("cache-fact-shape", `cache fact ${index} must be an object`);
    }
    const record = fact as Record<string, unknown>;
    if (typeof record.contentDigest !== "string" || !SHA256_HEX.test(record.contentDigest)) {
      reject("cache-fact-shape", `cache fact ${index} contentDigest must be a sha256 digest`);
    }
    if (
      typeof record.recordedAtEpochMs !== "number" ||
      !Number.isSafeInteger(record.recordedAtEpochMs) ||
      record.recordedAtEpochMs < 0
    ) {
      reject(
        "cache-fact-shape",
        `cache fact ${index} recordedAtEpochMs must be a non-negative integer`,
      );
    }
    facts.push({
      key: validateFactKey(record.key, digest, index),
      contentDigest: record.contentDigest,
      recordedAtEpochMs: record.recordedAtEpochMs,
    });
  }
  return facts;
}

function validateFactKey(
  value: unknown,
  digest: IrDigestPort,
  index: number,
): TenantScopedCacheKey {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("cache-fact-shape", `cache fact ${index} must carry a key`);
  }
  const record = value as Record<string, unknown>;
  try {
    return validateTenantScopedCacheKey(
      {
        tenantId: record.tenantId,
        applicationId: record.applicationId,
        keyClass: record.keyClass,
        key: record.key,
        semanticsDigest: record.semanticsDigest,
      },
      digest,
    );
  } catch (error) {
    if (error instanceof ContextEconomicsError) {
      // A fact whose key is foreign or tampered is a typed identity
      // rejection (the structural tenant-safety proof on facts).
      reject(
        error.invariant === "cache-key-tenant" ? "cache-plan-identity" : "cache-fact-shape",
        `cache fact ${index} key is invalid: ${error.message}`,
        { factIndex: index },
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The memoization planner (per-site decision set)
// ---------------------------------------------------------------------------

/** The cache-planning input (pure facts only). */
export interface CachePlanInput {
  /** The compiled variant (the memoization-hook annotations ride in it). */
  readonly variant: ExecutionIrVariant;
  /** Read-only cache facts (validated; identity-checked per plan). */
  readonly facts: readonly CacheFact[];
  /** The governing policy facts. */
  readonly policy: CachePolicyFacts;
  /** The tenant scope (structural cache-key safety). */
  readonly scope: TenantCacheScope;
  /** The explicit planning instant (epoch ms — an input, never ambient). */
  readonly nowEpochMs: number;
}

/**
 * Plan the cache decisions over a compiled variant: one decision per
 * step in VARIANT STEP ORDER — a site is `reuse` ONLY when
 * semantics, identity, policy and freshness ALL permit it; otherwise
 * an explicit `compute` decision carrying exactly one closed reason
 * code. Sites with invalid annotations (the consumer's fail-closed
 * rejections) are recorded as `compute` with
 * `semantics-hook-invalid`; steps with no hook are recorded as
 * `compute` with `semantics-no-hook` — the full decision set is
 * explicit evidence, never silent.
 *
 * PURE and deterministic: identical inputs produce the identical
 * plan (byte-identical `planDigest`); re-planning is a bounded no-op.
 */
export function planCacheDecisions(input: CachePlanInput, digest: IrDigestPort): CachePlan {
  const scope = validateTenantCacheScope(input.scope);
  const policy = validateCachePolicyFacts(input.policy);
  if (typeof input.nowEpochMs !== "number" || !Number.isSafeInteger(input.nowEpochMs)) {
    reject("cache-plan-shape", "cache planning requires an explicit integer nowEpochMs");
  }
  const facts = validateCacheFacts(input.facts, digest);

  const read = readMemoizationHooks(input.variant);
  const hooksByStep = new Map(read.hooks.map((hook) => [hook.stepId, hook]));
  const rejectedSteps = new Set(read.rejections.map((rejection) => rejection.stepId));

  const decisions: CacheSitePlanDecision[] = [];
  let reuseCount = 0;

  // VARIANT STEP ORDER — the deterministic decision order.
  for (const step of input.variant.steps) {
    const hook = hooksByStep.get(step.id);
    if (hook === undefined) {
      if (rejectedSteps.has(step.id)) {
        // The annotation exists but violates the fixed contract —
        // fail-closed compute, never consumed.
        decisions.push({
          stepId: step.id,
          memoKey: "",
          cacheKey: deriveTenantScopedCacheKey(
            scope,
            "memo-entry",
            { variantIrId: input.variant.variantIrId, stepId: step.id, invalid: true },
            digest,
          ),
          decision: "compute",
          reason: "semantics-hook-invalid",
          fact: null,
        });
        continue;
      }
      // No annotation at all — not a memoization candidate.
      decisions.push({
        stepId: step.id,
        memoKey: "",
        cacheKey: deriveTenantScopedCacheKey(
          scope,
          "memo-entry",
          { variantIrId: input.variant.variantIrId, stepId: step.id },
          digest,
        ),
        decision: "compute",
        reason: "semantics-no-hook",
        fact: null,
      });
      continue;
    }

    const cacheKey = deriveTenantScopedCacheKey(
      scope,
      "memo-entry",
      { variantIrId: input.variant.variantIrId, memoKey: hook.memoKey },
      digest,
    );
    const decision = decideSite(cacheKey, hook, facts, policy, input.nowEpochMs);
    if (decision.decision === "reuse") {
      reuseCount += 1;
    }
    decisions.push(decision);
  }

  const form = {
    variantIrId: input.variant.variantIrId,
    planId: input.variant.sourcePlanId,
    siteDecisions: decisions.map(siteDecisionForm),
    nowEpochMs: input.nowEpochMs,
  };
  return {
    variantIrId: form.variantIrId,
    planId: form.planId,
    siteDecisions: decisions,
    nowEpochMs: form.nowEpochMs,
    reuseCount,
    computeCount: decisions.length - reuseCount,
    planDigest: digest.sha256Hex(canonicalJson(form)),
  };
}

function decideSite(
  cacheKey: TenantScopedCacheKey,
  hook: MemoizationHook,
  facts: readonly CacheFact[],
  policy: CachePolicyFacts,
  nowEpochMs: number,
): CacheSitePlanDecision {
  const site = {
    stepId: hook.stepId,
    memoKey: hook.memoKey,
    cacheKey,
    decision: "compute" as const,
    reason: null as CacheComputeReason | null,
    fact: null as CacheFact | null,
  };
  // POLICY: fail-closed recorded denial (never an error).
  if (!policy.reuseAllowed) {
    return { ...site, reason: "policy-reuse-denied" };
  }
  // IDENTITY: only a fact for THIS tenant-scoped key can match.
  const matching = facts.find((fact) => sameTenantCacheKey(fact.key, cacheKey));
  if (matching === undefined) {
    return { ...site, reason: "freshness-no-fact" };
  }
  // SEMANTICS: the fact's semantics digest must match the current
  // derivation (content drift never reuses).
  if (matching.key.semanticsDigest !== cacheKey.semanticsDigest) {
    return { ...site, reason: "freshness-content-mismatch" };
  }
  // FRESHNESS: stale entries are NEVER served (fail closed).
  if (nowEpochMs - matching.recordedAtEpochMs > policy.maxEntryAgeMs) {
    return { ...site, reason: "freshness-expired" };
  }
  return { ...site, decision: "reuse" as const, fact: matching };
}

function siteDecisionForm(decision: CacheSitePlanDecision): Record<string, unknown> {
  return {
    stepId: decision.stepId,
    ...(decision.memoKey === "" ? {} : { memoKey: decision.memoKey }),
    decision: decision.decision,
    reason: decision.reason,
    ...(decision.fact === null
      ? {}
      : {
          fact: {
            key: {
              tenantId: decision.fact.key.tenantId,
              applicationId: decision.fact.key.applicationId,
              keyClass: decision.fact.key.keyClass,
              key: decision.fact.key.key,
            },
            contentDigest: decision.fact.contentDigest,
            recordedAtEpochMs: decision.fact.recordedAtEpochMs,
          },
        }),
  };
}

// ---------------------------------------------------------------------------
// Prompt/prefix cache planning
// ---------------------------------------------------------------------------

/** The prefix-planning input (pure facts only). */
export interface PrefixPlanInput {
  /** The context composition the prompt is assembled from. */
  readonly composition: ContextComposition;
  readonly facts: readonly CacheFact[];
  readonly policy: CachePolicyFacts;
  readonly scope: TenantCacheScope;
  readonly nowEpochMs: number;
}

/**
 * Plan the prompt/prefix cache decision over a context composition:
 * the maximal stable prefix (the leading run of stable segment
 * kinds) is a cacheable candidate ONLY when identity, policy and
 * freshness all permit it — a fresh prefix fact whose key matches
 * the tenant-scoped prefix key. Everything else is an explicit
 * `full-recompute` with exactly one closed reason code (volatile
 * prefix, empty prefix, no fact, expired fact, drifted content, or
 * policy denial). Stale prefixes are NEVER served.
 */
export function planPromptPrefixCache(
  input: PrefixPlanInput,
  digest: IrDigestPort,
): PrefixPlanDecision {
  const composition = validateContextComposition(input.composition);
  const policy = validateCachePolicyFacts(input.policy);
  const scope = validateTenantCacheScope(input.scope);
  const facts = validateCacheFacts(input.facts, digest);
  if (typeof input.nowEpochMs !== "number" || !Number.isSafeInteger(input.nowEpochMs)) {
    reject("cache-plan-shape", "prefix planning requires an explicit integer nowEpochMs");
  }

  // The maximal stable prefix (kind-level semantics).
  let prefixSegments = 0;
  const prefixContent: Record<string, unknown>[] = [];
  for (const segment of composition.segments) {
    if (!PREFIX_STABLE_KINDS.includes(segment.kind)) {
      break;
    }
    prefixSegments += 1;
    prefixContent.push({ kind: segment.kind, tokenCount: segment.tokenCount });
  }

  const recompute = (reason: PrefixRecomputeReason): PrefixPlanDecision => ({
    decision: "full-recompute",
    reason,
    prefixKey: null,
    prefixSegments,
    prefixTokens: 0,
    fact: null,
  });

  if (composition.segments.length === 0) {
    return recompute("prefix-empty");
  }
  if (prefixSegments === 0) {
    // A leading volatile segment: no stable prefix exists at all.
    return recompute("prefix-volatile");
  }

  if (!policy.prefixCacheAllowed) {
    return recompute("policy-prefix-denied");
  }

  // IDENTITY: the tenant-scoped prefix key over the prefix content.
  const prefixKey = deriveTenantScopedCacheKey(
    scope,
    "prefix-cache",
    { segments: prefixContent },
    digest,
  );
  const matching = facts.find((fact) => sameTenantCacheKey(fact.key, prefixKey));
  if (matching === undefined) {
    return recompute("freshness-no-fact");
  }
  if (matching.key.semanticsDigest !== prefixKey.semanticsDigest) {
    return recompute("freshness-content-mismatch");
  }
  // FRESHNESS: stale prefix facts are never served.
  if (input.nowEpochMs - matching.recordedAtEpochMs > policy.maxPrefixAgeMs) {
    return recompute("freshness-expired");
  }

  const prefixTokens = composition.segments
    .slice(0, prefixSegments)
    .reduce((sum, segment) => sum + segment.tokenCount, 0);
  return {
    decision: "cacheable-prefix",
    reason: null,
    prefixKey,
    prefixSegments,
    prefixTokens,
    fact: matching,
  };
}

// ---------------------------------------------------------------------------
// Determinism / idempotence re-verification
// ---------------------------------------------------------------------------

/**
 * Re-verify a cache plan: the `planDigest` must equal the digest of
 * the plan's canonical form (a plan that drifted from its claimed
 * identity is a mismatch — determinism drift is DETECTED, never
 * served). This is the replayable audit hook of the determinism
 * proof (work-order Required Verification: "deterministic
 * re-planning mismatches must be detected").
 */
export function verifyCachePlanDigest(
  plan: CachePlan,
  digest: IrDigestPort,
): { ok: boolean; expected: string; got: string } {
  const form = {
    variantIrId: plan.variantIrId,
    planId: plan.planId,
    siteDecisions: plan.siteDecisions.map(siteDecisionForm),
    nowEpochMs: plan.nowEpochMs,
  };
  const expected = digest.sha256Hex(canonicalJson(form));
  return { ok: expected === plan.planDigest, expected, got: plan.planDigest };
}
