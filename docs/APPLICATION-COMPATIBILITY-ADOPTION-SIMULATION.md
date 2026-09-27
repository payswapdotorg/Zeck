# Application Compatibility — Developer Adoption Simulation

Date: 2026-09-27
Type: scenario simulation, not a market forecast

## Question

Assume the architecture upgrades in ACR-006 and ACR-007 are fully implemented, all currently known capability gaps are closed, every target application has a maintained Zeck integration, and each integration can honestly reach AI_EXECUTION_COMPLETE.

How many developer teams would prefer making Zeck their default AI execution authority rather than continuing to own the application's direct AI-provider execution stack as the application, model portfolio and user base grow?

Use 100 hypothetical developer teams per application. Preference means the team would choose Zeck as the default execution authority after sustained exposure; it does not mean migration happens automatically.

## Central-case assumptions

The scenario assumes:

- Zeck preserves required provider/model/tool/substrate functionality.
- The Zeck integration adds a bounded gateway hop and does not materially degrade tail latency.
- Zeck optimizes successful-outcome cost rather than raw model-token cost.
- Deterministic computation, cache/reuse, verified competence, programmatic execution and parallelism are available when the constraints permit them.
- Provider failures and credentials are governed by Zeck rather than scattered across the application.
- Application-specific prompts, tools, policies, budgets, local/BYOK endpoints and domain context remain customizable.
- Zeck telemetry can reconstruct each governed execution.
- Developers can discover existing Zeck capabilities and reuse them rather than implementing a new provider integration for every new feature.
- Switching away from a provider through Zeck does not require rewriting the application.
- No application-domain state is moved into Zeck.

These assumptions are deliberately stronger than today's implementation because this is a future-state simulation.

## Modeled preference by application and maturity

| Application | Category | Early / low traffic | Growing / multi-provider | Mature / many users + modalities |
|---|---|---:|---:|---:|
| Aider | Coding assistant | 58% | 69% | 80% |
| Cline | IDE agent | 59% | 71% | 82% |
| OpenHands | Software-engineering agent | 61% | 73% | 85% |
| Continue | IDE/model platform | 52% | 63% | 74% |
| Hermes-Agent | General/autonomous agent | 62% | 75% | 86% |
| OpenClaw | Broad general agent | 54% | 66% | 78% |
| Browser Use | Browser agent | 50% | 60% | 72% |
| Open WebUI | General AI UI | 51% | 64% | 75% |
| AnythingLLM | RAG/knowledge application | 48% | 58% | 69% |

For a hypothetical 900-team cohort, the central-case preference averages approximately 55% in the early stage, 66% in the growing stage and 78% in the mature stage.

The mechanism is compounding operational complexity, not a claim that large teams inherently prefer infrastructure centralization.

## Why the preference can rise with scale

### 1. Performance

At small scale, a direct SDK call can be difficult to beat because it removes an extra hop.

At larger scale, Zeck has more opportunities to optimize the complete successful outcome:

direct model call
→ cache/reuse
→ deterministic computation
→ verified competence/tool
→ batching/parallelism
→ model selection
→ retry/escalation
→ substrate selection

The relevant metric is end-to-end successful-outcome latency and cost, including failures and retries.

A useful measurement is:

successful-outcome latency = time from application intent to verified acceptable result

rather than raw model response time.

### 2. Cost over time

The developer does not only pay the provider invoice. The application also pays engineering and operational cost for:

- provider SDK maintenance;
- model catalog changes;
- fallback chains;
- rate-limit handling;
- credential management;
- usage accounting;
- failure diagnosis;
- provider migration;
- duplicate work;
- bespoke caching and reuse;
- verification plumbing.

The simulation therefore treats cost as:

total cost of successfully resolved outcomes = infrastructure + provider + execution + verification + engineering overhead

Zeck becomes more valuable when the common execution layer can amortize those costs across many applications and workloads.

### 3. Customization

A plausible anti-Zeck failure mode is loss of application-specific control.

The scenario assumes Zeck preserves:

- custom prompts and context;
- explicit model/capability requirements;
- tool choices;
- budgets;
- latency/quality constraints;
- policy constraints;
- BYOK and customer-local endpoints where supported;
- application-specific verification requirements.

A team should not have to accept a generic black-box route.

### 4. Determinism and reuse

As users repeat the same jobs, Zeck can learn that some work should not invoke a generative model again.

Examples:

- deterministic parsing;
- schema validation;
- cached retrieval;
- reusable procedures;
- verified program execution;
- duplicate-work coalescing.

Measure the percentage of successful outcomes resolved without a fresh expensive model pass.

### 5. Capability discovery

This is a major part of the thesis.

A developer may ask:

"How do I add image generation?"

and discover that Zeck already exposes the capability and can govern its provider, budget, verification and telemetry.

Or:

"How do I add browser execution?"

and discover an existing governed tool/substrate path.

The relevant metric is:

avoided bespoke feature implementation = capabilities adopted from Zeck - capabilities independently implemented

This must be measured from actual developer actions, not inferred from the existence of a catalog.

### 6. Telemetry and execution explainability

As applications grow, developers increasingly need answers to:

- Which plan ran?
- Which capability was required?
- Which provider/model/substrate was selected?
- How much did it cost?
- Why did it retry?
- Was work reused?
- What verification passed?
- What failed?
- Can the exact execution be reproduced?

The simulation assumes Zeck makes those questions answerable from one execution evidence chain.

A practical metric is:

execution-explanation completeness = executions with reconstructible plan + route + usage/cost + verification + outcome / all governed executions

### 7. Provider portability

A direct integration often makes the provider a code-level concern.

A Zeck integration should turn provider changes into a policy/capability/configuration problem whenever the required capability remains available.

Measure:

- time-to-add-provider;
- time-to-switch-provider;
- changed application lines/modules;
- regression count after provider migration.

### 8. Reliability and incident recovery

As the number of providers and AI-backed features rises, the application accumulates distinct outage and retry states.

Zeck can centralize:

- normalized provider failures;
- idempotency;
- retries;
- failover;
- recovery;
- verification;
- evidence.

Measure:

- failure-adjusted success rate;
- duplicate side-effect rate;
- incident diagnosis time;
- recovery time;
- percentage of incidents reconstructible from the Zeck execution record.

## Adoption friction

The simulation also gives direct ownership reasons that can keep teams on their existing stack:

- migration effort;
- Zeck latency overhead;
- missing provider-specific features;
- local/offline requirements;
- compliance/data-residency constraints;
- insufficient execution customization;
- uncertainty about Zeck reliability at very high volume;
- existing sunk investment in application-specific infrastructure;
- fear of creating a new platform dependency.

A realistic adoption experiment must measure these reasons rather than assuming Zeck wins them.

## Sensitivity bands

Under different assumptions, the mature-stage preference moves materially.

| Scenario | Mature-stage preference band across the portfolio |
|---|---:|
| Zeck adds noticeable latency/cost and misses specialized features | 45–60% |
| Zeck is roughly cost-neutral with strong telemetry/portability | 60–72% |
| Zeck reduces successful-outcome cost and preserves performance/customization | 70–85% |
| Zeck also materially increases deterministic/reuse resolution and feature discovery | 75–90% |

These are model bands, not forecasts.

## A better empirical test than the simulation

PPR-027 should recruit or observe real developers using both stacks over representative workloads.

For each application, capture:

1. direct baseline period;
2. Zeck exposure period;
3. comparable task corpus;
4. provider/model portfolio;
5. workload volume;
6. modality count;
7. quality and reliability constraints;
8. cost;
9. latency;
10. deterministic/reuse rate;
11. portability effort;
12. customization coverage;
13. telemetry coverage;
14. incident diagnosis/recovery;
15. feature-discovery events;
16. migration effort;
17. final developer choice.

Preference should be measured after the team has experienced both systems and the same workload can be reproduced.

## Popularity context

Current GitHub repository size confirms that several targets have substantial developer ecosystems, but GitHub stars are not adoption counts and must not be used as proxy users in the experiment.

Examples checked for the target portfolio include OpenClaw, Hermes-Agent, OpenHands, Cline, Aider, Continue, Browser Use, Open WebUI and AnythingLLM. The current repositories are actively maintained and range from tens of thousands to hundreds of thousands of stars, making them useful compatibility stress cases rather than representative samples of all AI applications.

Sources checked:
- https://github.com/openclaw/openclaw
- https://github.com/NousResearch/hermes-agent
- https://github.com/OpenHands/OpenHands
- https://github.com/cline/cline
- https://github.com/Aider-AI/aider
- https://github.com/continuedev/continue
- https://github.com/browser-use/browser-use
- https://github.com/open-webui/open-webui
- https://github.com/Mintplex-Labs/anything-llm

## What would falsify the thesis

The thesis is weakened if repeated proofs show that Zeck:

- materially increases end-to-end latency;
- costs more for comparable verified outcomes;
- removes necessary provider-specific customization;
- cannot cover common execution surfaces;
- makes local/private execution materially harder;
- provides less useful telemetry;
- creates a provider-dependency of its own;
- cannot preserve direct-application performance at scale;
- requires developers to reproduce Zeck internals;
- or repeatedly needs completeness to be redefined to pass application demos.

Such findings are evidence, not failures of marketing.

## Decision rule

Do not treat the central percentages as a target to defend.

The target of the program is to measure whether real developers switch after they have experienced the actual trade-offs.

The strongest possible outcome is not a high simulated preference percentage. It is a reproducible portfolio of applications for which direct AI-provider infrastructure can be removed and the developers can demonstrate why Zeck is preferable for their actual workloads.
