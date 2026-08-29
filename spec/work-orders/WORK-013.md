# WORK-013 — Verification, evaluators and quality gates

Status: PENDING

Owner: Architect-assigned implementation worker

Architecture Version: v1.0

Assurance Profile: CRITICAL

# Objective

Make verification an independent evidence authority over execution quality.

# Context

This Work Order is executable only when all dependencies are complete. The worker must first read `README.md`, `IMPLEMENTATION.md`, `spec/contracts.md`, the governing architecture/lock, development state and requirement traceability, then run the governance checker.

# Dependencies

Requires: WORK-006, WORK-009, WORK-010, WORK-011

# Requirement IDs

Primary requirements owned by this Work Order:
- `INT-005`
- `VER-001`
- `VER-002`
- `VER-003`
- `VER-004`

# Declared Change Surfaces

- `src/modules/verification/`
- `src/modules/executions/`

Any file or surface outside these declarations requires a Work Order amendment before modification.

# Scope Boundaries

Allowed:
- files under the declared surfaces and their directly-required tests
- implementation evidence in `docs/work-items/WORK-013.md`

Forbidden:
- rewriting frozen architecture/lock semantics
- changing another Work Order's acceptance scope
- creating a parallel authority/state machine
- importing another module's `internal/` implementation
- importing provider SDKs outside provider adapters
- bypassing policy, verification, budgeting or tenant authorities
- merging the worker's own PR

# Architecture Invariants

- Execution remains the primary public abstraction.
- Provider-specific implementation remains behind adapters.
- Policy admission precedes dispatch.
- Customer-domain authority remains outside AI Execution OS.
- Evidence is durable and revision/provenance-bound.
- Idempotency and concurrency rules are preserved at durable authority boundaries.
- No duplicate authority or second state machine is introduced.

# Acceptance Criteria

1. Define VerificationResult and evaluator contracts with PASS/FAIL/INCONCLUSIVE status and evidence.
2. Implement deterministic, model-based and human/user verification adapter interfaces.
3. Attach verification results to execution/plan revisions and artifacts.
4. Allow replanning/escalation when required criteria are unmet.
5. Prove provider HTTP success cannot by itself produce verification PASS.
6. Gate candidate comparison and human escalation through explicit policy/planner decisions.

# Implementation Requirements

1. Use the repository contracts in `IMPLEMENTATION.md` and `spec/contracts.md`.
2. Implement public contracts before adapters/infrastructure where practical.
3. Make failure modes explicit and typed using the canonical error taxonomy.
4. Persist durable authority state transactionally where required.
5. Add tests that prove both the intended behavior and the protected negative case.

# Required Checkpoint Contracts

- `IMPLEMENTATION-COMPLETENESS`
- `IDENTITY-IDEMPOTENCY`
- `CONCURRENCY-CRASH-SAFETY`
- `SELF-HOSTING-BOUNDARY`
- `VERIFICATION-SEPARATION`
- `EXECUTION-PROVENANCE`

# Checkpoints

Required assurance profile: **CRITICAL**.

The applicable blocking contracts are enumerated in `spec/governance/checkpoint-contract.json`. Checkpoint results are evidence, not completion authority.


# Evidence Contract

The worker must update `docs/work-items/WORK-NNN.md` with exact revision, changed files, requirement IDs, test commands/results, checkpoint evidence, discrimination evidence where required, known limitations and PR binding. Claims without objective evidence do not satisfy completion.

# Required Verification

- `python3 scripts/governance-check.py`
- `bun run typecheck`
- `bun run lint`
- targeted unit/integration suites listed in the Implementation Requirements
- real PostgreSQL integration for schema, accounting, identity, idempotency, concurrency or durable execution work
- at least one discrimination/mutation test for every CRITICAL/HIGH_ASSURANCE safety boundary explicitly named above

# Completion

A worker may open a PR but cannot merge it. The architect is the merge authority. `program-state.json` becomes `complete` only after post-merge finalization records the actual PR number and merge commit.
