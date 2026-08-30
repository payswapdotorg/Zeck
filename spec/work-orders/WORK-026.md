# WORK-026 — Media Generation Agent Deployment

Status: PENDING

Owner: Architect-assigned implementation worker

Architecture Version: v1.0

Assurance Profile: HIGH_ASSURANCE

## Objective

Make video, image, audio and related media-generation agents easy to deploy as governed Zeck Executions.

## Dependencies

Requires: WORK-023, WORK-009, WORK-010, WORK-013

## Requirement IDs

- MOD-011
- MOD-012
- MOD-013

## Declared Change Surfaces

- `src/modules/deployments/`
- `src/modules/models/` (directly-required media capability seams only)
- `src/modules/artifacts/` (directly-required media artifact seams only)

## Acceptance Criteria

1. Define provider-neutral media-generation capability contracts covering video, image, audio and multimodal generation workloads.
2. Integrate at least one external media-generation rail through a provider adapter; provider/model choice remains downstream of capability and policy admission.
3. Support asynchronous jobs, polling/callback completion, cancellation and retry semantics through the Execution lifecycle.
4. Persist generated media as lineage-preserving artifacts; derived variants remain provenance-linked to source artifacts and deployment version.
5. Support deterministic preprocessing/postprocessing and verification around model generation, including validation that can reject bad outputs before completion.
6. Enforce budget/resource policy and idempotent job submission so retries cannot create uncontrolled duplicate paid jobs.
7. Support deployment versioning, rollback and provider substitution without changing the core Execution abstraction.

## Required Evidence

- capability-before-provider discrimination
- provider-neutral media adapter tests
- duplicate submission/idempotency tests
- async completion/retry/crash tests
- artifact lineage and tenant isolation proof
- budget-before-paid-dispatch proof
- verification-before-completion proof
