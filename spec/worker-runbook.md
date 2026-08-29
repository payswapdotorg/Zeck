# Fresh Implementation Worker Runbook

This is the canonical zero-context runbook for an LLM/implementation worker.

## Before coding

1. Read `README.md`.
2. Read `IMPLEMENTATION.md`.
3. Read `spec/architecture.md` and `spec/architecture-lock.md`.
4. Read `spec/development-state/program-state.json`, `frontier-state.json` and `dependency-state.json`.
5. Read the assigned `spec/work-orders/WORK-NNN.md`.
6. Read referenced ADRs and `spec/requirement-traceability.md`.
7. Run the repository-only gate first:

```bash
python3 scripts/governance-check.py
```

Do not assume application dependencies exist during the governance/bootstrap Work Order. They become required only after the relevant toolchain Work Order adds them.

8. Confirm the Work Order is in the computed frontier. If it is not eligible, do not implement it.

## Before changing code

- Create exactly one branch for the Work Order: `work/WORK-NNN-short-name`.
- Confirm the branch base matches current `main`.
- Record any conflict with another in-flight Work Item before editing a shared surface.
- Do not change frozen architecture documents.

## While coding

- Change only declared surfaces.
- Preserve module dependency direction.
- Use public contracts, never another module's `internal` files.
- Write tests before/with implementation for acceptance criteria.
- For `HIGH_ASSURANCE` and `CRITICAL`, add an explicit discrimination test that proves a weakened
  protection is rejected.
- For concurrency/external-side-effect/accounting work, test concurrent replay and crash/retry
  convergence using real PostgreSQL where required.

## Before opening the PR

Run the applicable command set from the Work Order. At minimum:

```bash
bun install
bun run typecheck
bun run lint
bun run test:unit
bun run test:integration
python3 scripts/governance-check.py
```

Then update `docs/work-items/WORK-NNN.md` with:

- exact implementation revision
- changed files/surfaces
- requirement-to-test mapping
- command outputs/results
- discrimination/concurrency evidence
- known limitations
- PR number

The PR must use `.github/pull_request_template.md` and must not be merged by the worker.

## After architect merge

Only after the architect merges:

- record the actual merge commit and PR number in repository program state;
- update the Work Order/evidence state through the post-merge finalization path;
- rerun governance validation against the merged revision.

A checkpoint pass is not a completion event. The merge is the completion authority.
