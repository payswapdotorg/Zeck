# ADR-0021 — D-08 Growth and Enterprise Hardening Architecture Extension

**Status:** APPROVED
**Date:** 2026-09-10
**Authority:** Architect
**Supersedes:** None
**Builds on:** ADR-0016 (D1.0 deployment/runtime architecture, if numbered differently see ACR-002), ADR-0017, ADR-0018, ADR-0019, ADR-0020
**Governing requirements:** `docs/DEPLOYMENT-ROADMAP-D08-REQUIREMENTS.md` (AVA-001..004, SEC-001..004)

## Context

The deployment roadmap's final phase D-08 ("Growth and enterprise hardening") moves the platform from lean MVP operations to high-assurance multi-tenant infrastructure. Its gate required "measured production usage, explicit availability/security requirements and an Architect-approved architecture extension". The usage baseline is being recorded as gate-1 evidence; the requirements above are the gate-2 artifact; this ADR (with ACR-005) is the gate-3 architecture extension.

## Decision

D-08 is an **extension of the existing authorities, never a new authority**. Concretely:

1. **HA database topology** — PostgreSQL remains the SOLE durable authority. Primary + standby topology, replication mode and failover procedure are deployment-substrate configuration owned by the existing `src/platform/db` + `deploy/` surfaces. Failover must pass the D-07 invariant-gate restore proof unchanged. `deploy/manifests/recovery-targets.json` is EXTENDED (HA targets per environment), never replaced.

2. **Independent provider redundancy** — the D-07 provider-substitution proofs (artifact bytes R2→alternate S3, alternate hosting, alternate managed PostgreSQL) are extended to steady-state redundancy: each durable concern declares a live alternate with typed failover classes. Providers remain substrate adapters; provider state never becomes Zeck authority.

3. **Runtime tenant isolation** — enforced at the existing identity→policy→execution boundaries and the worker claim plane. Isolation claims require discrimination tests (hostile cross-tenant access fails closed), including under evacuation/reassignment. No new tenant authority is created.

4. **Compute isolation classes + dedicated runners** — the existing sandbox authority (`src/platform/sandbox`, compute substrate contracts) gains typed isolation profiles (strict class for untrusted/consequential work; dedicated customer runner profiles with isolated pools). Profile selection is a policy/capability decision.

5. **Private connectivity + regional/data-residency** — region/residency become deployment-matrix dimensions (`deploy/manifests/`) and policy-consumed constraints. Data-at-rest locality is enforced at existing deployment/adapter seams. Residency is a constraint, never an authority.

6. **Advanced audit/compliance** — the existing evidence/observability authority gains an append-only audit projection of governed actions, compliance export, retention and legal hold. Audit records are evidence only.

## What this ADR does NOT authorize

- No second durable state source, ledger, state machine or cache authority.
- No frozen-v1.0 change; no change to the E1.1 objective or Execution Compiler role.
- No provider-specific domain semantics (provider HA/residency features are adapter mechanisms).
- No weakening of fail-closed authoritative-dependency semantics to "improve" availability numbers.
- No self-serve tenant trust: isolation and compliance claims must be measured, discrimination-tested and drilled, never asserted.

## Alternatives rejected

- **Multi-primary/multi-authority state:** rejected — recreates split-brain authority; v1.0 forbids a second durable authority.
- **Provider-managed HA as authority:** rejected — provider topology is substrate; authority stays with PostgreSQL through the existing ports.
- **Audit as a new ledger:** rejected — audit is an evidence projection of the existing event/evidence authority.
- **Residency as a new policy authority:** rejected — residency is a constraint consumed by the existing policy layer.

## Consequences

D-08 implementation proceeds through Architect-issued Work Orders (one branch = one PR, max three concurrent workers) carrying the AVA/SEC requirements as acceptance criteria with measured-evidence discipline. The completion of D-08 closes the deployment roadmap D-00→D-08 sequence.
