# Zeck — Deployment Roadmap

**Status:** AUTHORITATIVE / APPROVED
**Architecture:** Deployment & Runtime Architecture D1.0
**Parent:** `spec/architecture.md` v1.0 (frozen)
**Approved:** 2026-09-05

## Source-of-truth rule

This roadmap is the authoritative sequence for implementing Zeck deployment infrastructure. `docs/DEPLOYMENT-ARCHITECTURE.md` is the authoritative target architecture. `ACR-002` records the architectural approval.

No worker may infer deployment work from chat. Each roadmap phase becomes executable only through an approved repository Work Order with explicit surfaces, dependencies, acceptance criteria and evidence requirements.

## Strategic objective

Reach a commercially deployable, low-cost, provider-portable Zeck platform without allowing hosting infrastructure to become domain authority.

The roadmap optimizes for five properties:

1. lowest sensible operating cost during early product development;
2. fast environment creation and teardown;
3. durable authority and recovery;
4. safe autonomous execution;
5. clean provider substitution as Zeck grows.

## Provider strategy

### Reference development stack

- Vercel Hobby for personal/non-commercial experience previews;
- Neon Free for disposable databases;
- Cloudflare R2 Free for development artifacts;
- Cloudflare Queues Free for development dispatch transport;
- Cloudflare Workflows Free where orchestration fits its limits;
- Upstash Redis Free for ephemeral coordination;
- Clerk/Resend free tiers where permitted by their current terms.

### Reference commercial MVP stack

- Vercel Pro or equivalent commercially permitted experience/API hosting;
- Neon Launch PostgreSQL;
- Cloudflare R2;
- Cloudflare Queues + Workers + Workflows;
- Upstash pay-as-you-go or appropriate fixed tier;
- Clerk and Resend at the minimum commercial tier required by actual usage.

### Growth stack

- dedicated control-plane compute;
- independently scalable execution workers;
- stronger sandbox isolation;
- regional worker pools;
- automated DR;
- provider redundancy for critical external services.

## Roadmap phases

### D-00 — Architecture and deployment contract

**Goal:** Freeze the operational deployment target before implementation starts.

Deliverables:

- D1.0 deployment architecture;
- provider substitution matrix;
- environment model;
- secret/reference model;
- deployment naming conventions;
- resource ownership conventions;
- cost-control policy;
- failure/degraded-mode rules.

**Gate:** Repository contains one authoritative deployment target and no contradictory deployment guidance.

**Status:** COMPLETE — this roadmap and D1.0 architecture are approved by the Architect.

### D-01 — Reproducible infrastructure foundation

**Goal:** Make every required infrastructure resource reproducible from repository-controlled configuration.

Scope:

- provider projects/accounts/resource naming;
- environment separation;
- Neon projects/branches;
- R2 buckets;
- Redis databases;
- queues/workflows;
- Vercel projects;
- configuration manifests;
- environment variable contracts;
- secret references;
- health endpoints;
- deployment identifiers.

Acceptance:

- no required production behavior depends on undocumented console configuration;
- resources can be recreated from repository instructions/configuration;
- credentials never enter Git history;
- smoke checks identify each environment exactly.

**Status:** COMPLETE — WORK-042 / PR #2 merged.

### D-02 — Database and artifact production path

**Goal:** Connect Zeck authority to managed production-grade services.

Scope:

- Neon PostgreSQL adapter/configuration;
- migrations and startup checks;
- transaction/connection-pool validation;
- R2 `ObjectStore` adapter/configuration;
- signed upload/download flow where applicable;
- artifact hash/integrity checks;
- retention/cleanup jobs;
- backup/restore procedures.

Acceptance:

- authority remains in PostgreSQL;
- large bytes do not pass through PostgreSQL unnecessarily;
- restore is tested, not merely documented.

**Status:** COMPLETE — WORK-043 / PR #4 merged.

### D-03 — Asynchronous execution transport

**Goal:** Make execution dispatch durable and restartable.

Scope:

- queue adapter;
- durable dispatch records;
- idempotent consumers;
- retry/dead-letter behavior;
- queue backlog metrics;
- replay tooling;
- execution-to-message correlation.

Acceptance:

- worker crashes are recoverable;
- duplicate delivery cannot duplicate authoritative effects;
- a queued message is never mistaken for execution success.

**Status:** COMPLETE — WORK-044 / PR #6 merged.

### D-04 — Durable orchestration

**Goal:** Add long-lived orchestration for waits, callbacks, approvals, retries and deployment operations.

Scope:

- workflow adapter;
- execution/workflow correlation;
- resume-after-failure behavior;
- human-in-the-loop waits;
- timeout/expiration handling;
- orchestration state compaction;
- provider-limit monitoring.

Acceptance:

- workflow state remains subordinate to Zeck authority;
- waiting executions survive process restarts;
- large artifacts and secret values stay outside workflow state.

**Status:** CURRENT — WORK-045 authorized/in-flight.

### D-05 — Execution worker deployment fabric

**Goal:** Deploy actual model/tool/agent/program execution outside the request lifecycle.

Scope:

- worker service;
- provider adapters in worker runtime;
- container `ComputeEnvironment` implementation;
- execution leases/heartbeats;
- cancellation;
- worker drain/shutdown;
- concurrency controls;
- per-environment quotas;
- optional customer runner registration.

Acceptance:

- no long-running execution depends on an HTTP request staying open;
- worker failure converges to durable execution state;
- untrusted code receives no ambient credentials or unrestricted host access.

### D-06 — Production delivery, observability and release control

**Goal:** Make deployments safe to promote, inspect, roll back and audit.

Scope:

- GitHub-to-provider CI/CD;
- preview → staging → production promotion;
- exact commit/deployment identity;
- migration gating;
- health/smoke gates;
- OpenTelemetry traces/metrics/logs;
- error monitoring;
- alert thresholds;
- deployment rollback;
- cost/quota alerts.

Acceptance:

- every production deployment maps to an exact Git commit;
- failed releases can be rolled back without changing domain state;
- operational alerts exist before resource exhaustion.

### D-07 — Resilience, DR and provider exit

**Goal:** Prove Zeck can survive infrastructure loss and provider substitution.

Scope:

- PostgreSQL recovery drills;
- artifact recovery drills;
- queue/workflow replay;
- regional worker evacuation;
- provider outage simulations;
- R2 → alternate S3 store migration proof;
- PostgreSQL → alternate managed PostgreSQL proof;
- Vercel → alternate web/API host proof;
- documented RTO/RPO by environment.

Acceptance:

- authority can be restored from repository-defined procedures;
- provider replacement changes adapters/configuration rather than domain semantics;
- disaster recovery evidence is repeatable.

### D-08 — Growth and enterprise hardening

**Goal:** Move from lean MVP operations to high-assurance multi-tenant infrastructure.

Scope:

- regional/data-residency deployment;
- private connectivity;
- tenant isolation at runtime;
- stronger compute isolation;
- dedicated customer runners;
- high-availability database topology;
- advanced audit and compliance controls;
- independent provider redundancy.

Gate:

D-08 may only begin after measured production usage, explicit availability/security requirements and an Architect-approved architecture extension.

## Execution ordering

The default dependency chain is:

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

Some phases may be split into parallel Work Orders when their declared surfaces do not conflict. The Architect must derive concurrency from actual repository state; the roadmap does not authorize unsafe parallelism.

## Free-tier operating doctrine

Free tiers are treated as **development accelerators**, not durability or availability guarantees.

The implementation must:

- meter usage;
- alert before quota exhaustion;
- make limits visible;
- avoid automatic uncontrolled paid overage where a provider permits hard caps;
- keep production resources isolated from disposable free-tier resources;
- preserve migration paths before a free tier becomes operationally critical.

The goal is not to make Zeck permanently free. The goal is to postpone fixed infrastructure spend until product usage justifies it while preserving production-grade architecture.

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
2. the control plane and execution plane can be deployed independently;
3. durable authority has tested backup/restore;
4. execution dispatch is restartable and idempotent;
5. artifacts survive compute loss;
6. secrets are provider-managed and never source-controlled;
7. observability can reconstruct an execution end-to-end;
8. production releases are exact-commit attributable and rollbackable;
9. provider limits and spend are actively monitored;
10. at least one replacement implementation has been demonstrated for each critical provider category.

## Change-control rule

This roadmap can be amended only by the Architect through a repository-resident architecture/roadmap change. Workers may not add, remove or reorder deployment phases by implementation convenience.
