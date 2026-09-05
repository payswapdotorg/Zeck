# Zeck — Stateless AI Continuation Contract

This repository is designed to be recoverable by a fresh LLM Architect or implementation session without conversation history. Repository artifacts, Git history, and live GitHub state are authoritative.

## Current authoritative handoff

Read `docs/LLM-ARCHITECT-HANDOFF.md` immediately after `AGENTS.md`.

## Current continuation pointer

The UX v2 sequence is complete through **WORK-041 — UX integration hardening, usability and release gate**. W033–W041 are complete. W041 was accepted and merged as PR #74 at merge commit `153b5f1c4de6180e5e56c421f5fdfcea7b855cf2`.

The previous UX development frontier is `eligible=[]`, `inFlight=[]`, `blocked=[]`. There is no UX W042 authorized by the completed UX wave.

## Deployment architecture pointer

Zeck now has an approved deployment/runtime architecture stream:

- `docs/architecture-changes/ACR-002-deployment-runtime-architecture.md`
- `docs/DEPLOYMENT-ARCHITECTURE.md`
- `docs/DEPLOYMENT-ROADMAP.md`

Deployment Architecture **D1.0** is subordinate to frozen core architecture v1.0. It establishes the provider-neutral deployment model and the reference low-cost topology, but it does not itself authorize implementation work. Each deployment roadmap phase becomes executable only through an approved repository Work Order.

The reference topology uses Vercel for experience/preview delivery, Neon PostgreSQL for authority, Cloudflare R2 for artifact bytes, Cloudflare Queues for transport, Cloudflare Workflows for durable orchestration, and Upstash Redis for non-authoritative coordination. Commercial production must use commercially permitted plans; Vercel Hobby is development/non-commercial only.

## W041 completion identity

- Dispatch pin: `017e44f41eab9ce7a458843d39a38c895ba79800`
- Binding exact base: `bcc46ee402da33ca478d7cb860352c28b97b1080`
- Worker final head: `3fbb9db212376275ca50858a296234c25d15d46d`
- PR: #74
- Merge commit: `153b5f1c4de6180e5e56c421f5fdfcea7b855cf2`
- Issue #73: closed as completed

The dispatch ancestry nuance remains intentional: `017e44f…` is the final W041 dispatch-state commit and its parent `bcc46ee…` is the Work Order's binding base. Architect-owned documentation commits after dispatch must not be treated as worker implementation history.

## Required fresh-session recovery

1. Read this file.
2. Read `AGENTS.md`.
3. Read `docs/LLM-ARCHITECT-HANDOFF.md`.
4. Read `README.md` and `IMPLEMENTATION.md`.
5. Read `spec/worker-runbook.md` and `docs/ARCHITECT-RUNBOOK.md`.
6. Read `spec/architecture.md` and `spec/architecture-lock.md`.
7. Read all four files under `spec/development-state/`.
8. Read `spec/requirement-traceability.md` and relevant ADRs.
9. Read `docs/architecture-changes/ACR-002-deployment-runtime-architecture.md`, `docs/DEPLOYMENT-ARCHITECTURE.md`, and `docs/DEPLOYMENT-ROADMAP.md`.
10. Inspect the complete Work Order set and current live GitHub refs.
11. Run `python3 scripts/governance-check.py` before changing implementation or governance state.

## Non-negotiables

- One Work Order = one implementation branch = one PR.
- Implementers do not merge their own PRs.
- Workers do not modify `spec/development-state/*` during active work.
- Frozen architecture v1.0 cannot be silently rewritten.
- Deployment providers cannot become domain authorities.
- Dashboard code is projection over public API/SDK authorities, not a new authority.
- Learning remains advisory.
- Credentials/secrets remain secret-mediated.
- Browser presentation state is ephemeral and non-authoritative.
- Evidence is valid only for the exact revision on which it was produced.
- Governance-state changes are Architect-owned and minimal.

## Completion boundary

W041 was the final currently-defined UX v2 implementation order and is complete. Deployment architecture D1.0 is now the approved next engineering stream. Deployment implementation must follow `docs/DEPLOYMENT-ROADMAP.md` and explicit Work Orders; workers must not invent deployment phases or provider architecture from chat.

## Fresh-session invariant

A fresh LLM Architect must be able to recover Zeck from these repository artifacts and live GitHub state without any prior conversation transcript.
