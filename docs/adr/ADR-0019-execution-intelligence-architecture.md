# ADR-0019 — Execution Intelligence Architecture E1.0

**Status:** Accepted architectural augmentation
**Architecture:** v1.0 + Execution Intelligence Architecture E1.0
**Date:** 2026-09-09
**Authority:** Architect

## Decision

Zeck will introduce a subordinate **Execution Intelligence Architecture E1.0** above the existing planner and below the existing authority boundaries.

E1.0 does not replace or rewrite frozen v1.0. It standardizes optimization of an already-governed execution plan so Zeck can continuously find the cheapest sufficiently reliable computational representation of a requested outcome.

The compiler is subordinate to, and may not bypass:

- tenant/application identity
- policy
- capability resolution
- budgets/economic authority
- sandbox/substrate selection
- execution lifecycle
- verification
- evidence

## 1. Strategic objective

Zeck's optimization objective is:

> **For each requested outcome, choose the cheapest sufficiently reliable computational representation, and progressively replace probabilistic work with deterministic work when evidence permits.**

The optimization dimensions are:

- precision/correctness
- cost
- deterministicism
- latency
- reliability
- context cost
- tool-surface cost
- side-effect/risk exposure

Developer simplicity remains a first-class product constraint.

## 2. Position in the execution architecture

The current governed sequence remains the authority boundary:

```text
Intent
  ↓
Policy
  ↓
Capability resolution
  ↓
Planning
  ↓
Execution
  ↓
Verification
  ↓
Evidence
```

E1.0 adds an optimization stage after a valid plan exists and before execution:

```text
Intent
  ↓
Policy
  ↓
Capability resolution
  ↓
Planning
  ↓
Execution Compiler
  ↓
Optimized Execution IR
  ↓
Execution
  ↓
Verification
  ↓
Evidence
  ↓
Learning
```

The compiler cannot change the authoritative outcome contract, grant permissions, move money, bypass verification, or create a second execution authority.

## 3. Execution Intermediate Representation

The Execution Plan becomes a machine-readable **Execution IR** suitable for deterministic optimization.

Each node/edge should expose, where applicable:

- deterministic vs probabilistic
- model-required vs model-optional
- side-effecting vs pure
- idempotent vs non-idempotent
- parallelizable dependencies
- cacheability/memoizability
- context inputs/outputs
- expected output size
- estimated/observed cost
- estimated/observed latency
- risk/side-effect class
- freshness requirement
- verification requirement
- provenance

These properties are descriptive optimization facts. They do not replace authority contracts.

## 4. Compiler transformations

E1.0 should support deterministic, semantics-preserving transformations when their preconditions are satisfied, including:

- constant folding
- dead-step elimination
- common-subexpression/result reuse
- memoization/cache reuse
- safe parallelization
- batching
- tool composition
- result-shaping
- retry normalization
- model downsizing
- AI-call elimination
- verification insertion
- decomposition into deterministic and probabilistic subgraphs

Every transformation must carry its basis and preserve execution provenance.

## 5. Tool Surface Compiler

Tool exposure is itself an optimization problem.

Zeck should derive a minimal useful tool surface from:

```text
task
  ↓
capabilities
  ↓
policy
  ↓
task relevance
  ↓
tool ranking
  ↓
minimal tool surface
```

A tool surface may be rendered as any appropriate representation:

- direct typed tool
- deferred/discoverable tool
- CLI
- script
- code API
- MCP adapter
- skill/competence reference

These are representations, not separate authorities.

The optimizer must prefer the representation that minimizes context, orchestration overhead and failure surface while remaining sufficiently reliable.

## 6. Programmatic tool calling

Zeck should support model-generated orchestration code where useful:

```text
Model
  ↓
bounded orchestration program
  ↓
sandbox
  ├─ tool A
  ├─ tool B
  ├─ tool C
  ├─ filter
  ├─ transform
  └─ aggregate
  ↓
compact structured result
  ↓
Model
```

Intermediate data should remain outside model context when it does not need semantic inspection.

The generated program is an untrusted candidate and must remain under existing policy, capability, budget, sandbox, execution and verification authority.

## 7. Context economy

Context is a governed optimization resource.

The compiler/context system should be able to reason about:

- context tokens/bytes
- context redundancy
- information density
- intermediate-result volume
- retrieval overhead
- tool-definition overhead
- prompt assembly latency
- privacy/sensitivity exposure

Large intermediate data should be processed in the execution environment and only the necessary structured result should cross into model context.

Sensitive data must not be copied into model context merely because a tool returned it.

## 8. Parallelism and multi-agent economics

Zeck should deterministically identify independent work and parallelize it when safe.

Multi-agent execution is an optimization choice, not an agent-controlled default.

The optimizer should consider:

- dependency graph width
- expected quality improvement
- expected cost/token increase
- latency benefit
- failure/recovery cost
- verification burden

The system may choose 0, 1 or N agents according to policy and economic constraints.

## 9. Infrastructure-vs-intelligence failure taxonomy

Execution results MUST distinguish failures attributable to:

- model reasoning
- tool behavior
- provider
- sandbox
- infrastructure
- resource exhaustion
- timeout
- policy denial
- capability denial
- verification
- unknown

A benchmark or learning signal must not attribute infrastructure failure to model intelligence without evidence.

Environment fingerprints should be recorded for evaluation where relevant.

## 10. Evaluation as an optimization asset

Evaluation evidence should be reusable across planning and learning.

Zeck should measure, where applicable:

- correctness
- cost
- latency
- context cost
- tool-use accuracy
- deterministic replacement success
- infrastructure error rate
- retry rate
- verification outcomes
- human feedback

Evaluation output remains evidence/recommendation and cannot silently authorize behavior.

## 11. Competence integration

E1.0 composes with ADR-0017.

Successful execution trajectories may become candidate reusable competence. Competence may evolve from:

```text
AI procedure
  → AI + deterministic tools
  → tool composition
  → deterministic procedure
  → verified reusable competence
```

Promotion remains governed by validation, verification and policy. The agent cannot self-promote competence.

## 12. Computer-use integration

Computer use remains a fallback computational representation, not a default.

The preferred order is:

```text
API / deterministic
      ↓
existing tool / competence
      ↓
browser automation
      ↓
isolated desktop / terminal
```

The compiler should prove that deterministic/API alternatives are insufficient before selecting GUI interaction when the evidence permits such a conclusion.

Computer-use trajectories become evidence for future optimization and competence formation.

## 13. Economic integration

E1.0 composes with ADR-0018.

Economic actions are executable subgraphs subject to the same optimization objective. The compiler may optimize rail selection, batching or deterministic checks, but cannot bypass:

- economic policy
- budget
- bounded authorization
- settlement verification

Payment rails remain adapters.

## 14. Long-running continuation

Optimized execution must remain resumable.

A future **Execution Continuation Package** should preserve:

- execution identity
- current optimized IR
- completed steps
- pending obligations
- artifacts/references
- evidence
- policy/capability references
- budget state
- environment/substrate identity
- selected tools/competences
- known failure classification
- next recommended action

Continuation state is not a second execution state machine.

## 15. Security and authority invariants

The compiler MUST NOT:

- bypass policy
- grant capabilities
- bypass budgets
- mutate authorization from learning signals
- treat a model output as verified
- expose secrets merely to reduce context cost
- execute generated code outside the sandbox authority
- create a second execution ledger/state machine
- make tool registries or skill registries authorities
- make external runtimes authorities
- make economic rails authorities

## 16. Relationship to frozen v1.0

No v1.0 rule is weakened or replaced.

E1.0 is subordinate to v1.0 exactly as D1.0 is subordinate to v1.0.

If implementing E1.0 requires changing a frozen invariant, the work must stop and use the Architecture Change Request process for a new immutable architecture version.

## 17. Implementation sequencing

E1.0 is implemented incrementally:

1. Execution IR metadata and invariants
2. deterministic execution-plan compiler
3. Tool Surface Compiler
4. programmatic tool calling
5. context-economy measurement
6. deterministic parallelization/batching
7. multi-agent economic gate
8. infrastructure-vs-intelligence evaluation taxonomy
9. execution continuation package
10. competence-aware optimization
11. progressive deterministicization and safe promotion

Concrete implementation remains governed by Work Orders with explicit requirements, surfaces, checkpoints and evidence.

## Rejected alternatives

### Replace the existing planner

Rejected. Planning remains the intent-to-plan authority. E1.0 optimizes a governed plan; it does not create a competing planner.

### Let agents optimize their own execution authority

Rejected. Agents may propose plans or optimization candidates; Zeck's deterministic compiler and authorities decide what can execute.

### Standardize on MCP

Rejected. MCP is one tool representation. Zeck optimizes the representation rather than choosing one universal transport.

### Standardize on CLI/scripts

Rejected. CLI/script/code/MCP/direct tools are context/transport representations chosen by execution optimization.

### Use larger models to compensate for context/tool overhead

Rejected. Zeck should first reduce unnecessary context and orchestration overhead.

### Always use multi-agent execution for difficult work

Rejected. Multi-agent execution has an explicit economic/quality gate.
