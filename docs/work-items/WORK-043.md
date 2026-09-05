# WORK-043 Evidence — Database and artifact production path

Work Order: `WORK-043` (spec/work-orders/WORK-043.md) · Canonical remote: **`payswapdotorg/Zeck`** · Canonical issue: **#3** · Assurance: **HIGH_ASSURANCE** · Governing architecture: Deployment & Runtime Architecture **D1.0** (subordinate to frozen v1.0), roadmap phase **D-02**.

Exact dispatch base: `c13aaa0924e12152487d38a36c3ef3c4f31fa58` (verified present; the worker branch was created at exactly that SHA and contains exactly **one** code commit + this evidence document on top of it; the merge-base is `c13aaa0…` exactly; zero merge commits). Branch: `work/WORK-043-database-artifact-production-path` · **Final head: this doc's commit** (the code commit `8a6c109` precedes it). One PR, opened by the worker, **not merged by the worker**.

## Baseline gate at the exact frozen base (readiness checkpoint — BEFORE implementation)

- **`python3 scripts/governance-check.py` FAILED at the dispatch base** — and at canonical main `565cb95` identically: `AssertionError: WORK-043 missing # Requirement IDs`. Root cause: the dispatch automation's `spec/work-orders/WORK-043.md` does not carry the mandatory Work Order template headings (`# Requirement IDs`, `# Declared Change Surfaces`, `# Scope Boundaries`, `# Implementation Requirements`, `# Required Checkpoint Contracts`, `# Checkpoints`). This is an **Architect-owned dispatch-state defect — report-only, never worker-fixed** (the worker may not modify governance material; the fix is the Architect's: bring WORK-043.md up to the template). Until then the repository's automated governance gate cannot be green on this lineage — **no green governance-gate claim is made here**. The two failing tests in every suite run are exactly this defect (identical at base and main).
- `bun run typecheck` — 0 errors at `c13aaa0`.
- `bun run lint` — biome clean (1027 files) at `c13aaa0`.
- Full suite with real PostgreSQL (`ZECK_PG_TEST_URL`, PG 16.4 at 127.0.0.1:55432) at exactly `c13aaa0`: **295 files / 4380 tests, 4378 passed, 2 failed** — the ONLY two failures are the inherited governance-state defect above. (Executed as the three sequential script invocations `test:unit` / `test:integration` / `test:architecture` — the same complete test set as `bun run test`; this sandbox enforces a per-command wall-clock limit. 159+72+76 files.)

## Provider account/resource access (readiness checkpoint)

**NOT RUN — no Neon, Cloudflare/R2, Composio or other provider credential exists in this worker environment.** The only credential held is the operator-provided GitHub PAT for `payswapdotorg/Zeck` (environment-only: stored in the worker shell and credential store, never in Git, logs, artifacts or this repository; used solely for the Git/PR lifecycle of this Work Order).

Consequences, per the evidence contract (never convert unavailable provider access into a PASS):

- **Live managed-Neon endpoint verification: NOT RUN** — no Neon credential material. The managed-PostgreSQL path is instead executed against **real PostgreSQL 16.4 over the identical wire protocol, driver, pool and transaction semantics** (the WORK-002/042 local-evidence convention), including the SSL-mode contract, the 16+ floor, deterministic migrations, pool bounds and transaction discipline. A Neon endpoint is a standard PostgreSQL endpoint; the adapter is provider-neutral by construction (no Neon-specific code exists anywhere — pinned by architecture tests). What remains genuinely unverified without a live endpoint: Neon-specific TLS/SCRAM negotiation and managed-side behavior under their proxy.
- **Live R2 endpoint verification: NOT RUN** — no Cloudflare credential material. The R2 adapter is verified: (a) the SigV4 core reproduces the **official AWS SigV4 test-suite vectors byte-exact** (`get-vanilla` signature `5fa00fa3…`, `post-vanilla` signature `5da7c1a2…` — pinned in `tests/unit/object-store/sigv4.test.ts`); (b) the full S3 protocol surface (put/get/delete/HEAD, header auth, **presigned GET/PUT query-auth flows**, typed fail-closed error mapping) executes end-to-end over **real HTTP against an in-process S3-compatible server that verifies every request signature** (`tests/integration/object-store/s3-protocol.test.ts`) — protocol correctness, explicitly NOT R2 evidence; (c) the real-R2 suite (`tests/integration/object-store/r2-live.test.ts`) is env-gated on `ZECK_R2_ENDPOINT` / `ZECK_R2_ACCESS_KEY_ID` / `ZECK_R2_SECRET_ACCESS_KEY` / `ZECK_R2_BUCKET` and **skips with the exact missing-variable reason** (visible in every run: 5 skipped tests).
- No provider resource in any non-GitHub account was mutated by this worker; no provider-account state is claimed in any direction.

## What this order IS

D-02: connect Zeck's **authoritative** PostgreSQL state and **artifact bytes** to managed production-grade services **behind the existing provider-neutral ports** — the production `DatabasePort` adapter with deterministic startup/migrations, the environment-materialization secret store, the S3-compatible (R2) `ObjectStorePort` adapter with SigV4 signing and presigned delegated flows, content-integrity verification, retention/cleanup safety, and the **executed** backup/restore drill. Authority never moves: PostgreSQL stays the sole durable authority; R2 stores bytes only; provider SDK/driver imports stay confined to their owning adapter directories; no queue transport (D-03), no orchestration (D-04), no worker fabric (D-05), no CI/CD/observability expansion (D-06).

## Acceptance-criteria mapping (Work Order §Acceptance Criteria)

| AC | Claim | Evidence |
|---|---|---|
| 1. Start against managed PostgreSQL with repository-defined configuration via the existing port | PASS (managed-wire-protocol real PG; live Neon NOT RUN — no credentials, see above) | `startAuthoritativeDatabase` (startup validation: connectivity → PG 16+ floor → migrations → convergence); `deploy:migrate` executed (24/24 applied, converged); integration `pg-database-port.test.ts` (startup + restart-safe); connection contract + env secret store units |
| 2. Deterministic migrations; startup fails closed on incompatible/unavailable authoritative state | PASS | Migration exactly-once/restart-safe proven (24 applied → 0 applied/24 skipped on rerun); below-16 floor rejected (discrimination, version-lying fake via the `portFactory` seam); unavailable endpoint → redacted `DatabaseUnavailableError` (real refused-endpoint test); unconverged schema → `StartupValidationError` (unit + convergence checks) |
| 3. Transaction boundaries + connection pool validated on the managed path | PASS | Integration: commit/rollback atomicity, original-error propagation, 20 parallel increments with zero lost updates, **pool bounds under parallel load** (max observed server-side concurrency ≤ configured ceiling; wall-time lower bound), closed-adapter fail-closed |
| 4. `ObjectStore` production R2 adapter/configuration without R2 concepts in domain modules | PASS | `s3-object-store.ts` behind the untouched `ObjectStorePort`; architecture B2/B6 (port contract unchanged; provider vocabulary confined to adapters/deploy; domain modules clean); zero new SDK dependencies (SigV4 over node:crypto+fetch — no `@aws-sdk` needed, boundary table unchanged) |
| 5. Signed/delegated flow where required; bytes never proxied through PostgreSQL | PASS (S3-protocol real-HTTP; live R2 NOT RUN) | Every request SigV4-signed (header auth); presigned GET/PUT query-auth URLs executed end-to-end (delegated upload/download, server-verified); architecture B1: the object-store plane imports nothing from the db plane (and vice versa) — bytes cannot cross the authority path |
| 6. Content hash-verified; integrity mismatches fail closed without corrupting authoritative metadata | PASS | `integrity.ts` wrapper: digest verified before transport (put) and after retrieval (get); tampering test (real HTTP) — mismatch reported, **nothing deleted or repaired**; discrimination: no-transport/no-mutation mutation-proofs |
| 7. Retention/cleanup explicit, bounded, unable to delete authoritative metadata | PASS | `retention.ts`: explicit-key-only (never listing/globbing), namespace + content-addressed key-shape guards, retained keys never deletable, **unconfirmed inventory refuses everything**, dry-run default, per-key failure reporting; architecture: the module has no database access at all (metadata is unreachable by construction) |
| 8. Real backup/restore executed; documentation alone insufficient | **PASS — EXECUTED** | The drill below (integration test + deploy tools, both executed against real PG) |
| 9. Provider outages never create a second authority or silent success | PASS | Provider failures are typed fail-closed errors (403/404/5xx → `S3ObjectStoreError`, status+code, no silent success — real-HTTP negative paths); DB unavailability fails closed (refused-endpoint test); smoke readiness: authoritative-not-ready ⇒ overall DOWN (WORK-042 model, unchanged); no fallback path exists anywhere (architecture B1) |
| 10. Evidence: exact revision, managed resources where non-secret, secret-reference validation, migration/pool/integrity results, restore proof, changed-file inventory | PASS | This document (identity `1c87a5f5…` at code head `8a6c109`; manifest/resource digests below; the file inventory at the end) |

## The executed restore drill (AC8 — the primary recovery evidence)

**Executed twice over real PostgreSQL 16.4 through the PRODUCTION adapter path** — once as the repository integration test (re-runnable by anyone with `ZECK_PG_TEST_URL`), once through the operator tools:

### Drill A — the integration test (`tests/integration/postgres/backup-restore-drill.test.ts`, executed in both full-suite runs)

1. **Seed authoritative state through the REAL module services** (`seedMediaWorld` over the real SQL stores: tenants, applications, environments, budgets/wallets/grants, deployment profiles/plans/deployments, executions) and complete a media job that **adopts an artifact** — the write-once adoption ledger row (`deployments.media_artifacts`: content digest, lineage parents, deployment linkage).
2. **Backup** through the port-based logical engine: **96 tables / 16 schemas / 24-migration history**, per-table sha256 content checksums, deterministic primary-key row ordering.
3. **Total source loss**: backends terminated, source database **DROP**ped; the dead source URL then proven fail-closed (startup error, redacted).
4. **Restore** into a fresh disposable database (`zeck_work043_restore_<random>`): deterministic migrations (24, the production startup path) → data restore in ONE transaction (`session_replication_role = replica` for exact historical state; `OVERRIDING SYSTEM VALUE` for identity columns) → **8 sequences re-seeded** from restored maxima.
5. **Verification (all deterministic)**: every one of the 96 tables re-read + re-hashed — row counts AND content checksums match the backup manifest; the adoption-ledger row is **byte-identical** to the backed-up row (digest, key, lineage, role, linkage); referential integrity across the restored chain (artifact → job → deployment → application → tenant — a five-table join resolves); the **budget wallet balance matches exactly**; total restored rows match; an identity-sequence-backed table **serves a NEW insert beyond the restored max** (no collision).
6. **Cleanup**: the disposable recovery target dropped and confirmed gone.

### Drill B — the operator tools (executed at the final code tree `8a6c109`)

```
bun run deploy:migrate  -- --environment local        → 24 applied, schemaConverged: true
bun run deploy:backup   -- --environment local --out … → 96 tables, 2 seeded authoritative rows, 24-migration history
bun run deploy:restore  -- --environment local --from … --drop
  → target zeck_restore_007492b88e88 (disposable-recovery class)
  → migrations 24 | tables restored 96 | rows restored 2 | sequences reseeded 8
  → verification: allTablesVerified=true across 96 tables
    (method: per-table re-read + sha256 content checksum + row count, deterministic)
  → cleanup: dropped=true
```

**Restore evidence statement (per the Work Order evidence contract):** source backup class = repository-owned logical manifest (`zeck-logical-backup` v1) produced through the `DatabasePort`; recovery target = fresh disposable database `zeck_restore_*` on the same managed-class server; exact tested revision/environment = `8a6c109` / real PostgreSQL 16.4 at 127.0.0.1:55432 (managed-wire path; live Neon NOT RUN, no credentials); validation = the deterministic checks in step 5 (all passed, both drills); recovered authoritative state = the full 96-table surface incl. the adoption ledger and budget authority (byte-identical checksums); cleanup = both disposable recovery resources dropped and confirmed; **no authoritative data was altered or lost** (the drill never writes back to any authoritative source; the live `zeck_local` database was untouched — it still holds its seeded rows after the drill).

**Design note (why port-based logical backup):** the shipped migrations ARE the DDL authority, so restore re-applies them deterministically and restores DATA only — no pg_dump binary dependency, works identically against any PostgreSQL 16+ endpoint (managed Neon included), and the whole procedure crosses the provider-neutral port. The backup artifact is data-only; Zeck state never contains secret plaintext (external materialization), so the artifact carries no credentials.

## Neon/PostgreSQL evidence (summary)

- Deterministic startup + migrations over the managed wire path: **PASS** (24/24 exactly-once; restart 0-applied/24-skipped; both full-suite runs).
- Compatibility floor + schema convergence (existing schema, unmodified — architecture B4 proves **zero new migrations**; D-02 is a compatibility consumer): **PASS**.
- Connection-pool bounds + transaction discipline: **PASS** (see AC3 row).
- Fail-closed unavailability with redacted diagnostics: **PASS** (real refused endpoint with credential-bearing URL — the error contains neither user nor password).
- `pg` promoted to a runtime dependency, confined by the pre-existing SDK boundary table to `src/platform/db/` (the two runtime-import assertions updated as the pre-announced mechanism): **PASS**.
- Live managed-Neon endpoint (TLS/SCRAM through Neon's proxy, managed console/branching): **NOT RUN — no Neon credentials in this worker environment.**

## R2/artifact evidence (summary)

- SigV4 correctness against the **official AWS test-suite vectors**: **PASS** (byte-exact signatures; canonicalization mutation discrimination).
- S3 protocol surface (put/get/delete/HEAD, header auth, presigned delegated GET/PUT, 404→null, 403/404/500 typed fail-closed) over real HTTP with server-side signature verification: **PASS** (9 tests).
- Artifact integrity (authoritative digest, fail-closed, no mutation): **PASS** (incl. the real-HTTP tampering test).
- Retention/cleanup safety envelope: **PASS** (deletes exactly the planned keys; retained/foreign/shape-violating keys refused; unconfirmed inventory refuses everything; dry-run default; per-key failure reporting — over real HTTP).
- Live R2 endpoint: **NOT RUN — no Cloudflare credentials in this worker environment** (the gated suite records the exact missing variables on every run).

## Failure/recovery evidence

- Provider 403 (bad credentials) / 404 (missing bucket) / 5xx → typed `S3ObjectStoreError`, no silent success: **PASS** (real-HTTP negative paths).
- Wrong presigned signature → server rejection: **PASS** (unsigned fetch rejected 403).
- Database unavailable → fail-closed typed error, redacted, no fallback authority: **PASS**.
- Transaction failure → rollback, original error, connection returned to the pool: **PASS**.
- A failing ROLLBACK never masks the original error: **PASS** (unit).
- Readiness honesty: provider concerns without materialized credentials report **unavailable with the exact reason** (smoke output verified: `ZECK_SECRET_DATABASE_URL_REF is not materialized…`, `ZECK_DATABASE_URL is not set…`); with materialization, the real probes execute (verified locally: relational-state ready through the production adapter; artifact-bytes ready through a signed HEAD against a local S3 endpoint).

## Security/secret evidence

- **Secret-exposure scans**: architecture B5 scans every new `src/` and `deploy/` source for credential-shaped literals (AWS keys, sk-/ghp- tokens, URL-embedded credentials): **PASS**; `deploy:validate`'s manifest secret-scan over the updated `variables.json`: **PASS** (valid, 25 variables, 0 problems).
- The secret-reference model: values are environment-only materialization (`ZECK_DATABASE_URL`, `ZECK_OBJECT_STORE_ACCESS_KEY_ID`, `ZECK_OBJECT_STORE_SECRET_ACCESS_KEY` — credentialShaped in the variable contract); the reference bindings (`ZECK_SECRET_*_REF`) stay non-secret URIs; cross-environment resolution rejected; error messages carry variable NAMES only — **proven by dedicated unit + discrimination tests**.
- Redaction at every diagnostic wrap point (adapter connect, startup, tools): **PASS** (discrimination test scrubs credential shapes end-to-end).
- No credential material in Git: the working tree was scanned; nothing is committed beyond names/metadata (`git diff` verified — no URLs, keys or tokens in the diff).
- Backup artifacts: data-only, written to operator-controlled paths, disposed with the drill.

## Governance result

`python3 scripts/governance-check.py` — **FAILED at base `c13aaa0`, at main `565cb95`, and on this branch, identically**: `WORK-043 missing # Requirement IDs` (the dispatch-state defect disclosed at the top). Architect-owned; the worker did not touch `spec/development-state/*` or any governance material (the branch diff contains **zero** `spec/` changes — mechanically verified).

## Typecheck / lint / test results (at the final code tree `8a6c109`)

- `bun run typecheck` — **0 errors**.
- `bun run lint` — **biome clean (1027 files checked, 0 problems)**.
- `bun run deploy:validate` — **valid** (4 environments / 6 providers / 10 resource kinds / **25 variables** / 4 secret-reference inventories, 0 problems).
- Deployment identity at `8a6c109`: `identityId 1c87a5f5ab09116c9a12427d9fb593c78a757ad6c27de7951f6a194f07c870be`, `manifestDigest ce5a884e…`, `resourceDigest 96d1c34f…` (unchanged resource set; the manifest digest legitimately moved with the six new D-02 variables — content-addressed by design; `deploy:smoke` identity attestation passes).
- One latent test defect fixed (disclosed): WORK-042's tampered-identity discrimination test constructed its forgery as `0${id.slice(1)}`, which silently no-ops when the digest already begins with `0` — a 1/16 hash coincidence that this order's manifest addition triggered. The construction is now guaranteed-different (`0`×64 vs `1`×64); the protection it proves is unchanged and strengthened.

## Full-suite run 1 (three sequential script invocations, real PG via `ZECK_PG_TEST_URL`)

- `test:unit` — 159 files / **2517 tests, 2517 passed**.
- `test:integration` — 72 files / **814 tests: 808 passed, 1 failed, 5 skipped** (the failure = `fresh-clone-governance` on the inherited governance-state defect; the 5 skips = the real-R2 suite recording NOT RUN with the exact missing-variable reasons).
- `test:architecture` (incl. discrimination) — 76 files / **1057 tests: 1055 passed, 1 failed, 1 skipped** (the failure = the governance-gate negative control on the same inherited defect; the skip pre-exists this order).
- **Total: 307 files / 4388 tests — 4380 passed, 2 failed (both the inherited governance defect, identical at the base), 6 skipped (5 × R2 NOT RUN + 1 pre-existing).**

## Full-suite run 2 (consecutive, same tree, same environment)

- `test:unit` — 159 files / **2517 tests, 2517 passed**.
- `test:integration` — 72 files / **814 tests: 808 passed, 1 failed, 5 skipped** (same inherited defect; same R2 NOT RUN reasons).
- `test:architecture` — 76 files / **1057 tests: 1055 passed, 1 failed, 1 skipped** (same).
- **Total: 307 files / 4388 tests — 4380 passed, 2 failed (identical to run 1), 6 skipped.** Runs 1 and 2 are byte-identical in outcome. (An earlier integration sweep showed one transient WORK-027 full-load flake — `computer-use-lifecycle` concurrency convergence — which passes 17/17 in isolation and did not recur in either recorded final run; disclosed for completeness, same class as the WORK-042 precedent.)

## NOT RUN / NOT APPLICABLE evidence

- **NOT RUN — live managed-Neon endpoint**: no Neon credentials in this worker environment (exact reason); the managed-wire-path alternative executed over real PostgreSQL 16.4 is recorded above, including what remains genuinely unverified (Neon TLS/SCRAM negotiation through their proxy, managed console/branching behavior).
- **NOT RUN — live Cloudflare R2 endpoint**: no Cloudflare credentials (exact reason); protocol correctness is proven against the official AWS SigV4 vectors + a signature-verifying local S3-compatible server; the env-gated real-R2 suite is committed and records its skip reason on every run.
- **NOT RUN — provider resource provisioning execution** (creating the Neon project/branch, the R2 bucket): account-plane work outside the D-02 runtime credentials; `deploy:bootstrap` provider plans remain plan-only by design (the message updated to state this precisely).
- **NOT APPLICABLE — new artifact-lifecycle schema**: D-02 is a compatibility consumer of the existing schema (architecture B4: zero new migrations); the retention tool's authority input is an explicit contract (inventory + confirmed decisions) rather than speculative tables — the owning Work Order for artifact lifecycle domain semantics will add that surface.
- **NOT APPLICABLE — D-03/D-04/D-05/D-06 surfaces**: queue transport, durable orchestration, worker deployment fabric, release/observability expansion — out of scope, untouched.

## Changed-file inventory (39 files; `git diff --name-status c13aaa0..HEAD`)

**New platform adapters (src/): 11**
- `src/platform/db/connection.ts` — repository-defined connection contract (URL validation, pool bounds, redaction)
- `src/platform/db/pg-database-port.ts` — the production `DatabasePort` adapter (pg pool, transaction discipline)
- `src/platform/db/startup.ts` — deterministic startup validation (floor, migrations, convergence) + the `portFactory` test seam
- `src/platform/db/errors.ts` — the fail-closed DB error taxonomy
- `src/platform/db/backup.ts` — the logical backup/restore engine (checksums, atomic restore, sequences, self-verification)
- `src/platform/object-store/sigv4.ts` — the pure SigV4 core (header + query auth)
- `src/platform/object-store/s3-object-store.ts` — the S3-compatible (R2) `ObjectStorePort` adapter + presigned flows
- `src/platform/object-store/integrity.ts` — the hash-verified wrapper
- `src/platform/object-store/retention.ts` — the bounded, guarded retention sweep
- `src/platform/secret-store/adapters/env-secret-store.ts` — the environment-materialization secret store

**New deploy tooling: 3**
- `deploy/migrate.ts`, `deploy/backup.ts`, `deploy/restore.ts`

**New tests: 15**
- `tests/unit/db/{connection,pg-database-port,startup,backup}.test.ts` (4)
- `tests/unit/object-store/{sigv4,s3-object-store,integrity,retention}.test.ts` (4)
- `tests/unit/secret-store/env-secret-store.test.ts` (1)
- `tests/integration/postgres/{pg-database-port,backup-restore-drill}.test.ts` (2 — the drill is the executed restore proof)
- `tests/integration/object-store/{s3-protocol,r2-live}.test.ts` + `lib/fake-s3-server.ts` (3)
- `tests/discrimination/production-paths.discrimination.test.ts` (1)
- `tests/architecture/d02-production-paths.test.ts` (1)

**Modified: 10**
- `deploy/manifests/variables.json` (+6 D-02 runtime variables: the three credential-shaped materialization values and the object-store endpoint/bucket/region configuration)
- `deploy/smoke.ts` (real provider probes for the D-02 concerns when materialized; honest unavailability otherwise)
- `deploy/bootstrap.ts` (plan message corrected: provisioning is account-plane, runtime adapters landed)
- `deploy/README.md` (the D-02 runtime-configuration and backup/restore operator paths)
- `src/platform/README.md` (the landed-adapters statement, replacing the "ports only for now" note)
- `package.json` + `bun.lock` (`pg` promoted to runtime dependency, exact-pinned 8.16.3; +3 deploy scripts — a superset per the toolchain contract)
- `tests/architecture/provider-sdk-boundaries.test.ts`, `tests/architecture/dependency-direction.test.ts` (the two runtime-import assertions gain `pg` — the pre-announced SDK-arrival mechanism)
- `tests/discrimination/deployment-foundation.discrimination.test.ts` (the latent tamper-construction fix disclosed above)

**Explicitly NOT changed:** `spec/**` (zero diff — including `spec/development-state/*`), the frozen `ObjectStorePort`/`DatabasePort` contracts, `src/modules/**`, `src/api/**`, all 24 shipped migrations, `.env.example` (vestigial, untouched).

## Completion

The worker opened exactly one PR against `main` and does not merge it. Architect review, merge, exact-head verification and post-merge state finalization are mandatory. The remaining operator-facing steps to reach live managed infrastructure (recorded, not executable here): materialize the Neon/R2 resources and credentials per `deploy/README.md`'s D-02 section, then run `deploy:migrate` + `deploy:smoke` — every probe is already wired and honest about what is and is not attested.
