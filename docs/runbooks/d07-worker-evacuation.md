# D-07 runbook — regional worker evacuation, drain and fencing

**Scenario:** a region's workers are lost (regional failure) or must
be retired (planned provider exit/maintenance). Worker registrations
and claims are EXECUTOR coordination rows; execution state is never
mutated by evacuation. Stale workers are fenced at the DURABLE
EXECUTION LEASES (the single lease system) so a late write from an
evacuated region fails the authoritative lease guard.

**Tool:** `bun run deploy:drill worker-evacuation --env <environment> --region <label> --mode <drain|fence>`

## Choosing the mode

- **`drain` (planned evacuation — provider exit, maintenance):**
  workers move to `draining` first (claim admission refuses draining
  workers by construction), straggler claims abandon with the
  `worker-drained` cause, identities retire `offline`, then their
  leases release. In-flight work finishes gracefully where it can.
- **`fence` (regional LOSS — no cooperation):** identities retire
  FIRST (terminal offline), live claims abandon with the
  `worker-lost` cause, and every live lease is FORCE-RELEASED
  immediately — the stale workers' next write hits the
  `lease-released` fence without waiting for lease TTL expiry.

## Preconditions

- Workers are registered with a region label in their bounded
  registration metadata (`metadata.region`) — the label is
  reference-only coordination metadata, never domain state.
- The environment's PostgreSQL URL is materialized (same as the
  authority-loss runbook).

## The procedure (what the tool runs)

1. **Evacuate** the region: select the region's non-offline workers,
   drain/retire per mode, abandon their live claims with the typed
   cause, force-release their live leases.
2. **Fence verification** — every abandoned execution's lease is
   released and its claim is abandoned; any unreleased lease FAILS
   the drill (stale workers would NOT be fenced).

Afterwards, restartable reassignment is the STANDARD recovery: fresh
workers (any region) re-drive the abandoned executions from the
executions authority — fresh claim, fresh lease epoch, exactly one
provider dispatch per execution.

## Success criteria

- `evacuation.completed: true`, `fenceVerification.unreleasedLeases: 0`.
- Idempotent: re-running the same region selects nothing (the
  identities are offline-terminal) — a bounded no-op, never an error.
- An unknown region label FAILS CLOSED (wrong input is never a
  silent no-op PASS).
- Objectives within the environment target (exit 0).

## Failure handling (fail-closed)

- "no workers are registered for region" — the label is wrong or the
  workers were never registered; verify the region label before
  re-running (fail-closed by design).
- Unreleased leases — investigate immediately: a stale worker could
  still write; the drill refuses to declare the region evacuated.

Local evidence: `tests/integration/postgres/worker-evacuation.test.ts`
(the E1–E6 drill matrix over real PostgreSQL, including the
stale-write fencing proof).
