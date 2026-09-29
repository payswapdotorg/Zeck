# PPR-020 — OpenHands Zeck-complete application proof (compat/openhands)

The compatibility integration for **OpenHands** (pinned agent revision
`fcc102a697874d54a357e36004e02c95040dbdc0` — software-agent-sdk tag
v1.49.6, https://github.com/OpenHands/software-agent-sdk) under work
order `spec/post-release-work-orders/PPR-020.md` (ACR-006 + ACR-007).

## The upstream provenance (a structural finding, disclosed honestly)

The work-order-named upstream repository
https://github.com/All-Hands-AI/OpenHands at its pinned revision
`7dc6805406ea3c76cb4a3ce407c3c72d481b0ac6` (tag v1.24.0) is **OpenHands
Agent Canvas** — the self-hosted control center for coding agents. At
that revision the repository no longer contains the Python agent: the
OpenHands agent (the litellm-based completion layer, the agent loop, the
condenser, the skills system and the agent tools) lives in
https://github.com/OpenHands/software-agent-sdk, released as the
`openhands-agent-server` / `openhands-sdk` / `openhands-tools` packages.
Agent Canvas v1.24.0's own `config/defaults.json` pins agentServer
**1.49.6** — the out-of-the-box OpenHands agent the distribution runs.

The application under proof for the declared coding-agent corpus is
therefore the OpenHands agent at the exact distribution-pinned revision
(`fcc102a…`, tag v1.49.6), installed **verbatim** (editable, from the
tagged checkout) in a dedicated venv. Both pins are recorded in the
evidence record's `upstreamProvenance`.

## What this is

The proof that pinned OpenHands — a real, unmodified external
software-engineering agent — can remove its direct AI-provider execution
infrastructure and operate with Zeck as its sole AI execution authority
for the declared representative corpus:

- **OpenHands runs 100% unmodified** at the pinned revision (the exact
  public tag, installed editable into a dedicated venv). No OpenHands
  file is forked, patched or shimmed. The integration uses OpenHands's
  own existing model seam — the `openhands.sdk.llm.LLM` litellm
  abstraction (`api_mode="chat"`, `openai/` provider, custom `base_url`)
  — pointed at the Zeck adapter below.
- **The adapter** (`adapter/`) is a local OpenAI-compatible endpoint
  whose ONLY backend is the Zeck public API (the ACR-007 Application
  Delegation Boundary): every chat-completions request — including
  native tool calls, multimodal content parts and the condenser/oracle/
  sub-agent calls — becomes a real Zeck `Execution` (created
  idempotently through the real SDK over HTTP), is executed by the
  Zeck-side execution plane, and the normalized model turn (text + tool
  calls + finish reason + usage) is read back from the execution's
  public event ledger and rendered in the OpenAI wire format the pinned
  OpenHands litellm layer expects.
- **The execution plane** (`harness/`) is the real Zeck platform code
  composed in-process (the real Fastify public API server over the real
  executions/budgets/policies modules — the same in-memory composition
  the platform's own API suites use) plus the real model gateway
  (`createModelGateway`) with a `custom`-rail adapter that supplies
  model capability through the sandbox's authorized GLM endpoint
  (`/etc/.z-ai-config` — platform-side BYOK material, never present in
  the OpenHands runtime).
- **The rail worker** (`harness/rail-worker.ts`) drives every created
  execution through the executions authority's own public transition
  commands (`authorize → plan (+durable planning decision) → queue →
  start (+budget reservation) → dispatch through the real model gateway
  → governed step events → verify → pass/fail`), with the platform's
  policy-permitted bounded retry for retryable provider-axis failures
  (ACR-007 §1) and supply pacing.

## The rail protocol (disclosed design)

The platform's provider-neutral `ModelRequest` message shape cannot
express the OpenAI-format axes the pinned OpenHands runtime emits at
this seam (multimodal content parts, assistant `tool_calls` history,
`tool` role messages, the tools schema array). The ACR-007 delegation
contract carries those as the application-owned bounded context of the
edge (the task payload), and `harness/rail-protocol.ts` is the
documented, validated, unit-pinned translation between the rail worker
and the supply rail: a version-pinned request envelope, and the
normalized **structured turn** (the platform's own
`NormalizedStructuredOutput` concept) on the response side —
provider-specific OpenAI shapes are translated into neutral structures
BEFORE re-entering platform code (ACR-007 §5). Both sides are pinned by
`tests/rail-protocol.test.ts` and `tests/zai-rail.test.ts`.

## The declared execution graph

Five material AI edges are ACTIVE under the declared corpus
configuration and delegated through Zeck (see
`graph/execution-graph.ts`):

| Edge | OpenHands component | Surface | Corpus task |
|---|---|---|---|
| `openhands.agent-loop.main` | Agent._step → LLM.completion → litellm (agent/agent.py:728 / llm/llm.py:1648,2427) | text-generation | implement-edit (a real edit + a verification command via the terminal tool) |
| `openhands.agent-loop.vision` | the same seam carrying ImageContent attachments | vision-image-understanding | vision-qa (a real image attachment question) |
| `openhands.condenser.llm-summarize` | LLMSummarizingCondenser._generate_condensation (its own llm field, :229) | text-generation | context-compaction (max_size=10 → the summarizer fires mid-task) |
| `openhands.subagent.task-loop` | TaskToolSet → TaskManager (parent-LLM copy → a full sub-agent loop) | text-generation | delegate-explore (the seeded `explorer` sub-agent definition) |
| `openhands.tool.ask-oracle` | AskOracleExecutor (the saved `oracle` LLM profile, :98) | text-generation | oracle-consult (a mandatory oracle consult) |

Dormant seams at the pinned revision are inventoried and disclosed with
their configuration gates (never silently ignored): the browser-use
tool set (requires a browser environment; constructs NO separate LLM at
this revision — an inventory finding), the external `tom_swe` consult
(a second AI client path configured solely through tool params), the
API-based critic (an external vLLM /classify HTTP service with its own
credentials), the ToolShield/GraySwan security analyzers, the
Laminar/OTEL observability exporter (env-gated), prompt/agent hooks,
the classify-and-switch/switch-LLM builtins, the vision-inspect builtin,
the goal judge and ask-agent seams, the agent-server's auto-title /
profile-validation conveniences (server-mode only — the corpus runs the
in-process SDK), and the LLM fallback profiles. Non-AI operations
(terminal, file_editor, git, the deterministic keyword/path skill
triggers — no LLM, no embeddings at this revision, tree-sitter, local
token counting) remain OpenHands domain capabilities per PPR-020.

## Upstream behavior the proof run surfaced (disclosed)

**The GLM force-string-serializer quirk (vision edge).** At the pinned
revision the SDK's model-features fallback
(`openhands/sdk/llm/utils/model_features.py:
FORCE_STRING_SERIALIZER_MODELS`) force-string-serializes every model id
containing the substring `"glm"` — which `openai/glm-4-plus` matches.
The string serializer joins only `TextContent` items, so `ImageContent`
attachments were silently DROPPED from the wire: the agent's vision
turn reached the supply as plain text and the model truthfully
answered that it saw no image. The first live vision run exposed it.
The remedy is the application's own public configuration axis — the
`LLM(force_string_serializer=False, capability_overrides=
{"supports_vision": True})` constructor fields (which take precedence
over the auto-detection) restore the list serializer, so image parts
reach the wire and the delegated vision surface. No OpenHands file is
forked or patched; the behavior and its remedy are recorded here and
in the evidence record's runtime evidence. The supply's vision surface
also ignores the tools axis (vision turns carry no tools schema — a
disclosed supply limitation), so the vision corpus task is an
answer-directly-from-the-attachment question by design.

## The proof battery

`bun run compat/openhands/harness/run-battery.ts` composes the full
stack and runs the complete ACR-006/ACR-007 compatibility battery,
producing the evidence record at `deploy/evidence/ppr-020.json`:

1. edge inventory (static seam scan of the pinned revision,
   config-restricted to the declared corpus) + static no-bypass
   reconciliation;
2. provider credential removal from the OpenHands runtime
   (allowlist-scrubbed subprocess environment + recorded credential
   facts + the literal placeholder the litellm client's shape check
   requires);
3. direct-provider egress block (default-deny proof proxy wrapping
   every OpenHands egress except the loopback Zeck adapter + a
   positive-control canary proving the deny);
4. representative coding-agent corpus (5 tasks through the real pinned
   OpenHands agent SDK over Zeck, verified mechanically);
5. Zeck trace correlation (every delegated edge's executions read back
   through the public SDK wire reads and recorded as trace facts);
6. duplicate/retry/failure validation (idempotent replay, the runtime's
   own retry over fault-injected rails, honest FAILED executions, the
   timeout path unit-pinned);
7. baselines (the same-supply direct arm measured — the same pinned
   runtime calling the same GLM endpoint directly with the credential
   in the application runtime, by definition of a direct baseline; the
   strong optimized external baseline is an honest NOT RUN, owner:
   Lead);
8. customization test (the app's own configuration surface — tool
   selection, terminal backend, condenser config, the seeded sub-agent
   definition, the seeded oracle profile, iteration limits, vision
   capability declaration — through the delegated boundary);
9. deterministic/reuse measurement (content-addressed idempotency keys
   → measured replay rate);
10. telemetry inspection (per-execution ledger events, route facts,
    usage, latency);
11. no-bypass audit (static reconciliation + runtime egress
    observation);
12. reproducibility (the battery IS the reproduction script; the replay
    probe demonstrates it).

## Layout

```
compat/openhands/
  adapter/     the OpenAI-compatible endpoint over the Zeck public API
               (edges.ts: the request→edge attribution)
  corpus/      the representative coding-agent corpus (tasks.ts +
               fixtures + verifiers; openhands_task.py: the pinned
               driver that configures the SDK's own public surface)
  demo/        Demo Mirror entry data (NOT activated — the Lead binds it)
  graph/       the declared execution graph + discovered inventory +
               dormant-seam and non-AI disclosures
  harness/     composition, rail protocol, model rail, rail worker,
               egress proxy, credential-scrubbed corpus runner, trace
               source, battery orchestrator
  runtime/     the pinned-runtime driver (definePinnedRuntime) shipped
               for the Lead's merge-time Demo Mirror binding
  tests/       vitest suites (bunx vitest run --dir compat/openhands)
```

## Honest boundaries

- The model supply for every delegated edge is the sandbox's GLM
  endpoint (`internal-api.z.ai`, materialized platform-side from
  `/etc/.z-ai-config`). The OpenHands runtime holds ZERO provider
  credentials (its LLM config carries the literal placeholder
  `zeck-local-adapter` the litellm client's shape check requires — the
  adapter ignores it and no provider endpoint is reachable from the
  OpenHands process; every non-loopback egress is denied by the proof
  proxy).
- The sandbox provides no tmux server (the terminal tool runs on its
  own subprocess backend — the tool's public configuration axis) and no
  browser environment (the browser-use tool set stays a disclosed
  dormant seam).
- Direct/optimized external non-Zeck provider baselines (OpenRouter
  etc.) are NOT RUN in this sandbox (no provider credentials; owner:
  Lead).
- Final certification is the Lead's merge-time act. This delivery
  self-assesses through the merged PPR-018A harness pieces; the worker
  never activates their own demo.
