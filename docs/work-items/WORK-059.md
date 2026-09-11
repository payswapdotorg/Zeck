# WORK-059 Evidence — Advanced Audit and Compliance Controls (D-08 / SEC-004)

Work Order: `WORK-059` (`spec/work-orders/WORK-059.md` on `main` at the dispatch base — the canonical dispatch) · Canonical remote: **`payswapdotorg/Zeck`** · Assurance: **HIGH_ASSURANCE** · Governing architecture: frozen v1.0 + D1.0 (ACR-002) + ADR-0021 / ACR-005 (D-08 extension) · Binding requirement **SEC-004** (advanced audit and compliance controls) · Roadmap phase **D-08, wave A** (parallel with WORK-057 / WORK-058, disjoint surfaces).

## Dispatch, branch and ancestry

Exact dispatch base: `1a86262511e8d91286a98f26cdb6189d67281e3a` (main's head at dispatch — the D-08 UNLOCK commit; verified with `git rev-parse 1a86262^{commit}` before any change). Final implementation head: **`2281db2`** (the test-suite commit; the branch then carries the documentation on top — runbook `7fc1d6d` + this evidence file). **5 commits (4 implementation + 1 runbook; + this evidence doc), ZERO merge commits, ZERO `spec/` changes** (mechanically verified: `git log --merges 1a86262..HEAD` → 0; `git diff --name-only 1a86262..HEAD -- spec/` → 0). Required branch: `work/WORK-059-audit-compliance-controls` (confirmed at exactly the base SHA before any change). The worker does not merge.

## Baseline gate at the exact dispatch base (readiness checkpoint — BEFORE implementation)

Executed at exactly `1a86262` before any change:

- `python3 scripts/governance-check.py` — **PASSED**: `Governance OK: 60 Work Orders, 110 requirements, inFlight=[], frontier=['WORK-057', 'WORK-058', 'WORK-059']` (WORK-059 frontier-eligible — the runbook's eligibility confirmation).
- `bun install` — clean.
- Real PostgreSQL 16.4 (embedded zonky build started outside the repository at `127.0.0.1:55432`, the prior workers' convention; `ZECK_PG_TEST_URL=postgres://zeck@127.0.0.1:55432/postgres`).

## External-infrastructure access (readiness checkpoint)

**NOT RUN — no external compliance SaaS, SIEM, e-discovery or audit-log shipping target exists in this worker environment, and none is required by this Work Order** (the export is a typed, verifiable, self-contained object; SELF-HOSTING-BOUNDARY below). The only credential held is the operator-provided GitHub PAT for `payswapdotorg/Zeck` (environment-only, used solely for the Git/push lifecycle; verified absent from every committed file — `grep -rn "ghp_4Tcb\|payswapdotorg:ghp" src/ tests/ docs/ deploy/` → empty). No provider resource in any non-GitHub account was mutated.

## What this order IS

The D-08 audit/compliance plane on the `audit` module (SEC-004): a typed, append-only audit projection of governed actions with the full who/what/when/why provenance chain, observed through EXISTING seams only (executions lifecycle create/transition, the policy-admission authorize seam, the optimization decision-record append seam) plus the audit plane's own governed procedures (compliance export, legal hold, retention policy, governed purge); hash-chained integrity with gapless per-application chains and purge-manifest-aware verification; governed, bounded compliance exports with verifiable chain proofs; bounded retention with a governed, evidenced purge as the ONLY deletion path; legal holds that suspend expiry for their scope, themselves audited. **Audit is evidence, never authority**: no code path consults the projection; no second ledger of governed state exists; authoritative state stays in the existing module stores.

## Acceptance-criteria mapping (Work Order §Acceptance Criteria)

| AC | Claim | Evidence |
|---|---|---|
| 1. Typed append-only audit projection with DB-enforced immutability (mutation attempts rejected, proven by test) | PASS | `src/modules/audit/domain/record.ts` (the typed `AuditRecord`: actor/action/target/when/why + provenance, content-addressed `recordId` over the canonical identity form, `recordDigest` over the full record) + migration `0031_audit_compliance.sql` (physically append-only: row-level trigger rejects UPDATE and ungated DELETE, statement-level trigger rejects TRUNCATE — verified live before writing the migration; the ONLY deletion path is the governed purge under the transaction-local `audit.governed_purge` session gate). Proven by test over REAL PostgreSQL: `audit-schema.test.ts` (UPDATE rejected `/append-only/`, ungated DELETE rejected `/governed retention purge/`, TRUNCATE rejected, gate auto-resets after commit) and `audit-chain.test.ts` (hand-crafted INSERT rows are legal — only mutation is not — but a forged-digest row is rejected at read time by the store's total row validation) |
| 2. Hash-chained integrity verification (tamper detection proven by mutation test) | PASS | `domain/chain.ts`: `verifyAuditChain` is pure and deterministic — every record re-validated (both digests), gapless linkage checked, purge gaps must be exactly manifest-covered with the link digest matching the highest purged position, overlapping manifests (double purge) detected, tampered manifests rejected (commitment must cover entries). Mutation proofs: unit `chain.test.ts` (tampered content → `record-invalid`; re-signed forged predecessor → `chain-link-broken`; uncovered gap → `chain-gap-uncovered`; tampered manifest → `manifest-invalid`; overlapping manifests → `manifest-overlap`); integration over real PG: tampered durable row rejected at read; the full durable chain verifies after concurrent appends and after governed purges |
| 3. Compliance export with verifiable chain proof (round-trip verification test) | PASS | `domain/export.ts` (`buildComplianceExport`/`verifyComplianceExport` — bounded 200 records + 200 manifests, per-record digests, purge manifests for in-window gaps, attested window boundary and head, exportId + exportDigest over canonical forms) + `application/export-service.ts` (governed generation + the `audit.export-generated` evidence record). Round-trip proof over real PG: `audit-export.test.ts` (serialize → deserialize → verify → ok, deterministic on repeat; tampered record content/proof digests/export digest/purpose all fail); post-purge window exports verify across the manifest-covered gap |
| 4. Retention policy with governed expiry (expired purge recorded as governance evidence; bounded retention proven) | PASS | `domain/retention.ts` (bounded `[1, 3650]` days by validation AND by the migration CHECK — unbounded retention is unrepresentable) + `adapters/sql-audit-store.ts` `purgeExpiredRecords` (ONE transaction: session-gated DELETE of expired+hold-free records, the purge-evidence record carrying the full `{sequence, recordDigest}` manifest + commitment, head advance; a purge that finds nothing deletes nothing and records nothing) + `application/retention-service.ts` (fail-closed without an active bounded policy). Proven over real PG: `audit-retention-hold.test.ts` (purge deletes only expired records, evidence + manifest recorded, chain verifies WITH the gap; re-run converges with no duplicate evidence; concurrent purges never double-purge — total purged exactly the expired set, ≤1 evidence record; purge without a policy fails closed; adoption is audited; `audit-schema.test.ts` proves unbounded `retention_days` rows are unrepresentable via CHECK) |
| 5. Legal hold suspends expiry for its scope; holds are audited | PASS | Migration `audit.legal_holds` (scope shape CHECK, release shape CHECK, active-hold index) + `SqlAuditStore.placeHold`/`releaseHold` (the durable row AND the `audit.legal-hold-placed`/`audit.legal-hold-released` evidence record commit in the SAME transaction; idempotent per active scope+rationale, conflicting placement fails closed) + the purge's anti-join against active holds (application-wide holds cover everything; target holds match the record's target identity). Proven over real PG and over the in-memory double: held records survive the purge, release unblocks it, both procedures appear in the audit chain, the chain verifies throughout |
| 6. Discrimination tests: authorization-consulting audit access is non-existent; second-ledger patterns rejected; secret-shaped values scrubbed | PASS | `tests/discrimination/audit.discrimination.test.ts` (17 tests) over the shared rule engine `tests/architecture/lib/audit-boundary-rules.ts`: a synthetic audit store exposing `authorize(` is REJECTED (`evidence-only-vocabulary`); synthetic src files importing the audit module (sibling or via the barrel, import-resolved) are REJECTED (`no-audit-consultation` — the real tree has ZERO audit imports outside the module); governed-state literals in audit sources and a status column in a weakened migration are REJECTED (`no-second-ledger`); an audit file referencing the execution-ir plane is REJECTED (the E1.1 seam discipline — the observer uses structural seam typing); weakened migrations (missing trigger / missing purge gate / missing uniqueness / unbounded retention) are REJECTED; credential literals are REJECTED (`secret-free-sources`); external compliance/provider SDK imports are REJECTED (`no-new-sdk`); code/migration vocabulary drift is REJECTED (`vocabulary-sync`). Behavioral: secret-shaped detail keys are rejected at the service scrub gate (nothing recorded — fail closed BEFORE the authority); credential-shaped values are redacted in place; a hostile admission verdict passes through VERBATIM (the observer records, never decides); a failing projection never flips an allow into a deny (it fails closed with the typed error) |
| 7. Integration over real PostgreSQL at the final head; evidence document `docs/work-items/WORK-059.md` | PASS | This document, at the head recorded above; the audit integration suites (5 files, 36 tests) ran green over real PostgreSQL 16.4 at `127.0.0.1:55432` within the full battery (transcripts below) |

## Architecture invariants (Work Order §Architecture Invariants)

1. **Append-only by construction** — DB-level: the migration's triggers reject UPDATE, ungated DELETE and TRUNCATE; the store is the only code path setting `audit.governed_purge` (inside the purge transaction). Proven by `audit-schema.test.ts` + the discrimination suite (weakened migrations rejected).
2. **Evidence, never authority** — no code path consults the projection: the `no-audit-consultation` rule is import-precise over the whole real tree (zero violations), the audit ports/store/public surfaces carry no authorization vocabulary (rule + discrimination), and the admission observer passes verdicts through verbatim (behavioral proof).
3. **Hash-chained integrity; tampering detectable** — every record carries `previousRecordDigest` + `recordDigest`; `verifyAuditChain`/`verifyComplianceExport` re-derive everything; tamper proofs in unit + integration + export mutation tests.
4. **Retention and legal hold are governed procedures, themselves audited** — the purge is one transaction (delete + manifest evidence + head update) and a no-op purge records nothing; holds/policies write their evidence records in the same transaction as their rows.
5. **Completeness is honest** — the recorded action kinds are exactly the closed `AUDIT_ACTION_KINDS` vocabulary (CHECK-bound in the migration, machine-synced by `vocabulary-sync`); everything NOT recorded is listed under NOT-RUN/NOT-recorded boundaries below.
6. **Provenance** — every record carries actor/action/target/when/why with the exact source record identity (execution id, decisionId, holdId, policyId, exportId) and the observation seam; provenance-replay proven by test (`audit-chain.test.ts` "provenance replay").

## Required checkpoints

- **IDENTITY-IDEMPOTENCY** — `recordId` is content-addressed over the canonical identity form (volatile `occurredAt` excluded): the same governed action recorded twice is a bounded no-op (`replayed: true`, the durable row replays; unit + real-PG proofs); 3 concurrent duplicate submissions over real PG produce exactly 1 row; export verification is deterministic (repeated verification, same verdict).
- **CONCURRENCY-CRASH-SAFETY** — 20 concurrent appends serialize under the chain-head row lock into one gapless verified chain (no lost records, no broken links); concurrent purges never double-purge (serialized by the same head lock; total purged = the expired set; ≤1 evidence record); crash-resume: an append failing AFTER the record INSERT (fault-injected mid-transaction) rolls back COMPLETELY (record absent, head unchanged — PostgreSQL transaction atomicity) and the retry converges; a failed evidence append after a committed governed action fails closed (`AuditProjectionError`) and the retry converges to exactly ONE evidence record through the authority's idempotency (proven over the real executions fabric).
- **EXECUTION-PROVENANCE** — every record carries actor/action/target/when/why + provenance (seam + exact source identity) with full revision context; replayable by deterministic audit (`verifyChain` is pure over the durable records; the seams test proves the provenance over the REAL executions/policies/decision-store fabrics, including the exact policy-set identity/version/content-hash on policy decisions).
- **MIGRATION-SAFETY** — migration `0031` applies cleanly on a fresh database (the harness) AND on a database converged at the previous head 0030 (the D-02/E1.1 discipline: `runMigrations` with the full shipped set on a 0030-converged database applies exactly `[31]`, pre-existing authority rows intact, the audit store works immediately — proven in `audit-schema.test.ts`); forward-only, no destructive operation, tracked checksums intact.
- **DEPENDENCY-DIRECTION** — the audit module passes the shared dependency-rule engine (public-barrel-only cross-module imports, layer direction, domain purity); the projection observes existing seams import-only (the executions public contract, the policies public contract, and the decision-store append seam through STRUCTURAL typing — no module file references the execution-ir plane, keeping WORK-049's B3 seam boundary intact); no authority consults the audit projection (import-precise rule, zero violations over the real tree).
- **SELF-HOSTING-BOUNDARY** — no external compliance SaaS is absorbed (no external package imports in the audit module at all — the SQL store bridges the provider-neutral `DatabasePort`; the export is a self-contained verifiable object). External export targets (SIEM/e-discovery shipping): **NOT RUN and disclosed** below.
- **IMPLEMENTATION-COMPLETENESS** — this evidence package maps every AC and checkpoint to exact-revision results; forbidden surfaces untouched (zero `spec/` changes; `src/modules/audit/**` + the sanctioned new migration + tests + docs only; the 12 migration-count pin updates in other Work Orders' tests are the mechanical reconciliation the pins' own comments sanction — the WORK-049 `cd68723` precedent, disclosed in the inventory below).

## Test battery at the final implementation head (exact-revision results)

All gates re-run at implementation head `2281db2` (the runbook/evidence commits touch only `docs/`):

- `python3 scripts/governance-check.py` — **PASSED**: `Governance OK: 60 Work Orders, 110 requirements, inFlight=[], frontier=['WORK-057', 'WORK-058', 'WORK-059']`.
- `bun run typecheck` — **0 errors**.
- `bun run lint` — **biome clean, exit 0** (37 warnings / 1 info — the repo's tolerated warning baseline, same kinds as the base: `noNonNullAssertion`/`useTemplate` in tests).
- `bun run test:unit` — **224 files / 3262 tests, all passed** (including the 50 new `tests/unit/audit/**` tests and the reconciled startup test).
- `bun run test:architecture` — **103 files passed | 1 skipped (suite-level placeholder) / 1382 tests passed | 4 skipped** (including the 5 new `audit-boundary.test.ts` tests and the reconciled migration-count pins).
- `bun run test:integration` (real PostgreSQL 16.4, `ZECK_PG_TEST_URL` @ 127.0.0.1:55432) — **117 files / 1090 passed | 13 skipped** in the recorded clean run (the 13 skips are the live-provider honesty skips, unchanged from the base). The audit integration suites: **5 files / 36 tests, all passed**.
- `bun run deploy:validate` — **`valid: true`, problems `[]`, migrations 30** (the deployment-validation gate accepts the extended set).

**Honest flake disclosure:** under FULL-battery parallelism against the single embedded PostgreSQL instance, two PRE-EXISTING timing-sensitive tests occasionally flake (1-in-~3 full runs): `pg-database-port.test.ts > connection-pool bounds hold under parallel load` (a `pg_stat_activity` sampler counting a transient connection: "expected 3 to be less than or equal to 2") and, observed once, `computer-use-lifecycle.test.ts > N=8 same-key dispatchAction calls converge`. Both pass consistently in isolation (3/3 consecutive runs) and in full-battery re-runs; both live in surfaces this Work Order never modified (my only change to `pg-database-port.test.ts` is the migration-count pin 29→30, not the pool logic). They are load-dependent flakes of the shared test server, not regressions; the recorded battery above is a consecutive clean run.

## Changed-file inventory (52 files; ancestry `1a86262..HEAD`)

**Declared surfaces — `src/modules/audit/**` (24 files, all new except the 5 pre-existing skeleton barrels):**

```text
src/modules/audit/public.ts                                  (rewritten: the public contract)
src/modules/audit/domain/{index,canonical,vocabularies,record,scrub,chain,export,hold,retention}.ts
src/modules/audit/ports/{index,audit-store}.ts
src/modules/audit/adapters/{index,node-digest,sql-audit-store,in-memory-audit-store,
                            observing-execution-service,observing-authorization,observing-decision-store}.ts
src/modules/audit/application/{index,audit-service,export-service,retention-service,hold-service}.ts
src/modules/audit/internal/index.ts                          (unchanged skeleton)
```

**Declared surface — the audit migration (next available number at base):**

```text
src/platform/db/migrations/0032_audit_compliance.sql          (NEW file; no existing file modified — renumbered from 0031 by the Architect merge reconciliation after WORK-058's 0031_isolation_profiles merged first; identical content)
```

**Declared surfaces — tests (26 files):**

```text
tests/unit/audit/{record,scrub,chain,services,observers}.test.ts                       (5 new, 50 tests)
tests/integration/postgres/audit-world.ts                                               (new fixture)
tests/integration/postgres/{audit-schema,audit-chain,audit-retention-hold,
                             audit-export,audit-seams}.test.ts                          (5 new, 36 tests)
tests/architecture/audit-boundary.test.ts + tests/architecture/lib/audit-boundary-rules.ts (new)
tests/discrimination/audit.discrimination.test.ts                                       (new, 17 tests)
```

**Mechanical reconciliation (the WORK-049 cd68723 precedent — the pins' own comments sanction
"every future migration is a reviewed, disclosed extension of this expectation"; counts 29→30
files, head pin 0030→0031, startup pins 30 files/22 schemas):**

```text
tests/unit/db/startup.test.ts
tests/architecture/d02-production-paths.test.ts
tests/architecture/e11-{tool-surface,context-economics,model-economics,failure-recovery,
                        substrate-economics,compiler,competence-economics}-boundaries.test.ts
tests/discrimination/{context-economics,failure-recovery}.discrimination.test.ts
tests/integration/postgres/pg-database-port.test.ts
```

**Declared surface — operator documentation:**

```text
docs/runbooks/d08-audit-compliance.md                        (new)
```

**Zero changes** to: every other module, `src/platform/**` (except the NEW migration file), `deploy/**`, `benchmarks/**`, `spec/development-state/*`, the d08-usage measurement surfaces, frozen v1.0 public contracts.

## Honest NOT RUN / NOT-recorded boundaries

- **Production composition wiring (API layer): NOT RUN.** The three seam observers are built, exported and proven over the REAL authority fabrics by the integration suites, but wiring them into the production composition root (`src/api/`) is outside this Work Order's declared surfaces — it arrives with the D-08 composition/fabric Work Order. Until then, governed actions in a production deployment are NOT yet recorded (the honest completeness state at THIS head; the module's public barrel exposes no audit consumers by design — the `no-audit-consultation` boundary keeps it that way until the sanctioned wiring lands).
- **Observed-scope boundary (declared completeness):** exactly the three Work-Order-declared seams (execution lifecycle create/transition, policy admission, optimization decision records) + the audit plane's own governed procedures are recorded. **NOT recorded (explicit):** budget reservations/settlements, model dispatches, tool invocations, sandbox/substrate transitions, artifact writes, verification outcomes, learning telemetry, release operations, workflow events, computer-use actions, long-running checkpoint/lease events — each would require its own observation seam and Work Order scope.
- **External export targets (SIEM/e-discovery/compliance-SaaS shipping): NOT RUN** — no such infrastructure exists in this environment; the export is a self-contained verifiable object (SELF-HOSTING-BOUNDARY holds by construction).
- **Actor-kind granularity at the executions seam:** the executions public contract carries `actorId` only (no human/service principal typing); the observer applies the composition-configured `actorKind` (documented default `service-principal`). The actorId itself is exact.
- **`recordStepEvent` / `recordPlanningDecision` on the executions service:** passed through UNOBSERVED by the executions observer (ledger events, not lifecycle transitions — outside the declared observation scope).
- **Database-superuser residual boundary:** a superuser can disable triggers or set the `audit.governed_purge` GUC manually; the trigger makes every APPLICATION-path mutation/deletion unrepresentable, but a hostile superuser is outside any database-level guarantee (the same residual every DB-level enforcement in this repository carries).
- **Live R2/S3/object-store and live provider skips (13):** unchanged honesty skips from the base battery.

## Known limitations / deferred items

- **Purge-evidence retention:** `retention.purge-executed` records are exempt from purge deletion (a purged manifest would make its own gap unverifiable); the chain verification tolerates this by design, but purge evidence therefore accumulates at one record per governed purge batch (bounded by purge cadence + batch bound 500). A future Work Order could extend the manifest mechanism recursively if this becomes material.
- **Observer retry coupling:** fail-closed observation means a projection outage surfaces as an error on the observed call; convergence relies on the caller retrying (the authorities' request idempotency). A durable outbox/queue decoupling would be a larger (queue-plane) change — out of scope.
- **`InMemoryAuditStore`** implements the governed semantics for unit tests but does NOT simulate the DB triggers (by design — the durable proofs run only over real PostgreSQL; no simulated PASS claims).

## Risks

- The migration-count reconciliation touches other Work Orders' pinned expectations — disclosed above, mechanical, and the established precedent; the Architect should verify the reconciliation matches the merge-time state (sibling migration collisions, if WORK-057/058 took 0031 too, are reconciled by the Architect per the Work Order).
- The `audit` schema is new: no backfill exists (nothing to backfill — the projection starts empty; pre-D-08 governed actions were never recorded, an honest boundary, not a gap in this order).
- Chain verification cost is linear in chain length (paged, bounded memory, operator-procedure frequency) — acceptable for evidence verification; not a hot path.

## Architect merge reconciliation (2026-09-11, commit d072508)

After the worker's final head `780aa95`, the Architect merged wave-A siblings (WORK-057 PR #38, WORK-058 PR #37) into `main` and performed the WO-assigned merge reconciliation on this branch:

- `0031_audit_compliance.sql` → `0032_audit_compliance.sql` (identical content; 0031 lands as WORK-058's `0031_isolation_profiles`); all code references updated (`sql-audit-store.ts`, `audit-boundary.test.ts`, `audit.discrimination.test.ts`).
- Migration-count pins unified at **31** with the last = `0032_audit_compliance`, second-to-last = `0031_isolation_profiles` (`d02-production-paths`, `e11-*` boundary suites, `startup.test.ts`, the two discrimination suites).
- The branch's own battery claims in this document were executed at the pre-reconciliation heads (`2281db2`/`780aa95`) where the migration carried the 0031 number — those claims remain exact at those revisions; the full battery was re-run by the Architect at the reconciled head before merge.
