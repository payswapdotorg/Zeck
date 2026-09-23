# Zeck Architectural Gap Survey — 2026-09-23

Base surveyed: 338cc46c1f6081c1cbfa9de94e607982a74a159d

This survey is intentionally architecture-first. It distinguishes gaps in Zeck's core control plane from missing provider rails, protocols, substrates, product surfaces and operations. It is not a request to replace the frozen architecture.

## Gap classification and solution universe

For each gap, the solution set below covers the major viable solution classes and representative open-source/GitHub, Hugging Face and managed/closed options. "All possible" is treated as all material architectural approaches currently relevant to the gap, not every vendor in the market.

| Gap | Current gap | Open/source options | Managed/closed options | Safe Zeck integration |
|---|---|---|---|---|
| Realtime WebRTC | no live external rail | LiveKit, mediasoup, Janus | LiveKit Cloud, Daily and similar hosted SFUs | RealtimeRail + client-access port |
| Realtime media agent | no live streaming media participant | LiveKit Agents, Pipecat, custom WebRTC participant | provider realtime APIs | executor/turn-responder adapter |
| Messaging | simulated rail dominates proof | Matrix, protocol-native adapters, custom SDKs | Twilio, WhatsApp, Slack, Telegram, Discord | messaging-rail adapters |
| Browser automation | live browser rail not proven | browser-use, Playwright, Stagehand | Browserbase, Browserless | computer-use environment/tool adapter |
| Desktop automation | live desktop rail not proven | Firecracker/Kata/gVisor + VNC, OSWorld-style harnesses | managed desktop/browser environments | sandbox/computer-use adapters |
| 3D generation | no live 3D route | TRELLIS.2, TripoSR, Stable Fast 3D-class models | hosted GPU/model APIs | media rail -> artifact -> verification |
| Audio understanding | live breadth limited | faster-whisper, open audio models | OpenAI/Google/other audio APIs, HF providers | model capability adapters |
| Video generation redundancy | provider/quota breadth uneven | open video models on self-hosted GPU | HF providers, Replicate, fal.ai, Together | media adapters + provider observations |
| Model routing breadth | provider coverage incomplete | LiteLLM, open model servers | OpenRouter, Vercel AI Gateway, HF | model adapter only |
| Persistent retrieval | retrieval/storage scale can be limited | pgvector, Qdrant, LanceDB | managed vector stores | Context retrieval port |
| Document ingestion | specialized parsers limited | Docling, Unstructured, PaddleOCR, Marker | managed document AI | context/artifact derivation adapters |
| Web research | acquisition breadth limited | custom search/crawlers, MCP servers | Exa, Tavily, Jina, Serper, Firecrawl | tool adapters + evidence |
| MCP | no first-class protocol surface | official MCP SDKs/servers, self-hosted servers | MCP gateways/hosted servers | tools adapter |
| A2A | no first-class peer-agent protocol | A2A SDKs/spec implementations | managed agent endpoints | agents transport adapter |
| External agent frameworks | sparse framework adapters | LangGraph, PydanticAI, AutoGen, Google ADK, OpenAI Agents SDK, LiveKit Agents | managed agent platforms | agents adapter |
| Universal streaming | polling is stronger than generic stream UX | SSE, WebSocket, A2A streaming, LiveKit data | hosted realtime API | projection of execution events |
| Durable webhook delivery | delivery journal is incomplete | DB + queue workers, Temporal, Restate | Inngest, Trigger.dev, managed queues | webhook delivery adapter/store |
| AI observability | evidence exists, rich AI trace UX limited | OpenTelemetry, Langfuse, Grafana, Jaeger | hosted Langfuse/observability services | sink/projection only |
| External evaluators | internal verification exists | Inspect AI, DeepEval, promptfoo, Ragas | hosted eval platforms | verification adapter |
| Guardrails | third-party guardrails not broad | OPA, Cedar, Guardrails AI, NeMo Guardrails | provider moderation/guardrail APIs | policy input or verifier, never authority |
| Enterprise SSO | no first-class federation journey | Keycloak, Zitadel, OIDC libraries | Auth0, Clerk, WorkOS and IdPs | auth identity-provider adapter |
| Fine-grained auth engines | policy breadth limited | Cedar, OPA, OpenFGA, SpiceDB | managed policy/auth services | policy evaluator adapter only |
| Enterprise secret managers | env-scoped vault is main path | OpenBao, Vault, Infisical | AWS/GCP/Azure secret managers | platform secret-store adapter |
| Durable workflow alternatives | current runtime is provider-specific | Temporal, Restate | Inngest, Trigger.dev, managed durable runtimes | workflow/substrate adapter |
| Stronger isolation | container baseline | Firecracker, gVisor, Kata | managed sandbox services | sandbox/compute adapter |
| Edge/embodied | concrete hardware rails sparse | ROS2, Isaac, edge containers | industrial gateways/cloud edge | substrate adapters |
| GPU/training | accelerator breadth limited | self-hosted CUDA stacks | Modal, RunPod, cloud GPU/batch, HF Jobs/Endpoints | compute/substrate adapters |
| Media processing | transform breadth limited | FFmpeg, GStreamer, MediaMTX | managed media/transcode services, LiveKit Egress | artifact/media adapter |
| SDK distribution | repo-local SDK only | npm, PyPI, generated OpenAPI clients | package registries | distribution projection |
| Self-hosting | recipe exists, turnkey burden remains | Compose, Helm, Terraform/OpenTofu | managed Zeck hosting | deployment package |
| Payment rails | economic authority exists, provider breadth limited | custom/open payment connectors | Stripe, Paddle, Adyen, PayPal | economics payment rail |
| Regional placement | architecture models region, concrete placement sparse | Kubernetes multi-cluster, customer runners | cloud regions/edge schedulers | deployment scheduler |
| API abuse control | quotas/budgets are not edge rate-limit UX | Envoy, NGINX, Redis token bucket | Cloudflare/API gateways | transport middleware only |
| Retention/PII lifecycle | UX incomplete | DB/object lifecycle jobs | compliance/retention platforms | policy-governed lifecycle |
| Compliance mapping | evidence strong, reviewer UX limited | signed exports/control maps | GRC platforms | evidence projection |
| CLI/bootstrap | distribution remains repo-centered | standalone CLI, Homebrew, GitHub Action | managed installers | public SDK/API only |
| Embeddable UI | dashboard not an embeddable kit | React/Web Components/headless | hosted widget services | experience projection |
| Provider health | some availability is recorded-not-live | synthetic probes, circuit breakers, health workers | provider status/gateway services | capability evidence -> planning input |
| Incident workflow | ingredients exist, unified operator UX limited | OTEL/Grafana/PagerDuty-compatible flows | managed incident suites | operational projection |

## Architectural non-dependency rules

No third party may become the authority for:
- tenant/application identity;
- policy;
- capabilities;
- budget/economics;
- planning or optimization;
- execution identity/state;
- verification completion;
- artifacts/evidence;
- customer-domain state.

Protocols should be preferred to framework lock-in. Frameworks may be replaceable execution adapters.

Provider-specific facts belong in adapter provenance/evidence. Provider health, cost and latency are inputs to planning/learning, not a new routing authority.

## Most valuable sequence after the current three-worker wave

1. MCP interoperability.
2. A2A interoperability.
3. Live browser/computer-use substrate.
4. Realtime media-agent bridge.
5. 3D/audio/video redundancy.
6. Durable retrieval/document/search rails.
7. Observability/evaluation/incident UX.
8. Enterprise identity/secrets/residency/retention.
9. SDK/self-host distribution.
10. Additional workload families through the same conformance model.
