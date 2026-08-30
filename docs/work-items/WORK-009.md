# WORK-009 Evidence — Model routing and adaptive execution planner

**Work Order:** `spec/work-orders/WORK-009.md` (HIGH_ASSURANCE)
**Requirements owned:** INT-001, INT-003, INT-004 (primary); INT-002, DTR-001, DTR-004, HUM-001 satisfied at the planning boundary
**Base revision:** `74e65db1ec43becae9e8b5f6fcd81bb72b5b4a61` (main tip; frontier `['WORK-009','WORK-010']`)
**Governance repair commit:** `651e29d` (pre-existing main defect, disclosed below)
**Implementation head:** `79a6f08f5133a2d769de66c7995942e426405eca`
**Branch:** `work/WORK-009-deterministic-first-planner`

## Requirement mapping

| Requirement | Implementation | Proof |
|---|---|---|
| INT-001 structured task profile | `src/modules/planning/domain/task-profile.ts` — pure rule-based derivation over task kind/input/output characteristics/risk/quality targets, frozen 8-kind vocabulary, fail-closed typed validation | `tests/unit/planning/task-profile.test.ts` (13) |
| INT-002 capability requirements precede provider/model selection (boundary) | `src/modules/planning/application/planner.ts` pipeline steps 3–5: capability resolution through the WORK-005 registry BEFORE the route explorer is ever consulted; the explorer seam is only reached when sufficiency ≠ sufficient | planner-service ordering tests (spy proofs) + `tests/architecture/planner-surface.test.ts` scanner gate + P2 discrimination mutants |
| INT-003 composable execution plans | `src/modules/planning/domain/plan.ts` — immutable content-addressed DAGs over the 17 frozen architecture §9 step classes; hybrid plans first-class | `tests/unit/planning/execution-plan.test.ts` (15) + hybrid/cascade planner tests |
| INT-004 cheap-first/cascade planning | `src/modules/planning/domain/strategy.ts` — `compareCheapFirst` (cost → quality → latency → fewer model calls) + cascade candidate composition with escalation-on-verification-failure plan shape | `tests/unit/planning/strategy-selection.test.ts` (10) + planner-service tests |
| DTR-001 deterministicizable subgraphs representable as planning candidates | deterministic catalog entries are first-class plan candidates with capability identity, estimated cost, expected quality, verification strategy | `src/modules/planning/adapters/in-memory-deterministic-catalog.ts` + sufficiency/selection tests |
| DTR-004 plan decisions expose evidence/confidence/rationale | `src/modules/planning/domain/decision.ts` + `domain/subgraph-evidence.ts` — every decision record carries candidates, rationale codes, quality confidence, subgraph observations with bases | `tests/unit/planning/subgraph-evidence.test.ts` (5) + planner-service evidence assertions |
| HUM-001 bounded evaluation at material uncertainty | uncertain determinism ⇒ `bounded-evaluation` candidate class (deterministic execution + bounded model sample + compare step) instead of unconditional escalation (ADR-0012 discipline; ratings themselves belong to WORK-022) | sufficiency uncertain-path test + bounded-evaluation composition |

## Implementation

42 files changed (+7020/−59) at the implementation head: 26 planning-module files (domain 7, ports 7, adapters 7, application 1, barrels 4), 3 additive executions files (event type, `recordPlanningDecision` service method + input/outcome types, public barrel exports), 10 test files (6 unit planning suites, 1 executions unit suite, 1 architecture suite, 1 discrimination suite + shared scanner lib, 1 real-PG integration suite), 2 development-state JSONs (WORK-009 → in-flight; WORK-010 untouched/preserved eligible), 1 docs repair (WORK-021/022 protocol sections).

The planner pipeline (THE order is the protection — `spec/planning-contract.md`):

```text
task → policy inputs → capability resolution → deterministic sufficiency
     → candidate strategies → [provider/model selection only if needed]
     → verification strategy → durable decision record
```

- **TaskProfile** (`domain/task-profile.ts`): rule-based, deterministic derivation; semantic-reasoning reconciliation (downward-only explicit override; contradictory upward declarations rejected; a deterministic kind declaring model requirements fails closed; downward narrowing drops the kind table's model/human requirements).
- **ExecutionPlan** (`domain/plan.ts`): content-addressed `planId` (sha256 over canonical typed form), deeply frozen at construction, DAG validation (unique ids, edge refs, acyclicity via Kahn, self-loop rejection), `modelCalls`/`hasRouteRef` DERIVED, and the fabrication boundary: route refs are legal ONLY on generative step classes; a zero-model plan carrying a route is unrepresentable; a deterministic-only strategy with generative steps is unrepresentable.
- **Canonical serialization** (`domain/canonical.ts`): sorted keys at every depth, closed universe, finite floats via the ECMAScript shortest round-trip decimal (injective on doubles — quality probabilities keep distinct identities); NaN/±Infinity rejected.
- **Deterministic sufficiency** (`domain/sufficiency.ts`): the explicit ADR-0007 decision — semantic requirement ⇒ insufficient; unmet capability ⇒ insufficient; confident quality gap ⇒ insufficient (material reduction of the verified outcome); unverified estimate meeting target ⇒ UNCERTAIN (bounded evaluation, never blind escalation); else sufficient. Policy enters as INPUT, never as an override.
- **Strategies** (`domain/strategy.ts`): policy as HARD constraints (`filterAdmissibility` — a forbidden route makes the whole candidate inadmissible regardless of price/quality; cost/latency ceilings; quality floor) + `selectStrategy` (deterministic-first hard preference when sufficient; cheap-first otherwise; typed `none` → `NO_ELIGIBLE_ROUTE` upstream).
- **Subgraph evidence** (`domain/subgraph-evidence.ts`): per-step observations + the whole-plan hybrid observation; computation type, expected cost/quality, verification strategy, repeated-use opportunity and deterministicization potential, each with a recorded basis; evidence ONLY (LEARNING-NONAUTHORITY — no runtime promotion path exists in this module).
- **Decision record** (`domain/decision.ts`): closed-shape validation (`validatePlanningDecision`); content-derived `decisionId` (digest over request identity + profile + selection) so idempotent retries derive the same identity; `recordDigest` integrity binding; `replanOf` provenance for replanning.
- **Planner service** (`application/planner.ts`): the pipeline; the route explorer is consulted ONLY inside `if (sufficiency.outcome !== "sufficient")` and only when model-kind requirements exist; candidate composition covers deterministic-only (always when coverage exists), generative, hybrid, cascade (deterministic-first with escalate-on-failure and terminate happy-path), bounded-evaluation (uncertain path); the documented `sufficiency` discrimination hook exists for mutation records only (WORK-005 validation-hook precedent).
- **Executions extension** (declared surface, additive): `PLANNING_DECISION_EVENT_TYPE = "planning.decision-recorded"`; `recordPlanningDecision` validates the envelope essentials, locks the row (tenant scope before any write), enforces the PLANNING/REPLANNING state guard, appends the envelope + identity-preserving sequence advance (the policy-denied precedent) in ONE transaction with idempotency arbitration (`executions.record-planning-decision`). No state-machine change (TRANSITION_TABLE untouched — architecture-gated).
- **Adapters**: node digest (crypto confined to one file), in-memory deterministic catalog (planning-contract minimum set, IDs aligned with the WORK-005 seed vocabulary), deterministic-capability publisher (publishes ADDITIONAL claims into the registry through the sanctioned path; pre-arbitrated claims left untouched), capability-authority/policy-inputs adapters over the real authorities, composition-fed route-table explorer, planning sink over the executions public service (returns the DURABLE record on replay).

## Design decisions (architect-review pointers)

1. **Durable planning rides the executions ledger, not a new store** — the WO's declared surfaces exclude `src/platform/db/migrations/`, so no new tables are possible; planning decisions are append-only `planning.decision-recorded` envelopes through the executions single write path (gapless sequence, idempotency, concurrency arbitration all inherited; the WORK-008 no-migration durability precedent, now with REAL PostgreSQL proof because the executions SQL fabric already exists).
2. **The planner introduces no state machine** — execution status transitions stay owned by `/executions` (the invariants list); the planner records decisions only while the execution is PLANNING/REPLANNING (state guard, zero writes out of phase).
3. **Zero-model is unrepresentable-as-fabrication** — the plan domain rejects route refs on non-generative steps, zero-model plans with route refs, generative steps without routes, and deterministic-only strategies containing generative steps.
4. **Quality floats in the digest universe** — unlike WORK-008's integers-only payload universe, planning quality estimates are probabilities; the canonical serializer uses the ECMAScript shortest round-trip decimal (deterministic + injective on doubles) while still rejecting non-finite values. Disclosed as a deliberate divergence with rationale.
5. **Content-derived decisionId** — idempotent plan creation requires the decision identity to be a function of the logical request (execution + replanOf + profile digest + selection); a fresh UUID per call would break same-key replay (caught by my own test before commit — see disclosures).
6. **Deterministic catalog vs capability registry** — estimates live in the planning catalog; CLAIMS live in the single WORK-005 authority, added through the sanctioned publish path (rail-adapter precedent). IDs align with the existing seed vocabulary where claims already exist.
7. **Route exploration is composition-fed** — the models module exposes dispatch, not a pricing catalog; the explorer port takes a neutral route table at assembly (real rail metadata arrives with later work). The PORT is the seam; policy filtering happens at admissibility, never in the explorer.
8. **Cascade expected cost** — `ceil(deterministic_cost + (1 − deterministic_quality) × route_cost)` in integer micro-USD (documented conservative rounding).
9. **HUM-001 scope** — the planner provides the bounded-evaluation PATH (compare step + policy/budget subjection); the rating mechanism itself is WORK-022's surface. No human-rating authority is created here.

## Verification (at implementation head `79a6f08f5133a2d769de66c7995942e426405eca`)

| Check | Result |
|---|---|
| `bun install --frozen-lockfile` | clean; runtime dependencies `[]` unchanged |
| `python3 scripts/governance-check.py` | `Governance OK: 22 Work Orders, 53 requirements, frontier=['WORK-010']` (WORK-009 in-flight; WORK-010 preserved eligible for the parallel wave) |
| `bun run typecheck` | 0 errors |
| `bun run lint` (biome, 348 files) | clean, 0 diagnostics |
| Full suite with real PostgreSQL | **735/735 passed (89 files)** — TWICE consecutively, exit 0 both runs |
| Census vs baseline 638/638 (79 files) | +97 tests / +10 files: unit 360→435, architecture 47→55, discrimination 122→126, real-PG 103→112, integration 6→7 |

One baseline anomaly, honestly recorded: the FIRST baseline invocation (before any source change, at the repaired base) exited 1 at the vitest layer with zero failing tests — the WORK-005/WORK-007 transient class (piped-output truncation); three subsequent consecutive full runs at the same tree were green (623… this round's base was 638) and every later run was green.

## Checkpoint evidence (all four contracts)

| Contract | Status | Evidence |
|---|---|---|
| IMPLEMENTATION-COMPLETENESS | evidence-recorded | this file; `tests/unit/planning/*` (6 suites); `tests/integration/postgres/planning-decisions.test.ts` |
| IDENTITY-IDEMPOTENCY | evidence-recorded | content-derived decisionId + executions idempotency arbitration: `tests/unit/planning/planner-service.test.ts` (idempotent replay, one envelope); `tests/unit/executions/planning-record.test.ts`; `tests/integration/postgres/planning-decisions.test.ts` (replay; same-key/different-decision → `IDEMPOTENCY_KEY_REUSED`) |
| CONCURRENCY-CRASH-SAFETY | evidence-recorded | `tests/integration/postgres/planning-decisions.test.ts` — ×8 concurrent duplicate planning converges to ONE envelope with real PostgreSQL arbitration, gapless ledger preserved; single-transaction append + row advance (crash-atomicity inherited from the executions write path) |
| SELF-HOSTING-BOUNDARY | evidence-recorded | `tests/architecture/planner-surface.test.ts` (ordering scanner gate, type-only seam discipline, provider-independent public barrel, crypto confinement, no internal/ imports, frozen vocabularies, untouched executions state machine); `tests/discrimination/planner-deterministic-first.discrimination.test.ts` |

## Discrimination evidence (HIGH_ASSURANCE boundaries named by this Work Order)

| ID | Boundary | RED RECORD |
|---|---|---|
| P1 | always-generative planner rejected when deterministic suffices (planning-contract "required future discrimination proof"; AC-10) | production selects the zero-model plan and NEVER consults the explorer (spy proof: 0 explorations); the mutant (sufficiency hook always-insufficient — the protection removed through the documented discrimination hook) selects model calls on semantic tasks and fails `NO_ELIGIBLE_ROUTE` on the sufficient arithmetic task — it cannot produce a zero-model success |
| P2 | provider-first implementation rejected | shared order scanner (`tests/discrimination/lib/planner-order.ts`, also the architecture gate): explorer-before-sufficiency mutant, ungated-exploration mutant, and sufficiency-replaced-by-constant mutant are ALL rejected with named violations |
| P3 | deterministic-capability bypass rejected | empty-catalog mutant loses the deterministic candidate and fails closed `NO_ELIGIBLE_ROUTE` — never silently substitutes generative work; production selects zero-model on the same task |
| P4 | fabricated provider/model for zero-model execution rejected | production `buildPlan` rejects route-on-deterministic-step typed; the mutant (validation copy WITHOUT the check) accepts exactly that fabrication — `modelCalls === 0 && hasRouteRef === true` |
| P5 | forbidden provider never wins on price (AC-9) | production: policy filter first → forbidden-cheapest inadmissible, allowed-expensive selected; the mutant (cost ordering ignoring admissibility) selects the forbidden provider |

## Known limitations

1. The route explorer is composition-fed (neutral route table at assembly); real rail pricing/capability metadata arrives with later work. The port is the seam; policy filtering at admissibility is already proven.
2. The deterministic catalog's quality estimates are code-resident seeds; `qualityConfidence: "estimated"` entries route through bounded evaluation rather than trusted.
3. `bounded-evaluation` candidate quality is estimated as the min of the compared paths; differential-evaluation semantics deepen in WORK-021/022.
4. The planner records decisions; plan EXECUTION (step dispatch) is downstream (WORK-010 tool runtime / models fabric) — this WO owns planning only, per the order.
5. HUM-001: the bounded-evaluation path is provided; the rating/recording mechanism belongs to WORK-022.

## Disclosures

1. **Pre-existing main defect repaired first (commit `651e29d`, docs-only):** `spec/work-orders/WORK-021.md` and `WORK-022.md` were missing the `# Checkpoints` and `# Evidence Contract` protocol headings — `governance-check.py` FAILED on main (exit 1, `WORK-021 missing # Checkpoints`), and main CI was red on every push since the docs-expansion wave (runs 33319679194…33320103430 all failure). The repair adds exactly the canonical sibling text (CRITICAL profile for 021, HIGH_ASSURANCE for 022; governance logic untouched). **Parallel-wave note:** the WORK-010 implementer faces the same red gate; if their branch carries a different repair of the same two files, the merge-time union should take either side (semantically equivalent docs).
2. **Pre-existing executions defect fixed inside the declared surface:** `fail` with `verificationResults` wrote the refs onto the FAILED row, violating migration 0004's `executions_verification_binding_shape` on real PostgreSQL (refs exist iff COMPLETED; the in-memory fake cannot surface the physical CHECK). The fix writes row refs only for COMPLETED; the verification rows + envelope references are unchanged. Disclosed in the commit message and here; surfaced by this round's PG replanning test.
3. **Design correction during implementation, caught by my own test before commit:** the initial decisionId was a fresh UUID per call, which broke idempotent same-key replay (different fingerprint). Fixed to a content-derived digest identity; the sink adapter now returns the DURABLE record on replay.
4. `read-first` list item 12 names `spec/work-items/WORK-009.md` — that path does not exist (the evidence convention is `docs/work-items/WORK-009.md`, created here). Treated as a typo; no other action.
5. Transient vitest exit-1 at the unmodified repaired base (zero failing tests; the documented WORK-005/007 transient class) — recorded under Verification.
6. Canonical-serialization divergence from WORK-008 (finite floats via injective shortest round-trip decimal) — deliberate, documented in `domain/canonical.ts` and Design decision 4.
7. No migrations (declared surfaces exclude the migrations directory); runtime dependencies remain `[]`; no provider SDK imports; typed failures from the canonical taxonomy only (`POLICY_DENIED`, `TENANT_SCOPE_VIOLATION`, `INVALID_STATE_TRANSITION`, `IDEMPOTENCY_KEY_REUSED`, `NO_ELIGIBLE_ROUTE`, `PROVIDER_ERROR`).

## PR / merge

- PR: **#18** (`https://github.com/pectoraux/Zeck/pull/18`), opened by the worker against `main` (completion report posted there). The architect is the merge authority; the worker does NOT merge/approve.
- **Two-part binding**: this evidence file binds the implementation head `79a6f08f5133a2d769de66c7995942e426405eca` (verified against `git rev-parse HEAD`, 40-hex exact, character-by-character). The final branch head (this evidence commit) is bound in the PR body + completion comment, per the WORK-001→008 protocol.
- `program-state.json` becomes `complete` only at post-merge finalization with the actual PR number + merge commit (WORK-011+ then unblock per the dependency graph).

## CI status (final head)

CI could not execute for this PR: GitHub does not trigger `pull_request` workflows for conflicted PRs (no merge ref can be computed), and this PR conflicts with `main` in exactly one file (`spec/development-state/program-state.json` — the pre-disclosed parallel-wave union, verified by trial merge). At pickup `main` was governance-RED (WORK-021/022 missing protocol headings — repaired here as disclosed commit `651e29d`); `main` then advanced 20+ docs commits expanding requirements 53→78 while `scripts/governance-check.py:125` still asserts 53, leaving `main` governance-RED again (every `main` push run failing; flagged on the PR and issue #5). Modifying the checker's frozen count is architect authority — not taken.

**Recorded proof in lieu of CI** (the standing no-PostgreSQL-in-CI precedent, WORK-002 onward): the full gate run locally at the final head with real PostgreSQL — governance OK, typecheck 0, lint clean, **735/735 (89 files) TWICE consecutively** — plus the ×2 runs at the implementation head. Once the architect reconciles `main` (checker count vs requirements) and performs the disclosed union-merge, CI can be re-verified on the merged result.
