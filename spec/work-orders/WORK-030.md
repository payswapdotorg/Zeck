# WORK-030 — Training, batch GPU and specialized accelerator workloads

Status: PENDING

Owner: Architect-assigned implementation worker

Architecture Version: v1.0

Assurance Profile: HIGH_ASSURANCE

# Objective

Extend Zeck's execution substrate to govern training, fine-tuning, large batch inference and specialized accelerator workloads without coupling the core platform to a particular GPU, accelerator or training vendor.

# Context

Some AI workloads are not request/response inference. They may consume large GPU fleets, run for hours or days, emit checkpoints, and require reproducible resource accounting. Zeck should govern these workloads through the same execution identity, budget, provenance and verification model.

# Dependencies

Requires: WORK-012, WORK-013, WORK-016, WORK-019, WORK-031

# Requirement IDs

- `ACC-001`
- `ACC-002`
- `ACC-003`

# Declared Change Surfaces

- `src/modules/sandbox/`
- `src/modules/integrations/`
- `src/modules/deployments/` (directly-required workload deployment seams only)

# Scope Boundaries

Allowed:
- provider-neutral batch/training workload contracts
- checkpoint and artifact references
- GPU/accelerator resource requests and accounting
- scheduler/infrastructure adapters
- workload cancellation/retry/resume metadata

Forbidden:
- vendor-specific concepts in core contracts
- bypass of budget, policy, tenant or execution authority
- treating unverified training artifacts as verified model releases
- modifying model-provider authority owned by WORK-003
- merging the worker's own PR

# Architecture Invariants

- Training and batch workloads are Executions.
- Resource and cost admission occur before paid compute allocation.
- Checkpoints and outputs preserve artifact lineage and execution provenance.
- Resource selection remains provider-neutral.
- Verification/promotion remains separate from successful compute completion.

# Acceptance Criteria

1. Represent training, fine-tuning and large-batch workloads as governed Executions.
2. Select GPU/accelerator resources through a provider-neutral capability/resource contract.
3. Enforce budget/resource limits before paid compute allocation.
4. Support checkpoint, retry, cancellation and resume semantics with stable execution identity.
5. Preserve dataset, code, configuration, checkpoint and output lineage.
6. Prove provider/accelerator substitution does not change the core Execution abstraction.

# Implementation Requirements

- Resource estimates must be explicit and auditable.
- Failed training runs must not be presented as verified model releases.
- Checkpoint identities must be immutable and content/lineage addressable.
- Specialized accelerator adapters expose capability/resource metadata, not platform authority.

# Required Checkpoint Contracts

- `CONCURRENCY-CRASH-SAFETY`
- `EXECUTION-PROVENANCE`

# Checkpoints

- readiness: dependency, resource and declared-surface verification before implementation
- resource-safety: budget/resource admission and provider substitution proven
- provenance: dataset/config/checkpoint/output lineage and verification boundary proven

# Evidence Contract

Evidence must identify exact implementation/final revisions, map ACC requirements to code and tests, and prove resource admission occurs before paid allocation. Compute completion must remain distinct from verification or release authority.

# Required Verification

- governance checker
- typecheck
- lint
- workload contract tests
- budget-before-allocation discrimination
- checkpoint/retry/concurrency tests
- artifact lineage tests
- provider/accelerator substitution tests
- verification-before-release discrimination

# Completion

Worker opens a PR but does not merge. Completion requires architect acceptance and post-merge finalization.
