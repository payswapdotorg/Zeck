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

## Absorbed items

| Item | Absorbed by | Evidence (commit e163d86) |
|------|-------------|---------------------------|
| DEP-021 | DEP-020 | examples-manifest.json: 27 examples covering all 22 workload families with runnable/provider-gated classifications; WORKLOADS.md per-family catalog |
| DEP-022 | DEP-020 | docs/developer/machine/: openapi.json (19 paths), capability-manifest.json, env-vars.json, error-codes.json, examples-manifest.json, integration-recipe.json; AGENT-GUIDE.md + AGENTS.md |
| DEP-023 | DEP-020 | docs/developer/TROUBLESHOOTING.md + AVAILABILITY.md disclosure rules; reopen only if DEP-040/041 trials surface taxonomy gaps |

## Current frontier (main 3111950)

- delivered: DEP-001, DEP-010, DEP-011, DEP-012, DEP-013, DEP-014, DEP-020, DEP-025
- eligible: DEP-002, DEP-003, DEP-030, DEP-031, DEP-032
- in flight: none
- in flight: none (see dead-lane audit below)
- blocked: DEP-002 ← DEP-001; DEP-003 ← DEP-001 + DEP-002
- later authorized items awaiting dispatch gating: DEP-030..033, DEP-040..044

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

DEP-002, DEP-003 (deployment chain — unblocked by DEP-001);
DEP-030, DEP-031, DEP-032 (P3 wave, eligible now; DEP-033 last, gated on 030/031/032);
DEP-040..044 (deployment acceptance — after the P3 wave; the DEP-040 live-provider validation needs operator-provided free-tier credentials, the recorded NOT RUN boundary of DEP-001);
DEP-040..044 (deployment acceptance + release gate).
