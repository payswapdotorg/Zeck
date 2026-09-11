# Zeck — Stateless AI Continuation Contract

This repository is designed to be recoverable by a fresh LLM Architect, Tech Lead or implementation session without conversation history. Repository artifacts, Git history and live GitHub state are authoritative.

## Canonical remote

`payswapdotorg/Zeck` is the canonical remote for Zeck product development. `pectoraux/Zeck` is historical upstream/reference only.

## Current authoritative handoff

Read `docs/LLM-ARCHITECT-HANDOFF.md` immediately after `AGENTS.md`.
For dispatch/review/orchestration behavior also read:

- `docs/LLM-TECH-LEAD-BOOTSTRAP.md`
- `docs/LLM-TECH-LEAD-CONTRACT.md`
- `docs/E1.1-IMPLEMENTATION-PROGRAM.md`
- `docs/E1.1-RESEARCH-BASELINE.md`

## Current continuation pointer

- Core Architecture v1.0: frozen after approval.
- Deployment/runtime Architecture D1.0: approved and subordinate to v1.0.
- Execution Intelligence Architecture E1.0: approved by ACR-003/ADR-0019 and subordinate to v1.0.
- Economic Execution Intelligence E1.1: approved by ACR-004/ADR-0020 and subordinate to v1.0/E1.0.
- UX v2: complete through WORK-041.
- D-00 through D-06: complete.
- D-07 / WORK-048: COMPLETE — merged as PR #14 (merge commit c4051e2, implementation head c6dbb6f, dispatch base e5efa7e).
- E1.1 / WORK-049: COMPLETE — merged as PR #16 (merge commit 93ea53c, implementation head bca6db3, dispatch base b946ade).
- E1.1 / WORK-050: COMPLETE — merged as PR #18 (merge commit 3d249a7, implementation head fc9e564, dispatch base f8b77f2).
- E1.1 / WORK-051: COMPLETE — merged as PR #24 (merge commit bd9a1b1, implementation head 91372f8, dispatch base 0a1322b).
- E1.1 / WORK-052: authorized through Issue #20 (wave).
- E1.1 / WORK-052: COMPLETE — merged as PR #22 (merge commit 9861a84, implementation head a4d3a97, dispatch base 0a1322b).
- E1.1 / WORK-053: COMPLETE — merged as PR #26 (merge commit c763157, implementation head 48ffa23, dispatch base 0a1322b).
- E1.1 / WORK-054: COMPLETE — merged as PR #27 (merge commit b8aa548, implementation head 32670f3, dispatch base 863887e).
- E1.1 / WORK-055: COMPLETE — merged as PR #29 (merge commit ef929a4, implementation head 962afcb, dispatch base 9b6fa2f).
- E1.1 / WORK-056: COMPLETE — merged as PR #31 (merge commit 3318a8a, implementation head dfd397c, integration head 6bf510b incl. the Architect C9 pin reconciliation, dispatch base 201756c).

- D-08 gate-1 (measured production usage): COMPLETE — merged as PR #32 (merge commit f5feb14, evidence head be6642f incl. the boundary remediation + architect C9 reconciliation; dispatch base f2b5284).
- D-08 gates 2+3: APPROVED (014fb30 — AVA-001..004 / SEC-001..004 + ADR-0021/ACR-005).
- D-08 UNLOCKED: WORK-057/058/059 authorized as wave A (frontier eligible), WORK-060 wave B (blocked on WORK-057). Requirements catalog v4 (110 requirements: AVA-001..004, SEC-001..004).
- D-08 / WORK-057: COMPLETE — merged as PR #38 (merge commit 5850e91, implementation head 76292e9, final branch head 4aa3f86; dispatch base 1a86262; measured RTO 1081ms / RPO 0ms, 12-check invariant gate green post-failover).
- D-08 / WORK-058: COMPLETE — merged as PR #37 (merge commit d6a9ffa, implementation head 1fe05d4, final branch head f6fcddd; dispatch base 1a86262; physical tenant-isolation claim gate migration 0031_isolation_profiles).
- D-08 / WORK-059: COMPLETE — merged as PR #36 (merge commit 4ee2ce8, implementation head 2281db2, final branch head eb80d3f incl. the Architect merge reconciliation — 0031_audit_compliance renumbered to 0032; dispatch base 1a86262).
- D-08 wave A COMPLETE. Frontier: WORK-060 (wave B) eligible.

**THE E1.1 IMPLEMENTATION PROGRAM IS COMPLETE** — all nine charter Work Orders (WORK-048 through WORK-056) are implemented, reviewed, merged and finalized. The frontier is empty; future stages require new Architect Work Orders.

- E1.1 final architecture acceptance: RECORDED 2026-09-10 against `main` `8e88a84` (see `docs/architecture-changes/ACR-004-...md#final-architecture-acceptance` and `program-state.json postMergeFinalization.finalArchitectureAcceptance`). The E1.1 program is fully closed.

## D-08 unlock in progress (2026-09-10)

The final deployment phase D-08 is being unlocked: gate-2 requirements APPROVED (`docs/DEPLOYMENT-ROADMAP-D08-REQUIREMENTS.md`, AVA-001..004 / SEC-001..004), gate-3 extension APPROVED (ADR-0021 + ACR-005), gate-1 measured-usage evidence IN FLIGHT on branch `gate/d08-measured-usage`. When that PR merges, the Architect issues D-08 Work Orders (WORK-057+) with frontier/dependency authorization per ADR-0021.

Current frontier is `eligible=[]`, `inFlight=[]`, `blocked=[]` — the E1.1 program is complete.

## E1.1 architectural authority

E1.1 is a refinement of E1.0, not a new independent platform generation. The single `Execution Compiler` is the optimization authority.

It optimizes the expected cost of successfully resolving a governed outcome while preserving hard quality, reliability, policy, capability, budget, tenant, verification, safety and side-effect constraints.

Do not create independent core authorities for model routing, tool routing, context optimization, cache optimization, agent optimization, sandbox optimization, retry optimization or cost optimization.

## E1.1 implementation charter

`docs/E1.1-IMPLEMENTATION-PROGRAM.md` is the exact post-D-07 implementation charter.

```text
WORK-048
  ↓
WORK-049 → WORK-050
              ├─ WORK-051
              ├─ WORK-052
              ├─ WORK-053
              └─ WORK-054
                    ↓
                 WORK-055
                    ↓
                 WORK-056
```

Future stages become executable only when the Architect issues repository Work Orders and dependency/frontier state authorizes them. The charter is not permission to invent implementation work.

## Three-worker rule

A fresh Tech Lead may dispatch at most **3 concurrent implementation workers**.

Parallelism requires live conflict analysis over dependencies, source surfaces, migrations, public contracts, tests, package/toolchain/configuration, provider manifests and architecture/governance artifacts.

Workers do not modify `spec/development-state/*` during implementation and never merge their own PRs.

## No implementation drift

Stop and request Architect amendment whenever implementation would require:

- a new authority, durable state source, ledger, state machine or cache authority;
- a frozen v1.0 invariant change;
- a change to the E1.1 objective or Execution Compiler role;
- provider-specific semantics entering domain modules;
- weaker assurance;
- undocumented dependency/scope expansion;
- dishonest evidence substitution for unavailable infrastructure.

## Provider/substrate rule

E2B, Daytona, Modal and future compute vendors are neutral substrate adapters. Provider snapshots, warm pools, directory snapshots, readiness probes, scheduling and provider-local state remain mechanisms rather than Zeck authorities.

## Current deployment authority

D-07 and the FULL E1.1 implementation program are complete: 048 PR #14, 049 PR #16, 050 PR #18, 051 PR #24, 052 PR #22, 053 PR #26, 054 PR #27, 055 PR #29, 056 PR #31. All ten planes merged (tool-surface, context-economics, model-economics, substrate-economics, failure-recovery, competence-economics over the execution-ir/compiler/decision-record foundation). Post-WORK-055 C9 stale-pin reconciled by the Architect (84b96af, drift-immune dynamic merge-base). Nothing is in flight; the next stage of work requires new Architect-issued Work Orders per the charter.

Required branches: none — the program is complete. All charter branches (work/WORK-048…056-*) are merged into main.

## Recovery sequence

1. `AGENTS.md`
2. `AI_CONTINUATION.md`
3. `docs/LLM-ARCHITECT-HANDOFF.md`
4. `docs/LLM-TECH-LEAD-BOOTSTRAP.md`
5. `docs/LLM-TECH-LEAD-CONTRACT.md`
6. `docs/E1.1-IMPLEMENTATION-PROGRAM.md`
7. `docs/E1.1-RESEARCH-BASELINE.md`
8. README/IMPLEMENTATION/worker and architect runbooks
9. architecture + lock
10. requirements + traceability
11. all development-state JSON
12. relevant ADRs/ACRs and Work Orders
13. live GitHub refs/PRs/issues/checks
14. `python3 scripts/governance-check.py`

## Fresh-session invariant

A fresh LLM Tech Lead must recover the current architecture, frontier, Work Order authority, three-worker concurrency ceiling, E1.1 implementation sequence, provider boundary, evidence rules and merge/finalization protocol entirely from repository artifacts and live GitHub state.
