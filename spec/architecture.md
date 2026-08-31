# AI Execution OS Architecture

**Version:** v1.0
**Status:** FROZEN AFTER APPROVAL (bootstrap package)
**Purpose:** Define the architectural structure and authorities of AI Execution OS.

---

# 1. Purpose

AI Execution OS provides a provider-independent execution control plane for AI work. An application supplies an execution intent and constraints. The platform constructs and executes a plan that may combine models, deterministic programs, tools, agents, external services, sandboxes, verification and human intervention.

The platform is an execution authority, not a domain-workflow authority. Customer applications retain ownership of their own business state machines, domain verification semantics and release decisions.

---

# 2. Architectural principles

## 2.1 Execution is the primary abstraction

The stable public primitive is an `Execution`, not a model call. An Execution may contain zero or more model calls, tools, algorithms, agents, verification steps and human interactions.

## 2.2 Evidence over claims

A model or agent's statement that a result is correct is not sufficient proof. Verification evidence must be associated with the execution and the relevant quality requirements.

## 2.3 Provider independence

No domain module is allowed to depend on a specific model, agent, gateway, or provider SDK. Provider-specific behavior lives behind adapters.

## 2.4 Policy before dispatch

No model, tool, agent, external side effect, secret, or sandbox is dispatched until the effective policy has been evaluated.

## 2.5 Capability before provider

The system first determines the capabilities required by the task. Provider/model/agent selection is a downstream implementation choice.

## 2.6 Deterministic computation is first-class

The planner may choose programs, databases, algorithms, retrieval systems, calculators, compilers and other deterministic capabilities instead of or alongside generative models.

## 2.7 Context is compiled

Raw application state is not treated as model-ready context. Retrieval, filtering, deduplication, compression, structuring and task-specific transformation are explicit execution capabilities.

## 2.8 Verification is part of execution

Quality verification is part of the execution plan. A provider returning HTTP success does not imply task success.

## 2.9 Human intervention is a governed execution primitive

The platform may request user input or human review when uncertainty cannot be reduced adequately by additional computation and the policy permits escalation.

## 2.10 Isolation is policy- and risk-selected

Execution environments range from no code execution to process sandbox, container, microVM, VM and customer-controlled runner. The planner chooses an environment according to task capability, risk and policy.

## 2.11 Learning improves decisions; it never silently rewrites authority

Historical outcomes may improve model, tool, context, plan, verification and environment selection. Learning never bypasses policy or application-domain authority.

## 2.12 Customer-domain authority remains outside this platform

The platform returns execution results, artifacts, evidence and provenance. Customer systems decide their own business-state transitions.

---

# 3. System context

```text
                         CUSTOMER APPLICATION
                                  |
                                  v
                         +-------------------+
                         | AI Execution API  |
                         +---------+---------+
                                   |
                  +----------------+----------------+
                  |                                 |
                  v                                 v
           CONTROL / POLICY                  EXECUTION PLANE
                  |                                 |
                  v              +------------------+------------------+
          INTELLIGENCE PLANE     |                  |                  |
       +---------------------+   v                  v                  v
       | capability engine  | models             tools              agents
       | context compiler   |   |                  |                  |
       | execution planner  |   +------------------+------------------+
       | learning engine    |                      |
       +---------------------+                      v
                                            sandbox / runtime
                                                    |
                                                    v
                                               verification
                                                    |
                                                    v
                                              result + evidence
```

---

# 4. High-level layers

1. Experience — REST, SDKs, CLI, dashboard, webhooks.
2. Control — applications, environments, connections, policies, budgets, permissions.
3. Intelligence — task profiling, capabilities, context compilation, planning, routing, learning.
4. Execution — providers, models, tools, agents, sandboxes, customer runners.
5. Evidence — executions, steps, artifacts, evaluations, provenance and event history.
6. Economic — wallets, reservations, usage, settlement and BYOK accounting.
7. Security — identity, policy, secret mediation, network controls, isolation.

---

# 5. Public domain objects

- Application
- Environment
- Connection
- Policy
- Budget
- Funding Source
- Capability
- Model
- Tool
- Agent
- Task
- Execution
- Execution Step
- Execution Event
- Artifact
- Evaluation
- Verification Result
- Compute Environment
- Usage Record
- Ledger Transaction
- Webhook

---

# 6. Module boundaries

The initial modular-monolith modules are:

| Module | Responsibility |
|---|---|
| `/auth` | platform identity and authorization |
| `/applications` | applications, environments and project ownership |
| `/connections` | provider connections, BYOK, customer endpoints |
| `/policies` | effective policy resolution and enforcement contracts |
| `/budgets` | funding, reservations and append-only accounting |
| `/capabilities` | capability catalog and capability evidence |
| `/executions` | execution identity, plan lifecycle, steps and events |
| `/planning` | task profiling, plan generation and deterministic plan selection |
| `/models` | model/provider adapters and model metadata |
| `/tools` | governed tool registry and tool execution |
| `/agents` | agent providers and agent runtime contract |
| `/deployments` | provider-neutral agent deployment fabric (profiles, plans, lifecycle) |
| `/context` | retrieval/context compilation and artifact derivation |
| `/sandbox` | process/container/microVM/VM/customer-runner environments |
| `/verification` | verification strategies, evaluations and quality gates |
| `/learning` | outcome telemetry, scorecards and routing/tool/plan learning |
| `/artifacts` | durable artifacts and provenance |
| `/webhooks` | outbound event delivery |
| `/audit` | privileged platform event trail |

Cross-module access is through public interfaces. Internal implementation imports are forbidden.

---

# 7. API layer

The API layer is transport-only. It authenticates the caller, resolves application scope and delegates to module interfaces. It contains no authoritative domain state transition logic.

---

# 8. Execution lifecycle

```text
CREATED
  -> AUTHORIZED
  -> PLANNING
  -> QUEUED
  -> RUNNING
  -> VERIFYING
  -> COMPLETED

Alternative paths:
RUNNING -> WAITING_TOOL -> RUNNING
RUNNING -> WAITING_USER -> RUNNING
RUNNING -> WAITING_HUMAN -> RUNNING
VERIFYING -> REPLANNING -> QUEUED
RUNNING -> FAILED
VERIFYING -> FAILED
ANY_NONTERMINAL -> CANCELLED
ANY_NONTERMINAL -> EXPIRED
```

The execution state machine belongs to `/executions`. Customer workflow state does not belong to this state machine.

---

# 9. Execution Plan

An Execution Plan is an immutable-at-step-start graph describing intended work. A logical Execution may contain multiple plans after replanning.

Supported step classes:

- retrieve
- transform
- generate
- call-model
- call-tool
- call-agent
- run-program
- run-algorithm
- parallel
- branch
- verify
- compare
- ask-user
- ask-human
- retry
- escalate
- terminate

Plans are authorized before external side effects occur.

---

# 10. Capability engine

The Capability Engine resolves task needs into capability requirements before provider selection. Capabilities include model, tool, algorithm, data, runtime and human capabilities.

The engine may compose capabilities. Example: contract analysis may require document parsing + retrieval + clause segmentation + reasoning + citation mapping + consistency verification.

---

# 11. Context compiler

The Context subsystem turns raw application state into task-specific artifacts through:

```text
source -> retrieval -> relevance -> deduplication -> compression -> structure -> task context
```

Artifacts preserve provenance and parent/child lineage.

---

# 12. Provider fabric

Provider adapters normalize:

- request/response contracts
- streaming
- structured outputs
- tool calls
- multimodal data
- pricing/usage
- provider errors
- asynchronous jobs

OpenRouter is supported as a provider-federation rail, not as a system authority or architectural dependency.

---

# 13. Tool runtime

Tools are governed capabilities. Tool outcomes are observations/evidence. Tools cannot directly mutate customer workflow state or platform authority state.

Tool classes initially include:

- filesystem
- terminal
- HTTP
- browser
- search/fetch
- calculator
- schema validator
- parser
- program execution
- database access through explicit customer connectors

Every invocation is policy-gated and recorded as an execution event.

---

# 14. Agent runtime

Agents are composed of a reasoning capability, tools, workspace, compute environment, policy, session state and execution identity.

`LLM != Agent`.

The platform may delegate to external coding or browser agents, hosted agents, local agents or customer-controlled agents.

---

# 15. Compute environments

The platform defines one provider-independent `ComputeEnvironment` abstraction with implementations:

- no-execution
- process sandbox
- container
- microVM
- VM
- customer runner

Environment selection is risk- and policy-driven. Containers are the initial general-purpose implementation. MicroVM and VM support is a planned evolution for higher-risk or desktop workloads.

---

# 16. Policy and permissions

Effective policy controls:

- cost
- quality target
- latency
- privacy
- provider/model eligibility
- tool permissions
- network access
- secrets
- autonomy
- compute isolation
- user/human escalation

Policies may tighten upstream constraints. They cannot weaken higher-authority prohibitions.

---

# 17. Economic system

The budget subsystem supports:

- application-funded spending
- user-funded spending
- BYOK
- hybrid funding
- platform subsidy
- per-execution reservations
- append-only settlement

Actual provider cost is reconciled after execution. Unused reservations are released.

---

# 18. Verification

Verification may be deterministic, model-based, cross-model, retrieval-based, simulation-based or human.

The platform must distinguish:

- provider success
- execution success
- quality success
- policy success

A successful provider call is never itself sufficient evidence of task correctness.

---

# 19. Learning

The learning plane records:

- task characteristics
- context strategy
- capability selection
- execution plan
- models/providers
- tool sequence
- compute environment
- verification strategy
- cost
- latency
- outcome
- user/human feedback

Learning may improve recommendations but does not bypass the policy engine, verification authority or customer-domain authority.

---

# 20. Application boundary

The platform returns a result package:

```text
result
artifacts
verification evidence
provenance
cost
latency
route
warnings
```

A customer application consumes these outputs through its own domain boundary. For WorkflowOS, the resulting evidence is consumed by WorkflowOS's existing workflow/verification/review authorities.

---

# 21. Architecture evolution

This architecture is frozen once approved. Any change to a frozen rule requires an Architecture Change Request and a new immutable architecture version. Forward-evolution sections may add capabilities without rewriting historical architecture.
