# Zeck UX Screen Specification v2

**Status:** Architect-directed design specification
**Governing technical architecture:** `spec/architecture.md` v1.0 (frozen)
**Governing UX direction:** `docs/UX-EXPERIENCE-ARCHITECTURE-V2.md`

## 1. Global interaction grammar

Every primary Zeck experience follows:

```text
Intent -> proposed approach -> authorization/consequence -> execution -> result -> trust -> next action
```

The interface must preserve one mental model across AI, deterministic, agentic, batch, training, realtime, computer-use, edge, physical and economic work.

## 2. Global shell

Desktop:

- persistent but visually quiet navigation;
- global command/search;
- contextual page title;
- one dominant primary action;
- attention indicator only when action is required.

Tablet:

- collapsed navigation;
- full-width work surfaces;
- advanced information in focused sheets/panels.

Mobile:

- Home;
- Work;
- Attention;
- current Result/Review;
- command/search.

Global rule: never put more than one primary consequential action in the visual foreground at once.

## 3. Journey: first successful execution

### Entry
Home.

### Primary surface

```text
What would you like Zeck to accomplish?
[ describe outcome ]
```

Attachments, saved competences and templates are secondary affordances.

### Proposed approach
Show purpose, capabilities, estimated cost, latency, permissions and verification approach.

Do not require provider/model/substrate selection.

### Commitment
The primary action is `Run`.

For external side effects, replace `Run` with an explicit consequence-bearing confirmation.

### Completion
Open the Result view with verification summary visible.

### Trust
Show the four required distinctions where applicable: provider, execution, quality and policy.

## 4. Journey: failed execution and recovery

### Entry
Runs or Attention.

### Failure card
Use plain-language cause and recovery path.

```text
Zeck could not complete this work.

The connection rejected the request.

[Try another route]
[Review connection]
```

### Advanced
Expose events, route, policy, provider details and provenance only after the recovery decision is understood.

### Important rule
Never imply that a provider error means the task itself is impossible.

## 5. Journey: human approval

### Entry
Attention.

### Approval card
Show:

- requested action;
- affected resource/recipient;
- consequence;
- expected cost;
- governing rule;
- reversibility;
- evidence available so far.

Example:

```text
This action will send 4,218 messages.
Policy requires your approval.

Cost estimate: $18.20
Reversible: No

[Review] [Reject]
```

### Approval action
Commit only through the governed API operation.

### Completion
Return to the originating execution context and show verification.

## 6. Journey: build an agent

### Step 1
Describe the purpose.

### Step 2
Zeck proposes capabilities, integrations, guardrails, verification and operating envelope.

### Step 3
User accepts or edits the proposal.

### Step 4
Advanced controls appear only as necessary.

### Step 5
Build creates a versioned reusable Agent artifact.

### Step 6
Deployment is a separate explicit next step.

## 7. Journey: manage a deployment

Primary screen:

```text
Support Triage
Healthy · v12

Available through
Web · API · Messaging

Current sessions
Quality
Spend
```

Primary controls:

`Pause`, `Rollback`, `Change version`.

Do not show deployment implementation topology before operational state.

## 8. Journey: batch/training

Start with the outcome, not the substrate.

```text
What are you trying to accomplish?
[Process many items]
[Train a model]
[Evaluate a system]
```

Training screen must distinguish compute, training, evaluation and release status.

Cost and budget remain visible throughout a running workload.

## 9. Journey: artifact/evidence investigation

Artifact opens with:

- preview;
- producing execution;
- verification status;
- source/provenance;
- parent artifacts;
- downstream usage.

Navigation should permit:

```text
Artifact -> Execution -> Evidence -> Source
```

without returning to a top-level asset index at every step.

## 10. Journey: competence discovery and reuse

Competence discovery begins from a task or search phrase.

Results emphasize:

- what the competence accomplishes;
- relevance;
- success rate;
- typical cost/time;
- verification state.

`Use competence` is the primary action.

Procedure internals, provenance and promotion data are advanced.

## 11. Journey: improvement recommendation

A recommendation must answer:

```text
What did Zeck observe?
What could improve?
How large is the expected impact?
How confident is the recommendation?
What will change?
Is approval required?
```

Never present learning telemetry without translating it into a decision or recommendation.

## 12. Journey: computer-use / consequential external action

Before computer-use begins, show the capability envelope.

```text
Browser   Allowed
Desktop   Restricted
Files     Read-only
Network   Restricted
External side effects   Approval required
Risk      Medium
```

For each high-impact external action, show consequence preview before commitment.

Where an API/deterministic path exists, the UI should explain that it is preferred rather than silently implying GUI interaction is necessary.

## 13. Journey: scheduled and long-running work

Scheduled:

- next run;
- schedule;
- last result;
- failure streak;
- spend envelope.

Long-running:

- progress;
- phase;
- checkpoint recency;
- spend;
- recovery/resume state.

Infrastructure concepts such as leases and worker heartbeats belong in advanced diagnostics.

## 14. Journey: spend/budget

Default view:

```text
Spend this month
$1,284 / $5,000

Executions
Agents
Training
Other
```

Budget controls use user language such as `limit`, `approval` and `allowed spend`.

Reservations and settlement are advanced accounting views.

## 15. Journey: policy interpretation

User should be able to ask:

> Why can't Zeck do this?

Response structure:

```text
Blocked

Action: send external email
Reason: policy requires approval
Rule: External side effects
Scope: This application
```

Where several policies contribute, identify the effective controlling rule without forcing the user to understand policy precedence mechanics.

## 16. Journey: realtime/channel deployment

For voice/messaging:

```text
Support Agent
Live

Channel: Phone
Deployment: v12
Active sessions: 8

Escalation available
```

Session/turn/provenance information is available in activity/evidence, not the primary channel view.

## 17. Journey: edge/embodied operation

Operational view prioritizes:

- current physical command;
- local safety envelope;
- authorization;
- last verified state;
- connection state.

Cloud control-plane detail is secondary. The UI must explicitly preserve the local safety authority boundary.

## 18. Empty states

Empty states explain value and provide the next useful action.

Bad:

`No executions found.`

Good:

`No runs yet. Describe something you want Zeck to accomplish.`

## 19. Loading states

Loading must preserve page hierarchy. Do not replace the whole shell with a spinner.

Where asynchronous state is expected, show the current stage and retain the user's context.

## 20. Error states

Every error includes:

- what happened;
- what is known;
- what the user can do next;
- whether retry is safe.

Do not expose raw provider/network stack traces in the default experience.

## 21. Permission-denied states

Explain:

- requested action;
- missing permission or controlling rule;
- owner/admin pathway if one exists.

Never expose secret or authorization internals.

## 22. Accessibility invariants

Every primary journey must support:

- complete keyboard traversal;
- visible focus;
- semantic landmarks/headings;
- screen-reader-readable status;
- status independent of color alone;
- scalable text;
- reduced motion;
- accessible modal/sheet focus management;
- accessible timelines and tables;
- confirmation for destructive or consequential actions.

## 23. Command equivalents

Every major navigation target must be discoverable through command/search.

Every mutation available from the UI should have a natural-language command representation but still execute through the same governed API operation.

## 24. Progressive disclosure contract

Default:

```text
Outcome
Trust state
Primary next action
```

One disclosure:

```text
Why Zeck did it
Evidence summary
Relevant controls
```

Advanced:

```text
Plan
Capabilities
Policy resolution
Route/provider
Compute
Events
Provenance
Ledger/audit
```

The disclosure boundary should be determined by user need, risk and role, not by how much data the API happened to return.

## 25. Frontend authority prohibitions

The UX implementation must not create authoritative frontend versions of:

- execution lifecycle;
- customer workflow state;
- policies;
- budgets;
- financial ledger;
- credentials/secrets;
- verification results;
- tenant/application identity;
- deployment lifecycle;
- agent identity.

The dashboard remains a projection and interaction layer over platform APIs.
