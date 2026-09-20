# Zeck — Post-Release Public Productization & Deployment Plan

**Status:** ARCHITECT-AUTHORIZED FOLLOW-ON PROGRAM  
**Program:** `zeck-post-release-public-productization`  
**Baseline main:** `faa024247546e61d6e52465b1929188230f0feb6`  
**Max concurrent workers:** 3

## Purpose

The core implementation, validation program, and original Developer Platform roadmap are complete. The remaining product task is to turn that completed system into a genuinely reachable, understandable public product.

This program combines:

1. public preview deployment;
2. user-first discoverability improvements;
3. a repeatable public user-journey acceptance harness.

## Frozen architecture

```
Tenant / Application Identity
        ↓
Policy
        ↓
Capabilities
        ↓
Budget / Economics
        ↓
Planning
        ↓
Execution
        ↓
Sandbox / Substrate
        ↓
Verification
        ↓
Evidence
        ↓
Learning
```

There remains one optimization authority: **Execution Compiler**.

No post-release work may create a second execution, capability, budget, validation, verification, evidence, tenant/application, or provider authority.

## User-journey simulation findings

The pre-deployment simulation used the actual Zeck console source, machine manifests, Validation Lab, compare/export surfaces, deployment runbook, and the live ShareNet Conformance reference. It is explicitly a **repository-backed simulation**, not a live Zeck browser test, because no public Zeck URL was verified at the time.

| Journey | Current state | Learning | Implementation response |
|---|---|---|---|
| Discover Zeck | Partial | Home is outcome-oriented, but the IA quickly exposes internal concepts | Discovery-first home |
| First safe execution | Partial | Application/environment knowledge appears before first value | Guided disposable sandbox start |
| Discover capabilities | Partial | All 22 workload families exist, but discovery is buried in Develop/Playground | First-class capability catalog |
| Inspect execution | Strong | Explorer already exposes result, evidence, route, verification, provenance and costs | Make “How Zeck did it” the normal result hierarchy |
| Validation Lab | Strong | Rerun/evidence architecture is already mature | Promote Validation Lab into the main discovery path |
| Compare/economics | Strong | Compare, usage and export exist but are not central to first-run flow | Link from results/discovery |
| Trust/limits | Partial | Policy, spend, sandbox and verification are distributed | Add consolidated Trust & Limits entry |
| Agent onboarding | Strong / discoverability gap | Machine docs are good but not obvious to newcomers | First-class “For agents” entry |
| Sandbox safety | Strong | Quotas, identity, expiry/reset and synthetic-data policy exist | Surface safety envelope before running |
| Production path | Partial | Runbooks exist, but no verified public instance exists | Deployment Center |
| Mobile | Strong foundation | Existing responsive/a11y work can become simpler and calmer | ShareNet-inspired mobile hierarchy |
| Failure/unavailable states | Strong | Honest NOT RUN/provider-gated behavior is a product strength | Surface availability earlier |

## Target user path

```
Understand
   ↓
Choose capability
   ↓
Try safely
   ↓
See result
   ↓
Understand how Zeck did it
   ↓
Validate
   ↓
Compare / Reproduce
   ↓
Integrate
   ↓
Deploy
```

## ShareNet-inspired design direction

Reference:
- https://sharenet-conformance.vercel.app
- https://github.com/pectoraux/ShareNet

Adopt the interaction grammar:
- generous whitespace;
- calm neutral surfaces;
- one dominant primary action;
- state/outcome-first hierarchy;
- quiet persistent navigation;
- clear active navigation;
- desktop sidebar;
- mobile bottom navigation/compact header;
- progressive disclosure;
- restrained semantic status color;
- reduced-motion support.

Do **not** copy branding, assets, copy, or ShareNet domain semantics.

## Work Order graph

```
PPR-001 ──┐
          ├──► public journey verification ──► corrective WOs if evidence requires
PPR-002 ──┤
          │
PPR-003 ──┘
```

### PPR-001
Discovery-first console and ShareNet-inspired visual refinement.

### PPR-002
Live free-tier-first public preview deployment.

### PPR-003
Public user-journey simulation and acceptance harness.

## PPR-001 required changes

- discovery-first home;
- capability catalog covering all 22 workload families;
- guided safe sandbox start;
- prominent Validation Lab;
- “How Zeck did it” result explanation;
- Trust & Limits entry;
- obvious developer/agent entry points;
- visible Available / Provider-gated / Requires access / NOT RUN states;
- calmer ShareNet-inspired responsive visual hierarchy.

All facts must continue to come from existing public API/repository machine manifests. No second authority.

## PPR-002 deployment plan

### Preview topology

| Concern | Target | Role |
|---|---|---|
| Experience delivery | Vercel Hobby where permitted | delivery |
| Relational state | Neon Free | authoritative PostgreSQL |
| Artifact bytes | Cloudflare R2 Free | non-authoritative bytes |
| Async transport | Cloudflare Queues Free allowance | transport |
| Durable orchestration | Cloudflare Workflows Free allowance | orchestration |
| Coordination | Upstash Redis Free | non-authoritative |
| Execution | self-hosted/governed Zeck runner | isolated substrate |
| Observability | self-hosted or usage-based OTLP | non-authoritative |

Current public provider documentation supports these starting points:
- Vercel Hobby is $0 and for personal/non-commercial use; commercial production needs a permitted paid plan. citeturn606528search9
- Neon Free currently includes 100 projects, 100 CU-hours, 0.5 GB database storage and 10 branches per project. citeturn638571search2turn638571search3
- Cloudflare Workers Free currently provides 100,000 requests/day and 10 ms CPU per invocation. citeturn606528search1
- R2 Free currently includes 10 GB-month storage, 1M Class A and 10M Class B operations, with free egress. citeturn606528search2
- Queues is available on Workers Free with 10,000 operations/day; free retention is 24 hours. citeturn606528search4turn606528search8
- Workflows is included on Workers Free with documented free allowances including 100,000 requests/day, 3,000 steps/day and 1 GB-month storage. citeturn606528search5
- Upstash Redis Free currently provides 256 MB, 10 GB monthly bandwidth and 500K monthly commands. citeturn606528search3

The current repository provider ledger is older and explicitly **recorded-not-live-verified**. PPR-002 must refresh it before provisioning.

### Provisioning order

```
current main
→ account/credential preflight
→ provider-tier fact reconciliation
→ Neon + migrations
→ R2
→ Queues / Workflows
→ Upstash
→ governed runner
→ Vercel delivery
→ /identity
→ /health
→ public smoke
→ sandbox first-run
→ validation rerun
→ browser journey acceptance
```

### Commercial boundary

```
free preview / sandbox
        ≠
commercial production
```

Vercel Hobby must not be used for commercial production. Move to a permitted paid plan or alternate host when commercial production begins.

## PPR-003 journey set

Run against the actual deployed URL:

1. discover;
2. capability discovery;
3. sandbox start;
4. first text execution;
5. inspect execution;
6. inspect evidence/cost;
7. validation rerun;
8. compare;
9. export/reproduce;
10. trust/limits;
11. agent onboarding;
12. production/deployment path.

Run desktop/tablet/mobile and keyboard/accessibility variants.

Map all 22 workload families to a visible location and honest availability state.

## Acceptance gates

- public URL reachable;
- exact revision attested;
- /health verified;
- /identity verified;
- first sandbox execution works;
- all 22 capability families discoverable;
- executed validations discoverable and safely rerunnable where access permits;
- execution/evidence/cost inspection reachable;
- compare/reproduce reachable;
- agent integration discoverable;
- provider/free-tier state is truthful;
- no silent paid overage;
- rollback/repoint remains verified;
- handoff and continuation artifacts are current.

## Worker policy

Maximum 3 concurrent workers.

One Work Order = one branch = one PR.

Workers implement exact Work Orders, never merge themselves, never rewrite historical evidence, and never introduce new authorities.

Material issues must record reproduction, impact, root cause, viable solutions, recommended solution/trade-offs, and verification.

