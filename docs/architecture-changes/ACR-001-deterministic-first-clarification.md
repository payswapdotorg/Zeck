# ACR-001 — Deterministic-First Planning Clarification

**Status:** Approved
**Architecture:** v1.0
**Issue:** #15
**Authority:** Architect

## Decision

Clarify the existing v1.0 principle `Deterministic computation is first-class` as an explicit planner-selection rule.

When a deterministic capability can satisfy the task requirements and effective policy constraints, the execution planner must prefer that capability over generative inference. Generative inference is appropriate when the task requires semantic/generative reasoning, deterministic computation is insufficient, or the expected verified improvement materially justifies its additional cost, latency or risk.

This clarification does not prohibit hybrid plans. Deterministic and generative steps may be combined in one Execution when that produces the required verified outcome.

## Architectural interpretation

This is an operational clarification of existing v1.0 invariants 2.5 (`Capability before provider`) and 2.6 (`Deterministic computation is first-class`). It does not weaken any authority, security, provider-isolation, verification, budget, or customer-domain boundary.

## Required planner behavior

The planning contract must answer **whether AI is required** before selecting a specific model/provider/agent. A deterministic capability that is sufficient under the task and policy constraints is the preferred execution path.

The planner may introduce AI when deterministic computation is insufficient, when semantic generation is inherently required, or when evidence-based expected improvement justifies the additional resource use.

## Consequences

- Planner implementations must represent deterministic capabilities as first-class candidates.
- Model/provider selection remains downstream of capability selection.
- Future planner tests must discriminate against an implementation that always selects generative inference when a sufficient deterministic capability exists.
- Cost optimization must include avoiding unnecessary generative inference, not only selecting cheaper models.
- Existing completed Work Orders remain governed by the historical v1.0 contracts under which they were accepted.
