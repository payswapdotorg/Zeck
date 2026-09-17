# Developer Platform Delivery Report (cumulative)

Program: `zeck-developer-platform` (docs/DEVELOPER-PLATFORM-DEPLOYMENT-ROADMAP.md).
This report is the durable cumulative delivery record required by the Tech Lead
contract. It distinguishes implementation results from environment/provider/
access limitations. Frontier truth lives in
`spec/platform-delivery-state/frontier-state.json`; this report is the human/
agent-readable history behind it.

Report refreshed at: main `96e5db4` (2026-09-18, Tech Lead session B).

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

## Absorbed items

| Item | Absorbed by | Evidence (commit e163d86) |
|------|-------------|---------------------------|
| DEP-021 | DEP-020 | examples-manifest.json: 27 examples covering all 22 workload families with runnable/provider-gated classifications; WORKLOADS.md per-family catalog |
| DEP-022 | DEP-020 | docs/developer/machine/: openapi.json (19 paths), capability-manifest.json, env-vars.json, error-codes.json, examples-manifest.json, integration-recipe.json; AGENT-GUIDE.md + AGENTS.md |
| DEP-023 | DEP-020 | docs/developer/TROUBLESHOOTING.md + AVAILABILITY.md disclosure rules; reopen only if DEP-040/041 trials surface taxonomy gaps |

## Current frontier (main bd0bef8 after the DEP-032 merge, 2026-09-17)

- delivered: DEP-001, DEP-002, DEP-010, DEP-011, DEP-012, DEP-013, DEP-014, DEP-020, DEP-025,
  DEP-030, DEP-032
- in flight: DEP-003 (worker 3-a, Task-tool channel, worktree at base d1faea0; first commit
  777cc06 — plane-identity attestation core + full public-route production smoke with
  wrong-revision/unreachable fail-closed negatives; guardrails.ts + quota-guards additive rows
  in progress)
- eligible: DEP-031 (usage comparison — dispatching now at the post-DEP-032 head; the
  explorer/playground overlap with DEP-032 is resolved since DEP-032 merged first)
- blocked: DEP-033 ← DEP-031 only (030/032 delivered)
- later authorized items awaiting dispatch gating: DEP-033, DEP-040..044

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

## Remaining roadmap

DEP-003 (in flight, worker 3-a); DEP-031 (dispatching at the post-DEP-032 head);
DEP-033 (last P3, gated on 031);
DEP-040..044 (deployment acceptance — after the P3 wave; the DEP-040 live-provider validation needs operator-provided free-tier credentials, the recorded NOT RUN boundary of DEP-001);
DEP-040..044 (deployment acceptance + release gate).
