# Architecture Evolution Note — Deterministicization and Human Evaluation

**Governing architecture:** v1.0
**Approved decision:** ACR-002 / ADR-0008 / ADR-0009

This note is append-only and does not replace the frozen v1.0 architecture document.

## Approved evolution

Zeck may learn to replace recurring AI subgraphs with deterministic or hybrid computation through a validated lifecycle. It may also analyze customer-selected codebase subgraphs and provide advisory recommendations for adding, removing or restructuring AI computation.

Human ratings are a selective evidence mechanism for unresolved quality/preference uncertainty. They do not constitute policy or workflow authority.

## Planner implication

The existing deterministic-first contract remains mandatory. Deterministicization adds a feedback loop in which successful executions provide evidence for future plan simplification.

## Authority boundary

No learning or deterministicization mechanism may bypass policy admission, budget controls, tenant isolation, verification gates, sandbox isolation or customer-domain authority.
