# WORK-031 Evidence — Computational substrate federation and workload classes

Work Order: `WORK-031` (spec/work-orders/WORK-031.md) · Assurance: **HIGH_ASSURANCE** · Requirements: `CSX-001`, `CSX-002`, `CSX-003`, `CSX-004`
Base revision: `95159210bd056ffb034d27da1b31ac4d0aca2074` (main at pickup, post-WORK-017 finalization)
Branch: `work/WORK-031-substrate-federation`

## Pickup state (clean)

Governance at pickup: `Governance OK: 31 Work Orders, 94 requirements, frontier=['WORK-018','WORK-023','WORK-031'], inFlight=[]` — clean pickup. The transition commit `8f9897a` moved WORK-031 to in-flight; governance re-run green at `frontier=['WORK-018','WORK-023']` (both siblings in-flight on their own branches — the parallel wave).

## Requirement mapping

| Requirement / criterion | Implementation | Proof |
|---|---|---|
| CSX-001 — provider-neutral ComputationalSubstrate contract (capability, modality, latency, resource, isolation, side-effect metadata) | `capabilities/domain/substrate.ts`: the closed-shape `ComputationalSubstrateInput/Record` — frozen vocabularies (workload classes, modalities, latency, isolation ladder, side effects), explicit neutral resource profile, the execution-capability claim published through the EXISTING registry, the OPAQUE adapterRef (vendor specifics never cross) | substrate-federation unit (19) + PG schema/publication tests + F1/F2 gates |
| CSX-002 — the eight workload classes as Execution-compatible workload classes | The frozen `WORKLOAD_CLASSES` vocabulary (declared ONCE in capabilities; planning mirrors it type-only — pinned by test) + `planning/domain/workload-class.ts` (`WorkloadClassProfile`, the frozen class→requirement mapping). Nothing in the core Execution model changed: the classes ride the planning decision as additive capture | vocabulary tests + the pin test + F5 gate |
| CSX-003 — selection only after policy/capability/resource admission, deterministic-first before provider/substrate selection | The planner's step 7.7 (structurally AFTER policy inputs, capability resolution, sufficiency and the governed selection — the F3 source-order gate); the selection record carries the ORDERING EVIDENCE (three boolean captures) and the validation REJECTS pre-ordering captures; DETERMINISTIC-FIRST: a sufficient strategy records `no-substrate-required` and NEVER consults the catalog (SF9 + the PG ledger proof) | planner-substrate unit (5) + SF8/SF9 + F3/F4 gates + PG planning-evidence tests |
| CSX-004 — new substrates through replaceable adapters without duplicate authorities | `substrateCapabilityClaim` publishes through the EXISTING capability registry (the one claim authority); the substrate registry's deps are pinned {store, registry, digest, generateId, now}; the integration (`src/integrations/substrate-federation`) delegates validation/publication to the capabilities authority and holds a NEUTRAL operator adapter seam with no execution surface; no vendor SDK exists at v1 | F2/F7 gates + SF2/SF3/SF4 + the federation unit tests |
| Criterion 5 — extension seams for future substrates | The vocabulary + `custom` modality escapes, the opaque adapterRef seam, and the neutral workload-class→requirement mapping: WORK-027..030's substrates enter as claims + catalog entries without core execution changes (the architecture tests pin the unchanged module set) | F5/F6 + the integration structure |
| Criterion 6 — substrate-selection rationale + resource characteristics as execution evidence | The optional validated `substrateSelection` on the planning decision (admissible candidates WITH resource profiles, typed inadmissible reasons, the selected substrate, the rationale) rides the REAL executions ledger — proven on PostgreSQL | PG "planning evidence" tests (the decision event payload carries the selection) |

## Design decisions

- **A substrate is a capability and an execution target, not a new top-level authority (ADR-0016 invariant 2)**: the durable record (migration 0013) stores the substrate METADATA; the execution capability CLAIM publishes through the EXISTING capability registry — there is exactly one capability authority and no second catalog.
- **The planner-surface type-only discipline was preserved under pressure**: the WORK-009 planner-surface gate caught my first wiring (a VALUE import of `isWorkloadClass` from capabilities into planning domain/application) — the fix is the established mirror pattern: planning declares `WORKLOAD_CLASS_VOCABULARY` locally (type-only cross-module imports), PINNED against the capabilities authority by unit test (the same way sandbox mirrors the tools field vocabulary). The gate + the pin test keep both sides honest.
- **Deterministic-first is structural, not advisory**: the no-substrate-required short-circuit sits BEFORE the catalog consultation in the planner source (the F4 source-order gate) and the SF9 red record proves the catalog is never consulted for a sufficient strategy.
- **The selection policy is deterministic**: first admissible substrate in catalog order (documented in the rationale) — never a popularity/heuristic choice; admissibility filters: availability, workload-class support, the policy cost ceiling, the isolation floor (the policies ladder rank mirrored for the filter).
- **Claims ≠ authorization (the work order's implementation requirement)**: nothing in the substrate surface admits, budgets or dispatches; execution goes through the EXISTING paths (model routes, tools, the sandbox manager) under the EXISTING admission chains.
- **Error taxonomy**: `CAPABILITY_UNAVAILABLE` for substrate validation/resolution (the capabilities-module class), `IDEMPOTENCY_KEY_REUSED` for version conflicts, `INVALID_STATE_TRANSITION` for lifecycle guards, `NO_ELIGIBLE_ROUTE` for the planning-side selection validation (the planning-module class).

## Migration discipline (the collision rule, parallel wave)

Live inventory at authoring: 0001–0010 (merged on main); the sibling branches claim 0011 (WORK-018) and 0012 (WORK-023) — both pushed. The wave pre-assigned numbers by dispatch order: **WORK-031 claims 0013** (`0013_substrate_federation.sql`: `capabilities.substrates` — immutable metadata core, frozen lifecycle, no delete, identity UNIQUE). The claim is pinned in the migration header and asserted by the wave-tolerant inventory gate (baseline [1..10] unique/un-renumbered; wave numbers may be present or absent pre-merge; file gaps are legal — the runner applies in ascending order). The architect's merge reconciliation owns the final ordering.

## Discrimination results (the 12 mandatory mutants)

| Mutant | Proof |
|---|---|
| SF1 vendor SKU/rail leaks into the contracts | static red: an H100 line inserted into the real domain is flagged |
| SF2 substrate registry gains an authority seam | static red: `ToolAdmission` added to the pinned deps is flagged |
| SF3 registry stops publishing through the EXISTING registry | static red: the `registry.publish` call removed is flagged |
| SF4 integration creates its own registry | static red: `createCapabilityRegistry` appearing in the integration is flagged |
| SF5 execution vocabulary appears in the substrate trees | static red: `nextState` inserted is flagged |
| SF6 invalid declaration never publishes | runtime red: CAPABILITY_UNAVAILABLE fail-closed |
| SF7 different body under the same identity+version fails closed | runtime red + physical immutability on PG |
| SF8 pre-ordering selections rejected (CSX-003) | runtime red: the validation throws on the missing ordering capture |
| SF9 deterministic-first: sufficient strategy never consults the catalog | runtime red: no-substrate-required, catalogCalls === 0 |
| SF10 the selection must come from the ADMISSIBLE set | runtime red |
| SF11 retirement is terminal | runtime red + physical (PG) |
| SF12 cross-tenant lifecycle fails closed | runtime red: TENANT_SCOPE_VIOLATION |

## Verification (branch state finalized by this evidence commit)

Environment: Bun 1.3.14, real PostgreSQL 16.4 at `127.0.0.1:55432` (`ZECK_PG_TEST_URL`), migrations 0001..0010 + 0013 applied per suite on disposable databases (this branch carries only WORK-031's claim; 0011/0012 are the sibling branches' claims).

| Command | Result |
|---|---|
| `bun install --frozen-lockfile` | clean (no new dependency — WORK-031 adds NONE) |
| `bun run typecheck` | 0 errors |
| `bun run lint` | 0 errors, 0 warnings (597 files) |
| `python3 scripts/governance-check.py` | exit 0 — `Governance OK: 31 Work Orders, 94 requirements, frontier=['WORK-018', 'WORK-023']` (WORK-031 the sole in-flight item on this branch) |
| `bun run test:unit` | 964/964 (77 files; incl. 25 WORK-031 tests: substrate-federation 20 incl. the mirror pin, planner-substrate 5) |
| `bun run test:architecture` | 493/493 (48 files; incl. the 9-gate substrate-federation boundary + the 12-mutant discrimination suite + the wave-tolerant inventory gate) |
| `bun run test:integration` | 7 passed + 41 PG-gated skips |
| `ZECK_PG_TEST_URL=… bun run test:pg` (real PostgreSQL) | 275/275 (39 files; incl. the 8 WORK-031 substrate PG tests: schema/triggers, publication + claim resolution through the existing registry, physical immutability + no delete, lifecycle + listing, the substrateSelection riding the REAL executions ledger, deterministic-first on the ledger, tenant isolation) |
| `ZECK_PG_TEST_URL=… bun run test` (FULL suite) | **1738/1738 (166 files) in EVERY run, zero failing tests** — clean exit-0 runs 1, 4 and 5 (`/tmp/full-031-run1.log`, `-run4.log`, `-run5.log` — runs 4+5 CONSECUTIVE clean); runs 2+3 fired the DOCUMENTED teardown transient (the `pg_terminate_backend` permission / 57P01 class of WORK-010/013/014/015/016/017: ALL 1738 tests passing, the suite exits 1 only during disposable-database cleanup). Main at pickup was 1683/1683 (161 files) green; this branch's delta is +55 tests / +5 files (exactly WORK-031's tests) |

The evidence-change rule: the complete gate is re-executed at the exact final head (this commit) after the evidence lands — the results are recorded in the PR body before push (the two-phase SHA binding convention).

## Checkpoint evidence

Recorded in `spec/development-state/checkpoint-state.json` under `WORK-031` (the two required contracts, verdict `passed`, evidence pointers):

- `SELF-HOSTING-BOUNDARY` — the F1..F8 architecture gates + the SF1..SF12 discrimination suite + the migration collision-rule claim + the planner-surface type-only discipline (the gate caught the first wiring; the mirror + pin test restore it).
- `EXECUTION-PROVENANCE` — the substrateSelection riding the REAL executions ledger (the decision event payload carries the selection with the ordering evidence) + the PG proofs.
- `IMPLEMENTATION-COMPLETENESS` — recorded alongside (this file + the unit/PG/architecture suites for all three touched surfaces).

## Limitations

- **The substrate selection is planning EVIDENCE, not a dispatch instruction**: execution goes through the EXISTING paths (model routes, tools, the sandbox manager); wiring actual substrate dispatch for new workload classes is WORK-027..030's territory (this Work Order's boundary: the common contract, not every future substrate — the work order's forbidden list).
- **The substrate catalog adapter is capabilities-public in-memory in the PG world**: the durable SQL substrate store + the in-memory capability registry (the WORK-002/010 test pattern); a durable capability catalog store is a capabilities-module follow-up (the substrate records themselves ARE durable in SQL).
- **The isolation/cost admissibility filters mirror the policy ladder by value** (the planner-surface type-only discipline); the mirror is pinned by test, and the LIVE policy set remains the authority (the effective restriction set is read at planning time through the policy seam — unchanged).
- **Latency-class mismatch is a vocabulary reason but not yet an automatic filter** (the selection filters availability, workload class, cost ceiling and isolation floor; latency matching is recorded in the candidate metadata for downstream WORK-027..030 runtimes to enforce — disclosed).
- **No vendor operators exist at v1**: the operator adapter seam ships with an in-memory test double; real external compute systems arrive with WORK-027..030 behind the neutral seam.
- **CI runs no real-PG suites** (the standing WORK-002 flag); the PG proofs are local-verified against real PostgreSQL 16.4 and recorded above.
- **The teardown transient**: runs 2+3 of the full suite fired the documented cleanup transient (all tests passing each time); the consecutive-clean runs 4+5 are the recorded gate.

## PR binding

BOUND — the PR body of this branch's pull request records the exact final head, the complete-gate re-execution at that head, and the CI run identity (the two-phase SHA binding convention: the implementation gate is recorded above at `fd9ff20`; the evidence head's gate is re-executed after this commit lands and recorded in the PR body before push).

## Reconciliation onto main@286b3f8 (post WORK-032 landing)

WORK-032 landed on main while this branch was in flight (PR #36 merge `778c422`, finalized by PR #37 → main `286b3f83118364cb31acd680ca56ad96448c3776`), which left PR #33 mergeable=false. Per the reconciliation instruction, the branch was reconciled by a MERGE (no rebase, no force-push):

- **Historical provenance (old verified head)**: `155e1defacd48f60f9cd160ee96e416f479e8854` — the wave-verified final head (CI run 33441218477, 3/3 green; the gate numbers in the sections above are that head's record). A local-only backup branch `backup/WORK-031-wave` pins it.
- **Reconciliation merge (implementation head)**: `4e9f66decac4e65ea7cddaf2e129d22032a7bccf` — merge commit with parents (`155e1de`, `286b3f8`): the old verified head stays an ancestor, the push is a plain fast-forward.
- **Final head**: THIS evidence commit (the rebind; docs-only on top of the merge).
- **WORK-032 state preserved**: main's full change set is an ancestor; `git diff 286b3f8..HEAD` shows ZERO file deletions and zero loss of main-side content (the only line-level deletions are the conflict resolutions below, each of which keeps main's semantics — verified line-by-line).

### Conflicts resolved (semantic union)

1. `spec/development-state/checkpoint-state.json` — union of the items maps: ALL of main's entries (incl. the WORK-032 record: IDENTITY-IDEMPOTENCY / ECONOMIC-AUTHORITY-BOUNDARY / EXECUTION-PROVENANCE, all passed) AND this branch's `WORK-031` entry (SELF-HOSTING-BOUNDARY / EXECUTION-PROVENANCE / IMPLEMENTATION-COMPLETENESS) byte-identical to `155e1de`. Common entries are main's bytes.
2. `spec/development-state/program-state.json` — main's file verbatim (compact format, requirementCatalog v3/102, WORK-032 `complete` with mergedAs PR #36) + this branch's ONLY semantic delta applied: the WORK-031 line flipped `pending`→`in-flight`. WORK-031 remains the sole in-flight work order; WORK-018/WORK-023 stay pending.
3. `tests/architecture/composition-boundary.test.ts` (the migration inventory gate) — union: this branch's merge-order-tolerant assertions (1..10 unique/un-renumbered/contiguous) + main's WORK-032 claim (`0014` present — `expect(migrations).toContain(14)`) + this branch's own claim (`0013` present, and the `0013_substrate_federation.sql` content assertions unchanged). Main's exact-list assertion `toEqual([1..10, 14])` was subsumed by the tolerant union form (which holds for the reconciled inventory `[1..10, 13, 14]` and for any later sibling merge order); no test case from either side was dropped (10 tests before and after; all of main's and this branch's assertions survive as the union set).
4. `tests/architecture/integrations-boundary.test.ts` — union of the import-rule allowances and cases: main's payment-rails/economics-barrel allowance AND this branch's substrate-federation/capabilities-barrel allowance (both as scoped conjuncts of the same whitelist); main's new "the payment-rails integration exposes its public barrel and rail adapters" case kept verbatim; the authority-logic case keeps main's title (no policy/budget/verification/learning/CAPABILITY authority) with this branch's scoped capabilities exemption for `src/integrations/substrate-federation/` (payment-rails keeps main's blanket ban — it imports no capabilities); main's M1/M2/M9 title (payment-rails network-free note) kept. The file carries main's full 9-case set; this branch's 8 cases all survive in the union bodies (3 titles reworded to the union/main forms — the import-rule title, the authority-logic title, the M1/M2/M9 title; every branch condition and assertion kept, the capabilities allowance added as a second scoped conjunct).
5. `spec/development-state/frontier-state.json` (auto-merged, semantically reviewed) — the union state exactly as required: `eligible=['WORK-018','WORK-023']`, `inFlight=['WORK-031']` (WORK-032 done/absent, blocked set unchanged).

### Byte-for-byte guarantees (re-verified on the reconciled tree)

- `git diff 155e1de..HEAD -- src/platform/db/migrations/0013_substrate_federation.sql` is EMPTY (byte-identical; not renumbered; header claim unchanged).
- `git diff 286b3f8..HEAD -- src/platform/db/migrations/0014_economic_actions.sql` is EMPTY (WORK-032's migration preserved).
- Inventory on this branch: 0001–0010 + 0013 + 0014. 0011/0012 remain ABSENT by design (sibling branches not yet merged; never created here). The migration runner tolerates the gaps (the same shape WORK-032's branch ran green: 0001–0010 + 0014).

### Preservation proof (user step 1)

- WORK-031's owned change set (`git diff --name-status 9515921 155e1de`): 44 files (27 added + 17 modified).
- All 27 ADDED files (implementation, tests, migration, this evidence file) are byte-identical on the merge commit (`git diff 155e1de 4e9f66d -- <file>` empty for every one).
- Of the 17 modified files, 14 carry ZERO deletions vs `155e1de` (pure main-side additions — the WORK-032 code landed around WORK-031's edits without touching them: the sibling surfaces were disjoint). The 3 with textual deletions are exactly the conflict files above, and their deletions are format/union restructurings only: `program-state.json` (main's compact reformat — the branch's only semantic change, the in-flight flip, preserved), `composition-boundary.test.ts` (5 comment lines reworded; every assertion kept), `integrations-boundary.test.ts` (titles/comments/one import line for main's kept payment-rails case; every branch condition kept as a conjunct).
- Versus main: `git diff 286b3f8..HEAD` — no file deleted; all of WORK-032's code, tests, migration 0014, and governance records present.
- All WORK-031 tests preserved: substrate-federation unit 25, planner-substrate 5, the 9-gate architecture boundary file, the 12-mutant discrimination suite, the 8 real-PG substrate tests — all byte-identical files.

### Complete verification gate at the reconciliation merge `4e9f66d` (recorded before this evidence commit; per the evidence-change rule the full gate is RE-EXECUTED at the exact final head — this commit — and recorded in the PR body)

Environment: Bun 1.3.14, real PostgreSQL 16.4 at `127.0.0.1:55432`, migrations on the branch = 0001–0010 + 0013 + 0014.

| Command | Result |
|---|---|
| `bun install --frozen-lockfile` | clean, no changes (116 installs / 165 packages; no new dependency) |
| `bun run typecheck` | 0 errors |
| `bun run lint` | 0 errors / 0 warnings (649 files) |
| `python3 scripts/governance-check.py` | exit 0 — `Governance OK: 32 Work Orders, 102 requirements, frontier=['WORK-018', 'WORK-023']` (WORK-031 sole in-flight; WORK-032's 102-requirement catalog preserved) |
| `bunx vitest run tests/architecture` | 116/116 (18 files; incl. the 9-gate substrate-federation boundary + the union inventory gate + main's WORK-032 architecture cases) |
| `bunx vitest run tests/discrimination` | 427/427 (31 files; incl. SF1..SF12 + main's 48 economics mutants) |
| `bun run test:integration` (with `ZECK_PG_TEST_URL`) | 295/295 (42 files) |
| `ZECK_PG_TEST_URL=… bun run test:pg` (real PostgreSQL) | 289/289 (40 files; incl. the 8 WORK-031 substrate PG tests and main's 12 economics PG tests; migrations 0001–0010+0013+0014 applied per disposable DB) — runs 1–2 fired the DOCUMENTED 57P01/`pg_terminate_backend` permission teardown transient on the pre-existing `idempotency.test.ts` file (ALL 289 tests passing each time; exit 1 from cleanup only); run 3 clean exit-0 (`/tmp/rec3-pg-run3.log`) |
| `ZECK_PG_TEST_URL=… bun run test` (FULL suite) | **1903/1903 (177 files) ×2 CONSECUTIVE clean exit-0** (`/tmp/rec3-merge-full1.log`, `/tmp/rec3-merge-full2.log`, ~60s each, zero unhandled errors) |
| `bun run test:unit` (supplementary) | 1065/1065 (86 files) |

Deltas vs the two parents: main `286b3f8` was 1848/1848 (172 files) → +55 tests / +5 files (exactly WORK-031's test set); old branch head `155e1de` was 1738/1738 (166 files) → +165 tests / +11 files (exactly WORK-032's landing). No test from either side was lost.
