# WORK-060 Evidence — Provider Redundancy, Private Connectivity, Residency and Availability Measurement (D-08 / AVA-001 / AVA-003 / SEC-003)

Work Order: `WORK-060` (`spec/work-orders/WORK-060.md` at the dispatch base — the canonical dispatch) · Canonical remote: **`payswapdotorg/Zeck`** · Assurance: **HIGH_ASSURANCE** · Governing architecture: frozen v1.0 + D1.0 + ADR-0021 / ACR-005 (D-08 extension) · Binding requirements **AVA-001** (control-plane availability target), **AVA-003** (independent provider redundancy), **SEC-003** (private connectivity and regional/data-residency) · Roadmap phase **D-08, wave B** (sole worker; every wave-A sibling — WORK-057 HA, WORK-058 isolation, WORK-059 audit — merged at the dispatch base).

## Dispatch, branch and ancestry

Exact dispatch base: `f9386a4736d6a6c3513381d9fe598020809acdec` (main's head at dispatch — the D-08 wave-A finalization commit; verified with `git rev-parse f9386a4^{commit}` before any change). Final implementation head: **`d87eb4640f906bef80002a163531d80fd4741c90`** (the test-battery commit; the branch then carries this evidence file on top). **5 commits (4 implementation + 1 tests), ZERO merge commits, ZERO `spec/` changes, ZERO new migrations** (mechanically verified: `git log --merges f9386a4..HEAD` → 0; `git diff --name-only f9386a4..HEAD -- spec/` → 0; `deploy:validate` reports `migrations: 31`, the same count as the base). Required branch: `work/WORK-060-provider-redundancy-residency-availability` (created at exactly the base SHA before any change). The worker does not merge.

Dispatch note: main has since advanced `f9386a4 → 8af4ee1` (an Architect CI fix touching ONLY `.github/workflows/deployment-release.yml` checkout depth, per the revival dispatch). Per the dispatch instruction the branch is NOT rebased; the PR diff against `main` shows only this Work Order's changes plus that unrelated workflow-depth difference.

## Baseline gate at the exact dispatch base (readiness checkpoint — BEFORE implementation)

Executed at exactly `f9386a4` before any change:

- `python3 scripts/governance-check.py` — **PASSED**: `Governance OK: 60 Work Orders, 110 requirements, inFlight=[], frontier=['WORK-060']` (WORK-060 frontier-eligible — the wave-B eligibility confirmation).
- `bun install` — clean.
- Real PostgreSQL 16.4 (embedded zonky build at `127.0.0.1:55432`, the prior workers' convention; `ZECK_PG_TEST_URL=postgres://zeck@127.0.0.1:55432/postgres`).

## External-infrastructure access (readiness checkpoint)

**NOT RUN — no live provider credentials exist in this worker environment for ANY durable concern's alternate** (no Neon/managed-PostgreSQL standby credentials beyond the local sandbox, no S3-compatible alternate object-store credentials, no alternate queue transport, no alternate host). The only credential held is the operator-provided GitHub PAT for `payswapdotorg/Zeck` (environment-only, used solely for the Git/push/PR lifecycle; verified absent from every committed file — the staged diff was scanned for `ghp_`/`github_pat_`/`AKIA…`/`sk-…`/`payswapdotorg:<token>` shapes before every commit; the only matches are the DETECTION PATTERNS inside the discrimination tests themselves). No provider resource in any non-GitHub account was mutated. Every live-provider failover is therefore **NOT RUN and disclosed** (SELF-HOSTING-BOUNDARY below) — never claimed as PASS.

## What this order IS

The D-08 steady-state operations plane, exactly as the Work Order's Objective bounds it: (1) **declared alternate providers per durable concern** (relational-state, artifact-bytes, async-transport, experience-delivery) in `providers.json` with TYPED failover profiles and drill-measured redundancy evidence — governed procedures, never automatic cross-provider migration of authority; (2) **private connectivity profiles** in the environment matrix with the production class refusing public-path internal communication, VALIDATED by `deploy:validate` and the environment contract, not documented-only; (3) **region as a first-class deployment dimension** with tenant-declared data-residency constraints enforced at the existing deployment/adapter seams and CONSUMED by policy — residency is never a new authority, never authorization vocabulary; (4) **the ≥ 99.9% monthly control-plane availability target made measurable** through the D-06 release-control/observability surfaces with exact-revision identity and alert-state integration, with fail-closed semantics preserved AND measured as correct behavior (a control plane refusing to serve against a dead authority is CORRECT; serving against a dead authority is a correctness violation worse than an SLO breach).

## Acceptance-criteria mapping (Work Order §Acceptance Criteria)

| AC | Claim | Evidence |
|---|---|---|
| 1. Alternate providers declared for every durable concern with typed failover profiles; drill-measured evidence where execution is possible; honest NOT RUN elsewhere | PASS | `deploy/manifests/providers.json`: `durableConcerns` pinned `["relational-state","artifact-bytes","async-transport","experience-delivery"]`, each concern's provider carrying a typed `redundancy.alternate` block (`id` + `substitutionTarget` + `failover.mode:"governed-procedure"` + `procedure` + `measurement`); the loader (`src/platform/deployment/manifest.ts`) validates: every declared concern resolves to exactly one provider WITH an alternate, an `automatic` failover mode is unrepresentable (loader + `D3c`), a missing/malformed alternate block is rejected (unit `manifest.test.ts` "a malformed alternate failover block is rejected"). `src/platform/deployment/provider-failover.ts`: `providerFailoverProfiles` + `selectFailoverProvider` — the typed selection resolving each concern's DECLARED alternate with content-addressed `selectionId` provenance, idempotent per revision window. Drill-measured in the local class (the only class with executable credentials): `deploy:drill provider-redundancy --environment local` transcript below — 3 phases ok including a REAL disposable primary+standby PostgreSQL 16.4 failover (initdb + streaming replication + governed promotion, measured RTO 2751ms, `recovered: true`, RPO 0 by catchup bytesBehind=0) at revision `d87eb46`; honest `notRun` for artifact-bytes/async-transport/experience-delivery alternates (no credentials — never claimed as PASS). Integration over real PG: `provider-redundancy.test.ts` (4 passed, 1 live-provider honesty skip) proves every concern selects its declared alternate idempotently and the REAL HA topology failover converges |
| 2. Private connectivity profiles in the environment matrix; `deploy:validate` enforces the production-class rule | PASS | `deploy/manifests/environments.json`: every environment class declares `connectivity.internalPaths` (local `["loopback"]`, preview `["tunnel"]`, staging `["tunnel","private-endpoint"]`, production `["private-endpoint","tunnel"]` — `public` is unrepresentable by construction, `D1a`). `src/platform/deployment/connectivity.ts`: the closed address-path vocabulary (`loopback/private/dns-name/public`), `classifyAddress`/`classifyEndpointAddress` (IP-literal, RFC1918/CIDR, `.localhost`, DNS names), `pathClassAllowedByProfile`, `evaluateConnectivityContract` (fail-closed: an unknown class is refused). Enforcement is THREE-layered, validated not documented-only: `deploy:validate` rejects a public-path internal endpoint at the manifest/variables layer (`D1a`/manifest unit tests); the environment contract (`env-contract.ts`) fails a materialized public `ZECK_CONTAINER_RUNNER_URL` (`D1c` — proven live: the drill refused to run until the contract was satisfied); the endpoint evaluation refuses a public IP-literal for EVERY declared profile (`D1b`). Mutation proof: a weakened evaluator ignoring the address class admits the public endpoint — the check is load-bearing (`D1d`) |
| 3. Region/residency dimension: tenant constraints fail-closed at the adapter seams when unsatisfiable; satisfied constraints proven by test | PASS | `environments.json`: `region` declared per class (repository truth — a multi-region production edits this file, never a provider console). `src/modules/policies/domain/residency.ts`: the PURE typed constraint (`ResidencyConstraint` over required regions + tenant identity; `DATA_AT_REST_SURFACES` = authoritative-state/artifact-bytes/evidence), `evaluateResidencyConstraint` — an unsatisfied or unprovable locality (none supplied) returns the typed fail-closed refusal `residency-unsatisfied`; a malformed constraint returns `residency-invalid`; NO restriction dimension exists to loosen residency (`D2c` — a policy document can never widen it). `src/modules/policies/adapters/residency-enforcement.ts`: the deployment-seam enforcement over plain-data environment declarations (`dataAtRestLocalitiesFor` + `createResidencyEnforcement`). Fail-closed proofs: unit `residency.test.ts` (15 tests: unsatisfied fails closed per surface; unprovable locality fails closed; satisfied constraints PASS with provenance; invalid constraints refused) + discrimination `D2a`/`D2b` (the mutation that checks only the first surface admits the violation — the full check is load-bearing) + the adapter seam is exported through `src/modules/policies/public.ts` for the deployment seams |
| 4. Availability computation from the D-06 surfaces with exact-revision identity and alert-state integration; 99.9 wired as the production-class threshold | PASS | `src/platform/observability/availability.ts`: the PURE monthly window computation over typed interval observations — closed outcome vocabulary (`served`/`refused-fail-closed`/`unavailable`/`served-against-dead-authority`), exact-revision identity (`releaseId`+`gitRevision`+`manifestDigest`), content-addressed `evidenceDigest` (volatile timestamps excluded), `PRODUCTION_AVAILABILITY_TARGET_FLOOR_PCT = 99.9` (a weaker production target is unrepresentable at the loader — `D4b`); `availabilityOutcomeOfReadiness` derives observations from the EXISTING D-01/D-06 readiness evaluation (import-only — no second metrics authority, `D5c`). `quota-guards.json`: availability targets per class (local 99.0, preview 99.0, staging 99.5, production 99.9 — the AVA-001 floor). `release-policy.json`: the new `availability` gate kind. Alert-state integration: `availabilityAlertOf` — semantics violation ALWAYS critical ("a correctness breach is worse than an availability breach"), below-target critical, near-breach warning (`alerts.ts` wires the `availability` alert kind into the D-06 alert plane; `evaluateAlerts` surfaces the active release's availability alert). Recording: `deploy:release availability` computes + records the window as append-only exact-revision gate evidence over the real release-control ledger. Honest-measurement proofs: `D4a` (counting fail-closed refusal time as serving demonstrably inflates availability — the real computation never does), `D4c` (a served-against-dead-authority interval always violates — never a PASS). CLI transcript below: window 2026-08 @ `d87eb46` — 4 intervals, served 2591580000ms, refused-fail-closed 240000ms (CORRECT, not serving), unavailable 180000ms → availability 99.9838% vs target 99.0, `failClosedSemantics: "preserved"`, gate `passed`, digest `c1d12e76…`; re-run converges (attempt 2, IDENTICAL digest) |
| 5. Discrimination/mutation tests: public-path internal traffic rejected; unsatisfied residency fails closed; ambient provider substitution rejected | PASS | `tests/discrimination/d08-operations.discrimination.test.ts` — **18 tests, all passing**: D1a–D1d public-path internal traffic (manifest vocabulary, endpoint evaluation for every profile, environment contract, the weakened-evaluator mutation); D2a–D2c unsatisfied residency (typed refusal, the first-surface-only mutation, the no-widening proof); D3a–D3c ambient provider substitution (a non-declared provider is refused, the ignore-requested-provider mutation, automatic failover unrepresentable); D4a–D4c availability honesty (the inflate-availability mutation, the <99.9 production-target refusal, the dead-authority-serving violation); D5a–D5e boundary probes (no provider vocabulary / no credential literals on the new surfaces, NO residency vocabulary on the authority path, NO database dependency in the availability computation, the honest NOT RUN vocabulary in the drill surface, the repository manifests carry the D-08 dimensions) |
| 6. Full battery at the final head; evidence document `docs/work-items/WORK-060.md` | PASS | The six-command battery at implementation head `d87eb46` (below) — all green over real PostgreSQL; this document at the head recorded above |

## Architecture invariants (Work Order §Architecture Invariants)

1. **Every redundancy claim carries drill-measured evidence at exact revisions** — the drill transcript below is revision-bound (`d87eb46…`); no provider-dashboard claim exists anywhere; the drill's `notRun` list names every unmeasured alternate with the exact missing credentials; `D5d` pins the honest NOT RUN vocabulary structurally.
2. **Residency is a policy-consumed constraint; the authorities stay unchanged** — `domain/residency.ts` is pure typed data (no `PolicyAuthority`/`PolicyStore`/`DatabasePort`/`authorize(`/relative-or-pg imports — `D5b` probes this mechanically); the authority path (`application/policy-authority.ts`, `ports/policy-authority.ts`, `execution-authorization.ts`, `dispatch-admission.ts`) carries ZERO residency vocabulary (`D5b`, `/residen/i` over all four files — the one pre-existing base comment containing the unrelated word "configuration-resident" was reworded to "versioned configuration data", a comment-only change, disclosed in the inventory).
3. **Failover is typed and governed** — `failover.mode` is the closed vocabulary with `governed-procedure` the only representable mode for alternates (`D3c`); ambient substitution (a request naming a non-declared provider) is refused with the typed rejection (`D3a`); the selection carries replayable `selectionId` provenance (EXECUTION-PROVENANCE below).
4. **Availability never weakens the authoritative-dependency rule** — `D4a` proves the honest computation (fail-closed refusal time is never counted as serving); `D4c` proves a served-against-dead-authority interval always violates the semantics (never a PASS, always critical); the target floor is 99.9 for production, unrepresentable below (`D4b`).
5. **Free-tier resources are never operationally critical** — `providers.json` `freeTierDoctrine` note + every alternate is a PAID-class managed substitution target; the drill's local-class alternates are real disposable PostgreSQL instances (initdb'd per drill), never free-tier shared resources.
6. **Private connectivity is validated, not documented-only** — three enforcement layers (manifest loader, environment contract, endpoint evaluation) + the mutation proof `D1d`; proven live (the drill CLI itself refused to start until the environment contract was satisfied).

## Required checkpoints

- **RELEASE-IDENTITY** — every availability record and redundancy drill carries the exact revision: the drill transcript binds `revision: d87eb4640f906bef80002a163531d80fd4741c90`; the availability record carries `releaseId` (content-addressed over `gitRevision` + `manifestDigest`), `gitRevision`, `manifestDigest` AND its `evidenceDigest` covers them (the canonical digest input includes the full revision identity). Integration `availability-record.test.ts` A1 proves the record rides the real release-control ledger as gate evidence; a record dissociated from its revision is unrepresentable (the digest input structurally includes the identity).
- **OBSERVABILITY-BOUNDARY** — `availability.ts` imports ONLY `./port` (the alert shapes) and `../deployment/readiness` (the observation derivation); `D5c` mechanically forbids `DatabasePort`/`../db`/`release-control`/`SELECT `/`INSERT ` and whitelists the import specifiers. The computation is a pure evaluator over typed intervals handed to it — the durable RECORD rides the existing release-gate evidence plane through `deploy:release` (the D-06 surface), never a new metrics store.
- **SELF-HOSTING-BOUNDARY** — no provider SDK imports anywhere in the new surfaces (`D5a` provider-vocabulary probe over all five new files); live provider failovers are NOT RUN where credentials do not exist and disclosed exactly (the drill `notRun` list + this document's NOT RUN section); provider control planes stay provider-owned — Zeck consumes capability + economics (the alternates name SUBSTITUTION TARGETS, never absorbed control planes).
- **IDENTITY-IDEMPOTENCY** — the availability window computation is deterministic per (observations, window, revision identity, target): the CLI re-run produced the byte-identical `evidenceDigest` `c1d12e76…` with convergent gate attempt 2; the failover selection is idempotent per revision window (the drill's `failoverSelection` block reports `idempotent: true` for all four concerns; integration `provider-redundancy.test.ts` proves repeated selections converge).
- **EXECUTION-PROVENANCE** — every failover selection carries a content-addressed `selectionId` over (concern, requested provider, declared alternate, failure observation, revision window) — replayable by recomputation; every residency outcome carries the canonical constraint + localities + evaluated surfaces in its typed shape (unit tests replay the same evaluation to the same verdict); the availability record's canonical form is replayable from the same observations (the digest re-derivation is the replay proof).
- **IMPLEMENTATION-COMPLETENESS** — this evidence package maps every AC and checkpoint to exact-revision results; forbidden surfaces untouched: ZERO changes under `src/platform/db/**` (the HA machinery is imported — `provider-failover.test.ts` and the drill CONSUME `src/platform/db/ha/*` read-only), `src/modules/sandbox/**`, `src/modules/audit/**`, `src/platform/compute/**`, `benchmarks/**`, `spec/**`; the complete changed-file inventory below is 32 files, all within the declared surfaces (the `deploy/*.ts` CLI changes ride the Work Order's "typed failover selection through the existing substrate seams; tests + drills" + AC 2's `deploy:validate` enforcement mandate).

## Test battery at the final implementation head (exact-revision results)

All six gates re-run at implementation head `d87eb4640f906bef80002a163531d80fd4741c90` (the evidence-doc commit touches only `docs/`):

- `python3 scripts/governance-check.py` — **PASSED**: `Governance OK: 60 Work Orders, 110 requirements, inFlight=[], frontier=['WORK-060']`.
- `bun run typecheck` — **0 errors** (`tsc --noEmit` exit 0).
- `bun run lint` — **biome exit 0** (37 warnings / 1 info — the repo's tolerated warning baseline, exactly the same kinds and files as the base: `noNonNullAssertion`/`useTemplate`/`noUnusedFunctionParameters` in the pre-existing WORK-059 audit tests; ZERO new warnings from this Work Order's files).
- `bun run test:architecture` — **106 files passed | 1 skipped (suite-level placeholder) / 1423 tests passed | 4 skipped** (includes the 18 new `d08-operations.discrimination.test.ts` tests).
- `bun run test:unit` — **231 files / 3381 tests, all passed** (includes the new suites: `connectivity.test.ts` 18, `provider-failover.test.ts` 9, `availability.test.ts` 14, `residency.test.ts` 15, the `manifest.test.ts` D-08 dimensions and the `alerts.test.ts` availability-alert cases).
- `ZECK_PG_TEST_URL=postgres://zeck@127.0.0.1:55432/postgres bun run test:pg` — **real PostgreSQL 16.4: 107 files passed | 1 skipped / 880 tests passed | 7 skipped** (the skips are the pre-existing live-provider honesty skips; includes `provider-redundancy.test.ts` 4 passed + 1 live-credential skip and `availability-record.test.ts` 5 passed over the real ledger).
- `bun run deploy:validate` — **`valid: true`, problems `[]`**, with the D-08 dimensions present: `connectivityEnvironments: 4`, `regionEnvironments: 4`, `providerRedundancyProfiles: 4`, `migrations: 31` (unchanged — migration-free as the Work Order expected).

## Drill and CLI transcripts (exact-revision, at head `d87eb46…`)

### `deploy:drill provider-redundancy --environment local` (with real PostgreSQL 16.4 binaries via `ZECK_HA_POSTGRES_BIN`)

```text
revision: d87eb4640f906bef80002a163531d80fd4741c90
phases:
  redundancy-declarations   ok (every durable concern declares exactly one typed alternate, governed-procedure profile — AVA-003)
  failover-selection        ok (the typed selection resolves every concern's declared alternate with idempotent provenance; ambient substitution refused live)
  relational-state-failover ok (durationMs 766)
rtoMs: 2751 · rpoMs: null (RPO 0 by catchup: bytesBehind 0, waitedMs 6) · recovered: true
redundancyTopology: { form: local-disposable, primaryPort 55611, standbyPort 55612,
  replicationMode: asynchronous, catchup: { bytesBehind: 0, waitedMs: 6 },
  note: "a real disposable primary+standby (initdb + production startup + streaming replication); the live authority is never touched" }
failoverSelection: all four concerns → declared alternate, idempotent: true,
  selectionIds: relational-state f5c2178d…, artifact-bytes b15ddc1a…, async-transport e8a77116…, experience-delivery e81eccb0…
notRun (honest):
  artifact-bytes-alternate:   missing ZECK_DRILL_ALTERNATE_OBJECT_STORE_* credentials — NOT RUN, never claimed as PASS
  async-transport-alternate:  no alternate queue transport configuration exists in this environment (queue-recovery executes where credentials exist)
  experience-delivery-alternate: no alternate host endpoint exists (the API is independently runnable by construction — the D-07 proof)
```

### `deploy:release availability --environment local --window 2026-08` (real release-control ledger)

```text
releaseId:    ebbc15ffd7888b5c54e21eff568f454ccb69d17ea44bf246457e6181604b27b8
gitRevision:  d87eb4640f906bef80002a163531d80fd4741c90
manifestDigest: ee45041c64a912410366b7d34608b4d9e1aec6a7f3b7d5a3d1d6cf94586b44ea
intervals: 4 → totalMs 2592000000 · servedMs 2591580000 · refusedFailClosedMs 240000 (CORRECT, not serving)
             · unavailableMs 180000 · servedAgainstDeadAuthorityMs 0
availabilityPct: 99.9838 (vs targetPct 99.0) → withinTarget: true · failClosedSemantics: preserved
evidenceDigest: c1d12e764e46eaf910d0c7d30c7cbc62e5c0a0e2771cb55168ab12c9f9ec3873
gate: { gateKind: availability, attempt 1, status: passed, evidenceDigest: c1d12e76… } · alert: null · critical: false
RE-RUN (IDENTITY-IDEMPOTENCY): attempt 2, status passed, byte-identical evidenceDigest c1d12e76…
```

### `deploy:validate`

```text
valid: true · problems: [] · environments 4 · providers 8 · migrations 31
connectivityEnvironments: 4 · regionEnvironments: 4 · providerRedundancyProfiles: 4
releaseGateKinds: 14 (includes the new availability gate kind) · quotaGuards: 3 (includes the availability targets)
```

## Changed-file inventory (32 files; ancestry `f9386a4..d87eb46`; +4789/−27)

**Declared surface — `deploy/manifests/**` (4 files, all modified, never weakening an existing entry):**

```text
deploy/manifests/environments.json   (region + connectivity.internalPaths per class)
deploy/manifests/providers.json      (durableConcerns + typed redundancy.alternate per durable concern)
deploy/manifests/quota-guards.json   (availability targets per environment class; production floor 99.9)
deploy/manifests/release-policy.json (the availability gate kind)
```

**Declared surface — `src/platform/deployment/**` (4 files):**

```text
src/platform/deployment/connectivity.ts      (NEW: address-path classification + contract evaluation)
src/platform/deployment/provider-failover.ts (NEW: typed failover selection + provenance)
src/platform/deployment/manifest.ts          (loader: alternates/connectivity/region validation, fail-closed)
src/platform/deployment/env-contract.ts      (the contract consumes the connectivity profile)
```

**Declared surface — `src/platform/observability/**` (4 files):**

```text
src/platform/observability/availability.ts (NEW: the AVA-001 pure window computation + alert integration)
src/platform/observability/alerts.ts       (the availability alert kind rides the D-06 alert plane)
src/platform/observability/port.ts         (the OperationalAlert kind vocabulary extension)
src/platform/observability/index.ts        (the barrel export)
```

**Declared surface — `src/modules/policies/**` (6 files):**

```text
src/modules/policies/domain/residency.ts               (NEW: the pure consumed-constraint evaluation)
src/modules/policies/adapters/residency-enforcement.ts (NEW: the deployment-seam enforcement)
src/modules/policies/domain/index.ts                   (barrel)
src/modules/policies/adapters/index.ts                 (barrel)
src/modules/policies/public.ts                         (the public surface: constraint + evaluation exports)
src/modules/policies/ports/policy-authority.ts         (COMMENT-ONLY: "configuration-resident" → "versioned
                                                        configuration data" — the D5b authority-path boundary;
                                                        zero code change, disclosed here)
```

**The substrate seams the Work Order names ("typed failover selection through the existing substrate seams; tests + drills"; AC 2's `deploy:validate` enforcement) — 3 files:**

```text
deploy/drill.ts    (the provider-redundancy drill command: real-topology failover phase + honest notRun)
deploy/release.ts  (the availability command: compute + record as exact-revision gate evidence over the D-06 ledger)
deploy/validate.ts (the private-connectivity + redundancy-profile validation)
```

**Tests (11 files, 7 new):**

```text
tests/unit/deployment/connectivity.test.ts        (NEW, 18 tests)
tests/unit/deployment/provider-failover.test.ts  (NEW, 9 tests)
tests/unit/observability/availability.test.ts     (NEW, 14 tests)
tests/unit/policies/residency.test.ts             (NEW, 15 tests)
tests/discrimination/d08-operations.discrimination.test.ts (NEW, 18 tests)
tests/integration/postgres/provider-redundancy.test.ts     (NEW, 4 passed + 1 live-credential skip)
tests/integration/postgres/availability-record.test.ts     (NEW, 5 tests over the real ledger)
tests/unit/deployment/manifest.test.ts            (the D-08 manifest dimensions; 31 tests total in file)
tests/unit/observability/alerts.test.ts           (the availability alert cases)
tests/unit/release/policy.test.ts                 (the availability-gate pin reconciliation)
tests/integration/postgres/release-control.test.ts (the availability gate-kind coverage)
```

**ZERO changes under:** `src/platform/db/**` (HA machinery — imported only), `src/modules/sandbox/**`, `src/modules/audit/**`, `src/platform/compute/**`, `benchmarks/**`, `spec/**`, `src/platform/db/migrations/**` (migration-free, as the Work Order expected — no migration proved necessary).

## Honest NOT RUN boundaries

- **Live provider failovers in preview/staging/production classes — NOT RUN**: no credentials exist in this worker environment for any non-local provider (no managed-PostgreSQL standby outside the local sandbox, no S3-compatible alternate object store, no alternate queue transport, no alternate delivery host). Drill-measured evidence exists ONLY in the local class (declarations + typed selection + the REAL disposable PostgreSQL primary+standby failover). The production-class redundancy claim rests on the declared typed alternates + the governed procedures + the local-class drill of the exact machinery — never on an unexecuted live failover.
- **`artifact-bytes-alternate`, `async-transport-alternate`, `experience-delivery-alternate` drills in the local class — NOT RUN** (the drill transcript's own `notRun` list names the exact missing credentials; never claimed as PASS; `D5d` pins the vocabulary structurally).
- **Production monthly availability telemetry collection — NOT RUN**: the measurement/recording/alerting surface is proven over real PostgreSQL at exact revision (integration suite + CLI transcript); production interval collection itself is an operational activity outside this worker environment.
- **Live multi-region production residency — NOT RUN**: the region dimension, the constraint evaluation and the fail-closed adapter seam are proven by test over synthetic + real-local environments; no production multi-region deployment exists to measure.
- **The skipped integration test** (`provider-redundancy.test.ts`, 1 skip) is the live-provider honesty skip — the suite itself refuses to claim a live failover without credentials.
- **Cloudflare/Vercel/Neon control planes were never contacted**; no provider dashboard was read; no provider metric was trusted (SELF-HOSTING-BOUNDARY).

## Known limitations / deferred items

- The failover selection is typed + drilled, but an operator-facing `deploy:release` integration of alternate-selection recording (beyond the drill's provenance block) was not required by the AC and is left to the steady-state operations order that consumes it.
- The availability observations arrive as a typed JSON file from the readiness/telemetry plane; an automated telemetry collector feeding that file continuously is operational tooling outside this Work Order's surfaces.
- The residency constraint is enforced at the deployment seam and exported for policy consumption; wiring it into a tenant-facing declaration UI is a product-surface concern, not a platform concern.
