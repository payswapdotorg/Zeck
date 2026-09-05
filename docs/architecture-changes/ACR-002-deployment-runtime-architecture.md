# ACR-002 — Deployment & Runtime Architecture

**Status:** Approved
**Architecture:** v1.0 + Deployment Architecture D1.0
**Date:** 2026-09-05
**Authority:** Architect

## Decision

Establish a repository-resident **Deployment & Runtime Architecture D1.0** as the authoritative operational architecture for deploying Zeck. D1.0 is subordinate to the frozen `spec/architecture.md` v1.0 and `spec/architecture-lock.md`; it does not rewrite or weaken any frozen invariant.

D1.0 defines a provider-neutral deployment plane with a concrete low-cost reference implementation based on:

- Vercel for experience delivery and preview deployments;
- Neon PostgreSQL for authoritative relational state;
- Cloudflare R2 for durable object bytes;
- Cloudflare Queues for asynchronous dispatch transport;
- Cloudflare Workflows for durable orchestration where appropriate;
- Upstash Redis for non-authoritative ephemeral coordination;
- Clerk for platform identity as an external identity provider adapter;
- Resend for transactional email as an external provider adapter;
- GitHub Actions and provider-native Git integrations for CI/CD;
- OpenTelemetry-compatible telemetry and Sentry or equivalent for operational diagnostics;
- container/microVM/VM/customer-runner implementations behind the existing `ComputeEnvironment` port for execution workloads.

## Authority model

Zeck remains the authority. Infrastructure services are implementations of Zeck ports or deployment mechanisms and are never allowed to become an alternative source of truth.

1. PostgreSQL is authoritative for durable Zeck relational state, including execution lifecycle, budgets, reservations, ledger state, ownership, policy state and deployment records.
2. Object storage is authoritative only for durable artifact bytes; PostgreSQL remains authoritative for artifact metadata, ownership, hashes and provenance references.
3. Queues and workflow engines are transport/orchestration mechanisms. They cannot independently define execution truth.
4. Redis is ephemeral coordination/cache only and cannot contain irreplaceable authority.
5. Provider consoles are operational control surfaces, not Zeck domain state.
6. A deployment provider may fail or be replaced without changing the Zeck domain model.

## Commercial-use rule

The Vercel Hobby plan is a development/non-commercial facility only. Commercial production must use a commercially permitted plan or a different deployment implementation. The reference production architecture therefore treats Vercel Pro or an equivalent commercially permitted host as the minimum Vercel production tier; free-tier claims must never be interpreted as commercial entitlements.

## Deployment tiers

### Tier 0 — Local / CI

Local development uses Bun, PostgreSQL and Redis-compatible services as already defined by `IMPLEMENTATION.md`, with containerized integration tests.

### Tier 1 — Free development / preview

Use Vercel Hobby for personal/non-commercial previews; Neon Free; Cloudflare R2 Free; Cloudflare Queues Free; Cloudflare Workflows Free; Upstash Redis Free; and provider free tiers where their terms permit the intended development use. This tier must not hold production customer data or commercial production traffic.

### Tier 2 — Lean commercial production

Use Vercel Pro or an equivalent commercially permitted frontend/API deployment; Neon Launch; Cloudflare R2; Cloudflare Queues/Workers/Workflows; Upstash pay-as-you-go or fixed Redis as required; and paid identity/email tiers only when their limits are reached. Production data and secrets are never placed in development-tier resources.

### Tier 3 — Growth

Split API/control-plane compute from execution workers, add regional workers, stronger isolation, independent observability, backup/restore automation, and additional providers without changing domain interfaces.

### Tier 4 — Enterprise / high assurance

Introduce provider diversity, private networking where required, stronger runtime isolation, regional/data-residency placement, tenant-specific execution boundaries, formal disaster recovery objectives, stronger compliance controls and customer-controlled runners.

## Reference topology

```text
                       INTERNET
                           |
                    +------+------+
                    | Vercel / CDN |
                    | Experience   |
                    +------+-------+
                           |
                     HTTPS API
                           |
                 +---------v----------+
                 | Zeck API / Control  |
                 | Fastify + Bun       |
                 +----+----+----+------+ 
                      |    |    |
            +---------+    |    +----------------+
            |              |                     |
      +-----v-----+   +----v-----+       +-------v-------+
      |   Neon    |   | Upstash  |       | Cloudflare    |
      | PostgreSQL|   | Redis    |       | Queue/Workers |
      | AUTHORITY |   | ephemeral|       | transport     |
      +-----+-----+   +----------+       +-------+-------+
            |                                  |
            |                           +------v-------+
            |                           | CF Workflows |
            |                           | orchestration|
            |                           +------+-------+
            |                                  |
            +-------------------------+--------+
                                      |
                              +-------v--------+
                              | Execution      |
                              | workers/runners |
                              +-------+--------+
                                      |
                         +------------+------------+
                         |                         |
                  +------v------+          +-------v-------+
                  | provider    |          | sandbox /     |
                  | adapters    |          | customer      |
                  | models/tools|          | runners       |
                  +-------------+          +---------------+

                              +----------------+
                              | Cloudflare R2  |
                              | artifact bytes |
                              +----------------+
```

## Runtime separation

The control plane and execution plane are deliberately separable.

**Control plane:** authentication, tenant/application scope, policies, budgets, planning, execution identity, state transitions, event persistence, artifact metadata, deployment records and API transport.

**Execution plane:** model calls, tool calls, agents, programs, containers, microVMs, VMs and customer runners.

A control-plane request must not depend on an execution worker remaining alive. Long-lived or waiting executions are represented durably and resumed from authoritative state.

## Port requirements

The following infrastructure contracts are mandatory:

- `Database` / PostgreSQL adapter
- `ObjectStore` / S3-compatible adapter
- `CacheCoordinator` / Redis-compatible adapter
- `DispatchQueue` / queue adapter
- `DurableWorkflow` / workflow-orchestration adapter
- `SecretStore` / secret manager adapter
- `IdentityProvider` / external identity adapter
- `EmailProvider` / transactional email adapter
- `ComputeEnvironment` / process-container-microVM-VM-customer-runner adapters
- `TelemetrySink` / OpenTelemetry-compatible adapter

Provider SDKs may only appear inside their owning adapter packages.

## Data placement rules

### PostgreSQL

Store domain records, execution state, durable event envelopes, idempotency records, policies, budgets, reservations, ledger entries, deployment definitions, worker registrations and artifact metadata.

### R2

Store large immutable artifacts, execution outputs, evidence packages, files and other byte payloads. Persist content hashes, media metadata, retention policy and ownership in PostgreSQL.

### Redis

Store only values that can be recomputed or expired without losing authority. Examples include rate-limit counters, short-lived locks, coordination hints and hot cache entries.

### Queue

Messages carry durable identifiers and enough information to re-drive work, but not irreplaceable domain truth. Consumers must be idempotent and converge against PostgreSQL authority.

### Workflow engine

Workflow state is orchestration state. It must reference Zeck execution IDs and authoritative records rather than becoming the source of execution status.

## Secrets

Infrastructure credentials are provisioned through provider secret/configuration stores. Application code receives only the minimum secret material necessary at the point of authorized use. Secret values must not be copied into database domain fields, logs, artifacts, queues or model context.

The worker/agent provisioning mechanism may use externally connected credentials supplied by the operator; the repository must contain only secret names/references and reproducible configuration, never credential values.

## Failure rules

- Neon unavailable: fail closed for operations requiring authoritative state; no shadow database is promoted automatically without an explicit recovery authority.
- R2 unavailable: artifact-producing operations may fail or retry; existing metadata remains authoritative.
- Redis unavailable: disable cache/coordination-dependent optimizations and continue where the operation remains safe; never promote Redis into authority.
- Queue unavailable: durable admission may remain visible in PostgreSQL as queued/retryable, but dispatch must not be falsely reported as completed.
- Workflow engine unavailable: execution state remains in PostgreSQL; a recovery/re-drive mechanism resumes orchestration.
- Vercel unavailable: API/control-plane traffic must have a separately deployable implementation path before Tier 3; the domain model must remain portable.

## Cost governance

Every deployment must expose usage meters and hard operational budgets for infrastructure. Production environments must have alerts before provider limits are exhausted. A free-tier resource reaching its limit must degrade predictably rather than silently converting into uncontrolled spend.

Provider pricing and free-tier limits are external facts and must be re-verified before each material deployment decision; this document records the reference architecture, not a promise that vendor quotas will remain unchanged.

## Exit criteria for D1.0

D1.0 is considered implemented only when the repository contains reproducible configuration, environment contracts, deployment manifests, secret/reference wiring, health checks, migrations, backup/restore procedures, provider failure tests and exact deployment evidence for the selected reference environment.

No implementation worker may infer deployment behavior from chat history. The repository artifacts under `docs/`, `spec/`, deployment configuration and Work Orders are the sole source of truth.
