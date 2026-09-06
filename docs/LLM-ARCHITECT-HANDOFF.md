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
- D-03 asynchronous execution transport: complete through WORK-044 / PR #6.
- D-04 durable orchestration: complete through WORK-045 / PR #8.
- Current implementation order: **none authorized**.
- Canonical GitHub Issue: **#7**, closed as completed on `payswapdotorg/Zeck`.
- WORK-045 merge commit: `0067c72c8179a6f880f5477789958370376b8de9`.
- Development frontier: `eligible=[]`, `inFlight=[]`, `blocked=[]`.

## Authoritative deployment sequence

```text
D-00 Architecture/contract — COMPLETE
D-01 Reproducible infrastructure foundation — COMPLETE (WORK-042)
D-02 Database + artifact production path — COMPLETE (WORK-043)
D-03 Asynchronous execution transport — COMPLETE (WORK-044)
D-04 Durable orchestration — COMPLETE (WORK-045)
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
4. `spec/work-orders/WORK-045.md` — authoritative completed D-04 scope.

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
- Worker final head: `c61392260024244db7bab723e9f018d7c582a9e8`
- Merge commit: `b75e23bacf9a9ace76e88e643ea2a272f588a0f9`
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

## WORK-044 / D-03 completion

- Work Order: `spec/work-orders/WORK-044.md`
- Canonical issue: #5
- Status: COMPLETE
- Dependency: WORK-043
- Required branch: `work/WORK-044-asynchronous-execution-transport`
- Assurance: HIGH_ASSURANCE
- Exact dispatch base: `44eaceca4de2af7d531fd1b9bad5a14b14d3b69e`
- Corrected implementation head: `785605777ab590577cd8df8173cdb1ab64866116`
- PR: #6
- Merge commit: `985ca850faaa620cf3df05675f7af74e2073f188`
- Critical Architect correction: transport probe isolated to dedicated `ZECK_PROBE_QUEUE_ID`; exact-own-message settlement; execution queue never touched by probe.
- Live Cloudflare successful round-trip: NOT RUN due unavailable provider credentials; fail-closed provider reachability evidence retained.
- Post-merge program/dependency/frontier state finalized by Architect; repository governance check passes on main.

## WORK-045 / D-04 completion

- Work Order: `spec/work-orders/WORK-045.md`
- Canonical issue: #7
- Status: COMPLETE
- Dependency: WORK-044
- Required branch: `work/WORK-045-durable-orchestration`
- Assurance: HIGH_ASSURANCE
- Exact dispatch base: `6cfbd936475a457886a174adeb457faf9b974ce9`
- Implementation head: `b8a9536d662e9195c3044304fb61829360856048`
- PR: #8
- Merge commit: `0067c72c8179a6f880f5477789958370376b8de9`
- Architect acceptance completed before merge.
- Full regression at exact implementation head: 330 files / 4573 tests, 4562 passed, 11 skipped, 0 failed, twice consecutively.
- Governance and deployment validation: PASS at exact implementation head.
- Live Cloudflare Workflows successful round-trip: NOT RUN due unavailable provider credentials; real-HTTP protocol evidence and invalid-token 401 reachability/classification evidence retained.
- Post-merge program/frontier state finalized by Architect; no successor Work Order is currently authorized.

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
10. Inspect complete Work Orders and live Git refs, Issues, PRs and checks on `payswapdotorg/Zeck`; verify exact ancestry and current frontier.
11. Run `python3 scripts/governance-check.py` before changing state or implementation.

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
- Workflow state is never execution authority.
- Secrets remain secret-mediated and never enter Git, logs, artifacts or public domain state.
- Evidence is valid only for the exact revision tested.
- Governance-state changes are Architect-owned.

## Completion boundary

WORK-045 / D-04 is complete and its post-merge state is finalized. Do not invent or activate D-05, a product-runtime Work Order, or any successor implementation order solely from conversation. The next phase becomes executable only after the Architect creates and registers a new repository-approved Work Order, with explicit dependencies, declared surfaces, acceptance criteria and evidence requirements, and updates the authoritative frontier.

## Fresh-session invariant

A fresh LLM Architect must be able to recover Zeck, including the canonical remote and the D-00→D-08 deployment sequence, from repository artifacts and live GitHub state without any prior conversation transcript.
