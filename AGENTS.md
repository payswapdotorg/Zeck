# AI Execution OS — LLM Agent Contract

This repository is designed for stateless LLM architect, tech-lead and implementation agents. Conversation history is not authoritative.

## Required recovery sequence

1. Read this file.
2. Read `AI_CONTINUATION.md`.
3. Read `docs/LLM-ARCHITECT-HANDOFF.md`.
4. Read `docs/LLM-TECH-LEAD-BOOTSTRAP.md`.
5. Read `docs/LLM-TECH-LEAD-CONTRACT.md`.
6. Read `docs/E1.1-IMPLEMENTATION-PROGRAM.md`.
7. Read `README.md`.
8. Read `IMPLEMENTATION.md` and `spec/worker-runbook.md`.
9. Read `spec/architecture.md` and `spec/architecture-lock.md`.
10. Read `spec/development-state/program-state.json`, `dependency-state.json`, `frontier-state.json`, and `checkpoint-state.json`.
11. Read relevant ADRs/ACRs and `spec/requirement-traceability.md`.
12. Read the assigned `spec/work-orders/WORK-NNN.md` in full.
13. Inspect live Git refs/PRs/issues/checks and verify the active Work Order's exact branch/base relationship.
14. Run `python3 scripts/governance-check.py` before implementation or governance-state changes.

## Architect / Tech Lead agent

The architect/tech lead is the semantic authority for architecture, Work Orders, checkpoint verdicts, architecture-change approval, worker dispatch, merge approval and program-state finalization.

The architect must:

- derive the implementation frontier from repository state;
- issue/amend Work Orders rather than assigning undocumented work;
- review declared surfaces and dependency coordination;
- enforce a maximum of **3 concurrent implementation workers**;
- ensure parallel branches are conflict-safe before dispatch;
- ensure assurance depth is appropriate;
- require evidence rather than claims;
- keep frozen architecture immutable;
- prevent provider-specific features from becoming domain authority;
- approve merges only after required checks and review evidence pass;
- finalize program state against the actual merge identity after merge;
- keep architecture evolution discoverable through approved ADR/ACR artifacts;
- stop implementation drift and issue an amendment when the contract must change.

For zero-context dispatch/review/merge operation, use the Tech Lead bootstrap and contract plus the E1.1 implementation program.

## Implementer agent

The implementer may only implement an eligible Work Order. One Work Order means one branch and one PR.

The implementer must not:

- merge its own PR;
- modify another Work Order's scope;
- modify `spec/development-state/*` during active implementation;
- weaken architecture or assurance;
- create a second authority/state machine/ledger/cache authority;
- introduce undocumented provider semantics into domain modules;
- silently substitute unavailable live infrastructure with simulated PASS claims.

The implementer must report exact revisions, changed surfaces, tests, checkpoint evidence, limitations and PR identity.

## Architecture evolution

Frozen Architecture v1.0 remains authoritative.

Approved subordinate architecture evolutions currently include:

- Deployment/Runtime Architecture D1.0 via ACR-002.
- Execution Intelligence Architecture E1.0 via ACR-003 / ADR-0019.
- Economic Execution Intelligence E1.1 via ACR-004 / ADR-0020.

These augment rather than rewrite v1.0.

## E1.1 non-redundancy invariant

There is exactly one optimization authority: **Execution Compiler**.

Model routing, tool-surface choice, context optimization, cache planning, agent-count selection, retry/escalation, substrate selection and cost estimation are compiler decisions over one Execution IR.

The repository must not introduce independent core authorities for Model Router, Tool Router, Context Optimizer, Cache Optimizer, Agent Optimizer, Sandbox Optimizer, Retry Optimizer or Cost Optimizer.

## E1.1 right-representation invariant

When hard constraints permit, the compiler should search from cheaper to more expensive representations:

```text
deterministic → cache/reuse → verified competence/tool → programmatic execution → sufficient low-cost model/effort → stronger model → profitable parallel/multi-agent → computer use/human escalation
```

This is a constrained optimization preference, not authorization.

## E2B / Daytona / Modal boundary

E2B, Daytona and Modal are execution-substrate adapters. Their snapshots, warm pools, directory snapshots, readiness probes, scheduling and provider-local state are mechanisms, not Zeck authorities.

## Zero-context and zero-drift rule

When a decision is not supported by repository artifacts, do not invent it from memory or external product behavior. Raise a governance finding or request Architect amendment.

When implementation diverges from an issued Work Order, stop rather than rewriting the requirement in code.

## Current-state rule

For current implementation frontier and exact handoff, `docs/LLM-ARCHITECT-HANDOFF.md` is the durable navigation document. `docs/LLM-TECH-LEAD-BOOTSTRAP.md` and `docs/LLM-TECH-LEAD-CONTRACT.md` are the operational dispatch/review controls. `docs/E1.1-IMPLEMENTATION-PROGRAM.md` is the canonical post-D-07 architecture implementation charter.

These supplement, but never override, the architecture lock, Work Orders, development-state JSON, Git ancestry, and verified CI/evidence.
