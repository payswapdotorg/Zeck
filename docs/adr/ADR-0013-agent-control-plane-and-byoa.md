# ADR-0013 — Agent Control Plane and BYOA

**Status:** ACCEPTED
**Architecture version:** v1.0 additive extension
**Related decision:** GitHub Issue #17 — Architecture Change: Agent control-plane lifecycle and BYOA

## Context

Contemporary agent control planes demonstrate that production agents need more than model invocation: organizations need stable agent identity, inventory, versioning, scoped credentials, runtime policy enforcement, approvals, auditability and interoperability with agents built outside the platform.

Zeck already defines Agent as a strategy/participant within an Execution and already owns policy, capability, budget, execution lifecycle, verification and provenance authorities. The useful control-plane capabilities can therefore be adopted without making Agent the top-level abstraction.

## Decision

Zeck adopts the following additive agent control-plane capabilities:

1. **Agent identity and inventory** — every governed agent has a stable identity, ownership metadata and a discoverable catalog record.
2. **Versioned agent artifacts** — agent definitions/configuration/runtime references are immutable versioned artifacts with validation and promotion/rollback metadata.
3. **Mediated credentials and access** — model/tool/endpoint credentials remain platform-managed, scoped, revocable and policy-mediated; long-lived raw secrets must not be embedded in agent code or agent configuration sent to runtime.
4. **Runtime approval gates** — policy may require explicit human approval before designated high-risk agent actions.
5. **BYOA interoperability** — Zeck can register and govern agents created with external frameworks or runtimes through provider-neutral adapters.
6. **Complete agent session provenance** — governed sessions record inputs, invoked capabilities, tool calls, significant decisions, outputs and authorization context as execution evidence.

## Non-decisions

- Agent is not promoted above Execution as Zeck's primary abstraction.
- Zeck does not become an agent framework.
- Agent execution does not create a second policy engine, capability registry, budget authority, execution state machine or verification authority.
- Customer-domain state remains outside Zeck.

## Consequences

Positive:
- Zeck can govern existing agents instead of requiring developers to rebuild them.
- Agents become production-manageable, versionable and reversible artifacts.
- Security posture improves through scoped, mediated access and explicit approval gates.
- Agent inventory and provenance support organization-wide visibility and future optimization.
- External agent frameworks can become Zeck execution participants without changing the Execution API.

Tradeoffs:
- Agent lifecycle now requires additional identity and version metadata.
- Runtime adapters must preserve provider/framework neutrality.
- Approval gates can add latency and require clear policy configuration.

## Implementation ownership

- WORK-011 owns agent identity, inventory contract, versioning, mediated runtime access and approval semantics.
- WORK-015 owns public API/SDK/CLI/dashboard surfaces for agent inventory and lifecycle inspection.
- WORK-016 owns BYOA adapter interoperability and benchmark coverage.

## Verification expectation

The implementations must include discrimination tests showing that:
- unregistered or revoked agent versions cannot run;
- raw long-lived secrets cannot cross into agent runtime contracts;
- approval-required actions cannot execute without approval;
- cross-tenant sessions/workspaces are rejected;
- an external framework adapter cannot mutate Zeck or customer workflow state outside its declared authority.
