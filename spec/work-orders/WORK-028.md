# WORK-028 — Long-running and resumable execution

Status: PENDING

Owner: Architect-assigned implementation worker

Architecture Version: v1.0

Assurance Profile: CRITICAL

# Objective

Extend Zeck so executions can safely run for hours or days with checkpoints, interruption, resume, scheduling and resource re-admission while retaining the same execution identity.

# Context

Long-running agents and workloads must survive process loss, transient infrastructure failures, human interruption and resource changes without creating duplicate executions or silently bypassing policy.

# Dependencies

Requires: WORK-006, WORK-007, WORK-010, WORK-011, WORK-012, WORK-031

# Requirement IDs

- `LNG-001`
- `LNG-002`
- `LNG-003`

# Declared Change Surfaces

- `src/modules/executions/`
- `src/modules/agents/`
- `src/modules/sandbox/`

# Scope Boundaries

Allowed:
- checkpoint and resume protocols
- lease/heartbeat management
- safe interruption and termination requests
- scheduling/wake-up metadata
- resource re-admission on resume

Forbidden:
- changing the frozen lifecycle authority without a governed architecture decision
- bypassing policy/budget/capability checks on resume
- creating a second execution identity
- treating stale workers as authoritative
- merging the worker's own PR

# Architecture Invariants

- Execution identity is stable across pause, resume, retry and recovery.
- Every resume passes through current authority checks before side effects.
- Only one owner of a live mutable execution lease is authoritative at a time.
- Checkpoints are durable, provenance-linked and integrity-protected.
- Human interruption remains authoritative and auditable.

# Acceptance Criteria

1. Checkpoint an in-flight execution and resume it without changing execution identity.
2. Recover from worker/process loss without creating duplicate authoritative execution state.
3. Enforce lease expiry/renewal and prevent stale workers from committing side effects.
4. Re-run current policy/budget/capability admission on materially changed resumes where required.
5. Support explicit human interruption and governed termination.
6. Prove concurrent resume attempts converge safely and do not duplicate side effects.

# Implementation Requirements

- Checkpoint contents must identify execution, plan/revision, context/artifacts and last durable event position.
- Resume must validate checkpoint integrity and reject incompatible revisions.
- Lease conflicts must fail closed.
- Crash recovery must distinguish committed external effects from reversible internal work.

# Required Checkpoint Contracts

- `CONCURRENCY-CRASH-SAFETY`
- `EXECUTION-PROVENANCE`

# Checkpoints

- readiness: dependency and declared-surface verification before implementation
- concurrency: lease ownership and concurrent resume arbitration proven
- recovery: crash/resume behavior proven without duplicate authoritative side effects

# Evidence Contract

Evidence must identify the exact implementation and final branch heads, map LNG requirements to tests, and include real concurrency/crash results. Any external side-effect behavior must have provenance and a clear authoritative owner.

# Required Verification

- governance checker
- typecheck
- lint
- checkpoint/recovery integration tests
- lease concurrency tests
- stale-worker discrimination
- crash/restart tests with real PostgreSQL
- interruption/resume provenance tests
- side-effect duplication discrimination

# Completion

Worker opens a PR but does not merge. Completion requires architect acceptance and post-merge finalization.
