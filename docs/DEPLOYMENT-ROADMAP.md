# Zeck Deployment Roadmap

Deployment & Runtime Architecture **D1.0** is subordinate to frozen core architecture **v1.0**. This document is the authoritative deployment sequence; chat does not authorize phase changes.

## D-00 — Architecture and deployment contract

**Goal:** approve the deployment/runtime architecture and its authority boundaries.

**Status:** COMPLETE.

## D-01 — Reproducible infrastructure foundation

**Goal:** define reproducible, environment-separated infrastructure and provider adapters.

**Scope:** repository-defined environments; deployment manifests; provider-neutral configuration; secret references; bootstrap and validation; self-hosting boundary.

**Status:** COMPLETE — WORK-042 / PR #2, merge `b75e23bacf9a9ace76e88e643ea2a272f588a0f9`.

## D-02 — Database and artifact production path

**Goal:** establish authoritative PostgreSQL production state and durable artifact storage.

**Scope:** managed PostgreSQL adapter; deterministic migrations; backup/restore tooling; Cloudflare R2 artifact path; large-byte separation from PostgreSQL.

**Acceptance:** authority remains in PostgreSQL; large bytes do not pass through PostgreSQL unnecessarily; restore is tested, not merely documented.

**Status:** COMPLETE — WORK-043 / PR #4, merge `2175bc6c73ad0a8d4b5ab2efb6a8930cfdb01b17`.

## D-03 — Asynchronous execution transport

**Goal:** make execution dispatch durable and restartable.

**Scope:** queue adapter; durable dispatch records; idempotent consumers; retry/dead-letter behavior; queue metrics; replay tooling; execution-to-message correlation.

**Acceptance:** worker crashes are recoverable; duplicate delivery cannot duplicate authoritative effects; a queued message is never mistaken for execution success.

**Status:** COMPLETE — WORK-044 / PR #6, merge `985ca850faaa620cf3df05675f7af74e2073f188`.

## D-04 — Durable orchestration

**Goal:** add long-lived orchestration for waits, callbacks, approvals, retries and deployment operations.

**Scope:** workflow adapter; execution/workflow correlation; resume-after-failure; human-in-the-loop waits; timeout/expiration; state compaction; provider-limit monitoring.

**Acceptance:** workflow state remains subordinate to Zeck authority; waiting executions survive process restarts; large artifacts and secret values stay outside workflow state.

**Status:** COMPLETE — WORK-045 / PR #8, merge `0067c72c8179a6f880f5477789958370376b8de9`.

## D-05 — Execution worker deployment fabric

**Goal:** deploy actual model/tool/agent/program execution outside request lifecycle.

**Scope:** worker service; provider adapters in worker runtime; container `ComputeEnvironment`; execution leases/heartbeats; cancellation; worker drain/shutdown; concurrency controls; per-environment quotas; optional customer runner registration.

**Acceptance:** no long-running execution depends on an HTTP request staying open; worker failure converges to durable execution state; untrusted code receives no ambient credentials or unrestricted host access.

**Status:** COMPLETE — WORK-046 / PR #10, merge `5d26365ee9b8e55f41b923328443ae746205757a`. Revision 1 corrected execution-scoped external runner identity/idempotency before acceptance.

## D-06 — Production delivery, observability and release control

**Goal:** make deployments safe to promote, inspect, roll back and audit.

**Scope:** GitHub-to-provider CI/CD; local → CI → preview → staging → production promotion controls; exact commit/deployment identity; migration gating; health/smoke gates; OpenTelemetry-compatible traces/metrics/logs; error monitoring; quota/cost alerts; release rollback.

**Acceptance:** every production deployment maps to an exact Git commit; failed releases can be rolled back without changing durable domain state; operational alerts exist before resource exhaustion; preview/staging/production credentials and state remain isolated.

**Status:** COMPLETE — WORK-047 / Issue #11 / PR #12, merge `ad27648ebf78f868a749cdbc924f84e20dd62161`.

Exact synchronized GitHub Actions at the accepted head passed: Repository Governance; Deployment Validation; Deployment Release Control. Live provider/OTLP infrastructure not available in the worker environment remains explicitly NOT RUN rather than claimed as PASS.

## D-07 — Resilience, disaster recovery and provider exit

**Goal:** prove Zeck can survive infrastructure loss and provider substitution.

**Work Order:** `WORK-048`.

**Issue:** #13.

**Required branch:** `work/WORK-048-resilience-disaster-recovery-provider-exit`.

**Dependency:** WORK-047.

**Scope:** PostgreSQL recovery drills; artifact recovery drills; queue/workflow replay; regional worker evacuation; provider outage simulations; R2 → alternate S3-compatible store migration proof; PostgreSQL → alternate managed PostgreSQL proof; Vercel → alternate web/API host proof; documented/measured RTO/RPO by environment.

**Acceptance:** authority can be restored from repository-defined procedures; provider replacement changes adapters/configuration rather than domain semantics; disaster recovery evidence is repeatable; recovery and replay preserve identity, provenance, idempotency and tenant isolation.

**Status:** AUTHORIZED / PENDING — D-07 became executable only after WORK-047 was accepted, merged and post-merge state finalized.

## D-08 — Growth and enterprise hardening

**Goal:** move from lean MVP operations to high-assurance multi-tenant infrastructure.

**Scope:** regional/data-residency deployment; private connectivity; runtime tenant isolation; stronger compute isolation; dedicated customer runners; high-availability database topology; advanced audit/compliance controls; independent provider redundancy.

**Gate:** D-08 may only begin after measured production usage, explicit availability/security requirements and an Architect-approved architecture extension.

**Status:** BLOCKED — downstream of D-07 and its explicit architecture-extension gate.

## Execution ordering

```text
D-00
  -> D-01
  -> D-02
  -> D-03
  -> D-04
  -> D-05
  -> D-06
  -> D-07
  -> D-08
```

Some phases may be split into parallel Work Orders when their declared surfaces do not conflict. The Architect derives concurrency from actual repository state; the roadmap does not authorize unsafe parallelism.

## Free-tier operating doctrine

Free tiers are development accelerators, not durability or availability guarantees.

The implementation must meter usage, alert before quota exhaustion, make limits visible, avoid uncontrolled paid overage where hard caps exist, isolate production resources from disposable free-tier resources, and preserve migration paths before a free tier becomes operationally critical.

## Environment promotion

```text
local
  -> CI
  -> preview
  -> staging
  -> production
```

Promotion requires successful checks appropriate to the phase. Production does not inherit preview secrets or mutable state.

## Definition of deployment completeness

Deployment architecture is complete when:

1. all production resources are repository-defined;
2. control and execution planes can be deployed independently;
3. durable authority has tested backup/restore;
4. execution dispatch is restartable and idempotent;
5. artifacts survive compute loss;
6. secrets are provider-managed and never source-controlled;
7. end-to-end observability can reconstruct executions without secrets;
8. releases are attributable to exact commits and rollbackable without domain mutation;
9. active spend/quota monitoring prevents uncontrolled overage;
10. at least one replacement implementation is demonstrated for each critical provider category.

Provider access that is unavailable is recorded as **NOT RUN**, never converted into a PASS.
