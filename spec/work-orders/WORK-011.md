# WORK-011 — Agent fabric, sessions and workspaces

Status: PENDING

Owner: Architect-assigned implementation worker

Architecture Version: v1.0

Assurance Profile: HIGH_ASSURANCE

# Objective

Implement agents as distinct execution participants composed from models, tools, workspace and policy, while giving them the production control-plane properties needed for governed operation.

# Context

This Work Order is executable only when all dependencies are complete. The worker must first read `README.md`, `IMPLEMENTATION.md`, `spec/contracts.md`, the governing architecture/lock, development state and requirement traceability, then run the governance checker.

The agent control-plane extension in `docs/adr/ADR-0013-agent-control-plane-and-byoa.md` is normative for this Work Order. Agent remains a strategy/participant inside an Execution; Zeck does not become an agent framework.

# Dependencies

Requires: WORK-006, WORK-007, WORK-010

# Requirement IDs

Primary requirements owned by this Work Order:
- `AGT-001`
- `AGT-002`
- `AGT-003`
- `AGT-004`
- `AGT-005`
- `AGT-006`
- `AGT-008`
- `ACP-001`
- `ACP-002`
- `ACP-003`
- `ACP-004`
- `ACP-006`

Related requirement owned elsewhere:
- `AGT-007` / `ACP-005` — WORK-016 owns external/BYOA interoperability.

# Declared Change Surfaces

- `src/modules/agents/`

Any file or surface outside these declarations requires a Work Order amendment before modification.

# Scope Boundaries

Allowed:
- files under the declared surfaces and their directly-required tests
- implementation evidence in `docs/work-items/WORK-011.md`

Forbidden:
- rewriting frozen architecture/lock semantics
- changing another Work Order's acceptance scope
- creating a parallel authority/state machine
- importing another module's `internal/` implementation
- importing provider SDKs outside provider adapters
- bypassing policy, verification, budgeting or tenant authorities
- merging the worker's own PR
- making Agent the primary public execution abstraction
- embedding long-lived provider/tool/endpoint secrets in agent definitions or runtime payloads
- implementing external-framework BYOA adapters owned by WORK-016

# Architecture Invariants

- Execution remains the primary public abstraction.
- Agent is an execution participant, not a competing top-level authority.
- Provider-specific implementation remains behind adapters.
- Policy admission precedes dispatch and risky agent side effects.
- Customer-domain authority remains outside AI Execution OS.
- Evidence is durable and revision/provenance-bound.
- Idempotency and concurrency rules are preserved at durable authority boundaries.
- No duplicate authority or second state machine is introduced.
- Agent access is mediated through existing policy, capability, connection and budget authorities.

# Acceptance Criteria

1. Define an AgentProvider contract separate from ModelProvider.
2. Bind agent session and workspace identity to an ExecutionId and application/tenant scope.
3. Allow local/customer/hosted agent adapters without changing the execution abstraction.
4. Propagate policy and tool permissions into the agent environment.
5. Prove an agent cannot access a workspace or execution belonging to another application/tenant.
6. Maintain a stable governed agent identity and inventory/catalog record for every registered agent.
7. Represent agent definitions/runtime configurations as immutable versions with validation state and rollback/promotion metadata.
8. Mediate model/tool/endpoint/secret access with scoped, revocable credentials; prove raw long-lived secrets do not enter the agent runtime contract.
9. Support policy-designated human approval gates before configured high-risk agent actions and prove the side effect cannot occur before approval.
10. Record significant agent session inputs, actions, tool calls, outputs and authorization context as execution evidence with sufficient provenance to reconstruct who/what/when/why.
11. Preserve idempotent/concurrent session lifecycle behavior at the execution identity boundary.

# Implementation Requirements

1. Use the repository contracts in `IMPLEMENTATION.md` and `spec/contracts.md`.
2. Implement public contracts before adapters/infrastructure where practical.
3. Make failure modes explicit and typed using the canonical error taxonomy.
4. Persist durable authority state transactionally where required.
5. Add tests that prove both the intended behavior and the protected negative case.
6. Reuse `/auth`, `/policies`, `/capabilities`, `/connections`, `/budgets` and `/executions` authorities rather than recreating them.
7. Treat agent versions as immutable executable artifacts; promotion/rollback changes the selected version, not the artifact contents.
8. Treat approval as an execution/policy gate, not as application-domain state.
9. Agent runtime identity and permissions must be explicit inputs to the execution environment and must be revocable without modifying the agent artifact.

# Required Checkpoint Contracts

- `IMPLEMENTATION-COMPLETENESS`
- `IDENTITY-IDEMPOTENCY`
- `CONCURRENCY-CRASH-SAFETY`
- `SELF-HOSTING-BOUNDARY`

# Checkpoints

Required assurance profile: **HIGH_ASSURANCE**.

The applicable blocking contracts are enumerated in `spec/governance/checkpoint-contract.json`. Checkpoint results are evidence, not completion authority.

Additional blocking boundaries:
- agent inventory/version authority
- credential mediation/secret non-exposure
- human approval before risky side effects
- execution provenance for agent actions

# Evidence Contract

The worker must update `docs/work-items/WORK-NNN.md` with exact revision, changed files, requirement IDs, test commands/results, checkpoint evidence, discrimination evidence where required, known limitations and PR binding. Claims without objective evidence do not satisfy completion.

# Required Verification

- `python3 scripts/governance-check.py`
- `bun run typecheck`
- `bun run lint`
- targeted unit/integration suites listed in the Implementation Requirements
- real PostgreSQL integration for schema, accounting, identity, idempotency, concurrency or durable execution work
- at least one discrimination/mutation test for every HIGH_ASSURANCE boundary explicitly named above
- inventory/version immutability and rollback proof
- credential mediation and raw-secret non-exposure proof
- approval-before-side-effect discrimination proof
- cross-tenant agent/workspace/session proof
- session audit/provenance persistence proof

# Completion

A worker may open a PR but cannot merge it. The architect is the merge authority. `program-state.json` becomes `complete` only after post-merge finalization records the actual PR number and merge commit.
