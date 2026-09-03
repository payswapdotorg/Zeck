# Zeck Experience Architecture v2 — Council Decision

**Status:** Architect-directed product UX decision
**Governing technical architecture:** `spec/architecture.md` v1.0 (frozen)
**Relationship to existing UX contract:** Evolves `docs/UX-ARCHITECTURE.md` by sharpening the information hierarchy; it does not create a second execution, policy, budget, verification, identity, credential, or customer-domain authority.

## 1. Executive decision

Zeck shall present a radically simple surface over a radically capable execution control plane.

The product must feel smaller than the system underneath it.

The primary human mental model is:

```text
Intent
  -> Work
  -> Plan
  -> Authorization
  -> Execution
  -> Result
  -> Trust
  -> Improve
```

The UI must never require users to understand models, providers, sandboxes, substrates, ledgers, routing, context compilation, agent runtimes or payment rails before they can obtain useful work.

Advanced system detail remains inspectable and controllable, but appears progressively as context demands.

## 2. Product promise

Zeck is the place where users and developers tell software what outcome they want and receive a governed, observable and evidence-backed result.

The user should experience:

> **Tell Zeck what you want. Zeck figures out how.**

This is consistent with the technical architecture's execution-first, capability-before-provider, deterministic-first, policy-before-dispatch and evidence-over-claims principles.

## 3. Universal human concepts

The visible product is organized around five durable concepts.

### Work
Something Zeck is being asked to accomplish.

Work may internally become an Execution, a long-running workload, a batch job, training, computer use, a deployment action, an edge operation or an economic action, but the user does not need a separate mental model for each substrate.

### Agent
A reusable execution system.

An Agent is presented as a purpose-driven system with capabilities, tools, guardrails, quality, cost and availability rather than as a model wrapper.

### Resource
Things Work can use or produce: files, artifacts, connections, environments, datasets, competencies and related objects.

### Result
What Zeck produced or changed, including artifacts, external outcomes and verified state.

### Rule
What Zeck is permitted or required to do: quality targets, cost limits, approvals, data controls, tool/network permissions and other policy constraints.

These concepts absorb the complexity of the underlying module architecture without changing it.

## 4. Universal actions

The dominant actions are:

- **Ask** — state an outcome in natural language or structured form.
- **Run** — start governed work.
- **Build** — create reusable agents, deployments, workloads or competences.
- **Review** — inspect evidence, resolve decisions, approve consequential actions and diagnose failure.
- **Improve** — act on validated recommendations and learning.

The product should avoid exposing separate top-level flows for every backend capability.

## 5. Information architecture

Recommended desktop navigation:

```text
ZECK

Home

WORK
  New
  Active
  History
  Scheduled

BUILD
  Agents
  Deployments
  Workloads
  Competences

LIBRARY
  Artifacts
  Connections

TRUST
  Evidence
  Evaluations

CONTROL
  Policies
  Spend
  Team
  Environments

IMPROVE
  Insights
  Learning

----------------
Cmd/Ctrl+K  Search / Command
```

The sidebar is orientation, not the primary interaction model. Home, contextual object pages and the command surface are the primary ways to move through the product.

Where role-based or permission-based visibility is available, secondary areas should be collapsed or omitted without changing the underlying object model.

## 6. Home

Home is a decision surface, not an analytics dashboard.

The default hierarchy is:

```text
What would you like Zeck to accomplish?

[ Describe the outcome... ]

Suggested actions

Needs your attention

Happening now

Recent results
```

Charts, infrastructure telemetry, provider rankings and deep spend analytics do not belong above the fold.

Home should prioritize active work, unresolved decisions, approvals, failures requiring action and recent useful results.

## 7. Command/search as a second front door

`Cmd/Ctrl+K` is a universal discovery and action surface.

It accepts both object queries and natural-language commands, for example:

```text
show failed runs yesterday
why did customer-support-17 fail?
create a training workload from this dataset
show agents requiring approval
open invoice-risk-report
compare these two deployments
find deterministicization opportunities
```

Navigation and actions share one command surface, but consequential mutations must still pass through existing API authorization and idempotency paths.

## 8. Work lifecycle UX

All work uses one understandable surface regardless of internal modality.

```text
Intent
  -> proposed approach
  -> permission / cost / risk
  -> run
  -> live progress
  -> result
  -> verification
  -> evidence
```

The user should not be required to select a provider, model, sandbox, accelerator, gateway or payment rail unless the task or policy genuinely requires a human decision.

## 9. Execution detail

Execution is the canonical operational work surface.

Header:

```text
Invoice reconciliation                 Completed

High confidence    38 sec    $0.42
```

Primary tabs:

```text
Result | Evidence | Activity
```

Result answers:

- what was produced;
- whether the work completed;
- whether trust checks passed;
- what action is available next.

Evidence explains why the result can be trusted.

Activity explains what happened over time.

Advanced views may provide:

```text
Timeline | Graph | Events | Raw
```

The graph is never the default progress presentation.

## 10. Trust model

Trust is layered.

```text
Result
  -> checks
  -> evidence
  -> provenance
  -> execution history
  -> advanced route/plan detail
```

Zeck must distinguish at minimum:

- provider success;
- execution success;
- quality success;
- policy success.

A single opaque confidence percentage cannot replace those facts.

## 11. How Zeck did it

Every significant autonomous decision should have a contextual explanation.

The explanation should answer:

```text
What did Zeck understand?
What capabilities were required?
What approach did Zeck choose?
Why was that approach permitted?
Why was this route selected?
What did Zeck deliberately avoid?
How was the result verified?
```

Primary language should describe capabilities and goals. Provider/model/compute details are advanced information unless directly relevant to user choice.

## 12. Outcome-first authoring

All reusable creation begins with purpose, not configuration.

Example:

```text
What are you building?

"A support agent that handles tickets and escalates billing disputes."
```

Zeck proposes:

```text
Purpose
Capabilities
Tools / integrations
Guardrails
Verification
Expected cost
Expected latency
```

The user accepts or edits that proposal before advanced construction is exposed.

Blank-canvas graph editing is an expert mode, not the default authoring experience.

## 13. Agents

Agents are reusable systems.

Primary presentation:

```text
Support Triage

Handles incoming support requests
and escalates billing disputes.

98.7% policy pass
$0.07 / ticket
3 capabilities · 2 integrations
Currently deployed · Version 12
```

Secondary detail may reveal model strategy, provider set, policy graph, compute environment, runtime adapter and execution topology.

## 14. Deployments

A Deployment communicates persistent availability rather than individual work.

Primary view:

```text
Support Triage
Healthy · Version 12

Available through Web · API · Messaging

Current activity
Quality
Spend
```

Actions include pause, rollback and version change where authorized.

The UI must never blur deployment state with execution state.

## 15. Workloads, training and batch

Execution-compatible workload classes share the same interaction language.

The creation surface may offer:

```text
Run something
Process many items
Train a model
Evaluate a system
Deploy something
```

Training detail explicitly separates:

```text
Compute complete
Training complete
Evaluation passed
Release approved
```

The UI must never imply that successful computation automatically means successful evaluation or release.

## 16. Computer use

Computer interaction is presented as an explicit capability and risk envelope.

Example:

```text
Computer access

Browser      Allowed
Terminal     Allowed
Files        Read only
Network      Restricted

External side effects
Approval required

Risk: Medium
```

Advanced explanation may disclose policy, capability, credential mediation, budget, sandbox and verification. The user should not need to understand substrate implementation details.

## 17. Long-running work

Long-running work is presented as progress and reliability, not infrastructure.

Primary information includes:

- progress;
- current phase;
- checkpoint recency;
- spend versus limit;
- estimated remaining work;
- resume/recovery state.

Lease, heartbeat and worker fencing details remain advanced diagnostics.

## 18. Edge and embodied work

Edge and physical work shares Zeck's execution vocabulary but receives a specialized operational presentation.

The UI must surface:

- cloud authorization;
- local safety state;
- current command;
- last verified state;
- whether a new command is permitted.

The experience must never imply that Zeck's cloud control plane replaces a hard-real-time local safety authority.

## 19. Artifacts

Artifact pages are contextual objects, not file-management silos.

Every artifact should expose:

```text
Preview
Created by
Source
Parent artifacts
Verification
Lineage
Used by
```

Users should move naturally from result -> evidence -> artifact -> producing execution.

## 20. Competences

Competences are presented as validated reusable ways of accomplishing work.

Primary presentation:

```text
Invoice Reconciliation

Match invoices against purchase orders
and flag discrepancies.

99.1% success
$0.42 typical cost
38 sec typical time
3 verification checks

[Use competence]
```

Advanced views expose provenance, procedures, validation population, uncertainty, promotion state, compatibility, dependencies and rollback metadata.

## 21. Improve

Learning is surfaced as recommendations, not telemetry.

Example:

```text
Zeck found 3 improvements

Support triage

Potential impact
↓ 31% cost
↓ 24% latency
↑ verification pass rate

Why
37% of requests appear to use
more generative inference than necessary.

Confidence: High

[Review]
```

Recommendations must identify evidence, expected impact, confidence, affected work and whether they are advisory, reviewable or automatically applicable through the normal promotion gate.

## 22. Spend and economics

The ordinary spend experience resembles resource management rather than accounting infrastructure.

```text
This month
$1,284 spent
$3,716 remaining

Executions
Agents
Training
Other
```

Advanced users can inspect reservations, usage, settlement, funding sources and ledger records.

For an economic action the primary surface is:

```text
Purchase required

What: Dataset
Seller: Example Data Co.
Purpose: Invoice classification
Amount: $4.20
Policy: Allowed
Budget: Available

[Approve]
```

Intent, authorization, transaction, settlement and verification remain separate concepts in the underlying system.

## 23. Attention instead of notifications

Zeck should not interrupt users with low-value lifecycle notifications.

The product should aggregate consequential attention:

```text
Attention

2 decisions
1 approval
1 failed execution
1 improvement recommendation
```

Routine events belong in Activity and Evidence.

## 24. Progressive disclosure levels

Every major surface follows four conceptual depths.

### Depth 1 — Outcome

What happened?

### Depth 2 — Explanation

Why did it happen?

### Depth 3 — Control

What can I change?

### Depth 4 — Internals

How exactly did the system execute it?

The product is allowed to be technically deep at Depth 4 while remaining radically simple at Depth 1.

## 25. Experience modes

Experience modes alter visibility and density, never semantics.

### Simple

```text
Home
Work
Results
Approvals
```

### Professional

```text
Work
Agents
Deployments
Resources
Verification
Spend
```

### Expert

```text
Plans
Capabilities
Policies
Providers
Substrates
Events
Lineage
Audit
```

## 26. Universal consequence preview

Before any consequential external action, the UI should present:

```text
What will happen?
Who or what will be affected?
What will it cost?
Why is it allowed?
Can it be undone?
What approval is required?
```

This applies to external messages, purchases, changes to deployed systems, high-risk computer use, physical actions and other policy-designated side effects.

## 27. Responsive behavior

Desktop supports persistent orientation and richer side-by-side detail.

Tablet collapses secondary navigation and moves advanced inspection into focused panels.

Mobile prioritizes:

```text
Home
Active work
Attention
Result
Approval / Review
Command
```

Graph, raw events and deep administration are deliberately de-emphasized on small screens.

## 28. Accessibility

Accessibility remains structural:

- keyboard-first interaction;
- visible focus;
- semantic headings and landmarks;
- non-color state communication;
- scalable text and layout;
- reduced motion;
- accessible timelines and tables;
- explicit consequence confirmation;
- persistent asynchronous state;
- understandable recovery language.

## 29. The full capability surface, one UX

The following technical capabilities must not become separate user mental models:

| Capability | User experiences it as |
|---|---|
| Models/providers | Route / Zeck decision |
| Tools | Capability / integration |
| Agents | Reusable agent |
| Context compilation | Context prepared |
| Sandboxes | Safe compute |
| Browser/desktop/terminal | Computer access |
| Batch | Process many |
| Training | Train |
| Accelerators | Compute |
| Long-running execution | Ongoing work |
| Edge/robotics | Physical work |
| Voice/realtime | Live interaction |
| Messaging | Channel |
| Media generation | Generated result |
| Verification | Checks / Trust |
| Evidence/provenance | Why / Evidence |
| Learning | Improve |
| Deterministicization | Optimization |
| Competence | Reusable skill |
| Policies | Rules |
| Budgets | Spend / Limit |
| EconomicAction | Purchase / Payment |
| Payment rails | Transaction detail |
| External runtimes | Runtime / integration |

This is a UX translation layer, not a change to domain architecture.

## 30. Anti-patterns explicitly rejected

Zeck must not become:

- a giant AI dashboard;
- provider-first navigation;
- model-shopping as the default workflow;
- a graph-first execution monitor;
- a permanent infrastructure telemetry wall;
- a separate UI universe for every workload type;
- a notification-heavy activity center;
- a blank-canvas automation IDE for ordinary users;
- a ledger/accounting interface for routine spend;
- a hidden-confidence or opaque-AI decision system;
- a control surface that bypasses API/domain authorities.

## 31. Product quality test

A new feature passes UX review only if:

1. Its user-facing purpose is expressible in ordinary language.
2. It can be understood without learning a backend module name.
3. The default state exposes outcome before mechanism.
4. Consequential actions explain consequence, authorization and cost before commitment.
5. Trust claims link to actual evidence.
6. Advanced details remain inspectable.
7. The feature does not create a competing authority or second lifecycle.
8. The same concept can be expressed through API/SDK and dashboard semantics.
9. Mobile and accessibility behavior preserve the same hierarchy.
10. The feature reduces or preserves cognitive load rather than merely adding controls.

## 32. Design north star

Zeck should feel like:

> **A calm place where complex computer work gets done, with the depth of an infrastructure platform available exactly when you need it.**

The interface is the calm surface.

The execution architecture is the machinery underneath.

The user should never have to become an infrastructure engineer merely to benefit from that machinery.
