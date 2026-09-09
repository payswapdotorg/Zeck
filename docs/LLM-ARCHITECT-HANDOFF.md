# Zeck — LLM Architect Handoff

**Purpose:** Durable, repository-resident handoff for a fresh LLM Architect / LLM Tech Lead. Conversation history is never authoritative.

## Canonical remote

- Repository: `payswapdotorg/Zeck`
- `pectoraux/Zeck` is historical upstream/reference only.
- Canonical-remote declaration: `docs/FORK-CANONICAL-REMOTE.md`.

## Current state

- Core architecture: **v1.0**, frozen after approval.
- Deployment/runtime architecture: **D1.0**, approved and subordinate to v1.0.
- Execution Intelligence Architecture: **E1.0**, approved by ACR-003/ADR-0019.
- Economic Execution Intelligence: **E1.1**, approved by ACR-004/ADR-0020 and subordinate to v1.0/E1.0.
- UX v2: complete through WORK-041.
- Deployment phases D-00 through D-06: complete.
- Current authorized deployment phase: **D-07 / WORK-048 — resilience, disaster recovery and provider exit**.
- Canonical issue: **#13**.
- Current frontier remains `eligible=["WORK-048"]`, `inFlight=[]`, `blocked=[]` until D-07 is actually started/completed and state is updated by the Architect.

The exact `main` SHA must always be fetched at recovery time. Never treat the SHA in this file as current authority.

## Mission

Zeck is the neutral execution optimization layer for AI work.

> **For every governed outcome, choose the lowest expected-cost execution representation that satisfies policy, capability, quality, reliability, latency, verification and side-effect constraints.**

Zeck optimizes the whole successful outcome, not only model-token cost.

## Authority model

Frozen v1.0 remains authoritative:

```text
Tenant / Application Identity
        ↓
Policy
        ↓
Capabilities
        ↓
Budget / Economics
        ↓
Planning
        ↓
Execution
        ↓
Sandbox / Substrate
        ↓
Verification
        ↓
Evidence
        ↓
Learning
```

No subsequent architecture may create a second authority for any of these concerns.

## Architecture evolution

### D1.0 — Deployment/runtime

Providers supply infrastructure. Zeck owns domain authority. PostgreSQL remains authoritative for durable state; object storage owns artifact bytes; queues/workflows transport/orchestrate; Redis is non-authoritative coordination/cache.

### ADR-0017 — Procedural competence/runtime interoperability

Competence is versioned, provenance-bearing reusable procedural knowledge. OpenClaw, Hermes, WorkflowOS and customer runtimes integrate through adapters rather than becoming Zeck authorities.

### ADR-0018 — Agentic economics

EconomicAction and PaymentAuthority are future execution-control extensions. Budgets remain canonical spending authority. Payment rails are adapters.

### E1.0 — Execution Intelligence

Authoritative documents:

- `docs/adr/ADR-0019-execution-intelligence-architecture.md`
- `docs/architecture-changes/ACR-003-execution-intelligence-architecture.md`

E1.0 adds an optimization stage after a governed plan and before execution:

```text
Intent → Policy → Capability → Planning → Execution Compiler → Optimized Execution IR → Execution → Verification → Evidence → Learning
```

### E1.1 — Economic Execution Intelligence

Authoritative documents:

- `docs/adr/ADR-0020-economic-execution-intelligence-e1.1.md`
- `docs/architecture-changes/ACR-004-economic-execution-intelligence-e1.1.md`
- `docs/E1.1-IMPLEMENTATION-PROGRAM.md`
- `docs/LLM-TECH-LEAD-CONTRACT.md`

E1.1 does **not** create more optimizer services. One `Execution Compiler` makes the optimization decisions over a common Execution IR.

The compiler may jointly consider:

- deterministic computation;
- cached/reused results;
- verified competence and existing tools;
- programmatic execution;
- context/cache economics;
- duplicate-work coalescing;
- model and reasoning effort;
- safe parallelism/batching;
- 0/1/N agent selection;
- retry versus fresh escalation;
- verification burden;
- substrate selection;
- sandbox readiness/warm execution;
- service/inference tier;
- provider/infrastructure reliability and latency.

The objective is expected successful-resolution cost, subject to hard quality, reliability, safety, policy and verification constraints.

## Current implementation stream

The repository's current active stream is deployment D-07:

`spec/work-orders/WORK-048.md`

D-07 covers resilience, disaster recovery and provider exit, including PostgreSQL recovery, artifact recovery, queue/workflow replay, worker evacuation, outage simulation, alternate artifact storage, alternate managed PostgreSQL, alternate web/API hosting and measured RTO/RPO evidence.

Do not invent WORK-049 from chat. After D-07, the next implementation sequence is governed by `docs/E1.1-IMPLEMENTATION-PROGRAM.md`; its stages become executable only through actual Work Orders issued by the Architect and reflected in development-state/frontier state.

## Three-worker operating contract

A fresh Tech Lead may dispatch **at most three concurrent implementation workers**.

Before dispatching, compare:

- Work Order dependencies;
- source/module surfaces;
- migrations/schema ownership;
- public contracts;
- tests/fixtures;
- package/toolchain files;
- provider/deployment manifests;
- architecture/governance files.

Use fewer than three whenever semantic reconciliation would be required.

`docs/LLM-TECH-LEAD-CONTRACT.md` is normative for dispatch, review, merge and drift prevention.

## No implementation drift

Workers implement only the exact issued Work Order.

A worker must stop and request Architect amendment rather than adapting the architecture when implementation requires:

- a new authority;
- a second durable state source, ledger or state machine;
- a frozen v1.0 change;
- a change to the E1.1 objective or Execution Compiler role;
- provider-specific domain semantics;
- weaker assurance;
- an undocumented dependency or scope expansion;
- evidence that cannot honestly be executed.

External products and provider features are evidence for adapter design, never authority for Zeck architecture.

## Provider/substrate strategy

E2B, Daytona and Modal are provider adapters behind the neutral substrate contract.

Provider-specific snapshots, warm pools, directory snapshots, readiness probes, regional placement and scheduling remain provider mechanisms. Zeck may consume bounded capability/cost/readiness/reliability facts and select a substrate, but provider state cannot become Zeck authority.

## Post-D-07 E1.1 sequence

```text
WORK-049  Execution IR + outcome economics
      ↓
WORK-050  Execution Compiler
      ├───────────────┬───────────────┐
      ▼               ▼               ▼
WORK-051          WORK-052          WORK-053 / WORK-054
Tool/program      Context/reuse    Model/agent and/or substrate
      │               │               │
      └───────────────┴──────┬────────┘
                             ▼
                          WORK-055
                   failure + escalation + continuation
                             ↓
                          WORK-056
                 competence + deterministicization
```

The precise parallel wave is chosen from live surfaces; never assume maximum concurrency is automatically safe.

## Worker evidence invariant

Every implementation PR must bind evidence to the exact tested head and disclose unavailable external infrastructure as **NOT RUN**, never as PASS.

The Architect reviews identity/base/ancestry, scope, authority boundaries, migration ownership, discrimination evidence, durable/concurrency proof, exact CI and limitations before accepting a merge.

## Post-merge protocol

```text
merge
 ↓
verify actual merge commit
 ↓
finalize Work Order/program/dependency/frontier/checkpoint state
 ↓
run governance
 ↓
update handoff/continuation artifacts
 ↓
recompute next executable frontier
```

A green PR is not completion until repository state records the actual merge.

## Fresh-session recovery sequence

1. `AGENTS.md`
2. `AI_CONTINUATION.md`
3. `docs/LLM-ARCHITECT-HANDOFF.md`
4. `docs/LLM-TECH-LEAD-BOOTSTRAP.md`
5. `docs/LLM-TECH-LEAD-CONTRACT.md`
6. `docs/E1.1-IMPLEMENTATION-PROGRAM.md`
7. `README.md` / `IMPLEMENTATION.md`
8. worker runbook / architect runbook
9. architecture + architecture lock
10. requirements + traceability
11. all development-state JSON
12. relevant ADR/ACR
13. current Work Orders
14. live GitHub refs/PRs/issues/checks
15. `python3 scripts/governance-check.py`

## Fresh-session invariant

A new LLM Tech Lead must be able to recover the current architecture, implementation frontier, Work Order authority, safe concurrency limit, E1.1 sequence, provider integration boundary and review/merge protocol from repository artifacts alone.
