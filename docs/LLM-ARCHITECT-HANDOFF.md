# Zeck — LLM Architect Handoff

**Purpose:** Durable, repository-resident handoff for a fresh LLM Architect / LLM Tech Lead. Conversation history is never authoritative.

## Canonical remote

- Repository: `payswapdotorg/Zeck`
- `pectoraux/Zeck` is historical upstream/reference only.
- Canonical-remote declaration: `docs/FORK-CANONICAL-REMOTE.md`.

## Current state

- Core architecture: **v1.0**, frozen after approval.
- Deployment/runtime architecture: **D1.0**, approved and subordinate to v1.0.
- Execution Intelligence Architecture: **E1.0**, approved by ACR-003/ADR-0019 and subordinate to v1.0.
- UX v2: complete through WORK-041.
- Deployment phases D-00 through D-06: complete.
- Current authorized deployment phase: **D-07 / WORK-048 — resilience, disaster recovery and provider exit**.
- Canonical issue: **#13**.
- Current frontier: `eligible=["WORK-048"]`, `inFlight=[]`, `blocked=[]`.

The current exact `main` SHA must always be fetched and verified at recovery time. Do not hard-code a stale SHA from this document.

## Mission

Zeck is the neutral execution optimization layer for AI work.

> **For every requested outcome, choose the cheapest sufficiently reliable computational representation, and continuously replace probabilistic work with deterministic work when evidence permits.**

Optimize:

- precision/correctness
- cost
- deterministicism
- latency
- reliability
- context cost
- tool-surface cost
- side-effect/risk exposure
- developer simplicity

Zeck is not trying to become the largest agent framework, payment processor, browser controller, model provider or deployment provider.

## Authority model

Frozen v1.0 remains authoritative:

```text
Tenant / Application Identity
        ↓
Policy
        ↓
Capabilities
        ↓
Budget / Economics
        ↓
Planning
        ↓
Execution
        ↓
Sandbox / Substrate
        ↓
Verification
        ↓
Evidence
        ↓
Learning
```

No subsequent architecture may create a second authority for any of these concerns.

## Architecture evolution

### D1.0 — Deployment/runtime

Providers supply infrastructure. Zeck owns domain authority. PostgreSQL remains authoritative for durable state; object storage owns artifact bytes; queues/workflows transport/orchestrate; Redis is non-authoritative coordination/cache.

Authoritative documents:

- `docs/DEPLOYMENT-ARCHITECTURE.md`
- `docs/DEPLOYMENT-ROADMAP.md`
- `docs/architecture-changes/ACR-002-deployment-runtime-architecture.md`

### ADR-0017 — Procedural competence/runtime interoperability

Competence is versioned, provenance-bearing reusable procedural knowledge. Successful trajectories may become candidate competence, but validation/verification/promotion remain platform-controlled. OpenClaw, Hermes, WorkflowOS and customer runtimes integrate through adapters rather than becoming Zeck authorities.

### ADR-0018 — Agentic economics

EconomicAction and PaymentAuthority are future execution-control extensions. Budgets remain canonical spending authority. Payment rails such as Stripe/MPP/x402 are adapters. Intent, authorization, transaction, settlement and verification are distinct.

### E1.0 — Execution Intelligence

Authoritative documents:

- `docs/adr/ADR-0019-execution-intelligence-architecture.md`
- `docs/architecture-changes/ACR-003-execution-intelligence-architecture.md`
- `docs/ROADMAP.md`
- `docs/LLM-TECH-LEAD-BOOTSTRAP.md`

E1.0 adds an optimization plane after a governed plan exists:

```text
Intent
 ↓
Policy
 ↓
Capability
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

E1.0 covers Execution IR, plan/compiler optimization, Tool Surface Compiler, programmatic tool calling, Context Economy, safe parallelism/batching/reuse, multi-agent economic gating, infrastructure-vs-intelligence failure attribution, continuation packages, competence-aware optimization and progressive deterministicization.

The optimizer can transform a governed plan but cannot authorize behavior.

## Strategic product principles

### Deterministic-first

Prefer:

```text
deterministic code
  ↓
existing tool / competence
  ↓
programmatic orchestration
  ↓
smallest sufficient model
  ↓
larger model only when justified
  ↓
multi-agent only when economically justified
  ↓
human only when uncertainty warrants it
```

### Tool-surface economy

Do not expose the full tool universe to every model. Filter by capability/policy/relevance and choose the lowest-overhead representation: direct tool, deferred tool, CLI, script, code API, MCP or competence.

### Context economy

Keep large intermediate results outside model context when semantic inspection is unnecessary. Prefer filtering, aggregation, references and compact structured results. Context itself is an optimization resource.

### Computer use

Computer use is an escalation mode, not a default:

```text
API / deterministic
 → existing tool / competence
 → browser
 → isolated desktop / terminal
```

### Learning → competence → deterministicization

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

The long-term goal is that repeated successful probabilistic behavior becomes reusable deterministic computation where equivalence can be proven.

## Current implementation stream

The repository's current active stream is deployment D-07:

`spec/work-orders/WORK-048.md`

D-07 covers resilience, disaster recovery and provider exit, including PostgreSQL recovery, artifact recovery, queue/workflow replay, worker evacuation, outage simulation, alternate artifact storage, alternate managed PostgreSQL, alternate web/API hosting, and measured RTO/RPO evidence.

Do **not** invent WORK-049 or a new deployment phase from chat. D-08 is explicitly blocked until D-07 completion, measured production usage, explicit availability/security requirements and any required architecture extension.

## Post-D-07 strategic queue

The next architecture-level implementation sequence is planned but not executable until proper Work Orders are issued:

### Execution Intelligence

1. Execution IR
2. Execution Compiler
3. Tool Surface Compiler
4. Programmatic tool calling
5. Context Economy
6. deterministic parallelization/batching/reuse
7. multi-agent economic gate
8. infrastructure-vs-intelligence evaluation
9. continuation packages
10. competence-aware optimization
11. progressive deterministicization

### Competence/runtime ecosystem

12. Competence lifecycle
13. progressive competence retrieval
14. competence validation/promotion
15. competence registry/trust supply chain
16. Session/Gateway fabric
17. OpenClaw adapter
18. Hermes adapter
19. customer/BYOA runtime adapters
20. cross-runtime trajectory ingestion

### Product optimization

21. user-facing codebase/subgraph opportunity analysis
22. deterministicization recommendations
23. shadow/canary replacement evaluation
24. safe promotion/rollback

### Economic execution

25. EconomicAction / PaymentAuthority
26. bounded machine-payment authorization
27. payment rail contract
28. Stripe / MPP / x402 adapters
29. payment/resource-delivery verification
30. machine-to-machine commerce

These are roadmap concepts, not current implementation authority.

## Work Order / worker protocol

One Work Order = one implementation branch = one PR.

Before dispatch:

1. fetch `origin/main`
2. run governance
3. confirm actual eligibility
4. inspect dependencies/surfaces/migrations/open PRs
5. compare shared-state and public-contract overlap
6. decide safe parallelism

Worker constraints:

- do not invent requirements
- do not modify another Work Order's scope
- do not merge own PR
- do not weaken frozen architecture
- preserve single authorities
- use real durable integration proof for durable/concurrency/side-effect claims
- bind evidence to exact tested revisions
- disclose environmental limitations

Architect review:

1. identity/base/ancestry
2. surfaces
3. authority boundaries
4. migration ownership
5. discrimination evidence
6. durable/concurrency proof
7. exact-head CI
8. limitations and negative evidence
9. merge
10. post-merge state finalization

## Post-merge protocol

```text
merge approved PR
 ↓
verify actual merge commit
 ↓
finalize program state
 ↓
record PR + merge identities
 ↓
recompute frontier
 ↓
governance check
 ↓
update this handoff
```

A Work Order is not complete merely because its implementation PR is green; actual merge plus state finalization is required.

## Fresh-session recovery command set

```bash
git fetch origin
git rev-parse origin/main
python3 scripts/governance-check.py
```

Then inspect:

```text
AGENTS.md
AI_CONTINUATION.md
docs/LLM-ARCHITECT-HANDOFF.md
docs/LLM-TECH-LEAD-BOOTSTRAP.md
README.md
IMPLEMENTATION.md
spec/architecture.md
spec/architecture-lock.md
spec/requirements.md
spec/requirement-traceability.md
spec/development-state/*.json
relevant ADRs/ACRs
current Work Orders
live GitHub PRs/issues/checks
```

## Fresh-session invariant

A fresh LLM Tech Lead must be able to recover:

- canonical repository
- current architecture
- current deployment phase
- current frontier
- dependency graph
- Work Order ownership
- exact implementation/review state
- architecture evolution
- next strategic implementation sequence

without conversation history.
