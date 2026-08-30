# WORK-002 Evidence — Identity, applications and tenant isolation

Status: IN REVIEW — implementation complete on `work/WORK-002-identity-tenants`; PR open; architect review and merge pending.

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
- Implementation head: `496f890e820ee7480d1c5844494321b1b18b26c3` (the full verification gate below ran at exactly this revision; the final branch head carrying this evidence file is bound in the PR body — a commit cannot contain its own SHA)
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

## Verification

All commands run at implementation head `496f890e820ee7480d1c5844494321b1b18b26c3` with Bun 1.3.4 (CI-pinned) and PostgreSQL 16.4 (real server; embedded zonky build started outside the repository — `IMPLEMENTATION.md` §1 allows "Testcontainers (or equivalent real PostgreSQL)"):

- Governance check: `python3 scripts/governance-check.py` → `Governance OK: 20 Work Orders, 45 requirements, frontier=[]` (exit 0)
- Deterministic install: `bun install --frozen-lockfile` → no changes (68 installs across 117 packages)
- Typecheck: `bun run typecheck` → exit 0 (strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`)
- Lint: `bun run lint` → exit 0 (Biome, 163 files, no findings)
- Unit: `bun run test:unit` → 51/51
- Integration (no PG configured): `bun run test:integration` → 7 passed, 5 skipped (the PG suites skip with an explicit reason when `ZECK_PG_TEST_URL` is unset — honest skip, not silent)
- Architecture + discrimination: `bun run test:architecture` → 67/67 (includes the repaired governance-gate discrimination suite)
- Real PostgreSQL: `ZECK_PG_TEST_URL=postgres://zeck@127.0.0.1:55432/postgres bun run test:pg` → 23/23 against PostgreSQL 16.4:
  - migration-runner: applied+tracked, exactly-once rerun, checksum/renamed/reordered fail-closed, forward migration atomicity, statement splitting
  - schema-constraints: anti-ambiguity unique, membership composite FK rejection, environment composite FK rejection, tenant-scope shape CHECK, tenant-scoped slug namespaces, ledger partial-unique arbitration keys (application-scoped keys actor-independent; actor-scoped keys per-actor)
  - tenant-isolation: two-tenant matrix with journaled stores (no downstream write on rejection), scope derived from durable rows, cross-tenant environment fetch rejected, cross-tenant write structurally impossible through the command surface
  - idempotency: replay identity, `IDEMPOTENCY_KEY_REUSED` on fingerprint mismatch, concurrent identical requests converge to ONE durable tenant (two independent pools racing), crash atomicity (simulated failure before commit leaves NO ledger row, NO tenant; clean retry succeeds)
  - ownership: tenant creation provisions tenant-scope owner; application creation requires it; role matrix (member read-only, admin writes); duplicate convergence; owner-retention then valid removal; actor provisioning convergence
- CI: GitHub Actions runs the same suites without PG (PG suites skip visibly); the real-PG evidence is this locally-executed record (see known limitations)

## Checkpoint evidence

Applicable blocking contracts from `spec/governance/checkpoint-contract.json`:

- `IMPLEMENTATION-COMPLETENESS` — acceptance criteria 1–5 each implemented and mapped to passing tests (table above); full gate green including real-PG verification.
- `IDENTITY-IDEMPOTENCY` — proof classes static+dynamic+discrimination: static (ledger schema, dual partial uniques, port contracts), dynamic (replay/reuse/convergence on real PG), discrimination (fingerprint-check mutation replaying wrong outcome is exactly what the real port rejects; proven in `tests/discrimination/tenant-isolation.discrimination.test.ts`).
- `CONCURRENCY-CRASH-SAFETY` — dynamic proof on real PG: concurrent identical mutations converge via unique-index transactional arbitration (independent pools); crash before commit leaves zero partial state; retry is clean. Migration runner is advisory-lock serialized and exactly-once.
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

## PR / merge

- PR number: 4 (https://github.com/pectoraux/Zeck/pull/4)
- Architect review verdict: pending
- Merge commit: pending (architect merge authority; worker does not merge its own PR)
- Post-merge finalization revision: pending
