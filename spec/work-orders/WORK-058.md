# WORK-058 — Compute Isolation Classes and Runtime Tenant Isolation (D-08)

Status: AUTHORIZED / PENDING (wave A — parallel with WORK-057, WORK-059; disjoint surfaces)

Owner: Implementation worker; Architect retains review, merge and state-finalization authority

Architecture Version: v1.0 (frozen); D1.0 + ADR-0021/ACR-005 (D-08 extension); binding requirements `SEC-001`, `SEC-002`

Assurance Profile: CRITICAL

# Objective

Implement the D-08 compute-isolation plane: hardened isolation profiles on the sandbox authority — a `strict` class for untrusted/consequential work and `dedicated customer runner` profiles with isolated resource pools (no shared claim/artifact/secret state with other tenants) — plus discrimination-proven runtime tenant isolation: cross-tenant data access impossible BY CONSTRUCTION at the worker/runner plane (claims, artifacts, secrets and evidence scoped to the requesting tenant/application identity through the existing identity→policy boundary), including under worker evacuation and reassignment. Profile selection remains a governed policy/capability decision, never an ambient default.

# Dependencies

Requires: WORK-046

Enables: WORK-060 (residency enforcement rides isolation profiles).

Dispatch context: wave A of D-08. Sibling workers in flight: WORK-057 (platform/db + deploy — import/consume only, never modify), WORK-059 (audit — import/consume only).

# Requirement IDs

`SEC-001` (runtime tenant isolation) and `SEC-002` (compute isolation classes and dedicated runners) — binding text in docs/DEPLOYMENT-ROADMAP-D08-REQUIREMENTS.md.

# Declared Change Surfaces

Allowed modules/surfaces: `src/modules/sandbox/**` (isolation profile types, environment catalog extension, admission policy integration); `src/platform/compute/**` (runner profile wiring, evacuation/reassignment seams); `src/platform/sandbox/**` (runtime adapter profile plumbing); sandbox/compute migrations (next available number); discrimination + mutation tests; `docs/work-items/WORK-058.md`; operator documentation.

Forbidden to modify: `src/platform/db/**` and `deploy/**` (owned by WORK-057/060), `src/modules/audit/**` (WORK-059), `src/modules/executions|policies|budgets` semantics (import/consume only), `benchmarks/**`, frozen v1.0 public contracts, `spec/development-state/*` during active implementation, the d08-usage measurement surfaces.

# Scope Boundaries

Allowed:

- Isolation profile types: `standard`, `strict` (hardened: no ambient host access, tightened capability surface), `dedicated-customer` (isolated resource pools: separate claim/artifact/secret namespaces per tenant).
- Profile selection as a governed decision through the existing policy/capability seams (policy declares the required class; the sandbox authority admits/constructs it).
- Tenant-scoped claims/artifacts/secrets/evidence at the worker/runner plane, enforced by construction (scoped resolution at the seam, not filtering after fetch).
- Discrimination tests: hostile/misrouted claim crossing tenants fails closed; evacuation/reassignment preserves scoping; profile downgrade is rejected; ambient default assignment is rejected.
- Dedicated-runner pool isolation: no shared state between pools, proven by test.

Forbidden:

- a new authority (isolation is a policy-consumed constraint on the EXISTING sandbox/compute authorities);
- security by filtering post-fetch (scoping must be constructional);
- weakening existing isolation to make tests pass;
- absorbing provider sandboxing control planes (provider mechanisms stay provider-owned).

# Architecture Invariants

1. Isolation is consumed by policy, never an ambient default and never a new authority.
2. Cross-tenant access fails closed BY CONSTRUCTION (scoped resolution at the seam).
3. Evacuation/reassignment preserves tenant scoping (a reassigned claim never widens scope).
4. `strict` never weakens; profile transitions are governed and monotonic where required.
5. Dedicated pools share NOTHING (claims, artifacts, secrets, evidence).
6. Determinism: the same profile + policy context admits the same environment shape.
7. Discrimination evidence at exact revisions; honest NOT RUN boundaries for external hardened runtimes.

# Acceptance Criteria

1. Typed isolation profiles (`standard`/`strict`/`dedicated-customer`) with governed selection through policy/capability seams.
2. Discrimination battery: misrouted/hostile claims fail closed (cross-tenant read/write/execute rejected with typed denial), including under evacuation and reassignment.
3. Strict-class enforcement proven (capability surface restricted; ambient host access absent — tested).
4. Dedicated-pool isolation proven (zero shared state, typed pool identity).
5. No ambient default profile assignment (ungoverned assignment rejected).
6. Full unit + integration (real PostgreSQL) + architecture boundary coverage at the final head.
7. Evidence document `docs/work-items/WORK-058.md` mapping every criterion to exact-revision results.

# Implementation Requirements

- Build ON the D-05 worker fabric and D-07 evacuation seams — extend, never replace.
- Model profiles and pool identity as typed data; selection is a pure governed decision; fail closed on unmet preconditions.
- Tenant scoping rides the EXISTING identity→policy boundary (claims resolution); no new authorization semantics.
- Record exact-revision evidence; never claim unexecuted results as PASS.
- Do not modify `spec/development-state/*`; state transitions are Architect-owned after review/merge.
- Migration numbering: take the next available number at your base; a collision with a merged sibling is reconciled by the Architect at merge time.

# Required Checkpoint Contracts

- `TENANT-ISOLATION`
- `SANDBOX-BOUNDARY`
- `IDENTITY-IDEMPOTENCY`
- `CONCURRENCY-CRASH-SAFETY`
- `DEPENDENCY-DIRECTION`
- `IMPLEMENTATION-COMPLETENESS`

# Checkpoints

### TENANT-ISOLATION

Prove cross-tenant access is impossible by construction at the worker/runner plane, including under evacuation and reassignment — hostile/misrouted claims fail closed with typed denials.

### SANDBOX-BOUNDARY

Prove `strict` profiles restrict the capability surface and ambient host access is absent; profile selection is governed, never ambient.

### IDENTITY-IDEMPOTENCY

Prove admission/assignment under the same profile + policy context is idempotent: identical environment shape, bounded no-op on re-run.

### CONCURRENCY-CRASH-SAFETY

Prove concurrent admission, evacuation and reassignment never widen scope or corrupt pool identity.

### DEPENDENCY-DIRECTION

Prove the isolation plane depends only on the declared seams; module semantics are import-only; no authority consults isolation state for authorization.

### IMPLEMENTATION-COMPLETENESS

Prove all scope, acceptance criteria and Required Verification are implemented/tested, forbidden surfaces are untouched, and the evidence package maps each criterion to exact-revision results.

# Evidence Contract

The worker must publish at minimum: exact registered base SHA and final head SHA; complete changed-file inventory and ancestry proof; discrimination test transcripts; pool-isolation proof; honest NOT RUN boundaries (external hardened runtimes).

# Required Verification

## Static

governance-check, typecheck, lint at the final head.

## Dynamic

Full unit + architecture + integration battery (real PostgreSQL) at the final head.

## Discrimination / mutation

Misrouted claims, ambient assignment, profile downgrade, pool cross-talk must all be rejected by test.

# Completion

WORK-058 is complete only when all acceptance criteria and required checkpoints have exact-revision evidence, the Architect accepts the PR, the Architect merges it, and post-merge program/dependency/frontier/continuation state is finalized.

Required branch: `work/WORK-058-compute-isolation-tenant-isolation`

One Work Order = one implementation branch = one PR. The worker cannot approve or merge its own PR.
