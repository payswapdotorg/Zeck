# compat/harness — the cross-application compatibility proof harness (PPR-018A)

The ONE reusable runner, baseline, measurement and Demo Mirror activation harness
for the Zeck Application Compatibility Proof Program (ACR-006 + ACR-007). Every
application work order **PPR-018..PPR-027** plugs its pinned integration into
THIS harness instead of adding its own proof framework.

The harness adds **no provider selection, retry routing, budget accounting,
verification or optimization logic** — the application adapter you register is
an ACR-007 translation boundary
(`application task/context → Zeck task + constraints + references → Zeck
execution → result/evidence → application result`) and nothing more.

## The pieces

| File | What it is |
|---|---|
| `runtime.ts` | `definePinnedRuntime(...)` — the driver factory a work order implements once per pinned application/integration pair. Validates the registration fail-closed. |
| `credential-erasure.ts` | The provider-credential erasure tooling: the reusable env-var NAME list, the scrubbed-environment builder (allowlist-only, refuses credential names) and the erasure audit (ACR-007 §5). |
| `egress-control.ts` | The Zeck-only egress control: default-deny with an explicit allowlist (Zeck endpoint + loopback), provider-class patterns as observation labels. A provider edge hidden behind a proxy or an unknown host is still denied. |
| `corpus-runner.ts` | `runCorpus(...)` — starts ONE exact pinned session (refusing unpinned execution), audits erasure, executes every corpus task, correlates every delegated edge through the read-only executions trace source, derives the run-level outcomes (PASS / NOT-RUN / BLOCKED / FAIL / BYPASS_DETECTED) and the aggregated egress observation. |
| `baseline-runner.ts` | `captureBaseline(...)` — the direct-baseline and strong-optimized-non-Zeck-baseline hooks over the same corpus. Baseline records are structurally NOT Zeck evidence; the only bridge into an evidence record is the labeled `ComparisonFact`. |
| `measurement.ts` | `measurementSetOf(...)` — the thirteen-dimension measurement schema (outcome success; quality/verification; latency + tail; usage/cost; failure/retry; determinism/reuse; provider portability; customization coverage; engineering surface removed; capability-discovery avoidance; telemetry/explainability; diagnosis/recovery; reproducibility), with honest not-measured entries for what a run cannot measure. |
| `evidence-assembly.ts` | `evidenceRecordDraftOf(...)` + `writeEvidenceRecordFile(...)` — turn the corpus run report into a structurally valid `CompatibilityEvidenceRecord` (live-proof basis) and persist it fail-closed. |

The contracts these compose live in the platform's compatibility layer:
`src/integrations/compatibility/public` (the PPR-017 foundation — domain types,
the strict admission machine, ports and the demo registry). Import from there;
never from the layer's internals.

## How a work order (PPR-020..027) plugs in — the runbook

You have NO proof framework of your own to build. You implement the
application side and compose the harness pieces:

### 1. Pin and inventory

- Pin the exact upstream application revision and the exact Zeck integration
  revision (your branch HEAD at proof time).
- Inventory every material AI execution edge; declare it as an
  `ApplicationExecutionGraph` (`validateExecutionGraph` fails closed).
- Produce a discovered edge inventory and reconcile it
  (`reconcileExecutionGraph`) — a missing inventory or an undeclared edge alone
  forbids `AI_EXECUTION_COMPLETE`.

### 2. Implement the driver (the ONE application-side surface)

```ts
import { definePinnedRuntime } from "../../harness/runtime"; // from compat/<app>/
// …compose your pinned application runtime, your Zeck-boundary adapter
// (SDK over HTTP or the in-process API composition) and your certified
// proof environment (the scrubbed env + the egress control below)…

export const driver = definePinnedRuntime({
  runtimeId: "compat/<app>",            // the Demo Mirror binding names this
  identity: { name, repository, applicationId },
  pin: { upstreamRevision, integrationRevision },
  start: async (context) => { /* start ONE exact session */ },
});
```

`start` must:
- verify the expected binding you were handed (`context.expectedApplicationId`
  + `context.expectedPin` — the harness re-verifies what you started);
- build the runtime environment with
  `buildScrubbedRuntimeEnvironment({ applicationExtras, source, overrides })`
  (allowlist-only; a credential name in an override throws);
- wrap the runtime's outbound transport with
  `createZeckOnlyEgressControl({ zeckApiBaseUrl, mode: "deny", fetchImpl, now })`;
- report `environmentFacts` (env-var names + presence —
  `auditCredentialErasure` over your environment produces them);
- implement `executeTask(task)` by translating the task through the ACR-007
  boundary and returning the per-edge execution observations (the Zeck
  execution ids your adapter created, with latency/usage when known) plus your
  task's own mechanical success check result.

### 3. Run the corpus

```ts
const report = await runCorpus({
  driver,
  expected: expectedBindingOf(recordDraftInputs), // the record's pins
  corpus,                    // your representative tasks
  traceSource,               // createExecutionsServiceTraceSource in-process,
                             // or the SDK wire reads out-of-process
  now: () => new Date().toISOString(),
});
```

The runner refuses unpinned execution, audits erasure, correlates every
delegated execution and derives the honest run outcomes.

### 4. Capture BOTH baselines

```ts
const direct = await captureBaseline({
  kind: "direct-baseline",
  executor: { stack, methodology, executeTask },  // your non-Zeck direct stack
  corpus, now,
});
const optimized = await captureBaseline({
  kind: "optimized-baseline",
  executor: strongOptimizedExecutor,              // never a strawman
  corpus, now,
});
```

### 5. Measure and assemble

```ts
const measurements = measurementSetOf(report);      // all thirteen dimensions
const record = evidenceRecordDraftOf({
  recordId: "ppr-0NN-<app>-live-proof",
  pinnedApplication, graph, report,
  baselines: [direct, optimized],
  limitations, notRunCauses,
});
writeEvidenceRecordFile("deploy/evidence/<recordId>.json", record);
```

Assess with `createCompatibilityService().assess(record, inventory)` — the
status is derived, never asserted. Certification is the Lead's gate; a
fixture-basis run can never certify.

### 6. Bind the demo (the Lead binds it at merge)

Ship `compat/<app>/demo/demo-entry.json`:

```json
{
  "demoId": "<app>",
  "evidenceRecordId": "ppr-0NN-<app>-live-proof",
  "representativeTask": { "title": "…", "description": "…" },
  "runBinding": { "kind": "pinned-runtime", "runtime": "compat/<app>" },
  "reproducibility": {
    "instructions": "…",
    "pinnedUpstreamRevision": "…",
    "integrationRevision": "…"
  },
  "warnings": []
}
```

The Demo Mirror discovers the entry file and the record (from
`deploy/evidence/`) automatically; the entry runs only when the bound record
DERIVES `AI_EXECUTION_COMPLETE` **and** the deployment composition registered
your driver (`createRuntimeRegistry({ drivers: [driver] })` +
`createDemoRunService({ registry, traceSource, credentialEnvVarNames, now })`
wired into the demo run executor seam — a worker never activates their own
demo; the Lead binds it at merge).

## The five impossibilities (pinned by tests, enforced structurally)

1. **A demo run without `AI_EXECUTION_COMPLETE`** — the demo-run service
   authorizes on the DERIVED status only; fixture records can never derive it.
2. **A direct provider edge hidden by a proxy** — the Zeck-only allowlist
   denies every host that is not explicitly allowed (the proxy included); the
   erasure gate refuses a credential-bearing runtime (a reverse proxy alone is
   not sufficient — ACR-007 §5).
3. **Missing Zeck trace correlation** — every delegated execution must read
   back through the executions public surface with durable evidence; a miss is
   a named rule-4 defect, never a fabricated fact.
4. **Unpinned application execution** — the runner and the demo-run service
   verify the driver's pins AND the started session's descriptor against the
   bound record's pins, exactly, or refuse.
5. **Baseline facts presented as Zeck facts** — baseline records cannot carry
   Zeck fields; the only bridge is the labeled `ComparisonFact`; the
   presentation guard fails closed.

## Boundaries (binding)

No new authority. No new optimizer. No second execution lifecycle. No
capability-manifest rewriting. No provider SDKs in domain/public compatibility
contracts. No application source fork required by the harness. No hidden
credential fallback. No marketing claim derived from scenario data. Fixtures
may exercise this harness but can never produce `AI_EXECUTION_COMPLETE`.
