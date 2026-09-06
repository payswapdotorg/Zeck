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
- D-05 execution worker deployment fabric: **complete through WORK-046 / PR #10**.
- D-06 production delivery, observability and release control: **complete through WORK-047 / PR #12**.
- Current implementation order: **WORK-048 — Resilience, disaster recovery and provider exit (D-07)**.
- Canonical GitHub Issue: **#13**, authorized/pending on `payswapdotorg/Zeck`.
- Development frontier: `eligible=["WORK-048"]`, `inFlight=[]`, `blocked=[]`.

## Authoritative deployment sequence

```text
D-00 Architecture/contract — COMPLETE
D-01 Reproducible infrastructure foundation — COMPLETE (WORK-042)
D-02 Database + artifact production path — COMPLETE (WORK-043)
D-03 Asynchronous execution transport — COMPLETE (WORK-044)
D-04 Durable orchestration — COMPLETE (WORK-045)
D-05 Execution worker deployment fabric — COMPLETE (WORK-046)
D-06 Production delivery, observability and release control — COMPLETE (WORK-047)
D-07 Resilience, disaster recovery and provider exit — AUTHORIZED (WORK-048)
D-08 Growth/enterprise hardening — BLOCKED
```

Workers may not skip, reorder or infer phases from chat. A phase becomes executable only through a repository-approved Work Order.

## Deployment authority

1. `docs/DEPLOYMENT-ARCHITECTURE.md` — authoritative Deployment & Runtime Architecture D1.0.
2. `docs/DEPLOYMENT-ROADMAP.md` — authoritative deployment implementation sequence.
3. `docs/architecture-changes/ACR-002-deployment-runtime-architecture.md` — D1.0 approval record.
4. `spec/work-orders/WORK-048.md` — authoritative current executable scope.

Core principle:

> **Zeck owns authority; providers supply infrastructure.**

Reference topology remains Vercel for experience/delivery, Neon PostgreSQL for authoritative relational state, Cloudflare R2 for artifact bytes, Cloudflare Queues for transport, Cloudflare Workflows for durable orchestration, and Upstash Redis for non-authoritative coordination/cache.

## D-06 completion

- Work Order: `WORK-047`
- Canonical issue: #11
- Required branch: `work/WORK-047-production-delivery-observability-release-control`
- Dependency: `WORK-046`
- Assurance: HIGH_ASSURANCE
- Status: COMPLETE
- Exact authorization base: `5d26365ee9b8e55f41b923328443ae746205757a`
- Implementation/evidence head: `6eb3afb4456338bda771ade9300971cbdeaf8aee`
- PR: #12
- Merge commit: `ad27648ebf78f868a749cdbc924f84e20dd62161`
- Exact synchronized GitHub Actions: Repository Governance PASS; Deployment Validation PASS; Deployment Release Control PASS.
- Live provider/OTLP infrastructure remained NOT RUN where credentials/hosts were unavailable and was never claimed as live-provider PASS.
- Post-merge program/frontier state: finalized.

## D-07 authorization

- Work Order: `WORK-048`
- Canonical issue: #13
- Required branch: `work/WORK-048-resilience-disaster-recovery-provider-exit`
- Dependency: `WORK-047`
- Assurance: HIGH_ASSURANCE
- Status: AUTHORIZED / PENDING
- Objective: prove Zeck can survive infrastructure loss and provider substitution without moving authority away from PostgreSQL or changing frozen v1.0 semantics.
- Scope: PostgreSQL recovery, artifact recovery, queue/workflow replay, regional worker evacuation, provider outage simulations, alternate S3-compatible artifact storage, alternate managed PostgreSQL, alternate web/API hosting, and measured RTO/RPO evidence.

## D-07 gate

D-08 may not begin until D-07 is complete, measured production usage exists, explicit availability/security requirements are recorded, and the Architect approves any required architecture extension.

## Recovery sequence

1. Read `AGENTS.md`.
2. Read `AI_CONTINUATION.md`.
3. Read this file.
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
