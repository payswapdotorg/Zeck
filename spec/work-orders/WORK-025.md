# WORK-025 — Messaging Agent Deployment

Status: PENDING

Owner: Architect-assigned implementation worker

Architecture Version: v1.0

Assurance Profile: HIGH_ASSURANCE

# Objective

Make governed conversational agents easy to deploy across messaging channels without coupling Zeck to a single messaging provider.

# Context

This Work Order specializes WORK-023 for asynchronous and conversational messaging. Channel-specific delivery infrastructure is adapter-owned; Zeck retains authority over execution identity, policy, capabilities, budgets, tenant isolation, verification and provenance.

# Dependencies

Requires: WORK-023

# Requirement IDs

Primary requirements owned by this Work Order:
- `MOD-008`
- `MOD-009`

# Declared Change Surfaces

- `src/modules/deployments/`
- `src/modules/agents/` (directly-required messaging integration seams only)

# Scope Boundaries

Allowed:
- provider-neutral inbound/outbound messaging contracts
- conversation/thread/message identity
- attachments and delivery status references
- idempotent inbound event processing
- message-ordering and retry handling
- governed human escalation

Forbidden:
- hard-coding one messaging vendor into core contracts
- duplicate conversation/execution/policy authority
- sending before policy/capability/budget/tenant checks
- raw provider credentials in agent code
- hidden model dispatch outside existing execution planning
- direct mutation of customer workflow state
- merging the worker's own PR

# Architecture Invariants

- Conversation and message identities are scoped to application/tenant/deployment and bound to Execution.
- Inbound events are deduplicated before agent-side effects.
- Outbound messages are policy-gated before send.
- Delivery state is evidence/provenance, not a second execution state machine.
- Channel adapters are replaceable and provider-neutral.

# Acceptance Criteria

1. Define a provider-neutral messaging channel contract covering inbound/outbound messages, threads/conversations, attachments and delivery status.
2. Integrate at least one external messaging rail through an adapter without exposing vendor types in public contracts.
3. Bind channel, conversation and message provenance to application, tenant, deployment and Execution identity.
4. Duplicate, retry and out-of-order inbound events are handled deterministically according to the channel contract.
5. Policy, capability, budget, secret and tenant controls are proven to run before outbound side effects.
6. Tool/model activity can be traced from inbound message to outbound response through canonical execution evidence.
7. Human escalation is represented as a governed Execution step.

# Implementation Requirements

- Preserve idempotency across upstream retries and our own retry loop.
- Define explicit ordering semantics; do not assume global ordering for channels that do not provide it.
- Store large attachments through artifact/object references rather than embedding arbitrary binary data in execution events.
- Do not expose provider-native message IDs as the primary public identity.
- Make outbound send attempts auditable and correlate delivery callbacks to the originating execution.

# Required Checkpoint Contracts

- `IMPLEMENTATION-COMPLETENESS`
- `EXECUTION-PROVENANCE`
- `CONCURRENCY-CRASH-SAFETY`
- `SELF-HOSTING-BOUNDARY`

# Required Verification

- governance checker
- typecheck
- lint
- provider-neutral messaging contract tests
- at least one external messaging adapter integration test
- tenant/conversation isolation tests
- duplicate/retry/order tests
- policy-before-send discrimination tests
- provenance chaining tests
- human escalation integration test

# Completion

Worker opens a PR but does not merge. Completion requires architect acceptance and post-merge finalization.
