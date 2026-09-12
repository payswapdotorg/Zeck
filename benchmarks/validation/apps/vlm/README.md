# VLM Application (VAL-017)

A customer-style vision-language application: description and question
answering over submitted images, through Zeck's public SDK boundary.

## What it does

Submits pinned `vlm.describe-scene.v1` corpus tasks (`kind:
"describe-image"` with a fixture key; optional focused question), awaits
async completion, retrieves the result package and asserts the
deterministic outcome contract: terminal `COMPLETED`, verification
`PASS`, no forbidden terminal statuses, no retryable errors.

## Boundaries

- Integrates ONLY through the public SDK (the validation harness) —
  never Zeck internals; never selects provider/model/rail.
- Configuration is repository-reproducible and secret-free; the single
  secret is the environment token (`ZECK_VALIDATION_TOKEN`).
- The platform (Zeck's operators) plans the route, dispatches the real
  multimodal model call (vision rail, environment-credential gated) and
  records the mechanical verification criteria; evidence references
  carry payload DIGESTS, never image bytes.

## Run

The application is executed by the validation integration suite
(`tests/integration/validation/val-017-multimodal.test.ts`), which binds
the run-time configuration, the served API and the real platform
dispatch. A clean checkout reproduces the same pinned tasks, the same
fixtures and the same assertions.
