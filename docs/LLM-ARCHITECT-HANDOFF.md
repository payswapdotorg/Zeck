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
- D-00 architecture/contract: complete.
- D-01 reproducible infrastructure foundation: complete through WORK-042 / PR #2.
- Current implementation order: **WORK-043 — Database and artifact production path (D-02)**.
- Canonical GitHub Issue: **#3**, authorized/in-flight on `payswapdotorg/Zeck`.
- Required worker branch: `work/WORK-043-database-artifact-production-path`.
- Development frontier: `eligible=[]`, `inFlight=["WORK-043"]`, `blocked=[]`.

## Authoritative deployment sequence

```text
D-00 Architecture/contract — COMPLETE
D-01 Reproducible infrastructure foundation — COMPLETE (WORK-042)
D-02 Database + artifact production path — CURRENT (WORK-043)
D-03 Asynchronous execution transport
D-04 Durable orchestration
D-05 Execution worker deployment fabric
D-06 Production delivery, observability and release control
D-07 Resilience, disaster recovery and provider exit
D-08 Growth/enterprise hardening
```

Workers may not skip, reorder or infer phases from chat. A phase becomes executable only through a repository-approved Work Order.

## Deployment authority

1. `docs/DEPLOYMENT-ARCHITECTURE.md` — authoritative Deployment & Runtime Architecture D1.0.
2. `docs/DEPLOYMENT-ROADMAP.md` — authoritative deployment implementation sequence.
3. `docs/architecture-changes/ACR-002-deployment-runtime-architecture.md` — D1.0 approval record.
4. `spec/work-orders/WORK-043.md` — authoritative executable scope for the active increment.

Core principle:

> **Zeck owns authority; providers supply infrastructure.**

Reference topology:

- Vercel — experience/delivery and previews.
- Neon PostgreSQL — authoritative relational state.
- Cloudflare R2 — durable artifact bytes; metadata remains in Zeck authority.
- Cloudflare Queues — non-authoritative asynchronous transport.
- Cloudflare Workflows — non-authoritative durable orchestration.
- Upstash Redis — non-authoritative ephemeral coordination/cache.

## WORK-042 completion

- Work Order: `WORK-042`
- Canonical Issue: #1
- PR: #2
- Worker final head: `c61392260024244db7bab723e9f018d7c582e9a8`
- Merge commit: `b75e23bacf9a9ace76e88e643ea2a272f588a0f9`
- Post-merge program/frontier state finalized by Architect.

## WORK-043 D-02 dispatch

- Work Order: `spec/work-orders/WORK-043.md`
- Canonical issue: #3
- Status: AUTHORIZED / IN-FLIGHT
- Dependency: WORK-042
- Required branch: `work/WORK-043-database-artifact-production-path`
- Assurance: HIGH_ASSURANCE
- Exact dispatch base: see the canonical Issue #3 binding before checkout.

The worker may use authorized connected provider accounts to provision and verify Neon/R2 resources. Provider dashboards and external infrastructure state remain evidence/operational state only.

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
10. Read `spec/work-orders/WORK-043.md` in full.
11. Inspect live Git refs, canonical Issue #3, PRs and checks on `payswapdotorg/Zeck`; verify exact ancestry.
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
- Workers do not modify `spec/development-state/*` during active implementation.
- Frozen core v1.0 cannot be silently rewritten.
- D1.0 must remain subordinate to v1.0.
- Infrastructure providers implement ports and operational concerns; they do not become Zeck domain authorities.
- PostgreSQL remains authoritative for durable Zeck state.
- R2 stores artifact bytes only; artifact metadata/provenance remains authoritative in Zeck.
- Secrets remain secret-mediated and never enter Git, logs, artifacts or public domain state.
- Evidence is valid only for the exact revision tested.
- Governance-state changes are Architect-owned.

## Completion boundary

WORK-043 is the only authorized deployment implementation order. Do not invent D-03 or any product-runtime Work Order during active D-02 implementation. The next phase becomes executable only after D-02 acceptance, merge and post-merge finalization through a new repository-approved Work Order.

## Fresh-session invariant

A fresh LLM Architect must be able to recover Zeck, including the canonical remote and the D-00→D-08 deployment sequence, from repository artifacts and live GitHub state without any prior conversation transcript.
