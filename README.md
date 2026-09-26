# AI Execution OS

AI Execution OS is provider-independent infrastructure for executing AI work as governed, policy-constrained, evidence-producing executions.

It is designed to make AI integration as simple for developers as payments integration: an application declares an outcome and constraints; the platform determines the execution plan across models, tools, algorithms, agents, context strategies, sandboxes, verification and human escalation.

Its strategic role is broader than model orchestration: Zeck optimizes the **computational representation** of work and the expected cost of successfully resolving the outcome, preferring deterministic computation whenever it is sufficiently reliable and using probabilistic AI only where justified.

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

Read `AGENTS.md`, `AI_CONTINUATION.md`, `docs/LLM-ARCHITECT-HANDOFF.md`, `docs/LLM-TECH-LEAD-CONTRACT.md`, `IMPLEMENTATION.md`, then `spec/worker-runbook.md`. Read the governing architecture/lock and development-state JSON files. Run `python3 scripts/governance-check.py`. Only implement a Work Order listed in `spec/development-state/frontier-state.json`.

Every requirement is traced to an owning Work Order in `spec/requirement-traceability.md`; every Work Order contains concrete acceptance criteria, declared surfaces and evidence requirements.

## Start here as an architect / LLM Tech Lead

Read `AGENTS.md`, `AI_CONTINUATION.md`, `docs/LLM-ARCHITECT-HANDOFF.md`, `docs/LLM-TECH-LEAD-BOOTSTRAP.md`, `docs/LLM-TECH-LEAD-CONTRACT.md` and `docs/E1.1-IMPLEMENTATION-PROGRAM.md`.

For post-implementation developer-platform delivery, then read `docs/DEVELOPER-PLATFORM-DEPLOYMENT-ROADMAP.md` and `docs/LLM-DEVELOPER-PLATFORM-TECH-LEAD-CONTRACT.md`. This program is separate from the completed core and validation programs and is the authority for public deployment, console, sandbox and developer/agent onboarding work.

The Tech Lead may dispatch **at most three concurrent implementation workers**, and only after dependency, source-surface, migration, public-contract, test and evidence conflict analysis proves that reconciliation can be mechanical.

## Architecture and roadmap evolution

- `docs/adr/ADR-0017-procedural-competence-and-runtime-interoperability.md` — reusable procedural competence, session/gateway interoperability and external runtime adapters.
- `docs/adr/ADR-0018-agentic-economic-actions-and-payment-rails.md` — provider-neutral agentic economic actions and payment-rail adapters.
- `docs/adr/ADR-0019-execution-intelligence-architecture.md` — Execution Intelligence Architecture E1.0.
- `docs/adr/ADR-0020-economic-execution-intelligence-e1.1.md` — E1.1 refinement: expected successful-resolution economics with one Execution Compiler.
- `docs/architecture-changes/ACR-003-execution-intelligence-architecture.md` — approved E1.0 architecture-change record.
- `docs/architecture-changes/ACR-004-economic-execution-intelligence-e1.1.md` — approved E1.1 architecture-change record.
- `docs/E1.1-IMPLEMENTATION-PROGRAM.md` — exact post-D-07 implementation sequence and zero-drift boundaries.
- `docs/E1.1-RESEARCH-BASELINE.md` — external evidence and adopted/non-adopted lessons.
- `docs/ROADMAP.md` — authoritative forward roadmap.
- `docs/VALIDATION-ROADMAP.md` — completed customer-style validation program.
- `docs/VALIDATION-REPORT.md` — cumulative validation evidence and findings.
- `docs/DEVELOPER-PLATFORM-DEPLOYMENT-ROADMAP.md` — public deployment + developer console + sandbox program.
- `docs/LLM-DEVELOPER-PLATFORM-TECH-LEAD-CONTRACT.md` — zero-context Tech Lead execution contract for that program.

## Current delivery program

The core implementation, validation program and Developer Platform delivery program are complete. The active post-release work is now the Application Compatibility Proof Program, with operator-bound capability work tracked separately.

Authoritative program:
 docs/APPLICATION-COMPATIBILITY-PROOF-PROGRAM.md

Current executable Work Orders are recorded in:
 spec/post-release-state/frontier-state.json

The north star is a set of real Zeck-powered demonstrations across representative open-source AI application categories. Certification is strict: every material AI execution edge must be delegated through Zeck; completeness is never redefined to make a demo pass.

The website Demo Mirror is a proof surface into the same pinned application integrations, with real execution traces, evidence, cost/latency facts, limitations and reproduction paths.

## Provider strategy

Prefer providers in this order during development and sandbox operation:

```text
free tier
  → usage-based / no-minimum
  → low fixed cost
  → paid / enterprise only when justified
```

The provider map remains provider-neutral. Current candidate infrastructure includes Cloudflare Workers/Pages where compatible, Neon for early PostgreSQL environments, Cloudflare R2 for artifact bytes, and existing Vercel delivery where the plan and commercial terms permit it. Disposable free-tier resources must never become authoritative or operationally critical. Exact current limits and terms are verified by the Tech Lead at dispatch time.

## Strategic execution principle

For every governed outcome:

```text
deterministic
 → cache/reuse
 → verified competence/tool
 → programmatic execution
 → sufficient low-cost model/effort
 → stronger model
 → profitable parallel/multi-agent
 → computer use / human escalation
```

This is a constrained optimization preference, not a permission system. Quality, policy, capability, budget, tenant, verification and safety constraints always dominate.

## E1.1 non-redundancy rule

There is one optimization authority: **Execution Compiler**.

Model routing, tool routing, context optimization, cache planning, agent-count selection, retry/escalation, substrate selection and cost optimization are decisions over the shared Execution IR, not separate authorities.

E2B, Daytona and Modal are execution-substrate adapters; provider-native snapshots, warm pools, readiness probes and scheduling remain provider mechanisms.

## Status

Architecture v1.0 is the governing frozen baseline. D1.0, E1.0 and E1.1 are subordinate approved augmentations. Any change to frozen v1.0 requires the Architecture Change Request process; workers have no authority to drift the architecture through implementation.