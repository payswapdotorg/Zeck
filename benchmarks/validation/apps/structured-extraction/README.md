# Structured-Extraction Application (VAL-010)

A customer-style invoice-extraction application: unstructured invoice
documents in, governed JSON records out, submitted through Zeck's public
SDK boundary.

## What it does

Submits one pinned `structured.extract-invoice.v1` corpus task (`kind:
"extract"` with the invoice document key), awaits async completion,
retrieves the result package and asserts the deterministic outcome
contract: terminal `COMPLETED`, verification `PASS`, no forbidden
terminal statuses, no retryable errors.

The pinned slice deliberately includes one edge row (`invoice-007` —
missing total): the platform's mechanical verification requires the
extraction to flag the missing total rather than fabricate one, and the
application's outcome assertions hold only when the platform verified
exactly that.

## Boundaries

- Integrates ONLY through the public SDK (the validation harness) —
  never Zeck internals; never selects provider/model/rail.
- Configuration is repository-reproducible and secret-free; the single
  secret is the environment token (`ZECK_VALIDATION_TOKEN`).

## Run

Executed by the validation integration suite
(`tests/integration/validation/val-010-real-model.test.ts`).
