# ACR-006 — Application Execution Compatibility and Proof Architecture

Status: APPROVED / FORWARD ARCHITECTURE EVOLUTION
Architecture baseline: v1.0 + D1.0 + E1.0 + E1.1
Approval date: 2026-09-26

## Decision

Extend Zeck with a non-authoritative Application Execution Compatibility layer.

It does not execute work, choose providers, authorize access, own budgets, verify customer-domain outcomes, or become a second optimizer. It describes and proves the boundary between an external application and Zeck.

The governing execution chain remains:

Tenant/Application Identity → Policy → Capabilities → Budget/Economics → Planning → Execution Compiler → Execution → Sandbox/Substrate → Verification → Evidence → Learning

## New architectural concepts

### 1. Application Execution Graph

For a pinned application version, record every material AI-execution edge:

application component → execution surface → transport/adapter → external AI execution

An edge is material when the application would otherwise make a provider/model/AI-service execution decision or invoke an AI service directly.

Initial execution-surface vocabulary:

- text generation
- structured generation
- vision / image understanding
- embeddings
- reranking
- retrieval / context computation
- speech recognition
- speech generation
- image generation
- video generation
- 3D generation
- realtime multimodal session
- search / AI search
- extraction / document intelligence
- browser-use intelligence
- computer-use intelligence
- agent delegation
- deterministic computation
- sandbox / program execution
- human escalation

This vocabulary is additive to the existing 22 workload-family manifest. It does not replace, weaken, or reinterpret that manifest.

### 2. Execution Delegation Contract

An application may delegate a material AI execution edge through the public Zeck execution boundary.

The application supplies outcome/task information and application-owned context/constraints appropriate to the integration. Zeck owns execution identity, policy admission, capability resolution, budget/economic control, planning, execution compilation, provider/model/tool/substrate selection, policy-permitted retry/escalation, verification, evidence, telemetry and provenance.

The application retains domain state, UX, domain workflow state, business rules, and non-AI integrations that are explicitly outside the delegated surface.

The public contract must not require customer applications to import Zeck internals such as ExecutionService, provider adapters, planner internals, ledger stores, or domain repositories.

### 3. Compatibility Evidence Record

A compatibility record binds:

- application identity and pinned upstream revision;
- integration revision;
- declared execution graph;
- every material AI edge and disposition;
- Zeck execution identifiers;
- direct-provider egress observations;
- provider credential presence/absence;
- runtime evidence;
- quality/reliability/economic comparison;
- limitations and NOT-RUN causes.

It is evidence, subordinate to the existing Evidence authority.

### 4. Compatibility statuses

The only application-level statuses are:

- UNASSESSED
- PARTIAL
- BLOCKED
- BYPASS_DETECTED
- AI_EXECUTION_COMPLETE

AI_EXECUTION_COMPLETE requires:

1. every declared material AI execution edge is delegated through Zeck;
2. direct AI-provider egress is absent or provably blocked during the proof;
3. the application remains functionally usable for the declared corpus;
4. Zeck execution records/evidence exist for every delegated edge;
5. no fixture, simulation, or mocked provider path is counted as external PASS.

This definition must never be relaxed to make a demo pass.

### 5. Demo Mirror

The website may expose a Demo Mirror for a certified application.

It is a proof surface, not a second application authority.

The required flow is:

select application → choose declared task → run representative task → observe application result → inspect Zeck execution trace → inspect route/cost/latency/evidence → reproduce

The mirror must execute the actual certified integration path, or a pinned application runtime, rather than a toy response generator.

## Completeness rule

Zeck completeness for an application is an edge-coverage property, not a provider-count property.

An application is not complete because its main chat model uses Zeck while an auxiliary summarizer, vision call, media call, retrieval model, AI search provider, or other material AI edge bypasses Zeck.

Conversely, an application does not have to surrender ordinary domain logic, database state, UI, Git operations, or non-AI APIs to achieve AI-execution completeness.

## Architecture-gap test

For every compatibility failure:

- architecture enables, implementation does not → implementation gap;
- public boundary exists architecturally but integration requires Zeck internals → public-contract/implementation gap;
- required execution surface cannot be represented without a second authority or frozen-invariant violation → architecture-gap candidate;
- provider/credential/region/quota/infrastructure unavailable → external/operator boundary, not architecture evidence.

## Non-goals

ACR-006 does not create a compatibility authority competing with Execution, create another routing/optimization service, move customer state into Zeck, require upstream forks, or weaken verification/evidence.

## Consequence

The future claim becomes experimentally falsifiable:

Independent applications in materially different AI categories can remove their direct AI-execution/provider infrastructure and delegate that execution to Zeck through one stable provider-neutral boundary, while retaining their own domain logic and UX.
