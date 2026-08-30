# WORK-031 — Computational substrate federation and workload classes

Status: PENDING

Owner: Architect-assigned implementation worker

Architecture Version: v1.0

Assurance Profile: HIGH_ASSURANCE

# Objective

Establish the common provider-neutral contract by which any computational substrate can be registered, selected, governed, executed, observed and learned against without creating a new platform authority.

# Context

Zeck must remain extensible as workloads expand beyond conventional model inference. This Work Order defines the common substrate boundary consumed by computer-use, long-running, edge/embodied, training, media and future workload implementations.

# Dependencies

Requires: WORK-006, WORK-007, WORK-008, WORK-010, WORK-011, WORK-012, WORK-013, WORK-014, WORK-016

# Requirement IDs

- `CSX-001`
- `CSX-002`
- `CSX-003`
- `CSX-004`

# Declared Change Surfaces

- `src/modules/capabilities/`
- `src/modules/executions/`
- `src/modules/planning/`
- `src/modules/integrations/`

# Scope Boundaries

Allowed:
- provider-neutral computational substrate contracts
- workload-class vocabulary
- resource/capability declarations
- substrate admission and lifecycle seams
- integration contracts for external compute systems

Forbidden:
- replacing existing policy/capability/execution/verification authorities
- putting vendor-specific APIs in core contracts
- implementing every future substrate in this Work Order
- creating a second execution state machine
- merging the worker's own PR

# Architecture Invariants

- Every substrate participates through Execution.
- Capability and policy are resolved before substrate/provider selection.
- Deterministic-first planning remains applicable to every workload class.
- External substrate operators remain replaceable adapters.
- Substrate-specific safety/resource semantics are explicit and evidence-producing.
- A new workload class can be added without changing the core Execution abstraction.

# Acceptance Criteria

1. Define a provider-neutral `ComputationalSubstrate` contract with capability, modality, latency, resource, isolation and side-effect metadata.
2. Define workload-class contracts for interactive, realtime, asynchronous, batch, training/evaluation, edge, embodied and specialized-accelerator execution.
3. Enforce a common admission sequence: policy → capability → resource/budget → substrate selection → execution.
4. Prove substrate/provider replacement does not create a duplicate authority.
5. Provide extension seams for future substrates not known at v1.0 implementation time.
6. Record substrate-selection rationale and resource characteristics as execution evidence.

# Implementation Requirements

- Core contracts remain provider-neutral.
- Substrate capability claims are distinct from authorization to use them.
- Resource estimates and side-effect classes are explicit.
- Substrate adapters must fail closed when required metadata or authority seams are unavailable.

# Required Checkpoint Contracts

- `SELF-HOSTING-BOUNDARY`
- `EXECUTION-PROVENANCE`

# Checkpoints

- readiness: dependency and declared-surface verification before implementation
- authority: capability/policy/resource admission and substrate-selection boundaries proven
- extensibility: new workload classes can be represented without core execution changes

# Evidence Contract

Evidence must identify exact implementation and final branch heads, map CSX requirements to code/tests, and prove provider neutrality, authority ordering, deterministic-first compatibility and extensibility. Workers must not claim substrate capabilities or external resource results that were not actually observed.

# Required Verification

- governance checker
- typecheck
- lint
- workload-class contract tests
- provider-neutrality discrimination
- authority-boundary discrimination
- deterministic-first compatibility tests
- resource/admission ordering tests
- extension compatibility tests

# Completion

Worker opens a PR but does not merge. Completion requires architect acceptance and post-merge finalization.
