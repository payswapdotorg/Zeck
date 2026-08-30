# WORK-009 Evidence — Model routing and adaptive execution planner

**Work Order:** `spec/work-orders/WORK-009.md` (HIGH_ASSURANCE)
**Requirements owned:** INT-001, INT-003, INT-004 (primary); INT-002, DTR-001, DTR-004, HUM-001 satisfied at the planning boundary
**Base revision:** `3f7513a83e89ab572decb415aa7fb71922163943` (current main tip; frontier `['WORK-009','WORK-010']` at pickup)
**Implementation head:** `a0c174a86037793f2c5dd6c14b34f1651ddf3785`
**Branch:** `work/WORK-009-deterministic-first-planner`
**Requirements catalog at this base:** 78 frozen requirements (`spec/requirements.md`), each with exactly one primary owner in `spec/requirement-traceability.md`

## Remediation / rebase record (2026-08-30)

PR #18 was originally opened against main `74e65db1ec43becae9e8b5f6fcd81bb72b5b4a61` (53-requirement catalog era) and became conflicted when main advanced. This branch has been **rebased onto current main `3f7513a83e89ab572decb415aa7fb71922163943`**; the implementation is byte-identical to the previously reviewed round (`git diff` between the pre-rebase backup and the rebased branch shows **zero** differences under `src/` and `tests/`).

SHA translation (old head superseded — historical facts only):

| Role | Pre-rebase (SUPERSEDED) | Post-rebase (CURRENT) |
|---|---|---|
| Base | `74e65db1ec43becae9e8b5f6fcd81bb72b5b4a61` | `3f7513a83e89ab572decb415aa7fb71922163943` |
| Governance repair (WORK-021/022 protocol sections) | `651e29d842d7a1e5c6c71a9e0fb6a34975729ab9` | `16c601ba897c4fdcb172facf44a21c861483bbd1` |
| Implementation head | `79a6f08f5133a2d769de66c7995942e426405eca` | `a0c174a86037793f2c5dd6c14b34f1651ddf3785` |
| Final branch head | `5e06461b454144dac97e750899555eec82f3e0e2` | bound in the PR body / completion comment |

Rebase-conflict reconciliation (single conflicting file):

- `spec/development-state/program-state.json` — resolved with **current main as authority** for shared governance content and this branch as authority for the WORK-009 record. Net effect vs main: exactly ONE line — WORK-009 `pending` → `in-flight` with `branch` and `baseRevision: 3f7513a…`. All newer architect decisions on main are preserved (WORK-023..026 work orders; ADR-0013..0015 decision index; `asOf` 2026-08-30T16:16:00Z). WORK-010 remains `pending`/eligible and untouched.
- `spec/development-state/frontier-state.json` / `checkpoint-state.json` — applied cleanly on top of main (main's net change to these files since the old base is zero); the WORK-009 entries' `baseRevision` was updated to the new base.

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

Catalog note: since the original round, main's requirements catalog expanded 53 → 78 (agent control-plane ACP-001..006 and multimodal deployment MOD-001..013, plus AGT-003..008). Every requirement above is textually unchanged on current main, and WORK-009's primary ownership (INT-001/INT-003/INT-004) matches current `spec/requirement-traceability.md` exactly. None of the newly added requirements intersect the planning surfaces owned by this Work Order.

## Implementation

44 files changed (+6562/−35) at the implementation head `a0c174a86037793f2c5dd6c14b34f1651ddf3785` vs the base: 26 planning-module files (domain 7, ports 7, adapters 7, application 1, barrels 4), 3 additive executions files (event type, `recordPlanningDecision` service method + input/outcome types, public barrel exports), 10 test files (7 unit suites, 1 architecture suite, 1 discrimination suite + shared scanner lib, 1 real-PG integration suite), 3 development-state JSONs (WORK-009 → in-flight; WORK-010 untouched/preserved eligible), 2 docs repairs (WORK-021/022 protocol sections — pre-existing main defect, disclosed below).

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

## Verification (at implementation head `a0c174a86037793f2c5dd6c14b34f1651ddf3785`, after the rebase onto `3f7513a`)

| Check | Result |
|---|---|
| `bun install --frozen-lockfile` | clean; runtime dependencies `[]` unchanged (no package.json/bun.lock changes on this branch) |
| `bun run typecheck` | 0 errors |
| `bun run lint` (biome, 348 files) | clean, 0 diagnostics |
| `python3 scripts/governance-check.py` | **exit 1 — IndentationError at line 1, inherited byte-identical from current main** (see "Main-side governance findings"); the checker file was NOT modified (architect authority) |
| Architecture + discrimination suites | 181/182 — the single failure is `governance-gate.discrimination.test.ts` "negative control: a pristine tracked copy passes governance validation", which executes the main-broken checker; proven to fail IDENTICALLY on pristine main `3f7513a` |
| Unit tests | 435/435 (38 files) |
| Integration tests | 117/118 — the single failure is `fresh-clone-governance.test.ts`, which executes the main-broken checker; proven to fail IDENTICALLY on pristine main `3f7513a` |
| Real PostgreSQL suites (`ZECK_PG_TEST_URL`, embedded PG 16.4) | **112/112 (19 files)** — including `tests/integration/postgres/planning-decisions.test.ts` |
| Full suite, run TWICE consecutively | **733/735 (89 files) both runs** — the two failures are exactly the two checker-executing tests above; pristine-main baseline at the same commit: **636/638 (79 files)** with the SAME two failures; delta vs main baseline: **+97 tests / +10 files, all passing** |
| Census vs current-main baseline | unit 360→435 (+75), architecture 47→55 (+8), discrimination 122→127 (+5, the P1–P5 planner suite), integration 109→118 (+9, the real-PG planning-decisions suite) |

## Main-side governance findings (for the architect — NOT repaired here, checker modifications are architect authority)

Current main `3f7513a` is governance-RED and its own CI is red (latest push runs on `3f7513a`, `a524582`, `5a8dc6a`, `354f1c0` all failed; governance job log shows the same `IndentationError`). Findings, in checker execution order:

1. **`scripts/governance-check.py` is truncated** — commit `a524582` ("governance: update frozen requirement count to 72") reduced the file from 157 lines to a 22-line fragment that starts mid-function (line 1 is an indented `assert`). It cannot be parsed by Python. The intended count change (53 → 72) is present in the fragment; the rest of the file (imports, artifact loading, per-Work-Order validation, frontier derivation) was lost.
2. **`spec/development-state/dependency-state.json` is missing WORK-023..026** — the multimodal-deployment wave added them to `program-state.json` but not to `dependency-state.json`, so the (restored) checker fails "program-state and dependency-state have different Work Order identities".
3. **`spec/work-orders/WORK-023.md`..`WORK-026.md` are protocol-incomplete** — each is missing 8 of the 13 required headings (`# Scope Boundaries`, `# Architecture Invariants`, `# Implementation Requirements`, `# Required Checkpoint Contracts`, `# Checkpoints`, `# Evidence Contract`, `# Required Verification`, `# Completion`).
4. **Frozen-requirement count** — the architect's intended count (72) does not match the current catalog: `spec/requirements.md` carries **78** requirement IDs and `spec/requirement-traceability.md` carries exactly 78 matching rows with unique primary owners. (The 72 figure may have been intended to exclude some subset; as written, `re.findall(r"^- ([A-Z]+-\d+):", ...)` finds 78.)

Diagnostic method (no repository files modified): the pre-truncation checker from `5a8dc6a` was run out-of-tree against both pristine main and this branch; both fail first at (2), then (3), then (4). This branch already carries the analogous docs-only repair for WORK-021/WORK-022 (missing `# Checkpoints`/`# Evidence Contract` — disclosure 1 below), which remains necessary and is preserved by the rebase.

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

## Disclosures

1. **Pre-existing main defect repaired first (docs-only, commit `16c601ba897c4fdcb172facf44a21c861483bbd1` post-rebase / `651e29d842d7a1e5c6c71a9e0fb6a34975729ab9` original):** `spec/work-orders/WORK-021.md` and `WORK-022.md` were missing the `# Checkpoints` and `# Evidence Contract` protocol headings — at the original base this made `governance-check.py` fail on main. The repair adds exactly the canonical sibling text (CRITICAL profile for 021, HIGH_ASSURANCE for 022; governance logic untouched). Current main still lacks these sections (the docs wave never carried the fix), so the repair remains necessary after the rebase.
2. **Pre-existing executions defect fixed inside the declared surface (original round, preserved by rebase):** `fail` with `verificationResults` wrote the refs onto the FAILED row, violating migration 0004's `executions_verification_binding_shape` on real PostgreSQL (refs exist iff COMPLETED; the in-memory fake cannot surface the physical CHECK). The fix writes row refs only for COMPLETED; the verification rows + envelope references are unchanged. Disclosed in the commit message and here; surfaced by this round's PG replanning test.
3. **Design correction during implementation, caught by my own test before commit (original round):** the initial decisionId was a fresh UUID per call, which broke idempotent same-key replay (different fingerprint). Fixed to a content-derived digest identity; the sink adapter now returns the DURABLE record on replay.
4. `read-first` list item 12 names `spec/work-items/WORK-009.md` — that path does not exist (the evidence convention is `docs/work-items/WORK-009.md`, created here). Treated as a typo; no other action.
5. Canonical-serialization divergence from WORK-008 (finite floats via injective shortest round-trip decimal) — deliberate, documented in `domain/canonical.ts` and Design decision 4.
6. No migrations (declared surfaces exclude the migrations directory); runtime dependencies remain `[]`; no provider SDK imports; typed failures from the canonical taxonomy only (`POLICY_DENIED`, `TENANT_SCOPE_VIOLATION`, `INVALID_STATE_TRANSITION`, `IDEMPOTENCY_KEY_REUSED`, `NO_ELIGIBLE_ROUTE`, `PROVIDER_ERROR`).
7. **Rebase remediation (this round):** branch rebased onto current main `3f7513a` (see Remediation record). `governance-check.py` was NOT modified even though it is syntactically broken on main — repairing it is architect authority (explicitly out of bounds for the implementer). The two checker-dependent test failures are inherited from main and proven identical on pristine main; all 97 tests added by this Work Order pass, twice consecutively.

## PR / merge

- PR: **#18** (`https://github.com/pectoraux/Zeck/pull/18`), rebased/remediated against architect-advanced main; the previous conflicted head `5e06461b454144dac97e750899555eec82f3e0e2` is superseded. The architect is the merge authority; the worker does NOT merge/approve.
- **Two-part binding**: this evidence file binds the implementation head `a0c174a86037793f2c5dd6c14b34f1651ddf3785` (verified against `git rev-parse`, 40-hex exact, character-by-character). The final branch head is bound in the PR body + completion comment, per the WORK-001→008 protocol.
- `program-state.json` becomes `complete` only at post-merge finalization with the actual PR number + merge commit (WORK-011+ then unblock per the dependency graph).

## CI status (current final head)

After the rebase the PR is **no longer conflicted**, so `pull_request` CI can execute (this was the previous round's blocker). CI will run `bun install --frozen-lockfile` → typecheck → lint → architecture/discrimination → unit → integration. Expected outcome, verified locally at the exact pushed head:

- typecheck / lint / unit: **green**
- architecture+discrimination and integration: **red in exactly two checker-executing tests** (`governance-gate` negative control; `fresh-clone-governance`) — the identical two failures that current main's own CI exhibits (main push runs on `3f7513a`/`a524582`/`5a8dc6a`/`354f1c0` are all red; the governance job fails with the same `IndentationError` from the truncated `scripts/governance-check.py`, and the implementation job fails its Architecture-tests step for the same reason my branch does).

This is recorded as fact, not as a passing claim: **CI on this PR cannot be green while main's governance checker is syntactically broken, and repairing the checker is architect authority.** The remediation comment on the PR carries the run links once CI executes. The full local gate at the pushed head (real PostgreSQL included) is recorded under Verification above.
