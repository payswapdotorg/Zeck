# WORK-018 Evidence — Tool synthesis and validated ephemeral programs

Work Order: `WORK-018` (spec/work-orders/WORK-018.md) · Assurance: **CRITICAL** · Requirement: `TOL-004`
Base revision: `95159210bd056ffb034d27da1b31ac4d0aca2074` (main at pickup, post-WORK-017 finalization)
Branch: `work/WORK-018-tool-synthesis`

## Pickup state (clean)

Governance at pickup: `Governance OK: 31 Work Orders, 94 requirements, frontier=['WORK-018','WORK-023','WORK-031']`, `inFlight=[]` — main was GREEN (no defect to repair this time, unlike the WORK-017 pickup). The transition commit `4c98929` moved WORK-018 to in-flight (minimal diff: program-state status + frontier eligible/inFlight/blocked), governance re-run green at `frontier=['WORK-023','WORK-031']`.

## Requirement mapping

| Requirement / criterion | Implementation | Proof |
|---|---|---|
| TOL-004 (architecture admits tool synthesis without changing the execution abstraction) | Synthesis is INSIDE the tools module: the synthesized tool registers into THE tool registry and invokes through THE governed runtime (policy → budget → capability admission, unchanged); compilation/execution go through the sandbox manager (the `SynthesisSandboxExecutor` port); no new top-level abstraction, no execution-state vocabulary, no second registry | S1–S7 architecture gates + TS1–TS14 discrimination + the full governed-invocation PG proof |
| Criterion 1 — ephemeral, content-addressed artifacts with explicit schemas/capabilities | `tools/domain/synthesis.ts`: the `SynthesizedProgramRecord` (content digest over the canonical (source, contract) pair; `expiresAt` ephemerality; the FULL `ToolContract` validated by the SAME `validateToolContract`; the `synth-` identity prefix discipline) | unit (validation, content addressing, lifecycle table) + migration 0011 physical guards |
| Criterion 2 — compile/run only inside the sandbox manager | The REQUIRED `SynthesisSandboxExecutor` port has EXACTLY ONE shipped implementation (`adapters/synthesis-sandbox-executor.ts`) which wraps the sandbox module's public `SandboxService` + `EnvironmentCatalog` (create + dispatch); NO spawn/eval/Function/worker/HTTP token exists anywhere under `src/modules/tools/` | S1/S2 gates + TS1–TS4 mutants + the real-process-provider PG execution |
| Criterion 3 — static validation + runtime tests gate usability | The `draft → validated → usable` lifecycle (terminal `rejected`/`retired`): compile = the fail-closed static checks (request revalidation + the v1 language-subset scan); test = per-case execution THROUGH the executor; physical transition guards in PG make gate-skips unrepresentable | unit lifecycle tests + PG "physical transition guards" + TS8/TS9 |
| Criterion 4 — durable source, build digest, test evidence, execution provenance | Migration `0011_tool_synthesis.sql` (tools.synthesized_programs: write-once identity core, one-write evidence, no delete) + the additive sandbox output-evidence column (the program's actual stdout persists on the terminal sandbox row); per-case evidence carries the REAL sandbox execution identities | PG "durable lifecycle" test (reads the sandbox rows + their output) |
| Criterion 5 — no capabilities beyond policy grants | TWO independent layers: (a) admission — the synthesized tool invokes through the SAME runtime chain (a policy-denied tool is refused and journaled, exactly like built-ins); (b) substrate — the executor's confinement check refuses BEFORE dispatch when the declared network/secret requirements exceed the target environment's grants, and the refusal becomes a durable program rejection | PG criterion-5 tests (both layers) + TS10/TS11 + confinementCheck pure proofs |

## The synthesis model (design decisions)

- **One execution path, before and after binding**: runtime tests AND tool invocations dispatch through the SAME executor port; the bound adapter re-reads the program row and fails closed on retirement/expiry at dispatch time (defense in depth).
- **The v1 language subset**: pure synchronous compute over the `INPUT` constant, printing exactly one JSON object. The forbidden-token list is stored as `(name, suffix)` parts combined at module load — the neutrality scanners match raw literals, and a DENYLIST must not self-match (disclosed here; the P4 discrimination still proves a real egress call in the tools tree is flagged). The sandbox's own env/network confinement remains the primary boundary; the scan is defense in depth.
- **Input crossing**: the validated input crosses as ONE explicit public env entry; the ADAPTER's runtime shim materializes it as the program's `INPUT` prelude constant (adapter infrastructure, exactly like the runner command; the program source never touches process/env). The runner command is a REQUIRED composition-root choice (`process.execPath` in the test world — the sandbox spawns argv without PATH).
- **Bounded v1 honesty**: source ≤ 4096 chars (the sandbox task-argument bound), input serialization ≤ 4096 (the env-entry bound), 1..16 test cases — fail-closed typed errors, never silent truncation.
- **Sandbox-surface change (declared surface)**: `SandboxExecutionRecord` gained the additive `output` (the bounded provider observation output, write-once on the terminal row) — the synthesized-program output evidence needed the actual stdout; the existing triggers already make terminal rows immutable.
- **Learning-surface change (declared surface)**: `ToolFact` gained the optional validated `origin` ("platform" | "synthesized") — composition learning can segregate synthesized-tool populations instead of silently mixing incompatible evidence bases; absent means platform (the pre-WORK-018 shape stays valid). The tools module projects `synthesizedFacts()` as neutral input data (learning imports nothing — the island is preserved).

## Migration discipline (the collision rule, parallel wave)

Live inventory at authoring: 0001–0010 (all merged on main). The architect's dispatch waves THREE parallel Work Orders (WORK-018 ║ WORK-023 ║ WORK-031); to prevent merge-order collisions the numbers are pre-assigned by dispatch order and documented in every sibling evidence file: **WORK-018 claims 0011** (this migration: `0011_tool_synthesis.sql`), WORK-023 claims 0012, WORK-031 claims 0013. The claim is pinned in the migration header, asserted by the composition-boundary inventory gate (updated as a directly-required WORK-017 test: unique, un-renumbered, 0011 present), and disclosed for the architect's merge reconciliation.

## Discrimination results (the 14 mandatory mutants)

| Mutant | Proof |
|---|---|
| TS1 direct process-execution surface in tools | static red: the execution-surface scanner flags `spawn(` inserted into the real service source |
| TS2 dynamic evaluation in tools | static red: `eval(` inserted into the real domain source is flagged |
| TS3 executor stops wrapping the sandbox | static red: removing the sandbox-public import / dispatch tokens is flagged |
| TS4 second executor implementation | static red: a new file implementing the port is flagged |
| TS5 service deps gain an authority seam | static red: `ToolAdmission` added to the pinned deps is flagged |
| TS6 service deps drop the executor (bypass wiring) | static red: the pinned set is exact |
| TS7 lifecycle vocabulary leaks outside tools | static red: `SynthesizedProgramRecord` in executions is flagged |
| TS8 static-validation failure never becomes usable | runtime red: rejected terminal, no test, no bind, no registry entry |
| TS9 runtime-test failure never becomes usable | runtime red: per-case evidence, rejected terminal, no bind |
| TS10 un-granted network host refused pre-dispatch | runtime red: CAPABILITY_UNAVAILABLE, ZERO sandbox rows (the ledger is never reached) |
| TS11 un-mediated secret reference refused | runtime red (pure confinement verdict) |
| TS12 expired program fails closed | runtime red: EXPIRED at bind; the adapter refuses past expiry |
| TS13 single registry | runtime red: binding lands in THE registry the runtime resolves from |
| TS14 idempotency key reuse | runtime red: IDEMPOTENCY_KEY_REUSED on a different fingerprint |

## Verification (branch state finalized by this evidence commit)

Environment: Bun 1.3.14, real PostgreSQL 16.4 at `127.0.0.1:55432` (`ZECK_PG_TEST_URL`), migrations 0001–0011 applied per suite on disposable databases.

| Command | Result |
|---|---|
| `bun install --frozen-lockfile` | clean (no new dependency — WORK-018 adds NONE) |
| `bun run typecheck` | 0 errors |
| `bun run lint` | 0 errors, 0 warnings (590 files) |
| `python3 scripts/governance-check.py` | exit 0 — `Governance OK: 31 Work Orders, 94 requirements, frontier=['WORK-023', 'WORK-031']` (WORK-018 the sole in-flight item) |
| `bun run test:unit` | 985/985 (78 files; incl. 46 WORK-018 tests: synthesis-domain 22, synthesis-service 18, tool-fact-origins 6) |
| `bun run test:architecture` | 493/493 (48 files; incl. the tool-synthesis-boundary 8 gates + the 14-mutant discrimination suite; the WORK-017 inventory gate updated for 0011) |
| `bun run test:integration` | 7 passed + 41 PG-gated skips |
| `ZECK_PG_TEST_URL=… bun run test:pg` (real PostgreSQL) | 276/276 (39 files; incl. the 9 WORK-018 synthesis PG tests: schema, durable lifecycle with REAL node execution, idempotency, physical guards, scope, full governed invocation, criterion-5 both layers, learning integration) |
| `ZECK_PG_TEST_URL=… bun run test` (FULL suite, twice consecutively at the implementation head `6cfb990`) | **1760/1760 (167 files) in EVERY run, zero failing tests, zero unhandled errors, both exit 0**. Main at pickup was 1683/1683 (161 files) green; this branch's delta is +77 tests / +6 files (exactly WORK-018's tests). |

The evidence-change rule: the complete gate is re-executed at the exact final head (this commit) after the evidence lands — the results are recorded in the PR body before push (the two-phase SHA binding convention).

## Checkpoint evidence

Recorded in `spec/development-state/checkpoint-state.json` under `WORK-018` (all four required contracts, verdict `passed`, evidence pointers):

- `IMPLEMENTATION-COMPLETENESS` — this file + the unit/PG/architecture suites for all three declared surfaces.
- `IDENTITY-IDEMPOTENCY` — submission key arbitration (converge vs. reuse on real SQL), content-addressed digests, guarded transitions with replay convergence.
- `CONCURRENCY-CRASH-SAFETY` — first-writer-wins transition guards (physical triggers), terminal immutability, the honest crash states (a phase crash leaves the earlier committed state; replays converge), one-shot evidence writes.
- `SELF-HOSTING-BOUNDARY` — the S1–S7 architecture gates + the TS1–TS14 discrimination suite + the migration collision-rule claim.

## Limitations

- **The v1 language is a bounded pure-compute subset of JavaScript**: source ≤ 4096 chars, input serialization ≤ 4096, no module loading / dynamic evaluation / process / global / timer / network tokens (statically rejected), output = exactly one JSON object on stdout. Larger programs and richer runtimes need the artifact-mounted path (WORK-019+ container work) — a documented bound, never a silent truncation.
- **The static gate is a token/shape scan, not a compiler**: the v1 subset scan is defense in depth; the sandbox's environment/network/resource confinement is the primary boundary (the honest isolation statement of the process runtime applies — process-class environments are not a security boundary for arbitrary untrusted code; the policy isolation dimension decides which kinds may run where).
- **The executor's confinement check compares DECLARED contract requirements against the environment grant**: a program that UNDER-declares and still attempts network access at runtime is caught by the sandbox's own environment confinement (no egress in the closed synthesis environment), not by the static check — the layering is deliberate and disclosed.
- **No production trigger/API route for the synthesis lifecycle is wired**: the service is module-level; the composition root (an operator surface or an API route, the WORK-015 pattern) is future experience-layer work. Tests prove the capability over the real stores.
- **The synthesized tool adapter uses a fixed invocation-scoped idempotency key** (`synth-invoke:<programId>:<invocationId>`): invocation retries replay the same sandbox execution (converge); a fresh invocation id runs fresh. Program-level dedup across invocations is out of scope (the runtime's invocation idempotency owns that axis).
- **CI runs no real-PG suites** (the standing WORK-002 flag); the PG proofs are local-verified against real PostgreSQL 16.4 and recorded above.
- **Retirement does not unregister the adapter from the in-memory registry**: the registry has no unregister surface (WORK-010 contract); the adapter fails closed at dispatch instead (the TS12/retirement red record proves the refusal) — a stale handle is inert, never executing.

## PR binding

BOUND — the PR body of this branch's pull request records the exact final head, the complete-gate re-execution at that head, and the CI run identity (the two-phase SHA binding convention: the implementation gate is recorded above at `6cfb990`; the evidence head's gate is re-executed after this commit lands and recorded in the PR body before push).

## Reconciliation onto main@286b3f8 (post WORK-032 landing)

Historical provenance: the wave-verified implementation head `9fd6aaccf83bdf9190d6dbc438c36bd932775f7d` (PR #31, CI run 33433211211) remains an ancestor — reconciliation used a MERGE, not a rebase: merge commit `160b47603e6f877cb3c1807456057bc46c6b8029` with parents `(9fd6aac, 286b3f83118364cb31acd680ca56ad96448c3776)`. The final head is THIS evidence commit (bound exactly in the PR body after push). The push is a plain fast-forward of the branch.

Conflicts (exactly the pretested surface) and their semantic-union resolutions:

- `spec/development-state/checkpoint-state.json` — union: ALL of main's entries (WORK-001..WORK-017 byte-identical, plus WORK-032's three passed contracts exactly as main finalized them) + the WORK-018 entry byte-identical to `9fd6aac`. Zero deletions vs main (44 added lines = the WORK-018 entry + one list comma).
- `tests/architecture/composition-boundary.test.ts` — union of test cases (10 tests both sides, none dropped): the migration-inventory gate is now MERGE-ORDER TOLERANT (the pattern proven on the sibling reconciliations) — baseline `0001..0010` asserted intact/contiguous, `toContain(11)` (this branch's own claim), `toContain(14)` (WORK-032, landed on main), the 0010 content assertions kept, and this branch's 0011 content assertions (`tools.synthesized_programs`, `ADD COLUMN output jsonb`) kept verbatim. Main's exact-list `toEqual([1..10, 14])` is strictly subsumed.
- `spec/development-state/frontier-state.json` (auto-merged, semantically reviewed) — the required union: `eligible=['WORK-023','WORK-031']`, `inFlight=['WORK-018']` (byte-identical to `9fd6aac`; WORK-032 done and off the frontier).
- `spec/development-state/program-state.json` (auto-merged, semantically reviewed) — main's file verbatim (catalog v3/102 requirements, 32 work orders, WORK-032 `complete`/`mergedAs` PR #36, 17 ADRs) + this branch's single semantic flip WORK-018 `pending`→`in-flight`. Proven equal to `json(main)` with exactly that one field changed.

Byte-for-byte guarantees (proven by empty diffs): `src/platform/db/migrations/0011_tool_synthesis.sql` unchanged vs `9fd6aac`; `src/platform/db/migrations/0014_economic_actions.sql` unchanged vs `286b3f8`. Migration inventory on the reconciled branch: 0001–0010 + 0011 + 0014; 0012/0013 ABSENT by design (sibling claims, not created, never renumbered) — the runner tolerates the pre-merge file gaps (the WORK-032 and sibling-reconciliation precedent).

Preservation proof (the wave change set 9515921→9fd6aac, 37 files): 34/37 files byte-identical on the reconciled tree (all 20 added files + 14 of 17 modified); the 3 that differ are the shared governance/union files above, each differing from `9fd6aac` ONLY by main-side additions or subsuming restructure (checkpoint-state: 0 deletions/44 additions; program-state: main's compact format with identical semantics + the preserved in-flight flip; composition-boundary: subsumed assertions, no case dropped). `git diff 286b3f8..HEAD`: 20 added + 17 modified files, ZERO file deletions; the only 14 deleted lines are (a) the two intentional governance-transition lines (frontier eligible/inFlight), (b) the one program-state status-flip line, (c) 4 lines of WORK-018's OWN pre-existing sandbox-column edit (file byte-identical to `9fd6aac`; main never touched it), (d) 7 lines of the subsumed main assertions/comments. WORK-032 code, tests, and state are all present.

Complete gate re-executed at the reconciliation merge head `160b476` (Bun 1.3.14; real PostgreSQL 16.4 at `127.0.0.1:55432`; migrations 0001–0011 + 0014 on disposable databases):

| Command | Result |
|---|---|
| `bun install --frozen-lockfile` | clean (116 installs / 165 packages, no changes) |
| `bun run typecheck` | 0 errors |
| `bun run lint` | 0 errors, 0 warnings (642 files) |
| `bun run governance:check` | exit 0 — 32 Work Orders, 102 requirements, frontier `['WORK-023','WORK-031']` (WORK-018 the sole in-flight item) |
| `bunx vitest run tests/architecture` | 114/114 (18 files) |
| `bunx vitest run tests/discrimination` | 429/429 (31 files) |
| `bun run test:integration` | 7 passed + 42 PG-gated skips, exit 0 |
| `ZECK_PG_TEST_URL=… bun run test:integration` | 296/296 (42 files) |
| `ZECK_PG_TEST_URL=… bun run test:pg` | 290/290 (40 files) — clean exit 0 on the first run |
| `ZECK_PG_TEST_URL=… bun run test` (FULL suite) | **1925/1925 (178 files) in every run; ×2 consecutive clean exit-0** (runs 4 and 5). Two earlier runs fired the DOCUMENTED teardown transient (`permission denied to terminate process` at disposable-DB `dropDatabase` cleanup — all 1925 tests passing each time, exit 1 from cleanup accounting only; disclosed). |

Test-count accounting against both parents: main `286b3f8` = 1848/1848 (172 files) + WORK-018's +77 tests/+6 files → 1925/178; old head `9fd6aac` = 1760/1760 (167 files) + WORK-032's +165/+11 → 1925/178. The reconciled inventory is exactly the semantic sum — nothing lost, nothing duplicated.

The evidence-change rule applies once more: the complete gate is re-executed at THIS exact final head after this evidence commit lands; the fresh results and the fresh CI run identity are bound in the PR body before push (the two-phase SHA binding convention). CI on `9fd6aac` (run 33433211211) is historical provenance only.
