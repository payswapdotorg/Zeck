# Substrate-Failure Application (VAL-022)

A customer-style sandbox-readiness application: one pinned corpus
execution per run, submitted through Zeck's public SDK boundary,
driving the platform's compute-substrate failure semantics end to
end — sandbox unavailability at submission, mid-execution sandbox
loss, substrate timeout classification, resource exhaustion
(OOM-vs-timeout discrimination), readiness probing and quarantine —
each classified, recovered and contained per the pinned policies,
with per-attempt journal evidence (fresh sandbox ids, payload
digests — never payload bytes).

## The pinned corpus (`substrate-readiness.probe.v1`)

The task slice is FLAT — one entry per EXECUTION (the quarantine row
carries three; the registry state carries across them, which is the
propagation proof).

| Row | Injected failure mode | Classification (substrate / platform) | Retryable | Recovery policy | Attempts | Probes | Terminal |
|---|---|---|---|---|---|---|---|
| healthy-clean-run | none | — / — | — | — | 1 | 1 | **COMPLETED** |
| readiness-refused-terminal | unavailability at submission | readiness-refused / runtime-unavailable | (re-probe) | bounded re-probe exhausted — ZERO dispatches | 0 | 3 | FAILED (honest) |
| readiness-refused-recovery | transient unavailability (cold start) | — / — | — | bounded re-probe recovers on the LAST probe | 1 | 3 | **COMPLETED** |
| sandbox-lost-retry-fresh-recovery | mid-execution loss (once) | — / — | yes | retry-with-fresh-sandbox recovers | 2 | 2 | **COMPLETED** (failure history journaled) |
| sandbox-lost-exhausted | mid-execution loss (always) | sandbox-lost / runtime-unavailable | yes | bounded retry exhausted — 3 FRESH sandboxes | 3 | 3 | FAILED (honest) |
| substrate-timeout-classified | admitted-deadline kill (timedOut, exit 137) | substrate-timeout / timeout | yes | bounded retry exhausted | 3 | 3 | FAILED (honest) |
| resource-exhausted-oom | OOMKilled shape (exit 137, OOM marker, NOT timedOut) | resource-exhausted / sandbox-execution | no | honest FAILED — the same work would exhaust again | 1 | 1 | FAILED (honest) |
| payload-exit-nonzero | payload exits 7 | sandbox-execution / sandbox-execution | no | honest FAILED — a deterministic failure reproduces | 1 | 1 | FAILED (honest) |
| sandbox-lost-then-unready | loss, then the substrate goes down mid-recovery | readiness-refused / runtime-unavailable | (re-probe) | readiness gates EVERY dispatch; budget exhausted | 1 | 3 | FAILED (honest) |
| quarantine-on-repeat-failure ×3 | repeat substrate failures | exec1/2: sandbox-lost / runtime-unavailable; exec3: readiness-refused (QUARANTINED) | yes (exec1/2) | exec2's terminal crosses the threshold (streak 2); exec3 refused at the FIRST probe — zero dispatches | 3/3/0 | 3/3/1 | FAILED ×3 (honest) |

## Live rows (the REAL process substrate — driven inside the PG crown)

The REAL substrate in this environment is the validation sandbox
itself: the platform's declared sandbox/compute adapter surface
(`ProcessSandboxProvider` over `runIsolatedProcess`) is bound as the
seam. Live substrate LOSS and live OOM coercion are NOT RUN
boundaries — they cannot be coerced on demand; the injection points
are the adapter seams (the work order's own framing).

| Row | REAL demand | Expected |
|---|---|---|
| live-process-healthy | a REAL isolated process runs to exit 0 | COMPLETED, 1 attempt, 1 probe |
| live-process-timeout | a REAL payload outliving its admitted 250 ms deadline — the REAL SIGKILL-on-expiry | FAILED, substrate-timeout / timeout, 3 bounded REAL attempts |
| live-process-exit-nonzero | a REAL process exiting 7 | FAILED, sandbox-execution, 1 attempt |

## Pinned policies

- Readiness probes gate EVERY dispatch (never dispatch to an unready
  substrate — the driver probes before each attempt and the criteria
  verify the gating probe mechanically). At most 3 probes per
  execution (re-probe with backoff on refusal). A QUARANTINED
  substrate is refused at the FIRST probe — no re-probe, zero
  dispatches (the exact boundary).
- Bounded dispatch retry: sandbox-lost and substrate-timeout only, at
  most 2 extra attempts, each in a FRESH sandbox (per-attempt-distinct
  sandbox ids — a lost sandbox is never reused).
- Quarantine: 2 consecutive substrate-failure terminals on one
  substrate; a success resets the streak; per-substrate (no
  cross-propagation).

## Boundaries

- Integrates ONLY through the public SDK (the validation harness) —
  never Zeck internals; never selects provider/model/substrate (the
  task references the corpus scenario; the platform derives the route
  and the substrate policy).
- Offline rows replay the REAL substrate failure shapes from the
  documented sources (the process runtime's admitted-deadline kill;
  the container runtime's State.OOMKilled inspection shape; the
  payload exit-code fold; the never-settling mid-execution loss)
  through deterministic fault-injection substrate adapters — zero
  network dependence, zero credentials.
- Evidence carries payload DIGESTS, never payload bytes; usage, cost
  and latency are measured, never estimated.
- Configuration is repository-reproducible and secret-free; the single
  secret is the environment token (`ZECK_VALIDATION_TOKEN`).

## Run

Executed by the validation integration suite
(`tests/integration/validation/val-022-substrate-readiness.test.ts`).
