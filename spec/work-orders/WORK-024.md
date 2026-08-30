# WORK-024 — Voice and Realtime Agent Deployment

Status: PENDING

Owner: Architect-assigned implementation worker

Architecture Version: v1.0

Assurance Profile: HIGH_ASSURANCE

# Objective

Provide a simple production deployment path for voice and realtime agents through provider-neutral adapters while preserving Zeck's execution governance.

# Context

This Work Order specializes the shared WORK-023 deployment fabric for realtime conversations. Zeck should orchestrate identity, policy, budgets, capabilities, execution and provenance while replaceable upstream realtime infrastructure supplies media transport.

# Dependencies

Requires: WORK-023

# Requirement IDs

- `MOD-005`
- `MOD-006`
- `MOD-007`

# Declared Change Surfaces

- `src/modules/deployments/`
- `src/modules/agents/` (directly-required voice/realtime public integration seams only)

# Scope Boundaries

Allowed:
- provider-neutral realtime session contracts
- browser/mobile/telephony-style channel adapters
- inbound/outbound turn and interruption events
- human escalation/transfer integration
- voice-specific deployment configuration

Forbidden:
- hard-coding one realtime vendor into core contracts
- creating a second execution/session identity authority
- bypassing policy, capability, budget, secret or tenant controls
- hidden model dispatch outside the planner/models path
- making provider infrastructure a required core dependency
- merging the worker's own PR

# Architecture Invariants

- A realtime call/session maps to a governed Execution and Deployment.
- Tenant, application and deployment identity are established before side effects.
- Interruption/turn events are durable provenance, not a second event authority.
- Voice subtasks may be deterministic, tool-based, model-based or hybrid.
- Escalation is an execution-governed action and cannot bypass policy.

# Acceptance Criteria

1. Support a provider-neutral realtime voice contract for web and telephony-style channels.
2. Integrate at least one realtime/telephony upstream rail through an adapter while keeping core contracts provider-neutral.
3. Bind sessions/calls to tenant, application, deployment version and Execution identity.
4. Preserve turns, interruptions, transfers, failures and significant actions as execution provenance.
5. Prove policy, capability, budget, secret and tenant checks occur before governed side effects.
6. Allow deterministic-only and hybrid subtasks when planner decisions establish that generative inference is unnecessary or excessive.
7. Support deployment version pinning, rollback and reconnect/duplicate-event safety without changing prior Execution identity.

# Implementation Requirements

- Use idempotent inbound event identifiers where supplied by the upstream rail and create deterministic substitutes when required by the adapter contract.
- Model latency-sensitive behavior explicitly in the deployment profile without forcing a provider choice into the public contract.
- Preserve raw media outside the execution ledger unless a required artifact reference is sufficient; use artifact lineage for durable media references.
- Human transfer/escalation must be policy-designated and auditable.

# Required Checkpoint Contracts

- `IMPLEMENTATION-COMPLETENESS`
- `EXECUTION-PROVENANCE`
- `CONCURRENCY-CRASH-SAFETY`
- `SELF-HOSTING-BOUNDARY`

# Checkpoints

- readiness: realtime dependencies and declared surfaces verified before implementation
- realtime-safety: identity, policy-before-side-effect and deterministic/hybrid routing proven
- recovery: duplicate/reconnect, interruption and transfer behavior proven

# Evidence Contract

Evidence must identify exact implementation/final revisions, map MOD-005..007 to code/tests, and include provider-neutrality, tenant, policy-ordering, interruption and reconnect evidence. External realtime-provider behavior must be recorded only when actually observed.

# Required Verification

- governance checker
- typecheck
- lint
- realtime contract tests
- at least one upstream adapter integration test
- tenant/session identity tests
- policy-before-side-effect discrimination
- deterministic/hybrid subtask routing tests
- duplicate/reconnect concurrency tests
- interruption/transfer provenance tests
- rollback/version pinning tests

# Completion

Worker opens a PR but does not merge. Completion requires architect acceptance and post-merge finalization.
