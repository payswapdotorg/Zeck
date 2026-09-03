# WORK-034 Evidence — API/SDK application-scope reconciliation

Status: IN-FLIGHT (worker record; the Architect owns merge/finalization)

Assurance Profile: HIGH_ASSURANCE

Frozen base: `205ffea` (main, the governance head that issued this Work Order)
Declared surfaces: `sdk/`, `src/shared/wire.ts`, `src/api/`, `cli/`, tests for the above, this file. NOTHING else (audited below).

## Root cause (the PR #58 Architect review, verified in-tree)

The Architect review of PR #58 (WORK-033) established the blocking defect, and this implementation verified it in-tree before touching anything:

- The real API derives application scope per request from the `X-Zeck-Application` header and rejects scoped requests without it. The execution family (`GET /executions/:id`, `/results`, `/events`, `/verification` and `POST /executions/:id/cancel`) reads it through a route-local `applicationHeaderOf`; the agent family (`GET /agents`, `GET /agents/:id`, `/agents/:id/versions`, `/agents/:id/status`), the codebase-analysis family and the economic-action family each carry their OWN local copy of the same rule.
- The public SDK client (`sdk/index.ts`) sent only the bearer credential for every scoped method: `getExecution`, `cancelExecution`, `getResult`, `listEvents`, `listVerification`, `listAgents`, `getAgentStatus`. All seven were incompatible with the real wire contract.
- The CLI consumes those same methods (`inspect/result/events/cost/verify/cancel/agents/agent`), so its scoped commands were equally broken against the real API.
- The pre-existing main-side dashboard (`apps/dashboard/index.ts` at the base) also consumes the SDK — its scoped views were equally broken. It is WORK-033's declared surface and is NOT touched by this Work Order (see Limitations).

**The defect's true extent was broader than the review's execution-read list**: the review named execution detail, results, events and verification; cancel (a governed command, not a read) and the agent inventory reads require the same header. All seven scoped SDK methods are reconciled here.

## The reconciliation

1. **The canonical wire contract (`src/shared/wire.ts`)**: `ZECK_APPLICATION_HEADER = "x-zeck-application"` — one named constant, documented as the split contract (creation carries the selector in the request body's `applicationId`; every scoped read and governed command carries it in the header). The wire module is the ONE canonical contract shared by the API transport and the SDK (re-exported), so the header name is single-sourced by construction — the same discipline that keeps the wire shapes drift-free.
2. **The single-sourced server rule (`src/api/request-identity.ts`)**: `applicationScopeOf(request, surface)` — one helper where the other request-field rules live; each route family passes its disclosure-quality surface phrase ("execution reads", "execution commands", "agent inventory reads", "codebase-analysis routes", "economic action reads"). The four route-local `applicationHeaderOf` copies are REMOVED; all scoped routes consume the shared rule and the canonical constant. Server behavior is unchanged (same rejection code `CAPABILITY_UNAVAILABLE`, same 422/404 mapping, per-surface message fronts preserved; the message tail is canonicalized to "authorizes the request").
3. **The scoped SDK client (`sdk/index.ts`)**: `ZeckClientOptions.applicationId` — the application whose scope authorizes scoped reads and governed commands. Every scoped method sends the canonical header from that scope. A client constructed WITHOUT a scope fails fast client-side on every scoped method with an actionable plain `Error` naming the header and the missing option — the request is never issued. This mirrors the established client-side pinning pattern (provider-selection attempts are rejected before the wire, API-001/M17): the wire contract is pinned, never discovered. A blank scope is rejected at construction. `createExecution` is unchanged on the wire (the body's `applicationId` remains the creation selector; no header is sent).
4. **The CLI (`cli/index.ts`)**: every command constructs its client with the application id it already requires positionally — the command surface and usage text are unchanged.

## The proof inventory

| Tier | File | Records | What it pins |
|---|---|---|---|
| SDK unit | `tests/unit/sdk/client.test.ts` | 13 (was 8) | every scoped method sends the canonical header with the exact scope; creation sends NO header and carries the body scope; an unscoped client fails fast on all seven scoped methods with ZERO wire requests; the fail-fast names the header + the option and is not a `ZeckApiError`; a blank scope is rejected at construction |
| API unit | `tests/unit/api/executions-routes.test.ts` | 28 (was 25) | all four execution reads AND cancel reject a missing/blank header (422 `CAPABILITY_UNAVAILABLE`, the single-sourced message) |
| API unit | `tests/unit/api/agents-routes.test.ts` | 9 (was 8) | the agent inventory reads reject a missing header the same way |
| CLI unit | `tests/unit/cli/cli.test.ts` | 13 (was 11) | all eight scoped commands send `x-zeck-application` = the positional application argument; `submit` keeps its scope in the body (no header) |
| **Cross-tier** | `tests/unit/api/sdk-reconciliation.test.ts` | 4 (new) | **the real-server × real-SDK journey**: the world's REAL Fastify server (real routes, real server-side scope resolution, real serialization/error mapping over real module surfaces) bridged to the SDK's injectable fetch — creation → scoped reads → governed cancel → agent inventory → post-cancel read, 9 wire calls, all green; the unscoped client fails fast with the bridge recording ZERO invocations; the real server rejects a headerless scoped read (422); a scoped client for ANOTHER application gets the indistinguishable 404 miss (M1, no tenant leak in the error body) |

The cross-tier suite is the reconciliation's core evidence: it closes the exact gap the Architect identified (a fake transport implementing its own rules can be green while the real path is broken) by driving the REAL server through the REAL client. Every wire-level contract claim in this Work Order is proven against the real route/handler pipeline, not a re-implementation.

## Requirement mapping (acceptance criteria)

| Criterion | Implementation | Proof |
|---|---|---|
| AC1 — every scoped SDK method sends the header from the client's application scope | the seven scoped methods pass `{ [ZECK_APPLICATION_HEADER]: requireApplicationScope() }` | SDK unit "every scoped method sends the canonical application-scope header"; the cross-tier journey |
| AC2 — an unscoped client fails fast client-side, no unscoped wire request | `requireApplicationScope()` throws before `request()` is entered | SDK unit fail-fast records (0 recorded fetch calls); cross-tier "the wire is never reached" |
| AC3 — creation unchanged: body selector, no header | `createExecution` untouched (idempotency-key header only) | SDK unit "creation keeps its scope in the body"; CLI submit pin; the cross-tier creation call |
| AC4 — the rule single-sourced: one wire constant + one API helper, no route-local copies | `ZECK_APPLICATION_HEADER` in wire.ts; `applicationScopeOf` in request-identity.ts; the four local `applicationHeaderOf` implementations deleted (rg-verified: zero `x-zeck-application` literals outside wire.ts + the test worlds' header-setting helpers, which are the CLIENT side of the contract) | the source audit; API rejection pins across all four families |
| AC5 — the CLI passes its application argument as the client scope | `makeClient(applicationId)` in every command | CLI transport pins (all eight scoped commands) |
| AC6 — pinned end-to-end against the real server, including the 400/422 rejection and the fail-fast | `tests/unit/api/sdk-reconciliation.test.ts` | the 4 cross-tier records |
| AC7 — zero dashboard/spec/module/migration edits; server-side scope derivation unchanged | the surface audit below | `git diff --name-only 205ffea..HEAD` (audited) |

## Surface audit (rg-verified, base `205ffea` → final head)

Changed files — exactly the declared surfaces:
- `sdk/index.ts`
- `src/shared/wire.ts`
- `src/api/request-identity.ts`, `src/api/routes/executions.ts`, `src/api/routes/agents.ts`, `src/api/routes/codebase-analysis.ts`, `src/api/routes/economic-actions.ts`
- `cli/index.ts`
- `tests/unit/sdk/client.test.ts`, `tests/unit/api/executions-routes.test.ts`, `tests/unit/api/agents-routes.test.ts`, `tests/unit/cli/cli.test.ts`, `tests/unit/api/sdk-reconciliation.test.ts` (new)
- `docs/work-items/WORK-034.md` (this file)

ZERO files under `apps/dashboard/`, `spec/`, `src/modules/`, `migrations/` (no migration claimed; the shipped inventory is untouched), `.github/`, or root configs. Zero merge commits; `merge-base(205ffea, HEAD) == 205ffea`.

## Design decisions

- **Client-level scope, not per-call parameters**: the server resolves scope per request from one header; the client binds the application context at construction — the CLI's commands already require the application positionally, and an application-scoped projection (the dashboard's verification update, sequenced after this order) constructs one client per deployment. Per-call scope parameters would multiply the failure modes the review rejected (a caller forgetting the per-call scope on one read reintroduces the defect); the client-level scope makes the scoped reads' precondition structural.
- **Optional-at-construction + fail-fast-at-call, not a required option**: `apps/dashboard/` is WORK-033's in-flight declared surface and must not be edited from this Work Order (the frozen dependency pin, the PR #57 lesson, and the Architect's explicit sequencing). A required option would force a dashboard edit here. The optional + fail-fast contract keeps the old dashboard source-compatible while making its scoped views fail with a clear, actionable client-side error instead of an opaque server 422 — strictly better than the status quo (its scoped views were already broken against the real API; that is the defect being repaired). The WORK-033 verification update will construct its client WITH the scope.
- **A plain `Error` for the fail-fast, never `ZeckApiError`**: the failure never reached the wire; presenting it as a transport error would misattribute it. The message names the header, the missing option and the rule — the same disclosure discipline as the provider-selection rejection.
- **No server-side semantic change**: the scope derivation model (server-side, durable-membership-resolved, never client-authorized) is untouched; the four route files' edits are purely the shared-rule substitution. The create contract keeps the body selector (the closed create vocabulary is frozen and pinned by existing tests).
- **The canonicalized rejection message tail**: the four local copies ended differently ("authorizes the read"/"the operation"); the shared helper ends "authorizes the request" with the per-surface front preserved. No test asserted the old tails; the new pins assert the shared rule's message.

## Verification (two-phase SHA binding)

Phase 1 — base at pickup (orchestrator-verified, authoritative for the base): governance OK (34 Work Orders, 102 requirements, inFlight=[], frontier=['WORK-034']) · typecheck 0 errors · biome clean (937 files) · full suite with real PG = 262 files / 3589 tests at `205ffea` (the pre-WORK-033 baseline — PR #58 is unmerged, so its dashboard files are not in this base).

Phase 2 — the evidence-change rule: the COMPLETE gate (`python3 scripts/governance-check.py`, `bun run typecheck`, `bun run lint`, and `ZECK_PG_TEST_URL=… bun run test` — the FULL suite, run TWICE consecutively) is re-executed at the exact FINAL head (the branch head that contains this file) after this doc lands; the observed results and the CI run identity are recorded in the PR body before the review request. No result is claimed here that was not observed at the head it is bound to.

Test-count accounting (base vs branch): the base was 262 files / 3589 tests; this branch adds exactly **1 test file / 15 tests** (SDK +5, executions-routes +3, agents-routes +1, CLI +2, the cross-tier suite +4) and edits NO inherited test file's counts. The expected full-suite total is 263 files / 3604 tests.

## Checkpoint evidence (recorded HERE ONLY; `checkpoint-state.json` is Architect-owned and untouched)

- `AUTH-PRESERVATION` — status: recorded, verdict: **passed** — evidence: the scope derivation model is unchanged (server-side, resolved from durable membership rows through the injected scope resolver; the header selector never authorizes); the API's authority delegation is untouched; the SDK adds NO authority — it only names the application whose membership the server will resolve; the fail-fast is client-side input validation, the established M17 pattern.
- `TENANT-ISOLATION` — status: recorded, verdict: **passed** — evidence: the cross-tenant record (a scoped client for another application receives the indistinguishable 404; no tenant id in the error body); the server-side rejection pins; no route gained any client-supplied tenant/scope authority; the rejection ordering is unchanged (scope resolution before any authority read).
- `DEPENDENCY-DIRECTION` — status: recorded, verdict: **passed** — evidence: the SDK still imports ONLY `src/shared/wire` (the canonical contract — now also the header constant); `src/api` imports `src/shared` + module public barrels only (the scanner-pinned boundary); the CLI imports the SDK only; no new dependency edge anywhere (the public-surface architecture suite re-run green).
- `IMPLEMENTATION-COMPLETENESS` — status: recorded, verdict: **passed** — evidence: every acceptance criterion is implemented and pinned (the mapping table above); the declared surfaces exactly match the audited diff; the Work Order's forbidden list is respected (the surface audit).

The Work-Order checkpoints map:
- **readiness** — the frozen base `205ffea` verified green before implementation (phase 1); the WORK-033 surface boundary honored (zero dashboard edits).
- **contract** — the single-sourcing map + the canonical constant; the four local copies removed.
- **boundary** — the fail-fast pins (client-side, zero wire requests); no transport bypass anywhere (the public-surface discrimination suite re-run green — the SDK remains the only transport).
- **proof** — the cross-tier real-server × real-SDK suite, including the server enforcement pin and the client fail-fast pin.
- **review** — the complete gate twice at the exact final head (phase 2, recorded in the PR body).

## Limitations (honest)

- **The WORK-033 verification update is NOT in this Work Order** — by the Architect's explicit sequencing. PR #58's dashboard must construct its client with the application scope and its integration world must enforce the scoped-read requirement (mirroring the real server's rule) once this order merges; that update happens under WORK-033's own surfaces, against the reconciled contract. Until then, PR #58 remains rejected and the dashboard journey remains unproven — this order repairs the TRANSPORT, not the dashboard.
- **The old main-side dashboard remains runtime-broken for scoped views** (it was already broken against the real API — that is the defect; it is WORK-033's surface and will be replaced by the PR #58 dashboard). Its construction still typechecks (the optional scope), and its scoped views now fail with the actionable client-side error instead of an opaque server 422.
- **No live-transport (socket) test**: the cross-tier proof bridges the SDK's `fetchImpl` to the real Fastify server's inject pipeline — real routing, real handlers, real header semantics — without opening a network socket (the deterministic, CI-compatible convention; the PG tier's standing convention applies to CI runs).
- **The rejection status is 422, not 400** — `CAPABILITY_UNAVAILABLE` maps to 422 in the frozen error taxonomy; the review's phrasing ("rejects the request") is satisfied by the typed rejection. This is the pre-existing mapping, unchanged.
- **No external npm publication**: the SDK is the in-repo public contract; consumers outside this repository would see the new optional client option and the fail-fast as a behavior change on unscoped scoped-calls (the honest contract repair the review required).

## PR binding

BOUND — the PR body of this branch's single pull request records the exact final head, the complete-gate re-execution at that head (phase 2), and the CI run identity on that exact head. The implementation depends on no sibling branch (no rebase, no cherry-pick, no merge with main). The PR is NOT merged/approved by the worker — the Architect is the merge authority. The WORK-033 verification update follows the merge.
