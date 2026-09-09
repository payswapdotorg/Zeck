# WORK-052 — Context, Cache, Reuse and Duplicate-Work Economics

Status: AUTHORIZED / PENDING

Owner: Implementation worker; Architect retains review, merge and state-finalization authority

Architecture Version: v1.0 (frozen); Execution Intelligence Architecture E1.0 + Economic Execution Intelligence E1.1 (ADR-0019, ADR-0020)

Assurance Profile: HIGH_ASSURANCE

# Objective

Implement the E1.1 charter wave member 2: the context-economics plane — context-cost measurement, prompt/prefix cache planning, reusable artifacts/results, memoization, equivalent in-flight work coalescing, tenant-safe cache keys and duplication accounting — so repeated work is reused or coalesced when semantics, freshness, policy and identity permit it, with the cache never becoming an authority.

# Dependencies

Requires: WORK-050

Enables: WORK-056 (competence-aware optimization consumes reuse/dupe accounting).

Parallel-wave context: dispatched in the wave {WORK-051, WORK-052, WORK-053} after live surface/conflict analysis. Declared write surfaces are the new context-economics plane plus the executions seam (read-only) it consults; WORK-051 (tools/sandbox plane) and WORK-053 (planning/model-economics plane) are disjoint. WORK-054 (compute/substrate adapters) is deliberately deferred until a wave slot frees because its executions/compute boundary pins overlap this order's footprint.

# Requirement IDs

No existing product requirement IDs are introduced by this Work Order; it defines the context/cache/reuse economics contracts subordinate to ADR-0019/ADR-0020 and frozen v1.0.

# Declared Change Surfaces

Allowed modules/surfaces: the context-economics plane (context-cost measurement, cache planning, reuse and coalescing decision logic, tenant-safe key derivation, duplication accounting); additive consumption of the execution-compiler's memoization-hook annotations and the WORK-049 decision-record seam; E1.1 context-economics tests/evidence; operator/developer documentation for this surface.

Forbidden to modify frozen architecture v1.0, authorization/policy/capability/budget/secret/tenant/verification semantics, the planner or plan-selection authority, the execution-compiler engine and execution-ir foundation (import/consume only), or `spec/development-state/*` during active implementation.

# Scope Boundaries

Allowed:

- Context-cost measurement: bounded, explicit-basis cost accounting for context/prompt/prefix composition (the estimation-basis contract from WORK-049/050 is the seam).
- Prompt/prefix cache planning: planning-level decisions about what is cacheable, under freshness/semantics/policy/identity constraints; the plan annotations the compiler already emits are the input.
- Reusable artifacts/results: identification of reuse opportunities over the existing artifact seams (read-only), with equivalence evidence.
- Memoization: runtime memoization decision hooks consuming the compiler's memoization-hook annotations (the annotation contract is fixed; this order implements the consumer side).
- Equivalent in-flight work coalescing: detecting equivalent in-flight executions and coalescing joiners onto one leader, with correct fan-out of results and failures.
- Tenant-safe cache keys: key derivation that structurally cannot cross tenant boundaries.
- Duplication accounting: recording what was reused/coalesced/avoided as evidence (decision records through the existing store at the caller's seam).
- Tests: unit, integration over real PostgreSQL when durable semantics are claimed, discrimination/mutation, architecture boundary proofs.
- Evidence: `docs/work-items/WORK-052.md` matching the WORK-048/049/050 pattern.

Forbidden:

- cache as an authority (the cache plan is evidence and mechanism, never an authorization input);
- cross-tenant reuse (tenant-safe keys are structural, not conventional);
- cache-derived authorization (no runtime path may consult cache state for authorization — boundary proof);
- a second execution lifecycle or state machine (coalescing rides the existing executions seam);
- silent staleness (freshness violations must fail closed, not serve stale results);
- modifying the execution-compiler engine or execution-ir foundation (import/consume only);
- modifying frozen v1.0 public contracts;
- modifying `spec/development-state/*` during active implementation;
- self-approval or self-merge.

# Architecture Invariants

1. Reuse/coalescing is permitted ONLY when semantics, freshness, policy and identity all permit it — each check explicit, each failure fail-closed.
2. Cache keys are tenant-safe by construction (tenant identity is a structural key component, not a filter).
3. The cache is never an authority: no authorization path consults cache state (mechanical boundary proof).
4. Coalescing preserves execution semantics: joiners observe exactly the leader's outcome; failures fan out as failures.
5. Context-cost claims carry explicit bases and bounds (the estimation-basis contract); unattributed claims are rejected.
6. Determinism: the same inputs (plan, annotations, cache facts, policy) produce the same cache plan and the same coalescing decisions.
7. Duplication accounting is evidence (decision records), not a ledger of authority.
8. No cross-tenant information flow is representable.

# Acceptance Criteria

1. Context-cost measurement produces bounded, explicit-basis cost estimates for representative context compositions.
2. Prompt/prefix cache planning emits a plan-level cache decision set honoring semantics/freshness/policy/identity constraints.
3. Memoization consumers implement the compiler's memoization-hook annotation contract (hook round-trip proven).
4. Equivalent in-flight work coalescing converges joiners onto one leader with correct result and failure fan-out (real PostgreSQL evidence).
5. Tenant-safe key derivation makes cross-tenant reuse structurally unrepresentable (discrimination proof).
6. Duplication accounting records reuse/coalescing outcomes as decision records through the existing store at the caller's seam.
7. Determinism and idempotence of cache planning are proven.
8. The plane is fully covered by static, dynamic and discrimination/mutation evidence at exact revisions, with honest NOT RUN boundaries.

# Implementation Requirements

- Build ON the WORK-049/050 foundation (IR, decision records, memoization-hook annotations) — do not re-implement or fork it.
- Model cache planning and coalescing decisions as pure functions of (plan IR, annotations, cache facts, policy facts); fail closed on unmet preconditions.
- Consume the compiler's annotations import-only (the context-economics plane is a consumer, not an engine editor).
- Coalescing must ride the existing executions seam read-only at the decision level; any durable state uses the existing decision-record store pattern (append-only).
- Add architecture boundary tests proving the context-economics plane imports only the declared seams, creates no second state machine, and carries no vendor vocabulary.
- Add discrimination/mutation tests: cross-tenant key collisions, stale-freshness serves, cache-authorization consults, torn coalescing fan-out and unattributed cost claims must all be rejected.
- Record exact-revision evidence; never claim unexecuted results as PASS.
- Do not modify `spec/development-state/*`; state transitions are Architect-owned after review/merge.

# Required Checkpoint Contracts

- `TENANT-ISOLATION`
- `ECONOMIC-AUTHORITY-BOUNDARY`
- `DEPENDENCY-DIRECTION`
- `IDENTITY-IDEMPOTENCY`
- `CONCURRENCY-CRASH-SAFETY`
- `EXECUTION-PROVENANCE`
- `IMPLEMENTATION-COMPLETENESS`

# Checkpoints

### TENANT-ISOLATION

Prove cache keys and reuse decisions structurally cannot cross tenant boundaries; cross-tenant reuse is unrepresentable (mutation proof).

### ECONOMIC-AUTHORITY-BOUNDARY

Prove the cache is never an authority: no runtime authorization path consults cache state (mechanical boundary proof).

### DEPENDENCY-DIRECTION

Prove the context-economics plane depends only on the declared seams and the WORK-049/050 foundations; no module depends on it for authority.

### IDENTITY-IDEMPOTENCY

Prove re-planning the cache under the same facts is idempotent: identical decisions, bounded no-op on re-run.

### CONCURRENCY-CRASH-SAFETY

Prove concurrent coalescing of equivalent in-flight work converges (one leader, correct fan-out) and crash mid-coalescing leaves no torn durable state (real PostgreSQL evidence when durable semantics are claimed).

### EXECUTION-PROVENANCE

Prove exact provenance from annotation through cache plan to reuse/coalescing outcome, replayable by deterministic audit.

### IMPLEMENTATION-COMPLETENESS

Prove all scope, acceptance criteria and Required Verification are implemented/tested, forbidden surfaces are untouched, and the evidence package maps each criterion to exact-revision results.

# Evidence Contract

The worker must publish at minimum:

- exact registered base SHA and final head SHA;
- complete changed-file inventory and ancestry proof;
- architecture/dependency/governance checks;
- cache-planning results over representative plan corpora;
- per-feature precondition and decision evidence;
- coalescing convergence results (leader/joiner fan-out, failure fan-out);
- tenant-isolation discrimination results;
- determinism and idempotence proof results;
- real PostgreSQL evidence for any durable semantics claimed;
- discrimination/mutation evidence for every weakened invariant;
- exact CI status;
- exact external-infrastructure limitations, with anything unavailable explicitly NOT RUN rather than claimed PASS.

# Required Verification

## Static

- typecheck;
- lint;
- architecture/dependency boundary tests;
- vendor-vocabulary and secret-flow checks;
- changed-path inspection against this Work Order.

## Dynamic

- cache planning over real governed-plan annotations;
- memoization-hook consumer round-trips;
- coalescing over concurrent equivalent executions (real PostgreSQL when durable semantics are claimed);
- context-cost measurement over representative compositions;
- determinism and idempotence re-runs.

## Discrimination / mutation

- cross-tenant key derivation must be unrepresentable;
- stale-freshness serves must fail closed;
- cache-authorization consults must be impossible (boundary proof);
- torn or duplicated coalescing fan-out must be impossible;
- unattributed or unbounded cost claims must be rejected;
- deterministic re-planning mismatches must be detected.

# Completion

WORK-052 is complete only when all acceptance criteria and required checkpoints have exact-revision evidence, the Architect accepts the PR, the Architect merges it, and post-merge program/dependency/frontier/continuation/handoff state is finalized.

Required branch: `work/WORK-052-context-cache-reuse-economics`

One Work Order = one implementation branch = one PR. The worker cannot approve or merge its own PR.
