# WORK-048 — Resilience, disaster recovery and provider exit

Status: AUTHORIZED / PENDING

Owner: Implementation worker; Architect retains review, merge and state-finalization authority

Architecture Version: v1.0 (frozen); Deployment & Runtime Architecture D1.0

Assurance Profile: HIGH_ASSURANCE

# Objective

Implement D-07 so Zeck can survive infrastructure loss and provider substitution without moving domain authority away from PostgreSQL or changing frozen v1.0 semantics.

# Dependencies

Requires: WORK-047

Enables: D-08 growth and enterprise hardening, subject to the explicit D-08 gate.

# Requirement IDs

No existing product requirement IDs are introduced by D-07; this Work Order defines resilience, recovery and provider-exit contracts subordinate to D1.0 and frozen v1.0.

# Declared Change Surfaces

Allowed modules/surfaces: recovery and restore tooling, artifact recovery adapters, queue/workflow replay tooling, worker evacuation/drain controls, provider-outage simulation harnesses, alternate-provider adapters/configuration, RTO/RPO documentation/evidence, D-07 tests/evidence, operator runbooks, and minimum existing seam consumption required to prove provider substitution.

Forbidden to modify frozen architecture v1.0, authoritative execution/policy/capability/budget/secret/tenant/verification semantics, or `spec/development-state/*` during active implementation.

# Scope Boundaries

Allowed:

- PostgreSQL backup, restore and recovery drills.
- Durable artifact recovery from independent artifact storage.
- Queue and workflow replay after transport/orchestration loss.
- Regional worker evacuation, drain and restartable recovery.
- Provider outage simulations and explicit fail-closed behavior.
- R2 → alternate S3-compatible artifact-store replacement proof.
- Managed PostgreSQL → alternate managed PostgreSQL replacement proof.
- Vercel → alternate web/API host replacement proof.
- Documented RTO/RPO targets and measured drill evidence by environment.
- Repeatable disaster-recovery evidence and operator procedures.

Forbidden:

- changing frozen architecture v1.0;
- creating a second authoritative state store;
- moving authority into providers, queues, workflows, dashboards or recovery tooling;
- introducing D-08 enterprise hardening before its gate;
- changing domain semantics to accommodate a provider;
- bypassing policy, capability, budget, secret, tenant or verification authority;
- uncontrolled data loss presented as successful recovery;
- modifying `spec/development-state/*` during active implementation;
- self-approval or self-merge.

# Architecture Invariants

1. PostgreSQL remains the durable Zeck authority through recovery.
2. Recovery procedures restore authoritative state rather than reconstructing it from provider dashboards.
3. Artifact recovery preserves content identity and lineage.
4. Queue/workflow replay remains idempotent and cannot duplicate authoritative effects.
5. Worker evacuation converges through durable leases and recovery rather than provider-local state.
6. Provider replacement changes adapters/configuration, not domain semantics.
7. Recovery evidence is deterministic, auditable and repeatable.
8. RTO/RPO are measured claims per environment, not aspirational prose.

# Acceptance Criteria

1. Authoritative PostgreSQL state can be restored from repository-defined backup/restore procedures and verified against expected invariants.
2. Durable artifacts can be recovered after compute/artifact-provider loss with preserved identity and lineage.
3. Queue/workflow messages can be replayed after transport/orchestration loss without duplicating durable authoritative effects.
4. Regional worker evacuation drains or fences active work and allows restartable reassignment without stale-worker mutation.
5. At least one alternate implementation is demonstrated for each critical provider category in the D1.0 topology: artifact storage, managed PostgreSQL, and web/API hosting.
6. Provider outage simulation fails closed and recovery remains governed by Zeck's authoritative state.
7. RTO/RPO targets are documented with exact drill evidence for each environment covered by the program.
8. Recovery procedures are repeatable by a self-hosted operator using repository-defined tools and configuration.

# Implementation Requirements

- Use PostgreSQL as the sole durable domain authority during every recovery drill.
- Make backup/restore verification detect loss, corruption, checksum drift and incomplete restore conditions before declaring recovery success.
- Preserve artifact content addressing and lineage through provider migration.
- Make queue/workflow replay converge by existing dispatch/execution idempotency and never by provider-side deduplication alone.
- Prove worker fencing/evacuation against stale claims, heartbeats and regional failure.
- Demonstrate alternate-provider adapters/configuration without introducing provider-specific semantics into domain modules.
- Record outage simulations and recovery outcomes as bounded, auditable evidence tied to exact revisions.
- Measure and document RTO/RPO by environment; do not claim unexecuted live-provider results.
- Keep secrets provider-managed and environment isolated throughout drills.
- Keep CI/CD/recovery tooling as mechanisms over repository-defined procedures; preserve the self-hosting boundary.
- Add exact-revision static, dynamic and discrimination coverage for all acceptance criteria and checkpoint contracts.
- Do not modify `spec/development-state/*`; state transitions are Architect-owned after review/merge.

# Required Checkpoint Contracts

- `AUTH-PRESERVATION`
- `IDENTITY-IDEMPOTENCY`
- `CONCURRENCY-CRASH-SAFETY`
- `EXTERNAL-SIDE-EFFECTS`
- `EXECUTION-PROVENANCE`
- `SELF-HOSTING-BOUNDARY`
- `IMPLEMENTATION-COMPLETENESS`

# Checkpoints

### AUTH-PRESERVATION

Prove recovery never moves durable authority into provider, queue, workflow, dashboard or backup-control state.

### IDENTITY-IDEMPOTENCY

Prove replay and substitution preserve execution, artifact and deployment identity and do not duplicate authoritative effects.

### CONCURRENCY-CRASH-SAFETY

Prove worker evacuation, fencing and recovery converge after crash, timeout or regional loss with no stale-worker mutation.

### EXTERNAL-SIDE-EFFECTS

Prove provider outages and replacement do not create uncontrolled duplicate or irreversible side effects during replay/recovery.

### EXECUTION-PROVENANCE

Prove restored/replayed executions retain exact provenance, lineage and correlation across the recovery boundary.

### SELF-HOSTING-BOUNDARY

Prove recovery and provider replacement can be executed through repository-defined mechanisms with equivalent self-hosted procedures and no hidden provider authority.

### IMPLEMENTATION-COMPLETENESS

Prove all D-07 scope, acceptance criteria and Required Verification are implemented/tested, forbidden surfaces are untouched, and the evidence package maps each criterion to exact-revision implementation and drill results.

# Evidence Contract

The worker must publish at minimum:

- exact registered base SHA and final head SHA;
- complete changed-file inventory and ancestry proof;
- architecture/dependency/governance checks;
- backup/restore drill results;
- artifact recovery results;
- queue/workflow replay results;
- regional worker evacuation/fencing results;
- outage simulation results;
- alternate artifact-store proof;
- alternate managed-PostgreSQL proof;
- alternate web/API-host proof;
- measured RTO/RPO evidence by environment;
- exact CI status;
- exact external-infrastructure limitations, with unavailable live providers explicitly NOT RUN rather than claimed PASS.

# Required Verification

## Static

- typecheck;
- lint;
- architecture/dependency boundary tests;
- provider-neutrality and secret-flow checks;
- changed-path inspection against this Work Order.

## Dynamic

- real PostgreSQL backup/restore drills;
- artifact restore and identity verification;
- queue/workflow replay against real durable state;
- worker evacuation/fencing/reassignment drills;
- outage simulation and recovery procedures;
- alternate-provider adapter/configuration demonstrations;
- RTO/RPO measurement drills.

## Discrimination / mutation

- recovery from provider-local state instead of PostgreSQL must be rejected;
- replay must not duplicate authoritative execution/business effects;
- stale workers must not mutate after evacuation/fencing;
- provider-specific domain semantics must be rejected;
- artifact migration without identity/lineage preservation must fail;
- unverified recovery must not declare the environment recovered;
- preview/staging/production recovery credentials must remain environment-isolated.

# Completion

WORK-048 is complete only when all acceptance criteria and required checkpoints have exact-revision evidence, the Architect accepts the PR, the Architect merges it, and post-merge program/dependency/frontier/continuation/handoff state is finalized.

Required branch: `work/WORK-048-resilience-disaster-recovery-provider-exit`

One Work Order = one implementation branch = one PR. The worker cannot approve or merge its own PR.