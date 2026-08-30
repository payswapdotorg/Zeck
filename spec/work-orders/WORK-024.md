# WORK-024 — Voice and Realtime Agent Deployment

Status: PENDING

Owner: Architect-assigned implementation worker

Architecture Version: v1.0

Assurance Profile: HIGH_ASSURANCE

## Objective

Make production voice/realtime agent deployment simple through provider-neutral channel adapters while preserving Zeck execution governance.

## Dependencies

Requires: WORK-023

## Requirement IDs

- MOD-005
- MOD-006
- MOD-007

## Declared Change Surfaces

- `src/modules/deployments/`
- `src/modules/agents/` (directly-required voice/realtime seams only)

## Acceptance Criteria

1. Support a provider-neutral realtime voice contract for web and telephony-style channels.
2. Integrate at least one external realtime/telephony rail through an adapter; no transport stack is hard-coded into core contracts.
3. Bind inbound calls/sessions to application, tenant, deployment and Execution identity.
4. Preserve interruption, turn/event and failure provenance through the execution ledger.
5. Enforce policy, capability, budget, secret and human-escalation controls before governed side effects.
6. Permit deterministic-only or hybrid conversational steps when the planner determines a model is unnecessary for a subtask.
7. Support deployment rollback/version pinning without changing existing execution identity.

## Required Evidence

- realtime session identity and tenant isolation tests
- provider-neutral transport adapter discrimination
- policy-before-side-effect proof
- idempotent inbound event handling
- concurrent reconnect/duplicate-event handling
- human escalation/transfer evidence
