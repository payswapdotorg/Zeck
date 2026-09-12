# Image-Generation Application (VAL-015)

A customer-style text-to-image application: pinned seeded prompts
dispatched through Zeck's public SDK boundary, with mechanically
verified raster outcomes.

## What it does

Submits pinned `image-generation.from-prompt.v1` corpus tasks (`kind:
"generate-image"` with a seeded prompt fixture key and a declared
size), awaits async completion, retrieves the result package and
asserts the deterministic outcome contract. The empty-prompt edge row
asserts the honest failure contract: terminal `FAILED`, verification
`FAIL` — the platform rejects a blank prompt before any paid dispatch
and never fabricates an image.

## Boundaries

- Integrates ONLY through the public SDK (the validation harness) —
  never Zeck internals; never selects provider/model/rail.
- Configuration is repository-reproducible and secret-free; the single
  secret is the environment token (`ZECK_VALIDATION_TOKEN`).
- The platform (Zeck's operators) plans the route, dispatches the real
  image model through the dashscope-international multimodal-generation
  rail (environment-credential gated on `QWEN_API_KEY`) and records the
  mechanical verification criteria: valid raster container, declared
  dimensions, non-empty payload and sha256 digest capture. Evidence
  references carry payload DIGESTS, never image bytes.
- The seeded prompt fixtures (`img-prompt-001..003`, materialized in
  `apps/shared/media.ts`) make every dispatch reproducible at the
  request level — no external media, no free-text prompts.

## Run

The application is executed by the validation integration suite
(`tests/integration/validation/val-015-imagegen.test.ts`), which binds
the run-time configuration, the served API and the real platform
dispatch. A clean checkout reproduces the same pinned tasks, the same
fixtures and the same assertions.
