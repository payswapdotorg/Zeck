# WORK-032 — Agentic economic actions and provider-neutral payment rails

Status: pending

Owner: Architect-assigned implementation worker

Architecture Version: v1.0

Assurance Profile: CRITICAL

# Objective

Establish a governed economic-action boundary so agents can request purchases, payments, transfers and future machine-commerce operations without receiving unrestricted financial credentials or bypassing Zeck's existing policy, budget, capability, execution and verification authorities.

# Context

Zeck already controls AI spending through budgets, reservations and an append-only economic ledger. Agentic commerce adds a distinct requirement: an agent may need to cause an externally settled transaction. This Work Order adds the authorization and rail-interoperability seam without making Zeck a payment processor or creating a second financial ledger.

# Dependencies

Requires: WORK-004, WORK-006, WORK-007, WORK-013, WORK-015, WORK-016, WORK-017

# Requirement IDs

- `ECO-001`
- `ECO-002`
- `ECO-003`
- `ECO-004`
- `ECO-005`
- `ECO-006`
- `ECO-007`
- `ECO-008`

# Declared Change Surfaces

- `src/modules/economics/`
- `src/modules/budgets/` (directly-required economic authorization/ledger seams only)
- `src/modules/executions/` (directly-required economic execution/evidence seams only)
- `src/modules/verification/` (directly-required settlement/resource-delivery verification seams only)
- `src/modules/integrations/` (payment-rail adapters only)
- `src/api/` (directly-required economic-action API surface only)

# Scope Boundaries

Allowed:
- provider-neutral EconomicAction and payment-authorization contracts
- deterministic constraint evaluation
- bounded/tokenized agent-payment authorization
- payment-rail adapter contracts
- machine-payment / HTTP 402 interoperability
- settlement correlation and resource-delivery verification seams
- economic-action evidence and learning hooks

Forbidden:
- becoming a payment processor
- holding customer funds as a new platform authority
- card issuance
- KYC/AML systems
- money-transmission infrastructure
- unrestricted payment credentials in agent runtime
- creating a second budget or financial ledger
- allowing agents or LLMs to approve their own transactions
- merging the worker's own PR

# Architecture Invariants

- `intent != authorization != transaction != settlement != verification`.
- Existing Policy remains the hard authorization boundary.
- Existing Budget/Economic accounting remains the canonical spending-control authority.
- Payment rails are replaceable adapters, not Zeck authorities.
- Verification independently determines whether paid-for resources/services were delivered.
- Agents never receive unrestricted payment credentials.
- Economic actions retain execution, tenant, application and provenance identity.
- Deterministic constraints are evaluated by deterministic code, not by an LLM.

# Acceptance Criteria

1. Define a provider-neutral `EconomicAction` / payment-intent contract with actor, execution, tenant/application, purpose, recipient/seller, amount/currency or bounded range, expiration, idempotency identity and required capabilities.
2. Add bounded payment authorization whose constraints include recipient/seller, maximum amount, currency, purpose/resource, expiry and execution/application/tenant scope where the rail supports them.
3. Reuse the existing budget reservation/settlement authority and prevent double-counting or creation of a second Zeck financial ledger.
4. Define provider-neutral payment-rail adapters and prove rail/provider replacement does not change core authorities.
5. Support machine-readable payment-required responses such as HTTP 402 as inputs to economic planning; a 402 response itself is never authorization.
6. Correlate settlement with the originating economic action and allow independent verification of resource/service delivery.
7. Preserve idempotency, retry safety, concurrency safety and complete economic provenance.
8. Emit economic outcomes into Learning as evidence/recommendations without allowing learning scores to authorize spending.

# Implementation Requirements

- Raw payment credentials must never cross the agent/public API/SDK/CLI boundary.
- If a rail cannot express the safety constraints required by policy, fail closed.
- Material economic constraints must participate in request fingerprinting.
- Settlement records from external rails are correlated evidence, not a second Zeck truth source.
- Economic authorization must expire and be bounded according to policy.
- External side effects occur only after the normal policy → capability → budget → execution authorization chain.

# Required Checkpoint Contracts

- `IDENTITY-IDEMPOTENCY`
- `ECONOMIC-AUTHORITY-BOUNDARY`
- `EXECUTION-PROVENANCE`

# Checkpoints

- readiness: dependencies, surfaces and regulatory boundary verified before implementation
- authority: intent, policy, budget, authorization and settlement boundaries proven
- security: credential/constraint isolation and replay/recipient/amount substitution protections proven
- interoperability: at least one real or contract-tested payment rail integration seam plus machine-payment input handling proven
- verification: settlement is not treated as resource-delivery verification

# Evidence Contract

Evidence must identify exact implementation and final branch heads, map every ECO requirement to tests, prove bounded authorization, budget reuse, rail neutrality, idempotency/concurrency, secret safety, 402 handling and settlement/resource-delivery distinction. Workers must not claim a successful financial transaction unless it was actually observed in a controlled test environment.

# Required Verification

- governance checker
- typecheck
- lint
- EconomicAction contract tests
- deterministic constraint tests
- budget/authorization ordering tests
- credential exposure discrimination
- amount/recipient/currency substitution discrimination
- expiry/replay discrimination
- idempotency/concurrency tests
- payment-rail adapter contract tests
- HTTP 402 parsing/decision tests
- settlement correlation tests
- payment-success-vs-delivery verification tests
- tenant isolation tests
- real PostgreSQL durability tests
- full suite

# Completion

Worker opens a PR but does not merge. Completion requires architect acceptance and post-merge finalization.
