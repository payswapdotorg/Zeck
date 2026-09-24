# Zeck Public Deployment Bootstrap — Operator Recipe (DEP-001, extended by DEP-002, DEP-003, DEP-043, PPR-002 and PPR-006)

**Status:** OPERATIONAL RUNBOOK (repository truth; provider consoles are evidence, never authority)
**Parent:** `docs/DEPLOYMENT-ARCHITECTURE.md` (D1.0), `docs/DEVELOPER-PLATFORM-DEPLOYMENT-ROADMAP.md`
**Scope:** reproducing the public Zeck control/API plane for preview and sandbox exploration from repository configuration only, under the free-tier-first doctrine — now including the environment/secret/sandbox-account provisioning path (§8, DEP-002), the production verification chain: exact-revision public-route smoke, fail-closed health readiness, spend/quota guardrails and deployment-identity promotion (§9, DEP-003), the end-to-end validation driver (§10, DEP-040), the production operations drills: promote/rollback both directions, backup/restore round-trip, provider exit and teardown classification guards (§11, DEP-043), the PPR-002 free-tier preview readiness layer: the refreshed provider-tier ledger (asOf 2026-09-20) and the account/credential preflight + provider-tier fact reconciliation that now heads the credentialed sequence (§12, PPR-002), and the PPR-006 Vercel hosting layer: the repository-resident function entry, adapter and vercel.json that make the plane deployable to Vercel behind configuration only, with the exact deployment contract and the post-deploy exact-revision verification (§13, PPR-006).

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
| async-transport | Cloudflare Queues | Workers Free allowance (1: free tier — PPR-002 refresh) | non-authoritative | `dispatch-backlogged` |
| durable-orchestration | Cloudflare Workflows | Workers Free allowance (1: free tier — PPR-002 refresh) | non-authoritative | `orchestration-paused` |
| ephemeral-coordination | Upstash Redis | Free (1: free tier) | non-authoritative | `coordination-degraded` |
| experience-delivery | Vercel | Hobby (1: free tier — **non-commercial terms only**) | delivery-only | `delivery-degraded` |
| execution-compute | zeck-container-runner | self-hosted runner (4: where required) | non-authoritative | `execution-compute-unavailable` |
| observability-export | any OTLP collector | usage-based/self-hosted (2) | non-authoritative | `logs-only` |

Doctrine order (roadmap): provider free tier → usage-based/no-minimum
→ low fixed-cost managed → paid only where required.

**Exact limits/terms** live in the ledger with per-entry sources. They
are operational constraints recorded at an `asOf` date with a
per-entry source (the provider's public documentation URL, or the
repository contract path for repository-defined entries) and a
per-entry verification status — NOT live facts: the PPR-002 worker
pod had no cloud credentials, so every live-provider check is
recorded NOT RUN and the credentialed operator must re-verify each
limit against its recorded source before applying the deployment
(`bun deploy/preflight.ts` surfaces exactly this boundary — §12).
Drift is an operational update to the ledger, never a silent
assumption. The PPR-002 refresh (asOf 2026-09-20) moved Queues and
Workflows to doctrine position 1: both are included on the Workers
Free plan with documented free allowances (Queues 10,000
operations/day + 24-hour free retention; Workflows 100,000
requests/day + 3,000 steps/day + 1 GB-month storage), with
usage-based billing beyond the allowance on the same provider.

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
bun run deploy:provision -- --environment local --plan   # DEP-002 dry-run: the full convergence plan, zero credentials
ZECK_ENVIRONMENT=local bun run deploy:provision -- --environment local   # converge the scaffold + sandbox-account records (idempotent)
bun run deploy:api -- --environment local   # boots the bootstrap host (127.0.0.1:8787)
# in another shell:
curl -s http://127.0.0.1:8787/identity | jq '.identity.gitRevision'   # == git rev-parse HEAD
bun run deploy:public-smoke -- --environment local [--allow-degraded]
```

The provision step (DEP-002) writes under the local data root
(`ZECK_LOCAL_DATA_ROOT`, default `$XDG_DATA_HOME/zeck`): the
secret-reference scaffold (`secrets.reference.env` + CI variable
skeleton) and the sandbox-account records projected from
`deploy/manifests/sandbox-accounts.json`. It is idempotent — a second
run reports already-converged — and `deploy:teardown --environment
local` removes the records under the same classification guard.

The strict public smoke requires a reachable PostgreSQL authority
(`ZECK_PG_ADMIN_URL`, or `ZECK_DATABASE_URL` in provider
environments); without one it fails closed — `--allow-degraded`
records the explicit degraded pass. With a local PostgreSQL 16+:

```bash
export ZECK_PG_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres
export ZECK_ENVIRONMENT=local                            # GF-1 closure: the environment contract
                                                         # migrate/release check fail-closed without it
bun run deploy:bootstrap -- --environment local    # converges zeck_local (idempotent)
bun run deploy:migrate   -- --environment local    # deterministic migrations
bun run deploy:public-smoke -- --environment local # strict pass: /health 200
```

### 3.2 The public preview deployment (credentialed operator)

Account-plane preconditions (one-time; the repository cannot create
provider accounts):

0. **PPR-002 preflight (the head of the sequence):**
   `bun deploy/preflight.ts --environment preview [--branch <branch>]`
   runs the configuration gate, the URL-hygiene check over the
   variable contract, the account/credential preflight (presence
   only) and the provider-tier fact reconciliation in one fail-closed
   report — see §12.
1. Provider accounts exist: Cloudflare (R2 + Queues + Workflows), Neon,
   Upstash (optional), Vercel (or your alternate host).
2. Resources are created with the DETERMINISTIC names — never invented:
   `bun run deploy:bootstrap -- --environment preview --branch <branch>`
   emits the exact resource set, computed names and ownership labels.
3. Secret references are materialized (environment-scoped):
   `zeck-secret://preview/<name>` URIs in the `ZECK_SECRET_*_REF`
   variables plus their values in your secret manager / CI environment
   (the inventory: `deploy/manifests/secret-references.json`). Run
   `ZECK_ENVIRONMENT=preview bun run deploy:provision -- --environment preview --branch <branch>`
   to generate the reference scaffold and CI variable skeleton for
   exactly this environment — the tool emits the REFERENCES ONLY; the
   values never transit it (see §8).
4. Re-verify the free-tier limits against current provider pricing
   pages; update `deploy/manifests/provider-tiers.json` if drifted
   (then `bun run deploy:validate` must stay green, and the per-entry
   verification status upgrades to `live-verified` as you re-verify
   each recorded fact against its per-entry source).

Then converge and attest:

```bash
export ZECK_ENVIRONMENT=preview
bun run deploy:migrate   -- --environment preview --branch <branch>  # via the materialized database-url secret
bun run deploy:smoke     -- --environment preview --branch <branch>  # REAL provider probes (pg, R2, queue, workflow)
bun run deploy:api       -- --environment preview --branch <branch>  # the public bootstrap host
bun run deploy:public-smoke -- --environment preview --branch <branch>
bun run deploy:release   -- record --environment preview             # bind the exact-revision deployment identity
```

Hosting: the repository now carries the Vercel hosting
configuration (PPR-006, §13): the root `server.ts` function entry +
`deploy/vercel.ts` (the hosting adapter) + `vercel.json` — the plane
deploys to the Vercel project `zeck-preview-main` (Hobby,
non-commercial preview only) behind the deployment contract below,
or runs on any container/VM host via `deploy/api.ts`. The host is
configuration, not architecture — the identity and health surfaces
behave identically everywhere (pinned by
`tests/unit/deployment/vercel-adapter.test.ts` and
`tests/integration/deployment/vercel-entry.test.ts`).

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
| 1. Reproducible from repository configuration | this recipe + `deploy/manifests/**` + `deploy:validate` (15 rule families incl. the DEP-002 sandbox-accounts manifest, fail-closed) |
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

## 8. Environment provisioning — `deploy:provision` (DEP-002)

`bun run deploy:provision -- --environment <class> [--branch <branch>] [--plan] [--json]`
is the single reproducible operator path that converges an environment
class from repository truth, in documented order:

1. **manifest validation** — the full `deploy:validate` gate (15 rule
   families, including the sandbox-accounts manifest) runs FIRST;
   malformed rows abort before any provider call or write;
2. **resource plan** — the deterministic resource set from the DEP-001
   bootstrap seam (computed names, never invented topology); local
   convergence stays `deploy:bootstrap`'s lane;
3. **secret-reference scaffold** — per-environment reference templates
   (`secrets.reference.env`) and CI variable skeletons
   (`ci-variables.json`) mapping every `secret-references.json` entry
   to where its VALUE gets injected. EXTERNAL-ONLY by construction:
   the tool never accepts, stores, logs or renders secret plaintext —
   a reference variable holding non-reference material aborts
   fail-closed;
4. **sandbox-account records** — the disposable identity set the
   environment class permits (local `local-developer`, per-branch
   `preview-disposable`, staging `staging-validation`; production
   declares none — disposable synthetic identities are unrepresentable
   in the authoritative environment). Every record is a PURE projection
   of `deploy/manifests/sandbox-accounts.json`: synthetic-data policy
   cross-checked against the frozen platform artifact, quota envelope
   wired to `quota-guards.json` thresholds, DEP-014 expiry semantics
   (TTL, state-non-carrying reset, honest post-expiry reads);
5. **post-convergence validation** — the on-disk artifact set is
   re-derived and byte-compared against the manifest projection.

Idempotence and teardown: a second run reports already-converged; a
drifted state (missing/corrupted/orphaned artifacts) re-converges;
`deploy:teardown` removes exactly the classification-permitted records
(persistent classes are refused — classification, not operator intent,
governs removal).

Live-provider steps (Neon/R2/Cloudflare/Upstash/Vercel resource
creation) are account-plane work gated on credential PRESENCE (never
values): without credentials each step records honest NOT RUN with the
owner "Lead credentialed re-run"; with credentials present the plan is
marked executable for the credentialed operator application path. This
tool performs no provider control-plane calls (provider-neutrality
doctrine, §3.2).

**DEP-002 honest boundaries:** no live provider resource was created
from the DEP-002 worker pod (no credentials); the executable plan is
the deliverable and the credentialed re-run owns the live application.
The sandbox-account records are provisioning facts (policy envelopes),
not runtime identities — runtime sandbox identities stay governed by
the DEP-014 platform surface. Pinned by
`tests/unit/deployment/provision.test.ts` (plan mode without
credentials, idempotence, drift re-convergence, teardown guards,
secret external-only hostile probes, fail-closed manifest validation,
pure-manifest projection).

## 9. The production verification chain (DEP-003)

Everything above proves a plane can be BUILT and BOUND. The DEP-003
chain proves a plane can be PROMOTED ON EVIDENCE: the exact-revision
public-route smoke, the fail-closed health/authority readiness probes,
the spend/quota guardrail evaluation and the deployment-identity
verification compose into the promotion path the D-06 release surface
governs — one release authority, one alert authority, no second gate
vocabulary (the closed `release-policy.json` gate kinds are untouched;
the identity verification is a pre-gate refusal + journaled evidence,
not a new gate kind).

### 9.1 The public-route production smoke at an exact revision

```bash
# local-boot mode (default): boots the REAL bootstrap host on an
# ephemeral port, attests it, drains it on SIGTERM:
bun run deploy:public-smoke -- --environment local [--allow-degraded]

# --url mode (the production path): attest the ALREADY-DEPLOYED plane
# that serves traffic, wherever it runs:
bun run deploy:public-smoke -- --environment production --url https://api.example.com
bun run deploy:public-smoke -- --environment preview --branch <branch> --url https://<preview-host>
```

One run attests, over real HTTP against the real plane:

1. **TRANSPORT** — the plane answers at all;
2. **IDENTITY at the exact revision** — `GET /identity` recomputes:
   the Git SHA equals the checkout revision, the manifest digest and
   topology digest equal the recomputed values, the provider topology
   equals the `provider-tiers.json` concern map and the runtime
   identity id re-derives (`verifyRuntimeDeploymentIdentity`);
3. **HEALTH semantics** — §9.2 below;
4. **EVERY public route's honest boundary** — the full route table,
   not a sample: the executions/agents/economic-actions/
   codebase-analysis surfaces (18 routes) must answer the honest 401
   `AUTHENTICATION_FAILED` at the authenticate seam (the auth boundary
   enforced, no capability fabricated); the credentials and
   sandbox-governance surfaces wired to unbound authorities (7 routes)
   must answer the honest 422 `CAPABILITY_UNAVAILABLE`; the public
   sandbox data-policy artifact (1 route) must answer 200 with the
   versioned artifact + digest. The report carries the counts
   (`routeCoverage.probed / authBoundaryEnforced /
   capabilityUnboundHonest / publicArtifactBound`) — 26 probed routes
   plus `/health` and `/identity` attested separately = the complete
   28-route public table.

**Fail-closed semantics (a smoke never warns):**

- A plane attesting the WRONG revision fails exit 1, naming the
  exact-revision identity attest mismatch — even with `--allow-degraded`
  (a degraded pass never extends to identity drift).
- An UNREACHABLE plane fails exit 1 (`transportReachable: false`) —
  never a warning, never a partial pass.
- A plane whose `/health` answers 503 (an authoritative dependency
  unattested) fails in strict mode; `--allow-degraded` converts it to
  the EXPLICIT recorded boundary — the report's `healthCheck` carries
  the `down-allowed-degraded` marker and `problems` stays empty. The
  flag records the boundary; it never widens it.

The JSON report (`mode`, `planeUrl`, `expectedRevision`,
`attestation`, `routeCoverage`, `problems`) is the operator's evidence
artifact; exit code is the gate.

### 9.2 Fail-closed health and authority readiness

`GET /health` of the deployed plane reports the control-plane /
dependency distinction with honest facts:

- `controlPlane: "ready"` — the transport answered; the control plane
  is up regardless of dependency state.
- The dependency set is EXACTLY the manifests' provider-map projection
  for the environment class (database / object-store / coordination /
  compute for local; the provider concern map for hosted classes) —
  `expectedProbeConcerns`, never an invented label.
- Each dependency carries the closed classification vocabulary
  (`ready` / `degraded` / `unavailable`), its manifest-declared
  authority role and, when degraded, its provider-declared degraded
  mode.
- **Fail-closed authority**: an AUTHORITATIVE dependency not ready ⇒
  the whole plane answers 503 `down` (the relational authority is
  never silently bypassed); every non-authoritative dependency ⇒ its
  declared degraded mode (degraded-but-alive, never fabricated ready).
- An UNKNOWN/failed probe is `unavailable` — never a permissive
  default on missing telemetry.

Deterministic boundary drill (no PostgreSQL required): point the
environment's `ZECK_PG_ADMIN_URL` at a port with no listener (a
reserved-then-closed port); the health probe's TCP connect is
genuinely attempted and genuinely refused — the plane reports 503
`down` with `relational-state: unavailable ("unreachable (fail
closed)")` while the non-authoritative concerns degrade explicitly.
This is exactly the pinned test
(`tests/integration/deployment/plane-identity.test.ts`, real-process
probes — no mocks of the probe path itself).

### 9.3 Spend/quota guardrails — the composed evaluation

`bun run deploy:release -- alerts --environment <class>` now emits the
composed guardrail report (and `promote` evaluates the same
composition before deciding):

```json
{
  "alerts": [ ... ],
  "critical": false,
  "guardrails": {
    "fenceDecisions":   [ ... ],
    "thresholdsApplied": { "queue-backlog": { "warnAtPct": 80, "criticalAtPct": 95 }, ... },
    "limitResolutions": [ { "guard": "queue-backlog", "limit": 1000, "source": "manifest" }, ... ],
    "promotionBlocked": false,
    "blockReasons": []
  }
}
```

**Where every number comes from (the manifest is the only limit
carrier):** thresholds and default limits resolve from
`deploy/manifests/quota-guards.json` — `queue-backlog` carries
`defaultLimitBytes: 1000` (the manifest-declared default backlog
bound, unit: pending envelopes; operator override
`ZECK_QUEUE_BACKLOG_BOUND`), `database-size` documents its
`defaultLimitBytes: 5368709120` (5 GiB; override
`ZECK_DB_SIZE_LIMIT_BYTES`). Operator overrides sit ON TOP of the
manifest row and must be well-formed: a MALFORMED override (non-
positive, fractional, trailing garbage) ABORTS the evaluation
fail-closed — never a silent substitution of the manifest default.
A guard with no manifest row and no override (compute-claims: the
compute-plane environment quota IS the limit) resolves
authority-owned — nothing invented. The audit trail lands in
`limitResolutions` (`operator-override` / `manifest` /
`authority-owned`).

**Ceiling refusal vs alert semantics — two different honest answers:**

- The provider **spend fence** DENIES at the limit: a
  provider-concern usage snapshot at/over its declared limit refuses
  with the provider's declared degradation mode (relational-state ⇒
  fail-closed `authority-unavailable`; async-transport ⇒ explicit
  `dispatch-backlogged`). Silent paid overage is unrepresentable:
  the default overage policy is fail-closed, and continuing past a
  limit requires an explicit, RECORDED, BOUNDED overage approval —
  the approval's own bound denies when reached (no blank checks).
  Unknown usage denies (`usage-unknown`) — never a permissive
  default.
- The **alert thresholds** fire per the same manifest rows: WARNING
  at `warnAtPct` (plan capacity), CRITICAL at `criticalAtPct` — and a
  CRITICAL alert BLOCKS promotion (the D-06 semantics, one alert
  authority). Both are proven to move with the manifest row (a
  mutated row changes the evaluation — thresholds are never
  tool-local constants).

Honest boundary: `artifact-bytes` utilization is not measurable from
the local authoritative stores (the object store's own meter is
credential-gated) — the evaluation records the absence rather than
fabricating a snapshot (NOT RUN in `deploy/evidence/dep-003.json`,
owner: Lead credentialed re-run).

### 9.4 Deployment identity: attest → verify → promote; rollback re-attests

The promotion path consumes the exact-revision attestation (Git SHA +
manifest digest + provider topology, `GET /identity`) as an INPUT:

```bash
# the plane serving traffic must ATTEST the candidate revision
# BEFORE the promotion decides (hosting targets):
bun run deploy:release -- promote --to staging --actor <you> --plane-url https://api.staging.example.com

# after the governed rollback (pointer flip), re-attest the TARGET
# release's revision (the operator repoints the plane, then re-runs):
bun run deploy:release -- rollback --environment staging --to <releaseId> --actor <you> --plane-url https://api.staging.example.com
```

Semantics (both directions fail closed, never warn):

- **Promote**: with `--plane-url`, the plane is attested BEFORE the
  gate evaluation. An unreachable, schema-drifted, tampered or
  wrong-revision plane REFUSES the promotion — a `refused` promotion
  decision is journaled with the exact reason and the tool exits 1,
  regardless of gate evidence (an unverified plane is not promotable).
  A verified plane records the evidence in the journal and the stdout
  document (`planeIdentity`: plane URL, attested revision, runtime
  identity id). Without `--plane-url`, the recorded identity-audit
  gate evidence (the ledger binding) remains the identity authority —
  an honest note in the output, never a fabricated verification.
- **Rollback**: the pointer flip touches `release_control`
  exclusively (durable domain state untouched, §5); with
  `--plane-url` the tool then re-attests the plane at the TARGET
  release's revision. A plane still serving the FROM revision exits
  non-zero with the exact honest instruction ("not yet repointed …
  repoint it and re-run"); the rollback itself already happened, the
  repoint is the operator's remaining step. The re-attestation never
  touches domain authority: the identity document is
  hosting-independent and the provider topology is manifest-declared
  (invariant under repoint).
- For `preview` targets, pass `--branch <branch>` so the attestation
  expects the branch-scoped preview slug.

The guard decisions and the attestation core are pinned by
`tests/unit/deployment/promotion-identity.test.ts` (both directions)
and `tests/integration/deployment/plane-identity.test.ts` (real plane
processes, real HTTP).

### 9.5 DEP-003 honest boundaries (what this record does NOT claim)

- **Live-provider promotion rails were NOT RUN from the worker pod**
  (no cloud credentials): no promote/rollback against a real hosted
  production plane, no production-class `--url` smoke over the public
  internet, no live provider-meter parity for the fence inputs, no
  artifact-bytes measurement, no journaled end-to-end `--plane-url`
  drill over the PostgreSQL release ledger, no health
  ready-authority 200 path (no PostgreSQL server in the pod). Every
  one of these is recorded NOT RUN with its owner in
  `deploy/evidence/dep-003.json` — **owner: Lead credentialed
  re-run** (this recipe's §3.2 + §9 with live credentials is that
  re-run).
- What IS verified without credentials: every mechanism above
  against REAL local plane processes over real HTTP (real
  subprocesses, real TCP connects — the identity core, the full
  route-table smoke with its wrong-revision/unreachable negatives,
  the deterministic authority-unavailable health boundary, the
  guardrail negative paths over the real manifests, and the promote/
  rollback guard decisions in both directions).
- The full battery of record: governance OK, typecheck 0, lint
  68w/8i/0e (baseline), 504 files / 8515 tests + 201 honest PG-gated
  skips, `deploy:validate` exit 0 — exact numbers in
  `deploy/evidence/dep-003.json`.

## 10. The end-to-end validation driver (DEP-040)

Everything above is delivered as a COMPOSABLE chain; DEP-040 proves the
chain as an operator would run it — one driver, real subprocesses, real
HTTP, real local rails:

```bash
# the driver's own config (battery-separated from ZECK_PG_TEST_URL):
# a credential-less local PostgreSQL admin URL (17.11 verified; 16+ floor)
export ZECK_PG_ADMIN_URL=postgres://postgres@127.0.0.1:54329/postgres
bun deploy/e2e-validate.ts
```

The driver composes the operator order of this recipe — validate →
bootstrap → provision → migrate → identity → public-smoke → guardrails
(`deploy:release alerts`) → release (record → gate → promote/rollback
with the pre-promotion plane attestation) → teardown — recording each
step's REAL exit status, timing and output digest, and refusing on any
deviation (a failure anywhere fails the validation — never a warning).

What the one driver run proves over the real local rails (the report
carries each fact; `deploy/evidence/dep-040.json` is the evidence of
record):

- **Idempotent convergence**: bootstrap (create-or-skip → already
  converged), provision (create → already-converged), migrate
  (applies the shipped set → applies nothing) — the exact §3.1
  sequence against a real PostgreSQL server;
- **The strict ready-authority smoke**: `/health` 200 with the
  authority attested (the fail-closed authority would answer 503),
  the FULL public route table (26 probed = 18 honest 401 + 7 honest
  422 + 1 public artifact) at the exact revision, identity attested
  before AND after the chain (byte-identical document);
- **The hostile negatives, each REFUSED with its exact reason**: a
  wrong-revision plane, an unreachable plane, a dead authority (a
  genuinely refused TCP connect → 503 down; `--allow-degraded`
  records the explicit pass), a TAMPERED plane (a git archive of HEAD
  plus ONE well-formed `variables.json` row — the tampered tree still
  passes `deploy:validate`, and the identity recompute REFUSES it),
  a malformed guardrail override (abort, never a silent substitution),
  at-limit spend (DENY `quota-exhausted` with the declared
  degradation mode; CRITICAL blocks promotion), a mutated manifest
  limit row (the fence moves with the manifest), and the
  classification-guarded teardown refusals;
- **The promote path both directions**: refused on
  wrong-revision/unreachable/tampered planes; verified + activated on
  the real one; **rollback re-attestation both directions**: the
  pre-repoint refusal carries the exact repoint instruction, the
  post-repoint run verifies the target revision;
- **The real teardown**: the provisioned records removed, the
  computed `zeck_local` dropped (verified gone by round trip), the
  dead-PG drop failing closed.

PLANE-BOOT DISCIPLINE: the driver never proceeds on a bare `/health`
200 — it waits for the plane's BOOT DOCUMENT on stdout (the JSON
`deploy/api.ts` prints once the listener is bound). A health probe can
win against the boot document by a tick; the boot document is the
later, authoritative barrier. The integration suite pins this with
three consecutive full driver runs (`tests/integration/deployment/
e2e-driver.test.ts` — the 2-of-3 flaky class cannot hide).

Credential honesty (unchanged doctrine): the live-provider rails are
recorded NOT RUN with their owner in the driver's own report and in
`deploy/evidence/dep-040.json`; the PG-backed rails ran for real
against the local PostgreSQL server above. The driver REFUSES a
`ZECK_PG_ADMIN_URL` carrying URL-embedded credentials (the same
pattern the architecture secret-scan pins over `deploy/**`).

## 11. The production drill (DEP-043 — promote/rollback, backup/restore, provider exit, teardown guards)

The DEP-040 chain proves a plane can be BUILT, BOUND and PROMOTED ON
EVIDENCE. DEP-043 drills the production OPERATIONS story — the four
drills an operator runs when things change or go wrong — through ONE
driver over the SAME local rails, reusing the DEP-040 driver's
URL-hygiene preflight and boot-document discipline:

```bash
# the drill's own config (a DEDICATED instance: the drill's final
# teardown segment DROPS the computed zeck_local database):
export ZECK_PG_ADMIN_URL=postgres://postgres@127.0.0.1:54333/postgres
bun deploy/production-drill.ts
```

The driver composes the rail bring-up (validate → bootstrap →
provision → migrate) and then the four drills, recording each step's
REAL exit status, timing and output digest (any failure anywhere
fails the drill — never a warning; `deploy/evidence/dep-043.json` is
the evidence of record):

1. **PROMOTE→VERIFY→ROLLBACK** (§9.4 re-proven in the drill context):
   promotions to wrong-revision / unreachable / TAMPERED planes
   (a git archive of HEAD plus ONE well-formed `variables.json` row)
   each REFUSE with their exact fail-closed reason and a journaled
   `allowed:false` decision; the promotion to the verified plane
   succeeds with the attestation journaled; the governed rollback
   re-attests the TARGET revision after the pointer flip — the
   pre-repoint refusal carries the exact repoint instruction, the
   post-repoint run (a real plane booted from a manifest-identical
   ancestor worktree) verifies the target revision. Both directions
   proven.
2. **BACKUP/RESTORE ROUND-TRIP**: the authoritative store's logical
   backup (§2's relational-state exit path) restores into a fresh
   disposable target with per-table sha256 digest verification (the
   restore's own re-read + re-hash + row-count self-verification,
   plus the driver's before/after digest-stability comparison). The
   partial-failure behavior is fail-closed and tested: a
   wrong-format, a TRUNCATED and a DATA-TAMPERED artifact each REFUSE
   at restore with the exact reason — never a partial restore (the
   truncated refusal provably creates no recovery target).
3. **PROVIDER-EXIT** (every manifest provider class, §2): the
   relational-state exit is the executed round-trip above
   (provider-neutral adapter); the async-transport exit runs
   `deploy:drill queue-recovery`'s replay-plan classification against
   the real authority (the republish half honestly not-run in the
   tool's own registry); the durable-orchestration exit runs
   `deploy:workflow`'s authority-side machinery (the waits table is
   the authority; compaction + the recovery scan re-arm — synthetic
   provider configuration, zero provider calls on the empty
   substrate); the artifact-bytes exit's own fail-closed configuration
   gate is driven (never a fabricated PASS); the experience-delivery
   exit is proven by the REPOINT (two real planes on distinct
   endpoints attesting byte-identical identity documents through the
   same authority — no hosting coordinates in the document); the
   ephemeral-coordination / execution-compute / observability-export
   postures are attested live from the plane's `/health` (degraded
   -but-alive with the declared modes). The domain authority is
   proven UNTOUCHED by the whole exit segment (per-table digest
   fingerprint before/after). Every live half is recorded NOT RUN
   with its owner.
4. **TEARDOWN CLASSIFICATION GUARDS** (defensive re-check): staging
   and production refuse (classification, not operator intent); an
   AMBIGUOUS classification (a class/teardown-policy contradiction in
   `environments.json`) refuses at manifest load BEFORE any
   destruction; a reclassified-persistent environment refuses at the
   guard itself; the local PG drop fails closed against a dead
   authority; the REAL teardown removes exactly the computed
   resources (round-trip verified GONE).

The drill surfaced and fixed one deploy-tooling defect within
`deploy/`'s own boundaries (the full report is in the evidence
record): the D-07 objective gate made `deploy:drill queue-recovery`
(and `artifact-exit`/`worker-evacuation`) exit 1 on EVERY run — all
phases green, `recovered:true`, exit 1 — because the anchor-less
scenarios evaluated RPO without a recovery-point anchor. The
durability-anchored scenarios now carry the drill-start anchor (RPO 0
by durability: the envelopes, artifact digests and worker claims ARE
the authority's durable state), the same anchor class `authority-loss`
uses.

PLANE-BOOT DISCIPLINE (unchanged): the drill driver waits for the
plane's BOOT DOCUMENT, never a bare `/health` 200 — pinned by three
consecutive full drill runs in
`tests/integration/deployment/production-drill.test.ts`.

Credential honesty (unchanged doctrine): the live-provider halves are
recorded NOT RUN with their owner in the driver's own report and in
`deploy/evidence/dep-043.json`; the PG-backed rails ran for real
against the local PostgreSQL server above. The driver REFUSES a
`ZECK_PG_ADMIN_URL` carrying URL-embedded credentials.

## 12. The free-tier preview readiness layer (PPR-002)

PPR-002 (Live Free-Tier-First Public Preview Deployment,
repository-side work) refreshed the provider-tier ledger and added the
preflight that now heads the credentialed sequence. The evidence
record of this layer is `deploy/evidence/ppr-002.json`.

### 12.1 The refreshed provider-tier ledger (asOf 2026-09-20)

`deploy/manifests/provider-tiers.json` records the 2026-09-20 public
free-tier baseline, every entry now carrying its OWN `asOf`, `source`
(the provider's public documentation URL, or the repository contract
path for repository-defined entries) and `verification` status from
the closed vocabulary. The refresh:

- **Neon Free** — 100 projects / 100 CU-hours per month / 0.5 GB
  storage / 10 branches per project (was: bounded prose values);
- **Cloudflare Queues** — moved to doctrine position 1: included on
  the Workers Free plan (10,000 operations/day, 24-hour free
  retention; the queue consumer rides the Workers Free 100,000
  requests/day + 10 ms CPU platform allowance); usage-based beyond
  the allowance on the same provider;
- **Cloudflare Workflows** — moved to doctrine position 1: included
  on the Workers Free plan (100,000 requests/day, 3,000 steps/day,
  1 GB-month storage); usage-based beyond the allowances;
- **Upstash Redis Free** — 256 MB / 500,000 commands per month /
  10 GB monthly bandwidth (was: 10,000 commands per day);
- **Vercel Hobby** — $0 personal/non-commercial, the commercial-use
  PROHIBITED limit unchanged;
- R2 free allowances, the self-hosted runner and the OTLP collector
  entries unchanged (re-recorded with per-entry fields).

Every exhaustion/degradation/upgrade/exit behavior is preserved (the
exhaustion modes still equal the providers.json declared degradation
modes — pinned by `tests/unit/deployment/provider-tiers.test.ts`).
The commercial boundary is now recorded on the preview environment
itself (`environments.json` `commercialBoundary`) in addition to the
delivery tier's terms. Verification stays the honest worker-pod
state: `recorded-not-live-verified` — the Lead's credentialed re-run
re-verifies each fact against its per-entry source and upgrades the
status.

### 12.2 The preflight — `deploy/preflight.ts` (provisioning steps 1-2)

```bash
bun deploy/preflight.ts --environment preview [--branch work/PPR-002-x]
```

One fail-closed report before any provider resource is touched: the
configuration gate (the deploy:validate rule families), the URL
hygiene over the variable contract (a URL-typed variable carrying
`scheme://user:password@host` REFUSES — the same pattern class the
architecture secret-scan pins over `deploy/**`), the account/credential
preflight (the environment's provider resources with the
credential-variable NAMES each kind requires — presence only, never
values; the mapping is the ONE list shared with deploy/provision),
and the provider-tier fact reconciliation (per-entry
asOf/source/verification; a missing, malformed, future-dated or
unresolvable field refuses; the ledger age is reported informationally
— no invented staleness threshold). Absent credentials are honest
not-run rows with the owner "Lead credentialed re-run" — the tool
performs no provider control-plane calls. Exit 0 = preflight passed
(not-run rows are facts, not failures); exit 1 = fail-closed problems.

### 12.3 The honest boundary on manifest-refresh branches

The DEP-040/DEP-043 rollback both-directions drills require a second
revision with byte-identical `deploy/manifests` (the re-attestation
verifies against the CURRENT manifest set). A branch that legitimately
changes the manifests — the PPR-002 ledger refresh is the first such
case — has no such ancestor, and the drivers record their documented
honest skip (`skipped: true` with the exact reason) instead of
fabricating one. Both outcomes are pinned by
`tests/integration/deployment/e2e-driver.test.ts` and
`tests/integration/deployment/production-drill.test.ts`; the full
both-directions drills re-engage on the next manifest-stable revision.

## 13. The Vercel hosting layer (PPR-006 — the experience-delivery enabler)

The repository carries everything the Vercel deployment needs; the
Lead's credentialed run applies it. NO new authority and NO route
change: the deployed surface is the IDENTICAL `createApiServer`
public route table the CLI host serves, at its root paths (`GET
/health`, `GET /identity`, `POST /executions`, ...), composed by the
SHARED builder (`deploy/api.ts`'s `buildBootstrapApp`) — the hosting
adapter imports it, never re-implements it (parity pinned by
`tests/unit/deployment/vercel-adapter.test.ts`; the local-rail
`--url` proof plus the wrong-revision hostile negative are pinned by
`tests/integration/deployment/vercel-entry.test.ts`). The evidence
record of this layer is `deploy/evidence/ppr-006.json`.

### 13.1 The hosting files

- **`server.ts`** (repository root) — the Vercel function entry, at
  the location Vercel's Fastify framework entrypoint detection
  requires (a root `server.{ts}` importing fastify, calling
  `fastify.listen()`). The composition builds ONCE PER ISOLATE (the
  module-level singleton: cold start builds, warm requests reuse);
  Vercel's runtime captures the Fastify server and routes every
  request into Fastify's router with the ORIGINAL path. Locally
  (`bun server.ts`) the listener binds for real (`PORT`, default
  3000) so the exact `--url` smoke path can attest it before any
  deployment.
- **`deploy/vercel.ts`** — the hosting adapter: the fail-closed entry
  inputs, the once-per-isolate singleton, the cold-start boot record
  (the `deploy/vercel` `booted` JSON on the runtime logs) and the
  SIGTERM/SIGINT graceful drain.
- **`vercel.json`** (repository root) — pins the Fastify framework
  detection (`"framework": "fastify"`). The live deployment run
  (Lead, 2026-09-21) proved the platform's build REJECTS a
  `functions` pattern for a root entry (patterns only match
  Serverless Functions inside the `api` directory) and that the
  build's default file tracing ships `deploy/manifests/*.json` into
  the function bundle (verified in the built bundle of the same run)
  — the detected entry needs no functions-key configuration. The
  same run also proved the sandbox build's `tsc` transpile cannot
  resolve a `types` pin from the repository `tsconfig.json`
  (TS2688), so the tsconfig carries no `types` array (the installed
  `@types/*` packages are auto-included — verified identical
  typecheck/lint results on the real rail).

**The module-loading fact (the landed deployment's cold-start
  discovery)**: the framework build's `tsc` transpilation emits
  ES-module syntax (`import`/`export`; `import.meta.url` in
  `deploy/lib.ts` — the graph is ESM-required, a CommonJS emit is
  impossible), but the runtime loads the traced handler
  `/var/task/server.js` as **CommonJS**, because the file-traced
  repository `package.json` carries no `"type"` field — the isolate
  dies at cold start on every route (`SyntaxError: Cannot use import
  statement outside a module`, FUNCTION_INVOCATION_FAILED).
  `--rewriteRelativeImportExtensions` is NOT a fix (it rewrites only
  source-level `.ts` specifiers, never adds extensions to
  extensionless ones). **`deploy/build-vercel-output.ts`** is the
  correction — the platform's own `vercel build --prod` runs
  unchanged, then the emitted graph's relative import specifiers are
  made Node-ESM-resolvable (a file target gains `.js`; a directory
  target gains `/index.js` — Node ESM has no directory-index
  resolution) and the function root's `package.json` becomes the
  minimal `{"type": "module"}` marker (scoping only the emitted
  graph — every traced `node_modules` package keeps its own nearest
  `package.json`, so CJS packages stay CJS); a fail-closed
  verification refuses the build if any extensionless relative
  specifier remains. The corrected output ships with `vercel deploy
  --prebuilt --prod` — the artifact is proven locally first (it boots
  under plain `node server.js` and answers `deploy:public-smoke
  --url`) so the exact shipped bytes are verified before they serve
  traffic.

**The runtime**: Node.js (the Fastify framework detection's
default). The current Vercel documentation configures the officially
supported Bun runtime through the top-level `bunVersion` property —
NOT the `functions` `runtime` field, which is reserved for runtimes
that are not officially supported — and documents no Fastify
entrypoint shape for the Bun runtime (Beta, permissions-gated); the
Node.js runtime is used per the work order's allowance. Every source
URL and quotation date is recorded in the evidence record.

### 13.2 The deployment contract (environment variables — NAMES only)

Set these on the Vercel project (`zeck-preview-main`) before
deploying (the variable contract is `deploy/manifests/variables.json`
+ `secret-references.json`; values never transit this repository):

| Variable | Role |
|---|---|
| `ZECK_ENVIRONMENT` | the environment identity — `preview` on this rail (required, fail closed) |
| `ZECK_DEPLOY_GIT_REVISION` | the exact 40-hex deployed revision — REQUIRED on Vercel: the deployed bundle carries no git checkout, so the override is the only revision source; absent, the isolate fails closed at cold start (never a fabricated identity) |
| `ZECK_SECRET_DATABASE_URL_REF` + the other `ZECK_SECRET_*_REF` bindings | the environment-scoped reference URIs of the preview materialization set (§8; the inventory is `deploy/manifests/secret-references.json`) |
| the materialized values (`ZECK_DATABASE_URL`, ...) | the preview dependency values for the `/health` readiness facts (credential-shaped: environment-only storage, never committed) |
| `VERCEL_GIT_COMMIT_REF` | the Vercel system variable the adapter consumes as the preview branch input (provided by git-connected deployments; required when the environment is preview — the preview resource set is per-branch) |

### 13.3 The operator sequence (the Lead's credentialed run)

1. Set the deployment contract variables above on the Vercel project
   (Production environment; the preview materialization set of §3.2
   step 3).
2. Build and deploy the merged `main`:

   ```bash
   bun run deploy:build-vercel-output   # platform build + the module-loading correction
   # the local artifact proof (the exact shipped bytes):
   #   cd .vercel/output/functions/index.func && ZECK_ENVIRONMENT=preview \
   #   ZECK_DEPLOY_GIT_REVISION=<rev> VERCEL_GIT_COMMIT_REF=main node server.js
   #   bun run deploy:public-smoke -- --environment preview --branch main \
   #     --url http://127.0.0.1:<port> --allow-degraded
   vercel deploy --prebuilt --prod
   ```

   (A git-connected deployment or a plain `vc deploy --prod` produces
   the uncorrected transpilation and fails at cold start — the
   module-loading fact above; `deploy/build-vercel-output.ts` is the
   sanctioned path.)
3. Verify the DEPLOYED plane at the exact revision with the
   repository's own smoke — the same verification the local rail
   exercises against the entry before any deployment:

   ```bash
   bun run deploy:public-smoke -- --url <public-url> --environment preview --branch main
   ```

   The smoke attests the deployed plane's `/identity` (the exact
   revision, the recomputed identity, the provider topology), the
   `/health` honest facts over the materialized dependencies, and the
   full 26-route honest-boundary coverage; a wrong-revision or
   unreachable plane FAILS, never warns (the wrong-revision refusal
   is pinned by the integration test above).
4. Continue the §3.2 chain (`deploy:release -- record`, the journey
   acceptance against the public URL).

The worker never deploys and holds no Vercel credentials: every
live-Vercel step is an honest NOT RUN owned by the Lead credentialed
deployment run (the registry in `deploy/evidence/ppr-006.json`).


### 13.4 The experience surface (PPR-007 — the console composition served as a second function)

The preview deployment serves TWO functions composed from one
repository (the API plane unchanged, the experience surface added
alongside it):

- **`api/experience.ts`** (NEW) — the experience Serverless Function
  entry, at the placement the platform's `api` directory convention
  sanctions (files under `api/` are detected as Serverless Functions
  and served at their path — `/api/experience`; the documented
  convention is orthogonal to the framework detection, which allows
  ONE root entry per framework build — the root `server.ts` stays the
  Fastify entry and is NOT touched). The entry composes PPR-001's
  console composition ONCE PER ISOLATE (the module-level singleton in
  `deploy/experience.ts` — PPR-006's cold-start pattern) over the
  dashboard's ADDITIVE request-listener export
  (`createDashboardHandler` in `apps/dashboard/index.ts` — the exact
  listener `createDashboard`'s `createServer` wraps; the
  direct-execution entry's behavior is unchanged). On a local run
  (`bun api/experience.ts`) the listener binds for real (`PORT`,
  default 3001) so the composed shape can be proven before any
  deployment.
- **`deploy/experience.ts`** (NEW) — the hosting adapter: the
  fail-closed entry inputs, the once-per-isolate singleton, the
  cold-start boot record (the `deploy/experience` `booted` JSON on the
  runtime logs, with `tokenBound` as a BOOLEAN — never the
  credential), and the routing carry (`experienceRequestPath`).
- **`vercel.json`** — adds the routing (the `rewrites` array; the
  Fastify framework pin from PPR-006 is unchanged).

**The routing split (the preview plane's shape)**: every `/console/*`,
`/trust/*`, `/admin/*` path, the root `/` and the composition's own
static asset `/assets/client.js` route to the experience function;
EVERY other path routes to the existing API function (PPR-006's
entry), unchanged in behavior — the API plane's route table is
untouched, and the API serves no `/assets` path (the one added asset
rewrite changes no API route). The dashboard's non-experience paths
(`/runs`, `/build`, `/agents`, ...) honestly fall through to the API
function under this split — the work order's explicit contract.

**The routing mechanism (the platform's documented shape, verified
against the current Vercel documentation — URLs + dates recorded in
`deploy/evidence/ppr-007.json`)**: `vercel.json` `rewrites` is the
platform's sanctioned same-application routing layer for a framework
build, and a rewrite to a Serverless Function CONVERTS the source path
captures into QUERY PARAMETERS on the destination (the documented
`/resize/:width/:height` → `/api/sharp?width=800&height=600`
conversion). The routing table therefore carries the ORIGINAL
experience path in the `path` query parameter:

```json
{ "source": "/console/:path*", "destination": "/api/experience?path=/console/:path*" }
```

and `deploy/experience.ts`'s `experienceRequestPath` reconstructs the
original path before the dashboard dispatch (on a local rail the
requests arrive with their original paths and pass through
unchanged). The known platform fact from PPR-006's live run is
respected: `functions` patterns only match Serverless Functions inside
the `api` directory — the routing needs no `functions` key at all.

**The module-loading correction covers BOTH function graphs**: the
framework build's tsc transpilation emits ES-module syntax for every
graph it transpiles (the platform fact PPR-006's live run discovered —
§13.1), so `deploy/build-vercel-output.ts` now corrects EVERY function
directory of the emitted `.vercel/output` (the ESM specifier
resolution, the per-function-root `{"type": "module"}` marker, and the
fail-closed verification), and REFUSES a build whose required function
set is missing (the routing contract requires both `index` and
`api/experience`). The correction core is `deploy/vercel-output.ts`
(testable without Vercel credentials — the synthetic-fixture proof of
`tests/unit/deployment/vercel-output.test.ts`; the live build is the
Lead's credentialed run).

### 13.5 The experience deployment contract (environment variables — NAMES only)

Set these on the Vercel project (`zeck-preview-main`) for the
experience function (the variable contract is
`deploy/manifests/variables.json` +
`deploy/manifests/secret-references.json`; values never transit this
repository):

| Variable | Role |
|---|---|
| `ZECK_EXPERIENCE_API_URL` | the API plane base URL the experience function projects through — the SAME ORIGIN in the preview (`https://zeck-preview-main.vercel.app`); required, fail closed (an experience surface with no API to project is a structural misconfiguration) |
| `ZECK_EXPERIENCE_APPLICATION_ID` | the application whose scope authorizes the console's scoped reads (the canonical `X-Zeck-Application` selector); required, fail closed (a scopeless dashboard cannot exist by construction) |
| `ZECK_EXPERIENCE_TOKEN` | the materialized transport credential of the console's reads (materialized from `ZECK_SECRET_EXPERIENCE_TOKEN_REF`); MAY BE UNBOUND — see the honest unbound mode below |
| `ZECK_SECRET_EXPERIENCE_TOKEN_REF` | the environment-scoped reference URI of the experience transport credential (`zeck-secret://<environment>/experience-token`) — distinct from `ZECK_SECRET_EXPERIENCE_DEPLOY_TOKEN_REF` (the Vercel DEPLOYMENT credential) |

**The honest unbound mode (the designed degradation)**: when
`ZECK_EXPERIENCE_TOKEN` is absent or empty the experience surface
STILL SERVES. The console's no-read pages (home, catalog, playground
disclosures, validation lab, docs) render their designed 200 states;
the reading pages render their designed permission-denied states over
the API's honest 401 `AUTHENTICATION_FAILED`; the machine JSON views
compose from the disclosed recents (an empty list without cookies).
NOTHING fabricates: no data, no credential, no synthetic projection.
The entry fails closed ONLY on structural misconfiguration (a missing
API URL or application id).

### 13.6 The operator sequence for the experience surface (the Lead's credentialed run — the §13.3 chain extended)

After merging PPR-007, set the experience variables above on the
Vercel project (Production environment; `ZECK_EXPERIENCE_TOKEN` may
stay unbound — the honest mode is the sanctioned initial state), then
build and deploy BOTH functions through the committed pipeline and
verify:

```bash
# 1. the deployment contract variables (§13.2 + §13.5) are set on the project
# 2. build (the platform's own build + the two-function correction):
bun run deploy:build-vercel-output
# 3. the local artifact proof for BOTH functions:
#    cd .vercel/output/functions/index.func && ZECK_ENVIRONMENT=preview \
#      ZECK_DEPLOY_GIT_REVISION=<rev> VERCEL_GIT_COMMIT_REF=main node server.js
#    cd .vercel/output/functions/api/experience.func && \
#      ZECK_EXPERIENCE_API_URL=<plane-url> ZECK_EXPERIENCE_APPLICATION_ID=<scope> \
#      node api/experience.js
# 4. deploy the corrected output:
vercel deploy --prebuilt --prod
```

Then re-run the journey harness against the public URL for the
experience surface's acceptance: the 10 experience-surface journey
steps and the 22 workload-family disclosures that F1 recorded as
honestly not-served must now record their served states (the harness
audits the served HTML's structural dimensions — the availability
disclosure, the responsive plan, the resource integrity including
`/assets/client.js`, the navigation graph), and the API plane's own
acceptance (`deploy:public-smoke --url <public-url>`) must stay green
(the API side of the split is unchanged).

### 13.7 Correction #8 — the live credentialed run's residual findings (2026-09-23)

The §13.6 credentialed journey re-run against revision `3e9ec7a`
(`https://zeck-preview-main.vercel.app`, identity gate verified at the
exact revision, the 10 experience-surface steps and all 22 family
disclosures SERVED) recorded three residual findings; all three are
fixed at their truth sources:

1. **THE DEAD ROOT REWRITE** (the routing layer's platform fact). The
   `vercel.json` rewrite `{"source": "/"}` never fired on the
   platform: the framework build's root `index.func` is a FILESYSTEM
   match for `/`, and `rewrites` run AFTER the filesystem phase — `/`
   answered the API plane's Fastify 404 JSON while `/console` served
   the experience composition. The correction: the root now lands
   through a `redirects` entry (redirects run BEFORE the filesystem
   phase) — `/` → `307` → `/console` → the experience function's
   composition. The dead rewrite is removed and the routing-split
   truth-table pin
   (`tests/unit/deployment/experience-adapter.test.ts`) carries the
   platform fact.

2. **THE CACHED COLD-START SEEDING FAILURE** (the isolate's
   availability; §14.1's gate). The preview authority gate seeded ONCE
   per isolate and cached the failure: a single transient relational
   failure at cold start — the Neon free-tier autosuspend wake-up
   racing the isolate's first connect ("Connection terminated due to
   connection timeout") — permanently degraded that isolate (every
   authority-dependent route answered 502 `PROVIDER_ERROR`) while
   `GET /health`, an independent probe, reported the dependency
   reachable again. The correction (`deploy/preview-authorities.ts`):
   every FAILED seeding attempt is replaced with exactly one new
   attempt on the next `awaitReady()` call (concurrent callers share
   the in-flight replacement); the seeding is runtime-idempotent and
   the identical policy republish converges, so every retry either
   converges on the same rows or fails closed again with the honest
   `PROVIDER_ERROR`. The real-rail proof is
   `tests/integration/postgres/preview-authorities.test.ts`'s
   refusing-port → TCP-bridge → retry-converges test.

3. **THE UNMATERIALIZED EXPERIENCE TOKEN** (the projection's
   credential). `ZECK_EXPERIENCE_TOKEN` was never materialized on the
   project (only `ZECK_SECRET_EXPERIENCE_TOKEN_REF` existed) — the
   experience function served §13.5's honest UNBOUND mode and the
   reproducibility bundle (the projection's credentialed read)
   rendered the designed 403 "Not authorized" page. The correction is
   environment-only (no repository change): the token is materialized
   as the preview transport credential (§14.1's sanctioned binding
   path — "the Lead's directly-materialized token"), and
   `ZECK_EXPERIENCE_APPLICATION_ID` points at the MATERIALIZED preview
   application (`ZECK_PREVIEW_APPLICATION_ID`'s application — the one
   whose durable scope the preview authorities seed; the canonical
   local-rail id pinned in the integration test remains the local
   plane's own scope, unchanged). The bound mode is the sanctioned
   evolution of §13.5's "MAY BE UNBOUND" initial state.

## 14. The preview credential issuance & the deterministic sandbox substrate (PPR-008)

The bootstrap composition (`deploy/api.ts`'s `buildBootstrapApp` — the SAME
shared builder the CLI host and the Vercel hosting adapter compose) now
binds the REAL domain seams when — and only when — the environment
MATERIALIZES the preview authority set. Any missing piece leaves exactly
the honest unbound bootstrap of §13 (the 401/422 vocabulary, the identical
route table, local/dev behavior unchanged — both shapes are pinned by
`tests/unit/deployment/preview-authorities.test.ts`). The boot document
reports the derived `composition.authorityMaterialization` fact: which
authority set served, and which variable NAMES are absent when unbound
(never values). The evidence record of this layer is
`deploy/evidence/ppr-008.json`.

### 14.1 The materialization gate (the environment contract)

| Variable | Role |
|---|---|
| `ZECK_DATABASE_URL` (or `ZECK_PG_ADMIN_URL` on the local environment — exactly the value `/health`'s relational-state probe consumes) | the relational authority the whole bound set composes over (the Neon DatabasePort; the same materialized value §13.2 already contracts) |
| `ZECK_TRANSPORT_TOKEN` | the materialized value of the environment's `transport-token` secret (the Lead's directly-materialized journey token; credential-shaped — environment-only storage, never committed, never logged; the composition compares it in constant time and never echoes it) |
| `ZECK_PREVIEW_APPLICATION_ID` | the preview application id (a UUID) whose durable scope the materialized authorities bind |

The reference binding `ZECK_SECRET_TRANSPORT_TOKEN_REF`
(`zeck-secret://<environment>/transport-token`) and the two value variables
are contracted in `deploy/manifests/variables.json` +
`secret-references.json`. When all three values are present,
`deploy/preview-authorities.ts` constructs over the real `DatabasePort`:

- **bearer authentication** — `createBearerTokenAuthenticator` over the
  materialized token → the SEEDED transport principal, governed by the
  DURABLE credential row (revoking that row genuinely disables the token);
- **SQL scope resolution** — the scope resolver over the SQL identity store
  (durable membership rows are the only scope producer, exactly as
  everywhere else in the platform);
- **the credential lifecycle service** — `POST/GET /credentials` +
  rotate/revoke over the real SQL stores and idempotency ledger;
- **the execution service** — the SQL execution store + idempotency +
  the REAL policy admission authority (a published baseline unrestricted
  set — the same production composition `tests/integration/postgres/`'s
  agents world wires; without a published set the authority denies by
  default and no execution could ever run);
- **the agents inventory** — the SQL registry + the read-only enumeration
  seam.

Economics and codebase analysis STAY honestly unbound (their routes keep
§13's 422s) — no model credentials exist on this plane, by design.

### 14.2 How a transport credential is issued/bound on the preview

There are two paths, and both are real:

1. **The Lead's directly-materialized journey token (the binding path on
   the preview).** Set the reference + materialized value + application id
   on the deployment (§14.4) and redeploy: on every cold start the
   composition's IDEMPOTENT SEEDING converges the durable rows — the
   tenant, the preview application (the env's id), the transport
   principal + its OWNER membership, the substrate worker principal + its
   membership, and the transport credential row (ACTIVE, referencing
   `zeck-secret://<environment>/transport-token` — the material lives only
   in the deployment environment, never in the record). All seeded
   identities are deterministic functions of the application id, so
   re-running the seed yields the SAME rows (`ON CONFLICT DO NOTHING`
   guarded inserts; safe under concurrent isolates; run-twice-same-rows is
   pinned on the real rail by
   `tests/integration/postgres/preview-authorities.test.ts`). Revoking the
   transport credential through `POST /credentials/:id/revoke` is the REAL
   lifecycle: the durable row turns `revoked` and the token stops
   authenticating (pinned on the real rail). Revocation is terminal — a
   cold start never resurrects a revoked credential; re-binding after
   revocation means binding a fresh `ZECK_PREVIEW_APPLICATION_ID`.

2. **The `POST /credentials` lifecycle over the materialized authority.**
   The routes are bound (no more 422 "not wired"): `GET /credentials`
   lists the real durable rows and carries the deployment's issuance gate
   fact; `POST /credentials/:id/revoke` performs the real, idempotent
   revocation. On the preview, `issue` and `rotate` answer DEP-011's
   honest issuance-gate 422 (`CAPABILITY_UNAVAILABLE`: "credential
   issuance is not enabled for this deployment") because the preview's
   only secret-store adapter is the environment materialization, which is
   READ-ONLY — the external provisioning plane materializes values; the
   platform never writes secrets into it, and the show-once contract
   (DEP-011 AC1) cannot be honored against a store that cannot hold the
   material. Opening the gate requires a deployment whose secret store can
   hold issued material (a durable secret-store adapter is a future Work
   Order's surface); the issuance path itself — issue → the show-once
   secret authenticates → rotate retires the predecessor and the successor
   secret works — is proven over the SAME SQL authorities on the real rail
   with an issuance-capable secret store (the canonical
   `tests/integration/postgres/credentials.test.ts` pattern), in
   `tests/integration/postgres/preview-authorities.test.ts`.

### 14.3 The deterministic sandbox substrate — what it is, and what it is not

`deploy/preview-substrate.ts` drives a CREATED execution to an honest
terminal receipt on the materialized plane — THROUGH the execution
service's own state machine (`authorize → plan → [the planning decision]
→ queue → start → [sandbox-admitted, sandbox-completed step events] →
verify → pass` with the PASS verification result), under its frozen
legality rules, its idempotency arbitration and its append-only gapless
ledger. There is NO bypass and no direct table write: the substrate is a
decorator over the real service whose post-create drive issues ordinary
governed commands with deterministic idempotency keys
(`substrate:<executionId>:<step>`), so replays and concurrent drives
converge on the same durable outcome, and the create response itself is
the terminal receipt.

**What it IS:** a repository-resident deterministic substrate. Every
record it produces is labeled `preview-deterministic-substrate` — the
execution metadata carries `substrateOrigin` (caller keys preserved),
every drive envelope carries the origin as its provenance cause, the
sandbox evidence envelopes record the immutable runtime metadata
(`runtime: "deterministic"`, `modelBacked: false`) and the truthful
zero-cost facts (`costMicroUsd: "0"`, zero usage), and the verification
result names the substrate as its strategy and recorder. The "output" is
a fixed deterministic function of the task record that says plainly what
it is (the summarize fixture states that no model was involved).

**What it is NOT:** not a model-backed execution (no model credentials
are bound on this plane — the economics and codebase-analysis seams stay
honestly unbound), not a planner, not a verification authority, and not a
second state machine. It engages ONLY the materialized composition — the
unbound local/dev shapes never see it. On this plane it drives EVERY
execution created through the public API (the preview plane IS the
sandbox; there is no other runtime behind it). The `/executions/:id/results`
cost summary stays `null` (the honest no-settled-facts projection: the
budgets settlement surface is unbound here) — the zero-cost facts live on
the ledger's `sandbox-completed` envelope, durable and inspectable
through `/executions/:id/events` (note the wire events surface applies
the platform's secret-scrub guard to token-shaped KEYS, so the usage
token counts appear as `[redacted]` on that projection while the durable
ledger keeps the true zero values).

### 14.4 The operator sequence (the Lead's credentialed run, after merge)

1. Materialize the authority set on the Vercel project (`zeck-preview-main`,
   Production environment — NAMES only; values never transit this
   repository): `ZECK_SECRET_TRANSPORT_TOKEN_REF`
   (`zeck-secret://preview/transport-token`), `ZECK_TRANSPORT_TOKEN` (the
   journey token material — credential-shaped, high-entropy), and
   `ZECK_PREVIEW_APPLICATION_ID` (a fresh UUID — e.g. `uuidv7`), alongside
   the already-contracted `ZECK_DATABASE_URL`.
2. Redeploy the merged `main` through §13.3's sanctioned path
   (`bun run deploy:build-vercel-output` → the local artifact proof →
   `vercel deploy --prebuilt --prod`).
3. Verify with §13.3's smoke; then verify the MATERIALIZED plane: the boot
   document's `composition.authorityMaterialization` fact reads
   `materialized (...)`, `/health` reports the relational authority ready,
   and the credentialed journey re-run records real outcomes:

   ```bash
   ZECK_JOURNEY_TOKEN=<the materialized token> \
   ZECK_JOURNEY_APPLICATION_ID=<the preview application id> \
   bun tests/journey/run.ts --url https://zeck-preview-main.vercel.app \
     --environment preview --branch main
   ```

4. To disable the credentialed journeys: revoke the transport credential
   through `POST /credentials/<credentialId>/revoke` (the real, terminal
   lifecycle effect — pinned on the real rail) or unset the
   materialization variables and redeploy (the honest unbound shape
   returns).

The worker never deploys and holds no Neon/Vercel credentials: every
live-Neon/live-Vercel step above is the Lead's credentialed run (the NOT
RUN registry in `deploy/evidence/ppr-008.json`).

### 13.8 The F1/F2 closure record (2026-09-23 — the roadmap's credential-bound tail executed)

The §13.6 chain is COMPLETE on the public plane after the credential
re-provision: the deployed plane `https://zeck-preview-main.vercel.app`
attests revision `a244e703d881fc2e` (bound, preview — deployment
`dpl_7eAJpHdgzLCrVcxWuVvj2LHFnv8X`, `ZECK_DEPLOY_GIT_REVISION`
re-pinned before the deploy so the plane attests the exact head).

**The acceptance**: the credentialed journey re-run at the exact
revision — `bun tests/journey/run.ts --url … --environment preview
--branch main --expected-revision a244e703…` — exits 0: 12 journeys /
28 steps (27 pass / 0 fail / 1 honest not-run), ZERO findings, the
identity gate verified. All 10 experience-surface journey steps PASS
with every audited dimension; all 22 workload-family disclosures are
SERVED (F1 closed). The credentialed execution gate PASSES over the
materialized preview authorities — a well-formed `POST /executions`
drives to terminal COMPLETED with verification PASS, every inspection
surface answers, and the reproducibility bundle exports as 200 JSON
through the materialized experience token (F2 closed).
`deploy:public-smoke --url …` exits 0: 26/26 routes honest (18
auth-boundary 401 / 3 capability-unbound 422 / 4 credentials seams ALL
materialized-composition 401 / 1 public-artifact 200), zero problems.

**The honest residual** (recorded, owned): the bare root `/` answers
`307 → /console` — the platform's filesystem-phase fact (the
framework's root function owns `/`; correction #8's redirects bridge)
— and the harness's `redirect: "manual"` URL-hygiene records the
honest not-run for an HTML landing at the bare root; browsers land on
the console composition. A redirect-following landing audit would be
its own harness-contract work order if ever wanted. The maturity
ladder's level-5+ drills (alternate-solution substitution, failure
drills, sustained production observation) remain future governed work
beyond this roadmap. The full chain evidence is
`deploy/evidence/f1-closure.json` (+ `f1-closure-journey.json` +
`f1-closure-smoke.json`).

### 13.9 The landing-audit addendum (PPR-011 — §13.7/§13.8's recorded residual, 2026-09-23)

§13.8's honest residual — "a redirect-following landing audit would be
its own harness-contract work order if ever wanted" — is now that work
order, delivered. The journey harness follows the plane's own redirect
bridge manually and audits the surface the newcomer actually lands on:

- **The chain follower** (`tests/journey/landing-chain.ts`): a bounded,
  same-origin, `redirect: "manual"` walker — `MAX_LANDING_REDIRECT_HOPS
  = 3` (the named budget; one fetch per hop, the start URL counted).
  Every hop's status + raw `Location` header is disclosed in the step
  evidence (`StepEvidence.location`): the 307 platform bridge is
  DISCLOSED, never masked — nothing is auto-followed by fetch.
- **The landed-surface audit**: an HTML chain terminal gets the EXACT
  direct-landing treatment (the full dimension audit + `titleOf`) over
  the chain's own terminal fetch — no second landing request is made;
  the direct-HTML path stays byte-equivalent (the shared
  `recordHtmlLanding`).
- **The honest terminal shapes**: a non-HTML terminal keeps the honest
  not-run, extended with the chain facts; a redirect LOOP or an
  over-budget chain is a FINDING (`defectClass "landing-chain"`,
  severity major — a real browser fails to land too; the closed
  defect-class vocabulary extends 14 → 15 with the harness-contract pin
  moved); a CROSS-ORIGIN hop stops the chain unfetched (out of audit
  scope, owner the Lead); a mid-chain transport failure is recorded as
  the landing-chain finding, never misclassified as a served terminal.
- **The proof**: the six-scenario fixture matrix
  (`tests/integration/journey/landing-audit.test.ts` — direct HTML,
  one-hop 307, two-hop 307, a redirect loop, an over-budget chain, a
  cross-origin hop) green alongside the harness-e2e local-plane suite
  on the PG rail; the full worker battery (typecheck 0 / lint at the
  exact 3+68+8 baseline / unit 362f-6375t / governance OK /
  `deploy:validate` valid at 97 variables) is
  `deploy/evidence/ppr-011.json`.
- **The live re-run** (the plane's `/` → `307 /console` bridge actually
  followed to the console landing) is the Lead's MEASURE step at the
  wave-F redeploy — honestly not-run until then.

### 13.10 The wave-F redeploy record (2026-09-24 — the quota-bound tail closed)

The wave-F §13.6 redeploy chain was first REFUSED (2026-09-24 ~02:00
UTC) at the team's free-tier rolling-24h deployment quota — the
program's first non-credential external boundary, honestly recorded
(the burn was mostly sibling projects in the team; the plane stayed
live and healthy at `a244e70`; the operator was notified through
outbox record 6). The rolling window was re-queried through the
deployments API before any re-attempt: at 05:44 UTC the in-window
count stood at 71 (capacity freed by the early-window aging) and the
chain was re-executed at the **exact governed head**:

- **Rebuild at the head** (the tree had advanced past the refused
  attempt's pin by the spec-only LEARN record): both function graphs
  corrected (index 105 files/355 specifiers; experience 178
  files/589 specifiers/803 data files — the +1 data file is the
  evo-006 observe record, the head legitimately reaching the
  artifact);
  `ZECK_DEPLOY_GIT_REVISION` re-pinned to
  `25e11f9c0b3c3a5cbb9e8c3bb5683949e73f5091` on **both** env targets
  before the deploy.
- **The two-function local artifact proof PASSED** at `25e11f9`:
  `/identity` bound (preview), `/health` the honest fail-closed 503
  without the materialized relational dependency, `POST /executions`
  the honest 422 Idempotency-Key boundary; the experience function
  honest-unbound (`tokenBound: false`) serving `/console` as HTML.
- **Deploy**: `vercel deploy --prebuilt --prod` —
  `dpl_4stUVFACDjVgSB6smGdZm6DKcVvn` aliased to
  `https://zeck-preview-main.vercel.app`; the `a244e70` → head
  revision lag is closed, and the plane now serves wave F's merged
  surface (the landing-audit-capable harness's own journey runner,
  the advanced dependency set — fastify 5.12.5 + pg 8.23.0 — and the
  composition auto-rebind policy).
- **The journey MEASURE re-run** (the credentialed live proof,
  `--expected-revision 25e11f9…`): **12 journeys / 28 steps — 28
  pass / 0 fail / 0 not-run** — the program's first journey record
  with ZERO not-runs — findings 0, all 22 workload-family
  disclosures SERVED, the identity gate verified at the exact
  revision. §13.9's promise is kept on the live plane:
  `discover-landing` now records *"307 / → /console (1 hop); HTML
  landing served (title: Zeck — Developer console) with every
  audited dimension passing"* — the follower walked the plane's own
  redirect bridge and audited the landed console surface.
- **The API plane acceptance** (`deploy:public-smoke`): EXIT 0,
  26 routes probed, zero problems (18 auth-boundary / 3
  capability-unbound / 4 materialized-composition seam / 1
  public-artifact), the honest-degraded health shape identical to
  the F1-closure precedent.

The master record is `deploy/evidence/wave-f-redeploy.json`; the
closure completes PPR-011's and PPR-012's live-plane notRuns (their
evidence deliveryNotes) and GAP-004's live rung. What remains open is
credential-bound only (§15's operator sequence: the LiveKit API
keypair; GAP-002's model families).

## 15. The LiveKit realtime rail (PPR-009 — the first REAL external RealtimeRail)

The provider-neutral `RealtimeRail` port (WORK-024/MOD-005) now has a
REAL external adapter: `src/modules/deployments/adapters/livekit-realtime-rail.ts`
implements the seam over a real [LiveKit](https://livekit.io) server
through the published, UNMODIFIED `livekit-server-sdk` package (no
fork). All vendor types stay inside the adapter; the port sees only
neutral shapes; the channel identity is a deterministic opaque hash of
the neutral coordinates (never user-provided strings verbatim).

**The conformance contract** (`tests/conformance/realtime-rail/`) is
the provider-independence proof: ONE suite (C1-C12 — neutral
descriptor vocabulary, opaque coordinates, key convergence on
open/deliver/transfer/close, exactly-once upstream effects including
through the crash-restart model, failure normalization with neutral
reasons and no cached refusals, secret hygiene, no fabricated
metadata) that the SIMULATED rail (the semantic reference) and the
LiveKit adapter BOTH pass. A new realtime provider codes against this
contract — never another vendor's SDK shapes.

**The honest availability state**: the LiveKit adapter is verified
ONLY against a LOCAL open-source `livekit-server` (label
`local-livekit-server`) — the conformance suite boots one on loopback
in `--dev` mode (the public development keypair) when the binary is
available (`ZECK_LIVEKIT_SERVER_BIN`, default `/tmp/livekit-server`;
the binary is the official `livekit_…_linux_amd64.tar.gz` release).
NO managed or production LiveKit availability is claimed or implied
anywhere; every external boundary is owned by a Lead credentialed
run (the evidence record's notRun registry).

**The environment contract** (append-only in
`deploy/manifests/variables.json` +
`deploy/manifests/secret-references.json`):

| Variable | Role |
|---|---|
| `ZECK_LIVEKIT_URL` | the LiveKit server base URL (non-secret; the open-source server) |
| `ZECK_LIVEKIT_API_KEY` | the server's API key (credential-shaped; materialized from `ZECK_SECRET_LIVEKIT_API_KEY_REF`) |
| `ZECK_LIVEKIT_API_SECRET` | the server's API secret (credential-shaped; materialized from `ZECK_SECRET_LIVEKIT_API_SECRET_REF`) |

**The composition gate** (the PPR-008 materialization-gate pattern):
`src/modules/deployments/adapters/livekit-realtime-rail-binding.ts`
binds the REAL rail only when the environment materializes the full
LiveKit credential set (URL + key + secret); any missing piece keeps
EXACTLY the simulated rail behind the same neutral seam (both shapes
pinned by tests). The adapter materializes the keypair INSIDE its own
scope immediately before upstream calls — never in a port shape, a
log line, or an acknowledgment.

**The idempotency design** (which mechanism where): OPEN and CLOSE
converge across full process crashes through the server's own
room-identity semantics (the channel name is a deterministic function
of the stable rail-level idempotency key; a re-open asks the server
whether the channel exists and converges); DELIVERY and TRANSFER (data
effects) converge through the ADAPTER's key ledger — the shipped
default is in-memory (retries and replays within the adapter process;
a durable ledger binding is the composition's concern, recorded as the
honest boundary in the evidence record).

**The short-lived client-access seam**: the adapter's
`mintClientAccess` issues a SHORT-LIVED (≤ the session policy's
ceiling; default 600s, hard ceiling 3600s) single-purpose (join, not
administer) client access grant for an OPEN, admitted rail session —
the descriptor is vendor-neutral (`RealtimeRailClientAccess`), the
grant value is vendor material by nature.

**The operator sequence for a future credentialed run** (the Lead's):
provision a LiveKit server (self-hosted or managed) → set
`ZECK_LIVEKIT_URL` + materialize the keypair from the environment's
secret references on the target environment → redeploy through the
§13.3/§13.6 pipeline → run the conformance suite + the realtime
journeys against the plane with real credentials → record the
credentialed evidence. Until then the honest state stands: local-rail
conformance green, external availability NOT RUN.

**The credentialed-run addendum (2026-09-23 — the participant-join
rung)**. The owner provisioned the managed plane and delivered the
endpoint + the API key ID + a PRE-MINTED short-lived (900s) participant
join grant — not the API keypair secret. The Lead's credentialed probe
(`scripts/lead-livekit-join-probe.ts`) proved the EXTERNAL
participant-join plane: the managed plane
(`wss://zeck-vuo9lv9v.livekit.cloud`, LiveKit server 1.13.7, region
Japan) authenticated the grant, materialized room `zeck`, admitted
participant `zeck`, and progressed the handshake through its WebRTC SDP
offer + ICE candidates (the join acknowledged in 219ms; a clean leave;
the full record in `deploy/evidence/ppr-009-live-join.json` — GAP-001's
external rung advances from NOT RUN to partially credentialed).
**Still honestly NOT RUN**: the admin/server-SDK rung and the FULL §15
sequence — the API keypair SECRET was not delivered (a join grant is
not a keypair and must never be written into the secret references as
one); the composition binding stays fail-closed exactly as designed;
no repeatable external journey exists (the 900s single-purpose grant
expired; no mint authority was delivered). The operator's next move to
close the rung: deliver the API keypair through the environment's
`ZECK_SECRET_LIVEKIT_API_KEY_REF` / `ZECK_SECRET_LIVEKIT_API_SECRET_REF`.

## 16. The alternate realtime rail + the substitution drill (PPR-010 — GAP-003's level-5 rung)

The provider-independence iron law (neutral capability port →
conformance contract → provider adapter → provider/project) now has
its SECOND REAL subject: `src/modules/deployments/adapters/socketio-realtime-rail.ts`
implements the same `RealtimeRail` seam over the published, UNMODIFIED
[`socket.io`](https://socket.io) server package (4.8.x, no fork),
EMBEDDING a real socket.io server in process (the honest self-hosted
form — the binding's `ZECK_SOCKETIO_URL` is the listen/attach
coordinate). All socket.io/engine.io types stay inside the adapter;
the port sees only neutral shapes; the channel identity is a
deterministic opaque hash of the neutral coordinates.

**The substitution/failover drill**
(`tests/conformance/realtime-rail/rail-substitution.drill.test.ts`)
is the maturity ladder's level-5 evidence (GAP-003: "no
alternate-solution substitution drills"): the SAME durable session
coordinates — the same neutral coordinates and the SAME stable
rail-level idempotency keys — drive BOTH genuinely different REAL
rails (the local `livekit-server` primary while the binary is
present; the embedded socket.io alternate, ALWAYS real); when the
primary is SIGSTOP-refused, the coordinates REPLAY against the
alternate and converge: exactly-once upstream effects PER RAIL,
identical neutral acknowledgment shapes, the five shared failure
kinds carrying the EXACT same neutral reason strings on both rails.
**Explicitly out of scope** (the drill's honest residual): the
COMPOSITION-level auto-rebind policy — a preference order and
automatic failover inside the composition touches the frozen
admission ordering and can mask failures; this drill proves the
SEAM-level substitutability any such policy would rest on, never the
policy itself.

**The honest availability state**: the socket.io rail is verified
ONLY against its own LOCAL embedded server (label
`local-socketio-server`) — a real WebSocket server (real handshakes,
real rooms, real acknowledgments, real "went away" failure modes) on
loopback inside this repository's suites. NO external, managed or
production socket.io availability is claimed or implied anywhere;
every external boundary is owned by a Lead credentialed run (the
evidence record's notRun registry).

**The environment contract** (append-only in
`deploy/manifests/variables.json` +
`deploy/manifests/secret-references.json`):

| Variable | Role |
|---|---|
| `ZECK_SOCKETIO_URL` | the rail's listen/attach coordinate (non-secret; the embedded server binds it) |
| `ZECK_SOCKETIO_AUTH_SECRET` | the rail's handshake-auth secret (credential-shaped; materialized from `ZECK_SECRET_SOCKETIO_AUTH_SECRET_REF`) |

**The composition gate** (the established materialization-gate
pattern): `src/modules/deployments/adapters/socketio-realtime-rail-binding.ts`
binds the REAL alternate rail only when the environment materializes
its set (URL + auth secret); any missing piece keeps EXACTLY the
simulated rail behind the same neutral seam (both shapes pinned by
tests). The gate binds ONE rail — it never auto-fails-over (the
recorded residual above). The adapter materializes the secret INSIDE
its own scope immediately before upstream calls — never in a port
shape, a log line, or an acknowledgment.

**The idempotency design** (which mechanism where): OPEN and CLOSE
converge across full ADAPTER crashes WITHOUT any ledger because the
channel's room name is a deterministic function of the stable key and
the channel registry lives SERVER-side (the embedded server — or any
socket.io server the adapter attaches to — survives the adapter
instance); DELIVERY and TRANSFER (room-emit effects) converge through
the ADAPTER's in-memory key ledger AND the rail protocol's own
server-side key semantics. A durable ledger binding remains the
composition's concern, recorded as the honest boundary in the
evidence record (the PPR-009 residual, unchanged).

**The delivery semantics** (honest): an EMPTY room completes the
broadcast vacuously (exactly like publishing to a room with no
participants); receivers present in the room that fail to acknowledge
within the bounded window fail `no-receiver` (the socket.io seam's
own honest condition).

**The short-lived client-access seam**: the adapter's
`mintClientAccess` issues a SHORT-LIVED (≤ the session policy's
ceiling; default 600s, hard ceiling 3600s) single-purpose (join, not
administer) HMAC-signed join grant redeemable in the socket.io
handshake auth payload — scoped to ONE channel, expiring, honored
only while that channel is open; the descriptor is vendor-neutral
(`SocketIoRailClientAccess`), the grant value is vendor material by
nature.

**The operator sequence for a future credentialed/managed run** (the
Lead's): provision a socket.io-compatible realtime server reachable
from the plane (or accept the embedded self-hosted form) → set
`ZECK_SOCKETIO_URL` + materialize the auth secret from the
environment's secret reference on the target environment → redeploy
through the §13.3/§13.6 pipeline → run the conformance suite + the
realtime journeys against the plane → record the credentialed
evidence. Until then the honest state stands: local-rail conformance
green (all THREE subjects), the drill green, external availability
NOT RUN.

## 17. The composition auto-rebind policy (PPR-013 — PPR-010's deferred residual)

**The env contract is DERIVED, not extended**: the policy adds ZERO
environment variables and ZERO manifest entries. It composes the two
existing materialization gates (§15's LiveKit set: `ZECK_LIVEKIT_URL`
+ `ZECK_LIVEKIT_API_KEY` + `ZECK_LIVEKIT_API_SECRET`; §16's socket.io
set: `ZECK_SOCKETIO_URL` + `ZECK_SOCKETIO_AUTH_SECRET`) into a
preference order: the LiveKit set materializes ⇒ PREFERRED, the
socket.io set ⇒ ALTERNATE, only-socket.io ⇒ the alternate stands
alone, NOTHING ⇒ EXACTLY the simulated terminal fallback of §15/§16
(the in-process rail behind the same neutral seam, no policy in
effect). Composition consumers bind
`bindEnvironmentRealtimeRailWithRebind` (exported through the
deployments barrel) instead of a single gate.

**The bounded-failover semantics**: per `openSession` invocation, on a
RETRYABLE normalized failure (the neutral `PlatformError` vocabulary
both real rails normalize onto) from the preferred rail, AT MOST ONE
re-bind onto a MATERIALIZED alternate under the SAME coordinates and
the SAME stable rail-level idempotency key — the §16 drill's proven
convergence (exactly-once per rail). The alternate's answer returns
through the same neutral shapes, and the serving rail's own
`railCapabilityId` is the honest disclosure (the composed rail's
descriptor names the rail that served the most recent open; the
binding-level `servedBy`/`rebinds` accessors carry the per-session
truth). NON-retryable failures (authentication, not-found) NEVER
re-bind — an authentication failure is not a capacity event, and
masking it would violate the honest-failure discipline. When the
alternate also fails, its normalized failure surfaces with the
preferred's retained as the cause. There is NO failover onto the
simulated rail — a fake is never a substitution for a dead real rail.

**No mid-session flapping**: a session lives on the rail that opened
it — `deliverTurn`/`transferCall`/`closeSession` follow a per-session
affinity record; only `openSession` may re-bind, and every new open
starts at the standing preference (a recovered preferred is retried,
never permanently failed over). The honest boundary: the affinity
record is in-memory per binding instance — a post-crash frame for a
ref the current process never opened routes to the standing preferred
and fails neutrally there; the durable cross-rail ledger that would
close this remains PPR-009's recorded residual.

**The honest availability state**: the policy's real-rail evidence is
LOCAL-real (a dead preferred LiveKit endpoint re-binding onto the REAL
embedded socket.io server; the §16 drill extended through the policy
seam with the REAL local livekit-server refusing for real). No
live-plane failover has run — that rung belongs to the Lead after a
real rail binds on the deployed plane, per the §13.6/§15/§16 operator
sequences. No composition consumer binds a realtime rail today; the
binding ships ready for the composition root through the additive
barrel exports.
