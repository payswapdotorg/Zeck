# ADR-0007 — Deterministic-First Planning

**Status:** Accepted
**Architecture:** v1.0
**Related ACR:** ACR-001 / Issue #15

## Context

AI Execution OS is intended to maximize verified outcome quality per unit of cost and to avoid using generative inference when a deterministic computation can satisfy the task. The v1.0 architecture already establishes both capability-before-provider selection and deterministic computation as a first-class execution capability.

## Decision

The planner SHALL evaluate whether deterministic computation can satisfy the task before selecting generative inference as an execution mechanism.

A deterministic capability is preferred when it satisfies the task requirements and effective policy constraints. Generative inference is permitted when semantic/generative reasoning is required, deterministic computation is insufficient, or the expected verified improvement materially justifies the incremental cost, latency, or risk.

The planner may combine deterministic and generative steps in the same Execution.

## Examples

- Arithmetic → calculator/program, not an LLM.
- Database lookup → database query, not an LLM hallucinated answer.
- Sorting/filtering/aggregation → deterministic algorithm/database operation.
- Contract analysis → deterministic parsing/retrieval plus generative reasoning where interpretation is required.
- Ambiguous natural-language intent → generative reasoning may be primary.

## Consequences

- The planning engine must represent deterministic capabilities as first-class candidates.
- Model/provider/agent selection remains downstream of capability resolution.
- Planner tests must detect an implementation that chooses a generative model when a sufficient deterministic capability exists.
- Cost optimization must include elimination of unnecessary model calls, not only cheaper model routing.
