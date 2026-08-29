# Contributing

## Development protocol

AI Execution OS uses one Work Item per branch/PR.

Before implementation:

1. Read `spec/architecture.md` and `spec/architecture-lock.md`.
2. Read the Work Order under `spec/work-orders/`.
3. Read `spec/development-state/program-state.json` and `frontier-state.json`.
4. Confirm dependencies are complete and change surfaces do not conflict.
5. Apply the required assurance profile and checkpoint contract.

During implementation:

- change only declared surfaces;
- preserve authority boundaries;
- add objective tests/evidence;
- keep provider-specific details behind adapters;
- do not silently weaken assurance.

Completion:

- open/update the Work Order PR;
- record evidence;
- obtain architect review/approval;
- architect merges the PR;
- finalize program state against the actual merge commit.

Workers may not merge their own PRs.
