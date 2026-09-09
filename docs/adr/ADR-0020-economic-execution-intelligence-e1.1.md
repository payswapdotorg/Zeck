# ADR-0020 — Economic Execution Intelligence E1.1

**Status:** Accepted architectural augmentation
**Architecture:** v1.0 + D1.0 + E1.0 + E1.1
**Date:** 2026-09-09
**Authority:** Architect

## Context

E1.0 correctly establishes an Execution Compiler, Execution IR, tool-surface optimization, programmatic tool calling, context economy, parallelism, multi-agent economics, failure attribution, continuation, competence-aware optimization and progressive deterministicization.

Current production AI systems demonstrate that reducing model-token cost alone is insufficient. Cost and quality are affected by model selection, reasoning effort, context caching, tool-surface size, programmatic data processing, repeated work, retries, escalation, inference service tiers and sandbox readiness/startup. Runtime platforms also show that application readiness and warm execution can dominate infrastructure boot time.

## Decision

Refine E1.0 into **Economic Execution Intelligence E1.1**.

The single Execution Compiler becomes the coordination point for optimization decisions. No new optimization authority is introduced.

The primary objective becomes:

> Choose the lowest expected-cost execution representation that satisfies policy, capability, quality, reliability, latency, verification and side-effect constraints.

The compiler may select and compose:

- deterministic computation;
- cached/reused results;
- verified competence;
- governed tools;
- bounded programmatic execution;
- smaller or lower-effort models;
- stronger models where justified;
- safe parallel/multi-agent execution;
- alternative compute substrate;
- alternative inference/service tier;
- browser/computer-use fallback;
- human escalation where policy and uncertainty require it.

## Architectural non-redundancy rule

Model routing, tool ranking, context reduction, cache planning, agent-count selection, retry strategy, substrate selection and cost estimation are **not separate platform authorities**. They are optimization decisions over the same governed Execution IR.

No new durable state machine may be introduced for any of these concerns.

## Required decision evidence

Every material optimization must record its input constraints, candidate representations, selected representation, cost/latency expectations, quality/reliability expectation, transformation basis and provenance.

The decision record is evidence only; it does not authorize an action.

## Runtime-provider boundary

E2B, Daytona, Modal and future compute systems are provider adapters behind a neutral substrate contract. Provider snapshots, warm pools, readiness probes, directory snapshots, scheduling, GPU placement and runtime-specific caching remain provider mechanisms.

Zeck may consume measured provider capabilities and costs to select a substrate but must not import provider control-plane authority into the domain model.

## Quality-preserving economics

A cheaper representation is invalid when its measured or bounded expected quality/reliability falls below the Work Order's required assurance threshold.

Model escalation should be evidence-driven. Intelligence failures and infrastructure/provider/tool failures must be distinguished so retries and routing do not create runaway token inflation or misattribute environmental defects to model quality.

## Alternatives rejected

### One optimizer service per concern

Rejected because it recreates orchestration fragmentation and creates competing state/decision authorities.

### Always route through a dedicated model router

Rejected because the optimal representation may be deterministic code, reuse, a tool, a program, a sandbox or a human—not merely a different model.

### Always use warm pools

Rejected because idle-resource cost and lifecycle complexity can outweigh latency benefit.

### Make E2B/Daytona/Modal core runtime implementations

Rejected because the providers are execution substrates, not Zeck authorities.

### Add a separate cost ledger for optimization

Rejected. Existing Budget/Economic authority remains canonical. Optimization consumes budget facts; it does not redefine spending authority.
