# WORK-009 — Model routing and adaptive execution planner

Status: PENDING

Owner: Architect-assigned implementation worker

Architecture Version: v1.0

Assurance Profile: HIGH_ASSURANCE

# Objective

Build deterministic task profiling, capability-first planning and route selection. The planner is an execution-plan optimizer, not merely a model router.

# Context

This Work Order is executable only when all dependencies are complete. The worker must first read `README.md`, `IMPLEMENTATION.md`, `spec/contracts.md`, `spec/planning-contract.md`, the governing architecture/lock, development state and requirement traceability, then run the governance checker.

The approved ACR-001 / ADR-0007 deterministic-first contract is normative for this Work Order: the planner MUST determine whether AI is required before selecting a model/provider/agent and MUST prefer an admissible deterministic capability when it can satisfy the task requirements and effective policy constraints.

# Dependencies

Requires: WORK-005, WORK-006, WORK-007, WORK-008

# Requirement IDs

Primary requirements owned by this Work Order:
- `INT-001`
- `INT-003`
- `INT-004`

Related requirements that this implementation must satisfy at the planning boundary:
- `INT-002` — capability requirements precede provider/model selection
- `DTR-001` — deterministicizable recurring subgraphs are representable as planning candidates
- `DTR-004` — plan decisions expose evidence/confidence/rationale sufficient for later deterministicization learning

# Declared Change Surfaces

- `src/modules/planning/`
- `src/modules/executions/`

Any file or surface outside these declarations requires a Work Order amendment before modification.

# Scope Boundaries

Allowed:
- files under the declared surfaces and their directly-required tests
- implementation evidence in `docs/work-items/WORK-009.md`
- narrowly scoped planning-contract test fixtures required to prove the frozen planner boundary

Forbidden:
- rewriting frozen architecture/lock semantics
- changing another Work Order's acceptance scope
- creating a parallel authority/state machine
- importing another module's `internal/` implementation
- importing provider SDKs outside provider adapters
- bypassing policy, verification, budgeting or tenant authorities
- merging the worker's own PR
- treating a model/provider as the default execution mechanism before deterministic sufficiency is evaluated
- adding hidden AI calls to perform work that an admissible deterministic capability can satisfy

# Architecture Invariants

- Execution remains the primary public abstraction.
- Provider-specific implementation remains behind adapters.
- Policy admission precedes dispatch.
- Capability selection precedes provider/model selection.
- Deterministic computation is a first-class execution capability.
- The planner MUST evaluate deterministic sufficiency before generative inference selection.
- A valid execution plan may contain zero model calls.
- AI and deterministic computation may be combined in one plan.
- Customer-domain authority remains outside AI Execution OS.
- Evidence is durable and revision/provenance-bound.
- Idempotency and concurrency rules are preserved at durable authority boundaries.
- No duplicate authority or second state machine is introduced.

# Acceptance Criteria

1. Create a structured `TaskProfile` from task input, constraints, required output characteristics, risk and quality targets.
2. Generate immutable execution plans as typed DAGs of the supported step classes.
3. Resolve capabilities before any provider/model/agent implementation is selected.
4. Perform an explicit deterministic sufficiency check before generative selection.
5. Select a deterministic-only plan when an admissible deterministic capability can satisfy the task without materially reducing the verified outcome.
6. Represent hybrid plans in which deterministic preprocessing/computation surrounds or constrains generative reasoning.
7. Support cheap-first/cascade planning and verification-triggered replanning.
8. Persist the chosen plan, candidate strategies, route rationale, deterministic-sufficiency decision and policy inputs so the decision is auditable.
9. Prove a forbidden provider is never selected even when it appears cheapest/highest scoring.
10. Prove an always-generative planner mutant is rejected when a sufficient deterministic capability exists and no material verified advantage justifies AI.
11. Prove a no-model execution is a valid successful plan and does not fabricate a model/provider route.
12. Expose enough structured planning evidence for future learning/deterministicization systems to identify which plan subgraphs were expensive, repeated and potentially replaceable.

# Implementation Requirements

1. Use the repository contracts in `IMPLEMENTATION.md`, `spec/contracts.md` and `spec/planning-contract.md`.
2. Implement public contracts before adapters/infrastructure where practical.
3. Make failure modes explicit and typed using the canonical error taxonomy.
4. Persist durable authority state transactionally where required.
5. Add tests that prove both the intended behavior and the protected negative case.
6. Treat deterministic candidates as first-class plan candidates with explicit capability identity, estimated cost, expected quality and verification strategy.
7. Do not encode “use a model” as a fallback that is silently taken when the deterministic capability registry is sufficient.
8. Where deterministic sufficiency is uncertain, allow a bounded evaluation/compare path rather than defaulting blindly to generative inference.

# Required Checkpoint Contracts

- `IMPLEMENTATION-COMPLETENESS`
- `IDENTITY-IDEMPOTENCY`
- `CONCURRENCY-CRASH-SAFETY`
- `SELF-HOSTING-BOUNDARY`

# Checkpoints

Required assurance profile: **HIGH_ASSURANCE**.

The applicable blocking contracts are enumerated in `spec/governance/checkpoint-contract.json`. Checkpoint results are evidence, not completion authority.

In addition to the generic HIGH_ASSURANCE checkpoints, this Work Order requires an explicit deterministic-first discrimination proof covering the ACR-001 / ADR-0007 contract.

# Evidence Contract

The worker must update `docs/work-items/WORK-NNN.md` with exact revision, changed files, requirement IDs, test commands/results, checkpoint evidence, discrimination evidence where required, known limitations and PR binding. Claims without objective evidence do not satisfy completion.

# Required Verification

- `python3 scripts/governance-check.py`
- `bun run typecheck`
- `bun run lint`
- targeted unit/integration suites listed in the Implementation Requirements
- real PostgreSQL integration for durable execution-plan persistence, idempotency, concurrency or planning-decision state where applicable
- at least one discrimination/mutation test for every HIGH_ASSURANCE safety boundary explicitly named above
- a planner discrimination test that fails an implementation which always selects generative inference when a sufficient deterministic capability is available
- a planner test proving that a valid execution may contain zero model calls
- a planner test proving provider selection is downstream of capability/deterministic sufficiency decisions

# Completion

A worker may open a PR but cannot merge it. The architect is the merge authority. `program-state.json` becomes `complete` only after post-merge finalization records the actual PR number and merge commit.
