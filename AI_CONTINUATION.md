# Zeck — Stateless AI Continuation Contract

This repository is designed to be recoverable by a fresh LLM Architect, Tech Lead or implementation session without conversation history. Repository artifacts, Git history and live GitHub state are authoritative.

## Canonical remote

`payswapdotorg/Zeck` is the canonical remote for Zeck product development. `pectoraux/Zeck` is historical upstream/reference only.

## Current authoritative handoff

Read `docs/LLM-ARCHITECT-HANDOFF.md` immediately after `AGENTS.md`.
For dispatch/review/orchestration behavior also read:

- `docs/LLM-TECH-LEAD-BOOTSTRAP.md`
- `docs/LLM-TECH-LEAD-CONTRACT.md`
- `docs/E1.1-IMPLEMENTATION-PROGRAM.md`

## Current continuation pointer

- Core Architecture v1.0: frozen after approval.
- Deployment/runtime Architecture D1.0: approved and subordinate to v1.0.
- Execution Intelligence Architecture E1.0: approved by ACR-003/ADR-0019 and subordinate to v1.0.
- Economic Execution Intelligence E1.1: approved by ACR-004/ADR-0020 and subordinate to v1.0/E1.0.
- UX v2: complete through WORK-041.
- D-00 through D-06: complete.
- D-07 / WORK-048: authorized through Issue #13.

Current frontier: `eligible=["WORK-048"]`, `inFlight=[]`, `blocked=[]` until live state changes.

The exact current `main` SHA must always be fetched. Never hard-code a stale SHA from this file.

## Authoritative architecture navigation

- `docs/LLM-ARCHITECT-HANDOFF.md` — current architect state/navigation.
- `docs/LLM-TECH-LEAD-BOOTSTRAP.md` — zero-context dispatch/review/merge guide.
- `docs/LLM-TECH-LEAD-CONTRACT.md` — normative three-worker and zero-drift contract.
- `docs/E1.1-IMPLEMENTATION-PROGRAM.md` — canonical post-D-07 implementation charter.
- `docs/ROADMAP.md` — strategic roadmap.
- `docs/adr/ADR-0017-procedural-competence-and-runtime-interoperability.md` — competence/runtime interoperability.
- `docs/adr/ADR-0018-agentic-economic-actions-and-payment-rails.md` — agentic economics.
- `docs/adr/ADR-0019-execution-intelligence-architecture.md` — E1.0.
- `docs/adr/ADR-0020-economic-execution-intelligence-e1.1.md` — E1.1.
- `docs/architecture-changes/ACR-002-deployment-runtime-architecture.md` — D1.0.
- `docs/architecture-changes/ACR-003-execution-intelligence-architecture.md` — E1.0.
- `docs/architecture-changes/ACR-004-economic-execution-intelligence-e1.1.md` — E1.1.

## Deployment authority

- `docs/DEPLOYMENT-ARCHITECTURE.md`
- `docs/DEPLOYMENT-ROADMAP.md`
- `docs/architecture-changes/ACR-002-deployment-runtime-architecture.md`
- `spec/work-orders/WORK-048.md`
- GitHub Issue #13

Reference topology remains Vercel for experience/delivery, Neon PostgreSQL for authoritative relational state, Cloudflare R2 for artifact bytes, Cloudflare Queues for transport, Cloudflare Workflows for durable orchestration, and Upstash Redis for non-authoritative coordination/cache.

## D-07 authorization

`WORK-048` is the only current deployment implementation order.
Required branch: `work/WORK-048-resilience-disaster-recovery-provider-exit`.

D-07 covers PostgreSQL recovery, artifact recovery, queue/workflow replay, worker evacuation, outage simulation, alternate S3-compatible artifact storage, alternate managed PostgreSQL, alternate web/API hosting, and measured RTO/RPO evidence.

D-08 remains blocked until D-07 completion, measured production usage, explicit availability/security requirements and any required architecture extension.

## E1.1 implementation continuation

E1.1 optimizes the **expected cost of successfully resolving a governed outcome**, not model-token price alone.

There is one optimization authority: `Execution Compiler`.

Do not create separate core authorities for model routing, tool routing, context optimization, cache optimization, agent optimization, sandbox optimization, retry optimization or cost optimization. These are compiler decisions over one Execution IR.

The canonical post-D-07 sequence is defined exactly in `docs/E1.1-IMPLEMENTATION-PROGRAM.md`:

```text
WORK-048
   ↓
WORK-049  Execution IR + outcome economics
   ↓
WORK-050  Execution Compiler
   ├──────────────┬──────────────┬──────────────┐
   ▼              ▼              ▼
WORK-051       WORK-052       WORK-053 / WORK-054
Tool/program   Context/reuse  Model/agent and/or substrate
   └──────────────┴──────────────┴──────────────┐
                                                  ▼
                                               WORK-055
                                        failure + escalation + continuation
                                                  ↓
                                               WORK-056
                                    competence + deterministicization
```

Each becomes executable only through an actual repository Work Order plus dependency/frontier authorization. Never invent a future Work Order from conversation or roadmap prose.

## Three-worker rule

A fresh Tech Lead may dispatch **at most three concurrent implementation workers**.

Parallelism is permitted only after dependency, source-surface, migration, public-contract, test, package/configuration and architecture/governance conflict analysis proves mechanical reconciliation is possible.

Workers never modify `spec/development-state/*` during active implementation. Workers never merge their own PRs.

## No implementation drift

Implementation must stop rather than silently reinterpret the architecture when it would require:

- a new authority, durable state source, state machine, ledger or cache authority;
- a v1.0 invariant change;
- an E1.1 objective or Execution Compiler role change;
- provider-specific domain semantics;
- weaker assurance;
- undocumented dependencies/surfaces;
- dishonest substitution of unavailable infrastructure evidence.

Such changes require Architect amendment and, where architectural authority changes, the ACR/ADR process.

## Provider/substrate rule

E2B, Daytona, Modal and future compute vendors are neutral substrate adapters. Their snapshots, warm pools, directory snapshots, readiness probes, scheduling and provider-local state are implementation mechanisms. Zeck may compare their bounded capability/cost/readiness/reliability facts but must not import provider authority into the domain model.

## Non-negotiables

- One Work Order = one implementation branch = one PR.
- Exact-revision evidence only.
- Worker does not self-merge.
- Frozen architecture cannot be silently rewritten.
- Learning, competence, benchmarking, provider runtimes and payment rails do not become authorities.
- Secrets never enter Git, logs, artifacts or public domain state.

## Recovery sequence

1. Read `AGENTS.md`.
2. Read `AI_CONTINUATION.md`.
3. Read `docs/LLM-ARCHITECT-HANDOFF.md`.
4. Read `docs/LLM-TECH-LEAD-BOOTSTRAP.md`.
5. Read `docs/LLM-TECH-LEAD-CONTRACT.md`.
6. Read `docs/E1.1-IMPLEMENTATION-PROGRAM.md`.
7. Read README/IMPLEMENTATION/worker and architect runbooks.
8. Read architecture + lock.
9. Read requirements + traceability.
10. Read all development-state JSON.
11. Read relevant ADRs/ACRs and Work Orders.
12. Inspect live GitHub refs/PRs/issues/checks.
13. Run `python3 scripts/governance-check.py`.

## Fresh-session invariant

A fresh LLM must recover architecture, frontier, Work Order authority, three-worker safety limit, E1.1 implementation sequence, provider boundary and review/merge protocol entirely from repository artifacts plus live GitHub state.
