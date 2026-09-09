# ACR-003 — Execution Intelligence Architecture

**Status:** Approved
**Architecture:** v1.0 + Execution Intelligence E1.0
**Date:** 2026-09-09
**Authority:** Architect

## Decision

Approve **Execution Intelligence Architecture E1.0** as a subordinate, additive architecture to frozen core v1.0.

E1.0 standardizes deterministic optimization of governed execution plans. It does not replace Planning, Execution, Policy, Capability, Budget, Sandbox, Verification, Evidence or Learning authorities.

The architecture exists to advance Zeck's mission:

> For each requested outcome, choose the cheapest sufficiently reliable computational representation, and progressively replace probabilistic work with deterministic work when evidence permits.

## Strategic scope

E1.0 covers:

- Execution Intermediate Representation (IR)
- Execution Compiler / Optimization Plane
- Tool Surface Compiler
- programmatic tool calling
- context economics and intermediate-data minimization
- deterministic parallelization, batching, memoization and reuse
- model downsizing and AI-call elimination
- multi-agent economic gating
- infrastructure-vs-intelligence failure attribution
- reusable evaluation assets
- execution continuation packages
- competence-aware optimization
- progressive deterministicization

## Frozen-architecture relationship

The existing v1.0 sequence remains authoritative:

```text
Intent
  ↓
Policy
  ↓
Capability
  ↓
Planning
  ↓
Execution
  ↓
Verification
  ↓
Evidence
```

E1.0 inserts optimization after a governed plan is available:

```text
Intent
  ↓
Policy
  ↓
Capability
  ↓
Planning
  ↓
Execution Compiler / Optimization Plane
  ↓
Optimized Execution IR
  ↓
Execution
  ↓
Verification
  ↓
Evidence
  ↓
Learning
```

The compiler is not an authorization authority.

## Authority invariants

The optimization plane cannot:

- grant policy permissions
- grant capabilities
- bypass budgets
- approve payments
- mutate execution state outside the execution authority
- treat learning signals as authorization
- treat model output as verification
- execute generated code outside the sandbox/substrate authority
- create a second planner
- create a second execution ledger/state machine
- create a second learning authority

## Implementation sequencing

The architecture is intentionally incremental:

### E1 — Execution IR

Machine-readable step properties, dataflow and provenance.

### E2 — Execution Compiler

Safe transformations such as constant folding, dead-step elimination, reuse, batching, parallelization and AI-call elimination.

### E3 — Tool Surface Compiler

Minimize exposed tools/context and choose appropriate representations among direct tools, deferred tools, scripts, CLI, code APIs, MCP and competence.

### E4 — Programmatic tool calling

Permit bounded sandboxed orchestration code to invoke tools and reduce large intermediate results before they enter model context.

### E5 — Context Economy

Measure and optimize context size, redundancy, information density, intermediate result volume and retrieval/tool-definition overhead.

### E6 — Evaluation / failure attribution

Separate intelligence failure from provider/tool/sandbox/infrastructure/resource/timeout/policy/capability/verification failures and fingerprint relevant environments.

### E7 — Multi-agent optimization

Select 0/1/N agents according to expected quality benefit, parallelism, cost, latency and verification burden.

### E8 — Continuation

Standardize durable continuation packages for long-running and interrupted executions.

### E9 — Competence-aware optimization

Use ADR-0017 competences as executable optimization candidates and retrieve only the competence needed for the current task.

### E10 — Progressive deterministicization

Turn repeated successful probabilistic procedures into candidate deterministic procedures, validate them, shadow-test them and promote only after evidence supports equivalence.

## Product principle

Zeck should expose the optimization decision as a product feature:

```text
user outcome
    ↓
Zeck determines computational representation
    ↓
deterministic where sufficient
    ↓
tools / competence where useful
    ↓
smallest sufficient model
    ↓
large model only when justified
    ↓
multi-agent only when economically justified
    ↓
human only when uncertainty warrants it
```

This is the core differentiator, not any individual model, agent framework, payment rail or deployment provider.

## Relationship to current architecture streams

E1.0 composes with:

- ADR-0017 — procedural competence and runtime interoperability
- ADR-0018 — agentic economic actions and payment rails
- D1.0 — deployment/runtime architecture
- WORK-018 — validated tool synthesis
- WORK-020 — learned execution planning and policy optimization
- WORK-021 — deterministicization discovery and AI-call elimination
- WORK-022 — codebase opportunity analysis and selective human evaluation
- WORK-027 — governed computer use

These are extended rather than replaced.

## Approval boundary

This ACR approves the architecture and sequencing only. Implementation remains authorized only through repository Work Orders with explicit requirements, dependencies, declared surfaces, assurance profile, acceptance criteria, checkpoint contracts and evidence.

The current active Work Order is not changed by this ACR.
