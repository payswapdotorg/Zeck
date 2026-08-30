# WORK-004 Evidence — Budgets, wallets, reservations and ledger

Work Order: `spec/work-orders/WORK-004.md`
Assurance: `CRITICAL` · Architecture: `v1.0` (frozen)
Branch: `work/WORK-004-budgets-ledger` · Base: `82afe972f1a5774a099fbac3114a15efb3f3dafa`
Implementation revision (this file binds): `5b1ce97be55f64e0c906ea745324896eb0e7322e`

Parallelization disclosure: WORK-005 runs in parallel on disjoint surfaces per the
architect's frontier sanction. The three development-state JSON protocol edits
below are shared with that branch; the architect union-merges them (expected,
pre-declared here).

## Requirement mapping

| Requirement | Acceptance criterion | Implementation | Proof |
|---|---|---|---|
| BUD-001 | 1/2. Applications impose per-execution and monthly budgets with deterministic precedence | `budgets.budgets` (scope rows: `per-execution`, `monthly`, `user-monthly`); `domain/budget.ts` freezes `BUDGET_CHECK_ORDER` (per-execution → monthly → user-monthly — the FIRST failing check is THE denial reason); "monthly" is the deterministic UTC calendar-month window `month_key = YYYY-MM` of reservation creation (`domain/money.ts monthKeyOf`, physically CHECK-constrained); aggregates count active holds at reserved amount + settled rows at actual amount (`BudgetStore.usageForExecution/usageForMonth`) | `tests/unit/budgets/budget-service.test.ts` (precedence + denial reasons), `tests/integration/postgres/budgets-reservations.test.ts` ("budget admission on real PG"), `tests/discrimination/budgets-settlement.discrimination.test.ts` D1/D6 |
| BUD-002 | Users impose their own spending limits where the application permits | `application_funding_settings.allow_user_limits` gates `user-monthly` enforcement; user limits apply only to attributed user spend (`userId`), never silently to app totals | `tests/unit/budgets/budget-service.test.ts` (allow/deny user-limit cases), migration `budgets_scope_shape` CHECK |
| BUD-003 | Developer, user, BYOK, hybrid, subsidy funding modes supported by policy, deterministic precedence | `domain/funding.ts`: frozen `FUNDING_PRECEDENCE` byok > subsidy > user > developer; a mode selects the eligible subsequence (hybrid = user first, developer backstop); single-source draws only; no funding policy row ⇒ reservation admission fails closed `POLICY_DENIED` (no default-allow exists — D4 static proof) | `tests/unit/budgets/funding-precedence.test.ts`, `tests/integration/postgres/budgets-reservations.test.ts` (developer/hybrid/byok end-to-end flows), D4 |
| BUD-004 | Reservations are concurrency-safe and idempotent (unique per logical billable operation) | `budgets.reservations` UNIQUE `(application_id, operation_id)` + `ON CONFLICT DO NOTHING` convergence (WORK-002 arbitration semantics: first writer commits, racing replay converges on the same hold, different request ⇒ `IDEMPOTENCY_KEY_REUSED`); full-decision-domain lock (`lockDecisionDomain`: funding-settings pivot row `FOR UPDATE` FIRST, then budgets, then wallets, deterministic id order) with re-derive-under-lock; atomic guarded wallet debit (`balance >= amount` inside the UPDATE) with the physical CHECK as backstop | `tests/integration/postgres/budgets-concurrency.test.ts` (6 suites, multi-round), `tests/integration/postgres/budgets-reservations.test.ts` (replay/reuse/convergence), `tests/discrimination/budgets-overspend.discrimination.test.ts` M1/M2 |
| BUD-005 | Actual usage settled into an append-only ledger; corrections are new compensating entries | `budgets.ledger_entries` PHYSICALLY append-only: `BEFORE UPDATE OR DELETE` trigger raises; movement classes bound to directions by CHECK; every lifecycle transition writes its money movement as new entries (`settle-release`/`settle-overage`/`reservation-release`); settle exactly-once and release exactly-once enforced by `lockReservation` + status re-derivation and the forward-only finalize trigger (`reservations_finalize_once`, terminal rows physically immutable, never deletable) | `tests/integration/postgres/budgets-schema.test.ts` (trigger + CHECK rejections incl. UPDATE/DELETE on the ledger and terminal-immutability on reservations), `tests/integration/postgres/budgets-reservations.test.ts` (exactly-once settle/release + crash-atomicity), `tests/discrimination/budgets-settlement.discrimination.test.ts` D2/D3/D5 |

Acceptance criterion 6 (concurrent reservations cannot overspend the same
available balance) is proven by real-PostgreSQL multi-round stress:
exact-remaining-balance contests with two and with THREE competitors (exactly
one commits per round), budget-aggregate contests under one execution budget
(committed usage never exceeds the limit), same-logical-operation convergence
(one hold), and a settle-vs-release finalize race (exactly one finalizes, money
credited once) — `tests/integration/postgres/budgets-concurrency.test.ts`.

## Implementation

Surfaces (declared): `src/modules/budgets/` (domain: money/funding/budget/reservation/wallet; ports: `BudgetStore` incl. the `lockDecisionDomain` contract, `BudgetsIdempotencyPort`; application: `createBudgetService` with configureFundingMode/grantCredits/setBudget/reserve/settle/release; adapters: SQL store + idempotency arbitration over `platform.idempotency_records`; `public.ts` barrel exporting `BudgetAuthority` = the reserve/settle/release pick Executions will consult), `src/platform/db/migrations/0003_budgets_ledger.sql` (wallets, application_funding_settings, budgets, reservations, ledger_entries + append-only/forward-only triggers).

Surfaces (directly required, disclosed): `tests/unit/budgets/**`, `tests/integration/postgres/budgets-*.test.ts` + shared `budgets-world.ts`, `tests/discrimination/budgets-*.test.ts` (per the "directly-required tests" allowance); `spec/development-state/{program,frontier,checkpoint}-state.json` per the worker protocol (in-flight transition + checkpoint outcomes — WORK-002/003 precedent; adjacent-edit union-merge with the parallel WORK-005 branch is expected).

Key mechanics:
- **Lock the FULL decision domain** (WORK-002 remediation lesson): every reserve decision runs inside the arbitration transaction and starts by locking the application's funding-settings row (the pivot every reserve writer passes through), then all budget rows, then all wallets (`FOR UPDATE`, deterministic id order — deadlock-free). All decision inputs — funding mode, limits, balances, usage aggregates — are re-derived AFTER the pivot lock under READ COMMITTED, so concurrent writers of one application totally order and each loser re-derives the winner's committed state. A narrow lock missing a competing row is exactly the bug class WORK-002 remediated; here the pivot makes "missed row" impossible for reserve decisions, and the physical `balance_micro_usd >= 0` CHECK is the durable backstop even if both service-level guards were removed (M2).
- **Money = integer micro-USD only**: canonical decimal strings in TypeScript (`MicroUsd` branded; `parseMicroUsd` rejects signs, decimals, exponents, leading zeros, overflow past 10^18), `bigint` columns in PostgreSQL; every arithmetic op is `bigint`; no floating point touches accounting anywhere.
- **Idempotency arbitration** identical to WORK-002/003: `(applicationId, operationName, idempotencyKey, fingerprint)` — same key+same fingerprint replays the durable outcome; different fingerprint ⇒ `IDEMPOTENCY_KEY_REUSED`; concurrent identical requests converge through the unique index (loser replays winner's committed outcome).
- **Settlement/release exactly-once**: lock the reservation row, re-derive status under the lock; `settled` with the same actual converges, different actual ⇒ `IDEMPOTENCY_KEY_REUSED`; `released` cannot settle; `settled` cannot release (unused money is returned at settlement). Money effects are compensating APPEND-ONLY ledger entries; the forward-only finalize trigger makes a double finalize physically unrepresentable (D3 proves the green test detects losing it).
- **Crash-atomicity**: reservation + wallet movement + ledger entry commit in ONE transaction with the idempotency record; a mid-work failure (proven by an injected fault after the debit) rolls back all three — no partial hold, safe retry.
- **No executions wiring** (out of surface): the module ships the `BudgetAuthority` public contract for WORK-006 to consult before dispatch, exactly how connections/models were built underneath Execution in WORK-003. Authorization is not re-implemented (callers are post-authorization modules/admin composition roots; `assertTenant` guards tenant scope on every decision).

## Design decisions (architect-review pointers)

1. **Funding precedence byok > subsidy > user > developer** (frozen in `domain/funding.ts`): BYOK first because the customer's own credential pays the provider (no platform wallet drawn at all); subsidy before customer money because grants exist to be spent where intended; user funds before developer funds (developer is the backstop). Hybrid = `[user, developer]`, a subsequence of the frozen order — selection can never depend on iteration/insertion order.
2. **Budget precedence per-execution → monthly → user-monthly, and budget denials always precede funding insufficiency** (admission completes before money moves): the first failing check is THE machine-readable denial reason (`BUDGET_EXCEEDED` + `reason`), so two identical racing requests always produce the same denial and denial semantics never depend on evaluation timing (D1/D6).
3. **Monthly = deterministic UTC calendar month**: `month_key` is a pure function (`YYYY-MM`) of reservation creation time, stored on the row and CHECK-constrained — never wall-clock locale or a configurable window.
4. **Single-source draws (no split draws across wallets)**: each reservation draws from exactly one source — the first eligible source whose balance covers the full amount. Splitting would multiply the rows a racing draw must coordinate and would make "which limit failed" ambiguous.
5. **Money as integer micro-USD decimal strings / bigint**: floats unrepresentable at the type boundary (`parseMicroUsd`), in storage (`bigint` columns only) and in arithmetic (`bigint`); `MAX_MICRO_USD` = 10^18−1 bounds the column range.
6. **The funding-settings row is the serialization pivot**: fail-closed admission (no policy row ⇒ `POLICY_DENIED`) doubles as the guarantee that the pivot row exists for every decision ever made — reserve writers of one application always queue on the same row first.
7. **Ledger is the audit trail, wallet row the live balance — one authority, not a second state machine**: both are written in the same transaction; `SUM(debits)−SUM(credits)` always equals the live balance (asserted end-to-end in the developer/hybrid flows). Corrections are new `correction` entries (either direction allowed by CHECK); every other class is direction-bound.
8. **Reservations are forward-only and never deleted**: terminal rows are physically immutable (trigger) — usage aggregates and ledger linkage survive forever; the lifecycle-shape CHECK pins terminal payloads (settled carries exactly one non-negative actual + timestamp; released carries neither).
9. **Migration-runner statement rule honored**: trigger function bodies are single-line because the runner splits on `;`-at-end-of-line (documented in the migration header).

## Verification (at implementation head `5b1ce97be55f64e0c906ea745324896eb0e7322e`)

Toolchain: Bun 1.3.14 (local sandbox; CI pins 1.3.4 via bun.lock-compatible frozen install), real PostgreSQL 16.4 at 127.0.0.1:55432 (`ZECK_PG_TEST_URL`).

| Command | Result |
|---|---|
| `bun install --frozen-lockfile` | clean, no changes — runtime dependencies remain `[]` (package.json/bun.lock untouched by this branch) |
| `python3 scripts/governance-check.py` (baseline at `82afe97`) | `Governance OK: 20 Work Orders, 45 requirements, frontier=['WORK-004', 'WORK-005']` |
| `python3 scripts/governance-check.py` (at head) | `Governance OK: 20 Work Orders, 45 requirements, frontier=['WORK-005']` (WORK-004 in-flight; WORK-005 untouched, stays eligible) |
| `bun run typecheck` | 0 errors (232 files) |
| `bun run lint` | 0 errors, 0 warnings (232 files) |
| `ZECK_PG_TEST_URL=… bun run test` (full, **twice consecutively**) | **368/368 passed, 47 files** both runs — zero flakes |

Baseline before any change (recorded at `82afe97` in a clean worktree): typecheck 0,
lint clean (213 files), full suite **286/286, 39 files, twice green**.

Test census (delta vs WORK-003's 286): unit 129→180 (+51: money 9, funding-precedence 6, budget-service 36 over in-memory fakes); real-PG 54→77 (+23: budgets-schema 8, budgets-reservations 9, budgets-concurrency 6); discrimination 63→71 (+8: budgets-overspend 2, budgets-settlement 6); architecture 34 unchanged.

## Checkpoint evidence (CRITICAL: static + dynamic + discrimination)

- `IMPLEMENTATION-COMPLETENESS` — all 6 acceptance criteria mapped (table above + criterion-6 paragraph); `evidence-recorded` in `spec/development-state/checkpoint-state.json` (verdicts pending architect review).
- `IDENTITY-IDEMPOTENCY` — same-key replay returns the same durable outcome; key+conflicting-fingerprint ⇒ `IDEMPOTENCY_KEY_REUSED`; a DIFFERENT key for the same logical operation converges on the ONE hold (no double hold); concurrent identical reserves converge — all against real PG (`budgets-reservations.test.ts`, `budgets-concurrency.test.ts`); unit-level arbitration over fakes (`budget-service.test.ts`).
- `CONCURRENCY-CRASH-SAFETY` — multi-round exact-balance contests (2 and 3 competitors: exactly one commits), budget-aggregate contests (usage never exceeds the limit), settle-vs-release finalize race (one finalizer, money credited once); crash-atomicity: injected mid-work failure after the wallet debit rolls back reservation+wallet+ledger atomically; red record M1 proves the production scenarios detect the unserialized mutant.
- `SELF-HOSTING-BOUNDARY` — frozen install unchanged (no new packages at all); runtime deps `[]`; governance green; D4 static proof that no default-allow funding path exists (the reserve source cannot create or default the funding policy); the suites run entirely on the shipped toolchain; canonical error taxonomy only (`BUDGET_EXCEEDED`, `POLICY_DENIED`, `TENANT_SCOPE_VIOLATION`, `IDEMPOTENCY_KEY_REUSED`, `INVALID_STATE_TRANSITION` — no new vocabulary).

## Discrimination evidence (CRITICAL boundaries named by this Work Order)

| Boundary | Mutation proven |
|---|---|
| Concurrent overspend (criterion 6) | **M1 RED RECORD**: decision-domain lock removed (no `FOR UPDATE`; widened race window) ⇒ BOTH competing reservations under a 1500-limit budget commit 1000+1000 — committed usage 2000 > 1500 observed under the mutant, i.e. the production concurrency scenarios detect exactly this mutation. **M2**: lock AND debit guard both removed ⇒ PostgreSQL's physical `balance_micro_usd >= 0` CHECK still rejects the overdraft transaction — durable backstop independent of service code |
| Budget precedence determinism | D1: reversed `BUDGET_CHECK_ORDER` fails the frozen-precedence property (first-failure-is-THE-denial); D6: budget denial is independent of wallet sufficiency (admission completes before money moves — an insufficient wallet cannot mask a budget denial or vice versa) |
| Settle/release exactly-once | D2: a stale pre-lock status read cannot double-settle (the status guard re-derives from the durable row under `FOR UPDATE`); **D3 RED RECORD**: dropping the persisted terminal transition lets a double-settle double-credit — the green test detects it; D5: production double-settle/double-release never double-charge (contrast record) |
| Append-only ledger | Real-PG physical proofs: ledger UPDATE and DELETE each rejected by the trigger; terminal reservation UPDATE/DELETE rejected by the forward-only trigger; class/direction CHECK rejections; cross-tenant and cross-application wallet draws unrepresentable via composite FKs (`budgets-schema.test.ts`) |
| No default-allow admission | D4 static: the reserve path cannot create or default the funding policy — absence fails closed `POLICY_DENIED` |

## Known limitations

1. **CI has no PostgreSQL service** (carried since WORK-002, flagged there): the 77 real-PG tests skip with an explicit reason in CI; the local verification output above (twice-consecutive green) is the recorded proof. Governance-owned follow-up.
2. **Overage settlement can fail on an empty wallet** (`insufficient-funds-at-settlement`, retryable): usage has already happened, so the operator grants credits and retries the SAME settle (idempotency preserved; the reservation honestly stays active). Automatic negative-balance/postpay is deliberately not modeled (a second accounting authority would be required).
3. **Ledger `correction` entries are schema-supported but no service command emits them yet** — corrections are an operator/finance surface (append-only by construction); introducing a `correctLedger` command belongs to a future Work Order with its own authorization design.
4. **Monthly aggregates key on reservation creation month**: a hold created on the last day of a month that settles in the next month counts against its creation month (deterministic by design; documented rather than configurable).
5. **Wallets are created via `grantCredits`** (first grant creates the wallet); there is no zero-balance wallet provisioning command — an application with a funding policy but no wallets denies reserves fail-closed as `insufficient-funds`.
6. **Executions integration is future work** (WORK-006): `BudgetAuthority` is exported and consulted-by-construction only; nothing in `src/modules/executions/` was touched (out of declared surface).

## Disclosures

- **Development-state union-merge**: the three `spec/development-state/*.json` protocol edits (WORK-004 in-flight + checkpoint outcomes) are shared with the parallel WORK-005 branch (disjoint module surfaces, architect-sanctioned parallelization); adjacent edits will be union-merged by the architect — expected and pre-declared.
- **Migration surface addition**: `src/platform/db/migrations/0003_budgets_ledger.sql` under the declared migrations home (WORK-002/003 precedent); migration-runner tests remain state-independent (derive from the shipped set — the WORK-003 repair; verified green with migration 3 present).
- **No new packages**: nothing added to package.json/bun.lock; `pg` + `@types/pg` remain exact-pinned devDeps from WORK-002.
- **Baseline procedure note**: the implementation commit 5b1ce97 was authored in a prior interrupted session of this same task (branch never pushed, no PR, no worklog entry); this round re-verified the ENTIRE gate from scratch on the current tree — baseline re-recorded at `82afe97` in a clean worktree (286/286 twice), head gate re-run twice (368/368), code re-reviewed — before writing this evidence file.

## PR / merge

- PR: see completion report (worker opens; architect merges — never the worker).
- **Two-phase binding**: this evidence file binds the implementation head `5b1ce97be55f64e0c906ea745324896eb0e7322e`. The final branch head (this evidence commit) cannot contain its own SHA; it is bound in the PR body + completion/CI comments (WORK-001/002/003 protocol).
- `program-state.json` becomes `complete` only at post-merge finalization with the actual PR number + merge commit.
