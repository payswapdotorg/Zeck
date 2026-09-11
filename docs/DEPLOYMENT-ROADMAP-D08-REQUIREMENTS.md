# Zeck D-08 — Explicit Availability and Security Requirements

**Status:** APPROVED (Architect) — the gate-2 artifact for D-08
**Date:** 2026-09-10
**Authority:** Architect, under product-owner direction to complete the deployment roadmap
**Governing architecture:** v1.0 (frozen) + D1.0 (ACR-002) + ADR-0021 / ACR-005 (D-08 extension)
**Baseline anchors:** `deploy/manifests/recovery-targets.json` (D-07 repository truth), the D-07 executed drill evidence (local RTO 1692ms / RPO 0ms, `docs/work-items/WORK-048.md`), and the D-08 measured usage baseline (`docs/deployment/D08-PRODUCTION-USAGE-MEASUREMENT.md`, gate-1 evidence).

## Provenance

D-08 is gated on "explicit availability/security requirements" (docs/DEPLOYMENT-ROADMAP.md). These requirements are derived from the D-08 scope defined in the deployment roadmap (regional/data-residency deployment; private connectivity; runtime tenant isolation; stronger compute isolation; dedicated customer runners; high-availability database topology; advanced audit/compliance controls; independent provider redundancy) and from the measured D-07 resilience baseline. They are recorded here by the Architect so D-08 Work Orders can carry exact, measurable acceptance criteria. No requirement herein creates a new authority, a second durable state source, or any frozen-v1.0 change.

## Availability requirements

### AVA-001 — Control-plane availability target

The request-facing control plane (API) targets **≥ 99.9% monthly availability** in the production environment class, measured by the D-06 release-control/observability surfaces (which already record exact-revision identity and alert state). Fail-closed semantics are preserved: availability is never achieved by weakening the authoritative-dependency rule (a degraded control plane that refuses to serve against a dead authority is CORRECT behavior and must be measured as such, not worked around).

### AVA-002 — High-availability authoritative state

PostgreSQL remains the SOLE durable authority. D-08 extends the deployment topology with an HA configuration (primary + standby replica) and failover procedure:

- production RPO target: **≤ 60 seconds** with asynchronous replication, **0** on the synchronous path where configured;
- production RTO target for authority failover: **≤ 15 minutes**, measured by executing `deploy:drill` against the HA topology (extending `deploy/manifests/recovery-targets.json`, never replacing it);
- the D-07 invariant-gate restore proof (12 checks) must pass identically after failover;
- recovery RESTORES authority; it never reconstructs it from providers.

### AVA-003 — Independent provider redundancy

No durable concern (relational state, artifact bytes, queue transport, hosting) may depend on a single external provider in the production class. Each concern has a declared alternate provider (D-07 proved substitution for artifacts and hosting; D-08 extends it to steady-state redundancy with typed failover), and each redundancy claim carries drill-measured evidence. Free-tier doctrine applies: disposable free-tier resources are never operationally critical (docs/DEPLOYMENT-ROADMAP.md, Free-tier operating doctrine).

### AVA-004 — Transport loss never loses governed work

Queue/workflow replay convergence (proven in D-07 after total transport loss) must hold on the HA topology: after failover, in-flight governed work converges through the EXISTING dispatch/execution idempotency — never provider dedup — with zero duplicated side effects, proven by the replay drill executed against the redundant transport.

## Security and isolation requirements

### SEC-001 — Runtime tenant isolation

Cross-tenant data access is impossible **by construction** at the worker/runner plane: claims, artifacts, secrets and evidence are scoped to the requesting tenant/application identity through the existing identity→policy boundary. Isolation is discrimination-tested (a hostile/misrouted claim that would cross tenants must fail closed), including under worker evacuation and reassignment.

### SEC-002 — Compute isolation classes and dedicated runners

The sandbox authority gains hardened isolation profiles: a **strict** class for untrusted/consequential work and **dedicated customer runner** profiles with isolated resource pools (no shared claim/artifact/secret state with other tenants). Profile selection remains a governed policy/capability decision, not an ambient default.

### SEC-003 — Private connectivity and regional/data-residency

Internal control-plane/worker communication must not traverse public paths in the production class (private connectivity profiles in the environment matrix). Region becomes a first-class deployment dimension: tenants may declare data-residency constraints, and data-at-rest locality (authoritative state, artifact bytes, evidence) must satisfy the declared constraint, enforced at the existing deployment/adapter seams. Residency is a constraint consumed by policy — never a new authority.

### SEC-004 — Advanced audit and compliance controls

The evidence authority gains an immutable, complete audit projection of governed actions (who/what/when/why with provenance), with compliance evidence export, retention policy, and legal hold. Audit records are append-only evidence; they never become a second ledger or authorization source.

## Measurement and acceptance discipline

Every D-08 Work Order binds these requirements to: exact-revision evidence, real-PostgreSQL/real-topology drill measurements (RTO/RPO), discrimination/mutation tests for isolation claims, honest NOT RUN boundaries for unavailable external infrastructure, and the existing governance/typecheck/lint/test gates. A requirement is satisfied only by measured evidence at the exact accepted head — never by claim.
