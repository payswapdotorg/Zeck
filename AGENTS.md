# AI Execution OS — LLM Agent Contract

This repository is designed for stateless LLM architect, tech-lead and implementation agents. Conversation history is not authoritative.

## Required recovery sequence

1. Read this file.
2. Read `AI_CONTINUATION.md`.
3. Read `docs/LLM-ARCHITECT-HANDOFF.md`.
4. Read `docs/LLM-TECH-LEAD-BOOTSTRAP.md` when acting as architect/tech lead or dispatching workers.
5. Read `README.md`.
6. Read `IMPLEMENTATION.md` and `spec/worker-runbook.md`.
7. Read `spec/architecture.md` and `spec/architecture-lock.md`.
8. Read `spec/development-state/program-state.json`, `dependency-state.json`, `frontier-state.json`, and `checkpoint-state.json`.
9. Read the relevant ADRs/ACRs and `spec/requirement-traceability.md`.
10. Read the assigned `spec/work-orders/WORK-NNN.md` in full.
11. Inspect live Git refs/PRs/issues and verify the active Work Order's exact branch/base relationship.
12. Run `python3 scripts/governance-check.py` before making changes.

## Architect / Tech Lead agent

The architect/tech lead is the semantic authority for architecture, Work Orders, checkpoint verdicts, architecture-change approval and merge approval. The architect may approve/reject work and authorize remediation, but must never allow a worker to bypass the repository protocol.

The architect must:

- derive the implementation frontier from repository state;
- issue/amend Work Orders rather than assigning undocumented work;
- review declared surfaces and dependency coordination;
- ensure assurance depth is appropriate;
- require evidence rather than claims;
- keep frozen architecture immutable;
- approve merges only after required checks and review evidence pass;
- finalize program state against the actual merge identity after merge;
- keep architecture evolution discoverable through approved ADR/ACR artifacts;
- schedule parallel workers only after surface/migration/shared-state conflict analysis.

For zero-context dispatch/review/merge operation, use `docs/LLM-TECH-LEAD-BOOTSTRAP.md`.

## Implementer agent

The implementer may only implement an eligible Work Order. One Work Order means one branch and one PR. The implementer must not merge its own PR, modify another Work Order's scope, weaken architecture, create a second authority, or silently lower assurance.

The implementer must report exact revisions, changed surfaces, tests, checkpoint evidence, limitations and PR identity.

## Architecture evolution

Frozen Architecture v1.0 remains authoritative.

Approved subordinate architecture evolutions currently include:

- Deployment/Runtime Architecture D1.0 via ACR-002.
- Execution Intelligence Architecture E1.0 via ACR-003 / ADR-0019.

These augment rather than rewrite v1.0. Any proposal that changes a frozen v1.0 invariant requires a new Architecture Change Request and appropriate immutable architecture version.

## Zero-context rule

When a question cannot be answered from repository artifacts, treat the repository as incomplete and raise a governance finding or request an architecture/Work Order amendment. Do not invent missing authority from chat memory.

## Current-state rule

For the current implementation frontier and exact handoff, `docs/LLM-ARCHITECT-HANDOFF.md` is the durable navigation document. `docs/LLM-TECH-LEAD-BOOTSTRAP.md` is the durable dispatch/review/merge guide. They supplement, but never override, the architecture lock, Work Orders, development-state JSON, Git ancestry, and verified CI/evidence.
