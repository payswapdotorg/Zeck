# Zeck Roadmap — Governed AI Execution Infrastructure

## Mission

**Optimize execution precision, cost, deterministicism and developer simplicity.**

Zeck should make AI integration feel like Stripe: developers declare an outcome and constraints; Zeck selects and orchestrates the cheapest sufficiently reliable combination of deterministic computation, tools, models, agents, external runtimes, human intervention and—when explicitly authorized—economic actions.

## Core architectural rule

Execution remains the universal durable abstraction.

No feature in this roadmap creates a second authority for:

- execution lifecycle
- policy
- capabilities
- budgets/economics
- tenant identity
- credentials/secrets
- verification

Learning and benchmarking produce evidence and recommendations; they never silently become authorization.

---

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

---

## Current frontier

### Tool synthesis
WORK-018 creates validated ephemeral deterministic programs/tools from learned opportunities. Compilation and execution are sandboxed, statically validated, runtime-tested and independently verified.

### Multimodal deployment
WORK-023 establishes the common deployment object consumed by voice, messaging and media-generation implementations.

### Computational substrate federation
WORK-031 generalizes Execution-compatible workload/substrate classes for computer use, long-running work, edge/embodied execution, GPU/training and accelerators.

---

## Computer-use strategy

Computer use is deliberately treated as a **governed computational capability and escalation mode**, not as the default way an agent interacts with software.

The preferred execution order is:

```text
Task
  ↓
Can API / deterministic capability satisfy it?
  ├─ yes → deterministic/API execution
  └─ no  → browser automation
               ↓ insufficient
            isolated desktop/terminal interaction
```

This means a capable browser/desktop agent does not automatically receive a browser or desktop call. Zeck should first determine whether an API, structured connector, deterministic tool, existing competence or other exact computation can solve the subtask.

Every computer-use stage continues through:

```text
Policy
  ↓
Capability
  ↓
Tenant / credential mediation
  ↓
Budget
  ↓
Execution
  ↓
Sandbox / substrate
  ↓
Verification
  ↓
Evidence
```

Computer-use observations and actions should become reusable trajectory evidence. Repeated successful trajectories can later feed tool learning, competence formation and deterministicization rather than remaining permanently dependent on GUI/model interaction.

The implementation target is provider-neutral contracts for browser, desktop and terminal interaction, explicit side-effect capabilities, isolated execution, structured action/observation evidence, and deterministic/API-vs-GUI discrimination tests. WORK-027 owns the concrete implementation after WORK-031.

---

# Post-foundation evolution

The following capabilities are intentionally additive to the current architecture. They extend Learning, Planning, Deployment, Agent, Substrate and Economic foundations rather than replacing them.

## 1. Procedural competence

Turn repeated successful trajectories into reusable, versioned competence.

```text
Execution history
      |
      v
trajectory/pattern mining
      |
      v
candidate competence
      |
      +--> procedural guidance
      +--> tool composition
      +--> deterministic procedure
      +--> synthesized tool/program
      +--> verification recipe
      |
      v
validation + verification
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

A competence is broader than a Tool and different from an Agent, Plan, Execution or factual Memory.

### Strategic purpose

Enable Zeck to learn *how to accomplish tasks*, not only which provider/model/tool tends to perform well.

This is the platform-level version of agent self-improvement ideas demonstrated by systems such as Hermes: agents may discover procedures, but Zeck owns the evidence, validation and promotion boundary.

## 2. Progressive competence retrieval

Competence should be progressively disclosed:

```text
Task
  -> competence metadata
  -> relevance ranking
  -> minimal procedure/context
  -> detailed examples/artifacts only when justified
```

This directly supports low-cost model routing. Instead of always buying a stronger model, Zeck can supply a cheaper model with the right procedural competence, examples, artifacts, deterministic tools and verification strategy.

## 3. Session and Gateway fabric

Extend the Deployment layer with a provider-neutral session/gateway abstraction:

```text
channel/runtime
      |
      v
Gateway
      |
      v
Session
      |
      v
Deployment
      |
      v
Agent
      |
      v
Execution
```

The Gateway handles ingress, authentication, translation and delivery/retry concerns.

It does not become an execution/policy/budget/verification authority.

This is the primary architectural lesson to take from OpenClaw's channel/Gateway model: make the agent runtime live where users already communicate without making the runtime the platform.

## 4. External runtime adapters

Zeck should make OpenClaw, Hermes and other agent systems first-class interoperability targets through adapters.

Conceptually:

```text
OpenClaw ----\
Hermes -------> runtime adapter -> Zeck governed Execution
WorkflowOS ---/
Native -------/
Customer BYOA /
```

Adapters expose neutral observations and commands and keep framework-specific types outside core contracts.

## 5. Competence registry and trust supply chain

Create a governed registry for reusable competence and executable artifacts.

Registry entries eventually cover:

- procedural skills
- workflows
- tool compositions
- deterministic procedures
- synthesized tools/programs
- verification recipes
- connectors

Each entry carries:

- immutable identity/version
- source/provenance
- publisher
- required capabilities
- dependencies
- security results
- verification status
- evaluation population/window
- confidence/uncertainty
- compatibility
- promotion/rollback state

Borrow the useful ecosystem lessons from OpenClaw/ClawHub, but treat executable competence as a supply-chain object, not merely a marketplace listing.

## 6. Cross-runtime learning

Zeck should learn from trajectories generated by:

- native agents
- OpenClaw
- Hermes
- WorkflowOS
- customer BYOA runtimes
- future runtimes

All observations enter the same Learning/Evidence plane.

This makes the best runtime technique portable across ecosystems rather than locked inside one agent framework.

## 7. Progressive deterministicization

The long-term optimizer should search for the cheapest sufficiently reliable representation:

```text
AI procedure
   |
   v
AI + deterministic tools
   |
   v
tool composition
   |
   v
deterministic program
   |
   v
verified reusable competence
```

This extends WORK-009/014/017/018 and the deterministicization roadmap.

A repeatedly successful agent procedure should be a candidate for deterministic replacement when replay/differential/property testing shows equivalence.

## 8. User-visible improvement recommendations

The public product should eventually tell developers:

- which execution subgraphs appear unnecessarily generative
- which steps have deterministic substitutes
- which tool/competence combinations improve cost/precision
- where a stronger model is actually justified
- where user feedback is needed to resolve uncertainty

Recommendations remain advisory until they pass the normal validation/promotion gates.

## 9. Agentic economic actions and payment rails

Zeck should eventually govern agent-initiated economic activity through the same execution-control principles used for AI computation.

The platform abstraction is **EconomicAction**, not a provider-specific payment object. Payment is one economic action alongside purchase, transfer, refund, charge and future machine-commerce operations.

The intended flow is:

```text
agent/developer intent
        |
        v
economic intent
        |
        v
policy
        |
        v
budget reservation
        |
        v
economic/payment authorization
        |
        v
provider-neutral rail adapter
        |
        v
settlement / resource delivery
        |
        v
verification
        |
        v
evidence
        |
        v
learning
```

### Core invariants

```text
intent ≠ authorization ≠ transaction ≠ settlement ≠ verification
```

Agents must not receive unrestricted financial credentials. Authorizations should instead be bounded by the deterministic constraints Zeck already knows how to enforce, such as:

- seller/recipient
- maximum amount
- currency
- purpose/resource
- expiration
- execution/application/tenant scope
- one-time or bounded reuse

Payment rails remain replaceable adapters. Candidate rails include Stripe, Machine Payments Protocol (MPP), x402, network-token/payment APIs, bank rails, wallets, stablecoin rails and regional payment providers.

The economic layer must reuse Zeck's existing budget/economic authority rather than create a second accounting truth. External rail ledgers are settlement records correlated to Zeck evidence, not replacement Zeck ledgers.

Machine-readable payment-required flows such as HTTP 402 should be treated as inputs to economic planning, not as authorization by themselves.

A successful payment must never automatically imply that the purchased resource or business outcome succeeded; verification remains independent.

The implementation target is a provider-neutral EconomicAction/PaymentAuthority seam plus bounded rail adapters. Regulated financial services, KYC/AML, custody, money transmission, card issuance and similar infrastructure require separate Work Orders and compliance/security review.

---

# Recommended implementation sequencing

### Wave A — Current

WORK-018 + WORK-023 + WORK-031

### Wave B — Competence

1. Competence domain/model and lifecycle
2. Procedural pattern mining
3. Progressive competence retrieval
4. Competence validation/promotion
5. Competence registry/trust

### Wave C — Runtime ecosystem

1. Session/Gateway fabric
2. OpenClaw adapter
3. Hermes adapter
4. Customer/BYOA runtime adapters
5. Cross-runtime trajectory ingestion

### Wave D — Optimization loop

1. competence-aware planning
2. cross-runtime scorecards
3. deterministicization opportunity detection
4. user-facing deterministicization recommendations
5. automatic shadow/canary evaluation
6. safe promotion/rollback

### Wave E — Economic control plane

1. EconomicAction and PaymentAuthority contracts
2. bounded agent-payment authorization
3. payment rail adapter contract
4. Stripe / MPP / x402 integrations
5. machine-readable 402 payment-required handling
6. payment/resource-delivery verification
7. economic trajectory telemetry and optimization
8. machine-to-machine commerce and agent-to-agent settlement

No payment rail becomes a Zeck core dependency; Zeck remains the neutral orchestration and governance layer.

---

# Borrow vs integrate vs avoid

| System / idea | Action in Zeck |
|---|---|
| OpenClaw Gateway/channel architecture | **Integrate conceptually** into Deployment/Session/Gateway fabric |
| OpenClaw browser/desktop capability model | **Learn + adapt** into provider-neutral Computer Use capabilities |
| OpenClaw skills ecosystem | **Learn + adapt** into Competence Registry |
| OpenClaw security scanning/trust metadata | **Integrate principles** into competence supply chain |
| OpenClaw runtime | **Adapter**, not Zeck core |
| Hermes procedural skills | **Integrate concept** as first-class Competence |
| Hermes autonomous skill improvement | **Promote to Zeck learning/evaluation lifecycle**, never direct agent authority |
| Hermes memory/skills separation | **Integrate conceptually** into Context + Competence |
| Hermes gateway/profile isolation | **Learn + adapt** into Session/Deployment |
| Stripe agentic payment authorization/tokenization | **Integrate principles** into EconomicAction/PaymentAuthority |
| Stripe Machine Payments Protocol | **Adapter target**, not Zeck core |
| x402 / other machine-payment protocols | **Adapter targets**, not Zeck core |
| Third-party framework internals | **Do not copy into core** |

---

# Strategic end state

```text
                         ZECK
                          |
               Developer API / SDK / CLI
                          |
                   Execution Control
                          |
          +---------------+---------------+
          |               |               |
        Policy        Capabilities      Budget
          |               |               |
          +---------------+---------------+
                          |
                       Planner
                          |
               Deterministic-first choice
                          |
        +-----------------+------------------+
        |                 |                  |
   deterministic      tools/skills        AI models
        code          competence           / agents
        |                 |                  |
        +-----------------+------------------+
                          |
                   Substrate / Sandbox
                          |
                     Verification
                          |
                       Evidence
                          |
                      Learning
                          |
               Competence promotion
                          |
                    Planner improves
                          |
              +-----------+-----------+
              |                       |
       External runtimes       Economic actions
       OpenClaw/Hermes/etc.    payments/purchases
              |                       |
              +-----------+-----------+
                          |
                     Rail adapters
```

The strategic goal is not to build the biggest agent framework, payment processor or runtime.

The goal is to become the neutral execution layer that makes every agent framework, model, tool, computational substrate and authorized economic interaction **cheaper, safer, more deterministic, more precise and easier for developers to use**.
