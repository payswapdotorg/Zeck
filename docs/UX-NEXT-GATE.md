# Zeck UX Next Gate

**Status:** Design gate — not an implementation Work Order
**Depends on:** `docs/UX-EXPERIENCE-ARCHITECTURE-V2.md`
**Technical architecture:** `spec/architecture.md` v1.0

## Purpose

Define the next artifact required before authorizing further UX implementation: a screen-by-screen interaction specification derived from the v2 experience architecture.

## Required output

For each primary journey, specify:

- entry point;
- user intent;
- primary action;
- information hierarchy;
- default and advanced disclosure levels;
- loading, empty, error, permission-denied and offline/partial-data states;
- success and completion states;
- consequential-action preview;
- trust/evidence presentation;
- recovery paths;
- responsive behavior;
- keyboard/accessibility behavior;
- command-palette equivalents;
- API/domain object mapping;
- forbidden frontend authority/state.

## Journeys

1. First successful execution
2. Failed execution and recovery
3. Human/user approval
4. Agent creation
5. Deployment management
6. Batch/training workload
7. Artifact and evidence investigation
8. Competence discovery and reuse
9. Improvement recommendation review
10. Computer-use / consequential external action
11. Scheduled and long-running work
12. Spend/budget investigation
13. Policy interpretation and remediation
14. Cross-channel/realtime deployment inspection
15. Edge/embodied operational inspection

## Design test

A journey is not complete until a first-time user can understand what happened and what to do next without learning Zeck's backend architecture, while an expert can reach the underlying evidence, policy, plan and execution detail without changing semantics.

## Governance

This gate does not authorize implementation. Any subsequent implementation must be issued through the repository Work Order protocol with explicit surfaces, dependencies, acceptance criteria and evidence requirements.
