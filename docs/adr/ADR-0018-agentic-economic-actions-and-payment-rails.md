# ADR-0018 — Agentic economic actions and provider-neutral payment rails

Status: Accepted architectural augmentation

Date: 2026-09-01

## Decision

Zeck will treat agent-initiated economic activity as a governed extension of the execution control plane, without becoming a payment processor or replacing existing budget/economic authorities.

Zeck will introduce the architectural concept of an **Economic Action**. Payment is one economic-action class alongside purchase, transfer, refund, charge and future machine-commerce operations.

The platform will expose provider-neutral economic contracts and plug-in payment-rail adapters rather than implementing financial rails itself.

## Core model

```text
Agent / Developer intent
        ↓
Economic Intent
        ↓
Policy
        ↓
Budget reservation
        ↓
Payment / Economic Authorization
        ↓
Payment Rail Adapter
        ↓
Settlement / resource delivery
        ↓
Verification
        ↓
Evidence
        ↓
Learning
```

An agent intent is never an authorization and an authorization is never itself a settlement.

```text
intent ≠ authorization ≠ transaction ≠ settlement ≠ verification
```

## Authority boundaries

Existing Zeck authorities remain singular:

- Execution lifecycle
- Policy
- Capability
- Budget/economic accounting
- Tenant identity
- Credential/secret mediation
- Verification

The economic layer adds a governed authorization seam and rail adapters. It does not create a competing budget ledger or bypass the existing budget reservation/settlement model.

## Economic Action

An Economic Action should carry enough information to deterministically evaluate:

- actor/execution
- tenant/application
- purpose
- recipient/seller
- amount and currency, or bounded amount range
- timing/expiration
- idempotency identity
- requested payment method/rail constraints
- required capabilities
- evidence/verification expectations

Economic actions must be content- and context-bound so that changing a material constraint cannot reuse an authorization intended for another transaction.

## Agent payment guardrails

Agents MUST NOT receive unrestricted payment credentials.

The preferred model is a capability/token/reference with explicit constraints such as:

- seller/recipient scope
- maximum amount
- currency
- expiration
- purpose/resource
- execution/application/tenant scope
- one-time or bounded reuse

The platform must fail closed when a rail cannot express the required safety constraints.

This follows the emerging agentic-payment pattern in which machine payments are performed through bounded, tokenized or protocol-mediated authorization instead of exposing raw payment credentials.

## Payment-rail abstraction

Payment rails are adapters, not authorities in Zeck's core.

Examples include:

- Stripe
- Machine Payments Protocol (MPP)
- x402
- cards/network-token rails
- bank/payment APIs
- wallets
- stablecoin rails
- regional payment systems

Zeck must not require any one rail in its core contracts.

A rail adapter is responsible for protocol translation and settlement interaction. It may not alter Zeck policy, budgets, tenant identity, verification, or execution lifecycle.

## HTTP 402 / machine commerce

The architecture should support machine-readable payment-required responses from HTTP-addressable resources:

```text
request
  ↓
402 Payment Required
  ↓
machine-readable price/terms
  ↓
Zeck economic decision
  ↓
authorized payment
  ↓
retry/resource delivery
```

The 402 response is an input to the economic-planning flow, not an authorization by itself.

## Deterministic-first economics

Economic decisions should use deterministic checks wherever possible:

- maximum amount
- seller/recipient allowlists
- currency
- budget availability
- time window
- duplicate/idempotency constraints
- policy restrictions
- risk/rule thresholds

An LLM may propose an economic action, but it must not be trusted to perform deterministic constraint evaluation that the platform can perform exactly.

## Verification of economic outcomes

A successful payment response is not proof that the requested resource or service was delivered.

Where appropriate:

```text
payment success
      ≠
resource delivered
      ≠
execution success
```

Verification must remain independently responsible for evaluating the declared outcome.

## Learning and optimization

Economic actions enter the same Learning/Evidence plane as other executions.

Zeck may learn:

- cheaper payment rails
- transaction-vs-subscription choices
- merchant/provider performance
- successful purchase patterns
- machine-payment retry behavior
- fraud/risk signals where legally and contractually permissible

Learning output remains advisory and can never authorize a forbidden or over-budget transaction.

## Relationship to existing budgets

Budgets remain the spending-control authority.

A payment authorization must consume or reserve budget through the existing economic authority before settlement.

The system must avoid double-counting by keeping one canonical economic ledger for Zeck-controlled spending.

Where a payment rail has its own ledger, that is an external settlement record and must be correlated, not copied as an independent Zeck truth source.

## Developer experience

The eventual product should make an agent payment capability as simple to integrate as the rest of Zeck:

```text
agent.execute({
  task: "purchase resource X",
  constraints: {
    maxSpend: "5 USD",
    seller: "example.com"
  }
})
```

The developer should not need to implement rail-specific orchestration to obtain governed machine payments.

## Security invariants

The implementation must mechanically reject:

- raw payment credential exposure to agents
- agent-controlled amount escalation
- seller/recipient substitution
- currency substitution
- expired authorization reuse
- cross-tenant payment authorization
- policy bypass
- budget bypass
- duplicate settlement from retries
- settlement without required authorization
- payment-success-as-verification shortcuts
- rail adapters becoming budget or execution authorities

## Scope discipline

This ADR does **not** authorize immediate implementation of payment processing, wallets, financial accounts, KYC/AML systems, card issuance, money transmission, or other regulated financial infrastructure.

Those require separately governed Work Orders and compliance/security review.

The immediate purpose is to reserve a coherent architecture so future implementations can integrate payment rails without redesigning Execution, Policy, Budget, Capability, Verification or Learning.

## Relationship to external standards

The architecture is compatible with current machine-payment patterns, including Stripe's Machine Payments Protocol and agentic payment primitives that use bounded/tokenized authorization rather than exposing raw payment credentials.

Zeck should integrate such rails through adapters and remain independent of any single provider or protocol.

## Rejected alternatives

### Make Stripe the Zeck payment authority

Rejected. Stripe is an external rail/provider; making it authoritative would violate Zeck's provider-neutral design.

### Give agents a payment API key

Rejected. Possession of an unrestricted credential is incompatible with bounded agent authorization.

### Treat budget as payment

Rejected. A budget expresses spending authority; settlement is a separate economic event.

### Let the LLM approve transactions

Rejected. Deterministic constraints must be evaluated by deterministic code and policy authorities.

### Build a second financial ledger

Rejected. Zeck already has an economic ledger for platform-controlled AI spending; a second ledger would create reconciliation ambiguity.
