# Deterministicization Contract

**Architecture:** v1.0
**Decision:** ACR-002 / ADR-0008
**Status:** Approved

## Purpose

Deterministicization identifies AI execution subgraphs that can be replaced, simplified or supplemented by deterministic computation without materially reducing the verified outcome.

## Candidate classes

A candidate may be:

- a complete AI call that can be removed;
- an AI call that can be replaced by a deterministic function or algorithm;
- an AI subgraph that can be split into deterministic preprocessing plus residual AI reasoning;
- an AI subgraph that can be replaced by a retrieval/database/program pipeline;
- a repeated normalization/classification/transformation step suitable for a reusable tool.

## Evidence required for promotion

A candidate must progress through:

```text
observe
  -> characterize
  -> synthesize/propose
  -> offline replay
  -> differential evaluation
  -> property/metamorphic tests
  -> mutation tests
  -> shadow execution
  -> canary
  -> promotion
```

The candidate must retain provenance to the executions, datasets, tests and policy under which it was evaluated.

## Differential requirement

Where an AI implementation exists, the deterministic candidate must be compared against the incumbent on representative historical inputs and appropriate adversarial cases. Equality is not required for semantic outputs, but the acceptance criterion must be explicit and verified.

## Safety

A deterministic replacement cannot bypass policy admission, tenant boundaries, authorization, budgets, verification or customer-domain authority. Synthesized programs/tools are treated as untrusted code until isolated validation succeeds.

## Rollback

Production promotion must be reversible to the previous execution plan or implementation.

## Codebase analysis

Zeck may analyze customer-selected functions, traces or execution subgraphs and return advisory findings. Findings must identify the candidate subgraph, observed behavior, proposed deterministicization, evidence quality, expected cost/latency impact, and confidence. Analysis does not mutate customer code without explicit authorization.

## Human evaluation

When automated evidence is insufficient to distinguish outputs or candidate strategies, the planner may request a rating task. Rating prompts must minimize user effort and present only candidates relevant to the unresolved decision. Ratings are stored as explicit human evidence and preference signals, not as authorization to bypass policy.
