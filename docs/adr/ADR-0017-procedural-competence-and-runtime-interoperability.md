# ADR-0017 — Procedural Competence and Runtime Interoperability

**Status:** accepted architectural evolution
**Architecture version:** v1.0 (additive)
**Related systems:** OpenClaw, Hermes Agent, WorkflowOS, BYOA runtimes

## Decision

Zeck will evolve from learning isolated performance signals into learning, validating, versioning and promoting reusable **procedural competence**.

Zeck will also treat external agent runtimes and communication gateways as pluggable execution participants rather than attempting to replace them with a monolithic native agent framework.

This evolution preserves the v1.0 authorities:

- Execution remains the universal durable abstraction.
- Policy remains the hard authorization boundary.
- Capability resolution remains the capability authority.
- Budgeting remains the economic authority.
- Verification remains the independent correctness authority.
- Tenant/application identity remains singular.
- Sandbox/compute substrate remains the execution-isolation authority.
- Learning remains observational/advisory and cannot authorize execution.

## 1. Procedural competence

A **Competence** is a versioned, provenance-bearing reusable way of accomplishing a class of tasks. It is broader than a memory and broader than a tool.

A competence may contain or reference:

- procedural instructions
- deterministic procedures
- tool compositions
- context requirements
- capability requirements
- verification procedures
- executable program/tool artifacts
- failure modes and fallback strategies
- representative examples/evidence
- evaluation history

Competence is deliberately distinct from:

- factual memory
- a Tool
- an Agent
- a Plan
- an Execution
- a Policy

## 2. Competence lifecycle

Reusable competence follows a governed lifecycle:

```text
execution trajectories
        |
        v
pattern mining
        |
        v
candidate competence
        |
        v
static/security validation
        |
        v
sandbox/runtime validation
        |
        v
verification
        |
        v
shadow evaluation
        |
        v
promotion
        |
        v
planner recommendation
```

The agent may propose competence. The learning/evaluation plane owns evidence and promotion. An agent may never self-promote its own competence into trusted production behavior.

## 3. Competence and deterministicization

Competence must preserve evidence useful for progressively replacing AI work with deterministic computation.

A competence may therefore evolve through forms such as:

```text
AI procedure
  -> AI + deterministic tool composition
  -> deterministic program
  -> verified reusable capability
```

The cheapest sufficiently reliable representation should be preferred by planning, subject to policy, capability, budget and verification constraints.

## 4. Competence is not authority

A learned competence score, success rate or user rating MUST NOT itself:

- authorize a provider
- authorize a tool
- grant a capability
- bypass policy
- bypass budget
- bypass verification
- mutate execution state
- promote an agent

Learning remains evidence and recommendation only.

## 5. Progressive disclosure

Competence content should be loaded selectively rather than injected wholesale into every model context.

The context/learning systems may retrieve:

- competence metadata first
- relevance-ranked procedures second
- detailed examples/artifacts only when justified

This supports lower-cost models by supplying the precise procedural context needed for a task rather than compensating with larger model selection alone.

## 6. Runtime interoperability

Zeck will expose a provider-neutral runtime interoperability layer for external agent frameworks and gateways.

Conceptually:

```text
channel / external runtime
          |
          v
   Gateway / Session adapter
          |
          v
       Deployment
          |
          v
       Agent
          |
          v
      Execution
          |
   +------+------+------+------+------+------+
   | Policy | Capability | Budget | Sandbox | Verification |
   +-----------------------------------------+
          |
          v
       Evidence
```

External runtimes remain replaceable participants.

Potential integrations include OpenClaw, Hermes Agent, WorkflowOS and future customer-hosted runtimes. Integration does not make any external runtime a Zeck authority.

## 7. Session as a first-class integration concept

A session is the durable bridge between a deployment/channel/runtime interaction and individual executions.

A session may carry:

- tenant/application scope
- deployment identity
- agent/version identity
- external conversation/thread reference
- current execution context
- interruption/resume metadata
- selected competence references
- provenance

Session state must not become a second execution state machine. Execution remains the authoritative unit of durable work and lifecycle.

## 8. Gateway boundary

A Gateway/transport adapter may:

- authenticate an ingress channel
- resolve external session identity
- translate ingress events to Zeck commands
- return receipts/results/events
- maintain delivery/retry metadata

A Gateway MUST NOT:

- become policy authority
- become execution authority
- become budget authority
- become verification authority
- create a duplicate agent registry
- mutate customer workflow state directly
- grant capabilities to itself or an external runtime

## 9. Skill/competence supply chain

Zeck will eventually provide a trust-oriented registry for reusable competence, tool compositions and synthesized programs.

Registry metadata should include:

- immutable identity/version
- publisher/provenance
- required capabilities
- dependency graph
- security validation
- verification status
- evaluation population
- confidence/uncertainty
- compatibility
- promotion/rollback state

This is intentionally stronger than a simple skill marketplace: executable competence is treated as a governed supply-chain artifact.

## 10. External runtime trust model

The following are all untrusted by default:

```text
agent
skill
plugin
BYOA runtime
Gateway
competence
benchmark result
model output
```

They become usable only through existing Zeck admission, sandbox and verification controls.

## 11. Benchmarking

Zeck may compare native, external and customer-hosted runtimes using the same Execution/Evidence contract.

Benchmark results are observations. They cannot directly alter production authorization or policy.

## 12. Relationship to existing Work Orders

This ADR is intentionally additive to the existing roadmap:

- WORK-014 remains the learning telemetry/scorecard foundation.
- WORK-017 remains existing-tool composition learning.
- WORK-018 remains validated synthesis of new deterministic tools/programs.
- WORK-023 remains the common multimodal Deployment abstraction.
- WORK-031 remains the common ComputationalSubstrate/workload-class abstraction.

Future work will extend these foundations rather than replace them.

Candidate follow-on areas:

1. **Competence lifecycle and reusable procedural memory** — promote validated procedural patterns from execution history.
2. **Session/Gateway fabric** — standardize external channel/runtime sessions on top of Deployment and Execution.
3. **Competence registry and trust supply chain** — distribute validated skills/procedures/tools/programs with security and provenance metadata.
4. **Cross-runtime competence learning** — learn from OpenClaw/Hermes/BYOA/native trajectories through the same evidence contract.

Concrete implementation remains governed by future Work Orders and the normal architect review/merge process.

## 13. Architectural non-goals

Zeck will NOT:

- become a replacement for OpenClaw
- become a replacement for Hermes Agent
- own third-party channel infrastructures
- expose vendor-specific runtime types in core contracts
- create a monolithic native agent framework merely to reproduce ecosystem functionality

The strategic role is to provide the execution control plane, economic controls, policy, substrate, verification and learning layer underneath and across such runtimes.
