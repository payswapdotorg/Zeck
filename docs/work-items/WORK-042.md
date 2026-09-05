# WORK-042 Evidence — Reproducible deployment infrastructure foundation

Work Order: `WORK-042` (spec/work-orders/WORK-042.md) · Canonical remote: **`payswapdotorg/Zeck`** · Canonical issue: **#1** · Assurance: **HIGH_ASSURANCE** · Requirement IDs: N/A (deployment architecture foundation; acceptance governed by D1.0 and the checkpoint contracts below) · Governing architecture: Deployment & Runtime Architecture **D1.0**, subordinate to frozen v1.0.

Exact dispatch base: `6bbb76e17ec17de41141db6ef9d41a641ea5cdb4` (verified present; the worker branch was created at exactly that SHA — 0 commits ahead / 0 behind at start; canonical `main` has since advanced to `d2cdb25` through nine post-dispatch documentation commits, which are NOT part of this branch). Branch: `work/WORK-042-deployment-infrastructure-foundation` · **Final head: this doc's commit** (the last code commit, `cb728e2`, precedes it) · Zero merge commits; the merge-base is `6bbb76e…` exactly. PR: **#2** (the single PR for this branch; the worker does not merge it).

**Provenance disclosure (fork continuity):** this implementation was developed against the identical dispatch base on the historical upstream repository (`pectoraux/Zeck`, its PR #76 — reference only, not authoritative per `docs/FORK-CANONICAL-REMOTE.md`) and is re-submitted here against the canonical remote. The implementation tree is byte-identical to that reference (the manifest digest below matches the historical submission exactly). Every verification recorded in THIS document was re-executed in this worker environment at this branch's exact revisions — no historical evidence is claimed as current.

## Baseline gate at the exact frozen base (readiness checkpoint — BEFORE implementation)

- **`python3 scripts/governance-check.py` FAILED at the dispatch base** — and at canonical main `d2cdb25` identically: `program-state and dependency-state have different Work Order identities` (program-state registers 42 Work Orders, dependency-state 41). Root cause (traced over the dispatch-commit sequence, identical in this fork's history): the dispatch automation added WORK-042 to `program-state.json` (`375aee5`), `work-items.md` (`cc3cea6`), `dependency-graph.md` (`07c2221`) and `frontier-state.json` (`6bbb76e`), but **`spec/development-state/dependency-state.json` never received the WORK-042 entry** (`git log -S 'WORK-042' -- spec/development-state/dependency-state.json` is empty). This is an **Architect-owned state defect — report-only, never worker-fixed** (the binding rule "Worker must not modify `spec/development-state/*` during active work" — Work Order Dispatch Record, canonical issue #1, AI_CONTINUATION non-negotiables). The one-line fix is the Architect's: add the WORK-042 dependency entry to dependency-state.json. Until then, the repository's automated governance gate cannot be green on this lineage — **no green governance-gate claim is made here**.
- `bun run typecheck` — 0 errors at `6bbb76e`.
- `bun run lint` — biome clean (973 files) at `6bbb76e`.
- Full suite with real PostgreSQL (`ZECK_PG_TEST_URL`, PG 16.4 at 127.0.0.1:55432) at exactly `6bbb76e`: **284 files / 4179 tests, 4177 passed, 2 failed** — the ONLY two failures are the inherited governance-state defect above (`tests/integration/fresh-clone-governance.test.ts` and the `governance-gate.discrimination` negative control, both failing on the same missing dependency-state entry). Zero other failures — the pre-change baseline is otherwise exactly reproduced. (The suite was executed as the three sequential script invocations `test:unit`, `test:integration`, `test:architecture` — the same complete test set as `bun run test`; this sandbox enforces a per-command wall-clock limit. 144+67+73 files, 2369+781+1029 tests.)

## Provider account/resource access (readiness checkpoint)

**NOT RUN — no Composio workspace key or provider credential exists in this worker environment.** The only credential held is the operator-provided GitHub personal access token for `payswapdotorg/Zeck` (environment-only: stored in the worker shell and credential store, never in Git, logs, artifacts or this repository; used solely for the Git/PR lifecycle of this Work Order). Work Order issue #1 permits Composio-connected provider accounts for provisioning/verification, but no such connection material is available to this worker, so **provider-account state verification was not executed and no provider-account state is claimed in any direction**. For historical context only (not authoritative here): the equivalent check on the historical upstream submission found no Vercel/Neon/Cloudflare/Upstash connections existed for non-interactive worker use either.

Classification per Work Order Implementation Requirement 1: provider-account connection states are **external states that cannot be reproduced from the repository**. The repository-truth manifests define the exact topology, names, ownership and secret-reference contract; the `deploy:bootstrap` plans for provider environments mark `executable: false` until every secret reference is materialized (fail closed — no half-provisioned state), and `deploy:smoke` for provider environments reports the authoritative relational concern as unattested (DOWN) until the D-02+ adapter phase provisions and verifies it. **No provider resource was mutated in any non-GitHub account; no Vercel/Neon/R2/Queues/Workflows/Redis resource state is claimed.**

## What this order IS

The D-01 foundation: the repository becomes the single, reproducible source of truth for deployment configuration — five typed, cross-validated manifests; deterministic computed naming; a content-addressed deployment identity; a control-plane/dependency readiness model with fail-closed PostgreSQL authority; an environment contract with runtime secret-reference checks; idempotent local bootstrap/teardown; the `/health` transport seam; and CI that validates the configuration and emits the exact-revision deployment identity.

## What changed (the surface diff — every file)

35 files (34 at the code commit `cb728e2` + this evidence document), cross-checked against `git diff --name-only 6bbb76e..HEAD`:

**New: the repository-resident deployment configuration (D1.0's "infrastructure-as-code must be versioned in the repository")**
- `deploy/manifests/environments.json` — the four D1.0 environment classes (local/preview/staging/production), disposable/persistent classes, teardown policy, credential scope, promotion ladder `local>ci>preview>staging>production`
- `deploy/manifests/providers.json` — the concern→provider map: six concerns (neon relational-authority, cloudflare-r2 bytes, cloudflare-queues transport, cloudflare-workflows orchestration, upstash-redis coordination, vercel delivery), each with owning port (`established` with its real port-contract path, or `planned` with its D-03/D-04 roadmap phase), substitution target, and explicit degradation entry (the relational concern is `fail-closed`; exactly one authoritative provider — validated)
- `deploy/manifests/resources.json` — the per-environment resource inventory (local: 3; preview: 6 per-branch; staging/production: 7 each) with naming constraints per kind; names are NEVER stored — computed
- `deploy/manifests/secret-references.json` — the environment-scoped `zeck-secret://<environment>/<name>` inventory (local: 1 reference; preview/staging/production: 8 each), classifications, `ZECK_SECRET_*_REF` variable mapping
- `deploy/manifests/variables.json` — the non-secret variable contract (19 variables incl. the `ZECK_SECRET_*_REF` family cross-checked against the inventory, `ZECK_ENVIRONMENT` required, credential-shaped variables classified environment-only)
- `deploy/README.md` — the reproduction instructions (AC1's "without undocumented console steps"; the remaining operator steps classified as provider-account metadata)

**New: the platform configuration/bootstrap seams (declared surface: src/platform/ configuration/bootstrap seams only where directly required)**
- `src/platform/deployment/manifest.ts` — typed loader + fail-closed validator (schema versions; environment matrix; single-authoritative-relational invariant; degradation completeness; port status; kind/concern coverage; reference/variable cross-contract)
- `src/platform/deployment/naming.ts` — THE single naming authority: deterministic names from (environment, kind, preview slug), provider-constraint validation at computation time
- `src/platform/deployment/identity.ts` — the pure deployment identity (sha256 over revision+environment+manifest digest+resource digest; verification detects drift/tampering)
- `src/platform/deployment/readiness.ts` — control-plane vs dependency readiness; authoritative-not-ready ⇒ DOWN; non-authoritative ⇒ explicit degraded mode; redacted diagnostics
- `src/platform/deployment/env-contract.ts` — environment contract evaluation: required variables; reference-URI-shaped values ONLY (plaintext rejected); cross-environment references rejected; output structurally value-free

**New: the deterministic tooling (idempotent, zero new dependencies — `pg` is the existing pinned devDependency, used by the tools as test infrastructure already is)**
- `deploy/lib.ts` — root resolution (import.meta.url, never CWD), exact-revision source, the secret-plaintext scan, port-contract/roadmap-phase checks
- `deploy/validate.ts` — the configuration validation gate (manifests, naming for every environment, port contracts, roadmap phases, secret scan)
- `deploy/bootstrap.ts` — local convergence (create-or-skip PostgreSQL `zeck_local`, object-store root, Redis declared/absent) — idempotent; provider environments: deterministic plan + secret-reference preconditions, `executable` only when fully materialized
- `deploy/teardown.ts` — classification-guarded: persistent environments REFUSED (exit 3) regardless of flags; local teardown touches exactly the computed database name and the computed directory under the local data root; preview teardown is plan-only
- `deploy/smoke.ts` — readiness + exact-revision identity attestation; exit 0 = ready (or degraded with `--allow-degraded`); DOWN fails closed regardless
- `deploy/identity.ts` — deterministic identity emission (pure; two runs at the same revision are byte-identical — verified below and asserted by CI)

**Modified: the API transport (declared surface: deployment health/readiness probes)**
- `src/api/server.ts` — `ApiServerDeps.dependencyReadiness` (injected probe seam; transport reports, never computes) + health-route registration
- `src/api/routes/health.ts` — `GET /health`: the control-plane/dependency distinction on the wire; authoritative not-ready ⇒ 503; non-authoritative ⇒ 200 + status degraded + degraded mode; credential-shaped values scrubbed; probe failure ⇒ fail-closed 503 with no internals

**Modified: the automation and toolchain contracts (declared surfaces)**
- `.github/workflows/deployment-validation.yml` — NEW: PR/push job with PostgreSQL 16 + Redis 7 services: validate → bootstrap (×2, asserting the idempotent re-convergence) → smoke (the READY path with Redis) → identity emission (twice, diffed) as step summary + artifact. Additive; `governance.yml` untouched
- `package.json` — five `deploy:*` scripts (superset by design, per the toolchain-contract test's own comment)
- `tsconfig.json` / `biome.json` — `deploy/**` added to the typecheck/lint surface (the tooling is gated like all other code)

**Tests (new + narrow updates to three construction sites)**
- `tests/unit/deployment/manifest.test.ts` (real-manifest contracts + 10 fail-closed synthetic mutations)
- `tests/unit/deployment/naming.test.ts` (the deterministic name table; slug sanitation; drift rejection)
- `tests/unit/deployment/identity.test.ts` (purity, sensitivity to revision/environment/slug/manifest-content, tamper detection)
- `tests/unit/deployment/readiness.test.ts` (the distinction matrix; fail-closed authority; degraded modes; redaction proofs; HTTP mapping)
- `tests/unit/deployment/env-contract.test.ts` (satisfied/missing/mismatch; plaintext rejection; cross-env rejection; structural value-freedom)
- `tests/unit/api/health.test.ts` (8 route tests: 200/503 semantics, degraded mode, scrub proofs, probe-failure fail-closed, route-table pin)
- `tests/integration/deployment/bootstrap-smoke.test.ts` (10 real-PG tests driving the REAL tools as subprocesses: hermetic convergence, idempotence, teardown/recovery, classification-guard refusals with authoritative state verified untouched, non-executable provider plan, fail-closed smoke on unreachable authority, degraded-without-flag exit 1, deterministic identity)
- `tests/discrimination/deployment-foundation.discrimination.test.ts` (16 HIGH_ASSURANCE mutation proofs — see the discrimination section)
- `tests/architecture/public-surface.test.ts`, `tests/unit/api/world.ts`, `tests/integration/postgres/api-world.ts` — the `dependencyReadiness` seam added to the three `createApiServer` construction sites; the M21 route-table pin gains `GET /health` (one line)

**Evidence**
- `docs/work-items/WORK-042.md` — this document

NO file under `src/modules/` (domain authority untouched — rg-verified: zero infrastructure provider identifiers in the domain tree), NO change to `spec/development-state/*` (untouched — the inherited governance defect is REPORTED, not fixed), NO new runtime dependency, NO migration, NO frozen-architecture edit, NO second deployment authority (the `/deployments` module is untouched; this foundation is configuration + platform seams + transport reporting only).

## Acceptance-criteria mapping (the Work Order's AC1–AC10)

- **AC1** (fresh checkout reproduces the resource configuration without undocumented console steps) — `deploy/README.md` + the five manifests + the deterministic tools: a fresh checkout validates (`deploy:validate`), converges local (`deploy:bootstrap --environment local`), attests (`deploy:smoke`) and emits identity (`deploy:identity`) with nothing but Bun + PostgreSQL (+optional Redis); the remaining provider-console steps are documented and explicitly classified as provider-account metadata that cannot be reproduced from the repository.
- **AC2** (deterministic names/labels and environment ownership) — names are computed, never stored: `zeck_local`, `zeck-staging`, `zeck-staging-artifacts`, `zeck-preview-<slug>-executions`, `zeck-production-redis`, … (the full table in `tests/unit/deployment/naming.test.ts`); ownership labels `zeck.io/environment`/`zeck.io/managed-by` computed per environment; provider constraints validated at computation time (drift throws).
- **AC3** (environment separation; production credentials never reusable in non-production) — four explicitly named classes with per-class credential scope; reference namespaces are environment-scoped URIs (`zeck-secret://production/…` is unreachable from staging — the environment contract REJECTS cross-environment references, proven by unit + discrimination tests); the manifest loader rejects persistent environments that allow teardown.
- **AC4** (secret references only; no plaintext committed or returned) — the secret-scan over manifest sources (validate + discrimination); the runtime reference-shape checks (plaintext in a `ZECK_SECRET_*_REF` variable is rejected fail-closed); the readiness/health outputs scrub credential-shaped content (unit + route tests); credential-shaped variables classified environment-only. `git grep` for credential material in the diff: none (the worker's GitHub token lives only in the worker environment).
- **AC5** (provider-neutral Zeck ports/contracts, not domain dependencies) — the provider map binds each concern to its owning platform port (`database`, `object-storage`, `redis`, `secret-store`, `config`, `api-transport`) or a declared D-03/D-04 planned port; the discrimination suite proves the domain tree contains ZERO infrastructure provider identifiers and that provider names live only in the deployment configuration data.
- **AC6** (health/readiness distinguish control plane from dependency readiness; no secret-bearing diagnostics) — the platform readiness model + `GET /health`: the route answering IS the control-plane fact; dependencies arrive via the injected probe; the distinction is asserted on the wire (200-degraded vs 503-down vs control-plane-unavailable); scrubbed diagnostics proven by tests injecting credential-bearing details.
- **AC7** (CI validates configuration, deterministic smoke, auditable identity for the exact revision) — `deployment-validation.yml`: validate → idempotent bootstrap (×2) → smoke (PG16+Redis7 services) → identity emitted twice and diffed, uploaded as an artifact named with `github.sha`; the identity itself is content-addressed over the exact revision + manifest digests.
- **AC8** (teardown/recreation of disposable resources without corrupting authoritative state) — proven over real PostgreSQL by the integration suite: convergence, idempotent re-convergence, teardown of exactly the computed names, recreation, and the classification guard REFUSING staging/production teardown (exit 3) with authoritative state verified untouched after the refusal.
- **AC9** (explicit degraded modes; PostgreSQL authority failure fails closed) — the degradation table in providers.json covers every concern (loader-validated); readiness tests prove relational-unavailable ⇒ DOWN (and even relational-degraded ⇒ DOWN), non-authoritative failure ⇒ explicit mode; the smoke tool exits non-zero on DOWN regardless of flags; the manifest loader REJECTS a weakened (non-fail-closed or demoted) relational provider.
- **AC10** (evidence: exact revisions, configuration, environment matrix, secret-reference checks, smoke, changed-file inventory) — this document + the PR body + the PR comment (the three-layer chain).

## Discrimination evidence (HIGH_ASSURANCE — every weakened protection is rejected)

Sixteen mutation proofs in `tests/discrimination/deployment-foundation.discrimination.test.ts`, each named for the protection it discriminates: URL-credential/token-literal/credential-assignment/GitHub-token content in manifests (the secret scan flags each); plaintext in a reference variable and production-scoped reference in a staging evaluation (rejected); authoritative-unavailable ⇒ DOWN (a healthy report is unrepresentable) and the demoted-relational manifest rejected at load; the weakened teardown policy rejected at load; infrastructure provider identifiers in the domain tree (clean over the real tree; the scanner proven to detect synthetic leaks); naming constraint violations throw; a tampered identity id fails exact-revision verification.

## Verification (the gates, at this head)

- `bun install` — frozen lockfile, no new dependencies.
- `python3 scripts/governance-check.py` — **fails with the inherited dispatch-state defect** (see the baseline section): program-state 42 WOs vs dependency-state 41; WORK-042 missing from dependency-state.json; identical failure at the exact base `6bbb76e` and at canonical main `d2cdb25` (proven by runs at both revisions); report-only — the Architect's one-line dependency-state fix restores the gate without any worker change.
- `bun run typecheck` — 0 errors.
- `bun run lint` — biome clean (998 files, including `deploy/**`).
- `bun run deploy:validate` — valid: 4 environments, 6 providers, 10 resource kinds, 19 variables, 4 secret-reference inventories, 0 problems.
- Deployment integration suite (real PG): 10/10 — idempotent bootstrap, teardown/recovery, classification-guard refusals, fail-closed smoke, deterministic identity.
- **Full suite with real PG, run twice consecutively at the exact final head (the release gate): two consecutive runs over this branch's final tree — 292 files / 4271 tests, 4269 passed, 2 failed = exactly the two inherited governance-state failures** (the same two, same cause, failing identically at the dispatch base before any change of mine — attribution: the missing WORK-042 dependency-state entry, Architect-owned). Executed as the three sequential script invocations `test:unit` (150 files / 2435 tests), `test:integration` (68 files / 791 tests), `test:architecture` (74 files / 1045 tests) — the complete `bun run test` set; this sandbox enforces a per-command wall-clock limit, and the two consecutive full-suite cycles each traversed all 292 files at this exact tree.

## Deployment identity (this revision)

`bun run deploy:identity -- --environment local` at `cb728e2` (the last code commit; the final head adds only this document): `identityId e9f9b9a7482826871fcde9ece992021e18b7a49d6f241596bb6f060d6376efa1`, `manifestDigest 3e8e30c467b96764177c7da19fcbff6d6f36cbb69724ed9b67d9237e34465bce`, `resourceDigest 96d1c34fe0036d0a6dec40f7a07107574fce42acd93615234ea27b56843318cd`. The identity is pure — two consecutive emissions are byte-identical (verified locally; CI re-runs it twice and diffs). The manifest and resource digests are identical to the historical-upstream submission of this tree, confirming the byte-exact port.

## Repository truth versus external provider state (the evidence-contract distinction)

Repository truth: everything under `deploy/` (manifests, tools, README), the platform seams under `src/platform/deployment/`, the `/health` route, the CI workflow, and this document. External state (classified, NOT reproduced from the repository, and NOT verified in this worker environment — see the readiness section): Composio workspace/provider connections (none available here), the operator's GitHub credential (environment-only, Git/PR lifecycle only), and any resources eventually created in provider accounts under the computed names. No infrastructure resource outside GitHub was created, mutated or verified by this worker; nothing in this evidence claims otherwise.

## Reproduction and teardown procedure

See `deploy/README.md` (the operator path: set `ZECK_ENVIRONMENT`/`ZECK_PG_ADMIN_URL`/optional `ZECK_LOCAL_REDIS_URL` → `deploy:bootstrap` → `deploy:smoke` → `deploy:identity`; teardown `deploy:teardown --environment local`; provider environments: plan emission + the classified operator steps). CI runs the same path on every PR/push. Reproducibility from a fresh checkout was exercised in this environment: the clone at the base → branch → `bun install` → PG 16.4 provisioning → validate/bootstrap/smoke/identity all executed from repository-resident instructions alone.

## Known limitations

1. The inherited governance-state defect (Architect-owned fix; see above) — the only red gate on this branch, failing identically at the dispatch base and at canonical main.
2. Provider mutation adapters (Neon project/branch creation, R2 bucket creation, Queues/Workflows/Redis provisioning, Vercel project deployment) are D-02+ roadmap phases by design; D-01 makes the configuration reproducible and the plans/preconditions exact and fail-closed. No provider-account credentials exist in this worker environment (see the readiness section) — provider-account verification is NOT RUN, and no provider resource state is claimed.
3. Preview teardown and preview/staging/production bootstrap are plan-emitting only in D-01.
4. The `dependencyReadiness` probe on the API is injected by composition; the production wiring (real probes over the platform model) arrives with the deployment composition root in D-02+ (tests inject probes; the smoke tool is the reference evaluator today).
