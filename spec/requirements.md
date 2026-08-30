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
- WOS-003: AI Execution OS returns evidence and artifacts; it does not directly transition WorkflowOS workflow state.
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
