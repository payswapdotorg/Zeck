# ADR-0015 — Multimodal Deployment Product Surface

**Status:** accepted architectural/product evolution
**Architecture version:** v1.0 (additive)

## Decision

Zeck will expose a unified deployment experience for AI agents and AI-powered workloads across voice/realtime, messaging, media generation, document/vision and future modalities.

The user-facing abstraction is a governed deployment profile, not a vendor-specific integration. Every deployed workload ultimately executes through Zeck's existing Execution abstraction.

## Product principle

A user should be able to specify what they want to deploy, target channels/modalities, quality/latency expectations, permissions, escalation rules and budget. Zeck constructs the required governed execution/runtime composition and selects suitable upstream infrastructure through provider-neutral adapters.

## Examples

- voice receptionist -> realtime/telephony rail + agent + tools + policy + budget
- support messaging agent -> messaging rail + context + tools + agent
- video generation service -> media model + asynchronous job runtime + deterministic preprocessing/postprocessing + artifact lineage + verification
- multimodal assistant -> text + audio + vision + tools under a shared Execution identity

## Non-goals

Zeck will not make voice, messaging, video, or another modality a separate execution authority. It will not require customers to rebuild existing agents, and it will not hard-code one transport or infrastructure vendor into core contracts.
