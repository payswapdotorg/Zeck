# Zeck UX Council — Decision Summary

**Date:** 2026-09-03
**Decision authority:** Architect
**Technical baseline:** `spec/architecture.md` v1.0 (frozen)
**Detailed decision:** `docs/UX-EXPERIENCE-ARCHITECTURE-V2.md`

## Council premise

This is a synthesized design review using senior Apple- and Stripe-style product design principles. It is not a claim of participation by Apple or Stripe employees.

## Final decisions

### 1. Zeck must feel smaller than it is

The backend can orchestrate models, providers, tools, agents, deterministic programs, context compilation, verification, sandboxes, training, computer use, edge workloads, economic actions and learning. The default UI must not expose that complexity as a feature catalog.

### 2. Intent is the front door

The primary interaction begins with the outcome the user wants, not the implementation mechanism.

### 3. Work is the universal visible abstraction

The many workload types remain execution-compatible internally. The user should experience them through a common Work language.

### 4. Five durable user concepts

The primary visible concepts are Work, Agent, Resource, Result and Rule.

### 5. Five durable user actions

The dominant actions are Ask, Run, Build, Review and Improve.

### 6. Home is a Now surface

Home prioritizes intent, attention, active work and recent results. Analytics and infrastructure telemetry are contextual, not the primary home experience.

### 7. Command/search is a second front door

Natural-language discovery and action should complement navigation without bypassing authorization or API authority.

### 8. Execution detail is the canonical work inspector

The primary hierarchy is Result -> Evidence -> Activity, with Why Zeck did it and advanced internals progressively disclosed.

### 9. Trust must be evidence-backed

Provider success, execution success, quality success and policy success remain distinct. A single opaque confidence score is insufficient.

### 10. Explain important autonomous decisions

Users should be able to ask why a route, capability, compute environment, verification strategy or other significant execution choice was made.

### 11. Build begins with purpose

Agents, deployments, workloads and other reusable constructs begin with an outcome description and a proposed design. Detailed authoring is secondary.

### 12. Deployments and Executions remain visually distinct

Deployments communicate persistent availability; Executions communicate individual governed work.

### 13. Competence is a first-class reusable knowledge-of-how object

Competence should be presented as a validated reusable way of accomplishing a class of work, not as a prompt, model, Tool or Agent.

### 14. Attention replaces notification noise

Only decisions, approvals, consequential failures and useful recommendations should demand attention. Routine events remain in Activity.

### 15. Consequences precede commitment

Before high-impact external actions the UI should explain effect, scope, cost, authorization, reversibility and approval requirements.

### 16. Progressive disclosure is the complexity strategy

Four levels are recognized:

```text
Outcome -> Explanation -> Control -> Internals
```

The product may be deeply technical at the fourth level while remaining extremely simple at the first.

### 17. Experience modes change visibility, not semantics

Simple, Professional and Expert views are density/disclosure modes over the same underlying object model.

## Rejected directions

- backend-module-first navigation;
- model/provider selection as the default user task;
- graph-first execution monitoring;
- permanent telemetry-heavy dashboards;
- separate UX universes for voice, training, computer use, robotics, payments and other workloads;
- giant notification centers;
- blank-canvas-first automation building;
- opaque trust scores;
- dashboard-owned business or execution authority.

## Architectural consequence

No technical architecture change is required. The decision deliberately preserves Architecture v1.0 and its authorities while making the experience layer more opinionated and coherent.

## Next product-design gate

Before another implementation wave, convert this decision into a complete screen-by-screen interaction specification covering the primary journeys:

1. first successful execution;
2. failed execution and recovery;
3. human approval;
4. agent creation;
5. deployment management;
6. workload/training;
7. artifact/evidence investigation;
8. competence discovery and reuse;
9. improvement recommendation review;
10. consequential economic/computer-use action.

The specification must include information hierarchy, states, transitions, empty/loading/error/permission states, responsive behavior, accessibility behavior, and the exact progressive-disclosure boundary for each journey.
