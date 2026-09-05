# Zeck — Stateless AI Continuation Contract

This repository is designed to be recoverable by a fresh LLM Architect or implementation session without conversation history.

## Current authoritative handoff

Read `docs/LLM-ARCHITECT-HANDOFF.md` immediately after `AGENTS.md`. It is the current durable Architect handoff and records the active Work Order, exact repository state, dispatch history, review protocol, and completion boundary.

## Required recovery sequence

1. Read `AGENTS.md`.
2. Read this file.
3. Read `docs/LLM-ARCHITECT-HANDOFF.md`.
4. Read `README.md` and `IMPLEMENTATION.md`.
5. Read `spec/worker-runbook.md` and `docs/ARCHITECT-RUNBOOK.md`.
6. Read `spec/architecture.md` and `spec/architecture-lock.md`.
7. Read all four files under `spec/development-state/`.
8. Read `spec/requirement-traceability.md` and relevant ADRs.
9. Read the active `spec/work-orders/WORK-*.md` in full.
10. Inspect live GitHub refs, issues, PRs, and checks.
11. Run `python3 scripts/governance-check.py` before changing implementation or governance state.

Conversation history is never authoritative. Repository artifacts, Git history, and live GitHub state are authoritative.

## Current continuation pointer

At the current handoff, the UX v2 sequence has reached **WORK-041 — UX integration hardening, usability and release gate**. W033–W040 are complete. W041 is the sole in-flight Work Order and the current final defined UX v2 Work Order.

The current durable state is recorded in `docs/LLM-ARCHITECT-HANDOFF.md` and the development-state JSON files. Do not copy mutable SHAs into new documents without checking the live refs first.

## Critical rule about mutable state

Always inspect the current `main` ref and active worker branch refs before acting. An Architect-owned documentation/state commit may move `main` after a worker was dispatched. Never silently assume that the current `main` SHA is the original Work Order dispatch base; use the Dispatch Record plus actual ancestry to distinguish the original base from later Architect-only commits.

## Recovery rule

Do not begin new implementation merely because a PR exists or because another session claimed something was done. Inspect:

1. current `main` SHA;
2. current active Work Order branch SHA(s);
3. PR mergeability, exact head, and checks;
4. actual changed files/diff;
5. development-state JSON records;
6. Work Order Dispatch Record;
7. governance output;
8. exact evidence revision identity.

Continue from the smallest repository-proven next action.

## Non-negotiables

- One Work Order = one implementation branch = one PR.
- Implementers do not merge their own PRs.
- Workers do not modify `spec/development-state/*` during active work.
- Frozen architecture v1.0 cannot be silently rewritten.
- The dashboard is a projection over authoritative APIs/SDKs; it must not create alternate authority.
- Learning remains advisory and cannot become policy/execution authority.
- Credentials/secrets remain secret-mediated and must never appear in ordinary dashboard state.
- Economic/accounting truth remains canonical to its authority; never create a second ledger in presentation code.
- Browser state is ephemeral and non-authoritative.
- Evidence is valid only for the exact revision it was run against.
- Governance-state changes are Architect-owned and must be minimal semantic changes, not wholesale ledger rewrites.

## W041 completion boundary

W041 is the final currently-defined UX v2 implementation order. Its acceptance must close the integration/release gate, finalize development state against the actual merge commit, and re-run governance after finalization.

After W041 is complete, do not invent W042. Re-derive the frontier from repository state. A future implementation wave requires a formally approved Work Order and, where necessary, a new architecture decision/version before implementation.

## Architect behavior

The Architect is the review and merge authority. The Architect independently verifies worker claims, exact ancestry, declared surfaces, authority boundaries, CI, browser evidence, and checkpoint contracts. Worker summaries are evidence pointers, not acceptance.

When an active Work Order completes, the Architect must finalize program/checkpoint/frontier state against the actual merge identity before closing the Work Order issue.
