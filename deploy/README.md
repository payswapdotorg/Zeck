# Zeck Deployment Foundation (D-01 / WORK-042, D-02 / WORK-043, D-03 / WORK-044, D-04 / WORK-045)

Reproducible, environment-separated infrastructure configuration for Zeck,
per `docs/DEPLOYMENT-ARCHITECTURE.md` (D1.0) and `docs/DEPLOYMENT-ROADMAP.md`
(D-01, D-02). **The repository is the only source of truth**: the manifests under
`deploy/manifests/` define the environment matrix, the provider/concern map,
the resource inventory (with computed, deterministic names), the
secret-reference inventory and the environment-variable contract. Provider
consoles are evidence or operational state — never authority.

D-02 (WORK-043) landed the production runtime path behind the existing ports:
the managed-PostgreSQL database adapter with deterministic startup/migrations
(`src/platform/db/`), the S3-compatible R2 object-store adapter with SigV4
signing and presigned flows (`src/platform/object-store/`), artifact
integrity/retention safety, and the executed backup/restore drill below.

## Layout

```text
deploy/
  manifests/
    environments.json        the four environment classes + promotion ladder
    providers.json           concern → provider, owning port, substitution, degradation
    resources.json           resource inventory per environment + naming constraints
    secret-references.json   environment-scoped zeck-secret:// reference inventory
    variables.json           the non-secret environment variable contract
  lib.ts                     shared tooling plumbing (root resolution, secret scan)
  validate.ts                configuration validation gate
  bootstrap.ts               idempotent local convergence; provider plans
  teardown.ts                classification-guarded disposable teardown
  smoke.ts                   readiness + exact-revision identity attestation
  identity.ts                deployment identity emission
  migrate.ts                 D-02: deterministic managed-PostgreSQL startup/migrations
  backup.ts                  D-02: logical backup of the authoritative state
  restore.ts                 D-02: the executed restore drill (create/migrate/restore/verify)
```

## Environments

| Environment | Class | Teardown | Data policy |
|---|---|---|---|
| `local` | disposable | allowed | synthetic-only |
| `preview` | disposable (per-branch) | allowed | synthetic-only |
| `staging` | persistent | refused | staging-only |
| `production` | persistent | refused | authoritative |

Promotion ladder: `local → ci → preview → staging → production` (ci is a
check phase, not a hosting class). Preview resources carry the sanitized
branch slug (≤24 chars) and are never implicitly promoted.

## Deterministic naming

Resource names are NEVER stored — they are computed by
`src/platform/deployment/naming.ts` from `(environment, kind, preview
branch)` and validated against per-provider constraints (length, charset):

```text
local:      zeck_local (PostgreSQL), zeck-local-artifacts, zeck-local-redis
staging:    zeck-staging, zeck-staging-artifacts, zeck-staging-executions,
            zeck-staging-orchestration, zeck-staging-redis
preview:    zeck-preview-<branch-slug>[-artifacts|-executions|-orchestration|-redis]
production: zeck-production, zeck-production-artifacts, …
```

Two fresh checkouts at the same revision compute byte-identical names.

## Commands

```bash
bun run deploy:validate                                   # configuration gate (no network)
bun run deploy:bootstrap -- --environment local           # converge local resources
bun run deploy:bootstrap -- --environment staging         # emit the staging plan
bun run deploy:bootstrap -- --environment preview --branch work/WORK-042-x
bun run deploy:teardown -- --environment local            # remove disposable local resources
bun run deploy:teardown -- --environment production       # REFUSED (exit 3, always)
bun run deploy:smoke -- --environment local               # readiness + identity (exit = gate)
bun run deploy:smoke -- --environment local --allow-degraded
bun run deploy:identity -- --environment local            # deterministic identity document
# D-02 (WORK-043): the managed database + artifact production path
bun run deploy:migrate -- --environment local             # deterministic startup + migrations
bun run deploy:migrate -- --environment staging           # via the materialized database-url secret
bun run deploy:backup -- --environment local --out /path/backup.json
bun run deploy:restore -- --environment local --from /path/backup.json --drop
# D-03 (WORK-044): the asynchronous execution transport operator surface
bun run deploy:queue -- inspect --environment local       # backlog/failure/dead-letter snapshot (read-only)
bun run deploy:queue -- republish --environment local     # bounded crash/outage recovery (recorded envelopes)
bun run deploy:queue -- replay --environment local --envelope <uuid>   # bounded replay of a dead-lettered lineage
bun run deploy:queue -- consume --environment local --batches 1        # drain deliveries (idempotent, governed)
bun run deploy:queue -- probe --environment preview       # real transport round-trip on the dedicated probe queue
# D-04 (WORK-045): the durable-orchestration operator surface
bun run deploy:workflow -- inspect --environment local    # orchestration snapshot + provider limits (read-only)
bun run deploy:workflow -- scan --environment local       # arm waits for waiting executions (correlation-first)
bun run deploy:workflow -- recover --environment local    # restart/outage recovery + due deadlines (governed)
bun run deploy:workflow -- compact --environment local    # terminate instances of terminal waits (bounded state)
bun run deploy:workflow -- probe --environment preview    # real orchestration round-trip on the dedicated probe workflow
```

## Local environment reproduction (fresh checkout)

1. Requirements: `bun`, a PostgreSQL 16+ server, optionally a Redis-compatible
   service.
2. Set the environment:

   ```bash
   export ZECK_ENVIRONMENT=local
   export ZECK_PG_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres   # admin connection
   export ZECK_LOCAL_DATA_ROOT=~/.local/share/zeck                        # default
   # optional; absent ⇒ the smoke reports the explicit coordination-degraded mode:
   export ZECK_LOCAL_REDIS_URL=redis://127.0.0.1:6379
   ```

3. Converge and attest:

   ```bash
   bun run deploy:bootstrap -- --environment local   # creates zeck_local (idempotent)
   bun run deploy:smoke   -- --environment local [--allow-degraded]
   ```

The smoke fails closed (`exit 1`) when the PostgreSQL authority is
unreachable; it degrades explicitly (with `--allow-degraded`) when only
Redis is absent. CI (`.github/workflows/deployment-validation.yml`) runs
this exact path with PostgreSQL 16 and Redis 7 services and emits the
deployment identity for the checked-out revision.

## Secrets

Infrastructure credentials are **references only** —
`zeck-secret://<environment>/<name>` — held in `ZECK_SECRET_*_REF`
variables. Values live outside source control (operator/CI environment or
an external secret manager) and are resolved immediately before an
authorized adapter call (D1.0 §14). Reference URIs are environment-scoped:
production material is not addressable from any other environment (the
environment contract rejects cross-environment references and plaintext in
reference variables, fail closed). The variable contract classifies
credential-shaped variables (`ZECK_PG_ADMIN_URL`, `ZECK_PG_TEST_URL`,
`ZECK_TOKEN`) as environment-only storage that is never committed.

## Provider environments (preview / staging / production)

D-02 landed the RUNTIME adapters (migrations, probes, artifact path); resource
PROVISIONING (creating the Neon project/branch, the R2 bucket) remains
account-plane work outside the D-02 runtime credentials — `deploy:bootstrap`
emits the deterministic provisioning plan with the exact resource set,
computed names, ownership labels, and the secret-reference preconditions. The
plan is marked `executable: false` until every reference is materialized —
there is no half-provisioned, half-credentialed state.

Operator steps that remain outside the repository today (classified as
**provider-account metadata that cannot be reproduced from source**):

- create/own the provider accounts (Neon, Cloudflare, Upstash, Vercel);
- create the resources with the deterministic names above through each
  provider's console or API;
- materialize the `zeck-secret://<environment>/<name>` references AND their
  values in your secret manager / CI environment (see below).

`ZECK_CLOUDFLARE_ACCOUNT_ID` is provider-account metadata (an account
locator, not a credential) and is declared in `variables.json`.

## The D-02 runtime configuration (managed database + artifact bytes)

Once the provider resources exist, the runtime path is fully
repository-defined (`variables.json`; the smoke/migrate tools enforce it):

```bash
export ZECK_ENVIRONMENT=staging
# reference bindings (non-secret URIs, environment-scoped):
export ZECK_SECRET_DATABASE_URL_REF=zeck-secret://staging/database-url
export ZECK_SECRET_OBJECT_STORE_ACCESS_KEY_ID_REF=zeck-secret://staging/object-store-access-key-id
export ZECK_SECRET_OBJECT_STORE_SECRET_ACCESS_KEY_REF=zeck-secret://staging/object-store-secret-access-key
# materialized secret values (credential-shaped; environment-only, never committed):
export ZECK_DATABASE_URL='postgres://...@ep-xxx.neon.tech/zeck?sslmode=require'
export ZECK_OBJECT_STORE_ACCESS_KEY_ID=...
export ZECK_OBJECT_STORE_SECRET_ACCESS_KEY=...
# ordinary (non-secret) object-store configuration:
export ZECK_OBJECT_STORE_ENDPOINT='https://<account-id>.r2.cloudflarestorage.com'
export ZECK_OBJECT_STORE_BUCKET=zeck-staging-artifacts     # must match the computed name
export ZECK_OBJECT_STORE_REGION=auto                       # R2 region

bun run deploy:migrate -- --environment staging   # deterministic startup + migrations
bun run deploy:smoke -- --environment staging     # REAL provider probes (pg + R2 bucket)
```

The database URL never enters argv, logs or reports (the tools redact
credential shapes; error paths pass through `redactConnectionString`). The
secret values are resolved immediately before the authorized adapter call
(`src/platform/secret-store/adapters/env-secret-store.ts`). A Neon endpoint is
a standard PostgreSQL wire endpoint — the adapter is provider-neutral and
identical for any PostgreSQL 16+ endpoint.

## Backup/restore (the executed drill)

The authoritative state's recovery mechanism (D1.0 §17) is
repository-resident and PORT-BASED — the shipped migrations remain the DDL
authority, the backup artifact carries the authoritative DATA with per-table
sha256 checksums:

```bash
# 1. backup (source must be schema-converged; run deploy:migrate first)
bun run deploy:backup -- --environment local --out /tmp/zeck-backup.json
# 2. the restore drill: fresh disposable target → migrations → data → verify → drop
bun run deploy:restore -- --environment local --from /tmp/zeck-backup.json --drop
```

Restore verification re-reads every table, re-hashes the content and compares
row counts + checksums to the backup manifest; any drift fails closed
(`RestoreVerificationError`) leaving the target at migration-only state.
Sequences (serial + identity) are re-seeded from the restored maxima. The
re-runnable integration drill (with seeded authoritative rows and a
dropped source database) is
`tests/integration/postgres/backup-restore-drill.test.ts`. For a provider
environment, `ZECK_DATABASE_ADMIN_URL` (credential-shaped, environment-only)
supplies the managed admin connection for the disposable recovery target.

## Readiness and the health endpoint

`GET /health` on the control-plane API reports control-plane availability
and dependency readiness as separate facts; the authoritative relational
dependency not ready ⇒ HTTP 503 (fail closed); non-authoritative
dependencies ⇒ HTTP 200 with the explicit degraded mode. Diagnostics are
scrubbed (credential-shaped content never crosses the wire). The platform
model behind it: `src/platform/deployment/readiness.ts`.

## The D-03 runtime configuration (asynchronous execution transport)

The dispatch transport (Cloudflare Queues behind the provider-neutral
`src/platform/queue/port.ts`) is configured exactly like the D-02 paths:
ordinary variables for the endpoint identity, one environment-materialized
secret for the credential, and repository-declared bounded budgets.

```bash
# reference binding (non-secret URI, environment-scoped):
export ZECK_SECRET_QUEUE_API_TOKEN_REF='zeck-secret://<environment>/queue-api-token'

# materialized secret value (credential-shaped; environment-only, never committed):
export ZECK_QUEUE_API_TOKEN='<cloudflare api token with queues read+write>'

# ordinary (non-secret) transport configuration:
export ZECK_CLOUDFLARE_ACCOUNT_ID='<32-hex account id>'
export ZECK_QUEUE_ID='<32-hex queue resource id>'

# the DEDICATED operator-owned probe queue (required by deploy:smoke's
# async-transport probe and deploy:queue probe — never the execution queue):
export ZECK_PROBE_QUEUE_ID='<32-hex dedicated probe queue resource id>'

# bounded budgets (repository defaults: 3 / 3 / 3 / 500ms — all optional):
export ZECK_QUEUE_MAX_PUBLISH_ATTEMPTS=3     # then: backlogged (recoverable, explicit)
export ZECK_QUEUE_MAX_DELIVERY_ATTEMPTS=3    # then: explicit dead letter
export ZECK_QUEUE_MAX_REPLAYS=3              # bounded replay per dispatch lineage
export ZECK_QUEUE_RETRY_BACKOFF_MS=500
```

Pull-consumer prerequisites (account-plane, operator-owned): the queue
exists with the deterministic name from `resources.json` (kind `cf-queue`,
e.g. `zeck-<environment>[-<branch>]-executions`), an HTTP pull consumer is
enabled on it, and the token carries `queues_read` + `queues_write`.
`deploy:smoke` probes the real transport (publish → pull → ack round-trip)
when the materialization is present and reports the honest
`dispatch-backlogged` degraded mode otherwise — a queued message is never
mistaken for execution success.

### The transport probe and the dedicated probe queue

The transport probe (`deploy:smoke`'s async-transport concern and
`deploy:queue -- probe`) NEVER runs against the execution queue. It
executes its publish → pull → ack round trip on a **dedicated
operator-owned probe queue** (`ZECK_PROBE_QUEUE_ID`): a queue reserved
for probe traffic, provisioned exactly like the execution queue (HTTP
pull consumer enabled, token scopes `queues_read` + `queues_write`),
carrying no application state and therefore not part of the
environment's authoritative resource inventory.

The probe acknowledges **exactly the one message it published in that
run** (exact probe-tag match). Anything else it happens to lease — an
execution delivery, another probe's message, foreign noise — is never
acknowledged and never re-queued; the lease expires (the transport's
documented crash-recovery mechanism) and the message returns for its
rightful consumer. Configuration guards enforce the boundary fail
closed: `probe()` without `ZECK_PROBE_QUEUE_ID` refuses, and a probe
queue equal to the execution queue (`ZECK_PROBE_QUEUE_ID ==
ZECK_QUEUE_ID`) is rejected at configuration validation. A probe can
therefore never consume, discard or delay genuine execution deliveries.
(Probe-queue hygiene: leftover probe messages after a crashed probe are
disposable transport noise on a noise-only queue and may be purged by
the operator at will.)

Attesting the execution queue's own pull path is the consumer's job,
not the probe's: `deploy:queue -- consume` drains real deliveries
through the idempotent governed consumer, and the gated live suite
runs its port-flow verification on the probe queue.

The transport model (the authority boundary): every dispatch has a
durable PostgreSQL correlation record (`queue_transport.dispatch_envelopes`)
committed BEFORE the external message is published; the message carries
only a correlation pointer; consumption resolves the authoritative record
from PostgreSQL and re-enters the governed execution path (the executions
module's single write path) with a deterministic idempotency key —
duplicate delivery, consumer crash and ack loss converge to exactly one
authoritative effect. Queue state is transport progress evidence only.

## The D-04 runtime configuration (durable orchestration)

The durable orchestration (Cloudflare Workflows behind the
provider-neutral `src/platform/workflow/port.ts`) is configured exactly
like the D-02/D-03 paths: ordinary variables for the endpoint identity,
one environment-materialized secret for the credential, and
repository-declared bounded budgets.

```bash
# reference binding (non-secret URI, environment-scoped):
export ZECK_SECRET_WORKFLOW_API_TOKEN_REF='zeck-secret://<environment>/workflow-api-token'

# materialized secret value (credential-shaped; environment-only, never committed):
export ZECK_WORKFLOW_API_TOKEN='<cloudflare api token with Workers Scripts write>'

# ordinary (non-secret) orchestration configuration:
export ZECK_CLOUDFLARE_ACCOUNT_ID='<32-hex account id>'
export ZECK_WORKFLOW_NAME='<deployed workflow script name, up to 64 chars>'

# the DEDICATED operator-owned probe workflow (required by deploy:smoke's
# durable-orchestration probe and deploy:workflow probe — never the
# orchestration workflow):
export ZECK_WORKFLOW_PROBE_NAME='<dedicated probe workflow name>'

# bounded budgets (repository defaults: 3 / 3 / 3 / 3 / 500ms — all optional):
export ZECK_WORKFLOW_MAX_START_ATTEMPTS=3    # then: deferred (recoverable, explicit)
export ZECK_WORKFLOW_MAX_SIGNAL_ATTEMPTS=3   # then: delivery stops (compaction terminates)
export ZECK_WORKFLOW_MAX_EFFECT_ATTEMPTS=3   # then: abandoned with the exact reason
export ZECK_WORKFLOW_MAX_REPLACEMENTS=3      # bounded re-arm per wait lineage
export ZECK_WORKFLOW_RETRY_BACKOFF_MS=500

# bounded state (reference-only payloads; bounded notification retention):
export ZECK_WORKFLOW_MAX_PAYLOAD_BYTES=4096
export ZECK_WORKFLOW_MAX_RETAINED_NOTIFICATIONS=32

# default wait deadline (0 = none; bounded [0, 30 days]):
export ZECK_WORKFLOW_WAIT_TIMEOUT_MS=0
```

Provider prerequisites (account-plane, operator-owned): the workflow
Worker script is deployed under the deterministic name from
`resources.json` (kind `cf-workflow`, e.g.
`zeck-<environment>[-<branch>]-orchestration`), and the token carries
`Workers Scripts Write`. `deploy:smoke` probes the real orchestration
(create → observe → terminate round-trip) when the materialization is
present and reports the honest `orchestration-paused` degraded mode
otherwise — the authoritative execution, budget, policy and ledger
state in PostgreSQL is untouched either way.

### The workflow-code contract (account-plane)

The deployed workflow script is operator-plane infrastructure: Zeck's
machinery drives it purely through the port contract (instance start
with a reference-only pointer payload; observe; event signals
`zeck.callback` / `zeck.approval` / `zeck.deadline` / `zeck.supersede`;
termination). The contract the workflow code must honor: **hold the
wait** (`sleep` bounded by the deadline), **await the events**, and
**never act on execution state** — instance completion is never
execution success, and Zeck never relies on the instance for
continuation (the PostgreSQL wait record is the authority). Orphaned
instances from a crash between provider-accept and the armed mark are
bounded waste (provider retention is 30 days documented); they are
traceable by the deterministic instance hint `zeck-w-<digest>-a<attempt>`
and disposable at operator discretion — instances are non-authoritative
transport state.

### The orchestration probe and the dedicated probe workflow

The orchestration probe (`deploy:smoke`'s durable-orchestration concern
and `deploy:workflow -- probe`) NEVER runs against the orchestration
workflow. It executes its create → observe → terminate round trip on a
**dedicated operator-owned probe workflow** (`ZECK_WORKFLOW_PROBE_NAME`):
a workflow reserved for probe traffic, carrying no application state and
not part of the environment's authoritative resource inventory.

The probe terminates **exactly the one instance it created in that run**
(exact instance identity). It never signals, pauses, restarts or
terminates any other instance — instances are addressed by id, and the
probe only ever addresses ids it created itself. Configuration guards
enforce the boundary fail closed: `probe()` without
`ZECK_WORKFLOW_PROBE_NAME` refuses, and a probe workflow equal to the
orchestration workflow (`ZECK_WORKFLOW_PROBE_NAME == ZECK_WORKFLOW_NAME`)
is rejected at configuration validation. A probe can therefore never
consume, discard or delay genuine orchestration.

### The orchestration model (the authority boundary)

Every orchestration wait has a durable PostgreSQL correlation record
(`workflow_orchestration.waits`) committed BEFORE any provider workflow
instance is created or relied upon; the instance receives only a
reference-only correlation pointer (ids + digests; large artifact bytes
and secrets never enter workflow state). Resolution notifications
(callbacks, human approvals) are deduplicated by their deterministic key
with exactly ONE accepted notification per wait (first resolution wins,
physically enforced); the governed effect re-enters the executions
module's single write path with a deterministic idempotency key —
duplicate notifications, crash-after-mutation, restart recovery and
provider retries all converge to exactly one authoritative effect.
Deadlines elapse through the governed expiration path on the
PostgreSQL deadline (never the provider's clock). Waiting executions
survive process and provider-worker restarts: recovery scans
(`deploy:workflow -- recover`) re-drive deferred instance starts,
re-apply pending governed effects and re-deliver undelivered provider
signals, all from PostgreSQL authority. Terminal waits have their
provider instances terminated by the compaction run
(`deploy:workflow -- compact`); refused-notification evidence folds
into a durable counter beyond the retention bound (bounded, inspectable
state). Workflow state is orchestration progress evidence only — it
never establishes execution success.

## The D-05 runtime configuration (execution worker fabric)

The execution worker (the `deploy:worker` process — the independently
runnable execution-plane service) composes the D-02 database, the D-03
queue transport, the executions authority, the sandbox admission chain
and the container runner. Ordinary bounded variables for the fabric
policy; one environment-materialized secret for the runner credential.

```bash
# the database + queue (the D-02/D-03 configuration, unchanged):
export ZECK_DATABASE_URL='<connection string of the environment database>'
export ZECK_QUEUE_API_TOKEN='<cloudflare api token with queues read+write>'
export ZECK_QUEUE_ID='<32-hex queue id>'

# the container runner (the execution-plane host; OPTIONAL — absent
# means the container substrate reports unavailable and container
# sandbox dispatch fails closed; the process substrate still executes):
export ZECK_SECRET_CONTAINER_RUNNER_TOKEN_REF='zeck-secret://<environment>/container-runner-token'
export ZECK_CONTAINER_RUNNER_API_TOKEN='<runner bearer token>'
export ZECK_CONTAINER_RUNNER_URL='https://runner.internal.example'

# bounded fabric policy (repository defaults — all optional):
export ZECK_WORKER_LEASE_TTL_MS=60000         # per-claim lease TTL
export ZECK_WORKER_HEARTBEAT_INTERVAL_MS=5000 # registration/claim/lease cadence
export ZECK_WORKER_DEFAULT_ENV_QUOTA=8        # concurrent live claims per compute environment
export ZECK_WORKER_MAX_CLAIM_ATTEMPTS=3       # bounded re-selection per execution
export ZECK_WORKER_MAX_IN_FLIGHT=4            # per-worker concurrent work bound
export ZECK_WORKER_MAX_DRAIN_MS=120000        # bounded graceful shutdown
export ZECK_WORKER_CLAIM_VISIBILITY_MS=30000  # the dispatch pull visibility window
export ZECK_WORKER_BATCH_SIZE=8               # deliveries per poll
export ZECK_WORKER_STALE_AFTER_MS=90000       # heartbeat age -> offline/abandoned
export ZECK_WORKER_MAX_OUTCOME_BYTES=2048     # bounded claim outcome detail
export ZECK_WORKER_CLAIM_RETENTION_MS=604800000 # terminal-claim retention (7 days)

# run the worker (one process per execution-plane host; the identity is
# fresh per process — a restart registers a NEW worker identity and the
# recovery scan re-drives its predecessor's abandoned claims):
bun run deploy:worker -- run --environment <env> --application-id <uuid>
```

### The container-runner protocol (the execution-plane host contract)

The concrete container runtime behind the v1.0 container
`ComputeEnvironment` is a runner daemon implementing the documented
REST protocol (provider-neutral, no vendor SDK; the Zeck side is
`src/platform/compute/container-runtime.ts`):

```text
POST {base}/v1/runs                      (auth: Bearer <token>)
  body: {"runId": "<derived run id>", "config": <ContainerConfiguration>, "timeoutMs": <int>}
  -> 202 {"runId": "...", "accepted": true}          (accepted for execution)
  -> 400 (malformed configuration — permanent) / 401 / 403 (auth — permanent)
  -> 409 (the deterministic run id is already held — idempotent re-submission)

GET {base}/v1/runs/{runId}
  -> 200 {"status": "running"}
  -> 200 {"status": "succeeded"|"failed", "exitCode": <int>, "timedOut": <bool>,
          "stdout": "<bounded>", "stderr": "<bounded>", "durationMs": <int>}
  -> 404 (the runner no longer knows the run — the honest unknown-outcome
          class; fail closed, never re-executed)
```

The runner receives ONLY already-validated `ContainerConfiguration`
objects (the sandbox module's escape validator rejected privileged /
host-mount / ambient-network / secret-shaped configurations BEFORE the
wire — a configuration the validator would reject can never reach the
runner). The runner enforces the admitted wall-clock bound and bounds
its output payloads; Zeck truncates to its own byte bound and digests
the bounded payload (deterministic evidence). `probeContainerRunner`
(the `deploy:smoke` execution-compute concern) is an authenticated
synthetic run-id GET: the expected 404 proves wire + credential without
executing anything.

**The run-id derivation (identity binding).** The external `runId` is
derived by the Zeck client from the EXECUTION-SCOPED RUN IDENTITY
together with the configuration and the admitted timeout:

```text
runId = "run-" + sha256([runIdentity, config, timeoutMs])[0:32]
runIdentity = "zeck-run:<applicationId>:<executionId>:<sandboxId>"
```

The configuration alone does not identify the work: two DIFFERENT
executions doing identical work carry different run identities and
therefore different external run ids — they can never collapse into one
runner run (the configuration-only derivation was the pre-revision
defect). A replay of the SAME logical run (same execution, same sandbox
row, same admitted configuration) re-derives the SAME run id — the
idempotent 409 re-submission then converges on the held run. A runner
implementation MUST treat the submitted `runId` as the idempotency key
of the run (409 on re-submission of a held id) and never execute two
logically distinct runs under one id.

### The worker model (the authority boundary)

A worker is an executor, never an execution authority. The dispatch
delivery is the wake-up: after the atomic claim admission (per-worker
concurrency, per-environment quota, bounded re-selection attempts, ONE
live claim per execution — all physically enforced in the
`compute_plane` schema) and the durable execution lease acquisition
(the executions module's single lease system, monotonic epochs), the
delivery is settled and the durable claim + lease carry the work. The
completion commits through the frozen transition service under the
lease fence: success rides `verify` + `pass` with the MANDATORY
verification binding (a runtime/provider success signal alone never
completes an execution); failure rides the governed `fail`. A stale
worker (expired / superseded / foreign / released lease) is fenced at
the persistence boundary — its late completion NEVER becomes
authoritative, and the recovery scan re-drives the execution (the
deterministic sandbox identity replays the prior terminal outcome; no
duplicate governed effect). Cancellation and termination flow through
the existing governed interruption/termination paths; the worker only
observes and converges. Drain stops new acquisition, bounds in-flight
waiting, and abandons stragglers as recoverable claims — never lost,
never duplicated.

### The D-05 worker composition note (policy seeding)

The policies module's durable store does not exist yet (future scope
beyond D-05); the worker seeds the repository baseline policy set (the
platform-scope permissive baseline the governed admission chain
consumes) at boot through the REAL policy authority behind the sandbox
admission seam — policy admission is REAL and fail-closed (a restricted
set denies), never bypassed. When the durable policy store lands, the
seed is replaced by the durable read; nothing else changes.

### The operator surface

`bun run deploy:worker --` subcommands: `run` (the worker process;
SIGTERM triggers the bounded drain), `run-once` (one bounded
consume + recover iteration — the exact-revision verification path),
`inspect` (the read-only worker-plane snapshot: registrations, live
claims, quotas, recoverable candidates), `sweep` (stale workers
offline + stale claims abandoned, no re-drive), `recover` (the full
recovery scan), `compact` (bounded terminal-claim retention), `quota`
(per-compute-environment quota), `runner register|activate|suspend|
revoke|list` (the governed customer-runner registration lifecycle —
attributable, revocable, NON-AUTHORITATIVE executor metadata; a
customer-runner worker binds the registration and may only claim its
own application's executions).
