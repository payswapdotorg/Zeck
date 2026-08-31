# ADR-0017 — Procedural competence, session/gateway fabric and runtime interoperability

Status: Accepted architectural augmentation

Date: 2026-08-31

## Decision

Zeck will remain the neutral execution optimization/control plane rather than becoming a monolithic agent framework. Agent runtimes such as OpenClaw, Hermes and WorkflowOS are external runtimes that can participate through provider-neutral adapters.

Zeck will add four platform concepts over time:

1. **Procedural competence** — versioned, provenance-bearing reusable procedures that may contain instructional knowledge, tool compositions, deterministic procedures, synthesized programs or verification recipes.
2. **Competence promotion and trust** — candidate competences are validated, verified, evaluated and explicitly promoted before production use. Agents cannot self-promote.
3. **Session/Gateway fabric** — channel and external-runtime ingress is represented through provider-neutral gateway/session contracts layered on Deployment and Execution; the gateway never becomes a second execution authority.
4. **Cross-runtime interoperability and learning** — external runtimes can submit governed executions and contribute observations to Zeck learning without acquiring policy, capability, budget, verification or execution authority.

## Authority boundaries

Execution remains the primary durable execution abstraction. Existing Policy, Capability, Budget, Verification, Agent, Sandbox, Deployment and Learning authorities remain singular.

The following are explicitly non-authoritative:

- external agents and runtimes
- skills/plugins
- competence candidates
- gateway/channel adapters
- benchmark/evaluation recommendations
- learning scores

All executable behavior continues through the normal Zeck governance chain.

## Competence lifecycle

```text
successful trajectory
        ↓
pattern mining
        ↓
candidate competence
        ↓
static/security validation
        ↓
sandbox validation
        ↓
verification
        ↓
shadow evaluation
        ↓
promotion gate
        ↓
versioned competence
        ↓
planner recommendation
```

A competence is advisory until it passes the normal promotion gate.

## Progressive disclosure

Competence/context retrieval should load only the procedural material relevant to the current task. This allows smaller/cheaper models to receive better task-specific procedural context instead of treating model size as the only optimization lever.

Competence retrieval must remain deterministic and bounded where possible and must not become an implicit execution side channel.

## Runtime interoperability

The canonical relationship is:

```text
OpenClaw / Hermes / WorkflowOS / customer runtime
                  ↓
          Zeck runtime adapter
                  ↓
          Zeck public contracts
                  ↓
Execution → Policy → Capability → Budget → Substrate → Verification
                  ↓
               Learning
```

Provider/framework-specific types stay inside adapters. Zeck does not depend on a specific external agent runtime.

## Session and gateway

Gateway and Session are connection/context concepts, not execution authorities. A session may preserve tenant, application, deployment, agent and execution lineage across turns, retries and interruptions.

Gateway responsibilities include ingress, translation, delivery retry and channel provenance. Execution, policy, budget, capability and verification remain elsewhere.

## Trust and supply chain

Reusable competences and executable artifacts carry immutable identity, version, publisher/source provenance, dependency and capability metadata, security status, verification status, evaluation history and rollback state.

Untrusted external skills, plugins, competences and runtimes cannot become production-eligible merely because an agent requests them or they have high historical scores.

## Deterministic-first alignment

Zeck must prefer a deterministic/API/tool/procedural solution when it is sufficient before invoking GUI interaction, generative inference or multi-agent strategies. Computer use, model calls and agent calls are computational options, not mandatory steps.

Successful AI trajectories should therefore be mined for opportunities to replace portions of execution with deterministic procedures, tool compositions or synthesized programs.

## Computer-use principle

Browser, desktop and terminal control are governed capabilities, not privileged agent abilities. Computer use should use an explicit escalation ladder:

```text
API / deterministic capability
        ↓ insufficient
browser automation
        ↓ insufficient
isolated desktop/terminal interaction
```

Each stage remains subject to the same Policy, Capability, Budget, Tenant, Credential, Execution and Verification authorities. A computer-use trajectory should produce structured, provenance-bearing observations and actions that can later be learned from or replaced by deterministic procedures.

## Relationship to existing work

- WORK-014: learning telemetry and scorecards provide the observational substrate.
- WORK-017: existing tool-composition learning becomes an input to competence formation.
- WORK-018: synthesized programs become one competence artifact type, with sandbox validation.
- WORK-023: deployment fabric provides the common deployment abstraction.
- WORK-027: computer-use implements the deterministic/API → browser → desktop capability ladder.
- WORK-031: computational substrates remain replaceable under the Execution abstraction.
- Future Work Orders will introduce competence lifecycle, session/gateway and cross-runtime trust capabilities as explicit governed units rather than expanding existing Work Orders beyond their declared scope.

## Rejected alternatives

### Build another full agent framework

Rejected. This duplicates OpenClaw/Hermes/WorkflowOS and conflicts with Zeck's mission to be the infrastructure layer beneath agent frameworks.

### Let agents own skill/competence promotion

Rejected. Agent-generated procedures are untrusted and must pass platform validation, verification and promotion gates.

### Make learning scores authoritative

Rejected. Historical success is evidence, not permission. Policy/capability/budget/verification remain hard constraints.

### Create a second session/execution state machine inside the gateway

Rejected. Gateway/session state must remain connection/context state and feed the canonical Execution abstraction.
