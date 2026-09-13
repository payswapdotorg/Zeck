# Substrate-Failure Application (VAL-022)

A customer-style sandbox-readiness application: one pinned
substrate-failure corpus row per run, submitted through Zeck's public
SDK boundary, driving the platform's compute-substrate failure
machinery end to end — readiness-gated dispatch, retry with a fresh
sandbox, quarantine on repeat failure, fact-driven timeout-vs-OOM
classification and honest FAILED terminals with the exact boundary —
with per-attempt journal evidence riding the platform's own sandbox
step-event vocabulary (`sandbox-admitted` / `sandbox-denied` /
`sandbox-completed` + `agent-action-recorded`).

## The pinned corpus (`substrate-failure.probe.v1`)

| Row | Failure mode | Class | Layer | Retryable | Attempts | Terminal |
|---|---|---|---|---|---|---|
| healthy-substrate | none (clean success) | — | — | — | 1 | **COMPLETED** |
| readiness-refused-transient | capacity refusal at submission, ready on retry | readiness-refused | substrate | yes | 2 | **COMPLETED** |
| readiness-refused-persistent | persistent unavailability at submission | readiness-refused | substrate | yes | 3 (bounded) | FAILED |
| sandbox-lost-recovery | mid-execution loss, fresh-sandbox retry completes | sandbox-lost | substrate | yes | 2 | **COMPLETED** |
| sandbox-lost-persistent | persistent mid-execution loss | sandbox-lost | substrate | yes | 3 (bounded) | FAILED |
| substrate-timeout | the genuine deadline timeout (timer-fired fact) | substrate-timeout | substrate | yes | 3 (bounded) | FAILED |
| resource-exhausted-oom | OOM kill mislabeled timeout by the adapter (exit 137 + OOMKilled + deadline not elapsed) | resource-exhausted | substrate | **no** (deterministic reproduction at the same profile) | 1 | FAILED |
| task-failure-in-sandbox | the task's own non-zero exit in a healthy sandbox | task-failure | **task** | no (no strike either) | 1 | FAILED |
| unwired-substrate | no adapter wired for the kind (fail-closed) | runtime-unavailable | substrate | no | 1 (zero substrate contact) | FAILED |
| quarantine-propagation-and-recovery | repeat losses → quarantine → gated future submission → cool-down recovery | sandbox-lost → readiness-refused (gate) | substrate | — | 3+3+1+1 across 4 submissions | FAILED · FAILED · FAILED (0 probes, 0 executes) · **COMPLETED** |

## The REAL process rows (crown integration suite; no credentials)

| Row | REAL adapter path | Expected |
|---|---|---|
| real-process-echo-healthy | REAL `ProcessSandboxProvider` executing `/bin/echo` | COMPLETED, exit 0, REAL sha256 output digest |
| real-process-exit-task-failure | REAL runtime executing `/bin/false` | FAILED, task layer (the substrate is not blamed), 1 attempt |
| real-process-sleep-timeout | REAL runtime executing `/bin/sleep 5` under a 250ms admitted timeout | FAILED, substrate-timeout (the runtime's own timer), 3 bounded fresh-sandbox retries |

## Policies (pinned)

- Bounded fresh-sandbox retry: **2** extra attempts for the retryable
  substrate classes ONLY (`readiness-refused`, `sandbox-lost`,
  `substrate-timeout`); every retry dispatches to a FRESH sandbox
  identity — a lost/timed-out sandbox is never re-entered.
- Non-retryable classes (`resource-exhausted`, `adapter-error`,
  `runtime-unavailable`, `task-failure`, `platform-error`) never
  retry: the honest FAILED carries the exact boundary.
- Readiness gating: every dispatched attempt was probed ready in the
  SAME attempt; a not-ready substrate is never dispatched; a
  quarantined substrate is never even probed (zero substrate contact
  until the cool-down elapses).
- Quarantine: **2** terminal substrate-layer submission failures
  engage the quarantine; it propagates to future submissions (refused
  pre-probe); the **60s** cool-down window (the pinned injectable
  clock) elapses → recovery probes ready and completes; a success
  closes the circuit (strikes reset).

## Honesty rules

- No fabricated substrate results: the fake adapters replay the REAL
  failure shapes (the process runtime's timeout/success/exit
  observations; the container family's OOM kill; the E2B/DAYTONA
  closed-sandbox loss); the REAL adapter's healthy path is verified
  live in the crown where the adapter exists.
- Live substrate failure on EXTERNAL substrates (E2B/Daytona/Modal
  fleets) cannot be coerced on demand — recorded as the NOT RUN
  boundary; the injection points are the adapter seams.
- Evidence carries spec/output DIGESTS, never payload bytes; usage and
  latency are measured, never estimated; no credentials appear in any
  file, log or report (env-gated at run time only).
