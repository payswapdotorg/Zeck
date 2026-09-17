# Zeck Self-Hosting — the deployment handoff for developers

**Audience:** a developer who wants to run Zeck themselves — to reproduce
an execution against their own deployment, to explore the platform
privately, or to hand a working stack to their team. This page PROJECTS
the repository's deployment foundation by link: the authority for every
fact below lives in [`deploy/`](../../deploy/README.md), and this page
never duplicates a manifest, a command catalog or a limit table that
could drift. When this page and `deploy/` disagree, `deploy/` wins.

The console entry point: every execution's
**reproducibility bundle** (`/console/executions/<id>/export`) links here
for the "run it yourself" half of reproduction — the bundle carries the
facts, the recipe and the digests; this page carries the deployment path.

## What "running Zeck yourself" means

Zeck's authority chain is repository-first: the manifests under
`deploy/manifests/` define the environment matrix, the provider/concern
map, the resource inventory, the secret references and the variable
contract — provider consoles are evidence or operational state, never
authority. A self-hosted Zeck is therefore **a checkout of this
repository + a PostgreSQL authority + the configured provider seams**,
converged by the repository's own tooling. You do not assemble it by
hand in a provider console.

The three layers, and who owns each:

| Layer | What it is | Owner |
|---|---|---|
| The repository configuration | `deploy/manifests/**` + the `deploy:*` commands | everyone (it is the checkout) |
| The local environment | local PostgreSQL 16+, local object-store root, loopback-only control plane | **the developer** — fully reproducible, no cloud accounts |
| The provider topology | Neon, Cloudflare R2/Queues/Workflows, Upstash, Vercel | **the operator** — accounts, secrets, quotas, promotion |

## The developer path (no cloud accounts required)

This is the complete local verification sequence from
[`deploy/README.md`](../../deploy/README.md) and the operator recipe's
"local verification" section
([`deploy/PUBLIC-DEPLOYMENT.md`](../../deploy/PUBLIC-DEPLOYMENT.md) §3.1):

```bash
git clone https://github.com/payswapdotorg/Zeck.git && cd Zeck
bun install
bun run deploy:validate                 # the configuration gate (no network)
bun run deploy:api -- --environment local   # boots the bootstrap host (127.0.0.1:8787)
# in another shell:
curl -s http://127.0.0.1:8787/identity | jq '.identity.gitRevision'   # == git rev-parse HEAD
bun run deploy:public-smoke -- --environment local [--allow-degraded]
```

What this proves, honestly:

- `deploy:validate` checks the manifest set fail-closed (14 rule
  families) — your checkout's configuration is coherent before anything
  boots.
- `deploy:api` boots the bootstrap public API plane serving
  `GET /health` (honest dependency readiness, fail-closed authority)
  and `GET /identity` (the exact-revision attestation: git revision +
  manifest digest + provider topology). This identity surface is the
  revision authority the reproducibility bundle names as its boundary —
  run it yourself and the boundary closes for YOUR deployment.
- `deploy:public-smoke` exercises reachability, identity and the auth
  boundary. The strict smoke requires a reachable PostgreSQL authority;
  without one it fails closed — `--allow-degraded` records the explicit
  degraded pass rather than a silent one.

With a local PostgreSQL 16+ you can converge the full local
environment (synthetic-only by manifest policy):

```bash
export ZECK_PG_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres
bun run deploy:bootstrap -- --environment local    # converges zeck_local (idempotent)
bun run deploy:migrate   -- --environment local    # deterministic migrations
bun run deploy:public-smoke -- --environment local # strict pass: /health 200
```

Then point your integration at it: `ZECK_API_URL` at the API host,
`ZECK_TOKEN` a Zeck transport credential, `ZECK_APPLICATION_ID` your
application scope — the developer-side variable contract is
[machine/env-vars.json](machine/env-vars.json) (names only, never
values), and the connection values' discipline is
[AUTH.md](AUTH.md). The integration examples under
`examples/` (starting with `examples/quickstart.ts`) run unchanged
against your deployment.

## What is operator-only (the honest boundary)

These facts are recorded because they are the ones developers most
often underestimate:

- **Provider accounts cannot be created by the repository.** The
  public preview topology needs Cloudflare (R2 + Queues + Workflows),
  Neon, optionally Upstash, and a host (Vercel or any container/VM).
  Account-plane preconditions and the deterministic resource names are
  §3.2 of the operator recipe
  ([`deploy/PUBLIC-DEPLOYMENT.md`](../../deploy/PUBLIC-DEPLOYMENT.md)).
- **Secrets are environment-scoped references, never files.** The
  inventory is `deploy/manifests/secret-references.json`
  (`zeck-secret://<environment>/<name>` URIs); materializing their
  values in your secret manager / CI environment is an operator action.
- **The promotion ladder is governed, not social.**
  `deploy/manifests/environments.json` defines
  `local → ci → preview → staging → production` with per-step gates;
  staging → production requires architect approval. The operator
  surface is `deploy:release` (record → gate → promote), with the
  migration-safety gate, quota guards and rollback drill described in
  [`deploy/README.md`](../../deploy/README.md).
- **Free tiers are recorded, not live-verified.** The free-tier-first
  provider ledger `deploy/manifests/provider-tiers.json` records limits
  and terms with per-entry sources at an `asOf` date; the credentialed
  operator must re-verify each limit before applying the deployment
  (drift is an operational update to the ledger, never a silent
  assumption). One hard commercial rule worth internalizing early:
  **Vercel Hobby is non-commercial** — commercial production needs a
  commercially permitted plan or an alternate host (the API is
  independently runnable, so hosting moves with configuration only).
- **Spend never silently overages.** The quota fence denies at declared
  limits (fail-closed by default); unknown usage denies spend-incurring
  operations. See the guardrail summary in the operator recipe §4.

## Reproducing an execution against your deployment

The reproducibility bundle (`/console/executions/<id>/export`, machine
twin `…/export/bundle.json`) carries everything the public records
hold: the verbatim facts, artifact references with digests, the
repository revision facts the machine manifests carry, and the recipe.
To reproduce:

1. Bring up (or point at) a deployment — the developer path above for
   local, or your operator's preview.
2. Follow the bundle's `reproduction` section: run the recorded
   integration-kit example (or the quickstart fallback) with your
   connection values, or issue the documented API calls with the
   recreated create request. Use a fresh `Idempotency-Key` — the recipe
   recreates the run as a NEW governed execution, not the original row.
3. Compare what you get against the bundle's recorded facts (status,
   verification outcomes, artifact digests where your rails produce
   them). Differences are honest findings — provider rails, versions
   and non-determinism are exactly what a reproduction is for.

What the bundle deliberately does NOT carry — artifact content (bytes
stay in the object store behind digests), environment configuration,
the original request's idempotency key, per-step cost breakdowns, and
your deployment's git revision (that is `GET /identity`'s attestation)
— is listed as explicit boundaries inside the bundle itself.

## Where the authority lives (read these, not this page)

| Question | Authority |
|---|---|
| The full deployment layout and command catalog | [`deploy/README.md`](../../deploy/README.md) |
| The fresh-operator reproduction recipe (provider topology, preconditions, promotion) | [`deploy/PUBLIC-DEPLOYMENT.md`](../../deploy/PUBLIC-DEPLOYMENT.md) |
| Environment classes, isolation, promotion gates | `deploy/manifests/environments.json` |
| Provider/concern map and free-tier ledger | `deploy/manifests/providers.json`, `deploy/manifests/provider-tiers.json` |
| Resource inventory and deterministic naming | `deploy/manifests/resources.json` |
| Secret-reference inventory (names, scopes) | `deploy/manifests/secret-references.json` |
| The platform-side variable contract | `deploy/manifests/variables.json` |
| Quota/operational guardrail thresholds | `deploy/manifests/quota-guards.json` |
| Release gates and the promotion policy | `deploy/manifests/release-policy.json` |
| Production posture (promotion, secrets, quotas) from the developer side | [PRODUCTION.md](PRODUCTION.md) |

This page is a projection: if a seam above changes, the link follows
the change and this page stays true; a copied table would not.
