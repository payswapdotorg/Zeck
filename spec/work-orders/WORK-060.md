# WORK-060 — Provider Redundancy, Private Connectivity, Residency and Availability Measurement (D-08)

Status: AUTHORIZED / PENDING (wave B — dispatches only after WORK-057 merges; rides the HA topology and extended recovery targets)

Owner: Implementation worker; Architect retains review, merge and state-finalization authority

Architecture Version: v1.0 (frozen); D1.0 + ADR-0021/ACR-005 (D-08 extension); binding requirements `AVA-001`, `AVA-003`, `SEC-003`

Assurance Profile: HIGH_ASSURANCE

# Objective

Implement the D-08 steady-state operations plane: declared alternate providers per durable concern (relational state, artifact bytes, queue transport, hosting) with typed failover and drill-measured redundancy evidence; private connectivity profiles in the environment matrix (internal control-plane/worker communication never traverses public paths in the production class); region as a first-class deployment dimension — tenants may declare data-residency constraints enforced at the existing deployment/adapter seams and consumed by policy; and the control-plane availability target (≥ 99.9% monthly, production class) made measurable through the D-06 release-control/observability surfaces with fail-closed semantics preserved.

# Dependencies

Requires: WORK-057

Dispatch context: wave B of D-08 (sole worker; every wave-A sibling merged). WORK-057's HA topology and extended recovery-targets.json are merged foundations at the dispatch base — import/consume only, never modify.

# Requirement IDs

`AVA-001` (control-plane availability target), `AVA-003` (independent provider redundancy), `SEC-003` (private connectivity and regional/data-residency) — binding text in docs/DEPLOYMENT-ROADMAP-D08-REQUIREMENTS.md.

# Declared Change Surfaces

Allowed modules/surfaces: `deploy/manifests/**` (environments.json environment-matrix extension: private connectivity + region/residency dimensions; providers.json alternates; never weakening existing entries); `src/platform/observability/**` (availability measurement over the D-06 release-control/telemetry plane); `src/platform/deployment/**` (environment/residency validation); `src/modules/policies/**` (residency constraint as policy input — constraint CONSUMED, never new authority); typed failover selection through the existing substrate seams; tests + drills; `docs/work-items/WORK-060.md`; operator documentation.

Forbidden to modify: `src/platform/db/**` HA machinery (WORK-057 merged — import/consume only), `src/modules/sandbox` and `src/modules/audit` (merged siblings — import only), `src/platform/compute/**`, `benchmarks/**`, frozen v1.0 public contracts, `spec/development-state/*` during active implementation, the d08-usage measurement surfaces.

# Scope Boundaries

Allowed:

- Provider redundancy: each durable concern declares a primary + alternate provider (typed), with failover profiles measured by drill in the environment classes where credentials exist; free-tier doctrine applies (disposable free-tier resources never operationally critical).
- Private connectivity: connectivity profiles (loopback/tunnel/private-endpoint vocabulary) in the environment matrix; the production class refuses public-path internal communication (validated by `deploy:validate`).
- Residency: region dimension on environments; tenant-declared data-residency constraints (policy input) enforced at deployment/adapter seams — data-at-rest locality (authoritative state, artifact bytes, evidence) satisfies the declared constraint or the operation fails closed.
- Availability measurement: the D-06 surfaces compute and record control-plane availability against the 99.9% target with exact-revision identity; a degraded control plane refusing to serve against a dead authority is measured as CORRECT behavior.

Forbidden:

- automatic multi-cloud failover without authority design (typed, drilled, explicit);
- residency as a new authority (it is a constraint consumed by policy);
- public-path internal traffic in the production class;
- absorbing provider control planes (Zeck consumes capability + economics);
- claiming redundancy without drill-measured evidence.

# Architecture Invariants

1. Every redundancy claim carries drill-measured evidence at exact revisions (never provider-dashboard claims).
2. Residency is a policy-consumed constraint; the authorities stay unchanged.
3. Failover is typed and governed (no silent automatic cross-provider migration of authority).
4. Availability never weakens the authoritative-dependency rule (fail-closed is correct and measured as such).
5. Free-tier resources are never operationally critical.
6. Private connectivity is validated, not documented-only.

# Acceptance Criteria

1. Alternate providers declared for every durable concern in providers.json with typed failover profiles; drill-measured evidence in the environment classes where execution is possible; honest NOT RUN elsewhere.
2. Private connectivity profiles in the environment matrix; `deploy:validate` enforces the production-class rule (no public-path internal communication).
3. Region/residency dimension: tenant residency constraints fail-closed at the adapter seams when unsatisfiable; satisfied constraints proven by test.
4. Availability computation from the D-06 surfaces with exact-revision identity and alert-state integration; the 99.9% target wired as the production-class threshold.
5. Discrimination/mutation tests: public-path internal traffic rejected; unsatisfied residency fails closed; ambient provider substitution rejected.
6. Full battery at the final head; evidence document `docs/work-items/WORK-060.md`.

# Implementation Requirements

- Build ON the merged WORK-057 HA surfaces and D-06 release control — import/consume only, never modify.
- Model alternates, connectivity profiles and residency constraints as typed data validated at the existing seams; fail closed on unmet preconditions.
- Residency rides the policy seam as a consumed constraint; no new authorization semantics.
- Record exact-revision evidence; never claim unexecuted results as PASS.
- Do not modify `spec/development-state/*`; state transitions are Architect-owned after review/merge.
- Migration numbering: take the next available number at your base (none expected — this WO should be migration-free; if one proves necessary, document why).

# Required Checkpoint Contracts

- `RELEASE-IDENTITY`
- `OBSERVABILITY-BOUNDARY`
- `SELF-HOSTING-BOUNDARY`
- `IDENTITY-IDEMPOTENCY`
- `EXECUTION-PROVENANCE`
- `IMPLEMENTATION-COMPLETENESS`

# Checkpoints

### RELEASE-IDENTITY

Prove availability records and redundancy drills carry exact-revision identity; no record is dissociated from its revision.

### OBSERVABILITY-BOUNDARY

Prove availability computation rides the D-06 telemetry plane import-only; no second metrics authority.

### SELF-HOSTING-BOUNDARY

Prove provider control planes stay provider-owned; live provider failovers are NOT RUN where credentials do not exist, disclosed exactly.

### IDENTITY-IDEMPOTENCY

Prove failover selection and availability computation are idempotent per revision window.

### EXECUTION-PROVENANCE

Prove residency decisions and failover selections carry replayable provenance.

### IMPLEMENTATION-COMPLETENESS

Prove all scope, acceptance criteria and Required Verification are implemented/tested, forbidden surfaces are untouched, and the evidence package maps each criterion to exact-revision results.

# Evidence Contract

The worker must publish at minimum: exact registered base SHA and final head SHA; complete changed-file inventory and ancestry proof; drill transcripts; residency fail-closed proofs; availability computation proof; honest NOT RUN boundaries.

# Required Verification

## Static

governance-check, typecheck, lint at the final head.

## Dynamic

Full unit + architecture + integration battery at the final head.

## Discrimination / mutation

Public-path internal traffic, unsatisfied residency, ambient provider substitution must all be rejected by test.

# Completion

WORK-060 is complete only when all acceptance criteria and required checkpoints have exact-revision evidence, the Architect accepts the PR, the Architect merges it, and post-merge program/dependency/frontier/continuation state is finalized.

Required branch: `work/WORK-060-provider-redundancy-residency-availability`

One Work Order = one implementation branch = one PR. The worker cannot approve or merge its own PR.
