# ADR-0011 — Deterministic-First Planner Implementation Contract

**Status:** Accepted
**Architecture:** v1.0 extension
**Related decisions:** ACR-001 / ADR-0007 / ACR-002

## Decision

WORK-009 is not a conventional model router. Its planner must explicitly evaluate deterministic sufficiency before generative inference selection and must be able to produce successful zero-model execution plans.

The planner must represent candidate strategies across deterministic, retrieval, tool, model, agent and hybrid computation. Provider/model selection is downstream of capability resolution and deterministic sufficiency.

The planner must emit enough structured evidence to support later deterministicization discovery and codebase opportunity analysis, without allowing future learning to bypass policy or authority boundaries.

## Required properties

1. Deterministic-first decisions are explicit and auditable.
2. Zero-model plans are valid first-class plans.
3. Hybrid plans are first-class.
4. Always-generative selection when deterministic computation is sufficient is a detectable planning defect.
5. Uncertainty may trigger bounded comparison/evaluation rather than unconditional escalation to a model.
6. Plan evidence records candidate strategies, expected cost/quality, verification strategy and rationale.

This ADR adds implementation constraints without changing the frozen execution abstraction or authority boundaries.
