# Text-Generation Application (VAL-010)

A customer-style document-summarization application: bounded-length
abstracts of synthetic business documents, submitted through Zeck's
public SDK boundary.

## What it does

Submits one pinned `text.summarize-doc.v1` corpus task (`kind:
"summarize"` with a document key and a word bound), awaits async
completion, retrieves the result package and asserts the deterministic
outcome contract: terminal `COMPLETED`, verification `PASS`, no
forbidden terminal statuses, no retryable errors.

## Boundaries

- Integrates ONLY through the public SDK (the validation harness) —
  never Zeck internals; never selects provider/model/rail.
- Configuration is repository-reproducible and secret-free; the single
  secret is the environment token (`ZECK_VALIDATION_TOKEN`).
- The platform (Zeck's operators) plans the route, dispatches the real
  model call and records the mechanical verification criteria.

## Run

The application is executed by the validation integration suite
(`tests/integration/validation/val-010-real-model.test.ts`), which binds
the run-time configuration, the served API and the real platform
dispatch. A clean checkout reproduces the same pinned tasks, the same
fixtures and the same assertions.
