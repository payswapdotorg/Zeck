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
13. `docs/SESSION-HANDOFF.md` when present for the active work order

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
- Current PR head: `35c6aa01666ec366aa09e29d6193cc1c08c4b8d1`
- Current `main`: `f15c2cc91ef2b5b36cdea7682f98b37a657db433`
- PR #40 is currently open and GitHub reports it as non-mergeable; do not assume the PR description reflects a reconciled merge state.

## Current work product

WORK-022 implementation and evidence are already committed on its branch. The architectural intent is advisory codebase-opportunity analysis, governed as an execution, with selective human evaluation and no new execution/planner/verification authority.

The primary evidence document is:

`docs/work-items/WORK-022.md`

Its implementation/evidence history and requirement mapping should be treated as the canonical description of what WORK-022 actually contains.

## Verified evidence recorded before the continuation commits

The Repository Governance workflow for `86093eac92f9e87c16142567c95e1d8a79fdb950` completed successfully.

Recorded local evidence in the PR/work-item includes:

- `bun run typecheck`: 0 errors
- `bun run lint`: 0 errors, 0 warnings
- `python3 scripts/governance-check.py`: exit 0 at the recorded implementation evidence point
- targeted unit: 1236/1236
- architecture + discrimination: 633/633
- real PostgreSQL: 337/337
- full regression: 2212/2212 twice consecutively at the recorded exact final head

These are historical evidence claims. They do not certify the later continuation commits or a post-WORK-019 reconciliation. A fresh architect must re-run the required gate after any branch/base reconciliation or source/state change.

## Immediate next action

Do **not** start new feature implementation from chat memory.

First reconcile WORK-022 with current `main` because WORK-019 has since merged into `main`. Preserve both Work Orders' governance records and migration claims. In particular:

- WORK-019 owns migration `0015`.
- WORK-022 owns migration `0016`.
- The migration runner must continue to apply migrations in ascending order and tolerate the parallel-wave gap semantics described by the Work Orders.
- Do not delete or overwrite existing governance records merely to make JSON conflicts disappear.
- After reconciliation, re-run governance, typecheck, lint, architecture/discrimination, integration, real-PG suites, and the full regression required by the Work Order.
- Re-pin the final evidence to the actual post-reconciliation commit SHA.
- Only the architect may approve/merge the PR.

## Known state issue at cutoff

PR #40 is based on the older pre-WORK-019 `main` state and has a governance-state merge conflict/non-mergeable condition after WORK-019 merged. The previous session began reconciling this frontier/checkpoint state. Treat the current branch state as the starting point; inspect the actual files and git diff before making further edits.

A previous attempted state reconciliation produced an unnecessarily large rewrite of `spec/development-state/checkpoint-state.json`. Do not preserve a wholesale rewrite if it is not semantically required. Prefer the smallest correct union of WORK-019 and WORK-022 records.

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