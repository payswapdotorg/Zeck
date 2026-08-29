# AI Execution OS

AI Execution OS is provider-independent infrastructure for executing AI work as governed, policy-constrained, evidence-producing executions.

It is designed to make AI integration as simple for developers as payments integration: an application declares an outcome and constraints; the platform determines the execution plan across models, tools, algorithms, agents, context strategies, sandboxes, verification and human escalation.

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

Read `AGENTS.md`, then `IMPLEMENTATION.md`, then `spec/worker-runbook.md`. Read the governing architecture/lock and the development-state JSON files. Run `python3 scripts/governance-check.py`. Only implement a Work Order listed in `spec/development-state/frontier-state.json`.

Every requirement is traced to an owning Work Order in `spec/requirement-traceability.md`; every Work Order contains concrete acceptance criteria, declared surfaces and evidence requirements.

## Start here as an architect

Read `AGENTS.md`, then `docs/ARCHITECT-RUNBOOK.md`. The architect is the semantic and merge authority for the implementation program. Work Orders, ADRs, checkpoint verdicts and post-merge finalization are repository-resident authority artifacts.

## Initial implementation target

The first implementation wave is a modular-monolith control plane with:

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

## Status

Architecture v1.0 is the governing frozen baseline by ADR-0000. Later changes require an Architecture Change Request and a new immutable architecture version.
