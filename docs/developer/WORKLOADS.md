# Workload families — the catalog and their examples

**One sentence:** Zeck's validation corpus defines **22 workload
families**; every family has a concrete, copy/paste-runnable example
under `examples/` and an honest availability classification
(`runnable` or `provider-gated` with its recorded boundary).

The family vocabulary is the corpus's own
(`benchmarks/validation/corpus/schema.ts`, `WORKLOAD_FAMILIES`) — the
same vocabulary the machine manifest carries
([machine/capability-manifest.json](machine/capability-manifest.json)).
Classification rules: [AVAILABILITY.md](AVAILABILITY.md).

## The catalog

Every family below follows the same integration shape (create → poll →
retrieve — see [EXECUTIONS.md](EXECUTIONS.md)); what differs is the
task shape and the capability requirements.

### Text
- **One sentence:** bounded-length document summarization — the
  canonical first workload (`{kind: "summarize", doc, maxWords}`).
- **Example:** `examples/text-summarization.ts` — runnable
  (live-proven over the openrouter rail).
- **Capabilities:** `model:text`.
- **Cost/latency:** seconds-scale; sub-cent per execution at typical
  constraints.
- **Common failures:** budget too tight → `BUDGET_EXCEEDED`; no rail
  in the deployment → `NO_ELIGIBLE_ROUTE`.

### Structured
- **One sentence:** typed extraction into an exact JSON shape with
  byte-exact oracles (`{kind: "extract", format, doc}`).
- **Example:** `examples/structured-invoice-extraction.ts` — runnable
  (deterministic rows proven).
- **Capabilities:** `model:text`, `algorithm:json-schema-validation`.

### RAG
- **One sentence:** grounded question answering over a knowledge base
  (`{kind: "kb-qa", kb, question}`) with source-bound verification.
- **Example:** `examples/rag-grounded-answers.ts` — runnable.
- **Capabilities:** `model:text`, `tool:document-retrieval`
  (deterministic, seeded).

### Tools
- **One sentence:** goal execution with named neutral tools
  (`{kind: "use-tool", goal, tools}`).
- **Example:** `examples/tool-augmented-lookup.ts` — runnable
  (live-proven).
- **Notes:** tool invocations surface as step events in the ledger.

### Workflow
- **One sentence:** governed multi-step orchestration as ONE execution
  (`{kind: "run-workflow", workflow, …}`).
- **Example:** `examples/workflow-orchestration.ts` — runnable.

### Long-running
- **One sentence:** checkpointed batch jobs with crash-resume
  semantics (`{kind: "long-run", job}`).
- **Example:** `examples/long-running-batch.ts` — runnable
  (checkpoint/resume proven over REAL PostgreSQL).
- **Notes:** patient polling (minutes); the poll deadline must match
  the family.

### Voice
- **One sentence:** audio transcription round trips
  (`{kind: "transcribe", clip}`).
- **Example:** `examples/voice-transcription.ts` — **provider-gated**
  (ASR legs live-proven over the qwen rail — `QWEN_API_KEY`; the
  openai candidate is region-blocked 403).

### Realtime voice
- **One sentence:** streamed turn-taking voice sessions
  (`{kind: "rt-dialog", session, turn}`).
- **Example:** `examples/realtime-voice-session.ts` — **provider-gated,
  NOT RUN rail** (no authorized WebSocket voice-session API in the
  provider set).

### Image generation
- **One sentence:** raster synthesis with explicit dimensions
  (`{kind: "generate-image", prompt, width, height}`).
- **Example:** `examples/image-generation.ts` — **provider-gated**
  (live-proven over the qwen rail, `qwen-image-2.0`).

### Video media
- **One sentence:** asynchronous short-clip generation
  (`{kind: "generate-video", prompt, seconds}`).
- **Example:** `examples/video-generation.ts` — **provider-gated**
  (3 live generations proven, ~88 s each; further rows NOT RUN —
  free-tier quota exhausted; ark/seedance DNS-failed).
- **Notes:** the honest integration pattern is a LONG poll deadline
  and artifact digest verification.

### Image recognition
- **One sentence:** image classification over a closed label set
  (`{kind: "classify-image", image, labels}`).
- **Example:** `examples/image-recognition.ts` — **provider-gated**
  (openrouter live-proven; openai region-blocked).

### VLM
- **One sentence:** open-ended image question answering
  (`{kind: "describe-image", image}`).
- **Example:** `examples/vlm-image-qa.ts` — **provider-gated**
  (openrouter live-proven; openai region-blocked).

### Audio understanding
- **One sentence:** audio event classification
  (`{kind: "classify-audio", clip, onset?}`).
- **Example:** `examples/audio-understanding.ts` — **provider-gated,
  NOT RUN** (the only authorized audio-input candidate, openai, is
  region-blocked 403).

### Multimodal
- **One sentence:** cross-modal chained transformation consuming
  document + audio (`{kind: "multimodal-summary", doc, audio}`).
- **Example:** `examples/multimodal-transformation.ts` —
  **provider-gated** (chained rows live-proven: vision over openrouter,
  derived raster over qwen; one honest FAILED row — corrupted source,
  chain-abort).

### Three-D
- **One sentence:** 3D scene rendering / mesh synthesis
  (`{kind: "render-3d", scene}`).
- **Example:** `examples/three-d-generation.ts` — **provider-gated,
  NO provider in the authorized set** (`model:three-d` candidates:
  `[]`; minimum access: one 3D-capable provider key from
  `ZECK_3D_API_KEY`).

### Customer service
- **One sentence:** governed ticket triage
  (`{kind: "cs-ticket", ticket}`) with end-user attribution.
- **Example:** `examples/customer-service-triage.ts` — runnable.

### Browser use
- **One sentence:** goal-directed browsing tasks
  (`{kind: "browser-task", site, goal}`).
- **Example:** `examples/browser-use-agent.ts` — **provider-gated for
  LIVE rails** (fixture-proven: exact-total checkouts, secret-flow
  refusal row FAILING as designed; LIVE web rail NOT RUN).

### Computer use
- **One sentence:** goal-directed workspace tasks
  (`{kind: "computer-task", workspace, goal}`).
- **Example:** `examples/computer-use-agent.ts` — **provider-gated for
  LIVE rails** (fixture-proven: exact final-tree evidence, data-boundary
  refusal FAILING as designed; LIVE desktop rail NOT RUN).

### Research
- **One sentence:** multi-source synthesis with source binding
  (`{kind: "research", topic}`).
- **Example:** `examples/research-synthesis.ts` — runnable.

### Coding
- **One sentence:** implementation of pinned function specs
  (`{kind: "implement", spec}`).
- **Example:** `examples/coding-assistant.ts` — runnable.

### Operations
- **One sentence:** governed runbook execution
  (`{kind: "run-runbook", runbook, target}`).
- **Example:** `examples/operations-runbook.ts` — runnable.

### HITL (human review)
- **One sentence:** approval-gated actions where the human decision
  lands BEFORE the action — never after (`{kind: "hitl-gate", gate,
  decision}`).
- **Example:** `examples/human-review-gate.ts` — runnable (gate
  discipline is deterministic event ordering).
- **Notes:** `WAITING_HUMAN` is a healthy status — the wait IS the
  feature; an agent can never approve on the human's behalf.

## The platform-surface examples (not workload families)

| Example | Surface |
|---|---|
| `examples/quickstart.ts` | The five-minute spine ([QUICKSTART.md](QUICKSTART.md)) |
| `examples/agent-inventory.ts` | [AGENTS.md](AGENTS.md) |
| `examples/webhook-receiver.ts` | [WEBHOOKS.md](WEBHOOKS.md) |
| `examples/economic-actions.ts` | [ECONOMICS.md](ECONOMICS.md) |
| `examples/error-handling.ts` | [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |

## Choosing constraints per family

- **Cost bounds:** text/structured/RAG-scale work: `"3000"`–`"8000"`
  micro-USD; media families: `"50000"`–`"500000"` (generation is the
  expensive step).
- **Latency bounds:** interactive families: 10–60 s; long-running:
  600 s+; video: 900 s (measured ~88 s/clip when live-proven).
- **Quality:** `minQuality` expresses your floor; the planner treats
  constraints as hard bounds.

Machine inventory (validated against every example's exported
metadata): [machine/examples-manifest.json](machine/examples-manifest.json).
Availability truth: [AVAILABILITY.md](AVAILABILITY.md) and
`docs/VALIDATION-REPORT.md`.
