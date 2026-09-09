# Zeck Roadmap — Governed AI Execution Infrastructure

## Mission

**Optimize execution precision, cost, deterministicism and developer simplicity.**

Zeck should make AI integration feel like Stripe: developers declare an outcome and constraints; Zeck selects and orchestrates the cheapest sufficiently reliable combination of deterministic computation, tools, models, agents, external runtimes, human intervention and—when explicitly authorized—economic actions.

### Operational optimization rule

> **For every requested outcome, choose the cheapest sufficiently reliable computational representation, and continuously replace probabilistic work with deterministic work when evidence permits.**

This means Zeck optimizes not only model/provider choice, but also the representation of the work itself: deterministic code, existing tools, tool compositions, programmatic orchestration, reusable competence, models, agents, computer use, and human intervention.

## Core architectural rule

Execution remains the universal durable abstraction.

No feature in this roadmap creates a second authority for execution lifecycle, policy, capabilities, budgets/economics, tenant identity, credentials/secrets or verification.

Learning and benchmarking produce evidence and recommendations; they never silently become authorization.

## Completed foundations

### Execution control plane
Provider federation, BYOK, budgets, capabilities, execution lifecycle, durable evidence and tenant isolation.

### Intelligence plane
Deterministic-first planning, context compilation, learning telemetry, verification and tool-composition intelligence.

### Agent fabric
Versioned agent identity, governed sessions, sandboxed environments, BYOA adapters and deployment foundations.

### Developer surface
Public API, SDK, CLI, dashboard and webhooks.

### External interoperability
WorkflowOS integration and benchmark harness.

### Deployment/runtime
D1.0 approved and D-00 through D-06 completed; D-07 resilience/disaster-recovery/provider-exit is the current authorized implementation phase.

## Execution Intelligence Architecture E1.0

Approved by ACR-003 and ADR-0019 as an additive architecture subordinate to frozen v1.0.

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

The optimizer does not replace Planning or become an authority. It transforms governed plans under deterministic preconditions and records the transformation basis.

### E1 — Execution IR

Expose machine-readable step properties: deterministic/probabilistic, model-required, side-effecting, idempotent, parallelizable, cacheable, context cost, expected output size, estimated/observed cost and latency, risk, freshness, verification needs and provenance.

### E2 — Execution Compiler

Support proven semantics-preserving transformations including constant folding, dead-step elimination, common-result reuse, memoization, parallelization, batching, tool composition, result shaping, retry normalization, model downsizing, AI-call elimination, decomposition into deterministic/probabilistic subgraphs and verification insertion.

### E3 — Tool Surface Compiler

Treat tool exposure as an optimization problem:

```text
task
 ↓
capabilities
 ↓
policy
 ↓
relevance
 ↓
tool ranking
 ↓
minimal tool surface
```

Representations may include direct tools, deferred tools, CLI, scripts, code APIs, MCP and competence references. These are representations, not separate authorities.

### E4 — Programmatic tool calling

Allow bounded sandboxed orchestration code to invoke multiple tools, loop, branch, filter and aggregate while keeping large intermediate data outside model context when semantic inspection is unnecessary.

### E5 — Context Economy

Treat context as an optimization resource. Measure context size, redundancy, information density, retrieval overhead, tool-definition overhead, intermediate-result volume, privacy exposure and latency. Prefer compact structured outputs and opaque references over dumping large raw tool results into model context.

### E6 — Evaluation and failure attribution

Separate intelligence failure from model/provider/tool/sandbox/infrastructure/resource/timeout/policy/capability/verification failures. Fingerprint relevant environments so learning does not misattribute infrastructure noise to model quality.

### E7 — Multi-agent economic gate

Choose 0, 1 or N agents from dependency width, expected quality gain, cost, latency, recovery burden and verification burden. Agents cannot self-authorize spawning.

### E8 — Continuation package

Standardize durable continuation data for interrupted/long-running work: execution identity, optimized IR, completed steps, pending obligations, artifacts/evidence, policy/capability references, budget state, environment, tools/competences, failure classifications and next action.

### E9 — Competence-aware optimization

Use ADR-0017 competences as candidate computational representations. Retrieve competence progressively and only when justified by the task.

### E10 — Progressive deterministicization

Repeated successful probabilistic procedures become candidates for deterministic replacement. Differential, property, replay and verification evidence is required before promotion.

## Current deployment frontier

D-07 / WORK-048 is the authoritative active implementation order. See `AI_CONTINUATION.md`, `docs/LLM-ARCHITECT-HANDOFF.md` and `spec/work-orders/WORK-048.md`.

D-08 remains blocked pending D-07 completion, measured production usage, explicit availability/security requirements and an Architect-approved extension.

## Computer-use strategy

Computer use is a governed computational capability and escalation mode, not the default.

```text
Task
  ↓
API / deterministic sufficient?
  ├─ yes → deterministic/API execution
  └─ no
       ↓
existing tool / competence
       ↓
browser automation
       ↓ insufficient
isolated desktop / terminal
```

Every stage remains under Policy, Capability, Tenant/Credential mediation, Budget, Execution, Sandbox/Substrate, Verification and Evidence.

Computer-use trajectories should become learning evidence for future competence and deterministicization.

## Procedural competence and runtime ecosystem

ADR-0017 defines versioned, provenance-bearing Competence as reusable ways of accomplishing tasks, broader than tools or memories.

```text
trajectory
  ↓
pattern mining
  ↓
candidate competence
  ↓
validation
  ↓
verification
  ↓
shadow evaluation
  ↓
promotion
  ↓
planner recommendation
```

Zeck should integrate OpenClaw, Hermes, WorkflowOS and customer runtimes through adapters, not absorb their runtimes into core.

## Agentic economic actions

ADR-0018 defines EconomicAction and provider-neutral payment-rail adapters as a future governed extension.

```text
intent
 ↓
economic intent
 ↓
policy
 ↓
budget
 ↓
authorization
 ↓
rail adapter
 ↓
settlement/resource delivery
 ↓
verification
 ↓
evidence
```

`intent != authorization != transaction != settlement != verification`.

Budgets remain the spending-control authority; financial rails remain adapters.

## User-visible optimization product

Zeck should eventually expose recommendations such as unnecessarily generative execution subgraphs, deterministic replacements, better tool compositions, opportunities to reduce context/tool-surface cost, model downsizing opportunities, unnecessary multi-agent execution, infrastructure-vs-intelligence failure patterns, competence reuse opportunities and human-evaluation opportunities where uncertainty warrants them.

Recommendations remain advisory until normal validation and promotion gates pass.

## Borrow vs integrate

| External lesson | Zeck treatment |
|---|---|
| OpenClaw Gateway/channel ecosystem | Integrate as Deployment/Session/Gateway adapter concepts |
| OpenClaw browser/desktop use | Adapt as provider-neutral computer-use capabilities |
| OpenClaw skills/trust ecosystem | Adapt into Competence Registry/supply chain |
| Hermes procedural skills | Promote into Zeck Competence abstraction |
| Hermes skill self-improvement | Move into governed learning/evaluation/promotion |
| MCP | One possible tool representation, never a core authority |
| CLI/scripts/code APIs | Alternative tool representations chosen by optimization |
| Stripe/MPP/x402 machine payments | Adapter targets behind EconomicAction/PaymentAuthority |
| Third-party runtimes | Integrate through neutral adapters, never copy their authority model |

## Work Order discipline

No roadmap bullet is implementation authority.

A capability becomes executable only through a repository-resident Work Order containing requirement ownership, exact dependencies, declared/forbidden surfaces, assurance profile, acceptance criteria, checkpoint contracts, evidence contract, migration policy and completion boundary.

One Work Order = one implementation branch = one PR.

Parallel execution is allowed only after surface/migration/shared-state analysis proves the branches can be safely reconciled.

## Strategic end state

```text
                       ZECK
                         |
              Developer API / SDK / CLI
                         |
                  Execution Control
                         |
          +--------------+--------------+
          |              |              |
        Policy      Capabilities      Budget
          |              |              |
          +--------------+--------------+
                         |
                      Planner
                         |
               Execution Compiler
                         |
               Optimized Execution IR
                         |
       +-----------------+------------------+
       |                 |                  |
 deterministic       tools/competence     AI
       |                 |                  |
       +-----------------+------------------+
                         |
                  Sandbox / Substrate
                         |
                    Verification
                         |
                      Evidence
                         |
                      Learning
                         |
              Competence promotion
                         |
                       Planner
                         |
          +--------------+--------------+
          |                             |
   External runtimes              Economic actions
   OpenClaw/Hermes/etc.           payments/purchases
```

The strategic role of Zeck is not to become the largest agent framework, payment processor, browser controller or model platform.

Zeck is the neutral execution optimization layer underneath and across those systems.
