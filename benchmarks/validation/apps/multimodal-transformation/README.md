# Multimodal-Transformation Application (VAL-018)

A customer-style cross-modal transformation application: image →
structured description → derived media, through Zeck's public SDK
boundary, with mechanically verified chained outcomes.

## What it does

Submits pinned chained-transformation tasks (`kind:
"describe-and-generate"` with a seeded chain fixture key), awaits
async completion, retrieves the result package and asserts the
deterministic outcome contract. Each chain fixture couples the
deterministic synthetic source image (VAL-003 recipes), the fixture's
own oracle terms (the vision answer's mechanical ground truth), the
closed main-object vocabulary for the structured description, and the
seeded derivation scaffold plus declared raster size for the derived
media. The corrupted-source edge row asserts the honest failure
contract: terminal `FAILED`, verification `FAIL` — the REAL vision rail
rejects the genuinely corrupted image at stage 1, the chain aborts
(stage 2 is never dispatched), and no image is ever fabricated.

## Boundaries

- Integrates ONLY through the public SDK (the validation harness) —
  never Zeck internals; never selects provider/model/rail.
- Configuration is repository-reproducible and secret-free; the single
  secret is the environment token (`ZECK_VALIDATION_TOKEN`).
- The platform (Zeck's operators) plans the route, dispatches the REAL
  chained multimodal calls — the proven OpenRouter vision rail (stage
  1, environment-credential gated on `OPENROUTER_API_KEY`) feeding the
  proven dashscope-international image-generation rail (stage 2,
  environment-credential gated on `QWEN_API_KEY`) — and records the
  mechanical verification criteria at EACH stage: the vision answer
  against the fixture's own ground-truth oracle terms and the
  structured-description contract (stage 1); the derived raster by
  container validity, declared dimensions and sha256 digest capture
  (stage 2). Per-stage provenance (request digests, output digests,
  latencies, usage) is recorded in evidence; payload DIGESTS only —
  never image bytes.
- The seeded chain fixtures (`chain-001..003`, materialized in
  `apps/shared/media.ts`) make every dispatch reproducible at the
  request level — no external media, no free-text prompts.

## Run

The application is executed by the validation integration suite
(`tests/integration/validation/val-018-multimodal-3d.test.ts`), which
binds the run-time configuration, the served API and the real platform
dispatch. A clean checkout reproduces the same pinned tasks, the same
fixtures and the same assertions.
