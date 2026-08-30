# ADR-0012 — Selective Human Evaluation in Planning

**Status:** Accepted
**Architecture:** v1.0 extension
**Related decisions:** ACR-002 / ADR-0009

When automated evaluation cannot confidently distinguish candidate execution strategies, the planner may request a bounded human rating only when the expected information value exceeds the user-effort cost and policy permits it.

Human ratings become immutable evidence linked to the execution, candidate outputs and evaluation question. Ratings are learning signals, not authority overrides. A single low-confidence rating must not silently promote a new production strategy.

The mechanism is optional and should be invoked only where it materially reduces planning uncertainty.
