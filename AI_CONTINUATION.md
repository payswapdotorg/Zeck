# Zeck — Stateless AI Continuation Contract

This repository is designed to be recoverable by a fresh LLM Architect or implementation session without conversation history. Repository artifacts, Git history, and live GitHub state are authoritative.

## Canonical remote

`payswapdotorg/Zeck` is the canonical remote for Zeck product development. `pectoraux/Zeck` is historical upstream/reference only and its issues, pull requests, account permissions and infrastructure state are not authoritative for this repository.

See `docs/FORK-CANONICAL-REMOTE.md`.

## Current authoritative handoff

Read `docs/LLM-ARCHITECT-HANDOFF.md` immediately after `AGENTS.md`.

## Current continuation pointer

The UX v2 sequence is complete through **WORK-041**. The deployment/runtime roadmap is active under approved **Deployment & Runtime Architecture D1.0**.

**D-00 complete. D-01 complete through WORK-042. D-02 is now the sole authorized in-flight deployment phase through WORK-043.**

Current frontier: `eligible=[]`, `inFlight=["WORK-043"]`, `blocked=[]`.

## Authoritative deployment sequence

`D-00 → D-01 → D-02 → D-03 → D-04 → D-05 → D-06 → D-07 → D-08`

No deployment phase may be skipped, reordered or inferred from chat. Each phase becomes executable only through an approved repository Work Order with explicit surfaces, dependencies, acceptance criteria and evidence requirements.

## Deployment authority

- `docs/DEPLOYMENT-ARCHITECTURE.md` — authoritative Deployment & Runtime Architecture D1.0.
- `docs/DEPLOYMENT-ROADMAP.md` — authoritative deployment sequence.
- `docs/architecture-changes/ACR-002-deployment-runtime-architecture.md` — D1.0 approval record.
- `spec/work-orders/WORK-043.md` — authoritative current implementation scope.
- GitHub Issue #3 — canonical WORK-043 dispatch record on this remote.

The reference topology is Vercel for experience/delivery, Neon PostgreSQL for authoritative relational state, Cloudflare R2 for artifact bytes, Cloudflare Queues for transport, Cloudflare Workflows for durable orchestration, and Upstash Redis for non-authoritative coordination. Commercial production must use commercially permitted plans; free-tier eligibility is not an architectural authority.

## D-01 completion

- Work Order: `WORK-042`
- Canonical issue: #1
- PR: #2
- Merge commit: `b75e23bacf9a9ace76e88e643ea2a272f588a0f9`
- Worker final head: `c61392260024244db7bab723e9f018d7c582e9a8`
- Post-merge governance state: finalized

## D-02 dispatch

- Work Order: `WORK-043`
- Canonical issue: #3
- Required branch: `work/WORK-043-database-artifact-production-path`
- Dependency: `WORK-042`
- Status: `AUTHORIZED / IN-FLIGHT`
- Exact dispatch base: to be recorded in the final dispatch binding before worker checkout

## Recovery sequence

1. Read `AGENTS.md`.
2. Read this file.
3. Read `docs/LLM-ARCHITECT-HANDOFF.md`.
4. Read `README.md` and `IMPLEMENTATION.md`.
5. Read `spec/worker-runbook.md` and `docs/ARCHITECT-RUNBOOK.md`.
6. Read `spec/architecture.md` and `spec/architecture-lock.md`.
7. Read all files under `spec/development-state/`.
8. Read `spec/requirement-traceability.md`, relevant ADRs, `docs/DEPLOYMENT-ARCHITECTURE.md`, `docs/DEPLOYMENT-ROADMAP.md`, ACR-002, and `docs/FORK-CANONICAL-REMOTE.md`.
9. Inspect complete Work Orders and live GitHub refs on `payswapdotorg/Zeck`.
10. Run `python3 scripts/governance-check.py` before changing state or implementation.

## Non-negotiables

- One Work Order = one implementation branch = one PR.
- Implementers do not merge their own PRs.
- Workers do not modify `spec/development-state/*` during active implementation.
- Frozen architecture v1.0 cannot be silently rewritten.
- Deployment Architecture D1.0 is subordinate to frozen v1.0.
- Providers implement ports and operational concerns; they do not become Zeck domain authorities.
- Secrets remain secret-mediated and never enter Git, logs, artifacts or public domain state.
- Evidence is valid only for the exact revision on which it was produced.
- Governance-state changes are Architect-owned and minimal.

## Fresh-session invariant

A fresh LLM Architect must recover current Zeck state from this repository and live GitHub state, never from conversation history or provider dashboards.
