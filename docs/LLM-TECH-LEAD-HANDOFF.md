# Zeck — Successor LLM Tech Lead Handoff

Repository: payswapdotorg/Zeck
Canonical remote: payswapdotorg/Zeck
Handoff date: 2026-09-26
Role: Successor LLM Tech Lead / Orchestrator / Reviewer / Deployment Verifier
Maximum concurrent workers: 3

## Current truth

Completed and closed:
- Core Architecture v1.0;
- D1.0 deployment/runtime architecture;
- E1.0;
- E1.1;
- D-00 through D-08;
- VAL-001 through VAL-052;
- DEP-001 through DEP-044;
- PPR-001 through PPR-015.

Current public preview evidence was completed through PPR-015 at exact revision e14989cd5990db586f3eb32fa7f861701d9d2b78, with the public browser/productization battery green.

PPR-016 is the remaining operator-bound capability-rail order. It is not the application-compatibility demonstration wave because its unresolved parts depend on provider/operator access.

The new architectural/product north star is governed by:
- docs/architecture-changes/ACR-006-application-execution-compatibility.md
- docs/APPLICATION-COMPATIBILITY-PROOF-PROGRAM.md
- docs/APPLICATION-COMPATIBILITY-ADOPTION-SIMULATION.md

## Authority chain

Tenant / Application Identity
→ Policy
→ Capabilities
→ Budget / Economics
→ Planning
→ Execution Compiler
→ Execution
→ Sandbox / Substrate
→ Verification
→ Evidence
→ Learning

There is one optimization authority: Execution Compiler.

## Application compatibility definition

The Application Execution Graph records every material AI-execution edge of a pinned application.

AI_EXECUTION_COMPLETE requires:
1. every declared material AI execution edge terminates in Zeck execution;
2. direct AI-provider egress is absent or provably blocked during the proof;
3. the application remains functionally usable for the declared corpus;
4. Zeck execution/evidence correlates every delegated edge;
5. mocks, fixtures and simulations never upgrade the status.

Do not reinterpret completeness to make a demonstration pass.

Applications retain their own domain state, UX, business rules, Git/editor operations and non-AI integrations unless those operations themselves contain material AI execution.

## Current executable wave — three workers

The current frontier authorizes exactly these three Work Orders:

### Worker 1 — PPR-017
Application Execution Graph, Compatibility Proof Harness, and Demo Mirror Foundation.

Implement the ACR-006 proof/evidence layer, strict status machine, static/runtime no-bypass checks, exact application/integration pinning, and reusable Demo Mirror shell.

The compatibility layer is observational/projection infrastructure. It must not become a second execution, capability, policy, budget, verification, evidence or optimization authority.

### Worker 2 — PPR-018
Aider Zeck-Complete Application Proof.

Pin Aider, use its existing model/LiteLLM seam, remove direct AI-provider execution, prove every material AI edge is delegated to Zeck, run the full compatibility battery, and register the real integration in the Demo Mirror.

### Worker 3 — PPR-019
Cline Zeck-Complete Application Proof.

Pin Cline, use its existing LLM provider abstraction, remove direct AI-provider execution, cover all material model/vision/auxiliary AI paths exercised by the corpus, run the compatibility battery, and register the real integration in the Demo Mirror.

These three orders are conflict-safe because they have disjoint implementation surfaces and all use the same already-approved ACR-006 contract. A max-three ceiling is a limit, not a requirement; reduce concurrency if live conflict analysis finds semantic reconciliation.

## Application progression after this wave

Successor Work Orders are planned but not executable until the Architect records them in frontier state:

PPR-020 OpenHands
PPR-021 Continue
PPR-022 Hermes-Agent
PPR-023 OpenClaw
PPR-024 Browser Use
PPR-025 Open WebUI
PPR-026 AnythingLLM
PPR-027 cross-application longitudinal economics and developer-adoption evidence

The ordering progresses from clean provider seams toward fragmented multi-surface execution graphs. It is not a quality ranking.

## Demo Mirror doctrine

A website demonstration is a proof surface into the real integration.

It must:
- run the pinned application integration or exact application runtime;
- expose the real task result;
- expose the correlated Zeck execution trace;
- expose route/model/provider/substrate facts when available;
- expose cost, usage, latency, verification and evidence when available;
- expose honest limitations and NOT-RUN states;
- provide reproduction metadata.

A polished UI is never evidence of completeness.

## Required compatibility battery

For every application:
- exact upstream revision and integration revision;
- complete AI edge inventory;
- credential isolation;
- provider egress kill;
- representative functional replay;
- trace/evidence correlation;
- duplicate/retry/provider failure replay;
- direct and optimized non-Zeck economic comparison;
- customization test;
- determinism/reuse opportunity measurement;
- telemetry inspection;
- static/runtime no-bypass inspection;
- website reproducibility.

The primary economic metric remains cost per successfully resolved outcome at comparable quality, reliability, latency and safety.

## PPR-016 operator frontier

PPR-016 remains blocked only where external access is missing:
- GAP-002: model-family credentials / provider rails;
- GAP-005: staging/production environments and custom domains;
- optional socket.io/socket.io-client 4.8.4 governed advance.

Do not mark unavailable providers as PASS and do not create speculative provider adapters.

## Governance and dispatch loop

fetch exact live main
→ governance check
→ read ACR-006 and current frontier
→ prove dependency/surface conflict analysis
→ dispatch at most 3 workers
→ review exact PR bases and evidence
→ merge only through Architect authority
→ verify merged main
→ verify public exact revision when applicable
→ finalize Work Order/frontier state
→ run governance
→ continue to next eligible wave

Workers never merge themselves and do not edit frontier authority during implementation.

## No drift

Stop and escalate rather than changing architecture when implementation would require:
- a second authority;
- a second durable execution state source;
- a second optimizer;
- weaker verification/evidence;
- direct provider semantics in Zeck domain modules;
- a frozen-invariant change;
- a new material AI capability hidden outside the execution-surface taxonomy;
- redefining AI_EXECUTION_COMPLETE around the test.

## Fresh recovery

Read:
1. AGENTS.md
2. AI_CONTINUATION.md
3. docs/LLM-ARCHITECT-HANDOFF.md
4. this file
5. docs/LLM-POST-RELEASE-TECH-LEAD-CONTRACT.md
6. docs/APPLICATION-COMPATIBILITY-PROOF-PROGRAM.md
7. docs/architecture-changes/ACR-006-application-execution-compatibility.md
8. spec/post-release-state/frontier-state.json
9. the current Work Orders
10. live GitHub state
11. python3 scripts/governance-check.py

Conversation history is not authoritative.
