# Zeck Deployment Foundation (D-01 / WORK-042)

Reproducible, environment-separated infrastructure configuration for Zeck,
per `docs/DEPLOYMENT-ARCHITECTURE.md` (D1.0) and `docs/DEPLOYMENT-ROADMAP.md`
(D-01). **The repository is the only source of truth**: the manifests under
`deploy/manifests/` define the environment matrix, the provider/concern map,
the resource inventory (with computed, deterministic names), the
secret-reference inventory and the environment-variable contract. Provider
consoles are evidence or operational state — never authority.

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

Provider mutation adapters arrive with the D-02+ roadmap phases
(`providers.json` marks each owning port `established` or `planned`). Until
then, `deploy:bootstrap -- --environment <env>` emits the deterministic
provisioning plan: the exact resource set with computed names, ownership
labels, and the secret-reference preconditions. The plan is marked
`executable: false` until every reference is materialized — there is no
half-provisioned, half-credentialed state.

Operator steps that remain outside the repository today (classified as
**provider-account metadata that cannot be reproduced from source**):

- create/own the provider accounts (Neon, Cloudflare, Upstash, Vercel);
- create the resources with the deterministic names above through each
  provider's console or API until the D-02+ adapters automate them;
- materialize the `zeck-secret://<environment>/<name>` references in your
  secret manager / CI environment.

`ZECK_CLOUDFLARE_ACCOUNT_ID` is provider-account metadata (an account
locator, not a credential) and is declared in `variables.json`.

## Readiness and the health endpoint

`GET /health` on the control-plane API reports control-plane availability
and dependency readiness as separate facts; the authoritative relational
dependency not ready ⇒ HTTP 503 (fail closed); non-authoritative
dependencies ⇒ HTTP 200 with the explicit degraded mode. Diagnostics are
scrubbed (credential-shaped content never crosses the wire). The platform
model behind it: `src/platform/deployment/readiness.ts`.
