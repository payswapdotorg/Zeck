# WORK-057 — High-Availability Authoritative State and Failover (D-08)

Status: AUTHORIZED / PENDING (wave A — parallel with WORK-058, WORK-059; disjoint surfaces)

Owner: Implementation worker; Architect retains review, merge and state-finalization authority

Architecture Version: v1.0 (frozen); D1.0 + ADR-0021/ACR-005 (D-08 extension); binding requirements `AVA-002`, `AVA-004`

Assurance Profile: CRITICAL

# Objective

Implement the D-08 high-availability authoritative-state plane: a PostgreSQL primary + standby topology for the production environment class, a governed failover procedure measured by `deploy:drill`, RPO ≤ 60 s on the asynchronous replication path (0 on the synchronous path where configured), RTO ≤ 15 minutes for authority failover, the D-07 invariant-gate restore proof passing identically after failover, and queue/workflow replay convergence after failover through the EXISTING dispatch/execution idempotency (zero duplicated side effects) — recovery RESTORES authority; it never reconstructs it from providers.

# Dependencies

Requires: WORK-048

Enables: WORK-060 (provider redundancy and residency ride the HA topology and the extended recovery targets).

Dispatch context: wave A of D-08 (first post-gate wave). Sibling workers in flight: WORK-058 (sandbox/compute — import/consume only, never modify), WORK-059 (audit — import/consume only). D-08 gate-1 evidence merged as PR #32 (f5feb14) — the measured usage baseline is a dispatch-base input, never a surface to modify.

# Requirement IDs

`AVA-002` (high-availability authoritative state) and `AVA-004` (transport loss never loses governed work) — binding text in docs/DEPLOYMENT-ROADMAP-D08-REQUIREMENTS.md.

# Declared Change Surfaces

Allowed modules/surfaces: `deploy/manifests/recovery-targets.json` (EXTEND — add HA topology targets; never replace existing entries); `deploy/` failover tooling (new `deploy:drill` scenario: authority-failover); `src/platform/db/**` (topology configuration, replication-readiness probes, failover port + adapters); HA integration tests over real PostgreSQL; `docs/work-items/WORK-057.md`; operator documentation for the HA procedure.

Forbidden to modify: `src/modules/**` (all module semantics — import/consume only), `src/platform/compute/**`, `src/platform/observability/**`, `src/modules/audit/**`, `src/platform/sandbox/**`, `benchmarks/**`, `spec/development-state/*` during active implementation, frozen v1.0 public contracts, the D-07 drill scenarios' existing semantics (extend, never weaken), the d08-usage measurement surfaces.

# Scope Boundaries

Allowed:

- HA topology declaration: primary + standby per environment class (production-class target; local/CI exercise the same machinery over a real second local PostgreSQL instance).
- Replication-readiness probing and lag measurement (RPO evidence) through a platform port.
- A governed failover procedure: promote standby, repoint the database port, re-run the D-07 invariant-gate restore proof post-failover, record measured RTO/RPO.
- Replay convergence drill on the HA topology: total transport loss → failover → in-flight governed work converges through existing idempotency with zero duplicated side effects.
- Fail-closed degradation preserved: a control plane that refuses to serve against a dead authority is CORRECT behavior, measured as such.

Forbidden:

- provider-managed HA control planes absorbed into Zeck (provider mechanisms remain provider-owned; Zeck consumes capability + economics);
- any second durable authority or reconstructed-from-providers state;
- weakening the authoritative-dependency rule to fake availability;
- modifying sibling surfaces or the D-07 restore proof itself.

# Architecture Invariants

1. PostgreSQL remains the SOLE durable authority; HA extends topology, never authority.
2. Failover RESTORES authority; it never reconstructs it.
3. Replay convergence uses the EXISTING dispatch/execution idempotency — never provider dedup.
4. RTO/RPO are measured claims at exact revisions recorded in recovery-targets.json; never aspirational.
5. The invariant-gate restore proof passes identically after failover.
6. Fail-closed semantics are preserved and tested (degraded control plane refusing to serve against dead authority is correct).
7. Zero duplicated side effects across failover, proven by drill, not claim.

# Acceptance Criteria

1. HA topology (primary+standby) declarable per environment class through repository truth; local/CI run the same machinery against a real second PostgreSQL instance.
2. `deploy:drill` executes the authority-failover scenario: standby promotion, port repoint, invariant-gate restore proof green post-failover, measured RTO/RPO recorded (production-class targets: RTO ≤ 15 min, RPO ≤ 60 s asynchronous / 0 synchronous).
3. Replay convergence drill after transport loss on the HA topology: in-flight governed work converges, zero duplicated side effects (durable-ledger equality proof).
4. A replication-lag probe measures RPO evidence (lag at the failover instant recorded).
5. recovery-targets.json extended (never replaced); `deploy:validate` accepts the extension.
6. Full discrimination/mutation battery: failover that would duplicate effects, reconstruct state, or serve against a dead authority is rejected.
7. Honest NOT RUN boundaries for provider-managed HA features unavailable in the worker sandbox.

# Implementation Requirements

- Build ON the D-07 resilience surfaces (deploy/drill.ts, recovery invariants, recovery-targets.json) — extend, never replace.
- Model topology, readiness and failover as typed platform data + ports; fail closed on unmet preconditions.
- The failover drill must run over REAL PostgreSQL instances (primary + standby) in the worker sandbox; no simulation claimed as provider proof.
- Record measured RTO/RPO with exact-revision evidence; never claim unexecuted results as PASS.
- Do not modify `spec/development-state/*`; state transitions are Architect-owned after review/merge.
- Migration numbering: take the next available number at your base; a collision with a merged sibling is reconciled by the Architect at merge time.

# Required Checkpoint Contracts

- `IDENTITY-IDEMPOTENCY`
- `CONCURRENCY-CRASH-SAFETY`
- `EXECUTION-PROVENANCE`
- `DEPENDENCY-DIRECTION`
- `SELF-HOSTING-BOUNDARY`
- `IMPLEMENTATION-COMPLETENESS`

# Checkpoints

### IDENTITY-IDEMPOTENCY

Prove failover and convergence are idempotent: re-running the failover drill against an already-promoted topology is a bounded no-op; convergence produces zero duplicated side effects.

### CONCURRENCY-CRASH-SAFETY

Prove failover behaves correctly under load: concurrent executions during promotion converge through existing idempotency; no claim is stranded or double-applied.

### EXECUTION-PROVENANCE

Prove exact provenance from failover instant through promotion to restore-proof green, replayable by deterministic audit.

### DEPENDENCY-DIRECTION

Prove the HA plane depends only on the declared platform seams; modules and sibling planes are import-only; nothing consults failover state for authorization.

### SELF-HOSTING-BOUNDARY

Prove provider-managed HA control planes are never absorbed; live provider HA APIs are NOT RUN and disclosed exactly.

### IMPLEMENTATION-COMPLETENESS

Prove all scope, acceptance criteria and Required Verification are implemented/tested, forbidden surfaces are untouched, and the evidence package maps each criterion to exact-revision results.

# Evidence Contract

The worker must publish at minimum: exact registered base SHA and final head SHA; complete changed-file inventory and ancestry proof; drill transcripts with measured RTO/RPO; invariant-gate restore-proof output post-failover; replay-convergence ledger equality proof; honest NOT RUN boundaries.

# Required Verification

## Static

governance-check, typecheck, lint at the final head.

## Dynamic

Full unit + architecture + integration battery (real PostgreSQL primary + standby) at the final head.

## Discrimination / mutation

Failover duplicating effects, reconstructing authority, or serving against a dead authority must be rejected by test.

# Completion

WORK-057 is complete only when all acceptance criteria and required checkpoints have exact-revision evidence, the Architect accepts the PR, the Architect merges it, and post-merge program/dependency/frontier/continuation state is finalized.

Required branch: `work/WORK-057-ha-authoritative-state-failover`

One Work Order = one implementation branch = one PR. The worker cannot approve or merge its own PR.
