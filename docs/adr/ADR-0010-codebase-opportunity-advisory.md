# ADR-0010 — Codebase Opportunity Advisory

**Status:** Accepted
**Architecture:** v1.0

## Decision

Zeck will offer an advisory analysis mode for customer-selected codebase functions, call graphs and execution traces. The analysis identifies where generative AI, deterministic code, retrieval, tools or hybrid decomposition are likely to improve the execution strategy.

The advisory mode is read-only by default. Any code mutation or production rollout requires an explicitly authorized execution and the normal verification/promotion gates.

## Analysis outputs

Each finding should include:

- subgraph/function identity and source provenance;
- observed execution behavior;
- recommendation class;
- candidate deterministic/hybrid strategy;
- expected quality, cost and latency impact;
- confidence and uncertainty reasons;
- supporting evidence;
- validation steps needed before adoption.

## Learning

Accepted/rejected recommendations and user feedback become labeled evidence for future opportunity detection.
