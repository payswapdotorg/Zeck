# Zeck — Stateless AI Continuation Contract

This file exists so a fresh LLM/architect session can resume work without relying on conversation memory.

## Read first

1. `AGENTS.md`
2. `README.md`
3. `IMPLEMENTATION.md`
4. `spec/worker-runbook.md`
5. `spec/architecture.md`
6. `spec/architecture-lock.md`
7. `spec/development-state/program-state.json`
8. `spec/development-state/dependency-state.json`
9. `spec/development-state/frontier-state.json`
10. `spec/development-state/checkpoint-state.json`
11. `spec/requirement-traceability.md`
12. Relevant `spec/work-orders/WORK-NNN.md`

Then run:

```bash
python3 scripts/governance-check.py
```

Conversation history is not authoritative. The repository is the source of truth.

## Active continuation point

As of 2026-09-01, the active implementation is **WORK-022 — Codebase AI opportunity analysis and selective human evaluation**.

- Repository: `pectoraux/Zeck`
- Work branch: `work/WORK-022-opportunity-analysis`
- PR: `#40`
- PR URL: https://github.com/pectoraux/Zeck/pull/40
- The exact current branch and `main` SHAs must always be read from GitHub immediately before acting; this document deliberately does not hard-code mutable SHAs.
- PR #40 is currently open and has a non-mergeable state resulting from `main` moving forward after WORK-019 merged. Verify the live PR before changing anything.

## Current work product

WORK-022 implementation and evidence are already committed on its branch. The architectural intent is advisory codebase-opportunity analysis, governed as an execution, with selective human evaluation and no new execution/planner/verification authority.

The primary evidence document is:

`docs/work-items/WORK-022.md`

Its implementation/evidence history and requirement mapping should be treated as the canonical description of what WORK-022 actually contains.

## Historical verification evidence

Before the latest continuation/handoff commits and before post-WORK-019 reconciliation, the repository recorded a green verification at an earlier exact WORK-022 head, including successful governance workflow, typecheck, lint, targeted suites, real PostgreSQL suites, and repeated full regression. Those historical numbers remain evidence of that earlier revision only.

A fresh architect must re-run the required verification after branch/base reconciliation or any source/state change and bind the final evidence to the resulting exact commit SHA.

## Immediate next action

Do **not** start new feature implementation from chat memory.

First reconcile WORK-022 with current `main` because WORK-019 has merged into `main`. Preserve both Work Orders' governance records and migration claims. In particular:

- WORK-019 owns migration `0015`.
- WORK-022 owns migration `0016`.
- The migration runner must continue to apply migrations in ascending order and tolerate the parallel-wave gap semantics described by the Work Orders.
- Do not delete or overwrite existing governance records merely to make JSON conflicts disappear.
- Inspect the actual branch diff and development-state files before resolving anything.
- After reconciliation, re-run governance, typecheck, lint, architecture/discrimination, integration, real-PG suites, and the full regression required by the Work Order.
- Re-pin the final evidence to the actual post-reconciliation commit SHA.
- Only the architect may approve/merge the PR.

## Known state issue at cutoff

PR #40 was created from the pre-WORK-019 `main` state. The branch subsequently underwent state reconciliation, and GitHub currently reports the PR as non-mergeable. Treat the live branch contents as authoritative and inspect the exact diff before further edits.

A previous attempted reconciliation produced an unnecessarily large rewrite of `spec/development-state/checkpoint-state.json`. Do not preserve a wholesale rewrite if it is not semantically required. Prefer the smallest correct union of WORK-019 and WORK-022 records.

## Architectural non-negotiables

WORK-022 must remain consistent with these boundaries:

- learning remains an observation/advisory island
- analyzer dependencies remain limited to the governed quartet specified by the architecture gate
- no code execution, mutation, deployment, promotion, planner authority, verification authority, policy/capability/budget/sandbox bypass is introduced by learning
- analysis is read-only advisory evidence
- analysis is composed through the executions authority
- human ratings are immutable evidence
- transition vocabulary remains `advisory -> candidate -> verified`; `promoted` is not a learning state
- verified requires the frozen differential-equivalence evidence gate
- planner consultation is consult-only and recorded after governed selection; findings must not alter live selection
- migration ownership remains collision-free (`0015` WORK-019, `0016` WORK-022)

## Fresh-session protocol

When taking over, report only what the repository proves. If a required fact is missing, raise a governance finding or architecture/Work Order amendment instead of inferring it from memory.

The safest first prompt in a fresh session is:

> Read `AI_CONTINUATION.md`, `AGENTS.md`, `IMPLEMENTATION.md`, the architecture lock, all development-state JSON files, `spec/work-orders/WORK-022.md`, and `docs/work-items/WORK-022.md`. Inspect PR #40 and the current `main`/branch SHAs. Run the governance check. Then act as Architect: reconcile the WORK-019 merge with WORK-022 using the smallest valid state union, re-run all required evidence at the exact resulting head, and do not merge until the repository proves the Work Order is satisfied.