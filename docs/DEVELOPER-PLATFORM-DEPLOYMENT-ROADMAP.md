# Zeck Developer Platform Deployment Roadmap

**Status:** ARCHITECT-APPROVED DELIVERY PROGRAM
**Scope:** public deployment, end-to-end developer console, sandbox playground, complete rerunnable validation library, agent-readable documentation, onboarding examples and free-tier-first operations.
**Authority:** Architect / LLM Tech Lead
**Max concurrent workers:** 3

## Objective

Turn the completed Zeck platform into a usable public developer platform: a developer can discover Zeck, create or configure an application, obtain safe credentials, copy a minimal SDK/API integration, run a real execution in a disposable sandbox, inspect the full execution/evidence/cost path, rerun Zeck's executed validation experiments, and understand how to move from sandbox to production without reading internal implementation code.

The console is a projection/control surface over Zeck's existing authorities. It must not create a second execution, budget, capability, tenant, credential, artifact, validation authority or verification authority.

## User journeys

1. **Explore:** landing → concepts → examples → capability catalog.
2. **Create:** sign in → application → sandbox environment → API credentials.
3. **Integrate:** copy SDK/API snippet → run first execution → see outcome.
4. **Inspect:** execution → route/model/tool/agent/substrate → evidence → costs → events.
5. **Experiment:** choose workload → edit input/constraints → execute → compare strategies.
6. **Validation Lab:** choose any executed validation item → inspect original evidence → replay/rerun → compare → export reproduction bundle.
7. **Sandbox:** use disposable providers/resources, hard budgets, synthetic data and auto-expiration.
8. **Production:** follow documented promotion path, secrets, environment isolation, quotas and deployment checks.

## Console information architecture

```text
Home
├── Quickstart
├── Applications
│   ├── Overview
│   ├── API Keys / Credentials
│   ├── Environments
│   └── Usage
├── Playground
│   ├── Text
│   ├── Structured
│   ├── RAG
│   ├── Tools
│   ├── Agents / workflows
│   ├── Voice
│   ├── Image
│   ├── Video
│   ├── Vision / VLM / audio
│   ├── 3D
│   ├── Browser / computer use
│   └── Human review
├── Validation Lab
│   ├── All executed validations
│   ├── By capability
│   ├── By validation stage
│   ├── Recommended experiments
│   ├── Replay / rerun
│   ├── Compare
│   └── Agent / machine API
├── Executions
├── Evidence
├── Artifacts
├── Costs / Economics
├── Providers / Capabilities
├── Docs
└── Settings
```

## Delivery sequence

### Phase P0 — deployment foundation

- **DEP-001** — Public deployment bootstrap and free-tier-first provider topology.
- **DEP-002** — Environment, secret and sandbox-account provisioning automation.
- **DEP-003** — Production smoke, health, spend/quota guardrails and deployment identity.

### Phase P1 — developer console

- **DEP-010** — Console application shell, authentication and application/environment lifecycle.
- **DEP-011** — Credentials/API-key UX and safe connection management.
- **DEP-012** — Complete execution explorer: result, evidence, activity, route, tools, models, agents, verification, costs and provenance.
- **DEP-013** — Interactive sandbox playground covering every supported workload class.
- **DEP-014** — Sandbox budgets, quotas, expiration, reset and safe synthetic-data policy.
- **DEP-025** — Complete Validation Lab: expose every executed VAL-001..VAL-052 definition, historical evidence and safe rerun/compare/export paths.

### Phase P2 — developer and agent onboarding

- **DEP-020** — Complete quickstart and public API/SDK documentation.
- **DEP-021** — Copyable integration examples for every workload class.
- **DEP-022** — Agent-readable machine documentation, schemas, capability catalog and integration recipes.
- **DEP-023** — Troubleshooting, failure taxonomy, limits and solution playbook.

### Phase P3 — developer-product completeness

- **DEP-030** — Usage, economics and optimization dashboard.
- **DEP-031** — Playground compare mode: baseline vs Zeck strategy and execution explanation.
- **DEP-032** — Project export, reproducibility bundle and self-host/deployment handoff.
- **DEP-033** — Accessibility, responsive behavior, security and cross-browser hardening.

### Phase P4 — deployment acceptance

- **DEP-040** — End-to-end public deployment validation. *(status: delivered on `work/DEP-040-deployment-validation` at base 34e80bf — the e2e driver `deploy/e2e-validate.ts` + `deploy/evidence/dep-040.json`; awaiting the Lead's review/merge; the live-provider rails stay the Lead's credentialed re-run per the recorded boundary)*
- **DEP-041** — Fresh-developer integration trial.
- **DEP-042** — Fresh-agent integration trial.
- **DEP-043** — Production readiness, rollback and provider-exit drill.
- **DEP-044** — Final deployment report and release gate.

## Validation Library requirements

`DEP-025` is a first-class console surface, not a collection of demos.

The authoritative source is the executed validation program under `docs/VALIDATION-ROADMAP.md`, `spec/validation-work-orders/`, `spec/validation-state/`, `benchmarks/validation/` and the cumulative validation report. The console must project these sources rather than create hand-maintained duplicated definitions.

All completed validation items must be discoverable, including items that historically completed with FAILED rows, expected-failure rows, ties, regression findings or honest NOT RUN boundaries. Historical evidence is immutable/read-only.

Every validation definition must expose its objective, what it proves, capability/workload, corpus/fixture identity, environment requirements, expected and forbidden outcomes, quality/safety/economic metrics, required provider/model access, original exact revision, original evidence, current availability, cost controls and rerun instructions.

Rerun modes:

```text
EXACT REPLAY
  same validation definition + pinned inputs/configuration where available

CURRENT RERUN
  same validation definition against the current sandbox/platform

MODIFIED RUN
  allowed user changes, preserving lineage to the original definition

COMPARE
  multiple runs + original evidence + applicable baseline/competition arms
```

Every rerun gets a new immutable run identity. Reruns never overwrite historical evidence.

## Agent-readable Validation API

A coding/automation agent must be able to:

```text
list validations
→ inspect validation schema
→ inspect requirements/access
→ estimate cost
→ launch safe rerun
→ poll/stream execution
→ retrieve outcome/trace/environment/evidence/cost
→ compare runs
→ export reproduction bundle
```

The same catalog must power the human console and machine interface to prevent documentation drift.

## Sandbox requirements

The public playground and Validation Lab must run real Zeck executions against isolated synthetic data. They must support hard per-run and per-application spend limits, timeouts, concurrency limits, artifact size limits, provider allowlists, automatic expiry and reset.

The sandbox must expose enough of the real customer path to be meaningful, while making consequential real-world side effects impossible unless the user explicitly provisions a governed test connection.

## Free-tier-first deployment doctrine

Provider selection must optimize for zero/low fixed cost during exploration, while preserving provider-neutral ports and a clean upgrade/exit path.

Preferred order:

1. provider free tier;
2. provider usage-based/no-minimum tier;
3. low fixed-cost managed tier;
4. paid/enterprise only where required by security, scale, capability or commercial terms.

Candidate defaults must be verified at dispatch time. Current repository evidence already uses Vercel for experience delivery, Neon for PostgreSQL, Cloudflare R2 for artifact bytes and Cloudflare transport primitives. Vercel Hobby is restricted to permitted personal/non-commercial use in the existing repository contract; commercial production must use a commercially permitted plan or replacement host. Cloudflare Workers Free, R2 free allowances and Neon Free should be evaluated first for appropriate disposable/dev workloads; exact current limits and terms are operational constraints, not architecture.

The Tech Lead must measure free-tier limits, quota exhaustion behavior and expected sandbox cost before declaring a provider the default. Disposable free-tier resources must never become operationally critical.

## Documentation requirements

Every capability shown in the console must have:

- one-sentence explanation;
- conceptual model;
- minimal API example;
- SDK example where available;
- request/response schemas;
- expected execution lifecycle;
- security and policy notes;
- cost/latency considerations;
- common failures and remedies;
- links to the corresponding public contract.

Docs must be readable by both humans and coding agents. Machine-readable OpenAPI/schema/capability artifacts are first-class deliverables.

## Agent usability

A coding agent must be able to discover Zeck without chat with a maintainer. The repository and deployed docs must expose stable paths for authentication, application creation, sandbox configuration, first execution, result retrieval, evidence inspection, validation listing/rerun, tool/model configuration and production migration.

Examples should be copy/paste runnable and avoid hidden assumptions.

## Required reporting

Every delivery WO must record exact deployment revision, environment, providers, free-tier assumptions, checks executed, live integrations available/unavailable, cost consumed, defects, root causes, viable solutions, recommended solution and trade-offs.

The cumulative report must separate Zeck defects, console defects, validation-harness defects, application-example defects, provider limitations, missing credentials and environmental failures.

## Completion gate

DEP-044 passes only when a fresh developer can integrate Zeck through the public surface, create a sandbox execution, exercise the supported capability portfolio, open and rerun the complete executed validation library, inspect evidence/costs, follow the docs without maintainer intervention, and reproduce the deployment from repository-defined configuration. Free-tier use must be maximized wherever it does not violate safety, commercial terms or required runtime capability.
