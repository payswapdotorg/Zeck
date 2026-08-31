# Benchmark harness (WORK-016)

The benchmark harness compares **execution strategies** on representative
governed tasks using the **same execution and evidence contract**.

## Authority model

**Benchmark = measurement, never authority.** The harness and its reports
are evidence records only. A benchmark run cannot authorize providers,
change policy, change budgets, promote an agent, mutate routing, mark an
execution verified outside the canonical governed completion path, or
mutate WorkflowOS state. The harness surface holds no such call (an
architecture gate proves it), and the report is a pure projection with no
callbacks.

## The compared strategies (fair comparison)

| Strategy | Entry seam | Agent participant |
|---|---|---|
| `native-agent-session` | execution create + agents session-service admission chain | native local runtime provider |
| `byoa-agent-session` | execution create + the SAME admission chain | external agent wrapped through the WORK-016 BYOA adapter (`createByoaAgentProvider`) |
| `workflowos-submission` | the WORK-016 WorkflowOS submission contract | none (external submission) |

All three strategies:

- create executions through the **same injected executions authority**
  (the same policy admission, idempotency arbitration and durable
  identity);
- drive the **same canonical lifecycle**
  (`authorize → plan → queue → start → verify → pass` with durable
  verification results — the only completion path in the platform);
- leave evidence on the **same durable ledger** the harness re-reads
  through the authority's public reads (never trusting strategy
  self-reports).

Agent registration (setup) happens through the canonical WORK-011
registry path **before** any measurement; the harness only measures.

## Measured dimensions

success (terminal status), verification outcome (recorded results), cost
(settled ledger facts — `null` when unset, never fabricated), latency
(harness wall-clock + durable ledger timestamps), retries (replan/wait/
resume events), tool usage (agent-action/tool step events), route/strategy
(the planning decision's selected strategy id), artifacts (settled
artifact references), failure modes (the failure envelope).

## Environmental honesty

- Wall-clock latency is measured with `performance.now()` in the
  harness process — an **environmental** measurement recorded in the
  report, not a durable platform fact.
- The verification dimension is recorded through the canonical governed
  completion path with harness-identified provenance
  (`benchmark-harness`), **not** through independent evaluator judgment —
  a future benchmark surface.
- The agent participants are deterministic stubs: the comparison
  measures the governed paths (admission chain, submission seam,
  evidence flow), not a live model's quality.
- Store wiring (in-memory vs real PostgreSQL) is recorded in the
  report's environment block.

## Usage

```ts
import {
  buildBenchmarkReport,
  createBenchmarkHarness,
  createBenchmarkStrategies,
  renderBenchmarkReport,
} from "../benchmarks";

// Wire the REAL authorities (in-memory variants for quick runs, SQL
// variants over real PostgreSQL for durable runs — see
// tests/integration/postgres/benchmark-world.ts), then:
const strategies = createBenchmarkStrategies(deps);
const harness = createBenchmarkHarness({ executions, applicationId, label, environment });
const evidence = await harness.run(strategies, tasks);
const report = buildBenchmarkReport(evidence);
console.log(renderBenchmarkReport(report));
```

The evidence record references durable execution identities — its
provenance is the durable ledger, and every referenced row is
authoritative platform state (proven by the real-PostgreSQL suites).
