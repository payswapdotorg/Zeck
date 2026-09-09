# ACR-004 — Economic Execution Intelligence E1.1

**Status:** APPROVED architectural augmentation
**Date:** 2026-09-09
**Authority:** Architect
**Supersedes:** None
**Builds on:** ACR-003 / ADR-0019 (E1.0)

## Decision

Zeck E1.0 is refined into **Economic Execution Intelligence E1.1** without creating a new execution authority, planner, router service, cache authority, sandbox authority, or provider-specific control plane.

E1.1 strengthens the existing Execution Compiler so it optimizes the **complete expected cost of successfully resolving a governed outcome**, rather than optimizing model-token cost in isolation.

The optimization target is:

> **Choose the lowest expected-cost execution representation that satisfies policy, capability, quality, reliability, latency, verification and side-effect constraints.**

Expected execution cost includes model/inference cost, context cost, tool/control-plane overhead, retries, escalation, verification, sandbox readiness/startup, substrate cost, transport overhead and avoidable duplicate work.

## 1. Authority boundary

E1.1 remains subordinate to frozen v1.0 and existing D1.0/E1.0 authorities.

The compiler may optimize a governed plan, but may not:

- grant capabilities;
- alter policy;
- authorize spending;
- replace the execution authority;
- replace verification;
- make providers authoritative;
- promote learned behavior without existing validation/promotion gates;
- bypass tenant or secret boundaries.

## 2. Consolidation rule

E1.1 deliberately uses **one Execution Compiler** for optimization decisions.

The repository MUST NOT introduce independent core authorities named or functioning as:

- Model Router;
- Tool Router;
- Context Optimizer;
- Cache Optimizer;
- Agent Optimizer;
- Sandbox Optimizer;
- Retry Optimizer;
- Cost Optimizer.

Those concerns are compiler decisions over the same Execution IR. Concrete provider/runtime adapters remain subordinate infrastructure mechanisms.

## 3. Canonical optimization dimensions

The compiler MAY optimize jointly over:

- correctness/quality likelihood;
- model selection;
- reasoning effort;
- deterministic versus probabilistic representation;
- existing tool/competence versus newly generated work;
- programmatic orchestration;
- tool-surface size and representation;
- context size, redundancy and cacheability;
- result reuse and memoization;
- duplicate-work coalescing;
- safe parallelism and batching;
- multi-agent count;
- retry/recovery strategy;
- fresh escalation versus continuation;
- verification burden;
- sandbox readiness/startup;
- compute substrate;
- region and locality;
- service/inference tier;
- expected latency;
- expected provider/infrastructure failure;
- privacy and side-effect exposure.

## 4. Execution-cost model

Every optimization candidate SHOULD be evaluated against a bounded expected-cost model:

```text
Expected successful-resolution cost =
  direct execution cost
+ expected retry cost
+ expected escalation cost
+ expected verification cost
+ expected substrate/control-plane cost
+ expected duplication cost
+ latency/risk penalty where policy requires
```

Observed measurements replace estimates when sufficient evidence exists.

The compiler MUST preserve quality/reliability constraints; cost reductions are not valid when they knowingly reduce the required assurance level.

## 5. Execution representations

The compiler chooses among representations rather than assuming every task is a model invocation:

```text
deterministic computation
 → cached/reused result
 → existing competence/tool
 → programmatic execution
 → small/sufficient model
 → higher reasoning effort
 → larger/stronger model
 → profitable parallel/multi-agent execution
 → computer use / human escalation where justified
```

The exact ordering is task-dependent, but the invariant is that cheaper sufficient representations are evaluated before more expensive ones.

## 6. Reuse and coalescing

E1.1 adds first-class optimization of work already performed:

- memoizable results;
- reusable context/prefixes;
- prior successful execution artifacts;
- equivalent in-flight work;
- compatible competence;
- shared deterministic subgraphs.

Duplicate-work coalescing MUST preserve execution identity, tenant isolation, policy, budget accounting, provenance and verification semantics.

## 7. Fresh escalation

A failed execution MUST be classified before retry/escalation.

When the cause is intelligence failure, blindly replaying the same failing reasoning chain is not the default. The compiler SHOULD prefer a fresh strategy when evidence indicates that reuse would compound failure or cost.

Infrastructure/provider/tool/resource failures should be rerouted or retried according to their failure classes rather than counted as model-intelligence failures.

## 8. Context and cache economics

Context is an optimization resource.

The compiler SHOULD minimize uncached input, unnecessary tool definitions, repeated system material, redundant intermediate results and sensitivity exposure.

When a provider exposes deterministic cache controls, Zeck MAY use them, but provider cache state remains non-authoritative and disposable.

Cache keys and prefixes MUST respect tenant, application, policy and sensitivity boundaries.

## 9. Substrate economics

The provider-neutral substrate contract SHOULD expose enough facts to compare compute options, including where applicable:

- isolation class;
- CPU/memory/GPU resources;
- region;
- persistent/snapshot state;
- warm availability;
- readiness state;
- expected startup/readiness latency;
- cost class;
- interruption/recovery semantics.

E2B, Daytona, Modal, customer-owned runtimes and self-hosted compute are adapters. Their provider-specific optimizations remain outside Zeck's domain authority.

## 10. Warm execution and readiness

Zeck SHOULD distinguish:

```text
created → scheduled → started → ready → in-use
```

A sandbox being started is not equivalent to being useful.

Warm pools, snapshots, directory snapshots and readiness probes are provider mechanisms that may be selected when their expected savings outweigh idle-resource cost and lifecycle complexity.

## 11. Service-tier economics

The compiler MAY choose workload service classes such as real-time/on-demand, flexible, batch or priority when the provider supports them and the requested outcome permits the latency/availability trade-off.

The service tier is a resource-selection property, not a new authority.

## 12. Quality and safety guardrails

The compiler MUST preserve:

- existing assurance profile;
- verification requirements;
- policy decisions;
- capabilities;
- budgets;
- tenant boundaries;
- secret mediation;
- durable execution identity;
- authoritative side-effect ordering;
- evidence/provenance.

An optimization that violates any of these preconditions is invalid regardless of cost savings.

## 13. Optimization Decision Record

Every material compiler optimization MUST be explainable from deterministic facts or explicitly bounded evidence:

- candidate representations considered;
- hard constraints;
- estimates/observations used;
- selected representation;
- expected quality/reliability condition;
- expected cost/latency condition;
- transformation basis;
- provenance.

The record is evidence, not a new authorization surface.

## 14. External lessons adopted

The architecture intentionally incorporates proven industry patterns without importing their control-plane authority:

- programmatic tool execution and retained/compacted reasoning;
- prompt/context caching;
- adaptive model routing and model specialization;
- batch/flexible inference tiers;
- warm execution and snapshots;
- application-level readiness measurement;
- task-specific and deterministic work extraction.

## 15. Non-goals

E1.1 does not create:

- a new standalone optimization platform;
- a universal inference engine;
- a proprietary sandbox runtime;
- a universal MCP dependency;
- an always-on multi-agent system;
- a second cache authority;
- provider-specific business logic in domain modules;
- a separate economic authority.

## 16. Implementation sequence

The canonical implementation program is `docs/E1.1-IMPLEMENTATION-PROGRAM.md`.

Implementation MUST proceed only through repository-resident Work Orders generated from that program.

No worker may infer additional architecture from external provider capabilities, benchmarks or chat instructions.

## 17. Exit criteria for E1.1

E1.1 is architecturally complete only when the implementation program has produced:

1. executable Execution IR with invariant checks;
2. deterministic compiler transformations;
3. minimal tool-surface selection;
4. bounded programmatic execution;
5. context/cache/reuse/coalescing optimization;
6. adaptive model/reasoning/multi-agent selection;
7. provider-neutral substrate/service-tier selection with tested adapters;
8. failure-aware retry/fresh-escalation and continuation;
9. competence-aware selection;
10. verified deterministic replacement/promotion.

Every capability requires exact-revision proof and remains subordinate to v1.0 authority.
