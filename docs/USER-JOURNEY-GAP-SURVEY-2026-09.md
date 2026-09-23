# Zeck User-Journey Gap Survey — 2026-09-23

The journey universe includes visitor, developer, agent builder, application owner, operations, security/compliance, human reviewer, and end-user channels. The matrix covers 50 representative end-to-end journeys spanning the documented workload and platform surfaces.

| Journey | Desired path | Primary gap | Solution families | Zeck seam |
|---|---|---|---|---|
| Discover | landing -> value -> example | architecture concepts can precede value | outcome-first landing, capability catalog | experience projection |
| First execution | auth -> sandbox -> run -> result | onboarding/setup friction | guided setup, disposable sandbox | auth/executions |
| Capability selection | task -> availability -> run | capabilities better documented than surfaced | live catalog and examples | capabilities projection |
| Safe sandbox | select -> run -> reset | setup complexity | one-click deterministic substrate | sandbox |
| Inspect execution | result -> plan -> evidence | evidence discoverability | canonical execution story | executions/evidence |
| Reproduce | export -> replay -> compare | provider/environment drift | replay bundle, environment manifest | artifacts/verification |
| Document RAG | upload -> parse -> retrieve -> cite | specialized parsing/indexing | Docling/Unstructured/PaddleOCR, pgvector/Qdrant/LanceDB | context/artifacts |
| Tool integration | connect -> authorize -> invoke -> audit | limited ecosystem | MCP, OpenAPI-derived tools | tools/connections |
| Coding agent | repo -> edit -> test -> review | live computer rail | isolated runner + browser/desktop adapter | agents/tools/sandbox |
| Browser agent | browse -> act -> evidence | live browser rail | browser-use, Playwright, Stagehand, Browserbase | computer-use |
| Desktop agent | screen -> act -> approve | no live desktop substrate | microVM/VM + VNC, managed desktops | sandbox |
| Realtime voice | mic -> turns -> interrupt -> handoff | realtime transport/media bridge | LiveKit, Pipecat, provider realtime APIs | realtime |
| Messaging agent | channel -> inbound -> response | concrete rails | Twilio/WhatsApp/Slack/Telegram/Discord/Matrix | messaging |
| Media generation | prompt -> async -> preview -> verify | provider redundancy | HF, Replicate, fal.ai, Together, direct | media |
| 3D | media -> 3D -> inspect -> export | no live route | TRELLIS.2/TripoSR/hosted GPU | media/artifacts |
| Multimodal | mixed inputs -> reasoning -> result | modality gaps | VLM/audio/realtime adapters | models/realtime |
| Long-running | submit -> disconnect -> resume | UX can hide recovery semantics | richer resume UX; optional durable runtime | execution/workflow |
| Human review | ask -> notify -> decide -> resume | notification breadth | in-app/email/Slack/Teams/SMS adapters | ask-human/webhooks |
| Evaluation | dataset -> run -> compare | external evaluator integration | Inspect AI/DeepEval/promptfoo/Ragas | verification |
| Economic action | authorize -> pay -> settle | payment provider breadth | Stripe/Paddle/Adyen/custom | economics |
| BYOK admin | register -> test -> rotate -> revoke | health/setup UX | connection wizard, secret-manager adapter | connections |
| External agent | register -> validate -> deploy | framework breadth | LiveKit Agents/LangGraph/OpenAI Agents/ADK/AutoGen | agents/deployments |
| Agent-to-agent | discover -> delegate -> stream | A2A absent | A2A protocol | agents |
| MCP tools | discover -> authorize -> invoke | MCP absent | MCP protocol/servers | tools |
| Observability | trace -> cost -> failure -> replay | rich AI trace UX | OTEL/Langfuse/Grafana/Jaeger | observability |
| Production deploy | local -> preview -> staging -> production | public product validation | deployment center/promotion ladder | deployment/release |
| Self-host | provision -> migrate -> smoke -> upgrade | packaging burden | Compose/Helm/Terraform/OpenTofu | deployment |
| Enterprise SSO | IdP -> groups -> roles | SAML/SCIM journey | OIDC/SAML, Keycloak/Zitadel/Auth0/Clerk/WorkOS | auth |
| Security admin | policy -> secrets -> isolation -> audit | fragmented controls | Security Center + secret/policy adapters | existing authorities |
| Residency | region -> route -> audit | concrete placement controls | regional runners/multi-cluster | deployment/policy |
| Provider failure | fail -> alternate -> explain | alternate live rails | multi-provider adapters/health probes | capabilities/learning/compiler |
| Incident operator | alert -> inspect -> recover | unified operator UX | OTEL/Grafana/incident integration | release/recovery |
| Compliance reviewer | filter -> export -> verify | reviewer UX | signed bundles/control maps | evidence |
| SDK consumer | install -> auth -> typed call | SDK not packaged | npm/PyPI/generated clients | distribution |
| Embedded app | widget -> theme -> events | no embeddable kit | React/Web Components/headless | experience |
| Mobile | camera/mic -> realtime -> evidence | mobile/realtime surface | LiveKit SDKs/native/React Native | realtime/experience |
| Customer support | call/chat -> agent -> human -> evidence | channel rails | LiveKit + messaging/CRM adapters | deployment channels |
| Web research | query -> source -> synthesis -> citations | source acquisition breadth | Exa/Tavily/Jina/Firecrawl/custom | tools/context |
| Document analyst | parse -> extract -> compare | parser/VLM breadth | Docling/PaddleOCR/VLM | context/models |
| Cost optimizer | inspect -> constrain -> compare | insight UX | health/cost evidence + compiler | learning/planning |
| Deterministicization | recurring AI -> evaluate -> replay -> promote | workflow UX | existing deterministic route + eval adapters | planning/verification |
| SaaS backend | API -> policy -> execution -> callback -> billing | packaging/SSO/metering | hosted control plane, OIDC, payment rails | auth/API/economics |
| Autonomy profile | policy -> autonomous run -> evidence | autonomy UX | policy templates/simulation | policy/execution |
| Human approval | action -> ticket -> decision -> resume | notifications | email/Slack/Teams/SMS | webhooks |
| Provider migration | compare -> shadow -> cutover -> rollback | migration tooling | conformance, shadow traffic, circuit breakers | deployment/learning |
| Zeck upgrade | backup -> migrate -> smoke -> promote | upgrade UX | deployment/release integrations | release |
| Provider contribution | adapter -> tests -> license -> evidence | contribution recipe | conformance template/license scan | ports/capabilities |
| Webhook consumer | event -> dedupe -> update | durable journal | DB + queue + replay | webhooks |
| Physical/embodied | authorize -> safety -> edge -> evidence | hardware rails | ROS2/Isaac/customer runners | substrate |

## Journey-level acceptance model

Every journey should expose:
1. what the user is trying to accomplish;
2. what Zeck can currently do;
3. what is provider-gated or unavailable;
4. what evidence will be produced;
5. what is deterministic versus generative;
6. how to reproduce or recover.

The UI must never hide a provider boundary by fabricating capability. External frameworks may improve the journey only through Zeck's existing public authorities.
