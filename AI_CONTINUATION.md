# Zeck — Stateless AI Continuation Contract

This repository is designed to be recoverable by a fresh LLM Architect or implementation session without conversation history. Repository artifacts, Git history, and live GitHub state are authoritative.

## Current authoritative handoff

Read `docs/LLM-ARCHITECT-HANDOFF.md` immediately after `AGENTS.md`.

## Current continuation pointer

The UX v2 sequence is complete through **WORK-041 — UX integration hardening, usability and release gate**. W033–W041 are complete. W041 was accepted and merged as PR #74 at merge commit `153b5f1c4de6180e5e56c421f5fdfcea7b855cf2`.

The development frontier is now `eligible=[]`, `inFlight=[]`, `blocked=[]`. There is no currently authorized W042.

## W041 completion identity

- Dispatch pin: `017e44f41eab9ce7a458843d39a38c895ba79800`
- Binding exact base: `bcc46ee402da33ca478d7cb860352c28b97b1080`
- Worker final head: `3fbb9db212376275ca50858a296234c25d15d46d`
- PR: #74
- Merge commit: `153b5f1c4de6180e5e56c421f5fdfcea7b855cf2`
- Issue #73: closed as completed

The dispatch ancestry nuance remains intentional: `017e44f…` is the final W041 dispatch-state commit and its parent `bcc46ee…` is the Work Order's binding base. Architect-owned documentation commits after dispatch must not be treated as worker implementation history.

## Required fresh-session recovery

1. Read `AGENTS.md`.
2. Read this file.
3. Read `docs/LLM-ARCHITECT-HANDOFF.md`.
4. Read `README.md` and `IMPLEMENTATION.md`.
5. Read `spec/worker-runbook.md` and `docs/ARCHITECT-RUNBOOK.md`.
6. Read `spec/architecture.md` and `spec/architecture-lock.md`.
7. Read all four files under `spec/development-state/`.
8. Read `spec/requirement-traceability.md` and relevant ADRs.
9. Inspect the complete Work Order set and current live GitHub refs.
10. Run `python3 scripts/governance-check.py` before changing implementation or governance state.

## Non-negotiables

- One Work Order = one implementation branch = one PR.
- Implementers do not merge their own PRs.
- Workers do not modify `spec/development-state/*` during active work.
- Frozen architecture v1.0 cannot be silently rewritten.
- Dashboard code is projection over authoritative APIs/SDKs, not a new authority.
- Learning remains advisory.
- Credentials/secrets remain secret-mediated.
- Browser presentation state is ephemeral and non-authoritative.
- Evidence is valid only for the exact revision on which it was produced.
- Governance-state changes are Architect-owned and minimal.

## Completion boundary

W041 was the final currently-defined UX v2 implementation order. After its acceptance, merge, state finalization, issue closure, and governance re-check, the Architect must stop and re-derive the frontier. Do not invent W042.

A future implementation wave requires a formally approved new Work Order and, where necessary, a new architecture decision/version.
