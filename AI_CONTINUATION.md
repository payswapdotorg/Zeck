# Zeck — Stateless AI Continuation Contract

This repository is designed to be recoverable by a fresh LLM session without conversation history.

## Start here

Read `AGENTS.md` first. Then read `README.md`, `IMPLEMENTATION.md`, `spec/worker-runbook.md`, `spec/architecture.md`, `spec/architecture-lock.md`, the four files under `spec/development-state/`, `spec/requirement-traceability.md`, and the active Work Order(s).

Run `python3 scripts/governance-check.py` before making changes.

Conversation history is never authoritative; repository artifacts and Git history are authoritative.

## Current continuation pointer

As of 2026-09-01 the active implementation wave includes **WORK-020 — Learned execution planning and automatic policy optimization** and **WORK-024 — Voice and Realtime Agent Deployment**.

- Repository: `pectoraux/Zeck`
- Active implementation PRs: to be created from the exact stable main SHA recorded by the Architect activation.
- Parallelism rule: both active implementations must start from the same exact `main` SHA; neither branch may rebase onto the other.
- Shared development-state artifacts are Architect-owned during the wave and must not be modified by implementation branches.
- Always read the live branch and `main` refs from GitHub before acting; mutable SHAs are intentionally not hard-coded here.

## Recovery rule

Do not begin new implementation merely because a PR exists or because the last conversation claimed something was done. Inspect:

1. current `main` SHA;
2. current Work Order branch SHA(s);
3. PR mergeability and checks;
4. actual changed files/diff;
5. development-state JSON records;
6. governance output.

Then continue from the smallest repository-proven next action.

## Active implementation continuity

**WORK-020:** implement learned execution planning and automatic policy optimization within learning/planning/policies only. Preserve policy as hard authority; no second planner, state machine or execution authority.

**WORK-024:** implement provider-neutral voice/realtime deployment within deployments and directly-required agents seams only. Preserve execution, policy, capability, budget, tenant, secret and provenance authorities.

Keep the architecture locked unless a formal architecture change is approved.

## Parallel-wave rule

The current wave is intentionally parallel. A sibling branch is never another sibling's base and no implementation branch should edit `spec/development-state/` shared state during the wave. The Architect performs activation, frontier management, merge review and post-merge finalization centrally.

## Non-negotiables

- One Work Order = one branch = one PR.
- Implementers do not merge their own work.
- Parallel siblings use the same frozen base and do not rebase onto siblings.
- Learning remains advisory and must not become a second execution or policy authority.
- Shared governance state is centralized to the Architect during a parallel wave.
- Governance/checkpoint JSON changes must be minimal semantic unions, not wholesale rewrites.
- Evidence must be bound to the exact commit it was run against.
- WORK-019 migration ownership is `0015`; WORK-022 migration ownership is `0016`.
