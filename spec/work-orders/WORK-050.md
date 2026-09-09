# WORK-050 — Deterministic Execution Compiler

Status: AUTHORIZED / PENDING

Owner: Implementation worker; Architect retains review, merge and state-finalization authority

Architecture Version: v1.0 (frozen); Execution Intelligence Architecture E1.0 + Economic Execution Intelligence E1.1 (ADR-0019, ADR-0020)

Assurance Profile: HIGH_ASSURANCE

# Objective

Implement the E1.1 charter stage 2: the compiler engine that transforms a governed, validated Execution IR (WORK-049) into an optimized IR using only semantics-preserving transformations under explicit, recorded preconditions — the single optimization mechanism ADR-0020 designates, with no new authorities.

# Dependencies

Requires: WORK-049

Enables: the E1.1 parallel wave (WORK-051, WORK-052, WORK-053, WORK-054) and through it WORK-055, WORK-056.

# Requirement IDs

No existing product requirement IDs are introduced by this Work Order; it defines the execution-compiler transformation contracts subordinate to ADR-0019/ADR-0020 and frozen v1.0.

# Declared Change Surfaces

Allowed modules/surfaces: the deterministic execution compiler (transformation engine, transformation catalog, precondition checking, optimization pass pipeline over the WORK-049 IR); semantics-preservation proofs and equivalence validation; optimization decision-record integration (the compiler is the legitimate decision-record author/reader per WORK-049's design); the canonical representation ladder selection hooks (model/effort selection hooks — hooks only, no live selection); E1.1 compiler tests/evidence; operator/developer documentation for the compiler surface.

Forbidden to modify frozen architecture v1.0, authoritative execution/policy/capability/budget/secret/tenant/verification semantics, the planner or plan-selection authority, or `spec/development-state/*` during active implementation.

# Scope Boundaries

Allowed:

- The compiler engine: pass pipeline, bounded iteration, deterministic ordering, total validation of every output IR.
- Semantics-preserving transformations: constant folding, dead-step elimination, common-subexpression reuse, memoization hooks, safe parallelization, batching, result shaping, retry normalization, deterministic/probabilistic subgraph decomposition, verification insertion, model/effort selection hooks.
- Explicit preconditions per transformation: every pass records its preconditions and is rejected (fail-closed) when they do not hold.
- Equivalence/validation machinery: output IR re-validation, losslessness proofs, discrimination against semantics-violating transformations.
- Optimization decision records: the compiler writes decision records (the WORK-049 evidence contract is the output format) with provenance and bounded cost claims.
- Tests: unit, integration over real PostgreSQL when durable semantics are claimed, discrimination/mutation, architecture boundary proofs.
- Evidence: `docs/work-items/WORK-050.md` matching the WORK-048/WORK-049 pattern.

Forbidden:

- changing any authorization, policy, capability or budget semantics (authorization changes);
- duplicating execution state or introducing a second execution lifecycle (execution-state duplication);
- autonomous capability expansion (the compiler may not grant or widen capabilities);
- live model/provider/substrate selection behavior (hooks only; live selection is later E1.1 stages);
- non-semantics-preserving transformations presented as optimizations;
- creating a new authority or durable state machine beyond the WORK-049 decision-record store;
- modifying frozen v1.0 public contracts;
- modifying `spec/development-state/*` during active implementation;
- self-approval or self-merge.

# Architecture Invariants

1. Every transformation is semantics-preserving and proven so by validation, never assumed.
2. Every pass runs under explicit preconditions; unmet preconditions fail closed.
3. The compiler is the single optimization mechanism; it composes transformations, it does not create authorities.
4. Optimized IR output is always valid per the WORK-049 IR invariant validation (the closed 12-code vocabulary).
5. Determinism: the same input IR + constraints + transformation set produce the same output IR and the same decision record.
6. Decision records remain evidence; the compiler records them, no runtime path consults them for authorization.
7. The representation ladder preference (cheapest sufficient first) is a decision preference, not a mandatory pipeline.
8. Quality-preserving economics: an optimization below the assurance threshold is invalid regardless of cost.

# Acceptance Criteria

1. A validated Execution IR can be transformed into an optimized IR through a bounded, deterministic pass pipeline with total output validation.
2. Each catalogued transformation (constant folding, dead-step elimination, common-subexpression reuse, memoization hooks, safe parallelization, batching, result shaping, retry normalization, subgraph decomposition, verification insertion, model/effort selection hooks) is implemented with explicit preconditions and semantics-preservation evidence.
3. Transformations whose preconditions do not hold, or whose outputs violate IR invariants or plan semantics, are rejected with typed, bounded errors.
4. Every material optimization decision produces a WORK-049-format decision record (constraints, candidates, selected representation, cost/latency expectations, quality expectation, transformation basis, provenance) with bounded cost claims.
5. Determinism is proven: identical inputs produce identical outputs and identical decision records (including tie-breaking).
6. The compiler creates no new authority or durable state beyond the decision-record store, and no execution path consults decision records for authorization (boundary proof).
7. When durable semantics are claimed, real PostgreSQL evidence is provided.
8. The compiler is fully covered by static, dynamic and discrimination/mutation evidence at exact revisions, with honest NOT RUN boundaries.

# Implementation Requirements

- Build on the WORK-049 foundation (IR, constraints, cost model, decision records) — do not re-implement or fork it.
- Make every pass a pure function of (input IR, constraints, configuration); record preconditions; fail closed when unmet.
- Validate every output IR with the WORK-049 invariant validation before it can be emitted; equivalence machinery proves semantics preservation (canonical-form comparison, digest losslessness).
- Bound iteration (no unbounded fixpoints); the pipeline terminates deterministically.
- Keep the representation ladder hooks as decision points that record decisions; live selection behavior is out of scope.
- Use the closed transformation-basis vocabulary in decision records (consistent with the WORK-049 schema).
- Add architecture boundary tests proving the compiler imports only the IR foundation + declared seams, creates no state machine, and carries no vendor vocabulary.
- Add discrimination/mutation tests: semantics-violating transformations, precondition violations, non-deterministic orderings, unbounded costs, and below-threshold quality selections must all be rejected.
- Record exact-revision evidence; never claim unexecuted results as PASS.
- Do not modify `spec/development-state/*`; state transitions are Architect-owned after review/merge.

# Required Checkpoint Contracts

- `ECONOMIC-AUTHORITY-BOUNDARY`
- `DEPENDENCY-DIRECTION`
- `IDENTITY-IDEMPOTENCY`
- `EXECUTION-PROVENANCE`
- `VERIFICATION-SEPARATION`
- `CONCURRENCY-CRASH-SAFETY`
- `IMPLEMENTATION-COMPLETENESS`

# Checkpoints

### ECONOMIC-AUTHORITY-BOUNDARY

Prove compiler decisions and cost claims stay bounded evidence with explicit bases; budgets/policy/capabilities remain the authorities; no runtime authorization consults decision records.

### DEPENDENCY-DIRECTION

Prove the compiler depends only on the IR foundation and declared seams; no module depends on the compiler for authority.

### IDENTITY-IDEMPOTENCY

Prove re-compiling the same IR with the same constraints and configuration is idempotent: same output, same decision records, bounded no-op on re-run.

### EXECUTION-PROVENANCE

Prove exact provenance from input IR through every transformation to output IR and decision record, replayable by deterministic audit.

### VERIFICATION-SEPARATION

Prove verification insertion references the verification authority's contracts; the compiler never redefines quality gates.

### CONCURRENCY-CRASH-SAFETY

Prove concurrent compilations of the same or different IRs converge with no duplicate or torn decision records (real PostgreSQL evidence when durable semantics are claimed).

### IMPLEMENTATION-COMPLETENESS

Prove all scope, acceptance criteria and Required Verification are implemented/tested, forbidden surfaces are untouched, and the evidence package maps each criterion to exact-revision results.

# Evidence Contract

The worker must publish at minimum:

- exact registered base SHA and final head SHA;
- complete changed-file inventory and ancestry proof;
- architecture/dependency/governance checks;
- pass-pipeline results over real IR corpora;
- per-transformation precondition and semantics-preservation evidence;
- equivalence/validation results (losslessness, canonical-form comparison);
- decision-record round-trip and provenance audit results;
- determinism proof results (identical inputs → identical outputs/records);
- real PostgreSQL evidence for any durable semantics claimed;
- discrimination/mutation evidence for every weakened invariant;
- optimization decision examples (cheaper chosen and not-chosen with bases);
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

- compilation of real governed-plan IRs through the full pipeline;
- per-transformation dynamic evidence over representative IR shapes;
- decision-record creation and audit round-trips;
- determinism and idempotence re-runs;
- real PostgreSQL evidence when durable semantics are claimed.

## Discrimination / mutation

- semantics-violating transformations must be rejected;
- precondition violations must fail closed;
- non-deterministic orderings must be detected/rejected;
- unbounded or unattributed cost claims must be rejected;
- below-threshold quality selections must be rejected;
- decision records consulted for authorization must be impossible (boundary proof);
- torn or duplicate decision records under concurrent compilation must be impossible.

# Completion

WORK-050 is complete only when all acceptance criteria and required checkpoints have exact-revision evidence, the Architect accepts the PR, the Architect merges it, and post-merge program/dependency/frontier/continuation/handoff state is finalized.

Required branch: `work/WORK-050-deterministic-execution-compiler`

One Work Order = one implementation branch = one PR. The worker cannot approve or merge its own PR.
