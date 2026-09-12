# Tool-Using Agent Application (VAL-012)

A customer-style tool-using agent application: business goals that
require governed tool invocation — single tools (calculator, calendar,
converter, lookup), chained multi-step tools, and policy-routed
invoice-approval workflows — submitted through Zeck's public SDK
boundary.

## What it does

Submits one pinned corpus task (`kind: "use-tool"`, `kind:
"chain-tools"` or `kind: "run-workflow"`), awaits asynchronous
completion across the platform's multi-step agent loop (model rounds,
deterministic tool execution, genuine wait-tool/resume cycles on the
execution state machine), retrieves the result package and asserts the
per-row deterministic outcome contract from the corpus: an achievable
goal must complete with PASS verification; an unachievable one (the
corpus's expected-failure rows: no mail tool exposed, forged sign-off)
must FAIL — a COMPLETED there would mean a fabricated success.

## Boundaries

- Integrates ONLY through the public SDK (the validation harness) —
  never Zeck internals; never selects provider/model/rail.
- The exposed toolset is declared per task (the authority boundary: the
  agent may invoke only what the task's grant exposes).
- Tools are deterministic in-lab surfaces — no network, no external
  side effects.
- Configuration is repository-reproducible and secret-free; the single
  secret is the environment token (`ZECK_VALIDATION_TOKEN`).

## Run

Executed by the validation integration suite
(`tests/integration/validation/val-012-tool-agent.test.ts`).
