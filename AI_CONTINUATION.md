# Zeck — Stateless AI Continuation Contract

This repository is designed to be recoverable by a fresh LLM session without conversation history.

## Start here

Read `AGENTS.md` first. Then read `README.md`, `IMPLEMENTATION.md`, `spec/worker-runbook.md`, `spec/architecture.md`, `spec/architecture-lock.md`, the four files under `spec/development-state/`, `spec/requirement-traceability.md`, and the active Work Order.

Run `python3 scripts/governance-check.py` before making changes.

Conversation history is never authoritative; repository artifacts and Git history are authoritative.

## Current continuation pointer

As of 2026-09-01 the active implementation wave includes **WORK-022 — Codebase AI opportunity analysis and selective human evaluation**.

- Repository: `pectoraux/Zeck`
- Active PR: #40
- Branch: `work/WORK-022-opportunity-analysis`
- Active PR URL: https://github.com/pectoraux/Zeck/pull/40
- `main` currently points to `f15c2cc91ef2b5b36cdea7682f98b37a657db433`.
- The active WORK-022 branch head is tracked in PR #40 and in the branch-local continuation contract; inspect GitHub for the exact latest SHA before acting.

## Recovery rule

Do not begin new implementation merely because a PR exists or because the last conversation claimed something was done. Inspect:

1. current `main` SHA;
2. current Work Order branch SHA;
3. PR mergeability and checks;
4. actual changed files/diff;
5. development-state JSON records;
6. governance output.

Then continue from the smallest repository-proven next action.

## Active implementation continuity

The canonical WORK-022 implementation/evidence record is `docs/work-items/WORK-022.md`. The PR body is a summary, not a substitute for the actual repository state.

WORK-022 introduces advisory codebase-opportunity analysis, selective human evaluation, and a planning consultation seam while preserving the repository's authority boundaries. Keep the architecture locked unless a formal architecture change is approved.

## Fresh-session prompt

> Read `AI_CONTINUATION.md`, `AGENTS.md`, `IMPLEMENTATION.md`, `spec/architecture.md`, `spec/architecture-lock.md`, all files under `spec/development-state/`, `spec/requirement-traceability.md`, `spec/work-orders/WORK-022.md`, and `docs/work-items/WORK-022.md`. Inspect PR #40, its current head/base SHAs, and current `main`. Run `python3 scripts/governance-check.py`. Then act as the Architect: determine the exact repository-proven next action, reconcile any outstanding WORK-019/WORK-022 integration state without deleting valid governance records, re-run required evidence after every source/state change, and do not merge until the repository proves the Work Order is satisfied.

## Non-negotiables

- One Work Order = one branch = one PR.
- Implementers do not merge their own work.
- Learning remains advisory/observational and must not become a second execution or policy authority.
- WORK-019 migration ownership is `0015`; WORK-022 migration ownership is `0016`.
- Governance/checkpoint JSON changes must be minimal semantic unions, not wholesale rewrites.
- Evidence must be bound to the exact commit it was run against.