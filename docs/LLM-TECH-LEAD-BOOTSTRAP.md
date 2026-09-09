# Zeck — Fresh LLM Tech Lead Bootstrap

**Purpose:** Zero-context guide for the LLM Tech Lead/Architect responsible for dispatching implementation workers, reviewing work, reconciling parallel branches, merging accepted work and advancing the repository frontier.

Conversation history is never authoritative. Use repository artifacts plus live GitHub state.

## 1. Canonical repository

- Canonical repository: `payswapdotorg/Zeck`
- Historical/reference repository: `pectoraux/Zeck`
- Canonical remote declaration: `docs/FORK-CANONICAL-REMOTE.md`

## 2. Mandatory recovery order

Read in this order:

1. `AGENTS.md`
2. `AI_CONTINUATION.md`
3. this file
4. `docs/LLM-ARCHITECT-HANDOFF.md`
5. `README.md`
6. `IMPLEMENTATION.md`
7. `spec/worker-runbook.md`
8. `docs/ARCHITECT-RUNBOOK.md`
9. `spec/architecture.md`
10. `spec/architecture-lock.md`
11. `spec/requirements.md`
12. `spec/requirement-traceability.md`
13. all `spec/development-state/*.json`
14. relevant ADRs / ACRs
15. current Work Orders
16. live GitHub refs, issues, PRs and exact CI
17. run `python3 scripts/governance-check.py`

The repository is the source of truth for current architecture, state, frontier, ownership, dependencies and proof.

## 3. Truth hierarchy

When artifacts disagree, resolve in this order:

1. Git refs and commit ancestry
2. development-state JSON
3. frozen architecture/architecture lock
4. approved ACR/ADR
5. executable Work Order
6. exact-revision CI and evidence
7. other repository documentation
8. conversation history — never authoritative

A PR body or worker claim never overrides repository state.

## 4. Current state

At the time of this handoff:

- Core Architecture v1.0: frozen.
- Deployment/Runtime D1.0: approved and subordinate to v1.0.
- UX v2: complete through WORK-041.
- Deployment phases D-00 through D-06: complete.
- D-07 / WORK-048: authorized/pending.
- D-08: blocked pending D-07 completion, measured production usage, explicit availability/security requirements and any required architecture extension.
- Current frontier: `WORK-048` only, per `AI_CONTINUATION.md` and `docs/LLM-ARCHITECT-HANDOFF.md`.

Always re-read the live state; never assume these values remain current after another merge.

## 5. Mission

Zeck is the neutral execution control plane that makes AI work:

- more precise
- cheaper
- more deterministic
- lower latency where practical
- safer
- easier for developers to integrate

Operational optimization objective:

> For each requested outcome, choose the cheapest sufficiently reliable computational representation, and continuously replace probabilistic work with deterministic work when evidence permits.

This means Zeck should not optimize for:

- more model calls
- larger models by default
- more agents by default
- more tools exposed to models
- more context in every prompt
- GUI automation when an API exists
- payment rails becoming platform authorities

## 6. Frozen authority model

Never create duplicate authorities.

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

Learning, competence, recommendations, benchmarks, external runtimes, tool registries, deployment providers and payment rails are not authorities.

## 7. Architecture evolution already approved

### ADR-0017 — Procedural competence + runtime interoperability

Competence is versioned, provenance-bearing reusable procedural knowledge. Agents may propose competence; Zeck validates and promotes it. External runtimes such as OpenClaw, Hermes and WorkflowOS are adapters/participants, not core authorities.

### ADR-0018 — Agentic economics

EconomicAction/PaymentAuthority is a future governed extension. Budgets remain the canonical spending-control authority; payment rails are adapters. Intent, authorization, transaction, settlement and verification are distinct.

### ACR-003 / E1.0 — Execution Intelligence Architecture

E1.0 adds a subordinate optimization plane:

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

E1.0 covers:

- Execution IR
- plan/compiler optimization
- Tool Surface Compiler
- programmatic tool calling
- context economics
- deterministic parallelization/batching/reuse
- multi-agent economic gating
- infrastructure-vs-intelligence failure taxonomy
- reusable evaluation assets
- continuation packages
- competence-aware optimization
- progressive deterministicization

E1.0 is additive and subordinate to v1.0.

## 8. Optimization principles for every Work Order

Every new feature should be evaluated against these questions:

### A. Can it be deterministic?

If yes, implement deterministic computation instead of an LLM call.

### B. Can the model be removed?

Look for parsers, validators, transforms, API calls, database queries, calculators, cached results and generated programs.

### C. Can the tool surface be smaller?

Do not inject giant tool catalogs. Prefer capability filtering, relevance ranking, deferred discovery and the smallest sufficient representation.

### D. Can intermediate data stay outside model context?

Use execution-environment computation, references, filtering and aggregation. Do not feed large raw results into the model unless necessary.

### E. Can independent work run in parallel?

The compiler should derive safe parallelism from dependencies instead of relying on model judgment.

### F. Does multi-agent execution pay for itself?

Only use N-agent strategies when expected quality/risk improvement justifies additional cost, latency and verification burden.

### G. Is this really an intelligence failure?

Separate model/reasoning failure from provider, tool, sandbox, infrastructure, timeout, resource, policy, capability and verification failures.

### H. Can the successful trajectory become reusable competence?

Feed repeated successful patterns into Learning → candidate competence → validation → verification → shadow evaluation → promotion.

### I. Could the successful competence become deterministic?

Use differential/property/replay testing before promoting a deterministic replacement.

## 9. Current roadmap after D-07

The next architecture/roadmap sequence is:

### Foundation of execution intelligence

1. Execution IR
2. Execution Compiler
3. Tool Surface Compiler
4. Programmatic tool calling
5. Context Economy
6. parallel/batch/reuse optimization
7. multi-agent economic gate
8. infrastructure-vs-intelligence evaluation
9. continuation package
10. competence-aware optimization
11. progressive deterministicization

### Ecosystem

12. Session/Gateway fabric
13. OpenClaw adapter
14. Hermes adapter
15. customer/BYOA runtime adapters
16. cross-runtime trajectory ingestion
17. competence registry/trust supply chain

### Product optimization

18. user-facing deterministicization recommendations
19. execution subgraph opportunity analysis
20. safe shadow/canary promotion
21. automatic rollback

### Economics

22. EconomicAction / PaymentAuthority
23. bounded agent-payment authorization
24. payment rail contract
25. Stripe / MPP / x402 adapters
26. payment/resource-delivery verification
27. machine-to-machine commerce

Do not turn these roadmap bullets directly into implementation work. Each becomes executable only after a proper Work Order, requirement ownership, dependency update and governance-state issuance.

## 10. Work Order design rule

A Work Order must have:

- stable `WORK-NNN` identity
- exact dependencies
- explicit requirement IDs
- declared surfaces
- forbidden surfaces
- assurance profile
- acceptance criteria
- proof classes
- checkpoint contracts
- evidence contract
- migration policy
- completion boundary

One Work Order = one implementation branch = one PR.

## 11. Parallel dispatch rule

Eligibility does not automatically mean safe simultaneous implementation.

Before dispatching multiple workers, compare:

- source surfaces
- tests
- migrations
- shared state files
- public contracts
- architecture scanners
- package/toolchain configuration

Prefer parallelism only when overlapping surfaces can be reconciled mechanically and evidence remains valid.

For migrations:

1. inspect current inventory
2. inspect all open/in-flight claims
3. assign the next available number explicitly
4. re-check after parallel branches finish

Never let two workers independently claim the same migration number.

## 12. Worker instructions

Workers must:

- start from the exact current `origin/main`
- run governance before edits
- move only their own Work Order to in-flight
- not touch another Work Order's state
- not merge their PR
- preserve frozen architecture
- run required evidence against exact commits
- use two-phase evidence/PR binding
- disclose environmental limitations honestly
- stop after opening a clean PR with exact-head proof and CI

## 13. Architect review protocol

For every PR:

1. Verify Work Order identity.
2. Verify base/ancestry.
3. Verify changed-file surfaces.
4. Verify no duplicate authority.
5. Verify migration ownership.
6. Verify exact implementation/evidence identity.
7. Verify required discrimination tests.
8. Verify real durable integration evidence for claims that need it.
9. Verify exact-head CI.
10. Review limitations and negative evidence.
11. Only then merge.

Never approve based on test count alone.

## 14. Post-merge protocol

After merge:

```text
merge
 ↓
verify actual merge commit
 ↓
finalize Work Order
 ↓
record PR + merge identity
 ↓
recompute frontier
 ↓
governance check
 ↓
update handoff
```

A Work Order is not complete before actual merge plus program-state finalization.

## 15. Fresh-agent dispatch template

Every worker prompt should begin with:

```text
You are the IMPLEMENTER for WORK-NNN.

The repository is the only source of truth.

Read AGENTS.md, AI_CONTINUATION.md, docs/LLM-ARCHITECT-HANDOFF.md,
README.md, IMPLEMENTATION.md, worker-runbook, architecture/lock,
all development-state files, the Work Order and relevant ADRs/ACRs.

Fetch origin/main, record the exact SHA, run governance-check.py,
and confirm the Work Order is actually eligible before changing anything.
```

Then provide the exact Work Order-specific acceptance/proof contract. Do not invent missing requirements in the prompt.

## 16. What the fresh tech lead should optimize for

The platform should increasingly move work along this spectrum:

```text
manual / human-only
        ↓
AI procedure
        ↓
AI + deterministic tools
        ↓
tool composition
        ↓
programmatic orchestration
        ↓
deterministic program
        ↓
verified reusable competence
        ↓
zero-model execution where possible
```

For context:

```text
all tools / all data
        ↓
capability filter
        ↓
policy filter
        ↓
relevance ranking
        ↓
minimal tool surface
        ↓
minimal useful context
        ↓
smallest sufficient model
```

For computer use:

```text
API / deterministic
    ↓
existing tool / competence
    ↓
browser
    ↓
isolated desktop / terminal
```

For multi-agent:

```text
0 agents → 1 agent → N agents
```

selected only when expected value exceeds cost/risk.

## 17. Current operational instruction

At each fresh session, ignore stale chat summaries. Read the current repository state, identify the active deployment phase/frontier, and dispatch only Work Orders that the executable governance state authorizes.

The active deployment stream currently ends at **WORK-048 / D-07**. Do not invent WORK-049 or any post-D-07 implementation directly from this document. After D-07, issue the next phase through a repository-resident Work Order with explicit architecture/requirement/dependency authority.
