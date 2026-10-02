# compat/hermes-agent — PPR-022: Hermes-Agent Zeck-complete application proof

The Wave 2 compatibility proof for **Hermes-Agent** (the autonomous/general
agent by Nous Research — "the self-improving AI agent") under ACR-006 +
ACR-007: the pinned unmodified runtime delegates its **complete
multi-surface AI execution graph** — the primary agent loop, every
auxiliary model path, and the specialized media tools — to Zeck through
ONE stable provider-neutral boundary, with provider credentials erased
from the certified runtime and direct-provider egress provably blocked.

## The pinned application

| | |
|---|---|
| Repository | https://github.com/NousResearch/hermes-agent |
| Revision | `77e2992020eafded09e0c344e687ae53e52e6eab` (origin/main at proof-time clone; the runtime's own report: "Hermes Agent vgit.77e2992") |
| Runtime | editable install from the exact checkout into `/home/z/my-project/.venv-hermes` (Python 3.14.7) |
| Headless surface | `hermes -z` one-shot runs (the app's own user surface) + the `tools.transcription_tools.transcribe_audio` module entry |

## The declared execution graph (7 edges)

| Edge | Surface | The pinned seam |
|---|---|---|
| `hermes.agent-loop.main` | text-generation | the primary conversation turn (`model.provider=custom` → openai SDK → POST {base}/chat/completions) |
| `hermes.auxiliary.title-generation` | text-generation | the automatic session-title call (aux task, its own provider chain — the fragmentation the target matrix flags) |
| `hermes.auxiliary.compression` | text-generation | the context-compression summarizer (its own aux client + fallback chain) |
| `hermes.auxiliary.vision-analyze` | vision-image-understanding | the `vision_analyze` tool's auxiliary vision model (image content parts) |
| `hermes.tool.tts-openai` | speech-generation | the `text_to_speech` tool's OpenAI-compatible speech backend (`/audio/speech`) |
| `hermes.tool.stt-openai` | speech-recognition | the voice-memo transcription surface (`/audio/transcriptions` — the exact function the gateway dispatches inbound voice notes through) |
| `hermes.tool.image-generate-openai` | image-generation | the `image_generate` tool's OpenAI-compatible image backend (`/images/generations`; the in-tree default is direct FAL.ai) |

Every seam above is delegated through the adapter — **there is no
second AI gateway**: the application-side surface is a translation
boundary (ACR-007 §3), the app's own configuration keys point it at the
local adapter, and Zeck owns identity/admission/capability/budget/
planning/routing/retry/verification/evidence for every dispatch.

## The proof pieces (the PPR-018A harness composition)

```
graph/execution-graph.ts     the declared graph + discovered inventory +
                             dormant-seam disclosures + non-AI classifications
adapter/server.ts            the multi-surface OpenAI-compatible endpoint whose
                             ONLY backend is the Zeck public API (chat SSE+JSON,
                             speech bytes, transcription multipart, images b64)
adapter/edges.ts             content-derived request→edge attribution (the
                             pinned runtime's own prompt markers)
harness/compose.ts           the real Zeck public API in-process + the real
                             model gateway + the multi-surface GLM rail
harness/rail-protocol.ts     the four-surface envelope protocol (validated,
                             pure, test-pinned on both sides)
harness/zai-rail.ts          the multi-surface supply-rail adapter (text,
                             vision, TTS, ASR, image generation)
harness/rail-worker.ts       the execution-plane driver (the authority's own
                             transitions; per-surface verification criteria)
harness/egress-proxy.ts      the default-deny proof proxy (provider-class
                             deny labels for the fragmented surface graph)
harness/corpus-runner.ts     the scrubbed runtime environment + the app-config
                             writer + the one-shot/media drivers
corpus/tasks.ts              the 6-task representative corpus (text, vision,
                             compression, TTS, STT, image gen) with mechanical
                             verifiers
corpus/hermes_media.py       the STT-surface driver (proof-harness glue)
harness/run-battery.ts       the certified run (resumable, checkpointed)
runtime/hermes-pinned-driver.ts  the definePinnedRuntime plug-in (the Lead
                             binds it at merge; the worker never activates
                             their own demo)
demo/demo-entry.json         the Demo Mirror entry (data only)
tests/                       7 vitest suites (run: bunx vitest run --dir compat/hermes-agent)
```

## Running

```bash
# The tests (hermetic — an injected supply transport; no live calls):
bunx vitest run --dir compat/hermes-agent

# The certified battery (live; resumable — repeat until it prints the
# derived status; every completed step checkpoints):
bun run compat/hermes-agent/harness/run-battery.ts
```

The battery requires the pinned Hermes venv (see the demo entry's
reproducibility instructions) and the sandbox's authorized GLM supply
config (platform-side BYOK material at `/etc/.z-ai-config`, never present
in the Hermes runtime).

## The certified configuration (the app's own surface, zero code changes)

`model.provider=custom` + `model.base_url=<adapter>` for the main loop;
`auxiliary.<task>.provider=main` for every auxiliary task (no
OpenRouter/Nous/Anthropic rung can fire); `tts.provider=openai` +
`tts.openai.{api_key,base_url}` (the shared audio resolution that also
serves STT); `stt.provider=openai`; `image_gen.provider=openai` +
`image_gen.openai.{base_url,key_env}`. The only credential-shaped values
in the certified runtime are the literal placeholder
`zeck-local-adapter` (the openai SDK's shape check requires a non-empty
key; the adapter ignores it, and no provider host is reachable anyway).

## Honest boundaries (recorded, never silently dropped)

- **video generation**: the tool ships no in-tree provider at the pinned
  revision (plugins only) and the declared corpus exercises no video; the
  OpenAI-compatible video plugin's async protocol translation was not
  built — an implementation gap (owner: worker), disclosed in the
  evidence record's dormant seams.
- **web search / browser / MCP / computer-use / gateway platforms**:
  dormant under the declared corpus configuration (no credentials, no
  environments, egress-denied) — inventoried with gates in the graph.
- **strong optimized external baseline**: NOT RUN (no external provider
  credentials in this sandbox; owner: Lead).

## Classification rule (the work order's binding rule, applied)

A specialized tool is not automatically an AI edge: `session_search` is
FTS5-only at this revision (classified non-AI); MCP sampling translates
into the agent's own delegated turn; local TTS/STT engines are offline
(non-provider). The specialized **cloud** media tools (TTS/STT/image
generation) ARE AI edges and are delegated — their unselected
direct-service siblings (FAL, ElevenLabs, xAI, MiniMax, Mistral, Gemini,
Edge, Exa, Firecrawl…) are inventoried as dormant, credential-gated
paths.
