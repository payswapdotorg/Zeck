# WORK-049 — Execution IR and outcome-economics foundation

Status: AUTHORIZED / PENDING

Owner: Implementation worker; Architect retains review, merge and state-finalization authority

Architecture Version: v1.0 (frozen); Execution Intelligence Architecture E1.0 + Economic Execution Intelligence E1.1 (ADR-0019, ADR-0020)

Assurance Profile: HIGH_ASSURANCE

# Objective

Establish the E1.1 foundation (charter stage 1) so a governed plan can be represented as a machine-readable, optimizable Execution IR with deterministic validation and auditable optimization decision evidence, without replacing the existing planner or execution authority and without introducing a new optimizer service.

# Dependencies

Requires: WORK-048

Enables: WORK-050 (Deterministic Execution Compiler), and through it the full E1.1 sequence.

# Requirement IDs

No existing product requirement IDs are introduced by this Work Order; it defines the Execution IR, optimization-constraint, outcome-economics and decision-evidence contracts subordinate to ADR-0019/ADR-0020 and frozen v1.0.

# Declared Change Surfaces

Allowed modules/surfaces: the Execution IR foundation (machine-readable plan representation, hard/soft optimization constraints, expected successful-resolution cost model, optimization decision record, provenance, invariant validation); minimal existing seam consumption from planning (plan derivation inputs), executions (plan lifecycle/step identity) and budgets (read-only cost constraints); E1.1 foundation tests/evidence; operator/developer documentation for the IR surface.

Forbidden to modify frozen architecture v1.0, authoritative execution/policy/capability/budget/secret/tenant/verification semantics, the planner or execution lifecycle authority, or `spec/development-state/*` during active implementation.

# Scope Boundaries

Allowed:

- Machine-readable Execution IR for governed plans (steps, dataflow, capability/tool/model references, verification anchors, side-effect classes).
- Deterministic IR validation: schema, structural, authority-boundary and invariant checks.
- Hard and soft optimization constraints (policy, capability, budget, quality/reliability, latency, verification, side-effect constraints) represented and validated.
- Expected successful-resolution cost model over candidate representations (constraints → candidates → observed/estimated cost → selection basis).
- Optimization decision records with provenance (input constraints, candidate representations, cost/latency expectations, quality expectation, transformation basis, provenance) as evidence.
- Provenance and identity preservation from governed plan to IR and decision records.
- Tests: unit, integration over real PostgreSQL when durable semantics are claimed, discrimination/mutation, architecture boundary proofs.
- Evidence: `docs/work-items/WORK-049.md` matching the WORK-048 pattern.

Forbidden:

- replacing the existing planner, plan selection or execution authority;
- creating a new optimizer/execution-compiler engine (that is WORK-050);
- creating a new optimization authority, durable state machine or provider registry (ADR-0020 non-redundancy rule);
- speculative provider integration (live model/substrate/provider selection behavior);
- executing optimizations at runtime — this order builds the representation and evidence foundation only;
- changing frozen v1.0 domain semantics or public contracts;
- modifying `spec/development-state/*` during active implementation;
- self-approval or self-merge.

# Architecture Invariants

1. The Execution IR is a representation of a governed plan, never a second plan authority.
2. IR validation is deterministic and total: invalid, unsafe or authority-violating representations are rejected before use.
3. Hard constraints are enforced by validation; soft constraints are recorded, never silently enforced.
4. The cost model produces bounded, auditable expected-cost claims with an explicit estimation basis — never unbounded or unattributed numbers.
5. Optimization decision records are evidence only; they never authorize an action.
6. Provenance from plan to IR to decision record is exact and replayable.
7. No new durable state machine is introduced for any optimization concern.
8. Provider/runtime mechanisms remain behind neutral contracts; no vendor vocabulary enters the IR foundation.

# Acceptance Criteria

1. A governed plan can be converted to a machine-readable Execution IR and validated deterministically, with the conversion lossless with respect to plan semantics (identity, steps, dataflow, capability references, verification anchors, side-effect classes).
2. Hard and soft optimization constraints from the governing authorities (policy, capability, budget, quality/reliability, latency, verification, side effects) are represented in the IR and enforced by validation where hard, recorded where soft.
3. The expected successful-resolution cost model evaluates candidate representations and records bounded expected-cost claims with an explicit estimation basis and quality/reliability expectation.
4. Every material optimization decision is recorded as a decision record with input constraints, candidate representations, selected representation, cost/latency expectations, quality expectation, transformation basis and provenance.
5. IR invariant validation rejects authority-violating representations (second-authority plans, duplicated execution identity, unattributed costs, provider-vendor semantics, missing provenance) with typed, bounded errors.
6. Plan identity and provenance are preserved end-to-end from the governed plan through the IR to decision records, and are verifiable by deterministic audit.
7. When durable semantics are claimed (persisted decision records or provenance), real PostgreSQL evidence is provided and the durable store remains the sole authority.
8. The foundation is fully covered by static, dynamic and discrimination/mutation evidence at exact revisions, with honest NOT RUN boundaries for anything not executed.

# Implementation Requirements

- Derive the IR from the existing governed plan surfaces through declared minimal seams; do not duplicate plan state.
- Make IR validation total and deterministic; every rejection is a typed, bounded error naming the violated invariant.
- Represent constraints exactly as the governing authorities define them; do not invent policy, capability or budget semantics.
- Bound every cost claim with its estimation basis (observed, estimated or defaulted) and quality/reliability threshold per ADR-0020.
- Keep decision records append-only evidence; no execution path may consult them for authorization.
- Use real PostgreSQL for any durable decision-record/provenance store; no second durable authority.
- Add architecture boundary tests proving the IR foundation imports no module internals, carries no vendor vocabulary and creates no state machine.
- Add discrimination/mutation tests for every weakened invariant (each must fail closed).
- Record exact-revision evidence for all acceptance criteria; never claim unexecuted results as PASS.
- Do not modify `spec/development-state/*`; state transitions are Architect-owned after review/merge.

# Required Checkpoint Contracts

- `ECONOMIC-AUTHORITY-BOUNDARY`
- `DEPENDENCY-DIRECTION`
- `IDENTITY-IDEMPOTENCY`
- `EXECUTION-PROVENANCE`
- `VERIFICATION-SEPARATION`
- `IMPLEMENTATION-COMPLETENESS`

# Checkpoints

### ECONOMIC-AUTHORITY-BOUNDARY

Prove the cost model and decision records never become economic authorities: budgets remain authoritative, cost claims are bounded evidence with explicit bases, and no execution path consults decision records for authorization.

### DEPENDENCY-DIRECTION

Prove the IR foundation depends only on declared platform/module seams (planning, executions, budgets read-only); no module may depend on the IR foundation for authority.

### IDENTITY-IDEMPOTENCY

Prove plan identity, execution identity and decision-record identity are preserved and idempotent: re-derivation produces the same IR, and re-recording the same decision is a bounded no-op.

### EXECUTION-PROVENANCE

Prove exact provenance from governed plan to IR to decision record, replayable and verifiable by deterministic audit.

### VERIFICATION-SEPARATION

Prove verification/quality-gate contracts stay authoritative in the verification authority; the IR only anchors and references them.

### IMPLEMENTATION-COMPLETENESS

Prove all scope, acceptance criteria and Required Verification are implemented/tested, forbidden surfaces are untouched, and the evidence package maps each criterion to exact-revision results.

# Evidence Contract

The worker must publish at minimum:

- exact registered base SHA and final head SHA;
- complete changed-file inventory and ancestry proof;
- architecture/dependency/governance checks;
- IR validation results over governed-plan corpora;
- constraint representation and validation results;
- cost-model evaluation results with estimation bases;
- decision-record round-trip and provenance audit results;
- real PostgreSQL evidence for any durable semantics claimed;
- discrimination/mutation evidence for every weakened invariant;
- optimization decision examples showing why a cheaper representation was or was not chosen;
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

- IR derivation and validation over real governed plans;
- constraint validation (hard enforced, soft recorded);
- cost-model evaluation over candidate representations;
- decision-record creation, round-trip and provenance audit;
- real PostgreSQL evidence when durable semantics are claimed.

## Discrimination / mutation

- authority-violating IR must be rejected (second authority, duplicated identity, unattributed cost, vendor semantics, missing provenance);
- weakened hard constraints must fail closed;
- unbounded or unattributed cost claims must be rejected;
- decision records consulted for authorization must be impossible (boundary proof);
- re-derivation drift must be detected;
- durable decision records outside the authoritative store must be rejected.

# Completion

WORK-049 is complete only when all acceptance criteria and required checkpoints have exact-revision evidence, the Architect accepts the PR, the Architect merges it, and post-merge program/dependency/frontier/continuation/handoff state is finalized.

Required branch: `work/WORK-049-execution-ir-outcome-economics-foundation`

One Work Order = one implementation branch = one PR. The worker cannot approve or merge its own PR.
