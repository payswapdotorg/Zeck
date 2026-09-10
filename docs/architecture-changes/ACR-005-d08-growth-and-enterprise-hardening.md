# ACR-005 — D-08 Growth and Enterprise Hardening

**Status:** APPROVED architectural extension
**Date:** 2026-09-10
**Authority:** Architect
**Supersedes:** None
**Builds on:** ACR-002 (D1.0 deployment/runtime), ACR-003 (E1.0), ACR-004 (E1.1)
**Companion ADR:** `docs/adr/ADR-0021-d08-growth-and-enterprise-hardening.md`
**Governing requirements:** `docs/DEPLOYMENT-ROADMAP-D08-REQUIREMENTS.md` (AVA-001..004, SEC-001..004)

## Decision

The D-08 "Growth and enterprise hardening" deployment phase is architecturally approved as a subordinate extension of the frozen v1.0 architecture and the approved D1.0/E1.0/E1.1 stack:

- high-availability authoritative-state topology (PostgreSQL remains the sole durable authority; failover must pass the D-07 invariant gate unchanged);
- independent provider redundancy for every durable concern with typed failover and drill-measured evidence;
- runtime tenant isolation by construction with discrimination tests;
- hardened compute-isolation classes and dedicated customer runner profiles under the existing sandbox authority;
- private connectivity and regional/data-residency as deployment-matrix dimensions and policy-consumed constraints;
- advanced audit/compliance controls as an append-only evidence projection.

## Authority boundaries preserved

No new authority for execution lifecycle, policy, capabilities, budgets, tenant identity, credentials/secrets, sandbox/substrate, verification or evidence. Providers remain substrate adapters. Fail-closed semantics are inviolable. Every availability or isolation claim requires measured, exact-revision evidence with honest NOT RUN boundaries.

## Gate satisfaction record

| D-08 gate | Artifact | Status |
|---|---|---|
| measured production usage | `docs/deployment/D08-PRODUCTION-USAGE-MEASUREMENT.md` (gate task, branch `gate/d08-measured-usage`) | IN FLIGHT — must be merged before D-08 Work Orders are dispatched |
| explicit availability/security requirements | `docs/DEPLOYMENT-ROADMAP-D08-REQUIREMENTS.md` (AVA-001..004, SEC-001..004) | SATISFIED (this record) |
| Architect-approved architecture extension | ADR-0021 + this ACR | SATISFIED (this record) |

D-08 Work Orders become executable only after all three gates are recorded and the frontier state authorizes them.
