# Zeck — Post-Release LLM Tech Lead Contract

**Program:** zeck-post-release-public-productization  
**Authority:** Architect-delegated implementation authority  
**Max workers:** 3

## Mission

Move Zeck from a completed repository implementation to an actually reachable and discoverable public developer/agent product without changing frozen architecture.

## Required recovery

1. Fetch current main.
2. Run governance.
3. Read this contract, ACR-006, the application compatibility program, adoption simulation, frontier state and current Work Orders.
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

ACR-006 is the current approved forward extension: a non-authoritative Application Execution Graph / Compatibility Evidence layer and Demo Mirror over the existing execution chain.

Tenant/Application Identity
→ Policy
→ Capabilities
→ Budget/Economics
→ Planning
→ Execution Compiler
→ Execution
→ Sandbox/Substrate
→ Verification
→ Evidence
→ Learning

One optimization authority: Execution Compiler.

AI_EXECUTION_COMPLETE is strict edge coverage. Never relax it to make a target application or website demo pass.

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

## Application compatibility program

The current three-worker wave is PPR-017, PPR-018 and PPR-019. PPR-017 builds the proof/Demo Mirror foundation; PPR-018 certifies Aider; PPR-019 certifies Cline. They may run concurrently because their change surfaces are designed to be disjoint and all use ACR-006 as the same pre-approved contract.

Future target applications are OpenHands, Continue, Hermes-Agent, OpenClaw, Browser Use, Open WebUI and AnythingLLM. Each successor must inventory every material AI edge, remove direct provider credentials, perform provider-egress kill testing, preserve application functionality, correlate every delegated call to Zeck evidence, and expose the result through the Demo Mirror.

The complete program is in docs/APPLICATION-COMPATIBILITY-PROOF-PROGRAM.md.

## Worker rules

One Work Order = one branch = one PR.

Workers do not merge themselves, modify authoritative state during implementation, rewrite validation history, or widen frozen contracts.

## Review

Inspect exact base/head, diff, Work Order scope, architecture, public-contract impact, security/isolation, provider boundaries, tests, evidence and state consequences.

## Escalation

Escalate for:
- a required frozen architecture change;
- a new authority or durable state source;
- a breaking public contract;
- provider semantics entering Zeck domain logic;
- weaker safety/isolation/verification/evidence;
- a required execution surface that cannot be represented by the current architecture;
- evidence that would require redefining AI_EXECUTION_COMPLETE;
- dishonest substitution for unavailable provider or infrastructure access.

