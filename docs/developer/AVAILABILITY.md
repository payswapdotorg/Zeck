# Availability disclosure — the honest provider-boundary rules

**One sentence:** every workload family and example in this kit is
classified `runnable` or `provider-gated` against the RECORDED
availability facts of the authorized provider set — and a NOT RUN
boundary is never converted into a pass.

## The classification vocabulary

| Classification | Meaning |
|---|---|
| `runnable` | The example's full code path (submit → lifecycle → result/evidence/cost retrieval) runs against any Zeck deployment exposing the public API, and the workload family is exercised by the executed validation program (its task shapes are proven). |
| `provider-gated` | The code path is identical, but the workload's **COMPLETION** requires provider capabilities whose access is gated (credential, region, quota) or absent from the authorized set. The example prints its recorded boundary; it never silently claims success. |

A `provider-gated` example still demonstrates the correct INTEGRATION
(the wire contract is the same for every family) — the gate is about
what the deployment's rails can complete, not about your code.

## The disclosure rules (binding on this kit)

1. **Names, never values**: provider credentials appear only as env
   var NAMES (`OPENROUTER_API_KEY`, `QWEN_API_KEY`, …). No value, no
   example, no artifact.
2. **Recorded facts, not assumptions**: availability statements mirror
   `docs/VALIDATION-REPORT.md` (the executed validation program's
   evidence) and the capability matrix
   (`benchmarks/validation/capabilities/matrix.ts`).
3. **A gap is a gap**: a NOT RUN boundary (no rail, region block, DNS
   failure, quota exhaustion) is recorded as NOT RUN with its exact
   reason — never as a pass, never silently omitted.
4. **Designed failures are disclosed as designed**: fixture rows that
   FAIL as designed (secret-flow refusal, data-boundary refusal) are
   evidence of working protections, not availability gaps.
5. **The machine layer carries the same truth**:
   [machine/capability-manifest.json](machine/capability-manifest.json)
   (families + provider access) and
   [machine/examples-manifest.json](machine/examples-manifest.json)
   (per-example classification) are validated against the examples'
   own exported metadata by the battery — drift is a test failure.
6. **Re-verification is an operator action**: recorded availability
   changes only through a re-probe/re-run with credentials the
   operator authorizes (the validation program's own discipline).

## The recorded provider availability (as of the executed program)

| Provider | Credential (NAME) | Recorded availability |
|---|---|---|
| openrouter | `OPENROUTER_API_KEY` | live-proven — text/tool-agent/agentic (meta-llama/llama-3.3-70b-instruct) |
| qwen (dashscope-international) | `QWEN_API_KEY` | live-proven — ASR/TTS (qwen3-asr-flash/qwen3-tts-flash), raster (qwen-image-2.0), video (wan2.2-t2v-plus: 3 live generations; further rows quota-blocked) |
| openai | `OPENAI_API_KEY` | NOT RUN — HTTP 403 region block (`unsupported_country_region_territory`) from the recorded egress |
| byteplus-ark | `BYTEPLUS_ARK_API_KEY` | NOT RUN — DNS failure (ark.ap-southeast-1.bytepluses.com does not resolve) |
| seedance | `SEEDANCE_API_KEY` | NOT RUN — same DNS boundary |
| (3D generation) | `ZECK_3D_API_KEY` (minimum access requirement) | NOT RUN — no 3D-generation-capable provider in the authorized set |

Live web browser rails and live desktop computer-use rails: NOT RUN
(no operator-authorized rail at run time); those families' validation
rows ran against controlled in-memory fixtures.

## Per-family boundaries (summary)

The full per-family table with task shapes, capability requirements
and boundaries: [machine/capability-manifest.json](machine/capability-manifest.json).
Narrative catalog: [WORKLOADS.md](WORKLOADS.md). Run matrix:
`examples/README.md`.

Highlights of the hard boundaries:

- **realtime-voice**: streaming rail NOT RUN (no authorized WebSocket
  voice-session API; `QWEN_API_KEY` covers ASR/TTS legs only).
- **audio-understanding**: NOT RUN (openai-only candidate, region
  blocked).
- **three-d**: NOT RUN (no candidate provider at all —
  `model:three-d` candidates: `[]`).
- **video-media**: 3 live generations proven; further live rows NOT
  RUN (free-tier quota exhausted — an operator tier action, recorded
  as `AllocationQuota.FreeTierOnly`).
- **browser-use / computer-use**: fixture-proven; LIVE rails NOT RUN.

## Where the truth lives (source links)

- The executed validation report (the authoritative availability
  evidence): `docs/VALIDATION-REPORT.md` — its "NOT RUN boundaries"
  and "Providers actually exercised" sections are the recorded facts.
- The capability matrix and probe contract:
  `benchmarks/validation/capabilities/matrix.ts`,
  `benchmarks/validation/capabilities/probe.ts`.
- The workload family vocabulary:
  `benchmarks/validation/corpus/schema.ts`.

## What this means for you

- Choosing a workload family? Check its classification first
  ([WORKLOADS.md](WORKLOADS.md)).
- Hitting `NO_ELIGIBLE_ROUTE` on a gated family? That is the honest
  signal of a rail gap — no request shape will change it
  ([TROUBLESHOOTING.md](TROUBLESHOOTING.md)).
- Operating a deployment? Your provider allowlist determines which
  families complete in YOUR environment
  ([CONFIGURATION.md](CONFIGURATION.md), [PRODUCTION.md](PRODUCTION.md)).
- The credentialed re-runs of provider-gated examples are owned by the
  platform operator (the Lead in the delivery program) — this kit
  marks them honestly rather than claiming them runnable.
