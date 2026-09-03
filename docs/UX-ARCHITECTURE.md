# Zeck Experience Architecture

**Status:** Accepted UX direction  
**Scope:** Presentation and interaction architecture only  
**Governing technical architecture:** `spec/architecture.md` v1.0  
**Authority:** This document defines how Zeck exposes the existing platform to humans and developers. It does not create a competing execution, policy, budget, verification, identity, or customer-domain authority.

## 1. Product experience thesis

Zeck should feel like the place where work simply gets done, not like an AI control panel.

The user-facing mental model is:

```text
What do you want done?
        ↓
Zeck plans and executes it
        ↓
What is happening?
        ↓
What happened?
        ↓
Can I trust it?
        ↓
Why did Zeck do it?
```

The backend may coordinate models, tools, agents, programs, context compilation, compute environments, verification, budgets, providers, edge substrates, training systems and economic rails. The UI should expose those mechanisms only when they help a user understand, decide, build, control or debug.

## 2. Six UX questions

Every user-visible feature must answer at least one of these questions:

1. **What do I want done?**
2. **What is happening?**
3. **What happened?**
4. **Can I trust it?**
5. **What am I allowed to change?**
6. **How can it get better?**

Features that answer none of these belong behind an expert/diagnostic layer or should remain API-only.

## 3. Primary information architecture

Desktop navigation is organized around human tasks rather than backend modules.

```text
ZECK

Home

Build
  Executions
  Agents
  Deployments
  Workloads

Runs
  Active
  History
  Scheduled

Assets
  Artifacts
  Competences
  Connections

Improve
  Evaluations
  Insights
  Learning

Admin
  Policies
  Budgets
  Team
  Environments
  Audit
```

The hierarchy is deliberately shallow. Global search/command is a first-class navigation layer so users rarely need to browse the full tree.

### 3.1 User language versus system language

Prefer:

| System concept | Primary UI language | Advanced label |
|---|---|---|
| Execution | Run / Execution | Execution |
| Capability | Capability | Capability |
| Model/provider route | Route | Provider / Model strategy |
| Policy | Rules / Controls | Effective policy |
| Budget | Spend / Limit | Reservation / settlement |
| Verification | Confidence / Checks | Verification strategy |
| Compute environment | Compute | Substrate / environment |
| Artifact | File / Result / Artifact | Artifact lineage |
| Learning | Improve | Learning telemetry |
| Human intervention | Review / Approval | Human escalation |
| Economic action | Payment / Purchase / Spend | EconomicAction |
| Context compiler | Context | Context compilation |
| Competence | Skill / Competence | Competence |

Backend names remain available in expert views and API documentation.

## 4. Home: the "Now" surface

Home is not an analytics dashboard. It is a decision surface.

### Above the fold

```text
What would you like Zeck to accomplish?
[ Describe the outcome…                         ]

Suggested actions
Analyze files   Build an agent   Run a workload   Review a result

Needs your attention
[ 3 concise items ]

Happening now
[ 3 active executions with progress ]

Recent
[ 5–8 recent executions ]
```

The primary input accepts natural-language intent and may attach files, choose a saved competence, or start from a template.

Home prioritizes active work, unresolved decisions and recent outcomes over charts.

## 5. Global command surface

`Cmd/Ctrl + K` opens a universal command/search layer.

It supports both navigation and action:

```text
show failed executions yesterday
what cost us the most this month?
why did customer-support-17 fail?
create a training workload from this dataset
show me all agents requiring approval
open artifact invoice-risk-report
```

Search scopes include executions, agents, deployments, workloads, artifacts, competences, connections and settings. Commands requiring authorization are presented as proposed actions before mutation.

## 6. The execution is the center of the product

Execution detail is the canonical work surface.

### 6.1 Header

```text
Contract risk analysis                         ● Completed
High confidence     3m 42s     $4.18     4/4 checks
```

Status, duration, cost and confidence are always visible near the execution identity.

### 6.2 Primary tabs

```text
Result | Evidence | Activity
```

**Result** is the default. **Evidence** explains trust. **Activity** explains progress and events.

### 6.3 Result surface

The result page should answer immediately:

- What was produced?
- Is it complete?
- Can I trust it?
- What should I do next?

A compact verification strip sits beside the result:

```text
CONFIDENCE  High
✓ Data integrity
✓ Constraint compliance
✓ Independent consistency check
✓ Citation coverage

4 / 4 checks passed     View evidence
```

### 6.4 Why Zeck did this

A persistent disclosure action exposes the execution rationale:

```text
How Zeck did it ▾

Understood task
→ Required document parsing + retrieval + reasoning + verification

Plan
→ Parse → retrieve → analyze → cross-check → verify

Capabilities
→ document parser, retrieval, reasoning, consistency check

Route
→ selected according to effective policy, cost target and quality target

Compute
→ isolated container

Why this route?
→ met the required quality within the allowed budget
```

Provider/model names are secondary details, not the primary mental model.

## 7. Execution progress

The default progress visualization is chronological, not a graph.

```text
12:41  Authorized
12:42  Planning
12:42  Context prepared
12:43  Analysis running       68%
12:44  Verification running
12:44  Completed
```

Advanced views may switch to:

```text
Timeline | Graph | Events | Raw
```

The graph is for complex execution inspection and authoring. It must not be the default status view.

## 8. Failure and waiting states

Failures are written as recoverable explanations, not infrastructure jargon.

```text
Zeck could not complete this execution.

The selected connection rejected the request.

[ Try another route ]   [ Review connection ]
```

For `WAITING_USER` or `WAITING_HUMAN`:

```text
Decision needed

Zeck found two valid approaches.

A  Higher quality   $4.60   ~3 min
B  Lower cost       $1.90   ~2 min

[ Choose A ] [ Choose B ]
```

High-risk actions make the consequence explicit before approval:

```text
This action will send 4,218 messages.
Policy requires your approval before dispatch.

[ Review ] [ Cancel ]
```

Human intervention is treated as a normal governed execution state, not an error state.

## 9. Builder experience

Zeck is outcome-first even when the user is building something reusable.

### 9.1 Start

```text
What are you building?

"A support agent that handles incoming tickets and escalates billing disputes."

[ Build with Zeck ]
```

### 9.2 Proposal

Zeck proposes a human-readable design:

```text
Purpose
Customer support triage

Capabilities
Ticket retrieval · classification · knowledge retrieval · response drafting

Tools
CRM · knowledge base · email

Guardrails
Approval for refunds · no unrestricted outbound sending

Verification
Response policy check · citation check · escalation check

Estimated operating cost
~$0.08 / ticket

[ Use this plan ] [ Edit ]
```

Only after acceptance does the interface reveal detailed plan construction.

### 9.3 Advanced authoring

Power users can inspect and edit the immutable execution plan shape, branches, retries, verification nodes, capabilities and policies. Visual graph editing is an advanced authoring mode, not a blank-canvas requirement.

## 10. Agents

Agents are presented as reusable execution systems, not a second universe beside Executions.

An agent detail page answers:

```text
Purpose
Capabilities
Tools
Autonomy
Approval requirements
Current deployment
Recent executions
Quality
Cost
Version
```

Example summary:

```text
Support Triage Agent

Handles incoming tickets and escalates risky billing cases.

3 capabilities · 2 tools · approval on refunds · verified responses

12,481 executions   98.7% policy pass   $0.07 avg / ticket
```

The page can disclose the underlying model strategy, provider set, compute environment and policy graph only in advanced detail.

## 11. Deployments

Deployments represent persistent availability, while Executions represent individual governed work.

Deployment surfaces show:

- status
- version
- channels/endpoints
- active sessions where applicable
- recent executions
- health/quality
- spend
- rollback/version controls

The product must never blur "running deployment" with "running execution."

## 12. Workloads, training and batch compute

A single creation flow offers:

```text
Execution   Agent   Training   Batch processing   Deployment
```

Training and specialized compute remain visibly governed executions.

Training detail:

```text
Dataset
Code
Configuration
Compute
Checkpoints
Runs
Evaluation
Release
```

Important user-facing controls include estimated cost, budget reservation, checkpoint state, resume/retry state, verification status and release eligibility.

The UI must distinguish:

- compute completed
- training completed
- evaluation passed
- release approved

These are not interchangeable states.

## 13. Computer-use experience

Computer access is presented as explicit capability and risk.

```text
Computer access requested

Browser      Allowed
Desktop      Allowed
Files        Read-only
Network      Restricted

Risk: Medium
Approval: Required for external side effects

[ Review access ]
```

The user should not have to understand sandbox implementation details. The advanced explanation can show policy → capability → credential mediation → budget → execution → sandbox → verification → evidence.

## 14. Edge and embodied execution

Edge/robotic experiences use a specialized operational surface while sharing Zeck's execution language.

```text
Robot cell 04                              ● Connected

Current command
Move pallet to station B

Cloud governance
Authorized ✓
Policy ✓
Safety envelope ✓
Local controller ✓

Last verified state
Station B clear

If cloud connection is lost:
Local safety envelope remains active.
No new cloud command will be dispatched.
```

The local safety controller is treated as an operational constraint, never hidden by the cloud UI.

## 15. Artifacts and evidence

Artifacts are first-class outputs and evidence anchors.

Artifact pages show:

```text
Preview
Metadata
Created by execution
Source/provenance
Parent artifacts
Verification
Lineage
Usage references
```

Users should be able to navigate from a result → evidence → artifact → producing execution.

## 16. Competences

Competence is a reusable, evidence-backed way of describing work Zeck knows how to perform.

A competence page surfaces:

```text
Invoice reconciliation

Purpose
Match invoices against purchase orders and flag discrepancies.

Success rate   99.1%
Typical cost   $0.42
Typical latency 38s
Verification   3 checks

Procedure
[ View ]

Use competence
```

Competences should be easier to discover than their internal procedural representation.

## 17. Improve

Learning is exposed to users as useful recommendations, not telemetry jargon.

```text
Improve your support workflow

3 opportunities found

↓ 31% latency
↓ $1,840 / month
↑ 4.8% verification pass rate

[ Review improvements ]
```

Every recommendation must identify:

- observed evidence
- expected impact
- confidence
- affected executions or deployments
- whether the change is automatically applicable, reviewable, or advisory

Learning never silently changes authority.

## 18. Costs and budgets

The ordinary view should feel like spend management, not ledger administration.

```text
This month
$1,284 spent
$3,716 remaining

Executions     $702
Agents         $334
Training      $198
Other          $50
```

Advanced detail can expose reservations, usage records, settlement, funding source and append-only ledger transactions.

## 19. Policies and controls

The primary policy UI uses user concepts:

```text
Quality       High
Cost limit    $50 / execution
Latency       < 2 minutes
Data region   Ghana + EU
External tools Allowed: CRM, Email
Approval      Required for external side effects
```

Raw policy composition, precedence, effective-policy calculation and machine-readable constraints are advanced detail.

The UI must show why an action is blocked and identify which governing rule caused the block.

## 20. Settings and administration

Settings remain stable and intentionally boring.

```text
Workspace
Security
Policies
Billing
Connections
Environments
Notifications
Appearance
Accessibility
Developer
```

Administrative surfaces are separated from operational work so configuration does not dominate the primary product experience.

## 21. Experience modes

Zeck supports progressive disclosure through three conceptual experience modes.

### Simple

```text
Home · Execute · Runs · Results
```

### Professional

```text
Executions · Agents · Deployments · Workloads · Resources · Verification · Costs
```

### Expert

```text
Plans · Capabilities · Policies · Providers · Substrates · Events · Artifacts · Lineage · Audit · Raw execution graph
```

Modes may be implemented progressively, but the information architecture must preserve the same underlying object model.

## 22. Responsive behavior

### Desktop

Use a persistent sidebar, command bar and two-column detail layouts where useful.

### Tablet

Collapse secondary navigation and preserve the execution detail hierarchy. Evidence and advanced detail may become sheets/panels.

### Mobile

Prioritize:

```text
Home
Active work
Attention
Execution result
Approval/review
Command/search
```

Complex graph, raw event and deep administration views should be progressively disclosed or moved into dedicated detail screens rather than compressed into tiny controls.

## 23. Accessibility requirements

The experience must support:

- keyboard-first navigation
- visible focus states
- semantic headings and landmarks
- sufficient hit targets
- scalable text and layout
- reduced-motion behavior
- clear non-color status communication
- screen-reader-friendly timelines and tables
- confirmation for destructive/high-impact actions
- persistent context for asynchronous operations
- understandable error and recovery copy

Accessibility is part of the information architecture, not a post-processing layer.

## 24. Interaction patterns

Preferred patterns:

- inline progress near the affected execution
- scoped sheets for focused tasks
- action sheets for consequential choices
- familiar menus for compact command lists
- disclosure for advanced detail
- command/search for discovery
- concise notifications grouped as **Attention** rather than a noisy notification center

Avoid:

- permanent giant dashboards
- modal chains
- hidden destructive actions
- graph-first status monitoring
- provider-centric primary navigation
- exposing backend modules as top-level user concepts
- forcing users to configure internals before proving product value

## 25. Onboarding

Onboarding should demonstrate value before teaching architecture.

First-run path:

```text
1. Ask what the user wants done.
2. Offer a safe example or let them attach real work.
3. Show the proposed plan and estimated cost/time.
4. Run it.
5. Show result + verification evidence.
6. Explain advanced controls only when they become relevant.
```

Setup that is not required for the first useful execution should be deferrable.

## 26. Trust model in the UI

Trust is layered, never reduced to a single magic score.

```text
Result
  ↓
Verification checks
  ↓
Evidence
  ↓
Provenance
  ↓
Execution history
  ↓
Advanced route/plan/provider detail
```

"High confidence" must always be explainable.

The platform must distinguish at minimum:

- provider success
- execution success
- quality success
- policy success

## 27. Developer experience alignment

The dashboard, SDK and API must describe the same underlying mental model.

A user action such as:

```text
Run this task with a $10 limit and high quality.
```

should map conceptually to the same intent expressed by the API, while Zeck still owns planning, routing, execution, verification and evidence according to the architecture.

The UI must not invent a second execution semantics that differs from the API.

## 28. Visual direction

The visual system should feel calm, precise and content-first.

Principles:

- hierarchy over decoration
- typography carries structure
- surfaces distinguish navigation from work content
- restrained use of color, primarily for state/attention
- generous whitespace
- stable alignment
- consistent interaction vocabulary
- advanced detail appears when context demands it

Zeck should not resemble a developer IDE, trading terminal or enterprise data warehouse by default.

## 29. Core journeys

### Journey A — First successful execution

```text
Home → describe outcome → review plan/cost → Execute → Result → Evidence
```

### Journey B — Investigate a failed run

```text
Runs → failed execution → Result/Failure → Why → Activity → remediation action
```

### Journey C — Build an agent

```text
Home/Build → describe purpose → proposed design → Use plan → configure guardrails → deploy → observe executions
```

### Journey D — Approve a risky action

```text
Attention → decision request → consequence → policy → proposed action → Approve/Reject → verification
```

### Journey E — Improve a system

```text
Improve → recommendation → evidence → projected impact → review → apply/change → verify outcome
```

### Journey F — Run specialized compute

```text
Build → Training/Batch → dataset/config → compute + budget → execution → checkpoints → evaluation → release decision
```

## 30. Canonical object-to-UI mapping

| Platform object | Primary experience | Secondary experience |
|---|---|---|
| Execution | Result / Progress / Why | Raw events |
| Execution Step | Activity | Plan graph |
| Policy | Controls | Effective-policy detail |
| Budget | Spend / limits | Reservations + ledger |
| Capability | Build / Why | Catalog |
| Model | Route detail | Provider administration |
| Tool | Capability detail | Tool administration |
| Agent | Build / Deployment | Runtime internals |
| Deployment | Availability | Version details |
| Workload | Build / Run | Compute internals |
| Artifact | Result / Evidence | Lineage |
| Evaluation | Evidence / Improve | Scoring internals |
| Verification Result | Confidence / Evidence | Strategy internals |
| Competence | Reusable work | Procedural definition |
| Connection | Setup / Admin | Provider internals |
| Compute Environment | Advanced compute detail | Sandbox administration |
| Usage Record | Cost detail | Accounting |
| Ledger Transaction | Finance admin | Accounting internals |
| Webhook | Integration admin | Event detail |
| Audit | Admin | Raw platform evidence |

## 31. Success criteria for the UX architecture

The UX architecture is successful when:

1. A first-time user can complete a useful execution without understanding models, providers, tools, sandboxes or routing.
2. A professional user can build, operate and monitor agents, workloads and deployments without leaving the Zeck mental model.
3. An expert can reach every important control and diagnostic surface without the simple experience becoming cluttered.
4. Every consequential action reveals its authorization, cost/risk and expected outcome before commitment.
5. Every reported success can be traced to evidence and execution history.
6. The same concepts map consistently across UI, SDK and API.
7. Backend architectural complexity remains available without becoming the user's default mental model.

## 32. Non-goals

This document does not:

- modify the frozen v1.0 execution or policy authority
- create UI-specific domain state machines that compete with `/executions`
- redefine customer application workflow ownership
- declare provider-specific UI semantics as platform authority
- require a particular frontend framework
- freeze colors, typography or component-library implementation details

Implementation details should evolve inside the boundaries established here.
