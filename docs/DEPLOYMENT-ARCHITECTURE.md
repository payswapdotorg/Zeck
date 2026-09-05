# Zeck — Deployment & Runtime Architecture D1.0

**Status:** AUTHORITATIVE / APPROVED
**Approved:** 2026-09-05
**Parent architecture:** `spec/architecture.md` v1.0 (FROZEN)
**Architecture change record:** `docs/architecture-changes/ACR-002-deployment-runtime-architecture.md`

## 1. Authority

This document is the authoritative deployment and runtime architecture for Zeck. It is subordinate to and must remain compatible with the frozen v1.0 architecture and lock.

The repository is the only source of truth for Zeck deployment design. Provider dashboards, credentials, worker chat, tickets, temporary notes and infrastructure state are evidence or operational state only; they cannot redefine this architecture.

## 2. Core principle

**Zeck owns authority; providers supply infrastructure.**

The application domain owns durable truth. Infrastructure providers implement ports and operational concerns. Provider replacement must not require changing Zeck's domain model.

## 3. Reference provider map

| Concern | Reference | Authority role |
|---|---|---|
| Web experience / previews | Vercel | delivery only |
| Relational database | Neon PostgreSQL | authoritative |
| Large object storage | Cloudflare R2 | bytes only; metadata in Postgres |
| Asynchronous transport | Cloudflare Queues | non-authoritative |
| Durable orchestration | Cloudflare Workflows | non-authoritative orchestration |
| Ephemeral coordination | Upstash Redis | non-authoritative |
| Identity | Clerk | external IdP; Zeck remains domain authority |
| Email | Resend | external delivery provider |
| CI/CD | GitHub Actions + provider Git integrations | deployment automation |
| Telemetry | OpenTelemetry + compatible sink | diagnostics |
| Execution compute | Zeck ComputeEnvironment adapters | execution plane |

Current external plan facts are recorded in `ACR-002`. They must be re-verified before a deployment purchase or migration because vendor limits and terms can change.

## 4. Environments

Zeck has four logical environment classes.

### Local

Bun + PostgreSQL + Redis-compatible services, with containerized integration dependencies. Local infrastructure is disposable.

### Preview

Every implementation branch may receive an isolated preview. Preview data is synthetic or explicitly disposable. Preview deployments are never promoted implicitly.

### Staging

Production-like topology with isolated credentials, dedicated database branch/project and controlled provider resources. Staging exists to prove production deployment behavior before promotion.

### Production

Production data and credentials. Production requires commercial-use-compatible provider plans and explicit monitoring, backup and rollback procedures.

## 5. Deployment topology

```text
                           USERS / CLIENTS
                                  |
                         +--------v--------+
                         | Vercel / CDN    |
                         | Experience      |
                         +--------+--------+
                                  |
                              HTTPS API
                                  |
                    +-------------v--------------+
                    | Zeck Control Plane         |
                    | Fastify / Bun               |
                    +---+---------+---------+----+
                        |         |         |
              +---------+         |         +-----------------+
              |                   |                           |
       +------v------+      +-----v------+             +------v------+
       | Neon        |      | Upstash    |             | Cloudflare  |
       | PostgreSQL  |      | Redis      |             | Queues      |
       | AUTHORITY   |      | coordination|            | transport   |
       +------+------+      +------------+             +------+------+ 
              |                                             |
              |                                      +------v------+
              |                                      | Workflows   |
              |                                      | orchestration|
              |                                      +------+------+
              |                                             |
              +-------------------+-------------------------+
                                  |
                          +-------v--------+
                          | Execution Plane|
                          | workers/runners |
                          +---+---------+--+
                              |         |
                    +---------+         +----------+
                    |                            |
             +------v------+             +-------v-------+
             | provider    |             | ComputeEnvironment |
             | adapters    |             | process/container/ |
             | models/tools|             | microVM/VM/runner  |
             +-------------+             +-------------------+

                           +----------------+
                           | Cloudflare R2   |
                           | artifact bytes  |
                           +----------------+
```

## 6. Control plane versus execution plane

The control plane admits and governs work; the execution plane performs work.

The control plane contains API transport, identity resolution, policies, budgets, planning, execution identity and lifecycle, durable event persistence, artifact metadata and deployment records.

The execution plane contains model calls, tool calls, agents, programs, containers, microVMs, VMs and customer runners.

No execution worker owns execution state. A crashed, restarted or migrated worker resumes against durable Zeck state.

## 7. Database architecture

Neon PostgreSQL is the reference relational implementation. Zeck persists all authority-bearing state in PostgreSQL, including:

- applications and environments;
- connections and secret references;
- policies and budgets;
- reservations and append-only ledger entries;
- execution identity and lifecycle;
- execution events;
- plans and step state;
- deployment definitions and lifecycle;
- artifact metadata and provenance;
- webhook state and audit records.

Use Neon branching for disposable development/staging database variants where practical. A branch is an environment mechanism, not a separate domain authority.

Connection pooling and transaction semantics must preserve the existing PostgreSQL authority and idempotency guarantees.

## 8. Object storage architecture

Cloudflare R2 is the reference S3-compatible `ObjectStore` implementation.

PostgreSQL stores:

```text
artifact_id
owner/application/environment
content hash
media type
size
retention
provenance
storage key
status
```

R2 stores the bytes. Objects are immutable by content identity unless the `ObjectStore` contract explicitly authorizes replacement semantics.

Large request/response bodies must not be copied unnecessarily through PostgreSQL or Redis.

## 9. Queue architecture

Cloudflare Queues is the reference asynchronous transport.

Messages must be:

- small enough for the provider's message limits;
- idempotently processable;
- keyed by durable Zeck identifiers;
- safe to replay;
- free of irreplaceable authority.

Typical flow:

```text
POST /executions
    -> PostgreSQL admission + execution creation
    -> enqueue dispatch command
    -> worker consumes
    -> worker performs governed operation
    -> worker writes observations/result to PostgreSQL/R2
    -> execution authority advances state
```

A queue message is not proof that work completed.

## 10. Durable orchestration

Cloudflare Workflows is the reference implementation for long-lived orchestration where its limits and execution model fit the workflow.

Workflow state may contain orchestration checkpoints and durable identifiers, but Zeck PostgreSQL remains authoritative for execution status, budget state, policy state and ledger state.

Workflows are particularly appropriate for:

- waiting for external callbacks;
- human-in-the-loop pauses;
- retry/backoff orchestration;
- multi-step deployment operations;
- long-lived automation around executions.

Do not place large artifacts or sensitive secret material in workflow state.

## 11. Redis architecture

Upstash Redis is the reference Redis implementation. It is restricted to recomputable, bounded or expiring coordination data:

- rate limits;
- short-lived locks;
- deduplication hints;
- ephemeral session coordination;
- cache entries.

Redis outages must not corrupt or redefine durable application authority.

## 12. API hosting

The reference low-cost deployment may run the Fastify API on Vercel's Bun/Node-compatible server runtime where the workload fits its function semantics. Vercel documentation supports Bun and Fastify deployment patterns.

However, API hosting is an implementation choice, not a frozen domain requirement. The API must remain deployable as an independently runnable service so it can move to a dedicated container/VM runtime when continuous processes, custom networking, workload duration, data residency or cost justify it.

Long-lived execution must never depend on an HTTP request remaining open.

## 13. Vercel policy

Vercel Hobby is permitted for personal/non-commercial development and preview use only. It is not the commercial production foundation.

Commercial production uses a commercially permitted plan such as Vercel Pro, or another hosting adapter implementing the same API deployment contract.

Vercel is therefore a preferred experience/deployment provider, not an architectural dependency.

## 14. Identity and secrets

Clerk is the reference external identity provider. Zeck translates provider identity into its own Application/Environment/authorization model.

Secret values are never stored in ordinary database columns, logs, artifacts, workflow state, queue payloads or model/tool context. Only secret references are persisted in Zeck domain objects. Secret material is resolved immediately before an authorized adapter call.

Provider credentials for infrastructure are provisioned outside source control. Repository configuration contains variable names, resource identifiers and non-secret policy—not credential values.

## 15. CI/CD

The deployment pipeline is:

```text
Git push
  -> GitHub checks
  -> repository governance check
  -> typecheck/lint/tests
  -> build
  -> preview deployment
  -> environment verification
  -> architect-approved promotion
  -> production deployment
  -> smoke / health verification
  -> post-deploy evidence
```

Production deployment must be attributable to an exact Git commit. Rollback must be able to name the exact prior deployment/commit.

Infrastructure-as-code or deterministic provider configuration must be versioned in the repository. Console-only configuration is not authoritative.

## 16. Observability

Every request, execution, worker action and infrastructure adapter call must carry correlation identifiers sufficient to reconstruct:

```text
request
  -> application/environment
  -> execution
  -> plan/step
  -> queue/workflow operation
  -> provider call
  -> artifact/evidence
```

Use OpenTelemetry-compatible traces/metrics/logs where possible. Provider-specific observability remains supplemental.

Operational alerts must cover at least:

- database connectivity and latency;
- queue backlog/failure;
- workflow failure;
- worker error rate;
- execution stuck age;
- artifact storage growth;
- provider error rate;
- infrastructure quota consumption;
- spend/billing anomalies.

## 17. Backups and disaster recovery

PostgreSQL backup/restore is the primary recovery mechanism for authority-bearing state. R2 objects require independent retention/versioning/recovery procedures appropriate to the artifact policy.

Recovery objectives are explicitly documented per environment before production launch. A provider outage does not justify silently promoting a secondary datastore to authority.

## 18. Multi-region evolution

Tier 2 remains single-primary for simplicity. Tier 3 may add regional workers and replicated read paths. Writes requiring authority continue through the chosen authoritative PostgreSQL topology.

Tier 4 may introduce data-residency partitions or tenant-specific execution regions, but these require explicit architecture decisions; they must not emerge from ad-hoc provider configuration.

## 19. Provider substitution matrix

Every provider integration must have an owning port and a documented replacement target.

```text
Vercel       -> alternate web/API host
Neon         -> managed PostgreSQL provider
R2           -> any S3-compatible object store
Queues       -> managed queue / broker
Workflows    -> durable workflow engine
Upstash      -> managed Redis-compatible service
Clerk        -> OAuth/OIDC-capable identity provider
Resend       -> transactional email provider
```

Tests must target provider-neutral contracts as well as selected provider adapters.

## 20. Cost model and kill switches

Free-tier usage is optimized deliberately, but free tiers are not a reliability contract.

Each environment must define:

- maximum monthly spend;
- warning thresholds;
- provider quota thresholds;
- emergency disable switches;
- retention limits;
- cleanup policies.

Runaway autonomous execution must be stoppable through Zeck policy and budget controls before provider billing becomes the limiting safety mechanism.

## 21. Deployment security boundary

The deployment architecture must preserve all frozen security invariants, especially:

- policy before dispatch;
- capability before provider;
- secret mediation;
- explicit network access;
- isolation through `ComputeEnvironment`;
- no ambient host credentials;
- durable idempotent execution identity;
- external effects through owned ports;
- evidence-backed verification.

Provider convenience features must never bypass those controls.

## 22. Non-goals

D1.0 does not define:

- a new customer-domain workflow engine;
- a new execution state machine;
- a second policy engine;
- a second ledger;
- provider-specific domain semantics;
- a requirement for any single vendor;
- automatic multi-cloud failover without authority design.

## 23. Change control

Any material change to this document requires an architecture change record or equivalent Architect-approved repository artifact. Changes to the frozen v1.0 architecture additionally require the existing architecture-versioning protocol.

Workers may implement only the current approved Work Order. They may not reinterpret this document based on provider console behavior or conversational instructions.
