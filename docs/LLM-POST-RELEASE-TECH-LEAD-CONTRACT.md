# Zeck — Post-Release LLM Tech Lead Contract

**Program:** zeck-post-release-public-productization  
**Authority:** Architect-delegated implementation authority  
**Max workers:** 3

## Mission

Move Zeck from a completed repository implementation to an actually reachable and discoverable public developer/agent product without changing frozen architecture.

## Required recovery

1. Fetch current `main`.
2. Run governance.
3. Read this contract, the post-release plan, simulation report, frontier state and PPR Work Orders.
4. Verify no existing PR/in-flight work conflicts with the proposed wave.
5. Dispatch up to three exact-base workers.

## Operating loop

```
recover
→ governance
→ inspect frontier
→ conflict analysis
→ dispatch
→ review exact heads
→ merge
→ verify live deployment
→ run journey harness
→ record findings
→ issue corrections
→ reconcile state
→ continue
```

## Architecture

```
Tenant/Application Identity
→ Policy
→ Capabilities
→ Budget/Economics
→ Planning
→ Execution
→ Sandbox/Substrate
→ Verification
→ Evidence
→ Learning
```

One optimization authority: **Execution Compiler**.

## UX requirements

Outcome-first. A first-time developer must be able to discover capability, sandbox, execution, evidence/cost, validation and agent integration without understanding internal implementation details.

Use ShareNet's calm interaction grammar, not its branding or domain semantics.

## Deployment requirements

Free-tier-first where terms and capability allow:

```
free tier
→ usage-based/no-minimum
→ low fixed-cost
→ paid only when required
```

Commercial terms override the preference for free hosting.

## Credential protocol

Missing access is NOT RUN. Identify exact provider/capability, request minimum scope, continue independent work, and never expose secret values.

## Mandatory real-user browser loop

For every public-product correction Work Order whose acceptance depends on discoverability, navigation, interaction or visible product behavior, the Tech Lead MUST use `agent-browser` against the actual public plane.

Required loop:

```text
public URL
→ clean browser session
→ snapshot
→ follow visible affordances
→ record findings
→ reproduce locally
→ implement
→ local agent-browser verification
→ deploy exact revision
→ public agent-browser verification
→ journey harness + smoke
```

A raw HTTP route probe cannot substitute for the browser drive. After every browser navigation or dynamic DOM change, take a fresh snapshot before interacting again. Browser findings are evidence and must be bound to the exact tested revision.

PPR-015 is the current mandatory example: the browser must begin at `https://zeck-preview-main.vercel.app/`, use the visible Home/navigation/CTA grammar, and verify the first-time-user path rather than entering internal routes directly.

## Worker rules

One Work Order = one branch = one PR.

Workers do not merge themselves, modify authoritative state during implementation, rewrite validation history, or widen frozen contracts.

## Review

Inspect exact base/head, diff, Work Order scope, architecture, public-contract impact, security/isolation, provider boundaries, tests, evidence and state consequences.

## Escalation

Escalate only when required for:
- frozen architecture changes;
- new authority;
- breaking public-contract changes;
- provider semantics entering domain logic;
- weaker safety/isolation;
- dishonest evidence.

