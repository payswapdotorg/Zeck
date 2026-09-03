# WORK-036 Evidence — Home, Work creation and execution experience

Work Order: `WORK-036` (spec/work-orders/WORK-036.md) · Assurance: **HIGH_ASSURANCE** · Requirement IDs: N/A (dashboard projection realization; frozen technical requirement ownership untouched)

Frozen base: `5131e70c9ad694fb49ad14afb4035af8b6caed4f` (main — the post-WORK-035-finalization head: WORK-035 merged as PR #62 (`55ae99bf…`) and finalized; governance at the base: OK, 41 Work Orders / 102 requirements / inFlight=[] / frontier=['WORK-036'] — the sole eligible frontier, exactly as dispatched via issue #63). Branch: `work/WORK-036-home-work-execution` · **Final head: this doc's commit** (the house two-phase binding — the exact SHA is recorded by the orchestrator in the PR body; the last code commit is `de75d5f`) · Zero merge commits; the merge-base is `5131e70…` exactly.

## Implementation history (the ratchet — every commit compiles and is suite-green at the base)

1. `889bb48` — the journey implementation: the outcome composer (Home + /build/execution) with the optional `attachments` field (parsed/validated into `inputArtifactRefs` on the closed create request) and the honest secondary affordances (competences/templates as disclosed not-yet-exposed states — never fabricated pickers); the proposed-approach review envelope (Purpose / Estimated cost and time — the declared envelope, with the explicit statement that the platform exposes no pre-run estimate / the permission-and-risk envelope in user language / the proposed verification approach, honest that the platform chooses it) with **Run** as the primary action (UX-SCREEN-SPEC-V2 §3's commitment vocabulary); the execution-header **trust strip** (the four axes rendered as four separate facts, AC5); the §11 seven-question **How Zeck did it** panel; the **wait decision surface** (the recorded question, what deciding means, what cancelling means, return-to-work); the honest **failure distinction** — `classifyFailure` derives ONLY from public facts (FAILED ⇒ execution failure; COMPLETED with FAIL checks ⇒ quality failure; the recoverability guidance quotes the recorded reason and states plainly that the dashboard adds no classification of its own); the timeline-default **Activity** with Graph/Events/Raw moved inside one advanced disclosure.
2. `de75d5f` — the proof suites: the work-journey unit suite (20), the journey discriminations D9–D12, the (p)–(r) journeys.
3. This doc (the final head).

## Baseline gate (readiness checkpoint — the exact frozen base, BEFORE implementation)

governance OK (41 WOs, frontier=['WORK-036']) · typecheck 0 · biome clean (962 files) · **full suite with real PG = 276 files / 3833 tests, exit 0** at exactly `5131e70` — the WORK-035 merged baseline reproduced on this environment before any change.

## What changed (the surface diff, every touched file vs `5131e70…`)

Exactly 11 files (all inside the declared surfaces; rg-verified — zero files under `src/`, `sdk/`, `cli/`, `scripts/`, `spec/` (incl. development-state), `migrations/`, `.github/`, or root configs):

- `apps/dashboard/projection.ts` — `ExecutionFormValues.attachments` + `parseAttachmentRefs` (newline/comma-separated ids, hostile tokens rejected by validation — never silently dropped); `buildExecutionRequest` emits `inputArtifactRefs`; `classifyFailure` + `waitQuestion` (the honest derivations).
- `apps/dashboard/components.ts` — `executionHeader` renders the four-axis trust strip; the waiting surface (question + both consequences + return-to-work); the failed surface (dimension + recorded reason + the honest non-classification + safe retry); the `qualityFailureNotice` (the OTHER dimension, never merged); the whyPanel restructured into the §11 answers.
- `apps/dashboard/pages.ts` — the Home composer + secondary affordances; the composer's attachments field; the proposed-approach envelope (review + the create-error path); Run; `FORM_KEYS` carries `attachments` through the hidden fields; the header passes the trust axes; the activity default/disclosure restructure.
- `apps/dashboard/tokens.ts` — the trust-strip, composer-secondary, review-envelope, decision-consequences, failure-dimension and quality-failure CSS (all token-consuming; no one-off hierarchy).
- `tests/unit/dashboard/request-mapping.test.ts` — the attachments mapping/validation pins + the envelope/Run review pins (the inherited assertions updated to the v2 §3 "Run" vocabulary).
- `tests/unit/dashboard/components.test.ts` — the trust-strip pins (four separate facts, no merged verdict) + the header view extended.
- `tests/unit/dashboard/html-escape.test.ts` — the hostile trust-axis labels pass through the escape boundary.
- `tests/unit/dashboard/work-journey.test.ts` (NEW, 20) — the classification/wait/attachment/§11 contract.
- `tests/discrimination/dashboard-journey.discrimination.test.ts` (NEW, 10) — D9–D12.
- `tests/integration/dashboard/journeys.test.ts` — the (p)–(r) journeys + the quality/waiting fixtures + the WhyPanel §11 assertions.
- `docs/work-items/WORK-036.md` (this doc).

No migration claimed (the migration inventory is untouched). No new dependency (the driven-browser playwright harness lives OUTSIDE the repository at /home/z/w036-harness).

## Acceptance-criteria mapping (the Work Order's AC1–AC12)

- **AC1** Home makes outcome entry dominant and prioritizes Attention, active work and recent results over analytics — measured in the driven browser: the composer form is the first form with the outcome textarea; the §6 heading order (outcome → suggested actions → attention → happening now → recent results) is positionally ascending; ZERO chart/canvas/svg elements in main; pinned by the (a) journey and the harness record.
- **AC2** the composer with optional attachments, saved competences or templates without provider/model selection — the attachments field maps to `inputArtifactRefs` (the (p) journey proves the wire request carries them); the competence affordance links to the honest unavailable state; the templates affordance is the honest disclosed not-exposed note; the harness measured `providerSelects: 0`; the request-mapping/work-journey units pin the parsing and the closed-vocabulary mapping (a forbidden key can never be emitted).
- **AC3** purpose, estimated cost/time, permission/risk envelope and proposed verification approach before execution — the envelope's four sections (each a platform fact or an honest absence: "the platform exposes no pre-run cost or time estimate, so none is shown"); pinned by request-mapping + the (p) journey + the harness (both honest branches asserted).
- **AC4** execution detail opens on Result; Evidence and Activity are peer views — unchanged from the foundation and re-pinned ((a), (q), (r), the harness "run" check: `resultTab: "Result"` after the 303).
- **AC5** the header presents status, duration, cost and trust state from platform facts — the facts line + the four-axis trust strip (rendered from `deriveTrustAxes` — platform facts only); pinned by components + the (q) journey + the harness (4 `<li>`, the exact four kinds, "checks passed" in the facts).
- **AC6** progress is a chronological timeline by default; Graph/Events/Raw are advanced views — the timeline renders FIRST; the three advanced views live inside one `advancedDisclosure`; the graph is the honest expert-surface note; the events/raw views carry "Advanced view — …" + "Return to the timeline"; pinned by the (r) journey (nothing graph-shaped renders before the timeline) + the harness (disclosure AFTER the timeline, DOM-ordered).
- **AC7** `How Zeck did it` explains interpretation, capabilities, plan, route, compute and rationale without infrastructure as the default mental model — the panel answers all seven §11 questions; provider/model stay inside the route advanced disclosure + the focused sheet; pinned by components + the work-journey suite + the (a) journey + the harness (all seven true).
- **AC8** WAITING_USER/WAITING_HUMAN provide clear decisions, consequence and return-to-work — the recorded question (when the platform event carries one), what deciding means (resolve through the governed path; the public API exposes no resolve command — stated), what cancelling means (terminal, consequence preview), return-to-work link; pinned by work-journey + the (q) journey + the harness.
- **AC9** consequential actions expose consequence, affected, authorization, cost, reversibility before commitment — the cancel flow's `confirmationCard` (all seven rows before the single governed POST) is unchanged from WORK-035 and still pinned by the (d) journey; the CREATE commitment exposes the envelope before Run (AC3's four understandings + the idempotency disclosure).
- **AC10** failure states distinguish recoverable provider/infrastructure failure from task/quality failure — `classifyFailure` derives the dimension from public facts only (FAILED ⇒ execution; COMPLETED+FAIL ⇒ quality); the execution-failure surface states the distinction and the honest non-classification ("the dashboard does not add its own classification") with the recovery guidance tied to the recorded reason; the quality-failure notice renders the OTHER dimension and the two never appear together; pinned by work-journey (7 tests) + the (q) journey + the harness (both surfaces).
- **AC11** Result → Evidence → Activity preserves context and stays tenant-safe — the tab links preserve the execution id (the route context); the (l) scope journeys still prove the tenant-safety (the bound scope on every scoped read; the cross-scope miss is an indistinguishable 404); D10 re-pins the composer-scope rule.
- **AC12** end-to-end API-backed tests including denial/failed/waiting paths — the (a)–(r) journeys (55) over the REAL server + REAL SDK client against the scope-ENFORCING fake world: the first-execution journey, the failed journey (c), the waiting journey (d), the denial/404 journey (h), the composer journey (p), the trust/failure journeys (q), the activity journey (r).

## The required discriminations (Implementation Requirement 7 — D9–D12, in tests/discrimination/dashboard-journey.discrimination.test.ts)

- **D9 trust-state confusion**: `deriveTrustAxes` returns exactly the four kinds (the merge mutant's single "overall" verdict fails the count and the kind set); `deriveConfidenceChip` refuses empty/FAIL/missing-confidence inputs (the fabrication mutant's "High confidence" differs on the same input — the pin discriminates); the rendered detail keeps four separate `<li>` facts with the honest "No verification results" and no merged-verdict vocabulary anywhere.
- **D10 cross-scope access**: STATIC — no scoped client call site in pages.ts passes any application/query/form argument (the mutant passing `ctx.form.applicationId` is flagged by the same scanner); RUNTIME — a request with a foreign application in the URL query reads through the deployment's bound scope only (every scoped wire call carried the bound application) and the page renders THIS application's execution facts.
- **D11 unsafe command paths**: STATIC — the route table registers exactly the three governed POST routes (create, the legacy cancel alias, the v2 cancel — one handler); the mutant adding `/command` as a POST route is flagged; RUNTIME — direct POSTs to non-command routes are refused (404/405) with ZERO wire mutations; the two governed commands ARE reachable and post to exactly `/executions` and `/executions/:id/cancel`.
- **D12 accidental customer-domain mutation**: RUNTIME — driving every read journey (Home, build, the review GET, runs, detail, tabs, views, agents, attention, command) issues ZERO POST wire calls; every GET wire call carries the bound scope; STATIC — the mutation vocabulary in the journey code is exactly `createExecution` + `cancelExecution` (a `dispatchExternalSideEffect`-style mutant is neither).

## The driven-browser verification record (real Chromium 1.57 over the real createDashboard server + the scope-ENFORCING fake world)

The harness (OUTSIDE the repository — /home/z/w036-harness, playwright 1.57) boots the real `createDashboard` against a fake API world implementing the REAL application-scope wire rule, then drives the canonical WORK-036 journeys. **19/19 checks passed, ZERO console errors and ZERO page errors across the whole session** (screenshots at /home/z/w036-browser-*.png): the Home decision surface (the outcome form first, the §6 order positionally ascending, zero analytics elements, one h1); the composer (the secondary affordances open natively, attachments live, competences/templates honest, zero provider/model selects); the full journey (compose with attachments → the envelope renders the four understandings + the honest estimate framing + Run primary + the attachments carried as hidden fields → Run POSTs the governed create → 303 → the Result view opens with the verification summary visible — the spec §3 completion contract); the trust strip (four `<li>`, the exact four kinds, platform-fact labels); the §11 WhyPanel (all seven questions); the Activity timeline default with the advanced disclosure after it (DOM-ordered) and the honest graph note; the raw-events advanced view with the return link; the wait decision surface (the recorded question, both consequences, return-to-work, the confirmation-gated cancel); the execution-failure surface (dimension, recorded reason, honest non-classification, retry) AND the quality-failure notice (the other dimension — the execution-failure wording absent); keyboard (skip link first stop, brand second, solid 2px visible focus, the composer typeable); tablet 768 (the composer on the 704px full-width surface); mobile 390 (the composer single column, 44px touch minimum, the execution detail keeping Result|Evidence|Activity + the four-fact strip).

## The complete gate (run at the final head, TWICE consecutively green)

`python3 scripts/governance-check.py` (OK) · `bun run typecheck` (0 errors) · `bun run lint` (biome clean, 964 files) · `ZECK_PG_TEST_URL=postgres://postgres@127.0.0.1:55432/postgres bun run test` = **278 files / 3875 tests, exit 0** — run TWICE consecutively green at the exact final head (the 276/3833 baseline + 2 files / +42 tests: work-journey 20, dashboard-journey discriminations 10, the (p)–(r) journeys +9, the attachments/trust-strip/envelope pins across the inherited suites).

## Test inventory (the exact delta)

- NEW unit: `work-journey.test.ts` (20 — the classification 7, the wait 5, the attachments 4, the §11 4)
- NEW discrimination: `dashboard-journey.discrimination.test.ts` (10 — D9 ×3, D10 ×2, D11 ×3, D12 ×2)
- Extended integration: journeys 46 → 55 ((p) ×3, (q) ×4, (r) ×2) + the WhyPanel §11 assertions + the quality/waiting fixtures
- Updated units: components (+2 trust-strip pins, the header views), request-mapping (+2 attachments pins, the Run/envelope pins), html-escape (the hostile axis labels)
- Total dashboard-local: 13 unit files / 185 unit tests + 55 journeys + 10 journey discriminations

## Required checkpoint contracts

- **SELF-HOSTING-BOUNDARY**: the dashboard still imports ONLY `../../sdk` + node builtins; the client script performs ZERO network calls (unchanged, D5 of the foundation suite); no new dependency; every fact remains a live SDK read; the transport scope remains the SDK's bound application scope (D10 re-pins it for the composer surfaces; the (l) journeys still prove the wire).
- **EXECUTION-PROVENANCE**: no new facts — the trust strip renders `deriveTrustAxes` (public wire shapes only); the failure dimension derives ONLY from the execution status + verification results + event payloads; the wait question comes ONLY from the recorded wait event; the envelope's estimates are the declared request constraints (never a platform-estimate fabrication — the text says so); money renders from integer micro-USD strings (BigInt only); the attachments field maps to the wire's `inputArtifactRefs` exactly; no visual primitive manufactures trust or policy facts.

## Required verification mapping (the Work Order's list)

| Required | Evidence |
|---|---|
| governance checker | OK: 41 WOs, 102 reqs, inFlight=[], frontier=['WORK-036'] at the base and at the head |
| typecheck | 0 errors at the base and at the head |
| lint (biome) | clean (964 files) at the head |
| dashboard/unit/integration tests | 187 unit + 55 journeys + 10 journey discriminations |
| API-backed Home → Execution → Result → Evidence smoke | the (a)/(p) journeys over the REAL server + REAL scoped SDK client against the scope-ENFORCING world (the 303 → Result → Evidence chain) |
| trust-state discrimination | D9 + the trust-state suite + the (q) journey + the harness strip check |
| command authorization-path tests | D11 + the command-surface suite + the (f)/(n) journeys |
| responsive browser verification | the harness record (desktop / tablet 768 / mobile 390) |
| keyboard/accessibility verification | the harness record (skip link, brand, visible focus, the typeable composer) + the (k) frame checks |
| secret-exposure discrimination | the html-escape suite (incl. the hostile trust-axis labels) + D5 of the foundation suite + the (k) hostile-query journey |
| full suite twice consecutively at exact final head | the complete gate section above |

## Limitations (honest)

1. The pre-run "estimated cost/time" cannot be a platform estimate — the public API exposes none — so the envelope presents the DECLARED constraints and says so plainly. When a planning/estimate surface ships, its facts feed the same envelope section.
2. The recoverable-vs-task judgment inside an execution failure stays with the recorded reason text (the platform exposes no failure-classification field); the surface quotes the record and states that the dashboard adds no classification — never a guessed "recoverable" badge.
3. The wait's "resolve" action remains outside the public API (the honest no-resolve note, unchanged from the foundation); the decision surface links the governed cancel and the return-to-work path.
4. The composer's competence/template affordances are honest not-yet-exposed states (the authorities are not public); the attachments affordance is the one live secondary input.
5. The driven-browser harness is a session artifact OUTSIDE the repository (the repository stays zero-dependency); its 19-check record and the screenshots are the evidence; the repository's own automated proof is the 252-test dashboard-local suite (187 unit + 55 journeys) plus the 10 journey discriminations.
6. The trust strip's per-axis facts are the same derivations the Evidence tab renders in full (deriveTrustAxes) — compact labels, no new fact source (by design: one derivation, two presentations).
