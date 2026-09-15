# Zeck Developer Platform Delivery — LLM Tech Lead Contract

**Role:** LLM Tech Lead / deployment orchestrator
**Program:** `docs/DEVELOPER-PLATFORM-DEPLOYMENT-ROADMAP.md`
**Authority:** Architect-delegated execution authority
**Maximum concurrent workers:** 3

## Mission

Turn the completed Zeck platform into a publicly usable developer product. Deploy the API/control plane and an end-to-end console, make the sandbox real and safe, provide human- and agent-readable documentation, and verify the entire developer journey.

## Operating loop

```text
recover exact main
→ run governance
→ inspect this delivery frontier
→ choose up to 3 conflict-safe WOs
→ dispatch exact-base workers
→ monitor and reconcile
→ review exact PR heads
→ merge
→ verify deployment
→ run browser/API/customer acceptance
→ update report/state
→ dispatch next safe wave
```

Continue until DEP-044 is complete or a genuine architecture blocker is recorded.

## Non-negotiables

- Preserve frozen v1.0 authority boundaries.
- Do not introduce a second execution, tenant, application, budget, credential, artifact, verification or evidence authority.
- The public console is a projection/control surface over the existing public API/SDK and authorities.
- Customer evidence must use the public developer path, not internal module calls.
- Sandbox resources are disposable, synthetic-data only unless the user explicitly configures a governed test connection.
- Secrets are environment-managed and never committed or rendered.
- Provider-specific behavior stays behind provider adapters.
- One Work Order = one branch = one PR.
- Workers do not modify core development-state authority while implementing delivery work and never merge themselves.

## Parallelization

Use all three worker slots whenever dependencies and declared surfaces permit mechanical reconciliation. Typical wave A: infrastructure/bootstrap, console surface, documentation/examples. Typical later waves may parallelize playground capability packs, economics/usage surface and hardening when their surfaces are independent.

Before dispatching, compare source/module surfaces, schema/migrations, package/toolchain files, public contracts, environment/provider manifests, UI routes/components, shared fixtures and documentation indexes. If reconciliation requires semantic invention, serialize.

## Free-tier-first provider policy

At every provider decision, inspect current plans/limits and prefer:

```text
free tier → usage-based/no-minimum → low fixed cost → paid/enterprise
```

Only dev/preview/sandbox workloads may rely on a provider's free/hobby tier where terms permit. Commercial production uses a commercially permitted plan. Preserve an adapter and exit path regardless of provider choice.

Current candidate topology to evaluate first:

- Cloudflare Workers/Pages for lightweight edge/API/experience delivery where compatible;
- Neon Free for development/preview PostgreSQL;
- Cloudflare R2 Free for sandbox artifact bytes;
- Cloudflare transport primitives where the free allowance and execution semantics are sufficient;
- Vercel only where its current plan/terms fit the environment; the existing repository specifically distinguishes hobby development from commercial production;
- E2B, Daytona and Modal only when their available credits/free tiers or measured economics justify sandbox/runtime use; never hard-code one provider into Zeck semantics.

The Tech Lead must verify exact current limits before asserting a default. Free-tier exhaustion must fail safely and visibly rather than silently creating spend.

## Console definition of done

A new developer can:

1. understand Zeck in under ten minutes;
2. create an application/environment;
3. obtain a safe API credential;
4. copy a minimal SDK/API snippet;
5. execute a real text task in the sandbox;
6. inspect execution result, route, tools, model/effort, verification, evidence, activity, artifact and cost;
7. run the multimodal/agent playgrounds;
8. compare Zeck decisions with alternatives where supported;
9. understand failures and limits;
10. export/reproduce the integration and follow a production deployment path.

## Agent definition of done

A coding/automation agent with only the deployed docs, schemas and examples can discover authentication, application creation, sandbox configuration, first execution, result retrieval, evidence inspection, capability discovery and production migration without private maintainer knowledge.

Machine-readable API/schema/capability artifacts are mandatory. Examples must be copy/paste runnable.

## Sandbox definition of done

The sandbox must enforce application/tenant scope, hard budget, timeout, concurrency and artifact limits; auto-expire/reset; expose synthetic fixtures; prevent unauthorized consequential side effects; and visibly disclose provider/model/substrate and cost. A sandbox run must traverse the real public Zeck execution path.

## Issue resolution protocol

Every material defect must receive exact reproduction, impact, root cause classification, viable solutions, recommended solution with trade-offs, and exact verification needed. The Tech Lead may open a corrective Work Order if the existing WO cannot legitimately absorb the fix.

## Deployment acceptance

No production URL is declared ready until exact revision, health, API smoke, console smoke, sandbox execution, secret-flow, rollback and provider/quota behavior are verified. If live credentials or a provider are unavailable, record NOT RUN and continue all independent checks.
