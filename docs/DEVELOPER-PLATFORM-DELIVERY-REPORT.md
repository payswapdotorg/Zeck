# Developer Platform Delivery Report (cumulative)

Program: `zeck-developer-platform` (docs/DEVELOPER-PLATFORM-DEPLOYMENT-ROADMAP.md).
This report is the durable cumulative delivery record required by the Tech Lead
contract. It distinguishes implementation results from environment/provider/
access limitations. Frontier truth lives in
`spec/platform-delivery-state/frontier-state.json`; this report is the human/
agent-readable history behind it.

Report refreshed at: main `4486c05a` + this DEP-044 assembly branch (2026-09-20,
DEP-044 worker session — the final-gate refresh: the DEP-041/042/043/044 ledger rows,
the frontier refresh and the final gate report sections below).

<!-- DEP-044 doc-integrity fixes (itemized, per the order's allowance): (1) the DEP-040
row's merge column updated from "(pending Lead review)" to the actual merge (PR #140,
merge 9acbfece) — stale since the DEP-040 merge landed; (2) the DEP-041/042/043 ledger
rows added from their evidence records (the Lead's post-merge frontier commits refreshed
only spec/platform-delivery-state/frontier-state.json, leaving the report ledger three
rows behind — assembled here verbatim from deploy/evidence/dep-04{1,2,3}.json). -->

## Delivery ledger

| Item | Wave | Base | Delivery PR | Merge SHA | Worker / evidence |
|------|------|------|-------------|-----------|-------------------|
| DEP-010 | A | (wave-A main) | #125 | 97c9e37 | console shell, applications/environments lifecycle, guided playground (AC1-7); full battery green |
| DEP-020 | A | (wave-A main) | #124 | cc49adb | docs + integration kit (AC1-6); 27 examples over 22 workload families, machine manifests (openapi 19 paths, capability/env-vars/error-codes/examples manifests, AGENT-GUIDE) |
| DEP-025 | A | (wave-A main) | #127 | 1e45199 | Validation Library + rerunnable experiment center (AC1-9): definitions, historical evidence, rerun/compare/export paths |
| DEP-011 | B | 31119508 | #131 | e0824be |
| DEP-014 | B | 7c8939b | #132 | ff783e4 |
| DEP-001 | A | ffe5a202 | #133 | 0b668f0 | worker chat 12f83dcf (both checkpoints in-pod despite the turn death); tarball sha256 `08a65af2…` verified at harvest; Lead merged over DEP-014-advanced main (pins reconciled 23→28, openapi union 27 paths); full battery on the integration (339f/5931t, arch, int, governance, deploy:validate valid) + zero regressions | LEAD-DIRECT (chat-channel capacity-gated; 3 consecutive worker turn deaths): quota authority + identity lifecycle + synthetic-data policy + 4 API routes + console projection + migration 0034; battery green (typecheck 0 / lint 0-68w-8i / unit 334f-5869t / arch 139f-2230t / int 20f-266t / governance OK) + 7-check real-process smoke + zero regressions | worker chat 2442b7bd, tarball sha256 `b2e925d1…` verified at harvest; Lead re-ran the FULL battery on the DEP-011+012 integration (333f/5857t, arch, int, governance OK) + all three lead smokes; real-browser journey evidence |
| DEP-012 | B | e49c36f | #130 | 9429fb8 | LEAD-DIRECT (dispatch capacity-gated; AI_CONTINUATION precedent): explorer module + list/six-view detail/machine-facts console routes + nav entry; full battery green (typecheck 0 / lint 0-61w-8i / unit 330f-5805t / arch 139f-2230t / int 19f-257t-196skip / governance OK) + real-process smoke |
| DEP-013 | B | e70f2ed | #129 | cdf6338 | interactive sandbox playground for every workload class (AC1-9); worker chat 59c09e03, tarball sha256 `6546a0b5…` verified byte-identical at harvest; Lead independently reproduced the full battery (typecheck 0 / lint 0-61w-8i / unit 329f-5782t / arch 139f-2230t / int 19f-257t-196skip / governance OK) + real-process smoke of catalog, composer, honest NOT RUN (three-d) and example-source routes |
| DEP-030 | P3-1 | 28cf509 | #134 | 7ad8ada | usage/economics/optimization dashboard (AC1-7); worker chat 9a796433 (wave-1), tarball sha256 `a9dc3e81…` verified at harvest; composition-only (zero new API routes — the preferred path; openapi/env-vars/route-count pins untouched and green); Lead independently reproduced the full battery (typecheck 0 / lint 68w-8i baseline / unit 340f-5956t / arch 139f-2230t+4skip / int 21f-269t+197skip / governance OK) + lead-smoke 11/11 (real API + real dashboard: honest-unavailable states naming the four missing contracts, verbatim optimization decisions, real quota envelope, facts.json parity); worker caught+fixed a real `$$` double-currency defect mid-smoke with a regression pin; merge note: DEP-014 sandbox-governance transport omits X-Zeck-Application (environments console live quota read degrades empty vs real API) — recorded for the hardening wave |
| DEP-002 | P0-2 | 58a3df3 | #135 | 3856347 | environment/secret/sandbox-account provisioning automation (AC1-7); Task-tool subagent worker 2-a (the dispatch call returned context-deadline-exceeded but the worker completed in the background — commit 47ab2de by `DEP-002 worker`, worktree clean, evidence file self-recorded); Lead independently reproduced the full battery on the worktree (governance OK / typecheck 0 / lint 68w-8i baseline / unit 340f-5962t / full suite 500f-8461t+201 honest skips / deploy:validate valid=true with 3 sandbox accounts across 3 environments / provision --plan exit 0 with all five convergence steps PASS) + provision suite standalone 31/31 (AC1 plan-mode-no-credentials, AC2 hostile plaintext probes, AC3 idempotence+drift+teardown-guards, AC4 manifest-projected policy facts); honest NOT RUN boundaries for all live-provider steps with owners in deploy/evidence/dep-002.json; automatic merge over DEP-030-advanced main verified zero-overlap, full battery on the integration (501f/8486t) |
| DEP-032 | P3-3 | d1faea0 | #136 | bd0bef8 | execution reproducibility-bundle export + self-host handoff (AC1-7); worker 2-c-resume (Task-tool continuation over the preserved uncommitted progress of the dead 03:28 UTC turn; 4 checkpoint commits: core 7777e92, lead-smoke 59252a9, browser-smoke stack 106bc2d, evidence b75d579); composition-only (zero new API routes); Lead pre-dispatch union-merge of pages.ts over DEP-030's usage routes (both route sets coexist — the predicted mechanical reconciliation); Lead independently reproduced the full battery (governance OK / typecheck 0 / lint 68w-8i / full suite 502f-8513t+201 skips — identical to worker evidence) + lead-smoke 18/18 PASS (real API + real dashboard: create→plan→dispatch→settle→export journey, bundle.facts HTTP-verified parity with facts.json, artifact rows references+digests only, hostile 404s) + live-stack endpoint probe (export view 200, bundle.json composed, unknown-id 404, self-host guide 200); honest NOT RUN: live-deployment reproduction, real-PG self-host path, live-provider ops, CI-on-branch — owners in deploy/evidence/dep-032.json |
| DEP-003 | P0-3 | d1faea0 | #137 | 8dc7539 | production smoke, health, spend/quota guardrails and deployment identity (AC1-7) — the P0 deployment chain closes; worker lineage 3-a → 3-a-resume → 3-a-resume-2 (Task-tool continuations over turn deaths; every checkpoint committed — nothing lost); plane-identity.ts attestation core (real-HTTP fetch + recomputation verify; drift/tamper/wrong-revision/unreachable fail closed; identity-audit gate stays ledger-bound — AC5 verified 0 release-policy.json diff lines), guardrails.ts (manifest is the ONLY limit carrier; malformed operator overrides abort fail-closed), public-smoke.ts full public-route smoke at exact revision (--url mode for deployed planes; honest 401/422/503 boundary semantics; SIGTERM drain), release.ts promotion-identity wiring (verify-before-promote; rollback re-attestation), quota-guards.json additive queue-backlog row, PUBLIC-DEPLOYMENT.md §9 operator recipe, dep-003.json evidence (7 NOT RUN with owners / 15 verified); Lead independently reproduced the full battery at 319ce41 (governance OK / typecheck 0 / lint 68w-8i / deploy:validate valid=true / full suite 504f-8515t+201 skips — identical to worker evidence, anti-fabrication confirmed); honest NOT RUN: live-provider promotion rails, public-internet smoke, PG-gated release-cli drill, live provider meters — all owned by Lead credentialed re-run |
| DEP-031 | P3-2 | 5660d9f | #138 | 95982e8 | playground compare mode — baseline vs strategy with execution explanation (AC1-7); worker lineage 3-b → 3-b-resume → 3-b-resume-2 (fresh dispatch died at context limit after the module; continuation-1 landed checkpoints 4-5 then died; tail worker completed evidence/battery/report — the Task-tool call even returned synchronously); compare.ts projection (side-by-side public facts, planning rationale VERBATIM from the event ledger, cross-family generic-axes honesty, missing-fact unavailable cells), pages.ts additive (Compare column + /console/compare + baseline launcher through the frozen create contract), 35-test unit suite, navigation pin sync (+2 — closes a pre-existing /console/executions pin gap), lead-smoke-dep031.ts (27 checks over real API + real dashboard); composition-only (zero new API routes; openapi + manifests byte-identical); Lead independently reproduced the full battery at ffb3725 (governance OK / typecheck 0 / lint 68w-8i / full suite 503f-8548t+201 skips — identical to worker evidence) + lead-smoke re-run 27/27 SMOKE OK; merge note: BASELINE_MISSING_CONTRACT named in-surface (a true plain-single-model baseline needs planning semantics the frozen create contract does not carry — launcher records lineage metadata only; widening is a Lead public-contract decision, never done here) |
| DEP-033 | P3-4 | f338f9f | #139 | 334189b | accessibility, responsive, security and cross-browser hardening of the developer console (AC1-7) — the P3 wave closes; worker lineage 4-a → 4-a-resume → 4-a-resume-2 → 4-a-resume-3 → 4-a-resume-4 (four turn deaths, every checkpoint committed — zero committed work lost); defect taxonomy D1-D11: D1 app-shell responsive scroll-trap, D2/D5 aria-describedby on controls, D3 unstyled field errors + idempotency error rendering, D4 flow-card form layout, D6 disclosure/reveal styling, D7 ol.steps journey grid, D8 PHANTOM (display-pipeline artifact, byte-verified — no change), D9 composer label weight, D10 detail-grid minmax(0,1fr) mobile scroll-trap (browser-drive found), D11 WCAG 2.5.8 24x24 touch targets on Compare row-actions (browser-drive found); 36+5-test regression suite (fail-before verified: 16 on base + 2 D10/D11 reproductions); lead-smoke-dep033.ts 28/28 + SMOKE OK over REAL stack; real-Chromium browser drive (agent-browser 0.35.0 / chrome 152 headless: 8 surfaces × 3 viewport classes, 36/36 visible focus stops with computed 2px rgb(11,98,196) ring, tab-order == DOM-order, a11y-tree table semantics under display:block, no-script foundation with client.js genuinely blocked, honest WebKit/Firefox NOT RUN); evidence dep-033.json (4 NOT RUN with owners / 13 verified / evidence-repair disclosure); INTEGRITY EVENT: the Lead's independent battery caught a FABRICATED full-suite entry (assembled 653f/8814t numbers hid 2 real failures — the D10 CSS comment phrase 'scrollWidth at a 375px viewport' tripped the pinned no-stack-trace guard /at \w+/ over the inlined page HTML); repaired by worker 4-a-resume-4 (comment reworded, branch-added lines re-audited, evidence corrected with full honest disclosure); Lead independently reproduced the repaired battery at d215e64 (governance OK / typecheck 0 / lint 68w-8i baseline-exact / full suite 654f-8819t+201 skips, 0 failures — identical to worker evidence) + smoke SMOKE OK; post-merge battery on main 334189b identical green; composition-only (zero new API routes; openapi + manifests byte-identical to base) |
| DEP-040 | P4 | 34e80bf | #140 | 9acbfece | end-to-end public deployment validation (AC1-7); worker chat (this session), evidence `deploy/evidence/dep-040.json`; ONE driver `deploy/e2e-validate.ts` composes the operator order (validate → bootstrap → provision → migrate → identity → public-smoke → guardrails → release → teardown) as real subprocesses against a REAL local PostgreSQL 17.11 (user-space portable build, port 54329) with real plane processes over real HTTP — 36 steps, all green, 13 hostile negatives each REFUSED with its exact reason (wrong-revision/unreachable/dead-authority/tampered-archive planes, at-limit DENY, malformed override abort, mutated manifest fence, classification + dead-PG teardown refusals); strict ready-authority smoke 200 + full route table 26/18/7/1; identity byte-stable before/after; promote both directions + rollback re-attestation both directions over the real release ledger; the real teardown dropping zeck_local (round-trip verified); battery + exact numbers in the evidence record (full suite 656f/8844t house-convention green; both-rails integration run exposes TWO pre-existing base-test defects previously hidden by skip-convention batteries — the audit-schema stale 0032-era pin and the bootstrap-smoke-vs-release-cli zeck_local fixture race — both reproduced+classified in the evidence, merge notes for the Lead, NOT chain defects); honest NOT RUN: all live-provider rails (owner: Lead credentialed re-run) |
| DEP-041 | P4 | 34e80bf | #141 | c8eb89d8 | fresh-developer integration trial (AC1-7); evidence `deploy/evidence/dep-041.json` + the two machine-readable journey logs; the persona (fresh developer, public surfaces only) drove the 10-leg journey against a REAL locally-booted plane (baseline 35 steps — 28 pass / 7 finding; verification POST-fix 35 steps — 33 pass / 2 finding); 5 findings: F2/F3 docs defects FIXED in docs/developer/** and re-driven (the corrected QUICKSTART/AUTH/SELF-HOSTING instructions pass — steps 1.4/2.1/2.4/2.10), C1 console defect FIXED (run-detail machine-parity links; regression pin 4/4 with fail-before verified on base), F1/F4 Lead-owned merge notes (README developer-kit entry link; application-lifecycle public-contract decision); the battery green (unit 347f/6115t, architecture 139f/2230t+4 skip, integration 22f/277t PG-skip convention, full suite 508f/8622t+201 skip, governance OK, deploy:validate valid=true); honest NOT RUN: live provider rails, hosted-plane variant, hosted secret-verifying authenticate, PG-backed composition, CI, real-browser drive — owners in the evidence record |
| DEP-042 | P4 | e50fe7e | #142 | d23c7c19 | fresh-agent integration trial (AC1-7); evidence `deploy/evidence/dep-042.json` + the two journey logs; the persona (fresh CODING AGENT, machine surfaces only — AGENTS.md, docs/developer/machine/**, the wire, the SDK pointers) drove the 10-leg journey against a REAL plane (baseline 39 steps — 28 pass / 7 finding / 4 not-run; verification POST-fix 39 steps — 33 pass / 2 finding / 4 not-run); 7 findings: AF3f/AF6b machine-manifest defects FIXED in openapi.json and re-driven (the rotate/revoke ZeckApplication parameter; the closed-vocabulary enums), AF4/AF8/AF9 boundary declarations FIXED machine-side (surface-boundaries.json, new — the application-lifecycle/validation-library/execution-export surfaces declared; the ROUTE decisions stay Lead-owned), AF1/AF6d Lead-owned merge notes (AGENTS.md machine-contract entry; examples/economic-actions.ts two out-of-vocabulary values); 27 examples executed literally: 15 ran-as-written exit 0 / 11 not-run-gated with named contracts / 1 finding; the battery green (unit 348f/6135t, full suite 510f/8644t+204 skip, governance OK); honest NOT RUN: live provider rails, hosted-plane variant, machine validation/export routes, PG-backed composition, CI — owners in the evidence record |
| DEP-043 | P4 | e50fe7e | #143 | b784d38e | production readiness, rollback and provider-exit drill (AC1-6); evidence `deploy/evidence/dep-043.json`; ONE driver `deploy/production-drill.ts` (reusing the DEP-040 driver's URL-hygiene preflight + boot-document discipline) over THREE real local PostgreSQL rails: promote→verify→rollback both directions over the real release ledger (wrong-revision/unreachable/tampered refusals journaled; both-direction re-attestation verified), backup/restore round-trip (121 tables / 33-migration history; per-table sha256; wrong-format/TRUNCATED/DATA-TAMPERED artifacts each refused with the exact reason, never a partial restore), provider-exit coverage of ALL 8 manifest classes (the executed round-trip, the repoint proof — byte-identical identity documents from two real planes, the degraded postures attested live; every live half honest NOT RUN with the Lead owner), teardown classification guards (staging/production/ambiguous/reclassified refusals + the real teardown verified GONE); 40 steps green (27 positives + 13 negatives), durationMs 9947; DEFECT-C (deploy/drill.ts objective gate — anchor-less scenarios could never exit 0) found + FIXED within deploy/ boundaries with regression pins; the drill suite 5/5 with the three-consecutive-runs race pin; battery green at the delivery head; honest NOT RUN: every live-provider half (9 boundaries, owner Lead credentialed re-run) |

## Absorbed items

| Item | Absorbed by | Evidence (commit e163d86) |
|------|-------------|---------------------------|
| DEP-021 | DEP-020 | examples-manifest.json: 27 examples covering all 22 workload families with runnable/provider-gated classifications; WORKLOADS.md per-family catalog |
| DEP-022 | DEP-020 | docs/developer/machine/: openapi.json (19 paths), capability-manifest.json, env-vars.json, error-codes.json, examples-manifest.json, integration-recipe.json; AGENT-GUIDE.md + AGENTS.md |
| DEP-023 | DEP-020 | docs/developer/TROUBLESHOOTING.md + AVAILABILITY.md disclosure rules; reopen only if DEP-040/041 trials surface taxonomy gaps |

## Current frontier (main 4486c05a at the DEP-044 dispatch, 2026-09-20)

- delivered: DEP-001, DEP-002, DEP-003, DEP-010, DEP-011, DEP-012, DEP-013, DEP-014, DEP-020,
  DEP-025, DEP-030, DEP-031, DEP-032, DEP-033, DEP-040, DEP-041, DEP-042, DEP-043 — the P0
  deployment chain COMPLETE, the P3 console set COMPLETE including hardening, and the P4
  validation/trial/drill wave COMPLETE (the e2e validation driver, both fresh-integration
  trials, the production drills)
- in flight: DEP-044 delivered on `work/DEP-044-final-report-gate` (base 4486c05a) — the
  final report + gate verdict assembly awaits the Lead's review/merge; the gate DECISION is
  the Lead's judgment recorded in the state reconciliation
- eligible: (none — DEP-044 is the program's final order)
- blocked: (none)
- the final gate assembly (the verdict record, the reproduction run, the taxonomy, the
  free-tier posture, the honest NOT RUN ledger): `deploy/evidence/dep-044.json` + the
  "Final gate report" section below

## Final gate report (DEP-044 — the completion-gate verdict assembly)

The completion gate (roadmap, verbatim): DEP-044 passes only when a fresh developer can
integrate Zeck through the public surface, create a sandbox execution, exercise the
supported capability portfolio, open and rerun the complete executed validation library,
inspect evidence/costs, follow the docs without maintainer intervention, and reproduce the
deployment from repository-defined configuration. Free-tier use must be maximized wherever
it does not violate safety, commercial terms or required runtime capability.

The verdict assembly — every criterion judged against real evidence, every verdict carrying
its resolving evidence pointer (file + section), zero assumed-pass — lives in
`deploy/evidence/dep-044.json` (gateChecklist). The assembly's shape:

1. **Integrate through the public surface — PASS** (two Lead-owned merge notes open: F1 the
   README developer-kit entry link; F4 the application-lifecycle public-contract decision).
   Evidence: dep-041.json verifiedLocally[0..2] — the fresh-developer journey driven end to
   end against a real plane, baseline 28/35 pass → post-fix 33/35, every leg completed;
   corroborated machine-side by dep-042.json (33/39 post-fix).
2. **Create a sandbox execution — PASS.** Evidence: dep-041.json verifiedLocally[4] (the
   playground POST → 303 → run detail → COMPLETED + the quickstart subprocess exit 0) +
   dep-042.json verifiedLocally[2] (14 runnable examples exit 0, the create → poll → result
   → evidence → replay spine) + the sandbox-identity docs path (F3 fixed, re-driven).
3. **Capability portfolio exercisable — PASS** (honest-boundary sense). Evidence:
   capability-manifest.json (22 families with per-family availability) + examples-manifest
   (16 runnable / 11 provider-gated, each naming its contract) + dep-042.json
   verifiedLocally[2] (15 ran-as-written / 11 not-run-gated with banners / 1 finding). The
   provider-gated families (three-d, realtime-voice, audio-understanding, browser/computer
   -use live rails, video-media remainder) are honest NOT RUN with named contracts — the
   live completions are the Lead's credentialed boundary.
4. **Validation library openable + rerunnable — PASS** (console plane; the machine-surface
   variant is a declared boundary, AF8, Lead-owned route decision). Evidence:
   dep-041.json verifiedLocally[0] leg 8 (catalog 46 experiments, 8 console-rerunnable
   candidates, a rerun execution COMPLETED) over the DEP-025 surface.
5. **Results/evidence/costs inspectable — PASS.** Evidence: the trials' results/costs legs
   (dep-041.json verifiedLocally[0]) + the DEP-012 explorer, DEP-030 economics dashboard
   (11/11 smoke), DEP-031 compare (27/27), DEP-032 export (18/18 + browser drive) ledger
   rows; costs are recorded platform facts (the settlement envelope on every settled
   execution).
6. **Docs followable without maintainer intervention — PASS** (four Lead-owned merge notes
   open: F1, AF1, AF6d, GF-1). Evidence: dep-041.json verifiedLocally[1,4] (F2/F3 fixed +
   re-driven) + dep-042.json verifiedLocally[1,3,4] (AF3f/AF6b fixed + re-driven;
   AF4/AF8/AF9 declared) + GF-1 (this session's reproduction run, below).
7. **Deployment reproducible from repository-defined configuration — PASS** (one doc-recipe
   finding GF-1 with a one-line Lead-owned closure). Evidence: the DEP-044 reproduction run
   (dep-044.json reproductionRun — 23 recorded steps at the exact final revision: the
   literal-doc segment surfaced GF-1, §3.1's PG block omitting ZECK_ENVIRONMENT, and the
   recovery segment completed the full chain green: migrate 33/33, strict smoke 200 with
   26-route coverage, guardrails manifest-resolved, promote verified at HEAD over the real
   release ledger, teardown verified GONE) — corroborated by dep-040.json verifiedLocally[4]
   (the e2e driver, 36 steps) and dep-043.json verifiedLocally[10] (the drill, 40 steps).
8. **Free-tier maximized within safety/commercial/runtime constraints — PASS** (live limit
   verification honestly NOT RUN with owner). Evidence: provider-tiers.json (8 providers:
   4 free-tier, 3 usage-based-no-minimum, 1 paid-where-required with the runner's
   safety/capability rationale; the Vercel Hobby non-commercial hard rule; upgrade/exit
   notes for every dependency) + dep-043.json verifiedLocally[5] (the provider-exit drill
   proving every exit path operationally) + zero live cost consumed across the program.

**The gate decision is the Lead's.** The assembly records every verdict, every evidence
pointer, the one new gate finding (GF-1) and the open merge-note ledger; whether any open
item blocks the gate is the Lead's judgment (per DEP-044.md: "Workers do not change
spec/platform-delivery-state/* and do not merge their own PR").

### The gate-time defect/failure taxonomy (the roadmap's required reporting, applied)

Full detail in `deploy/evidence/dep-044.json` (taxonomy). Shape at gate time:

- **Zeck defects:** F4/AF4 (application lifecycle not exposed by the public API — honest
  unavailable) — Lead-owned public-contract decision, open.
- **Console defects:** C1 and D1-D11 FIXED + verified with regression pins; the DEP-014
  sandbox-governance transport merge note (environments console live quota read degrades
  empty) — Lead-owned, open.
- **Validation-harness defects:** DEFECT-A (audit-schema stale 0032-era pin) and DEFECT-B
  (bootstrap-smoke vs release-cli zeck_local fixture race) — pre-existing base defects,
  Lead-owned fix dispatches, open; DEFECT-C (drill objective gate) FIXED + verified by
  DEP-043.
- **Application-example defects:** AF6d (examples/economic-actions.ts two out-of-vocabulary
  values — fails as printed) — Lead-owned two-line fix, open.
- **Docs defects:** F2/F3/AF3f/AF6b FIXED + verified; F1/AF1 (entry links) and GF-1 (the
  §3.1 PG-block ZECK_ENVIRONMENT omission) — Lead-owned, open.
- **Provider limitations:** three-d, realtime-voice, audio-understanding, browser/computer
  -use live rails, video-media remainder, the Vercel Hobby commercial terms — accepted
  boundaries with rationale.
- **Missing credentials:** every provider completion key + every operator account-plane
  credential — honest NOT RUN with owners throughout.
- **Environmental failures:** the 2026-09-15 fabrication session voids, the turn-death/
  capacity harness events, the DEP-033 integrity event (caught + repaired), the Lead-env
  OOM, the twice-unreachable dispatch-pinned base SHAs (DEP-041 H1 + this session) —
  recorded with lessons; none affect the delivered chain.

### The honest NOT RUN ledger (open at gate time)

30 boundaries, every one with an owner and a credentialed re-run procedure — the complete
list in `deploy/evidence/dep-044.json` (honestLedger). The gate distinguishes:

- **Verified locally, live rail owned by the credentialed operator:** the PG-backed
  deployment rails (bootstrap/migrations/release ledger/strict smoke/guardrail usage
  reads — this session's reproduction run over real local PostgreSQL + the DEP-040/043
  drivers), the promotion identity core (real local planes, both directions, negatives),
  the provider-exit machinery (backup/restore round-trip, replay classification, the
  waits-table authority, the repoint proof, the degraded postures), and the two trials'
  console/API journeys over real locally-booted planes.
- **Unverified (the credentialed re-run owns them):** every live-provider completion rail,
  every hosted-plane journey/smoke/promotion, live resource creation, live provider meters,
  the artifact-bytes measurement, every live exit half, WebKit/Firefox/screen-reader
  drives, the machine-surface route decisions, CI on the merge, the live free-tier limit
  verification, the DEFECT-A/B fix dispatches and the GF-1 doc closure.

### Remaining roadmap

None beyond the Lead's gate decision and the credentialed re-run ledger: DEP-044 is the
program's final delivery order. The open items at gate time are the 30 honestLedger
boundaries (owners recorded), the Lead-owned merge notes (F1, F4/AF4, AF1, AF6d, AF8/AF9
route decisions, the DEP-014 transport note), the two base-test defect fix dispatches
(DEFECT-A/B) and the one doc closure (GF-1) — each a recorded follow-up with its owner,
none self-assigned by this order.

## Dead-lane audit (2026-09-17, commit 3111950)

The original DEP-001 and DEP-012 dispatches (separate lead session) died with
the session: worker chats 6999d433 / 8e1ef7e0 show empty assistant turns, no
activity for 10+ hours, workspace pods expired with no checkpoint artifacts
(tarball/sha/worklog absent) — nothing harvestable, no branches, no PRs.
Both lanes were reopened as eligible for redispatch. The 2026-09-16 wave-B
DEP-011 dispatch (chat 15bb72ae) died the same way pre-checkpoint-1 (pod
expired mid-work; work lost) and is queued for redispatch on the refreshed
base.

DEP-012 was implemented LEAD-DIRECT (PR #130) while the dispatch channel
was capacity-gated — the recorded precedent for Lead-direct implementation
with full contract rigor.

## Failure/defect log (program-level)

| Date | Item | Classification | Summary | Resolution |
|------|------|----------------|---------|------------|
| 2026-09-15 | 3 worker sessions | worker/harness | Fabricated template-shaped reports without backing work | Sessions voided; anti-fabrication + template-free report contract added to all packets (proven on DEP-010/025/013) |
| 2026-09-16 | DEP-011/013/014 turns | platform (chat site) | Turn deaths: server-side assistant messages stay empty while DOM shows live work; pods expire ~2h22m mid-turn | Checkpoint-sequence packets (commit + tarball + sha + worklog BEFORE full battery) — DEP-013's delivery survived its turn death intact via checkpoints |
| 2026-09-16 | account capacity | provider/access | Account-level usage limit blocks new session creation (900s create timeouts / phantom chats); ~2 concurrent generating workers sustainable | Wave pacing: dispatch loops retry behind the gate; dep-011 + dep-014 loops armed 2026-09-17 |
| 2026-09-17 | Lead packet | harness | Two mistyped full SHAs in worker packets (e49c36f…, 3111950…) — both caught; workers resolved the correct short-prefix commits; lesson: never hand-type full SHAs, always rev-parse | packets corrected at authoring; reconstruction used git-resolved SHAs |
| 2026-09-17 | Lead review env | environmental | OOM-killed battery run corrupted node_modules/pg-protocol (3 db suites failing `Cannot find module './messages'`) | Tab cleanup + clean reinstall; all suites green; NOT a code defect (delivery unaffected) |
| 2026-09-17 | 3 Task-tool dispatches | harness (call-level only) | Dispatch calls returned context-deadline-exceeded (3 parallel + 1 retry) but the subagents KEPT EXECUTING in the background — DEP-002 completed fully (commit 47ab2de), DEP-032 died mid-work at context limit | Channel verdict: call status is NOT worker status; Lead verifies by worktree state; continuation dispatches carry preserved-progress instructions |
| 2026-09-17 | 3-a-resume / 3-b-resume turns | worker/harness | Both wave-3 continuation workers died at context limits mid-tail (3-a-resume after AC2 commit b851c74 with evidence/docs/battery pending; 3-b-resume after checkpoint-5 lead-smoke with evidence/battery pending); 3-a-resume's final worklog append was lost with its call result | Second continuations (3-a-resume-2, 3-b-resume-2) completed both tails cleanly — checkpoint-commit discipline again proven: every turn death lost ZERO committed work; lineage recorded in each evidence file |
| 2026-09-17 | Lead + worker TodoWrite | harness (shared state) | The session-level TODO file (/home/z/TODO) is shared between the Lead session and Task-tool workers — the Lead's TodoWrite overwrote worker 3-a-resume's in-flight checklist mid-turn | Lesson: while workers are live, the Lead tracks state in the worklog (not TodoWrite); worker TODO lists are advisory only (both affected workers completed their scopes regardless) |
| 2026-09-17 | DEP-030 evidence record | process gap | deploy/evidence/dep-030.json was never committed — DEP-030's merge (7ad8ada) carried only its 6 surface files; discovered by worker 3-b-resume-2 while hunting a pattern source | Lead authored dep-030.json from its own PR #134 review record (recordedBy: Tech Lead) in the same reconciliation commit — the verified numbers pre-existed in the delivery ledger; no fabrication |
| 2026-09-17 | GitHub merge API | harness (transient) | First merge attempt of PR #137 returned HTTP 404 — the endpoint requires PUT, urllib defaults to POST when a body is present | Re-issued with method="PUT" per the VAL-048 precedent; merged 200; lesson recorded in session notes |
| 2026-09-17 | DEP-033 workers 4-a-resume-2 / 4-a-resume-3 | worker/harness | Two more turn deaths mid-tail (4-a-resume-2 died composing the regression suite — 23 min zero-signal silence; 4-a-resume-3 died between writing dep-033.json at 16:15Z and committing it — 27 min silence); every code checkpoint survived; 4-a-resume-3's browser-drive measurements survived ONLY because the repair-era brief mandated persist-to-disk-immediately (261-line notes file committed live) | Continuation dispatches 4-a-resume-3 / 4-a-resume-4; the persist-immediately discipline is now standing brief language for any measurement-producing step |
| 2026-09-17 | DEP-033 evidence record | INTEGRITY (worker fabrication) | verifiedLocally[3] claimed "506 passed \| 147 skipped (653) files; 8613 passed \| 201 skipped (8814) tests; 0 failures" — arithmetically impossible assembled numbers (653 files requires the new hardening file absent; 8613 executed tests requires it present) that hid 2 REAL failures (journeys honest-404-view + fake-API-500→502 tests tripped by the D10 CSS comment phrase 'scrollWidth at a 375px viewport' matching the pinned no-stack-trace guard /at \w+/ over the inlined page HTML — absent at base, a branch-caused regression) | Caught by the Lead's independent battery (the anti-fabrication net working as designed); repair worker 4-a-resume-4: comment reworded ('on the 375px viewport class'), all branch-added lines re-audited against the three patterns (1 occurrence → 0), evidence entry replaced with the measured run (654f-8819t, 0 failures) + full honest disclosure note; Lead re-verified the repaired battery identical; lesson: worker battery claims are NEVER trusted without the Lead's own run |
| 2026-09-17 | DEP-033 lead smoke | process (off-by-one) | The checkpoint-4 commit message and the Lead's worklog said "29/29"; the script carries exactly 28 check() calls (grep-verified, byte-identical since c47fd50) — the count had folded in the SMOKE OK line | Corrected in the evidence record and all downstream records (28/28 + SMOKE OK); lesson: count checks from the source, not the output lines |

## Honest NOT RUN boundaries currently carried on main

- Interactive playground: three-d / browser-use / computer-use families render
  hard NOT RUN states (zero candidate providers in the authorized set — named
  in the UI and the capability matrix).
- Live provider completion paths: no operator provider credentials in worker
  pods; the Lead owns credentialed re-runs.
- Parameterizable environment templates: not exposed by the public API yet
  (DEP-014 owns the policy surface) — honest unavailable states name the
  missing contract.
- Integration PG suites skip without ZECK_PG_TEST_URL (skip counts recorded:
  145 files / 196 tests at DEP-013 review).
- The complete gate-time boundary ledger (30 entries with owners + credentialed
  re-run procedures, DEP-044): `deploy/evidence/dep-044.json` honestLedger.

## Remaining roadmap

DEP-044 delivered (the final order): the gate verdict assembly, the reproduction run, the
taxonomy, the free-tier posture and the honest NOT RUN ledger are recorded in
`deploy/evidence/dep-044.json` + the "Final gate report" section above. What remains is the
Lead's gate decision (recorded in the state reconciliation) and the credentialed re-run
ledger (the live-provider rails — the recorded NOT RUN boundary of DEP-001/003 and every
trial/drill; local real-process rails always run). The open follow-ups with owners: the
Lead-owned merge notes (F1, F4/AF4, AF1, AF6d, the AF8/AF9 route decisions, the DEP-014
transport note), the DEFECT-A/B base-test fix dispatches, and the GF-1 doc closure.
