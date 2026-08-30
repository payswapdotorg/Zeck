# ADR-0016 — Computational Substrate Extensibility

**Status:** accepted architectural evolution
**Architecture version:** v1.0 (additive)

## Decision

Zeck will treat computational substrates as provider-neutral capabilities that can be selected, governed, executed, observed, verified and learned against through the existing Execution abstraction.

A computational substrate may be:

- a deterministic program or algorithm
- a database or retrieval system
- a model or model-serving rail
- a tool or browser/desktop environment
- an agent runtime
- a batch/GPU workload
- an edge or real-time runtime
- a specialized accelerator
- a physical/embodied system adapter
- a human operator
- a future substrate not yet known to Zeck

## Invariants

1. Execution remains the universal durable abstraction.
2. New substrates are capabilities and execution targets, not new top-level authorities.
3. Policy, tenant, budget, capability, secret, verification and execution authorities remain singular.
4. Provider/vendor selection occurs only after policy and capability resolution and, where applicable, deterministic-sufficiency analysis.
5. Real-time or physical control loops are not delegated to the cloud control plane when hard real-time or safety requirements prohibit that architecture; Zeck governs/deploys the substrate and records the resulting execution evidence.
6. Training, batch, accelerator and other high-throughput workloads use the same execution identity, budget, provenance and verification boundaries.
7. Computer-use environments are mediated capabilities with explicit network, credential, filesystem and side-effect policy.
8. Long-running executions are checkpointable, resumable, interruptible and auditable without changing execution identity.
9. Specialized infrastructure remains behind replaceable adapters; Zeck does not rebuild commodity substrate infrastructure unnecessarily.
10. New substrate classes must be additively incorporable without changing the core Execution abstraction or creating a duplicate state machine.

## Workload classes

The deployment/execution taxonomy may include interactive, realtime, asynchronous, batch, training/evaluation, edge, embodied and specialized-accelerator workloads. Class-specific requirements are expressed through capabilities, policies, resource constraints and deployment profiles.

## Scope

This ADR establishes the extensibility contract and roadmap. Concrete implementations belong to WORK-027 through WORK-031 and later Work Orders.
