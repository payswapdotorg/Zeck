# PPR-018 — Aider Zeck-complete application proof (compat/aider)

The compatibility integration for **Aider** (pinned upstream revision
`5dc9490bb35f9729ef2c95d00a19ccd30c26339c`, https://github.com/Aider-AI/aider)
under work order `spec/post-release-work-orders/PPR-018.md` (ACR-006).

## What this is

The proof that pinned Aider — a real, unmodified external coding
assistant — can remove its direct AI-provider execution infrastructure and
operate with Zeck as its sole AI execution authority for the declared
representative corpus:

- **Aider runs 100% unmodified** at the pinned revision (installed from
  the exact commit in a dedicated Python venv). No Aider file is forked,
  patched or shimmed. The integration uses Aider's own existing
  model-abstraction seam — the LiteLLM `openai/…` + `--openai-api-base`
  transport — pointed at the Zeck adapter below.
- **The adapter** (`adapter/`) is a local OpenAI-compatible endpoint whose
  ONLY backend is the Zeck public API: every chat-completion request
  becomes a real Zeck `Execution` (created idempotently through the real
  SDK over HTTP), is executed by the Zeck-side execution plane, and the
  response content is read back from the execution's public event ledger.
- **The execution plane** (`harness/`) is the real Zeck platform code
  composed in-process (the real Fastify public API server over the real
  executions/budgets/policies modules, the same in-memory composition the
  platform's own API suites use) plus the real model gateway
  (`createModelGateway`) with a `custom`-rail adapter that supplies model
  capability through the sandbox's authorized GLM endpoint
  (`/etc/.z-ai-config` — platform-side BYOK material, never present in
  the Aider runtime).
- **The rail worker** (`harness/rail-worker.ts`) drives every created
  execution through the executions authority's own public transition
  commands (`authorize → plan (+durable planning decision) → queue →
  start (+budget reservation) → dispatch through the real model gateway →
  governed step events → verify → pass/fail`) — exactly the pattern the
  platform's own validation suites (VAL-010) and docs battery use.

## The declared execution graph

Three material AI edges are ACTIVE under the declared corpus
configuration and are delegated through Zeck (see
`graph/execution-graph.ts`):

| Edge | Aider component | Surface |
|---|---|---|
| `aider.main-completion` | `aider/coders/base_coder.py:send` → `Model.send_completion` (`aider/models.py:1036`) | text-generation |
| `aider.commit-message` | `aider/repo.py:get_commit_message` (weak model) → `simple_send_with_retries` | text-generation |
| `aider.summarizer` | `aider/history.py:summarize_all` → `simple_send_with_retries` | text-generation |

Dormant AI edges that exist at the pinned revision but are NOT reachable
under the declared corpus configuration (opt-in flags / interactive
commands the corpus never issues) are inventoried and disclosed in the
evidence record's limitations — never silently ignored: cache warming
(`base_coder.py:1373`, needs `--cache-keepalive`), voice transcription
(`aider/voice.py`, `/voice` interactive command), image chat (multimodal,
corpus is text-only), the `/editor` editor-model path and `/web` scraping.

Non-AI edges (repo map tree-sitter, local token counting, LiteLLM's local
cost-table lookups) remain Aider domain operations — outside the
Zeck-completeness criterion per PPR-018 ("Aider may retain repository,
filesystem and Git domain operations").

## The proof battery

`bun run compat/aider/harness/run-battery.ts` composes the full stack and
runs the complete PPR compatibility battery, producing the evidence
record at `deploy/evidence/ppr-018.json`:

1. edge inventory (static scan of the pinned revision, config-restricted
   to the declared corpus);
2. provider credential removal from the Aider runtime (scrubbed
   subprocess environment + recorded credential facts);
3. direct-provider egress block (deny-by-default proxy wrapping every
   Aider egress except the local Zeck adapter, plus a positive-control
   canary proving the deny works);
4. representative coding corpus (5 real coding tasks in fresh git repos,
   resolved by real pinned Aider through Zeck, verified mechanically);
5. Zeck trace correlation (every delegated edge's executions read back
   through the public SDK wire reads and recorded as trace facts);
6. duplicate/retry/failure validation (idempotent replay, Aider's own
   retry over a fault-injected rail, failed-execution accounting);
7. cost per successfully resolved outcome (Zeck-arm measured from real
   rail usage; the direct external-provider baseline is an honest NOT RUN
   boundary in this sandbox — owner: Lead);
8. customization test (Aider's own model-settings surface configuring the
   delegated models);
9. deterministic/reuse opportunity measurement (content-addressed
   idempotency keys → measured replay/reuse rate);
10. telemetry inspection (per-execution ledger events, route facts,
    usage, latency);
11. no-bypass audit (static reconciliation + runtime egress observation).

## Layout

```
compat/aider/
  adapter/     the OpenAI-compatible endpoint over the Zeck public API
  corpus/      the representative coding corpus (task data + verifier)
  demo/        Demo Mirror entry data (NOT activated — Lead binds it)
  graph/       the declared execution graph + discovered inventory
  harness/     composition, model rail, rail worker, egress proxy,
               corpus runner, trace source, battery orchestrator
  tests/       vitest suites (run by `bun run test` via vitest.config.ts)
```

## Honest boundaries

- The model supply for every delegated edge is the sandbox's GLM endpoint
  (`internal-api.z.ai`, materialized platform-side from
  `/etc/.z-ai-config`). The Aider runtime holds ZERO provider credentials
  (its `OPENAI_API_KEY` carries the literal placeholder
  `zeck-local-adapter` required by LiteLLM's client-side shape check —
  the adapter ignores it and no provider endpoint is reachable from the
  Aider process).
- Direct/optimized non-Zeck provider baselines (OpenRouter etc.) are NOT
  RUN in this sandbox (no provider credentials; owner: Lead).
- The corpus configuration disables Aider's opt-in cache-warming edge and
  never issues voice/image/editor/web commands (disclosed per-edge in the
  evidence record, never counted as covered).
