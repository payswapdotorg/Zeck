# ADR-0009 — Selective Human Evaluation as Evidence

**Status:** Accepted
**Architecture:** v1.0

## Decision

Zeck may request a user or human to compare candidate outputs or rate an execution when automated verification leaves material uncertainty and the expected information value justifies the interaction cost.

Human evaluation is not a generic fallback for every uncertain execution. The planner must estimate whether the rating will materially reduce decision uncertainty.

Ratings are immutable evidence tied to the execution, candidate outputs and evaluation question. They may improve future model/tool/context/plan decisions but cannot override policy, authorization, tenant, budget or customer-domain authority.

## Supported forms

- pairwise preference between two candidate outputs;
- scalar quality rating against explicit criteria;
- accept/reject a deterministicization candidate;
- identify which execution step was deficient.

## Privacy and minimization

The rating task should contain only the minimum information required to answer the question and must honor the execution's effective privacy policy.

## Learning

Human decisions are labeled evidence, not truth by default. The learning system records rater context, question, candidates, decision, confidence when available, and downstream outcome.
