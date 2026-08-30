# WORK-023 — Multimodal Agent Deployment Fabric

Status: PENDING

Owner: Architect-assigned implementation worker

Architecture Version: v1.0

Assurance Profile: HIGH_ASSURANCE

## Objective

Implement the provider-neutral deployment substrate that lets users deploy governed agents across channels/modalities without creating a new authority per modality.

## Dependencies

Requires: WORK-011, WORK-012, WORK-015, WORK-016

## Requirement IDs

- MOD-001
- MOD-002
- MOD-003
- MOD-004
- MOD-010

## Declared Change Surfaces

- `src/modules/deployments/`
- `src/modules/agents/` (only directly-required public integration seams)

## Acceptance Criteria

1. Versioned DeploymentProfile and DeploymentPlan contracts exist and remain provider-neutral.
2. Deployment identity is bound to application/environment/agent version and can be referenced by Execution.
3. Deployment lifecycle is durable, idempotent and concurrency-safe where state can be mutated.
4. Channel/modality adapters are replaceable and cannot create duplicate policy, budget, capability, execution or verification authorities.
5. Deployment promotion, rollback and suspension preserve provenance and existing execution identity.
6. Profiles support voice/realtime, messaging, media-generation, document/vision and future multimodal profiles without changing the core Execution abstraction.
7. BYOA agents can be represented as deployment targets without making an external agent framework a Zeck dependency.

## Required Evidence

- versioned deployment identity tests
- concurrent deployment update tests where applicable
- cross-tenant isolation tests
- provider-neutrality discrimination
- policy/budget/capability mediation ordering
- rollback/promotion provenance proof
