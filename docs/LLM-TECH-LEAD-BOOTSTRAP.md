# Zeck — Fresh LLM Tech Lead Bootstrap

**Purpose:** Zero-context operational guide for the LLM Architect/Tech Lead responsible for implementation planning, dispatch, review, reconciliation, merge and repository-state finalization.

Conversation history is never authoritative. The repository plus live GitHub state is authoritative.

## 1. Mandatory recovery order

Read, in order:

1. `AGENTS.md`
2. `AI_CONTINUATION.md`
3. `docs/LLM-ARCHITECT-HANDOFF.md`
4. this file
5. `docs/LLM-TECH-LEAD-CONTRACT.md`
6. `docs/E1.1-IMPLEMENTATION-PROGRAM.md`
7. `README.md`
8. `IMPLEMENTATION.md`
9. `spec/worker-runbook.md`
10. `docs/ARCHITECT-RUNBOOK.md`
11. `spec/architecture.md`
12. `spec/architecture-lock.md`
13. `spec/requirements.md`
14. `spec/requirement-traceability.md`
15. every `spec/development-state/*.json`
16. relevant ADRs/ACRs
17. active Work Orders
18. live GitHub branches/PRs/issues/checks

Then run:

```bash
python3 scripts/governance-check.py
```

## 2. Authority hierarchy

Resolve disagreement in this order:

1. Git ancestry and actual merged state
2. development-state JSON
3. frozen architecture/architecture lock
4. approved ADR/ACR
5. executable Work Order
6. exact-revision evidence/CI
7. other documentation
8. chat history — never authoritative

Worker claims and PR bodies never override repository state.

## 3. Current implementation truth

At this handoff revision:

- v1.0 is frozen.
- D1.0 is approved and subordinate.
- E1.0 is approved.
- E1.1 is approved by ACR-004/ADR-0020.
- D-00 through D-06 are complete.
- `WORK-048 / D-07` is the only executable implementation item.
- D-08 is blocked until its explicit gates are satisfied.
- E1.1 implementation starts only after D-07 is complete and the Architect issues its next Work Order(s).

Never infer a future Work Order directly from chat or this bootstrap.

## 4. E1.1 architectural rule

E1.1 has one optimizer authority:

```text
Execution Compiler
```

Model selection, reasoning effort, tool-surface choice, context reduction, caching, reuse, duplicate-work coalescing, parallelism, agent count, retry/escalation, substrate selection and service-tier selection are compiler decisions.

Do NOT create separate core authorities such as Model Router, Tool Router, Context Optimizer, Cache Optimizer, Agent Optimizer, Sandbox Optimizer, Retry Optimizer or Cost Optimizer.

The compiler optimizes expected successful-resolution cost subject to hard quality, reliability, safety, policy, capability, budget, verification and side-effect constraints.

## 5. Maximum three concurrent workers

Maximum active implementation workers: **3**.

The Tech Lead must compare before every parallel dispatch:

- Work Order dependencies;
- source/module surfaces;
- schema/migration ownership;
- public contracts;
- tests/fixtures;
- package/toolchain files;
- manifests/configuration;
- architecture/governance artifacts.

Use fewer than three whenever semantic reconciliation is required or evidence could no longer be bound cleanly to a branch.

Never let two workers claim the same migration number.

Never let workers edit `spec/development-state/*` concurrently; governance-state ownership remains with the Architect.

## 6. E1.1 implementation sequence

The canonical implementation charter is `docs/E1.1-IMPLEMENTATION-PROGRAM.md`.

The sequence is:

```text
WORK-048
   ↓
WORK-049  Execution IR + outcome economics
   ↓
WORK-050  Execution Compiler
   ├──────────────┬──────────────┬──────────────┐
   ▼              ▼              ▼
WORK-051       WORK-052       WORK-053 / WORK-054
Tool/program   Context/reuse  Model/agent and/or substrate
   └──────────────┴──────────────┴──────────────┐
                                                  ▼
                                               WORK-055
                                        failure + escalation + continuation
                                                  ↓
                                               WORK-056
                                    competence + deterministicization
```

Actual concurrency is determined from live source surfaces and governance eligibility, not merely from this diagram.

## 7. Worker dispatch contract

Every worker must:

1. start from the exact current `origin/main`;
2. record the exact base SHA;
3. run governance before edits;
4. confirm the assigned Work Order is eligible;
5. change only declared surfaces;
6. preserve the frozen architecture and single-authority model;
7. test the acceptance and discrimination contract;
8. produce exact-revision evidence;
9. disclose NOT RUN external infrastructure honestly;
10. open exactly one PR;
11. stop and wait for Architect review.

Workers never merge or finalize governance state.

## 8. Zero implementation drift

The worker must stop rather than reinterpret the contract if implementation requires:

- new authority/state machine/ledger/cache authority;
- changed v1.0 invariant;
- changed E1.1 optimization objective;
- provider-specific domain semantics;
- weaker assurance;
- undocumented dependency/surface;
- unavailable evidence that is required for acceptance;
- a different architecture than the issued Work Order.

The Tech Lead must issue an amendment or new Work Order rather than allowing silent drift.

## 9. Right representation for the job

Evaluate, when applicable:

```text
deterministic
 → reuse/cache
 → verified competence/tool
 → programmatic execution
 → sufficient low-cost model/effort
 → stronger model
 → profitable parallel/multi-agent
 → browser/computer use
 → human escalation
```

This is a constrained optimization preference, not a blind linear pipeline.

## 10. Runtime provider rule

E2B, Daytona and Modal are neutral substrate adapters.

Their snapshots, warm pools, directory snapshots, readiness probes, scheduling and provider-native controls may inform selection, but remain provider mechanisms.

Zeck owns the selection decision; provider state does not become Zeck authority.

## 11. Exact review loop

For every PR:

```text
identity
 → base/ancestry
 → declared surfaces
 → authority boundaries
 → migration ownership
 → acceptance evidence
 → discrimination evidence
 → durable/concurrency evidence
 → provider limitations
 → exact CI
 → semantic Architect review
 → merge
```

After merge:

```text
actual merge commit
 → Work Order finalization
 → dependency/frontier recomputation
 → checkpoint finalization
 → governance check
 → handoff/continuation update
```

## 12. Evidence invariants

A claim is valid only for the exact revision tested.

No provider success may be claimed when credentials or live infrastructure were unavailable.

Lower tokens/calls/latency do not prove a better execution unless required quality/reliability/verification constraints are preserved.

## 13. Fresh-session outcome

A new Tech Lead must be able to reconstruct the entire implementation program and dispatch/review protocol from:

- this bootstrap;
- `docs/LLM-TECH-LEAD-CONTRACT.md`;
- `docs/E1.1-IMPLEMENTATION-PROGRAM.md`;
- architecture/ADRs/ACRs;
- development-state JSON;
- executable Work Orders;
- live GitHub state.

No conversation context is required.
