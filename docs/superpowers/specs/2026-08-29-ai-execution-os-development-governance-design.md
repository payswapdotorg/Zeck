# AI Execution OS Development Governance Design

## Goal

Make the repository the durable source of truth for this product's architecture program, implementation Work Orders, dependency frontier, assurance requirements, checkpoint evidence and architectural decisions.

## Control loop

```text
sense -> understand -> plan -> check -> execute -> verify -> review -> release -> observe -> learn
```

The loop is connective tissue across existing authorities; it is not a second workflow engine.

## Parallel implementation protocol

1. One Work Item per branch/PR.
2. A Work Item is eligible only when all dependencies are complete.
3. Each Work Item declares change surfaces.
4. Overlapping protected surfaces require explicit sequencing/coordination.
5. A worker changes only its own declared scope.
6. Work Orders and ADRs are the decision entry points.
7. A worker never merges its own PR.
8. Completion is finalized only against actual merge evidence.

## Assurance

Assurance profiles are deterministic functions of change surfaces. Unknown surfaces fail closed to `HIGH_ASSURANCE`. Profiles increase proof depth; they never reduce architectural authority or safety guarantees.

## Self-hosting

The implementation program may be executed by agentic workers, but the repository's architect remains the authority for architecture changes, required checkpoints and merge approval. The control plane is repository-resident and must be recoverable from a fresh clone without conversational memory.
