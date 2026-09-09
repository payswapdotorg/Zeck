# AI Execution OS

AI Execution OS is provider-independent infrastructure for executing AI work as governed, policy-constrained, evidence-producing executions.

It is designed to make AI integration as simple for developers as payments integration: an application declares an outcome and constraints; the platform determines the execution plan across models, tools, algorithms, agents, context strategies, sandboxes, verification and human escalation.

Its strategic role is broader than model orchestration: Zeck optimizes the **computational representation** of work, preferring deterministic computation whenever it is sufficiently reliable and using probabilistic AI only where justified.

## Repository governance

This repository uses the repository-resident implementation governance pattern proven in WorkflowOS:

- frozen ArchitectureVersion + architecture lock
- architect-issued Work Orders under `spec/work-orders/`
- one Work Item per branch/PR
- dependency-aware implementation frontier
- declared change surfaces and parallel-conflict detection
- adaptive assurance profiles
- executable architecture checkpoints
- evidence over claims
- architect-only approval/merge authority
- repository-resident program state for zero-context resumption
- post-merge finalization of program state

The governing development state lives under `spec/development-state/`; chat and PR comments are coordination only.

## Start here as an implementation agent

Read `AGENTS.md`, then `IMPLEMENTATION.md`, then `spec/worker-runbook.md`. Read the governing architecture/lock and development-state JSON files. Run `python3 scripts/governance-check.py`. Only implement a Work Order listed in `spec/development-state/frontier-state.json`.

Every requirement is traced to an owning Work Order in `spec/requirement-traceability.md`; every Work Order contains concrete acceptance criteria, declared surfaces and evidence requirements.

## Start here as an architect / LLM Tech Lead

Read `AGENTS.md`, then `docs/ARCHITECT-RUNBOOK.md`, then `docs/LLM-TECH-LEAD-BOOTSTRAP.md`. The tech-lead guide explains how to recover the active program, choose safe parallelism, dispatch workers, review evidence, reconcile branches and advance the frontier without conversation history.

## Architecture and roadmap evolution

- `docs/adr/ADR-0017-procedural-competence-and-runtime-interoperability.md` — reusable procedural competence, session/gateway interoperability and external runtime adapters.
- `docs/adr/ADR-0018-agentic-economic-actions-and-payment-rails.md` — provider-neutral agentic economic actions and payment-rail adapters.
- `docs/adr/ADR-0019-execution-intelligence-architecture.md` — Execution Intelligence Architecture E1.0: Execution IR, compiler optimization, tool-surface/context economy, programmatic tool use, evaluation and progressive deterministicization.
- `docs/architecture-changes/ACR-003-execution-intelligence-architecture.md` — approved E1.0 architecture-change record.
- `docs/ROADMAP.md` — authoritative forward roadmap.

## Initial implementation target

The original foundation is a modular-monolith control plane with:

- provider and connection federation
- BYOK
- budgets and an append-only usage ledger
- capability registry
- execution planning and routing
- context compilation
- governed tools
- container isolation, with a microVM/VM evolution path
- verification and quality gates
- learning/evaluation telemetry
- SDK/API foundations
- a first-class WorkflowOS adapter

## Strategic principle

For every requested outcome:

```text
simplest reliable representation
        ↓
deterministic code
        ↓
existing tool / competence
        ↓
programmatic orchestration
        ↓
smallest sufficient model
        ↓
larger model only when justified
        ↓
multi-agent only when economically justified
        ↓
human only when uncertainty warrants it
```

## Status

Architecture v1.0 is the governing frozen baseline by ADR-0000. Later changes require an Architecture Change Request and a new immutable subordinate architecture version such as D1.0 or E1.0; frozen v1.0 invariants may not be silently rewritten.
