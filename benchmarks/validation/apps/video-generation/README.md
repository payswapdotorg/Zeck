# Video-Generation Application (VAL-016)

A customer-style text-to-video application: pinned seeded storyboard
prompts dispatched through Zeck's public SDK boundary, riding the
platform's ASYNCHRONOUS generation rail end to end (submission → task
identity → bounded polling → terminal artifact → mechanical
verification).

## What it does

Submits pinned `video-media.clip-from-prompt.v1` corpus tasks (`kind:
"generate-video"` with a seeded storyboard prompt fixture key, a
bounded declared duration and a declared aspect), awaits async
completion, retrieves the result package and asserts the
deterministic outcome contract. The zero-seconds edge row asserts the
honest failure contract: terminal `FAILED`, verification `FAIL` — the
platform rejects a zero-duration task before any paid dispatch and
never fabricates a clip.

## Boundaries

- Integrates ONLY through the public SDK (the validation harness) —
  never Zeck internals; never selects provider/model/rail.
- Configuration is repository-reproducible and secret-free; the single
  secret is the environment token (`ZECK_VALIDATION_TOKEN`).
- The platform (Zeck's operators) plans the route, dispatches the real
  video model through the dashscope-international video-synthesis
  task API (`wan2.2-t2v-plus`, submitted with the async header
  `X-DashScope-Async: enable`; environment-credential gated on
  `QWEN_API_KEY`), polls the REAL task endpoint within a bounded
  wall-clock budget, fetches the terminal artifact over the REAL
  network path and records the mechanical verification criteria: MP4
  `ftyp` container validity, declared byte-size bounds and canonical
  sha256 digest capture (plus the rail-reported duration/dimension
  bounds where the rail reports them). Verification is
  container/bounds/digest ONLY — no frame-level content claims.
  Evidence references carry payload DIGESTS, never video bytes.
- The async lifecycle is a typed state machine: submitted → task-id
  issued → bounded polling → terminal (succeeded with artifact URL /
  failed with the provider-failure taxonomy) → artifact fetch. A
  generation that exceeds the declared bounded budget is an honest
  task-timeout failure — never an unbounded wait, never a fabricated
  completion.
- The seeded storyboard prompt fixtures (`vid-prompt-001..009` +
  the corpus's edge rows, materialized in `apps/video-generation/prompts.ts`
  from the VAL-003 `prompts-synthetic-video-v1` fixture set) make
  every dispatch reproducible at the request level — no external
  media, no free-text prompts.

## Run

The application is executed by the validation integration suite
(`tests/integration/validation/val-016-videogen.test.ts`), which binds
the run-time configuration, the served API and the real platform
dispatch. A clean checkout reproduces the same pinned tasks, the same
fixtures and the same assertions.
