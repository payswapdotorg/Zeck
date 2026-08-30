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

---

# REMEDIATION ROUND — Artifact lineage identity (issue #13)

**Everything above this divider is the historical round-1 record (merged as PR #11, merge `08caf5a2860b80d89184f09fe9cad1db509ac16c`; implementation head `c78e1e73fe0eec9e13f55ab635f9697534c65c24`, final branch head `b95860e30fde20a626e205dff3021f477f5cafd0`) and is preserved unchanged.** The round-1 bindings remain the historical record.

## The finding (GitHub issue #13)

Governance finding, blocking, discovered by architect finalization review after the WORK-008 merge: artifact identity hashed only `{kind, payload}` while `parents` / `sourceRefs` stayed OUTSIDE the digest-covered identity. Because the store converges on `(tenantId, digest)` with put-if-absent as the only mutation, a second put in the same tenant with identical kind/payload but DIFFERENT lineage converged to the first stored record and SILENTLY LOST the requested lineage (both the requested parents and the requested sourceRefs). The architect's one-line correction: "Artifact identity must not allow two semantically different lineage records to converge while silently losing parents / sourceRefs." A related incoherence: `domain/lineage.ts` claimed "a child's digest covers its (sorted) parent digests, so a cycle would require a SHA-256 collision" — which was FALSE under the round-1 digest (parents were not digest-covered).

## Chosen identity model — EXPLICIT DECISION (remediation requirement 1)

**Option (a) chosen: the canonical digest-covered identity form is extended to include the NORMALIZED lineage.** The artifact digest is now `sha256Hex(canonicalJson({ kind, payload, parents, sourceRefs }))` with `parents` / `sourceRefs` in their deterministic normalized stored shape (sorted, de-duplicated — exactly what the record persists). `ArtifactRecord.canonicalContent` remains the EXACT bytes the digest covers (the field's documented meaning is preserved by extending what it serializes, not by redefining it): it is now the canonical serialization of the full identity form.

**Justification.** This is the minimal-risk correction that keeps every existing invariant intact: `digest = identity` (server-derived, caller never supplies it), immutability by construction (put-if-absent stays the ENTIRE mutation surface; the store adapters are byte-unchanged), tenant-namespaced `(tenantId, digest)` keys, cross-tenant rejection-before-write, and true idempotency (identical FULL inputs — kind+payload+parents+sourceRefs — still converge). It makes lineage loss IMPOSSIBLE BY CONSTRUCTION: two records with identical kind/payload but different lineage compute different digests and therefore can never converge. It also makes the round-1 docstring claim literally true: a child's digest now covers its sorted parent digests, so a lineage cycle requires a SHA-256 collision (the DAG-by-construction claim is now enforced by identity, not asserted by prose).

**Tradeoffs (documented honestly).**
- *Provenance becomes identity-bearing*: identical payloads with different provenance are now DISTINCT artifacts. This is exactly the semantics issue #13 requires — it is the point, not a cost — but it means content-level deduplication across provenance variants is deliberately NOT performed by this substrate (a payload stored twice with different parents is two records). Callers wanting dedup must put identical full inputs.
- *Digest values change vs the round-1 model* (the covered bytes grew). There is no persisted data to migrate: the filesystem adapter's digest-named files are content-addressed by the digest that produced them, and no production data exists yet (WORK-009/010 are still blocked behind this remediation); the no-migration decision (round-1 design decision 1, the `ArtifactStore` port as the SQL seam) is unchanged and no migration surface was touched.
- *Option (b) rejected*: a separate immutable lineage/edge object with independently addressed identity would require a new port + store methods + a second durable surface — a larger change than the defect warrants, and it would split artifact identity across two objects (weaker invariant: the record and its edge-set could disagree). Option (a) keeps ONE identity covering the WHOLE semantic record.
- *Redundancy note*: for `compiled-context` artifacts the manifest payload already carries `parents` (round-1 design), so parents now participate in the digest twice (once inside the payload, once as an identity field). This is harmless (no instability — both are deterministic) and keeps the artifact service generic (lineage is covered for ALL kinds, not just manifests whose payload happens to include it).

## Requirement → evidence map (the 5 remediation requirements of issue #13)

| # | Requirement | Evidence |
|---|---|---|
| 1 | Canonical artifact identity so lineage/provenance semantics cannot be silently lost — explicit choice + tradeoffs | Option (a) above (this section); implementation `src/modules/artifacts/application/artifact-service.ts` (`putArtifact`: normalize → serialize full identity form → digest); domain docs made coherent: `domain/artifact.ts` (identity model header, `ArtifactContent` = identity form, `ArtifactRecord.canonicalContent` doc), `domain/lineage.ts` (DAG-by-construction now enforced by identity), `context/domain/manifest.ts` (manifest = digest-covered payload; identity additionally covers normalized lineage). Pinned by `tests/unit/artifacts/lineage-identity.test.ts` ("the digest is exactly sha256 over the canonical identity form") |
| 2 | Regression test: same tenant + same kind/payload + different parents/sourceRefs must NOT silently converge while losing lineage | `tests/unit/artifacts/lineage-identity.test.ts` — 10 tests: different parents → 2 records each keeping its own parents with `describeLineage` reflecting each (both directions); different sourceRefs → 2 records each keeping its own sourceRefs; parents AND sourceRefs each independently diverge the digest; identical FULL inputs converge idempotently; normalization (order/duplicates) keeps digests stable; exact identity-form digest; concurrent divergent-lineage puts store ALL records (3-way `Promise.all`); ×8 concurrent identical full inputs converge to exactly one record; cross-tenant same-full-input → same digest, one record per namespace; adoption rejection-before-write preserved |
| 3 | Discrimination/mutation evidence with an honest RED record | `tests/discrimination/artifact-lineage-identity.discrimination.test.ts` — L1 green protection; **L2/L3 RED RECORDS**: the content-only identity mutant (lineage fields removed from the digest-covered canonical form — exactly the round-1 model, applied via the documented `serialize` discrimination hook) makes divergent-parent puts CONVERGE with the second record keeping the FIRST's parents (requested lineage silently lost) and likewise for sourceRefs; L4 mutant honesty (mutant digest ≡ sha256 over canonical `{kind, payload}` only; production digest covers the full form); L5 adapter-independence (filesystem). PLUS the commit-time honest RED: the new suites were run UNCHANGED against the pre-remediation code BEFORE the fix (below) |
| 4 | Preserve cross-tenant rejection-before-write and immutable put-if-absent | Zero store/port/adapter code changed (adapters byte-identical; `ArtifactStore` surface still put/get/list/ownerOf only; `STORE_HAS_NO_MUTATION_METHODS` untouched). Green: `tests/unit/artifacts/lineage-identity.test.ts` (adoption rejected `TENANT_SCOPE_VIOLATION`, zero writes), `tests/unit/artifacts/artifact-service.test.ts` (adoption/read/dangling rejections unchanged), `tests/discrimination/artifacts-tenant-adoption.discrimination.test.ts` A1–A5 (incl. the A3 red record), `tests/architecture/artifact-store-surface.test.ts` (zero mutation sites, `wx`-only writes, surface gate) — all green at the remediation head |
| 5 | Rebind evidence and CI to the remediation head before re-review | This addendum binds the implementation head `06372aeb97279e20c3840f7713d7467cc0d73d0e` (verified char-by-char against `git rev-parse HEAD`); the final branch head (the evidence commit) is bound in the PR body + completion comments per the two-phase protocol; CI run for the final head cited in the CI-proof comment |

## Honest RED record (tests written first, run against the defect)

The two new suites were written BEFORE the fix and run unchanged against the pre-remediation code (base `5938013`, the round-1 merged model):

- `tests/unit/artifacts/lineage-identity.test.ts`: **5 failed / 5 passed** — failing exactly as the finding describes: `same kind/payload + DIFFERENT parents` → `AssertionError: expected 'converged' to be 'stored'`; `same kind/payload + DIFFERENT sourceRefs` → `expected 'converged' to be 'stored'`; `parents AND sourceRefs each independently change identity` → identical digests (`expected 'fb7b1d98…' not to be 'fb7b1d98…'`); `digest is exactly sha256 over the canonical identity form` → `canonicalContent` lacked the lineage fields (`expected '{"kind":"task-output","parents":[…],"payload":…,"sourceRefs":[…]}' to be '{"kind":"task-output","payload":…}'`); `concurrent divergent-lineage puts` → `['stored','converged','converged']` instead of three `stored`. The 5 passing were the invariants that already held (identical-full-input convergence, normalization stability, ×8 concurrency, cross-tenant isolation, adoption rejection).
- `tests/discrimination/artifact-lineage-identity.discrimination.test.ts`: **3 failed / 2 passed** — L1/L4/L5 failed (the production service exhibited the defect: divergent parents converged; production digest equalled the content-only digest), while L2/L3 passed because the mutant is byte-identical in behavior to the defective base (violation observed).

**Restoration**: the implementation commit `06372ae` applies Option (a) (normalize lineage → serialize the full identity form → digest) and adjusts the two pre-existing assertions that encoded the old model (disclosed below); both suites then pass in full (10/10 and 5/5) and the complete regression is green (verification table).

## Verification (remediation round)

Toolchain: Bun 1.3.14 locally (CI pins 1.3.4 — same lockfile, frozen install clean); real PostgreSQL 16.4 at `127.0.0.1:55432` (`ZECK_PG_TEST_URL`).

Baseline (at base `5938013`, before any change): governance OK `frontier=[]`, typecheck 0, lint clean (314 files), full suite **623/623 (77 files)** TWICE consecutively — matching the orchestrator-verified record.

| Command | At implementation head `06372ae` (×2 consecutive full-suite runs) | At final head (evidence commit; ×2 consecutive full-suite runs) |
|---|---|---|
| `bun install --frozen-lockfile` | clean, no changes (runtime deps `[]`) | clean, no changes |
| `python3 scripts/governance-check.py` | `Governance OK: 20 Work Orders, 45 requirements, frontier=[]` | identical |
| `bun run typecheck` | 0 errors | identical |
| `bun run lint` | 0 errors, 0 warnings (316 files) | identical |
| `ZECK_PG_TEST_URL=… bun run test` | **638/638 passed, 79 files — identical both runs, zero flakes** (22.00s / 21.50s, clean post-commit worktree at the head) | **638/638 passed, 79 files — identical both runs, zero flakes** (21.77s / 22.63s; every recorded full run of this round was 20–23s, zero flakes) |

Test census (delta vs the 623 baseline): **623 → 638 (+15)** — unit 350→360 (+10: `lineage-identity.test.ts`), discrimination 117→122 (+5: `artifact-lineage-identity.discrimination.test.ts`), architecture 47 unchanged, real-PG 103 unchanged (no new durable PG state — the no-migration decision stands), integration (non-PG) 6 unchanged.

## Checkpoint evidence (remediation round, all five contracts re-recorded)

`spec/development-state/checkpoint-state.json` WORK-008 item updated to this round (asOf `2026-08-30T14:34:47Z`, branch `work/WORK-008-artifact-lineage-remediation`, baseRevision `5938013cfe90591b2fa1cd23fec4c1ebbf187dbb`; every other entry byte-exact): all five outcome evidence arrays now include the new regression suite and/or the new discrimination suite, with verdicts pending architect re-review.

## Known limitations (remediation round)

1. **Content-level dedup across provenance variants is deliberately not performed** (the explicit tradeoff of Option (a)): identical payloads with different lineage are distinct artifacts and distinct stored records.
2. **Digest values differ from the round-1 model** for the same logical inputs (the covered bytes grew by the normalized lineage). No persisted artifact data exists to reconcile (WORK-009/010 blocked behind this remediation; the filesystem store is content-addressed by construction), but any consumer that hard-coded round-1 digest VALUES would observe the change — none exists in-repo (the only two VALUE-encoding assertions are the adjusted ones disclosed below).
3. **`ownerOf` filesystem scan remains O(tenants)** (round-1 limitation 1, unchanged).
4. **CI still has no PostgreSQL service** (standing flag since WORK-002): the 103 real-PG tests skip in CI; the local runs above are the recorded proof (standing precedent).

## Disclosures (remediation round)

- **Pre-existing test adjustments (exactly two, both encoding the round-1 content-only convergence semantics — each adjusted in the implementation commit and re-pinned to the remediated model):**
  1. `tests/unit/artifacts/artifact-service.test.ts` — "digest = identity" test's exact-sha256 expectation extended from `canonicalJson({kind, payload})` to the full identity form `canonicalJson({kind, payload, parents, sourceRefs})` (the helper's full input is pinned: `parents: []`, `sourceRefs: [{kind:"request",id:"req-1",locator:"test"}]`). The test's INTENT (server-derived digest = identity over canonical bytes) is unchanged.
  2. `tests/unit/context/context-compiler.test.ts` — "artifact content is the canonical serialization…" test's `canonicalContent` expectation extended to include the normalized `parents: []` + the compiler's three-item `sourceRefs` list (the digest = `sha256Hex(canonicalContent)` half of the assertion was already model-independent and is untouched). The test's INTENT (canonicalContent is exactly the digest-covered bytes) is unchanged.
  No other pre-existing test required adjustment: all other convergence assertions in the suite consume identical FULL inputs, which converge under both models.
- **Doc-only coherence edits** in `src/modules/context/domain/manifest.ts` (header: manifest = digest-covered payload; identity additionally covers normalized lineage) — within the declared `src/modules/context/` surface; no context BEHAVIOR changed (the compiler already passed normalized parents/sourceRefs to `putArtifact`).
- **Development state**: `program-state.json` WORK-008 `blocked` → `in-flight` (branch + baseRevision added; `historicalMerge` preserved EXACTLY; `remediation` object reflects in-flight with issue 13 + reason intact); `frontier-state.json` moves WORK-008 `blocked` → `inFlight` (WORK-009/010 stay blocked, `eligible` stays `[]`; the file's no-trailing-newline shape preserved); `checkpoint-state.json` WORK-008 item rebound to this round in THIS evidence commit (established split). Governance checker green (`frontier=[]`) at every recorded point.
- **No migration, no new packages, no store/port/adapter changes**: `package.json`/`bun.lock` untouched (runtime deps `[]`); the `ArtifactStore` port, both adapters, and `STORE_HAS_NO_MUTATION_METHODS` are byte-identical to round 1 — the identity fix lives entirely in the application service's digest computation.
- **The discrimination hook** (`ArtifactServiceDeps.serialize`) semantics extended in documentation only: it serializes the FULL identity form; the round-1 P2 reproducibility mutant (insertion-order `JSON.stringify`) remains meaningful and green (verified at the remediation head).

## PR / merge (remediation round)

- PR: opened by the worker against `main`; completion reports posted on the PR and on issue #13. The architect is the merge authority; the worker does NOT merge/approve.
- **Two-part binding**: this evidence file binds the implementation head `06372aeb97279e20c3840f7713d7467cc0d73d0e` (verified against `git rev-parse HEAD`, 40-hex exact, character-by-character). The final branch head (this evidence commit) is bound in the PR body + completion comment, per the WORK-001→008 protocol.
- `program-state.json` becomes `complete` only at post-merge finalization with the actual remediation PR number + merge commit (WORK-009/010 then unblock per the dependency graph).
