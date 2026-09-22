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
