# ADR-0000 — Freeze AI Execution OS Architecture v1.0

**Status:** Accepted
**Date:** 2026-08-29

## Decision

Freeze `spec/architecture.md` v1.0 and its corresponding `spec/architecture-lock.md` as the governing architecture for initial implementation.

The accepted v1.0 scope is the execution-control-plane architecture described by the baseline specifications. Future evolution must be append-only through an Architecture Change Request and a new immutable architecture version when it changes a locked rule.

## Authority

The architect owns the architecture freeze and all later architecture-change approvals. Implementation workers may implement Work Orders against v1.0 but may not rewrite the frozen architecture or lock.

## Consequences

- `spec/development-state/program-state.json` may identify v1.0 as the governing architecture.
- Work Orders use v1.0 as their governing architecture until an approved successor version becomes governing.
- Implementation PRs are reviewed against the lock and applicable assurance profile.
- A fresh clone can recover the governing implementation program without conversation history.
