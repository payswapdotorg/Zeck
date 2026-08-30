# WORK-008 Evidence — Context compiler and artifact lineage

Work Order: `spec/work-orders/WORK-008.md`
Assurance: `HIGH_ASSURANCE` · Architecture: `v1.0` (frozen)
Branch: `work/WORK-008-context-lineage` · Base: `8245191224de62f3f5a7a363761b45ae8c615e27`
Implementation revision (this file binds): `c78e1e73fe0eec9e13f55ab635f9697534c65c24`

> **Main-defect repair disclosure (handled FIRST, own commit)**: main at
> `8245191` carried a governance-state defect introduced by finalization
> commit `51214c7` — `spec/development-state/checkpoint-state.json` was
> INVALID JSON (the condensed rewrite dropped one closing brace on every
> entry line, leaving 6 objects unclosed), so
> `python3 scripts/governance-check.py` FAILED on main (recorded output:
> `invalid JSON in spec/development-state/checkpoint-state.json: Expecting
> ',' delimiter: line 14 column 1 (char 9097)`, exit 1; CI runs 33308710704
> and 33308715423 failed on main). The byte-exact repair (valid JSON; diff
> vs the last-good base = exactly the architect's 7 intended WORK-006
> content deltas: mergedAs records, accepted statuses, new note) was
> pre-staged in this clone and committed FIRST as its own commit
> `ad47444771fd82e56b87caf91978810585281693`
> (`WORK-008: repair pre-existing main defect — restore checkpoint-state.json
> syntax (preserving architect intent; disclosed)`), following the
> WORK-002-round precedent. `governance-check.py` and every other
> governance file are untouched. The identical repair is pre-staged on the
> parallel WORK-007 branch, so the two branches carry identical bytes for
> this file (trivial union-merge).
>
> **Parallel wave**: WORK-008 ran in parallel with Implementer A's WORK-007
> (policies/executions/shared surfaces — disjoint from context/artifacts).
> The only shared files are the three development-state JSONs: this branch
> moves ONLY WORK-008 (pending→in-flight; frontier eligible keeps
> `WORK-007`, inFlight gains `WORK-008` — union-merge by the architect,
> disclosed in the PR body).

## Requirement mapping

| Requirement | Acceptance criterion | Implementation | Proof |
|---|---|---|---|
| CTX-001 (criterion 1) | Retrieval, relevance filtering, deduplication, compression and structural compilation as EXPLICIT stages | `src/modules/context/domain/stages/` — five distinct typed units: `retrieval.ts` (`applyRetrievalStage`: tenant assert + deterministic order), `relevance.ts` (`applyRelevanceStage`: pure integer term-overlap scoring, threshold exclusion, deterministic ranking), `deduplication.ts` (`applyDeduplicationStage`: exact-content collapse onto the highest-ranked survivor, collapse recorded), `compression.ts` (`applyCompressionStage`: deterministic per-item + total char budgets, ASCII truncation marker, tail-first drops, source refs never compressed away), `structure.ts` (`applyStructureStage`: ordered task/sources sections, every item referenced); orchestrated by `application/context-compiler.ts` in the frozen order retrieval→relevance→dedup→compression→structure | `tests/unit/context/stages.test.ts` (14 tests: each stage's intended behavior + negative case), `tests/unit/context/context-compiler.test.ts` (stage statistics asserted per stage) |
| CTX-001 (criterion 5) + CTX-002 | Identical inputs + compiler version → REPRODUCIBLE byte-identical lineage manifest (digest-stable) | Determinism discipline: `artifacts/domain/canonical.ts` (`canonicalJson`: recursively sorted keys, closed JSON universe, integers-only — floats/non-finite/unsafe REJECTED, no timestamps/random ids in manifest content), `COMPILER_VERSION` is digest-covered content (`domain/manifest.ts`), request digest over the canonical request subset; artifact digest = sha256 over the canonical `{kind, payload}` bytes — server-derived, never caller-supplied | `tests/unit/context/reproducibility.test.ts` (same store converge; fresh in-memory stores; fresh filesystem stores over same/different dirs; key-order-shuffled requests; version change → digest change; input change → digest change), `tests/discrimination/context-reproducibility.discrimination.test.ts` P1–P4 |
| CTX-002 (criterion 2) | Immutable artifacts with content digest, source references and parent/child lineage | `artifacts/domain/artifact.ts` (digest = identity, 64-hex; `ArtifactRecord` carries canonicalContent + normalized sourceRefs + sorted parent digests), `ports/artifact-store.ts` (mutation surface = `put` ONLY; `STORE_HAS_NO_MUTATION_METHODS` compile-time assertion), `application/artifact-service.ts` (put-if-absent, parent validation, tenant-scoped reads, `describeLineage` parent/child), adapters: in-memory + filesystem content-addressed (exclusive-create `wx`, digest-named `<tenant>/<shard>/<digest>.json`) | `tests/unit/artifacts/artifact-service.test.ts` (digest identity incl. exact sha256 expectation; second put converges no-op; NO mutation API — runtime reflection over store/service method surface; lineage parent/child both directions), `tests/unit/artifacts/filesystem-store.test.ts` (digest-named files, tmp-only), `tests/architecture/artifact-store-surface.test.ts` (static: zero unlink/rm/rmdir/truncate/appendFile/copyFile/rename sites; the only writeFile flag is `wx`; runtime surface exactly put/get/list/ownerOf) |
| Criterion 3 (EXECUTION-PROVENANCE-compatible) | Bind compiled context to the execution and plan revision that consumed it | `context/domain/manifest.ts` — every `CompiledContextManifest` records `consumption: {executionId, applicationId, planRevision? {planId, revision}}`; `ExecutionId` is derived BY REFERENCE from the executions public type (`ExecutionRecord["id"]`, type-only import — zero executions edits); the binding is digest-covered content and persists in the stored artifact | `tests/unit/context/context-compiler.test.ts` ("execution + plan revision binding recorded AND survives persistence": stored canonicalContent parsed back, consumption equal; input-change tests prove the binding participates in identity) |
| Criterion 4 (THE named discrimination boundary) | Prevent cross-tenant source retrieval AND artifact adoption | Retrieval: `applyRetrievalStage` asserts every candidate's tenant; compiler throws canonical `TENANT_SCOPE_VIOLATION` before any write. Adoption: `artifact-service.putArtifact` validates every parent against the CALLER's namespace — foreign-owned digest → `TENANT_SCOPE_VIOLATION` (via the content-free `ownerOf` probe), dangling → `POLICY_DENIED`; `getArtifact` on a foreign digest → `TENANT_SCOPE_VIOLATION` (loud, never ambiguous miss). Store namespaces by `(tenantId, digest)` so identical content in two tenants stays isolated | GREEN: unit suites (zero-writes asserted via record counts). MUTATION RED RECORDS: `tests/discrimination/context-tenant-retrieval.discrimination.test.ts` T3 (tenant assertion removed → foreign content compiled + persisted — violation observed) and `tests/discrimination/artifacts-tenant-adoption.discrimination.test.ts` A3 (ownership probe removed → the same adoption attempt succeeds — violation observed) |
| Criterion 5 (reproducibility across stores) | Proven across repeated compilations AND across fresh store instances | See CTX-001/002 row: same-store convergence, fresh in-memory instances, fresh filesystem instances (same dir → converged; different dirs → same digest), and the canonical-serialization mutation record (insertion-order `JSON.stringify` mutant → digest instability on logically-identical manifests — detected) | `tests/unit/context/reproducibility.test.ts` (6), `tests/discrimination/context-reproducibility.discrimination.test.ts` (P2 RED RECORD, P3 discriminator proof) |

## Implementation

Surfaces (declared): `src/modules/context/` (domain: sources, the five stage units, the digest-stable manifest; ports: tenant-scoped `ContextRetrievalPort`; application: the deterministic compiler + policy; adapters: in-memory retrieval corpus; public barrel), `src/modules/artifacts/` (domain: content-addressed artifact model, canonical JSON, lineage assembly; ports: `ArtifactStore` (put-if-absent only) + `DigestPort`; application: the write-discipline service; adapters: node digest, in-memory store, filesystem content-addressed store; public barrel).

Surfaces (directly required, disclosed): `tests/**` (10 new suites: 6 unit, 1 architecture gate, 3 discrimination), `spec/development-state/*.json` (the worker-protocol in-flight transition in the implementation commit + the WORK-008 checkpoint outcomes with this evidence commit, preserving the main-defect repair). NO migration; `src/platform/db/migrations/` untouched (explicitly out of surface this round). `package.json`/`bun.lock` untouched — runtime dependencies remain `[]`; no new packages. Cross-module imports: `context → artifacts/public` (the substrate) and `context → executions/public` (TYPE-ONLY, by reference) — both through public barrels, architecture-rule compliant.

Key mechanics:
- **Digest = identity, server-derived**: the artifact digest is computed by the service over the canonical serialization of `{kind, payload}` — callers never supply a digest; content equality is namespace-equality (`(tenantId, digest)` keys the store; two tenants compiling identical content each own an isolated record with the SAME digest — content addressing is tenant-independent, ownership is not).
- **Immutability by construction, four layers**: (1) the port surface has no update/delete method (compile-time `STORE_HAS_NO_MUTATION_METHODS` stops compiling if one is added); (2) the in-memory adapter is a Map keyed put-if-absent; (3) the filesystem adapter writes ONLY exclusive creates (`flag: "wx"` — EEXIST converges to the existing bytes, never rewrites); (4) a static architecture gate rejects any unlink/rm/rmdir/truncate/appendFile/copyFile/rename site and any non-`wx` write flag anywhere under `src/modules/artifacts/`. The lineage graph is a DAG by construction (a child's digest covers its sorted parent digests — a cycle requires a SHA-256 collision).
- **Authority check order** (all before any write): request validation → parent-ref tenant resolution → retrieval tenant assert. Every rejection leaves zero records (asserted by record counts).

## Design decisions (architect-review pointers)

1. **No-migration durability (WORK-005 precedent, architect-accepted class)**: CTX-001/002 introduce no durable AUTHORITY state that requires PostgreSQL this round — the compiled-context substrate is content-addressed, so its durable identity is the digest itself, not a relational row identity. Durability without schema changes is delivered by the `ArtifactStore` PORT with (a) an in-memory adapter (default/tests) and (b) a filesystem content-addressed adapter (digest-named files, append-only discipline at the adapter level, durable across process restarts — proven by tests) under `artifacts/adapters/`. The SQL store port seam (`ArtifactStore` over `DatabasePort`) remains for a later Work Order that needs queryable tenant artifact indexes; adding a migration now would create an authority surface no requirement drives (and migrations are excluded from this round's surfaces).
2. **Canonical JSON as the determinism core**: sorted keys at every depth, arrays order-preserving, closed JSON universe (`undefined`/functions/symbols/bigints rejected), integers-only within the safe range — floats and non-finite values are REJECTED, not rounded (determinism discipline: no floating point anywhere digest-covered). The serializer is pure domain code; hashing flows through the `DigestPort` (node:crypto confined to its owning adapter, statically gated).
3. **Relevance scoring is integer term-set cardinality** (case-insensitive, each task keyword counts at most once), ranked score-desc with deterministic tie order (the retrieval-stage canonical order). This keeps CTX-001's "relevance filtering" fully deterministic and testable; richer ranking (embeddings, learned weights) is a future planning/learning concern behind the same stage signature.
4. **Compression is budgeted truncation + ranked tail-dropping, and NEVER touches provenance**: per-item char budget with an ASCII `...` marker; total budget drops lowest-ranked items tail-first (recorded in stage statistics). Source references survive compression by construction — CTX-002 provenance is not a compression target.
5. **Execution binding is by reference, digest-covered**: `ExecutionId` is `ExecutionRecord["id"]` (executions public type, type-only import); the plan-revision reference is a caller-declared `(planId, revision)` — validated shape-only (plans are WORK-009's authority; this module records WHAT consumed the context, it does not adjudicate plan legality). The binding is part of the manifest content, so it is durable, digest-covered and changes the digest when it changes (proven).
6. **Tenant namespacing of content addressing**: the store key is `(tenantId, digest)` — the honest reconciliation of "digest = identity" with tenant isolation: identity is content-global, OWNERSHIP is tenant-scoped. The `ownerOf` port answers ownership WITHOUT granting reads, enabling a typed `TENANT_SCOPE_VIOLATION` (adoption) instead of an ambiguous not-found; dangling refs (owned nowhere) are `POLICY_DENIED` — a distinct, honest failure.
7. **Discrimination hooks are injection points, not bypasses**: `ArtifactServiceDeps.serialize` (default `canonicalJson`) and `ContextCompilerDeps.compilerVersion` (default the frozen `COMPILER_VERSION`) exist so the reproducibility mutation records are honest (WORK-005 `validateFact` precedent); the production defaults are the disciplined path and the green suites pin them.
8. **Filesystem adapter scope**: digest-named files under `<rootDir>/<tenantId>/<shard>/<digest>.json`; `ownerOf` scans tenant directories (bounded by tenant count — recorded limitation); path safety by construction (tenant charset allow-list + 64-hex digest validation BEFORE path interpolation; tests use tmp directories only).

## Verification (at implementation head `c78e1e73fe0eec9e13f55ab635f9697534c65c24`)

Toolchain: Bun 1.3.14 locally (CI pins 1.3.4 — same lockfile, frozen install clean), real PostgreSQL 16.4 at `127.0.0.1:55432` (`ZECK_PG_TEST_URL`).

Baseline (at base `8245191`, after the repair commit `ad47444`): governance OK `frontier=['WORK-007','WORK-008']`, typecheck 0, lint clean (271 files), full suite **479/479 (62 files)** — matching the orchestrator-verified record.

| Command | Result |
|---|---|
| `bun install --frozen-lockfile` | clean, no changes (runtime deps `[]`; no packages added) |
| `python3 scripts/governance-check.py` | `Governance OK: 20 Work Orders, 45 requirements, frontier=['WORK-007']` (WORK-008 in-flight; WORK-007 preserved eligible for the parallel PR) |
| `bun run typecheck` | 0 errors |
| `bun run lint` | 0 errors, 0 warnings (300 files) |
| `ZECK_PG_TEST_URL=… bun run test` (full, twice consecutively) | **558/558 passed, 72 files — identical both runs, zero flakes** (run 1: 20.28s, run 2: 19.92s) |

Test census (delta vs the 479 baseline): unit 243→302 (+59: canonical 9, artifact-service 11, filesystem-store 9, stages 14, context-compiler 10, reproducibility 6), architecture 39→45 (+6: artifact-store-surface gate), discrimination 93→107 (+14: context-tenant-retrieval 5, artifacts-tenant-adoption 5, context-reproducibility 4), real-PG 98 unchanged (98/98 green — no new durable PG state exists, per design decision 1), integration (non-PG) 6 unchanged. Total 479→558.

## Checkpoint evidence (all five contracts)

- `IMPLEMENTATION-COMPLETENESS` — all 5 acceptance criteria mapped (table above) with files → tests → proof; outcomes recorded in `spec/development-state/checkpoint-state.json` (verdicts pending architect review).
- `IDENTITY-IDEMPOTENCY` — digest = server-derived identity; same canonical content → same digest, put-if-absent converges (stored→converged, exactly one record — proven including ×8 concurrent identical puts); logically-identical-but-differently-ordered requests converge to the SAME digest (canonicalization); compiler version is digest-covered so identity changes only through declared versioned change. Evidence: `tests/unit/artifacts/artifact-service.test.ts`, `tests/unit/context/reproducibility.test.ts`, `tests/discrimination/context-reproducibility.discrimination.test.ts`.
- `CONCURRENCY-CRASH-SAFETY` — concurrent identical compilations/puts converge to one durable record (×8 proven; the in-memory Map transition is atomic within the JS turn; the filesystem adapter's `wx` exclusive create is OS-level atomic — two racing writers produce exactly one file, the loser converges to the winner's bytes); crash-safety class = put-if-absent only: an interrupted write leaves either no file or a complete record (exclusive create never partial-overwrites); no update path exists to corrupt. Evidence: `tests/unit/artifacts/artifact-service.test.ts` (concurrent puts), `tests/unit/artifacts/filesystem-store.test.ts` (restart durability).
- `SELF-HOSTING-BOUNDARY` — frozen install clean; runtime deps `[]`; no provider SDK or rail slug (pure domain + node:crypto confined to one adapter file, statically gated); no migrations; governance checker green; canonical taxonomy only (`TENANT_SCOPE_VIOLATION`, `POLICY_DENIED`, `PROVIDER_ERROR` — `tests/unit/errors.test.ts` taxonomy sync untouched). Evidence: `tests/architecture/artifact-store-surface.test.ts`, full gate table.
- `EXECUTION-PROVENANCE` — static: the manifest type pins the consumption binding (executionId + plan revision) and every artifact carries source references + parent digests; digest-covered provenance cannot drift without identity change. Dynamic: the binding is recorded on every compile, survives persistence (stored canonical content parsed back), and participates in the digest (changing the execution/plan changes identity — proven). Evidence: `tests/unit/context/context-compiler.test.ts`, `tests/unit/context/reproducibility.test.ts`.

## Discrimination evidence (HIGH_ASSURANCE boundaries named by this Work Order)

| Boundary | Mutation proven rejected / violation observed |
|---|---|
| Cross-tenant source retrieval (criterion 4) | **T3 RED RECORD** (`context-tenant-retrieval.discrimination.test.ts`): with the retrieval-stage tenant assertion removed (accept-all mutant), the SAME scenario (own + foreign candidate) COMPILES AND PERSISTS the foreign document's content into tenant A's durable compiled context — violation observed. GREEN path (T2): the leaking adapter is rejected with canonical `TENANT_SCOPE_VIOLATION` and ZERO records; T4 proves machine-readable foreign-candidate coordinates in `details`; the "scanner honesty" test proves the real stage still discriminates. |
| Cross-tenant artifact adoption (criterion 4) | **A3 RED RECORD** (`artifacts-tenant-adoption.discrimination.test.ts`): with the ownership probe removed (a store whose `get` serves any namespace and whose `ownerOf` lies), the SAME adoption attempt SUCCEEDS — the foreign record becomes readable and a child of it persists in tenant A — violation observed. GREEN: A1 (compile-time parent adoption) and A2 (direct foreign read) both reject `TENANT_SCOPE_VIOLATION` with zero writes; A4 separates dangling refs (`POLICY_DENIED`); A5 proves the boundary is adapter-independent (filesystem). |
| Reproducible lineage manifest (criterion 5) | **P2 RED RECORD** (`context-reproducibility.discrimination.test.ts`): with canonical serialization mutated to insertion-order `JSON.stringify` (the documented discrimination hook), two LOGICALLY IDENTICAL manifests (equal canonical bytes) produce DIFFERENT digests — digest instability observed; the green P1 assertions fail under exactly this mutation. P3 isolates the discriminator (equal-value/shuffled-key inputs: JSON.stringify diverges, canonicalJson + digest converge); P4 proves compiler version is digest-covered. |
| Immutability of the substrate (criterion 2) | Static mutants gated by `tests/architecture/artifact-store-surface.test.ts`: zero delete/update/unlink/truncate sites exist to remove (the gate fails if any appears); the only permitted write flag is `wx`; the port surface is exactly put/get/list/ownerOf (compile-time + runtime reflection); filesystem second-put converges to the winner's bytes without rewriting. |

## Known limitations

1. **No durable PostgreSQL artifact index this round** (design decision 1): the filesystem adapter is durable-but-scanned (`ownerOf` is O(tenants) directory probes; `list` is O(namespace)); a SQL `ArtifactStore` adapter with migrations belongs to a future Work Order (the port is the seam).
2. **Retrieval is an in-memory corpus today**: real retrieval surfaces (vector/document stores, tenant-scoped connectors) are future Work Orders; the port contract + stage-1 re-assertion already enforce the tenant boundary for whatever adapter arrives.
3. **Relevance scoring is lexical keyword overlap** (design decision 3): deterministic and testable, not semantic; ranking intelligence is a planning/learning concern behind the same stage signature.
4. **Plan-revision references are caller-declared** `(planId, revision)` — validated for shape, not adjudicated against a plan authority (WORK-009 owns plans); the binding records WHAT consumed the context.
5. **CI has no PostgreSQL service** (carried over, governance-flagged since WORK-002): the 98 real-PG tests skip with an explicit reason in CI; local runs are the recorded proof (standing precedent). WORK-008 adds no new PG suites because it adds no new PG state (design decision 1).
6. **Parallel-wave coordination**: the three development-state JSONs union-merge with the WORK-007 PR (both branches carry the identical checkpoint-state repair — trivial union); the architect resolves the union at finalization.

## Disclosures

- **Main-defect repair FIRST** (prominent): commit `ad47444771fd82e56b87caf91978810585281693` restores `spec/development-state/checkpoint-state.json` syntax on top of broken main `8245191` (defect + failed-governance output recorded above; repair verified byte-exact against the architect's intended WORK-006 deltas; governance-check.py untouched; disclosed in the PR body).
- **No migration, no new packages**: `src/platform/db/migrations/` untouched (out of surface); runtime deps `[]`; devDependencies unchanged.
- **Development-state union-merge** with the parallel WORK-007 PR (both PR bodies disclose it; this branch moves only WORK-008's entries).
- **Executions consumed by reference only**: `src/modules/context/application/context-compiler.ts` imports `type { ExecutionRecord }` from `executions/public` to derive `ExecutionId`; no executions file is modified.
- **Discrimination hooks** (`serialize`, `compilerVersion`) are documented injection points for the mutation records (design decision 7); production defaults are the disciplined path.

## PR / merge

- PR: opened by the worker (completion report posted there); the architect is the merge authority. The worker does NOT merge/approve.
- **Two-part binding**: this evidence file binds the implementation head `c78e1e73fe0eec9e13f55ab635f9697534c65c24` (verified against `git rev-parse HEAD`, 40-hex exact, character-by-character). The final branch head (this evidence commit) cannot contain its own SHA and is bound in the PR body + completion comment, per the WORK-001→007 protocol.
- `program-state.json` becomes `complete` only at post-merge finalization with the actual PR number + merge commit.
