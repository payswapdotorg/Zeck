# Requirements

## API and developer experience

- API-001: A developer can create an execution with a task and input without selecting a provider.
- API-002: SDKs expose a stable execution-oriented abstraction.
- API-003: Every mutating execution request supports idempotency.
- API-004: Execution lifecycle events are available through webhooks.
- API-005: Developers can inspect execution receipts, provenance, cost and quality.

## Connections and provider federation

- CON-001: Providers are represented through provider-independent connection contracts.
- CON-002: BYOK is first-class.
- CON-003: OpenRouter can be configured as an upstream routing/provider rail.
- CON-004: Direct provider adapters can coexist with aggregation rails.
- CON-005: Provider failure and task-quality failure are distinct error classes.

## Policy, budgets and economics

- BUD-001: Applications can impose per-execution and monthly budgets.
- BUD-002: Users can impose their own spending limits where the application permits it.
- BUD-003: Developer, user, BYOK, hybrid and subsidized funding modes are supported by policy.
- BUD-004: Budget reservations are concurrency-safe and idempotent.
- BUD-005: Actual usage is settled into an append-only ledger.

- POL-001: Effective policy is resolved across platform/application/user/task/execution scope.
- POL-002: Policies can restrict models, tools, networks, secrets, autonomy and isolation.
- POL-003: A lower-level policy cannot weaken a higher-level prohibition.

## Execution intelligence

- INT-001: The system derives a structured task profile before planning.
- INT-002: Capability requirements are resolved before provider/model selection.
- INT-003: Execution plans can combine models, tools, algorithms, agents and humans.
- INT-004: Cheap-first/cascade execution is available when compatible with the task.
- INT-005: The planner can escalate when verification or quality thresholds are unmet.
- INT-006: Historical performance influences future plans without fabricating evidence.

## Context and tools

- CTX-001: Raw application context can be transformed into task-specific context artifacts.
- CTX-002: Context artifacts preserve source/provenance lineage.
- TOL-001: Tool invocation is policy-gated and recorded.
- TOL-002: Tool results are available as evidence to downstream execution steps.
- TOL-003: The system records which tools improve outcomes for which task classes.
- TOL-004: The architecture admits future tool synthesis without changing the execution abstraction.

## Agents and environments

- AGT-001: Agents are distinct from LLM/model providers.
- AGT-002: Agent sessions and workspaces are bound to execution identity.
- AGT-003: Every governed agent has a stable identity, ownership metadata and a discoverable inventory/catalog record.
- AGT-004: Agent definitions and runtime configurations are immutable versioned artifacts with validation and rollback metadata.
- AGT-005: Agent model/tool/endpoint access uses scoped, revocable, policy-mediated credentials and never requires long-lived raw secrets in agent code.
- AGT-006: Policy-designated risky agent actions can require explicit human approval before execution.
- AGT-007: Agents built with external frameworks or runtimes can be registered and governed through provider-neutral adapters without changing the Execution abstraction.
- AGT-008: Governed agent sessions record significant inputs, actions, tool calls, outputs and authorization context as execution evidence.
- ENV-001: Execution environments are selected through a provider-independent abstraction.
- ENV-002: Untrusted/general-purpose code can run in isolated containers in v1.0.
- ENV-003: The architecture has an explicit evolution path for microVM/VM execution.

## Verification and learning

- VER-001: Verification is distinct from provider success.
- VER-002: Verification evidence is attached to the execution.
- VER-003: Human/user escalation can be represented as an execution step.
- VER-004: Candidate comparison can be requested only when policy/planner conditions justify it.
- LRN-001: Outcomes are recorded for model, tool, context, plan, verifier and environment learning.
- LRN-002: Learning never bypasses policy or customer-domain authority.

## WorkflowOS integration

- WOS-001: WorkflowOS can submit implementation/review work to AI Execution OS through one provider-independent execution contract.
- WOS-002: WorkflowOS remains authoritative for its own workflow state transitions.
- WOS-003: AI Execution OS returns execution results, artifacts and evidence; it does not directly transition WorkflowOS workflow state.
- WOS-004: Existing WorkflowOS execution/session/workspace concepts can map to the platform execution substrate without creating duplicate authorities.

## Deterministicization and evaluation

- DTR-001: The system can identify recurring AI execution subgraphs that are candidates for deterministic replacement.
- DTR-002: Deterministicization candidates can be validated through replay, differential evaluation and property/metamorphic testing before promotion.
- DTR-003: Deterministic replacements can be progressively shadowed/canary-tested and rolled back without changing execution identity.
- DTR-004: The system records evidence, confidence and rationale for deterministicization decisions.
- DTR-005: Developers can submit selected codebase functions, traces or execution subgraphs for advisory analysis of AI/deterministic/hybrid opportunities.

## Human evaluation

- HUM-001: The planner can request selective human ratings when automated evaluation leaves material decision uncertainty and the expected information value justifies user effort.
- HUM-002: Human ratings are immutable evidence tied to the execution, candidates and evaluation question.
- HUM-003: Low-confidence human-rated findings cannot be promoted automatically as authoritative production behavior without satisfying the normal validation/promotion gate.

## Agent control plane

- ACP-001: Zeck maintains a stable governed identity and inventory/catalog record for every registered agent.
- ACP-002: Agent definitions/runtime configurations are versioned immutable artifacts with validation and rollback metadata.
- ACP-003: Agent access to models, tools, endpoints and secrets is mediated by scoped, revocable credentials and policy; long-lived raw secrets are not embedded in agent code.
- ACP-004: Policy can require human approval before designated high-risk agent actions.
- ACP-005: External/BYOA agent frameworks can be registered and governed through provider-neutral adapters without creating duplicate execution or policy authorities.
- ACP-006: Agent session actions are recorded as execution evidence with sufficient provenance to reconstruct who/what/when/why.

## Multimodal deployment

- MOD-001: Agents can be deployed through a provider-neutral versioned DeploymentProfile and DeploymentPlan without changing the Execution abstraction.
- MOD-002: Deployment identity is bound to application/environment/agent version and can be referenced by executions.
- MOD-003: Deployment lifecycle changes are idempotent, auditable, concurrency-safe where mutable, and preserve execution provenance.
- MOD-004: Channel/modality adapters cannot create duplicate policy, capability, budget, execution, verification or tenant authorities.
- MOD-005: The platform can deploy realtime voice agents through provider-neutral web/telephony/realtime adapters.
- MOD-006: Realtime sessions preserve tenant/deployment/execution identity, interruption/turn provenance and governed escalation.
- MOD-007: Voice/realtime deployment can use deterministic and hybrid subtasks rather than forcing every turn through generative inference.
- MOD-008: The platform can deploy conversational agents to messaging channels through provider-neutral adapters with idempotent event handling.
- MOD-009: Messaging deployments preserve conversation/message provenance, tenant isolation and policy-before-send ordering.
- MOD-010: Deployment profiles support external/BYOA agents and replaceable upstream channel/infrastructure rails without vendor lock-in.
- MOD-011: The platform can deploy video/image/audio generation workloads through provider-neutral media capabilities and asynchronous execution.
- MOD-012: Generated media and derived variants preserve artifact lineage, execution provenance and deployment version.
- MOD-013: Media-generation jobs enforce budget-before-paid-dispatch, idempotent submission, retry/cancel semantics and verification-before-completion.

## Computational substrate extensibility

- CSX-001: Zeck exposes a provider-neutral computational substrate contract covering capability, modality, latency, resource, isolation and side-effect metadata.
- CSX-002: Zeck represents interactive, realtime, asynchronous, batch, training/evaluation, edge, embodied and specialized-accelerator workloads as Execution-compatible workload classes.
- CSX-003: Substrate selection occurs only after policy, capability and applicable resource/budget admission, with deterministic-first planning applied before provider/substrate selection.
- CSX-004: New computational substrates can be added through replaceable adapters without creating duplicate execution, policy, capability, budget or verification authorities.

## Computer use

- CUI-001: Zeck provides provider-neutral browser, desktop and terminal computer-use capabilities.
- CUI-002: Computer-use sessions isolate network, filesystem, credential and side-effect access and preserve execution provenance.
- CUI-003: When a deterministic/API capability can satisfy a computer-use subtask, the planner can prefer it over GUI/model interaction.

## Long-running execution

- LNG-001: Long-running executions can checkpoint and resume without changing execution identity.
- LNG-002: Lease, heartbeat, interruption and wake-up semantics prevent stale workers from becoming authoritative.
- LNG-003: Resume/recovery re-enters applicable policy, capability, budget and provenance controls and prevents duplicate side effects.

## Edge and embodied execution

- EDGE-001: Edge and embodied targets are represented through provider-neutral execution/deployment contracts.
- EDGE-002: Zeck can govern latency-sensitive or physical workloads without requiring the cloud control plane to sit inside a hard-real-time safety loop.
- EDGE-003: Physical side effects require explicit authorization, safety-envelope enforcement, replay protection and durable provenance.

## Training, batch and accelerators

- ACC-001: Training, fine-tuning and large-batch workloads can be represented as governed Executions with resource and cost accounting.
- ACC-002: GPU and specialized-accelerator selection uses provider-neutral capability/resource contracts and remains replaceable by adapter.
- ACC-003: Training checkpoints, datasets, configurations and outputs preserve artifact lineage and verification status; compute success alone does not imply model-release verification.

## Procedural competence

- CMP-001: Successful execution trajectories can produce candidate reusable procedural competences with durable provenance.
- CMP-002: A competence can represent procedural guidance, tool compositions, deterministic procedures, synthesized programs or verification recipes without replacing Tool, Plan, Execution or Agent authorities.
- CMP-003: Competences are immutable versioned artifacts with explicit capabilities, dependencies, compatibility and promotion state.
- CMP-004: Competence promotion requires validation, verification and policy-compatible promotion gates; an agent cannot directly promote its own competence.
- CMP-005: Competence retrieval supports progressive disclosure so only the minimum relevant procedural context is loaded before execution.

## Session and gateway fabric

- GAT-001: Channels and external runtimes can connect through a provider-neutral Gateway and Session abstraction without creating a second execution authority.
- GAT-002: Sessions preserve tenant, application, deployment, agent and execution lineage across turns, retries and interruptions.
- GAT-003: Gateway ingress, translation and delivery retry handling are distinct from execution, policy, budget and verification authorities.
- GAT-004: Gateway adapters are replaceable and provider-neutral while preserving channel-specific provenance.

## Competence trust and ecosystem

- TRU-001: Reusable competences and executable artifacts carry immutable identity, version, provenance, publisher, dependencies, capabilities, security and verification metadata.
- TRU-002: Untrusted external skills, plugins, competences and runtimes cannot become production-eligible without the normal validation, verification and promotion gates.
- TRU-003: Competence installation, activation, deprecation and rollback preserve historical evidence and provenance.
- TRU-004: Compatibility and security metadata can reject a competence before execution without creating a second policy authority.

## Cross-runtime learning

- XRT-001: Zeck can ingest execution trajectories from native agents and external runtimes through provider-neutral observation contracts.
- XRT-002: Cross-runtime observations retain runtime identity, task context, execution provenance and verification evidence without granting runtime authority.
- XRT-003: Cross-runtime scorecards can compare strategies using common execution, cost, quality and verification dimensions.
- XRT-004: External runtime observations can contribute to learning without bypassing Zeck policy, capability, budget or verification.

Total requirements: **114**.
