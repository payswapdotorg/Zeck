/**
 * Equivalent in-flight work coalescing (platform context-economics
 * plane; WORK-052 / E1.1).
 *
 * Two layers, both under architecture invariant 4 ("coalescing
 * preserves execution semantics: joiners observe exactly the
 * leader's outcome; failures fan out as failures"):
 *
 *  1. The DECISION (pure): `decideCoalescing` — a pure function of
 *     (in-flight candidates, the caller's equivalence key, policy
 *     facts, explicit now) that decides `lead` / `join` /
 *     `independent`. It rides the EXISTING executions seam READ-ONLY
 *     at the decision level: the candidates are read-only projections
 *     of in-flight executions (identity + start instant + the
 *     tenant-scoped equivalence key), produced by the caller from the
 *     executions authority — this plane creates NO second execution
 *     lifecycle or state machine, and its decision vocabulary is
 *     closed and execution-status-free. Equivalence is structural:
 *     the equivalence key is a tenant-scoped `coalesce-group` cache
 *     key, so "equivalent" means SAME tenant, same application, same
 *     semantic content — cross-tenant coalescing is unrepresentable
 *     (the key collides only by sha256 collision over content that
 *     includes the tenant identity).
 *
 *  2. The MECHANISM (bounded, injectable clock): `InFlightCoalescer`
 *     — a process-local leader/joiner coordinator. The first caller
 *     for a key LEADS and runs the work; concurrent equivalent
 *     callers JOIN and await the leader's single outcome. Success
 *     fans out to every joiner as the leader's EXACT outcome value;
 *     failure fans out to every joiner as the SAME failure. A joiner
 *     arriving after settle finds no group (entries are removed on
 *     settle) and starts fresh — stale joins are impossible. The
 *     coordinator holds NO durable state: the only durable writes
 *     anywhere in this plane are the duplication-accounting decision
 *     records (append-only, through the existing WORK-049 store at
 *     the caller's seam), so a crash mid-coalescing leaves NO torn
 *     durable state — nothing is written until the outcome is
 *     final, and the append itself is atomic and idempotent.
 *
 * Determinism (invariant 6): the pure decision is a deterministic
 * function of its inputs (leader selection: oldest start instant,
 * tie-broken by execution id — content-canonical ordering); the
 * mechanism is deterministic given the interleaving the caller
 * produces.
 */

import type { IrDigestPort } from "../execution-ir/ir";
import {
  type CoalesceIndependentReason,
  MAX_COALESCE_GROUPS,
  MAX_IN_FLIGHT_CANDIDATES,
  reject,
} from "./catalog";
import {
  deriveTenantScopedCacheKey,
  sameTenantCacheKey,
  scopedLookupKey,
  type TenantCacheScope,
  type TenantScopedCacheKey,
  validateTenantCacheScope,
} from "./keys";
import { type CachePolicyFacts, validateCachePolicyFacts } from "./memo";

// ---------------------------------------------------------------------------
// The pure coalescing decision
// ---------------------------------------------------------------------------

/**
 * One in-flight candidate: a READ-ONLY projection of an in-flight
 * execution (produced by the caller from the executions authority —
 * this plane never queries executions directly and never carries
 * execution status vocabulary).
 */
export interface InFlightCandidate {
  readonly executionId: string;
  /** The tenant-scoped coalesce-group equivalence key of the candidate. */
  readonly equivalenceKey: TenantScopedCacheKey;
  /** When the candidate's work started (epoch ms — explicit input). */
  readonly startedAtEpochMs: number;
}

/** The pure coalescing decision over the in-flight set. */
export type CoalesceDecision =
  | {
      readonly kind: "lead";
      /** Candidates considered (the auditable in-flight set size). */
      readonly candidatesConsidered: number;
    }
  | {
      readonly kind: "join";
      readonly leaderExecutionId: string;
      readonly leaderStartedAtEpochMs: number;
      readonly candidatesConsidered: number;
    }
  | {
      readonly kind: "independent";
      readonly reason: CoalesceIndependentReason;
      readonly candidatesConsidered: number;
    };

/** The pure coalescing decision input. */
export interface CoalesceDecisionInput {
  /** The read-only in-flight candidates (bounded). */
  readonly candidates: readonly InFlightCandidate[];
  /** THIS execution's tenant-scoped equivalence key. */
  readonly equivalenceKey: TenantScopedCacheKey;
  readonly policy: CachePolicyFacts;
  /** The explicit decision instant (epoch ms — an input, never ambient). */
  readonly nowEpochMs: number;
}

/**
 * Decide coalescing: `join` onto the OLDEST equivalent, fresh leader
 * (deterministic: oldest `startedAtEpochMs`, ties broken by
 * lexicographically smallest `executionId`); `lead` when no
 * equivalent candidate exists or every equivalent one is older than
 * the policy join window (joining onto possibly-stuck work is
 * fail-closed: the caller becomes a fresh leader instead);
 * `independent` when policy denies coalescing or the equivalence
 * key is not a tenant-scoped coalesce-group key.
 */
export function decideCoalescing(input: CoalesceDecisionInput): CoalesceDecision {
  if (input.candidates.length > MAX_IN_FLIGHT_CANDIDATES) {
    reject("coalesce-shape", "in-flight candidates exceed the bounded input size", {
      got: input.candidates.length,
      max: MAX_IN_FLIGHT_CANDIDATES,
    });
  }
  const policy = validateCachePolicyFacts(input.policy);
  if (typeof input.nowEpochMs !== "number" || !Number.isSafeInteger(input.nowEpochMs)) {
    reject("coalesce-shape", "coalescing decision requires an explicit integer nowEpochMs");
  }

  // IDENTITY precondition: the equivalence key must be a tenant-scoped
  // coalesce-group key (structural: tenant + class + content).
  if (
    input.equivalenceKey.keyClass !== "coalesce-group" ||
    !/^[0-9a-f]{64}$/.test(input.equivalenceKey.key)
  ) {
    return {
      kind: "independent",
      reason: "equivalence-key-invalid",
      candidatesConsidered: input.candidates.length,
    };
  }

  // POLICY precondition: a denial is a recorded independent decision.
  if (!policy.coalescingAllowed) {
    return {
      kind: "independent",
      reason: "policy-coalesce-denied",
      candidatesConsidered: input.candidates.length,
    };
  }

  // Equivalence + freshness: candidates with the SAME key, within the
  // join window. Oldest wins (deterministic tie-break by id).
  let leader: InFlightCandidate | null = null;
  for (const candidate of input.candidates) {
    if (!sameKey(candidate.equivalenceKey, input.equivalenceKey)) {
      continue;
    }
    if (input.nowEpochMs - candidate.startedAtEpochMs > policy.maxJoinAgeMs) {
      // Too old to join: fail-closed fresh lead, never a stuck join.
      continue;
    }
    if (
      leader === null ||
      candidate.startedAtEpochMs < leader.startedAtEpochMs ||
      (candidate.startedAtEpochMs === leader.startedAtEpochMs &&
        candidate.executionId < leader.executionId)
    ) {
      leader = candidate;
    }
  }

  if (leader === null) {
    return { kind: "lead", candidatesConsidered: input.candidates.length };
  }
  return {
    kind: "join",
    leaderExecutionId: leader.executionId,
    leaderStartedAtEpochMs: leader.startedAtEpochMs,
    candidatesConsidered: input.candidates.length,
  };
}

function sameKey(left: TenantScopedCacheKey, right: TenantScopedCacheKey): boolean {
  return sameTenantCacheKey(left, right);
}

/**
 * Derive the coalesce-group equivalence key for a scope + semantic
 * content (the STRUCTURAL equivalence: same tenant + application +
 * class + semantics digest ⇒ same key).
 */
export function deriveEquivalenceKey(
  scope: TenantCacheScope,
  semantics: unknown,
  digest: IrDigestPort,
): TenantScopedCacheKey {
  return deriveTenantScopedCacheKey(scope, "coalesce-group", semantics, digest);
}

// ---------------------------------------------------------------------------
// The mechanism (process-local, bounded, no ambient time)
// ---------------------------------------------------------------------------

/** The coalesced execution outcome observed by one participant. */
export interface CoalescedOutcome<T> {
  /** The leader's EXACT outcome value (identical object for every joiner). */
  readonly outcome: T;
  /** This participant's role. */
  readonly role: "leader" | "joiner";
  /** The leader's key lookup handle (audit). */
  readonly leaderLookupKey: string;
  /** How many joiners coalesced onto the leader. */
  readonly joinerCount: number;
}

interface CoalesceGroupEntry {
  readonly lookupKey: string;
  readonly promise: Promise<unknown>;
  joiners: number;
}

/**
 * The process-local in-flight coalescer: `join(scope, semantics,
 * work)` — the FIRST concurrent caller for a (tenant, application,
 * semantics) group LEADS and executes `work`; concurrent equivalent
 * callers become JOINERS observing the leader's single outcome.
 *
 * FAN-OUT GUARANTEES (invariant 4):
 *  - success: every participant resolves with the leader's EXACT
 *    outcome value (one promise, N awaiters — atomic resolution);
 *  - failure: the leader's rejection propagates to every joiner as
 *    the SAME rejection (failures fan out as failures);
 *  - after settle, the group is removed synchronously — a later
 *    caller starts a fresh group (no stale joins, no torn fan-out:
 *    a joiner either attaches BEFORE settle and receives the exact
 *    outcome, or starts its own group).
 *
 * Bounded: at most MAX_COALESCE_GROUPS concurrent groups (a typed
 * rejection above the bound — never unbounded growth). No ambient
 * time, no randomness (the coordinator needs no clock: joiners await
 * the leader's single promise; age-window policy belongs to the
 * pure decision, which takes its `now` as an explicit input). No
 * durable state: the only durable writes in this plane are the
 * accounting decision records, appended by the caller AFTER the
 * outcome is final (atomic, idempotent) — crash mid-coalescing
 * leaves no torn durable state.
 */
export class InFlightCoalescer {
  private readonly groups = new Map<string, CoalesceGroupEntry>();

  /** The number of currently in-flight groups (bounded, observable). */
  get inFlightGroups(): number {
    return this.groups.size;
  }

  /**
   * Coalesce one unit of work: the first concurrent caller leads and
   * runs `work`; concurrent equivalent callers join and observe the
   * leader's exact outcome (or its exact failure).
   */
  async join<T>(
    scope: TenantCacheScope,
    semantics: unknown,
    digest: IrDigestPort,
    work: () => Promise<T>,
  ): Promise<CoalescedOutcome<T>> {
    const validated = validateTenantCacheScope(scope);
    const key = deriveTenantScopedCacheKey(validated, "coalesce-group", semantics, digest);
    const lookupKey = scopedLookupKey(key);

    const existing = this.groups.get(lookupKey);
    if (existing !== undefined) {
      // JOIN: observe the leader's exact outcome. The joiner count is
      // incremented synchronously in this event-loop turn — the entry
      // cannot settle between the get and the attach (settle handlers
      // run on later microtasks), so the fan-out set is fixed at
      // settle time and this joiner is inside it.
      existing.joiners += 1;
      const outcome = (await existing.promise) as T;
      return {
        outcome,
        role: "joiner",
        leaderLookupKey: lookupKey,
        // Final count: every join attaches before settle (post-settle
        // arrivals create a fresh group), and awaiters resume only
        // after the settle-time removal — the reference reads the
        // settled total.
        joinerCount: existing.joiners,
      };
    }

    if (this.groups.size >= MAX_COALESCE_GROUPS) {
      reject("coalesce-bound", "the in-flight coalescer is at its bounded group capacity", {
        groups: this.groups.size,
        max: MAX_COALESCE_GROUPS,
      });
    }

    // LEAD: create the single group; every concurrent equivalent
    // caller joins onto this promise. The promise is created BEFORE the
    // entry becomes visible in the registry (the set happens after
    // construction), so no concurrent caller can observe an
    // uninitialized entry.
    const promise: Promise<unknown> = Promise.resolve()
      .then(work)
      .finally(() => {
        // Remove the group when the leader settles: a caller arriving
        // after settle finds no group and starts fresh (no stale
        // joins). The removal happens before any awaiter resumes, so
        // the fan-out set is fixed at settle time.
        this.groups.delete(lookupKey);
      });
    const entry: CoalesceGroupEntry = {
      lookupKey,
      promise,
      joiners: 0,
    };
    this.groups.set(lookupKey, entry);
    const outcome: T = (await promise) as T;
    return {
      outcome,
      role: "leader",
      leaderLookupKey: lookupKey,
      // Final count: the leader resumes after settle-time removal,
      // after every joiner increment that joined this group.
      joinerCount: entry.joiners,
    };
  }
}
