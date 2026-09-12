# Media-Generation Jobs Application (VAL-016)

A customer-style media-generation JOB application: pinned jobs whose
ordered items are dispatched asynchronously through Zeck's public SDK
boundary — per item: submission → bounded polling → result retrieval
→ deterministic assertions — with mechanical job-level accounting.

## What it does

Submits each job item as its own public-API execution (`kind:
"generate-video"` with a seeded storyboard prompt fixture key and
bounded declared parameters), awaits asynchronous completion within
the bounded window, retrieves the result package, asserts the item's
deterministic outcome contract, and derives the job's terminal
mechanically:

- **No lost tasks** — every submitted item must reach a terminal
  status within the bounded completion window; an item that does not
  is reported as LOST and fails the job (never silently dropped,
  never an unbounded wait).
- **Honest task-failure propagation** — an item that lands FAILED
  (e.g. the zero-duration edge row, which the platform rejects before
  any paid dispatch) is recorded as a failed item and fails the job
  mechanically; a healthy sibling item still completes and is
  accounted.
- **Measured async economics** — per-item and whole-job async wall
  time, per-item poll observation counts (the poll cadence) and
  per-item result digests are measured and recorded; payload DIGESTS
  only, never payloads.

The pinned jobs (`media-job-001`, `media-job-002` in `jobs.ts`)
reference the same seeded fixture keys as the video-generation
application, so every dispatch is reproducible at the request level
(no external media, no free-text prompts).

## Boundaries

- Integrates ONLY through the public SDK (the validation harness) —
  never Zeck internals; never selects provider/model/rail.
- Configuration is repository-reproducible and secret-free; the single
  secret is the environment token (`ZECK_VALIDATION_TOKEN`).
- The platform (Zeck's operators) plans the route and drives the real
  asynchronous generation rail (dashscope-international
  video-synthesis, `wan2.2-t2v-plus`, env-credential gated on
  `QWEN_API_KEY`) per item execution, exactly as for the
  video-generation application.

## Run

The application is executed by the validation integration suite
(`tests/integration/validation/val-016-videogen.test.ts`), which binds
the run-time configuration, the served API and the real platform
dispatch. A clean checkout reproduces the same pinned jobs, the same
fixtures and the same assertions.
