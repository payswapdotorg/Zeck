# Application Compatibility Target Matrix

Date: 2026-09-26
Purpose: starting map for the pre-authorized PPR-017..PPR-027 sequence.
Important: this is a research/starting map, not a certification result. Each target must be re-inventoried against its pinned revision.

| Application | Category | Observed starting seam | Likely material AI edges to audit | Primary challenge |
|---|---|---|---|---|
| Aider | coding assistant | centralized model/LiteLLM-style model boundary | main completion plus any auxiliary/summarization/weak-model calls actually active | remove provider execution without disturbing repo/Git domain operations |
| Cline | IDE agent | @cline/llms provider abstraction / OpenAI-compatible provider seam | primary model, plan/act, vision, edit/apply and auxiliary model paths actually active | prove terminal/browser/MCP paths do not hide direct AI-provider calls |
| OpenHands | software-engineering agent | explicit LLM abstraction/provider configuration | all model calls plus any auxiliary model clients used by the runtime | distinguish LLM delegation from OpenHands-owned workspace/agent/runtime execution |
| Continue | IDE/model platform | role-based model/provider configuration | chat, edit/apply, autocomplete, embeddings, reranking and other active roles | capability granularity must remain truthful |
| Hermes-Agent | autonomous/general agent | provider registry/shared runtime plus auxiliary call paths | primary/auxiliary LLM, image/video, TTS/STT, MCP/tool or other AI-backed paths | fragmented specialist/auxiliary providers can silently bypass the central model path |
| OpenClaw | autonomous/general agent | generic streaming/model abstraction | model execution plus web search, web fetch, media and browser/computer/agent AI surfaces actually active | broad provider/tool graph; main model path is not enough |
| Browser Use | browser agent | provider/model abstraction with OpenAI-compatible options | model/intelligence plus browser actuation and any provider-backed cloud service | prove actuation plane, not only the model plane |
| Open WebUI | general AI UI | configurable provider/base-URL paths | chat, RAG/retrieval, embeddings, image generation, STT/TTS, local/remote inference | multiple modality/provider paths and local inference |
| AnythingLLM | RAG/knowledge | provider connectors plus embedding abstraction | generation, retrieval, embeddings, transcription and local/remote model paths | certify the whole material AI graph, not only chat |

## GitHub review lessons to preserve

### OpenClaw

The codebase has a generic model/streaming abstraction, but it also contains a broad tool/service plane with provider-specific search/media integrations. The compatibility proof must therefore inventory every material AI-backed service rather than treating the model provider as the whole application execution graph.

### Hermes-Agent

The codebase centralizes many provider concerns, which makes the main model path a good integration seam. The important audit target is the existence of auxiliary/specialized model or media calls outside that central path. Any such path is a bypass until it is delegated or explicitly shown to be non-AI.

### Continue

Continue demonstrates why "LLM" is too coarse as a compatibility vocabulary. Its distinct role types can require materially different execution capabilities. Do not alter Zeck's capability truth merely to fit Continue.

### Cline

Cline already exposes an OpenAI-compatible provider seam, but also has explicit terminal, browser/computer-use and MCP tool execution. The proof must distinguish application-owned actuation from AI-provider execution and test every AI edge that can arise inside those paths.

### OpenHands

OpenHands is a strong test of the boundary between AI execution and application runtime. Zeck should own delegated intelligence/execution decisions; OpenHands can retain its workspace, terminal, repository and application runtime state.

### Browser Use

Browser automation proves whether Zeck can govern not only the intelligence that chooses an action but the execution substrate performing the action. A model-only integration is intentionally insufficient.

### Open WebUI and AnythingLLM

These applications test multi-modal and RAG/embedding execution surfaces plus local-vs-remote provider portability. Customer-local inference should be representable as a Zeck rail when the application delegates it; it is not a reason to create a permanent bypass category.

## Mandatory reinterpretation test

Compare:

declared execution graph
vs
actual runtime egress
vs
Zeck execution evidence

Any mismatch becomes a named finding.

Do not infer completeness from configuration shape, provider abstraction quality, source inspection alone, or a passing front-end journey.
