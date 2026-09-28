# PPR-019 — Cline Zeck-complete application proof (compat/cline)

The compatibility integration for **Cline** (pinned upstream revision
`252082b9e93b4f91253876391e35b4c13326f5e6`, https://github.com/cline/cline)
under work order `spec/post-release-work-orders/PPR-019.md` (ACR-006 +
ACR-007).

## What this is

The proof that pinned Cline — a real, unmodified external IDE agent — can
remove its direct AI-provider execution infrastructure and operate with
Zeck as its sole AI execution authority for the declared representative
corpus:

- **Cline runs 100% unmodified** at the pinned revision (the exact public
  clone, built with its own toolchain: `bun install` + the sdk package
  builds; the CLI runs from source via `bun apps/cli/src/index.ts`). No
  Cline file is forked, patched or shimmed. The integration uses Cline's
  own existing model seam — the `openai-compatible` provider of its
  `@cline/llms` provider abstraction (the seam the work order names) —
  pointed at the Zeck adapter below.
- **The adapter** (`adapter/`) is a local OpenAI-compatible endpoint whose
  ONLY backend is the Zeck public API (the ACR-007 Application Delegation
  Boundary): every chat-completions request — including native tool
  calls, multimodal content parts and reasoning-effort control — becomes
  a real Zeck `Execution` (created idempotently through the real SDK over
  HTTP), is executed by the Zeck-side execution plane, and the normalized
  model turn (text + tool calls + finish reason + usage) is read back
  from the execution's public event ledger and rendered in the OpenAI
  wire format (SSE or JSON) the pinned Cline runtime expects.
- **The execution plane** (`harness/`) is the real Zeck platform code
  composed in-process (the real Fastify public API server over the real
  executions/budgets/policies modules — the same in-memory composition
  the platform's own API suites use) plus the real model gateway
  (`createModelGateway`) with a `custom`-rail adapter that supplies model
  capability through the sandbox's authorized GLM endpoint
  (`/etc/.z-ai-config` — platform-side BYOK material, never present in
  the Cline runtime).
- **The rail worker** (`harness/rail-worker.ts`) drives every created
  execution through the executions authority's own public transition
  commands (`authorize → plan (+durable planning decision) → queue →
  start (+budget reservation) → dispatch through the real model gateway →
  governed step events → verify → pass/fail`), with the platform's
  policy-permitted bounded retry for retryable provider-axis failures
  (ACR-007 §1) and supply pacing.

## The rail protocol (disclosed design)

The platform's provider-neutral `ModelRequest` message shape cannot
express the OpenAI-format axes the pinned Cline runtime emits at this
seam (multimodal content parts, assistant `tool_calls` history, `tool`
role messages, the tools schema array). The ACR-007 delegation contract
carries those as the application-owned bounded context of the edge (the
task payload), and `harness/rail-protocol.ts` is the documented,
validated, unit-pinned translation between the rail worker and the
supply rail: a version-pinned request envelope, and the normalized
**structured turn** (the platform's own `NormalizedStructuredOutput`
concept) on the response side — provider-specific OpenAI shapes are
translated into neutral structures BEFORE re-entering platform code
(ACR-007 §5). Nothing about the protocol is hidden; both sides are
pinned by `tests/rail-protocol.test.ts` and `tests/zai-rail.test.ts`.

## The declared execution graph

Five material AI edges are ACTIVE under the declared corpus
configuration and delegated through Zeck (see
`graph/execution-graph.ts`):

| Edge | Cline component | Surface | Corpus task |
|---|---|---|---|
| `cline.agent-loop.act` | agent runtime (act mode) → handler-factory → openai-compatible client | text-generation | act-mode-edit (real edits via editor/apply-patch + a verification command) |
| `cline.agent-loop.plan` | agent runtime (plan mode, `--plan`) → same seam | text-generation | plan-mode (numbered plan) |
| `cline.agent-loop.vision` | agent runtime (image `@`-mentions) → same seam | vision-image-understanding | vision-qa (a real image attachment question) |
| `cline.agent-loop.reasoning` | agent runtime (`--thinking high`) → same seam | text-generation | reasoning-math (reasoning-effort control end-to-end) |
| `cline.compaction.agentic` | `extensions/context/agentic-compaction.ts` (the default CLI compaction) | text-generation | context-compaction (small context window → the summarizer fires mid-task) |

Delegated subagent/teammate loops ride the SAME handler-factory seam and
are delegated through the same adapter edge by construction (disclosed
in the evidence record's limitations; the declared corpus does not spawn
subagents). Dormant seams at the pinned revision (the VS Code host
commit-message generator and LM handler, voice transcription, the
OpenRouter image-generation transport, the web_search model tool) are
inventoried and disclosed with their configuration gates — never
silently ignored. Non-AI operations (terminal, filesystem, editor/patch
application, git, fetch_web_content) remain Cline domain capabilities
per PPR-019.

## The proof battery

`bun run compat/cline/harness/run-battery.ts` composes the full stack
and runs the complete ACR-006/ACR-007 compatibility battery, producing
the evidence record at `deploy/evidence/ppr-019.json`:

1. edge inventory (static seam scan of the pinned revision,
   config-restricted to the declared corpus) + static no-bypass
   reconciliation;
2. provider credential removal from the Cline runtime (scrubbed
   subprocess environment + recorded credential facts + the literal
   placeholder the client-side shape check requires);
3. direct-provider egress block (default-deny runtime control wrapping
   every Cline egress except the local Zeck adapter — a fetch-level
   control for the Bun/Node runtime, since HTTP_PROXY env vars are not
   honored — plus a positive-control canary proving the deny);
4. representative IDE corpus (5 tasks through the real pinned Cline CLI
   over Zeck, verified mechanically);
5. Zeck trace correlation (every delegated edge's executions read back
   through the public SDK wire reads and recorded as trace facts);
6. duplicate/retry/failure validation (idempotent replay, Cline's own
   retry over fault-injected rails, honest FAILED executions, the
   timeout path unit-pinned);
7. baselines (same-supply direct arm measured — the same pinned Cline
   calling the same GLM endpoint directly with the credential in the
   application runtime, by definition of a direct baseline; the strong
   optimized external baseline is an honest NOT RUN, owner: Lead);
8. customization test (the app's own configuration surface — provider
   settings, model id, context window, plan mode, reasoning control,
   compaction strategy — through the delegated boundary);
9. deterministic/reuse measurement (content-addressed idempotency keys
   → measured replay rate);
10. telemetry inspection (per-execution ledger events, route facts,
    usage, latency);
11. no-bypass audit (static reconciliation + runtime egress observation);
12. reproducibility (the battery IS the reproduction script; the replay
    probe demonstrates it).

## Layout

```
compat/cline/
  adapter/     the OpenAI-compatible endpoint over the Zeck public API
               (edges.ts: the request→edge attribution)
  corpus/      the representative IDE-task corpus (tasks + fixtures + verifiers)
  demo/        Demo Mirror entry data (NOT activated — the Lead binds it)
  graph/       the declared execution graph + discovered inventory +
               dormant-seam and non-AI disclosures
  harness/     composition, rail protocol, model rail, rail worker,
               egress policy + runtime preload, credential-scrubbed
               spawner, corpus runner, trace source, battery orchestrator
  tests/       vitest suites (run by `bun run test` via vitest.config.ts)
```

## Honest boundaries

- The model supply for every delegated edge is the sandbox's GLM endpoint
  (`internal-api.z.ai`, materialized platform-side from
  `/etc/.z-ai-config`). The Cline runtime holds ZERO provider credentials
  (its provider settings carry the literal placeholder
  `zeck-local-adapter` the client-side shape check requires — the adapter
  ignores it and no provider endpoint is reachable from the Cline
  process; the egress control denies every non-loopback host).
- The reasoning edge is exercised end-to-end at the request-control
  level (`--thinking` → `reasoning_effort` → the rail's thinking control
  → the supply); the served supply model accepts the control but does
  not surface reasoning content (disclosed).
- The supply endpoint's vision surface does not execute the tools axis
  (the declared vision corpus task is a final-answer task) — disclosed
  as a supply-capability boundary.
- Direct/optimized external non-Zeck provider baselines (OpenRouter etc.)
  are NOT RUN in this sandbox (no provider credentials; owner: Lead).
- **Final certification is PENDING**: PPR-018A (the reusable
  runner/certification harness) is not merged at delivery time. This
  delivery self-certifies against the PPR-017 foundation + ACR-007; the
  final evidence must be re-run and bound through the merged PPR-018A
  harness before AI_EXECUTION_COMPLETE may be claimed for the Demo
  Mirror (owner: Tech-Lead).
