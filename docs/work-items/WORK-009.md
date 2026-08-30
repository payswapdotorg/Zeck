# WORK-009 Evidence — Model routing and adaptive execution planner

**Work Order:** `spec/work-orders/WORK-009.md` (HIGH_ASSURANCE)
**Requirements owned:** INT-001, INT-003, INT-004 (primary); INT-002, DTR-001, DTR-004, HUM-001 satisfied at the planning boundary
**Base revision:** `15ea1961406686fa2770212dc322645f52082ca6` (current main tip; frontier `['WORK-009','WORK-010']` at pickup)
**Implementation head:** `1b589cc5d5d69547fc4b16adc1ef5800a47bf811`
**Branch:** `work/WORK-009-deterministic-first-planner`
**Requirements catalog at this base:** 94 requirement IDs in `spec/requirements.md`, each with exactly one primary owner in `spec/requirement-traceability.md` (see "Requirement catalog reconciliation" below — the declared count on main was stale at 86; the repository ledger is authoritative).

## Remediation / rebase record (round 3, 2026-08-30 — against architect-advanced main `15ea196`)

PR #18 has gone through three identity generations. Historical generations remain recorded below as superseded facts only.

| Role | Round 1 (SUPERSEDED) | Round 2 (SUPERSEDED) | Round 3 (CURRENT) |
|---|---|---|---|
| Base | `74e65db1ec43becae9e8b5f6cd81bb72b5b4a61` (53-req era) | `3f7513a83e89ab572decb415aa7fb71922163943` (78-req era) | `15ea1961406686fa2770212dc322645f52082ca6` (94-req ledger) |
| WORK-021/022 protocol repair | `651e29d842d7a1e5c6c71a9e0fb6a34975729ab9` | `16c601ba897c4fdcb172facf44a21c861483bbd1` | `7c3cbae68248c0746fab492904e680647ccb0de8` |
| Implementation head | `79a6f08f5133a2d769de66c7995942e426405eca` | `a0c174a86037793f2c5dd6c14b34f1651ddf3785` | `1b589cc5d5d69547fc4b16adc1ef5800a47bf811` |
| Final branch head | `5e06461b454144dac97e750899555eec82f3e0e2` | `23e597a4055775b455b3300670de78275bd611c6` | bound in the PR body / completion comment |
| Catalog count alignment (new this round) | — | — | `5e6a4aafafbf63c2dc20d16e899b0cf700916d0c` |

**Implementation semantics are preserved exactly:** `git diff backup/work-009-pre-rebase-r2 HEAD -- src/ tests/` is **empty** — the rebased branch's `src/` and `tests/` trees are byte-identical to the previously reviewed round 2 head (`23e597a`). The only content changes this round are governance-state coordination and evidence/documentation.

### Rebase-conflict reconciliation (two conflicting files, resolved per the architect's authority rules)

- `spec/development-state/program-state.json` — resolved with **current main as authority** for architect content; this branch as authority for the WORK-009 record. Net effect vs main: exactly ONE line — WORK-009 `pending` → `in-flight` with `branch` and `baseRevision: 15ea196…`. All architect-side state on main is preserved (31 Work Orders including WORK-023..026 and the new substrate wave WORK-027..031; ADR index through ADR-0016; `asOf` 2026-08-30T18:12:00Z; the restored checker file untouched). WORK-010 remains `pending`/eligible and untouched.
- `spec/development-state/frontier-state.json` — resolved with main's authority for the blocked set (extended through WORK-031 by the substrate wave) plus this branch's in-flight coordination: `eligible: ["WORK-010"]`, `inFlight: ["WORK-009"]`. The checker's derived frontier matches exactly.
- `spec/development-state/dependency-state.json` / `checkpoint-state.json` — applied cleanly (branch does not touch dependency-state; the WORK-009 checkpoint entry is branch-owned; its `baseRevision` is rebound to `15ea196…`).

### What this branch deliberately does NOT revert from current main

ACR-003 / ADR-0016 computational-substrate extensibility, WORK-027..031 (substrate work orders), WORK-023..026 (multimodal deployment contracts), the restored `scripts/governance-check.py` (untouched — architect authority), the ledger-derived requirement-count validation, and every completed Work Order's state. Verified: `git diff origin/main HEAD -- scripts/ spec/architecture.md spec/architecture-lock.md spec/contracts.md spec/planning-contract.md spec/requirements.md spec/requirement-traceability.md spec/dependency-graph.md` is **empty**; the only spec/ changes are the WORK-021/022 protocol-heading repair, the two coordinated development-state JSONs, and this branch's checkpoint entry.

## Requirement catalog reconciliation (this round's governance finding — disclosed)

Current main `15ea196` fails its own restored `governance-check.py` in two places, both pre-existing and both repaired on this branch in separately disclosed commits:

1. **WORK-021/WORK-022 protocol headings** (fails first on pristine main): both Work Orders still lack `# Checkpoints` and `# Evidence Contract`. This branch carries the docs-only canonical-sibling repair from earlier rounds (now `7c3cbae`), which remains necessary and is preserved by the rebase.
2. **`requirementCatalog.count` data defect** (fails next): main's program-state declares `count: 86` while `spec/requirements.md` carries **94** requirement IDs (the substrate wave `bcb9fca` raised the ledger 78 → 94; `13e9c1f` then declared 86 — a stale partial count of only half the wave). The architect's own commit rule is "derive requirement count from repository ledger", and the restored checker enforces `count == len(requirement IDs)`. This branch aligns the declaration to **94** in commit `5e6a4aa` — data-only, governance-model `selfHostingBoundary.may` explicitly permits the worker to "maintain development state", the change is disclosed here and in the PR body, weakens no invariant, and touches no frozen architecture, no requirements.md content and no checker logic. The architect may trivially revert or amend this one-line alignment at review if a different catalog version was intended.
3. **Disclosed, NOT repaired:** `spec/requirements.md`'s footer line still reads "Total requirements: **86**" — stale arithmetic (the footer has lagged the actual ledger across waves: it read 72 when the ledger had 78). The footer is not validated by the checker and requirements.md is frozen architect-owned catalog content, so the correction is left to architect authority.

After these two disclosed repairs, `python3 scripts/governance-check.py` on this branch prints: `Governance OK: 31 Work Orders, 94 requirements, frontier=['WORK-010']`.

## Requirement mapping

| Requirement | Implementation | Proof |
|---|---|---|
| INT-001 structured task profile | `src/modules/planning/domain/task-profile.ts` — pure rule-based derivation over task kind/input/output characteristics/risk/quality targets, frozen 8-kind vocabulary, fail-closed typed validation | `tests/unit/planning/task-profile.test.ts` (13) |
| INT-002 capability requirements precede provider/model selection (boundary) | `src/modules/planning/application/planner.ts` pipeline steps 3–5: capability resolution through the WORK-005 registry BEFORE the route explorer is ever consulted; the explorer seam is only reached when sufficiency ≠ sufficient | planner-service ordering tests (spy proofs) + `tests/architecture/planner-surface.test.ts` scanner gate + P2 discrimination mutants |
| INT-003 composable execution plans | `src/modules/planning/domain/plan.ts` — immutable content-addressed DAGs over the frozen architecture §9 step classes; hybrid plans first-class | `tests/unit/planning/execution-plan.test.ts` (15) + hybrid/cascade planner tests |
| INT-004 cheap-first/cascade planning | `src/modules/planning/domain/strategy.ts` — `compareCheapFirst` (cost → quality → latency → fewer model calls) + cascade candidate composition with escalation-on-verification-failure plan shape | `tests/unit/planning/strategy-selection.test.ts` (10) + planner-service tests |
| DTR-001 deterministicizable subgraphs representable as planning candidates | deterministic catalog entries are first-class plan candidates with capability identity, estimated cost, expected quality, verification strategy | `src/modules/planning/adapters/in-memory-deterministic-catalog.ts` + sufficiency/selection tests |
| DTR-004 plan decisions expose evidence/confidence/rationale | `src/modules/planning/domain/decision.ts` + `domain/subgraph-evidence.ts` — every decision record carries candidates, rationale codes, quality confidence, subgraph observations with bases | `tests/unit/planning/subgraph-evidence.test.ts` (5) + planner-service evidence assertions |
| HUM-001 bounded evaluation at material uncertainty | uncertain determinism ⇒ `bounded-evaluation` candidate class (deterministic execution + bounded model sample + compare step) instead of unconditional escalation (ADR-0012 discipline; ratings themselves belong to WORK-022) | sufficiency uncertain-path test + bounded-evaluation composition |
| ADR-0016 / ACR-003 substrate extensibility (compatibility, no new authority) | the planner reasons over capability/substrate metadata (WORK-005 registry claims, deterministic catalog entries, composition-fed route table) and never hard-codes vendors or modalities; substrate/vendor choice stays downstream of policy → capability → sufficiency (ADR-0016 invariant 4); no second planner authority is introduced (invariant 2/3) | `tests/architecture/planner-surface.test.ts` (provider-independent public barrel, no internal/ imports, frozen vocabularies) + capability-vocabulary-neutrality discrimination suite (WORK-005) |

Catalog note: the substrate wave added CSX-001..004, CUI-001..003, LNG-001..003, EDGE-001..003, ACC-001..003 — all owned by WORK-027..031 per current `spec/requirement-traceability.md`. None intersect WORK-009's planning surfaces; WORK-009's primary ownership (INT-001/INT-003/INT-004) matches current traceability exactly, and every requirement text owned or boundary-satisfied here is unchanged on current main.

## Implementation

44 files changed at the implementation head `1b589cc5d5d69547fc4b16adc1ef5800a47bf811` vs the base (+6562/−35): 26 planning-module files (domain 7, ports 7, adapters 7, application 1, barrels 4), 3 additive executions files (event type, `recordPlanningDecision` service method + input/outcome types, public barrel exports), 10 test files (7 unit suites, 1 architecture suite, 1 discrimination suite + shared scanner lib, 1 real-PG integration suite), 3 development-state JSONs (WORK-009 → in-flight; WORK-010 untouched/preserved eligible), 2 docs repairs (WORK-021/022 protocol sections — pre-existing main defect, disclosed above).

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
10. **ACR-003 posture** — the planner is already substrate-neutral: capability resolution, deterministic sufficiency and candidate composition are expressed over capability metadata (the WORK-005 registry + deterministic catalog), not over a vendor/modality enum; future workload classes (WORK-027..031 substrates) enter as capabilities and route-table metadata without a planner change. No substrate concept creates a second planner authority (ADR-0016 invariants 2–4).

## Verification (at the rebased branch, real results from this round — all commands executed against the working tree at the final pre-push head)

| Check | Result (branch) | Result (pristine main `15ea196` baseline, same commands) |
|---|---|---|
| `bun install --frozen-lockfile` | clean; 68 installs / 117 packages, no changes; runtime deps `[]` unchanged | — |
| `bun run typecheck` | **0 errors** | 0 errors |
| `bun run lint` (biome) | **clean, 0 diagnostics (348 files)** | clean (316 files) |
| `python3 scripts/governance-check.py` | **GREEN — `Governance OK: 31 Work Orders, 94 requirements, frontier=['WORK-010']`** | **exit 1** — WORK-021 missing `# Checkpoints` (then WORK-022, then catalog 86≠94; checker itself intact) |
| Architecture + discrimination suites | **182/182 (30 files)** | 168/169 (28 files; the 1 failure is the governance-gate negative control executing main's failing checker) |
| Unit tests | **435/435 (38 files)** | 360/360 (31 files) |
| Integration tests (real PG) | **118/118 (21 files)** | 108/109 (20 files; the 1 failure is fresh-clone-governance executing main's failing checker) |
| Real PostgreSQL suites (`ZECK_PG_TEST_URL`, embedded PG 16.4) | **112/112 (19 files)** — including `tests/integration/postgres/planning-decisions.test.ts` | 103/103 (18 files) |
| Full suite, run TWICE consecutively | **735/735 (89 files) BOTH runs** | 636/638 (79 files) |
| Census vs main baseline | arch+discrim 168→182 (+14, incl. repaired negative control), unit 360→435 (+75), integration 108→118 (+10, incl. repaired fresh-clone-governance), real-PG 103→112 (+9) | — |

All planner suites individually confirmed green this round: `tests/architecture/planner-surface.test.ts` (8), `tests/discrimination/planner-deterministic-first.discrimination.test.ts` (5 — the P1–P5 boundary proofs), `tests/unit/planning/*` (7 suites), `tests/unit/executions/planning-record.test.ts`, `tests/integration/postgres/planning-decisions.test.ts`.

## Checkpoint evidence (all four contracts)

| Contract | Status | Evidence |
|---|---|---|
| IMPLEMENTATION-COMPLETENESS | evidence-recorded | this file; `tests/unit/planning/*` (7 suites); `tests/integration/postgres/planning-decisions.test.ts` |
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

All five discrimination tests pass on the rebased branch (see Verification).

## Known limitations

1. The route explorer is composition-fed (neutral route table at assembly); real rail pricing/capability metadata arrives with later work. The port is the seam; policy filtering at admissibility is already proven.
2. The deterministic catalog's quality estimates are code-resident seeds; `qualityConfidence: "estimated"` entries route through bounded evaluation rather than trusted.
3. `bounded-evaluation` candidate quality is estimated as the min of the compared paths; differential-evaluation semantics deepen in WORK-021/022.
4. The planner records decisions; plan EXECUTION (step dispatch) is downstream (WORK-010 tool runtime / models fabric) — this WO owns planning only, per the order.
5. HUM-001: the bounded-evaluation path is provided; the rating/recording mechanism belongs to WORK-022.
6. Real substrate workloads (computer-use, edge, training/batch, accelerators — ADR-0016) reach the planner as capabilities and route metadata through WORK-027..031; no substrate-specific branching exists here by design.

## Disclosures

1. **Pre-existing main defect repaired (docs-only, commit `7c3cbae` rebased from `651e29d`/`16c601b`):** `spec/work-orders/WORK-021.md` and `WORK-022.md` were missing the `# Checkpoints` and `# Evidence Contract` protocol headings — on current main this is the FIRST failure of the restored `governance-check.py`. The repair adds exactly the canonical sibling text (CRITICAL profile for 021, HIGH_ASSURANCE for 022; governance logic untouched). Main still lacks these sections, so the repair remains necessary after this rebase.
2. **Pre-existing main defect repaired (data-only, commit `5e6a4aa`, NEW this round):** `requirementCatalog.count` declared 86 while the ledger carries 94 requirement IDs; aligned to 94 as detailed under "Requirement catalog reconciliation". Explicitly flagged for architect confirmation; trivially revertible.
3. **Pre-existing main defect disclosed, NOT repaired:** `spec/requirements.md` footer still says "Total requirements: **86**" while the file carries 94 IDs (footer arithmetic has lagged the ledger across waves — it read 72 when the ledger had 78). Frozen architect-owned catalog content; correction left to architect authority.
4. **Pre-existing executions defect fixed inside the declared surface (original round, preserved by rebase):** `fail` with `verificationResults` wrote the refs onto the FAILED row, violating migration 0004's `executions_verification_binding_shape` on real PostgreSQL (refs exist iff COMPLETED; the in-memory fake cannot surface the physical CHECK). The fix writes row refs only for COMPLETED; the verification rows + envelope references are unchanged. Disclosed in the commit message and here; surfaced by this round's PG replanning test.
5. **Design correction during implementation, caught by my own test before commit (original round):** the initial decisionId was a fresh UUID per call, which broke idempotent same-key replay (different fingerprint). Fixed to a content-derived digest identity; the sink adapter now returns the DURABLE record on replay.
6. `read-first` list item 12 names `spec/work-items/WORK-009.md` — that path does not exist (the evidence convention is `docs/work-items/WORK-009.md`, created here). Treated as a typo; no other action.
7. Canonical-serialization divergence from WORK-008 (finite floats via injective shortest round-trip decimal) — deliberate, documented in `domain/canonical.ts` and Design decision 4.
8. No migrations (declared surfaces exclude the migrations directory); runtime dependencies remain `[]`; no provider SDK imports; typed failures from the canonical taxonomy only (`POLICY_DENIED`, `TENANT_SCOPE_VIOLATION`, `INVALID_STATE_TRANSITION`, `IDEMPOTENCY_KEY_REUSED`, `NO_ELIGIBLE_ROUTE`, `PROVIDER_ERROR`).
9. **Rebase remediation (this round):** branch rebased onto current main `15ea196` (architect handoff of 2026-08-30T18:43Z). `governance-check.py` was NOT modified (restored checker intact, architect authority). Implementation verified byte-identical to the previously reviewed round 2 (empty `src/`+`tests/` diff vs the pre-rebase backup). All 735 tests pass twice consecutively with real PostgreSQL; the two failures that round 2 inherited from main's broken checker are now green on this branch because main's checker is restored and this branch repairs the two remaining main-side governance defects.

## PR / merge

- PR: **#18** (`https://github.com/pectoraux/Zeck/pull/18`), rebased/remediated against architect-advanced main `15ea196`; the round-2 head `23e597a4055775b455b3300670de78275bd611c6` (and round-1 head `5e06461b454144dac97e750899555eec82f3e0e2`) are superseded. The architect is the merge authority; the worker does NOT merge/approve.
- **Two-part binding**: this evidence file binds the implementation head `1b589cc5d5d69547fc4b16adc1ef5800a47bf811` (verified against `git rev-parse`, 40-hex exact, character-by-character). The final branch head is bound in the PR body + completion comment, per the WORK-001→008 protocol.
- `program-state.json` becomes `complete` only at post-merge finalization with the actual PR number + merge commit (WORK-011+ then unblock per the dependency graph).

## CI status (current final head)

Recorded after push: the PR is no longer conflicted after this rebase, so `pull_request` CI executes on the actual final head. The governance job runs the restored checker against this branch's tree (GREEN locally at the pushed head: `Governance OK: 31 Work Orders, 94 requirements, frontier=['WORK-010']`); the implementation job runs frozen install → typecheck → lint → architecture/discrimination → unit → integration, all green locally at the pushed head with real PostgreSQL. The run links and job-level results for the exact final head are recorded in the PR completion comment — no CI result is claimed before it has actually executed.
