# Zeck Deployment Foundation (D-01 / WORK-042, D-02 / WORK-043, D-03 / WORK-044)

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
bun run deploy:queue -- probe --environment preview       # real transport round-trip (publish → pull → ack)
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

The transport model (the authority boundary): every dispatch has a
durable PostgreSQL correlation record (`queue_transport.dispatch_envelopes`)
committed BEFORE the external message is published; the message carries
only a correlation pointer; consumption resolves the authoritative record
from PostgreSQL and re-enters the governed execution path (the executions
module's single write path) with a deterministic idempotency key —
duplicate delivery, consumer crash and ack loss converge to exactly one
authoritative effect. Queue state is transport progress evidence only.
