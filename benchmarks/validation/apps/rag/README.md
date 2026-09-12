# RAG / Knowledge-Assistant Application (VAL-011)

A customer-style knowledge-assistant application: questions answered
strictly from the provisioned synthetic knowledge bases (policies and
products) with inline chunk citations, submitted through Zeck's public
SDK boundary.

## What it does

Submits one pinned `rag.kb-qa.v1` corpus task (`kind: "kb-qa"` with the
knowledge base and question), awaits asynchronous completion through the
platform's retrieval-augmented path (deterministic retrieval recorded on
the ledger, one REAL model dispatch with the retrieved context and
citation instructions), retrieves the result package and asserts the
deterministic outcome contract: terminal `COMPLETED`, verification
`PASS`, no forbidden terminal statuses, no retryable errors.

The pinned slice includes the out-of-KB edge row (a personal-data
question): the correct behavior is an explicit not-in-KB refusal — the
platform's mechanical verification requires it (no hallucinated
personal data, no citation of unrelated chunks).

## Boundaries

- Integrates ONLY through the public SDK (the validation harness) —
  never Zeck internals; never selects provider/model/rail.
- Answers derive only from provisioned fixtures — no external browsing
  (the data boundary).
- Configuration is repository-reproducible and secret-free; the single
  secret is the environment token (`ZECK_VALIDATION_TOKEN`).

## Run

Executed by the validation integration suite
(`tests/integration/validation/val-011-rag.test.ts`).
