# Architect Directive — Zeck Gap Closure Program
Date: 2026-09-23
Base main: 338cc46c1f6081c1cbfa9de94e607982a74a159d

## Role split

**Architect:** owns architecture, gap survey, work-order authorization, conflict partitioning, acceptance gates, and final architectural adjudication.

**Tech Lead:** owns implementation orchestration and verification. Recover live main, run governance, dispatch the three workers below, review exact-base PRs, merge only accepted work, redeploy, run journey/capability validation, reconcile state, and report.

**Workers:** implement only their assigned Work Order. One branch and one PR per worker. No worker changes the architecture lock, frontier authority, or another worker's scope.

## The three workers for this wave

### Worker 1 — PPR-007
Deploy the existing experience surface to the public preview.
Scope is exactly the existing PPR-007 Work Order.
Conflict ownership:
- apps/dashboard/index.ts
- new experience entry
- vercel.json
- deploy/build-vercel-output.ts
Shared documents only additive updates.

Required outcome:
- root landing and /console/*, /trust/*, /admin/* are reachable on the preview;
- honest unbound mode remains honest;
- no fake data is introduced.

### Worker 2 — PPR-008
Bind preview credentials and the deterministic sandbox substrate.
Scope is exactly the existing PPR-008 Work Order.
Conflict ownership:
- deploy/api.ts
- new authority-materialization files
- deterministic substrate files
Shared documents only additive updates.

Required outcome:
- bearer authentication, SQL scope resolution, credential lifecycle, execution service and agent inventory are materially wired;
- created sandbox executions have a repository-resident deterministic substrate and honest terminal receipt;
- every unmaterialized dependency remains honestly unbound.

### Worker 3 — PPR-009
Integrate LiveKit as a replaceable realtime/WebRTC rail.
Conflict ownership:
- deployments realtime adapter/port/test surfaces only;
- no edits to Worker 1 or Worker 2 owned files;
- no permanent provider critical path;
- no LiveKit fork.

Required outcome:
- provider-neutral RealtimeRail adapter;
- provider-neutral short-lived client-access seam;
- provider credentials stay behind connections/secret mediation;
- room/participant identifiers are opaque/non-PII;
- LiveKit types stay inside adapters;
- deterministic fake-client conformance tests;
- current realtime voice status remains NOT RUN until credentialed external evidence exists.

## Shared architectural gates

All three workers:
1. preserve the frozen authority chain:
   Tenant/Application Identity -> Policy -> Capabilities -> Budget/Economics -> Planning -> Execution -> Sandbox/Substrate -> Verification -> Evidence -> Learning;
2. do not create a competing authority;
3. keep providers behind ports/adapters;
4. do not put secrets, vendor identifiers, raw media, or provider SDK types in frozen domain contracts;
5. preserve idempotency, tenant isolation, fail-closed behavior and evidence;
6. do not rewrite historical validation evidence;
7. do not self-merge;
8. do not widen scope because a dependency appears convenient.

## Tech Lead operating loop

recover live main
-> governance
-> read current frontier + PPR-007 + PPR-008 + PPR-009
-> verify conflict partition
-> dispatch exactly these three workers from the same current main
-> review each exact head
-> merge accepted PRs
-> rerun governance/tests
-> redeploy
-> run the existing ten-step experience journey, 22-family disclosure checks and seven credentialed journey checks
-> run LiveKit adapter/conformance tests
-> record evidence and availability states
-> reconcile frontier only after all gates pass.

A worker failure does not block independent workers. Never merge around a failed security/architecture gate.

## Next wave guidance

After PPR-007..009 are verified, the Architect should authorize the next three from the gap ledger, with MCP and A2A as first-class interoperability candidates and browser/computer-use as the next high-value execution substrate.

No new authority should be created for those integrations. MCP is for tools/resources; A2A is for peer-agent communication; both should map external identifiers to opaque Zeck references while Zeck retains execution, policy, capability, budget and evidence authority.
