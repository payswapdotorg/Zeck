# WORK-017 Evidence — Advanced tool learning and tool-composition intelligence

Work Order: `spec/work-orders/WORK-017.md`
Assurance: `STANDARD` · Architecture: `v1.0` (frozen) · ADR-0005/0007/0008/0010/0011/0012/0016 read
Branch: `work/WORK-017-tool-composition-learning` · Base: `d35c5b6f664b3418e90fcdb20e2eb5d3cc0d936d` (actual current main at pickup — verified by `git fetch origin` + `git rev-parse origin/main`; WORK-016 complete/merged as PR #26)
Implementation revision (this file binds): `aba0bcafe03b74a5312bdab61be3600246efd6cd` (implementation commit)
Final branch head: bound in the PR body (the two-phase SHA binding convention — this evidence commit cannot contain its own SHA)

## Pre-existing main defect found at pickup (proved, repaired, disclosed)

Main at pickup was RED on its own governance and CI: the WORK-016 finalization commit `d35c5b6` advanced the frontier for WORK-017 only, but WORK-023 (deps WORK-011/012/015/016 — all complete) and WORK-031 (deps WORK-006..016 — all complete) also became computed-eligible. The checker's own invariant (`frontier == computed eligible`) failed on pristine main (`frontier mismatch: expected ['WORK-017', 'WORK-023', 'WORK-031'], got ['WORK-017']`), and the governance-gate discrimination test's negative control failed (1 failing architecture test on pristine main — reproduced locally at `d35c5b6`); main's CI runs 33419472206/33419500408 show governance + implementation (architecture step) failing.

Repair commit `eca980d` (the FIRST commit on this branch, before the transition): promotes WORK-023 and WORK-031 to `eligible` in `frontier-state.json` — the derived bookkeeping ONLY. No Work Order content, status, scope or acceptance criterion was modified (program-state untouched for WORK-018+; WORK-023/031 remain pending). This restores the invariant the architect's own checker defines — the `238100b` precedent (WORK-011's finalization promoted WORK-012+WORK-013 together). Without it no worker branch can be governance-green. The state protocol then moved WORK-017 to in-flight (commit `682292a`); after the transition the checker computes and reads `frontier=['WORK-023', 'WORK-031']`, WORK-017 the sole in-flight item, WORK-018+ untouched.

## Requirement/context mapping

The Work Order owns no primary requirement IDs ("implementation substrate/governance"); the acceptance criteria map:

| Criterion | Implementation | Proof |
|---|---|---|
| 1. Learn tool-sequence effectiveness by task class and policy context | `analyzeToolSequences` (learning domain, pure): segregates the telemetry population by the policy-relevant context key (task class + capability set + strategy class + context strategy — the policy-relevant vocabulary telemetry ACTUALLY records), mines each observed tool sequence, and evaluates it jointly (population, success, verification rollup, mean cost/latency, failure-mode distribution) | Unit composition-analysis (11 tests: segregation M13, statistics, window, tiny samples); PG generation proofs; discrimination R-M13 |
| 2. Ranked compositions with confidence, provenance, evaluation window | `CompositionRecommendation` (closed shape): deterministic ranking (success rate desc → population desc → canonical order) with honest confidence classification (binomial-spread discipline; below the floor ⇒ INCONCLUSIVE, never fabricated), mandatory provenance (sourceExecutionIds + evidenceRefs, non-empty) and the recorded evaluation window; every recommendation pins exact `(toolId, version)` pairs; durable as the versioned immutable `CompositionRecommendationSet` (digest, population fingerprint) | Unit + PG (durable row, digest, window); discrimination M10/M11/M12 static + runtime |
| 3. Feed compositions into planning as policy-gated recommendations | The planner's OPTIONAL `compositionRecommendations` seam: consulted AFTER the governed selection (the WORK-014 pipeline-order protection), recorded on the durable decision as `compositionConsultation` evidence; every recommendation's tools are re-checked against the CURRENT effective policy at consultation time (`compositionAllowedByPolicy`) — a forbidden tool never becomes preferred regardless of its learning score; the planner remains the sole planning authority | Unit planner-composition (7 tests); discrimination M5/M18 static + runtime; architecture gate |
| 4. Prevent unsupported/cyclic compositions and unverifiable recommendations | `checkToolComposition` (learning domain): deterministic 3-color DFS cycle detection (A→A, A→B→A, A→B→C→A, implicit cycles), self-edges, duplicate step ids (alias shadowing), unknown tools, unresolved versions, input/output edge compatibility at the field level; structural rejections become UNSUPPORTED records (never supported ranks); unversioned/unprovenanced recommendations fail closed at BOTH the learning projection and the planning adapter | Unit composition-domain (17 tests); discrimination M6/M7/M8/M9 static + runtime; PG physical proofs |
| 5. Rollback to a prior recommendation set WITHOUT mutating historical evidence | Rollback = activating the prior set (a 'rollback' entry in the append-only activation journal); the sets are immutable by migration triggers (0010) and by the store contract (no update path); the active pointer is the LATEST journal entry (single derived pointer) | Unit advisor (rollback test: sets byte-identical); PG (byte-identical rows + UPDATE/DELETE rejected by triggers); discrimination M15 |

## Composition identity model (§7/§8/§10/§11)

- **Tool identity**: the exact `(toolId, version)` pair — never the bare name (M26). Versions are resolved from the caller-supplied neutral tool-fact catalog (the current registry view) and pinned immutably on the recommendation; a recommendation claiming a version the facts never carried is rejected by validation.
- **Task class**: the existing repository notion — the planning `TaskKind` string recorded in telemetry (`taskClass`); no second taxonomy was created.
- **Policy context (§9)**: the population's context key (taskClass + sorted capability set + strategyClass + contextStrategy) — the policy-relevant vocabulary telemetry records. Populations with different keys are NEVER silently merged (M13); each recommendation records its exact key. The CONSUMPTION side re-checks admissibility under the CURRENT effective policy (M5) — the recommendation is stale evidence; the policy is live authority.
- **Composition structure**: a linear chain DAG mined from the observed sequence order (`linearCompositionOf`), validated structurally; the model supports arbitrary DAGs (the validator is general), and this Work Order mines chains only.
- **Deterministic-first compatibility (§17)**: per-sequence deterministic-evidence counters (subgraph observations + fully-deterministic execution counts) are preserved for future deterministicization discovery (WORK-021 owns the decisions). No deterministicization is implemented here.

## Non-authority proofs (the §6 boundary: TOOL LEARNING ≠ TOOL AUTHORIZATION)

- **Learning stays an observation island** (the WORK-014 architecture gate extended): the composition tree imports NO other module — not even public barrels. Tool facts cross INTO learning as validated INPUT DATA (the neutral closed-shape catalog); nothing crosses out except the consultation signals.
- **The composition advisor's deps are EXACTLY {store, digest, generateId, now}** (the WORK-014 quartet) — pinned by the architecture test and the discrimination lib; a mutated wiring adding any authority dep is scanner-detected (M19).
- **The planner's consultation is post-selection evidence only** (the WORK-014 learning-consultation discipline): the selection is computed before any composition consultation; the durable record keeps `selectedStrategyId: selected.strategyId`; the live selection is byte-identical with and without recommendations (runtime red record R-M18); a deterministic-sufficient selection is never displaced (R-M23).
- **The policy gate is at consultation time under the CURRENT policy** (M5): `compositionAllowedByPolicy` — deniedTools/allowedTools; a GLOWING recommendation of forbidden tools never becomes the preferred candidate (runtime red record).
- **No synthesis (M24)**: no code generation, no synthesized tools, no ephemeral programs — the synthesis vocabulary scanner proves absence; every composition step references an EXISTING registered tool at a pinned version (WORK-018 owns synthesis).
- **No verification fabrication (M22)**: the recommendation records OBSERVED verification rollups only (null when no data); it holds no verification write surface; the planner consultation adds no verification authority.
- **Ratings are evidence, never authorization (M21)**: ratings are recorded through WORK-014's rating surface; a five-star population cannot flip a policy verdict (runtime red record).
- **One authority per concern (M16/M17)**: one composition advisor factory in the learning barrel; learning contains no planner vocabulary (the WORK-014 scanner passes over the extended tree); no second store for scorecards/telemetry (the composition store READS the same telemetry population).

## Rollback/concurrency/idempotency (§21/§22 — proven on real PostgreSQL)

- **Generation**: same-basis retries CONVERGE (population fingerprint + facts basis + analysis version — replay, no version churn); concurrent builds converge through UNIQUE (application, set_version) — exactly ONE durable version-2 row landed in the PG concurrency proof, both callers received a durable set.
- **Activation**: content-derived activation identity — the same logical request converges (no duplicate journal entries); concurrent activations serialize through journal order (activation_seq); the LATEST entry is the single active pointer.
- **Rollback (M15)**: activates the prior set; PG proves the historical rows byte-identical and PHYSICALLY immutable (UPDATE/DELETE rejected by the 0010 triggers on both tables).
- **Scope (M25)**: every read is application+tenant filtered (cross-scope consultation returns nothing; foreign-set activation fails closed).

## Migration discipline (the collision rule)

Live inventory inspected at authoring: `src/platform/db/migrations/` on main carries exactly `0001`–`0009` (all merged; 0009 is WORK-014's). No in-flight/unmerged Work Order claims any number (PR #26 — the only open PR at pickup — carried zero migrations; the only remote branches with migration diffs are stale already-merged branches). **WORK-017 claims 0010 — the next valid non-conflicting version** (`0010_learning_compositions.sql`): the immutable versioned recommendation sets + the append-only activation journal, with the WORK-014 physical-invariant discipline (UNIQUE arbitrations, CHECK vocabularies, immutability triggers, composite FKs to applications and cross-application activation impossible). The architecture gate pins the inventory claim (unique versions, exactly [1..10]).

## Discrimination results (the 26 mandatory mutants)

| Mutant | Proof | Where |
|---|---|---|
| M1 recommendation bypasses policy | Runtime: an inadmissible candidate NEVER qualifies for the preference; the policy gate blocks forbidden tools before preference | discrimination runtime + unit |
| M2 learning imports policy | Static: the island scanner flags the mutated import | discrimination static |
| M3 learning imports capability | Static (island scanner) | discrimination static |
| M4 learning imports budget | Static (island scanner) | discrimination static |
| M5 forbidden tool recommended as executable | Static: `policy-gate-removed` scanner; runtime: GLOWING forbidden-tool recommendation never preferred | discrimination static + runtime |
| M6 unsupported composition accepted | Runtime: structural rejection ⇒ UNSUPPORTED with rank null | discrimination runtime + unit |
| M7 cyclic composition accepted | Static: `cycle-check-removed` scanner; runtime: A→B→A rejected with `cyclic-composition` | static + runtime + unit |
| M8 unresolved tool reference accepted | Runtime: unknown tool ⇒ UNSUPPORTED `unknown-tool-reference`; validation rejects | runtime + unit |
| M9 incompatible input/output accepted | Runtime: field-level mismatch ⇒ `incompatible-input-output` | runtime + unit |
| M10 tiny sample false high confidence | Static: `floor-removed` scanner; runtime: 2 observations ⇒ INCONCLUSIVE + material uncertainty + preference floor blocks | static + runtime + unit |
| M11 missing provenance accepted | Static: `provenance-removed` scanner; runtime: empty evidenceRefs/sourceExecutionIds throw | static + runtime |
| M12 missing evaluation window accepted | Static: `window-removed` scanner; runtime: empty window throws | static + runtime |
| M13 incompatible populations merged | Runtime: two contexts ⇒ two segregated records, never merged | runtime + unit |
| M14 historical scorecard mutated | Runtime: scorecard digest byte-identical before/after composition operations (in-memory + PG) | runtime + PG |
| M15 rollback mutates history | Static: `history-mutation-surface` scanner; runtime + PG: sets byte-identical after rollback; triggers reject UPDATE/DELETE | static + runtime + PG |
| M16 second recommendation authority | Runtime: exactly one advisor factory in the barrel | runtime |
| M17 second planner authority | The WORK-014 planner-vocabulary scanner passes over the extended tree (learning speaks no planner vocabulary) | static |
| M18 recommendation changes routing | Static: `selection-reference-mutated` + `consultation-before-selection` scanners; runtime: selection identical with/without recommendations | static + runtime + unit |
| M19 recommendation executes tools | Static: `dispatch-vocabulary` + `authority-deps` scanners (advisor deps exactly the quartet) | static |
| M20 provider types leak | Static: provider-identifier scan over the composition trees (the WORK-014 scanner) | static |
| M21 rating becomes authorization | Runtime: five-star ratings cannot flip the policy gate | runtime |
| M22 verification fabricated from score | Runtime: no verification data ⇒ verificationPassRate null (honest), no write surface | runtime |
| M23 deterministic replaced by AI | Runtime: deterministic-sufficient selection never displaced by glowing recommendations | runtime + unit |
| M24 synthesized tool appears | Static: `synthesis-vocabulary` scanner | static + architecture |
| M25 tenant scope dropped | Runtime: cross-tenant consultation empty; foreign activation fails closed | runtime + unit + PG |
| M26 wrong tool version accepted | Runtime: empty/mismatched versions rejected by validation AND the structural check | runtime + unit |

## Verification (branch state finalized by this evidence commit)

Environment: Bun 1.3.14, real PostgreSQL at `127.0.0.1:55432` (`ZECK_PG_TEST_URL`), the shipped migration set 0001–0010 applied per suite on disposable databases.

| Command | Result |
|---|---|
| `bun install --frozen-lockfile` | clean (no new dependency — WORK-017 adds NONE) |
| `bun run typecheck` | 0 errors |
| `bun run lint` | 0 errors, 0 warnings (572 files) |
| `python3 scripts/governance-check.py` | exit 0 — `Governance OK: 31 Work Orders, 94 requirements, frontier=['WORK-023', 'WORK-031']` (WORK-017 the sole in-flight item; the frontier repair restored the checker invariant — main at pickup was red, see above) |
| `bun run test:unit` | 939/939 (75 files; incl. 62 WORK-017 tests: composition-domain 17, composition-analysis 11, composition-advisor 10, composition-consultation 17, planner-composition 7) |
| `bun run test:architecture` | 469/469 (45 files; incl. composition-boundary 10 gates + the 34-mutant discrimination suite) |
| `bun run test:integration` | 7 passed + 39 PG-gated skips |
| `ZECK_PG_TEST_URL=… bun run test:pg` (real PostgreSQL) | 267/267 (39 files; incl. the 7 WORK-017 composition PG tests over migrations 0001–0010) |
| `ZECK_PG_TEST_URL=… bun run test` (FULL suite, twice consecutively at the implementation head `aba0bca`) | **1683/1683 (161 files) in EVERY run, zero failing tests, zero unhandled errors, both exit 0**. Main at pickup was 1570/1570 with 1 failing architecture test (the governance negative control — the pre-existing defect); this branch's delta is +113 tests / +8 files (exactly WORK-017's tests) and restores the failing negative control to green. The documented `57P01` teardown transient (the WORK-010/013/014/015/016 intermittent) fired in 1 of the 3 local PG-only runs — all tests passing each time |

## Checkpoint evidence

Recorded in `spec/development-state/checkpoint-state.json` under `WORK-017` (all five required contracts, verdict `passed`, evidence pointers):

- `IMPLEMENTATION-COMPLETENESS` — this file + the unit/PG suites for both surfaces.
- `IDENTITY-IDEMPOTENCY` — set version arbitration, same-basis replay convergence, activation identity convergence (unit + PG + discrimination).
- `CONCURRENCY-CRASH-SAFETY` — the PG concurrent-generation convergence proof; concurrent activation serialization through journal order; all durable writes append-only and trigger-guarded.
- `SELF-HOSTING-BOUNDARY` — the architecture gates (advisor deps, no history-mutation surface, consultation placement, adapter validation, migration inventory claim, provider neutrality) + the 26-mutant discrimination suite.
- `LEARNING-NONAUTHORITY` — the island scan over the extended learning tree, the advisor deps quartet, the M5/M18/M19/M21/M22/M23 runtime red records.

## Limitations

- **No production trigger for generation/activation is wired**: the composition advisor is a learning-module service; the composition-root wiring that schedules generation and activation (an operator surface or an API route) is future experience-layer work (the WORK-015 API surface pattern would carry it). Tests prove the capability over the real stores.
- **Tool facts are caller-supplied**: the neutral catalog is the validated INPUT (the observation-island discipline — learning imports nothing). A composition-root adapter deriving facts from the tools module's public registry is future wiring (disclosed; the domain accepts exactly the tools module's field vocabulary).
- **Policy context is the recorded vocabulary, not a policy-set identity**: telemetry does not carry policySetId (a WORK-014 design fact). The recommendation's context key records the policy-relevant vocabulary that IS observed (capability set + strategy class + task class), and the planner re-gates under the CURRENT policy at consultation time (the M5 boundary — the live authority). Recording policy-set identity on telemetry would be a WORK-014-contract change (a future amendment decision).
- **Only linear-chain compositions are mined**: the structural validator is general (arbitrary DAGs), but mining extracts observed sequences (chains). DAG mining (branching compositions) is future learning-surface work.
- **The version-resolution strategy pins the newest catalog version per toolId**: telemetry records tool ids without versions (a WORK-014 shape); the recommendation pins the catalog's current version and records it immutably (M26-visible). Version-aware telemetry would extend the observation shape (a future amendment).
- **CI runs no real-PG suites** (the standing WORK-002 flag); the PG proofs are local-verified against real PostgreSQL and recorded above.
- **User ratings are not yet a generation input** (§19 allows including them as evidence): this Work Order mines telemetry only; ratings remain immutable WORK-014 evidence and the M21 red record proves they grant no authority. Including ratings as weighted evidence is future learning-surface work.

## PR binding

BOUND — see the PR body of this branch's pull request for the exact final head, the complete-gate re-execution at that head, and the CI run identity (the two-phase SHA binding convention: the implementation gate is recorded above at `aba0bca`; the evidence head's gate is re-executed after this commit lands and recorded in the PR body before push).
