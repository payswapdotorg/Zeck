# WORK-016 — WorkflowOS integration adapter and benchmark harness

Status: PENDING

Owner: Architect-assigned implementation worker

Architecture Version: v1.0

Assurance Profile: HIGH_ASSURANCE

# Objective

Integrate WorkflowOS without duplicating its workflow authority, and provide a governed BYOA interoperability path for externally-built agents.

# Context

This Work Order is executable only when all dependencies are complete. The worker must first read `README.md`, `IMPLEMENTATION.md`, `spec/contracts.md`, the governing architecture/lock, development state and requirement traceability, then run the governance checker.

The agent control-plane extension in `docs/adr/ADR-0013-agent-control-plane-and-byoa.md` is normative for external/BYOA agent interoperability. External agent frameworks remain implementation details behind provider-neutral adapters; Execution remains the shared public primitive.

# Dependencies

Requires: WORK-006, WORK-007, WORK-009, WORK-010, WORK-011, WORK-013, WORK-015

# Requirement IDs

Primary requirements owned by this Work Order:
- `WOS-001`
- `WOS-002`
- `WOS-003`
- `WOS-004`
- `AGT-007`
- `ACP-005`

# Declared Change Surfaces

- `src/integrations/workflowos/`
- `benchmarks/`

Any file or surface outside these declarations requires a Work Order amendment before modification.

# Scope Boundaries

Allowed:
- files under the declared surfaces and their directly-required tests
- implementation evidence in `docs/work-items/WORK-016.md`

Forbidden:
- rewriting frozen architecture/lock semantics
- changing another Work Order's acceptance scope
- creating a parallel authority/state machine
- importing another module's `internal/` implementation
- importing provider SDKs outside provider adapters
- bypassing policy, verification, budgeting or tenant authorities
- merging the worker's own PR
- implementing the core Agent registry/version authority owned by WORK-011
- mutating WorkflowOS workflow state directly from the integration adapter

# Architecture Invariants

- Execution remains the primary public abstraction.
- Provider-specific implementation remains behind adapters.
- Policy admission precedes dispatch.
- Customer-domain authority remains outside AI Execution OS.
- WorkflowOS remains authoritative for WorkflowOS workflow state.
- External agent frameworks are governed through a provider-neutral adapter and cannot create a second Zeck execution/policy authority.
- Evidence is durable and revision/provenance-bound.
- Idempotency and concurrency rules are preserved at durable authority boundaries.
- No duplicate authority or second state machine is introduced.

# Acceptance Criteria

1. Define a provider-neutral WorkflowOS execution submission adapter.
2. Map WorkflowOS work/session/workspace/tool concepts to Execution OS capabilities without creating duplicate state machines.
3. Return execution receipts, artifacts and verification evidence to WorkflowOS.
4. Prove the adapter cannot mutate WorkflowOS workflow state directly.
5. Create a benchmark harness comparing execution strategies on representative governed tasks.
6. Provide a provider-neutral BYOA adapter contract that can register an externally-built agent/framework as an Execution participant without exposing framework-specific types through public Zeck contracts.
7. Prove an external/BYOA adapter cannot bypass Zeck policy, capability, budget, tenant, verification or execution authorities.
8. Benchmark BYOA agents against native Zeck agent participants using the same execution/evidence contract.

# Implementation Requirements

1. Use the repository contracts in `IMPLEMENTATION.md` and `spec/contracts.md`.
2. Implement public contracts before adapters/infrastructure where practical.
3. Make failure modes explicit and typed using the canonical error taxonomy.
4. Persist durable authority state transactionally where required.
5. Add tests that prove both the intended behavior and the protected negative case.
6. Reuse `/executions`, `/policies`, `/capabilities`, `/budgets`, `/agents` and `/verification` authorities rather than recreating them.
7. Keep framework-specific integration details entirely within the adapter surface.
8. Treat external agents as governed participants, not as a privileged bypass path.

# Required Checkpoint Contracts

- `IMPLEMENTATION-COMPLETENESS`
- `IDENTITY-IDEMPOTENCY`
- `CONCURRENCY-CRASH-SAFETY`
- `SELF-HOSTING-BOUNDARY`

# Checkpoints

Required assurance profile: **HIGH_ASSURANCE**.

The applicable blocking contracts are enumerated in `spec/governance/checkpoint-contract.json`. Checkpoint results are evidence, not completion authority.

Additional blocking boundaries:
- BYOA authority boundary
- WorkflowOS no-mutation boundary
- framework-neutral public contract boundary

# Evidence Contract

The worker must update `docs/work-items/WORK-NNN.md` with exact revision, changed files, requirement IDs, test commands/results, checkpoint evidence, discrimination evidence where required, known limitations and PR binding. Claims without objective evidence do not satisfy completion.

# Required Verification

- `python3 scripts/governance-check.py`
- `bun run typecheck`
- `bun run lint`
- targeted unit/integration suites listed in the Implementation Requirements
- real PostgreSQL integration for identity/idempotency/concurrency/durable adapter state where applicable
- at least one discrimination/mutation test for every HIGH_ASSURANCE boundary explicitly named above
- external-framework types cannot leak into provider-neutral contracts
- BYOA adapter cannot bypass any Zeck authority
- WorkflowOS adapter cannot mutate workflow state directly

# Completion

A worker may open a PR but cannot merge it. The architect is the merge authority. `program-state.json` becomes `complete` only after post-merge finalization records the actual PR number and merge commit.
