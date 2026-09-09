# Architect Runbook

This is the zero-context operating procedure for the LLM architect / tech lead of AI Execution OS. The architect's durable authority comes from repository artifacts, not conversation state.

## 0. Tech-lead bootstrap

For the complete dispatch, parallelization, review, merge and roadmap-evolution procedure, read `docs/LLM-TECH-LEAD-BOOTSTRAP.md` immediately after this runbook.

## 1. Recover the current program

Read, in order:

1. `AGENTS.md`
2. `README.md`
3. `IMPLEMENTATION.md`
4. `AI_CONTINUATION.md`
5. `docs/LLM-ARCHITECT-HANDOFF.md`
6. `docs/LLM-TECH-LEAD-BOOTSTRAP.md`
7. `spec/architecture.md`
8. `spec/architecture-lock.md`
9. `spec/requirements.md`
10. `spec/requirement-traceability.md`
11. `spec/development-state/governance-model.json`
12. `spec/development-state/program-state.json`
13. `spec/development-state/dependency-state.json`
14. `spec/development-state/frontier-state.json`
15. `spec/development-state/checkpoint-state.json`
16. ADRs/ACRs referenced by the active Work Orders.
17. Current Work Orders.

Run:

```bash
python3 scripts/governance-check.py
```

The repository state is the source of truth for what governs, what is complete, what is in flight, what is blocked and what is eligible.

## 2. Decide what may proceed

A Work Order is eligible only when all dependencies are `complete`, its declared surfaces have no uncoordinated conflict with another in-flight item, and the branch base is current with the governance expectation.

Never infer eligibility from issue order or chat sequence.

Eligibility is not automatically parallel-safe. Compare implementation surfaces, tests, migrations, public contracts, toolchain/configuration files and shared governance files before dispatching multiple workers.

## 3. Create or amend Work Orders

A Work Order must specify:

- one stable `WORK-NNN` identity;
- governing architecture version;
- exact dependencies;
- primary requirement IDs, or an explicit architecture/deployment scope where the governance model permits N/A;
- exact allowed and forbidden surfaces;
- applicable assurance profile;
- acceptance criteria;
- required proof and verification commands;
- checkpoint contracts;
- evidence/completion contract;
- migration/parallelization policy where applicable.

An architecture change cannot be smuggled into a Work Order. Use an Architecture Change Request and subordinate architecture version when a frozen rule must evolve.

## 4. Review implementations

For each PR verify:

- the PR is for exactly one Work Order;
- the implementation branch matches the Work Order;
- the changed surfaces stay within scope;
- dependency direction and authority boundaries remain intact;
- the required tests and proof classes exist;
- CRITICAL/HIGH_ASSURANCE items contain the required discrimination evidence;
- concurrency/accounting/external-side-effect claims use the required durable integration proof;
- evidence binds to the exact tested revision;
- any migration claim is unique and reconciled with all parallel/in-flight work;
- no worker merged its own PR.

A passing test suite is necessary but cannot substitute for a required checkpoint contract or architectural review.

## 5. Merge decision

The architect is the only merge authority. A merge approval requires the Work Order acceptance contract, required checkpoint evidence and repository governance checks to pass.

Do not mark a Work Order `complete` merely because a checkpoint passed. Completion occurs only after the approved PR has actually merged and repository program state has been finalized against the actual PR number and merge commit.

## 6. Post-merge finalization

After merge, update the canonical repository state in the same controlled finalization path:

- status becomes `complete`;
- actual PR number and merge commit are recorded;
- active in-flight state is removed;
- evidence references the merged revision where applicable;
- frontier is recomputed rather than manually guessed;
- governance validation is rerun.

If the merge is real but program state is stale, that is a governance defect and must be corrected; do not silently ignore the mismatch.

## 7. Architecture evolution

Current approved subordinate architecture evolutions include:

- D1.0 — Deployment/Runtime Architecture via ACR-002.
- E1.0 — Execution Intelligence Architecture via ACR-003 / ADR-0019.

E1.0 is the optimization plane for deterministic plan transformation, tool-surface/context economy, programmatic tool calling, safe parallelism, evaluation/failure attribution, continuation, competence-aware optimization and progressive deterministicization.

E1.0 does not replace Planning or any authority. If implementation would change a frozen v1.0 rule, stop and use the ACR process instead of weakening the lock.

## 8. Mission-level review lens

For every proposed feature or implementation, ask:

```text
Can this be deterministic?
Can the model call be removed?
Can the tool surface be smaller?
Can intermediate data stay outside model context?
Can independent work run in parallel?
Does multi-agent execution pay for itself?
Is the observed failure actually intelligence failure?
Can successful behavior become reusable competence?
Can competence become deterministic computation?
```

Prefer the cheapest sufficiently reliable representation, subject to policy, capabilities, budgets, sandbox/substrate and verification.

## 9. When the repository is insufficient

Do not invent missing architecture, requirements, APIs or authority from the conversation. Record a governance finding and either:

- amend the relevant Work Order within its authority, or
- issue an Architecture Change Request if a frozen rule must evolve.

The architect's job is to keep the implementation frontier executable from repository state alone.
