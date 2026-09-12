# Transformation Application (VAL-010)

A customer-style transformation application: register rewriting (tone)
and record-set normalization between canonical shapes, submitted through
Zeck's public SDK boundary.

## What it does

Submits one pinned corpus task (`kind: "transform"` or `kind:
"transform-records"`), awaits async completion, retrieves the result
package and asserts the deterministic outcome contract: terminal
`COMPLETED`, verification `PASS`, no forbidden terminal statuses, no
retryable errors.

## Boundaries

- Integrates ONLY through the public SDK (the validation harness) —
  never Zeck internals; never selects provider/model/rail.
- Configuration is repository-reproducible and secret-free; the single
  secret is the environment token (`ZECK_VALIDATION_TOKEN`).

## Run

Executed by the validation integration suite
(`tests/integration/validation/val-010-real-model.test.ts`).
