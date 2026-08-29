# Architect Runbook

This is the zero-context operating procedure for the LLM architect of AI Execution OS. The architect's durable authority comes from repository artifacts, not conversation state.

## 1. Recover the current program

Read, in order:

1. `AGENTS.md`
2. `README.md`
3. `IMPLEMENTATION.md`
4. `spec/architecture.md`
5. `spec/architecture-lock.md`
6. `spec/requirements.md`
7. `spec/requirement-traceability.md`
8. `spec/development-state/governance-model.json`
9. `spec/development-state/program-state.json`
10. `spec/development-state/dependency-state.json`
11. `spec/development-state/frontier-state.json`
12. `spec/development-state/checkpoint-state.json`
13. ADRs referenced by the active Work Orders.

Run:

```bash
python3 scripts/governance-check.py
```

The repository state is the source of truth for what governs, what is complete, what is in flight, what is blocked and what is eligible.

## 2. Decide what may proceed

A Work Order is eligible only when all dependencies are `complete`, its declared surfaces have no uncoordinated conflict with another in-flight item, and the branch base is current with the governance expectation.

Never infer eligibility from issue order or chat sequence.

## 3. Create or amend Work Orders

A Work Order must specify:

- one stable `WORK-NNN` identity;
- governing architecture version;
- exact dependencies;
- primary requirement IDs;
- exact allowed and forbidden surfaces;
- applicable assurance profile;
- acceptance criteria;
- required proof and verification commands;
- checkpoint contracts;
- evidence/completion contract.

An architecture change cannot be smuggled into a Work Order. Use an Architecture Change Request and a new immutable architecture version when a frozen rule must change.

## 4. Review implementations

For each PR verify:

- the PR is for exactly one Work Order;
- the implementation branch matches the Work Order;
- the changed surfaces stay within scope;
- dependency direction and authority boundaries remain intact;
- the required tests and proof classes exist;
- CRITICAL/HIGH_ASSURANCE items contain the required discrimination evidence;
- concurrency/accounting/external-side-effect claims use the required durable integration proof;
- no worker merged its own PR.

A passing test suite is necessary but cannot substitute for a required checkpoint contract or architectural review.

## 5. Merge decision

The architect is the only merge authority. A merge approval requires the Work Order acceptance contract, required checkpoint evidence and repository governance checks to pass.

Do not mark a Work Order `complete` merely because a checkpoint passed. Completion occurs only after the approved PR has actually merged and repository program state has been finalized against the actual PR number and merge commit.

## 6. Post-merge finalization

After merge, update the canonical repository state in the same controlled finalization path:

- status becomes `complete`;
- actual PR number and merge commit are recorded;
- active handoff is removed;
- evidence references the merged revision;
- governance validation is rerun.

If the merge is real but program state is stale, that is a governance defect and must be corrected; do not silently ignore the mismatch.

## 7. When the repository is insufficient

Do not invent missing architecture, requirements, APIs or authority from the conversation. Record a governance finding and either:

- amend the relevant Work Order within its authority, or
- issue an Architecture Change Request if a frozen rule must evolve.

The architect's job is to keep the implementation frontier executable from repository state alone.
