# WORK-002 Evidence — Identity, applications and tenant isolation

Status: IN REVIEW (round 2) — architect changes-requested on PR #4 REMEDIATED: owner-retention concurrency boundary implemented, proven on real PostgreSQL (red→green discrimination); re-review pending on `work/WORK-002-identity-tenants`.

## Requirement mapping

WORK-002 owns no frozen requirement IDs directly (substrate Work Order per `spec/work-orders/WORK-002.md`). Acceptance criteria mapping:

| Acceptance criterion | Implementation | Proof |
|---|---|---|
| 1. Actor, application, environment and membership authorization contracts | `src/modules/auth/domain/` (Actor, Principal, roles, permissions, TenantScope, MembershipRecord), `src/modules/applications/domain/ownership.ts` (Tenant, Application, Environment, kinds), public barrels exporting the contracts | `tests/unit/roles.test.ts`; `tests/unit/scope-resolver.test.ts`; `tests/architecture/module-skeleton.test.ts` (unchanged, still green) |
| 2. Tenant/application ownership persisted with DB constraints preventing cross-tenant ownership ambiguity | Migration `0001_identity_tenants.sql`: `applications (id, tenant_id)` UNIQUE; memberships and environments reference applications via the COMPOSITE FK `(application_id, tenant_id)`; tenant-scope shape CHECK; partial unique indexes | `tests/integration/postgres/schema-constraints.test.ts` (6 real-PG proofs: anti-ambiguity unique, both composite FKs, scope shape, tenant-scoped slug namespaces, ledger arbitration keys) |
| 3. Application scope resolved server-side on every protected command; callers may not select arbitrary tenant scope | `createScopeResolver` is the ONLY `TenantScope` producer; tenant always read from durable ownership/membership rows; command inputs carry no tenant selector (the single documented exception is `CreateApplicationCommand.tenantId` — a resolver-verified creation TARGET, not a scope selector) | `tests/unit/scope-contract.test.ts` (static: no selector on command inputs; scope literals only in the resolver); `tests/unit/scope-resolver.test.ts`; `tests/integration/postgres/tenant-isolation.test.ts` (dynamic, real PG) |
| 4. Cross-tenant read/write rejected before downstream module execution | `assertScopeCovers` guard + resolution-fails-first ordering; membership lookups by id WITHOUT application filtering (explicit `TENANT_SCOPE_VIOLATION`, never silent not-found); reads fail-closed on foreign-tenant rows | `tests/integration/postgres/tenant-isolation.test.ts` (journaled stores prove NO downstream write methods run; cross-tenant environment fetch rejected); `tests/unit/membership-service.test.ts`; discrimination proofs |
| 5. Idempotent identity/membership mutation semantics | `platform.idempotency_records` ledger: insert + guarded work + durable outcome in ONE transaction; `ON CONFLICT ... DO NOTHING` against dual partial unique indexes; fingerprint-checked replay (`IDEMPOTENCY_KEY_REUSED` on mismatch); role changes are explicit updates, same-role duplicates converge | `tests/integration/postgres/idempotency.test.ts` (replay, reuse rejection, concurrent convergence to ONE durable identity, crash atomicity + clean retry); `tests/integration/postgres/ownership.test.ts` |

## Implementation

- Base revision: `f5b7d6cd59af1c9d31b82ccc3de36f02b5f5b749` (`main`, post-WORK-001 finalization)
- Implementation head (round 1): `496f890e820ee7480d1c5844494321b1b18b26c3` (gate output preserved in git history)
- Implementation head (round 2, CURRENT — includes the PR #4 remediation): `a0a17bfc89192e3e6b06b1c25e9452787f5d29df` (the full verification gate below re-ran green at exactly this revision; the final branch head carrying this evidence file is bound in the PR body — a commit cannot contain its own SHA)
- Final identity: the architect merge commit, recorded at post-merge finalization
- Changed surfaces (all within declarations):
  - `src/platform/db/migrations/` — `0001_identity_tenants.sql` (schemas `applications`, `identity`, `platform`; ownership tables with composite FKs; idempotency ledger with dual partial unique indexes), `runner.ts` (forward-only migration runner: exactly-once via `platform.schema_migrations`, sha256 checksum integrity fail-closed, reorder fail-closed, `pg_advisory_xact_lock` serialization, transactional per migration), README updated (the runner this directory pre-announced)
  - `src/modules/auth/` — domain (actor/principal/roles/permissions/scope), ports (IdentityStore, IdempotencyPort), application (scope resolver, membership service), adapters (SQL implementation over the provider-neutral `DatabasePort`), public barrel (contracts + factories, provider-neutral)
  - `src/modules/applications/` — domain (tenant/application/environment), ports (ApplicationStore, IdempotencyPort), application (ownership services), adapters (SQL implementation; tenant/application creation writes the owner membership atomically), public barrel
  - `spec/development-state/` — WORK-002 `in-flight` (branch + base revision), frontier `eligible: []`, `inFlight: ["WORK-002"]`, checkpoint outcomes recorded (worker evidence; verdicts pending architect review)
- Directly-required items outside the declared module surfaces (called out for architect attention):
  - `package.json` + `bun.lock`: devDependencies `pg@8.16.3` + `@types/pg@8.15.6` (exact-pinned; TEST INFRASTRUCTURE ONLY — runtime `dependencies` remain empty, so the WORK-001 architecture assertion `allowedPackages == []` is untouched and unweakened), new script `test:pg`. Directly required by the Work Order's "real PostgreSQL integration" verification mandate: the harness's pg-backed `DatabasePort` is the reference implementation of the frozen platform port contract.
  - `tests/**` — unit (roles, scope resolver, membership service, scope-contract statics), `tests/integration/postgres/**` (env-gated real-PG suites + harness), `tests/discrimination/tenant-isolation.discrimination.test.ts`
  - WORK-001 test repairs — **pre-existing CI defect on `main`**: `tests/discrimination/governance-gate.discrimination.test.ts` had two fixtures hardcoded to the pre-finalization era ("frontier = [WORK-002]" mutation became a TRUE statement once WORK-001 completed; "merge evidence on WORK-001" became legal). Both failed on clean `main` (verified: 2 failed / 58 at `f5b7d6c` — the finalization commits made `test:architecture` red on `main`). Repaired to state-independent mutations (unknown id `WORK-999`; first incomplete Work Order), which discriminate forever. `tests/integration/toolchain-contract.test.ts`'s exact script snapshot changed to a superset check (canonical commands must exist exactly; additions by later Work Orders are legal) — with this PR's `test:pg` as the first addition.
- Not touched: frozen architecture/lock/ADRs, `spec/contracts.md`, other Work Orders, `scripts/governance-check.py` (byte-identical to base), `.github/` (CI has no PostgreSQL service — see known limitations)

## Design decisions (architect-review pointers)

1. **Composite-FK isolation**: cross-tenant ambiguity is prevented at the SCHEMA level (`applications (id, tenant_id)` UNIQUE; memberships/environments reference that composite key), not only in service code — proven by direct SQL violation attempts on real PG.
2. **Scope derivation**: `TenantScope` is constructible only inside the scope resolver (statically enforced); its `origin` records the durable derivation. `resolveTenantScope` VERIFIES claimed tenant authority against a durable membership — the target-tenant argument of `createApplication` is authorization-checked, never trusted.
3. **Idempotency scope**: exactly the contract's `(application_id, operation_name, idempotency_key)` for application-scoped operations (actor-independent, as the contract requires); pre-application operations (create tenant/application — no application id exists yet) are keyed `(actor_id, operation_name, idempotency_key)` via a second partial unique index. This is a documented extension for a case the contract scope cannot express, not a weakening.
4. **Cross-schema adapter coupling**: the auth adapter joins `identity.memberships` with `applications.applications`; the applications adapter inserts owner memberships into `identity.memberships`. Both couplings are the durable composite FK contract from migration 0001, confined to SQL adapters (infrastructure). There is exactly ONE TypeScript-level cross-module import in the tree: `applications/application/ownership-services.ts` → `auth/public.ts` (public barrel, dependency-direction-legal).
5. **Role changes are mutations**: `addMember` with an existing (actor, application) and a DIFFERENT role updates the role explicitly (with owner-retention applied to demotions); the same role converges (idempotent retry). Caught by a failing test during development — the original convergence path silently ignored promotions.
6. **pg driver placement**: `src/` never imports `pg` (SDK boundary table owns it under `src/platform/db/`; the production adapter arrives with the Work Order that owns that surface). The test harness in `tests/integration/postgres/harness.ts` implements the provider-neutral `DatabasePort` over `pg` and is the reference adapter proof.
7. **Owner-retention serialization domain = the application's FULL membership row set** (PR #4 remediation): the boundary is `lockApplicationMemberships(applicationId)` on the `IdentityStore` port — `SELECT ... WHERE application_id = $1 ORDER BY id FOR UPDATE` inside the arbitration transaction, returning the rows as committed at lock acquisition. The service re-derives BOTH retention facts (target's CURRENT role, owner count) from the locked rows; pre-lock reads never drive the decision. The lock set is deliberately the full set, not just current owner rows: a concurrent member→owner PROMOTION updates a row that is not yet an owner row, so owner-set-only locking would leave a window where a stale pre-lock role read drives a deletion. Inserts (new memberships) are additive — they cannot reduce the owner count and stay outside the lock domain (cannot starve it). Id-ordered acquisition is deadlock-free against other full-set lockers and single-row updates (no cycle can form). This is row locking per the architect's accepted designs, expressed through the module's own provider-neutral port — no second authority, no architecture change.

## Verification (round 2 — CURRENT, at remediation head `a0a17bfc89192e3e6b06b1c25e9452787f5d29df`; round-1 output at `496f890` preserved in git history)

All commands re-run at the round-2 implementation head `a0a17bfc89192e3e6b06b1c25e9452787f5d29df` with Bun 1.3.4 (CI-pinned) and PostgreSQL 16.4 (real server; embedded zonky build started outside the repository — `IMPLEMENTATION.md` §1 allows "Testcontainers (or equivalent real PostgreSQL)"):

- Governance check: `python3 scripts/governance-check.py` → `Governance OK: 20 Work Orders, 45 requirements, frontier=[]` (exit 0)
- Deterministic install: `bun install --frozen-lockfile` → no changes (68 installs across 117 packages)
- Typecheck: `bun run typecheck` → exit 0 (strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`)
- Lint: `bun run lint` → exit 0 (Biome, 165 files, no findings)
- Unit: `bun run test:unit` → 53/53 (adds role-change demotion retention: sole-owner demotion rejected; second-owner demotion + additive promotion succeed)
- Integration (no PG configured): PG suites skip with an explicit reason when `ZECK_PG_TEST_URL` is unset — honest skip, not silent
- Architecture + discrimination: `bun run test:architecture` → 67/67 (unchanged rules, still green)
- Real PostgreSQL: `ZECK_PG_TEST_URL=postgres://zeck@127.0.0.1:55432/postgres bun run test` → **156/156 across all 22 files, run twice consecutively** (30 real-PG tests):
  - migration-runner: applied+tracked, exactly-once rerun, checksum/renamed/reordered fail-closed, forward migration atomicity, statement splitting
  - schema-constraints: anti-ambiguity unique, membership composite FK rejection, environment composite FK rejection, tenant-scope shape CHECK, tenant-scoped slug namespaces, ledger partial-unique arbitration keys (application-scoped keys actor-independent; actor-scoped keys per-actor)
  - tenant-isolation: two-tenant matrix with journaled stores (no downstream write on rejection), scope derived from durable rows, cross-tenant environment fetch rejected, cross-tenant write structurally impossible through the command surface
  - idempotency: replay identity, `IDEMPOTENCY_KEY_REUSED` on fingerprint mismatch, concurrent identical requests converge to ONE durable tenant (two independent pools racing), crash atomicity (simulated failure before commit leaves NO ledger row, NO tenant; clean retry succeeds)
  - ownership: tenant creation provisions tenant-scope owner; application creation requires it; role matrix (member read-only, admin writes); duplicate convergence; owner-retention then valid removal; actor provisioning convergence
  - **owner-retention-concurrency (NEW — architect-mandated)**: two owners concurrently demoted / concurrently removed / mixed demote+remove, 25 rounds each through the full public service path on independent pool clients — EVERY round: exactly one mutation commits, the loser rejects with `AUTHORIZATION_DENIED` (owner retention), final committed owner count ≥ 1. Plus retained behaviors: last-owner demotion/removal rejection and same-role idempotent convergence under the boundary.
  - **owner-retention-serialization (NEW — deterministic mechanism proofs)**: gated real transactions prove (a) T2's boundary read CANNOT complete while T1 holds the membership-row locks (the architect's "T2 counts 2 owners" step is unreachable before T1 commits), (b) after T1's committed demotion/removal T2's locked read reflects it (owner count 1 → the derived decision must reject), (c) a concurrently promoted member IS an owner in the locked rows (stale pre-lock role reads never drive decisions).
- Concurrency-suite stability: the two new PG suites passed 6 consecutive full runs plus 3 isolated stress runs (7/7) — zero flakiness observed.
- CI: GitHub Actions runs the same suites without PG (PG suites skip visibly); the real-PG evidence is this locally-executed record (see known limitations)

## Checkpoint evidence

Applicable blocking contracts from `spec/governance/checkpoint-contract.json`:

- `IMPLEMENTATION-COMPLETENESS` — acceptance criteria 1–5 each implemented and mapped to passing tests (table above); full gate green including real-PG verification.
- `IDENTITY-IDEMPOTENCY` — proof classes static+dynamic+discrimination: static (ledger schema, dual partial uniques, port contracts), dynamic (replay/reuse/convergence on real PG), discrimination (fingerprint-check mutation replaying wrong outcome is exactly what the real port rejects; proven in `tests/discrimination/tenant-isolation.discrimination.test.ts`).
- `CONCURRENCY-CRASH-SAFETY` — dynamic proof on real PG: concurrent identical mutations converge via unique-index transactional arbitration (independent pools); crash before commit leaves zero partial state; retry is clean. Migration runner is advisory-lock serialized and exactly-once. Round 2 adds the owner-retention concurrency boundary: concurrent two-owner demotion/removal races always leave ≥ 1 committed owner (25-round service-level suites, both orders, plus the mixed pair), with deterministic gated-transaction proofs that the serialization boundary itself blocks and re-reads (red→green discrimination recorded in the Remediation section).
- `SELF-HOSTING-BOUNDARY` — no second authority: role/permission vocabulary is fixed code (not user-editable state), tenant scope derives only from durable rows via the single resolver, the worker did not merge its own PR, and the governance gate's own discrimination suite is green again (repaired from the stale-on-main state).

Recorded in `spec/development-state/checkpoint-state.json` as worker-recorded outcomes with verdicts pending architect review.

## Discrimination evidence (CRITICAL boundaries named by this Work Order)

Every weakened protection is proven to lose exactly the behavior the real tests assert (`tests/discrimination/tenant-isolation.discrimination.test.ts`):

- cross-tenant guard mutated to no-op → foreign-tenant access admitted (real guard throws `TENANT_SCOPE_VIOLATION`)
- scope resolver mutated to auto-grant → scope produced without any membership row (real resolver denies)
- idempotency fingerprint check removed → wrong-payload reuse silently replays (real port throws `IDEMPOTENCY_KEY_REUSED`)
- read fail-closed tenant filter removed → foreign-tenant rows leak (real filter omits them)
- owner-retention removed → last owner removable (real rule blocks)
- governance gate: hand-edited frontier / premature merge evidence / deleted lock artifact / dependency mismatch all rejected (state-independent mutations, repaired to survive program progression)

## Known limitations

- **CI has no PostgreSQL service** (`.github/` is outside this Work Order's declared surfaces): the PG suites are env-gated and skip visibly in CI; the real-PG proof is the locally-executed record above (Bun 1.3.4, PostgreSQL 16.4, output captured). Recommended architect follow-up: a governance-owned `.github/` change adding a `postgres:16` service + `ZECK_PG_TEST_URL` to the `implementation` job.
- **Authentication transport is not built** (by design): `Principal` is the contract an authenticated transport produces; credentials/tokens arrive with the Work Order that owns the API layer. Scope resolution CONSUMES principals; it never authenticates.
- **Module composition root deferred**: public barrels export factories over module ports; wiring SQL adapters to a live `DatabasePort` at the transport boundary is the API-layer Work Order's surface (the `api-boundary` rule forbids transport from importing module adapters directly — that wiring decision belongs to the Work Order that owns it).
- **No row-level security (RLS)**: isolation is enforced by composite FKs + scoped queries + service guards; RLS-in-adapter can be added by the platform-db-owning Work Order as defense in depth.
- Membership `listMemberships({})` fetches all rows for cross-application membership lookups in `removeMember`; fine at this scale, becomes a targeted `findMembershipById` query when the store grows.
- The embedded PostgreSQL 16.4 server used for verification runs outside the repository ( zonky binaries under `~/.local/embedded-pg`, no root required); CI parity for it is the `.github/` follow-up above.

## Remediation: architect review round 1 (PR #4, changes-requested)

**Finding (blocking, CRITICAL)**: owner-retention checking used `countApplicationOwners()` — a plain read — before the demotion/removal mutation, with no per-application serialization covering check + mutation. With exactly two owners A + B, T1 and T2 could both count 2, both mutate, both commit → zero owners. The 23 round-1 real-PG tests proved single-transaction retention but not concurrent safety. (Architect record: PR #4 review comment 5466948346; labels `changes-requested`/`security`/`concurrency`/`architect-review`.)

**Fix** (design decision 7 above; no architecture change, no second authority, provider-neutral port preserved):

1. `IdentityStore.lockApplicationMemberships(applicationId)` replaces `countApplicationOwners` — the SQL adapter locks EVERY membership row of the application (`SELECT ... WHERE application_id = $1 ORDER BY id FOR UPDATE`) inside the same arbitration transaction as the mutation and returns the rows as committed at lock acquisition.
2. The service re-derives BOTH retention facts (target's CURRENT role + owner count) from the locked rows in `addMember`'s role-change path and `removeMember`'s deletion path. Pre-lock reads never drive the decision — this also closes the subtler stale-role window the architect's sequence implies but does not name: owner-set-only locking would let a concurrent member→owner promotion (an update to a not-yet-owner row) escape the lock domain while a stale pre-lock role read drives a deletion.
3. Every owner-count-REDUCING mutation now totally orders per application; under READ COMMITTED the loser's locked read re-evaluates each row's latest committed version after the winner commits, sees 1 owner, and rejects with `AUTHORIZATION_DENIED`. Inserts are additive and outside the lock domain.

**Red→green discrimination** (the mandated proof that the new tests detect exactly this flaw): the architect-mandated service-level concurrency tests were written FIRST and run UNCHANGED against the pre-fix implementation at `808010a` — they failed by committing zero-owner applications:

- first run: all 3 concurrency tests failed (`round 1: ... got 0 ... outcome {"fulfilled":-2}` — both demotions committed; `round 0` same for removals; `round 21` for the mixed pair)
- repeated reproduction: 4 further runs each committed at least one zero-owner application (1–2 failing tests per run; the race is real and timing-dependent)

The same tests, plus the deterministic serialization proofs, pass 100% at the remediation head (6 consecutive full-suite runs + 3 stress runs, zero flakiness), together with the retained single-owner rejection and same-role idempotent convergence (unit + PG).

**Identity binding (two-part model, as fixed during WORK-001)**: this evidence file binds the round-2 implementation head `a0a17bfc89192e3e6b06b1c25e9452787f5d29df` (the commit that contains the fix and at which the full gate re-ran green). The final branch head (this evidence commit — a commit cannot contain its own SHA) is bound in the PR body and the remediation report comment on PR #4, together with the CI run for that head. Merge identity remains reserved for post-merge finalization.

## PR / merge

- PR number: 4 (https://github.com/pectoraux/Zeck/pull/4)
- Architect review verdict: round 1 CHANGES REQUESTED (owner-retention concurrency, comment 5466948346) — remediated in round 2 at implementation head `a0a17bf`; round-2 verdict pending
- Merge commit: pending (architect merge authority; worker does not merge its own PR)
- Post-merge finalization revision: pending
