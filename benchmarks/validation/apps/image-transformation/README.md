# Image-Transformation Application (VAL-015)

A customer-style image-editing application: a deterministic synthetic
source image plus a seeded edit instruction, dispatched through Zeck's
public SDK boundary, with mechanically verified transformation
outcomes.

## What it does

Submits pinned `image-generation.transform.v1` corpus tasks (`kind:
"transform-image"` with a synthetic source-image fixture key and a
seeded edit-instruction fixture key), awaits async completion,
retrieves the result package and asserts the deterministic outcome
contract. The corrupted-source edge row asserts the honest failure
contract: terminal `FAILED`, verification `FAIL` — the real provider
rejects genuinely undecodable media and the platform never fabricates
an edit.

## Boundaries

- Integrates ONLY through the public SDK (the validation harness) —
  never Zeck internals; never selects provider/model/rail.
- Configuration is repository-reproducible and secret-free; the single
  secret is the environment token (`ZECK_VALIDATION_TOKEN`).
- The platform (Zeck's operators) plans the route, dispatches the real
  image model through the dashscope-international multimodal-generation
  rail (environment-credential gated on `QWEN_API_KEY`) with the
  synthetic source image as a data-URI payload, and records the
  mechanical verification criteria: valid raster container, declared
  dimensions, non-empty payload, sha256 digest capture — plus the
  pixel-region change bounds derived from the deterministic synthetic
  source (a real change must be present and the changed region must
  intersect the edit fixture's declared target region — never
  aesthetic judgment). Evidence references carry payload DIGESTS,
  never image bytes.
- The deterministic source images (`img-c-001`, `scene-001`,
  `img-c-002`, `img-corrupt` — materialized in `apps/shared/media.ts`)
  and the seeded edit fixtures (`img-edit-001..004`) make every
  dispatch reproducible at the request level — no external media.

## Run

The application is executed by the validation integration suite
(`tests/integration/validation/val-015-imagegen.test.ts`), which binds
the run-time configuration, the served API and the real platform
dispatch. A clean checkout reproduces the same pinned tasks, the same
fixtures and the same assertions.
