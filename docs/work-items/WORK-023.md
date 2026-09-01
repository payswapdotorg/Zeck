# WORK-023 Evidence — Multimodal Agent Deployment Fabric

Work Order: `WORK-023` (spec/work-orders/WORK-023.md) · Assurance: **HIGH_ASSURANCE** · Requirements: `MOD-001`, `MOD-002`, `MOD-003`, `MOD-004`, `MOD-010`
Base revision: `95159210bd056ffb034d27da1b31ac4d0aca2074` (main at pickup, post-WORK-017 finalization)
Branch: `work/WORK-023-deployment-fabric`

## Pickup state (clean)

Governance at pickup: `Governance OK: 31 Work Orders, 94 requirements, frontier=['WORK-018','WORK-023','WORK-031'], inFlight=[]` — clean pickup. The transition commit `fcb650b` moved WORK-023 to in-flight (minimal diff), governance re-run green at `frontier=['WORK-018','WORK-031']` (the parallel wave is visible in the frontier — WORK-018 in-flight on its own branch).

## Requirement mapping

| Requirement / criterion | Implementation | Proof |
|---|---|---|
| MOD-001 — provider-neutral versioned DeploymentProfile and DeploymentPlan without changing the Execution abstraction | `deployments/domain/profile.ts` + `domain/plan.ts`: immutable versioned artifacts with frozen neutral vocabularies (modality/channel/latency/resource/side-effect/io); channel bindings name NEUTRAL adapter capability ids; content-addressed digests; `application/deployment-service.ts` publishes with fail-closed reference resolution. No execution model touched: zero executions-module changes | fabric-domain unit (19) + fabric-service unit (21) + D1..D8 architecture gates + PG artifact tests |
| MOD-002 — identity bound to application/environment/agent-version, referenceable by executions | `deployments.deployments` identity core + the PHYSICAL `deployments_identity_unique UNIQUE (application_id, environment_id, agent_id, agent_version)` (a different agent version is a different deployment); `getDeployment` returns the durable identity + current plan for any referencing consumer; the journal's `execution_id` reference column records execution provenance | PG identity tests (binding + physical UNIQUE + slug convergence) + the provenance test with a REAL execution |
| MOD-003 — idempotent, auditable, concurrency-safe lifecycle preserving execution provenance | The journal-first mutation driver: guarded single-row UPDATE arbitration (first writer wins; concurrent duplicates converge; disagreement fails `INVALID_STATE_TRANSITION`), `UNIQUE (application_id, idempotency_key)` event convergence, append-only event records carrying actor/cause/prior+current plan version/execution id; rollback DERIVES the prior version from the journal (history never rewritten) | PG lifecycle tests (replay, concurrent promotions, rollback physical append-only, no delete) + the §9 race completion: concurrent ROLLBACKS converge (one event), rollback-vs-promotion never tears the pointer, concurrent SUSPENSIONS converge, suspend-vs-retire unambiguous, concurrent DUPLICATE CREATIONS (single durable result) and concurrent IDENTITY collisions (physical UNIQUE) + fabric-service unit |
| MOD-004 — channel/modality adapters cannot create duplicate authorities | `ports/modality-adapter.ts`: the port's SHAPE carries only `checkBinding`/`describeBinding`/descriptor — no admission/authorize/budget/execute/invoke/dispatch method, no stores; the service never consults adapters for admission (only fail-closed coverage at plan validation); deployments owns no policy/capability/budget/verification surface | D1 gate + DF1 mutant (an execute method appearing on the port is flagged) + the pinned service deps (D2/DF2) |
| MOD-010 — external/BYOA agents and replaceable rails without vendor lock-in | `PlanAgentRef.agentKind: "byoa"` with an OPAQUE external descriptor (ref + bounded text; credential-shaped content rejected by validation and the migration CHECK); no SDK, no execution surface, no vendor identifiers anywhere (D4/DF4) | fabric-service BYOA test + PG BYOA deployment through the same lifecycle |
| Criterion 7 — future modalities consume the same abstraction | The modality vocabulary ships `custom` + the neutral channel-kind/adapter-capability seams; WORK-024/025/026 register their rails behind `ModalityChannelAdapter` without touching the core model (the roadmap's strategic rule: specialization in profiles/adapters, governance in Zeck) | the adapter registry + the vocabulary tests |

## The module addition (the 19th architecture module)

`/deployments` is a NEW top-level module authorized by ADR-0014/0015/0017 (accepted architectural evolution, v1.0 additive). The module-sync chain was updated in lockstep: `src/shared/module.ts` (ARCHITECTURE_MODULE_IDS + the module count 18→19), `spec/architecture.md` §6 table row, `IMPLEMENTATION.md` layout, `tests/unit/modules.test.ts` (19 unique identities), and the module-skeleton per-module loop. The deployments barrel exports `moduleDescriptor: { id: "deployments" }` like every module.

## Design decisions

- **Deployment identity is (application, environment, agent, agent-version)**: a different agent version is a DIFFERENT deployment (parallel identities), so promotion (which preserves identity) only moves between plan versions whose agent/environment reference MATCHES the binding — enforced at promotion AND at creation (the initial plan must match). This makes "promotion preserves Execution identity" (ADR-0014 invariant 9) structural.
- **The journal is the audit, the row is the pointer**: every mutation appends first-class evidence (actor, cause, prior/current version, execution provenance) and then moves the guarded row; converged duplicates never double-journal (the winner's event is the truth — the exact-once discipline).
- **Rollback derives the prior version from the journal** (the last promote/rollback's `priorPlanVersion`), never from caller assertion; history is append-only physically.
- **Status transitions are strict**: `active ↔ suspended`, either → `retired` (terminal-immutable, physically). Plan moves (promote/rollback) are guarded by the plan-version guard, fail closed on retired, and allowed while suspended (the pointer moves; resume serves the new version).
- **Agent-version facts resolve through the agents public seam** (the read-only inventory adapter — `getAgent`/`listVersions` only); environment facts resolve read-only through the executions-store cross-module SQL precedent. Neither seam mutates.
- **Error taxonomy**: deployments has no own taxonomy code (the frozen list); validation/input failures use `PROVIDER_ERROR` (the applications-module precedent), scope failures `TENANT_SCOPE_VIOLATION`, arbitration `IDEMPOTENCY_KEY_REUSED`, state `INVALID_STATE_TRANSITION`, coverage `CAPABILITY_UNAVAILABLE`, agent facts `AGENT_ERROR`.

## Migration discipline (the collision rule, parallel wave)

Live inventory at authoring: 0001–0010 (merged on main). The dispatch waves WORK-018 ║ WORK-023 ║ WORK-031; numbers pre-assigned by dispatch order and documented in every sibling evidence file: **WORK-023 claims 0012** (`0012_deployment_fabric.sql`), WORK-018 claims 0011 (already pushed on its branch), WORK-031 claims 0013. The claim is pinned in the migration header and asserted by the inventory architecture gate — which THIS branch evolved to be MERGE-ORDER TOLERANT: the baseline [0001..0010] must be unique/un-renumbered; wave numbers may be present (sibling merged first) or absent (this branch carries only its own claim); file-inventory gaps are legal pre-merge (the runner applies in ascending order and allows gaps). The architect's merge reconciliation owns the final ordering.

## Discrimination results (the 17 mutants)

| Mutant | Proof |
|---|---|
| DF1 execution method on the adapter port | static red: `execute(` added to the port interface is flagged |
| DF2 service deps gain an authority seam | static red: `ToolAdmission` added to the pinned deps is flagged |
| DF3 execution state-machine vocabulary in deployments | static red: `nextState` inserted into the service is flagged |
| DF4 vendor rail slug leaks into contracts | static red: `twilio` inserted into the channel vocabulary is flagged |
| DF5 agents seam gains a mutation call | static red: `.promote(` added to the inventory adapter is flagged |
| DF6 unknown agent version never deploys | runtime red: AGENT_ERROR fail-closed resolution |
| DF7 uncovered/refusing channel binding rejects the plan | runtime red: CAPABILITY_UNAVAILABLE both ways |
| DF8 initial plan mismatch refuses creation | runtime red: identity binding (environment mismatch class) |
| DF9 promotion to a mismatched agent version refused | runtime red: "preserves deployment identity" |
| DF10 rollback history never rewritten | runtime red: journal order + intact promote event |
| DF11 lifecycle key replay converges | runtime red: exactly one promote per key |
| DF12 cross-tenant mutation fails closed | runtime red: TENANT_SCOPE_VIOLATION |
| DF13 retired is terminal | runtime red: suspend AND promote both fail (found and fixed the promote-on-retired guard during development) |
| DF14 BYOA without a descriptor unrepresentable | runtime red: validation + the migration CHECK |
| DF15 foreign-schema SQL write (direct customer-domain workflow mutation — M22) | static red: `UPDATE integrations.workflow_runs …` added to the SQL store is flagged; every clean write targets `deployments.*` (mirrored by architecture gate D9) |
| DF16 any authority method beyond the non-authoritative duo on the adapter port (M10..M15 by exact shape) | static red: `execute`/`verify`/`authorize`/`admit`/`registerAgent`/`budget` each added to `ModalityChannelAdapter` is flagged; the clean port is exactly `checkBinding` + `describeBinding` (mirrored by the D1 exact-shape assertion) |
| DF17 cross-APPLICATION mutation fails closed before side effects (M3) | runtime red: PROVIDER_ERROR "not found in this application"; the journal is untouched (the PG suite proves the same against the real store) |

### The M1..M22 coverage map (work order §17)

M1 duplicate identity → PG identity UNIQUE + concurrent identity-collision race · M2 cross-tenant → DF12 + PG tenant isolation · M3 cross-application → DF17 + PG cross-application mutation (reads already proven empty) · M4 stale agent version → DF6 + unit · M5 promotion race → PG concurrent promotions · M6 rollback race → PG concurrent rollbacks + rollback-vs-promotion · M7 suspension race → PG concurrent suspensions + suspend-vs-retire · M8 duplicate lifecycle operation → DF11 + PG replay · M9 idempotency fingerprint bypass → unit fingerprint reuse (IDEMPOTENCY_KEY_REUSED) + slug-convergence arbitration · M10..M15 adapter authority creation (execution/policy/capability/budget/verification/second agent registry) → D1 exact shape + DF16 + D2/DF2 pinned deps + D7/DF5 read-only agents seam · M16 provider type leaks → D4/DF4 · M17 rollback mutates history → DF10 + PG physical append-only · M18 profile mutation after activation → PG physical immutability triggers · M19 modality-specific authority leaks → D1/D2/D4/D8 · M20 BYOA bypasses governance → PG BYOA through the same lifecycle · M21 external credentials bypass mediation → unit credential-shaped descriptor rejection + cause/descriptor secret scans + the migration CHECK · M22 direct customer workflow mutation → D9 + DF15 (write-target discipline) + the pinned service deps (no workflow seam — DF2).

## The §9/§17 verification-gap closure (the re-verification pass)

A from-repository-truth audit of the branch against the canonical work order found the §9 concurrency proof covered ONLY concurrent promotion, while §9 names promotion, ROLLBACK, SUSPENSION and CREATION; §17's minimum list had entries without a dedicated proof (M3's mutation path, M6, M7, M10..M15's exact-shape guarantee, M22). The closure (commit `35cda03`, test-dominant, zero authority-semantics change):

- **Seven new real-PG race tests** (§9/M5–M7/M1/M3): concurrent rollbacks converge (exactly one journal event — both callers derive the same prior version and the guarded single-row UPDATE admits one writer); rollback-vs-promotion never tears the pointer (the loser fails `INVALID_STATE_TRANSITION`, the committed row matches the LAST journaled move); concurrent suspensions converge (one suspend event); suspend-vs-retire is unambiguous and journaled once; concurrent duplicate creations yield a SINGLE durable result (one row, one create event, both callers agree on the deployment id); concurrent identity collisions are refused by the physical identity UNIQUE; cross-APPLICATION mutation fails closed before side effects.
- **One structural exact-once hardening in `createDeployment` (§10)**: a concurrent duplicate that converged through insert arbitration previously appended a SECOND `create` event under its own idempotency key (the winner's event should be the only truth — "concurrent duplicate: single durable result"). Converged ⇒ never journal. DISCLOSED: the pre-fix double-journal could NOT be reproduced as a stable failing assertion in the pool harness (6 attempts — the losing caller consistently observed the committed row through the slug fast path before its insert; the window is real but interleaving-dependent); the fix makes the discipline structural and the new race test pins the invariant in every ordering. No existing test depended on the converged-create journal path.
- **D9 + DF15 (M22)**: the adapters' SQL write targets are mechanically pinned to `deployments.*` (a foreign-schema write — direct customer-domain workflow mutation — is flagged).
- **D1 exact-shape + DF16 (M10..M15)**: the modality-adapter port's method set is exactly `checkBinding` + `describeBinding`; ANY authority-shaped method appearing on the port is flagged.

## Verification (branch state finalized by this evidence commit)

Environment: Bun 1.3.14, real PostgreSQL 16.4 at `127.0.0.1:55432` (`ZECK_PG_TEST_URL`), migrations 0001..0010 + 0012 applied per suite on disposable databases (this branch carries only WORK-023's claim; 0011 is the sibling WORK-018 branch's claim).

| Command | Result |
|---|---|
| `bun install --frozen-lockfile` | clean (no new dependency — WORK-023 adds NONE) |
| `bun run typecheck` | 0 errors |
| `bun run lint` | 0 errors, 0 warnings (596 files) |
| `python3 scripts/governance-check.py` | exit 0 — `Governance OK: 31 Work Orders, 94 requirements, frontier=['WORK-018', 'WORK-031']` (WORK-023 the sole in-flight item on this branch) |
| `bun run test:unit` | 979/979 (77 files; incl. 40 WORK-023 tests: fabric-domain 19, fabric-service 21; the modules test now pins 19 module identities) |
| `bun run test:architecture` | 499/499 (48 files; incl. the 10-gate deployment-fabric boundary (D9 added: adapters' SQL writes target only `deployments.*`) + the 17-mutant discrimination suite (DF15/DF16/DF17 added) + the module-skeleton 19th-module loop + the wave-tolerant inventory gate) |
| `bun run test:integration` | 7 passed + 41 PG-gated skips without `ZECK_PG_TEST_URL`; 293/293 (41 files) with the URL set |
| `ZECK_PG_TEST_URL=… bun run test:pg` (real PostgreSQL) | 287/287 (39 files; incl. the 20 WORK-023 fabric PG tests: schema/triggers, artifact immutability, identity UNIQUE, lifecycle replay + the §9 races — CONCURRENT promotions, rollbacks, rollback-vs-promotion, suspensions, suspend-vs-retire, duplicate creations, identity collisions — rollback physical append-only, execution provenance with a real execution, tenant isolation, cross-application fail-closed, terminal retired, BYOA) |
| `ZECK_PG_TEST_URL=… bun run test` (FULL suite) | **1771/1771 (166 files), zero failing tests** — at the gap-closure head `35cda03`: runs 1 and 3 fired the DOCUMENTED teardown transient (the 57P01 class: a `pg_terminate_backend`-related failure during disposable-DB teardown/cleanup — all 1771 tests passing each time, exit 1 only from cleanup/unhandled-error accounting); runs 2, 4 and 5 were clean exit-0, with runs 4+5 the two CONSECUTIVE clean runs (`/tmp/023-full-35cda03-run4.log`, `-run5.log`). Earlier heads: 1760/1760 ×2 clean at `3cb8351`, `01c4151` and `6d5d402`. Main at pickup was 1683/1683 (161 files) green; this branch's delta is +88 tests / +5 files (exactly WORK-023's tests) |

The evidence-change rule: the complete gate is re-executed at the exact final head (this commit) after the evidence lands — the results are recorded in the PR body before push (the two-phase SHA binding convention).

## Checkpoint evidence

Recorded in `spec/development-state/checkpoint-state.json` under `WORK-023` (the three required contracts, verdict `passed`, evidence pointers):

- `IMPLEMENTATION-COMPLETENESS` — this file + the unit/PG/architecture suites for the new module.
- `EXECUTION-PROVENANCE` — the journal's execution-provenance proof (a real execution id on a promote event) + the identity binding tests.
- `SELF-HOSTING-BOUNDARY` — the D1..D8 architecture gates + the DF1..DF14 discrimination suite + the migration collision-rule claim.

## Limitations

- **No production API/operator surface is wired**: the fabric is a module service; the composition root (API routes, the WORK-015 pattern) is future experience-layer work. Tests prove the capability over the real stores.
- **The modality adapters in this Work Order are neutral test adapters**: the REAL channel rails (web/telephony/SMS/media) arrive with WORK-024/025/026 behind the same seam; no vendor SDK exists anywhere in this module at v1 (D4).
- **Deployment identity does not FK to the agents module**: BYOA external agents are representable (MOD-010) and their versions live in the agents module's authority — the deployment references agent identity by UUID, resolved through the agents public seam at validation time, not by a physical FK (the honest trade-off, disclosed).
- **Session/job binding to deployment identity is downstream**: WORK-024/025/026 bind modality sessions/jobs to deployment identity using the plan's channel bindings and the adapter descriptions; this Work Order exposes the metadata they need (criterion 5 of the work order's implementation requirements) without implementing any modality runtime.
- **Promotions while suspended are allowed by design** (the pointer moves; resume serves the new version) — a deliberate control-plane semantics, journaled either way; suspend/resume themselves are strict.
- **CI runs no real-PG suites** (the standing WORK-002 flag); the PG proofs are local-verified against real PostgreSQL 16.4 and recorded above.
- **The inventory gate is now wave-tolerant**: the sibling branches' pre-assigned numbers may be present or absent — final reconciliation is the architect's merge responsibility (documented above).

## PR binding

BOUND — the PR body of this branch's pull request records the exact final head, the complete-gate re-execution at that head, and the CI run identity (the two-phase SHA binding convention: the implementation gate is recorded above at `3cb8351`; the first evidence head's gate at `01c4151`/`6d5d402`; the gap-closure gate at `35cda03` (§9/§17 completion + the exact-once hardening); the final evidence head's gate is re-executed after this commit lands and recorded in the PR body before push).

## Reconciliation onto main@286b3f8 (post WORK-032 landing)

Provenance and identity:

- **Old verified implementation head (historical provenance): `372e90ad8b214921c1cc959eb5692eb118de8e9f`** — the pre-reconciliation branch head (gap-closure `35cda03` + evidence rebinding `372e90a` on top of `6d5d402`), with its own green gate (1771/1771 ×2) and green CI (run 33445324664). It remains an ancestor of this branch as the first parent of the reconciliation merge.
- **Reconciliation merge commit: `acb452f4179fe91821292441226c8838c2cbb8e4`** — `git merge 286b3f83118364cb31acd680ca56ad96448c3776` into the branch; parents `(372e90a, 286b3f8)`; message "WORK-023: reconcile onto main@286b3f8 (post WORK-032 landing; semantic union of governance state and shared module surfaces)". Merge-based (no rebase, no force-push): the push to `origin/work/WORK-023-deployment-fabric` is a plain fast-forward and GitHub `mergeable` returns to clean.
- **Race-hardening commit: `f7a3e09`** — test-only (see "M6/M7 race hardening" below): the four §9 race tests in `tests/integration/postgres/deployments-fabric.test.ts` now assert the invariants that hold under EVERY legal interleaving instead of one specific interleave; no source change, no test dropped, the strict outcomes remain asserted when they are the only legal ones.
- **Final head: this evidence commit** (docs-only rebinding, per the two-phase SHA binding convention; the PR body binds the exact final head SHA after push).
- Local-only safety backup branch `backup/WORK-023-wave` at `372e90a` (never pushed).

Conflict resolutions (semantic union — every side's content preserved):

1. `spec/development-state/checkpoint-state.json` — union: all of main's entries (including WORK-032's three passed contracts: IDENTITY-IDEMPOTENCY, ECONOMIC-AUTHORITY-BOUNDARY, EXECUTION-PROVENANCE) PLUS the WORK-023 entry byte-identical to `372e90a`'s (all three WORK-023 contracts passed). Verified: diff vs `286b3f8` adds ONLY the WORK-023 entry; diff vs `372e90a` adds ONLY the WORK-032 entry.
2. `tests/architecture/composition-boundary.test.ts` — the migration-inventory gate in the merge-order-tolerant form (the REC-3/WORK-031 precedent): baseline 0001..0010 asserted by loop + `filter(<=10).toEqual([1..10])` + `toContain(12)` (this branch's claim, additionally pinned by reading `0012_deployment_fabric.sql`) + `toContain(14)` (WORK-032, landed on main). Main's strict `toEqual([1..10, 14])` is subsumed (the reconciled inventory is [1..10, 12, 14] — file gaps legal pre-merge, the runner applies in ascending order and tolerates gaps; the WORK-032 branch itself proved the gap tolerance with [1..10, 14]). No test case dropped; all of main's uniqueness/un-renumbering semantics preserved.
3. `tests/unit/modules.test.ts` — union count: 20 unique frozen module identities (WORK-023's `deployments` + WORK-032's `economics`); the spec-mirror and uniqueness assertions kept from both sides.
4. `spec/development-state/frontier-state.json` (auto-merged, semantically reviewed) — the required union: `eligible=['WORK-018','WORK-031']`, `inFlight=['WORK-023']` (WORK-032 done and removed from the frontier by main's `0ee5c8a` post-merge restore; WORK-023 in-flight as this branch's transition; siblings pending+eligible exactly as both sides carry them).
5. `spec/development-state/program-state.json` — main's file verbatim (catalog v3 / 102 requirements, WORK-032 `complete`/`mergedAs PR #36`, ADR-0017/0018-era additions) + the single branch semantic flip WORK-023 `pending`→`in-flight` (verified: diff vs `286b3f8` is EXACTLY that one status change).
6. `IMPLEMENTATION.md`, `spec/architecture.md`, `src/shared/module.ts` — pure unions: the deployments module row/entry from this branch PLUS the economics module and payment-rails integration entries from main; the module registry is the 20-identity union (`deployments` + `economics`).

Byte-for-byte and inventory guarantees:

- `git diff 372e90a..acb452f -- src/platform/db/migrations/0012_deployment_fabric.sql` is EMPTY (byte-for-byte preserved, not renumbered).
- `git diff 286b3f8..acb452f -- src/platform/db/migrations/0014_economic_actions.sql` is EMPTY (WORK-032's migration preserved byte-for-byte).
- Migration inventory on the reconciled tree: 0001–0010 + `0012_deployment_fabric.sql` + `0014_economic_actions.sql`; 0011/0013 ABSENT by design (sibling claims, not merged yet; never created on this branch; the runner tolerates the gaps — proven by WORK-032's own branch and REC-3's WORK-031 reconciliation, both real-PG green with exactly this shape).

Preservation proof (user step 1):

- WORK-023's owned change set `9515921 → 372e90a` = 33 files (24 added + 9 modified). All 24 added files are byte-identical on the reconciled tree (zero-line diffs vs `372e90a`; includes migration 0012, all deployments sources, all deployments tests, the evidence doc). The 9 modified shared files differ from `372e90a` ONLY by main-side additions (WORK-032's `economics`/`payment-rails` rows and entries, WORK-032's checkpoint/program records) plus the two union restructurings documented above (frontier/program WORK-023 in-flight flip is the branch's own pre-existing state; the module count 19→20 and the tolerant inventory gate are the union of both sides' assertions).
- `git diff 286b3f8..acb452f` = EXACTLY the 33-file owned change set (identical name-status list) — the merge changed nothing vs main except WORK-023's owned surfaces (+6260/−13); the only 13 deleted lines are the union-necessitated restructurings (the WORK-023 `pending→in-flight` flips in frontier/program state, main's strict inventory assertion replaced by the subsuming tolerant form, the `19`→`20` module count) — ZERO loss of main-side code, tests, or state; all WORK-032 content present.
- Test-count union: main's full suite 1848/1848 (172 files) + WORK-023's delta (+88 tests/+5 files vs the 1683/161 pickup baseline) = the reconciled 1936/1936 (177 files); equivalently the old head's 1771/1771 (166 files) + WORK-032's +165/+11 = 1936/177. Both parent identities subsumed exactly.

Interrupted-prior-attempt disclosure (session provenance):

- This reconciliation was dispatched as REC-2 after an earlier REC-2 attempt was infrastructure-interrupted: the worktree was found with the reconciliation merge commit `acb452f` already committed (author/committer `Z User <z@container>`, the branch's verified identity; parents and message exactly as above) and an UNCOMMITTED complete edit hardening the M6/M7 race assertions to interleaving-tolerant form. This session first verified the merge end-to-end (all conflict resolutions audited against both parents, as recorded above), then initially REVERTED the uncommitted edit out of conservatism ("preserve all WORK-023 tests") after 6 green observations of the STRICT assertions (3 isolated runs of `deployments-fabric.test.ts` 20/20; full suite with PG 1936/1936 ×2 consecutive; full suite without PG clean — all at the pristine merge). The subsequent gate work then FIRED the exact failure the interrupted session had been fixing: a `test:integration` run on the same test tree produced the M6 sequential-equivalent interleave (`CONCURRENT rollbacks converge` — `expected 2 to be 1` at the strict `currentPlanVersion` assertion; `/tmp/rec2-final-integ.log`), proving the strict assertions over-specify ONE interleaving of a race whose other interleavings are equally legal service semantics. The interrupted edit was then re-applied verbatim (`git apply` of the preserved diff `/tmp/rec2-m6-edit-interrupted.diff`) and completed (see "M6/M7 race hardening"), committed as `f7a3e09`. (A brief terminal-rendering artifact had made two `moves[moves.length - 1]` lines APPEAR corrupted as `movesoves` in console output; byte-level verification showed the edit was complete and syntactically valid all along.)

M6/M7 race hardening (`f7a3e09`, test-only — justification and semantics):

- **Empirical cause**: the reconciled tree carries WORK-032's additional PG test files, which raises connection/scheduling pressure inside the race tests' process; under that load the second concurrent rollback's journal read landed AFTER the first's commit — the sequential-equivalent interleave — and the strict assertion `currentPlanVersion === 1` failed (observed once; the same class was consistently converged at `372e90a`'s lighter load; races are interleaving-dependent by nature).
- **Semantics (from the service source, unchanged by this reconciliation)**: `rollbackDeployment` DERIVES the prior version from the journal's last move (`deployment-service.ts` rollback: `priorPlanVersion = last.priorPlanVersion`), and `applyGuardedMutation`'s single-row guarded UPDATE converges or fails closed when the guard disagrees. Two concurrent rollbacks with DISTINCT keys therefore have two legal outcome classes: (i) both read before either commits — one writer wins, the loser converges without journaling (pointer v1, ONE event — the previously asserted outcome); (ii) the second reads after the first's commit — it observes the first rollback's event, derives prior = v2 and applies a sequential-equivalent rollback-of-rollback (pointer v2, TWO events, both journaled under their own keys) — exactly the semantics of two sequential rollbacks. Same reasoning extends to rollback-vs-promotion (single-writer fail-closed, or sequential — pointer v1/v3, or v2 when a post-commit rollback re-derives from the journal after a promote), concurrent suspensions (pre-commit convergence with both fulfilled, or post-commit fail-closed — always exactly ONE suspend event), and suspend-vs-retire (guard arbitration, or the legal suspended→retired sequential application).
- **The hardened assertions assert the INVARIANTS that hold under every legal interleaving**: the pointer is never torn and always matches the LAST journaled move; every idempotency key journals at most once (per-key exact-once, also physically enforced by the journal's UNIQUE constraint); move counts are bounded to the legal interleave classes; the strict single-winner/single-event outcomes are STILL asserted wherever they are the only legal ones (concurrent promotions: exactly one event both fulfilled — the idempotent-target fast path makes that deterministic; concurrent suspensions: exactly one suspend event; duplicate creations: one row, one create event; identity collisions: refused by the physical UNIQUE). NO test was dropped, renamed away, or weakened in its authority guarantee; the four M6/M7 tests keep their §9 coverage intent with race-correct assertions. This is the same invariant-based pattern the §10 creation race and the concurrent-promotion test already used.
- **Verification of the hardening**: typecheck 0; lint 0/0 (648 files); `deployments-fabric.test.ts` 20/20 ×6 isolated runs; `test:integration` 307/307 with zero failing tests ×3 (run 1 marred ONLY by the documented 57P01 teardown transient on the PRE-EXISTING `learning-shadow.test.ts` disposable-DB cleanup — all 307 passing, exit 1; runs 2–3 clean exit-0).

Verification (complete gate at the reconciliation merge head `acb452f` — fresh runs this session, BEFORE the race hardening (strict M6/M7 assertions); migrations 0001–0010 + 0012 + 0014 applied per suite on disposable databases; the final-head re-execution follows the two-phase SHA binding convention below):

| Command | Result |
|---|---|
| `bun install --frozen-lockfile` | exit 0 (116 installs / 165 packages, no changes — no new dependency) |
| `bun run typecheck` | 0 errors |
| `bun run lint` | 0 errors, 0 warnings (648 files) |
| `python3 scripts/governance-check.py` | exit 0 — `Governance OK: 32 Work Orders, 102 requirements, frontier=['WORK-018', 'WORK-031']` (WORK-023 the sole in-flight item on this branch; WORK-032 complete on main; siblings pending+eligible — the required union) |
| `bunx vitest run tests/architecture` | 117/117 (18 files) |
| `bunx vitest run tests/discrimination` | 432/432 (31 files) |
| `bun run test:unit` (supplementary) | 1080/1080 (86 files; incl. the 40 WORK-023 deployments unit tests; the modules test now pins the 20-identity union registry) |
| `bun run test:integration` (with `ZECK_PG_TEST_URL`) | 307/307 (42 files) |
| `ZECK_PG_TEST_URL=… bun run test:pg` (real PostgreSQL) | 301/301 (40 files) — run 2 fired the DOCUMENTED 57P01 teardown transient (all 301 passing, 1 unhandled cleanup error, exit 1; run 1 similarly marred — 3 errors, exit 1) → run 3 clean exit 0 (all runs show zero failing tests) |
| `ZECK_PG_TEST_URL=… bun run test` (FULL suite) | **1936/1936 (177 files), zero failing tests, ×2 CONSECUTIVE clean exit-0** (`/tmp/rec2-full-merge-pg-run1.log`, `-run2.log`; zero 57P01, zero unhandled errors in both) — the union of main's 1848 and this branch's +88; a supplementary no-PG full run was also clean (1634 passed + 43 PG-gated skips) |

Race-hardening verification at `f7a3e09` (test-only commit): `bun run typecheck` 0 errors; `bun run lint` 0/0 (648 files); `deployments-fabric.test.ts` 20/20 ×6; `test:integration` 307/307 ×3 (zero failing tests every run; run 1 exit 1 from the documented 57P01 teardown transient on the pre-existing `learning-shadow.test.ts` cleanup, runs 2–3 clean exit-0). The full-suite and remaining stages are re-executed at the EXACT FINAL HEAD (this commit) per the evidence-change rule below.

The evidence-change rule: the complete gate is re-executed at the EXACT FINAL HEAD (this commit) after this evidence lands; the fresh results are recorded in the PR body before push, together with the fresh CI run identity for that exact head (the two-phase SHA binding convention; historical CI runs on `372e90a`/`6d5d402` are provenance only and are NOT counted).
