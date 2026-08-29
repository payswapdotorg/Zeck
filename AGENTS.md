# AI Execution OS — LLM Agent Contract

This repository is designed for stateless LLM architect and implementation agents. Conversation history is not authoritative.

## Required recovery sequence

1. Read this file.
2. Read `README.md`.
3. Read `IMPLEMENTATION.md` and `spec/worker-runbook.md`.
4. Read `spec/architecture.md` and `spec/architecture-lock.md`.
5. Read `spec/development-state/program-state.json`, `dependency-state.json`, `frontier-state.json`, and `checkpoint-state.json`.
6. Read the relevant ADRs and `spec/requirement-traceability.md`.
7. Read the assigned `spec/work-orders/WORK-NNN.md` in full.
8. Run `python3 scripts/governance-check.py` before making changes.

## Architect agent

The architect is the semantic authority for architecture, Work Orders, checkpoint verdicts, architecture-change approval and merge approval. The architect may approve/reject work and authorize remediation, but must never allow a worker to bypass the repository protocol.

The architect must:

- derive the implementation frontier from repository state;
- issue/amend Work Orders rather than assigning undocumented work;
- review declared surfaces and dependency coordination;
- ensure assurance depth is appropriate;
- require evidence rather than claims;
- keep frozen architecture immutable;
- approve merges only after required checks and review evidence pass;
- finalize program state against the actual merge identity after merge.

## Implementer agent

The implementer may only implement an eligible Work Order. One Work Order means one branch and one PR. The implementer must not merge its own PR, modify another Work Order's scope, weaken architecture, create a second authority, or silently lower assurance.

The implementer must report exact revisions, changed surfaces, tests, checkpoint evidence, limitations and PR identity.

## Zero-context rule

When a question cannot be answered from repository artifacts, treat the repository as incomplete and raise a governance finding or request an architecture/Work Order amendment. Do not invent missing authority from chat memory.
