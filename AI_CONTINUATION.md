# Zeck — Stateless AI Continuation Contract

This repository is designed to be recoverable by a fresh LLM Architect or implementation session without conversation history. Repository artifacts, Git history, and live GitHub state are authoritative.

## Current authoritative handoff

Read `docs/LLM-ARCHITECT-HANDOFF.md` immediately after `AGENTS.md`.

## Current continuation pointer

The UX v2 sequence is complete through **WORK-041**. The deployment/runtime stream is now active under approved **Deployment & Runtime Architecture D1.0**.

Current frontier: `eligible=[]`, `inFlight=["WORK-042"]`, `blocked=[]`.

## Deployment authority

- `docs/DEPLOYMENT-ARCHITECTURE.md` — authoritative Deployment & Runtime Architecture D1.0.
- `docs/DEPLOYMENT-ROADMAP.md` — authoritative deployment sequence.
- `docs/architecture-changes/ACR-002-deployment-runtime-architecture.md` — D1.0 approval record.
- `spec/work-orders/WORK-042.md` — authoritative current implementation scope.
- GitHub Issue #75 — WORK-042 dispatch record.

The reference topology is Vercel for experience/delivery, Neon PostgreSQL for authoritative relational state, Cloudflare R2 for artifact bytes, Cloudflare Queues for transport, Cloudflare Workflows for durable orchestration, and Upstash Redis for non-authoritative coordination. Commercial production must use commercially permitted plans; free-tier eligibility is not an architectural authority.

## WORK-042 identity

- Dispatch base: `6bbb76e17ec17de41141db6ef9d41a641ea5cdb4`
- Required branch: `work/WORK-042-deployment-infrastructure-foundation`
- Issue: #75

## Recovery sequence

1. Read `AGENTS.md`.
2. Read this file.
3. Read `docs/LLM-ARCHITECT-HANDOFF.md`.
4. Read `README.md` and `IMPLEMENTATION.md`.
5. Read `spec/worker-runbook.md` and `docs/ARCHITECT-RUNBOOK.md`.
6. Read `spec/architecture.md` and `spec/architecture-lock.md`.
7. Read all files under `spec/development-state/`.
8. Read `spec/requirement-traceability.md`, relevant ADRs, `docs/DEPLOYMENT-ARCHITECTURE.md`, `docs/DEPLOYMENT-ROADMAP.md`, and ACR-002.
9. Inspect complete Work Orders and live GitHub refs.
10. Run `python3 scripts/governance-check.py` before changing state or implementation.

## Non-negotiables

- One Work Order = one implementation branch = one PR.
- Implementers do not merge their own PRs.
- Workers do not modify `spec/development-state/*` during active work.
- Frozen architecture v1.0 cannot be silently rewritten.
- Deployment Architecture D1.0 is subordinate to frozen v1.0.
- Providers implement ports and operational concerns; they do not become Zeck domain authorities.
- Secrets remain secret-mediated and never enter Git, logs, artifacts or public domain state.
- Evidence is valid only for the exact revision on which it was produced.
- Governance-state changes are Architect-owned and minimal.

## Fresh-session invariant

A fresh LLM Architect must recover current Zeck state from this repository and live GitHub state, never from conversation history or provider dashboards.
