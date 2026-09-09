# WORK-049 Evidence — Execution IR and outcome-economics foundation

Work Order: `WORK-049` (`spec/work-orders/WORK-049.md` on `main` at the dispatch base — the canonical dispatch) · Canonical remote: **`payswapdotorg/Zeck`** · Assurance: **HIGH_ASSURANCE** · Governing architecture: frozen v1.0 + Execution Intelligence Architecture **E1.0** + Economic Execution Intelligence **E1.1** (ADR-0019, ADR-0020) · Roadmap phase **E1.1 stage 1**.

## Dispatch, branch and ancestry

Exact dispatch base: `b946ade7660cf431e8ed08490769743379546622` (the WORK-049 frontier advance; verified — the required branch `work/WORK-049-execution-ir-outcome-economics-foundation` was confirmed at exactly that SHA before any change). Final implementation head: **`83c8b9ea09b4ad8ee24b470b0f572f408522217b`** (the last implementation commit; the branch carries it plus the documentation on top). **7 commits (5 implementation + 2 documentation), ZERO merge commits, ZERO `spec/` changes** (mechanically verified: `git log --merges b946ade..HEAD` → 0; `git diff --name-only b946ade..HEAD -- spec/` → 0). One PR, opened by the worker, **not merged by the worker**.

## Baseline gate at the exact dispatch base (readiness checkpoint — BEFORE implementation)

Executed at exactly `b946ade` before any change:

- **`python3 scripts/governance-check.py` PASSED** — `Governance OK: 49 Work Orders, 102 requirements, inFlight=[], frontier=['WORK-049']`.
- `bun run typecheck` — 0 errors.
- `bun run lint` — biome clean, exit 0.
- `bun run test:unit` — **173 files / 2636 tests, all passed**.
- `bun run test:integration` with real PostgreSQL 16.4 (`ZECK_PG_TEST_URL`, 127.0.0.1:55432) — **104 files / 1027 passed | 13 skipped** (the live-provider honesty skips unchanged from WORK-048).
- `bun run test:architecture` — **86 files / 1148 passed | 4 skipped**.
- The PostgreSQL 16.4 server was built from source and run rootless at 127.0.0.1:55432 (the same instance prior workers used).

## External-infrastructure access (readiness checkpoint)

**NOT RUN — no live model, substrate, or provider credentials exist in this worker environment** (none are required by this Work Order: the foundation is representation + evidence only, and live provider selection is explicitly out of scope — later E1.1 stages). The only credential held is the operator-provided GitHub PAT for `payswapdotorg/Zeck` (environment-only; used solely for the Git/PR lifecycle of this Work Order). No provider resource in any non-GitHub account was mutated.

## What this order IS

E1.1 stage 1: a machine-readable, optimizable Execution IR derived losslessly from governed plans through declared minimal seams (planning, executions, budgets — all read-only); deterministic and total IR validation with typed, bounded invariant errors; hard/soft optimization constraints across the seven kinds (policy, capability, budget, quality, latency, verification, side-effect) with authority-sourced restrictions hard by construction and soft constraints recorded never enforced; the bounded, attributed expected-successful-resolution cost model over neutral candidate representations with quality-preserving deterministic selection; append-only optimization decision records carrying the full ADR-0020 evidence contract over real PostgreSQL as the sole durable authority; and the deterministic plan→IR→decision provenance audit. **No optimizer/execution-compiler engine (WORK-050), no runtime optimization, no new authority, no new state machine, no vendor vocabulary.**

## Acceptance-criteria mapping (Work Order §Acceptance Criteria)

| AC | Claim | Evidence |
|---|---|---|
| 1. Governed plan → machine-readable Execution IR, deterministic validation, lossless conversion (identity, steps, dataflow, capability references, verification anchors, side-effect classes) | PASS | `src/platform/execution-ir/ir.ts`: `deriveExecutionIr(snapshot, digest)` verifies the snapshot content digests to the planning authority's own `planId` BEFORE deriving (anti-second-authority), derives step facts (`computationType`, `sideEffectClass`) from frozen architecture step-class tables, and computes the content-addressed `irId`; `validateExecutionIr` is total (both identities verified); `planFormOfIr` reconstructs the canonical plan form — losslessness is proven by digest equality AND by the cross-plane byte-equality proof (`canonicalPlanFormOfSnapshot(snapshot) === canonicalPlanForm(plan)` — the planning module's own canonical form; unit `ir.test.ts`). Idempotent: same snapshot ⇒ same `irId`. Integration: the full chain derives the IR from a REAL planner outcome over real PG |
| 2. Hard and soft constraints from the governing authorities represented; hard enforced by validation, soft recorded | PASS | `constraints.ts`: 7 kinds × 5 authorities with payloads mirroring the owning authority's own fields; `enforceHardConstraints` → typed `ConstraintViolation[]` (closed 8-code vocabulary) covering policy routes/tools, budget ceilings, quality floors, latency ceilings, capability satisfaction, verification anchors, egress; `routeAllowedByPolicy` mirrors the planner's semantics. **Hard-by-construction**: an authority-sourced (policy/capability/budget/verification) restriction with `enforcement: "soft"` is unrepresentable — `validateOptimizationConstraint` rejects it (discrimination D7). Soft constraints never enforced (D11). Unit `constraints.test.ts` (13 tests) |
| 3. Cost model evaluates candidates; bounded expected-cost claims with explicit estimation basis and quality/reliability expectation | PASS | `cost-model.ts`: `validateCostClaim` rejects unattributed, unbounded (above `MAX_IR_COST_MICRO_USD`/latency bounds) and zero-reliability claims; `evaluateCandidate` computes expected successful-resolution cost = `ceil(cost/reliability)` over BigInt with `MAX_IR_COST_MICRO_USD="999999999999999999"`; quality expectation recorded (expectedQuality vs threshold, meetsThreshold); `selectCandidate` is deterministic (cost asc → representation-ladder tie → candidateId tie) with an explicit `selectionBasis`. Unit `cost-model.test.ts` (11 tests) |
| 4. Every material optimization decision recorded with input constraints, candidate representations, selected representation, cost/latency expectations, quality expectation, transformation basis, provenance | PASS | `decision-record.ts`: `buildOptimizationDecision` validates fail-closed (non-empty governing constraints, validated claims, coherent selection, hard-constraint compliance of the selected representation) and emits the full ADR-0020 record; `TRANSFORMATION_BASIS_CODES` closed to `identity`/`representation-substitution`; `decisionId` content-derived (excludes recordedAt/recordDigest); `recordDigest` over the full record. Integration: the real-PG chain builds and appends a decision from real planner/policy/capability/budget inputs |
| 5. IR invariant validation rejects authority-violating representations (second authority, duplicated identity, unattributed costs, vendor semantics, missing provenance) with typed, bounded errors | PASS | Closed `IR_INVARIANT_CODES` (12 codes); every rejection is an `IrValidationError` naming exactly one. Discrimination `execution-ir.discrimination.test.ts`: D1 second-authority identity claim, D2 duplicated step identity, D3 unattributed costs, D4 unbounded costs, D5 vendor semantics outside closed neutral vocabularies, D6 missing provenance — each rejected fail-closed |
| 6. Plan identity and provenance preserved end-to-end; verifiable by deterministic audit | PASS | `audit.ts`: `auditExecutionProvenance` re-validates the IR, re-derives from the snapshot, re-checks losslessness and every decision's identity/digest/hard-constraint compliance (closed 9-code violation vocabulary; deterministic — same inputs, same verdict); `auditDurableExecutionProvenance` over store-served records only. D9 re-derivation drift detected; integration: the durable audit runs green over the real appended record |
| 7. Durable semantics over real PostgreSQL; the durable store remains the sole authority | PASS | Migration `0030_execution_ir_decision_records` (schema `execution_ir`, physically append-only trigger, composite tenant FKs, hex-digest CHECKs, closed transformation-basis vocabulary CHECK, unique (application_id, decision_id)); `SqlOptimizationDecisionStore` over the standard `DatabasePort`: **race-safe idempotent append** (`ON CONFLICT DO NOTHING` + locked re-read convergence — N=8 concurrent identical appends over real PG produce exactly one durable row, one insert, seven replays; discrimination D12 proves the lost-race paths: identical winner → replay, drifted winner → typed conflict), `DecisionIdentityConflictError` on content drift, read-time row validation (tampered/foreign rows are typed errors), tenant isolation. D10: durable evidence outside the authoritative store is a `durable-record-foreign` violation. Six integration tests over real PG 16.4 |
| 8. Full static, dynamic and discrimination/mutation coverage at exact revisions with honest NOT RUN boundaries | PASS | This evidence document; all six gates green at the final implementation head (below); 73 new tests; every weakened invariant discriminated; NOT RUN boundaries stated below |

## Required checkpoints

- **ECONOMIC-AUTHORITY-BOUNDARY** — budgets stay the authority: the budgets seam is read-only ceilings (`BudgetConstraintsSeam`), never a reservation/settlement/admission surface; cost claims are bounded and attributed or rejected (D3/D4); the store exposes append/get/list only — **no admission or authorization vocabulary exists on the durable evidence path** (architecture B5), and no execution path can consult decision records for authorization (D8 boundary proof: the decision surface has no consumers outside the audit, and the store type carries no authorization semantics).
- **DEPENDENCY-DIRECTION** — the IR plane imports no module/integration/api surface (B1) and only node builtins + repository-relative modules (B7); the module-side references to the plane are EXACTLY the three declared seam adapters (B3, the WORK-048 seam-set precedent); no module depends on the plane for authority.
- **IDENTITY-IDEMPOTENCY** — `irId`/`decisionId`/`recordDigest` are content-addressed over canonical JSON; re-deriving the same snapshot produces the same IR (unit proof); re-appending the same decision is a bounded no-op (`replayed: true`), **including under concurrency**: N=8 simultaneous identical appends over real PostgreSQL converge to exactly one durable row (the unique index + `ON CONFLICT DO NOTHING` + locked re-read serialize the identity race; the lost race is never a raw error, never a duplicate, never an overwrite — D12 + the integration concurrency proof); content drift under a claimed identity is a typed conflict.
- **EXECUTION-PROVENANCE** — plan→IR→decision provenance is exact and replayable: the audit re-derives and re-validates the whole chain; the durable audit accepts only store-served records; drift is a violation (D9), foreign durable evidence is a violation (D10).
- **VERIFICATION-SEPARATION** — the IR carries the governed plan's verification anchors verbatim and never interprets them; the verification constraint mirrors the frozen completion binding (requires an anchor); no verification logic, scoring or gating exists in the plane (B4 vocabulary proof).
- **IMPLEMENTATION-COMPLETENESS** — this evidence package maps every AC and checkpoint to exact-revision results; forbidden surfaces untouched (zero `spec/` changes, zero frozen-semantics changes, no planner/execution-lifecycle modifications); the migration-count pins in three existing startup/count tests were mechanically reconciled 28→29 for the disclosed migration 0030 (the same disclosure discipline WORK-048 applied).

## Test battery and implementation evidence

The E1.1-stage-1 battery at the final implementation head `83c8b9e` (**all green, one consecutive run each**):

- `bun run typecheck` — 0 errors.
- `bun run lint` — biome clean, exit 0.
- `python3 scripts/governance-check.py` — `Governance OK: 49 Work Orders, 102 requirements, inFlight=[], frontier=['WORK-049']`.
- `bun run deploy:validate` — `valid: true`, migrations 29 (the deployment-validation CI workflow's local equivalent).
- `bun run test:unit` — **178 files / 2683 tests passed**.
- `bun run test:integration` (real PostgreSQL 16.4, `ZECK_PG_TEST_URL` @ 127.0.0.1:55432) — **105 files / 1033 passed | 13 skipped** (the live-provider honesty skips unchanged from the base).
- `bun run test:architecture` — **88 files / 1168 passed | 4 skipped** (includes the new `e11-ir-boundaries` gate and the new `execution-ir.discrimination` suite).

New WORK-049 tests: **73** (47 unit across 5 suites: `ir`, `constraints`, `cost-model`, `decision-record`, `audit`; 6 integration over real PG: migration vocabulary gate, the full real-PG foundation chain, idempotent re-append + conflict, the N=8 concurrent-append convergence, tenant isolation, read paths; 12 discrimination D1–D12; 8 architecture boundaries B1–B8).

The integration chain (`tests/integration/postgres/execution-ir-decisions.test.ts`) is the end-to-end proof over the real authorities: real execution + tenant → REAL planner `planExecution` (policy set published, decision recorded `allow`) → executions seam reads the durable plan binding → REAL budgets authority row read through the budgets seam → snapshot → IR (identity-verified) → constraints from the CAPTURED policy inputs + capability resolution + budget ceiling + verification anchor (≥6 constraints: cost ceiling, quality floor, latency ceiling, capability satisfaction, budget-monthly, verification-anchor) → two candidate representations over the planner's route facts → deterministic selection → decision record → idempotent append → durable audit with zero violations; and the concurrency proof: N=8 simultaneous identical appends converge to exactly one durable row.

## Optimization decision examples (why a cheaper representation was / was not chosen)

- **Cheaper chosen** (integration, real PG): `base-model-route` claims 1000 µUSD / quality 0.92 / reliability 0.9 (basis `estimated`, source `planning.route-table`) → expected successful-resolution cost `ceil(1000/0.9)` = **1112 µUSD**; `deterministic-replacement` claims 100 µUSD / quality 0.86 / reliability 1.0 (basis `observed`, source `learning.telemetry`) → **100 µUSD**. Both meet the quality threshold 0.8, so the deterministic replacement wins on expected successful-resolution cost — `selectionBasis: lowest-expected-successful-resolution-cost`, recorded with both claims and their bases.
- **Cheaper NOT chosen** (unit, quality-preserving economics): `cheap-below-threshold` claims 1000 µUSD but quality 0.5 < threshold 0.9 → **invalid** (`quality-below-threshold`) regardless of price; `sufficient-model` at 500000 µUSD / quality 0.95 is selected. Price never overrides quality.
- **Tie determinism** (unit): three candidates with equal expected successful-resolution cost 100000 µUSD order by the neutral representation ladder — `cache-reuse` (ladder rank 1) before `sufficient-model` (rank 4), and `aaa-cache` before `bbb-cache` within the class — the same inputs always produce the same ranking and winner.

## Changed-file inventory (23 implementation files, +7446/−14, plus the two documentation files)

Declared Change Surfaces only — the IR foundation plane, the disclosed migration, the declared minimal module seams, E1.1 foundation tests, and the operator/developer documentation:

- **Platform IR plane** (`src/platform/execution-ir/`): `canonical.ts`, `ir.ts`, `constraints.ts`, `cost-model.ts`, `decision-record.ts`, `decision-store.ts`, `audit.ts`, `seams.ts`.
- **Migration**: `src/platform/db/migrations/0030_execution_ir_decision_records.sql` (the single new migration — count pins reconciled 28→29 in `tests/unit/db/startup.test.ts`, `tests/integration/postgres/pg-database-port.test.ts`, `tests/architecture/d02-production-paths.test.ts`).
- **Declared module seams** (the WORK-048 precedent — module adapters implementing platform seam types over their own authorities): `src/modules/planning/adapters/ir-plan-source.ts`, `src/modules/executions/adapters/ir-execution-binding.ts` (read-only), `src/modules/budgets/adapters/ir-cost-constraints.ts` (read-only).
- **Tests**: `tests/unit/platform/execution-ir/{ir,constraints,cost-model,decision-record,audit}.test.ts`, `tests/integration/postgres/execution-ir-decisions.test.ts`, `tests/discrimination/execution-ir.discrimination.test.ts`, `tests/architecture/e11-ir-boundaries.test.ts`.
- **Documentation**: `docs/execution-ir.md` (operator/developer guide for the IR surface), this evidence document.

Zero changes to frozen semantics, zero `spec/development-state/*` changes, zero planner/execution-lifecycle modifications, no new provider SDK or runtime mechanism.

## CI status

The repository CI (`.github/workflows/governance.yml` on pull requests) runs exactly the locally executed battery: `governance-check.py`, `bun install --frozen-lockfile`, `typecheck`, `lint`, `test:architecture`, `test:unit`, `test:integration`; `deployment-validation.yml` runs `deploy:validate`. Every one of these was executed locally at the final implementation head with the results above (integration over the real local PostgreSQL 16.4). The Actions runs themselves execute on the PR — their status is reported on the PR, never self-claimed here.

## Known limitations (honest boundaries)

- **Live model/substrate/provider selection: NOT RUN** — out of scope for stage 1 (and for this worker environment, which holds no provider credentials). Candidate cost/quality/reliability claims in the tests are explicit-basis fixtures; live claim derivation from provider telemetry is later E1.1 work (the estimation-basis contract — observed/estimated/defaulted — is exactly the seam that wiring will fill).
- **Optimizer/execution-compiler engine: NOT RUN** — WORK-050. This order ships no code that transforms an execution at runtime; the `representation-substitution` transformation basis is representable and discriminated but no compiler produces such candidates yet.
- **Decision records are never consulted by any execution path** — by construction and by boundary proof (B5/D8). The consumer that will legitimately read them (the WORK-050 compiler's evidence trail and the audit) is future work.
- The `observed` estimation basis is proven with fixture claims (deterministic evidence); wiring it to the learning/telemetry authority's real observations is a later stage.
