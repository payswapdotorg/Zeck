# WORK-048 Evidence — Resilience, disaster recovery and provider exit

Work Order: `WORK-048` (`spec/work-orders/WORK-048.md` on `main` at the dispatch base — the canonical dispatch) · Canonical remote: **`payswapdotorg/Zeck`** · Assurance: **HIGH_ASSURANCE** · Governing architecture: frozen v1.0 + Deployment & Runtime Architecture **D1.0** · Roadmap phase **D-07**.

## Dispatch, branch and ancestry

Exact dispatch base: `e5efa7efe7f54c9744228b991a85d25da7a7869d` (the D-06 merge; verified — the required branch `work/WORK-048-resilience-disaster-recovery-provider-exit` was confirmed at exactly that SHA before any change). Final implementation head: **`55d518bfc3f5e0bea975045f23e3cc485081bd91`** (the last implementation commit; the branch carries it plus this evidence document on top). **14 commits, ZERO merge commits, ZERO `spec/` changes** (mechanically verified: `git log --merges e5efa7e..HEAD` → 0; `git diff --name-only e5efa7e..HEAD -- spec/` → 0). One PR, opened by the worker, **not merged by the worker**.

## Baseline gate at the exact dispatch base (readiness checkpoint — BEFORE implementation)

Executed at exactly `e5efa7e` before any change:

- **`python3 scripts/governance-check.py` PASSED** — `Governance OK: 48 Work Orders, 102 requirements, inFlight=[], frontier=['WORK-048']`.
- `bun run typecheck` — 0 errors.
- `bun run lint` — biome clean, exit 0.
- `bun run test:unit` — **171 files / 2623 tests, all passed**.
- `bun run test:integration` with real PostgreSQL 16.4 (`ZECK_PG_TEST_URL`, 127.0.0.1:55432) — **99 files / 1006 passed | 13 skipped** (the live-provider honesty skips: R2/runner live endpoints unconfigured).
- The PostgreSQL 16.4 server was built from source and run rootless at 127.0.0.1:55432 for this Work Order (the same instance prior workers used).

## Provider account/resource access (readiness checkpoint)

**NOT RUN — no Cloudflare (R2/Queues), no Vercel, no Neon (or other live provider) credential exists in this worker environment.** The only credential held is the operator-provided GitHub PAT for `payswapdotorg/Zeck` (environment-only; used solely for the Git/PR lifecycle of this Work Order).

Consequences, per the evidence contract (never convert unavailable provider access into a PASS):

- **Live R2 → live alternate S3-compatible migration: NOT RUN.** The substitution is proven at PROTOCOL level: two REAL S3-compatible HTTP endpoints (the in-process fake-s3 server that verifies every request's SigV4 signature) driven through the REAL `createS3ObjectStore` adapter, with the artifact inventory from the REAL PostgreSQL adoption ledger (`tests/integration/postgres/recovery-artifact-exit.test.ts`). The `deploy:drill artifact-exit` CLI refuses to run without the alternate endpoint's configuration (exit 2 with the exact missing variable names — verified executed: **NOT RUN, never claimed as PASS**).
- **Live managed-PostgreSQL → alternate managed PostgreSQL: NOT RUN** as a live cross-provider move. The substitution mechanism is proven over real PostgreSQL: the restore drill backs up the live authority and restores into a FRESH PostgreSQL target (deterministic migrations + one-transaction data restore + self-verification + the D-07 invariant gate) — the same engine any managed PostgreSQL endpoint runs (`recovery-authority-restore.test.ts` + the executed `deploy:drill authority-loss` on the local real server). Provider substitution is a connection URL + credentials, zero code.
- **Live Vercel → alternate web/API host: NOT RUN** (no provider credentials). The web/API hosting exit is a deployment-level property by construction: the server is a repository-defined image/entry with no provider-specific domain semantics (B2/B3 architecture proofs: no vendor vocabulary in the recovery plane or the domain modules; `docs/DEPLOYMENT-ARCHITECTURE.md` D1.0). It is executed by the operator from the target environment — never claimed as exercised here.
- **Live queue-transport republish: NOT RUN** (no queue credentials). The transport-loss recovery is proven over real PostgreSQL with the REAL dispatcher machinery and the REAL in-memory transport contract (the message-losing double is the transport provider's worst case): total loss converges through the executions authority with zero duplicate effects (`recovery-transport-replay.test.ts`). The CLI's republish half reports honestly (`deploy:drill queue-recovery --environment local` executed: the plan half ran, the republish half is **NOT RUN** — printed in `notRun`, never claimed as PASS).
- No provider resource in any non-GitHub account was mutated by this worker.

## What this order IS

D-07: resilience, disaster recovery and provider exit — PostgreSQL stays the SOLE durable authority through every drill (recovery RESTORES authority, never reconstructs it from providers); the executed restore drill with the recovered-authority invariant gate; artifact-byte recovery and the R2 → alternate S3-compatible substitution proof (content-addressed keys, digest-verified at both ends, lineage-preserving); queue/workflow replay after total transport/orchestration loss (converging through the EXISTING dispatch/execution idempotency, never provider dedup); regional worker evacuation/drain/fencing over the durable leases with restartable reassignment; provider-outage simulation that fails closed with the owning adapter's typed error classes; repository-truth RTO/RPO targets with measured drill evidence; the `deploy:drill` operator surface + runbooks (the self-hosting boundary). No frozen-v1.0 change, no second authority, no D-08 scope.

## Acceptance-criteria mapping (Work Order §Acceptance Criteria)

| AC | Claim | Evidence |
|---|---|---|
| 1. Authoritative PostgreSQL state restored from repository-defined procedures and verified against expected invariants | PASS (real PG) | `recovery-authority-restore.test.ts`: the executed drill — REAL module-service seed → WORK-043 logical backup (per-table sha256) → fresh disposable target → deterministic migrations + one-transaction restore + self-verification → the D-07 invariant gate (12 checks: migration history, queue vocabularies + consumed⇒applied, single live claim, worker vocabulary, wait vocabulary + instance binding, execution state vocabulary, gapless event ledgers, budget non-negativity, adoption digest shape + chain resolution) → measured RTO/RPO within the local target. Executed CLI: `deploy:drill authority-loss --environment local` → `recovered: true`, backup 113 tables / 28 migrations, all-restored-verified, 12 checks 0 violations, cleanup dropped, **RTO 1692ms / RPO 0ms within local 900000ms/0ms, exit 0**. Discrimination: gapped ledger / out-of-vocabulary status / negative wallet FAIL the gate (unverified recovery never declares recovery, no RTO claim, fail-closed phase ordering); a tampered backup artifact fails the restore self-verification (typed `RestoreVerificationError`) |
| 2. Durable artifacts recovered after provider loss with preserved identity and lineage | PASS (real PG + 2 real S3-compatible endpoints) | `recovery-artifact-exit.test.ts`: the adoption ledger (REAL media services) is the inventory; bytes = the artifact's canonical-identity bytes (sha256 = authoritative digest); migration primary → alternate through the REAL adapter against two REAL SigV4-verifying endpoints; verification at target + lineage preservation against PG; idempotent re-run (already-intact). Discrimination: source loss, source drift, target identity collision (never overwritten), read-after-write lying store, incomplete restore (missing at target), lineage drift — each a typed failure, `completed/recovered: false` |
| 3. Queue/workflow replay after transport/orchestration loss without duplicating durable effects | PASS (real PG) | `recovery-transport-replay.test.ts`: R1 — total transport loss (message-losing double delivers nothing forever) + interrupted in-flight workers; the durable plan classifies published-unapplied as re-drive; a fresh worker's authority-driven recovery converges both executions with EXACTLY ONE provider dispatch and EXACTLY ONE `execution.pass` event per execution, fresh lease epochs (stale pairs fenced). R2 — outage → typed transient failures → bounded backlog → `republishPending` through the real transport → worker convergence → the plan ends consumed⇒applied (converged). R5 — orchestration provider REPLACED: fresh coordinator over the same durable waits; recoverPending re-drives the recorded start onto the new provider. R4 — the plan is authority-only (provider message state invisible); an out-of-vocabulary state is a fail-closed error |
| 4. Regional worker evacuation drains/fences and allows restartable reassignment without stale-worker mutation | PASS (real PG) | `worker-evacuation.test.ts` (E1–E6): fence mode retires identities, abandons live claims (`worker-lost`) and FORCE-RELEASES live leases — the stale workers' completion guard and renewal BOTH fail (`lease-released`/`stale`); drain mode drains first (`worker-drained`); restartable reassignment converges with exactly one dispatch; region selectivity; idempotent re-run is a bounded no-op; unknown regions fail closed. CLI executed: `worker-evacuation --region region-a` on the empty local authority → the honest fail-closed refusal |
| 5. At least one alternate per critical provider category (artifact storage, managed PostgreSQL, web/API hosting) | PASS (protocol-level + construction; live providers NOT RUN) | Artifact storage: the two-endpoint substitution drill (above). Managed PostgreSQL: the fresh-target restore drill is the substitution engine (endpoint+credentials only; verified over real PG 16.4). Web/API hosting: the server is provider-neutral by construction (architecture proofs B2/B3 — no vendor vocabulary; the runbook documents the configuration-only exit). Live-provider executions explicitly NOT RUN |
| 6. Provider outage simulation fails closed; recovery stays governed by authoritative state | PASS (real PG) | `recovery-outage.test.ts`: database outage — every port operation (query AND transaction) fails with `DatabaseUnavailableError`; the frozen transition semantics REFUSE to run against a dead authority; after `end()` the SAME authority resumes (state unchanged). A drill hit by the outage records the failure, stops (later phases never run), `recovered: false`, no RTO claim. Queue outage (R2) and object-store outage (A2, typed 5xx — never a silent null) proven in their suites; the outage wrappers are provider-neutral by construction (discrimination suite) |
| 7. RTO/RPO targets documented with exact drill evidence per environment | PASS | `deploy/manifests/recovery-targets.json` (repository truth, fail-closed parsing — `rto-rpo.test.ts`: bounded numeric targets + measurement procedure for local/ci/preview/staging/production; every environment of the environments.json matrix covered, enforced by `deploy:validate` rule 9). Measured evidence: the local environment's targets measured by the executed CLI drills and the integration suites (RTO 1692ms / RPO 0ms within 900000/0); the plan/evacuation drills report measured objectives per execution; provider environments measured by executing the same drills there (never claimed without execution) |
| 8. Recovery repeatable by a self-hosted operator with repository tools | PASS | `deploy/drill.ts` (five commands, fail-closed, NOT RUN vocabulary) + `bun run deploy:drill` wiring + `docs/runbooks/` (README index + one runbook per scenario: preconditions, procedure, success criteria, failure handling); the runbooks and tooling are mechanically asserted (boundary test B9/B11). Executed locally: outage-readiness (exit 0, targets + validation), authority-loss (exit 0), queue-recovery (plan half; republish honestly NOT RUN), worker-evacuation (fail-closed refusal on an unregistered region), artifact-exit (NOT RUN refusal with the exact missing variables) |

## Required checkpoints

- **AUTH-PRESERVATION** — the recovery plane queries platform schemas only; module-private tables (executions/budgets/deployments) are consumed through the declared module-side seams (`evacuation-seam`, `recovery-invariants` ×2, `recovery-inventory`); the recovery plane's own SQL is read-only classification; evacuation writes only through the owning platform store ports + the lease seam (boundary test B1/B3/B5; the write-path gate passes with zero violations).
- **IDENTITY-IDEMPOTENCY** — content-addressed storage keys derived from the authoritative digest; migration is idempotent (already-intact); replay converges with exactly one dispatch/completion per execution (deterministic correlation keys, the single write path); re-running an evacuation is a bounded no-op.
- **CONCURRENCY-CRASH-SAFETY** — stale-worker fencing at the durable lease guard (E1–E3, C-matrix conventions); fresh lease epochs; the recovery re-drive is durable-state-driven with no queue involvement.
- **EXTERNAL-SIDE-EFFECTS** — outage wrappers fail with the owning adapter's typed classes (never silent null/success); migration never overwrites a target collision; unverified recovery refuses.
- **EXECUTION-PROVENANCE** — the restored authority's event ledgers are gapless (incomplete restore DETECTED); the consumed⇒applied transport boundary holds after replay; artifact lineage stays resolvable across the migration.
- **SELF-HOSTING-BOUNDARY** — the drill CLI + runbooks are repository mechanisms over provider-neutral ports; secrets are environment-materialized only (B6/B10: no credential-shaped literals; the drill variables declared with correct `credentialShaped` flags).
- **IMPLEMENTATION-COMPLETENESS** — this evidence package: every AC mapped to exact-revision implementation + drill results; forbidden surfaces untouched (zero `spec/` changes, zero frozen-semantics changes, the minimal module seam set declared and mechanically bounded).

## Test battery and implementation evidence

The D-07 battery at the final implementation head `55d518b` (**all green, one consecutive run each**):

- `bun run typecheck` — 0 errors.
- `bun run lint` — biome clean, exit 0.
- `python3 scripts/governance-check.py` — `Governance OK: 48 Work Orders, 102 requirements, inFlight=[], frontier=['WORK-048']`.
- `bun run test:unit` — **173 files / 2636 tests passed** (includes the new recovery-targets + drill-runner unit suites).
- `bun run test:integration` (real PostgreSQL 16.4, `ZECK_PG_TEST_URL` @ 127.0.0.1:55432) — **104 files / 1027 passed | 13 skipped** (the live-provider honesty skips unchanged from the base).
- `bun run test:architecture` — **86 files / 1148 passed | 4 skipped** (includes the new `d07-resilience-boundaries` gate and the new `resilience-recovery.discrimination` suite).

New D-07 tests: **63** (4 evacuation + 3 authority-restore + 8 artifact-exit + 4 transport-replay + 2 outage + 13 unit + 18 discrimination + 11 architecture).

The executed CLI drills (real local PostgreSQL, `zeck_local` authority, 28/28 migrations):

- `deploy:drill outage-readiness --environment local` → `recovered: true`; deployment validation valid (74 variables, 28 migrations, **recoveryTargetEnvironments: 5**); exit 0.
- `deploy:drill authority-loss --environment local` → `recovered: true`; backup 113 tables / 28 migrations; disposable restore target verified; 12 invariant checks, 0 violations; cleanup dropped; **measured RTO 1692ms / RPO 0ms, both within target**; exit 0.
- `deploy:drill queue-recovery --environment local` → the recovery-plan half `recovered: true`; the republish half honestly **NOT RUN** (no transport configuration — printed in `notRun`); exit 0.
- `deploy:drill worker-evacuation --environment local --region region-a` → the fail-closed refusal (`no workers are registered for region "region-a"` — the populated-authority matrix is the integration suite's E1–E6).
- `deploy:drill artifact-exit --environment local` → **NOT RUN** refusal (missing `ZECK_DRILL_ALTERNATE_OBJECT_STORE_*`; exit 2; never claimed as PASS).

## Changed-file inventory (32 implementation files, +6103/−3, plus this evidence document)

Declared Change Surfaces only — recovery/restore tooling, artifact-recovery adapters, queue/workflow replay tooling, evacuation controls, outage harnesses, alternate-provider configuration, RTO/RPO evidence, D-07 tests, operator runbooks, and the declared minimal module seams:

- **Platform recovery plane** (`src/platform/recovery/`): `evacuation.ts`, `outage.ts`, `artifact-recovery.ts`, `transport-recovery.ts`, `authority-verification.ts`, `rto-rpo.ts`, `drill.ts`.
- **Declared module seams** (the worker-fabric precedent — module adapters implementing platform seam types over their own private tables): `src/modules/executions/adapters/evacuation-seam.ts`, `src/modules/executions/adapters/recovery-invariants.ts`, `src/modules/budgets/adapters/recovery-invariants.ts`, `src/modules/deployments/adapters/recovery-inventory.ts`.
- **Operator tooling**: `deploy/drill.ts`, `deploy/manifests/recovery-targets.json`, `deploy/manifests/variables.json` (5 drill variables, credential flags), `deploy/validate.ts` (rule 9: recovery targets per environment), `package.json` (`deploy:drill`).
- **Runbooks**: `docs/runbooks/README.md` + the five scenario runbooks.
- **Tests**: `worker-evacuation.test.ts`, `recovery-authority-restore.test.ts`, `recovery-artifact-exit.test.ts`, `recovery-transport-replay.test.ts`, `recovery-outage.test.ts`, `tests/unit/platform/recovery/{rto-rpo,drill-runner}.test.ts`, `tests/discrimination/resilience-recovery.discrimination.test.ts`, `tests/architecture/d07-resilience-boundaries.test.ts`, `worker-world.ts` (the region-metadata seam for evacuation selection).

Zero changes to frozen semantics, zero `spec/development-state/*` changes, zero migrations (D-07 is procedure + tooling over the existing durable schemas).

## Known limitations (honest boundaries)

- Live R2, live alternate object store, live Vercel/alternate host, live managed-PostgreSQL cross-provider move, live queue transport: **NOT RUN** (no credentials) — the protocol-level and real-PostgreSQL proofs above are the executed evidence; the provider environments' RTO/RPO are measured by executing `deploy:drill` there (the targets file states this explicitly).
- The corrupted-state discrimination simulations use `session_replication_role = replica` (the same mode the restore engine itself uses) and targeted CHECK-guard suspension on disposable drill targets — the honest way to produce the state a foreign/broken restore leaves behind; the drifted schemas are always dropped with the disposable target.
- The artifact-exit drill's byte-level live evidence over real provider endpoints will be produced by the operator environments; the local substitution proof uses two real S3-compatible protocol endpoints (SigV4-verified).
