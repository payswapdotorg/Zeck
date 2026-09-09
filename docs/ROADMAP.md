# Zeck Roadmap — Governed AI Execution Infrastructure

## Mission

Zeck is the neutral execution optimization layer for AI work. Developers declare outcomes and constraints; Zeck selects the cheapest sufficiently reliable computational representation while preserving policy, capability, budget, verification, safety and tenant authority.

### Canonical optimization rule

> **For every governed outcome, choose the lowest expected-cost execution representation that satisfies policy, capability, quality, reliability, latency, verification and side-effect constraints.**

The unit of optimization is the **successful outcome**, not the isolated model call.

## Core architectural rule

Execution remains the universal durable abstraction.

No roadmap feature may create a second authority for execution lifecycle, policy, capabilities, budgets/economics, tenant identity, credentials/secrets, sandbox/substrate or verification.

Learning and benchmarking produce evidence/recommendations; they do not silently authorize behavior.

## Completed foundations

Provider federation/BYOK, budgets, capabilities, execution lifecycle, durable evidence, tenant isolation, deterministic-first planning, context compilation, verification, learning telemetry, tool composition, agent fabric, sandboxes, developer API/SDK/CLI/dashboard, WorkflowOS interoperability and deployment/runtime D1.0 through D-06 are complete.

Current authorized deployment work remains D-07 / WORK-048.

## E1.0 — Execution Intelligence

Approved by ACR-003 / ADR-0019. E1.0 adds optimization between Planning and Execution without changing authority.

```text
Intent → Policy → Capability → Planning → Execution Compiler → Optimized Execution IR → Execution → Verification → Evidence → Learning
```

E1.0 defines Execution IR, deterministic transformations, tool-surface compilation, programmatic tool calling, context economy, safe parallelism/batching/reuse, multi-agent economics, failure attribution, continuation, competence-aware optimization and progressive deterministicization.

## E1.1 — Economic Execution Intelligence

Approved by ACR-004 / ADR-0020.

E1.1 is a refinement of E1.0, not a new architecture generation.

### One compiler, many decisions

There is exactly one optimization authority: **Execution Compiler**.

Do not create independent core authorities for model routing, tool routing, context optimization, cache optimization, agent optimization, sandbox optimization, retry optimization or cost optimization.

These are compiler decisions over one Execution IR.

### Optimization dimensions

The compiler may jointly consider:

- deterministic computation;
- cache/reuse and prior successful work;
- verified competence and existing tools;
- bounded programmatic execution;
- tool-surface size and representation;
- context size/redundancy/cacheability;
- duplicate-work coalescing;
- model and reasoning effort;
- safe parallelism and batching;
- 0/1/N agent execution;
- retry, reroute and fresh escalation;
- verification cost;
- sandbox readiness/startup;
- compute substrate and region;
- inference/service tier;
- expected reliability and latency.

### Expected successful-resolution cost

The optimizer evaluates the whole execution economics:

```text
Expected cost =
  direct execution
+ expected retry
+ expected escalation
+ expected verification
+ expected substrate/control-plane
+ expected duplication
+ policy-required risk/latency penalty
```

Observed measurements replace estimates as evidence accumulates.

### Representation ladder

```text
deterministic
 → cache/reuse
 → verified competence/tool
 → programmatic execution
 → sufficient low-cost model/effort
 → stronger model
 → profitable parallel/multi-agent
 → computer use / human escalation where justified
```

This is a constrained search preference, not a mandatory pipeline.

### Context/tool economics

Large intermediate data should remain outside model context whenever semantic inspection is unnecessary. Tools should be filtered by capability, policy and task relevance. Provider cache state is disposable and never authoritative.

### Duplicate-work coalescing

Equivalent in-flight work may be shared when freshness, tenant, policy, budget, provenance, identity and verification conditions permit.

### Failure-aware escalation

Failures are classified before retry/escalation. Infrastructure/provider/tool/resource failures are not silently attributed to model intelligence. Failed reasoning is not automatically replayed indefinitely; fresh escalation is selected when evidence indicates continuation would compound cost or failure.

### Substrate economics

Zeck consumes provider-neutral substrate facts including isolation, resources, region, snapshot/warm readiness, startup/readiness latency, cost class and interruption/recovery semantics.

E2B, Daytona, Modal, customer compute and self-hosted runtimes are adapters only. Provider-specific snapshots, warm pools, directory snapshots, readiness probes and scheduling remain provider mechanisms.

### Service tiers

Where a provider supports different execution classes, the compiler may choose real-time/on-demand, flexible, batch or priority execution when the outcome permits the trade-off.

### Optimization Decision Record

Material optimization decisions must record candidates, hard constraints, selected representation, measured/estimated quality, expected cost/latency, transformation basis and provenance. The record is evidence, not authorization.

## E1.1 executable implementation program

The canonical implementation charter is:

`docs/E1.1-IMPLEMENTATION-PROGRAM.md`

The post-D-07 implementation sequence is:

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

Future Work Orders are not executable merely because this roadmap names them. The Architect must issue each Work Order and dependency/frontier state must authorize it.

## Current deployment frontier

`WORK-048 / D-07` is the current executable work. D-08 remains blocked pending D-07 completion, measured production usage, explicit availability/security requirements and any required architecture extension.

## External ecosystem

OpenClaw, Hermes and WorkflowOS remain adapter/participant ecosystems. Payment rails remain adapters behind EconomicAction/PaymentAuthority. They do not become Zeck authorities.

## Computer use

Computer use is an escalation representation:

```text
API / deterministic
 → existing tool / competence
 → browser
 → isolated desktop / terminal
```

Use it only when cheaper deterministic/tool representations are insufficient for the required outcome.

## Product optimization

Eventually Zeck may surface advisory opportunities such as:

- unnecessarily generative subgraphs;
- deterministic replacements;
- context/tool-surface reduction;
- model/reasoning downsizing;
- unnecessary multi-agent execution;
- duplicate-work opportunities;
- infrastructure-vs-intelligence failure patterns;
- competence reuse;
- human evaluation where uncertainty warrants it.

Recommendations remain advisory until normal validation and promotion gates pass.

## Work Order discipline

One Work Order = one branch = one PR.

Every Work Order requires exact dependencies, requirement ownership, declared/forbidden surfaces, assurance profile, acceptance criteria, checkpoint contracts, evidence contract, migration policy and completion boundary.

Maximum concurrent implementation workers: **3**.

Parallel implementation is allowed only when surface, migration, shared-state, public-contract, package/toolchain and evidence conflict analysis proves mechanical reconciliation.

## Strategic end state

```text
Developer outcome + constraints
             ↓
     Policy / Capability / Budget
             ↓
           Planning
             ↓
     Execution Compiler
             ↓
    Optimized Execution IR
             ↓
 deterministic / tool / program
       / competence / model
    / multi-agent / substrate
             ↓
          Execution
             ↓
        Verification
             ↓
          Evidence
             ↓
          Learning
             ↓
 competence / deterministicization
```

Zeck does not aim to become the largest agent framework, model provider, sandbox vendor, payment processor or browser controller. Its strategic role is to sit across those systems and optimize the execution representation while preserving governed authority.
