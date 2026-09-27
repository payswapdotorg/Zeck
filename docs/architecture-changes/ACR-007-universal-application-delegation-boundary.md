# ACR-007 — Universal Application Delegation Boundary

Status: APPROVED / FORWARD ARCHITECTURE EVOLUTION
Architecture baseline: v1.0 + D1.0 + E1.0 + E1.1 + ACR-006
Approval date: 2026-09-27

## Decision

Refine ACR-006 with an explicit, stable external **Application Delegation Boundary**.

The boundary is the product-facing contract by which an independent application delegates a material AI execution edge to Zeck without importing Zeck internals or reproducing Zeck authorities.

The governing chain remains unchanged:

Tenant/Application Identity → Policy → Capabilities → Budget/Economics → Planning → Execution Compiler → Execution → Sandbox/Substrate → Verification → Evidence → Learning

ACR-007 adds no second authority.

## 1. External delegation contract

A conforming application integration may provide:

- an application/environment identity;
- an outcome/task declaration;
- application-owned input artifact references or bounded context;
- application-owned constraints and quality/latency/cost requirements;
- a stable idempotency key;
- a correlation identifier linking the application's material execution edge to the Zeck execution.

Zeck owns, for the delegated edge:

- execution identity and lifecycle;
- policy admission;
- capability resolution;
- budget/economic authorization;
- plan generation;
- Execution Compiler optimization;
- provider/model/tool/agent/substrate selection;
- policy-permitted retry, escalation and continuation;
- verification and evidence binding;
- usage, cost, latency, provenance and execution telemetry.

The integration never selects a provider by writing provider semantics into the delegated task contract.

## 2. Transport profiles

The same execution boundary may be exposed through transport profiles appropriate to the workload:

- request/receipt for short executions;
- asynchronous execution plus polling/webhook for durable executions;
- event/stream consumption for progressive execution results;
- artifact references for large inputs/outputs;
- the existing governed RealtimeRail for genuinely persistent bidirectional sessions.

These are transport profiles of the same execution authority, not separate execution lifecycles or optimizer authorities.

An application may use a transport-specific client library, but the library is an adapter to the public Zeck boundary and must not reproduce Zeck policy, capability, budget, routing, verification or evidence logic.

## 3. Thin-integration invariant

A Zeck integration is architecturally healthy when the application-side adapter is a translation boundary:

Application execution edge
  → Zeck task + constraints + context references
  → Zeck execution
  → Zeck result/evidence
  → application domain result

The adapter must not become a shadow:

- provider registry;
- model router;
- retry authority;
- spend ledger;
- execution state machine;
- verification authority;
- evidence authority;
- optimizer.

The application may retain domain-specific decisions and UX. It must not retain material AI-provider execution decisions on a certified path.

## 4. Execution-edge taxonomy and capability relation

ACR-006's execution-surface taxonomy remains an observational vocabulary.

For each material application edge:

1. identify the execution surface;
2. identify the capabilities actually required;
3. resolve those capabilities through the existing Capability Engine;
4. execute through the existing Execution authority.

The compatibility taxonomy may reveal a capability not yet represented or implemented by Zeck. That is an implementation gap or architecture-gap candidate depending on the evidence. It may never rewrite existing capability truth.

One execution surface can require multiple capabilities, and one capability can support multiple surfaces.

## 5. Provider-erasure criterion

For a certified application proof:

- application-owned provider credentials must be absent from the certified runtime where the delegated edge is intended to be Zeck-owned;
- direct AI-provider egress must be blocked or otherwise provably absent during the proof;
- provider-specific configuration may exist only inside Zeck/provider adapter configuration that the application does not own;
- provider-specific behavior exposed to the application must be translated into neutral Zeck results, errors, artifacts and evidence.

A reverse proxy alone is not sufficient if the application still owns provider choice, provider credentials, provider fallback, or provider-specific execution semantics.

## 6. Completeness remains strict

ACR-006's AI_EXECUTION_COMPLETE definition is preserved unchanged.

No application is COMPLETE unless every declared material AI execution edge is delegated through Zeck, the application remains functionally usable for the declared corpus, direct provider egress is absent/provably blocked, and Zeck evidence correlates every delegated edge.

A demo can display PARTIAL/BLOCKED/NOT-RUN, but it cannot upgrade them.

## 7. Discovery without authority drift

Zeck may discover candidate capabilities, reusable competencies, deterministic alternatives and application integration opportunities from compatibility analysis and telemetry.

Discovery is advisory.

It must feed the existing capability/planning/learning authorities rather than create a compatibility-specific routing or optimization authority.

## 8. Architecture-gap test

A compatibility failure is escalated as:

- **implementation gap** when the existing architecture can represent the edge and the public boundary can express it, but an adapter/implementation is missing;
- **public-contract gap** when the architecture supports the edge but the external contract forces an application to understand Zeck internals;
- **architecture-gap candidate** when the edge cannot be represented through the governing chain without a second authority, frozen-invariant violation, or provider semantics leaking into the domain;
- **operator/provider boundary** when proof is blocked by credentials, region, quota, DNS, unavailable infrastructure, commercial terms or other external constraints.

Only the last three categories must not be conflated with each other.

## 9. Demonstration requirement

The website Demo Mirror is a projection of the certified integration and its evidence.

A certified demo must execute the same pinned application integration/runtime used for certification and expose:

application result + Zeck execution + plan/route + usage/cost/latency + verification/evidence + limitations + reproducibility

The mirror is not a simulator and is not a substitute for certification.

## 10. Application-owned agent organizations and execution realization

ACR-007 governs the **execution realization** of a delegated application edge. It does not require Zeck to replace an application's domain-level organization, agent-body model, possession model, or Agent OS.

For applications such as TradRL:

```
Application-owned organization / Agent Body / domain orchestration
                    ↓
           material AI execution edge
                    ↓
          ACR-007 Zeck delegation
                    ↓
      Zeck execution representation selection
```

The distinction is normative:

- The application remains the authority for its domain organization and logical agent composition.
- Zeck is the authority for how a delegated AI execution is realized, including provider/model/tool/agent execution strategy, subject to policy, capability, budget, quality, reliability, latency, verification and other hard constraints.
- A Zeck execution decision must not silently mutate or replace the application's domain organization.
- An application's logical role such as "Mathematical Researcher" is not itself a Zeck provider/model route.
- A concrete model chosen by Zeck is execution evidence for that delegated edge, not an application-owned provider-selection requirement.

### Cognitive-substrate terminology boundary

Applications may use "cognitive substrate" or an equivalent concept to describe the model-side realization of an application-owned agent. Zeck's **ComputationalSubstrate** is a separate execution-runtime concept. The two must not be treated as the same authority or schema.

An application may therefore maintain:

```
logical role / BodyVersion
        ↓
capability requirements
        ↓
delegated Zeck execution
        ↓
selected model + computational substrate
```

without requiring the application's model registry to become Zeck's routing authority.

### Capability discovery and publication boundary

Zeck's capability registry remains the capability authority. External applications and learning systems may discover or empirically characterize capabilities, but they must not create a second capability authority.

A future external capability-evidence adapter MAY translate application-owned evaluation results into provider-neutral capability facts for submission to the existing Zeck capability registry. Such a path is an ingestion seam, not a new registry or routing service.

Until such an adapter is explicitly implemented and governed, an application may pass task requirements through the existing execution boundary without assuming that its private capability catalog is automatically present in Zeck.

### TradRL interoperability consequence

For the planned TradRL proof, TradRL may own:

- Organization Compiler decisions;
- Agent Body / BodyVersion creation and learning;
- logical Possession and Agent OS semantics;
- Market World, research and trading-domain state;
- risk/execution domain decisions outside the delegated AI edge.

The certified live AI path must still satisfy the strict ACR-006/ACR-007 completeness contract. In particular, TradRL must not retain a direct material AI-provider execution path, provider-owned fallback, or application-side model router for a certified delegated edge.

TradRL interoperability is a future compatibility target and is **not** a current PPR authorization merely by being named here.

## Consequence

ACR-007 makes the Stripe-of-AI-execution thesis more falsifiable:

The meaningful unit of proof is not "Zeck can call provider X." It is "an independent application can erase its direct AI-provider execution infrastructure and delegate the material execution edge through one stable public Zeck contract."

The architecture therefore evolves by testing real applications, while preserving the original execution authorities and the strict definition of completeness.
