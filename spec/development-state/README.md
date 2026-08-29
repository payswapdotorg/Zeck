# Development State

This directory is the durable source of truth for the implementation program.

- `governance-model.json` is the architect-owned governance model.
- `program-state.json` records Work Order status and immutable merge evidence.
- `dependency-state.json` is the machine-readable dependency DAG and future frontier.
- `frontier-state.json` records what is currently eligible to implement.
- `checkpoint-state.json` records required/observed checkpoint outcomes.

A fresh implementation worker must be able to reconstruct the governing architecture, current frontier, Work Order context, applicable assurance level, and resumption state without reading chat history.
