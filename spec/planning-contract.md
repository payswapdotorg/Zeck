# Planning Contract — Deterministic-First Execution

**Architecture:** v1.0
**Decision:** ACR-001 / ADR-0007
**Status:** Approved

## Rule

The planner must determine whether AI is required before choosing a specific model/provider/agent.

A deterministic capability is preferred whenever it can satisfy the task requirements and effective policy constraints. The planner may choose generative inference when the task requires semantic or generative reasoning, deterministic computation is insufficient, or evidence-based expected improvement materially justifies additional cost, latency, or risk.

## Planning order

```text
task
  -> policy constraints
  -> capability requirements
  -> deterministic sufficiency check
  -> candidate execution strategies
  -> provider/model/agent selection where required
  -> verification strategy
```

## Deterministic candidates

The capability set must be able to represent, at minimum:

- calculators and arithmetic
- database queries and lookups
- sorting, filtering and aggregation
- parsers and schema validators
- deterministic transformations
- compilers, tests and static analyzers
- retrieval and search systems
- domain-specific algorithms
- program execution

## Hybrid execution

Deterministic-first does not mean deterministic-only. A plan may combine deterministic computation and generative inference. For example:

```text
retrieve -> parse -> deterministic checks -> model interpretation -> verify
```

## Cost rule

Avoiding an unnecessary model call is a first-class optimization. A plan using no model is valid when it produces the required verified outcome.

## Safety rule

A deterministic capability is preferred only when it is sufficient under the effective policy. Higher-authority policy restrictions, security controls, verification requirements and customer-domain authority remain binding.

## Required future discrimination proof

The planning implementation must include a discrimination test that fails a mutant which always selects a generative model even when an admissible deterministic capability can satisfy the task without materially reducing the verified outcome.
