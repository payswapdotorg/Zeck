# Zeck — LLM Architect Handoff

**Purpose:** This document is the durable, repository-resident handoff for a fresh LLM Architect. It is authoritative guidance for recovering the current engineering state without conversation history. Conversation history is never a source of truth.

## Current repository state

- Repository: `pectoraux/Zeck`
- Architecture: **v1.0**, frozen after approval.
- Current `main`: `017e44f41eab9ce7a458843d39a38c895ba79800`
- Current W041 worker branch: `work/WORK-041-ux-integration-hardening-release-gate`
- Current W041 worker branch head: `017e44f41eab9ce7a458843d39a38c895ba79800`
- `main` and W041 worker branch are therefore the same commit at handoff: **0/0 ahead/behind**.
- Frontier: `eligible=[]`, `inFlight=["WORK-041"]`, `blocked=[]`.
- Active Work Order: `spec/work-orders/WORK-041.md`.
- Active issue: **#73**, `WORK-041 — UX integration hardening, usability and release gate`.
- Assurance: **HIGH_ASSURANCE**.

### Dispatch-history nuance that must not be “fixed”

`017e44f41eab9ce7a458843d39a38c895ba79800` is the final dispatch-state commit and has parent `bcc46ee402da33ca478d7cb860352c28b97b1080`. Its commit message is `chore(governance): bind WORK-041 to dispatch pin` and its only file change is the W041 Work Order's binding-base text. The Work Order's Dispatch Record therefore names `bcc46ee402da33ca478d7cb860352c28b97b1080` as the binding exact base, while the **operational branch/main starting point is the final dispatch commit `017e44f…` itself**. This is intentional history, not a repository inconsistency.

Do not move `main`, recreate the branch, or rewrite the Work Order merely to make those two SHAs equal. The worker branch is correctly pinned to the final dispatch state.

## Completed UX wave

The UX v2 roadmap is serialized through W041:

- W033 — UX shell/dashboard realization — complete
- W034 — API/SDK application-scope reconciliation — complete
- W035 — experience foundation and interaction system — complete
- W036 — Home, Work creation and execution — complete
- W037 — Build, agents, deployments and workloads — complete
- W038 — Trust, evidence, artifacts and competence — complete
- W039 — Control, spend, connections and improvement — complete
- W040 — Advanced inspection and multimodal work — complete
- **W041 — UX integration hardening, usability and release gate — in flight**

W040 was accepted and merged as PR **#72**, with merge commit beginning `64bc1b11`. Its implementation/evidence records are preserved in `docs/work-items/WORK-040.md` and the development-state ledgers.

## W041 mandate

The only authorized implementation is the final UX v2 integration/release gate defined by `spec/work-orders/WORK-041.md`.

### Objective

Consolidate the complete UX v2 realization into a coherent production-quality product and prove that the accumulated surfaces behave as one system across navigation, Work, Build, Trust, Control, Improve, and advanced modality views.

### Allowed scope

- Cross-route consistency fixes.
- Navigation/context restoration.
- Loading, empty, error, and permission-state consistency.
- Responsive breakpoint refinements.
- Keyboard, screen-reader, and focus refinements.
- Visual hierarchy and density corrections.
- Performance improvements that do not alter domain semantics.
- End-to-end journey stabilization.
- Browser/visual verification harnesses and evidence.

### Forbidden scope

- New product domains or major feature surfaces.
- Backend module changes.
- New execution, policy, budget, verification, or tenant authority.
- Client-side registries/caches used as truth.
- Raw credentials/secrets.
- Architecture changes.
- Requirement ownership changes.
- Worker self-merge.

### Non-negotiable architecture invariants

- Dashboard remains a projection over public API/SDK authorities.
- Execution/Work semantics remain canonical across all modalities.
- UX v2 remains outcome-first with progressive disclosure.
- Trust claims remain evidence-backed.
- Consequential actions remain governed and consequence-aware.
- Expert depth must remain available without contaminating default flows.

## Required W041 verification

Before Architect acceptance, independently verify the worker's evidence against the actual final PR head. Required proof includes:

1. `python3 scripts/governance-check.py`.
2. `bun run typecheck`.
3. `bun run lint`.
4. Dashboard/unit/integration tests.
5. Complete primary-journey browser verification.
6. Desktop/tablet/mobile responsive verification.
7. Keyboard and screen-reader accessibility verification.
8. Trust/error/permission regression verification.
9. Command/action authorization-path tests.
10. Secret-exposure discrimination.
11. Performance sanity checks.
12. Full suite **twice consecutively at the exact final head**.
13. Exact changed-file inventory, including explicit confirmation that no forbidden surface changed.
14. Exact branch/base ancestry, zero worker merge commits, and worker did not merge its own PR.

The Architect must review the actual diff rather than trusting the worker's written summary. Evidence is valid only for the exact revision it names.

## Governance loop after W041 submission

When the worker opens a PR:

1. Verify the PR targets `main` and its merge-base is the exact dispatch base `017e44f41eab9ce7a458843d39a38c895ba79800` unless the repository's governance records explicitly show a later Architect-only state commit that became the binding base.
2. Cross-check the PR changed-file list against the Work Order's declared surfaces.
3. Inspect the complete diff for authority/transport/secret/architecture violations.
4. Verify CI and the worker's exact-head evidence.
5. Independently rerun or obtain the required evidence wherever possible.
6. Approve only after all acceptance criteria and checkpoint contracts pass.
7. Merge only as Architect.
8. After merge, finalize `spec/development-state/program-state.json`, `frontier-state.json`, and `checkpoint-state.json` against the **actual merge identity**.
9. Update the completed Work Order/evidence record if required by the state model.
10. Close issue #73 only after post-merge finalization is complete.
11. Re-run the governance checker after state finalization.
12. Only then determine whether any successor Work Order exists. W041 is the current final roadmap item; do not invent W042 without a formal architecture/work-order decision.

## Canonical repository recovery order

A fresh Architect should recover state in this order:

1. `AGENTS.md`
2. `AI_CONTINUATION.md`
3. `README.md`
4. `IMPLEMENTATION.md`
5. `spec/worker-runbook.md`
6. `docs/ARCHITECT-RUNBOOK.md`
7. `spec/architecture.md`
8. `spec/architecture-lock.md`
9. All four files under `spec/development-state/`
10. `spec/requirement-traceability.md`
11. Relevant ADRs
12. Current Work Order(s), especially `spec/work-orders/WORK-041.md`
13. Current GitHub refs, open PRs/issues, and CI
14. `python3 scripts/governance-check.py`

## Repository truth hierarchy

When sources disagree, prefer them in this order:

1. Actual Git refs and commit ancestry.
2. Repository-resident development-state JSON.
3. The frozen architecture and architecture lock.
4. The active Work Order.
5. Verified CI/test/browser evidence bound to exact revisions.
6. Other repository documentation.
7. Conversation history — **never authoritative**.

## Important lessons from W037–W040

### Evidence/file-count discipline

Whenever a worker reports a changed-file count, independently compare both:

- `git diff --name-only <exact-base>..<exact-head>`
- GitHub's PR changed-file listing.

Do not accept an evidence package whose count or breakdown differs from either source.

### Worker-owned development state is forbidden

Implementation branches must not modify `spec/development-state/*` during active work. Shared development state is Architect-owned.

### Authority boundaries

- Policy remains the authorization boundary.
- Economic/accounting truth remains owned by the platform authorities.
- BYOK credentials remain secret-mediated.
- Learning remains advisory and cannot become authorization.
- Edge hard-real-time safety remains local where required.
- Modality surfaces inspect recorded facts; they do not create alternate lifecycle or policy semantics.
- Browser/UI state is ephemeral and non-authoritative.

### Fail-closed behavior

A missing record may be rendered honestly as absence. An authorization/scope/transport failure must not be silently converted into absence. Errors outside the explicitly handled not-found cases must remain observable.

### Exact-head evidence

A green check on an earlier commit is not proof for a later commit. Treat the exact final head as the verification identity for every gate.

## Known W040 architectural follow-up context

During W040 implementation review, a fail-closed defect was identified in the deployments session read path: catching every `listEvents()` failure and converting it to an empty result would have hidden application-scope/auth failures. That issue was remediated before acceptance/merge. The lesson remains a standing review rule for W041 and all future work: **only explicitly recognized absence should collapse to an empty presentation; authorization/scope/transport failures must propagate.**

## Completion boundary after W041

W041 is the final currently-defined UX v2 Work Order. After W041 is accepted and finalized, the Architect must re-derive the frontier from repository state rather than assuming a next implementation item. There is no authorized W042 in the current roadmap.

A future successor must therefore either:

- conclude the implementation wave and leave the repository in a completed state, or
- formally create/approve a new architecture/work-order generation before implementation proceeds.

## Fresh-session invariant

A competent fresh LLM Architect must be able to continue from this repository using these artifacts, Git history, and live GitHub state without any prior conversation transcript.
