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
- D-02 database and artifact production path: complete through WORK-043 / PR #4.
- Current implementation order: **WORK-044 — Asynchronous execution transport (D-03)**.
- Canonical GitHub Issue: **#5**, authorized/in-flight on `payswapdotorg/Zeck`.
- Required worker branch: `work/WORK-044-asynchronous-execution-transport`.
- Exact dispatch base: `44eaceca4de2af7d531fd1b9bad5a14b14d3b69e`.
- Development frontier: `eligible=[]`, `inFlight=["WORK-044"]`, `blocked=[]`.

## Authoritative deployment sequence

```text
D-00 Architecture/contract — COMPLETE
D-01 Reproducible infrastructure foundation — COMPLETE (WORK-042)
D-02 Database + artifact production path — COMPLETE (WORK-043)
D-03 Asynchronous execution transport — CURRENT (WORK-044)
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
4. `spec/work-orders/WORK-044.md` — authoritative executable scope for the active increment.

Core principle:

> **Zeck owns authority; providers supply infrastructure.**

Reference topology:

- Vercel — experience/delivery and previews.
- Neon PostgreSQL — authoritative relational state.
- Cloudflare R2 — durable artifact bytes; metadata remains in Zeck authority.
- Cloudflare Queues — non-authoritative asynchronous transport.
- Cloudflare Workflows — non-authoritative durable orchestration.
- Upstash Redis — non-authoritative ephemeral coordination/cache.

## WORK-042 / D-01 completion

- Work Order: `WORK-042`
- Canonical Issue: #1
- PR: #2
- Worker final head: `c61392260024244db7bab723e9f018d7c582e9a8`
- Merge commit: `b75e23bacf9aace76e88e643ea2a272f588a0f9`
- Post-merge program/frontier state finalized by Architect.

## WORK-043 / D-02 completion

- Work Order: `WORK-043`
- Canonical Issue: #3
- PR: #4
- Worker implementation head: `0a99e6c65a21742672dc4e6ce4fbe5dd8e5db5cc`
- Final implementation-branch head: `84e6ef9cf32f514537bfdfbf59c0a84968d488d0`
- Merge commit: `2175bc6c73ad0a8d4b5ab2efb6a8930cfdb01b17`
- Live Neon/R2 provider verification: NOT RUN in the worker environment because provider credentials were unavailable; this is not a PASS claim.
- Post-merge program/dependency state finalized by Architect.

## WORK-044 / D-03 dispatch

- Work Order: `spec/work-orders/WORK-044.md`
- Canonical issue: #5
- Status: AUTHORIZED / IN-FLIGHT
- Dependency: WORK-043
- Required branch: `work/WORK-044-asynchronous-execution-transport`
- Assurance: HIGH_ASSURANCE
- Exact dispatch base: `44eaceca4de2af7d531fd1b9bad5a14b14d3b69e`

D-03 scope is limited to asynchronous execution transport: durable dispatch correlation, provider-neutral queue adapter, idempotent consumers, bounded retry/dead-letter handling, backlog inspection, safe replay, crash/restart recovery, and explicit provider outage behavior.

Workers must not implement D-04 orchestration, D-05 worker fabric, D-06 release/observability expansion, unrelated product runtime work, or a second execution state machine.

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
10. Read `spec/work-orders/WORK-044.md` in full.
11. Inspect live Git refs, canonical Issue #5, PRs and checks on `payswapdotorg/Zeck`; verify exact ancestry.
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
- Queue state is never execution authority.
- Secrets remain secret-mediated and never enter Git, logs, artifacts or public domain state.
- Evidence is valid only for the exact revision tested.
- Governance-state changes are Architect-owned.

## Completion boundary

WORK-044 is currently the only authorized deployment implementation order. Do not invent D-04 or any product-runtime Work Order during active D-03 implementation. The next phase becomes executable only after D-03 acceptance, merge and post-merge finalization through a new repository-approved Work Order.

## Fresh-session invariant

A fresh LLM Architect must be able to recover Zeck, including the canonical remote and the D-00→D-08 deployment sequence, from repository artifacts and live GitHub state without any prior conversation transcript.
