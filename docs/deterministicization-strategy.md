# Deterministicization Strategy

Zeck should progressively replace AI work with deterministic computation when evidence shows the deterministic alternative can satisfy the same task requirement under the effective policy.

## Runtime path

```text
task
 -> execution trace
 -> recurring subgraph detection
 -> deterministicizability analysis
 -> candidate implementation/tool
 -> replay
 -> differential evaluation
 -> property/metamorphic tests
 -> mutation tests
 -> sandbox validation
 -> shadow execution
 -> canary
 -> promote or rollback
```

## What makes a subgraph a candidate

Strong signals include:

- repeated invocation with stable input/output semantics
- low semantic variability
- high agreement across independent model calls
- deterministic external verification
- high execution volume or cost
- repetitive normalization, extraction, transformation, classification or calculation behavior
- a stable executable specification that can be inferred from examples

## Complex workflows

Deterministicization applies to subgraphs, not only whole tasks. A complex AI execution may progressively become:

```text
raw input
 -> deterministic parsing
 -> deterministic filtering
 -> retrieval
 -> small model interpretation
 -> deterministic validation
```

and later:

```text
raw input
 -> deterministic parsing
 -> deterministic filtering
 -> deterministic validation
```

The objective is not to eliminate AI at all costs. Semantic reasoning remains appropriate where deterministic computation cannot meet the task requirement or evidence shows a justified verified advantage.

## Evidence requirements

A replacement must be evaluated against representative historical executions and must retain provenance from the original AI subgraph to the replacement decision. Shadow/canary rollout and rollback are mandatory before automatic production substitution for consequential workloads.

## Codebase advisory path

Developers may submit selected functions, traces or call graphs. Zeck analyzes the subgraph and returns advisory findings such as:

- AI is unnecessary here
- deterministicize this function
- split into deterministic preprocessing + AI interpretation
- add AI to this semantic bottleneck
- retain current implementation

Recommendations are advisory until the normal validation and authority gates are satisfied.
