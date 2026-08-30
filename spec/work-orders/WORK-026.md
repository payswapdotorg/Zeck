# WORK-026 — Media Generation Agent Deployment

Status: PENDING

Owner: Architect-assigned implementation worker

Architecture Version: v1.0

Assurance Profile: HIGH_ASSURANCE

# Objective

Make video, image, audio and related media-generation agents easy to deploy as governed Zeck Executions with provider-neutral capabilities, asynchronous lifecycle and strong artifact provenance.

# Context

This Work Order specializes WORK-023 for media generation. Model/provider selection remains downstream of capability and policy authority; asynchronous generation is represented by Execution and generated media by the canonical artifact lineage system.

# Dependencies

Requires: WORK-009, WORK-010, WORK-013, WORK-023

# Requirement IDs

- `MOD-011`
- `MOD-012`
- `MOD-013`

# Declared Change Surfaces

- `src/modules/deployments/`
- `src/modules/models/` (directly-required media capability seams only)
- `src/modules/artifacts/` (directly-required media artifact seams only)

# Scope Boundaries

Allowed:
- provider-neutral media-generation capability contracts
- asynchronous job submission/status/cancellation/retry orchestration
- adapter integration for at least one upstream media rail
- generated-media artifact references and lineage
- deterministic preprocessing/postprocessing and verification hooks

Forbidden:
- provider-specific types in public contracts
- provider selection before capability/policy admission
- bypassing budget authority before paid dispatch
- duplicate media/execution state machines
- unverified output being marked complete when the Work Order requires rejection
- direct raw media mutation outside the canonical artifact authority
- merging the worker's own PR

# Architecture Invariants

- Media generation is an Execution, not a separate job abstraction with independent authority.
- Generated outputs are artifacts with execution/deployment lineage.
- Paid dispatch occurs only after budget/resource admission.
- Retries and callbacks are idempotent and cannot silently create uncontrolled paid duplicates.
- Verification remains separate from provider success and controls completion where required.

# Acceptance Criteria

1. Define provider-neutral media-generation capability contracts covering video, image, audio and related multimodal generation.
2. Integrate at least one external media rail while keeping provider/model selection downstream of capability and policy admission.
3. Support asynchronous submission, polling/callback completion, cancellation and retry semantics through the existing Execution lifecycle.
4. Persist generated media as lineage-preserving artifacts; derived variants remain linked to source artifacts and deployment version.
5. Support deterministic preprocessing/postprocessing and verification that can reject an invalid output before completion.
6. Enforce budget/resource policy before paid dispatch and make repeated job submission idempotent.
7. Support deployment versioning, rollback and provider substitution without changing the core Execution abstraction.

# Implementation Requirements

- Normalize provider-specific job states into a closed provider-neutral lifecycle.
- Correlate provider callbacks/polls to the originating Execution and deployment identity.
- Preserve tenant isolation for inputs, generated outputs, callbacks and artifact adoption.
- Treat provider success as an observation; completion requires the existing verification contract when configured.
- Use artifact references for large media rather than embedding payloads in EventEnvelope rows.

# Required Checkpoint Contracts

- `IMPLEMENTATION-COMPLETENESS`
- `EXECUTION-PROVENANCE`
- `CONCURRENCY-CRASH-SAFETY`
- `SELF-HOSTING-BOUNDARY`

# Checkpoints

- readiness: media dependencies and declared surfaces verified before implementation
- paid-execution-safety: capability/policy/budget admission and duplicate-job protection proven
- media-provenance: async lifecycle, artifact lineage and verification boundary proven

# Evidence Contract

Evidence must identify exact implementation/final revisions, map MOD-011..013 to code/tests, and prove provider neutrality, budget-before-paid-dispatch, idempotent async lifecycle, artifact lineage, tenant isolation and verification-before-completion.

# Required Verification

- governance checker
- typecheck
- lint
- media capability contract tests
- provider-neutral adapter tests
- capability-before-provider discrimination
- duplicate submission/idempotency tests
- async completion/retry/crash tests
- artifact lineage and tenant isolation tests
- budget-before-paid-dispatch discrimination
- verification-before-completion tests
- rollback/provider-substitution tests

# Completion

Worker opens a PR but does not merge. Completion requires architect acceptance and post-merge finalization.
