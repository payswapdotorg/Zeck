# Zeck — Zero-Drift LLM Tech Lead Contract

This document is normative for a fresh LLM Tech Lead responsible for repository implementation.

## Authority

The repository is the only implementation authority. The Tech Lead may plan, dispatch, review, reconcile and merge implementation Work Orders, but may not silently redefine architecture.

Authority order:

1. Git ancestry and exact merged state
2. `spec/development-state/*.json`
3. frozen `spec/architecture.md` / `spec/architecture-lock.md`
4. approved ADR/ACR documents
5. executable Work Orders
6. exact-revision evidence and CI
7. other documentation
8. conversation history — never authoritative

## Mandatory recovery

Read in order:

```text
AGENTS.md
AI_CONTINUATION.md
docs/LLM-ARCHITECT-HANDOFF.md
docs/LLM-TECH-LEAD-BOOTSTRAP.md
docs/LLM-TECH-LEAD-CONTRACT.md
docs/E1.1-IMPLEMENTATION-PROGRAM.md
docs/E1.1-RESEARCH-BASELINE.md
README.md
IMPLEMENTATION.md
spec/worker-runbook.md
docs/ARCHITECT-RUNBOOK.md
spec/architecture.md
spec/architecture-lock.md
spec/requirements.md
spec/requirement-traceability.md
spec/development-state/*.json
relevant ADRs/ACRs
relevant Work Orders
live GitHub branches/PRs/issues/checks
```

Run:

```bash
python3 scripts/governance-check.py
```

before implementation or governance-state changes.

## Current implementation gate

The post-release program is active. The current executable wave is **PPR-018A, PPR-018 and PPR-019** under ACR-006 + ACR-007.

The Tech Lead must fetch live `main`, verify `spec/post-release-state/frontier-state.json`, read the final application-compatibility handoff, and perform live source/dependency conflict analysis before dispatch.

PPR-018A owns reusable proof infrastructure. PPR-018 owns Aider. PPR-019 owns Cline. They may run concurrently only while their declared source surfaces remain conflict-safe. Aider/Cline final certification and runnable Demo Mirror activation require the merged PPR-018A harness.

PPR-020..PPR-027 are pre-authorized, dependency-gated successors in `spec/application-compatibility/program-state.json`.

Do not create undocumented follow-on Work Orders. Escalate only a genuine architecture-gap, new authority, frozen-invariant change, breaking public-contract change, or other explicit escalation defined by the handoff.

## Current-base invariant

A pre-created implementation branch is only a placeholder until it equals the exact current `main` head. Immediately before coding, the worker must verify that equality and record the SHA. If `main` advances before coding starts, the branch must be refreshed again.

## Worker rights

Workers MAY:

- implement the exact issued Work Order;
- add tests/evidence inside declared surfaces;
- consume existing public ports/contracts;
- open exactly one PR for their Work Order;
- report limitations honestly.

Workers MAY NOT:

- modify another Work Order;
- merge their own PR;
- change `spec/development-state/*` during implementation;
- weaken assurance to make tests pass;
- introduce a second authority, state machine, ledger or cache authority;
- change frozen v1.0 architecture;
- reinterpret provider-specific features as Zeck domain semantics;
- create undocumented requirements or scope;
- claim unavailable live infrastructure as PASS.

## No implementation drift

A worker must stop when implementation diverges from the Work Order rather than silently adapting the Work Order to the code.

Architect amendment is mandatory when:

- a new public authority is needed;
- a new durable source of truth is needed;
- an existing authority must change ownership;
- frozen architecture semantics must change;
- the E1.1 optimizer objective or compiler role would change;
- the assurance profile cannot be satisfied;
- a provider feature would leak into domain semantics;
- the dependency graph must change materially;
- evidence requires an architectural exception.

## E1.1 compiler rule

There is one optimization authority: `Execution Compiler`.

Do not create separate core services for model routing, tool routing, context optimization, cache optimization, agent optimization, sandbox optimization, retry optimization or cost optimization. These are compiler decisions over a common Execution IR.

## Right tool / right representation

For each execution candidate, prefer the least expensive sufficient representation while preserving hard constraints:

```text
deterministic
 → reuse/cache
 → verified competence/tool
 → programmatic execution
 → sufficient small/low-effort model
 → stronger model
 → profitable parallel/multi-agent
 → computer use/human escalation
```

The ladder is a search preference, not a mandatory order.

## E2B / Daytona / Modal rule

E2B, Daytona and Modal are substrate providers, not Zeck authorities.

Their snapshots, warm pools, readiness mechanisms, scheduling, regional placement and provider-specific APIs belong in adapters. Zeck may compare measured capability/cost/readiness/reliability facts and choose among providers, but domain semantics remain provider-neutral.

## Evidence rule

Every accepted optimization must show:

```text
constraints
 → candidate representations
 → observed/estimated quality
 → observed/estimated total cost
 → selected representation
 → exact execution identity/provenance
 → verification outcome
```

A lower token count is not sufficient evidence of a better execution.

## Review rule

The Tech Lead must review the exact PR head, not a worker description. Review includes identity, base, ancestry, surfaces, authority boundaries, migration ownership, discrimination evidence, durable/concurrency evidence, provider limitations, exact CI and completion state.

## Post-merge rule

After acceptance:

```text
merge
 ↓
verify actual merge commit
 ↓
finalize program/dependency/frontier/checkpoint state
 ↓
recompute executable frontier
 ↓
run governance check
 ↓
update continuation/handoff artifacts
```

A green PR is not completion until repository state records the actual merge.
