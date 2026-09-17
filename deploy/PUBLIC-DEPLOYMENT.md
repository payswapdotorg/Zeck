# Zeck Public Deployment Bootstrap — Operator Recipe (DEP-001)

**Status:** OPERATIONAL RUNBOOK (repository truth; provider consoles are evidence, never authority)
**Parent:** `docs/DEPLOYMENT-ARCHITECTURE.md` (D1.0), `docs/DEVELOPER-PLATFORM-DEPLOYMENT-ROADMAP.md`
**Scope:** reproducing the public Zeck control/API plane for preview and sandbox exploration from repository configuration only, under the free-tier-first doctrine.

This recipe is the DEP-001 deliverable for AC1 ("fresh operator can
reproduce the target deployment from repository configuration"). Every
step is a repository-resident command or a named account-plane
precondition. Nothing here requires reading internal implementation
code, and nothing here depends on provider console state as authority.

## 1. What is being deployed

The **bootstrap public API plane**: the independently-runnable API
host (`deploy/api.ts`) serving the repository's public route table —
`GET /health` (honest control-plane/dependency readiness facts,
fail-closed authority) and `GET /identity` (the exact-revision runtime
attestation: Git SHA + manifest digest + provider topology + free-tier
tier classes) — plus the deployment configuration set
(`deploy/manifests/`) that a credentialed operator applies to the
free-tier-first provider topology below.

The bootstrap composition binds the deployment seams for real and
leaves the domain capabilities honestly unbound
(`CAPABILITY_UNAVAILABLE` / `AUTHENTICATION_FAILED`): the console
application work orders (DEP-010+) own the domain binding at the same
seam. Deploying this plane proves reachability, identity, health
semantics and the provider topology — never a fabricated domain
success.

## 2. Provider topology (free-tier-first ledger)

The authoritative record is `deploy/manifests/provider-tiers.json`
(validated fail-closed by `bun run deploy:validate`). Summary as of the
`asOf` date in that file:

| Concern | Provider | Tier (doctrine position) | Authority role | Degradation on exhaustion/outage |
|---|---|---|---|---|
| relational-state | Neon | Neon Free (1: free tier) | **authoritative** | fail-closed `authority-unavailable` |
| artifact-bytes | Cloudflare R2 | free allowances (1: free tier) | bytes-only | `artifact-store-unavailable` |
| async-transport | Cloudflare Queues | usage-based, no minimum (2) | non-authoritative | `dispatch-backlogged` |
| durable-orchestration | Cloudflare Workflows | usage-based, no minimum (2) | non-authoritative | `orchestration-paused` |
| ephemeral-coordination | Upstash Redis | Free (1: free tier) | non-authoritative | `coordination-degraded` |
| experience-delivery | Vercel | Hobby (1: free tier — **non-commercial terms only**) | delivery-only | `delivery-degraded` |
| execution-compute | zeck-container-runner | self-hosted runner (4: where required) | non-authoritative | `execution-compute-unavailable` |
| observability-export | any OTLP collector | usage-based/self-hosted (2) | non-authoritative | `logs-only` |

Doctrine order (roadmap): provider free tier → usage-based/no-minimum
→ low fixed-cost managed → paid only where required.

**Exact limits/terms** live in the ledger with per-entry sources. They
are operational constraints recorded at an `asOf` date — NOT live
facts: the DEP-001 worker pod had no cloud credentials, so every
live-provider check is recorded NOT RUN (AC7) and the credentialed
operator must re-verify each limit before applying the deployment.
Drift is an operational update to the ledger, never a silent
assumption.

**Hard commercial rule:** Vercel Hobby is permitted for
personal/non-commercial development and preview only. Commercial
production must use a commercially permitted plan (e.g. Vercel Pro) or
an alternate host — the API is independently runnable, so hosting
moves with configuration only.

**Upgrade/exit notes** (every free-tier dependency has one — disposable
free-tier resources never become operationally critical):

- **Neon (authoritative — MUST upgrade for commercial production):**
  promote to Neon Launch or any managed PostgreSQL provider; the
  adapter is provider-neutral (wire protocol; connection URLs only).
  Exit drills: `deploy:backup` / `deploy:restore` (logical, checksummed).
- **R2:** any S3-compatible store via `deploy:drill artifact-exit`
  (digest-verified byte migration); metadata stays in PostgreSQL.
- **Queues/Workflows:** any broker/engine behind the existing ports via
  `deploy:drill queue-recovery` (replay convergence through existing
  idempotency — never provider dedup).
- **Upstash:** disposable by doctrine — drop it (coordination-degraded
  is a first-class state) or point at any Redis-compatible service.
- **Vercel:** repoint delivery at any host running `deploy/api.ts`;
  domain authority is operator-owned config and never changes with the
  host (see §7).

## 3. Reproduction steps (fresh operator)

### 3.1 Local verification (no cloud accounts required)

```bash
git clone https://github.com/payswapdotorg/Zeck.git && cd Zeck
bun install
bun run deploy:validate                 # configuration gate (no network)
bun run deploy:api -- --environment local   # boots the bootstrap host (127.0.0.1:8787)
# in another shell:
curl -s http://127.0.0.1:8787/identity | jq '.identity.gitRevision'   # == git rev-parse HEAD
bun run deploy:public-smoke -- --environment local [--allow-degraded]
```

The strict public smoke requires a reachable PostgreSQL authority
(`ZECK_PG_ADMIN_URL`, or `ZECK_DATABASE_URL` in provider
environments); without one it fails closed — `--allow-degraded`
records the explicit degraded pass. With a local PostgreSQL 16+:

```bash
export ZECK_PG_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres
bun run deploy:bootstrap -- --environment local    # converges zeck_local (idempotent)
bun run deploy:migrate   -- --environment local    # deterministic migrations
bun run deploy:public-smoke -- --environment local # strict pass: /health 200
```

### 3.2 The public preview deployment (credentialed operator)

Account-plane preconditions (one-time; the repository cannot create
provider accounts):

1. Provider accounts exist: Cloudflare (R2 + Queues + Workflows), Neon,
   Upstash (optional), Vercel (or your alternate host).
2. Resources are created with the DETERMINISTIC names — never invented:
   `bun run deploy:bootstrap -- --environment preview --branch <branch>`
   emits the exact resource set, computed names and ownership labels.
3. Secret references are materialized (environment-scoped):
   `zeck-secret://preview/<name>` URIs in the `ZECK_SECRET_*_REF`
   variables plus their values in your secret manager / CI environment
   (the inventory: `deploy/manifests/secret-references.json`).
4. Re-verify the free-tier limits against current provider pricing
   pages; update `deploy/manifests/provider-tiers.json` if drifted
   (then `bun run deploy:validate` must stay green).

Then converge and attest:

```bash
export ZECK_ENVIRONMENT=preview
bun run deploy:migrate   -- --environment preview --branch <branch>  # via the materialized database-url secret
bun run deploy:smoke     -- --environment preview --branch <branch>  # REAL provider probes (pg, R2, queue, workflow)
bun run deploy:api       -- --environment preview --branch <branch>  # the public bootstrap host
bun run deploy:public-smoke -- --environment preview --branch <branch>
bun run deploy:release   -- record --environment preview             # bind the exact-revision deployment identity
```

Hosting: run `deploy/api.ts` on Vercel's Bun runtime (preview;
Hobby terms only where permitted) or any container/VM host. The host
is configuration, not architecture — the identity and health surfaces
behave identically everywhere.

### 3.3 Promotion to staging/production

The governed ladder (`local → ci → preview → staging → production`) is
`deploy/manifests/environments.json` + `release-policy.json`; the
operator surface is `deploy:release` (record → gate → promote), with
the migration-safety gate, quota guards and rollback drill already
shipped (D-06). Commercial production requires the paid-tier upgrades
above and the architect-approval gate.

## 4. Spend/quota guardrails (no silent paid overage)

- **Quota fence** (`src/platform/deployment/quota-fence.ts`): the
  provider-neutral decision point. Usage at/over a declared limit ⇒
  DENY with the provider's declared degradation mode; the default
  overage policy is fail-closed. Continuing paid consumption past a
  limit requires an explicit, recorded overage approval — silent paid
  overage is unrepresentable (pinned by
  `tests/unit/deployment/quota-fence.test.ts`).
- **Unknown usage fails closed**: an outage/failed probe denies
  spend-incurring operations — never a permissive default on missing
  telemetry.
- **Provider outage postures**: authoritative ⇒ fail-closed (the plane
  is DOWN for authority-bearing work); every non-authoritative
  dependency ⇒ its declared degraded mode (degraded-but-alive).
  Authority roles are manifest-declared and invariant — an outage never
  promotes a secondary datastore.
- **Bounded budgets** at the transport layer (queue publish/delivery
  attempts, workflow start/signal/effect attempts, worker fabric
  bounds) are repository defaults in `deploy/manifests/variables.json`.

## 5. Rollback and repoint (domain authority unchanged)

- The runtime identity document is hosting-independent (no host/port/
  URL fields — pinned by `tests/unit/deployment/repoint.test.ts`), so
  repointing delivery never changes what an instance attests.
- The domain-authority mapping (PostgreSQL as the only durable
  authority) is manifest-declared and identical across hosts and
  revisions; a rollback is an identity-revision change, never an
  authority change.
- The governed rollback (pointer flip touching `release_control`
  exclusively, target must itself be gate-passed) is shipped in
  `deploy:release rollback` (D-06).

## 6. Verification mapping (DEP-001 acceptance criteria)

| AC | Evidence |
|---|---|
| 1. Reproducible from repository configuration | this recipe + `deploy/manifests/**` + `deploy:validate` (14 rule families, fail-closed) |
| 2. API health + public integration smoke at exact revision | `deploy:public-smoke` (identity attest + health semantics + auth boundary); `GET /identity` surface |
| 3. Environment/credential isolation | `tests/unit/deployment/env-contract.test.ts` (cross-environment references rejected); `zeck-secret://` environment scoping |
| 4. Free-tier choices + exact tested limits recorded | `deploy/manifests/provider-tiers.json` + `tests/unit/deployment/provider-tiers.test.ts` |
| 5. Quota exhaustion/outage fail safely, no silent overage | `src/platform/deployment/quota-fence.ts` + `tests/unit/deployment/quota-fence.test.ts` |
| 6. Rollback/repoint without domain-authority change | `tests/unit/deployment/repoint.test.ts` + the D-06 release rollback drill |
| 7. NOT RUN live-provider checks listed honestly | `deploy/evidence/dep-001.json` + the ledger's verification boundary |

## 7. Honest boundaries (what DEP-001 does NOT claim)

- No live provider operation was executed from the DEP-001 worker pod
  (no credentials): no Vercel/Neon/Cloudflare/Upstash deployment, no
  real DNS, no live quota probes. The credentialed re-run (Lead)
  executes §3.2 and owns the live verification of record.
- The bootstrap host's domain capabilities are intentionally unbound;
  the console application work orders (DEP-010+) bind them. The
  deployment seams (identity, readiness, transport) are production
  surfaces.
- Free-tier limits are recorded, not live-verified (see §2).
