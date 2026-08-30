# ADR-0014 — Multimodal Agent Deployment Fabric

**Status:** accepted architectural evolution
**Architecture version:** v1.0 (additive)

## Decision

Zeck will provide a provider-neutral deployment fabric for agents specialized by channel, modality, or workload. Voice/realtime, messaging, media generation, document/vision, and future modalities are deployment profiles of the same governed Agent + Execution substrate rather than separate product architectures.

## Invariants

1. Execution remains the primary public abstraction.
2. An Agent remains a participant/strategy inside an Execution, not the top-level platform abstraction.
3. Channel and modality adapters are infrastructure/provider seams, not authorities.
4. Policy, capability, budget, tenant, secret, verification, and execution lifecycle authorities remain singular.
5. Zeck does not rebuild realtime transport, telephony, messaging networks, model inference, or media infrastructure when suitable upstream rails exist; it orchestrates them through provider-neutral adapters.
6. A deployment may combine multiple modalities and may contain zero, one, or many model calls.
7. Deterministic-first planning applies inside deployed agents exactly as it applies to other executions.
8. External/BYOA agents remain governable through the same Execution, policy, capability, budget, provenance and verification boundaries.
9. Deployment configuration is versioned and immutable once referenced by an Execution; promotion and rollback preserve Execution identity.
10. Human approval and escalation remain governed Execution primitives.

## Deployment profile model

A deployment profile declares channel/modal requirements rather than a vendor-specific implementation:

- `realtime-voice`
- `messaging`
- `media-generation`
- `document-vision`
- `realtime-multimodal`
- future profiles

The profile resolves required capabilities, latency/resource characteristics, input/output modalities, side-effect class, isolation needs and external integration requirements. Provider/vendor selection remains downstream.

## Strategic consequence

A developer should be able to describe an agent's goal, channels/modalities, budget, quality target, permissions and escalation policy and receive a governed deployment plan without needing to assemble every infrastructure component manually.

## Non-goals

- No new top-level agent authority.
- No mandatory dependency on a single realtime, messaging, media or model provider.
- No provider-specific concepts in public core contracts.
- No automatic promotion based solely on popularity or user ratings; normal verification/promotion gates remain authoritative.
