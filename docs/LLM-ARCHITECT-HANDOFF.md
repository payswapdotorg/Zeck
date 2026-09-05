# Zeck — LLM Architect Handoff

**Purpose:** Durable, repository-resident handoff for a fresh LLM Architect. Conversation history is never authoritative.

## Canonical remote

- Repository: `payswapdotorg/Zeck`
- `pectoraux/Zeck` is historical upstream/reference only.
- The canonical-remote declaration is `docs/FORK-CANONICAL-REMOTE.md`.

## Current state

- Core architecture: **v1.0**, frozen after approval.
- Deployment/runtime architecture: **D1.0**, approved and authoritative for deployment concerns, subordinate to v1.0.
- UX v2 implementation wave: **complete through WORK-041**.
- Current implementation order: **WORK-042 — Reproducible deployment infrastructure foundation**.
- Canonical GitHub Issue: **#1**, authorized/in-flight on `payswapdotorg/Zeck`.
- Historical upstream issue: #75 — not authoritative for this remote.
- Dispatch base: `6bbb76e17ec17de41141db6ef9d41a641ea5cdb4`.
- Required worker branch: `work/WORK-042-deployment-infrastructure-foundation`.
- Development frontier: `eligible=[]`, `inFlight=["WORK-042"]`, `blocked=[]`.

## Deployment authority

1. `docs/DEPLOYMENT-ARCHITECTURE.md` — authoritative Deployment & Runtime Architecture D1.0.
2. `docs/DEPLOYMENT-ROADMAP.md` — authoritative deployment implementation sequence.
3. `docs/architecture-changes/ACR-002-deployment-runtime-architecture.md` — D1.0 approval record.
4. `spec/work-orders/WORK-042.md` — authoritative executable scope for the active increment.

Core principle:

> **Zeck owns authority; providers supply infrastructure.**

Reference topology:

- Vercel — experience/delivery and previews.
- Neon PostgreSQL — authoritative relational state.
- Cloudflare R2 — durable artifact bytes; metadata remains in Zeck authority.
- Cloudflare Queues — non-authoritative asynchronous transport.
- Cloudflare Workflows — non-authoritative durable orchestration.
- Upstash Redis — non-authoritative ephemeral coordination/cache.

Commercial-use plan requirements and mutable vendor limits are evidence inputs and must be re-verified before purchase or production promotion.

## W041 completion

- Dispatch pin: `017e44f41eab9ce7a458843d39a38c895ba79800`
- Binding exact base: `bcc46ee402da33ca478d7cb860352c28b97b1080`
- Worker final head: `3fbb9db212376275ca50858a296234c25d15d46d`
- PR: #74
- Merge commit: `153b5f1c4de6180e5e56c421f5fdfcea7b855cf2`
- Upstream issue #73: closed as completed

## WORK-042 dispatch

- Work Order: `spec/work-orders/WORK-042.md`
- Canonical issue: #1
- Status: AUTHORIZED / IN-FLIGHT
- Exact dispatch base: `6bbb76e17ec17de41141db6ef9d41a641ea5cdb4`
- Required branch: `work/WORK-042-deployment-infrastructure-foundation`
- Assurance: HIGH_ASSURANCE

The worker may use the user's Composio-connected provider accounts to provision and verify infrastructure. Provider dashboards, external infrastructure state, provider credentials and worker conversation are not architecture authority. Required configuration and evidence must be captured in the repository.

## Fresh-session recovery order

1. Read `AGENTS.md`.
2. Read `AI_CONTINUATION.md`.
3. Read this file.
4. Read `README.md` and `IMPLEMENTATION.md`.
5. Read `spec/worker-runbook.md` and `docs/ARCHITECT-RUNBOOK.md`.
6. Read `spec/architecture.md` and `spec/architecture-lock.md`.
7. Read all files under `spec/development-state/`.
8. Read `spec/requirement-traceability.md` and relevant ADRs.
9. Read `docs/DEPLOYMENT-ARCHITECTURE.md`, `docs/DEPLOYMENT-ROADMAP.md`, ACR-002, and `docs/FORK-CANONICAL-REMOTE.md`.
10. Read `spec/work-orders/WORK-042.md` in full.
11. Inspect live Git refs, canonical Issue #1, PRs and checks on `payswapdotorg/Zeck`; verify exact ancestry.
12. Run `python3 scripts/governance-check.py` before changing state or implementation.

## Repository truth hierarchy

1. Actual Git refs and commit ancestry.
2. Repository-resident development-state JSON.
3. Frozen architecture/architecture lock.
4. Approved architecture changes and Work Orders.
5. Exact-revision CI and evidence.
6. Other repository documentation.
7. Conversation history — never authoritative.

## Non-negotiables

- One Work Order = one implementation branch = one PR.
- Workers do not merge their own PRs.
- Workers do not modify `spec/development-state/*` during active work.
- Frozen core v1.0 cannot be silently rewritten.
- D1.0 must remain subordinate to v1.0.
- Infrastructure providers implement ports and operational concerns; they do not become Zeck domain authorities.
- PostgreSQL remains authoritative for durable Zeck state.
- Secrets remain secret-mediated and never enter Git, logs, artifacts or public domain state.
- Evidence is valid only for the exact revision tested.
- Governance-state changes are Architect-owned.

## Completion boundary

WORK-042 is currently the only authorized deployment implementation order. Do not invent the next deployment or product Work Order from chat. The next phase becomes executable only through a repository-approved Work Order with explicit dependency, surfaces, acceptance criteria and evidence contract.

## Fresh-session invariant

A fresh LLM Architect must be able to recover Zeck, including the deployment stream and canonical remote, from repository artifacts and live GitHub state without any prior conversation transcript.
