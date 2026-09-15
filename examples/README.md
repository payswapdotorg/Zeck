# Zeck Integration Examples

Copy/paste-runnable integration examples for **every supported workload
family** of the Zeck platform — plus the platform-surface examples
(agents, signed webhooks, economic actions, error discipline).

**The rules every example follows (machine-checkable):**

1. Connection identity comes from the environment — never flags, never
   embedded values. Required variables: `ZECK_API_URL`, `ZECK_TOKEN`,
   `ZECK_APPLICATION_ID` (optional: `ZECK_ENVIRONMENT_ID`). See
   `docs/developer/AUTH.md`.
2. `ZECK_TOKEN` is a **Zeck transport credential** — never a provider
   API key. Provider connections are BYOK references held server-side
   (`docs/developer/CONFIGURATION.md`).
3. Every create is idempotent (`Idempotency-Key`); every scoped read
   carries `X-Zeck-Application`.
4. **Zero secrets** in any file (the documentation battery scans for
   credential-shaped literals).
5. **Availability honesty**: each example declares its classification —
   `runnable` or `provider-gated` — and a provider-gated example prints
   its recorded boundary instead of silently claiming success
   (`docs/developer/AVAILABILITY.md`).

**Run any example from the repository root:**

```bash
ZECK_API_URL=http://127.0.0.1:3000 \
ZECK_TOKEN=<your-zeck-token> \
ZECK_APPLICATION_ID=<your-application-id> \
bun run examples/quickstart.ts
```

The SDK import path in-repo is `../sdk` (the frozen public contract at
`sdk/index.ts`, re-exporting `src/shared/wire.ts`). The examples
typecheck as part of `bun run typecheck`.

## The run matrix

| Example | Workload family | Classification | Gate |
|---|---|---|---|
| `quickstart.ts` | text (spine) | runnable | — |
| `text-summarization.ts` | text | runnable | — |
| `structured-invoice-extraction.ts` | structured | runnable | — |
| `rag-grounded-answers.ts` | rag | runnable | — |
| `tool-augmented-lookup.ts` | tools | runnable | — |
| `workflow-orchestration.ts` | workflow | runnable | — |
| `long-running-batch.ts` | long-running | runnable | — |
| `human-review-gate.ts` | hitl | runnable | — |
| `customer-service-triage.ts` | customer-service | runnable | — |
| `research-synthesis.ts` | research | runnable | — |
| `coding-assistant.ts` | coding | runnable | — |
| `operations-runbook.ts` | operations | runnable | — |
| `voice-transcription.ts` | voice | provider-gated | ASR rail (`QWEN_API_KEY` rails live-proven; openai 403) |
| `realtime-voice-session.ts` | realtime-voice | provider-gated | streaming rail NOT RUN (no authorized WebSocket voice-session API) |
| `image-generation.ts` | image-generation | provider-gated | generation rail (`QWEN_API_KEY` live-proven; openai 403) |
| `video-generation.ts` | video-media | provider-gated | 3 live-proven; further rows NOT RUN (free-tier quota exhausted) |
| `image-recognition.ts` | image-recognition | provider-gated | vision rail (`OPENROUTER_API_KEY` live-proven; openai 403) |
| `vlm-image-qa.ts` | vlm | provider-gated | VLM rail (`OPENROUTER_API_KEY` live-proven; openai 403) |
| `audio-understanding.ts` | audio-understanding | provider-gated | openai-only candidate region-blocked (403) — NOT RUN |
| `multimodal-transformation.ts` | multimodal | provider-gated | chained rows live-proven (openrouter + qwen rails) |
| `three-d-generation.ts` | three-d | provider-gated | NO 3D provider in the authorized set — NOT RUN |
| `browser-use-agent.ts` | browser-use | provider-gated | fixture-proven; LIVE web rail NOT RUN |
| `computer-use-agent.ts` | computer-use | provider-gated | fixture-proven; LIVE desktop rail NOT RUN |
| `agent-inventory.ts` | agents (projection) | runnable | — |
| `webhook-receiver.ts` | webhooks | runnable | `ZECK_WEBHOOK_SECRET` (out-of-band signing secret) |
| `economic-actions.ts` | economics | runnable | settlement observations need an external rail |
| `error-handling.ts` | errors/idempotency | runnable | — |

The machine-readable inventory — validated against the imported
`EXAMPLE` metadata of every file by the documentation battery — is
`docs/developer/machine/examples-manifest.json`.

## Shared helpers

- `lib/env.ts` — the environment contract loader (`ZECK_ENV_VAR_NAMES`)
  and the `runnable | provider-gated` classification vocabulary.
- `lib/poll.ts` — bounded terminal-status polling + the honest result
  printer (route/cost/usage/artifacts/verification/warnings).
- `lib/run.ts` — the entry guard: examples run when invoked directly
  (`bun run examples/<name>.ts`) and NEVER auto-execute on import.

## Verifying the examples

```bash
bun run typecheck                                   # examples typecheck
bun run test:unit -- tests/unit/developer-docs     # link + schema + end-to-end battery
```

The documentation battery runs selected example `main()` functions
end-to-end against the REAL public API server (composed in-memory) over
HTTP through the REAL SDK — the submission, lifecycle, result,
evidence and cost retrieval paths in these files are exercised, not
just compiled.
