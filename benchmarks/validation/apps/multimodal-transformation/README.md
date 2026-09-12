# Multimodal-Transformation Application (VAL-018)

A customer-style cross-modal transformation application: a synthetic
source image plus a seeded structured-description instruction,
chained by the platform into a mechanically verified derived image
(image -> structured description -> derived media).

## What it does

Submits pinned multimodal-transformation corpus tasks (`kind:
"transform-multimodal"` with a synthetic source-image fixture key and
a seeded instruction fixture key), awaits async completion, retrieves
the result package and asserts the deterministic outcome contract.
The platform-side chain (`chain.ts`, driven by the validation
integration suite) rides the EXISTING proven rails end to end:

1. **vision stage** — the source image + the instruction dispatched
   through the existing multimodal dispatch binding (the OpenRouter
   vision rail; env-credential gated on `OPENROUTER_API_KEY`) as a
   `describe-image` task whose question is the instruction;
2. **structured-description stage** — the vision answer derived into
   the structured JSON description (the pure
   `deriveStructuredDescription` from the three-d platform slice),
   mechanically verified against the source fixture's own ground
   truth before the next stage consumes it;
3. **derived-media stage** — the structured description rendered into
   a deterministic derived prompt and dispatched through the existing
   dashscope multimodal-generation rail (qwen-image-2.0, text-to-image;
   env-credential gated on `QWEN_API_KEY`), verified by raster
   container validity, declared dimensions, payload presence and sha256
   digest capture.

Every stage's output is verified before the next stage consumes it; a
stage failure aborts the chain with the exact stage recorded
(chain-abort propagation). Per-stage provenance (request digest,
response digest, measured latency, measured usage) travels into
evidence; payload DIGESTS only, never payloads.

The corrupted-source edge row asserts the honest failure contract:
terminal `FAILED` — the REAL vision provider rejects genuinely
undecodable media, the chain aborts at the vision stage. The
wrong-modality row (an imagegen task submitted to this application)
asserts the honest pre-dispatch rejection: terminal `FAILED`, zero
network effects.

## Boundaries

- Integrates ONLY through the public SDK (the validation harness) —
  never Zeck internals; never selects provider/model/rail.
- Configuration is repository-reproducible and secret-free; the single
  secret is the environment token (`ZECK_VALIDATION_TOKEN`).
- The deterministic source images (`img-c-001`, `scene-001`,
  `scene-004`, `img-corrupt` — materialized in `apps/shared/media.ts`)
  and the seeded instruction fixtures (`mm-instruction-001..002`, in
  this app's `fixtures.ts`) make every dispatch reproducible at the
  request level — no external media.

## Run

The application is executed by the validation integration suite
(`tests/integration/validation/val-018-3d-transform.test.ts`), which
binds the run-time configuration, the served API and the real platform
chain dispatch (per-stage env-credential gated). A clean checkout
reproduces the same pinned tasks, the same fixtures and the same
assertions.
