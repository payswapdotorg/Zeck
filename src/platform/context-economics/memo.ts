/**
 * The memoization-hook consumer (platform context-economics plane;
 * WORK-052 / E1.1).
 *
 * This module implements the CONSUMER side of the execution
 * compiler's memoization-hook annotation contract (WORK-050 pass 8):
 * the compiler annotates deterministic, non-verification, non-human
 * steps with a content-addressed memo key under the reserved
 * step-config key `execution-compiler` → `memoization-hooks` →
 * `{ memoKey }`. The annotation contract is FIXED — this plane never
 * writes, rewrites or invents annotations; it READS them and
 * re-proves their preconditions fail-closed:
 *
 *  - a site carrying a memo hook must be `deterministic` (the
 *    compiler's own precondition — a mutated annotation on a
 *    probabilistic or human step is REJECTED by the reader, never
 *    consumed: `memo-annotation-shape`);
 *  - a memo hook never rides a verification step (`stepClass`
 *    `verify` or a verification strategy — freshness is the
 *    verification authority's, so verification evidence is never
 *    memoizable);
 *  - the `memoKey` must be a 64-hex sha256 digest (the content
 *    addressing the compiler emits).
 *
 * The read is PURE and read-only: the variant is never mutated (the
 * round-trip proof: re-reading yields the identical hooks, and the
 * variant object is untouched). This is the hook round-trip of
 * Work Order AC 3: annotation → consumer → cache-planning input.
 */

import { COMPILER_ANNOTATION_KEY } from "../execution-compiler/semantics";
import type { ExecutionIrVariant, IrVariantStep } from "../execution-compiler/variant";
import { reject } from "./catalog";
import type { TenantScopedCacheKey } from "./keys";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const MEMO_PASS_KEY = "memoization-hooks";

// ---------------------------------------------------------------------------
// The read contracts
// ---------------------------------------------------------------------------

/** One memoization hook read from a compiled variant. */
export interface MemoizationHook {
  readonly stepId: string;
  /** The compiler's content-addressed memo key (64-hex). */
  readonly memoKey: string;
}

/** One typed, fail-closed rejection of an invalid hook site. */
export interface MemoHookRejection {
  readonly stepId: string;
  readonly code:
    | "memo-annotation-shape"
    | "memo-annotation-not-object"
    | "memo-key-not-digest"
    | "memo-step-not-deterministic"
    | "memo-verification-step";
  readonly detail: string;
}

/** The read result: hooks (validated) + typed rejections (fail-closed). */
export interface MemoHookRead {
  readonly hooks: readonly MemoizationHook[];
  readonly rejections: readonly MemoHookRejection[];
}

// ---------------------------------------------------------------------------
// The reader (the fixed annotation contract, consumer side)
// ---------------------------------------------------------------------------

/**
 * Read the memoization hooks of a compiled variant. For every step:
 *
 *  - no annotation → no hook (the site is simply not a memoization
 *    candidate; the cache planner records `semantics-no-hook`);
 *  - annotation present → the contract is re-proven: the annotation
 *    map must be an object, the pass key must map to an object with
 *    a 64-hex `memoKey`, and the step must still be deterministic,
 *    non-verification and non-human. ANY violation rejects the site
 *    (typed) — the hook is never consumed.
 *
 * Read-only: the variant is never mutated; re-reading is
 * idempotent (the same hooks, in step order).
 */
export function readMemoizationHooks(variant: ExecutionIrVariant): MemoHookRead {
  const hooks: MemoizationHook[] = [];
  const rejections: MemoHookRejection[] = [];
  for (const step of variant.steps) {
    const annotation = memoAnnotationOf(step);
    if (annotation === undefined) {
      continue;
    }
    // The semantic preconditions re-proven on the consumer side
    // (the compiler guarantees them when it emits; a mutated or
    // foreign annotation fails closed here, never consumed).
    if (step.computationType !== "deterministic") {
      rejections.push({
        stepId: step.id,
        code: "memo-step-not-deterministic",
        detail: "a memoization hook on a non-deterministic step violates the annotation contract",
      });
      continue;
    }
    if (step.stepClass === "verify" || step.verificationStrategy !== undefined) {
      rejections.push({
        stepId: step.id,
        code: "memo-verification-step",
        detail:
          "verification evidence is never a memoization hook (freshness is the verification authority's)",
      });
      continue;
    }
    if (typeof annotation.memoKey !== "string" || !SHA256_HEX.test(annotation.memoKey)) {
      rejections.push({
        stepId: step.id,
        code: "memo-key-not-digest",
        detail: "the memoKey must be the compiler's 64-hex content digest",
      });
      continue;
    }
    hooks.push({ stepId: step.id, memoKey: annotation.memoKey });
  }
  return { hooks, rejections };
}

/** The raw memoization annotation of a step, or undefined. */
function memoAnnotationOf(step: IrVariantStep): Record<string, unknown> | undefined {
  if (step.config === undefined || !Object.hasOwn(step.config, COMPILER_ANNOTATION_KEY)) {
    return undefined;
  }
  const annotationMap = step.config[COMPILER_ANNOTATION_KEY];
  if (typeof annotationMap !== "object" || annotationMap === null || Array.isArray(annotationMap)) {
    // A non-object reserved-key value is plan-owned content the
    // compiler never touches — it is not a memo annotation.
    return undefined;
  }
  const passAnnotation = (annotationMap as Record<string, unknown>)[MEMO_PASS_KEY];
  if (
    typeof passAnnotation !== "object" ||
    passAnnotation === null ||
    Array.isArray(passAnnotation)
  ) {
    return undefined;
  }
  return passAnnotation as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Cache facts (the read-only reuse facts the planner consumes)
// ---------------------------------------------------------------------------

/**
 * One cache fact: a read-only observation about a durable or
 * in-flight cache entry. Facts are INPUTS to planning (provided by
 * the caller from the owning stores) — this plane holds no cache
 * store and the cache is never an authority.
 */
export interface CacheFact {
  /** The tenant-scoped key of the entry (structural tenant safety). */
  readonly key: TenantScopedCacheKey;
  /** sha256 of the cached value (the reuse equivalence evidence). */
  readonly contentDigest: string;
  /** When the entry was recorded (epoch ms — explicit, not ambient). */
  readonly recordedAtEpochMs: number;
}

/**
 * The policy facts governing reuse/coalescing — read-only inputs
 * derived from the owning policy authority by the caller. All
 * freshness bounds are explicit; violations fail closed (stale
 * entries are never served).
 */
export interface CachePolicyFacts {
  /** Whether memo-entry reuse is permitted at all. */
  readonly reuseAllowed: boolean;
  /** Whether prompt/prefix caching is permitted. */
  readonly prefixCacheAllowed: boolean;
  /** Whether equivalent in-flight coalescing is permitted. */
  readonly coalescingAllowed: boolean;
  /** Maximum age of a reusable memo entry (epoch ms delta). */
  readonly maxEntryAgeMs: number;
  /** Maximum age of a reusable prefix fact (epoch ms delta). */
  readonly maxPrefixAgeMs: number;
  /** Maximum age of an in-flight leader a joiner may coalesce onto. */
  readonly maxJoinAgeMs: number;
}

/** Total validation of the policy facts. */
export function validateCachePolicyFacts(value: unknown): CachePolicyFacts {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("cache-plan-shape", "cache policy facts must be an object");
  }
  const record = value as Record<string, unknown>;
  const bool = (name: string): boolean => {
    if (typeof record[name] !== "boolean") {
      reject("cache-plan-shape", `cache policy facts must carry boolean ${name}`);
    }
    return record[name] as boolean;
  };
  const age = (name: string): number => {
    const v = record[name];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
      reject("cache-plan-shape", `cache policy facts must carry non-negative integer ${name}`);
    }
    return v as number;
  };
  return {
    reuseAllowed: bool("reuseAllowed"),
    prefixCacheAllowed: bool("prefixCacheAllowed"),
    coalescingAllowed: bool("coalescingAllowed"),
    maxEntryAgeMs: age("maxEntryAgeMs"),
    maxPrefixAgeMs: age("maxPrefixAgeMs"),
    maxJoinAgeMs: age("maxJoinAgeMs"),
  };
}
