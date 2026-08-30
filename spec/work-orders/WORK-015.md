# WORK-015 — Public API, SDKs, CLI and developer dashboard

Status: PENDING

Owner: Architect-assigned implementation worker

Architecture Version: v1.0

Assurance Profile: HIGH_ASSURANCE

# Objective

Expose the execution platform as a stable developer product surface, including governed visibility into registered agents and their versions without making Agent the primary abstraction.

# Context

This Work Order is executable only when all dependencies are complete. The worker must first read `README.md`, `IMPLEMENTATION.md`, `spec/contracts.md`, the governing architecture/lock, development state and requirement traceability, then run the governance checker.

The public product surface should expose the useful agent control-plane inventory/lifecycle information defined by `docs/adr/ADR-0013-agent-control-plane-and-byoa.md`, while preserving the Execution-first architecture.

# Dependencies

Requires: WORK-002, WORK-003, WORK-004, WORK-006, WORK-009, WORK-013

# Requirement IDs

Primary requirements owned by this Work Order:
- `API-001`
- `API-002`
- `API-004`
- `API-005`

Related agent-control-plane surface:
- Agent inventory/catalog inspection and version lifecycle visibility must be exposed through this Work Order when WORK-011 provides the underlying authority; WORK-011 remains authoritative for agent identity/version state.

# Declared Change Surfaces

- `src/api/`
- `sdk/`
- `cli/`
- `apps/dashboard/`

Any file or surface outside these declarations requires a Work Order amendment before modification.

# Scope Boundaries

Allowed:
- files under the declared surfaces and their directly-required tests
- implementation evidence in `docs/work-items/WORK-015.md`

Forbidden:
- rewriting frozen architecture/lock semantics
- changing another Work Order's acceptance scope
- creating a parallel authority/state machine
- importing another module's `internal/` implementation
- importing provider SDKs outside provider adapters
- bypassing policy, verification, budgeting or tenant authorities
- merging the worker's own PR
- creating an independent agent registry or version authority
- exposing raw credentials or secret material through API, SDK, CLI or dashboard

# Architecture Invariants

- Execution remains the primary public abstraction.
- Provider-specific implementation remains behind adapters.
- Policy admission precedes dispatch.
- Customer-domain authority remains outside AI Execution OS.
- Agent inventory/version state is read through the agent module's public authority; this surface does not create a second registry.
- Evidence is durable and revision/provenance-bound.
- Idempotency and concurrency rules are preserved at durable authority boundaries.
- No duplicate authority or second state machine is introduced.

# Acceptance Criteria

1. Implement HTTP endpoints for execution creation, retrieval, cancellation, results, events and policy-visible metadata.
2. Provide TypeScript SDK types centered on Execution rather than provider calls.
3. Provide CLI primitives for submitting and inspecting executions.
4. Provide developer dashboard views for execution receipt, route, cost, artifacts and verification evidence.
5. Implement signed/versioned webhook delivery with retry and idempotent receiver guidance.
6. Never expose secret plaintext or internal authority mutation endpoints.
7. Expose read-only governed views of agent inventory, ownership, active version, available versions and validation/promotion/rollback status when the underlying Agent authority is available.
8. Ensure public agent inventory/lifecycle views cannot mutate agent definitions, credentials, policy or execution state except through their owning authorities.

# Implementation Requirements

1. Use the repository contracts in `IMPLEMENTATION.md` and `spec/contracts.md`.
2. Implement public contracts before adapters/infrastructure where practical.
3. Make failure modes explicit and typed using the canonical error taxonomy.
4. Persist durable authority state transactionally where required.
5. Add tests that prove both the intended behavior and the protected negative case.
6. Treat dashboard/API agent views as projections over `/agents`, not as a second registry.
7. Never return secret references as secret plaintext.

# Required Checkpoint Contracts

- `IMPLEMENTATION-COMPLETENESS`
- `IDENTITY-IDEMPOTENCY`
- `CONCURRENCY-CRASH-SAFETY`
- `SELF-HOSTING-BOUNDARY`

# Checkpoints

Required assurance profile: **HIGH_ASSURANCE**.

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
- API/dashboard reads cannot expose secret plaintext
- agent catalog projection cannot mutate agent authority

# Completion

A worker may open a PR but cannot merge it. The architect is the merge authority. `program-state.json` becomes `complete` only after post-merge finalization records the actual PR number and merge commit.
