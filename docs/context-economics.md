# Context Economics — operator and developer guide (WORK-052 / E1.1)

The context-economics plane (`src/platform/context-economics/`) is the
E1.1 charter's wave member 2: the **context/cache/reuse/duplicate-work
economics** surface — context-cost measurement, prompt/prefix cache
planning, reusable result identification, memoization decision hooks,
equivalent in-flight work coalescing, tenant-safe cache keys and
duplication accounting. It is a **consumer** of the WORK-049/050
foundation (Execution IR, decision records, the compiler's
memoization-hook annotations) — it is never a second authority.

## What it is — and what it is not

| It IS | It is NOT |
|---|---|
| Context-cost measurement with bounded, explicit-basis claims | A pricing source or provider registry |
| A plan-level cache decision set (per-site memoization + prompt/prefix) | A cache store or cache authority |
| The consumer side of the compiler's memoization-hook annotation contract | A compiler engine or annotation writer |
| A pure coalescing decision + a process-local leader/joiner coordinator | A second execution lifecycle or state machine |
| Tenant-safe cache-key derivation (tenant identity is structural) | A tenant filter |
| Duplication accounting as decision records (evidence) | A ledger of authority or an authorization surface |

The governed plan stays the planner's authority; the executions ledger
stays the durable plan-decision authority; budgets/policy/capability/
verification stay the constraint authorities; the WORK-049
decision-record store stays the ONLY durable evidence surface (this
plane adds **zero** durable state — the migration count stays 29);
the planner and plan-selection authority are untouched.

## The pipeline

```
governed plan → Execution IR (WORK-049)
      │  compileExecutionIr (WORK-050 — memoization-hook annotations)
      ▼
compiled variant ──readMemoizationHooks──▶ MemoizationHook[]
      │                                        │
      │  cache facts (read-only inputs) +      │  context composition
      │  policy facts + tenant scope + now     │  + pricing basis
      ▼                                        ▼
planCacheDecisions(...)                 planPromptPrefixCache(...)     measureContextCost(...)
      │                                        │                          │
      └──── CachePlan (reuse/compute + reasons) └─ PrefixPlanDecision     └─ ContextCostMeasurement
                                             │
   equivalent in-flight work ──decideCoalescing──▶ lead | join | independent
                                             │
                     InFlightCoalescer.join(scope, semantics, work)
                       (one leader; joiners observe the leader's exact outcome)
                                             │
              buildDuplicationAccountingRecord(...)   (WORK-049 format)
                                             │
                SqlOptimizationDecisionStore.append()  (the caller's seam — the EXISTING store)
```

## Context-cost measurement (`cost.ts`)

A context composition is a bounded, ordered list of typed segments
(`system-prompt`, `instruction`, `tool-surface`, `retrieved-context`,
`conversation-history`, `user-input` — closed vocabulary), each with a
bounded token count and a REQUIRED estimation-basis attribution
(`observed` | `estimated` | `defaulted` + bounded source). The pricing
fact is an integer micro-USD-per-million-tokens value with its own
attribution. `measureContextCost` produces the bounded measurement:
totals, per-kind breakdown, the maximal stable prefix, the micro-USD
estimate (`ceil(tokens × price / 10^6)` over BigInt) and the
content-addressed `measurementDigest`. The composite basis is derived
by the weakest-input lattice (an estimate never claims more certainty
than its weakest input). **Unattributed or unbounded claims are
rejected before they exist** — typed `ContextEconomicsError`s naming
closed invariant codes.

## Tenant-safe cache keys (`keys.ts`)

Tenant identity is a **structural** component of every cache key:
`deriveTenantScopedCacheKey(scope, keyClass, semantics, digest)` digests
`{tenantId, applicationId, keyClass, semanticsDigest}` — two tenants
over identical semantics derive different keys by construction (the
tenant is IN the digested content). The key value carries its scope;
the lookup handle (`scopedLookupKey`) structurally prefixes the tenant.
`validateTenantScopedCacheKey` re-derives the key digest from the
claimed scope — a foreign or tampered key is a typed identity
rejection, never a filtered accident. A key without tenant identity is
unrepresentable (the derivation validates the scope fail-closed).

Key classes (closed): `memo-entry`, `prefix-cache`, `coalesce-group`,
`artifact-result`.

## The memoization consumer (`memo.ts`)

The compiler (WORK-050 pass `memoization-hooks`) annotates
deterministic, non-verification, non-human steps with
`config["execution-compiler"]["memoization-hooks"] = { memoKey }`. The
annotation contract is FIXED — this plane implements the **consumer**
side: `readMemoizationHooks(variant)` reads the hooks and RE-PROVES the
contract fail-closed (a mutated hook on a probabilistic/human/verify
step, or a non-digest memoKey, is a typed per-site rejection — never
consumed). The read is pure and read-only: the variant is never
mutated; re-reading is idempotent.

Cache facts and policy facts are read-only INPUTS (the caller provides
them from the owning stores/authorities): a fact is a tenant-scoped key
+ content digest + recorded-at instant; policy facts are the
reuse/prefix/coalescing permissions and freshness bounds.

## The cache planner (`plan.ts`)

`planCacheDecisions({variant, facts, policy, scope, nowEpochMs})` —
pure, deterministic, total: one decision per step in variant order.

A site is `reuse` ONLY when **all four** preconditions permit (each
failure is an explicit closed reason code on a `compute` decision):

| precondition | failure code |
|---|---|
| semantics — a valid memoization hook | `semantics-no-hook` / `semantics-hook-invalid` |
| identity — a tenant-safe key; foreign facts rejected | (typed identity rejection; facts are validated per plan) |
| policy — `reuseAllowed` | `policy-reuse-denied` |
| freshness — matching fact, semantics digest, age ≤ bound | `freshness-no-fact` / `freshness-expired` / `freshness-content-mismatch` |

**Stale entries are NEVER served** — freshness violations fail closed
(silent staleness is forbidden). `planPromptPrefixCache` applies the
same four-precondition discipline to the maximal stable prefix of a
context composition (`prefix-volatile`/`prefix-empty`/
`policy-prefix-denied`/`freshness-*` reason codes on
`full-recompute`).

The plan is content-addressed (`planDigest`) and carries the
provenance chain (`variantIrId` + the governed `planId`). Re-planning
is a bounded no-op (identical plan, digest included — proven by
`verifyCachePlanDigest`, which detects any plan that drifted from its
claimed digest).

## In-flight coalescing (`coalesce.ts`)

Two layers:

1. **The decision (pure)**: `decideCoalescing({candidates,
   equivalenceKey, policy, nowEpochMs})` — `join` onto the oldest
   equivalent, fresh leader (deterministic tie-break), `lead` when
   none exists or all are older than the join window (fail-closed: no
   joins onto possibly-stuck work), `independent` when policy denies
   coalescing or the equivalence key is not a tenant-scoped
   `coalesce-group` key. The candidates are read-only in-flight
   projections (execution id + start instant + equivalence key)
   produced by the caller from the executions authority — this plane
   never queries executions and carries no execution-status
   vocabulary. Equivalence is structural: the same tenant +
   application + semantic content ⇒ the same key; cross-tenant
   coalescing is unrepresentable.

2. **The mechanism (bounded)**: `InFlightCoalescer.join(scope,
   semantics, digest, work)` — the first concurrent caller leads and
   executes the work; concurrent equivalent callers join and await the
   leader's single promise. Success fans out as the leader's EXACT
   outcome value; failure fans out as the SAME failure. The group is
   removed synchronously at settle — a post-settle arrival starts a
   fresh group (no stale joins). Bounded at `MAX_COALESCE_GROUPS`
   concurrent groups (typed rejection above). No durable state: the
   only durable writes in this plane are accounting records appended
   by the caller AFTER the outcome is final — a crash mid-coalescing
   leaves no torn durable state.

## Duplication accounting (`accounting.ts`)

`buildDuplicationAccountingRecord` / `buildCoalescedAccountingRecord`
build the evidence records for what was reused/coalesced/avoided
through the EXISTING WORK-049 contract (`buildOptimizationDecision`):
the governing constraints, both candidates (fresh execution vs the
reused/coalesced representation — bounded, attributed claims,
validated before the record exists), the deterministic selection, the
role-specific outcome detail (the audit trail: keys, digests, leader
identity, joiner counts) and the provenance chain (plan → IR →
decision). The record is evidence only: appends happen through the
existing `SqlOptimizationDecisionStore` at the caller's seam; a
below-threshold reuse is a typed rejection (never a dishonest
record); concurrent identical accountings converge on the store's
unique index (one row, N−1 replays).

## The plane surface (7 modules)

- `catalog.ts` — the closed vocabularies, typed errors and bounds;
- `cost.ts` — context-cost measurement;
- `keys.ts` — tenant-safe cache-key derivation;
- `memo.ts` — the memoization-hook consumer + fact/policy contracts;
- `plan.ts` — the deterministic cache planner (sites + prefix);
- `coalesce.ts` — the pure coalescing decision + the coordinator;
- `accounting.ts` — duplication accounting through the WORK-049
  evidence contract.

## What this plane deliberately does NOT do

- No cache store, no SQL, no migration (duplication accounting rides
  the existing decision-record store at the caller's seam).
- No authorization surface: no runtime path consults cache state for
  authorization (mechanically proven by the architecture tests).
- No second execution lifecycle: coalescing rides the executions seam
  read-only at the decision level; its vocabulary carries no
  execution-status words.
- No live model/substrate/provider selection: the claims are
  explicit-basis inputs; live derivation from telemetry is later
  E1.1 work (WORK-053/054/056).
- Nothing in this plane modifies the execution-ir foundation or the
  execution-compiler engine — import/consume only, build ON, never
  fork.
