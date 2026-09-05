# Zeck — Canonical Remote Declaration

**Status:** AUTHORITATIVE
**Effective:** 2026-09-05

## Canonical repository

`payswapdotorg/Zeck`

This repository is the canonical remote for Zeck product development from this point forward.

The previous repository `pectoraux/Zeck` is a historical upstream/reference only. Its issues, pull requests, branch protection, account permissions and provider connections are not authoritative for this fork.

## Source-of-truth rule

Repository-resident architecture, Work Orders, development-state, Git history and verified CI/evidence in `payswapdotorg/Zeck` govern Zeck development.

External provider dashboards, Composio state, worker conversations and the historical upstream repository may provide evidence or operational access, but cannot redefine product architecture or development state.

## Fork continuity

This repository was forked from the completed Zeck v1.0/W041 state and carries the approved Deployment & Runtime Architecture D1.0 stream.

Current implementation frontier: `WORK-042` — Reproducible deployment infrastructure foundation.

The fork's issue numbering is independent. The canonical issue for WORK-042 is the issue recorded in this repository's `spec/work-orders/WORK-042.md` and `AI_CONTINUATION.md`.

## Governance

The existing Zeck development protocol remains in force unless explicitly amended in this repository:

- one Work Order = one implementation branch = one PR;
- workers do not merge their own PRs;
- workers do not modify `spec/development-state/*` during active implementation;
- frozen core architecture v1.0 remains unchanged unless an approved architecture change says otherwise;
- deployment architecture D1.0 remains subordinate to frozen v1.0;
- repository state is the only authoritative project state.
