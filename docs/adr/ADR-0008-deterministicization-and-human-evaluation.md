# ADR-0008 — Deterministicization, Codebase Analysis and Selective Human Evaluation

**Status:** Accepted by architect
**Architecture:** v1.0
**Related decision:** ACR-002

## Context

Zeck must optimize the complete execution strategy, not merely route between models. Repeated executions may reveal subcomputations that can be implemented deterministically. Users may also have existing codebases containing AI calls or AI-like subgraphs whose deterministic or hybrid replacement potential is unclear.

Automated evaluation is sometimes insufficient to distinguish acceptable outcomes, especially for subjective or semantic tasks. Human ratings can therefore provide a selective learning signal when automated evidence is uncertain and the expected information value justifies user effort.

## Decision

Zeck will support a deterministicization lifecycle that can:

1. identify repeated or structurally regular AI subcomputations;
2. propose deterministic or hybrid replacements;
3. synthesize candidate programs/tools when appropriate;
4. validate candidates by replay, differential testing, property/metamorphic testing, mutation testing and policy checks;
5. shadow-test accepted candidates before progressive rollout;
6. recommend or automatically apply replacement only within the applicable policy and authority boundaries.

Zeck will also expose a codebase-analysis capability that can execute or trace selected functions/subgraphs in a customer codebase and report where AI calls are candidates for:

- deterministic replacement;
- hybrid deterministic + AI decomposition;
- cheaper model substitution;
- better context/tooling;
- removal of an unnecessary AI call.

The analysis is advisory unless the customer explicitly authorizes a code mutation workflow.

Zeck will support selective human rating when automated verification cannot confidently resolve competing outputs or replacement candidates. Rating requests must be policy-gated, explain why human input is informative, and become learning evidence only after explicit user submission.

## Constraints

- Deterministicization must never weaken policy, tenant isolation, authorization, verification, budgeting or customer-domain authority.
- A synthesized tool/program is untrusted until validated inside an isolated execution environment.
- Shadow/canary replacement must preserve rollback to the prior execution strategy.
- Human ratings are preference/quality evidence, not authority to bypass security or policy rules.
- The execution abstraction remains unchanged.

## Consequences

The learning system becomes capable of learning not only which model/tool/plan works, but which AI subgraphs can be removed or replaced with verified deterministic computation. Codebase analysis becomes a first-class developer-facing capability built on execution tracing and the same evaluation substrate.
