# Zeck — Stateless AI Continuation Contract

This repository is designed to be recoverable by a fresh LLM Architect, Tech Lead or implementation session without conversation history. Repository artifacts, Git history and live GitHub state are authoritative.

## Canonical remote

`payswapdotorg/Zeck` is the canonical remote for Zeck product development. `pectoraux/Zeck` is historical upstream/reference only and is not authoritative for this repository.

See `docs/FORK-CANONICAL-REMOTE.md`.

## Current authoritative handoff

Read `docs/LLM-ARCHITECT-HANDOFF.md` immediately after `AGENTS.md`.

For dispatch/review/orchestration behavior, also read `docs/LLM-TECH-LEAD-BOOTSTRAP.md`.

## Current continuation pointer

- Core Architecture v1.0: frozen after approval.
- Deployment/runtime Architecture D1.0: approved and subordinate to v1.0.
- Execution Intelligence Architecture E1.0: approved by ACR-003/ADR-0019 and subordinate to v1.0.
- UX v2: complete through WORK-041.
- D-00 complete.
- D-01 complete through WORK-042.
- D-02 complete through WORK-043.
- D-03 complete through WORK-044.
- D-04 complete through WORK-045.
- D-05 complete through WORK-046 / PR #10.
- D-06 complete through WORK-047 / PR #12.
- D-07 is authorized through WORK-048 / Issue #13.

Current frontier: `eligible=["WORK-048"]`, `inFlight=[]`, `blocked=[]`.

## Authoritative architecture navigation

- `docs/LLM-TECH-LEAD-BOOTSTRAP.md` — zero-context architect/tech-lead dispatch, review, merge and roadmap guide.
- `docs/LLM-ARCHITECT-HANDOFF.md` — current authoritative state and recovery navigation.
- `docs/ROADMAP.md` — forward product/architecture roadmap.
- `docs/adr/ADR-0017-procedural-competence-and-runtime-interoperability.md` — competence and external runtime interoperability.
- `docs/adr/ADR-0018-agentic-economic-actions-and-payment-rails.md` — provider-neutral agentic economics.
- `docs/adr/ADR-0019-execution-intelligence-architecture.md` — Execution Intelligence E1.0.
- `docs/architecture-changes/ACR-002-deployment-runtime-architecture.md` — D1.0 approval.
- `docs/architecture-changes/ACR-003-execution-intelligence-architecture.md` — E1.0 approval.

## Deployment authority

- `docs/DEPLOYMENT-ARCHITECTURE.md`
- `docs/DEPLOYMENT-ROADMAP.md`
- `docs/architecture-changes/ACR-002-deployment-runtime-architecture.md`
- `spec/work-orders/WORK-048.md`
- GitHub Issue #13

Reference topology remains Vercel for experience/delivery, Neon PostgreSQL for authoritative relational state, Cloudflare R2 for artifact bytes, Cloudflare Queues for transport, Cloudflare Workflows for durable orchestration, and Upstash Redis for non-authoritative coordination/cache.

## D-07 authorization

`WORK-048` is the only current deployment implementation order.

Required branch: `work/WORK-048-resilience-disaster-recovery-provider-exit`

D-07 covers resilience, disaster recovery and provider exit while keeping PostgreSQL authoritative. Scope includes PostgreSQL recovery, artifact recovery, queue/workflow replay, worker evacuation, outage simulation, alternate S3-compatible artifact storage, alternate managed PostgreSQL, alternate web/API hosting and measured RTO/RPO evidence.

D-08 remains blocked until D-07 completion, measured production usage, explicit availability/security requirements and any required architecture extension.

## Execution Intelligence continuation

E1.0 is architecture-approved but its concrete implementation becomes executable only through repository Work Orders.

The intended sequence is:

```text
Execution IR
  ↓
Execution Compiler
  ↓
Tool Surface Compiler
  ↓
Programmatic tool calling
  ↓
Context Economy
  ↓
Parallel/batch/reuse optimization
  ↓
Multi-agent economic gate
  ↓
Evaluation + failure attribution
  ↓
Continuation packages
  ↓
Competence-aware optimization
  ↓
Progressive deterministicization
```

The purpose is to make Zeck continuously reduce unnecessary model calls, context/tool overhead, latency and cost while preserving or improving verified outcomes.

## Strategic ecosystem continuation

ADR-0017/0018/0019 together define the intended future ecosystem:

```text
             ZECK
               |
       Execution Control
               |
      +--------+---------+
      |        |         |
   compute   agents   economics
      |        |         |
 deterministic runtimes payments
 tools/skills OpenClaw  Stripe/MPP/x402
 competence  Hermes
      |        |         |
      +--------+---------+
               |
          Verification
               |
            Evidence
               |
            Learning
```

External runtime frameworks and payment rails are adapters/participants. They never become Zeck authorities.

## Non-negotiables

- One Work Order = one implementation branch = one PR.
- Implementers do not merge their own PRs.
- Workers do not modify `spec/development-state/*` during active implementation.
- Frozen architecture v1.0 cannot be silently rewritten.
- D1.0 and E1.0 are subordinate to v1.0.
- Providers implement ports and operational concerns; they do not become Zeck domain authorities.
- Secrets remain secret-mediated and never enter Git, logs, artifacts or public domain state.
- Evidence is valid only for the exact revision on which it was produced.
- Governance-state changes are Architect-owned and minimal.

## Recovery sequence

1. Read `AGENTS.md`.
2. Read `AI_CONTINUATION.md`.
3. Read `docs/LLM-ARCHITECT-HANDOFF.md`.
4. Read `docs/LLM-TECH-LEAD-BOOTSTRAP.md`.
5. Read `README.md` and `IMPLEMENTATION.md`.
6. Read `spec/worker-runbook.md` and `docs/ARCHITECT-RUNBOOK.md`.
7. Read `spec/architecture.md` and `spec/architecture-lock.md`.
8. Read all `spec/development-state/*.json`.
9. Read `spec/requirements.md` and `spec/requirement-traceability.md`.
10. Read relevant ADRs/ACRs and the active Work Order.
11. Inspect live Git refs, PRs, Issues and exact checks on `payswapdotorg/Zeck`.
12. Run `python3 scripts/governance-check.py` before state changes or implementation.

## Fresh-session invariant

A fresh LLM must recover current Zeck state from repository artifacts and live GitHub state, never from conversation history or provider dashboards.
