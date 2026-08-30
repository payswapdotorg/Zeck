# WORK-025 — Messaging Agent Deployment

Status: PENDING

Owner: Architect-assigned implementation worker

Architecture Version: v1.0

Assurance Profile: HIGH_ASSURANCE

## Objective

Make it easy to deploy governed conversational agents to messaging channels without coupling Zeck to a single network or messaging provider.

## Dependencies

Requires: WORK-023

## Requirement IDs

- MOD-008
- MOD-009

## Declared Change Surfaces

- `src/modules/deployments/`
- `src/modules/agents/` (directly-required messaging seams only)

## Acceptance Criteria

1. Define a provider-neutral messaging channel contract for inbound/outbound messages, threads, attachments and delivery status.
2. Integrate at least one external messaging rail through an adapter.
3. Bind channel identity, conversation identity and message provenance to application/tenant/deployment/Execution scope.
4. Handle retries, duplicates, ordering and idempotent inbound events safely.
5. Preserve policy, capability, budget, secret and verification authorities before outbound side effects.
6. Support escalation to human operators as a governed Execution step.

## Required Evidence

- provider-neutral channel discrimination
- cross-tenant conversation isolation
- duplicate/retry convergence
- ordering guarantees appropriate to the channel
- policy-before-send proof
- provenance from inbound message through tool/model activity to outbound message
