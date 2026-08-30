# WORK-023 — Multimodal Agent Deployment Fabric

Status: PENDING

Owner: Architect-assigned implementation worker

Architecture Version: v1.0

Assurance Profile: HIGH_ASSURANCE

# Objective

Implement the provider-neutral deployment substrate that lets users deploy governed agents across channels and modalities without creating a second authority for policy, capability, budget, execution, verification or tenant isolation.

# Context

WORK-023 establishes the common deployment abstraction consumed by voice, messaging and media-generation deployments. Deployment is a control-plane concern over the existing Execution and Agent abstractions; modality infrastructure is accessed through replaceable adapters.

# Dependencies

Requires: WORK-011, WORK-012, WORK-015, WORK-016

# Requirement IDs

- `MOD-001`
- `MOD-002`
- `MOD-003`
- `MOD-004`
- `MOD-010`

# Declared Change Surfaces

- `src/modules/deployments/`
- `src/modules/agents/` (only directly-required public integration seams)

# Scope Boundaries

Allowed:
- provider-neutral deployment profiles, plans and lifecycle state
- deployment identity and references from executions/agents
- adapter seams for channel/modality infrastructure
- promotion, rollback and suspension metadata
- deployment/BYOA registration metadata

Forbidden:
- modality-specific provider lock-in
- duplicate policy/capability/budget/execution/verification authorities
- direct mutation of customer-domain workflow state
- bypassing existing agent identity or execution identity
- implementing voice/messaging/media-specific provider rails owned by WORK-024/025/026
- merging the worker's own PR

# Architecture Invariants

- Deployment is an Execution-adjacent control-plane object, not a replacement for Execution.
- Deployment identity is application/environment/agent-version scoped.
- All modality access is mediated through provider-neutral adapter contracts.
- Lifecycle mutations are idempotent, auditable and concurrency-safe.
- Existing policy, capability, budget, tenant and verification authorities remain authoritative.

# Acceptance Criteria

1. Versioned provider-neutral DeploymentProfile and DeploymentPlan contracts exist.
2. Deployment identity is bound to application, environment and agent version and is referenceable by executions.
3. Lifecycle create/update/promote/rollback/suspend operations are idempotent and concurrency-safe where mutable.
4. Modality/channel adapters cannot create duplicate authorization or execution authorities.
5. Deployment lifecycle events preserve actor, cause, prior/current version and execution provenance.
6. BYOA/external agent deployments can be represented without making an external runtime a Zeck dependency.
7. Voice, messaging, media-generation and future modalities can consume the same deployment abstraction without changing the core Execution model.

# Implementation Requirements

- Use immutable versioned deployment artifacts.
- Make invalid cross-tenant or cross-application deployment references unrepresentable or fail before side effects.
- Preserve rollback provenance and previous-version references.
- Keep external rail identifiers outside provider-neutral public contracts.
- Expose enough metadata for WORK-024/025/026 to bind modality sessions/jobs to deployment identity.

# Required Checkpoint Contracts

- `IMPLEMENTATION-COMPLETENESS`
- `EXECUTION-PROVENANCE`
- `SELF-HOSTING-BOUNDARY`

# Checkpoints

- readiness: dependencies and declared surfaces verified before implementation
- lifecycle: idempotent/concurrent promotion, rollback and suspension semantics proven
- authority: modality adapters remain non-authoritative and governed by existing controls

# Evidence Contract

Evidence must identify exact implementation/final revisions, map each MOD-001..004/010 requirement to code and tests, and prove deployment identity, lifecycle safety, provider neutrality, tenant isolation and authority preservation.

# Required Verification

- governance checker
- typecheck
- lint
- deployment profile/plan contract tests
- deployment identity integration tests
- lifecycle idempotency/concurrency tests
- tenant isolation tests
- provider-neutrality discrimination
- authority-boundary mutation tests
- rollback/promotion provenance tests

# Completion

Worker opens a PR but does not merge. Completion requires architect acceptance and post-merge finalization.
