# TradRL ↔ Zeck Integration Boundary

Status: ARCHITECT-APPROVED FUTURE INTEROPERABILITY PROFILE
Date: 2026-09-27
Architecture baseline: v1.0 + D1.0 + E1.0 + E1.1 + ACR-006 + ACR-007

## Purpose

This document records the intended interoperability boundary between payswapdotorg/TradRL and payswapdotorg/Zeck.

It is a design profile for a future compatibility proof. It does **not** authorize a new PPR work order and does not change the current ACR-006/ACR-007 execution-completeness program.

## Authority split

TradRL remains the application/domain authority for:

- Goal and constraint semantics;
- Organization Compiler decisions;
- Agent Body and immutable BodyVersion creation and learning;
- logical Possession and Agent OS semantics;
- Market World and trading-domain state;
- strategy, portfolio and risk-domain logic;
- application UX and ordinary application state.

Zeck becomes the execution authority for each material AI execution edge that TradRL delegates:

- execution identity and lifecycle;
- policy admission;
- capability resolution;
- budget/economic authorization;
- planning;
- Execution Compiler optimization;
- provider/model/tool/agent execution-strategy selection;
- computational-substrate selection;
- retry/escalation/continuation;
- verification and evidence;
- execution telemetry and provenance.

Neither system should silently become the other's authority.

## Logical possession versus execution realization

TradRL's conceptual model is:

```
BodyVersion
    ↓
logical Possession
    ↓
Agent OS / organization
    ↓
material AI execution edge
```

The Zeck-backed realization is:

```
logical role / BodyVersion
    ↓
capability requirements
    ↓
ACR-007 delegation
    ↓
Zeck Execution Compiler
    ↓
selected model + computational substrate
    ↓
execution + verification + evidence
```

A concrete model selected by Zeck is therefore an execution realization/evidence fact, not a provider-selection requirement owned by TradRL.

This prevents TradRL and Zeck from competing as model routers while preserving TradRL's agent-organization abstraction.

## CognitiveSubstrate versus ComputationalSubstrate

TradRL's CognitiveSubstrate is the model-side object that can possess an application-owned Agent Body. Zeck's ComputationalSubstrate is an execution-runtime abstraction covering workload class, resource, latency, isolation and side-effect characteristics.

These are deliberately different concepts and schemas.

A future adapter may translate between them where necessary, but neither project should make the other's substrate object its internal authority.

## Autonomous capability discovery

The intended TradRL flow is:

```
observed project/task failures
        ↓
capability deficit characterization
        ↓
candidate specialization / BodyVersion
        ↓
candidate cognitive substrates
        ↓
task-specific evaluation
        ↓
empirical eligibility evidence
        ↓
delegated Zeck execution
        ↓
outcome/evaluation
        ↓
organization and Body learning
```

A label such as "mathematician" or a model name such as "Limite" is never sufficient evidence of suitability.

The system may discover a specialization, discover multiple candidate substrates, test them, and retain only candidates that satisfy the relevant capability, quality, reliability, cost, latency and policy constraints.

## Mathematical-research example

For a strategy-research problem that repeatedly fails on advanced optimization:

```
TradRL observes failure pattern
        ↓
infers missing capability:
"mathematical optimization / stochastic reasoning"
        ↓
synthesizes:
"Mathematical Researcher"
        ↓
searches candidate Bodies / Skills / Cognitive Substrates
        ↓
tests Limite and other candidates on a task-specific suite
        ↓
retains empirical capability evidence
        ↓
delegates actual AI execution to Zeck
        ↓
Zeck selects an admissible execution representation
        ↓
TradRL evaluates the resulting trading research
```

There must be no rule equivalent to:

```
if task == mathematics then use Limite
```

unless that rule is itself merely a candidate prior and the governed system still verifies that the resulting execution satisfies the current capability and hard-constraint requirements.

## Capability publication

Zeck's capability registry remains the single capability authority for Zeck-governed execution.

A future capability-evidence adapter may ingest provider-neutral, provenance-bearing capability facts produced by TradRL's evaluations into that existing Zeck registry.

That adapter must not create:

- a second capability registry;
- a TradRL-owned Zeck routing table;
- an independent provider/model authority;
- a second execution optimizer.

Until such an adapter is explicitly implemented and governed, TradRL may maintain its own private research/evaluation catalog while passing execution requirements through the existing Zeck public boundary.

## Zeck-complete TradRL definition

A pinned TradRL runtime is AI_EXECUTION_COMPLETE only under the strict ACR-006/ACR-007 proof rules:

1. every declared material AI-execution edge terminates in Zeck execution;
2. direct AI-provider egress is absent or provably blocked during the proof;
3. representative TradRL functionality remains usable;
4. every delegated edge correlates to Zeck execution identity and evidence;
5. fixtures, mocks, simulations and proxy-only paths cannot upgrade the status;
6. no hard static no-bypass coverage defect or missing inventory remains.

Completeness does **not** require moving TradRL's Market World, organization state, trading logic, databases, UI or ordinary non-AI integrations into Zeck.

## Required proof corpus

The eventual TradRL proof should deliberately exercise:

- a task that triggers capability discovery;
- synthesis of a new or recomposed specialist BodyVersion;
- candidate substrate evaluation including multiple models;
- a candidate specialist that is rejected despite a promising label/description;
- an accepted specialist with empirical evidence;
- Zeck execution with autonomous model realization;
- deterministic/reuse opportunities;
- one-agent versus multi-agent execution decisions where applicable;
- provider failure and retry/escalation;
- verification and evidence correlation;
- no-bypass checks across all material AI execution surfaces.

The proof must compare the declared application execution graph, actual runtime egress and Zeck evidence independently.

## Program status

TradRL is a **future compatibility target** under the Zeck architecture. It is not part of the current pre-authorized PPR-018A through PPR-027 sequence.

A future Work Order must be issued or explicitly pre-authorized before implementation work for TradRL is added to Zeck's executable frontier.

