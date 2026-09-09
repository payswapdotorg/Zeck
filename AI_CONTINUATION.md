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
- E1.1 / WORK-051: authorized through Issue #19 (wave).
- E1.1 / WORK-052: authorized through Issue #20 (wave).
- E1.1 / WORK-053: authorized through Issue #21 (wave; selected over WORK-054 by live surface/conflict analysis).

Current frontier is `eligible=["WORK-051", "WORK-052", "WORK-053"]`, `inFlight=["WORK-051", "WORK-052", "WORK-053"]`, `blocked=[]`.

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

D-07, E1.1 stage 1 and stage 2 are complete. The E1.1 parallel wave {WORK-051, WORK-052, WORK-053} is authorized and dispatched (Issues #19/#20/#21). WORK-054 (substrate/runtime adapters) is charter-listed but NOT yet authorized; it dispatches when a wave slot frees — its provider-SDK-table and compute-plane footprints overlap WORK-051's sandbox boundary pins, so it must not run beside WORK-051.

Required branches:
- `work/WORK-051-tool-surface-compiler-programmatic-execution`
- `work/WORK-052-context-cache-reuse-economics`
- `work/WORK-053-adaptive-model-economics`

Each wave worker creates its branch at exactly the current canonical `main` head (the WORK-050 merge, 3d249a7) so the base is exact with no stale pre-dispatch documentation. Wave workers are mutually conflict-free by declared surfaces: 051 [tools/sandbox], 052 [executions], 053 [planning].

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
